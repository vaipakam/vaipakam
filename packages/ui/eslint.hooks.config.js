/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why a LIBRARY package needs its own guard (#1521)
 * -------------------------------------------------
 * `packages/ui` is not deployed on its own, and I first used that as
 * the reason to leave it unguarded. That was the wrong test. These
 * components are compiled INTO deployable surfaces — `apps/app`
 * imports them from eleven files — so a conditional hook here crashes
 * a real page.
 *
 * The per-app guards cannot cover it: each runs `eslint .` from its own
 * directory and does not follow imports across the workspace boundary.
 * Without this file, a conditional hook in a shared component leaves
 * every app's CI green and still breaks the app at runtime.
 *
 * The rule of thumb is "does this code reach a deployed surface", not
 * "is this package deployed".
 *
 * Since #1609 the guard itself is declared ONCE in
 * `@vaipakam/eslint-config/hooks`; only the reason above is local.
 *
 * When this package gets a full config, fold the rule into it and
 * delete the file.
 */
import hooksGuard from '@vaipakam/eslint-config/hooks'

export default hooksGuard()
