/**
 * #2515 item 5 — the sanctions pass's one-off notices: a landed settlement or
 * staging resolution that MOVED value, named with the amounts its own receipt's
 * events state, and an evidence chain the run saw lapse. The receipt logs are
 * encoded from the compiled Diamond ABI, so a renamed or reshaped event fails
 * here rather than reading as "nothing moved".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseUnits, type Abi, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { lapsedChain, sendSanctionsNotices, valueMovesOf, type OwnerSanctionsStatus, type ValueMove } from '../src/rewardSanctionsHold';
import type { Env } from '../src/env';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as Address;
const OTHER = '0x00000000000000000000000000000000000000d2' as Address;
const OWNER = '0x00000000000000000000000000000000000000a1' as Address;
const SOMEONE = '0x00000000000000000000000000000000000000a2' as Address;
const CHAIN = 84532;
const TX = `0x${'7'.repeat(64)}` as Hex;

function log(address: Address, eventName: string, args: Record<string, unknown>): Log {
  const ev = (DIAMOND_ABI_VIEM as Abi).find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  if (!ev) throw new Error(`no event ${eventName} in the Diamond ABI`);
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(
    ev.inputs.filter((i) => !i.indexed),
    ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]),
  );
  return { address, topics, data } as unknown as Log;
}
const v = (x: string) => parseUnits(x, 18);

describe('valueMovesOf', () => {
  it("sums what the receipt says moved for the owner, from the Diamond's own logs only", () => {
    const logs = [
      log(DIAMOND, 'RewardSanctionsHeldApart', { user: OWNER, amount: v('3'), heldBalance: v('3') }),
      log(DIAMOND, 'RewardSanctionsHeldApart', { user: SOMEONE, amount: v('100'), heldBalance: v('100') }),
      log(DIAMOND, 'VpfiRecycled', { source: 0, refId: 0n, amount: v('1.5'), dayId: 7n }),
      log(DIAMOND, 'VpfiRecycled', { source: 2, refId: 0n, amount: v('9'), dayId: 7n }),
      log(DIAMOND, 'VpfiRecycledPreLaunch', { source: 0, refId: 0n, amount: v('0.5') }),
      log(DIAMOND, 'StagingClaimantForfeited', { key: `0x${'1'.repeat(64)}`, user: OWNER, fresh: v('2'), recycled: v('1') }),
      log(OTHER, 'VpfiRecycled', { source: 0, refId: 0n, amount: v('50'), dayId: 7n }),
    ];
    expect(valueMovesOf(logs, DIAMOND, OWNER)).toEqual({ heldApart: v('3'), forfeited: v('2'), stagedForfeited: v('3') });
  });

  it('reads nothing moved from a receipt with no such events', () => {
    expect(valueMovesOf([], DIAMOND, OWNER)).toEqual({ heldApart: 0n, forfeited: 0n, stagedForfeited: 0n });
  });
});

const st = (over: Partial<OwnerSanctionsStatus> = {}): OwnerSanctionsStatus => ({
  owner: OWNER,
  decision: 1,
  flaggedAt: 1_000,
  lastSeenAt: 5_000,
  forfeitableAt: 1_000 + 3 * 86_400,
  observeBy: 5_000 + 86_400,
  stored: true,
  ...over,
});

describe('lapsedChain', () => {
  it('a chain restarted past its observation deadline lapsed', () => {
    expect(lapsedChain(st(), st({ flaggedAt: 5_000 + 86_400 + 60, lastSeenAt: 5_000 + 86_400 + 60 }))).toEqual({
      lastSeenAt: 5_000,
      missedAt: 5_000 + 86_400,
      restartedAt: 5_000 + 86_400 + 60,
    });
  });
  it('a refreshed chain, a chain restarted inside its deadline (another oracle), or no prior chain is not a lapse', () => {
    expect(lapsedChain(st(), st({ lastSeenAt: 9_000 }))).toBeNull();
    expect(lapsedChain(st(), st({ flaggedAt: 9_000 }))).toBeNull();
    expect(lapsedChain(st({ flaggedAt: 0, observeBy: 0 }), st({ flaggedAt: 99_999 }))).toBeNull();
  });
});

describe('sendSanctionsNotices', () => {
  let warned: string[];
  let env: Env;
  beforeEach(() => {
    env = { DB: createSharedD1().d1, KEEPER_DB: createKeeperD1().d1 } as unknown as Env;
    warned = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('names the owner, the transaction and each amount moved', async () => {
    const m: ValueMove = { owner: OWNER, fn: 'settleSanctionedInteractionRewards', tx: TX, heldApart: v('3'), forfeited: v('1.5'), stagedForfeited: 0n };
    await sendSanctionsNotices(env, CHAIN, [m], [], new Map(), Number.POSITIVE_INFINITY);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`settleSanctionedInteractionRewards for ${OWNER} (tx ${TX}) moved 3 VPFI set apart`);
    expect(warned[0]).toContain('1.5 VPFI forfeited into the recycle bucket');
    expect(warned[0]).not.toContain('staged');
  });

  it('tells each lapse the run saw, with the gap', async () => {
    const after = new Map([[OWNER.toLowerCase(), st({ flaggedAt: 5_000 + 2 * 86_400, lastSeenAt: 5_000 + 2 * 86_400 })]]);
    await sendSanctionsNotices(env, CHAIN, [], [st()], after, Number.POSITIVE_INFINITY);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(new RegExp(`evidence chain of ${OWNER} lapsed: .* \\(a 48\\.0h gap\\)`));
  });

  it('says nothing past the deadline', async () => {
    const m: ValueMove = { owner: OWNER, fn: 'x', tx: TX, heldApart: 1n, forfeited: 0n, stagedForfeited: 0n };
    await sendSanctionsNotices(env, CHAIN, [m], [], new Map(), 0);
    expect(warned).toEqual([]);
  });
});
