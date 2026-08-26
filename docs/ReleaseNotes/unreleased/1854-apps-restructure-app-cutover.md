## Thread — the connected app becomes `apps/app` at app.vaipakam.com (PR #TBD)

The connected app finished its cutover. What shipped for two months as
`apps/alpha02` on alpha02.vaipakam.com is now simply the app: folder
`apps/app`, package `@vaipakam/app`, Cloudflare Worker `vaipakam-app`,
served at **app.vaipakam.com**. The three surfaces it superseded are
deleted — `apps/defi` (frozen since the redesign began, previously at
defi.vaipakam.com) and the two earlier prototypes `apps/alpha` and
`apps/alpha01`. Nothing named "alpha" survives on any surface a user
reaches.

The marketing site needed no structural change, which is worth recording
because it was the part everyone expected to be hard. `apps/www` never
imported the connected app: every "Launch App" button and every link to a
public-read tool (analytics, NFT verifier, protocol console) resolved
through a single URL helper. Rehoming the app was therefore a one-line
change of that helper's default plus an environment-variable rename, with
no call site touched. A cross-domain link turned out to be the entire
coupling between the two sites, exactly as intended when they were split.

Two consequences operators and users should expect. First, browser-stored
preferences do not survive the move: theme, Basic/Advanced mode, dismissed
notices and pending-action markers all live in per-origin browser storage,
and app.vaipakam.com is a new origin, so everyone starts from defaults
regardless of what the storage keys are called. Second, the scripted
Cloudflare frontend deploy — the only one in the repository, and formerly
`apps/defi`'s — was repointed rather than removed, so `deploy-chain.sh`,
`deploy-testnet.sh` and `deploy-mainnet.sh` still ship a frontend; the
per-app skip flag is now `--skip-app` and the phase is `cf-app`.

Two workflow display names deliberately keep stale text. A required status
check is keyed on the workflow's name, so renaming one strands it as
permanently pending and blocks every merge; `defi vitest` and
`alpha02 e2e (anvil fork)` therefore stay until branch protection is
updated by hand. Their files were renamed and every path filter and
package filter inside them was updated — only the two check-context
strings were left alone, each with a comment saying why.

Documentation that cited the deleted app by file path was repointed at
live successors rather than at git history. The published user guide told
advanced users to read two source files for the OpenSea listing path; both
died with `apps/defi`, so the guide now names the surviving reference for
each — the collection proxy the app reads collection fees through, and the
indexer-side publisher. The same sweep removed an English editorial note
that had been inserted into all ten translations of that guide. On the
internal side, the risk-committee sign-off questionnaire cited the deleted
app for its abnormal-market consent disclosure; its disclosure strings were
repointed to the marketing site, and the claim that consent *gates* offer
creation was re-verified against the connected app, where the refusal
actually lives. That correction matters on its own: the gate was previously
attributed to the disclosure text, but text cannot gate anything — the
validator refuses the form, and the accepted consent is recorded on-chain
with the offer, so it is auditable on the position rather than only in a
browser session.

Three follow-ups are left open rather than folded in. The operator must
create the app.vaipakam.com DNS binding and retire the four Workers whose
sources are now gone (`vaipakam-defi`, `vaipakam-alpha`, `vaipakam-alpha01`,
`vaipakam-alpha02`) — Cloudflare-dashboard actions, not repository changes.
A redirect from defi.vaipakam.com to the new origin is worth adding so
existing links and bookmarks survive. And `packages/defi-client` is now
orphaned: `apps/alpha01` was its only consumer. It is kept with its
description saying so, to be deleted if nothing adopts it.

Closes #1854.
