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

**后台委派的调度方不会误报「已完成」。** Adg 这类多智能体模式里，调度代理一派出子代理就立刻结束自己这一轮 —— 于是那声「对话已完成」会在子代理还在跑的时候到达。`waitForSubagents`（默认开）让它先看一眼：该会话名下还有没有在跑的子代理（`origin: 'subagent'` 的子孙，任意深度；fork 不算，它不是委派）。只要还有，通知就先按下去，日志写 `skip complete for <会话>: N delegated subagent(s) still running`。子代理结算会唤醒调度方，等它真正跑完最后一轮、名下再没有在跑的子代理时，那条通知才补上 —— 没丢通知，只是延后到任务真的收尾。被中止（`⏹️ 本轮已中止`）不受这条闸门影响：它说的是这一轮被停了，什么时候都成立。

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

DSH 的能力全是 `cordis.yml` 里的一行行插件。装一个第三方插件 = **装包**（+ 让它在 profile 里被选中）。从 0.2.0 起这个包自己带一层 bundle patch，所以「加一行」这一步由 DSH 自己做，见下面第 2 步。

装包这一步的落点由本版 DSH 定死：插件包只能从 **Desktop 安装目录**和**当前 profile 自己的 `node_modules`** 解析出来。旧文档里那个"所有 profile 共享的解析根"已被判过时（错误原文、源码位置与本机量法见「把所有 profile 一次装完」）。

### 1. 把包装进 profile

```powershell
# 从本仓库装：默认装进每一个有 package.json 的 profile
powershell -NoProfile -File scripts\sync-to-profile.ps1

# 只装一个 profile
powershell -NoProfile -File scripts\sync-to-profile.ps1 -Profile web
```

（`pwsh -File …` 等价，只要装了 PowerShell 7；`powershell` 是 Windows 自带的那一个，一定能跑。）

这个脚本真正做了什么：

1. `npm pack` 把仓库打成 `dist\dsh-windows-notifier-<版本>.tgz`，内容由 `package.json` 的 `files` 字段决定（与 npm 发布一致；`dist\` 不进版本库）。本机实测（2026-09-28，`npm pack --dry-run --json`，0.2.0）：打进包的条目是 `package.json`、`cordis.patch.yml`、`src\*.js`、`scripts\toast.ps1`、`scripts\send-test-toast.mjs`、`scripts\sync-to-profile.ps1`、`examples\cordis.patch.yml`、`README.md`、`LICENSE` —— `test\` 不在其中；
2. 对每个目标 profile 执行 `dsh plugin --profile <profile> add "file:<tgz 的绝对路径>"` —— 与 Desktop「插件市场」走同一条路：往该 profile 的 `package.json` 加一条依赖，并在 profile 目录里运行 pnpm（`dsh plugin` 把参数原样转发给这个 pnpm，所以任何 pnpm 认的 spec 都能传）。包落在 `$DSH_HOME\profiles\<profile>\node_modules\dsh-windows-notifier`，是**真目录**（本机实测 2026-09-28：`profiles\web` 下装出来的那份 `LinkType` 为空，profile 的依赖记成 `file:D:/dsh/dsh-windows-notifier/dist/dsh-windows-notifier-0.2.0.tgz`）；
3. 已经是该 profile 依赖的包会先 `remove` 再 `add`（原因见「改完源码怎么让它进环境」）；
4. **`desktop` profile 会被跳过**：`dsh` 对它的每一条 `plugin` 子命令都直接拒绝（原文 `error: profile "desktop" is managed exclusively by the Electron application`，源码是 `@deepseek-ai/dsh/lib/bin.js` 里的 `rejectElectronProfile`）。它归 Desktop 应用管，请在应用里的插件市场升级（那边做的是同一套安装 + 选中）；
5. `-DshHome` 指 DSH 用户根（默认 `$env:DSH_HOME`，再退到 `$HOME\.dsh`），`-Dsh` 指 `dsh` 命令；
6. 每个 profile 装完后核对它自己的 `dsh.profile.bundles` 里确实有 `dsh-windows-notifier`，缺了就补上（原因见下一条），并在这份机器级 patch 里发现本插件的行时给出警告（原因见「别把这一行放回机器级」）。

**装包 ≠ 选中。** `dsh plugin add` 转发给 pnpm 之后，CLI 还会做一次「已安装的 bundle 声明对账」：清单里声明了 `dsh.bundle` 的依赖会被补进 `dsh.profile.bundles`（`@deepseek-ai/dsh-app-boot` 的 `reconcileProfilePlugins`）。本机实测 2026-09-28：这次写在命令返回之后才落盘 —— 装完立刻读 `package.json` 有可能读到还没补上的那一刻，所以脚本自己再核对一遍、缺了就写。**只是依赖、没被选中 = 没有行、没有配置页**，这是最容易「装好了却什么都没发生」的地方。

**为什么是 tarball，而不是把仓库目录链接进去：** 解析器只从两个根解析，其中 profile 侧要求解析到的清单路径落在该 profile 自己的 `node_modules` 之内 —— 共享父级一律不行；tarball 展开成的真目录正是市场安装的形状（源码级：DSH 把 profile 的 `pnpm-workspace.yaml` 固化成 `nodeLinker: hoisted`，所以 pnpm 把依赖铺成真目录，而不是 `.pnpm` 下的链接）。另外，pnpm 的 `link:` 装法（`dsh plugin add <本地目录>` 用的就是它）只链接一个目录，**不安装该包自己的依赖**，也不像市场安装那样把包记进依赖；它还省不掉重启：模块缓存的键是解析后的**真实路径**，链接最终仍指向仓库里那份文件，改它不会重新导入（源码级：解析器用 `realpathSync` 规整缓存键）。

从 GitHub 装是另一条合法路径，但**本次未实测** —— `dsh plugin` 的后端是 pnpm，git 托管的 spec 由 pnpm 处理，DSH 的 CLI 对 `git+…` / `github:…` / `.git` 结尾的 spec 另有专门提示。形式例如：

```powershell
dsh plugin --profile web add github:ADkun/dsh-windows-notifier
```

量法：在一台没装过它的机器上跑这条命令，确认 profile 的 `package.json` 里出现该依赖、`(Get-Item $DSH_HOME\profiles\<profile>\node_modules\dsh-windows-notifier).LinkType` 为空（真目录），重启后宿主日志里没有 `failed to import`。这条路同样只服务你指定的那一个 profile。

> `dsh` 从 PATH 上找 `pnpm`，找不到就打印 `dsh: pnpm was not found; install pnpm and make it available on PATH.`；Desktop 自带一份并把它放上 PATH（见「没有 pnpm 时」）。`--profile desktop` 一律不行 —— 见上面第 4 条。

### 2. bundle 会自己带来那一行

从 0.2.0 起这个包声明了自己的一层 bundle patch（`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`）—— 这层带来的是**行本身**，所以 profile 里不用再手写那一行，只要把包**选中**（`dsh.profile.bundles` 里有它）。第 1 步的 `dsh plugin … add` 之后 CLI 会对账并补上这条选中（落盘可能晚一拍，脚本会自己核对、缺了就写）：

```yaml
# 包自带的 cordis.patch.yml（bundle 层）
- insert:
    - id: windows-notifier
      name: 'dsh-windows-notifier'
```

这层带来的是**行本身**（上面那段就来自包里的 `cordis.patch.yml`）。`id` 是 `windows-notifier`，而它就是配置表格的地址：DSH 给每个已挂载的 profile 条目生成一份「Host 侧可校验的配置描述」，浏览器里的配置卡片按 `<包名>#<行 id>` 注册到「插件」页的那一行上。改这个 id，两侧都得跟着改。

行里**故意没有 `config:`** —— 每个开关都有 schema 默认值（见 `src/settings.js`），新装一个 profile 不需要写任何值。

**per-profile 的值写在该 profile 自己的 patch 文件里**，也就是界面保存时写的那一份：

```yaml
# $DSH_HOME\profiles\<profile>\cordis.patch.yml
- id: windows-notifier
  name: 'dsh-windows-notifier'
  config:
    logFile: 'D:\dsh\dsh-windows-notifier\.dsh-windows-notifier.log'
```

`patchReload: live` 的 profile 会**热加载** `config:` 改动，不用重启；但**换掉 `src/` 里的代码必须重启**（模块缓存按解析后的真实路径做键，不会重新 import）。

> **别把这一行放回机器级 `$DSH_HOME\cordis.patch.yml`。** 两层原因：patch 命中一个已存在的 id 时是**整体替换**它的 `config` 对象（`dsh-app-boot` 的 `applyEntryPatches` 写的是 `target.config = value`），而机器级在每个 profile 之后应用 —— 界面上保存的值会被它悄悄盖掉；并且 Host 会直接拒绝这次保存，原文是 `Configuration for "<id>" is overridden by a home patch or command-line overlay`。症状是配置页能看、不能存。（2026-09-28 迁移时本机就是这么放的，那一行已删。）

### 把所有 profile 一次装完

机器级 `$DSH_HOME/cordis.patch.yml`（即 `C:\Users\<你>\.dsh\cordis.patch.yml`）仍然是「在每个 profile 自己的 patch 之后应用」的那一层，但**不再放这个插件的行**。要一次装到所有 profile，就是让脚本对每个 profile 各跑一次 `dsh plugin … add`，并让每个 profile 各自选中自己的 bundle：

```powershell
powershell -NoProfile -File scripts\sync-to-profile.ps1
```

**选中 ≠ 包能解析**：行由 bundle 层带来，包仍必须能从**每个** profile 自己的 `node_modules` 解析到，所以脚本不带参数时默认装进每一个有 `package.json` 的 profile（`desktop` 除外，见第 4 条），并在装完后逐个核对 `dsh.profile.bundles` 里确实有它（只是依赖、没被选中 = 没有行、没有配置页）。以后新建了 profile，要再跑一次脚本。

`pwsh`（PowerShell 7）不是 Windows 自带的；脚本用任意一个都能跑，上面写 `powershell` 是因为它一定在。

> **历史（已失效）：共享解析根。** 旧文档把这包装复制（或建目录联接）到 `$DSH_HOME\profiles\node_modules`，称它是"每个 profile 共享的解析根，Node 从 profile 目录向上上溯就能找到它"。本版 Desktop 反过来把这个共享父级当成**过时落点**：
>
> - 源码级：解析器只在 Desktop 安装目录与当前 profile 之间二选一（构造错误在 Desktop 安装目录的 `resources\app\lib\package-overlay-*.js`），并且要求 profile 侧解析到的清单路径落在 `<profileDir>\node_modules` 之内；共享父级在解析器的源码里就叫 `sharedFallbackDirectory`，落在里面的解析结果被判过时（`isObsoleteProfileFallback*`，见 `lib\module-resolution-*.js`）。
> - 本机实测（2026-09-27）：把包装进 `$DSH_HOME\profiles\node_modules` 时，解析直接失败，原文是 `dsh-plugin-desktop: cannot resolve package "dsh-windows-notifier" from the Desktop installation or active Profile`；同时宿主日志长期出现 loader 告警 `2026-09-27 15:01:53.779 [W] [hmr] windows-notifier (dsh-windows-notifier): failed to import` —— 机器级 patch 那一行在每个 profile 上都生效，而包躺在被拒绝的那个根里。那个旧目录到今天仍在（`scripts/sync-to-profile.ps1` 只报告、不删）。

完整示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

### 没有 pnpm 时

`dsh plugin --profile … add` 的底层是 pnpm，并且**要求 `pnpm` 在 PATH 上** —— 找不到时它会打印 `dsh: pnpm was not found; install pnpm and make it available on PATH.`。Desktop 自带一份并把它放上 PATH（本机实测：`Get-Command pnpm` 命中 `%APPDATA%\DSH Desktop\runtime-commands\…\bin\pnpm.cmd`），所以在 DSH 会话里通常不用管。

确实没有 pnpm 时，可行的手工路线只有一条：**在别处 `npm pack` 出 tarball，再把里面的 `package\` 展开成该 profile 自己的 `node_modules` 目录**（真目录）：

```powershell
$tgz = npm pack D:\path\to\dsh-windows-notifier --pack-destination $env:TEMP   # 打印出 tarball 文件名
tar -xzf "$env:TEMP\$tgz" -C $env:TEMP
$dest = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-windows-notifier"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force "$env:TEMP\package\*" $dest
```

**未实测**：这条路本次没有走。量法：删掉某个 profile 里已经装好的包（连目录一起删），按上面展开，重启 DSH，然后看宿主日志有没有 `failed to import`，以及（开着 `notifyOnActivate: true` 或 `logFile` 时）插件有没有写激活记录。注意手工展开**不会**给 profile 的 `package.json` 加依赖条目，`dsh plugin … remove` 也管不到它 —— 卸载要自己删目录。

插件本身零依赖、零构建，所以不需要 `npm install` / `pnpm install`。

### 改完源码怎么让它进环境

改完仓库里的源码，重跑一次脚本，然后**重启 DSH**：

```powershell
powershell -NoProfile -File scripts\sync-to-profile.ps1
```

脚本内部是**先 `remove` 再 `add`**，而不是直接 `add`：pnpm 对"路径和版本都没变、只有内容变了"的本地 tarball 会判成 `Already up to date` 而不重装（本机实测 2026-09-27：直接 `add` 打印 `Already up to date`，profile 里那份的 SHA256 一个字节没变；`remove` 后 `add` 才真的替换）。这正是"改了源码重跑脚本"能进到环境里的原因。版本号不必每次 bump —— `remove`/`add` 已经处理了内容变化。

重启也不是可选项：loader 按解析到的路径缓存 ES module，被替换的文件不会被重新 import（详见下一节）。现在也**没有"复制式部署的副本"这回事了**：包由 tarball 展开进 profile，改源码得到的是**一份新 tarball**（路径相同、版本号可能相同，内容不同）—— 所以旧文档那句"副本不会自己更新"，现在读作"环境里那份不会自己更新，只能重跑脚本 + 重启"。值得补一句：它同样**不会提示你已经旧了**，那正是"仓库里修好了、环境里照旧"这类问题的成因。

### 改配置 vs 改源码：热加载的边界

- **改 patch 文件**（开关、`logFile`、`launchUrl`…）→ `patchReload: live` 会立刻重挂载，马上生效。
- **改界面里的设置**（设置 → 插件 → 本插件那一行的「配置」）→ 立刻生效，写的是该 profile 自己的 patch 文件，见下面「界面化配置」。
- **改插件源码** → **不会**立即生效。要重跑一遍 `powershell -NoProfile -File scripts\sync-to-profile.ps1`（把新 tarball 装进每个 profile）**再重启 DSH**。DSH 的 loader 按「模块解析后的路径」缓存 ESM 模块，并且在插件行的 `name` 没变时复用已经加载过的那个模块；同一个文件路径改内容也不会重新导入。旧文档曾说"换个新路径（换个目录、或复制一份到别处）再让行指向它"就能生效 —— 在本版里这条也不可靠，而且得先把包解析到 profile 的 `node_modules` 里才谈得上换路径。
  浏览器半侧同理，而且更严格：客户端模块图按「解析后的说明符」缓存包元数据（包括"没有浏览器半侧"的否定结论），所以连"换个新路径的插件行"这条路也不通（实测：改成子路径说明符后这一行会导入失败），**只能重启一次**。

> **历史（已失效）：用目录联接指向仓库来"热改"。** 旧文档说"联接指向仓库时，增删**文件**（路径变化）就能被重新导入，改同一个文件则不行"。本版不成立：(1) 联接到共享根 `$DSH_HOME\profiles\node_modules` 的那条路已被解析器拒绝（见「把所有 profile 一次装完」）；(2) 模块缓存的键是解析后的**真实路径**，联接最终仍指向仓库里那份文件，增删/改文件都不会改变这个键，因此什么都不会重新导入。要改源码生效，只有"重跑脚本 + 重启"。（本次对解析器函数单独做过一次探针：把联接放在**某个 profile 自己的** `node_modules\<name>` 下会被它接受；但这条没有在真实启动里验证，不作为做法推荐。）

## 配置项

全部可省略，省略即用默认值。

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 时插件不做任何事 |
| `notifyOnActivate` | boolean | `false` | 激活时先弹一条「已启用」，用来确认通道正常 |
| `includeSubagents` | boolean | `false` | 是否也通知 subagent / workflow 子会话**自己一轮结束**；子会话的提问 / 审批 / 出错始终通知 |
| `waitForSubagents` | boolean | `true` | 会话名下还有子代理在跑时先不弹「对话已完成」，等它真正收尾再弹（挡住调度方一派出子代理就误报完成） |
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

**哪些键能在界面里改：** 上表 20 个键里只有 15 个是「运行时真的会重读」的，也就是**可以在 设置 → 插件 → 本插件那一行的配置 里改**：`enabled`、`notifyOnComplete`、`notifyOnQuestion`、`notifyOnApproval`、`notifyOnError`、`notifyOnInterrupted`、`notifyOnActivate`、`includeSubagents`、`waitForSubagents`、`minTaskDurationMs`、`sound`、`disappearAfterMs`、`openOnClick`、`launchUrl`、`logFile`。剩下 5 个是安装期的固定设施（`appId`、`powershellPath`、`scriptPath`、`maxConcurrent`、`timeoutMs`），只能在 patch 里写 —— Host 会拒绝界面对它们的写入。分界线就在 `src/settings.js`：标了 `.volatile()` 的是前者。

## 界面化配置

Web 界面的 **设置 → 插件** 里，本插件那一行会带一个配置页（卡片上是上面那 15 个可热改的键）。这套模型是 DSH 0.1.7 之后的样子，和旧版完全不同：

- **没有"插件注册的 settings 命名空间"这回事了。** Host 给每个已挂载的 profile 条目生成一份配置描述（`@deepseek-ai/dsh-settings` 的 `describe()`，地址就是**条目自己的 id**），浏览器侧的 `configForms` 服务把它镜像出来，卡片按 `<包名>#<行 id>` —— 这里是 `dsh-windows-notifier#windows-notifier` —— 注册到那一行上。id 变了，卡片就找不到行。
- **保存写的是该 profile 自己的 patch 文件**（`$DSH_HOME\profiles\<profile>\cordis.patch.yml`），不再是 `$DSH_HOME/settings.yaml`。一次保存 = 一次原子的、带 revision 栅栏的文档改动，Host 用行自己的 schema 重新校验；卡片上的「恢复默认」发一条 `unset`，让该字段重新继承 bundle 层的默认值。
- **只允许写 `.volatile()` 字段**：`src/settings.js` 里标了 `.volatile()` 的 15 个就是全部可写路径，写别的 Host 直接拒。字段被机器级 patch 或命令行 overlay 盖住时也会拒，原文 `Configuration for "<id>" is overridden by a home patch or command-line overlay`。
- **保存后立刻生效，不用重启。** 卡片改的是 `.volatile()` 引用，loader 就地改写它，宿主半侧每次做判断前都重读一遍 —— 包括总开关：关掉后不再有任何通知，但监听不摘，`enabled` 重新打开就立刻恢复（不再有"摘了挂不回来"的问题）。
- 卡片是插件的**浏览器半侧**（`src/client.js`），按 DSH 的 lazy-CJS 客户端模块格式手写，所以仓库仍然零构建；界面文案走 Client 的 locale 服务（`zh` / `en` 两本词典）。
- 行自己的 schema 需要 `@deepseek-ai/schemastery`（harness 自带）。环境里没有它时插件照常工作，只是**没有配置表格**（也就没有卡片）。
- 装好后**需要重启一次 DSH** 卡片才会出现：客户端模块图按「解析后的说明符」缓存包元数据，其中也包括"这个包没有浏览器半侧"这个结论，所以新声明的浏览器半侧要等下一次启动才进入引导图。

## 验证

先单独验证 Windows 侧通道：

```powershell
node scripts/send-test-toast.mjs
node scripts/send-test-toast.mjs "自定义标题" "自定义正文"
```

看到通知就说明通道没问题，剩下的只是让 DSH 把事件交给插件。

再验证插件本身：把 `notifyOnActivate` 打开（界面卡片里或 patch 里都行），然后保存 / 重启一次 —— 应该立刻弹出一条「已启用」通知，日志里出现 `[dsh-windows-notifier] active`。

不重启也能离线核对这套组合：`dsh --profile <profile> --dump-config` 会把每个 bundle 层、该 profile 的 patch、机器级 patch 依次应用后的结果打出来；应该能看到 `windows-notifier` 这一行、`name: dsh-windows-notifier`，以及它的 `config:` 里那些值。这一条在改动 patch 之后最值得跑：图层顺序错了、id 打错了、机器级那一行还在，都会在这里显形（"机器级那一行还在"还会额外让界面保存被拒）。

`logFile` 会记录**每一次决定**，包括每一次"没通知"的原因，例如：

```
notify complete: ✅ 对话已完成 / 重构支付模块 | 已运行 2 分 13 秒，可以继续对话了。 -> http://127.0.0.1:3080
skip complete for cccc1111-child-0001: subagent turn end (includeSubagents is off)
skip complete for session-…: 2 delegated subagent(s) still running
skip complete for session-…: 1 delegated subagent(s) still running (ctx.agents)
skip complete for session-…: attached session has no settled turn
session … is not attached; reporting completion without a turn outcome
skip question: switch off
```

「为什么没弹」基本都能在这几行里找到答案。

## 卸载

包分别装在每个 profile 自己的 `node_modules` 里，所以**每个装过的 profile 都要卸一次**：

1. `dsh plugin --profile <profile> remove dsh-windows-notifier`（对每个装过的 profile 跑一次）。包一走，**行也就没了** —— 行是 bundle 层带来的，而这条选中项不该再留着（同一套「已安装 bundle 声明」对账会把它一并摘掉；若你的版本没摘，手工从 `dsh.profile.bundles` 里删掉这一项即可），不再需要手工删 patch 里的行；手工展开进目录的那种直接删掉那个目录；
2. 想留着包但先关掉，就在该 profile 的 patch 里写 `disabled: true`（或直接用它那一行的开关）；
3. 顺手可以删掉 `$DSH_HOME/settings.yaml` 里残留的 `dsh-windows-notifier:` 分节 —— 那是旧版（0.1.x）留下的，本版不读它，留着也无害；
4. 旧落点 `$DSH_HOME\profiles\node_modules\dsh-windows-notifier`（历史遗留）本版已经不会被解析，可以删掉。

## 已知限制

- **仅 Windows**：非 Windows 平台插件会安静地跳过，不会报错。
- **专注助手（Focus Assist）/「请勿打扰」会拦掉通知**：这是系统行为，插件无法绕过。
- **通知显示的应用名是「Windows PowerShell」**：因为用的是它现成的 AUMID，好处是零安装。想改成自己的名字，需要注册一个带 `AppUserModelID` 的开始菜单快捷方式，然后把 `appId` 指过去。
- **每条通知会短暂启动一个 `powershell.exe`**（约 0.3–1 秒）。对「一轮任务结束」这种频率完全够用；这也是它不需要任何依赖的代价。
- **必须在有 DSH 事件的前提下工作**：headless / sdk 这类最小 profile 如果不发这些事件，插件会挂载但不产生通知。headless 收尾时会话可能已经 detach，这种情况下插件仍按「完成」通知（`idle` 只会在状态变化时发布，所以它本身就意味着有东西跑完过）。
- **点击通知只能打开 GUI 首页**：DSH 的 Web GUI 把会话选择放在内存里，没有会话级路由，所以没有可深链的地址。`launchUrl` 里写 `{sessionId}` 会被替换，但目标页面目前不消费它。不想要这个跳转就把 `openOnClick` 关掉（patch 或界面里都行）。
- **横幅时长只有两档**：见上面配置项下的说明；`0` 是唯一能"无限等待"的值（`scenario="reminder"`）。
- **必须重启一次，界面上的配置页才会出现**（原因见「界面化配置」最后一条）：浏览器半侧是在 DSH 启动时进入引导图的。
- **界面卡片的文案是它自己带的**：`src/client.js` 里注册了 `zh` / `en` 两本词典，跟界面语言走。schema 里的字段说明（`src/settings.js` 的 `LIVE_DESCRIPTIONS`）只有中文，但那一页是 Host 自动生成的表格 —— 本插件把它关掉了（`configure({ auto: false })`，DSH 自己的插件也这么写），所以实际显示的是卡片自己的文案。
- 通知不做「用户是否正在看这个会话」的判断 —— 前台会话结束同样会弹。

## 开发

```powershell
node --test test        # 66 项测试：消息文案、配置归一化、事件接线、双通道去重、
                        # 子会话识别（载荷自带 session / 创建公告兜底）、Config schema 与实时改配置、
                        # 浏览器半侧的卡片契约与暂存/保存
```

仓库结构：

```
src/plugin.js      插件本体：观察派发流 + 直接监听，决定要不要通知，并跟随界面设置
src/messages.js    纯函数：会话分类、文案、时长格式化
src/config.js      配置归一化（任何脏值都回退到默认值，不炸 profile）
src/settings.js    这行的 Config schema：进配置表格的 19 个键、哪些是 .volatile()（界面可改的那 14 个）
src/client.js      浏览器半侧：手写的 lazy-CJS bundle，注册「插件配置」里的卡片
src/notify.js      Windows Toast 传输层：队列 + powershell 进程生命周期
cordis.patch.yml   包自带的那一层 bundle patch：插入 windows-notifier 这一行（无 config）
scripts/toast.ps1  WinRT 弹窗脚本（纯 ASCII，中文通过参数以 UTF-16 传入）
scripts/send-test-toast.mjs  手动验证通道
scripts/sync-to-profile.ps1  打包（npm pack）+ 装进每个 profile 自己的 node_modules 并选中 bundle（默认全部 profile，-Profile 选一个，desktop 跳过）
examples/cordis.patch.yml    机器级/per-profile 覆盖与禁用的写法示例
```

## English

`dsh-windows-notifier` is a zero-build DSH plugin that raises a native Windows toast whenever
**any** conversation in the process hands control back to you: a turn finished, the agent asked a
question, an approval is pending, or a step errored. A subagent or workflow child's *own* turn end
is filtered out by default (set `includeSubagents: true` to hear it too); a child that asks a
question, blocks on approval, or errors is still reported, because the user is the one who has to
answer it. A *dispatcher* is handled separately: in a multi-agent mode such as Adg, delegating ends
the dispatcher's own turn at once, so its first `idle` is not the task being over. `waitForSubagents`
(on by default) holds that toast back while the session still has a running `origin: 'subagent'`
descendant — at any depth; a fork is not a delegation and never holds anything back — and releases it
on the last idle after the children reported back, because a settling child wakes its parent. The
interrupted report is never held back: this turn being stopped is true whatever the children do. It depends on nothing you have to install: the Windows side is Windows
PowerShell's built-in WinRT `Windows.UI.Notifications`, and the settings schema comes from the
harness's own `@deepseek-ai/schemastery`.

A child is recognised from `origin: 'subagent'` in the session header DSH stamps on it — read from
the session the *event payload itself* carries (`payload.agent.session`), never from a service
lookup that a patch-inserted row may have sampled before that service existed.

Its live switches are editable on the **Plugins** page, under this row's configuration. There is no
plugin-registered settings namespace any more: the Host derives a form per mounted profile entry from
that entry's own `Config` and addresses it by the entry id, so the card registers itself at
`<package>#<row id>` — here `dsh-windows-notifier#windows-notifier`. A save is one atomic,
revision-fenced document write into that profile's own `cordis.patch.yml` (not
`$DSH_HOME/settings.yaml`), with the row's own schema revalidating it; the card's per-field reset
sends an `unset`, so the field inherits the bundle layer's default again. Only the 15 `.volatile()`
fields are writable — the 5 install-time ones (`appId`, `powershellPath`, `scriptPath`,
`maxConcurrent`, `timeoutMs`) are refused by the Host, and the README's Chinese table names them.
That card is the plugin's browser half, hand-written in DSH's lazy-CJS client-module format, so this
repository still needs no build step. Note that a browser half only enters the web boot graph at
startup: the client module graph caches per-package metadata per resolved specifier, so **restart DSH
once** after installing.

DSH dispatches those events through a *scope carrier*, and Cordis drops listeners whose context
is outside the carrier's scope chain — a plain root-context listener sees `agent/status` but never
`user-questions/request`. The plugin therefore observes two channels: `internal/dispatch`, the
framework's own pre-filter dispatch announcement (which reaches every scope), plus direct
listeners as a fallback. Both carry the same payload object, so a `WeakSet` de-duplicates them by
identity. Toasts go through Windows PowerShell's built-in WinRT `Windows.UI.Notifications` types,
so nothing has to be installed, and a click opens the Web GUI.

Since 0.2.0 the package declares its own bundle patch (`package.json` → `dsh.bundle.patch` →
`cordis.patch.yml`). That layer contributes the `windows-notifier` row itself, so no `cordis.patch.yml`
has to be edited by hand any more: the package only has to be **selected**, i.e. its name has to appear
in that profile's `dsh.profile.bundles`. `dsh plugin … add` normally appends that selection when the
CLI reconciles installed bundle declarations, but the write was measured to land a moment after the
command returned — and a dependency that is never selected mounts nothing at all (no row, no
configuration page) — so the script verifies the selection and writes it itself when it is missing:

```powershell
powershell -NoProfile -File scripts\sync-to-profile.ps1              # every profile with a package.json
powershell -NoProfile -File scripts\sync-to-profile.ps1 -Profile web # one profile
```

That runs `npm pack` and then `dsh plugin --profile <profile> add "file:<tgz>"` per profile, which
adds the dependency and runs pnpm inside the profile directory, so the package lands in that
profile's own `node_modules` as a real directory. Two exceptions to "every profile":

- `desktop` is skipped: the launcher refuses every `dsh plugin` invocation for it (`error: profile
  "desktop" is managed exclusively by the Electron application`, `rejectElectronProfile` in
  `@deepseek-ai/dsh/lib/bin.js`). Update that profile from the Desktop app's plugin market, which runs
  the same install plus the selection.
- A profile whose host is running can refuse the swap outright (pnpm: another program is using this
  file, os error 32); stop that host, then re-run.

Current DSH (0.1.7-rc.2, Desktop) resolves plugin packages only from the Desktop installation and the
active profile's own `node_modules`; the shared parent `$DSH_HOME/profiles/node_modules` is treated as
an obsolete fallback and refused (`dsh-plugin-desktop: cannot resolve package "dsh-windows-notifier"
from the Desktop installation or active Profile`). A `link:` install is not used: it does not install
the package's own dependencies, and a link into a checkout resolves to the same real path the module
cache already holds, so it saves neither the dependency step nor the restart.

Per-profile values (a different log file, an `enabled: false` profile) belong in that profile's own
`cordis.patch.yml` — the same file the settings card writes to:

```yaml
- id: windows-notifier
  name: 'dsh-windows-notifier'
  config:
    logFile: 'D:\dsh\dsh-windows-notifier\.dsh-windows-notifier.log'
```

**Do not put the row into the machine-wide `$DSH_HOME/cordis.patch.yml`.** An id-targeted patch
replaces the whole `config` object (`applyEntryPatches` assigns `target.config = value`), and the
machine-wide layer is applied after every profile, so it silently shadows whatever the card saved —
and the Host refuses the save itself with `Configuration for "<id>" is overridden by a home patch or
command-line overlay`: the page renders, and cannot save.

After editing the source, re-run the script (it removes the package first, because pnpm reports an
unchanged local tarball as `Already up to date` and does not reinstall it) and **restart DSH**: the
loader caches an ES module by its resolved path. Uninstall per profile with
`dsh plugin --profile <profile> remove dsh-windows-notifier` — that also drops the selection, and the
row goes with the package; the `desktop` profile is uninstalled from the Desktop app's plugin market.
`dsh` needs `pnpm` on PATH (Desktop ships one); a git-hosted spec such as
`dsh plugin --profile <profile> add github:ADkun/dsh-windows-notifier` is a legitimate pnpm spec form,
but it was **not measured here**, and the unmeasured no-pnpm fallback is described in the Chinese
`没有 pnpm 时` section above.

## License

MIT