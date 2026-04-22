import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useWallet } from '../context/WalletContext';
import {
  Sun,
  Moon,
  Menu,
  X,
  Wallet,
  AlertTriangle,
  LogOut,
  ArrowRight,
} from 'lucide-react';
import './Navbar.css';
import { ReportIssueLink } from './app/ReportIssueLink';

type NavLink = { label: string; href: string };

// All links route through React Router <Link>; hash-anchor entries rely on the
// app-level ScrollToHash helper to jump to the matching section after the
// home page mounts on cross-route navigation.
const NAV_LINKS: NavLink[] = [
  { label: 'Features', href: '/#features' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'NFT Verifier', href: '/nft-verifier' },
  { label: 'Security', href: '/#security' },
  { label: 'FAQ', href: '/#faq' },
];

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const { address, isConnecting, isCorrectChain, connect, disconnect, switchToDefaultChain, error } =
    useWallet();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <Link to="/" className="navbar-brand" aria-label="Vaipakam home">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo-light.png'}
            alt="Vaipakam"
            className="navbar-logo navbar-logo--full"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).nextElementSibling?.classList.add('show');
            }}
          />
          <img
            src={theme === 'dark' ? '/icon-dark.png' : '/icon-light.png'}
            alt="Vaipakam"
            className="navbar-logo navbar-logo--icon"
            aria-hidden="true"
          />
          <span className="navbar-brand-text">Vaipakam</span>
        </Link>

        <div className={`navbar-links ${mobileOpen ? 'open' : ''}`}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              to={link.href}
              className="navbar-link"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}

          {/* Mobile Launch App button — routes to the authenticated app shell.
              Present only here (on Navbar) because AppLayout has its own
              internal nav and shouldn't show this CTA. */}
          <Link
            to="/app"
            className="btn btn-primary navbar-launch-mobile"
            onClick={() => setMobileOpen(false)}
          >
            Launch App <ArrowRight size={16} />
          </Link>

          {/* Mobile wallet button */}
          <div className="navbar-wallet-mobile">
            {!address ? (
              <button
                className="btn btn-primary"
                onClick={connect}
                disabled={isConnecting}
                style={{ width: '100%' }}
              >
                <Wallet size={16} />
                {isConnecting ? 'Connecting...' : 'Connect Wallet'}
              </button>
            ) : !isCorrectChain ? (
              <button
                className="btn btn-warning"
                onClick={switchToDefaultChain}
                style={{ width: '100%' }}
              >
                <AlertTriangle size={16} />
                Switch Network
              </button>
            ) : (
              <div className="wallet-connected-mobile">
                <span className="wallet-address-badge">
                  <span className="wallet-dot" />
                  {shortenAddress(address)}
                </span>
                <button className="btn btn-ghost" onClick={disconnect}>
                  <LogOut size={16} /> Disconnect
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="navbar-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {/* Desktop Launch App button — visible on every public page (landing,
              analytics, public Buy VPFI) because this Navbar only renders
              outside /app. AppLayout owns its own chrome, so no extra
              route-based gating needed here. */}
          <Link to="/app" className="btn btn-primary navbar-cta navbar-launch">
            Launch App <ArrowRight size={14} />
          </Link>

          {/* Desktop wallet button */}
          {!address ? (
            <button
              className="btn btn-primary navbar-cta"
              onClick={connect}
              disabled={isConnecting}
            >
              <Wallet size={16} />
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          ) : !isCorrectChain ? (
            <button
              className="btn btn-warning navbar-cta"
              onClick={switchToDefaultChain}
            >
              <AlertTriangle size={16} />
              Wrong Network
            </button>
          ) : (
            <div className="wallet-connected navbar-cta">
              <span className="wallet-address-badge">
                <span className="wallet-dot" />
                {shortenAddress(address)}
              </span>
              <button
                className="wallet-disconnect-btn"
                onClick={disconnect}
                aria-label="Disconnect wallet"
              >
                <LogOut size={16} />
              </button>
            </div>
          )}

          <button
            className="mobile-menu-btn"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {error && (
        <div className="wallet-error">
          <div
            className="container"
            style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
            <ReportIssueLink variant="inline" />
          </div>
        </div>
      )}
    </nav>
  );
}
