# Release notes — 2026-05-09

A long session almost entirely on the marketing surface
(`apps/labs`, later renamed to `apps/www`): chain-removal,
brand polish, cross-subdomain preference syncing, search-engine
discoverability groundwork, and a domain cutover from
`labs.vaipakam.com` to the canonical `vaipakam.com`.

## Marketing surface — chain-free cleanup

The fresh apps/labs clone had inherited every chain-aware piece
of the connected-app from its source — wallet context, per-user
escrow lookups, on-chain journey-log diagnostics, address-book
helpers — none of which made sense on a wallet-free marketing
site. The page also briefly went blank on `labs.vaipakam.com`
because a chain-resolution helper threw at module load when its
default chain had no Diamond contract address yet.

Path-of-least-resistance fix would have been to add a fail-soft
to the helper. The architectural fix (chosen instead) was to
strip the chain plumbing entirely: marketing pages are static
educational content, the connected app at `defi.vaipakam.com`
owns every chain interaction. After this pass, ~2,000 lines of
unused-on-marketing code was deleted. The marketing surface no
longer has any source of "the user's active chain" because it
no longer needs one — any "verify on chain" affordance simply
links over to the connected-app's transparency page.

## Connected-app top-bar — Pattern C + Launch Vaipakam relabel

Two interrelated tweaks to the navbar that renders on the
public-read shells (Analytics, NFT Verifier, Protocol Console)
of the connected app:

- **Drop the `Learn` dropdown** (Features / How it works /
  Documentation / FAQ — every link pointed back across the
  subdomain to the marketing site, opening in a new tab). A
  short survey of eight major DeFi/DEX platforms (Uniswap,
  Aave, Morpho, Pendle, dYdX, Compound, 1inch, GMX) showed
  that none of them mirror marketing sections in their
  connected-app top-bar. The dominant pattern is "in-app
  navigation only, with at most a single Docs link".
  Replaced the four-item dropdown with a single flat "Docs"
  link to the marketing whitepaper / overview index.

- **Rebrand "Launch App" → "Launch Vaipakam"** across every
  surface and every locale. The connected-app's same-domain
  CTA now uses an in-tab navigation (rather than the
  previously-broken empty-href that opened a duplicate tab).
  The marketing-site cross-domain CTA correctly keeps its
  new-tab behaviour because it crosses origins.

## Landing-page Security cards — verify-link removal

The Security section on the marketing landing page rendered
six trust-claim cards (Diamond standard, isolated escrows,
on-chain transparency, slippage safety, audits, non-custodial),
each with a per-chain "verify on chain" link underneath. Same
industry survey showed that no major DeFi platform inlines
per-card verify links on a marketing site — the cards are
high-level claims; the on-chain artefacts live on the
connected-app's transparency page. The inline links were
removed (along with all the dead i18n strings that backed
them); the Footer's "Smart Contracts" link still routes
visitors to the connected-app's transparency page if they want
to verify.

## i18n cleanup + Launch Vaipakam locale rebrand

A locale-side housekeeping pass touching all 20 locale files
(10 supported languages × marketing site + connected app):

- The 9 orphaned `security.*Verify*` keys (one per Security
  card's verify-link label) were dropped — 180 string entries
  removed.
- "Launch App" was rebranded to a localised "Launch Vaipakam"
  across every language, in both the navbar CTA and the
  longer landing-hero call-to-action. Examples: German
  "Vaipakam öffnen", Japanese "Vaipakamを開く", Chinese
  "启动 Vaipakam", Arabic "افتح Vaipakam".

## Cross-subdomain theme + language sync

Until this commit, picking a theme or a language on the
marketing site had no effect on the connected app (and vice
versa). Each subdomain ran its own preference store via
browser localStorage, which is origin-scoped — labs and defi
are different origins under the eyes of the browser, so the
two surfaces drift apart the moment the user expresses a
preference on one of them.

A short survey of the same eight major DeFi platforms showed
that none of them solve this problem (the four with a true
marketing/app split — Aave, Morpho, Pendle, 1inch — sidestep
it by exposing theme/language pickers only on the app side,
not the marketing site). Vaipakam already shipped both
pickers on both surfaces, so the choice was: ship a sync
mechanism, or remove the marketing-side pickers. The first
option won.

The mechanism: two new browser cookies, `vaipakam_theme` and
`vaipakam_lang`, scoped to the parent `.vaipakam.com` domain
so every Vaipakam subdomain sees the same value. Both
preferences fall back to the OS / browser default when the
cookies don't exist (so a visitor's very first session
follows their system theme and locale). The cookies are
classified under Google's Consent Mode v2 essential
"functionality storage" category — already permanently
granted by the consent banner — so no banner change is
needed. The supporting helper lives in the workspace's shared
library so both apps consume the same logic.

## Language picker — two-click bug fix

A subtle bug surfaced once the marketing site was bundle-size-
optimised earlier in the week: clicking the language picker
visibly did nothing on the first click, and only swapped on
the second. Cause: the marketing site lazy-loads non-English
locale bundles, but the React-i18n binding was only
subscribed to the language-changed event on the i18n
instance, not to the resource-store's bundle-loaded event.
The first picker click switched the active language but
rendered English (fallback) until the new bundle landed
~100 ms later — and then nothing told React to re-render.
The second click fired the event with the bundle already in
memory, so the page finally appeared in the chosen language.

Fix was a one-line config addition that subscribes
React-i18n to the resource-store's "bundle added" event.
First click now visibly swaps the language as soon as the
dynamic import resolves.

## Language picker — cross-subdomain sync regression

Theme started syncing correctly across the two subdomains via
the new cookie, but language did not — picking Japanese on the
marketing site left the connected app in Spanish (or whatever
its own first-init had cached). Two coupled bugs:

- The cookie-seeding helper deferred to the existing
  same-origin localStorage when localStorage was already set,
  which it always was after a single visit (i18n's detector
  caches the navigator-resolved language at first init).
  The cookie was never allowed to override.
- No cookie was written at the very first init either —
  the cookie-write listener was registered after the i18n
  init() call returned, missing init's synchronous
  language-changed event.

Both fixed: the cookie is now treated as the cross-domain
source of truth (overwrites localStorage when they disagree),
and an init-time cookie write is performed directly so the
first navigator-detected language propagates immediately.
After redeploy, picker selections sync bidirectionally
between the marketing site and the connected app.

## SEO Stage A — sitemap + robots + per-page metadata

Every marketing page across every locale was always served as
the same static HTML shell (one title, no per-page
description, empty body until JavaScript hydrated). To Google
that meant "every URL looks identical at first crawl" — only
the front page was reliably indexed, and per-locale variants
trickled in over weeks because the crawler had no sitemap to
work from.

Stage A of the SEO pass closes the gap without a framework
migration:

- A `robots.txt` and a `sitemap.xml` are now generated at
  build time, with the sitemap listing every marketing route
  in every translated locale (110 URLs total) and including
  the right `hreflang` siblings so Google groups locale
  variants under one indexable page rather than ranking them
  as duplicates.
- A new per-page metadata helper sets a unique `<title>`,
  `<meta description>`, and `<link rel="canonical">` on
  every page mount, with the values resolved through the
  i18n system so each locale renders its own translated
  title and description. English copy is in place across all
  11 marketing routes; other-language translations will fill
  in incrementally via the existing translator-friendly
  fallback chain.

The remaining "Stage B" — pre-rendering each route to an
actual HTML file at build time — was deliberately deferred.
Most modern crawlers handle JavaScript-rendered SPAs in 2026,
and Stage A alone closes the discovery + per-page-relevance
gap that was actually responsible for the indexing shortfall.
Stage B becomes worth shipping only if Google Search Console
measurements after Stage A still show gaps, or if social
share previews start mattering for outbound campaigns
(Twitter / LinkedIn cards etc. still don't run JS).

Operator submissions that go with Stage A (one-time, off-
repo): the new `https://vaipakam.com` property in Google
Search Console and Bing Webmaster Tools, with the sitemap
URL submitted to each.

## Marketing folder + package + Worker rename — apps/labs → apps/www

A pure naming change in service of new-contributor ergonomics.
The marketing surface had been called "labs" for historical
reasons; the actual deployed URL was always going to be
`www.vaipakam.com`. The mismatch — folder labelled one thing,
URL labelled another — was a permanent piece of mental
overhead.

Three renames in one batch:

- Source folder `apps/labs` → `apps/www` (the `git mv`
  preserves history on every file in the tree).
- Package name `@vaipakam/labs` → `@vaipakam/www`.
- Cloudflare Worker name `vaipakam-labs` → `vaipakam-www`.

Operator-side, the Worker rename meant a fresh deployment +
custom-domain re-binding. The metrics history under the old
Worker name was accepted as a one-off cost of full naming
consistency across folder, package, deploy target, and
canonical URL.

## Apex-canonical cutover — www.vaipakam.com → vaipakam.com

Late-session domain cutover. The plan throughout the day had
been "www.vaipakam.com is canonical, apex 301-redirects to
www" — but the operator decided the apex (`vaipakam.com`,
without the www prefix) reads as the cleaner brand. The
canonical was flipped to apex; `www.vaipakam.com` now
301-redirects to apex via a Cloudflare redirect rule.

End state of the public surface:

- `https://vaipakam.com/...` — canonical, indexable.
- `https://www.vaipakam.com/...` — 301 redirect to apex,
  preserves path and query string.
- `https://defi.vaipakam.com/...` — connected app, untouched.
- `https://labs.vaipakam.com/...` — legacy hostname; still
  bound for now (Google had not yet indexed any URL there
  before cutover, so the redirect rule was deemed
  unnecessary). The new apex-pinned canonical on every
  page means crawlers won't index labs even if they visit
  it.

The code-side flip touched five places: the sitemap
generator's default origin, the per-page metadata helper's
canonical origin, the language-alternate (`hreflang`)
helper's origin, the connected-app's "back to marketing"
URL helper, and the deploy comment in the marketing
Worker's wrangler config. The metadata helper and hreflang
helper now hardcode the apex hostname rather than reading
`window.location.origin`, so a visitor who hits the www host
before the redirect fires still emits an apex-rooted
canonical — splits in ranking signal between the two
hostnames are impossible to introduce by accident.

A small DNS prerequisite landed alongside: the
`www.vaipakam.com` record didn't exist in the zone before
this cutover, which would have made the Cloudflare redirect
rule silently no-op (the rule only fires on traffic that
reaches Cloudflare's edge). The record was created via the
Cloudflare API as a proxied AAAA pointing to the standard
edge-only address, matching the convention every other
Vaipakam subdomain follows.

## Documentation discipline

Per the user-declared "Document every completed task functionally
under /docs/" rule, this entry continues the daily-cadence
release-notes thread. Plain language, no code blocks or facet /
selector / interface jargon, so a reader on the project's
product or ops side can follow what changed and why without
having to read source.
