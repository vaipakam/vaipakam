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
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  CircleHelp,
  Coins,
  HandCoins,
  History,
  House,
  Images,
  Landmark,
  ListChecks,
  Gift,
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
import { NetworkBanner } from './NetworkBanner';
import { SanctionsBanner } from './SanctionsBanner';

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
  { to: '/vpfi', label: 'VPFI discounts', icon: Coins, advancedOnly: true },
  { to: '/activity', label: 'Activity', icon: History, advancedOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/help', label: 'Help', icon: CircleHelp },
];

/** Phone tab bar keeps only the highest-frequency destinations. */
const TABBAR: NavItem[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/borrow', label: 'Borrow', icon: HandCoins },
  { to: '/lend', label: 'Lend', icon: Coins },
  { to: '/positions', label: 'Positions', icon: ListChecks },
  { to: '/settings', label: 'More', icon: Settings },
];

export function AppShell() {
  const { isAdvanced } = useMode();
  const { readChain } = useActiveChain();
  const { pathname } = useLocation();

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
    '/claims',
    '/vault',
    '/offers',
    '/vpfi',
    '/activity',
    '/help',
  ].some((prefix) => pathname.startsWith(prefix));

  return (
    <div className="shell">
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
        </nav>

        <main className="shell-main">
          <NetworkBanner />
          <SanctionsBanner />
          {/* Route-level crash containment: a page that throws during
              render becomes a recoverable card while the nav stays
              alive; navigating away resets it (resetKey). */}
          <ErrorBoundary resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <nav className="shell-tabbar" aria-label="Quick navigation">
        {TABBAR.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `tabbar-item ${
                isActive || (item.to === '/settings' && moreIsActive)
                  ? 'active'
                  : ''
              }`
            }
          >
            <item.icon aria-hidden />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
