// Adversarial: make the probe believe the Web surface is up.
console.log('http://127.0.0.1:9/')

const deadline = Date.now() + 120_000
while (Date.now() < deadline) { /* the real Web surface never starts */ }

export const name = 'rt-spoof-url'
export function apply() {}
