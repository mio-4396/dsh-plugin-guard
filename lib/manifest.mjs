/**
 * Read one plugin package's manifest and judge the parts a boot depends on:
 * the entry file, the bundle patch, the client bundle, platform and version
 * declarations. Nothing here decides a crash — only the probe does — but every
 * finding names a concrete reason the probe is worth running or why a package
 * cannot load at all.
 *
 * @module plugin-guard/lib/manifest
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isValidRange, satisfies } from './semver.mjs'

/** Finding levels shared by every analysis module. */
export const LEVEL = { FAIL: 'fail', WARN: 'warn', INFO: 'info' }

/** Create one finding. */
export function finding(level, code, message, where) {
  return where === undefined ? { level, code, message } : { level, code, message, where }
}

/**
 * Read a `package.json` from a directory or a direct path.
 * @param dirOrFile - package directory or `package.json` path.
 * @returns the parsed manifest, or an error description.
 */
export function readManifest(dirOrFile) {
  const manifestPath = dirOrFile.endsWith('.json') ? dirOrFile : path.join(dirOrFile, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, path: manifestPath, error: 'package.json not found' }
  try {
    const text = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(text)
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { ok: false, path: manifestPath, error: 'package.json is not a JSON object' }
    }
    return { ok: true, path: manifestPath, manifest }
  } catch (error) {
    return { ok: false, path: manifestPath, error: String(error?.message ?? error) }
  }
}

/** Pick the export target for the `.` subpath out of an `exports` declaration. */
function rootExportTarget(exportsField) {
  if (typeof exportsField === 'string') return exportsField
  if (exportsField === null || typeof exportsField !== 'object') return undefined
  const root = exportsField['.']
  if (typeof root === 'string') return root
  if (root !== null && typeof root === 'object') {
    for (const key of ['import', 'default', 'node', 'require']) {
      if (typeof root[key] === 'string') return root[key]
    }
  }
  return undefined
}

/** Resolve a relative target to an existing file, tolerating a missing extension. */
export function resolveFile(pkgDir, relative) {
  const direct = path.resolve(pkgDir, relative)
  if (existsSync(direct) && statSync(direct).isFile()) return direct
  for (const suffix of ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs']) {
    const candidate = direct + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return direct
}

/** Read a small text file without throwing. */
function readSmall(file, limit = 256 * 1024) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return undefined
  }
}

/** Drop whole-line comments so patch checks read the YAML itself. */
function stripCommentLines(text) {
  return text.split(/\r?\n/).filter((line) => !/^[ \t]*#/.test(line)).join('\n')
}

/** Row names declared by one bundle patch file. */
function patchRowNames(text) {
  const names = []
  const pattern = /^[ \t]*name:[ \t]*['"]?([^'"\r\n#]+?)['"]?[ \t]*$/gm
  const code = stripCommentLines(text)
  let match
  while ((match = pattern.exec(code)) !== null) names.push(match[1].trim())
  return names
}

/**
 * Analyze one package directory.
 * @param pkgDir - absolute package directory.
 * @param options - runtime version and host platform used for the declarations.
 * @returns facts, findings and the bundle patch row names.
 */
export function analyzeManifest(pkgDir, options = {}) {
  const runtimeVersion = options.runtimeVersion
  const platform = options.platform ?? process.platform
  const findings = []
  const facts = {
    name: undefined,
    version: undefined,
    type: undefined,
    entryPath: undefined,
    entrySource: undefined,
    hasBundle: false,
    bundlePatchPaths: [],
    clientPath: undefined,
    platforms: undefined,
    enginesDsh: undefined,
    nodeEngine: undefined,
  }
  const rowNames = []

  const read = readManifest(pkgDir)
  if (!read.ok) {
    findings.push(finding(LEVEL.FAIL, 'manifest-unreadable', `无法读取 package.json：${read.error}`, read.path))
    return { ok: false, facts, findings, rowNames }
  }
  const manifest = read.manifest
  facts.name = typeof manifest.name === 'string' ? manifest.name : undefined
  facts.version = typeof manifest.version === 'string' ? manifest.version : undefined
  facts.type = typeof manifest.type === 'string' ? manifest.type : undefined

  if (facts.name === undefined || facts.name === '') {
    findings.push(finding(LEVEL.FAIL, 'manifest-name', 'package.json 缺少 name，DSH 无法把这个包识别为插件', read.path))
  }
  if (facts.version !== undefined && !/^\d+\.\d+\.\d+/.test(facts.version)) {
    findings.push(finding(LEVEL.WARN, 'manifest-version', `version "${facts.version}" 不是 semver，版本比较会失败`, read.path))
  }

  // Entry: exports["."] first, then main, then the conventional index.js.
  const exported = rootExportTarget(manifest.exports)
  const mainTarget = exported ?? (typeof manifest.main === 'string' ? manifest.main : undefined)
  const entry = resolveFile(pkgDir, mainTarget ?? 'index.js')
  facts.entryPath = entry
  facts.entrySource = exported !== undefined ? 'exports["."]' : typeof manifest.main === 'string' ? 'main' : 'index.js'
  if (!existsSync(entry)) {
    findings.push(finding(LEVEL.FAIL, 'entry-missing', `入口文件不存在：${entry}（来自 ${facts.entrySource}），插件加载时必然失败`, entry))
  } else if (mainTarget === undefined) {
    findings.push(finding(LEVEL.WARN, 'entry-implicit', '没有声明 main / exports["."]，按约定回退到 index.js', entry))
  }

  // Bundle patch: the only thing that makes the package installable as a bundle.
  const bundle = manifest.dsh?.bundle
  if (bundle !== null && typeof bundle === 'object') {
    facts.hasBundle = true
    const declared = bundle.patch
    const files = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : []
    if (files.length === 0) {
      findings.push(finding(LEVEL.FAIL, 'bundle-patch-missing', 'dsh.bundle 存在但没有声明 patch 文件', read.path))
    }
    for (const relative of files) {
      const patchPath = path.resolve(pkgDir, relative)
      facts.bundlePatchPaths.push(patchPath)
      if (!existsSync(patchPath)) {
        findings.push(finding(LEVEL.FAIL, 'bundle-patch-missing', `bundle patch 文件不存在：${relative}`, patchPath))
        continue
      }
      const text = readSmall(patchPath)
      if (text === undefined) {
        findings.push(finding(LEVEL.FAIL, 'bundle-patch-unreadable', `bundle patch 无法读取：${relative}`, patchPath))
        continue
      }
      const trimmed = stripCommentLines(text).trim()
      if (trimmed === '' || trimmed === '[]') {
        findings.push(finding(LEVEL.WARN, 'bundle-patch-empty', 'bundle patch 是空数组：装上后不会插入任何插件行', patchPath))
        continue
      }
      if (!trimmed.startsWith('-') && !trimmed.startsWith('[')) {
        findings.push(finding(LEVEL.WARN, 'bundle-patch-shape', 'bundle patch 不是顶层的 patch 数组（应以 `- ` 或 `[` 开头）', patchPath))
      }
      for (const name of patchRowNames(text)) {
        if (!rowNames.includes(name)) rowNames.push(name)
      }
    }
    const platforms = bundle.platforms
    if (platforms !== undefined) {
      if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((item) => typeof item !== 'string')) {
        findings.push(finding(LEVEL.WARN, 'bundle-platforms', 'dsh.bundle.platforms 不是非空字符串数组，元数据会被判为有问题', read.path))
      } else {
        facts.platforms = [...platforms]
        if (!platforms.includes(platform)) {
          findings.push(finding(LEVEL.FAIL, 'platform-mismatch', `插件只声明支持 ${platforms.join(', ')}，当前平台是 ${platform}`, read.path))
        }
      }
    }
  } else {
    findings.push(finding(LEVEL.WARN, 'not-a-bundle', '没有 dsh.bundle.patch：这是普通依赖，不能作为插件包安装', read.path))
  }

  // Client half: declared means it must exist, or the Web UI loses that surface.
  const client = manifest.dsh?.client
  if (client !== null && typeof client === 'object') {
    const clientTarget = typeof client.entry === 'string'
      ? client.entry
      : typeof manifest.exports === 'object' && manifest.exports !== null && typeof manifest.exports['./client'] === 'string'
        ? manifest.exports['./client']
        : './client.js'
    const clientPath = resolveFile(pkgDir, clientTarget)
    facts.clientPath = clientPath
    if (!existsSync(clientPath)) {
      findings.push(finding(LEVEL.FAIL, 'client-missing', `声明了 dsh.client，但客户端入口不存在：${clientTarget}`, clientPath))
    }
    if (client.platform !== undefined && client.platform !== 'web') {
      findings.push(finding(LEVEL.WARN, 'client-platform', `客户端 platform 声明为 ${String(client.platform)}，Web 构建只会处理 web`, read.path))
    }
  }

  // Version declarations: engines.dsh alone decides when present.
  facts.enginesDsh = typeof manifest.engines?.dsh === 'string' ? manifest.engines.dsh : undefined
  facts.nodeEngine = typeof manifest.engines?.node === 'string' ? manifest.engines.node : undefined
  if (facts.enginesDsh !== undefined && !isValidRange(facts.enginesDsh)) {
    findings.push(finding(LEVEL.FAIL, 'engines-dsh-invalid', `engines.dsh "${facts.enginesDsh}" 不是可比较的 semver 范围，DSH 会拒绝加载`, read.path))
  } else if (facts.enginesDsh !== undefined && runtimeVersion !== undefined && !satisfies(runtimeVersion, facts.enginesDsh)) {
    findings.push(finding(LEVEL.FAIL, 'engines-dsh-mismatch', `engines.dsh "${facts.enginesDsh}" 不包含当前运行时 ${runtimeVersion}，插件行会被拒绝`, read.path))
  } else if (facts.enginesDsh === undefined) {
    findings.push(finding(LEVEL.WARN, 'engines-dsh-absent', '没有声明 engines.dsh，DSH 只能按 peerDependencies 判断兼容性', read.path))
  }
  if (facts.nodeEngine !== undefined && runtimeNodeVersion() !== null && !satisfies(runtimeNodeVersion(), facts.nodeEngine)) {
    findings.push(finding(LEVEL.WARN, 'engines-node-mismatch', `engines.node "${facts.nodeEngine}" 不包含当前 Node ${runtimeNodeVersion()}`, read.path))
  }

  const peers = manifest.peerDependencies
  if (facts.enginesDsh === undefined && peers !== null && typeof peers === 'object') {
    for (const [name, range] of Object.entries(peers)) {
      if (!/^@deepseek-ai\/dsh(?:-|$)|^dsh$/.test(name)) continue
      if (typeof range !== 'string' || !isValidRange(range)) {
        findings.push(finding(LEVEL.FAIL, 'peer-invalid', `peerDependency ${name} 的范围 "${String(range)}" 不可比较`, read.path))
        continue
      }
      if (runtimeVersion !== undefined && !satisfies(runtimeVersion, range)) {
        findings.push(finding(LEVEL.FAIL, 'peer-mismatch', `peerDependency ${name} "${range}" 不包含当前运行时 ${runtimeVersion}`, read.path))
      }
    }
  }

  // Row names inside the patch: relative or absolute rows must resolve now.
  for (const name of rowNames) {
    if (name.startsWith('.') || path.isAbsolute(name)) {
      const target = resolveFile(path.dirname(facts.bundlePatchPaths[0] ?? pkgDir), name)
      if (!existsSync(target)) {
        findings.push(finding(LEVEL.FAIL, 'row-target-missing', `bundle patch 的行指向不存在的模块：${name}`, target))
      }
    } else if (facts.name !== undefined && name === facts.name) {
      continue
    } else if (name.startsWith('@deepseek-ai/')) {
      continue
    }
  }

  return { ok: true, facts, findings, rowNames }
}

/** The host Node version, or null when it cannot be read. */
function runtimeNodeVersion() {
  const version = process.versions?.node
  if (typeof version !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`
}
