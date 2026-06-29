## Thread — Keeper no-custody boundary: matrix + KEEPER_ACTION_ALL regression (PR #__)

Delegated keepers automate lifecycle actions (refinance, auto-extend, preclose,
intent fill/roll, early-withdrawal/loan-sale completion), but they must never be
custodians: a keeper cannot claim a user's funds, make an owner-only vault
withdrawal, transfer a position NFT, redirect a payout to itself, or weaken a
safety gate. (A keeper-driven action can still move the obligation the user
already owes — e.g. auto-extend forwards the borrower's accrued interest from
their vault to the lender/treasury — and earn the bounded VPFI housekeeping
reward; and a permissionless caller can earn a bounded matcher/liquidator bonus
or buy seized collateral by paying the debt — none of which hands over a user's
principal/collateral.) That boundary was enforced and correct in the code, but it
was reconstructable only from comments scattered across facets, and there was no
test proving it holds for a keeper approved with **every** action bit. This
change makes the boundary auditable from one place and pins the strongest case.

- **New matrix spec** — `docs/FunctionalSpecs/KeeperAuthorityMatrix.md` states
  the keeper delegation model (the three per-keeper gates + the global pause +
  the NFT-owner authority), the allowed delegated surface (action bit →
  function), and the no-custody boundary table (each owner-only /
  diamond-internal gate the keeper bitmask never reaches), plus the
  permissionless-trigger exception (repay / default / liquidation route value to
  the loan's parties, never to the caller). Listed in the FunctionalSpecs README.
- **KEEPER_ACTION_ALL regression tests** — `ClaimFacetTest` now approves a keeper
  with `KEEPER_ACTION_ALL`, enables the master switch, and enables it for the
  specific loan, then proves it is **still** rejected (`NotNFTOwner`) on
  `claimAsLender`, `claimAsBorrower`, and `addCollateral`. The pre-existing
  reverts only used a non-keeper non-owner caller; these prove the action
  bitmask never reaches the custody paths.
- **UI copy** — Keeper Settings gains an explicit no-custody line: keepers are
  automation agents, never custodians; even one approved for every action cannot
  claim, withdraw, add/withdraw collateral, transfer a position NFT, redirect
  proceeds, or weaken a safety gate.

The other boundary rows (partial-withdraw owner gate, `vaultWithdrawERC20`
diamond-internal, NFT-transfer ERC-721 ownership, oracle-derived liquidation
min-out) are already pinned by existing tests
(`AddCollateralFacetTest`, `PartialWithdrawalFacetTest`,
`LenderIntentCapital.t.sol`, `LiquidationMinOutputInvariant.t.sol`); the matrix
references them. This is a hardening / regression card — no protocol behaviour
changed (test-only contract change; no `contracts/src/` / selector / ABI change).

Closes #803.
