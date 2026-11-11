// apps/keeper/src/privateRouteOps.ts
//
// #3408 — the private submission route, bound to the keeper's environment:
// where an accepted private send is recorded, how a public fallback reaches
// the operator, and the tick's run of the inclusion fallback
// (`privateRebroadcast.ts`). The route itself (`submissionRoute.ts`) and the
// broadcast (`submissionQueue.ts`) know nothing of the database or Telegram;
// they report through the events armed here.

import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { getTransactionCount, sendRawTransaction } from 'viem/actions';
import type { Env } from './env';
import { sendOpsAlert } from './opsAlert';
import { rebroadcastStalePrivateSends, type PrivateSendRecords } from './privateRebroadcast';
import { PRIVATE_ENDPOINT_ANSWER_TIMEOUT_MS, type SubmissionRouteEvents, type SubmissionRoutes } from './submissionRoute';

/** One alert key per chain: a burst of fallbacks is one line on the ops
 *  channel, and every fallback is still logged. */
export const PUBLIC_FALLBACK_ALERT_INTERVAL_SEC = 600;

export function publicFallbackAlertKey(chainId: number): string {
  return `private-route-public:${chainId}`;
}

/** A send that left its nonce window unmined and never copied: rarer and
 *  worse than a fallback, so it has its own key. */
export function lapsedSendAlertKey(chainId: number): string {
  return `private-route-lapsed:${chainId}`;
}

/** The ops line for a send that went public on `chain`. */
export function publicFallbackAlertText(chain: { id: number; name: string } | undefined, chainId: number, line: string): string {
  return `⚠️ Keeper private route on ${where(chain, chainId)}: ${line} Further public fallbacks on this chain in the next ${PUBLIC_FALLBACK_ALERT_INTERVAL_SEC / 60} minutes are logged, not alerted. Check the private endpoints in PRIVATE_TX_RPCS.`;
}

/** The ops line for sends that left the nonce window unmined. */
export function lapsedSendAlertText(chain: { id: number; name: string } | undefined, chainId: number, line: string): string {
  return `⚠️ Keeper private route on ${where(chain, chainId)}: ${line} Further such sends on this chain in the next ${PUBLIC_FALLBACK_ALERT_INTERVAL_SEC / 60} minutes are logged, not alerted. Check that the keeper's ticks are running and the private endpoints in PRIVATE_TX_RPCS.`;
}

function where(chain: { id: number; name: string } | undefined, chainId: number): string {
  return chain ? `${chain.name} (${chainId})` : `chain ${chainId}`;
}

type ChainRef = { id: number; name: string; rpc: string };

/** The events a private broadcast reports through, for this tick's env. */
export function privateRouteEvents(env: Env, chains: readonly ChainRef[], records: PrivateSendRecords): SubmissionRouteEvents {
  return {
    privateAccepted: (send) => records.write(send),
    publicFallback: async (chainId, line) => {
      const chain = chains.find((c) => c.id === chainId);
      await sendOpsAlert(
        env,
        publicFallbackAlertKey(chainId),
        publicFallbackAlertText(chain, chainId, line),
        PUBLIC_FALLBACK_ALERT_INTERVAL_SEC,
        Math.floor(Date.now() / 1000),
        chainId,
      );
    },
  };
}

/** The tick's run of the inclusion fallback. Nothing is read unless some
 *  served chain's private route allows a public fallback. */
export async function runPrivateRebroadcast(
  env: Env,
  chains: readonly ChainRef[],
  routes: SubmissionRoutes,
  records: PrivateSendRecords,
  notAfterMs: number,
): Promise<void> {
  if ('unread' in routes) return;
  const served = chains.filter((c) => routes.routes.get(c.id)?.fallback === true);
  if (served.length === 0) return;
  const clients = new Map<number, PublicClient>();
  const client = (chainId: number): PublicClient => {
    let c = clients.get(chainId);
    if (!c) {
      const rpc = served.find((x) => x.id === chainId)!.rpc;
      // No transport retries and a bounded answer: a copy must reach the node
      // well inside its cutoff, and a read or send that fails is tried again
      // next tick (`PUBLIC_COPY_CUTOFF_MS`).
      c = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: PRIVATE_ENDPOINT_ANSWER_TIMEOUT_MS }) }) as PublicClient;
      clients.set(chainId, c);
    }
    return c;
  };
  const events = privateRouteEvents(env, chains, records);
  const lapsed = async (chainId: number, line: string) => {
    await sendOpsAlert(
      env,
      lapsedSendAlertKey(chainId),
      lapsedSendAlertText(chains.find((c) => c.id === chainId), chainId, line),
      PUBLIC_FALLBACK_ALERT_INTERVAL_SEC,
      Math.floor(Date.now() / 1000),
      chainId,
    );
  };
  const lines = await rebroadcastStalePrivateSends(
    routes,
    served,
    {
      records,
      minedCount: (chainId, address: Address) => getTransactionCount(client(chainId), { address, blockTag: 'latest' }),
      sendPublic: (chainId, serialized: Hex) => sendRawTransaction(client(chainId), { serializedTransaction: serialized }),
      alert: (chainId, kind, line) => (kind === 'public' ? events.publicFallback(chainId, line) : lapsed(chainId, line)),
      now: Date.now,
    },
    notAfterMs,
  );
  // eslint-disable-next-line no-console
  for (const line of lines) console.log(`[keeper] privateRebroadcast ${line}`);
}
