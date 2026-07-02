/**
 * Settings — theme, Basic/Advanced mode, and the secondary
 * destinations that don't earn a phone tab of their own.
 * Mode switching never navigates (Journey H1): the user returns to
 * whatever page they were on with advanced controls revealed.
 */
import { Link } from 'react-router-dom';
import {
  BookOpen,
  CircleHelp,
  Coins,
  Gift,
  History,
  Landmark,
  Moon,
  MonitorCog,
  Sun,
} from 'lucide-react';
import { useTheme, type ThemePreference } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function Settings() {
  const { preference, setPreference } = useTheme();
  const { mode, setMode } = useMode();

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-lede">Appearance, experience level, and more.</p>
      </div>

      <section className="card">
        <div className="card-title">
          {preference === 'dark' ? <Moon aria-hidden /> : preference === 'light' ? <Sun aria-hidden /> : <MonitorCog aria-hidden />}
          <h2 style={{ margin: 0 }}>Theme</h2>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={preference === opt.value}
              className={preference === opt.value ? 'active' : ''}
              onClick={() => setPreference(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-title">
          <BookOpen aria-hidden />
          <h2 style={{ margin: 0 }}>Experience level</h2>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Experience level">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'basic'}
            className={mode === 'basic' ? 'active' : ''}
            onClick={() => setMode('basic')}
          >
            Basic
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'advanced'}
            className={mode === 'advanced' ? 'active' : ''}
            onClick={() => setMode('advanced')}
          >
            Advanced
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Basic keeps every screen to the essentials. Advanced reveals more
          controls and market detail on the same pages — the rules of the
          protocol are identical in both.
        </p>
      </section>

      <section className="card">
        <div className="card-title">
          <Gift aria-hidden />
          <h2 style={{ margin: 0 }}>More</h2>
        </div>
        <div className="row-list">
          <Link to="/claims" className="item-row">
            <Gift aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">Claim Center</span>
              <br />
              <span className="row-sub">Collect repayments, collateral, and rewards</span>
            </span>
          </Link>
          <Link to="/offers" className="item-row">
            <BookOpen aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">Offer Book</span>
              <br />
              <span className="row-sub">Browse every open offer on this network</span>
            </span>
          </Link>
          <Link to="/vault" className="item-row">
            <Landmark aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">Your Vaipakam Vault</span>
              <br />
              <span className="row-sub">Where your assets sit — totals, locked, and free</span>
            </span>
          </Link>
          <Link to="/vpfi" className="item-row">
            <Coins aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">VPFI fee discounts</span>
              <br />
              <span className="row-sub">Optional — reduce protocol fees by holding VPFI</span>
            </span>
          </Link>
          <Link to="/activity" className="item-row">
            <History aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">Activity</span>
              <br />
              <span className="row-sub">Everything your wallet has done on Vaipakam</span>
            </span>
          </Link>
          <Link to="/help" className="item-row">
            <CircleHelp aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">Help</span>
              <br />
              <span className="row-sub">Plain-language answers and build info</span>
            </span>
          </Link>
        </div>
      </section>
    </div>
  );
}
