import { useEffect, useRef, useState } from 'react';
import { L as Link } from './L';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../context/ThemeContext';
import {
  Sun,
  Moon,
  Menu,
  X,
  ArrowRight,
  Settings,
  Globe,
  ChevronDown,
} from 'lucide-react';
import './Navbar.css';
import { LanguagePicker } from './LanguagePicker';

type NavLink = {
  labelKey: string;
  href: string;
  /** Open in a new browser tab. Used for VPFI dropdown's action items
   *  (Buy / Stake-Unstake) which jump from the public marketing site
   *  into the wallet-gated app at `/app/buy-vpfi`. */
  newTab?: boolean;
};

interface NavGroup {
  /** Translation key for the dropdown trigger label. Resolved via
   *  `t(labelKey)` at render time so the label localises with the
   *  rest of the navbar when the user changes language. */
  labelKey: string;
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
 * route navigation. Labels carry translation keys (resolved against
 * the `nav.*` namespace in `src/i18n/locales/*.json`) rather than
 * raw English strings so a language change re-renders them in place.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: 'learn',
    labelKey: 'nav.learn',
    links: [
      { labelKey: 'nav.features', href: '/#features' },
      { labelKey: 'nav.howItWorks', href: '/#how-it-works' },
      { labelKey: 'nav.documentation', href: '/help/overview' },
      { labelKey: 'nav.faq', href: '/#faq' },
    ],
  },
  {
    id: 'verify',
    labelKey: 'nav.verify',
    links: [
      { labelKey: 'nav.analytics', href: '/analytics' },
      { labelKey: 'nav.nftVerifier', href: '/nft-verifier' },
      // Public read-only governance dashboard. Same surface as
      // Aave's "Governance" / Compound's "Governance" — public visit
      // shows current values + ranges + pending timelock changes;
      // admin-wallet visit unlocks the propose flow. Footer carries
      // the same link too; the dropdown entry meaningfully improves
      // discoverability for a transparency-first audience.
      { labelKey: 'nav.protocolConsole', href: '/protocol-console' },
      { labelKey: 'nav.security', href: '/#security' },
    ],
  },
];

export default function Navbar() {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Which nav-group dropdown (if any) is currently expanded on
  // desktop. Mobile flyout shows both groups inline (no popover).
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groupsWrapRef = useRef<HTMLDivElement | null>(null);
  // Settings gear (Language + Theme) popover. Lives next to the
  // hamburger so the public navbar matches the in-app topbar's
  // settings entry-point. Click-only on every device (mirrors the
  // InfoTip click-only pattern; avoids the iOS hover-on-first-tap
  // bug that would defer click to a second tap).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (settingsRef.current?.contains(e.target as Node)) return;
      setSettingsOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSettingsOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

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
        <Link to="/" className="navbar-brand" aria-label={t('nav.brandHome')}>
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
                // Inside the open mobile flyout the section is a
                // click-only collapse/expand row — hover-to-open
                // would race with the click handler on touch /
                // hybrid devices and toggle the section as soon as
                // a stray cursor entered. Gate on `mobileOpen` so
                // hover-to-expand only fires on the desktop popover.
                if (mobileOpen) return;
                setOpenGroup(group.id);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType !== 'mouse') return;
                if (mobileOpen) return;
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
                {t(group.labelKey)}
                {/* Chevron is hidden on desktop via CSS (the
                 *  desktop trigger is a bare text label); on
                 *  mobile it's the visible affordance for the
                 *  collapse/expand row. Rotates 180° when
                 *  the section is open. */}
                <ChevronDown
                  size={16}
                  className="navbar-group-trigger-chevron"
                  aria-hidden="true"
                />
              </button>

              {/* Desktop popover. Stays mounted in the DOM so CSS
                  transitions can run on BOTH directions (the previous
                  conditional-render approach gave us a smooth open
                  but an instant unmount on close, which read as
                  jarring). Visibility, opacity, and pointer-events
                  flip together via the `--open` modifier so the
                  closed panel is genuinely inert (no tab-stops, no
                  hit-tests) without leaving it visible during the
                  fade-out. Hidden on mobile via CSS so the flyout
                  uses the inline list below instead. */}
              <div
                className={`navbar-group-panel${
                  openGroup === group.id ? ' navbar-group-panel--open' : ''
                }`}
                role="menu"
                // `inert` (not `aria-hidden`) per WAI-ARIA spec —
                // hiding a focused descendant via aria-hidden is a
                // a11y bug because screen readers lose track of where
                // the user is. `inert` prevents focus AND hides from
                // the accessibility tree, which is exactly what we
                // want for a closed dropdown panel. Supported in all
                // modern browsers + React 19.
                inert={openGroup !== group.id}
              >
                {group.links.map((link) =>
                  link.newTab ? (
                    // Plain <a target="_blank"> for items that cross
                    // the public→app boundary (VPFI Buy / Stake-Unstake)
                    // so the marketing tab stays open behind. React-
                    // router's <Link> doesn't natively model new-tab
                    // navigation, and noopener/noreferrer are
                    // required for the cross-origin-style target.
                    <a
                      key={link.href}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="navbar-group-item"
                      role="menuitem"
                      tabIndex={openGroup === group.id ? 0 : -1}
                      onClick={() => {
                        setOpenGroup(null);
                        setMobileOpen(false);
                      }}
                    >
                      {t(link.labelKey)}
                    </a>
                  ) : (
                    <Link
                      key={link.href}
                      to={link.href}
                      className="navbar-group-item"
                      role="menuitem"
                      tabIndex={openGroup === group.id ? 0 : -1}
                      onClick={() => {
                        setOpenGroup(null);
                        setMobileOpen(false);
                      }}
                    >
                      {t(link.labelKey)}
                    </Link>
                  ),
                )}
              </div>

              {/* Mobile inline list — collapsed by default,
                  expands when the trigger button above flips
                  `openGroup` to this group's id. The `--open`
                  modifier (set inline) gates the CSS rule that
                  shows the list inside the flyout. The section
                  label `<span>` is kept in the DOM for screen
                  readers but visually hidden in the flyout (the
                  trigger button serves as the heading). */}
              <div
                className={`navbar-group-mobile-list${
                  openGroup === group.id
                    ? ' navbar-group-mobile-list--open'
                    : ''
                }`}
              >
                <span className="navbar-group-mobile-label">
                  {t(group.labelKey)}
                </span>
                {group.links.map((link) =>
                  link.newTab ? (
                    <a
                      key={link.href}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="navbar-link navbar-link--mobile-nested"
                      onClick={() => setMobileOpen(false)}
                    >
                      {t(link.labelKey)}
                    </a>
                  ) : (
                    <Link
                      key={link.href}
                      to={link.href}
                      className="navbar-link navbar-link--mobile-nested"
                      onClick={() => setMobileOpen(false)}
                    >
                      {t(link.labelKey)}
                    </Link>
                  ),
                )}
              </div>
            </div>
          ))}

          {/* Mobile Launch App button — routes to the authenticated app shell.
              Present only here (on Navbar) because AppLayout has its own
              internal nav and shouldn't show this CTA. */}
          <a
            href="/app"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary navbar-launch-mobile"
            onClick={() => setMobileOpen(false)}
          >
            {t('nav.launchApp')} <ArrowRight size={16} />
          </a>

        </div>

        <div className="navbar-actions">
          {/* Desktop Launch App button — visible on every public page (landing,
              analytics, public Buy VPFI marketing) because this Navbar
              only renders outside /app. Opens in a new tab so the
              marketing page stays open behind — same pattern as the
              VPFI dropdown's Buy / Stake-Unstake action items. */}
          <a
            href="/app"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary navbar-cta navbar-launch"
          >
            {t('nav.launchApp')} <ArrowRight size={14} />
          </a>

          {/* Wallet UI removed from the public Navbar — every public
              route is read-only / marketing after the Buy-VPFI split,
              so a wallet connection here has no purpose. All wallet-
              bearing surfaces live inside `<AppLayout>` (reachable via
              the Launch App button above), where the WalletMenu chain
              pill is always prominent. */}

          {/* Settings gear — Language picker + Theme toggle. Sits
              left of the hamburger on mobile and rightmost on
              desktop (hamburger is hidden ≥ 1200px). Mirrors the
              in-app topbar gear so the two surfaces feel like
              siblings; click-only on every viewport to avoid the
              iOS hover-on-first-tap issue. */}
          <div className="navbar-settings" ref={settingsRef}>
            <button
              type="button"
              className="navbar-settings-btn"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
              aria-label={t('settings.title')}
            >
              <Settings size={18} />
            </button>

            {settingsOpen && (
              <div
                className="navbar-settings-panel"
                role="menu"
                aria-label={t('settings.title')}
              >
                <div className="navbar-settings-row">
                  <span className="navbar-settings-label">
                    <Globe size={12} aria-hidden="true" />
                    {t('common.language')}
                  </span>
                  <LanguagePicker />
                </div>

                <div className="navbar-settings-row">
                  <span className="navbar-settings-label">{t('common.theme')}</span>
                  <button
                    type="button"
                    className="theme-toggle"
                    onClick={toggleTheme}
                    aria-label={
                      theme === 'dark'
                        ? t('settings.themeSwitchToLight')
                        : t('settings.themeSwitchToDark')
                    }
                  >
                    {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                    <span className="navbar-settings-theme-label">
                      {theme === 'dark'
                        ? t('common.themeLight')
                        : t('common.themeDark')}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            className="mobile-menu-btn"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={t('nav.toggleMenu')}
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

    </nav>
  );
}
