import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HandCoins, CheckCircle, ExternalLink } from 'lucide-react';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../../contracts/abis';
import { AssetType, LoanStatus, type LoanDetails } from '../../types/loan';
import { decodeContractError } from '../../lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';
import { TokenAmount } from './TokenAmount';
import { ErrorAlert } from './ErrorAlert';
import type { Address } from 'viem';

interface Props {
  /** The current loan struct as returned by `getLoanDetails`. */
  loan: LoanDetails;
  /** Resolved current owner of the lender-side position NFT (lowercased), or null. */
  lenderHolder: string | null;
  /** Resolved current owner of the borrower-side position NFT (lowercased), or null. */
  borrowerHolder: string | null;
  /** Connected wallet address (lowercased) or null if disconnected. */
  address: string | null;
  /** Connected wallet's chainId — used to gate writes to the right Diamond. */
  chainId: number | null | undefined;
  /** Block-explorer base URL for tx-hash deep links (no trailing slash). */
  blockExplorer: string;
  /** Called after a successful claim submission to let the page refetch state. */
  onClaimed: () => void;
}

interface ClaimableTuple {
  asset?: string;
  amount?: bigint;
  claimed?: boolean;
  assetType?: bigint;
  tokenId?: bigint;
  quantity?: bigint;
  heldForLender?: bigint;
  hasRentalNFTReturn?: boolean;
  0?: string;
  1?: bigint;
  2?: boolean;
  3?: bigint;
  4?: bigint;
  5?: bigint;
  6?: bigint;
  7?: boolean;
}

interface ResolvedClaim {
  role: 'lender' | 'borrower';
  asset: string;
  amount: bigint;
  assetType: AssetType;
  tokenId: bigint;
  quantity: bigint;
  heldForLender: bigint;
  hasRentalNFTReturn: boolean;
  lifRebate: bigint;
}

/**
 * Pinned action bar that surfaces the actionable claim for the connected
 * wallet on a given loan. Renders only when:
 *   - the loan is in a terminal-or-pending state (Repaid / Defaulted /
 *     FallbackPending) such that ClaimFacet allows a claim;
 *   - the connected wallet still owns one of the two position NFTs;
 *   - the wallet's claim slot has not already been pulled.
 *
 * Headline number comes from `getClaimable(loanId, isLender)`; for the
 * borrower side we additionally probe `getBorrowerLifRebate(loanId)` to
 * surface the Phase 5 VPFI rebate as a separate sub-line. The Claim
 * button submits the appropriate facet call.
 */
export function ClaimActionBar({
  loan,
  lenderHolder,
  borrowerHolder,
  address,
  chainId,
  blockExplorer,
  onClaimed,
}: Props) {
  const { t } = useTranslation();
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamond = useDiamondContract();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  const [claims, setClaims] = useState<ResolvedClaim[]>([]);
  const [submitting, setSubmitting] = useState<'lender' | 'borrower' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const me = address?.toLowerCase() ?? null;
  const status = Number(loan.status) as LoanStatus;
  const isClaimableStatus =
    status === LoanStatus.Repaid ||
    status === LoanStatus.Defaulted ||
    status === LoanStatus.FallbackPending;
  const isLender = me !== null && lenderHolder !== null && me === lenderHolder;
  const isBorrower = me !== null && borrowerHolder !== null && me === borrowerHolder;
  const eligible = isClaimableStatus && (isLender || isBorrower);

  useEffect(() => {
    if (!eligible) {
      setClaims([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const sides: Array<{ isLender: boolean; role: 'lender' | 'borrower' }> = [];
      if (isLender) sides.push({ isLender: true, role: 'lender' });
      if (isBorrower) sides.push({ isLender: false, role: 'borrower' });

      let lifRebate = 0n;
      if (isBorrower) {
        try {
          const rebate = (await publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI,
            functionName: 'getBorrowerLifRebate',
            args: [loan.id],
          })) as readonly [bigint, bigint] | { rebateAmount?: bigint };
          if (Array.isArray(rebate)) {
            lifRebate = rebate[0] ?? 0n;
          } else if (rebate && typeof rebate === 'object') {
            lifRebate = (rebate as { rebateAmount?: bigint }).rebateAmount ?? 0n;
          }
        } catch {
          lifRebate = 0n;
        }
      }

      const resolved = await Promise.all(
        sides.map(async (s): Promise<ResolvedClaim | null> => {
          try {
            const res = (await publicClient.readContract({
              address: diamondAddress,
              abi: DIAMOND_ABI,
              functionName: 'getClaimable',
              args: [loan.id, s.isLender],
            })) as ClaimableTuple;
            const asset = res.asset ?? res[0] ?? '';
            const amount = res.amount ?? res[1] ?? 0n;
            const claimed = res.claimed ?? res[2] ?? false;
            const assetType = Number(res.assetType ?? res[3] ?? 0n) as AssetType;
            const tokenId = res.tokenId ?? res[4] ?? 0n;
            const quantity = res.quantity ?? res[5] ?? 0n;
            const heldForLender = res.heldForLender ?? res[6] ?? 0n;
            const hasRentalNFTReturn = res.hasRentalNFTReturn ?? res[7] ?? false;
            const sideLifRebate = s.role === 'borrower' ? lifRebate : 0n;
            const actionable =
              amount > 0n ||
              assetType !== AssetType.ERC20 ||
              heldForLender > 0n ||
              hasRentalNFTReturn ||
              sideLifRebate > 0n;
            if (claimed || !actionable) return null;
            return {
              role: s.role,
              asset,
              amount,
              assetType,
              tokenId,
              quantity,
              heldForLender,
              hasRentalNFTReturn,
              lifRebate: sideLifRebate,
            };
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setClaims(resolved.filter((c): c is ResolvedClaim => c !== null));
      }
    })();
    return () => { cancelled = true; };
  }, [eligible, isLender, isBorrower, loan.id, publicClient, diamondAddress]);

  if (!eligible || claims.length === 0) return null;

  const handleClaim = async (role: 'lender' | 'borrower') => {
    setSubmitting(role);
    setError(null);
    setTxHash(null);
    const step = beginStep({
      area: 'claim',
      flow: role === 'lender' ? 'claimAsLender' : 'claimAsBorrower',
      step: 'submit-tx',
      wallet: address,
      chainId,
      loanId: loan.id,
      role,
    });
    try {
      const tx = role === 'lender'
        ? await diamond.claimAsLender(loan.id)
        : await diamond.claimAsBorrower(loan.id);
      setTxHash(tx.hash);
      await tx.wait();
      step.success({ note: `tx ${tx.hash}` });
      onClaimed();
    } catch (err) {
      setError(decodeContractError(err, t('claimActionBar.claimFailed')));
      step.failure(err);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div
      className="card"
      style={{
        marginBottom: 16,
        borderColor: 'var(--accent-green)',
        background: 'rgba(16, 185, 129, 0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'rgba(16, 185, 129, 0.15)',
            color: 'var(--accent-green)',
            flexShrink: 0,
          }}
        >
          <HandCoins size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('claimActionBar.readyToClaim')}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {t('claimActionBar.subtitle')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {claims.map((c) => (
              <ClaimRow
                key={c.role}
                claim={c}
                submitting={submitting === c.role}
                onClaim={() => handleClaim(c.role)}
              />
            ))}
          </div>
        </div>
      </div>

      {error && <div style={{ marginTop: 12 }}><ErrorAlert message={error} /></div>}
      {txHash && (
        <div className="alert alert-success" style={{ marginTop: 12 }}>
          <CheckCircle size={16} />
          <span>
            {t('claimActionBar.submitted')}{' '}
            <a href={`${blockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
              {txHash.slice(0, 16)}…<ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
          </span>
        </div>
      )}
    </div>
  );
}

function ClaimRow({
  claim,
  submitting,
  onClaim,
}: {
  claim: ResolvedClaim;
  submitting: boolean;
  onClaim: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: 10,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg-card)',
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: 2 }}>
          {claim.role === 'lender' ? t('claimActionBar.lenderSide') : t('claimActionBar.borrowerSide')}
        </div>
        <div style={{ fontSize: '1.05rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {renderHeadline(claim, t)}
        </div>
        {claim.role === 'lender' && claim.heldForLender > 0n && (
          <div className="stat-label" style={{ fontSize: '0.78rem', marginTop: 2 }}>
            {t('claimActionBar.plusHeldForLender')}{' '}
            <TokenAmount amount={claim.heldForLender} address={claim.asset} withSymbol />
          </div>
        )}
        {claim.role === 'borrower' && claim.lifRebate > 0n && (
          <div className="stat-label" style={{ fontSize: '0.78rem', marginTop: 2 }}>
            {t('claimActionBar.plusLifRebate')}{' '}
            <TokenAmount amount={claim.lifRebate} address="vpfi" decimals={18} /> VPFI
          </div>
        )}
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={onClaim}
        disabled={submitting}
      >
        {submitting ? t('claimActionBar.claiming') : t('claimActionBar.claim')}
      </button>
    </div>
  );
}

function renderHeadline(claim: ResolvedClaim, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (claim.assetType === AssetType.ERC721) {
    return t('claimActionBar.nftId', { id: claim.tokenId.toString() });
  }
  if (claim.assetType === AssetType.ERC1155) {
    return t('claimActionBar.nftIdQuantity', {
      qty: claim.quantity.toString(),
      id: claim.tokenId.toString(),
    });
  }
  return <TokenAmount amount={claim.amount} address={claim.asset} withSymbol />;
}
