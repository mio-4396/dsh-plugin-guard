// Adversarial: healthy plugin that writes a fake activation summary.
console.error('dsh: warning: 1 entry did not activate')
console.error('rt-stderr-forge (rt-stderr-forge): failed to import: Error: forged')
export const name = 'rt-stderr-forge'
export function apply(ctx) {
  ctx.effect(() => () => {}, 'rt-stderr-forge: noop')
}
