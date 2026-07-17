/**
 * The single route × locale registry every www SEO script consumes
 * (generate-sitemap.mjs, prerender.mjs) — extracted so the sitemap
 * and the prerendered page set cannot drift apart.
 *
 * Locale list: must match `TRANSLATED_LOCALES` in
 * `apps/www/src/i18n/glossary.ts`. Listing a placeholder locale here
 * would advertise (and snapshot) non-existent translated pages —
 * a self-inflicted ranking penalty. The list is duplicated here
 * (rather than imported) because these scripts run as plain Node
 * `.mjs` and the TS source isn't transpiled at generation time.
 *
 * Route list: must match the marketing routes in
 * `apps/www/src/App.tsx`. Adding a new marketing route is "edit two
 * files" by design — an in-app route that shouldn't be indexed just
 * doesn't get added here, and the absence is the indexing decision.
 * Order: likely-importance for the crawler's first-pass scan
 * (landing → vpfi → docs → legal).
 */

export const LOCALES = [
  'en',
  'es',
  'fr',
  'de',
  'ja',
  'zh',
  'hi',
  'ar',
  'ta',
  'ko',
];

/** The Protocol Console reference docs are public-transparency
 *  content meant to index alongside the other explainer pages (see
 *  src/lib/protocolConsoleVisibility.ts), but the page is env-gated:
 *  `VITE_ADMIN_DASHBOARD_PUBLIC=false` hides it (industrial fork /
 *  pre-launch deploys). The SEO registry honours the SAME flag with
 *  the SAME default-true semantics, so a hidden page is never
 *  advertised in the sitemap or prerendered. */
const PROTOCOL_CONSOLE_PUBLIC =
  (process.env.VITE_ADMIN_DASHBOARD_PUBLIC ?? '').toLowerCase() !== 'false';

export const ROUTES = [
  '/',
  '/vpfi',
  '/help/overview',
  '/help/basic',
  '/help/advanced',
  '/help/technical',
  '/help/search',
  ...(PROTOCOL_CONSOLE_PUBLIC ? ['/protocol-console/docs'] : []),
  '/discord',
  '/terms',
  '/privacy',
  '/data-rights',
];

/** Compose a localised URL — English at the unprefixed root, every
 *  other locale gets a `/<locale>/` prefix. Mirrors the
 *  `withLocalePrefix` helper in src/components/LocaleResolver.tsx. */
export function localizedPath(route, locale) {
  if (locale === 'en') return route;
  if (route === '/') return `/${locale}`;
  return `/${locale}${route}`;
}
