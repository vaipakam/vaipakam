/**
 * Live protocol-config read for the marketing surface (#1612).
 *
 * Until now this was a stub returning `{ config: null }`, so every
 * `{liveValue:…}` figure on the public pages rendered the compile-time
 * default bundled at build time. That was a coherent choice with two
 * costs: the hover tooltip told readers a chain read was "pending or
 * unavailable" when none was ever attempted, and nothing tied the
 * bundled numbers to deployed reality — after a governance retune the
 * public pages would keep stating the old rate until someone
 * remembered to edit the registry.
 *
 * ── Why the indexer snapshot rather than an RPC read ──────────────
 *
 * The obvious implementation is a viem public client against a public
 * RPC. This deliberately does not do that, and the reason is a
 * property of THIS surface rather than a general preference:
 *
 *   - The package is defined as having no wallet, no wagmi and no
 *     on-chain reads. A chain client would pull viem and the Diamond
 *     ABI into a bundle that currently carries neither — the same
 *     ~761 kB of ABI that #1610's UX2-008 work went to some trouble to
 *     keep off first paint on the connected app. Paying that on the
 *     marketing site, whose whole job is loading fast for a stranger,
 *     to render a number that changes once a year, is a bad trade.
 *   - It would need per-chain RPC configuration on a surface that has
 *     none, and public RPC endpoints are the flakiest dependency we
 *     could pick for a page that must render for everyone.
 *   - The platform already publishes exactly this: the indexer's
 *     `GET /config/:chainId` display snapshot, refreshed on governance
 *     events with a slow backstop, served with open CORS, and already
 *     the FIRST source the connected app consults for display figures
 *     (`apps/alpha02/src/data/fees.ts`). Reading it here is one
 *     `fetch` and no new dependency.
 *
 * What that buys, precisely: the figures now follow a retune instead of
 * a release. What it does NOT buy: block-level freshness. The snapshot
 * lags a governance event by roughly one ingest scan. For a fee rate on
 * a marketing page that is the right granularity, and the tooltip says
 * where the number came from rather than implying more than it should.
 *
 * ── Failure is not a failure ──────────────────────────────────────
 *
 * Every unhappy path — indexer down, chain absent from the snapshot,
 * malformed payload, a row too old to trust, server rendering — returns
 * `null`, and `<LiveValue>` renders its bundled default. A doc page
 * must render for a reader who arrives while the indexer is redeploying,
 * so there is no error state to design; the number simply reverts to
 * the one shipped with the build, and the tooltip says so.
 */
import { useSyncExternalStore } from 'react';

/**
 * Vite replaces `import.meta.env.VITE_*` at build time, but this module
 * is also imported OUTSIDE Vite — `scripts/check-live-value-render.tsx`
 * server-renders the real pipeline under plain `tsx`, where
 * `import.meta.env` is `undefined` and a bare property read throws at
 * import time. Optional-chain the object itself, not just the key, so
 * the guard can import what the browser runs rather than a stand-in.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env;

/**
 * The published indexer origin. Overridable for previews.
 *
 * Trailing slashes are stripped, and that is not cosmetic. The Worker
 * dispatches on `/^\/config\/(\d+)$/`, so an origin configured as
 * `https://host/` would build `https://host//config/84532`, miss the
 * route, and 404 — after which this file's own fallback quietly serves
 * bundled defaults. The site would look fine and simply never be live,
 * with no error anywhere and a tooltip correctly reporting the values as
 * bundled. A misconfiguration that presents as "working, just not live"
 * is one nobody goes looking for.
 *
 * `apps/alpha02/src/data/indexer.ts` normalises for the same reason;
 * this strips one-or-more so a doubled slash cannot slip through either.
 */
const INDEXER_ORIGIN = (env?.VITE_INDEXER_ORIGIN ?? 'https://indexer.vaipakam.com').replace(
  /\/+$/,
  '',
);

/**
 * Which deployment the public pages quote. The docs state one set of
 * figures to a reader who has not chosen a network yet, so one chain
 * has to be nominated; this is that nomination, not a guess about the
 * reader. Base Sepolia while the platform is pre-live.
 */
const DOCS_CHAIN_ID = Number(env?.VITE_DOCS_CONFIG_CHAIN_ID ?? '84532');

/**
 * Refuse a snapshot older than a day. Config flips reach the snapshot
 * within about one ingest scan, so a row this stale means the refresh
 * rail is wedged — and a wedged rail serving a confidently wrong number
 * is worse than the bundled default, which at least announces itself as
 * a build-time value. Same window the connected app applies
 * (`protocolConfigFresh`); deliberately the same rule rather than a
 * second opinion about the same rail.
 */
const FRESH_WINDOW_SECONDS = 24 * 3600;

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

// ─── Module-level store ───────────────────────────────────────────────
//
// One fetch per page load, not one per token. A doc page renders a
// dozen `<LiveValue>`s; each calling the hook must not mean a dozen
// requests to the indexer. The store is module-scoped so every instance
// shares the single in-flight promise and re-renders together when it
// settles — which also means they can never disagree mid-render.

let config: MarketingProtocolConfig | null = null;
let loading = false;
let started = false;
const listeners = new Set<() => void>();

/** Stable snapshot object: `useSyncExternalStore` compares by identity,
 *  so returning a fresh `{ config, loading }` each call would loop
 *  forever. Replaced only when something actually changes. */
let snapshot: { config: MarketingProtocolConfig | null; loading: boolean } = {
  config: null,
  loading: false,
};

/** Server rendering never fetches — and must return a value that is
 *  identical across calls, or React warns. The docs render their
 *  bundled defaults in a snapshot, which is correct: a prerendered page
 *  cannot promise a figure fetched after it was written. */
const SERVER_SNAPSHOT: {
  config: MarketingProtocolConfig | null;
  loading: boolean;
} = { config: null, loading: false };

function publish() {
  snapshot = { config, loading };
  for (const l of listeners) l();
}

/**
 * Abort deadline for the snapshot request.
 *
 * Load-bearing for DEPLOYABILITY, not just for page latency. `fetch`
 * without a deadline hangs for as long as the peer holds the connection
 * open, and `scripts/prerender.mjs` snapshots every route × locale with
 * `waitUntil: 'networkidle'` under a 30 s timeout, exiting non-zero if a
 * route misses it. An indexer that accepts connections but stops
 * answering — a partial outage, not even a hard one — would therefore
 * fail the prerender of every route and block every marketing-site
 * deployment. That is a far worse failure than the one this whole file
 * exists to avoid, and it would arrive at the least convenient moment,
 * since the site is most likely to need a deploy when something else is
 * already wrong.
 *
 * Four seconds matches the connected app's indexer client
 * (`apps/alpha02/src/data/indexer.ts`) — deliberately the same number
 * rather than a second opinion about the same rail — and leaves the
 * prerenderer 26 s of headroom to reach networkidle with the bundled
 * default in place.
 */
const REQUEST_TIMEOUT_MS = 4_000;

async function load() {
  loading = true;
  publish();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${INDEXER_ORIGIN}/config/${DOCS_CHAIN_ID}`, {
      headers: { accept: 'application/json' },
      signal: ac.signal,
    });
    if (res.ok) {
      const body: unknown = await res.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        (body as { available?: unknown }).available === true &&
        snapshotFresh((body as { updatedAt?: unknown }).updatedAt)
      ) {
        config = decodeMarketingConfig((body as { bundle?: unknown }).bundle);
      }
    }
  } catch {
    // Deliberately silent, and this now also swallows the abort above.
    // There is nothing a reader of a docs page can do about an
    // unreachable or unresponsive indexer, and the page still renders
    // its bundled defaults. Logging here would put a red error in the
    // console of a perfectly working page.
  } finally {
    clearTimeout(timer);
    loading = false;
    publish();
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!started) {
    started = true;
    void load();
  }
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Read the published protocol config. `config` is `null` until the
 * snapshot resolves and stays `null` on every failure path, which
 * `<LiveValue>` reads as "use the bundled default".
 */
export function useProtocolConfig(): {
  config: MarketingProtocolConfig | null;
  loading: boolean;
  /**
   * Whether this surface ATTEMPTS a read at all — declared, not inferred
   * (#1612, preserved through the #1630 merge).
   *
   * `true` here now that the snapshot is wired. It is kept rather than
   * dropped because the flag is what lets `<LiveValue>` tell "no read was
   * ever made" apart from "the read did not land": both arrive as
   * `config === null`, and collapsing them is precisely the bug #1623
   * fixed — every reader of a public page was told the figure they
   * hovered was a chain read "pending or unavailable" on a surface where
   * nothing was pending and nothing had failed. That distinction still
   * matters for any future surface that opts out of reads.
   */
  chainReads: boolean;
} {
  const store = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
  // Wrapping the store value is safe: the identity churn that
  // `useSyncExternalStore` punishes is in `getSnapshot`, which still
  // returns the stable module-level `snapshot`. This object is ordinary
  // render output.
  return { config: store.config, loading: store.loading, chainReads: true };
}
