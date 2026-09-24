import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'

/** The plugin short-circuits off Windows, so the wiring tests are Windows-only. */
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows-only plugin' : false }

/** A log file the plugin appends its decisions to, used as this test's probe. */
function createLogFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-windows-notifier-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'notifier.log')
}

/** Read the probe log, returning `''` while it does not exist yet. */
function readLog(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** A live-session stand-in exposing only what the plugin actually reads. */
function fakeSession({ id, origin, events }) {
  return {
    seq: events.length,
    header: { id, origin, cwd: 'D:\\work\\demo' },
    eventAt: (seq) => events[seq],
  }
}

/**
 * One agent-scoped event payload, as the framework dispatches it: the payload
 * carries the live agent, and the live agent carries its session.
 *
 * @param session - the live session, or `undefined` for an agent whose session
 *   is only reachable through the session store.
 */
function agentPayload(session, extra) {
  return { agent: { id: session?.header.id, session }, ...extra }
}

/** A Cordis-context stand-in recording listeners, effects, and services. */
function createFakeContext(services) {
  const listeners = new Map()
  const effects = []
  return {
    listeners,
    effects,
    on(event, handler, options) {
      const bucket = listeners.get(event) ?? []
      bucket.push({ handler, options })
      listeners.set(event, bucket)
      return () => {}
    },
    get(serviceName) {
      return services[serviceName]
    },
    /**
     * Cordis opens the callback once every named service exists. Nothing in
     * this file provides one, so the settings branch simply never opens — the
     * event wiring under test must not depend on it.
     */
    inject(dependencies, callback) {
      if (!dependencies.every((dependency) => services[dependency] !== undefined)) return () => {}
      const injected = { ...this }
      for (const dependency of dependencies) injected[dependency] = services[dependency]
      callback(injected)
      return () => {}
    },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    logger: { info() {} },
  }
}

/** Invoke every listener registered for one event and collect their results. */
function fire(ctx, event, ...args) {
  return (ctx.listeners.get(event) ?? []).map(({ handler }) => handler(...args))
}

/**
 * Emulate the framework for one occurrence: announce the dispatch (which is
 * what the plugin actually relies on), then run the direct listeners.
 *
 * @param ctx - the fake context.
 * @param mode - the Cordis dispatch mode.
 * @param event - the event name.
 * @param args - the arguments the event is dispatched with.
 * @param direct - whether the direct listeners also see it; `false` stands in
 *   for a runtime whose scope filter drops them.
 */
function emit(ctx, mode, event, args, direct = true) {
  fire(ctx, 'internal/dispatch', mode, event, args, null)
  if (direct) fire(ctx, event, ...args)
}

/** Compose the plugin over one fake session and return the probe surface. */
function mount(t, { session, title = '重构支付模块' }, config = {}, extraServices = {}) {
  const logFile = createLogFile(t)
  const ctx = createFakeContext({
    sessions: { get: (id) => (session !== undefined && session.header.id === id ? session : undefined) },
    sessionTitle: { get: () => ({ title }) },
    ...extraServices,
  })
  // A missing toast script makes the transport a logged no-op, so no
  // powershell.exe is started while the notification decisions stay observable.
  apply(ctx, { logFile, scriptPath: join(tmpdir(), 'dsh-windows-notifier-missing-toast.ps1'), ...config })
  return { ctx, log: () => readLog(logFile) }
}

const running = (id) => ['agent/status', { agent: { id }, status: 'running' }]
const idle = (id) => ['agent/status', { agent: { id }, status: 'idle' }]

test('a finished turn notifies once, with the title and the elapsed time', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-aaaa1111-2222',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { ctx, log } = mount(t, { session })

  fire(ctx, ...running(session.header.id))
  fire(ctx, ...idle(session.header.id))

  const output = log()
  assert.match(output, /notify complete: ✅ 对话已完成 \/ 重构支付模块 \| 已运行 0 秒，可以继续对话了。/)
})

test('a session that never settled a turn is left alone', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-bbbb1111-2222',
    events: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const { ctx, log } = mount(t, { session })

  fire(ctx, ...idle(session.header.id))

  assert.doesNotMatch(log(), /notify complete/)
})

test('an unattached session still reports completion', windowsOnly, (t) => {
  // A headless run detaches its session during shutdown, so the idle event can
  // arrive with nothing left to read the turn outcome from.
  const { ctx, log } = mount(t, {})

  fire(ctx, ...idle('session-headless-0001'))

  assert.match(log(), /not attached/)
  assert.match(log(), /notify complete: ✅ 对话已完成 \/ 会话 headless \| 可以继续对话了。/)
})

test('an errored turn does not also report completion', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-cccc1111-2222',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
    ],
  })
  const { ctx, log } = mount(t, { session })

  fire(ctx, ...idle(session.header.id))

  assert.doesNotMatch(log(), /notify complete/)
})

/** A child session that settled one turn, and the events that say so. */
function childSession(id) {
  return fakeSession({
    id,
    origin: 'subagent',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
}

test('subagent sessions stay silent by default and speak when asked', windowsOnly, (t) => {
  const session = childSession('session-dddd1111-2222')

  const silent = mount(t, { session })
  fire(silent.ctx, ...idle(session.header.id))
  assert.match(silent.log(), /skip complete for session-dddd1111-2222: subagent turn end/)
  assert.doesNotMatch(silent.log(), /notify complete/)

  const loud = mount(t, { session }, { includeSubagents: true })
  fire(loud.ctx, ...idle(session.header.id))
  assert.match(loud.log(), /notify complete/)
})

test('a child is recognised from the session its own payload carries', windowsOnly, (t) => {
  // The reported failure: in a real host the session store lookup can come back
  // empty for every id, so a filter that depends on it silently never fires and
  // each child's turn end raises a "对话已完成" toast. The payload's agent
  // carries its session, so classification must not need the store at all.
  const child = childSession('cccc1111-child-0001')
  const { ctx, log } = mount(t, {})

  fire(ctx, 'agent/status', agentPayload(child, { status: 'idle' }))

  assert.match(log(), /skip complete for cccc1111-child-0001: subagent turn end/)
  assert.doesNotMatch(log(), /notify complete/)
})

test('a child recognised at creation stays silent when its session cannot be read', windowsOnly, (t) => {
  const child = childSession('cccc1111-child-0002')
  const { ctx, log } = mount(t, {})

  fire(ctx, 'session/created', child)
  // The idle payload carries only an id — no session anywhere.
  fire(ctx, ...idle(child.header.id))

  assert.match(log(), /skip complete for cccc1111-child-0002: subagent turn end/)
  assert.doesNotMatch(log(), /notify complete/)
})

test('a child that needs the user still notifies', windowsOnly, (t) => {
  const child = fakeSession({ id: 'cccc1111-child-0003', origin: 'subagent', events: [] })
  const { ctx, log } = mount(t, {})

  const question = fire(
    ctx,
    'user-questions/request',
    agentPayload(child, { questions: [{ question: '要用哪种模板？' }] }),
    () => 'downstream',
  )
  assert.deepEqual(question, ['downstream'])
  assert.match(log(), /notify question: ❓ 需要你的输入 \/ 重构支付模块 \| 要用哪种模板？/)

  fire(ctx, 'approval/request', agentPayload(child, { toolName: 'pwsh', reason: '需要确认' }), () => 'downstream')
  assert.match(log(), /notify approval: 🔐 需要你批准 \/ 重构支付模块 \| 工具 pwsh：需要确认/)

  fire(ctx, 'agent/error', agentPayload(child, { error: new Error('子代理挂了') }))
  assert.match(log(), /notify error: ❌ 对话出错 \/ 重构支付模块 \| 子代理挂了/)
})

test('an interrupted turn follows its own switch', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-eeee1111-2222',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ],
  })
  const off = mount(t, { session })
  fire(off.ctx, ...idle(session.header.id))
  assert.doesNotMatch(off.log(), /notify interrupted/)

  const on = mount(t, { session }, { notifyOnInterrupted: true })
  fire(on.ctx, ...idle(session.header.id))
  assert.match(on.log(), /notify interrupted/)
})

test('question and approval waterfalls notify and then delegate downstream', windowsOnly, (t) => {
  const session = fakeSession({ id: 'session-ffff1111-2222', events: [] })
  const { ctx, log } = mount(t, { session })

  const question = fire(
    ctx,
    'user-questions/request',
    { agent: { id: session.header.id }, questions: [{ question: '要用哪种模板？' }] },
    () => 'question-downstream',
  )
  assert.deepEqual(question, ['question-downstream'])
  assert.match(log(), /notify question: ❓ 需要你的输入 \/ 重构支付模块 \| 要用哪种模板？/)

  const approval = fire(
    ctx,
    'approval/request',
    { agent: { id: session.header.id }, toolName: 'pwsh', reason: '需要写入工作区之外' },
    () => 'approval-downstream',
  )
  assert.deepEqual(approval, ['approval-downstream'])
  assert.match(log(), /notify approval: 🔐 需要你批准 \/ 重构支付模块 \| 工具 pwsh：需要写入工作区之外/)
})

test('an agent error notifies with its message', windowsOnly, (t) => {
  const session = fakeSession({ id: 'session-99991111-2222', events: [] })
  const { ctx, log } = mount(t, { session })

  fire(ctx, 'agent/error', { agent: { id: session.header.id }, error: new Error('provider timeout') })

  assert.match(log(), /notify error: ❌ 对话出错 \/ 重构支付模块 \| provider timeout/)
})

test('every notification switch can silence its own kind', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-88881111-2222',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { ctx, log } = mount(t, { session }, { notifyOnComplete: false })

  fire(ctx, ...idle(session.header.id))

  assert.doesNotMatch(log(), /notify complete/)
})

test('the transport is owned by the context and released on dispose', windowsOnly, (t) => {
  const session = fakeSession({ id: 'session-77771111-2222', events: [] })
  const { ctx } = mount(t, { session })

  assert.equal(ctx.effects.length, 1)
  const disposer = ctx.effects[0]()
  assert.equal(typeof disposer, 'function')
  assert.doesNotThrow(disposer)
})

test('every listener is global, so scope routing can never drop it', windowsOnly, (t) => {
  const session = fakeSession({ id: 'session-66661111-2222', events: [] })
  const { ctx } = mount(t, { session })

  const observed = [
    'internal/dispatch',
    'agent/status',
    'agent/error',
    'user-questions/request',
    'approval/request',
    'agent/disposed',
    'session/created',
  ]
  assert.deepEqual([...ctx.listeners.keys()].sort(), [...observed].sort())
  for (const event of observed) {
    const bucket = ctx.listeners.get(event)
    assert.equal(bucket.length, 1, `${event} has one listener`)
    assert.equal(bucket[0].options?.global, true, `${event} is registered as a global listener`)
  }
})

test('an event the scope carrier hides from direct listeners still notifies', windowsOnly, (t) => {
  const session = fakeSession({ id: 'session-11112222-3333', events: [] })
  const { ctx, log } = mount(t, { session })

  // `direct: false` stands in for the real runtime, where this listener never
  // runs because the dispatch carries a scope carrier that excludes it — the
  // dispatch announcement is then the only observable signal.
  emit(ctx, 'waterfall', 'user-questions/request', [
    { agent: { id: session.header.id }, questions: [{ question: '部署到哪个环境？' }] },
    () => 'downstream',
  ], false)

  assert.match(log(), /notify question: ❓ 需要你的输入 \/ 重构支付模块 \| 部署到哪个环境？/)
})

test('an occurrence seen on both channels is reported exactly once', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-22223333-4444',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const { ctx, log } = mount(t, { session })

  // Both channels deliver the identical payload object, which is what makes
  // de-duplication exact instead of a timing guess.
  emit(ctx, 'emit', 'agent/status', [{ agent: { id: session.header.id }, status: 'idle' }])

  assert.equal((log().match(/notify complete/g) ?? []).length, 1)
})

test('a waterfall still reaches downstream listeners after being reported', windowsOnly, (t) => {
  const session = fakeSession({ id: 'session-33334444-5555', events: [] })
  const { ctx } = mount(t, { session })
  const request = { agent: { id: session.header.id }, questions: [{ question: '继续吗？' }] }

  fire(ctx, 'internal/dispatch', 'waterfall', 'user-questions/request', [request, () => {}], null)
  const results = fire(ctx, 'user-questions/request', request, () => 'downstream')

  assert.deepEqual(results, ['downstream'])
})

test('a toast links to the running Web GUI unless a URL is configured', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-55551111-2222',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })

  const derived = mount(t, { session }, {}, { webServer: { port: 3080 } })
  fire(derived.ctx, ...idle(session.header.id))
  assert.match(derived.log(), /-> http:\/\/127\.0\.0\.1:3080/)

  const configured = mount(t, { session }, { launchUrl: 'http://example.test/#{sessionId}' })
  fire(configured.ctx, ...idle(session.header.id))
  assert.match(configured.log(), /-> http:\/\/example\.test\/#session-55551111-2222/)

  const inert = mount(t, { session })
  fire(inert.ctx, ...idle(session.header.id))
  assert.doesNotMatch(inert.log(), /->/)
})

test('openOnClick false makes the toast inert even with a URL configured', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-44445555-6666',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })

  const closed = mount(t, { session }, { openOnClick: false, launchUrl: 'http://example.test/{sessionId}' })
  fire(closed.ctx, ...idle(session.header.id))
  assert.match(closed.log(), /notify complete/)
  assert.doesNotMatch(closed.log(), /->/)

  const opened = mount(t, { session }, { openOnClick: true, launchUrl: 'http://example.test/{sessionId}' })
  fire(opened.ctx, ...idle(session.header.id))
  assert.match(opened.log(), /-> http:\/\/example\.test\/session-44445555-6666/)
})