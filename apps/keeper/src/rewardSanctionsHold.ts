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

import { BaseError, ContractFunctionRevertedError, createPublicClient, formatUnits, http, parseAbi, parseEventLogs, type Abi, type Address, type Hex, type Log, type PublicClient } from 'viem';
import {
  DIAMOND_ABI_VIEM,
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
import { reportSendError } from './submissionQueue';
import type { PassTick } from './passSchedule';
import { boundedRead, deadlineClient, PastRunDeadline } from './batchRead';
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
import { resolveOpsAlert, sendOpsAlert, sendOpsNotice } from './opsAlert';

const ABI = [
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(ProfileFacetABI as Abi),
  ...(RewardClaimFacetABI as Abi),
  ...(RewardHorizonSweepFacetABI as Abi),
  ...(RewardStagingDomainFacetABI as Abi),
  ...(RewardStagingSettleFacetABI as Abi),
] as Abi;

/** The library events a settlement or a staging resolution announces its value
 *  moves with, taken from the compiled Diamond ABI (never hand-typed). */
const VALUE_MOVE_EVENTS = (DIAMOND_ABI_VIEM as Abi).filter(
  (x) =>
    x.type === 'event' &&
    ['RewardSanctionsHeldApart', 'VpfiRecycled', 'VpfiRecycledPreLaunch', 'StagingClaimantForfeited'].includes(x.name),
) as Abi;
/** `LibVpfiRecycle.RecycleSource.ForfeitedReward`. */
const RECYCLE_FORFEITED_REWARD = 0;

/** What one landed settlement or staging resolution MOVED for an owner, as its
 *  own receipt's events say (#2515). VPFI wei. */
export interface ValueMove {
  owner: string;
  fn: string;
  tx: Hex;
  /** Set apart for the owner (`RewardSanctionsHeldApart`). */
  heldApart: bigint;
  /** Credited to the recycle bucket as forfeited reward in this transaction
   *  (`VpfiRecycled` / `VpfiRecycledPreLaunch`, source ForfeitedReward). */
  forfeited: bigint;
  /** A staged payout of the owner's forfeited (`StagingClaimantForfeited`). */
  stagedForfeited: bigint;
}

/** Read a receipt's value moves for `owner`: only the Diamond's own logs, and a
 *  held-apart or staged forfeit only when it names `owner`. Pure. */
export function valueMovesOf(logs: readonly Log[], diamond: string, owner: string): Omit<ValueMove, 'owner' | 'fn' | 'tx'> {
  const d = diamond.toLowerCase();
  const o = owner.toLowerCase();
  const out = { heldApart: 0n, forfeited: 0n, stagedForfeited: 0n };
  const parsed = parseEventLogs({ abi: VALUE_MOVE_EVENTS, logs: logs.filter((l) => l.address.toLowerCase() === d) as Log[], strict: false });
  for (const ev of parsed) {
    const a = ev.args as Record<string, unknown>;
    if (ev.eventName === 'RewardSanctionsHeldApart' && String(a.user).toLowerCase() === o) out.heldApart += BigInt(a.amount as bigint);
    else if ((ev.eventName === 'VpfiRecycled' || ev.eventName === 'VpfiRecycledPreLaunch') && Number(a.source) === RECYCLE_FORFEITED_REWARD) {
      out.forfeited += BigInt(a.amount as bigint);
    } else if (ev.eventName === 'StagingClaimantForfeited' && String(a.user).toLowerCase() === o) {
      out.stagedForfeited += BigInt(a.fresh as bigint) + BigInt(a.recycled as bigint);
    }
  }
  return out;
}

/** An evidence chain the run saw LAPSE (#2515): before this run's writes the
 *  owner carried a chain, after them it carries a later one, and the later one
 *  started past the earlier one's observation deadline. (A chain restarted
 *  within its deadline — the oracle was changed — is not a lapse.) Pure. */
export function lapsedChain(pre: OwnerSanctionsStatus, post: OwnerSanctionsStatus): { lastSeenAt: number; missedAt: number; restartedAt: number } | null {
  if (pre.flaggedAt === 0 || pre.observeBy === 0 || post.flaggedAt <= pre.flaggedAt || post.flaggedAt <= pre.observeBy) return null;
  return { lastSeenAt: pre.lastSeenAt, missedAt: pre.observeBy, restartedAt: post.flaggedAt };
}

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

/** A chain with a live observation deadline: observed before, with a bound
 *  the contract enforces. Missing it restarts the confirmation window. */
function hasLiveDeadline(st: OwnerSanctionsStatus): boolean {
  return st.observeBy !== 0 && st.lastSeenAt !== 0;
}

/** Most urgent first — a total order (#2497 r4, pre-review of re-cut 3/3):
 *  every chain with a LIVE deadline, nearest deadline first, ahead of every
 *  owner without one (never observed, or held with no chain), oldest
 *  observation first, then the address. A first observation starts a chain
 *  and has no bound to miss; an observation on a live chain does, so a burst
 *  of newly screened owners cannot spend the budget a live chain's deadline
 *  needs. */
function byUrgency(a: OwnerSanctionsStatus, b: OwnerSanctionsStatus): number {
  const la = hasLiveDeadline(a);
  const lb = hasLiveDeadline(b);
  if (la !== lb) return la ? -1 : 1;
  if (la && a.observeBy !== b.observeBy) return a.observeBy - b.observeBy;
  if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt - b.lastSeenAt;
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

export async function runRewardSanctionsHold(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardSanctionsHold', 'REWARD_SANCTIONS_KEEPER_ENABLED')) return;
  const runDeadlineMs = tick.deadlineMs;
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
  // Each candidate SOURCE is read on its own (Codex #2573 r4): one that fails
  // costs its own candidates, never the others' observations, and the run
  // says discovery was incomplete rather than reporting coverage it lacks.
  const failedSources: string[] = [];
  const source = async (name: string, read: () => Promise<string[]>): Promise<string[] | null> => {
    try {
      return await read();
    } catch (err) {
      failedSources.push(name);
      console.error(`[keeper] rewardSanctionsHold chain=${chain.id}: candidate source ${name} unread this run: ${shortErr(err)}`);
      return null;
    }
  };
  const watched = (await source('watch list', () => listSanctionsWatch(env.KEEPER_DB, chain.id, diamondAddr))) ?? [];
  const stagingRead = await source('open staging', () => listOpenStagingOwners(env.DB, chain.id, deploymentFloor(chain.id)));
  const stagingOwners = stagingRead ?? [];
  const chainsRead = (await source('open evidence chains', () => listOpenSanctionsChains(env.DB, chain.id, deploymentFloor(chain.id)))) ?? [];
  const known = candidateOwners([...chainsRead, ...watched], stagingOwners);
  // Every single read and simulation is refused past the run's deadline
  // (`deadlineClient`); the batched status reads carry it themselves. The
  // alert-phase re-read uses the plain client, bounded by the alert window.
  const plainClient = createPublicClient({ transport: http(chain.rpc) });
  const client = deadlineClient(plainClient, deadline);
  const diamond = chain.diamond as Address;
  /** Candidates whose classification could not be read this run (#2497
   *  re-cut 3/3 pre-review): MEASURED, so a run that read nothing never
   *  reports its observations as covered. */
  let unread = 0;
  const readKnown = await readStatuses(plainClient as never, diamond, known, deadline);
  unread += readKnown.filter((st) => st === null).length;
  const statuses = readKnown.filter((st): st is OwnerSanctionsStatus => st !== null);
  // The SCREEN (Codex #2489 r2): a wallet flagged while it holds only ordinary
  // reward leaves neither of those traces — its claim's observation reverts
  // with the claim — so a bounded slice of every loan party is classified each
  // tick, and the held or confirmed ones join. Its first observation is what
  // starts the chain the forfeit window is counted from.
  // Discovery failures cost discovery, never the due observations (#2497
  // re-cut 3/3 pre-review): a screen that cannot run this time leaves the
  // known candidates to be served, and says so.
  let screen: ScreenOutcome = { found: [], overCapacity: null, unread: 0 };
  /** False when the screen itself failed: its capacity is then UNKNOWN, and
   *  nothing it would have measured may be cleared (Codex #2573 r2). */
  let screenMeasured = true;
  try {
    screen = await screenLoanParties(env, chain.id, plainClient as never, diamond, new Set(known), deadline);
  } catch (err) {
    screenMeasured = false;
    console.error(`[keeper] rewardSanctionsHold chain=${chain.id}: screen failed this run (known candidates are still served): ${shortErr(err)}`);
  }
  const screened = screen.found;
  unread += screen.unread;
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
    const readDeparted = await readStatuses(plainClient as never, diamond, departed, deadline);
    unread += readDeparted.filter((st) => st === null).length;
    statuses.push(...readDeparted.filter((st): st is OwnerSanctionsStatus => st !== null));
  }

  const plan = planSanctionsHold(statuses, nowSec);
  // A watched owner read as Deliver with nothing stored has nothing left for
  // this pass: it leaves the watch. Any other verdict keeps it.
  const watchedSet = new Set(watched);
  try {
    await unwatchSanctionsOwners(
      env.KEEPER_DB,
      chain.id,
      diamondAddr,
      statuses.filter((st) => watchedSet.has(st.owner.toLowerCase()) && st.decision === DECISION_DELIVER && !st.stored).map((st) => st.owner),
    );
  } catch (err) {
    // Bookkeeping only: the owner stays watched and is read again next run.
    console.error(`[keeper] rewardSanctionsHold chain=${chain.id}: watch-list cleanup failed this run: ${shortErr(err)}`);
  }
  // The run's deadline is honoured at each send's turn in the queue too
  // (`SendPastDeadline`), not only before the send joins it.
  const ctx = buildKeeperContext(env, chain, client as never, { notAfterMs: deadline });
  const budget = { writes: plan.writes, touched: new Set<string>(), deadline, moves: [] as ValueMove[] };
  /** MEASURED, not predicted (#2497 r16): the due observations and clean
   *  commits this tick never reached, because the write budget or the time
   *  window ran out. Null when there is no key to send with. */
  let shortfall: Shortfall | null = null;
  /** Owners a due observation or a clean commit was SENT for; whether it
   *  LANDED is decided below from a fresh read of the chain, never from the
   *  transaction's success (Codex #2573 r1). */
  const dueSent = new Set<string>();
  /** Owners with a final verdict whose staging resolution reverted this run,
   *  and those read whole with nothing wedged (whose alert may clear). */
  const stagingStuck = new Map<string, number>();
  const stagingClear = new Set<string>();
  /** Confirmed owners whose settlement reverted unexpectedly, with the reason. */
  const settleFailed = new Map<string, string>();
  const settleOk = new Set<string>();
  /** Final-verdict owners the backlog never reached this run (budget or
   *  deadline), MEASURED — the ceiling binding, said rather than predicted. */
  let backlogUnreached = 0;
  const cleanSent = new Set<string>();
  let reached = 0;
  let skippedOracleDown = 0;
  const measured = Boolean(ctx?.wallet.account);
  if (ctx?.wallet.account) {
    let dueReached = 0;
    // PHASE 1 — one observation-bearing write for EVERY due owner, most urgent
    // first, before anything else (#2497 r9). A Held owner gets the evidence
    // call. A Confirmed owner gets ONE settlement call (its observation is part
    // of the call) when that makes progress, else the evidence call — so its
    // chain is kept alive however large its backlog, and the backlog waits for
    // phase 3.
    const settleCallsUsed = new Map<string, number>();
    for (const due of plan.dueObservations) {
      const owner = due.owner;
      if (budget.writes <= 0 || Date.now() >= budget.deadline) break;
      dueReached += 1;
      if (due.confirmed) {
        // eslint-disable-next-line no-await-in-loop
        const settled = await runOwnerSettlement(ctx, budget, owner, 1, settleFailed, settleOk);
        settleCallsUsed.set(owner, settled ? 1 : 0);
        let sent = settled;
        if (!settled && budget.writes > 0) {
          // eslint-disable-next-line no-await-in-loop
          if (!(await oracleAnswers(client, diamond, owner))) {
            skippedOracleDown += 1;
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          sent = (await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner)) !== 'skipped';
        }
        if (sent) dueSent.add(owner.toLowerCase());
        continue;
      }
      // Every held observation waits for the oracle to answer (Codex #2573
      // r1): while it does not, the classifier writes no evidence — chain or
      // no chain — so the transaction would succeed, record nothing and spend
      // a write.
      // eslint-disable-next-line no-await-in-loop
      if (!(await oracleAnswers(client, diamond, owner))) {
        skippedOracleDown += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if ((await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner)) !== 'skipped') dueSent.add(owner.toLowerCase());
    }
    // PHASE 2 — the clean results (#2497 r7): until committed, a re-flag inside
    // the gap would continue the old chain. Sent only on the oracle's own clean
    // answer, so a Deliver that is not an authoritative Clean read (an outage,
    // a foreign-oracle chain) costs one read and no transaction.
    for (const owner of plan.commitClean) {
      if (budget.writes <= 0 || Date.now() >= budget.deadline) break;
      // eslint-disable-next-line no-await-in-loop
      if (!(await oracleSaysClean(client, diamond, owner))) continue;
      // eslint-disable-next-line no-await-in-loop
      if ((await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner)) !== 'skipped') cleanSent.add(owner.toLowerCase());
    }
    reached = dueReached;
    // PHASE 3 — the backlogs: the rest of each Confirmed owner's settlement,
    // then the staging pages, with whatever budget is left. The same rotation
    // rule as every other queue (#2497 r18): each owner's pages are capped per
    // run, and the starting owner rotates with the run, so one owner with a
    // deep backlog cannot take the whole phase run after run.
    const hourIndex = Math.floor(nowSec / 3600);
    const resolveCapped = async (owner: Address) => {
      const share = { writes: Math.min(budget.writes, MAX_RESOLVE_WRITES_PER_OWNER), touched: budget.touched, deadline: budget.deadline, moves: budget.moves };
      const before = share.writes;
      const r = await resolveOwnerRecords(env, ctx, share, owner);
      budget.writes -= before - share.writes;
      if (r.stuck > 0) stagingStuck.set(owner.toLowerCase(), r.stuck);
      else if (r.complete) stagingClear.add(owner.toLowerCase());
    };
    // ONE backlog of every final verdict, Confirmed and Deliver together,
    // rotated as one (Codex #2573 r2): two groups run one after the other
    // would let the first take every write, run after run. It stops at the
    // send deadline or an empty budget, before another owner's reads.
    const confirmed = new Set(plan.settle);
    const backlog = rotate([...plan.settle, ...plan.resolveOnly], hourIndex);
    for (const [i, owner] of backlog.entries()) {
      if (budget.writes <= 0 || Date.now() >= budget.deadline) {
        backlogUnreached = backlog.length - i;
        break;
      }
      if (confirmed.has(owner)) {
        const used = settleCallsUsed.get(owner) ?? 0;
        // eslint-disable-next-line no-await-in-loop
        if (used < MAX_SETTLE_CALLS_PER_OWNER) await runOwnerSettlement(ctx, budget, owner, MAX_SETTLE_CALLS_PER_OWNER - used, settleFailed, settleOk);
      }
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
  const freshBy = new Map<string, OwnerSanctionsStatus | null>();
  if (budget.touched.size > 0) {
    const touched = [...budget.touched];
    // The PLAIN client (Codex #2573 r1): this read belongs to the alert
    // window, past the send deadline the proxied client is bound to.
    const fresh = await readStatuses(plainClient as never, diamond, touched, deadline + PASS_ALERT_WINDOW_MS);
    touched.forEach((o, i) => freshBy.set(o.toLowerCase(), fresh[i]));
    alertStatuses = [
      ...statuses.filter((st) => !budget.touched.has(st.owner.toLowerCase())),
      ...fresh.filter((st): st is OwnerSanctionsStatus => st !== null),
    ];
    alertPlan = planSanctionsHold(alertStatuses, Math.floor(Date.now() / 1000));
  }
  if (measured) {
    const before = new Map(statuses.map((st) => [st.owner.toLowerCase(), st]));
    const landed = landedOn(dueSent, before, freshBy, evidenceAdvanced);
    const cleaned = landedOn(cleanSent, before, freshBy, (_pre, post) => !post.stored);
    shortfall = {
      due: plan.dueObservations.length - landed.yes,
      unreached: plan.dueObservations.length - reached,
      skippedOracleDown,
      clean: plan.commitClean.length - cleaned.yes,
      unread: unread + landed.unread + cleaned.unread,
      screenFailed: !screenMeasured,
      sourcesFailed: failedSources,
      backlogUnreached,
    };
  }
  await sendSanctionsNotices(env, chain.id, budget.moves, statuses, freshBy, deadline + PASS_ALERT_WINDOW_MS);
  await raiseAlerts(env, chain.id, alertStatuses, alertPlan, nowSec, screenMeasured ? screen.overCapacity : 'unmeasured', shortfall, deadline + PASS_ALERT_WINDOW_MS, { stuck: stagingStuck, clear: stagingClear, settleFailed, settleOk, openOwners: stagingRead === null ? undefined : new Set(stagingOwners.map((o) => o.toLowerCase())) });
}

/** The run's one-off notices (#2515), on the OPS channel: each landed
 *  settlement or staging resolution that moved value, with the amounts its
 *  receipt's events state, and each evidence chain this run saw restart. Past
 *  `deadline` the rest are left unsaid (the chain's events still record them).
 *  Exported for tests. */
export async function sendSanctionsNotices(
  env: Env,
  chainId: number,
  moves: readonly ValueMove[],
  before: readonly OwnerSanctionsStatus[],
  after: ReadonlyMap<string, OwnerSanctionsStatus | null>,
  deadline: number,
): Promise<void> {
  const tag = `[chain ${chainId}] reward sanctions hold`;
  const vpfi = (x: bigint) => `${formatUnits(x, 18)} VPFI`;
  for (const m of moves) {
    if (Date.now() >= deadline) return;
    const parts: string[] = [];
    if (m.heldApart > 0n) parts.push(`${vpfi(m.heldApart)} set apart for the owner (paid by its first claim once the flag is revoked)`);
    if (m.forfeited > 0n) parts.push(`${vpfi(m.forfeited)} forfeited into the recycle bucket`);
    if (m.stagedForfeited > 0n) parts.push(`${vpfi(m.stagedForfeited)} of a staged payout forfeited`);
    // eslint-disable-next-line no-await-in-loop
    await sendOpsNotice(
      env,
      `sanctions-moved:${chainId}:${m.tx}`,
      `${tag}: ${m.fn} for ${m.owner} (tx ${m.tx}) moved ${parts.join('; ')}. These are the amounts this transaction's own events state; any part settled by another transaction is told separately.`,
      Math.floor(Date.now() / 1000),
      chainId,
    );
  }
  const iso = (t: number) => new Date(t * 1000).toISOString();
  for (const pre of before) {
    if (Date.now() >= deadline) return;
    const post = after.get(pre.owner.toLowerCase());
    if (!post) continue;
    const lapse = lapsedChain(pre, post);
    if (!lapse) continue;
    const gapH = ((lapse.restartedAt - lapse.lastSeenAt) / 3600).toFixed(1);
    // eslint-disable-next-line no-await-in-loop
    await sendOpsNotice(
      env,
      `sanctions-lapsed:${chainId}:${pre.owner.toLowerCase()}:${lapse.restartedAt}`,
      `${tag}: the evidence chain of ${pre.owner} lapsed: last observed ${iso(lapse.lastSeenAt)}, due again by ${iso(lapse.missedAt)}, next observed ${iso(lapse.restartedAt)} (a ${gapH}h gap). Its confirmation window restarted from that observation, so its hold runs on.`,
      Math.floor(Date.now() / 1000),
      chainId,
    );
  }
}

/** What a run left undone, MEASURED. `screenFailed` is optional so a caller
 *  that ran no screen need not state it. */
export interface Shortfall {
  due: number;
  unreached: number;
  skippedOracleDown: number;
  clean: number;
  unread: number;
  screenFailed?: boolean;
  /** Candidate sources that could not be read this run, by name. */
  sourcesFailed?: readonly string[];
  /** Final-verdict owners whose settlement or staging the run never reached. */
  backlogUnreached?: number;
}

/** Whether an observation moved the owner's evidence: its chain started,
 *  restarted, was refreshed or cleared, or its verdict changed. Pure. */
export function evidenceAdvanced(pre: OwnerSanctionsStatus, post: OwnerSanctionsStatus): boolean {
  return post.lastSeenAt > pre.lastSeenAt || post.flaggedAt !== pre.flaggedAt || post.decision !== pre.decision;
}

/** Of the owners `sent`, how many the fresh read shows `moved`, and how many
 *  could not be re-read (unknown, never counted as landed). Pure. */
export function landedOn(
  sent: ReadonlySet<string>,
  before: ReadonlyMap<string, OwnerSanctionsStatus>,
  fresh: ReadonlyMap<string, OwnerSanctionsStatus | null>,
  moved: (pre: OwnerSanctionsStatus, post: OwnerSanctionsStatus) => boolean,
): { yes: number; unread: number } {
  let yes = 0;
  let unreadN = 0;
  for (const o of sent) {
    const pre = before.get(o);
    const post = fresh.get(o);
    if (!pre || post === undefined || post === null) {
      unreadN += 1;
      continue;
    }
    if (moved(pre, post)) yes += 1;
  }
  return { yes, unread: unreadN };
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
  if (total === 0) return { found: [], overCapacity: null, unread: 0 };
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
  // Held, Confirmed, and a CLEAN owner the contract still stores state for
  // (a chain, or the confirmed-flag marker another sanctions gate set): the
  // last stays watched until its clean result is committed (Codex #2573 r1).
  const found = read.filter(
    (st): st is OwnerSanctionsStatus => st !== null && (st.decision !== DECISION_DELIVER || st.stored),
  );
  const unread = read.filter((st) => st === null).length;
  // Watch first, cursor second: a failure between them re-reads the slice.
  await watchSanctionsOwners(env.KEEPER_DB, chainId, diamond, found.map((st) => st.owner));
  await putSanctionsScreenCursor(env.KEEPER_DB, chainId, diamond, nextScreenCursor(after, slice, ok, terminal));
  return { found, overCapacity, unread };
}

/** One screen tick: the owners found, whether a cycle overruns a day, and how
 *  many parties of the slice could not be read (the cursor waits at the first
 *  of them, so a persistent one is SAID, never a silent stall). */
interface ScreenOutcome {
  found: OwnerSanctionsStatus[];
  overCapacity: { total: number; ticks: number } | null;
  unread: number;
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
  /** Records a settlement that reverted for any reason OTHER than having
   *  nothing left to settle (Codex #2573 r3): named, so it is alerted. */
  failed?: Map<string, string>,
  /** Records an owner whose settlement simulated cleanly, or reported having
   *  nothing to settle: its failure alert may clear. */
  ok?: Set<string>,
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
      const name = revertName(err);
      if (failed && !(err instanceof PastRunDeadline) && name !== 'NoInteractionRewardsToClaim') {
        failed.set(owner.toLowerCase(), name ?? shortErr(err));
      } else if (name === 'NoInteractionRewardsToClaim') {
        ok?.add(owner.toLowerCase());
      }
      return sentAny;
    }
    if (decision !== DECISION_CONFIRMED) {
      ok?.add(owner.toLowerCase());
      return sentAny;
    }
    // Success is the RECEIPT's (Codex #2573 r4), never the simulation's.
    // eslint-disable-next-line no-await-in-loop
    const out = await send(ctx, budget, 'settleSanctionedInteractionRewards', [owner], owner);
    if (out === 'skipped') return sentAny;
    sentAny = true;
    if (out === 'failed') {
      failed?.set(owner.toLowerCase(), 'the settlement transaction failed');
      return sentAny;
    }
    if (out === 'unknown') return sentAny;
    ok?.add(owner.toLowerCase());
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
): Promise<{ stuck: number; complete: boolean }> {
  /** Resolving records or domains whose resolution page REVERTED this run:
   *  measured, so a wedged record is said (Codex #2573 r1). */
  const reverted: { n: number; unknown?: number } = { n: 0 };
  if (budget.writes <= 0) return { stuck: 0, complete: false };
  /** Every record of the owner READ this run — an unread one is unknown,
   *  so the owner cannot be reported clear (Codex #2573 r2). */
  let allRead = true;
  let readN = 0;
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
      if (r?.status !== 'success') {
        allRead = false;
        continue;
      }
      readN += 1;
      const view = r.result as { phase: number };
      if (Number(view.phase) !== PHASE_RESOLVING) continue;
      // eslint-disable-next-line no-await-in-loop
      // A record that belongs to a domain resolves through the domain's page
      // below; the standalone entry refuses it by name (`StagingRecordInDomain`),
      // which is the chain saying so, never a wedge (Codex #2573 r2).
      await sendIfEffective(ctx, budget, 'resolveStagedDayPage', [chunk[i] as Hex], () => true, owner, reverted, ['StagingRecordInDomain']);
    }
  }
  if (budget.writes <= 0 || !allRead || readN < keys.length) return { stuck: reverted.n, complete: false };
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
    await sendIfEffective(ctx, budget, 'resolveDomainPage', [t[0]], () => true, owner, reverted);
  }
  // Complete: every record and both domains were read and offered a page this
  // run, so a zero count is a measurement, not an absence.
  const complete = Date.now() < deadline && domains.every((r) => r?.status === 'success') && !reverted.unknown;
  return { stuck: reverted.n, complete };
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
  /** Counts a page that FAILED — a simulation that reverted, or a send whose
   *  transaction failed — and a send whose outcome is unknown. */
  reverted?: { n: number; unknown?: number },
  /** Revert reasons that are the contract routing the call elsewhere, not a
   *  failure: not counted in `reverted`. */
  expected: readonly string[] = [],
): Promise<SendOutcome> {
  try {
    const sim = await ctx.client.simulateContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: fn,
      args: args as never,
      account: ctx.wallet.account!,
    });
    if (!effective(sim.result)) return 'skipped';
  } catch (err) {
    console.log(`[keeper] rewardSanctionsHold ${fn} ${owner} would revert: ${shortErr(err)}`);
    if (reverted && !(err instanceof PastRunDeadline) && !expected.includes(revertName(err) ?? '')) reverted.n += 1;
    return 'skipped';
  }
  const out = await send(ctx, budget, fn, args, owner);
  if (reverted && out === 'failed') reverted.n += 1;
  if (reverted && out === 'unknown') reverted.unknown = (reverted.unknown ?? 0) + 1;
  return out;
}

/** What a send DID, measured (Codex #2573 r4) — one answer every caller
 *  decides from, so a simulation that succeeded is never mistaken for an
 *  outcome:
 *   - `landed`: the receipt says success;
 *   - `failed`: the receipt says reverted, or the send itself errored;
 *   - `unknown`: broadcast, but no receipt in time — it may still land;
 *   - `skipped`: not sent (no budget, or past the run's deadline). */
export type SendOutcome = 'landed' | 'failed' | 'unknown' | 'skipped';

async function send(
  ctx: KeeperContext,
  budget: { writes: number; touched?: Set<string>; deadline?: number; moves?: ValueMove[] },
  fn: string,
  args: readonly unknown[],
  owner: Address,
): Promise<SendOutcome> {
  // Past the run's send window, nothing more is sent this run (#2497 r16).
  if (budget.deadline !== undefined && Date.now() >= budget.deadline) budget.writes = 0;
  if (budget.writes <= 0) return 'skipped';
  let hash: Hex;
  try {
    hash = (await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: fn,
      args,
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never)) as Hex;
  } catch (err) {
    budget.writes = 0;
    // A deadline refusal is a deferral, said as one (nothing was sent), and
    // counts as skipped; anything else is a failed send (#2572 r6).
    const deferred = reportSendError(
      `[keeper] rewardSanctionsHold ${fn} owner=${owner}`,
      err,
      `send failed: ${shortErr(err)}`,
    );
    return deferred ? 'skipped' : 'failed';
  }
  try {
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
      return 'failed';
    }
    if (budget.moves && fn !== 'recordRewardSanctionsEvidence') {
      const m = valueMovesOf(receipt.logs as Log[], ctx.diamond, owner);
      if (m.heldApart > 0n || m.forfeited > 0n || m.stagedForfeited > 0n) budget.moves.push({ owner: owner.toLowerCase(), fn, tx: hash, ...m });
    }
    return 'landed';
  } catch (err) {
    console.error(`[keeper] rewardSanctionsHold ${fn} owner=${owner} receipt not seen in time: ${shortErr(err)}`);
    budget.writes = 0;
    return 'unknown';
  }
}

/** Raise or clear the pass's ops alerts for one chain. Exported for tests. */
export async function raiseAlerts(
  env: Env,
  chainId: number,
  statuses: readonly OwnerSanctionsStatus[],
  plan: SanctionsHoldPlan,
  nowSec: number,
  /** `'unmeasured'` = the screen did not run to a measurement: its alert stands. */
  screenOverCapacity: { total: number; ticks: number } | null | 'unmeasured' = null,
  /** What this tick left undone, measured ({@link observeChain}); null = not measured. */
  shortfall: Shortfall | null = null,
  /** Past this, alerts wait for the next run (#2497 r17); none by default. */
  alertDeadline: number = Number.POSITIVE_INFINITY,
  /** Staging resolution measured this run: owners whose page reverted, and
   *  owners read whole with nothing wedged. Others are left as they are. */
  staging: {
    stuck: ReadonlyMap<string, number>;
    clear: ReadonlySet<string>;
    settleFailed?: ReadonlyMap<string, string>;
    settleOk?: ReadonlySet<string>;
    openOwners?: ReadonlySet<string>;
  } = { stuck: new Map(), clear: new Set() },
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
  // The screen's daily bound, stated (#2497 r12) — and left as it is when the
  // screen did not measure it this run.
  if (screenOverCapacity !== 'unmeasured') await toggle(`sanctions-screen-capacity:${chainId}:all`, screenOverCapacity !== null, () =>
    `[chain ${chainId}] reward sanctions screen: ${screenOverCapacity?.total} loan parties take ${screenOverCapacity?.ticks} hourly ticks to screen, more than a day — a wallet flagged while holding only ordinary reward can go undiscovered that long. Raise the slice cap or the cadence.`,
  );
  // Capacity, MEASURED and stated per kind of work (#2497 r7, r16). An
  // observation left unsent this tick is what threatens a chain's bound; an
  // unsent clean commit is a separate backlog, said as such. A tick that could
  // not measure (no key) leaves both as they are.
  if (shortfall !== null) {
    // A run that could not READ a candidate cannot say whether it was due, so
    // an unread candidate keeps this alert raised — it is never cleared by a
    // run that did not look.
    await toggle(`sanctions-capacity:${chainId}:all`, shortfall.due > 0 || shortfall.unread > 0 || shortfall.screenFailed === true || (shortfall.sourcesFailed?.length ?? 0) > 0, () => {
      const attempted = shortfall.due - shortfall.unreached - shortfall.skippedOracleDown;
      const parts = [
        `${shortfall.due} due observation(s) did NOT land this tick: ${shortfall.unreached} unreached (the write budget or the run's time window ran out), ${shortfall.skippedOracleDown} not sent because the sanctions oracle is not answering, ${attempted} attempted but not recorded`,
      ];
      if (shortfall.sourcesFailed?.length) parts.push(`candidate source(s) unread this run (${shortfall.sourcesFailed.join(', ')}), so the wallets only they name were not looked at`);
      if (shortfall.screenFailed) parts.push('the daily screen of loan parties failed this run, so newly flagged wallets were not looked for');
      if (shortfall.unread > 0) parts.push(`${shortfall.unread} candidate(s) could not be classified at all (their status read failed), so whether they were due is unknown`);
      return `[chain ${chainId}] reward sanctions hold: ${parts.join('; ')} — if this persists, evidence chains will lapse past their ${OBSERVE_AFTER_SEC / 3600}h bound.`;
    });
    // The write ceiling binding on the final-verdict backlog, MEASURED (Codex
    // #2573 r3): due observations can all land while settlement and staging
    // are never reached — and a staging record blocks custody while it stands.
    const unreachedBacklog = shortfall.backlogUnreached ?? 0;
    await toggle(`sanctions-backlog:${chainId}:all`, unreachedBacklog > 0, () =>
      `[chain ${chainId}] reward sanctions hold: ${unreachedBacklog} owner(s) with a final verdict were not reached this run (the write budget or the run's time window ran out after every due observation). Their settlement and staging resolution wait; an unresolved staging record blocks custody activation and reward-role changes while it stands.`,
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
      `[chain ${chainId}] reward sanctions hold: ${st.owner} has been held past ${iso(st.forfeitableAt)} by more than the maximum observation gap.`,
    );
    // eslint-disable-next-line no-await-in-loop
    await toggle(k('hold-no-chain'), noChain.has(st.owner), () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} is held with no observation chain — the sanctions oracle is not answering authoritatively, or it answers Flagged but the chain broke and has not restarted; the hold cannot confirm or clear until an observation lands.`,
    );
  }
  // A final verdict whose staging work will not resolve (Codex #2573 r1):
  // measured from this run's reverted resolution pages, cleared only for an
  // owner whose records and domains were all read and none reverted.
  // A Confirmed owner's settlement that reverted for a reason other than
  // having nothing to settle, by name (Codex #2573 r3): its reward is
  // neither forfeited nor set apart while it stands.
  const settleFailed = staging.settleFailed ?? new Map<string, string>();
  for (const [owner, why] of settleFailed) {
    // eslint-disable-next-line no-await-in-loop
    await toggle(`sanctions-settle-failed:${chainId}:${owner}`, true, () =>
      `[chain ${chainId}] reward sanctions hold: the settlement of confirmed owner ${owner} reverted this run (${why}). Its reward is neither forfeited nor set apart until it succeeds.`,
    );
  }
  // Cleared on a measurement only: a settlement that simulated cleanly or had
  // nothing to settle, or a fresh read of the owner that is no longer Confirmed.
  const failPrefix = `sanctions-settle-failed:${chainId}:`;
  const notConfirmed = new Set(statuses.filter((st) => st.decision !== DECISION_CONFIRMED).map((st) => st.owner.toLowerCase()));
  for (const key of open) {
    if (!key.startsWith(failPrefix)) continue;
    const owner = key.slice(failPrefix.length).toLowerCase();
    if (settleFailed.has(owner)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (staging.settleOk?.has(owner) || notConfirmed.has(owner)) await toggle(key, false, () => '');
  }
  for (const [owner, n] of staging.stuck) {
    // eslint-disable-next-line no-await-in-loop
    await toggle(`sanctions-staging-stuck:${chainId}:${owner}`, true, () =>
      `[chain ${chainId}] reward sanctions hold: ${owner} has a final verdict, but ${n} staging resolution page(s) reverted this run. An unresolved staging record blocks custody activation and reward-role changes while it stands.`,
    );
  }
  // Cleared for an owner read whole with nothing wedged, and for one the
  // ledger shows holds no open staging work at all (resolved by any path).
  const stuckPrefix = `sanctions-staging-stuck:${chainId}:`;
  for (const key of open) {
    if (!key.startsWith(stuckPrefix)) continue;
    const owner = key.slice(stuckPrefix.length).toLowerCase();
    if (staging.stuck.has(owner)) continue;
    const gone = staging.openOwners !== undefined && !staging.openOwners.has(owner);
    // eslint-disable-next-line no-await-in-loop
    if (staging.clear.has(owner) || gone) await toggle(key, false, () => '');
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

/** The decoded custom error a simulation reverted with, when the ABI names it. */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return String(e?.shortMessage ?? e?.message ?? err).slice(0, 200);
}
