/**
 * #2515 item 6, the staging part — a claim held mid-resolution by the
 * sanctions screen, finished by the keeper once the owner's evidence chain is
 * confirmed. End to end on Anvil, against the repository's current contracts
 * and the real indexer.
 *
 * Where a staging record comes from. A claim whose pending days span more
 * than one settlement chunk (`MAX_INTERACTION_CLAIM_DAYS`, 30) does not pay
 * chunk by chunk: it opens the claimant-side's DOMAIN and prepares one staging
 * record per day. Anyone then reserves the domain and resolves it, in day
 * order, irrevocably. Each record pays on its last page, and that page runs the
 * #1566 sanctions screen: for a claimant flagged but not yet confirmed it
 * HOLDS, writing nothing, so the domain stays Resolving with its records
 * live (and `getStagingEncumberedCount` raised). (A second source, a claim day
 * whose transport-epoch scan passes its cap, needs more than 64 cross-chain
 * deliveries on one day; this scenario takes the domain path, which a single
 * canonical chain reaches with one long loan.)
 *
 * The story: the admin arms the share-of-pool walk from day 1 (the domain is
 * that walk's; the shared fixture leaves it unarmed, the testnets have it
 * armed). A lender earns 34 days of interaction reward on one loan (days 1–34;
 * the repay lands on day 34), the loan is repaid, and the lender claims. The claim opens a domain; a third
 * party reserves it. The overlay's owner then flags the lender, and the third
 * party's first resolution page holds. What it proves:
 *
 *   1. The held domain is visible to the keeper through the indexer's rows
 *      (`StagingDomainOpened` with no `StagingDomainCleared`) and through its
 *      screen; the pass starts and keeps the owner's evidence chain, and while
 *      the decision is Hold it sends nothing else — the held page is not
 *      retried into a revert, and no "staging stuck" alert is raised.
 *   2. In the run that finds the chain Confirmed, the keeper resolves the
 *      domain itself (`resolveDomainPage`, its own transaction): the days,
 *      all earned before the flag, are SET APART for the owner
 *      (`RewardSanctionsHeldApart`, equal to `getSanctionsHeldReward`), the
 *      domain is cleared (`StagingDomainCleared`), and the staging
 *      encumbrance is released.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFunctionSelector, type Hex } from 'viem';
import { runRewardSanctionsHold } from '../../src/rewardSanctionsHold';
import { OVERLAY_ABI, openScenario, type ScenarioChain } from '../harness/chain';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../harness/keeperEnv';
import type { Env } from '../../src/env';
import { opsBotSink, type OpsBotSink } from '../harness/opsAlerts';
import { openLoan, repayInFull } from '../harness/lending';
import { finalizeThrough } from '../harness/rewardDays';

const DAY = 86_400;
const HOUR = 3_600;
/** `LibRewardSanctions.Decision`. */
const HOLD = 1;
const CONFIRMED = 2;
/** `LibVaipakam.DomainPhase`. */
const DOMAIN_NONE = 0;
const DOMAIN_STAGING = 1;
const DOMAIN_RESOLVING = 3;
/** `LibVaipakam.RewardSide.Lender`. */
const LENDER_SIDE = 0;
/** The screen's observation entry — the only call the keeper may send while held. */
const OBSERVE_SELECTOR = toFunctionSelector('recordRewardSanctionsEvidence(address)');
/** Days from the accept (day 0) to the repay: the entry then covers days
 *  1–34, more than one 30-day chunk. */
const ACCRUED_DAYS = 33;

let sc: ScenarioChain;
let k: KeeperHarness;
let sink: OpsBotSink;
let env: Env;

beforeAll(async () => {
  sc = await openScenario();
  k = await keeperEnvFor(sc, ['REWARD_SANCTIONS_KEEPER_ENABLED'], { indexer: true });
  sink = opsBotSink();
  env = { ...k.env, ...sink.env } as Env;
});

afterAll(async () => {
  await sc?.stop();
});

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
  await runRewardSanctionsHold(env, tickNow());
}

interface Domain {
  key: Hex;
  phase: number;
  firstDay: number;
  lastDay: number;
  preparedThrough: number;
  liveRecords: number;
}

async function domain(who: `0x${string}`): Promise<Domain> {
  const r = await sc.read<readonly unknown[]>('getStagingDomain', [who, LENDER_SIDE]);
  return {
    key: r[0] as Hex,
    phase: Number(r[1]),
    firstDay: Number(r[2]),
    lastDay: Number(r[3]),
    preparedThrough: Number(r[4]),
    liveRecords: Number(r[8]),
  };
}

async function decision(who: `0x${string}`): Promise<number> {
  const r = await sc.read<readonly unknown[]>('getRewardSanctionsStatus', [who]);
  return Number(r[0]);
}

/** The keeper's transactions in blocks after `from`, by function selector. */
async function keeperCalls(from: bigint): Promise<Hex[]> {
  const keeper = sc.address('keeper').toLowerCase();
  const out: Hex[] = [];
  const head = await sc.blockNumber();
  for (let b = from + 1n; b <= head; b++) {
    // eslint-disable-next-line no-await-in-loop
    const block = await sc.pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions) if (tx.from.toLowerCase() === keeper) out.push(tx.input.slice(0, 10) as Hex);
  }
  return out;
}

describe('rewardSanctionsHold and a claim held mid-resolution', () => {
  const lender = () => sc.address('lender');
  let startBlock = 0n;
  let heldBlock = 0n;
  let encumberedBefore = 0n;

  it('a long claim opens a domain, and its first resolution page holds once the claimant is flagged', async () => {
    // The domain path is the ARMED (share-of-pool) walk's; the shared fixture
    // leaves the D* cutover unarmed, so this scenario arms it from day 1 —
    // before the loan opens — as the deployed testnets are.
    expect(await sc.rewardDay()).toBe(0);
    await sc.diamondWrite('admin', 'setGovernorCommitArmedFromDay', [1n]);
    const loan = await openLoan(sc, {
      lender: 'lender',
      borrower: 'borrower',
      principalWeth: '1',
      collateralTliq: '5',
      rateBps: 1000,
      days: 60,
    });
    startBlock = loan.acceptBlock;
    const acceptDay = await sc.rewardDay();
    // Entries start the day after the accept; repay on day acceptDay + 34.
    await warpToDay(acceptDay + ACCRUED_DAYS + 1);
    await repayInFull(sc, 'borrower', loan.loanId);
    await warpToDay(acceptDay + ACCRUED_DAYS + 2);
    await finalizeThrough(sc, (await sc.rewardDay()) - 1);

    encumberedBefore = await sc.read<bigint>('getStagingEncumberedCount');
    // The claim: more than one chunk of days, so it opens the domain and
    // prepares it, a chunk per call.
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      const d = await domain(lender());
      if (d.phase === DOMAIN_STAGING && d.preparedThrough >= d.lastDay) break;
      // eslint-disable-next-line no-await-in-loop
      await sc.diamondWrite('lender', 'claimInteractionRewards');
    }
    let d = await domain(lender());
    expect(d.phase).toBe(DOMAIN_STAGING);
    expect(d.lastDay - d.firstDay + 1).toBeGreaterThan(30);
    expect(d.preparedThrough).toBe(d.lastDay);

    // A third party reserves it (permissionless), page by page.
    for (let i = 0; i < 20 && (await domain(lender())).phase !== DOMAIN_RESOLVING; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sc.diamondWrite('other', 'reserveDomainPage', [d.key]);
    }
    d = await domain(lender());
    expect(d.phase).toBe(DOMAIN_RESOLVING);
    expect(await sc.read<bigint>('getStagingEncumberedCount')).toBeGreaterThan(encumberedBefore);

    // The flag lands before the resolution. The first page's first record
    // holds on its payout: the domain stays Resolving, nothing is paid.
    await sc.write('admin', sc.fixture.rewards.sanctionsOverlay, OVERLAY_ABI, 'setFlagged', [lender(), true]);
    expect(await decision(lender())).toBe(HOLD);
    await sc.diamondWrite('other', 'resolveDomainPage', [d.key]);
    heldBlock = await sc.blockNumber();
    const after = await domain(lender());
    expect(after.phase).toBe(DOMAIN_RESOLVING);
    expect(after.liveRecords).toBeGreaterThan(0);
    expect(await sc.diamondEvents('StagingDomainCleared', startBlock)).toHaveLength(0);
    expect(await sc.diamondEvents('RewardSanctionsHeldApart', startBlock)).toHaveLength(0);
  });

  it('the keeper only observes while the owner is held, then resolves the domain once confirmed', async () => {
    const dk = (await domain(lender())).key;
    let confirmedSeen = false;
    let heldObservations = 0;
    let cleared: `0x${string}` | null = null;
    const fromBlock = heldBlock;
    // Bounded: the three-day confirmation window plus two days of slack.
    for (let step = 0; step < 5 * 24 && cleared === null; step++) {
      // eslint-disable-next-line no-await-in-loop
      await sc.warp(HOUR);
      // eslint-disable-next-line no-await-in-loop
      const before = await sc.blockNumber();
      // eslint-disable-next-line no-await-in-loop
      const wasConfirmed = (await decision(lender())) === CONFIRMED;
      // eslint-disable-next-line no-await-in-loop
      await hour();
      // eslint-disable-next-line no-await-in-loop
      const ev = (await sc.diamondEvents('StagingDomainCleared', before + 1n))
        .filter((e) => String(e.args.domainKey).toLowerCase() === dk.toLowerCase());
      if (ev.length > 0) cleared = ev[0].transactionHash;
      if (!wasConfirmed && cleared === null) {
        // While held: the domain stands, and every keeper transaction is an
        // observation (never a resolution page that the screen would refuse).
        // eslint-disable-next-line no-await-in-loop
        expect((await domain(lender())).phase).toBe(DOMAIN_RESOLVING);
        // eslint-disable-next-line no-await-in-loop
        const calls = await keeperCalls(before);
        expect(calls.every((c) => c === OBSERVE_SELECTOR)).toBe(true);
        heldObservations += calls.length;
      }
      // eslint-disable-next-line no-await-in-loop
      if ((await decision(lender())) === CONFIRMED) confirmedSeen = true;
    }
    expect(heldObservations).toBeGreaterThan(0);
    expect(confirmedSeen).toBe(true);
    expect(cleared).not.toBeNull();
    // The keeper resolved it, with its own transaction.
    const tx = await sc.pub.getTransaction({ hash: cleared! });
    expect(tx.from.toLowerCase()).toBe(sc.address('keeper').toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(sc.diamond.toLowerCase());

    // The domain is gone and its encumbrance released.
    expect((await domain(lender())).phase).toBe(DOMAIN_NONE);
    expect(await sc.read<bigint>('getStagingEncumberedCount')).toBe(encumberedBefore);

    // Every day was earned before the flag: set apart for the owner, none
    // forfeited, and the chain's held balance agrees with the events.
    const heldApart = (await sc.diamondEvents('RewardSanctionsHeldApart', fromBlock))
      .filter((e) => String(e.args.user).toLowerCase() === lender().toLowerCase())
      .reduce((a, e) => a + BigInt(e.args.amount as bigint), 0n);
    expect(heldApart).toBeGreaterThan(0n);
    const [held] = await sc.read<readonly [bigint, bigint]>('getSanctionsHeldReward', [lender()]);
    expect(held).toBe(heldApart);

    // No fault alert across the run: the held page was never a stuck page.
    expect(sink.posts.filter((p) => /staging/i.test(p) && !/settle/i.test(p))).toEqual([]);
    expect(
      (k.keeperDb.db.prepare(`SELECT alert_key FROM keeper_ops_alert WHERE alert_key LIKE 'sanctions-staging-stuck:%'`).all() as unknown[]).length,
    ).toBe(0);
  });
});
