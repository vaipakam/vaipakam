## alpha02 — extract the display strings the .tsx guardrail can't see

Switching the connected app's display language still left three
prominent surfaces in English even for a fully-translated locale: the
**Activity feed** (every row read "Offer created", "Loan started",
"Loan repaid", … from a hardcoded label map), the **loan-status
badges** shown on every position and history row ("Repaid",
"Defaulted", "Closed", "Being settled", "Past due"), and the **Claim
Center** batch labels ("Loan #N — your proceeds", "surplus after
liquidation", …). The cause was the same extraction gap #1329 chased,
but in a blind spot: these strings live in plain `.ts` modules
(`lib/activityView.ts`, `lib/loanState.ts`, `data/claimAll.ts`), and
the hardcoded-string guardrail only scans `.tsx`, so they never had a
catalog key and no locale could translate them. A user-facing "notice"
in the alerts card (shown when the alert service is mid-rollout) was
hardcoded the same way.

Every one of these now routes through the `copy.*` catalog. The pure,
unit-tested modules stay framework-free: `activityView`/`loanState`
keep an English fallback label and expose a stable key/state that the
rendering component resolves through the catalog, and `claimAll` takes
its label strings as an injected argument (defaulting to the English
source, so its existing tests and callers are untouched). The catalog
grew by ~60 string leaves — 48 activity event labels, six loan-status
words, eight claim phrases, and the alerts notice.

Parametrized labels ("Due in N days", "Loan #5 — your proceeds",
"Interaction rewards — X VPFI") remain English for now: the i18n
factory does not yet translate function-valued (interpolating) catalog
entries — the same platform limitation every existing `(n) => …`
helper has — so they are deliberately deferred, not missed. As with
#1329/#1330 the newly-extracted keys ship English-only and fall back to
English in every locale until translated (tracked in #1323 alongside
the remaining locale bundles).

The Activity label set also now covers every event kind the indexer
attributes to a wallet's own feed — nine reward / VPFI-vault / roll /
settlement-breakdown kinds (e.g. "Rewards claimed", "VPFI deposited to
vault", "Loan rolled over") that previously fell through to a humanized
English label in every locale.

To stop the activity-label map from silently drifting back out of the
catalog, a unit guard (`lib/activityView.test.ts`) now fails the build
if any `ACTIVITY_LABELS` kind lacks a matching `copy.activity.labels`
entry (or vice-versa), and — Codex #1343 r1 — if the label set doesn't
cover the indexer's full attributed-event set (the `pluckActivityRefs`
cases) — the same "can't drift" contract the notification and indexer
event maps carry.

Part of the #1329/#1323 extraction lineage (the `.ts`-module leg);
does not close #1323, which still tracks the locale bundle backfills
and parametrized-string translation.
