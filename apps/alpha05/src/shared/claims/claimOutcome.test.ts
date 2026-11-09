import { encodeEventTopics, encodeAbiParameters, erc20Abi, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClaimFacetABI, RiskMatchLiquidationFacetABI, VaultOutflowFacetABI } from '@vaipakam/contracts/abis';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { matchIncentives } from './claimLog';
import { measureLoanClaim, type OutcomeText } from './claimOutcome';
import type { LoanClaimReview } from './loanClaimReview';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000aa' as Hex;
const VAULT = '0x00000000000000000000000000000000000000bb' as Hex;
const MY_VAULT = '0x00000000000000000000000000000000000000cc' as Hex;
const OTHER_VAULT = '0x00000000000000000000000000000000000000dd' as Hex;
const WETH = '0x00000000000000000000000000000000000000e1' as Hex;
const TLIQ = '0x00000000000000000000000000000000000000e2' as Hex;
const FALLBACK_PENDING = 4;

function log(address: Hex, abi: Abi, eventName: string, args: Record<string, unknown>): Log {
  const event = abi.find((e) => e.type === 'event' && e.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    event.inputs.filter((i) => !i.indexed).map((i) => args[i.name]),
  );
  return { address, topics: topics as [Hex, ...Hex[]], data } as unknown as Log;
}
const transfer = (token: Hex, value: bigint) => log(token, erc20Abi as Abi, 'Transfer', { from: VAULT, to: ME, value });
// The claim's payout: the protocol's record of it moving into the
// claimant's vault (class 2, a position holder's payout).
const credit = (asset: Hex, delivered: bigint, to: Hex = MY_VAULT, ref = 7n, class_ = 2) =>
  log(DIAMOND, VaultOutflowFacetABI as Abi, 'VaultOutflow', { owner: VAULT, vault: VAULT, asset, tokenId: 0n, amount: delivered, delivered, to, class_, reason: 1, ref });
const claimed = (amount: bigint) => log(DIAMOND, ClaimFacetABI as Abi, 'LenderFundsClaimed', { loanId: 7n, claimant: ME, asset: WETH, amount, newBothClaimed: false });
const matched = (matcher: Hex) =>
  log(DIAMOND, RiskMatchLiquidationFacetABI as Abi, 'InternalMatchExecuted', {
    loanIdA: 7n,
    loanIdB: 9n,
    loanIdC: 0n,
    matcher,
    notionalA: 100n,
    notionalB: 200n,
    notionalC: 0n,
    incentivePaidA: 1n,
    incentivePaidB: 2n,
    incentivePaidC: 0n,
  });

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;
const t: OutcomeText = { copy, amount: (a, v) => `${v} ${a.slice(-2)}`, exact: (a, v) => `${v} ${a.slice(-2)}`, nft: () => 'nft' };
const review: LoanClaimReview = {
  identity: '1:0xaa',
  loanId: 7n,
  side: 'lender',
  loan: {
    status: FALLBACK_PENDING,
    assetType: 0,
    principalAsset: WETH,
    collateralAsset: TLIQ,
    lender: ME,
    borrower: VAULT,
    lenderTokenId: 1n,
    borrowerTokenId: 2n,
  } as unknown as LoanDetails,
  holder: ME,
  paused: false,
  claim: null,
  lanes: [{ kind: 'row', asset: WETH, assetType: 0, tokenId: 0n, amount: 50n }],
  sellersShare: 0n,
  protection: { enabled: false, locked: false, delaySeconds: 0, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const },
  route: 'credit',
  frozen: null,
  dryRun: null,
  verdict: OPEN,
  readAt: 1,
};

describe('measureLoanClaim with a claim-time match', () => {
  it('reads the matcher’s reward per leg, only when the claimant is the matcher', () => {
    expect(matchIncentives([matched(ME)], DIAMOND, 7n, ME)).toEqual([
      { loanId: 7n, amount: 1n },
      { loanId: 9n, amount: 2n },
    ]);
    expect(matchIncentives([matched(VAULT)], DIAMOND, 7n, ME)).toEqual([]);
  });

  it('counts the reward in both tokens, says the match rewrote the row, and flags nothing', () => {
    const logs = [matched(ME), claimed(99n), credit(WETH, 99n), transfer(WETH, 1n), transfer(TLIQ, 2n)];
    const ok = measureLoanClaim(review, logs, DIAMOND, ME, MY_VAULT, t, [
      { loanId: 7n, asset: WETH, amount: 1n },
      { loanId: 9n, asset: TLIQ, amount: 2n },
    ]);
    expect(ok.every((l) => l.status === 'done')).toBe(true);
    const labels = ok.map((l) => l.label);
    expect(labels.some((l) => l.startsWith('loanClaim.legRowMatched'))).toBe(true);
    expect(labels).toContain('payout.legCredit{"what":"99 e1"}');
    expect(labels).toContain('loanClaim.legArrived{"amount":"1 e1"}');
    expect(labels).toContain('loanClaim.legArrived{"amount":"2 e2"}');
    expect(labels.filter((l) => l.startsWith('loanClaim.legIncentive'))).toHaveLength(2);
  });

  it('measures what a partial match delivered beyond the review, held proceeds included, without a mismatch', () => {
    // The row is paid as reviewed; the match's proceeds came through the
    // funds held for the lender, which the protocol pays with no record.
    const logs = [matched(ME), claimed(50n), credit(WETH, 50n), credit(WETH, 30n), transfer(WETH, 1n), transfer(TLIQ, 2n)];
    const legs = measureLoanClaim(review, logs, DIAMOND, ME, MY_VAULT, t, [
      { loanId: 7n, asset: WETH, amount: 1n },
      { loanId: 9n, asset: TLIQ, amount: 2n },
    ]);
    expect(legs.every((l) => l.status === 'done')).toBe(true);
    expect(legs.map((l) => l.label)).toContain('payout.legCredit{"what":"80 e1"}');
  });

  it('measures the principal a match paid with no reward and no reviewed principal', () => {
    // The residual row names collateral; the match's proceeds came in the
    // principal token through the held funds, and its reward rounded to zero.
    const collateralRow: LoanClaimReview = { ...review, lanes: [{ kind: 'row', asset: TLIQ, assetType: 0, tokenId: 0n, amount: 9n }] };
    const record = log(DIAMOND, ClaimFacetABI as Abi, 'LenderFundsClaimed', { loanId: 7n, claimant: ME, asset: TLIQ, amount: 9n, newBothClaimed: false });
    const legs = measureLoanClaim(collateralRow, [matched(VAULT), record, credit(TLIQ, 9n), credit(WETH, 40n)], DIAMOND, ME, MY_VAULT, t, []);
    expect(legs.map((l) => l.label)).toContain('payout.legCredit{"what":"40 e1"}');
    expect(legs.every((l) => l.status === 'done')).toBe(true);
  });

  it('still flags a reviewed token that delivered nothing after a match', () => {
    const legs = measureLoanClaim(review, [matched(ME), claimed(50n)], DIAMOND, ME, MY_VAULT, t, []);
    expect(legs.find((l) => l.status === 'not-done')?.label).toBe('payout.legCredit{"what":"50 e1"}');
  });

  it('compares with the review when no match ran', () => {
    const legs = measureLoanClaim({ ...review, loan: { ...review.loan, status: 1 } as LoanDetails }, [claimed(50n), credit(WETH, 80n)], DIAMOND, ME, MY_VAULT, t, []);
    expect(legs.some((l) => l.status === 'unknown')).toBe(true);
  });

  it('states a reward whose token could not be read as unknown', () => {
    const logs = [matched(ME), claimed(99n), credit(WETH, 99n), transfer(WETH, 1n)];
    const legs = measureLoanClaim(review, logs, DIAMOND, ME, MY_VAULT, t, [
      { loanId: 7n, asset: WETH, amount: 1n },
      { loanId: 9n, asset: null, amount: 2n },
    ]);
    expect(legs.find((l) => l.label === 'loanClaim.legIncentiveUnread')?.status).toBe('unknown');
  });
});

describe('measureLoanClaim: the payout is credited to the claimant’s vault', () => {
  const ended = { ...review, loan: { ...review.loan, status: 1 } as LoanDetails };

  it('counts a credit into the claimant’s vault, including one that stayed in its own vault', () => {
    // The claimant is still the party the loan recorded: the payout stays in
    // its vault and is recorded with that vault as its destination.
    const legs = measureLoanClaim(ended, [claimed(50n), credit(WETH, 50n)], DIAMOND, ME, MY_VAULT, t, []);
    expect(legs.every((l) => l.status === 'done')).toBe(true);
    expect(legs.map((l) => l.label)).toContain('payout.legCredit{"what":"50 e1"}');
  });

  it('never counts a credit to another vault, another loan, or a class the protocol does not credit', () => {
    const others = [credit(WETH, 50n, OTHER_VAULT), credit(WETH, 50n, MY_VAULT, 8n), credit(WETH, 50n, MY_VAULT, 7n, 13)];
    const legs = measureLoanClaim(ended, [claimed(50n), ...others], DIAMOND, ME, MY_VAULT, t, []);
    expect(legs.find((l) => l.label === 'payout.legCredit{"what":"50 e1"}')?.status).toBe('not-done');
  });

  it('states the credit as unmeasured when the vault could not be read', () => {
    const legs = measureLoanClaim(ended, [claimed(50n), credit(WETH, 50n)], DIAMOND, ME, null, t, []);
    const leg = legs.find((l) => l.label === 'payout.legCredit{"what":"50 e1"}');
    expect(leg?.status).toBe('unknown');
    expect(leg && 'reason' in leg ? leg.reason : null).toBe('payout.vaultUnread');
  });
});
