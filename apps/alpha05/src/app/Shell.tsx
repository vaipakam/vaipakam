import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
import { ControlIcon, PlaceIcon } from '../shared/ui/Icon';
import { OutstandingTx } from '../shared/tx/OutstandingTx';
import { NAV_ADVANCED, NAV_BASIC } from '../routes/pageMap';

/** The desktop panel's collapsed choice is remembered per browser (a
 *  convenience; nothing depends on it, and an unreadable store means open). */
const NAV_COLLAPSED_KEY = 'alpha05.navCollapsed';
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
/** Hover intent for the collapsed panel (NN/g): reveal the names after the
 *  pointer rests 300 ms, hide them once it has been away 500 ms. */
const PEEK_OPEN_MS = 300;
const PEEK_CLOSE_MS = 500;

/** How many destinations of the derived navigation the phone's bottom bar
 *  carries before More: the first ones in page-map order. */
const QUICK_DESTINATIONS = 4;

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
  // Phones (RB-A11Y: mobile first, bottom navigation on small screens): the
  // header is one row (brand and the wallet control, which is never folded,
  // because the identity every figure belongs to is never hidden), and a
  // bottom bar carries the first destinations of the same derived navigation
  // plus More, which opens every destination and the mode and theme
  // controls as a sheet. Choosing a page closes the sheet; Escape closes it
  // and returns focus to More. From 720px up the bar goes and the same
  // navigation becomes a left column under a one-row header: a rail (icon
  // above a short name) up to 1023px, a panel (icon beside the name) from
  // 1024px, with the mode and theme controls at its foot. The pages only
  // Advanced adds are grouped under their own label, after the Basic ones.
  const quick = nav.slice(0, QUICK_DESTINATIONS);
  const basicNav = nav.filter((e) => e.tier === 'basic');
  const advancedNav = nav.filter((e) => e.tier !== 'basic');
  const advancedLabel = useId();
  const navLink = (e: (typeof nav)[number]) => (
    <NavLink key={e.path} to={e.path} end={e.path === '/'} onClick={closeMenu}>
      <PlaceIcon place={e.path} />
      <span>{e.name}</span>
    </NavLink>
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const navToggle = useRef<HTMLButtonElement>(null);
  // From 1024px the panel can be collapsed to its icons (the main-menu
  // button at the left of the header; the choice remembered). While collapsed, resting a mouse on it, or
  // moving keyboard focus into it, reveals the full panel OVER the page (the
  // page does not move); leaving it, focus leaving it, or Escape hides it
  // again. Touch has no hover: the menu button is the way there.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusInside = () => !!sheet.current?.contains(document.activeElement);
  const schedulePeek = (open: boolean) => {
    clearTimeout(peekTimer.current);
    // The pointer leaving never folds a panel that holds keyboard focus
    // (folding would hide the focused control); checked again when the
    // timer fires, since focus may have moved in meanwhile.
    if (!open && focusInside()) return;
    peekTimer.current = setTimeout(() => setPeek(open || focusInside()), open ? PEEK_OPEN_MS : PEEK_CLOSE_MS);
  };
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    clearTimeout(peekTimer.current);
    setPeek(false);
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* not remembered; the panel still collapses for this visit */
    }
  };
  // From 720px the navigation column sits below the header. The header is
  // one row normally but grows when the wallet control has more to say (an
  // unsupported network and its remedy), so its measured height, not a fixed
  // figure, places the column: nothing in the header is ever covered or cut.
  useLayoutEffect(() => {
    const el = header.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--topbar-h');
    };
  }, []);
  const closeMenu = () => setMenuOpen(false);
  // Opening the sheet moves focus into it: the sheet sits earlier in the
  // document than More, so without this a keyboard user's Tab would leave
  // the page instead of reaching the destinations just revealed.
  useEffect(() => {
    if (menuOpen) sheet.current?.querySelector<HTMLElement>('nav a')?.focus();
  }, [menuOpen]);

  return (
    <div
      className="shell"
      data-nav-collapsed={collapsed}
      data-nav-peek={collapsed && peek}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menuOpen) {
          closeMenu();
          menuButton.current?.focus();
        }
        if (e.key === 'Escape' && peek) {
          // Folding hides the names and the controls; focus moves to the
          // menu button, which stays in view, so it is never left on a hidden one.
          if (focusInside()) navToggle.current?.focus();
          clearTimeout(peekTimer.current);
          setPeek(false);
        }
      }}
    >
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar" ref={header}>
        {/* From 1024px: the main-menu button, icon only, at the far left of
            the header above the panel it folds (the pattern everyday web
            apps use). Its spoken name is "Main menu" and aria-expanded says
            whether the panel shows its names; the title is the hover tip. */}
        <button
          type="button"
          ref={navToggle}
          className="nav-toggle"
          aria-label={text('shell.mainMenu')}
          title={text('shell.mainMenu')}
          aria-controls="site-menu"
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          <ControlIcon control="menu" size={24} />
        </button>
        <NavLink to="/" className="brand" aria-label="Vaipakam home">
          {/* The www brand set: the shield mark on phones, the full wordmark
              from 720px up, each in the resolved theme's colourway. The text
              is the accessible name and shows beside the mark only. */}
          <img src={resolved === 'dark' ? '/icon-dark.svg' : '/icon-light.svg'} alt="" className="brand-mark" width={28} height={28} />
          <img src={resolved === 'dark' ? '/logo-dark.png' : '/logo-light.png'} alt="" className="brand-wordmark" width={120} height={36} />
          <span className="brand-text">{text('shell.brand')}</span>
        </NavLink>
        <div
          id="site-menu"
          ref={sheet}
          className="site-menu"
          data-open={menuOpen}
          onPointerEnter={(e) => collapsed && e.pointerType === 'mouse' && schedulePeek(true)}
          onPointerLeave={(e) => collapsed && e.pointerType === 'mouse' && schedulePeek(false)}
          onFocus={() => {
            if (!collapsed) return;
            clearTimeout(peekTimer.current);
            setPeek(true);
          }}
          onBlur={(e) => {
            if (collapsed && !e.currentTarget.contains(e.relatedTarget as Node | null)) setPeek(false);
          }}
        >
          <nav aria-label="Primary">
            {basicNav.map(navLink)}
            {advancedNav.length > 0 && (
              <div className="nav-group" role="group" aria-labelledby={advancedLabel}>
                <p id={advancedLabel} className="nav-group-title">
                  {text('shell.advancedPages')}
                </p>
                {advancedNav.map(navLink)}
              </div>
            )}
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
          </div>
        </div>
        <div className="wallet-slot">
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
        <OutstandingTx />
        <Outlet />
      </div>
      <footer className="foot">
        <WhyLink summaryKey="shell.mode" detailKey="shell.modeWhy" vars={{ mode }} />
        <p className="tier-b">{format('shell.build', { hash: import.meta.env.VITE_BUILD_HASH ?? 'unknown', time: import.meta.env.VITE_BUILD_TIME ?? 'unknown' })}</p>
      </footer>
      <nav className="bottom-bar" aria-label="Quick access">
        {quick.map((e) => (
          <NavLink key={e.path} to={e.path} end={e.path === '/'} onClick={closeMenu}>
            <PlaceIcon place={e.path} />
            <span>{e.name}</span>
          </NavLink>
        ))}
        <button ref={menuButton} type="button" aria-expanded={menuOpen} aria-controls="site-menu" onClick={() => setMenuOpen((o) => !o)}>
          <PlaceIcon place="more" />
          <span>{text('shell.more')}</span>
        </button>
      </nav>
      <HelpPanel />
    </div>
  );
}
