# Protected mode: selling or handing over a locked position — design note (#3339)

**Status:** built 2026-11-16 on the batch branch. Owner rules: the #3339
comments of 2026-11-08 (items 1–3, 5 and 6; item 4, the pre-authorised sale,
was dropped). Ships by fresh deploy.

## 1. The gap

Protected mode puts the account's position NFTs under the PositionNFT core's
holder lock. Before this change, that lock also refused every protocol route
that moves a position out of the account: the listed and direct lender sales
and the borrower's obligation handover (`PositionNftsLocked`, from
`LibLoan._requirePositionMayLeave` and `SaleExitVerdictFacet`). A protected
holder had to request an unlock and wait the delay before it could exit a
loan early.

## 2. The rule

One read, `LibProtectedAccount.positionExit(account)`, hosted on
`ProtectedAccountFacet.positionExitOf`, classifies the holder:

| Holder | Exit | Why |
| --- | --- | --- |
| No holder lock | Free | Unchanged. |
| Protected mode on, vault not locked, not retired, holder lock on | UnderDelay | Everything that comes back lands in the account's own vault, where every wallet payout waits the delay and the owner or any signer can cancel it. |
| Retired account | Held | The old wallet has lost every right over it. |
| Protected vault locked | Held | A lock usually means a key is suspected. |
| Holder lock without protected mode | Held | No payout delay would cover the proceeds, so the lock's promise needs the unlock delay. |

`Held` refuses as before (`PositionNftsLocked`; the sale verdict names
`AccountRetired` or `ProtectedVaultLocked` first where they apply).

## 3. What comes back, verified in code

- **Lender sale, both routes.** The seller's net is credited to the seller's
  own vault (`LibFacet.creditOwnVault`, #3629), never to a wallet. The
  seller's earned and unpaid interest becomes the seller claim (#1209), paid
  later through the vault outflow to the owner, which protected mode gates.
- **Borrower handover.** The released collateral goes through
  `LibVaultOutflow.toPositionHolder` to the vault of the exiting holder, the
  same vault it sits in. No price floor is needed (item 3 confirmed).

## 4. The lender-sale floor

A sale may pay the buyer a rate shortfall (the buyer's higher rate over the
remaining term) out of the seller's principal. For an `UnderDelay` seller
that would move value to a third party at once, past the delay, so it is
refused:

- at completion, both routes: `LibProtectedAccount.requireLockedSaleFloor`
  reverts `LockedSaleShortfall(seller, shortfall)` for any shortfall above
  zero (it reads the host only when there is one);
- at listing: `requireLockedSaleRate` reverts `LockedSaleRateAbove` for a
  listing rate above the loan's, which could never settle.

With no shortfall the seller receives the whole principal into its vault and
keeps its accrued interest as the seller claim: the floor is principal plus
accrued interest, taken from the loan's own terms, so it holds for any
collateral, NFTs included. The co-signed shortfall cap the issue offered as an
alternative was not built: no shortfall at all is the simpler and stricter
rule, and the seller can still choose a buy offer at or below the loan's rate.

## 5. Unchanged

Lock and unlock rules (an unlock always waits the delay, no co-signed instant
unlock); plain ERC-721 transfers and outside-marketplace sales stay blocked
while locked; a buyer or incoming borrower that is a locked protected account
is still refused.

## 6. Alternatives considered

- **Allow any holder-locked account, protected or not:** a self-locked
  account without protected mode has no payout delay, so a stolen key could
  sell and withdraw at once; rejected.
- **Cap the shortfall at a co-signed amount:** more state and a signer flow
  for a case the seller can avoid by choosing the buy offer; deferred.
- **Pre-authorised sale:** dropped by the owner (2026-11-08).

**Recommendation:** as built.
