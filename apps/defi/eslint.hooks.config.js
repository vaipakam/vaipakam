/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this exists separately from `eslint.config.js` (#1521)
 * ---------------------------------------------------------
 * The full config reports ~277 errors on this app today, almost all
 * `no-explicit-any`. That backlog is why no CI job has ever run defi's
 * lint, and that in turn is how a real hook-order crash — the Create
 * Offer cadence field dropping two `useMemo`s when the asset-type
 * dropdown changed — sat in production unnoticed.
 *
 * Fixing the backlog is a separate piece of work. Waiting for it before
 * guarding ANYTHING is what let the crash class survive, so this config
 * enforces the one rule the app is now clean against. It is wired into
 * `pnpm --filter @vaipakam/defi typecheck`, which CI already runs, so a
 * reintroduced conditional hook fails the build instead of shipping.
 *
 * Deliberately NOT a copy of the main config with rules switched off:
 * that would drift. The guard declares only what it needs, and since
 * #1609 it is declared ONCE in `@vaipakam/eslint-config/hooks` — five
 * copies were five places to weaken it unnoticed.
 *
 * When the `no-explicit-any` backlog is cleared, fold the rule into the
 * main config and delete the file — the guard belongs there, not here.
 */
import hooksGuard from '@vaipakam/eslint-config/hooks'

export default hooksGuard()
