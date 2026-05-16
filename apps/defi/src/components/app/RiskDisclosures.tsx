import { useState } from 'react';
import { AlertTriangle, BookOpen, X } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { marketingUrl } from '../../lib/marketingUrl';
import './RiskDisclosures.css';

const PARAGRAPH_KEYS: string[] = [
  'riskDisclosures.paragraph1',
  'riskDisclosures.paragraph2',
];

/**
 * Renders the consent checkbox label with "Vaipakam Terms" as an inline
 * hyperlink to the marketing-site Terms of Service page. Uses i18next
 * `<Trans>` so translators preserve the placement of the linked phrase
 * without hand-splicing strings on the JSX side. `stopPropagation` on
 * the link prevents a label-click from toggling the checkbox via the
 * wrapping `<label>` element.
 *
 * Consumers wrap the parent `<label>` + `<input>` themselves; this
 * component is only the inline text + link slot.
 */
export function RiskConsentLabel() {
  return (
    <Trans
      i18nKey="riskDisclosures.checkboxLabel"
      components={{
        terms: (
          <a
            href={marketingUrl('/terms')}
            target="_blank"
            rel="noopener noreferrer"
            className="risk-consent-terms-link"
            onClick={(e) => e.stopPropagation()}
          />
        ),
      }}
    />
  );
}

/**
 * Pure presentation component that renders the Risk-Disclosure copy
 * from i18n. Two layout pieces:
 *
 *   1. The localised disclosures (translated to the active language).
 *   2. A small notice + button that surfaces the **English original**
 *      via a modal — the legally-binding text is the English copy,
 *      and any translation is a convenience summary. On English locale
 *      the notice is hidden and the button is suppressed.
 *
 * Callers own the "I agree" checkbox state (see CreateOffer, the
 * Accept-Review modal in OfferBook, and LenderEarlyWithdrawal).
 */
export function RiskDisclosures() {
  const { t, i18n } = useTranslation();
  const [showOriginal, setShowOriginal] = useState(false);
  const isEnglish = i18n.resolvedLanguage === 'en';

  return (
    <>
      <div className="risk-disclosures" role="note">
        <div className="risk-disclosures-head">
          <AlertTriangle size={16} aria-hidden />
          <span>{t('riskDisclosures.title')}</span>
        </div>

        {!isEnglish && (
          <div
            className="alert alert-info"
            style={{
              margin: '8px 0 12px',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              fontSize: '0.82rem',
            }}
          >
            <BookOpen size={14} style={{ flex: '0 0 auto', marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <span>{t('riskDisclosuresNotice.translatedSummary')}</span>{' '}
              <button
                type="button"
                onClick={() => setShowOriginal(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--brand)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {t('riskDisclosuresNotice.viewEnglishOriginal')}
              </button>
            </div>
          </div>
        )}

        {PARAGRAPH_KEYS.map((key, i) => (
          <p key={i} className="risk-disclosures-paragraph">
            {t(key)}
          </p>
        ))}

        <p className="risk-disclosures-learn-more">
          {/*
            Pin the explicit `/en` locale prefix. The marketing app's
            `DefaultLocaleRedirect` bounces an unprefixed `/help/advanced`
            to `/<locale>/help/advanced` for first-time visitors with a
            non-English browser locale — but the localized Advanced
            guides (`Advanced.de.md`, `.fr.md`, …) do not yet carry the
            `liquidation-mechanics.*` anchors (translation is tracked
            under EC-004 #13). An already-locale-prefixed path is left
            untouched by the redirect, so `/en/help/advanced` reliably
            renders `Advanced.en.md`, which has the anchors. Switch this
            back to a locale-aware `/help/advanced` once EC-004 adds the
            section + anchors to every localized guide.
          */}
          <a
            href={marketingUrl('/en/help/advanced#liquidation-mechanics.case-1')}
            target="_blank"
            rel="noopener noreferrer"
            className="risk-consent-terms-link"
          >
            {t('riskDisclosures.learnMoreLabel')}
          </a>
        </p>
      </div>

      {showOriginal && <EnglishOriginalModal onClose={() => setShowOriginal(false)} />}
    </>
  );
}

/**
 * Modal that renders the English-original Risk Disclosures regardless
 * of the active locale. Uses a fixed `lng: 'en'` lookup so the same
 * keys render in English even when the surrounding page is in (e.g.)
 * Tamil. Closed by clicking the backdrop, the X button, or pressing
 * Escape on the close button.
 */
function EnglishOriginalModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const en = (key: string) => t(key, { lng: 'en' });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('riskDisclosuresNotice.englishOriginalTitle')}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card, #1a1c25)',
          color: 'var(--text-primary)',
          borderRadius: 10,
          maxWidth: 640,
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: '20px 22px',
          border: '1px solid var(--border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <strong style={{ fontSize: '1.05rem' }}>
            {t('riskDisclosuresNotice.englishOriginalTitle')}
          </strong>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('riskDisclosuresNotice.closeModal')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              opacity: 0.75,
              padding: 4,
            }}
          >
            <X size={18} />
          </button>
        </div>
        <div className="risk-disclosures" role="note" lang="en" style={{ border: 'none', padding: 0 }}>
          <div className="risk-disclosures-head">
            <AlertTriangle size={16} aria-hidden />
            <span>{en('riskDisclosures.title')}</span>
          </div>
          {PARAGRAPH_KEYS.map((key, i) => (
            <p key={i} className="risk-disclosures-paragraph">
              {en(key)}
            </p>
          ))}
        </div>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            {t('riskDisclosuresNotice.closeModal')}
          </button>
        </div>
      </div>
    </div>
  );
}
