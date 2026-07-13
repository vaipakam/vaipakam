/**
 * App shell — one layout, two navigation surfaces:
 *   - phones: sticky top bar + fixed bottom tab bar (5 tabs max);
 *   - >=720px: the same top bar + a left sidebar.
 *
 * Navigation follows the Basic-mode nav model from
 * BasicUserUXSimplification.md. Advanced mode ADDS destinations
 * (Offer Book, VPFI) rather than replacing the tree — hidden routes
 * stay reachable by URL in both modes (they are deeper tools, not
 * disabled features).
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BadgeCheck,
  CandlestickChart,
  CircleHelp,
  Coins,
  HandCoins,
  History,
  House,
  Images,
  Landmark,
  ListChecks,
  LoaderCircle,
  Gift,
  Menu,
  Settings,
  BookOpen,
  Droplets,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { useMode } from '../app/ModeContext';
import { ErrorBoundary } from './ErrorBoundary';
import { useActiveChain } from '../chain/useActiveChain';
import { LiveChainSync } from '../chain/LiveChainSync';
import { IndexerPushSync } from '../chain/IndexerPushSync';
import { ConnectButton } from './ConnectButton';
import { EmptyState } from './EmptyState';
import { DiagnosticsDrawer } from './DiagnosticsDrawer';
import { NetworkBanner } from './NetworkBanner';
// UX2-008 — SanctionsBanner is the shell's ONLY eager Diamond-ABI
// consumer (it reads the on-chain sanctions oracle). Loading it lazily
// keeps the ~761 kB contract-ABI chunk off a DISCONNECTED first paint
// entirely (marketing routes Home/Help): the banner returns null unless
// a connected wallet is flagged, and the oracle read is itself
// connection-gated, so a beat's delay before it can appear is
// invisible — while a connected user (who needs the ABI for reads
// anyway) pulls the chunk as before.
const SanctionsBanner = lazy(() =>
  import('./SanctionsBanner').then((m) => ({ default: m.SanctionsBanner })),
);

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  advancedOnly?: boolean;
  /** Shown only while reads target a test network (the faucet). */
  testnetOnly?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/borrow', label: 'Borrow', icon: HandCoins },
  { to: '/lend', label: 'Lend', icon: Coins },
  { to: '/rent', label: 'NFT Rental', icon: Images },
  { to: '/positions', label: 'My positions', icon: ListChecks },
  { to: '/claims', label: 'Claims', icon: Gift },
];

const SECONDARY_NAV: NavItem[] = [
  { to: '/vault', label: 'My vault', icon: Landmark },
  { to: '/faucet', label: 'Get test assets', icon: Droplets, testnetOnly: true },
  { to: '/offers', label: 'Offer Book', icon: BookOpen, advancedOnly: true },
  { to: '/desk', label: 'Rate Desk', icon: CandlestickChart, advancedOnly: true },
  { to: '/vpfi', label: 'VPFI discounts', icon: Coins, advancedOnly: true },
  { to: '/activity', label: 'Activity', icon: History, advancedOnly: true },
  // UX-032 — the trust tool for exactly the off-platform user must be
  // reachable without a deep link.
  { to: '/nft', label: 'NFT verifier', icon: BadgeCheck },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/help', label: 'Help', icon: CircleHelp },
];

/** Phone tab bar keeps only the highest-frequency destinations; the
 *  fifth slot is a real "More" menu (UX-011), not a Settings alias. */
const TABBAR: NavItem[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/borrow', label: 'Borrow', icon: HandCoins },
  { to: '/lend', label: 'Lend', icon: Coins },
  { to: '/positions', label: 'Positions', icon: ListChecks },
];

/** The phone More sheet fronts every destination without a tab of its
 *  own — the pages with tabs stay out so the sheet reads as "the rest
 *  of the product", not a second copy of the tab bar. */
const MORE_SHEET: NavItem[] = [
  { to: '/rent', label: 'NFT Rental', icon: Images },
  { to: '/claims', label: 'Claims', icon: Gift },
  ...SECONDARY_NAV,
];

/** UX-011 — the Basic/Advanced switch, persistent in the sidebar
 *  footer (desktop) and the More sheet (phones) instead of buried in
 *  Settings. Switching never navigates (ModeContext rule). */
function ModeSwitch() {
  const { mode, setMode } = useMode();
  return (
    <div className="mode-switch" role="group" aria-label="Interface mode">
      <button
        type="button"
        className={mode === 'basic' ? 'active' : ''}
        aria-pressed={mode === 'basic'}
        onClick={() => setMode('basic')}
      >
        Basic
      </button>
      <button
        type="button"
        className={mode === 'advanced' ? 'active' : ''}
        aria-pressed={mode === 'advanced'}
        onClick={() => setMode('advanced')}
      >
        Advanced
      </button>
    </div>
  );
}

export function AppShell() {
  const { isAdvanced } = useMode();
  const { readChain, isConnected, onSupportedChain, walletChain } =
    useActiveChain();
  const { pathname, search } = useLocation();
  // Phone More sheet (UX-011) — closes on any navigation.
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // UX-031 — move focus to the main content region on route change so
  // a keyboard / screen-reader user lands on the new page instead of
  // staying on the clicked nav link (SPA navigation announces nothing
  // on its own). Skipped on first render so an initial load doesn't
  // steal focus from the top of the document.
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [pathname]);

  // testnetOnly entries (the faucet) additionally require the chain's
  // deployments bundle to actually carry `testnetMocks` — an unseeded
  // testnet (e.g. a chain whose mocks haven't been deployed yet) must
  // not advertise a faucet that immediately says "not set up here".
  const hasFaucetAssets = Boolean(
    getDeployment(readChain.chainId)?.testnetMocks,
  );
  const visible = (item: NavItem) =>
    (!item.advancedOnly || isAdvanced) &&
    (!item.testnetOnly || (readChain.testnet && hasFaucetAssets));

  // On phones the "More" tab fronts every destination without a tab of
  // its own — highlight it on those pages so the user is never "nowhere".
  const moreIsActive = [
    '/rent',
    '/claims',
    '/vault',
    '/faucet',
    '/offers',
    '/desk',
    '/vpfi',
    '/activity',
    '/nft',
    '/settings',
    '/help',
  ].some((prefix) => pathname.startsWith(prefix));

  return (
    <div className="shell">
      {/* UX-031 — first focusable element: a keyboard user can jump the
          nav and land on the page content. Visually hidden until
          focused (see `.skip-link`). */}
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {/* Block-driven live refresh of transaction caches (WS push when
          configured, HTTP block-poll otherwise). Renders nothing. */}
      <LiveChainSync />
      <IndexerPushSync />
      <header className="shell-topbar">
        <NavLink to="/" className="shell-brand" style={{ textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden>
            V
          </span>
          Vaipakam
          <span className="brand-tag">alpha</span>
        </NavLink>
        <div className="shell-topbar-spacer" />
        {/* UX-013 — a persistent network indicator when connected: the
            book, vault, and faucet are all per-network, but the chain
            name otherwise lives only inside the wallet modal. Shown only
            on a supported chain; an unsupported one is handled by the
            NetworkBanner in the main region. */}
        {isConnected && onSupportedChain && walletChain ? (
          <span className="net-chip" title={`Connected to ${walletChain.name}`}>
            <span className="net-chip-dot" aria-hidden />
            <span className="net-chip-name">{walletChain.name}</span>
          </span>
        ) : null}
        <ConnectButton />
      </header>

      <div className="shell-body">
        <nav className="shell-sidenav" aria-label="Primary">
          {PRIMARY_NAV.filter(visible).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `sidenav-item ${isActive ? 'active' : ''}`
              }
            >
              <item.icon aria-hidden />
              {item.label}
            </NavLink>
          ))}
          <div className="sidenav-section">More</div>
          {SECONDARY_NAV.filter(visible).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `sidenav-item ${isActive ? 'active' : ''}`
              }
            >
              <item.icon aria-hidden />
              {item.label}
            </NavLink>
          ))}
          {/* UX-011 — the mode switch lives where the nav lives, so
              discovering Advanced never requires finding Settings. */}
          <div className="sidenav-footer">
            <ModeSwitch />
          </div>
        </nav>

        <main className="shell-main" id="main-content" tabIndex={-1} ref={mainRef}>
          <NetworkBanner />
          <Suspense fallback={null}>
            <SanctionsBanner />
          </Suspense>
          {/* Route-level crash containment: a page that throws during
              render becomes a recoverable card while the nav stays
              alive; navigating away — including to a different
              ?offer/?chain deep link on the same path — resets it. */}
          {/* UX-005 — lazy route chunks download on first visit to a
              route; the fallback reuses the spinning empty state so a
              chunk fetch reads as "loading" inside the already-painted
              shell, never a blank panel. */}
          <ErrorBoundary resetKey={pathname + search}>
            <Suspense fallback={<EmptyState icon={LoaderCircle} title="Loading…" />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      {/* Support drawer: connection health + report-a-problem, on
          every page (#1028 item 4). Fixed-positioned; probes run only
          while it is open. */}
      <DiagnosticsDrawer />

      {moreOpen ? (
        <>
          <div
            className="more-sheet-backdrop"
            onClick={() => setMoreOpen(false)}
            aria-hidden
          />
          <nav className="more-sheet" aria-label="More destinations">
            {MORE_SHEET.filter(visible).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `more-sheet-item ${isActive ? 'active' : ''}`
                }
                onClick={() => setMoreOpen(false)}
              >
                <item.icon aria-hidden />
                {item.label}
              </NavLink>
            ))}
            <div className="more-sheet-mode">
              <ModeSwitch />
            </div>
          </nav>
        </>
      ) : null}

      <nav className="shell-tabbar" aria-label="Quick navigation">
        {TABBAR.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `tabbar-item ${isActive ? 'active' : ''}`
            }
          >
            <item.icon aria-hidden />
            {item.label}
          </NavLink>
        ))}
        {/* UX-011 — a real More menu, not a Settings alias: every
            destination without a tab is one tap away. */}
        <button
          type="button"
          className={`tabbar-item ${moreOpen || moreIsActive ? 'active' : ''}`}
          aria-haspopup="true"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((o) => !o)}
        >
          <Menu aria-hidden />
          More
        </button>
      </nav>
    </div>
  );
}
