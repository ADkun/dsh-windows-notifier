import { strict as assert } from 'node:assert'
import test from 'node:test'

import { isDelegatedChild, runningDescendants, toSubagentRecord } from '../src/lineage.js'

/** A delegated child's durable header, as DSH stamps it. */
const childHeader = (id, parentSession) => ({ id, parentSession, origin: 'subagent', delegationDepth: 1 })

test('only a dispatched subagent counts as a delegated child', () => {
  assert.equal(isDelegatedChild(childHeader('child-1', 'root')), true)
  // A fork shares the lineage field without the origin, and is independent.
  assert.equal(isDelegatedChild({ id: 'fork-1', parentSession: 'root' }), false)
  // A plain top-level conversation carries neither field.
  assert.equal(isDelegatedChild({ id: 'root' }), false)
  assert.equal(isDelegatedChild(undefined), false)
  assert.equal(isDelegatedChild(null), false)
  assert.equal(isDelegatedChild('child-1'), false)
  // The origin alone is not lineage: without a parent there is nothing to hold.
  assert.equal(isDelegatedChild({ id: 'child-1', origin: 'subagent' }), false)
})

test('a record keeps only the identity, the parent, and the liveness', () => {
  assert.deepEqual(
    toSubagentRecord(childHeader('child-1', 'root'), 'child-1', true),
    { id: 'child-1', parentSessionId: 'root', running: true },
  )
  assert.equal(toSubagentRecord(childHeader('child-1', 'root'), 'child-1', 'running').running, false)
  assert.equal(toSubagentRecord({ id: 'fork-1', parentSession: 'root' }, 'fork-1', true), undefined)
  assert.equal(toSubagentRecord(childHeader('child-1', 'root'), undefined, true), undefined)
})

test('a running child holds its dispatcher back', () => {
  const records = [
    { id: 'child-1', parentSessionId: 'root', running: true },
    { id: 'child-2', parentSessionId: 'root', running: false },
  ]
  assert.deepEqual(runningDescendants(records, 'root'), ['child-1'])
})

test('a settled or idle child does not', () => {
  assert.deepEqual(
    runningDescendants([{ id: 'child-1', parentSessionId: 'root', running: false }], 'root'),
    [],
  )
  assert.deepEqual(runningDescendants([], 'root'), [])
})

test('the walk reaches grandchildren, whatever the depth', () => {
  const records = [
    { id: 'child-1', parentSessionId: 'root', running: false },
    { id: 'grandchild-1', parentSessionId: 'child-1', running: true },
    { id: 'great-grandchild-1', parentSessionId: 'grandchild-1', running: true },
  ]
  assert.deepEqual(runningDescendants(records, 'root'), ['grandchild-1', 'great-grandchild-1'])
})

test('a child of another conversation never holds this one back', () => {
  const records = [
    { id: 'child-1', parentSessionId: 'root', running: false },
    { id: 'other-child', parentSessionId: 'someone-else', running: true },
  ]
  assert.deepEqual(runningDescendants(records, 'root'), [])
})

test('a damaged lineage chain that loops terminates', () => {
  const records = [
    { id: 'child-1', parentSessionId: 'child-2', running: true },
    { id: 'child-2', parentSessionId: 'child-1', running: true },
  ]
  assert.deepEqual(runningDescendants(records, 'child-1'), ['child-2'])
})

test('one child reported twice is counted once', () => {
  // The registry and the observed history can both answer for the same child.
  const records = [
    { id: 'child-1', parentSessionId: 'root', running: false },
    { id: 'child-1', parentSessionId: 'root', running: true },
  ]
  assert.deepEqual(runningDescendants(records, 'root'), ['child-1'])
})

test('a missing root or a malformed record is not a crash', () => {
  assert.deepEqual(runningDescendants([{ id: 'child-1', parentSessionId: 'root', running: true }], undefined), [])
  assert.deepEqual(runningDescendants(undefined, 'root'), [])
  assert.deepEqual(
    runningDescendants([null, { id: undefined, parentSessionId: 'root', running: true }], 'root'),
    [],
  )
})