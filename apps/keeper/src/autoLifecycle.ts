/**
 * apps/keeper — T-092 auto-lifecycle pass (#512).
 *
 * Per cron tick, per chain with `AdminFacet.getAutoExtendEnabled() ==
 * true`, walks active loans looking for both-side-consented auto-
 * extend candidates and submits `extendLoanInPlace`. The on-chain
 * contract enforces every safety guard (caps, staleness, grace
 * window, sub-day floor, sanctions); this pass is a thin discovery +
 * fire layer.
 *
 *   1. `AdminFacet.getAutoExtendEnabled` — admin kill switch. Skip
 *      the chain entirely when false; users' consent storage stays
 *      in place but no executor calls are made.
 *
 *   2. `getActiveLoansCount` (O(1)); short-circuit when zero.
 *
 *   3. Page `getActiveLoansPaginated` for the loan ids.
 *
 *   4. For each loanId, read both
 *      `AutoLifecycleFacet.getAutoExtendBorrowerCaps(loanId)` AND
 *      `getAutoExtendLenderCaps(loanId)`. The getters self-apply the
 *      staleness fence (post-NFT-transfer the cap returns
 *      `enabled: false`), so we only need to check the post-fence
 *      `enabled` flag.
 *
 *   5. When both sides are enabled + fresh, pick `newRateBps` at the
 *      lender's floor (most conservative for the borrower) and
 *      `newDurationDays` to fit inside `min(borrower.maxNewExpiry,
 *      lender.maxNewExpiry)`, capped at 30 days per extension so the
 *      borrower's consent doesn't roll forward indefinitely without
 *      a re-affirmation. Submit `extendLoanInPlace`.
 *
 *   6. Only inside the extension window (#2738): from three days before
 *      the loan's EFFECTIVE due date (the pause-adjusted loan clock) to
 *      the end of its grace, and only when the proposed term does not
 *      make the loan defaultable sooner — its new due date plus the new
 *      term's grace must not be earlier than the old due date plus the
 *      old grace. A shorter term lands in a smaller grace bucket, so
 *      "the end moves later" alone does not hold that. An unread clock
 *      (pause log or grace buckets) skips the chain for the run rather
 *      than deciding against a date the chain may not hold the loan to.
 *      The contract does not yet check either rule; when it publishes
 *      the window (`getAutoExtendWindow`) this pass reads it instead of
 *      holding its own copy.
 *
 *   7. Soft per-tick cap so one rogue chain can't burn the keeper's
 *      gas budget.
 *
 * Auto-refinance is NOT in this v1 pass — it requires running the
 * matcher against refinance-tagged offers + driving the create →
 * accept → refinanceLoan triplet, and the existing `runMatcher`
 * already exercises the matchOffers half of that loop. A future
 * follow-up will compose the two; until then auto-refinance happens
 * via the existing matcher path when a borrower has posted a
 * refinance-tagged offer and a compatible lender offer exists.
 *
 * Gating: the keeper-level gate only (no pass flag of its own) — same as the
 * matcher / liquidator. Goes through `passIsArmed`, so the skip line now names
 * which of `KEEPER_ENABLED` / `KEEPER_PRIVATE_KEY` stopped it instead of the
 * older ambiguous "keeper disabled" (#1475).
 */

import {
  createPublicClient,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import {
  AdminFacetABI,
  AutoLifecycleFacetABI,
  DIAMOND_ABI_VIEM,
  LoanFacetABI,
  MetricsFacetABI,
} from '@vaipakam/contracts/abis';
import {
  graceSecondsFromBuckets,
  loanDeadlines,
  readPauseLog,
  type GraceBucket,
  type PauseLog,
} from '@vaipakam/lib/loanClock';
import type { ChainConfig, Env } from './env';
import type { PassTick } from './passSchedule';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { reportSendError } from './submissionQueue';
import { runIndex } from './runWindow';
import { pagedWalk } from './rotate';
import { redactedError } from '@vaipakam/lib/errorDescription';

const ADMIN_ABI: Abi = AdminFacetABI as Abi;
const AUTO_LIFECYCLE_ABI: Abi = AutoLifecycleFacetABI as Abi;
const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const LOAN_ABI: Abi = LoanFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** Soft per-tick / per-chain cap. Five auto-extends per tick gives
 *  the keeper a predictable upper bound on gas spend; the rest are
 *  picked up next tick (loans don't lose their consent state by
 *  waiting). */
const MAX_EXTENDS_PER_TICK = 5;

/** Default per-extension window in days. The contract enforces
 *  `newDurationDays <= cfgMaxOfferDurationDays()` (typically 365) and
 *  the per-side `maxNewExpiry` caps. We use a much smaller default
 *  here so a single keeper-fired extension doesn't roll the
 *  borrower's loan term forward by a year on caps that allow it —
 *  forces the borrower to re-affirm consent periodically. */
const DEFAULT_EXTEND_DAYS = 30n;

const SECONDS_PER_DAY = 86_400n;

/** #2738 — how long before a loan's effective due date the window to extend
 *  it opens. The window closes at the end of the loan's grace, which the
 *  contract already enforces (`ExtensionGraceExpired`). The value is the one
 *  the contract half of #2738 will enforce and publish. */
export const EXTEND_WINDOW_SECONDS = 3n * SECONDS_PER_DAY;

/** What the extension window needs to know about the chain, read once per
 *  chain per run: the pause record behind the loan clock, and the grace
 *  buckets that size each term's grace. */
export interface ExtendClock {
  pauseLog: PauseLog;
  graceBuckets: readonly GraceBucket[];
}

/**
 * Whether an extension of `loan` to `newDurationDays` from `now` is inside
 * the window and keeps the loan's grace-inclusive deadline (#2738); null when
 * it is, otherwise the reason it is not. The new term starts at `now`, as
 * `extendLoanInPlace` restarts it, so it carries no pause credit yet.
 */
export function extendWindowVerdict(
  loan: { startTime: bigint; durationDays: bigint },
  newDurationDays: bigint,
  clock: ExtendClock,
  now: bigint,
): string | null {
  const old = loanDeadlines(
    loan,
    graceSecondsFromBuckets(clock.graceBuckets, loan.durationDays),
    clock.pauseLog,
    now,
  );
  const opensAt = old.maturity - EXTEND_WINDOW_SECONDS;
  if (now < opensAt) return `window opens at ${opensAt} (due ${old.maturity})`;
  if (now > old.graceEnd) return `past grace (ended ${old.graceEnd})`;
  const newMaturity = now + newDurationDays * SECONDS_PER_DAY;
  if (newMaturity <= old.maturity) return `a ${newDurationDays}-day term would not move the due date ${old.maturity} later`;
  const newGraceEnd = newMaturity + graceSecondsFromBuckets(clock.graceBuckets, newDurationDays);
  if (newGraceEnd < old.graceEnd) {
    return `a ${newDurationDays}-day term would make the loan defaultable sooner (grace end ${newGraceEnd} < ${old.graceEnd})`;
  }
  return null;
}

interface ExtendCaps {
  enabled: boolean;
  minRateBps: bigint;
  maxRateBps: bigint;
  maxNewExpiry: bigint;
  setter: Address;
}

export async function runAutoLifecycle(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'autoLifecycle')) return;
  const chains = getChainConfigs(env);
  // Chains side by side, loans from a moving start (#2572 r5/r7, `runWindow.ts`).
  const run = runIndex(tick, 60_000);
  await Promise.all(
    chains.map(async (chain) => {
      try {
        await processChain(env, chain, tick.deadlineMs, run);
      } catch (err) {
        console.error(
          `[keeper] autoLifecycle chain=${chain.id} failed:`,
          redactedError(err),
        );
      }
    }),
  );
}

async function processChain(env: Env, chain: ChainConfig, deadlineMs: number, run: number): Promise<void> {
  if (!chain.diamond) return;
  const publicClient = createPublicClient({
    transport: http(chain.rpc),
  }) as PublicClient;

  // Admin kill switch.
  const adminEnabled = (await publicClient.readContract({
    address: chain.diamond as Address,
    abi: ADMIN_ABI,
    functionName: 'getAutoExtendEnabled',
  })) as boolean;
  if (!adminEnabled) {
    console.log(`[keeper] autoLifecycle chain=${chain.id} skipped: kill switch off`);
    return;
  }

  // Enumerate active loans.
  const total = (await publicClient.readContract({
    address: chain.diamond as Address,
    abi: METRICS_ABI,
    functionName: 'getActiveLoansCount',
  })) as bigint;
  if (total === 0n) return;

  const ctx = buildKeeperContext(env, chain, publicClient, { notAfterMs: deadlineMs });
  if (!ctx) return;

  // #2738 — the extension window is measured on the loan clock. When it does
  // not read, no loan's window is known, so none is extended this run.
  let clock: ExtendClock;
  try {
    const [pauseLog, graceBuckets] = await Promise.all([
      readPauseLog({ client: publicClient, diamond: chain.diamond as Address }),
      publicClient.readContract({
        address: chain.diamond as Address,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getGraceBuckets',
      }) as Promise<readonly GraceBucket[]>,
    ]);
    clock = { pauseLog, graceBuckets };
  } catch (err) {
    console.log(
      `[keeper] autoLifecycle chain=${chain.id} skipped: loan clock unread, so no extension window is known — ${redactedError(err, { stack: false })}`,
    );
    return;
  }

  // Read a page, act on it, read the next (#2572 r5): the scan never spends
  // the window before the first extension. The walk starts at a loan that
  // moves each run (`pagedWalk`, #2572 r7), not at a page, so a run the
  // deadline stops partway through its first page does not leave that page's
  // tail unreached run after run.
  let scanned = 0;
  let submitted = 0;
  let stopped = false;
  for (const { cursor, limit } of pagedWalk(total, SCAN_PAGE, run)) {
    if (stopped || submitted >= MAX_EXTENDS_PER_TICK) break;
    const page = (await publicClient.readContract({
      address: chain.diamond as Address,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansPaginated',
      args: [cursor, limit],
    })) as bigint[];
    for (const loanIdBig of page) {
      if (submitted >= MAX_EXTENDS_PER_TICK) break;
      // #2572 — past the run's deadline every extension would be refused at
      // its turn in the send queue; the rest wait for the next run.
      if (Date.now() >= deadlineMs) {
        console.log(`[keeper] autoLifecycle chain=${chain.id} run deadline reached; remaining loans left for the next run`);
        stopped = true;
        break;
      }
      scanned += 1;
      const fired = await tryExtend(
        publicClient,
        ctx.wallet,
        chain.diamond as Address,
        loanIdBig,
        clock,
      );
      if (fired) submitted++;
    }
  }
  console.log(
    `[keeper] autoLifecycle chain=${chain.id} scanned=${scanned} extended=${submitted}`,
  );
}

async function tryExtend(
  publicClient: PublicClient,
  wallet: import('viem').WalletClient,
  diamond: Address,
  loanIdBig: bigint,
  clock: ExtendClock,
): Promise<boolean> {
  // Read both-side caps. Each getter self-applies the staleness
  // fence: if the NFT transferred since the setter wrote the cap,
  // `enabled` is returned as `false` and we skip without firing.
  const borrowerCaps = (await publicClient.readContract({
    address: diamond,
    abi: AUTO_LIFECYCLE_ABI,
    functionName: 'getAutoExtendBorrowerCaps',
    args: [loanIdBig],
  })) as ExtendCaps;
  if (!borrowerCaps.enabled) return false;

  const lenderCaps = (await publicClient.readContract({
    address: diamond,
    abi: AUTO_LIFECYCLE_ABI,
    functionName: 'getAutoExtendLenderCaps',
    args: [loanIdBig],
  })) as ExtendCaps;
  if (!lenderCaps.enabled) return false;

  // Pick rate at the lender's floor — most conservative for the
  // borrower while still respecting the lender's minimum. The
  // contract enforces `minRateBps <= newRateBps <= ceiling`.
  const ceiling =
    lenderCaps.maxRateBps < borrowerCaps.maxRateBps
      ? lenderCaps.maxRateBps
      : borrowerCaps.maxRateBps;
  const newRateBps = lenderCaps.minRateBps;
  if (newRateBps > ceiling) return false; // no intersection

  // Compute the duration that fits inside the tightest expiry cap.
  const expiryCap =
    lenderCaps.maxNewExpiry < borrowerCaps.maxNewExpiry
      ? lenderCaps.maxNewExpiry
      : borrowerCaps.maxNewExpiry;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiryCap !== 0n && nowSec >= expiryCap) return false;

  let newDurationDays = DEFAULT_EXTEND_DAYS;
  if (expiryCap !== 0n) {
    const remainingDays = (expiryCap - nowSec) / SECONDS_PER_DAY;
    if (remainingDays < newDurationDays) newDurationDays = remainingDays;
    if (newDurationDays === 0n) return false;
  }

  // #2738 — only inside the window, and only a term that keeps the loan's
  // grace-inclusive deadline. Read after the caps: most loans carry no
  // consent and never reach this read.
  const loan = (await publicClient.readContract({
    address: diamond,
    abi: LOAN_ABI,
    functionName: 'getLoanDetails',
    args: [loanIdBig],
  })) as { startTime: bigint; durationDays: bigint };
  const outside = extendWindowVerdict(loan, newDurationDays, clock, nowSec);
  if (outside !== null) {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: ${outside}`);
    return false;
  }

  // Submit `extendLoanInPlace`. Contract reverts on every safety
  // guard (sub-day-since-start, grace expired, sanctions, etc.) —
  // those failures bubble up here and we log + continue.
  try {
    const hash = await wallet.writeContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'extendLoanInPlace',
      args: [loanIdBig, Number(newRateBps), newDurationDays],
      chain: undefined,
      account: wallet.account ?? null,
    } as never);
    console.log(
      `[keeper] autoLifecycle extended loan=${loanIdBig} rate=${newRateBps}bps days=${newDurationDays} tx=${hash}`,
    );
    return true;
  } catch (err) {
    // Most reverts here are benign (loan in last day, grace
    // expired, both-side consent flipped between read + write).
    // Log at info, not error.
    reportSendError(`[keeper] autoLifecycle extend loan=${loanIdBig}`, err, `skipped: ${redactedError(err, { stack: false })}`, console.log);
    return false;
  }
}
