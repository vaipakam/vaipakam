/**
 * Consent state — persisted in localStorage and applied to Google Consent
 * Mode v2 via `gtag('consent', 'update', ...)`. The inline `<head>` block
 * in `index.html` sets all tracking categories to `denied` before the
 * gtag loader runs; this module is what flips them back on after the
 * user makes a choice in the banner.
 *
 * Only the five tracking categories are surfaced to the user; the two
 * essential categories (`functionality_storage`, `security_storage`) are
 * permanently granted in the inline defaults and never shown as a toggle
 * — they cover session state and anti-abuse, not marketing.
 *
 * GDPR / ePrivacy contract:
 *   - No tracking cookies fire before the user clicks Accept / Customize.
 *   - Reject all is as prominent as Accept all in the UI.
 *   - A revocation path exists via the Footer "Cookie settings" link
 *     (dispatches the `vaipakam:consent:open` event this module listens
 *     for via the ConsentBanner component, re-opening the banner).
 */

export type ConsentValue = 'granted' | 'denied';

export interface ConsentChoice {
  ad_storage: ConsentValue;
  ad_user_data: ConsentValue;
  ad_personalization: ConsentValue;
  analytics_storage: ConsentValue;
  personalization_storage: ConsentValue;
  /** ISO timestamp of when the user made this choice. Used to detect
   *  stale choices if the banner policy version ever changes. */
  updatedAt: string;
  /** Schema version of the choice — bump to force-reprompt users when
   *  consent categories change. */
  version: number;
}

export const CONSENT_STORAGE_KEY = 'vaipakam:consent:v1';
export const CONSENT_POLICY_VERSION = 1;
export const CONSENT_OPEN_EVENT = 'vaipakam:consent:open';

export const ALL_DENIED: Omit<ConsentChoice, 'updatedAt' | 'version'> = {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  personalization_storage: 'denied',
};

export const ALL_GRANTED: Omit<ConsentChoice, 'updatedAt' | 'version'> = {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted',
  personalization_storage: 'granted',
};

type GtagFn = (...args: unknown[]) => void;

function getGtag(): GtagFn | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { gtag?: GtagFn };
  return typeof w.gtag === 'function' ? w.gtag : null;
}

export function getStoredConsent(): ConsentChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConsentChoice;
    if (parsed.version !== CONSENT_POLICY_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConsent(
  categories: Omit<ConsentChoice, 'updatedAt' | 'version'>,
): ConsentChoice {
  const choice: ConsentChoice = {
    ...categories,
    updatedAt: new Date().toISOString(),
    version: CONSENT_POLICY_VERSION,
  };
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Quota / private mode — the tracking stays denied-by-default, which
    // is the right fallback.
  }
  return choice;
}

export function clearConsent(): void {
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Tolerate — next load will re-prompt, same end-state.
  }
}

/**
 * Push the user's choice to the Google tag. Called on first Accept/Reject
 * and again on every page load after a choice exists (so the defaults set
 * in `index.html` are replaced with the persisted decision before any
 * downstream events fire).
 */
export function applyConsent(
  categories: Omit<ConsentChoice, 'updatedAt' | 'version'>,
): void {
  const gtag = getGtag();
  if (!gtag) return;
  gtag('consent', 'update', categories);
}

/**
 * Open the consent banner again from anywhere in the app — e.g. the
 * "Cookie settings" link in the footer. Uses a CustomEvent so the banner
 * component doesn't need to be lifted into a context.
 */
export function openConsentBanner(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONSENT_OPEN_EVENT));
}
