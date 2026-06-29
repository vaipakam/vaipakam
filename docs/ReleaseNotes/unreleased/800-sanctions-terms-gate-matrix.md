## Thread — Sanctions & Terms-gate action matrix (PR #__)

Sanctions screening and the versioned Terms-of-Service gate touch many action
families across the protocol and the dapp, and inconsistent gating is a real
risk class: a compliance bypass, a falsely-blocked recovery path, or a UI that
offers a transaction the protocol will revert. This change captures the intended
behaviour in one place, closes two representative test gaps, and — importantly —
records the **enforcement gaps and remaining test gaps that stay open** as
tracked follow-ups rather than papering over them.

- **New action-matrix spec** —
  `docs/FunctionalSpecs/SanctionsAndTermsGateMatrix.md` documents, per action
  family, the expected sanctions behaviour (Tier-1 BLOCK fresh-value / claims;
  Tier-2 ALLOW wind-down so an unflagged counterparty can be made whole; fail-
  open while the oracle is unset) and the Terms-gate states (disabled at
  `currentTosVersion == 0`; accepted-current; stale after a version bump or
  content-hash drift). It also pins the UI rules: the sanctions banner shows
  only for a flagged connected wallet or relevant counterparty, distinguishes
  blocked fresh-value paths from permitted recovery paths, and points to the
  sanctions-data provider for recourse. The matrix is sourced from the canonical
  specs (ProjectDetailsREADME § Regulatory Compliance Considerations and
  WebsiteReadme), with "verified at / tested by" references to the enforcement
  sites and tests.
- **Two contract test gaps closed** — Tier-1 sanctions reverts on the VPFI
  **deposit** (value-in) and **withdraw** (value-out) paths, which the existing
  `SanctionsOracle.t.sol` suite couldn't reach (its diamond doesn't cut the
  VPFIDiscountFacet selectors). Added in `VPFIDiscountFacetTest.t.sol`.
- **Frontend test** — a `SanctionsBanner` test asserting it shows for a flagged
  address and stays silent for a clean address, while the read is loading, and
  when no wallet is connected (the fail-open posture).

**What the matrix surfaced (now documented, not yet fixed).** Authoring the
matrix from the canonical specs and comparing against the code surfaced several
**enforcement gaps** — most notably that the wind-down "unflagged counterparty
always recovers" guarantee does **not** fully hold: because `getOrCreateUserVault`
screens the recipient vault owner, a flagged *recipient loan party* (e.g. a
flagged lender on full `repayLoan`, or a surplus borrower on liquidation/default)
currently makes the close-out **revert** rather than deferring to a Tier-1 claim.
Other gaps: ungated prepay-listing post/update, keeper preclose / early-withdrawal
paths screening only `msg.sender` (not the current NFT holder), an unscreened
`triggerLiquidationDiscounted` recipient, and the default auto-dispatch matcher
bonus. These are recorded in the matrix's *Open gaps* section and in
`_CodeVsDocsAudit.md` for triage — they are not closed by this change.

The sanctions Tier-1/Tier-2 split (borrower-flagged direction), the
blocked-claim-by-flagged-claimant case, and the full Terms-gate lifecycle
(disabled / accept / version-bump + hash-drift invalidation) remain covered by
`SanctionsOracle.t.sol` and `LegalFacet.t.sol` / `LibAcceptTermsTest.t.sol`; the
matrix references those as the existing oracle.

Closes #800.
