# dsh-windows-notifier

给 DSH（DeepSeek Harness）用的 Windows 原生通知插件：**任何**对话把控制权交还给你的时候，弹一条 Windows 系统通知。

它监听的是整个 DSH 进程的事件，所以**后台正在运行的对话**同样会通知你 —— 你不用一直盯着某个会话窗口。

## 什么时候会通知

| 场景 | 通知标题 | 触发事件 |
| --- | --- | --- |
| 任务完成，可以继续对话 | ✅ 对话已完成 | `agent/status` → `idle` |
| 智能体向你提问（`ask_user_question`） | ❓ 需要你的输入 | `user-questions/request` |
| 有操作等待你批准 | 🔐 需要你批准 | `approval/request` |
| 某一步/某一轮出错 | ❌ 对话出错 | `agent/error` |
| 本轮被中止（可选，默认关） | ⏹️ 本轮已中止 | `agent/status` + `turn/end: aborted` |

通知正文第一行是**对话标题**（取自 DSH 的会话标题，还没生成标题时回退到工作目录名），第二行是状态说明或具体内容（提问内容、工具名、错误信息、运行时长）。

默认**不通知** subagent / workflow 子会话自己一轮跑完的那声「对话已完成」—— 一次后台委派会派生好几个子会话，全部通知会变成弹窗轰炸。**但子会话需要人**的时候照常通知：它向你提问、等你批准、或者出错，都会弹。需要连子会话的「结束」也听，把 `includeSubagents` 打开。

## 工作原理

```
DSH 进程
  └─ host 组合（所有 profile 共用）
       └─ dsh-windows-notifier  ← 这一个插件行
            ├─ ctx.on('internal/dispatch', …)   框架的派发公告（事件名 + 载荷）
            └─ ctx.on('agent/status' | 'user-questions/request' | …)  直接监听（兜底）
                     │
                     └─ 一个短命的 powershell.exe → Windows Toast（WinRT）
```

### 为什么要听两个通道

DSH 的作用域事件（`agent/status`、`user-questions/request`、`approval/request`、`agent/error`）是**带作用域载体**派发的：Cordis 会把「上下文不在该载体作用域链上」的监听器直接丢掉。

这个过滤是真实可观测的：挂在 host 根上下文上的普通监听器能收到 `agent/status`，却**收不到** `user-questions/request` —— 后者以提问的那个 agent 自身作为作用域键，而派发确实发生了，只是监听器被滤掉了（用 `ctx.on('internal/dispatch', …)` 能看到这次 waterfall 派发，但自己的监听器不响）。

所以插件同时观察两条通道：

1. **`internal/dispatch`** —— 框架自己的派发公告。任何非 `internal/` 事件都会在**作用域过滤之前**在这里公布一次，因此用 `{ global: true }` 注册的监听器能看到**所有作用域**的事件。这是「监听任意对话（含后台对话）」唯一可靠的入口（DSH 自己的 scope-invariant 插件也是这么监听的）。
2. **直接监听那四个事件** —— 兜底：万一某个版本不再公布派发流，直接监听仍然生效。

两条通道拿到的是**同一个载荷对象**，因此用一个 `WeakSet` 按对象身份去重：谁先到谁负责通知，另一条通道直接跳过 —— 不需要拍脑袋定一个时间窗。

### 怎么认出一个子会话

DSH 在每个子会话的 durable header 上盖了 `origin: 'subagent'`（连同 `parentSession`、`delegationDepth`），这是**唯一权威**的判据；`includeSubagents` 关着时，只有「一轮结束」这一族（`completed` / `interrupted`）会被它挡下，提问 / 审批 / 出错照旧通知。

判断本身走的是**事件载荷自带的那份会话**：载荷里有 live agent，live agent 上有它自己的 `session`，所以答案跟着事件一起来，不依赖任何服务查询。这一条是要紧的 —— 插件行是补丁层插进来的，可能在发布 `sessions` / `sessionTitle` 的那一行之前就激活，而 `ctx.get()` 在 apply 时取到的 `undefined` 会跟着进程一辈子；只查 `ctx.sessions` 的过滤会**永远不生效**，每个子会话跑完都弹一条「对话已完成」。那两个服务现在也用 `ctx.inject` 采用（和 `settings` 一样），所以会话标题也能正常读到。

另外还会从 `session/created` 的公告里**记下**子会话 id（有上限），作为「连载荷里的 session 都读不到」时的兜底。反过来，读不到会话一律**按用户会话处理**：宁可多弹一条，也不能把主对话吞掉。

其余特性：

- **零依赖**：通知由 `scripts/toast.ps1` 通过 Windows PowerShell 自带的 WinRT `Windows.UI.Notifications` 类型弹出，不需要装 BurntToast、不需要注册 COM、不需要常驻进程。
- **不阻塞任何东西**：所有监听器都只是旁观。追问/审批那条监听器仍会调用 `next()` 把瀑布链传下去，所以正常问答完全不受影响（有测试专门盯着这点）。通知进程异步启动并带并发上限，插件卸载时会杀掉还在跑的进程。
- **点击通知**可以打开 DSH 的 Web GUI（自动读取当前 Web 服务端口，也可用 `launchUrl` 指定）。GUI 目前没有会话级路由，所以只能打开到首页。

## 安装

DSH 的能力全是 `cordis.yml` 里的一行行插件。装一个第三方插件 = **装包** + **加一行**。

### 1. 把包装进 profile

```powershell
# 从 GitHub 装（推荐）
dsh plugin --profile web add https://github.com/ADkun/dsh-windows-notifier.git

# 或者从本地目录装
dsh plugin --profile web add D:\path\to\dsh-windows-notifier
```

> `dsh plugin` 只是把参数转发给 profile 目录里的 pnpm。如果机器上没有 pnpm，可以手动把仓库目录放到 profile 的 `node_modules` 下（见下方「没有 pnpm 时」）。

### 2. 加一行到 profile 的 patch 层

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（Windows 上通常是
`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`）：

```yaml
- insert:
    - id: windows-notifier
      name: 'dsh-windows-notifier'
```

`patchReload: live` 的 profile 会**热加载**这个改动，不用重启。

### 对所有 profile 生效

`$DSH_HOME/cordis.patch.yml`（即 `C:\Users\<你>\.dsh\cordis.patch.yml`）是**机器级**的 patch 层，在每个 profile 自己的 patch 之后应用。想一次管住所有 profile（web、headless、sdk…），就写在这里：

```yaml
- insert:
    - id: windows-notifier
      name: 'dsh-windows-notifier'
      config:
        includeSubagents: false
```

这样每个 profile 启动时都会挂载它。如果某个 profile 里没有 pnpm 装的包，需要保证包能被解析到 —— 最省事的做法是把它放进 profile 目录的公共 `node_modules`（`$DSH_HOME/profiles/node_modules/`），Node 的解析会从每个 profile 目录向上找到它。

完整示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

### 没有 pnpm 时

把仓库以目录联接（或直接复制）的方式放进公共模块目录即可：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-windows-notifier" `
  -Target "D:\path\to\dsh-windows-notifier"
```

插件本身零依赖、零构建，所以不需要 `npm install` / `pnpm install`。

### 改配置 vs 改源码：热加载的边界

- **改 patch 文件**（开关、`logFile`、`launchUrl`…）→ `patchReload: live` 会立刻重挂载，马上生效。
- **改界面里的设置**（设置 → 插件 → 插件配置）→ 立刻生效，见下面「界面化配置」。
- **改插件源码** → **不会**立即生效。DSH 的 loader 按「模块解析后的路径」缓存 ESM 模块，并且在插件行的 `name` 没变时复用已经加载过的那个模块；同一个文件路径改内容也不会重新导入。要让新代码生效，要么重启对应 profile，要么把包放到一个**新路径**（换个目录、或复制一份到别处）再让行指向它。
  浏览器半侧同理，而且更严格：客户端模块图按「解析后的说明符」缓存包元数据（包括"没有浏览器半侧"的否定结论），所以连"换个新路径的插件行"这条路也不通（实测：改成子路径说明符后这一行会导入失败），**只能重启一次**。

> 上面「目录联接」的写法适合开发：联接指向仓库时，增删**文件**（路径变化）就能被重新导入，改同一个文件则不行。

## 配置项

全部可省略，省略即用默认值。

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 时插件不做任何事 |
| `notifyOnActivate` | boolean | `false` | 激活时先弹一条「已启用」，用来确认通道正常 |
| `includeSubagents` | boolean | `false` | 是否也通知 subagent / workflow 子会话**自己一轮结束**；子会话的提问 / 审批 / 出错始终通知 |
| `notifyOnComplete` | boolean | `true` | 任务完成（`idle`）时通知 |
| `notifyOnQuestion` | boolean | `true` | 智能体提问时通知 |
| `notifyOnApproval` | boolean | `true` | 等待批准时通知 |
| `notifyOnError` | boolean | `true` | 出错时通知 |
| `notifyOnInterrupted` | boolean | `false` | 本轮被中止时通知 |
| `minTaskDurationMs` | number | `0` | 短于该时长的任务不通知（避免零星小任务刷屏），例如 `5000` |
| `sound` | `default` \| `silent` | `default` | 是否播放通知音 |
| `disappearAfterMs` | number | `6000` | 通知停留时长（毫秒）；`0` = 一直留在屏幕上，直到你手动关掉 |
| `openOnClick` | boolean | `true` | 点击通知时打开 DSH Web 界面；`false` 让通知不可点击 |
| `appId` | string | Windows PowerShell 的 AUMID | 通知归属的应用标识；换成你注册过的 AUMID 就能改显示名 |
| `powershellPath` | string | 自动探测 | 指定 `powershell.exe` 路径（必须是 Windows PowerShell 5.1，`pwsh` 7 不支持 WinRT） |
| `scriptPath` | string | 包内 `scripts/toast.ps1` | 指定自定义通知脚本 |
| `launchUrl` | string | 空（自动取当前 Web GUI 地址） | 点击通知打开的地址；支持 `{sessionId}` 占位符 |
| `logFile` | string | 空 | 追加调试日志到文件，排查用 |
| `maxConcurrent` | number | `1` | 同时运行的 powershell 进程上限 |
| `timeoutMs` | number | `15000` | 单个通知进程的超时时间 |

> **「停留时长」能做的事，受 Windows 自己限制。** 横幅时长只有「约 5 秒 / 约 25 秒」两档，插件只能按 `disappearAfterMs` 选最近的一档（> 7000 用长档）；这个值同时通过 `ExpirationTime` 决定它**在通知中心里保留多久**，所以写 3000 并不会让横幅 3 秒就走。要让通知「无限等待」，用 `0`：插件会带上 `scenario="reminder"`，通知就一直留在屏幕上直到你手动关闭——这是 Windows 上唯一能做到这件事的方式。

## 界面化配置

插件注册了一个 settings 命名空间 `dsh-windows-notifier`，并在 Web 界面的 **设置 → 插件 → 插件配置** 里贡献一张卡片。常用的开关都在卡片上：总开关、五类通知开关、停留时长、是否跳转、通知音、忽略短任务、点击地址。

- 卡片里保存的值写进 `$DSH_HOME/settings.yaml`，**优先级高于** patch 里的 `config:`；卡片上的「重置」让该字段重新继承 patch 的值。
- 保存后**立刻生效**，不用重启：`enabled` 关掉会真的把监听摘掉，重新打开再挂回去。
- 卡片是插件的**浏览器半侧**（`src/client.js`），按 DSH 的 lazy-CJS 客户端模块格式手写，所以仓库仍然零构建。注册命名空间需要 `@deepseek-ai/schemastery`（harness 自带）；环境里没有它时插件照常工作，只是没有这张卡片。
- 装好后**需要重启一次 DSH** 卡片才会出现：客户端模块图按「解析后的说明符」缓存包元数据，其中也包括"这个包没有浏览器半侧"这个结论，所以新声明的浏览器半侧要等下一次启动才进入引导图。

## 验证

先单独验证 Windows 侧通道：

```powershell
node scripts/send-test-toast.mjs
node scripts/send-test-toast.mjs "自定义标题" "自定义正文"
```

看到通知就说明通道没问题，剩下的只是让 DSH 把事件交给插件。

再验证插件本身：在配置里加 `notifyOnActivate: true`（或 `logFile: D:\dsn.log`），保存 patch 文件触发热加载，应该立刻弹出一条「已启用」通知 / 日志里出现 `[dsh-windows-notifier] active`。

`logFile` 会记录**每一次决定**，包括每一次"没通知"的原因，例如：

```
notify complete: ✅ 对话已完成 / 重构支付模块 | 已运行 2 分 13 秒，可以继续对话了。 -> http://127.0.0.1:3080
skip complete for cccc1111-child-0001: subagent turn end (includeSubagents is off)
skip complete for session-…: attached session has no settled turn
session … is not attached; reporting completion without a turn outcome
skip question: switch off
```

「为什么没弹」基本都能在这几行里找到答案。

## 卸载

1. 从 patch 文件里删掉那一行（或加 `disabled: true`）；
2. `dsh plugin --profile web remove dsh-windows-notifier`（手动放的目录直接删掉）；
3. 顺手可以删掉 `$DSH_HOME/settings.yaml` 里残留的 `dsh-windows-notifier:` 分节（不删也无害，它只是没人读）。

## 已知限制

- **仅 Windows**：非 Windows 平台插件会安静地跳过，不会报错。
- **专注助手（Focus Assist）/「请勿打扰」会拦掉通知**：这是系统行为，插件无法绕过。
- **通知显示的应用名是「Windows PowerShell」**：因为用的是它现成的 AUMID，好处是零安装。想改成自己的名字，需要注册一个带 `AppUserModelID` 的开始菜单快捷方式，然后把 `appId` 指过去。
- **每条通知会短暂启动一个 `powershell.exe`**（约 0.3–1 秒）。对「一轮任务结束」这种频率完全够用；这也是它不需要任何依赖的代价。
- **必须在有 DSH 事件的前提下工作**：headless / sdk 这类最小 profile 如果不发这些事件，插件会挂载但不产生通知。headless 收尾时会话可能已经 detach，这种情况下插件仍按「完成」通知（`idle` 只会在状态变化时发布，所以它本身就意味着有东西跑完过）。
- **点击通知只能打开 GUI 首页**：DSH 的 Web GUI 把会话选择放在内存里，没有会话级路由，所以没有可深链的地址。`launchUrl` 里写 `{sessionId}` 会被替换，但目标页面目前不消费它。不想要这个跳转就把 `openOnClick` 关掉（patch 或界面里都行）。
- **横幅时长只有两档**：见上面配置项下的说明；`0` 是唯一能"无限等待"的值（`scenario="reminder"`）。
- **界面卡片的文案只有中文**：插件没有注册 locale 词典，卡片上的文案是写死的（用户是中文用户，README 也是中文优先）。要双语的话得再注册一个 locale 命名空间。
- 通知不做「用户是否正在看这个会话」的判断 —— 前台会话结束同样会弹。

## 开发

```powershell
node --test test        # 60 项测试：消息文案、配置归一化、事件接线、双通道去重、
                        # 子会话识别（载荷自带 session / 创建公告兜底）、settings 命名空间与实时改配置、
                        # 浏览器半侧的卡片契约与暂存/保存
```

仓库结构：

```
src/plugin.js      插件本体：观察派发流 + 直接监听，决定要不要通知，并跟随界面设置
src/messages.js    纯函数：会话分类、文案、时长格式化
src/config.js      配置归一化（任何脏值都回退到默认值，不炸 profile）
src/settings.js    settings 命名空间：卡片能改哪些选项、默认值、组合层 base
src/client.js      浏览器半侧：手写的 lazy-CJS bundle，注册「插件配置」里的卡片
src/notify.js      Windows Toast 传输层：队列 + powershell 进程生命周期
scripts/toast.ps1  WinRT 弹窗脚本（纯 ASCII，中文通过参数以 UTF-16 传入）
scripts/send-test-toast.mjs  手动验证通道
```

## English

`dsh-windows-notifier` is a zero-build DSH plugin that raises a native Windows toast whenever
**any** conversation in the process hands control back to you: a turn finished, the agent asked a
question, an approval is pending, or a step errored. A subagent or workflow child's *own* turn end
is filtered out by default (set `includeSubagents: true` to hear it too); a child that asks a
question, blocks on approval, or errors is still reported, because the user is the one who has to
answer it. It depends on nothing you have to install: the Windows side is Windows
PowerShell's built-in WinRT `Windows.UI.Notifications`, and the settings schema comes from the
harness's own `@deepseek-ai/schemastery`.

A child is recognised from `origin: 'subagent'` in the session header DSH stamps on it — read from
the session the *event payload itself* carries (`payload.agent.session`), never from a service
lookup that a patch-inserted row may have sampled before that service existed.

Its common switches are editable at **Settings → Plugins → Plugin configuration**, which writes to
`$DSH_HOME/settings.yaml` and applies live — including the notification lifetime (`0` means "stay
until dismissed") and whether a click opens the Web GUI. That card is the plugin's browser half,
hand-written in DSH's lazy-CJS client-module format, so this repository still needs no build step.
Note that a browser half only enters the web boot graph at startup: the client module graph caches
per-package metadata per resolved specifier, so **restart DSH once** after installing.

DSH dispatches those events through a *scope carrier*, and Cordis drops listeners whose context
is outside the carrier's scope chain — a plain root-context listener sees `agent/status` but never
`user-questions/request`. The plugin therefore observes two channels: `internal/dispatch`, the
framework's own pre-filter dispatch announcement (which reaches every scope), plus direct
listeners as a fallback. Both carry the same payload object, so a `WeakSet` de-duplicates them by
identity. Toasts go through Windows PowerShell's built-in WinRT `Windows.UI.Notifications` types,
so nothing has to be installed, and a click opens the Web GUI.

Add the package to a profile and insert one row into the profile's `cordis.patch.yml` (or the
machine-wide `$DSH_HOME/cordis.patch.yml` to cover every profile):

```yaml
- insert:
    - id: windows-notifier
      name: 'dsh-windows-notifier'
```

## License

MIT