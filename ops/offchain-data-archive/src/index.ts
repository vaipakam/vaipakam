/**
 * Worker entry — Cloudflare invokes `scheduled()` on every cron tick.
 * Two crons are wired (see `wrangler.jsonc`):
 *   - "17 3 * * *"  → nightly backup at 03:17 UTC.
 *   - "0 9 * * 1"   → weekly healthcheck on Monday 09:00 UTC.
 *
 * Both paths converge on the same `tg()` alert helper so the
 * operator sees identical formatting whether the news is good (backup
 * landed) or bad (healthcheck found drift).
 */

import { importBackupKey } from './crypto';
import { parseRegionFromEndpoint, type B2Config } from './b2';
import { runNightlyBackup } from './backup';
import { runHealthcheck } from './healthcheck';
import type { Env } from './env';

/** Two B2 configs — see env.ts for why the keys are split. */
function b2WriteConfig(env: Env): B2Config {
  return {
    accessKeyId: env.B2_WRITE_ACCESS_KEY_ID,
    secretAccessKey: env.B2_WRITE_SECRET_ACCESS_KEY,
    endpoint: env.B2_ENDPOINT,
    bucket: env.B2_BUCKET,
    region: parseRegionFromEndpoint(env.B2_ENDPOINT),
  };
}

function b2ReadConfig(env: Env): B2Config {
  return {
    accessKeyId: env.B2_READ_ACCESS_KEY_ID,
    secretAccessKey: env.B2_READ_SECRET_ACCESS_KEY,
    endpoint: env.B2_ENDPOINT,
    bucket: env.B2_BUCKET,
    region: parseRegionFromEndpoint(env.B2_ENDPOINT),
  };
}

/** Send a Telegram alert. Never throws — alert failures must not
 *  abort a backup or mask a healthcheck failure. Returns true if the
 *  message landed, false otherwise (logged but swallowed). */
async function tg(env: Env, text: string): Promise<boolean> {
  if (!env.TG_OPS_BOT_TOKEN || !env.TG_OPS_CHAT_ID) {
    console.warn('[cloud-backup] TG_OPS_BOT_TOKEN/TG_OPS_CHAT_ID unset; skipping alert');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_OPS_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_OPS_CHAT_ID,
        text,
        // Plain text — no markdown so an attacker-controlled error
        // message can't smuggle a payload through markdown parsing.
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[cloud-backup] tg() failed: ${(err as Error).message}`);
    return false;
  }
}

/** Boot helper — imports the AES key from env once and returns the
 *  env enriched with the CryptoKey handle. */
async function withEncryptionKey(env: Env): Promise<Env> {
  env.encryptionKey = await importBackupKey(env.BACKUP_ENCRYPTION_KEY);
  return env;
}

/**
 * Fail-fast preflight that enumerates EVERY required secret/var and
 * throws a single error naming all the missing ones. Without this
 * guard, a missing value crashes deep inside helpers (e.g.
 * `parseRegionFromEndpoint(undefined)` throws `TypeError: Cannot read
 * properties of undefined` ~10 frames down) and surfaces as CF
 * Error 1101 with no operator-actionable context.
 *
 * Hard-required (cron can't function without these — missing any
 * means the backup path will crash):
 *   - BACKUP_ENCRYPTION_KEY  (64 hex chars, AES-256 key)
 *   - B2_ENDPOINT            (S3-compatible host)
 *   - B2_BUCKET              (B2 bucket name)
 *   - B2_WRITE_ACCESS_KEY_ID + B2_WRITE_SECRET_ACCESS_KEY
 *   - B2_READ_ACCESS_KEY_ID  + B2_READ_SECRET_ACCESS_KEY
 *
 * Soft-required (cron functions; alerts silently no-op — `tg()` is
 * already defensive about these):
 *   - TG_OPS_BOT_TOKEN
 *   - TG_OPS_CHAT_ID
 *
 * Soft cases are NOT checked here; the operator gets a one-line
 * `[cloud-backup] TG_OPS_BOT_TOKEN/TG_OPS_CHAT_ID unset; skipping
 * alert` console warn instead. Without that distinction, a fresh
 * deploy without TG configured would hard-abort the backup that
 * would otherwise run fine.
 */
function assertRequiredEnv(env: Env): void {
  const required = [
    'BACKUP_ENCRYPTION_KEY',
    'B2_ENDPOINT',
    'B2_BUCKET',
    'B2_WRITE_ACCESS_KEY_ID',
    'B2_WRITE_SECRET_ACCESS_KEY',
    'B2_READ_ACCESS_KEY_ID',
    'B2_READ_SECRET_ACCESS_KEY',
  ] as const;
  const missing = required.filter((k) => {
    const v = (env as unknown as Record<string, string | undefined>)[k];
    return v === undefined || v === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `MISSING ENV: ${missing.join(', ')}. ` +
      `Set each via \`wrangler secret put <NAME>\` against the ` +
      `vaipakam-offchain-data-archive Worker. See ` +
      `ops/offchain-data-archive/README.md §Setup for the full list ` +
      `+ values to paste.`,
    );
  }
  // Additional shape check: AES key must be 64 hex chars.
  // importBackupKey() does the same check but its error surfaces
  // from inside withEncryptionKey(); calling it out upfront gives
  // the operator a single page-source-of-truth.
  if (!/^[0-9a-fA-F]{64}$/.test(env.BACKUP_ENCRYPTION_KEY)) {
    throw new Error(
      'MISSING ENV: BACKUP_ENCRYPTION_KEY is set but is not 64 ' +
      'hex chars (expected an AES-256 key from `openssl rand -hex 32`).',
    );
  }
}

export default {
  /**
   * Cron dispatcher. Single cron at 03:17 UTC daily. Runs the
   * nightly backup unconditionally; on Mondays ALSO runs the weekly
   * healthcheck in parallel.
   *
   * Why parallel (two separate `ctx.waitUntil` calls instead of
   * sequential or `Promise.all`):
   *  - The two paths share NO state. They use different scoped B2
   *    keys (write-only vs read-only) and hit different B2 endpoints
   *    (PUT vs GET / list).
   *  - Cuts total Worker wall-time roughly in half on Mondays.
   *  - Failure isolation — a backup-path crash doesn't tear down the
   *    healthcheck Promise the way `Promise.all` would, and vice
   *    versa. The operator gets two independent Telegram alerts;
   *    healthcheck typically finishes first (smaller payload), which
   *    also gives faster "the cron actually fired" confirmation.
   *  - The Monday healthcheck verifies the MOST RECENT archive
   *    within the last 3 days (i.e. yesterday's at the time the cron
   *    starts, since today's hasn't uploaded yet). Acceptable
   *    trade-off vs the alternative of healthcheck-after-backup
   *    sequentially (which would verify today's just-written archive
   *    for a stronger end-to-end signal at the cost of doubling the
   *    cron wall-time and serializing failure modes).
   *
   * Why one cron at all: free-plan account cap of 5 cron triggers
   * across the org. apps/{keeper,agent,indexer} + ops/lz-watcher
   * already occupy 4. Splitting backup + healthcheck into two crons
   * would push past 5/5 and CF API rejects the deploy with 10072.
   * Split back into two crons if/when the account upgrades to
   * Workers Paid ($5/mo, removes the cap).
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Preflight: validate every required secret exists BEFORE any
    // helper that touches them gets called. A missing value would
    // otherwise crash inside `parseRegionFromEndpoint(undefined)` or
    // `importBackupKey('')` ~10 frames down, surfacing as CF
    // Error 1101 with no operator-actionable context.
    //
    // On failure: try to alert via Telegram BEFORE rethrowing, so
    // the operator gets a clear "missing X" message in the ops
    // channel. `tg()` is itself defensive — if TG creds are ALSO
    // missing the call silently no-ops, but a console.warn line
    // surfaces in `wrangler tail`. Then re-throw so the Worker's
    // invocation log records the failure too.
    try {
      assertRequiredEnv(env);
    } catch (err) {
      const msg = (err as Error).message;
      // Note: we haven't booted the encryption key yet, but the
      // error path doesn't need it — only the tg() call which
      // reads TG_OPS_BOT_TOKEN + TG_OPS_CHAT_ID directly from env.
      ctx.waitUntil(tg(env, `🚨 Worker preflight FAILED:\n${msg}`));
      throw err;
    }

    const bootedEnv = await withEncryptionKey(env);

    // Backup path — runs every day. Write-scoped B2 key
    // (listBuckets + listFiles + writeFiles). A CF compromise that
    // exfiltrates these credentials can corrupt FUTURE archives
    // (only at new unique object keys — the immutable-naming nonce
    // defeats in-place overwrite of existing ones) but cannot read
    // past archives or delete them.
    ctx.waitUntil(handleNightlyBackup(bootedEnv, b2WriteConfig(bootedEnv)));

    // Healthcheck path — runs on Mondays only. Read-scoped B2 key
    // (listBuckets + listFiles + readFiles). A CF compromise yields
    // AES-256-GCM ciphertext only; the offline encryption key
    // blocks plaintext recovery. `getUTCDay()` returns 1 for Monday
    // (0=Sun..6=Sat). Computed from event.scheduledTime so the
    // weekday is unambiguous even if the Worker's local clock
    // somehow drifts (Workers run in UTC; defensive but cheap).
    const monday = new Date(event.scheduledTime).getUTCDay() === 1;
    if (monday) {
      ctx.waitUntil(handleHealthcheck(bootedEnv, b2ReadConfig(bootedEnv)));
    }
  },

  /** No HTTP surface today — keep `fetch` defined so wrangler dev
   *  doesn't error out on a stray request during local testing.
   *  Always returns 404 with an honest description of why. */
  async fetch(): Promise<Response> {
    return new Response(
      'vaipakam-offchain-data-archive is a cron-driven Worker. No HTTP surface.',
      { status: 404 },
    );
  },
};

async function handleNightlyBackup(env: Env, cfg: B2Config): Promise<void> {
  try {
    const out = await runNightlyBackup(env, cfg);
    await tg(
      env,
      [
        '✅ Nightly off-chain backup succeeded',
        `  archive: ${out.archiveKey}`,
        `  manifest: ${out.manifestKey}`,
        `  size: ${(out.archiveBytes / 1024 / 1024).toFixed(2)} MB`,
        `  sha256: ${out.archiveSha256.slice(0, 16)}…`,
        `  rows: ${out.rowsBackedUp}, R2 objects: ${out.r2ObjectsBackedUp}`,
        `  took ${(out.durationMs / 1000).toFixed(1)} s`,
      ].join('\n'),
    );
  } catch (err) {
    const msg = (err as Error).message;
    await tg(env, `🚨 Nightly backup FAILED: ${msg}`);
    // Re-throw so Worker's invocation log shows the failure too
    // (operator-visible via `wrangler tail`).
    throw err;
  }
}

async function handleHealthcheck(env: Env, cfg: B2Config): Promise<void> {
  try {
    const r = await runHealthcheck(env, cfg);
    if (r.ok) {
      await tg(
        env,
        [
          '✅ Weekly backup healthcheck PASS',
          `  archive: ${r.archiveKey}`,
          r.archiveAgeHours !== undefined
            ? `  age: ${r.archiveAgeHours.toFixed(1)} h`
            : '',
          `  sha256: ${r.manifestSha?.slice(0, 16)}…`,
          `  ${r.reason}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } else {
      await tg(
        env,
        [
          '🚨 Weekly backup healthcheck FAILED',
          `  reason: ${r.reason}`,
          r.archiveKey ? `  archive: ${r.archiveKey}` : '',
          r.manifestSha ? `  manifest sha: ${r.manifestSha}` : '',
          r.actualSha ? `  actual sha:   ${r.actualSha}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  } catch (err) {
    await tg(env, `🚨 Weekly healthcheck CRASHED: ${(err as Error).message}`);
    throw err;
  }
}
