/**
 * #1209 — the interest a wallet earned on lender positions it SOLD.
 *
 * A lender sale no longer gives up the seller's earned interest: it becomes a
 * seller claim on the loan, paid ahead of the current holder as the borrower
 * pays interest, into the seller's vault, and settled once at the loan's end
 * (the holder's principal first). The seller holds no position NFT any more,
 * so the claims are found from the claim records themselves:
 *
 * - DISCOVERY: the indexer files every seller-claim event under the seller
 *   (the shared actor rule, `@vaipakam/lib/activityActor`), so the loans a
 *   wallet holds a claim on are its `SellerInterestClaimRecorded` rows.
 * - TRUTH: each candidate is read from the chain: the open claims on the
 *   loan's interest ledger, what is waiting in the seller's vault, and a
 *   simulation of the withdrawal, which is the authority on whether it would
 *   pay anything now.
 *
 * Nothing here is a confident partial answer: an unavailable indexer is
 * `null`, a loan that could not be read is listed as unread, and a list cut
 * short by its page cap says so.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { signalAware } from '../chain/railHealth';
import { submitErrorText } from '../lib/errors';
import { fetchActivity } from './indexer';
import { isRevert } from './liveLoanRow';

const ZERO = '0x0000000000000000000000000000000000000000';
/** Rows per indexer page (its own maximum). */
const PAGE = 200;
/** Pages read before the list is cut short and says so. */
const MAX_PAGES = 5;
const REFRESH_MS = 60_000;

/** Whether the seller's withdrawal would pay anything right now, from a
 *  simulation of `claimAsSeller`. */
export type SellerWithdrawVerdict =
  /** It would pay: something is waiting, or the loan's end settles it now. */
  | { kind: 'ready' }
  /** Nothing has reached the seller's vault yet. */
  | { kind: 'nothing-yet' }
  /** The protocol would refuse it, for the reason given. */
  | { kind: 'refused'; reason: string }
  /** The check itself failed. */
  | { kind: 'unknown' };

export interface SellerClaimRow {
  loanId: number;
  /** The loan's on-chain status (`LoanStatus`). */
  status: number;
  principalAsset: Address;
  /** What this seller's open claims are still owed, GROSS of the
   *  protocol's cut, in the principal asset. 0 once the loan's end has
   *  closed them. */
  owedGross: bigint;
  /** What is waiting in the seller's vault for them, per asset (only the
   *  non-zero ones). */
  held: { asset: Address; amount: bigint }[];
  withdraw: SellerWithdrawVerdict;
}

export interface SellerClaims {
  rows: SellerClaimRow[];
  /** Loans found but not read (a failed read), named rather than dropped. */
  unread: number[];
  /** The seller has more sales than the pages read cover. */
  truncated: boolean;
}

/** The loans a wallet recorded a seller claim on, newest first, from the
 *  indexer. `null` when the indexer could not answer. */
export async function sellerClaimLoanIds(
  chainId: number,
  seller: string,
): Promise<{ loanIds: number[]; truncated: boolean } | null> {
  const seen = new Set<number>();
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchActivity(chainId, {
      actor: seller,
      kind: 'SellerInterestClaimRecorded',
      limit: PAGE,
      before,
    });
    if (!res) return null;
    for (const e of res.events) {
      if (typeof e.loanId === 'number') seen.add(e.loanId);
    }
    if (!res.nextBefore) return { loanIds: [...seen], truncated: false };
    before = res.nextBefore;
  }
  return { loanIds: [...seen], truncated: true };
}

type Ctx = { client: PublicClient; diamond: Address; seller: Address };

/** One loan's seller claim for `seller`, read from the chain. `null` when
 *  nothing is open or waiting for them on it. Throws when a read fails. */
export async function readSellerClaim(ctx: Ctx, loanId: number): Promise<SellerClaimRow | null> {
  const { client, diamond, seller } = ctx;
  const id = BigInt(loanId);
  const [details, ledger, lenderClaim] = await Promise.all([
    client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getLoanDetails',
      args: [id],
    }) as Promise<{ status: number; principalAsset: Address }>,
    client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getInterestLedger',
      args: [id],
    }) as Promise<readonly [bigint, bigint, number, readonly { seller: Address; grossOwed: bigint }[]]>,
    client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getClaimable',
      args: [id, true],
    }) as Promise<readonly [Address, ...unknown[]]>,
  ]);
  const me = seller.toLowerCase();
  const owedGross = ledger[3]
    .filter((c) => c.seller.toLowerCase() === me)
    .reduce((sum, c) => sum + c.grossOwed, 0n);
  // The withdrawal pays the principal asset and, after an in-kind recovery,
  // the lender claim's own asset (`SellerClaimFacet.claimAsSeller`).
  const assets: Address[] = [details.principalAsset];
  const claimAsset = lenderClaim[0];
  if (claimAsset && claimAsset !== ZERO && claimAsset.toLowerCase() !== details.principalAsset.toLowerCase()) {
    assets.push(claimAsset);
  }
  const amounts = await Promise.all(
    assets.map(
      (asset) =>
        client.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getSellerInterestHeld',
          args: [id, seller, asset],
        }) as Promise<bigint>,
    ),
  );
  const held = assets
    .map((asset, i) => ({ asset, amount: amounts[i] }))
    .filter((h) => h.amount > 0n);
  if (owedGross === 0n && held.length === 0) return null;
  return {
    loanId,
    status: Number(details.status),
    principalAsset: details.principalAsset,
    owedGross,
    held,
    withdraw: await simulateSellerWithdraw(ctx, loanId),
  };
}

/** Whether `claimAsSeller(loanId)` would pay `seller` anything now. */
export async function simulateSellerWithdraw(
  ctx: Ctx,
  loanId: number,
): Promise<SellerWithdrawVerdict> {
  try {
    await ctx.client.simulateContract({
      account: ctx.seller,
      address: ctx.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'claimAsSeller',
      args: [BigInt(loanId)],
    });
    return { kind: 'ready' };
  } catch (err) {
    const revert =
      err instanceof BaseError
        ? (err.walk((e) => e instanceof ContractFunctionRevertedError) as
            | ContractFunctionRevertedError
            | null)
        : null;
    if (revert?.data?.errorName === 'NothingToClaimAsSeller') return { kind: 'nothing-yet' };
    if (isRevert(err)) return { kind: 'refused', reason: submitErrorText(err) };
    return { kind: 'unknown' };
  }
}

/** Every loan the connected wallet holds a seller claim on, or something
 *  waiting from one. `null` = the indexer could not list them. */
export function useMySellerClaims() {
  const { readChain, address } = useActiveChain();
  const client = usePublicClient({ chainId: readChain.chainId });
  const diamond = readChain.diamondAddress as Address;
  return useQuery({
    queryKey: ['sellerClaims', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(client),
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<SellerClaims | null> => {
      if (!address || !client) return null;
      const found = await sellerClaimLoanIds(readChain.chainId, address);
      if (!found) return null;
      const ctx: Ctx = { client: client as PublicClient, diamond, seller: address as Address };
      const rows: SellerClaimRow[] = [];
      const unread: number[] = [];
      await Promise.all(
        found.loanIds.map(async (loanId) => {
          try {
            const row = await readSellerClaim(ctx, loanId);
            if (row) rows.push(row);
          } catch {
            unread.push(loanId);
          }
        }),
      );
      rows.sort((a, b) => b.loanId - a.loanId);
      unread.sort((a, b) => b - a);
      return { rows, unread, truncated: found.truncated };
    },
  });
}
