/**
 * The reorg guard (#3411): notice when the chain has replaced a block the
 * scan already indexed, and have the chain's rows rebuilt rather than left
 * describing blocks that no longer exist.
 *
 * WHY THE SAFE HEAD IS NOT ENOUGH ON ITS OWN. The scan reads only up to the
 * chain's own `safe` block (`settledHead.ts`) and advances its cursor
 * monotonically, never revisiting a block below it. That makes a
 * reorganisation below the cursor rare, not impossible: `safe` is the chain's
 * statement, and a chain can break it (Polygon PoS has had deep reorgs; an
 * L2's safe head follows its L1 batch, which can itself be replaced). When it
 * happens, nothing else in the indexer would ever look at those blocks again.
 *
 * THE CHECK. When the cursor advances, the pass records an ANCHOR: the top
 * of the window it scanned and that block's hash, read before the check and
 * the logs (`indexer_chain_anchor`, {@link readAnchorCandidate}). Every later
 * pass with a settled head reads the anchor block by number and compares
 * hashes. One anchor per chain detects any reorganisation reaching at or
 * below it, because replacing any earlier block changes the hash of every
 * block after it, the anchor included. A reorganisation entirely above the
 * anchor needs no action: those blocks were never indexed.
 *
 * WHY THE ROLLBACK IS A REBUILD. Loans and offers are state rows, updated in
 * place by later events, not an append-only log keyed by block. A replaced
 * block cannot be undone row by row without per-row history the schema does
 * not keep. So a detected reorganisation requests a REBUILD of the chain
 * (`deploymentEpoch.ts`, `requestChainRebuild`): every row the replay derives
 * is deleted and the scan replays from the deploy block, reading the chain as
 * it now is. Unlike a Diamond change it keeps every row born off chain, since
 * the Diamond is the same: the user's signed orders (their fill and cancel
 * state restarting for the replay), alert settings and dedupe, tickets
 * (`reorgRebuildKeep.json`). It is expensive, and it is reserved for an event the
 * chain itself said would not happen.
 *
 * WHAT A SINGLE ODD ANSWER DOES NOT DO. A rebuild wipes and replays a whole
 * chain, so it must not follow from one provider glitch. The guard reads the
 * anchor block TWICE and calls a reorganisation only when both reads return
 * the same hash and it differs from the anchor. A failed read, a block with
 * no hash, or two reads that disagree hold the scan for this pass instead
 * (the same correctness-over-liveness choice the settled-head hold makes): a
 * provider that cannot answer for a block at or below its own safe head is
 * not one to build rows on.
 */

/** A block hash as the RPC reports it (`0x` + 64 hex). Compared case-insensitively. */
export type BlockHash = string;

/** The D1 surface this module uses. */
export interface AnchorDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
    };
  };
}

/** The slice of a viem public client this needs. */
export interface AnchorBlockReader {
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash?: string | null }>;
}

/** The recorded anchor for a chain. */
export interface ChainAnchor {
  block: bigint;
  hash: BlockHash;
}

/**
 * What the check found.
 *
 * - `none`: no anchor yet (a chain never scanned, or one just reset). Nothing to compare.
 * - `intact`: the anchor block still carries the recorded hash.
 * - `above-head`: the anchor sits above the head this pass resolved (a lagging
 *   replica). Not compared this pass; the caller scans nothing below it until
 *   the head passes it again.
 * - `unreadable`: the anchor block could not be read consistently. Hold the scan.
 * - `replaced`: both reads agree on a different hash. The chain replaced an indexed block.
 */
export type AnchorVerdict =
  | { state: 'none' }
  | { state: 'intact'; anchor: ChainAnchor }
  | { state: 'above-head'; anchor: ChainAnchor }
  | { state: 'unreadable'; anchor: ChainAnchor; reason: string }
  | { state: 'replaced'; anchor: ChainAnchor; seen: BlockHash };

const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** One read of a block's hash: the hash, or why there is none. */
async function readHash(
  client: AnchorBlockReader,
  block: bigint,
  describe: (err: unknown) => string,
): Promise<{ hash: BlockHash } | { reason: string }> {
  try {
    const b = await client.getBlock({ blockNumber: block });
    if (b.number !== block) return { reason: `the provider returned block ${b.number} for ${block}` };
    if (!b.hash) return { reason: `the provider returned block ${block} without a hash` };
    return { hash: b.hash };
  } catch (err) {
    return { reason: describe(err) };
  }
}

/**
 * Compare the chain's anchor block with the recorded hash. The scan reads the
 * anchor together with its cursor (one query) and passes it in.
 *
 * `head` is the settled head this pass resolved; call this only on a settled
 * head (a pass holding on a guessed head reads nothing from the chain).
 * `describe` turns a read failure into a bounded, credential-free line (pass
 * `describeFailure`).
 */
export async function checkChainAnchor(
  client: AnchorBlockReader,
  anchor: ChainAnchor | null,
  head: bigint,
  describe: (err: unknown) => string,
): Promise<AnchorVerdict> {
  if (anchor === null) return { state: 'none' };
  if (anchor.block > head) return { state: 'above-head', anchor };

  const first = await readHash(client, anchor.block, describe);
  if ('reason' in first) return { state: 'unreadable', anchor, reason: first.reason };
  if (sameHash(first.hash, anchor.hash)) return { state: 'intact', anchor };

  // A different hash. Read again before acting on it: a rebuild is too costly
  // to follow from one answer.
  const second = await readHash(client, anchor.block, describe);
  if ('reason' in second) return { state: 'unreadable', anchor, reason: second.reason };
  if (sameHash(second.hash, anchor.hash)) {
    return {
      state: 'unreadable',
      anchor,
      reason: `two reads of block ${anchor.block} disagreed (${first.hash}, then the recorded ${second.hash})`,
    };
  }
  if (!sameHash(first.hash, second.hash)) {
    return {
      state: 'unreadable',
      anchor,
      reason: `two reads of block ${anchor.block} returned different hashes (${first.hash}, ${second.hash})`,
    };
  }
  return { state: 'replaced', anchor, seen: first.hash };
}

/**
 * The statement that records the anchor, for the caller to run in the SAME
 * batch as the cursor advance (one transaction): the anchor moves only when
 * the rows it vouches for have landed.
 *
 * Monotonic like the cursor: an older block never replaces a newer anchor,
 * so a stale or overlapping pass cannot move it back. The same block with a
 * different hash is never written by a pass either; only a reset clears the
 * row.
 */
export function anchorUpsert<S>(
  db: { prepare(sql: string): { bind(...args: unknown[]): S } },
  args: { chainId: number; block: bigint; hash: BlockHash; nowSec: number },
): S {
  return db
    .prepare(
      `INSERT INTO indexer_chain_anchor (chain_id, block_number, block_hash, recorded_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (chain_id) DO UPDATE SET
         block_number = excluded.block_number,
         block_hash = excluded.block_hash,
         recorded_at = excluded.recorded_at
       WHERE excluded.block_number > indexer_chain_anchor.block_number`,
    )
    .bind(args.chainId, Number(args.block), args.hash, args.nowSec);
}

/**
 * The anchor a pass will record when it finishes: the top of the window it is
 * about to scan, with that block's hash, READ BEFORE the anchor check and
 * before any log (Codex #3528 r1 P2).
 *
 * WHY THE ORDER. The new anchor retires the old one, so it must describe a
 * chain the pass has checked, never one fetched independently afterwards: a
 * fork landing mid-pass would otherwise hand the pass its OWN hash as the new
 * anchor, and the rows read from the replaced blocks would never be noticed.
 * Read first, the candidate is caught either way:
 *
 * - a replacement at or below the OLD anchor that lands after this read is
 *   seen by the anchor check that follows;
 * - one that lands after that check, while the logs are read, leaves the
 *   candidate naming the replaced block, so the NEXT pass's check sees a
 *   different hash and asks for the rebuild.
 *
 * The cost is that the anchor can sit above the cursor (a pass the budget
 * stopped short of its window), so a replacement of blocks the cursor has not
 * reached yet also asks for a rebuild. That is the expensive direction, and
 * the safe one.
 *
 * `headHash` is the settled head's own hash, read with the head: used when
 * the window ends at the head, so the common pass spends no read on this.
 */
export async function readAnchorCandidate(args: {
  client: AnchorBlockReader;
  windowTo: bigint;
  head: bigint;
  headHash: BlockHash | undefined;
  describe: (err: unknown) => string;
}): Promise<{ anchor: ChainAnchor } | { reason: string }> {
  const { client, windowTo, head, headHash, describe } = args;
  if (windowTo === head && headHash) return { anchor: { block: windowTo, hash: headHash } };
  const read = await readHash(client, windowTo, describe);
  if ('reason' in read) return { reason: read.reason };
  return { anchor: { block: windowTo, hash: read.hash } };
}

/**
 * Anchor a cursor that has none, at the block it stands on. Used once per
 * chain: for a chain scanned before the guard existed, and for a quiet chain
 * whose cursor has not advanced since. Only inserts (a concurrent pass's
 * anchor wins), and fails open: an unread hash leaves the chain unanchored
 * and the next pass tries again.
 */
export async function bootstrapChainAnchor(
  db: AnchorDb,
  client: AnchorBlockReader,
  chainId: number,
  block: bigint,
  describe: (err: unknown) => string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const read = await readHash(client, block, describe);
  if ('reason' in read) {
    console.warn(`[reorgGuard] chain ${chainId}: could not anchor cursor block ${block} (${read.reason}); retried next pass`);
    return false;
  }
  try {
    await db
      .prepare(
        `INSERT INTO indexer_chain_anchor (chain_id, block_number, block_hash, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (chain_id) DO NOTHING`,
      )
      .bind(chainId, Number(block), read.hash, nowSec)
      .run();
    return true;
  } catch (err) {
    console.warn(`[reorgGuard] chain ${chainId}: could not record the anchor (${describe(err)}); retried next pass`);
    return false;
  }
}

/** The operator line for a replaced anchor. */
export function describeReplacedAnchor(chainId: number, v: Extract<AnchorVerdict, { state: 'replaced' }>): string {
  return (
    `[reorgGuard] chain ${chainId}: REORG BELOW THE SCAN CURSOR. Block ${v.anchor.block} was indexed ` +
    `with hash ${v.anchor.hash} and the chain now reports ${v.seen} (read twice). Rows indexed from ` +
    `the replaced blocks no longer describe the chain, so this chain's rows are being rebuilt from ` +
    `the deploy block; until the replay catches up, its offers, loans and activity are incomplete.`
  );
}
