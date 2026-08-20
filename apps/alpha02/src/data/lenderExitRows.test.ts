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
  pastDue: false,
  listingSupportedOnChain: true,
  collateralIsNft: false,
  alreadyListed: false,
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
      pastDue: true,
      listingSupportedOnChain: false,
      collateralIsNft: true,
      alreadyListed: true,
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
    const rows = buildLenderExitRows({ ...base, pastDue: true });
    expect(rows.find((r) => r.key === 'sell-now')!.unavailable).toBe(
      copy.lenderExit.pastDue,
    );
    expect(rows.find((r) => r.key === 'list')!.unavailable).toBe(
      copy.lenderExit.pastDue,
    );
  });

  it('does not report "no matching offers" past due — that would send the lender hunting for a fix that cannot help', () => {
    const row = rowFor(
      { pastDue: true, instantSellCandidates: 'none' },
      'sell-now',
    );
    expect(row.unavailable).toBe(copy.lenderExit.pastDue);
    expect(row.unavailable).not.toBe(o.sellNowNoOffers);
  });

  it('does not report a listing blocker past due either', () => {
    const row = rowFor({ pastDue: true, collateralIsNft: true }, 'list');
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
        alreadyListed: true,
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
      pastDue: true,
      instantSellCandidates: 'none',
    });
    expect(hasJumpableRow(rows)).toBe(false);
  });

  it('does not count the wait row as jumpable', () => {
    const rows = buildLenderExitRows({
      ...base,
      instantSellCandidates: 'none',
      alreadyListed: true,
    });
    expect(rows.find((r) => r.key === 'wait')!.unavailable).toBeUndefined();
    expect(hasJumpableRow(rows)).toBe(false);
  });
});
