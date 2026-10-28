/**
 * Runs the periodic-interest aggregate for one loan (#2524). The plan, the
 * mapper and the view are pure and live in `periodicInterest.ts`; this is
 * only the query around them.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';
import { multicall3Of, readAggregate } from '../contracts/aggregate';
import { periodicFacts, periodicReadPlan, periodicView, type PeriodicView } from './periodicInterest';

const REFETCH_MS = 30_000;

export const periodicInterestKey = (chainId: number, loanId: string | number) =>
  ['periodicInterest', chainId, String(loanId)] as const;

/** Reads the period again, now, for the gate a write runs behind. */
export async function readPeriodicView(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  diamond: `0x${string}`,
  loanId: string | number,
): Promise<PeriodicView | undefined> {
  const plan = periodicReadPlan({
    diamond,
    multicall3: multicall3Of(publicClient),
    loanId: BigInt(loanId),
  });
  // One `eth_call`: the block slot dates every fact, and a provider failure
  // rejects (a query error) instead of failing every slot.
  const slots = await readAggregate(
    publicClient,
    plan.map((e) => e.contract),
  );
  const facts = periodicFacts(plan, slots);
  return facts === undefined ? undefined : periodicView(facts);
}

export interface PeriodicInterestRead {
  /** `undefined` while loading, after a failed read, or when the chain's
   *  answer could not be dated or described — see `isError` / `unread`. */
  view: PeriodicView | undefined;
  isLoading: boolean;
  /** The read failed, or answered with something it could not describe.
   *  A retained earlier answer is NOT shown in that case: a stale "not due
   *  yet" kept through a failed refetch is the error this card exists to
   *  avoid. */
  unread: boolean;
}

export function usePeriodicInterest(opts: {
  loanId: string | number | undefined;
  /** Mount the read only where the card can render: an active loan on a
   *  schedule. Everything else pays RPC for an answer nothing shows. */
  enabled: boolean;
}): PeriodicInterestRead {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const diamond = readChain.diamondAddress as `0x${string}`;
  const on = opts.enabled && opts.loanId !== undefined && Boolean(publicClient);
  const q = useQuery({
    queryKey: periodicInterestKey(readChain.chainId, opts.loanId ?? ''),
    enabled: on,
    refetchInterval: tipAware('periodicInterest', REFETCH_MS, Boolean(readChain.wsUrl)),
    // `null` (not `undefined`) for an answer that could not be described,
    // so TanStack keeps it as data and the card can say it is unread.
    queryFn: async () => (await readPeriodicView(publicClient!, diamond, opts.loanId!)) ?? null,
  });
  const view = q.isError || q.data === null ? undefined : q.data;
  return {
    view,
    isLoading: on && q.isLoading,
    unread: on && (q.isError || q.data === null),
  };
}
