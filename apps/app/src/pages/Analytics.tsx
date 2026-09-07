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
  fetchLoanStats,
  fetchOfferStats,
  indexerConfigured,
  type LoanStats,
  type OfferStats,
} from '../data/indexer';
import { useActiveChain } from '../chain/useActiveChain';

/** Renders a counter, keeping "not reported" distinct from zero. */
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

function ageLabel(updatedAtSec: number | undefined): string {
  if (typeof updatedAtSec !== 'number') return copy.analytics.unknown;
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - updatedAtSec);
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

  // useQuery, not useEffect+setState. Beyond matching how every other
  // async surface here loads, the effect form trips
  // `react-hooks/set-state-in-effect` — the rule exists because a
  // synchronous setState in an effect body cascades renders.
  const stats = useQuery({
    queryKey: ['analytics-stats', chainId],
    enabled: indexerConfigured(),
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
  const cursor = offers?.indexer ?? loans?.indexer ?? null;
  const uninitialized =
    !unreachable && stats.isSuccess && typeof cursor?.lastBlock !== 'number';

  return (
    <div className="an-page">
      <header className="an-head">
        <h1>
          <BarChart3 aria-hidden="true" /> {copy.analytics.title}
        </h1>
        <p className="an-sub">
          {copy.analytics.lede(chainId)}
        </p>
        <button type="button" className="an-refresh" onClick={() => void stats.refetch()}>
          <RefreshCw aria-hidden="true" /> {copy.analytics.refresh}
        </button>
      </header>

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

      {!unreachable && !uninitialized && (
        <>
          <section className="an-section" aria-labelledby="an-loans">
            <h2 id="an-loans">{copy.analytics.loansHeading}</h2>
            <div className="an-grid">
              <Stat label={copy.analytics.active} value={loans?.active} />
              <Stat label={copy.analytics.repaid} value={loans?.repaid} />
              <Stat label={copy.analytics.defaulted} value={loans?.defaulted} />
              <Stat label={copy.analytics.liquidated} value={loans?.liquidated} />
              <Stat label={copy.analytics.settled} value={loans?.settled} />
              <Stat label={copy.analytics.total} value={loans?.total} />
            </div>
            <div className="an-grid an-grid-sub">
              <Stat label={copy.analytics.erc20Active} value={loans?.erc20ActiveLoans} />
              <Stat label={copy.analytics.nftRentalsActive} value={loans?.nftRentalsActive} />
            </div>
          </section>

          <section className="an-section" aria-labelledby="an-offers">
            <h2 id="an-offers">{copy.analytics.offersHeading}</h2>
            <div className="an-grid">
              <Stat label={copy.analytics.active} value={offers?.active} />
              <Stat label={copy.analytics.accepted} value={offers?.accepted} />
              <Stat label={copy.analytics.cancelled} value={offers?.cancelled} />
              <Stat label={copy.analytics.expired} value={offers?.expired} />
              <Stat label={copy.analytics.consumedBySale} value={offers?.consumedBySale} />
              <Stat label={copy.analytics.total} value={offers?.total} />
            </div>
          </section>

          {/*
            THE DEEP-LINK TARGET. The marketing site links to
            `/analytics#transparency`, so this id is load-bearing: drop it
            and that CTA silently lands at the top of the page instead of
            the section it promised. Keep the id even if the heading text
            changes.
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
              <dd>{ageLabel(cursor?.updatedAt)}</dd>
            </dl>
            <p className="an-caveat">
              {copy.analytics.caveat}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
