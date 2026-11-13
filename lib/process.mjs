/**
 * Child-process helpers shared by the probe and the upgrade rehearsal.
 *
 * @module plugin-guard/lib/process
 */

import { spawn } from 'node:child_process'

const TAIL_BYTES = 16 * 1024
const CAPTURE_LIMIT = 64 * 1024

/** Keep the last `limit` characters of one captured stream. */
export function tail(text, limit = TAIL_BYTES) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** Append to a capture, keeping memory bounded. */
export function append(capture, chunk) {
  capture.text += chunk
  if (capture.text.length > CAPTURE_LIMIT) capture.text = capture.text.slice(-CAPTURE_LIMIT)
}

/**
 * Environment for a child launcher: run as Node, isolated DSH home, no inherited
 * profile identity.
 * @param home - DSH_HOME for the child.
 * @param overrides - extra variables for this call.
 */
export function childEnv(home, overrides = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, ...overrides }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
    if (!Object.hasOwn(overrides, key)) delete env[key]
  }
  return env
}

/** Kill a process and its descendants (Windows) or the process itself elsewhere. */
export function killTree(pid) {
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
 * @param launcher - `{ exe, cliJs? }`; `cliJs` is the script Electron runs, and a
 *   call that supplies its own script (such as pnpm) omits it.
 * @param args - arguments after `--expose-internals [cliJs]`.
 * @param options - home, deadline, working directory and environment overrides.
 * @returns status `exit` with a code, or `timeout` once the deadline passed.
 */
export function runCommand(launcher, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const entry = launcher.cliJs === undefined || launcher.cliJs === null ? [] : [launcher.cliJs]
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(launcher.exe, ['--expose-internals', ...entry, ...args], {
        cwd: options.cwd,
        env: childEnv(options.home, options.env),
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
      resolve({ status: 'error', code: null, stdout: tail(out.text), stderr: String(error?.message ?? error), ms: Date.now() - started })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: 'exit', code, stdout: tail(out.text), stderr: tail(err.text), ms: Date.now() - started })
    })
  })
}
