import { useEffect, useState } from 'react';
import { X, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import {
  ALL_DENIED,
  ALL_GRANTED,
  CONSENT_OPEN_EVENT,
  applyConsent,
  getStoredConsent,
  saveConsent,
  type ConsentChoice,
} from '../lib/consent';
import './ConsentBanner.css';

type Toggles = Omit<ConsentChoice, 'updatedAt' | 'version'>;

/**
 * Consent banner — Google Consent Mode v2 compatible.
 *
 * Behaviour:
 *   - On first load with no stored choice, the banner slides up.
 *   - Accept / Reject buttons are equally prominent (EU requirement).
 *   - "Customize" expands granular toggles; "Save my choices" persists
 *     whatever combination the user dialled in.
 *   - Any existing choice is re-applied on mount so the `index.html`
 *     denied-by-default state matches the user's last decision.
 *   - Listens for the `vaipakam:consent:open` CustomEvent so the Footer
 *     "Cookie settings" link can re-open it without prop drilling.
 */
export default function ConsentBanner() {
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [toggles, setToggles] = useState<Toggles>(ALL_DENIED);

  // On mount: re-apply any stored choice. If nothing's stored, open the
  // banner so the user can make a fresh decision. The inline `<head>`
  // defaults leave everything denied until this runs.
  useEffect(() => {
    const stored = getStoredConsent();
    if (stored) {
      const { ...categories } = stored;
      const applied: Toggles = {
        ad_storage: categories.ad_storage,
        ad_user_data: categories.ad_user_data,
        ad_personalization: categories.ad_personalization,
        analytics_storage: categories.analytics_storage,
        personalization_storage: categories.personalization_storage,
      };
      applyConsent(applied);
      setToggles(applied);
    } else {
      setOpen(true);
    }
  }, []);

  // Re-open handler for the Footer link / anywhere else in the app.
  useEffect(() => {
    const onOpen = () => {
      const stored = getStoredConsent();
      if (stored) {
        setToggles({
          ad_storage: stored.ad_storage,
          ad_user_data: stored.ad_user_data,
          ad_personalization: stored.ad_personalization,
          analytics_storage: stored.analytics_storage,
          personalization_storage: stored.personalization_storage,
        });
      }
      setCustomizing(true);
      setOpen(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
  }, []);

  if (!open) return null;

  const commit = (next: Toggles) => {
    saveConsent(next);
    applyConsent(next);
    setToggles(next);
    setOpen(false);
    setCustomizing(false);
  };

  const handleAcceptAll = () => commit(ALL_GRANTED);
  const handleRejectAll = () => commit(ALL_DENIED);
  const handleSaveCustom = () => commit(toggles);

  const toggleCategory = (key: keyof Toggles) => {
    setToggles((t) => ({
      ...t,
      [key]: t[key] === 'granted' ? 'denied' : 'granted',
    }));
  };

  return (
    <div
      className="consent-banner"
      role="dialog"
      aria-modal="false"
      aria-labelledby="consent-banner-title"
    >
      <div className="consent-banner-inner">
        <button
          type="button"
          className="consent-banner-close"
          aria-label="Dismiss — we'll ask again next visit"
          onClick={() => setOpen(false)}
        >
          <X size={16} />
        </button>

        <div className="consent-banner-head">
          <div className="consent-banner-icon">
            <Shield size={20} />
          </div>
          <div>
            <h2 id="consent-banner-title" className="consent-banner-title">
              Your privacy choices
            </h2>
            <p className="consent-banner-body">
              We use cookies and similar technologies to run essential parts of
              the app (session state, anti-abuse) and — with your permission —
              to understand how Vaipakam is used so we can improve it. You can
              change your choice at any time from the "Cookie settings" link in
              the footer.
            </p>
          </div>
        </div>

        {customizing && (
          <div className="consent-banner-details">
            <CategoryRow
              label="Essential"
              description="Required for the app to function — session state, wallet connection, anti-abuse. Cannot be disabled."
              value="granted"
              disabled
            />
            <CategoryRow
              label="Analytics"
              description="Anonymous usage stats that help us understand which features matter and where flows break."
              value={toggles.analytics_storage}
              onToggle={() => toggleCategory('analytics_storage')}
            />
            <CategoryRow
              label="Personalization"
              description="Remembers UI preferences across visits (beyond the essentials)."
              value={toggles.personalization_storage}
              onToggle={() => toggleCategory('personalization_storage')}
            />
            <CategoryRow
              label="Advertising"
              description="Ad measurement and targeting. Vaipakam does not currently serve ads, but this covers any future ad-measurement pixels."
              value={toggles.ad_storage}
              onToggle={() => {
                const next = toggles.ad_storage === 'granted' ? 'denied' : 'granted';
                setToggles((t) => ({
                  ...t,
                  ad_storage: next,
                  ad_user_data: next,
                  ad_personalization: next,
                }));
              }}
            />
          </div>
        )}

        <div className="consent-banner-actions">
          <button
            type="button"
            className="consent-banner-btn consent-banner-btn--secondary"
            onClick={handleRejectAll}
          >
            Reject all
          </button>

          <button
            type="button"
            className="consent-banner-btn consent-banner-btn--ghost"
            onClick={() => setCustomizing((v) => !v)}
            aria-expanded={customizing}
          >
            Customize
            {customizing ? (
              <ChevronUp size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </button>

          {customizing ? (
            <button
              type="button"
              className="consent-banner-btn consent-banner-btn--primary"
              onClick={handleSaveCustom}
            >
              Save my choices
            </button>
          ) : (
            <button
              type="button"
              className="consent-banner-btn consent-banner-btn--primary"
              onClick={handleAcceptAll}
            >
              Accept all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface CategoryRowProps {
  label: string;
  description: string;
  value: 'granted' | 'denied';
  onToggle?: () => void;
  disabled?: boolean;
}

function CategoryRow({
  label,
  description,
  value,
  onToggle,
  disabled,
}: CategoryRowProps) {
  const granted = value === 'granted';
  return (
    <div className="consent-category">
      <div className="consent-category-text">
        <div className="consent-category-label">{label}</div>
        <div className="consent-category-desc">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={granted}
        aria-label={`${label}: ${granted ? 'on' : 'off'}`}
        className={`consent-switch ${granted ? 'consent-switch--on' : ''} ${
          disabled ? 'consent-switch--disabled' : ''
        }`}
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
      >
        <span className="consent-switch-thumb" />
      </button>
    </div>
  );
}
