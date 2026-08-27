import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Lint for apps/app (#1516). Scoped DELIBERATELY to correctness
// rules a type-checker cannot see, not to style.
//
// The motivating defect: #1511 shipped a `useCallback` below the page's
// loading/not-found early returns, so the hook was skipped on the first
// render and called on the second — "Rendered more hooks than during the
// previous render", a hard crash on every load of the position page. It
// survived fourteen review rounds, `tsc -b --noEmit`, the production
// build and a green preview deploy, because none of those can see it.
// `react-hooks/rules-of-hooks` catches it in under a second.
//
// A full style ruleset over an existing codebase is a separate, noisier
// change; keeping this narrow is what lets it be enforcing from day one
// instead of advisory forever.

/** Every rule name a shared config turns on, flattened — the config
 *  presets are arrays in some cases and single objects in others. */
const rulesOf = (preset) =>
  (Array.isArray(preset) ? preset : [preset]).flatMap((c) =>
    Object.keys(c?.rules ?? {}),
  )

/** Rules this config INTENDS to block on. Anything not named here is
 *  advisory, and the derivation below guarantees that rather than
 *  trusting the presets' own severities.
 *
 *  Two review rounds were spent discovering that "extends a recommended
 *  preset, override a few rules" does not achieve it: the first draft
 *  left nine react-hooks v7 rules erroring, and the second still left
 *  19 blockers inherited from `tseslint.configs.recommended`
 *  (`prefer-const`, `no-var`, `no-namespace`, `no-require-imports`, …).
 *  Every preset is now flattened to advisory FIRST and these are
 *  re-asserted after, so a preset gaining a rule can never quietly
 *  start failing `typecheck`. Verify with:
 *
 *    npx eslint --print-config src/main.tsx
 *
 *  which should report exactly these at error severity. */
const BLOCKING_CORE = {
  // "This code cannot be doing what its author meant" — bug rules, not
  // taste. Each is cheap, unambiguous, and already clean.
  'no-cond-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unreachable': 'error',
}

/** Kept separate because a rule may only be configured in a block that
 *  loads its plugin — the hooks rule belongs to the second block. */
const BLOCKING_HOOKS = {
  // The rule this config exists for. Clean at zero violations, so it
  // enforces from day one instead of becoming a backlog nobody pays.
  'react-hooks/rules-of-hooks': 'error',
  // Promoted on reaching zero (#1520). Five of the six sites it found were
  // deliberate reads whose writes always commit state in the same pass —
  // they carry a disable naming why converting them to state would be a
  // REGRESSION — and the sixth, a ref written during render, was fixed.
  // Erroring now keeps that judgement from being re-litigated by drift.
  'react-hooks/refs': 'error',
  // Promoted on reaching zero (#1520). The four sites were two root causes,
  // both of them a value that could not be declared as the dependency it
  // already was: an array rebuilt every render behind a `?? []`, and a reset
  // helper that was a fresh function each pass. Both are now stable, so the
  // dependency each effect really has is written down.
  'react-hooks/exhaustive-deps': 'error',
  // Promoted on reaching zero (#1520), and the last of the four. Unlike the
  // others, NONE of its nine sites was a defect: three close a page-owned
  // confirm slot when a refetch invalidated the open review, two reload
  // local state on an identity change a `key` cannot express, one seeds a
  // field the user owns immediately after, one persists a read-cursor to
  // localStorage, and one resolves a deep link. Each carries a disable
  // naming which of those it is. The ninth is `Rent`'s consent clear, whose
  // suppression is meant to be temporary — #1696 decides whether it becomes
  // a render-phase clear, and it is the ONLY one that should ever come back.
  // Erroring is what makes that distinction hold: a new violation is now a
  // deliberate, argued exception rather than one more warning in a list.
  'react-hooks/set-state-in-effect': 'error',
  // Promoted on reaching zero (#1520). All nine sites were `Date.now()`
  // read during render, which froze every value derived from it until an
  // unrelated re-render; they now read a ticking clock through state
  // (`hooks/useNowSec`). The one remaining call is in a submit handler the
  // rule cannot recognise as one, and carries a disable saying so.
  'react-hooks/purity': 'error',
}

export default defineConfig([
  globalIgnores(['dist', 'node_modules', '.wrangler', 'playwright-report']),
  {
    // Promoted on reaching zero (#1520), same rule as every entry in
    // BLOCKING_HOOKS above. ESLint 9 defaults this to `warn`; at that
    // severity nothing holds the count down.
    //
    // It matters here specifically BECAUSE of the promotions above.
    // Driving those five rules to zero left ~15 deliberate
    // `eslint-disable-next-line` comments in `src/`, each one an argued
    // exception with a reason written beside it. That is the intended
    // end state, not debt — but it means the suppression surface is now
    // large enough that a stale entry is easy to miss.
    //
    // The failure mode is a disable that outlives the violation it was
    // written for: the code gets refactored, the rule stops firing, the
    // comment stays. It is silent and harmless right up until the same
    // file regresses, at which point the leftover comment suppresses the
    // NEW violation and the rule that was promoted to catch it never
    // fires. A stale suppression is a pre-authorised future bug.
    //
    // Note this is not what catches a MISPLACED disable — one attached
    // to the wrong line leaves the real violation unsuppressed, so the
    // promoted rule errors on its own. This is strictly about
    // suppressions that have outlived their cause.
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Style and typing opinions from the base presets go OFF, not
      // warn: they are not what this config is for, and a few hundred
      // advisory hits would bury the signal it was added to surface.
      ...Object.fromEntries(
        [
          ...rulesOf(js.configs.recommended),
          ...rulesOf(tseslint.configs.recommended),
        ].map((rule) => [rule, 'off']),
      ),
      ...BLOCKING_CORE,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // The hooks preset's other rules DO stay visible as warnings —
      // unlike the style presets these are genuine correctness signals
      // (work done in the wrong render phase, refs read during render).
      // The existing surface has never been held to them, so the sweep
      // is tracked separately in #1520 rather than bolted onto a
      // plumbing change or used as an excuse to make everything
      // advisory.
      ...Object.fromEntries(
        rulesOf(reactHooks.configs.flat.recommended).map((rule) => [
          rule,
          'warn',
        ]),
      ),
      ...BLOCKING_HOOKS,
    },
  },
])
