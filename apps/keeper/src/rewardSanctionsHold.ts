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
import { batchedRead } from './batchRead';
import {
  countLoanParties,
  getSanctionsScreenCursor,
  listLoanPartiesAfter,
  listOpenSanctionsChains,
  listOpenStagingOwners,
  listOpenStagingRecordKeysForUser,
  listOpsAlertKeys,
  putSanctionsScreenCursor,
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
/** Transactions this pass may send per chain per tick. */
const MAX_WRITES_PER_TICK = 25;
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
}

export interface SanctionsHoldPlan {
  /** Held owners to observe now. */
  observe: Address[];
  /** Confirmed owners whose chain is due an observation: observed by a
   *  settlement call that makes progress, else by the evidence call (a lapsed
   *  chain stops counting the days the owner earns next). */
  settleObserveDue: Address[];
  /** Owners whose rewards to settle: Confirmed runs the settlement, then the
   *  pages. */
  settle: Address[];
  /** Owners whose Resolving records to resolve without a settlement (Deliver). */
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
 * The wallets worth classifying: every wallet with an open evidence chain and
 * every owner of an open staging record or domain, once each, lowercased. Pure;
 * the two reads ({@link listOpenSanctionsChains}, {@link listOpenStagingOwners})
 * decide openness on the chain's own events, so nothing here filters by age.
 */
export function candidateOwners(openChains: readonly string[], stagingOwners: readonly string[]): Address[] {
  return [...new Set([...openChains, ...stagingOwners].map((w) => w.toLowerCase() as Address))];
}

/** What to do for each classified candidate. Pure: the contract's verdict and
 *  deadlines in, the pass's actions out. */
export function planSanctionsHold(
  statuses: readonly OwnerSanctionsStatus[],
  nowSec: number,
): SanctionsHoldPlan {
  const plan: SanctionsHoldPlan = {
    observe: [],
    settleObserveDue: [],
    settle: [],
    resolveOnly: [],
    deadlineAtRisk: [],
    overdue: [],
    heldWithoutChain: [],
  };
  for (const st of statuses) {
    if (st.decision === DECISION_CONFIRMED) {
      plan.settle.push(st.owner);
      if (observeDue(st, nowSec)) plan.settleObserveDue.push(st.owner);
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
  // Owners of open staging work join the open chains: a claimant held with NO
  // chain (the oracle was unavailable when its page ran, a flag marker set)
  // emits no evidence event, so the events alone never surface it.
  const known = candidateOwners(
    await listOpenSanctionsChains(env.DB, chain.id),
    await listOpenStagingOwners(env.DB, chain.id),
  );
  const client = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;
  const statuses = (await readStatuses(client as never, diamond, known)).filter(
    (st): st is OwnerSanctionsStatus => st !== null,
  );
  // The SCREEN (Codex #2489 r2): a wallet flagged while it holds only ordinary
  // reward leaves neither of those traces — its claim's observation reverts
  // with the claim — so a bounded slice of every loan party is classified each
  // tick, and the held or confirmed ones join. Its first observation is what
  // starts the chain the forfeit window is counted from.
  const screened = await screenLoanParties(env, chain.id, client as never, diamond, new Set(known));
  statuses.push(...screened);
  const candidates = new Set<string>([...known, ...screened.map((st) => st.owner)]);

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
    const settleDue = new Set(plan.settleObserveDue);
    for (const owner of plan.settle) {
      // eslint-disable-next-line no-await-in-loop
      const settled = await runOwnerSettlement(ctx, budget, owner);
      if (!settled && settleDue.has(owner) && budget.writes > 0) {
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
  } else if (plan.observe.length + plan.settle.length > 0) {
    console.warn(
      `[keeper] rewardSanctionsHold chain=${chain.id}: ${plan.observe.length} to observe and ${plan.settle.length} to settle, but no keeper key — nothing sent`,
    );
  }
  await raiseAlerts(env, chain.id, statuses, plan, nowSec, candidates);
}

/** Each owner's classification, `getRewardSanctionsStatus` batched, aligned
 *  with `owners` — null where the read failed (classified next tick). */
async function readStatuses(
  client: PublicClient,
  diamond: Address,
  owners: readonly string[],
): Promise<(OwnerSanctionsStatus | null)[]> {
  const out: (OwnerSanctionsStatus | null)[] = [];
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
 *  for a cycle by a transient error. A slice shorter than asked has reached
 *  the end: start over. Pure; pinned by the tests. */
export function nextScreenCursor(after: string, slice: readonly string[], read: readonly boolean[], asked: number): string {
  const firstFail = read.indexOf(false);
  if (firstFail >= 0) return firstFail === 0 ? after : slice[firstFail - 1];
  return slice.length < asked ? '' : slice[slice.length - 1];
}

/** One tick of the screen: the next slice of loan parties (skipping ones the
 *  pass already knows), classified; the held or confirmed are returned to
 *  join the candidates, and the cursor moves on. */
async function screenLoanParties(
  env: Env,
  chainId: number,
  client: PublicClient,
  diamond: Address,
  known: ReadonlySet<string>,
): Promise<OwnerSanctionsStatus[]> {
  const total = await countLoanParties(env.DB, chainId);
  if (total === 0) return [];
  const size = screenSliceSize(total);
  if (Math.ceil(total / size) > SCREENS_PER_DAY) {
    console.warn(
      `[keeper] rewardSanctionsHold chain=${chainId}: ${total} loan parties exceed one day's screen at ${size} a tick — a cycle takes ${Math.ceil(total / size)} ticks`,
    );
  }
  const after = await getSanctionsScreenCursor(env.KEEPER_DB, chainId, diamond);
  const slice = await listLoanPartiesAfter(env.DB, chainId, after, size);
  const toRead = slice.filter((a) => !known.has(a));
  const read = await readStatuses(client, diamond, toRead);
  const byOwner = new Map(toRead.map((a, i) => [a, read[i]]));
  const ok = slice.map((a) => known.has(a) || byOwner.get(a) !== null);
  await putSanctionsScreenCursor(env.KEEPER_DB, chainId, diamond, nextScreenCursor(after, slice, ok, size));
  return read.filter((st): st is OwnerSanctionsStatus => st !== null && st.decision !== DECISION_DELIVER);
}

/** The owner settlement, repeated while it makes progress: each call is
 *  SIMULATED first and sent only when it would succeed — it reverts, as a
 *  claim does, when there is nothing left to settle, and returns early on a
 *  verdict that is not Confirmed — so an owner already settled costs one read.
 *  A sent call's on-chain observation is part of the same call, so it also
 *  keeps the chain alive. Returns whether any call was sent. */
async function runOwnerSettlement(ctx: KeeperContext, budget: { writes: number }, owner: Address): Promise<boolean> {
  let sentAny = false;
  for (let call = 0; call < MAX_SETTLE_CALLS_PER_OWNER && budget.writes > 0; call++) {
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
  budget: { writes: number },
  owner: Address,
): Promise<void> {
  if (budget.writes <= 0) return;
  // The owner's OPEN records only, however old (Codex #2489 r1); read in
  // bounded chunks, each record's own phase deciding whether a page is due.
  const keys = await listOpenStagingRecordKeysForUser(env.DB, ctx.chainId, owner);
  for (let c = 0; c < keys.length && budget.writes > 0; c += STATUS_CHUNK) {
    const chunk = keys.slice(c, c + STATUS_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const reads = await batchedRead(
      ctx.client as never,
      chunk.map((key) => ({
        address: ctx.diamond,
        abi: ABI,
        functionName: 'getStagingRecord' as const,
        args: [key as Hex] as const,
      })),
      `rewardSanctionsHold records ${owner} ${c}/${keys.length}`,
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
  const domains = await batchedRead(
    ctx.client as never,
    [0, 1].map((side) => ({
      address: ctx.diamond,
      abi: ABI,
      functionName: 'getStagingDomain' as const,
      args: [owner, side] as const,
    })),
    `rewardSanctionsHold domains ${owner}`,
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
  candidates: ReadonlySet<string>,
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
  const toggle = async (key: string, on: boolean, text: () => string): Promise<void> => {
    if (on) await sendOpsAlert(env, key, text(), ALERT_REPEAT_SEC, nowSec);
    else if (open.has(key)) await resolveOpsAlert(env, key);
  };
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
  // An owner who LEFT the candidates (a clean read or a claim closed its chain
  // and no staging work remains) is never in `statuses` again, so the loop
  // above can never clear its alerts (Codex #2489 r2): a stale row would
  // suppress the next incident for that wallet and the table would only grow.
  // Keyed on the candidate set, not on this tick's reads, so an owner whose
  // read merely failed keeps its alert.
  for (const key of open) {
    const owner = key.slice(key.lastIndexOf(':') + 1).toLowerCase();
    // eslint-disable-next-line no-await-in-loop
    if (!candidates.has(owner)) await resolveOpsAlert(env, key);
  }
}

function iso(sec: number): string {
  return sec > 0 ? new Date(sec * 1000).toISOString() : 'unknown';
}

function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return String(e?.shortMessage ?? e?.message ?? err).slice(0, 200);
}
