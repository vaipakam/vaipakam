/**
 * Remounts its subtree when the active language — or that language's
 * bundle load state — changes.
 *
 * Why a remount instead of per-component subscriptions: alpha02's
 * strings flow through the `copy` proxy (src/content/copy.ts), which
 * resolves through i18next at ACCESS time but does not make the
 * ~60 consuming components i18next subscribers. Remounting on
 * language change re-runs every render, re-evaluating every
 * `copy.*` read in the new language. Language switches are rare and
 * user-initiated, so losing transient component state (an un-submitted
 * form field) at that moment is an accepted trade — the URL, wallet
 * connection, theme, and react-query cache all live above this
 * wrapper and survive.
 *
 * The key includes the bundle-loaded flag because a first-time switch
 * races the locale JSON chunk fetch: `languageChanged` fires (key
 * flips, tree renders with English fallbacks), then
 * `addResourceBundle` lands ~50-200 ms later. `useTranslation` is
 * bound to that store event (`bindI18nStore: 'added removed'` in the
 * shared factory), so this component re-renders, the flag flips, and
 * the tree remounts once more with the real translations.
 */

import { type ReactNode } from 'react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

export function LanguageRemount({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const lng = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const loaded = lng === 'en' || i18n.hasResourceBundle(lng, 'translation');
  return <Fragment key={`${lng}:${loaded ? 1 : 0}`}>{children}</Fragment>;
}
