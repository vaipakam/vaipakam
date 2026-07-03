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
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
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
import { ReviewReceipt, type ReceiptData } from '../components/ReviewReceipt';
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
  // Position writes show the six-row receipt BEFORE any wallet prompt
  // — one flag per write surface on this page.
  const [confirming, setConfirming] = useState(false);
  const [confirmingCollateral, setConfirmingCollateral] = useState(false);
  const [confirmingPartial, setConfirmingPartial] = useState(false);

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
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'calculateRepaymentAmount',
            args: [BigInt(row.loanId)],
          }) as Promise<bigint>,
          publicClient.getBlock({ blockTag: 'latest' }),
        ]);
        const chainNow = latestBlock.timestamp;
        // repayLoan reverts RepaymentPastGracePeriod once past the
        // grace window — fail BEFORE the approval. Grace is judged by
        // the compile-time default schedule (storage buckets can only
        // be configured by governance; on the deployed testnets none
        // are). Judged by CHAIN time, never the browser clock.
        if (row.assetType === AssetType.ERC20) {
          const endTime = BigInt(row.startTime + row.durationDays * 86_400);
          const defaultGraceSec =
            row.durationDays < 7
              ? 3_600n
              : row.durationDays < 30
                ? 86_400n
                : row.durationDays < 90
                  ? 3n * 86_400n
                  : row.durationDays < 180
                    ? 7n * 86_400n
                    : row.durationDays < 365
                      ? 14n * 86_400n
                      : 30n * 86_400n;
          if (chainNow > endTime + defaultGraceSec) {
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
          const live = (await publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getLoanDetails',
            args: [BigInt(row.loanId)],
          })) as { principal: bigint; interestRateBps: bigint; startTime: bigint };
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
          const held = await publicClient.readContract({
            address: row.lendingAsset as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          });
          if (held < totalDue + pad) {
            setError(copy.errors.needMore(principalMeta.data?.symbol ?? 'the repayment asset'));
            return;
          }
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
      setConfirming(false);
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
      // addCollateral screens msg.sender — re-screen live before the
      // approval (the page gate is a cached read).
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // addCollateral rejects unless the collateral is currently
      // LIQUID (checkLiquidity == Liquid, enum 0) — fail before the
      // approval. Fail-open on read errors: the contract still guards.
      const liquidity = (await publicClient
        .readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'checkLiquidity',
          args: [row.collateralAsset as `0x${string}`],
        })
        .catch(() => 0)) as number;
      if (Number(liquidity) !== 0) {
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
      setConfirmingCollateral(false);
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
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLoanDetails',
          args: [BigInt(row.loanId)],
        }) as Promise<{
          principal: bigint;
          interestRateBps: bigint;
          startTime: bigint;
          interestAccrualStart: bigint;
        }>,
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
      const held = await publicClient.readContract({
        address: row.lendingAsset as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
      if (held < required) {
        setError(copy.errors.needMore(principalMeta.data.symbol));
        return;
      }
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
      setConfirmingPartial(false);
      void queryClient.invalidateQueries({ queryKey: ['loan'] });
      void queryClient.invalidateQueries({ queryKey: ['loanRisk'] });
      void queryClient.invalidateQueries({ queryKey: ['myLoans'] });
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
    row.collateralAsset.toLowerCase() !==
      '0x0000000000000000000000000000000000000000' &&
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
            : `${collateralStr} collateral back — claimable right after repayment settles.`,
          youLock: 'Nothing new.',
          youMayOwe: isRental
            ? 'Nothing more — fees were prepaid (late fees only if past the due date).'
            : `${principalStr} + interest accrued to now. The exact amount is read live when you confirm; the approval carries small day-boundary headroom that is never spent.`,
          youCanLose: 'Nothing beyond what you owe.',
          fees: 'No extra Vaipakam fee to repay — the protocol’s cut comes out of the lender’s interest.',
          whenThisEnds: 'Immediately — the loan settles and your side is released.',
        }
      : action === 'claim-borrower'
        ? {
            youReceive: isRental
              ? 'Your refundable buffer back.'
              : row.status === 'repaid'
                ? `${collateralStr} collateral back.`
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
                    `What this loan recovered: sale proceeds in ${principal?.symbol ?? 'the loan asset'}, or the ${collateralStr} collateral itself, depending on how the default settled.`,
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
              onClick={() => setConfirmingCollateral(true)}
            >
              Add
            </button>
          </div>
          {collateralOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.errors.needMore(collateral.symbol)}
            </p>
          ) : null}
          {confirmingCollateral && collateralInputWei !== null ? (
            <div style={{ marginTop: 16 }}>
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
              <ReviewReceipt
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
              />
              <div className="cluster" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmingCollateral(false)}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => void runAddCollateral()}
                >
                  {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                  {busy ? 'Waiting for wallet…' : 'Confirm — add collateral'}
                </button>
              </div>
            </div>
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
                !walletClient ||
                !publicClient ||
                partialInputWei === null ||
                principalBalance.data === undefined ||
                partialOverBalance
              }
              onClick={() => setConfirmingPartial(true)}
            >
              Repay part
            </button>
          </div>
          {partialOverBalance ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.errors.needMore(principal.symbol)}
            </p>
          ) : null}
          {confirmingPartial && partialInputWei !== null ? (
            <div style={{ marginTop: 16 }}>
              <ReviewReceipt
                data={{
                  youReceive: 'Nothing now — a smaller debt.',
                  youLock: 'Nothing.',
                  youMayOwe: `${partialInput} ${principal.symbol} now, plus the interest accrued so far (pulled together in this payment). The due date doesn’t move.`,
                  youCanLose: 'Nothing beyond the payment.',
                  fees: 'The protocol’s cut of the accrued interest settles inside the payment.',
                  whenThisEnds: 'Your remaining principal drops immediately; interest keeps accruing on the smaller amount.',
                }}
              />
              <div className="cluster" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmingPartial(false)}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => void runPartialRepay()}
                >
                  {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                  {busy ? 'Waiting for wallet…' : 'Confirm — repay part'}
                </button>
              </div>
            </div>
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

      {actionLabel && action ? (
        confirming ? (
          // Position writes go through the SAME six-row review surface
          // as every other write flow — the wallet prompt is never the
          // first place the user sees what a click will do.
          <section className="card">
            <h3>Before you confirm</h3>
            {actionReceipt ? <ReviewReceipt data={actionReceipt} /> : null}
            <div className="cluster" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={
                  busy ||
                  !onSupportedChain ||
                  // wallet/public client hydrate async after connect —
                  // without this the first click lands in run()'s early
                  // return and silently does nothing.
                  !walletClient ||
                  !publicClient ||
                  (action !== 'repay' && !sanctionsClear)
                }
                onClick={() => void run(action)}
              >
                {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                {busy ? 'Waiting for wallet…' : `Confirm — ${actionLabel}`}
              </button>
            </div>
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
            onClick={() => setConfirming(true)}
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
