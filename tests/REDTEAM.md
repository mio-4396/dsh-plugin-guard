# 对抗性验证（REDTEAM）

日期：2026-11-12 · 环境：Desktop 0.2.2-rc.1 / Windows / 启动器 `DeepSeek Harness.exe --expose-internals <app.asar>/dsh/…/dsh-desktop-host/lib/cli.js`

方法：`tests/fixtures/rt-*` 每个夹具都走完整链路——静态分析 → 隔离探针（临时 `DSH_HOME` + 新建 `web` profile + `pnpm add link:` + 真实启动）→ 判定。
命令：

```powershell
node tests/redteam-run.mjs rt-good rt-bad-patch rt-client-missing rt-engine-mismatch rt-exit0-import `
  rt-stderr-noise rt-spoof-url rt-hang-child rt-hang-apply rt-throw-apply rt-exit9-apply
```

## 实测矩阵

| 夹具 | 插件行为 | 实测判定 | 探针证据 | 结论 |
|---|---|---|---|---|
| `rt-good` | 正常插件 | `OK` | up，3.4 s | 对 |
| `rt-throw-apply` | `apply()` 抛异常 | `SKIPPED` | up，stderr 有 `did not activate` + 行名 | 对 |
| `rt-exit9-apply` | `apply()` 里 `process.exit(9)` | `CRASH_EXIT` | exit=9，2.4 s | 对 |
| `rt-hang-apply` | `apply()` 里死循环 | `CRASH_HANG` | 26 s 无 Web 地址 | 对 |
| `rt-exit0-import` | import 阶段 `process.exit(0)` | `EXITED_CLEAN` | exit=0，无 Web 地址 | 对（不是 OK） |
| `rt-hang-child` | import 阶段起子进程并阻塞 | `CRASH_HANG` | 26 s 无 Web 地址 | 对 |
| `rt-spoof-url` | 自己打印假 `http://127.0.0.1:9/` 再死循环 | `CRASH_HANG` | 26 s；假地址未通过 HTTP 校验 | 对（修复前会误判 up） |
| `rt-stderr-noise` | 正常插件，但 stderr 打一行「行未激活」形状的日志 | `OK` | up，无 `did not activate` | 对（修复前误判 SKIPPED） |
| `rt-bad-patch` | bundle patch 非法 YAML | `INSTALL_FAILED` | 安装阶段即拒绝 | 对 |
| `rt-engine-mismatch` | `engines.dsh` 为 `>=9.0.0` | `INSTALL_FAILED` | 安装阶段即拒绝 | 对 |
| `rt-client-missing` | 声明 `dsh.client` 但客户端文件缺失 | `CRASH_EXIT` | Web 启动 **exit=1** | 对（静态只给 fail，实为真崩） |

## 发现并已修复的两个缺陷

1. **假 Web 地址可骗过探针**：原实现只要 stdout 出现 `http://127.0.0.1:<port>` 就判 `up`，插件自己打印一个假地址即可伪造成功。
   修复：候选地址必须**真实 HTTP 可连通**（`lib/probe.mjs` 的 `servesHttp`，接受 2xx–4xx）；优先只认启动器自己的 `dsh web:` 行。
2. **stderr 形状噪声可伪造「被跳过」**：原实现把任意 `名字 (` 形状的行当成未激活行。
   修复：只有出现真实的 `did not activate` 汇总行才解析行名，且行格式要求 `名字 (定位): `。

另外修掉一个探针自伤竞态：判定 `up` 后我们 `taskkill` 掉的子进程会以 `exit 1` 触发 `close`，抢先把结论写成 `CRASH_EXIT`；现在判定后不再把自身 kill 当子进程退出。

## 剩余限制（未修，已知）

- `apply()` 抛错在 **Web 启动路径**上会给出 `did not activate` 汇总（可判 `SKIPPED`）；这一步依赖 stderr 汇总行，若上游改为只写日志文件，判定会退化为 `OK`。
- 探针跑的是 `web` 模板组合，不是 Desktop 真实组合：只依赖 Desktop 专属服务的插件可能被判 `SKIPPED`。
- 探针只在 `--port 0` 的临时实例上验证「能否起 Web」，不验证插件功能是否正确。
- 恶意插件可以在探针里表现良好、在真实 desktop 里行为不同；本插件不是沙箱。
