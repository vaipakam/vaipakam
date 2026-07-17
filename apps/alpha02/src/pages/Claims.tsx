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
import { useMyClaimables, type ClaimableLoan } from '../data/claimables';
import { useInteractionRewards } from '../data/rewards';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { ClaimAllCard } from '../components/ClaimAllCard';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';
import { captureTxError } from '../lib/errors';
import { WindowedRowList } from '../lib/visibleWindow';

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
          {copy.rewards.unavailable}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: 12 }}
          onClick={() => void rewards.refetch()}
        >
          {copy.common.tryAgain}
        </button>
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
      setError(captureTxError(err));
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
            {busy ? copy.common.waitingForWallet : copy.rewards.claim}
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

function ClaimRow({ loan }: { loan: ClaimableLoan }) {
  // Rentals have an NFT principal leg and often no collateral — never
  // format them through the ERC-20 loan template.
  const isRental = loan.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(isRental ? undefined : loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan.collateralAsset);
  // UX-002 — getClaimable told us the exact asset + amount this claim
  // pays out; show the NUMBER on the money-collection screen instead
  // of "+ interest" or a description of a field. Two extra payout
  // lanes ride the same claim transaction (Codex #1156 r1):
  //   - lifRebate is always VPFI (18 dec) → shown numerically;
  //   - heldForLender ACCUMULATES potentially mixed assets on-chain
  //     (each park carries its own asset), so no single denomination
  //     is honest → shown qualitatively, never as a number.
  const claimAssetMeta = useTokenMeta(loan.claim.asset ?? undefined);
  const baseAmountStr =
    loan.claim.amount > 0n && claimAssetMeta.data
      ? `${formatTokenAmount(loan.claim.amount, claimAssetMeta.data.decimals)} ${claimAssetMeta.data.symbol}`
      : null;
  const rebateStr =
    loan.claim.lifRebate > 0n
      ? `${formatTokenAmount(loan.claim.lifRebate, 18)} VPFI rebate`
      : null;
  const hasHeld = loan.role === 'lender' && loan.claim.heldForLender > 0n;
  const heldSuffix = hasHeld ? ' + held proceeds' : '';
  // Per-branch composition below (Codex #1156 r2): a blended string
  // can't distinguish "this number IS the collateral leg" from "this
  // is only a VPFI rebate", and a held-only lane must still surface.
  const defaulted = loan.status === 'defaulted' || loan.status === 'liquidated';
  // Claimable proper-close group: repaid or internal_matched. NOT
  // `settled` — ClaimFacet rejects Settled on both claim paths (claims
  // already consumed), and the claimables hook filters those out.
  const properClose =
    loan.status === 'repaid' || loan.status === 'internal_matched';

  const collateralStr = collateralMeta.data
    ? `${formatTokenAmount(loan.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol}`
    : 'collateral';

  let what: string;
  let why: string;
  if (isRental) {
    const nft = `NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`;
    if (loan.role === 'lender') {
      // getClaimable's amount is the fee payout (in the prepay asset)
      // when fungible fees are due — show the number (Codex #1156 r2).
      what = baseAmountStr
        ? `${baseAmountStr} fees + your ${nft} back`
        : `Rental fees + your ${nft} back`;
      why = copy.claims.row.whyRentalEnded;
    } else {
      what = baseAmountStr
        ? `${baseAmountStr} buffer back`
        : copy.claims.row.prepaidBufferBack;
      why = copy.claims.row.whyRentalClosed;
    }
  } else if (loan.role === 'lender') {
    if (properClose) {
      what = baseAmountStr
        ? `${baseAmountStr}${heldSuffix}`
        : hasHeld
          ? copy.claims.row.heldProceeds
          : principalMeta.data
            ? `${formatTokenAmount(loan.principal, principalMeta.data.decimals)} ${principalMeta.data.symbol} + interest`
            : copy.claims.row.repaidFunds;
      why =
        loan.status === 'repaid'
          ? copy.claims.row.whyRepaidLender
          : copy.claims.row.whyInternalMatchLender;
    } else if (loan.status === 'fallback_pending') {
      what = `${collateralStr} collateral`;
      why = copy.claims.row.whyFallbackPending;
    } else {
      // Liquid-collateral defaults settle by swap (proceeds in the
      // loan asset); in-kind paths hand over the collateral itself.
      // getClaimable names the exact asset + amount, so show it; only
      // when the read gave no fungible amount (pure in-kind transfer)
      // fall back to a plain-language title.
      what = baseAmountStr
        ? `${baseAmountStr}${heldSuffix} recovered from the default`
        : hasHeld
          ? copy.claims.row.heldProceedsDefault
          : `Default recovery — ${collateralStr}`;
      why = copy.claims.row.whyDefaultLender;
    }
  } else if (defaulted) {
    // After a liquidation only a residue (if any) is claimable — never
    // promise the full original collateral, and never say "you repaid".
    what = baseAmountStr
      ? `${baseAmountStr}${rebateStr ? ` + ${rebateStr}` : ''}`
      : (rebateStr ?? copy.claims.row.surplusAfterLiquidation);
    why = copy.claims.row.whyDefaultBorrower;
  } else if (loan.status === 'internal_matched') {
    // An internal match leaves the borrower a residual and/or VPFI
    // rebate at most — never promise the full collateral back.
    what = baseAmountStr
      ? `${baseAmountStr}${rebateStr ? ` + ${rebateStr}` : ''}`
      : (rebateStr ?? copy.claims.row.residualAfterMatch);
    why = copy.claims.row.whyInternalMatchBorrower;
  } else {
    what = baseAmountStr
      ? `${baseAmountStr} collateral back${rebateStr ? ` + ${rebateStr}` : ''}`
      : (rebateStr ?? `${collateralStr} collateral back`);
    why = copy.claims.row.whyRepaidBorrower;
  }

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">{what}</span>
        <br />
        <span className="row-sub">
          {isRental ? copy.claims.row.rental : copy.claims.row.loan} #{loan.loanId} · {why}
        </span>
      </span>
      <span className="btn btn-primary btn-sm">{copy.claims.claim}</span>
    </Link>
  );
}

export function Claims() {
  const { isConnected, address, readChain } = useActiveChain();
  const { setOpen } = useModal();
  // On-chain-authoritative (issue #921 item 7 / #958): the hook confirms
  // each candidate loan via `getClaimable`, so a lender's
  // `fallback_pending` loan surfaces without a client-side merge, and a
  // sold/settled position never shows a phantom claim. `undefined` =
  // loading, `null` = unavailable (never a confident partial list).
  const claimables = useMyClaimables();
  const rowsLoading = claimables.isLoading || claimables.data === undefined;
  const rowsUnavailable = claimables.data === null;
  const rows: ClaimableLoan[] =
    rowsLoading || rowsUnavailable ? [] : claimables.data!;

  // Pending interaction rewards still count as "something to claim":
  // with zero loan rows but a pending reward, RewardsCard is showing a
  // real payout, so the "Nothing to claim" empty state would be false.
  // (Free vault VPFI is deliberately NOT counted here: it is surfaced on
  // this page only WITHIN a Claim-All batch of ≥2 payouts — a solo
  // vault balance is withdrawn on /vpfi, so suppressing the empty state
  // for it would leave a dead screen with nothing actionable, Codex
  // #1291 r2.) The hook dedupes with RewardsCard's read (same key).
  const rewards = useInteractionRewards();
  const hasOtherClaimable = (rewards.data?.pending ?? 0n) > 0n;

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
          {/* #1268 / E-10 — one-signature Claim-All over the settled,
              confirmed claimables (+ rewards + free vault VPFI). Only
              once the claimables list is settled, so the batch never
              advertises a partial loan set that's still loading. */}
          {!rowsLoading && !rowsUnavailable ? (
            <ClaimAllCard loans={rows} />
          ) : null}
          {rowsLoading ? (
            <EmptyState icon={LoaderCircle} title={copy.claims.checking} />
          ) : rowsUnavailable ? (
            <UnavailableState body={copy.claims.unavailable} onRetry={() => void claimables.refetch()} />
          ) : rows.length === 0 ? (
            // No loan claims. If a reward / vault-VPFI payout is showing
            // above, the cards already say what's claimable — a "Nothing
            // to claim" panel here would be false (Codex #1291 r1).
            hasOtherClaimable ? null : (
              // UX-023 — say where claims come from and point forward.
              <EmptyState
                icon={Gift}
                title={copy.claims.empty}
                body={copy.claims.emptyBody}
                action={
                  <Link to="/positions" className="btn btn-secondary">
                    {copy.claims.emptyCta}
                  </Link>
                }
              />
            )
          ) : (
            // #1247 PAG-003 — a long-lived wallet's terminal history
            // only ever grows; render it a page at a time.
            <WindowedRowList
              rows={rows}
              resetKey={`${readChain.chainId}|${address?.toLowerCase() ?? ''}`}
              render={(loan) => (
                <ClaimRow key={`${loan.loanId}-${loan.role}`} loan={loan} />
              )}
            />
          )}
        </>
      )}
    </div>
  );
}
