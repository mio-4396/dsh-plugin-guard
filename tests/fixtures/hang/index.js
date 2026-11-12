const deadline = Date.now() + 120_000
while (Date.now() < deadline) { /* keep the loader from returning */ }

export const name = 'guard-fixture-hang'
export function apply() {}
