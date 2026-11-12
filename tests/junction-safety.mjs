/**
 * Regression: probe cleanup must never delete the package under test.
 *
 * A probe home contains a pnpm junction to the candidate directory. Under
 * Electron's Node, `fs.rmSync(recursive)` walks through that junction and empties
 * the candidate's own files; the guard therefore removes trees with its own
 * link-aware walker. This test reproduces both runtimes and asserts the source
 * survives.
 *
 * Run from the package root: `node tests/junction-safety.mjs`.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const probeModule = pathToFileURL(path.join(here, '..', 'lib', 'probe.mjs')).href

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

const electron = process.env.DSH_GUARD_LAUNCHER_EXE ?? 'D:\\DeepSeek Harness\\DeepSeek Harness.exe'

function layout(root) {
  const src = path.join(root, 'src')
  const home = path.join(root, 'home')
  mkdirSync(src, { recursive: true })
  for (const name of ['a.js', 'b.js', 'c.js', 'package.json']) writeFileSync(path.join(src, name), 'export const x = 1\n')
  mkdirSync(path.join(home, 'profiles', 'probe', 'node_modules'), { recursive: true })
  symlinkSync(src, path.join(home, 'profiles', 'probe', 'node_modules', 'pkg'), 'junction')
  return { src, home }
}

const root = mkdtempSync(path.join(os.tmpdir(), 'guard-junction-'))
const { src, home } = layout(root)
const harness = path.join(root, 'harness.mjs')
writeFileSync(harness, `import { removeProbeHome } from ${JSON.stringify(probeModule)}
const ok = await removeProbeHome(process.argv[2])
console.log(JSON.stringify({ ok }))
`)

// Plain Node: the walker must behave exactly like before.
const plain = await new Promise((resolve) => {
  const child = spawn(process.execPath, [harness, home], { windowsHide: true })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.on('close', (code) => resolve({ code, out }))
})
check('plain node: cleanup exits 0', plain.code === 0, plain.out)
check('plain node: source survives cleanup', readdirSync(src).length === 4, String(readdirSync(src).length))
check('plain node: probe home removed', !existsSync(home))

// Electron: the runtime the guard actually runs in inside DSH.
if (!existsSync(electron)) {
  console.log('SKIP electron check: launcher not found')
} else {
  const second = mkdtempSync(path.join(os.tmpdir(), 'guard-junction-e-'))
  const { src: src2, home: home2 } = layout(second)
  const run = await new Promise((resolve) => {
    const child = spawn(electron, [harness, home2], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => resolve({ code, out, err }))
  })
  check('electron: cleanup exits 0', run.code === 0, `${run.out} ${run.err}`)
  check('electron: source survives cleanup', readdirSync(src2).length === 4, `${readdirSync(src2).length} files left`)
  check('electron: probe home removed', !existsSync(home2))
  check('electron: cleanup reported ok', run.out.includes('"ok":true'), run.out)
  rmSync(second, { recursive: true, force: true })
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
