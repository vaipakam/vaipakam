import { useTranslation } from 'react-i18next';
import { normalizeToSupportedLocale } from '@vaipakam/i18n/createI18n';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { LOCALE_DISPLAY_CONFIG, TRANSLATED_LOCALES } from '../../i18n/localeConfig';
import { useMode } from '../../app/ModeContext';
import { useTheme, type ThemePreference } from '../../app/ThemeContext';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { FeeDiscountConsent } from '../../shared/consent/FeeDiscountConsent';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { fingerprint, PRIVACY_URL, termsUrl } from '../../shared/terms/terms';
import { useTerms } from '../../shared/terms/useTerms';
import { formatUtc } from '../../shared/ui/format';
import { DataRights } from './DataRights';

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const THEME_KEY = { system: 'settings.themeSystem', light: 'settings.themeLight', dark: 'settings.themeDark' } as const;

/** The languages the picker offers, in the shared display order; a language
 *  whose translation is not finished is offered and then shows English
 *  (RB-A11Y), so the page says which ones are translated. */
const LANGUAGES = Object.values(LOCALE_DISPLAY_CONFIG).filter((l) => l.visible);

/**
 * Settings (#3180; ACC-06, ACC-13, ACC-14, ACC-15 status, ACC-35, ACC-61;
 * RB-SETTINGS). One page for what the reader sets once: the mode, the theme
 * and the language, which need no wallet; then, for a connected wallet, the
 * Terms it has accepted on this network, the fee-discount consent, and where
 * alerts are set. What this build does with the reader's data is stated, and
 * the reader can download the app's records or erase everything this site
 * keeps (ACC-55, `DataRights`).
 */
export function SettingsPage() {
  const { text, format } = useCopy();
  const { mode, setMode } = useMode();
  const { preference, resolved, setPreference } = useTheme();
  const { i18n } = useTranslation();
  const { status } = useAccount();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  // The reader's choice, not the language the text renders in: a choice not
  // translated yet renders English (and keeps `<html lang="en">`).
  const current = normalizeToSupportedLocale(i18n.language);
  const translated = TRANSLATED_LOCALES.includes(current);

  return (
    <main className="page settings" aria-labelledby="settings-title">
      <h1 id="settings-title">{text('settings.title')}</h1>

      <section className="home-section" aria-labelledby="settings-display" data-testid="settings-display">
        <h2 id="settings-display">{text('settings.displayTitle')}</h2>
        <p className="tier-b">{text('settings.displayLead')}</p>

        <fieldset className="settings-row" data-testid="settings-mode">
          <legend>{text('settings.modeTitle')}</legend>
          <div className="segment" role="group" aria-label={text('settings.modeTitle')}>
            <button type="button" aria-pressed={mode === 'basic'} onClick={() => setMode('basic')}>
              {text('shell.modeBasic')}
            </button>
            <button type="button" aria-pressed={mode === 'advanced'} onClick={() => setMode('advanced')}>
              {text('shell.modeAdvanced')}
            </button>
          </div>
          <p className="tier-b">{text(mode === 'advanced' ? 'settings.modeAdvanced' : 'settings.modeBasic')}</p>
          <WhyLink summaryKey="settings.modeWhySummary" detailKey="shell.modeWhy" />
        </fieldset>

        <fieldset className="settings-row" data-testid="settings-theme">
          <legend>{text('settings.themeTitle')}</legend>
          <div className="segment" role="group" aria-label={text('settings.themeTitle')}>
            {THEMES.map((t) => (
              <button key={t} type="button" aria-pressed={preference === t} onClick={() => setPreference(t)} data-testid={`settings-theme-${t}`}>
                {text(THEME_KEY[t])}
              </button>
            ))}
          </div>
          <p className="tier-b" data-testid="settings-theme-state">
            {preference === 'system'
              ? format('settings.themeFollows', { theme: text(THEME_KEY[resolved]) })
              : format('settings.themeChosen', { theme: text(THEME_KEY[preference]) })}
          </p>
        </fieldset>

        <fieldset className="settings-row" data-testid="settings-language">
          <legend>{text('settings.languageTitle')}</legend>
          <label className="select">
            <span className="sr-only">{text('settings.languageTitle')}</span>
            <select value={current} onChange={(e) => void i18n.changeLanguage(e.target.value)} data-testid="settings-language-select">
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} lang={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <p className="tier-b" data-testid="settings-language-state">
            {text(translated ? 'settings.languageTranslated' : 'settings.languageEnglish')}
          </p>
          <p className="tier-b">{text('settings.languageStored')}</p>
        </fieldset>
      </section>

      <section className="home-section" aria-labelledby="settings-legal" data-testid="settings-legal">
        <h2 id="settings-legal">{text('settings.legalTitle')}</h2>
        {status !== 'connected' && <p className="tier-b">{text('settings.legalConnect')}</p>}
        {status === 'connected' && chain === null && <p className="tier-b">{text('settings.unsupportedChain')}</p>}
        {own && chain && <TermsStatus chainName={chain.name} />}
        <p className="tier-b">
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            {text('terms.privacy')}
          </a>
        </p>
      </section>

      {own && chain && (
        <section className="home-section" aria-labelledby="settings-fees" data-testid="settings-fees">
          <h2 id="settings-fees">{text('settings.feesTitle')}</h2>
          <FeeDiscountConsent />
        </section>
      )}

      <section className="home-section" aria-labelledby="settings-alerts" data-testid="settings-alerts">
        <h2 id="settings-alerts">{text('settings.alertsTitle')}</h2>
        <p className="tier-b">{text('settings.alertsLead')}</p>
        <Link className="btn" to="/alerts">
          {text('settings.alertsOpen')}
        </Link>
      </section>

      <section className="home-section" aria-labelledby="settings-privacy" data-testid="settings-privacy">
        <h2 id="settings-privacy">{text('settings.privacyTitle')}</h2>
        <p className="tier-b" data-testid="settings-diagnostics">
          {text('settings.diagnosticsNone')}
        </p>
        <p className="tier-b">{text('settings.storedHere')}</p>
        <WhyLink summaryKey="settings.privacyWhySummary" detailKey="settings.privacyWhy" />
      </section>

      <DataRights />
    </main>
  );
}

/** The Terms state on this network (ACC-15, `Settings › Legal`): none in
 *  force, accepted (with the version and its fingerprint), or not accepted
 *  yet, which is asked at the first action that needs it, never here. A read
 *  that failed says it could not confirm, which is not "not accepted". */
function TermsStatus({ chainName }: { chainName: string }) {
  const { text, format } = useCopy();
  const terms = useTerms();
  if (terms.state === 'reading' || terms.state === 'no-identity') return <p className="tier-b">{format('settings.legalReading', { chain: chainName })}</p>;
  if (terms.data === null) {
    return (
      <div data-testid="settings-terms" data-terms="unknown">
        <p className="tier-a">{format('settings.legalUnknown', { chain: chainName, reason: terms.error ?? '' })}</p>
        <button type="button" className="btn" onClick={terms.refetch}>
          {text('settings.retry')}
        </button>
      </div>
    );
  }
  const t = terms.data;
  return (
    <div data-testid="settings-terms" data-terms={t.kind}>
      {t.kind === 'none' && <p className="tier-b">{format('settings.legalNone', { chain: chainName })}</p>}
      {t.kind === 'accepted' && (
        <p className="tier-b">{format('settings.legalAccepted', { chain: chainName, version: String(t.version), fingerprint: fingerprint(t.hash) })}</p>
      )}
      {t.kind === 'needed' && (
        <>
          <p className="tier-b">{format('settings.legalNeeded', { chain: chainName, version: String(t.version), fingerprint: fingerprint(t.hash) })}</p>
          <p className="tier-b">{text('settings.legalNeededWhen')}</p>
          {t.previous && (
            <p className="tier-b">{format('terms.newer', { previous: String(t.previous.version), when: formatUtc(t.previous.acceptedAt) })}</p>
          )}
        </>
      )}
      {t.kind !== 'none' && (
        <p className="tier-b">
          <a href={termsUrl(t.version)} target="_blank" rel="noreferrer">
            {format('terms.read', { version: String(t.version) })}
          </a>
        </p>
      )}
      {terms.error !== null && <p className="tier-b">{format('settings.legalStale', { reason: terms.error })}</p>}
    </div>
  );
}
