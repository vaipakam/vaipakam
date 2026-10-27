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
 *   6. Only inside the extension window (#2738), as the contract states
 *      it for the loan: `getAutoExtendWindow(loanId)`, from three days
 *      before the loan's effective due date to the end of its grace. A
 *      window that cannot be read leaves that loan for the next run. The
 *      term rules are the contract's too (`ExtensionMustExtend`,
 *      `ExtensionShortensGrace`): a term that does not move the due date
 *      later, or makes the loan defaultable sooner, is refused at the
 *      send's gas estimate, so nothing is broadcast. (The keeper's interim
 *      copy of these rules, for Diamonds deployed before #2738's contract
 *      half, was removed at the all-waves fresh deploy, #2921.)
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
  MetricsFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import type { PassTick } from './passSchedule';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { reportSendError } from './submissionQueue';
import { runIndex } from './runWindow';
import { pagedWalk } from './rotate';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { revertErrorName } from '@vaipakam/lib/contractRevert';

const ADMIN_ABI: Abi = AdminFacetABI as Abi;
const AUTO_LIFECYCLE_ABI: Abi = AutoLifecycleFacetABI as Abi;
const METRICS_ABI: Abi = MetricsFacetABI as Abi;

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

/**
 * Whether `now` is inside the window the contract published for a loan
 * (`getAutoExtendWindow`, both bounds inclusive, as `extendLoanInPlace`
 * applies them); null when it is, otherwise the reason it is not.
 */
export function contractWindowVerdict(opensAt: bigint, closesAt: bigint, now: bigint): string | null {
  if (now < opensAt) return `window opens at ${opensAt}`;
  if (now > closesAt) return `past grace (ended ${closesAt})`;
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

  // #2738 — only inside the window. Read after the caps: most loans carry
  // no consent and never reach this read.
  const outside = await readContractWindow(publicClient, diamond, loanIdBig, nowSec);
  if (outside !== null) {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: ${outside}`);
    return false;
  }

  // Submit `extendLoanInPlace`. Contract reverts on every safety
  // guard (sub-day-since-start, grace expired, sanctions, a term that
  // does not extend or shortens grace, etc.) — those failures bubble
  // up at the gas estimate, before anything is broadcast, and we log +
  // continue.
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

/** The contract's window for one loan, judged at `now`; null when open,
 *  otherwise the reason the loan is not extended. A loan that left Active
 *  since its page was read answers `LoanNotActive`; any other failure leaves
 *  the window unknown, and the loan waits for the next run. */
export async function readContractWindow(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  loanId: bigint,
  now: bigint,
): Promise<string | null> {
  let window: readonly [bigint, bigint];
  try {
    window = (await client.readContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'getAutoExtendWindow',
      args: [loanId],
    })) as readonly [bigint, bigint];
  } catch (err) {
    if (revertErrorName(err) === 'LoanNotActive') return 'no longer active';
    return `window unread — ${redactedError(err, { stack: false })}`;
  }
  return contractWindowVerdict(window[0], window[1], now);
}
