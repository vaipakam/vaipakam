# @vaipakam/i18n

Shared internationalisation core for every Vaipakam app surface
(apps/www, apps/alpha02, future surfaces). Hoisted out of apps/www so
the third consumer (alpha02) didn't become the third copy.

## What lives here (must never drift between apps)

| Export | Purpose |
| --- | --- |
| `SUPPORTED_LOCALES`, `SupportedLocale` | The universe of locale codes every surface recognises (URL routing, cookie validation, picker plumbing). |
| `GLOSSARY_KEEP_VERBATIM`, `GLOSSARY_STYLE_NOTES`, `LOCALE_NAMES` | The do-not-translate glossary + register guidance injected into every translation run. |
| `RTL_LOCALES`, `isRtlLocale`, `applyDocumentDirection` | The RTL locale set + `<html lang>`/`dir` applier. |
| `LOCALE_NATIVE_LABELS`, `LocaleDisplayConfig` | Native self-names for LanguagePicker entries. |
| `initVaipakamI18n`, `LANGUAGE_STORAGE_KEY` | The i18next bootstrap factory: eager-English + lazy locale chunks, cookie-seeded cross-subdomain detection (`vaipakam_lang` at `.vaipakam.com`), `bindI18nStore` re-render wiring, RTL sync. |
| `missingSubtree`, `deepMerge`, `orderLike`, `leafPaths` | Structural bundle ops: find what a locale lacks, merge a partial answer in, normalise key order, enumerate leaves. |
| `placeholders`, `placeholderDrift` | Interpolation-token extraction + parity check, so a translation can't drop or invent a `{{value}}` slot. |
| `scripts/translate-i18n.ts` | Claude-API translation runner, generalised with `--locales-dir`. `--missing-only` fills gaps in already-translated locales. |
| `scripts/merge-locale-patch.ts` | Merge hand-authored / vendor-delivered partial bundles into locale files. |

## What stays per-app (genuinely differs by surface)

- `src/i18n/locales/*.json` — the app's translation bundles. `en.json`
  is the source of truth; other codes may be **placeholder stubs**
  (`{}`) that render English via `fallbackLng` until translated.
- `TRANSLATED_LOCALES` — which subset actually ships translated
  content. Drives hreflang / sitemap / per-locale SEO shells; a
  placeholder must never be advertised to crawlers.
- LanguagePicker visibility flags (`localeConfig.ts`).
- The app's `src/i18n/index.ts` — a thin `initVaipakamI18n({...})`
  call wiring the app's own bundles + lazy loaders.

## Translating a locale

```bash
ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
  --locales-dir apps/alpha02/src/i18n/locales        # fill empty stubs
# or explicit codes (overwrites):
#   ... translate -- --locales-dir <dir> es zh hi ja
# or top up locales that fell behind en.json (never overwrites):
#   ... translate -- --locales-dir <dir> --missing-only
```

**Reach for `--missing-only` after adding a section to an app's
`copy.ts`.** It is the only mode that can bring an already-translated
locale forward: the default mode skips anything that isn't an empty
placeholder, and the overwrite modes re-translate the whole bundle to
add a handful of keys — churning reviewed strings and burying the new
ones. That missing mode is why nine alpha02 locales silently froze at
their first-generated key set and drifted 291 keys behind (#1560); each
bundle looked complete the whole time.

For translations that didn't come from the API, drop one `<code>.json`
partial bundle per locale in a directory and merge:

```bash
pnpm --filter @vaipakam/i18n merge-patch -- \
  --locales-dir <dir> --patches <dir-of-patches>
```

Both paths merge in place and report what each locale is still missing.
Neither reorders the file by default (`--reorder` opts in): normalising
a bundle whose order has already drifted rewrites most of it, which is
worth doing as its own mechanical commit but never alongside content.
Each consuming app should also carry a coverage test that fails when a
locale in its `TRANSLATED_LOCALES` falls behind `en.json` — see
`apps/alpha02/src/i18n/localeCoverage.test.ts`.

Review the diff before committing — the glossary check flags missing
verbatim terms as warnings, not failures. Hand-authored translations
are equally fine: fill any `<code>.json` with the same key structure
as `en.json` (partial files are OK — missing keys fall back to
English).

Full plan + history: `docs/DesignsAndPlans/I18nPlan.md`.
