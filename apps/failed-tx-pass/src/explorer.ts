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
    /** The explorer refused for its rate limit (retried within the run before it holds). */
    readonly rateLimited = false,
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

/**
 * Etherscan v2 allows a key a few calls a second across EVERY network it
 * serves, and the pass runs its networks concurrently under one key. So
 * requests are paced per key, not per network: each waits its turn behind the
 * previous request made with the same key, at least this far apart.
 */
export const MIN_REQUEST_GAP_MS = 400;
/** A rate-limited request is retried within the run this many times, waiting longer each time. */
export const RATE_LIMIT_RETRIES = 4;
const RETRY_BASE_MS = 1_000;

export interface Pacer {
  /** Resolves when the caller may send its next request with `key`. */
  turn(key: string): Promise<void>;
}

export function keyPacer(gapMs: number, sleep: (ms: number) => Promise<void>, clock: () => number = Date.now): Pacer {
  const next = new Map<string, Promise<number>>();
  return {
    turn(key) {
      // Chain each request behind the previous one for the same key, so
      // concurrent callers are served one at a time, gapMs apart.
      const prev = next.get(key) ?? Promise.resolve(0);
      const mine = prev.then(async (lastAt) => {
        const wait = lastAt + gapMs - clock();
        if (wait > 0) await sleep(wait);
        return clock();
      });
      next.set(key, mine);
      return mine.then(() => undefined);
    },
  };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** One pacer for the process: every explorer built here shares it, whatever its network. */
const sharedPacer = keyPacer(MIN_REQUEST_GAP_MS, realSleep);

export function txlistExplorer(opts: {
  apiBase: string;
  apiKey: string;
  chainId: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pacer?: Pacer;
  sleep?: (ms: number) => Promise<void>;
}): Explorer {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pacer = opts.pacer ?? sharedPacer;
  const sleep = opts.sleep ?? realSleep;

  // A rate limit is retried here, with growing waits, before it reaches the
  // run as a hold: a refusal caused by the pass's own concurrency must not
  // stop a network's progress. Other failures go straight through.
  const page = async (address: string, from: number, to: number, n: number) => {
    for (let attempt = 0; ; attempt++) {
      await pacer.turn(opts.apiKey);
      try {
        return await pageOnce(address, from, to, n);
      } catch (e) {
        if (!(e instanceof ExplorerFailure) || !e.rateLimited || attempt >= RATE_LIMIT_RETRIES) throw e;
        await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  };

  const pageOnce = async (address: string, from: number, to: number, n: number) => {
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
    if (res.status === 429) throw new ExplorerFailure('transient', `explorer HTTP 429`, true);
    if (res.status >= 500) throw new ExplorerFailure('transient', `explorer HTTP ${res.status}`);
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
    const limited = /rate limit|max calls|too many/i.test(why);
    throw new ExplorerFailure(limited ? 'transient' : 'unreadable', `explorer: ${why}`, limited);
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
