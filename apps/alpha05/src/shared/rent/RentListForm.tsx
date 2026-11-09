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

/** A suggested address or a pasted one: the select's value and the address
 *  it stands for (null while a pasted one is not an address yet). */
function chosen(value: string, pasted: string): Hex | null {
  if (value === OTHER) return parsePasted(pasted);
  return value === '' ? null : (value as Hex);
}

interface RentListFormProps {
  formKey: string;
  chain: SupportedChain;
  own: OwnStateClient;
  onReview: (draft: ListDraft) => void;
  onCancel: () => void;
}

/**
 * NFT-01 — the owner's listing form: which NFT (a suggested test collection
 * on a test network, or a pasted collection address, and the token's
 * number; a quantity for a multi-token collection), the token the renter
 * pays in, the daily fee, the term, the rent rule and how long the listing
 * stays open. There are no collateral or rate fields: a rental carries
 * neither. Every figure is checked here for shape only; whether the protocol
 * takes the listing is its own answer, read in the review.
 */
export function RentListForm({ formKey, chain, own, onReview, onCancel }: RentListFormProps) {
  const { text, format } = useCopy();
  const ids = { nft: useId(), pay: useId() };
  const [stored, setStored] = useStoredValue<ListInput>(`${formKey}:input`);
  const input = stored ?? DEFAULT_INPUT;
  const set = (patch: Partial<ListInput>) => setStored({ ...input, ...patch });
  const [touched, setTouched] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const nftSuggested = (faucetAssets(chain) ?? []).filter((a) => a.kind === 'nft' || a.kind === 'multi').map((a) => a.address);
  const paySuggested = suggestedAssets(chain).map((c) => c.address);
  const nftChoice = input.nft === '' ? (nftSuggested[0] ?? OTHER) : nftSuggested.some((a) => a.toLowerCase() === input.nft.toLowerCase()) ? input.nft : OTHER;
  const [nftPasted, setNftPasted] = useState(nftChoice === OTHER ? input.nft : '');
  const payChoice = input.payment === '' ? (paySuggested[0] ?? OTHER) : paySuggested.some((a) => a.toLowerCase() === input.payment.toLowerCase()) ? input.payment : OTHER;
  const [payPasted, setPayPasted] = useState(payChoice === OTHER ? input.payment : '');

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
      className="card rent-list-form"
      data-testid="rent-list-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h3>{text('rentList.formTitle')}</h3>
      <p className="tier-b">{text('rentList.formLead')}</p>

      <div className="field">
        <label htmlFor={ids.nft}>{text('rentList.nftLabel')}</label>
        <select
          id={ids.nft}
          value={nftChoice}
          onChange={(e) => {
            const v = e.target.value;
            set({ nft: v === OTHER ? nftPasted : v });
            if (v !== OTHER) setNftPasted('');
          }}
          data-testid="rent-list-nft"
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
                set({ nft: e.target.value });
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              data-testid="rent-list-nft-address"
            />
          )}
        </FormField>
      )}
      {nftChoice !== OTHER && show(nftError) && <p className="tier-a field-error">{nftError}</p>}
      {standard.data === 'erc1155' && <p className="tier-b field-hint">{text('rentList.multiHint')}</p>}

      <FormField label={text('rentList.tokenIdLabel')} error={show(tokenIdError)}>
        {({ id, describedBy, invalid }) => (
          <input id={id} inputMode="numeric" value={input.tokenId} onChange={(e) => set({ tokenId: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid="rent-list-token-id" />
        )}
      </FormField>
      {multi && (
        <FormField label={text('rentList.quantityLabel')} error={show(quantityError)}>
          {({ id, describedBy, invalid }) => (
            <input id={id} inputMode="numeric" value={input.quantity} onChange={(e) => set({ quantity: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid="rent-list-quantity" />
          )}
        </FormField>
      )}

      <div className="field">
        <label htmlFor={ids.pay}>{text('rentList.payLabel')}</label>
        <select
          id={ids.pay}
          value={payChoice}
          onChange={(e) => {
            const v = e.target.value;
            set({ payment: v === OTHER ? payPasted : v });
            if (v !== OTHER) setPayPasted('');
          }}
          data-testid="rent-list-pay"
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
                set({ payment: e.target.value });
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              data-testid="rent-list-pay-address"
            />
          )}
        </FormField>
      )}
      {payChoice !== OTHER && show(payError) && <p className="tier-a field-error">{payError}</p>}

      <FormField label={format('rentList.feeLabel', { token: payment ? assetName(payment, meta) : '' })} hint={text('rentList.feeHint')} error={show(feeError)}>
        {({ id, describedBy, invalid }) => (
          <input id={id} inputMode="decimal" value={input.fee} onChange={(e) => set({ fee: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid="rent-list-fee" />
        )}
      </FormField>
      <FormField label={text('rentList.daysLabel')} hint={max === null ? undefined : format('request.durationHint', { max: String(max) })} error={show(daysError)}>
        {({ id, describedBy, invalid }) => (
          <input id={id} inputMode="numeric" value={input.days} onChange={(e) => set({ days: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid="rent-list-days" />
        )}
      </FormField>

      <fieldset className="field">
        <legend>{text('rent.rowRule')}</legend>
        <label>
          <input type="radio" name={`${formKey}-rule`} checked={!input.fullTerm} onChange={() => set({ fullTerm: false })} data-testid="rent-list-prorata" /> {text('rentList.ruleProRata')}
        </label>
        <label>
          <input type="radio" name={`${formKey}-rule`} checked={input.fullTerm} onChange={() => set({ fullTerm: true })} data-testid="rent-list-fullterm" /> {text('rentList.ruleFullTerm')}
        </label>
      </fieldset>

      <FormField label={text('rentList.rowExpiry')}>
        {({ id }) => (
          <select id={id} value={input.expiry} onChange={(e) => set({ expiry: e.target.value as ExpiryChoice })} data-testid="rent-list-expiry">
            {EXPIRY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {text(EXPIRY_LABEL[c])}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {input.expiry === 'custom' && (
        <FormField label={text('rentList.expiryDaysLabel')} error={show(expiryError)}>
          {({ id, describedBy, invalid }) => (
            <input id={id} inputMode="numeric" value={input.expiryDays} onChange={(e) => set({ expiryDays: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} data-testid="rent-list-expiry-days" />
          )}
        </FormField>
      )}

      {opening !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: opening })}
        </Notice>
      )}
      <WhyLink summaryKey="rentList.whySummary" detailKey="rentList.why" />
      <p className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid="rent-list-continue">
          {text('rentList.continue')}
        </button>{' '}
        <button type="button" className="btn btn-link" onClick={onCancel} data-testid="rent-list-cancel">
          {text('rentList.cancel')}
        </button>
      </p>
    </form>
  );
}
