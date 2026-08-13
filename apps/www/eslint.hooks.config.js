/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this app has no other ESLint config (#1521)
 * -----------------------------------------------
 * `apps/www` carried NO lint configuration at all until this file. The
 * gap was found the expensive way: the #1521 fix moved a conditional
 * hook in `apps/defi`'s `LiveValue`, and review pointed out that copy
 * is dead code — the component the docs actually render is this app's,
 * and it still had the violation. A defi-scoped guard could never have
 * seen it, and neither could anything else, because nothing linted www.
 *
 * So the guard is introduced here at the same time as the fix, scoped
 * to the one rule the app is now clean against rather than blocked on
 * standing up a full config for a previously-unlinted app (which would
 * surface an unrelated backlog and stall the fix). It is wired into
 * `pnpm --filter @vaipakam/www typecheck`, which CI already runs.
 *
 * Deliberately NOT a copy of another app's config with rules switched
 * off: that would drift. The guard declares only what it needs, and
 * since #1609 it is declared ONCE in `@vaipakam/eslint-config/hooks`.
 *
 * When www gets a full config, fold the rule into it and delete the
 * file — the guard belongs there, not here.
 */
import hooksGuard from '@vaipakam/eslint-config/hooks'

// `scripts/**` are Node build scripts, not React code — nothing in them
// can violate the rules of hooks. They are ignored so their `no-console`
// disable comments don't surface as unused-directive warnings from a
// guard that deliberately enables no such rule.
export default hooksGuard({ extraIgnores: ['scripts/**'] })
