import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import type { OwnStateClient } from '../../../chain/ownRail';
import type { SupportedChain } from '../../../chain/chains';
import { useCopy, type CopyKey } from '../../../shared/copy/useCopy';
import { WhyLink } from '../../../shared/help/WhyLink';
import { refusalFromError } from '../../../shared/eligibility/refusal';
import { assetName, tokenAmount, type TokenMetaMap } from '../../../shared/reads/tokens';
import { useOwnRead } from '../../../shared/reads/useOwnRead';
import { useStoredValue } from '../../../shared/tx/txStore';
import { useMounted } from '../../../shared/tx/useReviewRefresh';
import { FormField } from '../../../shared/ui/FormField';
import { Notice } from '../../../shared/ui/Notice';
import {
  bucketsWithin,
  DEFAULT_DURATION_DAYS,
  DEFAULT_INPUT,
  EXPIRY_CHOICES,
  expiresAt,
  MAX_EXPIRY_DAYS,
  parseAmount,
  parseDays,
  parseRateBps,
  requestFigures,
  type ExpiryChoice,
  type ParseError,
  type RequestInput,
  type RequestPair,
} from './requestModel';
import { readRequestFormInputs, type RequestDraft } from './requestReview';

/** The store key the typed request is kept under, so a navigation away and
 *  back, or a review closed to change a figure, keeps what was typed. */
export const REQUEST_KEY = 'borrow.request';

const EXPIRY_LABEL: Readonly<Record<ExpiryChoice, CopyKey>> = {
  never: 'request.expiryNeverOption',
  '1d': 'request.expiry1d',
  '7d': 'request.expiry7d',
  '30d': 'request.expiry30d',
  custom: 'request.expiryOther',
};

interface RequestFormProps {
  chain: SupportedChain;
  own: OwnStateClient;
  pair: RequestPair;
  meta: TokenMetaMap | null;
  /** The confirmed request, with its expiry fixed now; the page opens the
   *  review on it. */
  onReview: (draft: RequestDraft) => void;
  onCancel: () => void;
}

/**
 * OFF-04 / OFF-07 / OFF-12 / OFF-13 / OFF-18 — the borrower types the
 * request: the exact amount, the collateral, the rate, the term (only the
 * terms the protocol has open), how long it stays open, the interest mode
 * and partial repayment. Every figure is parsed exactly (more decimals than
 * the token has are refused, never rounded), and the live summary uses the
 * protocol's list fee, so it is a floor the discount tier can only raise.
 */
export function RequestForm({ chain, own, pair, meta, onReview, onCancel }: RequestFormProps) {
  const { text, format } = useCopy();
  const [stored, setStored] = useStoredValue<RequestInput>(`${REQUEST_KEY}:input`);
  const input = stored ?? DEFAULT_INPUT;
  const set = (patch: Partial<RequestInput>) => setStored({ ...input, ...patch });
  /** Errors show once a field has been left, or after a review was asked. */
  const [touched, setTouched] = useState<Record<'amount' | 'collateral' | 'rate' | 'term' | 'expiry', boolean>>({
    amount: false,
    collateral: false,
    rate: false,
    term: false,
    expiry: false,
  });
  const [asked, setAsked] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const diamond = chain.diamondAddress;
  const inputs = useOwnRead(['borrow', 'request', 'inputs', pair.collateral.toLowerCase()], (c) => readRequestFormInputs(c, diamond, own.account, pair.collateral));

  const lendingMeta = meta?.[pair.lending.toLowerCase()];
  const collateralMeta = meta?.[pair.collateral.toLowerCase()];
  const lendingDecimals = lendingMeta?.decimals ?? null;
  const collateralDecimals = collateralMeta?.decimals ?? null;
  const lendingSymbol = assetName(pair.lending, meta);
  const collateralSymbol = assetName(pair.collateral, meta);

  const amount = lendingDecimals === null ? null : parseAmount(input.amount, lendingDecimals);
  const collateral = collateralDecimals === null ? null : parseAmount(input.collateral, collateralDecimals);
  const rate = parseRateBps(input.rate);

  const amountError = (r: typeof amount, symbol: string, decimals: number | null): string | null => {
    if (r === null || r.ok) return null;
    return parseText(r.error, symbol, decimals);
  };
  const parseText = (e: ParseError, symbol: string, decimals: number | null): string =>
    e === 'empty'
      ? text('request.errEmpty')
      : e === 'invalid'
        ? text('request.errInvalid')
        : e === 'zero'
          ? text('request.errZero')
          : format('request.errDecimals', { symbol, decimals: String(decimals ?? 0) });
  const rateError = rate.ok
    ? null
    : rate.error === 'empty'
      ? text('request.errRateEmpty')
      : rate.error === 'zero'
        ? text('request.errRateZero')
        : rate.error === 'decimals'
          ? text('request.errRateDecimals')
          : rate.error === 'high'
            ? text('request.errRateHigh')
            : text('request.errInvalid');

  const show = (field: keyof typeof touched) => touched[field] || asked;
  const leave = (field: keyof typeof touched) => setTouched((t) => ({ ...t, [field]: true }));

  // Only the terms the protocol has open are offered; a term kept from
  // before that is no longer open falls back to the longest one that is. A
  // typed term is checked against the same live maximum.
  const maxDays = inputs.data ? Number(inputs.data.maxDurationDays) : 0;
  const buckets = inputs.data ? bucketsWithin(inputs.data.maxDurationDays) : [];
  const typedTerm = parseDays(input.termDays, maxDays);
  const durationDays = input.customTerm
    ? typedTerm.ok
      ? typedTerm.value
      : null
    : buckets.includes(input.durationDays)
      ? input.durationDays
      : buckets.includes(DEFAULT_DURATION_DAYS)
        ? DEFAULT_DURATION_DAYS
        : (buckets[buckets.length - 1] ?? null);
  const termError =
    !input.customTerm || typedTerm.ok
      ? null
      : typedTerm.error === 'high'
        ? format('request.errTermHigh', { max: String(maxDays) })
        : typedTerm.error === 'empty'
          ? text('request.errDaysEmpty')
          : text('request.errDays');
  const typedExpiry = parseDays(input.expiryDays, MAX_EXPIRY_DAYS);
  const expiryOk = input.expiry !== 'custom' || typedExpiry.ok;
  const expiryError =
    input.expiry !== 'custom' || typedExpiry.ok
      ? null
      : typedExpiry.error === 'high'
        ? format('request.errExpiryHigh', { max: String(MAX_EXPIRY_DAYS) })
        : typedExpiry.error === 'empty'
          ? text('request.errDaysEmpty')
          : text('request.errDays');

  const figures = inputs.data && amount?.ok && rate.ok && durationDays !== null ? requestFigures(amount.value, rate.value, durationDays, inputs.data.lifBps) : null;
  const valid = amount?.ok === true && collateral?.ok === true && rate.ok && durationDays !== null && expiryOk && inputs.data !== null;

  // Only the latest submission, from a form still on screen for the same
  // wallet and network, may open a review: a slow block read answered after
  // the reader cancelled, or after they asked again, is dropped.
  const mounted = useMounted();
  const attempt = useRef(0);
  const identity = `${chain.chainId}:${own.account.toLowerCase()}`;
  const identityNow = useRef(identity);
  useEffect(() => {
    identityNow.current = identity;
  }, [identity]);

  const review = async () => {
    setAsked(true);
    if (!valid || !amount?.ok || !collateral?.ok || !rate.ok || durationDays === null) return;
    setOpening(null);
    const mine = ++attempt.current;
    const askedFor = identity;
    const current = () => mounted.current && attempt.current === mine && identityNow.current === askedFor;
    try {
      // The expiry is fixed from the chain's own clock now, so a re-read of
      // the review never moves the deadline under a consent.
      const block = await own.read((c) => c.getBlock({ blockTag: 'latest' }));
      if (!current()) return;
      onReview({
        parsed: {
          amount: amount.value,
          collateral: collateral.value,
          rateBps: rate.value,
          durationDays,
          expiry: input.expiry,
          fullTerm: input.fullTerm,
          allowsPartialRepay: input.allowsPartialRepay,
        },
        pair,
        expiresAt: expiresAt(input.expiry, block.value.timestamp, typedExpiry.ok ? typedExpiry.value : 0),
      });
    } catch (e) {
      if (current()) setOpening(refusalFromError(e).reason);
    }
  };

  const metaMissing = meta !== null && (lendingDecimals === null || collateralDecimals === null);

  return (
    <form
      className="request-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void review();
      }}
    >
      <h2 id="borrow-request-form">{text('request.formTitle')}</h2>
      <WhyLink summaryKey="request.openSummary" detailKey="request.openWhy" />
      {metaMissing && (
        <Notice tone="warn" tier="A">
          {text('request.metaUnread')}
        </Notice>
      )}
      {inputs.state === 'reading' && <p className="tier-b">{text('request.configReading')}</p>}
      {inputs.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('request.configUnread', { reason: inputs.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={inputs.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      <div className="request-grid">
        <FormField
          label={format('request.amountLabel', { symbol: lendingSymbol })}
          hint={text('request.amountHint')}
          error={show('amount') ? amountError(amount, lendingSymbol, lendingDecimals) : null}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={input.amount}
              onChange={(e) => set({ amount: e.target.value })}
              onBlur={() => leave('amount')}
              data-testid="request-amount"
            />
          )}
        </FormField>
        <FormField
          label={format('request.collateralLabel', { symbol: collateralSymbol })}
          hint={inputs.data ? format('request.collateralHint', { have: tokenAmount(inputs.data.balance, pair.collateral, meta, format) }) : text('request.collateralHintPlain')}
          error={show('collateral') ? amountError(collateral, collateralSymbol, collateralDecimals) : null}
        >
          {({ id, describedBy, invalid }) => (
            <div className="input-with-action">
              <input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={input.collateral}
                onChange={(e) => set({ collateral: e.target.value })}
                onBlur={() => leave('collateral')}
                data-testid="request-collateral"
              />
              {inputs.data && collateralDecimals !== null && inputs.data.balance > 0n && (
                // RB-CLICKS: Max fills the whole wallet balance, exactly.
                <button
                  type="button"
                  className="btn"
                  onClick={() => set({ collateral: formatUnits(inputs.data!.balance, collateralDecimals) })}
                  data-testid="request-collateral-max"
                >
                  {text('request.max')}
                </button>
              )}
            </div>
          )}
        </FormField>
        <FormField label={text('request.rateLabel')} hint={text('request.rateHint')} error={show('rate') ? rateError : null}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={input.rate}
              onChange={(e) => set({ rate: e.target.value })}
              onBlur={() => leave('rate')}
              data-testid="request-rate"
            />
          )}
        </FormField>
      </div>

      <fieldset className="choice-group">
        <legend>{text('request.durationLabel')}</legend>
        {inputs.data && maxDays < 1 ? (
          <Notice tone="warn" tier="A">
            {text('request.durationNone')}
          </Notice>
        ) : (
          <div className="chips" data-testid="request-duration">
            {buckets.map((d) => (
              <label key={d} className="chip">
                <input
                  type="radio"
                  name="request-duration"
                  value={d}
                  checked={!input.customTerm && durationDays === d}
                  onChange={() => set({ durationDays: d, customTerm: false })}
                />
                <span>{format('request.durationDays', { days: String(d) })}</span>
              </label>
            ))}
            {inputs.data && (
              <label className="chip">
                <input type="radio" name="request-duration" value="other" checked={input.customTerm} onChange={() => set({ customTerm: true })} />
                <span>{text('request.durationOther')}</span>
              </label>
            )}
          </div>
        )}
        {input.customTerm && (
          <FormField label={text('request.termDaysLabel')} error={show('term') ? termError : null}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={input.termDays}
                onChange={(e) => set({ termDays: e.target.value })}
                onBlur={() => leave('term')}
                data-testid="request-term-days"
              />
            )}
          </FormField>
        )}
        {inputs.data && maxDays >= 1 && <p className="tier-b field-hint">{format('request.durationHint', { max: String(maxDays) })}</p>}
      </fieldset>

      <FormField label={text('request.expiryLabel')}>
        {({ id }) => (
          <select id={id} value={input.expiry} onChange={(e) => set({ expiry: e.target.value as ExpiryChoice })} data-testid="request-expiry">
            {EXPIRY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {text(EXPIRY_LABEL[c])}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {input.expiry === 'custom' && (
        <FormField label={text('request.expiryDaysLabel')} hint={format('request.expiryDaysHint', { max: String(MAX_EXPIRY_DAYS) })} error={show('expiry') ? expiryError : null}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={input.expiryDays}
              onChange={(e) => set({ expiryDays: e.target.value })}
              onBlur={() => leave('expiry')}
              data-testid="request-expiry-days"
            />
          )}
        </FormField>
      )}

      <fieldset className="choice-group">
        <legend>{text('request.interestLabel')}</legend>
        <label className="choice">
          <input type="radio" name="request-interest" checked={input.fullTerm} onChange={() => set({ fullTerm: true })} />
          <span>{text('request.fullTermOption')}</span>
        </label>
        <label className="choice">
          <input type="radio" name="request-interest" checked={!input.fullTerm} onChange={() => set({ fullTerm: false })} data-testid="request-prorata" />
          <span>{text('request.proRataOption')}</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={input.allowsPartialRepay} onChange={(e) => set({ allowsPartialRepay: e.target.checked })} data-testid="request-partial" />
          <span>{text('request.partialOption')}</span>
        </label>
        <WhyLink summaryKey="request.optionsSummary" detailKey="request.optionsWhy" />
      </fieldset>

      {opening !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: opening })}
        </Notice>
      )}

      <div className="thumb-action">
        {figures && (
          <p className="tier-b request-summary" data-testid="request-summary" aria-live="polite">
            {format('request.summary', { receive: tokenAmount(figures.received, pair.lending, meta, format), owe: tokenAmount(figures.owedAtDue, pair.lending, meta, format) })}
          </p>
        )}
        <div className="thumb-buttons">
          <button type="submit" className="btn btn-primary" disabled={inputs.data === null} data-testid="request-review">
            {text('request.review')}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            {text('request.cancelForm')}
          </button>
        </div>
      </div>
    </form>
  );
}
