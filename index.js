/**
 * dsh-plugin-guard — Host half.
 *
 * Installing or updating a plugin can leave DSH unable to start: a module that
 * calls `process.exit` while loading takes the whole process down, a synchronous
 * loop at import time makes the Web surface never appear, and a package whose
 * bundle patch or entry is broken is silently skipped. The plugin manager already
 * refuses version-incompatible packages, so what it cannot see is the boot
 * itself — which is what this plugin checks.
 *
 * The check is a real boot: the candidate is installed into a throwaway DSH home
 * with a fresh `web` profile and the launcher is started for real. That home is
 * deleted afterwards, so the live profile, its `node_modules`, and its patch
 * files are never touched. The same machinery backs four tools:
 *
 *  - `plugin_guard_check`   one target, before installing or updating it;
 *  - `plugin_guard_audit`   every installed bundle (the "every plugin" sweep);
 *  - `plugin_guard_install` install only after the probe admits the package;
 *  - `plugin_guard_update`  update only after the probe admits the new version.
 *
 * Installing through the plugin manager from the Web UI or its own tool bypasses
 * these tools, so the plugin also snapshots the profile files when an install or
 * update starts and re-audits statically when it completes, keeping the evidence
 * for `plugin_guard_status` and offering `plugin_guard_restore`.
 *
 * No package import is used at all: a guard that cannot fail to load is worth
 * more than one sharing the loader it is meant to verify.
 *
 * @module dsh-plugin-guard
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { analyzeManifest, LEVEL } from './lib/manifest.mjs'
import { resolveTarget } from './lib/plan.mjs'
import { createLauncher, runBootProbe } from './lib/probe.mjs'
import { rehearseUpgrade } from './lib/rehearse.mjs'
import { isCrash, renderAudit, renderCheck, renderRehearsal, verdictFrom, verdictLabel, VERDICT } from './lib/report.mjs'
import { scanPackage } from './lib/scan.mjs'

export const name = 'plugin-guard'
export const inject = ['tools']

/** Profile files a plugin change can rewrite; snapshotted before an install. */
const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'compatibility.json']

/** How many automatic checks and snapshots stay addressable. */
const MAX_HISTORY = 20

/** In-memory state for the status tool; the disk keeps the snapshots. */
const state = {
  checks: [],
  auto: [],
  lastAutoAudit: undefined,
  lastError: undefined,
  startedAt: Date.now(),
}

/** The Harness home this process runs against. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Where snapshots and the automatic-check log live. */
function guardDir() {
  return path.join(dshHome(), 'plugin-guard')
}

/** The active profile directory: launcher environment, the profile service, then the default layout. */
function profileDirOf(ctx) {
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') return process.env.DSH_PROFILE_DIR
  const service = ctx?.get?.('profileContext')
  if (service !== null && typeof service === 'object' && typeof service.dir === 'string' && service.dir !== '') return service.dir
  const profile = process.env.DSH_PROFILE
  if (typeof profile === 'string' && profile !== '') return path.join(dshHome(), 'profiles', profile)
  const fallback = path.join(dshHome(), 'profiles', 'desktop')
  return existsSync(fallback) ? fallback : undefined
}

/** Verdicts that must stop an install or update outright. */
const BLOCKING_VERDICTS = new Set([
  VERDICT.CRASH_EXIT,
  VERDICT.CRASH_HANG,
  VERDICT.EXITED_CLEAN,
  VERDICT.INSTALL_FAILED,
  VERDICT.PROBE_UNAVAILABLE,
])

/**
 * Whether a check result must gate an install or update.
 *
 * A boot that never came up (crash, hang, clean exit before readiness), an
 * install the probe could not complete, or a probe that could not run blocks the
 * change. So does a static check with a failure-level finding when no boot probe
 * backed it: a missing entry or client bundle is not a warning.
 * @param result - a check result from `checkTarget`.
 * @returns whether the change must be refused.
 */
function blocksInstall(result) {
  if (BLOCKING_VERDICTS.has(result.verdict)) return true
  const probed = result.probe !== null && result.probe !== undefined && result.probe.status !== 'unavailable'
  if (!probed && (result.findings ?? []).some((item) => item.level === LEVEL.FAIL)) return true
  return false
}

/** Trim a captured output for a stored record. */
function clip(text, limit = 2000) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** Remember one check result, keeping the history bounded. */
function remember(entry) {
  state.checks.unshift(entry)
  if (state.checks.length > MAX_HISTORY) state.checks.length = MAX_HISTORY
}

/** The runtime directory that owns the launcher's CLI entry. */
function runtimeDirOf(launcher) {
  if (launcher?.ok !== true) return undefined
  return path.resolve(path.dirname(launcher.cliJs), '..', '..', '..', '..')
}

/** Where the installation's own packages live, used to find shipped bundles by name. */
function installationDirOf(launcher) {
  const runtimeDir = runtimeDirOf(launcher)
  return runtimeDir === undefined ? undefined : path.join(runtimeDir, 'node_modules')
}

/** Read the running DSH version from the launcher's runtime directory. */
function runtimeVersion(launcher) {
  const runtimeDir = runtimeDirOf(launcher)
  if (runtimeDir === undefined) return undefined
  for (const relative of ['package.json', path.join('node_modules', '@deepseek-ai', 'dsh', 'package.json')]) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(runtimeDir, relative), 'utf8'))
      if (typeof manifest.version === 'string') return manifest.version
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Run the static half: manifest facts, hazard scan, version declarations.
 * @param resolved - a target from {@link resolveTarget}.
 * @returns findings plus the analyzer facts.
 */
function staticFindings(resolved, version) {
  const findings = [...(resolved.findings ?? [])]
  if (resolved.kind !== 'directory' || typeof resolved.dir !== 'string' || !existsSync(resolved.dir)) {
    return { findings, facts: undefined }
  }
  const analysis = analyzeManifest(resolved.dir, { runtimeVersion: version, platform: process.platform })
  findings.push(...analysis.findings)
  const entries = [analysis.facts.entryPath, analysis.facts.clientPath].filter((entry) => typeof entry === 'string')
  const scan = scanPackage(resolved.dir, { entries })
  findings.push(...scan.findings)
  return { findings, facts: analysis.facts, rowNames: analysis.rowNames, scanned: scan.scanned }
}

/**
 * Check one target: static always, boot probe when asked.
 * @param input - the user-facing target text.
 * @param options - depth, deadlines, and progress callback.
 * @returns `{ resolved, findings, probe, verdict, report }`.
 */
async function checkTarget(input, options = {}) {
  const launcher = options.launcher ?? createLauncher()
  const version = runtimeVersion(launcher)
  const resolved = resolveTarget(input, {
    profileDir: options.profileDir,
    installationDir: options.installationDir,
    runtimeVersion: version,
  })
  const depth = options.depth === 'static' ? 'static' : 'boot'
  if (resolved.ok !== true) {
    const findings = resolved.findings ?? []
    const verdict = verdictFrom({ findings, probe: null })
    const result = { target: input, resolved, depth, verdict, findings, probe: null }
    return { ...result, report: renderCheck(result) }
  }

  const statics = staticFindings(resolved, version)
  const findings = statics.findings
  let probe = null
  if (depth === 'boot') {
    if (typeof resolved.dir === 'string' && /app\.asar/i.test(resolved.dir)) {
      probe = {
        status: 'unavailable',
        reason: '这是 DSH 安装自带的包，位于 app.asar 内，无法复制进隔离探针；只做了静态检查',
        exitCode: null,
        url: null,
        stdout: '',
        stderr: '',
        skippedRows: [],
        steps: [],
        elapsedMs: 0,
        cleanupOk: true,
      }
    } else {
      probe = await runBootProbe(resolved, {
        launcher,
        bootTimeoutMs: options.timeoutMs,
        onLog: options.onLog,
        expectedRows: statics.rowNames,
      })
    }
  }
  const verdict = verdictFrom({ findings, probe })
  const result = {
    target: input,
    resolved: { ...resolved, runtimeVersion: version },
    depth,
    verdict,
    findings,
    probe,
    facts: statics.facts,
    rowNames: statics.rowNames,
  }
  return { ...result, report: renderCheck(result) }
}

/** Snapshot the profile files a pending change may rewrite. */
function snapshotProfile(ctx, reason) {
  const dir = profileDirOf(ctx)
  if (dir === undefined || !existsSync(dir)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(guardDir(), 'snapshots', stamp)
  try {
    mkdirSync(target, { recursive: true })
    const copied = []
    for (const file of SNAPSHOT_FILES) {
      const source = path.join(dir, file)
      if (!existsSync(source)) continue
      copyFileSync(source, path.join(target, file))
      copied.push(file)
    }
    const record = { stamp, reason, profileDir: dir, files: copied }
    writeFileSync(path.join(target, 'snapshot.json'), JSON.stringify(record, undefined, 2))
    const entries = readdirSync(path.join(guardDir(), 'snapshots'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    while (entries.length > MAX_HISTORY) {
      const oldest = entries.shift()
      rmSync(path.join(guardDir(), 'snapshots', oldest), { recursive: true, force: true })
    }
    state.auto.unshift({ at: stamp, kind: 'snapshot', reason, files: copied.length })
    if (state.auto.length > MAX_HISTORY) state.auto.length = MAX_HISTORY
    return record
  } catch (error) {
    state.lastError = `snapshot failed: ${String(error?.message ?? error)}`
    return undefined
  }
}

/** Copy the newest snapshot back over the profile files. */
function restoreSnapshot() {
  const root = path.join(guardDir(), 'snapshots')
  if (!existsSync(root)) return { ok: false, reason: '没有可用的快照' }
  const stamps = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const newest = stamps.at(-1)
  if (newest === undefined) return { ok: false, reason: '没有可用的快照' }
  const dir = path.join(root, newest)
  let record
  try {
    record = JSON.parse(readFileSync(path.join(dir, 'snapshot.json'), 'utf8'))
  } catch {
    return { ok: false, reason: `快照 ${newest} 无法读取` }
  }
  const restored = []
  for (const file of record.files ?? []) {
    const source = path.join(dir, file)
    if (!existsSync(source)) continue
    copyFileSync(source, path.join(record.profileDir, file))
    restored.push(file)
  }
  return { ok: true, stamp: newest, profileDir: record.profileDir, restored }
}

/** Describe the profile's bundles for the audit, tolerating a missing manager. */
async function listBundles(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null || typeof manager.listBundles !== 'function') return undefined
  return manager.listBundles()
}

/**
 * Cheap re-audit after an untracked profile change: every bundle's manifest and
 * runtime graph, no boot. Runs on `plugin-manager/changed` so a change made from
 * the Web UI still gets a verdict recorded even though no tool saw it.
 * @returns the audit summary stored on `state.lastAutoAudit`.
 */
async function autoStaticAudit(ctx, options) {
  const bundles = await listBundles(ctx)
  if (bundles === undefined) return undefined
  const names = bundles.map((bundle) => bundle.name).filter((value) => typeof value === 'string')
  const failures = []
  for (const bundleName of names) {
    try {
      const resolved = resolveTarget(bundleName, {
        profileDir: options.profileDir,
        installationDir: options.installationDir,
        runtimeVersion: options.version,
      })
      if (resolved.ok !== true) continue
      const statics = staticFindings(resolved, options.version)
      const fails = statics.findings.filter((item) => item.level === LEVEL.FAIL)
      if (fails.length > 0) failures.push({ name: bundleName, codes: fails.map((item) => item.code) })
    } catch {
      continue
    }
  }
  const summary = { at: new Date().toISOString(), bundles: names.length, failures }
  state.lastAutoAudit = summary
  if (failures.length > 0) {
    console.warn(`[plugin-guard] 静态复核：${failures.length} 个插件有失败项 — ${failures.map((item) => `${item.name}(${item.codes[0]})`).join(', ')}`)
  }
  return summary
}

/** The newest installer the Desktop updater has staged, if any. */
function pendingInstaller() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(local, '@deepseek-aidsh-desktop-updater', 'pending')
  try {
    const candidates = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
      .map((entry) => {
        const file = path.join(dir, entry.name)
        return { file, mtime: statSync(file).mtimeMs }
      })
      .sort((left, right) => right.mtime - left.mtime)
    return candidates[0]?.file
  } catch {
    return undefined
  }
}

/** Tool output for one check. */
function checkOutput(result) {
  return {
    verdict: result.verdict,
    label: verdictLabel(result.verdict),
    target: result.resolved?.name ?? result.target,
    version: typeof result.resolved?.version === 'string' ? result.resolved.version : '',
    crashed: isCrash(result.verdict),
    probeStatus: result.probe?.status ?? 'not-run',
    exitCode: result.probe?.exitCode === null || result.probe?.exitCode === undefined ? -1 : result.probe.exitCode,
    report: result.report,
  }
}

/** Output schema shared by the check-shaped tools. */
const CHECK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'label', 'target', 'version', 'crashed', 'probeStatus', 'exitCode', 'report'],
  properties: {
    verdict: { type: 'string', description: 'Verdict identifier' },
    label: { type: 'string', description: 'Verdict label' },
    target: { type: 'string', description: 'Checked package name or input' },
    version: { type: 'string', description: 'Checked version, empty when unknown' },
    crashed: { type: 'boolean', description: 'True when the probe proved DSH would not start' },
    probeStatus: { type: 'string', description: 'up | exit | hang | install-failed | unavailable | not-run' },
    exitCode: { type: 'integer', description: 'Probe exit code, -1 when none' },
    report: { type: 'string', description: 'Rendered report' },
  },
}

/** Text renderer for a check-shaped tool. */
function renderCheckOutput(_args, value) {
  return [{ type: 'text', text: value.report }]
}

/**
 * Update one installed bundle behind the probe.
 * @param ctx - plugin context carrying the plugin manager service.
 * @param name - bundle package name.
 * @param version - exact target version.
 * @param probe - whether the boot probe must admit the version first.
 * @returns the manager's own result, or the probe refusal.
 */
async function guardedUpdate(ctx, name, version, probe, options = {}) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined || manager === null || typeof manager.updateBundle !== 'function') {
    return { ok: false, reason: 'pluginManager 服务不可用（这个 profile 没有插件管理器）' }
  }
  if (probe) {
    const result = await checkTarget(`${name}@${version}`, { ...options, depth: 'boot' })
    remember({ at: Date.now(), kind: 'update', target: `${name}@${version}`, verdict: result.verdict })
    if (blocksInstall(result)) {
      return { ok: false, refused: true, verdict: result.verdict, report: result.report }
    }
  }
  snapshotProfile(ctx, `update ${name}@${version}`)
  const outcome = await manager.updateBundle(name, version)
  return { ok: true, outcome }
}

/** Register every tool and the profile-change watchers. */
export function apply(ctx) {
  const launcher = createLauncher()
  const version = runtimeVersion(launcher)
  const baseOptions = {
    launcher,
    profileDir: profileDirOf(ctx),
    installationDir: installationDirOf(launcher),
  }

  const register = (definition) => ctx.effect(() => {
    const dispose = ctx.tools.register(definition)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, `plugin-guard: ${definition.name}`)

  register({
    name: 'plugin_guard_check',
    description: 'Preflight one DSH plugin before installing or updating it: analyze its manifest and sources, then boot it for real in an isolated throwaway DSH home and report whether it would crash (process exit or hang), be skipped, or start normally. Use this before plugin_manager install_bundle or any version update.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: {
          type: 'string',
          description: 'Installed bundle name, absolute package directory, package@version, or a git/registry install spec.',
        },
        depth: {
          type: 'string',
          enum: ['boot', 'static'],
          description: 'boot (default) runs the real boot rehearsal; static only reads the package.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Boot deadline in milliseconds; default 90000.',
        },
      },
    },
    output: { schema: CHECK_OUTPUT, render: renderCheckOutput },
    async execute(args) {
      const result = await checkTarget(args.target, { ...baseOptions, depth: args.depth, timeoutMs: args.timeoutMs })
      remember({ at: Date.now(), kind: 'check', target: args.target, verdict: result.verdict })
      return checkOutput(result)
    },
  })

  register({
    name: 'plugin_guard_audit',
    description: 'Check every bundle installed in this profile for boot risk. Static depth reads each installed package; boot depth additionally boots each candidate alone in an isolated throwaway DSH home (about 5-10 seconds per bundle, so pass only/limit to narrow it).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        depth: {
          type: 'string',
          enum: ['static', 'boot'],
          description: 'static (default) or boot for the real rehearsal.',
        },
        only: {
          type: 'string',
          description: 'Audit just this one bundle name.',
        },
        limit: {
          type: 'integer',
          description: 'At most this many bundles; defaults to all for static and 8 for boot.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'report'],
        properties: {
          count: { type: 'integer', description: 'Bundles checked' },
          report: { type: 'string', description: 'Rendered audit' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const bundles = await listBundles(ctx)
      if (bundles === undefined) {
        return { count: 0, report: '这个 profile 没有 pluginManager 服务，无法列出已安装插件。' }
      }
      let names = bundles.map((bundle) => bundle.name).filter((value) => typeof value === 'string')
      if (typeof args.only === 'string' && args.only !== '') names = names.filter((value) => value === args.only)
      const depth = args.depth === 'boot' ? 'boot' : 'static'
      const limit = typeof args.limit === 'number' ? args.limit : depth === 'boot' ? 8 : names.length
      names = names.slice(0, Math.max(0, limit))
      const results = []
      for (const bundleName of names) {
        try {
          results.push(await checkTarget(bundleName, { ...baseOptions, depth, timeoutMs: args.timeoutMs }))
        } catch (error) {
          results.push({
            target: bundleName,
            resolved: { name: bundleName },
            verdict: VERDICT.PROBE_UNAVAILABLE,
            findings: [{ level: LEVEL.WARN, code: 'check-failed', message: String(error?.message ?? error) }],
            probe: null,
          })
        }
      }
      remember({ at: Date.now(), kind: 'audit', target: `${results.length} bundles`, verdict: 'MIXED' })
      return {
        count: results.length,
        report: renderAudit(results) + (results.some((result) => isCrash(result.verdict))
          ? '\n\n存在会让 DSH 起不来的插件：先用 plugin_guard_check 看单个插件的证据，再移除或更新它。'
          : ''),
      }
    },
  })

  register({
    name: 'plugin_guard_install',
    description: 'Install a bundle only after the boot probe admits it in an isolated DSH home. Refuses when the package would crash DSH, hang the boot, exit before the Web surface is ready, fail to install, or when the probe cannot run; the profile is left unchanged. A package that boots but has a skipped row is installed and the report says so.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: {
          type: 'string',
          description: 'Package directory, package@version, registry name, or git address, as plugin_manager install_bundle accepts.',
        },
        enabled: {
          type: 'boolean',
          description: 'Select the bundle after installing; defaults to true.',
        },
        probe: {
          type: 'boolean',
          description: 'Run the boot probe first; defaults to true.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'report'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the install ran' },
          report: { type: 'string', description: 'Rendered outcome' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const manager = ctx.get('pluginManager')
      if (manager === undefined || manager === null || typeof manager.installBundle !== 'function') {
        return { ok: false, report: 'pluginManager 服务不可用：这个 profile 无法安装插件。' }
      }
      const probe = args.probe !== false
      const resolved = resolveTarget(args.target, { profileDir: baseOptions.profileDir, installationDir: baseOptions.installationDir, runtimeVersion: version })
      if (resolved.ok !== true) {
        return { ok: false, report: `目标无法识别：\n${renderCheck({ target: args.target, resolved, depth: 'static', verdict: verdictFrom({ findings: resolved.findings ?? [], probe: null }), findings: resolved.findings ?? [], probe: null })}` }
      }
      if (resolved.shipped === true) {
        return { ok: false, report: `${resolved.name} 是 DSH 安装自带的包，已经在运行时里，不需要安装。` }
      }
      const result = await checkTarget(args.target, { ...baseOptions, depth: probe ? 'boot' : 'static' })
      remember({ at: Date.now(), kind: 'install', target: args.target, verdict: result.verdict })
      if (blocksInstall(result)) {
        return { ok: false, report: `${result.report}\n\n未改动 profile：拦截了这次安装。` }
      }
      const options = args.enabled === undefined ? {} : { enabled: args.enabled === true }
      let outcome
      try {
        outcome = await manager.installBundle(resolved.spec, options)
      } catch (error) {
        return { ok: false, report: `${result.report}\n\n预检通过，但安装失败：${String(error?.message ?? error)}` }
      }
      const stateText = outcome?.application ?? outcome?.status ?? 'unknown'
      return { ok: true, report: `${result.report}\n\n已提交安装：${String(stateText)}${outcome?.version === undefined ? '' : `（${outcome.version}）`}` }
    },
  })

  register({
    name: 'plugin_guard_update',
    description: 'Update an installed bundle only after the boot probe admits the target version in an isolated DSH home. Refuses and leaves the installed version in place when the new version would crash DSH, hang, exit before the Web surface is ready, fail to install, or when the probe cannot run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version'],
      properties: {
        name: { type: 'string', description: 'Installed bundle package name.' },
        version: { type: 'string', description: 'Exact target version.' },
        probe: { type: 'boolean', description: 'Run the boot probe first; defaults to true.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'report'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the update ran' },
          report: { type: 'string', description: 'Rendered outcome' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const result = await guardedUpdate(ctx, args.name, args.version, args.probe !== false, baseOptions)
      if (result.refused === true) {
        return { ok: false, report: `${result.report}\n\n未改动 profile：拦截了这次更新。` }
      }
      if (result.ok !== true) return { ok: false, report: `更新失败：${result.reason}` }
      return { ok: true, report: `${args.name}@${args.version} 的更新已提交：${JSON.stringify(result.outcome?.application ?? result.outcome?.status ?? 'unknown')}` }
    },
  })

  register({
    name: 'plugin_guard_rehearse',
    description: 'Rehearse a DSH upgrade before taking it: boot the current plugin set on a candidate DSH runtime in an isolated DSH home, then report whether it starts and which plugins the new version would deny or skip. The candidate may be an installed directory or a staged updater installer (extracted with 7-Zip, never installed); extraction needs about 1.2 GB of temp space and the boot copies the active profile, so it is read-only for the real profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: {
          type: 'string',
          description: 'Candidate runtime: an installed DSH directory, or an installer .exe. Defaults to the newest installer staged in the updater cache.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Boot deadline in milliseconds; default 180000 (a full profile boots slower than a bare probe).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'verdict', 'newVersion', 'currentVersion', 'report'],
        properties: {
          ok: { type: 'boolean', description: 'Whether the rehearsal ran and the candidate started' },
          verdict: { type: 'string', description: 'UPGRADE_OK | UPGRADE_WARN | UPGRADE_CRASH | INSTALL_FAILED | RUNTIME_UNRESOLVED | PROFILE_UNAVAILABLE | PROBE_FAILED' },
          newVersion: { type: 'string', description: 'Version the candidate runtime reports' },
          currentVersion: { type: 'string', description: 'Version of the running DSH' },
          report: { type: 'string', description: 'Rendered rehearsal report' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const source = typeof args.source === 'string' && args.source !== '' ? args.source : pendingInstaller()
      if (source === undefined) {
        return {
          ok: false,
          verdict: 'RUNTIME_UNRESOLVED',
          newVersion: '',
          currentVersion: version ?? '',
          report: '没有给出候选运行时，也没有在更新器缓存里找到安装包。请传 source（安装目录或安装包路径）。',
        }
      }
      const result = await rehearseUpgrade({
        source,
        profileDir: baseOptions.profileDir,
        currentLauncher: launcher,
        currentVersion: version,
        timeoutMs: args.timeoutMs,
      })
      remember({ at: Date.now(), kind: 'rehearse', target: `${path.basename(source)} → ${result.runtime?.version ?? '?'}`, verdict: result.verdict })
      return {
        ok: result.ok === true,
        verdict: result.verdict,
        newVersion: result.runtime?.version ?? '',
        currentVersion: version ?? '',
        report: renderRehearsal(result),
      }
    },
  })

  register({
    name: 'plugin_guard_status',
    description: 'Report the automatic install/update watches this plugin saw, the snapshot it holds for the current profile, and the recent manual checks.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['report'],
        properties: { report: { type: 'string', description: 'Rendered status' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute() {
      const lines = []
      lines.push(`runtime：${version ?? '未知'}；启动器：${launcher.ok === true ? '可用' : launcher.reason}`)
      lines.push(`profile：${baseOptions.profileDir ?? '未知'}`)
      lines.push(`运行时长：${Math.round((Date.now() - state.startedAt) / 1000)}s`)
      lines.push('')
      lines.push('最近的自动监听：')
      if (state.auto.length === 0) lines.push('- 还没有记录到安装或更新事件')
      for (const item of state.auto.slice(0, 8)) lines.push(`- ${item.at} · ${item.kind} · ${item.reason}${item.files === undefined ? '' : ` · ${item.files} 个文件`}`)
      lines.push('')
      lines.push('最近的手动检查：')
      if (state.checks.length === 0) lines.push('- 还没有运行过检查')
      for (const item of state.checks.slice(0, 8)) lines.push(`- ${new Date(item.at).toLocaleTimeString()} · ${item.kind} · ${item.target} · ${item.verdict}`)
      if (state.lastAutoAudit !== undefined) {
        lines.push('')
        lines.push(`最近一次变更后的自动静态复核：${state.lastAutoAudit.at} · ${state.lastAutoAudit.bundles} 个插件 · 失败 ${state.lastAutoAudit.failures.length} 个`)
        for (const failure of state.lastAutoAudit.failures.slice(0, 8)) lines.push(`- ${failure.name}：${failure.codes.join(', ')}`)
      }
      if (state.lastError !== undefined) lines.push(`\n最近一次错误：${state.lastError}`)
      return { report: lines.join('\n') }
    },
  })

  register({
    name: 'plugin_guard_restore',
    description: 'Restore the profile files (package.json, lockfile, patches) from the newest snapshot taken before the last watched install or update. Use after a change left DSH unable to start; requires confirm=true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['confirm'],
      properties: {
        confirm: { type: 'boolean', description: 'Must be true to overwrite the profile files.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'report'],
        properties: {
          ok: { type: 'boolean', description: 'Whether files were restored' },
          report: { type: 'string', description: 'Rendered outcome' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args) {
      if (args.confirm !== true) return { ok: false, report: '没有执行：需要 confirm=true 才会覆盖 profile 文件。' }
      const restored = restoreSnapshot()
      if (restored.ok !== true) return { ok: false, report: `没有恢复：${restored.reason}` }
      return { ok: true, report: `已从快照 ${restored.stamp} 恢复 ${restored.restored.length} 个文件：${restored.restored.join(', ')}\n重启 DSH 后生效。` }
    },
  })

  // Automatic watch: snapshot before a change reaches the files, statically
  // re-audit after it lands. The boot probe stays a manual step because booting
  // a second Web surface on every change is too expensive to do silently.
  ctx.effect(() => {
    const disposers = []
    const subscribe = (event, handler) => {
      try {
        const dispose = ctx.on(event, handler)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        state.lastError = `subscribe ${event}: ${String(error?.message ?? error)}`
      }
    }
    subscribe('plugin-manager/install-state', (payload) => {
      try {
        if (payload?.phase === 'installing' || payload?.phase === 'applying') snapshotProfile(ctx, `install ${payload?.requestId ?? ''}`.trim())
      } catch (error) {
        state.lastError = `install-state: ${String(error?.message ?? error)}`
      }
    })
    subscribe('plugin-manager/update-state', (payload) => {
      try {
        if (payload?.phase === 'checking' || payload?.phase === 'removing' || payload?.phase === 'installing') snapshotProfile(ctx, `update ${payload?.requestId ?? ''}`.trim())
      } catch (error) {
        state.lastError = `update-state: ${String(error?.message ?? error)}`
      }
    })
    subscribe('plugin-manager/changed', (payload) => {
      try {
        state.auto.unshift({ at: new Date().toISOString(), kind: 'changed', reason: String(payload?.reason ?? 'unknown') })
        if (state.auto.length > MAX_HISTORY) state.auto.length = MAX_HISTORY
      } catch (error) {
        state.lastError = `changed: ${String(error?.message ?? error)}`
      }
      autoStaticAudit(ctx, baseOptions).catch((error) => {
        state.lastError = `auto audit: ${String(error?.message ?? error)}`
      })
    })
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Disposal of an already-removed listener is not an error here.
        }
      }
    }
  }, 'plugin-guard: profile watch')

  // A tiny status file makes the state visible when the process dies from the
  // very change it was watching.
  ctx.effect(() => {
    try {
      mkdirSync(guardDir(), { recursive: true })
      writeFileSync(path.join(guardDir(), 'last-run.json'), JSON.stringify({
        runtime: version,
        launcher: launcher.ok === true ? 'ok' : launcher.reason,
        profileDir: baseOptions.profileDir,
        startedAt: new Date(state.startedAt).toISOString(),
      }, undefined, 2))
    } catch (error) {
      state.lastError = `write state: ${String(error?.message ?? error)}`
    }
    return () => {}
  }, 'plugin-guard: state file')
}
