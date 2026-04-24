/**
 * Push Protocol notification helpers.
 *
 * Push Protocol's REST API lets a channel (identified by its signer
 * address) broadcast a targeted notification to a subscriber. Our
 * watcher signs + sends on behalf of the Vaipakam channel.
 *
 * TODO(ops): replace the placeholder endpoint + signing flow with the
 * real @pushprotocol/restapi SDK call once we finalise the channel
 * address and fund the staking deposit. The code below is shaped
 * correctly for the final drop-in so the watcher wiring doesn't need
 * to change — only the `sendPush` body grows.
 */

export interface PushPayload {
  subscriber: string; // 0x-hex wallet address (EIP-155 format or CAIP-2)
  title: string;
  body: string;
  deepLinkUrl?: string;
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
    // TODO(ops): replace with real Push API call, e.g.:
    //   import { PushAPI, CONSTANTS } from '@pushprotocol/restapi';
    //   const channel = await PushAPI.initialize(signer, { env: CONSTANTS.ENV.PROD });
    //   await channel.channel.send([`eip155:1:${payload.subscriber}`], {
    //     notification: { title: payload.title, body: payload.body },
    //     payload: { cta: payload.deepLinkUrl ?? '' }
    //   });
    //
    // The @pushprotocol/restapi SDK has native Cloudflare-Worker
    // compatibility as of v1.6 — no polyfills needed.
    console.log(
      `[push] stub dispatch subscriber=${payload.subscriber} title="${payload.title}"`,
    );
  } catch (err) {
    console.error(
      `[push] send failed subscriber=${payload.subscriber} err=${String(err).slice(0, 200)}`,
    );
  }
}
