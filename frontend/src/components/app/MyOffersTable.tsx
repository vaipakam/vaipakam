import { useTranslation } from 'react-i18next';
import { L as Link } from '../L';
import { bpsToPercent } from '../../lib/format';
import {
  ASSET_TYPE_LABELS,
  OFFER_TYPE_LABELS,
} from '../../pages/OfferBook';
import type { MyOfferRow } from '../../hooks/useMyOffers';
import { CardInfo } from '../CardInfo';
import { PrincipalCell } from './PrincipalCell';

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
  /** Block-explorer base URL (no trailing slash). Threaded through to
   *  `<PrincipalCell>` for the NFT-page `<a>` icon on NFT rows. */
  blockExplorer: string;
  /** Title rendered in the card header. */
  title: string;
  /** Subtitle rendered next to the title. */
  subtitle: string;
  /** Optional registry id for the (i) info-tip next to the title. */
  cardHelpId?: string;
  /** Optional element rendered on the right of the card header. */
  headerAction?: React.ReactNode;
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
  blockExplorer,
  title,
  subtitle,
  cardHelpId,
  headerAction,
}: Props) {
  const { t } = useTranslation();

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
              {rows.map((row) => {
                const offer = row.offer;
                if (row.status === 'cancelled') {
                  // Compact identity-only row. Other cells render `—`
                  // because the on-chain storage slot was deleted at
                  // cancel time and the OfferCanceled event only carries
                  // (offerId, creator). Showing zeros where real data
                  // used to live would mislead — see useMyOffers docs
                  // for the data-availability rationale.
                  return (
                    <tr
                      key={offer.id.toString()}
                      style={{ opacity: 0.7 }}
                    >
                      <td>#{offer.id.toString()}</td>
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
                        <span
                          className="status-badge"
                          style={{
                            background: 'var(--surface-2)',
                            color: 'var(--muted)',
                          }}
                          data-tooltip={t('myOffersTable.cancelledTooltip')}
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
                return (
                  <tr key={offer.id.toString()}>
                    <td>#{offer.id.toString()}</td>
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
                        blockExplorer={blockExplorer}
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
                          <Link
                            to="/app/keepers"
                            data-tooltip={t('myOffersTable.manageKeepersTooltip')}
                            style={{
                              fontSize: '0.72rem',
                              padding: '3px 8px',
                              color: 'var(--brand)',
                            }}
                          >
                            {t('offerTable.manageKeepers')}
                          </Link>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => onCancel(offer.id)}
                            disabled={cancellingId === offer.id}
                            data-tooltip={t('myOffersTable.cancelTooltip')}
                          >
                            {cancellingId === offer.id
                              ? t('myOffersTable.cancelling')
                              : t('myOffersTable.cancel')}
                          </button>
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
