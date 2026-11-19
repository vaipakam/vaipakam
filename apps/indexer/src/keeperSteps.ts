/**
 * `GET /keeper/steps?chainId=<deployment chain>` — which keeper steps this
 * deployment's keeper is running, as the keeper last published them (#3681).
 *
 * WHAT IT IS FOR. A borrower's standing instruction (a collateral top-up, a
 * due repayment, an interest payment) authorises anyone to run it; it is not
 * a promise that someone will. Each deployment's keeper may have any of the
 * three steps armed or not. The keeper's `standingInstructions` pass writes
 * migration 0098's table every few minutes while it runs; this route only
 * reads it, so the app's "Reserve and instructions" panel can show, per
 * instruction, whether an automatic runner is active here, and say plainly
 * when it is not or when that cannot be told.
 *
 * WHAT IT STATES, per step: the keeper pass and step, the Diamond the keeper
 * serves on the chain, whether its flag was armed, and when the keeper last
 * said so. `running` is true only when the step was armed AND that statement
 * is fresh (no older than `staleAfterSeconds`): a keeper that stopped writing
 * may have stopped running, so an old row is never read as the last word.
 * The app should also compare `diamond` with the Diamond it serves.
 *
 * Steps for the standing-instructions pass: `topUp` (the collateral top-up),
 * `repay` (the due repayment) and `interest` (the interest payment). Steps for
 * the protected-account pass (#3756 §4.6, whether owner alerts are sent here):
 * `alerts` (the owner alerts, among them the recovery-claim reminders),
 * `alertsTelegram` (the keeper can reach the agent that sends Telegram; the
 * agent's own bot token is not covered) and `alertsPush` (the keeper's Push
 * rail can send). A channel step is armed only while `alerts` is. A step
 * with no row has never been published on this chain: read it as not running.
 *
 * D1 only, dispatched before `resolveEnv` (index.ts) like `/assets/rankings`.
 * Tolerates the previous schema: before 0098 is applied the table does not
 * exist and the route answers 503 `unavailable`, never an empty list, which
 * the app reads as "cannot be read". Never cached: a stopped keeper must read
 * as stopped.
 */
import { redactedError } from '@vaipakam/lib/errorDescription';
import { parseTokenChainId } from './assetRankings';

/** A published row older than this reads as not running: three times the
 *  keeper's publish interval (`STATUS_PUBLISH_SEC`, five minutes). */
export const KEEPER_STEP_STALE_SEC = 15 * 60;

/** The narrow D1 surface this route reads. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

interface StepRow {
  pass: string;
  step: string;
  diamond: string;
  armed: number;
  observed_at: number;
}

export interface KeeperStep {
  pass: string;
  step: string;
  /** The Diamond the keeper serves on the chain, lowercase. */
  diamond: string;
  armed: boolean;
  /** Unix seconds, the keeper's clock. */
  observedAt: number;
  /** Armed, and said so within `staleAfterSeconds`. */
  running: boolean;
}

export interface KeeperSteps {
  chainId: number;
  staleAfterSeconds: number;
  steps: KeeperStep[];
}

const HEADERS: HeadersInit = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

/** Read one chain's published steps. Throws when the table cannot be read. */
export async function readKeeperSteps(db: D1Like, chainId: number, nowSec: number): Promise<KeeperSteps> {
  const rows = await db
    .prepare('SELECT pass, step, diamond, armed, observed_at FROM keeper_step_status WHERE chain_id = ? ORDER BY pass, step')
    .bind(chainId)
    .all<StepRow>();
  return {
    chainId,
    staleAfterSeconds: KEEPER_STEP_STALE_SEC,
    steps: (rows.results ?? []).map((r) => ({
      pass: r.pass,
      step: r.step,
      diamond: r.diamond,
      armed: r.armed === 1,
      observedAt: r.observed_at,
      running: r.armed === 1 && nowSec - r.observed_at <= KEEPER_STEP_STALE_SEC,
    })),
  };
}

/** The route. `db` is the shared D1 binding. */
export async function handleKeeperSteps(req: Request, db: D1Like, nowSec: number = Math.floor(Date.now() / 1000)): Promise<Response> {
  const chainId = parseTokenChainId(new URL(req.url).searchParams.get('chainId'));
  if (chainId === null) {
    return new Response(JSON.stringify({ error: 'chainId is required: the deployment chain id, a positive integer' }), {
      status: 400,
      headers: HEADERS,
    });
  }
  try {
    return new Response(JSON.stringify(await readKeeperSteps(db, chainId, nowSec)), { headers: HEADERS });
  } catch (err) {
    // Before migration 0098 the table is missing; any other read failure is
    // the same answer to the caller: whether a runner is active cannot be
    // stated now.
    console.error('[indexer] /keeper/steps read failed', redactedError(err));
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: HEADERS });
  }
}
