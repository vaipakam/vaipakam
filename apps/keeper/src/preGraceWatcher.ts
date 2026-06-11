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
} from '@vaipakam/contracts/abis';
import { erc721Abi } from 'viem';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { listThresholdsForChain } from './db';
import {
  getPreGraceNotifyState,
  putPreGraceNotifyState,
} from './db';
import { sendMessage as sendTelegramMessage } from './telegram';
import { sendPush } from './push';

const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const AUTO_LIFECYCLE_ABI: Abi = AutoLifecycleFacetABI as Abi;
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
        nowSec,
      );
    } catch (err) {
      console.warn(
        `[keeper] preGraceWatcher loan=${loanIdBig} chain=${chain.id}: ${String(err).slice(0, 200)}`,
      );
    }
  }
}

async function checkLoan(
  env: Env,
  chain: ChainConfig,
  publicClient: PublicClient,
  diamond: Address,
  loanIdBig: bigint,
  subsByWallet: Map<string, { wallet: string; tg_chat_id: string | null; push_channel: string | null; locale: string }>,
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
