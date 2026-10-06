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
 * ## Waiting for delegated children
 *
 * A child's own turn end is not the only report a *parent* can get wrong. A
 * dispatcher delegates in the background and ends its own turn immediately, so
 * its first `idle` announces "my turn settled" — not "the task is over" — while
 * the delegated work is still running. Reporting that as the conversation's
 * completion is the same false toast from the other side.
 *
 * So the completion report asks a second question first: does this session
 * still have a running subagent descendant? Two sources answer it — the live
 * Agent registry (`ctx.agents`, adopted optionally, read exactly the way DSH's
 * own `runningDescendants` reads it) and the `agent/status` history this plugin
 * observed — and either may hold the report back. Nothing is *lost* by holding
 * it: a settled child wakes its dispatcher with a settlement notice, whose next
 * turn ends with the whole tree quiet, and that is when the toast fires.
 * `waitForSubagents` turns this off.
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
 * ## Configuration
 *
 * The row's `Config` (see `./settings.js`) declares the live switches
 * `.volatile()`: the Loader hands `apply` one stable reference per field and
 * rewrites it in place when the Plugins page saves a value, so this body reads
 * `options` afresh before each decision rather than caching a snapshot. The
 * listeners stay attached for the row's whole life and `enabled` gates each
 * report, which is what makes turning the plugin on and off from the form work
 * without a reload.
 *
 * The plugin declares no hard dependencies: `sessions`, `sessionTitle`,
 * `webServer`, `settings`, and `logger` are all read optionally, so a profile
 * that lacks them still activates and simply notifies with less context.
 *
 * @module dsh-windows-notifier
 */

import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

import { normalizeConfig } from './config.js'
import { runningDescendants, toSubagentRecord } from './lineage.js'
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
import { Config, SCHEMA_SPECIFIER, readConfig } from './settings.js'

/** Stable plugin name; also the id a composed row refers to. */
export const name = 'dsh-windows-notifier'

export { Config }

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
  /**
   * The row's live options — one mutable object, deliberately.
   *
   * The Loader hands `apply` the row's *resolved* config, where every
   * `.volatile()` field is a stable reference that a form edit rewrites in
   * place. So the plain values are re-read from those references before every
   * use, and the transport below holds this same object: that is how a changed
   * `sound`, `disappearAfterMs`, or `openOnClick` reaches the next
   * notification without a reload.
   */
  const options = normalizeConfig(readConfig(rawConfig))

  /** Re-read every live field of the row's config. */
  const refresh = () => {
    Object.assign(options, normalizeConfig(readConfig(rawConfig)))
  }

  /** Write one diagnostic line to the Host log and, optionally, to a file. */
  const log = (message) => {
    refresh()
    const line = `[${name}] ${message}`
    try {
      ctx.logger?.info?.(line)
    } catch {
      // Logging must never break a notification path.
    }
    if (options.logFile === '') return
    try {
      appendFileSync(options.logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // An unwritable log file is not worth failing a notification over.
    }
  }

  // A configuration form is derived from this row's own `Config`, so there is
  // no namespace to register: `@deepseek-ai/dsh-settings` projects the volatile
  // fields of every active entry and addresses them by profile entry id, and this
  // package's browser half renders those fields on a page of its own
  // (`settings.section`, id `windows-notifier`) instead of the row page the
  // settings system would otherwise generate from the same schema. The policy is
  // owned by this fiber and registered as the injected child's effect, so a
  // settings service that arrives late — or is replaced — picks it up again
  // instead of failing on a second registration for the same fiber.
  //
  // This runs before the platform guard below: the row has a form on every
  // platform, and a browser half that renders that page there, so opting out of
  // the automatic row page is not a Windows-only concern.
  if (Config === undefined) {
    log(`no ${SCHEMA_SPECIFIER} available; the configuration form is off and configuration stays composition-only`)
  } else {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  if (process.platform !== 'win32') {
    log(`skipped: Windows toast notifications are Windows-only (platform ${process.platform})`)
    return
  }

  // Every lookup is optional context, and each is adopted through `ctx.inject`
  // rather than sampled once with `ctx.get`: a row inserted by a patch layer
  // (this one) can activate before the row that publishes the service, and a
  // value captured at apply time would then stay `undefined` for the rest of
  // the process — which is exactly how a live conversation ends up labelled
  // "会话 a1b2c3d4" instead of by its title, and how a subagent gate would
  // silently never fire.
  let sessions = ctx.get('sessions')
  let sessionTitle = ctx.get('sessionTitle')
  let agents = ctx.get('agents')
  for (const [serviceName, adopt] of [
    ['sessions', (value) => { sessions = value }],
    ['sessionTitle', (value) => { sessionTitle = value }],
    ['agents', (value) => { agents = value }],
  ]) {
    ctx.inject([serviceName], (serviceCtx) => {
      const value = serviceCtx[serviceName]
      if (value !== undefined) adopt(value)
    })
  }
  const notifier = createNotifier(options, log)

  /**
   * Whether the master switch is on right now.
   *
   * Read per event instead of cached, because `enabled` is one of the live
   * fields: a value saved in the configuration form has to take effect on the
   * next event, and nothing announces the change to this row. A disabled
   * plugin therefore stays attached but silent, which is cheaper and more
   * reliable than tearing listeners down from a value nobody reports.
   *
   * @returns {boolean} whether notifications are currently wanted.
   */
  const isEnabled = () => {
    refresh()
    return options.enabled
  }

  /** Sessions seen running, so a finished turn can report its duration. */
  const runningSince = new Map()

  /** Child sessions learned from their own creation announcement, by identity. */
  const subagentSessions = new Set()

  /**
   * Delegated children whose liveness was observed, by identity.
   *
   * The fallback for a runtime where the Agent registry is not reachable, or
   * where it does not publish a delegated child to this row's scope: a child
   * seen `running` and never seen `idle` still holds its dispatcher's task
   * open. Bounded like `subagentSessions`, for the same reason — and released
   * on `agent/disposed`, so a child that dies mid-turn cannot silence its
   * parent forever.
   */
  const subagentRuns = new Map()

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

  /**
   * Remember one child's own liveness and lineage, as its status change
   * reports them.
   *
   * Runs for every `agent/status` occurrence, before any switch is consulted,
   * so the fallback memory is warm even when notifications were off while the
   * child started.
   *
   * @param {unknown} agent - the payload's agent subject.
   * @param {unknown} sessionId - the identity the payload carries.
   * @param {unknown} status - the announced status.
   */
  const rememberRun = (agent, sessionId, status) => {
    if (status !== 'running' && status !== 'idle') return
    try {
      const id = String(sessionId)
      const record = toSubagentRecord(readAgentSession(agent)?.header, sessionId, status === 'running')
      if (record === undefined) {
        // A payload carrying no readable session still settles the child it
        // names, which is what keeps an id-only `idle` from looking forever.
        const known = subagentRuns.get(id)
        if (known !== undefined) known.running = status === 'running'
        return
      }
      subagentRuns.delete(record.id)
      subagentRuns.set(record.id, record)
      while (subagentRuns.size > SUBAGENT_MEMORY_LIMIT) {
        subagentRuns.delete(subagentRuns.keys().next().value)
      }
    } catch (error) {
      log(`agent/status lineage handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Every delegated child the live Agent registry publishes right now.
   *
   * @returns {import('./lineage.js').SubagentRecord[]} the records, or `[]`
   *   when there is no registry to ask.
   */
  const liveSubagentRecords = () => {
    const records = []
    if (agents === undefined) return records
    let list
    try {
      list = agents.list()
    } catch {
      return records
    }
    if (!Array.isArray(list)) return records
    for (const live of list) {
      try {
        const record = toSubagentRecord(live?.session?.header, live?.id, live?.status === 'running')
        if (record !== undefined) records.push(record)
      } catch {
        // One unreadable agent must not stop the scan for all the others.
      }
    }
    return records
  }

  /**
   * The delegated children still running below one conversation.
   *
   * Both sources are consulted and neither can veto the other: the registry is
   * authoritative about the agents it publishes, while the observed history
   * covers a delegated child the registry never showed this row's scope. The
   * only way either errs is by holding a report back, and the next settlement
   * of that child releases it.
   *
   * @param {unknown} sessionId - the conversation about to report its turn end.
   * @returns {{ ids: string[], source: string }} the running child ids, and
   *   which source was primarily able to answer.
   */
  const runningChildrenBelow = (sessionId) => {
    const live = liveSubagentRecords()
    const observed = [...subagentRuns.values()]
    return {
      ids: runningDescendants([...observed, ...live], sessionId),
      source: live.length > 0 ? 'ctx.agents' : 'agent/status events',
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
    if (!options.openOnClick) return ''
    if (options.launchUrl !== '') {
      return options.launchUrl.replaceAll('{sessionId}', encodeURIComponent(String(sessionId ?? '')))
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
    refresh()
    if (!options.enabled) return
    if (options[KIND_SWITCH[kind]] !== true) {
      log(`skip ${kind}: switch off`)
      return
    }
    const sessionId = agent?.id
    const session = resolveSession(agent, sessionId)
    // Only a child's own turn end is the parent's business. A child that needs
    // the user — a question, an approval, an error — is still reported.
    if (!options.includeSubagents && isTurnEndKind(kind) && isSubagentEvent(agent, sessionId, session)) {
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
    // Lineage is remembered before any switch is consulted: the gate below asks
    // about children that started while notifications happened to be off.
    rememberRun(agent, sessionId, payload?.status)
    if (!isEnabled()) return
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
      if (!interrupted && options.minTaskDurationMs > 0 && startedAt !== undefined) {
        if (Date.now() - startedAt < options.minTaskDurationMs) {
          log(`skip complete for ${String(sessionId)}: shorter than minTaskDurationMs`)
          return
        }
      }
      // A dispatcher ends its own turn the moment it has delegated, so this
      // `idle` is the *task's* end only once nothing delegated is still
      // running. The withheld toast is not lost: each settled child wakes its
      // dispatcher with a settlement notice, and the last idle of the tree is
      // reported. An interruption is exempt — that toast describes the turn
      // being stopped, which is true whatever the children are doing.
      if (!interrupted && options.waitForSubagents) {
        const below = runningChildrenBelow(sessionId)
        if (below.ids.length > 0) {
          log(`skip complete for ${String(sessionId)}: ${String(below.ids.length)} delegated subagent(s) still running (${below.source})`)
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
    if (!isEnabled()) return
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
    if (!isEnabled()) return
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
    if (!isEnabled()) return
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
    if (sessionId === undefined || sessionId === null) return
    runningSince.delete(sessionId)
    // A disposed child can no longer hold its dispatcher's task open.
    subagentRuns.delete(String(sessionId))
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

  /**
   * Attach the listeners, once, for the life of this row.
   *
   * `enabled` gates each report instead of owning the listeners (see
   * {@link isEnabled}), so the switch can be turned on or off from the
   * configuration form without anything here having to re-run.
   */
  const detach = attach()
  log('listening')

  if (!options.enabled) log('disabled by config')

  ctx.effect(() => () => {
    detach()
    runningSince.clear()
    subagentRuns.clear()
    notifier.dispose()
  }, `${name}: toast transport`)

  log(`active (appId=${options.appId}, includeSubagents=${String(options.includeSubagents)}, waitForSubagents=${String(options.waitForSubagents)}, disappearAfterMs=${String(options.disappearAfterMs)}, openOnClick=${String(options.openOnClick)})`)
  if (options.notifyOnActivate) {
    notifier.send('🔔 dsh-windows-notifier 已启用', ['从现在起，任何对话需要你时都会弹出通知。'], resolveLaunchUrl(undefined))
  }
}

export default { name, apply, Config }