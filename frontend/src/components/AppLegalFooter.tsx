import { useTranslation } from 'react-i18next';
import { L as Link } from './L';
import { openConsentBanner } from '../lib/consent';
import './AppLegalFooter.css';

/**
 * Minimal legal-only footer rendered at the bottom of every connected-app
 * page. Mirrors the bottom strip of the public-site `Footer.tsx` —
 * copyright + Terms + Privacy + Cookie settings + BUSL license — but
 * omits the brand block, network selector, link columns, and disclaimer
 * paragraph that the public marketing footer carries. Reuses the same
 * i18n keys (`footer.rightsReserved`, `footer.terms`, `footer.privacy`,
 * `footer.cookieSettings`, `footer.license`) so translations stay in
 * sync and adding a locale to one updates both surfaces.
 *
 * Why a separate component instead of dropping the public Footer into
 * AppLayout: the marketing footer's brand + networks + columns are
 * heavy and visually compete with the in-app sidebar / topbar chrome.
 * The connected app needs the legal surface (compliance / cookie
 * controls / license attribution) without the marketing weight.
 */
export function AppLegalFooter() {
  const { t } = useTranslation();
  return (
    <footer className="app-legal-footer">
      <div className="app-legal-footer-inner">
        <p>
          &copy; {new Date().getFullYear()} Vaipakam.{' '}
          {t('footer.rightsReserved')}
        </p>
        <Link to="/terms" className="app-legal-footer-link">
          {t('footer.terms')}
        </Link>
        <Link to="/privacy" className="app-legal-footer-link">
          {t('footer.privacy')}
        </Link>
        <button
          type="button"
          className="app-legal-footer-link"
          onClick={openConsentBanner}
        >
          {t('footer.cookieSettings')}
        </button>
        <p className="app-legal-footer-license">{t('footer.license')}</p>
      </div>
    </footer>
  );
}
