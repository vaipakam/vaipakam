/**
 * The contract's own answer to "may this lender sell this position right
 * now, and if not, why" (#1841), read from
 * `SaleExitVerdictFacet.saleExitVerdict(loanId, caller)`.
 *
 * The lender exit chooser used to assemble that answer itself, from
 * whatever the page happened to be reading: the live status, two term
 * reads reconciled against each other, the listing lock, the chain's
 * listing window, the collateral kind. Each was a copy of a rule the sale
 * entries own, and each drifted — #1839 spent seventeen review rounds on
 * them, and ten refusals were never represented at all
 * (`docs/DesignsAndPlans/SaleExitPreviewVerdict.md`). The facet now
 * classifies every refusal once, and both sale entries raise the first
 * refusal it returns, so the chooser reads that and no copy is kept here.
 *
 * A refusal is the ABI-encoded custom error the entry raises, decoded
 * against the Diamond ABI. There is no code table to mirror: a reason the
 * app does not recognise still arrives as a refusal and is shown as one,
 * never as clear.
 *
 * What a clear verdict does NOT say, per the facet: anything about the
 * buy offer a direct sale would consume, the listing's own inputs, or a
 * keeper's capacity charge. So "no refusal" means the loan and this
 * wallet may sell, not that a particular sale will succeed.
 */
import { useQuery } from '@tanstack/react-query';
import { decodeErrorResult, type Address, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { isMissingSelectorError } from '../contracts/preflights';

/** One reason a sale route is refused. */
export interface SaleRefusal {
  /** The custom error's name, or `null` when the Diamond ABI this build
   *  carries cannot decode it (a Diamond newer than the app). */
  error: string | null;
  /** The error's decoded arguments, in declaration order. */
  args: readonly unknown[];
  /** The earliest unix time this refusal can lift by time alone or by a
   *  step anyone may take; `null` when the contract names no time (it
   *  needs a decision, or never lifts). */
  reopensAt: number | null;
}

/** The verdict as the chooser consumes it.
 *
 *  `unserved` is its own state, not a failure: a Diamond cut before
 *  #1841 has no `saleExitVerdict` selector and answers
 *  `FunctionDoesNotExist()` every time, so it is a fact about the
 *  deployment that no retry will change. The chooser says so rather than
 *  offering a sale it cannot check. */
export type SaleExitVerdict =
  | { kind: 'checking' }
  | { kind: 'failed' }
  | { kind: 'unserved' }
  | { kind: 'known'; direct: SaleRefusal[]; listing: SaleRefusal[] };

/** The verdict plus whether its read has stopped — a refetch in flight
 *  can still change a `known` answer, which the chooser's readiness
 *  attribute must not publish as settled. */
export interface SaleExitVerdictRead {
  verdict: SaleExitVerdict;
  settled: boolean;
}

interface RawRefusal {
  reason: Hex;
  reopensAt: bigint;
}

/** Decode one route's refusals. Pure, so the decoding is tested without a
 *  chain. */
export function decodeSaleRefusals(raw: readonly RawRefusal[]): SaleRefusal[] {
  return raw.map((r) => {
    const reopensAt = r.reopensAt === 0n ? null : Number(r.reopensAt);
    try {
      const decoded = decodeErrorResult({ abi: DIAMOND_ABI_VIEM, data: r.reason });
      return { error: decoded.errorName, args: decoded.args ?? [], reopensAt };
    } catch {
      return { error: null, args: [], reopensAt };
    }
  });
}

/**
 * Read the verdict for `loanId` as submitted by `caller`.
 *
 * Caller-relative by the contract's definition (only the holder may sell
 * directly; a keeper may list), so the wallet is part of the query key
 * and a wallet change is a new read, never a reuse.
 */
export function useSaleExitVerdict(
  loanId: number,
  caller: Address | undefined,
  enabled: boolean,
): SaleExitVerdictRead {
  const { readChain } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const query = useQuery({
    queryKey: ['saleExitVerdict', readChain.chainId, loanId, caller?.toLowerCase()],
    enabled: enabled && Boolean(readClient) && Boolean(caller),
    refetchInterval: tipAware(30_000, Boolean(readChain.wsUrl)),
    queryFn: async () => {
      const [direct, listing] = (await readClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'saleExitVerdict',
        args: [BigInt(loanId), caller!],
      })) as readonly [readonly RawRefusal[], readonly RawRefusal[]];
      return { direct: decodeSaleRefusals(direct), listing: decodeSaleRefusals(listing) };
    },
    // A missing selector will not appear on a retry.
    retry: (failures, err) => !isMissingSelectorError(err) && failures < 2,
  });
  return {
    verdict: verdictOf(query),
    settled: query.fetchStatus === 'idle',
  };
}

/** The query's state as a verdict. Exported for the tests. */
export function verdictOf(q: {
  data: { direct: SaleRefusal[]; listing: SaleRefusal[] } | undefined;
  error: unknown;
  isError: boolean;
}): SaleExitVerdict {
  // An answer counts only while the latest fetch succeeded (the
  // `freshData` rule): a cached "open" outliving a failed refresh would
  // offer a sale on a position whose state has not been re-checked.
  if (q.isError) return isMissingSelectorError(q.error) ? { kind: 'unserved' } : { kind: 'failed' };
  if (q.data === undefined) return { kind: 'checking' };
  return { kind: 'known', direct: q.data.direct, listing: q.data.listing };
}
