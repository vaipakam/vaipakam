/**
 * Claim Center — everything ready to collect, each row saying what
 * will be received and why (Journey C1). Claims deep-link to the loan
 * detail page, which owns the actual claim action.
 */
import { useState } from 'react';
import { Gift, LoaderCircle, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useMyClaimables } from '../data/hooks';
import { useInteractionRewards } from '../data/rewards';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';
import { submitErrorText } from '../lib/errors';
import type { PositionLoan } from '../data/hooks';

/** Interaction-reward VPFI, kept visually separate from loan claims
 *  so the source of funds is never confused (Journey C1). */
function RewardsCard() {
  const rewards = useInteractionRewards();
  const { onSupportedChain } = useActiveChain();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = rewards.data;
  if (!snapshot) return null;

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      await write('claimInteractionRewards', []);
      void queryClient.invalidateQueries({ queryKey: ['interactionRewards'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">
        <Sparkles aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.rewards.title}</h2>
      </div>
      {snapshot.pending > 0n ? (
        <>
          <p>
            {formatTokenAmount(snapshot.pending, 18)} VPFI ready to claim.{' '}
            {copy.rewards.blurb}
          </p>
          {error ? (
            <div className="banner banner-danger" role="alert">
              <span className="banner-body">{error}</span>
            </div>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !onSupportedChain}
            onClick={() => void claim()}
          >
            {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
            {busy ? 'Waiting for wallet…' : copy.rewards.claim}
          </button>
        </>
      ) : snapshot.waiting ? (
        <p className="muted" style={{ margin: 0 }}>
          {copy.rewards.waiting}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {copy.rewards.empty}
        </p>
      )}
    </section>
  );
}

function ClaimRow({ loan }: { loan: PositionLoan }) {
  // Rentals have an NFT principal leg and often no collateral — never
  // format them through the ERC-20 loan template.
  const isRental = loan.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(isRental ? undefined : loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan.collateralAsset);
  const defaulted = loan.status === 'defaulted' || loan.status === 'liquidated';

  const collateralStr = collateralMeta.data
    ? `${formatTokenAmount(loan.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol}`
    : 'collateral';

  let what: string;
  let why: string;
  if (isRental) {
    const nft = `NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`;
    if (loan.role === 'lender') {
      what = `Rental fees + your ${nft} back`;
      why = 'The rental ended — collect your earned fees and reclaim the NFT.';
    } else {
      what = 'Your prepaid buffer back';
      why = 'The rental closed — the refundable buffer is released.';
    }
  } else if (loan.role === 'lender') {
    if (loan.status === 'repaid') {
      what = principalMeta.data
        ? `${formatTokenAmount(loan.principal, principalMeta.data.decimals)} ${principalMeta.data.symbol} + interest`
        : 'Repaid funds';
      why = 'The borrower repaid this loan.';
    } else {
      what = `${collateralStr} collateral`;
      why = 'The loan defaulted — the collateral is yours to claim.';
    }
  } else if (defaulted) {
    // After a liquidation only a residue (if any) is claimable — never
    // promise the full original collateral, and never say "you repaid".
    what = 'Anything left after liquidation';
    why = 'This loan defaulted. If the liquidation left a surplus, you can claim it.';
  } else {
    what = `${collateralStr} collateral back`;
    why = 'You repaid this loan, so your collateral is released.';
  }

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">{what}</span>
        <br />
        <span className="row-sub">
          {isRental ? 'Rental' : 'Loan'} #{loan.loanId} · {why}
        </span>
      </span>
      <span className="btn btn-primary btn-sm">{copy.claims.claim}</span>
    </Link>
  );
}

export function Claims() {
  const { isConnected } = useActiveChain();
  const { setOpen } = useModal();
  const claimables = useMyClaimables();

  return (
    <div>
      <h1 className="page-title">{copy.claims.title}</h1>
      <p className="page-lede">{copy.claims.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={Gift}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : (
        <>
          <RewardsCard />
          {claimables.isLoading || claimables.data === undefined ? (
            <EmptyState icon={LoaderCircle} title="Checking for claims…" />
          ) : claimables.data === null ? (
            <UnavailableState body={copy.claims.unavailable} />
          ) : claimables.data.length === 0 ? (
            <EmptyState icon={Gift} title={copy.claims.empty} />
          ) : (
            <div className="row-list">
              {claimables.data.map((loan) => (
                <ClaimRow key={`${loan.loanId}-${loan.role}`} loan={loan} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
