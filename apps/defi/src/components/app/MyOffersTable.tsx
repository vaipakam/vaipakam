import { useTranslation } from 'react-i18next';
import { L as Link } from '../L';
import { bpsToPercent } from '../../lib/format';
import {
  ASSET_TYPE_LABELS,
  OFFER_TYPE_LABELS,
} from '../../pages/OfferBook';
import type { MyOfferRow } from '../../hooks/useMyOffers';
import { CardInfo } from '../CardInfo';
import { HoverTip } from '../HoverTip';
import { Pager } from './Pager';
import { PrincipalCell } from './PrincipalCell';
import { TimeChip } from '../TimeChip';

// #241 — cancel cooldown: 5 min from createdAt while partialFillEnabled
// is on AND no partial fill has landed yet. Mirrors the contract-side
// `MIN_OFFER_CANCEL_DELAY` constant in `LibVaipakam.sol`. Surfaced as
// a button-disabling gate + a TimeChip on the row so the user sees
// exactly when they'll be able to cancel instead of hitting a revert.
const CANCEL_COOLDOWN_SECONDS = 5 * 60;

interface Props {
  /** Status-tagged rows from `useMyOffers`. Already sorted newest-id-first. */
  rows: MyOfferRow[];
  /** Submit-side handler the Active row's Cancel button calls.
   *  Receives the offer id. The handler is responsible for confirming,
   *  signing, and refreshing on success. */
  onCancel: (offerId: bigint) => void;
  /** Set of offer ids whose `cancelOffer` tx is currently submitting.
   *  Disables the Cancel button so the user can't double-click. */
  cancellingId: bigint | null;
  /** #241 — `ProtocolConfig.partialFillEnabled`. When true, the
   *  contract's 5-min cancel cooldown is in effect for offers whose
   *  `amountFilled == 0`; the table disables Cancel for those rows
   *  and renders a TimeChip "Cancellable in N" countdown. When false
   *  (default on deployed chains today), no gating — Cancel is always
   *  enabled and the chip is suppressed. */
  partialFillEnabled: boolean;
  /** Chain id this table's offers live on. Threaded through to
   *  `<PrincipalCell>` so each row's "open externally" link routes to
   *  CoinGecko / OpenSea / explorer / Vaipakam-verifier as appropriate
   *  for the row's asset and the connected chain. */
  chainId: number;
  /** Title rendered in the card header. */
  title: string;
  /** Subtitle rendered next to the title. */
  subtitle: string;
  /** Optional registry id for the (i) info-tip next to the title. */
  cardHelpId?: string;
  /** Optional element rendered on the right of the card header. */
  headerAction?: React.ReactNode;
  /** Optional pagination props. When all three are supplied, the
   *  table slices `rows` to the current page and renders a `<Pager>`
   *  in the card footer. When omitted (legacy callers), the full
   *  list is rendered without paging. */
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}

/**
 * Tabled view of the connected wallet's offers, status-aware. Used on
 * the Dashboard's "Your Offers" card.
 *
 * Differs from the public `<OfferTable>` in three ways:
 *
 *   1. **Status discriminator.** Each row carries `status`
 *      (`active | filled | cancelled`). Rendering branches on it —
 *      filled rows get a `Loan #N` link, cancelled rows render compact
 *      (most cells `—`) because the on-chain data is gone after
 *      `cancelOffer` deletes the storage slot.
 *   2. **Cancel button.** Active rows get a Cancel control alongside
 *      "Manage keepers" — currently the only way for a user to cancel
 *      an offer from the website (the function existed on-chain but
 *      had no UI before this change).
 *   3. **Principal column.** Asset + Amount merged into a single
 *      `<PrincipalCell>` so the row reads consistently with Your Loans.
 *
 * Public `<OfferTable>` keeps its split Asset / Amount columns until a
 * separate migration brings it onto `<PrincipalCell>` too — see the
 * "Your Offers" release notes for the staged-rollout rationale.
 */
export function MyOffersTable({
  rows,
  onCancel,
  cancellingId,
  partialFillEnabled,
  chainId,
  title,
  subtitle,
  cardHelpId,
  headerAction,
  page,
  pageSize,
  onPageChange,
}: Props) {
  const { t } = useTranslation();
  // Pagination is opt-in: when all three props are present, slice;
  // otherwise render the full list (legacy behaviour).
  const paginated =
    typeof page === 'number' &&
    typeof pageSize === 'number' &&
    typeof onPageChange === 'function';
  const visibleRows = paginated
    ? rows.slice(page * pageSize, (page + 1) * pageSize)
    : rows;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div
        className="card-title"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {title}
          {cardHelpId && <CardInfo id={cardHelpId} />}
        </span>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{subtitle}</span>
          {headerAction}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 8 }}>
          {t('myOffersTable.empty')}
        </div>
      ) : (
        <div className="loans-table-wrap">
          <table className="loans-table">
            <thead>
              <tr>
                <th>{t('offerTable.colId')}</th>
                <th>{t('offerTable.colType')}</th>
                <th>{t('offerTable.colPrincipal')}</th>
                <th>{t('offerTable.colRate')}</th>
                <th>{t('offerTable.colDuration')}</th>
                <th>{t('offerTable.colCollateral')}</th>
                <th>{t('myOffersTable.colStatus')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const offer = row.offer;
                if (row.status === 'cancelled') {
                  // Three-state cancelled rendering driven by data
                  // availability — see `useMyOffers` for hydrate
                  // priority (event > snapshot > stub). When we have
                  // a full offer payload (the new
                  // `OfferCanceledDetails` event OR a same-browser
                  // localStorage snapshot survived), render every
                  // column normally with a dimmed look. When all we
                  // have is the identity stub (zero `lendingAsset`),
                  // fall back to compact rendering with `—` cells.
                  const ZERO_ADDR =
                    '0x0000000000000000000000000000000000000000';
                  const hasFullData =
                    offer.lendingAsset.toLowerCase() !== ZERO_ADDR;
                  if (!hasFullData) {
                    return (
                      <tr
                        key={offer.id.toString()}
                        style={{ opacity: 0.7 }}
                      >
                        <td><Link to={`/app/offers/${offer.id.toString()}`}>#{offer.id.toString()}</Link></td>
                        <td>
                          <span
                            className={`status-badge ${
                              offer.offerType === 0 ? 'lender' : 'borrower'
                            }`}
                          >
                            {OFFER_TYPE_LABELS[offer.offerType]}
                          </span>
                        </td>
                        <td>—</td>
                        <td>—</td>
                        <td>—</td>
                        <td>—</td>
                        <td>
                          <HoverTip text={t('myOffersTable.cancelledTooltip')}>
                            <span
                              className="status-badge"
                              style={{
                                background: 'var(--surface-2)',
                                color: 'var(--muted)',
                              }}
                            >
                              {t('myOffersTable.statusCancelled')}
                            </span>
                          </HoverTip>
                        </td>
                        <td></td>
                      </tr>
                    );
                  }
                  // Full-data cancelled row: same shape as active rows,
                  // but dimmed and with a Cancelled pill instead of
                  // active/filled status.
                  return (
                    <tr
                      key={offer.id.toString()}
                      style={{ opacity: 0.65 }}
                    >
                      <td><Link to={`/app/offers/${offer.id.toString()}`}>#{offer.id.toString()}</Link></td>
                      <td>
                        <span
                          className={`status-badge ${
                            offer.offerType === 0 ? 'lender' : 'borrower'
                          }`}
                        >
                          {OFFER_TYPE_LABELS[offer.offerType]}
                        </span>
                      </td>
                      <td>
                        <PrincipalCell
                          assetType={offer.assetType}
                          asset={offer.lendingAsset}
                          amount={offer.amount}
                          tokenId={offer.tokenId}
                          chainId={chainId}
                        />
                      </td>
                      <td>{bpsToPercent(offer.interestRateBps)}</td>
                      <td>
                        {offer.durationDays.toString()}{' '}
                        {t('loanDetails.daysSuffix')}
                      </td>
                      <td>
                        <PrincipalCell
                          assetType={0}
                          asset={offer.collateralAsset}
                          amount={offer.collateralAmount}
                          chainId={chainId}
                        />
                      </td>
                      <td>
                        <span
                          className="status-badge"
                          style={{
                            background: 'var(--surface-2)',
                            color: 'var(--muted)',
                          }}
                        >
                          {t('myOffersTable.statusCancelled')}
                        </span>
                      </td>
                      <td></td>
                    </tr>
                  );
                }

                // Active or filled — full row.
                const isActive = row.status === 'active';
                const isFilled = row.status === 'filled';

                // #241 — time-driven UI state.
                //
                // Cooldown gate (Cancel disabled + chip showing "Cancellable in N"):
                //   Mirrors the contract's `MIN_OFFER_CANCEL_DELAY`
                //   branch in `OfferCancelFacet.cancelOffer` — fires
                //   ONLY when partialFillEnabled is on AND the offer
                //   has zero accumulated fills AND we're inside the
                //   5-min window from createdAt. Without all three the
                //   contract doesn't revert, so the UI doesn't gate.
                //   `offer.createdAt` is uint64 unix-seconds (#164's
                //   storage stamp); `offer.amountFilled` is bigint.
                const createdAtNum = Number(offer.createdAt ?? 0n);
                const cooldownEndsSec =
                  createdAtNum + CANCEL_COOLDOWN_SECONDS;
                const cooldownActive =
                  isActive &&
                  partialFillEnabled &&
                  (offer.amountFilled ?? 0n) === 0n &&
                  createdAtNum > 0 &&
                  Math.floor(Date.now() / 1000) < cooldownEndsSec;
                // GTT expiry chip (#195):
                //   `expiresAt = 0` is the GTC sentinel — no chip.
                //   Non-zero = "expires in N" (live) or "expired N ago
                //   — anyone can clean up" (lapsed). Both states get
                //   the chip; the lapsed-state copy tells the user
                //   their Cancel is also reachable to anyone (the
                //   permissionless-clear path).
                const expiresAtSec = Number(offer.expiresAt ?? 0n);
                const showExpiryChip = isActive && expiresAtSec > 0;

                return (
                  <tr key={offer.id.toString()}>
                    <td><Link to={`/app/offers/${offer.id.toString()}`}>#{offer.id.toString()}</Link></td>
                    <td>
                      <span
                        className={`status-badge ${
                          offer.offerType === 0 ? 'lender' : 'borrower'
                        }`}
                      >
                        {OFFER_TYPE_LABELS[offer.offerType]}
                      </span>
                    </td>
                    <td>
                      <PrincipalCell
                        assetType={offer.assetType}
                        asset={offer.lendingAsset}
                        amount={offer.amount}
                        tokenId={offer.tokenId}
                        chainId={chainId}
                      />
                    </td>
                    <td>{bpsToPercent(offer.interestRateBps)}</td>
                    <td>
                      {offer.durationDays.toString()}{' '}
                      {t('loanDetails.daysSuffix')}
                    </td>
                    <td>
                      <PrincipalCell
                        assetType={
                          // Collateral asset type isn't stored separately
                          // on the offer; for ERC-20 lending offers the
                          // collateral matches the principal asset type
                          // category (treated as ERC-20 for display).
                          // For NFT lending offers the collateral side is
                          // typically ERC-20 too. So pass 0 (ERC-20) —
                          // a future contract change that gates collateral
                          // type independently would surface this assumption.
                          0
                        }
                        asset={offer.collateralAsset}
                        amount={offer.collateralAmount}
                        chainId={chainId}
                      />
                    </td>
                    <td>
                      {isFilled ? (
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span className="status-badge settled">
                            {t('offerTable.filled')}
                          </span>
                          {row.loanId && (
                            <Link
                              to={`/app/loans/${row.loanId}`}
                              style={{
                                fontSize: '0.78rem',
                                color: 'var(--brand)',
                              }}
                            >
                              {t('offerTable.linkedLoan', { id: row.loanId })}
                            </Link>
                          )}
                        </div>
                      ) : (
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span
                            className="status-badge"
                            style={{
                              background:
                                'rgba(16, 185, 129, 0.15)',
                              color: 'var(--accent-green)',
                            }}
                          >
                            {t('myOffersTable.statusActive')}
                          </span>
                          {/* #195/#241 — GTT expiry decoration. The
                              chip itself decides live-vs-expired copy
                              based on `Date.now()` vs `targetSec`. */}
                          {showExpiryChip && (
                            <TimeChip kind="expiry" targetSec={expiresAtSec} />
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {isActive && (
                        <div
                          style={{
                            display: 'flex',
                            gap: 6,
                            justifyContent: 'flex-end',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                          }}
                        >
                          {/* #241 — cooldown chip + button gating.
                              While the contract's 5-min cooldown
                              applies, render the countdown chip and
                              disable the button. The tooltip explains
                              the bound so the user doesn't think the
                              app is broken. */}
                          {cooldownActive && (
                            <TimeChip
                              kind="cooldown"
                              targetSec={cooldownEndsSec}
                            />
                          )}
                          {/* Per-offer keeper toggles moved to the offer
                              details page — list rows now show only the
                              cancel action so the action column scans as
                              a single button per row. */}
                          <HoverTip
                            text={
                              cooldownActive
                                ? t('myOffersTable.cancelCooldownTooltip')
                                : t('myOffersTable.cancelTooltip')
                            }
                          >
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => onCancel(offer.id)}
                              disabled={
                                cancellingId === offer.id || cooldownActive
                              }
                            >
                              {cancellingId === offer.id
                                ? t('myOffersTable.cancelling')
                                : t('myOffersTable.cancel')}
                            </button>
                          </HoverTip>
                        </div>
                      )}
                      {/* Filled row's column is empty — the loan link
                          already lives in the Status column. */}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {paginated && (
            <Pager
              total={rows.length}
              pageSize={pageSize!}
              page={page!}
              onPageChange={onPageChange!}
              unit="offer"
            />
          )}
          <div
            style={{
              fontSize: '0.7rem',
              opacity: 0.55,
              padding: '8px 4px 0',
            }}
          >
            {t('myOffersTable.assetTypeLegend', {
              kinds: ASSET_TYPE_LABELS.join(' · '),
            })}
          </div>
        </div>
      )}
    </div>
  );
}
