/**
 * This Worker's Push rail configuration, read from its env in ONE place so the
 * sender (`periodicPreNotify`) and the status the app reads (`GET
 * /push/status`, `PUT /thresholds`) can never consult different settings
 * (#2251). The rail itself is the shared `@vaipakam/push` (#2248). Since
 * #2667 the status also covers the keeper's rail, as the keeper publishes it.
 */
import {
  pushRailStatus,
  readPublishedRail,
  type PublishedRailStatus,
  type PushRailConfig,
  type PushRailUnavailableReason,
} from '@vaipakam/push';
import { readPublishedPushRail } from './db';
import type { Env } from './env';

export function pushRailConfigOf(env: Pick<Env, 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>): PushRailConfig {
  return { channelPk: env.PUSH_CHANNEL_PK, channelAddress: env.PUSH_CHANNEL_ADDRESS };
}

/** How long the keeper's published row is trusted (#2667). Its watcher
 *  publishes every tick (one minute); this leaves room for a restart or a
 *  release, and no more — a row this old says the sender has stopped. */
export const KEEPER_RAIL_FRESH_SEC = 15 * 60;

/** A row stamped this far ahead of the agent's clock is not trusted either:
 *  it would otherwise stay "fresh" for as long as the skew lasts. */
const KEEPER_RAIL_MAX_SKEW_SEC = 60;

/**
 * What `GET /push/status` answers, and what a new opt-in is judged against.
 *
 * `scope: 'service'` covers BOTH senders: the agent's rail (payment
 * reminders) and the keeper's (risky-loan warnings), the latter as the
 * keeper last published it (#2667). It is `available` only when both can
 * issue a request on the SAME channel, since a subscriber opts in to one
 * channel. When the keeper's row is missing, unreadable, stale or malformed,
 * nothing is known about that rail, and the answer falls back to `scope:
 * 'agent'` — this Worker's own rail, which the app already presents with a
 * caveat that it does not cover the warnings. It never borrows the agent's
 * answer for the keeper.
 *
 * `rail` names which sender is down when one is (`agent` or `keeper`); a
 * channel disagreement is `reason: 'channel-mismatch'` and names neither.
 */
export type ServicePushStatus =
  | { usable: true; channel: string; scope: 'agent' | 'service' }
  | {
      usable: false;
      reason: PushRailUnavailableReason | 'channel-mismatch';
      rail?: 'agent' | 'keeper';
      scope: 'agent' | 'service';
    };

export async function servicePushStatus(
  env: Pick<Env, 'DB' | 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<ServicePushStatus> {
  const agent = pushRailStatus(pushRailConfigOf(env));
  const keeper = await keeperRail(env.DB, nowSec);
  if (keeper === undefined) {
    return agent.usable
      ? { usable: true, channel: agent.channel, scope: 'agent' }
      : { usable: false, reason: agent.reason, rail: 'agent', scope: 'agent' };
  }
  if (!agent.usable) return { usable: false, reason: agent.reason, rail: 'agent', scope: 'service' };
  if (!keeper.usable) return { usable: false, reason: keeper.reason, rail: 'keeper', scope: 'service' };
  if (keeper.channel.toLowerCase() !== agent.channel.toLowerCase()) {
    return { usable: false, reason: 'channel-mismatch', scope: 'service' };
  }
  return { usable: true, channel: agent.channel, scope: 'service' };
}

/** The keeper's published rail, or `undefined` when nothing trustworthy is
 *  known about it. A read failure (the table not migrated yet, a D1 outage)
 *  is unknown too: this answer must tolerate the previous schema. */
async function keeperRail(db: D1Database, nowSec: number): Promise<PublishedRailStatus | undefined> {
  let row;
  try {
    row = await readPublishedPushRail(db, 'keeper');
  } catch {
    return undefined;
  }
  const published = readPublishedRail(row);
  if (published === undefined) return undefined;
  const age = nowSec - published.observedAt;
  if (age > KEEPER_RAIL_FRESH_SEC || age < -KEEPER_RAIL_MAX_SKEW_SEC) return undefined;
  return published.status;
}

/**
 * The chains on which this service charges the paid-Push notification fee
 * (`NotificationFeeFacet.markNotifBilled`) — none (#2723).
 *
 * No sender in this service calls the billing entry point today, so the
 * honest answer is an empty list, written here rather than read from a
 * setting: an operator flag could declare billing that no code performs.
 * The app reads this list before it offers the on-chain consent to be
 * charged, and offers that consent only on a chain listed here; elsewhere it
 * says Push is not billed and offers only the withdrawal. A biller that ships
 * replaces this constant with the chains it actually bills on, from its own
 * state, and must skip a payer whose consent does not cover the fee or whose
 * loan is not active (functional spec, "Notification Billing Consent").
 */
export const PUSH_BILLED_CHAIN_IDS: readonly number[] = [];

/**
 * `GET /push/status` — whether Push can be sent, for the app to read BEFORE
 * it offers the opt-in (#2251, #2667), and on which chains it is billed
 * (`billedChainIds`, #2723) — the latter in every answer, whatever the
 * rail's state, because consent can be withdrawn while the rail is down.
 *
 * The app used to offer the Push rail on its own build-time channel address
 * alone, so a deployment whose signer was unset or malformed said "Push
 * delivery is on" and sent nothing. The answer here comes from the rails
 * themselves, without any key leaving its Worker: `available` and the channel
 * posted as, or `available: false` and the reason code. Its `scope` says
 * whose rails it covers; see `servicePushStatus`.
 *
 * `available` is "can issue a request", not "Push will accept it": a channel
 * Push does not recognise, or a signer that is not the channel's delegate, is
 * refused per send. Nothing local can answer that, and the copy does not
 * claim it.
 */
export async function handlePushStatus(
  env: Pick<Env, 'DB' | 'PUSH_CHANNEL_PK' | 'PUSH_CHANNEL_ADDRESS'>,
  corsOrigin: string,
  nowSec?: number,
): Promise<Response> {
  const status = await servicePushStatus(env, nowSec);
  const billedChainIds = [...PUSH_BILLED_CHAIN_IDS];
  const body = status.usable
    ? { available: true, channel: status.channel, scope: status.scope, billedChainIds }
    : {
        available: false,
        reason: status.reason,
        ...(status.rail ? { rail: status.rail } : {}),
        scope: status.scope,
        billedChainIds,
      };
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
