/**
 * Configuration normalization for dsh-windows-notifier.
 *
 * A composed row passes its `config:` block straight through, and this module
 * turns it into a fully-populated option object. The plugin deliberately
 * exports no Cordis `Config` schema, so nothing here rejects unknown keys — a
 * malformed value falls back to its default and is reported through the
 * plugin's own logger instead of failing the profile load.
 *
 * @module dsh-windows-notifier/config
 */

/**
 * The well-known `AppUserModelID` of Windows PowerShell v1.0.
 *
 * A toast needs a registered AUMID, and this one exists on every Windows
 * install, which keeps the plugin install-free. Windows renders the toast
 * under the "Windows PowerShell" app name; override `appId` if you registered
 * your own Start-menu shortcut.
 */
export const POWERSHELL_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Every option with its default, as one frozen reference object. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; `false` makes `apply` contribute nothing at all. */
  enabled: true,
  /** Send one "plugin is active" toast as soon as the row activates. */
  notifyOnActivate: false,
  /** Notify for subagent / workflow child sessions as well. */
  includeSubagents: false,
  /** A turn ended normally: the conversation is waiting for your next message. */
  notifyOnComplete: true,
  /** The agent asked a structured question (`ask_user_question`). */
  notifyOnQuestion: true,
  /** The agent is blocked on an approval decision. */
  notifyOnApproval: true,
  /** A step or turn errored. */
  notifyOnError: true,
  /** A turn was aborted/interrupted (usually the user stopped it). */
  notifyOnInterrupted: false,
  /** Suppress completion toasts for turns shorter than this many milliseconds. */
  minTaskDurationMs: 0,
  /** `default` plays the standard toast sound, `silent` mutes it. */
  sound: 'default',
  /**
   * How long a notification should stay around, in milliseconds.
   *
   * `0` means "do not disappear on its own": the toast stays on screen until
   * the user dismisses it. Any other value selects the nearest banner step
   * Windows supports (~5s / ~25s) and removes the Action Center copy at
   * exactly this time.
   */
  disappearAfterMs: 6000,
  /** Whether a click on the toast opens the Web GUI. */
  openOnClick: true,
  /** `AppUserModelID` the toast is shown under. */
  appId: POWERSHELL_APP_ID,
  /** Explicit `powershell.exe` path; empty auto-detects the Windows one. */
  powershellPath: '',
  /** Explicit `toast.ps1` path; empty uses the copy shipped in this package. */
  scriptPath: '',
  /**
   * URL a click on the toast opens. Empty asks the running Web GUI for its own
   * loopback address; `{sessionId}` is substituted when present.
   */
  launchUrl: '',
  /** Append a debug log to this file; empty disables file logging. */
  logFile: '',
  /** How many `powershell.exe` processes may run at once. */
  maxConcurrent: 1,
  /** Kill a notification process that outlives this many milliseconds. */
  timeoutMs: 15000,
})

/** @returns {boolean} whether `value` is a plain object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a boolean, falling back when the value is absent or of another type. */
function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a finite number, falling back when the value is absent or invalid. */
function readNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Clamp `value` into `[min, max]`. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Read a non-empty trimmed string, or `undefined` when there is none. */
function readText(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read a string restricted to `allowed`, ignoring anything else. */
function readEnum(value, allowed, fallback) {
  const text = readText(value)
  return text !== undefined && allowed.includes(text) ? text : fallback
}

/**
 * Normalize one raw `config:` block into a complete option object.
 *
 * @param {unknown} raw - the row's configuration, as composed from YAML.
 * @returns {typeof DEFAULT_CONFIG} every option resolved to a usable value.
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  return {
    enabled: readBoolean(input.enabled, DEFAULT_CONFIG.enabled),
    notifyOnActivate: readBoolean(input.notifyOnActivate, DEFAULT_CONFIG.notifyOnActivate),
    includeSubagents: readBoolean(input.includeSubagents, DEFAULT_CONFIG.includeSubagents),
    notifyOnComplete: readBoolean(input.notifyOnComplete, DEFAULT_CONFIG.notifyOnComplete),
    notifyOnQuestion: readBoolean(input.notifyOnQuestion, DEFAULT_CONFIG.notifyOnQuestion),
    notifyOnApproval: readBoolean(input.notifyOnApproval, DEFAULT_CONFIG.notifyOnApproval),
    notifyOnError: readBoolean(input.notifyOnError, DEFAULT_CONFIG.notifyOnError),
    notifyOnInterrupted: readBoolean(input.notifyOnInterrupted, DEFAULT_CONFIG.notifyOnInterrupted),
    minTaskDurationMs: clamp(readNumber(input.minTaskDurationMs, DEFAULT_CONFIG.minTaskDurationMs), 0, 86_400_000),
    sound: readEnum(input.sound, ['default', 'silent'], DEFAULT_CONFIG.sound),
    disappearAfterMs: clamp(Math.round(readNumber(input.disappearAfterMs, DEFAULT_CONFIG.disappearAfterMs)), 0, 86_400_000),
    openOnClick: readBoolean(input.openOnClick, DEFAULT_CONFIG.openOnClick),
    appId: readText(input.appId) ?? DEFAULT_CONFIG.appId,
    powershellPath: readText(input.powershellPath) ?? DEFAULT_CONFIG.powershellPath,
    scriptPath: readText(input.scriptPath) ?? DEFAULT_CONFIG.scriptPath,
    launchUrl: readText(input.launchUrl) ?? DEFAULT_CONFIG.launchUrl,
    logFile: readText(input.logFile) ?? DEFAULT_CONFIG.logFile,
    maxConcurrent: clamp(Math.round(readNumber(input.maxConcurrent, DEFAULT_CONFIG.maxConcurrent)), 1, 8),
    timeoutMs: clamp(Math.round(readNumber(input.timeoutMs, DEFAULT_CONFIG.timeoutMs)), 1000, 120_000),
  }
}