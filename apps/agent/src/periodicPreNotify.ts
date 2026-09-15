/**
 * T-034 PR2 — Periodic Interest Payment pre-notify cron lane.
 *
 * Walks the indexed `loans` table for active loans with non-None
 * cadence whose next checkpoint is within `preNotifyDays` of now AND
 * has not been pre-notified for this period yet. For each match,
 * sends push (and optional Telegram) to BOTH borrower (priority — they
 * need to act) and lender (courtesy). De-dups via the
 * `period_pre_notified_at` column on the loans table — set to the
 * checkpoint timestamp we last pushed for, so a cron over-fire doesn't
 * re-push.
 *
 * Decoupled from the HF watcher pass — they share the cron tick but
 * not the per-user iteration shape. HF watcher walks subscribers (a
 * subscriber may have N active loans); this lane walks loans (a loan
 * has exactly two human counterparties).
 *
 * `preNotifyDays` is read from chain via
 * `ConfigFacet.getPreNotifyDays()` once per tick per chain; the value
 * is governance-tunable in [1, 14] days. Failure to read the config
 * (older deploy without the surface, RPC blip) defaults to the
 * library default of 3 days — mirrors the on-chain
 * `PERIODIC_PRE_NOTIFY_DAYS_DEFAULT` constant.
 */

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import { LoanFacetABI, NumeraireConfigFacetABI } from '@vaipakam/contracts/abis';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { sendPush } from './push';
import { sendMessage } from './telegram';
import { isPeriodicInterestEligible } from '@vaipakam/lib/reminderEligibility';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';

const DEFAULT_PRE_NOTIFY_DAYS = 3;
const SECONDS_PER_DAY = 86_400;

/**
 * The allowance, counted in OUTBOUND SENDS — not in loans (#2213 r7
 * `4012662252`).
 *
 * A Worker invocation gets a documented 50 outbound subrequests, shared with
 * every other lane on the same tick. This lane spends them on pushes and
 * Telegram messages; 32 leaves comfortable headroom for its own batched chain
 * reads and for whatever else the tick is doing.
 *
 * **The unit is the point, and two review rounds went into learning that.**
 * Rounds 5 and 6 counted LOANS, which meant anything that consumed a loan slot
 * without sending anything could hold the allowance forever: first candidates
 * the chain rejected (r6), then candidates whose counterparties had opted out
 * or had no subscription at all (r7). Both were charged, neither was stamped,
 * so the same handful sat at the front of the deadline order on every tick and
 * the subscribed borrowers behind them were never reached. Patching each case
 * as it was found would have left the next one waiting; counting the thing the
 * budget actually protects makes the whole class impossible, because a
 * candidate that sends nothing cannot decrement a counter that only sending
 * decrements.
 *
 * THIS IS A CAP ON A TICK, NOT ON A LOAN. The window is `preNotifyDays` wide
 * (three days by default) and ticks are minutes apart, so a deferred loan has
 * thousands of later chances. Two things make that true rather than hopeful:
 * the ORDER (`candidatesInWindow`) and the unit above.
 */
const MAX_OUTBOUND_SENDS_PER_INVOCATION = 32;

/**
 * The most sends ONE loan can need: two counterparties × two rails.
 *
 * Reserved in full before a loan is STARTED, which is what keeps the ceiling a
 * ceiling. Nothing inside a loan re-checks the allowance — deliberately, since
 * stopping between the borrower's message and the lender's would stamp the
 * checkpoint with one side never told, and the stamp is per-loan so that side's
 * reminder is lost rather than deferred. A loan therefore always finishes, and
 * the only way to keep the total inside the cap is to refuse to begin one that
 * might not fit.
 *
 * The cost is up to three sends unused at the end of a tick. The alternative
 * is overshooting the invocation's subrequest budget by up to three, which is
 * how a lane starts failing mid-loop and taking later chains down with it.
 */
const MAX_SENDS_PER_LOAN = 4;

/**
 * How many candidates one batched chain read covers, and how many such reads
 * one chain gets per tick (#2213 r6 `4012464544`).
 *
 * These bound the SCAN, and they are deliberately far larger than the message
 * allowance, because they are a different cost: one `aggregate3` covers a
 * hundred loans for a single outbound request, where a hundred reminders would
 * be four hundred. Three batches is three requests and three hundred
 * candidates — thirty-seven times the message allowance — so the scan can walk
 * past a long run of rows the chain rejects and still reach the eligible ones
 * behind them on the SAME tick.
 *
 * NOT UNBOUNDED, and the residue is stated rather than implied: a chain whose
 * window holds more than three hundred candidates the chain rejects, all ahead
 * of an eligible one in deadline order, still defers that one. That is a
 * chain with three hundred orphaned rows, which is an operator problem the
 * scan reports rather than a load problem it absorbs — see the warning at the
 * end of the scan loop.
 */
const EXAMINE_BATCH = 100;
const MAX_EXAMINE_BATCHES = 3;

/**
 * How much of the window one tick can examine, and therefore the step the scan
 * start rotates by when the window is wider than that (#2213 r8 `4012811563`).
 */
const SCAN_SPAN = EXAMINE_BATCH * MAX_EXAMINE_BATCHES;

/** Cadence enum value → interval in days. Mirrors
 *  `LibVaipakam.intervalDays`. */
function intervalDays(cadence: number): number {
  switch (cadence) {
    case 1:
      return 30;
    case 2:
      return 90;
    case 3:
      return 180;
    case 4:
      return 365;
    default:
      return 0;
  }
}

// `getPreNotifyDays` moved to NumeraireConfigFacet in the #394 ConfigFacet
// split (Codex #647 round-3) — it's no longer in ConfigFacet's ABI, so
// encoding it from ConfigFacetABI would make viem throw before the RPC call
// and the catch silently fall back to the default. Source it from the facet
// that actually implements it so a future rename lands as a TypeScript error
// here instead of a silent runtime FunctionDoesNotExist. (The selector still
// routes through the Diamond at runtime — same address, just a different ABI.)
const PRE_NOTIFY_DAYS_ABI = NumeraireConfigFacetABI;

interface LoanRow {
  loan_id: number;
  chain_id: number;
  lender: string;
  borrower: string;
  periodic_interest_cadence: number;
  last_period_settled_at: number;
  period_pre_notified_at: number;
}

interface UserPushRow {
  wallet: string;
  push_channel: string | null;
  tg_chat_id: string | null;
  locale: string;
  /** #1033 — 0 = the user opted out of due-date pre-notifies. */
  notify_maturity_approaching: number;
}

/** What is left of this invocation's message allowance. Mutated as it spends. */
interface TickBudget {
  remaining: number;
}

export async function runPeriodicPreNotify(env: Env): Promise<void> {
  const chains = getChainConfigs(env).filter(
    (c) => c.diamond && c.diamond !== '0x0000000000000000000000000000000000000000',
  );
  if (chains.length === 0) return;

  const budget: TickBudget = { remaining: MAX_OUTBOUND_SENDS_PER_INVOCATION };

  // START AT A DIFFERENT CHAIN EACH TICK (#2213 r5 `4012300071`). A budget
  // spent in list order is a budget the first chain spends first, so a busy
  // chain at the head of the list could hold the allowance every tick and the
  // chains behind it would never be reached at all. Rotating by the minute
  // makes the starting point move on its own, with nothing to persist.
  const offset = chains.length > 1 ? Math.floor(Date.now() / 60_000) % chains.length : 0;

  for (let i = 0; i < chains.length; i++) {
    const chain = chains[(i + offset) % chains.length]!;
    if (budget.remaining < MAX_SENDS_PER_LOAN) {
      // SAID, not silently dropped. A chain skipped for want of allowance is
      // a chain whose borrowers got no reminder this tick, and an operator
      // seeing this every tick is being told the cap is too low for the load.
      console.warn(
        `[periodicPreNotify] chain=${chain.name} skipped: this invocation's ` +
          `allowance of ${MAX_OUTBOUND_SENDS_PER_INVOCATION} outbound send(s) ` +
          `is down to ${budget.remaining}, below the ${MAX_SENDS_PER_LOAN} one ` +
          `loan can need. Its turn comes first on a later tick (the start ` +
          `rotates), and the notification window is days wide.`,
      );
      continue;
    }
    try {
      await preNotifyChain(env, chain, budget);
    } catch (err) {
      // BOUNDED, never `String(err)` — this catch is downstream of viem reads
      // whose messages carry the RPC URL, API key and all (#2213 r5
      // `4012300079`).
      console.error(
        `[periodicPreNotify] chain=${chain.name} err=${describeFailure(err)}`,
      );
    }
  }
}

async function preNotifyChain(
  env: Env,
  chain: { id: number; name: string; rpc: string; diamond: string },
  budget: TickBudget,
): Promise<void> {
  // Pull the configured pre-notify lead time. Fall through to the
  // library default on any read failure so a transient hiccup
  // doesn't turn the lane silent for the entire tick.
  //
  // ONE CLIENT for the whole chain pass: the lead-time read below and the
  // batched status read further down both use it (#2213 r3).
  //
  // NON-RETRYING, SHORT TIMEOUT (#2213 r4 `4012114109`). viem's defaults are
  // three retries and a ten-second timeout, and this runs inside a sequential
  // loop over chains — so one unreachable RPC early in the list could spend
  // the whole scheduled invocation and cost later, HEALTHY chains their
  // reminders entirely. That is a bigger outage than the one the check
  // prevents.
  //
  // Retrying buys nothing here anyway: a failed read skips this chain for this
  // tick and the next tick asks again, with days of window left. The same
  // argument the reconciliation pass makes for its own non-retrying client.
  const client = createPublicClient({
    transport: http(chain.rpc, { retryCount: 0, timeout: 5_000 }),
  });
  let preNotifyDays = DEFAULT_PRE_NOTIFY_DAYS;
  try {
    const v = (await client.readContract({
      address: chain.diamond as Address,
      abi: PRE_NOTIFY_DAYS_ABI,
      functionName: 'getPreNotifyDays',
    })) as number;
    if (v && v > 0) preNotifyDays = Number(v);
  } catch {
    // Older deploy without the getter, or RPC failure — fall through
    // to the default. Logged at debug level only since this is an
    // expected condition during the rollout window.
  }

  const now = Math.floor(Date.now() / 1000);
  const windowSec = preNotifyDays * SECONDS_PER_DAY;

  // Pull active periodic loans on this chain. We over-fetch slightly
  // (any periodic-cadence active loan with a known last-settle stamp)
  // and filter the cron-window check in TS — keeps the SQL simple
  // while the cadence-specific interval math stays out of D1.
  //
  // DELIBERATELY UNBOUNDED, and the bound is applied a few lines below
  // instead. A `LIMIT` here would cap the wrong thing: rows, before the
  // window filter and before the deadline ordering, so the cap would fall on
  // whatever the database returned first rather than on what this tick can
  // afford to send. D1 reads are not outbound subrequests — the allowance
  // this lane has to respect is spent on chain reads and pushes, and both are
  // bounded explicitly.
  const rows = await env.DB.prepare(
    `SELECT loan_id, chain_id, lender, borrower,
            periodic_interest_cadence, last_period_settled_at,
            period_pre_notified_at
     FROM loans
     WHERE chain_id = ?
       AND status = 'active'
       AND periodic_interest_cadence > 0
       AND last_period_settled_at > 0`,
  )
    .bind(chain.id)
    .all<LoanRow>();

  const due = candidatesInWindow(rows.results ?? [], now, windowSec);
  if (due.length === 0) return;

  // TWO LIMITS, NOT ONE (#2213 r6 `4012464544`). Round 5 took a single slice
  // of `budget.remaining` candidates and both read and messaged within it,
  // which quietly made the MESSAGE budget govern the READ pass as well. Those
  // have opposite cost shapes: a message is up to four outbound requests, a
  // read is one per HUNDRED loans. Worse, a candidate the chain rejects
  // consumes a read slot and no message slot — so eight persistent orphans at
  // the head of the deadline order occupied the whole slice on every tick
  // while spending nothing, and eligible loans behind them were never looked
  // at. The cap was supposed to defer a loan by a tick; for those it deferred
  // it indefinitely, which is the opposite of what this file claims.
  //
  // So the read pass now SCANS PAST rejected candidates, in batches, and only
  // the sends draw on the allowance.
  // AND THE SCAN DOES NOT ALWAYS START AT THE HEAD (#2213 r8 `4012811563`).
  // Counting the allowance in sends stopped a non-sending candidate from
  // spending it; it did not stop one from being examined again on every tick.
  // A candidate that is deliberately never stamped — an opted-out pair, a row
  // the chain rejects — stays exactly where it was in the deadline order, so a
  // window whose first three hundred are all of that kind hides candidate 301
  // for good. Round 6 wrote that residue down and called it an operator
  // problem; opted-out counterparties made it an ordinary one, and the spec
  // now promises it cannot happen.
  //
  // The fix is stateless on purpose. A persisted cursor would need a table,
  // and therefore a migration, and therefore the deploy window #2214 is about
  // — real cost for a case that a rotation answers exactly: when the window is
  // wider than one tick can scan, successive ticks start at successive spans,
  // so every candidate is examined within `spans` ticks. Minutes apart, in a
  // window days wide.
  //
  // It engages ONLY when it has to. With 300 or fewer candidates there is one
  // span, the offset is zero, and the nearest deadline is examined first on
  // every tick exactly as before — so the common case keeps the ordering that
  // makes the send cap fair, and only the overloaded case trades a tick of
  // latency for not starving anyone.
  //
  // THE DRIVER'S STEP MUST BE COPRIME WITH `spans`, and it is because this
  // Worker's cron fires every minute — a step of 1, coprime with everything.
  // At a five-minute schedule the minute is always a multiple of five, so a
  // window of 1,201–1,500 candidates (`spans` = 5) would scan span 0 forever
  // and starve the rest: this fix, undone by an edit to a different file.
  // `apps/agent/test/cronPeriodPinsScanRotation.test.ts` asserts the schedule
  // rather than leaving that to this comment.
  const spans = Math.ceil(due.length / SCAN_SPAN);
  const start = spans > 1 ? (Math.floor(now / 60) % spans) * SCAN_SPAN : 0;

  let cursor = start;
  let reminded = 0;
  let rejected = 0;
  let unreadable = 0;
  let batches = 0;
  while (
    cursor < due.length &&
    budget.remaining >= MAX_SENDS_PER_LOAN &&
    batches < MAX_EXAMINE_BATCHES
  ) {
    const batch = due.slice(cursor, cursor + EXAMINE_BATCH);
    batches += 1;

    // ONE CHAIN READ FOR THE WHOLE BATCH (#2213 r5 `4012300071`). An earlier
    // revision asked per loan, which spends one of the invocation's ~50
    // outbound subrequests per candidate — so a chain with more due loans than
    // that exhausted the allowance mid-loop and took every REMAINING chain
    // down with it, on every tick, forever. Multicall3 turns the batch into a
    // single call whose per-sub-call failures are reported individually rather
    // than poisoning the whole of it.
    const states = await readLoanStates(client, chain, batch.map((c) => c.row.loan_id));
    if (states === null) return; // the batch itself failed; said so, nothing stamped

    const outcome = await messageBatch(env, chain, batch, states, budget, now);
    reminded += outcome.reminded;
    rejected += outcome.rejected;
    unreadable += outcome.unreadable;
    cursor += outcome.consumed;
  }

  // WHAT THIS TICK LEFT UNDONE, and which of the two limits left it.
  const examined = cursor - start;
  if (examined < due.length) {
    const capped =
      budget.remaining < MAX_SENDS_PER_LOAN
        ? `the invocation's send allowance is down to ${budget.remaining}`
        : null;
    const scanned = batches >= MAX_EXAMINE_BATCHES ? 'the scan reached its read cap' : null;
    const span =
      spans > 1 ? ` (scanning span ${start / SCAN_SPAN + 1} of ${spans}, from ${start})` : '';
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: ${due.length} loan(s) in the ` +
        `notification window${span}, ${examined} examined, ${reminded} reminded, ` +
        `${rejected} rejected by the chain, ${unreadable} unreadable — ` +
        `${capped ?? scanned ?? 'stopping'}. ` +
        `The remainder is not dropped: nothing is stamped for it, and a later ` +
        `tick reaches it — the next spans in turn when there is more than one. ` +
        `A tick that reports the read cap with hundreds rejected is reporting ` +
        `orphaned rows, not load.`,
    );
  }
}

/**
 * Message the eligible loans in one examined batch, and report what happened.
 *
 * Split out of the scan loop because the two answer different questions: the
 * loop asks "have we looked far enough", this asks "who may be told". Keeping
 * them in one function is what let the message budget silently govern the
 * scan.
 *
 * `consumed` is how far the scan may advance — every row LOOKED AT, including
 * the rejected ones, and NOT the rows left unexamined when the allowance ran
 * out mid-batch. Those stay for the next tick; they are eligible, so they will
 * be at the front of it.
 */
async function messageBatch(
  env: Env,
  chain: { id: number; name: string; rpc: string; diamond: string },
  batch: DueLoan[],
  states: (LoanState | null)[],
  budget: TickBudget,
  now: number,
): Promise<{ consumed: number; reminded: number; rejected: number; unreadable: number }> {
  let reminded = 0;
  let rejected = 0;
  let unreadable = 0;
  for (let i = 0; i < batch.length; i++) {
    // RESERVED, not spent. A loan may need up to four sends and must not be
    // started unless all four are available — see `MAX_SENDS_PER_LOAN`.
    if (budget.remaining < MAX_SENDS_PER_LOAN) {
      return { consumed: i, reminded, rejected, unreadable };
    }
    const { row, nextCheckpoint, secsUntil } = batch[i]!;

    // ASK THE CHAIN BEFORE SAYING SOMETHING THAT CANNOT BE TAKEN BACK
    // (#2213 r3 `4011960593`). `status = 'active'` above is STORED state, and
    // a loan whose terminal event this platform missed for good sits at
    // exactly that — so without this the holder of an ended loan is told a
    // payment is due, and the checkpoint is stamped so it is never revisited.
    //
    // Asked AFTER every cheap filter, because by this point the candidates
    // are the loans actually inside the notification window rather than the
    // whole active set.
    //
    // This is the keeper's pattern rather than the indexer's: a lane that can
    // ask the chain needs no cross-Worker suppression list, and does not
    // inherit that list's races, deploy-window coupling, or "could not ask"
    // ambiguity. An earlier revision of this PR did import the list; three
    // findings followed, all from the coordination rather than the rule.
    //
    // A FAILED READ SKIPS, and skipping is safe: nothing is stamped, so the
    // next tick asks again while the window is still open. Sending on a
    // failed read would be choosing the unretractable outcome on no evidence.
    //
    // WHAT THIS CHECK DOES NOT DO, stated because it reads as if it does
    // (#2213 r5 `4012300082`): it is a POINT-IN-TIME answer. A loan that is
    // repaid, defaulted or otherwise leaves `Active` between this read and
    // the sends below is still messaged, and the checkpoint still stamped.
    // Nothing here serialises against the chain, and nothing could — the
    // window between a read and a push is not closable from off-chain. What
    // the check removes is the LARGE case, a row that has been wrong in D1
    // for hours or days; what remains is a few seconds. Closing that would
    // take a settlement-aware send, which is a different design.
    const detail = states[i];
    if (!detail) {
      // The batch returned, this slot did not: the sub-call reverted, or its
      // return data did not decode. Same rule as a failed batch — no evidence,
      // no message, nothing stamped.
      console.warn(
        `[periodicPreNotify] chain=${chain.name} loan=${row.loan_id} status read ` +
          `returned nothing (the batched call failed for this loan); not ` +
          `pre-notifying this tick.`,
      );
      // NOT counted as rejected — the chain did not reject it, it did not
      // answer. Counted separately and reported separately, because the two
      // send an operator to different places: a rejection is a row the indexer
      // has wrong, an unreadable slot is an RPC that could not answer. Both
      // count as EXAMINED, so the scan moves past them rather than re-reading
      // the same rows every tick.
      unreadable += 1;
      continue;
    }
    if (!isPeriodicInterestEligible(detail)) {
      // WHAT THE CHAIN SAID, AND NOTHING ABOUT WHAT HAPPENS NEXT (#2213 r4
      // `4012114114`). An earlier version promised the reconciliation pass
      // would correct the stored row. For a terminal status it will; for a
      // status this build does not recognise it deliberately will NOT — it
      // refuses to project an unknown member and only reports it. Promising a
      // correction that cannot happen sends an operator away from a row that
      // needs them.
      const zeroStruct = Number(detail.id) === 0;
      console.warn(
        `[periodicPreNotify] chain=${chain.name} loan=${row.loan_id} is stored as ` +
          `active but the chain ${
            zeroStruct
              ? 'has no such loan (zero struct)'
              : `reports status ${Number(detail.status)}`
          } — no reminder sent. The stored row disagrees with the chain; ` +
          `whether anything corrects it depends on which case this is.`,
      );
      rejected += 1;
      continue;
    }

    const daysUntil = Math.max(1, Math.ceil(secsUntil / SECONDS_PER_DAY));

    // Push to BOTH counterparties — borrower first (they need to
    // act), then lender (courtesy). Each lookup is a single D1
    // query; subscribers usually overlap with HF-watcher rows so
    // the table is hot in cache.
    const borrowerOutcome = await pushIfSubscribed(
      env, chain, row, row.borrower, daysUntil, 'borrower', budget,
    );
    const lenderOutcome = await pushIfSubscribed(
      env, chain, row, row.lender, daysUntil, 'lender', budget,
    );
    if (borrowerOutcome === 'sent' || lenderOutcome === 'sent') reminded += 1;

    // Stamp the de-dup column when a delivery went out, or when
    // there's genuinely no one to notify (re-querying every tick is
    // wasteful). Do NOT stamp when the ONLY reason nothing went out
    // is an opt-out: the user may re-enable the reminder before the
    // deadline, and the next tick should then deliver it (#1056
    // round 9). Granularity note: the stamp is per-loan, so when one
    // side WAS notified, an opted-out counterparty re-enabling
    // mid-window misses this checkpoint — per-user dedupe would need
    // a schema change, out of proportion for a courtesy reminder.
    //
    // STAMPING KEYS ON "HANDLED", NOT ON "SENT" (#2213 r8 `4012811575`). Those
    // were one word until this round, which is why splitting `no-route` out of
    // `sent` would otherwise have changed behaviour nobody asked to change: a
    // counterparty with no usable rail has nothing to retry, so it stamps
    // exactly as it did before. Only the operator COUNT distinguishes them.
    const handled = (o: PreNotifyOutcome) => o === 'sent' || o === 'no-route';
    const anyHandled = handled(borrowerOutcome) || handled(lenderOutcome);
    const onlyBlockedByOptOut =
      !anyHandled &&
      (borrowerOutcome === 'opted-out' || lenderOutcome === 'opted-out');
    if (onlyBlockedByOptOut) continue;
    await env.DB.prepare(
      `UPDATE loans SET period_pre_notified_at = ?, updated_at = ?
       WHERE chain_id = ? AND loan_id = ?`,
    )
      .bind(nextCheckpoint, now, chain.id, row.loan_id)
      .run();
  }
  return { consumed: batch.length, reminded, rejected, unreadable };
}

/** A loan inside the notification window, with the arithmetic already done. */
interface DueLoan {
  row: LoanRow;
  nextCheckpoint: number;
  secsUntil: number;
}

/**
 * The loans this tick could remind about, NEAREST DEADLINE FIRST.
 *
 * The order is what makes the invocation cap fair rather than arbitrary
 * (#2213 r5 `4012300071`). Unordered, a capped pass returns whatever the
 * database happened to hand back — in practice the same early rows every
 * tick — so a borrower behind them could be starved of the reminder for the
 * whole window and then miss the deadline it was for. Ordered by deadline,
 * the queue drains in the order the deadlines arrive, and a loan deferred
 * today is nearer the front tomorrow. Ties break on loan id so the order is
 * total, not merely mostly-determined.
 *
 * The cadence arithmetic stays HERE rather than becoming an `ORDER BY` in
 * SQL, which would be the obvious way to get the same order. `intervalDays`
 * mirrors `LibVaipakam.intervalDays`, and a second copy of it written as a
 * SQL `CASE` is a copy that drifts the first time the enum grows a member —
 * silently, because a mis-ordered query still returns rows.
 */
function candidatesInWindow(rows: LoanRow[], now: number, windowSec: number): DueLoan[] {
  const due: DueLoan[] = [];
  for (const row of rows) {
    const ivlDays = intervalDays(row.periodic_interest_cadence);
    if (ivlDays === 0) continue;
    const nextCheckpoint = row.last_period_settled_at + ivlDays * SECONDS_PER_DAY;
    const secsUntil = nextCheckpoint - now;
    // Window: 0 < secsUntil <= preNotifyDays. We DON'T pre-notify after the
    // boundary has already passed (a settler can fire any moment) — that's
    // the SETTLEMENT lane's territory, separate from this PRE-notify lane.
    if (secsUntil <= 0 || secsUntil > windowSec) continue;
    // De-dup: we've already pushed for this exact checkpoint.
    if (row.period_pre_notified_at === nextCheckpoint) continue;
    due.push({ row, nextCheckpoint, secsUntil });
  }
  due.sort((a, b) => a.nextCheckpoint - b.nextCheckpoint || a.row.loan_id - b.row.loan_id);
  return due;
}

/** What the chain says about each loan, positionally. `null` where it did not say. */
type LoanState = { id: bigint | number; status: number };

/**
 * Read every candidate's state in ONE call.
 *
 * `null` (the whole return, not a slot) means the batch itself failed and
 * this chain says nothing this tick. A `null` SLOT means that one sub-call
 * failed — `aggregate3` reports per-call success, so one unreadable loan does
 * not cost the rest of the slice its reminders.
 *
 * Multicall3 sits at the same address on every chain in scope. If it is
 * absent the call reverts, which lands in the batch-failed branch: the lane
 * goes quiet on that chain and says why every tick, rather than sending on
 * an answer it does not have.
 */
async function readLoanStates(
  client: PublicClient,
  chain: { name: string; diamond: string },
  loanIds: number[],
): Promise<(LoanState | null)[] | null> {
  if (loanIds.length === 0) return [];
  try {
    return await batchCalls<LoanState>(
      client,
      LoanFacetABI as Abi,
      'getLoanDetails',
      encodeBatchCalls(
        chain.diamond as Address,
        LoanFacetABI as Abi,
        'getLoanDetails',
        loanIds.map((id) => [BigInt(id)]),
      ),
      // CHUNK SIZE PASSED EXPLICITLY, not left to the library's default. The
      // scan's whole cost model is "one outbound request per batch", and that
      // is only true while the chunk size is at least the batch size — today
      // both happen to be 100, which is a coincidence a reader would have to
      // check in another package to notice. Passing it makes the claim
      // structural: whatever `EXAMINE_BATCH` becomes, a batch is one request.
      EXAMINE_BATCH,
    );
  } catch (err) {
    // BOUNDED DESCRIPTION, never the message: viem puts the full request URL
    // — API key included — in `HttpRequestError.message` (#2213 r5
    // `4012300079`).
    console.warn(
      `[periodicPreNotify] chain=${chain.name} status read failed for ` +
        `${loanIds.length} loan(s); not pre-notifying this tick: ${describeFailure(err)}`,
    );
    return null;
  }
}

/**
 * Why nothing (or something) went out for one counterparty.
 *
 * - `sent` — at least one rail was issued.
 * - `no-route` — subscribed, opted in, and no usable rail (no channel, or the
 *   deployment has no signer/token for the one they have). Stamped like a
 *   delivery, counted like none.
 * - `opted-out` — they switched these reminders off. NOT stamped: they may
 *   switch them back on before the deadline.
 * - `none` — no subscription row at all. Stamped; nobody to tell.
 */
type PreNotifyOutcome = 'sent' | 'no-route' | 'opted-out' | 'none';

async function pushIfSubscribed(
  env: Env,
  chain: { id: number; name: string },
  loan: LoanRow,
  wallet: string,
  daysUntil: number,
  role: 'borrower' | 'lender',
  budget: TickBudget,
): Promise<PreNotifyOutcome> {
  let sub: UserPushRow | null;
  try {
    sub = await env.DB.prepare(
      `SELECT wallet, push_channel, tg_chat_id, locale, notify_maturity_approaching
       FROM user_thresholds
       WHERE chain_id = ? AND wallet = ?`,
    )
      .bind(chain.id, wallet.toLowerCase())
      .first<UserPushRow>();
  } catch {
    // Rollout window — migration 0027 not applied yet. Legacy column
    // set with the opt-out defaulted to OPTED IN so reminders keep
    // flowing (the safe direction); same fallback the keeper's
    // listThresholdsForChain carries.
    const legacy = await env.DB.prepare(
      `SELECT wallet, push_channel, tg_chat_id, locale
       FROM user_thresholds
       WHERE chain_id = ? AND wallet = ?`,
    )
      .bind(chain.id, wallet.toLowerCase())
      .first<Omit<UserPushRow, 'notify_maturity_approaching'>>();
    sub = legacy ? { ...legacy, notify_maturity_approaching: 1 } : null;
  }
  if (!sub) return 'none';
  // #1033 — the connected app Alerts card exposes this as a real opt-out;
  // honor it before any rail fires. Reported distinctly so the
  // caller can leave the checkpoint unstamped (a re-enable before
  // the deadline must still get its reminder).
  if (sub.notify_maturity_approaching === 0) return 'opted-out';

  const cadenceLabel = cadenceI18nLabel(loan.periodic_interest_cadence);
  // English-only copy for now — the watcher's existing translation
  // helpers (formatAlert / pushTitle) are HF-specific and don't yet
  // cover periodic-interest events. A follow-up i18n pass will add
  // localized strings; for the rollout window the message is plain
  // English in every locale, matching how the borrower-facing
  // acknowledgement copy in the AcceptOffer flow shipped.
  const title =
    role === 'borrower'
      ? `Loan #${loan.loan_id} — ${cadenceLabel} interest due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`
      : `Your borrower's interest payment due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
  const body =
    role === 'borrower'
      ? `Pay this period's accrued interest before the deadline to avoid an automatic collateral sale during the grace window.`
      : `Loan #${loan.loan_id}'s ${cadenceLabel.toLowerCase()} interest checkpoint is approaching. If the borrower misses the deadline, a permissionless settler can sell collateral to cover the shortfall.`;
  // FRONTEND_ORIGIN is a CSV allow-list — interpolating it whole
  // produced a malformed URL the moment it grew past one entry. Deep
  // links use the FIRST origin (the primary app by convention). Path
  // shape is /loans/:id — the pro app root-mounts loan details there
  // (the historical /app/loans/:id nesting was flattened away and no
  // current app serves it), and the retail app aliases /loans/:id to
  // its own positions route.
  const linkBase = env.FRONTEND_ORIGIN.split(',')[0]!.trim();
  const deepLink = `${linkBase}/loans/${loan.loan_id}`;

  // `env.PUSH_CHANNEL_PK` is in the condition, not only in `sendPush`, and
  // that is the r7 rule applied to itself (#2213 r8 `4012811567`): with the
  // signer unset, `sendPush` returns without issuing anything, so a charge here
  // would spend the allowance on a deployment that made no request — the same
  // "non-sending thing holds the budget" failure, one layer down. The condition
  // that decides whether a request happens has to BE the condition that
  // charges for it.
  const pushSigner = sub.push_channel ? env.PUSH_CHANNEL_PK : undefined;
  const tgRoute =
    sub.tg_chat_id && env.TG_BOT_TOKEN
      ? { chat: sub.tg_chat_id, token: env.TG_BOT_TOKEN }
      : null;
  if (pushSigner) {
    // CHARGED HERE, at the point an outbound request is actually made (#2213
    // r7 `4012662252`). Every earlier revision charged a loan slot further up
    // and was wrong in the same way each time: a candidate that sends nothing
    // held the allowance, was never stamped, and so held it again on the next
    // tick. Decrementing where the request is issued makes that impossible
    // rather than merely handled — there is no path to a send that skips this
    // line, and no path to this line that skips a send.
    budget.remaining -= 1;
    try {
      await sendPush(pushSigner, {
        subscriber: wallet,
        title,
        body,
        deepLinkUrl: deepLink,
      });
    } catch (err) {
      console.error(
        `[periodicPreNotify] push failed loan=${loan.loan_id} wallet=${wallet} ` +
          `err=${describeFailure(err)}`,
      );
    }
  }
  if (tgRoute) {
    budget.remaining -= 1;
    try {
      await sendMessage(tgRoute.token, tgRoute.chat, `${title}\n${body}\n${deepLink}`);
    } catch (err) {
      console.error(
        `[periodicPreNotify] tg failed loan=${loan.loan_id} wallet=${wallet} ` +
          `err=${describeFailure(err)}`,
      );
    }
  }
  // TWO DIFFERENT ANSWERS, because two different questions are asked of this
  // return value (#2213 r8 `4012811575`). A subscriber row whose rails are
  // both empty — a shape the settings upsert really produces — used to report
  // 'sent', which was right for STAMPING (there is nothing to retry for them,
  // so re-querying every tick is waste) and wrong for REPORTING (the operator
  // count then says hundreds were reminded on a tick that sent nothing).
  // 'no-route' keeps the stamp and leaves the count honest.
  return pushSigner || tgRoute ? 'sent' : 'no-route';
}

function cadenceI18nLabel(cadence: number): string {
  switch (cadence) {
    case 1:
      return 'Monthly';
    case 2:
      return 'Quarterly';
    case 3:
      return 'Semi-annual';
    case 4:
      return 'Annual';
    default:
      return '';
  }
}
