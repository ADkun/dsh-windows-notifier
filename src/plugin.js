/**
 * dsh-windows-notifier — a host-plane DSH/Cordis plugin that raises a native
 * Windows toast whenever a conversation hands control back to the user.
 *
 * It reports on four moments and never participates in them:
 *
 * | Event | Moment |
 * | --- | --- |
 * | `agent/status` | `running` → `idle`: the turn settled, the user may type again |
 * | `user-questions/request` | the agent asked a structured question |
 * | `approval/request` | an operation is blocked on the user's approval |
 * | `agent/error` | a step or turn errored |
 *
 * ## Delegated children
 *
 * A subagent or workflow child is a real session that hands control back to its
 * parent, not to the user, so its *turn end* is reported only when
 * `includeSubagents` is on. Everything else a child does that needs a human —
 * asking a question, blocking on approval, erroring — is still reported,
 * because the user is the one who has to answer it.
 *
 * Telling a child apart must not depend on a service lookup that can come back
 * empty: the event payload already carries the live `agent`, and the live
 * `agent` carries its own `session` with the durable header DSH classification
 * lives in. That is the primary source; the session store, and an id set
 * learned from `session/created`, are fallbacks. An event whose session cannot
 * be read at all is treated as a user conversation — an unknown session must
 * never lose a notification.
 *
 * ## Why it listens on two channels
 *
 * DSH dispatches those events through a *scope carrier*, and Cordis drops any
 * listener whose owning context is not in that carrier's scope chain. The
 * filtering is real and observable: `agent/status` reaches an ordinary
 * standing listener, while `user-questions/request` — keyed to the asking
 * agent itself — does not, even though the dispatch definitely happened.
 *
 * So this plugin observes both:
 *
 * 1. **`internal/dispatch`**, the framework's own dispatch announcement. Every
 *    non-internal dispatch is published there *before* scope filtering is
 *    applied, so a `{ global: true }` listener sees events from every scope —
 *    the only way to watch *any* conversation, including one running in the
 *    background. (DSH's own scope-invariant plugin listens the same way.)
 * 2. **Direct listeners**, kept as a fallback for a runtime that stops
 *    announcing dispatches. They are registered `{ global: true }` too.
 *
 * Both channels carry the *same payload object*, so an identity-keyed
 * `WeakSet` de-duplicates them: whichever channel reports an occurrence first
 * wins and the other is ignored, with no time window to tune.
 *
 * The plugin declares no hard dependencies: `sessions`, `sessionTitle`,
 * `webServer`, and `logger` are all read optionally, so a profile that lacks
 * them still activates and simply notifies with less context.
 *
 * @module dsh-windows-notifier
 */

import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

import { normalizeConfig } from './config.js'
import {
  KIND_APPROVAL,
  KIND_COMPLETE,
  KIND_ERROR,
  KIND_INTERRUPTED,
  KIND_QUESTION,
  buildNotification,
  isSubagentHeader,
  isTurnEndKind,
} from './messages.js'
import { createNotifier } from './notify.js'
import { SCHEMA_SPECIFIER, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, settingsBase } from './settings.js'

/** Stable plugin name; also the id a composed row refers to. */
export const name = 'dsh-windows-notifier'

/**
 * Scope filtering is bypassed by marking a listener global. Every listener
 * this plugin registers is global: watching every scope is the whole point.
 */
const GLOBAL = Object.freeze({ global: true })

/** The notification kind each config switch gates. */
const KIND_SWITCH = Object.freeze({
  [KIND_COMPLETE]: 'notifyOnComplete',
  [KIND_QUESTION]: 'notifyOnQuestion',
  [KIND_APPROVAL]: 'notifyOnApproval',
  [KIND_ERROR]: 'notifyOnError',
  [KIND_INTERRUPTED]: 'notifyOnInterrupted',
})

/** How many trailing session events to scan when looking for the last turn end. */
const TURN_SCAN_LIMIT = 200

/**
 * How many child session ids to remember when a live session cannot be read off
 * the event payload. Bounded so an arbitrarily long-lived process cannot grow
 * this set without limit; the payload's own session is the primary source, so
 * eviction only ever forgets a fallback.
 */
const SUBAGENT_MEMORY_LIMIT = 2048

/**
 * Map one durable `turn/end` reason onto a notification kind.
 *
 * @param {unknown} eventData - the `turn/end` event payload.
 * @returns {'completed' | 'aborted' | 'interrupted' | 'error' | 'other'}
 */
function readTurnEndKind(eventData) {
  const reason = typeof eventData === 'object' && eventData !== null ? eventData.reason : undefined
  const kind = typeof reason === 'object' && reason !== null ? reason.kind : undefined
  if (kind === 'completed' || kind === 'max-tokens' || kind === 'blocked') return 'completed'
  if (kind === 'aborted' || kind === 'interrupted') return kind
  if (kind === 'error') return 'error'
  return 'other'
}

/**
 * Read the outcome of the session's most recent settled turn.
 *
 * Going idle is only meaningful when a turn actually ended, so the backward
 * scan stops at an open `turn/start`; a session with no turn boundary at all
 * reports `undefined` rather than a made-up completion.
 *
 * @param {object | undefined} session - the live session, when it is attached.
 * @returns {{ kind: string } | undefined} the settled outcome, or `undefined`.
 */
function readLastTurnOutcome(session) {
  if (session === undefined || session === null) return undefined
  try {
    if (typeof session.eventAt === 'function' && typeof session.seq === 'number') {
      const end = session.seq
      for (let seq = end - 1; seq >= 0 && seq > end - TURN_SCAN_LIMIT; seq -= 1) {
        const event = session.eventAt(seq)
        if (event === undefined || event === null) continue
        if (event.type === 'turn/end') return { kind: readTurnEndKind(event.data) }
        if (event.type === 'turn/start') return undefined
      }
      return undefined
    }
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      for (let index = events.length - 1; index >= 0 && index > events.length - TURN_SCAN_LIMIT; index -= 1) {
        const event = events[index]
        if (event === undefined || event === null) continue
        if (event.type === 'turn/end') return { kind: readTurnEndKind(event.data) }
        if (event.type === 'turn/start') return undefined
      }
    }
  } catch {
    // A non-live or partially replayed session simply has no readable outcome.
  }
  return undefined
}

/**
 * The plugin body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 * @param {unknown} rawConfig - the row's `config:` block, if it declared one.
 */
export function apply(ctx, rawConfig) {
  const raw = typeof rawConfig === 'object' && rawConfig !== null && !Array.isArray(rawConfig)
    ? rawConfig
    : {}
  const composition = normalizeConfig(raw)
  // Mutable on purpose: a live settings namespace replaces it without a reload.
  let config = composition

  /** Write one diagnostic line to the Host log and, optionally, to a file. */
  const log = (message) => {
    const line = `[${name}] ${message}`
    try {
      ctx.logger?.info?.(line)
    } catch {
      // Logging must never break a notification path.
    }
    if (config.logFile === '') return
    try {
      appendFileSync(config.logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // An unwritable log file is not worth failing a notification over.
    }
  }

  if (process.platform !== 'win32') {
    log(`skipped: Windows toast notifications are Windows-only (platform ${process.platform})`)
    return
  }

  // Both lookups are optional context, and both are adopted through
  // `ctx.inject` rather than sampled once with `ctx.get`: a row inserted by a
  // patch layer (this one) can activate before the row that publishes the
  // service, and a value captured at apply time would then stay `undefined` for
  // the rest of the process — which is exactly how a live conversation ends up
  // labelled "会话 a1b2c3d4" instead of by its title.
  let sessions = ctx.get('sessions')
  let sessionTitle = ctx.get('sessionTitle')
  for (const [serviceName, adopt] of [
    ['sessions', (value) => { sessions = value }],
    ['sessionTitle', (value) => { sessionTitle = value }],
  ]) {
    ctx.inject([serviceName], (serviceCtx) => {
      const value = serviceCtx[serviceName]
      if (value !== undefined) adopt(value)
    })
  }
  let notifier = createNotifier(config, log)

  /** Sessions seen running, so a finished turn can report its duration. */
  const runningSince = new Map()

  /** Child sessions learned from their own creation announcement, by identity. */
  const subagentSessions = new Set()

  /** Payload objects already reported, shared by both observation channels. */
  const reported = new WeakSet()

  /**
   * Claim an event occurrence, so the two channels cannot report it twice.
   *
   * Both channels receive the very same payload object, which makes identity
   * the exact de-duplication key — no timing window to guess at.
   *
   * @param {unknown} payload - the dispatch payload.
   * @returns {boolean} `true` when this call is the first to see the payload.
   */
  const claim = (payload) => {
    if (payload === null || typeof payload !== 'object') return true
    if (reported.has(payload)) return false
    reported.add(payload)
    return true
  }

  /** Look up the live session behind an agent id, without throwing. */
  const lookupSession = (sessionId) => {
    if (sessionId === undefined || sessionId === null || sessions === undefined) return undefined
    try {
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * The live session an event's own agent drives, without throwing.
   *
   * This is the authoritative source: the payload carries the agent and the
   * agent carries its session, so the answer travels with the event instead of
   * depending on a service this row may have resolved before it existed.
   *
   * @param {unknown} agent - the payload's agent subject.
   * @returns {object | undefined} the live session, when there is one.
   */
  const readAgentSession = (agent) => {
    if (agent === null || typeof agent !== 'object') return undefined
    let session
    try {
      session = agent.session
    } catch {
      return undefined
    }
    return session !== null && typeof session === 'object' ? session : undefined
  }

  /** The best session object available for one event, without throwing. */
  const resolveSession = (agent, sessionId) => readAgentSession(agent) ?? lookupSession(sessionId)

  /**
   * Whether one event belongs to a delegated child conversation.
   *
   * Unknown is deliberately NOT a child: an event whose session cannot be read
   * keeps its notification, because losing a real conversation is worse than
   * one extra toast.
   *
   * @param {unknown} agent - the payload's agent subject.
   * @param {unknown} sessionId - the agent identity the payload carries.
   * @param {object | undefined} session - the session already resolved for it.
   * @returns {boolean} whether this event belongs to a subagent run.
   */
  const isSubagentEvent = (agent, sessionId, session) => {
    const header = (session ?? readAgentSession(agent))?.header
    if (header !== undefined && header !== null) return isSubagentHeader(header)
    const stored = lookupSession(sessionId)
    if (stored !== undefined) return isSubagentHeader(stored.header)
    return sessionId !== undefined && sessionId !== null && subagentSessions.has(String(sessionId))
  }

  /**
   * Learn one child identity from its own `session/created` announcement.
   *
   * The fallback for an event whose payload never exposes a readable session:
   * classification recorded at creation time outlives the live session.
   *
   * @param {unknown} session - the announced session.
   */
  const rememberSession = (session) => {
    try {
      const header = session?.header
      if (header === undefined || header === null) return
      if (!isSubagentHeader(header)) return
      const id = header.id ?? session?.id
      if (id === undefined || id === null) return
      subagentSessions.add(String(id))
      while (subagentSessions.size > SUBAGENT_MEMORY_LIMIT) {
        const oldest = subagentSessions.values().next().value
        subagentSessions.delete(oldest)
      }
    } catch (error) {
      log(`session/created handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The best available human label for one conversation. */
  const resolveSessionTitle = (session) => {
    if (session === undefined || session === null) return ''
    if (sessionTitle !== undefined) {
      try {
        const snapshot = sessionTitle.get(session)
        const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
        if (title !== '') return title
      } catch {
        // Fall through to the workspace folder name.
      }
    }
    const cwd = session.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? basename(cwd) : ''
  }

  /**
   * Where a click on the toast should land.
   *
   * `openOnClick: false` makes the toast inert. Otherwise an explicit
   * `launchUrl` wins and may reference `{sessionId}`; with no configured URL
   * the running Web GUI's own loopback address is used, so a click at least
   * brings the harness forward — the GUI keeps session selection in memory and
   * exposes no per-session route, so there is nothing deeper to link to.
   *
   * @param {unknown} sessionId - the conversation the notification belongs to.
   * @returns {string} an absolute URL, or `''` to make the toast inert.
   */
  const resolveLaunchUrl = (sessionId) => {
    if (!config.openOnClick) return ''
    if (config.launchUrl !== '') {
      return config.launchUrl.replaceAll('{sessionId}', encodeURIComponent(String(sessionId ?? '')))
    }
    try {
      const port = ctx.get('webServer')?.port
      if (typeof port === 'number') return `http://127.0.0.1:${String(port)}`
    } catch {
      // A profile without a Web server simply gets a non-clickable toast.
    }
    return ''
  }

  /**
   * Filter, render, and queue one notification.
   *
   * Every suppressed notification is logged with its reason: "why did nothing
   * pop up" is the only question this plugin ever gets asked, and `logFile` is
   * how it answers.
   *
   * @param {string} kind - one of the `KIND_*` values.
   * @param {unknown} agent - the payload's agent subject, carrying its session.
   * @param {string} [detail] - the question, tool name, or error text.
   * @param {number} [durationMs] - how long the finished turn ran.
   */
  const notify = (kind, agent, detail, durationMs) => {
    if (config[KIND_SWITCH[kind]] !== true) {
      log(`skip ${kind}: switch off`)
      return
    }
    const sessionId = agent?.id
    const session = resolveSession(agent, sessionId)
    // Only a child's own turn end is the parent's business. A child that needs
    // the user — a question, an approval, an error — is still reported.
    if (!config.includeSubagents && isTurnEndKind(kind) && isSubagentEvent(agent, sessionId, session)) {
      log(`skip ${kind} for ${String(sessionId)}: subagent turn end (includeSubagents is off)`)
      return
    }
    const message = buildNotification(kind, {
      sessionId,
      sessionTitle: resolveSessionTitle(session),
      detail,
      durationMs,
    })
    const launchUrl = resolveLaunchUrl(sessionId)
    log(`notify ${kind}: ${message.title} / ${message.lines.join(' | ')}${launchUrl === '' ? '' : ` -> ${launchUrl}`}`)
    notifier.send(message.title, message.lines, launchUrl)
  }

  /** Report one settled turn, once the log confirms what settled it. */
  const reportStatus = (payload) => {
    const agent = payload?.agent
    const sessionId = agent?.id
    if (sessionId === undefined || sessionId === null) return
    try {
      if (payload.status === 'running') {
        runningSince.set(sessionId, Date.now())
        return
      }
      if (payload.status !== 'idle') return
      const startedAt = runningSince.get(sessionId)
      runningSince.delete(sessionId)

      const session = resolveSession(agent, sessionId)
      const outcome = readLastTurnOutcome(session)
      // `idle` is only published on a change, so it always means a running
      // agent stopped — the turn outcome refines the wording, it is not the
      // evidence. An attached session that shows no settled turn is the one
      // genuinely suspicious case; an unattached one (a headless run that
      // detached its session while shutting down) still deserves its toast.
      if (session !== undefined && outcome === undefined) {
        log(`skip complete for ${String(sessionId)}: attached session has no settled turn`)
        return
      }
      const kind = outcome?.kind
      // An errored turn already produced its own notification from `agent/error`.
      if (kind === 'error') {
        log(`skip complete for ${String(sessionId)}: the settled turn ended in an error`)
        return
      }
      if (session === undefined) {
        log(`session ${String(sessionId)} is not attached; reporting completion without a turn outcome`)
      }

      const interrupted = kind === 'aborted' || kind === 'interrupted'
      if (!interrupted && config.minTaskDurationMs > 0 && startedAt !== undefined) {
        if (Date.now() - startedAt < config.minTaskDurationMs) {
          log(`skip complete for ${String(sessionId)}: shorter than minTaskDurationMs`)
          return
        }
      }
      notify(
        interrupted ? KIND_INTERRUPTED : KIND_COMPLETE,
        agent,
        undefined,
        interrupted || startedAt === undefined ? undefined : Date.now() - startedAt,
      )
    } catch (error) {
      log(`agent/status handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Report one failed step or turn. */
  const reportError = (payload) => {
    try {
      const failure = payload?.error
      const detail = failure instanceof Error
        ? failure.message
        : typeof failure === 'string' ? failure : ''
      notify(KIND_ERROR, payload?.agent, detail)
    } catch (error) {
      log(`agent/error handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Report one pending structured question. */
  const reportQuestion = (request) => {
    try {
      const questions = request?.questions
      const first = Array.isArray(questions) ? questions[0] : undefined
      const question = typeof first?.question === 'string' ? first.question : ''
      notify(KIND_QUESTION, request?.agent, question)
    } catch (error) {
      log(`user-questions/request handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Report one pending approval. */
  const reportApproval = (request) => {
    try {
      const toolName = typeof request?.toolName === 'string' ? request.toolName : '未知工具'
      const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
      notify(KIND_APPROVAL, request?.agent, reason === '' ? `工具 ${toolName} 等待你确认。` : `工具 ${toolName}：${reason}`)
    } catch (error) {
      log(`approval/request handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Forget a conversation that no longer exists. */
  const forgetAgent = (payload) => {
    const sessionId = payload?.agent?.id
    if (sessionId !== undefined && sessionId !== null) runningSince.delete(sessionId)
  }

  /**
   * Observed events, and whether the direct listener must continue the
   * waterfall chain (`user-questions/request` and `approval/request` are
   * answered by a downstream listener, usually the remote UI).
   */
  const OBSERVED = Object.freeze({
    'agent/status': { report: reportStatus, chain: false },
    'agent/error': { report: reportError, chain: false },
    'user-questions/request': { report: reportQuestion, chain: true },
    'approval/request': { report: reportApproval, chain: true },
    'agent/disposed': { report: forgetAgent, chain: false },
    'session/created': { report: rememberSession, chain: false },
  })

  /**
   * Register every listener, and return one disposer for all of them.
   *
   * Channel 1 — the framework's dispatch stream, published before scope
   * filtering, so this sees conversations in every scope.
   *
   * Channel 2 — direct listeners, the fallback when no dispatch announcement
   * is available. They must keep the chain alive for the waterfall events.
   *
   * @returns {() => void} removes everything registered here.
   */
  const attach = () => {
    const disposers = [
      ctx.on('internal/dispatch', (_mode, eventName, args) => {
        const observed = OBSERVED[eventName]
        if (observed === undefined) return
        const payload = Array.isArray(args) ? args[0] : undefined
        if (payload === undefined || payload === null) return
        if (!claim(payload)) return
        observed.report(payload)
      }, GLOBAL),
    ]
    for (const [eventName, observed] of Object.entries(OBSERVED)) {
      if (!observed.chain) {
        disposers.push(ctx.on(eventName, (payload) => {
          if (claim(payload)) observed.report(payload)
        }, GLOBAL))
        continue
      }
      disposers.push(ctx.on(eventName, (payload, next) => {
        if (claim(payload)) observed.report(payload)
        return typeof next === 'function' ? next() : undefined
      }, GLOBAL))
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // A listener that already went away is not worth reporting.
        }
      }
    }
  }

  /** Disposer for the listeners currently registered, or `null` while idle. */
  let detach = null

  /**
   * Follow `enabled`.
   *
   * The switch is the one option that changes whether anything is listened to
   * at all, so it is also the one that can come back off: an idle plugin owns
   * no listeners, and a user re-enabling it from the settings card gets them
   * back without a reload.
   */
  const sync = () => {
    if (config.enabled) {
      if (detach === null) {
        detach = attach()
        log('listening')
      }
      return
    }
    if (detach !== null) {
      detach()
      detach = null
      log('listening stopped: disabled')
    }
  }

  /**
   * Adopt a resolved settings section: once when the settings service arrives,
   * and again on every user edit behind it.
   */
  const reconfigure = (next, reason) => {
    const previous = notifier
    config = normalizeConfig({ ...raw, ...next })
    notifier = createNotifier(config, log)
    previous.dispose()
    sync()
    log(`${reason} (disappearAfterMs=${String(config.disappearAfterMs)}, openOnClick=${String(config.openOnClick)}, includeSubagents=${String(config.includeSubagents)})`)
  }

  // The settings namespace is registered even while `enabled` is false: the
  // configuration card is how a user turns the plugin back on, so it has to
  // exist precisely when the plugin is idle. Registration is an effect of this
  // fiber, and the resolved value layers schema defaults, this row's config,
  // and the user's own overrides — in that order.
  //
  // `ctx.inject` rather than `ctx.get`: the settings provider is a separate row
  // of the composition and is not guaranteed to be mounted before this one, so
  // a consumer waits for the service instead of sampling it once at apply time.
  // DSH's own plugins open their settings section the same way.
  if (SETTINGS_SCHEMA === undefined) {
    log(`no ${SCHEMA_SPECIFIER} available; the settings card is off and configuration stays composition-only`)
  } else {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.settings
      if (settings === undefined || typeof settings.register !== 'function') {
        log('the settings service provides no namespaces; configuration stays composition-only')
        return
      }
      try {
        const scope = settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, {
          base: settingsBase(composition),
          applies: 'live',
        })
        reconfigure(scope.get(), 'settings applied')
        ctx.effect(() => scope.watch((next) => reconfigure(next, 'reconfigured')), `${name}: settings namespace`)
        log(`settings namespace '${SETTINGS_NAMESPACE}' registered; edit it under 设置 → 插件 → 插件配置`)
      } catch (error) {
        log(`settings namespace failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    if (ctx.get('settings') === undefined) {
      log('waiting for the settings service; configuration stays composition-only until it appears')
    }
  }

  sync()
  if (!config.enabled) log('disabled by config')

  ctx.effect(() => () => {
    if (detach !== null) {
      detach()
      detach = null
    }
    runningSince.clear()
    notifier.dispose()
  }, `${name}: toast transport`)

  log(`active (appId=${config.appId}, includeSubagents=${String(config.includeSubagents)}, disappearAfterMs=${String(config.disappearAfterMs)}, openOnClick=${String(config.openOnClick)})`)
  if (config.notifyOnActivate) {
    notifier.send('🔔 dsh-windows-notifier 已启用', ['从现在起，任何对话需要你时都会弹出通知。'], resolveLaunchUrl(undefined))
  }
}

export default { name, apply }