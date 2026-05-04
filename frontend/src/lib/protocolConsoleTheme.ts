/**
 * T-042 Phase 3 — Protocol Console theme mode.
 *
 * Two visual modes for the same console surface:
 *
 *   - 'public':   matches the rest of the Vaipakam site theme.
 *                 Clean, professional, friendly to first-time
 *                 visitors who land on `/admin` for transparency.
 *
 *   - 'terminal': Bloomberg / mission-control aesthetic. Dark
 *                 background, high-contrast monospace numerics,
 *                 denser layout, neon-grade green / amber / red
 *                 accents. Reads as "professional power-user view"
 *                 to operators and signers who spend time here
 *                 making proposals.
 *
 * Resolution order (highest precedence first):
 *   1. URL query string `?view=public|terminal` (deep-link override).
 *   2. localStorage user preference (`vaipakam:admin-theme`).
 *   3. Auto-engage 'terminal' when a protocol-admin wallet is
 *      connected (`useIsProtocolAdmin()` consults the on-chain
 *      `ADMIN_ROLE` check).
 *   4. Default 'public'.
 *
 * The CSS theme variant lives in `components/admin/admin-theme.css`
 * — switching modes only flips a `data-admin-theme` attribute on
 * the wrapper, so the same React component tree renders either look.
 *
 * **Naming note (renamed 2026-05-02)**: this surface used to be
 * called the "Admin Console" / "Governance Console" in different
 * places; both were the same page. Standardised on **Protocol
 * Console** at the user-facing layer + the new identifier names
 * in this file. The localStorage key still reads
 * `vaipakam:admin-theme` for back-compat — renaming would orphan
 * an existing user's theme choice on next visit. Same for the
 * `data-admin-theme` HTML attribute (selector-load-bearing in
 * `admin-theme.css`).
 */

export type ProtocolConsoleThemeMode = 'public' | 'terminal';

const STORAGE_KEY = 'vaipakam:admin-theme';

/** Read the persisted preference. Returns null when nothing is set
 *  or localStorage is unavailable (SSR / strict cookies). */
export function readPersistedConsoleTheme(): ProtocolConsoleThemeMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'public' || raw === 'terminal' ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the user's mode choice. Best-effort; failures are
 *  swallowed (the toggle still works, just won't survive reload). */
export function persistConsoleTheme(mode: ProtocolConsoleThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* swallow */
  }
}

/** Read the URL `?view=` override if present and valid. */
export function readUrlConsoleTheme(search: string): ProtocolConsoleThemeMode | null {
  try {
    const params = new URLSearchParams(search);
    const v = params.get('view');
    return v === 'public' || v === 'terminal' ? v : null;
  } catch {
    return null;
  }
}
