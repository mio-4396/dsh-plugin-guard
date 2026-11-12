/**
 * Static hazard scan over the JavaScript a plugin actually loads.
 *
 * Only the runtime graph matters: the entry module and whatever relative
 * imports it reaches. Build scripts (`scripts/`), tests, and other files the
 * loader never imports are excluded, because a `process.exit(1)` in a build
 * script says nothing about booting DSH.
 *
 * Nothing found here proves a crash: the boot probe decides. What the scan does
 * is name the mechanisms that make a crash likely and give a line to look at.
 *
 * @module plugin-guard/lib/scan
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { finding, LEVEL, resolveFile } from './manifest.mjs'

const SOURCE_RE = /\.(?:js|mjs|cjs)$/i
const MAX_FILES = 200
const MAX_BYTES = 512 * 1024
const MAX_DEPTH = 6
const MAX_FINDINGS = 24

/** Patterns that can end or freeze the host process. */
const PATTERNS = [
  { code: 'process-exit', re: /\bprocess\s*\.\s*exit\s*\(/g, level: LEVEL.WARN, message: '调用了 process.exit()：若在加载或激活阶段执行，DSH 进程会直接退出' },
  { code: 'process-abort', re: /\bprocess\s*\.\s*abort\s*\(/g, level: LEVEL.WARN, message: '调用了 process.abort()：会让进程立即终止' },
  { code: 'busy-loop', re: /\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/g, level: LEVEL.WARN, message: '存在无条件循环：若在加载阶段执行，启动会永久卡住' },
  { code: 'atomics-wait', re: /\bAtomics\s*\.\s*wait\s*\(/g, level: LEVEL.WARN, message: '调用了 Atomics.wait()：会同步阻塞线程' },
  { code: 'sync-child-process', re: /\b(?:execSync|spawnSync)\s*\(/g, level: LEVEL.WARN, message: '使用同步子进程：加载阶段的阻塞会拖住启动' },
  { code: 'dynamic-code', re: /\beval\s*\(|\bnew\s+Function\s*\(/g, level: LEVEL.WARN, message: '使用 eval / new Function 动态执行代码' },
  { code: 'native-addon', re: /require\s*\(\s*['"][^'"]+\.node['"]\s*\)/g, level: LEVEL.WARN, message: '加载原生 .node 扩展：架构或 ABI 不匹配会让进程直接退出' },
  { code: 'write-outside-effects', re: /\bwriteFileSync\s*\(/g, level: LEVEL.INFO, message: '存在同步写文件调用：若在加载阶段执行会拖慢启动并产生副作用' },
]

/** Import specifiers that point at another local module. */
const IMPORT_RE = /(?:^|[^\w$.])(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|[^\w$.])(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Whether one source line is a comment rather than executable code. */
function isCommentLine(text, index) {
  let start = index
  while (start > 0 && text.charCodeAt(start - 1) !== 10) start -= 1
  const line = text.slice(start, index).trim()
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')
}

/** Line number of one match offset. */
function lineAt(text, index) {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/** Relative import targets of one module. */
function localImports(text) {
  const specs = []
  IMPORT_RE.lastIndex = 0
  let match
  while ((match = IMPORT_RE.exec(text)) !== null) {
    const specifier = match[1] ?? match[2]
    if (typeof specifier !== 'string') continue
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
    if (!specs.includes(specifier)) specs.push(specifier)
  }
  return specs
}

/** Resolve one relative import against its importing file. */
function resolveImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/** Collect the runtime module graph from the declared entry files. */
function collectGraph(pkgDir, entries) {
  const found = []
  const seen = new Set()
  const queue = []
  for (const entry of entries) {
    if (typeof entry === 'string' && SOURCE_RE.test(entry) && existsSync(entry)) queue.push({ file: entry, depth: 0 })
  }
  while (queue.length > 0 && found.length < MAX_FILES) {
    const next = queue.shift()
    const key = path.resolve(next.file)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(key)
    if (next.depth >= MAX_DEPTH) continue
    let text
    try {
      if (statSync(key).size > MAX_BYTES) continue
      text = readFileSync(key, 'utf8')
    } catch {
      continue
    }
    for (const specifier of localImports(text)) {
      const resolved = resolveImport(key, specifier)
      if (resolved !== undefined) queue.push({ file: resolved, depth: next.depth + 1 })
    }
  }
  return found
}

/** Files a package loads when no entry could be resolved: the usual runtime layout. */
function fallbackFiles(pkgDir) {
  const files = []
  const roots = [pkgDir, path.join(pkgDir, 'lib'), path.join(pkgDir, 'src')]
  for (const root of roots) {
    for (const name of ['index.js', 'index.mjs', 'client.js', 'client.mjs']) {
      const candidate = path.join(root, name)
      if (existsSync(candidate) && statSync(candidate).isFile() && !files.includes(candidate)) files.push(candidate)
    }
  }
  return files
}

/**
 * Scan a package's runtime graph for the hazard patterns above.
 * @param pkgDir - absolute package directory.
 * @param options - `entries` (entry and client files) to start the graph from.
 * @returns findings and how many modules were read.
 */
export function scanPackage(pkgDir, options = {}) {
  const findings = []
  const declared = Array.isArray(options.entries) ? options.entries.filter((entry) => typeof entry === 'string') : []
  const entries = declared.filter((entry) => SOURCE_RE.test(entry) && existsSync(entry))
  const usedFallback = entries.length === 0
  const graph = usedFallback ? fallbackFiles(pkgDir) : collectGraph(pkgDir, entries)
  if (graph.length === 0) {
    return {
      findings: [finding(LEVEL.INFO, 'scan-empty', '没有定位到运行时代码，跳过危险模式扫描', pkgDir)],
      scanned: 0,
      files: 0,
      usedFallback,
    }
  }
  let scanned = 0
  let tooLarge = 0
  for (const file of graph) {
    if (findings.length >= MAX_FINDINGS) break
    let size
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size > MAX_BYTES) {
      tooLarge += 1
      continue
    }
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scanned += 1
    const relative = path.relative(pkgDir, file) || file
    for (const pattern of PATTERNS) {
      if (findings.length >= MAX_FINDINGS) break
      pattern.re.lastIndex = 0
      let match
      let shown = 0
      while ((match = pattern.re.exec(text)) !== null && shown < 2) {
        if (!isCommentLine(text, match.index)) {
          findings.push(finding(pattern.level, pattern.code, pattern.message, `${relative}:${lineAt(text, match.index)}`))
          shown += 1
          continue
        }
        shown += 1
      }
    }
  }
  if (tooLarge > 0) {
    findings.push(finding(LEVEL.INFO, 'large-sources', `${tooLarge} 个模块超过 ${Math.round(MAX_BYTES / 1024)} KB，已跳过扫描`, pkgDir))
  }
  return { findings, scanned, files: graph.length, usedFallback }
}
