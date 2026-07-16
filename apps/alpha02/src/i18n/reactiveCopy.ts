/**
 * i18n-aware view over the copy catalog — the mechanism that delivers
 * on copy.ts's founding promise ("localization later becomes a matter
 * of swapping this module for an i18n catalog without touching
 * pages") with ZERO call-site changes.
 *
 * `createTranslatedCopy(copySource)` returns a deep Proxy with the
 * same shape as the source object. Every STRING leaf read resolves
 * through i18next at ACCESS time:
 *
 *     copy.home.title  →  i18n.t('copy.home.title',
 *                                { defaultValue: copySource.home.title })
 *
 * so a locale bundle that carries the key wins, and everything else
 * falls back to the English source string in copy.ts — which stays
 * the single source of truth (the en bundle is deliberately NOT
 * registered as an i18next resource; `defaultValue` IS the English
 * text, so copy.ts edits are live without regenerating anything).
 *
 * Non-string leaves pass through untouched:
 *   - FUNCTIONS (parametrized strings like `testnetNudge(chainName)`)
 *     return their English template output in every locale for now.
 *     Translating those requires converting each to an i18next
 *     interpolation key — tracked as a follow-up in
 *     docs/DesignsAndPlans/I18nPlan.md, deliberately not blocking the
 *     static-string corpus (~90% of the catalog).
 *   - Numbers / booleans reflect through.
 *
 * Arrays are proxied like objects — elements resolve under numeric
 * key segments (`copy.consentParts.0`), and array methods (.map etc.)
 * reflect through the proxy so iteration yields translated elements.
 *
 * Re-rendering: components read `copy.*` during render but don't
 * subscribe to i18next. `<LanguageRemount>` (mounted around the app
 * in main.tsx) remounts the tree when the active language — or its
 * bundle's load state — changes, so every access re-evaluates. A
 * module-level read (`const s = copy.x.y` at import time) evaluates
 * once and stays English; those are rare and self-heal as they're
 * migrated into render scope.
 *
 * Guard: reads that happen before i18next initialises (module-load
 * order) return the source string directly — never a raw key.
 */

import i18n from 'i18next';

/** Sub-proxy cache — one proxy per nested object, so identity is
 *  stable across reads (React deps arrays, Set membership). */
const subProxyCache = new WeakMap<object, Map<PropertyKey, object>>();

export function createTranslatedCopy<T extends object>(
  source: T,
  prefix = 'copy',
): T {
  return new Proxy(source, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // Symbols (Symbol.iterator, React internals probing) and
      // prototype plumbing reflect through untouched.
      if (typeof prop === 'symbol') return value;

      if (typeof value === 'string') {
        if (!i18n.isInitialized) return value;
        return i18n.t(`${prefix}.${prop}`, { defaultValue: value });
      }

      if (value !== null && typeof value === 'object') {
        let perTarget = subProxyCache.get(target);
        if (!perTarget) {
          perTarget = new Map();
          subProxyCache.set(target, perTarget);
        }
        let sub = perTarget.get(prop);
        if (!sub) {
          sub = createTranslatedCopy(value, `${prefix}.${prop}`);
          perTarget.set(prop, sub);
        }
        return sub;
      }

      // Functions, numbers, booleans, undefined — pass through.
      return value;
    },
  }) as T;
}
