/**
 * The Windows toast transport for dsh-windows-notifier.
 *
 * A notification is one short-lived `powershell.exe` process running the
 * `scripts/toast.ps1` companion. Windows PowerShell v1.0 exposes the WinRT
 * `Windows.UI.Notifications` types directly, so no module has to be installed
 * and no COM server has to stay resident — the trade-off is process startup
 * cost, which is absorbed by a small queue that caps how many run at once.
 *
 * @module dsh-windows-notifier/notify
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the package root, derived from this module's URL. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The `toast.ps1` shipped with this package. */
export const DEFAULT_SCRIPT_PATH = join(PACKAGE_ROOT, 'scripts', 'toast.ps1')

/**
 * Locate the Windows PowerShell host.
 *
 * `pwsh` (PowerShell 7+) cannot project the WinRT notification types without
 * extra modules, so the Windows-shipped `powershell.exe` is the only correct
 * choice here — and it exists on every supported Windows install.
 *
 * @param {string} configured - an explicit path from the row config, if any.
 * @returns {string | undefined} the path to use, or `undefined` if none exists.
 */
export function resolvePowershellPath(configured) {
  const candidates = []
  if (configured !== '') candidates.push(configured)
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  if (typeof systemRoot === 'string' && systemRoot !== '') {
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  candidates.push('powershell.exe')
  return candidates.find((candidate) => candidate === 'powershell.exe' || existsSync(candidate))
}

/**
 * Create the notification sender for one running plugin.
 *
 * @param {object} options - resolved plugin options (see `config.js`).
 * @param {(message: string) => void} log - the plugin's logger.
 * @returns {{ send: (title: string, lines: string[]) => void, dispose: () => void }}
 *   `send` never throws and never blocks the caller; `dispose` drops anything
 *   still queued and kills the processes already running.
 */
export function createNotifier(options, log) {
  const scriptPath = options.scriptPath === '' ? DEFAULT_SCRIPT_PATH : options.scriptPath
  const powershellPath = resolvePowershellPath(options.powershellPath)

  /** @type {Array<{ title: string, lines: string[] }>} */
  const queue = []
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const live = new Set()
  let active = 0
  let disposed = false

  if (powershellPath === undefined) {
    log('no powershell.exe found; notifications are disabled')
    return { send: () => {}, dispose: () => {} }
  }
  if (!existsSync(scriptPath)) {
    log(`toast script not found at ${scriptPath}; notifications are disabled`)
    return { send: () => {}, dispose: () => {} }
  }

  /** Start as many queued notifications as the concurrency budget allows. */
  function pump() {
    while (!disposed && active < options.maxConcurrent && queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) return
      active += 1
      run(next)
    }
  }

  /**
   * Spawn one `powershell.exe` for one notification.
   *
   * Arguments travel as an argv array, so a title containing quotes, spaces,
   * ampersands, or CJK text reaches PowerShell verbatim; only the XML inside
   * the script needs escaping.
   */
  function run({ title, lines }) {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(
        powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-Title', title,
          '-Body', lines.join('\n'),
          '-AppId', options.appId,
          '-Sound', options.sound,
          '-Duration', options.duration,
        ],
        { stdio: 'ignore', windowsHide: true },
      )
    } catch (error) {
      active -= 1
      log(`failed to start powershell: ${error instanceof Error ? error.message : String(error)}`)
      pump()
      return
    }
    live.add(child)
    const timer = setTimeout(() => {
      log('powershell notification timed out; killing it')
      try {
        child.kill()
      } catch {
        // A process that already exited needs no kill.
      }
    }, options.timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const settle = (note) => {
      clearTimeout(timer)
      live.delete(child)
      active -= 1
      if (note !== undefined) log(note)
      pump()
    }

    child.on('error', (error) => {
      settle(`powershell error: ${error instanceof Error ? error.message : String(error)}`)
    })
    child.on('exit', (code, signal) => {
      const failed = signal !== null || (code !== null && code !== 0)
      settle(failed ? `powershell exited with code ${String(code)} signal ${String(signal)}` : undefined)
    })
  }

  return {
    /**
     * Queue one notification.
     *
     * @param {string} title - the bold first toast line.
     * @param {string[]} lines - the body lines, one `<text>` element each.
     */
    send(title, lines) {
      if (disposed) return
      queue.push({ title, lines })
      pump()
    },
    /** Drop the queue and terminate every running notification process. */
    dispose() {
      disposed = true
      queue.length = 0
      for (const child of live) {
        try {
          child.kill()
        } catch {
          // Nothing to clean up for an already-exited process.
        }
      }
      live.clear()
    },
  }
}