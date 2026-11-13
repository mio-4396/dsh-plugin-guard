/**
 * Read an Electron `app.asar` archive without Electron.
 *
 * The upgrade rehearsal needs two facts before it boots anything: which DSH
 * version a runtime carries, and where its CLI entry lives inside the archive.
 * Both are plain reads of the archive header and one entry, so a candidate
 * runtime can be inspected without installing or launching it.
 *
 * @module plugin-guard/lib/asar
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const HEADER_MARKER = Buffer.from('{"files":')

/**
 * Parse the header of one archive and return a small reader over its entries.
 * @param asarPath - absolute `app.asar` path.
 * @returns the reader, or null when the file is not an asar archive.
 */
export function openAsar(asarPath) {
  if (!existsSync(asarPath)) return null
  let bytes
  try {
    bytes = readFileSync(asarPath)
  } catch {
    return null
  }
  const start = bytes.indexOf(HEADER_MARKER)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 92) escaped = true
      else if (byte === 34) inString = false
      continue
    }
    if (byte === 34) inString = true
    else if (byte === 123) depth += 1
    else if (byte === 125) {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  if (end < 0) return null
  let header
  try {
    header = JSON.parse(bytes.toString('utf8', start, end))
  } catch {
    return null
  }
  // File data begins after the padded header, not necessarily right after the
  // JSON text: the pickle pads the header to a 4-byte boundary, and newer
  // archives (0.2.2-rc.3) actually use that padding. `8 + header size` is the
  // canonical offset; the brace end is only a fallback for malformed sizes.
  const declared = bytes.length >= 8 ? bytes.readUInt32LE(4) : 0
  const alignedBase = 8 + declared
  const base = Number.isFinite(alignedBase) && alignedBase >= end && alignedBase < bytes.length ? alignedBase : end
  const unpackedRoot = `${asarPath}.unpacked`

  function entryOf(name) {
    let node = header
    for (const segment of name.split('/')) {
      if (node === null || node === undefined || node.files === undefined) return null
      node = node.files[segment]
      if (node === undefined) return null
    }
    return node
  }

  /** Read one file; unpacked entries come from the sibling `.unpacked` tree. */
  function readFile(name) {
    const entry = entryOf(name)
    if (entry === null || entry.files !== undefined) return null
    if (entry.unpacked === true) {
      try {
        return readFileSync(path.join(unpackedRoot, name))
      } catch {
        return null
      }
    }
    const offset = Number(entry.offset)
    const size = Number(entry.size)
    if (!Number.isFinite(offset) || !Number.isFinite(size)) return null
    return bytes.subarray(base + offset, base + offset + size)
  }

  /** Every file path in the archive. */
  function list() {
    const files = []
    const walk = (node, prefix) => {
      for (const name of Object.keys(node.files ?? {})) {
        const child = node.files[name]
        const full = prefix === '' ? name : `${prefix}/${name}`
        if (child.files !== undefined) walk(child, full)
        else files.push(full)
      }
    }
    walk(header, '')
    return files
  }

  return { path: asarPath, bytes, header, base, readFile, list }
}

/** Parse a `package.json` entry out of an archive. */
export function readAsarManifest(asar, name) {
  const raw = asar.readFile(name)
  if (raw === null) return null
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}
