# dsh-plugin-guard · 插件安全闸

在**安装或更新 DSH 插件之前**先判断：它会不会让 DSH 起不来。

判断不是靠读代码猜，而是**真实启动一次**：在临时 `DSH_HOME` 里建一个全新的 `web` 探针 profile，用官方启动器把候选包装进去、真的启动 Web，按「是否打印出 `http://127.0.0.1:<port>` / 退出码 / 超时」定性。探针目录用后即删，**不碰**真实 profile、它的 `node_modules` 和 patch 文件。

## 为什么需要它

DSH 的 `plugin_manager` 已经会在安装前拦掉 `engines.dsh` / peer 版本不满足的包，但它看不到“启动”本身。实测（Desktop 0.2.2-rc.1）几类失败长这样：

| 插件行为 | DSH 实际表现 | 本插件的判定 |
|---|---|---|
| 模块 import 抛异常 | 启动继续，`warning: 1 entry did not activate`，插件被跳过 | `SKIPPED`（装了也不生效） |
| `apply()` 抛异常 | 同上，启动继续 | `SKIPPED` |
| 模块顶层 `process.exit(9)` | 进程退出码 9，Web 端口不起 | `CRASH_EXIT`（会崩） |
| `apply()` 里 `process.exit(9)` | 进程退出码 9 | `CRASH_EXIT`（会崩） |
| 模块顶层或 `apply()` 里死循环 | 进程不返回，Web 永不起 | `CRASH_HANG`（会卡死） |
| 声明 `dsh.client` 但客户端文件缺失 | Web 启动进程退出码 1 | `CRASH_EXIT`（会崩） |
| bundle patch 声明错误 | bundle 被跳过或安装即拒绝 | `SKIPPED` / `INSTALL_FAILED` |
| 正常插件 | 约 2–3 s 起 Web | `OK` |

也就是说：**“能 import”不等于“能启动”，“不崩”也可能“白装”**。只有真实启动能同时回答这两件事。

## 安装

正常路径（推荐）：在 **Plugins** 页面安装，或让 Agent 调 `plugin_manager`：

```text
action: install_bundle
target: D:\dsh-tools\dsh-plugin-guard      # 本地目录；发布后可用 name@version
```

开发时可以直接 link（改动源码即生效）：

```powershell
dsh plugin --profile <profile> add link:D:/dsh-tools/dsh-plugin-guard
```

装好后重启 DSH（Desktop 的 profile 默认不开 HMR）。插件零运行时依赖、不 import 任何 `@deepseek-ai/*` 包，所以它自己的加载路径刻意保持最简。

## 工具

| 工具 | 用途 |
|---|---|
| `plugin_guard_check` | 检查一个目标：已装插件名 / 本地目录 / `name@version` / git 地址。`depth=boot`（默认）跑真实启动，`depth=static` 只读包。 |
| `plugin_guard_audit` | 扫当前 profile 里**每一个**已装插件；`depth=boot` 会逐个真实启动（每个约 5–10 s，可用 `only`/`limit` 收窄）。 |
| `plugin_guard_install` | **带闸安装**：先探针，会崩就拒绝，profile 一个字节都不改；通过才调 `plugin_manager.install_bundle`。 |
| `plugin_guard_update` | **带闸更新**：先探针目标版本，会崩就拒绝并保留旧版本；通过才调 `updateBundle`。 |
| `plugin_guard_status` | 自动监听记录、当前快照、最近的检查。 |
| `plugin_guard_restore` | 用最近一次安装/更新前的快照恢复 profile 文件（需 `confirm=true`）。 |

示例：

```text
plugin_guard_check   target: dsh-bad-sidebar@0.24.1
plugin_guard_install target: D:\my-plugins\new-tool
plugin_guard_update  name: dsh-better-sidebar   version: 0.25.0
plugin_guard_audit   depth: boot   limit: 5
```

一个会崩的插件，返回长这样：

```text
判定：会让 DSH 起不来（进程直接退出）（CRASH_EXIT）
目标：dsh-guard-bad@1.0.0（本地目录）
启动预演：进程在打印 Web 地址前退出，退出码 9（2431ms）

崩溃证据
- 启动预演：进程在打印 Web 地址前退出，退出码 9（2431ms）
- 子进程 stderr（尾部）：
  （空）

失败项
- [fail] bundle-patch-missing @ …：bundle patch 文件不存在：./cordis.patch.yml
风险项
- [warn] process-exit @ index.js:1：调用了 process.exit()：若在加载或激活阶段执行，DSH 进程会直接退出

结论：不要安装这个版本。DSH 下次启动会停在它上面。
```

## 判定含义

| 判定 | 含义 | 会不会崩 |
|---|---|---|
| `OK` | 隔离环境里真实启动成功 | 否 |
| `WARN` | 有失败项/风险项，但没有会崩的证据 | 未见 |
| `SKIPPED` | 能启动，但插件行被跳过（装了不生效） | 否 |
| `DENIED` | 版本/平台要求不满足，DSH 会拒绝这一行 | 否 |
| `INSTALL_FAILED` | 探针里装不上（registry/网络/构建脚本） | 未知 |
| `CRASH_EXIT` | 启动进程提前退出（附退出码） | **是** |
| `CRASH_HANG` | 启动在超时内没有起 Web | **是** |
| `EXITED_CLEAN` | 进程退出码 0，但 Web 没起来 | 异常 |
| `STATIC_ONLY` | 只做了静态检查（`depth=static`） | 未知 |
| `PROBE_UNAVAILABLE` | 找不到启动器，只能静态判断 | 未知 |

带闸工具只在 `CRASH_EXIT` / `CRASH_HANG` / `INSTALL_FAILED` 时拒绝；其余判定会执行并回报风险。

## 自动监听

从 Web UI 或 `plugin_manager` 直接安装/更新时不会经过上面的工具，所以插件还做两件事：

1. 在 `plugin-manager/install-state` / `update-state` 进入安装阶段时，**快照**当前 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`compatibility.json`（存在才拷）；
2. 在 `plugin-manager/changed` 时记录这次变更；`plugin_guard_status` 里能看到全部记录。

事后如果发现 DSH 起不来，用 `plugin_guard_restore confirm=true` 回到最近一次快照。自动监听**不会**静默跑真实启动（每次启动一个 Web 太贵），所以“带闸安装/更新”仍然是拿到强保证的入口。

## 探针是怎么跑的

1. 临时目录 `%TEMP%\dsh-plugin-guard\home-<rand>` 作为 `DSH_HOME`；
2. `<启动器> <probe> --from-default-profile web --dump-config` 建 profile（约 0.3 s）；
3. `<启动器> plugin --profile <probe> add <spec>` 装候选（本地 `link:` 约 1 s，registry 初次取决于网络）；
4. `<启动器> --profile <probe> --port 0 --no-open` 真实启动，轮询 stdout 的 Web 地址；
5. 地址必须**真实 HTTP 可连通**才算启动成功（插件自己打印的假地址骗不过探针）；
6. 结束：`taskkill /T /F` 杀进程树、删临时 `DSH_HOME`；超过 2 小时的残留目录在下次运行时清理。

子进程环境：`ELECTRON_RUN_AS_NODE=1`、独立 `DSH_HOME`，并剥掉继承的 `DSH_PROFILE*` / `DSH_SESSION_ID` / `DSH_WEB_URL` / `DSH_SHELL`，避免连到正在运行的实例。

启动器默认从当前进程推导（`process.argv[1]` 同目录的 `cli.js`，或 `process.resourcesPath` 下的打包路径）；也可显式指定：

```powershell
$env:DSH_GUARD_LAUNCHER_EXE = 'D:\DeepSeek Harness\DeepSeek Harness.exe'
$env:DSH_GUARD_LAUNCHER_CLI = 'D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
```

## 验证记录（本机实测，2026-11-12）

| 检查 | 结果 |
|---|---|
| `node tests\selftest.mjs` | 56/56 通过（含 10 类真实启动夹具：OK / SKIPPED / CRASH_EXIT / CRASH_HANG / EXITED_CLEAN / INSTALL_FAILED，探针目录零残留） |
| `node tests\tooltest.mjs` | 25/25 通过（六个工具、带闸安装拦截、快照与恢复、自动静态复核、profile 服务回退） |
| 对抗矩阵 `tests\REDTEAM.md` | 11 个对手夹具全部判对；期间修掉「假 Web 地址」「stderr 形状噪声」「探针自伤竞态」三个缺陷 |
| 运行中实例 `plugin_guard_check` 坏包 | `CRASH_EXIT`，退出码 9，create 345ms · install 1082ms · boot 2479ms |
| 运行中实例 `plugin_guard_check` 正常包 | `OK`，启动成功 `http://127.0.0.1:61086/…`，create 330ms · install 1027ms · boot 3717ms |
| 安装到 Desktop profile | `dsh plugin --profile desktop add link:…` 成功，六个工具在运行中的会话里立即出现 |

## 限制（说实话的部分）

- 探针跑的是 **web 模板**的合成，不是 Desktop 的真实组合。只依赖 Desktop 专属服务的插件在探针里可能被判 `SKIPPED`，但装到 Desktop 是好的——这类要结合 `plugin_guard_audit depth=static` 与真实重启判断。
- registry 包的探针要真的下载一次；首次检查受网络影响，之后有 pnpm store 缓存。
- 静态层只扫**运行时导入图**（入口与其相对 import），`scripts/`、`tests/` 不参与，避免把构建脚本里的 `process.exit` 误报成启动风险。
- 检测的是“会不会崩”，不是“安不安全”：插件代码在进程内运行，本插件不做沙箱，也不审查恶意行为。

## 开发

```powershell
cd D:\dsh-tools\dsh-plugin-guard
node tests\selftest.mjs   # 56 项：semver / manifest / scan / plan + 10 类真实启动夹具
node tests\tooltest.mjs   # 25 项：六个工具的判定、带闸安装、快照与恢复、自动复核
node tests\redteam-run.mjs rt-good rt-spoof-url …   # 对抗矩阵，见 tests/REDTEAM.md
```

目录：

```text
index.js            Host 插件：六个工具 + 事件监听 + 快照
lib/semver.mjs      版本范围子集
lib/manifest.mjs    manifest / 入口 / bundle patch / engines / peers
lib/scan.mjs        运行时代码危险模式扫描
lib/plan.mjs        目标归一（名字/目录/link:/spec）
lib/probe.mjs       隔离探针与真实启动
lib/report.mjs      判定与渲染
tests/fixtures/     好、退出、卡死、import 抛错四类夹具
DESIGN.md           冻结的接口与实测语义
```
