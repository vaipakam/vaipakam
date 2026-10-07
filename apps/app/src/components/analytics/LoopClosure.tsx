/**
 * RL-2 (#1303) — loop closure on /analytics: how much of the reward VPFI
 * that claims paid out stays inside the platform. Shown for the first time;
 * the metric has been served by `/metrics/loop-closure` since RL-2 with no
 * display home (TokenomicsTechSpec, "Loop-closure transparency metric").
 *
 * TWO DIFFERENT QUANTITIES, KEPT APART. The daily figure is a FLOW (of
 * what claims paid out that day, the part kept in vaults or absorbed that
 * day); the lifetime figure is a STOCK (reward VPFI still held in vaults
 * plus everything absorbed, over everything ever paid out). The spec says
 * they "must not be mixed", so they are never placed in one column, and
 * the copy says why neither can be read off the other.
 *
 * NOT APPLICABLE IS NOT ZERO. On a day nothing was paid out the ratio has
 * no denominator; the indexer serves `null` and the page says "not
 * applicable" — never 0, a dash, NaN or ∞ — matching the spec's
 * zero-distribution convention.
 *
 * CONSERVATIVE BY DEFINITION, AND ON SCREEN. The metric is a lower bound
 * that may never overstate closure, so every proportion is rounded DOWN.
 *
 * NOT YET RECORDED IS NOT ZERO EITHER (#1349 M5). A day's figures are a
 * fact only once it has ended and every claim in it is recorded. The
 * indexer publishes the moment its record reaches (`recordedBefore`, shown
 * as the series' as-of) and marks each day: a complete day renders as
 * above; a day still being recorded (the UTC day in progress, or the day
 * the record stops in) shows its amounts so far, labelled as such, and no
 * proportion; a day the record has not reached shows "not yet recorded" in
 * every cell. The page takes the indexer's status as given — deciding it
 * from the reader's clock would make the page a second authority on where
 * the record ends.
 *
 * WHICH DAY. This series is bucketed by the CALENDAR day (UTC) the tokens
 * left the platform — not by the programme day the recycling account
 * uses. The page shows the indexer's own `date` verbatim (no conversion,
 * so no second authority on where a day begins, and no timezone shift),
 * labelled as a UTC calendar day, and says the two do not line up.
 *
 * COPY GATE (RL-6): bookkeeping over fees already received; nothing here
 * is a rate, a return, or sized by anyone's holding.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Repeat } from 'lucide-react';
import { copy } from '../../content/copy';
import { indexerConfigured } from '../../data/indexer';
import {
  fetchLoopClosure,
  LOOP_CLOSURE_WINDOW_DAYS,
  type LoopClosureData,
} from '../../data/recycling';
import { idleAware } from '../../lib/idle';
import { formatRoundedDownPercent, formatVpfiWei } from '../../lib/recyclingFormat';

export type LoopClosureState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: LoopClosureData };

/** The container — same cadence and posture as the rest of /analytics. */
export function LoopClosure({ chainId }: { chainId: number }) {
  const { i18n } = useTranslation();
  const query = useQuery({
    queryKey: ['loop-closure', chainId, LOOP_CLOSURE_WINDOW_DAYS],
    enabled: indexerConfigured(),
    refetchInterval: idleAware(180_000),
    queryFn: () => fetchLoopClosure(chainId, LOOP_CLOSURE_WINDOW_DAYS),
  });
  const state: LoopClosureState = !indexerConfigured()
    ? { status: 'unavailable' }
    : query.isPending
      ? { status: 'loading' }
      : query.data
        ? { status: 'ready', data: query.data }
        : { status: 'unavailable' };
  return <LoopClosureView state={state} locale={i18n.resolvedLanguage} />;
}

/** Pure view. The `#loop-closure` anchor is present in every state. */
export function LoopClosureView({
  state,
  locale,
}: {
  state: LoopClosureState;
  locale: string | undefined;
}) {
  return (
    <section
      className="an-section rc-section"
      id="loop-closure"
      aria-labelledby="lc-title"
      aria-busy={state.status === 'loading'}
    >
      <h2 id="lc-title">
        <Repeat aria-hidden="true" /> {copy.loopClosure.title}
      </h2>
      <p className="an-note rc-lede">{copy.loopClosure.lede}</p>
      {state.status === 'loading' && (
        <p className="muted" role="status">
          {copy.loopClosure.loading}
        </p>
      )}
      {state.status === 'unavailable' && (
        <p className="muted" role="status" data-testid="loop-unavailable">
          {copy.loopClosure.unavailable}
        </p>
      )}
      {state.status === 'ready' && <LoopBody data={state.data} locale={locale} />}
    </section>
  );
}

function LoopBody({
  data,
  locale,
}: {
  data: LoopClosureData;
  locale: string | undefined;
}) {
  const amt = (wei: string) => formatVpfiWei(wei, locale);
  /** A ratio, rounded down — or "not applicable" when nothing was paid out. */
  const ratio = (r: number | null) =>
    r === null ? copy.loopClosure.notApplicable : formatRoundedDownPercent(r, locale);
  const { cumulative } = data;
  return (
    <>
      {/* The lifetime STOCK ratio, with every amount it is built from. */}
      <dl className="rc-figures">
        <div>
          <dt>{copy.loopClosure.lifetimeRatio}</dt>
          <dd
            className={cumulative.ratio === null ? 'rc-refusal' : undefined}
            data-testid="loop-lifetime-ratio"
          >
            {ratio(cumulative.ratio)}
          </dd>
        </div>
        <div>
          <dt>{copy.loopClosure.retainedStock}</dt>
          <dd data-testid="loop-retained-stock">{amt(cumulative.retainedStock)}</dd>
        </div>
        <div>
          <dt>{copy.loopClosure.cumAbsorbed}</dt>
          <dd data-testid="loop-cum-absorbed">{amt(cumulative.cumAbsorbed)}</dd>
        </div>
        <div>
          <dt>{copy.loopClosure.cumDistributed}</dt>
          <dd data-testid="loop-cum-distributed">{amt(cumulative.cumDistributed)}</dd>
        </div>
      </dl>
      <p className="an-note" data-testid="loop-measures-note">
        {copy.loopClosure.measuresNote}
      </p>
      <p className="an-note" data-testid="loop-lower-bound-note">
        {copy.loopClosure.lowerBoundNote}
      </p>
      <p className="an-note" data-testid="loop-days-note">
        {copy.loopClosure.daysNote}
      </p>
      <p className="an-note" data-testid="loop-window">
        {copy.loopClosure.windowNote(data.days)}
      </p>
      {/* The series' as-of moment: how far the record of claims reaches. */}
      <p className="an-note" data-testid="loop-recorded-before">
        {data.recordedBefore === null
          ? copy.loopClosure.recordedBeforeUnknown
          : copy.loopClosure.recordedBefore(data.recordedBefore)}
      </p>

      {/* The daily FLOW ratio — a separate table from the stock above. */}
      <div className="rc-table-wrap" data-testid="loop-table-wrap">
        <table className="rc-table">
          <caption className="visually-hidden">{copy.loopClosure.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.loopClosure.colDay}</th>
              <th scope="col">{copy.loopClosure.colDistributed}</th>
              <th scope="col">{copy.loopClosure.colKept}</th>
              <th scope="col">{copy.loopClosure.colAbsorbed}</th>
              <th scope="col">{copy.loopClosure.colRatio}</th>
            </tr>
          </thead>
          <tbody>
            {data.daily.map((d) => (
              <tr key={d.dayId} data-testid={`loop-day-${d.dayId}`} data-status={d.status}>
                {/* The indexer's own UTC date, verbatim — see the module
                    note on why it is neither converted nor re-indexed. */}
                <th scope="row" data-testid={`loop-date-${d.dayId}`}>
                  {d.date}
                  {d.status === 'partial' && (
                    <span className="rc-day-note" data-testid={`loop-status-${d.dayId}`}>
                      {copy.loopClosure.dayPartial}
                    </span>
                  )}
                </th>
                {d.status === 'unrecorded' ? (
                  // Unknown in every cell — not a zero, not "nothing paid out".
                  <>
                    <td className="rc-refusal" data-testid={`loop-distributed-${d.dayId}`}>
                      {copy.loopClosure.notRecorded}
                    </td>
                    <td className="rc-refusal" data-testid={`loop-kept-${d.dayId}`}>
                      {copy.loopClosure.notRecorded}
                    </td>
                    <td className="rc-refusal" data-testid={`loop-absorbed-${d.dayId}`}>
                      {copy.loopClosure.notRecorded}
                    </td>
                    <td className="rc-refusal" data-testid={`loop-ratio-${d.dayId}`}>
                      {copy.loopClosure.notRecorded}
                    </td>
                  </>
                ) : (
                  <>
                    <td data-testid={`loop-distributed-${d.dayId}`}>{amt(d.distributed)}</td>
                    <td data-testid={`loop-kept-${d.dayId}`}>{amt(d.netVaultDelivered)}</td>
                    <td data-testid={`loop-absorbed-${d.dayId}`}>{amt(d.absorbed)}</td>
                    <td
                      className={d.ratio === null ? 'rc-refusal' : undefined}
                      data-testid={`loop-ratio-${d.dayId}`}
                    >
                      {/* A day still being recorded has no proportion yet —
                          never "not applicable — nothing paid out". */}
                      {d.status === 'partial' ? copy.loopClosure.ratioNotFinal : ratio(d.ratio)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
