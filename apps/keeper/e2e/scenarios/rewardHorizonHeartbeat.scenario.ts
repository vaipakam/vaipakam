/**
 * #2517 item 5 — the claim-horizon heartbeat, end to end on Anvil.
 *
 * The REAL pass (`runRewardHorizonHeartbeat`, exactly as the scheduler calls
 * it) against the repository's current contracts, deployed from source and
 * configured as a canonical reward chain. What it proves, in order:
 *
 *   1. While the horizon is DARK the pass only discovers: it queues the
 *      loan's two reward entries in its private database and sends nothing.
 *   2. Once an operator arms `setRewardClaimHorizonDays(180)`, the pass's
 *      touches start each entry's executable clock (`RewardEntryHorizonStamped`).
 *   3. Heartbeats across the horizon — chain time moved in steps inside the
 *      contract's seven-day maximum observation gap, the keeper's clock moved
 *      with it — accrue that clock to the horizon: `RewardEntryExpiryArmed`
 *      (the final notice) is emitted for both entries, and its notice start
 *      lies 180 days of executable time after the stamp.
 *   4. Heartbeats across the 90-day notice then reach removal:
 *      `RewardEntryExpiryBegun` and `RewardEntryExpired`. The recycle
 *      bucket moves by exactly the ExpiredReward credits the accounting
 *      events record (`VpfiRecycled`), and the entries are settled
 *      (processed on chain, gone from the keeper's queue).
 *   5. Nothing went wrong along the way: the pass raised no operator alert.
 *
 * Every transaction that moves an entry is the keeper's own: the scenario's
 * only writes are the loan, the day closes, and the operator's arming.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRewardHorizonHeartbeat } from '../../src/rewardHorizonHeartbeat';
import { openScenario, type DecodedEvent, type ScenarioChain } from '../harness/chain';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../harness/keeperEnv';
import { collectOpsAlerts, type OpsAlertLog } from '../harness/opsAlerts';
import { openLoan, repayInFull } from '../harness/lending';
import { finalizeThrough } from '../harness/rewardDays';
import { openRecycleWindow } from '../harness/recycle';

const DAY = 86_400;
const HORIZON_DAYS = 180;
const NOTICE_DAYS = 90;
/** Inside the contract's maximum observation gap (7 days), with margin. */
const STEP_SEC = 6 * DAY;
/** `LibVpfiRecycle.RecycleSource.ExpiredReward`. */
const EXPIRED_REWARD = 8;

let sc: ScenarioChain;
let k: KeeperHarness;
let alerts: OpsAlertLog;

beforeAll(async () => {
  sc = await openScenario();
  k = await keeperEnvFor(sc, ['REWARD_HORIZON_HEARTBEAT_ENABLED']);
  alerts = collectOpsAlerts();
});

afterAll(async () => {
  await sc?.stop();
});

async function heartbeat(): Promise<void> {
  await sc.syncClock();
  await runRewardHorizonHeartbeat(k.env, tickNow());
}

function queued(): number[] {
  return (
    k.keeperDb.db
      .prepare('SELECT entry_id FROM keeper_horizon_entry WHERE chain_id = ? AND lower(diamond) = lower(?) ORDER BY entry_id')
      .all(sc.chain.id, sc.diamond) as { entry_id: number | string }[]
  ).map((r) => Number(r.entry_id));
}

function byEntry(events: DecodedEvent[]): Map<number, DecodedEvent> {
  return new Map(events.map((e) => [Number(e.args.entryId as bigint), e]));
}

describe('rewardHorizonHeartbeat on a canonical Anvil chain', () => {
  let entryIds: number[] = [];
  let startBlock = 0n;

  it('discovers the reward entries while the horizon is dark, and sends nothing', async () => {
    const loan = await openLoan(sc, {
      lender: 'lender',
      borrower: 'borrower',
      principalWeth: '1',
      collateralTliq: '5',
      rateBps: 1000,
      days: 30,
    });
    startBlock = loan.acceptBlock;
    // Accrue whole reward days, close the loan, let the closing day elapse.
    await sc.warp(3 * DAY);
    await repayInFull(sc, 'borrower', loan.loanId);
    await sc.warp(DAY + 60);
    await finalizeThrough(sc, (await sc.rewardDay()) - 1);

    const lenderIds = (await sc.read<readonly bigint[]>('getUserRewardEntryIds', [sc.address('lender')])).map(Number);
    const borrowerIds = (await sc.read<readonly bigint[]>('getUserRewardEntryIds', [sc.address('borrower')])).map(Number);
    entryIds = [...lenderIds, ...borrowerIds].sort((a, b) => a - b);
    expect(entryIds).toHaveLength(2);
    expect(await sc.read<number>('getRewardClaimHorizonDays')).toBe(0);

    const before = await sc.blockNumber();
    await heartbeat();
    expect(queued()).toEqual(entryIds);
    // Dark horizon: no touch was sent, so no clock started.
    expect(await sc.diamondEvents('RewardEntryHorizonStamped', before)).toHaveLength(0);
    const nonce = await sc.pub.getTransactionCount({ address: sc.address('keeper') });
    expect(nonce).toBe(0);
  });

  it('starts each entry clock on the first heartbeat after the horizon is armed', async () => {
    await sc.diamondWrite('admin', 'setRewardClaimHorizonDays', [HORIZON_DAYS]);
    expect(await sc.read<number>('getRewardClaimHorizonDays')).toBe(HORIZON_DAYS);
    await sc.warp(12 * 3600);
    await heartbeat();
    const stamped = byEntry(await sc.diamondEvents('RewardEntryHorizonStamped', startBlock));
    expect([...stamped.keys()].sort((a, b) => a - b)).toEqual(entryIds);
    for (const id of entryIds) {
      const [firstClaimableAt, expiresAt] = await sc.read<readonly [bigint, bigint]>('getRewardEntryExpiry', [BigInt(id)]);
      expect(firstClaimableAt).toBeGreaterThan(0n);
      expect(expiresAt).toBeGreaterThan(firstClaimableAt);
    }
  });

  it('arms the final notice once the horizon of executable time has accrued, then removes the entries after the notice', async () => {
    const stamped = byEntry(await sc.diamondEvents('RewardEntryHorizonStamped', startBlock));
    // The sweep's window: only heartbeats and clock moves happen in it.
    const sweep = await openRecycleWindow(sc);
    let armed = new Map<number, DecodedEvent>();
    let begun = new Map<number, DecodedEvent>();
    // Bounded: horizon + notice in STEP_SEC steps, plus slack.
    const maxSteps = Math.ceil(((HORIZON_DAYS + NOTICE_DAYS) * DAY) / STEP_SEC) + 5;
    let steps = 0;
    while (begun.size < entryIds.length && steps < maxSteps) {
      await sc.warp(STEP_SEC);
      await heartbeat();
      steps += 1;
      armed = byEntry(await sc.diamondEvents('RewardEntryExpiryArmed', startBlock));
      begun = byEntry(await sc.diamondEvents('RewardEntryExpiryBegun', startBlock));
      // Removal never precedes the final notice.
      for (const id of begun.keys()) expect(armed.has(id)).toBe(true);
    }
    console.log(`[keeper-e2e] horizon: ${steps} heartbeats of ${STEP_SEC / DAY} days reached removal`);
    expect([...armed.keys()].sort((a, b) => a - b)).toEqual(entryIds);
    expect([...begun.keys()].sort((a, b) => a - b)).toEqual(entryIds);

    for (const id of entryIds) {
      // The final notice starts a full horizon of executable time after the
      // clock started: every interval was observed inside the gap, so none
      // was dropped (the contract reports the TRUE crossing instant).
      const stampAt = Number((await sc.pub.getBlock({ blockNumber: stamped.get(id)!.blockNumber })).timestamp);
      const noticeFrom = Number(armed.get(id)!.args.finalNoticeFrom as bigint);
      expect(noticeFrom - stampAt).toBe(HORIZON_DAYS * DAY);
      // Removal came only after the full notice had also accrued.
      const begunAt = Number((await sc.pub.getBlock({ blockNumber: begun.get(id)!.blockNumber })).timestamp);
      expect(begunAt - noticeFrom).toBeGreaterThanOrEqual(NOTICE_DAYS * DAY);
      // Every armed/begun transaction was sent by the keeper.
      for (const ev of [armed.get(id)!, begun.get(id)!]) {
        const tx = await sc.pub.getTransaction({ hash: ev.transactionHash });
        expect(tx.from.toLowerCase()).toBe(sc.address('keeper').toLowerCase());
      }
    }

    // The expired value went to the recycle bucket. `RewardEntryExpired` is
    // the entry's face value and is deliberately non-accounting; the amount
    // the bucket was credited is what the accounting events say, so the
    // bucket's movement over the sweep must equal exactly the ExpiredReward
    // credits those events record, and no other credit class may appear.
    const expired = await sc.diamondEvents('RewardEntryExpired', startBlock);
    expect(new Set(expired.map((e) => Number(e.args.entryId as bigint)))).toEqual(new Set(entryIds));
    const expiredTotal = expired.reduce((a, e) => a + BigInt(e.args.total as bigint), 0n);
    const r = await sweep.close();
    console.log(`[keeper-e2e] horizon: expired face value ${expiredTotal} wei, credited to the bucket ${r.credited} wei`);
    expect([...r.creditedBySource.keys()]).toEqual([EXPIRED_REWARD]);
    expect(r.consumed).toBe(0n);
    expect(r.debits).toHaveLength(0);
    expect(r.credited).toBeGreaterThan(0n);
    expect(r.bucketDelta).toBe(r.credited);
    // The credit is the fresh share of what expired; it cannot exceed the face value.
    expect(r.credited).toBeLessThanOrEqual(expiredTotal);

    // One more heartbeat reads the settled entries and drops them from the queue.
    await sc.warp(12 * 3600);
    await heartbeat();
    expect(queued()).toEqual([]);

    // Every touch landed and every clock advanced: across the whole run the
    // pass raised no alert (no refused touch, no overdue entry, no clock that
    // failed to advance).
    expect(alerts.texts).toEqual([]);
  });
});
