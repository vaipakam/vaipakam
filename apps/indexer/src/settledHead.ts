/**
 * The block a pass pins its reads to — and whether the CHAIN called it
 * settled, or we guessed (#2201).
 *
 * The `safe` tag is the chain's own statement about finality. The fallback —
 * a fixed step back from the tip — is a heuristic finality MARGIN, and a
 * reorganisation deeper than the margin presents state that later
 * disappears.
 *
 * **Both consumers are exposed by that, and neither recovers on its own.**
 * It is tempting to say the scan self-corrects — that a wrong read leaves
 * its cursor re-readable and events replay — and it is false: the cursor
 * advances monotonically from `lastBlock + 1`, so a reorganised-out block is
 * never revisited and its rows stay wrong in D1 for good. The scan's own
 * comment says this in as many words. `_CodeVsDocsAudit.md` records the
 * claim and its retraction, because the retraction has had to be made more
 * than once.
 *
 * What differs is severity, not recoverability. The correction's wrong
 * record is a position published as CLOSED when it is open, and it cannot
 * even be re-examined by the mechanism that wrote it, since that mechanism
 * selects only live rows. So the correction refuses a guessed head today
 * (see `_runLoanReconcilePass`); the scan's exposure is real, is NOT fixed
 * here, and stays tracked on #2201.
 *
 * **When the fallback engages is wider than "an old node".** The `catch` is
 * unconditional, so a timeout or a momentary error from a provider that
 * normally answers takes it just as a provider that cannot answer does.
 * Supporting the tag does not exempt a deployment; it only makes the
 * contingency rarer — which is why `fallbackReason` travels with the answer
 * instead of the caller guessing at a cause.
 *
 * ONE definition, because there were two. `chainIndexer` and `recycleRoutes`
 * each carried their own `SAFE_FALLBACK_BUFFER` and their own try/catch, the
 * second commented "mirrors chainIndexer's" — a mirror is a copy that has
 * not drifted YET.
 */

/** How far back from the tip to step when no settled block can be read. */
export const SAFE_FALLBACK_BUFFER = 32n;

export interface SettledHead {
  /** The block number every read in this pass pins to. */
  block: bigint;
  /** That block's timestamp. */
  timestamp: bigint;
  /**
   * TRUE only when the chain itself answered the `safe` tag.
   *
   * False means the number above is `latest - SAFE_FALLBACK_BUFFER` — a
   * guess good enough to keep a scan moving and not good enough to close a
   * position on.
   */
  settled: boolean;
  /**
   * Why the settled read did not answer, when it did not. Present only on a
   * fallback.
   *
   * Carried rather than inferred: "unsupported tag" and "the provider timed
   * out" send an operator to different remedies, and the caller cannot tell
   * them apart from a boolean.
   */
  fallbackReason?: string;
}

/** The slice of a viem public client this needs. */
interface HeadReader {
  // Two overloads rather than one optional-everything argument: viem's own
  // parameter type is a union of mutually exclusive selectors (hash OR
  // number OR tag), and a shape offering both at once is not assignable to
  // it.
  getBlock(args: { blockTag: 'safe' }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getBlockNumber(): Promise<bigint>;
}

/**
 * Resolve the head, saying where it came from.
 *
 * The fallback branch costs one read more than a bare `getBlockNumber()`,
 * because the timestamp of the block actually pinned is part of the answer
 * and `latest`'s timestamp is not the same thing. On the ordinary path this
 * is one call, exactly as the two copies it replaced were.
 */
export async function resolveSettledHead(client: HeadReader): Promise<SettledHead> {
  let reason: string;
  try {
    const safe = await client.getBlock({ blockTag: 'safe' });
    if (safe.number !== null) {
      return { block: safe.number, timestamp: safe.timestamp, settled: true };
    }
    // A `safe` block always has a number; `null` is the `pending` case, which
    // is not a tag this asks for. Treated as a non-answer rather than
    // coerced — pinning to genesis and calling it settled is the one outcome
    // worse than falling back.
    reason = 'the provider returned a safe block with no number';
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  const latest = await client.getBlockNumber();
  const block = latest > SAFE_FALLBACK_BUFFER ? latest - SAFE_FALLBACK_BUFFER : 0n;
  const pinned = await client.getBlock({ blockNumber: block });
  return { block, timestamp: pinned.timestamp, settled: false, fallbackReason: reason };
}
