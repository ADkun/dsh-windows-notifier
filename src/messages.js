/**
 * Pure message-shaping helpers for dsh-windows-notifier.
 *
 * Everything here is side-effect free and takes plain scalars, which keeps the
 * wording and the session filtering testable without a Windows host or a live
 * DSH process.
 *
 * @module dsh-windows-notifier/messages
 */

/** A turn finished and the conversation accepts the next user message. */
export const KIND_COMPLETE = 'complete'
/** The agent asked for structured user input. */
export const KIND_QUESTION = 'question'
/** The agent is waiting for an approval decision. */
export const KIND_APPROVAL = 'approval'
/** A step or turn errored. */
export const KIND_ERROR = 'error'
/** A turn was aborted or interrupted. */
export const KIND_INTERRUPTED = 'interrupted'

/** Collapse whitespace and cut `text` down to `max` characters. */
export function truncate(text, max = 200) {
  const value = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/**
 * A short, stable human label for a session that has no title yet.
 *
 * @param {unknown} sessionId - the raw session identity.
 * @returns {string} its first eight characters, for use inside a message.
 */
export function sessionLabel(sessionId) {
  const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId)
  const body = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return body.length > 8 ? body.slice(0, 8) : body
}

/**
 * Decide whether a conversation is one the user actually sees.
 *
 * Subagent runs and workflow child agents are real sessions, but they are not
 * conversations in the sidebar, and notifying for each of them turns one
 * background task into a burst of toasts.
 *
 * @param {{ origin?: string, parentSession?: unknown } | undefined | null} header
 *   the session header, or `undefined` when the session is not attached.
 * @returns {boolean} whether a toast for this session is worth showing.
 */
export function isUserVisibleSession(header) {
  if (header === undefined || header === null) return true
  if (header.origin === 'subagent') return false
  if (header.parentSession !== undefined && header.parentSession !== null) return false
  return true
}

/**
 * Render a duration the way a notification should read it.
 *
 * @param {unknown} ms - elapsed milliseconds; anything invalid yields `''`.
 * @returns {string} a compact Chinese duration, or `''`.
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** The heading shown on the first toast line, per kind. */
const KIND_TITLES = Object.freeze({
  [KIND_COMPLETE]: '✅ 对话已完成',
  [KIND_QUESTION]: '❓ 需要你的输入',
  [KIND_APPROVAL]: '🔐 需要你批准',
  [KIND_ERROR]: '❌ 对话出错',
  [KIND_INTERRUPTED]: '⏹️ 本轮已中止',
})

/**
 * Build the toast heading and body lines for one notification.
 *
 * @param {string} kind - one of the exported `KIND_*` values.
 * @param {object} [fields] - the context gathered at the event site.
 * @param {unknown} [fields.sessionId] - session identity, for a fallback label.
 * @param {string} [fields.sessionTitle] - the folded session title, when known.
 * @param {string} [fields.detail] - the question, tool name, or error text.
 * @param {number} [fields.durationMs] - how long the finished turn ran.
 * @returns {{ title: string, lines: string[] }} heading plus non-empty body lines.
 */
export function buildNotification(kind, fields = {}) {
  const title = KIND_TITLES[kind] ?? KIND_TITLES[KIND_COMPLETE]
  const fallbackLabel = sessionLabel(fields.sessionId)
  const label = truncate(fields.sessionTitle, 80)
    || (fallbackLabel === '' ? '未命名对话' : `会话 ${fallbackLabel}`)
  const detail = truncate(fields.detail, 220)

  /** @type {string[]} */
  const lines = [label]

  if (kind === KIND_COMPLETE) {
    const duration = formatDuration(fields.durationMs)
    lines.push(duration === '' ? '可以继续对话了。' : `已运行 ${duration}，可以继续对话了。`)
  } else if (kind === KIND_QUESTION) {
    lines.push(detail === '' ? '智能体正在等你回答。' : detail)
  } else if (kind === KIND_APPROVAL) {
    lines.push(detail === '' ? '有一个操作需要你确认。' : detail)
  } else if (kind === KIND_ERROR) {
    lines.push(detail === '' ? '本轮以错误结束。' : detail)
  } else if (kind === KIND_INTERRUPTED) {
    lines.push('本轮已被中止。')
  }

  return { title, lines: lines.filter((line) => line !== '') }
}