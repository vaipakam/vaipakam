import { describe, expect, it } from 'vitest';
import { refScopedKinds } from '@vaipakam/lib/activityRefs';
import { actorAttributedKinds } from '@vaipakam/lib/activityActor';
import { participantKinds } from '@vaipakam/lib/activityParticipants';
import {
  coalesceByTx,
  legText,
  rowValue,
  valueLeg,
  type LegLabels,
  humanizeKind,
  isWalletActivity,
  labelForKind,
  ACTIVITY_LABELS,
  STATUS_EDGE_LABELS,
} from './activityView';
import { copySource } from '../content/copy';
import type { IndexedActivityEvent } from '../data/indexer';

function ev(p: Partial<IndexedActivityEvent>): IndexedActivityEvent {
  return {
    chainId: 84532,
    blockNumber: 1,
    logIndex: 0,
    txHash: '0xtx',
    kind: 'LoanInitiated',
    loanId: null,
    offerId: null,
    actor: null,
    args: {},
    blockAt: 1_700_000_000,
    ...p,
  };
}

describe('humanizeKind', () => {
  it('splits camelCase', () => {
    expect(humanizeKind('LoanRepaid')).toBe('Loan Repaid');
  });
  it('keeps ALL-CAPS acronyms intact (the "Nftminted" bug)', () => {
    expect(humanizeKind('NFTMinted')).toBe('NFT Minted');
    expect(humanizeKind('VPFIDeposited')).toBe('VPFI Deposited');
    expect(humanizeKind('LTVUpdated')).toBe('LTV Updated');
  });
  it('handles a trailing acronym and digits', () => {
    expect(humanizeKind('SwapTo0x')).toContain('Swap');
  });
  it('falls back for empty input', () => {
    expect(humanizeKind('')).toBe('Protocol event');
  });
});

describe('labelForKind', () => {
  it('prefers the mapped label', () => {
    expect(labelForKind('OfferCanceled')).toBe('Offer cancelled');
  });
  it('normalizes the cancelled/canceled spelling drift', () => {
    // Both the offer and signed-offer cancel events read "cancelled".
    expect(ACTIVITY_LABELS.OfferCanceled.label).toContain('cancelled');
    expect(ACTIVITY_LABELS.SignedOfferCancelled.label).toContain('cancelled');
  });
  it('humanizes an unmapped kind', () => {
    expect(labelForKind('SomeNewEvent')).toBe('Some New Event');
  });
  it('maps the internal-match + prepay-listing event family (Codex #1171 r1)', () => {
    // Every kind the indexer's log.eventName handlers emit should have
    // an explicit label, not a title-cased raw name.
    for (const kind of [
      'InternalMatchExecuted',
      'PrepayListingPosted',
      'PrepayListingMatched',
      'PrepayListingUpdated',
      'PrepayListingCanceled',
      'PrepayCollateralSaleSettled',
    ]) {
      expect(ACTIVITY_LABELS[kind]).toBeDefined();
    }
  });
});

describe('activity feed labels are translatable (extraction guard)', () => {
  // The Activity page renders copy.activity.labels[kind] (translatable),
  // falling back to this pure module only for an unmapped kind. If a new
  // event kind is added to ACTIVITY_LABELS but not to the catalog, its
  // row would silently render English in every locale — this guard fails
  // the build instead, mirroring the ACTIVITY_LABELS ↔ catalog contract.
  it('every mapped kind has a matching catalog label', () => {
    const catalog = copySource.activity.labels;
    for (const [kind, meta] of Object.entries(ACTIVITY_LABELS)) {
      expect(catalog[kind], `missing catalog label for ${kind}`).toBe(
        meta.label,
      );
    }
  });

  it('every status-edge label has a matching catalog label, and no stale one', () => {
    const catalog = copySource.activity.statusEdgeLabels;
    for (const [status, meta] of Object.entries(STATUS_EDGE_LABELS)) {
      expect(catalog[status], `missing status-edge catalog label for ${status}`).toBe(meta.label);
    }
    for (const status of Object.keys(catalog)) {
      expect(STATUS_EDGE_LABELS[status], `stale status-edge catalog label for ${status}`).toBeDefined();
    }
  });

  it('the catalog adds no stale label for a kind the module dropped', () => {
    for (const kind of Object.keys(copySource.activity.labels)) {
      expect(ACTIVITY_LABELS[kind], `stale catalog label for ${kind}`).toBeDefined();
    }
  });

  // #2658 / #2703 — the label set covers every kind a wallet's Activity page
  // can receive: one filed under a loan or an offer (the page's loan match),
  // and one naming the wallet as a participant (the participants rule, whose
  // actor is the indexer's `actor` column). Every set is READ from the rule
  // the indexer and the page run, in the shared library
  // (`@vaipakam/lib/activityRefs`, `activityActor`, `activityParticipants`),
  // never re-derived here. A hand list (Codex #1343 r1's) fell forty-odd kinds
  // behind #1794's rule, and a test-side copy of that rule ignored the
  // policy's `extraAliases` (#2702 r1); each missed kind would render a
  // generated English name in every locale.
  it('labels every kind the page can receive for a wallet', () => {
    const refScoped = refScopedKinds();
    const attributed = actorAttributedKinds();
    const parties = participantKinds();
    // Each set must find its long-mapped core, or it is reading nothing.
    expect(refScoped.has('LoanRepaid')).toBe(true);
    expect(refScoped.has('OfferCreated')).toBe(true);
    expect(attributed.has('VPFIDepositedToVault')).toBe(true);
    expect(parties.has('UserVaultCreated')).toBe(true);
    const received = new Set([...refScoped, ...attributed, ...parties]);
    const missing = [...received].filter((k) => !Object.hasOwn(ACTIVITY_LABELS, k)).sort();
    expect(missing, 'event kinds a wallet can receive with no Activity label').toEqual([]);
  });

  // Rows shown only to a flagged wallet follow the sanctions copy rule: the
  // in-app wording only ("while this wallet is flagged"), no list or provider
  // named. `SanctionedProceedsLocked` is not filed under a loan (its number is
  // not always a loan); it reaches the recipient as a participant.
  it('labels the flagged-wallet events with the in-app wording only', () => {
    for (const kind of [
      'SanctionedProceedsLocked',
      'RewardSanctionsHeldApart',
      'StagingClaimantForfeited',
    ]) {
      const label = ACTIVITY_LABELS[kind]?.label ?? '';
      expect(label, kind).toContain('while this wallet is flagged');
    }
    for (const kind of [
      'SanctionedProceedsLocked',
      'RewardSanctionsHeldApart',
      'RewardSanctionsHeldReleased',
      'StagingClaimantForfeited',
    ]) {
      expect(ACTIVITY_LABELS[kind]?.label, kind).not.toMatch(/sanction|OFAC|Chainalysis|RedStone|oracle/i);
      expect(copySource.activity.labels[kind], kind).not.toMatch(/sanction|OFAC|Chainalysis|RedStone|oracle/i);
    }
  });
});

describe('#2703 — a wallet’s rows, by loan or by the participants rule', () => {
  const ME = '0x00000000000000000000000000000000000000aa';
  const OTHER = '0x00000000000000000000000000000000000000bb';
  const loans = new Set([7]);

  it('keeps a row on one of the wallet’s loans, whoever it names', () => {
    expect(isWalletActivity(ev({ kind: 'LoanStatusChanged', loanId: 7, args: {} }), ME, loans)).toBe(true);
  });

  it('keeps a row naming the wallet as a party', () => {
    expect(isWalletActivity(ev({ kind: 'UserVaultCreated', args: { user: ME, proxy: OTHER } }), ME, loans)).toBe(true);
    expect(isWalletActivity(ev({ kind: 'Transfer', args: { from: ME, to: OTHER } }), ME, loans)).toBe(true);
  });

  it('drops a row that only mentions the wallet', () => {
    // An admin event naming the wallet, and an address the event only approves.
    expect(isWalletActivity(ev({ kind: 'RoleGranted', args: { account: ME, sender: OTHER } }), ME, loans)).toBe(false);
    expect(isWalletActivity(ev({ kind: 'Approval', args: { owner: OTHER, approved: ME } }), ME, loans)).toBe(false);
    // The address inside an unrelated string, which the old text match kept.
    expect(isWalletActivity(ev({ kind: 'OfferCreated', args: { creator: OTHER, note: ME } }), ME, loans)).toBe(false);
  });

  it('reads no participant from args the indexer could not parse', () => {
    expect(isWalletActivity(ev({ kind: 'UserVaultCreated', args: `{"user":"${ME}"` }), ME, loans)).toBe(false);
  });
});

describe('coalesceByTx', () => {
  // #2658 — a liquidation whose every swap route failed, with the log sets
  // the two producers emit (#2702 r1). Both reach the shared fallback entry
  // (FallbackCustodyFacet.enterFallback), which emits, in order: the failed
  // route attempts, the custody move, the tier-exclusion sync, the status
  // edge, then LiquidationFallback + LiquidationFallbackSplit (+ the
  // no-price event when the oracle could not price the split). The row is
  // named by the outcome; every step inside it is counted, not shown.
  const FALLBACK_ENTRY = [
    'SwapAdapterAttempted',
    'SwapAllAdaptersFailed',
    'FallbackCustodyMoved',
    'TierExclusionUpdated',
    'LoanStatusChanged',
    'LiquidationFallback',
    'LiquidationFallbackSplit',
  ];
  // The status edge carries its destination, as the indexer stores it.
  const argsOf = (kind: string) =>
    kind === 'LoanStatusChanged' ? { from: 0, to: 4 } : {};
  const rowOf = (kinds: string[]) =>
    coalesceByTx(kinds.map((kind, logIndex) => ev({ kind, logIndex, loanId: 9, args: argsOf(kind) })));

  it('names a failed-sale HF liquidation by its outcome, not its steps', () => {
    // RiskFacet.triggerLiquidation returns straight after the fallback entry:
    // no HFLiquidationTriggered (a successful sale's event) and no
    // LoanFallbackPending (the time-default path's).
    const rows = rowOf(FALLBACK_ENTRY);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Collateral sale failed');
    expect(rows[0].hiddenCount).toBe(FALLBACK_ENTRY.length - 1);
  });

  it('says when the failed sale also had no price for the split', () => {
    const rows = rowOf([...FALLBACK_ENTRY, 'LiquidationFallbackOracleUnavailable']);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Collateral sale failed: no price available');
  });

  it('names a failed-sale time default by the pending settlement', () => {
    // DefaultedFacet emits LoanFallbackPending after the same entry.
    const rows = rowOf([...FALLBACK_ENTRY, 'LoanFallbackPending']);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Settlement pending after a failed sale');
    expect(rows[0].hiddenCount).toBe(FALLBACK_ENTRY.length);
  });

  // #2702 r2 — a status edge into an end state is named by its destination
  // when nothing else in the transaction names the outcome.
  const edge = (to: number | string, logIndex = 0) =>
    ev({ kind: 'LoanStatusChanged', logIndex, loanId: 5, args: { from: 0, to } });

  it('names the last rental deduction by the repayment it completes', () => {
    const rows = coalesceByTx([edge(1, 0), ev({ kind: 'AutoDailyDeducted', logIndex: 1, loanId: 5 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Loan repaid');
    expect(rows[0].labelSource).toEqual({ catalog: 'statusEdgeLabels', key: 'Repaid' });
    expect(rows[0].category).toBe('loan-repay');
  });

  it('reads the destination whether the indexer stored a number or a numeric string', () => {
    expect(coalesceByTx([edge('2')])[0].label).toBe('Loan defaulted');
    expect(coalesceByTx([edge(5)])[0].label).toBe('Loan closed by internal matching');
  });

  it('leaves the row to an event that names the outcome itself', () => {
    const repay = coalesceByTx([edge(1, 0), ev({ kind: 'LoanRepaid', logIndex: 1, loanId: 5 })]);
    expect(repay[0].label).toBe('Loan repaid');
    expect(repay[0].labelSource).toEqual({ catalog: 'labels', key: 'LoanRepaid' });
    const claim = coalesceByTx([
      ev({ kind: 'BorrowerFundsClaimed', logIndex: 0, loanId: 5 }),
      ev({ kind: 'LoanStatusChanged', logIndex: 1, loanId: 5, args: { from: 1, to: 3 } }),
    ]);
    expect(claim[0].label).toBe('Collateral claimed');
  });

  it('keeps the generic name for an edge back to Active, or an unreadable one', () => {
    expect(coalesceByTx([edge(0)])[0].label).toBe('Loan status updated');
    expect(coalesceByTx([edge('x')])[0].label).toBe('Loan status updated');
    expect(coalesceByTx([edge(99)])[0].labelSource).toEqual({ catalog: 'labels', key: 'LoanStatusChanged' });
  });

  it('collapses one transaction to its highest-priority event', () => {
    // A loan-start tx emits LoanInitiated (90) + LoanInitiatedDetails
    // (10) + Transfer (5): one row, labelled by the real action.
    const rows = coalesceByTx([
      ev({ kind: 'Transfer', logIndex: 2 }),
      ev({ kind: 'LoanInitiatedDetails', logIndex: 1 }),
      ev({ kind: 'LoanInitiated', logIndex: 0, loanId: 7 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Loan started');
    expect(rows[0].event.loanId).toBe(7);
    expect(rows[0].hiddenCount).toBe(2);
  });

  // #2708 r1 — a wallet's first offer creates its vault lazily, before the
  // offer's own event: the offer represents the row, not the vault.
  it('names a first offer by the offer, not the vault created inside it', () => {
    const rows = coalesceByTx([
      ev({ kind: 'UserVaultCreated', logIndex: 0 }),
      ev({ kind: 'OfferCreated', logIndex: 1, offerId: 3 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Offer created');
    expect(rows[0].event.offerId).toBe(3);
  });

  // #2708 r1 — a share set apart for a flagged wallet also emits the generic
  // delivery event (venue: the held balance); the row says it was set aside.
  it('names a set-apart reward share by the set-aside, not the delivery', () => {
    const rows = coalesceByTx([
      ev({ kind: 'RewardSanctionsHeldApart', logIndex: 0 }),
      ev({ kind: 'StagingDelivered', logIndex: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Rewards set aside while this wallet is flagged');
  });

  // #2374 / #2426 r4 — the owed-at-default record never represents a
  // transaction: a default or fallback entry is labelled by the default (or
  // by the status change, as before the record existed).
  it('never lets the owed-at-default record represent the transaction', () => {
    for (const lead of ['LoanDefaulted', 'LoanLiquidated', 'LoanStatusChanged']) {
      const rows = coalesceByTx([
        ev({ kind: 'OwedAtDefaultRecorded', logIndex: 0, loanId: 7 }),
        ev({ kind: lead, logIndex: 1, loanId: 7 }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].event.kind).toBe(lead);
      expect(rows[0].hiddenCount).toBe(1);
    }
  });

  it('never lets the internal-match record represent the transaction', () => {
    for (const lead of ['InternalMatchExecuted', 'LoanStatusChanged']) {
      const rows = coalesceByTx([
        ev({ kind: 'OwedAtInternalMatchRecorded', logIndex: 0, loanId: 7 }),
        ev({ kind: lead, logIndex: 1, loanId: 7 }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].event.kind).toBe(lead);
      expect(rows[0].hiddenCount).toBe(1);
    }
  });

  it('keeps events from different transactions separate', () => {
    const rows = coalesceByTx([
      ev({ txHash: '0xa', kind: 'OfferCreated', blockNumber: 2 }),
      ev({ txHash: '0xb', kind: 'LoanRepaid', blockNumber: 3 }),
    ]);
    expect(rows).toHaveLength(2);
    // Newest (higher block) first.
    expect(rows[0].event.blockNumber).toBe(3);
    expect(rows[1].event.blockNumber).toBe(2);
  });

  it('breaks priority ties by earliest logIndex', () => {
    const rows = coalesceByTx([
      ev({ kind: 'OfferMatched', logIndex: 3 }),
      ev({ kind: 'OfferAccepted', logIndex: 1 }), // same priority (80)
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event.logIndex).toBe(1);
  });

  it('never merges events that lack a txHash', () => {
    const rows = coalesceByTx([
      ev({ txHash: '', kind: 'LoanRepaid', logIndex: 0, blockNumber: 5 }),
      ev({ txHash: '', kind: 'LoanRepaid', logIndex: 1, blockNumber: 5 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('lets a claim outrank the LoanSettled in the same tx (Codex #1171 r2)', () => {
    // ClaimFacet emits {Lender,Borrower}FundsClaimed THEN LoanSettled in
    // one transaction; the indexer inserts both. The user's own claim,
    // not the book-keeping settle, must be the representative row.
    const lender = coalesceByTx([
      ev({ kind: 'LoanSettled', logIndex: 1, loanId: 4 }),
      ev({ kind: 'LenderFundsClaimed', logIndex: 0, loanId: 4 }),
    ]);
    expect(lender).toHaveLength(1);
    expect(lender[0].label).toBe('Funds claimed');
    expect(lender[0].hiddenCount).toBe(1);

    const borrower = coalesceByTx([
      ev({ kind: 'LoanSettled', logIndex: 1, loanId: 9 }),
      ev({ kind: 'BorrowerFundsClaimed', logIndex: 0, loanId: 9 }),
    ]);
    expect(borrower).toHaveLength(1);
    expect(borrower[0].label).toBe('Collateral claimed');
  });
});

describe('#2383 — the row’s value, from the indexer’s normalized fields only', () => {
  const USDC = '0x00000000000000000000000000000000000000a1';
  const WETH = '0x00000000000000000000000000000000000000a2';
  const NFT = '0x00000000000000000000000000000000000000b1';
  const ready = { status: 'ready' as const, decimals: 6, symbol: 'USDC' };
  const labels: LegLabels = {
    loading: (t) => `LOADING ${t}`,
    unreadable: (a, t) => `RAW ${a} OF ${t}`,
    quantityUnknown: 'QTY?',
  };
  const text = (p: Partial<IndexedActivityEvent>, m: Parameters<typeof legText>[1] = ready) => {
    const leg = valueLeg(ev(p));
    return leg ? legText(leg, m, labels) : null;
  };

  it('states an exact token amount WITH the contract beside the symbol', () => {
    // Two contracts can both call themselves USDC; the address tells them apart.
    expect(text({ asset: USDC, assetType: 0, amount: '1500000' })).toBe('1.5 USDC (0x0000…00a1)');
  });
  it('states a range as X–Y', () => {
    expect(text({ asset: USDC, assetType: 0, amount: '500000', amountMax: '2000000' })).toBe(
      '0.5–2 USDC (0x0000…00a1)',
    );
  });
  it('says the amount is loading — a known amount is never silently dropped', () => {
    expect(text({ asset: USDC, assetType: 0, amount: '1500000' }, { status: 'loading' })).toBe(
      'LOADING 0x0000…00a1',
    );
  });
  it('names raw base units AS base units when the token cannot be read', () => {
    expect(text({ asset: USDC, assetType: 0, amount: '1500000' }, { status: 'unreadable' })).toBe(
      'RAW 1500000 OF 0x0000…00a1',
    );
    expect(
      text({ asset: USDC, assetType: 0, amount: '5', amountMax: '9' }, { status: 'unreadable' }),
    ).toBe('RAW 5–9 OF 0x0000…00a1');
  });
  it('names an ERC-721 by token id, with no amount or copies', () => {
    expect(text({ asset: NFT, assetType: 1, tokenId: '42', quantity: '5' })).toBe('NFT 0x0000…00b1 #42');
  });
  it('states an ERC-1155’s copies — one and a hundred are different positions', () => {
    expect(text({ asset: NFT, assetType: 2, tokenId: '42', quantity: '100' })).toBe('100 × NFT 0x0000…00b1 #42');
    expect(text({ asset: NFT, assetType: 2, tokenId: '42', quantity: null })).toBe('NFT 0x0000…00b1 #42 (QTY?)');
    // Zero is the "not applicable" default, never "0 copies".
    expect(text({ asset: NFT, assetType: 2, tokenId: '42', quantity: '0' })).toBe('NFT 0x0000…00b1 #42 (QTY?)');
  });
  it('states nothing the indexer did not establish — and never reads args', () => {
    // Unknown type, no fields at all (an older indexer), and an amount in
    // the args bag the row does not carry: all nothing.
    expect(text({ asset: USDC, assetType: null, amount: '1' })).toBeNull();
    expect(text({})).toBeNull();
    expect(text({ args: { amount: '1000000', asset: USDC } })).toBeNull();
  });

  describe('a row states EVERY leg of its action (#2383 r1)', () => {
    const tx = (events: Partial<IndexedActivityEvent>[]) =>
      coalesceByTx(events.map((e, i) => ev({ logIndex: i, ...e })));

    it('a borrower claim paying collateral AND a frozen surplus states both', () => {
      const [row] = tx([
        { kind: 'BorrowerSurplusClaimed', loanId: 5, asset: USDC, assetType: 0, amount: '100' },
        { kind: 'BorrowerFundsClaimed', loanId: 5, asset: WETH, assetType: 0, amount: '100' },
        { kind: 'LoanSettled', loanId: 5 },
      ]);
      expect(row.label).toBe('Collateral claimed');
      const v = rowValue(row);
      // Same amount, different assets AND different lanes: two legs, not one.
      expect(v.legs.map((l) => l.asset)).toEqual([USDC, WETH]);
      expect(v.unstated).toBe(false);
    });

    it('a companion pair states its value once', () => {
      const [row] = tx([
        { kind: 'LoanInitiated', loanId: 5, asset: USDC, assetType: 0, amount: '7' },
        { kind: 'LoanInitiatedDetails', loanId: 5, asset: USDC, assetType: 0, amount: '7' },
        { kind: 'OfferAccepted', loanId: 5, offerId: 3, asset: USDC, assetType: 0, amount: '7' },
      ]);
      expect(rowValue(row).legs).toHaveLength(1);
    });

    it('a companion without the value does not hide the one that has it', () => {
      // Emission order must not decide: the first event of the fill lacks a
      // value, the second carries it.
      const [row] = tx([
        { kind: 'OfferAccepted', loanId: 5, offerId: 3 },
        { kind: 'LoanInitiated', loanId: 5, asset: USDC, assetType: 0, amount: '7' },
      ]);
      expect(rowValue(row)).toMatchObject({ unstated: false });
      expect(rowValue(row).legs).toHaveLength(1);
    });

    it('says an unitemised rebate exists rather than dropping it', () => {
      const [row] = tx([
        { kind: 'BorrowerFundsClaimed', loanId: 5, asset: WETH, assetType: 0, amount: '9' },
        { kind: 'BorrowerLifRebateClaimed', loanId: 5 },
      ]);
      const v = rowValue(row);
      expect(v.legs).toHaveLength(1);
      expect(v.unstated).toBe(true);
    });

    it('a value row the indexer could not state says so', () => {
      const [row] = tx([{ kind: 'LoanInitiated', loanId: 5 }]);
      expect(rowValue(row)).toEqual({ legs: [], unstated: true, mayIncludeHeldForLender: false });
    });

    it('a row with no value kind states nothing about value', () => {
      const [row] = tx([{ kind: 'LoanRepaid', loanId: 5 }]);
      expect(rowValue(row)).toEqual({ legs: [], unstated: false, mayIncludeHeldForLender: false });
    });

    it('a lender claim discloses that held funds are paid out with it', () => {
      const [row] = tx([
        { kind: 'LenderFundsClaimed', loanId: 5, asset: USDC, assetType: 0, amount: '1100' },
        { kind: 'LoanSettled', loanId: 5 },
      ]);
      expect(rowValue(row).mayIncludeHeldForLender).toBe(true);
    });

    it('never borrows a neighbouring loan’s value in a multicall', () => {
      const [row] = tx([
        { kind: 'LoanInitiated', loanId: 5, asset: USDC, assetType: 0, amount: '1' },
        { kind: 'LoanInitiated', loanId: 6, asset: WETH, assetType: 0, amount: '2' },
        { kind: 'CollateralAdded', loanId: 7, asset: WETH, assetType: 0, amount: '3' },
      ]);
      expect(rowValue(row).legs.map((l) => l.asset)).toEqual([USDC]);
    });
  });
});
