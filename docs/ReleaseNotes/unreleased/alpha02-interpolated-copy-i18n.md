## alpha02 — parametrized & inline copy made translatable (i18n interpolation)

Switching the connected app's display language previously left a large
class of text in English no matter how complete a locale's translation
was: parametrized catalog entries ("Due in N days", "You're on X, a test
network", the review-receipt lines) and interpolated notices built inline
in JSX ("You have N active positions", "Checking VPFI availability on
X…", every borrow/lend/rent receipt line). The i18n factory could only
translate plain string leaves — it passed function-valued catalog
entries straight through, and JSON locale bundles cannot carry
interpolation logic — so this text was English by architecture, not by
oversight.

This change makes all of it translatable. A new `tmpl(...)` catalog
primitive expresses a parametrized string as an i18next `{{var}}`
template (with locale-aware `_one`/`_other` plurals and `{{n, number}}`
number formatting) while keeping the existing positional call sites
unchanged. The i18n factory now binds each `tmpl` entry to its key and
resolves it through i18next, and the template exporter emits every one
into `en.json` so translators can localize it.

Every parametrized catalog function (about 105 of them) was converted,
and roughly seventy notices that were built inline in components — the
review receipts, the balance and availability hints, the claim-row
lines, the position summaries — were extracted into the catalog. The
handful of pre-submit guard errors thrown by the contract hooks now read
from the catalog too. Signing-critical text stays English by design:
EIP-712 domain names and the wallet-signed message bodies must match the
on-chain / backend verifier byte-for-byte, and chain and asset names are
proper nouns.

The hardcoded-string guardrail was extended to catch the exact blind
spot this class exploited — a backtick template whose literal text is a
real sentence — so a new interpolation-interspersed notice now fails CI
instead of silently shipping English. Running the extended check
immediately surfaced about fifteen more notices that a plain-text sweep
had missed, all now extracted.

The newly-added `{{var}}` keys ship English-first and fall back to
English in every locale until translated, tracked with the remaining
locale backfill (#1323). A separate follow-up covers the shared-library
contract-revert messages that alpha02 and the DeFi app display, which
live outside this catalog.

Part of the #1329 / #1323 extraction lineage; design in
[`docs/DesignsAndPlans/Alpha02InterpolatedCopyI18n.md`](../../DesignsAndPlans/Alpha02InterpolatedCopyI18n.md).
