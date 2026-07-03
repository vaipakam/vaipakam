/**
 * NFT rental — journeys N1 (owner lists an NFT) and N2 (user rents
 * one), kept deliberately separate from debt lending: nothing here is
 * called a loan, there is no "repay", and the custody model (NFT
 * stays vaulted; renter gets temporary use rights only) is stated
 * before anything is signed.
 *
 * Money model (mirrors OfferFacet): the renter prepays
 * `dailyFee × days` plus a refundable buffer (live
 * `rentalBufferBps`); rentals settle prepaid fees, not APR interest,
 * so listings are created with a 0% rate.
 *
 * NOTE on units: the on-chain daily fee is RAW wei of the prepay
 * asset (`toCreateOfferPayload` does `BigInt(amount)` for NFT legs).
 * This page converts the human "10 USDC per day" input with the
 * payment asset's live decimals BEFORE building the payload —
 * apps/defi's form writes the typed number through unscaled, which
 * this page intentionally does NOT copy (candidate
 * _CodeVsDocsAudit entry).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleCheck, Images, KeyRound, LoaderCircle } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { parseUnits } from 'viem';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { useAcceptTermsSigning } from '../contracts/useAcceptTerms';
import { ensureAllowance, isAddressLike, useTokenBalance, useTokenMeta } from '../contracts/erc20';
import { ensureNftApproval, useNftOwnership, useNftRentalSupport } from '../contracts/nft';
import { useActiveOffers, useOffer } from '../data/hooks';
import {
  readRentalBufferBps,
  totalRentalPrepay,
  useRentalBufferBps,
} from '../data/protocol';
import { useProtocolFees, bpsToPercentText } from '../data/fees';
import { useVpfi } from '../data/vpfi';
import type { IndexedOffer } from '../data/indexer';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type OfferFormState,
} from '../lib/offerSchema';
import { AssetType } from '../lib/types';
import { formatDurationDays, formatTokenAmount, shortAddress } from '../lib/format';
import { submitErrorText } from '../lib/errors';
import { AssetPicker } from '../components/AssetPicker';
import { Checklist, allChecksPass, type CheckItem } from '../components/Checklist';
import { ReviewReceipt, type ReceiptData } from '../components/ReviewReceipt';
import { StepNav } from '../components/StepNav';
import { useEligibility } from '../components/useEligibility';

type Path = 'own' | 'want' | null;

function bufferPct(bufferBps: number): string {
  return `${Number((bufferBps / 100).toFixed(2))}%`;
}

// ---------------------------------------------------------------- N1
function ListNftFlow() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const { bps: bufferBps } = useRentalBufferBps();
  const fees = useProtocolFees();

  const [step, setStep] = useState<'details' | 'review' | 'done'>('details');
  const [standard, setStandard] = useState<'erc721' | 'erc1155'>('erc721');
  const [contract, setContract] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [prepayAsset, setPrepayAsset] = useState('');
  const [dailyFee, setDailyFee] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const prepayMeta = useTokenMeta(prepayAsset || undefined);
  const standardEnum =
    standard === 'erc721' ? AssetType.ERC721 : AssetType.ERC1155;
  const ownership = useNftOwnership(contract, standardEnum, tokenId, quantity);
  // ERC-4907 is a heads-up, not a gate: the vault rents non-4907 NFTs
  // via its own renter registry (VaipakamVaultImplementation.setUser
  // only forwards when the collection supports it) — same first-party
  // semantic every ERC-1155 rental uses. We warn the owner that
  // external apps won't see the renter, and let them list.
  const rentalSupport = useNftRentalSupport(contract, standardEnum);

  const dailyFeeWei = useMemo(() => {
    if (!prepayMeta.data || !dailyFee || Number(dailyFee) <= 0) return null;
    try {
      return parseUnits(dailyFee, prepayMeta.data.decimals);
    } catch {
      return null;
    }
  }, [dailyFee, prepayMeta.data]);

  const form = useMemo((): OfferFormState | null => {
    if (!dailyFeeWei || !isAddressLike(contract) || !/^\d+$/.test(tokenId)) return null;
    // '0' is truthy as a string — a zero-edition ERC-1155 listing must
    // not pass the client gates only to revert after the approval tx.
    if (standard === 'erc1155' && !(/^\d+$/.test(quantity) && Number(quantity) > 0)) {
      return null;
    }
    return {
      ...initialOfferForm,
      offerType: 'lender',
      assetType: standard,
      lendingAsset: contract,
      // RAW prepay-asset wei — see the units note in the file header.
      amount: dailyFeeWei.toString(),
      interestRate: '0', // rentals settle prepaid fees, not APR
      durationDays,
      tokenId,
      quantity: standard === 'erc1155' ? quantity || '1' : '1',
      prepayAsset,
      riskAndTermsConsent: consent,
    };
  }, [dailyFeeWei, contract, tokenId, standard, durationDays, quantity, prepayAsset, consent]);

  const detailsComplete = form !== null;

  const baseChecks = useEligibility({ consent });
  // The contract rejects VPFI as a rental prepay asset
  // (VpfiNotAllowedAsRentalPrepay) — catch it BEFORE the user pays for
  // setApprovalForAll on the NFT.
  const vpfi = useVpfi();
  // Until the VPFI-token read SUCCEEDS we can't rule the prepay asset
  // in or out — a transport error is NOT knowledge (treating it as
  // known would let a pasted VPFI token pass, spend setApprovalForAll,
  // then revert VpfiNotAllowedAsRentalPrepay). react-query keeps the
  // last good snapshot across refetch errors, so `data` present is
  // enough even when `isError` flickers.
  const vpfiKnown = vpfi.data !== undefined;
  const vpfiCheckFailed = vpfi.data === undefined && vpfi.isError;
  const prepayIsVpfi =
    Boolean(vpfi.data?.token) &&
    prepayAsset.toLowerCase() === vpfi.data!.token!.toLowerCase();
  const checks = useMemo((): CheckItem[] => {
    const extra: CheckItem[] = [
      {
        id: 'nft-ownership',
        label:
          ownership.data === false || ownership.data === null
            ? copy.rent.checkNotOwner
            : copy.rent.checkOwnNft,
        state:
          ownership.data === true
            ? 'pass'
            : ownership.data === undefined
              ? 'pending'
              : 'fail',
      },
      {
        id: 'prepay-token',
        label: prepayIsVpfi
          ? 'VPFI can’t be used as the rental payment asset — pick another token.'
          : vpfiCheckFailed
            ? 'We couldn’t verify the payment asset just now — please retry in a moment.'
            : prepayMeta.isError
              ? copy.errors.notAToken
              : `Payment asset recognised (${prepayMeta.data?.symbol ?? '…'})`,
        state: prepayIsVpfi
          ? 'fail'
          : vpfiCheckFailed
            ? 'fail'
            : !vpfiKnown
              ? 'pending'
              : prepayMeta.isError
                ? 'fail'
                : prepayMeta.data
                  ? 'pass'
                  : 'pending',
      },
      {
        id: 'live-fees',
        label: fees.ready ? 'Live fee terms loaded' : 'Loading live fee terms…',
        state: fees.ready ? 'pass' : 'pending',
      },
    ];
    // wallet + network first, then the rental-specific facts, then consent.
    return [...baseChecks.slice(0, 2), ...extra, ...baseChecks.slice(2)];
  }, [baseChecks, ownership.data, prepayMeta.isError, prepayMeta.data, prepayIsVpfi, vpfiKnown, vpfiCheckFailed, fees.ready]);

  const receipt = useMemo((): ReceiptData | null => {
    if (!form || !dailyFeeWei || !prepayMeta.data) return null;
    const days = Number(durationDays);
    const totalFees = dailyFeeWei * BigInt(days);
    const pay = prepayMeta.data.symbol;
    const feesStr = `${formatTokenAmount(totalFees, prepayMeta.data.decimals)} ${pay}`;
    const nftStr = `${shortAddress(contract)} #${tokenId}${
      standard === 'erc1155' ? ` ×${quantity || '1'}` : ''
    }`;
    return {
      youReceive: `~${feesStr} in rental fees for the full ${formatDurationDays(days)} term — the renter prepays everything up front.`,
      youLock: `Your NFT ${nftStr} moves into your vault and stays there for the whole listing and rental.`,
      youMayOwe: 'Nothing.',
      youCanLose: `Temporary use of the NFT while it is rented — the renter can never transfer or sell it. ${copy.rent.notDebt}`,
      fees: copy.fees
        .lenderYieldFee(bpsToPercentText(fees.treasuryFeeBps))
        .replace('interest', 'rental fees'),
      whenThisEnds: `When the rental ends, the renter’s rights reset automatically; you claim your fees and reclaim the NFT from the rental’s detail page.`,
    };
  }, [
    form,
    dailyFeeWei,
    prepayMeta.data,
    durationDays,
    contract,
    tokenId,
    standard,
    quantity,
    fees.treasuryFeeBps,
  ]);

  const formError = form ? validateOfferForm(form) : null;
  const canSign =
    allChecksPass(checks) &&
    receipt !== null &&
    formError === null &&
    // wallet client hydrates async after isConnected — without these a
    // click in the gap would silently no-op.
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    !busy;

  async function submit() {
    if (!form || !address || !walletChain || !walletClient || !publicClient) {
      setError(copy.wallet.connectFirst);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ensureNftApproval({
        publicClient,
        walletClient,
        contract: contract as `0x${string}`,
        owner: address,
        operator: walletChain.diamondAddress,
      });
      const payload = toCreateOfferPayload(form, {});
      const { hash } = await write('createOffer', [payload]);
      setTxHash(hash);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <StepNav
        steps={['Your NFT & price', 'Review & sign', 'Done']}
        current={step === 'details' ? 0 : step === 'review' ? 1 : 2}
      />

      {step === 'details' ? (
        <div className="card">
          <div className="field">
            <label htmlFor="nft-standard">NFT type</label>
            <select
              id="nft-standard"
              className="input"
              value={standard}
              onChange={(e) => setStandard(e.target.value as 'erc721' | 'erc1155')}
            >
              <option value="erc721">Single NFT (ERC-721)</option>
              <option value="erc1155">Multi-edition NFT (ERC-1155)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="nft-contract">NFT contract address</label>
            <input
              id="nft-contract"
              className={`input ${contract !== '' && !isAddressLike(contract) ? 'input-invalid' : ''}`}
              placeholder="0x…"
              value={contract}
              onChange={(e) => setContract(e.target.value.trim())}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="field-hint">
              Single NFTs that support ERC-4907 give renters use rights other
              apps can see; other NFTs still rent, tracked inside Vaipakam.
            </span>
          </div>
          <div className="field">
            <label htmlFor="nft-token-id">Token id</label>
            <input
              id="nft-token-id"
              className="input"
              inputMode="numeric"
              placeholder="1"
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value.trim())}
            />
          </div>
          {standard === 'erc1155' ? (
            <div className="field">
              <label htmlFor="nft-quantity">Quantity</label>
              <input
                id="nft-quantity"
                className="input"
                inputMode="numeric"
                placeholder="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.trim())}
              />
            </div>
          ) : null}
          <AssetPicker
            id="prepay-asset"
            label="Asset renters pay you in"
            hint="Renters prepay the whole rental in this token."
            value={prepayAsset}
            onChange={setPrepayAsset}
          />
          <div className="field">
            <label htmlFor="daily-fee">
              Daily fee{prepayMeta.data ? ` (${prepayMeta.data.symbol} per day)` : ''}
            </label>
            <input
              id="daily-fee"
              className="input"
              inputMode="decimal"
              placeholder="10"
              value={dailyFee}
              onChange={(e) => setDailyFee(e.target.value.trim())}
            />
            <span className="field-hint">
              {copy.rent.bufferNote(bufferPct(bufferBps))}
            </span>
          </div>
          <div className="field">
            <label htmlFor="rent-duration">Rental length</label>
            <select
              id="rent-duration"
              className="input"
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
            >
              {OFFER_DURATION_BUCKETS_DAYS.map((d) => (
                <option key={d} value={String(d)}>
                  {formatDurationDays(d)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!detailsComplete}
            onClick={() => setStep('review')}
          >
            Continue to review
          </button>
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="stack">
          <div className="banner banner-info">
            <span className="banner-body">{copy.rent.custodyNote}</span>
          </div>
          {standard === 'erc721' && rentalSupport.data !== true && !rentalSupport.isLoading ? (
            <div className="banner banner-warn" role="status">
              <span className="banner-body">
                {rentalSupport.data === false
                  ? copy.rent.no4907Warning
                  : copy.rent.no4907Unknown}
              </span>
            </div>
          ) : null}
          <div className="card">
            <h3>Before you sign</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : <p className="muted">Preparing your review…</p>}
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span style={{ flex: 1 }}>{copy.consentLabel}</span>
            </label>
            {error ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{error}</span>
              </div>
            ) : null}
            <div className="cluster" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep('details')}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!canSign}
                onClick={() => void submit()}
              >
                {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                {busy ? 'Waiting for wallet…' : copy.rent.postListing}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <CircleCheck aria-hidden size={40} style={{ color: 'var(--ok)', marginBottom: 8 }} />
          <h2>{copy.rent.listingPosted}</h2>
          <p className="muted">{copy.rent.listingPostedNext}</p>
          {txHash && walletChain ? (
            <p className="muted">
              <a
                href={`${walletChain.blockExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View the transaction
              </a>
            </p>
          ) : null}
          <Link to="/positions" className="btn btn-primary">
            View my positions
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- N2
function RentalListingRow({
  offer,
  bufferBps,
  onChoose,
}: {
  offer: IndexedOffer;
  bufferBps: number;
  onChoose: () => void;
}) {
  const prepayMeta = useTokenMeta(offer.prepayAsset);
  const dailyFee = BigInt(offer.amount);
  const total = totalRentalPrepay(dailyFee, offer.durationDays, bufferBps);
  const pay = prepayMeta.data?.symbol ?? '…';

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {shortAddress(offer.lendingAsset)} #{offer.tokenId}
          {offer.assetType === AssetType.ERC1155 ? ` ×${offer.quantity}` : ''}
        </span>
        <br />
        <span className="row-sub">
          {prepayMeta.data
            ? `${formatTokenAmount(dailyFee, prepayMeta.data.decimals)} ${pay}/day · ${formatDurationDays(offer.durationDays)} · ${formatTokenAmount(total, prepayMeta.data.decimals)} ${pay} up front (incl. buffer)`
            : `${formatDurationDays(offer.durationDays)} · listing #${offer.offerId}`}
        </span>
      </span>
      <button type="button" className="btn btn-primary btn-sm" onClick={onChoose}>
        {copy.match.choose}
      </button>
    </div>
  );
}

function RentNftFlow() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const { sign: signAcceptTerms } = useAcceptTermsSigning();
  const queryClient = useQueryClient();
  const { bps: bufferBps, ready: bufferReady } = useRentalBufferBps();
  const activeOffers = useActiveOffers();

  const [step, setStep] = useState<'browse' | 'review' | 'done'>('browse');
  const [selected, setSelected] = useState<IndexedOffer | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Deep link (?offer=<id>) from the Offer Book's "Rent this NFT".
  // Same rules and notices as OfferFlow's deep link — dead links get a
  // plain-language explanation, never a silent return to browse.
  const [searchParams, setSearchParams] = useSearchParams();
  const offerParam = searchParams.get('offer');
  const offerParamValid =
    offerParam !== null && /^\d+$/.test(offerParam.trim()) && offerParam.trim() !== '';
  const deepLinkId = offerParamValid ? Number(offerParam) : undefined;
  const deepLinkQuery = useOffer(deepLinkId);
  useEffect(() => {
    if (offerParam === null || selected || step !== 'browse') return;
    const clear = (message: string | null) => {
      if (message) setNotice(message);
      setSearchParams({}, { replace: true });
    };
    if (!offerParamValid) {
      clear(copy.match.offerNotFound);
      return;
    }
    if (deepLinkQuery.isLoading) return;
    const row = deepLinkQuery.data;
    if (row === null || row === undefined) {
      clear(copy.match.offerNotFound);
      return;
    }
    if (row.offerType !== 0 || row.assetType === AssetType.ERC20) {
      clear(copy.match.wrongSide);
      return;
    }
    if (address && row.creator.toLowerCase() === address.toLowerCase()) {
      clear(copy.match.ownOffer);
      return;
    }
    if (row.status !== 'active') {
      clear(copy.match.offerGone);
      return;
    }
    clear(null);
    setSelected(row);
    setStep('review');
  }, [
    offerParam,
    offerParamValid,
    deepLinkQuery.isLoading,
    deepLinkQuery.data,
    selected,
    step,
    address,
    setSearchParams,
  ]);

  const listings = useMemo(() => {
    const rows = activeOffers.data;
    if (!Array.isArray(rows)) return rows === null ? null : [];
    return rows.filter(
      (o) =>
        o.offerType === 0 &&
        (o.assetType === AssetType.ERC721 || o.assetType === AssetType.ERC1155) &&
        (!address || o.creator.toLowerCase() !== address.toLowerCase()),
    );
  }, [activeOffers.data, address]);

  const prepayMeta = useTokenMeta(selected?.prepayAsset);
  const prepayBalance = useTokenBalance(selected?.prepayAsset);
  const totalPrepay = selected
    ? totalRentalPrepay(BigInt(selected.amount), selected.durationDays, bufferBps)
    : undefined;

  const baseChecks = useEligibility({
    asset: selected
      ? {
          meta: prepayMeta.data,
          metaError: prepayMeta.isError,
          balance: prepayBalance.data,
          required: totalPrepay,
        }
      : undefined,
    consent,
  });
  // The prepay pull depends on the LIVE buffer — signing before the
  // config read lands would compute the approval from a default.
  const checks = useMemo(
    (): CheckItem[] => [
      ...baseChecks,
      {
        id: 'rental-config',
        label: bufferReady
          ? 'Live rental terms loaded'
          : 'Loading live rental terms…',
        state: bufferReady ? 'pass' : 'pending',
      },
    ],
    [baseChecks, bufferReady],
  );

  const receipt = useMemo((): ReceiptData | null => {
    if (!selected || !prepayMeta.data || totalPrepay === undefined) return null;
    const pay = prepayMeta.data.symbol;
    const totalStr = `${formatTokenAmount(totalPrepay, prepayMeta.data.decimals)} ${pay}`;
    const nftStr = `${shortAddress(selected.lendingAsset)} #${selected.tokenId}`;
    const durationStr = formatDurationDays(selected.durationDays);
    return {
      youReceive: `Use rights of ${nftStr} for ${durationStr}, starting now. ${copy.rent.custodyNote}`,
      youLock: `${totalStr} prepaid — the full term’s fees plus a ${bufferPct(bufferBps)} refundable buffer.`,
      youMayOwe: `Nothing more — fees are prepaid. ${copy.rent.notDebt}`,
      youCanLose: `The ${bufferPct(bufferBps)} buffer if the rental isn’t closed on time. Your use rights end at expiry either way.`,
      fees: 'The price shown is the rental fee; Vaipakam’s cut comes out of the owner’s earnings, not on top of yours.',
      whenThisEnds: `Rights reset automatically after ${durationStr}. Close the rental on time from its detail page to get the buffer back.`,
    };
  }, [selected, prepayMeta.data, totalPrepay, bufferBps]);

  const canSign =
    allChecksPass(checks) &&
    receipt !== null &&
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    !busy;

  async function submit() {
    if (!selected || !address || !walletChain || !walletClient || !publicClient) {
      setError(copy.wallet.connectFirst);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Reviewed row and executing chain must agree — same offerId on
      // another chain is a different rental.
      if (selected.chainId !== walletChain.chainId) {
        throw new Error(copy.match.termsChanged);
      }
      // Re-check at submit time: the wallet may have changed since the
      // listing was selected (deep link → connect the owner wallet).
      if (selected.creator.toLowerCase() === address.toLowerCase()) {
        throw new Error(copy.match.ownOffer);
      }
      // acceptOffer screens BOTH parties — if the owner was flagged
      // after listing, abort before any signature or prepay approval.
      const ownerFlagged = await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [selected.creator as `0x${string}`],
        })
        .catch(() => false); // fail-open, mirroring useSanctionsCheck
      if (ownerFlagged) {
        throw new Error(copy.match.counterpartyBlocked);
      }
      const { terms, signature } = await signAcceptTerms({
        offerId: BigInt(selected.offerId),
        consent,
      });
      // Canonical terms must still match what was reviewed (the owner
      // can edit the listing in place; the indexer row can lag).
      const reviewedMatchesSigned =
        terms.lendingAsset.toLowerCase() === selected.lendingAsset.toLowerCase() &&
        terms.prepayAsset.toLowerCase() === selected.prepayAsset.toLowerCase() &&
        terms.amount === BigInt(selected.amount) &&
        Number(terms.durationDays) === selected.durationDays &&
        terms.tokenId === BigInt(selected.tokenId);
      if (!reviewedMatchesSigned) {
        void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
        void queryClient.invalidateQueries({ queryKey: ['offer'] });
        throw new Error(copy.match.termsChanged);
      }
      // Renter's pull is dailyFee × days × (1 + buffer) in prepayAsset.
      // Fee terms come from the SIGNED canonical terms; the buffer is
      // read LIVE right now — never a default that may lag governance.
      const liveBufferBps = await readRentalBufferBps(
        publicClient,
        walletChain.diamondAddress,
      );
      // The receipt and balance check used the cached buffer — if
      // governance changed it since review, the user would be asked to
      // approve MORE than the receipt showed. Force a re-review.
      if (liveBufferBps !== bufferBps) {
        void queryClient.invalidateQueries({ queryKey: ['rentalBufferBps'] });
        throw new Error(copy.match.termsChanged);
      }
      // A legacy listing can carry the (now-disallowed) VPFI token as
      // its prepay asset — acceptOffer reverts VpfiNotAllowedAsRental-
      // Prepay AFTER the approval would have been mined. Check the
      // SIGNED terms against the live VPFI token first, and fail
      // CLOSED when the read itself fails: proceeding unchecked is
      // exactly the wasted-approval path this guard exists to prevent
      // (nothing has been sent yet — retrying is free).
      const vpfiToken = (await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getVPFIToken',
        })
        .catch(() => {
          throw new Error(copy.rent.vpfiCheckRetry);
        })) as string;
      if (vpfiToken.toLowerCase() === terms.prepayAsset.toLowerCase()) {
        throw new Error(copy.rent.vpfiPrepayListing);
      }
      const canonicalTotal = totalRentalPrepay(
        terms.amount,
        Number(terms.durationDays),
        liveBufferBps,
      );
      await ensureAllowance({
        publicClient,
        walletClient,
        token: terms.prepayAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: canonicalTotal,
      });
      const { hash } = await write('acceptOffer', [
        BigInt(selected.offerId),
        terms,
        signature,
      ]);
      setTxHash(hash);
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <StepNav
        steps={['Choose an NFT', 'Review & sign', 'Done']}
        current={step === 'browse' ? 0 : step === 'review' ? 1 : 2}
      />

      {step === 'browse' && notice ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{notice}</span>
        </div>
      ) : null}

      {step === 'browse' ? (
        <div className="card">
          <div className="card-title">
            <KeyRound aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.rent.browseTitle}</h2>
          </div>
          {activeOffers.isLoading ? (
            <p className="muted">Loading rental listings…</p>
          ) : listings === null ? (
            <p className="muted">{copy.rent.browseUnavailable}</p>
          ) : listings.length === 0 ? (
            <p className="muted">{copy.rent.browseEmpty}</p>
          ) : (
            <div className="row-list">
              {listings.map((o) => (
                <RentalListingRow
                  key={o.offerId}
                  offer={o}
                  bufferBps={bufferBps}
                  onChoose={() => {
                    setSelected(o);
                    setStep('review');
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {step === 'review' && selected ? (
        <div className="stack">
          <div className="banner banner-info">
            <span className="banner-body">{copy.rent.custodyNote}</span>
          </div>
          <div className="card">
            <h3>Before you sign</h3>
            <Checklist items={checks} />
          </div>
          <div className="card">
            {receipt ? <ReviewReceipt data={receipt} /> : <p className="muted">Preparing your review…</p>}
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span style={{ flex: 1 }}>{copy.consentLabel}</span>
            </label>
            {error ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{error}</span>
              </div>
            ) : null}
            <div className="cluster" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSelected(null);
                  setStep('browse');
                }}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!canSign}
                onClick={() => void submit()}
              >
                {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                {busy ? 'Waiting for wallet…' : copy.rent.acceptRental}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <CircleCheck aria-hidden size={40} style={{ color: 'var(--ok)', marginBottom: 8 }} />
          <h2>{copy.rent.rentalOpened}</h2>
          <p className="muted">{copy.rent.rentalOpenedNext}</p>
          {txHash && walletChain ? (
            <p className="muted">
              <a
                href={`${walletChain.blockExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View the transaction
              </a>
            </p>
          ) : null}
          <Link to="/positions" className="btn btn-primary">
            View my positions
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- page
export function Rent() {
  // A ?offer=<id> deep link goes straight to the renter path.
  const [initialSearch] = useSearchParams();
  const [path, setPath] = useState<Path>(
    initialSearch.get('offer') !== null ? 'want' : null,
  );

  return (
    <div>
      <h1 className="page-title">{copy.rent.title}</h1>
      <p className="page-lede">{copy.rent.lede}</p>

      {path === null ? (
        <div className="intent-grid">
          <button type="button" className="intent-card" onClick={() => setPath('own')}>
            <span className="intent-icon">
              <Images aria-hidden />
            </span>
            <span style={{ textAlign: 'left' }}>
              <h3>{copy.rent.ownPath}</h3>
              <p>{copy.rent.ownPathBlurb}</p>
            </span>
          </button>
          <button type="button" className="intent-card" onClick={() => setPath('want')}>
            <span className="intent-icon">
              <KeyRound aria-hidden />
            </span>
            <span style={{ textAlign: 'left' }}>
              <h3>{copy.rent.wantPath}</h3>
              <p>{copy.rent.wantPathBlurb}</p>
            </span>
          </button>
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPath(null)}
            >
              ← {path === 'own' ? copy.rent.wantPath : copy.rent.ownPath}? Switch
            </button>
          </p>
          {path === 'own' ? <ListNftFlow /> : <RentNftFlow />}
        </>
      )}
    </div>
  );
}
