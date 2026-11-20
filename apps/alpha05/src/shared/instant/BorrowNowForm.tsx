import { useState } from 'react';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { readMaxDurationDays } from '../post/postReview';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useStoredValue } from '../tx/txStore';
import { FormField } from '../ui/FormField';
import { DEFAULT_BORROW_NOW, parseBorrowNow, type BorrowNowError, type BorrowNowField, type BorrowNowInput, type BorrowNowTerms } from './borrowNow';

type Hex = `0x${string}`;

/** The store key the Borrow page's "Borrow now" lives under (the typed
 *  form, the terms under review, the review and its tracker). */
export const BORROW_NOW_KEY = 'borrow.now';

interface BorrowNowFormProps {
  chain: SupportedChain;
  lending: Hex;
  collateral: Hex;
  meta: TokenMetaMap | null;
  disabled: boolean;
  onReview: (terms: BorrowNowTerms) => void;
}

/**
 * #3761 — the form the Borrow page opens on: the amount, the most collateral
 * to lock, the term and the highest rate, each stated by the borrower (no
 * rate is suggested). Every loan it opens ends on its due date: renewal is
 * not built, so the form offers a stated term only (#3763, §4.1).
 */
export function BorrowNowForm({ chain, lending, collateral, meta, disabled, onReview }: BorrowNowFormProps) {
  const { text, format } = useCopy();
  const [stored, setStored] = useStoredValue<BorrowNowInput>(`${BORROW_NOW_KEY}:input`);
  const input = stored ?? DEFAULT_BORROW_NOW;
  const set = (patch: Partial<BorrowNowInput>) => setStored({ ...input, ...patch });
  const [touched, setTouched] = useState<Partial<Record<BorrowNowField, boolean>>>({});
  const [asked, setAsked] = useState(false);
  const show = (f: BorrowNowField) => touched[f] === true || asked;
  const leave = (f: BorrowNowField) => setTouched((t) => ({ ...t, [f]: true }));

  const diamond = chain.diamondAddress;
  const maxRead = useOwnRead(['borrowNow', 'maxDays'], (c) => readMaxDurationDays(c, diamond).then(Number));
  const maxDays = maxRead.data ?? null;
  const lendDecimals = meta?.[lending.toLowerCase()]?.decimals ?? null;
  const collDecimals = meta?.[collateral.toLowerCase()]?.decimals ?? null;
  const lend = assetName(lending, meta);
  const coll = assetName(collateral, meta);
  const parsed =
    lendDecimals !== null && collDecimals !== null && maxDays !== null
      ? parseBorrowNow(input, lending, collateral, { lending: lendDecimals, collateral: collDecimals }, maxDays)
      : null;
  const errors = parsed && !parsed.ok ? parsed.errors : {};

  const errorText = (field: BorrowNowField, e: BorrowNowError | undefined): string | null => {
    if (e === undefined || !show(field)) return null;
    const rate = field === 'rate';
    switch (e) {
      case 'empty':
        return text(rate ? 'borrowNow.errPercentEmpty' : field === 'days' ? 'borrowNow.errDays' : 'borrowNow.errEmpty');
      case 'invalid':
        return text(field === 'days' ? 'borrowNow.errDays' : 'borrowNow.errInvalid');
      case 'zero':
        return text(rate ? 'borrowNow.errPercentZero' : field === 'days' ? 'borrowNow.errDays' : 'borrowNow.errZero');
      case 'decimals':
        return rate
          ? text('borrowNow.errPercentDecimals')
          : format('borrowNow.errDecimals', { symbol: field === 'amount' ? lend : coll, decimals: String((field === 'amount' ? lendDecimals : collDecimals) ?? 0) });
      case 'high':
        return field === 'days' ? format('borrowNow.errDaysHigh', { max: String(maxDays ?? '') }) : text('borrowNow.errPercentHigh');
    }
  };

  const field = (f: BorrowNowField, label: string, hint: string, value: string, onChange: (v: string) => void, mode: 'decimal' | 'numeric' = 'decimal') => (
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
          data-testid={`borrownow-${f}`}
        />
      )}
    </FormField>
  );

  return (
    <form
      className="offer-form borrownow-form"
      aria-labelledby="borrownow-form-title"
      data-testid="borrownow-form"
      onSubmit={(e) => {
        e.preventDefault();
        setAsked(true);
        if (parsed && parsed.ok) onReview(parsed.terms);
      }}
    >
      <h3 id="borrownow-form-title">{text('borrowNow.formTitle')}</h3>
      <p className="tier-a">{text('borrowNow.lead')}</p>
      {field('amount', format('borrowNow.amountLabel', { symbol: lend }), text('borrowNow.amountHint'), input.amount, (v) => set({ amount: v }))}
      {field('collateral', format('borrowNow.collateralLabel', { symbol: coll }), text('borrowNow.collateralHint'), input.collateral, (v) => set({ collateral: v }))}
      {field('days', text('borrowNow.daysLabel'), format('borrowNow.daysHint', { max: String(maxDays ?? '…') }), input.days, (v) => set({ days: v }), 'numeric')}
      {field('rate', text('borrowNow.rateLabel'), text('borrowNow.rateHint'), input.rate, (v) => set({ rate: v }))}
      <div className="field field-check">
        <label>
          <input type="checkbox" checked={input.allowsPartialRepay} onChange={(e) => set({ allowsPartialRepay: e.target.checked })} data-testid="borrownow-partial" />
          <span>{text('borrowNow.partialLabel')}</span>
        </label>
        <p className="tier-a field-hint">{text('borrowNow.partialHint')}</p>
      </div>
      {maxRead.error !== null && maxRead.data === null && <p className="tier-a">{format('flow.unreadable', { reason: maxRead.error })}</p>}
      <p className="actions">
        <button type="submit" className="btn btn-primary" disabled={disabled || parsed === null} data-testid="borrownow-review">
          {text('borrowNow.review')}
        </button>
      </p>
    </form>
  );
}
