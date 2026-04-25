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
 */

import { PushAPI, CONSTANTS } from '@pushprotocol/restapi';
import { Wallet } from 'ethers';

export interface PushPayload {
  subscriber: string; // 0x-hex wallet address (EIP-155 format or CAIP-2)
  title: string;
  body: string;
  deepLinkUrl?: string;
}

/**
 * Lazy-initialized PushAPI client cached at module scope. Push's
 * `initialize` hits the network once to register the signer, so
 * caching the instance amortises that cost across every send within
 * a single Worker isolate's lifetime. The Worker recycles its
 * isolate periodically and the cache is rebuilt automatically on
 * the next invocation.
 */
let pushClient: Awaited<ReturnType<typeof PushAPI.initialize>> | null = null;
let pushClientForKey: string | null = null;

async function getPushClient(channelPk: string) {
  if (pushClient && pushClientForKey === channelPk) return pushClient;
  // Normalise to 0x-prefix — ethers.Wallet rejects naked hex.
  const pk = channelPk.startsWith('0x') ? channelPk : `0x${channelPk}`;
  const signer = new Wallet(pk);
  pushClient = await PushAPI.initialize(signer, {
    env: CONSTANTS.ENV.PROD,
  });
  pushClientForKey = channelPk;
  return pushClient;
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
    const channel = await getPushClient(channelPk);
    // Targeted send to one subscriber. The CAIP-2 `eip155:1:`
    // prefix is the SUBSCRIBER's chain context (we use mainnet's
    // namespace as the canonical wallet identifier — Push routes
    // by wallet address, the chain hint is metadata for the
    // subscriber-side filter UI).
    await channel.channel.send([`eip155:1:${payload.subscriber}`], {
      notification: {
        title: payload.title,
        body: payload.body,
      },
      payload: {
        title: payload.title,
        body: payload.body,
        cta: payload.deepLinkUrl ?? '',
        embed: '',
      },
    });
  } catch (err) {
    console.error(
      `[push] send failed subscriber=${payload.subscriber} err=${String(err).slice(0, 200)}`,
    );
  }
}
