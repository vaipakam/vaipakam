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

/** A bounded description of a failure, safe to print. Never the message. */
export function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'a non-Error value was thrown';
  const e = err as Error & { code?: unknown; status?: unknown };
  const parts = [redactAndBound(e.name || 'Error')];
  if (typeof e.code === 'number') parts.push(`rpc code ${e.code}`);
  if (typeof e.status === 'number') parts.push(`HTTP ${e.status}`);
  return parts.join(', ');
}
