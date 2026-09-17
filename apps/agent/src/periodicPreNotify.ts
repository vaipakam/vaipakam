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
import { AdminFacetABI, LoanFacetABI, NumeraireConfigFacetABI } from '@vaipakam/contracts/abis';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { sendPush } from './push';
import { sendMessage } from './telegram';
import {
  periodicIntervalDays,
  periodicInterestEligibility,
  type PeriodicEligibility,
  type PeriodicLoanState,
} from '@vaipakam/lib/periodicEligibility';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { isRpcIdentityVerified, verifyRpcChainIdentity } from '@vaipakam/lib/rpcIdentity';

const DEFAULT_PRE_NOTIFY_DAYS = 3;
const SECONDS_PER_DAY = 86_400;

/**
 * The allowance, counted in OUTBOUND REQUESTS — every one of them, reads
 * included (#2213 r13 `4013571040`).
 *
 * A Worker invocation gets a documented 50 subrequests, shared with every
 * other lane on the same tick — the same ceiling the indexer sizes its own
 * passes against (`apps/indexer/src/chainIndexer.ts`).
 *
 * **D1 COMES OUT OF IT, and an earlier version of this comment said it did
 * not** (#2213 r27 `4016129218`). That claim was taken from
 * `loanReconcile.ts`, which asserts D1 rows "are not subrequests, so this
 * costs nothing against the invocation budget". The repository contradicts
 * itself on this and that file is the wrong half: `marketSummary.ts` states
 * the opposite in its own invariants — "a whole sweep costs a constant number
 * of D1 subrequests" — and it is the one that matches the platform. A binding
 * call is a subrequest.
 *
 * The consequence of believing the wrong half was not cosmetic. Forty
 * outbound plus the lane's own D1 traffic — a rotation read and write, four
 * bookkeeping calls per chain, and up to five per loan messaged — reached the
 * high sixties on a full tick, so a busy chain could hit the platform ceiling
 * MID-LOAN: one counterparty told, the other not, and the cursor write that
 * would have recorded the position lost with it.
 *
 * So the counter is subrequests, not outbound requests, and every D1 call
 * decrements it too. That is the same argument r13 made for folding reads in
 * with sends, applied to the third kind of spend nobody had counted.
 *
 * This lane spends the allowance on chain reads, on D1, and
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
// EXPORTED AS A TEST SEAM (#2213 r22). Ten budget tests hand-computed their
// expectations from these three numbers, so adding the pause read broke all
// ten at once and each had to be re-derived by hand. The suite now computes
// from the constants instead, which is the difference between a test that
// fails when BEHAVIOUR changes and one that fails when arithmetic moves.
export const MAX_SUBREQUESTS_PER_INVOCATION = 40;

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
export const MAX_SENDS_PER_LOAN = 4;

/**
 * The D1 a single loan costs: up to two subscriber lookups per counterparty
 * (the row, then the legacy fallback when it misses) and one checkpoint
 * stamp.
 *
 * WORST CASE, not typical, because the reservation exists so a started loan
 * always finishes (#2213 r27 `4016129218`). Reserving the typical four would
 * put the overshoot back where the ceiling is, which is the failure this
 * whole reservation prevents. The cost is a little allowance unused.
 */
export const MAX_D1_PER_LOAN = 5;

/** Everything one loan can spend: its sends and its own bookkeeping. */
export const MAX_SUBREQUESTS_PER_LOAN = MAX_SENDS_PER_LOAN + MAX_D1_PER_LOAN;

/**
 * The scan position written back at the end of every pass.
 *
 * HELD BACK FROM THE LOAN LOOP, not merely counted (#2213 r32 `4017648029`).
 * It is inside `CHAIN_OPENING_REQUESTS_AFTER_IDENTITY`, so a chain is only
 * ADMITTED when there is room for it — and nothing kept the loop from
 * spending it afterwards. A run of cheap loans could take the remainder to
 * exactly a loan's worth, admit one more, spend all of it, and then issue
 * this write anyway: one request past the stated cap.
 *
 * The same shape as the indexer lane's P1 one round earlier (#2221): a
 * request made at the END of a pass, by a step no gate consults, in a lane
 * whose gates all reason about what comes next. A pass that spends its last
 * request on work and then cannot record where it got to is the failure
 * every one of these budgets exists to prevent, so this one is reserved
 * rather than hoped for.
 */
export const CURSOR_WRITE_RESERVE = 1;

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

/**
 * `AdminFacet.paused()` — the Diamond-wide emergency stop.
 *
 * A SECOND read rather than folded into the config bundle, because the two
 * live on different facets and there is no getter carrying both. It costs one
 * more request per chain per tick — one of the four chain reads in
 * `CHAIN_OPENING_REQUESTS_AFTER_IDENTITY`.
 */
const PAUSE_ABI = AdminFacetABI;

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
 * What one chain still needs AFTER its identity is settled.
 *
 * FOUR CHAIN READS — the head, the config (lead time + periodic switch), the
 * pause, and one batched status read — AND FOUR D1 CALLS: the indexer cursor,
 * this lane's stored scan position, the candidate query, and the write that
 * saves the position again (#2213 r27 `4016129218`). The D1 half was missing
 * from this number for as long as the budget believed D1 was free.
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
export const CHAIN_OPENING_REQUESTS_AFTER_IDENTITY = 8;

export async function runPeriodicPreNotify(env: Env): Promise<void> {
  const chains = getChainConfigs(env).filter(
    (c) => c.diamond && c.diamond !== '0x0000000000000000000000000000000000000000',
  );
  if (chains.length === 0) return;

  const budget: TickBudget = { remaining: MAX_SUBREQUESTS_PER_INVOCATION };

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
  const startChain = await rotationStart(env, chains.length, budget);
  await saveRotationStart(env, (startChain + 1) % chains.length, budget);

  for (let i = 0; i < chains.length; i++) {
    const chain = chains[(i + startChain) % chains.length]!;
    if (budget.remaining <= 0) {
      // Not even enough to ASK anything. The fuller admission test lives
      // inside the pass, after the identity verdict, because until then the
      // opening cost is not known — see `CHAIN_OPENING_REQUESTS_AFTER_IDENTITY`
      // (#2213 r17 `4014237569`).
      console.warn(
        `[periodicPreNotify] chain=${chain.name} skipped: this invocation's ` +
          `allowance of ${MAX_SUBREQUESTS_PER_INVOCATION} outbound ` +
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
  //
  // AND THE PROBE'S COST IS KNOWN BEFORE IT IS SPENT (#2213 r24
  // `4015538606`). r17 moved admission AFTER the verdict so a warm probe was
  // not charged for — correct, and it left the opposite hole: a COLD chain
  // that cannot be admitted still burns its probe, and the chain behind it,
  // whose probe is warm and which could have afforded the whole pass, is then
  // refused for the request the first one wasted. A mixed cache is the
  // ordinary state after any capped run, so this is not a corner.
  //
  // `isRpcIdentityVerified` answers what the probe will cost without issuing
  // anything, which makes admission and probing one budget-aware decision
  // rather than two that disagree.
  const identityCostsARequest = !isRpcIdentityVerified(chain.id, chain.rpc);
  const needed =
    CHAIN_OPENING_REQUESTS_AFTER_IDENTITY +
    MAX_SUBREQUESTS_PER_LOAN +
    (identityCostsARequest ? 1 : 0);
  if (budget.remaining < needed) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name} skipped: ${budget.remaining} ` +
        `outbound request(s) left, below the ${needed} needed to ` +
        `${identityCostsARequest ? 'verify, ' : ''}read this chain and ` +
        `message about one loan. Nothing is spent on it — including its ` +
        `identity probe, so a later chain that can afford the pass still ` +
        `gets it. It takes its turn first on a later tick, and the ` +
        `notification window is days wide.`,
    );
    return;
  }

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
  const indexed = await indexedThrough(env, chain.id, budget);
  if (indexed === 'unknown') {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: could not read the indexer ` +
        `cursor, so whether this head is current cannot be established — no ` +
        `reminder is sent this tick. Nothing is stamped; the next tick asks ` +
        `again.`,
    );
    return;
  }
  if (indexed === 'absent') {
    // SAME ACTION, DIFFERENT DIAGNOSIS from the unreadable case above (#2213
    // r29 `4016866279`). Both stop the tick; only this one may need somebody.
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: there is no indexer cursor ` +
        `row for this chain, so whether this head is current cannot be ` +
        `established — no reminder is sent this tick, and nothing is ` +
        `stamped. This is expected only on a chain the indexer has never run ` +
        `for, which has no stored loans to send about either. If this chain ` +
        `DOES have stored loans, the row is gone — a partial restore, a ` +
        `deletion — and those rows' freshness cannot be established until it ` +
        `is back. Unlike a failed read, this does not clear on its own.`,
    );
    return;
  }
  if (head < indexed) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: the RPC head ${head} is behind ` +
        `the indexed cursor ${indexed}, so its answers describe a past the ` +
        `stored rows have already moved beyond — nothing is confirmable this ` +
        `tick, and no reminder is sent. A lagging replica or a mis-pointed ` +
        `endpoint; the indexer flags the same condition for its own scan.`,
    );
    return;
  }

  // THE GLOBAL PAUSE IS THE FIRST GATE, AND IT IS ASKED FIRST (#2213 r22
  // `4015173439`, ordering corrected r24 `4015538614`).
  //
  // `settlePeriodicInterest` is declared `nonReentrant whenNotPaused`, and a
  // MODIFIER RUNS BEFORE THE BODY — so the pause is checked before
  // `periodicInterestEnabled` is even read. The r18 fix asked the switch and
  // stopped there, which leaves the paused-but-enabled deployment sending
  // exactly the instruction that fix exists to prevent.
  //
  // It is also the worse case of the two. A global pause is an emergency, and
  // it closes ORDINARY REPAYMENT as well — so the borrower told to pay before
  // their collateral is sold has no route at all, not even the fallback they
  // would otherwise reach for. Telling someone to act during the one window
  // where they cannot is the failure this lane must never produce.
  //
  // Pinned to the same head as everything else, and unreadable is treated as
  // paused, for the reason the config read already is: not knowing whether
  // the payment can be made is not permission to demand it.
  //
  // ASKED BEFORE THE PERIODIC SWITCH, which r22 got backwards. With the
  // switch off and the diamond ALSO paused, the periodic gate returned first
  // and the operator was told only about the switch — the milder of the two
  // states, and the one that leaves ordinary repayment open. A failed config
  // read hid the pause entirely. The contract checks the pause first because
  // `whenNotPaused` is a modifier; this lane now reports in the same order,
  // which is also what the functional spec says.
  budget.remaining -= 1; // the pause read below
  let paused: boolean;
  try {
    paused = (await client.readContract({
      address: chain.diamond as Address,
      abi: PAUSE_ABI,
      functionName: 'paused',
      blockNumber: head,
    })) as boolean;
  } catch (err) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: not pre-notifying — could not ` +
        `read whether the diamond is paused (${describeFailure(err)}). A pause ` +
        `stops settlement before the periodic switch is even consulted, so ` +
        `this is not a question the lane may skip. Nothing is stamped.`,
    );
    return;
  }
  if (paused) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: not pre-notifying — the ` +
        `diamond is PAUSED, so settlement reverts before the periodic switch ` +
        `is read, and ordinary repayment is closed too. A borrower told to ` +
        `pay now would have no route at all. Nothing is stamped; reminders ` +
        `resume when it is unpaused.`,
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
  budget.remaining -= 1; // the candidate query — D1 is a subrequest
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
  // AND IT RESUMES EXACTLY, because the stored value is a DEADLINE (#2219).
  //
  // This note used to say the resumption was approximate and that an exact one
  // "would need a key that survives reordering, which a deadline-ordered list
  // does not have". The second half was wrong: the list is sorted by
  // `(nextCheckpoint, loanId)`, and that pair IS such a key — it does not move
  // when other loans enter or leave. What the list does not have is a stable
  // POSITION, which is what was being stored.
  //
  // The cost of getting that wrong was not an approximation. Stamping the
  // nearest five and persisting 5 meant the next tick started at what was now
  // the eleventh loan, stepping over the sixth through tenth — the nearest
  // remaining deadlines. Under sustained load the lane's own
  // nearest-deadline-first guarantee ran backwards.
  const resumeKey = await scanResumeKey(env, chain.id, budget);
  const start = resumeIndex(due, resumeKey);

  let cursor = start;
  let reminded = 0;
  let unreached = 0;
  let noRoute = 0;
  let failedRails = 0;
  let refusedRails = 0;
  let transientRails = 0;
  let rejected = 0;
  let checkpointLag = 0;
  let staleCheckpoint = 0;
  let unreadable = 0;
  const pushUnconfigured = new Set<string>();
  const tgUnconfigured = new Set<string>();
  let batches = 0;
  let batchFailed = false;
  while (
    cursor < due.length &&
    // Room for this batch's read AND a loan's worth of sends: reading a batch
    // this tick cannot afford to act on spends a request for nothing.
    budget.remaining >= 1 + MAX_SUBREQUESTS_PER_LOAN + CURSOR_WRITE_RESERVE &&
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
    refusedRails += outcome.refusedRails;
    transientRails += outcome.transientRails;
    rejected += outcome.rejected;
    checkpointLag += outcome.checkpointLag;
    staleCheckpoint += outcome.staleCheckpoint;
    unreadable += outcome.unreadable;
    for (const w of outcome.pushUnconfigured) pushUnconfigured.add(w);
    for (const w of outcome.tgUnconfigured) tgUnconfigured.add(w);
    cursor += outcome.consumed;
  }

  // WHERE THE NEXT TICK PICKS UP. Written even when nothing was examined, so
  // a pass that stopped for want of allowance does not re-read the same
  // prefix next time.
  //
  // The DEADLINE of the next unexamined candidate, not its position — so a
  // loan stamped by this tick leaving the list cannot shift what the next tick
  // resumes at. A finished window stores the bottom of the order, which is how
  // the scan wraps.
  const resumeAtEnd = cursor >= due.length;
  const resumeKeyNext: ScanResume = resumeAtEnd
    ? SCAN_FROM_TOP
    : { checkpoint: due[cursor].nextCheckpoint, loanId: due[cursor].row.loan_id };
  const resumeRecorded = await saveScanResumeKey(env, chain.id, resumeKeyNext, budget);

  // WHAT THIS TICK LEFT UNDONE, and which of the two limits left it.
  const examined = cursor - start;
  // TESTS THE CURSOR, not how many rows this tick looked at (#2213 r13
  // `4013571024`). A pass that RESUMED at 300 in a 350-row window and finished
  // it examined 50 — so the old `examined < due.length` was true and the tick
  // announced a remainder it had just consumed, telling an operator the run
  // was partial when it had completed the window.
  if (!resumeAtEnd) {
    // THE SAME THRESHOLD THE LOOP TESTS (#2213 r14 `4013761165`). The loop
    // needs a batch read AND a loan's sends to continue, so a tick stopping
    // with exactly four left was halted by the allowance and reported only
    // "stopping". And it is the OUTBOUND-REQUEST allowance now, not a send
    // allowance — reads come out of the same counter since r13.
    const capped =
      budget.remaining < 1 + MAX_SUBREQUESTS_PER_LOAN + CURSOR_WRITE_RESERVE
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
        `${failedRails} rail(s) unconfirmed, ${refusedRails} refused by the ` +
        `service, ${transientRails} deferred by the service, ` +
        `${rejected} rejected by the chain, ${checkpointLag} awaiting the ` +
        `indexer, ${staleCheckpoint} with a checkpoint ahead of the chain, ` +
        `${unreadable} unreadable — ` +
        `${failed ?? capped ?? scanned ?? 'stopping'}. ` +
        `The remainder is not dropped: nothing is stamped for it, and the ` +
        `next tick ${
          resumeRecorded
            ? `RESUMES at the loan due ${resumeKeyNext.checkpoint} (loan ` +
              `${resumeKeyNext.loanId}) rather than re-reading this prefix`
            : `starts from where THIS one did, because the position could ` +
              `not be recorded (see the warning above) — so this prefix is ` +
              `re-read and the tail stays unreached until a write lands`
        }. A tick that reports the read cap with ` +
        `hundreds rejected is reporting orphaned rows, not load — whereas ` +
        `hundreds awaiting the indexer is the indexer being behind, which ` +
        `needs nothing done to the rows themselves — and anything at all ` +
        `with a checkpoint ahead of the chain needs a person, because nothing ` +
        `repairs that on its own.`,
    );
  } else if (
    noRoute + unreached + failedRails + refusedRails + transientRails + rejected +
      checkpointLag + staleCheckpoint + unreadable >
    0
  ) {
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
        `unconfirmed, ${refusedRails} refused by the service, ` +
        `${transientRails} deferred by the service, ` +
        `${rejected} rejected by the chain, ${checkpointLag} ` +
        `awaiting the indexer, ${staleCheckpoint} with a checkpoint ahead of ` +
        `the chain, ${unreadable} unreadable.`,
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
  if (pushUnconfigured.size > 0) {
    // "MISSING OR UNUSABLE", because r24 made this count both (#2213 r25
    // `4015755007`). The disclosure now fires for a key that is absent AND for
    // one that is present and malformed — which was the point of that fix —
    // while the wording still said the deployment had none. That sends an
    // operator to look for an unset binding when the value is sitting there
    // and invalid, which is the slower of the two things to discover.
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: ${pushUnconfigured.size} ` +
        `subscriber(s) this tick have a Push channel set while this ` +
        `deployment cannot send Push at all, so no Push was sent to them and ` +
        `none can be. They were reached on Telegram or not at all. Three ` +
        `things produce this and the fix differs: PUSH_CHANNEL_PK is unset, ` +
        `it is set but not a valid key, or the installed Push SDK and the ` +
        `installed ethers major disagree about how to sign (the SDK calls ` +
        `the v5 '_signTypedData', which an ethers v6 wallet does not have). ` +
        `Check the secret first, then the dependency pair — either way the ` +
        `Push channel on those subscriptions is inert.`,
    );
  }
  // THE SAME DISCLOSURE FOR THE OTHER RAIL (#2213 r22 `4015173418`). r19 fixed
  // Push and left Telegram, which is the shape this PR keeps rediscovering: a
  // rule applied to the instance that prompted it rather than to the class.
  // Without it, a subscriber with a chat id on a deployment with no bot token
  // was counted under "nobody to tell" — a statement about the USER, when the
  // truth is about the operator's configuration.
  if (tgUnconfigured.size > 0) {
    console.warn(
      `[periodicPreNotify] chain=${chain.name}: ${tgUnconfigured.size} ` +
        `subscriber(s) this tick have a Telegram chat set while this ` +
        `deployment has no TG_BOT_TOKEN, so no Telegram was sent to them and ` +
        `none can be. They were reached on Push or not at all. Set the token, ` +
        `or the Telegram route on those subscriptions is inert.`,
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
  refusedRails: number;
  transientRails: number;
  rejected: number;
  checkpointLag: number;
  staleCheckpoint: number;
  unreadable: number;
  /**
   * WHICH WALLETS, not how many occurrences (#2213 r27 `4016129208`). The
   * warning these feed says "N subscriber(s)", and a wallet that is a
   * counterparty on five loans used to be five of them — so a single
   * misconfigured subscription on a busy chain reported as a deployment-wide
   * outage. A set is the counting unit the sentence already claimed.
   */
  pushUnconfigured: Set<string>;
  tgUnconfigured: Set<string>;
}> {
  let reminded = 0;
  let unreached = 0;
  let noRoute = 0;
  let failedRails = 0;
  let refusedRails = 0;
  let transientRails = 0;
  let rejected = 0;
  let checkpointLag = 0;
  let staleCheckpoint = 0;
  let unreadable = 0;
  const pushUnconfigured = new Set<string>();
  const tgUnconfigured = new Set<string>();
  for (let i = 0; i < batch.length; i++) {
    // RESERVED, not spent. A loan may need up to four sends and must not be
    // started unless all four are available — see `MAX_SENDS_PER_LOAN` — AND
    // the scan position must still be writable afterwards, which is what
    // `CURSOR_WRITE_RESERVE` holds back (#2213 r32 `4017648029`).
    if (budget.remaining < MAX_SUBREQUESTS_PER_LOAN + CURSOR_WRITE_RESERVE) {
      return {
        consumed: i, reminded, unreached, noRoute, failedRails,
        rejected, checkpointLag, staleCheckpoint, unreadable,
        refusedRails, transientRails, pushUnconfigured, tgUnconfigured,
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
    const verdict = periodicInterestEligibility(
      detail,
      nextCheckpoint,
      row.periodic_interest_cadence,
    );
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
      const explained = explainVerdict(
        verdict,
        detail,
        nextCheckpoint,
        row.periodic_interest_cadence,
      );
      console.warn(
        `[periodicPreNotify] chain=${chain.name} loan=${row.loan_id}: ` +
          `${explained.text} — no reminder sent. Nothing is stamped, so a ` +
          `later tick reconsiders.`,
      );
      if (explained.bucket === 'checkpoint-lag') checkpointLag += 1;
      else if (explained.bucket === 'stale-checkpoint') staleCheckpoint += 1;
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
    refusedRails += borrowerOutcome.refusedRails + lenderOutcome.refusedRails;
    transientRails += borrowerOutcome.transientRails + lenderOutcome.transientRails;
    // KEYED ON THE WALLET so the same subscription seen on a second loan is
    // the same subscriber, lowercased because the stored rows are and an
    // address that differs only in case is one wallet.
    if (borrowerOutcome.pushUnconfigured) pushUnconfigured.add(row.borrower.toLowerCase());
    if (lenderOutcome.pushUnconfigured) pushUnconfigured.add(row.lender.toLowerCase());
    if (borrowerOutcome.tgUnconfigured) tgUnconfigured.add(row.borrower.toLowerCase());
    if (lenderOutcome.tgUnconfigured) tgUnconfigured.add(row.lender.toLowerCase());

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
    // THE GATE, AS THREE QUESTIONS ABOUT THE LOAN (#2213 r28 — the root fix).
    // See `stampDecision` for why this is no longer a predicate over a
    // per-party label, and for the four findings that produced it.
    if (!stampDecision(borrowerOutcome, lenderOutcome).stamp) continue;
    budget.remaining -= 1; // the checkpoint stamp — D1 is a subrequest
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
    refusedRails,
    transientRails,
    rejected,
    checkpointLag,
    staleCheckpoint,
    unreadable,
    pushUnconfigured,
    tgUnconfigured,
  };
}

/** The `indexer_cursor` row the indexer advances for its own chain scan. */
const INDEXER_SCAN_KIND = 'diamond';

// The scan position USED to live in `indexer_cursor` under the kind
// 'prenotify_scan', as an index into the candidate list — chosen so it needed
// no migration and so it could not walk into the deploy-window hazard #2214
// describes. That reasoning was sound about the cost and wrong about the
// value: an index into a list rebuilt every tick does not point where it did
// (#2219). It now lives in `prenotify_scan_cursor` as the deadline to resume
// at, which migration 0050 creates and whose old row that migration deletes.
// The rotation position below is genuinely a small integer and stays where it
// is.

/** The row carrying which chain leads the next invocation. */
const PRENOTIFY_ROTATION_KIND = 'prenotify_rotation';

/**
 * The rotation row, stored against chain id 0 — not a chain, so it cannot
 * collide with a real one, and the `(chain_id, kind)` key keeps it distinct
 * from every per-chain row.
 */
const ROTATION_ROW_CHAIN_ID = 0;

/** Which chain leads this invocation. Absent or unreadable → the first one. */
async function rotationStart(env: Env, chainCount: number, budget: TickBudget): Promise<number> {
  if (chainCount <= 1) return 0;
  budget.remaining -= 1; // D1 is a subrequest (#2213 r27 `4016129218`)
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
async function saveRotationStart(env: Env, next: number, budget: TickBudget): Promise<void> {
  await persistRotationCursor(env, ROTATION_ROW_CHAIN_ID, next, budget);
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
/**
 * The two positions this lane keeps — named by what they MEAN, not by where
 * they are stored (#2219). They now live in different tables, and a union over
 * storage keys would have stopped describing them the moment one moved.
 */
type PrenotifyCursorKind = 'scan' | 'rotation';

/**
 * What a failed write of THIS cursor costs, in the terms its own reader uses.
 *
 * Found by auditing this file's operator-facing lines against the evidence
 * each one actually has (#2213, self-review after r20). One shared message
 * served both callers and was wrong for the rotation one twice over.
 *
 * It named `chain ${chainId}`, and the rotation row's id is
 * `ROTATION_ROW_CHAIN_ID` — a SENTINEL, chosen a few lines above precisely
 * because it "cannot collide with a real one". So the line told an operator
 * to go and look at chain 0, which does not exist.
 *
 * And it asserted the SCAN's consequence — loans behind a run of unreachable
 * ones stop being reached — for a failure whose actual fallout is the one
 * `rotationStart`'s own catch describes: the same chain leads every tick and
 * the later ones can be starved of the shared allowance. Different failure,
 * different remedy, one sentence claiming the first for both.
 *
 * A union rather than a `string`, so the switch is exhaustive and a third
 * cursor kind cannot inherit either description by default — the same reason
 * `explainVerdict` returns its bucket alongside its wording.
 */
function describeCursorLoss(kind: PrenotifyCursorKind, chainId: number): {
  subject: string;
  consequence: string;
} {
  switch (kind) {
    case 'rotation':
      return {
        subject: 'the chain rotation position',
        consequence:
          'The next tick therefore leads with the same chain this one did ' +
          'rather than the next — so if this keeps appearing, one busy chain ' +
          'holds the shared allowance and the chains behind it may not be ' +
          'reached at all.',
      };
    case 'scan':
      return {
        subject: `the scan position for chain ${chainId}`,
        consequence:
          'The next tick therefore starts from where this one did rather ' +
          'than from where it stopped — so if this keeps appearing, loans ' +
          'behind a run of unreachable ones stop being reached, and that is ' +
          'the fairness guarantee degrading, not a wasted read.',
      };
  }
}

/**
 * Writes the ROTATION row — the only position still kept in `indexer_cursor`,
 * since the scan's moved to its own table in #2219.
 *
 * It takes no `kind` any more. It briefly did, typed by the LOGICAL kind that
 * `describeCursorLoss` switches on, and bound that value straight into the
 * storage column — writing `rotation` where the reader a few lines above looks
 * for `prenotify_rotation`, which would have left the rotation permanently at
 * its default while reporting success. One caller, one row, one literal.
 */
async function persistRotationCursor(
  env: Env,
  chainId: number,
  at: number,
  budget: TickBudget,
): Promise<boolean> {
  budget.remaining -= 1; // D1 is a subrequest (#2213 r27 `4016129218`)
  try {
    await env.DB.prepare(
      `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, kind) DO UPDATE SET
         last_block = excluded.last_block,
         updated_at = excluded.updated_at`,
    )
      .bind(chainId, PRENOTIFY_ROTATION_KIND, at, Math.floor(Date.now() / 1000))
      .run();
    return true;
  } catch (err) {
    const { subject, consequence } = describeCursorLoss('rotation', chainId);
    console.warn(
      `[periodicPreNotify] could not persist ${subject} at ${at}: ` +
        `${describeFailure(err)}. ${consequence}`,
    );
    // REPORTED, not swallowed (#2213 r25 `4015755019`). The caller's summary
    // tells an operator where the next tick resumes, and that sentence is only
    // true if this landed. Returning void let the summary promise a resume the
    // database had just refused — contradicting the warning printed one line
    // above it.
    return false;
  }
}

/**
 * Record the DEADLINE to resume at (#2219).
 *
 * Its own table rather than the shared cursor row, because the value is a pair
 * and a pair does not fit an integer column honestly. Packing both into one
 * number would have avoided a migration and left a figure nobody can read; an
 * operator looking at this table sees a deadline and a loan.
 *
 * ONE ROW, ONE WRITE. The pair has to move together — a checkpoint stored
 * without its tiebreak, or the two written separately and one failing, is a
 * cursor that points between two loans.
 *
 * @returns whether the position actually landed — the summary depends on it.
 */
async function saveScanResumeKey(
  env: Env,
  chainId: number,
  key: ScanResume,
  budget: TickBudget,
): Promise<boolean> {
  budget.remaining -= 1; // D1 is a subrequest (#2213 r27 `4016129218`)
  try {
    await env.DB.prepare(
      `INSERT INTO prenotify_scan_cursor (chain_id, next_checkpoint, loan_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id) DO UPDATE SET
         next_checkpoint = excluded.next_checkpoint,
         loan_id = excluded.loan_id,
         updated_at = excluded.updated_at`,
    )
      .bind(chainId, key.checkpoint, key.loanId, Math.floor(Date.now() / 1000))
      .run();
    return true;
  } catch (err) {
    const { subject, consequence } = describeCursorLoss('scan', chainId);
    console.warn(
      `[periodicPreNotify] could not persist ${subject} at deadline ` +
        `${key.checkpoint} (loan ${key.loanId}): ${describeFailure(err)}. ` +
        `${consequence}`,
    );
    // REPORTED, not swallowed (#2213 r25 `4015755019`). The caller's summary
    // tells an operator where the next tick resumes, and that sentence is only
    // true if this landed. Returning void let the summary promise a resume the
    // database had just refused — contradicting the warning printed one line
    // above it.
    return false;
  }
}


/**
 * WHERE THIS CHAIN'S SCAN RESUMES — a DEADLINE, not a list position (#2219).
 *
 * The position used to be an index into the candidate list. That list is
 * rebuilt every tick and a loan stamped last tick is no longer in it, so the
 * index did not point where it did: stamp the nearest five, persist 5, and
 * next tick position 5 is the ELEVENTH original loan — the sixth through
 * tenth, the NEAREST remaining deadlines, stepped over. Under sustained load
 * that inverts the nearest-deadline-first guarantee this lane states, which is
 * the whole of #2219.
 *
 * A deadline survives insertion and removal; a position does not. So the
 * cursor is the ordering key itself — the same `(nextCheckpoint, loanId)` pair
 * `candidatesInWindow` sorts by — and resuming means "the first candidate at
 * or after this", which is well defined however the list has changed.
 *
 * ABSENT OR UNREADABLE RESUMES AT THE TOP, and the direction of that failure
 * is the point: starting at the nearest deadline re-reads a prefix, it never
 * steps over one.
 *
 * THAT IS A PROPERTY OF ONE TICK, never an absolute. A read that fails on
 * EVERY tick is a different thing entirely: each tick reprocesses the same
 * allowance-filling prefix, the scan never advances, and loans in the tail can
 * pass their deadline. Duplicated work is the cost of one failed read; a
 * persistent one costs reminders, which is precisely why both non-throwing
 * paths below announce themselves rather than absorbing it.
 *
 * The full statement lives ONCE, in `docs/FunctionalSpecs/
 * Alpha02ConnectedApp.md` under "THE RESTART PROPERTY", and is not restated
 * here or in the migration, the restore runbook or the release note. Four
 * consecutive review rounds each caught this property overstated in a
 * different surface, every one of them written by re-deriving it locally
 * instead of pointing at it (#2229 r1-r4).
 */
interface ScanResume {
  checkpoint: number;
  loanId: number;
}

/** Before every real deadline, so it resumes at the nearest one. */
const SCAN_FROM_TOP: ScanResume = { checkpoint: 0, loanId: 0 };

/**
 * One rule for both halves of the key, so they cannot drift apart.
 *
 * `Number.isSafeInteger` covers whole, exact and within the range where
 * integer comparison means what it says; the sign check covers the rest,
 * since neither a unix second nor a loan id is negative and a negative key
 * would sort before every candidate and silently disable the resume.
 */
function isCursorNumber(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

async function scanResumeKey(
  env: Env,
  chainId: number,
  budget: TickBudget,
): Promise<ScanResume> {
  budget.remaining -= 1; // D1 is a subrequest (#2213 r27 `4016129218`)
  try {
    const row = await env.DB.prepare(
      `SELECT next_checkpoint, loan_id FROM prenotify_scan_cursor WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ next_checkpoint: number; loan_id: number }>();
    // SAID, BOTH WAYS (#2229 r1 `4034434474`). A cursor that is gone and a
    // cursor that is unreadable have the same consequence — the lane re-reads
    // a prefix — and this file's own promise is that an unavailable position
    // is announced rather than absorbed. Returning quietly on the two
    // non-throwing paths would have made that promise true only of the
    // throwing one, and a row being deleted or corrupted repeatedly is
    // exactly the case an operator would never hear about.
    //
    // A chain that has genuinely never been scanned has no position to be
    // missing, so that first tick is not reported as a loss: it is the same
    // absent row, and the sentence says which it is.
    if (!row) {
      console.warn(
        `[periodicPreNotify] chain ${chainId}: no stored scan position; ` +
          `starting from the nearest deadline. Expected once for a chain this ` +
          `lane has not scanned before, and after a restore clears the row — ` +
          `repeated appearances otherwise mean the position is not being kept.`,
      );
      return SCAN_FROM_TOP;
    }
    const checkpoint = Number(row.next_checkpoint);
    const loanId = Number(row.loan_id);
    // A WHOLE, NON-NEGATIVE, EXACTLY-REPRESENTABLE pair, or it is not a
    // position (#2229 r2 `4034537653`). Finiteness alone was not enough: an
    // ordinary SQLite column accepts a REAL, and `(deadline, 7.5)` is finite
    // and sorts between loan 7 and loan 8 — so the scan would resume just past
    // loan 7 and step over it, silently, which is the defect this cursor
    // exists to remove. The table is STRICT so this should be unreachable
    // through the migration; a restored or hand-made table is why it is
    // checked here too.
    if (!isCursorNumber(checkpoint) || !isCursorNumber(loanId)) {
      console.warn(
        `[periodicPreNotify] chain ${chainId}: the stored scan position is ` +
          `not a pair of whole numbers (${String(row.next_checkpoint)}, ` +
          `${String(row.loan_id)}); starting from the nearest deadline. THIS ` +
          `tick re-reads a prefix rather than skipping one, but the position ` +
          `is not being kept: until it is, the tail is not reached and loans ` +
          `in it can pass their deadline.`,
      );
      return SCAN_FROM_TOP;
    }
    return { checkpoint, loanId };
  } catch (err) {
    // A failure here is safe to absorb — nothing is decided on this value
    // except where to start looking, so the worst case is a repeated prefix
    // rather than a wrong message. It is NOT safe to absorb silently: a
    // repeated prefix IS the starvation this persistence removed.
    //
    // This is also what a deploy landing ahead of its migration looks like
    // (#2214): the table is absent, every tick says so, and the lane keeps
    // working from the nearest deadline until the migration lands.
    console.warn(
      `[periodicPreNotify] chain ${chainId}: could not read the stored scan ` +
        `position (${describeFailure(err)}); starting from the nearest ` +
        `deadline. THIS tick re-reads a prefix rather than skipping one. If ` +
        `this keeps appearing the position is not being kept at all, and a ` +
        `prefix that fills a tick then holds the allowance every tick — the ` +
        `tail is not reached, and loans in it can pass their deadline.`,
    );
    return SCAN_FROM_TOP;
  }
}

/**
 * The index to resume at: the first candidate AT OR AFTER the stored key.
 *
 * "At or after" rather than "after", because the key names the next
 * UNEXAMINED candidate rather than the last examined one. If that exact loan
 * is still in the list it is the one to start with; if it has been stamped,
 * settled or has passed its deadline, the next one along is — which is what
 * makes this stable under removal, and what a position could never be.
 *
 * No match means every remaining deadline is nearer than the stored one: the
 * window has moved past where this chain stopped, so the scan wraps to the
 * front rather than doing nothing.
 */
function resumeIndex(due: DueLoan[], key: ScanResume): number {
  const at = due.findIndex(
    (c) =>
      c.nextCheckpoint > key.checkpoint ||
      (c.nextCheckpoint === key.checkpoint && c.row.loan_id >= key.loanId),
  );
  return at === -1 ? 0 : at;
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
async function indexedThrough(
  env: Env,
  chainId: number,
  budget: TickBudget,
): Promise<bigint | 'absent' | 'unknown'> {
  budget.remaining -= 1; // D1 is a subrequest (#2213 r27 `4016129218`)
  try {
    const row = await env.DB.prepare(
      `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
    )
      .bind(chainId, INDEXER_SCAN_KIND)
      .first<{ last_block: number }>();
    // A MISSING ROW IS NOT A FRESH DATABASE (#2213 r29 `4016866279`). `null`
    // used to mean "no cursor, so there is nothing to be behind", and the
    // caller went on to send. That reading is only safe where the absence
    // explains itself — a chain the indexer has never run for has no stored
    // loans either, so nothing would be sent regardless.
    //
    // Where it does NOT explain itself the answer is the opposite: a partial
    // restore, a deleted cursor row, corruption. Stored loans then exist
    // whose freshness cannot be established, and a lagging RPC will happily
    // report one of them active at an older head — which is exactly the send
    // this comparison exists to stop. There is no way to tell the two apart
    // from here without another read, and the cheap reading is the unsafe
    // one.
    //
    // So a missing row now DEFERS, exactly as an unreadable one does. It is
    // still reported as its own value rather than folded into `'unknown'`:
    // r12 `4013387361` established that these two must not collapse, and that
    // finding is about what the OPERATOR is told, which is unchanged. A
    // database hiccup clears on its own; a cursor row that is gone while
    // loans remain needs a person. They agree on the action and differ on the
    // diagnosis, so the value carries both.
    //
    // The cost where the absence was innocent is that a chain the indexer has
    // not yet reached stays quiet for a tick or two — on a window measured in
    // days, and with nothing worth sending on such a chain anyway.
    return row ? BigInt(row.last_block) : 'absent';
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
  storedCadence: number,
): { text: string; bucket: 'rejected' | 'checkpoint-lag' | 'stale-checkpoint' } {
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
    case 'chain-ahead':
      return {
        text:
          `the stored row still points at the checkpoint ${expected}, and the ` +
          `chain has settled PAST it (last period at ` +
          `${Number(detail.lastPeriodicInterestSettledAt)}) — most likely a ` +
          `payment the indexer has not caught up with`,
        // NOT a rejection. The chain knows this loan and is happy with it; our
        // copy is a few blocks behind and heals itself on the next indexer
        // pass. Filing it with the ghost rows would send an operator to repair
        // something that is already correct.
        bucket: 'checkpoint-lag',
      };
    case 'cadence-mismatch':
      return {
        text:
          `the stored row was read with cadence ${Number(storedCadence)} and ` +
          `the chain reports cadence ` +
          `${Number(detail.periodicInterestCadence)} — the two disagree about ` +
          `how long this loan's period is, so the date this reminder would ` +
          `name comes from the wrong interval and the message would be ` +
          `labelled with a cadence the chain does not have. The dates can ` +
          `still coincide, which is why matching them proves nothing here`,
        // A STORED ROW THAT IS WRONG, like the ghosts — not a timing artefact
        // and not something that heals. The chain is authoritative on cadence
        // (it is snapshotted at init and immutable), so a disagreement means
        // our copy needs correcting.
        bucket: 'rejected',
      };
    case 'row-ahead':
      return {
        text:
          `the stored row points at the checkpoint ${expected}, which is ` +
          `AHEAD of the chain (last period at ` +
          `${Number(detail.lastPeriodicInterestSettledAt)}) — a settlement ` +
          `indexed and then reorged out, or a corrupted row. The active-loan ` +
          `reconciliation does not repair a checkpoint, so this does not heal ` +
          `on its own and this loan's reminders stay suppressed until someone ` +
          `corrects the row`,
        // ITS OWN BUCKET (#2213 r21 `4015014110`). Filing it under lag told an
        // operator to wait for a condition that never resolves, and filing it
        // under "rejected by the chain" would be wrong too — the chain has no
        // quarrel with this loan, our copy of one field is wrong.
        bucket: 'stale-checkpoint',
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
 * Whether this checkpoint may be marked finished, decided for the LOAN.
 *
 * THE ROOT FIX FOR A SEAM THAT PRODUCED FOUR FINDINGS IN THREE ROUNDS (#2213
 * r26 `4015927527`, r27 `4016129201`, r28 `4016565753` + `4016565763`). Each
 * of those was a different combination of the two parties' outcomes, each was
 * patched where it was found, and the next round produced the next
 * combination. The cause was structural rather than arithmetic: the decision
 * was assembled from boolean algebra over a per-party `status` word, and one
 * word cannot carry two parties' worth of partial knowledge. So the word is
 * gone and the rule is stated once, here, in terms of what the stamp MEANS.
 *
 * The stamp means "finished — never revisit this checkpoint". That is
 * justified exactly when no later tick could do better for anybody, which is
 * three questions and not a taxonomy:
 *
 * - **Was anyone actually reached?** Then coming back would tell them about
 *   the same payment twice. The stamp is per loan and there is no per-party
 *   de-dup (that needs a schema change, out of proportion for a courtesy
 *   reminder), so one confirmed delivery settles the loan.
 * - **Is anything UNCERTAIN?** A rail that issued a request and got no answer
 *   may have delivered. Retrying it risks the same duplicate, and the honest
 *   position is that we do not know — so an unknown blocks the retry exactly
 *   as a delivery does. This is `4016565763`: a Push of unknown fate beside a
 *   rate-limited Telegram was being called a clean deferral and retried.
 * - **Is anyone OWED another attempt?** Three things earn one: a service that
 *   said "not now"; a subscriber who has switched the reminder off and may
 *   switch it back on before the deadline; and a subscriber who ASKED for a
 *   rail this deployment cannot currently use, which an operator may repair
 *   inside the window. All three are states that can change and then make
 *   delivery possible, which is the whole test. A refusal does not qualify —
 *   it will fail identically until a person acts on that credential, and
 *   repeating it buys nobody a reminder. Having no rail at all, and having no
 *   subscription, do not either: nothing about those changes on its own.
 *
 *   The third arrived in r30 (`4017166970`) as a consequence of r29's own
 *   fix. Reporting an unusable Push rail as `not-requested` — correct, it
 *   issued nothing — left a Push-ONLY subscriber with no delivery, no
 *   uncertainty, no opt-out and no deferral, so nothing marked them as owed
 *   and the checkpoint stamped. Repairing the secret or the dependency
 *   mid-window then could not deliver a reminder that was already written
 *   off. That is the exact failure the spec names: marking a record as
 *   handled while delivering nothing.
 *
 * Stamp unless somebody is owed, nobody was reached, and nothing is
 * uncertain.
 *
 * **Being owed is not cancelled by the OTHER party having nothing to offer**,
 * which is `4016565753` and the P1 of the four. The old gate treated "no
 * usable rail" as handled, so a deferred borrower stopped being retryable the
 * moment their lender turned out to have no channel — the lender's absence
 * silently spending the borrower's retry. Only a real delivery or a real
 * uncertainty may do that, because only those two can duplicate a message.
 */
function stampDecision(
  borrower: DeliveryOutcome,
  lender: DeliveryOutcome,
): { stamp: boolean; reached: boolean; uncertain: boolean; owed: boolean } {
  const reached = borrower.delivered || lender.delivered;
  const uncertain = borrower.unconfirmedRails > 0 || lender.unconfirmedRails > 0;
  const owedBy = (o: DeliveryOutcome) =>
    o.optedOut || o.transientRails > 0 || o.pushUnconfigured || o.tgUnconfigured;
  const owed = owedBy(borrower) || owedBy(lender);
  return { stamp: !(owed && !reached && !uncertain), reached, uncertain, owed };
}

/**
 * What happened for one counterparty — FACTS, not a verdict.
 *
 * THERE USED TO BE A `status` LABEL HERE, and removing it is the #2213 r28
 * root fix. It ranged over `sent | deferred | no-route | opted-out | none`,
 * and nothing but the stamp gate ever read it: every operator count is
 * derived from `delivered` / `attempted` / the rail tallies below. So its
 * whole job was to compress this record into one word for one decision — and
 * three consecutive review rounds each found a different combination the
 * compression had lost.
 *
 * r26 `4015927527` found that a rate limit was filed as a refusal. r27
 * `4016129201` found that a deferral still stamped. r28 found two more in one
 * round: a deferral stamped anyway when the OTHER party merely had no route
 * (`4016565753`), and a mixed unknown-plus-deferred attempt was called a
 * deferral although the unknown one may have delivered (`4016565763`). Four
 * findings, one cause — a label cannot carry two parties' worth of partial
 * knowledge, and each patch fixed the combination in front of it while
 * leaving the next one standing.
 *
 * The gate reads these fields directly now. See `stampDecision`.
 *
 * `attempted` is whether any rail issued a request — what the allowance was
 * charged for. `delivered` is whether a rail was CONFIRMED accepted, and it is
 * the only thing that may be reported as a reminder (#2213 r10 `4013087415`).
 * They genuinely disagree: a Telegram 401 and a Push SDK throw are both
 * attempted and neither delivered, and collapsing them let a run tell an
 * operator it had reminded people it had not reached.
 */
interface DeliveryOutcome {
  /**
   * They switched these reminders off (#1033).
   *
   * A FACT about the subscriber, and the reason it survives the label's
   * removal: it is the one thing the numeric fields below cannot express —
   * an opt-out and an absent subscription both attempt nothing, deliver
   * nothing and fail no rails, yet only the first earns another tick,
   * because they may switch the reminder back on before the deadline.
   */
  optedOut: boolean;
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
   * Rails the service ANSWERED and refused — a rotated token, a stale chat.
   *
   * Apart from `unconfirmedRails` because the two need opposite responses
   * (#2213 r24 `4015538638`): a refusal is a credential or a target to fix and
   * will keep failing until someone does; an unknown fate may be a passing
   * incident. Only Telegram can tell them apart today — see where this is
   * populated — and the summary says so rather than implying Push has none.
   */
  refusedRails: number;
  /**
   * Rails the service DEFERRED — 429 or 5xx.
   *
   * Apart from `refusedRails` because that bucket's stated meaning is "will
   * keep failing until someone repairs it" (#2213 r26 `4015927527`), and a
   * rate limit repairs itself. Reported apart from `unconfirmedRails` too,
   * even though neither needs an operator, because a deferral definitely did
   * NOT deliver where an unconfirmed attempt may have.
   */
  transientRails: number;
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
  /**
   * The subscriber asked for Telegram and the DEPLOYMENT has no bot token.
   *
   * The exact mirror of `pushUnconfigured`, and it is here because r19 fixed
   * ONE rail (#2213 r22 `4015173418`). The Telegram route collapses to `null`
   * on a missing `TG_BOT_TOKEN` in the same expression that checks the
   * subscriber's chat id, so a deployment misconfiguration read as "this
   * person has no route" — and if Push was also unavailable the loan was
   * stamped as handled and reported under "nobody to tell", which is a
   * statement about the USER when the truth is about the operator.
   */
  tgUnconfigured: boolean;
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
    budget.remaining -= 1; // the subscriber lookup — D1 is a subrequest
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
    budget.remaining -= 1; // the legacy fallback lookup — also a subrequest
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
      optedOut: false, attempted: false, delivered: false,
      unconfirmedRails: 0, refusedRails: 0, transientRails: 0,
      pushUnconfigured: false, tgUnconfigured: false,
    };
  }
  // #1033 — the connected app Alerts card exposes this as a real opt-out;
  // honor it before any rail fires. Reported distinctly so the
  // caller can leave the checkpoint unstamped (a re-enable before
  // the deadline must still get its reminder).
  if (sub.notify_maturity_approaching === 0) {
    return {
      optedOut: true, attempted: false, delivered: false,
      unconfirmedRails: 0, refusedRails: 0, transientRails: 0,
      pushUnconfigured: false, tgUnconfigured: false,
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
  /** Rails the service ANSWERED and refused — a credential or target to fix. */
  let refusedRails = 0;
  /** Rails the service deferred — 429 or 5xx. Clears without anyone acting. */
  let transientRails = 0;
  // WHETHER THE PUSH RAIL IS USABLE AT ALL, answered by the sender rather than
  // by inspecting the env (#2213 r23 `4015375741`). See where this is returned.
  let pushSignerUnusable = false;
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
      } else {
        // A SIGNER THAT IS PRESENT AND UNUSABLE. `sendPush` builds the signer
        // before it sends, so a malformed key returns here having issued
        // nothing — and it does so for EVERY push on that deployment, which
        // makes this strictly worse than an unset key while looking
        // configured (#2213 r23 `4015375741`).
        pushSignerUnusable = true;
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
      // THREE OUTCOMES, KEPT APART (#2213 r24 `4015538638`). Charged either
      // way — a request went out — but a service that ANSWERED and said no is
      // a different operator problem from one that never answered: a rotated
      // token or a stale chat needs a credential fixed, a transport failure
      // needs an incident checked. The release note promised these were
      // counted separately and the code was folding both into one bucket.
      const tg = await sendMessage(tgRoute.token, tgRoute.chat, `${title}\n${body}\n${deepLink}`);
      if (tg === 'accepted') delivered = true;
      else if (tg === 'refused') refusedRails += 1;
      // `transient` joins the unconfirmed bucket deliberately (#2213 r26
      // `4015927527`). What it must NOT join is `refused`, whose stated
      // meaning is "keeps failing until someone repairs it" — a rate limit
      // repaired by waiting would send an operator to rotate a credential
      // during an incident. Grouped with unconfirmed because the action is
      // the same there (nothing to do; it retries), and the summary names it
      // apart so the difference is still legible.
      else if (tg === 'transient') transientRails += 1;
      else unconfirmedRails += 1;
    } catch (err) {
      // `sendMessage` swallows its own failures, so reaching here is a throw
      // it did not expect — nothing is known about the message's fate.
      unconfirmedRails += 1;
      console.error(
        `[periodicPreNotify] tg failed loan=${loan.loan_id} wallet=${wallet} ` +
          `err=${describeFailure(err)}`,
      );
    }
  }
  // NO VERDICT IS COMPUTED HERE ANY MORE (#2213 r28). This used to end in a
  // `status` word — `deferred` when every rail that answered said "not now",
  // `sent` when anything was attempted, `no-route` otherwise — and that line
  // was wrong twice in four rounds for the same structural reason: it decided
  // one party's fate without the other party's facts, and the stamp is a
  // per-LOAN decision. `stampDecision` now asks the three questions that
  // actually bear on it, over both parties at once.
  //
  // What the deleted `deferred` branch missed, kept here because it names the
  // trap: it ignored `unconfirmedRails`, so a Push whose fate is unknown
  // alongside a Telegram rate limit was reported as a clean deferral and
  // retried — although the unknown one may already have arrived
  // (`4016565763`).
  return {
    optedOut: false,
    attempted,
    delivered,
    unconfirmedRails,
    refusedRails,
    transientRails,
    // The subscriber WANTED push (they have a channel) and the deployment
    // cannot sign for it. Distinct from "no channel": that is the user's
    // choice, this is the operator's configuration.
    // DERIVED FROM WHAT THE SENDER DID, not from the env being falsy (#2213
    // r23 `4015375741`). The truthiness test saw a non-empty key and called
    // the rail configured, so a MALFORMED `PUSH_CHANNEL_PK` — which fails
    // every push while looking set — fell into the user-routing bucket and was
    // reported as "nobody to tell". The deployment-level disclosure exists
    // precisely for that case; sending it to the user bucket is the same
    // misattribution r19 and r22 removed, arriving through the one door left.
    pushUnconfigured: Boolean(sub.push_channel) && (!env.PUSH_CHANNEL_PK || pushSignerUnusable),
    tgUnconfigured: Boolean(sub.tg_chat_id) && !env.TG_BOT_TOKEN,
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
