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
 * bounded window (`RELOAD_WINDOW_MS`). A load inside the window takes
 * it out and shows it; a load after it, a timer at its end, a dismissal and
 * the next erasure each remove it. It is outside the erasure set (see
 * `ERASURE_REPORT_KEY`), so it is never counted as something an erasure
 * left behind, and nothing but this module removes it.
 *
 * ONE LOCK FOR BOTH WAYS INTO AN ERASURE (Codex #2670 r2 P1). This tab's
 * own run and its follow-up of ANOTHER tab's erasure both close this tab's
 * wallet, and a reload-prone wallet reloads the tab as it closes. Run side
 * by side, the follow-up could reach that reload while the run was still
 * clearing — before it had kept a report — which is the interrupted,
 * unreported erasure the ordering exists to prevent. So both live here, as
 * one queue: a broadcast that arrives while this tab's own run is going is
 * carried out AFTER that run, and a run requested while a follow-up is still
 * closing the wallet waits for it before touching anything. A broadcast is
 * never dropped (Codex #2670 r5): the run's plan was fixed at its own request
 * and its sweep may already have passed, so a wallet connected or data
 * written since is the later request's to remove — against the connections
 * this tab held when THAT request arrived.
 *
 * ONE RELOAD BARRIER, WHOEVER ASKED (Codex #2670 r3–r4). The teardown
 * resolving is not the moment a reload stops being possible, for the reason
 * above — so after ANY reload-prone close this tab asks for, whether its own
 * run asked or a follow-up did, the tab owes a possible reload for
 * `RELOAD_WINDOW_MS`, and no queued operation — a run, or a follow-up
 * waiting its turn — starts its work until that has passed (`awaitTurn`). The
 * barrier is a property of the tab, not of a path: the first revision
 * guarded the follow-up path alone, a second run started inside its own
 * predecessor's window was exposed the same way, and then a follow-up queued
 * behind another follow-up (Codex #2670 r6). A run waiting on it shows
 * as running and has done nothing yet — not even dropped the previous run's
 * kept report — so a reload in the wait interrupts nothing and shows the
 * report of the run that caused it.
 *
 * A KEPT REPORT IS SHOWN ONLY ON A RELOAD (Codex #2670 r4). `sessionStorage`
 * is copied into a tab opened from this one, so the key alone cannot say
 * the load in front of it is the reload the report is waiting for. The
 * browser's navigation type can: a load that is not a reload discards the
 * copy unread. This is a write made after an erasure,
 * and it is justified narrowly: it holds counts and outcome flags only —
 * nothing about the wallet, the user or what was erased — it lives only
 * across the window a reload can land in, it is removed on the first read,
 * and `sessionStorage` dies with the tab. The alternative is the outcome the page exists to prevent: a
 * reload that returns the user to a blank page with no word on what
 * happened.
 */
import {
  ERASURE_REPORT_KEY,
  eraseConnectorStorageQuietly,
  eraseIndexedDbData,
  eraseMyDataFully,
  erasePerTabData,
  inspectErasableData,
  connectionGeneration,
  type FullEraseResult,
} from './dataRights';
import { bumpEraseEpoch } from './eraseEpoch';
import {
  planWalletTeardown,
  type WalletPort,
  type WalletTeardownPlan,
} from './walletTeardown';

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

/** Where a report waits out a reload — owned by this module, outside the
 *  erasure set (see `ERASURE_REPORT_KEY`). */
export const REPORT_KEY = ERASURE_REPORT_KEY;

/** How long after a reload-prone teardown a reload is still attributed to
 *  it. The SDK reloads once a network round trip completes, after the
 *  teardown has resolved. Two things are bounded by it: a kept report lives
 *  this long (a load later than this is the user's own and gets none), and
 *  no run starts its work until this long after the tab last asked for such
 *  a close, so the reload cannot land inside it (see the header). */
export const RELOAD_WINDOW_MS = 30_000;

const IDLE: ErasureRunState = { phase: 'idle' };
let state: ErasureRunState = takeKeptReport(loadWasReload()) ?? IDLE;
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

/** This tab's own run while it is going, settled either way — what a
 *  follow-up heard meanwhile waits for. */
let currentRun: Promise<void> | undefined;

/**
 * Run the erasure, unless one is already running in this tab — the busy
 * guard lives here, not in the page, so a remount cannot drop it.
 */
export function runErasure<C>(deps: ErasureDeps<C>): Promise<void> {
  if (state.phase === 'running') return Promise.resolve();
  const run = performErasure(deps);
  const settled: Promise<void> = run
    .catch(() => {})
    .finally(() => {
      if (currentRun === settled) currentRun = undefined;
    });
  currentRun = settled;
  return run;
}

async function performErasure<C>(deps: ErasureDeps<C>): Promise<void> {
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
  // The plan has fixed the request's connections (see `planWalletTeardown`),
  // so a wallet connected during the waits below is not the request's.

  // A follow-up of another tab's erasure may still be closing this tab's
  // wallet, and a reload this tab owes may still be on its way (see the
  // header). Nothing of this run has happened yet, so a reload landing in
  // either wait interrupts nothing and claims nothing.
  await awaitTurn([peerFollowUp]);
  // A previous run's kept copy describes that run, not this one — dropped
  // only now, so a reload during the waits still shows it.
  dropKeptReport();
  // Language goes back to the default BEFORE the erase, deliberately.
  // `changeLanguage` persists — to the key and the shared-domain cookie — so
  // running it afterwards would rewrite what the erase had just removed.
  deps.resetLanguage();

  const closeLast = plan.last;
  // The report kept just before a reload-prone close, if one was asked for.
  let kept: ErasureReport | undefined;
  let erased: FullEraseResult;
  try {
    erased = await eraseMyDataFully({
      hasLiveSession,
      disconnect: plan.first,
      disconnectLast: closeLast
        ? (interim) =>
            closeLast(() => {
              kept = measure(interim);
              keepReport(kept);
              owePossibleReload();
            })
        : undefined,
    });
  } catch (error) {
    // `eraseMyDataFully` reports refusals rather than throwing; reaching here
    // is a defect. The run must not stay "running" forever over it.
    setState(IDLE);
    throw error;
  } finally {
    // The kept copy, if any, is NOT dropped here: the reload can still be
    // on its way (see the header). It is RENEWED instead, with the barrier:
    // the reload follows the close, so its window runs from when the close
    // came back, however long that took — not from when it was asked for.
    if (kept) {
      keepReport(kept);
      owePossibleReload();
    }
    openGate();
  }
  setState({ phase: 'done', report: measure(erased) });
  deps.resetPreferences();
  // Everything else that read storage once and kept the value re-reads off
  // this. Deliberately NO page reload: it would throw the report away.
  bumpEraseEpoch();
}

export interface PeerErasureDeps<C> {
  /** The wallet, read at call time — see `chain/walletTeardownPort.ts`. */
  readonly wallet: WalletPort<C>;
  /**
   * Bring the live theme and mode into line with storage WITHOUT writing:
   * the default when nothing is stored, a choice made since the erasure
   * when one is.
   */
  readonly followPreferences: () => void;
  /** The same for the language, undoing exactly what its reset persists. */
  readonly followLanguage: () => void;
}

/** This tab's follow-ups of other tabs' erasures, while any is closing the
 *  wallet. Chained, so two broadcasts never close it side by side. */
let peerFollowUp: Promise<void> | undefined;

/**
 * Bring this tab into line after ANOTHER tab erased (#1960, #2037): its
 * per-tab data, its live preferences, its readers, and its own wallet
 * connections — and nothing shared, which the originating tab has cleared
 * and is the only party to report on.
 *
 * In the same queue as `runErasure` (see the header): heard while this tab's
 * own run is going, it is carried out once that run has finished.
 */
export function followPeerErasure<C>(deps: PeerErasureDeps<C>): void {
  // This tab's own connections are PLANNED NOW, so the ones it closes are
  // those this tab held when the request arrived (Codex #2670 r4) — only the
  // work waits its turn, and a wallet connected in that wait is left alone.
  const plan = planWalletTeardown(deps.wallet);
  const followUp = () => {
    erasePerTabData();
    deps.followPreferences();
    deps.followLanguage();
    // ...and tell this tab's mounted readers to re-read, exactly as the
    // erasing tab does for its own.
    bumpEraseEpoch();
  };
  // Behind this tab's own run, when one is going: its sweep and counts are
  // under way, and a per-tab sweep run beside them would make its report
  // understate what it removed — the same race #2037 took out of the
  // shared stores.
  const run = currentRun;
  if (!run) followUp();
  // The connections LAST: a reload-prone one reloads this tab (#2035), which
  // is harmless once everything above has run. Best effort and
  // unacknowledged: there is nobody to report to, which is why the
  // originating page says other tabs were ASKED.
  const next = awaitTurn([run, peerFollowUp]).then(() => {
    if (run) followUp();
    return closeConnections(plan);
  });
  peerFollowUp = next;
  void next.finally(() => {
    if (peerFollowUp === next) peerFollowUp = undefined;
  });
}

async function closeConnections(plan: WalletTeardownPlan): Promise<void> {
  let askedReloadProne = false;
  const teardowns = [
    plan.first,
    plan.last &&
      (() =>
        plan.last!(() => {
          askedReloadProne = true;
          owePossibleReload();
        })),
  ];
  for (const teardown of teardowns) {
    try {
      await teardown?.();
    } catch {
      // A wallet that refuses, or is still restoring, must not stop the
      // other teardown being tried.
    }
  }
  // Renewed once the close has come back, as in `runErasure`.
  if (askedReloadProne) owePossibleReload();
}

/** Resolves once no reload this tab owes can still come (see the header). */
let reloadQuiet: Promise<void> = Promise.resolve();

/**
 * Record that this tab owes a possible reload — called as a reload-prone
 * close is ASKED for, whatever it answers, because the asking is what
 * schedules the reload, and again once that close has come back, because
 * the reload follows it. Each call restarts the window.
 */
function owePossibleReload(): void {
  reloadQuiet = new Promise((resolve) => setTimeout(resolve, RELOAD_WINDOW_MS));
}

/**
 * Where every queued operation of this tab's erasure queue starts — its own
 * run and each follow-up of another tab's: once the operations ahead of it
 * have finished, AND once no reload this tab owes can still come (Codex #2670
 * r6). One rule for both, so no operation is begun under a reload a previous
 * one scheduled, whichever kind either is.
 */
async function awaitTurn(
  ahead: readonly (Promise<void> | undefined)[],
): Promise<void> {
  await Promise.all(ahead);
  await untilReloadQuiet();
}

async function untilReloadQuiet(): Promise<void> {
  // Re-checked after each wait: a close asked for meanwhile extends it.
  let current: Promise<void>;
  do {
    current = reloadQuiet;
    await current;
  } while (current !== reloadQuiet);
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
  keptExpiry = setTimeout(dropKeptReport, RELOAD_WINDOW_MS);
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

/**
 * Whether the load in front of us is a RELOAD of this page — the only load
 * a kept report may be shown on (see the header). Unknown reads as no: a
 * report withheld is a lost report, a report shown in a tab that never ran
 * the erasure is a false one.
 */
function loadWasReload(): boolean {
  try {
    const [entry] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    if (entry) return entry.type === 'reload';
    // The older interface, where the newer is missing: type 1 is a reload.
    return (
      (performance as { navigation?: { type?: number } }).navigation?.type === 1
    );
  } catch {
    return false;
  }
}

/** Take a report kept across a reload, removing it as it is read — on any
 *  load, so a copy inherited by a tab that did not reload is not left
 *  behind either. */
function takeKeptReport(reloaded: boolean): ErasureRunState | null {
  const store = session();
  let raw: string | null = null;
  try {
    raw = store?.getItem(REPORT_KEY) ?? null;
    if (raw !== null) store?.removeItem(REPORT_KEY);
  } catch {
    return null;
  }
  if (raw === null || !reloaded) return null;
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
    now - e.keptAt > RELOAD_WINDOW_MS
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
  peerFollowUp = undefined;
  currentRun = undefined;
  reloadQuiet = Promise.resolve();
  state = IDLE;
  listeners.clear();
}

/** Test seam: re-read a kept report, as a fresh module load would — by
 *  default a reload; `'navigate'` stands for any other load, such as a tab
 *  opened from this one that inherited its `sessionStorage`. */
export function reloadErasureRunForTests(
  load: 'reload' | 'navigate' = 'reload',
): void {
  state = takeKeptReport(load === 'reload') ?? IDLE;
}
