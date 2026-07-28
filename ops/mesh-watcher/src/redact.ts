/**
 * Strip secrets out of anything that leaves this Worker.
 *
 * viem embeds the request URL in its error messages —
 * `URL: https://base-mainnet.g.alchemy.com/v2/<key>` — and common
 * providers put the API key in the path or the query string. Those errors
 * were being copied verbatim into coverage findings, which are sent to
 * Telegram and written to Worker logs, so a provider having a bad minute
 * would have published the `RPC_<chainId>` secrets to the ops chat
 * (Codex #1443 r4, confirmed by constructing a viem `HttpRequestError`
 * and observing the key in `.message`).
 *
 * Two layers, because either alone has a gap:
 *
 * 1. **Exact match** on every configured secret. Precise, and renders as
 *    a named placeholder the operator can act on (`<RPC_42161>`), but
 *    only covers values this Worker knows about.
 * 2. **Structural** — any URL keeps its scheme and host and loses its
 *    path, query and fragment. Catches credentials in a URL this Worker
 *    never configured (a provider redirect, an upstream's own upstream)
 *    and keeps the host, which is the part worth reading in an outage.
 */

import { rpcFor, type Env } from './env';

/** Placeholder for a path/query that may carry credentials. */
const STRIPPED = '/<redacted>';

/** Longest-first, so a secret that contains another is replaced whole. */
function collectSecrets(env: Env, chainIds: readonly number[]): [string, string][] {
  const pairs: [string, string][] = [];

  for (const chainId of chainIds) {
    const url = rpcFor(env, chainId);
    if (url) pairs.push([url, `<RPC_${chainId}>`]);
  }
  if (typeof env.TG_OPS_BOT_TOKEN === 'string' && env.TG_OPS_BOT_TOKEN) {
    pairs.push([env.TG_OPS_BOT_TOKEN, '<TG_OPS_BOT_TOKEN>']);
  }
  if (typeof env.WATCHER_RUN_TOKEN === 'string' && env.WATCHER_RUN_TOKEN) {
    pairs.push([env.WATCHER_RUN_TOKEN, '<WATCHER_RUN_TOKEN>']);
  }

  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/** Replace every occurrence of `needle`, without regex escaping concerns. */
function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  return haystack.split(needle).join(replacement);
}

/**
 * Strip the path, query and fragment from every URL in `text`, keeping
 * scheme and host.
 *
 * Deliberately hand-rolled rather than a regex with a greedy tail: the
 * inputs are error messages where a URL is followed by prose, and the
 * terminator set (whitespace, quotes, brackets, trailing punctuation) is
 * easier to get right explicitly than to encode.
 */
export function stripUrlPaths(text: string): string {
  const TERMINATORS = new Set([' ', '\n', '\t', '"', "'", '`', '<', '>', ')', ']', '}', ',', ';']);
  let out = '';
  let i = 0;

  while (i < text.length) {
    const httpsAt = text.indexOf('http', i);
    if (httpsAt === -1) {
      out += text.slice(i);
      break;
    }
    const rest = text.slice(httpsAt);
    if (!rest.startsWith('http://') && !rest.startsWith('https://')) {
      out += text.slice(i, httpsAt + 4);
      i = httpsAt + 4;
      continue;
    }

    // Find where the URL ends.
    let end = httpsAt;
    while (end < text.length && !TERMINATORS.has(text[end]!)) end += 1;
    const url = text.slice(httpsAt, end);

    const schemeEnd = url.indexOf('://') + 3;
    const hostEnd = (() => {
      for (let j = schemeEnd; j < url.length; j += 1) {
        const c = url[j]!;
        if (c === '/' || c === '?' || c === '#') return j;
      }
      return url.length;
    })();

    // USERINFO is a credential too. `https://user:secret@rpc.example/…`
    // keeps its secret entirely inside the authority, so stripping only
    // the path would have preserved it verbatim (Codex #1443 r6).
    const authority = url.slice(schemeEnd, hostEnd);
    const at = authority.lastIndexOf('@');
    const safeAuthority =
      at === -1 ? authority : `<redacted>@${authority.slice(at + 1)}`;

    out += text.slice(i, httpsAt);
    out += url.slice(0, schemeEnd) + safeAuthority;
    if (hostEnd < url.length) out += STRIPPED;
    i = end;
  }

  return out;
}

/** A redactor bound to this Worker's configured secrets. */
export type Redactor = (text: string) => string;

/**
 * Build the redactor.
 *
 * @param chainIds Chains whose `RPC_<id>` secrets should be recognised.
 *                 Pass every chain the tick may touch — a URL that is not
 *                 listed still loses its path via {@link stripUrlPaths},
 *                 but is not named.
 */
export function makeRedactor(env: Env, chainIds: readonly number[]): Redactor {
  const secrets = collectSecrets(env, chainIds);
  return (text: string): string => {
    let out = text;
    for (const [secret, placeholder] of secrets) {
      out = replaceAll(out, secret, placeholder);
    }
    return stripUrlPaths(out);
  };
}

/**
 * Every chain id with an `RPC_<id>` secret configured.
 *
 * Discovered from the environment rather than taken from the caller, so
 * the failure paths — which run BEFORE the chain set is known — still
 * redact every configured endpoint.
 */
export function configuredRpcChainIds(env: Env): number[] {
  const ids: number[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('RPC_')) continue;
    const id = Number(key.slice(4));
    if (Number.isInteger(id) && typeof env[key] === 'string' && env[key]) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Redactor for paths where the chain set is not yet known — the
 * canonical-read failure and the tick-failure handler.
 *
 * Passing an empty chain list here left every `RPC_<id>` value
 * unredacted on exactly the path a canonical-read failure takes, so a
 * credential in the URL authority reached the log, the alert and the
 * `/run` body (Codex #1443 r6). It now discovers the configured chains
 * from the environment itself.
 */
export function makeBaseRedactor(env: Env): Redactor {
  return makeRedactor(env, configuredRpcChainIds(env));
}
