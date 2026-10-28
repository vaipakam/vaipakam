/**
 * #2984 — the keeper's close-out pass (`runRewardCloseOut`) on a Base/mirror
 * pair on Anvil, against the contracts' own closure proof.
 *
 * The cycle is the real one (`rewardCycle.ts`): a mirror loan accrues over
 * days 0 and 1 and is repaid on day 1; the keeper's day-close pass closes,
 * finalizes and broadcasts both days; the keeper's remit pass funds day 1 on
 * the mirror and its delivery-proof pass indexes the delivery. No chain state
 * is doctored. What it proves, in order:
 *
 *   1. Before anyone claims, the pass proves closed every elapsed day with
 *      nothing outstanding (both days on Base, day 0 on the mirror) and leaves
 *      the mirror's day 1, whose reward entries are not yet claimed. It sends
 *      nothing for that day and parks nothing.
 *   2. After the lender and the borrower claim, the next run proves the
 *      mirror's day 1 closed through the contract's own walk (a start, then a
 *      page per side) and parks the remainder of the transport epoch that
 *      carried it, for the administrator's release.
 *   3. A further run sends nothing on either chain.
 *   Every transaction is the keeper's, to a Diamond, and no operator alert is
 *   raised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import type { Party } from '@vaipakam/anvil-harness/scenarioChain';
import { runDeliveryProof } from '../../../src/deliveryProof';
import { runRewardBudgetRemit } from '../../../src/rewardBudgetRemit';
import { PASS_CADENCE_SEC, runRewardCloseOut } from '../../../src/rewardCloseOut';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../../harness/keeperEnv';
import { collectOpsAlerts, type OpsAlertLog } from '../../harness/opsAlerts';
import { claimUntilPaid } from '../claims';
import { openMeshScenario, type MeshChain, type MeshScenario } from '../mesh';
import { closeAndFinalizeDays, FIVE_MIN_MS, transactionsSince } from '../rewardCycle';
import { BASE_ID, MIRROR_ID } from '../fixture';

const DAY = 86_400;
const HOUR = 3_600;
const CLOSE_OUT_MS = PASS_CADENCE_SEC * 1000;

let m: MeshScenario;
let k: KeeperHarness;
let alerts: OpsAlertLog;
/** The transport epoch that carried day 1 to the mirror. */
let batchId: Hex;

beforeAll(async () => {
  m = await openMeshScenario();
  k = await keeperEnvFor([m.base, m.mirror], ['REWARD_DAY_CLOSE_ENABLED', 'REWARD_REMIT_ENABLED', 'REWARD_DELIVERY_PROOF_ENABLED', 'REWARD_CLOSE_OUT_ENABLED'], { indexer: true });
  alerts = collectOpsAlerts();
});

afterAll(async () => {
  await m?.stop();
});

async function warpToDay(day: number, hour: number, extra = 0): Promise<void> {
  const target = m.fixture.interactionLaunchTimestamp + day * DAY + hour * HOUR + extra;
  const now = Math.max(await m.base.now(), await m.mirror.now());
  if (target <= now) throw new Error(`cannot warp back to day ${day} +${hour}h`);
  await m.warp(target - now);
}

function closed(sc: MeshChain, day: number): Promise<boolean> {
  return sc.read<boolean>('isDayObligationsClosed', [BigInt(day)]);
}

/** One close-out run on both chains, with what each chain mined during it. */
async function closeOut(): Promise<{ base: { from: string; to: string | null }[]; mirror: { from: string; to: string | null }[] }> {
  await m.syncClock();
  const b = await m.base.blockNumber();
  const mi = await m.mirror.blockNumber();
  await runRewardCloseOut(k.env, tickNow(CLOSE_OUT_MS));
  return { base: await transactionsSince(m.base, b), mirror: await transactionsSince(m.mirror, mi) };
}

function expectKeeperOnly(txs: { from: string; to: string | null }[], sc: MeshChain): void {
  const keeper = m.base.address('keeper').toLowerCase();
  for (const t of txs) {
    expect(t.from.toLowerCase()).toBe(keeper);
    expect(t.to?.toLowerCase()).toBe(sc.diamond.toLowerCase());
  }
}

describe('the close-out pass on a Base/mirror pair', () => {
  it('runs the real cycle: a repaid mirror loan, days closed and finalized, day 1 delivered and indexed', async () => {
    const loan = await openLoan(m.mirror, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });
    await warpToDay(1, 20);
    await repayInFull(m.mirror, 'borrower', loan.loanId);
    await warpToDay(2, 0, 60);
    await closeAndFinalizeDays(m, k);

    await m.syncClock();
    const from = await m.base.blockNumber();
    await runRewardBudgetRemit(k.env, tickNow(FIVE_MIN_MS));
    const remitted = (await m.base.diamondEvents('RewardBudgetRemitted', from + 1n)).filter((e) => Number(e.args.dstChainId) === MIRROR_ID);
    expect(remitted).toHaveLength(1);
    const delivered = await m.relay.deliver(BASE_ID, MIRROR_ID);
    expect(delivered).toHaveLength(1);
    const receipt = await m.mirror.pub.getTransactionReceipt({ hash: delivered[0].destinationTx });
    const admitted = m.mirror.decodeDiamondLogs(receipt.logs).filter((e) => e.eventName === 'TransportBatchAdmitted');
    expect(admitted).toHaveLength(1);
    batchId = admitted[0].args.batchId as Hex;
    await m.warp(60);
    await k.indexer!.index();
    await m.syncClock();
    await runDeliveryProof(k.env, tickNow(FIVE_MIN_MS));
    const [, , , dayCount, indexedDays] = await m.mirror.read<readonly [Hex, bigint, bigint, number, number, boolean]>('getTransportBatch', [batchId]);
    expect(Number(indexedDays)).toBe(Number(dayCount));
    expect(alerts.texts).toEqual([]);
  });

  it('closes every day with nothing outstanding and leaves the mirror day its users have not claimed', async () => {
    for (const day of [0, 1]) {
      expect(await closed(m.base, day)).toBe(false); // eslint-disable-line no-await-in-loop
      expect(await closed(m.mirror, day)).toBe(false); // eslint-disable-line no-await-in-loop
    }
    const txs = await closeOut();
    expect(await closed(m.base, 0)).toBe(true);
    expect(await closed(m.base, 1)).toBe(true);
    expect(await closed(m.mirror, 0)).toBe(true);
    expect(await closed(m.mirror, 1), 'a day whose reward entries are unclaimed is not closed').toBe(false);
    // Base has no reward entries: each day closes at its start, one send each.
    expect(txs.base).toHaveLength(2);
    expect(txs.mirror).toHaveLength(1);
    expectKeeperOnly(txs.base, m.base);
    expectKeeperOnly(txs.mirror, m.mirror);
    const [, parkedDays] = await m.mirror.read<readonly [bigint, number, boolean, bigint]>('getTransportRemainder', [batchId]);
    expect(Number(parkedDays), 'nothing is parked while day 1 is open').toBe(0);
    expect(alerts.texts).toEqual([]);
  });

  it('after both parties claim, proves the mirror day closed and parks its epoch\'s remainder', async () => {
    for (const who of ['lender', 'borrower'] as Party[]) {
      expect(await claimUntilPaid(m.mirror, who)).toBeGreaterThan(0n); // eslint-disable-line no-await-in-loop
    }
    const txs = await closeOut();
    expect(await closed(m.mirror, 1)).toBe(true);
    expect(txs.base).toEqual([]);
    expectKeeperOnly(txs.mirror, m.mirror);
    // A start, a page per side, then the park.
    expect(txs.mirror).toHaveLength(4);
    const [, parkedDays] = await m.mirror.read<readonly [bigint, number, boolean, bigint]>('getTransportRemainder', [batchId]);
    expect(Number(parkedDays)).toBeGreaterThan(0);
    expect(alerts.texts).toEqual([]);
  });

  it('sends nothing more on either chain', async () => {
    const txs = await closeOut();
    expect(txs.base).toEqual([]);
    expect(txs.mirror).toEqual([]);
    expect(alerts.texts).toEqual([]);
  });
});
