export const name = 'guard-fixture-good'

export function apply(ctx) {
  ctx.effect(() => () => {}, 'guard-fixture-good: noop')
}
