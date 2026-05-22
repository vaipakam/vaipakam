## previewAccept(offerId, acceptor) — contract-side dry-run for direct-accept (Issue #196)

The Range-Orders matching path already exposed `OfferMatchFacet.previewMatch(lenderOfferId, borrowerOfferId)` so a keeper bot or the frontend could ask the protocol "what loan would land here?" before submitting a match. The direct-accept path — `OfferAcceptFacet.acceptOffer(offerId, true)` — had no such surface. The frontend's AcceptOffer modal and the indexer / keeper that project the would-be loan had to duplicate the protocol's role-aware mapping (lender direct-accept reads the lender's max + floor rate; borrower direct-accept reads the borrower's floor + ceiling rate; NFT rentals stay single-value) plus run a separate computation for the 0.1% Loan Initiation Fee with VPFI-discount short-circuit. That duplication is exactly the class of drift the May-2026 watcher offer-decode incident exposed.

This release adds **`previewAccept(uint256 offerId, address acceptor) → AcceptPreview`** as a pure view on `OfferAcceptFacet`. One `eth_call` returns the projection (`effectivePrincipal`, `interestRateBps`, `collateralAmount`, `lifEstimate`, `collateralResidualRefund`) plus a typed `AcceptError` enum classifying any would-be revert — `OfferAlreadyAccepted`, `SanctionedAcceptor`, `SanctionedCreator`, `AssetPaused`, `CountriesNotCompatible`, `RiskAndTermsConsentRequired`, `KYCRequired`. The only path that reverts instead of surfacing through `errorCode` is `InvalidOffer` (non-existent slot), mirroring `acceptOffer`'s top-of-function behaviour.

The load-bearing design choice: happy-path projection fields stay populated even when `errorCode != None`, so the frontend can render meaningful copy like "tier-up to unlock this offer at 10k principal, 300 bps" alongside the `KYCRequired` error, instead of the bland "KYC required" the protocol used to surface. Pause and country-pair errors are recoverable too — the operator unpausing the asset or the user's country changing flips the offer back to acceptable.

The LIF estimate mirrors the VPFI-discount probe `_acceptOffer` itself runs before pulling VPFI: tier ≥ 1, consent flipped, vault holds ≥ the full LIF-equivalent VPFI, and the borrower-side oracle route resolves. When the probe says the discount would apply, `lifEstimate = 0`; otherwise it's the 0.1% of `effectivePrincipal`. NFT-rental offers always project `lifEstimate = 0` because the LIF path is guarded behind `assetType == ERC20`.

Coverage:

- **Happy-path pins** — four scenarios mirror the load-bearing assertions in `AcceptRangedOfferTest`: lender-ranged offer accepted by borrower (principal = `amountMax`, rate = `interestRateBps`); borrower-ranged offer accepted by lender (principal = `amount`, rate = `interestRateBpsMax`); borrower-ranged-collateral with `collateralAmountMax > collateralAmount` (residual refund populated); single-value (non-ranged) lender offer. Each test computes the preview first, runs the real `acceptOffer`, and asserts the loan shape matches the projection field-for-field. If `previewAccept` drifts from `_acceptOffer`'s mapping, these pins fail.
- **Error-code walks** — one test per `AcceptError` variant: `OfferAlreadyAccepted` (accept once, preview again — surfaces error and still populates the projection so the indexer can render historical offers); `KYCRequired` (drop borrower to Tier-0 with enforcement on, project a Tier-2-threshold offer — happy-path fields stay populated for the tier-up nudge); `AssetPaused` (pause the lending leg); `SanctionedAcceptor` and `SanctionedCreator` (mock the sanctions oracle to flag each side independently). Plus the `InvalidOffer` revert test.

Wiring:

- `OfferAcceptFacet` selector list extended from 3 to 4 in `DeployDiamond.s.sol` (cut #18 of 36 on the production diamond) and in `HelperTest.sol` (the SetupTest scaffolding).
- ABI re-export: `packages/contracts/src/abis/OfferAcceptFacet.json` carries the new selector, the `AcceptPreview` tuple and the `AcceptError` enum. The sibling reference bot's `src/abis/` syncs from the same export script.
- The `SelectorCoverageTest` deploy-sanity guard automatically catches a missed wiring step, so the selector list is provably consistent across `DeployDiamond` and `HelperTest`.

No state-changing change to existing code paths — every legacy `acceptOffer` flow is byte-identical. This release adds a new external view and the two structural types it returns.

Closes #196. Frontend consumer wiring (`useAcceptPreview(offerId)` hook + integration into the `OfferDetails` / `AcceptOffer` modal) lands in its own follow-up PR.
