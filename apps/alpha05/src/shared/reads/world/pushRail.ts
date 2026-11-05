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

/** The rail's state is DERIVED from what the indexer says over the socket,
 *  never from the socket alone: an open socket proves a connection, not that
 *  anything will ever be announced on it (design §4.1.1 of the indexer's
 *  read-diet plan). `hello` says whether this chain is scanned at all, and
 *  the `cursor` heartbeat that follows every successful scan says the scan
 *  loop is alive; a heartbeat overdue by `HEARTBEAT_GRACE` cadences while
 *  the socket stays open is a stalled rail, and the stamp says so. */
export type PushState =
  /** This build has no indexer origin: there is no rail to open. */
  | 'off'
  /** Opening the socket, or open and waiting for the indexer's `hello`. */
  | 'connecting'
  /** `hello` said this chain is scanned and a heartbeat is not overdue. */
  | 'live'
  /** `hello` said the indexer does not scan this chain: the socket stays
   *  open but nothing will be announced on it, so the app polls. */
  | 'inactive'
  /** The socket is open but no heartbeat arrived within the grace period:
   *  the scan loop is not reporting, so the app polls. */
  | 'stalled'
  /** Refused or dropped; reconnecting with backoff while the tab lives. */
  | 'unavailable'
  | 'closed';

/** Heartbeats are expected once per scan cadence; this many cadences
 *  without one reads as a stall. Two, because a single late scan (a busy
 *  pass, a slow RPC) is ordinary and should not flip the stamp. */
export const HEARTBEAT_GRACE = 2;

/** How long after a heartbeat (or `hello`) the next one may take before the
 *  rail reads as stalled. The cadence comes from the frame itself, so an
 *  indexer that scans slower or faster moves the deadline with it. */
export function heartbeatDeadlineMs(scanCadenceSec: number): number {
  return Math.max(1, scanCadenceSec) * HEARTBEAT_GRACE * 1000;
}

/** The state the rail is in after `frame`, given the state before it. Pure,
 *  so the rule is testable without a socket: `hello` decides between live
 *  and inactive; a `cursor` heartbeat makes a live-or-stalled rail live
 *  again; an `invalidate` changes nothing (its scan's heartbeat follows it
 *  when the scan's cursor could be read, and its absence is the signal). */
export function stateAfterFrame(frame: PushFrame, before: PushState, nowSec: number = Date.now() / 1000): PushState {
  if (frame.t === 'hello') {
    if (!frame.ingestActive) return 'inactive';
    // A cursor already older than the grace period at connect time is a
    // stall the socket's openness cannot contradict (design §4.1.1).
    const cadence = frame.scanCadenceSec ?? 0;
    if (frame.cursor && cadence > 0 && nowSec - frame.cursor.updatedAt > cadence * HEARTBEAT_GRACE) return 'stalled';
    return 'live';
  }
  if (frame.t === 'cursor') return before === 'inactive' ? 'inactive' : 'live';
  return before;
}

/** The socket URL for a chain's push rail, from the indexer's HTTP origin. */
export function pushRailUrl(indexerOrigin: string | null, chainId: number): string | null {
  if (indexerOrigin === null) return null;
  const url = new URL(indexerOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/chain/${chainId}`;
  return url.toString();
}

/** Which of the app's reads a frame invalidates. World reads refetch on
 *  every invalidate. Own reads refetch unless the hints PROVE the account
 *  unaffected: a hint may only narrow the work when it is complete (not
 *  truncated) AND every affected id carries a link naming its parties, none
 *  of them this account. An id with no link (a repayment, a default, a
 *  periodic settlement: the indexer links only creations) names no party,
 *  so it could be one of this account's positions, and the own reads
 *  refetch (the coarse key). Degraded is never wrong; skipping a refetch
 *  of a position that just changed would be. */
export function invalidationsFor(frame: PushFrame, account: `0x${string}` | null): { world: boolean; own: boolean } {
  if (frame.t !== 'invalidate' || frame.keys.length === 0) return { world: false, own: false };
  if (account === null) return { world: true, own: false };
  const hints = frame.hints;
  if (!hints || hints.truncated) return { world: true, own: true };
  const unlinked =
    hints.loanIds.some((id) => !hints.links.some((l) => l.loanId === id)) ||
    hints.offerIds.some((id) => !hints.links.some((l) => l.offerId === id));
  if (unlinked) return { world: true, own: true };
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
  let heartbeat: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;
  // `closed` until `connect` runs, so the first `connecting` is announced.
  let state: PushState = 'closed';

  const setState = (next: PushState) => {
    if (state === next) return;
    state = next;
    opts.onState(next);
  };

  const clearHeartbeat = () => {
    if (heartbeat !== null) clearT(heartbeat);
    heartbeat = null;
  };

  /** Arm (or re-arm) the stall deadline from a frame that carries the scan
   *  cadence. A `hello` for an inactive chain carries none, and arms nothing:
   *  no heartbeat is expected there. */
  const armHeartbeat = (scanCadenceSec: number | null) => {
    clearHeartbeat();
    if (scanCadenceSec === null || state !== 'live') return;
    heartbeat = setT(() => {
      heartbeat = null;
      if (!closed && state === 'live') setState('stalled');
    }, heartbeatDeadlineMs(scanCadenceSec));
  };

  const connect = () => {
    if (closed) return;
    setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(opts.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      // Open proves a connection, not a live rail: the state stays
      // `connecting` until the indexer's `hello` says what this socket carries.
      attempt = 0;
    };
    ws.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (!frame) return;
      setState(stateAfterFrame(frame, state));
      if (frame.t === 'hello' || frame.t === 'cursor') armHeartbeat(frame.scanCadenceSec);
      opts.onFrame(frame);
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
    clearHeartbeat();
    setState('unavailable');
    const delay = reconnectDelayMs(attempt++);
    timer = setT(connect, delay);
  };

  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearT(timer);
      clearHeartbeat();
      const ws = socket;
      socket = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      setState('closed');
    },
  };
}
