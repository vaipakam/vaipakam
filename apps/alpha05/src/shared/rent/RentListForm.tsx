import { useId, useState } from 'react';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { faucetAssets } from '../faucet/faucet';
import { WhyLink } from '../help/WhyLink';
import { parseTokenId } from '../nft/nft';
import { useAssetStandard } from '../nft/useStandard';
import { parsePasted, suggestedAssets } from '../offers/assets';
import { EXPIRY_CHOICES, expiresAt, MAX_EXPIRY_DAYS, parseAmount, parseDays, type ExpiryChoice } from '../post/postModel';
import { readMaxDurationDays } from '../post/postReview';
import { assetName, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useStoredValue } from '../tx/txStore';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { parseUnits, type ListDraft } from './listModel';

type Hex = `0x${string}`;

const OTHER = 'other';

/** What the owner typed, kept in the app's store so a navigation away and
 *  back reopens the same form. */
export interface ListInput {
  nft: string;
  tokenId: string;
  quantity: string;
  payment: string;
  fee: string;
  days: string;
  fullTerm: boolean;
  expiry: ExpiryChoice;
  expiryDays: string;
}

const DEFAULT_INPUT: ListInput = { nft: '', tokenId: '', quantity: '1', payment: '', fee: '', days: '7', fullTerm: false, expiry: '30d', expiryDays: '' };

const EXPIRY_LABEL: Readonly<Record<ExpiryChoice, 'request.expiryNeverOption' | 'request.expiry1d' | 'request.expiry7d' | 'request.expiry30d' | 'request.expiryOther'>> = {
  never: 'request.expiryNeverOption',
  '1d': 'request.expiry1d',
  '7d': 'request.expiry7d',
  '30d': 'request.expiry30d',
  custom: 'request.expiryOther',
};

/**
 * Which option a stored field selects. The stored value is a suggested
 * address, a pasted one, or the OTHER marker itself: choosing "another" with
 * nothing pasted yet stores the marker, so the paste box stays open instead
 * of the list snapping back to its first suggestion. Empty means untouched.
 */
function choiceOf(value: string, suggested: readonly string[]): string {
  if (value === '') return suggested[0] ?? OTHER;
  if (value === OTHER) return OTHER;
  return suggested.some((a) => a.toLowerCase() === value.toLowerCase()) ? value : OTHER;
}

/** The text a reopened paste box starts with: a pasted address, never the marker. */
function pastedOf(value: string, choice: string): string {
  return choice === OTHER && value !== OTHER ? value : '';
}

/** A suggested address or a pasted one: the select's value and the address
 *  it stands for (null while a pasted one is not an address yet). */
function chosen(value: string, pasted: string): Hex | null {
  if (value === OTHER) return parsePasted(pasted);
  return value === '' ? null : (value as Hex);
}

/** Which form: an owner's listing (NFT-01) or a renter's request (NFT-02).
 *  Both carry the same terms; the words and the test ids differ. */
export type RentFormSide = 'list' | 'request';

const SIDE_KEYS = {
  list: {
    title: 'rentList.formTitle',
    lead: 'rentList.formLead',
    quantity: 'rentList.quantityLabel',
    pay: 'rentList.payLabel',
    expiry: 'rentList.rowExpiry',
    expiryDays: 'rentList.expiryDaysLabel',
    multiHint: 'rentList.multiHint',
    continue: 'rentList.continue',
    proRata: 'rentList.ruleProRata',
    fullTerm: 'rentList.ruleFullTerm',
    whySummary: 'rentList.whySummary',
    why: 'rentList.why',
  },
  request: {
    title: 'rentRequest.formTitle',
    lead: 'rentRequest.formLead',
    quantity: 'rentRequest.quantityLabel',
    pay: 'rentRequest.payLabel',
    expiry: 'rentRequest.rowExpiry',
    expiryDays: 'rentRequest.expiryDaysLabel',
    multiHint: 'rentRequest.multiHint',
    continue: 'rentRequest.continue',
    proRata: 'rent.ruleProRata',
    fullTerm: 'rent.ruleFullTerm',
    whySummary: 'rentRequest.whySummary',
    why: 'rentRequest.why',
  },
} as const;

interface RentListFormProps {
  side?: RentFormSide;
  formKey: string;
  chain: SupportedChain;
  own: OwnStateClient;
  onReview: (draft: ListDraft) => void;
  onCancel: () => void;
}

/**
 * NFT-01 / NFT-02 — the owner's listing form, and the renter's request form
 * on the same terms: which NFT (a suggested test collection
 * on a test network, or a pasted collection address, and the token's
 * number; a quantity for a multi-token collection), the token the renter
 * pays in, the daily fee, the term, the rent rule and how long the listing
 * stays open. There are no collateral or rate fields: a rental carries
 * neither. Every figure is checked here for shape only; whether the protocol
 * takes the listing is its own answer, read in the review.
 */
export function RentListForm({ side = 'list', formKey, chain, own, onReview, onCancel }: RentListFormProps) {
  const { text, format } = useCopy();
  const keys = SIDE_KEYS[side];
  const tid = (name: string) => `rent-${side}-${name}`;
  const ids = { nft: useId(), pay: useId() };
  const [stored, setStored] = useStoredValue<ListInput>(`${formKey}:input`);
  const input = stored ?? DEFAULT_INPUT;
  const set = (patch: Partial<ListInput>) => setStored({ ...input, ...patch });
  const [touched, setTouched] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const nftSuggested = (faucetAssets(chain) ?? []).filter((a) => a.kind === 'nft' || a.kind === 'multi').map((a) => a.address);
  const paySuggested = suggestedAssets(chain).map((c) => c.address);
  const nftChoice = choiceOf(input.nft, nftSuggested);
  const [nftPasted, setNftPasted] = useState(pastedOf(input.nft, nftChoice));
  const payChoice = choiceOf(input.payment, paySuggested);
  const [payPasted, setPayPasted] = useState(pastedOf(input.payment, payChoice));

  const nft = chosen(nftChoice, nftPasted);
  const payment = chosen(payChoice, payPasted);
  const standard = useAssetStandard(nft);
  const metaRead = useTokenMeta([...(nft ? [nft] : []), ...(payment ? [payment] : []), ...nftSuggested, ...paySuggested]);
  const meta = metaRead.data ?? null;
  const maxDays = useOwnRead(['rentList.maxDays', chain.diamondAddress], (c) => readMaxDurationDays(c, chain.diamondAddress));

  const isNft = standard.data === 'erc721' || standard.data === 'erc1155';
  const multi = standard.data === 'erc1155';
  const tokenId = parseTokenId(input.tokenId);
  const quantity = multi ? parseUnits(input.quantity) : 1n;
  const decimals = payment ? (meta?.[payment.toLowerCase()]?.decimals ?? null) : null;
  const fee = decimals === null ? null : parseAmount(input.fee, decimals);
  const max = maxDays.data !== null ? Number(maxDays.data) : null;
  const days = max === null ? null : parseDays(input.days, max);
  const typedExpiry = parseDays(input.expiryDays, MAX_EXPIRY_DAYS);

  const nftError =
    nft === null
      ? text('rentList.errNft')
      : standard.error
        ? format('rentList.errStandardUnread', { reason: standard.error })
        : standard.data === 'erc20'
          ? text('rentList.errNotNft')
          : null;
  const tokenIdError = tokenId === null ? text(input.tokenId.trim() === '' ? 'request.errTokenIdEmpty' : 'request.errTokenId') : null;
  const quantityError = multi && quantity === null ? text('rentList.errQuantity') : null;
  const payError = payment === null ? text('rentList.errPayment') : decimals === null && metaRead.state !== 'reading' ? text('rentList.errPaymentUnread') : null;
  const feeError = fee === null || fee.ok ? null : text(fee.error === 'empty' ? 'rentList.errFeeEmpty' : fee.error === 'decimals' ? 'rentList.errFeeDecimals' : 'rentList.errFee');
  const daysError = days === null || days.ok ? null : format(days.error === 'high' ? 'rentList.errDaysHigh' : 'rentList.errDays', { max: String(max) });
  const expiryError = input.expiry !== 'custom' || typedExpiry.ok ? null : format('rentList.errExpiry', { max: String(MAX_EXPIRY_DAYS) });
  const show = (e: string | null) => (touched ? e : null);

  const ready =
    nftError === null &&
    isNft &&
    tokenIdError === null &&
    quantityError === null &&
    payError === null &&
    fee?.ok === true &&
    days?.ok === true &&
    expiryError === null &&
    nft !== null &&
    payment !== null &&
    tokenId !== null &&
    quantity !== null;
  // A click that cannot go on always says why: a field's own error, the
  // term limit's failed read (stated with a retry below the term), or, when
  // neither stands, that a read the listing needs has not answered yet.
  const fieldErrors = [nftError, tokenIdError, quantityError, payError, feeError, daysError, expiryError];
  const stillReading = touched && !ready && maxDays.state !== 'failed' && fieldErrors.every((e) => e === null);

  const submit = async () => {
    setTouched(true);
    if (!ready || nft === null || payment === null || tokenId === null || quantity === null || !fee?.ok || !days?.ok) return;
    setOpening(null);
    try {
      const block = await own.read((c) => c.getBlock({ blockTag: 'latest' }));
      onReview({
        nft,
        standard: multi ? 'erc1155' : 'erc721',
        tokenId,
        quantity,
        payment,
        dailyFee: fee.value,
        days: BigInt(days.value),
        fullTerm: input.fullTerm,
        expiresAt: expiresAt(input.expiry, block.value.timestamp, typedExpiry.ok ? typedExpiry.value : 0),
      });
    } catch (e) {
      setOpening(refusalFromError(e).reason);
    }
  };

  return (
    <form
      className={`card rent-${side}-form`}
      data-testid={tid('form')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h3>{text(keys.title)}</h3>
      <p className="tier-b">{text(keys.lead)}</p>

      <div className="field">
        <label htmlFor={ids.nft}>{text('rentList.nftLabel')}</label>
        <select
          id={ids.nft}
          value={nftChoice}
          onChange={(e) => {
            const v = e.target.value;
            set({ nft: v === OTHER ? nftPasted || OTHER : v });
            if (v !== OTHER) setNftPasted('');
          }}
          data-testid={tid('nft')}
        >
          {nftSuggested.map((a) => (
            <option key={a} value={a}>
              {format('rentList.testCollection', { name: assetName(a, meta) })}
            </option>
          ))}
          <option value={OTHER}>{text('rentList.otherCollection')}</option>
        </select>
      </div>
      {nftChoice === OTHER && (
        <FormField label={text('rentList.nftAddressLabel')} error={show(nftError)}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              value={nftPasted}
              onChange={(e) => {
                setNftPasted(e.target.value);
                set({ nft: e.target.value || OTHER });
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              data-testid={tid('nft-address')}
            />
          )}
        </FormField>
      )}
      {nftChoice !== OTHER && show(nftError) && <p className="tier-a field-error">{nftError}</p>}
      {standard.data === 'erc1155' && <p className="tier-b field-hint">{text(keys.multiHint)}</p>}

      <FormField label={text('rentList.tokenIdLabel')} error={show(tokenIdError)}>
        {({ id, describedBy, invalid }) => (
          <input id={id} inputMode="numeric" value={input.tokenId} onChange={(e) => set({ tokenId: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid={tid('token-id')} />
        )}
      </FormField>
      {multi && (
        <FormField label={text(keys.quantity)} error={show(quantityError)}>
          {({ id, describedBy, invalid }) => (
            <input id={id} inputMode="numeric" value={input.quantity} onChange={(e) => set({ quantity: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid={tid('quantity')} />
          )}
        </FormField>
      )}

      <div className="field">
        <label htmlFor={ids.pay}>{text(keys.pay)}</label>
        <select
          id={ids.pay}
          value={payChoice}
          onChange={(e) => {
            const v = e.target.value;
            set({ payment: v === OTHER ? payPasted || OTHER : v });
            if (v !== OTHER) setPayPasted('');
          }}
          data-testid={tid('pay')}
        >
          {paySuggested.map((a) => (
            <option key={a} value={a}>
              {assetName(a, meta)}
            </option>
          ))}
          <option value={OTHER}>{text('rentList.otherToken')}</option>
        </select>
      </div>
      {payChoice === OTHER && (
        <FormField label={text('rentList.payAddressLabel')} error={show(payError)}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              value={payPasted}
              onChange={(e) => {
                setPayPasted(e.target.value);
                set({ payment: e.target.value || OTHER });
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              data-testid={tid('pay-address')}
            />
          )}
        </FormField>
      )}
      {payChoice !== OTHER && show(payError) && <p className="tier-a field-error">{payError}</p>}

      <FormField label={format('rentList.feeLabel', { token: payment ? assetName(payment, meta) : '' })} hint={text('rentList.feeHint')} error={show(feeError)}>
        {({ id, describedBy, invalid }) => (
          <input id={id} inputMode="decimal" value={input.fee} onChange={(e) => set({ fee: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid={tid('fee')} />
        )}
      </FormField>
      <FormField label={text('rentList.daysLabel')} hint={max === null ? undefined : format('request.durationHint', { max: String(max) })} error={show(daysError)}>
        {({ id, describedBy, invalid }) => (
          <input id={id} inputMode="numeric" value={input.days} onChange={(e) => set({ days: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid={tid('days')} />
        )}
      </FormField>
      {maxDays.state === 'failed' && (
        <Notice tone="warn" tier="A">
          <span data-testid={tid('days-unread')}>{format('rentList.errDaysUnread', { reason: maxDays.error ?? 'no answer' })}</span>{' '}
          <button type="button" className="btn" onClick={maxDays.refetch} data-testid={tid('days-retry')}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}

      <fieldset className="field">
        <legend>{text('rent.rowRule')}</legend>
        <label>
          <input type="radio" name={`${formKey}-rule`} checked={!input.fullTerm} onChange={() => set({ fullTerm: false })} data-testid={tid('prorata')} /> {text(keys.proRata)}
        </label>
        <label>
          <input type="radio" name={`${formKey}-rule`} checked={input.fullTerm} onChange={() => set({ fullTerm: true })} data-testid={tid('fullterm')} /> {text(keys.fullTerm)}
        </label>
      </fieldset>

      <FormField label={text(keys.expiry)}>
        {({ id }) => (
          <select id={id} value={input.expiry} onChange={(e) => set({ expiry: e.target.value as ExpiryChoice })} data-testid={tid('expiry')}>
            {EXPIRY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {text(EXPIRY_LABEL[c])}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {input.expiry === 'custom' && (
        <FormField label={text(keys.expiryDays)} error={show(expiryError)}>
          {({ id, describedBy, invalid }) => (
            <input id={id} inputMode="numeric" value={input.expiryDays} onChange={(e) => set({ expiryDays: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid={tid('expiry-days')} />
          )}
        </FormField>
      )}

      {stillReading && (
        <Notice tone="info" tier="A">
          <span data-testid={tid('still-reading')}>{text('rentList.stillReading')}</span>
        </Notice>
      )}
      {opening !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: opening })}
        </Notice>
      )}
      <WhyLink summaryKey={keys.whySummary} detailKey={keys.why} />
      <p className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid={tid('continue')}>
          {text(keys.continue)}
        </button>{' '}
        <button type="button" className="btn btn-link" onClick={onCancel} data-testid={tid('cancel')}>
          {text('rentList.cancel')}
        </button>
      </p>
    </form>
  );
}
