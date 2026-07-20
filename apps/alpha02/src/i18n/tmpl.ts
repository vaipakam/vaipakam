/**
 * `tmpl` — a translatable parametrized copy entry.
 *
 * The copy catalog (content/copy.ts) has long expressed parametrized
 * strings as JS template functions, e.g.
 *   testnetNudge: (chainName) => `You're on ${chainName}, a test network.`
 * The i18n factory (reactiveCopy.ts) can translate STRING leaves but
 * passes functions through untouched, so those rendered English in
 * every locale (see docs/DesignsAndPlans/Alpha02InterpolatedCopyI18n.md).
 *
 * `tmpl` replaces that pattern with a declarative i18next-interpolation
 * template the factory CAN translate, WITHOUT changing call sites:
 *   testnetNudge: tmpl('You're on {{chainName}}, a test network.', ['chainName'])
 *   // call site unchanged: copy.home.testnetNudge(chainName)
 *
 * `paramNames` lists the `{{placeholders}}` in the SAME order as the
 * original function's positional parameters, so `foo(a, b)` keeps
 * working — the entry maps args → named params for i18next.
 *
 * The returned value is a callable function (so it still works before
 * i18next initialises, in tests, and at module scope) tagged with the
 * raw `{{}}` template. The factory recognises the tag, binds it to the
 * entry's key path, and routes calls through `i18n.t(key, params)` so a
 * locale bundle wins; the template exporter emits the raw template (and
 * plural variants) so translators can localize it.
 *
 * Pluralization: name a param `count` and pass `{ one }` (and any other
 * CLDR categories). English selection happens here; translated bundles
 * use i18next's locale-aware `_one` / `_other` plural keys.
 */

/** Marker for a tmpl entry — a symbol property on the callable. */
export const TMPL = Symbol('vaipakam.tmpl');

export type TmplArg = string | number;
export type TmplParams = Record<string, TmplArg>;

export interface TmplMeta {
  /** Raw i18next template, e.g. `Due in {{n}} days` (the `_other` form
   *  when plural). */
  template: string;
  /** Placeholder names in positional-argument order. */
  paramNames: readonly string[];
  /** i18next plural variants keyed by CLDR category (`one`, `few`, …).
   *  `other` defaults to `template`. Present only for count-plural
   *  entries. */
  plurals?: Partial<Record<'zero' | 'one' | 'two' | 'few' | 'many', string>>;
}

export type TmplFn = ((...args: TmplArg[]) => string) & {
  readonly [TMPL]: TmplMeta;
};

/** Minimal `{{var}}` interpolation for the English / pre-init path.
 *  Tolerates an i18next format suffix (`{{n, number}}`) — the fallback
 *  inserts the raw value; i18next applies the locale-aware format at
 *  runtime. Unknown placeholders are left intact so a bad param fails
 *  loudly (a visible `{{x}}`) rather than silently vanishing. */
export function interpolate(template: string, params: TmplParams): string {
  return template.replace(
    /\{\{\s*(\w+)\s*(?:,[^}]*)?\}\}/g,
    (whole, key: string) => (key in params ? String(params[key]) : whole),
  );
}

/** Map positional args to their named params per `paramNames`. */
export function toParams(meta: TmplMeta, args: TmplArg[]): TmplParams {
  const params: TmplParams = {};
  meta.paramNames.forEach((name, i) => {
    if (i < args.length) params[name] = args[i];
  });
  return params;
}

/** Pick the English template variant for a given count (CLDR-en: only
 *  `one` vs `other`). Translated locales get their own categories from
 *  i18next. */
export function englishVariant(meta: TmplMeta, params: TmplParams): string {
  const count = params.count;
  if (meta.plurals && typeof count === 'number' && count === 1 && meta.plurals.one) {
    return meta.plurals.one;
  }
  return meta.template;
}

export function tmpl(
  template: string,
  paramNames: readonly string[] = [],
  plurals?: TmplMeta['plurals'],
): TmplFn {
  const meta: TmplMeta = plurals
    ? { template, paramNames, plurals }
    : { template, paramNames };
  const fn = ((...args: TmplArg[]) => {
    const params = toParams(meta, args);
    return interpolate(englishVariant(meta, params), params);
  }) as TmplFn;
  Object.defineProperty(fn, TMPL, { value: meta, enumerable: false });
  return fn;
}

export function isTmpl(value: unknown): value is TmplFn {
  return typeof value === 'function' && TMPL in (value as object);
}
