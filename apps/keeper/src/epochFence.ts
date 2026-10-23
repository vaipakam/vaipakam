/**
 * The epoch fence (#2569 r4): a launched pass acts only while the indexer's
 * epoch it was launched under still holds.
 *
 * The tick checks, before launching anything, that the indexer has settled
 * on the Diamond each chain is configured with (`keeperEpoch.ts`). A pass it
 * launches then runs for a while — on the machine, across later minutes —
 * and the indexer can adopt a new Diamond in the meantime: it records the new
 * one, clears the chain's shared rows, and repopulates them with the new
 * deployment's ids. A pass still running with the old chain configuration
 * would then read the OLD Diamond's state against the NEW epoch's rows, and
 * a loan id the new Diamond reuses could draw a liquidation, an alert or a
 * stored notification meant for another borrower's loan. Checking once at
 * launch does not hold that invariant for the pass's lifetime.
 *
 * So the invariant is enforced where a pass has an EFFECT, at four seams and
 * nowhere else:
 *
 *   - a transaction: `withSubmissionSlot` (`submissionQueue.ts`), which every
 *     send passes through, asserts the fence before the signature;
 *   - an alert to a subscriber: `AlertDelivery.deliver` (`alertDelivery.ts`) asserts
 *     it before either channel;
 *   - an operator alert about a chain: `sendOpsAlert` (`opsAlert.ts`) asserts
 *     it before the post (a global ops alert names no chain and is not held);
 *   - a write to a SHARED table the indexer resets on a Diamond change: the
 *     statement itself carries the guard ({@link epochWriteGuard}), so the
 *     check and the write are ONE statement, atomic on any transport.
 *     `test/epochFence.test.ts` pins that every such write in `src/` carries
 *     it, from the schema, so a new one cannot be added bare.
 *
 * WHY THE TWO KINDS OF SEAM DIFFER (#2569 r5). A row outlives the epoch: a
 * `notify_state` or `notifications` row written for loan 7 after the
 * indexer's reset is read, in the new epoch, as the NEW Diamond's loan 7, and
 * is never cleared again. So a check followed by the write — two calls, with
 * the indexer's adoption able to land between them — is not enough; the
 * write must be conditional in the same statement. A send or an alert is
 * consumed in the moment and read back by nothing: the check at that seam
 * sits after every read the effect was computed from and before the effect,
 * so an adoption BEFORE the check is seen and refuses it, and an adoption
 * AFTER the check leaves an effect computed entirely from the old epoch,
 * about the old Diamond, which is what it says it is.
 *
 * A read is not fenced: a read that leads to no effect changes nothing. A
 * write to the keeper's PRIVATE database is not fenced either: its chain-
 * keyed rows are cleared by the keeper's own epoch reset (`keeperEpoch.ts`)
 * on the first tick of the build that names the new Diamond, and no pass
 * runs under the new Diamond before that reset — the build change that names
 * it restarts the process, so no pass of the old build straddles it. A row
 * written under the old epoch is therefore gone before the first read under
 * the new one. A refused effect throws {@link EpochFenceRefusal}, which the
 * pass reports as any other failure; the tick keeps declining until the
 * keeper's build names the Diamond the indexer has settled on, and the next
 * launched pass starts from the new epoch.
 *
 * ARMED BY THE TICK, FOR THE PROCESS. The fence is module state, like the
 * submission queues: `runKeeperTick` arms it with the chains it just
 * reconciled, so every pass of that tick — and any pass still running from an
 * earlier one — is held to the same rule. Unarmed, every effect is refused:
 * an effect from a path no tick established the epochs for is exactly what
 * the fence exists to stop. Tests arm it with {@link armEpochFenceWith}.
 *
 * COST. A send or an alert pays one read of `indexer_deployment` (a row per
 * chain); a guarded write pays an EXISTS over that table inside its own
 * statement. Reads, the bulk of a pass, pay nothing.
 */
import { INDEXER_DEPLOYMENTS_SQL, indexerAdopted } from '../scripts/lib/indexer-adoption.mjs';
import type { ChainConfig } from './env';

/** One `indexer_deployment` row, as `INDEXER_DEPLOYMENTS_SQL` selects it. */
export interface IndexerAdoptionRow {
  chain_id: number;
  diamond: string;
  reset_pending: number;
}

interface ArmedFence {
  /** Reads every chain's current adoption; a failed read refuses the effect. */
  read: () => Promise<readonly IndexerAdoptionRow[]>;
  /** Chain id → the Diamond this build is configured with, lowercased. */
  want: ReadonlyMap<number, string>;
}

let armed: ArmedFence | null = null;

/** The refusal an effect gets when the fence does not hold. */
export class EpochFenceRefusal extends Error {
  constructor(message: string) {
    super(`epoch fence: ${message}`);
    this.name = 'EpochFenceRefusal';
  }
}

/** The Diamond each configured chain names, lowercased. */
export function configuredDiamonds(chains: readonly ChainConfig[]): Map<number, string> {
  return new Map(chains.map((c) => [c.id, String(c.diamond).toLowerCase()]));
}

/** Arm the fence with a reader of the indexer's adoptions and the chains to hold to. */
export function armEpochFenceWith(read: ArmedFence['read'], want: ReadonlyMap<number, string>): void {
  armed = { read, want };
}

/** Arm the fence from the shared database and the tick's resolved chains. */
export function armEpochFence(db: D1Database, chains: readonly ChainConfig[]): void {
  armEpochFenceWith(
    async () => (await db.prepare(INDEXER_DEPLOYMENTS_SQL).all<IndexerAdoptionRow>()).results ?? [],
    configuredDiamonds(chains),
  );
}

/** Test seam: forget the armed fence, so every effect is refused again. */
export function disarmEpochFence(): void {
  armed = null;
}

/**
 * Throws {@link EpochFenceRefusal} unless, for EVERY chain the fence holds
 * to, the indexer's settled adoption (`indexer-adoption.mjs`: recorded and
 * its reset done) is the configured Diamond — read now, not remembered.
 */
export async function assertEpochsHold(): Promise<void> {
  if (armed === null) {
    throw new EpochFenceRefusal('not armed — no tick has established the indexer epochs this process acts under');
  }
  let rows: readonly IndexerAdoptionRow[];
  try {
    rows = await armed.read();
  } catch (err) {
    throw new EpochFenceRefusal(`could not re-read the indexer's adoptions (${String(err)})`);
  }
  const settled = new Map<number, string | null>();
  for (const row of rows) settled.set(Number(row.chain_id), indexerAdopted(row));
  const moved: string[] = [];
  for (const [chainId, want] of armed.want) {
    const have = settled.get(chainId) ?? null;
    if (have !== want) moved.push(`chain ${chainId}: configured ${want}, indexer ${have ?? 'none settled'}`);
  }
  if (moved.length > 0) {
    throw new EpochFenceRefusal(`the indexer's epoch moved since this tick launched (${moved.join('; ')}); the tick declines until this build names it`);
  }
}

/**
 * The guard a SHARED write carries INSIDE its statement, so the check and
 * the write are one SQLite statement — atomic whatever the transport (the
 * machine reaches D1 one HTTP request per statement, and a batch's atomicity
 * over that API is not established, KeeperMachine.md). The statement writes
 * only while the indexer's settled adoption for `chainId` is the Diamond this
 * process is configured with, read by the same statement:
 *
 *   INSERT INTO t (a, b) SELECT ?, ? WHERE <where> ON CONFLICT ... DO UPDATE ...
 *   bind(a, b, ...binds)
 *
 * `where` is `EXISTS (...)` over `indexer_deployment`, the same rule as
 * `assertEpochsHold` (`indexer-adoption.mjs`: recorded, reset done), and
 * `binds` are its two parameters, placed AFTER the statement's own. Throws
 * {@link EpochFenceRefusal} while unarmed, or for a chain this process is not
 * configured for — a write for such a chain has no epoch to hold to.
 */
export function epochWriteGuard(chainId: number): { where: string; binds: [number, string] } {
  if (armed === null) {
    throw new EpochFenceRefusal('not armed — no tick has established the indexer epochs this process acts under');
  }
  const want = armed.want.get(chainId);
  if (want === undefined) throw new EpochFenceRefusal(`chain ${chainId} is not one this process is configured for`);
  return {
    where: 'EXISTS (SELECT 1 FROM indexer_deployment WHERE chain_id = ? AND lower(diamond) = ? AND reset_pending = 0)',
    binds: [chainId, want],
  };
}

/**
 * What a guarded write that ALWAYS changes a row when it runs (an upsert
 * with `DO UPDATE`) reports: zero changes means the guard refused it, and
 * the refusal is thrown so the pass reports it like any other failure. An
 * `INSERT OR IGNORE` cannot be judged this way — a duplicate also changes
 * nothing — and its caller says so where it reads the count.
 */
export function assertGuardedWriteLanded(result: { meta?: { changes?: number } } | undefined, what: string): void {
  if (Number(result?.meta?.changes ?? 0) === 0) {
    throw new EpochFenceRefusal(`${what} was refused by its statement's guard: the indexer's epoch moved since this tick launched`);
  }
}
