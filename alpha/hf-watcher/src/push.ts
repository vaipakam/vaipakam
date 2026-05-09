/**
 * Push Protocol notification helpers.
 *
 * Push Protocol's REST API lets a channel (identified by its signer
 * address) broadcast a targeted notification to a subscriber. Our
 * watcher signs + sends on behalf of the Vaipakam channel.
 *
 * Channel: https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b
 *
 * Setup state (operator-side, one-time, completed):
 *   1. Channel created on app.push.org with the address above as
 *      the channel signer.
 *   2. 50 PUSH staking deposit posted.
 *   3. Channel signer privkey stored in `PUSH_CHANNEL_PK` as a
 *      Cloudflare Worker secret (encrypted, never in source).
 *
 * Runtime: each watcher cron tick that sees a HF band crossing for a
 * subscribed user calls `sendPush(...)`. The function is fail-soft —
 * a Push API outage logs and returns, so a single Push hiccup never
 * stalls the broader watcher loop or blocks the Telegram rail.
 *
 * SDK note: `@pushprotocol/restapi@^1.7` exposes the legacy
 * modular API (`payloads.sendNotification(...)`), not the v2
 * `PushAPI` class — the docs site documents both, only the v1 form
 * is available on the version range we install. Push channels live
 * on Ethereum mainnet by default, so the CAIP-2 prefix is
 * `eip155:1` for both channel id and recipient id; the recipient
 * wallet's actual chain doesn't need to match (Push routes by raw
 * wallet, the chain prefix is metadata).
 */

import * as PushAPI from '@pushprotocol/restapi';
import { Wallet } from 'ethers';

// Push channels live on Ethereum mainnet; the CAIP-2 prefix is
// shared across both the channel id and recipient ids.
const CAIP_PREFIX = 'eip155:1';

export interface PushPayload {
  subscriber: string; // 0x-hex wallet address (we add the CAIP-2 prefix)
  title: string;
  body: string;
  deepLinkUrl?: string;
}

/**
 * Cache the (signer, channel CAIP id) pair derived from the privkey
 * at module scope so we only pay the address-derivation cost once
 * per Worker isolate. The Worker recycles its isolate periodically;
 * the cache rebuilds automatically on the next cold start.
 */
let cachedSignerKey: string | null = null;
let cachedSigner: Wallet | null = null;
let cachedChannelCaip: string | null = null;

function getSignerAndChannel(channelPk: string): {
  signer: Wallet;
  channelCaip: string;
} {
  if (cachedSignerKey === channelPk && cachedSigner && cachedChannelCaip) {
    return { signer: cachedSigner, channelCaip: cachedChannelCaip };
  }
  // Normalise to 0x-prefix — ethers.Wallet rejects naked hex.
  const pk = channelPk.startsWith('0x') ? channelPk : `0x${channelPk}`;
  const signer = new Wallet(pk);
  const channelCaip = `${CAIP_PREFIX}:${signer.address}`;
  cachedSignerKey = channelPk;
  cachedSigner = signer;
  cachedChannelCaip = channelCaip;
  return { signer, channelCaip };
}

/**
 * Fire-and-forget Push notification. Returns without throwing so a
 * single API hiccup doesn't kill the cron tick.
 *
 * When `channelPk` is missing (dev / pre-launch), the function no-ops
 * and logs — useful to exercise the rest of the cron without a
 * real Push channel configured.
 */
export async function sendPush(
  channelPk: string | undefined,
  payload: PushPayload,
): Promise<void> {
  if (!channelPk) {
    console.log(
      `[push] skipping (PUSH_CHANNEL_PK unset) subscriber=${payload.subscriber} title="${payload.title}"`,
    );
    return;
  }
  try {
    const { signer, channelCaip } = getSignerAndChannel(channelPk);
    await PushAPI.payloads.sendNotification({
      signer,
      // type=3 → targeted notification to a single recipient.
      // type=1 is broadcast-to-all-subscribers; type=4 is a subset
      // of subscribers. We only ever fan out individual HF alerts,
      // so 3 is the right shape.
      type: 3,
      // identityType=2 → direct payload (no IPFS / Graph indirection).
      // The notification body travels with the Push API request rather
      // than being hash-pointed at off-chain storage. Cheapest + most
      // reliable for short-lived alert content.
      identityType: 2,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      payload: {
        title: payload.title,
        body: payload.body,
        cta: payload.deepLinkUrl ?? '',
        img: '',
      },
      recipients: `${CAIP_PREFIX}:${payload.subscriber}`,
      channel: channelCaip,
      env: 'prod',
    });
  } catch (err) {
    console.error(
      `[push] send failed subscriber=${payload.subscriber} err=${String(err).slice(0, 200)}`,
    );
  }
}
