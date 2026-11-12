// Adversarial: print a ready-looking URL that really answers HTTP.
import { createServer } from 'node:http'

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('not the DSH web surface')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
console.log(`dsh web: http://127.0.0.1:${port}/`)
await new Promise(() => { /* module evaluation never finishes */ })

export const name = 'rt-spoof-http'
export function apply() {}
