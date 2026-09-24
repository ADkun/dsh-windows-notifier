/**
 * The settings namespace behind the browser-side configuration card.
 *
 * DSH's plugin settings section intersects two ledgers: the namespaces the
 * running Host serves, and the cards registered in the browser under those
 * namespace keys. This module owns the first half — the namespace name, the
 * schemastery schema a card renders, and the composition layer its values
 * inherit from.
 *
 * The schema deliberately covers only the *live* switches: everything here can
 * be changed while the plugin runs. Process-level knobs (`appId`,
 * `powershellPath`, `scriptPath`, `logFile`, `maxConcurrent`, `timeoutMs`)
 * stay out of the namespace on purpose, so no card can present a value as
 * reload-free when changing it would not be.
 *
 * Schemastery is resolved at runtime rather than imported statically: it ships
 * with the harness (`@deepseek-ai/dsh-settings` depends on it), but a checkout
 * of this repository has no `node_modules` at all. A deployment that cannot
 * resolve it loses the configuration card and keeps everything else — the
 * plugin never fails to load over a UI it may not even be able to show.
 *
 * @module dsh-windows-notifier/settings
 */

import { createRequire } from 'node:module'

import { DEFAULT_CONFIG } from './config.js'

const localRequire = createRequire(import.meta.url)

/**
 * Settings namespace owned by this plugin.
 *
 * Also the slot key of the configuration card, which is how the settings
 * section pairs a served namespace with the card that edits it.
 */
export const SETTINGS_NAMESPACE = 'dsh-windows-notifier'

/** The specifier the harness's own schema library resolves to. */
export const SCHEMA_SPECIFIER = '@deepseek-ai/schemastery'

/**
 * The options the namespace resolves, in card order.
 *
 * A resolved namespace section is merged *over* the composition row config, so
 * this list is also exactly what a browser card may override.
 */
export const SETTINGS_OPTIONS = Object.freeze([
  'enabled',
  'notifyOnComplete',
  'notifyOnQuestion',
  'notifyOnApproval',
  'notifyOnError',
  'notifyOnInterrupted',
  'notifyOnActivate',
  'includeSubagents',
  'disappearAfterMs',
  'openOnClick',
  'launchUrl',
  'minTaskDurationMs',
  'sound',
])

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
 * Build the namespace schema.
 *
 * Defaults intentionally mirror `DEFAULT_CONFIG`, so a namespace whose
 * composition `base` omits a key still resolves to the plugin's own default.
 *
 * @param {object | undefined} Schema - schemastery, when it resolved.
 * @returns {object | undefined} the schema, or `undefined` without schemastery.
 */
export function buildSettingsSchema(Schema) {
  if (Schema === undefined) return undefined
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled).description('总开关；关掉后不再有任何通知'),
    notifyOnComplete: Schema.boolean().default(DEFAULT_CONFIG.notifyOnComplete).description('对话完成、可以继续输入时通知'),
    notifyOnQuestion: Schema.boolean().default(DEFAULT_CONFIG.notifyOnQuestion).description('智能体向你提问时通知'),
    notifyOnApproval: Schema.boolean().default(DEFAULT_CONFIG.notifyOnApproval).description('操作等待你批准时通知'),
    notifyOnError: Schema.boolean().default(DEFAULT_CONFIG.notifyOnError).description('出错时通知'),
    notifyOnInterrupted: Schema.boolean().default(DEFAULT_CONFIG.notifyOnInterrupted).description('对话被中断时通知'),
    notifyOnActivate: Schema.boolean().default(DEFAULT_CONFIG.notifyOnActivate).description('插件启用时先发一条通知'),
    includeSubagents: Schema.boolean().default(DEFAULT_CONFIG.includeSubagents).description('子智能体与工作流会话也通知'),
    disappearAfterMs: Schema.number().default(DEFAULT_CONFIG.disappearAfterMs).description('通知停留时长（毫秒）；0 = 一直留到手动关闭'),
    openOnClick: Schema.boolean().default(DEFAULT_CONFIG.openOnClick).description('点击通知时打开 DSH Web 界面'),
    launchUrl: Schema.string().default(DEFAULT_CONFIG.launchUrl).description('点击通知打开的地址；留空 = 当前 Web 界面，可用 {sessionId}'),
    minTaskDurationMs: Schema.number().default(DEFAULT_CONFIG.minTaskDurationMs).description('短于该时长的任务不通知（毫秒）；0 = 不限制'),
    sound: Schema.string().default(DEFAULT_CONFIG.sound).description('default 播放提示音；silent 静音'),
  })
}

/** The namespace schema, or `undefined` in an environment without schemastery. */
export const SETTINGS_SCHEMA = buildSettingsSchema(loadSchema())

/**
 * The composition-layer `base` for the namespace.
 *
 * Only the namespace's own options travel: the schema would drop anything else
 * anyway, and a base that carried the process-level knobs would invite a card
 * to edit values a reload cannot apply.
 *
 * @param {Record<string, unknown>} config - the normalized composition config.
 * @returns {Record<string, unknown>} the base section handed to `register`.
 */
export function settingsBase(config) {
  const base = {}
  for (const key of SETTINGS_OPTIONS) base[key] = config[key]
  return base
}