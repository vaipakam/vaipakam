/**
 * The pass's only way to the database (#3919): the indexer's
 * `/internal/failed-tx` route and its state read, under the writer token.
 * The pass has no database binding; everything it remembers between runs is
 * what it wrote here.
 */

export interface PassState {
  cursor: {
    mode: string;
    blockNumber: number;
    blockTime: number;
    watchedShareBps: number | null;
    slowBlockNumber: number | null;
    listFromBlock: number | null;
    auditPlan: { day: string; fromBlock: number; toBlock: number } | null;
  } | null;
  checkpoints: Array<{ blockNumber: number; blockHash: string }>;
  auditedTo: number | null;
  recorded: string[] | null;
  /** The same, less the audit's own finds: what the other sources covered. */
  recordedByOthers: string[] | null;
}

export interface IndexerClient {
  state(chainId: number, diamond: string, span?: { from: number; to: number }): Promise<PassState>;
  write(body: unknown): Promise<void>;
}

export class IndexerFailure extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'IndexerFailure';
  }
}

export function indexerClient(opts: { origin: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): IndexerClient {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const headers = { authorization: `Bearer ${opts.token}` };
  const send = async (path: string, init: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await f(new URL(path, opts.origin).toString(), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new IndexerFailure(null, `the indexer did not answer (${e instanceof Error ? e.name : 'error'})`);
    }
    const text = await res.text();
    if (!res.ok) {
      let why = text.slice(0, 300);
      try {
        why = String((JSON.parse(text) as { error?: unknown }).error ?? why);
      } catch {
        /* not JSON */
      }
      throw new IndexerFailure(res.status, `indexer ${init.method ?? 'GET'} ${path}: HTTP ${res.status}: ${why}`);
    }
    return text ? JSON.parse(text) : null;
  };
  return {
    async state(chainId, diamond, span) {
      const q = new URLSearchParams({ chainId: String(chainId), diamond });
      if (span) {
        q.set('from', String(span.from));
        q.set('to', String(span.to));
      }
      return (await send(`/internal/failed-tx/state?${q}`, { method: 'GET', headers })) as PassState;
    },
    async write(body) {
      await send('/internal/failed-tx', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
  };
}
