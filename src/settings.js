/**
 * The live configuration schema behind the browser-side settings page
 * (**设置 → Windows 通知**, the `settings.section` entry `src/client.js` registers).
 *
 * DSH 0.1.7 replaced the plugin-registered settings namespace with a form
 * derived from each profile entry's own `Config`: the Host projects one
 * descriptor per active entry (`@deepseek-ai/dsh-settings`, `describe()`), that
 * page renders it, and only fields declared `.volatile()` can be edited
 * while the plugin runs. The entry is addressed by its own row id, so this
 * package no longer owns a namespace and never registers one.
 *
 * Two consequences shape this module:
 *
 * 1. `Config` must be part of the plugin object the Loader resolves — the
 *    default export of `src/plugin.js`. It is built once, at module evaluation,
 *    and schemastery is still resolved at runtime rather than imported
 *    statically: it ships with the harness, but a checkout of this repository
 *    has no `node_modules` at all. A deployment that cannot resolve it loses
 *    the form and keeps everything else — the plugin never fails to load over a
 *    UI it may not even be able to show.
 * 2. Only genuinely live switches become volatile fields. `logFile` is one of
 *    them — the host half re-reads it before every line it writes, so a form may
 *    edit the debug log's path and have it apply at once. The install-time
 *    infrastructure knobs (`appId`, `powershellPath`, `scriptPath`,
 *    `maxConcurrent`, `timeoutMs`) stay ordinary fields, so no form can present
 *    a value as reload-free when changing it would not be.
 *
 * @module dsh-windows-notifier/settings
 */

import { createRequire } from 'node:module'

import { DEFAULT_CONFIG } from './config.js'

const localRequire = createRequire(import.meta.url)

/** The specifier the harness's own schema library resolves to. */
export const SCHEMA_SPECIFIER = '@deepseek-ai/schemastery'

/**
 * The options a form may edit while the plugin runs, in form order.
 *
 * Exactly these are declared `.volatile()`: each arrives as a stable reference
 * the Loader rewrites in place, so a value saved in the Plugins page reaches
 * the running plugin without a reload.
 */
export const LIVE_OPTIONS = Object.freeze([
  'enabled',
  'notifyOnComplete',
  'notifyOnQuestion',
  'notifyOnApproval',
  'notifyOnError',
  'notifyOnInterrupted',
  'notifyOnActivate',
  'includeSubagents',
  'waitForSubagents',
  'disappearAfterMs',
  'openOnClick',
  'launchUrl',
  'minTaskDurationMs',
  'sound',
  'logFile',
])

/**
 * The install-time infrastructure knobs, deliberately outside the form.
 *
 * They are declared all the same, so the row's `config:` block is fully
 * described and validated — but as ordinary fields, whose change is applied
 * only when the plugin is mounted again.
 */
export const ORDINARY_OPTIONS = Object.freeze([
  'appId',
  'powershellPath',
  'scriptPath',
  'maxConcurrent',
  'timeoutMs',
])

/** Hint the form shows beside each live option, keyed by option name. */
const LIVE_DESCRIPTIONS = Object.freeze({
  enabled: '总开关；关掉后不再有任何通知',
  notifyOnComplete: '对话完成、可以继续输入时通知',
  notifyOnQuestion: '智能体向你提问时通知',
  notifyOnApproval: '操作等待你批准时通知',
  notifyOnError: '出错时通知',
  notifyOnInterrupted: '对话被中断时通知',
  notifyOnActivate: '插件启用时先发一条通知',
  includeSubagents: '子智能体自己的「结束」也通知（提问/审批/出错始终通知）',
  waitForSubagents: '会话名下还有子智能体在跑时，先不通知它「已完成」；等子智能体全部结束、调度方真正收尾时再通知',
  disappearAfterMs: '通知停留时长（毫秒）；0 = 一直留到手动关闭',
  openOnClick: '点击通知时打开 DSH Web 界面',
  launchUrl: '点击通知打开的地址；留空 = 当前 Web 界面，可用 {sessionId}',
  minTaskDurationMs: '短于该时长的任务不通知（毫秒）；0 = 不限制',
  sound: 'default 播放提示音；silent 静音',
  logFile: '排查日志的路径；留空 = 不写日志文件（改完立刻生效）',
})

/**
 * Resolve the harness's schema library.
 *
 * @returns {object | undefined} the schemastery namespace, or `undefined` when
 * the running environment has no copy of it.
 */
export function loadSchema() {
  try {
    const loaded = localRequire(SCHEMA_SPECIFIER)
    const schema = loaded?.default ?? loaded
    return typeof schema?.object === 'function' ? schema : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the row's `Config` schema.
 *
 * Defaults intentionally mirror `DEFAULT_CONFIG`, so a row whose `config:` block
 * omits a key resolves to the plugin's own default.
 *
 * @param {object | undefined} Schema - schemastery, when it resolved.
 * @returns {object | undefined} the schema, or `undefined` without schemastery.
 */
export function buildConfigSchema(Schema) {
  if (Schema === undefined) return undefined
  /** One live field: a default plus the `.volatile()` marker the form reads. */
  const live = (node, key) =>
    node.default(DEFAULT_CONFIG[key]).volatile().description(LIVE_DESCRIPTIONS[key])
  /** One composition-only field: declared and validated, never writable live. */
  const fixed = (node, key) => node.default(DEFAULT_CONFIG[key])
  return Schema.object({
    enabled: live(Schema.boolean(), 'enabled'),
    notifyOnComplete: live(Schema.boolean(), 'notifyOnComplete'),
    notifyOnQuestion: live(Schema.boolean(), 'notifyOnQuestion'),
    notifyOnApproval: live(Schema.boolean(), 'notifyOnApproval'),
    notifyOnError: live(Schema.boolean(), 'notifyOnError'),
    notifyOnInterrupted: live(Schema.boolean(), 'notifyOnInterrupted'),
    notifyOnActivate: live(Schema.boolean(), 'notifyOnActivate'),
    includeSubagents: live(Schema.boolean(), 'includeSubagents'),
    waitForSubagents: live(Schema.boolean(), 'waitForSubagents'),
    disappearAfterMs: live(Schema.number(), 'disappearAfterMs'),
    openOnClick: live(Schema.boolean(), 'openOnClick'),
    launchUrl: live(Schema.string(), 'launchUrl'),
    minTaskDurationMs: live(Schema.number(), 'minTaskDurationMs'),
    sound: live(Schema.string(), 'sound'),
    logFile: live(Schema.string(), 'logFile'),
    appId: fixed(Schema.string(), 'appId'),
    powershellPath: fixed(Schema.string(), 'powershellPath'),
    scriptPath: fixed(Schema.string(), 'scriptPath'),
    maxConcurrent: fixed(Schema.number(), 'maxConcurrent'),
    timeoutMs: fixed(Schema.number(), 'timeoutMs'),
  })
}

/** The row's schema, or `undefined` in an environment without schemastery. */
export const Config = buildConfigSchema(loadSchema())

/**
 * Read one resolved field of a row's Config.
 *
 * A volatile field arrives as the stable reference the Loader rewrites when a
 * saved value is applied, so `.get()` is where a live value comes from; every
 * ordinary field is plain data and passes through untouched.
 *
 * @param {unknown} value - one field of the resolved config.
 * @returns {unknown} the current plain value.
 */
export function readField(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

/**
 * Resolve every field of a row's Config into plain values.
 *
 * @param {unknown} config - the resolved config the Loader handed to `apply`.
 * @returns {Record<string, unknown>} plain values, ready for `normalizeConfig`.
 */
export function readConfig(config) {
  const plain = {}
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return plain
  for (const [key, value] of Object.entries(config)) plain[key] = readField(value)
  return plain
}