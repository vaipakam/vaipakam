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
 * Non-string leaves:
 *   - `tmpl(...)` entries (parametrized strings — see i18n/tmpl.ts) are
 *     translated: the proxy binds each to its key path and routes calls
 *     through `i18n.t(key, params)`, so a locale bundle wins and the
 *     English template (count-correct for plurals) is the defaultValue.
 *   - PLAIN FUNCTIONS not yet migrated to `tmpl` still pass through and
 *     render their English output in every locale (tracked in
 *     docs/DesignsAndPlans/Alpha02InterpolatedCopyI18n.md).
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
import { isTmpl, englishVariant, TMPL, type TmplParams, type TmplFn } from './tmpl';

/** Sub-proxy cache — one proxy per nested object, so identity is
 *  stable across reads (React deps arrays, Set membership). */
const subProxyCache = new WeakMap<object, Map<PropertyKey, object>>();

/** Bound-tmpl cache — one wrapper fn per (source fn), so a captured
 *  reference keeps a stable identity across reads (same reason as the
 *  sub-proxy cache). Keyed by the source tmpl fn itself. */
const tmplFnCache = new WeakMap<TmplFn, (params?: TmplParams) => string>();

/** Bind a `tmpl` entry to its key path: route calls through i18next so
 *  a locale bundle wins, with the count-correct English template as the
 *  defaultValue (alpha02 registers an EMPTY `en` bundle, so English is
 *  always served from here). Translated bundles carry i18next's
 *  locale-aware `_one` / `_other` plural keys. */
function bindTmpl(fn: TmplFn, key: string): (params?: TmplParams) => string {
  const cached = tmplFnCache.get(fn);
  if (cached) return cached;
  const bound = (params?: TmplParams): string => {
    // Before i18next is ready, serve the English template directly.
    if (!i18n.isInitialized) return fn(params);
    // defaultValue is the English text (count-correct) — used whenever
    // the active bundle lacks the key (always, for en). A translated
    // bundle carrying the key (or its `_one`/`_other` plural variants)
    // wins; `count` drives i18next's locale-aware plural selection.
    return i18n.t(key, {
      ...params,
      defaultValue: englishVariant(fn[TMPL], params),
    }) as string;
  };
  tmplFnCache.set(fn, bound);
  return bound;
}

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

      // Parametrized-but-translatable entries — bound to their key path.
      if (isTmpl(value)) {
        return bindTmpl(value, `${prefix}.${String(prop)}`);
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
