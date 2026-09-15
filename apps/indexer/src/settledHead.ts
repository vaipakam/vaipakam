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
   *
   * **Built from bounded fields, never from the error's message** — see
   * `describeFailure`. The RPC URLs carry API keys, and viem puts the whole
   * request URL in `HttpRequestError.message`, so carrying that text would
   * have printed a credential into the operator log on every tick of a
   * provider that rejects the tag. The bounded fields say as much: a
   * `TimeoutError` and an `RpcRequestError` with code -32601 are exactly the
   * two cases an operator needs to tell apart.
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
 * A bounded description of a failed settled read, safe to print.
 *
 * NOT the error's message. `chain.rpc` embeds an API key on every hosted
 * provider this deploys against, and viem's `HttpRequestError` /
 * `RpcRequestError` carry the full request URL inside `.message` — so
 * quoting it would leak that key into the operator log, repeatedly, exactly
 * on the providers whose settled read is failing (#2211 r1 `4011103040`).
 *
 * The fields taken instead are a class name and two numbers. That is not a
 * reduced version of the message, it is the identifying part of it: a
 * `TimeoutError` and an `RpcRequestError` carrying -32601 are the two cases
 * worth telling apart, and neither number can contain a secret.
 *
 * The name is still truncated and URL-stripped rather than trusted. It is
 * conventionally a bare identifier, and "conventionally" is not a property
 * of a value arriving from a dependency.
 */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'a non-Error value was thrown';
  const e = err as Error & { code?: unknown; status?: unknown };
  const parts = [redactAndBound(e.name || 'Error')];
  if (typeof e.code === 'number') parts.push(`rpc code ${e.code}`);
  if (typeof e.status === 'number') parts.push(`HTTP ${e.status}`);
  return parts.join(', ');
}

/** Strip anything URL-shaped and cap the length. Belt and braces for the above. */
function redactAndBound(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<redacted url>').slice(0, 80);
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
    reason = describeFailure(err);
  }
  const latest = await client.getBlockNumber();
  const block = latest > SAFE_FALLBACK_BUFFER ? latest - SAFE_FALLBACK_BUFFER : 0n;
  const pinned = await client.getBlock({ blockNumber: block });
  return { block, timestamp: pinned.timestamp, settled: false, fallbackReason: reason };
}

/**
 * A block number as a number, and ONLY a block number.
 *
 * `Number()` accepts anything, which is how `Number(head)` kept compiling
 * after `head` was rebound from a `bigint` to the object above — and quietly
 * produced `NaN` for the block stamped on every repaired terminal
 * notification (#2211 r2 `4011201400`). A name reverting to its old meaning
 * fixes that site; this makes the class of mistake a compile error where a
 * block crosses into D1, which is where it matters, since SQLite takes `NaN`
 * without complaint.
 *
 * **Applied to the head-derived path, deliberately not swept tree-wide.**
 * The other ~13 `Number(log.blockNumber)` sites take a `bigint` straight off
 * a viem log and were never reachable by this substitution, so converting
 * them is tidiness rather than a fix — and a mid-review-loop refactor is
 * exactly what the repo's triage rule says not to grow a diff with. Stated
 * here so the boundary reads as a decision rather than as the sweep running
 * out of steam.
 */
export function blockToNumber(block: bigint): number {
  return Number(block);
}
