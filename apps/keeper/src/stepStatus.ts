// apps/keeper/src/stepStatus.ts
//
// Which steps of a keeper pass are armed on each chain, published where the
// app can read it (`keeper_step_status`, shared migration 0098, served by the
// indexer's `GET /keeper/steps`).
//
// A pass whose work the app describes to a user (a standing instruction that
// anyone may run, an owner alert the user relies on) must not let the app
// present that work as happening when this deployment's keeper does not do
// it. So each such pass publishes its steps' armed state every few minutes
// while the keeper runs, armed or not, and the indexer reads a row older than
// three publish intervals as not running. One publisher per pass, built here,
// so every pass publishes on the same rule.

import { publishKeeperStepStatus } from './db';
import { shortErr } from './callErrors';

/** How often a pass's armed steps are republished while the keeper runs. The
 *  indexer's `/keeper/steps` reads a row older than three times this as not
 *  running (`KEEPER_STEP_STALE_SEC`). */
export const STATUS_PUBLISH_SEC = 5 * 60;

export interface StepPublisher<S extends string> {
  /**
   * Publish which of the pass's steps are armed on each chain: at most once
   * per STATUS_PUBLISH_SEC per chain, and at once when the armed set changes.
   * Every chain the keeper serves is published, armed or not. A failed write
   * is logged and retried next run; it never stops the pass.
   */
  publish(db: D1Database, chains: readonly { id: number; diamond: string }[], armed: ReadonlySet<S>, nowSec: number): Promise<void>;
  /** Forget what was published (tests). */
  reset(): void;
}

/** The publisher for `pass`, whose steps are `steps` (in their stored order). */
export function stepPublisher<S extends string>(pass: string, steps: readonly S[]): StepPublisher<S> {
  /** When this process last published each chain's steps, and what. */
  const lastPublished = new Map<number, { at: number; armed: string }>();
  return {
    async publish(db, chains, armed, nowSec) {
      const key = steps.filter((s) => armed.has(s)).join(',');
      const due = chains.filter((c) => {
        const last = lastPublished.get(c.id);
        return last === undefined || last.armed !== key || nowSec - last.at >= STATUS_PUBLISH_SEC;
      });
      if (due.length === 0) return;
      try {
        await publishKeeperStepStatus(
          db,
          due.flatMap((c) =>
            steps.map((step) => ({ chain_id: c.id, diamond: c.diamond, pass, step, armed: armed.has(step) ? (1 as const) : (0 as const), observed_at: nowSec })),
          ),
        );
        for (const c of due) lastPublished.set(c.id, { at: nowSec, armed: key });
      } catch (err) {
        console.warn(`[keeper] ${pass}: the armed steps could not be published, so the app may read them as stale (${shortErr(err)})`);
      }
    },
    reset() {
      lastPublished.clear();
    },
  };
}
