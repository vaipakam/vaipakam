/**
 * #3119 — one machine-level ops alert when the keeper cannot sign.
 *
 * `passIsArmed` (keeper.ts) disarms every pass while `KEEPER_PRIVATE_KEY` is
 * unset or unusable: the fund-moving passes and the observers alike (the
 * reward sanctions hold, the horizon heartbeat, the testnet stand-in refresh).
 * Each pass logs a skip line naming the cause, and nothing else does, so an
 * operator learns of it only from the journal. This alert says it once for the
 * whole machine, on the ops channel, while `KEEPER_ENABLED` is on and the key
 * cannot sign.
 *
 * It is one alert, not a key-less mode in each pass, so the shared gate keeps
 * a single meaning: a pass that reads as armed can sign. The cause comes from
 * the gate's own reading (`signingKeyProblem`), which names only the form of
 * the mistake, never the value.
 *
 * While `KEEPER_ENABLED` is off every pass is deliberately dark and the key is
 * not in use, so nothing is said. Once the key signs again (or the keeper is
 * switched off) the alert's record is cleared, so a recurrence alerts at once.
 */

import type { Env } from './env';
import { keeperFlagOn, signingKeyProblem } from './keeper';
import { sendOpsAlert, type OpsAlertOutcome } from './opsAlert';
import { clearOpsAlert, getOpsAlert } from './db';
import { redactedError } from '@vaipakam/lib/errorDescription';

export const SIGNING_KEY_ALERT_KEY = 'keeper-signing-key';
/** A condition an operator must fix by hand: re-sent every six hours while it lasts. */
export const SIGNING_KEY_ALERT_INTERVAL_SEC = 6 * 3600;

export type SigningKeyHealth = { kind: 'alerted'; outcome: OpsAlertOutcome } | { kind: 'cleared' } | { kind: 'ok' };

export interface SigningKeyAlertDeps {
  send: typeof sendOpsAlert;
  prior: (env: Env, key: string) => Promise<unknown>;
  clear: (env: Env, key: string) => Promise<void>;
}

const DEFAULT_DEPS: SigningKeyAlertDeps = {
  send: sendOpsAlert,
  prior: (env, key) => getOpsAlert(env.KEEPER_DB, key),
  clear: (env, key) => clearOpsAlert(env.KEEPER_DB, key),
};

export function signingKeyAlertText(problem: string): string {
  return `⚠️ Keeper machine: KEEPER_ENABLED is on, but KEEPER_PRIVATE_KEY is ${problem}, so every keeper pass is disarmed (liquidations, defaults, reward passes and the observers alike) until the key can sign again. Fix the key in the machine's keeper environment and restart the keeper.`;
}

/** Raise, repeat or clear the alert for this tick. Never throws. */
export async function signingKeyHealth(env: Env, deps: SigningKeyAlertDeps = DEFAULT_DEPS): Promise<SigningKeyHealth> {
  const problem = keeperFlagOn(env) ? signingKeyProblem(env) : null;
  if (problem !== null) {
    const outcome = await deps.send(env, SIGNING_KEY_ALERT_KEY, signingKeyAlertText(problem), SIGNING_KEY_ALERT_INTERVAL_SEC);
    if (outcome === 'sent') console.warn(`[keeper] signing key ${problem}: ops alerted`);
    return { kind: 'alerted', outcome };
  }
  try {
    // A read each tick, and a write only when there is a record to clear.
    if ((await deps.prior(env, SIGNING_KEY_ALERT_KEY)) === null) return { kind: 'ok' };
    await deps.clear(env, SIGNING_KEY_ALERT_KEY);
    console.log('[keeper] signing key alert cleared');
    return { kind: 'cleared' };
  } catch (err) {
    console.warn(`[keeper] signing key alert record not read or cleared (${redactedError(err, { stack: false })}); retried next tick`);
    return { kind: 'ok' };
  }
}
