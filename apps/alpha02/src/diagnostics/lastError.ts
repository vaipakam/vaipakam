/**
 * Last-error sink — the lightweight alpha02 stand-in for defi's
 * journey-log buffer (#1028 item 4).
 *
 * One slot, not a ring: the naive-user product needs "what just
 * broke" attached to a support report, not a forensic timeline. The
 * ErrorBoundary writes here on every caught render crash; the
 * DiagnosticsDrawer reads it into the pre-filled GitHub report. The
 * slot lives in sessionStorage so it survives the reload the crash
 * card suggests, and dies with the tab — nothing is persisted.
 *
 * Storage access is best-effort: private windows and locked-down
 * browsers may throw on any storage touch, and a diagnostics helper
 * must never become a crash source itself.
 */

const KEY = 'vaipakam.alpha02.lastError';

export interface LastError {
  message: string;
  /** Trimmed component stack when the ErrorBoundary had one. */
  componentStack?: string;
  /** Route path where it happened. */
  path: string;
  /** Unix ms. */
  at: number;
}

/** In-memory copy so a broken sessionStorage still reports within
 *  the current page lifetime. */
let memory: LastError | null = null;

export function recordLastError(entry: LastError): void {
  memory = entry;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(entry));
  } catch {
    /* storage unavailable — memory copy still serves this page */
  }
}

export function readLastError(): LastError | null {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastError;
    // Validate the WHOLE shape — a stale/corrupt slot (e.g. a
    // non-finite `at` reaching toISOString in the report builder)
    // must read as "no error", never crash the support surface.
    if (
      typeof parsed?.message !== 'string' ||
      typeof parsed?.path !== 'string' ||
      !Number.isFinite(parsed?.at) ||
      (parsed.componentStack !== undefined &&
        typeof parsed.componentStack !== 'string')
    ) {
      return null;
    }
    memory = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLastError(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear if storage is unreachable */
  }
}
