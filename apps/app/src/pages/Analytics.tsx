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
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
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
      {!reported && <div className="an-stat-note">not reported</div>}
    </div>
  );
}

function ageLabel(updatedAtSec: number | undefined): string {
  if (typeof updatedAtSec !== 'number') return 'unknown';
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - updatedAtSec);
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
  return `${Math.round(secs / 3600)} h ago`;
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
  const [loans, setLoans] = useState<LoanStats | null>(null);
  const [offers, setOffers] = useState<OfferStats | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unreachable'>('loading');

  const load = useCallback(async () => {
    if (!indexerConfigured()) {
      setState('unreachable');
      return;
    }
    setState('loading');
    const [l, o] = await Promise.all([fetchLoanStats(chainId), fetchOfferStats(chainId)]);
    setLoans(l);
    setOffers(o);
    // BOTH null means the endpoint did not answer. One null is a partial
    // read and still worth rendering — half a picture beats none, as
    // long as the missing half reads as missing rather than as zero.
    setState(l === null && o === null ? 'unreachable' : 'ready');
  }, [chainId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="an-page">
      <header className="an-head">
        <h1>
          <BarChart3 aria-hidden="true" /> Protocol analytics
        </h1>
        <p className="an-sub">
          Live counts from the public indexer for chain {chainId}. No wallet needed —
          these are the same keyless endpoints anyone can query.
        </p>
        <button type="button" className="an-refresh" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" /> Refresh
        </button>
      </header>

      {state === 'unreachable' && (
        <p className="an-unreachable" role="status">
          <AlertTriangle aria-hidden="true" /> The indexer did not answer, so no figures
          are shown. Nothing is inferred from the silence — an unreachable indexer is not
          evidence of zero activity.
        </p>
      )}

      {state !== 'unreachable' && (
        <>
          <section className="an-section" aria-labelledby="an-loans">
            <h2 id="an-loans">Loans</h2>
            <div className="an-grid">
              <Stat label="Active" value={loans?.active} />
              <Stat label="Repaid" value={loans?.repaid} />
              <Stat label="Defaulted" value={loans?.defaulted} />
              <Stat label="Liquidated" value={loans?.liquidated} />
              <Stat label="Settled" value={loans?.settled} />
              <Stat label="Total" value={loans?.total} />
            </div>
            <div className="an-grid an-grid-sub">
              <Stat label="ERC-20 loans active" value={loans?.erc20ActiveLoans} />
              <Stat label="NFT rentals active" value={loans?.nftRentalsActive} />
            </div>
          </section>

          <section className="an-section" aria-labelledby="an-offers">
            <h2 id="an-offers">Offers</h2>
            <div className="an-grid">
              <Stat label="Active" value={offers?.active} />
              <Stat label="Accepted" value={offers?.accepted} />
              <Stat label="Cancelled" value={offers?.cancelled} />
              <Stat label="Expired" value={offers?.expired} />
              <Stat label="Consumed by sale" value={offers?.consumedBySale} />
              <Stat label="Total" value={offers?.total} />
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
              <ShieldCheck aria-hidden="true" /> Transparency
            </h2>
            <p>
              Every figure above is read from the public indexer API, which is keyless and
              open-CORS. You do not have to trust this page — query the same endpoints
              yourself and compare.
            </p>
            <dl className="an-facts">
              <dt>Indexer cursor block</dt>
              <dd>
                {typeof offers?.indexer?.lastBlock === 'number'
                  ? offers.indexer.lastBlock.toLocaleString()
                  : 'unknown'}
              </dd>
              <dt>Last ingest</dt>
              <dd>{ageLabel(offers?.indexer?.updatedAt)}</dd>
              <dt>Chain</dt>
              <dd>{chainId}</dd>
            </dl>
            <p className="an-caveat">
              These counts are as current as the cursor above, not as current as the
              chain. If the last ingest is old, the numbers are old — that is why the age
              is shown here rather than left for you to guess. Settlement figures come
              from indexed events, so a state change that has not been ingested yet will
              not appear.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
