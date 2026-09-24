/**
 * The browser half's contract, exercised without a browser.
 *
 * `src/client.js` is a script, not a module: it registers one factory with the
 * shell's lazy-CJS loader and does nothing else until that factory is
 * materialized. So the whole browser half is reachable from Node by supplying
 * the two globals it touches (`window`, `document`) and the module requests it
 * makes — which is exactly what a card that must not be able to break the shell
 * deserves: the shape it registers, the namespace it keyed on, and the staging
 * logic behind every control.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

/** Namespace the Host half serves; the card's slot key must match it. */
const NAMESPACE = 'dsh-windows-notifier'

/** A minimal React: this card only ever calls `createElement`. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
}

/** A minimal snapshot store with the same contract the shell's does. */
function createStoreStub(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

let imports = 0

/**
 * Load the bundle and hand back the single factory it registered.
 *
 * @returns {Promise<{ entry: object, styles: object[] }>} the loader entry and
 * every `<style>` the bundle injected.
 */
async function loadBundle() {
  const entries = []
  const styles = []
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load: (entry) => entries.push(entry) } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styles.push(tag) },
  }
  try {
    imports += 1
    // A distinct specifier per call: each test gets its own module instance.
    await import(`../src/client.js?case=${imports}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
  assert.equal(entries.length, 1, 'the bundle registers exactly one factory')
  return { entry: entries[0], styles }
}

/** Materialize one factory, refusing any module the shell does not seed. */
function materialize(entry) {
  return entry.factory((specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: createStoreStub }
    throw new Error(`unexpected client module request: ${specifier}`)
  })
}

/**
 * A bound settings scope stand-in: one snapshot plus a mutation log.
 *
 * @param value - the resolved section the Host would report.
 * @param options - `writable` and the raw `user` layer.
 */
function createScope(value, { writable = true, user = {} } = {}) {
  const listeners = new Set()
  const mutations = []
  let snapshot = {
    status: 'ready',
    value: { ...value },
    base: { ...value },
    user: { ...user },
    revision: 1,
    writable,
    mode: 'host',
  }
  return {
    mutations,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(operations) {
      mutations.push(operations)
      const nextUser = { ...snapshot.user }
      const nextValue = { ...snapshot.value }
      for (const operation of operations) {
        const [field] = operation.path
        if (operation.op === 'unset') {
          delete nextUser[field]
          // The Host resolves a cleared field back out of the composition base.
          nextValue[field] = snapshot.base[field]
        } else {
          nextUser[field] = operation.value
          nextValue[field] = operation.value
        }
      }
      snapshot = { ...snapshot, user: nextUser, value: nextValue, revision: snapshot.revision + 1 }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Mount the card over one scope and return its registered inject face. */
function mountCard(scope) {
  const registrations = []
  const bound = []
  const effects = []
  const ctx = {
    settingsScope: {
      bind(spec) {
        bound.push(spec)
        return scope
      },
    },
    effect(callback) {
      effects.push(callback())
      return () => {}
    },
    slots: {
      inject(name, generator) {
        assert.equal(name, 'settings.plugin.item')
        for (const registration of generator()) registrations.push(registration)
      },
      register(options, component) {
        return { options, component }
      },
    },
  }
  return async () => {
    const module = materialize(await loadBundle().then(({ entry }) => entry))
    module.apply(ctx)
    assert.equal(bound.length, 1)
    assert.deepEqual(bound[0], { namespace: NAMESPACE })
    assert.equal(registrations.length, 1)
    const registration = registrations[0]
    assert.equal(registration.options.name, 'settings.plugin.item')
    assert.equal(registration.options.key, NAMESPACE)
    return { registration, face: registration.options.inject(), module, effects }
  }
}

/** The resolved section a card normally starts from. */
const RESOLVED = {
  enabled: true,
  notifyOnComplete: true,
  notifyOnQuestion: true,
  notifyOnApproval: true,
  notifyOnError: true,
  notifyOnInterrupted: false,
  notifyOnActivate: false,
  includeSubagents: false,
  disappearAfterMs: 6000,
  openOnClick: true,
  launchUrl: '',
  minTaskDurationMs: 0,
  sound: 'default',
}

/** Collect every string and every input in a rendered element tree. */
function walk(node, collected = { text: [], inputs: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return collected
  if (Array.isArray(node)) {
    for (const child of node) walk(child, collected)
    return collected
  }
  if (typeof node === 'object') {
    if (node.type === 'input') collected.inputs.push(node.props)
    for (const child of node.children) walk(child, collected)
    return collected
  }
  collected.text.push(String(node))
  return collected
}

test('the bundle registers one factory under the package name', async () => {
  const { entry, styles } = await loadBundle()
  assert.equal(entry.id, 'dsh-windows-notifier')
  assert.equal(typeof entry.factory, 'function')
  // The stylesheet arrives with the factory, not with the script.
  assert.equal(styles.length, 0)
})

test('materializing requires nothing the shell does not seed', async () => {
  const { entry } = await loadBundle()
  const module = materialize(entry)
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...module.inject], ['slots', 'settingsScope'])
})

test('the card is registered on the namespace the Host serves', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { registration, face, effects } = await mount()
  assert.equal(typeof registration.component, 'function')
  assert.ok(face.hooks.notifierCard, 'the card reads its state through one injected hook')
  for (const action of ['edit', 'toggle', 'setSilent', 'resetField', 'discard', 'save']) {
    assert.equal(typeof face[action], 'function', `${action} is injected as a prop`)
  }
  assert.equal(effects.length, 1, 'the card store is disposed with the plugin')
})

test('a rendered card shows every field and its resolved value', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { registration, face } = await mount()
  const state = face.hooks.notifierCard.getSnapshot()
  const tree = registration.component({
    ...face,
    useNotifierCard: (selector) => selector(state),
  })
  const collected = walk(tree)
  assert.ok(collected.text.includes('Windows 通知'))
  assert.ok(collected.text.includes('通知停留时长（毫秒）'))
  assert.ok(collected.text.includes('点击通知时打开 DSH Web 界面'))
  // 9 switches plus the sound checkbox, and the three text/number inputs.
  assert.equal(collected.inputs.filter((props) => props.type === 'checkbox').length, 10)
  assert.equal(collected.inputs.filter((props) => props.type === 'text').length, 3)
  const duration = collected.inputs.find((props) => props.id === `${NAMESPACE}-disappearAfterMs`)
  assert.equal(duration.value, '6000')
  const clickable = collected.inputs.find((props) => props.id === `${NAMESPACE}-openOnClick`)
  assert.equal(clickable.checked, true)
})

test('staging an edit marks the card dirty without writing anything', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { face } = await mount()
  face.toggle('openOnClick', false)
  face.edit('disappearAfterMs', '0')
  const state = face.hooks.notifierCard.getSnapshot()
  assert.equal(state.dirty, true)
  assert.equal(state.fields.openOnClick.checked, false)
  assert.equal(state.fields.openOnClick.draft, true)
  assert.equal(state.fields.disappearAfterMs.text, '0')
  assert.equal(scope.mutations.length, 0)
})

test('saving writes one atomic mutation and clears the drafts', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { face } = await mount()
  face.toggle('openOnClick', false)
  face.edit('disappearAfterMs', '0')
  face.setSilent('sound', true)
  await face.save()
  assert.deepEqual(scope.mutations, [[
    { op: 'set', path: ['openOnClick'], value: false },
    { op: 'set', path: ['disappearAfterMs'], value: 0 },
    { op: 'set', path: ['sound'], value: 'silent' },
  ]])
  const state = face.hooks.notifierCard.getSnapshot()
  assert.equal(state.dirty, false)
  assert.equal(state.error, '')
  assert.equal(state.fields.openOnClick.overridden, true)
  assert.equal(state.fields.disappearAfterMs.text, '0')
})

test('resetting a field clears the user override instead of writing a value', async () => {
  const scope = createScope({ ...RESOLVED, disappearAfterMs: 25000 }, { user: { disappearAfterMs: 25000 } })
  const mount = mountCard(scope)
  const { face } = await mount()
  assert.equal(face.hooks.notifierCard.getSnapshot().fields.disappearAfterMs.overridden, true)
  face.resetField('disappearAfterMs')
  assert.equal(face.hooks.notifierCard.getSnapshot().fields.disappearAfterMs.overridden, true)
  await face.save()
  assert.deepEqual(scope.mutations, [[{ op: 'unset', path: ['disappearAfterMs'] }]])
})

test('discarding drops every draft', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { face } = await mount()
  face.edit('launchUrl', 'http://example.test/')
  face.discard()
  const state = face.hooks.notifierCard.getSnapshot()
  assert.equal(state.dirty, false)
  assert.equal(state.fields.launchUrl.text, '')
})

test('an unparseable number blocks the save instead of dropping the field', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { face } = await mount()
  face.edit('disappearAfterMs', '马上')
  assert.equal(face.hooks.notifierCard.getSnapshot().fields.disappearAfterMs.invalid, true)
  await face.save()
  assert.equal(scope.mutations.length, 0)
  const state = face.hooks.notifierCard.getSnapshot()
  assert.match(state.error, /合法数字/)
  assert.equal(state.dirty, true, 'the draft survives so the user can fix it')
})

test('a deployment that cannot accept writes disables saving', async () => {
  const scope = createScope(RESOLVED, { writable: false })
  const mount = mountCard(scope)
  const { face } = await mount()
  face.toggle('openOnClick', false)
  await face.save()
  assert.equal(scope.mutations.length, 0)
  assert.equal(face.hooks.notifierCard.getSnapshot().writable, false)
})

test('the host rejecting a save is reported on the card', async () => {
  const scope = createScope(RESOLVED)
  scope.mutate = async () => {
    throw new Error('settings conflict: the namespace moved')
  }
  const mount = mountCard(scope)
  const { face } = await mount()
  face.edit('launchUrl', 'http://example.test/')
  await face.save()
  const state = face.hooks.notifierCard.getSnapshot()
  assert.match(state.error, /settings conflict/)
  assert.equal(state.saving, false)
  assert.equal(state.dirty, true)
})

test('the card follows the namespace when it changes elsewhere', async () => {
  const scope = createScope(RESOLVED)
  const mount = mountCard(scope)
  const { face } = await mount()
  assert.equal(face.hooks.notifierCard.getSnapshot().fields.sound.checked, false)
  await scope.mutate([{ op: 'set', path: ['sound'], value: 'silent' }])
  assert.equal(face.hooks.notifierCard.getSnapshot().fields.sound.checked, true)
})