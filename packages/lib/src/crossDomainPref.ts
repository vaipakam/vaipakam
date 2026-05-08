/**
 * `crossDomainPref` — read/write user UI preferences in cookies
 * scoped to the parent eTLD+1 (`.vaipakam.com`) so the value is
 * shared between every Vaipakam subdomain (labs.vaipakam.com,
 * defi.vaipakam.com, …).
 *
 * Two preference cookies (one per category) — `vaipakam_theme`
 * and `vaipakam_lang` — emitted with attributes:
 *
 *     Domain=.vaipakam.com   (auto-promoted up to the eTLD+1 of the
 *                              current host so a `defi.vaipakam.com`
 *                              write is visible from
 *                              `labs.vaipakam.com` and vice-versa)
 *     Path=/
 *     Max-Age=31536000       (one year)
 *     SameSite=Lax           (cross-subdomain navigation under the
 *                              same eTLD+1 is allowed; not
 *                              cross-site)
 *     Secure                 (HTTPS only — dropped automatically on
 *                              localhost so dev still works)
 *
 * GCM v2 classification: both cookies are `functionality_storage`
 * (UI theme + language). Per Google's GCM taxonomy this category is
 * for user-interface state and is treated as ESSENTIAL — the
 * vaipakam consent banner permanently grants this category in the
 * inline `<head>` defaults and never offers it as a toggle. Setting
 * these cookies in response to a user-initiated picker action is
 * not consent-gated under GDPR / PECR Article 5(3) ("strictly
 * necessary for a service explicitly requested by the user").
 *
 * Why two cookies, not one combined JSON blob:
 *   - Independent lifecycle — theme rotation doesn't re-encode the
 *     language value.
 *   - Smaller per-request header (~30 bytes vs ~80+ for JSON).
 *   - No JSON.parse on the SSR / hydration path.
 *   - Each can be cleared independently.
 *
 * The helpers fall through silently in non-browser contexts
 * (`typeof document === 'undefined'`) so they're safe to call
 * during SSR / build-time prerender. The reads return `null` and
 * the writes are no-ops; consumers fall back to localStorage /
 * navigator detection.
 */

/** Cookie name for the theme preference. Values: `'light'` or
 *  `'dark'`. Absence means the user hasn't picked a theme — the
 *  app then follows the OS via `prefers-color-scheme`. */
export const THEME_COOKIE = 'vaipakam_theme';

/** Cookie name for the language preference. Values: any locale
 *  code the app supports (`en`, `ar`, `de`, `es`, `fr`, `hi`,
 *  `ja`, `ko`, `ta`, `zh`). Absence means the user hasn't picked —
 *  the i18n detector then runs `navigator.language` / `htmlTag`. */
export const LANG_COOKIE = 'vaipakam_lang';

/**
 * Compute the eTLD+1 cookie scope for the current host so a write
 * on a subdomain is visible from every other subdomain under the
 * same parent.
 *
 * Logic:
 *   - `defi.vaipakam.com`  → `.vaipakam.com`
 *   - `labs.vaipakam.com`  → `.vaipakam.com`
 *   - `vaipakam.com`       → `.vaipakam.com`
 *   - `localhost`          → `null`  (browsers ignore Domain on a
 *                                     bare hostname; we omit the
 *                                     attribute so the cookie is
 *                                     scoped to the exact host)
 *   - `127.0.0.1`          → `null`  (same)
 *
 * The two-label heuristic (`a.b` → `.b` is wrong, we want `.a.b`)
 * is intentionally simple — a public-suffix-list-aware
 * implementation is overkill for a fixed-brand monorepo. Vaipakam
 * runs on `*.vaipakam.com` plus localhost; both paths are covered.
 */
function cookieDomainForHost(host: string): string | null {
  // Bare hostnames (no dot): localhost, an IP literal, etc. The
  // Domain attribute would be rejected by the browser, so omit it.
  if (!host.includes('.')) return null;
  // IPv4 literal — same: omit Domain so the cookie binds to the
  // exact IP. (IPv6 literals don't appear in document.location.host
  // for our deploy targets.)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const labels = host.split('.');
  // Take the last two labels — `vaipakam.com` from any
  // `*.vaipakam.com`, or just the host itself when it's already
  // two labels (e.g. someone visiting the apex `vaipakam.com`).
  const eTldPlusOne = labels.slice(-2).join('.');
  return `.${eTldPlusOne}`;
}

/** Read a cookie by name. Returns `null` when:
 *  - running outside a browser (`typeof document === 'undefined'`)
 *  - the cookie isn't set
 *  - decoding fails
 *  Pure read; doesn't mutate. */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  // `document.cookie` is `name1=val1; name2=val2; …`. Splitting on
  // `; ` matches the spec's separator; trimming each part covers
  // trailing-space edge cases.
  const parts = document.cookie.split(';');
  for (const raw of parts) {
    const segment = raw.trim();
    if (segment.startsWith(prefix)) {
      try {
        return decodeURIComponent(segment.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Write a cookie scoped so every subdomain under the current
 *  eTLD+1 sees the value. Idempotent; calling with the same value
 *  is a no-op visible-state-wise. No-op when not in a browser. */
export function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  const host = window.location?.hostname ?? '';
  const domain = cookieDomainForHost(host);
  // Match-anything path so the cookie is sent on every navigation.
  // Max-Age in seconds: 365 days. Browsers cap at ~400 days
  // (Chrome's RFC 9421-ish policy) — we deliberately stay under.
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${365 * 24 * 60 * 60}`,
    'SameSite=Lax',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  // `Secure` is mandatory under SameSite=Lax for cross-site
  // sub-requests, but the browser also rejects `Secure` from a
  // non-HTTPS origin (silent ignore on localhost) — so emit it
  // unconditionally on https and skip on http to avoid the
  // "Cookie not set, scheme is not secure" devtools warning during
  // local dev.
  if (window.location?.protocol === 'https:') parts.push('Secure');
  document.cookie = parts.join('; ');
}

/** Clear a cross-domain cookie set by {@link writeCookie}. The
 *  Domain attribute MUST match the original write or the browser
 *  treats the deletion as a different cookie. No-op when not in
 *  a browser. */
export function clearCookie(name: string): void {
  if (typeof document === 'undefined') return;
  const host = window.location?.hostname ?? '';
  const domain = cookieDomainForHost(host);
  const parts = [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (window.location?.protocol === 'https:') parts.push('Secure');
  document.cookie = parts.join('; ');
}
