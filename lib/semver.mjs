/**
 * Minimal semver range matching for the subset DSH manifests use.
 *
 * DSH compares a plugin's `engines.dsh` (or `peerDependencies`) against one
 * runtime version, and prereleases take part in that comparison. This module
 * implements only what a manifest can express: exact versions, x-ranges, caret,
 * tilde, plain comparators, space-separated conjunctions, and `||` alternatives.
 * It never throws: an unparseable version or range yields `false`, so callers
 * treat it as unmet instead of crashing their own plugin.
 *
 * @module plugin-guard/lib/semver
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/

/**
 * Parse an exact version.
 * @param text - version text such as `0.2.2-rc.1`.
 * @returns the parsed version, or null when it is not an exact version.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Split a prerelease into comparable identifiers (numeric ones compare numerically). */
function prereleaseIdentifiers(version) {
  return version.prerelease.map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

/**
 * Compare two versions under semver precedence rules, prereleases included.
 * @param a - left version (string or parsed).
 * @param b - right version (string or parsed).
 * @returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (left === null || right === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const leftPre = prereleaseIdentifiers(left)
  const rightPre = prereleaseIdentifiers(right)
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const length = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index]
    const rightPart = rightPre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return leftPart < rightPart ? -1 : 1
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** A partial version such as `1`, `1.2`, `1.2.x`, or `*`, with wildcard slots as null. */
function parsePartial(text) {
  const match = PARTIAL_RE.exec(String(text).trim())
  if (match === null) return null
  const slot = (value) => {
    if (value === undefined) return null
    if (value === 'x' || value === 'X' || value === '*') return null
    return Number(value)
  }
  const version = {
    major: slot(match[1]),
    minor: slot(match[2]),
    patch: slot(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
  if (version.major === null) return { major: 0, minor: 0, patch: 0, prerelease: [], wildcard: true }
  return version
}

/** Build a concrete version from a partial one, filling absent slots with zero. */
function concrete(version) {
  return { major: version.major, minor: version.minor ?? 0, patch: version.patch ?? 0, prerelease: version.prerelease }
}

/** Turn one comparator token into a predicate pair `[lower, upper]` (either may be null). */
function comparatorBounds(token) {
  const match = COMPARATOR_RE.exec(token.trim())
  if (match === null) return null
  const operator = match[1] ?? ''
  const raw = match[2].trim()
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') {
    if (operator === '' || operator === '=') return { lower: null, upper: null, exact: null }
    return null
  }
  const partial = parsePartial(raw)
  if (partial === null) return null
  if (partial.wildcard === true) return { lower: null, upper: null, exact: null }
  const base = concrete(partial)

  if (operator === '' || operator === '=') {
    if (partial.minor === null) {
      return { lower: base, upper: { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }, exact: null }
    }
    if (partial.patch === null) {
      return { lower: base, upper: { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }, exact: null }
    }
    return { lower: base, upper: base, exact: true }
  }
  if (operator === '>') return { lower: base, upper: null, strictLower: true, exact: null }
  if (operator === '>=') return { lower: base, upper: null, exact: null }
  if (operator === '<') return { lower: null, upper: base, strictUpper: true, exact: null }
  if (operator === '<=') return { lower: null, upper: base, inclusiveUpper: true, exact: null }
  if (operator === '^') {
    if (base.major > 0) return { lower: base, upper: { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }, exact: null }
    if (partial.minor === null) return { lower: base, upper: { major: 1, minor: 0, patch: 0, prerelease: [] }, exact: null }
    if (base.minor > 0) return { lower: base, upper: { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }, exact: null }
    if (partial.patch === null) return { lower: base, upper: { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }, exact: null }
    return { lower: base, upper: { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] }, exact: null }
  }
  if (operator === '~') {
    if (partial.minor === null) return { lower: base, upper: { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }, exact: null }
    return { lower: base, upper: { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }, exact: null }
  }
  return null
}

/** Whether one parsed version satisfies one conjunction (an array of tokens). */
function satisfiesConjunction(version, tokens) {
  for (const token of tokens) {
    const bounds = comparatorBounds(token)
    if (bounds === null) return false
    if (bounds.lower !== null) {
      const order = compareVersions(version, bounds.lower)
      if (bounds.strictLower === true ? order <= 0 : order < 0) return false
    }
    if (bounds.upper !== null) {
      const order = compareVersions(version, bounds.upper)
      if (bounds.exact === true) {
        if (order !== 0) return false
      } else if (bounds.inclusiveUpper === true) {
        if (order > 0) return false
      } else if (order >= 0) {
        return false
      }
    }
  }
  return true
}

/** Whether `range` is a range this module understands. */
export function isValidRange(range) {
  if (typeof range !== 'string') return false
  const text = range.trim()
  if (text === '') return false
  if (text.includes('workspace:')) return false
  for (const alternative of text.split('||')) {
    const tokens = alternative.trim().split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0) return false
    for (const token of tokens) if (comparatorBounds(token) === null) return false
  }
  return true
}

/**
 * Whether a version satisfies a range. An empty range means "no constraint" and
 * satisfies everything; an unparseable version or range does not.
 * @param version - exact version text.
 * @param range - semver range text.
 * @returns whether the version is admitted.
 */
export function satisfies(version, range) {
  if (range === undefined || range === null) return true
  if (typeof range !== 'string') return false
  const text = range.trim()
  if (text === '' || text === '*' || text === 'x' || text === 'X') return true
  const parsed = parseVersion(version)
  if (parsed === null) return false
  if (text.includes('workspace:')) return false
  for (const alternative of text.split('||')) {
    const tokens = alternative.trim().split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0) continue
    if (satisfiesConjunction(parsed, tokens)) return true
  }
  return false
}
