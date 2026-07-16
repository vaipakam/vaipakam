/**
 * RPC read-diet PR D — the client scoping rule, pinned. The only unsafe
 * failure is SUPPRESSING a needed refetch, so every ambiguous input
 * (absent/truncated/malformed hints, unknown wallet or id sets) must
 * return the roots unchanged; narrowing happens only on a provably
 * complete, provably irrelevant frame.
 */
import { describe, expect, it } from 'vitest';
import { OWN_SCOPED_ROOTS, scopeInvalidationRoots } from './pushHintScope';

const ROOTS = ['myLoans', 'claimables', 'vaultAssets', 'deskTape', 'activity'];
const CTX = {
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  myLoanIds: new Set([16]),
  myOfferIds: new Set([9]),
};
const clean = { loanIds: [99], offerIds: [], links: [], truncated: false };

describe('scopeInvalidationRoots', () => {
  it('narrows a complete, irrelevant frame to the shared roots only', () => {
    const out = scopeInvalidationRoots({ roots: ROOTS, hints: clean, ...CTX });
    expect(out).toEqual(['deskTape', 'activity']);
    expect(out.every((r) => !OWN_SCOPED_ROOTS.has(r))).toBe(true);
  });

  it('scopes the notification feed out of an irrelevant frame but keeps it when relevant (#1213)', () => {
    // The bell's `notifications` root is per-wallet; a foreign loan frame
    // never adds a row for this wallet, so it must be dropped when
    // irrelevant and refetched when the wallet is a party (Codex #1295 r2).
    expect(OWN_SCOPED_ROOTS.has('notifications')).toBe(true);
    const roots = ['myLoans', 'notifications', 'deskTape'];
    expect(scopeInvalidationRoots({ roots, hints: clean, ...CTX })).toEqual(['deskTape']);
    expect(
      scopeInvalidationRoots({ roots, hints: { ...clean, loanIds: [16] }, ...CTX }),
    ).toEqual(roots);
  });

  it('keeps everything when the frame is relevant (id / causative offer / party)', () => {
    for (const hints of [
      { ...clean, loanIds: [16] },
      { ...clean, offerIds: [9] },
      { ...clean, links: [{ loanId: 99, offerId: 9 }] },
      { ...clean, links: [{ loanId: 99, lender: CTX.address.toUpperCase() }] },
      { ...clean, links: [{ loanId: 99, borrower: CTX.address }] },
    ]) {
      expect(scopeInvalidationRoots({ roots: ROOTS, hints, ...CTX })).toEqual(ROOTS);
    }
  });

  it('never narrows on any ambiguous input', () => {
    const cases = [
      { hints: undefined },
      { hints: { ...clean, truncated: true } },
      { hints: { ...clean, truncated: undefined } },
      { hints: { ...clean, loanIds: ['16'] } }, // malformed ids
      { hints: { ...clean, links: [null] } }, // malformed link ⇒ relevant
      { address: null },
      { myLoanIds: null },
      { myOfferIds: null },
    ];
    for (const over of cases) {
      expect(
        scopeInvalidationRoots({ roots: ROOTS, hints: clean, ...CTX, ...over }),
      ).toEqual(ROOTS);
    }
  });
});
