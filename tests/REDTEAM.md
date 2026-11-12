# dsh-plugin-guard 对抗性验证报告（REDTEAM）

日期：2026-11-12
环境：Windows / DSH Desktop 0.2.2-rc.1 / Electron 44.7.0（Node 24.21.0）/ 系统 Node 24.19.0
启动器：`D:\DeepSeek Harness\DeepSeek Harness.exe --expose-internals <app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`
探针子进程环境：`ELECTRON_RUN_AS_NODE=1`、独立临时 `DSH_HOME`、清除 `DSH_PROFILE*` / `DSH_SESSION_ID` / `DSH_WEB_URL` / `DSH_SHELL`

## 0. 结论摘要

- 7 个指定情形（a–g）中：a 的**判定名对、安装门禁错**；b、c、d、e、g **对**；f 的**探针对、静态策略错**。
- 另测 7 个附加夹具，并做了清理副作用实验，发现 1 个**可伪造启动成功**的严重误判、1 个**误报 SKIPPED**、1 个**会删除被检查包源码**的严重副作用。
- **关键缺陷 5 个**：D1 数据丢失（Electron 清理跟随 junction 删除源目录）、D2 自建 HTTP + 伪造 `dsh web:` 行可判 OK、D3 `EXITED_CLEAN` 被安装/更新门禁放行、D4 `client-missing` 静态策略放行（实测会崩）、D5 伪造 `did not activate` 可判 SKIPPED。另有 2 个低危（D6、D7）、1 个中危（D11）、3 个灰区观察（D8–D10）。

## 1. 被测版本（快照）与环境

测试期间 `D:\dsh-tools\dsh-plugin-guard` 被其他进程持续修改（`index.js` 11:06、`report.mjs` 11:02、`scan.mjs` 11:19、`probe.mjs` 11:21、`DESIGN.md` 11:18、`README.md` 11:32、`selftest.mjs` 11:30）。为避免“边测边改”，所有脚本化测量固定到 11:38 的完整快照 `D:\WORK1\redteam\snap-1138`，写报告前复核仓库哈希与快照一致。

| 文件 | 字节 | SHA256 前 16 位 | mtime |
|---|---:|---|---|
| `index.js` | 30578 | `F0699B76129BF618` | 11:06:12 |
| `lib/probe.mjs` | 15462 | `24B0D7ECA377AA45` | 11:21:22 |
| `lib/manifest.mjs` | 12329 | `4135ECDE1C263633` | 10:56:39 |
| `lib/report.mjs` | 8721 | `BCE313B2AACEE714` | 11:02:02 |
| `lib/plan.mjs` | 5932 | `9F04CA2F51BF62B7` | 11:00:38 |
| `lib/scan.mjs` | 8200 | `144B8B778905DA23` | 11:19:22 |
| `lib/semver.mjs` | 8392 | `AAD8E8D717778660` | 10:54:17 |
| `DESIGN.md` | 6451 | `84AB8603428EC1AD` | 11:18:38 |
| `package.json` | 848 | `CC16E9F50FEE2008` | 10:54:03 |

版本说明：更早的 `lib/probe.mjs`（11:21 前，哈希 `D23A0BB7…`）在本轮早期实测中会把插件自报的 `http://127.0.0.1:9/` 直接判 `up`（误判 OK），也会把 stderr 中任意 `名字 (` 形状的日志误判 `SKIPPED`。当前快照已分别加入 HTTP 连通性校验和 `did not activate` 汇总行校验；本报告只以当前快照的结果计入判定，旧版本观察仅作为版本演进记录。

## 2. 方法

- 夹具：在 `tests/fixtures/` 下新增 `rt-*`（共 14 个，原有 `good` / `crash-exit` / `hang` / `import-error` 未改动）。
- 测试脚本放在仓库外 `D:\WORK1\redteam\`：`run-snapshot.mjs`（全量探针）、`gate-snapshot.mjs`（真实 `index.js` 工具 + 假 `pluginManager`）、`repeat-snapshot.mjs`（重复性）、`probe-one.mjs`（单例）、`steps-electron.mjs` / `steps-safe.mjs` / `deltest*.mjs`（清理副作用根因与修法验证）。
- 探针链路与 `plugin_guard_check` 相同：`resolveTarget` → `analyzeManifest` → `scanPackage` → `runBootProbe`（临时 `DSH_HOME` + 新建 `web` profile + `pnpm add link:` + 真实启动）→ `verdictFrom`。
- 安装门禁测试：导入真实 `index.js`，用假 `pluginManager.installBundle` 只记录调用、不落盘；`DSH_HOME` 指向 scratch 目录。因此**没有向真实 profile 安装任何插件**。
- 隔离验证：测试前后对真实 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`cordis.yml` 做 SHA256，`node_modules` 计数；8 次探针前后完全一致（见 §4.3）。
- 时间：`rt-good` 全链路 3.0–3.6 s；卡死夹具 20 s 超时 + 约 1.2 s 终止宽限，总计 21.1–21.3 s。

## 3. 逐个夹具

### a. `rt-exit0-import` — import 阶段 `process.exit(0)`

- **情形**：模块顶层 `process.exit(0)`，Web 永不出现，但退出码看起来像成功。
- **命令/脚本**：`node D:\WORK1\redteam\run-snapshot.mjs`（用例 `rt-exit0-import`）；门禁用 `node D:\WORK1\redteam\gate-snapshot.mjs`。
- **实测判定**：`EXITED_CLEAN`。静态 `warn:process-exit` / `STATIC_ONLY`；`install` 710 ms、`boot` exit(0) 1729 ms、总计 2682 ms；无 URL、stderr 为空；`cleanupOk=true`、临时目录已删。**安装门禁返回 `ok:true` 并调用 `installBundle`**（2530 ms，`crashed:false`）。
- **期望判定**：`EXITED_CLEAN`（或判失败），绝不能是 `OK`，也不应被安装门禁放行。
- **结论**：**判定名对，门禁错**。`isCrash()` 不包含 `EXITED_CLEAN`，`plugin_guard_install` / `plugin_guard_update` 的守卫式 `isCrash(verdict) || verdict === INSTALL_FAILED` 因此放行一个会让 DSH 静默退出的包；报告的 `crashed=false` 和“无结论行”也会误导调用方。

### b. `rt-hang-apply` — `apply()` 里死循环

- **情形**：`apply()` 内 `while (Date.now() < deadline) {}`，不阻塞 import，只阻塞激活。
- **命令/脚本**：`run-snapshot.mjs`；另以 `rt-exit9-apply`（`apply()` 内 `process.exit(9)`）交叉验证 `apply()` 的执行时机。
- **实测判定**：`CRASH_HANG`。`boot` 20203 ms（20 s 超时 + 终止宽限）、总计 21342 ms；无 URL；`cleanupOk=true`、无残留；门禁拒绝。`rt-exit9-apply` 为 `CRASH_EXIT`、exit=9、boot 1602 ms，说明 `apply()` 在 Web 就绪前执行。
- **期望判定**：实验确认是 `CRASH_HANG` 还是 `SKIPPED`。
- **结论**：**对**。`apply()` 死循环会卡住启动，判 `CRASH_HANG` 正确；不是 `SKIPPED`。

### c. `rt-throw-apply` — `apply()` 抛异常

- **情形**：模块可 import，`apply()` 抛 `Error`。
- **命令/脚本**：`run-snapshot.mjs` + `repeat-snapshot.mjs`（3 次重复）。
- **实测判定**：`SKIPPED`，4/4 次（1 次全量 + 3 次重复）。stderr 为 `dsh: warning: 1 entry did not activate` + `rt-throw-apply (rt-throw-apply): Error: fixture: apply() throws`；`skippedRows=["rt-throw-apply"]`；boot 2229–2419 ms、总计 3152–3381 ms；`cleanupOk=true`。门禁**放行**（`SKIPPED` 不属于拒绝集合）。
- **期望判定**：`SKIPPED`。
- **结论**：**对**。但该判定依赖“URL 出现后 3 s 内还能收到 stderr”的宽限（见 D8），且安装工具描述声称会拒绝 `SKIPPED`、实际放行（见 D6）。

### d. `rt-bad-patch` — bundle patch 非法 YAML（`- insert: [`）

- **情形**：`cordis.patch.yml` 内容为 `- insert: [`，YAML 流集合未闭合。
- **命令/脚本**：`run-snapshot.mjs`。
- **实测判定**：`INSTALL_FAILED`。`install` exit(1) 1135 ms，stderr：`installation rejected: Cannot validate installed package rt-bad-patch: Error: dsh: failed to parse overlay …/cordis.patch.yml: YAMLException: unexpected end of the stream within a flow collection (2:1)`，并附 `dsh: restored package.json, pnpm-lock.yaml, and node_modules.`；`boot` 未执行；总计 1408 ms；无崩溃、临时目录已删。静态层**没有任何 finding**（`STATIC_ONLY`），静态门禁（`probe:false`）会提交安装（随后被 DSH 拒绝）。
- **期望判定**：实验确认是“启动崩溃”还是“bundle 被跳过”。
- **结论**：**实测是安装阶段被 DSH 拒绝，既不是启动崩溃，也不是静默跳过**；就“会不会让 DSH 起不来”而言 `INSTALL_FAILED` 正确。但 `DESIGN.md` §1 的“bundle 声明无效 → SKIPPED”与实测不符（文档偏差，低），静态层对非法 YAML 无发现（D7）。

### e. `rt-engine-mismatch` — `engines.dsh = ">=9.0.0"`

- **情形**：运行时为 0.2.2-rc.1，声明 `engines.dsh: ">=9.0.0"`。
- **命令/脚本**：`run-snapshot.mjs`。
- **实测判定**：静态 `DENIED`（`fail:engines-dsh-mismatch`）；探针 `INSTALL_FAILED`：`install` exit(1) 250 ms，stderr：`Plugin rt-engine-mismatch@1.0.0 is incompatible with dsh 0.2.2-rc.1: requirements {"engines.dsh":">=9.0.0"}`，并给出 `allow-version` 例外提示；总计 467 ms；门禁拒绝。
- **期望判定**：安装/探针阶段被拒或 `DENIED`。
- **结论**：**对**。boot 深度下报 `INSTALL_FAILED`、static 深度下报 `DENIED`，二者都表示“装不进去”。

### f. `rt-client-missing` — 声明 `dsh.client` 但客户端文件缺失

- **情形**：`dsh.client` 存在、`exports["./client"]` 指向 `./client.js`，文件不存在。
- **命令/脚本**：`run-snapshot.mjs`；门禁用 `gate-snapshot.mjs` 的 `probe:true` 与 `probe:false` 两个用例。
- **实测判定**：静态 `fail:client-missing`，但静态判定是 `WARN`（不是 `DENIED`）；探针 `boot` exit(1) 2191 ms，stderr：`client bundle not found; run 'pnpm run build' before launch` + `ENOENT … client.js`，判定 `CRASH_EXIT`，总计 3145 ms。门禁 `probe:true` 拒绝；**门禁 `probe:false` 返回 `ok:true` 并调用 `installBundle`**（2 ms，静态 `WARN` 被放行）。
- **期望判定**：静态 FAIL（`client-missing`）；探针**可能**仍 OK。
- **结论**：**探针对、静态策略错**。实测该包会让启动直接 exit 1，静态层却给出“有风险，但没有会崩的证据（WARN）”并允许跳过探针安装；与真实风险不符（D4）。

### g. `rt-good` — 正常插件

- **情形**：普通 no-op 插件 + 合法 patch + 匹配的 `engines.dsh`。
- **命令/脚本**：`run-snapshot.mjs` + `repeat-snapshot.mjs`。
- **实测判定**：`OK`。静态无 finding；`boot` 2550 ms 打印 `dsh web: http://127.0.0.1:<port>/?token=…`；总计 3647 ms（同夹具另两次 3.0–3.3 s）；`cleanupOk=true`、`homeExists=false`、`PROBE_ROOT` 残留 0/0；门禁安装（正确）。
- **期望判定**：`OK`，探针 3–6 s，临时目录清理。
- **结论**：**对**。

### 附加 1. `rt-exit9-apply` — `apply()` 内 `process.exit(9)`

- **情形**：模块可 import，`apply()` 内 `process.exit(9)`。
- **命令/脚本**：`run-snapshot.mjs`（用例 `rt-exit9-apply`）。
- **实测判定**：`CRASH_EXIT`，exit=9；`boot` 1602 ms、总计 2542 ms；无 URL；`cleanupOk=true`；门禁拒绝。
- **期望判定**：`CRASH_EXIT`（`apply()` 在 Web 就绪前执行）。
- **结论**：**对**。

### 附加 2. `rt-hang-child` — import 死循环 + detached 子进程

- **情形**：import 阶段 `while` 阻塞，并 `spawn(process.execPath, ['-e','setInterval…'], {detached:true})` 后 `unref()`，把 host/child 的 pid 写到 `D:\Temp\redteam-pids\rt-hang-child.json`。
- **命令/脚本**：`run-snapshot.mjs`（用例 `rt-hang-child`，boot 超时 20 s）。
- **实测判定**：`CRASH_HANG`，总计 21171 ms；探针返回瞬间 hostPid 11208 与 childPid 10792 **都已死亡**；`cleanupOk=true`、`PROBE_ROOT` 残留 0/0。
- **期望判定**：`CRASH_HANG`，且超时后进程树被杀、无残留。
- **结论**：**对**（进程树真被杀）。

### 附加 3. `rt-spoof-url` — 假 URL + 顶层 `await` 永不完成

- **情形**：`console.log('http://127.0.0.1:9/')` 后 `await new Promise(() => {})`；URL 可被刷出，但 9 端口没有 HTTP 服务。
- **命令/脚本**：`run-snapshot.mjs`；早期还做过 2 次 `trials.mjs` 重复。
- **实测判定**：`CRASH_HANG`，总计 21199 ms；`url=null`（HTTP 校验失败，不认这个假地址）。
- **期望判定**：不能判 `OK`；`CRASH_HANG` 可接受。
- **结论**：**对**（旧版会直接判 `OK`，当前快照已修复该路径）。

### 附加 4. `rt-spoof-url-sync` — 假 URL + 同步死循环（stdout 刷新竞态）

- **情形**：假 URL 后紧接 `while (Date.now() < deadline) {}`，stdout 是否刷出是竞态。
- **命令/脚本**：`run-snapshot.mjs`（用例 `rt-spoof-url-sync`）。
- **实测判定**：`CRASH_HANG`，总计 21142 ms；`url=null`。
- **期望判定**：不能判 `OK`。
- **结论**：**对**。

### 附加 5. `rt-spoof-http` — 自建可达 HTTP + 伪造 `dsh web:` 行

- **情形**：插件自己 `createServer(...)` 返回 200，打印 `dsh web: http://127.0.0.1:<port>/`，然后顶层 `await` 永不完成；DSH 的 Web 从未启动。
- **命令/脚本**：`run-snapshot.mjs`（1 次）+ `repeat-snapshot.mjs`（2 次）+ 实时 `plugin_guard_check`（1 次）+ `gate-snapshot.mjs`。
- **实测判定**：**`OK` 3/3**（脚本化）。URL `http://127.0.0.1:52846/`（无 token），boot 2040/2063/2245 ms、总计 2999–3300 ms；门禁 `ok:true` 并调用 `installBundle`；实时工具输出“启动成功：http://127.0.0.1:55571/（2961ms）”“隔离环境里真实启动成功”。
- **期望判定**：`CRASH_HANG`（DSH Web 未就绪），绝不能判 `OK`。
- **结论**：**错（严重误判）**。`servesHttp` 只验证 URL 可达（200–499），`dsh web:` 前缀可被插件伪造；详见 D2。

### 附加 6. `rt-stderr-noise` — 正常插件打印“行形状”日志

- **情形**：完全正常的插件，import 时 `console.error('booting (rt-stderr-noise) into the web surface')`。
- **命令/脚本**：`run-snapshot.mjs`（用例 `rt-stderr-noise`）。
- **实测判定**：`OK`，正常 Web URL，`skippedRows=[]`，总计 3384 ms。
- **期望判定**：`OK`（不能因为一行 stderr 就判 `SKIPPED`）。
- **结论**：**对**（旧版会误判 `SKIPPED`，当前快照已修复）。

### 附加 7. `rt-stderr-forge` — 正常插件伪造“未激活”汇总

- **情形**：完全正常的插件，import 时向 stderr 打印 `dsh: warning: 1 entry did not activate` 与 `rt-stderr-forge (rt-stderr-forge): failed to import: Error: forged`，Web 正常启动。
- **命令/脚本**：`run-snapshot.mjs`（1 次）+ `repeat-snapshot.mjs`（2 次）+ `gate-snapshot.mjs`。
- **实测判定**：**`SKIPPED` 3/3**，正常 Web URL + `skippedRows=["rt-stderr-forge"]`，总计 3219–3380 ms；门禁照常安装。
- **期望判定**：`OK`（插件实际生效）。
- **结论**：**错（误报）**，详见 D5。

### 附加 8（对照，原夹具）. `import-error` — import 抛异常

- **情形**：`tests/fixtures/import-error` 的模块体 `throw new Error(...)`（原有夹具，未改动）。
- **命令/脚本**：`run-snapshot.mjs`（用例 `import-error`）。
- **实测判定**：`SKIPPED`；stderr 真实 `dsh: warning: 1 entry did not activate` + `guard-fixture-import-error (guard-fixture-import-error): failed to import…`；`skippedRows=["guard-fixture-import-error"]`；boot 2666 ms、总计 3583 ms。
- **期望判定**：`SKIPPED`（与给定 DSH 语义一致）。
- **结论**：**对**（说明探针的 `SKIPPED` 解析在真实警告上工作正常）。

## 4. 横切检查

### 4.1 临时目录与残留

- 全量 15 个探针：`cleanupOk=true` 15/15，`homeExists=false` 15/15；`PROBE_ROOT` 在探针返回时与 1.5 s 后均为 0 个条目；私有 `TMP` 下的 `PROBE_ROOT` 最终为空。
- `rt-hang-child`：探针返回瞬间 hostPid 与 childPid **都已不存在**，没有留下被 kill 后仍存活的 Electron/Node 进程。
- **实时（Electron）路径观测到一次残留**：`D:\Temp\dsh-plugin-guard\home-mwd048md-jrrq65`（11:41:45 创建）在探针结束后仍存在，内含 `.credentials.yaml`（161 B）。该残留说明 `removeDir` 并非 100% 成功，且 `cleanupOk=false` 不会出现在 `plugin_guard_check` 的文本输出中；这次残留的来源无法区分是本次实时检查还是并发探针，但目录结构属于本探针。已删除该残留（未读取凭据内容）。
- 结论：子进程树清理**对**；脚本化临时目录清理 15/15 干净，但实时路径存在**静默残留**，且残留可能包含 `.credentials.yaml`（见 D11）。

### 4.2 时序

| 夹具 | create | install | boot | 总计 |
|---|---:|---:|---:|---:|
| `rt-good` | 219 ms | 876 ms | 2550 ms | 3647 ms |
| `rt-throw-apply` | 240 ms | 720 ms | 2419 ms | 3381 ms |
| `rt-exit9-apply` | 230 ms | 710 ms | 1602 ms | 2542 ms |
| `rt-hang-apply` | 305 ms | 834 ms | 20203 ms | 21342 ms |
| `rt-exit0-import` | 243 ms | 710 ms | 1729 ms | 2682 ms |
| `rt-client-missing` | 239 ms | 714 ms | 2191 ms | 3145 ms |

正常插件 3.0–3.6 s，符合 3–6 s 预期；卡死夹具 21.1–21.3 s = 20 s 超时 + 约 1.2 s 终止宽限。

### 4.3 真实 profile 隔离

8 次探针（含 `rt-good`、`rt-hang-child` 等）前后：

```
package.json     113f01b5595b00aa  → 113f01b5595b00aa
cordis.patch.yml 67ede20387d18047  → 67ede20387d18047
pnpm-lock.yaml   75f02914ca855a37  → 75f02914ca855a37
cordis.yml       c300dcf2ebc5f020  → c300dcf2ebc5f020
node_modules 条目 127 → 127
```

结论：**没有触碰真实 profile**（对）。

### 4.4 严重副作用：清理会删除被检查包的源码（Electron 专属）

这是本轮最重要的发现，且现有 Node 测试全部漏掉。

**实测步骤**（每一份都是 `rt-good` 的独立副本，含 `nested/keep.txt`，共 4 个文件）：

| 场景 | 操作 | 操作后源目录文件数 |
|---|---|---:|
| `live-target` | 在真实 DSH 中调用 `plugin_guard_check`（boot 深度） | **0** |
| `live-target2` | 同上，复核 | **0** |
| `live-static` | 同样的实时工具，`depth=static` | **4**（完好） |
| `node-target` | 用 `probe-one.mjs` + 系统 Node 跑同一探针 | **4**（完好） |
| `electron-target` | 用 `probe-one.mjs` + `DeepSeek Harness.exe`（`ELECTRON_RUN_AS_NODE=1`）跑同一探针 | **0** |

**步骤追踪**（Electron 下 `steps-electron.mjs`，目标 3 个文件）：create 后 3 → install 后 3 → boot 成功并 kill 后 3 → 执行 `rmSync(home, {recursive:true, force:true, maxRetries:2})` 后 **0**（`package.json` 不存在）。删除发生在探针收尾的 `removeDir(home)`，不是安装或启动阶段。

**根因**：

- `pnpm add link:<dir>` 在探针 profile 里生成的 `node_modules/<包名>` 是 **Junction**（PowerShell `LinkType=Junction`，`Target` 指向源目录；Node `lstat().isSymbolicLink()=true`）。
- 同一句 `rmSync(parent,{recursive:true})`：系统 Node 24.19 **不跟随** junction（目标保留）；Electron 44.7 / Node 24.21 **跟随 junction**，把目标目录内容清空，只留下空的源目录。`deltest.mjs` / `deltest3.mjs` 在 direct、1 层、3 层嵌套 junction 上都复现了该差异。
- `deltest2.mjs`（Electron）：junction 的 `lstat().isSymbolicLink()=true`；`rmdirSync(link)` **只删链接、目标完好**；`rmSync(link,{recursive:false})` 抛 `ERR_FS_EISDIR` **且目标被删**（危险）。
- `steps-safe.mjs`（Electron）：先对 symlink/junction 用 `rmdirSync`、再删其余内容的安全 walker，删除 home 后目标 3 个文件**完好**、home 已消失——修法已验证。

**影响面**：

- `plugin_guard_check <本地目录>`：检查即删源码（本轮观察到：`rt-exit0-import`、`rt-spoof-url`、`rt-spoof-http` 三个仓库夹具在实时检查后内容为空，与独立复现的 D1 一致，后从快照恢复；`live-target`、`live-target2`、`electron-target` 为独立复现）。
- `plugin_guard_install <本地目录>`：按代码路径推断，先跑探针，源码会在真正 `installBundle` 之前被删，随后安装的是空目录（高危；未执行真实安装以免破坏现场）。
- `plugin_guard_audit depth=boot`：真实 profile 里有 5 个 `link:` 依赖（`@dsh-external/dsh-blender-plugin`、`dsh-file-menu`、`dsh-hippocampus`、`dsh-message-rewind`、`dsh-plugin-guard`），按同一清理路径推断，boot 深度审计会把它们的源码逐个清空（推断，未执行以免破坏这些插件）。
- 系统 Node 下 `selftest.mjs` / `redteam-run.mjs` 不会暴露该问题；只有真实 Electron Host 或 `ELECTRON_RUN_AS_NODE=1` 能复现。

### 4.5 并发（灰区）

- 安静窗口下 2 路并发 8/8 成功、3 路并发 6/6 成功、同 profile 名/不同 profile 名同时启动 6/6 成功。
- 但曾在两轮“两个探针同时跑”的试验中观察到 4 个探针都 exit 1、无 stderr（当时有第三个第三方探针同时运行）；之后无法在受控条件下复现。**不确定**，但代码里没有锁或唯一 profile 名（固定 `guard-probe`），建议按 D9 处理。

## 5. 发现的缺陷

### D1【严重 · 数据丢失】Electron 清理跟随 junction，删除被检查包的源码

- 证据：§4.4；`cleanupOk=true` 的同时源目录文件数变为 0。
- 根因：`removeDir` 直接 `rmSync(home,{recursive:true})`；Electron 的 fs 在递归删除时跟随 pnpm 创建的 junction。
- 修法（已验证）：用安全 walker 替代 `rmSync`——对 `lstat().isSymbolicLink()` 的条目用 `rmdirSync`，绝不递归进入；其余目录/文件再删；失败则 `cleanupOk=false` 并上报。或先把候选包复制进探针 home 再 `link:` 副本。`steps-safe.mjs` 实测：目标 3 个文件完好、home 已删。另建议把 `cleanupOk` 暴露到工具输出，并在 `ELECTRON_RUN_AS_NODE=1` 下跑自测。

### D2【严重 · 误判】自建 HTTP 服务 + 伪造 `dsh web:` 行 → 判 OK 且可安装

- 证据：`rt-spoof-http` 3/3 `OK`，URL `http://127.0.0.1:52846/`（无 token），boot 2040–2245 ms；门禁 `ok:true` 并安装；实时工具输出“启动成功”“隔离环境里真实启动成功”。
- 根因：`servesHttp` 接受 200–499（含 401/403/404/303），`READY_RE` 前缀可被插件伪造，且没有 `dsh web:` 行时仍回退到任意 URL；HTTP 可达 ≠ DSH Web 已就绪。
- 修法：要求 DSH 专属证明——URL 必须带启动器 token，跟随后校验响应体中的 DSH 标记（实测真实根路径无 token 返回 401 `dsh web authentication required; reopen the URL printed by dsh web.`，带 token 返回 303）；去掉任意 URL 回退；更稳妥的是启动器通过文件/通道写结构化就绪信号并带一次性 nonce，探针只认该信号。注意：插件与启动器同进程，任何“可读的 nonce/token”理论上仍可伪造；本插件不是恶意代码沙箱，应在文档中写明边界。

### D3【高 · 门禁】`EXITED_CLEAN` 被安装/更新门禁放行

- 证据：`rt-exit0-import` 判定 `EXITED_CLEAN`、`crashed:false`，`plugin_guard_install` 返回 `ok:true` 并调用 `installBundle`；`plugin_guard_update` 用同一判定式。
- 修法：门禁拒绝 `EXITED_CLEAN`（或把“URL 前任何退出”统一视为不可安装）；`isCrash` 不应是唯一拒绝依据；报告给 `EXITED_CLEAN` 补结论行（当前无结论），`renderAudit` 也应把它标成“起不来”而不是中性行。

### D4【高 · 静态策略】`client-missing` 只判 `WARN`，`probe:false` 时放行；实测该包 `CRASH_EXIT`

- 证据：静态 `fail:client-missing` → `WARN`；`probe:true` 时探针 exit(1)；`probe:false` 时门禁 `ok:true` 并安装（2 ms）。
- 修法：把 `client-missing`（以及其他已证实会崩的 fail 类别，如 `entry-missing`、`bundle-patch-missing`）加入拒绝集合；任何 fail finding 存在时不允许 `probe:false` 绕过（或强制至少一次 boot 探针）；`WARN` 的“没有会崩的证据”文案在 fail 存在时应改写。

### D5【中 · 误报】伪造 `did not activate` + 行形状 stderr → 判 `SKIPPED`

- 证据：`rt-stderr-forge`（完全正常）3/3 `SKIPPED`，`skippedRows=["rt-stderr-forge"]`，Web 正常启动；门禁照常安装。
- 根因：`skippedRowsOf` 仍是“stderr 文本包含 `did not activate` + 行正则”，没有来源校验。
- 修法：优先读启动器的结构化激活结果（例如启动报告/状态文件），而不是 stderr 文本；若只能解析文本，至少校验警告行数（`N entry` 与解析出的行数一致）、行名必须属于已安装行集合、且出现在 ready 行之前；把它降级为“疑似未激活”而不是硬判定。

### D6【低 · 契约】`plugin_guard_install` 描述称会拒绝 `SKIPPED`，实际放行

- 证据：`rt-throw-apply`、`import-error`、`rt-stderr-forge` 均为 `SKIPPED`，门禁 `ok:true` 并安装；代码里拒绝条件只有 `isCrash || INSTALL_FAILED`。
- 修法：按描述补上 `SKIPPED` 拒绝，或改描述说明“跳过不阻止安装”。二者选一，别让描述与实现相反。

### D7【低 · 静态盲区】非法 YAML patch 静态零发现

- 证据：`rt-bad-patch` 静态 `STATIC_ONLY`/无 finding，`probe:false` 会提交安装（DSH 安装阶段拒绝，未造成崩溃）。
- 修法：至少做括号/流集合平衡与首行形状校验，或在静态结论里明确“未校验 patch 语义”；不要把“没有 finding”呈现为“干净”。

### D8【灰 · 时序】`apply()` 抛错的 `SKIPPED` 依赖 3 s 宽限

- 证据：本轮 4/4 命中（一次全量 + 3 次重复）；但早期版本在同夹具上测到过 3 次 `OK`（警告在 URL 之后才到达，探针已 kill）。当前实现用“kill 后等 close/3 s”捕获 stderr，宽限之外仍可能退化为 `OK`。
- 建议：把宽限提高到可配置值，或判定 `up` 后继续读 stderr 到 close（有上限），并在报告中注明该判定的时序依赖。

### D9【灰 · 并发】固定 profile 名、无锁

- 证据：安静窗口 20/20 成功；两轮“两个探针同时跑”的试验中 4 个探针都 exit 1、无 stderr（当时有第三个第三方探针同时运行），之后无法受控复现。
- 建议：profile 名加随机后缀；`PROBE_ROOT` 加进程锁或至少串行化；对“exit 1 且 stderr 为空”的探针结果做一次重试并标注。

### D10【灰 · 文档】`DESIGN.md` 与实测不一致

- `bundle` 无效：文档写 `SKIPPED`，实测是安装阶段 `INSTALL_FAILED`（DSH 直接拒绝安装）。
- `apply()` 抛错：文档写 `SKIPPED`，实测依赖 stderr 到达时序（D8）。
- 建议同步文档，避免后续实现按错误语义写测试。

### D11【中 · 清理/凭据】清理偶发失败时静默残留含 `.credentials.yaml` 的探针 home

- 证据：§4.1，实时路径残留 `D:\Temp\dsh-plugin-guard\home-mwd048md-jrrq65`（11:41:45），内含 `.credentials.yaml` 161 B；脚本化 15/15 干净；`plugin_guard_check` 文本输出不含 `cleanupOk`。
- 风险：凭据文件留在临时目录，`pruneStale` 默认要 2 小时才清；共享机器/多用户场景是信息暴露面，也占磁盘。
- 修法：清理失败时在工具输出里显式告警并列出 home 路径；下一次探针开始时立即重试清理；清理前先删除 `.credentials.yaml` 等敏感文件；把 `PRUNE` 阈值调短；或把探针 home 放到专用短生命周期目录。

## 6. 建议修法（按优先级）

1. **先修 D1（数据丢失）**。在 `lib/probe.mjs` 用安全 walker 替代 `removeDir` 的 `rmSync`；对 junction/symlink 只做 `rmdirSync`，不递归；`cleanupOk=false` 时上报。补一条在 `ELECTRON_RUN_AS_NODE=1` 下运行的自测，断言“删除 home 后链接目标仍在”。在修复前，不要对含 `link:` 插件的 profile 跑 `plugin_guard_audit depth=boot`，也不要用 `plugin_guard_check` 检查本地目录。
2. **修 D2（可伪造就绪）**。把“URL 可达”升级为“DSH 专属就绪证明”（token + body 标记/结构化信号）；删除任意 URL 回退；对 401/303 显式处理而不是一律接受。
3. **修 D3/D4（门禁与静态策略）**。`EXITED_CLEAN`、`client-missing` 等已证实起不来的结论必须拒绝安装/更新；`probe:false` 不能绕过 fail。
4. **修 D5（SKIPPED 误报）**。改为结构化激活结果；文本解析只作降级证据。
5. **修 D6/D7/D10（契约与文档）**。让描述、DESIGN 与实际判定一致；补静态 YAML 校验或明确边界。
6. **D8/D9（时序与并发）**。加宽限/重试/唯一 profile 名/锁，并在报告里标注时序依赖。
7. **D11（清理与凭据）**。清理失败必须可见；先删 `.credentials.yaml`；缩短 stale home 的保留时间。
8. **测试层**。把本轮 `rt-*` 夹具纳入自测；至少增加：`rt-spoof-http`（应判 `CRASH_HANG`）、`rt-stderr-forge`（应判 `OK`）、`rt-exit0-import`（门禁必须拒绝）、`rt-client-missing`（`probe:false` 必须拒绝）、以及“本地目录检查后源码仍在”的 Electron 模式测试。

## 7. 附录：脚本、数据与夹具

- 固定快照：`D:\WORK1\redteam\snap-1138\`（代码 + 夹具副本，哈希见 §1）。
- 原始测量：`D:\WORK1\redteam\snapshot-results.json`（15 个探针的 status/exitCode/url/steps/skippedRows/cleanup/verdict/gate）。
- 脚本：`run-snapshot.mjs`（全量）、`gate-snapshot.mjs`（真实工具 + 假 manager）、`repeat-snapshot.mjs`（重复性 + 真实 profile 隔离）、`probe-one.mjs`（单例）、`steps-electron.mjs`（删除步骤追踪）、`steps-safe.mjs`（安全清理验证）、`deltest.mjs` / `deltest2.mjs` / `deltest3.mjs`（Node vs Electron 的 junction 删除差异）、`fetch-real-web.mjs`（真实 Web 响应：无 token 401 / 带 token 303）。
- 新增夹具（`tests/fixtures/rt-*`）：`rt-exit0-import`、`rt-hang-apply`、`rt-throw-apply`、`rt-bad-patch`、`rt-engine-mismatch`、`rt-client-missing`、`rt-good`、`rt-exit9-apply`、`rt-hang-child`、`rt-spoof-url`、`rt-spoof-url-sync`、`rt-spoof-http`、`rt-stderr-noise`、`rt-stderr-forge`。原有 `good`、`crash-exit`、`hang`、`import-error` 未改动；`tests/fixtures/bad-patch/` 不是本次新增。
- 说明：实时检查过程中，本报告的部分 `rt-*` 夹具内容曾被清空（与 D1 的机制一致），已按 §1 快照恢复并逐一核对 `package.json`/`index.js`/`cordis.patch.yml` 齐全；这正是 D1 在真实环境中的后果之一。


## 8. 第二轮修复记录（收到本报告后，2026-11-12 12:xx）

报告绑定的是 11:38 快照；以下是针对 D1–D5 及附带项的修复与回归证据。

| 编号 | 状态 | 修复 | 回归证据 |
|---|---|---|---|
| D1 数据丢失 | **已修** | `lib/probe.mjs` 用安全 walker `removeTreeSafe` 替代 `fs.rmSync`：`lstat().isSymbolicLink()` 的条目只 `unlink/rmdir`，绝不递归进入；`removeProbeHome` 失败重试 5 次并先删 `.credentials.yaml`；`pruneStale` 同样走安全 walker，阈值 30 分钟 | `tests/junction-safety.mjs` 7/7：在 **Electron-as-node** 下建 junction→调用 `removeProbeHome`→源目录 4 个文件仍在、home 已删；修复前该场景源目录被清空（报告 §4.4 同机制） |
| D2 自建 HTTP 伪造就绪 | **已修（提高门槛）** | 探针自己选空闲端口并用 `--port <P>` 启动；只接受端口等于 P、且能走完真实 DSH 认证（303 + Set-Cookie → 200 页面含 `__DSH_BOOT__`）的地址；删除“任意 URL”回退 | `tests/selftest.mjs` 中 `rt-spoof-http` 由 `OK` 变为 `CRASH_HANG`；`rt-spoof-url`、`rt-spoof-url-sync` 同为 `CRASH_HANG` |
| D3 EXITED_CLEAN 放行 | **已修** | 新增 `blocksInstall()`：`CRASH_EXIT` / `CRASH_HANG` / `EXITED_CLEAN` / `INSTALL_FAILED` / `PROBE_UNAVAILABLE` 一律拒绝安装与更新 | `tests/tooltest.mjs`：对 `rt-exit0-import` 安装返回 `ok:false` 且未调用 `installBundle` |
| D4 静态 fail 放行 | **已修** | `probe:false` 时，任何 fail 级 finding（entry-missing、bundle-patch-missing / syntax、client-missing、engines/peer 不满足、平台不符）都拒绝；另外补了 patch 结构校验（括号/引号/制表符），`rt-bad-patch` 现在静态即 `bundle-patch-syntax` | `tests/tooltest.mjs`：`rt-client-missing` 在 `probe:false` 下被拒；`rt-bad-patch` 静态被拒；`good` 静态放行 |
| D5 伪造 SKIPPED | **已修（降低误报）** | `skippedRowsOf` 现在要求：出现 `did not activate` 汇总行、stderr 内有真实堆栈帧（`^    at `）、行名属于候选自身（包名或 patch 行 id） | `tests/selftest.mjs`：`rt-stderr-forge` 由 `SKIPPED` 变为 `OK`；`rt-stderr-noise` 保持 `OK`；真实失败 `import-error` / `rt-throw-apply` 仍判 `SKIPPED` |
| D6 描述与实现相反 | 已修 | `plugin_guard_install` / `_update` 描述改为“崩溃/卡死/未就绪退出/装不上/探针不可用才拒绝；SKIPPED 会安装并回报” | 描述文本 |
| D7 非法 YAML 静态盲区 | 已修 | `manifest.mjs` 增加 `patchSyntaxIssue`：引号闭合、`[]{}` 配对、禁止制表符缩进；含块标量或 `!!js` 时跳过（交给安装阶段） | `rt-bad-patch` 静态 → fail `bundle-patch-syntax` |
| D8 apply 抛错的时序依赖 | 已缓解（文档化） | kill 后等 close（最多 3 s）再读 stderr；README「限制」写明该判定依赖 stderr 汇总 + 堆栈 | 本轮 selftest 中 `rt-throw-apply` 稳定 `SKIPPED` |
| D9 并发 | 已缓解 | profile 名改为 `guard-probe-<rand>`，home 名字本就随机；未加跨进程锁，README 写明 | — |
| D10 文档与实测不一致 | 已修 | DESIGN.md 语义表更新：bundle patch 无效 → `INSTALL_FAILED`；apply 抛错 → `SKIPPED`（依赖 stderr）；新增 EXITED_CLEAN / 缺客户端 / 自建 HTTP 三行 | DESIGN.md §1 |
| D11 残留含凭据的 home | 已修 | `removeProbeHome` 先删 `.credentials.yaml`；清理失败在报告里显式提示并给出路径；`pruneStale` 阈值 2 h → 30 min | 报告渲染新增 cleanup 行；selftest 每个夹具断言 home 已删 |

复跑结果（修复后）：`selftest` 65/65、`tooltest` 29/29、`junction-safety` 7/7；`redteam-run.mjs` 全矩阵无 `OK` 误判、无崩溃漏判。
