# Protected mode guards commitments — design note (#3227)

Status: **design for owner review, no code.** Scope is the three guards the
owner kept on #3227 on 2026-11-06: the off-band rate, the lender-position sale
below 95% of par, and the NFT listing below the owner's minimum. Illiquid and
unpriced collateral goes through the risk-access tiers (#671,
`riskAccessGateEnabled` with its opt-up cooldown). It is not covered here. The
liquidation swap cap stays at 6% (`MAX_LIQUIDATION_SLIPPAGE_BPS`,
`LibVaipakam.sol:261`) and the swap-to-repay cap at 3%
(`MAX_SWAP_TO_REPAY_SLIPPAGE_BPS`, `LibVaipakam.sol:268`). The second-source
check for forced sales, listed under #3227 in `ThreatModel.md:98`, is not
designed here either (see Q8).

## 1. Principles

- **Protected accounts only.** An account not in protected mode is unchanged
  on-chain. The app shows a warning before it signs.
- **A delay, never a refusal.** A commitment outside a guardrail is accepted
  and recorded. It becomes fillable only after the account's protected delay
  (`delaySeconds`, 2–5 days, `LibProtectedAccount.sol:51-53`). A lock in the
  meantime voids it.
- **Inside the guardrails, nothing changes.** The commitment executes at once,
  through today's code path.
- **One rule, enforced at fill.** Each guard is judged when the commitment is
  made, and the result is stored. Every route that can complete the
  commitment re-reads that record at the completion chokepoint. A route that
  skips the commit step (a signed off-chain order, a pre-validated
  marketplace order) is still caught at fill.
- **Voiding reuses the change epoch.** A lock, a switch-off and a primary
  replacement already advance `protectedChangeEpoch`
  (`LibVaipakam.sol:8220`, `ProtectedAccountFacet.sol:173-191`, called from
  `_lock` at `:631-667`). Every queued commitment records the epoch it was
  queued in, and it is live only while that epoch is current. A lock therefore
  voids all of an account's queued commitments with one storage write, without
  a sweep, and an unlock cannot revive them.
- **The surface states what it knows.** Where a rule cannot be judged (no rate
  model, no fresh reference rate, an asset that does not match the minimum's
  asset), the app says which rule and why. It never implies the account was
  checked.

## 2. Shared mechanism: the commitment guard record

A new library `LibProtectedCommitment` holds the rules, and a new
`ProtectedCommitmentFacet` holds the entry points and views.
`ProtectedAccountFacet` (941 lines) and the offer, sale and listing facets
sit close to EIP-170, so this is the clean placement: the chokepoints call one
library function each. Storage is appended at the tail of
`LibVaipakam.Storage`, the storage-layout golden file is regenerated, and the
full facet registration list from CLAUDE.md applies.

**The record.** It is keyed by `(kind, ref)`. `ref` is the offer id, the
order hash, the signed-offer digest or the queue-row id, depending on the
kind. Its fields:

- `account`, the protected account it guards;
- `rule`: off-band rate, sale below par, or below the NFT minimum;
- `observed` and `threshold`, so the app can state the figures;
- `liveAt`, the commit time plus `delaySeconds` in force at commit;
- `epoch`;
- `state`: queued, released, cancelled.

It is **live** when the state is queued or released, the epoch is current and
`block.timestamp ≥ liveAt`. No record means the commitment was inside the
guardrails. A per-account set of open guard ids, keyed by epoch like
`protectedPendingAllowlist`, feeds the views and alerts. It is bounded by
`MAX_QUEUED_COMMITMENTS` (proposal: 16, the same as `MAX_OPEN_ROWS`,
`LibProtectedAccount.sol:61`). A full set makes a new out-of-guardrail
commitment revert. That is a capacity refusal the app explains, not a policy
refusal.

**Two shapes of commitment.**

- *Standing* commitments wait to be filled by someone else: an offer, a sale
  listing or an NFT listing. They need no release step. They simply become
  fillable at `liveAt`.
- *Instant* commitments are completed by the account's own call: accepting an
  offer, the direct sale into a buy offer, the atomic match of a bid. These
  become a **queued action row**. The row stores the target and a hash of the
  terms the account agreed to. After `liveAt`, anyone may execute it, as with
  a payout release (`beginRelease`, `LibProtectedAccount.sol:447-460`).
  Execution re-runs the ordinary route with the stored terms, and reverts if
  the counterparty's terms hash has changed. Nothing is earmarked while it
  waits. If the funds are gone at execution, the execution fails and the row
  lapses, and nothing is lost.

**Cancel and void.**

- The manager may cancel any guard record; for a retired account that is the
  controller.
- A secondary signer may also cancel. That only makes the commitment
  unfillable: the funds of a voided offer stay in the owner's vault until the
  owner cancels the offer.
- A lock voids by epoch, as above. After an unlock, the owner may re-queue a
  voided standing commitment with `requeueCommitment(kind, ref)`. It gets a
  fresh `liveAt` in the new epoch and is never revived silently.
- **Co-sign.** If the account has `requireCosign`, a queued commitment also
  needs one signer's approval before it is live, the same rule as for payouts
  (`LibProtectedAccount.sol:453`) (Q5).

**Events.** All of these sit under the
`state-change/offer-mutation` or `loan-mutation` categories, so the indexer's
event-coverage guardrail requires a handler for each.

- `CommitmentQueued(account, kind, ref, rule, observed, threshold, liveAt)`
- `CommitmentCosigned(account, kind, ref, signer)`
- `CommitmentReleased(account, kind, ref)`, for action rows only
- `CommitmentCancelled(account, kind, ref, by)`

A lock voids queued commitments without a per-record event. The indexer infers
the void from the existing `VaultLocked`, and the view reports it as `voided`.

**Views.**

- `getCommitmentGuard(kind, ref)` returns the rule, the observed figure, the
  threshold, `liveAt`, the state, and whether the record is voided by epoch.
- `getQueuedCommitments(account)`.
- `previewCommitmentGuard(...)` per kind, for the app before signing. It runs
  the same library function as the commit, so the quote and the rule cannot
  drift (the `projectSellerBounds` pattern, `LibSaleListing.sol:227`).

The keeper's existing protected-mode alerts subscribe to `CommitmentQueued`
through the operator-facing path the payout alerts already use.

## 3. Guard A — off-band rate

**Current code.** A typed rate is binding and never passes through a model
(`OfferCreateFacet.sol:1477-1488`). `RateModelFacet.quoteOfferRateBps` clamps
a model's quote to `ref ± halfWidth` (`RateModelFacet.sol:172-199`; the band
formula is at `:87-104`). However, `ref` is **supplied by the caller**
(`IRateModel.sol:55`, `RiskPremiumRateModel.sol:43`). The repo stores no
reference rate on-chain. So "outside the band" has no centre for a
hand-typed offer, and this guard needs one (Q1).

**Proposed reference.** A per-chain record per `(lendingAsset, tenor bucket)`
holds a reference rate and its update time.

- A bounded role publishes it. The proposal is `WATCHER_ROLE`, with a
  staleness bound and a **movement cap over time, not per update**. Each key
  keeps an anchor rate and the anchor's time. The anchor rolls forward to the
  current rate only once 24 hours have passed since the anchor's time, and
  every update must stay within the cap of the anchor. Repeated updates in one
  block, or across a day, cannot reset it, so the reference moves at most the
  cap within one anchor period and at most twice the cap in any 24 hours.
  Updates are also at least one hour apart.
- The band centre is the registered model's quote at that reference, clamped
  as today. The half-width is `cfgRateModelBandHalfWidthBps(ref)`.

The rule **applies** only when a rate model is registered, a reference exists
for the asset and tenor, and that reference is fresh. Otherwise it does not
apply, and `getRateGuardStatus(lendingAsset, durationDays)` returns the reason
(no model / no reference / stale) for the app to state.

**Trigger: directional, on the worst end the account committed to.**

- For a protected **lender**, the rate is off-band when the lowest rate it
  accepts (`interestRateBps`) is below the band.
- For a protected **borrower**, the rate is off-band when the highest rate it
  accepts (`interestRateBpsMax`, or `interestRateBps` for single-valued
  offers) is above the band.

An above-band lender offer or a below-band borrower offer harms only the
thief's side, so it executes at once (Q2). NFT rental offers are excluded,
because their pricing is a daily fee and not an APR (Q3). **The synthetic
borrower offer a lender's listed sale creates** (`EarlyWithdrawalFacet._buildSaleParams`,
`EarlyWithdrawalFacet.sol:418`) is also excluded from this rate rule. Its
creator is the selling lender and its rate is the buyer's asked APR, so the
borrower rule would judge a sale as if it were a loan request. A sale's
economics are judged by guard B (§5), the same as the direct sale route, so a
listed sale is never held by an APR the seller does not pay.

**Where the check runs.**

- *Commit*: `_createOfferFinish` (`OfferCreateFacet.sol:1219`, next to
  `requireCanOpen`) and every rate or terms mutation (`setOfferRate`,
  `modifyOffer`, `OfferMutateFacet.sol:212,290`).
  - A mutation is a new commitment. An off-band mutation gets a **new**
    `liveAt` measured from the mutation, never the old one, so "queue early,
    then mutate" gains nothing.
  - A mutation back in-band closes the record.
- *Fill*: `LoanFacet.initiateLoan` (`LoanFacet.sol:188-205`).
  - It is the chokepoint for accept, match, signed fill and sale vehicle, and
    it already calls `requireCanOpen` for both parties.
  - It refuses with `CommitmentNotLive(kind, ref, liveAt)` when **any
    standing offer the fill consumes** has a non-live record: the creator's
    offer on an accept, and **both** offers on a match. A match passes the
    borrower's offer as the accepted offer and carries the lender's offer
    separately in the match context (`matchLenderAuthOfferId`,
    `LibOfferMatchExecute.sol:343-355,382-385`), so the lookup resolves the
    lender's record from that context rather than from the accepted offer.
    One shared check takes the list of consumed offer ids, so no fill route
    can check a subset.
  - The resolved rate (`LoanFacet.sol:1021-1074`, including the match
    midpoint) is always inside the offer's committed range, so no fresh
    judgement is needed at fill.
- *Acceptor side*: when a protected account accepts an offer whose rate is
  off-band against it, the accept becomes a **queued accept row**. The row
  stores the offer id, the hash of the offer's current terms, and the consent
  flags. A later mutation of the offer changes the hash and the execution
  fails.
- *Signed offers* (`SignedOfferFacet.sol:84,117`) have no commit transaction.
  - At fill, `initiateLoan` judges the materialized offer. If the signer is
    protected and the offer is off-band, the fill requires that the signer
    **armed** that digest on-chain (`armSignedOffer(digest)`) at least
    `delaySeconds` earlier.
  - The arm is a guard record of kind signed-offer, voided by epoch.
  - An in-band signed offer stays gasless.
  - A protected account accepting an off-band signed offer queues an accept
    row holding the digest, and the execution takes the signed offer and its
    signature again as calldata.
- *Matches* (`OfferMatchFacet.sol:147`) reach `initiateLoan`, which checks
  both the lender's and the borrower's records, so either queued standing
  offer simply goes unmatched until it is live. The rate the match resolves is
  not a substitute: a lender offer whose low range end put it off-band can
  match at an in-band midpoint, and it still waits.
- *Lender intents* have no standing offer to wait. `matchIntent`
  materializes a fresh slice and fills it in the same transaction, so a delay
  started at that point could never mature: the failing fill would revert the
  record with it. The guard is therefore recorded against the **persistent
  intent**, when it is registered and whenever its terms change:
  - an off-band protected intent gets a guard record keyed by the intent id
    and a hash of its terms, live after `delaySeconds`, voided by epoch;
  - a materialized slice inherits the intent's authorization: `initiateLoan`
    accepts an off-band slice only if the parent intent's record is live and
    its terms hash still matches;
  - any change to the intent's rate or terms writes a new record and restarts
    the delay.

**Drift.** The reference can move after commit, and a live offer is not
re-queued for that (see the residual risks in §6).

**App copy.**

- "Rate outside the market band (x%–y% for USDC, 90 days). Because protected
  mode is on, this offer goes live on {date time}. Locking your account
  before then cancels it."
- Where the rule does not apply: "The market-band check isn't available on
  this network ({no rate model registered | no reference rate for this asset
  | reference rate is stale}). Protected mode can't hold off-band rates
  here."
- For an account without protected mode: "This rate is x points outside the
  market band. Check that you meant it."

## 4. Guard B — lender-position sale below 95% of par

**Current code.** The only price guard is the seller's own floor:

- the direct route, `SaleBounds.minSellerNet`, checked at
  `EarlyWithdrawalDirectFacet.sol:718-722`;
- the listed route, the recorded floor at `EarlyWithdrawalFacet.sol:694-703`.

The seller's cost of a sale is the rate shortfall alone. That is the buyer's
higher rate over the remaining term (`LibSaleListing.sol:267-283`). Since
#1209 the interest the seller earned stays with the seller as a claim
(`LibInterestLedger.recordSale`, `LibInterestLedger.sol:268`).

**Definitions.**

- **par** = outstanding principal + interest accrued to the seller, both in
  the lending asset.
- **seller value** = the cash net at completion (proceeds − shortfall) + the
  seller claim the sale records.

So the rule reads: hold when `seller value < 95% × par`, which is the same as
`shortfall > 5% × par`. The comparison is entirely in the lending asset. The
oracle is used only for cross-asset display. This rule applies to every
lending asset (Q4). 95% is a fixed constant in the proposal (Q6).

**Where the check runs.**

- *Listed route.*
  - The sale rate is fixed at listing, so `createLoanSaleOffer(Bound)`
    (`EarlyWithdrawalFacet.sol:170,219`) judges it with the worst case over
    the listing window that `projectSellerBounds` already computes.
  - A below-par sale offer gets a guard record.
  - `initiateLoan` refuses to fill a sale vehicle with a non-live record. It
    already detects sale vehicles (`LoanFacet.sol:212`).
  - `completeLoanSaleInternal` re-checks the record. That covers the manual
    `completeLoanSale` path.
- *Direct route.*
  - `sellLoanViaBuyOffer(Bound)` (`EarlyWithdrawalDirectFacet.sol:292,338`)
    is instant. A below-par sale by a protected seller becomes a **queued
    direct-sale row** holding the loan id, the buy-offer id, the buy offer's
    terms hash, `minSellerNet` and a deadline.
  - Anyone executes it after `liveAt`, through the same implementation.
  - It fails if the buy offer changed, was taken, or the deadline passed.
  - The row's deadline must be at least `liveAt` plus a margin, or the row
    can never execute. The app sizes it.
- Position-NFT movement between queue and execution voids the row through
  #3205's transfer-count check, or the current NFT lock until that ships.

**App copy.** "This sale nets you {net} of a {par} position ({pct}%), below
the 95% protected-mode line. It goes live on {date time}. Locking cancels it.
Above 95% it would go through at once." For an account without protected
mode: "You'd receive {pct}% of this position's value."

## 5. Guard C — NFT listing below the owner's minimum

### 5.1 The minimum record

- **Storage:** per account wallet, per `(collection, tokenId)`, a record of
  `asset`, `amount`, `pendingAmount`, `pendingAt` and `epoch`. ERC-1155
  records a per-unit amount, and every comparison scales it by the quantity
  the order sells (see the effective floor below).
- **Set or raise:** instant. Either the manager or a signer may raise, because
  a raise only tightens the guard. The first setting is also instant: until
  then the effective floor is what the lender and treasury are owed, so a
  thief setting a low minimum gains nothing beyond the default.
- **Lower, clear or change asset:** recorded as pending with
  `pendingAt = now + delaySeconds`, and finalized by anyone after that. Only
  the manager may request it, and the manager or a signer may cancel it. A
  lock voids it by epoch, as allowlist additions are voided
  (`ProtectedAccountFacet.sol:433-472`).
- **Effective floor** = max(minimum × quantity sold, what the lender and
  treasury are owed now). The quantity sold is the order's ERC-1155 quantity
  (today the whole `collateralQuantity`, `LibPrepayOrder._componentsAtMemory`),
  and 1 for an ERC-721. Every check in §5.2 (fixed, Dutch end price, parallel
  sale, atomic match) compares the order's **total** ask or net against this
  total floor, never a per-unit minimum against a total. When no minimum is set, it is the owed amount alone (the live floor,
  `NFTPrepayListingFacet.sol:1248-1262`).
- **Collection floor:** advisory only. The app may offer it as the starting
  value and warns "x% under the collection floor". Nothing on-chain reads it.
- **Events:** `NftMinimumSet`, `NftMinimumLowerRequested(…, at)`,
  `NftMinimumLowerCancelled`, `NftMinimumLowerFinalized`.
- **View:** `getNftMinimum(account, collection, tokenId)` returns the record,
  the effective floor now, and the asset the floor is measured in.

The listing's consideration is in the loan's principal asset
(`LibPrepayOrder.sol:404-414`). A minimum recorded in another asset cannot be
compared. Such a listing counts as **below the minimum**, and the app says
why.

### 5.2 Trigger and checks

| Route | Commit check | Below the minimum |
| --- | --- | --- |
| Fixed listing: `postPrepayListing` / `updatePrepayListing` (`NFTPrepayListingFacet.sol:447,684`) | ask price vs effective floor | guard record on the order hash |
| Dutch listing: `postPrepayDutchListing` / update (`NFTPrepayDutchListingFacet.sol:172,260`) | **end** ask vs the minimum, and run length vs the protected minimum run (proposal: 24 h; the current minimum is 1 h, `PrepayTypes.sol:80`) | guard record. A Dutch listing never descends below the minimum without the delay |
| Parallel sale before the loan: `postParallelSaleListing` (`OfferParallelSaleFacet.sol:215`) | ask vs the minimum. Nothing is owed yet | below the minimum, or no minimum set: guard record (Q7) |
| Atomic match of a bid: `matchOpenSeaOffer` (`NFTPrepayListingAtomicFacet.sol:240`) | bid net vs effective floor | queued match row holding the bidder order hash. Execution supplies the order again and requires the same hash |

**Fill-time enforcement has two independent layers.**

1. **The order's own start time.** A queued listing is recorded on the
   executor with `startTime = liveAt` (`OrderContext.startTime`,
   `CollateralListingExecutor.sol:191-203`). The marketplace itself refuses a
   fill before the start time. The Dutch curve starts at `liveAt`, so the
   descent the owner reviewed is the one that runs.
2. **The executor asks the Diamond.** Both `isOrderValid` (the ERC-1271 path,
   `:1186`) and the zone precondition stacks ask the Diamond through
   `isListingCommitmentLive(orderHash)`. The precondition stacks are
   `authorizeOrder` and `validateOrder`, at `:1272-1300`. The zone check sits
   next to `_assertProtectionAllows` (`:1876`).
   - Pre-validated orders skip the signature check, but they still run the
     zone hook (`:1262-1270`). So a queued or voided listing is unfillable
     either way.
   - A lock voids the record by epoch. After that, the listing reads as
     unsigned and its zone check reverts. That holds even though the order
     sits on an external book.

`assertListingAuthorized` (`LibPrepayListingWiring.sol:174`) is the shared
commit hook for the guard call.

**Grace.** A Dutch window must end before grace ends
(`NFTPrepayDutchListingFacet.sol:387-397`). If `liveAt` plus the minimum run
would cross grace, the post still queues the listing. The app states that it
cannot run before default, and offers the owner either an at-or-above-minimum
price or a lock.

**App copy.**

- "Listed below your minimum ({min}). Protected mode holds it until {date
  time}. Lock your account to cancel it."
- Lowering the minimum: "Lowering your minimum takes {delay}. Raising it is
  instant."
- With no minimum set: "No minimum set. The floor is what your lender and
  the treasury are owed ({owed}), so anything above that is yours to lose."
- "{x}% below the collection floor of {f} (advisory, not checked on-chain)."

## 6. Residual risks (stated, not solved)

- **The reference-rate publisher is a new trust input.** A stale or missing
  reference turns guard A off, and the app says so. A captured publisher
  could shift what counts as in-band, but only by the movement cap per
  anchor period (at most twice the cap in any 24 hours), however many updates
  it sends. A commitment that a shift brought in-band still needed that shift
  to be published first, in the open.
- **The band is wide by design.** At a 12% market, 7–17% is in-band
  (`RateModelFacet.sol:92-94`). A thief can still make in-band commitments
  with liquid collateral at once. The loss is bounded by the band width times
  the term.
- **Reference drift after commit** does not re-queue a live offer.
- **5% per sale.** A thief may sell each lender position at 95% of par at
  once.
- **Forced paths are not guarded.**
  - `autoListAtFloorOnGrace` (`NFTPrepayAutoListFacet.sol:127`) and default
    are not owner commitments, so a thief who lets a loan reach grace gets a
    floor listing. The borrower's opt-out stays available.
  - The forced-sale price check is a separate item (Q8).
- **Griefing.** A thief with the key can raise a minimum, cancel honest
  offers or fill the commitment queue. None of these moves value. Locking
  voids a pending lowering. A delay near grace can cost the owner the chance
  to sell below the minimum.
- **Execution races.** A queued action can fail at execution because the
  counterparty withdrew, terms changed or a deadline passed. The failure is
  atomic and only costs gas.
- **ERC-1155 collateral** whose recipient is not the fulfiller is outside the
  zone's sight (`CollateralListingExecutor.sol:1890-1905`). This change does
  not alter that.

## 7. Tests

Unit tests for `LibProtectedCommitment`:

- the band, both directions, on the range ends;
- the rule not applying with no model, no reference or a stale reference;
- a lender's listed sale whose buyer asks an above-band APR is not held by
  guard A, and guard B alone decides it, as for the direct sale;
- matches: a queued, a cancelled and an epoch-voided lender offer each fail
  to match an otherwise fillable borrower offer, including at an in-band
  midpoint; the same for a queued borrower offer against a live lender offer;
- reference movement: many updates from the publisher in one block, and
  across a day, cannot move the reference beyond the cap from its anchor;
  an update within an hour of the last is refused; the anchor rolls only after
  24 hours;
- 95% par at 94.99%, 95% and 95.01%;
- effective floor = max(minimum × quantity sold, owed), including an
  ERC-1155 order of ten units whose total ask passes a per-unit minimum but
  not ten times it (held);
- an asset mismatch counting as below the minimum;
- the epoch void;
- the queue bound.

Scenario tests:

1. **Self-dealing loan, held (acceptance).** Off-band against a protected
   borrower or lender. Held, voided by lock, and live without a lock.
   - (a) A protected borrower's stolen key accepts the thief's lender offer
     at a rate far above the band. A queued accept row results. A fill before
     `liveAt` reverts. A lock voids the row, and execution after unlock still
     reverts.
   - (b) A protected lender's key posts a far-below-band lender offer and the
     thief tries to accept, match or signed-fill it. Every route reverts
     before `liveAt`. Without a lock it fills after `liveAt`.
   - (c) An unarmed off-band signed offer from a protected signer reverts at
     fill. An armed and matured one fills.
   - (d) An off-band protected lender intent: a match before the intent's
     record is live reverts; after it, the materialized slice fills; changing
     the intent's rate restarts the delay.
2. **Floor-priced NFT listing, held (acceptance).**
   - (a) A protected borrower with a minimum lists at the live floor. Before
     `liveAt`: the ERC-1271 view returns invalid, a pre-validated order's fill
     reverts in the zone hook, and a direct fill reverts on the start time. A
     lock leaves it permanently unfillable.
   - (b) A Dutch listing ending below the minimum gets the same treatment.
   - (c) An atomic match below the minimum is queued.
   - (d) Lowering the minimum waits, and a lock voids the pending lowering.
3. **Below-par sale, held.** Listed and direct routes at 94% are queued. At
   96% they execute at once. A direct-sale row fails cleanly when its buy
   offer changes.
4. **Non-protected parity.** The same calls behave byte-for-byte as today.
5. **Mutation.** Mutating an off-band offer resets `liveAt`, and mutating it
   back in-band closes the record.
6. **Deploy-sanity.** Facet size, selector coverage, export parity and the
   indexer event coverage for the new events.

App: a Playwright spec on the CI-Anvil tier shows the guardrail hit and the
live time for each guard, plus the "rule not available" state.
`COVERAGE.md` and `docs/FunctionalSpecs` are updated in the implementing PRs.

## 8. Open questions for the owner

- **Q1. Reference rate.** No on-chain reference exists today; the band is
  centred on the caller's input. Who publishes a per-asset, per-tenor
  reference, under what bounds and with what staleness? An on-chain median of
  cleared loans is rejected here, because self-dealing moves it.
- **Q2. Directional band.** Hold only the side that harms the protected
  account (low for a lender, high for a borrower)? The proposal is yes.
- **Q3. Rentals.** Exclude NFT rental offers from guard A?
- **Q4. Par basis.** The 07:44 decision says par is in the lending asset, with
  the oracle only for display. The 07:45 note says it is "priced by the
  oracle when the principal is blue-chip". This proposal compares in the
  lending asset. It also counts the retained seller claim in the seller's
  value. Confirm both.
- **Q5. Co-sign.** For `requireCosign` accounts, does a queued commitment also
  need a signer's approval?
- **Q6. Fixed values.** Is 95% a fixed constant or a bounded governance
  setting? Is the protected minimum Dutch run 24 h? Is 16 queued commitments
  the right bound?
- **Q7. Parallel sale with no minimum.** Nothing is owed before the loan.
  Should a no-minimum parallel-sale listing by a protected account wait the
  delay, as proposed?
- **Q8. Forced sales.** Is the forced-sale second-source agreement check
  (`ThreatModel.md:98`) a separate note or card?
- **Q9. Atomic match.** Accept a queued match row (the bid may vanish), or
  require the owner to lower the minimum first instead?
