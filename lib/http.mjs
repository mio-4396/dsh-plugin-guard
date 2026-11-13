/**
 * Readiness proof for a DSH Web surface.
 *
 * A plugin can print a URL and even answer HTTP on it, so reachability alone is
 * not proof. The real surface answers the token URL with an auth redirect that
 * sets a cookie, and the page it then serves carries the marker only `dsh web`
 * injects.
 *
 * @module plugin-guard/lib/http
 */

import { request } from 'node:http'
import { createServer } from 'node:net'

/** Only the real app shell carries this marker: `dsh web` injects it. */
export const BOOT_MARKER = '__DSH_BOOT__'

/** One HTTP GET, returning status, headers and body without following redirects. */
export function fetchOnce(url, timeoutMs, cookie) {
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
 * Whether a URL is the real DSH Web surface.
 * @param url - candidate URL from a launcher's stdout.
 * @param timeoutMs - per-request deadline.
 * @returns whether the DSH app shell answered.
 */
export async function servesDsh(url, timeoutMs = 5000) {
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
export function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(0))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}
