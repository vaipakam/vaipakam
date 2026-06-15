import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { useTokenMeta } from '../../lib/tokenMeta';
import { TokenAmount } from '../app/TokenAmount';
import { AddressDisplay } from '../app/AddressDisplay';
import { type Encumbrance } from '../../types/encumbrance';
import { AssetType } from '../../types/loan';

/** Canonical EVM zero address — a `getLoanCollateralLien` default
 *  (never-encumbered) record carries `user == address(0)`. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface Props {
  /** The loan's collateral lien, read from
   *  `MetricsFacet.getLoanCollateralLien`. */
  lien: Encumbrance | null | undefined;
  /** Block-explorer base URL for the active chain (no trailing slash) —
   *  used to deep-link the locked-balance owner as the lender's on-chain
   *  proof anchor. */
  blockExplorer: string;
  /** Viewer's relationship to the loan. Drives the role-specific copy:
   *  `'lender'` emphasises provability + an explorer link; `'borrower'`
   *  surfaces the lock-until-terminal warning. `undefined` (non-party)
   *  renders the neutral lien facts only. */
  role?: 'lender' | 'borrower';
}

/**
 * #564 D.1 — "Collateral backing this loan" card.
 *
 * Renders the on-chain collateral lien so each party can see the deposit
 * is provably encumbered for the life of the loan. Mirrors the existing
 * loan-detail `.card` markup (title + `.data-row` pairs).
 *
 * Renders NOTHING when there is no live lien. `getLoanCollateralLien`
 * returns a DEFAULT zero `Encumbrance` (`user == address(0)`, `amount == 0`)
 * for loans that never had a collateral lien (e.g. NFT-rental loans), so we
 * treat ANY non-positive-amount or zero-`user` record as "no lien" rather
 * than rendering a bogus card. Only a positive-amount lien with a real
 * vault owner renders.
 */
export function CollateralLienCard({ lien, blockExplorer, role }: Props) {
  const { t } = useTranslation();
  // Hook order must be stable — resolve token meta before any early return.
  const meta = useTokenMeta(lien?.asset ?? null);

  // No lien to show: missing record, zero amount (includes the default
  // never-encumbered record), or a default record whose `user` is the
  // zero address. Any of these means there's nothing real to surface.
  if (!lien) return null;
  if (lien.amount === 0n) return null;
  if (!lien.user || lien.user.toLowerCase() === ZERO_ADDRESS) return null;

  // ERC-721 / ERC-1155 lien amounts are token COUNTS, not 18-dec wei.
  const isNft =
    lien.assetType === AssetType.ERC721 || lien.assetType === AssetType.ERC1155;
  const isActive = !lien.released && lien.amount > 0n;
  const symbol = meta?.symbol ?? '';

  return (
    <div className="card">
      <div className="card-title">
        🔒 {t('loanDetails.lien.title')}
      </div>

      <div className="data-row">
        <span className="data-label">{t('loanDetails.lien.asset')}</span>
        <span className="data-value mono">
          {symbol ? `${symbol} (${lien.asset})` : lien.asset}
        </span>
      </div>

      <div className="data-row">
        <span className="data-label">{t('loanDetails.lien.amount')}</span>
        <span className="data-value mono">
          {isNft ? (
            // ERC-721 (count 1) / ERC-1155 (quantity) — render the raw
            // count, never via <TokenAmount> (which applies 18 decimals
            // and would show `0.000…001` for a 1-NFT lien).
            <>
              {lien.amount.toString()}{' '}
              {t('loanDetails.lien.tokenCountSuffix', {
                count: Number(lien.amount),
              })}
              {/* Surface the tokenId for the single-NFT (ERC-721) case
                  so the lien names the exact pledged NFT. */}
              {lien.assetType === AssetType.ERC721 && (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {' '}#{lien.tokenId.toString()}
                </span>
              )}
            </>
          ) : (
            <TokenAmount amount={lien.amount} address={lien.asset} />
          )}
        </span>
      </div>

      <div className="data-row">
        <span className="data-label">{t('loanDetails.lien.status')}</span>
        <span
          className="data-value"
          style={{ color: isActive ? 'var(--brand)' : 'var(--text-tertiary)' }}
        >
          {isActive
            ? t('loanDetails.lien.statusActive')
            : t('loanDetails.lien.statusReleased')}
        </span>
      </div>

      <div className="data-row">
        <span className="data-label">{t('loanDetails.lien.lockedIn')}</span>
        <span
          className="data-value"
          style={{ color: 'var(--brand)', fontSize: '0.82rem' }}
        >
          <AddressDisplay address={lien.user} withTooltip copyable />
        </span>
      </div>

      {/* Role-specific footer copy. Lender: provability emphasis + an
          explorer deep-link to the locked-balance owner as the on-chain
          proof anchor. Borrower: the lock-until-terminal warning. */}
      {role === 'lender' && (
        <p
          className="lien-note"
          style={{
            marginTop: 10,
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
          }}
        >
          {t('loanDetails.lien.lenderNote')}{' '}
          <a
            href={`${blockExplorer}/address/${lien.user}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--brand)' }}
          >
            {t('loanDetails.lien.verifyOnChain')} <ExternalLink size={12} />
          </a>
        </p>
      )}

      {role === 'borrower' && (
        <p
          className="lien-note"
          style={{
            marginTop: 10,
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
          }}
        >
          {t('loanDetails.lien.borrowerNote')}
        </p>
      )}
    </div>
  );
}
