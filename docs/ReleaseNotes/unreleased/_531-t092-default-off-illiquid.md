## Thread — T-092-B: default auto-refinance OFF for illiquid / NFT collateral (#531)

Closes the asymmetric-tail-risk gap in the T-092 auto-opt-in flow. A novice borrower who toggles `setAutoOptInOnNewLoan(true)` for their everyday liquid loans was previously silently enrolled in auto-refinance on their NFT-backed loans too — with a 100%-loss tail risk they almost certainly didn't understand.

### What's new

**Contract gate** ([`LoanFacet.sol:285`](contracts/src/facets/LoanFacet.sol#L285)) — the auto-opt-in populate-on-init path now requires `collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid`. The check reuses the `collateralLiquidity` value already computed earlier in `initiateLoan` (line 202) — no extra `OracleFacet.checkLiquidity` round-trip.

When the gate fires (illiquid ERC20 collateral, NFT collateral, or temporary sequencer outage), the per-loan caps slot stays unpopulated. The borrower can still manually call `setAutoRefinanceCaps(loanId, ...)` to enroll a specific loan in the keeper-driven path — the explicit setter is unchanged. Only the silent auto-enrollment is gated.

### Why this asymmetry matters

| Collateral type | If auto-refinance fires | If it doesn't fire (default path) |
|---|---|---|
| Liquid ERC20 | Smooth handoff | `DefaultedFacet` swaps → borrower keeps surplus above debt |
| Illiquid ERC20 / NFT | Smooth handoff | **Lender takes whole collateral** ([`DefaultedFacet.sol:442-486`](contracts/src/facets/DefaultedFacet.sol#L442-L486)) — borrower loses 100% |

The auto-refinance opt-in is best-effort: it only fires if a compatible new lender offer exists in the book at the right time. If no match, the loan defaults. For liquid collateral the borrower still gets the swap surplus; for illiquid / NFT the loss is total. A convenience flag must not silently enroll a user into the latter.

### Dapp warning surface

`AutoLifecycleLoanCapsCard` (on LoanDetails) now accepts a `collateralIsNft` prop. When true, a stark warning banner renders above the editor sections:

> ⚠️ This loan's collateral is an NFT. If no compatible refinance offer is found before the grace period ends, your NFT will transfer in full to the lender (no market swap, no surplus). Auto-refinance is best-effort, not a guarantee. Consider repaying directly instead.

LoanDetails wires the prop from `Number(loan.collateralAssetType) === ERC721 || ERC1155`. The dapp warning surfaces only for NFT collateral today; illiquid ERC20 collateral warning is deferred to a follow-up (requires an extra `OracleFacet.checkLiquidity` view call from the dapp).

### Verification

- forge build clean (`viaIR + optimizer=200`).
- `T092AutoLifecycleIntegrationTest` 17/17 green (was 15, +2):
  - `test_T092B_AutoOptInGate_PopulatesOnLiquidCollateral` — happy path still works.
  - `test_T092B_AutoOptInGate_SkipsOnIlliquidCollateral` — new gate fires; caps stay unpopulated.
- Deploy-sanity 12/12; broader RefinanceFacet + AutoLifecycle + LoanFacet 81/81 green.
- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- ABI re-export ran (`exportFrontendAbis.sh`).

### Out of scope

- Illiquid ERC20 collateral warning on the dapp — separate follow-up; needs the dapp to call `OracleFacet.checkLiquidity` for the loan's collateral, which adds an RPC call.
- Manual setter (`setAutoRefinanceCaps`) is unchanged — sophisticated borrowers can still explicitly enroll any loan, including NFT-collateralised ones, by acknowledging the tail risk.
