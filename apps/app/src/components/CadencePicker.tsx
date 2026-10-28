/**
 * The create form's interest-schedule picker (#2524).
 *
 * Every option's state comes from `previewCadenceAdmission`, the cadence
 * rule offer creation runs: an open schedule can be chosen, a closed one
 * is shown with the protocol's reason and cannot. When the rule closes
 * everything but "once, when the loan is repaid" for a reason that applies
 * to the whole offer (the switch is off, an asset cannot be priced), the
 * picker is replaced by one line saying so, since there is no choice to
 * make. When the verdict is unknown the form says why, and only "once,
 * when the loan is repaid" passes (`cadenceAllowed`).
 *
 * In Basic mode the picker appears only when the chosen schedule is not
 * allowed, so a new user is asked to choose only when a choice is needed.
 */
import { formatUnits } from 'viem';
import { copy } from '../content/copy';
import {
  CADENCES,
  CADENCE_NONE,
  cadenceAllowed,
  type CadenceAdmission,
  type CadencePreview,
  type CadenceRefusal,
} from '../data/cadenceAdmission';

export function cadenceLabel(cadence: number): string {
  const t = copy.offerFlow.cadence;
  switch (cadence) {
    case 0:
      return t.none;
    case 1:
      return t.monthly;
    case 2:
      return t.quarterly;
    case 3:
      return t.semiAnnual;
    case 4:
      return t.annual;
    default:
      return copy.acceptTerms.cadenceUnknown;
  }
}

/** A 1e18 numeraire figure, with its unit or the stated unknown unit. */
function numeraireFigure(value: bigint, preview: CadencePreview): string {
  const n = Number(formatUnits(value, 18)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  return preview.numeraire
    ? `${n} ${preview.numeraire.symbol}`
    : `${n} ${copy.offerFlow.cadence.unitUnknown}`;
}

export function refusalText(r: CadenceRefusal, preview: CadencePreview): string {
  const t = copy.offerFlow.cadence.refusal;
  switch (r.kind) {
    case 'switched-off':
      return t.switchedOff;
    case 'illiquid':
      if (!r.principalLiquid && !r.collateralLiquid) return t.illiquidBoth;
      if (!r.principalLiquid) return t.illiquidLending;
      if (!r.collateralLiquid) return t.illiquidCollateral;
      // Both priced, so a leg is not an ERC-20 token.
      return t.illiquidKind;
    case 'yearly-floor':
      return t.yearlyFloor;
    case 'below-threshold':
      return t.belowThreshold(
        numeraireFigure(r.threshold, preview),
        numeraireFigure(r.principalNumeraire, preview),
      );
    case 'interval':
      return t.interval(String(r.intervalDays));
    case 'other':
      return t.other;
    case 'unevaluated':
      return t.unevaluated;
  }
}

/** The offer-wide reason only "once, when the loan is repaid" is open, or
 *  `null` when schedules are a real choice for these terms. */
function offerWideNote(preview: CadencePreview): string | null {
  const t = copy.offerFlow.cadence;
  if (!preview.periodicInterestEnabled) return t.switchedOffNote;
  if (!preview.bothLegsQualify) {
    const monthly = preview.cadences.find((c) => c.cadence === 1)?.refusal;
    const reason =
      monthly && monthly.kind === 'illiquid'
        ? refusalText(monthly, preview)
        : t.refusal.illiquidKind;
    return t.illiquidNote(reason);
  }
  return null;
}

interface Props {
  admission: CadenceAdmission;
  value: number;
  onChange: (cadence: number) => void;
  onRetry: () => void;
  isAdvanced: boolean;
}

export function CadencePicker({ admission, value, onChange, onRetry, isAdvanced }: Props) {
  const t = copy.offerFlow.cadence;
  if (admission.kind === 'idle') return null;
  const allowed = cadenceAllowed(admission, value);
  if (!isAdvanced && allowed) return null;

  if (admission.kind !== 'known') {
    const line =
      admission.kind === 'checking'
        ? t.checking
        : admission.kind === 'unserved'
          ? t.unserved
          : t.failed;
    return (
      <div className="stack" data-testid="cadence-picker" data-state={admission.kind}>
        <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
          {line}
        </p>
        {admission.kind === 'failed' ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            {copy.offerFlow.retry}
          </button>
        ) : null}
        {!allowed && admission.kind !== 'checking' ? (
          <p className="field-hint" style={{ color: 'var(--danger)', margin: 0 }}>
            {t.selectedUnchecked}
          </p>
        ) : null}
        {value !== CADENCE_NONE ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onChange(CADENCE_NONE)}
          >
            {t.none}
          </button>
        ) : null}
      </div>
    );
  }

  const { preview } = admission;
  const note = offerWideNote(preview);
  if (note !== null && allowed) {
    return (
      <p
        className="muted"
        style={{ fontSize: '0.85rem', margin: 0 }}
        data-testid="cadence-picker"
        data-state="none-only"
      >
        {note}
      </p>
    );
  }

  return (
    <fieldset
      style={{ border: 'none', margin: 0, padding: 0 }}
      className="stack"
      data-testid="cadence-picker"
      data-state="choice"
    >
      <legend style={{ paddingBottom: 8 }}>{t.legend}</legend>
      {CADENCES.map((cadence) => {
        const verdict = preview.cadences.find((c) => c.cadence === cadence);
        const open = verdict?.admitted === true;
        const reason = verdict?.refusal ? refusalText(verdict.refusal, preview) : null;
        return (
          <label
            key={cadence}
            className="cluster"
            style={{ fontSize: '0.9rem', alignItems: 'flex-start' }}
            data-testid={`cadence-option-${cadence}`}
            data-admitted={open ? 'true' : 'false'}
          >
            <input
              type="radio"
              name="periodic-interest-cadence"
              value={cadence}
              checked={value === cadence}
              disabled={!open}
              // Disclosure-driving term — the review restates it and
              // consent is given against it.
              onChange={() => onChange(cadence)}
            />
            <span className="stack" style={{ gap: 2 }}>
              <span>{cadenceLabel(cadence)}</span>
              {reason ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  {reason}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
      <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
        {t.periodsNote}
      </p>
      {!allowed ? (
        <p
          className="field-hint"
          style={{ color: 'var(--danger)', margin: 0 }}
          data-testid="cadence-selected-refused"
        >
          {t.selectedRefused}
        </p>
      ) : null}
    </fieldset>
  );
}
