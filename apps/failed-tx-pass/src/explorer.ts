/**
 * The network explorer's list of transactions sent to a contract (#3919,
 * TroubleshootingPictureDesign.md §4.3, "list and audit").
 *
 * An outside source of WHERE TO LOOK, never of what is stored: the pass keeps
 * only the hashes it marks as failed, and reads the receipt and the
 * explanation from the network's own node. The API is the common
 * `account/txlist` shape (Etherscan v2: one key for every network, chosen by
 * `chainid`). The key is never logged; a failure is described by the
 * explorer's status message, with anything shaped like a URL removed.
 */
import { cleanMessage } from './rpc';

export class ExplorerFailure extends Error {
  constructor(
    /**
     * transient: a wait. unreadable: the explorer will not serve this list at
     * all (a bad key, a network or tier the plan does not cover). refused:
     * one range it cannot answer (more rows in one block than it pages).
     */
    readonly kind: 'transient' | 'unreadable' | 'refused',
    message: string,
  ) {
    super(message);
    this.name = 'ExplorerFailure';
  }
}

export interface FoundTx {
  hash: string;
  blockNumber: number;
}

export interface Explorer {
  /** Failed transactions sent to `address` in [fromBlock, toBlock], oldest first. */
  failedSentTo(address: string, fromBlock: number, toBlock: number): Promise<FoundTx[]>;
}

/** The explorer answers at most this many rows for one query (pages x page size). */
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

export function txlistExplorer(opts: { apiBase: string; apiKey: string; chainId: number; fetch?: typeof fetch; timeoutMs?: number }): Explorer {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const page = async (address: string, from: number, to: number, n: number) => {
    const u = new URL(opts.apiBase);
    u.searchParams.set('chainid', String(opts.chainId));
    u.searchParams.set('module', 'account');
    u.searchParams.set('action', 'txlist');
    u.searchParams.set('address', address);
    u.searchParams.set('startblock', String(from));
    u.searchParams.set('endblock', String(to));
    u.searchParams.set('page', String(n));
    u.searchParams.set('offset', String(PAGE_SIZE));
    u.searchParams.set('sort', 'asc');
    u.searchParams.set('apikey', opts.apiKey);
    let res: Response;
    try {
      res = await f(u.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ExplorerFailure('transient', `the explorer did not answer (${e instanceof Error ? e.name : 'error'})`);
    }
    if (res.status === 429 || res.status >= 500) throw new ExplorerFailure('transient', `explorer HTTP ${res.status}`);
    let body: { status?: string; message?: string; result?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ExplorerFailure('transient', `explorer HTTP ${res.status}, not JSON`);
    }
    if (body.status === '1' && Array.isArray(body.result)) return body.result as Array<Record<string, string>>;
    if (body.status === '0' && /no transactions found/i.test(String(body.message)) && Array.isArray(body.result)) return [];
    const why = cleanMessage(typeof body.result === 'string' ? `${body.message}: ${body.result}` : body.message);
    // A rate limit is a wait; anything else (a bad key, a network or tier the
    // plan does not cover) means the list cannot be read on this network.
    throw new ExplorerFailure(/rate limit|max calls|too many/i.test(why) ? 'transient' : 'unreadable', `explorer: ${why}`);
  };

  const range = async (address: string, from: number, to: number): Promise<FoundTx[]> => {
    const out: FoundTx[] = [];
    for (let n = 1; n <= MAX_PAGES; n++) {
      const rows = await page(address, from, to, n);
      for (const r of rows) {
        if (r.isError === '1' || r.txreceipt_status === '0') out.push({ hash: String(r.hash).toLowerCase(), blockNumber: Number(r.blockNumber) });
      }
      if (rows.length < PAGE_SIZE) return out;
    }
    // More rows than the explorer will page through: split the range.
    if (from === to) throw new ExplorerFailure('refused', `explorer: more than ${PAGE_SIZE * MAX_PAGES} transactions in block ${from}`);
    const mid = Math.floor((from + to) / 2);
    return [...(await range(address, from, mid)), ...(await range(address, mid + 1, to))];
  };

  return {
    async failedSentTo(address, fromBlock, toBlock) {
      if (toBlock < fromBlock) return [];
      const rows = await range(address.toLowerCase(), fromBlock, toBlock);
      const seen = new Set<string>();
      return rows.filter((r) => (seen.has(r.hash) ? false : (seen.add(r.hash), true)));
    },
  };
}
