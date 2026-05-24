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
  if (!env.TG_BOT_TOKEN || !env.TG_OPS_CHAT_ID) {
    console.warn('[cloud-backup] TG_BOT_TOKEN/TG_OPS_CHAT_ID unset; skipping alert');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
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

export default {
  /**
   * Cron dispatcher. Cloudflare passes `event.cron` matching the
   * pattern from `wrangler.jsonc`, which is how we tell nightly vs
   * weekly apart. The two paths share env boot but otherwise don't
   * interfere — a stuck nightly never blocks the healthcheck, and a
   * failing healthcheck never aborts a nightly.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const bootedEnv = await withEncryptionKey(env);

    if (event.cron === '17 3 * * *') {
      // Nightly path uses the write-scoped B2 key — listBuckets +
      // listFiles + writeFiles only. A compromise that exfiltrates
      // it can corrupt FUTURE backups (uploading garbage to new
      // unique keys; immutable naming defeats in-place overwrite of
      // existing archives) but cannot read past archives.
      ctx.waitUntil(handleNightlyBackup(bootedEnv, b2WriteConfig(bootedEnv)));
    } else if (event.cron === '0 9 * * 1') {
      // Weekly healthcheck uses the read-scoped B2 key — listBuckets
      // + listFiles + readFiles only. A compromise that exfiltrates
      // it yields AES ciphertext; the offline encryption key blocks
      // the plaintext.
      ctx.waitUntil(handleHealthcheck(bootedEnv, b2ReadConfig(bootedEnv)));
    } else {
      console.warn(`[cloud-backup] unknown cron pattern: ${event.cron}`);
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
