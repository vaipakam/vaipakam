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
 *   - `DB` is the D1 HTTP adapter, pointed at the same database the Worker
 *     binds (`D1_DATABASE_ID`), with the account id and an API token.
 *
 * Without the three D1 settings `DB` is left absent, which the tick already
 * treats as a maintenance build: it declines the whole tick, by name, rather
 * than running passes against no database.
 */

import { SECRET_BINDING_KEYS, type WorkerEnv } from '../src/env';
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
}

export function buildHostEnv(
  vars: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
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

  const accountId = vars[HOST_SETTINGS.accountId];
  const databaseId = vars[HOST_SETTINGS.databaseId];
  const apiToken = vars[HOST_SETTINGS.apiToken];
  const missingD1 = Object.values(HOST_SETTINGS).filter((k) => !vars[k]);
  if (accountId && databaseId && apiToken) {
    out.DB = createD1HttpDatabase({ accountId, databaseId, apiToken, fetchFn });
  }
  return { env: out as WorkerEnv, missingD1 };
}
