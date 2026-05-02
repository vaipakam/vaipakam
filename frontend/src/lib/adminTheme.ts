/**
 * T-042 Phase 3 — admin dashboard theme mode.
 *
 * Two visual modes for the same dashboard surface:
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
 *   3. Auto-engage 'terminal' when an admin/governance wallet is
 *      connected (Phase 4 wires the on-chain role check; until then
 *      `useIsAdminWallet()` returns `false` and the auto-engage path
 *      is dormant).
 *   4. Default 'public'.
 *
 * The CSS theme variant lives in `components/admin/admin-theme.css`
 * — switching modes only flips a `data-admin-theme` attribute on
 * the dashboard wrapper, so the same React component tree renders
 * either look.
 */

export type AdminThemeMode = 'public' | 'terminal';

const STORAGE_KEY = 'vaipakam:admin-theme';

/** Read the persisted preference. Returns null when nothing is set
 *  or localStorage is unavailable (SSR / strict cookies). */
export function readPersistedAdminTheme(): AdminThemeMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'public' || raw === 'terminal' ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the user's mode choice. Best-effort; failures are
 *  swallowed (the toggle still works, just won't survive reload). */
export function persistAdminTheme(mode: AdminThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* swallow */
  }
}

/** Read the URL `?view=` override if present and valid. */
export function readUrlAdminTheme(search: string): AdminThemeMode | null {
  try {
    const params = new URLSearchParams(search);
    const v = params.get('view');
    return v === 'public' || v === 'terminal' ? v : null;
  } catch {
    return null;
  }
}
