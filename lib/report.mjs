/**
 * Turn analysis findings plus a probe result into one verdict, and render that
 * verdict for a person reading a tool result.
 *
 * @module plugin-guard/lib/report
 */

/** Verdict identifiers. `CRASH_EXIT` and `CRASH_HANG` are the only "will crash" outcomes. */
export const VERDICT = {
  OK: 'OK',
  WARN: 'WARN',
  SKIPPED: 'SKIPPED',
  DENIED: 'DENIED',
  INSTALL_FAILED: 'INSTALL_FAILED',
  CRASH_EXIT: 'CRASH_EXIT',
  CRASH_HANG: 'CRASH_HANG',
  EXITED_CLEAN: 'EXITED_CLEAN',
  STATIC_ONLY: 'STATIC_ONLY',
  PROBE_UNAVAILABLE: 'PROBE_UNAVAILABLE',
}

const LABELS = {
  OK: '可以安装',
  WARN: '有风险，但没有会崩的证据',
  SKIPPED: '能启动，但这个插件不会生效',
  DENIED: '版本要求不满足，DSH 会拒绝它',
  INSTALL_FAILED: '装不上',
  CRASH_EXIT: '会让 DSH 起不来（进程直接退出）',
  CRASH_HANG: '会让 DSH 卡死（启动无响应）',
  EXITED_CLEAN: '启动未就绪就退出',
  STATIC_ONLY: '只做了静态检查',
  PROBE_UNAVAILABLE: '探针不可用，只做了静态检查',
}

/** Codes that make DSH deny a plugin row outright rather than load it. */
const DENIAL_CODES = new Set([
  'engines-dsh-mismatch',
  'engines-dsh-invalid',
  'peer-mismatch',
  'peer-invalid',
  'platform-mismatch',
])

/** Human label for one verdict. */
export function verdictLabel(verdict) {
  return LABELS[verdict] ?? verdict
}

/**
 * Decide the verdict from static findings and the optional probe outcome.
 * @param input - static findings and the probe result (null for static-only).
 * @returns the verdict identifier.
 */
export function verdictFrom(input) {
  const findings = input.findings ?? []
  const probe = input.probe ?? null
  if (probe === null || probe === undefined) {
    if (findings.some((item) => DENIAL_CODES.has(item.code))) return VERDICT.DENIED
    if (findings.some((item) => item.level === 'fail')) return VERDICT.WARN
    return VERDICT.STATIC_ONLY
  }
  switch (probe.status) {
    case 'unavailable':
      return findings.some((item) => DENIAL_CODES.has(item.code)) ? VERDICT.DENIED : VERDICT.PROBE_UNAVAILABLE
    case 'install-failed':
      return VERDICT.INSTALL_FAILED
    case 'exit':
      return probe.exitCode === 0 ? VERDICT.EXITED_CLEAN : VERDICT.CRASH_EXIT
    case 'hang':
      return VERDICT.CRASH_HANG
    case 'error':
      return VERDICT.PROBE_UNAVAILABLE
    case 'up':
      if (probe.skippedRows.length > 0) return VERDICT.SKIPPED
      if (findings.some((item) => item.level === 'fail')) return VERDICT.WARN
      return VERDICT.OK
    default:
      return VERDICT.PROBE_UNAVAILABLE
  }
}

/** Whether a verdict means "DSH would not start". */
export function isCrash(verdict) {
  return verdict === VERDICT.CRASH_EXIT || verdict === VERDICT.CRASH_HANG
}

/** One line describing the probe outcome. */
function probeLine(probe) {
  if (probe === null) return '未运行启动预演'
  const steps = probe.steps.map((step) => `${step.name} ${step.status}${step.code === null || step.code === undefined ? '' : `(${step.code})`} ${step.elapsedMs}ms`).join(' · ')
  switch (probe.status) {
    case 'up':
      return `启动成功：${probe.url ?? '(未打印地址)'}（${probe.elapsedMs}ms）`
    case 'exit':
      return `进程在打印 Web 地址前退出，退出码 ${String(probe.exitCode)}（${probe.elapsedMs}ms）`
    case 'hang':
      return `启动无响应：等待 ${Math.round(probe.elapsedMs / 1000)}s 没有 Web 地址，已强制结束`
    case 'install-failed':
      return `安装失败（${probe.elapsedMs}ms）`
    case 'unavailable':
      return `探针不可用：${probe.reason ?? '未知原因'}`
    default:
      return `探针异常：${probe.status}`
  }
}

/** Indent a block of captured output under one bullet. */
function outputBlock(text, limit = 1200) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const clipped = text.trim().length > limit ? `…${text.trim().slice(-limit)}` : text.trim()
  return clipped.split(/\r?\n/).slice(0, 18).map((line) => `  ${line}`)
}

/** Group findings by level, keeping the first occurrence of each code. */
function groupFindings(findings) {
  const seen = new Set()
  const groups = { fail: [], warn: [], info: [] }
  for (const item of findings) {
    const key = `${item.level}|${item.code}|${item.where ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    if (groups[item.level] === undefined) groups.info.push(item)
    else groups[item.level].push(item)
  }
  return groups
}

/**
 * Render one check result as compact text.
 * @param result - `{ target, resolved, depth, verdict, findings, probe }`.
 * @returns the rendered report.
 */
export function renderCheck(result) {
  const lines = []
  const probe = result.probe ?? null
  lines.push(`判定：${verdictLabel(result.verdict)}（${result.verdict}）`)
  const identity = result.resolved?.version === undefined
    ? `${result.target}`
    : `${result.resolved.name ?? result.target}@${result.resolved.version}`
  lines.push(`目标：${identity}${result.resolved?.kind === 'directory' ? '（本地目录）' : ''}`)
  lines.push(`启动预演：${probeLine(probe)}`)
  if (probe !== null && probe.steps.length > 0) {
    lines.push(`步骤：${probe.steps.map((step) => `${step.name} ${step.status}${step.code === null || step.code === undefined ? '' : `(${step.code})`} ${step.elapsedMs}ms`).join(' · ')}`)
  }

  const groups = groupFindings(result.findings ?? [])
  if (isCrash(result.verdict)) {
    lines.push('')
    lines.push('崩溃证据')
    lines.push(`- 启动预演：${probeLine(probe)}`)
    const stderr = outputBlock(probe?.stderr ?? '')
    if (stderr.length > 0) {
      lines.push('- 子进程 stderr（尾部）：')
      lines.push(...stderr)
    }
    const skipped = probe?.skippedRows ?? []
    if (skipped.length > 0) lines.push(`- 未激活的行：${skipped.join(', ')}`)
  }

  const section = (title, items, prefix) => {
    if (items.length === 0) return
    lines.push('')
    lines.push(title)
    for (const item of items.slice(0, 12)) {
      lines.push(`- ${prefix}${item.code}${item.where === undefined ? '' : ` @ ${item.where}`}：${item.message}`)
    }
    if (items.length > 12) lines.push(`- …另有 ${items.length - 12} 条`)
  }
  section('失败项', groups.fail, '[fail] ')
  section('风险项', groups.warn, '[warn] ')
  section('提示项', groups.info, '[info] ')

  if (result.verdict === VERDICT.OK) {
    lines.push('')
    lines.push('结论：隔离环境里真实启动成功，没有会让 DSH 起不来的迹象。')
  } else if (isCrash(result.verdict)) {
    lines.push('')
    lines.push('结论：不要安装这个版本。DSH 下次启动会停在它上面。')
  } else if (result.verdict === VERDICT.SKIPPED) {
    lines.push('')
    lines.push('结论：DSH 能起来，但这一行会被跳过，装了也不生效。')
  }
  return lines.join('\n')
}

/**
 * Render several check results as one audit table.
 * @param results - check results in display order.
 * @returns the rendered audit.
 */
export function renderAudit(results) {
  if (results.length === 0) return '没有可检查的插件。'
  const lines = []
  const counts = new Map()
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1)
  const summary = [...counts.entries()].map(([verdict, count]) => `${verdictLabel(verdict)}×${count}`).join('，')
  lines.push(`共 ${results.length} 个插件：${summary}`)
  lines.push('')
  for (const result of results) {
    const name = result.resolved?.name ?? result.target
    const version = result.resolved?.version === undefined ? '' : `@${result.resolved.version}`
    const top = (result.findings ?? []).find((item) => item.level === 'fail')
      ?? (result.findings ?? []).find((item) => item.level === 'warn')
    const probe = result.probe
    let evidence
    if (probe !== null && probe !== undefined) {
      switch (probe.status) {
        case 'up':
          evidence = `启动成功 ${probe.elapsedMs}ms`
          break
        case 'exit':
          evidence = `启动退出 code=${String(probe.exitCode)} ${probe.elapsedMs}ms`
          break
        case 'hang':
          evidence = `启动卡死 ${Math.round(probe.elapsedMs / 1000)}s`
          break
        case 'install-failed':
          evidence = '探针安装失败'
          break
        default:
          evidence = top === undefined ? `探针：${probe.status}` : `${top.code}`
      }
    } else if (top !== undefined) {
      evidence = top.code
    } else {
      evidence = '无'
    }
    lines.push(`- ${verdictLabel(result.verdict)} · ${name}${version} · ${evidence}`)
  }
  return lines.join('\n')
}
