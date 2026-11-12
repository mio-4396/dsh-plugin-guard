/**
 * Tool-layer self-test: load index.js with a stub context, call every tool, and
 * verify the gating decisions and the snapshot/restore flow. Boot-shaped calls
 * reuse the real launcher, so this file takes about 15 s.
 *
 * Run from the package root: `node tests/tooltest.mjs`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const root = mkdtempSync(path.join(os.tmpdir(), 'guard-tool-'))
const profileDir = path.join(root, 'profile')
const home = path.join(root, 'home')
mkdirSync(profileDir, { recursive: true })
writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tooltest',
  dependencies: { 'dsh-file-menu': 'link:D:/dsh-tools/dsh-file-menu' },
  dsh: { profile: { bundles: ['dsh-file-menu'] } },
}, undefined, 2))
writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_HOME = home
// Under plain Node the launcher cannot be derived from process.execPath, so the
// test names the installed Desktop launcher explicitly.
if (process.env.DSH_GUARD_LAUNCHER_CLI === undefined) {
  const installedExe = 'D:\\DeepSeek Harness\\DeepSeek Harness.exe'
  const installedCli = 'D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'
  if (existsSync(installedExe)) {
    process.env.DSH_GUARD_LAUNCHER_EXE = installedExe
    process.env.DSH_GUARD_LAUNCHER_CLI = installedCli
  }
}

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

const registry = []
const events = new Map()
const calls = []
const manager = {
  async listBundles() {
    return [{ name: 'dsh-file-menu' }]
  },
  async installBundle(spec, options) {
    calls.push({ kind: 'install', spec, options })
    return { application: 'applied', version: '0.2.2' }
  },
  async updateBundle(name, version) {
    calls.push({ kind: 'update', name, version })
    return { application: 'applied' }
  },
  async inspect() {
    return { name: 'x' }
  },
}
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(event, handler) {
    events.set(event, handler)
    return () => {}
  },
  get(name) {
    return name === 'pluginManager' ? manager : undefined
  },
  tools: {
    register(definition) {
      registry.push(definition)
      return () => {}
    },
  },
}

apply(ctx)

const tools = new Map(registry.map((definition) => [definition.name, definition]))
check('registers six tools', tools.size === 6, [...tools.keys()].join(','))
check('register shapes carry output.render', [...tools.values()].every((tool) => typeof tool.output?.render === 'function'))

const checkTool = tools.get('plugin_guard_check')
const goodResult = await checkTool.execute({ target: path.join(fixtures, 'good') })
check('check good → OK', goodResult.verdict === 'OK', `${goodResult.verdict}: ${goodResult.report.slice(0, 200)}`)
check('check good returns a report string', typeof goodResult.report === 'string' && goodResult.report.includes('判定'))

const crashResult = await checkTool.execute({ target: path.join(fixtures, 'crash-exit') })
check('check crash-exit → CRASH_EXIT', crashResult.verdict === 'CRASH_EXIT', `${crashResult.verdict} exit=${crashResult.exitCode}`)
check('check crash-exit marks crashed', crashResult.crashed === true)
check('check crash-exit has evidence', crashResult.report.includes('崩溃证据'))

const staticResult = await checkTool.execute({ target: path.join(fixtures, 'crash-exit'), depth: 'static' })
check('static depth skips the probe', staticResult.probeStatus === 'not-run' && staticResult.verdict === 'STATIC_ONLY', staticResult.verdict)

const installTool = tools.get('plugin_guard_install')
const blocked = await installTool.execute({ target: path.join(fixtures, 'crash-exit') })
check('install refuses a crashing package', blocked.ok === false && blocked.report.includes('拦截'))
check('install did not touch the manager', calls.filter((call) => call.kind === 'install').length === 0)

const allowed = await installTool.execute({ target: path.join(fixtures, 'good') })
check('install admits a good package', allowed.ok === true, allowed.report.slice(-200))
check('install called the manager once', calls.filter((call) => call.kind === 'install').length === 1)

const auditTool = tools.get('plugin_guard_audit')
const audit = await auditTool.execute({ depth: 'static' })
check('audit lists the bundle', audit.count === 1 && audit.report.includes('dsh-file-menu'), audit.report)

// The audit table names the probe outcome, not just the verdict.
const { renderAudit } = await import('../lib/report.mjs')
const renderedAudit = renderAudit([
  { target: 'a', resolved: { name: 'a', version: '1.0.0' }, verdict: 'CRASH_EXIT', findings: [], probe: { status: 'exit', exitCode: 9, elapsedMs: 2400 } },
  { target: 'b', resolved: { name: 'b', version: '2.0.0' }, verdict: 'OK', findings: [], probe: { status: 'up', elapsedMs: 3100 } },
])
check('audit renders exit codes and boot timings', renderedAudit.includes('code=9') && renderedAudit.includes('3100ms'), renderedAudit)

// Snapshot before a change, then restore it.
const installState = events.get('plugin-manager/install-state')
check('subscribes to install-state', typeof installState === 'function')
installState?.({ requestId: 'r1', phase: 'installing' })
const snapshotsRoot = path.join(home, 'plugin-guard', 'snapshots')
const snapshots = readdirSync(snapshotsRoot)
check('snapshot taken before install', snapshots.length === 1, snapshots.join(','))
const snapshotFiles = readdirSync(path.join(snapshotsRoot, snapshots[0]))
check('snapshot holds the profile files', snapshotFiles.includes('package.json') && snapshotFiles.includes('cordis.patch.yml'), snapshotFiles.join(','))

writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'broken' }))
const restoreTool = tools.get('plugin_guard_restore')
const notConfirmed = await restoreTool.execute({ confirm: false })
check('restore refuses without confirm', notConfirmed.ok === false)
const restored = await restoreTool.execute({ confirm: true })
const afterRestore = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
check('restore puts the profile files back', restored.ok === true && afterRestore.name === 'dsh-profile-tooltest', JSON.stringify(afterRestore))

const status = tools.get('plugin_guard_status').execute({})
check('status reports the launcher and profile', status.report.includes('runtime') && status.report.includes(profileDir), status.report.slice(0, 300))

// Without the environment variable the profile comes from the profileContext service.
const savedProfileEnv = process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE_DIR
const serviceRegistry = []
apply({
  effect(fn) {
    fn()
    return () => {}
  },
  on() {
    return () => {}
  },
  get(name) {
    if (name === 'profileContext') return { dir: profileDir }
    return undefined
  },
  tools: {
    register(definition) {
      serviceRegistry.push(definition)
      return () => {}
    },
  },
})
const serviceStatus = serviceRegistry.find((definition) => definition.name === 'plugin_guard_status').execute({})
check('status falls back to the profileContext service', serviceStatus.report.includes(profileDir), serviceStatus.report.slice(0, 300))
process.env.DSH_PROFILE_DIR = savedProfileEnv

const updateTool = tools.get('plugin_guard_update')
const noManagerRegistry = []
const noManagerCtx = {
  effect(fn) {
    fn()
    return () => {}
  },
  on() {
    return () => {}
  },
  get() {
    return undefined
  },
  tools: {
    register(definition) {
      noManagerRegistry.push(definition)
      return () => {}
    },
  },
}
apply(noManagerCtx)
const managerlessUpdate = noManagerRegistry.find((definition) => definition.name === 'plugin_guard_update')
const managerless = await managerlessUpdate.execute({ name: 'dsh-file-menu', version: '9.9.9' })
check('update refuses when the profile has no plugin manager', managerless.ok === false && managerless.report.includes('不可用'), managerless.report)
check('update tool is registered once per activation', updateTool !== undefined)

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
