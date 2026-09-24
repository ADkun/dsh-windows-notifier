import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.js'

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

/** A Cordis-context stand-in recording listeners, effects, and services. */
function createFakeContext(services) {
  const listeners = new Map()
  const effects = []
  return {
    listeners,
    effects,
    on(event, handler) {
      const bucket = listeners.get(event) ?? []
      bucket.push(handler)
      listeners.set(event, bucket)
      return () => {}
    },
    get(serviceName) {
      return services[serviceName]
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
  return (ctx.listeners.get(event) ?? []).map((handler) => handler(...args))
}

/** Compose the plugin over one fake session and return the probe surface. */
function mount(t, { session, title = '重构支付模块' }, config = {}) {
  const logFile = createLogFile(t)
  const ctx = createFakeContext({
    sessions: { get: (id) => (session !== undefined && session.header.id === id ? session : undefined) },
    sessionTitle: { get: () => ({ title }) },
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

test('subagent sessions stay silent by default and speak when asked', windowsOnly, (t) => {
  const session = fakeSession({
    id: 'session-dddd1111-2222',
    origin: 'subagent',
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })
  const silent = mount(t, { session })
  fire(silent.ctx, ...idle(session.header.id))
  assert.doesNotMatch(silent.log(), /notify complete/)

  const loud = mount(t, { session }, { includeSubagents: true })
  fire(loud.ctx, ...idle(session.header.id))
  assert.match(loud.log(), /notify complete/)
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