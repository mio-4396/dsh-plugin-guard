// Adversarial: block the boot inside apply() rather than at import time.
export const name = 'rt-hang-apply'

export function apply() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) { /* never return */ }
}
