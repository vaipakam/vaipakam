## Thread — HoldOnly borrower LIF + fee-default freeze 0.2%/2% (M2 PR-4) (PR #<n>)

Implements the borrower-side of the fee package the spec supersession (#1350)
described. Two changes, both dark-safe for the pre-live posture:

**Fee-default freeze (0.1%/1% → 0.2%/2%), grandfathered.** The compiled
default Loan-Initiation Fee moves from 0.1% to 0.2% and the yield (treasury)
fee from 1% to 2%, for **new** originations only. A loan snapshots the fee
rate in force at its origination, and the settlement resolver now falls back
to a **frozen legacy 1%** for any loan whose snapshot is zero (a pre-snapshot
loan) — so bumping the live default can never retroactively reprice an
already-open loan from 1% to 2% at repayment. The Loan-Initiation Fee is
charged once at acceptance, so the 0.2% only ever applies to new loans. On a
fresh deploy the new defaults are simply in force from genesis.

**Borrower LIF becomes a HoldOnly hold-tier direct reduction.** Previously a
consenting tier-holding borrower's Loan-Initiation-Fee discount was delivered
only through a peg-gated path that pulled the full fee in VPFI into protocol
custody and rebated it at settlement. That peg-custody path is **retired for
new loans**: the borrower's hold-tier discount is now applied **directly to
the lending-asset fee at acceptance** — the borrower simply pays less fee, in
the loan's own asset, with no VPFI moved and no custody taken. The discount is
resolved at acceptance (pinned at origination, so a last-minute top-up can't
game it), consent-gated, and applies on liquid-asset loans (an illiquid loan
pays the full fee — matching the prior posture, and a reward-eligible loan
requires a priceable asset anyway). A new loan therefore never records
up-front VPFI custody; loans already open on the legacy custody path keep
settling through their existing rebate/forfeit helpers unchanged. The
per-party VPFI "Full" tariff is a separate later card.

The accept charge and the accept-preview quote share one fee-computation
helper so a borrower is quoted exactly what they are charged. The offer-match
event's matcher-fee field is **gross/display-only** — it logs the list-rate
matcher slice, not the borrower's tier-discounted figure (folding the discount
into that event pushed the match facet past the runtime-bytecode limit, and
the field is an informational log rather than the borrower's charge).

**Uniform 50% fee-discount ceiling.** The 50% cap the borrower Loan-Initiation
Fee already respected is now applied symmetrically to the **lender yield-fee**
discount as well, and to the public `getEffectiveDiscount` view. Governance can
configure a per-tier discount as high as 90%, but the *applied* reduction on
either fee line — and what the view reports — is clamped at 50%, so a high-tier
lender can never under-collect treasury by more than half the yield fee.

The Loan-Initiation-Fee receipt (`loanInitiationFeeBpsAtInit`) is clarified as
the **list-rate schedule** the loan was originated under — a consenting
tier-holding borrower pays a lower effective rate after their HoldOnly discount,
derivable from their consent + tier. The client-side default fee mirrors and the
stale-facet upgrade script's selector list were also brought in sync with the
new defaults.

The connected-app accept modal was reframed to match the HoldOnly mechanic: a
consenting tier-holder now sees the discounted Loan-Initiation Fee charged in
the lending asset (with net proceeds = principal − fee), instead of the old
"pay the full fee in VPFI and receive a later rebate" framing that no longer
matches how the fee is charged. (The broader Full-tariff frontend surface
remains tracked under PR-8.) Closes #1352.
