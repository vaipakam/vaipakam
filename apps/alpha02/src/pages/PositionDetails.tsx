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
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, LoaderCircle, ShieldPlus, ShieldQuestion } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  parseUnits,
} from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, submitErrorText } from '../lib/errors';
import { useLoan } from '../data/hooks';
import { useLoanRisk, healthView } from '../data/risk';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
import {
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
  isAssetIlliquidLive,
  readGraceSecondsLive,
} from '../contracts/preflights';
import {
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  readRepaymentDueLive,
} from '../contracts/loanLive';
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
import { type ReceiptData } from '../components/ReviewReceipt';
import { ConfirmReceipt } from '../components/ConfirmReceipt';
import { RefinanceFlow } from '../components/RefinanceFlow';
import { RefinancePendingCard } from '../components/RefinancePendingCard';
import { EarlyExitFlow } from '../components/EarlyExitFlow';
import { LoanSaleFlow } from '../components/LoanSaleFlow';
import { LoanSalePendingCard } from '../components/LoanSalePendingCard';
import { useLoanSalePending } from '../data/loanSalePending';
import { useRefinancePending } from '../data/refinancePending';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { AssetType } from '../lib/types';

type Action = 'repay' | 'claim-borrower' | 'claim-lender' | null;
/** The page's inline confirm surfaces — ONE open at a time, so two
 *  review receipts can never invite conflicting signatures at once. */
type ConfirmSurface =
  | 'action'
  | 'collateral'
  | 'partial'
  | 'preclose'
  | 'refinance'
  | 'early-exit'
  | 'loan-sale';

export function PositionDetails() {
  const { loanId: loanIdParam } = useParams();
  // Remount the page per loan: React Router reuses the same element
  // when only the :loanId param changes, and this page's latches
  // (claimed, closedThisSession, doneMessage, typed inputs) describe
  // ONE loan — leaking them onto the next would hide the repay button
  // on a different, still-open loan.
  return <PositionDetailsInner key={loanIdParam ?? 'none'} loanIdParam={loanIdParam} />;
}

function PositionDetailsInner({ loanIdParam }: { loanIdParam: string | undefined }) {
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
  // Same indexer lag after a full repay or preclose: the row stays
  // "active" until the indexer catches up, so without this latch the
  // repay button and the close-early card would re-appear and invite
  // a second, reverting submit (LoanNotActive).
  const [closedThisSession, setClosedThisSession] = useState(false);
  // Lender-side sibling of closedThisSession: after a successful
  // position sale the indexer still shows this wallet as lender for
  // a window — the latch lives on the PAGE so an EarlyExitFlow
  // remount (mode toggle) can't resurrect the stale picker.
  const [soldThisSession, setSoldThisSession] = useState(false);
  // Position writes show the six-row receipt BEFORE any wallet prompt.
  // One slot (not one flag per surface) — opening a surface closes any
  // other, so two receipts never invite conflicting signatures.
  const [confirmingSurface, setConfirmingSurface] =
    useState<ConfirmSurface | null>(null);

  // For rentals the "principal" leg is the NFT contract — no ERC-20
  // metadata to read there.
  const loanIsRental =
    loan.data !== null &&
    loan.data !== undefined &&
    loan.data.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(
    loanIsRental ? undefined : loan.data?.lendingAsset,
  );
  // NFT collateral (ERC-721/1155) has no ERC-20 metadata to read.
  const collateralIsNft =
    loan.data !== null &&
    loan.data !== undefined &&
    loan.data.collateralAssetType !== AssetType.ERC20;
  const collateralMeta = useTokenMeta(
    collateralIsNft ? undefined : (loan.data?.collateralAsset ?? undefined),
  );

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
  // flashes controls at its previous holder. 'unverified' when the
  // owner reads FAILED: the historical addresses are NOT a safe
  // fallback (full repay is permissionless — a stale "borrower" could
  // spend real tokens closing a position that now belongs to someone
  // else), so a failed read stays non-actionable instead.
  const role: 'lender' | 'borrower' | 'viewer' | 'checking' | 'unverified' =
    useMemo(() => {
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
      if (nftOwners.isError) return 'unverified';
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

  // Page-owned pending-refinance state — deliberately independent of
  // the strategy cards' mount gates. A live request interlocks the
  // repay-family surfaces (a changed principal or a settled loan
  // strands the frozen-amount request) and keeps its own card below.
  const refi = useRefinancePending(
    loanId,
    loanIsRental || !loan.data
      ? undefined
      : (loan.data.lendingAsset as `0x${string}`),
  );
  const refinancePending = refi.offerId !== null;

  // Lender-side sibling: a live Option-2 sale listing. Existence is
  // the CHAIN's say-so (positionLock on the lender NFT), so a listing
  // made on another device still shows and interlocks here.
  const sale = useLoanSalePending(
    loanId,
    loan.data?.lenderTokenId,
    loanIsRental || !loan.data
      ? undefined
      : (loan.data.lendingAsset as `0x${string}`),
    // Lender-side viewers only (the hook also self-enables on a
    // device marker) — borrowers/spectators must not pay the polling
    // cost for a watch their wallet can't answer.
    !loanIsRental && Boolean(loan.data) && role === 'lender',
  );
  const salePending = sale.state?.listed === true;
  // The listing ended off-page (a buyer accepted, or it was cancelled
  // elsewhere) — surface the outcome once via the page banner.
  useEffect(() => {
    if (sale.endedNotice) {
      setDoneMessage(copy.loanSale.ended);
      sale.clearEndedNotice();
    }
  }, [sale, sale.endedNotice]);

  // Live loan snapshot — interest MODE and the re-stampable accrual
  // clock live only on-chain (the indexer row lacks them). The quoted
  // preclose figure is the contract's OWN settlement math
  // (`calculateRepaymentAmount` routes through the same
  // settlementInterestNet as `computePreclose`: full-term floor,
  // interest already settled by partials, chain time) — never a
  // hand-derived formula that can drift from what is pulled.
  // `chainNow` rides along so time gates never trust the local clock.
  const loanLive = useQuery({
    queryKey: ['loanLive', readChain.chainId, loan.data?.loanId],
    // Only the advanced strategy cards consume this (borrower:
    // close-early/refinance; lender: early exit) — don't burn three
    // RPC reads a minute for viewers or basic mode.
    enabled:
      Boolean(readClient) &&
      Boolean(loan.data) &&
      loan.data?.status === 'active' &&
      !loanIsRental &&
      isAdvanced &&
      (role === 'borrower' || role === 'lender'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [live, calcDue, latestBlock] = await Promise.all([
        readLoanLive(readClient!, readChain.diamondAddress, loan.data!.loanId),
        readRepaymentDueLive(
          readClient!,
          readChain.diamondAddress,
          loan.data!.loanId,
        ),
        readClient!.getBlock({ blockTag: 'latest' }),
      ]);
      return { live, calcDue, chainNow: latestBlock.timestamp };
    },
  });

  // Balance gates: approve() succeeds regardless of balance, so check
  // the wallet actually holds the typed amount before any approval.
  const collateralBalance = useTokenBalance(
    loanIsRental || collateralIsNft ? undefined : loan.data?.collateralAsset,
  );
  const principalBalance = useTokenBalance(
    loanIsRental ? undefined : loan.data?.lendingAsset,
  );
  const collateralInputWei = useMemo(() => {
    if (!collateralMeta.data || !isPositiveDecimal(collateralInput)) return null;
    try {
      const wei = parseUnits(collateralInput, collateralMeta.data.decimals);
      // A positive decimal below the token's precision parses to 0 wei
      // — the contract rejects zero amounts, so treat it as invalid.
      return wei > 0n ? wei : null;
    } catch {
      return null;
    }
  }, [collateralInput, collateralMeta.data]);
  const partialInputWei = useMemo(() => {
    if (!principalMeta.data || !isPositiveDecimal(partialInput)) return null;
    try {
      const wei = parseUnits(partialInput, principalMeta.data.decimals);
      return wei > 0n ? wei : null;
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
      !closedThisSession &&
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
    // fallback_pending is claimable for the LENDER too: claimAsLender
    // runs the claim-time fallback resolution (ClaimFacet accepts
    // FallbackPending), so the lender can finalize instead of waiting
    // on a keeper retry. (The borrower's cure path is handled above.)
    if (role === 'lender' && row.status === 'fallback_pending') {
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
        const [calcDue, latestBlock] = await Promise.all([
          readRepaymentDueLive(publicClient, walletChain.diamondAddress, row.loanId),
          publicClient.getBlock({ blockTag: 'latest' }),
        ]);
        const chainNow = latestBlock.timestamp;
        // Two more independent live reads, one round-trip: the role
        // came from a CACHED ownerOf (repayLoan is PERMISSIONLESS — a
        // stale "borrower" could pay off a position whose claim now
        // belongs to someone else), and the grace window is judged by
        // CHAIN time against the LIVE buckets.
        const [, graceSec] = await Promise.all([
          assertPositionNftHeldLive({
            publicClient,
            diamondAddress: walletChain.diamondAddress,
            tokenId: row.borrowerTokenId,
            expectedOwner: address,
          }),
          // Grace only gates ERC-20 repays — don't spend a read on
          // rental closes.
          row.assetType === AssetType.ERC20
            ? readGraceSecondsLive({
                publicClient,
                diamondAddress: walletChain.diamondAddress,
                durationDays: row.durationDays,
              })
            : Promise.resolve(0n),
        ]);
        // repayLoan reverts RepaymentPastGracePeriod once past the
        // grace window — fail BEFORE the approval.
        if (row.assetType === AssetType.ERC20) {
          const endTime = BigInt(row.startTime + row.durationDays * 86_400);
          if (chainNow > endTime + graceSec) {
            setError(copy.errors.pastGrace);
            return;
          }
        }
        // calculateRepaymentAmount returns 0 for any non-Active status
        // — but repayLoan ACCEPTS FallbackPending (the cure path) and
        // still pulls principal + interest. Estimate the pull from the
        // live loan so the cure flow gets a real allowance; the
        // estimate only over-approves (repayLoan pulls what it
        // recomputes) and the pad below is never spent.
        let totalDue = calcDue;
        if (
          totalDue === 0n &&
          row.status === 'fallback_pending' &&
          row.assetType === AssetType.ERC20
        ) {
          const live = await readLoanLive(
            publicClient,
            walletChain.diamondAddress,
            row.loanId,
          );
          const elapsedDays =
            chainNow > live.startTime ? (chainNow - live.startTime) / 86_400n : 0n;
          const interestEst =
            (live.principal * live.interestRateBps * (elapsedDays + 2n)) /
            (365n * 10_000n);
          // Late fees accrue 0.5%/day past maturity — cover them too.
          const daysPastEnd =
            chainNow > live.startTime + BigInt(row.durationDays) * 86_400n
              ? (chainNow - (live.startTime + BigInt(row.durationDays) * 86_400n)) / 86_400n
              : 0n;
          const lateFeeEst = (live.principal * 50n * (daysPastEnd + 2n)) / 10_000n;
          totalDue = live.principal + interestEst + lateFeeEst;
        }
        if (row.assetType === AssetType.ERC20 && totalDue > 0n) {
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
          // approve() succeeds no matter the balance — check the wallet
          // holds the PADDED amount before asking for an approval
          // signature: a wallet holding exactly totalDue can still be
          // short when repayLoan recomputes across a boundary, which
          // would burn the approval on a doomed transferFrom.
          await assertErc20BalanceLive({
            publicClient,
            token: row.lendingAsset as `0x${string}`,
            owner: address,
            amount: totalDue + pad,
            symbol: principalMeta.data?.symbol,
          });
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
        setClosedThisSession(true);
        setDoneMessage(
          isRental
            ? 'Rental closed. Any refundable buffer is ready — claim it from the Claim Center.'
            : 'Repayment confirmed. Your collateral is ready — claim it below or from the Claim Center.',
        );
      } else if (kind === 'claim-borrower') {
        // Claims screen msg.sender on-chain and the page's gate is a
        // CACHED read — re-screen live before the wallet prompt.
        await assertWalletNotSanctionedLive(
          publicClient,
          walletChain.diamondAddress,
          address,
        );
        await write('claimAsBorrower', [BigInt(row.loanId)]);
        setClaimed(true);
        setDoneMessage(copy.claims.claimed);
      } else {
        await assertWalletNotSanctionedLive(
          publicClient,
          walletChain.diamondAddress,
          address,
        );
        await write('claimAsLender', [BigInt(row.loanId)]);
        setClaimed(true);
        setDoneMessage(copy.claims.claimed);
      }
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
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
      // addCollateral screens msg.sender — re-screen live before the
      // approval (the page gate is a cached read).
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // Three independent live gates, one round-trip: addCollateral
      // authorizes the CURRENT borrower-position holder
      // (requireBorrowerNftOwner), approve() ignores balances, and the
      // contract rejects top-ups on unpriced collateral
      // (IlliquidAsset; fail-open read — the contract still guards).
      const [, , collateralIlliquid] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        assertErc20BalanceLive({
          publicClient,
          token: row.collateralAsset as `0x${string}`,
          owner: address,
          amount: wei,
          symbol: collateralMeta.data.symbol,
        }),
        isAssetIlliquidLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.collateralAsset,
        }),
      ]);
      if (collateralIlliquid) {
        setError(copy.errors.collateralNotPriced);
        return;
      }
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
      setConfirmingSurface(null);
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
      // repayPartial pulls MORE than the typed amount: the accrued
      // interest to now (lender + treasury split) rides along in the
      // same transferFrom set. Approve and balance-check the full pull
      // from the LIVE loan (row.principal / startTime go stale after a
      // prior partial re-stamps the accrual clock).
      const [live, latestBlock] = await Promise.all([
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        // The contract accrues by block.timestamp — a slow browser
        // clock must not under-approve past the two-day pad.
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      // A partial equal to the FULL remaining principal is accepted by
      // the contract but leaves the loan Active at principal 0 —
      // settlement (and collateral release) needs the real repay path.
      if (wei >= live.principal) {
        setError(copy.errors.partialOverPrincipal);
        return;
      }
      // repayPartial authorizes the CURRENT borrower-position holder
      // (stored-anchor auth after consolidation) — re-check live so a
      // stale role fails before the approval.
      await assertPositionNftHeldLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        tokenId: row.borrowerTokenId,
        expectedOwner: address,
      });
      // repayPartial pays the CURRENT lender-position holder DIRECTLY
      // and reverts if that wallet is sanctioned — screen the resolved
      // holder before the approval (full repay stays open: it defers
      // the lender's proceeds to a screened claim instead).
      const lenderHolder = (await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'ownerOf',
          args: [BigInt(row.lenderTokenId)],
        })
        .catch(() => null)) as string | null;
      if (lenderHolder) {
        const lenderFlagged = await publicClient
          .readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'isSanctionedAddress',
            args: [lenderHolder as `0x${string}`],
          })
          .catch(() => false);
        if (lenderFlagged) {
          setError(copy.errors.lenderBlockedPartial);
          return;
        }
      }
      const accrualStart =
        live.interestAccrualStart !== 0n ? live.interestAccrualStart : live.startTime;
      const nowSec = latestBlock.timestamp;
      const elapsedDays = nowSec > accrualStart ? (nowSec - accrualStart) / 86_400n : 0n;
      // +2 days pad for day-boundary steps while the tx is pending —
      // the contract pulls only the recomputed accrued, never the pad.
      const accrued =
        (live.principal * live.interestRateBps * (elapsedDays + 2n)) /
        (365n * 10_000n);
      const required = wei + accrued;
      await assertErc20BalanceLive({
        publicClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        amount: required,
        symbol: principalMeta.data.symbol,
      });
      await ensureAllowance({
        publicClient,
        walletClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: required,
      });
      await write('repayPartial', [BigInt(row.loanId), wei]);
      setDoneMessage('Partial repayment confirmed — you now owe less.');
      setPartialInput('');
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      // The close-early quote (loanLive.calcDue) changes with every
      // partial — without this it keeps quoting the pre-partial figure.
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['loanRisk'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPreclose() {
    if (!address || !walletChain || !walletClient || !publicClient || !principalMeta.data) return;
    setBusy(true);
    setError(null);
    try {
      // precloseDirect is a Tier-1 entry point — live re-screen, plus
      // the ownership/clock reads, one round-trip.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      const [, live, calcDue, latestBlock] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        readRepaymentDueLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      // The card's pre-maturity gate ran on a CACHED chain clock (a
      // backgrounded tab stops refetching) — re-judge maturity live
      // against the LIVE term fields. precloseDirect itself has NO
      // maturity revert: past maturity it would settle WITHOUT the
      // late fee the repay path charges, and the quoted calcDue
      // (which includes late fees) would no longer match the pull.
      if (
        latestBlock.timestamp >=
        live.startTime + live.durationDays * 86_400n
      ) {
        setError(copy.errors.precloseMatured);
        return;
      }
      // `calculateRepaymentAmount` IS the preclose figure — it and
      // `computePreclose` route through the same settlementInterestNet
      // (full-term floor max(elapsed, remaining), interest already
      // settled by partials, CHAIN time). It returns 0 for any
      // non-Active loan — but 0 on a still-ACTIVE loan is the legal
      // "principal fully paid down via partials" state, where
      // precloseDirect is exactly the call that settles and releases
      // the collateral (pulling nothing), so only a non-Active status
      // aborts.
      if (calcDue === 0n && live.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // The owed amount steps up at each elapsed-day boundary while
      // the tx is pending — pad by ~2 days of interest; precloseDirect
      // pulls only what it recomputes, so the pad is never spent.
      const due =
        calcDue +
        (live.principal * live.interestRateBps * 2n) / (365n * 10_000n);
      await assertErc20BalanceLive({
        publicClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        amount: due,
        symbol: principalMeta.data.symbol,
      });
      await ensureAllowance({
        publicClient,
        walletClient,
        token: row.lendingAsset as `0x${string}`,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: due,
      });
      await write('precloseDirect', [BigInt(row.loanId)]);
      setClosedThisSession(true);
      setDoneMessage(copy.preclose.done);
      setConfirmingSurface(null);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
      void queryClient.invalidateQueries({ queryKey: ['claimables'] });
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  // NFT collateral is identified by collateralTokenId/quantity — its
  // fungible `collateralAmount` is normally ZERO, so amount alone must
  // not decide "no collateral" (that would hide a real NFT pledge).
  const hasCollateral =
    row.collateralAsset.toLowerCase() !== ZERO_ADDRESS &&
    (BigInt(row.collateralAmount) > 0n ||
      row.collateralAssetType !== AssetType.ERC20);
  const collateralStr = !hasCollateral
    ? 'No collateral'
    : row.collateralAssetType !== AssetType.ERC20
      ? `NFT ${shortAddress(row.collateralAsset)} #${row.collateralTokenId}`
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
              : 'Claim what this loan recovered'
          : null;

  // Six-row receipt for the pending position write — same shape and
  // rows as every create/accept flow (WebsiteReadme intended-behaviour).
  const actionReceipt: ReceiptData | null =
    action === 'repay'
      ? {
          youReceive: isRental
            ? 'Any refundable buffer back — claimable right after closing.'
            : hasCollateral
              ? `${collateralStr} collateral back — claimable right after repayment settles.`
              : 'Nothing extra back — this loan has no collateral to release.',
          youLock: 'Nothing new.',
          youMayOwe: isRental
            ? 'Nothing more — fees were prepaid (late fees only if past the due date).'
            : `${principalStr} + this loan's interest. For full-term loans (the protocol default) the whole term's interest applies even when repaying early; day-by-day loans charge only what has accrued. The exact amount is read live when you confirm; the approval carries small headroom that is never spent.`,
          youCanLose: 'Nothing beyond what you owe.',
          fees: 'No extra Vaipakam fee to repay — the protocol’s cut comes out of the lender’s interest.',
          whenThisEnds: 'Immediately — the loan settles and your side is released.',
        }
      : action === 'claim-borrower'
        ? {
            youReceive: isRental
              ? 'Your refundable buffer back.'
              : row.status === 'repaid'
                ? hasCollateral
                  ? `${collateralStr} collateral back.`
                  : 'Whatever this side is still owed (this loan had no collateral, so there may be nothing).'
                : 'Anything left after liquidation (may be zero).',
            youLock: 'Nothing.',
            youMayOwe: 'Nothing.',
            youCanLose: 'Nothing.',
            fees: 'None.',
            whenThisEnds: 'The claim pays out immediately and this position closes for you.',
          }
        : action === 'claim-lender'
          ? {
              youReceive: isRental
                ? 'Your earned rental fees, plus your NFT back.'
                : row.status === 'repaid'
                  ? `${principalStr} plus the earned interest.`
                  : // Liquid-collateral defaults settle by SWAP — the
                    // lender's claim pays proceeds in the loan asset,
                    // not the collateral itself. Only in-kind (illiquid)
                    // paths hand over the raw collateral, so promise
                    // neither specifically.
                    hasCollateral
                    ? `What this loan recovered: sale proceeds in ${principal?.symbol ?? 'the loan asset'}, or the ${collateralStr} collateral itself, depending on how the default settled.`
                    : 'Whatever this loan recovered (it had no collateral, so there may be nothing).',
              youLock: 'Nothing.',
              youMayOwe: 'Nothing.',
              youCanLose: 'Nothing.',
              fees: row.status === 'repaid' && !isRental
                ? 'The protocol’s yield fee comes out of the interest before payout.'
                : isRental
                  ? 'The protocol’s cut comes out of the rental fees before payout.'
                  : 'None.',
              whenThisEnds: 'The claim pays out immediately and this position closes for you.',
            }
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
          {!isRental && row.status === 'active' && !risk.data ? (
            // A missing risk read must LOOK missing — hiding the row
            // would render a possibly-liquidatable loan as complete.
            <div className="receipt-row">
              <dt>Health</dt>
              <dd>
                {risk.isError
                  ? 'We couldn’t read this loan’s health right now — retrying. Liquidation protection still applies on-chain.'
                  : 'Checking this loan’s health…'}
              </dd>
            </div>
          ) : null}
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

      {role === 'borrower' &&
      (row.status === 'active' || row.status === 'fallback_pending') &&
      !closedThisSession &&
      !isRental &&
      hasCollateral &&
      collateral ? (
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
                !walletClient ||
                !publicClient ||
                !sanctionsClear ||
                collateralInputWei === null ||
                // balance still loading → over-balance can't be judged
                // yet, so hold the button rather than let a short
                // wallet through to a doomed approval.
                collateralBalance.data === undefined ||
                collateralOverBalance
              }
              onClick={() => setConfirmingSurface('collateral')}
            >
              Add
            </button>
          </div>
          {collateralOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.errors.needMore(collateral.symbol)}
            </p>
          ) : null}
          {confirmingSurface === 'collateral' && collateralInputWei !== null ? (
            <div style={{ marginTop: 16 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel="Confirm — add collateral"
                onBack={() => setConfirmingSurface(null)}
                onConfirm={() => void runAddCollateral()}
                data={{
                  youReceive:
                    row.status === 'fallback_pending'
                      ? 'A chance to bring the loan back to health — ONLY if this top-up restores the required health level (see the warning above).'
                      : 'Nothing now — a safer loan (liquidation moves further away).',
                  youLock: `${collateralInput} ${collateral.symbol} more collateral, returned with the rest when the loan closes properly.`,
                  youMayOwe: 'Nothing more — this doesn’t change what you owe.',
                  youCanLose:
                    row.status === 'fallback_pending'
                      ? 'The added amount joins the collateral at stake — if the top-up doesn’t fully cure, the lender can still claim it all.'
                      : 'The added amount joins the existing collateral — it’s at stake the same way if the loan defaults.',
                  fees: 'None.',
                  whenThisEnds: 'The top-up applies immediately.',
                }}
              >
                {row.status === 'fallback_pending' ? (
                  // A fallback-pending top-up CURES only if it restores
                  // the loan's required health thresholds — a partial
                  // top-up leaves the lender able to claim AND puts the
                  // added collateral at stake. Never let the generic
                  // "safer now" copy stand alone here.
                  <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                    <span className="banner-body">
                      This loan is in a failed-liquidation state. Adding
                      collateral only brings it back to Active if the top-up
                      restores the required health level — otherwise the lender
                      can still claim, and the added collateral is at stake too.
                      Repaying in full always cures. If unsure, repay instead.
                    </span>
                  </div>
                ) : null}
              </ConfirmReceipt>
            </div>
          ) : null}
        </section>
      ) : null}

      {isAdvanced &&
      role === 'borrower' &&
      row.status === 'active' &&
      !closedThisSession &&
      !isRental &&
      row.allowsPartialRepay &&
      principal ? (
        <section className="card">
          <h3>Repay part of the loan</h3>
          <p className="muted">
            This loan allows partial repayment. Payments go to interest first,
            then reduce the amount you owe — the due date never moves.
          </p>
          {refinancePending ? (
            // A live refinance request is frozen at the CURRENT
            // principal — a partial would strand it unacceptable
            // forever (the contract rejects any accept once amount >
            // live principal). Explain instead of failing later.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.refinance.partialBlockedByPending}
              </span>
            </div>
          ) : (
          <>
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
                !walletClient ||
                !publicClient ||
                partialInputWei === null ||
                principalBalance.data === undefined ||
                partialOverBalance
              }
              onClick={() => setConfirmingSurface('partial')}
            >
              Repay part
            </button>
          </div>
          {partialOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.errors.needMore(principal.symbol)}
            </p>
          ) : null}
          {confirmingSurface === 'partial' && partialInputWei !== null ? (
            <div style={{ marginTop: 16 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel="Confirm — repay part"
                onBack={() => setConfirmingSurface(null)}
                onConfirm={() => void runPartialRepay()}
                data={{
                  youReceive: 'Nothing now — a smaller debt.',
                  youLock: 'Nothing.',
                  youMayOwe: `${partialInput} ${principal.symbol} now, plus the interest accrued so far (pulled together in this payment). The due date doesn’t move.`,
                  youCanLose: 'Nothing beyond the payment.',
                  fees: 'The protocol’s cut of the accrued interest settles inside the payment.',
                  whenThisEnds: 'Your remaining principal drops immediately; interest keeps accruing on the smaller amount.',
                }}
              />
            </div>
          ) : null}
          </>
          )}
        </section>
      ) : null}

      {/* A flagged wallet sees no close-early surface at all rather
          than a dead button — its open path is the Tier-2 repay
          above. Everyone else gets a visible checking/error state
          while the live reads are in flight (never a silently absent
          feature), and the full card only once the live loan has
          landed: the quoted figure and mode note come from it, and
          the pre-maturity gate is judged by CHAIN time against the
          LIVE term fields (a wrong device clock or a stale indexer
          row must not decide it). */}
      {isAdvanced &&
      role === 'borrower' &&
      row.status === 'active' &&
      !closedThisSession &&
      !isRental &&
      principal &&
      !(sanctions.ready && sanctions.flagged) ? (
        !loanLive.data || !sanctions.ready ? (
          <section className="card">
            <h3>{copy.preclose.title}</h3>
            <p className="muted">
              {loanLive.isError
                ? copy.preclose.checkFailed
                : copy.preclose.checking}
            </p>
          </section>
        ) : (
        <>
        {loanLive.data.chainNow <
        loanLive.data.live.startTime +
          loanLive.data.live.durationDays * 86_400n ? (
        <section className="card">
          <h3>{copy.preclose.title}</h3>
          <p className="muted">
            {copy.preclose.blurb}{' '}
            {loanLive.data.live.useFullTermInterest
              ? copy.preclose.fullTermNote
              : copy.preclose.proRataNote}
          </p>
          {refinancePending ? (
            // A live refinance request is frozen against THIS loan —
            // settling it early would strand the request forever.
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">
                {copy.refinance.precloseBlockedByPending}
              </span>
            </div>
          ) : confirmingSurface !== 'preclose' ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !onSupportedChain || !walletClient || !publicClient}
              onClick={() => setConfirmingSurface('preclose')}
            >
              {copy.preclose.action}
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.preclose.confirm}
                onBack={() => setConfirmingSurface(null)}
                onConfirm={() => void runPreclose()}
                // The wallet can disconnect or hop chains while this
                // receipt is open — a click must land on a disabled
                // button, not on runPreclose's silent early return.
                disabled={!onSupportedChain || !walletClient || !publicClient}
                data={{
                  youReceive: hasCollateral
                    ? `${collateralStr} collateral back — claimable right after closing.`
                    : 'Nothing extra back — this loan has no collateral to release.',
                  youLock: 'Nothing new.',
                  youMayOwe: `~${formatTokenAmount(
                    loanLive.data.calcDue,
                    principal.decimals,
                  )} ${principal.symbol}, paid now. ${
                    loanLive.data.live.useFullTermInterest
                      ? copy.preclose.fullTermNote
                      : copy.preclose.proRataNote
                  } The exact amount is read live when you confirm; the approval carries small headroom that is never spent.`,
                  youCanLose: 'Nothing beyond what you pay.',
                  fees: 'No extra Vaipakam fee to close early — the protocol’s cut comes out of the lender’s interest.',
                  whenThisEnds: 'Immediately — the loan settles today and your collateral is released.',
                }}
              />
            </div>
          )}
        </section>
        ) : // Matured (by live chain time + live term): close-early no
          // longer applies — the plain Repay path below is the one
          // that settles a matured loan, late fees included.
          null}
        {/* Refinance FORM — shares the strategy gates with
            close-early (advanced borrower, live-verified Active,
            sanctions-clear — Tier-1 at accept), PLUS: only the
            ORIGINAL borrower (carry-over binds to the borrower
            stored at init; a transferred position would silently
            re-pledge fresh collateral), and only while NO request is
            already live (the pending surface is the page-owned card
            below, which outlives these gates). Keyed by chain so a
            chain switch re-seeds per-chain state. */}
        {!refinancePending &&
        address &&
        address.toLowerCase() === row.borrower.toLowerCase() ? (
          <RefinanceFlow
            key={readChain.chainId}
            row={row}
            live={loanLive.data.live}
            chainNow={loanLive.data.chainNow}
            principalMeta={principal}
            confirmOpen={confirmingSurface === 'refinance'}
            onOpenConfirm={() => setConfirmingSurface('refinance')}
            onCloseConfirm={() =>
              setConfirmingSurface((s) => (s === 'refinance' ? null : s))
            }
            onPosted={refi.remember}
          />
        ) : null}
        </>
        )
      ) : null}

      {/* Lender strategy — early exit by selling the position into a
          matching open lending offer. Same gate conventions as the
          borrower block: flagged wallets see nothing (Tier-1),
          checking/error states are visible, the full card requires
          the live loan and pre-maturity by chain time. The done
          message goes to the PAGE banner (the role flips to viewer
          as soon as the ownership read refreshes, unmounting this
          block). */}
      {isAdvanced &&
      role === 'lender' &&
      row.status === 'active' &&
      !soldThisSession &&
      !isRental &&
      principal &&
      !(sanctions.ready && sanctions.flagged) ? (
        !loanLive.data || !sanctions.ready ? (
          <section className="card">
            <h3>{copy.earlyExit.title}</h3>
            <p className="muted">
              {loanLive.isError
                ? copy.earlyExit.checkFailed
                : copy.earlyExit.checking}
            </p>
          </section>
        ) : salePending ? (
          // A live sale listing owns the lender's exit story — the
          // pending card below explains and offers cancel/restore.
          null
        ) : loanLive.data.chainNow <
          loanLive.data.live.startTime +
            loanLive.data.live.durationDays * 86_400n ? (
          <>
          <EarlyExitFlow
            row={row}
            live={loanLive.data.live}
            chainNow={loanLive.data.chainNow}
            principalMeta={principal}
            confirmOpen={confirmingSurface === 'early-exit'}
            onOpenConfirm={() => setConfirmingSurface('early-exit')}
            onCloseConfirm={() =>
              setConfirmingSurface((s) => (s === 'early-exit' ? null : s))
            }
            onSold={() => {
              setSoldThisSession(true);
              setDoneMessage(copy.earlyExit.done);
            }}
            busy={busy}
            setBusy={setBusy}
          />
          <section className="card">
            <LoanSaleFlow
              row={row}
              live={loanLive.data.live}
              chainNow={loanLive.data.chainNow}
              principalMeta={principal}
              confirmOpen={confirmingSurface === 'loan-sale'}
              onOpenConfirm={() => setConfirmingSurface('loan-sale')}
              onCloseConfirm={() =>
                setConfirmingSurface((s) => (s === 'loan-sale' ? null : s))
              }
              onListed={(offerId) => {
                sale.remember(offerId);
                setDoneMessage(copy.loanSale.done);
              }}
              busy={busy}
              setBusy={setBusy}
            />
          </section>
          </>
        ) : null
      ) : null}

      {/* The live sale listing's standing surface — chain-authoritative
          (positionLock), outside the strategy gates so it survives
          data hiccups, mode switches, and other-device listings. */}
      {sale.state?.listed &&
      !isRental &&
      address &&
      // Bound to the wallet the settlement pull binds to — a
      // non-holder on the listing device must not see funding
      // verdicts (or grant approvals) for someone else's sale.
      (role === 'lender' || sale.state.isHolder) ? (
        <LoanSalePendingCard
          loanId={row.loanId}
          lenderTokenId={row.lenderTokenId}
          state={sale.state}
          principalAsset={row.lendingAsset as `0x${string}`}
          principalMeta={principal ?? undefined}
          busy={busy}
          setBusy={setBusy}
          onCleared={sale.clear}
          onDone={setDoneMessage}
        />
      ) : null}

      {/* The live request's standing surface — rendered on the MARKER
          alone, outside every strategy gate (mode, loanLive
          readiness, sanctions, loan status, maturity): the banner,
          funding watch, and cancel affordance must survive all of
          those windows, including the loan settling another way. */}
      {refi.offerId &&
      !isRental &&
      address &&
      address.toLowerCase() === row.borrower.toLowerCase() ? (
        <RefinancePendingCard
          loanId={row.loanId}
          offerId={refi.offerId}
          state={refi.state}
          principalAsset={row.lendingAsset as `0x${string}`}
          principalMeta={principal ?? undefined}
          busy={busy}
          setBusy={setBusy}
          onCleared={refi.clear}
        />
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

      {actionLabel && action && actionReceipt ? (
        confirmingSurface === 'action' ? (
          // Position writes go through the SAME six-row review surface
          // as every other write flow — the wallet prompt is never the
          // first place the user sees what a click will do.
          <section className="card">
            <ConfirmReceipt
              busy={busy}
              confirmLabel={`Confirm — ${actionLabel}`}
              onBack={() => setConfirmingSurface(null)}
              onConfirm={() => void run(action)}
              // wallet/public client hydrate async after connect —
              // without this the first click lands in run()'s early
              // return and silently does nothing.
              disabled={
                !onSupportedChain ||
                !walletClient ||
                !publicClient ||
                (action !== 'repay' && !sanctionsClear)
              }
              data={actionReceipt}
            >
              {action === 'repay' && refinancePending && !isRental ? (
                // Repay stays open with a pending refinance request
                // (it's the safety valve — never block it), but the
                // request's fate must be stated before signing.
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">
                    {copy.refinance.repayWarnPending}
                  </span>
                </div>
              ) : null}
            </ConfirmReceipt>
          </section>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={
              busy ||
              !onSupportedChain ||
              (action !== 'repay' && !sanctionsClear)
            }
            onClick={() => setConfirmingSurface('action')}
          >
            {actionLabel}
          </button>
        )
      ) : role === 'unverified' ? (
        <div className="banner banner-warn" role="alert">
          <ShieldQuestion aria-hidden />
          <span className="banner-body">
            We couldn’t verify who currently holds this position, so actions
            are hidden for now. Please try again in a moment.
          </span>
        </div>
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
