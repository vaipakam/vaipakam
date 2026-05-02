/**
 * T-042 Phase 1d — public-visibility flag for the Protocol Console.
 *
 * The `/admin` and `/admin/docs` routes default to **publicly
 * readable** so anyone visiting the site can see every governance-
 * tunable parameter's current value, hard bound, and recommended
 * operational zone. Transparency is good optics for DeFi — it's the
 * pattern Aave / Compound / Maker have all settled on.
 *
 * Operators who'd rather not surface the console publicly (e.g. on a
 * pre-launch deploy where tunables are still mid-tuning, or on the
 * industrial fork where parameter visibility itself is restricted)
 * can flip the flag off via `VITE_ADMIN_DASHBOARD_PUBLIC=false`. With
 * the flag off:
 *   - Direct navigation to `/admin` redirects to home unless a
 *     protocol-admin wallet is connected.
 *   - `/admin/docs` follows the same gate — same audit trail logic,
 *     no point exposing the parameter rationale if the values
 *     themselves are hidden.
 *
 * Same env-flag pattern as `VITE_DIAG_DRAWER_ENABLED` and the other
 * feature flags. Default-on so a forgotten `.env` line falls into
 * the public-transparency mode rather than the opaque mode.
 *
 * **Naming note (renamed 2026-05-02)**: function renamed from
 * `isAdminDashboardPublic` → `isProtocolConsolePublic` so that
 * future readers don't conflate this with the contract `ADMIN_ROLE`
 * gate (which is on a different layer). The env var name
 * `VITE_ADMIN_DASHBOARD_PUBLIC` stays for back-compat with existing
 * `.env.local` / Cloudflare deploy configurations — renaming would
 * orphan operator-side configs.
 */

export function isProtocolConsolePublic(): boolean {
  try {
    const raw =
      (import.meta.env.VITE_ADMIN_DASHBOARD_PUBLIC as string | undefined) ?? '';
    // Default-true on missing / empty: the public console is the
    // canonical transparency surface and should be reachable unless
    // governance explicitly turns it off.
    return raw.toLowerCase() !== 'false';
  } catch {
    return true;
  }
}
