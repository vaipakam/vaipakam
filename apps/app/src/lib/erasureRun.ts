/**
 * The local erasure as ONE operation per tab, owned outside React (#2038).
 *
 * WHY NOT IN THE PAGE. The erasure resets the language first — deliberately,
 * so its own sweep removes what `changeLanguage` persists — and
 * `LanguageRemount` remounts the whole page tree on that event. For anyone
 * not already in English, the Data Rights page that started the erasure is
 * therefore replaced while the erasure is still running: a busy flag held in
 * its state came back `false` in the new instance, so a second erasure could
 * start over the first, and the first one's result was written into an
 * instance that no longer existed, so no report was shown at all. The
 * connection fence already learned this (round 16 P2, `connectionGeneration`)
 * and moved out of the page; the rest of the operation follows it here. The
 * page only starts it and renders what this module reports.
 *
 * A module store read through `useSyncExternalStore`, the same shape as the
 * erase epoch: the page is the only reader, so a context above
 * `LanguageRemount` would wrap the whole app for one route.
 *
 * WHY A REPORT CAN OUTLIVE A RELOAD (#2035). Closing a reload-prone wallet
 * connection reloads the page, and nothing can stop it. That teardown runs
 * last, after everything the erasure counts; just before it, the report as it
 * stands is kept in this tab's `sessionStorage` under `REPORT_KEY`. The
 * teardown returning is NOT proof that no reload is coming (Codex #2670 r1):
 * Coinbase's WalletLink path fires the provider's disconnect without
 * awaiting it and reloads only once its relay connection is destroyed, after
 * the teardown has already resolved. So the kept copy is not removed when
 * the teardown returns; it carries the time it was kept and lives for a
 * bounded window (`KEPT_REPORT_WINDOW_MS`). A load inside the window takes
 * it out and shows it; a load after it, a timer at its end, a dismissal and
 * the next erasure each remove it. This is a write made after an erasure,
 * and it is justified narrowly: it holds counts and outcome flags only —
 * nothing about the wallet, the user or what was erased — it lives only
 * across the window a reload can land in, it is removed on the first read,
 * and `sessionStorage` dies with the tab. The alternative is the outcome the page exists to prevent: a
 * reload that returns the user to a blank page with no word on what
 * happened.
 */
import {
  eraseConnectorStorageQuietly,
  eraseIndexedDbData,
  eraseMyDataFully,
  inspectErasableData,
  connectionGeneration,
  type FullEraseResult,
} from './dataRights';
import { bumpEraseEpoch } from './eraseEpoch';
import { planWalletTeardown, type WalletPort } from './walletTeardown';

export interface ErasureReport extends FullEraseResult {
  /** Erasable items still present when the erasure finished. */
  readonly remaining: number;
  /** Whether that final inspection was refused. */
  readonly refusedAfter: boolean;
  /**
   * The page reloaded while a reload-prone connection was being closed
   * (#2035). The report is the one kept just before that step, so the
   * step's own outcome is NOT in it and must not be claimed either way.
   */
  readonly reloadedDuringLast: boolean;
}

export type ErasureRunState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'done'; readonly report: ErasureReport };

/** Where a report waits out a reload. Under `app.`, so an erasure reaches it. */
export const REPORT_KEY = 'app.dataRights.erasureReport';

/** How long after the reload-prone teardown starts a reload is still
 *  attributed to it. The SDK reloads once a network round trip completes;
 *  a load later than this is the user's own and gets no report. */
export const KEPT_REPORT_WINDOW_MS = 30_000;

const IDLE: ErasureRunState = { phase: 'idle' };
let state: ErasureRunState = takeKeptReport() ?? IDLE;
const listeners = new Set<() => void>();

function setState(next: ErasureRunState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeErasureRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getErasureRun(): ErasureRunState {
  return state;
}

/** Clear a finished report, so a new confirmation starts from nothing. */
export function dismissErasureReport(): void {
  dropKeptReport();
  if (state.phase === 'done') setState(IDLE);
}

export interface ErasureDeps<C> {
  /** The wallet, read at call time — see `chain/walletTeardownPort.ts`. */
  readonly wallet: WalletPort<C>;
  /**
   * Put the language back to the default. Called FIRST, so the sweep
   * removes what it persists.
   */
  readonly resetLanguage: () => void;
  /**
   * Put the live preferences back to their defaults WITHOUT persisting.
   * Called AFTER, because their ordinary setters would write back what the
   * erasure removed.
   */
  readonly resetPreferences: () => void;
}

/**
 * Run the erasure, unless one is already running in this tab — the busy
 * guard lives here, not in the page, so a remount cannot drop it.
 */
export async function runErasure<C>(deps: ErasureDeps<C>): Promise<void> {
  if (state.phase === 'running') return;
  // Language goes back to the default BEFORE the erase, deliberately.
  // `changeLanguage` persists — to the key and the shared-domain cookie — so
  // running it afterwards would rewrite what the erase had just removed.
  deps.resetLanguage();
  setState({ phase: 'running' });

  // The mark every late cleanup compares against, taken at the request so
  // "newer than the request" is measured from when the user asked. Re-taken
  // once a restoring session has settled (see `onSettled`).
  let mark = connectionGeneration.current();
  // "Is there a session the request must not destroy?" — status OR
  // generation, because each catches what the other cannot. The generation
  // misses a connection made and dropped again before the cleanup (nothing to
  // protect, so that is correct); the status misses one a stale teardown's
  // write erased (round 15 P2: `@wagmi/core@2.22.1` publishes `disconnected`
  // over a newer connection when a late teardown settles).
  const hasLiveSession = () =>
    deps.wallet.status() !== 'disconnected' ||
    connectionGeneration.current() !== mark;

  // Opened when the erasure — its counted clear included — has finished. A
  // straggler's cleanup waits on it so it can never empty the stores ahead
  // of the call that counts them (round 12 P2).
  let openGate: () => void = () => {};
  const erasedFully = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const plan = planWalletTeardown(deps.wallet, {
    // A connector the per-target bound gave up on can still complete and
    // write. Its cleanup is queued behind the counted clear, and declines if
    // a session now exists that postdates the request (rounds 12–15): there
    // is no per-record attribution in these stores, and a stale connector
    // key is strictly better than deleting a live session.
    onStragglerSettled: () => {
      void erasedFully.then(() => {
        if (hasLiveSession()) return;
        eraseConnectorStorageQuietly();
        void eraseIndexedDbData();
      });
    },
    // A reconnect that completes while the teardown waits for it installs the
    // session being erased, not one created after the request.
    onSettled: () => {
      mark = connectionGeneration.current();
    },
  });

  const closeLast = plan.last;
  let erased: FullEraseResult;
  try {
    erased = await eraseMyDataFully({
      hasLiveSession,
      disconnect: plan.first,
      disconnectLast: closeLast
        ? (interim) =>
            closeLast(() => keepReport(measure(interim)))
        : undefined,
    });
  } catch (error) {
    // `eraseMyDataFully` reports refusals rather than throwing; reaching here
    // is a defect. The run must not stay "running" forever over it.
    setState(IDLE);
    throw error;
  } finally {
    // The kept copy, if any, is NOT dropped here: the reload can still be
    // on its way (see the header). Its window and its timer remove it.
    openGate();
  }
  setState({ phase: 'done', report: measure(erased) });
  deps.resetPreferences();
  // Everything else that read storage once and kept the value re-reads off
  // this. Deliberately NO page reload: it would throw the report away.
  bumpEraseEpoch();
}

/**
 * Freeze the outcome with what is left, measured now and never recomputed:
 * a report about a past event must not be rewritten by later ones. The
 * ERASURE inventory, not the export one (#1862 round 1 P1), so a connector
 * key that refused removal or was written straight back is still counted.
 */
function measure(result: FullEraseResult): ErasureReport {
  const after = inspectErasableData();
  return {
    ...result,
    remaining: after.count,
    refusedAfter: after.refused,
    reloadedDuringLast: false,
  };
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

let keptExpiry: ReturnType<typeof setTimeout> | undefined;

function keepReport(report: ErasureReport): void {
  try {
    session()?.setItem(REPORT_KEY, JSON.stringify({ keptAt: Date.now(), report }));
  } catch {
    // Storage refused: the report survives only if no reload comes, which
    // is the behaviour before #2035 and nothing worse.
    return;
  }
  // A tab that never reloads must not keep it past the window.
  clearTimeout(keptExpiry);
  keptExpiry = setTimeout(dropKeptReport, KEPT_REPORT_WINDOW_MS);
}

function dropKeptReport(): void {
  clearTimeout(keptExpiry);
  keptExpiry = undefined;
  try {
    session()?.removeItem(REPORT_KEY);
  } catch {
    // Nothing kept, or nothing reachable.
  }
}

/** Take a report kept across a reload, removing it as it is read. */
function takeKeptReport(): ErasureRunState | null {
  const store = session();
  let raw: string | null = null;
  try {
    raw = store?.getItem(REPORT_KEY) ?? null;
    if (raw !== null) store?.removeItem(REPORT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const report = parseKeptReport(raw);
  return report ? { phase: 'done', report } : null;
}

/**
 * Read a kept report back, strictly. Anything malformed is dropped rather
 * than shown: a report the page cannot vouch for is worse than none, and the
 * holding figure on the page still says what is stored now. So is one kept
 * outside the reload window, before or after `now`: a load that late was
 * not caused by the teardown.
 */
export function parseKeptReport(raw: string, now: number = Date.now()): ErasureReport | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  const e = envelope as { keptAt?: unknown; report?: unknown } | null;
  if (
    !e ||
    typeof e.keptAt !== 'number' ||
    !Number.isFinite(e.keptAt) ||
    now < e.keptAt ||
    now - e.keptAt > KEPT_REPORT_WINDOW_MS
  ) {
    return null;
  }
  const v = e.report as Record<string, unknown> | null;
  const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const isBool = (x: unknown) => typeof x === 'boolean';
  const db = v?.indexedDb as Record<string, unknown> | undefined;
  const conn = v?.connector as Record<string, unknown> | undefined;
  if (
    !v ||
    !isNum(v.localStorage) ||
    !isNum(v.sessionStorage) ||
    !isNum(v.cookies) ||
    !isNum(v.total) ||
    !isBool(v.peersNotified) ||
    !isBool(v.complete) ||
    !isNum(v.remaining) ||
    !isBool(v.refusedAfter) ||
    !db ||
    !isNum(db.cleared) ||
    !isNum(db.records) ||
    !Array.isArray(db.refused) ||
    !db.refused.every((name) => typeof name === 'string') ||
    !isBool(db.unavailable) ||
    !conn ||
    !isBool(conn.attempted) ||
    !isBool(conn.disconnected) ||
    !isBool(conn.reconnectPending)
  ) {
    return null;
  }
  return {
    localStorage: v.localStorage as number,
    sessionStorage: v.sessionStorage as number,
    cookies: v.cookies as number,
    total: v.total as number,
    peersNotified: v.peersNotified as boolean,
    indexedDb: {
      cleared: db.cleared as number,
      records: db.records as number,
      refused: db.refused as string[],
      unavailable: db.unavailable as boolean,
    },
    connector: {
      attempted: conn.attempted as boolean,
      disconnected: conn.disconnected as boolean,
      reconnectPending: conn.reconnectPending as boolean,
    },
    complete: v.complete as boolean,
    remaining: v.remaining as number,
    refusedAfter: v.refusedAfter as boolean,
    reloadedDuringLast: true,
  };
}

/** Test seam: forget any state and any kept report. Not for app code. */
export function resetErasureRunForTests(): void {
  dropKeptReport();
  state = takeKeptReport() ?? IDLE;
  listeners.clear();
}

/** Test seam: re-read a kept report, as a fresh module load would. */
export function reloadErasureRunForTests(): void {
  state = takeKeptReport() ?? IDLE;
}
