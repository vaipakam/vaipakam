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

import { createPublicClient, http, parseAbi, type Address } from 'viem';
import type { Env } from './env';
import { getChainConfigs } from './env';
import { sendPush } from './push';
import { sendMessage } from './telegram';

const DEFAULT_PRE_NOTIFY_DAYS = 3;
const SECONDS_PER_DAY = 86_400;

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

const PRE_NOTIFY_DAYS_ABI = parseAbi([
  'function getPreNotifyDays() view returns (uint8)',
]);

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
}

export async function runPeriodicPreNotify(env: Env): Promise<void> {
  const chains = getChainConfigs(env).filter(
    (c) => c.diamond && c.diamond !== '0x0000000000000000000000000000000000000000',
  );
  if (chains.length === 0) return;

  for (const chain of chains) {
    try {
      await preNotifyChain(env, chain);
    } catch (err) {
      console.error(
        `[periodicPreNotify] chain=${chain.name} err=${String(err).slice(0, 300)}`,
      );
    }
  }
}

async function preNotifyChain(
  env: Env,
  chain: { id: number; name: string; rpc: string; diamond: string },
): Promise<void> {
  // Pull the configured pre-notify lead time. Fall through to the
  // library default on any read failure so a transient hiccup
  // doesn't turn the lane silent for the entire tick.
  let preNotifyDays = DEFAULT_PRE_NOTIFY_DAYS;
  try {
    const client = createPublicClient({ transport: http(chain.rpc) });
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

  for (const row of rows.results ?? []) {
    const ivlDays = intervalDays(row.periodic_interest_cadence);
    if (ivlDays === 0) continue;
    const nextCheckpoint = row.last_period_settled_at + ivlDays * SECONDS_PER_DAY;
    const secsUntil = nextCheckpoint - now;
    // Window: 0 < secsUntil <= preNotifyDays. We DON'T pre-notify
    // after the boundary has already passed (settler can fire any
    // moment) — that's the SETTLEMENT lane's territory, separate
    // from this PRE-notify lane.
    if (secsUntil <= 0 || secsUntil > windowSec) continue;
    // De-dup: we've already pushed for this exact checkpoint.
    if (row.period_pre_notified_at === nextCheckpoint) continue;

    const daysUntil = Math.max(1, Math.ceil(secsUntil / SECONDS_PER_DAY));

    // Push to BOTH counterparties — borrower first (they need to
    // act), then lender (courtesy). Each lookup is a single D1
    // query; subscribers usually overlap with HF-watcher rows so
    // the table is hot in cache.
    await pushIfSubscribed(env, chain, row, row.borrower, daysUntil, 'borrower');
    await pushIfSubscribed(env, chain, row, row.lender, daysUntil, 'lender');

    // Stamp the de-dup column even if neither side is subscribed —
    // re-querying on every tick is wasteful when we know there's
    // no one to notify for this checkpoint.
    await env.DB.prepare(
      `UPDATE loans SET period_pre_notified_at = ?, updated_at = ?
       WHERE chain_id = ? AND loan_id = ?`,
    )
      .bind(nextCheckpoint, now, chain.id, row.loan_id)
      .run();
  }
}

async function pushIfSubscribed(
  env: Env,
  chain: { id: number; name: string },
  loan: LoanRow,
  wallet: string,
  daysUntil: number,
  role: 'borrower' | 'lender',
): Promise<void> {
  const sub = await env.DB.prepare(
    `SELECT wallet, push_channel, tg_chat_id, locale
     FROM user_thresholds
     WHERE chain_id = ? AND wallet = ?`,
  )
    .bind(chain.id, wallet.toLowerCase())
    .first<UserPushRow>();
  if (!sub) return;

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
  const deepLink = `${env.FRONTEND_ORIGIN}/app/loans/${loan.loan_id}`;

  if (sub.push_channel) {
    try {
      await sendPush(env.PUSH_CHANNEL_PK, {
        subscriber: wallet,
        title,
        body,
        deepLinkUrl: deepLink,
      });
    } catch (err) {
      console.error(
        `[periodicPreNotify] push failed loan=${loan.loan_id} wallet=${wallet} err=${String(err).slice(0, 200)}`,
      );
    }
  }
  if (sub.tg_chat_id && env.TG_BOT_TOKEN) {
    try {
      await sendMessage(env.TG_BOT_TOKEN, sub.tg_chat_id, `${title}\n${body}\n${deepLink}`);
    } catch (err) {
      console.error(
        `[periodicPreNotify] tg failed loan=${loan.loan_id} wallet=${wallet} err=${String(err).slice(0, 200)}`,
      );
    }
  }
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
