/**
 * dsh-windows-notifier — browser half.
 *
 * This file is the plugin's client bundle, hand-written instead of built: DSH
 * loads client halves through a lazy CommonJS table, so a bundle is only a
 * script that registers one factory with `window.__ModuleLoader__.load`. The
 * factory body runs when the module is first materialized, and everything it
 * `require`s must be a module the web shell already seeds — `react`,
 * `react/jsx-runtime`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-slots` and the other static UI libraries. A
 * cross-plugin value import is not allowed here; collaboration goes through
 * Cordis services, which is why this card reaches settings through
 * `ctx.settingsScope` rather than by importing another plugin.
 *
 * The card registers into the `settings.plugin.item` slot *keyed by the
 * settings namespace its Host half serves*. That key is the whole contract: the
 * plugins settings section dispatches one card per namespace the Host exposes,
 * so this file never needs to know how the section is laid out, and the section
 * never needs to know what "dsh-windows-notifier" means.
 *
 * The Host owns validation: every save is a revision-fenced document mutation
 * that the Host re-validates against the namespace schema, so this card only
 * stages text, refuses drafts it cannot parse, and reports what the Host says.
 */

window.__ModuleLoader__.load({
  id: 'dsh-windows-notifier',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const clientStore = require('@deepseek-ai/dsh-client-store')

    const h = React.createElement

    /** Settings namespace owned by the Host half; also this card's slot key. */
    const NAMESPACE = 'dsh-windows-notifier'

    /** Injected hook name; the shell exposes it to the card as `useNotifierCard`. */
    const HOOK = 'notifierCard'

    const CSS_ID = `${NAMESPACE}/card.css`
    const CSS = [
      '.dwnCard{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;color:var(--dsw-alias-label-primary)}',
      '.dwnHead{display:flex;align-items:flex-start;gap:12px}',
      '.dwnTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}',
      '.dwnDesc{margin:2px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dwnActions{margin-left:auto;display:flex;gap:8px;flex-shrink:0}',
      '.dwnButton{font:inherit;font-size:12px;line-height:1.5;padding:4px 10px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dwnButton:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.7}',
      '.dwnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dwnField{display:flex;flex-direction:column;gap:6px;padding:8px 0}',
      '.dwnField+.dwnField{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dwnRow{display:flex;align-items:center;gap:8px}',
      '.dwnCheck{display:flex;align-items:center;gap:8px;flex:1;cursor:pointer}',
      '.dwnLabel{flex:1;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dwnBadge{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dwnLink{font:inherit;font-size:12px;line-height:1.5;background:none;border:none;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.dwnLink:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dwnLink:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}',
      '.dwnInput{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px}',
      '.dwnInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dwnInput:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dwnInputInvalid{border-color:var(--dsw-alias-label-error)}',
      '.dwnHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dwnError{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
    ].join('')

    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NAMESPACE
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * The fields this card edits, in the order it renders them.
     *
     * `kind` is the control, not the schema type: `switch` is a boolean,
     * `silent` is a checkbox over the `sound` string, and `number`/`text` are
     * staged as text so an unparseable draft can be shown instead of silently
     * snapping back to a number.
     */
    const FIELDS = [
      { name: 'enabled', kind: 'switch', label: '启用通知', hint: '关掉后不再有任何通知，也不需要重启。' },
      { name: 'notifyOnComplete', kind: 'switch', label: '对话完成、可以继续输入时通知' },
      { name: 'notifyOnQuestion', kind: 'switch', label: '智能体向你提问时通知' },
      { name: 'notifyOnApproval', kind: 'switch', label: '操作等待你批准时通知' },
      { name: 'notifyOnError', kind: 'switch', label: '出错时通知' },
      { name: 'notifyOnInterrupted', kind: 'switch', label: '对话被中断时通知' },
      { name: 'notifyOnActivate', kind: 'switch', label: '插件启用时先发一条通知', hint: '用来确认通知通道本身是通的。' },
      { name: 'includeSubagents', kind: 'switch', label: '子智能体与工作流会话也通知' },
      {
        name: 'disappearAfterMs',
        kind: 'number',
        label: '通知停留时长（毫秒）',
        hint: '0 = 一直留在屏幕上，直到你手动关闭。其它值受 Windows 限制：横幅只有约 5 秒 / 25 秒两档（超过 7000 用长档），这个值决定它在通知中心里保留多久。',
      },
      { name: 'openOnClick', kind: 'switch', label: '点击通知时打开 DSH Web 界面' },
      {
        name: 'launchUrl',
        kind: 'text',
        label: '点击打开的地址',
        hint: '留空 = 自动使用当前 Web 界面的地址；可以用 {sessionId} 占位。',
      },
      { name: 'minTaskDurationMs', kind: 'number', label: '忽略短于该时长的任务（毫秒）', hint: '0 = 不限制。' },
      { name: 'sound', kind: 'silent', label: '静音（不播放提示音）' },
    ]

    const FIELD_BY_NAME = {}
    for (const field of FIELDS) FIELD_BY_NAME[field.name] = field

    /** @returns {boolean} whether `value` is a plain object. */
    const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

    /** Render one resolved value as the text a draft starts from. */
    const formatValue = (value) => (value === undefined || value === null ? '' : String(value))

    /**
     * Parse one staged draft back into a JSON value.
     *
     * @param {object} field - one entry of {@link FIELDS}.
     * @param {string} text - the staged text.
     * @returns {{ ok: boolean, value?: unknown }} the parsed value, or `ok: false`.
     */
    const parseValue = (field, text) => {
      if (field.kind === 'number') {
        const trimmed = text.trim()
        if (trimmed === '') return { ok: false }
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false }
      }
      return { ok: true, value: text }
    }

    /**
     * Build the card's staged form over one bound settings scope.
     *
     * Reads come straight from the scope snapshot — the settings mirror is the
     * only reader of the Host document — while writes are staged here until the
     * user saves, so what is on screen is always what a save would store.
     *
     * @param {object} scope - a `settingsScope.bind({ namespace })` handle.
     * @returns {{ store: object, actions: object, dispose: () => void }} the card.
     */
    const createCard = (scope) => {
      /** Staged edits by field: `{ op: 'set', text }`, `{ op: 'set', value }`, or `{ op: 'unset' }`. */
      const drafts = new Map()
      let saving = false
      let error = ''

      /** Project the current scope snapshot plus the staged drafts. */
      const build = () => {
        const snapshot = scope.getSnapshot()
        const saved = isObject(snapshot.value) ? snapshot.value : {}
        const user = isObject(snapshot.user) ? snapshot.user : {}
        const fields = {}
        for (const field of FIELDS) {
          const draft = drafts.get(field.name)
          const stored = saved[field.name]
          const entry = {
            draft: draft !== undefined,
            overridden: Object.prototype.hasOwnProperty.call(user, field.name),
            invalid: false,
          }
          if (draft !== undefined && draft.op === 'set' && field.kind === 'switch') {
            entry.checked = draft.value === true
          } else if (draft !== undefined && draft.op === 'set' && field.kind === 'silent') {
            entry.checked = draft.value === 'silent'
          } else if (field.kind === 'switch') {
            entry.checked = stored === true
          } else if (field.kind === 'silent') {
            entry.checked = stored === 'silent'
          } else {
            const text = draft !== undefined && draft.op === 'set' ? draft.text : formatValue(stored)
            entry.text = text
            entry.invalid = !parseValue(field, text).ok
          }
          fields[field.name] = entry
        }
        return {
          status: snapshot.status,
          writable: snapshot.writable === true && snapshot.mode === 'host',
          revision: snapshot.revision,
          saving,
          error,
          dirty: drafts.size > 0,
          fields,
        }
      }

      const store = clientStore.createSnapshotStore(build())
      const refresh = () => {
        store.set(build())
      }
      const unsubscribe = scope.subscribe(refresh)

      const stage = (name, draft) => {
        drafts.set(name, draft)
        error = ''
        refresh()
      }

      const actions = {
        /**
         * Stage one text draft.
         * @param {string} name - field name.
         * @param {string} text - the control's value.
         */
        edit(name, text) {
          stage(name, { op: 'set', text })
        },
        /**
         * Stage one boolean draft.
         * @param {string} name - field name.
         * @param {boolean} checked - the control's checked state.
         */
        toggle(name, checked) {
          stage(name, { op: 'set', value: checked === true })
        },
        /**
         * Stage one `sound` draft, whose control is a checkbox over a string.
         * @param {string} name - field name.
         * @param {boolean} muted - whether the user asked for silence.
         */
        setSilent(name, muted) {
          stage(name, { op: 'set', value: muted === true ? 'silent' : 'default' })
        },
        /**
         * Stage a clear: the field stops being a user override and re-inherits
         * whatever this row's own config says.
         * @param {string} name - field name.
         */
        resetField(name) {
          stage(name, { op: 'unset' })
        },
        /** Drop every staged draft. */
        discard() {
          drafts.clear()
          error = ''
          refresh()
        },
        /** Commit every staged draft as one atomic, revision-fenced mutation. */
        async save() {
          if (saving || store.getSnapshot().writable !== true) return
          const operations = []
          let invalid = false
          for (const [name, draft] of drafts) {
            if (draft.op === 'unset') {
              operations.push({ op: 'unset', path: [name] })
              continue
            }
            const field = FIELD_BY_NAME[name]
            if (field.kind === 'switch' || field.kind === 'silent') {
              operations.push({ op: 'set', path: [name], value: draft.value })
              continue
            }
            const parsed = parseValue(field, draft.text)
            if (!parsed.ok) {
              invalid = true
              continue
            }
            operations.push({ op: 'set', path: [name], value: parsed.value })
          }
          if (invalid || operations.length === 0) {
            error = invalid ? '有字段不是合法数字，先修好再保存。' : error
            refresh()
            return
          }
          saving = true
          error = ''
          refresh()
          try {
            await scope.mutate(operations)
            drafts.clear()
          } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure)
          } finally {
            saving = false
            refresh()
          }
        },
      }

      return { store, actions, dispose: unsubscribe }
    }

    /**
     * Render one field row.
     *
     * @param {object} field - one entry of {@link FIELDS}.
     * @param {object} entry - its projected state.
     * @param {object} props - the card's injected actions.
     * @param {boolean} locked - whether every control is disabled.
     * @returns {object} the React element.
     */
    const renderField = (field, entry, props, locked) => {
      const id = `${NAMESPACE}-${field.name}`
      const checkable = field.kind === 'switch' || field.kind === 'silent'
      const control = checkable
        ? h('label', { className: 'dwnCheck', htmlFor: id, key: 'label' },
            h('input', {
              id,
              type: 'checkbox',
              checked: entry.checked === true,
              disabled: locked,
              onChange: (event) => {
                if (field.kind === 'silent') props.setSilent(field.name, event.target.checked)
                else props.toggle(field.name, event.target.checked)
              },
            }),
            h('span', { className: 'dwnLabel' }, field.label))
        : h('label', { className: 'dwnLabel', htmlFor: id, key: 'label' }, field.label)

      const children = [
        h('div', { className: 'dwnRow', key: 'head' },
          control,
          entry.overridden ? h('span', { className: 'dwnBadge', key: 'badge' }, '已覆盖') : null,
          entry.overridden
            ? h('button', {
                key: 'reset',
                type: 'button',
                className: 'dwnLink',
                disabled: locked,
                onClick: () => props.resetField(field.name),
              }, '重置')
            : null),
      ]
      if (!checkable) {
        children.push(h('input', {
          key: 'input',
          id,
          className: entry.invalid ? 'dwnInput dwnInputInvalid' : 'dwnInput',
          type: 'text',
          inputMode: field.kind === 'number' ? 'numeric' : 'text',
          spellCheck: false,
          value: entry.text ?? '',
          disabled: locked,
          onChange: (event) => props.edit(field.name, event.target.value),
        }))
      }
      if (field.hint) children.push(h('p', { className: 'dwnHint', key: 'hint' }, field.hint))
      if (entry.invalid) children.push(h('p', { className: 'dwnError', key: 'invalid' }, '需要一个数字（毫秒）。'))
      return h('div', { className: 'dwnField', key: field.name }, children)
    }

    /**
     * The configuration card.
     *
     * It reads its state through the injected `useNotifierCard` hook and writes
     * through the injected actions, so it holds no state of its own: the card is
     * a pure projection of the staging store.
     *
     * @param {object} props - injected hooks and actions.
     * @returns {object} the React element.
     */
    function NotifierCard(props) {
      const state = props.useNotifierCard((snapshot) => snapshot)
      const locked = !state.writable || state.saving
      const rows = FIELDS.map((field) => renderField(field, state.fields[field.name], props, locked))
      return h('div', { className: 'dwnCard' },
        h('div', { className: 'dwnHead' },
          h('div', { key: 'titles' },
            h('h4', { className: 'dwnTitle' }, 'Windows 通知'),
            h('p', { className: 'dwnDesc' }, '任何对话需要你时（完成、提问、等待批准、出错），弹一条 Windows 系统通知。')),
          h('div', { className: 'dwnActions', key: 'actions' },
            h('button', {
              type: 'button',
              className: 'dwnButton dwnPrimary',
              disabled: locked || !state.dirty,
              onClick: () => {
                void props.save()
              },
            }, state.saving ? '保存中…' : '保存'),
            h('button', {
              type: 'button',
              className: 'dwnButton',
              disabled: state.saving || !state.dirty,
              onClick: () => props.discard(),
            }, '放弃修改'))),
        state.status === 'unavailable'
          ? h('p', { className: 'dwnHint' }, 'Host 没有把这个设置暴露给本页面，界面暂时只能看。')
          : null,
        state.error ? h('p', { className: 'dwnError' }, state.error) : null,
        rows)
    }

    /** Required client services: the settings transport and the slot registry. */
    const inject = ['slots', 'settingsScope']

    /**
     * Mount the card into the plugins settings section.
     *
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
      const card = createCard(scope)
      ctx.effect(() => card.dispose, `${NAMESPACE}: card store`)
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: NAMESPACE,
          inject: () => ({ hooks: { [HOOK]: card.store }, ...card.actions }),
        }, NotifierCard)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})