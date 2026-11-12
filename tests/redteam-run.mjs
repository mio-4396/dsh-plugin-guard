import { analyzeManifest } from '../lib/manifest.mjs'
import { resolveTarget } from '../lib/plan.mjs'
import { createLauncher, runBootProbe } from '../lib/probe.mjs'
import { verdictFrom } from '../lib/report.mjs'
import { scanPackage } from '../lib/scan.mjs'

const names = process.argv.slice(2)
const launcher = createLauncher()
for (const name of names) {
  const dir = `D:/dsh-tools/dsh-plugin-guard/tests/fixtures/${name}`
  const resolved = resolveTarget(dir, {})
  const analysis = analyzeManifest(dir, { runtimeVersion: '0.2.2-rc.1', platform: 'win32' })
  const scan = scanPackage(dir, { entries: [analysis.facts.entryPath, analysis.facts.clientPath] })
  const findings = [...resolved.findings, ...analysis.findings, ...scan.findings]
  const probe = await runBootProbe(resolved, { launcher, bootTimeoutMs: 25000 })
  const verdict = verdictFrom({ findings, probe })
  console.log(`${name}\t${verdict}\tprobe=${probe.status}\texit=${probe.exitCode}\tskipped=${probe.skippedRows.join('|')}\t${probe.elapsedMs}ms\tfails=${findings.filter((f) => f.level === 'fail').map((f) => f.code).join('|') || '-'}`)
}

