/**
 * Resolve one DSH runtime to the pieces an upgrade rehearsal needs: the
 * executable, the CLI entry inside `app.asar`, and the version the archive says
 * it carries.
 *
 * Two sources are supported:
 *  - a directory of an installed or unpacked DSH (contains `resources/app.asar`);
 *  - an NSIS installer from the updater cache, extracted with 7-Zip. Extraction
 *    never runs the installer, so the real installation is untouched.
 *
 * @module plugin-guard/lib/runtime
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openAsar, readAsarManifest } from './asar.mjs'
import { removeProbeHome } from './fs-safe.mjs'

const CLI_SUFFIXES = [
  'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',
  'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
]

/** Locate 7-Zip: explicit environment variable first, then PATH, then usual installs. */
export function find7z() {
  const explicit = process.env.DSH_GUARD_7Z
  const candidates = []
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') candidates.push(path.join(dir, '7z.exe'))
  }
  for (const base of ['F:\\Programs\\7-Zip', 'C:\\Program Files\\7-Zip', 'C:\\Program Files (x86)\\7-Zip']) {
    candidates.push(path.join(base, '7z.exe'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Run 7-Zip synchronously; extraction of a 300 MB installer is expected to take a minute. */
function extract(sevenZip, archive, targetDir) {
  const result = spawnSync(sevenZip, ['x', archive, `-o${targetDir}`, '-y'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

/** Find the first path matching one predicate under a root, bounded in depth. */
function findUnder(root, predicate, maxDepth = 5) {
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const next = queue.shift()
    let entries
    try {
      entries = readdirSync(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(next.dir, entry.name)
      if (predicate(entry.name, full, entry)) return full
      if (entry.isDirectory() && next.depth < maxDepth) queue.push({ dir: full, depth: next.depth + 1 })
    }
  }
  return undefined
}

/** Locate the app root under an extracted tree. */
function findAppRoot(root) {
  const direct = path.join(root, 'DeepSeek Harness.exe')
  if (existsSync(direct) && existsSync(path.join(root, 'resources', 'app.asar'))) return root
  const exe = findUnder(root, (name) => /^DeepSeek Harness\.exe$/i.test(name))
  return exe === undefined ? undefined : path.dirname(exe)
}

/** Read the version a runtime's archive reports. */
function versionOf(appRoot) {
  const asarPath = path.join(appRoot, 'resources', 'app.asar')
  const asar = openAsar(asarPath)
  if (asar !== null) {
    for (const name of ['dsh/package.json', 'package.json']) {
      const manifest = readAsarManifest(asar, name)
      if (manifest !== null && typeof manifest.version === 'string') return { version: manifest.version, asar }
    }
  }
  const appManifest = path.join(appRoot, 'resources', 'app', 'package.json')
  if (existsSync(appManifest)) {
    try {
      const manifest = JSON.parse(readFileSync(appManifest, 'utf8'))
      if (typeof manifest.version === 'string') return { version: manifest.version, asar: asar ?? null }
    } catch {
      // fall through
    }
  }
  return { version: undefined, asar: asar ?? null }
}

/** Locate the CLI entry inside the archive, tolerating a renamed desktop-host package. */
function cliPathOf(asar) {
  if (asar === null) return undefined
  for (const candidate of CLI_SUFFIXES) {
    if (asar.readFile(candidate) !== null) return candidate
  }
  const listed = asar.list().find((name) => /\/dsh-desktop-host\/lib\/cli\.js$/.test(name) || /\/dsh\/lib\/bin\.js$/.test(name))
  return listed
}

/** The pnpm script a runtime ships for profile operations. */
function pnpmOf(appRoot) {
  const candidate = path.join(appRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Resolve a runtime source into something bootable.
 * @param source - installed directory, resources directory, or installer `.exe`.
 * @param options - temporary root and a progress callback.
 * @returns the runtime facts, or a reason and the cleaned-up temp path.
 */
export async function resolveRuntime(source, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const tempRoot = path.join(options.tempRoot ?? os.tmpdir(), `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const detail = {
    source,
    kind: undefined,
    appRoot: undefined,
    exe: undefined,
    cliJs: undefined,
    version: undefined,
    asarPath: undefined,
    pnpm: undefined,
    extracted: false,
    tempRoot,
    cleanup: async () => removeProbeHome(tempRoot),
  }
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, reason: '没有给出运行时目录或安装包路径', detail }
  }
  const target = path.resolve(source.trim())
  if (!existsSync(target)) {
    return { ok: false, reason: `路径不存在：${target}`, detail }
  }

  let appRoot
  const stat = statSync(target)
  if (stat.isDirectory()) {
    if (existsSync(path.join(target, 'resources', 'app.asar'))) appRoot = target
    else if (existsSync(path.join(target, 'app.asar'))) appRoot = path.dirname(target)
    else if (existsSync(path.join(target, 'DeepSeek Harness.exe')) && existsSync(path.join(target, 'resources'))) appRoot = target
    if (appRoot === undefined) {
      return { ok: false, reason: `目录里没有 resources/app.asar：${target}`, detail }
    }
    detail.kind = 'directory'
  } else if (/\.exe$/i.test(target)) {
    const sevenZip = find7z()
    if (sevenZip === undefined) {
      return { ok: false, reason: '需要 7-Zip 解包安装包：未找到 7z.exe（可设置 DSH_GUARD_7Z）', detail }
    }
    detail.kind = 'installer'
    detail.extracted = true
    log(`解包安装包（${Math.round(stat.size / 1024 / 1024)} MB）`)
    const unpacked = path.join(tempRoot, 'unpacked')
    const first = extract(sevenZip, target, unpacked)
    if (!first.ok) {
      await detail.cleanup()
      return { ok: false, reason: `解包安装包失败（7z 退出码 ${String(first.status)}）`, detail }
    }
    const payload = findUnder(unpacked, (name) => /^app-64\.7z$/i.test(name))
    if (payload !== undefined) {
      log('解包应用负载')
      const appDir = path.join(tempRoot, 'app')
      const second = extract(sevenZip, payload, appDir)
      if (!second.ok) {
        await detail.cleanup()
        return { ok: false, reason: `解包应用负载失败（7z 退出码 ${String(second.status)}）`, detail }
      }
      appRoot = findAppRoot(appDir)
    } else {
      appRoot = findAppRoot(unpacked)
    }
    if (appRoot === undefined) {
      await detail.cleanup()
      return { ok: false, reason: '解包后没有找到 DeepSeek Harness.exe / resources/app.asar', detail }
    }
  } else {
    return { ok: false, reason: `不支持的运行时来源：${target}（给安装目录或安装包 .exe）`, detail }
  }

  const exe = path.join(appRoot, 'DeepSeek Harness.exe')
  if (!existsSync(exe)) {
    if (detail.extracted) await detail.cleanup()
    return { ok: false, reason: `运行时目录里没有 DeepSeek Harness.exe：${appRoot}`, detail }
  }
  const { version, asar } = versionOf(appRoot)
  const cli = cliPathOf(asar)
  if (cli === undefined) {
    if (detail.extracted) await detail.cleanup()
    return { ok: false, reason: '运行时里找不到 CLI 入口（dsh-desktop-host/lib/cli.js）', detail }
  }
  // The archive path is what the launcher process can open; Electron reads
  // inside `app.asar` from the filesystem path, plain Node cannot.
  const cliJs = path.join(appRoot, 'resources', 'app.asar', cli)
  Object.assign(detail, {
    appRoot,
    exe,
    cliJs,
    version,
    asarPath: path.join(appRoot, 'resources', 'app.asar'),
    pnpm: pnpmOf(appRoot),
    asar,
  })
  return { ok: true, detail }
}
