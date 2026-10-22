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
 * The story: the admin arms the share-of-pool walk from day 1. The domain is
 * that walk's, and the arming is SYNTHETIC: the shared fixture leaves the D*
 * cutover unarmed, and so does every current deployment
 * (TokenomicsTechSpec: "while `D*` is unarmed — every current deploy"), so
 * this tests the planned armed state rather than reproducing a testnet's
 * configuration. A lender earns 34 days of interaction reward on one loan
 * (days 1–34; the repay lands on day 34), the loan is repaid, and the lender
 * claims. The claim opens a domain; a third party reserves it. The overlay's
 * owner then flags the lender, and the third party's first resolution page
 * holds. What it proves:
 *
 *   1. The held domain is a discovery source in its own right: after
 *      indexing, the keeper's staging query (`listOpenStagingOwners`, over
 *      `StagingDomainOpened` with no `StagingDomainCleared`) names the owner.
 *      The pass has two other sources that can name the same owner here (the
 *      open evidence chains and the loan-party screen), so this scenario
 *      checks the staging query directly rather than inferring it from the
 *      pass's behaviour, and it does not claim which source started the
 *      chain. While the decision is Hold the keeper sends only observations
 *      (`recordRewardSanctionsEvidence`): the held page is not retried into
 *      a revert, and no "staging stuck" alert is raised.
 *   2. From the run that finds the chain Confirmed, the keeper resolves the
 *      domain itself, one `resolveDomainPage` per pass (each walks at most
 *      eight days, `DOMAIN_PAGE_DAYS`), so a domain of more than 30 days
 *      clears over several later passes, not in the confirming run. No keeper
 *      resolution page is sent before Confirmed. Once cleared
 *      (`StagingDomainCleared`, the keeper's own transaction) the staging
 *      encumbrance is released, and the days, all earned before the flag,
 *      are SET APART for the owner (`RewardSanctionsHeldApart`, equal to
 *      `getSanctionsHeldReward`). None is forfeited: no ForfeitedReward
 *      recycle credit, no `StagingClaimantForfeited`, and
 *      `rewardSanctionsDayForfeited` is false for every day of the domain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFunctionSelector, type Hex } from 'viem';
import { runRewardSanctionsHold } from '../../src/rewardSanctionsHold';
import { listOpenStagingOwners } from '../../src/db';
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
/** The domain resolution page, permissionless. */
const RESOLVE_DOMAIN_SELECTOR = toFunctionSelector('resolveDomainPage(bytes32)');
/** `LibVpfiRecycle.RecycleSource.ForfeitedReward`. */
const FORFEITED_REWARD = 0;
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
    // The domain path is the ARMED (share-of-pool) walk's. The shared fixture
    // and every current deployment leave the D* cutover unarmed, so this arms
    // it from day 1, before the loan opens: the planned armed state, not a
    // testnet's configuration.
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

    // The staging rows on their own name the owner: the keeper's staging
    // query over the indexer's projection, independent of the evidence chain
    // and the screen, which could also name them.
    await k.indexer!.index();
    expect(await listOpenStagingOwners(k.env.DB, sc.chain.id, 0)).toContain(lender().toLowerCase());
  });

  it('the keeper only observes while the owner is held, then resolves the domain once confirmed', async () => {
    const dom = await domain(lender());
    const dk = dom.key;
    let confirmedStep = -1;
    let clearedStep = -1;
    let heldObservations = 0;
    let keeperPages = 0;
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
      if (ev.length > 0) {
        cleared = ev[0].transactionHash;
        clearedStep = step;
      }
      // eslint-disable-next-line no-await-in-loop
      const calls = await keeperCalls(before);
      const pages = calls.filter((c) => c === RESOLVE_DOMAIN_SELECTOR).length;
      // No keeper resolution page while the owner is still held: a pass that
      // sent one must leave the chain Confirmed.
      // eslint-disable-next-line no-await-in-loop
      if (pages > 0) expect(await decision(lender())).toBe(CONFIRMED);
      keeperPages += pages;
      if (!wasConfirmed && cleared === null) {
        // While held: the domain stands, and every keeper transaction is an
        // observation (never a resolution page that the screen would refuse).
        // eslint-disable-next-line no-await-in-loop
        expect((await domain(lender())).phase).toBe(DOMAIN_RESOLVING);
        expect(calls.every((c) => c === OBSERVE_SELECTOR)).toBe(true);
        heldObservations += calls.length;
      }
      // eslint-disable-next-line no-await-in-loop
      if (confirmedStep < 0 && (await decision(lender())) === CONFIRMED) confirmedStep = step;
    }
    expect(heldObservations).toBeGreaterThan(0);
    expect(confirmedStep).toBeGreaterThanOrEqual(0);
    expect(cleared).not.toBeNull();
    // Clearance converges over the passes after confirmation, a page each: a
    // domain of more than 30 days needs more than one eight-day page.
    expect(clearedStep).toBeGreaterThan(confirmedStep);
    expect(keeperPages).toBeGreaterThan(1);
    console.log(`[keeper-e2e] staging retry: confirmed at pass ${confirmedStep}, cleared at pass ${clearedStep}, ${keeperPages} keeper pages`);
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

    // None forfeited, checked against signals other than the held amount: no
    // ForfeitedReward recycle credit and no staged forfeit since the hold, and
    // no day of the domain marked forfeited.
    const forfeitCredits = (await sc.diamondEvents('VpfiRecycled', fromBlock))
      .concat(await sc.diamondEvents('VpfiRecycledPreLaunch', fromBlock))
      .filter((e) => Number(e.args.source) === FORFEITED_REWARD);
    expect(forfeitCredits).toHaveLength(0);
    expect(await sc.diamondEvents('StagingClaimantForfeited', fromBlock)).toHaveLength(0);
    for (let day = dom.firstDay; day <= dom.lastDay; day++) {
      // eslint-disable-next-line no-await-in-loop
      expect(await sc.read<boolean>('rewardSanctionsDayForfeited', [lender(), BigInt(day)])).toBe(false);
    }

    // No fault alert across the run: the held page was never a stuck page.
    expect(sink.posts.filter((p) => /staging/i.test(p) && !/settle/i.test(p))).toEqual([]);
    expect(
      (k.keeperDb.db.prepare(`SELECT alert_key FROM keeper_ops_alert WHERE alert_key LIKE 'sanctions-staging-stuck:%'`).all() as unknown[]).length,
    ).toBe(0);
  });
});
