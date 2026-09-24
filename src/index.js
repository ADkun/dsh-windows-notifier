/**
 * dsh-windows-notifier — a host-plane DSH/Cordis plugin that raises a native
 * Windows toast whenever a conversation hands control back to the user.
 *
 * It observes four host events and never participates in them:
 *
 * | Event | Meaning |
 * | --- | --- |
 * | `agent/status` | `running` → `idle`: the turn settled, the user may type again |
 * | `user-questions/request` | the agent asked a structured question |
 * | `approval/request` | an operation is blocked on the user's approval |
 * | `agent/error` | a step or turn errored |
 *
 * All four are scope-routed, and scope dispatch admits untagged listeners to
 * every scope, so this one root-level registration observes every conversation
 * in the process — including background sessions the user is not looking at.
 *
 * The plugin declares no hard dependencies: it reads `sessions`, `sessionTitle`,
 * and `logger` optionally, so a profile that lacks them still activates and
 * simply notifies less.
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
 * Going idle is only meaningful when a turn actually ended. This guards the
 * two cases where it is not: a session that was already idle when the plugin
 * mounted, and an agent that reaches `idle` before running anything. Scanning
 * backwards also stops at an open `turn/start`, so a session mid-turn is never
 * reported as finished.
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
   * Filter, render, and queue one notification.
   *
   * @param {string} kind - one of the `KIND_*` values.
   * @param {unknown} sessionId - the conversation the event belongs to.
   * @param {string} [detail] - the question, tool name, or error text.
   * @param {number} [durationMs] - how long the finished turn ran.
   */
  const notify = (kind, sessionId, detail, durationMs) => {
    if (config[KIND_SWITCH[kind]] !== true) return
    const session = lookupSession(sessionId)
    if (!config.includeSubagents && !isUserVisibleSession(session?.header)) return
    const message = buildNotification(kind, {
      sessionId,
      sessionTitle: resolveSessionTitle(session),
      detail,
      durationMs,
    })
    log(`notify ${kind}: ${message.title} / ${message.lines.join(' | ')}`)
    notifier.send(message.title, message.lines)
  }

  ctx.on('agent/status', (payload) => {
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
      if (outcome === undefined) return
      // An errored turn already produced its own notification from `agent/error`.
      if (outcome.kind === 'error') return

      const interrupted = outcome.kind === 'aborted' || outcome.kind === 'interrupted'
      if (!interrupted && config.minTaskDurationMs > 0 && startedAt !== undefined) {
        if (Date.now() - startedAt < config.minTaskDurationMs) return
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
  })

  ctx.on('agent/error', (payload) => {
    try {
      const failure = payload?.error
      const detail = failure instanceof Error
        ? failure.message
        : typeof failure === 'string' ? failure : ''
      notify(KIND_ERROR, payload?.agent?.id, detail)
    } catch (error) {
      log(`agent/error handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('user-questions/request', (request, next) => {
    try {
      const questions = request?.questions
      const first = Array.isArray(questions) ? questions[0] : undefined
      const question = typeof first?.question === 'string' ? first.question : ''
      notify(KIND_QUESTION, request?.agent?.id, question)
    } catch (error) {
      log(`user-questions/request handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  ctx.on('approval/request', (request, next) => {
    try {
      const toolName = typeof request?.toolName === 'string' ? request.toolName : '未知工具'
      const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
      notify(KIND_APPROVAL, request?.agent?.id, reason === '' ? `工具 ${toolName} 等待你确认。` : `工具 ${toolName}：${reason}`)
    } catch (error) {
      log(`approval/request handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    const sessionId = payload?.agent?.id
    if (sessionId !== undefined && sessionId !== null) runningSince.delete(sessionId)
  })

  ctx.effect(() => () => {
    runningSince.clear()
    notifier.dispose()
  }, `${name}: toast transport`)

  log(`active (appId=${config.appId}, includeSubagents=${String(config.includeSubagents)})`)
  if (config.notifyOnActivate) {
    notifier.send('🔔 dsh-windows-notifier 已启用', ['从现在起，任何对话需要你时都会弹出通知。'])
  }
}

export default { name, apply }