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

/** The published indexer origin. Overridable for previews. */
const INDEXER_ORIGIN = env?.VITE_INDEXER_ORIGIN ?? 'https://indexer.vaipakam.com';

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

/** VPFI is 18 decimals on every deploy — required by the bridge spec,
 *  and the connected app's own fallback when its `decimals()` read
 *  fails. Reading it live would need the chain client this file exists
 *  to avoid. */
const VPFI_DECIMALS = 18n;

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

function asBpsQuad(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const out = value.map(asBigInt);
  if (out.some((v) => v === null)) return null;
  return out.map((v) => Number(v)) as [number, number, number, number];
}

function asTokenQuad(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const out = value.map(asBigInt);
  if (out.some((v) => v === null)) return null;
  // Divide in BIGINT space before the Number cast. `Number(100_000n *
  // 10n ** 18n)` silently rounds past 2^53; dividing first keeps the
  // whole-token figure exact, which is the one a reader sees.
  const scale = 10n ** VPFI_DECIMALS;
  return out.map((v) => Number(v! / scale)) as [number, number, number, number];
}

/** Map a display bundle onto the knobs the docs quote, or `null` if any
 *  field fails to decode. All-or-nothing on purpose: a half-decoded
 *  config would show live figures beside build-time ones with no way
 *  for a reader to tell which is which. */
export function decodeMarketingConfig(
  bundle: unknown,
): MarketingProtocolConfig | null {
  if (!Array.isArray(bundle) || bundle.length < 9) return null;
  const treasuryFeeBps = asBigInt(bundle[0]);
  const loanInitiationFeeBps = asBigInt(bundle[1]);
  const tierThresholdsTokens = asTokenQuad(bundle[7]);
  const tierDiscountBps = asBpsQuad(bundle[8]);
  if (
    treasuryFeeBps === null ||
    loanInitiationFeeBps === null ||
    tierThresholdsTokens === null ||
    tierDiscountBps === null
  ) {
    return null;
  }
  return {
    treasuryFeeBps: Number(treasuryFeeBps),
    loanInitiationFeeBps: Number(loanInitiationFeeBps),
    tierThresholdsTokens,
    tierDiscountBps,
  };
}

/** Exported for the render guard: the freshness rule, stated once. */
export function snapshotFresh(updatedAt: unknown): boolean {
  return (
    typeof updatedAt === 'number' &&
    Date.now() / 1000 - updatedAt < FRESH_WINDOW_SECONDS
  );
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

async function load() {
  loading = true;
  publish();
  try {
    const res = await fetch(`${INDEXER_ORIGIN}/config/${DOCS_CHAIN_ID}`, {
      headers: { accept: 'application/json' },
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
    // Deliberately silent. There is nothing a reader of a docs page can
    // do about an unreachable indexer, and the page still renders its
    // bundled defaults. Logging here would put a red error in the
    // console of a perfectly working page.
  } finally {
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
} {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}
