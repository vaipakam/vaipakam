## Thread — Close the deferred Slither set: write-after-write, dead-code, assembly, missing-zero-check (PR #<n>)

Final phase of issue #148's Code Scanning queue triage. Phase 2 (PR
#150) closed the 6 surviving HIGHs. Phase 3 (bulk gh-api) dismissed
381 alerts across 6 rule classes. Phase 4 (PR #155) added 3 in-source
suppressions on the highest-value security signals (Pyth gates +
Chainlink Feed Registry) and bulk-dismissed 119 more alerts across 8
lower-risk rule classes. Phase 5 — this PR — handles the 42 alerts
intentionally deferred from Phase 4 because they needed real per-site
review.

The deferred set split four ways. The two `write-after-write` alerts
on `RepayFacet.autoDeductDaily` both flag the same `ok` local being
re-assigned across three best-effort cross-facet cleanup calls
(escrow renter reset + two NFT-status updates). The reuse is
intentional — every cleanup is non-critical (the inline comments mark
them so), independent of the others, and the loan still transitions
to Repaid at the end of the block regardless of cleanup outcome.
Added two `// slither-disable-next-line write-after-write` directives
before the second and third assignments, with a paragraph-long
rationale block above the first call explaining why the shared `ok`
is right and what would trigger replacing it with per-call locals.

The five `dead-code` findings were genuinely orphaned helper
functions left behind by earlier refactors. Each gets DELETED here,
not suppressed:

- `PartialWithdrawalFacet._simulateHF` + `_simulateLTV` — replaced by
  the unified `_loadValuationContext` + per-iteration inline loop
  body. Source comment at line 161 ("Previously each iteration called
  `_simulateHF` + `_simulateLTV`...") confirmed the refactor history.
- `VaipakamNFTFacet._isClosedStatus` — every call site was inlined to
  compare the status enum directly. The test file still references it
  in comments (since-stale doc), but the tests themselves go through
  the public `tokenURI` surface and continue to pass.
- `RiskFacet._getZeroExProxy` + `_getAllowanceTarget` — leftovers from
  the pre-Phase-7a 0x-direct liquidation path that was replaced by
  the 4-DEX adapter pattern (`AggregatorAdapterBase` + per-aggregator
  adapters). Live paths now read `zeroExProxy` / `allowanceTarget`
  via `LibVaipakam.storageSlot()` at each call site.

The 14 `assembly` findings and 21 `missing-zero-check` findings both
get bulk-dismissed via `gh api PATCH state=dismissed` with rule-class
rationale (the comments fit GitHub's 280-character `dismissed_comment`
limit). Every assembly site is a canonical EVM-low-level pattern —
Diamond storage-slot lookups (`LibVaipakam.storageSlot`,
`LibAccessControl._storage`, `GuardianPausable._getGuardianStorage`),
the Diamond fallback router (`VaipakamDiamond.fallback`), and bytes-
data returndatasize manipulation (`LibRevert.bubbleOnFailure`,
`LibERC721._checkOnERC721Received`, `VpfiBuyReceiver._decodeFailReason`).
Every missing-zero-check site is on a function gated by
`onlyDiamondInternal` — only sibling Diamond facets call them, never
user input, and the addresses passed (`loan.borrower`, `loan.lender`,
`recipient` from `loan.recipient`, etc.) are storage-sourced and
validated at write time. Defense-in-depth zero-checks would duplicate
the upstream guards.

After this PR lands the Code Scanning queue drops from ~42 open
Slither alerts to **0**. The two CodeQL alerts that remain (medium-
severity JavaScript findings) are tracked separately as #148's tail
work. Closes #148.
