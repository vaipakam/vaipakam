/**
 * Loan detail — the command center for one position. Basic mode
 * answers the five questions at the top (role, state, what's locked,
 * what you can do now, what happens if you do nothing) and offers ONE
 * primary action for the current state:
 *   borrower + active  → Repay (allowance handled inline)
 *   borrower + repaid  → Claim collateral back
 *   lender  + repaid   → Claim principal + interest
 *   lender  + defaulted→ Claim the collateral
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, LoaderCircle, ShieldQuestion } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useLoan } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, useTokenMeta } from '../contracts/erc20';
import {
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
} from '../lib/format';
import { loanStateView } from '../lib/loanState';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { AssetType } from '../lib/types';

type Action = 'repay' | 'claim-borrower' | 'claim-lender' | null;

export function PositionDetails() {
  const { loanId: loanIdParam } = useParams();
  const loanId = Number(loanIdParam);
  const loan = useLoan(Number.isFinite(loanId) ? loanId : undefined);
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const principalMeta = useTokenMeta(loan.data?.lendingAsset);
  const collateralMeta = useTokenMeta(loan.data?.collateralAsset ?? undefined);

  const role: 'lender' | 'borrower' | 'viewer' = useMemo(() => {
    const row = loan.data;
    if (!row || !address) return 'viewer';
    if (row.borrower.toLowerCase() === address.toLowerCase()) return 'borrower';
    if (row.lender.toLowerCase() === address.toLowerCase()) return 'lender';
    return 'viewer';
  }, [loan.data, address]);

  if (loan.isLoading) {
    return <EmptyState icon={LoaderCircle} title="Loading the loan…" />;
  }
  if (!loan.data) {
    return (
      <UnavailableState body="We couldn’t find this loan right now. It may be new (still indexing) or the link may be old." />
    );
  }

  const row = loan.data;
  const view = loanStateView(row);
  const principal = principalMeta.data;
  const collateral = collateralMeta.data;
  const interest = fullTermInterest(
    BigInt(row.principal),
    row.interestRateBps,
    row.durationDays,
  );

  const action: Action = (() => {
    if (role === 'borrower' && row.status === 'active') return 'repay';
    if (role === 'borrower' && row.status === 'repaid') return 'claim-borrower';
    if (role === 'lender' && row.status === 'repaid') return 'claim-lender';
    if (role === 'lender' && (row.status === 'defaulted' || row.status === 'liquidated')) {
      return 'claim-lender';
    }
    return null;
  })();

  async function run(kind: Exclude<Action, null>) {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'repay') {
        const totalDue = (await publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'calculateRepaymentAmount',
          args: [BigInt(row.loanId)],
        })) as bigint;
        if (row.assetType === AssetType.ERC20 && totalDue > 0n) {
          await ensureAllowance({
            publicClient,
            walletClient,
            token: row.lendingAsset as `0x${string}`,
            owner: address,
            spender: walletChain.diamondAddress,
            amount: totalDue,
          });
        }
        await write('repayLoan', [BigInt(row.loanId)]);
        setDoneMessage(
          'Repayment confirmed. Your collateral is ready — claim it below or from the Claim Center.',
        );
      } else if (kind === 'claim-borrower') {
        await write('claimAsBorrower', [BigInt(row.loanId)]);
        setDoneMessage(copy.claims.claimed);
      } else {
        await write('claimAsLender', [BigInt(row.loanId)]);
        setDoneMessage(copy.claims.claimed);
      }
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /rejected|denied|cancel/i.test(message)
          ? copy.errors.txRejected
          : `${copy.errors.txFailed} (${message.slice(0, 160)})`,
      );
    } finally {
      setBusy(false);
    }
  }

  const principalStr = principal
    ? `${formatTokenAmount(row.principal, principal.decimals)} ${principal.symbol}`
    : '…';
  const interestStr = principal
    ? `${formatTokenAmount(interest, principal.decimals)} ${principal.symbol}`
    : '…';
  const collateralStr = collateral
    ? `${formatTokenAmount(row.collateralAmount, collateral.decimals)} ${collateral.symbol}`
    : '…';
  const dueDate = formatDate(row.startTime + row.durationDays * 86_400);

  const actionLabel =
    action === 'repay'
      ? 'Repay this loan'
      : action === 'claim-borrower'
        ? 'Claim my collateral'
        : action === 'claim-lender'
          ? row.status === 'repaid'
            ? 'Claim my funds'
            : 'Claim the collateral'
          : null;

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1 className="page-title">Loan #{row.loanId}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {role === 'borrower'
              ? `You borrowed ${principalStr}`
              : role === 'lender'
                ? `You lent ${principalStr}`
                : `A loan of ${principalStr} between two other wallets`}
          </p>
        </div>
        <span className={`badge badge-${view.badge}`}>{view.label}</span>
      </div>

      <section className="card">
        <dl className="receipt" style={{ margin: 0 }}>
          <div className="receipt-row">
            <dt>Locked</dt>
            <dd>{collateralStr} collateral (borrower’s)</dd>
          </div>
          <div className="receipt-row">
            <dt>Owed</dt>
            <dd>
              {principalStr} + up to ~{interestStr} interest
            </dd>
          </div>
          <div className="receipt-row">
            <dt>Terms</dt>
            <dd>
              {formatBpsAsPercent(row.interestRateBps)} yearly ·{' '}
              {formatDurationDays(row.durationDays)} · due {dueDate}
            </dd>
          </div>
          <div className="receipt-row receipt-risk">
            <dt>If nothing happens</dt>
            <dd>
              {role === 'borrower'
                ? copy.positions.whatIfNothingBorrower(collateral?.symbol ?? 'locked')
                : copy.positions.whatIfNothingLender}
            </dd>
          </div>
        </dl>
      </section>

      {doneMessage ? (
        <div className="banner banner-info" role="status">
          <CircleCheck aria-hidden />
          <span className="banner-body">{doneMessage}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}

      {actionLabel ? (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy || !onSupportedChain}
          onClick={() => action && void run(action)}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
          {busy ? 'Waiting for wallet…' : actionLabel}
        </button>
      ) : role === 'viewer' ? (
        <div className="banner banner-info">
          <ShieldQuestion aria-hidden />
          <span className="banner-body">
            Connect the wallet that holds this loan’s position to act on it.
          </span>
        </div>
      ) : null}

      <p className="muted">
        <Link to="/positions">← Back to my positions</Link>
      </p>
    </div>
  );
}
