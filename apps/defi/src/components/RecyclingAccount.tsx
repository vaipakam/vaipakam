import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  fetchRecyclingSeries,
  type RecyclingSeries,
} from '../lib/indexerClient';

/**
 * M5 (#1218 / #1349) — the recycling programme's own account, in public.
 *
 * ── COPY GATE (RL-6 / VPFITokenomicsRedesignResearch.md §A.4) ──────────
 *
 * All four checks, and how this surface meets them:
 *
 * 1. "usage rebates / fee discounts / PROGRAM LONGEVITY — never yield,
 *    APY, income, deflation, scarcity, or price." Programme longevity is
 *    explicitly permitted and is what this page is about. Nothing here
 *    names a rate, a return, or a token price, and "net emission" is
 *    presented as what the programme DREW, never as supply or scarcity.
 * 2. "sized by the user's own activity." This surface is programme-level,
 *    not per-user, so it makes no sizing claim at all — and must not
 *    acquire one. No copy suggests a holder receives anything.
 * 3. "no market touch, no published price, no purchase surface."
 *    None appears. There is nothing to click that acquires anything.
 * 4. "deterministic bookkeeping over fees already received — no
 *    operator-discretion framing." The strings describe what happened,
 *    and never "we allocate" or "the team decides".
 *
 * ── HONESTY GATE (the reason the endpoint has so many nulls) ──────────
 *
 * The read surface refuses to publish figures it cannot stand behind, and
 * this component must not undo that by rendering a refusal as a zero or a
 * dash:
 *
 *   - an UNFINALIZED day has no pool — it renders as "not yet closed",
 *     not as 0;
 *   - an UNARMED day is a schedule, not a commitment — it is labelled an
 *     estimate and its net-emission cell stays empty;
 *   - a withheld runway renders its REASON, because "—" would read as
 *     zero runway, which is the opposite of "we cannot say";
 *   - `scope: 'local-only'` means this deployment finalized no day itself,
 *     so the global figures are genuinely absent rather than zero.
 */
export default function RecyclingAccount({ chainId }: { chainId: number }) {
  const { t } = useTranslation();
  const [series, setSeries] = useState<RecyclingSeries | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchRecyclingSeries(chainId, 30)
      .then((s) => {
        if (cancelled) return;
        // A null read is "we cannot say", not "nothing happened". Rendering
        // an empty account here would be a claim we have not earned.
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
    return () => {
      cancelled = true;
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
  const finalized = daily.filter((d) => d.stamped);

  return (
    <section className="recycling-account">
      <h2>{t('recycling.title')}</h2>
      <p className="recycling-lede">{t('recycling.lede')}</p>

      {scope === 'local-only' && (
        <p className="muted" data-testid="recycling-scope-note">
          {t('recycling.scopeLocalOnly')}
        </p>
      )}

      <dl className="recycling-totals">
        <div>
          <dt>{t('recycling.absorbedTotal')}</dt>
          <dd data-testid="recycling-absorbed">{cumulative.absorbed}</dd>
        </div>
        <div>
          <dt>{t('recycling.absorbedPreLaunch')}</dt>
          <dd data-testid="recycling-prelaunch">
            {cumulative.absorbedPreLaunch}
          </dd>
        </div>
        <div>
          <dt>{t('recycling.drawnTotal')}</dt>
          <dd data-testid="recycling-drawn">{cumulative.freshDrawdown}</dd>
        </div>
        <div>
          <dt>{t('recycling.runway')}</dt>
          <dd data-testid="recycling-runway">
            {cumulative.selfFunded
              ? t('recycling.runwaySelfFunded')
              : cumulative.runwayExtensionDays !== null
                ? t('recycling.runwayDays', {
                    days: cumulative.runwayExtensionDays,
                  })
                : /* A reason, never a dash: "—" reads as zero runway,
                     which is the opposite of "we cannot say". */
                  t(`recycling.runwayUnavailable.${
                      cumulative.runwayUnavailableReason ?? 'unknown'
                    }`, {
                    defaultValue: t('recycling.runwayUnavailable.unknown'),
                  })}
          </dd>
        </div>
      </dl>

      {coverageFromDay !== null && (
        <p className="muted" data-testid="recycling-coverage">
          {t('recycling.coverageFrom', { day: coverageFromDay })}
        </p>
      )}

      <table className="recycling-days">
        <caption className="sr-only">{t('recycling.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('recycling.colDay')}</th>
            <th scope="col">{t('recycling.colFloor')}</th>
            <th scope="col">{t('recycling.colRecycled')}</th>
            <th scope="col">{t('recycling.colDrawn')}</th>
            <th scope="col">{t('recycling.colAbsorbed')}</th>
          </tr>
        </thead>
        <tbody>
          {finalized.map((d) => (
            <tr key={d.dayId} data-testid={`recycling-day-${d.dayId}`}>
              <th scope="row">
                {t('recycling.dayLabel', { day: d.dayId })}
                {d.estimate && (
                  <span className="badge badge-estimate" data-testid={`estimate-${d.dayId}`}>
                    {t('recycling.estimateBadge')}
                  </span>
                )}
              </th>
              <td>{d.scheduleFloor}</td>
              <td>{d.recycledBudget}</td>
              {/* Empty, not zero: an unarmed day committed nothing, so
                  printing 0 would assert a commitment that was not made. */}
              <td data-testid={`drawn-${d.dayId}`}>{d.netEmission ?? ''}</td>
              {/* Likewise: `absorbed` is null while a day is still
                  collecting cross-chain reports. */}
              <td data-testid={`absorbed-${d.dayId}`}>{d.absorbed ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {finalized.length === 0 && (
        <p className="muted" data-testid="recycling-no-days">
          {t('recycling.noFinalizedDays')}
        </p>
      )}

      <p className="recycling-footnote">{t('recycling.footnote')}</p>
    </section>
  );
}
