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
  isUserVisibleSession,
} from './messages.js'
import { createNotifier } from './notify.js'

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
  const config = normalizeConfig(rawConfig)

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

  if (!config.enabled) {
    log('disabled by config')
    return
  }
  if (process.platform !== 'win32') {
    log(`skipped: Windows toast notifications are Windows-only (platform ${process.platform})`)
    return
  }

  const sessions = ctx.get('sessions')
  const sessionTitle = ctx.get('sessionTitle')
  const notifier = createNotifier(config, log)

  /** Sessions seen running, so a finished turn can report its duration. */
  const runningSince = new Map()

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
   * An explicit `launchUrl` wins and may reference `{sessionId}`. Otherwise the
   * running Web GUI's own loopback address is used, so a click at least brings
   * the harness forward — the GUI keeps session selection in memory and exposes
   * no per-session route, so there is nothing deeper to link to.
   *
   * @param {unknown} sessionId - the conversation the notification belongs to.
   * @returns {string} an absolute URL, or `''` to make the toast inert.
   */
  const resolveLaunchUrl = (sessionId) => {
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
   * @param {unknown} sessionId - the conversation the event belongs to.
   * @param {string} [detail] - the question, tool name, or error text.
   * @param {number} [durationMs] - how long the finished turn ran.
   */
  const notify = (kind, sessionId, detail, durationMs) => {
    if (config[KIND_SWITCH[kind]] !== true) {
      log(`skip ${kind}: switch off`)
      return
    }
    const session = lookupSession(sessionId)
    if (!config.includeSubagents && !isUserVisibleSession(session?.header)) {
      log(`skip ${kind} for ${String(sessionId)}: not a user-visible conversation`)
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
    const sessionId = payload?.agent?.id
    if (sessionId === undefined || sessionId === null) return
    try {
      if (payload.status === 'running') {
        runningSince.set(sessionId, Date.now())
        return
      }
      if (payload.status !== 'idle') return
      const startedAt = runningSince.get(sessionId)
      runningSince.delete(sessionId)

      const session = lookupSession(sessionId)
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
        sessionId,
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
      notify(KIND_ERROR, payload?.agent?.id, detail)
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
      notify(KIND_QUESTION, request?.agent?.id, question)
    } catch (error) {
      log(`user-questions/request handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Report one pending approval. */
  const reportApproval = (request) => {
    try {
      const toolName = typeof request?.toolName === 'string' ? request.toolName : '未知工具'
      const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
      notify(KIND_APPROVAL, request?.agent?.id, reason === '' ? `工具 ${toolName} 等待你确认。` : `工具 ${toolName}：${reason}`)
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
  })

  // Channel 1 — the framework's dispatch stream, published before scope
  // filtering, so this sees conversations in every scope.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    const observed = OBSERVED[eventName]
    if (observed === undefined) return
    const payload = Array.isArray(args) ? args[0] : undefined
    if (payload === undefined || payload === null) return
    if (!claim(payload)) return
    observed.report(payload)
  }, GLOBAL)

  // Channel 2 — direct listeners, the fallback when no dispatch announcement
  // is available. They must keep the chain alive for the waterfall events.
  for (const [eventName, observed] of Object.entries(OBSERVED)) {
    if (!observed.chain) {
      ctx.on(eventName, (payload) => {
        if (claim(payload)) observed.report(payload)
      }, GLOBAL)
      continue
    }
    ctx.on(eventName, (payload, next) => {
      if (claim(payload)) observed.report(payload)
      return typeof next === 'function' ? next() : undefined
    }, GLOBAL)
  }

  ctx.effect(() => () => {
    runningSince.clear()
    notifier.dispose()
  }, `${name}: toast transport`)

  log(`active (appId=${config.appId}, includeSubagents=${String(config.includeSubagents)})`)
  if (config.notifyOnActivate) {
    notifier.send('🔔 dsh-windows-notifier 已启用', ['从现在起，任何对话需要你时都会弹出通知。'], resolveLaunchUrl(undefined))
  }
}

export default { name, apply }