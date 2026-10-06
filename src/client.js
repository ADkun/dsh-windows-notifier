/**
 * dsh-windows-notifier — browser half.
 *
 * This file is the plugin's client bundle, hand-written instead of built: DSH
 * loads client halves through a lazy CommonJS table, so a bundle is only a
 * script that registers one factory with `window.__ModuleLoader__.load`. The
 * factory body runs when the module is first materialized, and everything it
 * `require`s must be a module the web shell already seeds — `react` and
 * `react/jsx-runtime` here. A cross-plugin value import is not allowed;
 * collaboration goes through Cordis services, which is why this page reaches
 * configuration through `ctx.configForms` rather than by importing another
 * plugin.
 *
 * DSH 0.1.7 moved that boundary: the old `settingsScope` service is gone, and a
 * plugin no longer owns a settings namespace. What exists instead is
 * `configForms`, which mirrors the Host's own descriptors (one per active
 * profile entry, addressed by entry id) and hands out one form controller per
 * entry.
 *
 * The configuration is a settings page of its own — `settings.section`, the
 * sidebar entry the settings shell renders in its nav — and not a card inside
 * the Plugins page, so this plugin now contributes two things:
 *
 *   - the page, which subscribes to the entry's form controller itself, because
 *     the shell mounts only the active section and never re-renders it on a Host
 *     answer; and
 *   - the Plugins row's one-line summary, plus a pointer to the page that took
 *     the form over.
 *
 * The Host owns validation: every save is one atomic document mutation that the
 * Host re-validates against the row's Config schema, so this page only stages
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

    /** The key the Plugins page looks this row's summary up by. */
    const ROW_KEY = `${PACKAGE}#${ENTRY_ID}`

    /** This plugin's entry in the settings sidebar; the shell keys the nav on it. */
    const SECTION_ID = 'windows-notifier'

    /** Where the settings entry sits between the factory sections and later ones. */
    const SECTION_ORDER = 38

    const CSS_ID = `${PACKAGE}/card.css`
    const CSS = [
      '.dwnPage{display:flex;flex-direction:column;gap:14px;max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      '.dwnPageTitle{margin:0;font-size:15px;font-weight:600;line-height:1.5}',
      '.dwnPageDesc{margin:2px 0 0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-width:62ch}',
      '.dwnCard{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;color:var(--dsw-alias-label-primary)}',
      '.dwnActions{display:flex;gap:8px;padding-top:2px}',
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

    /** The dictionaries the settings page and the Plugins row render copy from. */
    const en = {
      title: 'Windows notifications',
      description: 'A native Windows toast whenever a conversation needs you — a turn finished, a question was asked, an approval is waiting, or an error came up.',
      nav: 'Windows notifications',
      moved: 'These settings live in Settings → Windows notifications.',
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
      label_waitForSubagents: 'Hold a completion while its subagents are still running',
      hint_waitForSubagents: 'A dispatcher ends its own turn the moment it delegates, so its first idle is not the task being over. While this is on, that notification waits for the session to have no running subagent left — the last idle after the children reported back is what notifies you.',
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
      nav: 'Windows 通知',
      moved: '这些设置已移到「设置 → Windows 通知」。',
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
      label_waitForSubagents: '子智能体还在跑时，先不通知「已完成」',
      hint_waitForSubagents: '调度方派出子智能体后自己这一轮立刻结束，那声「已完成」并不代表任务真的做完了。开着这个开关时，会话名下还有子智能体在跑就先不通知；等子智能体全部回报、调度方真正收尾的那一次空闲才通知你。',
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
     * The fields this page edits, in the order it renders them.
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
      { name: 'waitForSubagents', kind: 'switch' },
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
     * @param {object} handlers - staging callbacks for this page.
     * @param {boolean} locked - whether every control is disabled.
     * @param {Function} t - this page's locale reader.
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
     * Follow one entry's configuration form.
     *
     * The settings shell mounts only the active section and renders it once per
     * panel open, so nothing re-renders this page when the Host answers a write
     * or when another surface edits the same entry — the page subscribes to the
     * form controller itself, which hands out a stable snapshot reference per
     * change. `configForms.get` returns a stable controller per entry, so the
     * effect re-subscribes only if that controller is ever replaced.
     *
     * @param {object | undefined} form - the entry's form controller.
     * @returns {object | undefined} the Host snapshot this page renders from.
     */
    const useFormState = (form) => {
      const [state, setState] = React.useState(() => (form === undefined ? undefined : form.getSnapshot()))
      React.useEffect(() => {
        if (form === undefined) return undefined
        const sync = () => {
          setState(form.getSnapshot())
        }
        sync()
        return form.subscribe(sync)
      }, [form])
      return state
    }

    /**
     * The page's form.
     *
     * It stages edits in its own React state and reads the accepted values from
     * the snapshot the page subscribed to, so what is on screen is always what a
     * save would store.
     *
     * @param {object} props - locale copy, the Host snapshot, and the write.
     * @returns {object} the form.
     */
    function NotifierForm(props) {
      const { t, state, mutate } = props
      const [drafts, setDrafts] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

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
        if (mutate === undefined) return
        setBusy(true)
        setNotice(null)
        Promise.resolve()
          .then(() => mutate(operations, state.revision))
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
        if (mutate === undefined || locked || !dirty || invalid) return
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
      const statusLine = state === undefined || status === 'unavailable'
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
        statusLine,
        noticeLine,
        entries.map((entry) => renderField(entry, handlers, locked, t)),
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
          }, t('discard'))))
    }

    /**
     * This plugin's settings page.
     *
     * The shell renders the sidebar row from the registration's `label` and
     * hands the page only `{ close }` plus its standard hooks — no heading, no
     * title bar — so the page draws its own.
     *
     * @param {object} props - this plugin's locale reader and the entry's form.
     * @returns {object} the page.
     */
    function NotifierSection(props) {
      const { t, form } = props
      const state = useFormState(form)
      const mutate = form === undefined
        ? undefined
        : (operations, revision) => form.mutate(operations, revision)
      return h('div', { className: 'dwnPage' },
        h('div', { className: 'dwnPageHead', key: 'head' },
          h('h3', { className: 'dwnPageTitle' }, t('title')),
          h('p', { className: 'dwnPageDesc' }, t('description'))),
        h(NotifierForm, { key: 'form', t, state, mutate }))
    }

    /**
     * What the Plugins page keeps for this row.
     *
     * The configuration now belongs to the settings page, so the row answers the
     * one-line summary the Plugins list shows above it, and points its own detail
     * view at the page that took the form over instead of rendering it again.
     *
     * @param {object} props - the view asked for (`summary` or `page`) and locale
     * copy.
     * @returns {string | object} the one-liner, or the pointer.
     */
    function NotifierRowNote(props) {
      const { t, view } = props
      if (view === 'summary') return t('description')
      return h('p', { className: 'dwnHint' }, t('moved'))
    }

    /**
     * Required client services: the slot registry, the locale reader, and the
     * configuration forms this row's Host entry is bound to.
     */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Contribute the settings page, and leave the Plugins row pointing at it.
     *
     * Both registrations are kept alive only while the Host serves this row's
     * namespace: the page edits exactly that entry's configuration, so a
     * deployment that never served it has nothing to show and shows no trace of
     * the page. The registration names the dictionary namespace, and the slot
     * machinery hands the component `t`; both components get this plugin's own
     * reader anyway, so their copy never depends on that projection.
     *
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(installStyles, `${NS}: card styles`)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('settings.section', () => {
        const form = ctx.configForms.get(ENTRY_ID)
        return ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('nav'),
          locale: NS,
        }, (props) => h(NotifierSection, { ...props, t, form }))
      })), `${NS}: settings page`)
      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
      }, (props) => h(NotifierRowNote, { ...props, t })))), `${NS}: row summary`)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})