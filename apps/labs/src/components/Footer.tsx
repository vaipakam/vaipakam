import { L as Link } from './L';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../context/ThemeContext';
import { openConsentBanner } from '../lib/consent';
import { defiUrl } from '../lib/defiUrl';
import './Footer.css';

const GITHUB_URL = 'https://github.com/vaipakam';
const X_URL = 'https://x.com/vaipakam';
const REDDIT_URL = 'https://www.reddit.com/user/Vaipakam/';

export default function Footer() {
  const { theme } = useTheme();
  const { t } = useTranslation();

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <img
              src={theme === 'dark' ? '/logo-dark.png' : '/logo-light.png'}
              alt="Vaipakam"
              className="footer-logo"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <p className="footer-tagline">{t('footer.tagline')}</p>
            {/* Per-chain Diamond verify links live on the connected-app
                surface (defi.vaipakam.com/analytics#transparency) — see
                the "Smart Contracts" link in the Resources column. The
                marketing footer is intentionally chain-agnostic so the
                deployed-network set can change without a labs build. */}
          </div>

          <div className="footer-col">
            <h4>{t('footer.colProtocol')}</h4>
            <Link to="/#features">{t('nav.features')}</Link>
            <Link to="/#how-it-works">{t('nav.howItWorks')}</Link>
            <Link to="/#security">{t('nav.security')}</Link>
            <Link to="/#faq">{t('nav.faq')}</Link>
          </div>

          <div className="footer-col">
            <h4>{t('footer.colResources')}</h4>
            <Link to="/help/overview">{t('footer.documentation')}</Link>
            {/* Analytics, Protocol Console, and NFT Verifier are
                public-read tools hosted on the connected-app domain
                — see Navbar for the rationale. Plain `<a>` with
                `target="_blank"` so the marketing tab stays open. */}
            <a
              href={defiUrl('/analytics#transparency')}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('footer.smartContracts')}
            </a>
            <a
              href={defiUrl('/protocol-console')}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('footer.protocolConsole', 'Protocol Console')}
            </a>
            <a
              href={defiUrl('/nft-verifier')}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('nav.nftVerifier')}
            </a>
            <Link to="/buy-vpfi">{t('appNav.buyVpfi')}</Link>
          </div>

          <div className="footer-col">
            <h4>{t('footer.colCommunity')}</h4>
            <Link to="/discord">{t('footer.discord')}</Link>
            <a href={X_URL} target="_blank" rel="noreferrer">X</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={REDDIT_URL} target="_blank" rel="noreferrer">Reddit</a>
          </div>
        </div>

        <p className="footer-disclaimer" role="note">{t('footer.disclaimer')}</p>

        <div className="footer-bottom">
          <p>
            &copy; {new Date().getFullYear()} Vaipakam.{' '}
            {t('footer.rightsReserved')}
          </p>
          <Link to="/terms" className="footer-cookie-link">
            {t('footer.terms')}
          </Link>
          <Link to="/privacy" className="footer-cookie-link">
            {t('footer.privacy')}
          </Link>
          <button
            type="button"
            className="footer-cookie-link"
            onClick={openConsentBanner}
          >
            {t('footer.cookieSettings')}
          </button>
          <p className="footer-license">{t('footer.license')}</p>
        </div>
      </div>
    </footer>
  );
}
