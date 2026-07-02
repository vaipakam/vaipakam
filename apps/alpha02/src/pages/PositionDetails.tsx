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
import { CircleCheck, LoaderCircle, ShieldPlus, ShieldQuestion } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  parseUnits,
} from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, submitErrorText } from '../lib/errors';
import { useLoan } from '../data/hooks';
import { useLoanRisk, healthView } from '../data/risk';
import { useSanctionsCheck } from '../data/sanctions';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, useTokenBalance, useTokenMeta } from '../contracts/erc20';
import {
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  fullTermInterest,
  shortAddress,
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

  const { isAdvanced } = useMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [collateralInput, setCollateralInput] = useState('');
  const [partialInput, setPartialInput] = useState('');
  // A successful claim doesn't change the indexer row's status, so
  // without this latch the button would re-enable and invite a
  // second, reverting claim.
  const [claimed, setClaimed] = useState(false);

  // For rentals the "principal" leg is the NFT contract — no ERC-20
  // metadata to read there.
  const loanIsRental =
    loan.data !== null &&
    loan.data !== undefined &&
    loan.data.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(
    loanIsRental ? undefined : loan.data?.lendingAsset,
  );
  const collateralMeta = useTokenMeta(loan.data?.collateralAsset ?? undefined);

  // Claim rights and role permissions travel with the POSITION NFTs,
  // not the original addresses — a wallet that bought/received a
  // lender- or borrower-side NFT must see that side's actions. Read
  // the current owners (Diamond is the ERC-721); fall back to the
  // historical addresses when the reads are unavailable.
  const { readChain } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const nftOwners = useQuery({
    queryKey: ['positionOwners', readChain.chainId, loan.data?.loanId],
    enabled: Boolean(loan.data) && Boolean(readClient),
    refetchInterval: 60_000,
    queryFn: async () => {
      const row = loan.data!;
      // Tri-state per side: an address (live owner), 'burned' (the
      // token positively no longer exists — its claim was made), or a
      // THROW on transport errors so the query lands in error state.
      // Collapsing burned and unreadable into one null previously let
      // the historical party look actionable on burned positions.
      const ownerOf = async (
        tokenId: string,
      ): Promise<string | 'burned'> => {
        if (!/^[1-9]\d*$/.test(tokenId)) return 'burned';
        try {
          return (await readClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'ownerOf',
            args: [BigInt(tokenId)],
          })) as string;
        } catch (err) {
          const isRevert =
            err instanceof BaseError &&
            (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
              err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
          if (isRevert) return 'burned';
          throw err;
        }
      };
      const [lenderOwner, borrowerOwner] = await Promise.all([
        ownerOf(row.lenderTokenId),
        ownerOf(row.borrowerTokenId),
      ]);
      return { lenderOwner, borrowerOwner };
    },
  });

  // 'checking' while the owner reads are in flight — actions render
  // only once the role is CONFIRMED, so a transferred position never
  // flashes controls at its previous holder.
  const role: 'lender' | 'borrower' | 'viewer' | 'checking' = useMemo(() => {
    const row = loan.data;
    if (!row || !address) return 'viewer';
    const me = address.toLowerCase();
    const owners = nftOwners.data;
    if (owners) {
      if (owners.borrowerOwner !== 'burned' && owners.borrowerOwner.toLowerCase() === me) {
        return 'borrower';
      }
      if (owners.lenderOwner !== 'burned' && owners.lenderOwner.toLowerCase() === me) {
        return 'lender';
      }
      // Burned side = that claim was already made; the historical
      // address gets NO actionable role from it.
      return 'viewer';
    }
    if (nftOwners.isError) {
      // Transport failure — can't verify live ownership. Fall back to
      // the historical addresses (the wallet prompt still protects).
      if (row.borrower.toLowerCase() === me) return 'borrower';
      if (row.lender.toLowerCase() === me) return 'lender';
      return 'viewer';
    }
    return 'checking';
  }, [loan.data, address, nftOwners.data, nftOwners.isError]);

  // HF/LTV apply only to active, priced (ERC-20) loans; the hook maps
  // the illiquid-leg revert to `priced: false`.
  const risk = useLoanRisk(
    loan.data?.loanId,
    Boolean(loan.data && loan.data.status === 'active' && !loanIsRental),
  );

  // Sanctions: addCollateral and both claim paths screen msg.sender on
  // chain — gate them BEFORE the approval/click so a flagged wallet
  // never pays gas for a doomed tx. Repay/close stays open (Tier-2
  // wind-down is deliberately unscreened).
  const sanctions = useSanctionsCheck();
  const sanctionsClear = sanctions.ready && !sanctions.flagged;

  // Balance gates: approve() succeeds regardless of balance, so check
  // the wallet actually holds the typed amount before any approval.
  const collateralBalance = useTokenBalance(
    loanIsRental ? undefined : loan.data?.collateralAsset,
  );
  const principalBalance = useTokenBalance(
    loanIsRental ? undefined : loan.data?.lendingAsset,
  );
  const collateralInputWei = useMemo(() => {
    if (!collateralMeta.data || !isPositiveDecimal(collateralInput)) return null;
    try {
      return parseUnits(collateralInput, collateralMeta.data.decimals);
    } catch {
      return null;
    }
  }, [collateralInput, collateralMeta.data]);
  const partialInputWei = useMemo(() => {
    if (!principalMeta.data || !isPositiveDecimal(partialInput)) return null;
    try {
      return parseUnits(partialInput, principalMeta.data.decimals);
    } catch {
      return null;
    }
  }, [partialInput, principalMeta.data]);
  const collateralOverBalance =
    collateralInputWei !== null &&
    collateralBalance.data !== undefined &&
    collateralInputWei > collateralBalance.data;
  const partialOverBalance =
    partialInputWei !== null &&
    principalBalance.data !== undefined &&
    partialInputWei > principalBalance.data;

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
  const isRental = row.assetType !== AssetType.ERC20;
  const principal = principalMeta.data;
  const collateral = collateralMeta.data;
  const interest = fullTermInterest(
    BigInt(row.principal),
    row.interestRateBps,
    row.durationDays,
  );

  const action: Action = (() => {
    if (claimed) return null; // claim already made this session
    // fallback_pending is CURABLE: the contracts still accept full
    // repayment (and add-collateral) while a failed liquidation waits
    // for retry — never leave the borrower without the cure action.
    if (
      role === 'borrower' &&
      (row.status === 'active' || row.status === 'fallback_pending')
    ) {
      return 'repay';
    }
    if (role === 'borrower' && row.status === 'repaid') return 'claim-borrower';
    // After a default/liquidation the borrower may still have a
    // residual entitlement (liquidation surplus) — the Claim Center
    // lists these rows, so this page must offer the claim.
    if (
      role === 'borrower' &&
      (row.status === 'defaulted' || row.status === 'liquidated')
    ) {
      return 'claim-borrower';
    }
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
          // approve() succeeds no matter the balance — check the wallet
          // actually holds the full amount due BEFORE asking for an
          // approval signature, so a short wallet gets a plain "you
          // need more X" instead of a doomed approve→revert pair.
          const held = await publicClient.readContract({
            address: row.lendingAsset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          });
          if (held < totalDue) {
            setError(copy.errors.needMore(principalMeta.data?.symbol ?? 'the repayment asset'));
            return;
          }
          // The owed amount STEPS UP at each elapsed-day boundary
          // (whole-day interest flooring) and by 0.5%/day late fee —
          // an exact-amount approval can be short by the time repayLoan
          // executes. Pad by ~2 days of interest + one late-fee step;
          // repayLoan only pulls the recomputed amount, so the pad is
          // never spent.
          const principal = BigInt(row.principal);
          const pad =
            fullTermInterest(principal, row.interestRateBps, 2) +
            (principal * 50n) / 10_000n;
          await ensureAllowance({
            publicClient,
            walletClient,
            token: row.lendingAsset as `0x${string}`,
            owner: address,
            spender: walletChain.diamondAddress,
            amount: totalDue + pad,
          });
        }
        await write('repayLoan', [BigInt(row.loanId)]);
        setDoneMessage(
          isRental
            ? 'Rental closed. Any refundable buffer is ready — claim it from the Claim Center.'
            : 'Repayment confirmed. Your collateral is ready — claim it below or from the Claim Center.',
        );
      } else if (kind === 'claim-borrower') {
        await write('claimAsBorrower', [BigInt(row.loanId)]);
        setClaimed(true);
        setDoneMessage(copy.claims.claimed);
      } else {
        await write('claimAsLender', [BigInt(row.loanId)]);
        setClaimed(true);
        setDoneMessage(copy.claims.claimed);
      }
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
    } catch (err) {
      setError(submitErrorText(err));
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
  async function runAddCollateral() {
    if (!address || !walletChain || !walletClient || !publicClient || !collateralMeta.data) return;
    setBusy(true);
    setError(null);
    try {
      const wei = parseUnits(collateralInput, collateralMeta.data.decimals);
      await ensureAllowance({
        publicClient,
        walletClient,
        token: row.collateralAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: wei,
      });
      await write('addCollateral', [BigInt(row.loanId), wei]);
      setDoneMessage('Collateral added — the loan is safer now.');
      setCollateralInput('');
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanRisk'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPartialRepay() {
    if (!address || !walletChain || !walletClient || !publicClient || !principalMeta.data) return;
    setBusy(true);
    setError(null);
    try {
      const wei = parseUnits(partialInput, principalMeta.data.decimals);
      await ensureAllowance({
        publicClient,
        walletClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: wei,
      });
      await write('repayPartial', [BigInt(row.loanId), wei]);
      setDoneMessage('Partial repayment confirmed — you now owe less.');
      setPartialInput('');
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanRisk'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const hasCollateral =
    row.collateralAsset.toLowerCase() !==
      '0x0000000000000000000000000000000000000000' &&
    BigInt(row.collateralAmount) > 0n;
  const collateralStr = !hasCollateral
    ? 'No collateral'
    : collateral
      ? `${formatTokenAmount(row.collateralAmount, collateral.decimals)} ${collateral.symbol}`
      : '…';
  const nftStr = `NFT ${shortAddress(row.lendingAsset)} #${row.tokenId}`;
  const dueDate = formatDate(row.startTime + row.durationDays * 86_400);

  const actionLabel =
    action === 'repay'
      ? isRental
        ? 'Close this rental'
        : 'Repay this loan'
      : action === 'claim-borrower'
        ? isRental
          ? 'Claim my buffer back'
          : row.status === 'repaid'
            ? 'Claim my collateral'
            : 'Claim what’s left (if anything)'
        : action === 'claim-lender'
          ? isRental
            ? 'Claim fees & reclaim NFT'
            : row.status === 'repaid'
              ? 'Claim my funds'
              : 'Claim the collateral'
          : null;

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1 className="page-title">
            {isRental ? 'Rental' : 'Loan'} #{row.loanId}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {isRental
              ? role === 'borrower'
                ? `You rent ${nftStr}`
                : role === 'lender'
                  ? `Your ${nftStr} is rented out`
                  : `A rental of ${nftStr} between two other wallets`
              : role === 'borrower'
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
            <dd>
              {isRental
                ? `${nftStr} stays in the owner’s vault${hasCollateral ? `, plus ${collateralStr} collateral` : ''}`
                : `${collateralStr} collateral (borrower’s)`}
            </dd>
          </div>
          <div className="receipt-row">
            <dt>Owed</dt>
            <dd>
              {isRental
                ? 'Nothing to repay — rental fees were prepaid (late fees only if closed past the due date).'
                : `${principalStr} + up to ~${interestStr} interest`}
            </dd>
          </div>
          <div className="receipt-row">
            <dt>Terms</dt>
            <dd>
              {isRental
                ? `${formatDurationDays(row.durationDays)} · ends ${dueDate}`
                : `${formatBpsAsPercent(row.interestRateBps)} yearly · ${formatDurationDays(row.durationDays)} · due ${dueDate}`}
            </dd>
          </div>
          {!isRental && row.status === 'active' && risk.data ? (
            <div className="receipt-row">
              <dt>Health</dt>
              <dd>
                {risk.data.priced ? (
                  <>
                    <span className={`badge badge-${healthView(risk.data).badge}`}>
                      {healthView(risk.data).label}
                    </span>{' '}
                    {copy.risk.explain}
                    {isAdvanced ? (
                      <>
                        {' '}
                        <span className="muted">
                          (health factor {healthView(risk.data).ratio}, loan-to-value{' '}
                          {healthView(risk.data).ltvPct}; liquidation below 1.00)
                        </span>
                      </>
                    ) : null}
                  </>
                ) : (
                  copy.risk.notPriced
                )}
              </dd>
            </div>
          ) : null}
          <div className="receipt-row receipt-risk">
            <dt>If nothing happens</dt>
            <dd>
              {isRental
                ? role === 'borrower'
                  ? 'Your use rights end at the due date and the prepaid buffer goes to the owner — close on time to get it back.'
                  : 'The renter’s rights reset after the due date and grace period; your fees stay claimable here.'
                : role === 'borrower'
                  ? copy.positions.whatIfNothingBorrower(collateral?.symbol ?? 'locked')
                  : copy.positions.whatIfNothingLender}
            </dd>
          </div>
        </dl>
      </section>

      {role === 'borrower' && (row.status === 'active' || row.status === 'fallback_pending') && !isRental && hasCollateral && collateral ? (
        <section className="card">
          <div className="card-title">
            <ShieldPlus aria-hidden />
            <h3 style={{ margin: 0 }}>Add collateral</h3>
          </div>
          <p className="muted">
            Topping up your {collateral.symbol} collateral makes the loan safer
            and moves liquidation further away.
          </p>
          <div className="cluster">
            <input
              aria-label="Collateral amount to add"
              className="input"
              style={{ flex: 1 }}
              inputMode="decimal"
              placeholder="0.0"
              value={collateralInput}
              onChange={(e) => setCollateralInput(e.target.value.trim())}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={
                busy ||
                !onSupportedChain ||
                !sanctionsClear ||
                collateralInputWei === null ||
                // balance still loading → over-balance can't be judged
                // yet, so hold the button rather than let a short
                // wallet through to a doomed approval.
                collateralBalance.data === undefined ||
                collateralOverBalance
              }
              onClick={() => void runAddCollateral()}
            >
              Add
            </button>
          </div>
          {collateralOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.errors.needMore(collateral.symbol)}
            </p>
          ) : null}
        </section>
      ) : null}

      {isAdvanced &&
      role === 'borrower' &&
      row.status === 'active' &&
      !isRental &&
      row.allowsPartialRepay &&
      principal ? (
        <section className="card">
          <h3>Repay part of the loan</h3>
          <p className="muted">
            This loan allows partial repayment. Payments go to interest first,
            then reduce the amount you owe — the due date never moves.
          </p>
          <div className="cluster">
            <input
              aria-label="Amount to repay now"
              className="input"
              style={{ flex: 1 }}
              inputMode="decimal"
              placeholder="0.0"
              value={partialInput}
              onChange={(e) => setPartialInput(e.target.value.trim())}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={
                busy ||
                !onSupportedChain ||
                partialInputWei === null ||
                principalBalance.data === undefined ||
                partialOverBalance
              }
              onClick={() => void runPartialRepay()}
            >
              Repay part
            </button>
          </div>
          {partialOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.errors.needMore(principal.symbol)}
            </p>
          ) : null}
        </section>
      ) : null}

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
          disabled={
            busy ||
            !onSupportedChain ||
            (action !== 'repay' && !sanctionsClear)
          }
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
