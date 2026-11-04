/**
 * Worker environment: bindings, operator knobs, and their parsing.
 *
 * The split follows CLAUDE.md's "what still lives operator-side" rule —
 * addresses come from the committed deployment artifact (see `chains.ts`),
 * while RPC endpoints (they carry API keys), the ops bot token and the ops
 * chat id are bound from the account Secrets Store and resolved once per
 * invocation by {@link resolveEnv}. Tuning thresholds are plain vars.
 */

/** Cloudflare bindings + configuration this Worker reads. */
export interface Env {
  /** D1 — alert dedup + the per-chain observation history the windowed
   *  advisories need. `vaipakam-mesh-alerts-db`; see wrangler.jsonc for
   *  why it is NOT the shared `vaipakam-warm`. */
  DB: D1Database;

  // ── Telegram (ops-internal bot — never the user-facing TG_BOT_TOKEN) ──
  /** Secrets Store (`TG_OPS_BOT_TOKEN`). The ops bot, never the
   *  user-facing `TG_BOT_TOKEN`. A plain string once resolved. */
  TG_OPS_BOT_TOKEN?: string;
  /** Secrets Store (`TG_OPS_CHAT_ID`). Numeric chat id of the internal ops
   *  channel. Not a credential, but kept beside the token so the pair has
   *  one home. A plain string once resolved. */
  TG_OPS_CHAT_ID?: string;

  /** Secret. Bearer token for the manual `POST /run` trigger. While
   *  UNSET the endpoint is closed — a tick is not a read-only probe (it
   *  burns RPC quota, advances streak counters and sends Telegram), and a
   *  `workers.dev` URL is public. */
  WATCHER_RUN_TOKEN?: string;

  // ── Mesh topology ────────────────────────────────────────────────────
  /** Var. EVM chain id of the canonical REWARD chain (Base / Base
   *  Sepolia). The mirror set is not configured here — it is read from
   *  the canonical Diamond's `getExpectedSourceChainIds()`, so a mirror
   *  wired on-chain is watched without a Worker redeploy. */
  CANONICAL_CHAIN_ID?: string;

  // ── Tuning ───────────────────────────────────────────────────────────
  /** Var. Consecutive observations with a positive outstanding commitment
   *  and FLAT retirement before the (advisory) stuck-settlement signal
   *  fires. Default 6. */
  STUCK_WINDOW_TICKS?: string;
  /** Var. Consecutive observations where Base's accepted cumulatives for a
   *  chain trail that chain's own ledger before the (advisory) report-lag
   *  signal fires.
   *
   *  Default 130, and the size is NOT arbitrary: these cumulatives travel
   *  only in the chain's DAY-CLOSE report, so between reports Base is
   *  legitimately behind and frozen for a whole day. The window must
   *  exceed one full report cycle or a perfectly healthy chain alarms
   *  every day (Codex #1443 r3). Floor = day (86400s) + finalization
   *  grace (14400s) + CCIP delivery, over the cron interval: at 15-minute
   *  ticks that is ~112, so 130 (~32.5h) leaves headroom. RETUNE THIS if
   *  you change the cron interval. */
  REPORT_LAG_WINDOW_TICKS?: string;
  /** Var. Absolute VPFI-wei slack allowed on the bucket-coverage check.
   *  See `invariants.ts` — `LibVpfiRecycle.consume` deliberately floors
   *  the bucket at zero to survive cap-trim dust, so an exact
   *  `bucket >= outstanding` would fire on wei-scale rounding. Default
   *  1e15 (0.001 VPFI): ~12 orders of magnitude above per-day dust and
   *  far below any real shortfall. */
  BUCKET_COVERAGE_TOLERANCE_WEI?: string;
  /**
   * Slack allowed on the REVERSE composition bound only (#1448 r3).
   *
   * Deliberately NOT the coverage knob. Raising the coverage tolerance for
   * a chain with noisy dust would otherwise silently widen a
   * custody-exclusion blind spot the operator has no reason to connect to
   * it — which is why they are separate settings rather than one.
   */
  COMPOSITION_SLACK_TOLERANCE_WEI?: string;
  /** Var. Seconds before an already-notified alert of the same identity
   *  is sent again. Default 21600 (6h). */
  ALERT_REPEAT_SECONDS?: string;
  /** Var. How old a chain's latest block may be before its snapshot is
   *  treated as unreadable rather than compared against Base. Default 300
   *  (5 min): comfortably above ordinary RPC head lag and clock skew, far
   *  below the day-close cadence, and far below the 15-minute tick. Raise
   *  it only for a chain that genuinely idles between blocks. */
  STALE_LOCAL_SECONDS?: string;
  /** Var. Seconds between cron ticks, which each observe ONE chain of the
   *  rotation (see `rotation.ts`). Must equal the cron interval in
   *  `wrangler.jsonc`, or ticks land on the wrong slots and a chain can be
   *  skipped or doubled. Default 300 (the `*\/5` cron). */
  ROTATION_STEP_SECONDS?: string;

  // ── Per-chain RPC endpoints (Secrets Store — they carry API keys) ───
  //
  // Keyed by EVM chain id: `RPC_8453`, `RPC_42161`, `RPC_84532`, ...
  // Each is a Secrets Store binding to the store's slug-named secret
  // (`RPC_84532` → `RPC_BASE_SEPOLIA`), resolved to a string by
  // `resolveEnv`. A plain per-Worker secret of the same name also works.
  // Keying by chain id rather than a short name means a chain added to
  // `getExpectedSourceChainIds()` needs one secret and no code change.
  // A chain with no RPC configured is reported as a COVERAGE GAP rather
  // than silently skipped.
  [key: string]: unknown;
}

/** Parsed, validated knobs — resolved once per tick. */
export interface Config {
  canonicalChainId: number;
  stuckWindowTicks: number;
  reportLagWindowTicks: number;
  bucketCoverageToleranceWei: bigint;
  /** Slack on the REVERSE composition bound only — never the coverage knob. */
  compositionSlackToleranceWei: bigint;
  alertRepeatSeconds: number;
  staleLocalSeconds: number;
  rotationStepSeconds: number;
  telegram: { token: string; chatId: string } | null;
}

function intVar(raw: unknown, fallback: number, label: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${String(raw)}`);
  }
  return n;
}

function bigintVar(raw: unknown, fallback: bigint, label: string): bigint {
  if (raw === undefined || raw === null || raw === '') return fallback;
  try {
    const v = BigInt(String(raw));
    if (v < 0n) throw new Error('negative');
    return v;
  } catch {
    throw new Error(
      `${label} must be a non-negative integer string, got ${String(raw)}`,
    );
  }
}

/**
 * Resolve the alert destination, INDEPENDENTLY of everything else.
 *
 * Deliberately its own function, and deliberately incapable of throwing.
 * The failure path needs to page the operator precisely when the rest of
 * the configuration is unparseable — and an earlier version derived the
 * destination through {@link readConfig}, so a malformed
 * `STUCK_WINDOW_TICKS` or `CANONICAL_CHAIN_ID` made the recovery path
 * throw a second time, yield `null`, and leave the watcher silently blind
 * with only a Cloudflare log to show for it (Codex #1443 r1).
 */
export function readTelegramTarget(
  env: Env,
): { token: string; chatId: string } | null {
  const token = typeof env.TG_OPS_BOT_TOKEN === 'string' ? env.TG_OPS_BOT_TOKEN : '';
  const chatId = typeof env.TG_OPS_CHAT_ID === 'string' ? env.TG_OPS_CHAT_ID : '';
  return token && chatId ? { token, chatId } : null;
}

/**
 * Resolve the alert repeat interval, INDEPENDENTLY and without throwing.
 *
 * The tick-failure handler needs the operator's configured cadence even
 * when some OTHER knob is what made `readConfig` throw — hard-coding the
 * default there gave the watcher-down alert a different, undocumented
 * cadence from every other alert (Codex #1443 r4). Falls back to the
 * default only when THIS setting is absent or unparseable.
 */
export function readAlertRepeatSeconds(env: Env): number {
  try {
    return intVar(env.ALERT_REPEAT_SECONDS, 21_600, 'ALERT_REPEAT_SECONDS');
  } catch {
    return 21_600;
  }
}

/**
 * The rotation step, INDEPENDENTLY and without throwing — the cron entry
 * needs it to pick a slot before `readConfig` runs, and a malformed value
 * must still let the tick start (and fail loudly inside `runTick`, which
 * validates it again) rather than throw outside the alerting path.
 */
export function readRotationStep(env: Env): number {
  try {
    return intVar(env.ROTATION_STEP_SECONDS, 300, 'ROTATION_STEP_SECONDS');
  } catch {
    return 300;
  }
}

/**
 * Resolve the tick configuration.
 *
 * @throws When `CANONICAL_CHAIN_ID` is unset or unparseable — without it
 *         there is no mesh to walk, and guessing would be worse than
 *         failing loudly. Callers recovering from this must resolve the
 *         alert destination via {@link readTelegramTarget}, never by
 *         calling this again.
 */
export function readConfig(env: Env): Config {
  const canonicalRaw = env.CANONICAL_CHAIN_ID;
  const canonicalChainId = Number(canonicalRaw);
  if (!canonicalRaw || !Number.isInteger(canonicalChainId)) {
    throw new Error(
      'CANONICAL_CHAIN_ID must be set to the EVM chain id of the canonical reward chain (e.g. 8453 for Base, 84532 for Base Sepolia)',
    );
  }

  return {
    canonicalChainId,
    stuckWindowTicks: intVar(env.STUCK_WINDOW_TICKS, 6, 'STUCK_WINDOW_TICKS'),
    reportLagWindowTicks: intVar(
      env.REPORT_LAG_WINDOW_TICKS,
      130, // ~32.5h at the 15-minute cron — see the field's doc comment
      'REPORT_LAG_WINDOW_TICKS',
    ),
    bucketCoverageToleranceWei: bigintVar(
      env.BUCKET_COVERAGE_TOLERANCE_WEI,
      1_000_000_000_000_000n, // 1e15 wei = 0.001 VPFI
      'BUCKET_COVERAGE_TOLERANCE_WEI',
    ),
    compositionSlackToleranceWei: bigintVar(
      env.COMPOSITION_SLACK_TOLERANCE_WEI,
      1_000_000_000_000_000n, // 1e15 wei = 0.001 VPFI
      'COMPOSITION_SLACK_TOLERANCE_WEI',
    ),
    alertRepeatSeconds: readAlertRepeatSeconds(env),
    staleLocalSeconds: intVar(env.STALE_LOCAL_SECONDS, 300, 'STALE_LOCAL_SECONDS'),
    rotationStepSeconds: intVar(env.ROTATION_STEP_SECONDS, 300, 'ROTATION_STEP_SECONDS'),
    telegram: readTelegramTarget(env),
  };
}

/** A Cloudflare Secrets Store secret binding — read with `.get()`. */
export interface SecretBinding {
  get(): Promise<string>;
}

/**
 * The binding names that may arrive as account Secrets Store bindings
 * (store `vaipakam-credentials`, declared under `secrets_store_secrets`
 * in `wrangler.jsonc`): the ops bot pair and the per-chain RPC URLs. The
 * RPC bindings keep the chain-id naming {@link rpcFor} reads, and point at
 * the store's slug-named secrets (`RPC_84532` → `RPC_BASE_SEPOLIA`), so the
 * watcher shares one copy of each credential with the keeper, indexer and
 * agent instead of holding a second per-Worker copy that can drift.
 *
 * `WATCHER_RUN_TOKEN` is deliberately absent: it is this Worker's own
 * per-Worker secret and arrives as a plain string.
 */
const STORE_BOUND = /^(RPC_\d+|TG_OPS_BOT_TOKEN|TG_OPS_CHAT_ID)$/;

function isSecretBinding(v: unknown): v is SecretBinding {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { get?: unknown }).get === 'function'
  );
}

/**
 * Resolve the raw Worker bindings into the plain-string {@link Env} every
 * other module reads — the "resolve at the boundary" pattern from
 * `docs/DesignsAndPlans/SecretsStoreMigration.md` §6, used by the keeper,
 * indexer and agent. Call it ONCE per invocation, at the entry point.
 *
 * Every other field (`DB`, the vars, a per-Worker secret) is copied
 * through unchanged, so a deployment that still sets a name as a plain
 * per-Worker secret keeps working.
 *
 * A store read that fails resolves to UNSET rather than throwing. That is
 * the honest reading, and it is already reported: a missing RPC becomes a
 * coverage gap (so the tick is not `ok`), and a missing ops-bot pair makes
 * `deliveryConfigured` false. The error is logged by binding name only —
 * never with the value.
 */
export async function resolveEnv(raw: Env): Promise<Env> {
  const resolved: Env = { ...raw };
  const reads: Promise<void>[] = [];
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!STORE_BOUND.test(key) || !isSecretBinding(value)) continue;
    reads.push(
      value.get().then(
        (secret) => {
          resolved[key] = secret;
        },
        () => {
          console.error(`[env] Secrets Store read failed for ${key}; treating it as unset`);
          delete resolved[key];
        },
      ),
    );
  }
  await Promise.all(reads);
  return resolved;
}

/** RPC endpoint for `chainId`, or `null` when the operator has not
 *  configured one (surfaced as a coverage gap, never silently dropped). */
export function rpcFor(env: Env, chainId: number): string | null {
  const raw = env[`RPC_${chainId}`];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
