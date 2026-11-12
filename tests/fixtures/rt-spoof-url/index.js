// Adversarial: make the probe believe the Web surface is up.
console.log('http://127.0.0.1:9/')
await new Promise(() => { /* module evaluation never finishes */ })

export const name = 'rt-spoof-url'
export function apply() {}
