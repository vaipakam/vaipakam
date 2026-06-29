# Keeper Authority Matrix — the no-custody boundary

**Status:** intended-behaviour specification (the test oracle). Sourced from the
keeper-delegation design (Phase 6) and the security boundary documented across
`docs/FunctionalSpecs/WebsiteReadme.md` (keeper UX) and
`docs/ops/IncidentRunbook.md` — not transcribed from the contracts. The "Verified at" / "Tested by" columns
reference where each rule is enforced and exercised; a divergence between this
matrix and the code is a bug to be logged in `_CodeVsDocsAudit.md`, not a reason
to edit the matrix.

This addresses GitHub issue #803 — so a reviewer can audit keeper authority from
**one** matrix instead of reconstructing it from comments scattered across
facets. The load-bearing claim it pins: **a delegated keeper is an automation
agent, never a custodian.** Even a keeper a user has approved with *every* action
bit (`KEEPER_ACTION_ALL`) cannot claim a user's funds, make an owner-only vault
withdrawal, transfer a position NFT, redirect a payout to itself, or weaken a
safety gate. (It CAN drive granted automation that moves the obligation the user
already owes — e.g. auto-extend forwards the borrower's accrued interest from
their vault to the lender/treasury — and earn the bounded VPFI housekeeping
reward; neither hands the keeper the user's principal/collateral. The allowed
surface + permissionless-exception sections give the precise economics.)

## The delegation model

A keeper-accessible function authorises **one** of three callers
(`LibAuth.requireKeeperFor(action, loan, lenderSide)`):

1. **The Diamond itself** — internal cross-facet calls.
2. **The current owner of the relevant-side position NFT** — authority follows
   `ownerOf(tokenId)` (lender NFT for lender-entitled actions, borrower NFT
   otherwise), so a mid-flow NFT transfer carries authority with the position.
3. **A delegated keeper** — only when **all** of these hold:
   - the NFT owner's **master keeper switch** is on (`keeperAccessEnabled`);
   - the keeper is **enabled for this specific loan** (`loanKeeperEnabled`);
   - the keeper's **action bitmask** for that owner has the bit for this action
     (`approvedKeeperActions & action != 0`);
   - keepers are **not globally paused** (`keepersPaused`).

   Any gate failing reverts `KeeperAccessRequired`.

A pre-loan variant (`requireKeeperForPrincipal`) authorises a solver against the
**principal** being acted for (used by signed-fill / intent-roll, where no loan
NFT exists yet).

The action bits (`LibVaipakam.KEEPER_ACTION_*`, a `uint8` mask;
`KEEPER_ACTION_ALL = 0xFF`): `COMPLETE_LOAN_SALE`, `COMPLETE_OFFSET`,
`INIT_EARLY_WITHDRAW`, `INIT_PRECLOSE`, `REFINANCE`, `EXTEND`, `SIGNED_FILL`,
`AUTO_ROLL`.

## What a delegated keeper CAN do (the allowed surface)

Each row is reachable by a keeper holding the listed action bit (plus the gates
above). Every one is a **lifecycle/automation** action whose loan PROCEEDS route
to the loan's own parties, never to the keeper as principal — though a
keeper-driven action may (a) move the obligation the user already owes from the
user's own vault to the counterparty (e.g. auto-extend pays the lender/treasury
the interest + late fee the borrower owes), and (b) earn the keeper the bounded
VPFI **housekeeping reward** (`LibKeeperReward.payVpfiReward`, itself sanctions
soft-skipped). Neither hands the keeper the user's principal/collateral.

| Delegated action | Action bit | Authorized side (keeper whitelist resolves against this NFT owner) | Enforced at |
| --- | --- | --- | --- |
| Initiate early withdrawal / loan-sale listing | `INIT_EARLY_WITHDRAW` | lender | `EarlyWithdrawalFacet` |
| Complete loan sale | `COMPLETE_LOAN_SALE` | lender | `EarlyWithdrawalFacet` |
| Initiate preclose (direct / transfer / offset) | `INIT_PRECLOSE` | borrower | `PrecloseFacet` |
| Complete offset | `COMPLETE_OFFSET` | **borrower** (`requireKeeperFor(..., lenderSide=false)`) | `PrecloseFacet` |
| Refinance loan | `REFINANCE` | borrower | `RefinanceFacet` |
| Auto-extend in place | `EXTEND` | **borrower** (the `EXTEND` bit gates the borrower-side call; lender consent comes only from the per-loan caps, so a lender-approved keeper alone cannot drive it) | `AutoLifecycleFacet` |
| Fill a standing signed intent | `SIGNED_FILL` | lender — **principal-keyed** (`requireKeeperForPrincipal`): no per-loan gate (the loan doesn't exist yet), only global pause + master access + the principal's action bit | `OfferMatchFacet` |
| Auto-roll a repaid intent loan | `AUTO_ROLL` | lender — **principal-keyed** (same model, no per-loan toggle) | `LenderIntentFacet` |

## What a delegated keeper CANNOT do — the no-custody boundary

These paths are **owner-only** (gated on current position-NFT ownership) or
**diamond-internal**. The keeper action bitmask is **not** consulted, so even
`KEEPER_ACTION_ALL` does not reach them.

| Sensitive path | Gate (keeper has no bypass) | Revert | Tested by |
| --- | --- | --- | --- |
| Claim lender funds (`claimAsLender` / `…WithRetry`) | `LibAuth.requireLenderNftOwner` | `NotNFTOwner` | `ClaimFacetTest::testClaimAsLenderRevertsIfNotNFTOwner`; **`…::test_KeeperActionAll_CannotClaimAsLender`** |
| Claim borrower funds (`claimAsBorrower`) | `LibAuth.requireBorrowerNftOwner` | `NotNFTOwner` | `ClaimFacetTest::testClaimAsBorrowerRevertsIfNotNFTOwner`; **`…::test_KeeperActionAll_CannotClaimAsBorrower`** |
| Add collateral (`addCollateral`) | `LibAuth.requireBorrowerNftOwner` | `NotNFTOwner` | `AddCollateralFacetTest::testAddCollateralRevertsIfNotEffectiveBorrowerNFTOwner`; **`ClaimFacetTest::test_KeeperActionAll_CannotAddCollateral`** |
| Partial collateral withdrawal (`partialWithdrawCollateral`) | `LibAuth.requireBorrowerNftOwner` + post-withdraw HF/LTV vs the loan's admission floor | `NotNFTOwner` / `HealthFactorTooLow` | `PartialWithdrawalFacetTest::testPartialWithdrawRevertsNotNFTOwner` |
| Direct vault withdrawal (`vaultWithdrawERC20`) | `onlyDiamondInternal` — no external caller, keeper included | (internal-only) | covered by the modifier; exercised across vault flows |
| Transfer a position NFT | ordinary ERC-721 owner/approval + transfer-lock guards; keeper approval is **not** a transfer right | ERC-721 / lock revert | ERC-721 owner/lock tests |
| Lower the liquidation min-out floor | oracle-derived floor in the liquidation facet; caller calldata picks routes but cannot set a lower minimum-out | slippage revert | `LiquidationMinOutputInvariantTest::test_Invariant_MinOutputIsOracleDerived` |
| Redirect claim ownership / recipient | recipients are the loan's lender/borrower (or current NFT holder), never `msg.sender` | n/a | the permissionless-recipient tests below |

## The permissionless exception (not a delegated-keeper right)

Some lifecycle triggers are intentionally callable by **any** address — including,
incidentally, a keeper address — because they are safety/close-out paths whose
*economics are fixed by loan state*, not by the caller:

- `RepayFacet.repayLoan` — anyone may push a repayment; proceeds route to the
  loan's lender (current lender-NFT holder) and collateral back to the borrower
  side, **never to `msg.sender`**. A lender is explicitly barred from repaying
  their own loan (`LenderCannotRepayOwnLoan`).
- `DefaultedFacet.triggerDefault` — anyone may trigger a time-based default;
  settlement routes to the stored parties / treasury. One caller incentive
  exists: if the default finds an internal-match candidate
  (`attemptInternalMatchAutoDispatch`), the caller earns the bounded 1% matcher
  bonus — a bounded incentive, not custody of the loan's principal/collateral.
- `RiskFacet.triggerLiquidation` (and the partial / split paths) — permissionless
  HF-based liquidation; the liquidation settlement routes to the position-NFT
  holders, and only the separate liquidator *bonus* goes to the caller (a bounded
  skim, not a custody transfer of the loan's funds); the min-out floor stays
  oracle-derived.
- `RiskFacet.triggerLiquidationDiscounted` (when the discounted path is enabled)
  — permissionless, and the caller acts as the liquidator: they **pay the debt**
  and pass a `recipient` for the **seized collateral they purchased**. This is a
  liquidation *purchase* (value-for-value), not a custody redirect of someone
  else's funds — the caller cannot take collateral without paying, and the
  borrower's surplus / lender's proceeds still settle to the loan's parties — but
  the matrix calls it out so "no power to redirect custody" is not read as
  forbidding a paying liquidator from naming where the bought collateral lands.

Calling one of these as a keeper address gives the caller **no claim to the
user's principal or collateral and no power to redirect a user's custody or
weaken a safety gate** — the only value a caller can earn is a bounded,
documented incentive (matcher / liquidator bonus) or collateral they paid the
debt to purchase. It is the same call any address can make, distinct from the
delegated-keeper surface above.

## UI rule

The Keeper Settings surface must state the no-custody boundary in plain language:
approved keepers can automate only the listed lifecycle actions and **cannot**
claim, add collateral, withdraw, transfer position NFTs, or redirect vault funds
— those stay owner-only. (Per-loan enablement and the master switch are set
separately, per the keeper-state visibility rules in `WebsiteReadme.md`.)

## Test coverage

**Existing — no-custody boundary proven for a non-owner caller:**
`ClaimFacetTest` (claim NFT-owner gates), `AddCollateralFacetTest`,
`PartialWithdrawalFacetTest` (owner-only collateral ops), and
`LiquidationMinOutputInvariant.t.sol` (oracle-derived min-out, caller cannot
lower the floor).

**Existing — allowed-surface authorization (a keeper without the action bit is
denied):** `LenderIntentCapital.t.sol::test_rollIntentLoan_unauthorizedKeeper_reverts`.
Note this exercises the AUTO_ROLL bit-gate on an *allowed* path — it does NOT
cover a custody-boundary row (vault withdrawal, NFT transfer, recipient routing);
those rows are pinned by the owner-only / `onlyDiamondInternal` tests above and by
the new `KEEPER_ACTION_ALL` tests below.

**Added with this matrix (the `KEEPER_ACTION_ALL` boundary — the novel case):**
`ClaimFacetTest` gains tests that approve a keeper with `KEEPER_ACTION_ALL`,
enable it for the loan, and prove it is **still** rejected (`NotNFTOwner`) on
`claimAsLender`, `claimAsBorrower`, and `addCollateral` — proving the action
bitmask never reaches the custody paths.

The remaining boundary rows (partial-withdraw, vault-withdraw internal-only,
NFT-transfer, min-out) are pinned by the existing tests above; the centralised
owner-only / `onlyDiamondInternal` gates mean the `KEEPER_ACTION_ALL` result is
identical, so a per-path duplicate is tracked as low-priority follow-up rather
than a blocker.
