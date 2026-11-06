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
import { useMode } from '../../../app/ModeContext';
import { Notice } from '../../../shared/ui/Notice';
import {
  advancedSet,
  bucketsWithin,
  DEFAULT_DURATION_DAYS,
  DEFAULT_INPUT,
  EXPIRY_CHOICES,
  expiresAt,
  FILL_MODES,
  fillModeBlock,
  rangeError,
  MAX_EXPIRY_DAYS,
  parseAmount,
  parseDays,
  parseRateBps,
  requestFigures,
  type ExpiryChoice,
  type FillMode,
  type ParseError,
  type RequestAssets,
  type RequestInput,
} from './requestModel';
import { holds, parseQuantity, parseTokenId, readErc1155, readErc721 } from '../../../shared/nft/nft';
import { readRequestFormInputs, type RequestDraft } from './requestReview';

/** The store key the typed request is kept under, so a navigation away and
 *  back, or a review closed to change a figure, keeps what was typed. */
export const REQUEST_KEY = 'borrow.request';

const FILL_LABEL: Readonly<Record<FillMode, CopyKey>> = {
  partial: 'request.fillPartial',
  aon: 'request.fillAon',
  ioc: 'request.fillIoc',
};

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
  /** The two assets, and the standard the collateral claims. */
  pair: RequestAssets;
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
 * NFT-13: an ERC-721 collateral is one token, named by its id; the form
 * says live whether this wallet holds it, and the review checks it again.
 * OFF-10 / OFF-11 (Advanced): an amount range with an optional floor
 * collateral, and the fill mode. Set in Advanced, they still apply in Basic,
 * which says so and offers to clear them (RB-MODE never drops a choice).
 */
export function RequestForm({ chain, own, pair, meta, onReview, onCancel }: RequestFormProps) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const [stored, setStored] = useStoredValue<RequestInput>(`${REQUEST_KEY}:input`);
  // A request kept from before a field existed reads that field's default.
  const input: RequestInput = { ...DEFAULT_INPUT, ...stored };
  const set = (patch: Partial<RequestInput>) => setStored({ ...input, ...patch });
  /** Errors show once a field has been left, or after a review was asked. */
  const [touched, setTouched] = useState<Record<'amount' | 'amountMax' | 'floor' | 'collateral' | 'tokenId' | 'rate' | 'term' | 'expiry', boolean>>({
    amount: false,
    amountMax: false,
    floor: false,
    collateral: false,
    tokenId: false,
    rate: false,
    term: false,
    expiry: false,
  });
  const [asked, setAsked] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const diamond = chain.diamondAddress;
  const nft = pair.standard === 'erc721';
  /** An ERC-1155 collateral: a quantity of one token, named by its id. */
  const multi = pair.standard === 'erc1155';
  const named = nft || multi;
  const inputs = useOwnRead(['borrow', 'request', 'inputs', pair.collateral.toLowerCase(), pair.standard], (c) =>
    readRequestFormInputs(c, diamond, own.account, pair.collateral, pair.standard),
  );
  const tokenId = named ? parseTokenId(input.tokenId) : null;
  // Who holds the typed token, read live so the reader learns before the
  // review whether it is theirs; the review reads it again at one block.
  const token = useOwnRead(
    ['borrow', 'request', 'token', pair.collateral.toLowerCase(), String(tokenId)],
    (c) => readErc721(c, pair.collateral, tokenId ?? 0n, own.account, diamond),
    { enabled: nft && tokenId !== null, perBlock: true },
  );
  // How many of the typed ERC-1155 token the wallet holds, read live too.
  const units = useOwnRead(
    ['borrow', 'request', 'units', pair.collateral.toLowerCase(), String(tokenId)],
    (c) => readErc1155(c, pair.collateral, tokenId ?? 0n, own.account, diamond),
    { enabled: multi && tokenId !== null, perBlock: true },
  );

  const lendingMeta = meta?.[pair.lending.toLowerCase()];
  const collateralMeta = meta?.[pair.collateral.toLowerCase()];
  const lendingDecimals = lendingMeta?.decimals ?? null;
  const collateralDecimals = collateralMeta?.decimals ?? null;
  const lendingSymbol = assetName(pair.lending, meta);
  const collateralSymbol = assetName(pair.collateral, meta);

  const amount = lendingDecimals === null ? null : parseAmount(input.amount, lendingDecimals);
  const collateral = named || collateralDecimals === null ? null : parseAmount(input.collateral, collateralDecimals);
  const quantity = multi ? parseQuantity(input.collateral) : null;
  const quantityError = !multi || quantity !== null ? null : input.collateral.trim() === '' ? text('request.errQuantityEmpty') : text('request.errQuantity');
  const tokenIdError = !named || tokenId !== null ? null : input.tokenId.trim() === '' ? text('request.errTokenIdEmpty') : text('request.errTokenId');
  // A failed read, first or a refresh behind an earlier answer, is stated
  // as unknown: a cached holder is never shown as current.
  const unitsStanding =
    !multi || tokenId === null
      ? null
      : units.error !== null
        ? { tone: 'warn' as const, text: format('request.tokenUnread', { reason: units.error }) }
        : units.data === null
          ? null
          : units.data.balance === 0n
            ? { tone: 'warn' as const, text: format('request.unitsNone', { id: String(tokenId) }) }
            : { tone: 'ok' as const, text: format('request.unitsHeld', { have: String(units.data.balance) }) };
  const tokenStanding = multi
    ? unitsStanding
    : !nft || tokenId === null
      ? null
      : token.error !== null
        ? { tone: 'warn' as const, text: format('request.tokenUnread', { reason: token.error }) }
        : token.data === null
          ? null
          : token.data.owner === null
        ? { tone: 'warn' as const, text: format('request.tokenMissing', { id: String(tokenId) }) }
        : holds(token.data, own.account)
          ? { tone: 'ok' as const, text: text('request.tokenHeld') }
          : { tone: 'warn' as const, text: text('request.tokenNotHeld') };
  const rate = parseRateBps(input.rate);
  // OFF-10: a range needs ERC-20 collateral; one kept from an ERC-20 pair
  // does not carry over to a token.
  const ranged = input.ranged && !named;
  const amountMax = ranged && lendingDecimals !== null ? parseAmount(input.amountMax, lendingDecimals) : null;
  const floorTyped = ranged && input.collateralFloor.trim() !== '';
  const floor = floorTyped && collateralDecimals !== null ? parseAmount(input.collateralFloor, collateralDecimals) : null;
  const shapeError =
    ranged && amount?.ok && amountMax?.ok && collateral?.ok
      ? rangeError(amount.value, amountMax.value, collateral.value, floor?.ok ? floor.value : collateral.value)
      : null;
  const fillBlock = fillModeBlock(input.fillMode, ranged, input.expiry);
  const effective = advancedSet({ ...input, ranged });

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
  /** The largest amount, for the live summary of a range. */
  const largest = ranged && amountMax?.ok ? amountMax.value : null;
  const collateralOk = nft ? tokenId !== null : multi ? tokenId !== null && quantity !== null : collateral?.ok === true;
  const rangeOk = !ranged || (amountMax?.ok === true && (!floorTyped || floor?.ok === true) && shapeError === null);
  const valid = amount?.ok === true && collateralOk && rate.ok && durationDays !== null && expiryOk && rangeOk && fillBlock === null && inputs.data !== null;

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
    if (!valid || !amount?.ok || !rate.ok || durationDays === null) return;
    const locked = nft ? (tokenId === null ? null : 1n) : multi ? quantity : collateral?.ok ? collateral.value : null;
    if (locked === null) return;
    const max = ranged && amountMax?.ok ? amountMax.value : amount.value;
    const floorValue = ranged && floor?.ok ? floor.value : locked;
    const leg =
      nft && tokenId !== null
        ? { kind: 'erc721' as const, tokenId }
        : multi && tokenId !== null
          ? { kind: 'erc1155' as const, tokenId, quantity: locked }
          : { kind: 'erc20' as const };
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
          amountMax: max,
          collateral: locked,
          collateralFloor: floorValue,
          fillMode: input.fillMode,
          rateBps: rate.value,
          durationDays,
          expiry: input.expiry,
          fullTerm: input.fullTerm,
          allowsPartialRepay: input.allowsPartialRepay,
        },
        pair: { lending: pair.lending, collateral: pair.collateral, leg },
        expiresAt: expiresAt(input.expiry, block.value.timestamp, typedExpiry.ok ? typedExpiry.value : 0),
      });
    } catch (e) {
      if (current()) setOpening(refusalFromError(e).reason);
    }
  };

  // A token's collection has no decimals; only an ERC-20 collateral needs them.
  const metaMissing = meta !== null && (lendingDecimals === null || (!named && collateralDecimals === null));

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
          label={format(ranged ? 'request.amountMinLabel' : 'request.amountLabel', { symbol: lendingSymbol })}
          hint={text(ranged ? 'request.amountMinHint' : 'request.amountHint')}
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
        {named ? (
          <FormField label={format('request.tokenIdLabel', { symbol: collateralSymbol })} hint={text('request.tokenIdHint')} error={show('tokenId') ? tokenIdError : null}>
            {({ id, describedBy, invalid }) => (
              <>
                <input
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={input.tokenId}
                  onChange={(e) => set({ tokenId: e.target.value })}
                  onBlur={() => leave('tokenId')}
                  data-testid="request-token-id"
                />
                {tokenStanding !== null && (
                  <p
                    className={`tier-b field-hint token-standing token-standing-${tokenStanding.tone}`}
                    aria-live="polite"
                    data-testid="request-token-standing"
                    data-tone={tokenStanding.tone}
                  >
                    {tokenStanding.text}
                  </p>
                )}
              </>
            )}
          </FormField>
        ) : null}
        {multi && (
          <FormField
            label={format('request.quantityLabel', { symbol: collateralSymbol })}
            hint={units.data && tokenId !== null ? format('request.quantityHint', { have: String(units.data.balance) }) : text('request.quantityHintPlain')}
            error={show('collateral') ? quantityError : null}
          >
            {({ id, describedBy, invalid }) => (
              <div className="input-with-action">
                <input
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={input.collateral}
                  onChange={(e) => set({ collateral: e.target.value })}
                  onBlur={() => leave('collateral')}
                  data-testid="request-quantity"
                />
                {units.data && tokenId !== null && units.data.balance > 0n && (
                  // RB-CLICKS: Max fills everything the wallet holds of the token.
                  <button type="button" className="btn" onClick={() => set({ collateral: units.data!.balance.toString() })} data-testid="request-quantity-max">
                    {text('request.max')}
                  </button>
                )}
              </div>
            )}
          </FormField>
        )}
        {!named && (
          <FormField
            label={format('request.collateralLabel', { symbol: collateralSymbol })}
            hint={
              inputs.data && inputs.data.balance !== null
                ? format('request.collateralHint', { have: tokenAmount(inputs.data.balance, pair.collateral, meta, format) })
                : text('request.collateralHintPlain')
            }
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
                {inputs.data && inputs.data.balance !== null && collateralDecimals !== null && inputs.data.balance > 0n && (
                  // RB-CLICKS: Max fills the whole wallet balance, exactly.
                  <button
                    type="button"
                    className="btn"
                    onClick={() => set({ collateral: formatUnits(inputs.data!.balance!, collateralDecimals) })}
                    data-testid="request-collateral-max"
                  >
                    {text('request.max')}
                  </button>
                )}
              </div>
            )}
          </FormField>
        )}
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

      {isAdvanced ? (
        <section className="advanced-options" aria-labelledby="request-advanced" data-testid="request-advanced">
          <h3 id="request-advanced">{text('request.advancedTitle')}</h3>
          <fieldset className="choice-group">
            <legend className="sr-only">{text('request.rangeOption')}</legend>
            <label className="choice">
              <input
                type="checkbox"
                checked={ranged}
                disabled={named}
                onChange={(e) => set({ ranged: e.target.checked, ...(e.target.checked && input.fillMode === 'aon' ? { fillMode: 'partial' as const } : {}) })}
                data-testid="request-range"
              />
              <span>{text('request.rangeOption')}</span>
            </label>
            {named && <p className="tier-b field-hint">{text('request.rangeNft')}</p>}
            {ranged && (
              <div className="request-grid">
                <FormField
                  label={format('request.amountMaxLabel', { symbol: lendingSymbol })}
                  hint={text('request.amountMaxHint')}
                  error={
                    show('amountMax')
                      ? amountMax !== null && !amountMax.ok
                        ? parseText(amountMax.error, lendingSymbol, lendingDecimals)
                        : shapeError === 'max-below-min'
                          ? text('request.errMaxBelowMin')
                          : null
                      : null
                  }
                >
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={input.amountMax}
                      onChange={(e) => set({ amountMax: e.target.value })}
                      onBlur={() => leave('amountMax')}
                      data-testid="request-amount-max"
                    />
                  )}
                </FormField>
                <FormField
                  label={format('request.floorLabel', { symbol: collateralSymbol })}
                  hint={text('request.floorHint')}
                  error={
                    show('floor')
                      ? floor !== null && !floor.ok
                        ? parseText(floor.error, collateralSymbol, collateralDecimals)
                        : shapeError === 'floor-above-lock'
                          ? text('request.errFloorAbove')
                          : null
                      : null
                  }
                >
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      value={input.collateralFloor}
                      onChange={(e) => set({ collateralFloor: e.target.value })}
                      onBlur={() => leave('floor')}
                      data-testid="request-floor"
                    />
                  )}
                </FormField>
              </div>
            )}
            <WhyLink summaryKey="request.rangeSummary" detailKey="request.rangeWhy" />
          </fieldset>
          <fieldset className="choice-group" data-testid="request-fill">
            <legend>{text('request.fillLabel')}</legend>
            {FILL_MODES.map((m) => {
              const blocked = fillModeBlock(m, ranged, input.expiry);
              return (
                <label key={m} className="choice">
                  <input type="radio" name="request-fill" value={m} checked={input.fillMode === m} disabled={blocked !== null && input.fillMode !== m} onChange={() => set({ fillMode: m })} />
                  <span>{text(FILL_LABEL[m])}</span>
                </label>
              );
            })}
            {fillBlock !== null && (
              <Notice tone="warn" tier="A">
                {text(fillBlock === 'aon-range' ? 'request.fillAonRange' : 'request.fillIocOpen')}
              </Notice>
            )}
            <WhyLink summaryKey="request.fillSummary" detailKey="request.fillWhy" />
          </fieldset>
        </section>
      ) : (
        effective.length > 0 && (
          // RB-MODE: an Advanced choice still applies in Basic, and says so.
          <Notice tone="warn" tier="A">
            <span data-testid="request-advanced-set">
              {format('request.advancedSetNote', {
                list:
                  effective.length === 2
                    ? format('request.advancedList', { a: text('request.advancedRange'), b: text('request.advancedFill') })
                    : text(effective[0] === 'range' ? 'request.advancedRange' : 'request.advancedFill'),
              })}
            </span>{' '}
            <button type="button" className="btn" onClick={() => set({ ranged: false, amountMax: '', collateralFloor: '', fillMode: 'partial' })} data-testid="request-advanced-clear">
              {text('request.advancedClear')}
            </button>
          </Notice>
        )
      )}
      {fillBlock !== null && !isAdvanced && (
        <Notice tone="warn" tier="A">
          {text(fillBlock === 'aon-range' ? 'request.fillAonRange' : 'request.fillIocOpen')}
        </Notice>
      )}

      {opening !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: opening })}
        </Notice>
      )}

      <div className="thumb-action">
        {figures && (
          <p className="tier-b request-summary" data-testid="request-summary" aria-live="polite">
            {largest !== null
              ? format('request.rangeReceiveSummary', {
                  receive: tokenAmount(figures.received, pair.lending, meta, format),
                  owe: tokenAmount(figures.owedAtDue, pair.lending, meta, format),
                  largest: tokenAmount(largest, pair.lending, meta, format),
                })
              : format('request.summary', { receive: tokenAmount(figures.received, pair.lending, meta, format), owe: tokenAmount(figures.owedAtDue, pair.lending, meta, format) })}
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
