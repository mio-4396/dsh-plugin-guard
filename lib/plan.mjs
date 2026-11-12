/**
 * Normalize whatever the caller names into something the probe can install.
 *
 * A plugin can be named as an installed bundle, a directory, a `link:` spec, a
 * registry range, or a git address. The probe always needs one of two things:
 * a directory to link, or a pnpm install spec.
 *
 * @module plugin-guard/lib/plan
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { finding, LEVEL, readManifest } from './manifest.mjs'

/** Read a profile's dependencies without throwing. */
function profileDependencies(profileDir) {
  if (profileDir === undefined) return {}
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const dependencies = manifest?.dependencies
    return dependencies !== null && typeof dependencies === 'object' ? dependencies : {}
  } catch {
    return {}
  }
}

/** A directory holding a package.json. */
function isPackageDir(dir) {
  try {
    return statSync(dir).isDirectory() && existsSync(path.join(dir, 'package.json'))
  } catch {
    return false
  }
}

/** Strip a `link:` / `file:` prefix into an absolute path. */
function localPathFromSpec(spec, base) {
  const match = /^(?:link|file):(.+)$/i.exec(spec)
  if (match === null) return undefined
  const target = match[1].trim()
  return path.isAbsolute(target) ? target : path.resolve(base ?? process.cwd(), target)
}

/**
 * Resolve one user/model supplied target.
 * @param input - bundle name, package directory, `link:` spec, or registry/git spec.
 * @param options - profile directory used to recognise installed bundles.
 * @returns the resolved target; `ok` is false when nothing can be probed.
 */
export function resolveTarget(input, options = {}) {
  const profileDir = options.profileDir
  const raw = String(input ?? '').trim()
  if (raw === '') {
    return { ok: false, kind: 'unknown', findings: [finding(LEVEL.FAIL, 'target-empty', '没有给出要检查的插件')] }
  }
  const findings = []

  // An explicit directory, or a link:/file: dependency spec.
  const linked = localPathFromSpec(raw, profileDir)
  if (linked !== undefined) {
    if (!isPackageDir(linked)) {
      return { ok: false, kind: 'directory', dir: linked, findings: [finding(LEVEL.FAIL, 'target-missing', `目录里没有 package.json：${linked}`)] }
    }
    const read = readManifest(linked)
    return {
      ok: true,
      kind: 'directory',
      dir: linked,
      spec: `link:${linked}`,
      name: read.ok ? read.manifest.name : undefined,
      version: read.ok ? read.manifest.version : undefined,
      findings,
    }
  }

  // A plain path, absolute or relative to the profile.
  const asPath = path.isAbsolute(raw) ? raw : path.resolve(profileDir ?? process.cwd(), raw)
  if (isPackageDir(asPath)) {
    const read = readManifest(asPath)
    return {
      ok: true,
      kind: 'directory',
      dir: asPath,
      spec: `link:${asPath}`,
      name: read.ok ? read.manifest.name : undefined,
      version: read.ok ? read.manifest.version : undefined,
      findings,
    }
  }

  const dependencies = profileDependencies(profileDir)

  // An installed bundle: prefer its installed copy, which is what the runtime uses.
  if (Object.hasOwn(dependencies, raw)) {
    const declared = String(dependencies[raw])
    const declaredDir = localPathFromSpec(declared, profileDir)
    if (declaredDir !== undefined && isPackageDir(declaredDir)) {
      const read = readManifest(declaredDir)
      return {
        ok: true,
        kind: 'directory',
        dir: declaredDir,
        spec: `link:${declaredDir}`,
        name: raw,
        version: read.ok ? read.manifest.version : undefined,
        findings,
        installed: true,
        declared,
      }
    }
    if (profileDir !== undefined) {
      const installedDir = path.join(profileDir, 'node_modules', raw)
      if (isPackageDir(installedDir)) {
        const read = readManifest(installedDir)
        const version = read.ok ? read.manifest.version : undefined
        return {
          ok: true,
          kind: version !== undefined ? 'spec' : 'directory',
          dir: installedDir,
          spec: version !== undefined ? `${raw}@${version}` : `link:${installedDir}`,
          name: raw,
          version,
          findings,
          installed: true,
          declared,
        }
      }
    }
    findings.push(finding(LEVEL.WARN, 'installed-unreadable', `${raw} 在 profile 里声明为 ${declared}，但读不到已安装的副本`, profileDir))
    return { ok: true, kind: 'spec', spec: declared, name: raw, findings, installed: true, declared }
  }

  // A bundle the installation itself ships: read it there, never from a registry.
  if (typeof options.installationDir === 'string' && /^(@[^/]+\/)?[^/@\s]+$/.test(raw)) {
    const shippedDir = path.join(options.installationDir, raw)
    if (isPackageDir(shippedDir)) {
      const read = readManifest(shippedDir)
      return {
        ok: true,
        kind: 'directory',
        dir: shippedDir,
        spec: `link:${shippedDir}`,
        name: raw,
        version: read.ok ? read.manifest.version : undefined,
        findings,
        shipped: true,
      }
    }
  }

  // A registry range, git address, or a bare name meaning "the published one".
  const isGit = /^(?:github:|git\+|https?:\/\/|ssh:\/\/|git@)/i.test(raw)
  const hasVersion = /^(@[^/]+\/)?[^/@]+@[^/]+$/.test(raw)
  if (isGit || hasVersion || /^(@[^/]+\/)?[^/@\s]+$/.test(raw)) {
    if (!isGit && !hasVersion) {
      findings.push(finding(LEVEL.INFO, 'registry-latest', `${raw} 未安装，会按 registry 上的最新版本检查`, raw))
    }
    return { ok: true, kind: 'spec', spec: raw, name: raw.replace(/@[^@/]*$/, ''), findings }
  }

  return { ok: false, kind: 'unknown', findings: [finding(LEVEL.FAIL, 'target-unrecognized', `无法把 "${raw}" 解析成目录、已安装插件或安装 spec`)] }
}
