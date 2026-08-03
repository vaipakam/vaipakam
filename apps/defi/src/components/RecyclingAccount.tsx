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

/** Fractional digits `formatUnitsPretty` keeps by default. */
const DISPLAY_FRAC_DIGITS = 4;
/**
 * The smallest amount that survives rendering. Anything positive below it
 * formats to "0" — which on an accounting surface is a false statement,
 * not a rounding artefact, so it is shown as a below-threshold marker.
 */
const MIN_DISPLAYABLE = 10n ** BigInt(18 - DISPLAY_FRAC_DIGITS);

/** Wire amounts are unsigned integer decimal strings. Nothing else is one. */
const WELL_FORMED_AMOUNT = /^\d+$/;

/** Every field of the payload that is a token amount. */
const AMOUNT_FIELDS = {
  cumulative: [
    'absorbed',
    'absorbedPreLaunch',
    'absorbedLocal',
    'absorbedMirror',
    'freshDrawdown',
    'recycledBudget',
  ],
  daily: [
    'scheduleFloor',
    'recycledBudget',
    'aBar',
    'freshDrawdown',
    'netEmission',
    'absorbedLocal',
    'absorbedMirror',
    'absorbed',
  ],
  // The live backing block. A new family of amounts that skipped this list
  // would be rendered unvalidated — the validator walks what it is told
  // about, and nothing else notices an omission.
  backing: [
    'vpfiBalance',
    'bucket',
    'unearmarked',
    'outstandingRecycled',
    'paidOutRecycled',
    'keeperBudget',
    'platformRetained',
    'releasedRemitStranded',
    'blockNumber',
  ],
} as const;

/**
 * Reject a payload whose amounts are not amounts, BEFORE rendering.
 *
 * `BigInt('')` throws, and this component renders inside the routed
 * surface's error boundary — so one corrupt field from a bad D1 row or a
 * tampered cache would replace the whole of /analytics with the app-crash
 * fallback. Validating here degrades to this section's own "cannot say"
 * state instead, which is both narrower and honest.
 *
 * It deliberately does NOT coerce a bad field to zero: that would turn a
 * detected corruption into a confident false figure, which is the failure
 * this entire surface is built to avoid.
 */
const wellFormedAmount = (v: unknown) =>
  v === null || (typeof v === 'string' && WELL_FORMED_AMOUNT.test(v));

/**
 * The D1-DERIVED series only. Backing is validated separately, on purpose.
 *
 * Folding backing into this check made one malformed backing amount mark
 * the WHOLE account unavailable — hiding a perfectly good day series and
 * cumulative totals. That is the opposite of the rule this component's
 * own spec clause states: a surface that cannot trust an input refuses
 * ITS OWN figures and no more. Backing is a separately captured payload,
 * so its failures belong to its own block.
 */
function seriesAmountsAreWellFormed(s: RecyclingSeries): boolean {
  const cum = s.cumulative as unknown as Record<string, unknown>;
  for (const f of AMOUNT_FIELDS.cumulative) if (!wellFormedAmount(cum[f])) return false;
  for (const d of s.daily) {
    const row = d as unknown as Record<string, unknown>;
    for (const f of AMOUNT_FIELDS.daily) if (!wellFormedAmount(row[f])) return false;
  }
  return true;
}

/** The backing block alone. A failure here withholds only that block. */
function backingAmountsAreWellFormed(b: RecyclingSeries['backing']): boolean {
  const rec = b as unknown as Record<string, unknown>;
  return AMOUNT_FIELDS.backing.every((f) => wellFormedAmount(rec[f]));
}

/**
 * The self-funded share, rounded so it can never overstate.
 *
 * `Math.round` turns 0.9995 into 100%, presenting a day that still drew a
 * fresh floor as fully self-funded — and contradicting the runway card,
 * whose `selfFunded` state is exact. Rounding DOWN means the error can
 * only ever understate how self-funding the programme was, which is the
 * safe direction for a figure the platform publishes about itself.
 *
 * No clamp at the top: the ratio is `recycledBudget / (floor +
 * recycledBudget)`, so it reaches 1 exactly when the floor is zero and
 * cannot exceed it. `Math.floor(1 * 1000) / 10` is already 100, so an
 * explicit `>= 1` branch would be unreachable — it survived deletion
 * under mutation, which is how it was found.
 */
function selfFundedPct(ratio: number): number {
  return Math.floor(ratio * 1000) / 10;
}

/**
 * What a day's absorption may STATE — decided once, for every cell.
 *
 * The wire format and this surface have different obligations, and that
 * asymmetry is the whole reason this function exists. The endpoint
 * publishes both components unconditionally and lets a machine consumer
 * read `stamped` to know what they mean. A human reading a table cannot:
 * to them a rendered `0` under "Absorbed on other reward chains" is a
 * statement that no other chain absorbed anything. So the qualifier has
 * to survive into the presented form rather than remain a flag a reader
 * is trusted to check.
 *
 * Ratified intent (TokenomicsTechSpec, day-series surface rules): the
 * platform's OWN absorption is live from the moment it happens, INCLUDING
 * for the day in progress; absorption on other reward chains is *not*
 * live and cannot be, because a chain reports a day only once its own
 * clock has passed that day. Before finalization a mirror `0` therefore
 * means "no report yet", never "nothing was absorbed".
 *
 * Why a function and not three inline `d.stamped` tests: two consecutive
 * review rounds put a wrong figure in a DIFFERENT one of these three
 * cells — r1 hid the components that ARE live, r2 published the one that
 * is NOT — because each cell re-decided the rule at its own JSX site.
 * Deciding once means a fourth absorption cell has to come here and be
 * classified, instead of quietly picking whichever neighbour it sat next
 * to.
 */
function disclosableAbsorption(d: RecyclingDay): {
  local: string | null;
  mirror: string | null;
  combined: string | null;
} {
  return {
    // Live. This is why an unfinalized row is listed at all.
    local: d.absorbedLocal,
    // Structurally incomplete until the day closes — withheld, not zeroed.
    mirror: d.stamped ? d.absorbedMirror : null,
    // The endpoint already withholds the sum on an open day: adding up
    // whichever reports happened to arrive would wear a global label it
    // has not earned. Passed through so all three live in one place.
    combined: d.absorbed,
  };
}

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
          // A null read is "we cannot say", not "nothing happened" — and
          // a malformed one is the same answer, reached differently.
          if (!s || !seriesAmountsAreWellFormed(s)) {
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
  // EVERY displayed member, not just the two I first checked. The
  // validator accepts nulls (a withheld read is all-nulls by design), so a
  // partial payload — retained present, balance null — passed the old gate
  // and rendered the reserve with an empty balance cell beside it. That is
  // the all-or-nothing rule failing on precisely the untrusted-payload
  // path it exists to cover.
  // Driven off the AMOUNT FAMILY, not a second hand-kept list.
  //
  // Two lists that must agree is how this rule failed three times in one
  // PR: the gate covered two of the four members, then four of the five
  // once `releasedRemitStranded` was added. A field can now only enter
  // the payload through `AMOUNT_FIELDS.backing`, and entering it puts the
  // field in the gate automatically. `unavailableReason` being null means
  // the read SUCCEEDED, so every amount it returns must be present; a
  // null among them is a partial payload, not a withheld one.
  const backingPublishable = (b: RecyclingSeries['backing']): boolean =>
    b.unavailableReason === null &&
    // The capture time is part of the success tuple, not decoration.
    // These figures are read on a schedule, and the ONLY thing making
    // that honest is the reader being able to judge their currency — so
    // a snapshot that cannot say when it was taken is not publishable.
    // It is required here rather than in the amount family because it is
    // a timestamp, and that family validates digit strings.
    // A PARSEABLE instant, not merely a non-empty string: `asOf:
    // "unknown"` passed a length check and was rendered as the freshness
    // disclosure, which is the same defect as omitting it.
    typeof b.asOf === 'string' &&
    Number.isFinite(Date.parse(b.asOf)) &&
    // Required, and NOT in the amount family — it is an address, and that
    // family validates digit strings. A successful read returns it, so a
    // response missing it is partial rather than withheld.
    typeof b.diamond === 'string' &&
    b.diamond.length > 0 &&
    // Malformed amounts withhold the BLOCK, not the account.
    backingAmountsAreWellFormed(b) &&
    AMOUNT_FIELDS.backing.every(
      (f) => (b as unknown as Record<string, unknown>)[f] !== null,
    );

  // An indexer that predates the backing block serves no `backing` at all.
  // Treat that as the same refusal a failed read produces — the page must
  // degrade to "cannot say", never crash the analytics surface over a
  // field that a rolling deploy legitimately has not shipped yet.
  const backing = series.backing ?? {
    vpfiBalance: null,
    bucket: null,
    unearmarked: null,
    outstandingRecycled: null,
    paidOutRecycled: null,
    keeperBudget: null,
    platformRetained: null,
    unavailableReason: 'not-served-by-this-indexer',
    asOf: null,
  };
  const backingShown = backingPublishable(backing);
  // Every amount arrives as an 18-decimal wei decimal string. Rendering it
  // verbatim shows a 20-digit integer for an ordinary figure.
  const amt = (v: string | null): string => {
    if (v === null) return '';
    const n = BigInt(v);
    // A positive amount must never render as "0". Below the display
    // threshold the formatter truncates to zero, and a zero here is
    // indistinguishable from a genuinely quiet programme — the single
    // reading this surface exists to prevent.
    if (n > 0n && n < MIN_DISPLAYABLE) return t('recycling.belowThreshold');
    return formatUnitsPretty(n, 18);
  };
  const globalScope = scope === 'global';
  // The reconciliation note is shown exactly when the figures ON SCREEN
  // actually disagree — not as a standing caveat.
  //
  // Rendering it unconditionally made two claims that are routinely false:
  // it explains a combined total that is not displayed at all under
  // `local-only` / `empty` scope, and it asserts a day is currently open
  // even when every recorded day has closed. A caveat that describes an
  // absent figure teaches a reader to distrust the ones that are present.
  //
  // The components fold EVERY recorded day and the combined total folds
  // only finalized ones, so the parts can exceed the total but never fall
  // short — testing that exact direction is both the precise trigger for
  // the confusion this note prevents, and a check on that invariant.
  //
  // Compared at DISPLAYED precision, not raw wei. The note makes a claim
  // about what is on screen ("the parts add up to more than the total
  // here"), so a reader must be able to check it by looking. An excess
  // below the display threshold is invisible in all three cells, and the
  // note would then assert a discrepancy nothing shown can support —
  // the same defect as the unconditional version, one order down.
  const shown = (v: string) => BigInt(v) / MIN_DISPLAYABLE;
  const partsExceedCombined =
    globalScope &&
    shown(cumulative.absorbedLocal) + shown(cumulative.absorbedMirror) >
      shown(cumulative.absorbed);

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
        {/* SCOPE DIFFERS from the combined total above, and saying so is
            the fix: the endpoint folds EVERY row into these components and
            only FINALIZED rows into `absorbed`, so during normal live
            operation local+mirror legitimately exceeds it. Presenting them
            adjacently without that note invites the reader to subtract. */}
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

      {partsExceedCombined && (
        <p className="muted" data-testid="recycling-split-scope">
          {t('recycling.splitScopeNote')}
        </p>
      )}

      {/* THE RETAINED RESERVE, AND THE TOKENS BEHIND IT.
          Published as a pair on purpose. Every other figure on this page
          is counter-derived, and a counter cannot notice that the tokens
          behind it have left; this is the one figure that can, and it is
          worthless alone. The ratified requirement is the reserve
          "alongside the token balance actually held", so the page renders
          BOTH or NEITHER — a reserve on its own is the confident, checkable
          -looking number the requirement exists to prevent. */}
      {backingShown ? (
        <dl className="recycling-backing" data-testid="recycling-backing">
          <div>
            <dt>{t('recycling.platformRetained')}</dt>
            <dd data-testid="recycling-retained">
              {amt(backing.platformRetained)}
            </dd>
          </div>
          <div>
            <dt>{t('recycling.vpfiBalance')}</dt>
            <dd data-testid="recycling-balance">{amt(backing.vpfiBalance)}</dd>
          </div>
          <div>
            <dt>{t('recycling.bucketLabel')}</dt>
            <dd data-testid="recycling-bucket">{amt(backing.bucket)}</dd>
          </div>
          <div>
            <dt>{t('recycling.outsideBucket')}</dt>
            <dd data-testid="recycling-unearmarked">
              {amt(backing.unearmarked)}
            </dd>
          </div>
          {/* THE VERDICT, stated rather than left to be inferred.
              `unearmarked` is `balance − bucket` FLOORED AT ZERO, so a
              bucket that is exactly consumed and one that is SHORT both
              render 0 — the lens documentation says so in as many words
              and directs a reader to compare balance against bucket. A
              page that shows only the floored value publishes the two
              states identically, which is the one distinction this whole
              block exists to make. */}
          {/* Only when non-zero: a permanent "stranded: 0" row is a
              caveat whose condition is absent, which this surface's own
              rule forbids. */}
          {backing.releasedRemitStranded !== null &&
            BigInt(backing.releasedRemitStranded) > 0n && (
              <div>
                <dt>{t('recycling.strandedLabel')}</dt>
                <dd data-testid="recycling-stranded">
                  {amt(backing.releasedRemitStranded)}
                </dd>
              </div>
            )}
          <div>
            <dt>{t('recycling.backedLabel')}</dt>
            <dd data-testid="recycling-backed">
              {BigInt(backing.vpfiBalance!) >= BigInt(backing.bucket!)
                ? t('recycling.backedYes')
                : t('recycling.backedShort', {
                    // Through `amt`, not the raw formatter. A shortfall
                    // under 0.0001 truncates to "short by 0 VPFI" — a
                    // FALSE quantified claim, and worse than the bare
                    // verdict it decorates. The below-threshold handling
                    // already existed two functions up; this new call
                    // site simply did not go through it.
                    amount: amt(
                      (
                        BigInt(backing.bucket!) - BigInt(backing.vpfiBalance!)
                      ).toString(),
                    ),
                  })}
            </dd>
          </div>
          {/* THE AGE, RENDERED. The snapshot is captured on a schedule,
              so it is minutes old by construction — and I had justified
              serving a non-live figure by saying its age was "published",
              when it was published only into the JSON. A disclosure the
              reader cannot see is not one. */}
          {backing.asOf !== null && (
            <div>
              <dt>{t('recycling.asOfLabel')}</dt>
              <dd data-testid="recycling-asof">
                {t('recycling.asOfValue', { at: backing.asOf })}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        // The REASON, never a dash: a dash reads as a zero reserve, which
        // is the opposite claim to "we could not read the chain".
        <p className="muted" data-testid="recycling-backing-unavailable">
          {t('recycling.backingUnavailable', {
            reason: backing.unavailableReason ?? 'unknown',
          })}
        </p>
      )}

      {coverageFromDay !== null && (
        <p className="muted" data-testid="recycling-coverage">
          {t('recycling.coverageFrom', { day: coverageFromDay })}
        </p>
      )}
      <p className="muted" data-testid="recycling-window">
        {t('recycling.windowNote', { days: WINDOW_DAYS })}
      </p>

      {/* An eight-column table with no scroller expands the DOCUMENT on a
          narrow viewport, pushing the drawn and absorbed columns off-screen
          — the figures this section exists to show. Same container the
          dashboard's other tables use. */}
      <div className="pd-table-wrap" data-testid="recycling-table-wrap">
        <table className="recycling-days">
        <caption className="sr-only">{t('recycling.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('recycling.colDay')}</th>
            <th scope="col">{t('recycling.colFloor')}</th>
            <th scope="col">{t('recycling.colRecycled')}</th>
            <th scope="col">{t('recycling.colSelfFunded')}</th>
            <th scope="col">{t('recycling.colDrawn')}</th>
            <th scope="col">{t('recycling.colAbsorbedLocal')}</th>
            <th scope="col">{t('recycling.colAbsorbedMirror')}</th>
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
                      pct: selfFundedPct(d.selfFundingRatio),
                    })}
              </td>
              {/* Empty, not zero: an unarmed day committed nothing. */}
              <td data-testid={`drawn-${d.dayId}`}>{amt(d.netEmission)}</td>
              {/* All three decided in `disclosableAbsorption`, never here:
                  the local term is live, the mirror term cannot be, and
                  the sum waits for both. */}
              <td data-testid={`absorbed-local-${d.dayId}`}>
                {amt(disclosableAbsorption(d).local)}
              </td>
              <td data-testid={`absorbed-mirror-${d.dayId}`}>
                {amt(disclosableAbsorption(d).mirror)}
              </td>
              <td data-testid={`absorbed-${d.dayId}`}>
                {amt(disclosableAbsorption(d).combined)}
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>

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
