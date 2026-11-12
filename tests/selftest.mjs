/**
 * Self-test for dsh-plugin-guard.
 *
 * Run from the package root: `node tests/selftest.mjs`.
 * The boot probes use the installed DSH launcher (override with
 * DSH_GUARD_LAUNCHER_EXE / DSH_GUARD_LAUNCHER_CLI) and take about 40 s total
 * because one fixture has to reach a boot timeout.
 */

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeManifest, LEVEL } from '../lib/manifest.mjs'
import { resolveTarget } from '../lib/plan.mjs'
import { createLauncher, PROBE_ROOT, runBootProbe } from '../lib/probe.mjs'
import { isCrash, renderCheck, verdictFrom, VERDICT } from '../lib/report.mjs'
import { scanPackage } from '../lib/scan.mjs'
import { compareVersions, isValidRange, satisfies } from '../lib/semver.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const runtimeVersion = '0.2.2-rc.1'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`ok   ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------- semver
const SEMVER_CASES = [
  ['0.2.2-rc.1', '>=0.2.0 <0.3.0', true],
  ['0.2.2-rc.1', '^0.2.0', true],
  ['0.3.0', '>=0.2.0 <0.3.0', false],
  ['1.2.3', '^1.2.0', true],
  ['2.0.0', '^1.2.0', false],
  ['1.2.9', '~1.2.3', true],
  ['1.3.0', '~1.2.3', false],
  ['0.0.4', '^0.0.3', false],
  ['1.5.0', '1.x', true],
  ['3.0.0', '1 || 3', true],
  ['0.2.2', 'workspace:^', false],
  ['0.2.2', '*', true],
]
for (const [version, range, want] of SEMVER_CASES) {
  check(`semver ${version} ⊨ ${range}`, satisfies(version, range) === want)
}
check('semver rc sorts before release', compareVersions('0.2.2-rc.1', '0.2.2') === -1)
check('semver rejects workspace range', isValidRange('workspace:^') === false)

// ---------------------------------------------------------------- static
const goodDir = path.join(fixtures, 'good')
const goodAnalysis = analyzeManifest(goodDir, { runtimeVersion, platform: 'win32' })
check('manifest finds the entry', goodAnalysis.facts.entryPath === path.join(goodDir, 'index.js'), goodAnalysis.facts.entryPath)
check('manifest finds the bundle patch', goodAnalysis.facts.hasBundle && goodAnalysis.facts.bundlePatchPaths.length === 1)
check('manifest reads the row name', goodAnalysis.rowNames.includes('guard-fixture-good'))
check('manifest admits a matching engines.dsh', !goodAnalysis.findings.some((item) => item.code === 'engines-dsh-mismatch'))

const mismatchDir = path.join(fixtures, 'crash-exit')
mismatchDir // fixture is analysed below through resolveTarget for the static path

const badEngineDir = path.join(fixtures, 'good')
const badEngine = analyzeManifest(badEngineDir, { runtimeVersion: '9.9.9', platform: 'win32' })
check('manifest flags an engines.dsh mismatch', badEngine.findings.some((item) => item.code === 'engines-dsh-mismatch'), JSON.stringify(badEngine.findings))

const realPlugin = 'D:/dsh-tools/dsh-file-menu'
if (existsSync(realPlugin)) {
  const analysis = analyzeManifest(realPlugin, { runtimeVersion, platform: 'win32' })
  const scan = scanPackage(realPlugin, { entries: [analysis.facts.entryPath, analysis.facts.clientPath] })
  check('real plugin scans clean of fail findings', !analysis.findings.some((item) => item.level === LEVEL.FAIL), JSON.stringify(analysis.findings))
  check('real plugin has no hazard warnings', !scan.findings.some((item) => item.level === LEVEL.WARN), JSON.stringify(scan.findings))
  check('real plugin scan reads the runtime graph only', scan.scanned <= 4, String(scan.scanned))
}

// ---------------------------------------------------------------- plan
const goodTarget = resolveTarget(goodDir, {})
check('plan resolves a directory', goodTarget.ok === true && goodTarget.kind === 'directory' && goodTarget.name === 'guard-fixture-good')
const specTarget = resolveTarget('some-package@1.2.3', {})
check('plan resolves a versioned spec', specTarget.ok === true && specTarget.kind === 'spec')
const badTarget = resolveTarget('', {})
check('plan rejects an empty target', badTarget.ok === false)

// ---------------------------------------------------------------- probe
function launcher() {
  const exe = process.env.DSH_GUARD_LAUNCHER_EXE
  const cliJs = process.env.DSH_GUARD_LAUNCHER_CLI
  if (exe !== undefined && cliJs !== undefined && existsSync(cliJs)) return { ok: true, exe, cliJs }
  const detected = createLauncher()
  if (detected.ok === true) return detected
  const installed = 'D:\\DeepSeek Harness\\DeepSeek Harness.exe'
  const installedCli = 'D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'
  if (existsSync(installed)) return { ok: true, exe: installed, cliJs: installedCli }
  return detected
}

const probeLauncher = launcher()
if (probeLauncher.ok !== true) {
  console.log(`SKIP boot probes: ${probeLauncher.reason}`)
} else {
  const cases = [
    { name: 'good', expect: VERDICT.OK },
    { name: 'import-error', expect: VERDICT.SKIPPED },
    { name: 'crash-exit', expect: VERDICT.CRASH_EXIT },
    { name: 'hang', expect: VERDICT.CRASH_HANG },
    // Adversarial: the shape of each failure the boot probe must not miss.
    { name: 'rt-exit0-import', expect: VERDICT.EXITED_CLEAN },
    { name: 'rt-throw-apply', expect: VERDICT.SKIPPED },
    { name: 'rt-exit9-apply', expect: VERDICT.CRASH_EXIT },
    { name: 'rt-spoof-url', expect: VERDICT.CRASH_HANG, timeoutMs: 12_000 },
    { name: 'rt-stderr-noise', expect: VERDICT.OK },
    { name: 'rt-client-missing', expect: VERDICT.CRASH_EXIT },
  ]
  for (const item of cases) {
    const dir = path.join(fixtures, item.name)
    const resolved = resolveTarget(dir, {})
    const analysis = analyzeManifest(dir, { runtimeVersion, platform: 'win32' })
    const scan = scanPackage(dir, { entries: [analysis.facts.entryPath] })
    const findings = [...resolved.findings, ...analysis.findings, ...scan.findings]
    const probe = await runBootProbe(resolved, { launcher: probeLauncher, bootTimeoutMs: item.timeoutMs ?? 60_000 })
    const verdict = verdictFrom({ findings, probe })
    const result = { target: item.name, resolved, depth: 'boot', verdict, findings, probe }
    check(`probe ${item.name} → ${item.expect}`, verdict === item.expect, `${verdict} (probe ${probe.status} code ${probe.exitCode})`)
    check(`probe ${item.name} cleans up`, probe.cleanupOk === true && !existsSync(probe.home), probe.home)
    if (isCrash(verdict)) {
      check(`probe ${item.name} reports a crash verdict`, verdict === VERDICT.CRASH_EXIT || verdict === VERDICT.CRASH_HANG)
      check(`probe ${item.name} renders evidence`, renderCheck(result).includes('崩溃证据'))
    }
  }
  const staleRoot = path.join(PROBE_ROOT)
  if (existsSync(staleRoot)) {
    const leftovers = []
    for (const entry of (await import('node:fs')).readdirSync(staleRoot)) leftovers.push(entry)
    check('no probe home left behind', leftovers.length === 0, leftovers.join(','))
  }
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
