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

import { extractRevertName } from './decodeContractError';

/**
 * Remove every URL and every credential-shaped token from `text` (#2759).
 *
 * The one redaction rule every formatter here applies. A URL is removed
 * whole, host included, because some providers put the key in the
 * subdomain; that covers a URL written without its scheme too
 * (`host.tld/path`). Outside a URL it removes the value of a key-like query
 * or header field (`apikey=`, `token:`, `Authorization: Bearer …`) and a
 * Telegram bot token. It does not remove 32-byte hex values: transaction and
 * order hashes are what an operator searches a log for.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<redacted url>')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s"'<>)]*/gi, '<redacted url>')
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(
      /\b(api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd|authorization|auth|key|x-api-key)(["']?\s*[:=]\s*["']?)(?!<redacted)[^\s"'&,;}]+/gi,
      '$1$2<redacted>',
    )
    .replace(/\b\d{6,}:[a-z0-9_-]{30,}\b/gi, '<redacted token>');
}

/**
 * Strip anything URL-shaped or credential-shaped and cap the length.
 *
 * Applied even to fields that are conventionally bare identifiers: "an error
 * class is a single word" is a convention of the libraries we happen to use,
 * not a property of a value arriving from a dependency.
 */
export function redactAndBound(text: string): string {
  return redactSecrets(text).slice(0, 80);
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

/**
 * A one-line summary of a failure, safe to print, that keeps a contract's
 * revert reason (#2760).
 *
 * {@link describeFailure} prints class names and numbers only, so a revert
 * reads as `ContractFunctionExecutionError ← ContractFunctionRevertedError`
 * and the reason an operator needs is lost. viem keeps a decoded custom error's
 * NAME on `ContractFunctionRevertedError.data.errorName`, one or more causes
 * down, and not in any message (Codex #2807 r3): its `shortMessage` says only
 * `The contract function "x" reverted.` So the summary is that name, found by
 * walking the causes ({@link extractRevertName}), followed by viem's
 * `shortMessage`, which, unlike `message`, carries no request URL. Both are
 * values from a dependency, so anything URL-shaped in them is stripped by
 * {@link redactSecrets}. Without a `shortMessage` the bounded
 * description stands in. Never the raw message.
 */
export function summarizeFailure(err: unknown, max = 200): string {
  const stripUrls = redactSecrets;
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
  const body = typeof short === 'string' && short.length > 0 ? stripUrls(short) : describeFailure(err);
  const name = extractRevertName(err);
  return (name ? `${stripUrls(name)}: ${body}` : body).slice(0, max);
}

/** How many stack frames {@link redactedError} keeps. */
const MAX_STACK_FRAMES = 8;
/** How long a {@link redactedError} line may run. */
const MAX_REDACTED_ERROR_CHARS = 2_000;

/**
 * A failure as text for a log, an alert or a response, with every URL and
 * credential removed (#2759).
 *
 * {@link describeFailure} keeps only identifiers, which is right for an RPC
 * failure but loses what a database or a third-party error says (`no such
 * column: x`, a Telegram `chat not found`). This keeps the message, and the
 * message of each cause (`Name: message ← Name: message`, at most five
 * deep, cycles stopped), then the first eight frames of the outermost stack,
 * all passed through {@link redactSecrets} and bounded. It is what
 * `console.error(label, err)` printed before, minus the secrets. Pass
 * `{ stack: false }` where the text is a field (a result, a stored row)
 * rather than a log line.
 *
 * A thrown value that is not an Error is described by its type, never
 * stringified: an object can carry anything in its fields.
 */
export function redactedError(err: unknown, opts: { stack?: boolean } = {}): string {
  if (typeof err === 'string') return redactSecrets(err).slice(0, MAX_REDACTED_ERROR_CHARS);
  if (!(err instanceof Error)) {
    return `a thrown ${err === null ? 'null' : typeof err} (not an Error)`;
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur !== undefined && cur !== null; depth += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(`${cur.name || 'Error'}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(typeof cur === 'string' ? cur : `a ${typeof cur} cause`);
      break;
    }
  }
  const frames = (opts.stack === false ? '' : err.stack ?? '')
    .split('\n')
    .filter((l) => /^\s*at\s/.test(l))
    .slice(0, MAX_STACK_FRAMES)
    .map((l) => l.trim());
  const text = [parts.join(' ← '), ...frames].join('\n    ');
  return redactSecrets(text).slice(0, MAX_REDACTED_ERROR_CHARS);
}
