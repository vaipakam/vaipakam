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
 *  read-diet plan). `hello` says whether this chain is scanned at all. After
 *  that, liveness is the AGE of the indexer's persisted cursor, which every
 *  frame carries, never the arrival of a frame: a scan whose RPC head has
 *  wedged still sends heartbeats, carrying the same old timestamp
 *  (apps/indexer chainIngestDO.ts), so a frame arriving proves nothing. The
 *  rail is live while that timestamp is within `HEARTBEAT_GRACE` scan
 *  cadences of now, and stalled from the moment it is not. */
export type PushState =
  /** This build has no indexer origin: there is no rail to open. */
  | 'off'
  /** Opening the socket, or open and waiting for the indexer's `hello`. */
  | 'connecting'
  /** `hello` said this chain is scanned and its cursor is recent. */
  | 'live'
  /** `hello` said the indexer does not scan this chain: the socket stays
   *  open but nothing will be announced on it, so the app polls. */
  | 'inactive'
  /** The socket is open but the indexer's cursor has not advanced within
   *  the grace period: the scan is not progressing, so the app polls. */
  | 'stalled'
  /** Refused or dropped; reconnecting with backoff while the tab lives. */
  | 'unavailable'
  | 'closed';

/** The cursor is expected to advance once per scan cadence; this many
 *  cadences without it reads as a stall. Two, because a single late scan (a
 *  busy pass, a slow RPC) is ordinary and should not flip the stamp. */
export const HEARTBEAT_GRACE = 2;

/** When (unix seconds) the rail stops counting as live: the cursor's own
 *  timestamp plus the grace. A `hello` with no cursor yet (a chain the scan
 *  has not reached) gives the indexer the grace from now. A timestamp ahead
 *  of this clock earns no extra time: it counts as "now". The cadence comes
 *  from the frame, so an indexer that scans slower moves the line with it. */
export function stallDeadlineSec(cursorUpdatedAt: number | null, scanCadenceSec: number, nowSec: number): number {
  const evidence = cursorUpdatedAt === null ? nowSec : Math.min(cursorUpdatedAt, nowSec);
  return evidence + Math.max(1, scanCadenceSec) * HEARTBEAT_GRACE;
}

/** The deadline a frame sets, or null when it sets none (an inactive chain,
 *  an invalidation). */
export function frameDeadlineSec(frame: PushFrame, nowSec: number): number | null {
  if (frame.t === 'hello') {
    if (!frame.ingestActive || frame.scanCadenceSec === null) return null;
    return stallDeadlineSec(frame.cursor?.updatedAt ?? null, frame.scanCadenceSec, nowSec);
  }
  if (frame.t === 'cursor') return stallDeadlineSec(frame.updatedAt, frame.scanCadenceSec, nowSec);
  return null;
}

/** The state the rail is in after `frame`, given the state before it. Pure,
 *  so the rule is testable without a socket: `hello` decides inactive, or
 *  live or stalled by its cursor's age; a `cursor` frame decides live or
 *  stalled by ITS timestamp's age, the same way (an inactive chain stays
 *  inactive); an `invalidate` changes nothing. */
export function stateAfterFrame(frame: PushFrame, before: PushState, nowSec: number = Date.now() / 1000): PushState {
  if (frame.t === 'hello' && !frame.ingestActive) return 'inactive';
  if (frame.t === 'cursor' && before === 'inactive') return 'inactive';
  const deadline = frameDeadlineSec(frame, nowSec);
  if (deadline === null) return frame.t === 'hello' ? 'live' : before;
  return nowSec > deadline ? 'stalled' : 'live';
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
  /** The clock, in unix milliseconds; `Date.now` by default. */
  nowMs?: () => number;
}

export interface PushRailHandle {
  close(): void;
}

export function openPushRail(opts: PushRailOptions): PushRailHandle {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  const nowSec = () => (opts.nowMs ?? Date.now)() / 1000;
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

  /** Arm (or re-arm) the stall timer at the deadline a frame set: the
   *  cursor's own age decides it, so a frame carrying an old timestamp arms
   *  a timer that is already due, and nothing is armed for an inactive
   *  chain or a rail that is already stalled. */
  const armHeartbeat = (deadlineSec: number | null) => {
    clearHeartbeat();
    if (deadlineSec === null || state !== 'live') return;
    heartbeat = setT(() => {
      heartbeat = null;
      if (!closed && state === 'live') setState('stalled');
    }, Math.max(0, (deadlineSec - nowSec()) * 1000));
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
      const now = nowSec();
      setState(stateAfterFrame(frame, state, now));
      if (frame.t === 'hello' || frame.t === 'cursor') armHeartbeat(frameDeadlineSec(frame, now));
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
