/**
 * Worker environment: bindings, operator knobs, and their parsing.
 *
 * The split follows CLAUDE.md's "what still lives operator-side" rule —
 * addresses come from the committed deployment artifact (see `chains.ts`),
 * while RPC endpoints (they carry API keys) and the Telegram bot token are
 * Cloudflare secrets. Chat ids and tuning thresholds are plain vars.
 */

/** Cloudflare bindings + configuration this Worker reads. */
export interface Env {
  /** D1 — alert dedup + the per-chain observation history the windowed
   *  advisories need. `vaipakam-mesh-alerts-db`; see wrangler.jsonc for
   *  why it is NOT the shared `vaipakam-archive`. */
  DB: D1Database;

  // ── Telegram (ops-internal bot — never the user-facing TG_BOT_TOKEN) ──
  /** Secret. Ops bot shared with `ops/offchain-data-archive`. */
  TG_OPS_BOT_TOKEN?: string;
  /** Var. Numeric chat id of the internal ops channel. */
  TG_OPS_CHAT_ID?: string;

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
  /** Var. Consecutive observations where Base's accepted cumulative for a
   *  chain trails that chain's own ledger before the (advisory) report-lag
   *  signal fires. Default 6. */
  REPORT_LAG_WINDOW_TICKS?: string;
  /** Var. Absolute VPFI-wei slack allowed on the bucket-coverage check.
   *  See `invariants.ts` — `LibVpfiRecycle.consume` deliberately floors
   *  the bucket at zero to survive cap-trim dust, so an exact
   *  `bucket >= outstanding` would fire on wei-scale rounding. Default
   *  1e15 (0.001 VPFI): ~12 orders of magnitude above per-day dust and
   *  far below any real shortfall. */
  BUCKET_COVERAGE_TOLERANCE_WEI?: string;
  /** Var. Seconds before an already-notified alert of the same identity
   *  is sent again. Default 21600 (6h). */
  ALERT_REPEAT_SECONDS?: string;

  // ── Per-chain RPC endpoints (secrets — they carry API keys) ──────────
  //
  // Keyed by EVM chain id: `RPC_8453`, `RPC_42161`, `RPC_84532`, ...
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
  alertRepeatSeconds: number;
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
 * Resolve the tick configuration.
 *
 * @throws When `CANONICAL_CHAIN_ID` is unset or unparseable — without it
 *         there is no mesh to walk, and guessing would be worse than
 *         failing loudly.
 */
export function readConfig(env: Env): Config {
  const canonicalRaw = env.CANONICAL_CHAIN_ID;
  const canonicalChainId = Number(canonicalRaw);
  if (!canonicalRaw || !Number.isInteger(canonicalChainId)) {
    throw new Error(
      'CANONICAL_CHAIN_ID must be set to the EVM chain id of the canonical reward chain (e.g. 8453 for Base, 84532 for Base Sepolia)',
    );
  }

  const token = typeof env.TG_OPS_BOT_TOKEN === 'string' ? env.TG_OPS_BOT_TOKEN : '';
  const chatId = typeof env.TG_OPS_CHAT_ID === 'string' ? env.TG_OPS_CHAT_ID : '';

  return {
    canonicalChainId,
    stuckWindowTicks: intVar(env.STUCK_WINDOW_TICKS, 6, 'STUCK_WINDOW_TICKS'),
    reportLagWindowTicks: intVar(
      env.REPORT_LAG_WINDOW_TICKS,
      6,
      'REPORT_LAG_WINDOW_TICKS',
    ),
    bucketCoverageToleranceWei: bigintVar(
      env.BUCKET_COVERAGE_TOLERANCE_WEI,
      1_000_000_000_000_000n, // 1e15 wei = 0.001 VPFI
      'BUCKET_COVERAGE_TOLERANCE_WEI',
    ),
    alertRepeatSeconds: intVar(
      env.ALERT_REPEAT_SECONDS,
      21_600,
      'ALERT_REPEAT_SECONDS',
    ),
    telegram: token && chatId ? { token, chatId } : null,
  };
}

/** RPC endpoint for `chainId`, or `null` when the operator has not
 *  configured one (surfaced as a coverage gap, never silently dropped). */
export function rpcFor(env: Env, chainId: number): string | null {
  const raw = env[`RPC_${chainId}`];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
