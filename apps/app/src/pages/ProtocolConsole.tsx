/**
 * Protocol Console — public, read-only view of every governance-tunable
 * parameter's current value (#1959).
 *
 * WHY IT LIVES HERE. `/protocol-console` was served by the retired
 * `apps/defi` and was the second of two surfaces the #1854 cutover did
 * not port. Together with `/analytics` it is why `defi.vaipakam.com`
 * could not be retired: the marketing site links to both.
 *
 * WHAT IS *NOT* HERE, DELIBERATELY. The prose reference already lives on
 * the marketing apex at `vaipakam.com/protocol-console/docs`, alongside
 * the Whitepaper and Overview, so the public-read explainer content
 * indexes together. This surface owns only the live VALUES. Duplicating
 * the runbook here would create a second copy to drift — the marketing
 * mirror is already pinned byte-for-byte against `docs/ops/` by
 * `check-admin-knobs-mirror.mjs`, and a third copy would not be.
 *
 * NAMED, NOT POSITIONAL. Values come from the indexer's named `values`
 * object, never the positional `bundle`. The release record carries an
 * incident where hand-typed tuples silently shifted field positions; a
 * governance parameter displayed against the wrong label is worse than
 * one not displayed at all, because it looks authoritative.
 *
 * PUBLIC BY DEFAULT, AND WALLET-FREE. Anyone can read every parameter
 * without connecting — the same posture the retired console had, and the
 * one every major protocol has settled on. Operators who would rather
 * not surface it (a pre-launch deploy mid-tuning, or the industrial fork
 * where parameter visibility is itself restricted) set
 * `VITE_ADMIN_DASHBOARD_PUBLIC=false`.
 *
 * READ-ONLY. There are no write controls here and none are planned on
 * this route: governance changes go through the timelock and the admin
 * multisig, not a web form.
 */
import { useCallback, useEffect, useState } from 'react';
import { SlidersHorizontal, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import {
  fetchProtocolKnobs,
  protocolConfigFresh,
  type ProtocolKnobSnapshot,
} from '../data/indexer';
import { useActiveChain } from '../chain/useActiveChain';
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';

/** Where the prose lives. Kept as one constant so the link cannot drift
 *  apart across the cards below. */
const DOCS_URL = 'https://vaipakam.com/protocol-console/docs';

/** bps → percent, without pretending to more precision than we have. */
function bps(v: string | undefined): string {
  if (v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `${(n / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}% (${n} bps)`;
}

function seconds(v: string | undefined): string {
  if (v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (n % 3600 === 0) return `${n / 3600} h (${n}s)`;
  if (n % 60 === 0) return `${n / 60} min (${n}s)`;
  return `${n}s`;
}

function plain(v: string | undefined, unit = ''): string {
  return v === undefined ? '—' : `${Number(v).toLocaleString()}${unit}`;
}

function flag(v: boolean | undefined): string {
  return v === undefined ? '—' : v ? 'enabled' : 'disabled';
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  const reported = value !== '—';
  return (
    <div className="pc-row">
      <div className="pc-row-label">{label}</div>
      <div className="pc-row-value" data-reported={reported}>
        {value}
        {!reported && <span className="pc-row-note"> not reported</span>}
      </div>
      {note && <div className="pc-row-hint">{note}</div>}
    </div>
  );
}

export function ProtocolConsole() {
  // READ CHAIN, not `useChainId()`. This page is a marketing deep-link
  // target, so most arrivals have NO wallet — and `useChainId()` reports
  // mainnet (1) for them, which is not a chain this deployment indexes.
  // The result was an empty page for exactly the audience it is for.
  // `readChain` is the app's "where reads land when disconnected"
  // resolution, honouring VITE_DEFAULT_CHAIN_ID.
  const { readChain } = useActiveChain();
  const chainId = readChain.chainId;
  const [snap, setSnap] = useState<ProtocolKnobSnapshot | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    const s = await fetchProtocolKnobs(chainId);
    setSnap(s);
    setState(s ? 'ready' : 'unavailable');
  }, [chainId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isProtocolConsolePublic()) {
    return (
      <div className="pc-page">
        <h1>Protocol console</h1>
        <p role="status">
          Parameter visibility is turned off on this deployment. The reference
          documentation remains public.{' '}
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            Read the parameter reference <ExternalLink aria-hidden="true" />
          </a>
        </p>
      </div>
    );
  }

  const v = snap?.values;
  // A snapshot older than a day means the refresh rail is wedged. Saying
  // so is the point of the console; quietly rendering day-old governance
  // parameters as current would be the failure this guard exists for.
  const stale =
    typeof snap?.updatedAt === 'number' && !protocolConfigFresh(snap.updatedAt);

  return (
    <div className="pc-page">
      <header className="pc-head">
        <h1>
          <SlidersHorizontal aria-hidden="true" /> Protocol console
        </h1>
        <p className="pc-sub">
          Every governance-tunable parameter's current value on chain {chainId}. Public
          and read-only — no wallet needed, and no controls here change anything.
          Governance changes go through the timelock, not this page.
        </p>
        <div className="pc-actions">
          <button type="button" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" /> Refresh
          </button>
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            Parameter reference <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </header>

      {state === 'unavailable' && (
        <p className="pc-unavailable" role="status">
          <AlertTriangle aria-hidden="true" /> No configuration snapshot is available for
          this chain. Nothing is inferred from that — it means the value is unknown here,
          not that it is unset on-chain.
        </p>
      )}

      {stale && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> This snapshot is more than a day old, so
          treat the values below as historical. Config changes normally reach the snapshot
          within one ingest scan.
        </p>
      )}

      {state === 'ready' && v && (
        <>
          <section className="pc-section" aria-labelledby="pc-fees">
            <h2 id="pc-fees">Fees</h2>
            <Row label="Treasury fee" value={bps(v.treasuryFeeBps)} note="Cut of interest at settlement." />
            <Row label="Loan initiation fee" value={bps(v.loanInitiationFeeBps)} note="Charged once, at accept." />
            <Row label="Liquidation handling fee" value={bps(v.liquidationHandlingFeeBps)} />
            <Row label="Matcher fee" value={bps(v.lifMatcherFeeBps)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-risk">
            <h2 id="pc-risk">Risk</h2>
            <Row label="Max liquidation slippage" value={bps(v.maxLiquidationSlippageBps)} />
            <Row label="Max liquidator incentive" value={bps(v.maxLiquidatorIncentiveBps)} />
            <Row
              label="Volatility LTV threshold"
              value={bps(v.volatilityLtvThresholdBps)}
              note="LTV at which the volatility collapse rule applies."
            />
            <Row label="NFT rental buffer" value={bps(v.rentalBufferBps)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-limits">
            <h2 id="pc-limits">Limits &amp; timing</h2>
            <Row label="Auto-pause duration" value={seconds(v.autoPauseDurationSeconds)} />
            <Row label="Max offer duration" value={plain(v.maxOfferDurationDays, ' days')} />
          </section>

          <section className="pc-section" aria-labelledby="pc-flags">
            <h2 id="pc-flags">Feature flags</h2>
            <Row label="Range amount offers" value={flag(v.rangeAmountEnabled)} />
            <Row label="Range rate offers" value={flag(v.rangeRateEnabled)} />
            <Row label="Partial fill" value={flag(v.partialFillEnabled)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-tiers">
            <h2 id="pc-tiers">VPFI discount tiers</h2>
            {/*
              Thresholds are 18-decimal amounts far beyond
              Number.MAX_SAFE_INTEGER, so they are rendered as the strings
              the API sent. Parsing them to floats to "tidy" the display
              would round the very figures this page exists to report.
            */}
            {(v.tierThresholds ?? []).length === 0 ? (
              <Row label="Tiers" value="—" />
            ) : (
              (v.tierThresholds ?? []).map((t, i) => (
                <Row
                  key={t}
                  label={`Tier ${i + 1} threshold`}
                  value={`${t} (raw) → ${bps(v.tierDiscountBps?.[i])} discount`}
                />
              ))
            )}
          </section>

          <p className="pc-provenance">
            Read from the public indexer's configuration snapshot
            {typeof snap.sourceBlock === 'number'
              ? ` at block ${snap.sourceBlock.toLocaleString()}`
              : ''}
            . The same endpoint is keyless and open-CORS, so you can verify any figure
            here independently rather than taking this page's word for it.
          </p>
        </>
      )}
    </div>
  );
}
