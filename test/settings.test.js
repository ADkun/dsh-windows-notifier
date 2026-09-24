/**
 * The settings namespace: what it declares, and how the plugin follows it.
 *
 * Two halves are covered here. The first is pure — the namespace name, the
 * schema, and the composition `base` a card inherits from. The second runs the
 * plugin body over a stand-in settings service to prove the part users actually
 * feel: a value saved in the GUI changes behaviour without a reload, and
 * `enabled` really does take the listeners off.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js'
import { apply } from '../src/plugin.js'
import {
  SETTINGS_NAMESPACE,
  SETTINGS_OPTIONS,
  SETTINGS_SCHEMA,
  buildSettingsSchema,
  loadSchema,
  settingsBase,
} from '../src/settings.js'

/** The plugin short-circuits off Windows, so the wiring tests are Windows-only. */
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows-only plugin' : false }

/** The namespace can only be registered where the harness ships schemastery. */
const schemaOnly = {
  skip: SETTINGS_SCHEMA === undefined ? 'this checkout has no @deepseek-ai/schemastery' : false,
}

/** A schemastery stand-in that records the shape a schema builder declared. */
function createFakeSchema() {
  const builder = (kind) => {
    const node = {
      kind,
      value: `${kind}:`,
      default(value) {
        node.value = `${kind}:${String(value)}`
        return node
      },
      description() {
        return node
      },
    }
    return node
  }
  return {
    boolean: () => builder('boolean'),
    number: () => builder('number'),
    string: () => builder('string'),
    object(shape) {
      const resolved = {}
      for (const [key, node] of Object.entries(shape)) resolved[key] = node.value
      return { dict: shape, resolved }
    },
  }
}

test('the namespace name is one the settings service accepts', () => {
  assert.match(SETTINGS_NAMESPACE, /^[a-z][a-z0-9-]*$/)
})

test('the schema covers exactly the options a card may override', () => {
  const schema = buildSettingsSchema(createFakeSchema())
  assert.deepEqual(Object.keys(schema.resolved), [...SETTINGS_OPTIONS])
  assert.equal(schema.resolved.enabled, 'boolean:true')
  assert.equal(schema.resolved.notifyOnActivate, 'boolean:false')
  assert.equal(schema.resolved.disappearAfterMs, 'number:6000')
  assert.equal(schema.resolved.openOnClick, 'boolean:true')
  assert.equal(schema.resolved.launchUrl, 'string:')
  assert.equal(schema.resolved.sound, 'string:default')
})

test('every schema default mirrors the plugin default', () => {
  const schema = buildSettingsSchema(createFakeSchema())
  // The two non-boolean kinds, so the assertion can name the control each
  // option is declared as instead of guessing from the default's type.
  const kindOf = (key) => {
    if (key === 'disappearAfterMs' || key === 'minTaskDurationMs') return 'number'
    if (key === 'sound' || key === 'launchUrl') return 'string'
    return 'boolean'
  }
  for (const key of SETTINGS_OPTIONS) {
    assert.equal(
      schema.resolved[key],
      `${kindOf(key)}:${String(DEFAULT_CONFIG[key])}`,
      `${key} default`,
    )
  }
})

test('building a schema is inert without schemastery', () => {
  assert.equal(buildSettingsSchema(undefined), undefined)
})

test('the schema loader agrees with the schema it produced', () => {
  assert.equal(SETTINGS_SCHEMA === undefined, loadSchema() === undefined)
})

test('the composition base carries the namespace options and nothing else', () => {
  const config = normalizeConfig({ notifyOnComplete: false, logFile: 'C:\\tmp\\n.log', maxConcurrent: 4 })
  const base = settingsBase(config)
  assert.deepEqual(Object.keys(base).sort(), [...SETTINGS_OPTIONS].sort())
  assert.equal(base.notifyOnComplete, false)
  assert.equal(base.disappearAfterMs, 6000)
  assert.equal(base.logFile, undefined)
  assert.equal(base.maxConcurrent, undefined)
})

test('the real schema resolves a full section', schemaOnly, () => {
  const resolved = SETTINGS_SCHEMA({ ...settingsBase(DEFAULT_CONFIG) })
  assert.deepEqual(Object.keys(resolved).sort(), [...SETTINGS_OPTIONS].sort())
  assert.equal(resolved.disappearAfterMs, 6000)
  assert.equal(resolved.sound, 'default')
})

/** A Cordis-context stand-in: listeners that can really be removed. */
function createContext(services) {
  const listeners = new Map()
  const effects = []
  const pending = []
  const context = {
    listeners,
    effects,
    on(event, handler, options) {
      const bucket = listeners.get(event) ?? []
      const entry = { handler, options }
      bucket.push(entry)
      listeners.set(event, bucket)
      return () => {
        const index = bucket.indexOf(entry)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    get(serviceName) {
      return services[serviceName]
    },
    /**
     * Cordis runs the callback once every named service exists and hands it a
     * context that exposes them as properties. A service that only appears
     * after `apply` still reaches the consumer — which is exactly why a plugin
     * waits instead of sampling the service once.
     */
    inject(dependencies, callback) {
      const open = () => {
        const injected = { ...context }
        for (const dependency of dependencies) injected[dependency] = services[dependency]
        callback(injected)
      }
      if (dependencies.every((dependency) => services[dependency] !== undefined)) open()
      else pending.push({ dependencies, open })
      return () => {}
    },
    /** Publish a service the way the composition does when its row activates. */
    provide(serviceName, service) {
      services[serviceName] = service
      for (const entry of [...pending]) {
        if (!entry.dependencies.every((dependency) => services[dependency] !== undefined)) continue
        pending.splice(pending.indexOf(entry), 1)
        entry.open()
      }
    },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    logger: { info() {} },
  }
  return context
}

/** A settings-service stand-in owning one namespace and its watchers. */
function createFakeSettings() {
  const registrations = []
  const watchers = []
  let section = {}
  return {
    registrations,
    register(ns, schema, options) {
      registrations.push({ ns, schema, options })
      section = { ...(options?.base ?? {}) }
      return {
        get: () => section,
        watch(callback) {
          watchers.push(callback)
          return () => {
            const index = watchers.indexOf(callback)
            if (index >= 0) watchers.splice(index, 1)
          }
        },
        update: async () => {},
        replace: async () => {},
      }
    },
    /** Commit a change the way a user's save would. */
    commit(patch) {
      const previous = section
      section = { ...section, ...patch }
      for (const watcher of [...watchers]) watcher(section, previous)
    },
  }
}

/** A live-session stand-in exposing only what the plugin reads. */
function fakeSession(id) {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { seq: events.length, header: { id, cwd: 'D:\\work\\demo' }, eventAt: (seq) => events[seq] }
}

/**
 * Run the plugin body over one fake settings service.
 *
 * @param t - the test context, for the temporary log file.
 * @param config - the composition row config.
 * @param settings - the settings stand-in, or `undefined` for a profile without one.
 * @param session - the live session to report on.
 * @returns the probe surface: the context, the settings service, and the log.
 */
function mountHost(t, config, settings, session = fakeSession('session-cccc1111-2222')) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-windows-notifier-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logFile = join(dir, 'notifier.log')
  const ctx = createContext({
    sessions: { get: (id) => (session.header.id === id ? session : undefined) },
    sessionTitle: { get: () => ({ title: '重构支付模块' }) },
    ...(settings === undefined ? {} : { settings }),
  })
  // A missing toast script keeps the transport a logged no-op.
  apply(ctx, { logFile, scriptPath: join(dir, 'missing-toast.ps1'), ...config })
  // Effects run the way Cordis runs them: immediately, keeping their disposer.
  for (const callback of ctx.effects) callback()
  return {
    ctx,
    settings,
    log: () => {
      try {
        return readFileSync(logFile, 'utf8')
      } catch {
        return ''
      }
    },
  }
}

const running = (id) => ['agent/status', { agent: { id }, status: 'running' }]
const idle = (id) => ['agent/status', { agent: { id }, status: 'idle' }]

/** Invoke every listener registered for one event. */
function fire(ctx, event, ...args) {
  return (ctx.listeners.get(event) ?? []).map(({ handler }) => handler(...args))
}

test('the namespace is registered over the composition row config', schemaOnly, windowsOnly, (t) => {
  const settings = createFakeSettings()
  const { log } = mountHost(t, { notifyOnComplete: false, maxConcurrent: 4 }, settings)

  assert.equal(settings.registrations.length, 1)
  const [registration] = settings.registrations
  assert.equal(registration.ns, SETTINGS_NAMESPACE)
  assert.equal(registration.options.applies, 'live')
  assert.equal(registration.options.base.notifyOnComplete, false, 'the row config is the base layer')
  assert.equal(registration.options.base.maxConcurrent, undefined, 'process-level knobs stay out')
  assert.match(log(), /settings namespace 'dsh-windows-notifier' registered/)
})

test('a value from the settings document beats the composition row config', schemaOnly, windowsOnly, (t) => {
  const settings = createFakeSettings()
  const session = fakeSession('session-dddd1111-2222')
  const { ctx, log } = mountHost(t, { notifyOnComplete: true }, settings, session)

  fire(ctx, ...running(session.header.id))
  fire(ctx, ...idle(session.header.id))
  assert.match(log(), /notify complete: ✅ 对话已完成 \/ 重构支付模块/)

  settings.commit({ notifyOnComplete: false })
  assert.match(log(), /reconfigured \(/)
  fire(ctx, ...running(session.header.id))
  fire(ctx, ...idle(session.header.id))
  assert.match(log(), /skip complete: switch off/)
})

test('disabling from the settings document takes the listeners off again', schemaOnly, windowsOnly, (t) => {
  const settings = createFakeSettings()
  const session = fakeSession('session-eeee1111-2222')
  const { ctx, log } = mountHost(t, { enabled: false, scriptPath: '' }, settings, session)

  assert.equal((ctx.listeners.get('internal/dispatch') ?? []).length, 0, 'a disabled row listens to nothing')
  assert.equal(settings.registrations.length, 1, 'but its card still exists, so it can be turned back on')

  settings.commit({ enabled: true })
  assert.equal((ctx.listeners.get('internal/dispatch') ?? []).length, 1)
  fire(ctx, ...running(session.header.id))
  fire(ctx, ...idle(session.header.id))
  assert.match(log(), /notify complete: ✅ 对话已完成/)

  settings.commit({ enabled: false })
  assert.equal((ctx.listeners.get('internal/dispatch') ?? []).length, 0)
  assert.match(log(), /listening stopped: disabled/)
})

test('a profile without a settings service stays composition-only', windowsOnly, (t) => {
  const { log } = mountHost(t, {}, undefined)
  assert.match(log(), /waiting for the settings service/)
  assert.match(log(), /active \(appId=/)
})

test('a settings service that arrives after apply still gets the namespace', schemaOnly, windowsOnly, (t) => {
  const probe = mountHost(t, {}, undefined)
  assert.match(probe.log(), /waiting for the settings service/)
  assert.doesNotMatch(probe.log(), /registered/)

  // Now the composition mounts the provider, exactly as it does in a profile
  // where the settings row activates after this one.
  const settings = createFakeSettings()
  probe.ctx.provide('settings', settings)
  assert.equal(settings.registrations.length, 1)
  assert.equal(settings.registrations[0].ns, 'dsh-windows-notifier')
  assert.match(probe.log(), /settings namespace 'dsh-windows-notifier' registered/)

  // ...and the namespace is live, not just registered.
  settings.commit({ openOnClick: false })
  assert.match(probe.log(), /reconfigured \(disappearAfterMs=6000, openOnClick=false/)
})

test('the live options reach the toast transport', schemaOnly, windowsOnly, (t) => {
  const settings = createFakeSettings()
  const { log } = mountHost(t, { disappearAfterMs: 6000, openOnClick: true }, settings)
  assert.match(log(), /active \(appId=.*, includeSubagents=false, disappearAfterMs=6000, openOnClick=true\)/)

  settings.commit({ disappearAfterMs: 0, openOnClick: false })
  assert.match(log(), /reconfigured \(disappearAfterMs=0, openOnClick=false/)
})