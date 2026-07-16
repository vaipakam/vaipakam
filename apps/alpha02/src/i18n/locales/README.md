# alpha02 locale bundles

- **`en.json`** — the translators' TEMPLATE, generated from
  `src/content/copy.ts` by `pnpm --filter @vaipakam/alpha02
  i18n:template`. It is **not loaded at runtime** (copy.ts itself is
  the English source of truth); it exists so translators have the
  exact key structure to mirror. A vitest drift check fails CI when
  copy.ts changes without regenerating it.
- **Every other `<code>.json`** — that locale's translation bundle,
  lazy-loaded on first use. All start as **placeholder stubs (`{}`)**:
  picking the language renders English via i18next's `fallbackLng`
  until the file is filled in.

## Translating a locale

Copy the structure of `en.json` into `<code>.json` and translate the
string VALUES only (keys stay verbatim). Partial files are fine —
missing keys fall back to English. Respect the do-not-translate
glossary in `packages/i18n/src/glossary.ts` (VPFI, HF, LTV, asset and
network names, …).

Machine-assisted alternative:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
  --locales-dir apps/alpha02/src/i18n/locales es zh hi ja
```

Then promote the locale in `src/i18n/localeConfig.ts`
(`TRANSLATED_LOCALES` + picker visibility) — the lazy loader map
already covers every code.

Note: parametrized strings (function values in copy.ts, e.g.
`testnetNudge(chainName)`) are not yet in the template and render
English in every locale — converting them to i18next interpolation
keys is tracked in docs/DesignsAndPlans/I18nPlan.md.
