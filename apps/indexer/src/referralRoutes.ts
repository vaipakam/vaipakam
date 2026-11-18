/**
 * #3727 — GET /referrals/by-inviter/{address}?chainId=…: what one inviter's
 * invitations have paid on one network (ReferralFeeShareDesign.md 6.1).
 *
 * Answers the wallets that bound this inviter (each with its own end time,
 * as its binding event states it, and the loans that carried a share), the
 * shares paid to the inviter's wallet with a total per asset, and the
 * shares sent to the reserve instead with the reason each event gave. The
 * figures are current to `indexedThroughBlock`. Per network only.
 *
 * Unreadable answers 503 with null lists: the page then says it cannot show
 * the figures, never that there are none.
 */
import type { Env } from './env';
import { chainNotServed, requestedChainId } from './servedChain';
import { jsonResponse } from './offerRoutes';
import { inviterReferrals } from './referralRecord';
import { CURSOR_KIND } from './chainIndexer';
import { redactedError } from '@vaipakam/lib/errorDescription';

export async function handleInviterReferrals(req: Request, env: Env, address: string): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    return jsonResponse(await inviterReferrals(env, chainId, address, CURSOR_KIND));
  } catch (err) {
    console.error('[referralRoutes] read failed', redactedError(err));
    return jsonResponse(
      {
        chainId,
        inviter: address.toLowerCase(),
        indexedThroughBlock: null,
        invited: null,
        received: null,
        sentToReserve: null,
      },
      503,
    );
  }
}
