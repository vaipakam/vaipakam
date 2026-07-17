/**
 * The user's ACTIVE locale, normalised to a supported code — the
 * correct signal for everything that keys off "which language did
 * the user choose": markdown-body resolvers (Basic.<locale>.md),
 * locale-prefixed links, the English-only notice, picker state.
 *
 * Why not `i18n.resolvedLanguage`: i18next computes it only inside
 * init/changeLanguage, and it stays 'en' while a lazily-loaded
 * bundle is still in flight — on a COLD load of a locale URL
 * (`/es/help/basic`, exactly what the prerender pass drives) the
 * markdown resolvers picked the English file even though the Spanish
 * markdown exists, baking English bodies into localized snapshots
 * (Codex #1309 r6, verified). The active language is set by
 * `changeLanguage` immediately and is what the user actually chose;
 * string lookups themselves still fall back per-key via i18next's
 * fallback chain, so nothing breaks while a bundle loads.
 *
 * Subscribed via `useTranslation()`, so consumers re-render on
 * language changes and bundle arrivals like before.
 */

import { useTranslation } from 'react-i18next';
import { normalizeToSupportedLocale } from '@vaipakam/i18n/createI18n';
import type { SupportedLocale } from './glossary';

export function useActiveLocale(): SupportedLocale {
  const { i18n } = useTranslation();
  return normalizeToSupportedLocale(i18n.language) as SupportedLocale;
}
