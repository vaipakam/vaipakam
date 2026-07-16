## Thread — Search/AI discoverability for www + alpha02, and alpha02 multi-language foundation (PR #TBD)

The marketing site and the connected app were both client-rendered
single-page apps, which meant search engines saw thin pages and the
JavaScript-less crawlers behind AI tools (GPTBot, ClaudeBot,
PerplexityBot and similar) saw essentially nothing. This thread makes
both surfaces first-class citizens for search and AI ingestion, and
lays the full multi-language foundation for the connected app.

**Marketing site (vaipakam.com).** The deploy pipeline now prerenders
every marketing route in every translated locale (110 pages) to static
HTML after the build, so any crawler receives the full rendered page —
headings, copy, per-locale title/description/canonical/hreflang —
without executing JavaScript. Every page also carries Open Graph and
Twitter Card tags (link unfurls on X/Discord/Telegram now show a real
card), and structured data was added: organisation and website
identity on the landing page, the FAQ as a machine-readable Q&A set
(rebuilt per locale), and article metadata on the overview, user
guides and whitepaper. For AI tools specifically, the canonical docs
are now published as raw Markdown under stable `/docs/*.md` URLs and
indexed by a root `llms.txt` (plus a one-fetch `llms-full.txt`) — the
emerging convention AI crawlers check. Prerendering is deliberately a
deploy-time step, not part of the plain build, so CI and typechecks
need no browser; a prerender failure still leaves a fully deployable
SPA build.

**Connected app (alpha02).** The app now states an explicit indexing
policy: generic product surfaces (home, borrow, lend, rent, offer
book, rate desk, VPFI, NFT verifier, help) are indexable with
per-route titles, descriptions and production-origin canonicals, while
wallet-scoped pages (positions, claims, vault, activity, settings,
faucet) are excluded via noindex both in-page and at the header layer,
so a JS-less crawler sees the same policy. A generated robots.txt and
sitemap ship with every build. The indexer Worker's root URL, which
previously answered 404, now returns a self-describing catalog of the
public keyless JSON API — so AI agents and integrators discovering
Vaipakam via llms.txt fetch supported endpoints instead of scraping
the app.

**Multi-language (alpha02).** The i18n machinery that already served
the marketing site was hoisted into a shared workspace package
(`@vaipakam/i18n`) — locale registry, do-not-translate glossary, RTL
handling, detection chain and translate tooling now exist exactly once
— and the marketing site was migrated onto it with no behaviour
change. The connected app is wired end-to-end: its centralized copy
catalog now resolves through the translation layer at read time (zero
changes at the ~900 call sites), a Language card in Settings offers
the first wave (English, Spanish, Chinese, Hindi, Japanese), the
choice persists across the `.vaipakam.com` subdomains, and
right-to-left locales flip layout before first paint. Per the
operator's direction, no machine translations were committed: all 33
non-English locales ship as placeholder bundles that render English
until translated, with a generated `en.json` template (drift-checked
in CI) for translators to mirror and a documented promotion recipe per
locale.

Follow-ups deferred: converting parametrized copy strings (function
values) to interpolation keys so they become translatable; locale URL
prefixes + hreflang on alpha02 once the first translated bundle ships;
registering both hosts in Google Search Console / Bing Webmaster Tools
(operator-side).
