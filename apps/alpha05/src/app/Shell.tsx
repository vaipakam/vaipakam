import { NavLink, Outlet } from 'react-router-dom';
import { useMode } from './ModeContext';
import { useTheme } from './ThemeContext';
import { useCapabilities } from '../shared/capability/CapabilityContext';
import { WhyLink } from '../shared/help/WhyLink';
import { copy } from '../content/copy';
import { NAV_ADVANCED, NAV_BASIC, PAGES } from '../routes/pageMap';

const GUIDE_BASE = 'https://vaipakam.com/guide';

/**
 * The shell: brand, mode toggle, theme toggle, primary navigation by mode,
 * the deployment-posture line (RB-RAILS, RB-FUNDS: the capability read is
 * stated as reading, read or unreadable, never implied), and the routed
 * page. The wallet control lands with the Home PR, where the first
 * connected read is.
 */
export function Shell() {
  const { mode, setMode, isAdvanced } = useMode();
  const { preference, setPreference } = useTheme();
  const { caps, stale, chainId, error } = useCapabilities();
  const nav = (isAdvanced ? NAV_ADVANCED : NAV_BASIC).map((p) => PAGES.find((e) => e.path === p)!);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Vaipakam home">
          <span className="badge">V</span> {copy.shell.brand.text}
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
              {copy.shell.modeBasic.text}
            </button>
            <button type="button" aria-pressed={mode === 'advanced'} onClick={() => setMode('advanced')}>
              {copy.shell.modeAdvanced.text}
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
        </div>
      </header>
      <div className="notice tier-a" role="status">
        {copy.shell.underConstruction.text}
      </div>
      <div className="posture">
        {error ? (
          <p className="tier-a">{copy.capability.unreadable.text}</p>
        ) : caps === null ? (
          <p className="tier-b">{copy.capability.reading.text}</p>
        ) : (
          <WhyLink
            summary={{
              tier: 'B',
              text: `Chain ${chainId}: ${caps.routedSelectors?.size ?? 0} routed functions read from the protocol contract${stale ? ' (re-reading now)' : ''}.`,
            }}
            detail={copy.capability.why}
            guideBase={GUIDE_BASE}
          />
        )}
      </div>
      <div id="main">
        <Outlet />
      </div>
      <footer className="foot">
        <WhyLink summary={{ tier: 'B', text: `Mode: ${mode}.` }} detail={copy.shell.modeWhy} guideBase={GUIDE_BASE} />
        <p className="tier-b">
          Build {import.meta.env.VITE_BUILD_HASH ?? 'unknown'} · {import.meta.env.VITE_BUILD_TIME ?? 'unknown'}
        </p>
      </footer>
    </div>
  );
}
