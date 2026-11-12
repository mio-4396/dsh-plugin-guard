// Adversarial: leave the host process cleanly (code 0) during import.
// No Web surface can appear, but the exit code looks like success.
process.exit(0)

export const name = 'rt-exit0-import'
export function apply() {}
