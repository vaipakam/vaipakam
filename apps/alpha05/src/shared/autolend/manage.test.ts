import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Abi, type Log } from 'viem';
import { INTENT, type IntentRecord } from './autoLend';
import { hasEnded, manageBlocks, manageCall, manageLogs, manageOffers, type ManageDraft, type ManageFacts } from './manage';
import { manageReceipt, type ManageReview } from './manageReview';

type Hex = `0x${string}`;
const USDC = '0x1111111111111111111111111111111111111111' as Hex;
const WETH = '0x2222222222222222222222222222222222222222' as Hex;
const ME = '0x3333333333333333333333333333333333333333' as Hex;
const DIAMOND = '0x4444444444444444444444444444444444444444' as Hex;
const NOW = 1_800_000_000n;
const DAY = 86_400n;

const intent = (over: Partial<IntentRecord> = {}): IntentRecord => ({
  active: true,
  maxExposure: 1000n,
  minRateBps: 500n,
  maxInitLtvBps: 6000,
  maxDurationDays: 30,
  minFillAmount: 100n,
  requiresKeeperAuth: false,
  termsSetAt: NOW - DAY,
  lendUntil: 0n,
  acceptsProRata: false,
  ...over,
});
const facts = (over: Partial<ManageFacts> = {}): ManageFacts => ({
  blockNumber: 1n,
  chainNow: NOW,
  intent: intent(),
  unlent: 400n,
  lent: 600n,
  protocolPaused: false,
  lendingPaused: false,
  collateralPaused: false,
  balance: 1000n,
  allowance: 0n,
  protection: null,
  ...over,
});
const draft = (kind: ManageDraft['kind'], amount: bigint): ManageDraft => ({ kind, lending: USDC, collateral: WETH, amount });
const kinds = (d: ManageDraft, f: ManageFacts) => manageBlocks(d, f).map((b) => b.kind);

describe('manageBlocks', () => {
  it('adds only to a running Auto-lend that can still lend, with the money in the wallet', () => {
    expect(kinds(draft('add', 100n), facts())).toEqual([]);
    expect(kinds(draft('add', 100n), facts({ intent: intent({ active: false }) }))).toEqual(['stopped']);
    expect(kinds(draft('add', 100n), facts({ intent: intent({ lendUntil: NOW + DAY - 1n }) }))).toEqual(['ended']);
    expect(kinds(draft('add', 2000n), facts())).toEqual(['balance']);
    expect(kinds(draft('add', 0n), facts())).toEqual(['zero']);
  });

  it('a paused asset stops adding but not taking back; a paused protocol stops both', () => {
    expect(kinds(draft('add', 100n), facts({ collateralPaused: true }))).toEqual(['assetPaused']);
    expect(kinds(draft('takeBack', 100n), facts({ lendingPaused: true }))).toEqual([]);
    expect(kinds(draft('add', 100n), facts({ protocolPaused: true }))).toEqual(['protocolPaused']);
    expect(kinds(draft('takeBack', 100n), facts({ protocolPaused: true }))).toEqual(['protocolPaused']);
    expect(kinds(draft('add', 100n), facts({ lendingPaused: null }))).toEqual(['unread']);
  });

  it('takes back only money set aside and not lent, even from a stopped one', () => {
    expect(kinds(draft('takeBack', 400n), facts())).toEqual([]);
    expect(kinds(draft('takeBack', 401n), facts())).toEqual(['aboveUnlent']);
    expect(kinds(draft('takeBack', 100n), facts({ intent: intent({ active: false }) }))).toEqual([]);
    expect(kinds(draft('takeBack', 0n), facts())).toEqual(['zero']);
  });

  it('a pause blocks only the take-back a stop carries, never the stop itself', () => {
    expect(kinds(draft('stop', 0n), facts({ protocolPaused: true }))).toEqual([]);
    expect(kinds(draft('stop', 400n), facts({ protocolPaused: true }))).toEqual(['protocolPaused']);
    expect(kinds(draft('stop', 0n), facts({ intent: intent({ active: false }) }))).toEqual(['stopped']);
  });
});

describe('manageCall', () => {
  it('adds and takes back with one call each', () => {
    const add = manageCall(draft('add', 100n), ME);
    expect(decodeFunctionData({ abi: INTENT, data: encode(add) })).toMatchObject({ functionName: 'fundLenderIntent', args: [USDC, WETH, 100n] });
    const back = manageCall(draft('takeBack', 50n), ME);
    expect(decodeFunctionData({ abi: INTENT, data: encode(back) })).toMatchObject({ functionName: 'withdrawLenderIntentCapital', args: [ME, USDC, WETH, 50n] });
  });

  it('stops alone, or stops and takes back in one batch', () => {
    expect(manageCall(draft('stop', 0n), ME).functionName).toBe('cancelLenderIntent');
    const both = manageCall(draft('stop', 400n), ME);
    expect(both.functionName).toBe('multicall');
    const calls = (both.args as unknown as [readonly { callData: Hex; allowFailure: boolean }[]])[0];
    expect(calls.map((c) => decodeFunctionData({ abi: INTENT, data: c.callData }).functionName)).toEqual(['cancelLenderIntent', 'withdrawLenderIntentCapital']);
    expect(calls.every((c) => c.allowFailure === false)).toBe(true);
  });
});

function encode(call: ReturnType<typeof manageCall>): Hex {
  return encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: call.args as readonly unknown[] });
}

describe('manageLogs', () => {
  const log = (eventName: string, owner: Hex, data: readonly [bigint, bigint] | null): Log =>
    ({
      address: DIAMOND,
      topics: encodeEventTopics({ abi: INTENT, eventName, args: { owner, lendingAsset: USDC, collateralAsset: WETH } } as never),
      data: data === null ? '0x' : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], data),
    }) as unknown as Log;

  it('reads what this wallet funded, took back and stopped on this pair, and nothing else', () => {
    const other = '0x5555555555555555555555555555555555555555' as Hex;
    const logs = [
      log('LenderIntentFunded', ME, [100n, 500n]),
      log('LenderIntentCapitalWithdrawn', ME, [40n, 460n]),
      log('LenderIntentCancelled', ME, null),
      log('LenderIntentFunded', other, [999n, 999n]),
    ];
    expect(manageLogs(logs, DIAMOND, ME, USDC, WETH)).toEqual({ funded: 100n, withdrawn: 40n, stopped: true });
    expect(manageLogs([], DIAMOND, ME, USDC, WETH)).toEqual({ funded: null, withdrawn: null, stopped: false });
  });
});

describe('manageOffers and hasEnded', () => {
  it('offers the steps that fit where an Auto-lend stands', () => {
    expect(manageOffers(true, false, 10n)).toEqual(['add', 'takeBack', 'stop']);
    expect(manageOffers(true, true, 10n)).toEqual(['takeBack', 'stop']);
    expect(manageOffers(false, false, 10n)).toEqual(['takeBack']);
    expect(manageOffers(false, false, 0n)).toEqual([]);
  });

  it('ends when its date leaves no day-long loan', () => {
    expect(hasEnded(intent(), NOW)).toBe(false);
    expect(hasEnded(intent({ lendUntil: NOW + DAY }), NOW)).toBe(false);
    expect(hasEnded(intent({ lendUntil: NOW + DAY - 1n }), NOW)).toBe(true);
  });
});

describe('manageReceipt', () => {
  const copy = { text: (k: string) => k, format: (k: string) => k } as never;
  const review = (route: ManageReview['route']): ManageReview => ({
    draft: draft('takeBack', 100n),
    identity: 'x',
    readAt: 0,
    facts: facts(),
    blocks: [],
    approvalSteps: 0,
    route,
    verdict: { kind: 'ok' },
  });
  const to = (route: ManageReview['route']) => manageReceipt(review(route), null, copy).rows.find((r) => r.label === 'autoLend.mRowTo')?.value;

  it('states the destination a take-back binds, and leaves an unread mode unknown', () => {
    expect(to('wallet')).toEqual({ kind: 'text', text: 'autoLend.mToWallet' });
    expect(to('unknown')).toEqual({ kind: 'unknown', why: 'receipt.unknown' });
    expect(to('held')).toEqual({ kind: 'text', text: 'payout.toHeld' });
  });
});
