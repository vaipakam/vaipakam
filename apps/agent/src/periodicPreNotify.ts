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
 * `preNotifyDays` and the periodic-interest master switch are read together
 * from `NumeraireConfigFacet.getPeriodicInterestConfig()`, once per tick per
 * chain. The lead time is governance-tunable in [1, 14] days and arrives
 * already resolved against `PERIODIC_PRE_NOTIFY_DAYS_DEFAULT`.
 *
 * A chain that cannot answer that call, or answers with the switch OFF, is not
 * pre-notified at all (#2213 r18). With the switch off `settlePeriodicInterest`
 * reverts while existing loans keep the cadence they snapshotted at init, so
 * every reminder would be an instruction to make a payment the chain refuses.
 * "We could not ask" is treated the same as "off" for the same reason: the
 * lane may not send an unactionable financial warning on the strength of an
 * answer it never got.
 */

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import { LoanFacetABI, NumeraireConfigFacetABI } from '@vaipakam/contracts/abis';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { sendPush } from './push';
import { sendMessage } from './telegram';
import {
  periodicIntervalDays,
  periodicInterestEligibility,
  type PeriodicEligibility,
  type PeriodicLoanState,
} from '@vaipakam/lib/reminderEligibility';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { verifyRpcChainIdentity } from '@vaipakam/lib/rpcIdentity';

const DEFAULT_PRE_NOTIFY_DAYS = 3;
const SECONDS_PER_DAY = 86_400;

/**
 * The allowance, counted in OUTBOUND REQUESTS — every one of them, reads
 * included (#2213 r13 `4013571040`).
 *
 * A Worker invocation gets a documented 50 outbound subrequests, shared with
 * every other lane on the same tick — the same ceiling the indexer sizes its
 * own passes against (`apps/indexer/src/chainIndexer.ts`). D1 does not come
 * out of it: queries through the binding "are D1 rows, not subrequests, so
 * this costs nothing against the invocation budget"
 * (`apps/indexer/src/loanReconcile.ts`), which is why this lane's own
 * bookkeeping reads and per-loan stamps are uncounted here. Forty against
 * fifty is the headroom, and it is stated because the number invites tuning
 * and a reader cannot otherwise tell where the wall is.
 *
 * This lane spends the allowance on chain reads and
 * on pushes and Telegram messages, and until r13 it bounded only the second
 * kind: the read cap was per CHAIN while the send cap was per invocation, so
 * three quiet chains could spend fifteen reads between them and leave the
 * fourth to spend five more plus thirty-two sends — fifty-two, past the
 * ceiling, with the overshoot landing on deliveries that had already been
 * attempted and stamped. Three deployed chains is under it today and a fourth
 * is a configuration change away, which is not a margin worth relying on.
 *
 * So there is ONE counter and everything decrements it. That also removes the
 * arithmetic the old split needed — nobody has to work out whether the read
 * cap times the chain count still fits beside the send cap, because there is
 * no longer a second number to reconcile.
 *
 * **The unit is the point, and three review rounds went into learning it.**
 * Rounds 5 and 6 counted LOANS, which let anything that consumed a loan slot
 * without sending hold the allowance: candidates the chain rejected (r6), then
 * opted-out counterparties (r7). Counting the thing the budget actually
 * protects makes that whole class impossible.
 *
 * THIS IS A CAP ON A TICK, NOT ON A LOAN. The window is `preNotifyDays` wide
 * (three days by default) and ticks are minutes apart, so a deferred loan has
 * thousands of later chances. Two things make that true rather than hopeful:
 * the ORDER (`candidatesInWindow`) and the stored scan position.
 */
const MAX_OUTBOUND_REQUESTS_PER_INVOCATION = 40;

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

// ONE CALL FOR BOTH VALUES this lane gates on — the pre-notify lead time and
// the periodic-interest master switch (#2213 r18 `4014510645`). The facet
// already bundles them, so needing the second answer costs no extra request
// and `CHAIN_OPENING_REQUESTS_AFTER_IDENTITY` is unchanged.
//
// Sourced from NumeraireConfigFacet, which is where this config moved in the
// #394 ConfigFacet split (Codex #647 round-3). Encoding it from ConfigFacetABI
// would make viem throw before the RPC call, so a future rename lands as a
// TypeScript error here instead of a silent runtime FunctionDoesNotExist. (The
// selector still routes through the Diamond — same address, different ABI.)
const PERIODIC_CONFIG_ABI = NumeraireConfigFacetABI;

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

/**
 * What is left of this invocation's outbound-request allowance.
 *
 * Mutated wherever a request is issued — a chain read or a delivery — so no
 * caller has to remember to report its spending upward.
 */
interface TickBudget {
  remaining: number;
}

/**
 * What one chain still needs AFTER its identity is settled: the lead-time
 * read, the head read, and one batched status read.
 *
 * A chain does not go further unless this plus a loan's worth is available, so
 * a pass never spends its opening reads and then finds it cannot afford to
 * send anything with them.
 *
 * The identity probe is deliberately NOT in this number. It costs a request
 * only on an isolate's first pass for a (chain, url) pair and nothing
 * afterwards, so folding it in would overstate the requirement on every warm
 * tick — skipping a chain whose real cost fits, and printing a figure one
 * higher than the truth while doing it (#2213 r17 `4014237569`). That is why
 * this test runs after the verdict, where the probe has already charged
 * itself or not.
 */
const CHAIN_OPENING_REQUESTS_AFTER_IDENTITY = 3;

export async function runPeriodicPreNotify(env: Env): Promise<void> {
  const chains = getChainConfigs(env).filter(
    (c) => c.diamond && c.diamond !== '0x0000000000000000000000000000000000000000',
  );
  if (chains.length === 0) return;

  const budget: TickBudget = { remaining: MAX_OUTBOUND_REQUESTS_PER_INVOCATION };

  // WHICH CHAIN GOES FIRST IS ALSO REMEMBERED, for the same reason the scan
  // position is (#2213 r13 `4013571003`).
  //
  // This was `minute % chains.length`, and r12 retired exactly that shape one
  // level down without my noticing it was still here. A clock-derived index
  // aliases with any periodic opportunity, and the cron IS one: at a `*/3`
  // schedule with three chains the minute is always a multiple of three, so
  // the same chain leads every tick and a busy one could hold the allowance
  // forever. The deleted schedule-pinning test had been protecting this too,
  // which I missed when I deleted it — the fix is to remove the dependence,
  // not to restore the pin.
  const startChain = await rotationStart(env, chains.length);
  await saveRotationStart(env, (startChain + 1) % chains.length);

  for (let i = 0; i < chains.length; i++) {
    const chain = chains[(i + startChain) % chains.length]!;
    if (budget.remaining <= 0) {
      // Not even enough to ASK anything. The fuller admission test lives
      // inside the pass, after the identity verdict, because until then the
      // opening cost is not known — see `CHAIN_OPENING_REQUESTS_AFTER_IDENTITY`
      // (#2213 r17 `4014237569`).
      console.warn(
        `[periodicPreNotify] chain=${chain.name} skipped: this invocation's ` +
          `allowance of ${MAX_OUTBOUND_REQUESTS_PER_INVOCATION} outbound ` +
          `request(s) is spent. It takes its turn first on a later tick, and ` +
          `the notification window is days wide.`,
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
  // IS THIS EVEN THE RIGHT CHAIN? ASKED FIRST (#2213 r14 `4013761179`, and
  // the ORDER is r16 `4014095561`).
  //
  // Everything below treats what this endpoint says as authoritative enough
  // to send a message that cannot be taken back. An `RPC_*` secret swapped to
  // a foreign network — with a head past our cursor and plausible state at the
  // same address — would answer every one of those reads confidently and
  // wrongly. The indexer has refused that configuration before reading state
  // since #1415; this lane became authoritative in r11 and never asked.
  //
  // IT GOES BEFORE THE LEAD-TIME READ, and that ordering is the whole of r16's
  // finding. With the probe after it, a foreign deployment answering a shorter
  // `getPreNotifyDays` could empty the candidate window, and an empty window
  // returns before the identity check ever runs — so the mis-pointed endpoint
  // decided whether its own identity was examined, and suppressed every
  // reminder on the chain for as long as the secret stayed wrong. Silently.
  // A precondition that a later step can skip is not a precondition.
  //
  // Cached per isolate per (chain, url), and CHARGED ONLY WHEN IT PROBES
  // (r16 `4014095543`): after the first pass it answers from memory and issues
  // nothing, so charging for the call rather than the request would invent one
  // per chain per tick. A MISMATCH and an UNANSWERED probe both stop the
  // chain — an endpoint that cannot say what it is could be the mis-pointed one.
  const identity = await verifyRpcChainIdentity(
    client,
    chain.id,
    chain.rpc,
    'periodicPreNotify',
  );
  if (!identity.ok || identity.probed) budget.remaining -= 1;
  if (!identity.ok) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: not pre-notifying — the RPC ` +
        `${
          identity.reason === 'mismatch'
            ? `answered eth_chainId=${identity.reported}, which is not this chain`
            : 'could not confirm which chain it serves'
        }. Nothing read from it can justify a reminder.`,
    );
    return;
  }

  // CAN THIS CHAIN AFFORD TO FINISH? Asked HERE, not in the caller, because
  // until the identity verdict is in, the opening cost is unknown (#2213 r17
  // `4014237569`). A warm cache makes that probe free, so a caller assuming it
  // always costs one would skip a chain whose real cost — lead time, head,
  // one batch and a loan's sends — fits exactly in what is left, and would
  // print a requirement one higher than the truth while doing it.
  if (budget.remaining < CHAIN_OPENING_REQUESTS_AFTER_IDENTITY + MAX_SENDS_PER_LOAN) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name} skipped: ${budget.remaining} ` +
        `outbound request(s) left, below the ` +
        `${CHAIN_OPENING_REQUESTS_AFTER_IDENTITY + MAX_SENDS_PER_LOAN} needed ` +
        `to read this chain and message about one loan. It takes its turn ` +
        `first on a later tick, and the notification window is days wide.`,
    );
    return;
  }

  // A HEAD THAT IS BEHIND WHAT THE PLATFORM HAS ALREADY INDEXED CANNOT
  // CONFIRM ANYTHING (#2213 r11 `4013218986`).
  //
  // The chain check exists to catch a stored row whose terminal event was
  // missed. If the endpoint serving this pass is behind the indexer's own
  // cursor — a lagging replica, a mis-pointed URL, conditions the indexer
  // detects explicitly for its own scan — then a loan that ended AFTER that
  // stale head still reads `Active`, the check passes, and the lane sends the
  // exact reminder it was built to withhold. Worse than no check: it is a
  // check that endorses the wrong answer.
  //
  // So the head is resolved first, compared against `indexer_cursor`, and the
  // batch is PINNED to it. Pinning is what turns a second node being behind
  // into an error rather than a quietly older answer.
  //
  // AND IT IS THE PASS'S ONE ANCHOR, resolved before anything else is read
  // (#2213 r20 `4014807939`). The config read below is pinned here too, so
  // the operational setting and the loan states describe a single block. It
  // used to sit above this and ask `latest`, which reopened the very gap the
  // pin closes: governance disabling settlement in between, or two nodes at
  // different heights, and the switch answers for a block the loans were
  // never read at.
  //
  // The cost is one request on a chain with nothing due, where the old order
  // returned before reaching here. That is the honest price of one anchor,
  // and it is three requests a tick across the deployed chains against an
  // allowance of forty.
  //
  // `latest` RATHER THAN A SETTLED TAG, deliberately. A reorg can only undo
  // recent blocks, and a terminal event in a block that reorgs out did not
  // happen — so reading the chain's current best view is the right basis for
  // "may we speak", and the notification window is days wide, which is many
  // ticks of correction. The indexer needs a settled head because it WRITES
  // rows it never revisits; this lane decides one message and asks again next
  // tick. (The stronger version would share the indexer's settled-head
  // resolver, which lives in that Worker and is not reachable from here.)
  let head: bigint;
  budget.remaining -= 1; // the head read
  try {
    head = await client.getBlockNumber();
  } catch (err) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: could not read the head; ` +
        `not pre-notifying this tick: ${describeFailure(err)}`,
    );
    return;
  }
  const indexed = await indexedThrough(env, chain.id);
  if (indexed === 'unknown') {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: could not read the indexer ` +
        `cursor, so whether this head is current cannot be established — no ` +
        `reminder is sent this tick. Nothing is stamped; the next tick asks ` +
        `again.`,
    );
    return;
  }
  if (indexed !== null && head < indexed) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: the RPC head ${head} is behind ` +
        `the indexed cursor ${indexed}, so its answers describe a past the ` +
        `stored rows have already moved beyond — nothing is confirmable this ` +
        `tick, and no reminder is sent. A lagging replica or a mis-pointed ` +
        `endpoint; the indexer flags the same condition for its own scan.`,
    );
    return;
  }

  // THE LEAD TIME AND THE KILL SWITCH COME BACK TOGETHER (#2213 r18
  // `4014510645`), because this lane needs BOTH before it may say anything and
  // `getPeriodicInterestConfig` already returns both in one call. Reading only
  // the lead time was the defect: `Loan.periodicInterestCadence` is
  // snapshotted at init and immutable "regardless of any later governance
  // change" (`LibVaipakam.sol`), and the kill switch gates `createOffer` and
  // `settlePeriodicInterest` — NOT the loans already open. So with the switch
  // off, every existing cadence loan stays Active and due-looking while
  // `settlePeriodicInterest` reverts `PeriodicInterestDisabled`. This lane
  // would have gone on telling those borrowers to pay before their collateral
  // is sold, for a payment the chain refuses to accept. An instruction the
  // recipient cannot act on is worse than silence, and it is worst precisely
  // when the switch is off — which is an emergency.
  let preNotifyDays = DEFAULT_PRE_NOTIFY_DAYS;
  budget.remaining -= 1; // the config read below
  let periodicEnabled: boolean;
  try {
    const cfg = (await client.readContract({
      address: chain.diamond as Address,
      abi: PERIODIC_CONFIG_ABI,
      functionName: 'getPeriodicInterestConfig',
      // PINNED TO THE SAME BLOCK THE LOAN STATES ARE READ AT (#2213 r20
      // `4014807939`). Unpinned, this asked `latest` while every loan read
      // asked `head`, so governance disabling settlement in between — or one
      // node behind a load balancer answering from a different height — let
      // the switch report enabled for a block at which it was already off.
      // The lane would then send and stamp the unretractable warning the r18
      // fix exists to prevent, and the r14 pin exists to stop exactly this
      // class of two-moments answer. Pinning one read and not the other was
      // half a fix.
      blockNumber: head,
    })) as readonly [string, bigint, number, boolean, boolean];
    // `preNotify` is already resolved against the library default on-chain, so
    // the guard here is only against a zero a malformed decode could produce.
    if (cfg[2] && Number(cfg[2]) > 0) preNotifyDays = Number(cfg[2]);
    periodicEnabled = cfg[3];
  } catch (err) {
    // A FAILED READ IS NOT PERMISSION TO SEND. The old code swallowed this and
    // fell back to the default lead time, which was defensible when the answer
    // only set a window width. It is not defensible now that the same call
    // carries whether the payment is possible at all: "we could not ask" and
    // "it is enabled" are different states, and collapsing them would put the
    // unactionable warning in front of the user on exactly the transport blip
    // that makes it hardest to notice.
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: not pre-notifying — could not ` +
        `read the periodic-interest config (${describeFailure(err)}), so ` +
        `whether settlement is currently accepted is unknown. Nothing is ` +
        `stamped; a later tick asks again.`,
    );
    return;
  }
  if (!periodicEnabled) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: not pre-notifying — the ` +
        `periodic-interest master switch is off, so settlement reverts for ` +
        `every loan on this chain. Existing cadence loans keep their cadence ` +
        `and still look due; telling them to pay would be an instruction the ` +
        `chain refuses. Nothing is stamped; reminders resume when it is on.`,
    );
    return;
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
  // AND THE SCAN RESUMES WHERE IT STOPPED — from STORED state, not from the
  // clock (#2213 r12 `4013387382`).
  //
  // Round 8 started successive ticks at successive spans, keyed on the minute.
  // That was a clock-derived index, and a clock-derived index aliases with any
  // periodic opportunity: first with the cron period (r8 follow-up pinned the
  // schedule to keep the step coprime), and then — the finding that retired the
  // approach — with the CHAIN rotation. A chain that only gets a turn every
  // `chains.length` ticks sees the minute advance in steps of that size, so
  // with three chains and three spans `minute % spans` is CONSTANT on every
  // opportunity it ever gets, and two thirds of its window is never examined.
  // Patching the arithmetic again would only move the collision, because the
  // defect is the input: a clock cannot know which ticks this chain was
  // actually scanned on.
  //
  // So the position advances on its own PROGRESS. Nothing can alias with it,
  // there is no coprimality to preserve, and the cron schedule becomes
  // irrelevant to coverage — which is why this change also deletes the test
  // that pinned that schedule.
  //
  // WHAT IS APPROXIMATE, stated rather than implied: the stored value is an
  // index into a list that changes between ticks as loans enter the window,
  // are stamped, or pass their deadline. So this resumes NEAR where it
  // stopped, not exactly. That is enough for the property being bought —
  // forward progress independent of any clock — and an exact resumption would
  // need a key that survives reordering, which a deadline-ordered list does
  // not have.
  const storedOffset = await scanOffset(env, chain.id);
  const start = storedOffset < due.length ? storedOffset : 0;

  let cursor = start;
  let reminded = 0;
  let unreached = 0;
  let noRoute = 0;
  let failedRails = 0;
  let rejected = 0;
  let checkpointLag = 0;
  let unreadable = 0;
  let pushUnconfigured = 0;
  let batches = 0;
  let batchFailed = false;
  while (
    cursor < due.length &&
    // Room for this batch's read AND a loan's worth of sends: reading a batch
    // this tick cannot afford to act on spends a request for nothing.
    budget.remaining >= 1 + MAX_SENDS_PER_LOAN &&
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
    budget.remaining -= 1; // the batched status read
    const states = await readLoanStates(client, chain, batch.map((c) => c.row.loan_id), head);
    if (states === null) {
      // STOP, DO NOT RETURN (#2213 r12 `4013387389`). Earlier batches in this
      // same pass may already have sent messages and stamped checkpoints;
      // returning here threw away their counters and skipped the summary, so
      // the only thing an operator saw during an RPC incident was "not
      // pre-notifying this tick" — while deliveries and failed rails from the
      // completed batches went unreported. Breaking keeps them, and the
      // summary below describes only THIS batch as unreadable.
      batchFailed = true;
      break;
    }

    const outcome = await messageBatch(env, chain, batch, states, budget, now);
    reminded += outcome.reminded;
    unreached += outcome.unreached;
    noRoute += outcome.noRoute;
    failedRails += outcome.failedRails;
    rejected += outcome.rejected;
    checkpointLag += outcome.checkpointLag;
    unreadable += outcome.unreadable;
    pushUnconfigured += outcome.pushUnconfigured;
    cursor += outcome.consumed;
  }

  // WHERE THE NEXT TICK PICKS UP. Written even when nothing was examined, so
  // a pass that stopped for want of allowance does not re-read the same
  // prefix next time.
  await saveScanOffset(env, chain.id, cursor < due.length ? cursor : 0);

  // WHAT THIS TICK LEFT UNDONE, and which of the two limits left it.
  const examined = cursor - start;
  // TESTS THE CURSOR, not how many rows this tick looked at (#2213 r13
  // `4013571024`). A pass that RESUMED at 300 in a 350-row window and finished
  // it examined 50 — so the old `examined < due.length` was true and the tick
  // announced a remainder it had just consumed, telling an operator the run
  // was partial when it had completed the window.
  if (cursor < due.length) {
    // THE SAME THRESHOLD THE LOOP TESTS (#2213 r14 `4013761165`). The loop
    // needs a batch read AND a loan's sends to continue, so a tick stopping
    // with exactly four left was halted by the allowance and reported only
    // "stopping". And it is the OUTBOUND-REQUEST allowance now, not a send
    // allowance — reads come out of the same counter since r13.
    const capped =
      budget.remaining < 1 + MAX_SENDS_PER_LOAN
        ? `the invocation's outbound-request allowance is down to ${budget.remaining}`
        : null;
    const scanned = batches >= MAX_EXAMINE_BATCHES ? 'the scan reached its read cap' : null;
    // THE THIRD WAY A TICK STOPS (#2213 r15 `4013952981`). `batchFailed` was
    // set and never read, so a read failure before either cap produced the
    // bare "stopping" — on the very summary that exists to report what the
    // completed batches did, during the incident that makes it matter.
    const failed = batchFailed ? 'a status read failed for the batch after these' : null;
    const span = start > 0 ? ` (resumed at ${start})` : '';
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: ${due.length} loan(s) in the ` +
        `notification window${span}, ${examined} examined, ${reminded} reminded, ` +
        `${unreached} reached nobody, ${noRoute} with nobody to tell, ` +
        `${failedRails} rail(s) unconfirmed, ` +
        `${rejected} rejected by the chain, ${checkpointLag} awaiting the ` +
        `indexer, ${unreadable} unreadable — ` +
        `${failed ?? capped ?? scanned ?? 'stopping'}. ` +
        `The remainder is not dropped: nothing is stamped for it, and the ` +
        `next tick RESUMES from ${cursor < due.length ? cursor : 0} rather ` +
        `than re-reading this prefix. A tick that reports the read cap with ` +
        `hundreds rejected is reporting orphaned rows, not load — whereas ` +
        `hundreds awaiting the indexer is the indexer being behind, which ` +
        `needs nothing done to the rows themselves.`,
    );
  } else if (noRoute + unreached + failedRails + rejected + checkpointLag + unreadable > 0) {
    // A COMPLETED SCAN REPORTS TOO, when it has something to report (#2213
    // r19 `4014677438`). The summary above only fires on an early stop, on the
    // reasoning that a finished window needs no explanation — which is true of
    // a finished window in which everything went right, and false of one that
    // reached nobody. A tick that quietly stamps forty loans as handled having
    // delivered nothing is the failure this lane is least able to notice, and
    // it is the ORDINARY shape of a misconfigured deployment: nothing is
    // capped, nothing is unreadable, the scan finishes every time.
    //
    // Still silent on a clean tick. The condition is "did anything happen that
    // someone would want to know about", not "did the scan end early".
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: scan complete — ` +
        `${examined} examined, ${reminded} reminded, ${unreached} reached ` +
        `nobody, ${noRoute} with nobody to tell, ${failedRails} rail(s) ` +
        `unconfirmed, ${rejected} rejected by the chain, ${checkpointLag} ` +
        `awaiting the indexer, ${unreadable} unreadable.`,
    );
  }

  // THE DEPLOYMENT'S OWN CONFIGURATION, SAID OUT LOUD (#2213 r19
  // `4014677438`). Once per chain per tick with a count, never per loan: this
  // is one fact about the Worker, and printing it per subscriber is how a real
  // misconfiguration becomes background noise.
  //
  // It went missing by a route worth remembering. `sendPush` used to log
  // "PUSH_CHANNEL_PK unset" when it was reached with no signer. Moving that
  // check up into the condition that decides whether a request happens was
  // correct — it is what stopped the lane charging its allowance for requests
  // it never made — but `sendPush` was then never reached, and the diagnostic
  // went with it. A fix to the accounting silently removed a disclosure.
  if (pushUnconfigured > 0) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: ${pushUnconfigured} ` +
        `subscriber(s) this tick have a Push channel set while this ` +
        `deployment has no PUSH_CHANNEL_PK, so no Push was sent to them and ` +
        `none can be. They were reached on Telegram or not at all. Set the ` +
        `signer, or the Push channel on those subscriptions is inert.`,
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
): Promise<{
  consumed: number;
  reminded: number;
  unreached: number;
  noRoute: number;
  failedRails: number;
  rejected: number;
  checkpointLag: number;
  unreadable: number;
  pushUnconfigured: number;
}> {
  let reminded = 0;
  let unreached = 0;
  let noRoute = 0;
  let failedRails = 0;
  let rejected = 0;
  let checkpointLag = 0;
  let unreadable = 0;
  let pushUnconfigured = 0;
  for (let i = 0; i < batch.length; i++) {
    // RESERVED, not spent. A loan may need up to four sends and must not be
    // started unless all four are available — see `MAX_SENDS_PER_LOAN`.
    if (budget.remaining < MAX_SENDS_PER_LOAN) {
      return {
        consumed: i, reminded, unreached, noRoute, failedRails,
        rejected, checkpointLag, unreadable, pushUnconfigured,
      };
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
    const verdict = periodicInterestEligibility(detail, nextCheckpoint);
    if (verdict !== 'ok') {
      // WHAT THE CHAIN SAID, AND NOTHING ABOUT WHAT HAPPENS NEXT (#2213 r4
      // `4012114114`). An earlier version promised the reconciliation pass
      // would correct the stored row. For a terminal status it will; for a
      // status this build does not recognise it deliberately will NOT — it
      // refuses to project an unknown member and only reports it. Promising a
      // correction that cannot happen sends an operator away from a row that
      // needs them.
      //
      // ONE DECISION PRODUCES BOTH THE WORDING AND THE TALLY (#2213 r18
      // `4014510655`). They used to be decided in different places: the
      // per-loan line already said `checkpoint-advanced` was most likely
      // indexer lag, while the counter filed it under `rejected` and the
      // summary called the total "rejected by the chain" and pointed at
      // orphaned rows. The parts were right and the aggregate was wrong,
      // which is the harder failure to notice — nobody reads every per-loan
      // line, and the summary is what an operator acts on.
      const explained = explainVerdict(verdict, detail, nextCheckpoint);
      console.warn(
        `[periodicPreNotify] chain=${chain.name} loan=${row.loan_id}: ` +
          `${explained.text} — no reminder sent. Nothing is stamped, so a ` +
          `later tick reconsiders.`,
      );
      if (explained.bucket === 'checkpoint-lag') checkpointLag += 1;
      else rejected += 1;
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
    // THREE OUTCOMES, COUNTED SEPARATELY (#2213 r10 `4013087415`).
    // "Reminded" is a claim about a person having been told, so it needs a
    // rail that was CONFIRMED accepted. A Telegram 401 and a Push SDK throw
    // both issued a request — they are charged — and neither is evidence that
    // anyone was reached, so they are their own count rather than folded into
    // either neighbour.
    // THREE NUMBERS, THREE QUESTIONS (#2213 r10 `4013087415`, r11
    // `4013218976`). They are not alternatives and must not be an `else if`
    // chain: a loan reached on Telegram while every Push failed is a reminder
    // AND two broken rails, and reporting only the first hides a
    // deployment-wide outage behind a working second channel.
    //
    // `reminded` counts LOANS somebody was confirmed to have been told about.
    // `unreached` counts LOANS that were attempted and confirmed to nobody.
    // `failedRails` counts RAILS — the channel-health signal, which is why it
    // is per-rail and not per-loan.
    if (borrowerOutcome.delivered || lenderOutcome.delivered) {
      reminded += 1;
    } else if (borrowerOutcome.attempted || lenderOutcome.attempted) {
      unreached += 1;
    } else {
      // NOTHING WAS EVEN TRIED for this loan: both sides are unreachable, or
      // have no subscription at all. It is still EXAMINED, so leaving it out
      // of every category made the summary's numbers fail to add up — ten
      // loans could vanish between "18 examined" and "8 reminded" with
      // nothing saying where they went (#2213 r12 `4013387370`).
      noRoute += 1;
    }
    failedRails += borrowerOutcome.unconfirmedRails + lenderOutcome.unconfirmedRails;
    pushUnconfigured +=
      (borrowerOutcome.pushUnconfigured ? 1 : 0) + (lenderOutcome.pushUnconfigured ? 1 : 0);

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
    const handled = (o: DeliveryOutcome) => o.status === 'sent' || o.status === 'no-route';
    const anyHandled = handled(borrowerOutcome) || handled(lenderOutcome);
    const onlyBlockedByOptOut =
      !anyHandled &&
      (borrowerOutcome.status === 'opted-out' || lenderOutcome.status === 'opted-out');
    if (onlyBlockedByOptOut) continue;
    try {
      await env.DB.prepare(
        `UPDATE loans SET period_pre_notified_at = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(nextCheckpoint, now, chain.id, row.loan_id)
        .run();
    } catch (err) {
      // CAUGHT HERE, so a failed stamp cannot discard what this pass already
      // did (#2213 r17 `4014237577`). Escaping to the chain-level catch threw
      // away the delivery counters, skipped the summary, and left the scan
      // position unsaved — for a tick in which messages had ALREADY gone out.
      //
      // WHAT THE LINE CLAIMS IS READ OFF THE OUTCOMES, not asserted beside
      // them (#2213 r18 `4014510672`). The r17 wording said "the reminder went
      // out" unconditionally, and the stamp does not only happen after a
      // delivery: `handled` includes `no-route`, so a loan whose
      // counterparties have no usable rail — and a loan whose every rail
      // failed — reaches this catch with nothing delivered. A D1 error would
      // then have been reported as a confirmed user notification, which is the
      // same overclaim this PR removed from `reminded`, arriving by a
      // different door. Deriving the sentence from `delivered` makes the two
      // impossible to drift apart.
      const delivered = borrowerOutcome.delivered || lenderOutcome.delivered;
      const attempted = borrowerOutcome.attempted || lenderOutcome.attempted;
      const what = delivered
        ? 'a reminder was delivered for this loan'
        : attempted
          ? 'a reminder was attempted for this loan and confirmed to nobody'
          : 'nothing was sent for this loan — nobody had a usable route';
      const consequence = delivered
        ? 'A later tick will send it again — the stamp is the only record ' +
          'that it already has.'
        : 'A later tick will reconsider it, which is the intended outcome ' +
          'here rather than a duplicate.';
      console.warn(
        `[periodicPreNotify] chain=${chain.name} loan=${row.loan_id}: ` +
          `${what}, and its checkpoint could not be stamped ` +
          `(${describeFailure(err)}). ${consequence}`,
      );
    }
  }
  return {
    consumed: batch.length,
    reminded,
    unreached,
    noRoute,
    failedRails,
    rejected,
    checkpointLag,
    unreadable,
    pushUnconfigured,
  };
}

/** The `indexer_cursor` row the indexer advances for its own chain scan. */
const INDEXER_SCAN_KIND = 'diamond';

/**
 * The `indexer_cursor` row THIS lane advances for its own window scan.
 *
 * A separate `kind` in the existing table rather than a new table, so this
 * needs no migration and therefore does not walk into the deploy-window
 * hazard #2214 describes — which was the reason round 8 reached for a
 * clock-derived rotation in the first place. `last_block` carries a position
 * in the candidate list rather than a block; the indexer already repurposes
 * the column this way for its market sweep, so the shape is the established
 * one here rather than an invention.
 */
const PRENOTIFY_SCAN_KIND = 'prenotify_scan';

/** The row carrying which chain leads the next invocation. */
const PRENOTIFY_ROTATION_KIND = 'prenotify_rotation';

/**
 * The rotation row, stored against chain id 0 — not a chain, so it cannot
 * collide with a real one, and the `(chain_id, kind)` key keeps it distinct
 * from every per-chain row.
 */
const ROTATION_ROW_CHAIN_ID = 0;

/** Which chain leads this invocation. Absent or unreadable → the first one. */
async function rotationStart(env: Env, chainCount: number): Promise<number> {
  if (chainCount <= 1) return 0;
  try {
    const row = await env.DB.prepare(
      `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
    )
      .bind(ROTATION_ROW_CHAIN_ID, PRENOTIFY_ROTATION_KIND)
      .first<{ last_block: number }>();
    const at = row ? Number(row.last_block) : 0;
    return Number.isFinite(at) && at >= 0 ? at % chainCount : 0;
  } catch (err) {
    // SAID, for the same reason the scan position is (#2213 r14
    // `4013761131`). Silently leading with the first chain every tick lets a
    // busy one hold the shared allowance and starve the rest — the failure
    // the rotation exists to prevent, reinstated by a failure nobody sees.
    console.warn(
      `[periodicPreNotify] could not read the stored rotation position ` +
        `(${describeFailure(err)}); leading with the first chain. Repeated ` +
        `appearances mean later chains may not be reached at all.`,
    );
    return 0;
  }
}

/** Remember which chain leads next. Reported when it fails — see `saveScanOffset`. */
async function saveRotationStart(env: Env, next: number): Promise<void> {
  await persistCursor(env, ROTATION_ROW_CHAIN_ID, PRENOTIFY_ROTATION_KIND, next);
}

/**
 * Remember where to resume — and SAY SO when that cannot be done (#2213 r13
 * `4013571011`).
 *
 * A write that never lands, or a read that keeps failing, returns the scan to
 * the front on every tick. That is not merely "one wasteful repeat": with a
 * few hundred unreachable or rejected loans at the head of the window — the
 * exact case persistence was added for — it restores the starvation the
 * persistence removed. So the failure is reported rather than swallowed.
 *
 * **There was an in-isolate fallback here, and r14 deleted it** (`4013761116`,
 * `4013761131`). The idea was that a database refusing writes should still
 * make progress for as long as the isolate lives, and it produced two findings
 * in one round: a later successful READ overwrote the remembered value with
 * the stale stored one, and the rotation never consulted the memory at all.
 * Both were real, and fixing each would have left a third — dirty-vs-clean
 * tracking, per-kind, across two readers — for a case nothing has observed.
 *
 * So there is ONE source of truth, D1, and a failure to use it degrades
 * fairness LOUDLY instead of quietly. That is what the finding which asked for
 * this behaviour actually required ("preserve an in-isolate fallback or at
 * minimum report the unavailable cursor"); the fallback was the more elaborate
 * half of an either/or, and it earned its complexity in findings rather than
 * in behaviour.
 */
async function persistCursor(
  env: Env,
  chainId: number,
  kind: string,
  at: number,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, kind) DO UPDATE SET
         last_block = excluded.last_block,
         updated_at = excluded.updated_at`,
    )
      .bind(chainId, kind, at, Math.floor(Date.now() / 1000))
      .run();
  } catch (err) {
    console.warn(
      `[periodicPreNotify] could not persist ${kind} for chain ${chainId} at ` +
        `${at}: ${describeFailure(err)}. The next tick therefore starts from ` +
        `where this one did rather than from where it stopped — so if this ` +
        `keeps appearing, loans behind a run of unreachable ones stop being ` +
        `reached, and that is the fairness guarantee degrading, not a ` +
        `wasted read.`,
    );
  }
}

async function saveScanOffset(env: Env, chainId: number, at: number): Promise<void> {
  await persistCursor(env, chainId, PRENOTIFY_SCAN_KIND, at);
}


/** Where this chain's scan stopped last tick. Absent or unreadable → start over. */
async function scanOffset(env: Env, chainId: number): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
    )
      .bind(chainId, PRENOTIFY_SCAN_KIND)
      .first<{ last_block: number }>();
    const at = row ? Number(row.last_block) : 0;
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch (err) {
    // A failure here is safe to absorb — nothing is decided on this value
    // except where to start looking, so the worst case is a repeated prefix
    // rather than a wrong message. It is NOT safe to absorb silently: a
    // repeated prefix IS the starvation this persistence removed.
    console.warn(
      `[periodicPreNotify] chain ${chainId}: could not read the stored scan ` +
        `position (${describeFailure(err)}); starting from the front of the ` +
        `window. Repeated appearances mean loans behind a run of unreachable ` +
        `ones are not being reached.`,
    );
    return 0;
  }
}


/**
 * The block the indexer has scanned this chain through: a number, `null` when
 * it has never recorded one, or `'unknown'` when the question could not be
 * asked.
 *
 * Read from the shared database rather than asked of the indexer: the two
 * Workers already read the same D1, and a cross-Worker call would reintroduce
 * exactly the coupling #2213 r3 removed from this lane.
 *
 * `null` is not an error. A chain the indexer has never scanned has no cursor
 * to be behind, and blocking on its absence would silence the lane on a fresh
 * deployment for a comparison that could not have said anything.
 *
 * `'unknown'` IS a reason to stop, and keeping the two apart is the whole
 * shape of this function. They were one value until #2213 r12.
 */
async function indexedThrough(env: Env, chainId: number): Promise<bigint | null | 'unknown'> {
  try {
    const row = await env.DB.prepare(
      `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
    )
      .bind(chainId, INDEXER_SCAN_KIND)
      .first<{ last_block: number }>();
    return row ? BigInt(row.last_block) : null;
  } catch {
    // NOT `null`, and the difference is the whole point (#2213 r12
    // `4013387361`). `null` means "there is no cursor, so there is nothing to
    // be behind" and lets the pass continue; collapsing a FAILED READ into it
    // would turn a database hiccup into permission to send on exactly the
    // stale head the comparison exists to catch. An unanswered question is
    // not an answer.
    return 'unknown';
  }
}

/**
 * The operator-facing sentence for a verdict.
 *
 * English lives here rather than in the shared rule so the rule stays a rule;
 * what each case needs said differs by lane, and a lane messaging about a
 * different contract call would word these differently for the same verdict.
 */
/**
 * ONE place decides what a non-`ok` verdict is CALLED and which total it joins
 * (#2213 r18 `4014510655`).
 *
 * The wording and the tally used to be chosen independently, and drifted: the
 * per-loan line described `checkpoint-advanced` as indexer lag while the
 * summary counted it under "rejected by the chain" and told the operator to go
 * looking for orphaned rows. Those are different problems with opposite
 * remedies — a chain rejection is a stored row that needs repairing, index lag
 * is the system working and catching up, and nothing should be done about it.
 *
 * Returning both from one switch makes the drift unrepresentable, and the
 * exhaustive `PeriodicEligibility` union means a verdict added later cannot
 * inherit a bucket by default: it fails to compile until someone chooses.
 */
function explainVerdict(
  verdict: Exclude<PeriodicEligibility, 'ok'>,
  detail: LoanState,
  expected: number,
): { text: string; bucket: 'rejected' | 'checkpoint-lag' } {
  switch (verdict) {
    case 'no-such-loan':
      return {
        text: 'stored as active but the chain has no such loan (zero struct)',
        bucket: 'rejected',
      };
    case 'ended':
      return {
        text: `stored as active but the chain reports status ${Number(detail.status)}`,
        bucket: 'rejected',
      };
    case 'no-cadence':
      return {
        text:
          `stored with a periodic cadence but the chain reports cadence ` +
          `${Number(detail.periodicInterestCadence)}, which this build cannot ` +
          `turn into a payment date`,
        bucket: 'rejected',
      };
    case 'checkpoint-advanced':
      return {
        text:
          `the stored row still points at the checkpoint ${expected}, and the ` +
          `chain settled its last period at ` +
          `${Number(detail.lastPeriodicInterestSettledAt)} — the period this ` +
          `reminder is about is not the one the chain is on, most likely a ` +
          `payment the indexer has not caught up with`,
        // NOT a rejection. The chain knows this loan and is happy with it; our
        // copy is a few blocks behind and heals itself on the next indexer
        // pass. Filing it with the ghost rows would send an operator to repair
        // something that is already correct.
        bucket: 'checkpoint-lag',
      };
  }
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
    const ivlDays = periodicIntervalDays(row.periodic_interest_cadence);
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

/**
 * What the chain says about each loan, positionally. `null` where it did not
 * say.
 *
 * The whole struct is decoded, and the rule reads four fields of it — the
 * period checkpoint among them, which is why r12's finding was answerable
 * without a second call: the answer was already in hand and simply not looked
 * at.
 */
type LoanState = PeriodicLoanState;

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
  blockNumber: bigint,
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
      blockNumber,
    );
  } catch (err) {
    // BOUNDED DESCRIPTION, never the message: viem puts the full request URL
    // — API key included — in `HttpRequestError.message` (#2213 r5
    // `4012300079`).
    console.warn(
      `[periodicPreNotify] chain=${chain.name} status read failed for this ` +
        `batch of ${loanIds.length} loan(s): ${describeFailure(err)}. The scan ` +
        `stops here; whatever earlier batches in this tick already did is ` +
        `reported in the summary below.`,
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

/**
 * What happened for one counterparty, in the three senses that differ.
 *
 * `status` drives STAMPING and is the pre-existing semantics (#1056).
 * `attempted` is whether any rail issued a request — what the allowance was
 * charged for. `delivered` is whether a rail was CONFIRMED accepted, and it is
 * the only thing that may be reported as a reminder (#2213 r10 `4013087415`).
 *
 * They are three fields rather than one because they genuinely disagree: a
 * Telegram 401 and a Push SDK throw are both attempted, neither delivered, and
 * both still stamp — and collapsing any two of those let a run tell an
 * operator it had reminded people it had not reached.
 */
interface DeliveryOutcome {
  status: PreNotifyOutcome;
  attempted: boolean;
  delivered: boolean;
  /**
   * Rails that issued a request and could not be confirmed.
   *
   * A COUNT rather than a flag, and reported independently of `delivered`
   * (#2213 r11 `4013218976`). A loan reached on one rail and failed on the
   * other is a reminder AND a broken rail; folding the second into the first
   * meant a deployment-wide Push outage reported nothing wrong for as long as
   * Telegram kept working — which is the outage an operator most needs to see.
   */
  unconfirmedRails: number;
  /**
   * The subscriber asked for Push and the DEPLOYMENT has no signer.
   *
   * Carried out of here rather than logged here (#2213 r19 `4014677438`),
   * because it is a property of the deployment and not of this loan: logging
   * per loan would print the same line for every subscriber on every tick,
   * which is how a real misconfiguration gets trained into background noise.
   * The chain pass reports it once, with a count.
   *
   * It exists at all because moving `PUSH_CHANNEL_PK` into the condition that
   * decides whether a request happens — correct, and what stopped the lane
   * charging for requests it never made — also stopped `sendPush` being
   * reached, and `sendPush` was where the "unset" diagnostic lived. The charge
   * fix silently took the disclosure with it.
   */
  pushUnconfigured: boolean;
}

async function pushIfSubscribed(
  env: Env,
  chain: { id: number; name: string },
  loan: LoanRow,
  wallet: string,
  daysUntil: number,
  role: 'borrower' | 'lender',
  budget: TickBudget,
): Promise<DeliveryOutcome> {
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
  if (!sub) {
    return {
      status: 'none', attempted: false, delivered: false,
      unconfirmedRails: 0, pushUnconfigured: false,
    };
  }
  // #1033 — the connected app Alerts card exposes this as a real opt-out;
  // honor it before any rail fires. Reported distinctly so the
  // caller can leave the checkpoint unstamped (a re-enable before
  // the deadline must still get its reminder).
  if (sub.notify_maturity_approaching === 0) {
    return {
      status: 'opted-out', attempted: false, delivered: false,
      unconfirmedRails: 0, pushUnconfigured: false,
    };
  }

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
  let attempted = false;
  let delivered = false;
  let unconfirmedRails = 0;
  if (pushSigner) {
    // CHARGED FROM WHAT THE SENDER REPORTS, not from the fact that we called
    // it (#2213 r9 `4012940120`). `sendPush` swallows its own failures, so a
    // malformed `PUSH_CHANNEL_PK` returns quietly having made no request —
    // and on a deployment misconfigured that way, that is EVERY push. The
    // truthiness guard added in r8 saw a non-empty key and charged anyway,
    // which is the same "charged for something that did not happen" this
    // whole sequence of rounds has been about, one layer further down.
    //
    // The same answer drives the REPORT: a loan whose only rail made no
    // request is not "reminded". Every earlier revision charged a loan slot further up
    // and was wrong in the same way each time: a candidate that sends nothing
    // held the allowance, was never stamped, and so held it again on the next
    // tick. Decrementing where the request is issued makes that impossible
    // rather than merely handled — there is no path to a send that skips this
    // line, and no path to this line that skips a send.
    try {
      const attempt = await sendPush(pushSigner, {
        subscriber: wallet,
        title,
        body,
        deepLinkUrl: deepLink,
      });
      if (attempt !== 'not-requested') {
        // CHARGED for `failed` as well as `accepted` — a request may have gone
        // — while only `accepted` is evidence anyone was told.
        attempted = true;
        budget.remaining -= 1;
        if (attempt === 'accepted') delivered = true;
        else unconfirmedRails += 1;
      }
    } catch (err) {
      console.error(
        `[periodicPreNotify] push failed loan=${loan.loan_id} wallet=${wallet} ` +
          `err=${describeFailure(err)}`,
      );
    }
  }
  if (tgRoute) {
    attempted = true;
    budget.remaining -= 1;
    try {
      // `sendMessage` returns whether TELEGRAM ACCEPTED it: false covers both
      // a definitive rejection (a 401 from a rotated token, a 400 from a stale
      // chat id) and a network failure. Either way nobody can say the message
      // arrived, so it is charged and not counted (#2213 r10 `4013087415`).
      if (await sendMessage(tgRoute.token, tgRoute.chat, `${title}\n${body}\n${deepLink}`)) {
        delivered = true;
      } else {
        unconfirmedRails += 1;
      }
    } catch (err) {
      unconfirmedRails += 1;
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
  return {
    status: attempted ? 'sent' : 'no-route',
    attempted,
    delivered,
    unconfirmedRails,
    // The subscriber WANTED push (they have a channel) and the deployment
    // cannot sign for it. Distinct from "no channel": that is the user's
    // choice, this is the operator's configuration.
    pushUnconfigured: Boolean(sub.push_channel) && !env.PUSH_CHANNEL_PK,
  };
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
