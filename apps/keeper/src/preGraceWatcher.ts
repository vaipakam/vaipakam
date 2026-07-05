/**
 * apps/keeper — T-092-C (#532) pre-grace notification pass.
 *
 * Closes the "auto-refinance is best-effort, not a guarantee" UX
 * gap. Per cron tick, per chain:
 *
 *   1. Walk active loans via `MetricsFacet.getActiveLoansPaginated`.
 *   2. For each loan, read `AutoLifecycleFacet.getAutoRefinanceCaps`.
 *      Skip if disabled (borrower hasn't opted in → no warning
 *      expected).
 *   3. Read `LoanFacet.getLoanDetails` for `startTime`,
 *      `durationDays`, `status`. Skip non-Active loans.
 *   4. Compute `endTime = startTime + durationDays * 86400`. If the
 *      loan is more than `PRE_GRACE_WINDOW_SECONDS` from endTime,
 *      skip — too early to warn. If `block.timestamp >= endTime`,
 *      skip — the loan is already past its natural end (the
 *      separate `runLiquidator` / default flow handles those).
 *   5. Resolve the borrower-NFT owner via `ERC721.ownerOf`.
 *      Look up their subscription in the `user_thresholds` table —
 *      same row the HF watcher uses. If they haven't subscribed,
 *      skip (no channel to send on).
 *   6. Check the `pre_grace_notify_state` dedupe — if we warned in
 *      the last `THROTTLE_SECONDS`, skip.
 *   7. Send the warning via Telegram + Push, then stamp the dedupe.
 *
 * Gated only on the watcher being enabled (`env.DB` present + at
 * least one chain with a Diamond). Unlike the liquidator + matcher
 * + auto-extend passes, this one doesn't require a signing key — it
 * only reads + dispatches notifications.
 *
 * Why a separate pass and not folded into `runWatcher`?
 *
 *   The HF watcher already iterates the user's active loans via
 *   `getUserActiveLoans` (subscribed-user subset). The pre-grace
 *   watcher's job is different in two ways:
 *
 *     (a) It cares about ALL active loans on the chain, not just
 *         subscribed users — auto-refinance caps can be set on any
 *         loan, by any borrower, regardless of whether they've
 *         subscribed for HF alerts. (However, we DO use the
 *         subscription table for the dispatch channel; a borrower
 *         who hasn't subscribed gets no warning. Future
 *         enhancement: auto-subscribe on cap-set.)
 *
 *     (b) The trigger is time-to-grace, not HF-band transition.
 *         Mixing the two would muddy `notify_state.last_band`
 *         hysteresis logic.
 *
 *   Splitting keeps each pass's invariant simple.
 */

import {
  createPublicClient,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import {
  AutoLifecycleFacetABI,
  LoanFacetABI,
  MetricsFacetABI,
  OfferCancelFacetABI,
} from '@vaipakam/contracts/abis';
import { erc721Abi } from 'viem';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { listThresholdsForChain, type UserThresholds } from './db';
import {
  getPreGraceNotifyState,
  putPreGraceNotifyState,
} from './db';
import { sendMessage as sendTelegramMessage } from './telegram';
import { sendPush } from './push';

const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const AUTO_LIFECYCLE_ABI: Abi = AutoLifecycleFacetABI as Abi;
/** T-092 #547 — `getOffer` (offer hydration) lives on
 *  OfferCancelFacet post the EIP-170 facet split. Used to read the
 *  active offer book for the viable-counterparty pre-check. */
const OFFER_CANCEL_ABI: Abi = OfferCancelFacetABI as Abi;
const LOAN_ABI: Abi = LoanFacetABI as Abi;

const SCAN_PAGE = 200n;

/** How close to `endTime` triggers the warning. 24 hours mirrors
 *  the conservative HF watcher's lead-time on band 'alert'. */
const PRE_GRACE_WINDOW_SECONDS = 24 * 60 * 60;

/** Dedupe throttle — don't re-warn the same loan within this window.
 *  Half the warning window so the borrower gets at most 2 reminders
 *  in the lead-up to grace expiry. */
const THROTTLE_SECONDS = 12 * 60 * 60;

interface RefinanceCaps {
  enabled: boolean;
  maxRateBps: bigint;
  maxNewExpiry: bigint;
  setter: Address;
}

interface LoanDetails {
  status: number;
  borrowerTokenId: bigint;
  startTime: bigint;
  durationDays: bigint;
  principalAsset: Address;
  principal: bigint;
  collateralAsset: Address;
  assetType: number;
  collateralAssetType: number;
}

/** T-092 #547 — minimal Offer shape for the viable-counterparty
 *  pre-check. Only the fields needed for matching against a loan's
 *  refinance shape are listed; the full Offer struct has 20+ fields
 *  but the matcher's `previewMatch` does the deeper validation and
 *  we want to keep this scan cheap. */
interface OfferRow {
  offerType: number; // 0 = Lender, 1 = Borrower
  accepted: boolean;
  lendingAsset: Address;
  collateralAsset: Address;
  assetType: number;
  collateralAssetType: number;
  amount: bigint;
  amountMax: bigint;
}

export async function runPreGraceWatcher(env: Env): Promise<void> {
  if (!env.DB) {
    console.log('[keeper] preGraceWatcher skipped: DB not bound');
    return;
  }
  const chains = getChainConfigs(env);
  for (const chain of chains) {
    try {
      await watchChain(env, chain);
    } catch (err) {
      console.error(
        `[keeper] preGraceWatcher chain=${chain.id} failed:`,
        err,
      );
    }
  }
}

async function watchChain(env: Env, chain: ChainConfig): Promise<void> {
  if (!chain.diamond) return;
  const publicClient = createPublicClient({
    transport: http(chain.rpc),
  }) as PublicClient;
  const diamond = chain.diamond as Address;

  // Enumerate active loans on this chain.
  let total: bigint;
  try {
    total = (await publicClient.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansCount',
    })) as bigint;
  } catch (err) {
    console.warn(
      `[keeper] preGraceWatcher count failed chain=${chain.id}: ${String(err).slice(0, 200)}`,
    );
    return;
  }
  if (total === 0n) return;

  const loanIds: bigint[] = [];
  for (let cursor = 0n; cursor < total; cursor += SCAN_PAGE) {
    const limit =
      cursor + SCAN_PAGE > total ? total - cursor : SCAN_PAGE;
    try {
      const page = (await publicClient.readContract({
        address: diamond,
        abi: METRICS_ABI,
        functionName: 'getActiveLoansPaginated',
        args: [cursor, limit],
      })) as bigint[];
      loanIds.push(...page);
    } catch (err) {
      console.warn(
        `[keeper] preGraceWatcher page failed chain=${chain.id}: ${String(err).slice(0, 200)}`,
      );
      return;
    }
  }

  // Pre-fetch the subscription map so we don't hit D1 once per loan.
  // `listThresholdsForChain` returns one row per (wallet, chain_id);
  // we re-key by wallet for O(1) lookup.
  const subs = await listThresholdsForChain(env.DB!, chain.id);
  const subsByWallet = new Map(
    subs.map((s) => [s.wallet.toLowerCase(), s]),
  );

  // T-092 #547 — pull the active offer book once per tick + filter
  // to lender offers. The viable-counterparty pre-check uses this
  // cache to skip the pre-grace warning when at least one in-book
  // lender offer would match the loan's refinance shape. Cuts
  // false-positive notifications without paying for `previewMatch`
  // simulation per loan. Soft-capped via `OFFER_SCAN_CAP` so a
  // chain with a runaway order book can't blow the per-tick budget.
  const lenderOffers = await _scanLenderOfferBook(
    publicClient,
    diamond,
    chain.id,
  );

  const nowSec = Math.floor(Date.now() / 1000);

  for (const loanIdBig of loanIds) {
    try {
      await checkLoan(
        env,
        chain,
        publicClient,
        diamond,
        loanIdBig,
        subsByWallet,
        lenderOffers,
        nowSec,
      );
    } catch (err) {
      console.warn(
        `[keeper] preGraceWatcher loan=${loanIdBig} chain=${chain.id}: ${String(err).slice(0, 200)}`,
      );
    }
  }
}

/** T-092 #547 — soft cap on offers hydrated per tick per chain.
 *  Beyond this the viable-counterparty pre-check is disabled and
 *  all loans get the pre-grace warning (conservative-safe — we
 *  over-warn rather than miss). */
const OFFER_SCAN_CAP = 500;

/**
 * Scan the active offer book and return the lender offers (the
 * candidate counterparties for a refinance-tagged borrower offer).
 * Soft-capped at OFFER_SCAN_CAP; returns null beyond the cap so
 * callers know to fall back to unconditional warning.
 */
async function _scanLenderOfferBook(
  publicClient: PublicClient,
  diamond: Address,
  chainId: number,
): Promise<OfferRow[] | null> {
  let total: bigint;
  try {
    total = (await publicClient.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveOffersCount',
    })) as bigint;
  } catch (err) {
    console.warn(
      `[keeper] preGraceWatcher offer-count failed chain=${chainId}: ${String(err).slice(0, 200)}`,
    );
    return null;
  }
  if (total === 0n) return [];
  if (total > BigInt(OFFER_SCAN_CAP)) {
    console.log(
      `[keeper] preGraceWatcher offer book too large for pre-check chain=${chainId} count=${total} cap=${OFFER_SCAN_CAP}`,
    );
    return null;
  }

  const offerIds: bigint[] = [];
  for (let cursor = 0n; cursor < total; cursor += SCAN_PAGE) {
    const limit =
      cursor + SCAN_PAGE > total ? total - cursor : SCAN_PAGE;
    try {
      const page = (await publicClient.readContract({
        address: diamond,
        abi: METRICS_ABI,
        functionName: 'getActiveOffersPaginated',
        args: [cursor, limit],
      })) as bigint[];
      offerIds.push(...page);
    } catch (err) {
      console.warn(
        `[keeper] preGraceWatcher offer-page failed chain=${chainId}: ${String(err).slice(0, 200)}`,
      );
      return null;
    }
  }

  const lenderOffers: OfferRow[] = [];
  for (const offerIdBig of offerIds) {
    try {
      const o = (await publicClient.readContract({
        address: diamond,
        abi: OFFER_CANCEL_ABI,
        functionName: 'getOffer',
        args: [offerIdBig],
      })) as Record<string, unknown>;
      // Only lender offers that haven't already accepted are
      // candidates for matching a refinance-tagged borrower offer.
      if (
        Number(o.offerType) === 0 /* Lender */ &&
        !o.accepted
      ) {
        lenderOffers.push({
          offerType: Number(o.offerType),
          accepted: Boolean(o.accepted),
          lendingAsset: o.lendingAsset as Address,
          collateralAsset: o.collateralAsset as Address,
          assetType: Number(o.assetType),
          collateralAssetType: Number(o.collateralAssetType),
          amount: o.amount as bigint,
          amountMax: o.amountMax as bigint,
        });
      }
    } catch (err) {
      // Hydration of a single offer failing isn't fatal; continue
      // with the rest.
      console.log(
        `[keeper] preGraceWatcher offer-hydrate skipped offerId=${offerIdBig}: ${String(err).slice(0, 120)}`,
      );
    }
  }
  return lenderOffers;
}

/**
 * Heuristic compatibility check: at least one in-book lender offer
 * matches the loan's lending + collateral asset pair + can cover
 * the loan's principal. Doesn't simulate previewMatch (would cost
 * gas-equivalent eth_calls per loan); the matcher pass itself
 * does the deeper validation when it actually tries to match.
 * False negatives possible (HF may fail, caps may reject) — the
 * borrower still gets the warning in those cases.
 */
function _hasViableLenderForLoan(
  loan: LoanDetails,
  lenderOffers: OfferRow[],
): boolean {
  for (const o of lenderOffers) {
    if (o.assetType !== loan.assetType) continue;
    if (o.collateralAssetType !== loan.collateralAssetType) continue;
    if (
      o.lendingAsset.toLowerCase() !== loan.principalAsset.toLowerCase()
    )
      continue;
    if (
      o.collateralAsset.toLowerCase() !== loan.collateralAsset.toLowerCase()
    )
      continue;
    const ceiling = o.amountMax > 0n ? o.amountMax : o.amount;
    if (ceiling < loan.principal) continue;
    return true;
  }
  return false;
}

async function checkLoan(
  env: Env,
  chain: ChainConfig,
  publicClient: PublicClient,
  diamond: Address,
  loanIdBig: bigint,
  subsByWallet: Map<string, UserThresholds>,
  lenderOffers: OfferRow[] | null,
  nowSec: number,
): Promise<void> {
  // Auto-refinance caps — skip when not enabled (no opt-in → no
  // warning expected).
  const caps = (await publicClient.readContract({
    address: diamond,
    abi: AUTO_LIFECYCLE_ABI,
    functionName: 'getAutoRefinanceCaps',
    args: [loanIdBig],
  })) as RefinanceCaps;
  if (!caps.enabled) return;

  // Loan details — compute endTime + skip if Status != Active or
  // outside the warning window.
  const loan = (await publicClient.readContract({
    address: diamond,
    abi: LOAN_ABI,
    functionName: 'getLoanDetails',
    args: [loanIdBig],
  })) as LoanDetails;
  if (loan.status !== 0 /* Active */) return;

  const endTime = Number(loan.startTime + loan.durationDays * 86400n);
  if (endTime <= nowSec) return; // already past natural end
  if (endTime - nowSec > PRE_GRACE_WINDOW_SECONDS) return; // too early

  // T-092 #547 — viable-counterparty pre-check. When the offer book
  // scan succeeded (lenderOffers !== null) AND a compatible lender
  // offer exists for this loan, skip the warning — the matcher will
  // likely fire on the next tick. When the scan failed or the book
  // exceeded OFFER_SCAN_CAP, we fall back to unconditional warning
  // (lenderOffers === null) — conservative-safe.
  if (lenderOffers !== null && _hasViableLenderForLoan(loan, lenderOffers)) {
    return;
  }

  // Resolve borrower-NFT owner. The Diamond IS the ERC721 collection
  // for position NFTs.
  const ownerAddr = (await publicClient.readContract({
    address: diamond,
    abi: erc721Abi,
    functionName: 'ownerOf',
    args: [loan.borrowerTokenId],
  })) as Address;

  const sub = subsByWallet.get(ownerAddr.toLowerCase());
  if (!sub) return; // borrower hasn't subscribed → no channel to dispatch on
  // #1033 — the "message me before a payment comes due" opt-out
  // covers this lane too: the pre-grace warning is a due-date
  // warning, and an advertised opt-out that one detector ignores
  // isn't a real control. (HF-band alerts stay governed by the
  // bands, not this flag.)
  if (sub.notify_maturity_approaching === 0) return;

  // Dedupe — throttle re-notifications.
  const lastSent = await getPreGraceNotifyState(
    env.DB!,
    sub.wallet,
    chain.id,
    Number(loanIdBig),
  );
  if (nowSec - lastSent < THROTTLE_SECONDS) return;

  // Format + dispatch.
  const hoursToEnd = Math.max(0, Math.floor((endTime - nowSec) / 3600));
  const frontendOrigin = env.FRONTEND_ORIGIN ?? '';
  const text = formatPreGraceWarning(
    chain.name,
    Number(loanIdBig),
    hoursToEnd,
    frontendOrigin,
  );

  if (sub.tg_chat_id && env.TG_BOT_TOKEN) {
    await sendTelegramMessage(env.TG_BOT_TOKEN, sub.tg_chat_id, text);
  }
  if (sub.push_channel) {
    await sendPush(env.PUSH_CHANNEL_PK, {
      subscriber: sub.wallet,
      title: 'Auto-refinance: no match found yet',
      body: text,
      deepLinkUrl: `${frontendOrigin}/loans/${loanIdBig}`,
    });
  }

  await putPreGraceNotifyState(
    env.DB!,
    sub.wallet,
    chain.id,
    Number(loanIdBig),
    nowSec,
  );
}

function formatPreGraceWarning(
  chainName: string,
  loanId: number,
  hoursToEnd: number,
  frontendOrigin: string,
): string {
  return [
    `⚠️ Auto-refinance pre-grace warning`,
    ``,
    `Your loan #${loanId} on ${chainName} enters its grace period in ~${hoursToEnd}h.`,
    `Auto-refinance is best-effort — if no compatible lender offer is matched before grace expires, your loan will default.`,
    ``,
    `What to do now:`,
    `• Open ${frontendOrigin}/loans/${loanId} to review terms`,
    `• Tighten your refinance caps if the market has moved`,
    `• Or repay manually before grace ends to avoid liquidation`,
  ].join('\n');
}
