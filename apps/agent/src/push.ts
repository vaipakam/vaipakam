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
 * SDK note: `@pushprotocol/restapi` (installed: 1.7.32) exposes the
 * legacy modular API (`payloads.sendNotification(...)`) as well as the
 * v2 `PushAPI` class — the docs site documents both, and this call site
 * uses the modular form.
 *
 * THE PIN WAS THE BUG (#2220). It read `^0.0.1`, and on a `0.0.x`
 * version a caret does NOT widen — `^0.0.1` means exactly `0.0.1`, so
 * the range could never reach 1.x. An earlier revision of this comment
 * said `^1.7` and was "corrected" to match the install (#1450 r26);
 * the install was what needed correcting. `0.0.1` also declares
 * `peerDependencies: { ethers: "^5.6.8" }` against a workspace on
 * ethers 6, so the peer requirement had been unsatisfied all along
 * without anything failing loudly. 1.7.32 declares
 * `ethers: "^5.0.0 || ^6.0.0"`, which is the range we actually satisfy.
 *
 * Push channels live on Ethereum mainnet by default, so the CAIP-2 prefix is
 * `eip155:1` for both channel id and recipient id; the recipient
 * wallet's actual chain doesn't need to match (Push routes by raw
 * wallet, the chain prefix is metadata).
 */

import * as PushAPI from '@pushprotocol/restapi';
import { Wallet } from 'ethers';
import { describeFailure } from '@vaipakam/lib/errorDescription';

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
 * Whether a call consumed an outbound request (#2213 r9 `4012940120`).
 *
 * The caller has a subrequest allowance to spend, and it cannot see inside
 * here: an unset key and a malformed one both return quietly, so charging on
 * "we called sendPush" charged for requests that never happened. On a
 * deployment whose signer is misconfigured that is EVERY push, which exhausts
 * the allowance and defers recipients the platform could have reached.
 *
 * THREE ANSWERS, because the caller asks two different questions of them and
 * they do not have the same answer (#2213 r10 `4013087415`):
 *
 * - `not-requested` — the SDK call was never entered: no key, or a key it
 *   cannot build a signer from. No request, so no charge, and nobody told.
 * - `accepted` — the SDK resolved. A request happened, so charge it, and this
 *   is the ONLY answer that justifies telling an operator someone was
 *   reminded.
 * - `failed` — the call was entered and threw. Charge it, because a request
 *   may well have gone; do NOT count it as a reminder, because nobody can say
 *   it arrived.
 *
 * The charge and the count deliberately disagree on `failed`, and that is the
 * point: a ceiling must assume the request happened, and a report must not
 * assume the message did. Folding them into one word is what let a run claim
 * deliveries it had no evidence for.
 *
 * What this still does NOT separate is whether a throw came before or after
 * the POST. That would be a guess about an error's shape, the kind this repo
 * has refused before — so `failed` is honestly ambiguous rather than
 * confidently wrong, and it is reported as its own thing rather than folded
 * into either neighbour.
 */
export type PushAttempt = 'accepted' | 'failed' | 'not-requested';

/**
 * Fire-and-forget Push notification. Returns without throwing so a
 * single API hiccup doesn't kill the cron tick.
 *
 * When `channelPk` is missing (dev / pre-launch), the function no-ops
 * and logs — useful to exercise the rest of the cron without a
 * real Push channel configured.
 */
/**
 * Drop the pinned SDK's request-payload log line — installed ONCE, at module
 * load, and never swapped.
 *
 * `@pushprotocol/restapi@0.0.1` logs its entire `apiPayload` immediately
 * before the POST (`src/lib/payloads/sendNotifications.js:81`). That payload
 * carries `recipients` in CAIP form — the subscriber's wallet — so every
 * successful send wrote a wallet-to-event trail into the Worker log, and
 * omitting the subscriber from OUR log line did nothing about it (#1450 r24).
 *
 * WHY MODULE-LEVEL AND NOT AROUND EACH CALL (#1450 r25). The first version
 * saved `console.log`, installed a filter, and restored in `finally`. That is
 * unsound here because sends OVERLAP: the keeper launches `runWatcher` and
 * `runPreGraceWatcher` in separate `ctx.waitUntil` calls. Each invocation
 * captures whichever wrapper is currently installed rather than the real
 * logger, so completions out of LIFO order restore a stale wrapper, chains
 * accumulate, and an early completion can strip another in-flight send's
 * filter — which is a recipient leak, i.e. exactly the failure the filter
 * exists to prevent.
 *
 * There is nothing to restore, because there is no case where we want this
 * line: it is the SDK's debug output and it is never wanted in a Worker log.
 * Installing once is both simpler and reentrancy-proof. It matches the marker
 * on the FIRST argument, where the SDK puts it, so nothing else is affected.
 *
 * If the pin ever moves, re-check that marker: a changed prefix means this
 * silently stops filtering, and that failure is invisible by construction.
 *
 * THE PIN MOVED, AND THE MARKER WAS RE-CHECKED (#2220, 2026-09-20). On
 * `1.7.32` the `payloads/` path contains **no** `console.log` at all and the
 * string `API call` does not appear anywhere in the package. The only logging
 * left in `src/lib/` is in `channels/subscribeV2`, `chat/getGroupByName` and
 * `pushstream/PushStream` — none on the `payloads.sendNotification` path, and
 * none of them logs a payload or a recipient. So the leak this filter exists
 * to stop no longer happens on our call path, and the filter is currently
 * INERT.
 *
 * It is retained deliberately rather than deleted, because the asymmetry is
 * one-sided: an inert filter costs a few lines, and a filter removed on a
 * wrong reading costs subscriber wallets written into Worker logs. The pin is
 * a caret, so a future patch inside `^1.7` could reintroduce logging without
 * any change here. Re-run the check above on the next pin move; converting it
 * from a hand-check into an executable one is filed separately.
 */
const realConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('API call :-->> ')) return;
  realConsoleLog(...args);
};

export async function sendPush(
  channelPk: string | undefined,
  payload: PushPayload,
): Promise<PushAttempt> {
  if (!channelPk) {
    console.log(
      `[push] skipping (PUSH_CHANNEL_PK unset) subscriber=${payload.subscriber} title="${payload.title}"`,
    );
    return 'not-requested';
  }
  let signer: Wallet;
  let channelCaip: string;
  try {
    ({ signer, channelCaip } = getSignerAndChannel(channelPk));
  } catch (err) {
    // SEPARATE FROM THE SEND BELOW because it is the branch that definitely
    // made no request, so the caller must not be charged for it.
    //
    // AND IT RETURNS SILENTLY (#2213 r24 `4015538623`). This is a property of
    // the DEPLOYMENT, not of this recipient: a malformed key fails for every
    // subscriber, so logging here printed the identical line once per
    // attempted recipient — on a wide window, the log flood that turns a real
    // configuration failure into background noise. The caller reports it once
    // per chain per run with a count, which is the only place that can.
    //
    // `err` is deliberately unused rather than described: a PRIVATE KEY is the
    // argument in scope in this branch, and the one diagnostic that survives
    // says which SETTING is wrong, which is what an operator acts on.
    void err;
    return 'not-requested';
  }
  // THE SDK AND THE SIGNER MUST AGREE. The capability question stays; what
  // counts as a capable signer widened when the pin was corrected (#2220).
  //
  // #2213 r29 asked for `_signTypedData` because `@pushprotocol/restapi@0.0.1`
  // called exactly that — an ethers **v5** method — and the workspace resolves
  // ethers 6.16, whose `Wallet` exposes `signTypedData` without the
  // underscore. Every send therefore threw inside the SDK having issued no
  // request, and this branch reported `not-requested`, which was the fact.
  //
  // 1.7.32 does not call either method directly. It wraps the signer in its
  // own `PushSigner`, whose `signTypedData` dispatches
  // (`src/lib/helpers/signer.js:40-61`): a viem account, else
  // `'_signTypedData' in signer` for ethers v5, else `'signTypedData' in
  // signer` for ethers v6, else it throws `Signer does not support
  // signTypedData`.
  //
  // SO THE CHECK MUST MIRROR THE DISPATCH, NOT ONE ARM OF IT. Left as
  // `_signTypedData`-only, this guard would have gone on returning
  // `not-requested` for our ethers-v6 `Wallet` **after** the upgrade — the
  // rail would have stayed dark, with the dependency fixed and nothing
  // saying so. That failure would have been invisible: the lane reports
  // `not-requested`, which is indistinguishable from an unset key.
  //
  // Still a capability question and not an error-message classifier, for the
  // reason r29 gave: "does this object expose a typed-data signer" has a
  // definite answer, "was that exception a version mismatch" is a guess about
  // a string. And it keeps working across a future bump in either direction,
  // because it asks the same question the SDK asks.
  const asRecord = signer as unknown as Record<string, unknown>;
  const signsTheWaySdkExpects =
    typeof asRecord.signTypedData === 'function' ||
    typeof asRecord._signTypedData === 'function';
  if (!signsTheWaySdkExpects) {
    // Silent for the same reason the malformed-key branch above is: this is a
    // property of the DEPLOYMENT and fails identically for every subscriber,
    // so the caller discloses it once per chain per run with a count.
    return 'not-requested';
  }
  try {
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
      // `CONSTANTS.ENV.PROD` rather than the bare string: 1.7.32 types this
      // field as its own `ENV` enum, which the package exports only through
      // `CONSTANTS` — the enum itself is not a root export. The runtime value
      // is unchanged (`ENV.PROD` IS `'prod'`), so this is a type-level
      // adjustment and the upgrade does not silently retarget the
      // environment (#2220).
      env: PushAPI.CONSTANTS.ENV.PROD,
    });
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
    return 'failed';
  }
  return 'accepted';
}
