import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { formatDateTime } from '../lib/format';
import {
  buildLenderExitRows,
  chooserReadiness,
  hasJumpableRow,
  type LenderExitInput,
} from './lenderExitRows';
import type { SaleExitVerdict, SaleRefusal } from './saleExitVerdict';

const o = copy.lenderExit.options;
const f = o.refusal;

/** One refusal as the verdict hook hands it over (already decoded). */
const refusal = (
  error: string | null,
  args: readonly unknown[] = [],
  reopensAt: number | null = null,
): SaleRefusal => ({ error, args, reopensAt });

const known = (direct: SaleRefusal[] = [], listing: SaleRefusal[] = []): SaleExitVerdict => ({
  kind: 'known',
  direct,
  listing,
});

/** A position the contract clears on both routes, with every app-side
 *  gate open. */
const base: LenderExitInput = {
  periodicInterestCadence: 0,
  cadenceReadFailed: false,
  allowsPartialRepay: false,
  lenderFeeModeFull: false,
  verdict: known(),
  verdictSettled: true,
  saleCancel: 'yes',
  listingMayStand: false,
  listingSupportedOnChain: true,
  listingFlowDisabled: false,
  saleTools: 'ready',
  saleToolsSettled: true,
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

  it('is never marked unavailable, whatever the verdict says', () => {
    for (const verdict of [
      { kind: 'checking' },
      { kind: 'failed' },
      { kind: 'unserved' },
      known([refusal('SaleLoanPastMaturity')], [refusal('SaleLoanPastMaturity')]),
    ] as SaleExitVerdict[]) {
      expect(rowFor({ verdict }, 'wait').unavailable).toBeUndefined();
    }
  });
});

describe('wait row — cadence awareness', () => {
  it('uses the periodic shape when the loan has a schedule', () => {
    expect(rowFor({ periodicInterestCadence: 2 }, 'wait').desc).toBe(o.waitDescPeriodic);
  });

  it('uses the at-close shape only when the schedule is genuinely None', () => {
    expect(rowFor({ periodicInterestCadence: 0 }, 'wait').desc).toBe(o.waitDescAtClose);
  });

  it('says it is still checking while the read is in flight', () => {
    expect(rowFor({ periodicInterestCadence: undefined }, 'wait').desc).toBe(o.waitDescChecking);
  });

  it('says the schedule could not be read when the read failed', () => {
    expect(
      rowFor({ periodicInterestCadence: undefined, cadenceReadFailed: true }, 'wait').desc,
    ).toBe(o.waitDescUnknown);
  });

  it('uses the partial variant on a no-cadence loan that permits partial repay', () => {
    expect(rowFor({ allowsPartialRepay: true }, 'wait').desc).toBe(o.waitDescAtClosePartial);
  });

  it('lets cadence win over partial repay', () => {
    expect(
      rowFor({ allowsPartialRepay: true, periodicInterestCadence: 1 }, 'wait').desc,
    ).toBe(o.waitDescPeriodic);
  });
});

describe('the verdict decides availability (#1841)', () => {
  it('leaves both sale rows available when the contract refuses neither route', () => {
    expect(rowFor({}, 'sell-now').unavailable).toBeUndefined();
    expect(rowFor({}, 'list').unavailable).toBeUndefined();
  });

  it('closes each route on its OWN refusals only', () => {
    const verdict = known([], [refusal('SaleOfferCollateralMustBeERC20')]);
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBeUndefined();
    expect(rowFor({ verdict }, 'list').unavailable).toBe(o.listUnavailableNft);
  });

  it('states the FIRST refusal, which is the one the entry reverts with', () => {
    const verdict = known([refusal('EnforcedPause'), refusal('LoanNotActive')]);
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBe(f.paused);
  });

  it('states past due ahead of the entry’s order, because nothing else can reopen the route', () => {
    const verdict = known(
      [refusal('EnforcedPause'), refusal('SaleLoanPastMaturity')],
      [refusal('SaleOfferAlreadyExists', [], 1_800_000_000), refusal('SaleLoanPastMaturity')],
    );
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBe(copy.lenderExit.pastDue);
    expect(rowFor({ verdict }, 'list').unavailable).toBe(copy.lenderExit.pastDue);
  });

  it.each([
    ['EnforcedPause', f.paused],
    ['SanctionedAddress', f.screened],
    ['LoanNotActive', f.loanNotActive],
    ['NotNFTOwner', f.notHolder],
    ['KeeperAccessRequired', f.notHolder],
    ['InvalidSaleOffer', f.rental],
    ['OffsetActiveOnLoan', o.listUnavailableOffsetPending],
    ['SaleLoanPastMaturity', copy.lenderExit.pastDue],
    ['SaleRelistCooldownActive', f.relistCooldown],
    ['SalePositionNotConsolidatable', f.heldVpfi],
    ['AssetPaused', f.assetPaused],
    ['VaultUpgradeRequired', f.vaultUpgrade],
    ['SalePositionBelowSolvencyFloor', f.admissionBlocked],
    ['SaleLtvAboveAdmissionCap', f.admissionBlocked],
    ['SaleInheritsWeakerRiskTerms', f.admissionBlocked],
    ['SaleInheritsWorseFeeTerms', f.admissionBlocked],
    ['SaleLegUnpriceable', f.admissionUnpriceable],
    ['SaleAdmissionCodeUnknown', f.admissionUnknown],
  ])('words %s', (error, text) => {
    expect(rowFor({ verdict: known([], [refusal(error)]) }, 'list').unavailable).toBe(text);
  });

  it('names the duration cap from the error’s own argument', () => {
    const verdict = known([], [refusal('OfferDurationExceedsCap', [400n, 365n])]);
    expect(rowFor({ verdict }, 'list').unavailable).toBe(f.durationCap('365'));
  });

  it('shows a refusal this build has no words for as a refusal, never as open', () => {
    const verdict = known([refusal('SomeFutureRefusal')]);
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBe(f.unrecognised('SomeFutureRefusal'));
  });

  it('shows an undecodable refusal as a refusal too', () => {
    const verdict = known([refusal(null)]);
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBe(f.unrecognised(f.unnamedError));
  });

  it('appends the contract’s earliest lift time when it names one', () => {
    const at = 1_800_000_000;
    const verdict = known([], [refusal('SaleRelistCooldownActive', [BigInt(at)], at)]);
    expect(rowFor({ verdict }, 'list').unavailable).toBe(
      `${f.relistCooldown} ${f.reopensEarliest(formatDateTime(at))}`,
    );
  });

  it('invents no time when the contract names none', () => {
    const verdict = known([refusal('AssetPaused')]);
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBe(f.assetPaused);
  });
});

describe('a verdict that is not known closes both sale rows', () => {
  it.each([
    ['checking', f.verdictChecking],
    ['failed', f.verdictFailed],
    ['unserved', f.verdictUnserved],
  ] as const)('%s', (kind, text) => {
    const verdict = { kind } as SaleExitVerdict;
    expect(rowFor({ verdict }, 'sell-now').unavailable).toBe(text);
    expect(rowFor({ verdict }, 'list').unavailable).toBe(text);
  });

  it('outranks every app-side gate — the contract’s question comes first', () => {
    const input: Partial<LenderExitInput> = {
      verdict: { kind: 'checking' },
      saleTools: 'failed',
      listingSupportedOnChain: false,
      instantSellCandidates: 'none',
    };
    expect(rowFor(input, 'sell-now').unavailable).toBe(f.verdictChecking);
    expect(rowFor(input, 'list').unavailable).toBe(f.verdictChecking);
  });
});

describe('an existing listing — do not promise a cancel the pending card withholds', () => {
  const listed = known([refusal('SaleOfferAlreadyExists')], [refusal('SaleOfferAlreadyExists')]);

  it.each([
    ['yes', o.listAlreadyListed, o.sellNowAlreadyListed],
    ['no-elsewhere', o.listAlreadyListedNoCancel, o.sellNowAlreadyListedNoCancel],
    ['no-unverified', o.listAlreadyListedCancelUnverified, o.sellNowAlreadyListedCancelUnverified],
    // The contract reports a listing this device's own read has not shown
    // (Codex #3024 r1): neither "below" nor "elsewhere" is known.
    ['unread', o.listAlreadyListedUnread, o.sellNowAlreadyListedUnread],
  ] as const)('saleCancel %s', (saleCancel, listText, sellText) => {
    expect(rowFor({ verdict: listed, saleCancel }, 'list').unavailable).toBe(listText);
    expect(rowFor({ verdict: listed, saleCancel }, 'sell-now').unavailable).toBe(sellText);
  });
});

describe('the final-hour listing window', () => {
  it('reassures about the instant sale only while the contract leaves it open', () => {
    const verdict = known([], [refusal('SaleListingWindowInvalid')]);
    expect(rowFor({ verdict }, 'list').unavailable).toBe(o.listUnavailableTooClose);
  });

  it('drops the reassurance when the direct ROW is closed by this app’s own gates (Codex #3024 r1)', () => {
    const verdict = known([], [refusal('SaleListingWindowInvalid')]);
    for (const input of [
      { saleTools: 'checking' },
      { saleTools: 'failed' },
      { instantSellCandidates: 'none' },
    ] as Partial<LenderExitInput>[]) {
      expect(rowFor({ verdict, ...input }, 'list').unavailable).toBe(o.listUnavailableTooCloseOnly);
    }
  });

  it('drops the reassurance when the direct route is refused too', () => {
    const verdict = known([refusal('EnforcedPause')], [refusal('SaleListingWindowInvalid')]);
    expect(rowFor({ verdict }, 'list').unavailable).toBe(o.listUnavailableTooCloseOnly);
  });
});

describe('app-side gates, after the contract’s answer', () => {
  it('states the contract’s refusal ahead of this app’s own tool state', () => {
    const verdict = known([refusal('LoanNotActive')], [refusal('LoanNotActive')]);
    expect(rowFor({ verdict, saleTools: 'failed' }, 'sell-now').unavailable).toBe(
      f.loanNotActive,
    );
    expect(rowFor({ verdict, listingSupportedOnChain: false }, 'list').unavailable).toBe(
      f.loanNotActive,
    );
  });

  it('holds both rows while the tools’ disclosure read is in flight, and says so on failure', () => {
    expect(rowFor({ saleTools: 'checking' }, 'sell-now').unavailable).toBe(o.saleToolsChecking);
    expect(rowFor({ saleTools: 'checking' }, 'list').unavailable).toBe(o.saleToolsChecking);
    expect(rowFor({ saleTools: 'failed' }, 'sell-now').unavailable).toBe(o.saleToolsFailed);
  });

  it('closes only the listing row where this deployment does not publish it', () => {
    expect(rowFor({ listingSupportedOnChain: false }, 'list').unavailable).toBe(
      o.listUnavailableNetwork,
    );
    expect(rowFor({ listingSupportedOnChain: false }, 'sell-now').unavailable).toBeUndefined();
  });

  it('closes only the listing row under the operator kill switch', () => {
    expect(rowFor({ listingFlowDisabled: true }, 'list').unavailable).toBe(
      o.listUnavailableFlowDisabled,
    );
    expect(rowFor({ listingFlowDisabled: true }, 'sell-now').unavailable).toBeUndefined();
  });

  it('separates candidates checking, none and unknown', () => {
    expect(rowFor({ instantSellCandidates: 'checking' }, 'sell-now').unavailable).toBe(
      copy.lenderExit.checking,
    );
    expect(rowFor({ instantSellCandidates: 'none' }, 'sell-now').unavailable).toBe(
      o.sellNowNoOffers,
    );
    expect(rowFor({ instantSellCandidates: 'unknown' }, 'sell-now').unavailable).toBeUndefined();
  });

  it('offers the listing as the way out of an empty market only while the listing row is open (#1849)', () => {
    expect(
      rowFor({ instantSellCandidates: 'none', listingFlowDisabled: true }, 'sell-now').unavailable,
    ).toBe(o.sellNowNoOffersNoListing);
    const listingRefused = known([], [refusal('SaleOfferAlreadyExists')]);
    expect(
      rowFor({ instantSellCandidates: 'none', verdict: listingRefused }, 'sell-now').unavailable,
    ).toBe(o.sellNowNoOffersNoListing);
  });
});

describe('costs while a listing may stand', () => {
  it('keeps both sale rows’ cost lines, and the wait row stops calling waiting free', () => {
    const verdict = known([refusal('SaleOfferAlreadyExists')], [refusal('SaleOfferAlreadyExists')]);
    const rows = buildLenderExitRows({ ...base, verdict, listingMayStand: true });
    expect(rows.find((r) => r.key === 'wait')!.cost).toBe(o.waitCostListed);
    expect(rows.find((r) => r.key === 'sell-now')!.costStillApplies).toBe(true);
    expect(rows.find((r) => r.key === 'list')!.costStillApplies).toBe(true);
  });

  it('keeps the cost-free wait line when no listing stands', () => {
    expect(rowFor({}, 'wait').cost).toBe(o.waitCost);
  });

  it('adds the Full-plan line to both sale rows, never the wait row', () => {
    expect(rowFor({ lenderFeeModeFull: true }, 'sell-now').costExtra).toBe(o.costFullTariff);
    expect(rowFor({ lenderFeeModeFull: true }, 'list').costExtra).toBe(o.costFullTariff);
    expect(rowFor({ lenderFeeModeFull: true }, 'wait').costExtra).toBeUndefined();
  });
});

describe('Basic-mode switch action', () => {
  it('offers the switch when some sale row is takeable', () => {
    expect(hasJumpableRow(buildLenderExitRows(base))).toBe(true);
  });

  it('withholds it when the contract refuses both routes', () => {
    const verdict = known([refusal('SaleLoanPastMaturity')], [refusal('SaleLoanPastMaturity')]);
    expect(hasJumpableRow(buildLenderExitRows({ ...base, verdict }))).toBe(false);
  });

  it('withholds it on a deployment that cannot answer', () => {
    expect(hasJumpableRow(buildLenderExitRows({ ...base, verdict: { kind: 'unserved' } }))).toBe(
      false,
    );
  });
});

describe('chooserReadiness — has the jumpability question settled?', () => {
  const ready = (input: Partial<LenderExitInput>) => chooserReadiness({ ...base, ...input });

  it('is ready when the verdict and the tools have answered', () => {
    expect(ready({})).toBe('ready');
  });

  it('is pending while the verdict read is still running, even on a cached answer', () => {
    expect(ready({ verdictSettled: false })).toBe('pending');
    expect(ready({ verdict: { kind: 'checking' } })).toBe('pending');
  });

  it('reports a failed verdict distinctly', () => {
    expect(ready({ verdict: { kind: 'failed' } })).toBe('failed');
  });

  it('is ready on a deployment without the verdict — that is a fact, not a wait', () => {
    expect(ready({ verdict: { kind: 'unserved' }, saleToolsSettled: false })).toBe('ready');
  });

  it('does not wait on the tools when the contract refuses both routes', () => {
    const verdict = known([refusal('LoanNotActive')], [refusal('LoanNotActive')]);
    expect(ready({ verdict, saleToolsSettled: false, saleTools: 'failed' })).toBe('ready');
  });

  it('waits on the tools when a route is open', () => {
    expect(ready({ saleToolsSettled: false })).toBe('pending');
    expect(ready({ saleTools: 'checking' })).toBe('pending');
    expect(ready({ saleTools: 'failed' })).toBe('failed');
    expect(ready({ instantSellCandidates: 'checking' })).toBe('pending');
  });

  it('does not wait on the cadence read, which cannot move a jump', () => {
    expect(ready({ periodicInterestCadence: undefined })).toBe('ready');
  });
});
