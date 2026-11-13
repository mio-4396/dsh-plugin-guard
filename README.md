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

从 GitHub 安装（仓库公开）：

```text
plugin_manager install_bundle
target: github:mio-4396/dsh-plugin-guard
```

```powershell
dsh plugin --profile <profile> add github:mio-4396/dsh-plugin-guard
```

本地目录安装（开发时推荐）：在 **Plugins** 页面安装，或 `plugin_manager`：

```text
action: install_bundle
target: D:\dsh-tools\dsh-plugin-guard
```

改动源码即生效可以直接 link：

```powershell
dsh plugin --profile <profile> add link:D:/dsh-tools/dsh-plugin-guard
```

装好后重启 DSH（Desktop 的 profile 默认不开 HMR）。插件零运行时依赖、不 import 任何 `@deepseek-ai/*` 包，所以它自己的加载路径刻意保持最简。

## 工具

| 工具 | 用途 |
|---|---|
| `plugin_guard_check` | 检查一个目标：已装插件名 / 本地目录 / `name@version` / git 地址。`depth=boot`（默认）跑真实启动，`depth=static` 只读包。 |
| `plugin_guard_audit` | 扫当前 profile 里**每一个**已装插件；`depth=boot` 会逐个真实启动（每个约 5–10 s，可用 `only`/`limit` 收窄）。 |
| `plugin_guard_install` | **带闸安装**：先探针；崩溃、卡死、Web 就绪前退出、装不上、探针不可用都会拒绝，profile 一个字节都不改。通过才调 `plugin_manager.install_bundle`。 |
| `plugin_guard_update` | **带闸更新**：同样的拒绝条件；拒绝时保留旧版本，通过才调 `updateBundle`。 |
| `plugin_guard_rehearse` | **升级前演练**：用候选 DSH 运行时（安装目录，或更新器缓存的安装包——解包但不安装）启动当前整套插件，报告能否启动、哪些插件会被拒绝或跳过。 |
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
| `EXITED_CLEAN` | 进程退出码 0，但 Web 没起来 | **是**（等同起不来，安装/更新会被拒） |
| `STATIC_ONLY` | 只做了静态检查（`depth=static`） | 未知 |
| `PROBE_UNAVAILABLE` | 找不到启动器，只能静态判断 | 未知 |
| `UPGRADE_OK` | 升级演练：候选运行时能带当前插件启动，且无插件失效 | 否 |
| `UPGRADE_WARN` | 升级演练：能启动，但有插件会被拒绝或跳过 | 否 |
| `UPGRADE_CRASH` | 升级演练：候选运行时起不来 | **是** |

带闸工具在 `CRASH_EXIT` / `CRASH_HANG` / `EXITED_CLEAN` / `INSTALL_FAILED` / `PROBE_UNAVAILABLE` 时拒绝；`probe:false` 走纯静态时，任何 fail 级发现（入口缺失、bundle patch 结构不合法、客户端缺失、版本不满足等）同样拒绝。`SKIPPED` 会安装并回报；若想连“装了不生效”也拦住，看报告里的 `SKIPPED` 再手动放弃即可。

## 自动监听

从 Web UI 或 `plugin_manager` 直接安装/更新时不会经过上面的工具，所以插件还做两件事：

1. 在 `plugin-manager/install-state` / `update-state` 进入安装阶段时，**快照**当前 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`compatibility.json`（存在才拷）；
2. 在 `plugin-manager/changed` 时记录这次变更；`plugin_guard_status` 里能看到全部记录。

事后如果发现 DSH 起不来，用 `plugin_guard_restore confirm=true` 回到最近一次快照。自动监听**不会**静默跑真实启动（每次启动一个 Web 太贵），所以“带闸安装/更新”仍然是拿到强保证的入口。

## 升级前演练（DSH 本体）

DSH 本体升级不在「插件安装/更新」的覆盖面里：插件要等运行时启动后才有机会运行。`plugin_guard_rehearse` 在升级前把这件事演练一遍：

1. 候选运行时：传 `source`（安装目录或更新器缓存的 `.exe`）；不传就用更新器 `pending` 里最新的安装包；
2. 安装包用 7-Zip 解到临时目录（**不运行安装器、不碰真实安装**），约 17 s、1.2 GB；
3. 复制当前 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 等进临时 `DSH_HOME`，用候选运行时自带的 pnpm 装同一套依赖（约 3–5 s）；
4. 用候选运行时真实启动 Web（端口由探针挑，必须拿到 DSH 外壳才算成功），提前退出 / 超时即判定；
5. 逐个包比对 `engines.dsh` / DSH peer 与候选版本，列出升级后会被拒绝或跳过的插件；
6. 删除临时 profile 与解包产物。

```text
plugin_guard_rehearse
plugin_guard_rehearse source: D:\Downloads\deepseek-harness-0.3.0-win-x64.exe
```

判定：`UPGRADE_OK`（能启动且无插件失效）/ `UPGRADE_WARN`（能启动，但有插件会被拒绝或跳过）/ `UPGRADE_CRASH`（升级后起不来）/ `INSTALL_FAILED` / `RUNTIME_UNRESOLVED` / `PROFILE_UNAVAILABLE`。

需要：7-Zip（找不到会提示设置 `DSH_GUARD_7Z`）、约 1.5 GB 临时空间、20–60 s（安装包解包占大头）。

演练的边界：复制的是**当前 profile**；候选版本与当前相同时只能验证流程与现有插件加载，不能预测新版本行为；启动崩溃时不会自动二分定位，先看 stderr 再用 `plugin_guard_check` 逐个查。

## 探针是怎么跑的

1. 临时目录 `%TEMP%\dsh-plugin-guard\home-<rand>` 作为 `DSH_HOME`；
2. `<启动器> <probe> --from-default-profile web --dump-config` 建 profile（约 0.3 s）；
3. `<启动器> plugin --profile <probe> add <spec>` 装候选（本地 `link:` 约 1 s，registry 初次取决于网络）；
4. 探针自己挑一个空闲回环端口，用 `--port <P>` 启动，插件不能决定 Web 面在哪；
5. 只有带 `dsh web:` 的行、端口等于 P、并且**真实拿到 DSH 应用外壳**（303+Set-Cookie → 200 页面含 `__DSH_BOOT__`）才算启动成功；插件自建 HTTP 或伪造地址都不算；
6. 结束：`taskkill /T /F` 杀进程树，再用**不跟随 junction 的安全 walker** 删除临时 `DSH_HOME`（Electron 的 `rmSync` 会顺着 junction 删掉被检查包的源码，这是实测过的坑）；删除失败会在报告里写明，残留目录 30 分钟后清理。

子进程环境：`ELECTRON_RUN_AS_NODE=1`、独立 `DSH_HOME`，并剥掉继承的 `DSH_PROFILE*` / `DSH_SESSION_ID` / `DSH_WEB_URL` / `DSH_SHELL`，避免连到正在运行的实例。

启动器默认从当前进程推导（`process.argv[1]` 同目录的 `cli.js`，或 `process.resourcesPath` 下的打包路径）；也可显式指定：

```powershell
$env:DSH_GUARD_LAUNCHER_EXE = 'D:\DeepSeek Harness\DeepSeek Harness.exe'
$env:DSH_GUARD_LAUNCHER_CLI = 'D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
```

## 验证记录（本机实测，2026-11-14）

| 检查 | 结果 |
|---|---|
| `node tests\selftest.mjs` | 65/65 通过（含 15 类真实启动夹具：OK / SKIPPED / CRASH_EXIT / CRASH_HANG / EXITED_CLEAN / INSTALL_FAILED，探针目录零残留） |
| `node tests\tooltest.mjs` | 30/30 通过（七个工具、带闸安装拦截、静态 fail 拦截、快照与恢复、自动静态复核、profile 服务回退） |
| `node tests\rehearse.test.mjs` | 19/19 通过（asar 读取、engines/peer 兼容比对、跳过行解析、运行时解析）；加 `DSH_GUARD_REHEARSE=1` 多 3 项真实演练 |
| `node tests\junction-safety.mjs` | 7/7 通过：**Electron 下删除探针 home 后，被 link 的本地包源码完好**（回归 D1） |
| 对抗矩阵 `tests\REDTEAM.md` | 两轮共 15 个对手夹具；第一轮修掉假地址/噪声/自伤竞态，第二轮修掉 junction 删源码、自建 HTTP 伪造就绪、EXITED_CLEAN 放行、静态 fail 放行、伪造 SKIPPED |
| 运行中实例 `plugin_guard_check` 坏包 | `CRASH_EXIT`，退出码 9，create 345ms · install 1082ms · boot 2479ms |
| 运行中实例 `plugin_guard_check` 正常包 | `OK`，启动成功 `http://127.0.0.1:61086/…`，create 330ms · install 1027ms · boot 3717ms |
| 安装到 Desktop profile | `dsh plugin --profile desktop add link:…` 成功，七个工具在运行中的会话里立即出现 |
| 升级演练（安装目录） | `UPGRADE_OK`：install 3.1 s · boot 2.6 s · 15 个包全部兼容 · 总 5.8 s |
| 升级演练（更新器安装包） | `UPGRADE_OK`：解包 + install + boot 总 24.5 s（解包约 17 s）· 1.5 GB 临时目录已删除 |

## 限制（说实话的部分）

- 探针跑的是 **web 模板**的合成，不是 Desktop 的真实组合。只依赖 Desktop 专属服务的插件在探针里可能被判 `SKIPPED`，但装到 Desktop 是好的——这类要结合 `plugin_guard_audit depth=static` 与真实重启判断。
- registry 包的探针要真的下载一次；首次检查受网络影响，之后有 pnpm store 缓存。
- 静态层只扫**运行时导入图**（入口与其相对 import），`scripts/`、`tests/` 不参与，避免把构建脚本里的 `process.exit` 误报成启动风险。
- `SKIPPED` 依赖 stderr 的激活汇总 + 堆栈帧；若上游改成只写日志文件，或插件刻意伪造带堆栈的汇总，判定会退化（伪造只会让它自己被判“不生效”，不会掩盖崩溃）。
- 探针与插件同进程、同权限：理论上插件可以自建服务并伪装 DSH 外壳。当前用「探针选定端口 + 303/Set-Cookie + `__DSH_BOOT__` 页面标记」提高门槛，但**本插件不是恶意代码沙箱**。
- 同一台机器上并发跑两个真实启动可能互相抢资源；探针 home 与 profile 名都带随机后缀，但没有跨进程锁。
- 升级演练需要 7-Zip（`DSH_GUARD_7Z` 可指定）与约 1.5 GB 临时空间；候选版本与当前相同只能验证流程，不能预测新版本行为；启动失败时不自动二分定位。
- 检测的是“会不会崩”，不是“安不安全”：插件代码在进程内运行，不做沙箱，也不审查恶意行为。

## 开发

```powershell
cd D:\dsh-tools\dsh-plugin-guard
node tests\selftest.mjs        # 65 项：semver / manifest / scan / plan + 15 类真实启动夹具
node tests\tooltest.mjs        # 30 项：七个工具的判定、带闸安装、静态 fail 拦截、快照与恢复
node tests\rehearse.test.mjs   # 19 项：asar / 兼容比对 / 跳过行 / 运行时解析（DSH_GUARD_REHEARSE=1 加真实演练）
node tests\junction-safety.mjs # 7 项：Electron 下清理不跟随 junction（防删源码）
node tests\redteam-run.mjs rt-good rt-spoof-http …   # 对抗矩阵，见 tests/REDTEAM.md
```

目录：

```text
index.js            Host 插件：七个工具 + 事件监听 + 快照
lib/semver.mjs      版本范围子集
lib/manifest.mjs    manifest / 入口 / bundle patch / engines / peers
lib/scan.mjs        运行时代码危险模式扫描
lib/plan.mjs        目标归一（名字/目录/link:/spec）
lib/probe.mjs       隔离探针与真实启动
lib/rehearse.mjs    升级前演练：复制 profile、兼容比对、启动候选运行时
lib/runtime.mjs     运行时解析：安装目录 / 更新器安装包（7-Zip 解包）
lib/asar.mjs        不依赖 Electron 读取 app.asar
lib/fs-safe.mjs     不跟随 junction 的安全删除
lib/process.mjs     子进程环境、终止与命令执行
lib/http.mjs        DSH Web 就绪证明（303+cookie+`__DSH_BOOT__`）
lib/report.mjs      判定与渲染
tests/fixtures/     15 类故障/对抗夹具（正常、退出、卡死、import/apply 抛错、假地址、自建 HTTP、噪声、伪造汇总、缺客户端…）
DESIGN.md           冻结的接口与实测语义
```
