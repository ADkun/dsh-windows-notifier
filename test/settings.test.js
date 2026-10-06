/**
 * The live configuration schema, and how the plugin follows it.
 *
 * DSH 0.1.7 removed the plugin-registered settings namespace: a row's form is
 * now derived from its own `Config`, whose `.volatile()` fields arrive as
 * references the Harness rewrites in place when a saved value is applied. Two
 * halves are covered here. The first is pure — the option lists, the schema they
 * build, and how a resolved config is read back. The second runs the plugin body
 * over a Cordis stand-in to prove the part users actually feel: a value saved in
 * the Plugins page changes behaviour without a reload, and `enabled` gates every
 * report while the listeners stay attached for the row's whole life.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG } from '../src/config.js'
import { apply } from '../src/plugin.js'
import {
  Config,
  LIVE_OPTIONS,
  ORDINARY_OPTIONS,
  SCHEMA_SPECIFIER,
  buildConfigSchema,
  loadSchema,
  readConfig,
  readField,
} from '../src/settings.js'

/** The plugin short-circuits off Windows, so the wiring tests are Windows-only. */
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows-only plugin' : false }

/** The schema-dependent half can only run where schemastery resolves. */
const schemaOnly = {
  skip: loadSchema() === undefined ? `this checkout has no ${SCHEMA_SPECIFIER}` : false,
}

/**
 * Both conditions at once.
 *
 * `node:test` takes its options as a single argument: called with two options
 * objects, the second is dropped along with the test body.
 */
const windowsAndSchema = { skip: windowsOnly.skip || schemaOnly.skip }

/** A schemastery stand-in that records what each builder was told. */
function createFakeSchema() {
  const builder = (kind) => {
    const node = {
      kind,
      value: undefined,
      live: false,
      description: undefined,
      default(value) {
        node.value = value
        return node
      },
      volatile() {
        node.live = true
        return node
      },
      description(text) {
        node.description = text
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
      return { dict: shape }
    },
  }
}

test('the live and ordinary option lists are disjoint and name real options', () => {
  assert.equal(LIVE_OPTIONS.length, 15)
  assert.equal(ORDINARY_OPTIONS.length, 5)
  const all = [...LIVE_OPTIONS, ...ORDINARY_OPTIONS]
  assert.equal(new Set(all).size, all.length, 'no option appears twice')
  for (const key of all) {
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key), `${key} is a real option`)
  }
})

test('the schema declares exactly the live options volatile, in form order', () => {
  const schema = buildConfigSchema(createFakeSchema())
  assert.deepEqual(Object.keys(schema.dict), [...LIVE_OPTIONS, ...ORDINARY_OPTIONS])
  for (const key of LIVE_OPTIONS) {
    assert.equal(schema.dict[key].live, true, `${key} is a live field`)
    assert.equal(typeof schema.dict[key].description, 'string', `${key} carries a form hint`)
  }
  for (const key of ORDINARY_OPTIONS) {
    assert.equal(schema.dict[key].live, false, `${key} stays composition-only`)
    assert.notEqual(typeof schema.dict[key].description, 'string', `${key} is never shown in the form`)
  }
})

test('every schema default mirrors the plugin default', () => {
  const schema = buildConfigSchema(createFakeSchema())
  // The kind follows from the default's own type, so a new option is covered
  // without this test having to grow a lookup table alongside it.
  const kindOf = (value) =>
    typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string'
  for (const [key, node] of Object.entries(schema.dict)) {
    assert.equal(node.kind, kindOf(DEFAULT_CONFIG[key]), `${key} control`)
    assert.equal(node.value, DEFAULT_CONFIG[key], `${key} default`)
  }
})

test('building a schema is inert without schemastery', () => {
  assert.equal(buildConfigSchema(undefined), undefined)
})

test('the schema loader agrees with the schema it produced', () => {
  // `Config` is built once from `loadSchema()` at module evaluation, so the two
  // must always agree about whether schemastery was there at all.
  assert.equal(Config === undefined, loadSchema() === undefined)
})

test('readField unwraps a volatile reference and leaves plain data alone', () => {
  let value = false
  const ref = { get: () => value }
  assert.equal(readField(ref), false)
  value = true
  assert.equal(readField(ref), true, 'the reference is read, not its value at build time')
  assert.equal(readField('silent'), 'silent')
  assert.equal(readField(6000), 6000)
  assert.equal(readField(undefined), undefined)
})

test('readConfig flattens a resolved row config into plain values', () => {
  let enabled = false
  const resolved = {
    enabled: { get: () => enabled },
    disappearAfterMs: { get: () => 6000 },
    appId: 'aumid',
    timeoutMs: 15000,
  }
  assert.deepEqual(readConfig(resolved), {
    enabled: false,
    disappearAfterMs: 6000,
    appId: 'aumid',
    timeoutMs: 15000,
  })
  enabled = true
  assert.equal(readConfig(resolved).enabled, true, 'a volatile field is re-read, never cached')
  for (const malformed of [undefined, null, 'nonsense', [], 7]) {
    assert.deepEqual(readConfig(malformed), {}, `${String(malformed)} flattens to nothing`)
  }
})

test('the real schema resolves 15 volatile fields and 5 plain ones', schemaOnly, () => {
  const resolved = Config({ enabled: false, disappearAfterMs: 0 })
  assert.deepEqual(
    Object.keys(resolved).sort(),
    [...LIVE_OPTIONS, ...ORDINARY_OPTIONS].sort(),
    'the schema declares every option and nothing else',
  )
  for (const key of LIVE_OPTIONS) {
    assert.equal(typeof resolved[key]?.get, 'function', `${key} arrives as a volatile reference`)
  }
  for (const key of ORDINARY_OPTIONS) {
    assert.notEqual(typeof resolved[key]?.get, 'function', `${key} arrives as plain data`)
  }
  assert.equal(resolved.enabled.get(), false, 'the row config wins over the default')
  assert.equal(resolved.disappearAfterMs.get(), 0)
  assert.equal(resolved.sound.get(), DEFAULT_CONFIG.sound)
  assert.equal(resolved.logFile.get(), '')
  assert.equal(resolved.appId, DEFAULT_CONFIG.appId)

  const plain = readConfig(resolved)
  assert.equal(Object.keys(plain).length, LIVE_OPTIONS.length + ORDINARY_OPTIONS.length)
  assert.equal(plain.enabled, false)
  assert.equal(plain.disappearAfterMs, 0)
  assert.equal(plain.appId, DEFAULT_CONFIG.appId)
})

test('the real schema rejects a value of the wrong type', schemaOnly, () => {
  assert.throws(() => Config({ enabled: 'yes' }))
  assert.throws(() => Config({ disappearAfterMs: 'soon' }))
})

/** A volatile reference stand-in: one value the Harness rewrites in place. */
function liveRef(initial) {
  let value = initial
  return {
    get: () => value,
    set: (next) => {
      value = next
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
 * A Cordis-context stand-in: listeners that can really be removed, effects that
 * run immediately, and an `inject` that waits for its services the way Cordis
 * does.
 */
function createContext(services) {
  const listeners = new Map()
  const disposers = []
  const injectRequests = []
  const pending = []
  const fiber = { id: 'row-fiber' }

  /** Hand one callback the child context Cordis would build for it. */
  const deliver = (dependencies, callback) => {
    const injected = {
      ...context,
      // A child context has its own effect scope, so the effect it registers is
      // not mistaken for one of the plugin's own.
      effect(effectCallback) {
        const dispose = effectCallback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    }
    for (const dependency of dependencies) injected[dependency] = services[dependency]
    callback(injected)
  }

  const context = {
    listeners,
    disposers,
    injectRequests,
    fiber,
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
     * child context exposing them as properties. A service that only appears
     * after `apply` still reaches the consumer — which is why a plugin waits
     * instead of sampling the service once.
     */
    inject(dependencies, callback) {
      injectRequests.push([...dependencies])
      if (dependencies.every((dependency) => services[dependency] !== undefined)) {
        deliver(dependencies, callback)
      } else {
        pending.push({ dependencies, callback })
      }
      return () => {}
    },
    /** Publish a service the way the composition does when its row activates. */
    provide(serviceName, service) {
      services[serviceName] = service
      for (const entry of [...pending]) {
        if (!entry.dependencies.every((dependency) => services[dependency] !== undefined)) continue
        pending.splice(pending.indexOf(entry), 1)
        deliver(entry.dependencies, entry.callback)
      }
    },
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    logger: { info() {} },
  }
  return context
}

/**
 * The Host's settings service stand-in.
 *
 * It has no `register`: a row no longer owns a namespace. The only thing a row
 * may still say is that it opts out of the page the settings system generates
 * from its own schema.
 */
function createFakeSettings() {
  const configureCalls = []
  return {
    configureCalls,
    configure(options, fiber) {
      configureCalls.push({ options, fiber })
      return () => {}
    },
  }
}

/**
 * Run the plugin body over one row's resolved config.
 *
 * The Loader hands `apply` a resolved config in which every `.volatile()` field
 * is a stable reference and every ordinary one is plain data, so that is what
 * this builds. `refs` exposes those references, so a test can rewrite one in
 * place the way a saved form value does, and the probe log file records every
 * decision the plugin makes.
 */
function mountHost(
  t,
  { config = {}, settings, session = fakeSession('session-cccc1111-2222'), services = {} } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-windows-notifier-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const probeLog = join(dir, 'notifier.log')
  /** Read a probe file, returning `''` while it does not exist yet. */
  const readLog = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }

  const refs = new Map()
  const raw = {}
  for (const key of LIVE_OPTIONS) refs.set(key, liveRef(DEFAULT_CONFIG[key]))
  refs.get('logFile').set(probeLog)
  for (const key of ORDINARY_OPTIONS) raw[key] = DEFAULT_CONFIG[key]
  // A missing toast script keeps the transport a logged no-op.
  raw.scriptPath = join(dir, 'missing-toast.ps1')
  for (const [key, value] of Object.entries(config)) {
    if (refs.has(key)) refs.get(key).set(value)
    else raw[key] = value
  }
  for (const [key, ref] of refs) raw[key] = ref

  const ctx = createContext({
    sessions: { get: (id) => (session.header.id === id ? session : undefined) },
    sessionTitle: { get: () => ({ title: '重构支付模块' }) },
    ...(settings === undefined ? {} : { settings }),
    ...services,
  })
  apply(ctx, raw)
  return {
    ctx,
    refs,
    settings,
    logFile: probeLog,
    log: () => readLog(probeLog),
    readLog,
  }
}

const running = (id) => ['agent/status', { agent: { id }, status: 'running' }]
const idle = (id) => ['agent/status', { agent: { id }, status: 'idle' }]

/** Invoke every listener registered for one event. */
function fire(ctx, event, ...args) {
  return (ctx.listeners.get(event) ?? []).map(({ handler }) => handler(...args))
}

/** How many notifications of one decision the probe log holds. */
function countOf(log, pattern) {
  return (log.match(pattern) ?? []).length
}

test('the row opts out of the generated page once, through the injected child', windowsAndSchema, (t) => {
  const settings = createFakeSettings()
  const probe = mountHost(t, { settings })

  assert.equal(settings.configureCalls.length, 1, 'one policy per registration, never two')
  assert.deepEqual(settings.configureCalls[0].options, { auto: false })
  assert.equal(settings.configureCalls[0].fiber, probe.ctx.fiber, 'the policy is owned by the row fiber')
  // The policy rides on the injected child, so the row's own effect scope holds
  // only the toast transport.
  assert.equal(probe.ctx.disposers.length, 1)
  assert.equal(typeof probe.ctx.disposers[0], 'function')
  assert.deepEqual(
    probe.ctx.injectRequests,
    [['settings'], ['sessions'], ['sessionTitle'], ['agents']],
    'the settings service is injected, not sampled once (and before the platform guard)',
  )
})

test('a settings service that arrives after apply still opts the row out', windowsAndSchema, (t) => {
  const probe = mountHost(t)
  const settings = createFakeSettings()
  assert.equal(settings.configureCalls.length, 0)

  // Now the composition mounts the provider, exactly as it does in a profile
  // where the settings row activates after this one.
  probe.ctx.provide('settings', settings)
  assert.equal(settings.configureCalls.length, 1)
  assert.deepEqual(settings.configureCalls[0].options, { auto: false })
  assert.equal(settings.configureCalls[0].fiber, probe.ctx.fiber)
})

test('a value the Harness rewrites in place is obeyed without a re-apply', windowsOnly, (t) => {
  const session = fakeSession('session-dddd1111-2222')
  const probe = mountHost(t, { config: { notifyOnComplete: true }, session })
  const attached = () => (probe.ctx.listeners.get('internal/dispatch') ?? []).length

  assert.equal(attached(), 1)
  fire(probe.ctx, ...running(session.header.id))
  fire(probe.ctx, ...idle(session.header.id))
  assert.match(probe.log(), /notify complete: ✅ 对话已完成 \/ 重构支付模块/)
  assert.equal(countOf(probe.log(), /notify complete/g), 1)

  // A form save rewrites the very reference `apply` was handed; nothing
  // re-applies the plugin or re-registers its listeners.
  probe.refs.get('notifyOnComplete').set(false)
  assert.equal(attached(), 1, 'the listeners were never torn down')
  fire(probe.ctx, ...running(session.header.id))
  fire(probe.ctx, ...idle(session.header.id))
  assert.match(probe.log(), /skip complete: switch off/)
  assert.equal(countOf(probe.log(), /notify complete/g), 1)

  probe.refs.get('notifyOnComplete').set(true)
  fire(probe.ctx, ...running(session.header.id))
  fire(probe.ctx, ...idle(session.header.id))
  assert.equal(countOf(probe.log(), /notify complete/g), 2, 'and the switch turns back on live')
})

test('enabled gates every report while the listeners stay attached', windowsOnly, (t) => {
  const session = fakeSession('session-eeee1111-2222')
  const probe = mountHost(t, { config: { enabled: false }, session })

  // Unlike the namespace-era plugin, a disabled row is attached and silent
  // rather than detached: `enabled` is read before each report instead.
  assert.equal((probe.ctx.listeners.get('internal/dispatch') ?? []).length, 1)
  assert.match(probe.log(), /disabled by config/)
  fire(probe.ctx, ...running(session.header.id))
  fire(probe.ctx, ...idle(session.header.id))
  assert.equal(countOf(probe.log(), /notify complete/g), 0)

  probe.refs.get('enabled').set(true)
  fire(probe.ctx, ...running(session.header.id))
  fire(probe.ctx, ...idle(session.header.id))
  assert.equal(countOf(probe.log(), /notify complete/g), 1)

  probe.refs.get('enabled').set(false)
  fire(probe.ctx, ...running(session.header.id))
  fire(probe.ctx, ...idle(session.header.id))
  assert.equal(countOf(probe.log(), /notify complete/g), 1, 'a disabled row stays silent')
  assert.equal((probe.ctx.listeners.get('internal/dispatch') ?? []).length, 1)
})

test('the live transport knobs reach the next notification', windowsOnly, (t) => {
  const probe = mountHost(t, {
    config: { openOnClick: true, launchUrl: '' },
    services: { webServer: { port: 3080 } },
  })

  // The session is unattached, which still reports a completion.
  fire(probe.ctx, ...idle('session-headless-0001'))
  assert.match(probe.log(), /-> http:\/\/127\.0\.0\.1:3080/)
  assert.equal(countOf(probe.log(), /->/g), 1)

  probe.refs.get('openOnClick').set(false)
  fire(probe.ctx, ...idle('session-headless-0002'))
  assert.equal(countOf(probe.log(), /->/g), 1, 'an inert toast carries no URL')

  probe.refs.get('openOnClick').set(true)
  probe.refs.get('launchUrl').set('http://example.test/#{sessionId}')
  fire(probe.ctx, ...idle('session-headless-0003'))
  assert.match(probe.log(), /-> http:\/\/example\.test\/#session-headless-0003/)
  assert.equal(countOf(probe.log(), /->/g), 2)
})

test('a log file chosen in the form takes over without a re-apply', windowsOnly, (t) => {
  const probe = mountHost(t)
  fire(probe.ctx, ...idle('session-headless-0004'))
  const first = probe.log()
  assert.match(first, /notify complete/)

  const moved = join(dirname(probe.logFile), 'moved.log')
  probe.refs.get('logFile').set(moved)
  assert.equal(probe.readLog(moved), '', 'nothing is written until the next decision')

  fire(probe.ctx, ...idle('session-headless-0005'))
  assert.match(probe.readLog(moved), /notify complete/)
  assert.equal(probe.log(), first, 'the old file is left alone')
})

test('a profile without a settings service keeps notifying', windowsOnly, (t) => {
  const probe = mountHost(t)
  assert.ok(
    probe.ctx.injectRequests.some((request) => request.length === 1 && request[0] === 'settings'),
    'the row waits instead of failing',
  )
  fire(probe.ctx, ...idle('session-headless-0006'))
  assert.match(probe.log(), /notify complete/)
  assert.match(probe.log(), /active \(appId=/)
})