import { useState } from 'react';
import { AlertTriangle, BookOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './RiskDisclosures.css';

const KEYS: Array<{ heading: string; points: string[] }> = [
  {
    heading: 'riskDisclosures.section1Heading',
    points: [
      'riskDisclosures.section1Point1',
      'riskDisclosures.section1Point2',
      'riskDisclosures.section1Point3',
    ],
  },
  {
    heading: 'riskDisclosures.section2Heading',
    points: [
      'riskDisclosures.section2Point1',
      'riskDisclosures.section2Point2',
      'riskDisclosures.section2Point3',
    ],
  },
  {
    heading: 'riskDisclosures.section3Heading',
    points: ['riskDisclosures.section3Point1', 'riskDisclosures.section3Point2'],
  },
];

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

        {KEYS.map((section, i) => (
          <section key={i} className="risk-disclosures-section">
            <h4 className="risk-disclosures-heading">{t(section.heading)}</h4>
            <ol className="risk-disclosures-points">
              {section.points.map((p, j) => (
                <li key={j}>{t(p)}</li>
              ))}
            </ol>
          </section>
        ))}
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
          {KEYS.map((section, i) => (
            <section key={i} className="risk-disclosures-section">
              <h4 className="risk-disclosures-heading">{en(section.heading)}</h4>
              <ol className="risk-disclosures-points">
                {section.points.map((p, j) => (
                  <li key={j}>{en(p)}</li>
                ))}
              </ol>
            </section>
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
