/**
 * Tests for the upgrade rehearsal: archive facts, compatibility analysis,
 * skipped-row parsing, and (optionally) one real rehearsal against the installed
 * runtime.
 *
 * Run from the package root:
 *   node tests/rehearse.test.mjs
 *   DSH_GUARD_REHEARSE=1 node tests/rehearse.test.mjs   # adds the slow end-to-end run
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openAsar, readAsarManifest } from '../lib/asar.mjs'
import { analyzeCompatibility, parseSkipped, pnpmOfLauncher, rehearseUpgrade } from '../lib/rehearse.mjs'
import { resolveRuntime } from '../lib/runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
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

// ---------------------------------------------------------------- asar
const installedAsar = 'D:\\DeepSeek Harness\\resources\\app.asar'
if (existsSync(installedAsar)) {
  const asar = openAsar(installedAsar)
  check('asar opens', asar !== null)
  const manifest = readAsarManifest(asar, 'dsh/package.json')
  check('asar exposes the runtime version', typeof manifest?.version === 'string', String(manifest?.version))
  check('asar lists files', asar.list().length > 1000, String(asar.list().length))
  check('asar finds the desktop CLI', asar.list().some((name) => name.endsWith('/dsh-desktop-host/lib/cli.js')))
} else {
  console.log('SKIP asar checks: DSH installation not found')
}

// A header that ends off a 4-byte boundary (0.2.2-rc.3) must still resolve its
// data base: `8 + headerSize`, not the end of the JSON text.
{
  const paddedRoot = mkdtempSync(path.join(os.tmpdir(), 'guard-asar-'))
  const paddedPath = path.join(paddedRoot, 'padded.asar')
  const payload = Buffer.from('{"hello":"world"}', 'utf8')
  const headerText = JSON.stringify({ files: { 'a.json': { offset: '0', size: String(payload.length) } } })
  const padded = Math.ceil(headerText.length / 4) * 4
  const bytes = Buffer.alloc(8 + padded + payload.length, 0x20)
  bytes.writeUInt32LE(4, 0)
  bytes.writeUInt32LE(padded, 4)
  bytes.write(headerText, 8, 'utf8')
  bytes.write(payload.toString('utf8'), 8 + padded, 'utf8')
  writeFileSync(paddedPath, bytes)
  const paddedAsar = openAsar(paddedPath)
  const read = paddedAsar === null ? null : paddedAsar.readFile('a.json')
  check('asar handles a padded header', read !== null && read.toString('utf8') === payload.toString('utf8'), read?.toString('utf8'))
  check('asar uses the aligned data base', paddedAsar?.base === 8 + padded, String(paddedAsar?.base))
  rmSync(paddedRoot, { recursive: true, force: true })
}

// ------------------------------------------------------- compatibility
const root = mkdtempSync(path.join(os.tmpdir(), 'guard-rehearse-'))
const profileDir = path.join(root, 'profile')
mkdirSync(path.join(profileDir, 'node_modules', 'good-plugin'), { recursive: true })
mkdirSync(path.join(profileDir, 'node_modules', 'old-plugin'), { recursive: true })
mkdirSync(path.join(profileDir, 'node_modules', 'peer-plugin'), { recursive: true })
writeFileSync(path.join(profileDir, 'node_modules', 'good-plugin', 'package.json'), JSON.stringify({
  name: 'good-plugin', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.4.0' },
}))
writeFileSync(path.join(profileDir, 'node_modules', 'old-plugin', 'package.json'), JSON.stringify({
  name: 'old-plugin', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.3.0' },
}))
writeFileSync(path.join(profileDir, 'node_modules', 'peer-plugin', 'package.json'), JSON.stringify({
  name: 'peer-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' },
}))
writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-test',
  dependencies: { 'good-plugin': '1.0.0', 'old-plugin': '1.0.0', 'peer-plugin': '1.0.0' },
  dsh: { profile: { bundles: ['good-plugin', 'old-plugin', 'peer-plugin'] } },
}))

const upgraded = analyzeCompatibility({ profileDir, newVersion: '0.3.0', asar: null })
check('compatibility flags an engines range that excludes the new runtime',
  upgraded.incompatible.some((item) => item.name === 'old-plugin' && item.kind === 'engines'),
  JSON.stringify(upgraded.incompatible))
check('compatibility flags a DSH peer that excludes the new runtime',
  upgraded.incompatible.some((item) => item.name === 'peer-plugin' && item.kind === 'peer'),
  JSON.stringify(upgraded.incompatible))
check('compatibility keeps matching packages', !upgraded.incompatible.some((item) => item.name === 'good-plugin'))
check('compatibility counts what it read', upgraded.checked === 3, String(upgraded.checked))

const current = analyzeCompatibility({ profileDir, newVersion: '0.2.2-rc.1', asar: null })
check('compatibility admits the running version', current.incompatible.length === 0, JSON.stringify(current.incompatible))

// ------------------------------------------------------------ skipped
const realFailure = 'dsh: warning: 1 entry did not activate\nrow-a (file:///x/index.js): failed to import: Error: boom\n    at row-a (file:///x/index.js:1:1)'
check('skipped rows need the activation summary', parseSkipped('row-a (file:///x): failed\n    at x').length === 0)
check('skipped rows need a stack frame', parseSkipped('dsh: warning: 1 entry did not activate\nrow-a (row-a): Error: boom').length === 0)
check('skipped rows parse a real failure', parseSkipped(realFailure).includes('row-a'), JSON.stringify(parseSkipped(realFailure)))
check('skipped bundles parse the launcher wording', parseSkipped('dsh: skipped bundle old-plugin: incompatible').includes('old-plugin'))

// ------------------------------------------------------------ runtime
const runtime = await resolveRuntime('D:\\DeepSeek Harness')
check('runtime resolves an installed directory', runtime.ok === true, runtime.reason)
if (runtime.ok) {
  check('runtime finds the executable', existsSync(runtime.detail.exe))
  check('runtime finds the CLI inside the archive', runtime.detail.cliJs.includes('app.asar'), runtime.detail.cliJs)
  check('runtime reads the version', typeof runtime.detail.version === 'string', String(runtime.detail.version))
  check('runtime exposes cleanup', typeof runtime.detail.cleanup === 'function')
  await runtime.detail.cleanup()
}
check('pnpm resolves from the launcher', pnpmOfLauncher({
  ok: true,
  exe: 'D:\\DeepSeek Harness\\DeepSeek Harness.exe',
  cliJs: 'D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
}) !== undefined)

// --------------------------------------------------------- e2e (opt-in)
if (process.env.DSH_GUARD_REHEARSE === '1' && existsSync(installedAsar)) {
  const launcher = {
    ok: true,
    exe: 'D:\\DeepSeek Harness\\DeepSeek Harness.exe',
    cliJs: 'D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
  }
  const asar = openAsar(installedAsar)
  const version = readAsarManifest(asar, 'dsh/package.json')?.version
  const result = await rehearseUpgrade({
    source: 'D:\\DeepSeek Harness',
    profileDir: 'C:\\Users\\vipanda\\.dsh\\profiles\\desktop',
    currentLauncher: launcher,
    currentVersion: version,
    timeoutMs: 180_000,
  })
  check('e2e rehearsal runs and boots', result.verdict === 'UPGRADE_OK' || result.verdict === 'UPGRADE_WARN', `${result.verdict} ${result.reason ?? ''}`)
  check('e2e rehearsal cleans up', result.cleanupOk === true, String(result.cleanupOk))
  const probeRoot = path.join(os.tmpdir(), 'dsh-plugin-guard')
  const leftovers = existsSync(probeRoot) ? readdirSync(probeRoot) : []
  check('e2e rehearsal leaves no probe home', leftovers.length === 0, leftovers.join(','))
} else {
  console.log('SKIP e2e rehearsal: set DSH_GUARD_REHEARSE=1 to run it')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
