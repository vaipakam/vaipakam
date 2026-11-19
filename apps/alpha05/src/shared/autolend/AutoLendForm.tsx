import { useState } from 'react';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { readMaxDurationDays } from '../post/postReview';
import { readWalletFunds } from '../offers/reads';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useStoredValue } from '../tx/txStore';
import { FormField } from '../ui/FormField';
import { autoLendDraft, DEFAULT_AUTOLEND_INPUT, localToday, parseAutoLend, type AutoLendDraft, type AutoLendError, type AutoLendField, type AutoLendInput } from './autoLend';

type Hex = `0x${string}`;

/** The store key the Lend page's Auto-lend setup lives under (the typed
 *  form, the draft, the review and its tracker). */
export const AUTOLEND_KEY = 'lend.autolend';

interface AutoLendFormProps {
  chain: SupportedChain;
  own: OwnStateClient;
  lending: Hex;
  collateral: Hex;
  meta: TokenMetaMap | null;
  onReview: (draft: AutoLendDraft) => void;
  onCancel: () => void;
  /** Where the typed form is kept (the Lend page's by default). */
  flowKey?: string;
  /** A change of an Auto-lend already on the pair, in its slot: the form
   *  opens on its recorded limits (`initial`), and adding money is optional. */
  change?: { initial: AutoLendInput; restart: boolean; slot: number };
}

/**
 * #3624 — the lender types the Auto-lend limits: the amount funded now, the
 * lowest rate, the loan-to-value ceiling, the longest term, an optional end
 * date and whether pro-rata borrowers are taken; in Advanced, the most lent
 * out at once and the smallest loan. Every figure is parsed exactly (more
 * decimals than the token has are refused, never rounded); the longest term
 * is checked against the network's live maximum. The typed form is kept,
 * so a navigation away or a review closed to change a figure keeps it.
 */
export function AutoLendForm({ chain, own, lending, collateral, meta, onReview, onCancel, flowKey = AUTOLEND_KEY, change }: AutoLendFormProps) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const [stored, setStored] = useStoredValue<AutoLendInput>(`${flowKey}:input`);
  const input = stored ?? change?.initial ?? DEFAULT_AUTOLEND_INPUT;
  const isChange = change !== undefined;
  const set = (patch: Partial<AutoLendInput>) => setStored({ ...input, ...patch });
  const [touched, setTouched] = useState<Partial<Record<AutoLendField, boolean>>>({});
  const [asked, setAsked] = useState(false);
  const show = (f: AutoLendField) => touched[f] === true || asked;
  const leave = (f: AutoLendField) => setTouched((t) => ({ ...t, [f]: true }));

  const diamond = chain.diamondAddress;
  const reads = useOwnRead(['autolend', 'form', lending.toLowerCase()], async (c) => {
    const [maxDays, funds] = await Promise.all([readMaxDurationDays(c, diamond), readWalletFunds(c, lending, own.account, diamond)]);
    return { maxDays: Number(maxDays), balance: funds.balance };
  });
  const decimals = meta?.[lending.toLowerCase()]?.decimals ?? null;
  const symbol = assetName(lending, meta);
  const maxDays = reads.data?.maxDays ?? null;
  const today = localToday();
  const parsed = decimals !== null && maxDays !== null ? parseAutoLend(input, decimals, maxDays, isAdvanced, today, isChange) : null;
  const errors = parsed && !parsed.ok ? parsed.errors : {};

  const errorText = (field: AutoLendField, e: AutoLendError | undefined): string | null => {
    if (e === undefined || !show(field)) return null;
    const percent = field === 'rate' || field === 'ltv';
    switch (e) {
      case 'empty':
        return text(percent ? 'autoLend.errPercentEmpty' : 'autoLend.errEmpty');
      case 'invalid':
        return text(field === 'days' ? 'autoLend.errDays' : 'autoLend.errInvalid');
      case 'zero':
        return text(percent ? 'autoLend.errPercentZero' : field === 'days' ? 'autoLend.errDays' : 'autoLend.errZero');
      case 'decimals':
        return percent ? text('autoLend.errPercentDecimals') : format('autoLend.errDecimals', { symbol, decimals: String(decimals ?? 0) });
      case 'high':
        return field === 'days' ? format('autoLend.errDaysHigh', { max: String(maxDays ?? '') }) : text('autoLend.errPercentHigh');
      case 'date':
        return text('autoLend.errDate');
      case 'past':
        return text('autoLend.errPast');
      case 'aboveExposure':
        return text('autoLend.errAboveExposure');
    }
  };

  const confirm = () => {
    setAsked(true);
    if (!parsed || !parsed.ok) return;
    onReview(autoLendDraft(lending, collateral, parsed.parsed, isChange, change?.slot));
  };

  const field = (f: AutoLendField, label: string, hint: string, value: string, onChange: (v: string) => void, mode: 'decimal' | 'numeric' = 'decimal') => (
    <FormField label={label} hint={hint} error={errorText(f, errors[f])}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          inputMode={mode}
          autoComplete="off"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => leave(f)}
          data-testid={`autolend-${f}`}
        />
      )}
    </FormField>
  );

  return (
    <form
      className="offer-form autolend-form"
      aria-labelledby="autolend-form-title"
      data-testid="autolend-form"
      onSubmit={(e) => {
        e.preventDefault();
        confirm();
      }}
    >
      <h3 id="autolend-form-title">{text(!isChange ? 'autoLend.formTitle' : change.restart ? 'autoLend.startTitle' : 'autoLend.changeTitle')}</h3>
      {isChange && <p className="tier-b">{text('autoLend.changeLead')}</p>}
      {field(
        'amount',
        format(isChange ? 'autoLend.addAmountLabel' : 'autoLend.amountLabel', { symbol }),
        reads.data
          ? format(isChange ? 'autoLend.addAmountHint' : 'autoLend.amountHint', { have: tokenAmount(reads.data.balance, lending, meta, format) })
          : text(isChange ? 'autoLend.addAmountHintPlain' : 'autoLend.amountHintPlain'),
        input.amount,
        (v) => set({ amount: v }),
      )}
      {field('rate', text('autoLend.rateLabel'), text('autoLend.rateHint'), input.rate, (v) => set({ rate: v }))}
      {field('ltv', text('autoLend.ltvLabel'), text('autoLend.ltvHint'), input.ltv, (v) => set({ ltv: v }))}
      {field('days', text('autoLend.daysLabel'), format('autoLend.daysHint', { max: String(maxDays ?? '…') }), input.days, (v) => set({ days: v }), 'numeric')}
      <FormField label={text('autoLend.untilLabel')} hint={text('autoLend.untilHint')} error={errorText('lendUntil', errors.lendUntil)}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            type="date"
            min={today}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={input.lendUntil}
            onChange={(e) => set({ lendUntil: e.target.value })}
            onBlur={() => leave('lendUntil')}
            data-testid="autolend-lendUntil"
          />
        )}
      </FormField>
      <div className="field field-check">
        <label>
          <input type="checkbox" checked={input.proRata} onChange={(e) => set({ proRata: e.target.checked })} data-testid="autolend-prorata" />
          <span>{text('autoLend.proRataLabel')}</span>
        </label>
        <p className="tier-a field-hint">{text('autoLend.proRataHint')}</p>
      </div>
      {isAdvanced && (
        <fieldset className="advanced-set" data-testid="autolend-advanced">
          <legend>{text('autoLend.advancedTitle')}</legend>
          {field('exposure', format('autoLend.exposureLabel', { symbol }), text(isChange ? 'autoLend.exposureHintChange' : 'autoLend.exposureHint'), input.exposure, (v) =>
            set({ exposure: v }),
          )}
          {field('minFill', format('autoLend.minFillLabel', { symbol }), text(isChange ? 'autoLend.minFillHintChange' : 'autoLend.minFillHint'), input.minFill, (v) =>
            set({ minFill: v }),
          )}
        </fieldset>
      )}
      {reads.error !== null && reads.data === null && <p className="tier-a">{format('flow.unreadable', { reason: reads.error })}</p>}
      <p className="actions">
        <button type="submit" className="btn btn-primary" disabled={parsed === null} data-testid="autolend-review">
          {text('autoLend.review')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {text('autoLend.cancel')}
        </button>
      </p>
    </form>
  );
}
