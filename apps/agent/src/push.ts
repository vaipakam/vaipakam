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
/**
 * Suppress ONLY the pinned SDK's request-payload log line.
 *
 * `@pushprotocol/restapi@0.0.1` logs its entire `apiPayload` immediately
 * before the POST — `src/lib/payloads/sendNotifications.js:81`,
 * `console.log('\n\nAPI call :-->> ', requestURL, '\n\n', apiPayload, ...)`.
 * That payload carries `recipients` in CAIP form, i.e. the subscriber's wallet
 * address, next to the notification title and body. So every successful send
 * wrote a wallet-to-event trail into the Worker log, and omitting the
 * subscriber from OUR log line did nothing about it (#1450 r24). The comment
 * that used to sit near the success log claimed the exposure was closed; it
 * was not.
 *
 * FILTERED, not silenced. Replacing `console.log` wholesale for the duration
 * of the call would also drop anything logged concurrently — `console` is an
 * isolate-wide global and this call is awaited — so this matches the SDK's
 * literal marker on the FIRST argument, where the SDK puts it, and passes
 * everything else through.
 *
 * If the pin ever moves, re-check that marker: a changed prefix means this
 * silently stops filtering, and that failure is invisible by construction.
 */
async function withSdkPayloadLogSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  const real = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('API call :-->> ')) return;
    real(...args);
  };
  try {
    return await fn();
  } finally {
    console.log = real;
  }
}

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
    await withSdkPayloadLogSuppressed(() =>
      PushAPI.payloads.sendNotification({
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
      }),
    );
    // #1450 — a POSITIVE signal, deliberately. Only the unset-key and
    // failure branches logged before, so a channel Push does not recognise
    // produced two quiet tails and looked exactly like "no eligible events
    // yet". That made the incident runbook's post-rotation verification step
    // unsound: an operator could watch nothing happen and conclude the
    // migration worked. The channel is logged because it is the field a
    // rotation changes and the one worth eyeballing.
    //
    // The subscriber is deliberately NOT logged (#1450 r13). This branch is
    // routine — it fires on every HF-band, pre-grace and periodic-payment
    // notification — so including the address would build a standing
    // wallet-to-event-timestamp trail in Cloudflare observability as a side
    // effect of a verification aid. The failure branch below still carries
    // it: that one is exceptional, and there the address is the diagnostic.
    console.log(`[push] sent channel=${channelCaip}`);
  } catch (err) {
    console.error(
      `[push] send failed subscriber=${payload.subscriber} err=${String(err).slice(0, 200)}`,
    );
  }
}
