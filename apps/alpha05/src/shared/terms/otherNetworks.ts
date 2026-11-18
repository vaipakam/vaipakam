import { useQueries } from '@tanstack/react-query';
import { createPublicClient, http, type Abi, type Hex, type PublicClient } from 'viem';
import { LenderIntentViewFacetABI } from '@vaipakam/contracts/abis';
import { RPC_PROXY_MAX_BATCH } from '@vaipakam/lib/rpcProxyPolicy';
import { readThrough, type OwnStateSource } from '../../chain/ownRail';
import { SUPPORTED_CHAINS, type SupportedChain } from '../../chain/chains';
import { ownRefreshIntervalMs } from '../reads/refreshPolicy';
import { useVisible } from '../reads/useVisible';
import { readMyOffers } from '../offers/myOffers';
import { readPagedList, type IntentRow } from '../vault/holdings';
import { readTerms, type TermsAnnouncement, type TermsState } from './terms';

const INTENT = LenderIntentViewFacetABI as Abi;

/**
 * #3734 design section 7, "Another network": where a wallet stands on one
 * network during the notice of a material change, read from THAT network's
 * contract and never from another's. Two things are kept apart and never
 * merged: the standing now (current or not) and the announced change
 * (covered by an acceptance, or not yet, with its date).
 *
 * What would stop there on the date is what the app can read today: the
 * wallet's open offers and its active Auto-lend. Loans set to extend and
 * standing instructions are not read here, and the step says so rather than
 * implying a network with neither found has nothing.
 */
export interface NetworkTerms {
  /** No Terms are in force there: nothing to accept, nothing stops. */
  none: boolean;
  /** The protocol's verdict on that network now. */
  current: boolean;
  /** The announced change still waiting there, when the wallet's
   *  acceptances do not cover it; null when none is announced or it is
   *  covered. */
  due: TermsAnnouncement | null;
  /** Open offers the wallet made there. */
  openOffers: number;
  /** Auto-lend offers of the wallet's that are active there. */
  autoLend: number;
  /** Both lists were read to their end. */
  complete: boolean;
}

/** The pure part: the standing and the found commitments as one row. */
export function networkTerms(t: TermsState, openOffers: number, autoLend: number, complete: boolean): NetworkTerms {
  if (t.kind === 'none') return { none: true, current: true, due: null, openOffers, autoLend, complete };
  return { none: false, current: t.kind === 'accepted', due: t.kind === 'accepted' ? t.due : (t.posture.announced ?? null), openOffers, autoLend, complete };
}

/** Whether the guided flow lists this network: something found there would
 *  stop on the date of a change the wallet has not covered there. A network
 *  where the wallet is not current is asked at its next use there instead. */
export function listedForNotice(n: NetworkTerms): boolean {
  return !n.none && n.current && n.due !== null && n.openOffers + n.autoLend > 0;
}

export async function readNetworkTerms(client: PublicClient, diamond: Hex, account: Hex): Promise<NetworkTerms> {
  const [terms, offers, intents] = await Promise.all([
    readTerms(client, diamond, account),
    readMyOffers(client, diamond, account),
    readPagedList<IntentRow>(
      (offset, limit) =>
        client.readContract({ address: diamond, abi: INTENT, functionName: 'getLenderIntentsByOwner', args: [account, offset, limit] }) as Promise<
          readonly [readonly IntentRow[], bigint]
        >,
    ),
  ]);
  const openOffers = offers.rows.filter((o) => o.created && o.state === 'open').length;
  const autoLend = intents.assets.filter((r) => r.active).length;
  return networkTerms(terms, openOffers, autoLend, offers.complete && intents.complete);
}

/** The own-rail sources for a network the wallet is not on: the proxy, then
 *  the public endpoint. The wallet's provider answers for its own network
 *  only, so it is not a source here, and each answer names the one used. */
const otherSources = new Map<number, OwnStateSource[]>();
export function otherNetworkSources(chain: SupportedChain): readonly OwnStateSource[] {
  let s = otherSources.get(chain.chainId);
  if (!s) {
    s = chain.rpcEndpoints.map((e) => ({
      via: e.viaProxy ? ('proxy' as const) : ('public' as const),
      client: createPublicClient({
        transport: e.viaProxy ? http(e.url, { batch: { batchSize: RPC_PROXY_MAX_BATCH }, retryCount: 0 }) : http(e.url, { batch: true }),
        batch: { multicall: true },
      }) as PublicClient,
    }));
    otherSources.set(chain.chainId, s);
  }
  return s;
}

export interface OtherNetworkRow {
  chain: SupportedChain;
  state: 'reading' | 'ready' | 'failed';
  data: NetworkTerms | null;
  error: string | null;
  refetch: () => void;
}

/** The wallet's Terms standing on every served network but `exclude`, each
 *  read from that network alone. */
export function useOtherNetworksTerms(account: Hex | null, exclude: number | null): OtherNetworkRow[] {
  const visible = useVisible();
  const chains = SUPPORTED_CHAINS.filter((c) => c.chainId !== exclude);
  const results = useQueries({
    queries: chains.map((chain) => ({
      queryKey: ['own-other', chain.chainId, account, 'terms-network'],
      queryFn: async () => (await readThrough(otherNetworkSources(chain), (c) => readNetworkTerms(c, chain.diamondAddress, account!))).value,
      enabled: account !== null,
      refetchInterval: ownRefreshIntervalMs(visible),
      refetchIntervalInBackground: false,
      retry: 1,
    })),
  });
  return chains.map((chain, i) => {
    const q = results[i]!;
    const state = q.data !== undefined ? 'ready' : q.status === 'error' ? 'failed' : 'reading';
    return { chain, state, data: q.data ?? null, error: q.error ? (q.error as Error).message : null, refetch: () => void q.refetch() };
  });
}
