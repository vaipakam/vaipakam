/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this app has no other ESLint config (#1521)
 * -----------------------------------------------
 * `apps/alpha` is a deployable Worker (`vaipakam-alpha`) that renders
 * React, and it carried NO lint configuration and no CI typecheck at
 * all. It was missed by the first pass of the #1521 sweep, which
 * checked the apps it happened to be working in rather than
 * enumerating `apps/*` — review caught the omission.
 *
 * The app is currently clean of this rule; the guard exists so it
 * stays that way. It is wired into `pnpm --filter @vaipakam/alpha
 * typecheck`, which CI now runs. Since #1609 the guard itself is
 * declared ONCE in `@vaipakam/eslint-config/hooks`.
 *
 * When this app gets a full config, fold the rule into it and delete
 * the file — the guard belongs there, not here.
 */
import hooksGuard from '@vaipakam/eslint-config/hooks'

// `scripts/**` are Node build scripts, not React code — nothing in them
// can violate the rules of hooks. They are ignored so their `no-console`
// disable comments don't surface as unused-directive warnings from a
// guard that deliberately enables no such rule.
export default hooksGuard({ extraIgnores: ['scripts/**'] })
