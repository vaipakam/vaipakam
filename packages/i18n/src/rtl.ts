/**
 * Right-to-left locale handling, shared across every app surface so
 * the RTL set can never drift between the index.html pre-paint
 * bootstrap, the i18next `languageChanged` listener, and the SEO
 * shell generators.
 */

/** Locales whose script runs right-to-left. `<html dir="rtl">` flips
 *  layout for CSS written with logical properties
 *  (margin-inline-start, text-align: start, …). */
export const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'] as const;

export function isRtlLocale(lng: string): boolean {
  return (RTL_LOCALES as readonly string[]).includes(lng);
}

/** Keep the document `lang` + `dir` attributes in sync with the
 *  active language. Safe to call in non-DOM contexts (no-op). */
export function applyDocumentDirection(lng: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('dir', isRtlLocale(lng) ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('lang', lng);
}
