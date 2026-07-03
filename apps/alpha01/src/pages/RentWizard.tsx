import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import { parseUnits, type Address } from 'viem';
import type { IndexedOffer } from '@vaipakam/defi-client';
import {
  acceptOfferFlow,
  computeRentalPrepayWei,
  createNftRentalDemand,
  createNftRentalListing,
  rentalDailyFeeWei,
  rentalPrepayForOffer,
} from '@vaipakam/defi-client';
import { AmountField } from '../components/AmountField';
import { AssetAmount } from '../components/AssetAmount';
import { BasicAssetPicker } from '../components/BasicAssetPicker';
import { DurationSelect } from '../components/DurationSelect';
import { EligibilityChecklist } from '../components/EligibilityChecklist';
import { FlowDone } from '../components/FlowDone';
import { HelpLink } from '../components/HelpLink';
import { RentalOfferCard } from '../components/RentalOfferCard';
import { ReviewReceipt, type ReviewReceiptView } from '../components/ReviewReceipt';
import { RiskConsentLabel } from '../components/RiskConsentLabel';
import { useWallet } from '../context/WalletContext';
import { useRentalBufferBps } from '../hooks/useProtocolConfig';
import { useSanctionsCheck } from '../hooks/useSanctionsCheck';
import { useBorrowerNftRentalDemands, useLenderNftOffersForRent } from '../hooks/useRentalOffers';
import { useSpendableBalance } from '../hooks/useSpendableBalance';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';
import { baseEligibilityItems, sanctionsAllowsProceed } from '../lib/eligibility';
import {
  hasResolvedTokenDecimals,
  requireTokenDecimals,
  useTokenMeta,
  type TokenMeta,
} from '../lib/tokenMeta';

type Path = 'choose' | 'list' | 'browse' | 'request';
type Step = 'inputs' | 'pick' | 'check' | 'review' | 'done';

function dailyFeeWeiFromHuman(amount: string, decimals: number): bigint {
  try {
    return parseUnits(amount || '0', decimals);
  } catch {
    return 0n;
  }
}

function listReceipt(opts: {
  dailyFee: string;
  duration: string;
  prepayAsset: string;
  prepayMeta: TokenMeta | null;
  nftLabel: string;
  rentalBufferBps: number;
  prepayDecimals: number;
}): ReviewReceiptView {
  const dailyWei = dailyFeeWeiFromHuman(opts.dailyFee, opts.prepayDecimals);
  const days = Number(opts.duration) || 0;
  const totalPrepay = computeRentalPrepayWei(dailyWei, days, opts.rentalBufferBps);
  const bufferWei = totalPrepay - dailyWei * BigInt(Math.max(days, 0));

  return {
    youReceive: {
      label: 'You receive',
      value: 'Rental fees when a renter accepts and the rental closes normally.',
      hint: 'Fees are not guaranteed until a renter accepts your listing.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          {opts.nftLabel} stays in vault custody. The renter never receives ownership — only temporary use
          rights.
        </>
      ),
      hint: 'Your NFT remains in your vault while listed and during an active rental.',
    },
    youMayOwe: { label: 'You may owe', value: 'Nothing beyond gas to post the listing.' },
    youCanLose: {
      label: 'You can lose',
      value: 'Nothing while the offer is open. If a renter defaults, protocol rules apply to prepaid fees.',
    },
    fees: {
      label: 'Fees',
      value: `Renter prepay includes a ${(opts.rentalBufferBps / 100).toFixed(1)}% buffer (returned on normal close). Network gas is separate.`,
    },
    whenEnds: {
      label: 'When this ends',
      value: `Listing stays open until accepted or you cancel. After acceptance, the rental runs for ${opts.duration} days.`,
    },
    technicalDetails:
      bufferWei > 0n
        ? [
            {
              label: 'Renter buffer (at accept)',
              value: (
                <AssetAmount
                  mode="raw"
                  amount={bufferWei.toString()}
                  address={opts.prepayAsset}
                  meta={opts.prepayMeta}
                />
              ),
            },
          ]
        : undefined,
  };
}

function requestReceipt(opts: {
  dailyFee: string;
  duration: string;
  prepayAsset: string;
  prepayMeta: TokenMeta | null;
  rentalBufferBps: number;
  prepayDecimals: number;
}): ReviewReceiptView {
  const dailyWei = dailyFeeWeiFromHuman(opts.dailyFee, opts.prepayDecimals);
  const days = Number(opts.duration) || 0;
  const totalPrepay = computeRentalPrepayWei(dailyWei, days, opts.rentalBufferBps);
  const bufferWei = totalPrepay - dailyWei * BigInt(Math.max(days, 0));

  return {
    youReceive: {
      label: 'You receive',
      value: 'Nothing yet — temporary use rights only when an NFT owner accepts your request.',
      hint: 'You never gain ownership; rights start only after a lender matches.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          <AssetAmount
            mode="raw"
            amount={totalPrepay.toString()}
            address={opts.prepayAsset}
            meta={opts.prepayMeta}
          />{' '}
          prepay (rental fees + buffer) now.
        </>
      ),
      hint: 'Prepay locks when you post the request, before any lender accepts.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: (
        <>
          Up to{' '}
          <AssetAmount mode="raw" amount={dailyWei.toString()} address={opts.prepayAsset} meta={opts.prepayMeta} /> per
          day for {opts.duration} days once matched.
        </>
      ),
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Prepaid fees if the rental ends by default. You never gain ownership of the NFT.',
    },
    fees: {
      label: 'Fees',
      value: (
        <>
          Includes {(opts.rentalBufferBps / 100).toFixed(1)}% prepay buffer (
          <AssetAmount mode="raw" amount={bufferWei.toString()} address={opts.prepayAsset} meta={opts.prepayMeta} />
          ). Protocol treasury may take a cut of rental fees. Gas is separate.
        </>
      ),
    },
    whenEnds: {
      label: 'When this ends',
      value: 'When you cancel, a lender accepts, or the rental term closes after a match.',
    },
  };
}

function acceptReceipt(
  offer: IndexedOffer,
  prepayMeta: TokenMeta | null,
  rentalBufferBps: number,
): ReviewReceiptView {
  const dailyWei = rentalDailyFeeWei(offer);
  const totalPrepay = rentalPrepayForOffer(offer, rentalBufferBps);
  const bufferWei = totalPrepay - dailyWei * BigInt(offer.durationDays);
  const nftLabel = offer.assetType === 2 ? 'ERC-1155' : 'ERC-721';

  return {
    youReceive: {
      label: 'You receive',
      value: `Temporary use rights to ${nftLabel} #${offer.tokenId} — not ownership.`,
      hint: 'Rights expire when you close the rental or when the term ends.',
    },
    youLock: {
      label: 'You lock',
      value: (
        <>
          <AssetAmount
            mode="raw"
            amount={totalPrepay.toString()}
            address={offer.prepayAsset}
            meta={prepayMeta}
          />{' '}
          prepay (rental fees + buffer).
        </>
      ),
      hint: 'Unused prepay and buffer can be claimable after a normal close.',
    },
    youMayOwe: {
      label: 'You may owe',
      value: (
        <>
          Up to{' '}
          <AssetAmount mode="raw" amount={dailyWei.toString()} address={offer.prepayAsset} meta={prepayMeta} /> per
          day for {offer.durationDays} days.
        </>
      ),
    },
    youCanLose: {
      label: 'You can lose',
      value: 'Prepaid fees if the rental ends by default. You never gain ownership of the NFT.',
    },
    fees: {
      label: 'Fees',
      value: (
        <>
          Includes {(rentalBufferBps / 100).toFixed(1)}% prepay buffer (
          <AssetAmount mode="raw" amount={bufferWei.toString()} address={offer.prepayAsset} meta={prepayMeta} />
          ). Protocol treasury may take a cut of rental fees. Gas is separate.
        </>
      ),
    },
    whenEnds: {
      label: 'When this ends',
      value: `After ${offer.durationDays} days, or earlier if you close the rental.`,
    },
  };
}

export function RentWizard() {
  const navigate = useNavigate();
  const chain = useReadChain();
  const { address, isCorrectChain, connect, switchToAppChain } = useWallet();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const sanctions = useSanctionsCheck(address);
  const { data: rentalBufferBps = 500 } = useRentalBufferBps();

  const [path, setPath] = useState<Path>('choose');
  const [step, setStep] = useState<Step>('inputs');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<IndexedOffer | null>(null);

  const [nftKind, setNftKind] = useState<'erc721' | 'erc1155'>('erc721');
  const [nftContract, setNftContract] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [dailyFee, setDailyFee] = useState('');
  const [prepayAsset, setPrepayAsset] = useState('');
  const [durationDays, setDurationDays] = useState('30');

  const prepayMeta = useTokenMeta(prepayAsset || null);
  const selectedPrepayMeta = useTokenMeta(selectedOffer?.prepayAsset ?? null);
  const { data: spendable } = useSpendableBalance(
    path === 'browse' ? selectedOffer?.prepayAsset ?? null : prepayAsset || null,
    address,
  );
  const { data: listings = [], isLoading: listingsLoading } = useLenderNftOffersForRent();
  const { data: demands = [] } = useBorrowerNftRentalDemands();

  const prepayDecimals = prepayMeta?.decimals ?? 18;

  const prepayRequired = useMemo(() => {
    if (path === 'browse' && selectedOffer) {
      return rentalPrepayForOffer(selectedOffer, rentalBufferBps);
    }
    if ((path === 'request' || path === 'browse') && dailyFee && prepayAsset) {
      return computeRentalPrepayWei(
        dailyFeeWeiFromHuman(dailyFee, prepayDecimals),
        Number(durationDays) || 0,
        rentalBufferBps,
      );
    }
    return 0n;
  }, [path, selectedOffer, dailyFee, prepayAsset, prepayDecimals, durationDays, rentalBufferBps]);

  const checklist = useMemo(
    () => [
      ...baseEligibilityItems({
        address,
        connect,
        chainName: chain.name,
        isCorrectChain,
        switchChain: () => void switchToAppChain(),
        consent,
        isSanctioned: sanctions.isSanctioned,
        sanctionsLoading: sanctions.loading,
        sanctionsUnverified: sanctions.unverified,
      }),
      ...(path !== 'list' && prepayRequired > 0n
        ? [
            spendable != null && spendable.total >= prepayRequired
              ? { id: 'prepay-balance', label: 'Enough prepay token in wallet', ok: true as const }
              : { id: 'prepay-balance', label: 'Insufficient prepay token balance', ok: false as const },
          ]
        : []),
    ],
    [
      address,
      chain.name,
      connect,
      consent,
      isCorrectChain,
      path,
      prepayRequired,
      sanctions,
      spendable,
      switchToAppChain,
    ],
  );

  const allOk =
    checklist.every((i) => i.ok) &&
    sanctionsAllowsProceed({
      isSanctioned: sanctions.isSanctioned,
      sanctionsLoading: sanctions.loading,
      sanctionsUnverified: sanctions.unverified,
    });

  function resetFlow(nextPath: Path) {
    setPath(nextPath);
    setStep(nextPath === 'browse' ? 'pick' : 'inputs');
    setError(null);
    setConsent(false);
    setSelectedOffer(null);
  }

  async function submitList() {
    if (!walletClient || !chain.diamondAddress) throw new Error('Wallet not connected');
    const decimals = requireTokenDecimals(prepayMeta, prepayAsset, 'Prepay asset', chain.chainId);
    await createNftRentalListing({
      diamond,
      publicClient,
      walletClient,
      diamondAddress: chain.diamondAddress as Address,
      form: {
        nftAssetKind: nftKind,
        nftContract,
        tokenId,
        quantity: nftKind === 'erc1155' ? quantity : '1',
        dailyFee,
        prepayAsset,
        durationDays,
        riskAndTermsConsent: consent,
      },
      decimals: { lending: decimals },
    });
  }

  async function submitDemand() {
    if (!walletClient || !chain.diamondAddress) throw new Error('Wallet not connected');
    const decimals = requireTokenDecimals(prepayMeta, prepayAsset, 'Prepay asset', chain.chainId);
    await createNftRentalDemand({
      diamond,
      publicClient,
      walletClient,
      diamondAddress: chain.diamondAddress as Address,
      form: {
        nftAssetKind: nftKind,
        nftContract,
        tokenId,
        quantity: nftKind === 'erc1155' ? quantity : '1',
        maxDailyFee: dailyFee,
        prepayAsset,
        durationDays,
        riskAndTermsConsent: consent,
      },
      decimals: { lending: decimals },
      rentalBufferBps,
    });
  }

  async function submitAccept(offer: IndexedOffer) {
    if (!walletClient || !chain.diamondAddress) throw new Error('Wallet not connected');
    await acceptOfferFlow({
      diamond,
      publicClient,
      walletClient,
      diamondAddress: chain.diamondAddress as Address,
      chainId: chain.chainId,
      offer,
      consent,
      rentalBufferBps,
    });
  }

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      if (path === 'list') await submitList();
      else if (path === 'request') await submitDemand();
      else if (path === 'browse' && selectedOffer) await submitAccept(selectedOffer);
      else throw new Error('Nothing to submit');
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setBusy(false);
    }
  }

  if (path === 'choose') {
    return (
      <div>
        <h1 className="page-title">Rent or lend an NFT</h1>
        <p className="page-subtitle">
          NFT rentals use temporary use rights — not a debt loan. <HelpLink anchor="nft-rental" />
        </p>
        <div className="intent-grid" style={{ marginTop: 16 }}>
          <button type="button" className="intent-card" onClick={() => resetFlow('list')}>
            <h3>I own an NFT</h3>
            <p>List your NFT for rent. It stays in vault custody; the renter gets temporary rights only.</p>
          </button>
          <button type="button" className="intent-card" onClick={() => resetFlow('browse')}>
            <h3>I want to rent one</h3>
            <p>Browse ERC-721 and ERC-1155 listings. You will see daily fee, total prepay, and duration before signing.</p>
          </button>
        </div>
        <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          <Link to="/">Back to home</Link>
        </p>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <FlowDone
        title={path === 'list' ? 'Rental listing posted' : path === 'request' ? 'Rental request posted' : 'Rental started'}
        body={
          path === 'browse'
            ? 'Your temporary use rights are active. Open Positions to close the rental or watch remaining time.'
            : 'Open Positions when a match happens, or post another listing.'
        }
        primaryLabel="View positions"
        onPrimary={() => navigate('/positions')}
        secondary={
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
            Back to home
          </button>
        }
      />
    );
  }

  if (path === 'browse' && step === 'pick') {
    return (
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => setPath('choose')}>
          ← Back
        </button>
        <h1 className="page-title" style={{ marginTop: 12 }}>Browse rentals</h1>
        <p className="page-subtitle">Pick a listing. Total prepay includes rental fees plus the protocol buffer.</p>
        {listingsLoading ? <p>Loading listings…</p> : null}
        {!listingsLoading && listings.length === 0 ? (
          <div className="card" style={{ marginTop: 16 }}>
            <p>No NFT rental listings match right now.</p>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => resetFlow('request')}>
              Post a rental request instead
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
            {listings.map((o) => (
              <RentalOfferCard
                key={o.offerId}
                offer={o}
                rentalBufferBps={rentalBufferBps}
                selected={selectedOffer?.offerId === o.offerId}
                onSelect={() => {
                  setSelectedOffer(o);
                  setStep('check');
                }}
              />
            ))}
          </div>
        )}
        {demands.length > 0 ? (
          <p style={{ marginTop: 16, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {demands.length} open rental request{demands.length === 1 ? '' : 's'} on the book.
          </p>
        ) : null}
      </div>
    );
  }

  if ((path === 'list' || path === 'request') && step === 'inputs') {
    return (
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => setPath('choose')}>
          ← Back
        </button>
        <h1 className="page-title" style={{ marginTop: 12 }}>
          {path === 'list' ? 'List your NFT' : 'Post a rental request'}
        </h1>
        <p className="page-subtitle">
          {path === 'list'
            ? 'Set a daily fee and duration. Your NFT stays in vault custody.'
            : 'Lock prepay now so lenders can accept when they have a matching NFT.'}
        </p>
        <div className="card" style={{ marginTop: 16, display: 'grid', gap: 12 }}>
          <label className="form-label">NFT type</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={`btn ${nftKind === 'erc721' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setNftKind('erc721')}
            >
              ERC-721
            </button>
            <button
              type="button"
              className={`btn ${nftKind === 'erc1155' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setNftKind('erc1155')}
            >
              ERC-1155
            </button>
          </div>
          <label className="form-label">NFT contract address</label>
          <input
            className="form-input"
            placeholder="0x…"
            value={nftContract}
            onChange={(e) => setNftContract(e.target.value.trim())}
          />
          <label className="form-label">Token ID</label>
          <input
            className="form-input"
            inputMode="numeric"
            placeholder="e.g. 42"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value.trim())}
          />
          {nftKind === 'erc1155' ? (
            <>
              <label className="form-label">Quantity</label>
              <input
                className="form-input"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.trim())}
              />
            </>
          ) : null}
          <BasicAssetPicker
            kind="stablecoin"
            chainId={chain.chainId}
            label="Prepay token (daily fee denomination)"
            value={prepayAsset}
            onChange={setPrepayAsset}
          />
          <AmountField
            label={path === 'list' ? 'Daily rental fee' : 'Max daily fee you will pay'}
            value={dailyFee}
            onChange={setDailyFee}
            hint="Fee is charged per day for the full rental term."
          />
          <DurationSelect
            label="Rental duration"
            value={durationDays}
            onChange={setDurationDays}
            hint="Total prepay = daily fee × days + buffer."
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !nftContract ||
              !tokenId ||
              !dailyFee ||
              !prepayAsset ||
              !hasResolvedTokenDecimals(prepayMeta, prepayAsset, chain.chainId)
            }
            onClick={() => setStep('check')}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === 'check') {
    return (
      <div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setStep(path === 'browse' ? 'pick' : 'inputs')}
        >
          ← Back
        </button>
        <h1 className="page-title" style={{ marginTop: 12 }}>Before you sign</h1>
        <EligibilityChecklist items={checklist} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <RiskConsentLabel />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 16 }}
          disabled={!allOk}
          onClick={() => setStep('review')}
        >
          Review receipt
        </button>
      </div>
    );
  }

  if (step === 'review') {
    const receipt =
      path === 'browse' && selectedOffer
        ? acceptReceipt(selectedOffer, selectedPrepayMeta, rentalBufferBps)
        : path === 'request'
          ? requestReceipt({
              dailyFee,
              duration: durationDays,
              prepayAsset,
              prepayMeta,
              rentalBufferBps,
              prepayDecimals,
            })
          : listReceipt({
              dailyFee,
              duration: durationDays,
              prepayAsset,
              prepayMeta,
              nftLabel: `${nftKind === 'erc1155' ? 'ERC-1155' : 'ERC-721'} #${tokenId}`,
              rentalBufferBps,
              prepayDecimals,
            });

    return (
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => setStep('check')}>
          ← Back
        </button>
        <h1 className="page-title" style={{ marginTop: 12 }}>Review receipt</h1>
        <ReviewReceipt data={receipt} />
        {error ? <p className="banner banner-error" style={{ marginTop: 12 }}>{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 16 }}
          disabled={busy || !allOk}
          onClick={() => void onConfirm()}
        >
          {busy ? 'Confirming…' : 'Sign transaction'}
        </button>
      </div>
    );
  }

  return null;
}