/**
 * How a thrown value is described in a log, when the thing that threw was a
 * network client (#2213 r5 `4012300079`).
 *
 * **The hazard is specific and it is not obvious from the call site.** Every
 * RPC URL this monorepo deploys against embeds an API key, and viem puts the
 * WHOLE request URL inside `HttpRequestError.message` / `RpcRequestError`.
 * So `String(err)` in a `catch` writes that credential into the operator log
 * — repeatedly, on exactly the providers that are failing, which is when the
 * log is being read. Truncating does not help: the URL appears near the start
 * of viem's message, so a 200-character slice keeps the key and drops the
 * part a human wanted.
 *
 * **Why this is in the shared package rather than next to one caller.** It
 * was written once, as a private helper in the indexer's head resolver, with
 * a comment explaining the hazard in full — and the very next change wrote
 * `String(err).slice(0, 200)` into the agent's reminder lane around a viem
 * read. A rule that lives inside one module protects that module; the hazard
 * belongs to every Worker that holds an RPC client. One rule, every caller.
 *
 * WHAT THIS IS NOT: a reduced version of the message. It is the identifying
 * part of it. A `TimeoutError`, an `RpcRequestError` carrying -32601, and an
 * `HttpRequestError` carrying HTTP 429 are the cases an operator separates,
 * and none of the three fields can contain a secret.
 *
 * **AND IT HAS TO LOOK THROUGH THE WRAPPER TO FIND THEM** (#2213 r25
 * `4015755031`). viem does not throw the useful error; it throws a
 * `ContractFunctionExecutionError` whose `cause` is the `HttpRequestError` or
 * `RpcRequestError` that actually carries the status or the code. Reading only
 * the outer object printed the wrapper's class name for every one of those
 * cases — collapsing exactly the three the paragraph above says are the point
 * of this function, on the most common caller in the tree (`readContract`).
 *
 * The tests did not catch it because they CONSTRUCTED the shape the code
 * expected — a bare `Error` with a top-level `status` — rather than the shape
 * viem produces. An assertion written against your own assumption cannot
 * falsify it; the suite now builds real viem errors.
 */

/**
 * Strip anything URL-shaped and cap the length.
 *
 * Applied even to fields that are conventionally bare identifiers: "an error
 * class is a single word" is a convention of the libraries we happen to use,
 * not a property of a value arriving from a dependency.
 */
export function redactAndBound(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<redacted url>').slice(0, 80);
}

/**
 * How deep to follow `cause`.
 *
 * Bounded rather than trusting the chain to end: `cause` is an arbitrary
 * value from a dependency and nothing stops it being cyclic or absurdly long.
 * The seen-set handles cycles; this handles length.
 */
const MAX_CAUSE_DEPTH = 5;

/** A bounded description of a failure, safe to print. Never the message. */
export function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'a non-Error value was thrown';

  // WALK THE CHAIN, taking the first of each field that appears — outermost
  // wins, which is the one closest to the operation that failed. Names are
  // collected too: `ContractFunctionExecutionError` alone says only "a
  // contract read failed", where the inner class says WHY.
  const names: string[] = [];
  let code: number | undefined;
  let status: number | undefined;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur instanceof Error; depth += 1) {
    if (seen.has(cur)) break; // a cycle, which a dependency is free to hand us
    seen.add(cur);
    const e = cur as Error & { code?: unknown; status?: unknown; cause?: unknown };
    const name = redactAndBound(e.name || 'Error');
    // Only distinct names, and only while they add something: a chain of five
    // identical wrappers is one fact, not five.
    if (name && !names.includes(name)) names.push(name);
    if (code === undefined && typeof e.code === 'number') code = e.code;
    if (status === undefined && typeof e.status === 'number') status = e.status;
    cur = e.cause;
  }

  // At most two names — the operation that failed and the reason — so a deep
  // wrapper stack cannot turn this line into a stack trace by another route.
  const parts = [names.slice(0, 2).join(' ← ') || 'Error'];
  if (code !== undefined) parts.push(`rpc code ${code}`);
  if (status !== undefined) parts.push(`HTTP ${status}`);
  return parts.join(', ');
}
