/**
 * Upgrade rehearsal: boot the current plugin set on a different DSH runtime.
 *
 * A DSH update replaces `resources/app.asar` and its runtime; a plugin that
 * passes the version gate can still kill the new process, and one whose
 * `engines.dsh` excludes the new version is silently skipped. Neither is visible
 * from the running installation, so this rehearsal:
 *
 *  1. resolves the candidate runtime (installed directory or updater installer,
 *     extracted with 7-Zip, never installed);
 *  2. copies the active profile's manifest, patch and lockfile into a throwaway
 *     DSH home and installs the same dependencies there;
 *  3. boots the candidate runtime against that home and classifies the result;
 *  4. compares every bundle's `engines.dsh` / DSH peers against the candidate
 *     version, so the report says which plugins will be denied or skipped;
 *  5. removes the copied home and any extracted runtime.
 *
 * @module plugin-guard/lib/rehearse
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { readAsarManifest } from './asar.mjs'
import { removeProbeHome } from './fs-safe.mjs'
import { freePort } from './http.mjs'
import { readManifest } from './manifest.mjs'
import { bootWebProfile, PROBE_ROOT } from './probe.mjs'
import { runCommand, tail } from './process.mjs'
import { resolveRuntime } from './runtime.mjs'
import { isValidRange, satisfies } from './semver.mjs'

/** Profile files that decide what loads; everything else is rebuilt. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'compatibility.json']

/** Packages whose peer ranges DSH checks when `engines.dsh` is absent. */
const DSH_PEER_RE = /^@deepseek-ai\/dsh(?:-|$)|^dsh$/

/** The pnpm a launcher's installation ships, if any. */
export function pnpmOfLauncher(launcher) {
  if (launcher === null || launcher === undefined || launcher.ok !== true) return undefined
  const root = path.resolve(path.dirname(launcher.cliJs), '..', '..', '..', '..', '..', '..', '..')
  const candidate = path.join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  return existsSync(candidate) ? candidate : undefined
}

/** Strip a `link:` / `file:` dependency spec into an absolute directory. */
function localSpecPath(spec, base) {
  const match = /^(?:link|file):(.+)$/i.exec(String(spec ?? ''))
  if (match === null) return undefined
  const target = match[1].trim()
  return path.isAbsolute(target) ? target : path.resolve(base, target)
}

/**
 * Compare every bundle in a copied profile against the candidate runtime.
 * @param input - copied profile directory, candidate version, and its archive.
 * @returns the checked count and the packages DSH would deny or skip.
 */
export function analyzeCompatibility(input) {
  const { profileDir, newVersion, asar } = input
  const out = { checked: 0, incompatible: [], missing: [], unreadable: [] }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return out
  }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object' ? manifest.dependencies : {}
  const names = [...new Set([...bundles, ...Object.keys(dependencies)])].filter((name) => typeof name === 'string').sort()

  for (const name of names) {
    let record = null
    const installed = readManifest(path.join(profileDir, 'node_modules', name))
    if (installed.ok) record = installed.manifest
    if (record === null) {
      const local = localSpecPath(dependencies[name], profileDir)
      if (local !== undefined) {
        const linked = readManifest(local)
        if (linked.ok) record = linked.manifest
      }
    }
    if (record === null && asar !== undefined && asar !== null) {
      const archived = readAsarManifest(asar, `dsh/node_modules/${name}/package.json`)
      if (archived !== null) record = archived
    }
    if (record === null) {
      out.missing.push(name)
      continue
    }
    out.checked += 1

    const requirement = typeof record.engines?.dsh === 'string' ? record.engines.dsh : undefined
    if (requirement !== undefined) {
      if (!isValidRange(requirement)) {
        out.incompatible.push({ name, version: record.version, kind: 'engines', requirement, reason: 'invalid-range' })
      } else if (typeof newVersion === 'string' && !satisfies(newVersion, requirement)) {
        out.incompatible.push({ name, version: record.version, kind: 'engines', requirement, reason: 'excludes-runtime' })
      }
      continue
    }
    const peers = record.peerDependencies !== null && typeof record.peerDependencies === 'object' ? record.peerDependencies : {}
    for (const [peer, range] of Object.entries(peers)) {
      if (!DSH_PEER_RE.test(peer)) continue
      if (typeof range !== 'string' || !isValidRange(range) || (typeof newVersion === 'string' && !satisfies(newVersion, range))) {
        out.incompatible.push({ name, version: record.version, kind: 'peer', requirement: `${peer} ${String(range)}`, reason: 'excludes-runtime' })
      }
    }
  }
  return out
}

/** Row and bundle names one boot reported as not activated / skipped. */
export function parseSkipped(stderr) {
  if (typeof stderr !== 'string') return []
  const names = new Set()
  for (const match of stderr.matchAll(/skipp(?:ed|ing)\s+(?:bundle\s+)?["']?([@\w./-]+)["']?/gi)) {
    if (typeof match[1] === 'string' && match[1] !== '') names.add(match[1])
  }
  if (stderr.includes('did not activate') && /^    at /m.test(stderr)) {
    for (const match of stderr.matchAll(/^(\S+) \(([^)]+)\): /gm)) names.add(match[1])
  }
  return [...names]
}

/**
 * Rehearse one DSH upgrade.
 * @param options - source runtime, profile directory, current launcher/version, deadlines.
 * @returns the rehearsal record: runtime facts, install/boot results, compatibility, verdict.
 */
export async function rehearseUpgrade(options = {}) {
  const started = Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const result = {
    ok: false,
    verdict: 'RUNTIME_UNRESOLVED',
    reason: undefined,
    source: options.source,
    runtime: null,
    currentVersion: options.currentVersion,
    profile: { source: options.profileDir, name: 'guard-upgrade', files: [] },
    install: null,
    boot: null,
    compatibility: null,
    skipped: [],
    findings: [],
    home: null,
    elapsedMs: 0,
    cleanupOk: true,
  }

  const runtime = await resolveRuntime(options.source, { tempRoot: PROBE_ROOT, log })
  let home
  let cleanedHome = true
  try {
    if (runtime.ok !== true) {
      result.reason = runtime.reason
      return result
    }
    const { exe, cliJs, version: newVersion, asar, pnpm, tempRoot } = runtime.detail
    result.runtime = {
      kind: runtime.detail.kind,
      appRoot: runtime.detail.appRoot,
      exe,
      cliJs,
      version: newVersion,
      asarPath: runtime.detail.asarPath,
      pnpm,
      extracted: runtime.detail.extracted,
      source: options.source,
    }
    if (typeof newVersion === 'string' && typeof options.currentVersion === 'string' && newVersion === options.currentVersion) {
      result.findings.push({ level: 'info', code: 'same-version', message: `候选运行时版本与当前相同（${newVersion}），演练验证的是流程与插件加载` })
    }

    const profileSource = options.profileDir
    if (typeof profileSource !== 'string' || !existsSync(path.join(profileSource, 'package.json'))) {
      result.verdict = 'PROFILE_UNAVAILABLE'
      result.reason = `找不到要演练的 profile：${String(profileSource)}`
      return result
    }

    const profileName = 'guard-upgrade'
    home = path.join(PROBE_ROOT, `home-rehearse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    const targetProfile = path.join(home, 'profiles', profileName)
    result.home = home
    mkdirSync(targetProfile, { recursive: true })
    log('复制 profile 到隔离 DSH home')
    for (const file of PROFILE_FILES) {
      const source = path.join(profileSource, file)
      if (!existsSync(source)) continue
      copyFileSync(source, path.join(targetProfile, file))
      result.profile.files.push(file)
    }
    const manifest = JSON.parse(readFileSync(path.join(targetProfile, 'package.json'), 'utf8'))
    manifest.name = `dsh-profile-${profileName}`
    writeFileSync(path.join(targetProfile, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    writeFileSync(path.join(targetProfile, 'cordis.yml'), '[]\n')

    const pnpmPath = pnpm ?? pnpmOfLauncher(options.currentLauncher)
    if (pnpmPath === undefined) {
      result.verdict = 'INSTALL_FAILED'
      result.reason = '候选运行时与当前安装都找不到 pnpm，无法在隔离环境安装依赖'
      return result
    }
    log('在隔离 profile 里安装同一套依赖')
    const install = await runCommand({ exe }, [pnpmPath, 'install'], {
      home,
      cwd: targetProfile,
      timeoutMs: options.installTimeoutMs ?? 600_000,
    })
    result.install = {
      status: install.status,
      code: install.code,
      elapsedMs: install.ms,
      outputTail: tail(`${install.stdout}\n${install.stderr}`.trim(), 1600),
    }
    if (install.status !== 'exit' || install.code !== 0) {
      result.verdict = 'INSTALL_FAILED'
      result.reason = '隔离环境里依赖装不上（见 install.outputTail）'
      return result
    }

    result.compatibility = analyzeCompatibility({ profileDir: targetProfile, newVersion, asar })
    log('用候选运行时启动同一套插件')
    const port = await freePort()
    const boot = await bootWebProfile({ exe, cliJs }, home, profileName, {
      timeoutMs: options.timeoutMs ?? 180_000,
      port,
    })
    result.boot = {
      status: boot.status,
      code: boot.code,
      url: boot.url,
      elapsedMs: boot.ms,
      stdoutTail: tail(boot.stdout, 1000),
      stderrTail: tail(boot.stderr, 4000),
    }
    result.skipped = parseSkipped(boot.stderr)

    if (boot.status === 'up') {
      const risky = (result.compatibility?.incompatible.length ?? 0) > 0 || result.skipped.length > 0
      result.verdict = risky ? 'UPGRADE_WARN' : 'UPGRADE_OK'
    } else if (boot.status === 'error') {
      result.verdict = 'UPGRADE_CRASH'
      result.reason = '候选运行时无法启动'
    } else {
      result.verdict = 'UPGRADE_CRASH'
    }
    result.ok = result.verdict === 'UPGRADE_OK' || result.verdict === 'UPGRADE_WARN'
    return result
  } catch (error) {
    result.verdict = 'PROBE_FAILED'
    result.reason = String(error?.message ?? error)
    return result
  } finally {
    result.elapsedMs = Date.now() - started
    if (home !== undefined) cleanedHome = await removeProbeHome(home)
    const cleanedRuntime = await runtime.detail.cleanup()
    result.cleanupOk = cleanedHome && cleanedRuntime
  }
}
