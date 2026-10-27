/**
 * M5 (#1218 / #1349) — the recycling programme's own account, in public,
 * on /analytics.
 *
 * Ported from the retired dashboard's `RecyclingAccount`, keeping every
 * honesty property its test suite pinned, and fixing the two defects it
 * shipped with:
 *
 *  1. BOTH RECOVERY RESERVATIONS ARE LISTED. The remainder "platform
 *     balance after the amounts set against it" subtracts the value held
 *     back mid-transfer and the recovery-position earmark as well as the
 *     pool. The retired surface listed neither, so a reader could check
 *     that the remainder was a number but not that it was the RIGHT number
 *     (TokenomicsTechSpec: a remainder is published with EVERY subtrahend).
 *     A reading that predates either figure shows it as not determinable,
 *     never as zero.
 *
 *  2. "IS THE POOL BACKED?" IS THE INDEXER'S ANSWER. The retired surface
 *     decided it here as `vpfiBalance >= bucket`, which was wrong before
 *     custody activation (it ignored both reservations held inside the same
 *     balance) and after it (the bucket is then held at the custody
 *     address). The answer is now the indexer's `backed` verdict, produced
 *     by the one shared function in `@vaipakam/contracts/recycle-backing`;
 *     this component only SAYS it — which comparison decided it, whether it
 *     holds, each shortfall, or why it cannot be determined. On an
 *     activated deployment the custody address's balance and attributed
 *     total are shown beside it, so the answer can be checked against the
 *     figures it compares; on a reading that does not record the custody
 *     state, both rows stay and say they are not determinable. When custody
 *     HAS moved but the custody address's balance could not be read, the
 *     reserve (and the amounts it is the remainder of) is withheld with that
 *     reason: the platform contract's balance no longer backs it, so showing
 *     the reserve beside it would publish the counter-derived half alone.
 *
 * ── COPY GATE (RL-6 / VPFITokenomicsRedesignResearch.md §A.4) ──────────
 * Programme longevity and bookkeeping only. Nothing names a rate, a return
 * or a token price; nothing is sized by holding; there is no purchase
 * surface; the copy states what happened, never that anyone decided it.
 *
 * ── HONESTY GATE ──────────────────────────────────────────────────────
 * The endpoint refuses to publish figures it cannot stand behind. This
 * component must not resolve a refusal into a zero, a dash, a blank, or a
 * total it computed itself:
 *   - an unfinalized day has no pool → its cells SAY so, and the day is
 *     still listed because its own absorption is real and live;
 *   - an unarmed day is a schedule → marked an estimate, nothing drawn;
 *   - another chain's absorption on an open day, and the combined sum, are
 *     withheld until the day closes — named as pending, never 0;
 *   - a withheld runway or programme-wide total renders its REASON;
 *   - days are the programme's own day index, never calendar dates.
 *
 * Data comes pre-validated from `data/recycling.ts`; this file does no
 * arithmetic on figures beyond deciding whether a caveat's condition is
 * visible at the displayed precision.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Recycle } from 'lucide-react';
import { copy } from '../../content/copy';
import { indexerConfigured } from '../../data/indexer';
import {
  fetchRecyclingAccount,
  RECYCLING_WINDOW_DAYS,
  type BackingVerdictView,
  type BackingWithheld,
  type PublishableBacking,
  type RecyclingAccountData,
  type RecyclingCumulative,
  type RecyclingDay,
} from '../../data/recycling';
import { localeNumber } from '../../lib/format';
import { idleAware } from '../../lib/idle';
import {
  formatRoundedDownPercent,
  formatVpfiWei,
  formatVpfiWeiCeil,
  partsVisiblyExceed,
  roundedDownTenths,
} from '../../lib/recyclingFormat';

/** What the view is asked to show. Loading is its own posture, never "none". */
export type RecyclingAccountState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: RecyclingAccountData };

/**
 * The container: reads the account and hands the view a settled state.
 *
 * Same cadence and posture as the rest of /analytics — `cool` tier
 * (180 s active, stretched once the session goes idle), no manual refresh
 * control. A stale recycling account beside live counters would read as a
 * stalled programme.
 */
export function RecyclingAccount({ chainId }: { chainId: number }) {
  // The APP's language, not the device's — the same rule the rest of the
  // page follows, so figures and labels agree.
  const { i18n } = useTranslation();
  const query = useQuery({
    queryKey: ['recycling-account', chainId, RECYCLING_WINDOW_DAYS],
    enabled: indexerConfigured(),
    refetchInterval: idleAware(180_000),
    queryFn: () => fetchRecyclingAccount(chainId, RECYCLING_WINDOW_DAYS),
  });
  const state: RecyclingAccountState = !indexerConfigured()
    ? { status: 'unavailable' }
    : query.isPending
      ? { status: 'loading' }
      : query.data
        ? { status: 'ready', data: query.data }
        : // A null read is "we cannot say", not "nothing happened" — and a
          // malformed series is the same answer, reached differently.
          { status: 'unavailable' };
  return <RecyclingAccountView state={state} locale={i18n.resolvedLanguage} />;
}

/**
 * The presentational half — pure, so every honesty property is testable
 * without a network or a provider tree.
 *
 * The `#recycling` anchor is on the section in EVERY state, so a deep link
 * resolves on the first render rather than only once the read settles.
 */
export function RecyclingAccountView({
  state,
  locale,
}: {
  state: RecyclingAccountState;
  locale: string | undefined;
}) {
  return (
    <section
      className="an-section rc-section"
      id="recycling"
      aria-labelledby="rc-title"
      aria-busy={state.status === 'loading'}
    >
      <h2 id="rc-title">
        <Recycle aria-hidden="true" /> {copy.recycling.title}
      </h2>
      {state.status === 'loading' && (
        <p className="muted" role="status">
          {copy.recycling.loading}
        </p>
      )}
      {state.status === 'unavailable' && (
        <p className="muted" role="status" data-testid="recycling-unavailable">
          {copy.recycling.unavailable}
        </p>
      )}
      {state.status === 'ready' && (
        <AccountBody data={state.data} locale={locale} />
      )}
    </section>
  );
}

function AccountBody({
  data,
  locale,
}: {
  data: RecyclingAccountData;
  locale: string | undefined;
}) {
  const { cumulative, daily, scope, coverageFromDay } = data;
  const amt = (wei: string) => formatVpfiWei(wei, locale);
  // A day index is an identifier, not a quantity: the reader's digits,
  // but no grouping separators.
  const dayNo = (n: number) => localeNumber(n, locale, { useGrouping: false });
  const globalScope = scope === 'global';

  // The reconciliation note is shown exactly when the figures ON SCREEN
  // disagree — not as a standing caveat. The components fold EVERY
  // recorded day and the combined total only finalized ones, so the parts
  // can exceed the total but never fall short. Compared at DISPLAYED
  // precision: an excess below 0.0001 VPFI is invisible in all three cells,
  // and the note would then assert a discrepancy nothing shown supports —
  // while a part labelled "less than 0.0001" beside a combined "0" IS a
  // visible excess, which a bare units count (0 = 0) would miss. The rule
  // lives in `partsVisiblyExceed`. Never shown when the combined total
  // itself is withheld — a note explaining a figure that is not displayed
  // describes nothing.
  const partsExceedCombined =
    globalScope &&
    partsVisiblyExceed(
      [cumulative.absorbedLocal, cumulative.absorbedMirror],
      cumulative.absorbed,
    );
  // Each badge's explanation is shown only when a row on screen carries
  // that badge: a caveat whose condition is absent is noise a reader has
  // to rule out (TokenomicsTechSpec — caveats only where they hold).
  const anyEstimate = daily.some((d) => d.estimate);
  // The drawn figure's limits describe a drawn figure, so they are shown
  // only while one is on screen: the programme-wide drawn total (global
  // scope) or a committed day's drawn cell. On a local-only or empty
  // deployment the total is declined and no day carries a drawn amount,
  // and the caveat would then qualify a figure the page is withholding.
  const anyDrawnShown =
    globalScope || daily.some((d) => d.netEmission !== null);
  // "Records begin at day N; earlier days are not shown" explains a gap at
  // the START of the table, so it holds only when (a) there ARE earlier
  // programme days — day 0 is the first, so coverage from day 0 has no gap
  // to explain — and (b) the table actually begins at the coverage
  // boundary. When the window cut the table later than that, the earlier
  // days are absent because of the window, which the window note states.
  const coverageGapShown =
    coverageFromDay !== null &&
    coverageFromDay > 0 &&
    data.fromDay === coverageFromDay;

  return (
    <>
      <p className="an-note rc-lede">{copy.recycling.lede}</p>

      {!globalScope && (
        <p className="an-note" data-testid="recycling-scope-note">
          {scope === 'empty'
            ? copy.recycling.scopeEmpty
            : copy.recycling.scopeLocalOnly}
        </p>
      )}

      <dl className="rc-figures">
        {/* Programme-wide totals only where a day was finalized here. On
            any other deployment the endpoint leaves them at 0, and printing
            that 0 is exactly the "looks like a quiet programme" error — so
            the row states the total is DECLINED, and why. */}
        <div>
          <dt>{copy.recycling.absorbedTotal}</dt>
          {globalScope ? (
            <dd data-testid="recycling-absorbed">{amt(cumulative.absorbed)}</dd>
          ) : (
            <dd className="rc-refusal" data-testid="recycling-absorbed-declined">
              {copy.recycling.totalDeclined}
            </dd>
          )}
        </div>
        {/* The split is published because a combined figure alone hides
            exactly the cross-chain activity the programme exists to show. */}
        <div>
          <dt>{copy.recycling.absorbedLocal}</dt>
          <dd data-testid="recycling-absorbed-local">
            {amt(cumulative.absorbedLocal)}
          </dd>
        </div>
        <div>
          <dt>{copy.recycling.absorbedMirror}</dt>
          <dd data-testid="recycling-absorbed-mirror">
            {amt(cumulative.absorbedMirror)}
          </dd>
        </div>
        <div>
          <dt>{copy.recycling.absorbedPreLaunch}</dt>
          <dd data-testid="recycling-prelaunch">
            {amt(cumulative.absorbedPreLaunch)}
          </dd>
        </div>
        <div>
          <dt>{copy.recycling.drawnTotal}</dt>
          {globalScope ? (
            <dd data-testid="recycling-drawn">{amt(cumulative.freshDrawdown)}</dd>
          ) : (
            <dd className="rc-refusal" data-testid="recycling-drawn-declined">
              {copy.recycling.totalDeclined}
            </dd>
          )}
        </div>
        <div>
          <dt>{copy.recycling.runway}</dt>
          <dd data-testid="recycling-runway">{runwayText(cumulative, locale)}</dd>
        </div>
      </dl>

      {partsExceedCombined && (
        <p className="an-note" data-testid="recycling-split-scope">
          {copy.recycling.splitScopeNote}
        </p>
      )}

      <h3 className="rc-subheading">{copy.recycling.backingHeading}</h3>
      {/* THE RETAINED RESERVE, AND THE TOKENS BEHIND IT — both or neither.
          Every other figure here is counter-derived, and a counter cannot
          notice that the tokens behind it have left; this block is the one
          that can, and the reserve on its own is the confident-looking,
          uncheckable number the requirement exists to prevent. */}
      {data.backing.kind === 'published' ? (
        <BackingFigures backing={data.backing.backing} locale={locale} />
      ) : (
        // The REASON, never a dash: a dash reads as a zero reserve, which
        // is the opposite claim to "no current reading is available".
        <p className="an-note" data-testid="recycling-backing-unavailable">
          {copy.recycling.backingUnavailable}{' '}
          {backingWithheldText(data.backing.reason)}
          {data.backing.reason.kind === 'indexer' && data.backing.reason.pendingMigration !== null
            ? ' ' + copy.recycling.custodyPendingMigration(data.backing.reason.pendingMigration)
            : null}
        </p>
      )}

      {coverageGapShown && (
        <p className="an-note" data-testid="recycling-coverage">
          {copy.recycling.coverageFrom(dayNo(coverageFromDay))}
        </p>
      )}
      {/* The window is described by the range the indexer SERVED, not the
          number of days requested, and is omitted when no day is served —
          a note about a table that is not there describes nothing. */}
      {data.fromDay !== null && data.toDay !== null && (
        <p className="an-note" data-testid="recycling-window">
          {data.fromDay === data.toDay
            ? copy.recycling.windowSingleDay(dayNo(data.fromDay))
            : copy.recycling.windowRange(dayNo(data.fromDay), dayNo(data.toDay))}{' '}
          {globalScope
            ? copy.recycling.windowTotalsWholeProgramme
            : copy.recycling.windowTotalsRecordedHere}
        </p>
      )}

      {daily.length === 0 ? (
        <p className="an-note" data-testid="recycling-no-days">
          {copy.recycling.noRecordedDays}
        </p>
      ) : (
        // An eight-column table must scroll inside its own box: without
        // one it widens the DOCUMENT on a phone and pushes the drawn and
        // absorbed columns — the figures this section exists for — off
        // screen.
        <div className="rc-table-wrap" data-testid="recycling-table-wrap">
          <table className="rc-table recycling-days">
            <caption className="visually-hidden">
              {copy.recycling.tableCaption}
            </caption>
            <thead>
              <tr>
                <th scope="col">{copy.recycling.colDay}</th>
                <th scope="col">{copy.recycling.colFloor}</th>
                <th scope="col">{copy.recycling.colRecycled}</th>
                <th scope="col">{copy.recycling.colSelfFunded}</th>
                <th scope="col">{copy.recycling.colDrawn}</th>
                <th scope="col">{copy.recycling.colAbsorbedLocal}</th>
                <th scope="col">{copy.recycling.colAbsorbedMirror}</th>
                <th scope="col">{copy.recycling.colAbsorbed}</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <DayRow key={d.dayId} d={d} locale={locale} dayNo={dayNo} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {anyEstimate && (
        <p className="an-note" data-testid="recycling-footnote-estimate">
          {copy.recycling.footnoteEstimate}
        </p>
      )}
      {/* Always true: every section above has figure cells, and every one
          of them follows these two rules. */}
      <p className="an-note" data-testid="recycling-footnote-cells">
        {copy.recycling.footnoteCells}
      </p>
      {/* The ratified spec requires the drawn figure's limits on the SAME
          surface — a caveat kept elsewhere is one a reader over-trusts —
          and only while a drawn figure is on screen (`anyDrawnShown`). */}
      {anyDrawnShown && (
        <p className="an-note" data-testid="recycling-drawn-bounds">
          {copy.recycling.drawnBounds}
        </p>
      )}
    </>
  );
}

/** The runway cell: a figure, the self-funded state, or WHY it is withheld. */
function runwayText(c: RecyclingCumulative, locale: string | undefined): string {
  if (c.selfFunded) return copy.recycling.runwaySelfFunded;
  if (c.runwayExtensionDays !== null) {
    // Rounded DOWN to a tenth: a longevity figure must not claim more than
    // the published value supports.
    const tenths = roundedDownTenths(c.runwayExtensionDays);
    // …but a positive runway under a tenth of a day is LABELLED as such,
    // never "About 0 days": flooring to zero would state that the recycled
    // portion extended the programme by nothing, the opposite fact.
    if (c.runwayExtensionDays > 0 && tenths === 0) {
      return copy.recycling.runwayBelowPrecision(localeNumber(0.1, locale));
    }
    return copy.recycling.runwayDays(
      localeNumber(tenths / 10, locale, {
        maximumFractionDigits: 1,
      }),
    );
  }
  switch (c.runwayUnavailableReason) {
    case 'no-armed-finalized-days':
      return copy.recycling.runwayNoArmedDays;
    case 'attribution-column-unavailable':
      return copy.recycling.runwayAttributionRebuilding;
    case null:
      return copy.recycling.runwayUnknown;
    default:
      // A code this build has not been taught. Still a reason, and still
      // the indexer's — shown rather than collapsed into a generic dash.
      return copy.recycling.runwayUnrecognised(c.runwayUnavailableReason);
  }
}

/** Why the backing block is withheld — a full sentence, never a code alone. */
function backingWithheldText(reason: BackingWithheld): string {
  switch (reason.kind) {
    case 'not-served':
      return copy.recycling.backingReasonNotServed;
    case 'malformed':
      return copy.recycling.backingReasonMalformed;
    case 'incomplete':
      return copy.recycling.backingReasonIncomplete;
    case 'indexer':
      switch (reason.code) {
        case 'not-captured-yet':
          return copy.recycling.backingReasonNotCaptured;
        case 'read-failed':
          return copy.recycling.backingReasonReadFailed;
        case 'snapshot-stale':
          return copy.recycling.backingReasonStale;
        case 'chain-behind':
          return copy.recycling.backingReasonChainBehind;
        case 'snapshot-other-deployment':
          return copy.recycling.backingReasonOtherDeployment;
        default:
          return copy.recycling.backingReasonUnrecognised(reason.code);
      }
  }
}

/**
 * One programme day. Every withheld cell names its reason — the reasons are
 * chosen from the day's own flags, which `data/recycling.ts` has already
 * checked agree with its nulls.
 */
function DayRow({
  d,
  locale,
  dayNo,
}: {
  d: RecyclingDay;
  locale: string | undefined;
  dayNo: (n: number) => string;
}) {
  const amt = (wei: string) => formatVpfiWei(wei, locale);
  // A withheld cell is styled apart from a figure, and keyed by its test id
  // (unique within the row) so the absorption cells can be mapped.
  const refusal = (text: string, testId: string) => (
    <td key={testId} className="rc-refusal" data-testid={testId}>
      {text}
    </td>
  );
  const figure = (text: string, testId: string) => (
    <td key={testId} data-testid={testId}>
      {text}
    </td>
  );
  return (
    <tr data-testid={`recycling-day-${d.dayId}`}>
      <th scope="row">
        {copy.recycling.dayLabel(dayNo(d.dayId))}{' '}
        {d.estimate && (
          <span className="badge badge-warn" data-testid={`estimate-${d.dayId}`}>
            {copy.recycling.estimateBadge}
          </span>
        )}
      </th>
      {d.scheduleFloor === null
        ? refusal(copy.recycling.cellNoPool, `floor-${d.dayId}`)
        : figure(amt(d.scheduleFloor), `floor-${d.dayId}`)}
      {d.recycledBudget === null
        ? refusal(copy.recycling.cellNoPool, `recycled-${d.dayId}`)
        : figure(amt(d.recycledBudget), `recycled-${d.dayId}`)}
      {d.selfFundingRatio === null
        ? refusal(
            d.stamped ? copy.recycling.cellEmptyPool : copy.recycling.cellNoPool,
            `selffunded-${d.dayId}`,
          )
        : figure(
            formatRoundedDownPercent(d.selfFundingRatio, locale),
            `selffunded-${d.dayId}`,
          )}
      {/* An unarmed day committed nothing; an open day has no pool yet.
          Either way the cell says which — never 0. */}
      {d.netEmission === null
        ? refusal(
            d.stamped ? copy.recycling.cellNotCommitted : copy.recycling.cellNoPool,
            `drawn-${d.dayId}`,
          )
        : figure(amt(d.netEmission), `drawn-${d.dayId}`)}
      {absorptionCells(d).map((cell) =>
        cell.value === null
          ? refusal(cell.pending, cell.testId)
          : figure(amt(cell.value), cell.testId),
      )}
    </tr>
  );
}

/**
 * What a day's absorption cells may STATE — decided once, for all three.
 *
 * The endpoint publishes both components unconditionally and lets a
 * machine consumer read `stamped`; a human reading the table cannot, and to
 * them a rendered 0 under "Absorbed elsewhere" states that no other chain
 * absorbed anything — the one thing an open day cannot know, because a
 * chain reports a day only once its own clock has passed it. The local
 * term is live from the moment it happens, which is why an open day is
 * listed at all; the combined sum waits for both.
 *
 * One function rather than three inline tests: two review rounds of the
 * retired surface each put a wrong figure in a DIFFERENT one of these
 * cells, because each re-decided the rule at its own site.
 */
function absorptionCells(d: RecyclingDay): {
  value: string | null;
  pending: string;
  testId: string;
}[] {
  return [
    // Live. This is why an unfinalized row is listed at all.
    { value: d.absorbedLocal, pending: '', testId: `absorbed-local-${d.dayId}` },
    // Structurally incomplete until the day closes — withheld, not zeroed.
    {
      value: d.stamped ? d.absorbedMirror : null,
      pending: copy.recycling.cellMirrorPending,
      testId: `absorbed-mirror-${d.dayId}`,
    },
    // The endpoint already withholds the sum on an open day.
    {
      value: d.absorbed,
      pending: copy.recycling.cellCombinedPending,
      testId: `absorbed-${d.dayId}`,
    },
  ];
}

/**
 * The published backing reading: the reserve with every amount it
 * subtracts, the balance behind it with every amount set against THAT,
 * where custody is held, the indexer's verdict, and the moment and
 * contract the reading describes.
 */
function BackingFigures({
  backing: b,
  locale,
}: {
  backing: PublishableBacking;
  locale: string | undefined;
}) {
  const amt = (wei: string) => formatVpfiWei(wei, locale);
  /** A figure an older reading may lack: shown as not determinable, never 0. */
  const maybe = (wei: string | null) =>
    wei === null ? copy.recycling.olderReading : amt(wei);
  const activated = b.custodyActivated === true;
  /** The custody address's balance is a figure this reading actually holds. */
  const holderReadable = b.holderBalanceKnown === true && b.holderBalance !== null;
  /**
   * The reserve is withheld when the balance behind it is not in this reading.
   *
   * Once custody has moved, the recycled pool — and so the reserve carved
   * from it — is held at the custody address, not in the platform contract.
   * If that address's balance could not be read, the only balance left on
   * screen is the platform contract's, which no longer backs the reserve: the
   * counter-derived half would be shown alone, beside an unrelated balance
   * that invites exactly the wrong comparison. TokenomicsTechSpec: the
   * reserve and the balance behind it are published together or not at all.
   * So the reserve, its three subtrahends and the attributed total are
   * withheld WITH that reason, while the platform-contract figures and the
   * indexer's verdict (itself "not determinable" here) stay.
   *
   * DELIBERATELY NOT withheld when the custody state is unrecorded (`null`,
   * every reading stored before the field existed, or one whose source
   * could not report it). TokenomicsTechSpec's older-reading rule: a stored
   * reading remains a complete record of what it claimed to hold, and a
   * newer figure is shown as not determinable rather than the reading being
   * withdrawn. Such a reading published its reserve beside the platform
   * contract's balance, which is what it recorded; the custody row, the
   * remainder note and the verdict each say the arrangement is not
   * determinable, so no comparison is asserted. Withholding here would take
   * every pre-existing reading down for improving the disclosure — the
   * outage the rule exists to prevent.
   */
  const retainedWithheld = activated && !holderReadable;
  return (
    <>
      <dl className="rc-figures" data-testid="recycling-backing">
        {retainedWithheld ? (
          <div>
            <dt>{copy.recycling.platformRetained}</dt>
            <dd className="rc-refusal" data-testid="recycling-retained-withheld">
              {copy.recycling.retainedWithheldHolderUnread}
            </dd>
          </div>
        ) : (
          <>
            <div>
              <dt>{copy.recycling.platformRetained}</dt>
              <dd data-testid="recycling-retained">{amt(b.platformRetained)}</dd>
            </div>
            {/* The three amounts `platformRetained` is the remainder of. */}
            <div>
              <dt>{copy.recycling.bucketLabel}</dt>
              <dd data-testid="recycling-bucket">{amt(b.bucket)}</dd>
            </div>
            <div>
              <dt>{copy.recycling.outstandingRecycled}</dt>
              <dd data-testid="recycling-outstanding">{amt(b.outstandingRecycled)}</dd>
            </div>
            <div>
              <dt>{copy.recycling.keeperBudget}</dt>
              <dd data-testid="recycling-keeper">{amt(b.keeperBudget)}</dd>
            </div>
          </>
        )}
      </dl>
      {/* The note explains how the reserve is derived, so it holds only
          while the reserve is on screen — a caveat about a withheld figure
          describes nothing. */}
      {!retainedWithheld && (
        <p className="an-note" data-testid="recycling-retained-note">
          {copy.recycling.retainedNote}
        </p>
      )}

      <dl className="rc-figures">
        <div>
          <dt>{copy.recycling.custodyLabel}</dt>
          <dd data-testid="recycling-custody">
            {b.custodyActivated === null
              ? b.pendingMigration !== null
                ? copy.recycling.custodyPendingMigration(b.pendingMigration)
                : copy.recycling.custodyUnknown
              : activated
                ? copy.recycling.custodyHolder
                : copy.recycling.custodyDiamond}
          </dd>
        </div>
        <div>
          <dt>{copy.recycling.vpfiBalance}</dt>
          <dd data-testid="recycling-balance">{amt(b.vpfiBalance)}</dd>
        </div>
        {/* BOTH reservations, always — the retired surface listed neither,
            so the remainder below could not be checked. */}
        <div>
          <dt>{copy.recycling.strandedRecoveryReserved}</dt>
          <dd
            className={b.strandedRecoveryReserved === null ? 'rc-refusal' : undefined}
            data-testid="recycling-stranded-recovery"
          >
            {maybe(b.strandedRecoveryReserved)}
          </dd>
        </div>
        <div>
          <dt>{copy.recycling.recoveryPositionReserved}</dt>
          <dd
            className={b.recoveryPositionReserved === null ? 'rc-refusal' : undefined}
            data-testid="recycling-recovery-position"
          >
            {maybe(b.recoveryPositionReserved)}
          </dd>
        </div>
        <div>
          <dt>{copy.recycling.outsideBucket}</dt>
          <dd data-testid="recycling-unearmarked">{amt(b.unearmarked)}</dd>
        </div>
        {/* Only when non-zero: a permanent "stranded: 0" row is a caveat
            whose condition is absent. */}
        {BigInt(b.releasedRemitStranded) > 0n && (
          <div>
            <dt>{copy.recycling.strandedLabel}</dt>
            <dd data-testid="recycling-stranded">{amt(b.releasedRemitStranded)}</dd>
          </div>
        )}
        {/* The custody address's side of the comparison — hidden ONLY where
            custody is known not to have moved (`false`): then the address
            holds nothing this reserve depends on, and showing it would
            invite a comparison that does not apply. A reading that does not
            record the custody state (`null` — every row stored before the
            field existed) keeps both rows, each saying it is not
            determinable: an older reading shows a newer field as not
            determinable, never removes it (TokenomicsTechSpec). */}
        {b.custodyActivated !== false && (
          <>
            <div>
              <dt>{copy.recycling.holderBalance}</dt>
              <dd
                className={holderReadable ? undefined : 'rc-refusal'}
                data-testid="recycling-holder-balance"
              >
                {b.holderBalanceKnown === false
                  ? copy.recycling.holderBalanceUnreadable
                  : holderReadable
                    ? amt(b.holderBalance as string)
                    : copy.recycling.holderNotDeterminable}
              </dd>
            </div>
            {/* The attributed total is the counter-derived side of the
                custody address's comparison, so it follows the same
                together-or-not-at-all rule as the reserve above: withheld,
                with that reason, when the balance it is set against is not
                in the reading. */}
            <div>
              <dt>{copy.recycling.holderAttributed}</dt>
              <dd
                className={
                  retainedWithheld || b.holderAttributed === null ? 'rc-refusal' : undefined
                }
                data-testid="recycling-holder-attributed"
              >
                {retainedWithheld
                  ? copy.recycling.holderAttributedWithheld
                  : b.holderAttributed === null
                    ? copy.recycling.holderNotDeterminable
                    : amt(b.holderAttributed)}
              </dd>
            </div>
          </>
        )}
        {b.verdict.kind === 'served' && b.verdict.verdict.relation !== null && (
          <div>
            <dt>{copy.recycling.comparisonLabel}</dt>
            <dd data-testid="recycling-comparison">
              {b.verdict.verdict.relation === 'holder'
                ? copy.recycling.comparisonHolder
                : copy.recycling.comparisonDiamond}
            </dd>
          </div>
        )}
        <div>
          <dt>{copy.recycling.backedLabel}</dt>
          <dd
            data-testid="recycling-backed"
            data-verdict={verdictPosture(b.verdict)}
          >
            {verdictContent(b.verdict, locale)}
          </dd>
        </div>
        {/* THE MOMENT AND THE SOURCE, RENDERED. The reading is taken on a
            schedule, so it trails the chain by construction; a disclosure
            that lives only in the JSON is not one. The contract is shown
            because, after a redeploy, a block alone no longer identifies
            whose state produced these figures. */}
        <div>
          <dt>{copy.recycling.asOfLabel}</dt>
          <dd className="rc-wrap" data-testid="recycling-asof">
            {copy.recycling.asOfValue(b.blockNumber, b.asOf, b.diamond)}
          </dd>
        </div>
      </dl>
      {/* Which amounts the remainder subtracts depends on where custody is
          held; the note says which, or that the reading does not record it. */}
      <p className="an-note" data-testid="recycling-unearmarked-note">
        {b.custodyActivated === null
          ? copy.recycling.outsideBucketNoteUnknown
          : activated
            ? copy.recycling.outsideBucketNoteHolder
            : copy.recycling.outsideBucketNoteDiamond}
      </p>
    </>
  );
}

/** A machine-readable posture for the verdict cell (styling and e2e). */
function verdictPosture(view: BackingVerdictView): 'yes' | 'short' | 'undetermined' {
  if (view.kind !== 'served' || !view.verdict.determinable) return 'undetermined';
  return view.verdict.ok ? 'yes' : 'short';
}

/**
 * The verdict, as stated by the indexer. Nothing here compares amounts:
 * the shortfalls are the indexer's, formatted through the same
 * below-precision rule as every other figure — a gap under 0.0001 VPFI is
 * "short by less than 0.0001", never the false "short by 0". Unlike every
 * other amount, a shortfall rounds UP to the display unit: truncating a
 * breach figure would show it smaller than published (25.00009 as "short
 * by 25"), the flattering direction for a figure about the platform itself.
 */
function verdictContent(view: BackingVerdictView, locale: string | undefined): ReactNode {
  const gap = (wei: string) => formatVpfiWeiCeil(wei, locale);
  if (view.kind === 'not-served') return copy.recycling.backedNotServed;
  if (view.kind === 'malformed') return copy.recycling.backedMalformed;
  const v = view.verdict;
  if (!v.determinable) {
    switch (v.reason) {
      case 'custody-state-unknown':
        return copy.recycling.backedCustodyUnknown;
      case 'holder-balance-unknown':
        return copy.recycling.backedHolderBalanceUnknown;
      default:
        return copy.recycling.backedSubtrahendUnknown;
    }
  }
  if (v.relation === 'diamond') {
    return v.ok
      ? copy.recycling.backedYesDiamond
      : // Non-null by the parse-time shape check: a failing Diamond-side
        // verdict without its shortfall is refused as malformed there, so
        // no fallback here can ever print "short by 0".
        copy.recycling.backedShortDiamond(gap(v.diamondShortfall as string));
  }
  if (v.ok) return copy.recycling.backedYesHolder;
  // The holder relation has two legs and either (or both) can fail; each
  // failing leg is named with its own shortfall. The list is the WHOLE
  // answer: a determinable holder verdict means both legs were read (an
  // unread leg is "not determinable" above, and a verdict naming an unread
  // leg is refused as malformed at parse time), so no leg is missing here.
  return (
    <>
      {copy.recycling.backedNo}
      <ul className="rc-legs">
        {v.holderShortfall !== null && (
          <li data-testid="recycling-short-holder">
            {copy.recycling.backedShortHolder(gap(v.holderShortfall))}
          </li>
        )}
        {v.diamondShortfall !== null && (
          <li data-testid="recycling-short-diamond">
            {copy.recycling.backedShortHolderDiamond(gap(v.diamondShortfall))}
          </li>
        )}
      </ul>
    </>
  );
}
