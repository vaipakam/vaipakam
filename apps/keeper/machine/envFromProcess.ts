/**
 * Build the keeper's RAW env from process environment variables, in the exact
 * shape the Worker receives — so the machine goes through the SAME
 * `resolveEnv` (src/env.ts) as the Worker, and nothing downstream can tell
 * which host it is on.
 *
 * Names are the binding names, unchanged: `RPC_BASE_SEPOLIA`,
 * `KEEPER_PRIVATE_KEY`, `KEEPER_ENABLED`, …. A secret is presented as a
 * `{ get() }` binding over its variable; an unset or empty variable is ABSENT,
 * as an unbound secret is on the Worker, so the dependent chain or pass skips
 * exactly as it would there.
 *
 * The D1 handle comes from {@link D1HttpDatabase}; its credentials are the
 * machine's own (`CLOUDFLARE_ACCOUNT_ID`, `KEEPER_D1_API_TOKEN`,
 * `KEEPER_D1_DATABASE_ID`) and are NOT part of the keeper env.
 */
import type { WorkerEnv } from '../src/env';
import { D1HttpDatabase } from './d1Http';

/** Secrets the Worker reads from the Secrets Store (src/env.ts `WorkerEnv`). */
export const SECRET_NAMES = [
  'RPC_BASE',
  'RPC_ETH',
  'RPC_ARB',
  'RPC_OP',
  'RPC_BNB',
  'RPC_SEPOLIA',
  'RPC_BASE_SEPOLIA',
  'RPC_ARB_SEPOLIA',
  'RPC_OP_SEPOLIA',
  'RPC_BNB_TESTNET',
  'TG_BOT_TOKEN',
  'PUSH_CHANNEL_PK',
  'ZEROEX_API_KEY',
  'ONEINCH_API_KEY',
  'KEEPER_PRIVATE_KEY',
] as const;

/** Plain-string knobs (src/env.ts `BaseEnv`), passed through as given. */
export const KNOB_NAMES = [
  'TG_BOT_USERNAME',
  'FRONTEND_ORIGIN',
  'KEEPER_ENABLED',
  'REWARD_REMIT_ENABLED',
  'REWARD_REMIT_LOOKBACK_DAYS',
  'REWARD_REMIT_LANE_CAP',
  'REWARD_COMMIT_ENABLED',
  'REWARD_COMMIT_LOOKBACK_DAYS',
  'GRACE_DEFAULT_ENABLED',
  'LIQ_CONFIDENCE_MIN_CHECKS',
  'LIQ_CONFIDENCE_MIN_WINDOW_DAYS',
  'LIQ_TIER3_MIN_TVL_USD',
  'LIQ_TIER3_DISABLE_DEFI_LISTING',
  'LIQ_TIER3_MIN_MCAP_USD',
  'LIQ_TIER3_MIN_VOL_USD',
  'SPLIT_MIN_IMPROVEMENT_BPS',
  'PARTIAL_LIQ_MIN_HF_BPS',
] as const;

/** The shared database the Worker binds as `DB` (`vaipakam-warm`). */
export const DEFAULT_D1_DATABASE_ID = 'e5e927cf-56c3-42c7-9820-179a235cc84f';

export type ProcessEnv = Record<string, string | undefined>;

export function rawEnvFromProcess(env: ProcessEnv, fetchFn?: typeof fetch): WorkerEnv {
  const required = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required to run the keeper off Workers`);
    return v;
  };
  const db = new D1HttpDatabase({
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: required('KEEPER_D1_API_TOKEN'),
    databaseId: env.KEEPER_D1_DATABASE_ID || DEFAULT_D1_DATABASE_ID,
    fetchFn,
  });
  const raw: Record<string, unknown> = { DB: db as unknown as D1Database };
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (value) raw[name] = { get: async () => value };
  }
  for (const name of KNOB_NAMES) {
    const value = env[name];
    if (value !== undefined && value !== '') raw[name] = value;
  }
  return raw as unknown as WorkerEnv;
}
