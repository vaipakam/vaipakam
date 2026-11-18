// apps/keeper/src/checkpointCoverage.ts
//
// The checkpoint pass must run wherever a pass that fills from lender intent
// slots runs (`intentCalm.ts`): with the calm-price check on, a slot fills
// only while both assets of its pair have checkpoints for the last two hours,
// and the price checkpoint pass is what writes them. This is the launch
// check: the host states it at start-up (and in `--check`), and the tick
// raises one ops alert while it does not hold, like the signing-key alert
// (`signingKeyAlert.ts`).

import type { Env } from './env';
import { keeperFlagOn, signingKeyProblem } from './keeper';
import { sendOpsAlert } from './opsAlert';
import { clearOpsAlert, getOpsAlert } from './db';
import { redactedError } from '@vaipakam/lib/errorDescription';

const flagOn = (raw: string | undefined) => raw === 'true' || raw === '1';

/**
 * Why the configuration leaves slot fills without the checkpoints they read,
 * or null when it does not. Auto-lend fills run in the matcher, which every
 * armed keeper runs; the backstop fill runs under POSITION_UPKEEP_ENABLED +
 * BACKSTOP_FILL_ENABLED. Either one needs PRICE_CHECKPOINT_ENABLED: without
 * it nothing writes the hourly checkpoints, and every slot with the check on
 * refuses every fill (the backstop's always has it on). The parse is the
 * arming gate's own (`'true'` or `'1'`). Pure.
 */
/** The settings the coverage check reads (the host's environment carries
 *  them before its database is bound). */
export type CoverageFlags = Pick<Env, 'KEEPER_ENABLED' | 'KEEPER_PRIVATE_KEY' | 'PRICE_CHECKPOINT_ENABLED' | 'POSITION_UPKEEP_ENABLED' | 'BACKSTOP_FILL_ENABLED'>;

export function checkpointCoverageGap(env: CoverageFlags): string | null {
  if (flagOn(env.PRICE_CHECKPOINT_ENABLED)) return null;
  const autoLend = keeperFlagOn(env as Env) && signingKeyProblem(env as Env) === null;
  const backstop = flagOn(env.POSITION_UPKEEP_ENABLED) && flagOn(env.BACKSTOP_FILL_ENABLED);
  if (!autoLend && !backstop) return null;
  const fills = [autoLend ? 'Auto-lend fills (the matcher)' : null, backstop ? 'the backstop fill' : null].filter(Boolean).join(' and ');
  return `${fills} ${autoLend && backstop ? 'are' : 'is'} armed but PRICE_CHECKPOINT_ENABLED is not, so nothing writes the hourly price checkpoints and every fill from a lender intent slot with the price check on is refused`;
}

export const COVERAGE_ALERT_KEY = 'keeper-checkpoint-coverage';
/** A setting an operator must fix by hand: repeated every six hours. */
export const COVERAGE_ALERT_INTERVAL_SEC = 6 * 3600;

export interface CoverageAlertDeps {
  send: typeof sendOpsAlert;
  prior: (env: Env, key: string) => Promise<unknown>;
  clear: (env: Env, key: string) => Promise<void>;
}

const DEFAULT_COVERAGE_DEPS: CoverageAlertDeps = {
  send: sendOpsAlert,
  prior: (env, key) => getOpsAlert(env.KEEPER_DB, key),
  clear: (env, key) => clearOpsAlert(env.KEEPER_DB, key),
};

/** Raise, repeat or clear the coverage alert for this tick. Never throws. */
export async function checkpointCoverageHealth(env: Env, deps: CoverageAlertDeps = DEFAULT_COVERAGE_DEPS): Promise<'alerted' | 'cleared' | 'ok'> {
  const gap = checkpointCoverageGap(env);
  if (gap !== null) {
    const outcome = await deps.send(env, COVERAGE_ALERT_KEY, `⚠️ Keeper machine: ${gap}. Arm the price checkpoint pass (keeper-flag PRICE_CHECKPOINT_ENABLED on) or disarm the fills.`, COVERAGE_ALERT_INTERVAL_SEC);
    if (outcome === 'sent') console.warn(`[keeper] checkpoint coverage: ${gap}; ops alerted`);
    return 'alerted';
  }
  try {
    if ((await deps.prior(env, COVERAGE_ALERT_KEY)) === null) return 'ok';
    await deps.clear(env, COVERAGE_ALERT_KEY);
    console.log('[keeper] checkpoint coverage alert cleared');
    return 'cleared';
  } catch (err) {
    console.warn(`[keeper] checkpoint coverage alert record not read or cleared (${redactedError(err, { stack: false })}); retried next tick`);
    return 'ok';
  }
}
