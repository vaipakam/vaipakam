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
import { PowerSurfaceNote } from '../components/PowerSurfaceNote';
import { AddressName } from '../components/AddressName';
import { SelectMenu } from '../components/SelectMenu';
import { useActiveOffers } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { MarketFreshnessNote } from '../components/MarketFreshnessNote';
import { useTokenMeta } from '../contracts/erc20';
import {
  OfferRiskBadge,
  offerRiskLevel,
  offerScreenableLegs,
  type OfferRiskLevel as RiskLevel,
} from '../components/TokenRiskBadge';
import { useBookTokenSecurity } from '../data/tokenSecurity';
import { ShowMoreButton, useVisibleWindow } from '../lib/visibleWindow';
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

function OfferRow({ offer, risk }: { offer: IndexedOffer; risk: RiskLevel | null }) {
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
    // Partially-filled offers are matcher-only — direct acceptOffer
    // reverts OfferPartiallyFilled, so never offer the button.
    BigInt(offer.amountFilled || '0') === 0n &&
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
      } · ${formatDurationDays(offer.durationDays)} · fees prepaid`
    : `${formatBpsAsPercent(
        isLending ? offer.interestRateBps : offer.interestRateBpsMax,
      )} yearly · ${formatDurationDays(offer.durationDays)} · collateral ${
        hasCollateral
          ? (collateralMeta.data?.symbol ?? shortAddress(offer.collateralAsset))
          : 'none'
      }`;

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
        <span className="row-title">
          {title} <OfferRiskBadge level={risk} />
        </span>
        <br />
        <span className="row-sub">
          {sub} · by <AddressName address={offer.creator} />
        </span>
        {isAdvanced && advancedBits.length > 0 ? (
          <>
            <br />
            <span className="row-sub muted">{advancedBits.join(' · ')}</span>
          </>
        ) : null}
      </span>
      {acceptable ? (
        <Link to={acceptHref} className="btn btn-primary btn-sm">
          {/* UX-018 — role-specific CTA: "Use this offer" hid the money
              direction. Taking a LENDER offer makes you the borrower;
              taking a BORROW request makes you the lender. A sale
              vehicle is a borrower-STYLE row (offerType 1) but accepting
              it BUYS a running lender position, not funds a new borrow —
              so it must not read "Fund this request" (Codex #1175 r1). */}
          {isRentalListing
            ? 'Rent this NFT'
            : offer.isSaleVehicle
              ? 'Buy this loan position'
              : isLending
                ? 'Borrow this'
                : 'Fund this request'}
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
  const { readChain } = useActiveChain();

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

  // #1247 PAG-002 — the render window. The filtered/sorted array can
  // hold up to the 500-row data cap; rows (and their per-row reads)
  // render a page at a time. The window collapses when any
  // row-removing/reordering control changes — a deep window over a
  // DIFFERENT list must not persist.
  const bookWindow = useVisibleWindow(
    Array.isArray(visible) ? visible : [],
    // Chain identity too (Codex #1265 r2): a network switch with the
    // same filters must collapse the window over the NEW book.
    `${readChain.chainId}|${activeSide}|${activeSort}|${activeAssetFilter}`,
  );

  // #1036 badges: one batched screen for every distinct non-curated
  // leg on the visible WINDOW (rows keep their own chainId) — the
  // screen set grows with Show-more, in step with the rows it badges
  // (#1247 PAG-002). Browse tier is early-warning only — rows are
  // never hidden here, the book must not lie about what the market
  // holds; the accept gate downstream is the enforcement point.
  const screenLegs = useMemo(
    () => bookWindow.shown.flatMap(offerScreenableLegs),
    [bookWindow.shown],
  );
  const verdicts = useBookTokenSecurity(screenLegs);

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

      {/* UX-026 — orient Basic-mode visitors landing here by URL. */}
      <PowerSurfaceNote />

      <MarketFreshnessNote />

      {isAdvanced ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="cluster" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="book-side">Show</label>
              <SelectMenu
                id="book-side"
                value={side}
                onChange={(next) => setSide(next as SideFilter)}
                options={[
                  { value: 'all', label: 'Everything' },
                  { value: 'lending', label: 'Lending offers (borrow from these)' },
                  { value: 'borrowing', label: 'Borrow requests (lend to these)' },
                  { value: 'rentals', label: 'NFT rentals' },
                ]}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="book-sort">Sort by</label>
              <SelectMenu
                id="book-sort"
                value={sort}
                onChange={(next) => setSort(next as SortKey)}
                options={[
                  { value: 'newest', label: 'Newest first' },
                  { value: 'rate-low', label: 'Rate — low to high' },
                  { value: 'rate-high', label: 'Rate — high to low' },
                  { value: 'duration-short', label: 'Duration — shortest first' },
                  { value: 'duration-long', label: 'Duration — longest first' },
                ]}
              />
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
            {bookWindow.shown.map((o) => (
              <OfferRow
                key={o.offerId}
                offer={o}
                risk={offerRiskLevel(o, verdicts)}
              />
            ))}
          </div>
          <ShowMoreButton
            hasMore={bookWindow.hasMore}
            hiddenCount={bookWindow.hiddenCount}
            nextCount={bookWindow.nextCount}
            onClick={bookWindow.loadMore}
          />
          <p className="muted" style={{ marginTop: 16 }}>
            {/* Copy follows the role-specific card CTAs (Codex #1175 r2)
                — the button no longer reads "Use this offer". */}
            Taking an offer here — “Borrow this”, “Fund this request”, or “Buy
            this loan position” — walks you through the same review-and-sign
            steps as the guided <Link to="/borrow">Borrow</Link> and{' '}
            <Link to="/lend">Lend</Link> flows.
          </p>
        </>
      )}
    </div>
  );
}
