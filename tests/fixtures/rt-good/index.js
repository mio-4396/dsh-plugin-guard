export const name = 'rt-good'

export function apply(ctx) {
  ctx.effect(() => () => {}, 'rt-good: noop')
}
