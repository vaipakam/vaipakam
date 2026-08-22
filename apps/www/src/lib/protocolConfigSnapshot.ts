/**
 * Reading the published protocol-config snapshot — decode, freshness,
 * and the fetch itself.
 *
 * REACT-FREE on purpose. This was inside `useProtocolConfig.ts` until
 * #1664 item 3, which is the wrong home for it now: the build script
 * that writes the machine-readable exports (`/docs/*.md`,
 * `llms-full.txt`) needs exactly this logic, and a build script has no
 * business importing a hook. A second copy of "how do we read the
 * published config" is the drift this module exists to prevent — the
 * same reasoning that moved the knob registry in item 2.
 *
 * The hook re-exports what it used to define, so existing importers are
 * unaffected.
 *
 * Env resolution deliberately stays with each CALLER. The hook reads
 * `import.meta.env`; the build script reads `process.env`. Threading
 * one of those through the other's runtime would mean either a
 * `process` reference in the browser bundle or a Vite-only global in a
 * node script, so the origin and chain id arrive as arguments instead.
 */

/**
 * Refuse a snapshot older than a day. Config flips reach the snapshot
 * within about one ingest scan, so a row this stale means the refresh
 * rail is wedged — and a wedged rail serving a confidently wrong number
 * is worse than the bundled default, which at least announces itself as
 * a build-time value. Same window the connected app applies
 * (`protocolConfigFresh`); deliberately the same rule rather than a
 * second opinion about the same rail.
 */
export const FRESH_WINDOW_SECONDS = 24 * 3600;

/** How far ahead of the reader's clock a snapshot may be stamped before
 *  it is treated as wrong rather than merely new. Browsers' clocks are
 *  routinely a few minutes out; nothing legitimate is hours ahead. */
const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60;

/** VPFI is 18 decimals on every deploy — required by the bridge spec,
 *  and the connected app's own fallback when its `decimals()` read
 *  fails. Reading it live would need the chain client this file exists
 *  to avoid. */
const VPFI_DECIMALS = 18n;

/**
 * The ceiling the protocol APPLIES to a per-tier VPFI fee discount —
 * `LibVaipakam.MAX_FEE_DISCOUNT_BPS`.
 *
 * Mirrored here rather than read, for the same reason the knob defaults
 * are: this surface has no chain client. It is a deliberately narrow
 * mirror — one number, guarding a display clamp — and the drift risk is
 * bounded by the fact that raising the applied ceiling is a protocol
 * change that would go through the same review that would notice this
 * line. (`ConfigFacet`'s SETTER ceiling is a different, higher number —
 * 9,000 — which is exactly why the clamp is needed.)
 */
const APPLIED_DISCOUNT_CEILING_BPS = 5000;

/**
 * The knobs the marketing pages quote, mapped from the display bundle.
 * Field names match what `<LiveValue>`'s registry reads, so the two
 * cannot drift apart silently — a rename breaks the build.
 */
export interface MarketingProtocolConfig {
  /** Yield fee on lender interest, BPS. Bundle index 0. */
  treasuryFeeBps: number;
  /** Borrower loan-initiation fee, BPS. Bundle index 1. */
  loanInitiationFeeBps: number;
  /** Tier minimums in WHOLE VPFI, T1..T4. Bundle index 7 (wei). */
  tierThresholdsTokens: [number, number, number, number];
  /** Per-tier discount, BPS, T1..T4. Bundle index 8. */
  tierDiscountBps: [number, number, number, number];
}

/**
 * The serializer emits bigints as DECIMAL STRINGS. Accept those and
 * plain integers, and nothing else.
 *
 * The strictness is load-bearing for the thresholds specifically: an
 * 18-decimal value that arrived as a JSON number has already lost
 * precision before this function could see it, so coercing whatever
 * turned up would render a confidently wrong tier table. Rejecting
 * falls back to the bundled default, which is the safe direction.
 */
function asBigInt(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

/**
 * Narrow a bigint to a `number` ONLY where the cast is exact.
 *
 * `asBigInt` happily accepts an arbitrarily long decimal string — that
 * is correct for a bigint and wrong for what happens next. `Number(…)`
 * on a large one silently rounds, and past ~1.8e308 yields `Infinity`,
 * which `bpsAsPct` would render as `∞%` with a `published` provenance
 * badge on it. A value that cannot survive the cast is a malformed
 * payload, and malformed payloads take the bundled default.
 */
function toSafeNumber(v: bigint | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function asBpsQuad(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const out = value.map((v) => toSafeNumber(asBigInt(v)));
  if (out.some((v) => v === null)) return null;
  return out as [number, number, number, number];
}

function asTokenQuad(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const out = value.map(asBigInt);
  if (out.some((v) => v === null)) return null;
  // Divide in BIGINT space before the Number cast. `Number(100_000n *
  // 10n ** 18n)` silently rounds past 2^53; dividing first keeps the
  // whole-token figure exact, which is the one a reader sees.
  const scale = 10n ** VPFI_DECIMALS;
  // ...but that division FLOORS, and `ConfigFacet.setVpfiTierThresholds`
  // permits a threshold that is not a whole multiple of 1e18. A
  // configured 100.9 VPFI would publish as "100 VPFI" wearing the
  // `published` badge — a documented eligibility boundary that is simply
  // wrong, and wrong in the direction that tells a reader they qualify
  // when they do not. The display format for these is whole tokens
  // (`format: 'count'`, zero fraction digits), so there is nowhere to
  // put the remainder even if we kept it.
  //
  // So reject rather than truncate. That drops the whole bundle to
  // bundled defaults, which is the same all-or-nothing rule the decoder
  // already applies elsewhere: a figure the site cannot state exactly is
  // one it should not state as live.
  if (out.some((v) => v! % scale !== 0n)) return null;
  const tokens = out.map((v) => toSafeNumber(v! / scale));
  if (tokens.some((v) => v === null)) return null;
  return tokens as [number, number, number, number];
}

/** Map a display bundle onto the knobs the docs quote, or `null` if any
 *  field fails to decode. All-or-nothing on purpose: a half-decoded
 *  config would show live figures beside build-time ones with no way
 *  for a reader to tell which is which. */
export function decodeMarketingConfig(
  bundle: unknown,
): MarketingProtocolConfig | null {
  if (!Array.isArray(bundle) || bundle.length < 9) return null;
  const treasuryFeeBps = toSafeNumber(asBigInt(bundle[0]));
  const loanInitiationFeeBps = toSafeNumber(asBigInt(bundle[1]));
  const tierThresholdsTokens = asTokenQuad(bundle[7]);
  // The bundle carries the CONFIGURED per-tier discount, which
  // `ConfigFacet.setVpfiTierDiscountBps` permits up to 9,000 BPS. What a
  // user actually receives is clamped to `LibVaipakam.MAX_FEE_DISCOUNT_BPS`
  // (5,000) by `getEffectiveDiscount` and every fee path. Publishing the
  // raw figure would advertise a 60% discount that reduces fees by 50%
  // across all 134 documentation references — a promise the protocol does
  // not keep. The docs describe the discount a user GETS, so publish the
  // applied value.
  const rawDiscountBps = asBpsQuad(bundle[8]);
  const tierDiscountBps = rawDiscountBps?.map((v) =>
    Math.min(v, APPLIED_DISCOUNT_CEILING_BPS),
  ) as [number, number, number, number] | undefined ?? null;
  if (
    treasuryFeeBps === null ||
    loanInitiationFeeBps === null ||
    tierThresholdsTokens === null ||
    tierDiscountBps === null
  ) {
    return null;
  }
  return {
    treasuryFeeBps,
    loanInitiationFeeBps,
    tierThresholdsTokens,
    tierDiscountBps,
  };
}

/** Exported for the render guard: the freshness rule, stated once. */
export function snapshotFresh(updatedAt: unknown): boolean {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return false;
  const ageSeconds = Date.now() / 1000 - updatedAt;
  // A NEGATIVE age is not "very fresh", it is a broken clock or a
  // timestamp emitted in the wrong unit — milliseconds instead of
  // seconds puts `updatedAt` ~55,000 years ahead, and `age < WINDOW`
  // would then be true forever, pinning a wedged row as `published`
  // permanently. That is the precise failure this window exists to
  // prevent, so a future-dated row is refused rather than trusted.
  // The small tolerance absorbs ordinary clock skew between the
  // indexer and the reader's machine.
  if (ageSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) return false;
  return ageSeconds < FRESH_WINDOW_SECONDS;
}

/**
 * Fetch and validate one published snapshot.
 *
 * Returns the decoded config plus the timestamp it was accepted on, or
 * `null` for every failure — unreachable, non-2xx, unavailable, stale,
 * undecodable. The caller decides what a `null` means: the hook renders
 * bundled defaults and says so, the build script refuses to publish.
 *
 * The acceptance rule is the SAME one the hook applied inline, moved
 * rather than rewritten: `available === true`, a fresh `updatedAt`, and
 * an all-or-nothing decode.
 */
export async function fetchProtocolConfigSnapshot(opts: {
  origin: string;
  chainId: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<{ config: MarketingProtocolConfig; updatedAt: number } | null> {
  const { origin, chainId, timeoutMs } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(`${origin.replace(/\/+$/, '')}/config/${chainId}`, {
      headers: { accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as { available?: unknown }).available !== true ||
      !snapshotFresh((body as { updatedAt?: unknown }).updatedAt)
    ) {
      return null;
    }
    const config = decodeMarketingConfig((body as { bundle?: unknown }).bundle);
    if (config === null) return null;
    return { config, updatedAt: (body as { updatedAt: number }).updatedAt };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
