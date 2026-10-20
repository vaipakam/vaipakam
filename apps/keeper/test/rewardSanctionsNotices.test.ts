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
import { applyLateOutcome, lapseRestartLine, readLedger, reconcileSent, sendSanctionsNotices, storedChainLapsed, valueMoveLines, valueMovesOf, type OutcomeMaps, type OwnerSanctionsStatus, type SentTx, type ValueMove } from '../src/rewardSanctionsHold';
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

describe('valueMoveLines', () => {
  it('one line per figure, each naming the call, owner and transaction; the forfeited payout and the credit stated as OVERLAPPING', () => {
    const lines = valueMoveLines(move({ heldApart: v('1'), stagedForfeitFresh: v('2'), stagedForfeitRecycled: v('1'), recycleCredit: v('2') }));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l.startsWith(`resolveStagedDayPage for ${OWNER} (tx ${TX}): `)).toBe(true);
      // Inside the digest's per-line cap, so no figure is cut.
      expect(l.length).toBeLessThanOrEqual(600);
    }
    expect(lines[1]).toContain("the owner's staged payout of 3 VPFI forfeited (its event's split: 2 VPFI fresh, 1 VPFI recycled)");
    expect(lines[1]).toContain('the two figures overlap and are not to be added');
    expect(lines[2]).toContain("credited 2 VPFI to the recycle bucket as forfeited reward (every such credit it made, not only this owner's)");
  });

  it('says so when a forfeited staged payout came with no bucket credit', () => {
    expect(valueMoveLines(move({ stagedForfeitRecycled: v('1') }))[0]).toContain('this transaction made no forfeited-reward credit to the recycle bucket');
  });

  it("names a set-apart and a payment as the owner's", () => {
    const lines = valueMoveLines(move({ fn: 'settleSanctionedInteractionRewards', heldApart: v('3'), paidWallet: v('1') }));
    expect(lines[0]).toContain('3 VPFI set apart for the owner');
    expect(lines[1]).toContain("1 VPFI paid to the owner's wallet");
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
const restartLog = () => log(DIAMOND, 'RewardSanctionsEvidenceRecorded', { who: OWNER, oracle: ORACLE, flaggedAt: BigInt(RESTART), forfeitableAt: BigInt(RESTART + 3 * 86_400) });
const TX2 = `0x${'8'.repeat(64)}` as Hex;
const TX3 = `0x${'9'.repeat(64)}` as Hex;
const sent = (fn: string, tx: Hex, receipt?: SentTx['receipt'], late?: boolean): SentTx => ({ owner: OWNER.toLowerCase(), fn, tx, receipt, late });

describe('readLedger', () => {
  it('reads value moves, restarts from the receipt\'s own event, late reverts and the unknown, by one rule', () => {
    const ledger = readLedger(
      [
        sent('settleSanctionedInteractionRewards', TX, { status: 'success', logs: [log(DIAMOND, 'RewardSanctionsHeldApart', { user: OWNER, amount: v('3'), heldBalance: v('3') })] }),
        sent('recordRewardSanctionsEvidence', TX2, { status: 'success', logs: [restartLog(), log(OTHER, 'RewardSanctionsEvidenceRecorded', { who: SOMEONE, oracle: ORACLE, flaggedAt: 1n, forfeitableAt: 2n })] }, true),
        sent('resolveStagedDayPage', TX3, { status: 'reverted', logs: [] }, true),
        sent('resolveDomainPage', TX3, { status: 'reverted', logs: [] }),
        sent('resolveStagedDayPage', TX),
      ],
      DIAMOND,
    );
    expect(ledger.moves).toEqual([expect.objectContaining({ tx: TX, heldApart: v('3') })]);
    expect([...ledger.restarts]).toEqual([[OWNER.toLowerCase(), RESTART]]);
    // Only receipts seen at reconciliation are late; one seen in the send's
    // own wait was already applied there.
    expect(ledger.late.map((t) => t.fn)).toEqual(['recordRewardSanctionsEvidence', 'resolveStagedDayPage']);
    expect(ledger.unknown.map((t) => t.fn)).toEqual(['resolveStagedDayPage']);
  });
});

describe('applyLateOutcome', () => {
  const maps = (): OutcomeMaps => ({ settleFailed: new Map(), settleOk: new Set(), stagingStuck: new Map(), stagingClear: new Set() });
  const o = OWNER.toLowerCase();
  it('a late LANDED settlement may clear its failure alert, as an immediate one does', () => {
    const m = maps();
    applyLateOutcome(m, sent('settleSanctionedInteractionRewards', TX, { status: 'success', logs: [] }, true));
    expect([...m.settleOk]).toEqual([o]);
    expect(m.settleFailed.size).toBe(0);
  });
  it('a late REVERTED settlement is a named failure', () => {
    const m = maps();
    m.settleOk.add(o);
    applyLateOutcome(m, sent('settleSanctionedInteractionRewards', TX, { status: 'reverted', logs: [] }, true));
    expect(m.settleFailed.get(o)).toContain(TX);
    expect(m.settleOk.has(o)).toBe(false);
  });
  it('a late reverted page is wedged; a late landed page clears nothing by itself', () => {
    const m = maps();
    applyLateOutcome(m, sent('resolveDomainPage', TX, { status: 'success', logs: [] }, true));
    expect(m.stagingClear.size + m.stagingStuck.size).toBe(0);
    m.stagingClear.add(o);
    applyLateOutcome(m, sent('resolveStagedDayPage', TX, { status: 'reverted', logs: [] }, true));
    expect(m.stagingStuck.get(o)).toBe(1);
    expect(m.stagingClear.has(o)).toBe(false);
  });
  it('an observation, or a send still without a receipt, moves no alert state', () => {
    const m = maps();
    applyLateOutcome(m, sent('recordRewardSanctionsEvidence', TX, { status: 'reverted', logs: [] }, true));
    applyLateOutcome(m, sent('settleSanctionedInteractionRewards', TX));
    expect(m).toEqual(maps());
  });
});

describe('reconcileSent', () => {
  it('asks again for every missing receipt at once, and marks what arrives as late', async () => {
    const xs = [sent('settleSanctionedInteractionRewards', TX), sent('resolveStagedDayPage', TX2), sent('resolveDomainPage', TX3, { status: 'success', logs: [] })];
    const asked: string[] = [];
    await reconcileSent(
      xs,
      async (tx) => {
        asked.push(tx);
        if (tx === TX2) throw new Error('not found');
        return { status: 'success', logs: [] };
      },
      Date.now() + 5_000,
    );
    expect(asked).toEqual([TX, TX2]);
    expect(xs[0]).toMatchObject({ receipt: { status: 'success' }, late: true });
    expect(xs[1].receipt).toBeUndefined();
    expect(xs[2].late).toBeUndefined();
  });

  it('a stalled receipt read costs no more than the cutoff, and stays unknown', async () => {
    const xs = [sent('settleSanctionedInteractionRewards', TX)];
    const t0 = Date.now();
    await reconcileSent(xs, () => new Promise(() => {}), Date.now() + 50);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(xs[0].receipt).toBeUndefined();
  });
});

describe('lapseRestartLine', () => {
  it("states the gap as a bound, as a figure only when the new chain's own pair was read", () => {
    expect(lapseRestartLine(OWNER, RESTART, RESTARTED)).toContain('more than 24.0h (the contract\'s maximum gap) before that observation');
    expect(lapseRestartLine(OWNER, RESTART, null)).toContain("more than the contract's maximum observation gap before that observation");
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
  const ledgerOf = (xs: SentTx[]) => readLedger(xs, DIAMOND);

  it('journals every notice — the moves and a restart its receipt proves, even with no post-write read — and makes ONE post', async () => {
    const ledger = ledgerOf([
      sent('settleSanctionedInteractionRewards', TX, { status: 'success', logs: [log(DIAMOND, 'RewardSanctionsHeldApart', { user: OWNER, amount: v('3'), heldBalance: v('3') })] }),
      sent('recordRewardSanctionsEvidence', TX2, { status: 'success', logs: [restartLog()] }, true),
    ]);
    await sendSanctionsNotices(env, CHAIN, ledger, [LAPSED], new Map(), Number.POSITIVE_INFINITY);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain('2 notices this run');
    expect(logged[1]).toContain(`${OWNER}: its evidence chain had lapsed`);
    expect(logged[1]).toContain("more than the contract's maximum observation gap");
    // The ops channel is unconfigured here: one undelivered post, not one per notice.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('ops notice NOT delivered');
    expect(warned[0]).toContain('2 lines');
  });

  it('past the deadline, still journals every notice and says it was not posted', async () => {
    const ledger = { ...ledgerOf([]), moves: [move({ heldApart: 1n })] };
    await sendSanctionsNotices(env, CHAIN, ledger, [], new Map(), 0);
    expect(logged).toHaveLength(1);
    expect(warned).toEqual([expect.stringContaining("not posted, past the run's alert window")]);
  });

  it('says a value-moving send whose outcome is unknown, but not a bare observation', async () => {
    await sendSanctionsNotices(env, CHAIN, ledgerOf([sent('settleSanctionedInteractionRewards', TX), sent('recordRewardSanctionsEvidence', TX2)]), [], new Map(), Number.POSITIVE_INFINITY);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`settleSanctionedInteractionRewards for ${OWNER.toLowerCase()} (tx ${TX}): its receipt was not seen`);
    expect(logged[0]).toContain('UNKNOWN');
  });

  it('a lapsed chain whose observation is still unknown is said; one nothing was sent for is left to the alerts', async () => {
    await sendSanctionsNotices(env, CHAIN, ledgerOf([sent('recordRewardSanctionsEvidence', TX)]), [LAPSED], new Map(), Number.POSITIVE_INFINITY);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`its evidence chain had lapsed (unobserved past the contract's maximum gap). This run's recordRewardSanctionsEvidence (tx ${TX}) was not seen`);
    logged.length = 0;
    await sendSanctionsNotices(env, CHAIN, ledgerOf([]), [LAPSED], new Map(), Number.POSITIVE_INFINITY);
    expect(logged).toEqual([]);
  });

  it('a run with nothing to tell says nothing', async () => {
    await sendSanctionsNotices(env, CHAIN, ledgerOf([]), [st()], new Map([[OWNER.toLowerCase(), st({ lastSeenAt: 9_000 })]]), Number.POSITIVE_INFINITY);
    expect(logged).toEqual([]);
    expect(warned).toEqual([]);
  });
});
