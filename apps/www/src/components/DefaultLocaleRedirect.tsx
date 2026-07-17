import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TRANSLATED_LOCALES } from '../i18n/glossary';
import { isSupportedLocale, withLocalePrefix } from './LocaleResolver';

/**
 * Default-locale redirect.
 *
 * Behaviour:
 *   1. If the user has already chosen a language (a non-empty
 *      `localStorage["vaipakam:language"]` entry exists — their own
 *      picker choice, or one seeded from the cross-app cookie), the
 *      stored value is the source of truth. English needs no redirect
 *      (it lives at the unprefixed root). A non-English TRANSLATED
 *      preference on an UNPREFIXED URL is redirected to its prefixed
 *      equivalent — this is what keeps the root `LocaleResolver` from
 *      ever forcing `en` over a cross-app cookie preference
 *      (Codex #1309 r8). Placeholder (untranslated) preferences stay
 *      put: redirecting a Telugu preference to `/te/` would serve
 *      English content under a Telugu URL.
 *   2. Otherwise, walk `navigator.languages` and find the first entry
 *      whose primary tag matches a TRANSLATED locale. Falls back to
 *      English if none match.
 *   3. If the matched locale is non-English AND the current URL has no
 *      `/<locale>` prefix, navigate to the locale-prefixed equivalent.
 *      Persists the choice to localStorage so subsequent visits take
 *      the cheap step-1 path.
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

    const onLocalePrefix = /^\/([a-z]{2})(\/|$)/.exec(location.pathname);
    const prefixed = !!(onLocalePrefix && isSupportedLocale(onLocalePrefix[1]));

    // Step 1 — explicit user choice trumps everything. English stays
    // at the unprefixed root; a non-English TRANSLATED preference on
    // an unprefixed URL gets moved to its prefixed equivalent (see
    // the doc comment — this also protects the cross-app cookie from
    // the root LocaleResolver's `en` force). Placeholder preferences
    // are left where they are.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      if (
        !prefixed &&
        stored !== 'en' &&
        isSupportedLocale(stored) &&
        (TRANSLATED_LOCALES as readonly string[]).includes(stored)
      ) {
        const target = withLocalePrefix(location.pathname, stored);
        navigate(`${target}${location.search}${location.hash}`, {
          replace: true,
        });
      }
      return;
    }

    // Step 2 — find the first navigator-language match. `navigator.languages`
    // is a priority-ordered list (e.g. `['en-US', 'en', 'es']`); we
    // strip to the primary subtag and pick the first that we ship
    // a **translation bundle** for. Placeholder locales are
    // intentionally NOT matched here — redirecting a Telugu-speaking
    // visitor to `/te/` would land them on English content with a
    // `<html lang="te">` mismatch (worse than just leaving them on
    // the root English page). Defaults to English when nothing matches.
    const candidates = (navigator.languages?.length
      ? navigator.languages
      : [navigator.language ?? 'en']
    ).map((tag) => tag.split('-')[0].toLowerCase());
    const matched = candidates.find((primary) =>
      (TRANSLATED_LOCALES as readonly string[]).includes(primary),
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
    if (prefixed && onLocalePrefix) {
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
    // Re-runs per navigation (Codex #1309 r8): a bare `<Link>` that
    // missed the `<L>` migration lands the user on an unprefixed URL
    // mid-session, and the stored-preference redirect in step 1 must
    // catch that too, not just the first mount. After the first run a
    // stored value always exists, so subsequent runs are just the
    // cheap step-1 check (idempotent — prefixed URLs and English
    // return without navigating, so there is no redirect loop).
  }, [location.pathname, location.search, location.hash, navigate]);

  return null;
}
