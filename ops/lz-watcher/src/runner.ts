/**
 * Per-tick orchestrator. Runs the three watchers in sequence (their
 * subrequest budgets are non-overlapping, so serial keeps memory and
 * CPU predictable while still finishing well under the 30s scheduled
 * wall-clock budget on free tier). Each watcher returns a list of
 * alerts that should fire this tick — already deduped against
 * `lz_alert_state`. The runner formats + delivers via Telegram.
 */

import type { Env } from './env';
import { getChainContexts } from './chains';
import { checkDvnDrift, formatDvnAlert } from './lzGuard';
import { checkOftImbalance, formatImbalanceAlert } from './oftBalance';
import { scanOversizedFlows, formatOversizedFlowAlert } from './flowGuard';
import { sendOpsAlert } from './telegram';

export async function runLzWatcher(env: Env): Promise<void> {
  const chains = getChainContexts(env);
  if (chains.length === 0) {
    console.log('[lz-watcher] no chains configured — nothing to do');
    return;
  }
  // The bot-token secret was renamed TG_BOT_TOKEN → TG_OPS_BOT_TOKEN
  // (audience cleavage: ops bot ≠ user-facing bot). Keeping a legacy
  // fallback during the rollout window means an existing deployment
  // that only has the OLD secret set keeps delivering alerts during
  // the brief window between code-deploy and `wrangler secret put
  // TG_OPS_BOT_TOKEN`. Once every deploy is on the new secret, the
  // fallback is dead code and can be removed (tracked as part of the
  // lz-watcher refactor / delete decision in issue #250).
  const tgToken = env.TG_OPS_BOT_TOKEN ?? env.TG_BOT_TOKEN;
  if (env.TG_BOT_TOKEN && !env.TG_OPS_BOT_TOKEN) {
    console.warn(
      '[lz-watcher] using legacy TG_BOT_TOKEN — rotate to TG_OPS_BOT_TOKEN via `wrangler secret put` and drop TG_BOT_TOKEN. See CLAUDE.md "Two Telegram bots".',
    );
  }
  if (!tgToken || !env.TG_OPS_CHAT_ID) {
    console.warn(
      '[lz-watcher] TG_OPS_BOT_TOKEN (or legacy TG_BOT_TOKEN) or TG_OPS_CHAT_ID not set — alerts will be logged but not delivered',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const messages: string[] = [];

  // ── 1. DVN-count drift ──────────────────────────────────────────────
  try {
    const alerts = await checkDvnDrift(env.DB, chains, now);
    for (const a of alerts) messages.push(formatDvnAlert(a));
  } catch (err) {
    console.error(`[lz-watcher] checkDvnDrift threw: ${String(err).slice(0, 300)}`);
  }

  // ── 2. OFT mint/burn imbalance ──────────────────────────────────────
  try {
    const alert = await checkOftImbalance(env.DB, chains, now);
    if (alert) messages.push(formatImbalanceAlert(alert));
  } catch (err) {
    console.error(`[lz-watcher] checkOftImbalance threw: ${String(err).slice(0, 300)}`);
  }

  // ── 3. Oversized VPFI flows ─────────────────────────────────────────
  try {
    const threshold = parseThreshold(env.FLOW_THRESHOLD_VPFI);
    const alerts = await scanOversizedFlows(env.DB, chains, threshold, now);
    for (const a of alerts) messages.push(formatOversizedFlowAlert(a));
  } catch (err) {
    console.error(`[lz-watcher] scanOversizedFlows threw: ${String(err).slice(0, 300)}`);
  }

  // ── Deliver ─────────────────────────────────────────────────────────
  if (messages.length === 0) {
    console.log('[lz-watcher] tick clean — no alerts');
    return;
  }
  console.log(`[lz-watcher] tick produced ${messages.length} alert(s)`);
  if (tgToken && env.TG_OPS_CHAT_ID) {
    for (const msg of messages) {
      await sendOpsAlert(tgToken, env.TG_OPS_CHAT_ID, msg);
    }
  } else {
    for (const msg of messages) console.log(msg);
  }
}

function parseThreshold(raw: string | undefined): bigint {
  if (!raw) return 100_000n * 10n ** 18n; // default 100k VPFI
  try {
    return BigInt(raw);
  } catch {
    return 100_000n * 10n ** 18n;
  }
}
