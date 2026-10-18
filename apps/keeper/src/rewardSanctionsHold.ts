// apps/keeper/src/rewardSanctionsHold.ts
//
// #2450 — the #1566 sanctions-hold observer.
//
// The reward sanctions rule (owner 2026-10-14) pays a flagged wallet nothing
// until its flag is revoked; once the flag is CONFIRMED, reward the wallet
// earned while flagged is forfeited and reward it earned before is set apart
// for it. A flag is confirmed by a chain of authoritative Flagged
// observations spanning the confirmation window W with no gap longer than G
// (`LibRewardSanctions`; W = 3 days, G = 1 day today). Until then a first-
// flagged claimant's staged payout is HELD and its staging record stays
// `Resolving`. A Resolving record keeps the staging encumbrance raised, and
// that count gates custody activation and every reward-role change, so one
// held claimant blocks both. The bound is W only if somebody observes the
// owner at least every G: a longer gap restarts the chain and the hold (and
// the block with it) runs on. Nothing on chain observes by itself — this pass
// does:
//
//   1. CANDIDATES — read from the indexer's record of the chain's own events
//      (`activity_events`), each decided per wallet or per record and never
//      by age or by a row count (Codex #2489 r1): every wallet whose LATEST
//      evidence event starts a chain (an open chain), and every owner of an
//      OPEN staging record or domain — opened, with no close event since. The
//      second set is what carries a cleared wallet (its record may still be
//      Resolving from the hold, and the claimant is owed the payout) and a
//      claimant held with no chain at all, however long either waits.
//   2. CLASSIFY — `getRewardSanctionsStatus`, the contract's ONE classifier
//      read without writing, batched. Its deadlines (`observeBy`,
//      `forfeitableAt`) are the contract's, never restated here.
//   3. ACT — Hold: `recordRewardSanctionsEvidence` once the latest observation
//      is `OBSERVE_AFTER_SEC` old (a quarter of G). Confirmed: the owner
//      settlement (`settleSanctionedInteractionRewards`, repeated while it
//      makes progress — each call settles what one claim would), which
//      forfeits the window days and sets the rest apart, then the owner's
//      Resolving staging records and domains, whose resolution page does the
//      same for a staged day and closes the record. Deliver (a chain cleared):
//      the same resolution pages, which now pay the claimant. Every
//      write is SIMULATED first and sent only if it would change something,
//      so an owner already settled costs reads, not gas.
//   4. ALERT — the OPS channel when an observation deadline is within one
//      cadence (our observations are not landing), when a hold outlasts its
//      confirmation by more than G (an outage or a wedged record is holding
//      custody activation), or when a wallet is held with no observation chain
//      at all (the oracle is not answering).
//
// Every call here is permissionless and moves value only into protocol
// custody or to the claimant's own venue — never to the keeper.
//
// Gated by KEEPER_ENABLED + REWARD_SANCTIONS_KEEPER_ENABLED.

import { createPublicClient, http, parseAbi, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  InteractionRewardsLensFacetABI,
  ProfileFacetABI,
  RewardClaimFacetABI,
  RewardHorizonSweepFacetABI,
  RewardStagingDomainFacetABI,
  RewardStagingSettleFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { boundedRead } from './batchRead';
import {
  deploymentFloor,
  countLoanParties,
  getSanctionsScreenCursor,
  listLoanPartiesAfter,
  listOpenSanctionsChains,
  listOpenStagingOwners,
  listOpenStagingRecordKeysForUser,
  listOpsAlertKeys,
  putSanctionsScreenCursor,
  listSanctionsWatch,
  unwatchSanctionsOwners,
  watchSanctionsOwners,
} from './db';
import { resolveOpsAlert, sendOpsAlert } from './opsAlert';

const ABI = [
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(ProfileFacetABI as Abi),
  ...(RewardClaimFacetABI as Abi),
  ...(RewardHorizonSweepFacetABI as Abi),
  ...(RewardStagingDomainFacetABI as Abi),
  ...(RewardStagingSettleFacetABI as Abi),
] as Abi;

/** `LibRewardSanctions.Decision`. */
export const DECISION_DELIVER = 0;
export const DECISION_HOLD = 1;
export const DECISION_CONFIRMED = 2;

/** Observe a held owner once its latest observation is this old: a quarter of
 *  the contract's one-day maximum gap, so three more passes run before the
 *  chain could break. */
export const OBSERVE_AFTER_SEC = 6 * 3600;
/** This pass's cadence in seconds (passSchedule). Alert margins are one cadence. */
export const PASS_CADENCE_SEC = 60 * 60;

/** `LibVaipakam.StagingPhase.Resolving` / `DomainPhase.Resolving`. */
const PHASE_RESOLVING = 3;
/** Status reads per `aggregate3` (the other passes' bound, #1946). */
const STATUS_CHUNK = 100;
/** The floor of one tick's transactions per chain: settlement, resolution and
 *  a small observation load. */
const MAX_WRITES_PER_TICK = 25;
/** The hard ceiling of one tick's transactions per chain (#2497 r7). Each send
 *  waits for its receipt, so this bounds a tick's wall time. Past it, the
 *  six-hour observation bound cannot be kept, and the pass SAYS so (an ops
 *  alert) rather than silently letting chains lapse. */
const WRITE_CEILING_PER_TICK = 120;
/** Ticks inside one observation bound: each held owner must be observed once
 *  in this many ticks. */
// An owner is due every (bound − one cadence), see {@link observeDue}, so that
// is the run count the observation rate is spread over (#2497 r18).
const TICKS_PER_OBSERVE_BOUND = Math.max(1, Math.floor((OBSERVE_AFTER_SEC - PASS_CADENCE_SEC) / PASS_CADENCE_SEC));

/**
 * One tick's write budget, from the WHOLE demand rather than a fixed count
 * (#2497 r7, r8) — every consumer of the tick's writes is counted here, once:
 * the floor for settlement and resolution, the clean commits this tick found,
 * and the observation rate the six-hour bound needs (`ceil(held /
 * ticks-per-bound)`). The observations are protected by ORDER, not by a
 * reserve (#2497 r9): the pass serves every due observation before any other
 * write. Capped at {@link WRITE_CEILING_PER_TICK}; `overCapacity` says when
 * that cap binds. Pure; pinned by the tests.
 */
export function writeBudgetFor(heldCount: number, cleanCount = 0): { writes: number; overCapacity: boolean } {
  const need = MAX_WRITES_PER_TICK + cleanCount + Math.ceil(heldCount / TICKS_PER_OBSERVE_BOUND);
  return { writes: Math.min(WRITE_CEILING_PER_TICK, need), overCapacity: need > WRITE_CEILING_PER_TICK };
}
/** Staging pages one owner may resolve per run (#2497 r18): the rest resume
 *  next run, after the other owners have had a turn. */
const MAX_RESOLVE_WRITES_PER_OWNER = 4;
/** `xs` started at `turn mod length` — a stateless rotation keyed by the run.
 *  Pure; pinned by the tests. */
export function rotate<T>(xs: readonly T[], turn: number): T[] {
  if (xs.length === 0) return [];
  const k = ((turn % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}
/** Settlement calls per owner per tick; each settles what one claim would
 *  (a bounded window of days), and the rest resumes next tick. */
const MAX_SETTLE_CALLS_PER_OWNER = 4;
/** Re-send a still-standing ops condition at most this often. */
const ALERT_REPEAT_SEC = 6 * 3600;
/** How long one send may take to be mined before this tick's sends stop. */
const RECEIPT_TIMEOUT_MS = 30_000;
const ORACLE_ABI = parseAbi(['function isSanctioned(address) view returns (bool)']);

/** One candidate's classification, as `getRewardSanctionsStatus` returns it. */
export interface OwnerSanctionsStatus {
  owner: Address;
  decision: number;
  flaggedAt: number;
  lastSeenAt: number;
  forfeitableAt: number;
  observeBy: number;
  /** The contract still STORES sanctions state for this owner: an evidence
   *  chain (its oracle is set) or the confirmed-flag marker. */
  stored: boolean;
}

export interface SanctionsHoldPlan {
  /** Held owners to observe now. */
  observe: Address[];
  /** EVERY owner due an observation-bearing write this tick — Held ones due an
   *  observation and Confirmed ones whose chain is due (#2497 r9) — in urgency
   *  order. The pass serves this whole list before any other write, so neither
   *  a clean commit nor one owner's settlement backlog can spend the share the
   *  six-hour bound needs. */
  dueObservations: { owner: Address; confirmed: boolean }[];
  /** Confirmed owners whose chain is due an observation: observed by a
   *  settlement call that makes progress, else by the evidence call (a lapsed
   *  chain stops counting the days the owner earns next). */
  settleObserveDue: Address[];
  /** Owners whose rewards to settle: Confirmed runs the settlement, then the
   *  pages. */
  settle: Address[];
  /** Owners whose Resolving records to resolve without a settlement (Deliver). */
  resolveOnly: Address[];
  /** Deliver owners the contract still stores a chain or marker for (#2497
   *  r7): an observation commits the clean result — clears the marker, ends
   *  the chain and records its window — once the oracle answers clean. Left
   *  uncommitted, a re-flag inside the gap would read the old chain as
   *  continuous and forfeit reward earned while the owner was clean. */
  commitClean: Address[];
  /** This tick's write budget and whether the cap binds ({@link writeBudgetFor}). */
  writes: number;
  overCapacity: boolean;
  /** Held or confirmed owners this tick, the demand the budget is sized for. */
  heldCount: number;
  /** Held owners whose chain breaks within one cadence. */
  deadlineAtRisk: OwnerSanctionsStatus[];
  /** Held owners past confirmation by more than the maximum gap. */
  overdue: OwnerSanctionsStatus[];
  /** Held owners with no observation chain: the oracle is not answering, or it
   *  answers Flagged but the chain broke and has not restarted. */
  heldWithoutChain: OwnerSanctionsStatus[];
}

/**
 * The wallets worth classifying: every wallet with an open evidence chain and
 * every owner of an open staging record or domain, once each, lowercased. Pure;
 * the two reads ({@link listOpenSanctionsChains}, {@link listOpenStagingOwners})
 * decide openness on the chain's own events, so nothing here filters by age.
 */
export function candidateOwners(openChains: readonly string[], stagingOwners: readonly string[]): Address[] {
  return [...new Set([...openChains, ...stagingOwners].map((w) => w.toLowerCase() as Address))];
}

/** Most urgent first: the oldest observation (never observed first of all),
 *  then the nearest deadline, then the address — a total order (#2497 r4). */
function byUrgency(a: OwnerSanctionsStatus, b: OwnerSanctionsStatus): number {
  if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt - b.lastSeenAt;
  const da = a.observeBy === 0 ? Number.MAX_SAFE_INTEGER : a.observeBy;
  const db = b.observeBy === 0 ? Number.MAX_SAFE_INTEGER : b.observeBy;
  if (da !== db) return da - db;
  return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0;
}

/** What to do for each classified candidate. Pure: the contract's verdict and
 *  deadlines in, the pass's actions out.
 *
 *  The action lists are in URGENCY order ({@link byUrgency}), never address
 *  order (#2497 r4): the tick's write cap is spent from the front, so with
 *  more held owners than one tick can observe, address order would observe the
 *  same first slice forever. Staleness order is a rotation that needs no
 *  cursor — an owner just observed carries the newest observation and goes to
 *  the back — so every held owner is observed, the most overdue first. */
export function planSanctionsHold(
  statuses: readonly OwnerSanctionsStatus[],
  nowSec: number,
): SanctionsHoldPlan {
  statuses = [...statuses].sort(byUrgency);
  const plan: SanctionsHoldPlan = {
    observe: [],
    dueObservations: [],
    settleObserveDue: [],
    settle: [],
    resolveOnly: [],
    commitClean: [],
    writes: 0,
    overCapacity: false,
    heldCount: 0,
    deadlineAtRisk: [],
    overdue: [],
    heldWithoutChain: [],
  };
  for (const st of statuses) {
    if (st.decision === DECISION_CONFIRMED) {
      plan.settle.push(st.owner);
      if (observeDue(st, nowSec)) {
        plan.settleObserveDue.push(st.owner);
        plan.dueObservations.push({ owner: st.owner, confirmed: true });
      }
      continue;
    }
    if (st.decision === DECISION_DELIVER) {
      if (st.stored) plan.commitClean.push(st.owner);
      plan.resolveOnly.push(st.owner);
      continue;
    }
    if (st.decision !== DECISION_HOLD) continue;
    // Hold. A chain that has never been observed, or whose latest observation
    // is a quarter-gap old, is observed now.
    if (observeDue(st, nowSec)) {
      plan.observe.push(st.owner);
      plan.dueObservations.push({ owner: st.owner, confirmed: false });
    }
    if (st.flaggedAt === 0) {
      plan.heldWithoutChain.push(st);
      continue;
    }
    if (st.observeBy !== 0 && st.observeBy - nowSec <= PASS_CADENCE_SEC) plan.deadlineAtRisk.push(st);
    // The maximum gap, read from the contract's own pair rather than restated.
    const gap = st.observeBy !== 0 && st.lastSeenAt !== 0 ? st.observeBy - st.lastSeenAt : 0;
    if (st.forfeitableAt !== 0 && gap > 0 && nowSec > st.forfeitableAt + gap) plan.overdue.push(st);
  }
  plan.heldCount = statuses.filter((st) => st.decision === DECISION_HOLD || st.decision === DECISION_CONFIRMED).length;
  ({ writes: plan.writes, overCapacity: plan.overCapacity } = writeBudgetFor(
    plan.heldCount,
    plan.commitClean.length,
  ));
  return plan;
}

/** One rule for when a chain is due an observation, for every decision: never
 *  observed, or its latest observation is ONE CADENCE short of the six-hour
 *  bound old (#2497 r18). An observation lands seconds or minutes into a run,
 *  so waiting for an age of exactly six hours deferred it to the next run and
 *  produced nearly seven-hour gaps; due one cadence early, it lands inside. */
export function observeDue(st: OwnerSanctionsStatus, nowSec: number): boolean {
  return st.lastSeenAt === 0 || nowSec - st.lastSeenAt >= OBSERVE_AFTER_SEC - PASS_CADENCE_SEC;
}

/** The tail of a run reserved for its alerts (#2497 r17, r18): reads and sends
 *  stop this long before the run's deadline ({@link PassTick.deadlineMs}), and
 *  an alert not delivered by the deadline is not recorded, so the next run
 *  raises it. Everything a run does is therefore inside its own cadence. */
export const PASS_ALERT_WINDOW_MS = 10 * 60_000;

export async function runRewardSanctionsHold(env: Env, tick?: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardSanctionsHold', 'REWARD_SANCTIONS_KEEPER_ENABLED')) return;
  const runDeadlineMs = tick?.deadlineMs ?? Date.now() + 60 * 60_000;
  const deadline = runDeadlineMs - PASS_ALERT_WINDOW_MS;
  // Chains run CONCURRENTLY (#2497 r16): each has its own nonce lane in the
  // per-key submission queue, so one chain's receipt waits never spend another
  // chain's window.
  await Promise.all(
    getChainConfigs(env).map(async (chain) => {
      try {
        await observeChain(env, chain, deadline);
      } catch (err) {
        console.error(`[keeper] rewardSanctionsHold chain=${chain.id} failed:`, err);
      }
    }),
  );
}

async function observeChain(env: Env, chain: ChainConfig, deadline: number = Date.now() + 50 * 60_000): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Owners of open staging work join the open chains: a claimant held with NO
  // chain (the oracle was unavailable when its page ran, a flag marker set)
  // emits no evidence event, so the events alone never surface it.
  const diamondAddr = String(chain.diamond);
  // The owners the screen found earlier stay candidates until a fresh read
  // shows nothing left to do (#2497 r11): they may have no other trace yet.
  const watched = await listSanctionsWatch(env.KEEPER_DB, chain.id, diamondAddr);
  const known = candidateOwners(
    [...(await listOpenSanctionsChains(env.DB, chain.id, deploymentFloor(chain.id))), ...watched],
    await listOpenStagingOwners(env.DB, chain.id, deploymentFloor(chain.id)),
  );
  const client = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;
  const statuses = (await readStatuses(client as never, diamond, known, deadline)).filter(
    (st): st is OwnerSanctionsStatus => st !== null,
  );
  // The SCREEN (Codex #2489 r2): a wallet flagged while it holds only ordinary
  // reward leaves neither of those traces — its claim's observation reverts
  // with the claim — so a bounded slice of every loan party is classified each
  // tick, and the held or confirmed ones join. Its first observation is what
  // starts the chain the forfeit window is counted from.
  const screen = await screenLoanParties(env, chain.id, client as never, diamond, new Set(known), deadline);
  const screened = screen.found;
  statuses.push(...screened);
  const candidates = new Set<string>([...known, ...screened.map((st) => st.owner)]);
  // An owner with an OPEN alert who is not a candidate this tick (a screen
  // slice moved on, a chain closed) is classified FRESHLY here, so its alerts
  // clear only on a positive read that shows the condition gone (#2497 r1).
  // Absence from this tick's candidates is not evidence: a screened wallet
  // whose oracle is down leaves the slice while it is still held. A failed
  // read leaves its alerts as they are.
  const departed = await departedAlertOwners(env, chain.id, candidates);
  if (departed.length > 0) {
    statuses.push(
      ...(await readStatuses(client as never, diamond, departed, deadline)).filter(
        (st): st is OwnerSanctionsStatus => st !== null,
      ),
    );
  }

  const plan = planSanctionsHold(statuses, nowSec);
  // A watched owner read as Deliver with nothing stored has nothing left for
  // this pass: it leaves the watch. Any other verdict keeps it.
  const watchedSet = new Set(watched);
  await unwatchSanctionsOwners(
    env.KEEPER_DB,
    chain.id,
    diamondAddr,
    statuses.filter((st) => watchedSet.has(st.owner.toLowerCase()) && st.decision === DECISION_DELIVER && !st.stored).map((st) => st.owner),
  );
  const ctx = buildKeeperContext(env, chain, client as never);
  const budget = { writes: plan.writes, touched: new Set<string>(), deadline };
  /** MEASURED, not predicted (#2497 r16): the due observations and clean
   *  commits this tick never reached, because the write budget or the time
   *  window ran out. Null when there is no key to send with. */
  let shortfall: { due: number; unreached: number; clean: number } | null = null;
  if (ctx?.wallet.account) {
    let dueReached = 0;
    /** Due observations that LANDED — counted on the write's own success
     *  (#2497 r18), never on the attempt. */
    let dueLanded = 0;
    let cleanLanded = 0;
    // PHASE 1 — one observation-bearing write for EVERY due owner, most urgent
    // first, before anything else (#2497 r9). A Held owner gets the evidence
    // call. A Confirmed owner gets ONE settlement call (its observation is part
    // of the call) when that makes progress, else the evidence call — so its
    // chain is kept alive however large its backlog, and the backlog waits for
    // phase 3.
    const noChain = new Set(plan.heldWithoutChain.map((st) => st.owner));
    const settleCallsUsed = new Map<string, number>();
    for (const due of plan.dueObservations) {
      const owner = due.owner;
      if (budget.writes <= 0 || Date.now() >= budget.deadline) break;
      dueReached += 1;
      if (due.confirmed) {
        // eslint-disable-next-line no-await-in-loop
        const settled = await runOwnerSettlement(ctx, budget, owner, 1);
        settleCallsUsed.set(owner, settled ? 1 : 0);
        let landed = settled;
        if (!settled && budget.writes > 0) {
          // eslint-disable-next-line no-await-in-loop
          landed = await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner);
        }
        if (landed) dueLanded += 1;
        continue;
      }
      // A held owner with no chain is observed only while the oracle answers:
      // during an outage the observation records nothing, and an hourly
      // transaction would buy nothing until it recovers.
      // eslint-disable-next-line no-await-in-loop
      if (noChain.has(owner) && !(await oracleAnswers(client, diamond, owner))) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner)) dueLanded += 1;
    }
    // PHASE 2 — the clean results (#2497 r7): until committed, a re-flag inside
    // the gap would continue the old chain. Sent only on the oracle's own clean
    // answer, so a Deliver that is not an authoritative Clean read (an outage,
    // a foreign-oracle chain) costs one read and no transaction.
    for (const owner of plan.commitClean) {
      if (budget.writes <= 0 || Date.now() >= budget.deadline) break;
      // eslint-disable-next-line no-await-in-loop
      if (!(await oracleSaysClean(client, diamond, owner))) continue;
      // Counted on the write's own success (#2497 r19), as the observations are.
      // eslint-disable-next-line no-await-in-loop
      if (await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner)) cleanLanded += 1;
    }
    shortfall = {
      due: plan.dueObservations.length - dueLanded,
      unreached: plan.dueObservations.length - dueReached,
      clean: plan.commitClean.length - cleanLanded,
    };
    // PHASE 3 — the backlogs: the rest of each Confirmed owner's settlement,
    // then the staging pages, with whatever budget is left. The same rotation
    // rule as every other queue (#2497 r18): each owner's pages are capped per
    // run, and the starting owner rotates with the run, so one owner with a
    // deep backlog cannot take the whole phase run after run.
    const hourIndex = Math.floor(nowSec / 3600);
    const resolveCapped = async (owner: Address) => {
      const share = { writes: Math.min(budget.writes, MAX_RESOLVE_WRITES_PER_OWNER), touched: budget.touched, deadline: budget.deadline };
      const before = share.writes;
      await resolveOwnerRecords(env, ctx, share, owner);
      budget.writes -= before - share.writes;
    };
    for (const owner of rotate(plan.settle, hourIndex)) {
      const used = settleCallsUsed.get(owner) ?? 0;
      // eslint-disable-next-line no-await-in-loop
      if (used < MAX_SETTLE_CALLS_PER_OWNER) await runOwnerSettlement(ctx, budget, owner, MAX_SETTLE_CALLS_PER_OWNER - used);
      // eslint-disable-next-line no-await-in-loop
      await resolveCapped(owner);
    }
    for (const owner of rotate(plan.resolveOnly, hourIndex)) {
      // eslint-disable-next-line no-await-in-loop
      await resolveCapped(owner);
    }
  } else if (plan.observe.length + plan.settle.length > 0) {
    console.warn(
      `[keeper] rewardSanctionsHold chain=${chain.id}: ${plan.observe.length} to observe and ${plan.settle.length} to settle, but no keeper key — nothing sent`,
    );
  }
  // Alerts reflect the state AFTER this tick's writes (#2497 r2): an owner this
  // tick sent anything for is classified again, so an observation that
  // started a chain or recorded a clean result does not raise an alert for the
  // condition it just removed. An owner whose fresh read fails is left out of
  // this tick's alerts entirely — neither raised from stale state nor cleared.
  let alertStatuses = statuses;
  let alertPlan = plan;
  if (budget.touched.size > 0) {
    const touched = [...budget.touched];
    const fresh = await readStatuses(client as never, diamond, touched, deadline + PASS_ALERT_WINDOW_MS);
    alertStatuses = [
      ...statuses.filter((st) => !budget.touched.has(st.owner.toLowerCase())),
      ...fresh.filter((st): st is OwnerSanctionsStatus => st !== null),
    ];
    alertPlan = planSanctionsHold(alertStatuses, Math.floor(Date.now() / 1000));
  }
  await raiseAlerts(env, chain.id, alertStatuses, alertPlan, nowSec, screen.overCapacity, shortfall, deadline + PASS_ALERT_WINDOW_MS);
}

/** Owners with an open sanctions alert on this chain who are not candidates
 *  this tick; [] when the alert table cannot be read (nothing is cleared). */
async function departedAlertOwners(env: Env, chainId: number, candidates: ReadonlySet<string>): Promise<string[]> {
  let keys: string[];
  try {
    keys = await listOpsAlertKeys(env.KEEPER_DB, `sanctions-%:${chainId}:%`);
  } catch {
    return [];
  }
  const owners = new Set<string>();
  for (const key of keys) {
    const owner = key.slice(key.lastIndexOf(':') + 1).toLowerCase();
    // Owner-scoped keys only (#2497 r12): a chain-wide key such as
    // `sanctions-capacity:<chain>:all` names no address, and one bad entry
    // would make the batched status read fall back to serial reads.
    if (!/^0x[0-9a-f]{40}$/.test(owner)) continue;
    if (!candidates.has(owner)) owners.add(owner);
  }
  return [...owners];
}

/** Each owner's classification, `getRewardSanctionsStatus` batched, aligned
 *  with `owners` — null where the read failed (classified next tick). */
async function readStatuses(
  client: PublicClient,
  diamond: Address,
  owners: readonly string[],
  /** Past this, the rest read as unread (null), for the next run (#2497 r18). */
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<(OwnerSanctionsStatus | null)[]> {
  const out: (OwnerSanctionsStatus | null)[] = [];
  for (let i = 0; i < owners.length; i += STATUS_CHUNK) {
    const chunk = owners.slice(i, i + STATUS_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const res = await boundedRead(
      client as never,
      chunk.map((owner) => ({
        address: diamond,
        abi: ABI,
        functionName: 'getRewardSanctionsStatus' as const,
        args: [owner] as const,
      })),
      `rewardSanctionsHold getRewardSanctionsStatus ${i}/${owners.length}`,
      // BOUNDED (#2497 r18, r19): past the deadline nothing is issued, and a
      // rejected aggregate costs one request and reads as unread — classified
      // next run — never one serial request per owner.
      deadline,
    );
    chunk.forEach((owner, j) => {
      const r = res[j];
      if (!r || r.status !== 'success') {
        out.push(null);
        return;
      }
      const t = r.result as readonly [number, bigint | number, bigint | number, bigint | number, bigint | number, Address, boolean];
      out.push({
        owner: owner as Address,
        decision: Number(t[0]),
        flaggedAt: Number(t[1]),
        lastSeenAt: Number(t[2]),
        forfeitableAt: Number(t[3]),
        observeBy: Number(t[4]),
        stored: !/^0x0{40}$/i.test(String(t[5] ?? '0x0000000000000000000000000000000000000000')) || t[6] === true,
      });
    });
  }
  return out;
}

/** Screen passes per day at this pass's cadence. */
const SCREENS_PER_DAY = (24 * 3600) / PASS_CADENCE_SEC;
/** Bounds on one tick's screen slice: at least a few multicalls' worth so a
 *  small universe is re-screened often, at most what the invocation's
 *  subrequest budget can carry. */
export const SCREEN_MIN_PER_TICK = 100;
export const SCREEN_MAX_PER_TICK = 1000;

/** How many loan parties one tick screens: enough to cover all `total` within
 *  a day — a flagged party's first observation then lags its flag by at most
 *  a day, which is the reward it keeps as earned "before" — within the bounds
 *  above. Past the upper bound the cycle stretches past a day, and the pass
 *  says so. Pure; pinned by the tests. */
export function screenSliceSize(total: number): number {
  return Math.min(SCREEN_MAX_PER_TICK, Math.max(SCREEN_MIN_PER_TICK, Math.ceil(total / SCREENS_PER_DAY)));
}

/** Where the screen resumes after a slice: past the last address read, or —
 *  if a read failed — just before the first failure, so no party is skipped
 *  for a cycle by a transient error. A TERMINAL slice — the caller read one
 *  row past it and found none — has reached the end: start over now, on this
 *  tick, even when the slice was exactly full (#2497 r2: the cursor used to
 *  wait for an empty page, which cost the cycle a whole extra tick).
 *  Pure; pinned by the tests. */
export function nextScreenCursor(after: string, slice: readonly string[], read: readonly boolean[], terminal: boolean): string {
  const firstFail = read.indexOf(false);
  if (firstFail >= 0) return firstFail === 0 ? after : slice[firstFail - 1];
  return terminal || slice.length === 0 ? '' : slice[slice.length - 1];
}

/** One tick of the screen: the next slice of loan parties (skipping ones the
 *  pass already knows), classified. The held or confirmed are WATCHED
 *  (#2497 r11) — recorded so they stay candidates until a fresh read shows
 *  nothing left to do — and returned to join this tick's candidates. Then the
 *  cursor moves on past every party it READ, whatever this tick's sends do:
 *  what keeps a found owner is the watch, not the cursor. */
async function screenLoanParties(
  env: Env,
  chainId: number,
  client: PublicClient,
  diamond: Address,
  known: ReadonlySet<string>,
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<ScreenOutcome> {
  const total = await countLoanParties(env.DB, chainId);
  if (total === 0) return { found: [], overCapacity: null };
  const size = screenSliceSize(total);
  // Past the slice cap a cycle takes longer than a day, and a wallet flagged
  // while it holds only ordinary reward goes undiscovered for that long. That
  // is SAID — an ops alert (#2497 r12) — not just logged.
  const overCapacity = Math.ceil(total / size) > SCREENS_PER_DAY ? { total, ticks: Math.ceil(total / size) } : null;
  if (overCapacity) {
    console.warn(
      `[keeper] rewardSanctionsHold chain=${chainId}: ${total} loan parties exceed one day's screen at ${size} a tick — a cycle takes ${overCapacity.ticks} ticks`,
    );
  }
  const after = await getSanctionsScreenCursor(env.KEEPER_DB, chainId, diamond);
  // One row past the slice, so the end of the cycle is known on its last page.
  const page = await listLoanPartiesAfter(env.DB, chainId, after, size + 1);
  const terminal = page.length <= size;
  const slice = page.slice(0, size);
  const toRead = slice.filter((a) => !known.has(a));
  const read = await readStatuses(client, diamond, toRead, deadline);
  const byOwner = new Map(toRead.map((a, i) => [a, read[i]]));
  const ok = slice.map((a) => known.has(a) || byOwner.get(a) !== null);
  const found = read.filter((st): st is OwnerSanctionsStatus => st !== null && st.decision !== DECISION_DELIVER);
  // Watch first, cursor second: a failure between them re-reads the slice.
  await watchSanctionsOwners(env.KEEPER_DB, chainId, diamond, found.map((st) => st.owner));
  await putSanctionsScreenCursor(env.KEEPER_DB, chainId, diamond, nextScreenCursor(after, slice, ok, terminal));
  return { found, overCapacity };
}

/** One screen tick: the owners found, and whether a cycle overruns a day. */
interface ScreenOutcome {
  found: OwnerSanctionsStatus[];
  overCapacity: { total: number; ticks: number } | null;
}

/** The owner settlement, repeated while it makes progress: each call is
 *  SIMULATED first and sent only when it would succeed — it reverts, as a
 *  claim does, when there is nothing left to settle, and returns early on a
 *  verdict that is not Confirmed — so an owner already settled costs one read.
 *  A sent call's on-chain observation is part of the same call, so it also
 *  keeps the chain alive. Returns whether any call was sent. */
async function runOwnerSettlement(
  ctx: KeeperContext,
  budget: { writes: number },
  owner: Address,
  maxCalls: number = MAX_SETTLE_CALLS_PER_OWNER,
): Promise<boolean> {
  let sentAny = false;
  for (let call = 0; call < maxCalls && budget.writes > 0; call++) {
    let decision: number;
    try {
      // eslint-disable-next-line no-await-in-loop
      const sim = await ctx.client.simulateContract({
        address: ctx.diamond,
        abi: ABI,
        functionName: 'settleSanctionedInteractionRewards',
        args: [owner],
        account: ctx.wallet.account!,
      });
      decision = Number((sim.result as readonly [number, bigint, bigint, bigint])[0]);
    } catch (err) {
      console.log(`[keeper] rewardSanctionsHold settle ${owner} would revert: ${shortErr(err)}`);
      return sentAny;
    }
    if (decision !== DECISION_CONFIRMED) return sentAny;
    // eslint-disable-next-line no-await-in-loop
    const sent = await send(ctx, budget, 'settleSanctionedInteractionRewards', [owner], owner);
    if (!sent) return sentAny;
    sentAny = true;
  }
  return sentAny;
}

/** Whether the chain's sanctions oracle answers for `owner` right now — a view
 *  read off chain, so a no-chain held owner is observed only when an
 *  observation can record something. No oracle, or a failing read: false. */
/** Whether the configured oracle answers that `owner` is NOT sanctioned — the
 *  authoritative Clean read an observation commits. False on any failure. */
async function oracleSaysClean(client: PublicClient, diamond: Address, owner: Address): Promise<boolean> {
  try {
    const oracle = (await client.readContract({ address: diamond, abi: ABI, functionName: 'getSanctionsOracle' })) as Address;
    if (!oracle || /^0x0{40}$/i.test(oracle)) return false;
    return (await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'isSanctioned', args: [owner] })) === false;
  } catch {
    return false;
  }
}

async function oracleAnswers(client: PublicClient, diamond: Address, owner: Address): Promise<boolean> {
  try {
    const oracle = (await client.readContract({ address: diamond, abi: ABI, functionName: 'getSanctionsOracle' })) as Address;
    if (!oracle || /^0x0{40}$/i.test(oracle)) return false;
    await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'isSanctioned', args: [owner] });
    return true;
  } catch {
    return false;
  }
}

/** Resolve every Resolving staging record and domain of `owner`. The page pays
 *  a Deliver claimant, settles a confirmed one under the rule (a window day
 *  forfeited, an earlier day set apart), and withholds a held one — the last
 *  case is never reached here (held owners are observed instead). */
async function resolveOwnerRecords(
  env: Env,
  ctx: KeeperContext,
  budget: { writes: number; deadline?: number },
  owner: Address,
): Promise<void> {
  if (budget.writes <= 0) return;
  // Every read here is bounded by the run's deadline too (#2497 r19).
  const deadline = budget.deadline ?? Number.POSITIVE_INFINITY;
  // The owner's OPEN records only, however old (Codex #2489 r1); read in
  // bounded chunks, each record's own phase deciding whether a page is due.
  const keys = await listOpenStagingRecordKeysForUser(env.DB, ctx.chainId, owner, deploymentFloor(ctx.chainId));
  for (let c = 0; c < keys.length && budget.writes > 0 && Date.now() < deadline; c += STATUS_CHUNK) {
    const chunk = keys.slice(c, c + STATUS_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const reads = await boundedRead(
      ctx.client as never,
      chunk.map((key) => ({
        address: ctx.diamond,
        abi: ABI,
        functionName: 'getStagingRecord' as const,
        args: [key as Hex] as const,
      })),
      `rewardSanctionsHold records ${owner} ${c}/${keys.length}`,
      deadline,
    );
    for (let i = 0; i < chunk.length && budget.writes > 0; i++) {
      const r = reads[i];
      if (r?.status !== 'success') continue;
      const view = r.result as { phase: number };
      if (Number(view.phase) !== PHASE_RESOLVING) continue;
      // eslint-disable-next-line no-await-in-loop
      await sendIfEffective(ctx, budget, 'resolveStagedDayPage', [chunk[i] as Hex], () => true, owner);
    }
  }
  if (budget.writes <= 0) return;
  const domains = await boundedRead(
    ctx.client as never,
    [0, 1].map((side) => ({
      address: ctx.diamond,
      abi: ABI,
      functionName: 'getStagingDomain' as const,
      args: [owner, side] as const,
    })),
    `rewardSanctionsHold domains ${owner}`,
    deadline,
  );
  for (let side = 0; side < 2 && budget.writes > 0; side++) {
    const r = domains[side];
    if (r?.status !== 'success') continue;
    const t = r.result as readonly [Hex, number];
    if (Number(t[1]) !== PHASE_RESOLVING) continue;
    // eslint-disable-next-line no-await-in-loop
    await sendIfEffective(ctx, budget, 'resolveDomainPage', [t[0]], () => true, owner);
  }
}

/** Simulate `fn`; send it only when the simulation succeeds and `effective`
 *  says the result changes something. */
async function sendIfEffective(
  ctx: KeeperContext,
  budget: { writes: number },
  fn: 'recordRewardSanctionsEvidence' | 'resolveStagedDayPage' | 'resolveDomainPage',
  args: readonly unknown[],
  effective: (result: unknown) => boolean,
  owner: Address,
): Promise<boolean> {
  try {
    const sim = await ctx.client.simulateContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: fn,
      args: args as never,
      account: ctx.wallet.account!,
    });
    if (!effective(sim.result)) return false;
  } catch (err) {
    console.log(`[keeper] rewardSanctionsHold ${fn} ${owner} would revert: ${shortErr(err)}`);
    return false;
  }
  return send(ctx, budget, fn, args, owner);
}

async function send(
  ctx: KeeperContext,
  budget: { writes: number; touched?: Set<string>; deadline?: number },
  fn: string,
  args: readonly unknown[],
  owner: Address,
): Promise<boolean> {
  // Past the run's send window, nothing more is sent this run (#2497 r16).
  if (budget.deadline !== undefined && Date.now() >= budget.deadline) budget.writes = 0;
  if (budget.writes <= 0) return false;
  try {
    const hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: fn,
      args,
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never);
    budget.writes -= 1;
    // Sent: this owner's state may have changed, whatever the receipt says,
    // so its alerts are judged on a fresh read (#2497 r2).
    budget.touched?.add(owner.toLowerCase());
    console.log(`[keeper] rewardSanctionsHold ${fn} owner=${owner} chain=${ctx.chainId} tx=${hash}`);
    // Wait for inclusion before the next send, as the matcher and the daily
    // oracle snapshot do: the keeper's liquidator and matcher sign from the
    // same account, so a burst of unmined sends here would race them for
    // nonces. A send that does not land in time ends this pass's sends for
    // the tick; every call here is idempotent and the next tick re-reads the
    // contract's verdict before acting again.
    const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') {
      console.error(`[keeper] rewardSanctionsHold ${fn} owner=${owner} reverted on chain: tx=${hash}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[keeper] rewardSanctionsHold ${fn} owner=${owner} send failed: ${shortErr(err)}`);
    budget.writes = 0;
    return false;
  }
}

/** Raise or clear the pass's ops alerts for one chain. Exported for tests. */
export async function raiseAlerts(
  env: Env,
  chainId: number,
  statuses: readonly OwnerSanctionsStatus[],
  plan: SanctionsHoldPlan,
  nowSec: number,
  screenOverCapacity: { total: number; ticks: number } | null = null,
  /** What this tick left undone, measured ({@link observeChain}); null = not measured. */
  shortfall: { due: number; unreached: number; clean: number } | null = null,
  /** Past this, alerts wait for the next run (#2497 r17); none by default. */
  alertDeadline: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  const atRisk = new Set(plan.deadlineAtRisk.map((s) => s.owner));
  const overdue = new Set(plan.overdue.map((s) => s.owner));
  const noChain = new Set(plan.heldWithoutChain.map((s) => s.owner));
  // One read of this chain's open sanctions alerts, so a candidate with
  // nothing open costs no write: only a raised alert, or the clearing of one
  // that is actually open, touches the table.
  let open: Set<string>;
  try {
    open = new Set(await listOpsAlertKeys(env.KEEPER_DB, `sanctions-%:${chainId}:%`));
  } catch (err) {
    console.error(`[keeper] rewardSanctionsHold open-alert read failed on chain ${chainId}: ${shortErr(err)}`);
    return;
  }
  let deferred = 0;
  const toggle = async (key: string, on: boolean, text: () => string): Promise<void> => {
    // Bounded by the run's alert window, like its sends: an alert past it is
    // neither sent nor recorded, so the next run raises it.
    if (Date.now() >= alertDeadline) {
      deferred += 1;
      return;
    }
    if (on) await sendOpsAlert(env, key, text(), ALERT_REPEAT_SEC, nowSec, chainId);
    else if (open.has(key)) await resolveOpsAlert(env, key);
  };
  // The screen's daily bound, stated (#2497 r12).
  await toggle(`sanctions-screen-capacity:${chainId}:all`, screenOverCapacity !== null, () =>
    `[chain ${chainId}] reward sanctions screen: ${screenOverCapacity?.total} loan parties take ${screenOverCapacity?.ticks} hourly ticks to screen, more than a day — a wallet flagged while holding only ordinary reward can go undiscovered that long. Raise the slice cap or the cadence.`,
  );
  // Capacity, MEASURED and stated per kind of work (#2497 r7, r16). An
  // observation left unsent this tick is what threatens a chain's bound; an
  // unsent clean commit is a separate backlog, said as such. A tick that could
  // not measure (no key) leaves both as they are.
  if (shortfall !== null) {
    await toggle(`sanctions-capacity:${chainId}:all`, shortfall.due > 0, () =>
      `[chain ${chainId}] reward sanctions hold: ${shortfall.due} due observation(s) did NOT land this tick (${shortfall.unreached} unreached — the write budget or the run's time window ran out — and ${shortfall.due - shortfall.unreached} attempted but not recorded) — if this persists, evidence chains will lapse past their ${OBSERVE_AFTER_SEC / 3600}h bound.`,
    );
    await toggle(`sanctions-clean-backlog:${chainId}:all`, shortfall.clean > 0, () =>
      `[chain ${chainId}] reward sanctions hold: ${shortfall.clean} clean result(s) were NOT committed this tick; every due observation was sent first. Until committed, a re-flag inside the gap would read the old chain as continuous.`,
    );
  }
  for (const st of statuses) {
    const k = (what: string) => `sanctions-${what}:${chainId}:${st.owner}`;
    // eslint-disable-next-line no-await-in-loop
    await toggle(k('observe-deadline'), atRisk.has(st.owner), () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} must be observed by ${iso(st.observeBy)} or its confirmation window restarts — the keeper's observations are not landing.`,
    );
    // eslint-disable-next-line no-await-in-loop
    await toggle(k('hold-overdue'), overdue.has(st.owner), () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} has been held past ${iso(st.forfeitableAt)} by more than the maximum observation gap. A held staging record blocks custody activation and reward-role changes while it stands.`,
    );
    // eslint-disable-next-line no-await-in-loop
    await toggle(k('hold-no-chain'), noChain.has(st.owner), () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} is held with no observation chain — the sanctions oracle is not answering authoritatively, or it answers Flagged but the chain broke and has not restarted; the hold cannot confirm or clear until an observation lands.`,
    );
  }
  // An owner who LEFT the candidates is read freshly by the caller and is in
  // `statuses` here (#2497 r1), so the loop above clears its alerts on a
  // positive clean read — and only then (Codex #2489 r2's stale-row concern,
  // without treating absence as departure).
  if (deferred > 0) {
    console.warn(`[keeper] rewardSanctionsHold chain=${chainId}: the alert window closed — ${deferred} alert update(s) wait for the next run`);
  }
}

function iso(sec: number): string {
  return sec > 0 ? new Date(sec * 1000).toISOString() : 'unknown';
}

function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return String(e?.shortMessage ?? e?.message ?? err).slice(0, 200);
}
