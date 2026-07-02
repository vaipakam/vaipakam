import { NavLink, Outlet } from 'react-router-dom';
import { ConnectKitButton } from 'connectkit';
import { Home, ArrowDownLeft, ArrowUpRight, LayoutList, MoreHorizontal, Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useMode } from '../context/ModeContext';

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
        <div className="shell-brand">Vaipakam</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {mode === 'basic' ? 'Basic' : 'Advanced'}
          </span>
          <button type="button" className="btn btn-secondary" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <ConnectKitButton />
        </div>
      </header>

      <main className="shell-main">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="Primary">
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