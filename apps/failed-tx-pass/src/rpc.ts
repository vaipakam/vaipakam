/**
 * A JSON-RPC client over fetch, for the failed transaction pass (#3919).
 *
 * Every failure is described without the request: node endpoints carry API
 * keys, so neither the URL nor a message that could echo it is ever kept.
 * Failures come in two kinds, because the pass acts differently on each:
 *
 *   transient  the node did not answer (network, timeout, rate limit, 5xx).
 *              The pass holds and tries again on its next run.
 *   refused    the node answered with an error. A method it does not offer,
 *              or a block whose state it no longer holds, moves the pass to
 *              the next source; a refused range becomes a recorded gap.
 */

export type RpcFailureKind = 'transient' | 'refused';

export class RpcFailure extends Error {
  constructor(
    readonly kind: RpcFailureKind,
    readonly code: number | null,
    message: string,
    /** Revert data a refused `eth_call` carried. */
    readonly data?: string,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

const MAX_MESSAGE = 200;
/** A node's message, with anything shaped like a URL removed and its length bounded. */
export function cleanMessage(m: unknown): string {
  const s = typeof m === 'string' ? m : 'no message';
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, MAX_MESSAGE);
}

/** A node error that means the state of that block is gone (pruned, beyond reach). */
export function stateGone(e: unknown): boolean {
  return (
    e instanceof RpcFailure &&
    e.kind === 'refused' &&
    /missing trie node|header not found|required historical state|historical state .*not available|state .*(not available|unavailable|pruned)|block .*not found|unknown block|beyond (the )?(current )?(state )?(history|reach)/i.test(e.message)
  );
}

export function jsonRpc(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Rpc {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      let res: Response;
      try {
        res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new RpcFailure('transient', null, `${method}: the node did not answer (${e instanceof Error ? e.name : 'error'})`);
      }
      if (res.status === 429 || res.status >= 500) throw new RpcFailure('transient', res.status, `${method}: HTTP ${res.status}`);
      let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new RpcFailure(res.ok ? 'transient' : 'refused', res.status, `${method}: HTTP ${res.status}, not JSON`);
      }
      if (body.error) {
        const code = typeof body.error.code === 'number' ? body.error.code : null;
        // Rate limits and "try again" answers from providers are not refusals.
        const msg = cleanMessage(body.error.message);
        if (code === -32005 || code === 429 || /rate limit|too many requests|temporar|try again|timeout/i.test(msg)) {
          throw new RpcFailure('transient', code, `${method}: ${msg}`);
        }
        const data = typeof body.error.data === 'string' && /^0x[0-9a-f]*$/i.test(body.error.data) ? body.error.data : undefined;
        throw new RpcFailure('refused', code, `${method}: ${msg}`, data);
      }
      if (!res.ok) throw new RpcFailure('refused', res.status, `${method}: HTTP ${res.status}`);
      return body.result as T;
    },
  };
}

export const hex = (n: number | bigint): string => `0x${n.toString(16)}`;
export const num = (h: string | null | undefined): number => (h ? Number.parseInt(h, 16) : 0);
