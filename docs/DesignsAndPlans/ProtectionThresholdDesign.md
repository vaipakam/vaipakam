# Protection or a recorded decline above a liquid-value threshold (#3233)

Status: design note for owner review. Pairs with #3206 (outflow delay, every account) and the
outflow policy (#3205, [VaultOutflowPolicyDesign.md](VaultOutflowPolicyDesign.md)); reads prices
through the path the standalone price guard (#3272) will take over. Line references are to `main`
at the time of writing.

## 1. The rule (owner decision 2026-11-06 09:03 UTC)

An owner's own action that adds value to their vault or opens a position goes through only if,
afterwards, the vault's liquid value is at or below the threshold, or the account has
**decided**. "Decided" means one of:

- (a) **qualifying protection**: protected mode on, with at least one secondary key or an alert
  channel (section 4 says what the contract can and cannot verify here); or
- (b) a **current decline record**: the owner has recorded "I decline protection" against the
  live protection-terms version.

The threshold is governance-set, default $1000 in the platform numeraire. The rule never runs on
payouts, repay, settlement, claims, liquidation, defaults or cures that the protocol drives, and a
price rise never changes anything for an existing position or holds money. A vault that rises above
the threshold through prices or settlements is asked only at its owner's next gated action.

## 2. The value definition

**Vault liquid value** = the sum, over the ERC-20 assets in the account's *tracked holding*, of
each amount valued by the existing KYC rule, `NumeraireValueFacet.getLiquidNumeraireValue`
(`contracts/src/facets/NumeraireValueFacet.sol:64-84`): an asset that `OracleFacet.checkLiquidity`
does not classify Liquid is worth 0, a liquid one is priced by `OracleFacet.getAssetPrice`
(`OracleFacet.sol:604`) and rounded down. NFTs and ERC-1155 balances count 0, as the owner's rule says.

- **Tracked, not raw balance.** The tracked holding (`LibVaipakam.trackedHolding`,
  `LibVaipakam.sol:12690-12696`) is what the protocol put in and has not taken out. Tokens sent to
  the vault outside the protocol are not counted until adopted, and adoption is gated (section 3).
- **Liened amounts count.** Collateral under a loan's lien and principal escrowed for an open
  offer are still in the vault and still the owner's exposure, so they are counted.
- **Lender side: outstanding loans do NOT count.** Settled here, for three reasons.
  1. Once lent, the principal has left the lender's vault. What the lender holds is a position NFT,
     a receivable whose worth depends on the borrower, accrued interest and default risk. The repo's
     valuation rule has no price for that, and inventing one breaks the standing rule against a
     figure the system cannot substantiate.
  2. The value was counted when it entered. A lender's principal passes through a gated deposit or
     a gated create offer while it sits in the vault, so any lender above the threshold has already
     been asked.
  3. Counting it needs a per-holder ledger of open receivables that follows the position NFT. Under
     #3205 §3.9 the NFT moves to its own contract outside the Diamond, so the Diamond would have to
     track transfers it no longer sees.
  The gap this leaves (lend $900, deposit $900 again, lend again) is stated in section 7. What
  protects a receivable is protected mode's NFT protection and #3206, not this gate.
- **Borrower side.** Delivered principal leaves the vault and is not counted. Collateral in the
  vault is counted.

## 3. Where and how it is checked

**Who is checked: the acting account only**, meaning the owner whose own transaction adds value to
their own vault or opens a position for them. A passive party is never checked: an offer's creator
at someone else's accept, both creators at a keeper's match, the buyer behind a standing buy offer.
Checking a passive party would let a price move, or a third party's timing, fail a fill that only
the passive owner could fix. This deliberately differs from #671, which re-checks creators at accept
because a tier can be lowered after posting. See Q1.

The value is read **after** the action's ledger writes, at the end of the entry point (one view; a
revert undoes the whole action). The six owner-named entries map onto these routes:

| Owner's entry | Route (gated for `msg.sender`) | Note |
| --- | --- | --- |
| deposit | `VaultDepositoryFacet.depositToVault` (`:165`), `adoptUntracked` (`:279`), `VPFIDiscountFacet.depositVPFIToVault` / `WithPermit` (`:172`, `:226`) | adoption is a deposit of value already present |
| create offer | `OfferCreateFacet.createOffer` / `createOfferWithPermit` (`:349`, `:414`) | NOT `createOfferInternal` (`:377`), which only the offset (`PrecloseFacet.sol:1796`) and sale-listing (`EarlyWithdrawalFacet.sol:335`) exits reach |
| accept | `OfferAcceptFacet.acceptOffer` / `acceptOfferWithPermit` (`:302`, `:392`) | at the external entry, not at `LoanFacet.initiateLoan` (`:204-205`), whose "acceptor" is not the sender on match and auto-link paths |
| match | the owner's own matched postings: `LenderIntentFacet` (`:210`, `:386`) | keeper `OfferMatchFacet.matchOffers` (`:147`) acts for no owner; its creators were checked when they posted (Q1) |
| add collateral | `AddCollateralFacet.addCollateral` (`:104`) | gated for the vault that receives the collateral; a cure question is open (Q2) |
| buy a lender position | listed sale: through `acceptOffer`; direct sale: the buyer's own buy offer, through `createOffer` | the selling lender (`EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer`, `:292`) is receiving a payout, never gated |

Today's open-position refusal for locked or retired accounts, `LibProtectedAccount.requireCanOpen`
(`LibProtectedAccount.sol:250-256`), sits at the passive-and-active chokepoints. The new gate does
not go inside it, and not inside the ledger writers `recordVaultDeposit` / `recordVaultWithdraw`
(`LibVaipakam.sol:12713`, `:12735`), because those also run for settlement credits, which must
never be gated.

**Placement.** A new `LibProtectionGate` holds the one rule, `requireDecided(account)`. It reads
the protection and decline state from storage and returns at once when the account has decided.
Only otherwise does it make one self-staticcall to a new view facet, `ProtectionGateFacet`, which
hosts the holdings walk. The walk's bytecode then stays out of facets near EIP-170 (CLAUDE.md
records `OfferAcceptFacet` at 164 bytes of headroom before #1835). Each entry facet gains one call,
and `FacetSizeLimitTest` must be re-read at `-vv` for every facet touched. On refusal the gate
reverts `ProtectionDecisionRequired(account, threshold)`.

## 4. What "protected mode on" means to the contract

On-chain, "on" is `protectedAccount[account].enabled` (`LibProtectedAccount.sol:186-188`, struct at
`LibVaipakam.sol:8347-8365`), and the account is neither retired nor locked (a locked or retired
account is refused by `requireCanOpen` anyway). A switch-off that is requested but not yet matured
still counts as on, because payouts are still delayed until it matures.

- **Secondary key**: verifiable. At least one active signer (`protectedSigners`,
  `getProtectedSigners`, `ProtectedAccountFacet.sol:845`). A signer addition waits the account's
  delay (`addSigner` / `_later`, `ProtectedAccountFacet.sol:497-517`, `:159-161`), so the "secondary
  key" setup would gate the user for at least two days. **Proposed:** an accepted, unexpired pending
  addition also counts. The nominee has proven control of the key, and the delay that protects the
  account is already running (Q3).
- **Alert channel**: NOT verifiable on-chain. Alert channels live in the agent (Telegram chat,
  Push subscription; ProjectDetailsREADME "Removing An Alert Chat Waits Under Protected Mode"), and
  nothing in `contracts/src` records them. **Proposed:** an owner-written on-chain flag,
  "alerts linked", which the app writes only after the agent confirms a live chat for that network.
  The account page labels it as the owner's statement, and shows it as unconfirmed when the agent no
  longer sees the chat. The alternative, an agent-attested bit, puts a new off-chain key in the
  trust path (Q4).

## 5. The decline record

- **Storage** (appended at the tail of `Storage`, golden layout updated): per account, the
  terms version declined and the time; one global `currentProtectionTermsVersion`; one threshold
  (zero reads as the $1000e18 default, the repo's "effective config" pattern).
- **Versioned like risk consent.** The record counts only while its version equals the live
  version, the same read-time re-lock as `LibRiskAccess.effectiveTier` (`LibRiskAccess.sol:210-226`).
  A bump re-asks everyone with zero writes. Its own counter, not `currentRiskTermsVersion`
  (`LibVaipakam.sol:5304`), so a risk-terms change does not re-ask declines and vice versa (Q5). No
  commit-reveal: that exists in `revealRiskTermsBump` (`RiskAccessFacet.sol:226-256`) because a
  signed accept ack binds the anchor, and nothing signed binds this version.
- **Writes.** `declineProtection(expectedVersion)`: by the account's manager directly, refused when
  `expectedVersion` is not live, the same checked shape as `setVaultRiskTierChecked`, so a terms bump
  between screen and landing refuses instead of stamping terms the user never saw.
  `revokeProtectionDecline()`: immediate, since it can only tighten. Enabling protected mode also
  clears the record, so a later switch-off re-asks rather than reviving an old choice.
- **Events.** `ProtectionDeclined(account, version)`, `ProtectionDeclineCleared(account, reason)`
  (revoked / protected mode enabled), `ProtectionTermsVersionBumped(version, termsDocHash)`,
  `ProtectionThresholdSet(old, new)`.
- **Views.** `getProtectionDecline(account)` returns version, time, and whether it is current.
  `getProtectionGateStatus(account)` returns: decided-by, threshold, liquid value, whether the
  value is known, and assets walked. `previewProtectionGate(account, asset, amount)` serves the app.
- **Governance.** The threshold setter and the version bump are timelocked admin actions. The
  threshold is range-bounded (Q6).
- **Relayed signature: none (recommended).** #3238 removed the relayed risk `*BySig` setters
  (`LibRiskAccess.sol:26-30`) because nothing used them and a held signature was a phishing surface.
  The same holds here, more strongly: every gated entry is the owner's own transaction, so the owner
  is already sending transactions and can send the decline first. A relayed decline only helps a
  gasless or smart-wallet onboarding flow the app does not have. If the owner wants one anyway,
  bound it as follows. EIP-712 typed data on the Diamond's domain (name, version, chain id, verifying
  contract), struct (account, termsVersion, nonce, deadline). termsVersion must be live. A per-account
  sequential nonce, consumed on use. Deadline at most one hour ahead, enforced on-chain. Contract
  wallets verified through ERC-1271. The event marks it as relayed (Q7).

## 6. Cost of the value read

The tracked ledger is a mapping with no enumeration (`LibVaipakam.sol:8292`). The depository asset
list (`depositoryAssets`, `LibDepositoryLedger.sol:68-80`) covers only depository credits and never
shrinks, so it misses collateral and grows forever. Two shapes were weighed:

- **A running "tracked liquid value" figure: rejected.** A figure kept at write time is valued at
  that day's price. It drifts both ways with every price move and every Liquid/Illiquid
  reclassification, and withdrawals at a different price push it negative or stale. The gate would
  then be deciding on a number nobody can substantiate.
- **Walk the account's held ERC-20s with current prices: chosen.** A new per-account set of
  ERC-20 assets with a non-zero tracked holding, added on 0→positive and removed on positive→0. It is
  written from the ERC-20 deposit and withdraw routes, which know the asset kind; the shared writer
  takes only a token id, and an ERC-721 can have token id 0. Bounded by:
  1. **Short-circuit.** A decided account pays only for storage reads, no oracle. After the first
     prompt this is the steady state for every large account.
  2. **Early exit.** The walk stops as soon as the running sum passes the threshold, and it starts
     with the asset the action just added.
  3. **A walk cap K** (proposed 8 assets). An undecided account with more than K held ERC-20s is
     treated as above the threshold and asked. Asking is cheap and holds nothing.
  4. **Unknown is not zero.** A Liquid asset whose price read refuses makes the value *unknown*.
     The gate then asks, as it does above the threshold, rather than counting the asset as 0. The
     status view says "value unknown" (Q8).

  Each walked asset costs one liquidity classification plus one quorum price read, the same cost as
  a KYC leg value today (`OfferAcceptFacet.sol:1787-1796`). It is not measured yet: a gas-snapshot
  test pins the worst case (K assets, all below the threshold) before code review. Under #3272 the
  price half moves to the guard unchanged, and the gate inherits it through `NumeraireValueFacet`.
  The set costs one extra storage write per first deposit of a new asset, and refunds on emptying.

## 7. Residual risks (stated)

- **Splitting across wallets.** The rule is per account. Five wallets at $900 each never prompt.
  Wallets cannot be linked on-chain, and the gate does not try.
- **Value that grows without an entry.** Repayments, claims and price rises can lift a vault above
  the threshold with no prompt until the next gated action. Outstanding loans are not counted, so
  repeated lend-and-redeposit cycles can build exposure below the threshold. #3206's outflow delay
  above $1000 per 24h covers the withdrawal end for every account.
- **The decline is consent, not a theft barrier.** A thief holding the key can record a decline in
  one transaction. What slows a thief is #3206 and protected mode itself. The decline event is public
  and the agent can alert on it for any subscribed owner.
- **The alert flag is the owner's own statement** (section 4), and the contract cannot see a chat.
- **NFT-heavy vaults never prompt**, because illiquid assets are worth 0 by the owner's rule.
- **Standing offers fill as posted.** A creator who later switches protection off is not re-asked
  at a stranger's accept (Q1).
- **Oracle outage.** Undecided accounts above (or possibly above) the threshold are asked to decide
  before entering. Decided accounts are unaffected.

## 8. App flow

Before any gated transaction the app calls `previewProtectionGate`. When the result would cross the
threshold and the account is undecided, a step before signing says, with the on-chain threshold and
the post-action value (or "value unknown, a price could not be read"), that above this amount the
platform asks for protection or a recorded choice. It offers:

1. **Minimum delay plus owner alerts**: enable protected mode at the 2-day minimum
   (`LibProtectedAccount.MIN_DELAY`, `LibProtectedAccount.sol:51`), and after #3246 set the mandatory
   recovery address. Link the Telegram chat, then write the alerts-linked flag. The app states what
   the delay will hold: payouts to the owner's wallet wait two days.
2. **A secondary key**: protected mode on, nominate the key, and the key accepts from its own wallet.
   The app says the key becomes fully active after the delay, and whether the pending key already
   satisfies the gate (Q3).
3. **Decline**: the versioned text, then the decline transaction.

The protection page shows how the account is decided and the decline's version and date, offers
Revoke, and re-asks after a terms bump. Unread state is shown as unknown, never as "not needed".
Every refusal names the remedy; none is a dead end. e2e: CI-Anvil specs for all three paths and the
terms-bump re-ask; `apps/app/e2e/COVERAGE.md` updated.

## 9. Spec change (public copy)

Replace "an account that never turns protected mode on: the key holder decides" with: "Above a
liquid-value threshold set by governance (by default $1000 in the platform's reference currency,
with assets that have no reliable market valued at nothing), an owner's own deposit, new offer,
accept, matched posting, collateral top-up or purchase of a lender position goes ahead only once the
account has protected mode on with a second key or linked alerts, or the owner has recorded that they
decline protection. A decline is re-asked when the protection terms change and can be withdrawn at
any time. Payouts, repayments, settlements, claims and liquidations never wait on this, and a price
rise changes nothing for a position already open." The edit lands in `ProjectDetailsREADME.md`
(Protected Account Mode), `VaultOperations.md` (Optional account protection), `WebsiteReadme.md`
(Vault Protection Experience) and the ThreatModel §5 "Small accounts" residual, each with the
release-note fragment.

## 10. Tests

- Boundary: exactly at the threshold passes; one base unit above refuses for an undecided account
  at each of the six entries, and passes for a decided one.
- The acting party only: an undecided creator above the threshold is not checked at someone else's
  accept, nor at a keeper match. The offset and sale-listing internal creates are not gated.
- Never gated (one test per route): repay, preclose, refinance completion, claims, default,
  HF liquidation, fallback, settlement credits into a protected or unprotected vault, a price rise
  followed by repay.
- Valuation: illiquid and NFT holdings count 0; untracked tokens count 0 until adopted (adoption
  gated); liened collateral counts; a lent-out principal does not.
- Walk: early exit; the K+1 asset asks; an asset that refuses a price makes the value unknown and asks;
  the set adds on 0→positive and removes on positive→0 for every ERC-20 deposit and withdraw route;
  ERC-721 token id 0 never enters it.
- Decline: written only by the manager; a stale `expectedVersion` refuses; a version bump voids it
  with zero writes; revoke is immediate; enabling protected mode clears it; events and views agree.
- Protection: enabled with an active signer passes; an accepted pending signer passes or refuses
  per the Q3 decision; locked and retired accounts are still refused by `requireCanOpen`.
- Governance: threshold bounds, timelock, events. Deploy-sanity: selectors, sizes at `-vv`, storage
  golden. A gas snapshot of the worst-case walk.

## 11. Questions for the owner

- Q1. Acting party only (proposed), or re-check passive creators at accept and match, as #671 does?
- Q2. Gate add collateral always, or let it pass when the loan is below the 1.5 initiation health
  factor, so a cure is never blocked by a missing decision?
- Q3. Does an accepted, still-pending secondary key satisfy the gate before its delay matures?
- Q4. Alert channel: an owner-written "alerts linked" flag (proposed), an agent-attested bit, or
  protected mode alone?
- Q5. A separate protection-terms version (proposed), or reuse the risk-terms version?
- Q6. Threshold bounds (proposed $100 to $100,000), and one knob shared with #3206's $1000 or two?
- Q7. Confirm there is no relayed decline. If one is wanted, confirm the one-hour deadline cap.
- Q8. An unreadable price: ask (proposed), or count that asset as 0? And the walk cap K = 8?
- Q9. Are lender-intent postings the "match" the decision means, and should keeper matches stay
  unchecked?
