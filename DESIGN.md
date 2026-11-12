# dsh-plugin-guard · 设计契约（实现前冻结）

> 目标：在插件**安装 / 更新**前后判断「它会不会让 DSH 起不来」，并给出证据、必要时阻止或回滚。
> 本文件冻结模块接口与判定模型；实现须与之一致。

## 1. 已验证的 DSH 崩溃语义（实测，非推测）

运行环境：Desktop 0.2.2-rc.1，启动器 `DeepSeek Harness.exe --expose-internals <app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`。

| 情形 | 实测结果 | 判定 |
|---|---|---|
| 插件 import 抛异常 | 启动继续，stderr `warning: 1 entry did not activate`，插件被跳过 | `SKIPPED`（不崩，但不生效） |
| 插件 `apply()` 抛异常 | 同上，启动继续 | `SKIPPED` |
| 插件模块顶层 `process.exit(9)` | 进程退出码 9，Web 端口未起 | `CRASH_EXIT` |
| 插件模块顶层死循环 | 进程不返回，端口永不起 | `CRASH_HANG` |
| `apply()` 抛异常 | 启动继续，该行报 `did not activate` | `SKIPPED` |
| `apply()` 里 `process.exit(9)` | 进程退出码 9 | `CRASH_EXIT` |
| `apply()` 里死循环 | Web 端口不起 | `CRASH_HANG` |
| 声明 `dsh.client` 但客户端文件缺失 | Web 启动 exit=1 | `CRASH_EXIT` |
| 插件自己打印假 Web 地址 | 真地址未起；假地址 HTTP 不通 | `CRASH_HANG`（探针须做 HTTP 校验） |
| bundle（`dsh.bundle.patch`）声明无效 | 安装阶段即被拒绝 | `INSTALL_FAILED` |
| `engines.dsh` / DSH peer 不满足 | 安装阶段即被拒绝，插件行被拒绝 | `INSTALL_FAILED` / `DENIED` |
| 正常插件 | 约 2–3 s 起 Web，打印 `http://127.0.0.1:<port>` | `OK` |

**结论**：唯一可靠的“会不会崩”判据是**真实启动**。模块能否 import、patch 能否解析都只是线索。

## 2. 检测分层

- `static`（<200 ms）：读 manifest / exports / bundle patch / engines / peers / 入口文件；危险模式扫描。
- `boot`（约 4–8 s）：在**完全隔离的临时 DSH_HOME** 里，用官方启动器把候选包装进一个从 `web` 模板新建的探针 profile，真实启动 Web，按 端口/退出码/超时 判定。
- 隔离性：临时 `DSH_HOME`，不触碰真实 profile / node_modules / patch；探针目录用后即删。

## 3. 判定模型

```js
Verdict = 'OK' | 'WARN' | 'SKIPPED' | 'DENIED' | 'INSTALL_FAILED' | 'CRASH_EXIT' | 'CRASH_HANG' | 'STATIC_ONLY' | 'PROBE_UNAVAILABLE'
```

`CRASH_EXIT` / `CRASH_HANG` = **会崩**；`SKIPPED` = 装上但不会生效；`DENIED` = 版本要求不满足；`INSTALL_FAILED` = 装不上。

Finding：`{ level: 'fail' | 'warn' | 'info', code, message, where? }`。

## 4. 模块接口（全部零依赖，仅 node: 内置模块）

### `lib/semver.mjs`
```js
parseVersion(text) -> { major, minor, patch, prerelease: string[] } | null
compareVersions(a, b) -> -1 | 0 | 1
satisfies(version, range) -> boolean         // 支持 ||、空格与、>= > <= < =、^、~、x/*、部分版本
isValidRange(range) -> boolean               // 'workspace:^' 等视为无效
```

### `lib/manifest.mjs`
```js
readManifest(dirOrJsonPath) -> { ok, path, manifest, error }
analyzeManifest(pkgDir, { runtimeVersion, platform }) -> {
  facts: { name, version, type, entryPath, entrySource, hasBundle, bundlePatchPaths, clientPath, platforms, enginesDsh, nodeEngine },
  findings: Finding[],
  rowNames: string[]
}
```

### `lib/scan.mjs`
```js
scanPackage(pkgDir, { entryFiles, maxFiles, maxBytes }) -> { findings: Finding[], scanned: number }
```
危险模式：`process.exit` / `process.abort` / `while(true)` / `for(;;)` / `Atomics.wait` / 顶层 `execSync|spawnSync` / `eval|new Function` / `.node` 原生依赖 / 超大文件。

### `lib/probe.mjs`
```js
createLauncher() -> { ok, exe, cliJs, reason? }
runBootProbe(target, options) -> Promise<ProbeResult>
// target: { kind: 'directory', dir, name? } | { kind: 'spec', spec, name? }
// options: { launcher, timeoutMs = 90000, installTimeoutMs = 240000, onLog }
ProbeResult = {
  status: 'up' | 'exit' | 'hang' | 'install-failed' | 'unavailable',
  exitCode: number|null, url: string|null, elapsedMs,
  stdout: string, stderr: string,          // 尾部各 ≤ 16 KB
  skippedRows: string[],                   // 从 'did not activate' 提取
  steps: [{ name, status, elapsedMs, detail? }],
  profile: string, cleanupOk: boolean,
}
```

### `lib/report.mjs`
```js
verdictFrom({ staticFindings, probe }) -> Verdict
renderCheck(result) -> string   // 人读文本（中文为主）
renderSummary(results) -> string
```

### `lib/plan.mjs`（目标解析）
```js
resolveTarget(input, { profileDir, runtimeVersion }) ->
  { kind:'directory'|'spec'|'installed', dir?, spec, name?, version?, findings }
```
把 `名字` / 绝对目录 / `name@version` / `link:` / git URL 归一成探针可用的安装说明。

### `index.js`（Host 插件，我负责）
- `export const name = 'plugin-guard'`，`inject = ['tools']`
- 工具：`plugin_guard_check` / `plugin_guard_audit` / `plugin_guard_install` / `plugin_guard_update` / `plugin_guard_status` / `plugin_guard_restore`
- 事件：`plugin-manager/install-state`（applying 前快照）、`plugin-manager/changed`（事后静态复检）
- 不 import 任何 `@deepseek-ai/*`：工具定义直接写 JSON Schema（DSH 支持子集：type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）。

## 5. 探针实现要点（实测参数）

1. 建 profile：`<exe> --expose-internals <cliJs> <probeName> --from-default-profile web --dump-config`，≈0.3 s。
2. 装候选：`... plugin --profile <probeName> add <spec>`，≈1–4 s；`link:<dir>` 用绝对路径。
3. 启动：`... --profile <probeName> --port 0 --no-open`；stdout 出现 `http://127.0.0.1:<port>` 即 `up`。
4. 收尾：`taskkill /PID <pid> /T /F`（Windows）或 `SIGKILL`；删除临时 `DSH_HOME`。
5. 子进程环境：`ELECTRON_RUN_AS_NODE=1`，`DSH_HOME=<temp>`，删除 `DSH_PROFILE*`、`DSH_SESSION_ID`、`DSH_WEB_URL`、`DSH_SHELL`。

## 6. 文件职责

| 文件 | 职责 |
|---|---|
| `DESIGN.md`、`README.md`、`index.js`、`package.json`、`cordis.patch.yml`、`locale/*`、`icon.svg` | 插件本体与工具/事件编排 |
| `lib/semver.mjs`、`lib/manifest.mjs`、`lib/scan.mjs` | 静态层 |
| `lib/probe.mjs`、`lib/plan.mjs` | 探针层与目标归一 |
| `lib/report.mjs` | 判定与渲染 |
| `tests/selftest.mjs`、`tests/tooltest.mjs`、`tests/fixtures/*` | 验收与四类故障夹具 |
