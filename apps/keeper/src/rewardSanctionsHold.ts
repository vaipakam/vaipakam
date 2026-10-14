// apps/keeper/src/rewardSanctionsHold.ts
//
// #2450 — the #1566 sanctions-hold observer.
//
// The reward sanctions rule forfeits a flagged owner's undelivered interaction
// reward only once the flag is CONFIRMED: a chain of authoritative Flagged
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
//   1. CANDIDATES — wallets with sanctions evidence, read from the indexer's
//      record of the chain's own events (`activity_events`): every wallet
//      whose latest evidence event starts a chain, plus every wallet whose
//      chain was cleared recently (its record may still be Resolving from the
//      hold, and the claimant is owed the payout).
//   2. CLASSIFY — `getRewardSanctionsStatus`, the contract's ONE classifier
//      read without writing, batched. Its deadlines (`observeBy`,
//      `forfeitableAt`) are the contract's, never restated here.
//   3. ACT — Hold: `recordRewardSanctionsEvidence` once the latest observation
//      is `OBSERVE_AFTER_SEC` old (a quarter of G). Forfeit: the owner sweep
//      (`forfeitFlaggedOwnerRewards`, paged) and then the owner's Resolving
//      staging records and domains, whose resolution page forfeits the held
//      share into the recycle bucket and closes the record. Deliver (a chain
//      cleared): the same resolution pages, which now pay the claimant. Every
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
  RewardHorizonSweepFacetABI,
  RewardStagingDomainFacetABI,
  RewardStagingSettleFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import { batchedRead } from './batchRead';
import {
  listSanctionsEvidenceEvents,
  listStagingRecordKeysForUser,
  listStagingRecordOwners,
  SANCTIONS_EVIDENCE_ROW_LIMIT,
  type SanctionsEvidenceRow,
} from './db';
import { resolveOpsAlert, sendOpsAlert } from './opsAlert';

const ABI = [
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(ProfileFacetABI as Abi),
  ...(RewardHorizonSweepFacetABI as Abi),
  ...(RewardStagingDomainFacetABI as Abi),
  ...(RewardStagingSettleFacetABI as Abi),
] as Abi;

/** `LibRewardSanctions.Decision`. */
export const DECISION_DELIVER = 0;
export const DECISION_HOLD = 1;
export const DECISION_FORFEIT = 2;

/** Observe a held owner once its latest observation is this old: a quarter of
 *  the contract's one-day maximum gap, so three more passes run before the
 *  chain could break. */
export const OBSERVE_AFTER_SEC = 6 * 3600;
/** This pass's cadence in seconds (passSchedule). Alert margins are one cadence. */
export const PASS_CADENCE_SEC = 60 * 60;
/** A wallet whose chain was cleared stays a candidate this long, so a staging
 *  record it left `Resolving` during the hold is still resolved. */
export const CLEARED_CANDIDATE_SEC = 30 * 86_400;

/** `LibVaipakam.StagingPhase.Resolving` / `DomainPhase.Resolving`. */
const PHASE_RESOLVING = 3;
/** Status reads per `aggregate3` (the other passes' bound, #1946). */
const STATUS_CHUNK = 100;
/** Transactions this pass may send per chain per tick. */
const MAX_WRITES_PER_TICK = 25;
/** Sweep page arguments; the facet clamps both (32 entries, 30 steps). */
const FORFEIT_PAGE_ENTRIES = 32n;
const FORFEIT_MAX_STEPS = 30n;
/** Sweep pages per owner per tick; the rest resumes next tick. */
const MAX_FORFEIT_PAGES_PER_OWNER = 4;
/** Re-send a still-standing ops condition at most this often. */
const ALERT_REPEAT_SEC = 6 * 3600;
/** How far back staging-record owners join the candidates (#2450 review):
 *  a held claimant whose chain never started emits no evidence event. */
const STAGING_OWNER_LOOKBACK_SEC = 30 * 86_400;
const ORACLE_ABI = parseAbi(['function isSanctioned(address) view returns (bool)']);

/** One candidate's classification, as `getRewardSanctionsStatus` returns it. */
export interface OwnerSanctionsStatus {
  owner: Address;
  decision: number;
  flaggedAt: number;
  lastSeenAt: number;
  forfeitableAt: number;
  observeBy: number;
}

export interface SanctionsHoldPlan {
  /** Held owners to observe now. */
  observe: Address[];
  /** Forfeit owners whose chain is due an observation: observed by a sweep page
   *  that makes progress, else by the evidence call (a lapsed chain would
   *  restart confirmation for whatever accrues to them next). */
  forfeitObserveDue: Address[];
  /** Owners whose rewards to settle: Forfeit runs the sweep, then the pages. */
  forfeit: Address[];
  /** Owners whose Resolving records to resolve without a sweep (Deliver). */
  resolveOnly: Address[];
  /** Held owners whose chain breaks within one cadence. */
  deadlineAtRisk: OwnerSanctionsStatus[];
  /** Held owners past confirmation by more than the maximum gap. */
  overdue: OwnerSanctionsStatus[];
  /** Held owners with no observation chain: the oracle is not answering, or it
   *  answers Flagged but the chain broke and has not restarted. */
  heldWithoutChain: OwnerSanctionsStatus[];
}

/**
 * The wallets worth classifying, from the chain's own evidence events (oldest
 * first): every wallet whose LATEST event starts a chain, plus every wallet
 * whose chain was cleared within `CLEARED_CANDIDATE_SEC`.
 */
export function candidateOwners(rows: readonly SanctionsEvidenceRow[], nowSec: number): Address[] {
  const latest = new Map<string, SanctionsEvidenceRow>();
  for (const r of rows) latest.set(r.who, r); // rows are oldest first: the last one wins
  const out: Address[] = [];
  for (const [who, r] of latest) {
    if (r.kind === 'RewardSanctionsEvidenceRecorded') out.push(who as Address);
    else if (nowSec - r.block_at <= CLEARED_CANDIDATE_SEC) out.push(who as Address);
  }
  return out;
}

/** What to do for each classified candidate. Pure: the contract's verdict and
 *  deadlines in, the pass's actions out. */
export function planSanctionsHold(
  statuses: readonly OwnerSanctionsStatus[],
  nowSec: number,
): SanctionsHoldPlan {
  const plan: SanctionsHoldPlan = {
    observe: [],
    forfeitObserveDue: [],
    forfeit: [],
    resolveOnly: [],
    deadlineAtRisk: [],
    overdue: [],
    heldWithoutChain: [],
  };
  for (const st of statuses) {
    if (st.decision === DECISION_FORFEIT) {
      plan.forfeit.push(st.owner);
      if (observeDue(st, nowSec)) plan.forfeitObserveDue.push(st.owner);
      continue;
    }
    if (st.decision === DECISION_DELIVER) {
      plan.resolveOnly.push(st.owner);
      continue;
    }
    if (st.decision !== DECISION_HOLD) continue;
    // Hold. A chain that has never been observed, or whose latest observation
    // is a quarter-gap old, is observed now.
    if (observeDue(st, nowSec)) plan.observe.push(st.owner);
    if (st.flaggedAt === 0) {
      plan.heldWithoutChain.push(st);
      continue;
    }
    if (st.observeBy !== 0 && st.observeBy - nowSec <= PASS_CADENCE_SEC) plan.deadlineAtRisk.push(st);
    // The maximum gap, read from the contract's own pair rather than restated.
    const gap = st.observeBy !== 0 && st.lastSeenAt !== 0 ? st.observeBy - st.lastSeenAt : 0;
    if (st.forfeitableAt !== 0 && gap > 0 && nowSec > st.forfeitableAt + gap) plan.overdue.push(st);
  }
  return plan;
}

/** One rule for when a chain is due an observation, for every decision: never
 *  observed, or its latest observation is a quarter of the maximum gap old. */
export function observeDue(st: OwnerSanctionsStatus, nowSec: number): boolean {
  return st.lastSeenAt === 0 || nowSec - st.lastSeenAt >= OBSERVE_AFTER_SEC;
}

/** Sweep a page only when it makes progress: a page that stamps and settles
 *  nothing (the day not final yet, held by the delivery gate, no headroom or
 *  backing room) is not worth a transaction every tick — its observation, if
 *  due, is the cheap evidence call instead. */
export function sweepPageEffective(stamped: bigint, settled: bigint): boolean {
  return stamped > 0n || settled > 0n;
}

export async function runRewardSanctionsHold(env: Env): Promise<void> {
  if (!passIsArmed(env, 'rewardSanctionsHold', 'REWARD_SANCTIONS_KEEPER_ENABLED')) return;
  for (const chain of getChainConfigs(env)) {
    try {
      await observeChain(env, chain);
    } catch (err) {
      console.error(`[keeper] rewardSanctionsHold chain=${chain.id} failed:`, err);
    }
  }
}

async function observeChain(env: Env, chain: ChainConfig): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await listSanctionsEvidenceEvents(env.DB, chain.id);
  if (rows.length >= SANCTIONS_EVIDENCE_ROW_LIMIT) {
    console.warn(
      `[keeper] rewardSanctionsHold chain=${chain.id}: ${rows.length} evidence rows hit the read bound — the newest may be unread`,
    );
  }
  // Owners of recent staging records join the candidates: a claimant held with
  // NO chain (the oracle was unavailable when its page ran, a flag marker set)
  // emits no evidence event, so the events alone never surface it.
  const recordOwners = await listStagingRecordOwners(env.DB, chain.id, nowSec - STAGING_OWNER_LOOKBACK_SEC);
  const owners = [...new Set([...candidateOwners(rows, nowSec), ...recordOwners.map((o) => o.toLowerCase() as Address)])];
  if (owners.length === 0) return;

  const client = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;
  const statuses: OwnerSanctionsStatus[] = [];
  for (let i = 0; i < owners.length; i += STATUS_CHUNK) {
    const chunk = owners.slice(i, i + STATUS_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const res = await batchedRead(
      client as never,
      chunk.map((owner) => ({
        address: diamond,
        abi: ABI,
        functionName: 'getRewardSanctionsStatus' as const,
        args: [owner] as const,
      })),
      `rewardSanctionsHold getRewardSanctionsStatus ${i}/${owners.length}`,
    );
    res.forEach((r, j) => {
      if (r.status !== 'success') return; // unread: classified next tick
      const t = r.result as readonly [number, bigint | number, bigint | number, bigint | number, bigint | number, Address, boolean];
      statuses.push({
        owner: chunk[j],
        decision: Number(t[0]),
        flaggedAt: Number(t[1]),
        lastSeenAt: Number(t[2]),
        forfeitableAt: Number(t[3]),
        observeBy: Number(t[4]),
      });
    });
  }

  const plan = planSanctionsHold(statuses, nowSec);
  const ctx = buildKeeperContext(env, chain, client as never);
  const budget = { writes: MAX_WRITES_PER_TICK };
  if (ctx?.wallet.account) {
    const noChain = new Set(plan.heldWithoutChain.map((st) => st.owner));
    for (const owner of plan.observe) {
      if (budget.writes <= 0) break;
      // A held owner with no chain is observed only while the oracle answers:
      // during an outage the observation records nothing, and an hourly
      // transaction would buy nothing until it recovers.
      // eslint-disable-next-line no-await-in-loop
      if (noChain.has(owner) && !(await oracleAnswers(client, diamond, owner))) continue;
      // eslint-disable-next-line no-await-in-loop
      await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner);
    }
    const forfeitDue = new Set(plan.forfeitObserveDue);
    for (const owner of plan.forfeit) {
      // eslint-disable-next-line no-await-in-loop
      const swept = await runOwnerSweep(ctx, budget, owner);
      if (!swept && forfeitDue.has(owner) && budget.writes > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sendIfEffective(ctx, budget, 'recordRewardSanctionsEvidence', [owner], () => true, owner);
      }
      // eslint-disable-next-line no-await-in-loop
      await resolveOwnerRecords(env, ctx, budget, owner);
    }
    for (const owner of plan.resolveOnly) {
      // eslint-disable-next-line no-await-in-loop
      await resolveOwnerRecords(env, ctx, budget, owner);
    }
  } else if (plan.observe.length + plan.forfeit.length > 0) {
    console.warn(
      `[keeper] rewardSanctionsHold chain=${chain.id}: ${plan.observe.length} to observe and ${plan.forfeit.length} to settle, but no keeper key — nothing sent`,
    );
  }
  await raiseAlerts(env, chain.id, statuses, plan, nowSec);
}

/** The owner sweep, paged from index 0: each page simulated, sent only when it
 *  stamps or settles (#2450 review: a page that leaves work but makes no
 *  progress is not sent). A page's on-chain observation is part of the same
 *  call, so a sent page also keeps the chain alive. Returns whether any page
 *  was sent. */
async function runOwnerSweep(ctx: KeeperContext, budget: { writes: number }, owner: Address): Promise<boolean> {
  let sentAny = false;
  let from = 0n;
  for (let page = 0; page < MAX_FORFEIT_PAGES_PER_OWNER && budget.writes > 0; page++) {
    let result: readonly [number, bigint, bigint, bigint, bigint];
    try {
      // eslint-disable-next-line no-await-in-loop
      const sim = await ctx.client.simulateContract({
        address: ctx.diamond,
        abi: ABI,
        functionName: 'forfeitFlaggedOwnerRewards',
        args: [owner, from, FORFEIT_PAGE_ENTRIES, FORFEIT_MAX_STEPS],
        account: ctx.wallet.account!,
      });
      result = sim.result as readonly [number, bigint, bigint, bigint, bigint];
    } catch (err) {
      console.log(`[keeper] rewardSanctionsHold sweep ${owner} from=${from} would revert: ${shortErr(err)}`);
      return sentAny;
    }
    const [decision, stamped, settled, nextIndex] = result;
    if (Number(decision) !== DECISION_FORFEIT) return sentAny;
    if (sweepPageEffective(stamped, settled)) {
      // eslint-disable-next-line no-await-in-loop
      const sent = await send(ctx, budget, 'forfeitFlaggedOwnerRewards', [owner, from, FORFEIT_PAGE_ENTRIES, FORFEIT_MAX_STEPS], owner);
      if (!sent) return sentAny;
      sentAny = true;
    }
    if (nextIndex <= from) return sentAny; // the list is exhausted
    from = nextIndex;
  }
  return sentAny;
}

/** Whether the chain's sanctions oracle answers for `owner` right now — a view
 *  read off chain, so a no-chain held owner is observed only when an
 *  observation can record something. No oracle, or a failing read: false. */
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
 *  a Deliver claimant, forfeits a confirmed one, and withholds a held one —
 *  the last case is never reached here (held owners are observed instead). */
async function resolveOwnerRecords(
  env: Env,
  ctx: KeeperContext,
  budget: { writes: number },
  owner: Address,
): Promise<void> {
  if (budget.writes <= 0) return;
  const keys = await listStagingRecordKeysForUser(env.DB, ctx.chainId, owner);
  const reads = await batchedRead(
    ctx.client as never,
    [
      ...keys.map((key) => ({
        address: ctx.diamond,
        abi: ABI,
        functionName: 'getStagingRecord' as const,
        args: [key as Hex] as const,
      })),
      ...[0, 1].map((side) => ({
        address: ctx.diamond,
        abi: ABI,
        functionName: 'getStagingDomain' as const,
        args: [owner, side] as const,
      })),
    ],
    `rewardSanctionsHold records ${owner}`,
  );
  for (let i = 0; i < keys.length && budget.writes > 0; i++) {
    const r = reads[i];
    if (r?.status !== 'success') continue;
    const view = r.result as { phase: number };
    if (Number(view.phase) !== PHASE_RESOLVING) continue;
    // eslint-disable-next-line no-await-in-loop
    await sendIfEffective(ctx, budget, 'resolveStagedDayPage', [keys[i] as Hex], () => true, owner);
  }
  for (let side = 0; side < 2 && budget.writes > 0; side++) {
    const r = reads[keys.length + side];
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
  budget: { writes: number },
  fn: string,
  args: readonly unknown[],
  owner: Address,
): Promise<boolean> {
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
    console.log(`[keeper] rewardSanctionsHold ${fn} owner=${owner} chain=${ctx.chainId} tx=${hash}`);
    // No receipt wait: every call here is idempotent, and the next tick
    // re-reads the contract's verdict before acting again.
    return true;
  } catch (err) {
    console.error(`[keeper] rewardSanctionsHold ${fn} owner=${owner} send failed: ${shortErr(err)}`);
    return false;
  }
}

async function raiseAlerts(
  env: Env,
  chainId: number,
  statuses: readonly OwnerSanctionsStatus[],
  plan: SanctionsHoldPlan,
  nowSec: number,
): Promise<void> {
  const atRisk = new Set(plan.deadlineAtRisk.map((s) => s.owner));
  const overdue = new Set(plan.overdue.map((s) => s.owner));
  const noChain = new Set(plan.heldWithoutChain.map((s) => s.owner));
  for (const st of statuses) {
    const k = (what: string) => `sanctions-${what}:${chainId}:${st.owner}`;
    // eslint-disable-next-line no-await-in-loop
    await toggle(env, k('observe-deadline'), atRisk.has(st.owner), nowSec, () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} must be observed by ${iso(st.observeBy)} or its confirmation window restarts — the keeper's observations are not landing.`,
    );
    // eslint-disable-next-line no-await-in-loop
    await toggle(env, k('hold-overdue'), overdue.has(st.owner), nowSec, () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} has been held past ${iso(st.forfeitableAt)} by more than the maximum observation gap. A held staging record blocks custody activation and reward-role changes while it stands.`,
    );
    // eslint-disable-next-line no-await-in-loop
    await toggle(env, k('hold-no-chain'), noChain.has(st.owner), nowSec, () =>
      `[chain ${chainId}] reward sanctions hold: ${st.owner} is held with no observation chain — the sanctions oracle is not answering authoritatively, or it answers Flagged but the chain broke and has not restarted; the hold cannot confirm or clear until an observation lands.`,
    );
  }
}

async function toggle(env: Env, key: string, on: boolean, nowSec: number, text: () => string): Promise<void> {
  if (on) await sendOpsAlert(env, key, text(), ALERT_REPEAT_SEC, nowSec);
  else await resolveOpsAlert(env, key);
}

function iso(sec: number): string {
  return sec > 0 ? new Date(sec * 1000).toISOString() : 'unknown';
}

function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return String(e?.shortMessage ?? e?.message ?? err).slice(0, 200);
}
