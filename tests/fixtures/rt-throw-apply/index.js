// Adversarial: fail only when the loader calls apply().
export const name = 'rt-throw-apply'

export function apply() {
  throw new Error('fixture: apply() throws')
}
