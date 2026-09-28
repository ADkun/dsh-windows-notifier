/**
 * Delegated-child lineage: who is still running below a given conversation.
 *
 * A background subagent is a *separate session* that hands its result back to
 * its parent agent, not to the user. The parent dispatches it and immediately
 * ends its own turn, so the parent's first `idle` says "my turn settled", not
 * "the work is over" — and a notifier that reads it as the latter raises a
 * "对话已完成" toast while the delegated work is still in flight.
 *
 * The fix is a lineage question: *does this session still have a running
 * subagent descendant?* Two sources can answer it, and this module is the pure
 * half that both feed into:
 *
 * 1. The live Agent registry (`ctx.agents`, `@deepseek-ai/dsh-agent`). DSH
 *    answers the same question for its own archive admission with exactly this
 *    walk (`runningDescendants` in `@deepseek-ai/dsh-subagent`), so the
 *    semantics are copied from there rather than invented here.
 * 2. The `agent/status` events this plugin already observes, remembered as
 *    records — the fallback for a runtime where the registry is not reachable.
 *
 * A *delegated child* is the strict shape DSH guarantees: a header carrying
 * `origin: 'subagent'` **and** a parent. That is deliberately narrower than
 * {@link import('./messages.js').isSubagentHeader}: a `subagent_fork` shares
 * the lineage field without that origin and is an independent conversation, so
 * it never holds its source back. Being strict here also keeps the gate
 * conservative — an unrecognised session never suppresses a notification.
 *
 * @module dsh-windows-notifier/lineage
 */

/**
 * One delegated child, reduced to the three facts the walk needs.
 *
 * @typedef {object} SubagentRecord
 * @property {string} id - the child's own session identity.
 * @property {string} parentSessionId - the session that dispatched it.
 * @property {boolean} running - whether it is executing right now.
 */

/**
 * Whether a session header marks the strict delegated child the gate follows.
 *
 * @param {{ origin?: unknown, parentSession?: unknown } | undefined | null} header
 *   the durable session header, when one could be read.
 * @returns {boolean} whether this header is a dispatched subagent.
 */
export function isDelegatedChild(header) {
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin !== 'subagent') return false
  return header.parentSession !== undefined && header.parentSession !== null
}

/**
 * Reduce one session header into a walkable record.
 *
 * @param {{ origin?: unknown, parentSession?: unknown } | undefined | null} header
 *   the durable session header, when one could be read.
 * @param {unknown} id - the child's session identity.
 * @param {boolean} running - whether the child is executing right now.
 * @returns {SubagentRecord | undefined} the record, or `undefined` when this
 *   header is not a delegated child (or carries no usable identity).
 */
export function toSubagentRecord(header, id, running) {
  if (id === undefined || id === null) return undefined
  if (!isDelegatedChild(header)) return undefined
  return { id: String(id), parentSessionId: String(header.parentSession), running: running === true }
}

/**
 * List the delegated children below one conversation that are running now.
 *
 * The walk is breadth-first through `parentSessionId` at any depth, so a child
 * of a child still counts against its grandparent. Cycles are visited once, so
 * a damaged header chain terminates instead of spinning.
 *
 * @param {Iterable<SubagentRecord>} records - every known delegated child.
 * @param {unknown} rootId - the conversation to ask about.
 * @returns {string[]} the distinct child ids still running below `rootId`, in
 *   discovery order; empty when the conversation holds no running child.
 */
export function runningDescendants(records, rootId) {
  if (rootId === undefined || rootId === null) return []
  const root = String(rootId)

  /** @type {Map<string, Map<string, boolean>>} parent id → child id → running */
  const childrenOf = new Map()
  for (const record of records ?? []) {
    if (record === undefined || record === null) continue
    if (record.id === undefined || record.id === null) continue
    if (record.parentSessionId === undefined || record.parentSessionId === null) continue
    const id = String(record.id)
    const parentSessionId = String(record.parentSessionId)
    const siblings = childrenOf.get(parentSessionId) ?? new Map()
    // Two sources can report the same child — the live registry and the
    // observed history — and either one seeing it run must hold the report
    // back, so the liveness of one identity is an OR of its records.
    siblings.set(id, siblings.get(id) === true || record.running === true)
    childrenOf.set(parentSessionId, siblings)
  }

  const running = []
  const seen = new Set([root])
  const pending = [root]
  while (pending.length > 0) {
    const parentId = pending.shift()
    for (const [childId, isRunning] of childrenOf.get(parentId) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      if (isRunning) running.push(childId)
      pending.push(childId)
    }
  }
  return running
}