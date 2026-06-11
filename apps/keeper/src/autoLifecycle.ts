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
 *   6. Soft per-tick cap so one rogue chain can't burn the keeper's
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
 * Gating: `isKeeperEnabled` only — same as the matcher / liquidator.
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
import { getChainConfigs } from './env';
import { buildKeeperContext, isKeeperEnabled } from './keeper';

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

interface ExtendCaps {
  enabled: boolean;
  minRateBps: bigint;
  maxRateBps: bigint;
  maxNewExpiry: bigint;
  setter: Address;
}

export async function runAutoLifecycle(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) {
    console.log('[keeper] autoLifecycle skipped: keeper disabled');
    return;
  }
  const chains = getChainConfigs(env);
  for (const chain of chains) {
    try {
      await processChain(env, chain);
    } catch (err) {
      console.error(
        `[keeper] autoLifecycle chain=${chain.id} failed:`,
        err,
      );
    }
  }
}

async function processChain(env: Env, chain: ChainConfig): Promise<void> {
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

  const loanIds: bigint[] = [];
  for (let cursor = 0n; cursor < total; cursor += SCAN_PAGE) {
    const limit =
      cursor + SCAN_PAGE > total ? total - cursor : SCAN_PAGE;
    const page = (await publicClient.readContract({
      address: chain.diamond as Address,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansPaginated',
      args: [cursor, limit],
    })) as bigint[];
    loanIds.push(...page);
  }

  const ctx = buildKeeperContext(env, chain, publicClient);
  if (!ctx) return;

  let submitted = 0;
  for (const loanIdBig of loanIds) {
    if (submitted >= MAX_EXTENDS_PER_TICK) break;
    const fired = await tryExtend(
      publicClient,
      ctx.wallet,
      chain.diamond as Address,
      loanIdBig,
    );
    if (fired) submitted++;
  }
  console.log(
    `[keeper] autoLifecycle chain=${chain.id} scanned=${loanIds.length} extended=${submitted}`,
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
    console.log(
      `[keeper] autoLifecycle extend skipped loan=${loanIdBig}: ${(err as Error).message}`,
    );
    return false;
  }
}
