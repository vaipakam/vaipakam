/**
 * Public-visibility flag for the Protocol Console docs page hosted
 * on the marketing site. Mirrors the same-named helper in
 * `apps/defi/src/lib/protocolConsoleVisibility.ts` so the env var
 * `VITE_ADMIN_DASHBOARD_PUBLIC` is honoured uniformly across both
 * apps.
 *
 * Why the docs live here (not in apps/defi): the connected-app
 * surface owns the *interactive* `/protocol-console` dashboard
 * (wallet-bearing reads + writes); the marketing surface owns
 * the *reference docs* at `/protocol-console/docs` so the public
 * URL `https://vaipakam.com/protocol-console/docs` indexes alongside
 * the rest of the public-read explainer content (Whitepaper /
 * Overview / User Guide).
 *
 * The `/protocol-console` dashboard route on defi continues to
 * default to publicly readable so anyone visiting the site can see
 * every governance-tunable parameter's current value, hard bound,
 * and recommended operational zone. Transparency is good optics for
 * DeFi — the pattern every major protocol has settled on.
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
