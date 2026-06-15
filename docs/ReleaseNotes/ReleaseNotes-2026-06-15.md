# Release Notes — 2026-06-15

This release closes out the **encumbrance / internal-match arc**. On the
contract side: lenders of refinanced loans keep their collateral carry-over
correctly (#576), the internal-match lender-side lifecycle and its top-up-aware
unwind are complete so a fallback-pending loan that received an extra collateral
top-up can be matched and have that top-up returned to the right party
(#585 / #591), and VPFI lender-proceeds are reserved against the unstake path on
every terminal so a transferred-away lender can't drain them (#592). To stay
within deploy limits, RepayFacet's periodic-interest / NFT-rental cluster moved
to a new RepayPeriodicFacet, and the paginated dashboard views now return lean
summaries (#601). On the app side, the dapp now surfaces the on-chain lien
records so both parties can see — and the lender can prove — that collateral and
principal are provably locked (#564).

## Thread — dapp surface for collateral lien (PR #564)

The web app now surfaces the on-chain encumbrance (lien) records that the
`MetricsFacet` views already expose, so both sides of a loan can see —
and the lender can independently prove — that collateral and principal are
provably locked while a loan or offer is live. This is a read-only
frontend change: it consumes existing on-chain views and adds no contract
behaviour.

Three surfaces gained lien awareness. The Loan Details page now renders a
"Collateral backing this loan" card to either party of a loan, reading
`getLoanCollateralLien(loanId)`. It shows the encumbered asset, amount,
lien status (Active vs Released) and the vault the collateral is locked in.
The copy adapts to the viewer: a lender sees a provability message plus a
block-explorer deep-link to the locked-balance owner as the on-chain proof
anchor, while a borrower sees a warning that the collateral stays locked
until they repay, refinance, or default — and that direct withdrawals of
the locked amount revert until then. The card renders nothing when there
is no live lien.

The Vault page now breaks each token balance into Total / Locked / Free,
reading `getEncumbered(user, asset, 0)` alongside the existing balance
reads and computing the withdrawable free balance as the total minus the
locked portion (floored at zero). When a balance is fully locked the row
shows a "fully locked" status; this page has no per-row withdraw control
of its own (withdrawals run through the staking flow), so the gate
surfaces as a read-only indicator rather than a disabled button. The
Offer Details page reads `getOfferPrincipalLien(offerId)` and, for an
accepted offer viewed by its creator (the lender), adds a "Locked
principal" row showing the still-locked principal amount.

Closes #564. The D.3 NFT-metadata work in the issue is contract/worker-
side and intentionally out of this frontend scope. Note: the apps/defi
vitest page suite remains affected by the pre-existing Issue #85 harness
breakage (CI gates these on `tsc` only); the new isolated
`CollateralLienCard` component test passes against a working test
environment, and the added LoanDetails page-test assertions follow the
existing mock pattern so they go green once #85's harness fix lands.

## Thread — Refinance collateral carry-over (PR #576)

Refinancing a loan used to make the borrower lock collateral **twice**.
Creating the refinance offer pre-vaulted a fresh full collateral batch,
the new loan was built on that fresh collateral, and the old loan's
collateral was then withdrawn back to the borrower — so mid-refinance the
borrower momentarily had two full collateral batches locked. For an
operation that is "same debt, same collateral, just a better lender/rate,"
that was capital-inefficient and poor UX.

Refinance now **carries the existing collateral over in place** for the
common case. When carry-over applies, the collateral never leaves the
borrower's vault: the refinance offer pledges no fresh collateral, the new
loan is created without a fresh deposit or lien, and the encumbrance lien
simply **retags** from the old loan to the new one (same vault, same amount
— the protocol's locked-balance ledger is unchanged across the refinance).
The double-lock is gone; the borrower no longer needs a second collateral
batch. The post-refinance health-factor and LTV checks run against the
carried collateral, and the carried collateral identity must match the old
loan's exactly (asset, type, amount, token id, quantity) or the refinance
is rejected.

Carry-over is deliberately scoped to the case the retag machinery handles
end-to-end: the refinancer must be the **original borrower** (the borrower
position has **not** been transferred) and the offer must pledge a
**single, fixed** collateral amount (no borrower range). Every other
refinance — a **transferred** borrower position, a **ranged** offer, or an
**untagged** direct refinance — takes the unchanged **legacy path**: the
new collateral batch is deposited fresh and the old loan's collateral is
returned to the current borrower-position holder. This avoids skipping a
deposit the protocol never received (a transferred position's collateral
lives in the *original* borrower's vault, which carry-over can't retag into
the refinancer's). Letting a transferred position also carry over — by
consolidating the collateral into the current holder's vault — is tracked
as a separate design item (#594).

The carry-over decision is **computed once at offer creation and recorded
on the offer**, and every later step reads that record rather than
re-deriving it. This is the key correctness property: the targeted loan's
borrower can change (obligation transfer) and its lien can be released
between offer creation and the later steps, so a re-derived decision could
flip and desync from what was physically deposited — a carry-over offer
deposited nothing, so a flipped "not carry-over" reading could try to
refund or settle collateral that never existed (a fund-safety bug on
cancel). Recording the decision once removes that whole class.

Because the decision is recorded once but the real lien lives on the target
loan, the accept-time hand-off is a STRICT same-key retag: it only moves the
lien when its key (owner, asset, token id, amount, kind) still matches the
new loan exactly. If the target obligation migrated to a different borrower
after the offer was posted (which moved the lien to that borrower and
returned the original collateral), the keys diverge and the refinance is
rejected — never falling back to creating a fresh, unbacked lien against an
empty vault. This holds even if the borrower position is later transferred
back to the original creator.

Eligibility is correspondingly precise: an offer carries over only if it is
the original borrower's, single-value, with collateral identity exactly
matching the targeted loan AND a live old-loan lien. Anything else — a
mismatched-collateral or no-lien tagged offer included — resolves to "not
carry-over" and takes the legacy fresh-pledge path (so it is never an
unfillable advertised offer). A refinance-tagged offer's collateral is also
**frozen** once created — the offer-collateral mutators reject it (principal
and rate terms can still be changed). Separately, when a same-key retag
moves a lien from the old loan to the new one, the old loan's lien row is
zeroed (matching the normal release path) so stale per-loan readers can't
mis-report the collateral as still owed on the refinanced-away loan.

A refinance-tagged offer is also **single-purpose**: it can be consumed
only by a lender directly accepting it (which chains atomically into the
refinance). Every other offer-consumption path rejects it, because a
carry-over offer advertises collateral it never re-deposited (the
collateral is the target loan's, already liened): the range-order matcher
rejects it, the pre-loan parallel-sale opt-in is forbidden on it at
creation, and the obligation-transfer path rejects it. Loan-level paths
(prepay-listing, auto-list, OpenSea-bidder match, liquidation, default)
stay safe because they act on the fully-collateralized refinanced loan, or
— for liquidation/default of the target loan — they release that loan's
lien, after which an open carry-over offer can neither be accepted (target
no longer Active) nor over-refund on cancel (it reads the recorded
"deposited nothing" decision). Re-admitting tagged offers to the matcher
with a carry-over-aware path is tracked separately (#595).

Refinance carries over the **same** collateral by definition; changing the
collateral as part of a refinance is out of scope (use the add/remove
collateral flow). Closes #576.

## Thread — Internal-match lender-side lifecycle (PR #585)

When a loan is cleared by internal-liquidation matching, the lender's
matched proceeds were deposited into the original lender's protocol-held
vault but no claim record was created, and the lender claim path refused
internally-matched loans. If the lender had transferred their position to
a new holder, that holder had no way to retrieve the proceeds — and the
original lender could not either, because protocol-tracked vault balances
have no user-facing withdrawal. The funds were stranded and the loan was
left stuck in the internally-matched state, since the borrower's own
residual claim had been deliberately prevented from settling the loan
while this lender-side gap remained.

This change closes the lender side through the ordinary lender claim path.
A full internal match now records the matched proceeds as a lender claim
owed to the **current** holder of the lender position. That holder claims
them the same way they would on any resolved loan: the claim is
NFT-owner-gated and sanctions-screened on the recipient, pays out of the
protocol-held custody (so the original lender, once transferred away,
cannot take them), burns the lender position, and settles the loan once
both sides have cleared. The borrower and lender claims are now symmetric
and order-independent — whichever party claims last settles the loan — and
an exactly-collateralized match (no borrower residual) settles on the
lender claim alone. The earlier deferral that blocked the borrower's
residual claim from settling an internally-matched loan is removed, since
the natural two-sided settlement now composes correctly.

This covers every non-topped-up internal match. A fallback-pending loan
carrying an extra collateral top-up stays excluded from matching as
before; reconciling that split-custody case is tracked as a separate
follow-up (Part B — the top-up-aware unwind). Closes #585.

## Thread — Internal-match top-up-aware unwind (PR #591)

A fallback-pending loan can receive an extra collateral top-up (a
borrower "cure" attempt that doesn't fully clear the debt). That top-up
sits in the borrower's own vault under a lock, while the loan's original
collateral has already moved into the protocol's central custody. Until
now such "topped-up" loans were excluded from internal-liquidation
matching entirely: a match draws the matched collateral from the central
custody, and if it had drawn against the loan's full collateral figure
(which silently includes the vault-held top-up) it would have over-drawn
custody — taking collateral belonging to other loans parked in the same
asset.

This change replaces that exclusion with top-up-aware accounting. A
topped-up loan is now matchable, but only its custody-held portion
participates in the match — the vault-held top-up never does. The top-up
stays where it is, locked in the borrower's vault, and is folded into the
borrower's residual claim so it is returned to the **current**
borrower-position holder (not a stale original borrower if the position
was transferred). On a full match the loan settles as internally matched
and the whole remaining collateral — the custody residual plus the
untouched top-up — becomes claimable by that holder. On a partial match
the loan stays fallback-pending and its settlement snapshot is scaled
against the custody portion only, leaving the top-up lock intact for a
later match or in-kind payout. The same custody-portion-only rule now
governs the claim-time retry swap, so that path is likewise safe for
topped-up loans.

With the unwind in place, the four former exclusion points (the direct
trigger gate, the auto-dispatch skip, the candidate-scan filter, and the
defensive settlement guard) are removed, and the unused
"top-up unsupported" error is retired. Lender-proceeds routing from the
lender-side lifecycle work is unchanged. Closes #591 (the Part B
follow-up to #585).

# RepayFacet split — periodic-interest + NFT-rental cluster moved to RepayPeriodicFacet (#592)

The #592 VPFI lender-proceeds reservation logic grew `RepayFacet` past the
EIP-170 24,576-byte contract-size limit. To stay deployable, the
permissionless NFT-rental daily-deduction loop and the periodic-interest
settlement cluster were moved out of `RepayFacet` into a new
`RepayPeriodicFacet`. `RepayFacet` keeps the borrower-driven full/partial
repayment surface; both facets are now comfortably under the size limit.

This is a **pure structural move** — no behaviour change. The moved functions
keep the same names, signatures, and semantics; they simply route to a
different facet behind the Diamond. From a caller's perspective nothing
changes (the Diamond resolves each function to its facet by selector as
before).

Integrators that hold per-facet ABIs gain a new `RepayPeriodicFacet` ABI; the
moved functions are no longer in the `RepayFacet` ABI. The full-Diamond ABI
bundle (frontend / workers) is unchanged in aggregate — the same selectors are
present, just split across two facet ABIs.

## Thread — Reserve VPFI lender-proceeds against the unstake path on all terminal paths (#592)

When a loan whose principal asset is VPFI reaches a terminal close, the
lender's proceeds are deposited into the **stored** lender's vault and owed
to the **current** lender-position NFT holder via a claim. VPFI is the one
principal asset with a user-facing tracked-balance exit (the VPFI unstake
/ withdraw path), so — if the lender position had been transferred away —
the stored lender could **front-run the current holder's claim and unstake
the proceeds**, leaving the rightful claim unfundable. (No funds are at
risk today: the platform is pre-live. This closes the class before
mainnet.)

The internal-match path already closed this (the #585 work added the
reserve/release mechanism: the proceeds are reserved in the locked-balance
ledger at deposit and released, path-agnostically, the instant the holder
claims). This change extends the **reserve** call to every remaining VPFI
lender-proceeds deposit site across the **terminal** close paths — the ones
where the loan closes immediately, so the lender of record is fixed between
the deposit and the eventual claim:

- full repayment,
- swap-to-repay (collateral swapped to clear the debt),
- time-based default (liquid DEX-swap settlement),
- borrower preclose (direct),
- refinance (the old loan's lender is paid off and exits),
- health-factor liquidation (full, atomic-split, and discounted variants).

At each, when the asset that lands in the lender's vault is VPFI, the
proceeds are reserved against the unstake path the moment they land, and
the claim-time release frees them exactly when the current holder claims.
The reservation now keys on the **asset actually deposited** rather than the
loan's principal asset: that is the principal asset for cash-settled closes,
but the **collateral** asset for an in-kind / illiquid default — and VPFI is
collateral-eligible, so a non-VPFI-principal loan whose VPFI collateral is
handed to the lender in kind is now reserved too. Each loan's reservation
**records the asset it was placed under**, and the claim-time release frees
**that same** asset rather than re-deriving one — previously it used the
loan's principal asset, which would have freed the wrong balance (or none)
for a VPFI-collateral claim, and even keying on the claim record's asset
could mismatch a loan whose reserve and claim assets differ. Recording the
asset makes reserve and release agree by construction. Assets with no
user-facing tracked-withdraw path carry no reservation and are untouched.

Deliberately **not** reserved (documented): the partial-repayment and
periodic-interest-shortfall paths pay the lender's **wallet** directly (not
a vault deposit, so no tracked balance to drain), and partial liquidation
deposits proceeds to the lender with no deferred claim (they belong to the
lender at liquidation time, not to a later holder).

The **held-for-lender** accruals (preclose offset and obligation transfer)
are also deliberately left for a follow-up (#597): unlike the terminal
paths, they land on a loan that stays **active**, whose lender of record
can change before the claim (the offset path rewrites it in the same
transaction; a later lender sale rewrites it and migrates the held funds),
so reserving them correctly needs a re-key across every lender-change path
plus a decision on exiting-lender ownership. Closes #592.

# Lean summary projections for paginated dashboard views (#601)

The paginated dashboard and analytics views that return **lists** of loans or
offers now hand back a **lean summary** of each row instead of the entire
on-chain record. The summary carries exactly the fields the dashboard and
analytics surfaces render — identity, the principal and collateral terms,
status, the position-NFT ids, and (for loans) the at-init liquidation
threshold; (for offers) the rate/amount ranges, fill progress, and expiry.

Affected views: the per-user dashboard loan lists (both the single-side and
the combined-sides variants), the per-user dashboard offer list, and the
"all of a user's offers with details" list.

Anything that needs the *complete* record for a single loan or offer — the
rental-prepay accounting, periodic-interest state, fallback/discount
snapshots, or the offer's listing/parallel-sale/refinance flags — continues
to read it from the single-item detail views (`getLoanDetails`,
`getOffer`/`getOfferDetails`), which are unchanged and still return the full
record.

**Why:** returning an *array* of the full 40-plus-field record forced the
Solidity compiler's ABI encoder past an internal stack limit when the whole
test suite was compiled as one unit — a build-time failure that the
per-PR CI lane never saw (it compiles a narrower scope) and that only
surfaced in a full local regression. Projecting each list row onto a small
flat summary keeps that encoder shallow and the whole project compiles
cleanly again. There is **no change to what data the platform exposes or how
loans/offers behave** — only the shape of the list payloads, which now omit
fields the list screens never displayed anyway (and which remain available
from the detail views).

A nested-sub-struct reshaping of the core loan/offer records was trialled
first and **reverted** — it made the build-time problem worse rather than
better. See #601 for the full rationale.
