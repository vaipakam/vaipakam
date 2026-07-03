/**
 * The live sale listing's standing surface — rendered by the page on
 * the CHAIN's say-so (positionLock == EarlyWithdrawalSale), outside
 * the strategy-card gates, so it survives data hiccups, mode
 * switches, and being listed from another device. Cancel needs the
 * offer id (device-local marker, live-verified); without it the card
 * still shows the lock, the funding watch, and the restore action.
 *
 * Shares the PAGE's busy lock: its writes touch the same token
 * allowance the repay-family flows manage.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { submitErrorText } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance, type TokenMeta } from '../contracts/erc20';
import { readLoanLive } from '../contracts/loanLive';
import {
  LOCK_EARLY_WITHDRAWAL_SALE,
  saleSettlementBound,
  type LoanSalePendingState,
} from '../data/loanSalePending';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { formatTokenAmount } from '../lib/format';

export function LoanSalePendingCard({
  loanId,
  lenderTokenId,
  state,
  principalAsset,
  principalMeta,
  busy,
  setBusy,
  onCleared,
}: {
  loanId: number;
  /** For the restore-time lock re-check. */
  lenderTokenId: string;
  state: LoanSalePendingState;
  principalAsset: `0x${string}`;
  principalMeta: TokenMeta | undefined;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCleared: () => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);
  const underfunded = state.allowanceShort || state.balanceShort;

  async function cancelListing() {
    if (!state.offerId || !address || !walletChain || !walletClient || !publicClient) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(state.offerId)]);
      onCleared();
      void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      try {
        await revokeAllowance({
          publicClient,
          walletClient,
          token: principalAsset,
          owner: address,
          spender: walletChain.diamondAddress,
        });
        setDone(copy.loanSale.cancelled);
      } catch {
        setDone(copy.loanSale.cancelledRevokeFailed);
      }
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      // Verify the listing still stands before re-granting the
      // settlement approval — a completed/cancelled listing must not
      // get a fresh dangling authorization.
      const [lock, liveLoan, latestBlock] = await Promise.all([
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'positionLock',
          args: [BigInt(lenderTokenId)],
        }) as Promise<number | bigint>,
        readLoanLive(publicClient, walletChain.diamondAddress, loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      if (Number(lock) !== LOCK_EARLY_WITHDRAWAL_SALE) {
        setError(copy.refinance.reapproveAborted);
        void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
        return;
      }
      await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: saleSettlementBound(
          liveLoan,
          state.saleRateBps ?? liveLoan.interestRateBps,
          latestBlock.timestamp,
        ),
      });
      setDone(copy.loanSale.restored);
      void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>{copy.loanSale.title}</h3>
      <div className="banner banner-warn" role="status">
        <span className="banner-body">
          {state.offerId
            ? copy.loanSale.pending(state.offerId)
            : copy.loanSale.pendingNoId}
        </span>
      </div>
      {underfunded ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">
            {copy.loanSale.allowanceShort}{' '}
            {principalMeta
              ? `(a buyer’s acceptance would pull ~${formatTokenAmount(state.requiredNow, principalMeta.decimals)} ${principalMeta.symbol} right now)`
              : null}
          </span>
        </div>
      ) : null}
      <div className="cluster" style={{ marginTop: 12 }}>
        {state.offerId ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !walletReady}
            onClick={() => void cancelListing()}
          >
            {copy.loanSale.cancel}
          </button>
        ) : null}
        {underfunded ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !walletReady}
            onClick={() => void restore()}
          >
            {copy.loanSale.restore}
          </button>
        ) : null}
      </div>
      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
