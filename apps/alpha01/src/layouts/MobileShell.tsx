import { NavLink, Outlet } from 'react-router-dom';
import { ConnectKitButton } from 'connectkit';
import { Home, ArrowDownLeft, ArrowUpRight, LayoutList, MoreHorizontal, Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useMode } from '../context/ModeContext';
import { SanctionsBanner } from '../components/SanctionsBanner';
import { WrongChainBanner } from '../components/WrongChainBanner';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/borrow', label: 'Borrow', icon: ArrowDownLeft },
  { to: '/lend', label: 'Lend', icon: ArrowUpRight },
  { to: '/positions', label: 'Positions', icon: LayoutList },
  { to: '/more', label: 'More', icon: MoreHorizontal },
] as const;

export function MobileShell() {
  const { theme, toggleTheme } = useTheme();
  const { mode } = useMode();

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-header-start">
          <NavLink to="/" className="shell-brand">
            Vaipakam
          </NavLink>
          <nav className="desktop-nav" aria-label="Primary desktop">
            {NAV.map(({ to, label, ...rest }) => (
              <NavLink key={to} to={to} {...('end' in rest ? { end: rest.end } : {})}>
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="shell-header-actions">
          <span className="shell-mode-badge">{mode === 'basic' ? 'Basic' : 'Advanced'}</span>
          <button type="button" className="btn btn-secondary btn-icon" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <ConnectKitButton />
        </div>
      </header>

      <main className="shell-main">
        <SanctionsBanner />
        <WrongChainBanner />
        <div className="page-frame">
          <Outlet />
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Primary mobile">
        {NAV.map(({ to, label, icon: Icon, ...rest }) => (
          <NavLink key={to} to={to} {...('end' in rest ? { end: rest.end } : {})}>
            {({ isActive }) => (
              <>
                <Icon size={20} className={isActive ? 'active' : undefined} />
                <span className={isActive ? 'active' : undefined}>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}