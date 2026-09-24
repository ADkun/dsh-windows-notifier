import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  KIND_APPROVAL,
  KIND_COMPLETE,
  KIND_ERROR,
  KIND_INTERRUPTED,
  KIND_QUESTION,
  buildNotification,
  formatDuration,
  isSubagentHeader,
  isTurnEndKind,
  sessionLabel,
  truncate,
} from '../src/messages.js'

test('truncate collapses whitespace and cuts long text', () => {
  assert.equal(truncate('  hello   world \n'), 'hello world')
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate(undefined), '')
})

test('sessionLabel shortens a session identity', () => {
  assert.equal(sessionLabel('session-d80c005a-456d-40bb-97d0-bee7ebe10d0c'), 'd80c005a')
  assert.equal(sessionLabel('abcdefghijkl'), 'abcdefgh')
  assert.equal(sessionLabel(undefined), '')
})

test('isSubagentHeader recognises a delegated child and never guesses', () => {
  assert.equal(isSubagentHeader({}), false)
  assert.equal(isSubagentHeader(undefined), false)
  assert.equal(isSubagentHeader(null), false)
  assert.equal(isSubagentHeader('session-x'), false)
  assert.equal(isSubagentHeader({ origin: 'subagent' }), true)
  assert.equal(isSubagentHeader({ delegationDepth: 1 }), true)
  assert.equal(isSubagentHeader({ delegationDepth: 0 }), false)
  assert.equal(isSubagentHeader({ parentSession: 'session-parent' }), true)
  assert.equal(isSubagentHeader({ parentSession: null }), false)
})

test('isTurnEndKind covers exactly the turn-end reports', () => {
  assert.equal(isTurnEndKind(KIND_COMPLETE), true)
  assert.equal(isTurnEndKind(KIND_INTERRUPTED), true)
  assert.equal(isTurnEndKind(KIND_QUESTION), false)
  assert.equal(isTurnEndKind(KIND_APPROVAL), false)
  assert.equal(isTurnEndKind(KIND_ERROR), false)
})

test('formatDuration reads like a notification', () => {
  assert.equal(formatDuration(undefined), '')
  assert.equal(formatDuration(-1), '')
  assert.equal(formatDuration(41_000), '41 秒')
  assert.equal(formatDuration(120_000), '2 分钟')
  assert.equal(formatDuration(133_000), '2 分 13 秒')
  assert.equal(formatDuration(7_200_000), '2 小时 0 分')
})

test('a completion toast names the conversation and the elapsed time', () => {
  const message = buildNotification(KIND_COMPLETE, {
    sessionId: 'session-abcdefgh-0000',
    sessionTitle: '重构支付模块',
    durationMs: 133_000,
  })
  assert.equal(message.title, '✅ 对话已完成')
  assert.deepEqual(message.lines, ['重构支付模块', '已运行 2 分 13 秒，可以继续对话了。'])
})

test('a completion toast falls back to the session id without a title', () => {
  const message = buildNotification(KIND_COMPLETE, { sessionId: 'session-abcdefgh-0000' })
  assert.deepEqual(message.lines, ['会话 abcdefgh', '可以继续对话了。'])
})

test('question, approval, and error toasts carry their detail', () => {
  const question = buildNotification(KIND_QUESTION, { sessionTitle: '写周报', detail: '要用哪种模板？' })
  assert.equal(question.title, '❓ 需要你的输入')
  assert.deepEqual(question.lines, ['写周报', '要用哪种模板？'])

  const approval = buildNotification(KIND_APPROVAL, { sessionTitle: '部署', detail: '工具 pwsh 等待你确认。' })
  assert.equal(approval.title, '🔐 需要你批准')
  assert.deepEqual(approval.lines, ['部署', '工具 pwsh 等待你确认。'])

  const failure = buildNotification(KIND_ERROR, { sessionTitle: '部署', detail: 'provider timeout' })
  assert.equal(failure.title, '❌ 对话出错')
  assert.deepEqual(failure.lines, ['部署', 'provider timeout'])
})

test('toasts without a detail still read as a sentence', () => {
  assert.deepEqual(buildNotification(KIND_QUESTION, {}).lines, ['未命名对话', '智能体正在等你回答。'])
  assert.deepEqual(buildNotification(KIND_APPROVAL, { sessionTitle: '部署' }).lines, ['部署', '有一个操作需要你确认。'])
  assert.deepEqual(buildNotification(KIND_ERROR, { sessionTitle: '部署' }).lines, ['部署', '本轮以错误结束。'])
  assert.deepEqual(buildNotification(KIND_INTERRUPTED, { sessionTitle: '部署' }).lines, ['部署', '本轮已被中止。'])
})