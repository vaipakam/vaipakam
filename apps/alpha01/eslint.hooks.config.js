/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this is separate from the app's own `eslint.config.js` (#1521)
 * -----------------------------------------------------------------
 * `apps/alpha01` HAS a full config with the react-hooks plugin, but
 * its `typecheck` script never ran it and CI never typechecked the
 * app at all — so the config was decorative. Wiring `eslint .` in
 * wholesale would fail on a real backlog of react-hooks v7 findings
 * (`set-state-in-effect`, `preserve-manual-memoization`) unrelated to
 * hook ORDER.
 *
 * This enforces the one rule the app is already clean against, so the
 * v7 backlog can be worked separately without leaving hook order
 * unguarded in the meantime. Since #1609 the guard itself is declared
 * ONCE in `@vaipakam/eslint-config/hooks`.
 *
 * When the v7 backlog is cleared, run the full `eslint .` in
 * `typecheck` and delete this file.
 */
import hooksGuard from '@vaipakam/eslint-config/hooks'

// `scripts/**` are Node build scripts, not React code — nothing in them
// can violate the rules of hooks. They are ignored so their `no-console`
// disable comments don't surface as unused-directive warnings from a
// guard that deliberately enables no such rule.
export default hooksGuard({ extraIgnores: ['scripts/**'] })
