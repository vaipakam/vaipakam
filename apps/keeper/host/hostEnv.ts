/**
 * The keeper's raw env, built from process environment variables.
 *
 * On a Worker, Cloudflare delivers `WorkerEnv`: the D1 database as a binding,
 * the store-backed secrets as `{ get() }` bindings, and everything else as a
 * plain string. Here every value arrives as a string, so this builds the same
 * shape and hands it to the same `resolveEnv`, and nothing downstream of the
 * tick knows which host it is on:
 *
 *   - every variable is copied through as a string, which covers the arming
 *     flags and tuning knobs exactly as the Worker receives them. An EMPTY
 *     variable is dropped, so a blank line in the env file means "unset",
 *     as an unbound var does on the Worker. Without this, `KNOB=` would
 *     arrive as `''` and a numeric knob could read it as 0 instead of its
 *     default;
 *   - the keys in `SECRET_BINDING_KEYS` are wrapped as bindings;
 *   - `KEEPER_RUNNER_ID` (the one-runner lease's name for this copy, #2503)
 *     defaults to `host:<host name>` when the env file leaves it unset, so a
 *     machine set up before the setting existed still claims the lease
 *     instead of declining every tick;
 *   - `DB` is the D1 HTTP adapter, pointed at the same database the Worker
 *     binds (`D1_DATABASE_ID`), with the account id and an API token.
 *
 *   - `KEEPER_DB` is a second adapter, pointed at the keeper's PRIVATE
 *     database (#2450) with the same account and token — the Worker binds
 *     both, so the machine supplies both. Its id is the PINNED one from the
 *     D1 registry (`PRIVATE_DB_ID`), never host config (#2497 r4): a wrong
 *     id could point the keeper at an empty or unrelated ledger whose
 *     cutover check passes vacuously.
 *
 * A private id equal to the shared one is refused: that would be a second
 * handle onto the shared data under the private name, which the registry
 * (`PRIVATE_DATABASES`) forbids. `KEEPER_DB` is then left absent, and the tick
 * declines naming it.
 *
 * A database whose settings are missing is left absent, which the tick
 * already treats as a maintenance build: it declines the whole tick, naming
 * the unbound database, rather than running passes against half the state.
 */

import { hostname as osHostname } from 'node:os';
import { SECRET_BINDING_KEYS, type WorkerEnv } from '../src/env';
import { PRIVATE_DB_ID } from '../scripts/lib/keeper-cutover.mjs';
import { createD1HttpDatabase } from './d1Http';

/** The settings the machine host reads that a Worker never sees. */
export const HOST_SETTINGS = {
  accountId: 'CLOUDFLARE_ACCOUNT_ID',
  databaseId: 'D1_DATABASE_ID',
  apiToken: 'CLOUDFLARE_D1_API_TOKEN',
} as const;

/** Names of the host-only settings, so they are not copied into the env. */
const HOST_ONLY = new Set<string>(Object.values(HOST_SETTINGS));

export interface HostEnvResult {
  env: WorkerEnv;
  /** The D1 settings that are missing; empty when the database is wired. */
  missingD1: string[];
  /** Why a set D1 setting was refused, or null. */
  refusedD1: string | null;
}

export function buildHostEnv(
  vars: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
  hostname: () => string = osHostname,
): HostEnvResult {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined || value === '' || HOST_ONLY.has(key)) continue;
    out[key] = value;
  }
  const secretKeys: readonly string[] = SECRET_BINDING_KEYS;
  for (const key of secretKeys) {
    const value = vars[key];
    if (value === undefined || value === '') {
      delete out[key];
      continue;
    }
    out[key] = { get: async () => value };
  }

  if (out.KEEPER_RUNNER_ID === undefined) out.KEEPER_RUNNER_ID = `host:${hostname()}`;

  const accountId = vars[HOST_SETTINGS.accountId];
  const databaseId = vars[HOST_SETTINGS.databaseId];
  const apiToken = vars[HOST_SETTINGS.apiToken];
  const missingD1 = Object.values(HOST_SETTINGS).filter((k) => !vars[k]);
  if (accountId && databaseId && apiToken) {
    out.DB = createD1HttpDatabase({ accountId, databaseId, apiToken, fetchFn });
  }
  let refusedD1: string | null = null;
  if (databaseId && databaseId.toLowerCase() === PRIVATE_DB_ID.toLowerCase()) {
    // The shared setting names the keeper's private database: both handles
    // would be one database, the barrier gone. Neither is bound.
    refusedD1 = `${HOST_SETTINGS.databaseId} names the keeper's private database; no database is bound`;
    delete out.DB;
  } else if (accountId && apiToken) {
    out.KEEPER_DB = createD1HttpDatabase({ accountId, databaseId: PRIVATE_DB_ID, apiToken, fetchFn });
  }
  return { env: out as WorkerEnv, missingD1, refusedD1 };
}
