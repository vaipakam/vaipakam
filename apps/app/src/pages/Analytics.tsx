/**
 * Analytics — the public transparency dashboard (#1959).
 *
 * WHY IT LIVES HERE. `/analytics` was served by the retired `apps/defi`
 * and was one of two surfaces the #1854 cutover did not port, which is
 * why `defi.vaipakam.com` could not be retired: the marketing site links
 * here, and pointing those links at an app that had no such route would
 * have landed visitors on an in-shell not-found.
 *
 * WALLET-FREE ON PURPOSE. The counters and the recycling account come
 * from the indexer's keyless, open-CORS read API — the same endpoints any
 * third party can call — and the VPFI token and fee figures (#2437) from
 * the Diamond's own view functions over the app's public RPC, at one
 * stated block. That is the page's whole claim: a number a visitor cannot
 * reproduce independently is a number they have to take on trust, which
 * is the opposite of transparency. So this page must render fully for
 * someone who has never connected a wallet, and it does.
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
import { useTranslation } from 'react-i18next';
import { copy } from '../content/copy';
import { resolveActiveSplit } from '../data/activeSplit';
import { isReportedCount } from '../data/reportedCount';
import { localeNumber } from '../lib/format';
import { olderCursor } from '../data/olderCursor';
import {
  BarChart3,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import {
  fetchLoanStats,
  fetchOfferStats,
  indexerConfigured,
  type LoanStats,
  type OfferStats,
} from '../data/indexer';
import { useActiveChain } from '../chain/useActiveChain';
import { RecyclingAccount } from '../components/analytics/RecyclingAccount';
import { LoopClosure } from '../components/analytics/LoopClosure';
import { useNowSec } from '../hooks/useNowSec';
import { ageLabel } from '../components/analytics/ageLabel';
import { ChainFigures } from '../components/analytics/ChainFigures';
import { idleAware } from '../lib/idle';
import { useEffect, useRef } from 'react';

/** Renders a counter, keeping "not reported" distinct from zero.
 *
 *  ROUND 54 P2 — "reported" is `isReportedCount`, not `typeof value ===
 *  'number'`. The weaker test published whatever the endpoint sent,
 *  including a negative or fractional count, on the one page whose claim
 *  is that its figures can be trusted — and it did so while
 *  `resolveActiveSplit` was already refusing to compute anything from
 *  that same value. A figure this page cannot substantiate reads as
 *  "not reported", which is the rule it applies to an absent one and for
 *  the same reason. */
function Stat({ label, value }: { label: string; value: number | undefined }) {
  const reported = isReportedCount(value);
  // ROUND 65 P2 — the APP's language, not the device's. A visitor who
  // picked German on an en-US machine was getting German labels beside
  // English-grouped numbers.
  const { i18n } = useTranslation();
  return (
    <div className="an-stat">
      <div className="an-stat-value" data-reported={reported}>
        {reported ? localeNumber(value, i18n.resolvedLanguage) : '—'}
      </div>
      <div className="an-stat-label">{label}</div>
      {/* Absent and impossible are different facts about the indexer, and
          a page that exists to be audited must not present one as the
          other. `value === undefined` is a gap; anything else reaching
          here arrived and failed `isReportedCount`. */}
      {!reported && (
        <div className="an-stat-note">
          {value === undefined
            ? copy.analytics.notReported
            : copy.analytics.notUsable}
        </div>
      )}
    </div>
  );
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
  // ROUND 65 P2 — the block number below is formatted in the app's
  // language, like every other figure on this page.
  const { i18n } = useTranslation();
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
  //
  // EVERY RENDERED RESPONSE MUST BRING ITS OWN (round 42 P2). A non-null
  // stats response can still carry `indexer: null` — before the first
  // cursor exists, or from an older cached read. Combining them without
  // checking meant the surviving cursor substantiated counters it had
  // never covered: loan figures rendered under the offers read's block.
  // A missing cursor is not a weaker claim to be outvoted, it is the
  // absence of one, so it disqualifies the whole combined statement.
  const cursorsComplete =
    (loans === null || loans === undefined || loans.indexer != null) &&
    (offers === null || offers === undefined || offers.indexer != null);
  const cursor = cursorsComplete
    ? olderCursor(offers?.indexer ?? null, loans?.indexer ?? null)
    : null;
  const uninitialized =
    !unreachable && stats.isSuccess && typeof cursor?.lastBlock !== 'number';

  /** How the active total relates to its typed subtotals — three
   *  answers, not a number.
   *
   *  Owned by `data/activeSplit` with a case table, because the third
   *  answer is the one that used to be swallowed: the subtotals can
   *  EXCEED the total, and clamping that to zero left three mutually
   *  inconsistent counters on screen with nothing acknowledging it. See
   *  that module for why the page says so instead. */
  const activeSplit = resolveActiveSplit({
    active: loans?.active,
    erc20ActiveLoans: loans?.erc20ActiveLoans,
    nftRentalsActive: loans?.nftRentalsActive,
  });

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
              {activeSplit.kind === 'reconciled' &&
              activeSplit.unclassified > 0 ? (
                <Stat
                  label={copy.analytics.unclassifiedActive}
                  value={activeSplit.unclassified}
                />
              ) : null}
            </div>
            {activeSplit.kind === 'reconciled' &&
            activeSplit.unclassified > 0 ? (
              <p className="an-note">{copy.analytics.unclassifiedActiveNote}</p>
            ) : null}
            {/* The counters disagree. Shown rather than clamped away —
                the figures above are left exactly as reported so the
                reader can see the discrepancy for themselves. */}
            {activeSplit.kind === 'contradiction' ? (
              <p className="an-note" data-testid="an-active-contradiction">
                <strong>{copy.analytics.activeSplitContradiction}</strong>{' '}
                {copy.analytics.activeSplitContradictionNote}
              </p>
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
        M5 (#1218 / #1349) — THE RECYCLING ACCOUNT AND LOOP CLOSURE.

        Outside the counters' guard on purpose: they are separate indexer
        reads with their own loading and "cannot say" states, and an outage
        of the loan/offer counters is no reason to hide the programme's
        account (nor the reverse). Each section carries its anchor
        (`#recycling`, `#loop-closure`) in every state, so a deep link
        resolves on the first render through the same fragment effect
        above. Placed before the transparency section so its "every
        figure above is read from the public indexer" stays true of them.
      */}
      <RecyclingAccount chainId={chainId} />
      <LoopClosure chainId={chainId} />

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
                  ? localeNumber(cursor.lastBlock, i18n.resolvedLanguage)
                  : copy.analytics.unknown}
              </dd>
              <dt>{copy.analytics.lastIngest}</dt>
              <dd>{ageLabel(cursor?.updatedAt, nowSec)}</dd>
            </dl>
            <p className="an-caveat">
              {copy.analytics.caveat}
            </p>
          </section>

      {/*
        #2437 — THE CONTRACT'S OWN FIGURES. After the transparency section,
        whose "figures above are read from the public indexer" must stay
        true: these are not, and the section says where they come from,
        at which block, and how old that reading is. Outside every
        indexer guard, because an indexer outage is no reason to hide
        what the chain answers directly.
      */}
      <ChainFigures
        chainId={chainId}
        diamond={readChain.diamondAddress}
        explorer={readChain.blockExplorer}
      />
    </div>
  );
}
