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
import { useClaimPayoutText } from '../data/useClaimPayout';
import { useInteractionRewards } from '../data/rewards';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { ClaimAllCard } from '../components/ClaimAllCard';
import { AssetType } from '../lib/types';
import { formatTokenAmount } from '../lib/format';
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
      <section className="card" style={{ marginBottom: 16 }} data-testid="rewards-card">
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
    <section className="card" style={{ marginBottom: 16 }} data-testid="rewards-card">
      <div className="card-title">
        <Sparkles aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.rewards.title}</h2>
      </div>
      {snapshot.pending > 0n ? (
        <>
          <p>
            {copy.rewards.readyToClaim(formatTokenAmount(snapshot.pending, 18))}{' '}
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
  const isRental = loan.assetType !== AssetType.ERC20;
  const { what, why, note } = useClaimPayoutText(loan);

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">{what}</span>
        <br />
        <span className="row-sub">
          {isRental ? copy.claims.row.rental : copy.claims.row.loan} #{loan.loanId} · {why}
        </span>
        {note ? (
          <>
            <br />
            <span className="row-sub">{note}</span>
          </>
        ) : null}
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
