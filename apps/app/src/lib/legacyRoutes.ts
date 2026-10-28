/**
 * Destinations for the retired app's routes that have no page of the same
 * name here (#2076).
 *
 * The retired `defi.vaipakam.com` router was enumerated, and every path it
 * served is either routed in `App.tsx`, aliased there, or mapped below.
 * Converting the old host into a path-preserving redirect is only honest
 * about "bookmarks keep working" if each of those paths lands somewhere
 * that does what the bookmark was for.
 *
 * Pure: no router, no React, so each mapping is tested on its own. The
 * route elements in `App.tsx` only read the URL and call these.
 *
 * One retired path is deliberately NOT here: `/buy-vpfi`. The fixed-rate
 * VPFI purchase surface was removed in the #687-A legal-surface excision,
 * so there is no destination and the not-found page is the correct answer.
 */

/** The old loan sub-pages became cards on the position page. Each maps to
 *  the CHOOSER that lists the action, never to the action's own card: the
 *  exit pages each hosted several routes, and refinance's own card renders
 *  only in Advanced mode and only while the loan can take a request, so an
 *  anchor on it would land a Basic-mode borrower nowhere (Codex #3004 r2).
 *  The borrower's chooser renders in both modes and its refinance row says
 *  whether refinancing is open now, why not, and offers the switch to
 *  Advanced, so the bookmark always lands on an account of the action. */
export const LEGACY_LOAN_SUBPAGE_ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  'early-withdrawal': 'lender-exit-options',
  preclose: 'early-repay-options',
  refinance: 'early-repay-options',
});

/** `/loans/:loanId/:subpage` → the position, at the named card when the
 *  sub-page is one the retired app had. An unknown sub-page still lands on
 *  the position rather than a not-found: the loan id is the part of the
 *  bookmark that identifies what the visitor was looking at. */
export function legacyLoanTarget(loanId: string, subpage?: string): string {
  const key = subpage?.toLowerCase();
  // Own keys only: `constructor` must not read through to the prototype.
  const anchor =
    key !== undefined && Object.hasOwn(LEGACY_LOAN_SUBPAGE_ANCHORS, key)
      ? LEGACY_LOAN_SUBPAGE_ANCHORS[key]
      : undefined;
  return `/positions/${loanId}${anchor ? `#${anchor}` : ''}`;
}

/** The retired settings pages, now cards on `/settings`, by the card's
 *  anchor. `/settings` honours these anchors even in Basic mode, so a
 *  bookmark to the allowances page still reaches the revoke button. */
export const LEGACY_SETTINGS_ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  alerts: 'alerts',
  allowances: 'approvals',
  keepers: 'keepers',
});

/** The `/settings` anchors whose cards are Advanced-only in normal use but
 *  render whenever the URL asks for them by name. */
export const SETTINGS_ANCHORED_ADVANCED_CARDS = Object.freeze(['approvals', 'keepers'] as const);

/**
 * `/create-offer?…` → where that job lives now.
 *
 * The retired app had one create form with a side toggle, reached three
 * ways, and its query string says which:
 * - `from=refinance` or `from=offset` with a `loanId` came from a loan's
 *   refinance or offset flow, which now live on that position (the offset
 *   among the borrower's early-repay options);
 * - a side (`side` from the market widget, `offerType` from the loan
 *   flows) names the lend or borrow form;
 * - anything else is the bare create page, whose choice of side is now the
 *   home page's question.
 *
 * The prefill values the old form read (assets, amounts, rate) are NOT
 * carried: the new forms take none of them from the URL, and a half-filled
 * form that silently dropped the rest would be worse than an empty one.
 */
export function legacyCreateOfferTarget(search: string): string {
  const q = new URLSearchParams(search);
  const from = q.get('from');
  const loanId = q.get('loanId');
  if ((from === 'refinance' || from === 'offset') && loanId !== null && /^\d+$/.test(loanId)) {
    return legacyLoanTarget(loanId, from === 'refinance' ? 'refinance' : 'preclose');
  }
  const side = q.get('side') ?? q.get('offerType');
  if (side === 'lender') return '/lend';
  if (side === 'borrower') return '/borrow';
  return '/';
}

/** A positive decimal offer id, or `undefined` for anything else. */
export function parseLegacyOfferId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}
