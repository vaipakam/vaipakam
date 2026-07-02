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
import { NavLink, Outlet } from 'react-router-dom';
import {
  CircleHelp,
  Coins,
  HandCoins,
  House,
  Images,
  ListChecks,
  Gift,
  Settings,
  BookOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMode } from '../app/ModeContext';
import { ConnectButton } from './ConnectButton';
import { NetworkBanner } from './NetworkBanner';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  advancedOnly?: boolean;
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
  { to: '/offers', label: 'Offer Book', icon: BookOpen, advancedOnly: true },
  { to: '/vpfi', label: 'VPFI discounts', icon: Coins, advancedOnly: true },
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

  const visible = (item: NavItem) => !item.advancedOnly || isAdvanced;

  return (
    <div className="shell">
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
        <nav className="shell-sidenav" aria-label="Main">
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
          <Outlet />
        </main>
      </div>

      <nav className="shell-tabbar" aria-label="Main">
        {TABBAR.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `tabbar-item ${isActive ? 'active' : ''}`}
          >
            <item.icon aria-hidden />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
