/**
 * Filesystem helpers shared by the probe and the upgrade rehearsal.
 *
 * The important rule here: never let `fs.rmSync(recursive)` walk a tree that
 * contains links. Under Electron, removing a probe home that links the package
 * under test deletes that package's own files, so every removal goes through
 * `removeTreeSafe`, which unlinks links instead of descending into them.
 *
 * @module plugin-guard/lib/fs-safe
 */

import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'

/**
 * Delete one tree without ever following a link.
 * @param target - absolute path inside a tree this process owns.
 */
export function removeTreeSafe(target) {
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
        // Already gone or locked; the caller retries.
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
 * Remove one tree safely, retrying the transient lock a killed child leaves on
 * Windows and deleting credentials first so a locked directory cannot keep them.
 * @param dir - absolute directory this process owns.
 * @returns whether the directory is gone.
 */
export async function removeProbeHome(dir) {
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
