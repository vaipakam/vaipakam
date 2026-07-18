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
  Languages,
  Moon,
  MonitorCog,
  Sun,
} from 'lucide-react';
import { useTheme, type ThemePreference } from '../app/ThemeContext';
import { useMode } from '../app/ModeContext';
import { KeeperSettingsCard } from '../components/KeeperSettingsCard';
import { ApprovalsCard } from '../components/ApprovalsCard';
import { AlertsCard } from '../components/AlertsCard';
import { LanguagePicker } from '../components/LanguagePicker';
import { LANGUAGE_PICKER_ENABLED } from '../i18n/localeConfig';
import { copy } from '../content/copy';

export function Settings() {
  const { preference, setPreference } = useTheme();
  const { mode, setMode, isAdvanced } = useMode();

  // Theme labels resolve through the copy proxy in render scope — a
  // module-level read would bake in English and miss locale switches
  // (see src/i18n/reactiveCopy.ts).
  const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
    { value: 'light', label: copy.settingsPage.theme.light },
    { value: 'dark', label: copy.settingsPage.theme.dark },
    { value: 'system', label: copy.settingsPage.theme.system },
  ];

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.settingsPage.title}</h1>
        <p className="page-lede">{copy.settingsPage.lede}</p>
      </div>

      <section className="card">
        <div className="card-title">
          {preference === 'dark' ? <Moon aria-hidden /> : preference === 'light' ? <Sun aria-hidden /> : <MonitorCog aria-hidden />}
          <h2 style={{ margin: 0 }}>{copy.settingsPage.theme.title}</h2>
        </div>
        <div
          className="segmented"
          role="radiogroup"
          aria-label={copy.settingsPage.theme.title}
        >
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

      {LANGUAGE_PICKER_ENABLED ? (
        <section className="card">
          <div className="card-title">
            <Languages aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.chrome.settings.language}</h2>
          </div>
          <LanguagePicker />
          <p className="muted" style={{ marginTop: 12 }}>
            {copy.chrome.settings.languageHint}
          </p>
        </section>
      ) : null}

      <section className="card">
        <div className="card-title">
          <BookOpen aria-hidden />
          <h2 style={{ margin: 0 }}>{copy.settingsPage.experience.title}</h2>
        </div>
        <div
          className="segmented"
          role="radiogroup"
          aria-label={copy.settingsPage.experience.title}
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'basic'}
            className={mode === 'basic' ? 'active' : ''}
            onClick={() => setMode('basic')}
          >
            {copy.settingsPage.experience.basic}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'advanced'}
            className={mode === 'advanced' ? 'active' : ''}
            onClick={() => setMode('advanced')}
          >
            {copy.settingsPage.experience.advanced}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          {copy.settingsPage.experience.hint}
        </p>
      </section>

      <AlertsCard />

      {isAdvanced ? <KeeperSettingsCard /> : null}
      {isAdvanced ? <ApprovalsCard /> : null}

      <section className="card">
        <div className="card-title">
          <Gift aria-hidden />
          <h2 style={{ margin: 0 }}>{copy.settingsPage.more.title}</h2>
        </div>
        <div className="row-list">
          <Link to="/claims" className="item-row">
            <Gift aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">{copy.chrome.nav.claims}</span>
              <br />
              <span className="row-sub">{copy.settingsPage.more.claimsSub}</span>
            </span>
          </Link>
          <Link to="/offers" className="item-row">
            <BookOpen aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">{copy.chrome.nav.offers}</span>
              <br />
              <span className="row-sub">{copy.settingsPage.more.offersSub}</span>
            </span>
          </Link>
          <Link to="/vault" className="item-row">
            <Landmark aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">{copy.chrome.nav.vault}</span>
              <br />
              <span className="row-sub">{copy.settingsPage.more.vaultSub}</span>
            </span>
          </Link>
          <Link to="/vpfi" className="item-row">
            <Coins aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">{copy.chrome.nav.vpfi}</span>
              <br />
              <span className="row-sub">{copy.settingsPage.more.vpfiSub}</span>
            </span>
          </Link>
          <Link to="/activity" className="item-row">
            <History aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">{copy.chrome.nav.activity}</span>
              <br />
              <span className="row-sub">{copy.settingsPage.more.activitySub}</span>
            </span>
          </Link>
          <Link to="/help" className="item-row">
            <CircleHelp aria-hidden size={18} />
            <span className="row-main">
              <span className="row-title">{copy.chrome.nav.help}</span>
              <br />
              <span className="row-sub">{copy.settingsPage.more.helpSub}</span>
            </span>
          </Link>
        </div>
      </section>
    </div>
  );
}
