import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseAbi, type Log } from 'viem';
import { claimRecord, deliveryOutcome, inFinalNotice, moreRemains, pendingFromRevert, revertOf, soonestFrom, vpfiArrivals, type ExpiryPage } from './rewards';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const ME = '0x00000000000000000000000000000000000000a1' as const;
const OTHER = '0x00000000000000000000000000000000000000b2' as const;

const VPFI = '0x00000000000000000000000000000000000000e1' as const;
const VAULT = '0x00000000000000000000000000000000000000f1' as const;

const EVENTS = parseAbi([
  'event InteractionRewardsClaimed(address indexed user, uint256 fromDay, uint256 toDay, uint256 amount)',
  'event RewardDeliveredToVault(address indexed user, uint256 amount, uint256 claimDayId)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function transfer(to: `0x${string}`, value: bigint, token: `0x${string}` = VPFI): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'Transfer', args: { from: DIAMOND, to } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  } as unknown as Log;
}

function claimed(user: `0x${string}`, amount: bigint, address: `0x${string}` = DIAMOND): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'InteractionRewardsClaimed', args: { user } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 3n, amount]),
  } as unknown as Log;
}

function toVault(user: `0x${string}`, amount: bigint): Log {
  return {
    address: DIAMOND,
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'RewardDeliveredToVault', args: { user } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, 3n]),
  } as unknown as Log;
}

describe('pendingFromRevert', () => {
  it('reads the simulation revert as the exact figure', () => {
    expect(pendingFromRevert({ errorName: 'InteractionRewardsSimulation', args: [5n, 1n, 4n] }, 9n)).toEqual({ kind: 'exact', amount: 5n, fromDay: 1n, toDay: 4n, atBlock: 9n });
  });
  it('names each refusal the claim itself would raise', () => {
    expect(pendingFromRevert({ errorName: 'NoInteractionRewardsToClaim', args: [] }, 9n)).toEqual({ kind: 'none' });
    expect(pendingFromRevert({ errorName: 'InteractionDayGlobalNotFinalized', args: [7n] }, 9n)).toEqual({ kind: 'waiting', day: 7n, why: 'global' });
    expect(pendingFromRevert({ errorName: 'InteractionDayAwaitingDelivery', args: [8n] }, 9n)).toEqual({ kind: 'waiting', day: 8n, why: 'delivery' });
    expect(pendingFromRevert({ errorName: 'InteractionEmissionsNotStarted', args: [] }, 9n)).toEqual({ kind: 'not-started' });
    expect(pendingFromRevert({ errorName: 'VPFITokenNotSet', args: [] }, 9n)).toEqual({ kind: 'not-started' });
    expect(pendingFromRevert({ errorName: 'EnforcedPause', args: [] }, 9n)).toEqual({ kind: 'paused' });
    expect(pendingFromRevert({ errorName: 'SanctionedAddress', args: [ME] }, 9n)).toEqual({ kind: 'barred' });
  });
  it('keeps any other refusal by its name, never as "nothing to claim"', () => {
    expect(pendingFromRevert({ errorName: 'RewardDeliveryNotSelectable', args: [3] }, 9n)).toEqual({ kind: 'refused', code: 'RewardDeliveryNotSelectable' });
  });
});

describe('revertOf', () => {
  const ERRORS = parseAbi(['error InteractionRewardsSimulation(uint256 paid, uint256 fromDay, uint256 toDay)', 'error InteractionDayGlobalNotFinalized(uint256 dayId)']);
  it('decodes revert bytes a wallet quoted only in its message text', () => {
    const data = encodeErrorResult({ abi: ERRORS, errorName: 'InteractionDayGlobalNotFinalized', args: [12n] });
    const err = Object.assign(new Error(`execution reverted with the signature ${data.slice(0, 10)} | (data: ${data})`), { code: 3 });
    expect(revertOf(err)).toEqual({ errorName: 'InteractionDayGlobalNotFinalized', args: [12n] });
  });
  it('decodes the simulation figure from a structured field', () => {
    const data = encodeErrorResult({ abi: ERRORS, errorName: 'InteractionRewardsSimulation', args: [5n, 1n, 30n] });
    expect(revertOf({ data })).toEqual({ errorName: 'InteractionRewardsSimulation', args: [5n, 1n, 30n] });
  });
  it('is null for a failure that never reached the contract', () => {
    expect(revertOf(new Error('fetch failed'))).toBeNull();
  });
  it('is null for a revert whose source dropped the reason, so the next source is asked', () => {
    expect(revertOf(new ContractFunctionRevertedError({ abi: ERRORS, functionName: 'simulateClaimInteractionRewards' }))).toBeNull();
  });
});

describe('soonestFrom', () => {
  const page = (expiresAt: bigint, next: bigint, total: bigint): ExpiryPage => [1n, expiresAt, next, total];
  it('takes the earliest date across every page', () => {
    expect(soonestFrom([page(900n, 200n, 400n), page(500n, 400n, 400n), page(0n, 400n, 400n)], true)).toEqual({ kind: 'date', at: 500, complete: true });
  });
  it('says none only when every reward was read', () => {
    expect(soonestFrom([page(0n, 10n, 10n)], true)).toEqual({ kind: 'none' });
    expect(soonestFrom([page(0n, 200n, 900n)], false)).toEqual({ kind: 'incomplete' });
  });
  it('marks a date found on a partial walk as possibly not the soonest', () => {
    expect(soonestFrom([page(700n, 200n, 900n)], false)).toEqual({ kind: 'date', at: 700, complete: false });
  });
});

describe('moreRemains', () => {
  const exact = (amount: bigint, fromDay: bigint, toDay: bigint, atBlock: bigint) => ({ kind: 'exact' as const, amount, fromDay, toDay, atBlock });
  it('offers claim again only for a preview read at or after the claim block', () => {
    expect(moreRemains(exact(5n, 31n, 35n, 100n), 100n)).toBe(true);
    expect(moreRemains(exact(5n, 31n, 35n, 101n), 100n)).toBe(true);
    expect(moreRemains(exact(5n, 1n, 30n, 99n), 100n)).toBe(false);
  });
  it('counts an entries-only remainder that names no day range', () => {
    expect(moreRemains(exact(5n, 0n, 0n, 100n), 100n)).toBe(true);
  });
  it('offers a remainder that pays nothing, since the protocol answers zero only for a claim that makes progress', () => {
    expect(moreRemains(exact(0n, 31n, 35n, 100n), 100n)).toBe(true);
    expect(moreRemains({ kind: 'none' }, 100n)).toBe(false);
    expect(moreRemains(null, 100n)).toBe(false);
  });
});

describe('inFinalNotice', () => {
  it('is on within 90 days of the estimate and off before', () => {
    const now = 1_000_000;
    expect(inFinalNotice(now + 90 * 86_400, now)).toBe(true);
    expect(inFinalNotice(now + 90 * 86_400 + 1, now)).toBe(false);
    expect(inFinalNotice(now - 1, now)).toBe(true);
  });
});

describe('claimRecord', () => {
  it('reads what the claim paid and the vault share for this wallet only', () => {
    expect(claimRecord([claimed(ME, 10n), toVault(ME, 10n), claimed(OTHER, 99n), toVault(OTHER, 99n)], DIAMOND, ME)).toEqual({ paid: 10n, toVault: 10n });
  });
  it('ignores the same event from another contract', () => {
    expect(claimRecord([claimed(ME, 10n, OTHER)], DIAMOND, ME)).toEqual({ paid: null, toVault: 0n });
  });
  it('reports no claim when the transaction logged none', () => {
    expect(claimRecord([], DIAMOND, ME)).toEqual({ paid: null, toVault: 0n });
  });
});

describe('vpfiArrivals', () => {
  it('counts only the VPFI this transaction sent to the wallet and to its vault', () => {
    const logs = [transfer(ME, 3n), transfer(VAULT, 7n), transfer(OTHER, 99n), transfer(ME, 50n, OTHER)];
    expect(vpfiArrivals(logs, VPFI, ME, VAULT)).toEqual({ wallet: 3n, vault: 7n });
  });
  it('counts nothing for the vault when the account has none', () => {
    expect(vpfiArrivals([transfer(ME, 4n)], VPFI, ME, '0x0000000000000000000000000000000000000000')).toEqual({ wallet: 4n, vault: 0n });
  });
});

describe('deliveryOutcome', () => {
  it('names where the payment landed when the arrivals add up to it', () => {
    expect(deliveryOutcome(10n, 0n, 10n)).toEqual({ where: 'vault', verdict: 'done' });
    expect(deliveryOutcome(10n, 10n, 0n)).toEqual({ where: 'wallet', verdict: 'done' });
    expect(deliveryOutcome(10n, 4n, 6n)).toEqual({ where: 'split', verdict: 'done' });
  });
  it('leaves the destination unknown, never inferred, when they do not', () => {
    expect(deliveryOutcome(10n, 0n, 7n)).toEqual({ where: 'unknown', verdict: 'unknown' });
    expect(deliveryOutcome(10n, 0n, 0n)).toEqual({ where: 'unknown', verdict: 'unknown' });
    expect(deliveryOutcome(10n, 5n, 10n)).toEqual({ where: 'unknown', verdict: 'unknown' });
  });
});
