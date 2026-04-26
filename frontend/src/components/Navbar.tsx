import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useWallet } from '../context/WalletContext';
import {
  Sun,
  Moon,
  Menu,
  X,
  AlertTriangle,
  LogOut,
  ArrowRight,
  ChevronDown,
} from 'lucide-react';
import './Navbar.css';
import { ReportIssueLink } from './app/ReportIssueLink';
import { ConnectWalletButton } from './app/ConnectWalletButton';
import { WalletMenu } from './app/WalletMenu';

type NavLink = { label: string; href: string };

interface NavGroup {
  /** Dropdown trigger label. */
  label: string;
  /** Stable identifier — used as the React key + the `openGroup` value
   *  in popover state so we know which dropdown is currently expanded. */
  id: string;
  links: NavLink[];
}

/** Two grouped dropdowns replacing the previous 6-flat-link row.
 *
 *   - "Learn"  — explainer / about-us anchors on the landing page.
 *   - "Verify" — transparency tooling: Analytics dashboard, NFT
 *                Verifier, and the Security section (whose cards
 *                each link to on-chain verification artifacts).
 *
 * Hash-anchor entries rely on the app-level ScrollToHash helper to
 * jump to the matching section after the home page mounts on cross-
 * route navigation. */
const NAV_GROUPS: NavGroup[] = [
  {
    id: 'learn',
    label: 'Learn',
    links: [
      { label: 'Features', href: '/#features' },
      { label: 'How It Works', href: '/#how-it-works' },
      { label: 'FAQ', href: '/#faq' },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    links: [
      { label: 'Analytics', href: '/analytics' },
      { label: 'NFT Verifier', href: '/nft-verifier' },
      { label: 'Security', href: '/#security' },
    ],
  },
];

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const { address, isCorrectChain, disconnect, switchToDefaultChain, error, warning } = useWallet();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Which nav-group dropdown (if any) is currently expanded on
  // desktop. Mobile flyout shows both groups inline (no popover).
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groupsWrapRef = useRef<HTMLDivElement | null>(null);

  // Close the desktop dropdown on outside click / Escape so it never
  // outlives the user's attention. Mobile uses inline rendering, so
  // these handlers are scoped to the desktop popover only.
  useEffect(() => {
    if (!openGroup) return;
    function onPointerDown(e: PointerEvent) {
      if (groupsWrapRef.current?.contains(e.target as Node)) return;
      setOpenGroup(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenGroup(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openGroup]);

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

        <div
          className={`navbar-links ${mobileOpen ? 'open' : ''}`}
          ref={groupsWrapRef}
        >
          {NAV_GROUPS.map((group) => (
            <div
              key={group.id}
              className="navbar-group"
              // Mouse-only hover-to-open. Pointer-type filter keeps
              // touch devices from synthesising a phantom hover on
              // tap, which would race with the trigger's onClick
              // toggle and immediately close the menu the user just
              // opened. Touch / keyboard still get a deterministic
              // open via the trigger's click + Enter / Space.
              onPointerEnter={(e) => {
                if (e.pointerType !== 'mouse') return;
                setOpenGroup(group.id);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType !== 'mouse') return;
                setOpenGroup((prev) => (prev === group.id ? null : prev));
              }}
            >
              {/* Desktop trigger — popover dropdown. Mobile flyout
                  ignores this button visually and renders the
                  section as an inline list (see mobile-only CSS in
                  Navbar.css). */}
              <button
                type="button"
                className={`navbar-link navbar-group-trigger ${
                  openGroup === group.id ? 'navbar-group-trigger--open' : ''
                }`}
                onClick={() =>
                  setOpenGroup((prev) => (prev === group.id ? null : group.id))
                }
                aria-haspopup="menu"
                aria-expanded={openGroup === group.id}
              >
                {group.label}
                <ChevronDown size={14} aria-hidden="true" />
              </button>

              {/* Desktop popover — only one open at a time. Hidden on
                  mobile via CSS so the flyout uses the inline list
                  below instead of a nested dropdown surface. */}
              {openGroup === group.id && (
                <div className="navbar-group-panel" role="menu">
                  {group.links.map((link) => (
                    <Link
                      key={link.href}
                      to={link.href}
                      className="navbar-group-item"
                      role="menuitem"
                      onClick={() => {
                        setOpenGroup(null);
                        setMobileOpen(false);
                      }}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              )}

              {/* Mobile inline list — visible only inside the open
                  flyout. Section header + 3 items per group, no
                  popover. CSS-toggled via `.navbar-group-mobile-list`
                  visibility rules in Navbar.css. */}
              <div className="navbar-group-mobile-list">
                <span className="navbar-group-mobile-label">
                  {group.label}
                </span>
                {group.links.map((link) => (
                  <Link
                    key={link.href}
                    to={link.href}
                    className="navbar-link navbar-link--mobile-nested"
                    onClick={() => setMobileOpen(false)}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
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
              <ConnectWalletButton fullWidth />
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
          {/* Desktop Launch App button — visible on every public page (landing,
              analytics, public Buy VPFI) because this Navbar only renders
              outside /app. AppLayout owns its own chrome, so no extra
              route-based gating needed here. */}
          <Link to="/app" className="btn btn-primary navbar-cta navbar-launch">
            Launch App <ArrowRight size={14} />
          </Link>

          {/* Desktop wallet entry-point. Mirrors the in-app topbar: a
              single pill (chain icon + address) that opens a popover
              containing the chain switcher + disconnect. The
              ConnectWalletButton / Wrong-Network states stay as
              standalone buttons because they're one-click actions
              with nothing else to consolidate. */}
          {!address ? (
            <ConnectWalletButton className="navbar-cta" />
          ) : !isCorrectChain ? (
            <button
              className="btn btn-warning navbar-cta"
              onClick={switchToDefaultChain}
            >
              <AlertTriangle size={16} />
              Wrong Network
            </button>
          ) : (
            <span className="navbar-cta">
              <WalletMenu />
            </span>
          )}

          <button
            className="mobile-menu-btn"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>

          {/* Theme toggle anchored to the trailing edge of the row
              so the public navbar's right end mirrors the in-app
              topbar's right-end-anchored Settings gear. On mobile
              the hamburger sits to its left; the toggle is small
              enough (40px) to share the row without crowding. */}
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
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

      {/* Warning surface — "no wallet detected" etc. Amber banner, no
       *  "report this" link because it's a user-environment nudge,
       *  not a system failure. */}
      {warning && !error && (
        <div className="wallet-warning">
          <div
            className="container"
            style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{warning}</span>
          </div>
        </div>
      )}
    </nav>
  );
}
