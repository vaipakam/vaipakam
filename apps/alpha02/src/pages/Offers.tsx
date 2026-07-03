/**
 * Offer Book — a browse surface (advanced navigation, still readable
 * in plain language). Each ERC-20/ERC-20 row deep-links into the
 * guided flow's review step ("Use this offer" → /borrow?offer=N for
 * lending offers, /lend?offer=N for borrow requests), so accepting
 * from the book shares the exact receipt/checklist/signing path.
 *
 * Advanced mode reveals power controls IN PLACE (H1: switching mode
 * never navigates): side filter, rate/duration sorting, an asset-
 * address filter, and a per-row detail line with the exact bps, the
 * offer id, expiry, and range bounds. Basic mode keeps the plain
 * newest-first list.
 *
 * Empty-state honesty rule (audit F-20260702-001): "no offers" is
 * only said when the indexer POSITIVELY returned zero offers; a
 * failed load shows the unavailable state instead. A filter that
 * matches nothing says "no match for these filters" — never "the
 * market is empty".
 */
import { useMemo, useState } from 'react';
import { BookOpen, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { useActiveOffers } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import {
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../lib/format';
import type { IndexedOffer } from '../data/indexer';

type SideFilter = 'all' | 'lending' | 'borrowing' | 'rentals';
type SortKey =
  | 'newest'
  | 'rate-low'
  | 'rate-high'
  | 'duration-short'
  | 'duration-long';

function isRental(offer: IndexedOffer): boolean {
  return offer.assetType !== AssetType.ERC20 && offer.offerType === 0;
}

/** Comparable APR for sorting; rentals have no APR → null (sinks). */
function rateOf(offer: IndexedOffer): number | null {
  if (isRental(offer)) return null;
  return offer.offerType === 0
    ? offer.interestRateBps
    : offer.interestRateBpsMax;
}

function OfferRow({ offer }: { offer: IndexedOffer }) {
  const { address } = useActiveChain();
  const { isAdvanced } = useMode();
  const isLending = offer.offerType === 0;
  const isRentalListing = isRental(offer);
  // A rental listing's "lending asset" is the NFT contract and its
  // price lives in the prepay asset — never format it through the
  // ERC-20 loan template (it renders "… / 0% yearly / 0x0000…0000").
  const meta = useTokenMeta(isRentalListing ? undefined : offer.lendingAsset);
  const prepayMeta = useTokenMeta(isRentalListing ? offer.prepayAsset : undefined);
  const hasCollateral =
    offer.collateralAsset.toLowerCase() !==
    '0x0000000000000000000000000000000000000000';
  const collateralMeta = useTokenMeta(hasCollateral ? offer.collateralAsset : undefined);

  const notMine =
    !address || offer.creator.toLowerCase() !== address.toLowerCase();
  const acceptable =
    notMine &&
    (isRentalListing ||
      (offer.assetType === AssetType.ERC20 &&
        offer.collateralAssetType === AssetType.ERC20));
  // Offer ids are PER-CHAIN — a link without the chain can resolve to
  // a different offer with the same id on another network. The deep-
  // link consumers refuse to select when this doesn't match the
  // active read chain.
  const acceptHref = isRentalListing
    ? `/rent?offer=${offer.offerId}&chain=${offer.chainId}`
    : isLending
      ? `/borrow?offer=${offer.offerId}&chain=${offer.chainId}`
      : `/lend?offer=${offer.offerId}&chain=${offer.chainId}`;

  const title = isRentalListing
    ? `NFT rental · ${shortAddress(offer.lendingAsset)} #${offer.tokenId}${
        offer.assetType === AssetType.ERC1155 ? ` ×${offer.quantity}` : ''
      }`
    : `${isLending ? copy.offers.lenderOffer : copy.offers.borrowerOffer} · ${
        meta.data
          ? formatTokenAmount(
              isLending ? offer.amountMax : offer.amount,
              meta.data.decimals,
            )
          : '…'
      } ${meta.data?.symbol ?? ''}`;

  const sub = isRentalListing
    ? `${
        prepayMeta.data
          ? `${formatTokenAmount(offer.amount, prepayMeta.data.decimals)} ${prepayMeta.data.symbol}/day`
          : 'daily fee loading…'
      } · ${formatDurationDays(offer.durationDays)} · fees prepaid · by ${shortAddress(offer.creator)}`
    : `${formatBpsAsPercent(
        isLending ? offer.interestRateBps : offer.interestRateBpsMax,
      )} yearly · ${formatDurationDays(offer.durationDays)} · collateral ${
        hasCollateral
          ? (collateralMeta.data?.symbol ?? shortAddress(offer.collateralAsset))
          : 'none'
      } · by ${shortAddress(offer.creator)}`;

  // Advanced detail line: the exact numbers a DEX-versed user expects
  // to see before clicking through — id, bps, expiry, range bounds.
  const advancedBits: string[] = [];
  if (isAdvanced) {
    advancedBits.push(`offer #${offer.offerId}`);
    if (!isRentalListing) {
      const bps = isLending ? offer.interestRateBps : offer.interestRateBpsMax;
      advancedBits.push(`${bps} bps`);
      // Range offers: a lender can post a size band, a borrower a rate
      // band — direct accept binds one end, matching can fill within.
      if (isLending && offer.amount !== offer.amountMax && meta.data) {
        advancedBits.push(
          `size ${formatTokenAmount(offer.amount, meta.data.decimals)}–${formatTokenAmount(offer.amountMax, meta.data.decimals)} ${meta.data.symbol}`,
        );
      }
      // Borrow requests posted by this app carry floor 0 / ceiling Y by
      // design — a zero floor is still a real band, so don't suppress it.
      if (!isLending && offer.interestRateBpsMax !== offer.interestRateBps) {
        advancedBits.push(
          `rate band ${offer.interestRateBps}–${offer.interestRateBpsMax} bps`,
        );
      }
      // Always state the flag both ways — on rows where it's absent an
      // advanced user can't tell "disabled" from "not rendered".
      advancedBits.push(
        offer.allowsPartialRepay ? 'partial repay OK' : 'no partial repay',
      );
    }
    advancedBits.push(
      offer.expiresAt ? `expires ${formatDate(offer.expiresAt)}` : 'no expiry',
    );
  }

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">{title}</span>
        <br />
        <span className="row-sub">{sub}</span>
        {isAdvanced && advancedBits.length > 0 ? (
          <>
            <br />
            <span className="row-sub muted">{advancedBits.join(' · ')}</span>
          </>
        ) : null}
      </span>
      {acceptable ? (
        <Link to={acceptHref} className="btn btn-primary btn-sm">
          {isRentalListing ? 'Rent this NFT' : 'Use this offer'}
        </Link>
      ) : (
        <span className={`badge ${isLending ? 'badge-info' : 'badge-neutral'}`}>
          {isLending ? 'Lender' : 'Borrower'}
        </span>
      )}
    </div>
  );
}

export function Offers() {
  const offers = useActiveOffers();
  const { isAdvanced } = useMode();

  const [side, setSide] = useState<SideFilter>('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [assetFilter, setAssetFilter] = useState('');

  // Basic mode ignores the power controls entirely (they aren't
  // rendered), so switching back to Basic restores the plain list.
  const activeSide: SideFilter = isAdvanced ? side : 'all';
  const activeSort: SortKey = isAdvanced ? sort : 'newest';
  const activeAssetFilter = isAdvanced ? assetFilter.trim().toLowerCase() : '';

  const visible = useMemo(() => {
    if (!Array.isArray(offers.data)) return offers.data;
    let rows = offers.data.filter((o) => {
      const lending = o.offerType === 0;
      const rental = isRental(o);
      if (activeSide === 'lending' && (!lending || rental)) return false;
      if (activeSide === 'borrowing' && lending) return false;
      if (activeSide === 'rentals' && !rental) return false;
      if (
        activeAssetFilter &&
        !o.lendingAsset.toLowerCase().includes(activeAssetFilter) &&
        !o.collateralAsset.toLowerCase().includes(activeAssetFilter) &&
        !(o.prepayAsset ?? '').toLowerCase().includes(activeAssetFilter)
      ) {
        return false;
      }
      return true;
    });
    if (activeSort !== 'newest') {
      rows = [...rows].sort((a, b) => {
        switch (activeSort) {
          case 'rate-low': {
            // Rentals have no APR — sink them below every priced row.
            const ra = rateOf(a) ?? Number.POSITIVE_INFINITY;
            const rb = rateOf(b) ?? Number.POSITIVE_INFINITY;
            return ra - rb;
          }
          case 'rate-high': {
            const ra = rateOf(a) ?? Number.NEGATIVE_INFINITY;
            const rb = rateOf(b) ?? Number.NEGATIVE_INFINITY;
            return rb - ra;
          }
          case 'duration-short':
            return a.durationDays - b.durationDays;
          case 'duration-long':
            return b.durationDays - a.durationDays;
          default:
            return 0;
        }
      });
    }
    return rows;
  }, [offers.data, activeSide, activeSort, activeAssetFilter]);

  // Only ROW-REMOVING controls count (sort can never empty a list),
  // and the filter-empty copy may only ever appear when the unfiltered
  // book actually has rows — a truly empty market must say so even
  // with filters set (empty-state honesty rule).
  const filtersActive = activeSide !== 'all' || activeAssetFilter !== '';
  const marketHasRows = Array.isArray(offers.data) && offers.data.length > 0;

  return (
    <div>
      <h1 className="page-title">{copy.offers.title}</h1>
      <p className="page-lede">{copy.offers.lede}</p>

      {isAdvanced ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="cluster" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="book-side">Show</label>
              <select
                id="book-side"
                className="input"
                value={side}
                onChange={(e) => setSide(e.target.value as SideFilter)}
              >
                <option value="all">Everything</option>
                <option value="lending">Lending offers (borrow from these)</option>
                <option value="borrowing">Borrow requests (lend to these)</option>
                <option value="rentals">NFT rentals</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="book-sort">Sort by</label>
              <select
                id="book-sort"
                className="input"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <option value="newest">Newest first</option>
                <option value="rate-low">Rate — low to high</option>
                <option value="rate-high">Rate — high to low</option>
                <option value="duration-short">Duration — shortest first</option>
                <option value="duration-long">Duration — longest first</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
              <label htmlFor="book-asset">Filter by asset address</label>
              <input
                id="book-asset"
                className="input"
                placeholder="0x… (any leg: principal, collateral, payment)"
                value={assetFilter}
                onChange={(e) => setAssetFilter(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
        </div>
      ) : null}

      {offers.isLoading ? (
        <EmptyState icon={LoaderCircle} title="Loading the offer book…" />
      ) : visible === null || visible === undefined ? (
        <UnavailableState body={copy.offers.unavailable} />
      ) : visible.length === 0 ? (
        filtersActive && marketHasRows ? (
          // The MARKET isn't empty — the filters matched nothing.
          <EmptyState
            icon={BookOpen}
            title="No offers match these filters"
            body="Loosen the filters above — the offer book itself has open offers."
            action={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSide('all');
                  setSort('newest');
                  setAssetFilter('');
                }}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={BookOpen}
            title={copy.offers.emptyTitle}
            body={copy.offers.emptyBody}
            action={
              <Link to="/" className="btn btn-primary">
                Create an offer
              </Link>
            }
          />
        )
      ) : (
        <>
          <div className="row-list">
            {visible.map((o) => (
              <OfferRow key={o.offerId} offer={o} />
            ))}
          </div>
          <p className="muted" style={{ marginTop: 16 }}>
            “Use this offer” takes you through the same review-and-sign steps
            as the guided <Link to="/borrow">Borrow</Link> and{' '}
            <Link to="/lend">Lend</Link> flows.
          </p>
        </>
      )}
    </div>
  );
}
