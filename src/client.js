/**
 * dsh-windows-notifier — browser half.
 *
 * This file is the plugin's client bundle, hand-written instead of built: DSH
 * loads client halves through a lazy CommonJS table, so a bundle is only a
 * script that registers one factory with `window.__ModuleLoader__.load`. The
 * factory body runs when the module is first materialized, and everything it
 * `require`s must be a module the web shell already seeds — `react` and
 * `react/jsx-runtime` here. A cross-plugin value import is not allowed;
 * collaboration goes through Cordis services, which is why this card reaches
 * configuration through `ctx.configForms` rather than by importing another
 * plugin.
 *
 * DSH 0.1.7 moved that boundary: the old `settingsScope` service is gone, and a
 * plugin no longer owns a settings namespace. What exists instead is
 * `configForms`, which mirrors the Host's own descriptors (one per active
 * profile entry, addressed by entry id) and hands out one form controller per
 * entry. This card registers into the Plugins page's `plugins.row.config` slot
 * under `<package>#<row id>`, and the page supplies it with `{ view, form }`:
 * `form.state` is the Host's snapshot (`value`, `base`, `user`, `revision`,
 * `writable`) and `form.mutate(ops, revision)` is the revision-fenced write.
 *
 * The Host owns validation: every save is one atomic document mutation that the
 * Host re-validates against the row's Config schema, so this card only stages
 * text, refuses drafts it cannot parse, and reports what the Host says.
 */

window.__ModuleLoader__.load({
  id: 'dsh-windows-notifier',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const h = React.createElement

    /** The bundle's package name; the row page key is `<package>#<row id>`. */
    const PACKAGE = 'dsh-windows-notifier'

    /** The row id the bundle patch declares; the form is addressed by it. */
    const ENTRY_ID = 'windows-notifier'

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-windows-notifier'

    /** The key the Plugins page looks this row's configuration page up by. */
    const ROW_KEY = `${PACKAGE}#${ENTRY_ID}`

    const CSS_ID = `${PACKAGE}/card.css`
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
      '.dwnOk{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    /** Append the card's stylesheet, and return the disposer that removes it. */
    const installStyles = () => {
      if (typeof document === 'undefined') return () => {}
      const selector = `style[data-plugin-css=${JSON.stringify(CSS_ID)}]`
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /** The dictionaries the Plugins page renders this card's copy from. */
    const en = {
      title: 'Windows notifications',
      description: 'A native Windows toast whenever a conversation needs you — a turn finished, a question was asked, an approval is waiting, or an error came up.',
      label_enabled: 'Notifications enabled',
      hint_enabled: 'Nothing is reported while this is off, and it takes effect without a restart.',
      label_notifyOnComplete: 'Notify when a conversation is ready for your next message',
      label_notifyOnQuestion: 'Notify when the agent asks you a question',
      label_notifyOnApproval: 'Notify when an operation waits for your approval',
      label_notifyOnError: 'Notify when a step or turn fails',
      label_notifyOnInterrupted: 'Notify when a turn is interrupted',
      label_notifyOnActivate: 'Send one notification when the plugin starts',
      hint_notifyOnActivate: 'Useful for proving the notification channel itself works.',
      label_includeSubagents: "Also notify for a subagent's own turn end",
      hint_includeSubagents: 'A subagent that asks you something, waits for approval, or fails is always reported; this switch only covers the "the child finished its turn" family.',
      label_disappearAfterMs: 'How long a notification stays (ms)',
      hint_disappearAfterMs: '0 = stay on screen until you dismiss it. Windows offers roughly 5s and 25s banner steps (over 7000 uses the long one); this value decides how long it stays in the Action Center.',
      label_openOnClick: 'Open the DSH Web GUI when a notification is clicked',
      label_launchUrl: 'URL a click opens',
      hint_launchUrl: 'Empty = the running Web GUI; {sessionId} is substituted when present.',
      label_minTaskDurationMs: 'Ignore turns shorter than this (ms)',
      hint_minTaskDurationMs: '0 = no limit.',
      label_sound: 'Silent (no notification sound)',
      label_logFile: 'Debug log file',
      hint_logFile: 'One line per decision, including every suppressed notification and why — the way to answer "why did nothing pop up". Empty = write no file.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Saved; it applies from now on.',
      saveFailed: 'This profile did not accept the values; they are kept for you to fix.',
      invalidNumber: 'A number of milliseconds is required here.',
      overridden: 'Overridden',
      reset: 'Reset',
      loading: 'Reading the Host configuration…',
      unavailable: 'The Host does not expose this configuration to this page.',
      readOnly: 'This profile does not accept settings writes.',
    }

    const zh = {
      title: 'Windows 通知',
      description: '任何对话需要你时（完成、提问、等待批准、出错），弹一条 Windows 系统通知。',
      label_enabled: '启用通知',
      hint_enabled: '关掉后不再有任何通知，也不需要重启。',
      label_notifyOnComplete: '对话完成、可以继续输入时通知',
      label_notifyOnQuestion: '智能体向你提问时通知',
      label_notifyOnApproval: '操作等待你批准时通知',
      label_notifyOnError: '出错时通知',
      label_notifyOnInterrupted: '对话被中断时通知',
      label_notifyOnActivate: '插件启用时先发一条通知',
      hint_notifyOnActivate: '用来确认通知通道本身是通的。',
      label_includeSubagents: '子智能体自己的「结束」也通知',
      hint_includeSubagents: '子智能体向你提问、等你批准、或出错时始终会通知；这里只管子智能体自己一轮跑完的那声「对话已完成」。',
      label_disappearAfterMs: '通知停留时长（毫秒）',
      hint_disappearAfterMs: '0 = 一直留在屏幕上，直到你手动关闭。其它值受 Windows 限制：横幅只有约 5 秒 / 25 秒两档（超过 7000 用长档），这个值决定它在通知中心里保留多久。',
      label_openOnClick: '点击通知时打开 DSH Web 界面',
      label_launchUrl: '点击打开的地址',
      hint_launchUrl: '留空 = 自动使用当前 Web 界面的地址；可以用 {sessionId} 占位。',
      label_minTaskDurationMs: '忽略短于该时长的任务（毫秒）',
      hint_minTaskDurationMs: '0 = 不限制。',
      label_sound: '静音（不播放提示音）',
      label_logFile: '排查日志文件',
      hint_logFile: '每做一个判断写一行，包括每一次被跳过的通知和原因 —— 「为什么没弹」就靠它回答。留空 = 不写文件。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '已保存，从现在起生效。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '这里需要一个数字（毫秒）。',
      overridden: '已覆盖默认',
      reset: '恢复默认',
      loading: '正在读取 Host 配置…',
      unavailable: 'Host 没有把这个设置暴露给本页面。',
      readOnly: '这个 profile 不允许写入设置。',
    }

    /**
     * The fields this card edits, in the order it renders them.
     *
     * `kind` is the control, not the schema type: `switch` is a boolean, `mute`
     * is a checkbox over the `sound` string, and `number`/`text` are staged as
     * text so an unparseable draft can be shown instead of silently snapping
     * back to a number. The names are exactly the volatile fields of the Host
     * half's `Config` (`src/settings.js`), in the same order, because they are
     * precisely the paths the Host accepts in a write.
     */
    const FIELDS = [
      { name: 'enabled', kind: 'switch' },
      { name: 'notifyOnComplete', kind: 'switch' },
      { name: 'notifyOnQuestion', kind: 'switch' },
      { name: 'notifyOnApproval', kind: 'switch' },
      { name: 'notifyOnError', kind: 'switch' },
      { name: 'notifyOnInterrupted', kind: 'switch' },
      { name: 'notifyOnActivate', kind: 'switch' },
      { name: 'includeSubagents', kind: 'switch' },
      { name: 'disappearAfterMs', kind: 'number' },
      { name: 'openOnClick', kind: 'switch' },
      { name: 'launchUrl', kind: 'text' },
      { name: 'minTaskDurationMs', kind: 'number' },
      { name: 'sound', kind: 'mute' },
      { name: 'logFile', kind: 'text' },
    ]

    /** @returns {boolean} whether `value` is a plain object. */
    const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

    /** Render one resolved value as the text a draft starts from. */
    const formatValue = (value) => (value === undefined || value === null ? '' : String(value))

    /** @returns {boolean} whether the control of `field` is a checkbox. */
    const isCheckable = (field) => field.kind === 'switch' || field.kind === 'mute'

    /** The checked state a stored value resolves to. */
    const checkedOf = (field, stored) =>
      field.kind === 'mute' ? stored === 'silent' : stored === true

    /**
     * Parse one staged draft back into the JSON value the Host stores.
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
     * Render one field row.
     *
     * @param {object} entry - the field with its projected state.
     * @param {object} handlers - staging callbacks for this card.
     * @param {boolean} locked - whether every control is disabled.
     * @param {Function} t - this card's locale reader.
     * @returns {object} the React element.
     */
    const renderField = (entry, handlers, locked, t) => {
      const field = entry.field
      const id = `${NS}-${field.name}`
      const checkable = isCheckable(field)
      const control = checkable
        ? h('label', { className: 'dwnCheck', htmlFor: id, key: 'label' },
            h('input', {
              id,
              type: 'checkbox',
              checked: entry.checked === true,
              disabled: locked,
              onChange: (event) => {
                handlers.toggle(field.name, event.target.checked)
              },
            }),
            h('span', { className: 'dwnLabel' }, t(`label_${field.name}`)))
        : h('label', { className: 'dwnLabel', htmlFor: id, key: 'label' }, t(`label_${field.name}`))

      const children = [
        h('div', { className: 'dwnRow', key: 'head' },
          control,
          entry.overridden ? h('span', { className: 'dwnBadge', key: 'badge' }, t('overridden')) : null,
          entry.overridden
            ? h('button', {
                key: 'reset',
                type: 'button',
                className: 'dwnLink',
                disabled: locked,
                onClick: () => {
                  handlers.resetField(field.name)
                },
              }, t('reset'))
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
          onChange: (event) => {
            handlers.edit(field.name, event.target.value)
          },
        }))
      }
      const hint = t(`hint_${field.name}`)
      if (hint !== `hint_${field.name}`) children.push(h('p', { className: 'dwnHint', key: 'hint' }, hint))
      if (entry.invalid) children.push(h('p', { className: 'dwnError', key: 'invalid' }, t('invalidNumber')))
      return h('div', { className: 'dwnField', key: field.name }, children)
    }

    /**
     * The row's configuration page.
     *
     * It stages edits in its own React state and reads the accepted values from
     * the snapshot the Plugins page passes in, so what is on screen is always
     * what a save would store.
     *
     * @param {object} props - the view asked for (`page` or `summary`), locale
     * copy, and the form the page bound to this row (`state` plus `mutate`).
     * @returns {object | string} the form, or the one-liner.
     */
    function NotifierCard(props) {
      const { t, view, form } = props
      const [drafts, setDrafts] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      if (view === 'summary') return t('description')

      const state = form?.state
      const status = state?.status
      const writable = state?.writable === true && state?.mode === 'host'
      const saved = isObject(state?.value) ? state.value : {}
      const user = isObject(state?.user) ? state.user : {}

      const entries = []
      let invalid = false
      let dirty = false
      for (const field of FIELDS) {
        const stored = saved[field.name]
        const staged = Object.prototype.hasOwnProperty.call(drafts, field.name)
        const entry = { field, overridden: Object.prototype.hasOwnProperty.call(user, field.name), invalid: false }
        if (isCheckable(field)) {
          entry.checked = staged ? drafts[field.name] === true : checkedOf(field, stored)
          entry.changed = entry.checked !== checkedOf(field, stored)
        } else {
          entry.text = staged ? drafts[field.name] : formatValue(stored)
          entry.invalid = !parseValue(field, entry.text).ok
          entry.changed = entry.text !== formatValue(stored)
          if (entry.invalid) invalid = true
        }
        if (entry.changed) dirty = true
        entries.push(entry)
      }

      const locked = !writable || busy

      /** Stage one draft for a text control. */
      const edit = (name, text) => {
        setNotice(null)
        setDrafts((current) => ({ ...current, [name]: text }))
      }

      /** Stage one draft for a checkbox control. */
      const toggle = (name, checked) => {
        setNotice(null)
        setDrafts((current) => ({ ...current, [name]: checked === true }))
      }

      /** Commit one field edit and report what the Host decided. */
      const commit = (operations) => {
        setBusy(true)
        setNotice(null)
        Promise.resolve()
          .then(() => form.mutate(operations, state.revision))
          .then((accepted) => {
            setBusy(false)
            if (accepted !== true) {
              setNotice({ kind: 'error', text: t('saveFailed') })
              return
            }
            setDrafts({})
            setNotice({ kind: 'ok', text: t('saved') })
          }, (failure) => {
            setBusy(false)
            const detail = failure instanceof Error ? failure.message : String(failure)
            setNotice({ kind: 'error', text: `${t('saveFailed')} ${detail}` })
          })
      }

      /** Commit every staged edit as one atomic, revision-fenced mutation. */
      const save = () => {
        if (locked || !dirty || invalid) return
        const operations = []
        for (const entry of entries) {
          if (!entry.changed) continue
          if (entry.field.kind === 'switch') {
            operations.push({ op: 'set', path: [entry.field.name], value: entry.checked === true })
            continue
          }
          if (entry.field.kind === 'mute') {
            operations.push({ op: 'set', path: [entry.field.name], value: entry.checked === true ? 'silent' : 'default' })
            continue
          }
          operations.push({ op: 'set', path: [entry.field.name], value: parseValue(entry.field, entry.text).value })
        }
        if (operations.length === 0) return
        commit(operations)
      }

      /** Drop every staged draft. */
      const discard = () => {
        setDrafts({})
        setNotice(null)
      }

      /** Drop one field's user override, so it re-inherits the row's config. */
      const resetField = (name) => {
        if (locked) return
        commit([{ op: 'unset', path: [name] }])
      }

      const handlers = { edit, toggle, resetField }
      const statusLine = form === undefined || status === 'unavailable'
        ? h('p', { className: 'dwnHint', key: 'status' }, t('unavailable'))
        : status === 'loading'
          ? h('p', { className: 'dwnHint', key: 'status' }, t('loading'))
          : !writable
            ? h('p', { className: 'dwnHint', key: 'status' }, t('readOnly'))
            : null
      const noticeLine = notice === null
        ? null
        : h('p', { className: notice.kind === 'error' ? 'dwnError' : 'dwnOk', key: 'notice' }, notice.text)

      return h('div', { className: 'dwnCard' },
        h('div', { className: 'dwnHead' },
          h('div', { key: 'titles' },
            h('h4', { className: 'dwnTitle' }, t('title')),
            h('p', { className: 'dwnDesc' }, t('description'))),
          h('div', { className: 'dwnActions', key: 'actions' },
            h('button', {
              type: 'button',
              className: 'dwnButton dwnPrimary',
              disabled: locked || !dirty || invalid,
              onClick: save,
            }, busy ? t('saving') : t('save')),
            h('button', {
              type: 'button',
              className: 'dwnButton',
              disabled: busy || !dirty,
              onClick: discard,
            }, t('discard')))),
        statusLine,
        noticeLine,
        entries.map((entry) => renderField(entry, handlers, locked, t)))
    }

    /**
     * Required client services: the slot registry, the locale reader, and the
     * configuration forms the Plugins page binds to each entry.
     */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Contribute the row's configuration page to the Plugins page.
     *
     * The registration is kept alive only while the Host serves this row's
     * namespace, so a deployment that never enabled the bundle shows no trace
     * of the card.
     *
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(installStyles, `${NS}: card styles`)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
      // The registration names the dictionary namespace, and the slot machinery
      // hands the component the `t` bound to it — no reader is created here.
      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
      }, NotifierCard))), `${NS}: row configuration page`)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})