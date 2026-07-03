import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { Address, PublicClient } from 'viem';
import { fetchClaimables, type ClaimablesResponse } from '../indexer/claimables.js';
import { fetchAllLoansForWallet } from '../indexer/loans.js';
import { ASSET_TYPE_ERC20 } from '../types/offers.js';
import type { IndexedLoan } from '../types/loans.js';

const CLAIMABLE_STATUSES = new Set<IndexedLoan['status']>([
  'repaid',
  'defaulted',
  'liquidated',
  'fallback_pending',
  'internal_matched',
]);

interface ClaimableTuple {
  asset?: string;
  amount?: bigint;
  claimed?: boolean;
  assetType?: bigint;
  tokenId?: bigint;
  quantity?: bigint;
  heldForLender?: bigint;
  hasRentalNftReturn?: boolean;
  0?: string;
  1?: bigint;
  2?: boolean;
  3?: bigint;
  4?: bigint;
  5?: bigint;
  6?: bigint;
  7?: boolean;
}

function mergeLoanSide(existing: IndexedLoan[], extra: IndexedLoan[]): IndexedLoan[] {
  const byId = new Map(existing.map((l) => [l.loanId, l]));
  for (const loan of extra) {
    if (!byId.has(loan.loanId)) byId.set(loan.loanId, loan);
  }
  return [...byId.values()];
}

async function borrowerLifRebate(
  publicClient: PublicClient,
  diamondAddress: Address,
  loanId: number,
): Promise<bigint> {
  try {
    const rebate = (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getBorrowerLifRebate',
      args: [BigInt(loanId)],
    })) as readonly [bigint, bigint] | { rebateAmount?: bigint };
    if (Array.isArray(rebate)) return rebate[0] ?? 0n;
    return (rebate as { rebateAmount?: bigint }).rebateAmount ?? 0n;
  } catch {
    return 0n;
  }
}

async function sideClaimActionable(
  publicClient: PublicClient,
  diamondAddress: Address,
  loanId: number,
  isLender: boolean,
): Promise<boolean> {
  try {
    const res = (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getClaimable',
      args: [BigInt(loanId), isLender],
    })) as ClaimableTuple;
    const amount = res.amount ?? res[1] ?? 0n;
    const claimed = res.claimed ?? res[2] ?? false;
    const assetType = Number(res.assetType ?? res[3] ?? 0n);
    const heldForLender = res.heldForLender ?? res[6] ?? 0n;
    const hasRentalNftReturn = res.hasRentalNftReturn ?? res[7] ?? false;
    const lifRebate = !isLender ? await borrowerLifRebate(publicClient, diamondAddress, loanId) : 0n;
    const actionable =
      amount > 0n ||
      assetType !== ASSET_TYPE_ERC20 ||
      heldForLender > 0n ||
      hasRentalNftReturn ||
      lifRebate > 0n;
    return !claimed && actionable;
  } catch {
    return false;
  }
}

/**
 * Indexer `/claimables` plus holder loans in resolution paths the route omits,
 * with optional on-chain `getClaimable` filtering for terminal borrower rows.
 */
export async function fetchWalletClaimables(
  indexerOrigin: string | undefined,
  chainId: number,
  address: string,
  opts: { publicClient?: PublicClient | null; diamondAddress?: Address | null } = {},
): Promise<ClaimablesResponse | null> {
  const wallet = address.toLowerCase();
  const base = await fetchClaimables(indexerOrigin, chainId, wallet);
  if (!base && !indexerOrigin) return null;

  let asLender = base?.asLender ?? [];
  let asBorrower = base?.asBorrower ?? [];

  if (indexerOrigin) {
    const holderLoans = await fetchAllLoansForWallet(indexerOrigin, chainId, wallet);
    const extras = holderLoans.filter((l) => CLAIMABLE_STATUSES.has(l.status));
    const lenderExtras = extras.filter((l) => l.lenderCurrentOwner?.toLowerCase() === wallet);
    const borrowerExtras = extras.filter((l) => l.borrowerCurrentOwner?.toLowerCase() === wallet);
    asLender = mergeLoanSide(asLender, lenderExtras);
    asBorrower = mergeLoanSide(asBorrower, borrowerExtras);
  }

  const publicClient = opts.publicClient;
  const diamondAddress = opts.diamondAddress;
  if (publicClient && diamondAddress) {
    const verifiedBorrower: IndexedLoan[] = [];
    for (const loan of asBorrower) {
      if (loan.status === 'defaulted' || loan.status === 'liquidated') {
        if (await sideClaimActionable(publicClient, diamondAddress, loan.loanId, false)) {
          verifiedBorrower.push(loan);
        }
      } else {
        verifiedBorrower.push(loan);
      }
    }
    asBorrower = verifiedBorrower;
  }

  return { chainId, address: wallet, asLender, asBorrower };
}