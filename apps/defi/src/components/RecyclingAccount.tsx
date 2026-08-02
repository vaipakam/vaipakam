import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  fetchRecyclingSeries,
  type RecyclingDay,
  type RecyclingSeries,
} from '../lib/indexerClient';
import { formatUnitsPretty } from '../lib/format';

/** How many days the table asks for. Disclosed in the copy, not implied. */
const WINDOW_DAYS = 30;
/** The dashboard's own refresh cadence, so this section does not go stale. */
const REFRESH_MS = 60_000;

/**
 * M5 (#1218 / #1349) — the recycling programme's own account, in public.
 *
 * ── COPY GATE (RL-6 / VPFITokenomicsRedesignResearch.md §A.4) ──────────
 *
 * 1. "usage rebates / fee discounts / PROGRAM LONGEVITY — never yield,
 *    APY, income, deflation, scarcity, or price." Programme longevity is
 *    expressly permitted and is what this page is about. Nothing names a
 *    rate, a return or a token price; "drawn" is what the programme drew,
 *    never supply or scarcity.
 * 2. "sized by the user's own activity." Programme-level surface: it makes
 *    no per-user claim and must not acquire one.
 * 3. "no market touch, no published price, no purchase surface." None.
 * 4. "deterministic bookkeeping over fees already received." The copy says
 *    what happened, never "we allocate" / "the team decides".
 *
 * ── HONESTY GATE ──────────────────────────────────────────────────────
 *
 * The endpoint refuses to publish figures it cannot stand behind. This
 * component must not resolve a refusal into a zero, a dash, or a total it
 * computed itself:
 *
 *   - an unfinalized day has no pool → the pool cells stay empty, and the
 *     day is still LISTED because its absorption is real and live;
 *   - an unarmed day is a schedule, not a commitment → marked an estimate,
 *     drawn cell empty;
 *   - a partial cross-chain total → empty, never a partial sum;
 *   - a withheld runway → renders its REASON, since "—" reads as zero;
 *   - `scope: 'local-only'` → the GLOBAL totals are absent, not zero. The
 *     endpoint leaves them at 0 there because no day was finalized here;
 *     printing that 0 is exactly the "looks like a quiet programme" error
 *     this component exists to avoid.
 */
export default function RecyclingAccount({ chainId }: { chainId: number }) {
  const { t } = useTranslation();
  const [series, setSeries] = useState<RecyclingSeries | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );

  useEffect(() => {
    let cancelled = false;
    const load = (first: boolean) => {
      if (first) setState('loading');
      fetchRecyclingSeries(chainId, WINDOW_DAYS)
        .then((s) => {
          if (cancelled) return;
          // A null read is "we cannot say", not "nothing happened".
          if (!s) {
            setState('unavailable');
            return;
          }
          setSeries(s);
          setState('ready');
        })
        .catch(() => {
          if (!cancelled) setState('unavailable');
        });
    };
    load(true);
    // The rest of the dashboard refreshes; a stale recycling account beside
    // live figures reads as a stalled programme.
    const id = setInterval(() => load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chainId]);

  if (state === 'loading') {
    return (
      <section className="recycling-account" aria-busy="true">
        <h2>{t('recycling.title')}</h2>
        <p className="muted">{t('recycling.loading')}</p>
      </section>
    );
  }

  if (state === 'unavailable' || !series) {
    return (
      <section className="recycling-account">
        <h2>{t('recycling.title')}</h2>
        <p className="muted">{t('recycling.unavailable')}</p>
      </section>
    );
  }

  const { cumulative, daily, scope, coverageFromDay } = series;
  // Every amount arrives as an 18-decimal wei decimal string. Rendering it
  // verbatim shows a 20-digit integer for an ordinary figure.
  const amt = (v: string | null): string =>
    v === null ? '' : formatUnitsPretty(BigInt(v), 18);
  const globalScope = scope === 'global';

  return (
    <section className="recycling-account">
      <h2>{t('recycling.title')}</h2>
      <p className="recycling-lede">{t('recycling.lede')}</p>

      {!globalScope && (
        <p className="muted" data-testid="recycling-scope-note">
          {t('recycling.scopeLocalOnly')}
        </p>
      )}

      <dl className="recycling-totals">
        {/* GLOBAL totals only where a day was actually finalized here.
            On a local-only deployment the endpoint leaves them at 0, and
            printing that 0 would be the exact failure this avoids. */}
        {globalScope && (
          <div>
            <dt>{t('recycling.absorbedTotal')}</dt>
            <dd data-testid="recycling-absorbed">
              {amt(cumulative.absorbed)}
            </dd>
          </div>
        )}
        {/* The split is published because a combined figure alone hides
            exactly the cross-chain activity the programme exists to show. */}
        <div>
          <dt>{t('recycling.absorbedLocal')}</dt>
          <dd data-testid="recycling-absorbed-local">
            {amt(cumulative.absorbedLocal)}
          </dd>
        </div>
        <div>
          <dt>{t('recycling.absorbedMirror')}</dt>
          <dd data-testid="recycling-absorbed-mirror">
            {amt(cumulative.absorbedMirror)}
          </dd>
        </div>
        <div>
          <dt>{t('recycling.absorbedPreLaunch')}</dt>
          <dd data-testid="recycling-prelaunch">
            {amt(cumulative.absorbedPreLaunch)}
          </dd>
        </div>
        {globalScope && (
          <div>
            <dt>{t('recycling.drawnTotal')}</dt>
            <dd data-testid="recycling-drawn">
              {amt(cumulative.freshDrawdown)}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('recycling.runway')}</dt>
          <dd data-testid="recycling-runway">
            {cumulative.selfFunded
              ? t('recycling.runwaySelfFunded')
              : cumulative.runwayExtensionDays !== null
                ? t('recycling.runwayDays', {
                    days: cumulative.runwayExtensionDays,
                  })
                : t(
                    `recycling.runwayUnavailable.${
                      cumulative.runwayUnavailableReason ?? 'unknown'
                    }`,
                    { defaultValue: t('recycling.runwayUnavailable.unknown') },
                  )}
          </dd>
        </div>
      </dl>

      {coverageFromDay !== null && (
        <p className="muted" data-testid="recycling-coverage">
          {t('recycling.coverageFrom', { day: coverageFromDay })}
        </p>
      )}
      <p className="muted" data-testid="recycling-window">
        {t('recycling.windowNote', { days: WINDOW_DAYS })}
      </p>

      <table className="recycling-days">
        <caption className="sr-only">{t('recycling.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('recycling.colDay')}</th>
            <th scope="col">{t('recycling.colFloor')}</th>
            <th scope="col">{t('recycling.colRecycled')}</th>
            <th scope="col">{t('recycling.colSelfFunded')}</th>
            <th scope="col">{t('recycling.colDrawn')}</th>
            <th scope="col">{t('recycling.colAbsorbed')}</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d: RecyclingDay) => (
            <tr key={d.dayId} data-testid={`recycling-day-${d.dayId}`}>
              <th scope="row">
                {t('recycling.dayLabel', { day: d.dayId })}{' '}
                {d.estimate && (
                  <span
                    className="badge badge-estimate"
                    data-testid={`estimate-${d.dayId}`}
                  >
                    {t('recycling.estimateBadge')}
                  </span>
                )}
                {/* A recomputed row was captured later from state a role
                    handover can rewrite — not recorded as it happened. */}
                {d.origin === 'backfill' && (
                  <span
                    className="badge badge-recomputed"
                    data-testid={`recomputed-${d.dayId}`}
                  >
                    {t('recycling.recomputedBadge')}
                  </span>
                )}
              </th>
              <td>{amt(d.scheduleFloor)}</td>
              <td>{amt(d.recycledBudget)}</td>
              <td data-testid={`selffunded-${d.dayId}`}>
                {d.selfFundingRatio === null
                  ? ''
                  : t('recycling.selfFundedPct', {
                      pct: Math.round(d.selfFundingRatio * 1000) / 10,
                    })}
              </td>
              {/* Empty, not zero: an unarmed day committed nothing. */}
              <td data-testid={`drawn-${d.dayId}`}>{amt(d.netEmission)}</td>
              {/* Likewise while a day is still collecting reports. */}
              <td data-testid={`absorbed-${d.dayId}`}>{amt(d.absorbed)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {daily.length === 0 && (
        <p className="muted" data-testid="recycling-no-days">
          {t('recycling.noFinalizedDays')}
        </p>
      )}

      <p className="recycling-footnote">{t('recycling.footnote')}</p>
      {/* The ratified spec requires the drawn figure's limits on the SAME
          surface — a caveat kept elsewhere is one a reader over-trusts. */}
      <p className="recycling-footnote" data-testid="recycling-drawn-bounds">
        {t('recycling.drawnBounds')}
      </p>
    </section>
  );
}
