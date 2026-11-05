/**
 * The push rail (RB-RAILS): the indexer announces changes over a WebSocket
 * per chain (`GET /ws/chain/:chainId`), and reports its own freshness in
 * every frame, so a quiet rail is told from a stalled one. The app treats
 * the rail as degradable by construction: when it is refused (503 while
 * push is off, 403 for an unlisted origin, 429 over budget) or drops, the
 * polled reads carry on and the stamp says push is unavailable.
 *
 * Frames (apps/indexer/src/chainIngestDO.ts): `hello` at connect,
 * `invalidate` after a scan that changed rows (coarse keys, with bounded
 * affected-id hints that are TRUNCATION-HONEST), `cursor` after every scan.
 * Unknown `t` values are ignored, so the indexer can add frame kinds.
 */

export type InvalidationKey =
  | 'offer.created'
  | 'offer.changed'
  | 'loan.created'
  | 'loan.updated'
  | 'ownership.changed'
  | 'notification.created'
  | 'activity.appended';

export interface PushHintLink {
  loanId?: number;
  offerId?: number;
  lender?: string;
  borrower?: string;
  creator?: string;
  newLender?: string;
  newBorrower?: string;
}

export interface PushHints {
  loanIds: number[];
  offerIds: number[];
  links: PushHintLink[];
  truncated: boolean;
}

export type PushFrame =
  | {
      t: 'hello';
      chainId: number | null;
      ingestActive: boolean;
      cursor: { lastBlock: number; updatedAt: number } | null;
      scanCadenceSec: number | null;
    }
  | { t: 'invalidate'; chainId: number; keys: InvalidationKey[]; scannedTo: string; hints?: PushHints }
  | { t: 'cursor'; chainId: number; lastBlock: string; updatedAt: number; scanCadenceSec: number };

export type PushState =
  /** This build has no indexer origin: there is no rail to open. */
  | 'off'
  | 'connecting'
  | 'live'
  /** Refused or dropped; reconnecting with backoff while the tab lives. */
  | 'unavailable'
  | 'closed';

/** The socket URL for a chain's push rail, from the indexer's HTTP origin. */
export function pushRailUrl(indexerOrigin: string | null, chainId: number): string | null {
  if (indexerOrigin === null) return null;
  const url = new URL(indexerOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/chain/${chainId}`;
  return url.toString();
}

/** Which of the app's reads a frame invalidates. World reads refetch on
 *  every invalidate; own reads refetch when the hints name the account, and
 *  ALWAYS when the hints are absent or truncated (the coarse key): a hint
 *  may only narrow the work when it is complete. */
export function invalidationsFor(frame: PushFrame, account: `0x${string}` | null): { world: boolean; own: boolean } {
  if (frame.t !== 'invalidate' || frame.keys.length === 0) return { world: false, own: false };
  if (account === null) return { world: true, own: false };
  const hints = frame.hints;
  if (!hints || hints.truncated) return { world: true, own: true };
  const me = account.toLowerCase();
  const named = hints.links.some((l) =>
    [l.lender, l.borrower, l.creator, l.newLender, l.newBorrower].some((p) => typeof p === 'string' && p.toLowerCase() === me),
  );
  return { world: true, own: named };
}

export function parseFrame(raw: unknown): PushFrame | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const t = (parsed as { t?: unknown }).t;
  if (t === 'hello' || t === 'invalidate' || t === 'cursor') return parsed as PushFrame;
  return null;
}

/** Reconnect delay after `attempt` consecutive failures: 1 s doubling to a
 *  minute. The rail never gives up while the tab lives, because push being
 *  off is a deployment posture that can change under an open tab. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

export interface PushRailOptions {
  url: string;
  onFrame: (frame: PushFrame) => void;
  onState: (state: PushState) => void;
  /** The WebSocket constructor; the browser's by default, a fake in tests. */
  WebSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface PushRailHandle {
  close(): void;
}

export function openPushRail(opts: PushRailOptions): PushRailHandle {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const connect = () => {
    if (closed) return;
    opts.onState('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(opts.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      opts.onState('live');
    };
    ws.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (frame) opts.onFrame(frame);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      /* the close event that follows carries the retry */
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    opts.onState('unavailable');
    const delay = reconnectDelayMs(attempt++);
    timer = setT(connect, delay);
  };

  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearT(timer);
      const ws = socket;
      socket = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      opts.onState('closed');
    },
  };
}
