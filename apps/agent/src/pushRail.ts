/**
 * This Worker's Push rail configuration, read from its env in ONE place so the
 * sender (`periodicPreNotify`) and the status the app reads (`GET
 * /push/status`, `PUT /thresholds`) can never consult different settings
 * (#2251). The rail itself is the shared `@vaipakam/push` (#2248).
 */
import { pushRailStatus, type PushRailConfig } from '@vaipakam/push';
import type { Env } from './env';

export function pushRailConfigOf(env: Pick<Env, 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>): PushRailConfig {
  return { channelPk: env.PUSH_CHANNEL_PK, channelAddress: env.PUSH_CHANNEL_ADDRESS };
}

/**
 * `GET /push/status` — whether this deployment can send Push, for the app to
 * read BEFORE it offers the opt-in (#2251).
 *
 * The app used to offer the Push rail on its own build-time channel address
 * alone, so a deployment whose signer was unset or malformed said "Push
 * delivery is on" and sent nothing. The answer here comes from the same rail
 * the sender uses, without the key leaving the Worker: `available` and the
 * channel the rail posts as, or `available: false` and the reason code.
 *
 * Its SCOPE is this Worker's rail. The keeper sends the HF-band alerts from its
 * own copy of the key on its own machine, and this Worker cannot see that
 * configuration; the response says so in `scope` rather than letting the app
 * read one rail's status as the whole Push service's.
 *
 * `available` is "can issue a request", not "Push will accept it": a channel
 * Push does not recognise, or a signer that is not the channel's delegate, is
 * refused per send. Nothing local can answer that, and the copy does not
 * claim it.
 */
export function handlePushStatus(
  env: Pick<Env, 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>,
  corsOrigin: string,
): Response {
  const status = pushRailStatus(pushRailConfigOf(env));
  const body = status.usable
    ? { available: true, channel: status.channel, scope: 'agent' }
    : { available: false, reason: status.reason, scope: 'agent' };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
      'Cache-Control': 'no-store',
    },
  });
}

/** What a settings save did with the Push opt-in it carried (#2251). */
export type PushOptInOutcome = 'not-requested' | 'stored' | 'unavailable';

/**
 * Decide what a `PUT /thresholds` write stores for Push (#2251).
 *
 * An opt-in is stored only where it can be honoured: when the rail cannot
 * issue a request, the push field is dropped from the write and the outcome
 * says `unavailable`, so the app never reports Push as on for a rail that
 * sends nothing. Only that field is dropped. A client holding an earlier
 * opt-in sends the field on every save, so refusing the whole save would stop
 * it changing anything else during an outage. An opt-in ALREADY stored is not
 * touched — the write keeps a stored channel when the field is absent — so it
 * survives the outage and resumes when the rail is back.
 */
export function decidePushOptIn<T extends { push_channel?: string | null }>(
  parsed: T,
  rail: { usable: boolean },
): { write: T; push: PushOptInOutcome } {
  const requested = parsed.push_channel !== null && parsed.push_channel !== undefined;
  if (!requested) return { write: parsed, push: 'not-requested' };
  if (rail.usable) return { write: parsed, push: 'stored' };
  return { write: { ...parsed, push_channel: null }, push: 'unavailable' };
}
