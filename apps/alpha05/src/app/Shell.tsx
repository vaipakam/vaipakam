import { NavLink, Outlet } from 'react-router-dom';
import { useMode } from './ModeContext';
import { useTheme } from './ThemeContext';
import { IdentityLine, WalletControl } from './WalletControl';
import { useCapabilities } from '../shared/capability/CapabilityContext';
import { useCopy } from '../shared/copy/useCopy';
import { HelpPanel } from '../shared/help/HelpPanel';
import { WhyLink } from '../shared/help/WhyLink';
import { useWorldRail } from '../shared/reads/world/WorldRailContext';
import { FreshnessStamp } from '../shared/ui/FreshnessStamp';
import { NAV_ADVANCED, NAV_BASIC } from '../routes/pageMap';

/**
 * The shell: brand, mode toggle, theme toggle, the wallet control, primary
 * navigation by mode, the deployment-posture lines (RB-RAILS, RB-FUNDS:
 * the capability read and the index's freshness are stated as reading,
 * read or unreadable, never implied), the routed page, and the one help
 * panel every "Why?" opens.
 */
export function Shell() {
  const { mode, setMode, isAdvanced } = useMode();
  const { preference, resolved, setPreference } = useTheme();
  const { caps, stale, chainId, error } = useCapabilities();
  const world = useWorldRail();
  const { text, format } = useCopy();
  const nav = isAdvanced ? NAV_ADVANCED : NAV_BASIC;

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Vaipakam home">
          {/* The www brand set: the shield mark on phones, the full wordmark
              from 720px up, each in the resolved theme's colourway. The text
              is the accessible name and shows beside the mark only. */}
          <img src={resolved === 'dark' ? '/icon-dark.svg' : '/icon-light.svg'} alt="" className="brand-mark" width={28} height={28} />
          <img src={resolved === 'dark' ? '/logo-dark.png' : '/logo-light.png'} alt="" className="brand-wordmark" width={120} height={36} />
          <span className="brand-text">{text('shell.brand')}</span>
        </NavLink>
        <nav aria-label="Primary">
          {nav.map((e) => (
            <NavLink key={e.path} to={e.path} end={e.path === '/'}>
              {e.name}
            </NavLink>
          ))}
        </nav>
        <div className="controls">
          <div className="segment" role="group" aria-label="Mode">
            <button type="button" aria-pressed={mode === 'basic'} onClick={() => setMode('basic')}>
              {text('shell.modeBasic')}
            </button>
            <button type="button" aria-pressed={mode === 'advanced'} onClick={() => setMode('advanced')}>
              {text('shell.modeAdvanced')}
            </button>
          </div>
          <label className="select">
            <span className="sr-only">Theme</span>
            <select value={preference} onChange={(e) => setPreference(e.target.value as typeof preference)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <WalletControl />
        </div>
      </header>
      <div className="notice tier-a" role="status">
        {text('shell.underConstruction')}
      </div>
      <div className="posture">
        <IdentityLine />
        {error ? (
          <p className="tier-a">{text('capability.unreadable')}</p>
        ) : caps === null ? (
          <p className="tier-b">{text('capability.reading')}</p>
        ) : (
          <WhyLink
            summaryKey="capability.routed"
            detailKey="capability.why"
            vars={{ chain: String(chainId), count: String(caps.routedSelectors?.size ?? 0) }}
            extra={stale ? text('capability.rereading') : undefined}
          />
        )}
        <div className="stamp-row">
          <FreshnessStamp freshness={world.freshness} push={world.push.state} onRefresh={world.refresh} />
          <WhyLink summaryKey="rail.source" detailKey="rail.why" />
        </div>
      </div>
      <div id="main">
        <Outlet />
      </div>
      <footer className="foot">
        <WhyLink summaryKey="shell.mode" detailKey="shell.modeWhy" vars={{ mode }} />
        <p className="tier-b">{format('shell.build', { hash: import.meta.env.VITE_BUILD_HASH ?? 'unknown', time: import.meta.env.VITE_BUILD_TIME ?? 'unknown' })}</p>
      </footer>
      <HelpPanel />
    </div>
  );
}
