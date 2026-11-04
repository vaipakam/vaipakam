import { lazy, Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAccount, useSwitchChain } from 'wagmi';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { SUPPORTED_CHAINS } from '../chain/chains';
import { AssetPicker } from '../components/AssetPicker';
import { SelectMenu } from '../components/SelectMenu';
import { ConnectButton } from '../components/ConnectButton';
import { MarketFreshnessNote } from '../components/MarketFreshnessNote';
import { isAddressLike, useTokenMeta } from '../contracts/erc20';
import { useActiveOffers } from '../data/hooks';
import { fetchRecentLoans, type IndexedLoan, type IndexedOffer } from '../data/indexer';
import { offerAcceptPath } from '../data/offerLinks';
import { OFFER_DURATION_BUCKETS_DAYS, OFFER_DURATION_DEFAULT_DAYS } from '../lib/offerSchema';
import { exactUnitsOrNull, formatBpsAsPercent, formatDate, formatDurationDays, formatTokenAmountExact, shortAddress } from '../lib/format';
import { initiatedPrincipal, initiatedTerms } from '../lib/positionAmounts';
import { marketplaceOffers, marketplaceRate, verifiedMarketplaceHistory, type MarketplaceSide } from '../lib/marketplace';
import './marketplace.css';

const OfferFlow = lazy(() => import('../components/OfferFlow').then((m) => ({ default: m.OfferFlow })));
const PAGE_SIZE = 20;

function TokenAmount({ asset, amount }: { asset: string; amount: string | bigint | null }) {
  const meta = useTokenMeta(asset);
  if (amount === null) return <span>{copy.marketplace.notRecorded}</span>;
  return <span title={asset}>
    {meta.data
      ? `${formatTokenAmountExact(amount, meta.data.decimals)} ${meta.data.symbol}`
      : <>{String(amount)} · {shortAddress(asset)}<br /><small>{copy.marketplace.metadataUnknown}</small></>}
  </span>;
}

function OfferCard({ offer }: { offer: IndexedOffer }) {
  const { address } = useActiveChain();
  const own = address?.toLowerCase() === offer.creator.toLowerCase();
  const partial = BigInt(offer.amountFilled || '0') !== 0n;
  return <article className="card marketplace-offer">
    <div className="marketplace-offer-heading">
      <strong>{formatBpsAsPercent(marketplaceRate(offer))} <small>{copy.marketplace.apr}</small></strong>
      <span>{formatDurationDays(offer.durationDays)}</span>
    </div>
    <dl className="marketplace-facts">
      <div><dt>{copy.marketplace.principalAmount}</dt><dd><TokenAmount asset={offer.lendingAsset} amount={offer.offerType === 0 ? offer.amountMax : offer.amount} /></dd></div>
      <div><dt>{copy.marketplace.collateral}</dt><dd><TokenAmount asset={offer.collateralAsset} amount={offer.collateralAmount} /></dd></div>
    </dl>
    <p className="muted">{offer.offerType === 0 ? copy.marketplace.collateralFull : copy.marketplace.collateralFloor}</p>
    {(offer.refinanceTargetLoanId ?? 0) > 0 ? <p>{copy.marketplace.refinance}</p> : null}
    {own ? <span className="badge badge-neutral">{copy.marketplace.own}</span>
      : partial ? <p>{copy.marketplace.partial}</p>
        : <Link className="btn btn-primary" to={offerAcceptPath(offer)}>{copy.marketplace.review}</Link>}
  </article>;
}

function LoanRow({ loan }: { loan: IndexedLoan }) {
  const terms = initiatedTerms(loan);
  return <div className="item-row">
    <div className="row-main">
      <strong>{copy.activity.loanRef(loan.loanId)}</strong> · {formatDate(loan.startAt)}
      <div><TokenAmount asset={loan.lendingAsset} amount={initiatedPrincipal(loan)} /></div>
      <div className="muted">{terms
        ? <>{formatBpsAsPercent(terms.rateBps)} {copy.marketplace.apr} · {formatDurationDays(terms.durationDays)}</>
        : copy.marketplace.notRecorded}</div>
    </div>
  </div>;
}

function PairHistory({ lendingAsset, collateralAsset }: { lendingAsset: string; collateralAsset: string }) {
  const { readChain } = useActiveChain();
  const history = useQuery({
    queryKey: ['marketplaceRecentLoans', readChain.chainId, lendingAsset.toLowerCase(), collateralAsset.toLowerCase()],
    refetchInterval: 30_000,
    queryFn: async () => verifiedMarketplaceHistory(
      await fetchRecentLoans(readChain.chainId, { lendingAsset, collateralAsset, excludeSaleVehicles: true, limit: PAGE_SIZE }),
      { chainId: readChain.chainId, lendingAsset, collateralAsset },
    ),
  });
  return <section className="card" aria-labelledby="marketplace-history">
    <h2 id="marketplace-history">{copy.marketplace.recent}</h2>
    <p className="muted">{copy.marketplace.recentHint}</p>
    {history.isError || history.data === null
      ? <p role="status">{copy.marketplace.recentUnavailable} <button className="btn btn-secondary" onClick={() => void history.refetch()}>{copy.marketplace.retry}</button></p>
      : history.data === undefined ? <p role="status">{copy.chrome.loading}</p>
        : history.data.loans.length === 0 ? <p>{copy.marketplace.recentEmpty}</p>
          : <div className="row-list">{history.data.loans.map((loan) => <LoanRow key={loan.loanId} loan={loan} />)}</div>}
    {history.data?.nextBefore != null ? <p className="muted">{copy.marketplace.historyMore}</p> : null}
  </section>;
}

function MarketplaceSession() {
  const { readChain, isConnected } = useActiveChain();
  const switcher = useSwitchChain();
  const [side, setSide] = useState<MarketplaceSide>('lender');
  const [principal, setPrincipal] = useState('');
  const [collateral, setCollateral] = useState('');
  const [duration, setDuration] = useState('');
  const [amount, setAmount] = useState('');
  const principalMeta = useTokenMeta(isAddressLike(principal) ? principal : undefined);
  const minimumAmount = amount === '' || !principalMeta.data ? null : exactUnitsOrNull(amount, principalMeta.data.decimals);
  const amountValid = amount === '' || (minimumAmount !== null && minimumAmount > 0n);
  const [creating, setCreating] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const pairReady = isAddressLike(principal) && isAddressLike(collateral) &&
    !/^0x0{40}$/i.test(principal) && !/^0x0{40}$/i.test(collateral);
  const offers = useActiveOffers({ enabled: pairReady && !creating });
  const selection = { chainId: readChain.chainId, side, lendingAsset: principal, collateralAsset: collateral, durationDays: duration ? Number(duration) : null, minimumAmount };
  const matches = Array.isArray(offers.data) ? marketplaceOffers(offers.data, selection, now) : [];

  if (creating && pairReady) return <div className="stack">
    <Link className="btn btn-secondary" to="/marketplace" onClick={() => setCreating(false)}>{copy.marketplace.back}</Link>
    <Suspense fallback={<p role="status">{copy.chrome.loading}</p>}>
      <OfferFlow side={side} createOnly initialMarket={{
        lendingAsset: principal, collateralAsset: collateral,
        durationDays: duration || String(OFFER_DURATION_DEFAULT_DAYS),
      }} />
    </Suspense>
  </div>;

  return <div className="marketplace stack">
    <header><h1 className="page-title">{copy.marketplace.title}</h1><p className="page-lede">{copy.marketplace.lede}</p></header>
    <section className="card">
      <div className="marketplace-network">
        <div className="field">
          <label htmlFor="marketplace-network">{copy.marketplace.network}</label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={!isConnected || switcher.isPending}>
            <SelectMenu id="marketplace-network" value={String(readChain.chainId)}
              onChange={(value) => switcher.switchChain({ chainId: Number(value) })}
              options={SUPPORTED_CHAINS.map((chain) => ({ value: String(chain.chainId), label: chain.name }))} />
          </fieldset>
        </div>
        {readChain.testnet ? <span className="badge badge-info">{copy.marketplace.testnet}</span> : null}
        {!isConnected ? <ConnectButton /> : null}
      </div>
      <p className="muted">{copy.marketplace.networkHint}</p>
      {switcher.error ? <p role="alert">{copy.marketplace.networkError}</p> : null}
      <div className="cluster" role="group" aria-label={copy.marketplace.title}>
        <button className={side === 'lender' ? 'btn btn-primary' : 'btn btn-secondary'} aria-pressed={side === 'lender'} onClick={() => { setSide('lender'); setVisible(PAGE_SIZE); }}>{copy.chrome.nav.lend}</button>
        <button className={side === 'borrower' ? 'btn btn-primary' : 'btn btn-secondary'} aria-pressed={side === 'borrower'} onClick={() => { setSide('borrower'); setVisible(PAGE_SIZE); }}>{copy.chrome.nav.borrow}</button>
      </div>
      <div className="marketplace-pair">
        <AssetPicker searchable id="marketplace-principal" label={copy.marketplace.principal} value={principal} onChange={(value) => { setPrincipal(value); setAmount(''); setVisible(PAGE_SIZE); }} />
        <AssetPicker searchable id="marketplace-collateral" label={side === 'lender' ? copy.marketplace.collateralLend : copy.marketplace.collateralBorrow} value={collateral} onChange={(value) => { setCollateral(value); setVisible(PAGE_SIZE); }} />
      </div>
      <p className="muted">{copy.marketplace.tokenHint}</p>
      <div className="banner banner-warn" role="note">{side === 'lender' ? copy.marketplace.lendRisk : copy.marketplace.borrowRisk}</div>
    </section>
    <MarketFreshnessNote />
    {!pairReady ? <p role="status">{copy.marketplace.pairPrompt}</p> : <>
      <section aria-labelledby="marketplace-offers">
        <div className="marketplace-toolbar">
          <div><h2 id="marketplace-offers">{copy.marketplace.offers}</h2><p>{side === 'lender' ? copy.marketplace.lendSort : copy.marketplace.borrowSort}</p></div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>{copy.marketplace.create}</button>
        </div>
        <div className="field">
          <label htmlFor="marketplace-duration">{copy.marketplace.duration}</label>
          <SelectMenu id="marketplace-duration" value={duration} onChange={(value) => { setDuration(value); setVisible(PAGE_SIZE); }}
            options={[{ value: '', label: copy.marketplace.anyDuration }, ...OFFER_DURATION_BUCKETS_DAYS.map((days) => ({ value: String(days), label: formatDurationDays(days) }))]} />
        </div>
        <div className="field">
          <label htmlFor="marketplace-amount">{copy.marketplace.minimumAmount}</label>
          <input id="marketplace-amount" className="input" inputMode="decimal" value={amount}
            aria-invalid={!amountValid} onChange={(event) => { setAmount(event.target.value.trim()); setVisible(PAGE_SIZE); }} />
          <span className="field-hint">{amountValid ? copy.marketplace.amountHint : copy.marketplace.amountInvalid}</span>
        </div>
        <p className="muted">{copy.marketplace.scope}</p>
        {offers.isError || offers.data === null
          ? <p role="status">{copy.marketplace.unavailable} <button className="btn btn-secondary" onClick={() => void offers.refetch()}>{copy.marketplace.retry}</button></p>
          : !amountValid ? <p role="status">{copy.marketplace.amountInvalid}</p>
          : offers.data === undefined ? <p role="status">{copy.chrome.loading}</p>
            : matches.length === 0 ? <p role="status">{copy.marketplace.empty}</p>
              : <div className="marketplace-offers">{matches.slice(0, visible).map((offer) => <OfferCard key={offer.offerId} offer={offer} />)}</div>}
        {matches.length > visible ? <button className="btn btn-secondary" onClick={() => setVisible((count) => count + PAGE_SIZE)}>{copy.marketplace.more}</button> : null}
      </section>
      <PairHistory key={principal.toLowerCase() + collateral.toLowerCase()} lendingAsset={principal} collateralAsset={collateral} />
    </>}
  </div>;
}

/** A chain or wallet change unmounts selections, reads, consent and form
 * together: no previous-chain token pair or pending review is carried over. */
export function Marketplace() {
  const { readChain, address } = useActiveChain();
  const { chainId } = useAccount();
  return <MarketplaceSession key={readChain.chainId + ':' + (chainId ?? '') + ':' + (address ?? '')} />;
}
