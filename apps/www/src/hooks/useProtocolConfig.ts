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
 * Human name for the nominated chain, DERIVED from the configured id —
 * never written as a literal where the id is configurable, or an env
 * change to another deployment would leave every provenance tooltip
 * naming the wrong network (#1664 item 4). Each supported network runs
 * an independent Diamond with independently tunable knobs, so "the
 * published configuration" without a chain name under-specifies which
 * deployment a figure describes the moment two chains are retuned
 * apart. An id outside this map falls back to naming itself, which is
 * ugly and honest — the reader learns exactly which deployment was
 * consulted rather than a prettier guess.
 */
const CHAIN_NAMES: Record<number, string> = {
  8453: 'Base',
  84532: 'Base Sepolia',
  1: 'Ethereum',
  11155111: 'Sepolia',
  137: 'Polygon',
  42161: 'Arbitrum',
  421614: 'Arbitrum Sepolia',
  10: 'Optimism',
  11155420: 'OP Sepolia',
};

/** The chain the documented figures describe, e.g. "Base Sepolia". */
export const DOCS_CHAIN_LABEL = CHAIN_NAMES[DOCS_CHAIN_ID] ?? `chain ${DOCS_CHAIN_ID}`;

// Decode, freshness and the fetch itself now live in a REACT-FREE
// module (#1664 item 3): the build script that writes `/docs/*.md` and
// `llms-full.txt` needs the same logic, and a build script importing a
// hook is the wrong shape. Re-exported here so existing importers of
// `decodeMarketingConfig` / `snapshotFresh` are unaffected.
import {
  FRESH_WINDOW_SECONDS,
  decodeMarketingConfig,
  snapshotFresh,
  fetchProtocolConfigSnapshot,
  type MarketingProtocolConfig,
} from '../lib/protocolConfigSnapshot';

export {
  decodeMarketingConfig,
  snapshotFresh,
  fetchProtocolConfigSnapshot,
  type MarketingProtocolConfig,
};

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
/** `updatedAt` of the snapshot `config` was accepted from — the input to
 *  the same freshness rule at REVALIDATION time that gated acceptance,
 *  so a snapshot cannot keep `published` provenance past the window
 *  just because it was fresh when it arrived (#1664 item 6). */
let acceptedUpdatedAt: number | null = null;
/** Whether at least one load has CONCLUDED. Until then the marker may
 *  honestly say `pending`; after a conclusion, a background revalidation
 *  keeps the previous conclusion on display rather than flickering to
 *  `pending` — the store still HAS a conclusion while it re-checks. */
let hasConcluded = false;
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
  // The store's conclusion, exposed as a document-level fact — the same
  // philosophy as `data-live-value-source` on each figure (#1623: the
  // attribute is the fact; prose is prose). A live-review drive needs to
  // know whether THIS document accepted a snapshot, and every document
  // fetches independently; without this, an external check can only
  // re-implement the acceptance conditions (status, `available`,
  // freshness, full field-level decode) and drift from them — a probe
  // did exactly that and was wrong twice (#1778 rounds 4-5). `pending`
  // while the fetch is in flight, then `published` or `bundled` as the
  // store itself concluded. Guarded: the store is imported during
  // prerender where no document exists.
  if (typeof document !== 'undefined') {
    const concludedSource = config ? 'published' : 'bundled';
    document.documentElement.dataset.protocolConfig =
      loading && !hasConcluded ? 'pending' : concludedSource;
  }
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
        acceptedUpdatedAt =
          config !== null ? ((body as { updatedAt: number }).updatedAt) : null;
      }
    }
  } catch {
    // Deliberately silent, and this now also swallows the abort above.
    // There is nothing a reader of a docs page can do about an
    // unreachable or unresponsive indexer, and the page still renders
    // its bundled defaults. Logging here would put a red error in the
    // console of a perfectly working page.
  } finally {
    // A held snapshot that has aged past the freshness window must not
    // keep claiming published provenance just because this refresh
    // failed to replace it. Acceptance requires freshness, so a config
    // accepted THIS round always survives; only a stale hold is
    // demoted — to the same bundled fallback a failed first read gets,
    // which is the honest description of what the page then knows.
    if (config !== null && !snapshotFresh(acceptedUpdatedAt)) {
      config = null;
      acceptedUpdatedAt = null;
    }
    clearTimeout(timer);
    loading = false;
    hasConcluded = true;
    // Re-arm (or clear) the expiry deadline for whatever this load
    // concluded: a fresh acceptance schedules its own aging-out; a
    // demotion or failure leaves no timer, because there is nothing
    // held whose expiry could need acting on.
    armExpiryTimer();
    publish();
  }
}

/** A read is worth (re)trying when none is in flight and the store
 *  either holds nothing (the first read failed) or holds a snapshot
 *  that has aged past the freshness window. A fresh, accepted snapshot
 *  triggers nothing — navigation must not turn into request traffic. */
function needsRevalidation(): boolean {
  return !loading && (config === null || !snapshotFresh(acceptedUpdatedAt));
}

/** One DEADLINE timer, armed at acceptance for the moment the held
 *  snapshot crosses the freshness window. Without it, a tab that stays
 *  visible with no navigation never re-evaluates `snapshotFresh` after
 *  acceptance, and the displayed values keep `published` provenance
 *  past the cutoff — the exact indefinite hold the spec forbids
 *  (Codex #1809 r1 P2).
 *
 *  The deadline is a WALL-CLOCK moment (`snapshotFresh` compares
 *  against `Date.now()`), but `setTimeout` counts MONOTONIC time, and
 *  the two disagree whenever the clock is corrected or the machine
 *  sleeps. Both directions bit in review: a backward correction fires
 *  the timer while the snapshot still reads fresh (r2 P2), and a
 *  forward correction — most commonly a laptop sleeping with the tab
 *  visible throughout, so no `visibilitychange` fires either — expires
 *  the snapshot while the timer's countdown stands still (r3 P2). So
 *  no single slice is trusted for the whole window: each armed slice
 *  is capped, and every firing re-reads the wall clock — demote/reload
 *  if the deadline has truly passed, re-arm for the recomputed
 *  remainder if not. The wakeups are bounded (at most one per slice)
 *  and make NO network request; the read still happens only at expiry.
 *  Background tabs may throttle timers arbitrarily; the
 *  `visibilitychange` path covers those on return, and the timer
 *  covers the visible-idle case timers are reliable for. */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Longest slice the deadline timer trusts before re-reading the wall
 *  clock: bounds how long a forward clock jump (sleep/resume, NTP) can
 *  keep an already-expired snapshot on display at ~1h, at the cost of
 *  at most `FRESH_WINDOW / slice` zero-network wakeups per window. */
const MAX_TIMER_SLICE_MS = 3_600_000;

function armExpiryTimer(): void {
  if (typeof window === 'undefined') return;
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  if (config === null || acceptedUpdatedAt === null) return;
  const expiresAtMs = (acceptedUpdatedAt + FRESH_WINDOW_SECONDS) * 1000;
  // +1s so the check runs just AFTER the boundary — firing on the exact
  // millisecond would race `snapshotFresh`'s own comparison.
  const delay = Math.min(Math.max(0, expiresAtMs - Date.now()) + 1_000, MAX_TIMER_SLICE_MS);
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    if (needsRevalidation()) {
      void load();
    } else if (!loading) {
      // The deadline has not actually arrived — this was a capped
      // intermediate slice, or the wall clock moved backward past the
      // cushion. Re-arm for the recomputed remainder; the delay is
      // always ≥1s, so this cannot spin. (If a load is in flight
      // instead, its conclusion re-arms; arming here off the pre-load
      // state would tick uselessly until it ends.)
      armExpiryTimer();
    }
  }, delay);
}

/** Registered once: returning to a long-lived tab is the other natural
 *  moment to re-check (#1664 item 6) — without it, a tab left in the
 *  background for a day keeps a by-then-stale snapshot on display with
 *  no navigation to trigger the subscribe-path retry. */
let visibilityHooked = false;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!started) {
    started = true;
    if (typeof document !== 'undefined' && !visibilityHooked) {
      visibilityHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && needsRevalidation()) {
          void load();
        }
      });
    }
    void load();
  } else if (needsRevalidation()) {
    // A later subscription — a new page in the same document — retries
    // a failed first read and refreshes an aged-out snapshot, instead
    // of the session being pinned forever to its first attempt
    // (#1664 item 6). The `loading` gate inside `needsRevalidation`
    // means a page mounting a dozen `<LiveValue>`s still causes at
    // most one request.
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
