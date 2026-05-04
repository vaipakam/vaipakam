# Internationalisation (i18n) plan

Vaipakam ships English by default; users can pick a different display
language from the gear-popover **Language** dropdown. This doc records
what's wired today, how to refresh translations when source strings
change, and the staged rollout plan for the broader string corpus.

## Stack

- **Framework**: [`react-i18next`](https://react.i18next.com/) +
  `i18next` + `i18next-browser-languagedetector`. Industry-standard,
  ~5 KB gzipped, integrates with React Router and our existing
  `useMode` / `useTheme` context layers without surprises.
- **Translation engine**: Claude API (`claude-opus-4-7`), invoked via
  the build-time script `frontend/scripts/translate-i18n.ts`.
  Translations are committed to git as `frontend/src/i18n/locales/<code>.json`
  and reviewed in PRs. No runtime translation calls.
- **Glossary**: `frontend/src/i18n/glossary.ts`. Lists every
  protocol-specific term that must NOT be translated (VPFI, HF, LTV,
  ERC-20, Vaipakam, etc.) plus tone / register guidance for the model.
  The glossary is injected into the prompt on every `npm run translate`
  call, and a post-translation sanity check flags any glossary term
  that went missing from the output.

## Languages

Ten locales appear in the LanguagePicker:

| Code | Native label | Status |
|------|--------------|--------|
| `en` | English | Source |
| `es` | Español | Hand-curated |
| `fr` | Français | Hand-curated |
| `de` | Deutsch | Hand-curated |
| `ja` | 日本語 | Hand-curated |
| `zh` | 中文 | Hand-curated |
| `ko` | 한국어 | Hand-curated |
| `hi` | हिन्दी | Hand-curated |
| `ta` | தமிழ் | Hand-curated |
| `ar` | العربية | Hand-curated; RTL applied via `<html dir="rtl">` |

Adding a new locale requires (a) appending it to `SUPPORTED_LOCALES`
in `src/i18n/glossary.ts`, (b) authoring the matching
`locales/<code>.json` (or running `npm run translate` to generate
it via Claude API), and (c) adding the picker entry to
`components/LanguagePicker.tsx`.

## Detection chain

`i18next-browser-languagedetector` runs in this order on first
visit:

1. `localStorage["vaipakam:language"]` — the LanguagePicker writes
   here. Same key the pre-i18n stub used, so existing user
   preferences carry forward.
2. `navigator.languages` — the browser's preference list, first
   match against `supportedLngs`.
3. `<html lang>` attribute — last-resort hint.
4. Fallback to `en`.

Future hooks (not wired yet):

- URL path prefix (`/es/...`, `/ta/...`) for SEO-friendly per-locale
  routes — reserved for if/when localised marketing pages launch.
- Cloudflare's `cf-ipcountry` request header forwarded as a cookie
  — useful for users with English browsers in non-English regions
  (expat workers, default Android in low-resource markets, etc.).

## Refreshing translations

When `en.json` gains a new string or an existing one changes, run
the translate script to regenerate every other locale:

```bash
cd frontend
ANTHROPIC_API_KEY=sk-ant-... npm run translate
```

The script reads `src/i18n/locales/en.json`, prompts Claude with the
glossary + style notes, and writes each target locale's JSON. It
overwrites existing files — review the diff before committing. Any
glossary term that goes missing from the output is flagged as a
warning (not an error) so an operator can catch it before push.

The script translates every non-`en` locale in `SUPPORTED_LOCALES`
in one run. Adding a new locale to that array means the next
`npm run translate` invocation will pick it up automatically.

## Coverage today

Strings wired today:

- `LanguagePicker` aria-label
- `Footer` bottom row (copyright, Terms, Privacy, Cookie settings,
  License)
- The starter set of common chrome strings exists in each locale's
  JSON (`common.connectWallet`, `common.modeBasic`, etc.) so adding
  more `t()` call sites doesn't require new translation work.

That's the entirety of Phase 1.

## Phase 2 — UI string extraction

Walk every page / component and replace inline JSX strings with
`t()` calls against namespaced keys (e.g. `loanDetails.actionsTitle`,
`createOffer.submitButton`, etc.). Targets, in priority order:

1. **Top-bar / settings popover** (Mode / Theme / Language labels).
2. **Common buttons + inputs** (Connect Wallet, Save, Cancel,
   placeholders, validation messages).
3. **Page titles + headings**.
4. **Card titles** (the `card-title` text rendered alongside
   `<CardInfo />` icons).
5. **Error messages** (`decodeContractError` strings,
   `useTxSimulation` messages, `ErrorAlert` content).
6. **Body text** in cards and forms.

Estimated string count after Phase 2: ~800–1200. Add the new keys to
`en.json` in batches as each page is migrated; re-run
`npm run translate` per batch; review each locale's diff in the PR.

## Phase 3 — Help / docs translation

Two long-form Markdown docs (`docs/UserGuide-Basic.md`,
`docs/UserGuide-Advanced.md`) are loaded by the `/help/<mode>` pages
via Vite's `?raw` import. To localise these:

1. Sister script `scripts/translate-docs.ts` (TBD) translates each
   `.md` to `.<code>.md` while preserving headings, anchor ids,
   inline code, and the role-tab subsection markers.
2. The `UserGuide` page picks the locale-specific Markdown via the
   active i18next language at render time, falling back to the
   English file if the localised version doesn't exist.
3. The TOC extractor and role-tab parser already operate on raw
   text and don't need changes.

Docs translation is held until Phase 2 settles — no point translating
docs while the surrounding chrome is still English.

## Phase 4 — Locale-aware formatting

Numbers, dates, currencies, and percentages should format per locale
via `Intl.NumberFormat` / `Intl.DateTimeFormat` rather than the
inline `.toFixed(...)` and `Math.round(...)` calls scattered through
the codebase. Wrap the existing format helpers (`lib/format.ts`)
around `Intl` with `i18n.language` as the default locale.

## Phase 5 — RTL polish

Arabic ships with `<html dir="rtl">` applied automatically by
`i18n/index.ts`. CSS that uses logical properties
(`margin-inline-start`, `padding-inline-end`, `text-align: start`)
flips correctly. Anywhere we still use physical properties
(`margin-left`, `padding-right`, `left:`/`right:` positioning) needs
a targeted RTL pass. The TopBar's wallet-pill chevron, the help-page
sidebar, and the icon spacing inside buttons are the most likely
needers; everything else looked correct in a quick scan.

## Locale display flags (LanguagePicker visibility control)

Two compile-time switches in
[`frontend/src/i18n/localeConfig.ts`](../frontend/src/i18n/localeConfig.ts)
control what the LanguagePicker dropdown advertises. Both are TypeScript
constants — flip the value, rebuild, redeploy.

### `LANGUAGE_PICKER_ENABLED` — master switch

```ts
export const LANGUAGE_PICKER_ENABLED = true;  // flip to false to hide entirely
```

When `false`, the LanguagePicker is not rendered anywhere — public Navbar,
in-app settings panel, both gone. URL-based locale routing
(`/es/...`, `/ta/...`) continues to work for users with bookmarks or
hreflang-discovered URLs; the picker is just the user-facing surface for
switching. Useful when the user base is overwhelmingly English and the
picker is more clutter than feature.

### `LOCALE_DISPLAY_CONFIG[<code>].visible` — per-language switch

```ts
export const LOCALE_DISPLAY_CONFIG: Record<SupportedLocale, LocaleDisplayConfig> = {
  en: { code: 'en', label: 'English',   visible: true  },
  es: { code: 'es', label: 'Español',   visible: true  },
  // ...
  te: { code: 'te', label: 'తెలుగు',     visible: false }, // placeholder
  // ...
};
```

Each locale has a `visible` flag that controls whether it appears in the
dropdown options. Use cases:

- **Hide a locale temporarily** — flip `visible: false`. URL routing and
  bookmarks keep working; the locale just disappears from the picker.
- **Surface a placeholder locale early** — flip `visible: true` on a
  placeholder (i.e. an entry with no JSON bundle yet). The user can
  select it; i18next's `fallbackLng: 'en'` renders English text under
  that locale code (with `<html lang="te">` set). Good for "coming
  soon" tease; misleading if you don't actually intend to ship the
  translation soon.

The picker reads `VISIBLE_LOCALES` (filtered list of entries with
`visible: true`) so the order in the dropdown matches the order in
`LOCALE_DISPLAY_CONFIG` — translated locales first, placeholders below.

## Placeholder locales (recognised but not translated)

`SUPPORTED_LOCALES` in
[`frontend/src/i18n/glossary.ts`](../frontend/src/i18n/glossary.ts)
includes every locale code the URL router accepts. It is partitioned
into two groups:

- **Translated** (10): `en, es, fr, de, ja, zh, hi, ar, ta, ko`. Each
  has a JSON bundle in `locales/`, gets a per-locale SSG shell via
  `inject-seo-meta.ts`, appears in `sitemap.xml`, and is advertised in
  the `<link rel="alternate" hreflang>` block.
- **Placeholder** (12): `te, kn, ml, pt, ru, tr, it, nl, id, pl, bn, mr`.
  Recognised by URL routing (so `/te/dashboard` doesn't 404) and
  accepted by i18next, but with **no JSON bundle**. Picking one of these
  resolves every `t('key')` call to the English string via
  `fallbackLng: 'en'`. Hidden from the LanguagePicker by default
  (`visible: false`).

A separate constant `TRANSLATED_LOCALES` lists only the 10 translated
codes. SEO surfaces use this list:

| Surface | Iterates | Why |
|---|---|---|
| LanguagePicker | `VISIBLE_LOCALES` | User can pick any locale we want to expose, translated or not |
| URL routing (LocaleResolver) | `SUPPORTED_LOCALES` | Recognise placeholder URL prefixes too — never 404 a `/te/...` URL |
| `inject-seo-meta.ts` (per-locale shells) | `TRANSLATED_LOCALES` | Don't emit a Telugu shell with English content under `<html lang="te">` — worse SEO than serving the root |
| `generate-sitemap.ts` | `TRANSLATED_LOCALES` | Don't list locale URLs for content that doesn't exist as localised pages |
| `HreflangAlternates.tsx` | `TRANSLATED_LOCALES` | Don't advertise non-existent localised pages to crawlers |
| `DefaultLocaleRedirect.tsx` | `TRANSLATED_LOCALES` | Auto-redirecting a Telugu-browser visitor to `/te/` would land them on English content with `<html lang="te">` mismatch |
| i18next resources | English + 10 translated bundles | Placeholder codes resolve via `fallbackLng: 'en'` |

### Promoting a placeholder to translated

When a placeholder locale's translation lands:

1. Run `npm run translate -- <code>` (or hand-author
   `locales/<code>.json` from `en.json`).
2. Add the import + resource registration in `i18n/index.ts`:
   ```ts
   import te from './locales/te.json';
   // ...
   resources: { ..., te: { translation: te } },
   ```
3. Move `<code>` from the placeholder section into `TRANSLATED_LOCALES`
   in `glossary.ts`.
4. Add the locale's `META` entry (htmlLang, title, description) and
   `OG_LOCALES` BCP-47 tag in `scripts/inject-seo-meta.ts`.
5. Flip `visible: true` for the entry in `localeConfig.ts`.
6. Rebuild — `inject-seo-meta` will emit `dist/<code>/index.html`,
   sitemap will include the locale's URLs, hreflang block will
   advertise it.

Going the other way (demoting / hiding) is just the inverse of step 5
(or step 3 if you want to remove SEO surfacing too).

## Files

- `frontend/src/i18n/index.ts` — i18next bootstrap, detection
  chain, RTL toggle.
- `frontend/src/i18n/glossary.ts` — DO-NOT-TRANSLATE list, style
  notes for the prompt, `SUPPORTED_LOCALES` (full) and
  `TRANSLATED_LOCALES` (subset that ships JSON bundles).
- `frontend/src/i18n/localeConfig.ts` — `LANGUAGE_PICKER_ENABLED`
  master switch + `LOCALE_DISPLAY_CONFIG` per-locale visibility flags
  + computed `VISIBLE_LOCALES`.
- `frontend/src/i18n/locales/<code>.json` — translated string
  bundles. Source is `en.json`.
- `frontend/scripts/translate-i18n.ts` — Claude API translation
  script. Runnable via `npm run translate`.
- `frontend/scripts/inject-seo-meta.ts` — post-build per-locale SSG
  shell generator. Iterates `TRANSLATED_LOCALES`.
- `frontend/scripts/generate-sitemap.ts` — sitemap.xml generator.
  Iterates `TRANSLATED_LOCALES`.
- `frontend/src/components/LanguagePicker.tsx` — picker UI; reads
  `LANGUAGE_PICKER_ENABLED` + `VISIBLE_LOCALES`; delegates language
  change to `i18n.changeLanguage`.
- `frontend/src/components/Footer.tsx` — first call site using
  `t()` (demo).
- `frontend/src/main.tsx` — imports `./i18n` before app render.
