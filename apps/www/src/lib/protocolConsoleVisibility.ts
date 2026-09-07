/**
 * Public-visibility flag for the Protocol Console docs page hosted
 * on the marketing site. Mirrors the same-named helper in
 * `apps/app/src/lib/protocolConsoleVisibility.ts` so the env var
 * `VITE_ADMIN_DASHBOARD_PUBLIC` is honoured uniformly across both
 * apps. (It named `apps/defi` until #1959 — that tree was deleted in
 * #1854 and the console was ported to `apps/app`, so a reader
 * synchronising a visibility change was being sent to a counterpart
 * that no longer exists.)
 *
 * Why the docs live here rather than in the app: the connected-app
 * surface owns the LIVE VALUES at `/protocol-console`; the marketing
 * surface owns the *reference docs* at `/protocol-console/docs` so the
 * public URL `https://vaipakam.com/protocol-console/docs` indexes
 * alongside the rest of the public-read explainer content (Whitepaper /
 * Overview / User Guide).
 *
 * The `/protocol-console` route on the app defaults to publicly
 * readable so anyone visiting can see the current values of the
 * governance parameters the indexer publishes. It is READ-ONLY — the
 * ported page has no wallet-bearing writes and shows no hard bounds or
 * recommended zones; those live in the reference docs here.
 * Transparency is good optics for DeFi — the pattern every major
 * protocol has settled on.
 *
 * BOTH SIDES MOVE TOGETHER. When this flag is off, the app renders only
 * its hidden-state message, this site's docs page redirects home, and
 * the Footer link and Navbar entry are withheld — so nothing advertises
 * a surface the deployment has decided not to serve.
 *
 * Operators who'd rather not surface the console publicly (e.g. on a
 * pre-launch deploy where tunables are still mid-tuning, or on the
 * industrial fork where parameter visibility itself is restricted)
 * can flip the flag off via `VITE_ADMIN_DASHBOARD_PUBLIC=false` —
 * the same env-var name on both apps, set the same way in each
 * Worker's Cloudflare config so the dashboard + docs hide together.
 *
 * Default-on so a forgotten `.env` line falls into the
 * public-transparency mode rather than the opaque mode.
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
