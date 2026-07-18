# alpha02 — translatable interpolated copy (i18n interpolation support)

**Status:** scoping / design (follow-up to the #1329 / #1323 / #1343
extraction lineage)
**Owner:** TBD
**Related:** #1329 (initial extraction), #1343 (`.ts`-module extraction),
#1323 (locale backfill tracker)

## Problem

After #1329/#1330/#1343, every **static** user-visible string in alpha02
is routed through the `copy.*` catalog and translates with the display
language. But a large class of user-visible text still renders **English
in every locale, no matter how complete the locale bundle is**:

1. **Function-valued catalog entries** (~111 in `content/copy.ts`) —
   parametrized copy authored as JS template functions, e.g.
   `dueInDays: (n) => `Due in ${n} days``,
   `testnetNudge: (chainName) => `You're on ${chainName}, a test
   network. …``. These are centralized but untranslatable.

2. **Inline interpolated notices** (~51 across 13 components) — sentences
   built inline with `${…}` in JSX and never extracted at all, e.g.
   `ActivePositionsBanner` ("You have {n} active {position/positions}.
   View them under My positions."), the offer/rental duration caps ("The
   protocol currently caps offers at {max} — pick a shorter duration."),
   `Claims` ("{amount} VPFI ready to claim."), `Vpfi` ("Checking VPFI
   availability on {chain}…"), `Positions` ("Offer #{id} · waiting for
   the other side to accept").

## Root cause

The i18n factory (`src/i18n/reactiveCopy.ts`) is a deep Proxy that, on a
**string** leaf, returns `i18n.t(key, { defaultValue })` — translatable.
On a **function** leaf it does `return value` (passes it through
untouched). By construction, a function can never be translated: the
locale bundles are JSON, and JSON cannot hold the interpolation logic a
JS template function encodes. The template exporter
(`scripts/export-i18n-template.ts` → `buildTemplate`) skips function
entries for the same reason, so translators never even see them.

Separately, the inline interpolated notices are invisible to the
`check-hardcoded-strings` guardrail: its regexes match quoted strings and
clean `>text<` JSX, but interpolation-interspersed JSX text (`}…text…{`)
and backtick templates slip through — which is exactly how the
`ActivePositionsBanner` notice was never caught.

## Goal

Make parametrized copy translatable end-to-end: a translator fills in
`"Due in {{n}} days"` (localized), and `copy.loanState.dueInDays(3)`
returns the localized, interpolated string — while keeping call-site
ergonomics close to today's.

## Proposed approach — i18next interpolation

i18next natively supports `{{var}}` interpolation and plural forms. The
migration turns each parametrized entry into a **declarative interpolation
template** the factory can bind to a key.

### 1. Authoring helper

Introduce a small marker so the catalog can express "interpolated
template" without losing the key path the proxy assigns:

```
// pseudocode — final shape TBD in implementation PR
dueInDays: tmpl<'n'>('Due in {{n}} days'),
testnetNudge: tmpl<'chainName'>(
  "You're on {{chainName}}, a test network. Get free test assets to try things out →",
),
activePositions: tmpl<'count'>(
  'You have {{count}} active positions. View them under My positions.',
  { count_one: 'You have {{count}} active position. View them under My positions.' },
),
```

`tmpl(...)` returns a tagged value the factory recognizes.

### 2. Factory support (`reactiveCopy.ts`)

When the proxy encounters a `tmpl` leaf at key path `copy.x.y`, it returns
a function `(params) => i18n.t('copy.x.y', { ...params, defaultValue })`
where `defaultValue` is the raw English template (with `{{}}` intact so
i18next interpolates it). i18next handles plural selection from
`count` automatically when `_one`/`_other` variants exist.

### 3. Template export (`buildTemplate`)

Emit `tmpl` entries as their raw `{{}}` string (plus plural variants) so
translators can localize them — the change that lets the locale bundles
finally carry parametrized copy.

### 4. Call-site migration

Positional calls (`copy.x.dueInDays(3)`) become named
(`copy.x.dueInDays({ n: 3 })`). Ergonomic but mechanical; TypeScript
enforces the param names via the `tmpl<'n'>` type parameter, so a missed
call site is a compile error, not a runtime English fallback.

### 5. Inline-notice extraction

Extract the ~51 inline interpolated notices into `tmpl` catalog entries
and replace the inline JSX with the call. This folds category (2) into
category (1) — one representation for all parametrized copy.

### 6. Close the guardrail blind spot

Extend `check-hardcoded-strings.mjs` to also flag
interpolation-interspersed JSX text and backtick UI templates, with an
allowlist for the deliberate non-UI cases (dev-guard errors, signed
messages, EIP-712 domains). This prevents new inline interpolated notices
from ever regressing the way `ActivePositionsBanner` did.

## Inventory (scope)

| Category | Count | Location |
| --- | --- | --- |
| Function-valued catalog entries | ~111 | `content/copy.ts` |
| Inline interpolated notices | ~51 | 13 components (`ActivePositionsBanner`, `OfferFlow`, `Rent`, `Vpfi`, `Claims`, `PositionDetails`, `RefinanceFlow`, `EarlyExitFlow`, `LoanSaleFlow`, `LoanSalePendingCard`, `LoanRow`, `CopyAddress`, `desk/DeskHeader`) |
| Factory + exporter + guardrail | 3 files | `reactiveCopy.ts`, `export-i18n-template.ts` / `template.ts`, `check-hardcoded-strings.mjs` |

## Special cases to handle

- **Pluralization** — entries like `unreadBadgeTitle: (n) => n === 1 ?
  '1 unread notification' : `${n} unread notifications`` map to i18next
  `_one` / `_other` plural keys, not a single template. Every locale has
  its own plural rules (Arabic has six categories) — i18next covers this,
  but each such entry needs its variants authored.
- **List joins** — entries interpolating `reasons.join('; ')` (token
  security) keep the join in JS and interpolate the joined string.
- **Glossary terms** stay verbatim inside templates (VPFI, HF, LTV,
  asset/network names) per the existing rule.
- **Do NOT touch**: signed-message builders (`buildDueDateOptOutMessage`
  et al. — byte-identical to the backend verifier), thrown dev-guard
  errors, EIP-712 domain strings, chain proper names.

## Phasing (keeps each PR reviewable)

1. **Platform**: `tmpl` helper + factory support + exporter, migrate a
   small pilot slice (e.g. `loanState` + `activity` refs already added in
   #1343) and prove translation end-to-end with one locale.
2. **Catalog migration**: convert the remaining function entries to
   `tmpl`, batch by domain (offers, rentals, positions, claims, VPFI,
   alerts), each batch its own PR with call-site updates.
3. **Inline-notice extraction**: extract the ~51 inline notices into
   `tmpl` entries.
4. **Guardrail**: extend `check-hardcoded-strings.mjs` + add the
   interpolation cases to COVERAGE.md.
5. **Backfill**: the locale bundles gain the new `{{}}` templates
   (tracked with #1323); until translated they fall back to the English
   template exactly as static keys do today.

## Risks

- **Breadth of call-site churn** — mitigated by the compile-time param
  typing (a wrong/missing param is a build error, not a silent fallback).
- **Plural correctness across locales** — i18next handles selection, but
  authored variants must be right; the pilot proves the mechanism before
  the bulk migration.
- **Bundle-size / init cost** — negligible; i18next interpolation is
  already loaded (the factory uses `i18n.t`).

## Verification plan

- Unit: factory returns a localized interpolated string for a `tmpl`
  leaf given a stub bundle; falls back to the English template with no
  bundle; plural selection picks the right variant.
- Template drift test extended to assert `tmpl` entries export their raw
  `{{}}` string.
- e2e (spec 23): with a locale bundle carrying a translated `tmpl` entry,
  a parametrized notice (e.g. the active-positions banner) renders
  localized with the value interpolated.
- Live review per the testnet DoD once a locale is backfilled.
