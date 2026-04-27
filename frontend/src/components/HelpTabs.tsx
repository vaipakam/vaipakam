import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMode } from '../context/ModeContext';
import { isSupportedLocale, withLocalePrefix } from './LocaleResolver';
import type { SupportedLocale } from '../i18n/glossary';

/**
 * Three-tab strip rendered at the top of every `/help/*` page:
 *
 *   [ Overview ]  [ User Guide ]  [ Technical ]
 *
 * - **Overview** — `/help/overview`. Friendly product tour. Translated.
 * - **User Guide** — `/help/basic` or `/help/advanced` depending on the
 *   active app mode (`useMode`). The User Guide is per-card help with
 *   a Basic/Advanced split that mirrors the in-app mode toggle, so the
 *   tab opens whichever variant matches the user's current preference.
 *   Once on the page, the existing Lender/Borrower role tabs continue
 *   to work the same way.
 * - **Technical** — `/help/technical`. The full whitepaper. English
 *   only; non-English visitors get the translation-pending notice.
 *
 * Active-tab detection is path-prefix based so deep links inside the
 * User Guide (`/help/basic#some-card-anchor`) still highlight the
 * "User Guide" tab. The locale prefix is stripped first so a Spanish
 * user on `/es/help/overview` matches the same predicate as an English
 * user on `/help/overview`.
 */
export function HelpTabs() {
  const { t, i18n } = useTranslation();
  const { mode } = useMode();
  const { pathname } = useLocation();

  const locale: SupportedLocale = isSupportedLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : 'en';

  // Strip an optional `/<locale>` prefix so the active-tab predicate
  // doesn't have to special-case ten URL shapes.
  const stripped = pathname.replace(/^\/[a-z]{2}(\/|$)/, '/');
  const isOverview = stripped.startsWith('/help/overview');
  const isTechnical = stripped.startsWith('/help/technical');
  // Anything else under /help/ is part of the User Guide (basic or advanced).
  const isUserGuide = stripped.startsWith('/help') && !isOverview && !isTechnical;

  const overviewHref = withLocalePrefix('/help/overview', locale);
  const userGuideHref = withLocalePrefix(
    `/help/${mode === 'advanced' ? 'advanced' : 'basic'}`,
    locale,
  );
  const technicalHref = withLocalePrefix('/help/technical', locale);

  return (
    <div className="help-tabs" role="tablist" aria-label={t('helpTabs.ariaLabel')}>
      <Link
        to={overviewHref}
        role="tab"
        aria-selected={isOverview}
        className={`help-tab ${isOverview ? 'is-active' : ''}`}
      >
        {t('helpTabs.overview')}
      </Link>
      <Link
        to={userGuideHref}
        role="tab"
        aria-selected={isUserGuide}
        className={`help-tab ${isUserGuide ? 'is-active' : ''}`}
      >
        {t('helpTabs.userGuide')}
      </Link>
      <Link
        to={technicalHref}
        role="tab"
        aria-selected={isTechnical}
        className={`help-tab ${isTechnical ? 'is-active' : ''}`}
      >
        {t('helpTabs.technical')}
      </Link>
    </div>
  );
}
