// Adversarial: die only when the loader calls apply().
export const name = 'rt-exit9-apply'

export function apply() {
  process.exit(9)
}
