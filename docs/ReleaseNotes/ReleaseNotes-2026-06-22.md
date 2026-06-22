# Release Notes — 2026-06-22

This is a catch-up assembly folding every behaviour-changing fragment that had
accumulated since the last dated release-notes file. The headline themes:

- **Position-transfer correctness — the eager-consolidation arc (#594 / #658 /
  #656 / #654 / #691).** Whenever a borrower or lender position NFT changes
  hands on the secondary market, the protocol now re-anchors that side's
  accounting — collateral lien, reward-accrual entry, and VPFI fee/stake
  checkpoint — to the *current* holder before the loan goes terminal, and
  before any collateral-sale listing binds to a vault. Every close-out family
  (repayment, HF / time / split liquidation, the multi-loan internal match,
  preclose, refinance) and every listing-creation path (fixed-price, Dutch,
  atomic OpenSea-match, auto-list-at-floor) is covered. NFT-rental income now
  follows the current lender-position holder too. A holder that is sanctioned
  or otherwise ineligible can never block a counterparty's close-out.
- **VPFI reservation hardening (#597 / #661)** against the unstake path, and a
  **backstop oracle-coverage gate (#638)**.
- **Risk-pricing & liquidation flexibility (#394 / #395 / #400 / #404)** —
  dual-factor risk premiums, graduated partial liquidation, a pluggable rate
  model, and the ossification roadmap.
- **Refinance carry-over correctness (#595).**



Risk pricing on Vaipakam now has **two independent, governance-tunable levers**,
where before it had hard-coded constants. Neither touches a human's typed
interest rate — market price-discovery stays the differentiator.

**Lever A — a runtime, range-bounded loan-admission Health Factor floor.**
Until now the minimum HF a loan must clear to be admitted was the fixed
`1.5` constant. It is now a governance knob (`RISK_ADMIN_ROLE`) tunable within
a hard `[1.2, 2.0]` band, defaulting to `1.5` so nothing changes until it is
deliberately moved. The protocol can now tighten admission in a volatile
regime, or loosen it for a proven-safe book, **without a contract redeploy**.

- The change is *branch-aware*: only the standard (non-depth-tiered) admission
  floor moves. The depth-tiered regime keeps its `1.0` not-born-liquidatable
  floor, and the **liquidation trigger** (`HF < 1.0`) is deliberately untouched
  in both regimes — so a retune can never make an open loan liquidatable.
- The floor applies only to loans admitted *after* a change; open loans were
  gated at their own admission time and are never retro-checked.
- Every place the protocol enforces the health floor — loan admission,
  collateral top-up cure, partial withdrawal, repay/swap-to-repay guards, and
  the min-collateral / max-borrow preview math — now reads the same runtime
  value, so they stay consistent with whatever admission is set to.

**Lever B — a deployable dual-factor risk-premium rate model.** Building on the
#400 pluggable rate-model substrate, a new `RiskPremiumRateModel` quotes
`reference + collateral-risk premium + tenor premium`:

- *Collateral risk* — keyed on the collateral's live liquidity tier (the same
  signal the depth-tiered LTV gate uses): thinner liquidity charges more, and an
  unknown / oracle-stale collateral charges the most (it fails *expensive*,
  never cheap).
- *Tenor* — a per-year premium applied pro-rata to the loan's duration, capped.

It is consulted **only on the automated / delegated lending path** (auto-lend /
keeper-AMM) — a human who types a rate still posts at exactly that rate. And
because it only ever *adds* to the live market reference, #400's deviation clamp
bounds its output to the market band: even a misconfigured premium can never
push an automated offer off-market. The model holds no funds and is a pure
view. It can also be wholesale-swapped by deploying a new model and
re-registering, and governance can revert to the identity model instantly in an
incident.

**Governance — two distinct authorities (don't conflate them):**

- *Lever A — the HF-floor knob* is a Diamond setter under `RISK_ADMIN_ROLE`
  (`RiskFacet.setMinHealthFactor`), hard range-bounded.
- *Lever B — the premium model* is a **standalone `Ownable2Step` contract**, not
  a Diamond facet. Its premiums are retuned by the **model's own owner** (the
  admin multisig → timelock) via its hard-bounded `setTierPremiumBps` /
  `setTenorPremium` setters — so the model *is* mutable, by its owner. Wiring it
  to (or off) the Diamond is a **separate** Diamond action under `AdminFacet`
  (`setRateModel` registers — `ADMIN_ROLE` → timelock; `disableRateModel`
  reverts to identity — a watcher/guardian fast-path). Operator runbooks must
  point premium retunes at the **model owner**, and register/disable at
  `AdminFacet` — not at `RISK_ADMIN_ROLE`.

The optimistic-delta / cooldown "risk-steward" machinery is intentionally left
to the governance track (#404).

### #395 — Graduated partial-liquidation sizing ("liquidate only as much as needed")

Intentional partial liquidation already restored an unhealthy loan to health by
selling the smallest collateral slice the keeper chose — but nothing stopped a
keeper from selling a *bigger* slice than the position needed, which is harsher
on the borrower than necessary. This change adds a borrower-protective guardrail
so a routine partial can't over-liquidate, while still letting a keeper act
decisively when a position is badly underwater or about to leave un-recoverable
dust.

After a partial, the loan's resulting health is now checked against a governance
**target ceiling** (default: health factor 1.20). If the partial left the
borrower comfortably healthier than that ceiling — i.e. it sold more than needed
— it is rejected and the keeper must pick a smaller slice. The ceiling is
**waived** in two cases so solvency and dust-cleanup are never blocked:

- **Deep underwater** — if the position was already below a configurable health
  threshold (default 0.95) before the partial, the keeper may delever
  aggressively to restore solvency.
- **Pre-existing dust** — when governance has switched dust handling on (it is
  off by default), a position that was *already* tiny at entry (debt or
  collateral below the dust floor) isn't blocked from clearing. This keys off
  the position's size *before* the partial, never the leftover after it, so a
  keeper can't manufacture a tiny leftover by over-selling and bypass the guard.

When dust handling is on, the reverse is also enforced: a routine partial may
**not** *leave* a fresh tiny position (both leftover debt and collateral below
the floor) out of a normal loan — it must use full liquidation instead, so no
un-liquidatable scrap is stranded. Dust handling is **off by default** because
the right floor depends on the active price numeraire, which a deployment can
rotate away from US dollars; governance sets an explicit floor to turn it on.

Finally, an intentional partial now **defers to the internal-match priority
window** exactly as full liquidation does — a keeper can no longer use a partial
to sell collateral externally while an internal match still has priority.

This only governs *how much* collateral a partial may sell; it never changes how
the loan is priced, and full liquidation remains available unchanged as the
alternative path. The existing dynamic liquidator bonus and the per-loan
bad-debt handling were reviewed against current best practice and kept as-is —
they already match it.

Three new governance parameters (target-HF ceiling, deep-underwater threshold,
dust floor) are set together via a single admin call, each range-checked; all
default to sensible values so the feature is active out of the box without any
configuration.

### #400 — Pluggable quote-time interest-rate model (the mechanism, identity by default)

Vaipakam's interest rate is set by the **human-driven P2P order book** — lenders
and borrowers post offers at the rate *they* choose, and the market clears
between them (a limit-order book for credit). That market price-discovery is the
core differentiator from pooled lenders that impose an algorithmic rate. This
change adds an *optional* pluggable rate-model substrate **without changing
that**: a human who types a rate still posts at exactly that rate.

What ships:

- An `IRateModel` interface — a pure, view-only quote function that, given an
  offer's create-time dimensions and a **reference rate**, returns a rate in
  basis points.
- A governance registry: governance can register one active model (a
  risk-increasing change → timelock + guardian-revocable after handover) or
  leave it unset. **Unset is the default — the "identity model" — so nothing
  changes on the live protocol until a model is deliberately registered.**
- A read-only resolver (`quoteOfferRateBps`) that returns the reference rate
  verbatim when no model is set, else the model's quote.

How it's used — deliberately **not** by overwriting human offers:

- **Manual offers stay human-priced.** The rate a person types is binding and is
  never transformed on-chain. The model is, at most, a *suggestion* the dApp can
  show — which the person can take or ignore.
- **Automated / delegated pricing is where the model does the work** — auto-lend,
  auto-roll, and keeper-posted standing intents (where the user opted into having
  their liquidity priced for them). Those flows call the resolver and post the
  quoted rate themselves. This is the legitimate, fixed-rate-safe "keeper-AMM":
  automated price-discovery layered *on top of* the human market, not a protocol
  rate decree.
- **Signed offers** carry the offerer's client-quoted rate inside their
  signature, so the model is applied off-chain before signing.

Safety / anti-rate-setting hardening:

- A model only ever sets the value written into a *new* offer; a matched or live
  loan's rate is never re-priced (it's snapshotted immutably at initiation).
- **Deviation cap (on-chain).** The resolver clamps a model's output to within
  a governance-set band (±5% by default, tunable 0.5%–25%) of the reference
  rate. So a registered model — even a buggy or adversarial one — can only nudge
  the rate around the supplied market anchor; it can never drive an automated
  offer far off-market. This guarantee lives in the substrate, so every consumer
  inherits it rather than each having to re-implement it.
- **Enable-slow / disable-fast.** Registering a model is admin-gated (→ timelock
  after handover, a risk-increasing change); disabling it back to identity is a
  fast path a watcher/guardian can flip instantly in an incident.
- Automated callers must still anchor the reference to the **live cleared-market
  rate** (the clamp then bounds drift from the real market) — a requirement on
  the consumer work (risk premiums / auto-lend); this change ships only the
  mechanism and never auto-posts on its own.

### #404 — Published ossification roadmap + guardian-pause framing

Vaipakam now publishes an **ossification roadmap** (`docs/DesignsAndPlans/OssificationRoadmap.md`)
— a plain-English, honest commitment about which protocol rules can still
change, who can change them, and behind what delay. It does **not** claim an
immutable core (the protocol is fully upgradeable today, on purpose, pre-audit);
instead it commits to a staged, milestone-gated freeze and frames the guardian
guarantee around primitives that already exist.

What it tells a reader:

- **The guardian fast-pause already exists.** The asymmetric `PAUSER` (fast
  pause, guardian Safe) / `UNPAUSER` (slow unpause, timelock) split is the
  guardian-pause the design called for — no new role invented.
- **Staged freeze, ordered by trust.** Fund-custody + core accounting freeze
  first; curation parameters stay bounded-upgradeable. The freeze is
  milestone-gated (audit sign-off → published mainnet bake → renounce), with no
  calendar dates committed before the audit.
- **Honest gaps, named not hidden.** The document explicitly discloses where the
  current guarantees rest on multisig honesty rather than code — the root
  `DEFAULT_ADMIN`/`ADMIN` timelock-bypass (role-grant + `transferAdmin`), the
  arbitrary-address oracle / rate-model / executor-pointer setters, the
  per-notification fee debit that sits outside the timelock, and every
  cross-chain and UUPS upgrade surface that must be frozen alongside the Diamond
  cut path.

Two hardening follow-ups were filed from the review: reconciling the legacy
handover script so it can't leave the unpause key on a hot wallet (#650), and a
code-derived census so the freeze/allowlist scope provably covers every
custody-moving surface (#651).

No contract behaviour changed — this is a published commitment and an accurate
trust-surface map.

### #594 (PR 2/3) — auto-consolidate a transferred position on borrower-side actions

PR 1 shipped the consolidation primitive plus the proactive
`consolidate…ToHolder` entry points. This PR makes consolidation **automatic**
on the borrower side: whenever the current holder of a transferred position
performs an active borrower action, the protocol first pulls that loan's
collateral into the holder's own vault (re-keying the lien and re-pointing the
loan's custody anchor) so the action then operates on an ordinary loan instead
of the keep-collateral-in-the-original-vault special case.

Wired into the borrower-side mutations:

- **Partial collateral withdrawal** and **add-collateral** (the latter
  *after* its FallbackPending cure, so a just-cured loan consolidates) — the
  collateral now lives in the holder's vault before the withdraw/top-up math.
- **Partial swap-to-repay** — the swap operates on the holder's consolidated
  vault.
- **Swap-to-repay intent commit** — consolidates before the commit pulls the
  collateral into protocol custody.
- **Swap-to-repay intent cancel / force-cancel** — consolidates *after* the
  teardown returns the collateral, which otherwise re-strands it in the
  departed owner's vault for a transferred position.

For a position that has **not** transferred, every hook is a no-op (a single
ownership check), so existing flows are unchanged — confirmed by the full
existing test suites for the touched facets passing untouched.

Sanctions safety is **conservative-safe**. Moving a transferred position's
collateral *out* of its (possibly later-flagged) original vault to the current
holder is allowed — that is the de-risking direction the policy wants. But the
protocol never *credits or strands* funds in a flagged vault: in the narrow
cases where the consolidation itself can't run in the same action — a
FallbackPending top-up too small to cure, or an intent cancel while a prepay /
parallel-sale listing is still recorded — and the original anchor has since been
sanctioned, the host action **reverts** rather than depositing into that flagged
vault (the funds stay put — in the borrower's vault or in Diamond custody —
nothing is lost). Letting those actions proceed for a flagged-and-stale anchor
is a tracked liveness follow-up (#658); all of it is dormant until the sanctions
oracle is configured.

When a transferred position is collateralised in VPFI, the holder's VPFI
fee-tier and staking credit are re-stamped *after* the withdraw/swap/commit, so
they never carry credit for VPFI that has left their vault.

The full swap-to-repay and the prepay-listing creation paths are wired in the
remaining PRs / follow-up (see #656); lender-side and both-side close-out
wiring lands in PR 3.

### #594 (PR 3/3a) — auto-consolidate on the two most common loan terminations

Following PR 1 (the primitive) and PR 2 (borrower-side mid-life actions), this PR
makes consolidation automatic on **both sides** for the two most common ways a
loan ends — voluntary repayment and time-based default — so a transferred
position routes its proceeds and collateral to the *current* holders rather than
the departed owner.

Wired (consolidating **both** the borrower and the lender side, since these
close-outs settle lender economics through the stored lender as well as return
collateral to the stored borrower):

- **Full repayment** and **partial repayment** — lender proceeds (and the
  partial path's `lenderShare`) now route to the current lender holder, and the
  collateral returns to the current borrower holder.
- **Time-based default** — the liquidation proceeds / illiquid-collateral
  transfers route to the current holders on both sides.

As before, every hook is a no-op for a position that has not transferred, and it
never blocks the close-out: a sanctioned or excluded holder simply skips
consolidation and the termination proceeds under its own rules. No existing
behaviour changes for ordinary (non-transferred) loans — confirmed by the full
existing repay and default test suites passing untouched.

Sanctions safety on these eager paths is preserved end-to-end. A position
whose departed (now-stale) owner is sanctions-flagged *after* the transfer no
longer bricks the close-out: moving the asset *out* of that owner's vault to
the current (sanctions-checked) holder is the de-risking action the policy
wants, so it is allowed, while a sanctioned *current* holder is still kept from
receiving funds (the partial-repayment payout refuses a flagged recipient, and
every consolidation still blocks/skips a flagged incoming holder per its tier).

The remaining close-outs — HF-liquidation, internal-match and split liquidation,
early-withdrawal sale, preclose, periodic settlement, in-place extension, full
swap-to-repay, intent settlement, and refinance — are tracked in #658, together
with the architectural note that the size-constrained liquidation facets need a
cross-facet entry point (the consolidation logic inlines into each caller, and
those facets are already at the contract-size limit).

### #594 (PR 1/3) — collateral/principal consolidation to the position-NFT holder: the primitive

When a position NFT is transferred, the underlying vaulted assets cannot move
with it (an ERC-721 transfer can't carry ERC-20/721/1155 balances), so they stay
in the *original* vault and the loan's custody anchor diverges from the current
holder. The funds were already safe (the close-time claim path + the encumbrance
lien protect them), but the divergence forced a "borrower-pin" special case
through every mutation path. #594 removes that by **consolidating** a transferred
position into the current holder's vault, restoring an ordinary loan.

This first PR ships the **primitive and the two standalone entry points** — the
eager (automatic) wiring at lifecycle events lands in the follow-up PRs.

What a user/operator can now do:

- **`consolidateCollateralToHolder(loanId)`** / **`consolidatePrincipalToHolder(loanId)`**
  — a position-NFT holder can proactively pull a transferred loan's collateral
  (or held lender proceeds) into their own vault. The collateral physically
  moves vault-to-vault inside the protocol (never to a wallet), the encumbrance
  lien re-keys to the new owner with the aggregate conserved, the loan's custody
  anchor re-points to the holder, and the reward / metrics / VPFI-tier accounting
  follows. After it runs, the position is indistinguishable from one that never
  transferred.

How it stays safe:

- The asset move is gated so it can only ever deliver value to the **rightful
  current holder** (resolved on-chain from the position NFT), never redirect it.
- A transferred position that is mid-flight in a special state — awaiting
  liquidation fallback, carrying a live collateral-sale listing, or inside a live
  swap-to-repay intent — is **skipped**, not forced; those are handled by the
  paths that already own them.
- The protocol's transient hold of an NFT during a vault-to-vault move is
  **pinned to the exact expected token** and released on first receipt, so the
  protocol never becomes an open NFT sink.
- A sanctioned holder is rejected on the proactive path; the equivalent
  automatic path (a later PR) will simply skip rather than block a close-out, in
  line with the retail sanctions policy.

No existing behaviour changes — this adds new, opt-in entry points. Internal
plumbing only: no migration, and the standalone calls are holder-only.

## Thread — Carry-over-aware matched refinance (PR #<n>)

Refinance-tagged carry-over offers can again be filled through the
range-orders / partial-fill matcher (`matchOffers`), not only by direct
accept. PR #593 had disabled them there after two bugs were found
(an uncollateralized-loan window, and a collateral-divergence that made
valid offers unfillable); this re-enables the path safely, against a
design spec that passed a four-round adversarial review.

The key idea is that a refinance is intrinsically all-or-nothing — one old
loan, one collateral lien, one retag — so a carry-over offer is admitted to
the matcher only as a single full (AON) fill. That makes the fill reach the
existing atomic retag in the same transaction (no uncollateralized window),
and it keeps the model coherent (a partial fill would create more than one
replacement loan for a single old lien). The matched collateral is pinned to
the carried amount and the risk check runs on that pinned value, so a lender
asking for less collateral than the loan already carries no longer makes the
offer unfillable; a lender asking for *more* than the carried amount is
cleanly rejected (carry-over pledges no fresh collateral to top up).

Crucially, the matcher's admission test is a faithful mirror of every
precondition the atomic accept-and-refinance path enforces — target still
active, offer creator still the current borrower-position holder, the amount
still equal to the loan's outstanding principal, auto-refinance caps and the
kill-switch satisfied, no pending periodic-interest settlement, no live
swap-to-repay intent, and the strict same-key lien retag still possible — so
a keeper's preview never reports a match that would then revert on-chain. A
carry-over offer's amount is frozen while it stays refinance-tagged (cancel
and re-create to retarget), and a carry-over offer is all-or-nothing
single-value from creation. Closes #595.

### #597 — reserve held-for-lender VPFI against the unstake path

When a lender's obligation is transferred or offset to a new offer mid-loan, the
amount owed to that lender is parked in their vault as a "held-for-lender"
balance and paid out later when the position holder claims. Previously, when
that held balance was in VPFI, nothing stopped the lender from immediately
unstaking it back out of their vault before the claim — so a departing lender
could withdraw funds that were already earmarked for whoever holds the position.

This change reserves those held-for-lender VPFI balances against the unstake
path the moment they accrue, exactly like the lender's proceeds on a normal
loan close are already reserved. The reserved amount is invisible to the
"withdraw my staked VPFI" path until the position holder claims it.

Because a loan can change hands, the reservation follows the funds:

- On obligation-transfer and offset, the loan keeps its lender, so the
  reservation simply sits with that lender until claim.
- When a lender sells the loan to a new lender, the held VPFI physically moves
  to the new lender's vault, and the reservation is re-keyed to the new lender
  in the same step — so the old lender can never unstake it on the way out, and
  the new lender's claim is fully backed.

No change for non-VPFI held balances (only VPFI has a user-facing unstake path)
and no change for loans that never accrue a held-for-lender amount.

## Thread — Backstop-only minimum oracle-coverage gate (PR #<n>)

The general, permissionless Vaipakam protocol does not gate which assets can
be used as collateral, and that stays true: an asset whose secondary oracles
are unset still rides the Soft-2-of-N quorum's single-feed soft fallback, and
the general liquidation / liquid-classification path is unchanged. Asset
eligibility on the general path remains ungated (owner direction, 2026-06-19).

Where protocol money is at stake, though, gating is legitimate. The
treasury-seeded backstop puts *protocol* funds on the line when it becomes a
loan's counterparty (Role A) or absorbs a defaulted loan's collateral with
treasury cash (Role B). This change adds an **opt-in, governance-set,
backstop-scoped** minimum-oracle-coverage requirement: governance can configure
the backstop to refuse collateral priced by fewer than N live secondary feeds
(Tellor / API3 / DIA), so the treasury is never left holding single-feed-priced
collateral. A feed counts as "live" when it is configured, fresh, and reporting
a non-zero value — independent of whether it currently agrees with Chainlink.

The knob defaults to 0 (no requirement), so an unconfigured backstop behaves
exactly as before. It is read **only** by the two backstop paths; it never
touches `getAssetPrice`, `checkLiquidity`, or any general liquidation entry
point. The setter is admin/governance-gated and range-bounded to the three
available secondaries. Closes #638.

## Thread — NFT-rental daily fee follows the current lender-position holder (PR #<n>)

Fixes a fund-misrouting bug surfaced during the #594 design review: the
permissionless daily rental deduction (`autoDeductDaily`) paid each day's lender
share **directly to the stored `loan.lender`**, with no claim indirection. So
after a lender-position NFT was sold or transferred on the secondary market, the
daily rental income kept flowing to the **departed** lender instead of the
current holder.

The daily deduction now routes the lender's share to the current
`ownerOf(lenderTokenId)` resolved at payment time, with the same direct-recipient
sanctions gate the other direct-payout paths use — mirroring
`_autoLiquidatePeriodShortfall` and `RepayFacet.repayPartial`. The loan is Active
when the daily fee is taken, so the lender position NFT is live and `ownerOf`
holds.

The other rental lender paths were already correct and are unchanged: full
`repayLoan` and `markDefaulted` deposit the lender's share into the lender vault
and write a `lenderClaims` row, which the current holder pulls through the
`ownerOf`- and sanctions-gated `ClaimFacet.claimAsLender`; the rented NFT itself
likewise returns to the current holder through that same gated claim. Only the
direct-payout daily path needed the current-holder routing.

This is the lender-side analogue of the borrower-side drain protection — the
rental income stream now follows position-NFT ownership over the life of the
loan (earlier days to the old holder, later days to the new one).

Closes #654.

## Thread — LibPrepayOrder: bundle the order-spec scalars into a memory struct (PR #<n>)

Pure refactor of the canonical Seaport `OrderComponents` builder, with **no
behaviour change** — every prepay listing's derived orderHash is byte-identical
(the fixed-price, Dutch, atomic, cancel-reconstruction, and parallel-sale suites
all stay green).

The builder `LibPrepayOrder._componentsAtMemory` took nine scalar order-spec
arguments (`startAskPrice`, `endAskPrice`, `lenderLeg`, `treasuryLeg`, `salt`,
`conduitKey`, `startTime`, `seaportEndTime`, `counter`) and — because the whole
`buildAndHash*` → `_componentsAtMemory` chain is `internal`/`private` and inlines
into each listing facet — those nine values lived as nine simultaneous stack
slots in the flattened frame, holding the NFT-prepay listing compilation unit at
the exact viaIR whole-unit stack ceiling. Any addition anywhere in that unit
overflowed it.

They're now bundled into an `OrderSpec` memory struct, read on-demand (one
`mload` each at use) instead of nine live stack slots. The public builders
(`buildAndHash`, `buildAndHashMem`, `buildAndHashDutch`, `componentsForCancel`,
`componentsForCancelDutch`) keep their scalar signatures — each just packs its
scalars into an `OrderSpec` before the private build — so callers and the
orderHash inputs are untouched; only the two private helpers (`_componentsAtMemory`,
`_componentsAtCalldata`) changed shape.

This recovers the whole-unit slack needed to wire the #594 consolidate-before-
listing hooks (the #656b prerequisite — #697). Confirmed: with this lean the
fixed-price `postPrepayListing` consolidate hook now compiles where it previously
tipped `_componentsAtMemory`. (The Dutch / atomic / auto-list *entry* functions
carry their own separate per-function ceilings, addressed in #656b.)

Closes #697 (#656a). Prerequisite for #698 (#656b).

## Thread — Consolidate-before-listing on the fixed-price + parallel-sale paths (PR #<n>)

Part of #698 (#656b), unblocked by the #697 (#656a) `LibPrepayOrder` lean.

When a borrower position is transferred on the secondary market and the new
holder lists the collateral for sale, the listing-creation path must consolidate
the borrower side to the current holder *before* it caches the holder's vault —
otherwise the listing binds the departed borrower's vault and, once the listing
hash is set, every later borrower-side consolidation is `_isExcludedLive`-skipped
(the position locks out of consolidation).

This wires the #594 borrower-side eager consolidation into the two paths that fit
within the recovered whole-unit stack slack:

- **`NFTPrepayListingFacet.postPrepayListing`** (the dominant fixed-price path) —
  after the holder check, before the order is built + the vault cached. No live
  listing hash exists there (the lock-check guarantees it), so the consolidation
  fires.
- **`OfferParallelSaleFacet.releaseParallelSaleLock`** — after the offer-keyed
  listing lock is cleared (so the borrower side is no longer excluded), if the
  offer has become a loan, consolidate it to the current holder.

Both use the few-byte cross-facet `ConsolidationFacet.eagerConsolidateToHolder`
(Tier-2 skip-not-block); no-op when not transferred or terminal.

**Deferred to #656c** (each needs its own entry-function stack lean, analogous to
#656a, because those entry functions sit at their own per-function viaIR
ceilings): `postPrepayDutchListing` (the 12-arg Dutch builder call), the atomic
`matchOpenSeaOffer` rotation, and `autoListAtFloorOnGrace` (the `_caseBRotate`
marshalling). The lock-out remains mitigated for all paths by the close-out
clear-then-consolidate (`precloseDirect`, #690) until those land.

Part of #698.

## Thread — Consolidate-before-listing on the Dutch / atomic / auto-list paths (PR #<n>)

Part of #698 → tracked to completion under #700 (#656c); closes out the
consolidate-before-listing family (#656). Builds on the #697 (#656a)
`LibPrepayOrder` lean and the #701 (#656b) fixed-price + parallel-sale hooks.

When a borrower position is transferred on the secondary market and the new
holder lists the collateral for sale, the listing-creation path must
consolidate the borrower side to the current holder *before* it caches the
holder's vault — otherwise the listing binds the departed borrower's vault and,
once the listing hash is set, every later borrower-side consolidation is
`_isExcludedLive`-skipped (the position locks out of consolidation). #656b
wired the two paths that fit within the recovered whole-unit stack slack; this
wires the remaining three listing-creation entries, each of which sat at its
own per-function viaIR stack ceiling and so needed a dedicated per-entry stack
lean before the one-line hook would fit:

- **`NFTPrepayDutchListingFacet.postPrepayDutchListing`** — consolidate after
  the holder check, before the Dutch order is built + the vault cached.
- **`NFTPrepayListingAtomicFacet.matchOpenSeaOffer`** — consolidate after STEP 0
  auto-clears any pre-existing v1 listing (so the borrower side is no longer
  excluded) and before the counter-order is built.
- **`NFTPrepayAutoListFacet.autoListAtFloorOnGrace`** — consolidate on the
  Case-A (fresh-post) path only, before the holder's vault is cached. Case B
  (rotation of an existing listing) needs no consolidation: a live listing
  locks the borrower NFT, so the position cannot have been transferred since
  the listing was created — whichever creation path posted it already
  consolidated.

All three use the few-byte cross-facet `ConsolidationFacet.eagerConsolidateToHolder`
(Tier-2 skip-not-block); no-op when the position hasn't been transferred or the
loan is terminal.

**Stack leans applied to fit the hooks (no external ABI change; the Seaport
orderHash each path produces is byte-identical):**

- Dutch — the post + update builders were unified into one private
  `_buildAndRecordDutch(..., bool lockNft)` called from both entries; the
  two-call-site shape stops the optimizer from inlining the heavy `recordOrder`
  marshalling back into either entry frame, and the order scalars now ride
  through a small `DutchParams` memory struct.
- Atomic — the canonical `PrepayListingMatched` event is now emitted BEFORE the
  `_settle` (`matchAdvancedOrders`) interaction rather than after. This is
  CEI-compliant (every field is already established by the counter-order
  record) and keeps the event payload off the stack across the heavy `_settle`
  marshalling. On revert the whole tx reverts, so observers only ever see the
  event on success; the topic-hash-keyed indexer is insensitive to intra-tx log
  ordering.
- Auto-list — the `_orderProtocolLegs` + `OrderContext` reads (consumed only by
  the B-cond rotation gate) were moved from `_caseBRotate` into
  `_pickBCondReason`, confining them to that frame so they no longer sit live
  across the snapshot→gate→rotation span. Both reads still run before
  `clearOrder`, so the pre-clear snapshot semantics are unchanged.

**Test coverage** — new transferred-position integration tests assert the
end-to-end mechanism (borrower side re-anchors to the current holder, the
collateral physically moves into the holder's vault, and the listing is bound
to that vault) for the fixed-price (`postPrepayListing`, #698), Dutch
(`postPrepayDutchListing`), and auto-list Case-A (`autoListAtFloorOnGrace`)
paths. The atomic `matchOpenSeaOffer` success path is fork-only (the unit
`MockSeaport` does not implement `matchAdvancedOrders`; the happy path lives in
`SeaportAtomicMatchForkTest`), so its transferred-position assertion is a
follow-up in that fork suite; the hook itself is placed identically to the
other paths (before the counter-order's vault read) and the shared
consolidation primitive is exhaustively covered by `CollateralConsolidation`.
The full prepay/Dutch/atomic/auto-list/parallel-sale suites stay green,
confirming the per-path leans leave the Seaport orderHash byte-identical.

No diamond cut, no selector/error/event signature change, so no ABI re-export.

Part of #656.

## Thread — Eager consolidation for the liquidation close-out family (PR #<n>)

This continues the #594 "eager consolidation" arc, which makes a
transferred loan position follow its current NFT holder. When a borrower
or lender transfers their position NFT, the underlying collateral /
principal must be re-anchored to the new holder before any close-out
event distributes funds — otherwise proceeds and surplus would still pay
the departed party. PR-1/PR-2/PR-3 wired this for the repay, default,
preclose and borrower-side paths; this PR extends it to the HF-based
liquidation family.

The architectural wrinkle is the EIP-170 facet-size limit. The
consolidation orchestrator (`LibConsolidation.consolidateToHolder`) is an
`internal` library function, so it INLINES its full body (~5 KB) into
every facet that calls it. `RiskFacet` sits only a few hundred bytes
under the 24,576-byte limit and cannot absorb that. The fix is a thin
internal-only entry point on `ConsolidationFacet`
(`eagerConsolidateBothSides`) that the orchestrator is inlined into ONCE;
size-constrained hosts reach it through a few-byte cross-facet call. The
new entry is gated to the Diamond's own internal calls
(`OnlyDiamondInternal`) and uses the Tier-2 "skip, never block a
close-out" sanctions semantics, so a sanctioned or excluded holder can
never brick a liquidation. `triggerLiquidation`,
`triggerPartialLiquidation`, `triggerLiquidationDiscounted` (RiskFacet)
and `triggerLiquidationSplit` (RiskSplitLiquidationFacet) now consolidate
both sides at the point they commit to liquidating — before the
internal-match dispatch and swap settlement.

A VPFI-collateral subtlety: when a transferred-position loan is backed by
VPFI, the eager consolidation checkpoints the current holder's fee-tier /
staking credit at the full pre-liquidation balance, but the liquidation
then withdraws that VPFI out of the holder's vault. Each liquidation path
now re-stamps the holder at the reduced balance after the withdrawal (via
a second internal-only ConsolidationFacet entry), so the holder cannot
retain tier/staking credit for VPFI that has already left — the same
invariant the eager-withdraw hosts (AddCollateral / SwapToRepay /
PartialWithdrawal) already preserve.

Scope: this PR is PR-A of #658 — the cross-facet entry plus the
size-constrained liquidation family (the architecturally-motivated core).
The remaining close-out hosts (EarlyWithdrawal lender-side, Preclose,
periodic-interest, in-place extension, swap-to-repay-full, intent
settlement, refinance) and the multi-loan internal-match liquidation path
follow as PR-B. Part of #658; #658 stays open until PR-B lands.

## Thread — Eager close-out consolidation for direct preclose + refinance (PR #<n>)

Continues the #594 "eager consolidation" arc (#658 umbrella). On every
close-out, a transferred loan position is now consolidated to its current
NFT holder *before* the loan goes terminal, so the collateral lien, the
reward-accrual entry, and the VPFI fee/stake checkpoint follow the live
holder rather than staying stranded on the address that originally opened
the position.

This PR extends that hook to two more hosts:

- **`PrecloseFacet.precloseDirect`** — a both-side close-out. Both the
  borrower and lender sides are consolidated to their current holders
  while the loan is still Active (the consolidation primitive is a no-op
  once a loan is terminal, so it must run before the Active→Repaid flip).
  Direct preclose moves no collateral out of a vault — the borrower's
  collateral stays in place as a `borrowerClaims` row, withdrawn later by
  `claimAsBorrower` — so no post-withdrawal VPFI re-stamp is needed here.

- **`RefinanceFacet.refinanceLoan`** — the **lender side always** (the old
  lender exits in every refinance: it is paid out via `lenderClaims` and the
  old loan closes, so its reward entry + VPFI checkpoint repoint to the
  current lender-NFT holder). The **borrower side is consolidated only on
  the non-carry-over path** (transferred / untagged / ranged offer), where
  the old collateral is returned and the old loan closes for the borrower
  too — so its lien / reward / VPFI follow the current holder and the
  borrower-LIF rebate prices from that holder. On the carry-over path the
  borrower stays and its collateral re-tags into the new loan (#576), so a
  borrower-side consolidation there is skipped (it would be a no-op at best
  and fight the re-tag at worst). On the non-carry-over path the old
  collateral is then returned to the holder, so when it is VPFI the path runs
  a post-withdraw VPFI re-stamp (the same one the liquidation hosts use) so
  the holder doesn't keep fee-tier / staking credit on VPFI that has left the
  vault.

Both hooks use the few-byte cross-facet consolidation entry (both facets
are size-tight) with Tier-2 "skip-not-block" semantics — a
sanctioned/excluded holder never bricks a close-out.

Direct preclose leaves the position's payouts to be claimed later via
`ClaimFacet`; both claim paths now run a post-withdraw VPFI re-stamp after VPFI
leaves the vault, so a holder can't keep fee-tier / staking credit on VPFI that
has been claimed out. On the borrower side (`claimAsBorrower`) this covers VPFI
in any of its three forms — collateral, a VPFI principal-surplus claim row, or a
still-liened VPFI top-up paid via the extra-lien path. On the lender side
(`claimAsLender`) it covers VPFI proceeds and a `heldForLender` top-up. Both use
a general user-keyed restamp, gated on the actually-withdrawn asset so the common
non-VPFI claim never reaches the consolidation facet. **NFT-rental loans are out of scope** for this consolidation —
the underlying primitive only handles ERC20 loans, so a transferred rental
position keeps its position effects on the stored anchor (consistent across
the whole #594/#658 arc).

**Funds were never at risk** on these paths: every payout already routes
to the current holder through the `lenderClaims` / `encumberLenderProceeds`
→ `ClaimFacet` reservation and `claimAsBorrower`, all `ownerOf`- and
sanctions-gated. This change closes the remaining **position-effect
accounting** gap (reward/VPFI/lien following the holder), not a
fund-misrouting gap.

**Scope notes / deferrals (Part of #658, not Closes):**

- `EarlyWithdrawalFacet` (`sellLoanViaBuyOffer` / `completeLoanSale`) is
  **already integrated** with the #594 consolidation primitive (via
  `s.consolidationMoveFromUser`) — it is a loan-*sale* path (the lender
  position migrates to a new lender and the loan continues), not a missing
  close-out host, so no change was needed.
- `PrecloseFacet.transferObligationViaOffer` / `offsetWithNewOffer` are
  obligation-transfer paths (the position migrates / the loan continues)
  and are tracked for a focused follow-up rather than treated as plain
  both-side close-outs.
- The **multi-loan internal match** (`RiskMatchLiquidationFacet`) eager
  consolidation is **deferred** to a dedicated follow-up. The 3-way
  executor sits at the exact viaIR per-function stack ceiling: it compiles
  with zero slack today, and *any* contract-level addition (even an
  un-hooked one) tips the inlined function over. Closing it cleanly needs a
  per-function stack reduction (a lean struct-return DTO + settle-helper
  refactor of the executor), which is too invasive to bundle here for a
  position-effect-only improvement on the rarest liquidation path. The
  internal-match proceeds are already current-holder-safe via #585
  `lenderClaims` + `claimAsBorrower`.

### #661 — reserve a borrower's VPFI default surplus against the unstake path

When a loan is liquidated or defaults and the collateral is worth more than the
debt, the leftover surplus is returned to the borrower's vault and paid out
later when the position holder claims it. Previously, when that surplus was in
VPFI, nothing stopped the borrower from immediately unstaking it back out of
their vault before the claim — so a borrower who had transferred their position
could withdraw funds that were already earmarked for whoever holds the position.

This change reserves the VPFI surplus against the "withdraw my staked VPFI" path
the moment it lands, exactly like the lender's proceeds are already reserved on
a close. The reserved surplus is invisible to the unstake path until the current
borrower-position holder claims it, at which point it is released and paid out
atomically. It is wired on every path that can return a surplus — time-based
default and both the standard and split liquidations.

No change for non-VPFI surpluses (only VPFI has a user-facing unstake path) and
no change for loans that close with no surplus.

## Thread — Eager consolidation for the multi-loan internal match (PR #<n>)

Completes the #594 / #658 eager close-out consolidation arc. The multi-loan
internal-match liquidation path — where two loans (or three in an A→B→C→A
chain) that are liquidatable in opposing directions settle against each other
at oracle price instead of through an aggregator — now consolidates every
participating loan to its current position-NFT holder before it settles. So a
transferred borrower or lender position carries its collateral lien,
reward-accrual entry, and VPFI fee/stake checkpoint to the live holder, exactly
like the other close-out hosts. Each leg's VPFI is also re-stamped after its
collateral leaves the vault. This was the last host in the arc; the platform's
close-out consolidation guarantee now spans the whole family.

**Why it was deferred until now (and how it was unblocked):** the internal-match
executors sit at the exact viaIR per-function stack ceiling — the 3-way executor
compiled with zero slack, so any added local (the consolidation hook) overflowed
it. The fix returns the per-leg moved/incentive amounts in a lean **memory
struct** instead of a six-value stack tuple: the values live in memory rather
than on the stack at the (inlined) call boundary, and each is written as
computed so all six are never live at once. That freed the headroom for the
consolidation + restamp hooks. The matchable/incentive scratch values were also
block-scoped, and the post-settle restamps keyed off the live loan-struct
pointers, to keep the deep tail under the limit.

**Funds were never at risk** on this path — internal-match proceeds already
reached the current holder through the standard `lenderClaims` / `claimAsBorrower`
claim path (`ownerOf`- and sanctions-gated). This change closes the remaining
position-effect accounting gap. FallbackPending legs are a benign no-op (their
collateral is in Diamond custody and the consolidation primitive excludes them).

Closes #691. Part of #658.
