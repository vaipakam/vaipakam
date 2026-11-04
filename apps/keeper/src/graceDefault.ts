/**
 * apps/keeper — time-based default pass (#2483).
 *
 * Closes out loans whose grace period has ended by submitting the
 * permissionless `DefaultedFacet.triggerDefault(loanId, adapterCalls)`, so a
 * lender who never opens the app is still closed out and only has to claim.
 * The lender's close-out card (#2474) sends the same transaction; this pass
 * applies the card's rules rather than a second set of its own.
 *
 * Per run — bounded, because the invocation's 50-subrequest allowance is
 * shared by every chain and every pass the tick launches:
 *
 *   1. ONE chain, taking turns by run index. Pin one block and read one
 *      SCAN_WINDOW of its active list at it; a larger book is walked a
 *      window per visit. Swap-and-pop on the active list can skip a loan
 *      mid-pagination when the scan spans blocks — the liquidator's reason
 *      for pinning, and the same here.
 *   2. Batch-read `isLoanDefaultable` at that block. The contract's own view
 *      is the eligibility rule; nothing here re-derives grace arithmetic.
 *   3. MAX_ATTEMPTS_PER_RUN candidates from the window, successive visits
 *      to it taking successive ones, so a loan that never closes cannot
 *      hold the front of the queue (`pickBatch`). All of it is derived from
 *      the scheduled tick, so nothing persists between isolates:
 *        a. Not the liquidator's. A loan that is also under water belongs
 *           to the HF liquidator, wholly — it runs every tick from the same
 *           keeper account, and two passes each deciding whether to close
 *           one loan race two terminal transactions however the decision
 *           is split. This pass does not act on it at all. When the
 *           liquidator finds no route for such a loan and it is past grace,
 *           the liquidator itself sends the in-kind close-out through the
 *           same attempt this pass uses (`attemptCloseOut(..., 'in-kind')`,
 *           #2487), so the loan still has exactly one owner.
 *        b. The sale interlock (#2078): `triggerDefault` does not inspect
 *           sale linkage, so closing a loan after a buyer accepted its
 *           lender-position sale strands the buyer's principal. An accepted
 *           sale, or a sale state the chain does not establish, skips.
 *        c. The try-list. Liquid ERC-20 collateral for an ERC-20 loan is
 *           quoted through the shared route builder for only the
 *           collateral the debt needs: the middle of the range
 *           `previewForcedSale(loanId, TimeBasedDefault)` accepts (#2796).
 *           Anything else sends an empty list and lets the contract take its
 *           in-kind branch, or refuse.
 *        d. The final gate, everything at ONE fresh block: the health
 *           factor still on the side of the line step a judged it on, the
 *           sale state again, the collateral amount the quotes were made
 *           for (#2472), the quoted amount still inside the contract's
 *           range, and the preview.
 *           `previewCloseOut` runs the call on `eth_simulateV1` and
 *           reads its logs, because a plain simulation SUCCEEDS into the
 *           full-collateral fallback when every route fails. Only a `sale`
 *           or an `other` ending (in-kind, collapsed LTV, internal match,
 *           rental) is sent. A route that would fall back is not: the spec
 *           wants a liquid forced close to make a real market attempt, and
 *           a route already known to fail is not one. The preview is in
 *           the gate, not before it, so the route is judged at the block
 *           the other reads are.
 *        e. Submit. The receipt is not awaited; the next tick's
 *           `isLoanDefaultable` read is what says whether it landed.
 *
 * Every defaultable loan is named in the log — attempted (with what
 * happened to it), deferred to a later batch, or unread — so `wrangler tail`
 * says why a past-grace loan is still Active.
 *
 * What stays uncovered is the gap between the final gate and inclusion: no
 * read from off-chain closes it. The on-chain guards that would are #2078
 * and #2472.
 *
 * Gated by KEEPER_ENABLED + GRACE_DEFAULT_ENABLED. The pass moves a
 * borrower's collateral, so it gets its own flag rather than riding the
 * keeper-wide one, and it is dark until that flag is armed.
 */

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import { DefaultedFacetABI } from '@vaipakam/contracts/abis';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { attemptErrorReason } from './keeperSend';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { deadlineFetch, PastRunDeadline, readPhaseClient, settledChunkedRead } from './batchRead';
import { readCutoffMs } from './runWindow';
import { createSubrequestBudget } from './subrequestBudget';
import { orchestrateServerQuotes } from './serverQuotes';
import type { PassTick } from './passSchedule';
import { attemptGraceDefault, type GraceDefaultDeps, type GraceDefaultOutcome } from './closeOut';

// The per-loan attempt lives in ./closeOut, shared with the liquidator's
// in-kind fallback (#2487). Re-exported so existing importers keep working.
export {
  attemptGraceDefault,
  LEFT_TO_LIQUIDATOR,
  type GraceDefaultDeps,
  type GraceDefaultOutcome,
  type GraceLoan,
} from './closeOut';
import { pickBatch } from './rotate';
import { readActiveWindow, scanCutoffs, type ScanCutoffs, type ScanWindow } from './activeLoanWindow';

const DEFAULTED_ABI: Abi = DefaultedFacetABI as Abi;

/** The shared active-list window (`activeLoanWindow.ts`): with four
 *  eligibility aggregates on top, a run's scan costs at most eight
 *  subrequests (block, count, pages, aggregates) however large the book. */
export { SCAN_WINDOW, type ScanWindow } from './activeLoanWindow';

/** `isLoanDefaultable` reads per aggregate — the liquidator's HF chunk size,
 *  so one eth_call never grows with the active-loan count. */
const READ_CHUNK = 100;

/** Candidates attempted per run. One attempt costs about eighteen
 *  requests plus two per enabled swap adapter (the roster is read one
 *  adapter at a time) plus the aggregator quotes. The CPU bench measures 35
 *  for a whole run (scan, a quoted route, preview and send) with three
 *  adapters. A longer roster can
 *  push an attempt past {@link SUBREQUEST_BUDGET}; the cap then stops it
 *  before the send. */
export const MAX_ATTEMPTS_PER_RUN = 1;

/** Requests one run may make, all told: the scan, the attempt (its route
 *  build and quotes included) and the send. A HARD cap, enforced on the
 *  run's transport rather than estimated per input: the inputs that drive
 *  cost (chains, the book, governance's adapter roster) are not this pass's
 *  to bound, and three review rounds found three of them. A run that
 *  reaches it stops before sending and says so; the loan is tried again on
 *  a later visit.
 *
 *  What it bounds is THIS pass's share. The invocation's 50 are shared by
 *  every pass due on the tick, and the other passes' requests are not
 *  counted here, so this cap cannot keep the invocation as a whole under
 *  the ceiling; the CPU bench shows several existing passes past it on
 *  their own. One budget per invocation, shared by every due pass, is
 *  #2490. */
export const SUBREQUEST_BUDGET = 40;

/** The pass's cadence, in ms — the rotation moves one batch per run.
 *  Mirrors `cadenceMinutes` in passSchedule.ts. */
const ROTATION_STEP_MS = 5 * 60_000;

/** LibVaipakam.AssetType.ERC20. */
const ASSET_TYPE_ERC20 = 0;

export async function runGraceDefault(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'graceDefault', 'GRACE_DEFAULT_ENABLED')) return;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  if (chains.length === 0) return;

  // The rotation reads the tick's SCHEDULED time, not the clock: a late
  // delivery must not land on the previous run's index and repeat its work
  // (or skip some). Only an invocation that is not a cron tick reads the
  // clock.
  const run = Math.floor((tick.scheduledTimeMs ?? Date.now()) / ROTATION_STEP_MS);

  // ONE chain per run, and a bounded window of its active list: the
  // subrequest allowance is the invocation's — shared by every chain and
  // every pass the tick launches — so neither the number of chains nor the
  // size of a book may grow what one run costs. Chains take turns; on its
  // turn a chain's next window is scanned; within a window, successive
  // visits take successive candidates. Stateless: everything is derived
  // from the run index, so nothing persists between isolates.
  const chain = chains[run % chains.length];
  const visit = Math.floor(run / chains.length);
  try {
    await processChain(env, chain, visit, tick.deadlineMs);
  } catch (err) {
    // Described, never stringified: a viem transport error carries the
    // request URL, and this Worker's RPC URLs carry API keys.
    console.error(`[keeper] graceDefault chain=${chain.id} failed: ${describeFailure(err)}`);
  }
}

async function processChain(env: Env, chain: ChainConfig, visit: number, deadlineMs: number): Promise<void> {
  // Every request below goes through this one budget — reads, quotes and
  // the wallet's send alike.
  const budget = createSubrequestBudget(SUBREQUEST_BUDGET);
  const client = createPublicClient({
    transport: http(chain.rpc, { fetchFn: budget.fetch }),
  }) as PublicClient;
  const ctx = buildKeeperContext(env, chain, client, { notAfterMs: deadlineMs, fetchFn: budget.fetch });
  if (!ctx) return;
  const keeper = ctx.wallet.account?.address;
  if (!keeper) return;
  const spent = () => `requests=${budget.spent()}/${budget.limit}`;
  // Each read stage stops early enough to leave the stages after it their
  // time (runWindow.ts, rule 3): the attempt's reads by the read cutoff,
  // which reserves the send's time; the eligibility reads a stage reserve
  // before that; the active-list window a stage reserve before those.
  const readCutoff = readCutoffMs(ctx.notAfterMs);
  const cutoffs = scanCutoffs(readCutoff);

  let scan: Awaited<ReturnType<typeof findDefaultable>>;
  try {
    scan = await findDefaultable(client, ctx.diamond, chain.id, visit, cutoffs);
  } catch (err) {
    if (err instanceof PastRunDeadline) {
      console.log(`[keeper] graceDefault chain=${chain.id} scan stopped: the active-loan window was not read by its stage cutoff ${spent()}`);
      return;
    }
    if (!budget.exhausted()) throw err;
    console.log(`[keeper] graceDefault chain=${chain.id} scan stopped: ${BUDGET_SPENT} ${spent()}`);
    return;
  }
  const { defaultable: candidates, unread, window } = scan;
  const where = `chain=${chain.id} window=${window.index + 1}/${window.count} active=${window.total}`;
  if (unread.length > 0) {
    // Unread is not "not defaultable": name them, so a loan missing from the
    // attempts below is not mistaken for one the chain ruled out.
    console.log(`[keeper] graceDefault ${where} eligibility-unread loans=${unread.join(',')}`);
  }
  if (candidates.length === 0) {
    console.log(`[keeper] graceDefault ${where} defaultable=0`);
    return;
  }

  const deps: GraceDefaultDeps = {
    client,
    wallet: ctx.wallet,
    diamond: ctx.diamond,
    chainId: chain.id,
    notAfterMs: ctx.notAfterMs,
    readCutoff,
    // The route's reads and quotes are the attempt's: none starts past its cutoff.
    buildRoute: (loan, sellAmount, cutoff) =>
      orchestrateServerQuotes(env, readPhaseClient(client, cutoff), {
        chainId: chain.id,
        diamond: ctx.diamond,
        sellToken: loan.collateralAsset,
        buyToken: loan.principalAsset,
        sellAmount,
        txOrigin: keeper,
        fetchFn: deadlineFetch(budget.fetch, cutoff),
      }),
  };

  // This window's visit count, so each visit to it takes the next batch.
  const { picked, deferred } = pickBatch(candidates, window.round, MAX_ATTEMPTS_PER_RUN);
  if (deferred.length > 0) {
    // Named, not just counted: an operator asking why one loan is still
    // Active must be able to tell "waiting its turn" from "never seen".
    console.log(`[keeper] graceDefault ${where} deferred-by-cap loans=${deferred.join(',')}`);
  }
  // Counted per attempt made, not per loan picked (#2572 r7): a run the
  // deadline stops before a picked loan made no attempt on it.
  let attempted = 0;
  let submitted = 0;
  let unconfirmed = 0;
  for (const loanId of picked) {
    // #2572 — past the read cutoff an attempt can read nothing, so it is not
    // started; the remaining loans keep their place for the next run.
    if (Date.now() >= readCutoff) {
      console.log(`[keeper] graceDefault ${where} read cutoff reached; left for the next run loans=${picked.slice(picked.indexOf(loanId)).join(',')}`);
      break;
    }
    let outcome: GraceDefaultOutcome;
    attempted += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await attemptGraceDefault(deps, loanId);
    } catch (err) {
      outcome = { kind: 'skipped', reason: attemptErrorReason(err) };
    }
    // Whatever step the cap interrupted — a read that threw, or a route
    // build that swallowed its failures and came back empty — the attempt
    // was cut short, and that is what the log says. Nothing was sent: the
    // send would have needed a request the budget refused.
    if (budget.exhausted() && outcome.kind === 'skipped') {
      outcome = { kind: 'skipped', reason: BUDGET_SPENT };
    }
    if (outcome.kind === 'submitted') {
      submitted += 1;
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} submitted tx=${outcome.tx} preview=${outcome.preview} calls=${outcome.calls} sell=${outcome.sellAmount}`,
      );
    } else if (outcome.kind === 'unconfirmed') {
      unconfirmed += 1;
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} send-unconfirmed tx=${outcome.tx} preview=${outcome.preview} calls=${outcome.calls} sell=${outcome.sellAmount}: ${outcome.reason} — may or may not have been broadcast; later runs hold while it is pending`,
      );
    } else {
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} skipped: ${outcome.reason}`,
      );
    }
  }
  console.log(
    `[keeper] graceDefault ${where} defaultable=${candidates.length} picked=${picked.length} attempted=${attempted} submitted=${submitted} unconfirmed=${unconfirmed} ${spent()}`,
  );
}

/** The skip reason for a run the subrequest cap cut short. */
export const BUDGET_SPENT = `subrequest-budget-spent (cap ${SUBREQUEST_BUDGET}; tried again on a later visit)`;

/** Active loans past grace within one SCAN_WINDOW of the active list,
 *  everything read at one pinned block. `visit` picks the window, so
 *  successive visits walk the list and wrap. The window is read by
 *  `cutoffs.window` or not at all (`PastRunDeadline`); the eligibility reads
 *  stop at `cutoffs.reads`, keeping the chunks they finished, and a loan
 *  whose chunk was not read is reported unread. */
export async function findDefaultable(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  visit: number,
  cutoffs: ScanCutoffs,
): Promise<{ defaultable: bigint[]; unread: bigint[]; window: ScanWindow }> {
  const { ids, blockNumber, window } = await readActiveWindow(client, diamond, visit, cutoffs.window);
  // No serial retry: it would cost one subrequest per id, up to SCAN_WINDOW
  // of them, and break the scan's bound. A chunk not read is reported as
  // eligibility-unread and is read again on a later visit, which starts at a
  // different chunk (the window's own visit count).
  const results = await settledChunkedRead(
    client,
    ids,
    READ_CHUNK,
    (id) => ({ address: diamond, abi: DEFAULTED_ABI, functionName: 'isLoanDefaultable', args: [id] }),
    `graceDefault chain=${chainId} isLoanDefaultable`,
    cutoffs.reads,
    window.round,
    blockNumber,
  );
  const defaultable: bigint[] = [];
  const unread: bigint[] = [];
  for (const id of ids) {
    const r = results.get(id);
    if (r?.status !== 'success') unread.push(id);
    else if (r.result === true) defaultable.push(id);
  }
  return { defaultable, unread, window };
}

/** The candidates starting at `step mod length` — the keeper's shared rule (`rotate.ts`). */
export { rotate } from './rotate';

/** This run's batch (the keeper's shared rule, `rotate.ts`). */
export { pickBatch } from './rotate';
