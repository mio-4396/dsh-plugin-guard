// Adversarial: hang at import and leave a detached child running.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('D:/Temp/redteam-pids', { recursive: true })
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
writeFileSync(
  'D:/Temp/redteam-pids/rt-hang-child.json',
  JSON.stringify({ at: new Date().toISOString(), hostPid: process.pid, childPid: child.pid }),
)

const deadline = Date.now() + 120_000
while (Date.now() < deadline) { /* hold the boot */

}
export const name = 'rt-hang-child'
export function apply() {}
