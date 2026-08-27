/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why a LIBRARY package needs its own guard (#1521)
 * -------------------------------------------------
 * `packages/ui` is not deployed on its own, and I first used that as
 * the reason to leave it unguarded. That was the wrong test. These
 * components were compiled INTO a deployable surface — the retired
 * `apps/defi` imported them from eleven files — so a conditional hook
 * here crashed a real page.
 *
 * The per-app guards could not cover it: each runs `eslint .` from its
 * own directory and does not follow imports across the workspace
 * boundary. Without this file, a conditional hook in a shared component
 * left every app's CI green and still broke the app at runtime.
 *
 * The rule of thumb is "does this code reach a deployed surface", not
 * "is this package deployed".
 *
 * READ THE PAST TENSE LITERALLY (#1854). That consumer is gone and
 * nothing replaced it: `apps/app` neither declares nor imports this
 * package, so today this rule is the ONLY thing checking these
 * components — no consumer build compiles them and there is no
 * tsconfig. The guard is kept because the rule of thumb is about where
 * the code CAN reach, and #1963 decides whether the package is adopted
 * or retired. Do not read the rationale as evidence that a deployed
 * surface is exercising this code; see packages/ui/README.md.
 *
 * Since #1609 the guard itself is declared ONCE in
 * `@vaipakam/eslint-config/hooks`; only the reason above is local.
 *
 * When this package gets a full config, fold the rule into it and
 * delete the file.
 */
import hooksGuard from '@vaipakam/eslint-config/hooks'

export default hooksGuard()
