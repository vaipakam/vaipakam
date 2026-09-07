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
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { SlidersHorizontal, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import {
  fetchProtocolKnobs,
  protocolConfigFresh,
  type ProtocolKnobSnapshot,
} from '../data/indexer';
import { useActiveChain } from '../chain/useActiveChain';
import { formatTokenAmount } from '../lib/format';
import { VPFI_DECIMALS } from '../data/vpfi';
import { useNowSec } from '../hooks/useNowSec';
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';

/** Where the prose lives. Kept as one constant so the link cannot drift
 *  apart across the cards below. */
const DOCS_URL = 'https://vaipakam.com/protocol-console/docs';

/** bps → percent, without pretending to more precision than we have. */
function bps(v: string | undefined): string {
  if (v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return copy.protocolConsole.bpsValue(
    (n / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }),
    n,
  );
}

function seconds(v: string | undefined): string {
  if (v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (n % 3600 === 0)
    return copy.protocolConsole.hoursValue(n / 3600, n);
  if (n % 60 === 0)
    return copy.protocolConsole.minutesValue(n / 60, n);
  return copy.protocolConsole.secondsValue(n);
}

/** Snapshot age, against a caller-supplied ticking clock (never
 *  `Date.now()` in render — that freezes the reading). */
function ageText(updatedAtSec: number, nowSec: number): string {
  const secs = Math.max(0, nowSec - updatedAtSec);
  if (secs < 90) return copy.analytics.ageSeconds(secs);
  if (secs < 5400) return copy.analytics.ageMinutes(Math.round(secs / 60));
  return copy.analytics.ageHours(Math.round(secs / 3600));
}

function plain(v: string | undefined, unit = ''): string {
  return v === undefined ? '—' : `${Number(v).toLocaleString()}${unit}`;
}

function flag(v: boolean | undefined): string {
  if (v === undefined) return '—';
  return v ? copy.protocolConsole.enabled : copy.protocolConsole.disabled;
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  const reported = value !== '—';
  return (
    <div className="pc-row">
      <div className="pc-row-label">{label}</div>
      <div className="pc-row-value" data-reported={reported}>
        {value}
        {!reported && <span className="pc-row-note"> {copy.protocolConsole.notReported}</span>}
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
  // Ticks, so the snapshot age below advances instead of freezing at
  // whenever React last rendered.
  const nowSec = useNowSec();

  // useQuery, not useEffect+setState — matches every other async surface
  // here, and the effect form trips `react-hooks/set-state-in-effect`,
  // whose point is that a synchronous setState in an effect body
  // cascades renders.
  const knobs = useQuery({
    queryKey: ['protocol-knobs', chainId],
    queryFn: () => fetchProtocolKnobs(chainId),
  });

  const snap: ProtocolKnobSnapshot | null = knobs.data ?? null;
  const unavailable = knobs.isError || (knobs.isSuccess && snap === null);

  if (!isProtocolConsolePublic()) {
    return (
      <div className="pc-page">
        <h1>{copy.protocolConsole.title}</h1>
        {/*
          NO DOCS LINK IN THIS POSTURE. The reference page on the
          marketing site reads the SAME `VITE_ADMIN_DASHBOARD_PUBLIC`
          flag and redirects to its home page when it is off, so linking
          there from here promised the reader something the very flag
          that produced this state had already taken away.
        */}
        <p role="status">{copy.protocolConsole.hiddenBody}</p>
      </div>
    );
  }

  const v = snap?.values;
  // A snapshot older than a day means the refresh rail is wedged. Saying
  // so is the point of the console; quietly rendering day-old governance
  // parameters as current would be the failure this guard exists for.
  const stale =
    typeof snap?.updatedAt === 'number' &&
    snap.updatedAt > 0 &&
    !protocolConfigFresh(snap.updatedAt);
  // UNDATED IS NOT FRESH (review round 3 P2). `fetchProtocolKnobs`
  // deliberately accepts a response with no `updatedAt`, and that case
  // was neither `stale` nor `unavailable` — so an old or malformed
  // worker could present indefinitely old governance parameters beneath
  // copy calling them current, with no qualification at all. The wire
  // type's own comment requires callers to surface this timestamp.
  // Silence about age is the one thing this page must not do: it exists
  // so a reader knows what they are looking at.
  //
  // ZERO IS A SENTINEL, NOT A TIMESTAMP (review round 8 P2).
  // `markStaleBelow` zeroes `updated_at` when a catch-up scan saw a
  // governance event the row predates, and the endpoint emits
  // `stale: true` alongside it. Zero is a real `number`, so it fell
  // through as a capture time and the provenance sentence read "taken
  // 56 years ago" — a confident, precise, entirely invented figure on
  // the page whose whole claim is that its numbers can be trusted.
  // The honest reading of the sentinel is that the capture time is
  // UNKNOWN and the values are known-behind, which is what `undated`
  // already says.
  const undated =
    snap !== null && (typeof snap.updatedAt !== 'number' || snap.updatedAt === 0);

  return (
    <div className="pc-page">
      <header className="pc-head">
        <h1>
          <SlidersHorizontal aria-hidden="true" /> {copy.protocolConsole.title}
        </h1>
        <p className="pc-sub">
          {copy.protocolConsole.lede(chainId)}
        </p>
        <div className="pc-actions">
          <button type="button" onClick={() => void knobs.refetch()}>
            <RefreshCw aria-hidden="true" /> {copy.protocolConsole.refresh}
          </button>
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            {copy.protocolConsole.reference} <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </header>

      {unavailable && (
        <p className="pc-unavailable" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.unavailable}
        </p>
      )}

      {undated && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.undated}
        </p>
      )}

      {stale && (
        <p className="pc-stale" role="status">
          <AlertTriangle aria-hidden="true" /> {copy.protocolConsole.stale}
        </p>
      )}

      {!unavailable && v && (
        <>
          <section className="pc-section" aria-labelledby="pc-fees">
            <h2 id="pc-fees">{copy.protocolConsole.feesHeading}</h2>
            <Row label={copy.protocolConsole.treasuryFee} value={bps(v.treasuryFeeBps)} note={copy.protocolConsole.treasuryFeeHint} />
            <Row label={copy.protocolConsole.loanInitiationFee} value={bps(v.loanInitiationFeeBps)} note={copy.protocolConsole.loanInitiationFeeHint} />
            <Row label={copy.protocolConsole.liquidationHandlingFee} value={bps(v.liquidationHandlingFeeBps)} />
            <Row label={copy.protocolConsole.matcherFee} value={bps(v.lifMatcherFeeBps)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-risk">
            <h2 id="pc-risk">{copy.protocolConsole.riskHeading}</h2>
            <Row label={copy.protocolConsole.maxSlippage} value={bps(v.maxLiquidationSlippageBps)} />
            <Row label={copy.protocolConsole.maxIncentive} value={bps(v.maxLiquidatorIncentiveBps)} />
            <Row
              label={copy.protocolConsole.volatilityLtv}
              value={bps(v.volatilityLtvThresholdBps)}
              note={copy.protocolConsole.volatilityLtvHint}
            />
            <Row label={copy.protocolConsole.rentalBuffer} value={bps(v.rentalBufferBps)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-limits">
            <h2 id="pc-limits">{copy.protocolConsole.limitsHeading}</h2>
            <Row label={copy.protocolConsole.autoPause} value={seconds(v.autoPauseDurationSeconds)} />
            <Row label={copy.protocolConsole.maxOfferDuration} value={plain(v.maxOfferDurationDays, ` ${copy.protocolConsole.days}`)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-flags">
            <h2 id="pc-flags">{copy.protocolConsole.flagsHeading}</h2>
            <Row label={copy.protocolConsole.rangeAmount} value={flag(v.rangeAmountEnabled)} />
            <Row label={copy.protocolConsole.rangeRate} value={flag(v.rangeRateEnabled)} />
            <Row label={copy.protocolConsole.partialFill} value={flag(v.partialFillEnabled)} />
          </section>

          <section className="pc-section" aria-labelledby="pc-tiers">
            <h2 id="pc-tiers">{copy.protocolConsole.tiersHeading}</h2>
            {/*
              Thresholds are 18-decimal amounts far beyond
              Number.MAX_SAFE_INTEGER, so they are rendered as the strings
              the API sent. Parsing them to floats to "tidy" the display
              would round the very figures this page exists to report.
            */}
            {(v.tierThresholds ?? []).length === 0 ? (
              <Row label={copy.protocolConsole.tiers} value="—" />
            ) : (
              (v.tierThresholds ?? []).map((t, i) => (
                <Row
                  key={t}
                  label={copy.protocolConsole.tierThreshold(i + 1)}
                  value={copy.protocolConsole.tierValue(
                    // BASE UNITS IN, TOKEN UNITS OUT (review round 5 P2).
                    // `tierThresholds` arrives as 18-decimal VPFI base-unit
                    // STRINGS, so rendering `t` directly printed an integer
                    // with eighteen extra digits — the wei-for-token display
                    // failure this repo has hit before, on a public page
                    // whose figures are meant to be checkable. The raw
                    // string is what gets converted, so nothing is rounded
                    // on the way in.
                    formatTokenAmount(t, VPFI_DECIMALS),
                    bps(v.tierDiscountBps?.[i]),
                  )}
                />
              ))
            )}
          </section>

          <p className="pc-provenance">
            {copy.protocolConsole.provenance}
            {typeof snap.sourceBlock === 'number'
              ? copy.protocolConsole.provenanceBlock(snap.sourceBlock.toLocaleString())
              : ''}
            {/* The age rides in the provenance sentence, so it is read
                whenever the source is — not only when a day-old
                threshold trips a warning. */}
            {typeof snap.updatedAt === 'number' && snap.updatedAt > 0
              ? copy.protocolConsole.provenanceAge(
                  ageText(snap.updatedAt, nowSec),
                )
              : copy.protocolConsole.provenanceAgeUnknown}
            {copy.protocolConsole.provenanceTail}
          </p>
        </>
      )}
    </div>
  );
}
