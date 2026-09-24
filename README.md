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

默认**不通知** subagent / workflow 产生的内部子会话 —— 一次后台委派会派生好几个子会话，全部通知会变成弹窗轰炸。需要的话把 `includeSubagents` 打开。

## 工作原理

```
DSH 进程
  └─ host 组合（所有 profile 共用）
       └─ dsh-windows-notifier  ← 这一个插件行
            ├─ ctx.on('agent/status', …)          所有会话的 running ⇄ idle
            ├─ ctx.on('user-questions/request', …) 所有会话的提问
            ├─ ctx.on('approval/request', …)       所有会话的审批
            └─ ctx.on('agent/error', …)            所有会话的错误
                     │
                     └─ 一个短命的 powershell.exe → Windows Toast（WinRT）
```

- **所有对话都能收到**：DSH 的事件按 scope 路由，同时把「未打作用域标签」的监听器视为全局监听器。这个插件挂在 host 根上下文，所以每个会话（含后台会话）的事件都会到达它。
- **零依赖**：通知由 `scripts/toast.ps1` 通过 Windows PowerShell 自带的 WinRT `Windows.UI.Notifications` 类型弹出，不需要装 BurntToast、不需要注册 COM、不需要常驻进程。
- **不阻塞任何东西**：四个监听器都只是旁观。通知进程异步启动，并带并发上限；插件卸载时会杀掉还在跑的进程。

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

## 配置项

全部可省略，省略即用默认值。

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 时插件不做任何事 |
| `notifyOnActivate` | boolean | `false` | 激活时先弹一条「已启用」，用来确认通道正常 |
| `includeSubagents` | boolean | `false` | 是否也通知 subagent / workflow 子会话 |
| `notifyOnComplete` | boolean | `true` | 任务完成（`idle`）时通知 |
| `notifyOnQuestion` | boolean | `true` | 智能体提问时通知 |
| `notifyOnApproval` | boolean | `true` | 等待批准时通知 |
| `notifyOnError` | boolean | `true` | 出错时通知 |
| `notifyOnInterrupted` | boolean | `false` | 本轮被中止时通知 |
| `minTaskDurationMs` | number | `0` | 短于该时长的任务不通知（避免零星小任务刷屏），例如 `5000` |
| `sound` | `default` \| `silent` | `default` | 是否播放通知音 |
| `duration` | `short` \| `long` | `short` | 通知停留时长（约 5 秒 / 25 秒） |
| `appId` | string | Windows PowerShell 的 AUMID | 通知归属的应用标识；换成你注册过的 AUMID 就能改显示名 |
| `powershellPath` | string | 自动探测 | 指定 `powershell.exe` 路径（必须是 Windows PowerShell 5.1，`pwsh` 7 不支持 WinRT） |
| `scriptPath` | string | 包内 `scripts/toast.ps1` | 指定自定义通知脚本 |
| `logFile` | string | 空 | 追加调试日志到文件，排查用 |
| `maxConcurrent` | number | `1` | 同时运行的 powershell 进程上限 |
| `timeoutMs` | number | `15000` | 单个通知进程的超时时间 |

## 验证

先单独验证 Windows 侧通道：

```powershell
node scripts/send-test-toast.mjs
node scripts/send-test-toast.mjs "自定义标题" "自定义正文"
```

看到通知就说明通道没问题，剩下的只是让 DSH 把事件交给插件。

再验证插件本身：在配置里加 `notifyOnActivate: true`（或 `logFile: D:\dsn.log`），保存 patch 文件触发热加载，应该立刻弹出一条「已启用」通知 / 日志里出现 `[dsh-windows-notifier] active`。

## 卸载

1. 从 patch 文件里删掉那一行（或加 `disabled: true`）；
2. `dsh plugin --profile web remove dsh-windows-notifier`（手动放的目录直接删掉）。

## 已知限制

- **仅 Windows**：非 Windows 平台插件会安静地跳过，不会报错。
- **专注助手（Focus Assist）/「请勿打扰」会拦掉通知**：这是系统行为，插件无法绕过。
- **通知显示的应用名是「Windows PowerShell」**：因为用的是它现成的 AUMID，好处是零安装。想改成自己的名字，需要注册一个带 `AppUserModelID` 的开始菜单快捷方式，然后把 `appId` 指过去。
- **每条通知会短暂启动一个 `powershell.exe`**（约 0.3–1 秒）。对「一轮任务结束」这种频率完全够用；这也是它不需要任何依赖的代价。
- **必须在有 DSH 事件的前提下工作**：headless / sdk 这类最小 profile 如果不发这些事件，插件会挂载但不产生通知。
- 通知不做「用户是否正在看这个会话」的判断 —— 前台会话结束同样会弹。

## 开发

```powershell
node --test test        # 22 项测试，覆盖消息文案、配置归一化、事件接线
```

仓库结构：

```
src/index.js       插件本体：监听四个 host 事件，决定要不要通知
src/messages.js    纯函数：会话过滤、文案、时长格式化
src/config.js      配置归一化（任何脏值都回退到默认值，不炸 profile）
src/notify.js      Windows Toast 传输层：队列 + powershell 进程生命周期
scripts/toast.ps1  WinRT 弹窗脚本（纯 ASCII，中文通过参数以 UTF-16 传入）
scripts/send-test-toast.mjs  手动验证通道
```

## English

`dsh-windows-notifier` is a zero-dependency, zero-build DSH host plugin that raises a native
Windows toast whenever **any** conversation in the process hands control back to you: a turn
finished, the agent asked a question, an approval is pending, or a step errored. It listens on
the host root context, so background sessions notify too, while subagent/workflow child sessions
are filtered out by default. Toasts go through Windows PowerShell's built-in WinRT
`Windows.UI.Notifications` types, so nothing has to be installed.

Add the package to a profile and insert one row into the profile's `cordis.patch.yml` (or the
machine-wide `$DSH_HOME/cordis.patch.yml` to cover every profile):

```yaml
- insert:
    - id: windows-notifier
      name: 'dsh-windows-notifier'
```

## License

MIT