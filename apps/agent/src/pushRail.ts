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

/** What a settings save did with the Push opt-in it carried (#2251):
 *  `stored` — written; `kept` — the rail cannot send now, but an opt-in made
 *  earlier is already stored and stays (it resumes when the rail is back);
 *  `not-requested` — the save carried none. */
export type PushOptInOutcome = 'not-requested' | 'stored' | 'kept';

/** The save is refused as a whole: it asked to switch Push ON and the rail
 *  cannot send. */
export interface PushOptInRefused {
  refused: true;
}

/**
 * Decide what a `PUT /thresholds` write does with Push (#2251).
 *
 * A NEW opt-in is accepted only where the rail can honour it. When it cannot,
 * the WHOLE save is refused with a non-2xx status and nothing is stored, so a
 * client of any age reads it as a failure: an app bundle from before this
 * change treats every 2xx as a stored opt-in and would otherwise report
 * "Push delivery is on" for a rail that sends nothing (Codex #2665 r1). The
 * current app retries the save without the opt-in, so its other settings
 * still land, and says why Push stayed off.
 *
 * An opt-in ALREADY stored is not a new one: a client holding it sends the
 * field on every save, and refusing those would stop it changing anything
 * else during an outage. The field is dropped from the write (the stored
 * value is kept by the upsert's COALESCE) and the outcome says `kept`.
 * `alreadyStored` is read only when it can matter — the caller asks for it
 * when an opt-in arrives while the rail cannot send.
 */
export async function decidePushOptIn<T extends { push_channel?: string | null }>(
  parsed: T,
  rail: { usable: boolean },
  alreadyStored: () => Promise<boolean>,
): Promise<{ write: T; push: PushOptInOutcome } | PushOptInRefused> {
  const requested = parsed.push_channel !== null && parsed.push_channel !== undefined;
  if (!requested) return { write: parsed, push: 'not-requested' };
  if (rail.usable) return { write: parsed, push: 'stored' };
  if (await alreadyStored()) return { write: { ...parsed, push_channel: null }, push: 'kept' };
  return { refused: true };
}
