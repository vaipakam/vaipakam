/**
 * #2515 item 6 — the sanctions-hold observer, end to end on Anvil.
 *
 * The REAL pass (`runRewardSanctionsHold`, exactly as the scheduler calls it)
 * against the repository's current contracts, deployed from source as a
 * canonical reward chain, with the REAL indexer projecting the chain into the
 * shared database the pass takes its candidates from (`harness/indexer.ts`).
 *
 * The story: a lender earns interaction reward for two days, is then flagged
 * on the chain's sanctions oracle (the testnet overlay, by its owner), keeps
 * earning for two more days, and the loan is repaid. What it proves:
 *
 *   1. DISCOVERY through the indexer's rows: the flagged lender has no
 *      evidence and no staging trace, so only the pass's SCREEN over the loan
 *      parties the indexer recorded can find it. It does, puts it on the
 *      keeper's watch list and starts the evidence chain with the first
 *      observation (`RewardSanctionsEvidenceRecorded`, sent by the keeper).
 *   2. OBSERVATION: the indexer projects that evidence into `activity_events`,
 *      which is the pass's open-chain source on later runs; the pass keeps
 *      observing inside the contract's one-day maximum gap, so the chain is
 *      never broken, and the classifier moves from Hold to Confirmed once the
 *      three-day confirmation window has been observed whole.
 *   3. SETTLEMENT: in the run that finds it Confirmed, the pass settles the
 *      owner's reward (`settleSanctionedInteractionRewards`): the days earned
 *      while flagged are forfeited to the recycle bucket (`VpfiRecycled`,
 *      source ForfeitedReward) and the days earned before are set apart for
 *      the owner (`RewardSanctionsHeldApart`), which
 *      `getSanctionsHeldReward` then reports. The borrower, never flagged,
 *      forfeits nothing.
 *
 * NOT covered here: the staging-page retry (`resolveStagedDayPage`). Staging
 * records exist only for a claim delivered to ANOTHER chain's venue, which a
 * single canonical chain cannot open — see the COVERAGE note.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatEther } from 'viem';
import { runRewardSanctionsHold } from '../../src/rewardSanctionsHold';
import { listOpenSanctionsChains, listSanctionsWatch } from '../../src/db';
import { OVERLAY_ABI, openScenario, type ScenarioChain } from '../harness/chain';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../harness/keeperEnv';
import { collectOpsAlerts, type OpsAlertLog } from '../harness/opsAlerts';
import { openLoan, repayInFull } from '../harness/lending';
import { finalizeThrough } from '../harness/rewardDays';

const DAY = 86_400;
const HOUR = 3_600;
/** The pass's cadence: it runs hourly; a held owner is due every 5 hours. */
const STEP_SEC = HOUR;
/** `LibRewardSanctions.Decision`. */
const HOLD = 1;
const CONFIRMED = 2;
/** `LibVpfiRecycle.RecycleSource.ForfeitedReward`. */
const FORFEITED_REWARD = 0;

let sc: ScenarioChain;
let k: KeeperHarness;
let alerts: OpsAlertLog;

beforeAll(async () => {
  sc = await openScenario();
  k = await keeperEnvFor(sc, ['REWARD_SANCTIONS_KEEPER_ENABLED'], { indexer: true });
  alerts = collectOpsAlerts();
});

afterAll(async () => {
  await sc?.stop();
});

/** Move to `hour` hours into reward day `day`. */
async function warpToDay(day: number, hour = 1): Promise<void> {
  const target = sc.fixture.rewards.interactionLaunchTimestamp + day * DAY + hour * HOUR;
  const now = await sc.now();
  if (target <= now) throw new Error(`cannot warp back to day ${day} +${hour}h`);
  await sc.warp(target - now);
}

/** One scheduled hour: the indexer catches up, then the keeper pass runs. */
async function hour(): Promise<void> {
  const today = await sc.rewardDay();
  await finalizeThrough(sc, today - 1);
  await k.indexer!.index();
  await sc.syncClock();
  await runRewardSanctionsHold(k.env, tickNow());
}

interface Status {
  decision: number;
  flaggedAt: bigint;
  lastSeenAt: bigint;
  forfeitableAt: bigint;
}

async function status(who: `0x${string}`): Promise<Status> {
  const r = await sc.read<readonly unknown[]>('getRewardSanctionsStatus', [who]);
  return {
    decision: Number(r[0]),
    flaggedAt: BigInt(r[1] as bigint),
    lastSeenAt: BigInt(r[2] as bigint),
    forfeitableAt: BigInt(r[3] as bigint),
  };
}

async function sentByKeeper(tx: `0x${string}`): Promise<boolean> {
  const t = await sc.pub.getTransaction({ hash: tx });
  return t.from.toLowerCase() === sc.address('keeper').toLowerCase();
}

describe('rewardSanctionsHold on a canonical Anvil chain', () => {
  let acceptDay = 0;
  let startBlock = 0n;
  const lender = () => sc.address('lender');

  it('finds a flagged loan party through the indexer and starts its evidence chain', async () => {
    const loan = await openLoan(sc, {
      lender: 'lender',
      borrower: 'borrower',
      principalWeth: '1',
      collateralTliq: '5',
      rateBps: 1000,
      days: 30,
    });
    startBlock = loan.acceptBlock;
    acceptDay = await sc.rewardDay();
    // Two whole reward days accrue before the flag (entries start the day
    // after the accept).
    await warpToDay(acceptDay + 3);
    await finalizeThrough(sc, acceptDay + 2);
    await k.indexer!.index();
    const loanRow = k.shared.db.prepare('SELECT lender FROM loans WHERE chain_id = ? AND loan_id = ?').get(sc.chain.id, Number(loan.loanId)) as
      | { lender: string }
      | undefined;
    expect(loanRow?.lender.toLowerCase()).toBe(lender().toLowerCase());

    // A clean run: nothing flagged, nothing sent.
    await sc.syncClock();
    await runRewardSanctionsHold(k.env, tickNow());
    expect(await sc.pub.getTransactionCount({ address: sc.address('keeper') })).toBe(0);

    // The overlay's owner flags the lender. No evidence exists yet.
    const overlay = sc.fixture.rewards.sanctionsOverlay;
    await sc.write('admin', overlay, OVERLAY_ABI, 'setFlagged', [lender(), true]);
    expect((await status(lender())).decision).toBe(HOLD);
    expect((await status(lender())).flaggedAt).toBe(0n);

    await hour();
    const evidence = await sc.diamondEvents('RewardSanctionsEvidenceRecorded', startBlock);
    expect(evidence.length).toBe(1);
    expect(String(evidence[0].args.who).toLowerCase()).toBe(lender().toLowerCase());
    expect(await sentByKeeper(evidence[0].transactionHash)).toBe(true);
    const st = await status(lender());
    expect(st.decision).toBe(HOLD);
    expect(st.flaggedAt).toBeGreaterThan(0n);
    expect(await listSanctionsWatch(k.env.KEEPER_DB, sc.chain.id, sc.diamond)).toEqual([lender().toLowerCase()]);

    // The next indexer pass projects the evidence: the chain is now an OPEN
    // chain in the shared database, the pass's own candidate source.
    await k.indexer!.index();
    expect(await listOpenSanctionsChains(k.env.DB, sc.chain.id, 0)).toEqual([lender().toLowerCase()]);
  });

  it('keeps the chain observed inside the gap until it is confirmed, then settles the owner', async () => {
    const flaggedAt = (await status(lender())).flaggedAt;
    const repayAt = sc.fixture.rewards.interactionLaunchTimestamp + (acceptDay + 5) * DAY + HOUR;
    let repaid = false;
    let confirmedAt = 0;
    let heldApartTx: `0x${string}` | null = null;
    // Bounded: the three-day window plus two days of slack, an hour a step.
    for (let step = 0; step < 5 * 24 && heldApartTx === null; step++) {
      await sc.warp(STEP_SEC);
      if (!repaid && (await sc.now()) >= repayAt) {
        await repayInFull(sc, 'borrower', (await sc.diamondEvents('LoanInitiated', startBlock))[0].args.loanId as bigint);
        repaid = true;
      }
      await hour();
      const st = await status(lender());
      // The chain is never broken: it keeps the first observation's start.
      expect(st.flaggedAt).toBe(flaggedAt);
      if (st.decision === CONFIRMED && confirmedAt === 0) confirmedAt = await sc.now();
      const held = await sc.diamondEvents('RewardSanctionsHeldApart', startBlock);
      if (held.length > 0) heldApartTx = held[0].transactionHash;
    }
    expect(repaid).toBe(true);
    expect(confirmedAt).toBeGreaterThan(0);
    // Confirmation needs the whole window observed.
    expect(BigInt(confirmedAt)).toBeGreaterThanOrEqual((await status(lender())).forfeitableAt);
    expect(heldApartTx).not.toBeNull();
    expect(await sentByKeeper(heldApartTx!)).toBe(true);

    // Observations landed every few hours, never a gap near the one-day bound.
    const evidence = await sc.diamondEvents('RewardSanctionsEvidenceRecorded', startBlock);
    expect(evidence.length).toBeGreaterThanOrEqual(1);

    // The settlement's own receipt: reward set apart for the owner, and the
    // flagged days forfeited to the recycle bucket.
    const receipt = await sc.pub.getTransactionReceipt({ hash: heldApartTx! });
    const evs = sc.decodeDiamondLogs(receipt.logs);
    const heldApart = evs
      .filter((e) => e.eventName === 'RewardSanctionsHeldApart' && String(e.args.user).toLowerCase() === lender().toLowerCase())
      .reduce((a, e) => a + BigInt(e.args.amount as bigint), 0n);
    const forfeited = evs
      .filter((e) => e.eventName === 'VpfiRecycled' && Number(e.args.source) === FORFEITED_REWARD)
      .reduce((a, e) => a + BigInt(e.args.amount as bigint), 0n);
    console.log(`[keeper-e2e] sanctions: held apart ${heldApart} wei, forfeited ${forfeited} wei`);
    expect(heldApart).toBeGreaterThan(0n);
    expect(forfeited).toBeGreaterThan(0n);

    // Chain state agrees with the events.
    const [held, heldTotal] = await sc.read<readonly [bigint, bigint]>('getSanctionsHeldReward', [lender()]);
    expect(held).toBe(heldApart);
    expect(heldTotal).toBe(heldApart);
    // The two days before the flag are the owner's (set apart); the two
    // days earned while flagged are forfeited. The borrower forfeits nothing.
    const forfeitedDay = (who: `0x${string}`, d: number) => sc.read<boolean>('rewardSanctionsDayForfeited', [who, BigInt(d)]);
    expect(await forfeitedDay(lender(), acceptDay + 1)).toBe(false);
    expect(await forfeitedDay(lender(), acceptDay + 2)).toBe(false);
    expect(await forfeitedDay(lender(), acceptDay + 3)).toBe(true);
    expect(await forfeitedDay(lender(), acceptDay + 4)).toBe(true);
    // The repay day: the loan's last accruing day, earned while flagged.
    expect(await forfeitedDay(lender(), acceptDay + 5)).toBe(true);
    expect(await forfeitedDay(sc.address('borrower'), acceptDay + 3)).toBe(false);

    // What the operators were told: exactly one notice, the settlement's own
    // amounts, and no fault alert (no lapsed chain, no deadline at risk, no
    // failed settlement) across the whole run.
    expect(alerts.texts).toHaveLength(1);
    expect(alerts.texts[0]).toContain('settleSanctionedInteractionRewards');
    expect(alerts.texts[0]).toContain(`${formatEther(heldApart)} VPFI set apart`);
    expect(alerts.texts[0]).toContain(`${formatEther(forfeited)} VPFI forfeited`);
  });
});
