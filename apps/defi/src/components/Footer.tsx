import { useMemo } from 'react';
import { L as Link } from './L';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../context/ThemeContext';
import { CHAIN_REGISTRY, compareChainsForDisplay } from '../contracts/config';
import { ChainPicker } from '@vaipakam/ui/ChainPicker';
import { openConsentBanner } from '../lib/consent';
import { marketingUrl } from '../lib/marketingUrl';
import './Footer.css';

const GITHUB_URL = 'https://github.com/vaipakam';
const X_URL = 'https://x.com/vaipakam';
const REDDIT_URL = 'https://www.reddit.com/user/Vaipakam/';

export default function Footer() {
  const { theme } = useTheme();
  const { t } = useTranslation();

  // Derive the "supported networks" badges directly from CHAIN_REGISTRY so
  // this block reflects what's actually deployed (diamondAddress non-null)
  // rather than the old hard-coded "Ethereum / Polygon / Arbitrum" list.
  // Mainnet first, then testnets; within each tier alphabetical by name.
  const deployedNetworks = useMemo(
    () =>
      Object.values(CHAIN_REGISTRY)
        .filter((c) => c.diamondAddress !== null)
        .sort(compareChainsForDisplay),
    [],
  );

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
            <div className="footer-networks">
              {deployedNetworks.length === 0 ? (
                <span className="network-badge">{t('footer.comingSoon')}</span>
              ) : (
                <div className="footer-network-select">
                  <span className="footer-network-label">
                    {t('footer.supportedNetworks')}
                  </span>
                  {/* No persistent value — the picker is a menu; selecting a
                      chain opens its Diamond on the chain's block explorer in
                      a fresh tab. */}
                  <ChainPicker
                    chains={deployedNetworks}
                    placeholder={t('footer.viewDiamondOnExplorer')}
                    ariaLabel={t('footer.viewDiamondAria')}
                    onSelect={(chainId) => {
                      const chain = deployedNetworks.find(
                        (c) => c.chainId === chainId,
                      );
                      if (!chain || !chain.diamondAddress) return;
                      const url = `${chain.blockExplorer}/address/${chain.diamondAddress}`;
                      window.open(url, '_blank', 'noopener,noreferrer');
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="footer-col">
            <h4>{t('footer.colProtocol')}</h4>
            {/* Landing-page section anchors live on the marketing
                site post-PR3. Cross-domain via `marketingUrl(...)`,
                opened in a new tab so the connected-app session
                stays open behind. */}
            <a href={marketingUrl('/#features')} target="_blank" rel="noopener noreferrer">
              {t('nav.features')}
            </a>
            <a href={marketingUrl('/#how-it-works')} target="_blank" rel="noopener noreferrer">
              {t('nav.howItWorks')}
            </a>
            <a href={marketingUrl('/#security')} target="_blank" rel="noopener noreferrer">
              {t('nav.security')}
            </a>
            <a href={marketingUrl('/#faq')} target="_blank" rel="noopener noreferrer">
              {t('nav.faq')}
            </a>
          </div>

          <div className="footer-col">
            <h4>{t('footer.colResources')}</h4>
            {/* `/help/overview` and `/buy-vpfi` are marketing pages
                — cross-domain. `/analytics#transparency`,
                `/protocol-console`, `/nft-verifier` are public-read
                tools that live on this connected-app domain, so
                they stay as in-app `<L>` links. */}
            <a href={marketingUrl('/help/overview')} target="_blank" rel="noopener noreferrer">
              {t('footer.documentation')}
            </a>
            <Link to="/analytics#transparency">{t('footer.smartContracts')}</Link>
            <Link to="/protocol-console">{t('footer.protocolConsole', 'Protocol Console')}</Link>
            <Link to="/nft-verifier">{t('nav.nftVerifier')}</Link>
            <a href={marketingUrl('/buy-vpfi')} target="_blank" rel="noopener noreferrer">
              {t('appNav.buyVpfi')}
            </a>
          </div>

          <div className="footer-col">
            <h4>{t('footer.colCommunity')}</h4>
            <a href={marketingUrl('/discord')} target="_blank" rel="noopener noreferrer">
              {t('footer.discord')}
            </a>
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
          {/* Terms / Privacy live on the marketing site post-PR3. */}
          <a
            href={marketingUrl('/terms')}
            target="_blank"
            rel="noopener noreferrer"
            className="footer-cookie-link"
          >
            {t('footer.terms')}
          </a>
          <a
            href={marketingUrl('/privacy')}
            target="_blank"
            rel="noopener noreferrer"
            className="footer-cookie-link"
          >
            {t('footer.privacy')}
          </a>
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
