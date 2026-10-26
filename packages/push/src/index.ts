/**
 * The Push Protocol rail — ONE implementation for every Worker that sends
 * Push notifications (#2248).
 *
 * `apps/agent` (periodic-interest reminders) and `apps/keeper` (HF-band and
 * pre-grace alerts) each carried a near-identical `push.ts`, and the copies had
 * drifted: the agent's returned an accounting answer and guarded the signer's
 * capability, the keeper's returned nothing and entered the SDK regardless.
 * Every correction to the rail had to land twice or it was half-made. This
 * module is the single copy; a Worker supplies its own configuration and
 * nothing else.
 *
 * WHICH CHANNEL WE POST AS IS CONFIGURATION, NOT A PROPERTY OF THE KEY
 * (#1456). The channel used to be derived from the signing key
 * (`eip155:1:<wallet(PUSH_CHANNEL_PK).address>`), so rotating the key — what a
 * compromise forces — silently moved every send to a channel nobody was
 * subscribed to. `PushRailConfig.channelAddress` names the channel; the key is
 * only the signer. Unset, the channel is still the signer's own address, so a
 * deployment that sets nothing behaves exactly as before. Set to a different
 * address, the signer posts as a DELEGATE of that channel (Push's
 * `addDelegate`), which is what makes a key rotation a signer swap rather than
 * a channel migration. Whether the delegation exists is Push's record, not
 * ours: nothing here can see it, so a signer that is not a delegate shows up as
 * `failed` sends, never as an unavailable rail.
 *
 * Push channels live on Ethereum mainnet, so the CAIP-2 prefix is `eip155:1`
 * for both the channel and the recipient; the recipient wallet's own chain does
 * not need to match (Push routes by raw wallet, the prefix is metadata).
 *
 * SDK pin (#2220): `@pushprotocol/restapi` 1.7.32, whose peer range
 * `ethers: "^5.0.0 || ^6.0.0"` the workspace satisfies. The earlier `^0.0.1`
 * pin meant exactly `0.0.1` (a caret does not widen on `0.0.x`), which signed
 * the ethers-v5 way only and threw inside the SDK on every send.
 */

import * as PushAPI from '@pushprotocol/restapi';
import { Wallet, getAddress } from 'ethers';
import { redactedError } from '@vaipakam/lib/errorDescription';

const CAIP_PREFIX = 'eip155:1';

/** Where a Worker's Push rail is configured. Both fields are the raw values
 *  the Worker read from its own environment; neither is validated by the
 *  caller. */
export interface PushRailConfig {
  /** The signer's private key (`PUSH_CHANNEL_PK`). Absent → the rail is off. */
  channelPk?: string;
  /** The channel posted as (`PUSH_CHANNEL_ADDRESS`). Absent or empty → the
   *  signer's own address, the historical behaviour. */
  channelAddress?: string;
}

export interface PushPayload {
  /** 0x-hex wallet address; the CAIP-2 prefix is added here. */
  subscriber: string;
  title: string;
  body: string;
  deepLinkUrl?: string;
}

/**
 * Whether a call consumed an outbound request (#2213 r9, r10).
 *
 * - `not-requested` — the SDK call was never entered: the rail is unavailable
 *   (see `PushRailStatus`). No request, so nothing to charge and nobody told.
 * - `accepted` — the SDK resolved. A request happened, and this is the ONLY
 *   answer that justifies reporting that someone was told.
 * - `failed` — the call was entered and threw. A request may well have gone,
 *   so a caller with an outbound allowance charges it; nobody can say it
 *   arrived, so it is never counted as a delivery.
 *
 * The charge and the count deliberately disagree on `failed`: a ceiling must
 * assume the request happened, and a report must not assume the message did.
 * Whether a throw came before or after the POST is not separated — that would
 * be a guess about an error's shape — so `failed` is honestly ambiguous.
 */
export type PushAttempt = 'accepted' | 'failed' | 'not-requested';

/** Why a rail cannot issue a request at all. Each names the setting to fix. */
export type PushRailUnavailableReason =
  /** No signer key is configured. */
  | 'signer-unset'
  /** A key is configured and no signer can be built from it. */
  | 'signer-malformed'
  /** The signer exposes no typed-data signing the SDK can use. */
  | 'signer-unsupported'
  /** A channel address is configured and is not an address. */
  | 'channel-malformed';

/**
 * What a Worker can say about its rail without sending anything and without
 * the key leaving it (#2251).
 *
 * `usable` means the rail can ISSUE a request: a signer exists, it signs the
 * way the SDK expects, and the channel is a well-formed address. It does not
 * mean Push will accept the request — a channel Push does not recognise, or a
 * signer that is not the channel's delegate, is refused per send and surfaces
 * as `failed`. That limit is stated rather than papered over: nothing local
 * can answer it.
 */
export type PushRailStatus =
  | {
      usable: true;
      /** The channel posted as, checksummed. */
      channel: string;
      /** True when the signer posts as a delegate of a configured channel
       *  rather than as the channel itself. */
      delegated: boolean;
    }
  | { usable: false; reason: PushRailUnavailableReason };

type ResolvedRail =
  | { status: Extract<PushRailStatus, { usable: true }>; signer: Wallet }
  | { status: Extract<PushRailStatus, { usable: false }> };

/**
 * Cache the signer at module scope, so the key is turned into a `Wallet` once
 * per isolate (or per process, on the keeper machine) rather than per send.
 * Only the signer is cached: the capability check and the channel are cheap
 * and are answered fresh on every call, so a changed key or channel setting
 * is never read through a stale verdict.
 */
let cachedPk: string | null = null;
let cachedSigner: Wallet | null = null;

function signerFor(pk: string): Wallet {
  if (cachedPk === pk && cachedSigner) return cachedSigner;
  // ethers rejects naked hex, so normalise to the 0x form.
  const signer = new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
  cachedPk = pk;
  cachedSigner = signer;
  return signer;
}

function resolveRail(config: PushRailConfig): ResolvedRail {
  const pk = config.channelPk ?? '';
  const configured = (config.channelAddress ?? '').trim();
  if (!pk) return { status: { usable: false, reason: 'signer-unset' } };
  let signer: Wallet;
  try {
    signer = signerFor(pk);
  } catch (err) {
    // The argument in scope is a PRIVATE KEY, so the error is deliberately
    // not described anywhere: the reason code names the setting to fix, which
    // is what an operator acts on.
    void err;
    return { status: { usable: false, reason: 'signer-malformed' } };
  }
  // THE SDK AND THE SIGNER MUST AGREE (#2213 r29, #2220). 1.7.32 wraps the
  // signer in its own `PushSigner`, which dispatches to a viem account, else
  // `_signTypedData` (ethers v5), else `signTypedData` (ethers v6), else
  // throws. The check mirrors that dispatch rather than one arm of it, and it
  // is a capability question with a definite answer — not a classifier over
  // an exception's message.
  const asRecord = signer as unknown as Record<string, unknown>;
  const signsTheWaySdkExpects =
    typeof asRecord.signTypedData === 'function' ||
    typeof asRecord._signTypedData === 'function';
  if (!signsTheWaySdkExpects) {
    return { status: { usable: false, reason: 'signer-unsupported' } };
  }
  let channel = signer.address;
  if (configured) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(configured)) {
      return { status: { usable: false, reason: 'channel-malformed' } };
    }
    try {
      // A mixed-case value with a wrong checksum is refused: it is likelier a
      // typo than a channel.
      channel = getAddress(configured);
    } catch {
      return { status: { usable: false, reason: 'channel-malformed' } };
    }
  }
  return {
    status: {
      usable: true,
      channel,
      delegated: channel.toLowerCase() !== signer.address.toLowerCase(),
    },
    signer,
  };
}

/** The rail's status, answered without sending anything. Safe to expose:
 *  it carries no part of the key. */
export function pushRailStatus(config: PushRailConfig): PushRailStatus {
  return resolveRail(config).status;
}

/**
 * Drop the SDK's request-payload log line — installed ONCE, at module load,
 * and never swapped (#1450 r24, r25).
 *
 * `@pushprotocol/restapi@0.0.1` logged its whole request payload, recipients
 * included, so every send wrote a wallet-to-event trail into the Worker log.
 * Installing around each call was unsound because sends overlap (the keeper
 * runs two watchers concurrently) and out-of-order restores could strip
 * another send's filter. There is no case where this line is wanted, so it is
 * filtered once, matching the marker on the first argument only.
 *
 * Re-checked on the move to 1.7.32 (#2220): the `payloads/` path logs nothing
 * and the marker appears nowhere in the package, so the filter is currently
 * INERT. Retained because the asymmetry is one-sided — an inert filter costs a
 * few lines, a wrongly removed one costs subscriber wallets in logs — and a
 * patch inside the caret range could bring the logging back. Re-run the check
 * on the next pin move.
 */
const realConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('API call :-->> ')) return;
  realConsoleLog(...args);
};

/**
 * Send one targeted notification. Never throws: a Push outage must not stop a
 * cron pass or block another rail, so every failure comes back as an answer
 * (see `PushAttempt`).
 *
 * An unavailable rail returns `not-requested` SILENTLY. It is a property of
 * the deployment and fails identically for every subscriber, so logging it
 * here would print the same line once per recipient; a caller that wants to
 * disclose it reads `pushRailStatus` once and reports it with a count.
 */
export async function sendPush(
  config: PushRailConfig,
  payload: PushPayload,
): Promise<PushAttempt> {
  const rail = resolveRail(config);
  if (!('signer' in rail)) return 'not-requested';
  const { signer } = rail;
  const { channel, delegated } = rail.status;
  const channelCaip = `${CAIP_PREFIX}:${channel}`;
  try {
    await PushAPI.payloads.sendNotification({
      signer,
      // type=3 → targeted to one recipient (1 is broadcast, 4 a subset).
      type: 3,
      // identityType=2 → direct payload: the body travels with the request
      // rather than being hash-pointed at off-chain storage.
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
      // The SDK types this as its own `ENV` enum, exported only through
      // `CONSTANTS`; `ENV.PROD` IS `'prod'`.
      env: PushAPI.CONSTANTS.ENV.PROD,
    });
    // A POSITIVE signal (#1450): without it a channel Push does not recognise
    // looked exactly like "nothing to send yet". The channel is logged because
    // it is the field a rotation changes; a delegate's own address is logged
    // too, since it is the one a rotation swaps. The subscriber is NOT logged
    // (#1450 r13) — this line fires on every send, and the address would build
    // a standing wallet-to-event trail.
    console.log(
      delegated
        ? `[push] sent channel=${channelCaip} delegate=${signer.address}`
        : `[push] sent channel=${channelCaip}`,
    );
  } catch (err) {
    // Exceptional, so here the subscriber IS the diagnostic.
    console.error(`[push] send failed subscriber=${payload.subscriber}`, redactedError(err));
    return 'failed';
  }
  return 'accepted';
}

/**
 * A rail's status as one sender PUBLISHES it for another to read (#2667).
 *
 * The keeper sends the risky-loan warnings from its own copy of the key on
 * its own machine, so the agent cannot ask that rail directly. The keeper
 * writes this row (shared D1 `push_rail_status`) each time its watcher runs,
 * and the agent reads it back. Both directions go through the two functions
 * below, so the writer and the reader cannot disagree about the encoding. The
 * row carries no part of the key — it is `PushRailStatus` and a timestamp.
 */
export interface PublishedRailRow {
  usable: number;
  reason: string | null;
  channel: string | null;
  observed_at: number;
}

const UNAVAILABLE_REASONS: readonly PushRailUnavailableReason[] = [
  'signer-unset',
  'signer-malformed',
  'signer-unsupported',
  'channel-malformed',
];

/** The row a sender writes for `status`, observed at `nowSec`. */
export function publishedRailRow(status: PushRailStatus, nowSec: number): PublishedRailRow {
  return status.usable
    ? { usable: 1, reason: null, channel: status.channel, observed_at: nowSec }
    : { usable: 0, reason: status.reason, channel: null, observed_at: nowSec };
}

/**
 * What a reader learns from a published row: whether that sender's rail can
 * issue a request, and on which channel or why not. Narrower than
 * `PushRailStatus` on purpose — whether the sender posts as a delegate is not
 * published, so a reader is never handed a value for it.
 */
export type PublishedRailStatus =
  | { usable: true; channel: string }
  | { usable: false; reason: PushRailUnavailableReason };

/**
 * Read a published row back, strictly: a row is accepted only when it is
 * EXACTLY what `publishedRailRow` writes for the status it decodes to, so a
 * contradictory row (usable with a reason, unusable with a channel, a
 * lowercase channel the writer would have checksummed) reads as `undefined`
 * (unknown), never as a guess about which field to believe.
 */
export function readPublishedRail(
  row: PublishedRailRow | null | undefined,
): { status: PublishedRailStatus; observedAt: number } | undefined {
  if (!row || !Number.isSafeInteger(row.observed_at) || row.observed_at <= 0) return undefined;
  const decoded = decodeRailFields(row);
  if (decoded === undefined) return undefined;
  const rewritten = publishedRailRow(
    decoded.usable ? { ...decoded, delegated: false } : decoded,
    row.observed_at,
  );
  const same =
    rewritten.usable === row.usable &&
    rewritten.reason === row.reason &&
    rewritten.channel === row.channel;
  return same ? { status: decoded, observedAt: row.observed_at } : undefined;
}

/** The status a row's own fields name, before the round-trip check. */
function decodeRailFields(row: PublishedRailRow): PublishedRailStatus | undefined {
  if (row.usable === 1) {
    if (typeof row.channel !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(row.channel)) return undefined;
    try {
      return { usable: true, channel: getAddress(row.channel) };
    } catch {
      return undefined;
    }
  }
  if (row.usable === 0) {
    const reason = row.reason as PushRailUnavailableReason;
    return UNAVAILABLE_REASONS.includes(reason) ? { usable: false, reason } : undefined;
  }
  return undefined;
}
