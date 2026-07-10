## Thread — S10 sanctions freeze now covers the inline-payout & collateral-sale channels (PR #<n>)

The S10 central-enforcement work (#1132) made the sanctions freeze **structural**
for one class of close-out: *deferred* payouts, where value sits waiting in a
claim record until the holder withdraws it. This change completes the picture by
covering the two remaining channels — the *inline* holder payouts and the
prepay-collateral-sale settlement — that pay a position holder immediately rather
than parking a claim for later. Together with #1132 this closes the S10 design's
"Invariant B."

**A build-time guardrail for inline payouts.** The register-coverage guardrail
that #1132 added (it fails the build if a close-out writes a deferred claim
without recording the fail-closed marker beside it) now has a second scan. This
one walks every production contract and flags any function that looks up the
current holder of a position and then pays that exact holder directly, unless the
payment goes through the sanctions-aware "pay-or-freeze" helpers or carries an
explicit freeze guard. Crucially the scan follows the payment even when the
"who is the holder" lookup and the actual transfer live in *different* functions
(a resolve-here, pay-there split), which is exactly the pattern a naive text
search would miss. A small, reasoned allow-list carries the three deliberate
exceptions — the discretionary partial-swap path (which hard-screens its payee),
the borrower's own-collateral return on an obligation transfer, and the
parallel-sale settlement (covered by the sync mechanism below). Any *new* path
that forgets the treatment now fails the build.

**A committed sanctions sync for collateral-sale listings.** The
prepay-collateral sale settles inside a marketplace order that pays the current
position holders directly, the instant before the loan flips to settled. Because
that settlement is atomic, a screen that merely *reverts* on a flagged recipient
would roll its own record back with the revert — so a first attempt during a
sanctions-oracle outage could block while leaving no trace, and a later attempt
could pay fail-open. This change adds two permissionless, non-reverting sync
entry points — one keyed by loan, one keyed by the sale offer (the pre-loan sale
surface has no loan to key on) — that anyone (a keeper, the counterparty) can
call. Each reads the live recipients the order pays, records any confirmed-flagged
recipient in the fail-closed registry, and cancels the listing so it can no longer
fill. The record persists because it is committed by this separate call, not
inside the atomic fill.

**A fail-closed backstop at the fill.** As defense in depth, the marketplace
fill screen and the parallel-sale settlement now consult the committed registry
in addition to the live oracle read. So even during an oracle outage, a recipient
the registry already knows to be flagged is barred from being paid — while an
honest, unflagged holder still settles normally through a brief oracle blip
(the check does not hard-fail on outage, only on a known-flagged recipient).

Observable behaviour is unchanged for everyone clean: a clean holder is never
barred and a clean listing is never cancelled (the sync self-heals a stale
marker on a clean read). Only a genuinely sanctioned recipient is frozen out.
Relates to #998, #1132; implements `docs/DesignsAndPlans/S10CentralEnforcement.md`
§2 Invariant B + Keystone. Closes #1144.
