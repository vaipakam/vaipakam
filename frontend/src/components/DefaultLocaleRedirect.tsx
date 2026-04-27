import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SUPPORTED_LOCALES } from '../i18n/glossary';
import { isSupportedLocale, withLocalePrefix } from './LocaleResolver';

/**
 * First-visit default-locale redirect.
 *
 * Behaviour:
 *   1. If the user has already chosen a language (a non-empty
 *      `localStorage["vaipakam:language"]` entry exists), do nothing —
 *      the LanguagePicker is the source of truth.
 *   2. Otherwise, walk `navigator.languages` and find the first entry
 *      whose primary tag matches a SUPPORTED_LOCALES code. Falls back
 *      to English if none match.
 *   3. If the matched locale is non-English AND the current URL has no
 *      `/<locale>` prefix, navigate to the locale-prefixed equivalent.
 *      Persists the choice to localStorage so subsequent visits skip
 *      the redirect.
 *
 * Why a redirect (and not just `i18n.changeLanguage(lng)`)?
 *   - The URL is the canonical signal for the active locale (SEO
 *     routes), not the i18n state. A user who arrives via a search
 *     result for `/es/help/basic` is already on the right URL; the
 *     redirect is for first-time visitors who land on the root and
 *     should be sent to the prefixed equivalent of where they wanted
 *     to go.
 *   - The browser bar and any link the user shares carry the locale
 *     prefix so a recipient on a different browser locale gets the
 *     same content.
 *
 * Hidden component — renders nothing. Mount once near the top of the
 * router tree.
 */
const STORAGE_KEY = 'vaipakam:language';

export function DefaultLocaleRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    // Step 1 — explicit user choice trumps everything.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return;

    // Step 2 — find the first navigator-language match. `navigator.languages`
    // is a priority-ordered list (e.g. `['en-US', 'en', 'es']`); we
    // strip to the primary subtag and pick the first that we ship
    // a translation for. Defaults to English when nothing matches.
    const candidates = (navigator.languages?.length
      ? navigator.languages
      : [navigator.language ?? 'en']
    ).map((tag) => tag.split('-')[0].toLowerCase());
    const matched = candidates.find((primary) =>
      (SUPPORTED_LOCALES as readonly string[]).includes(primary),
    );
    if (!matched || !isSupportedLocale(matched) || matched === 'en') {
      // Persist so we don't re-evaluate every visit. English at root
      // is the correct default for these users.
      try {
        window.localStorage.setItem(STORAGE_KEY, 'en');
      } catch {
        // Storage disabled (private mode / quota). Ignore — the
        // redirect won't fire again this session, which is fine.
      }
      return;
    }

    // Step 3 — only redirect if we're not already on a localised path.
    // The LocaleResolver / route table already flips i18n based on the
    // URL prefix; this redirect is only for the unprefixed root.
    const onLocalePrefix = /^\/([a-z]{2})(\/|$)/.exec(location.pathname);
    if (onLocalePrefix && isSupportedLocale(onLocalePrefix[1])) {
      // Already on a prefixed URL — persist the user's effective
      // locale (the one in the URL) so future no-prefix visits don't
      // bounce them away.
      try {
        window.localStorage.setItem(STORAGE_KEY, onLocalePrefix[1]);
      } catch {
        // ignore
      }
      return;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, matched);
    } catch {
      // ignore
    }
    const target = withLocalePrefix(location.pathname, matched);
    navigate(`${target}${location.search}${location.hash}`, { replace: true });
    // Empty deps — fires exactly once on mount. We don't want this
    // running on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
