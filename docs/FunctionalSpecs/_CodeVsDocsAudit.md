# Code vs Docs Audit

The implementation evidence and triage history are preserved in the
[internal divergence audit](../internal/FunctionalSpecsCodeVsDocsAudit.md).
They are separate from the code-free intended-behavior specifications.
An observed behavior does not become intended behavior without a recorded
owner decision. Existing section links remain available below.

## How to use this file

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#how-to-use-this-file).

## Open findings

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#open-findings).

## Resolved findings

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#resolved-findings).

## D-#1457-01 — Unarmed-day recycled portion — **NOT A DIVERGENCE (refuted 2026-07-30)**

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#d-1457-01--unarmed-day-recycled-portion--not-a-divergence-refuted-2026-07-30).

## Partial repayment vs. a standing refinance request — the hold is device-local (2026-08-07, #1589 r3)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#partial-repayment-vs-a-standing-refinance-request--the-hold-is-device-local-2026-08-07-1589-r3).

## Full-tariff ceiling overtake: creator arm form has no warning (#1702)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#full-tariff-ceiling-overtake-creator-arm-form-has-no-warning-1702).

## Direct position sale ignored a standing offer's deadline (#1503 item 8)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#direct-position-sale-ignored-a-standing-offers-deadline-1503-item-8).

## Obligation transfer ignores the incoming borrower's offer deadline (sibling of #1503 item 8)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#obligation-transfer-ignores-the-incoming-borrowers-offer-deadline-sibling-of-1503-item-8).

## The spec cited three test files that do not exist (#1785)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-spec-cited-three-test-files-that-do-not-exist-1785).

## §9's lender-exit hardening lives under one option instead of the shared section (#1780)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#9s-lender-exit-hardening-lives-under-one-option-instead-of-the-shared-section-1780).

## Offer-lifecycle VPFI vault movements skip the tier restamp (#1817 r3 → #1820)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#offer-lifecycle-vpfi-vault-movements-skip-the-tier-restamp-1817-r3--1820).

## A disclosed reward migration was performed best-effort (#1503 item 12)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#a-disclosed-reward-migration-was-performed-best-effort-1503-item-12).

## The sale's transitional record was counted as a real position (#1503 item 26)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-sales-transitional-record-was-counted-as-a-real-position-1503-item-26).

## Sale listing vs live position — behavioural terms (#1503 item 23)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#sale-listing-vs-live-position--behavioural-terms-1503-item-23).

## Sale-cost disclosure keys on the lock, where the spec keys on fillability

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#sale-cost-disclosure-keys-on-the-lock-where-the-spec-keys-on-fillability).

## The app asked a seller to fund a settlement the protocol takes from the buyer's payment (#2674)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-app-asked-a-seller-to-fund-a-settlement-the-protocol-takes-from-the-buyers-payment-2674).

## VPFI fee discounts: the spec was right and everything downstream of it was wrong (#1981)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#vpfi-fee-discounts-the-spec-was-right-and-everything-downstream-of-it-was-wrong-1981).

## Data-rights erasure: four places the shipped behaviour cannot yet meet the stated intent (#1862 Part 2)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#data-rights-erasure-four-places-the-shipped-behaviour-cannot-yet-meet-the-stated-intent-1862-part-2).

## An unsubstantiable loan record is reported, but not withdrawn from publication (#2190 r8)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#an-unsubstantiable-loan-record-is-reported-but-not-withdrawn-from-publication-2190-r8).

## A correction's "settled point" is a guess when the source cannot supply one (#2199 r4)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#a-corrections-settled-point-is-a-guess-when-the-source-cannot-supply-one-2199-r4).

## The transport epochs: two divergences the 3b-i ledger resolved (#2232)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-transport-epochs-two-divergences-the-3b-i-ledger-resolved-2232).

### 1. The day index's order — a contradiction INSIDE the design, not code drift

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#1-the-day-indexs-order--a-contradiction-inside-the-design-not-code-drift).

### 2. The 3a-to-3b window — spec promised an index nothing could provide

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#2-the-3a-to-3b-window--spec-promised-an-index-nothing-could-provide).

### 3. The release of a transport epoch — spec states a machine check the code leaves to the operator

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#3-the-release-of-a-transport-epoch--spec-states-a-machine-check-the-code-leaves-to-the-operator).

## Finalization coverage is a report COUNT, and Base's own report counts whether or not Base is listed (#2613)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#finalization-coverage-is-a-report-count-and-bases-own-report-counts-whether-or-not-base-is-listed-2613).

## A chain taken off Base's expected-source list has its last report refused (#2618)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#a-chain-taken-off-bases-expected-source-list-has-its-last-report-refused-2618).

## The pre-d6 budget wires are retired: a spec change made on a recorded owner decision (2026-10-22)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-pre-d6-budget-wires-are-retired-a-spec-change-made-on-a-recorded-owner-decision-2026-10-22).

## Accepting an offset offer: the connected-app spec excluded it, the owner reversed that (#2523, 2026-10-23)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#accepting-an-offset-offer-the-connected-app-spec-excluded-it-the-owner-reversed-that-2523-2026-10-23).

## The day-close grace window reads as zero when it was never set (#2681, 2026-10-23)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-day-close-grace-window-reads-as-zero-when-it-was-never-set-2681-2026-10-23).

## The connected app is not installable (#2687, 2026-10-23)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#the-connected-app-is-not-installable-2687-2026-10-23).

## Forced sales: the spec now sizes them to the debt, ahead of the code (#2796, 2026-10-25)

See the [audit record](../internal/FunctionalSpecsCodeVsDocsAudit.md#forced-sales-the-spec-now-sizes-them-to-the-debt-ahead-of-the-code-2796-2026-10-25).
