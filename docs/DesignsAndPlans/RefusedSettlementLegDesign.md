# A settlement leg the token refuses (#3669)

Status: decided (owner, 2026-11-15: "lien in place, close the loan"). Builds
the blacklistable row of
[`WeirdErc20HardeningSweepDesign.md`](WeirdErc20HardeningSweepDesign.md):
the other party's settlement and the loan's terminal state complete even when
a token refuses to move one leg.

## 1. Why

Some tokens let their issuer freeze an address, or pause every transfer. A
settlement step that moves a leg into a vault the token has frozen reverts,
and today the whole step reverts with it. Two cases came out of the #1220
matrix (`contracts/test/WeirdErc20MatrixTest.t.sol`):

- **Repay.** The borrower's repayment goes from the borrower's wallet into the
  lender's vault. If the lending asset freezes the lender's vault, the
  borrower cannot repay, so the loan runs past grace and defaults on the
  borrower's collateral, through no act or fault of the borrower.
- **In-kind default.** The collateral goes from the borrower's vault to the
  lender's vault. If the collateral asset freezes the borrower's vault, the
  default reverts and the loan never reaches a terminal state.

The rest of the matrix held. A frozen wallet only holds up its own
withdrawal, a paused token holds up every step until it resumes, a
false-return token is refused, and a rebase down fails visibly.

## 2. The rule

When a forced or terminal settlement step cannot move a leg to its payee,
the leg stays in the payer's own vault, under a lien for the payee, and the
step completes. The loan reaches its terminal state. The payee's claim
releases the leg from the payer's vault when the token allows the move.

Nothing waits in the Diamond. Users' funds stay out of the Diamond, and the
same rule already governs the fallback custody since #1566 S2b.

What parks, and what does not:

| Step | Leg | On refusal |
| --- | --- | --- |
| Full repay, partial repay, periodic interest | borrower wallet to lender vault | parks in the borrower's vault for the lender side |
| Preclose (direct and offset completion), swap-to-repay | payer to lender vault | parks in the payer's vault for the lender side |
| In-kind default (ERC-20, ERC-721, ERC-1155) | borrower vault to lender vault | stays in the borrower's vault for the lender side |
| Treasury share of any of the above | payer to treasury | parks in the payer's vault for the treasury |
| Loan origination, offer posting, sales, claims, withdrawals | any | refuses, as today: nothing is open yet, or only the frozen party's own leg waits |

A leg parks only after the attempt to move it fails **and** the payer's vault
or wallet holds the whole leg. A vault that holds less than its tracked
amount (a rebase down) still fails visibly, as the sweep's rebase row
requires: a parked leg must always be paid in full later.

## 3. One host

Every parking leg goes through one self-call on a new host facet,
`SettlementLegFacet`, the way fees go through `TreasuryFeeFacet` (#2440):

- `deliverOrPark(...)`: attempts the move as a nested self-call with a fixed
  gas budget. The host requires enough gas for that budget before the
  attempt, so a caller cannot starve the move to make it park (the
  `ProtocolBroadcastFacet` rule). On failure it moves the leg into the payer's
  own vault if it is not already there, places it under the loan's lien for
  the payee side, writes the parked row and emits `SettlementLegParked`.
- `releaseParked(loanId, side)`: `address(this)`-gated. The claim of that side
  calls it first. It moves the parked leg from the payer's vault to the vault
  of that side's stored party (the `ClaimCustody` class, where a settlement
  parks a side's share today), clears the row and emits
  `SettlementLegReleased`. The claim then pays as it always does. While the
  token still refuses, the claim reverts and the row stays, so the payee
  retries later.
- `getParkedLeg(loanId, side)`: the row, for the app and the indexer.

The calling facets each gain one self-call in place of a direct move, so the
change costs a few bytes in facets that sit close to EIP-170. The rule, the
gas budget and the lien bookkeeping exist once.

A treasury leg parks under a treasury row, released by a permissionless
`releaseParkedTreasury(loanId)` (keeper-backed, shipped disarmed) to the
treasury the payer's vault code names.

## 4. What the parties see

- The loan is Repaid or Defaulted, with the usual claim rows. A parked side's
  claim amount is unchanged; `getParkedLeg` says where it is and why.
- The borrower's vault shows the parked leg as liened, not as the borrower's
  free balance.
- `SettlementLegParked(loanId, payer, asset, assetType, tokenId, amount)` and
  `SettlementLegReleased(loanId, payer, arrived)` are state-change events.
  The loan's own status events still carry its lifecycle, so the indexer
  allowlists both for now; surfacing the parked row there is a follow-up.

## 5. Alternatives considered

- **Accept it as listing risk** and state it in the trust-tier copy. Freezable
  stablecoins are the most common lending assets, so this leaves an
  issuer-assisted grief against every borrower of one. Rejected (owner).
- **Park in the Diamond.** Simpler bookkeeping, but it puts user funds in the
  Diamond, which the platform rules out.
- **Try/catch inside each facet.** Repeats the rule in about eight facets, most
  near EIP-170, and each copy could drift on the gas guard or the rebase check.

## 6. Recommendation

Build the host and route the paths in section 2 through it, starting with full
repay and in-kind default, which the matrix proved. Extend the matrix with a
cell per row of the table.

## 7. What is built (first phase)

`SettlementLegFacet` hosts the rule for the lender side:

- `deliverLenderDueOrPark` carries full repay's lender leg. A refused
  delivery is moved from the payer's wallet into the payer's own vault and
  liened there.
- `moveInKindCollateralOrPark` carries the in-kind default's collateral move
  (ERC-20, ERC-721 and ERC-1155). A refused move leaves the collateral where
  it is, under the loan's existing collateral lien.
- `releaseParkedLeg` runs first in the lender claim. It moves the leg into
  the stored lender's vault through the claim-custody outflow class and sets
  the claim to what arrived.

- `depositLenderShareOrPark` carries a forced sale's lender share (the
  liquid default and the Health-Factor liquidations, which all book through
  `ForcedSaleFacet.sellToNeed`). The Diamond holds the share from the sale;
  a refused deposit into the lender's vault goes into the stored borrower's
  vault instead, since the collateral sold was theirs, and is liened there.

## 8. What does not park, and why

A closer read of the remaining rows of the table in section 2 changes two of
them:

- **Partial repay, preclose and swap-to-repay** are the borrower's own
  choices on an open loan. A refusal leaves the borrower full repay, which
  parks, so no one is held hostage. They refuse as today.
- **Periodic interest** pays the current lender-position holder while the
  loan is open. A refusal delays only that holder's own interest, and the
  forced sale that would settle the period stops with it, which costs the
  borrower nothing. It refuses as today.
- **The treasury share** does hold others hostage: a frozen treasury would
  stop every repayment and default in that token. It parks (section 9).

## 9. The treasury share

`SettlementLegFacet.treasuryShareOrPark(source, owner, asset, amount)`
attempts the move through `TreasuryFeeFacet` (from `owner`'s wallet, from
`owner`'s vault, or from proceeds of `owner`'s the Diamond holds). When the
token refuses it, the share goes into, or stays in, `owner`'s vault under a
lien for the treasury, added to one row per owner and asset. The forced and
terminal sites call it through `LibFacet.treasuryShareOrPark`: full repay
(wallet and rental), the time-based default's rental buffer and fee, the
forced sale's terminal share, the prepay sale's settlement and the
fallback retry's distribution. Voluntary sites keep the plain helpers.

`releaseParkedTreasury(owner, asset)` is open to anyone: it sends the whole
row to the treasury the vault code names and accrues what arrived. Its
keeper pass is a recorded gap (#3669) and ships disarmed.

Two limits are known. Parked VPFI still counts toward its holder's fee
tier until it is released. And the periodic and partial liquidation routes
keep the plain treasury helper, so a frozen treasury stops them; the full
liquidation and the default, which park, remain open.
