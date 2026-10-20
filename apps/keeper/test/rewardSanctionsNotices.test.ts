/**
 * #2515 item 5 — the sanctions pass's one-off notices: a landed settlement or
 * staging resolution that MOVED value, named with the amounts its own receipt's
 * events state, and a lapsed evidence chain the run saw restart, all in ONE
 * bounded post sent after the standing alerts (Codex #2602 r1). The receipt
 * logs are encoded from the compiled Diamond ABI, so a renamed or reshaped
 * event fails here rather than reading as "nothing moved".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseUnits, type Abi, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { restartedLapse, sendSanctionsNotices, settlePending, storedChainLapsed, valueMoveLine, valueMovesOf, type OwnerSanctionsStatus, type ValueMove } from '../src/rewardSanctionsHold';
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
  it("reads each figure from its own event: owner-named ones only for the owner, the recycle credit for the whole transaction, Diamond logs only", () => {
    const logs = [
      log(DIAMOND, 'RewardSanctionsHeldApart', { user: OWNER, amount: v('3'), heldBalance: v('3') }),
      log(DIAMOND, 'RewardSanctionsHeldApart', { user: SOMEONE, amount: v('100'), heldBalance: v('100') }),
      log(DIAMOND, 'StagingDelivered', { key: `0x${'2'.repeat(64)}`, user: OWNER, amount: v('4'), venue: 2 }),
      log(DIAMOND, 'StagingDelivered', { key: `0x${'3'.repeat(64)}`, user: OWNER, amount: v('7'), venue: 3 }),
      log(DIAMOND, 'StagingDelivered', { key: `0x${'4'.repeat(64)}`, user: SOMEONE, amount: v('8'), venue: 1 }),
      log(DIAMOND, 'VpfiRecycled', { source: 0, refId: 0n, amount: v('1.5'), dayId: 7n }),
      log(DIAMOND, 'VpfiRecycled', { source: 2, refId: 0n, amount: v('9'), dayId: 7n }),
      log(DIAMOND, 'VpfiRecycledPreLaunch', { source: 0, refId: 0n, amount: v('0.5') }),
      log(DIAMOND, 'StagingClaimantForfeited', { key: `0x${'1'.repeat(64)}`, user: OWNER, fresh: v('2'), recycled: v('1') }),
      log(OTHER, 'VpfiRecycled', { source: 0, refId: 0n, amount: v('50'), dayId: 7n }),
    ];
    expect(valueMovesOf(logs, DIAMOND, OWNER)).toEqual({
      heldApart: v('3'),
      paidWallet: 0n,
      // A SanctionsHeld delivery (venue 3) is not a payment: its held-apart event tells it.
      paidVault: v('4'),
      stagedForfeitFresh: v('2'),
      stagedForfeitRecycled: v('1'),
      recycleCredit: v('2'),
    });
  });

  it('reads nothing moved from a receipt with no such events', () => {
    expect(valueMovesOf([], DIAMOND, OWNER)).toEqual({ heldApart: 0n, paidWallet: 0n, paidVault: 0n, stagedForfeitFresh: 0n, stagedForfeitRecycled: 0n, recycleCredit: 0n });
  });
});

const move = (over: Partial<ValueMove> = {}): ValueMove => ({
  owner: OWNER,
  fn: 'resolveStagedDayPage',
  tx: TX,
  heldApart: 0n,
  paidWallet: 0n,
  paidVault: 0n,
  stagedForfeitFresh: 0n,
  stagedForfeitRecycled: 0n,
  recycleCredit: 0n,
  ...over,
});

describe('valueMoveLine', () => {
  it('states a forfeited staged payout and the recycle credit as OVERLAPPING, never as two moves', () => {
    const line = valueMoveLine(move({ stagedForfeitFresh: v('2'), stagedForfeitRecycled: v('1'), recycleCredit: v('2') }));
    expect(line).toContain(`resolveStagedDayPage for ${OWNER} (tx ${TX}): the owner's staged payout of 3 VPFI forfeited (its event's split: 2 VPFI fresh, 1 VPFI recycled)`);
    expect(line).toContain('the two figures overlap and are not to be added');
    expect(line).toContain("credited 2 VPFI to the recycle bucket as forfeited reward (every such credit it made, not only this owner's)");
  });

  it('says so when a forfeited staged payout came with no bucket credit', () => {
    expect(valueMoveLine(move({ stagedForfeitRecycled: v('1') }))).toContain('this transaction made no forfeited-reward credit to the recycle bucket');
  });

  it('names a set-apart and a payment as the owner\'s', () => {
    const line = valueMoveLine(move({ fn: 'settleSanctionedInteractionRewards', heldApart: v('3'), paidWallet: v('1') }));
    expect(line).toContain('3 VPFI set apart for the owner');
    expect(line).toContain("1 VPFI paid to the owner's wallet");
    expect(line).not.toContain('staged');
  });
});

const ORACLE = '0x00000000000000000000000000000000000000c1';
const OTHER_ORACLE = '0x00000000000000000000000000000000000000c2';
const ZERO = '0x0000000000000000000000000000000000000000';

describe('storedChainLapsed', () => {
  const lapsed = { decision: 1, flaggedAt: 0, evidenceOracle: ORACLE, marker: true };
  it('a chain stored under the configured oracle, its marker standing, that reads as no live chain, lapsed', () => {
    expect(storedChainLapsed(lapsed, ORACLE)).toBe(true);
    expect(storedChainLapsed({ ...lapsed, decision: 2 }, ORACLE.toUpperCase().replace('0X', '0x'))).toBe(true);
  });
  it('a live chain, a foreign-oracle chain, a cleared marker, a Clean read, no chain or no oracle is not a lapse', () => {
    expect(storedChainLapsed({ ...lapsed, flaggedAt: 1_000 }, ORACLE)).toBe(false);
    expect(storedChainLapsed(lapsed, OTHER_ORACLE)).toBe(false);
    expect(storedChainLapsed({ ...lapsed, marker: false }, ORACLE)).toBe(false);
    expect(storedChainLapsed({ ...lapsed, decision: 0 }, ORACLE)).toBe(false);
    expect(storedChainLapsed({ ...lapsed, evidenceOracle: ZERO }, ORACLE)).toBe(false);
    expect(storedChainLapsed({ ...lapsed, evidenceOracle: ZERO }, ZERO)).toBe(false);
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
const LAPSED = st({ flaggedAt: 0, lastSeenAt: 0, forfeitableAt: 0, observeBy: 0, chainLapsed: true });
const RESTART = 200_000;
const RESTARTED = st({ flaggedAt: RESTART, lastSeenAt: RESTART, forfeitableAt: RESTART + 3 * 86_400, observeBy: RESTART + 86_400 });

describe('restartedLapse', () => {
  it('a lapsed chain read live after the run restarted, with the gap bound from the new chain\'s own pair', () => {
    expect(restartedLapse(LAPSED, RESTARTED)).toEqual({ restartedAt: RESTART, maxGapSec: 86_400 });
  });
  it('no lapse before, an unknown lapse, or no live chain after is not told', () => {
    expect(restartedLapse(st(), RESTARTED)).toBeNull();
    expect(restartedLapse({ ...LAPSED, chainLapsed: undefined }, RESTARTED)).toBeNull();
    expect(restartedLapse(LAPSED, LAPSED)).toBeNull();
  });
});

describe('settlePending', () => {
  const p = (fn: string, tx: Hex) => ({ owner: OWNER.toLowerCase(), fn, tx });
  const TX2 = `0x${'8'.repeat(64)}` as Hex;
  const TX3 = `0x${'9'.repeat(64)}` as Hex;
  it('a late receipt is read like any other; a reverted one moved nothing; an unseen one stays UNKNOWN', async () => {
    const receipts: Record<string, { status: string; logs: Log[] }> = {
      [TX]: { status: 'success', logs: [log(DIAMOND, 'RewardSanctionsHeldApart', { user: OWNER, amount: v('3'), heldBalance: v('3') })] },
      [TX2]: { status: 'reverted', logs: [] },
    };
    const out = await settlePending(
      [p('settleSanctionedInteractionRewards', TX), p('resolveStagedDayPage', TX2), p('resolveStagedDayPage', TX3)],
      async (tx) => {
        const r = receipts[tx];
        if (!r) throw new Error('receipt not found');
        return r;
      },
      DIAMOND,
      Number.POSITIVE_INFINITY,
    );
    expect(out.moves).toEqual([expect.objectContaining({ tx: TX, heldApart: v('3') })]);
    expect(out.unknown).toEqual([p('resolveStagedDayPage', TX3)]);
  });
  it('past the deadline, every pending send stays unknown', async () => {
    const out = await settlePending([p('resolveStagedDayPage', TX)], async () => ({ status: 'success', logs: [] }), DIAMOND, 0);
    expect(out.unknown).toHaveLength(1);
  });
});

describe('sendSanctionsNotices', () => {
  let logged: string[];
  let warned: string[];
  let env: Env;
  beforeEach(() => {
    env = { DB: createSharedD1().d1, KEEPER_DB: createKeeperD1().d1 } as unknown as Env;
    logged = [];
    warned = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  it('journals every notice, the moves and the restarted lapse, and makes ONE post for them', async () => {
    const after = new Map([[OWNER.toLowerCase(), RESTARTED]]);
    await sendSanctionsNotices(env, CHAIN, [move({ heldApart: v('3') }), move({ paidVault: v('1') })], [LAPSED], after, Number.POSITIVE_INFINITY);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toContain('3 notices this run');
    expect(logged[2]).toMatch(new RegExp(`${OWNER}: its evidence chain had lapsed .* more than 24\\.0h before that observation`));
    // The ops channel is unconfigured here: one undelivered post, not one per notice.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('ops notice NOT delivered');
    expect(warned[0]).toContain('3 lines');
  });

  it('past the deadline, still journals every notice and says it was not posted', async () => {
    await sendSanctionsNotices(env, CHAIN, [move({ heldApart: 1n })], [], new Map(), 0);
    expect(logged).toHaveLength(1);
    expect(warned).toEqual([expect.stringContaining('not posted, past the run\'s alert window')]);
  });

  it('says a value-moving send whose outcome is unknown, but not an observation', async () => {
    const unknown = [
      { owner: OWNER.toLowerCase(), fn: 'settleSanctionedInteractionRewards', tx: TX },
      { owner: OWNER.toLowerCase(), fn: 'recordRewardSanctionsEvidence', tx: TX },
    ];
    await sendSanctionsNotices(env, CHAIN, [], [], new Map(), Number.POSITIVE_INFINITY, unknown);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`settleSanctionedInteractionRewards for ${OWNER.toLowerCase()} (tx ${TX}): its receipt was not seen`);
    expect(logged[0]).toContain('UNKNOWN');
  });

  it('a run with nothing to tell says nothing', async () => {
    await sendSanctionsNotices(env, CHAIN, [], [st()], new Map([[OWNER.toLowerCase(), st({ lastSeenAt: 9_000 })]]), Number.POSITIVE_INFINITY);
    expect(logged).toEqual([]);
    expect(warned).toEqual([]);
  });
});
