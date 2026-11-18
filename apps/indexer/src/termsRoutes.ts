/**
 * #3734 — GET /terms/{address}?chainId=…: where one wallet stands on the
 * Terms of Service on one network, as the indexer reads the on-chain record.
 *
 * Answers the versions the wallet accepted (each with its fingerprint, time
 * and transaction), the network's record (versions in force, minimum,
 * latest, and an announced change still waiting), and the wallet's standing
 * now. Per network only: an acceptance on another network never counts.
 *
 * An unreadable record answers 503 with `standing.state = 'unknown'`; the
 * apps treat that as not current (closed), never as current. The contract
 * remains the authority: this read is for display and for lists.
 */
import type { Env } from './env';
import { chainNotServed, requestedChainId } from './servedChain';
import { jsonResponse } from './offerRoutes';
import { walletTerms } from './termsStanding';
import { redactedError } from '@vaipakam/lib/errorDescription';

export async function handleTermsWallet(req: Request, env: Env, address: string): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    const body = await walletTerms(env, chainId, address);
    return jsonResponse(body, body.standing.state === 'unknown' ? 503 : 200);
  } catch (err) {
    console.error('[termsRoutes] read failed', redactedError(err));
    return jsonResponse(
      { chainId, wallet: address.toLowerCase(), standing: { state: 'unknown' }, accepted: null, record: null },
      503,
    );
  }
}
