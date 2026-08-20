import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import {
  buildLenderExitRows,
  hasJumpableRow,
  type LenderExitInput,
} from './lenderExitRows';

const o = copy.lenderExit.options;

/** A position with nothing blocking either sale path. */
const base: LenderExitInput = {
  periodicInterestCadence: 0,
  cadenceReadFailed: false,
  maturity: 'current',
  listingSupportedOnChain: true,
  listingFlowDisabled: false,
  saleTools: 'ready',
  collateralIsNft: false,
  allowsPartialRepay: false,
  saleListingCancellable: true,
  saleLock: 'clear',
  heldVpfiUnresolved: false,
  borrowerOffsetPending: false,
  instantSellCandidates: 'some',
};

const rowFor = (input: Partial<LenderExitInput>, key: string) =>
  buildLenderExitRows({ ...base, ...input }).find((r) => r.key === key)!;

describe('wait row — ordering and framing', () => {
  it('renders FIRST, because doing nothing is the default that costs no sale forfeiture', () => {
    expect(buildLenderExitRows(base)[0].key).toBe('wait');
  });

  it('never offers a jump — there is no tool behind waiting', () => {
    expect(rowFor({}, 'wait').target).toBeUndefined();
  });

  it('is never marked unavailable, on any input', () => {
    const hostile: LenderExitInput = {
      periodicInterestCadence: undefined,
      cadenceReadFailed: true,
      maturity: 'past',
      listingSupportedOnChain: false,
      listingFlowDisabled: true,
      saleTools: 'failed',
      collateralIsNft: true,
      allowsPartialRepay: true,
      saleListingCancellable: false,
      saleLock: 'listed',
      heldVpfiUnresolved: true,
      borrowerOffsetPending: true,
      instantSellCandidates: 'none',
    };
    expect(buildLenderExitRows(hostile)[0].unavailable).toBeUndefined();
  });
});

describe('wait row — cadence awareness (invariant 1)', () => {
  // The whole point: a periodic-schedule lender is paid DURING the
  // term, so the at-close sentence would misstate when they get paid.
  it('uses the periodic shape when the loan has a schedule', () => {
    expect(rowFor({ periodicInterestCadence: 2 }, 'wait').desc).toBe(
      o.waitDescPeriodic,
    );
  });

  it('uses the at-close shape only when the schedule is genuinely None', () => {
    expect(rowFor({ periodicInterestCadence: 0 }, 'wait').desc).toBe(
      o.waitDescAtClose,
    );
  });

  it('says it is still checking rather than DEFAULTING while the read is in flight', () => {
    const desc = rowFor({ periodicInterestCadence: undefined }, 'wait').desc;
    expect(desc).toBe(o.waitDescChecking);
    // Guard the actual regression: silently falling back to either
    // concrete shape would tell a lender something not yet known.
    expect(desc).not.toBe(o.waitDescAtClose);
    expect(desc).not.toBe(o.waitDescPeriodic);
  });

  it('treats every non-zero cadence as periodic, not just one', () => {
    for (const cadence of [1, 2, 3, 4]) {
      expect(rowFor({ periodicInterestCadence: cadence }, 'wait').desc).toBe(
        o.waitDescPeriodic,
      );
    }
  });
});

describe('past maturity outranks narrower reasons (invariant 2)', () => {
  it('flips BOTH sale rows to the past-due line', () => {
    const rows = buildLenderExitRows({ ...base, maturity: 'past' });
    expect(rows.find((r) => r.key === 'sell-now')!.unavailable).toBe(
      copy.lenderExit.pastDue,
    );
    expect(rows.find((r) => r.key === 'list')!.unavailable).toBe(
      copy.lenderExit.pastDue,
    );
  });

  it('does not report "no matching offers" past due — that would send the lender hunting for a fix that cannot help', () => {
    const row = rowFor(
      { maturity: 'past', instantSellCandidates: 'none' },
      'sell-now',
    );
    expect(row.unavailable).toBe(copy.lenderExit.pastDue);
    expect(row.unavailable).not.toBe(o.sellNowNoOffers);
  });

  it('does not report a listing blocker past due either', () => {
    const row = rowFor({ maturity: 'past', collateralIsNft: true }, 'list');
    expect(row.unavailable).toBe(copy.lenderExit.pastDue);
    expect(row.unavailable).not.toBe(o.listUnavailableNft);
  });
});

describe('sell-now availability — checking vs unknown must not collapse', () => {
  it('"none" is the only state that claims no matching offers', () => {
    expect(rowFor({ instantSellCandidates: 'none' }, 'sell-now').unavailable).toBe(
      o.sellNowNoOffers,
    );
  });

  it('"checking" says a read is in flight', () => {
    expect(
      rowFor({ instantSellCandidates: 'checking' }, 'sell-now').unavailable,
    ).toBe(copy.lenderExit.checking);
  });

  it('"unknown" leaves the row available and makes NO claim — we have not looked', () => {
    const row = rowFor({ instantSellCandidates: 'unknown' }, 'sell-now');
    expect(row.unavailable).toBeUndefined();
    // The regression this guards: rendering the checking line forever
    // in the case where nothing is actually being checked.
    expect(row.unavailable).not.toBe(copy.lenderExit.checking);
  });

  it('"some" leaves the row available', () => {
    expect(rowFor({ instantSellCandidates: 'some' }, 'sell-now').unavailable)
      .toBeUndefined();
  });
});

describe('list-row refusal precedence — most structural first', () => {
  it('already-listed leads, so a lender is not invited to do what they have done', () => {
    const row = rowFor(
      {
        saleLock: 'listed',
        listingSupportedOnChain: false,
        collateralIsNft: true,
        heldVpfiUnresolved: true,
        borrowerOffsetPending: true,
      },
      'list',
    );
    expect(row.unavailable).toBe(o.listAlreadyListed);
  });

  it('network support outranks the per-position reasons', () => {
    const row = rowFor(
      {
        listingSupportedOnChain: false,
        collateralIsNft: true,
        borrowerOffsetPending: true,
      },
      'list',
    );
    expect(row.unavailable).toBe(o.listUnavailableNetwork);
  });

  it('NFT collateral outranks the clearable reasons', () => {
    const row = rowFor(
      { collateralIsNft: true, heldVpfiUnresolved: true, borrowerOffsetPending: true },
      'list',
    );
    expect(row.unavailable).toBe(o.listUnavailableNft);
  });

  it('each remaining blocker states its own reason', () => {
    expect(rowFor({ heldVpfiUnresolved: true }, 'list').unavailable).toBe(
      o.listUnavailableHeldVpfi,
    );
    expect(rowFor({ borrowerOffsetPending: true }, 'list').unavailable).toBe(
      o.listUnavailableOffsetPending,
    );
  });

  it('is available with nothing blocking, and carries its cross-party structural note', () => {
    const row = rowFor({}, 'list');
    expect(row.unavailable).toBeUndefined();
    // The note names what listing holds for the BORROWER, not only the
    // seller — the fact a seller is least likely to expect.
    expect(row.note).toBe(o.listStructural);
  });
});

describe('Basic-mode switch action', () => {
  it('offers the switch when some sale row is actually takeable', () => {
    expect(hasJumpableRow(buildLenderExitRows(base))).toBe(true);
  });

  it('withholds it when every sale row is unavailable — there would be nothing to switch to', () => {
    const rows = buildLenderExitRows({
      ...base,
      maturity: 'past',
      instantSellCandidates: 'none',
    });
    expect(hasJumpableRow(rows)).toBe(false);
  });

  it('does not count the wait row as jumpable', () => {
    const rows = buildLenderExitRows({
      ...base,
      instantSellCandidates: 'none',
      saleLock: 'listed',
    });
    expect(rows.find((r) => r.key === 'wait')!.unavailable).toBeUndefined();
    expect(hasJumpableRow(rows)).toBe(false);
  });
});

describe('sale lock — an unanswered read is not "clear" (Codex r1 P2)', () => {
  it('blocks BOTH sale rows while the listing read is in flight', () => {
    const rows = buildLenderExitRows({ ...base, saleLock: 'checking' });
    expect(rows.find((r) => r.key === 'sell-now')!.unavailable).toBe(
      o.saleLockChecking,
    );
    expect(rows.find((r) => r.key === 'list')!.unavailable).toBe(
      o.saleLockChecking,
    );
  });

  it('blocks the DIRECT sale too when a listing stands — its tool is unmounted, so the jump would scroll to nothing', () => {
    expect(rowFor({ saleLock: 'listed' }, 'sell-now').unavailable).toBe(
      o.sellNowAlreadyListed,
    );
  });

  it('does not let a matching candidate override an unchecked lock', () => {
    // The regression: candidate availability is the NARROWER fact, so
    // it must not decide a row whose authoritative lock is unknown.
    const row = rowFor(
      { saleLock: 'checking', instantSellCandidates: 'some' },
      'sell-now',
    );
    expect(row.unavailable).toBe(o.saleLockChecking);
  });

  it('past due still outranks the lock state', () => {
    const rows = buildLenderExitRows({
      ...base,
      saleLock: 'checking',
      maturity: 'past',
    });
    for (const key of ['sell-now', 'list']) {
      expect(rows.find((r) => r.key === key)!.unavailable).toBe(
        copy.lenderExit.pastDue,
      );
    }
  });

  it('withholds the Basic-mode switch while the lock is unknown', () => {
    expect(hasJumpableRow(buildLenderExitRows({ ...base, saleLock: 'checking' })))
      .toBe(false);
  });
});

describe("sale lock 'unknown' — a read that cannot run is not a read in flight", () => {
  // Self-caught while reviewing the r1 fix: the lock query is gated on
  // a valid lender position token, so with none it never runs and its
  // data is undefined PERMANENTLY. Folding that into 'checking' would
  // have pinned both sale rows behind a spinner that never resolves —
  // the same unknown-as-known defect the tri-state was added to fix,
  // entering by the opposite door.
  it('leaves both sale rows to their narrower predicates rather than blocking', () => {
    const rows = buildLenderExitRows({ ...base, saleLock: 'unknown' });
    expect(rows.find((r) => r.key === 'sell-now')!.unavailable).toBeUndefined();
    expect(rows.find((r) => r.key === 'list')!.unavailable).toBeUndefined();
  });

  it('never renders the checking line — nothing is being checked', () => {
    for (const key of ['sell-now', 'list']) {
      expect(rowFor({ saleLock: 'unknown' }, key).unavailable).not.toBe(
        o.saleLockChecking,
      );
    }
  });

  it('still yields to the narrower reasons that ARE known', () => {
    expect(
      rowFor({ saleLock: 'unknown', collateralIsNft: true }, 'list').unavailable,
    ).toBe(o.listUnavailableNft);
    expect(
      rowFor({ saleLock: 'unknown', instantSellCandidates: 'none' }, 'sell-now')
        .unavailable,
    ).toBe(o.sellNowNoOffers);
  });

  it('still yields to past due', () => {
    expect(rowFor({ saleLock: 'unknown', maturity: 'past' }, 'list').unavailable).toBe(
      copy.lenderExit.pastDue,
    );
  });

  it('does not withhold the Basic-mode switch — the tools are still reachable', () => {
    expect(hasJumpableRow(buildLenderExitRows({ ...base, saleLock: 'unknown' })))
      .toBe(true);
  });
});

describe('wait row — partial repay also pays during the term (Codex r4 P2)', () => {
  // `repayPartial` transfers that share of principal plus the interest
  // built up on it immediately, while the loan stays active. So the
  // plain at-close sentence states the timing wrongly for these loans —
  // the same defect the cadence split exists to avoid, by a second route.
  it('uses the partial variant on a no-cadence loan that permits partial repay', () => {
    expect(
      rowFor({ periodicInterestCadence: 0, allowsPartialRepay: true }, 'wait').desc,
    ).toBe(o.waitDescAtClosePartial);
  });

  it('keeps the plain at-close shape when partial repay is NOT permitted', () => {
    expect(
      rowFor({ periodicInterestCadence: 0, allowsPartialRepay: false }, 'wait').desc,
    ).toBe(o.waitDescAtClose);
  });

  it('lets cadence win — a periodic schedule already says "during the term"', () => {
    expect(
      rowFor({ periodicInterestCadence: 2, allowsPartialRepay: true }, 'wait').desc,
    ).toBe(o.waitDescPeriodic);
  });

  it('still says checking when the schedule is unknown, whatever partial says', () => {
    expect(
      rowFor({ periodicInterestCadence: undefined, allowsPartialRepay: true }, 'wait')
        .desc,
    ).toBe(o.waitDescChecking);
  });
});

describe('listed row — do not promise a cancel the pending card withholds (Codex r5 P2)', () => {
  it('promises cancellation only when the listing record is recoverable', () => {
    expect(
      rowFor({ saleLock: 'listed', saleListingCancellable: true }, 'list').unavailable,
    ).toBe(o.listAlreadyListed);
  });

  it('points elsewhere when it is not — matching the pending card’s own refusal', () => {
    expect(
      rowFor({ saleLock: 'listed', saleListingCancellable: false }, 'list').unavailable,
    ).toBe(o.listAlreadyListedNoCancel);
  });

  // The sell-now row NAMES the cancel as the fix ("cancel the listing
  // first"), so the identical split applies one row up. Fixing only
  // the listing row would leave the same wrong instruction directly
  // above the corrected one.
  it('applies the same split to the sell-now row, which names the cancel as the fix', () => {
    expect(
      rowFor({ saleLock: 'listed', saleListingCancellable: true }, 'sell-now')
        .unavailable,
    ).toBe(o.sellNowAlreadyListed);
    expect(
      rowFor({ saleLock: 'listed', saleListingCancellable: false }, 'sell-now')
        .unavailable,
    ).toBe(o.sellNowAlreadyListedNoCancel);
  });

  it('lets past-due still outrank both listed variants on both rows', () => {
    for (const cancellable of [true, false]) {
      for (const key of ['sell-now', 'list'] as const) {
        expect(
          rowFor(
            { saleLock: 'listed', saleListingCancellable: cancellable, maturity: 'past' },
            key,
          ).unavailable,
        ).toBe(copy.lenderExit.pastDue);
      }
    }
  });
});

describe('cost survives a live listing (Codex r5 P1)', () => {
  // A listed position is a sale in FLIGHT, not a declined option: the
  // held-balance transfer and reward forfeiture are pending
  // consequences, and LoanSalePendingCard states neither.
  it('keeps the cost line on both sale rows while listed, despite being unavailable', () => {
    const rows = buildLenderExitRows({ ...base, saleLock: 'listed' });
    for (const key of ['sell-now', 'list']) {
      const row = rows.find((r) => r.key === key)!;
      expect(row.unavailable).toBeDefined();
      expect(row.costStillApplies).toBe(true);
    }
  });

  it('does NOT keep it for an option merely unavailable for another reason', () => {
    const row = rowFor({ collateralIsNft: true }, 'list');
    expect(row.unavailable).toBe(o.listUnavailableNft);
    expect(row.costStillApplies).toBe(false);
  });
});

describe('the tools behind the rows (Codex r3 P2)', () => {
  // Both sale tools live behind the fee-entitlement disclosure read,
  // and their jump ANCHORS go with them. A row left available then
  // rendered a jump to an element that did not exist, and `jump()`
  // optional-chains a missing target — so the click did nothing, with
  // nothing said. Availability follows the tools.
  it('holds BOTH sale rows while the disclosure read is in flight', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(rowFor({ saleTools: 'checking' }, key).unavailable).toBe(
        o.saleToolsChecking,
      );
    }
  });

  it('says so when that read failed, rather than showing a spinner', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(rowFor({ saleTools: 'failed' }, key).unavailable).toBe(
        o.saleToolsFailed,
      );
    }
  });

  it('offers no switch to Advanced when neither tool can render', () => {
    expect(hasJumpableRow(buildLenderExitRows({ ...base, saleTools: 'checking' }))).toBe(
      false,
    );
  });

  // The kill switch is LISTING-scoped: `LoanSaleFlow` refuses on
  // `post-offer`, the direct sale carries no kill switch at all, so
  // gating both rows would invent a blocker on the instant exit.
  it('marks the listing row unavailable under the operator kill switch', () => {
    expect(rowFor({ listingFlowDisabled: true }, 'list').unavailable).toBe(
      o.listUnavailableFlowDisabled,
    );
  });

  it('leaves the direct sale alone under that same switch', () => {
    expect(rowFor({ listingFlowDisabled: true }, 'sell-now').unavailable).toBeUndefined();
  });

  // Ordering, each asserted with every lower-precedence blocker also
  // set, so precedence is pinned rather than incidentally passing.
  it('ranks the listing lock above both operational blockers', () => {
    expect(
      rowFor(
        { saleLock: 'listed', listingFlowDisabled: true, saleTools: 'checking' },
        'list',
      ).unavailable,
    ).toBe(o.listAlreadyListed);
  });

  it('ranks past-due above everything', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(
        rowFor(
          { maturity: 'past', listingFlowDisabled: true, saleTools: 'failed' },
          key,
        ).unavailable,
      ).toBe(copy.lenderExit.pastDue);
    }
  });

  it('ranks the kill switch above the disclosure read, and both above position refusals', () => {
    expect(
      rowFor(
        { listingFlowDisabled: true, saleTools: 'failed', heldVpfiUnresolved: true },
        'list',
      ).unavailable,
    ).toBe(o.listUnavailableFlowDisabled);
    expect(
      rowFor({ saleTools: 'failed', heldVpfiUnresolved: true }, 'list').unavailable,
    ).toBe(o.saleToolsFailed);
  });

  it('still ranks the network and collateral facts above both', () => {
    expect(
      rowFor(
        { listingSupportedOnChain: false, listingFlowDisabled: true, saleTools: 'failed' },
        'list',
      ).unavailable,
    ).toBe(o.listUnavailableNetwork);
    expect(
      rowFor(
        { collateralIsNft: true, listingFlowDisabled: true, saleTools: 'failed' },
        'list',
      ).unavailable,
    ).toBe(o.listUnavailableNft);
  });
});

describe('an unestablished due date is not a live one (Codex r6 P2)', () => {
  // `pastDue` used to be a boolean whose false arm covered BOTH "the
  // chain says the term is running" and "no read answered". In Basic
  // mode the strategy read is disabled outright, so an errored terms
  // read left the card asserting a live term with nothing behind it —
  // on the one question that refuses both exits.
  it('holds both sale rows when maturity could not be established', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(rowFor({ maturity: 'unknown' }, key).unavailable).toBe(
        o.maturityUnknown,
      );
    }
  });

  it('says something different from the past-due line — the two are not the same claim', () => {
    expect(rowFor({ maturity: 'unknown' }, 'list').unavailable).not.toBe(
      copy.lenderExit.pastDue,
    );
  });

  it('outranks every narrower reason, exactly as past-due does', () => {
    expect(
      rowFor(
        {
          maturity: 'unknown',
          saleLock: 'listed',
          listingFlowDisabled: true,
          collateralIsNft: true,
          instantSellCandidates: 'none',
        },
        'list',
      ).unavailable,
    ).toBe(o.maturityUnknown);
    expect(
      rowFor(
        { maturity: 'unknown', instantSellCandidates: 'none' },
        'sell-now',
      ).unavailable,
    ).toBe(o.maturityUnknown);
  });

  it('leaves the wait row alone — waiting needs no due date to be safe advice', () => {
    const rows = buildLenderExitRows({ ...base, maturity: 'unknown' });
    expect(rows.find((r) => r.key === 'wait')!.unavailable).toBeUndefined();
  });

  it('withholds the Advanced switch, since neither tool would be offered', () => {
    expect(hasJumpableRow(buildLenderExitRows({ ...base, maturity: 'unknown' }))).toBe(
      false,
    );
  });
});

describe('a failed read is not a slow one (Codex r7 P2)', () => {
  // Both arrive as an undefined cadence. Rendering the checking line
  // for a persistent failure promises an answer that is not coming —
  // the sale lock's fourth-state lesson, on the wait row.
  it('says the schedule could not be read, rather than still reading it', () => {
    const desc = rowFor(
      { periodicInterestCadence: undefined, cadenceReadFailed: true },
      'wait',
    ).desc;
    expect(desc).toBe(o.waitDescUnknown);
    expect(desc).not.toBe(o.waitDescChecking);
  });

  it('still says checking while the read is merely in flight', () => {
    expect(
      rowFor({ periodicInterestCadence: undefined, cadenceReadFailed: false }, 'wait')
        .desc,
    ).toBe(o.waitDescChecking);
  });

  it('is ignored once the cadence actually resolved, either way', () => {
    expect(
      rowFor({ periodicInterestCadence: 2, cadenceReadFailed: true }, 'wait').desc,
    ).toBe(o.waitDescPeriodic);
    expect(
      rowFor({ periodicInterestCadence: 0, cadenceReadFailed: true }, 'wait').desc,
    ).toBe(o.waitDescAtClose);
  });

  it('never marks the wait row unavailable for it — waiting is still the honest default', () => {
    expect(
      rowFor({ periodicInterestCadence: undefined, cadenceReadFailed: true }, 'wait')
        .unavailable,
    ).toBeUndefined();
  });
});
