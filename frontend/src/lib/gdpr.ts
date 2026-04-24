/**
 * GDPR / CCPA data-subject-rights helpers (Phase 4.4).
 *
 * Vaipakam's frontend collects three kinds of client-side data, all
 * keyed under the `vaipakam` namespace:
 *
 *   - Journey-log telemetry in `sessionStorage` under
 *     `vaipakam.journey`.
 *   - Consent-banner choice in `localStorage` under
 *     `vaipakam:consent:v1`.
 *   - Event-index cache in `localStorage` under
 *     `vaipakam:logIndex:<chainId>:<diamond>` — not wallet-keyed, but
 *     cleared here too so "delete my data" is complete from the
 *     user's perspective.
 *
 * These helpers scan both storages for any key starting with
 * `vaipakam` and either export the full set as JSON (the
 * "right to portability" deliverable) or delete them (the "right to
 * erasure" deliverable). On-chain data is NOT touched — Vaipakam
 * has no power to erase blockchain state.
 */

interface GdprExport {
  /** ISO timestamp of when the export was generated. */
  exportedAt: string;
  /** User agent string at export time — helps the user identify
   *  which browser / device produced the export. */
  userAgent: string;
  /** Session-storage keys under the `vaipakam` namespace. */
  sessionStorage: Record<string, unknown>;
  /** Local-storage keys under the `vaipakam` namespace. */
  localStorage: Record<string, unknown>;
  /** Explanatory note embedded in the export so a user (or a
   *  regulator) reading it later has the context without needing
   *  a separate document. */
  note: string;
}

const NAMESPACE_PREFIX = 'vaipakam';

/** True if `key` belongs to Vaipakam's storage namespace. */
function isVaipakamKey(key: string | null): boolean {
  if (!key) return false;
  return key === NAMESPACE_PREFIX || key.startsWith(`${NAMESPACE_PREFIX}.`) || key.startsWith(`${NAMESPACE_PREFIX}:`);
}

function collectStorage(storage: Storage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!isVaipakamKey(key)) continue;
    const raw = storage.getItem(key!);
    if (raw === null) continue;
    try {
      // Most Vaipakam storage values are JSON-serialised. Parse when we
      // can so the export is human-readable; fall back to the raw
      // string when parsing fails.
      out[key!] = JSON.parse(raw);
    } catch {
      out[key!] = raw;
    }
  }
  return out;
}

function clearStorage(storage: Storage) {
  // Collect keys first — mutating while iterating skips entries.
  const toDelete: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (isVaipakamKey(key)) toDelete.push(key!);
  }
  for (const key of toDelete) storage.removeItem(key);
}

/** Assemble the full GDPR export. Returns the JSON payload and
 *  triggers a browser download. */
export function downloadMyData(): GdprExport | null {
  if (typeof window === 'undefined') return null;
  const payload: GdprExport = {
    exportedAt: new Date().toISOString(),
    userAgent: window.navigator.userAgent,
    sessionStorage: collectStorage(window.sessionStorage),
    localStorage: collectStorage(window.localStorage),
    note:
      'This file contains every piece of client-side data Vaipakam stores under the ' +
      '`vaipakam` namespace in your browser. On-chain data (your wallet address, any ' +
      'transactions you have signed) is public on the blockchain and cannot be ' +
      'included in or erased by this export.',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vaipakam-my-data-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return payload;
}

/** Erase every Vaipakam-namespaced key from both localStorage and
 *  sessionStorage. After calling, the user's browser state resets to
 *  a "never visited Vaipakam" posture — they will see the cookie
 *  banner again on next load and will need to re-accept the ToS if
 *  the on-chain gate is active. On-chain positions are unaffected
 *  (the protocol has no deletion surface for on-chain state). */
export function deleteMyData(): { localKeysCleared: number; sessionKeysCleared: number } | null {
  if (typeof window === 'undefined') return null;
  // Count keys before clearing so we can return a receipt to the UI.
  let localCount = 0;
  let sessionCount = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    if (isVaipakamKey(window.localStorage.key(i))) localCount++;
  }
  for (let i = 0; i < window.sessionStorage.length; i++) {
    if (isVaipakamKey(window.sessionStorage.key(i))) sessionCount++;
  }
  clearStorage(window.localStorage);
  clearStorage(window.sessionStorage);
  return { localKeysCleared: localCount, sessionKeysCleared: sessionCount };
}
