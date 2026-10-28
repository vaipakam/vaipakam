/**
 * #2984 — the keeper's zeroed-day pass (`runRewardZeroedDay`) on a Base/mirror
 * pair on Anvil, against the contracts' own compensation quote and lapse.
 *
 * The zeroing is the real one. Base only marks a missing chain's day zeroed
 * once the D* commitment cutover is armed, and the shared fixture and every
 * current deployment leave it unarmed, so the admin arms it from day 1 at the
 * start: the planned armed state, not a testnet's configuration. A mirror loan
 * then accrues over days 0 and 1 and is repaid on day 1; the keeper's day-close
 * pass closes both days on both chains, but the mirror's two reports are held
 * in the lane past Base's grace, so the next day-close run finalizes both days
 * on Base without them, and the broadcasts tell the mirror its day 1 was
 * zeroed (day 0 predates the arming and is not). What it proves, in order:
 *
 *   1. On the mirror, the pass accumulates day 1's quote over the covering
 *      reward entries and dispatches it toward Base, paying the lane fee; the
 *      relay lands the quote and Base stores it. Day 0 is left alone.
 *   2. While the day waits for compensation inside their lapse window, a run
 *      sends nothing.
 *   3. Past the day's frozen expiry, with no compensation sent, the pass
 *      lapses it, the chain records an exact (not partial) loss, and one
 *      operator notice is posted.
 *   4. A further run sends nothing.
 *   Every pass transaction is the keeper's, to the mirror Diamond.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import { runRewardDayClose } from '../../../src/rewardDayClose';
import { PASS_CADENCE_SEC, runRewardZeroedDay } from '../../../src/rewardZeroedDay';
import type { Env } from '../../../src/env';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../../harness/keeperEnv';
import { opsBotSink, type OpsBotSink } from '../../harness/opsAlerts';
import { openMeshScenario, type MeshChain, type MeshScenario } from '../mesh';
import { FIFTEEN_MIN_MS, transactionsSince } from '../rewardCycle';
import { BASE_ID, MIRROR_ID } from '../fixture';

const DAY = 86_400;
const HOUR = 3_600;
const ZEROED_MS = PASS_CADENCE_SEC * 1000;
/** The days closed and finalized; only day 1 is zeroed (see the arming below). */
const CLOSED = [0, 1] as const;
const DAYS = [1] as const;

let m: MeshScenario;
let k: KeeperHarness;
/** The operators' chat. A configured bot, as in production: the keeper
 *  records each notice it delivered, so a later run does not post it again. */
let sink: OpsBotSink;
let env: Env;

beforeAll(async () => {
  m = await openMeshScenario();
  k = await keeperEnvFor([m.base, m.mirror], ['REWARD_DAY_CLOSE_ENABLED', 'REWARD_ZEROED_DAY_ENABLED']);
  sink = opsBotSink();
  env = { ...k.env, ...sink.env } as Env;
});

afterAll(async () => {
  await m?.stop();
});

async function warpTo(target: number): Promise<void> {
  const now = Math.max(await m.base.now(), await m.mirror.now());
  if (target <= now) throw new Error(`cannot warp back to ${target}`);
  await m.warp(target - now);
}

async function dayClose(): Promise<void> {
  await m.syncClock();
  await runRewardDayClose(env, tickNow(FIFTEEN_MIN_MS));
}

/** One zeroed-day run, with what the mirror mined during it. */
async function zeroedDay(): Promise<{ from: string; to: string | null }[]> {
  await m.syncClock();
  const from = await m.mirror.blockNumber();
  await runRewardZeroedDay(env, tickNow(ZEROED_MS));
  return transactionsSince(m.mirror, from);
}

function expectKeeperOnly(txs: { from: string; to: string | null }[], sc: MeshChain): void {
  const keeper = m.mirror.address('keeper').toLowerCase();
  for (const t of txs) {
    expect(t.from.toLowerCase()).toBe(keeper);
    expect(t.to?.toLowerCase()).toBe(sc.diamond.toLowerCase());
  }
}

/** The mirror's quote accumulation for `day`: [cursorL, cursorB, accumL, accumB, consL, consB, sentAt]. */
function accum(day: number): Promise<readonly bigint[]> {
  return m.mirror.read<readonly bigint[]>('getCompQuoteAccum', [BigInt(day)]);
}

describe('the zeroed-day pass on a Base/mirror pair', () => {
  it('zeroes day 1 for the mirror: its reports held past grace, Base finalizes without them', async () => {
    const launch = m.fixture.interactionLaunchTimestamp;
    await m.base.diamondWrite('admin', 'setGovernorCommitArmedFromDay', [1n]);
    const loan = await openLoan(m.mirror, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });
    await warpTo(launch + DAY + 20 * HOUR);
    await repayInFull(m.mirror, 'borrower', loan.loanId);
    await warpTo(launch + 2 * DAY + 60);

    // Both chains close both days; the mirror's reports stay in the lane.
    await dayClose();
    for (const day of CLOSED) {
      for (const sc of [m.base, m.mirror]) {
        expect(await sc.read<bigint>('getChainReportSentAt', [BigInt(day)])).not.toBe(0n); // eslint-disable-line no-await-in-loop
      }
    }
    const [, , , , grace] = await m.base.read<readonly [unknown, unknown, unknown, unknown, bigint]>('getRewardReporterConfig');
    await warpTo((await m.base.now()) + Number(grace) + 120);
    // Past grace Base finalizes on the reports it has, and broadcasts.
    await dayClose();
    for (const day of CLOSED) {
      const [, reason] = await m.base.read<readonly [boolean, number]>('isDayReadyToFinalize', [BigInt(day)]); // eslint-disable-line no-await-in-loop
      expect(Number(reason), `Base finalized day ${day}`).toBe(1);
    }
    const broadcasts = await m.relay.deliver(BASE_ID, MIRROR_ID);
    expect(broadcasts).toHaveLength(2);
    expect(await m.mirror.read<boolean>('getDayDeliberatelyZeroed', [0n]), 'day 0 predates the arming').toBe(false);
    for (const day of DAYS) {
      expect(await m.mirror.read<boolean>('getDayDeliberatelyZeroed', [BigInt(day)]), `day ${day} zeroed on the mirror`).toBe(true); // eslint-disable-line no-await-in-loop
      const stamp = await m.mirror.read<readonly unknown[]>('getDayPoolStamp', [BigInt(day)]); // eslint-disable-line no-await-in-loop
      expect(stamp[0], `day ${day}'s pool stamp installed`).toBe(true);
    }
    sink.clear();
  });

  it('quotes the zeroed day toward Base, and Base stores the quote', async () => {
    const txs = await zeroedDay();
    expect(txs.length).toBeGreaterThan(0);
    expectKeeperOnly(txs, m.mirror);
    for (const day of DAYS) {
      const a = await accum(day); // eslint-disable-line no-await-in-loop
      expect(a[6], `day ${day}'s quote dispatched`).not.toBe(0n);
      expect(a[2] + a[3], `day ${day}'s quote is owed something`).toBeGreaterThan(0n);
    }
    const from = await m.base.blockNumber();
    // The lane carries the two held day reports (late, recorded and ignored)
    // and the quote.
    const landed = await m.relay.deliver(MIRROR_ID, BASE_ID);
    expect(landed).toHaveLength(3);
    const stored = (await m.base.diamondEvents('CompQuoteStored', from + 1n)).filter((e) => Number(e.args.sourceChainId) === MIRROR_ID);
    expect(stored.map((e) => Number(e.args.dayId)).sort()).toEqual([...DAYS]);
    expect(sink.posts).toEqual([]);
  });

  it('sends nothing while the quoted day waits inside its lapse window', async () => {
    expect(await zeroedDay()).toEqual([]);
    expect(sink.posts).toEqual([]);
  });

  it('lapses the day past its frozen expiry, records an exact loss and posts one notice', async () => {
    let expiry = 0;
    for (const day of DAYS) {
      const [finalizedAt, version, window] = await m.mirror.read<readonly [bigint, number, bigint, bigint]>('getDayLapseClock', [BigInt(day)]); // eslint-disable-line no-await-in-loop
      expect(finalizedAt).not.toBe(0n);
      expect(Number(version)).toBeGreaterThan(0);
      expiry = Math.max(expiry, Number(finalizedAt + window));
    }
    await warpTo(expiry + 60);
    const txs = await zeroedDay();
    expect(txs).toHaveLength(1);
    expectKeeperOnly(txs, m.mirror);
    for (const day of DAYS) {
      const loss = await m.mirror.read<{ lender18: bigint; borrower18: bigint; partialFigure: boolean; shortLapse: boolean; recorded: boolean }>('getLapsedDayLoss', [BigInt(day)]); // eslint-disable-line no-await-in-loop
      expect(loss.recorded, `day ${day}'s loss recorded`).toBe(true);
      expect(loss.partialFigure, `day ${day}'s loss is exact`).toBe(false);
      expect(loss.shortLapse).toBe(false);
      const a = await accum(day); // eslint-disable-line no-await-in-loop
      expect([loss.lender18, loss.borrower18], 'the loss is the quote it never received').toEqual([a[2], a[3]]);
    }
    expect(sink.posts).toHaveLength(1);
    for (const day of DAYS) expect(sink.posts.some((t) => t.includes(`Zeroed reward day ${day} on chain ${MIRROR_ID}`))).toBe(true);
    sink.clear();
  });

  it('sends nothing more', async () => {
    expect(await zeroedDay()).toEqual([]);
    expect(sink.posts).toEqual([]);
  });
});
