import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, type Abi, type Log } from 'viem';
import { MulticallFacetABI } from '@vaipakam/contracts/abis';
import {
  autoLendDraft,
  bpsText,
  DEFAULT_AUTOLEND_INPUT,
  earliestLendUntil,
  fillPosture,
  inputFromIntent,
  INTENT,
  ltvCapBlock,
  lendUntilSeconds,
  localToday,
  parseAutoLend,
  resolvedMinFill,
  setAsideAfter,
  setupBlocks,
  setupCall,
  setupLogs,
  type AutoLendInput,
  type IntentRecord,
  type SetupFacts,
} from './autoLend';
import { autoLendOption } from './lendChoice';
import { autoLendState, shareLentByAsset, sortMyAutoLend, type MyAutoLend } from './myAutoLend';

type Hex = `0x${string}`;
const USDC = '0x1111111111111111111111111111111111111111' as Hex;
const WETH = '0x2222222222222222222222222222222222222222' as Hex;
const ME = '0x3333333333333333333333333333333333333333' as Hex;
const DIAMOND = '0x4444444444444444444444444444444444444444' as Hex;
const E6 = 10n ** 6n;
const NOW = 1_800_000_000n;
const DAY = 86_400n;

const input = (over: Partial<AutoLendInput> = {}): AutoLendInput => ({ ...DEFAULT_AUTOLEND_INPUT, amount: '1000', rate: '8', ...over });
const parse = (over: Partial<AutoLendInput> = {}, advanced = false) => parseAutoLend(input(over), 6, 365, advanced, '2027-01-10');
const parsed = (over: Partial<AutoLendInput> = {}, advanced = false) => {
  const p = parse(over, advanced);
  if (!p.ok) throw new Error(JSON.stringify(p.errors));
  return p.parsed;
};

const NONE: IntentRecord = {
  active: false,
  maxExposure: 0n,
  minRateBps: 0n,
  maxInitLtvBps: 0,
  maxDurationDays: 0,
  minFillAmount: 0n,
  requiresKeeperAuth: false,
  termsSetAt: 0n,
  lendUntil: 0n,
  acceptsProRata: false,
};
const RECORD: IntentRecord = {
  ...NONE,
  active: true,
  maxExposure: 2000n * E6,
  minRateBps: 550n,
  maxInitLtvBps: 6000,
  maxDurationDays: 60,
  minFillAmount: 200n * E6,
  termsSetAt: NOW - DAY,
};

function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    blockNumber: 10n,
    chainNow: NOW,
    existing: null,
    record: NONE,
    unlent: 0n,
    lent: 0n,
    priority: false,
    minFillValue: 10n * 10n ** 18n,
    floor: 10n * E6,
    minTermsAgeSec: 3600n,
    gates: { protocolPaused: false, matching: false, intents: false, keepers: false, aggregators: false },
    balance: 5000n * E6,
    allowance: 0n,
    ...over,
  };
}

describe('the Auto-lend form', () => {
  it('parses every figure exactly, in the token’s units and in basis points', () => {
    const p = parsed({ amount: '1000.5', rate: '7.25', ltv: '65', days: '90', proRata: true });
    expect(p).toMatchObject({ fund: 1_000_500_000n, minRateBps: 725n, maxInitLtvBps: 6500, maxDurationDays: 90, acceptsProRata: true, maxExposure: null, minFill: null });
  });

  it('refuses more decimals than the token has and a term past the network’s longest, and takes a 0% lowest rate', () => {
    const p = parse({ amount: '1.0000001', rate: '0', days: '400' });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.errors).toEqual({ amount: 'decimals', days: 'high' });
  });

  it('refuses an end date that is not after today, and keeps an empty one as none', () => {
    const past = parse({ lendUntil: '2027-01-10' });
    expect(!past.ok && past.errors.lendUntil).toBe('past');
    expect(parsed({ lendUntil: '' }).lendUntilDate).toBeNull();
    expect(parsed({ lendUntil: '2027-02-01' }).lendUntilDate).toBe('2027-02-01');
  });

  it('ignores the Advanced limits outside Advanced, so a hidden figure never reaches the protocol', () => {
    expect(parsed({ exposure: '50', minFill: '1' }, false)).toMatchObject({ maxExposure: null, minFill: null });
    expect(parsed({ exposure: '2000', minFill: '100' }, true)).toMatchObject({ maxExposure: 2000n * E6, minFill: 100n * E6 });
  });

  it('refuses a smallest loan above the most lent out at once', () => {
    const p = parse({ exposure: '50', minFill: '60' }, true);
    expect(!p.ok && p.errors.minFill).toBe('aboveExposure');
  });

  it('takes the end date as the last second of that day where the reader is', () => {
    const s = lendUntilSeconds('2027-02-01');
    expect(s).toBe(BigInt(Math.floor(new Date(2027, 1, 1, 23, 59, 59).getTime() / 1000)));
    expect(localToday(new Date(2027, 0, 5, 9))).toBe('2027-01-05');
  });
});

describe('the smallest loan', () => {
  it('defaults to a tenth of the most lent out at once, rounded up, at least the network minimum', () => {
    expect(resolvedMinFill(parsed({ amount: '1000' }), 10n * E6)).toBe(100n * E6);
    expect(resolvedMinFill(parsed({ amount: '50' }), 10n * E6)).toBe(10n * E6);
  });

  it('never exceeds the most lent out at once, and is unknown when the minimum is unread', () => {
    expect(resolvedMinFill(parsed({ amount: '5' }), 10n * E6)).toBe(5n * E6);
    expect(resolvedMinFill(parsed({ amount: '1000' }), null)).toBeNull();
  });

  it('keeps a typed smallest loan as typed', () => {
    expect(resolvedMinFill(parsed({ minFill: '42' }, true), null)).toBe(42n * E6);
  });
});

describe('what stops a setup before any dry run', () => {
  it('refuses a pair that already has an Auto-lend, since setting it again replaces its terms', () => {
    const d = autoLendDraft(USDC, WETH, parsed());
    const existing = { active: true } as SetupFacts['existing'];
    expect(setupBlocks(d, facts({ existing })).map((b) => b.kind)).toContain('exists');
  });

  it('asks for an end date the protocol takes: the terms age, then one day-long loan', () => {
    const d = { ...autoLendDraft(USDC, WETH, parsed()), lendUntil: NOW + DAY };
    const blocks = setupBlocks(d, facts());
    expect(blocks).toContainEqual({ kind: 'lendUntil', earliest: earliestLendUntil(NOW, 3600n) });
    expect(earliestLendUntil(NOW, 3600n)).toBe(NOW + 3600n + DAY);
    expect(setupBlocks({ ...d, lendUntil: NOW + 3600n + DAY }, facts()).map((b) => b.kind)).not.toContain('lendUntil');
  });

  it('names a smallest loan below the network minimum, an unread minimum and a short wallet', () => {
    const small = autoLendDraft(USDC, WETH, parsed({ amount: '5' }));
    expect(setupBlocks(small, facts())).toContainEqual({ kind: 'belowFloor', floor: 10n * E6 });
    expect(setupBlocks(autoLendDraft(USDC, WETH, parsed()), facts({ floor: null })).map((b) => b.kind)).toContain('floorUnread');
    expect(setupBlocks(autoLendDraft(USDC, WETH, parsed()), facts({ balance: 10n }))).toContainEqual({ kind: 'balance', balance: 10n });
  });

  it('stops a smallest loan above the money set aside, which no fill could meet', () => {
    // Advanced: most at once 5000, funded 100; the floor of 10 resolves under
    // the funding, an explicit smallest loan of 200 does not.
    const d = autoLendDraft(USDC, WETH, parsed({ amount: '100', exposure: '5000', minFill: '200' }, true));
    expect(setupBlocks(d, facts())).toContainEqual({ kind: 'minAboveFund', minFill: 200n * E6 });
    expect(setupBlocks(autoLendDraft(USDC, WETH, parsed({ amount: '100', exposure: '5000' }, true)), facts()).map((b) => b.kind)).not.toContain('minAboveFund');
  });

  it('stops a loan-to-value ceiling above the network’s bound for the pair, and only that', () => {
    expect(ltvCapBlock({ kind: 'cap', fits: false, approxBps: 5500 })).toEqual({ kind: 'ltvCap', capBps: 5500 });
    // A fitting ceiling is not refused, even when the rounded figure reads lower (low-decimal collateral).
    expect(ltvCapBlock({ kind: 'cap', fits: true, approxBps: 1000 })).toBeNull();
    expect(ltvCapBlock({ kind: 'none' })).toBeNull();
    expect(ltvCapBlock({ kind: 'closed' })).toEqual({ kind: 'ltvClosed' });
    // Unread is stated as a consequence, not a block.
    expect(ltvCapBlock(null)).toBeNull();
  });

  it('finds nothing to stop a setup that fits', () => {
    expect(setupBlocks(autoLendDraft(USDC, WETH, parsed()), facts())).toEqual([]);
  });
});

describe('the setup call', () => {
  it('sends the terms and the funding as one batch, every step required, terms first', () => {
    const d = autoLendDraft(USDC, WETH, parsed({ proRata: true, lendUntil: '2027-03-01' }));
    const call = setupCall(d, 100n * E6, 99n, null);
    expect(call.functionName).toBe('multicall');
    const steps = call.args[0] as readonly { callData: Hex; allowFailure: boolean }[];
    expect(steps.map((s) => s.allowFailure)).toEqual([false, false]);
    const set = decodeFunctionData({ abi: INTENT, data: steps[0]!.callData });
    expect(set.functionName).toBe('setLenderIntent');
    expect(set.args).toEqual([USDC, WETH, 0, 1000n * E6, 800n, 6000, 30, 100n * E6, false, d.lendUntil, true, true, 99n]);
    const fund = decodeFunctionData({ abi: INTENT, data: steps[1]!.callData });
    expect(fund).toEqual({ functionName: 'fundLenderIntent', args: [USDC, WETH, 0, 1000n * E6] });
    // The batch ABI names the steps' errors, so a step's revert decodes.
    expect((call.abi as Abi).some((i) => i.type === 'error' && i.name === 'LenderIntentInvalidBounds')).toBe(true);
    expect((call.abi as Abi).some((i) => i.type === 'function' && i.name === 'multicall')).toBe(true);
    void MulticallFacetABI;
  });

  it('sends the terms alone for the dry run that comes before an approval', () => {
    const call = setupCall(autoLendDraft(USDC, WETH, parsed()), 100n * E6, 99n, null, true);
    expect(call.functionName).toBe('setLenderIntent');
  });
});

describe('a change of an Auto-lend', () => {
  const change = (over: Partial<AutoLendInput> = {}, advanced = false) => {
    const p = parseAutoLend(input({ amount: '', ...over }), 6, 365, advanced, '2027-01-10', true);
    if (!p.ok) throw new Error(JSON.stringify(p.errors));
    return autoLendDraft(USDC, WETH, p.parsed, true);
  };

  it('keeps a recorded 0% lowest rate, which the protocol takes as any rate', () => {
    expect(change({ rate: '0' }).parsed.minRateBps).toBe(0n);
    const fresh = parseAutoLend(input({ rate: '0' }), 6, 365, false, '2027-01-10');
    expect(fresh.ok && fresh.parsed.minRateBps).toBe(0n);
    // A zero ceiling is still refused.
    expect(parseAutoLend(input({ ltv: '0' }), 6, 365, false, '2027-01-10').ok).toBe(false);
  });

  it('may add nothing: an empty or zero amount adds none, and sends the terms alone', () => {
    expect(change().parsed.fund).toBe(0n);
    expect(change({ amount: '0' }).parsed.fund).toBe(0n);
    const call = setupCall(change(), 200n * E6, 99n, RECORD);
    expect(call.functionName).toBe('setLenderIntent');
    // The recorded most at once and the fill restriction are kept.
    expect(call.args[3]).toBe(2000n * E6);
    expect(call.args[8]).toBe(false);
    expect(setupCall(change(), 200n * E6, 99n, { ...RECORD, requiresKeeperAuth: true }).args[8]).toBe(true);
  });

  it('adds money in the same batch when an amount is typed', () => {
    const call = setupCall(change({ amount: '50' }), 200n * E6, 99n, RECORD);
    expect(call.functionName).toBe('multicall');
  });

  it('keeps the recorded smallest loan unless one is typed', () => {
    expect(resolvedMinFill(change().parsed, 10n * E6, RECORD)).toBe(200n * E6);
    expect(resolvedMinFill(change({ minFill: '300' }, true).parsed, 10n * E6, RECORD)).toBe(300n * E6);
  });

  it('counts the money already waiting, and refuses a pair with nothing to change', () => {
    const f = facts({ record: RECORD, existing: RECORD, unlent: 150n * E6 });
    expect(setAsideAfter(change({ amount: '100' }), f)).toBe(250n * E6);
    expect(setupBlocks(change(), f)).toEqual([{ kind: 'minAboveFund', minFill: 200n * E6 }]);
    expect(setupBlocks(change({ amount: '100' }), f)).toEqual([]);
    expect(setupBlocks(change(), facts()).map((b) => b.kind)).toContain('missing');
  });

  it('refuses a smallest loan above a kept most at once', () => {
    const f = facts({ record: RECORD, existing: RECORD, unlent: 5000n * E6 });
    expect(setupBlocks(change({ minFill: '2500' }, true), f)).toEqual([{ kind: 'minAboveExposure', minFill: 2500n * E6 }]);
  });

  it('opens the form on the recorded limits, exactly', () => {
    const i = inputFromIntent({ ...RECORD, lendUntil: 0n }, 6);
    expect(i).toMatchObject({ amount: '', rate: '5.5', ltv: '60', days: '60', lendUntil: '', exposure: '2000', minFill: '200' });
    expect(bpsText(725n)).toBe('7.25');
    expect(bpsText(800n)).toBe('8');
  });
});

describe('what a setup’s logs record', () => {
  const log = (name: 'LenderIntentSet' | 'LenderIntentFunded', owner: Hex, data: Hex): Log =>
    ({
      address: DIAMOND,
      topics: encodeEventTopics({ abi: INTENT, eventName: name, args: { owner, lendingAsset: USDC, collateralAsset: WETH } as never }),
      data,
    }) as unknown as Log;
  const setData = encodeAbiParameters(
    [
      { type: 'uint8' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint16' },
      { type: 'uint32' },
      { type: 'uint256' },
      { type: 'bool' },
      { type: 'uint64' },
      { type: 'bool' },
    ],
    [0, 1n, 1n, 1, 1, 1n, false, 0n, false],
  );
  const fundData = encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }], [0, 700n, 700n]);
  const otherSlot = encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }], [1, 900n, 900n]);

  it('reads the terms set and the amount funded, for this wallet, pair and slot only', () => {
    expect(setupLogs([log('LenderIntentSet', ME, setData), log('LenderIntentFunded', ME, otherSlot), log('LenderIntentFunded', ME, fundData)], DIAMOND, ME, USDC, WETH, 0)).toEqual(
      {
        set: true,
        funded: 700n,
      },
    );
    const other = '0x9999999999999999999999999999999999999999' as Hex;
    expect(setupLogs([log('LenderIntentSet', other, setData)], DIAMOND, ME, USDC, WETH, 0)).toEqual({ set: false, funded: null });
  });
});

describe('whether Auto-lend can run here', () => {
  const gates = (over: Partial<SetupFacts['gates']>) => ({ ...facts().gates, ...over });
  it('is halted by a pause, off by either switch, and paused when only the protocol’s own service is', () => {
    expect(fillPosture(gates({}))).toBe('on');
    expect(fillPosture(gates({ protocolPaused: true }))).toBe('halted');
    expect(fillPosture(gates({ intents: true }))).toBe('off');
    expect(fillPosture(gates({ matching: true }))).toBe('off');
    expect(fillPosture(gates({ keepers: true }))).toBe('service-paused');
    expect(fillPosture(gates({ intents: null }))).toBe('unknown');
  });

  it('closes the choice with the reason, and leaves it open when unread', () => {
    expect(autoLendOption(null)).toBe('open');
    expect(autoLendOption({ posture: 'unknown', has: false })).toBe('open');
    expect(autoLendOption({ posture: 'on', has: true })).toBe('has');
    expect(autoLendOption({ posture: 'off', has: false })).toBe('off');
    expect(autoLendOption({ posture: 'halted', has: false })).toBe('halted');
  });
});

describe('the Auto-lend cards on Positions', () => {
  const row = (over: Partial<MyAutoLend['intent']> = {}, active = true): MyAutoLend => ({
    active,
    intent: {
      owner: ME,
      lendingAsset: USDC,
      collateralAsset: WETH,
      slot: 0,
      maxExposure: 1000n,
      minRateBps: 800n,
      maxInitLtvBps: 6000,
      maxDurationDays: 30,
      minFillAmount: 100n,
      requiresKeeperAuth: false,
      livePrincipal: 0n,
      availableCapital: 1000n,
      lendUntil: 0n,
      acceptsProRata: false,
      ...over,
    },
  });

  it('says ended once no day-long loan fits before the end date, as the protocol’s feed does', () => {
    expect(autoLendState(row(), NOW)).toBe('active');
    expect(autoLendState(row({ lendUntil: NOW + DAY }), NOW)).toBe('active');
    expect(autoLendState(row({ lendUntil: NOW + DAY - 1n }), NOW)).toBe('ended');
    expect(autoLendState(row({}, false), NOW)).toBe('stopped');
  });

  it('lists lending first, then ended, then stopped, the most waiting money first', () => {
    const rows = [row({ availableCapital: 5n }, false), row({ availableCapital: 1n }), row({ availableCapital: 9n, lendUntil: NOW }), row({ availableCapital: 3n })];
    expect(sortMyAutoLend(rows, NOW).map((r) => r.intent.availableCapital)).toEqual([3n, 1n, 9n, 5n]);
  });

  it('sums lent and waiting per lending asset, never across assets, and names waiting money that will not be lent', () => {
    const rows = [
      row({ livePrincipal: 300n, availableCapital: 700n }),
      row({ collateralAsset: ME, livePrincipal: 200n, availableCapital: 0n }),
      row({ collateralAsset: USDC, livePrincipal: 0n, availableCapital: 100n }, false),
      row({ lendingAsset: WETH, livePrincipal: 1n, availableCapital: 2n, lendUntil: NOW }),
      row({ lendingAsset: ME, livePrincipal: 0n, availableCapital: 0n }, false),
    ];
    expect(shareLentByAsset(rows, NOW)).toEqual([
      { lendingAsset: USDC, lent: 500n, waiting: 800n, idle: 100n, shareBps: 3846, settings: 3 },
      { lendingAsset: WETH, lent: 1n, waiting: 2n, idle: 2n, shareBps: 3333, settings: 1 },
    ]);
  });
});
