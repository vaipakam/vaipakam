/**
 * Worker entry — Cloudflare invokes `scheduled()` on the nightly cron tick
 * (`17 3 * * *`, see `wrangler.jsonc`), which runs the backup and reports the
 * outcome to the ops chat.
 *
 * The Worker no longer checks its own archives. The weekly healthcheck it
 * used to run needed a read key and the symmetric decryption key, and holding
 * those beside the write key is what let one compromised environment find,
 * read and overwrite an archive; all three left together (#1463, #1469). The
 * backup watcher (`scripts/backup-ledger.mjs`, run outside Cloudflare) makes
 * the online checks every day instead, and only an offline restore drill can
 * prove an archive decrypts (design: docs/DesignsAndPlans/BackupSecurityDesign.md).
 */

import { parseRegionFromEndpoint, type B2Config } from './b2';
import { runNightlyBackup, type WrittenArchive } from './backup';
import type { Env } from './env';

/**
 * This Worker's deployed name, mirroring `wrangler.jsonc`'s `name`.
 *
 * Needed because the preflight alert fires BEFORE any config is resolved,
 * so there is no bucket to name — and during the archive→warm handoff two
 * Workers share the schedule and the ops bot, making an unattributed alert
 * unactionable. `identity.test.ts` asserts this equals the wrangler config,
 * so the two cannot drift apart silently.
 */
const WORKER_NAME = 'vaipakam-offchain-data-warm';

/** The write-scoped B2 config: the only B2 key the Worker holds (env.ts). */
function b2WriteConfig(env: Env): B2Config {
  return {
    accessKeyId: env.B2_WRITE_ACCESS_KEY_ID,
    secretAccessKey: env.B2_WRITE_SECRET_ACCESS_KEY,
    endpoint: env.B2_ENDPOINT,
    bucket: env.B2_BUCKET,
    region: parseRegionFromEndpoint(env.B2_ENDPOINT),
  };
}

/** Send a Telegram alert. Never throws — alert failures must not
 *  abort a backup or mask its failure. Returns true if the
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
 *   - B2_ENDPOINT            (S3-compatible host)
 *   - B2_BUCKET              (B2 bucket name)
 *   - B2_WRITE_ACCESS_KEY_ID + B2_WRITE_SECRET_ACCESS_KEY
 *
 * No encryption key is required, or accepted: the recipients are public
 * keys bundled from `backup-recipients/recipients.json` at build time.
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
  const required = ['B2_ENDPOINT', 'B2_BUCKET', 'B2_WRITE_ACCESS_KEY_ID', 'B2_WRITE_SECRET_ACCESS_KEY'] as const;
  const missing = required.filter((k) => {
    const v = (env as unknown as Record<string, string | undefined>)[k];
    return v === undefined || v === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `MISSING ENV: ${missing.join(', ')}. ` +
      `Set each via \`wrangler secret put <NAME>\` against the ` +
      `vaipakam-offchain-data-warm Worker. See ` +
      `ops/offchain-data-warm/README.md §Setup for the full list ` +
      `+ values to paste.`,
    );
  }
}

export default {
  /**
   * Cron handler: one cron, at 03:17 UTC daily, runs the nightly backup.
   * Why one cron: the account caps cron triggers, and this Worker takes
   * exactly one. What that budget holds today is in
   * `docs/ops/CloudflareCronSlots.md` and deliberately not here (#1977).
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Preflight: validate every required secret exists BEFORE any
    // helper that touches them gets called. A missing value would
    // otherwise crash inside `parseRegionFromEndpoint(undefined)` ~10
    // frames down, surfacing as CF Error 1101 with no
    // operator-actionable context.
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
      // Identity on THIS alert especially (#1537 r8): a preflight failure
      // names no bucket (an unset bucket is one of the things reported), so
      // the Worker name is the identity that always resolves. `WORKER_NAME`
      // is pinned to wrangler.jsonc by a test so it cannot drift.
      ctx.waitUntil(
        tg(env, `🚨 ${WORKER_NAME} preflight FAILED:\n${msg}`),
      );
      throw err;
    }

    // The write-scoped key's capabilities are `['listBuckets',
    // 'writeFiles']` (scripts/setup-backblaze.mjs): no `listFiles`, no
    // `readFiles`, no `deleteFiles`. With no read key beside it, the Worker
    // can neither enumerate nor read an existing archive, so overwriting one
    // in place means guessing its 128-bit nonce, which the Worker no longer
    // writes anywhere (design §4).
    ctx.waitUntil(handleNightlyBackup(env, b2WriteConfig(env)));
  },

  /** No HTTP surface today — keep `fetch` defined so wrangler dev
   *  doesn't error out on a stray request during local testing.
   *  Always returns 404 with an honest description of why. */
  async fetch(): Promise<Response> {
    return new Response(
      'vaipakam-offchain-data-warm is a cron-driven Worker. No HTTP surface.',
      { status: 404 },
    );
  },
};

/** Open-ticket count for the daily ops message. This is the DAILY
 *  backstop behind the agent Worker's instant new-ticket notify: if
 *  that Telegram send fails persistently (bad chat id, outage), the
 *  operator still sees a non-zero open count here within 24 h — a
 *  ticket can never sit in D1 unnoticed indefinitely (#1040 phase 1,
 *  Codex round-3). Read-only, same posture as the backup SELECTs. */
async function openSupportTicketCount(env: Env): Promise<string> {
  try {
    const row = await env.DB_ARCHIVE
      .prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'`)
      .first<{ n: number }>();
    return String(row?.n ?? 0);
  } catch {
    // Pre-migration-0028 environments have no table yet — say so
    // rather than reporting a misleading 0.
    return 'n/a (table missing)';
  }
}

/**
 * One report line per archive written: tier, period, size and the full
 * SHA-256. Never the object name: the random nonce in it is what keeps a
 * leaked write key from overwriting the archive, and this message goes to a
 * chat and the Worker log, both of which outlive the run (design §4). The
 * SHA-256 matches the archive to the backup watcher's ledger entry.
 */
function archiveLine(a: WrittenArchive): string {
  return `  ${a.tier} ${a.period}: ${(a.bytes / 1024 / 1024).toFixed(2)} MB, sha256 ${a.sha256}`;
}

async function handleNightlyBackup(env: Env, cfg: B2Config): Promise<void> {
  try {
    const out = await runNightlyBackup(env, cfg);
    // A failed ops notification must not pass silently (#1470 r1). `tg()`
    // returns false for unset credentials, a non-2xx, or a network error,
    // and discarding that left a nightly run reporting success with no
    // record of it anywhere an operator looks. The upload already happened,
    // so this must not fail the run — but it CAN make the gap visible in
    // the Worker log, which is the only channel left when the alert channel
    // is the thing that broke.
    const notified = await tg(
      env,
      [
        '✅ Nightly off-chain backup succeeded',
        // WHICH bucket, on every alert (#1537 r7): the bucket is what an
        // operator needs to know which deployment wrote the archives.
        `  bucket: ${cfg.bucket}`,
        ...out.archives.map(archiveLine),
        // THE DIGEST IS NOT A PROVENANCE ANCHOR. The same environment holds
        // the B2 write key and this bot's token, so whoever can forge an
        // archive can also send this line, and a bot can edit and delete its
        // own messages. What vouches for an archive is the backup watcher's
        // ledger, a record this Worker cannot write (#1473); the full digest
        // is here so the operator can match the two.
        `  encrypted to recipient set ${out.recipientSet}`,
        `  rows: ${out.rowsBackedUp}, R2 objects: ${out.r2ObjectsBackedUp}`,
        `  open support tickets: ${await openSupportTicketCount(env)}`,
        `  took ${(out.durationMs / 1000).toFixed(1)} s`,
      ].join('\n'),
    );
    if (!notified) {
      console.warn(
        `[cloud-backup] nightly SUCCEEDED but the ops notification did not send. ` +
          out.archives.map((a) => `${a.tier} ${a.period} sha256=${a.sha256}`).join('; ') +
          ` rows=${out.rowsBackedUp} r2Objects=${out.r2ObjectsBackedUp}. ` +
          `The backup exists in B2; only the record of it is missing.`,
      );
    }
  } catch (err) {
    const msg = (err as Error).message;
    await tg(env, `🚨 Nightly backup FAILED (bucket: ${cfg.bucket}): ${msg}`);
    // Re-throw so Worker's invocation log shows the failure too
    // (operator-visible via `wrangler tail`).
    throw err;
  }
}
