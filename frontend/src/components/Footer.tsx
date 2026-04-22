import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { CHAIN_REGISTRY, compareChainsForDisplay } from '../contracts/config';
import { ChainPicker } from './ChainPicker';
import './Footer.css';

const GITHUB_URL = 'https://github.com/vaipakam';
const X_URL = 'https://x.com/vaipakam';
const REDDIT_URL = 'https://www.reddit.com/user/Vaipakam/';

export default function Footer() {
  const { theme } = useTheme();

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
            <p className="footer-tagline">
              Decentralized peer-to-peer lending and NFT rentals. Trustless, transparent, on-chain.
            </p>
            <div className="footer-networks">
              {deployedNetworks.length === 0 ? (
                <span className="network-badge">Coming soon</span>
              ) : (
                <div className="footer-network-select">
                  <span className="footer-network-label">
                    Supported networks
                  </span>
                  {/* No persistent value — the picker is a menu; selecting a
                      chain opens its Diamond on the chain's block explorer in
                      a fresh tab. */}
                  <ChainPicker
                    chains={deployedNetworks}
                    placeholder="View Diamond on explorer…"
                    ariaLabel="View Diamond contract on block explorer"
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
            <h4>Protocol</h4>
            <Link to="/#features">Features</Link>
            <Link to="/#how-it-works">How It Works</Link>
            <Link to="/#security">Security</Link>
            <Link to="/#faq">FAQ</Link>
          </div>

          <div className="footer-col">
            <h4>Resources</h4>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">Documentation</a>
            <Link to="/analytics">Smart Contracts</Link>
            <Link to="/app/nft-verifier">NFT Verifier</Link>
            <Link to="/buy-vpfi">Buy VPFI</Link>
          </div>

          <div className="footer-col">
            <h4>Community</h4>
            <Link to="/discord">Discord</Link>
            <a href={X_URL} target="_blank" rel="noreferrer">X</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={REDDIT_URL} target="_blank" rel="noreferrer">Reddit</a>
          </div>
        </div>

        <p className="footer-disclaimer" role="note">
          Vaipakam is a decentralized, non-custodial protocol. No KYC is required.
          Users are responsible for their own regulatory compliance.
        </p>

        <div className="footer-bottom">
          <p>&copy; {new Date().getFullYear()} Vaipakam. All rights reserved.</p>
          <p className="footer-license">BUSL 1.1 License</p>
        </div>
      </div>
    </footer>
  );
}
