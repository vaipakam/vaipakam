/**
 * Which language copies of a page are INDEXED (#1314, owner decision
 * 2026-10-28): the copies whose body is actually in that language.
 *
 * Every page keeps a copy under every translated locale's prefix, for
 * visitors. But a copy whose body fell back to English is the English page
 * under localized chrome, and advertising it would offer search engines
 * English duplicates as localized pages. So such a copy is left out of
 * hreflang and the sitemap and canonicalises to the English page — and
 * joins the index by itself the moment its body file is added.
 *
 * `src/content/bodySources.json` is the one declaration of where a page's
 * body comes from, read here at runtime and by `scripts/seo-routes.mjs` for
 * the sitemap (the prerender checks the two agree on every snapshot):
 *
 *   - a pattern (`overview/Overview.{locale}.md`, under `src/content/`):
 *     the body is that file, so a locale is indexed when its file exists;
 *   - `null`: the body is written in English only (the legal texts), so
 *     only the English page is indexed;
 *   - no entry: the body is the page's catalogue strings, translated with
 *     the locale's bundle, so every translated locale is indexed.
 */
import BODY_SOURCES from '../content/bodySources.json';
import { TRANSLATED_LOCALES, type TranslatedLocale } from '../i18n/glossary';

const SOURCES: Readonly<Record<string, string | null>> = BODY_SOURCES;

/**
 * The locales whose copy of `route` (locale prefix already stripped) is
 * indexed. `bodyFiles` is the page's own `import.meta.glob` of its body
 * directory; a page with a pattern entry must pass it, and one that does
 * not is treated as English-only — the direction that never advertises a
 * duplicate.
 */
export function indexedLocales(
  route: string,
  bodyFiles?: Readonly<Record<string, unknown>>,
): readonly TranslatedLocale[] {
  const key = routeKey(route);
  if (!(key in SOURCES)) return TRANSLATED_LOCALES;
  if (SOURCES[key] === null || bodyFiles === undefined) return ['en'];
  return TRANSLATED_LOCALES.filter(
    (locale) => bodyFileFor(route, locale, bodyFiles) !== undefined,
  );
}

function routeKey(route: string): string {
  return route.replace(/\/+$/, '') || '/';
}

/** The key in `bodyFiles` of `route`'s body in `locale`, by the route's
 *  pattern, or `undefined` when there is no such file (or the route has
 *  no pattern). The ONE matching rule: `indexedLocales` indexes exactly
 *  the locales this finds, and `resolveBody` serves exactly the file it
 *  finds, so a copy is never indexed as translated while the page serves
 *  English (Codex #3036 r1). */
export function bodyFileFor(
  route: string,
  locale: string,
  bodyFiles: Readonly<Record<string, unknown>>,
): string | undefined {
  const pattern = SOURCES[routeKey(route)];
  if (typeof pattern !== 'string') return undefined;
  const suffix = `/${pattern.replace('{locale}', locale)}`;
  return Object.keys(bodyFiles).find((path) => path.endsWith(suffix));
}

/** The body a page renders for `locale`: its own file when there is one,
 *  otherwise the English file. `locale` is the language of the text
 *  actually returned, for the page's content language, number formatting
 *  and English-only notice. */
export function resolveBody(
  route: string,
  locale: string,
  bodyFiles: Readonly<Record<string, string>>,
): { text: string; locale: string; fellBackToEnglish: boolean } {
  const own = bodyFileFor(route, locale, bodyFiles);
  if (own !== undefined) return { text: bodyFiles[own], locale, fellBackToEnglish: false };
  const english = bodyFileFor(route, 'en', bodyFiles);
  return {
    text: english !== undefined ? bodyFiles[english] : '',
    locale: 'en',
    fellBackToEnglish: locale !== 'en',
  };
}
