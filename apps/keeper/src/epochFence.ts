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
 * So the invariant is enforced where a pass has an EFFECT, re-reading the
 * indexer's adoptions each time, at three seams and nowhere else:
 *
 *   - a transaction: `withSubmissionSlot` (`submissionQueue.ts`), which every
 *     send passes through, asserts the fence before the signature;
 *   - an alert to a subscriber: `deliverAlert` (`alertDelivery.ts`);
 *   - a database write: the `DB` / `KEEPER_DB` handles a pass receives are
 *     wrapped by {@link fencedD1}, which asserts the fence before any
 *     statement that writes, and before every batch.
 *
 * A read is not fenced: a read that leads to no effect changes nothing, and
 * the keeper's own private rows for a chain are cleared by its epoch reset
 * on the first tick of the build that names the new Diamond. A refused
 * effect throws {@link EpochFenceRefusal}, which the pass reports as any
 * other failure; the tick keeps declining until the keeper's build names the
 * Diamond the indexer has settled on, and the next launched pass starts from
 * the new epoch.
 *
 * ARMED BY THE TICK, FOR THE PROCESS. The fence is module state, like the
 * submission queues: `runKeeperTick` arms it with the chains it just
 * reconciled, so every pass of that tick — and any pass still running from an
 * earlier one — is held to the same rule. Unarmed, every effect is refused:
 * an effect from a path no tick established the epochs for is exactly what
 * the fence exists to stop. Tests arm it with {@link armEpochFenceWith}.
 *
 * COST. One read of `indexer_deployment` (a row per chain) per effect. Sends
 * and alerts are rare; writes come in batches. Reads, the bulk of a pass, pay
 * nothing.
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

/** A statement that writes, by its leading keyword. `WITH` counts as one:
 *  a CTE may feed an INSERT, and an extra check on a read costs one read. */
const WRITES = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH)\b/i;

const INNER = Symbol('epochFence.inner');

type Statement = D1PreparedStatement & { [INNER]?: D1PreparedStatement };

function fencedStatement(inner: D1PreparedStatement, sql: string): D1PreparedStatement {
  const gate = async () => {
    if (WRITES.test(sql)) await assertEpochsHold();
  };
  const wrapped: Statement = {
    [INNER]: inner,
    bind: (...values: unknown[]) => fencedStatement(inner.bind(...values), sql),
    first: (async (column?: string) => {
      await gate();
      return column === undefined ? inner.first() : inner.first(column);
    }) as D1PreparedStatement['first'],
    all: (async () => {
      await gate();
      return inner.all();
    }) as D1PreparedStatement['all'],
    raw: (async (options?: { columnNames?: boolean }) => {
      await gate();
      return options === undefined ? inner.raw() : inner.raw(options as never);
    }) as D1PreparedStatement['raw'],
    run: (async () => {
      await gate();
      return inner.run();
    }) as D1PreparedStatement['run'],
  } as Statement;
  return wrapped;
}

/** The statement `batch` must hand the binding: the one it was built from. */
function unwrap(statement: D1PreparedStatement): D1PreparedStatement {
  return (statement as Statement)[INNER] ?? statement;
}

/**
 * `db`, with every write fenced: a statement whose SQL writes asserts the
 * fence before it runs, whichever method runs it, and so does every batch
 * and `exec`. Reads pass through. Statements it prepares can be handed to
 * its own `batch`, which unwraps them for the binding.
 */
export function fencedD1<T extends D1Database>(db: T): T {
  const fenced = {
    prepare: (sql: string) => fencedStatement(db.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      await assertEpochsHold();
      return db.batch(statements.map(unwrap));
    },
    exec: async (sql: string) => {
      await assertEpochsHold();
      return db.exec(sql);
    },
    dump: () => db.dump(),
    withSession: (constraint?: unknown) => (db as unknown as { withSession: (c?: unknown) => unknown }).withSession(constraint),
  };
  return fenced as unknown as T;
}
