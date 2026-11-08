import { encodeEventTopics, encodeAbiParameters, erc20Abi, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClaimFacetABI, RiskMatchLiquidationFacetABI } from '@vaipakam/contracts/abis';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { matchIncentives } from './claimLog';
import { measureLoanClaim, type OutcomeText } from './claimOutcome';
import type { LoanClaimReview } from './loanClaimReview';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000aa' as Hex;
const VAULT = '0x00000000000000000000000000000000000000bb' as Hex;
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
  protection: { enabled: false, locked: false, delaySeconds: 0, requireCosign: false },
  route: 'wallet',
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
    const logs = [matched(ME), claimed(99n), transfer(WETH, 99n + 1n), transfer(TLIQ, 2n)];
    const ok = measureLoanClaim(review, logs, DIAMOND, ME, t, [
      { loanId: 7n, asset: WETH, amount: 1n },
      { loanId: 9n, asset: TLIQ, amount: 2n },
    ]);
    expect(ok.every((l) => l.status === 'done')).toBe(true);
    const labels = ok.map((l) => l.label);
    expect(labels.some((l) => l.startsWith('loanClaim.legRowMatched'))).toBe(true);
    expect(labels).toContain('loanClaim.legArrived{"amount":"100 e1"}');
    expect(labels).toContain('loanClaim.legArrived{"amount":"2 e2"}');
    expect(labels.filter((l) => l.startsWith('loanClaim.legIncentive'))).toHaveLength(2);
  });

  it('states a reward whose token could not be read as unknown', () => {
    const logs = [matched(ME), claimed(99n), transfer(WETH, 100n)];
    const legs = measureLoanClaim(review, logs, DIAMOND, ME, t, [
      { loanId: 7n, asset: WETH, amount: 1n },
      { loanId: 9n, asset: null, amount: 2n },
    ]);
    expect(legs.find((l) => l.label === 'loanClaim.legIncentiveUnread')?.status).toBe('unknown');
  });
});
