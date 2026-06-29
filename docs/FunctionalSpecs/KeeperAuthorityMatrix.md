# Keeper Authority Matrix — the no-custody boundary

**Status:** intended-behaviour specification (the test oracle). Sourced from the
keeper-delegation design (Phase 6) and the security boundary documented across
`docs/FunctionalSpecs/WebsiteReadme.md` (keeper UX) and `docs/IncidentRunbook.md`
— not transcribed from the contracts. The "Verified at" / "Tested by" columns
reference where each rule is enforced and exercised; a divergence between this
matrix and the code is a bug to be logged in `_CodeVsDocsAudit.md`, not a reason
to edit the matrix.

This addresses GitHub issue #803 — so a reviewer can audit keeper authority from
**one** matrix instead of reconstructing it from comments scattered across
facets. The load-bearing claim it pins: **a delegated keeper is an automation
agent, never a custodian.** Even a keeper a user has approved with *every* action
bit (`KEEPER_ACTION_ALL`) cannot claim funds, move money out of a vault, transfer
a position NFT, redirect proceeds, or weaken a safety gate.

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

Each row is reachable by a keeper holding the listed action bit (plus the three
gates above). Every one is a **lifecycle/automation** action that routes value to
the loan's own parties — never to the keeper.

| Delegated action | Action bit | Entitled side | Enforced at |
| --- | --- | --- | --- |
| Initiate early withdrawal / loan-sale listing | `INIT_EARLY_WITHDRAW` | lender | `EarlyWithdrawalFacet` |
| Complete loan sale | `COMPLETE_LOAN_SALE` | lender | `EarlyWithdrawalFacet` |
| Initiate preclose (direct / transfer / offset) | `INIT_PRECLOSE` | borrower | `PrecloseFacet` |
| Complete offset | `COMPLETE_OFFSET` | lender | `PrecloseFacet` |
| Refinance loan | `REFINANCE` | borrower | `RefinanceFacet` |
| Auto-extend in place | `EXTEND` | both (per-loan caps) | `AutoLifecycleFacet` |
| Fill a standing signed intent | `SIGNED_FILL` | lender (principal-keyed) | `OfferMatchFacet` |
| Auto-roll a repaid intent loan | `AUTO_ROLL` | lender (principal-keyed) | `LenderIntentFacet` |

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
- `DefaultedFacet.markDefaulted` / `triggerDefault` — anyone may trigger a
  time-based default; settlement routes to the stored parties / treasury.
- `RiskFacet.triggerLiquidation` — permissionless HF-based liquidation; the
  liquidation settlement routes to the position-NFT holders, and only the
  separate liquidator *bonus* goes to the caller (a bounded skim, not a custody
  transfer of the loan's funds), and the min-out floor stays oracle-derived.

Calling one of these as a keeper address gives the caller **no claim ownership
and no power to redirect custody or weaken a gate** — it is the same call any
address can make. This is distinct from the delegated-keeper surface above.

## UI rule

The Keeper Settings surface must state the no-custody boundary in plain language:
approved keepers can automate only the listed lifecycle actions and **cannot**
claim, add collateral, withdraw, transfer position NFTs, or redirect vault funds
— those stay owner-only. (Per-loan enablement and the master switch are set
separately, per the keeper-state visibility rules in `WebsiteReadme.md`.)

## Test coverage

**Existing (boundary proven for a non-owner caller):**
`ClaimFacetTest` (claim NFT-owner gates), `AddCollateralFacetTest`,
`PartialWithdrawalFacetTest`, `LenderIntentCapital.t.sol`
(`test_rollIntentLoan_unauthorizedKeeper_reverts` — keeper without the bit is
denied), `LiquidationMinOutputInvariant.t.sol` (oracle-derived min-out).

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
