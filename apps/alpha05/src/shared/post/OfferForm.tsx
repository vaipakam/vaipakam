import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { refusalFromError } from '../eligibility/refusal';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useStoredValue } from '../tx/txStore';
import { useMounted } from '../tx/useReviewRefresh';
import { FormField } from '../ui/FormField';
import { formatFigureText } from '../ui/format';
import { useMode } from '../../app/ModeContext';
import { Notice } from '../ui/Notice';
import {
  advancedSet,
  bucketsWithin,
  DEFAULT_DURATION_DAYS,
  DEFAULT_INPUT,
  EXPIRY_CHOICES,
  expiresAt,
  FILL_MODES,
  fillModeBlock,
  partError,
  rangeError,
  ASSET_ERC1155,
  ASSET_ERC20,
  ASSET_ERC721,
  MAX_EXPIRY_DAYS,
  parseAmount,
  parseDays,
  parseRateBps,
  postFigures,
  type ExpiryChoice,
  type FillMode,
  type ParseError,
  type PostAssets,
  type PostInput,
  type PostSide,
} from './postModel';
import { POST_KEYS } from './postCopy';
import { holds, parseQuantity, parseTokenId, readErc1155, readErc721 } from '../nft/nft';
import { readPostFormInputs, type PostDraft } from './postReview';
import { CADENCES, cadenceOpen, cadenceRefusalText, isCadence, readCadenceAdmission, type Cadence } from '../offers/cadence';
import { readNumeraireSymbol } from '../reads/numeraire';
import { belowFloor, capStanding, readMinOfferAmount, readOpenOffers } from '../offers/offerBook';
import { readTariffQuote, readTariffSwitch, suggestedCeiling, VPFI_DECIMALS } from '../offers/fullTariff';

/** The store keys each page's posting flow is kept under (the typed form,
 *  the draft, the review and its tracker), so a navigation away and back, or
 *  a review closed to change a figure, keeps what was typed; and a borrower's
 *  request and a lender's offer never share one. */
export const REQUEST_KEY = 'borrow.request';
export const LEND_OFFER_KEY = 'lend.offer';

const FILL_LABEL: Readonly<Record<FillMode, CopyKey>> = {
  partial: 'request.fillPartial',
  aon: 'request.fillAon',
  ioc: 'request.fillIoc',
};

const CADENCE_LABEL: Readonly<Record<Cadence, CopyKey>> = {
  0: 'request.cadenceNone',
  1: 'request.cadenceMonthly',
  2: 'request.cadenceQuarterly',
  3: 'request.cadenceSemiAnnual',
  4: 'request.cadenceAnnual',
};

const ADVANCED_NAME = {
  range: 'request.advancedRange',
  fill: 'request.advancedFill',
  cadence: 'request.advancedCadence',
  tariff: 'request.advancedTariff',
} as const satisfies Record<string, CopyKey>;

const EXPIRY_LABEL: Readonly<Record<ExpiryChoice, CopyKey>> = {
  never: 'request.expiryNeverOption',
  '1d': 'request.expiry1d',
  '7d': 'request.expiry7d',
  '30d': 'request.expiry30d',
  custom: 'request.expiryOther',
};

interface OfferFormProps {
  /** Who posts: a borrower's request, or a lender's offer (OFF-06). */
  side: PostSide;
  /** The store key the typed form is kept under (REQUEST_KEY, LEND_OFFER_KEY). */
  flowKey: string;
  chain: SupportedChain;
  own: OwnStateClient;
  /** The two assets, and the standard the collateral claims; a lender's
   *  offer is posted on an ERC-20 pair only (its NFT collateral is later). */
  pair: PostAssets;
  meta: TokenMetaMap | null;
  /** The confirmed request, with its expiry fixed now; the page opens the
   *  review on it. */
  onReview: (draft: PostDraft) => void;
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
 * OFF-10 / OFF-11 / OFF-14 (Advanced): an amount range with an optional
 * floor collateral, the fill mode, and the interest schedule, which offers
 * only the schedules the protocol admits for the terms typed, each closed
 * one with the protocol's reason. Set in Advanced, they still apply in Basic,
 * which says so and offers to clear them (RB-MODE never drops a choice).
 * OFF-06: a lender types the same shape from the other side: the exact
 * amount they lend (which posting locks in their vault, so the form shows
 * their balance of it), the one collateral every borrower must lock, the
 * rate, the term, the expiry and the interest mode. OFF-10 / OFF-11 for a
 * lender (Advanced): parts, the smallest of which one match may lend (the
 * amount typed stays the whole amount locked, which a direct take borrows),
 * and the fill mode. OFF-14 / OFF-22 for a lender (Advanced): the interest
 * schedule, admitted at the smallest amount one loan may lend (the smallest
 * part, or the whole amount without parts), as creation admits it; and the
 * Full fee tariff, quoted at the whole amount, the largest loan the offer
 * opens (a direct take).
 */
export function OfferForm({ side, flowKey, chain, own, pair, meta, onReview, onCancel }: OfferFormProps) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const k = POST_KEYS[side];
  const lender = side === 'lender';
  const [stored, setStored] = useStoredValue<PostInput>(`${flowKey}:input`);
  // A request kept from before a field existed reads that field's default.
  const input: PostInput = { ...DEFAULT_INPUT, ...stored };
  const set = (patch: Partial<PostInput>) => setStored({ ...input, ...patch });
  /** Errors show once a field has been left, or after a review was asked. */
  const [touched, setTouched] = useState<Record<'amount' | 'amountMax' | 'part' | 'floor' | 'collateral' | 'tokenId' | 'rate' | 'term' | 'expiry' | 'ceiling', boolean>>({
    ceiling: false,
    part: false,
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
  const nft = !lender && pair.standard === 'erc721';
  /** An ERC-1155 collateral: a quantity of one token, named by its id. */
  const multi = !lender && pair.standard === 'erc1155';
  const named = nft || multi;
  /** The ERC-20 posting locks: the lending asset for an offer, the
   *  collateral for a request (none for a token, checked by its id). */
  const stakeAsset = lender ? pair.lending : named ? null : pair.collateral;
  const inputs = useOwnRead([flowKey, 'inputs', String(stakeAsset).toLowerCase()], (c) => readPostFormInputs(c, diamond, own.account, stakeAsset));
  const tokenId = named ? parseTokenId(input.tokenId) : null;
  // Who holds the typed token, read live so the reader learns before the
  // review whether it is theirs; the review reads it again at one block.
  const token = useOwnRead([flowKey, 'token', pair.collateral.toLowerCase(), String(tokenId)], (c) => readErc721(c, pair.collateral, tokenId ?? 0n, own.account, diamond), {
    enabled: nft && tokenId !== null,
    perBlock: true,
  });
  // How many of the typed ERC-1155 token the wallet holds, read live too.
  const units = useOwnRead([flowKey, 'units', pair.collateral.toLowerCase(), String(tokenId)], (c) => readErc1155(c, pair.collateral, tokenId ?? 0n, own.account, diamond), {
    enabled: multi && tokenId !== null,
    perBlock: true,
  });

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
  // does not carry over to a token. A request's range is its smallest and
  // largest amount, with an optional floor collateral; a lending offer's is
  // the smallest part one match may lend, the amount typed staying the
  // whole amount locked.
  const ranged = input.ranged && !named;
  const fillMode: FillMode = input.fillMode;
  /** The Full tariff, chosen on either side. */
  const tariffChosen = input.tariff;
  const amountMax = ranged && !lender && lendingDecimals !== null ? parseAmount(input.amountMax, lendingDecimals) : null;
  const minPart = ranged && lender && lendingDecimals !== null ? parseAmount(input.minPart, lendingDecimals) : null;
  const floorTyped = ranged && !lender && input.collateralFloor.trim() !== '';
  const floor = floorTyped && collateralDecimals !== null ? parseAmount(input.collateralFloor, collateralDecimals) : null;
  const shapeError =
    ranged && !lender && amount?.ok && amountMax?.ok && collateral?.ok
      ? rangeError(amount.value, amountMax.value, collateral.value, floor?.ok ? floor.value : collateral.value)
      : null;
  const partShape = lender && amount?.ok && minPart?.ok ? partError(minPart.value, amount.value) : null;
  const fillBlock = fillModeBlock(fillMode, ranged, input.expiry);
  const effective = advancedSet({ ...input, ranged });
  /** Names joined as the catalog joins two: "a, b and c". */
  const listOf = (names: string[]): string =>
    names.length <= 1 ? (names[0] ?? '') : format('request.advancedList', { a: names.slice(0, -1).join(', '), b: names[names.length - 1]! });

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
            ? text(k.errRateHigh)
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
  // OFF-14: the schedules the protocol admits for these terms, asked of the
  // protocol's own rule (valued at the smallest amount, as creation values
  // it). Read whenever a schedule can be chosen or one is already set; while
  // it is unknown only interest at repayment is offered.
  // A lender's offer is created with its smallest part as the amount, so
  // that is what creation admits; without parts it is the whole amount.
  const cadence: Cadence = isCadence(input.cadence) ? input.cadence : 0;
  const admissionAmount = lender && ranged ? (minPart?.ok && partShape === null ? minPart.value : null) : amount?.ok ? amount.value : null;
  const admissionTerms = admissionAmount !== null && durationDays !== null ? { amount: admissionAmount, durationDays } : null;
  // #3242 — the offer book's value floor applies to that same amount (a
  // lending offer's smallest part, a request's smallest amount), and the
  // per-wallet cap to the post itself. Both are the protocol's own answers;
  // a failed read says nothing and leaves the refusal to the protocol.
  const bookFloor = useOwnRead([flowKey, 'offerFloor', pair.lending.toLowerCase()], (c) => readMinOfferAmount(c, diamond, pair.lending));
  const floorAmount = bookFloor.error === null ? bookFloor.data : null;
  const floorShort = belowFloor(admissionAmount, floorAmount);
  const floorText =
    floorShort && floorAmount !== null && lendingDecimals !== null
      ? format('request.errBelowFloor', { min: formatUnits(floorAmount, lendingDecimals), symbol: lendingSymbol })
      : null;
  const openOffers = useOwnRead([flowKey, 'openOffers'], (c) => readOpenOffers(c, diamond, own.account));
  const capNow = capStanding(openOffers.error === null ? openOffers.data : null);
  const admission = useOwnRead(
    [flowKey, 'cadence', pair.lending.toLowerCase(), pair.collateral.toLowerCase(), pair.standard, String(admissionTerms?.amount), String(admissionTerms?.durationDays)],
    (c) =>
      readCadenceAdmission(c, diamond, {
        lendingAsset: pair.lending,
        amount: admissionTerms!.amount,
        assetType: ASSET_ERC20,
        collateralAsset: pair.collateral,
        collateralAssetType: pair.standard === 'erc721' ? ASSET_ERC721 : pair.standard === 'erc1155' ? ASSET_ERC1155 : ASSET_ERC20,
        durationDays: admissionTerms!.durationDays,
      }),
    { enabled: admissionTerms !== null && (isAdvanced || cadence !== 0) },
  );
  const numeraire = useOwnRead(['numeraireSymbol', diamond], (c) => readNumeraireSymbol(c, diamond), { enabled: isAdvanced || cadence !== 0 });
  const unit = numeraire.data ?? text('home.exposureUnit');
  // The admission is used only while it answers for the terms on screen.
  const admitted = admissionTerms !== null && admission.error === null ? admission.data : null;
  const cadenceVerdict = admitted?.verdicts.find((v) => v.cadence === cadence) ?? null;
  /** Why the chosen schedule cannot go to review: closed with the
   *  protocol's reason, or not yet known for these terms. */
  const cadenceBlock =
    cadence === 0
      ? null
      : admitted === null
        ? admissionTerms !== null && admission.error !== null
          ? format('request.cadenceUnread', { reason: admission.error })
          : text('request.cadenceClosedUnknown')
        : cadenceOpen(admitted, cadence)
          ? null
          : format('request.cadenceClosed', { reason: cadenceVerdict?.refusal ? cadenceRefusalText(cadenceVerdict.refusal, unit, { text, format }) : '' });
  // OFF-22: the Full VPFI fee tariff. Offered only while the protocol's
  // switch is on, and said either way (RB-SWITCH class 1a). The tariff is
  // the protocol's quote for the largest loan the request can open; a blank
  // ceiling takes that figure, which no loan of this request exceeds at
  // today's figures. The opt-in is armed by its own transaction after
  // posting, so it never enters the create call.
  const tariffShown = isAdvanced || input.tariff;
  const tariffSwitch = useOwnRead(['feeEntitlementSwitch', diamond], (c) => readTariffSwitch(c, diamond), { enabled: tariffShown });
  const tariffPrincipal = ranged && amountMax?.ok ? amountMax.value : amount?.ok ? amount.value : null;
  const tariffQuote = useOwnRead(
    [flowKey, 'tariff', pair.lending.toLowerCase(), String(tariffPrincipal), String(durationDays)],
    (c) => readTariffQuote(c, diamond, pair.lending, tariffPrincipal!, durationDays!),
    { enabled: tariffShown && tariffSwitch.data === true && tariffPrincipal !== null && durationDays !== null },
  );
  const quoteNow = tariffPrincipal !== null && durationDays !== null && tariffQuote.error === null ? tariffQuote.data : null;
  const suggested = suggestedCeiling(quoteNow);
  const ceilingTyped = input.tariffCeiling.trim() !== '';
  const ceiling = ceilingTyped ? parseAmount(input.tariffCeiling, VPFI_DECIMALS) : null;
  const ceilingValue = ceiling?.ok ? ceiling.value : ceilingTyped ? null : suggested;
  const vpfi = (v: bigint) => format('request.tariffVpfi', { amount: formatFigureText(v, VPFI_DECIMALS) });
  /** Why the chosen tariff cannot go to review: switched off now, or no
   *  ceiling to authorize (none typed, and no quote to take it from). */
  const tariffBlock = !tariffChosen
    ? null
    : tariffSwitch.data === false
      ? text('request.tariffOffBlock')
      : ceiling !== null && !ceiling.ok
        ? parseText(ceiling.error, 'VPFI', VPFI_DECIMALS)
        : ceilingValue === null
          ? text('request.tariffCeilingNeeded')
          : null;
  const typedExpiry = parseDays(input.expiryDays, MAX_EXPIRY_DAYS);
  const expiryOk = input.expiry !== 'custom' || typedExpiry.ok;
  const expiryError =
    input.expiry !== 'custom' || typedExpiry.ok
      ? null
      : typedExpiry.error === 'high'
        ? format(k.errExpiryHigh, { max: String(MAX_EXPIRY_DAYS) })
        : typedExpiry.error === 'empty'
          ? text('request.errDaysEmpty')
          : text('request.errDays');

  const figures = inputs.data && amount?.ok && rate.ok && durationDays !== null ? postFigures(amount.value, rate.value, durationDays, inputs.data.lifBps) : null;
  /** The largest amount, for the live summary of a range. */
  const largest = ranged && !lender && amountMax?.ok ? amountMax.value : null;
  const collateralOk = nft ? tokenId !== null : multi ? tokenId !== null && quantity !== null : collateral?.ok === true;
  const rangeOk = !ranged || (lender ? minPart?.ok === true && partShape === null : amountMax?.ok === true && (!floorTyped || floor?.ok === true) && shapeError === null);
  const valid =
    amount?.ok === true &&
    collateralOk &&
    rate.ok &&
    durationDays !== null &&
    expiryOk &&
    rangeOk &&
    fillBlock === null &&
    cadenceBlock === null &&
    tariffBlock === null &&
    !floorShort &&
    capNow !== 'full' &&
    inputs.data !== null;

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
    // A lending offer's typed amount is its whole amount (what posting locks
    // and a direct take borrows); its smallest part is the protocol's minimum.
    const max = lender ? amount.value : ranged && amountMax?.ok ? amountMax.value : amount.value;
    const min = lender && ranged && minPart?.ok ? minPart.value : amount.value;
    const floorValue = !lender && ranged && floor?.ok ? floor.value : locked;
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
        side,
        parsed: {
          amount: min,
          amountMax: max,
          collateral: locked,
          collateralFloor: floorValue,
          fillMode,
          cadence,
          tariff: tariffChosen && ceilingValue !== null ? { maxCStar: ceilingValue, allowDowngrade: input.tariffDowngrade } : null,
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

  /** OFF-11: how matches may fill the request or offer; the same choice on
   *  both sides, worded for each. */
  const fillFieldset = (
    <fieldset className="choice-group" data-testid="request-fill">
      <legend>{text('request.fillLabel')}</legend>
      {FILL_MODES.map((m) => {
        const blocked = fillModeBlock(m, ranged, input.expiry);
        return (
          <label key={m} className="choice">
            <input
              type="radio"
              name="request-fill"
              value={m}
              checked={input.fillMode === m}
              disabled={blocked !== null && input.fillMode !== m}
              onChange={() => set({ fillMode: m })}
            />
            <span>{text(m === 'aon' ? k.fillAon : FILL_LABEL[m])}</span>
          </label>
        );
      })}
      {fillBlock !== null && (
        <Notice tone="warn" tier="A">
          {text(fillBlock === 'aon-range' ? 'request.fillAonRange' : k.fillIocOpen)}
        </Notice>
      )}
      <WhyLink summaryKey={k.fillSummary} detailKey={k.fillWhy} />
    </fieldset>
  );
  /** The range switch: the same box on both sides; turning it on drops an
   *  all-or-none choice, which takes one amount. */
  /** OFF-14: the interest schedule, for either side; only the schedules
   *  the protocol admits for the terms typed can be chosen. */
  const cadenceFieldset = (
    <fieldset className="choice-group" data-testid="request-cadence">
      <legend>{text('request.cadenceLabel')}</legend>
      {CADENCES.map((c) => {
        const verdict = admitted?.verdicts.find((v) => v.cadence === c) ?? null;
        const open = cadenceOpen(admitted, c);
        return (
          <label key={c} className="choice">
            <input type="radio" name="request-cadence" value={c} checked={cadence === c} disabled={!open && cadence !== c} onChange={() => set({ cadence: c })} />
            <span>
              {text(CADENCE_LABEL[c])}
              {verdict?.refusal && <small className="choice-note">{cadenceRefusalText(verdict.refusal, unit, { text, format })}</small>}
            </span>
          </label>
        );
      })}
      {admissionTerms === null ? (
        <p className="tier-b field-hint">{text('request.cadenceNeedsTerms')}</p>
      ) : admission.error !== null && cadence === 0 ? (
        <Notice tone="warn" tier="A">
          {format('request.cadenceUnread', { reason: admission.error })}
        </Notice>
      ) : admitted === null ? (
        <p className="tier-b field-hint" aria-live="polite">
          {text('request.cadenceReading')}
        </p>
      ) : null}
      {cadenceBlock !== null && (
        <Notice tone="warn" tier="A">
          <span data-testid="request-cadence-block">{cadenceBlock}</span>
        </Notice>
      )}
      <WhyLink summaryKey="request.cadenceSummary" detailKey={k.cadenceWhy} />
    </fieldset>
  );
  /** OFF-22: the Full fee tariff, for either side, said either way while
   *  the switch is off or unread (RB-SWITCH class 1a). */
  const tariffFieldset = (
    <fieldset className="choice-group" data-testid="request-tariff">
      <legend>{text('request.tariffLabel')}</legend>
      {tariffSwitch.error !== null ? (
        <Notice tone="warn" tier="A">
          {format('request.tariffSwitchUnread', { reason: tariffSwitch.error })}
        </Notice>
      ) : tariffSwitch.data === false ? (
        <p className="tier-b field-hint" data-testid="request-tariff-off">
          {text('request.tariffOff')}
        </p>
      ) : tariffSwitch.data === null ? (
        <p className="tier-b field-hint" aria-live="polite">
          {text('request.tariffReading')}
        </p>
      ) : null}
      <label className="choice">
        <input
          type="checkbox"
          checked={input.tariff}
          disabled={tariffSwitch.data !== true && !input.tariff}
          onChange={(e) => set({ tariff: e.target.checked })}
          data-testid="request-tariff-opt"
        />
        <span>{text(k.tariffOption)}</span>
      </label>
      {input.tariff && (
        <div className="tariff-detail">
          <p className="tier-b field-hint" data-testid="request-tariff-quote" aria-live="polite">
            {tariffPrincipal === null || durationDays === null
              ? text('request.tariffNeedsTerms')
              : tariffQuote.error !== null
                ? format('request.tariffQuoteUnread', { reason: tariffQuote.error })
                : quoteNow === null
                  ? text('request.tariffReading')
                  : !quoteNow.numeraireOk
                    ? text(k.tariffUnpriced)
                    : format('request.tariffQuote', { tariff: vpfi(quoteNow.cStar), amount: tokenAmount(tariffPrincipal, pair.lending, meta, format) })}
          </p>
          <FormField
            label={text('request.tariffCeilingLabel')}
            hint={suggested !== null ? format('request.tariffCeilingHint', { tariff: vpfi(suggested) }) : text('request.tariffCeilingHintNone')}
            error={show('ceiling') && ceiling !== null && !ceiling.ok ? parseText(ceiling.error, 'VPFI', VPFI_DECIMALS) : null}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={suggested !== null ? formatUnits(suggested, VPFI_DECIMALS) : undefined}
                value={input.tariffCeiling}
                onChange={(e) => set({ tariffCeiling: e.target.value })}
                onBlur={() => leave('ceiling')}
                data-testid="request-tariff-ceiling"
              />
            )}
          </FormField>
          <fieldset className="choice-group" data-testid="request-tariff-fail">
            <legend>{text('request.tariffFailLabel')}</legend>
            <label className="choice">
              <input type="radio" name="request-tariff-fail" checked={!input.tariffDowngrade} onChange={() => set({ tariffDowngrade: false })} />
              <span>{text('request.tariffFailRefuse')}</span>
            </label>
            <label className="choice">
              <input type="radio" name="request-tariff-fail" checked={input.tariffDowngrade} onChange={() => set({ tariffDowngrade: true })} />
              <span>{text('request.tariffFailOpen')}</span>
            </label>
          </fieldset>
        </div>
      )}
      {tariffBlock !== null && (
        <Notice tone="warn" tier="A">
          <span data-testid="request-tariff-block">{tariffBlock}</span>
        </Notice>
      )}
      <WhyLink summaryKey={k.tariffSummary} detailKey={k.tariffWhy} />
    </fieldset>
  );
  const rangeToggle = (
    <label className="choice">
      <input
        type="checkbox"
        checked={ranged}
        disabled={named}
        onChange={(e) => set({ ranged: e.target.checked, ...(e.target.checked && input.fillMode === 'aon' ? { fillMode: 'partial' as const } : {}) })}
        data-testid="request-range"
      />
      <span>{text(k.rangeOption)}</span>
    </label>
  );

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
      <h2 id={lender ? 'lend-offer-form' : 'borrow-request-form'}>{text(k.formTitle)}</h2>
      <WhyLink summaryKey={k.openSummary} detailKey={k.openWhy} />
      {metaMissing && (
        <Notice tone="warn" tier="A">
          {text('request.metaUnread')}
        </Notice>
      )}
      {capNow !== 'room' && openOffers.data !== null && (
        <Notice tone="warn" tier="A">
          <span data-testid="request-offer-cap">
            {format(capNow === 'full' ? 'request.offerCapFull' : 'request.offerCapNear', { open: String(openOffers.data.open), cap: String(openOffers.data.cap) })}
          </span>
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
          label={format(ranged && !lender ? 'request.amountMinLabel' : k.amountLabel, { symbol: lendingSymbol })}
          hint={
            lender
              ? inputs.data && inputs.data.balance !== null
                ? format('lendOffer.amountHint', { have: tokenAmount(inputs.data.balance, pair.lending, meta, format) })
                : text('lendOffer.amountHintPlain')
              : text(ranged ? 'request.amountMinHint' : 'request.amountHint')
          }
          error={show('amount') ? (amountError(amount, lendingSymbol, lendingDecimals) ?? (lender && ranged ? null : floorText)) : null}
        >
          {({ id, describedBy, invalid }) => (
            <div className="input-with-action">
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
              {lender && inputs.data && inputs.data.balance !== null && lendingDecimals !== null && inputs.data.balance > 0n && (
                // RB-CLICKS: Max lends the whole wallet balance, exactly.
                <button type="button" className="btn" onClick={() => set({ amount: formatUnits(inputs.data!.balance!, lendingDecimals) })} data-testid="request-amount-all">
                  {text('request.max')}
                </button>
              )}
            </div>
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
            label={format(k.collateralLabel, { symbol: collateralSymbol })}
            hint={
              lender
                ? text(ranged ? 'lendOffer.collateralHintRange' : 'lendOffer.collateralHint')
                : inputs.data && inputs.data.balance !== null
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
                {!lender && inputs.data && inputs.data.balance !== null && collateralDecimals !== null && inputs.data.balance > 0n && (
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
            {text(k.durationNone)}
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

      <FormField label={text(k.expiryLabel)}>
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
        <FormField label={text(k.expiryDaysLabel)} hint={format('request.expiryDaysHint', { max: String(MAX_EXPIRY_DAYS) })} error={show('expiry') ? expiryError : null}>
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
        <legend>{text(k.interestLabel)}</legend>
        <label className="choice">
          <input type="radio" name="request-interest" checked={input.fullTerm} onChange={() => set({ fullTerm: true })} />
          <span>{text(k.fullTermOption)}</span>
        </label>
        <label className="choice">
          <input type="radio" name="request-interest" checked={!input.fullTerm} onChange={() => set({ fullTerm: false })} data-testid="request-prorata" />
          <span>{text('request.proRataOption')}</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={input.allowsPartialRepay} onChange={(e) => set({ allowsPartialRepay: e.target.checked })} data-testid="request-partial" />
          <span>{text(k.partialOption)}</span>
        </label>
        <WhyLink summaryKey={k.optionsSummary} detailKey={k.optionsWhy} />
      </fieldset>

      {lender && isAdvanced ? (
        <section className="advanced-options" aria-labelledby="request-advanced" data-testid="request-advanced">
          <h3 id="request-advanced">{text('request.advancedTitle')}</h3>
          <fieldset className="choice-group">
            <legend className="sr-only">{text(k.rangeOption)}</legend>
            {rangeToggle}
            {ranged && (
              <div className="request-grid">
                <FormField
                  label={format('lendOffer.partLabel', { symbol: lendingSymbol })}
                  hint={text('lendOffer.partHint')}
                  error={
                    show('part')
                      ? minPart !== null && !minPart.ok
                        ? parseText(minPart.error, lendingSymbol, lendingDecimals)
                        : partShape === 'part-above-amount'
                          ? text('lendOffer.errPartAbove')
                          : floorText
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
                      value={input.minPart}
                      onChange={(e) => set({ minPart: e.target.value })}
                      onBlur={() => leave('part')}
                      data-testid="lend-offer-part"
                    />
                  )}
                </FormField>
              </div>
            )}
            <WhyLink summaryKey={k.rangeSummary} detailKey={k.rangeWhy} />
          </fieldset>
          {fillFieldset}
          {cadenceFieldset}
          {tariffFieldset}
        </section>
      ) : !lender && isAdvanced ? (
        <section className="advanced-options" aria-labelledby="request-advanced" data-testid="request-advanced">
          <h3 id="request-advanced">{text('request.advancedTitle')}</h3>
          <fieldset className="choice-group">
            <legend className="sr-only">{text(k.rangeOption)}</legend>
            {rangeToggle}
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
            <WhyLink summaryKey={k.rangeSummary} detailKey={k.rangeWhy} />
          </fieldset>
          {fillFieldset}
          {cadenceFieldset}
          {tariffFieldset}
          <p className="tier-b field-hint" data-testid="request-backstop">
            {text('request.backstopGap')}
          </p>
        </section>
      ) : (
        effective.length > 0 && (
          // RB-MODE: an Advanced choice still applies in Basic, and says so.
          <Notice tone="warn" tier="A">
            <span data-testid="request-advanced-set">
              {format(k.advancedSetNote, { list: listOf(effective.map((o) => text(o === 'range' ? k.advancedRange : ADVANCED_NAME[o]))) })}
            </span>{' '}
            <button
              type="button"
              className="btn"
              onClick={() =>
                set({ ranged: false, amountMax: '', minPart: '', collateralFloor: '', fillMode: 'partial', cadence: 0, tariff: false, tariffCeiling: '', tariffDowngrade: false })
              }
              data-testid="request-advanced-clear"
            >
              {text('request.advancedClear')}
            </button>
          </Notice>
        )
      )}
      {fillBlock !== null && !isAdvanced && (
        <Notice tone="warn" tier="A">
          {text(fillBlock === 'aon-range' ? 'request.fillAonRange' : k.fillIocOpen)}
        </Notice>
      )}
      {cadenceBlock !== null && !isAdvanced && (
        <Notice tone="warn" tier="A">
          <span data-testid="request-cadence-block">{cadenceBlock}</span>
        </Notice>
      )}
      {tariffBlock !== null && !isAdvanced && (
        <Notice tone="warn" tier="A">
          <span data-testid="request-tariff-block">{tariffBlock}</span>
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
            {lender
              ? format(cadence !== 0 ? k.summaryScheduled : k.summary, {
                  amount: amount?.ok ? tokenAmount(amount.value, pair.lending, meta, format) : '',
                  owe: tokenAmount(figures.owedAtDue, pair.lending, meta, format),
                })
              : largest !== null
                ? format(cadence !== 0 ? 'request.rangeReceiveSummaryScheduled' : 'request.rangeReceiveSummary', {
                    receive: tokenAmount(figures.received, pair.lending, meta, format),
                    owe: tokenAmount(figures.owedAtDue, pair.lending, meta, format),
                    largest: tokenAmount(largest, pair.lending, meta, format),
                  })
                : format(cadence !== 0 ? 'request.summaryScheduled' : 'request.summary', {
                    receive: tokenAmount(figures.received, pair.lending, meta, format),
                    owe: tokenAmount(figures.owedAtDue, pair.lending, meta, format),
                  })}
          </p>
        )}
        <div className="thumb-buttons">
          <button type="submit" className="btn btn-primary" disabled={inputs.data === null} data-testid="request-review">
            {text(k.review)}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            {text(k.cancelForm)}
          </button>
        </div>
      </div>
    </form>
  );
}
