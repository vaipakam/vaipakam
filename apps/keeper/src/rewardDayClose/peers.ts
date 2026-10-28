// apps/keeper/src/rewardDayClose/peers.ts
//
// Every read of another chain goes through a peer the run has ATTESTED: the
// Diamond its RPC serves names itself (its reward reporter config's local
// chain id) as the chain it is read for. An RPC pointed at the wrong chain,
// where a deterministic deployment puts a Diamond at the same address, would
// otherwise answer for another chain, and the run would close, finalize or
// call a day delivered on that chain's facts.
//
// A peer that cannot be attested (the identity read failed, or names another
// chain) is read as UNREADABLE for the whole run: every read of it fails, so
// every rule that waits on a read holds, and the run says which peer and why.
// It is never treated as unserved, which some rules accept.

import { createPublicClient, custom, type PublicClient } from 'viem';
import { PastRunDeadline } from '../batchRead';
import { ABI } from './constants';
import type { DayCloseDeps, PeerReader } from './deps';
import { shortErr } from '../callErrors';

export interface Peers {
  /** The attested reader of chain `id` (null = not served by this keeper). */
  peer(id: number): Promise<PeerReader | null>;
  /** Peers read as unreadable this run, with why. */
  unattested: Map<number, string>;
}

/** A client every request of which fails with `why`. */
function unreadable(why: string): PublicClient {
  return createPublicClient({
    transport: custom(
      {
        request: async () => {
          throw new Error(why);
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
}

/** The chain id a Diamond names itself as, from its reporter config. */
export async function localChainIdOf(client: PublicClient, diamond: PeerReader['diamond']): Promise<number> {
  const cfg = (await client.readContract({ address: diamond, abi: ABI, functionName: 'getRewardReporterConfig', args: [] })) as readonly unknown[];
  return Number(cfg[1]);
}

export function attestedPeers(deps: DayCloseDeps, where: string): Peers {
  const unattested = new Map<number, string>();
  const cache = new Map<number, Promise<PeerReader | null>>();
  const attest = async (id: number): Promise<PeerReader | null> => {
    const p = deps.peer(id);
    if (p === null) return null;
    let why: string | null = null;
    try {
      const named = await localChainIdOf(p.client, p.diamond);
      if (named !== id) why = `the Diamond its RPC serves at ${p.diamond} names itself chain ${named}, so the RPC configured for chain ${id} answers for another chain`;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      why = `the read of which chain its Diamond names itself failed (${shortErr(err)})`;
    }
    if (why === null) return p;
    console.error(`[keeper] rewardDayClose ${where}: chain ${id} read as unreadable this run: ${why}`);
    unattested.set(id, why);
    return { diamond: p.diamond, client: unreadable(`chain ${id} is not attested this run: ${why}`) };
  };
  return {
    unattested,
    peer(id) {
      let p = cache.get(id);
      if (p === undefined) {
        p = attest(id);
        cache.set(id, p);
      }
      return p;
    },
  };
}
