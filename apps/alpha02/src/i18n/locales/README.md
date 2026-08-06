# alpha02 locale bundles

- **`en.json`** — the translators' TEMPLATE, generated from
  `src/content/copy.ts` by `pnpm --filter @vaipakam/alpha02
  i18n:template`. It is **not loaded at runtime** (copy.ts itself is
  the English source of truth); it exists so translators have the
  exact key structure to mirror. A vitest drift check fails CI when
  copy.ts changes without regenerating it. It has two top-level
  namespaces: `copy.*` (from `copy.ts`) and `contractError.*` — the
  friendly contract-revert messages, whose English is owned by
  `@vaipakam/lib` (seeded into the template from its catalog, so the
  strings live there once and aren't duplicated here). Translate the
  `contractError.*` values in each locale bundle exactly like `copy.*`
  ones; a missing key falls back to the lib English at runtime.
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
the placeholder tokens intact in every one.

Placeholder sets are validated at build time by
`scripts/check-locale-coverage.ts` — run by `pnpm typecheck`, or on
its own with `pnpm --filter @vaipakam/alpha02 i18n:coverage` (#1362): introducing a token the
English doesn't have always fails, and dropping one fails unless the
locale is listed in that file's `ALLOWED_OMISSIONS` with a linguistic
reason (Arabic's dual `_two` forms are the standing example — the noun
already means "two days", so restating `{{count}}` would read
"2 يومان").

Machine-assisted alternative:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
  --locales-dir apps/alpha02/src/i18n/locales es zh hi ja
```

**After adding a new section to `copy.ts`**, top up the already-
translated locales instead of re-running the whole bundle — the
`--missing-only` mode translates ONLY what each locale lacks and merges
it in, leaving reviewed strings untouched:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
  --locales-dir apps/alpha02/src/i18n/locales --missing-only \
  --policy apps/alpha02/src/i18n/translation-policy.json
```

If the translations arrive some other way (a translator's hand-back, a
vendor delivery), drop one `<code>.json` partial bundle per locale into
a directory and merge them the same way:

```bash
pnpm --filter @vaipakam/i18n merge-patch -- \
  --locales-dir apps/alpha02/src/i18n/locales --patches path/to/patches \
  --policy apps/alpha02/src/i18n/translation-policy.json
```

Pass `--policy` on both. Each run validates the WHOLE merged bundle,
not just the incoming translations, so a value the locale had already
lost — an `{{amount}}` that vanished in an earlier delivery, a leaf
holding a number where English has a sentence — is reported instead of
riding along under a clean "0 still missing". The exemptions file is
what keeps that check honest: without it the standing linguistic cases
below would fail every run, and a flag you always pass guards nothing.

Both report what each locale is still missing rather than reporting a
clean success, and `scripts/check-locale-coverage.ts` fails the build if
a locale in `TRANSLATED_LOCALES` falls behind `en.json` outside its
recorded backlog.

That backlog is `src/i18n/untranslated-baseline.json` — the exact
`(key, locale)` pairs still untranslated, not a list of sections. When
you fill some of them, run this to drop the entries you closed:

```bash
pnpm --filter @vaipakam/alpha02 i18n:coverage -- --prune
```

The check fails until you do, so the file can't drift stale. `--prune`
only ever REMOVES pairs (each one it keeps was observed missing on that
run), so it can't be used to wave through a key that regressed. It also does NOT suppress other findings: if the
locale has a genuinely new gap, a drifted leaf, a malformed placeholder
or a lost `CONFIRM`, `--prune` fixes the stale entries and still exits
non-zero for the rest.

Both merge paths reject a translation that mangles an interpolation
token before it can reach a file — an invented `{{token}}` or a
malformed brace run always, and a DROPPED token unless you name that
exact omission:

```bash
--allow-omission "ar:copy.units.durationDay_two:count, number"
```

The triple is `<locale>:<key>:<token>`, repeatable, and it excuses only
itself — allowing the Arabic dual does not license an unrelated
`{{amount}}` disappearing elsewhere in the same delivery. The rejection
message prints the exact flag to paste. Use it only where the target
grammar already carries the value.

For a STANDING exemption — one the locale will always need — record it
in `src/i18n/translation-policy.json` instead. That file is the single
record `check-locale-coverage.ts` and both merge paths read, so the
exemption is stated once with its linguistic reason rather than restated
on every command line. The `--allow-*` flags remain for a genuine
one-off.

The same file carries `requiredLiterals`: strings the app compares TYPED
USER INPUT against, like the `CONFIRM` a user must type to arm the
recovery signature. A locale that translates one renders a gate nobody
speaking that language can pass — they type the word the page asks for,
it never matches, and the button stays disabled with no error. Both
ingestion paths REJECT a delivery that breaks one, and the check is a
standalone-token match, so `Escribe CONFIRMAR` fails while
`CONFIRMと入力` passes. Enforced in the shared scripts rather than only
in this app's guard, because the surfaces at risk include apps with no
coverage command of their own.

An EMPTY translation is rejected the same way (`--allow-empty
"<locale>:<key>"`), because no other check can see one: the key is
present, the value is a valid string, and there are no tokens to
compare — while i18next renders it blank instead of falling back to
English, so the sentence just disappears for that language. Japanese
is the standing legitimate case: the verb goes last, so the consent
sentence's `prefix` is empty and `suffix` carries the agreement.

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
