import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import {
  buildLenderExitRows,
  chooserReadiness,
  hasJumpableRow,
  type LenderExitInput,
} from './lenderExitRows';

const o = copy.lenderExit.options;

/** A position with nothing blocking either sale path. */
const base: LenderExitInput = {
  periodicInterestCadence: 0,
  cadenceReadFailed: false,
  maturity: 'current',
  listingWindowTooShort: false,
  listingSupportedOnChain: true,
  listingFlowDisabled: false,
  saleTools: 'ready',
  collateralIsNft: false,
  allowsPartialRepay: false,
  lenderFeeModeFull: false,
  saleCancel: 'yes',
  fallbackPending: false,
  saleLock: 'clear',
  listingMayStand: false,
  heldVpfiUnresolved: false,
  borrowerOffsetPending: false,
  instantSellCandidates: 'some',
  statusSettled: true,
  maturitySettled: true,
  maturityReadFailed: false,
  statusReadFailed: false,
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
      listingWindowTooShort: true,
      listingSupportedOnChain: false,
      listingFlowDisabled: true,
      saleTools: 'failed',
      collateralIsNft: true,
      allowsPartialRepay: true,
      lenderFeeModeFull: true,
      saleCancel: 'no-elsewhere',
      fallbackPending: true,
      saleLock: 'listed',
      listingMayStand: true,
      heldVpfiUnresolved: true,
      borrowerOffsetPending: true,
      instantSellCandidates: 'none',
      statusSettled: false,
      maturitySettled: false,
      maturityReadFailed: true,
      statusReadFailed: true,
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
    expect(rowFor({ saleLock: 'listed', listingMayStand: true }, 'sell-now').unavailable).toBe(
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
      rowFor({ saleLock: 'listed', saleCancel: 'yes' }, 'list').unavailable,
    ).toBe(o.listAlreadyListed);
  });

  it('points elsewhere when it is not — matching the pending card’s own refusal', () => {
    expect(
      rowFor({ saleLock: 'listed', saleCancel: 'no-elsewhere' }, 'list').unavailable,
    ).toBe(o.listAlreadyListedNoCancel);
  });

  // The sell-now row NAMES the cancel as the fix ("cancel the listing
  // first"), so the identical split applies one row up. Fixing only
  // the listing row would leave the same wrong instruction directly
  // above the corrected one.
  it('applies the same split to the sell-now row, which names the cancel as the fix', () => {
    expect(
      rowFor({ saleLock: 'listed', saleCancel: 'yes' }, 'sell-now')
        .unavailable,
    ).toBe(o.sellNowAlreadyListed);
    expect(
      rowFor({ saleLock: 'listed', saleCancel: 'no-elsewhere' }, 'sell-now')
        .unavailable,
    ).toBe(o.sellNowAlreadyListedNoCancel);
  });

  it('lets past-due still outrank both listed variants on both rows', () => {
    for (const cancellable of ['yes', 'no-elsewhere'] as const) {
      for (const key of ['sell-now', 'list'] as const) {
        expect(
          rowFor(
            { saleLock: 'listed', saleCancel: cancellable, maturity: 'past' },
            key,
          ).unavailable,
        ).toBe(copy.lenderExit.pastDue);
      }
    }
  });
});

describe('the wait row answers the live listing too (Codex r24 P2)', () => {
  // The same `listingMayStand` the sale rows use for `costStillApplies`.
  // It reached the rows that NAME the cost and not the row that denies
  // there is one, so the card said "a buyer can still complete this,
  // here is what it takes" and "costs nothing — this is the default"
  // about one listing, on one screen.
  it('stops calling waiting cost-free while a listing may still be filled', () => {
    const row = rowFor({ saleLock: 'listed', listingMayStand: true }, 'wait');
    expect(row.cost).toBe(o.waitCostListed);
    // Not refused — cancelling is the way back to it, and greying the
    // row out would suggest there is none.
    expect(row.unavailable).toBeUndefined();
  });

  it('keeps the cost-free default when no listing stands', () => {
    expect(rowFor({}, 'wait').cost).toBe(o.waitCost);
  });

  it('agrees with the sale rows on the same input', () => {
    const rows = buildLenderExitRows({
      ...base,
      saleLock: 'listed',
      listingMayStand: true,
    });
    const wait = rows.find((r) => r.key === 'wait')!;
    for (const key of ['sell-now', 'list']) {
      const sale = rows.find((r) => r.key === key)!;
      // One live listing, one verdict: if the sale rows say the cost is
      // still pending, the wait row must not say there is no cost.
      expect(sale.costStillApplies).toBe(true);
      expect(wait.cost).not.toBe(o.waitCost);
    }
  });
});

describe('cost survives a live listing (Codex r5 P1)', () => {
  // A listed position is a sale in FLIGHT, not a declined option: the
  // held-balance transfer and reward forfeiture are pending
  // consequences, and LoanSalePendingCard states neither.
  it('keeps the cost line on both sale rows while listed, despite being unavailable', () => {
    // Both inputs, mirroring the call site: `saleLock === 'listed'`
    // only arises from a confirmed `listed: true`, which is exactly
    // what sets `listingMayStand`. They are separate inputs because
    // they come APART on an errored poll, not because a live listing
    // can set one without the other.
    const rows = buildLenderExitRows({
      ...base,
      saleLock: 'listed',
      listingMayStand: true,
    });
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

describe('two ways a cancel can be absent, two sentences (Codex r8 P2)', () => {
  // My own r7 fix folded a FAILED holder read into the "listed from
  // another device" wording, which fabricates a cause: the read says
  // nothing about where the listing was made, and may clear on retry.
  it('says elsewhere only when the offer record is genuinely missing', () => {
    expect(rowFor({ saleLock: 'listed', saleCancel: 'no-elsewhere' }, 'list').unavailable)
      .toBe(o.listAlreadyListedNoCancel);
  });

  it('stays cause-neutral when it is the holder read that failed', () => {
    const line = rowFor(
      { saleLock: 'listed', saleCancel: 'no-unverified' },
      'list',
    ).unavailable;
    expect(line).toBe(o.listAlreadyListedCancelUnverified);
    expect(line).not.toBe(o.listAlreadyListedNoCancel);
  });

  it('applies the same split on the sell-now row', () => {
    expect(
      rowFor({ saleLock: 'listed', saleCancel: 'no-unverified' }, 'sell-now').unavailable,
    ).toBe(o.sellNowAlreadyListedCancelUnverified);
  });
});

describe('a fallback-pending loan admits no sale (Codex r8 P2)', () => {
  // Both entry points require exactly Active. The card stays mounted —
  // the status is not terminal and waiting is still honest advice —
  // but neither sale can be started.
  it('blocks both sale rows', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(rowFor({ fallbackPending: true }, key).unavailable).toBe(
        o.saleFallbackPending,
      );
    }
  });

  it('outranks the listing lock, whose advice would lead nowhere', () => {
    expect(
      rowFor({ fallbackPending: true, saleLock: 'listed' }, 'list').unavailable,
    ).toBe(o.saleFallbackPending);
  });

  it('still yields to past-due and to an unestablished due date', () => {
    expect(
      rowFor({ fallbackPending: true, maturity: 'past' }, 'list').unavailable,
    ).toBe(copy.lenderExit.pastDue);
    expect(
      rowFor({ fallbackPending: true, maturity: 'unknown' }, 'list').unavailable,
    ).toBe(o.maturityUnknown);
  });

  it('leaves the wait row untouched', () => {
    const rows = buildLenderExitRows({ ...base, fallbackPending: true });
    expect(rows.find((r) => r.key === 'wait')!.unavailable).toBeUndefined();
  });
});

describe('a failed prerequisite names no read at all (Codex r10 P2)', () => {
  // Three rounds argued about WHICH read to blame: r8 sent a
  // token-metadata failure into the fee sentence, r9 split them, r10
  // found a third prerequisite arriving in the fee sentence again. The
  // states collapsed instead — a name that does not exist cannot be
  // wrong, and the reader could not act on it anyway.
  it('reports one sentence for a failed prerequisite, whichever it was', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(rowFor({ saleTools: 'failed' }, key).unavailable).toBe(
        o.saleToolsFailed,
      );
    }
  });

  it('does not blame a specific read in that sentence', () => {
    // The guard that keeps the collapse honest: if someone reintroduces
    // an attribution, it has to survive being pointed at three
    // different prerequisites, which is what kept failing.
    for (const term of ['fee', 'token', 'loan details']) {
      expect(o.saleToolsFailed.toLowerCase()).not.toContain(term);
    }
  });

  it('separates a failed read from a slow one', () => {
    for (const key of ['sell-now', 'list'] as const) {
      expect(rowFor({ saleTools: 'checking' }, key).unavailable).toBe(
        o.saleToolsChecking,
      );
      expect(rowFor({ saleTools: 'checking' }, key).unavailable).not.toBe(
        o.saleToolsFailed,
      );
    }
  });

  it('keeps the failure ranked exactly where it was', () => {
    expect(
      rowFor({ saleTools: 'failed', maturity: 'past' }, 'list').unavailable,
    ).toBe(copy.lenderExit.pastDue);
    expect(
      rowFor({ saleTools: 'failed', heldVpfiUnresolved: true }, 'list')
        .unavailable,
    ).not.toBe(o.listUnavailableHeldVpfi);
  });
});


describe('Full-tariff entitlement — the fourth loss', () => {
  it('is silent on a position that is not Full-stamped', () => {
    for (const key of ['sell-now', 'list']) {
      expect(rowFor({ lenderFeeModeFull: false }, key).costExtra).toBeUndefined();
    }
  });

  it('names the forfeited plan on BOTH sale rows when the stamp is Full', () => {
    for (const key of ['sell-now', 'list']) {
      expect(rowFor({ lenderFeeModeFull: true }, key).costExtra).toBe(
        o.costFullTariff,
      );
    }
  });

  it('never touches the wait row — keeping the position keeps the plan', () => {
    expect(rowFor({ lenderFeeModeFull: true }, 'wait').costExtra).toBeUndefined();
  });

  it('survives alongside a live listing, exactly as the base cost does', () => {
    // A listed position is a sale in flight, so its costs are pending
    // consequences rather than declined prices — and the entitlement
    // transfers on completion with everything else. If this ever
    // diverged from `costStillApplies`, one cost line would vanish
    // while its sibling stayed.
    const row = rowFor({ lenderFeeModeFull: true, saleLock: 'listed', listingMayStand: true }, 'list');
    expect(row.costStillApplies).toBe(true);
    expect(row.costExtra).toBe(o.costFullTariff);
    expect(row.cost).toBe(o.listCost);
  });

  it('is a SEPARATE line, never folded into the base sentence', () => {
    // The base cost is identical for every position; only this line
    // varies. Concatenating them would mean two near-identical long
    // strings per row in nine locales.
    const full = rowFor({ lenderFeeModeFull: true }, 'sell-now');
    const plain = rowFor({ lenderFeeModeFull: false }, 'sell-now');
    expect(full.cost).toBe(plain.cost);
    expect(full.cost).not.toContain(o.costFullTariff);
  });
});

describe('borrower offset — refuses BOTH routes, not just listing', () => {
  it('blocks the instant-sale row, which jumps straight to a wallet prompt', () => {
    // EarlyWithdrawalDirectFacet:253 reverts OffsetActiveOnLoan just as
    // the listing facet does. Consulting it on one row only left the
    // more dangerous row available (Codex r15 P2).
    expect(rowFor({ borrowerOffsetPending: true }, 'sell-now').unavailable).toBe(
      o.listUnavailableOffsetPending,
    );
  });

  it('still blocks the listing row', () => {
    expect(rowFor({ borrowerOffsetPending: true }, 'list').unavailable).toBe(
      o.listUnavailableOffsetPending,
    );
  });

  it('past due still outranks it on both rows', () => {
    for (const key of ['sell-now', 'list']) {
      expect(
        rowFor({ borrowerOffsetPending: true, maturity: 'past' }, key).unavailable,
      ).toBe(copy.lenderExit.pastDue);
    }
  });
});


describe('final-hour listing cutoff', () => {
  it('blocks ONLY the listing row — the instant sale has no window', () => {
    expect(rowFor({ listingWindowTooShort: true }, 'list').unavailable).toBe(
      o.listUnavailableTooClose,
    );
    expect(
      rowFor({ listingWindowTooShort: true }, 'sell-now').unavailable,
    ).toBeUndefined();
  });

  it('is outranked by past maturity — the wider refusal wins', () => {
    expect(
      rowFor({ listingWindowTooShort: true, maturity: 'past' }, 'list')
        .unavailable,
    ).toBe(copy.lenderExit.pastDue);
  });

  it('outranks the narrower network and collateral reasons', () => {
    const row = rowFor(
      {
        listingWindowTooShort: true,
        listingSupportedOnChain: false,
        collateralIsNft: true,
      },
      'list',
    );
    expect(row.unavailable).toBe(o.listUnavailableTooClose);
  });
});


describe('lock trust vs listing risk — two questions, two inputs', () => {
  it('keeps BOTH cost lines up when a listing may still stand but the poll errored', () => {
    // saleLock 'checking' blocks the rows; listingMayStand keeps the
    // disclosure. Collapsing these hid the held-balance and reward
    // losses while a buyer could still accept.
    const row = rowFor(
      { saleLock: 'checking', listingMayStand: true, lenderFeeModeFull: true },
      'list',
    );
    expect(row.unavailable).toBe(o.saleLockChecking);
    expect(row.costStillApplies).toBe(true);
    expect(row.cost).toBe(o.listCost);
    expect(row.costExtra).toBe(o.costFullTariff);
  });

  it('does not claim a pending cost when no listing was ever seen', () => {
    const row = rowFor({ saleLock: 'checking', listingMayStand: false }, 'list');
    expect(row.costStillApplies).toBeFalsy();
  });

  it('blocks both rows while the lock is unverified — never waves them through', () => {
    for (const key of ['sell-now', 'list']) {
      expect(rowFor({ saleLock: 'checking' }, key).unavailable).toBe(
        o.saleLockChecking,
      );
    }
  });

  it('leaves the rows takeable only once the lock reads clear', () => {
    for (const key of ['sell-now', 'list']) {
      expect(rowFor({ saleLock: 'clear' }, key).unavailable).toBeUndefined();
    }
  });
});


describe('final-hour message does not promise a shut exit', () => {
  it('reassures about the instant sale only when that row is takeable', () => {
    expect(rowFor({ listingWindowTooShort: true }, 'list').unavailable).toBe(
      o.listUnavailableTooClose,
    );
  });

  it('drops the reassurance when a shared prerequisite shut sell-now too', () => {
    // saleTools 'failed' shuts BOTH rows; the listing row still wins
    // the precedence contest, so its tail must not point at an exit
    // that is equally unavailable.
    const rows = buildLenderExitRows({
      ...base,
      listingWindowTooShort: true,
      saleTools: 'failed',
    });
    expect(rows.find((r) => r.key === 'sell-now')!.unavailable).toBeDefined();
    expect(rows.find((r) => r.key === 'list')!.unavailable).toBe(
      o.listUnavailableTooCloseOnly,
    );
  });
});

describe('chooserReadiness — has the jumpability question settled?', () => {
  // Why this exists at all: from outside the card, "no switch" means
  // either "still reading" or "nothing to switch to", and a live driver
  // cannot tell those apart from the DOM. It waits out a 45-second
  // deadline per page and still cannot distinguish a stale render from
  // a regression (#1855, and three defect families on #1853).

  it('is ready when every jumpability input has answered', () => {
    expect(chooserReadiness(base)).toBe('ready');
  });

  const pendingCases: Array<[string, Partial<LenderExitInput>]> = [
    ['the sale tools are still checking', { saleTools: 'checking' }],
    ['the due date has not been established', { maturity: 'unknown' }],
    ['the sale lock is still being read', { saleLock: 'checking' }],
    ['the offer sweep is still running', { instantSellCandidates: 'checking' }],
  ];
  for (const [name, patch] of pendingCases) {
    it(`is pending while ${name}`, () => {
      expect(chooserReadiness({ ...base, ...patch })).toBe('pending');
    });
  }

  // The load-bearing asymmetry, and the reason this is not just
  // "anything not concrete is pending".
  describe("'unknown' is not uniformly pending", () => {
    it('treats an unreadable sale lock as SETTLED, not pending', () => {
      // No query can run for it and none ever will, so waiting would
      // hang forever — on a Basic-mode page, permanently.
      expect(chooserReadiness({ ...base, saleLock: 'unknown' })).toBe('ready');
    });

    it('treats an unrun offer sweep as SETTLED, not pending', () => {
      // Basic mode deliberately does not run it; the row makes no claim
      // rather than waiting on an answer nobody is fetching.
      expect(chooserReadiness({ ...base, instantSellCandidates: 'unknown' })).toBe('ready');
    });

    it('treats an unestablished due date as PENDING, because it clears', () => {
      // A query enabled for exactly this case has not answered yet.
      expect(chooserReadiness({ ...base, maturity: 'unknown' })).toBe('pending');
    });
  });

  it('reports a failed prerequisite distinctly from ready', () => {
    // The rows HAVE settled, so a reader is not left waiting — but a
    // consumer asserting "the switch should be here" must not read a
    // failed prerequisite as a clean negative answer.
    expect(chooserReadiness({ ...base, saleTools: 'failed' })).toBe('failed');
  });

  it('does not wait on the cadence read, which cannot move a jump', () => {
    // Cadence changes the WAIT row's wording only. Waiting on it would
    // block readiness on an answer irrelevant to jumpability — and on a
    // loan whose cadence read never lands, readiness would never come.
    expect(chooserReadiness({ ...base, periodicInterestCadence: undefined })).toBe('ready');
    expect(chooserReadiness({ ...base, cadenceReadFailed: true })).toBe('ready');
  });

  it('answers ready on a past-due position, where nothing is jumpable', () => {
    // Settled and negative is the common live case — every lender
    // position on the testnet chain today. Readiness must not be
    // conflated with jumpability: the question has an answer, and the
    // answer is no.
    const pastDue = { ...base, maturity: 'past' as const };
    expect(chooserReadiness(pastDue)).toBe('ready');
    expect(hasJumpableRow(buildLenderExitRows(pastDue))).toBe(false);
  });

  describe('a conclusive negative does not wait on reads that cannot matter', () => {
    // The combination the first version of this suite MISSED, because
    // every case inherited fully-settled secondaries from `base` (Codex
    // #1858 r1). Past maturity shuts both sale rows ahead of every
    // narrower reason, so a still-checking lock or sweep cannot change
    // the answer — and reporting `pending` there kept a past-due page
    // undecided behind a slow read, which is the exact timeout this
    // predicate exists to remove.
    const stillLoading = {
      saleTools: 'checking' as const,
      saleLock: 'checking' as const,
      instantSellCandidates: 'checking' as const,
    };

    it('is ready past maturity even with every secondary read in flight', () => {
      const input = { ...base, maturity: 'past' as const, ...stillLoading };
      expect(chooserReadiness(input)).toBe('ready');
      expect(hasJumpableRow(buildLenderExitRows(input))).toBe(false);
    });

    it('is ready past maturity even when a prerequisite read FAILED', () => {
      const input = { ...base, maturity: 'past' as const, saleTools: 'failed' as const };
      expect(chooserReadiness(input)).toBe('ready');
    });

    it('is ready on a fallback-settling loan with reads in flight', () => {
      // Same shape: a fallback-pending loan refuses both sales outright.
      const input = { ...base, fallbackPending: true, ...stillLoading };
      expect(chooserReadiness(input)).toBe('ready');
      expect(hasJumpableRow(buildLenderExitRows(input))).toBe(false);
    });

    it('agrees with the rows about which blocks are conclusive', () => {
      // The anti-drift assertion. `pastDueOr` and `chooserReadiness` now
      // share one precedence head; this pins that they still agree
      // rather than trusting the extraction to hold.
      for (const head of [{ maturity: 'past' as const }, { fallbackPending: true }]) {
        const input = { ...base, ...head, ...stillLoading };
        expect(chooserReadiness(input)).toBe('ready');
        expect(hasJumpableRow(buildLenderExitRows(input))).toBe(false);
      }
    });
  });

  describe('an unsettled status read is not a settled answer', () => {
    // `fallbackPending` is a `.some(...)` on the page, so `false` means
    // either "not fallback" or "nothing has answered yet" (Codex #1858
    // r1). Publishing `ready` on the ambiguous case let the answer flip
    // from yes to no when the outstanding query reported
    // FallbackPending — a settled verdict that unsettled itself.
    it('is pending while no live status read has answered', () => {
      expect(chooserReadiness({ ...base, statusSettled: false })).toBe('pending');
    });

    it('stays pending even when another input has already failed', () => {
      // Pending outranks failed here: the status answer could still make
      // this a conclusive negative, which is a better answer than
      // "settled but untrustworthy".
      const input = { ...base, statusSettled: false, saleTools: 'failed' as const };
      expect(chooserReadiness(input)).toBe('pending');
    });

    it('does not gate a conclusive negative on the status read', () => {
      // Past-due does not wait on `liveStatus`: that query carries a
      // status enum, not a term, so it cannot change the maturity
      // verdict. The maturity sources are a different question — see
      // the block below.
      expect(chooserReadiness({ ...base, maturity: 'past', statusSettled: false })).toBe(
        'ready',
      );
    });

    it('does not gate a fallback negative on the status read either', () => {
      // Same reasoning as past-due: fallback shuts both rows outright.
      expect(
        chooserReadiness({ ...base, fallbackPending: true, statusSettled: false }),
      ).toBe('ready');
    });
  });

  describe('a past-due verdict is provisional until its own reads land', () => {
    // The retraction this closes (Codex #1858 r3). `maturity` is
    // RECONCILED from two term reads and answers `'unknown'` when they
    // disagree, so a `'past'` computed from the one that landed first
    // is not yet an answer: an in-grace keeper extension moves the due
    // date forward, the second read arrives with the longer term, and
    // the verdict becomes `'unknown'`. Readiness had already published
    // `ready`/`no` — a settled answer retracting with no chain
    // transition behind it, which is precisely what an external check
    // reads this attribute to avoid.
    it('is pending when past maturity but a term read is still in flight', () => {
      expect(
        chooserReadiness({ ...base, maturity: 'past', maturitySettled: false }),
      ).toBe('pending');
    });

    it('is pending on a current verdict that is equally provisional', () => {
      // Not a past-due special case: a `'current'` from one source can
      // become `'unknown'` on disagreement just as a `'past'` can, so
      // the wait is on the RECONCILIATION, not on which side it landed.
      expect(
        chooserReadiness({ ...base, maturity: 'current', maturitySettled: false }),
      ).toBe('pending');
    });

    it('becomes ready once the term reads have all answered', () => {
      expect(chooserReadiness({ ...base, maturity: 'past', maturitySettled: true })).toBe(
        'ready',
      );
    });

    it('does NOT hold a fallback answer behind the term reads', () => {
      // The asymmetry that makes this correct rather than merely
      // cautious. `fallbackPending: true` is a positive observation
      // from a status read; nothing a term read reports can reopen a
      // sale route on a fallback-settling loan. Waiting here would
      // restore the timeout on exactly the population the conclusive
      // arm exists to spare — so the two arms are gated differently on
      // purpose.
      expect(
        chooserReadiness({
          ...base,
          fallbackPending: true,
          maturity: 'past',
          maturitySettled: false,
        }),
      ).toBe('ready');
    });

    it('holds even when a later input has already failed', () => {
      // Same precedence as the status gate: the term reads could still
      // make this a conclusive negative, which beats "settled but
      // untrustworthy".
      expect(
        chooserReadiness({
          ...base,
          maturity: 'past',
          maturitySettled: false,
          saleTools: 'failed' as const,
        }),
      ).toBe('pending');
    });
  });

  describe('settled and ANSWERED are not the same thing', () => {
    // Round 3 stopped readiness resting on a verdict whose reads were
    // still in flight. This is the same retraction reached by the other
    // route (Codex #1858 r4): a source that stopped by ERRORING counted
    // as settled, so a verdict resting on whichever source landed could
    // be published — and an errored query keeps its refetch interval,
    // so its recovery can overturn that verdict with nothing having
    // happened on chain.
    it('reports failed when a maturity read errored, even past maturity', () => {
      expect(
        chooserReadiness({ ...base, maturity: 'past', maturityReadFailed: true }),
      ).toBe('failed');
    });

    it('reports failed when a status read errored on an otherwise ready card', () => {
      expect(chooserReadiness({ ...base, statusReadFailed: true })).toBe('failed');
    });

    it('is failed rather than pending — the rows HAVE settled', () => {
      // The distinction is the whole reason `failed` exists as a third
      // state. Pending says "wait, an answer is coming"; nothing is
      // coming here, and a consumer asserting "the switch should be
      // here" must not read the result as a clean negative either.
      const out = chooserReadiness({ ...base, maturityReadFailed: true });
      expect(out).toBe('failed');
      expect(out).not.toBe('pending');
    });

    it('still holds an in-flight read ahead of a failed one', () => {
      // Ordering: something outstanding could still make this a
      // conclusive negative, which beats "settled but untrustworthy".
      expect(
        chooserReadiness({
          ...base,
          maturitySettled: false,
          maturityReadFailed: true,
        }),
      ).toBe('pending');
    });

    it('does NOT hold a fallback answer behind a failed read', () => {
      // Same asymmetry as round 3's: a positive FallbackPending
      // observation shuts both sale routes whatever any other read
      // later reports, so no failure can make it provisional.
      expect(
        chooserReadiness({
          ...base,
          fallbackPending: true,
          maturityReadFailed: true,
          statusReadFailed: true,
        }),
      ).toBe('ready');
    });

    it('reads a disagreement as pending, not failed', () => {
      // Two HEALTHY sources that disagree resolve to `unknown`, and
      // that clears on the next poll of either — so it is a wait, not
      // an untrustworthy answer. Ordering `maturityReadFailed` ahead of
      // the `unknown` check is what keeps these two apart.
      expect(chooserReadiness({ ...base, maturity: 'unknown' })).toBe('pending');
    });
  });

  describe('jumpability conclusiveness is NOT the copy precedence', () => {
    // Round 1 shared `conclusiveBlock` between the row copy and
    // readiness, on the reasoning that one rule should not be written
    // twice. They are two different rules (Codex #1858 r2): for COPY an
    // unestablished due date outranks a fallback status, because it is
    // the more informative sentence; for JUMPABILITY it does not matter
    // at all, because fallback refuses both routes whatever maturity
    // turns out to be.
    it('is ready when fallback lands before the due date is established', () => {
      // The exact combination the shared precedence got wrong: the copy
      // arm names maturity-unknown, which sent this back to `pending`
      // and preserved the timeout on the whole fallback population.
      const input = { ...base, fallbackPending: true, maturity: 'unknown' as const };
      expect(chooserReadiness(input)).toBe('ready');
      expect(hasJumpableRow(buildLenderExitRows(input))).toBe(false);
    });

    it('still reports the maturity reason in the ROW, not the readiness', () => {
      // The two answers coexist: readiness says "decided, and the answer
      // is no", while the row still shows the more informative copy.
      // Conflating them is what round 1 did.
      const input = { ...base, fallbackPending: true, maturity: 'unknown' as const };
      const sellNow = buildLenderExitRows(input).find((r) => r.key === 'sell-now');
      expect(sellNow?.unavailable).toBe(copy.lenderExit.options.maturityUnknown);
    });

    it('is pending on an unestablished due date with NO fallback', () => {
      // Without the fallback the maturity answer genuinely can still
      // change the outcome, so waiting is right.
      expect(chooserReadiness({ ...base, maturity: 'unknown' })).toBe('pending');
    });
  });
});
