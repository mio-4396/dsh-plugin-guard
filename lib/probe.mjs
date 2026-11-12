/**
 * Boot one candidate plugin in a throwaway DSH home and watch what happens.
 *
 * The probe is the only authority on "would this crash DSH": a module can pass
 * every static check and still call `process.exit` while loading, and a module
 * that only throws is merely skipped. The probe therefore runs the real
 * launcher against a freshly created `web` profile in a temporary DSH home:
 *
 *  1. `<launcher> <probe> --from-default-profile web --dump-config` creates it (≈0.3 s).
 *  2. `<launcher> plugin --profile <probe> add <spec>` installs the candidate.
 *  3. `<launcher> --profile <probe> --port 0 --no-open` boots the Web surface.
 *
 * An HTTP URL on stdout means the boot completed; an exit beforehand is a crash
 * with its code; no URL until the deadline is a hang. The temporary home is
 * removed afterwards, so the real profile, its node_modules, and its patch files
 * are never touched.
 *
 * @module plugin-guard/lib/probe
 */

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Where isolated probe homes live. */
export const PROBE_ROOT = path.join(os.tmpdir(), 'dsh-plugin-guard')

const TAIL_BYTES = 16 * 1024
const CAPTURE_LIMIT = 64 * 1024
const URL_RE = /https?:\/\/[^\s"'<>]+/
/** The launcher's own ready line, preferred over any URL a plugin might print. */
const READY_RE = /dsh web:\s*(https?:\/\/[^\s"'<>]+)/
/** Only the real app shell carries this marker: `dsh web` injects it. */
const BOOT_MARKER = '__DSH_BOOT__'

/** One HTTP GET, returning status, headers and body without following redirects. */
function fetchOnce(url, timeoutMs, cookie) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const headers = cookie === undefined ? {} : { cookie }
      const req = request(url, { method: 'GET', timeout: timeoutMs, headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 512 * 1024) req.destroy()
        })
        res.on('end', () => finish({ status: res.statusCode, location: res.headers.location, setCookie: res.headers['set-cookie'], body }))
      })
      req.on('error', () => finish(null))
      req.on('timeout', () => {
        req.destroy()
        finish(null)
      })
      req.end()
    } catch {
      finish(null)
    }
  })
}

/**
 * Whether a printed URL is the real DSH Web surface.
 *
 * A plugin can print a URL and answer HTTP on it, so reachability alone is not
 * enough. The real surface answers the token URL with an auth redirect that sets
 * a cookie, and the page it then serves carries the `__DSH_BOOT__` marker only
 * `dsh web` injects.
 * @param url - candidate URL from the child's stdout.
 * @param timeoutMs - per-request deadline.
 * @returns whether the DSH app shell answered.
 */
async function servesDsh(url, timeoutMs = 5000) {
  const first = await fetchOnce(url, timeoutMs)
  if (first === null) return false
  if (first.status !== undefined && first.status >= 300 && first.status < 400 && typeof first.location === 'string') {
    const cookie = (first.setCookie ?? []).map((value) => String(value).split(';')[0]).join('; ')
    let target
    try {
      target = new URL(first.location, url).href
    } catch {
      return false
    }
    const second = await fetchOnce(target, timeoutMs, cookie === '' ? undefined : cookie)
    return second !== null && second.status === 200 && second.body.includes(BOOT_MARKER)
  }
  return first.status === 200 && first.body.includes(BOOT_MARKER)
}

/** A free loopback port, so a plugin cannot decide where the Web surface lives. */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(0))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** Keep the last `limit` characters of one captured stream. */
function tail(text, limit = TAIL_BYTES) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** Append to a capture, keeping memory bounded. */
function append(capture, chunk) {
  capture.text += chunk
  if (capture.text.length > CAPTURE_LIMIT) capture.text = capture.text.slice(-CAPTURE_LIMIT)
}

/** The `app.asar` archive containing one packaged path, if it is packaged. */
function asarArchiveOf(candidate) {
  const normalized = candidate.replace(/\\/g, '/')
  const index = normalized.indexOf('/app.asar/')
  if (index < 0) return undefined
  return normalized.slice(0, index + '/app.asar'.length).replace(/\//g, path.sep)
}

/**
 * Locate the launcher that owns this process.
 *
 * The Host runs `DeepSeek Harness.exe --expose-internals <runtime>/dsh/node_modules/
 * @deepseek-ai/dsh-desktop-host/lib/index.js`; the CLI entry sits beside it. The
 * packaged fallback covers a Host booted from another entry point.
 * @returns the executable and CLI script, or the reason they are unavailable.
 */
export function createLauncher() {
  const overrideExe = process.env.DSH_GUARD_LAUNCHER_EXE
  const overrideCli = process.env.DSH_GUARD_LAUNCHER_CLI
  const exe = typeof overrideExe === 'string' && overrideExe !== '' ? overrideExe : process.execPath
  const candidates = []
  if (typeof overrideCli === 'string' && overrideCli !== '') {
    if (existsSync(overrideCli)) return { ok: true, exe, cliJs: overrideCli }
    candidates.push(overrideCli)
  }
  const argvEntry = process.argv[1]
  if (typeof argvEntry === 'string' && argvEntry.length > 0) candidates.push(path.join(path.dirname(argvEntry), 'cli.js'))
  if (typeof process.resourcesPath === 'string') {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'))
  }
  candidates.push(path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { ok: true, exe, cliJs: candidate }
  }
  // An `app.asar` is one file, so a path inside it never "exists" for a plain
  // Node caller — but the child that runs it is Electron and reads it fine.
  for (const candidate of candidates) {
    const archive = asarArchiveOf(candidate)
    if (archive !== undefined && existsSync(archive)) return { ok: true, exe, cliJs: candidate }
  }
  return {
    ok: false,
    exe,
    reason: '找不到 DSH 启动器（dsh-desktop-host/lib/cli.js）：只能做静态检查',
    tried: candidates,
  }
}

/** Environment for a child launcher: run as Node, isolated DSH home, no inherited profile. */
function childEnv(home) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) delete env[key]
  return env
}

/** Kill a process and its descendants (Windows) or its group elsewhere. */
function killTree(pid) {
  if (typeof pid !== 'number') return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // The process may already be gone.
  }
}

/**
 * Run one launcher command to completion.
 * @returns status `exit` with a code, or `timeout` once the deadline passed.
 */
function runCommand(launcher, args, home, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(launcher.exe, ['--expose-internals', launcher.cliJs, ...args], {
        env: childEnv(home),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ status: 'error', code: null, stdout: '', stderr: String(error?.message ?? error), ms: Date.now() - started })
      return
    }
    const out = { text: '' }
    const err = { text: '' }
    child.stdout.on('data', (chunk) => append(out, String(chunk)))
    child.stderr.on('data', (chunk) => append(err, String(chunk)))
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child.pid)
      const settle = () => resolve({ status: 'timeout', code: null, stdout: tail(out.text), stderr: tail(err.text), ms: Date.now() - started })
      const grace = setTimeout(settle, 3000)
      child.once('close', () => {
        clearTimeout(grace)
        settle()
      })
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: 'error', code: null, stdout: out.text, stderr: String(error?.message ?? error), ms: Date.now() - started })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: 'exit', code, stdout: out.text, stderr: err.text, ms: Date.now() - started })
    })
  })
}

/**
 * Boot the probe profile and decide between up / exit / hang.
 * @param port - the loopback port the probe chose; only that port can be the Web surface.
 * @returns the boot verdict with the URL when it came up.
 */
function runBoot(launcher, home, profile, timeoutMs, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(launcher.exe, [
        '--expose-internals', launcher.cliJs,
        '--profile', profile, '--port', String(port), '--no-open',
      ], { env: childEnv(home), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ status: 'error', code: null, url: null, stdout: '', stderr: String(error?.message ?? error), ms: Date.now() - started })
      return
    }
    const out = { text: '' }
    const err = { text: '' }
    let settled = false
    let deciding = false
    let verifying = false
    const rejected = new Set()
    const settle = (status, code, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child.pid)
      resolve({ status, code, url, stdout: tail(out.text), stderr: tail(err.text), ms: Date.now() - started })
    }
    const finish = (status, code, url) => {
      if (settled || deciding) return
      deciding = true
      killTree(child.pid)
      if (child.exitCode !== null || child.signalCode !== null) {
        settle(status, code, url)
        return
      }
      // Give the killed tree a moment to release its files before cleanup runs.
      const grace = setTimeout(() => settle(status, code, url), 3000)
      child.once('close', () => {
        clearTimeout(grace)
        settle(status, code, url)
      })
    }
    const tryReady = () => {
      if (settled || verifying) return
      const ready = READY_RE.exec(out.text)
      const generic = ready === null ? URL_RE.exec(out.text) : null
      const candidate = ready !== null ? ready[1] : generic === null ? null : generic[0]
      if (candidate === null || rejected.has(candidate)) return
      let parsed
      try {
        parsed = new URL(candidate)
      } catch {
        rejected.add(candidate)
        return
      }
      // The probe picked the port. Anything else is a plugin's own server, not
      // the Web surface the launcher started.
      if (parsed.port !== String(port)) {
        rejected.add(candidate)
        return
      }
      verifying = true
      servesDsh(candidate).then((ok) => {
        verifying = false
        if (settled) return
        if (ok) {
          finish('up', null, candidate)
          return
        }
        rejected.add(candidate)
        setTimeout(tryReady, 250)
      })
    }
    const timer = setTimeout(() => finish('hang', null, null), timeoutMs)
    child.stdout.on('data', (chunk) => {
      append(out, String(chunk))
      tryReady()
    })
    child.stderr.on('data', (chunk) => append(err, String(chunk)))
    child.on('error', () => settle('error', null, null))
    child.on('close', (code) => {
      // Our own kill also closes the child; only a close before any decision is
      // the child's own exit.
      if (deciding) return
      // A URL may still be verified while the process is already gone; let the
      // verification settle first when one is in flight.
      if (verifying) {
        setTimeout(() => {
          if (!settled && !deciding) settle('exit', code, null)
        }, 4200)
        return
      }
      settle('exit', code, null)
    })
  })
}

/**
 * Delete one tree without ever following a link.
 *
 * A probe home contains pnpm links (symlinks on POSIX, junctions on Windows) to
 * the package under test — and to every local plugin the profile already links.
 * `fs.rmSync(recursive)` under Electron walks *through* a junction and deletes
 * the linked package's own files, so this walker removes each link itself and
 * only descends into real directories. The regression is reproduced by
 * `tests/junction-safety.mjs` under Electron.
 * @param target - absolute path inside the probe home.
 */
function removeTreeSafe(target) {
  let info
  try {
    info = lstatSync(target)
  } catch {
    return
  }
  if (info.isSymbolicLink()) {
    // A directory junction needs rmdir; a file symlink needs unlink.
    try {
      unlinkSync(target)
    } catch {
      try {
        rmdirSync(target)
      } catch {
        // Already gone or locked by the killed child; the caller retries.
      }
    }
    return
  }
  if (info.isDirectory()) {
    let names = []
    try {
      names = readdirSync(target)
    } catch {
      names = []
    }
    for (const name of names) removeTreeSafe(path.join(target, name))
    try {
      rmdirSync(target)
    } catch {
      // Locked; the caller retries.
    }
    return
  }
  try {
    unlinkSync(target)
  } catch {
    // Locked; the caller retries.
  }
}

/**
 * Remove a probe home safely, tolerating the transient lock a killed child
 * leaves on Windows.
 * @returns whether the directory is gone.
 */
export async function removeProbeHome(dir) {
  // Credentials are the only sensitive file the launcher writes here; remove
  // them first so a locked subdirectory cannot keep them on disk.
  for (const name of ['.credentials.yaml']) {
    try {
      unlinkSync(path.join(dir, name))
    } catch {
      // absent or locked
    }
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (!existsSync(dir)) return true
      removeTreeSafe(dir)
      if (!existsSync(dir)) return true
    } catch {
      // fall through to the retry delay
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return !existsSync(dir)
}

/** Remove probe homes left behind by a process that died mid-run. */
async function pruneStale(root, maxAgeMs = 30 * 60 * 1000) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let pruned = 0
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    try {
      if (now - statSync(full).mtimeMs > maxAgeMs) {
        if (await removeProbeHome(full)) pruned += 1
      }
    } catch {
      continue
    }
  }
  return pruned
}

/**
 * Extract the row names a boot reported as not activated.
 *
 * A real failure prints the activation summary, then one row line (row id, the
 * module URL or the id again, and the failure) followed by a stack frame. A
 * healthy plugin can print text shaped like that summary, so the parse also
 * requires a stack frame and, when the caller knows them, a row name that comes
 * from the candidate itself.
 * @param stderr - captured stderr.
 * @param expected - row ids and package name the candidate declares.
 */
function skippedRowsOf(stderr, expected) {
  if (typeof stderr !== 'string') return []
  if (!stderr.includes('did not activate')) return []
  if (!/^    at /m.test(stderr)) return []
  const allowed = expected instanceof Set && expected.size > 0 ? expected : null
  const names = []
  const rowPattern = /^(\S+) \(([^)]+)\): /gm
  let match
  while ((match = rowPattern.exec(stderr)) !== null) {
    const name = match[1]
    if (allowed !== null && !allowed.has(name)) continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Boot-probe one candidate.
 * @param target - `{ dir }` for a local package, or `{ spec }` for an install spec.
 * @param options - launcher, deadlines, and an optional progress callback.
 * @returns the probe result: status, exit code, URL, outputs, steps and timings.
 */
export async function runBootProbe(target, options = {}) {
  const launcher = options.launcher ?? createLauncher()
  const bootTimeoutMs = options.bootTimeoutMs ?? 90_000
  const installTimeoutMs = options.installTimeoutMs ?? 240_000
  const createTimeoutMs = options.createTimeoutMs ?? 60_000
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}

  const result = {
    status: 'unavailable',
    exitCode: null,
    url: null,
    stdout: '',
    stderr: '',
    skippedRows: [],
    steps: [],
    profile: null,
    home: null,
    port: null,
    elapsedMs: 0,
    cleanupOk: true,
    reason: undefined,
  }
  if (launcher.ok !== true) {
    result.reason = launcher.reason
    return result
  }

  const started = Date.now()
  const home = path.join(PROBE_ROOT, `home-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const profile = `guard-probe-${Math.random().toString(36).slice(2, 8)}`
  result.home = home

  try {
    mkdirSync(home, { recursive: true })
    await pruneStale(PROBE_ROOT)

    onLog('创建隔离 profile')
    const created = await runCommand(launcher, [profile, '--from-default-profile', 'web', '--dump-config'], home, createTimeoutMs)
    result.steps.push({ name: 'create-profile', status: created.status, code: created.code, elapsedMs: created.ms })
    if (created.status !== 'exit' || created.code !== 0) {
      result.status = 'unavailable'
      result.reason = `无法创建探针 profile：${tail(created.stderr || created.stdout, 800)}`
      result.stderr = tail(created.stderr)
      return result
    }

    onLog(`安装候选：${target.spec}`)
    const installed = await runCommand(launcher, ['plugin', '--profile', profile, 'add', target.spec], home, installTimeoutMs)
    result.steps.push({ name: 'install', status: installed.status, code: installed.code, elapsedMs: installed.ms })
    if (installed.status !== 'exit' || installed.code !== 0) {
      result.status = 'install-failed'
      result.steps[result.steps.length - 1].detail = tail((installed.stderr || installed.stdout).trim(), 1200)
      result.stderr = tail(installed.stderr)
      result.stdout = tail(installed.stdout)
      return result
    }

    const port = await freePort()
    result.port = port
    onLog(`真实启动预演（端口 ${port}）`)
    const boot = await runBoot(launcher, home, profile, bootTimeoutMs, port)
    result.steps.push({ name: 'boot', status: boot.status, code: boot.code, elapsedMs: boot.ms })
    result.status = boot.status
    result.exitCode = boot.code
    result.url = boot.url
    result.stdout = boot.stdout
    result.stderr = boot.stderr
    const expected = new Set()
    if (typeof target.name === 'string' && target.name !== '') expected.add(target.name)
    for (const row of options.expectedRows ?? []) expected.add(row)
    result.skippedRows = skippedRowsOf(boot.stderr, expected)
    return result
  } catch (error) {
    result.status = 'unavailable'
    result.reason = String(error?.message ?? error)
    return result
  } finally {
    result.elapsedMs = Date.now() - started
    result.cleanupOk = await removeProbeHome(home)
  }
}
