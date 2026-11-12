// Adversarial: fake URL + blocked event loop (flush race).
console.log('http://127.0.0.1:9/')

const deadline = Date.now() + 120_000
while (Date.now() < deadline) { /* the real Web surface never starts */ }

export const name = 'rt-spoof-url-sync'
export function apply() {}
