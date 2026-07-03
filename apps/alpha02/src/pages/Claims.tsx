/**
 * Claim Center — everything ready to collect, each row saying what
 * will be received and why (Journey C1). Claims deep-link to the loan
 * detail page, which owns the actual claim action.
 */
import { useState } from 'react';
import { Gift, LoaderCircle, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useMyClaimables, useMyLoans } from '../data/hooks';
import { useInteractionRewards } from '../data/rewards';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
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
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  // claimInteractionRewards has NO on-chain sanctions screen (unlike the
  // Tier-1 entry points), so this UI gate is load-bearing: a flagged
  // wallet must not be handed a working payout button.
  const sanctions = useSanctionsCheck();
  const sanctionsClear = sanctions.ready && !sanctions.flagged;
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = rewards.data;
  // Transport failure ≠ "no rewards" — say we couldn't check rather
  // than silently hiding possibly-claimable VPFI (the hook maps a
  // genuinely absent rewards facet to a quiet zero snapshot instead).
  if (!snapshot && rewards.isError) {
    return (
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">
          <Sparkles aria-hidden />
          <h2 style={{ margin: 0 }}>{copy.rewards.title}</h2>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          We couldn’t check your rewards right now — please try again in a
          moment.
        </p>
      </section>
    );
  }
  if (!snapshot) return null;

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      // The button gate is a CACHED read, and this is the one payout
      // with NO on-chain screen — the live re-read here is the last
      // line of enforcement, so it fails CLOSED: an unreadable oracle
      // blocks the claim instead of waving it through. (Everywhere
      // else fail-open is fine because the contract screens too.)
      if (!address || !walletChain || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
        { failClosed: true },
      );
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
            disabled={busy || !onSupportedChain || !sanctionsClear}
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
    } else if (loan.status === 'fallback_pending') {
      what = `${collateralStr} collateral`;
      why =
        'An automatic liquidation didn’t complete — claiming finalizes the recovery yourself.';
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
  // The indexer's /claimables endpoint lists only terminal statuses —
  // a lender's fallback_pending loan is ALSO claimable (ClaimFacet
  // runs the claim-time fallback resolution), so merge those in from
  // the wallet's loan list. Either source failing → unavailable; a
  // list missing a live claim is exactly the partial-as-complete
  // dishonesty the null contract exists to prevent.
  const loans = useMyLoans();
  const rowsLoading =
    claimables.isLoading ||
    claimables.data === undefined ||
    loans.isLoading ||
    loans.data === undefined;
  const rowsUnavailable =
    claimables.data === null || loans.data === null;
  const rows: PositionLoan[] =
    rowsLoading || rowsUnavailable
      ? []
      : [
          ...claimables.data!,
          ...loans
            .data!.filter(
              (l) => l.role === 'lender' && l.status === 'fallback_pending',
            )
            .filter(
              (l) =>
                !claimables.data!.some(
                  (c) => c.loanId === l.loanId && c.role === 'lender',
                ),
            ),
        ];

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
          {rowsLoading ? (
            <EmptyState icon={LoaderCircle} title="Checking for claims…" />
          ) : rowsUnavailable ? (
            <UnavailableState body={copy.claims.unavailable} />
          ) : rows.length === 0 ? (
            <EmptyState icon={Gift} title={copy.claims.empty} />
          ) : (
            <div className="row-list">
              {rows.map((loan) => (
                <ClaimRow key={`${loan.loanId}-${loan.role}`} loan={loan} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
