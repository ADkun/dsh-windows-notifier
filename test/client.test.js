/**
 * The browser half's contract, exercised without a browser.
 *
 * `src/client.js` is a script, not a module: it registers one factory with the
 * shell's lazy-CJS loader and does nothing else until that factory is
 * materialized. So the whole browser half is reachable from Node by supplying
 * the two globals it touches (`window`, `document`) and the one module it
 * requests (`react`) — which is exactly what a card that must not be able to
 * break the shell deserves: the shape it registers, the services it needs, the
 * row it hangs off, and the operations it builds from a staged draft.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { LIVE_OPTIONS } from '../src/settings.js'

/** The package that ships the card; also its dictionary namespace. */
const PACKAGE = 'dsh-windows-notifier'

/** The row id the bundle patch declares. */
const ENTRY_ID = 'windows-notifier'

/** The key the Plugins page looks this row's configuration page up by. */
const ROW_KEY = `${PACKAGE}#${ENTRY_ID}`

/** The dictionary namespace the card registers its copy under. */
const NS = 'dsh-windows-notifier'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A React stand-in with just enough hook runtime to render one function
 * component: `createElement`, and a `useState` whose setter re-renders
 * synchronously, so a test can drive a control and read the next tree.
 */
function createReactHarness() {
  let slots = []
  let cursor = 0
  let component = null
  let props = null
  let tree = null

  const render = () => {
    cursor = 0
    tree = component(props)
    return tree
  }

  const React = {
    createElement: (type, elementProps, ...children) => ({
      type,
      props: elementProps ?? {},
      children,
    }),
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
          if (component !== null) render()
        },
      ]
    },
  }

  return {
    React,
    /** The latest rendered tree; every `useState` write replaces it. */
    get tree() {
      return tree
    },
    /** Mount the component, resetting the hook slots. */
    mount(renderable, initialProps) {
      component = renderable
      props = initialProps
      slots = []
      return render()
    },
    /** Re-render with new props, as the Plugins page does on a snapshot change. */
    update(nextProps) {
      props = nextProps
      return render()
    },
  }
}

/** A `document` stand-in recording every stylesheet the bundle appends. */
function createDocumentStub(styles) {
  return {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: (tag) => styles.push(tag) },
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
  globalThis.document = createDocumentStub(styles)
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
function materialize(entry, React) {
  return entry.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected client module request: ${specifier}`)
  })
}

/**
 * A `configForms` controller stand-in: one Host snapshot plus a write log.
 *
 * @param value - the resolved section the Host would report.
 * @param options - `writable`, `mode`, the raw `user` layer, and `status`.
 */
function createScope(value, { writable = true, mode = 'host', user = {}, status = 'ready' } = {}) {
  const mutations = []
  const revisions = []
  let snapshot = {
    status,
    value: { ...value },
    base: { ...value },
    user: { ...user },
    revision: 1,
    writable,
    mode,
  }
  return {
    mutations,
    revisions,
    snapshot: () => snapshot,
    async mutate(operations, atRevision) {
      mutations.push(operations)
      revisions.push(atRevision)
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
      return true
    },
  }
}

/**
 * Load the bundle, apply it to a fake Plugins page, and bind the card to a form.
 *
 * The fake registry decides whether this row's namespace is served, exactly as
 * the Host does: only then does the card reach the `plugins.row.config` slot.
 *
 * @param scope - the form controller to bind.
 * @param options - `served`, whether the Host serves this row's namespace.
 */
async function mountCard(scope, { served = true } = {}) {
  const registrations = []
  const effects = []
  const dictionaries = new Map()
  const requested = []
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
      return () => {}
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries.set(namespace, dictionary)
        return () => dictionaries.delete(namespace)
      },
    },
    configForms: {
      whileServed(entryIds, callback) {
        assert.deepEqual([...entryIds], [ENTRY_ID], 'the row is addressed by its own entry id')
        if (!served) return () => {}
        const dispose = callback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    },
    slots: {
      inject(name, generator) {
        requested.push(name)
        generator()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  const { entry, styles } = await loadBundle()
  const harness = createReactHarness()
  const module = materialize(entry, harness.React)
  // `installStyles` runs inside the first effect, so the document must be there
  // while `apply` runs — not only while the factory is materialized.
  const previousDocument = globalThis.document
  globalThis.document = createDocumentStub(styles)
  try {
    module.apply(ctx)
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }

  const t = (key) => dictionaries.get(NS)?.zh?.[key] ?? key
  const registration = registrations[0]
  let mounted = false
  const renderView = (view) => {
    const props = {
      t,
      view,
      form: view === 'summary'
        ? undefined
        : {
            state: scope.snapshot(),
            mutate: (operations, revision) => scope.mutate(operations, revision),
          },
    }
    if (mounted) return harness.update(props)
    mounted = true
    return harness.mount(registration.component, props)
  }

  return {
    module,
    ctx,
    entry,
    styles,
    registrations,
    effects,
    dictionaries,
    requested,
    t,
    /** Render the page over the Host's current snapshot. */
    render: () => renderView('page'),
    /** The latest tree, after whatever interaction the test just drove. */
    tree: () => harness.tree,
    /** The one-liner the Plugins list shows, rendered the same way. */
    summary: () => renderView('summary'),
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
  waitForSubagents: true,
  disappearAfterMs: 6000,
  openOnClick: true,
  launchUrl: '',
  minTaskDurationMs: 0,
  sound: 'default',
  logFile: '',
}

/** Collect every string, every element, and every input in a rendered tree. */
function walk(node, collected = { text: [], nodes: [], inputs: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return collected
  if (Array.isArray(node)) {
    for (const child of node) walk(child, collected)
    return collected
  }
  if (typeof node === 'object') {
    collected.nodes.push(node)
    if (node.type === 'input') collected.inputs.push(node.props)
    for (const child of node.children) walk(child, collected)
    return collected
  }
  collected.text.push(String(node))
  return collected
}

/** Every string rendered inside one element, joined. */
const textOf = (node) => walk(node).text.join('')

/** One rendered input's props, by id. */
const inputsById = (tree) => new Map(walk(tree).inputs.map((props) => [props.id, props]))

/** The props of the control the card rendered for one field. */
const controlOf = (card, name) => inputsById(card.tree()).get(`${NS}-${name}`)

/** Stage one text draft through the control, as a user would. */
const stageEdit = (card, name, value) =>
  controlOf(card, name).onChange({ target: { value } })

/** Stage one checkbox draft through the control, as a user would. */
const stageToggle = (card, name, checked) =>
  controlOf(card, name).onChange({ target: { checked } })

/** The props of the first button whose text contains `label`. */
const buttonByText = (tree, label) =>
  walk(tree).nodes.find((node) => node.type === 'button' && textOf(node).includes(label))

/** Every error line the card is currently showing. */
const errorsOf = (tree) =>
  walk(tree)
    .nodes.filter((node) => node.type === 'p' && node.props.className === 'dwnError')
    .map(textOf)
    .join(' | ')

test('the bundle registers one factory under the package name', async () => {
  const { entry, styles } = await loadBundle()
  assert.equal(entry.id, 'dsh-windows-notifier')
  assert.equal(typeof entry.factory, 'function')
  // The stylesheet arrives with the applied factory, not with the script.
  assert.equal(styles.length, 0)
})

test('materializing requires nothing the shell does not seed', async () => {
  const { entry } = await loadBundle()
  const module = materialize(entry, createReactHarness().React)
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...module.inject], ['slots', 'locale', 'configForms'])
})

test('the card is registered on the row key once the namespace is served', async () => {
  const card = await mountCard(createScope(RESOLVED))

  assert.equal(card.registrations.length, 1)
  const [registration] = card.registrations
  assert.equal(registration.options.name, 'plugins.row.config')
  assert.equal(registration.options.key, 'dsh-windows-notifier#windows-notifier')
  assert.equal(registration.options.locale, NS)
  assert.equal(typeof registration.component, 'function')
  assert.deepEqual(card.requested, ['plugins.row.config'])

  // Stylesheet, dictionaries, and the row's page: three effects the owning
  // context can dispose.
  assert.deepEqual(
    card.effects.map((effect) => effect.label),
    [`${NS}: card styles`, `${NS}: dictionaries`, `${NS}: row configuration page`],
  )
  assert.equal(card.styles.length, 1)
  assert.equal(card.styles[0].dataset.plugin, PACKAGE)
  assert.equal(card.styles[0].dataset.pluginCss, `${PACKAGE}/card.css`)
  assert.equal(card.dictionaries.get(NS).zh.title, 'Windows 通知')
  assert.equal(card.dictionaries.get(NS).en.title, 'Windows notifications')
})

test('an unserved row contributes no card at all', async () => {
  const card = await mountCard(createScope(RESOLVED), { served: false })
  assert.equal(card.registrations.length, 0)
  assert.deepEqual(card.requested, [])
  assert.equal(card.dictionaries.size, 1, 'the dictionaries are registered regardless')
})

test('a rendered card shows every live field in schema order', async () => {
  const card = await mountCard(createScope(RESOLVED))
  const tree = card.render()
  const collected = walk(tree)

  assert.ok(collected.text.includes('Windows 通知'))
  assert.ok(collected.text.includes('通知停留时长（毫秒）'))
  assert.ok(collected.text.includes('排查日志文件'))
  assert.ok(collected.text.includes('点击通知时打开 DSH Web 界面'))
  // 10 switches plus the sound checkbox, and the four text/number inputs.
  assert.equal(collected.inputs.filter((props) => props.type === 'checkbox').length, 11)
  assert.equal(collected.inputs.filter((props) => props.type === 'text').length, 4)
  // The card edits exactly the Host's volatile fields, in the same order.
  assert.deepEqual(
    collected.inputs.map((props) => props.id.replace(`${NS}-`, '')),
    [...LIVE_OPTIONS],
  )

  assert.equal(controlOf(card, 'disappearAfterMs').value, '6000')
  assert.equal(controlOf(card, 'minTaskDurationMs').value, '0')
  assert.equal(controlOf(card, 'logFile').value, '')
  assert.equal(controlOf(card, 'openOnClick').checked, true)
  assert.equal(controlOf(card, 'enabled').checked, true)
  assert.equal(controlOf(card, 'sound').checked, false)
})

test('view summary renders a one-liner, not a form', async () => {
  const card = await mountCard(createScope(RESOLVED))
  assert.equal(typeof card.summary(), 'string')
  assert.equal(card.summary(), '任何对话需要你时（完成、提问、等待批准、出错），弹一条 Windows 系统通知。')
})

test('staging an edit marks the card dirty without writing anything', async () => {
  const scope = createScope(RESOLVED)
  const card = await mountCard(scope)
  card.render()

  stageToggle(card, 'openOnClick', false)
  stageEdit(card, 'disappearAfterMs', '0')

  assert.equal(controlOf(card, 'openOnClick').checked, false)
  assert.equal(controlOf(card, 'disappearAfterMs').value, '0')
  assert.equal(buttonByText(card.tree(), '保存').props.disabled, false, 'the save is armed')
  assert.equal(scope.mutations.length, 0, 'nothing is written until Save')
})

test('saving sends one atomic, revision-fenced operation list', async () => {
  const scope = createScope(RESOLVED)
  const card = await mountCard(scope)
  card.render()

  stageToggle(card, 'enabled', false)
  stageEdit(card, 'disappearAfterMs', '0')
  stageToggle(card, 'sound', true)
  buttonByText(card.tree(), '保存').props.onClick()
  assert.equal(scope.mutations.length, 0, 'the write is asynchronous')

  await flush()
  assert.deepEqual(scope.mutations, [[
    { op: 'set', path: ['enabled'], value: false },
    { op: 'set', path: ['disappearAfterMs'], value: 0 },
    { op: 'set', path: ['sound'], value: 'silent' },
  ]])
  assert.deepEqual(scope.revisions, [1], 'the write is fenced to the snapshot it read')

  // The Host accepted it: the page re-renders from the new snapshot and the
  // drafts are gone.
  card.render()
  assert.match(textOf(card.tree()), /已保存，从现在起生效。/)
  assert.equal(controlOf(card, 'enabled').checked, false)
  assert.equal(controlOf(card, 'disappearAfterMs').value, '0')
  assert.equal(controlOf(card, 'sound').checked, true)
})

test('resetting a field clears the user override instead of writing a value', async () => {
  const scope = createScope(
    { ...RESOLVED, disappearAfterMs: 25000 },
    { user: { disappearAfterMs: 25000 } },
  )
  const card = await mountCard(scope)
  card.render()
  assert.match(textOf(card.tree()), /已覆盖默认/)

  buttonByText(card.tree(), '恢复默认').props.onClick()
  await flush()
  assert.deepEqual(scope.mutations, [[{ op: 'unset', path: ['disappearAfterMs'] }]])
})

test('discarding drops every draft', async () => {
  const scope = createScope(RESOLVED)
  const card = await mountCard(scope)
  card.render()
  stageEdit(card, 'launchUrl', 'http://example.test/')
  assert.equal(controlOf(card, 'launchUrl').value, 'http://example.test/')

  buttonByText(card.tree(), '放弃修改').props.onClick()
  assert.equal(controlOf(card, 'launchUrl').value, '')
  assert.equal(scope.mutations.length, 0)
})

test('an unparseable number blocks the save instead of dropping the field', async () => {
  const scope = createScope(RESOLVED)
  const card = await mountCard(scope)
  card.render()
  stageEdit(card, 'disappearAfterMs', '马上')

  assert.equal(controlOf(card, 'disappearAfterMs').value, '马上', 'the draft survives')
  assert.match(textOf(card.tree()), /这里需要一个数字（毫秒）。/)
  const save = buttonByText(card.tree(), '保存')
  assert.equal(save.props.disabled, true)
  save.props.onClick()

  await flush()
  assert.equal(scope.mutations.length, 0, 'the unparseable draft is never sent')
})

test('a deployment that cannot accept writes locks every control', async () => {
  for (const options of [{ writable: false }, { mode: 'user-config' }]) {
    const scope = createScope(RESOLVED, options)
    const card = await mountCard(scope)
    const tree = card.render()

    assert.match(textOf(tree), /这个 profile 不允许写入设置。/, JSON.stringify(options))
    assert.equal(buttonByText(tree, '保存').props.disabled, true)
    for (const props of walk(tree).inputs) {
      assert.equal(props.disabled, true, `${props.id} is locked`)
    }

    stageToggle(card, 'openOnClick', false)
    assert.equal(buttonByText(card.tree(), '保存').props.disabled, true)
    await flush()
    assert.equal(scope.mutations.length, 0)
  }
})

test('a save the Host refuses is reported instead of swallowed', async () => {
  const declined = createScope(RESOLVED)
  const declinedCard = await mountCard(declined)
  declinedCard.render()
  declined.mutate = async (operations) => {
    declined.mutations.push(operations)
    return false
  }
  stageEdit(declinedCard, 'launchUrl', 'http://example.test/')
  buttonByText(declinedCard.tree(), '保存').props.onClick()
  await flush()
  assert.match(textOf(declinedCard.tree()), /本部署没有接受这些值，已保留供你修改。/)
  assert.equal(
    controlOf(declinedCard, 'launchUrl').value,
    'http://example.test/',
    'the draft is kept so the user can fix it',
  )

  const rejected = createScope(RESOLVED)
  const rejectedCard = await mountCard(rejected)
  rejectedCard.render()
  rejected.mutate = async () => {
    throw new Error('revision conflict: the row moved')
  }
  stageEdit(rejectedCard, 'launchUrl', 'http://example.test/')
  buttonByText(rejectedCard.tree(), '保存').props.onClick()
  await flush()
  assert.match(errorsOf(rejectedCard.tree()), /revision conflict: the row moved/)
  assert.equal(controlOf(rejectedCard, 'launchUrl').value, 'http://example.test/')
})

test('the card follows the Host snapshot when it changes elsewhere', async () => {
  const scope = createScope(RESOLVED)
  const card = await mountCard(scope)
  card.render()
  assert.equal(controlOf(card, 'sound').checked, false)

  await scope.mutate([{ op: 'set', path: ['sound'], value: 'silent' }])
  card.render()
  assert.equal(controlOf(card, 'sound').checked, true)
})