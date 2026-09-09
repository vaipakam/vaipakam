/**
 * Analytics — the public transparency dashboard (#1959).
 *
 * WHY IT LIVES HERE. `/analytics` was served by the retired `apps/defi`
 * and was one of two surfaces the #1854 cutover did not port, which is
 * why `defi.vaipakam.com` could not be retired: the marketing site links
 * here, and pointing those links at an app that had no such route would
 * have landed visitors on an in-shell not-found.
 *
 * WALLET-FREE ON PURPOSE. Every figure comes from the indexer's keyless,
 * open-CORS read API — the same endpoints any third party can call. That
 * is the page's whole claim: a number a visitor cannot reproduce
 * independently is a number they have to take on trust, which is the
 * opposite of transparency. So this page must render fully for someone
 * who has never connected a wallet, and it does.
 *
 * ABSENT IS NOT ZERO. Every counter is optional on the wire. When the
 * indexer does not report a field, this renders "not reported" rather
 * than 0 — on a page whose entire purpose is accuracy, a fabricated zero
 * is worse than an admitted gap, and the two are indistinguishable to a
 * reader once rendered.
 *
 * THE FRESHNESS LINE IS NOT DECORATION. Every figure here is as old as
 * the indexer's last ingest, so the cursor's age is stated beside the
 * numbers rather than buried. A dashboard that shows stale figures
 * without saying they are stale is misleading in exactly the way this
 * page exists to avoid — and "unknown" is kept distinct from "fresh",
 * because an unreachable indexer must never read as an up-to-date one.
 */
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import {
  BarChart3,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import {
  CLOCK_SKEW_ALLOWANCE_SEC,
  fetchLoanStats,
  fetchOfferStats,
  indexerConfigured,
  type LoanStats,
  type OfferStats,
} from '../data/indexer';
import { useActiveChain } from '../chain/useActiveChain';
import { useNowSec } from '../hooks/useNowSec';
import { idleAware } from '../lib/idle';
import { useEffect, useRef } from 'react';

/** Renders a counter, keeping "not reported" distinct from zero. */
/** The lagging of two indexer cursors, or whichever one exists.
 *
 *  Compared on `lastBlock` when both report one, since that is what the
 *  provenance line actually claims coverage through; `updatedAt` breaks
 *  the tie only when the blocks match, and a cursor missing `lastBlock`
 *  cannot be compared at all so the other one stands. */
export function olderCursor<T extends { lastBlock?: number; updatedAt?: number }>(
  a: T | null,
  b: T | null,
): T | null {
  if (a === null) return b;
  if (b === null) return a;
  const ab = a.lastBlock;
  const bb = b.lastBlock;
  if (typeof ab !== 'number') return typeof bb === 'number' ? b : a;
  if (typeof bb !== 'number') return a;
  if (ab !== bb) return ab < bb ? a : b;
  const au = a.updatedAt ?? Number.POSITIVE_INFINITY;
  const bu = b.updatedAt ?? Number.POSITIVE_INFINITY;
  return au <= bu ? a : b;
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  const reported = typeof value === 'number';
  return (
    <div className="an-stat">
      <div className="an-stat-value" data-reported={reported}>
        {reported ? value.toLocaleString() : '—'}
      </div>
      <div className="an-stat-label">{label}</div>
      {!reported && <div className="an-stat-note">{copy.analytics.notReported}</div>}
    </div>
  );
}

/**
 * How old the last ingest is, against a clock the CALLER supplies.
 *
 * `nowSec` is a parameter rather than a `Date.now()` read inside here on
 * purpose. Reading the clock during render freezes the answer at whenever
 * React happened to render: a visitor who leaves this page open would sit
 * on "12s ago" for hours, which is worse than showing no age at all —
 * this page states the age precisely so that stale figures cannot pass as
 * current, and a frozen age is the failure it exists to prevent, wearing
 * the mask of the fix. `useNowSec` is the app's existing ticking clock and
 * its own docstring names this exact bug.
 */
function ageLabel(updatedAtSec: number | undefined, nowSec: number): string {
  if (typeof updatedAtSec !== 'number') return copy.analytics.unknown;
  const secs = nowSec - updatedAtSec;
  // A STAMP FROM THE FUTURE IS UNKNOWN, NOT BRAND NEW (review round 22
  // P2). `Math.max(0, …)` turned a negative age into "0s ago" — so a
  // skewed or corrupted timestamp was rendered as the most current
  // reading this page can show, which is the precise inverse of the
  // rule it exists to honour: an unknown age must never pass as a fresh
  // one. A small allowance keeps ordinary clock differences readable.
  if (secs < -CLOCK_SKEW_ALLOWANCE_SEC) return copy.analytics.unknown;
  if (secs < 0) return copy.analytics.ageSeconds(0);
  if (secs < 90) return copy.analytics.ageSeconds(secs);
  if (secs < 5400) return copy.analytics.ageMinutes(Math.round(secs / 60));
  return copy.analytics.ageHours(Math.round(secs / 3600));
}

export function Analytics() {
  // READ CHAIN, not `useChainId()`. This page is a marketing deep-link
  // target, so most arrivals have NO wallet — and `useChainId()` reports
  // mainnet (1) for them, which is not a chain this deployment indexes.
  // The result was an empty page for exactly the audience it is for.
  // `readChain` is the app's "where reads land when disconnected"
  // resolution, honouring VITE_DEFAULT_CHAIN_ID.
  const { readChain } = useActiveChain();
  const chainId = readChain.chainId;
  // Ticks, so the freshness line below keeps telling the truth for a
  // visitor who leaves the page open.
  const nowSec = useNowSec();

  // useQuery, not useEffect+setState. Beyond matching how every other
  // async surface here loads, the effect form trips
  // `react-hooks/set-state-in-effect` — the rule exists because a
  // synchronous setState in an effect body cascades renders.
  const stats = useQuery({
    queryKey: ['analytics-stats', chainId],
    enabled: indexerConfigured(),
    // AUTO-REFRESH AT THE `cool` TIER, and no manual button (review
    // round 7 P2). The connected-app spec is explicit on both halves:
    // public Analytics "should not expose a spam-clickable manual
    // refresh button; it should auto-refresh", and Analytics sits at
    // `cool` — 180 seconds active — among the named watermark tiers.
    // This page shipped with the exact inverse: a click-to-refresh
    // control and no interval at all, so a visitor who left it open saw
    // counters frozen indefinitely on a page whose stated purpose is
    // showing the current state of the protocol.
    //
    // `idleAware` is how every other polling surface here honours "pause
    // while the tab is hidden and catch up on focus": TanStack already
    // suspends interval refetches on a hidden tab and refetches on
    // focus, and this stretches the cadence further once the session
    // goes quiet without a timer of its own.
    refetchInterval: idleAware(180_000),
    queryFn: async (): Promise<{ loans: LoanStats | null; offers: OfferStats | null }> => {
      const [loans, offers] = await Promise.all([
        fetchLoanStats(chainId),
        fetchOfferStats(chainId),
      ]);
      return { loans, offers };
    },
  });

  const loans = stats.data?.loans ?? null;
  const offers = stats.data?.offers ?? null;
  // BOTH null means the endpoint did not answer. One null is a partial
  // read and still worth rendering — half a picture beats none, as long
  // as the missing half reads as missing rather than as zero.
  const unreachable =
    !indexerConfigured() ||
    stats.isError ||
    (stats.isSuccess && loans === null && offers === null);

  // NO CURSOR MEANS NOTHING HAS BEEN INDEXED — which is not the same
  // fact as "nothing has happened" (review round 2 P2). A fresh, reset
  // or mid-backfill database answers both endpoints successfully with
  // every counter at zero and no cursor at all. Those objects are
  // non-null, so without this the page rendered a full board of
  // authoritative-looking zeros for a deployment that may have years of
  // history the indexer simply has not read yet.
  //
  // That is the one failure this page cannot afford. It exists so a
  // reader does not have to take a number on trust, and "0 defaulted"
  // sourced from an empty database is the most reassuring number here
  // and the least earned. The freshness line cannot rescue it either:
  // with no cursor there is no age to state.
  // OLDEST WINS WHEN COMBINING TWO SOURCES (round 41 P2). This used to
  // take the first cursor that existed, so the page could state its
  // freshness from the offers response while the loans counters came
  // from an older read — presenting one dataset's coverage as though it
  // covered both. When a claim spans two responses, only the LAGGING one
  // is true of the whole.
  //
  // Still an app-side floor rather than a guarantee: each endpoint reads
  // its aggregates and its cursor in separate queries, so an ingest
  // committing between them returns pre-ingest counters with a
  // post-ingest cursor. Fixing that means capturing the cursor BEFORE
  // the aggregates, or binding both to one snapshot, inside the indexer
  // — tracked separately. Taking the oldest cannot repair a cursor that
  // is already ahead of its own counters; it only stops the page
  // borrowing the fresher of two.
  const cursor = olderCursor(offers?.indexer ?? null, loans?.indexer ?? null);
  const uninitialized =
    !unreachable && stats.isSuccess && typeof cursor?.lastBlock !== 'number';

  /** Active loans the indexer counted but could not type, because the
   *  row still carries the `'0x'` lending-asset placeholder. Derived
   *  from one response so the arithmetic is internally consistent, and
   *  `undefined` unless every input is present — a residual computed
   *  against a missing counter would be a figure this page invented.
   *  Clamped at zero: a negative difference would mean the endpoint
   *  contradicted itself, which is not something to render as a count. */
  const unclassifiedActive =
    typeof loans?.active === 'number' &&
    typeof loans?.erc20ActiveLoans === 'number' &&
    typeof loans?.nftRentalsActive === 'number'
      ? Math.max(
          0,
          loans.active - loans.erc20ActiveLoans - loans.nftRentalsActive,
        )
      : undefined;

  // PENDING IS NOT AN ANSWER. Before the first response settles, both
  // `isSuccess` and `isError` are false, so every counter fell through to
  // "not reported" — a statement ABOUT THE SOURCE made before the source
  // had been heard from. On a slow connection a visitor was told the
  // indexer had omitted fields it was still in the middle of sending.
  // Loading is its own posture and says only that.
  const loading = indexerConfigured() && stats.isPending;

  // RE-SCROLL TO THE LAZY TARGET (review round 7 P2). The marketing
  // footer links `/analytics#transparency`, but this route is lazy: on a
  // cold navigation the browser resolves the fragment against the SPA
  // shell and the loading fallback, neither of which contains a
  // `transparency` element, and React Router does not replay fragment
  // scrolling once the chunk mounts. So the "Smart Contracts" link
  // landed readers at the top of the dashboard rather than at the
  // contract address it promises — the same defect the `/vpfi#deposit`
  // anchor had, one route over.
  //
  // AT MOST ONE SCROLL PER FRAGMENT (review round 16 P2).
  //
  // The posture flags stay in the dependency list because some targets
  // mount late — `#an-loans` / `#an-offers` live inside the data-loaded
  // branch, so an effect that ran only on mount could never reach them.
  // But `#transparency`, the fragment the marketing site actually links,
  // is a sibling of those guards and exists on the FIRST render. It was
  // therefore scrolled to immediately and then again when the request
  // settled up to four seconds later — long enough for a reader to have
  // started reading, or to have followed the explorer link, before being
  // yanked back to where they had already been put once.
  //
  // Recording the fragment once it has been scrolled keeps the late
  // mount working and makes the second scroll impossible. A ref, not
  // state: nothing renders from it, and a re-render here is what caused
  // the bug.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* malformed escape — fall back to the raw fragment */
    }
    if (scrolledTo.current === id) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return; // target not mounted yet — a later posture retries
      scrolledTo.current = id;
      el.scrollIntoView();
    });
    return () => cancelAnimationFrame(raf);
  }, [loading, unreachable, uninitialized]);

  return (
    <div className="an-page">
      <header className="an-head">
        <h1>
          <BarChart3 aria-hidden="true" /> {copy.analytics.title}
        </h1>
        <p className="an-sub">
          {copy.analytics.lede(chainId)}
        </p>
        {/*
          NO MANUAL REFRESH CONTROL. The spec reserves those for pages
          where a user inspects mutable lists; this page auto-refreshes
          and states its data age instead, which is the honest signal —
          a refresh button invites clicking at a figure that is already
          as current as the last ingest.
        */}
      </header>

      {loading && (
        <p className="an-unreachable" role="status">
          <RefreshCw aria-hidden="true" /> {copy.analytics.loading}
        </p>
      )}

      {unreachable && (
        <p className="an-unreachable" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.analytics.unreachable}
        </p>
      )}

      {uninitialized && (
        <p className="an-unreachable" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.analytics.uninitialized}
        </p>
      )}

      {/*
        COUNTERS ONLY. What follows is behind the stats guard because it
        is what the indexer told us; the transparency section below is
        NOT, because it is not.
      */}
      {!loading && !unreachable && !uninitialized && (
        <>
          <section className="an-section" aria-labelledby="an-loans">
            <h2 id="an-loans">{copy.analytics.loansHeading}</h2>
            <div className="an-grid">
              <Stat label={copy.analytics.active} value={loans?.active} />
              <Stat label={copy.analytics.repaid} value={loans?.repaid} />
              <Stat label={copy.analytics.defaulted} value={loans?.defaulted} />
              <Stat label={copy.analytics.liquidated} value={loans?.liquidated} />
              <Stat label={copy.analytics.settled} value={loans?.settled} />
              {/*
                RENDERED BECAUSE `total` COUNTS THEM. These are normal
                lifecycle states; leaving them out made Total exceed
                every visible bucket combined, which a reader could see
                and not explain — the opposite of what this page is for.
              */}
              <Stat label={copy.analytics.fallbackPending} value={loans?.fallbackPending} />
              <Stat label={copy.analytics.internalMatched} value={loans?.internalMatched} />
              <Stat label={copy.analytics.other} value={loans?.other} />
              <Stat label={copy.analytics.total} value={loans?.total} />
            </div>
            {/* Round 41 P2 — these two do NOT have to sum to `Active`,
                and rendering them alone made them look as though they
                did. The indexer excludes rows whose `lending_asset` is
                still the `'0x'` placeholder from both subtotals while
                counting them in `active`, and says so in its own
                comment: "the subtotals may sum to less than `active`
                while metadata-less rows await healing… undercounting a
                type is an admitted gap, misfiling it is a false
                statement."

                It is the right call server-side, and this page was
                dropping the admission. A reader could subtract and find
                a gap with nothing on the page to explain it — which on
                a transparency surface is worse than the gap. The
                residual is now shown whenever it is non-zero, and only
                when all three inputs are present, since a difference
                computed from a missing counter would be invented. */}
            <div className="an-grid an-grid-sub">
              <Stat label={copy.analytics.erc20Active} value={loans?.erc20ActiveLoans} />
              <Stat label={copy.analytics.nftRentalsActive} value={loans?.nftRentalsActive} />
              {unclassifiedActive !== undefined && unclassifiedActive > 0 ? (
                <Stat
                  label={copy.analytics.unclassifiedActive}
                  value={unclassifiedActive}
                />
              ) : null}
            </div>
            {unclassifiedActive !== undefined && unclassifiedActive > 0 ? (
              <p className="an-note">{copy.analytics.unclassifiedActiveNote}</p>
            ) : null}
          </section>

          <section className="an-section" aria-labelledby="an-offers">
            <h2 id="an-offers">{copy.analytics.offersHeading}</h2>
            {/* Round 28 P2 — these counts read the `offers` table only.
                A gasless maker order lives in `signed_offers` and is
                served as executable liquidity by the offer book and the
                Rate Desk's depth, so an unqualified "Active" here
                undercounts what a visitor can actually see and fill.
                Labelling rather than unioning: the two are different
                things (one is on-chain state, the other a signed
                intention nobody has spent gas on), and a transparency
                page that quietly merges them is less honest than one
                that says which it is counting. */}
            <p className="muted an-scope">{copy.analytics.offersScope}</p>
            <div className="an-grid">
              <Stat label={copy.analytics.active} value={offers?.active} />
              <Stat label={copy.analytics.accepted} value={offers?.accepted} />
              <Stat label={copy.analytics.cancelled} value={offers?.cancelled} />
              <Stat label={copy.analytics.expired} value={offers?.expired} />
              <Stat label={copy.analytics.consumedBySale} value={offers?.consumedBySale} />
              <Stat label={copy.analytics.fullyFilled} value={offers?.fullyFilled} />
              <Stat
                label={copy.analytics.activeUnknownExpiry}
                value={offers?.activeUnknownExpiry}
              />
              <Stat label={copy.analytics.other} value={offers?.other} />
              <Stat label={copy.analytics.total} value={offers?.total} />
            </div>
            {/* The offer Total is NOT a lifetime figure and must not be
                read as one (review round 16 P2): cancelled offers are
                pruned from the index past the retention window, so both
                Cancelled and Total fall as old cancellations age out.
                Stated here rather than left for a reader to discover by
                watching a "Total" go backwards. */}
            <p className="an-note">{copy.analytics.offersRetentionNote}</p>
          </section>
        </>
      )}

      {/*
        THE DEEP-LINK TARGET, AND DELIBERATELY OUTSIDE EVERY GUARD ABOVE.
        The marketing site links to `/analytics#transparency` and labels
        that resource "Smart Contracts", so this id is load-bearing: drop
        it and the CTA lands at the top of the page instead of the
        section it promised.

        Round 2 added the contract address here; round 3 caught that it
        had been added INSIDE the stats-success guard, so an indexer
        outage or a fresh database took the address and the explorer link
        away with the counters — the "Smart Contracts" link arriving at
        no contract again, in precisely the conditions where a reader is
        most likely to want to check the chain themselves.
        `readChain` is local config: the address, the chain and the
        explorer are known whether or not any endpoint answers, so they
        are stated unconditionally. Only the two indexer-sourced facts
        below degrade, and they degrade to "unknown" rather than
        vanishing.
      */}
      <section className="an-section" id="transparency" aria-labelledby="an-transparency">
        <h2 id="an-transparency">
              <ShieldCheck aria-hidden="true" /> {copy.analytics.transparencyHeading}
            </h2>
            <p>
              {copy.analytics.transparencyBody}
            </p>
            {/*
              THE CONTRACT ITSELF. The marketing footer routes its
              "Smart Contracts" resource here, and until review round 2
              this section answered with indexer provenance and a chain
              number — nothing a reader could actually verify a contract
              against. Someone following a link labelled "Smart
              Contracts" wants the address and a way to open it, so
              state both, and put them ABOVE the indexer facts: the
              chain is the primary source, and the indexer is a
              second-hand reading of it.
            */}
            <dl className="an-facts">
              <dt>{copy.analytics.contractLabel}</dt>
              <dd>
                <a
                  className="an-addr"
                  href={`${readChain.blockExplorer}/address/${readChain.diamondAddress}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {readChain.diamondAddress} <ExternalLink aria-hidden="true" />
                </a>
              </dd>
              <dt>{copy.analytics.chain}</dt>
              <dd>
                {readChain.name} ({chainId})
              </dd>
              <dt>{copy.analytics.cursorBlock}</dt>
              <dd>
                {typeof cursor?.lastBlock === 'number'
                  ? cursor.lastBlock.toLocaleString()
                  : copy.analytics.unknown}
              </dd>
              <dt>{copy.analytics.lastIngest}</dt>
              <dd>{ageLabel(cursor?.updatedAt, nowSec)}</dd>
            </dl>
            <p className="an-caveat">
              {copy.analytics.caveat}
            </p>
          </section>
    </div>
  );
}
