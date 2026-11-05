/**
 * The copy catalog. English lives here as the single source of truth and
 * reaches i18next as per-key default values; locale bundles override per
 * key. Every entry is declared through a tier helper (RB-TIERS), which is
 * how `scripts/check-word-budget.mjs` finds the inline tier-B sentences it
 * budgets and the help panel finds the tier-C explanation for a key.
 */
import { A, B, C } from '../shared/copy/tiers';

export const copy = {
  shell: {
    brand: B('Vaipakam'),
    modeBasic: B('Basic'),
    modeAdvanced: B('Advanced'),
    modeWhy: C(
      'Basic shows the capabilities most people need. Advanced adds the exit and settlement tools, automation, signed orders, keeper posture and accounting detail. Switching modes never hides a consent, a blocker or a remedy.',
      'advanced-mode',
    ),
    underConstruction: A(
      'This is the next version of the Vaipakam app, being built page by page. Nothing here signs or sends anything yet. Your positions, claims and vault are untouched and are served by the current app.',
    ),
  },
  notBuilt: {
    a: A('This page is not built yet in the new app. Nothing you own is affected; the current app still serves it.'),
    b: B('Use the current app for this job until this page ships.'),
  },
  capability: {
    reading: B('Checking what this deployment supports.'),
    unreadable: A(
      'The routed functions of the protocol contract could not be read, so this build cannot tell which actions the deployment supports. No signing step is offered until it can.',
    ),
    why: C(
      'The app binds to one protocol contract per chain and reads the list of functions it routes before offering any action. After an upgrade that list changes; reading it, rather than assuming it, is what lets the app name what changed instead of failing on a missing function.',
      'deployments',
    ),
  },
} as const;
