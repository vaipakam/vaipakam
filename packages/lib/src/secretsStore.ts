/**
 * Reading Cloudflare Secrets Store bindings — the one rule for every Worker
 * that holds secrets.
 *
 * ── Why a failed read is not fatal ───────────────────────────────────
 *
 * A Worker reads all its secrets in parallel at the top of each cron run or
 * request. A read can fail: a short Secrets Store outage, or a secret
 * deleted or deactivated after a deploy. If one rejected read rejected the
 * whole set, a single unavailable secret would stop the entire run,
 * including every part of it that never uses that secret. So a failed read
 * resolves to `undefined`, the same as an unbound secret. Every secret field
 * downstream is optional and already handled when absent: that chain is
 * skipped, that adapter is off, that endpoint answers 503 or 401. The failure
 * stays scoped to the feature that needs the secret. (T-078, PR #36 review.)
 *
 * ── Why every failure is logged by name ──────────────────────────────
 *
 * The read used to be positional (`Promise.all` over an array of bindings),
 * so the log could only say THAT a secret failed. An operator then had to
 * match the `Promise.all (index N)` frame in the stack to the order of the
 * array in the source, which is how a single all-secrets outage on the agent
 * (2026-11-05 05:31 UTC, 17 lines) was first misread as a missing key. The
 * read is now keyed by the binding's name, and the log names it.
 *
 * When EVERY bound secret fails in the same run, the cause is the store, not
 * one key, so that run logs ONE line saying so and listing the names,
 * instead of one line per secret. Values are never logged, and errors pass
 * through {@link redactedError}.
 */

import { redactedError } from './errorDescription';

/** A Secrets Store binding as a Worker sees it. */
export type SecretBinding = { get(): Promise<string> };

/** Options for {@link readSecret} and {@link readSecrets}. */
export interface ReadSecretOptions {
  /** Called once for each binding actually read, before the read: lets a
   *  Worker count the call against its own subrequest budget. */
  onRead?: () => void;
  /** Where the lines go. Defaults to `console.error`. */
  log?: (line: string) => void;
}

/** One read's outcome, kept apart from logging so the set can decide what to say. */
type Outcome =
  | { kind: 'unbound' }
  | { kind: 'read'; value: string }
  | { kind: 'failed'; error: string };

async function readOne(b: SecretBinding | undefined, onRead?: () => void): Promise<Outcome> {
  if (!b) return { kind: 'unbound' };
  try {
    onRead?.();
    return { kind: 'read', value: await b.get() };
  } catch (err) {
    return { kind: 'failed', error: redactedError(err) };
  }
}

// eslint-disable-next-line no-console
const defaultLog = (line: string) => console.error(line);

function failedLine(name: string, error: string): string {
  return `[env] Secrets Store: could not read ${name}; treating it as unset for this run: ${error}`;
}

/**
 * Read one named secret. `undefined` when it is unbound or the read failed;
 * a failure is logged with the secret's name.
 */
export async function readSecret(
  name: string,
  b: SecretBinding | undefined,
  opts: ReadSecretOptions = {},
): Promise<string | undefined> {
  const out = await readOne(b, opts.onRead);
  if (out.kind === 'failed') (opts.log ?? defaultLog)(failedLine(name, out.error));
  return out.kind === 'read' ? out.value : undefined;
}

/**
 * Read a set of named secrets in parallel. Each key of the result is the
 * secret's value, or `undefined` when it is unbound or could not be read.
 *
 * Logging: each failed read is one line naming the secret. When every bound
 * secret failed (and there was more than one), the run logs one line instead,
 * saying the store was unavailable and naming them all.
 */
export async function readSecrets<K extends string>(
  bindings: { readonly [P in K]: SecretBinding | undefined },
  opts: ReadSecretOptions = {},
): Promise<{ [P in K]: string | undefined }> {
  const names = Object.keys(bindings) as K[];
  const outcomes = await Promise.all(names.map((n) => readOne(bindings[n], opts.onRead)));
  const log = opts.log ?? defaultLog;

  const bound = names.filter((_, i) => outcomes[i].kind !== 'unbound');
  const failed = names
    .map((n, i) => ({ n, o: outcomes[i] }))
    .filter((x): x is { n: K; o: Extract<Outcome, { kind: 'failed' }> } => x.o.kind === 'failed');

  if (failed.length > 1 && failed.length === bound.length) {
    log(
      `[env] Secrets Store unavailable: none of the ${failed.length} secrets could be read this run ` +
        `(${failed.map((f) => f.n).join(', ')}). Everything that needs them is skipped until a later run reads them. ` +
        `First error: ${failed[0].o.error}`,
    );
  } else {
    for (const f of failed) log(failedLine(f.n, f.o.error));
  }

  const result = {} as { [P in K]: string | undefined };
  names.forEach((n, i) => {
    const o = outcomes[i];
    result[n] = o.kind === 'read' ? o.value : undefined;
  });
  return result;
}
