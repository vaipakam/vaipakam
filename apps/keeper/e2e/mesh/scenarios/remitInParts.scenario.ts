/**
 * #2961 case 6 (#918, #2960) — one reward day sent to the mirror in THREE
 * parts, by the keeper's own passes, across a Base/mirror pair on Anvil.
 *
 * The cycle is the real one (`rewardCycle.ts`): a mirror loan accrues over
 * days 0 and 1 and is repaid on day 1, and the keeper's day-close pass closes,
 * finalizes and broadcasts both days. The only thing the scenario sets is the
 * operator's part ceiling, `REWARD_REMIT_LANE_CAP`: just over a third of day
 * 1's slice as Base quotes it, so the keeper's remit pass must send the day in
 * three parts — two at the ceiling and the completing remainder. No chain
 * state is doctored; the relay carries only what each remit put on the lane.
 *
 * What it proves, in order:
 *   1. Each remit run sends exactly one part, the keeper's own transaction,
 *      never above the ceiling; the parts sum to the slice Base quoted.
 *   2. After each of the first two parts — relayed, and counted by the
 *      mirror's ingress in the transaction it arrives in (#2828) — the mirror
 *      still holds the day (not landed, no landing time), Base's ledger for
 *      the day is not whole, Base lists the day as open, and a claim on the
 *      mirror pays nothing.
 *   3. The third part makes both ends agree at once: Base's ledger reads
 *      whole and the day leaves Base's open-day list, and the mirror shows the
 *      day landed, every component equal to the whole Base declared, over
 *      three counted parts with no conflicting whole.
 *   4. A further remit run sends nothing.
 *   5. The lender and the borrower each claim on the mirror and are paid,
 *      in VPFI, out of the delivered day (a first claim that defers into its
 *      staging domain is stepped home permissionlessly, as on a live chain).
 *   No operator alert is raised at any point.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import type { Party } from '@vaipakam/anvil-harness/scenarioChain';
import { runRewardBudgetRemit } from '../../../src/rewardBudgetRemit';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../../harness/keeperEnv';
import { collectOpsAlerts, type OpsAlertLog } from '../../harness/opsAlerts';
import { claimUntilPaid, simulatedClaim } from '../claims';
import { openMeshScenario, type MeshScenario } from '../mesh';
import { closeAndFinalizeDays, FIVE_MIN_MS } from '../rewardCycle';
import { BASE_ID, MIRROR_ID } from '../fixture';

const DAY = 86_400;
const HOUR = 3_600;
/** The day whose slice moves: day 0 is never remitted. */
const DAY_ID = 1n;
const PARTS = 3;

interface DayLedger {
  wholeFresh: bigint;
  wholeRecycled: bigint;
  sentFresh: bigint;
  sentRecycled: bigint;
  residualRemitId: bigint;
  partsSent: number;
  locked: boolean;
}

interface DeliveryParts {
  wholeFresh: bigint;
  wholeRecycled: bigint;
  landedFresh: bigint;
  landedRecycled: bigint;
  landedAt: bigint;
  parts: number;
  wholeConflict: boolean;
}

let m: MeshScenario;
let k: KeeperHarness;
let alerts: OpsAlertLog;
let whole: bigint;
let laneCap: bigint;

beforeAll(async () => {
  m = await openMeshScenario();
  k = await keeperEnvFor([m.base, m.mirror], ['REWARD_DAY_CLOSE_ENABLED', 'REWARD_REMIT_ENABLED'], { indexer: true });
  alerts = collectOpsAlerts();
});

afterAll(async () => {
  await m?.stop();
});

/** Move both chains to `hour` hours (plus `extra` seconds) into reward day `day`. */
async function warpToDay(day: number, hour: number, extra = 0): Promise<void> {
  const target = m.fixture.interactionLaunchTimestamp + day * DAY + hour * HOUR + extra;
  const now = Math.max(await m.base.now(), await m.mirror.now());
  if (target <= now) throw new Error(`cannot warp back to day ${day} +${hour}h`);
  await m.warp(target - now);
}

function baseLedger(): Promise<DayLedger> {
  return m.base.read<DayLedger>('getRemitDayLedger', [MIRROR_ID, DAY_ID]);
}

/** Base's whole rule for a day's ledger (#918). */
function ledgerWhole(l: DayLedger): boolean {
  return l.locked && l.sentFresh === l.wholeFresh && l.sentRecycled === l.wholeRecycled && l.residualRemitId !== 0n;
}

async function openDays(): Promise<bigint[]> {
  return [...(await m.base.read<readonly bigint[]>('getRemitOpenDays', [MIRROR_ID]))];
}

function mirrorParts(): Promise<DeliveryParts> {
  return m.mirror.read<DeliveryParts>('getDayDeliveryParts', [DAY_ID]);
}

async function mirrorLanded(): Promise<boolean> {
  const state = await m.mirror.read<readonly unknown[]>('getDayDeliveryState', [DAY_ID]);
  return state[3] as boolean;
}

describe('one day remitted to the mirror in three parts', () => {
  it('closes and finalizes a day whose slice comes from a repaid mirror loan', async () => {
    const loan = await openLoan(m.mirror, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });
    await warpToDay(1, 20);
    await repayInFull(m.mirror, 'borrower', loan.loanId);
    await warpToDay(2, 0, 60);
    await closeAndFinalizeDays(m, k);

    const [total] = await m.base.read<readonly [bigint, readonly bigint[]]>('quoteRewardBudget', [MIRROR_ID, [DAY_ID]]);
    whole = total;
    expect(whole).toBeGreaterThan(0n);
    // Two parts at the ceiling leave a non-zero remainder below it.
    laneCap = whole / BigInt(PARTS) + 1n;
    expect(2n * laneCap).toBeLessThan(whole);
    (k.env as unknown as Record<string, string>).REWARD_REMIT_LANE_CAP = laneCap.toString();
    expect(await openDays()).toEqual([]);
    expect(alerts.texts).toEqual([]);
  });

  it('holds the day on the mirror until the last part lands, then both ends read it whole', async () => {
    const keeper = m.base.address('keeper').toLowerCase();
    const sent: bigint[] = [];
    for (let part = 1; part <= PARTS; part++) {
      await m.syncClock(); // eslint-disable-line no-await-in-loop
      const from = await m.base.blockNumber(); // eslint-disable-line no-await-in-loop
      await runRewardBudgetRemit(k.env, tickNow(FIVE_MIN_MS)); // eslint-disable-line no-await-in-loop
      const remitted = (await m.base.diamondEvents('RewardBudgetRemitted', from + 1n)).filter( // eslint-disable-line no-await-in-loop
        (e) => Number(e.args.dstChainId) === MIRROR_ID,
      );
      expect(remitted, `remit run ${part}`).toHaveLength(1);
      const tx = await m.base.pub.getTransaction({ hash: remitted[0].transactionHash }); // eslint-disable-line no-await-in-loop
      expect(tx.from.toLowerCase()).toBe(keeper);
      const amount = BigInt(remitted[0].args.total as bigint);
      expect(amount).toBeGreaterThan(0n);
      expect(amount).toBeLessThanOrEqual(laneCap);
      sent.push(amount);

      // The part crosses the lane and its ingress counts it; the indexer sees it.
      const delivered = await m.relay.deliver(BASE_ID, MIRROR_ID); // eslint-disable-line no-await-in-loop
      expect(delivered, `relay of part ${part}`).toHaveLength(1);
      await m.warp(60); // eslint-disable-line no-await-in-loop
      await k.indexer!.index(); // eslint-disable-line no-await-in-loop
      await m.syncClock(); // eslint-disable-line no-await-in-loop

      const ledger = await baseLedger(); // eslint-disable-line no-await-in-loop
      const parts = await mirrorParts(); // eslint-disable-line no-await-in-loop
      expect(Number(ledger.partsSent)).toBe(part);
      expect(Number(parts.parts), `parts the mirror counted after part ${part}`).toBe(part);
      expect(parts.wholeConflict).toBe(false);
      if (part < PARTS) {
        expect(ledgerWhole(ledger), `Base read day ${DAY_ID} whole after part ${part}`).toBe(false);
        expect(await openDays()).toEqual([DAY_ID]); // eslint-disable-line no-await-in-loop
        expect(parts.landedAt, `the mirror opened the day after part ${part}`).toBe(0n);
        expect(await mirrorLanded()).toBe(false); // eslint-disable-line no-await-in-loop
        for (const who of ['lender', 'borrower'] as Party[]) {
          const pays = await simulatedClaim(m.mirror, who); // eslint-disable-line no-await-in-loop
          expect(pays ?? 0n, `${who}'s claim would pay after part ${part}`).toBe(0n);
        }
      } else {
        expect(ledgerWhole(ledger)).toBe(true);
        expect(await openDays()).toEqual([]); // eslint-disable-line no-await-in-loop
        expect(parts.landedAt).toBeGreaterThan(0n);
        expect(await mirrorLanded()).toBe(true); // eslint-disable-line no-await-in-loop
        // The mirror's whole is the one Base declared, and every component landed.
        expect(parts.wholeFresh).toBe(ledger.wholeFresh);
        expect(parts.wholeRecycled).toBe(ledger.wholeRecycled);
        expect(parts.landedFresh).toBe(parts.wholeFresh);
        expect(parts.landedRecycled).toBe(parts.wholeRecycled);
      }
    }
    expect(sent.slice(0, PARTS - 1)).toEqual(Array(PARTS - 1).fill(laneCap));
    expect(sent.reduce((a, b) => a + b, 0n)).toBe(whole);
    expect(alerts.texts).toEqual([]);
  });

  it('sends nothing more once the day is whole', async () => {
    await m.syncClock();
    const nonce = await m.base.pub.getTransactionCount({ address: m.base.address('keeper') });
    await runRewardBudgetRemit(k.env, tickNow(FIVE_MIN_MS));
    expect(await m.base.pub.getTransactionCount({ address: m.base.address('keeper') })).toBe(nonce);
    expect(alerts.texts).toEqual([]);
  });

  it('pays the lender and the borrower on the mirror out of the delivered day', async () => {
    for (const who of ['lender', 'borrower'] as Party[]) {
      expect(await claimUntilPaid(m.mirror, who)).toBeGreaterThan(0n); // eslint-disable-line no-await-in-loop
    }
    expect(alerts.texts).toEqual([]);
  });
});
