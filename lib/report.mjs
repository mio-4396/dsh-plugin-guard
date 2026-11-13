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
  UPGRADE_OK: '升级演练通过',
  UPGRADE_WARN: '能启动，但有插件会失效',
  UPGRADE_CRASH: '升级后 DSH 会起不来',
  RUNTIME_UNRESOLVED: '找不到可用的候选运行时',
  PROFILE_UNAVAILABLE: '找不到要演练的 profile',
  PROBE_FAILED: '演练过程出错',
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
  if (probe !== null && probe.cleanupOk === false) {
    lines.push(`注意：临时探针目录没能删掉（可能仍被占用），下次启动会清理：${probe.home ?? '(未知路径)'}`)
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
  } else if (result.verdict === VERDICT.EXITED_CLEAN) {
    lines.push('')
    lines.push('结论：进程在 Web 就绪前就退出了（退出码 0 也一样），效果等同于起不来；不要安装。')
  } else if (result.verdict === VERDICT.SKIPPED) {
    lines.push('')
    lines.push('结论：DSH 能起来，但这一行会被跳过，装了也不生效。')
  } else if (result.verdict === VERDICT.WARN && groups.fail.length > 0) {
    lines.push('')
    lines.push('结论：静态检查有失败项（见上），不要把它们当成普通警告；这类包可以直接拒绝。')
  }
  return lines.join('\n')
}

/**
 * Render several check results as one audit table.
 * @param results - check results in display order.
 * @returns the rendered audit.
 */
export function renderAudit(results) {  if (results.length === 0) return '没有可检查的插件。'
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

/** One line describing the rehearsal boot outcome. */
function rehearsalBootLine(boot) {
  if (boot === null || boot === undefined) return '未运行启动预演'
  switch (boot.status) {
    case 'up':
      return `启动成功：${boot.url ?? '(未打印地址)'}（${boot.elapsedMs}ms）`
    case 'exit':
      return `候选运行时在打印 Web 地址前退出，退出码 ${String(boot.code)}（${boot.elapsedMs}ms）`
    case 'hang':
      return `候选运行时启动无响应：等待 ${Math.round(boot.elapsedMs / 1000)}s 没有 Web 地址`
    case 'error':
      return '候选运行时无法启动'
    default:
      return `启动预演异常：${boot.status}`
  }
}

/**
 * Render one upgrade rehearsal.
 * @param result - the record from `rehearseUpgrade`.
 * @returns the rendered report.
 */
export function renderRehearsal(result) {
  const lines = []
  const newVersion = result.runtime?.version ?? '未知版本'
  const currentVersion = result.currentVersion ?? '当前版本未知'
  lines.push(`结论：${verdictLabel(result.verdict)}（${result.verdict}）`)
  lines.push(`版本：${currentVersion} → ${newVersion}`)
  if (result.runtime !== null && result.runtime !== undefined) {
    const kind = result.runtime.kind === 'installer' ? '安装包（已解包，未安装）' : '安装目录'
    lines.push(`候选运行时：${kind} · ${result.runtime.appRoot ?? result.source}`)
  }
  lines.push(`profile：${result.profile?.source ?? '未知'}（复制 ${result.profile?.files?.length ?? 0} 个文件到隔离 home）`)
  if (result.install !== null && result.install !== undefined) {
    lines.push(`隔离安装：${result.install.status}${result.install.code === null || result.install.code === undefined ? '' : `(${result.install.code})`} ${result.install.elapsedMs}ms`)
  }
  lines.push(`启动预演：${rehearsalBootLine(result.boot)}`)
  if (result.compatibility !== null && result.compatibility !== undefined) {
    lines.push(`兼容性：检查 ${result.compatibility.checked} 个包，${result.compatibility.incompatible.length} 个不兼容，${result.compatibility.missing.length} 个未能读取清单`)
  }

  if ((result.compatibility?.incompatible.length ?? 0) > 0) {
    lines.push('')
    lines.push('换到新版本后会被拒绝或跳过的插件')
    for (const item of result.compatibility.incompatible.slice(0, 20)) {
      const where = item.kind === 'engines' ? `engines.dsh "${item.requirement}"` : `peer ${item.requirement}`
      lines.push(`- ${item.name}${item.version === undefined ? '' : `@${item.version}`}：${where} 不包含 ${newVersion}`)
    }
    if (result.compatibility.incompatible.length > 20) lines.push(`- …另有 ${result.compatibility.incompatible.length - 20} 个`)
  }
  if (result.skipped.length > 0) {
    lines.push('')
    lines.push(`启动时被跳过 / 未激活：${result.skipped.join(', ')}`)
  }
  if (result.verdict === 'UPGRADE_CRASH' && result.boot?.stderrTail) {
    lines.push('')
    lines.push('崩溃证据（候选运行时的 stderr 尾部）')
    for (const line of String(result.boot.stderrTail).trim().split(/\r?\n/).slice(-18)) lines.push(`  ${line}`)
  }
  if (result.reason !== undefined) {
    lines.push('')
    lines.push(`原因：${result.reason}`)
  }
  if (result.findings !== undefined && result.findings.length > 0) {
    lines.push('')
    for (const item of result.findings) lines.push(`- [${item.level}] ${item.code}：${item.message}`)
  }
  if (result.cleanupOk === false) {
    lines.push('')
    lines.push(`注意：演练用的临时目录没能删除，下次启动会清理：${result.home ?? '(未知路径)'}`)
  }

  lines.push('')
  if (result.verdict === 'UPGRADE_OK') {
    lines.push('建议：可以升级。升级后仍有插件被跳过时，按上面的兼容性清单放宽 engines.dsh 或禁用对应插件。')
  } else if (result.verdict === 'UPGRADE_WARN') {
    lines.push('建议：能升级，但先处理上面列出的插件（放宽 engines.dsh / 暂时禁用），否则升级后它们不生效。')
  } else if (result.verdict === 'UPGRADE_CRASH') {
    lines.push('建议：不要直接升级。先用 plugin_guard_check / plugin_guard_audit 定位会崩的插件，再重试演练。')
  } else {
    lines.push('建议：先解决上面的原因，再重新演练。')
  }
  return lines.join('\n')
}
