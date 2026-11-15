import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, erc20Abi, parseAbi, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClaimFacetABI, DIAMOND_ABI_VIEM, VaultOutflowFacetABI } from '@vaipakam/contracts/abis';
import type { LoanDetails } from '../positions/loanView';
import {
  batchCalls,
  claimAllGasLimit,
  batchOf,
  batchStop,
  CLAIM_ALL_MAX_CALLS,
  claimAllBlockers,
  claimAllChanged,
  claimAllList,
  claimAllReceipt,
  defaultPicked,
  legResults,
  measureClaimAll,
  optInText,
  payoutLabel,
  type ClaimAllInputs,
  type ClaimAllLeg,
  type ClaimAllReview,
  type ClaimAllWords,
} from './claimAll';
import type { LoanClaimRow } from './loanClaimRows';
import { remainderAfter } from './rewards';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000aa' as Hex;
const OTHER = '0x00000000000000000000000000000000000000bb' as Hex;
const MY_VAULT = '0x00000000000000000000000000000000000000cc' as Hex;
const WETH = '0x00000000000000000000000000000000000000e1' as Hex;
const TLIQ = '0x00000000000000000000000000000000000000e2' as Hex;
const VPFI = '0x00000000000000000000000000000000000000e3' as Hex;
const REPAID = 1;
const FALLBACK = 4;
const ACTIVE = 0;

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;
const words: ClaimAllWords = { amount: (_a, v) => `${v}`, exact: (_a, v) => `${v}`, symbol: (a) => a.slice(-2), nft: () => 'nft' };

function loanRow(loanId: bigint, over: Partial<LoanClaimRow> = {}, status = REPAID): LoanClaimRow {
  return {
    loanId,
    side: 'lender',
    listed: true,
    loan: { status, assetType: 0, principalAsset: WETH, collateralAsset: TLIQ, lender: ME, borrower: OTHER, lenderTokenId: 1n, borrowerTokenId: 2n } as unknown as LoanDetails,
    holder: ME,
    claim: { asset: WETH, amount: 100n, claimed: false, assetType: 0, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNftReturn: false, surplus: null, liened: null },
    lanes: [{ kind: 'row', asset: WETH, assetType: 0, tokenId: 0n, amount: 100n }],
    ...over,
  };
}

function inputs(over: Partial<ClaimAllInputs> = {}): ClaimAllInputs {
  return {
    account: ME,
    paused: false,
    frozen: null,
    protection: { enabled: false } as never,
    loans: { paused: false, rows: [loanRow(7n)], complete: true },
    rewards: { kind: 'none' },
    held: { held: 0n, decision: 'deliver' },
    vpfiToken: VPFI,
    intents: { rows: [], complete: true },
    vpfiFree: 0n,
    payroll: { rows: [], complete: true },
    ...over,
  };
}

const keys = (legs: ClaimAllLeg[]) => legs.map((l) => l.key);

describe('the Claim everything list', () => {
  it('lists a loan side the claim’s rule opens, and leaves out one it refuses', () => {
    const list = claimAllList(inputs({ loans: { paused: false, rows: [loanRow(7n), loanRow(8n, {}, ACTIVE), loanRow(9n, { holder: OTHER })], complete: true } }), copy, 1);
    expect(keys(list.legs)).toEqual(['loan:lender:7']);
    expect(list.gaps).toEqual([]);
  });

  it('names a loan that could not be read, and collects a lender claim in fallback on its own', () => {
    const list = claimAllList(inputs({ loans: { paused: false, rows: [loanRow(7n, { claim: null }), loanRow(8n, {}, FALLBACK)], complete: false } }), copy, 1);
    expect(list.legs).toEqual([]);
    expect(list.gaps.map((g) => `${g.kind}:${g.why}:${g.loanId ?? ''}`)).toEqual(['loan:partial:', 'loan:unread:7', 'loan:own:8']);
  });

  it('takes the rewards claim when its preview completes, and a released held reward only when it does not', () => {
    const exact = claimAllList(inputs({ rewards: { kind: 'exact', amount: 5n, fromDay: 1n, toDay: 2n, atBlock: 10n }, held: { held: 3n, decision: 'deliver' } }), copy, 1);
    expect(keys(exact.legs)).toEqual(['loan:lender:7', 'rewards']);
    expect(exact.legs[1]!.route).toBe('reward-vault');
    const held = claimAllList(inputs({ rewards: { kind: 'waiting', day: 3n, why: 'global', atBlock: 1n }, held: { held: 3n, decision: 'deliver' } }), copy, 1);
    expect(keys(held.legs)).toEqual(['loan:lender:7', 'held']);
    // A flag still under observation: the held reward is not released.
    expect(keys(claimAllList(inputs({ held: { held: 3n, decision: 'hold' } }), copy, 1).legs)).toEqual(['loan:lender:7']);
  });

  it('turns on a paused standing offer’s capital and leaves free vault VPFI and a running offer’s capital off', () => {
    const list = claimAllList(
      inputs({
        intents: {
          rows: [
            { lendingAsset: WETH, collateralAsset: TLIQ, available: 40n, active: false },
            { lendingAsset: TLIQ, collateralAsset: WETH, available: 9n, active: true },
            { lendingAsset: WETH, collateralAsset: VPFI, available: 0n, active: false },
          ],
          complete: true,
        },
        vpfiFree: 70n,
        payroll: { rows: [{ streamId: 2n, asset: WETH, withdrawable: 6n }], complete: true },
      }),
      copy,
      1,
    );
    expect(keys(list.legs)).toEqual(['loan:lender:7', `intent:${WETH}:${TLIQ}`, `intent:${TLIQ}:${WETH}`, 'vpfi', 'payroll:2']);
    expect([...defaultPicked(list.legs)]).toEqual(['loan:lender:7', `intent:${WETH}:${TLIQ}`, 'payroll:2']);
  });

  it('offers a rewards claim whose preview completes paying nothing, since it walks days to reach later paying ones', () => {
    const list = claimAllList(inputs({ rewards: { kind: 'exact', amount: 0n, fromDay: 3n, toDay: 9n, atBlock: 10n } }), copy, 1);
    const rewards = list.legs.find((l) => l.key === 'rewards')!;
    expect(rewards.payouts[0]!.amount).toBe(0n);
    expect(payoutLabel(rewards, rewards.payouts[0]!, copy)).toBe('rewards.pendingZero{"from":"3","to":"9"}');
  });

  it('leaves out, and says so, a rewards claim that pays nothing and only moves on to the next part of the entries (#1787)', () => {
    const list = claimAllList(
      inputs({ rewards: { kind: 'exact', amount: 0n, fromDay: 0n, toDay: 0n, atBlock: 10n, window: { from: 0n, to: 128n, total: 200n } } }),
      copy,
      1,
    );
    expect(list.legs.find((l) => l.key === 'rewards')).toBeUndefined();
    expect(list.gaps).toContainEqual({ kind: 'rewards', why: 'partial' });
  });

  it('keeps a standing offer’s capital off, and says why, when the VPFI token could not be read', () => {
    const list = claimAllList(
      inputs({ vpfiToken: null, intents: { rows: [{ lendingAsset: WETH, collateralAsset: TLIQ, available: 9n, active: false }], complete: true } }),
      copy,
      1,
    );
    const intent = list.legs.find((l) => l.subject.kind === 'intent')!;
    expect(intent.optIn).toBe(true);
    expect(optInText(intent, copy)).toBe('claimAll.tierUnknownOptIn');
    const consequences = claimAllReceipt(review([intent]), copy, { symbol: words.symbol, nft: words.nft }).consequences;
    expect(consequences).toContain('claimAll.tierUnknown');
    expect(consequences).not.toContain('claimAll.vpfiTier');
  });

  it('still offers a released held reward when the rewards preview could not be read', () => {
    const list = claimAllList(inputs({ rewards: null, held: { held: 3n, decision: 'deliver' } }), copy, 1);
    expect(keys(list.legs)).toEqual(['loan:lender:7', 'held']);
    expect(list.gaps.map((g) => `${g.kind}:${g.why}`)).toEqual(['rewards:unread']);
  });

  it('leaves a VPFI standing offer’s capital off, since it counts toward the fee-discount tier, and says so', () => {
    const list = claimAllList(inputs({ intents: { rows: [{ lendingAsset: VPFI, collateralAsset: WETH, available: 9n, active: false }], complete: true } }), copy, 1);
    const intent = list.legs.find((l) => l.subject.kind === 'intent')!;
    expect(intent.optIn).toBe(true);
    expect(optInText(intent, copy)).toBe('claimAll.vpfiOptIn');
    expect(claimAllReceipt(review([intent]), copy, { symbol: words.symbol, nft: words.nft }).consequences).toContain('claimAll.vpfiTier');
  });

  it('names every source that could not be read as left out, never empty', () => {
    const list = claimAllList(inputs({ loans: null, rewards: null, intents: null, vpfiFree: null, payroll: null }), copy, 1);
    expect(list.legs).toEqual([]);
    expect(list.gaps.map((g) => g.kind)).toEqual(['loan', 'rewards', 'intent', 'vpfi', 'payroll']);
  });

  it('stops the whole batch for the pause, then for a flagged wallet, and says an unread pause', () => {
    expect(batchStop({ paused: null, frozen: null }, copy)?.code).toBe('Unread');
    expect(batchStop({ paused: true, frozen: 'flagged' }, copy)?.code).toBe('EnforcedPause');
    expect(batchStop({ paused: false, frozen: 'flagged' }, copy)?.code).toBe('SanctionedAddress');
    // An outage is the dry run's to decide, payout by payout.
    expect(batchStop({ paused: false, frozen: 'outage' }, copy)).toBeNull();
  });
});

describe('the batch', () => {
  it('sends at most the protocol’s bound, in list order, and leaves the rest for a second batch', () => {
    const many = claimAllList(inputs({ loans: { paused: false, rows: Array.from({ length: 33 }, (_, n) => loanRow(BigInt(n + 1))), complete: true } }), copy, 1);
    const picked = defaultPicked(many.legs);
    picked.delete('loan:lender:2');
    const { now, later } = batchOf(many.legs, picked);
    expect(now).toHaveLength(CLAIM_ALL_MAX_CALLS);
    expect(now[1]!.key).toBe('loan:lender:3');
    expect(keys(later)).toEqual(['loan:lender:32', 'loan:lender:33']);
  });

  it('encodes each payout as the call it makes alone, each allowed to fail', () => {
    const list = claimAllList(
      inputs({
        rewards: { kind: 'exact', amount: 5n, fromDay: 1n, toDay: 2n, atBlock: 10n },
        intents: { rows: [{ lendingAsset: WETH, collateralAsset: TLIQ, available: 40n, active: false }], complete: true },
        vpfiFree: 70n,
        payroll: { rows: [{ streamId: 2n, asset: WETH, withdrawable: 6n }], complete: true },
      }),
      copy,
      1,
    );
    const calls = batchCalls(list.legs, ME);
    expect(calls.every((c) => c.allowFailure)).toBe(true);
    const decoded = calls.map((c) => decodeFunctionData({ abi: DIAMOND_ABI_VIEM as Abi, data: c.callData }));
    expect(decoded.map((d) => d.functionName)).toEqual(['claimAsLender', 'claimInteractionRewardsTo', 'withdrawLenderIntentCapital', 'withdrawVPFIFromVault', 'withdrawSalary']);
    expect((decoded[2]!.args as readonly unknown[]).map((a) => (typeof a === 'string' ? a.toLowerCase() : a))).toEqual([ME, WETH, TLIQ, 40n]);
    expect(decoded[3]!.args).toEqual([70n]);
    // The gas limit is sized on the same calls each required to succeed.
    const required = batchCalls(list.legs, ME, false);
    expect(required.every((c) => !c.allowFailure)).toBe(true);
    expect(required.map((c) => c.callData)).toEqual(calls.map((c) => c.callData));
    expect(claimAllGasLimit(100_000n)).toBe(130_000n);
    expect(claimAllGasLimit(1n)).toBe(2n);
  });

  it('reads each payout’s dry run: a pass, or the protocol’s named refusal', () => {
    const list = claimAllList(inputs({ loans: { paused: false, rows: [loanRow(7n), loanRow(8n)], complete: true } }), copy, 1);
    const refused = encodeErrorResult({ abi: DIAMOND_ABI_VIEM as Abi, errorName: 'EnforcedPause' });
    const results = legResults(list.legs, [
      { success: true, returnData: '0x' },
      { success: false, returnData: refused },
    ]);
    expect(results.get('loan:lender:7')).toBeNull();
    expect(results.get('loan:lender:8')?.code).toBe('EnforcedPause');
  });
});

const LEG_EVENTS = parseAbi([
  'event LenderIntentCapitalWithdrawn(address indexed owner, address indexed lendingAsset, address indexed collateralAsset, uint256 amount, uint256 remainingCapital)',
  'event InteractionRewardsClaimed(address indexed user, uint256 fromDay, uint256 toDay, uint256 amount)',
  'event RewardDeliveredToVault(address indexed user, uint256 amount, uint256 claimDayId)',
]) as Abi;

function log(address: Hex, abi: Abi, eventName: string, args: Record<string, unknown>): Log {
  const event = abi.find((e) => e.type === 'event' && e.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const plain = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      plain,
      plain.map((i) => args[i.name]),
    ),
  } as unknown as Log;
}
const transfer = (token: Hex, value: bigint) => log(token, erc20Abi as Abi, 'Transfer', { from: OTHER, to: ME, value });
// A loan claim's payout: the protocol's record of it moving into the
// claimant's vault (class 2, a position holder's payout).
const credit = (ref: bigint, asset: Hex, delivered: bigint, tokenId = 0n) =>
  log(DIAMOND, VaultOutflowFacetABI as Abi, 'VaultOutflow', { owner: OTHER, vault: OTHER, asset, tokenId, amount: delivered, delivered, to: MY_VAULT, class_: 2, reason: 1, ref });
const claimed = (loanId: bigint, amount: bigint) => log(DIAMOND, ClaimFacetABI as Abi, 'LenderFundsClaimed', { loanId, claimant: ME, asset: WETH, amount, newBothClaimed: false });

function review(send: ClaimAllLeg[], over: Partial<ClaimAllReview> = {}): ClaimAllReview {
  const list = claimAllList(inputs(), copy, 1);
  return { identity: '1:0xaa', list, picked: send.map((l) => l.key), send, refused: [], later: [], dryRun: null, readAt: 1, ...over };
}

describe('the finish card', () => {
  const list = claimAllList(
    inputs({
      loans: { paused: false, rows: [loanRow(7n), loanRow(8n)], complete: true },
      rewards: { kind: 'exact', amount: 5n, fromDay: 1n, toDay: 2n, atBlock: 10n },
      intents: { rows: [{ lendingAsset: WETH, collateralAsset: TLIQ, available: 40n, active: false }], complete: true },
    }),
    copy,
    1,
  );

  it('reports each payout collected or skipped, and each token measured where it landed against what the collected ones recorded', () => {
    const r = review(list.legs);
    const logs = [
      claimed(7n, 100n),
      credit(7n, WETH, 100n),
      log(DIAMOND, LEG_EVENTS, 'RewardDeliveredToVault', { user: ME, amount: 5n, claimDayId: 3n }),
      log(DIAMOND, LEG_EVENTS, 'InteractionRewardsClaimed', { user: ME, fromDay: 1n, toDay: 2n, amount: 5n }),
      log(DIAMOND, LEG_EVENTS, 'LenderIntentCapitalWithdrawn', { owner: ME, lendingAsset: WETH, collateralAsset: TLIQ, amount: 40n, remainingCapital: 0n }),
      transfer(WETH, 40n),
    ];
    const legs = measureClaimAll(r, logs, DIAMOND, ME, MY_VAULT, words, copy, true);
    expect(legs.map((l) => `${l.status}:${l.label}`)).toEqual([
      'done:claimAll.legCollected{"what":"claimAll.loanLender{\\"id\\":\\"7\\"}"}',
      'not-done:claimAll.loanLender{"id":"8"}',
      'done:claimAll.legRewards{"what":"claimAll.rewards","amount":"5"}',
      'done:claimAll.legRewardsMore',
      `done:claimAll.legCollected{"what":"claimAll.intent{\\"lend\\":\\"e1\\",\\"collateral\\":\\"e2\\"}"}`,
      'done:payout.legCredit{"what":"100"}',
      'done:loanClaim.legArrived{"amount":"40"}',
    ]);
    expect(legs[1]!.status === 'not-done' && legs[1]!.reason).toBe('claimAll.skipped');
  });

  it('says when whether more reward days remain could not be read after the claim', () => {
    const rewards = list.legs.find((l) => l.key === 'rewards')!;
    const logs = [
      log(DIAMOND, LEG_EVENTS, 'RewardDeliveredToVault', { user: ME, amount: 5n, claimDayId: 3n }),
      log(DIAMOND, LEG_EVENTS, 'InteractionRewardsClaimed', { user: ME, fromDay: 1n, toDay: 2n, amount: 5n }),
    ];
    const legs = measureClaimAll(review([rewards]), logs, DIAMOND, ME, MY_VAULT, words, copy, null);
    expect(legs.map((l) => `${l.status}:${l.label}`)).toEqual(['done:claimAll.legRewards{"what":"claimAll.rewards","amount":"5"}', 'unknown:claimAll.legRewardsRest']);
    expect(measureClaimAll(review([rewards]), logs, DIAMOND, ME, MY_VAULT, words, copy, false).map((l) => l.status)).toEqual(['done']);
    expect(remainderAfter(null, 10n)).toBeNull();
    expect(remainderAfter({ kind: 'none' }, 10n)).toBe(false);
    expect(remainderAfter({ kind: 'exact', amount: 1n, fromDay: 3n, toDay: 4n, atBlock: 9n }, 10n)).toBeNull();
    expect(remainderAfter({ kind: 'exact', amount: 1n, fromDay: 3n, toDay: 4n, atBlock: 10n }, 10n)).toBe(true);
  });

  it('flags a token that did not all arrive', () => {
    const legs = measureClaimAll(review(list.legs.slice(0, 1)), [claimed(7n, 100n), credit(7n, WETH, 60n)], DIAMOND, ME, MY_VAULT, words, copy, null);
    expect(legs.at(-1)!.status).toBe('unknown');
  });

  it('states left-out payouts, the remainder and the opt-in consequences in the receipt', () => {
    const vpfi = claimAllList(inputs({ vpfiFree: 70n }), copy, 1).legs.find((l) => l.key === 'vpfi')!;
    const r = review([list.legs[0]!, vpfi], {
      refused: [{ leg: list.legs[1]!, refusal: { code: 'NothingToClaim', reason: 'nothing', reopensAt: null, remedy: null } }],
      later: [list.legs[2]!],
    });
    const receipt = claimAllReceipt(r, copy, { symbol: words.symbol, nft: words.nft });
    expect(receipt.title).toBe('claimAll.title{"n":"2"}');
    expect(receipt.consequences).toContain('claimAll.vpfiTier');
    expect(receipt.consequences).toContain('claimAll.leftOut{"what":"claimAll.loanLender{\\"id\\":\\"8\\"}","reason":"nothing"}');
    expect(receipt.consequences).toContain('claimAll.remainder{"n":"1","max":"30"}');
    expect(receipt.prompts).toBe(1);
  });

  it('credits a loan claim to the vault whatever the protected mode, and reads a queued payout’s new delay or secondary signer as a changed review', () => {
    const guard = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
    const intents = { rows: [{ lendingAsset: WETH, collateralAsset: TLIQ, available: 40n, active: false }], complete: true };
    const a = claimAllList(inputs({ protection: guard, intents }), copy, 1);
    expect(a.legs.map((l) => l.route)).toEqual(['credit', 'queued']);
    expect(claimAllList(inputs({ protection: null }), copy, 1).legs[0]!.route).toBe('credit');
    const b = claimAllList(inputs({ protection: { ...guard, delaySeconds: 7200 }, intents }), copy, 1);
    const c = claimAllList(inputs({ protection: { ...guard, requireCosign: true }, intents }), copy, 1);
    const at = (l: typeof a) => review(l.legs, { list: l });
    expect(claimAllChanged(at(a), at(a), copy)).toBeNull();
    expect(claimAllChanged(at(a), at(b), copy)).toBe('claimAll.changed');
    expect(claimAllChanged(at(a), at(c), copy)).toBe('claimAll.changed');
  });

  it('states each destination in full when payouts land in different places', () => {
    const guard = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
    const l = claimAllList(inputs({ protection: guard, payroll: { rows: [{ streamId: 2n, asset: WETH, withdrawable: 6n }], complete: true } }), copy, 1);
    // A loan claim is credited to the vault; a protected payee's payroll is
    // paid into its vault.
    expect(l.legs.map((x) => x.route)).toEqual(['credit', 'vault']);
    const rows = claimAllReceipt(review(l.legs, { list: l }), copy, { symbol: words.symbol, nft: words.nft }).rows.filter((x) => x.label.startsWith('claimAll.rowToFor'));
    expect(rows.map((x) => x.label)).toEqual([
      'claimAll.rowToFor{"what":"claimAll.loanLender{\\"id\\":\\"7\\"}"}',
      'claimAll.rowToFor{"what":"claimAll.payroll{\\"id\\":\\"2\\"}"}',
    ]);
    expect(rows[0]!.value).toEqual({ kind: 'text', text: 'payout.toCredit' });
    expect(rows[1]!.value).toEqual({ kind: 'text', text: 'payout.toVault' });
    expect(claimAllList(inputs({ protection: null, payroll: { rows: [{ streamId: 2n, asset: WETH, withdrawable: 6n }], complete: true } }), copy, 1).legs.at(-1)!.route).toBe(
      'unknown',
    );
  });

  it('lets a payroll stream’s accrual through the recheck, and reads a lower figure as a change', () => {
    const pay = (withdrawable: bigint) =>
      claimAllList(inputs({ loans: { paused: false, rows: [], complete: true }, payroll: { rows: [{ streamId: 2n, asset: WETH, withdrawable }], complete: true } }), copy, 1);
    const at = (l: ReturnType<typeof pay>) => review(l.legs, { list: l });
    expect(claimAllChanged(at(pay(6n)), at(pay(9n)), copy)).toBeNull();
    expect(claimAllChanged(at(pay(6n)), at(pay(5n)), copy)).toBe('claimAll.changed');
    expect(payoutLabel(pay(6n).legs[0]!, pay(6n).legs[0]!.payouts[0]!, copy)).toBe('claimAll.payrollAtLeast');
  });

  it('measures one ERC-1155 token paid by two loans once, each destination with its own quantity', () => {
    const NFT = '0x00000000000000000000000000000000000000f2' as Hex;
    const lane = { kind: 'rentalReturn' as const, asset: NFT, assetType: 2, tokenId: 5n };
    const guard = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
    const l = claimAllList(
      inputs({
        protection: guard,
        loans: { paused: false, rows: [loanRow(7n, { lanes: [{ ...lane, amount: 5n }] }), loanRow(8n, { lanes: [{ ...lane, amount: 2n }] })], complete: true },
      }),
      copy,
      1,
    );
    const logs = [claimed(7n, 0n), claimed(8n, 0n), credit(7n, NFT, 5n, 5n), credit(8n, NFT, 2n, 5n)];
    const w = { ...words, nft: (p: { amount: bigint }) => `${p.amount} units` };
    const nft = measureClaimAll(review(l.legs, { list: l }), logs, DIAMOND, ME, MY_VAULT, w, copy, null)
      .map((x) => `${x.status}:${x.label}`)
      .filter((x) => x.includes('units'));
    expect(nft).toEqual(['done:payout.legCredit{"what":"7 units"}']);
    // Short of what the two loans promised: said, never read as done.
    const short = measureClaimAll(review(l.legs, { list: l }), logs.slice(0, 3), DIAMOND, ME, MY_VAULT, w, copy, null).filter((x) => x.label.includes('units'));
    expect(short.map((x) => x.status)).toEqual(['not-done']);
  });

  it('reads a selected standing offer starting to lend again as a changed review', () => {
    const row = (active: boolean) => ({ rows: [{ lendingAsset: WETH, collateralAsset: TLIQ, available: 40n, active }], complete: true });
    const a = claimAllList(inputs({ intents: row(false) }), copy, 1);
    const b = claimAllList(inputs({ intents: row(true) }), copy, 1);
    expect(claimAllChanged(review(a.legs, { list: a }), review(b.legs, { list: b }), copy)).toBe('claimAll.changed');
  });

  it('credits each NFT of one collection only from its own record', () => {
    const NFT = '0x00000000000000000000000000000000000000f1' as Hex;
    const nftLane = (tokenId: bigint) => ({ kind: 'rentalReturn' as const, asset: NFT, assetType: 1, tokenId, amount: 1n });
    const guard = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
    const l = claimAllList(inputs({ protection: guard, loans: { paused: false, rows: [loanRow(7n, { lanes: [nftLane(11n), nftLane(12n)] })], complete: true } }), copy, 1);
    // Only token 11 was credited: token 12 is not read as arrived from it.
    const logs = [claimed(7n, 0n), credit(7n, NFT, 1n, 11n)];
    const w = { ...words, nft: (p: { tokenId: bigint }) => `nft${p.tokenId}` };
    const legs = measureClaimAll(review(l.legs, { list: l }), logs, DIAMOND, ME, MY_VAULT, w, copy, null)
      .map((x) => `${x.status}:${x.label}`)
      .filter((x) => x.includes('nft1'));
    expect(legs).toEqual(['done:payout.legCredit{"what":"nft11"}', 'not-done:payout.legCredit{"what":"nft12"}']);
  });

  it('refuses to send nothing, and a batch whose dry run could not run', () => {
    expect(claimAllBlockers(review([], { picked: [] }), copy)).toEqual(['claimAll.noneChosen']);
    expect(claimAllBlockers(review(list.legs, { dryRun: 'unread' }), copy)).toEqual(['claimAll.dryRunUnread']);
    expect(claimAllBlockers(review([], { picked: ['loan:lender:7'] }), copy)).toEqual(['claimAll.allRefused']);
  });
});
