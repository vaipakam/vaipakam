## Thread — Translatable contract-revert messages in the connected app (PR #<n>)

The plain-language explanations shown when a transaction fails — the
friendly cause a contract revert decodes to, like "Health factor too low.
Add collateral to bring it above 1.5", "This offer has expired", or the
"the wallet could not estimate this transaction" guidance — are now
translatable in the alpha02 connected app. Previously these lived (in
English) inside the shared `@vaipakam/lib` decoder and reached the screen
already resolved, so they stayed English in every locale even when the
rest of the interface was translated — a visible patch of English on an
otherwise localized error banner.

The shared decoder keeps English as its single source of truth (so the
keeper bot, servers, and tests are unchanged), but now optionally accepts
a localizer: for each error it resolves a **stable key** — the Solidity
error name, or its 4-byte selector when no name resolves — plus the
English copy, and hands both to the caller's translator. The connected
app supplies one that looks the key up in the active locale's bundle and
falls back to the lib English when a language hasn't translated it yet
(never a raw error code or hex). The ~150 curated messages are seeded
into the translators' template automatically from the library's single
catalog, so the English is never duplicated app-side and can't drift.

Translating the messages themselves per locale is a backfill step (the
keys ship English-first and fall back until a locale's bundle is filled),
the same model the rest of the app's copy follows. This covers the
alpha02 connected app only; the older `apps/defi` surface is slated for
retirement and was intentionally left on the English default.

Follow-ups: the full decoder unit suite currently lives in the retiring
`apps/defi` and should be relocated to `@vaipakam/lib` as part of that
retirement so decode coverage isn't lost.
