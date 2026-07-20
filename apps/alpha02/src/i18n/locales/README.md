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

**Preserve every `{{placeholder}}` verbatim.** The migrated `tmpl(...)`
values carry live i18next interpolation tokens — `{{chainName}}`,
`{{amount}}`, and format-suffixed ones like `{{units, number}}`. These
are NOT words to translate: the name inside the braces (and any
`, number` / `, ...` format suffix) must appear unchanged in the
translation, or i18next renders the string without its dynamic value (or
with raw braces). You may reorder placeholders to fit the target
grammar, but never rename, translate, or drop one, and keep the same set
that appears in the English value. A count-plural key ships as its full
CLDR category set (`_zero` / `_one` / `_two` / `_few` / `_many` /
`_other`); fill each category your locale grammatically uses and leave
the placeholder tokens intact in every one. (Automated placeholder-set
validation for the machine-assisted flow is tracked in #1362.)

Machine-assisted alternative:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
  --locales-dir apps/alpha02/src/i18n/locales es zh hi ja
```

Then promote the locale in `src/i18n/localeConfig.ts`
(`TRANSLATED_LOCALES` + picker visibility) — the lazy loader map
already covers every code.

Note: parametrized strings are being migrated from JS template
functions to `tmpl(...)` entries (src/i18n/tmpl.ts), which DO appear in
the template as i18next `{{var}}` interpolation keys (with `_one` /
`_other` plural siblings) and translate like any other key. Plain
function entries not yet migrated still render English in every locale —
progress + plan in
docs/DesignsAndPlans/Alpha02InterpolatedCopyI18n.md.
