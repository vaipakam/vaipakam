# Fork verification of the live Base Sepolia deployment — 2026-09-24

An advanced-user walkthrough of the deployment that is **live right now**,
driven against a local fork of it rather than a fresh local deploy, so that
what is under test is the deployed bytecode and the deployment's own
configuration — not the source tree's idea of them.

- **Target** — Diamond `0xd89fd7F787e4415460b23891E97570a4881fb995`, chain
  84532 (Base Sepolia), forked at block 47,228,632.
- **Driver** — [`contracts/script/fork-scenarios/`](../../contracts/script/fork-scenarios/README.md),
  committed with this document. `node run-all.mjs` reproduces every row.
- **Result** — 77 scenarios: **72 PASS, 5 INFO, 0 FAIL.** The INFOs are
  observations with no assertion behind them, not soft failures; each is
  written out below.
- **Assets** — the deployment's own faucet mocks: `tLIQ` priced $2,000,
  `tLIQ2` priced $1.00, plus `illiquidToken` (unpriced).

Two things this run did **not** cover, stated up front so the coverage is not
read as wider than it is: the **contracts were not refreshed** and **no ABI
re-export was performed** (neither is possible in the session container —
see "What could not be done here"), and the **full Foundry regression was
deliberately not run**, per the standing per-PR rule that it is a pre-deploy
gate only.

---

## 1. What the walkthrough establishes

### 1.1 Money moves exactly where the specification says

Every scenario snapshots both parties' wallets, both parties' vaults, the
Diamond and the treasury before and after each state change, so a claim like
"the repay worked" is replaced by an exact ledger. On a 1,000 tLIQ2 loan
against 1.25 tLIQ of collateral, at 500 bps over 7 days:

| Step | lender wallet | lender vault | borrower wallet | borrower vault | treasury |
| --- | --- | --- | --- | --- | --- |
| create offer | −1,000 | +1,000 | — | — | — |
| accept | — | −1,000 | +998.02 tLIQ2, −1.25 tLIQ | +1.25 tLIQ | +1.98 |
| repay | — | +1,000.9397 | −1,000.9589 | — | +0.01918 |
| claim (borrower) | — | — | +1.25 tLIQ | −1.25 tLIQ | — |

Read off that ledger:

- **The lender's principal is escrowed in the lender's OWN vault** at offer
  creation, not in the Diamond. It leaves that vault only when the offer is
  accepted.
- **The borrower's collateral never leaves the borrower's own vault.** It is
  *encumbered by a lien*, not transferred. This is the single most
  consequential structural fact in the walkthrough and it is easy to
  mis-describe as an escrow.
- **The loan-initiation fee is 0.2% of the principal, charged in the LENDING
  asset** (not in VPFI — the #1352 posture), and it is **split 99 / 1 between
  the treasury and the matcher**. On this accept the borrower was also the
  matcher (they called `acceptOffer`), which is why they net 998.02 rather
  than 998.00. That 1% kickback is the same one the functional spec documents
  for the keeper-matcher path.
- **The treasury takes 2% of the INTEREST and nothing of the principal.**
  0.019178 on 0.958904 of interest, to the wei.
- **The payoff quote is principal + simple interest over the full term** —
  1,000 × 500 bps × 7/365 = 0.958904109589041095, matched exactly.

### 1.2 Per-loan fee stamps hold

`treasuryFeeBpsAtInit = 200`, `loanInitiationFeeBpsAtInit = 20` and
`minHealthFactorAtInit = 1.5e18` are all written onto the loan record at
initiation. A governance retune therefore cannot re-price an open loan —
which is the whole point of the rev-8 freeze, and it is now observed rather
than assumed.

### 1.3 Repay settles the money; the claim releases the collateral

This is a **two-step close, and the second step is the borrower's**. After a
full repay the loan is already `Repaid`, the lender is already credited and
the treasury already paid — but `getLoanCollateralLien` still reports
`released: false`, and the borrower's vault balance is still fully
encumbered. `claimAsBorrower` is what releases the lien and returns the
tokens.

An interface that treats "Repaid" as "done" would leave the borrower's
collateral locked with no prompt, so a status surface has to distinguish
*repaid* from *repaid and claimed*.

**The connected app already does.** Checked after this run rather than
assumed: `apps/app` carries a Claims page and a `ClaimAllCard`, the
close-early confirmation reads "Your collateral is ready — claim it below or
from the Claim Center", and the push hints for `loan_repaid` /
`loan_defaulted` / `internal_matched` all route to what is claimable. This
paragraph records a real protocol shape a *new* surface has to honour — not
a gap in the shipped one.

The same shape applies on the lender side: a repay credits the lender's
**vault**, and `claimAsLender` sweeps it to their wallet. The sweep creates
no new money — the Diamond's balance is unchanged across it — and a second
claim on either side reverts and moves nothing.

### 1.4 Position NFTs survive terminalization, and are spent by the claim

Two distinct facts that are easy to collapse into one:

- **At terminalization both position NFTs still resolve.** After the loan
  went `Repaid`, `ownerOf` answered for both the lender and the borrower
  token. They are status-updated, not burned — exactly the invariant
  `CLAUDE.md` states for the refinance path.
- **The claim spends the claiming side's receipt.** After
  `claimAsBorrower`, the borrower's token no longer resolves; the lender's
  still does.

So "a terminal loan's NFTs are gone" is wrong, and "a terminal loan's NFTs
always resolve" is also wrong. An indexer needs both halves.

---

## 2. The forced-close routes

### 2.1 Time-based default

Grace behaves as documented and the boundary is observable: a healthy in-term
loan is not defaultable; one day past a 7-day term it is still not
defaultable (inside grace); past term *and* grace it is.

`triggerDefault` is **permissionless** — an unrelated third party closed the
position — and the settlement on 1.25 tLIQ of collateral sold for 2,500
tLIQ2 came out as:

| Recipient | Amount | Basis |
| --- | --- | --- |
| caller (liquidator) | 75.000000 | 300 bps of proceeds, the loan's stamped `fallbackLenderBonusBpsAtInit`, taken off the top |
| lender | 1,054.101373 | debt owed, net of the treasury's cut |
| treasury | 51.104110 | the loan's stamped treasury bps |
| borrower (surplus) | 1,319.794517 | what is left, returned to the borrower |
| **total** | **2,500.000000** | reconciles exactly |

The borrower surplus is the part worth stating on any liquidation surface:
an over-collateralised position that is force-closed does **not** forfeit the
excess.

### 2.2 A forced close that cannot route refuses, rather than mis-settling

`triggerDefault` with an empty swap try-list reverts `NoEnabledSwapRoute`.
It does not fall through to a full-collateral transfer. That is the correct
posture — a permissionless caller must not be able to push a liquid position
into the fallback path by simply declining to name a venue — and it means a
keeper that cannot quote a route must report that, not retry blindly.

### 2.3 Health-factor liquidation, and the gap between 1.5 and 1.0

The two thresholds are distinct and both were exercised:

- At **HF 1.1** — below the 1.5 initiation floor — `triggerLiquidation`
  refuses with `HealthFactorNotLow()`. The 1.5 floor binds at *initiation*
  only; a live position is not liquidatable until HF < 1.0.
- At **HF 0.8**, liquidation succeeds, permissionlessly, and pays the caller
  a 30 tLIQ2 bonus out of 1,000 tLIQ2 of proceeds (3%), with the remaining
  970 credited to the lender. There was no surplus and no treasury cut,
  because the proceeds did not cover the debt — the lender takes the
  shortfall, and the bonus comes off the top regardless.

### 2.4 FINDING — on this deployment a collateral crash closes the HF-swap route

**Observed:** the seeded `tLIQ` / WETH pool sits barely above the on-chain
depth floor at the seeded price. Repricing `tLIQ` downward flips it from
Liquid (tier 3) to Illiquid (tier 0) at a **20% drawdown**:

| tLIQ price | `checkLiquidity` | tier |
| --- | --- | --- |
| $2,000 (seeded) | Liquid | 3 |
| $1,600 | Illiquid | 0 |
| $1,400 … $900 | Illiquid | 0 |

Because `triggerLiquidation` re-checks liquidity **live** (it will not swap
an asset it can no longer route) it then refuses with `NonLiquidAsset()` —
even though HF is below 1 and the loan is otherwise liquidatable.

Any collateral drawdown large enough to make a position unhealthy on this
deployment is therefore also large enough to close the route that would
resolve it, leaving only the slower time-based default. The HF-liquidation
payout above had to be driven from the **debt** side (repricing `tLIQ2`
upward) to keep the collateral routable.

**Classification:** this is a property of the *testnet mock pool seeding*,
not a contract defect — the refusal is correct behaviour, and refusing is
strictly better than swapping into a pool that cannot absorb the trade. But
it does mean **HF liquidation is effectively untestable on Base Sepolia
through a collateral price move**, which matters for any rehearsal that
claims to have exercised it. The remedy is operational: seed the mock pool
with materially more depth, so the asset stays above the floor across a
realistic drawdown.

---

## 3. Early exits

### 3.1 FINDING — precloseDirect under a full-term-interest offer saves nothing

`precloseDirect` on **day 1 of a 7-day term** charged
1,000.958904109589041095 — byte-identical to the full-term payoff quote. The
offer carried `useFullTermInterest: true`, so this is the flag behaving as
named, not a bug.

It is still a transparency obligation. A borrower reading "close early" will
reasonably expect a pro-rated interest saving, and on a full-term-interest
offer there is none. Any preclose quote surface must state that the full
term's interest is due, and must distinguish a full-term offer from one that
accrues pro rata, before the borrower signs.

**The connected app already does, and does it more carefully than a
straight disclosure would.** Checked after this run rather than assumed:
`EarlyRepayOptionsCard` reads the loan's interest mode live and is
deliberately **tri-state** — `closeEarlyCostFullTerm` ("Costs the full agreed
term's interest even though you're closing early"),
`closeEarlyCostProRata`, and a neutral `closeEarlyCostChecking` while the
mode is unknown. It never falls back to the full-term default, because doing
so would misprice a *pro-rata* loan's close. That tri-state was itself the
product of a review round (Codex #1500 r2/r3).

Recorded here because the underlying protocol behaviour is easy to
misremember, and because any NEW surface that quotes an early payoff has to
reproduce all three states — not because the shipped surface is missing it.

### 3.2 Partial repayment

With `allowsPartialRepay` set on the offer, the flag carries onto the loan, a
400-of-1,000 payment reduces the recorded principal to 600 and leaves the
loan `Active`, the payoff quote re-quotes at 600.575342, and the final
`repayLoan` terminalizes to `Repaid`.

One asymmetry worth noting for interface work: the **partial** payment went
straight to the lender's **wallet**, while a **full** repay credits the
lender's **vault**. Both are correct; a balance display that assumes one
shape will be wrong about the other.

### 3.3 Lender exit by listing

`createLoanSaleOffer` accepts a listing from the lender, **refuses a zero
listing window** (`SaleListingWindowInvalid`) — so there are no perpetual
sale listings — and refuses a third party attempting to list someone else's
position (`KeeperAccessRequired`).

---

## 3A. Two things that move funds on an OPEN position

### 3A.1 Releasing surplus collateral — the boundary is the 1.5 floor

On a loan opened at HF 4 (2.5 tLIQ against 1,000 tLIQ2), the protocol quotes
**1.5625 tLIQ** as releasable, and releasing exactly that lands the position
at **HF 1.5000** — the same floor that binds at initiation. So the surplus is
defined as *everything down to the initiation floor*, not some softer margin.

- One wei past the quote is refused with `HealthFactorTooLow()`. It is not
  clamped to the maximum, which matters: a caller who miscalculates gets an
  error rather than a silently different outcome.
- A second quote afterwards reports **0**.
- A third party attempting the release is refused with `NotNFTOwner()` —
  worth noting because it names the authorisation model: the borrower
  **position NFT** is what authorises, not the borrower address recorded on
  the loan. A transferred position carries the right with it.

### 3A.2 Refinance is a consent-gated, single-purpose path

The CLAUDE.md invariant is confirmed exactly: a completed refinance leaves
**two loan records and four distinct position NFTs, all four still
resolving**. The original loan terminalizes to `Repaid`, the replacement is a
separate record with the new rate and the new lender, and the old borrower
token still answers `ownerOf` as a redeemable receipt on the original
position. An indexer assuming one NFT per loan, or that a terminal loan's
NFTs are gone, is wrong on both counts.

What was not obvious until it was driven is **how much has to be true before
a refinance-tagged offer can even be created**. It must be a Borrower offer,
all-or-nothing fill, on the same lending / collateral / prepay assets, with
`amount <= oldPrincipal <= amountMax` — and, the interesting one:

> **The borrower must have consented in advance**, by enabling
> auto-refinance caps on the loan. Without them, creating the offer is
> refused with `RefinanceCapsRequired()`. With them, an offer above the
> consented rate is refused with `RefinanceRateExceedsCap()`.

So the terms a third party may move a borrower onto are bounded by something
the borrower set first, not by the offer alone. Enabling the caps with no
expiry is itself refused (`InvalidCaps()`), so the consent always carries a
deadline — even though the downstream checker reads a zero expiry as "no
cap". The setter is deliberately the stricter of the two.

## 4. The three gates

### 4.1 Sanctions — the Tier-1 / Tier-2 split works exactly as documented

With a stub oracle armed so that every address reads as flagged:

| Path | Tier | Result |
| --- | --- | --- |
| `createOffer` | 1 | `SanctionedAddress(address)` |
| `getOrCreateUserVault` | 1 | `SanctionedAddress(address)` |
| `repayLoan` | 2 | **open** — simulates clean |
| default readback | 2 | **open** |

Position-creating and fund-receiving paths refuse; close-out paths stay open
so the unflagged counterparty can be made whole. Disarming restores
permissionless access immediately.

The live deployment currently has **no oracle set** (`address(0)`), which is
the documented fail-open deploy window. `ProfileFacet.setSanctionsOracle`
remains an outstanding retail post-deploy step.

### 4.2 FINDING — KYC enforcement binds at ACCEPT, not at offer creation

The knob is dormant on retail, as required: `isKYCVerified` and
`meetsKYCRequirement` short-circuit to `true`. Flipping
`setKYCEnforcement(true)` makes both report `false` for an unverified wallet,
and flipping it back restores the retail posture — the knob is clean in both
directions.

But with enforcement **armed**, a $50,000 `createOffer` was still **allowed**;
it was the **accept** that refused, with `KYCRequired()`.

This is not wrong — the offer creates no position — but it is a real
interface consequence for the industrial fork: a maker can post an offer they
are not permitted to have filled, and the refusal lands on the *taker's*
transaction. An industrial-fork interface needs to surface the maker-side
requirement at creation time rather than letting the offer sit un-fillable.
Recorded here rather than acted on, because retail never arms this knob.

### 4.3 Illiquid collateral — dual consent, and an honest refusal

`illiquidToken` reads back with no usable price (`tryGetAssetPrice` →
`false`) and `checkLiquidity` → Illiquid. Against it:

- an offer **is** creatable;
- accepting **without** the explicit acknowledgement is refused with
  `IlliquidAssetNotAcknowledged(address)`;
- accepting **with** `acknowledgedIlliquidCollateralAsset` set succeeds — the
  explicit per-asset consent is the gate;
- and the resulting loan answers `calculateHealthFactor` with
  **`IlliquidLoanNoRiskMath()`** rather than a number.

That last one is the behaviour to protect. The protocol refuses to state a
health factor it cannot substantiate, instead of deriving one from a $0
valuation. Any surface rendering HF must carry the "not applicable — this
position has no priceable collateral" case, and must never coerce the
refusal into `0` or `∞`.

---

## 5. FINDING — the committed deployment artifact does not describe the live Diamond

Independent of the scenarios, and the most actionable item in this document.

`contracts/deployments/base-sepolia/addresses.json` is **internally
inconsistent** and **behind the chain**:

| Source | Count |
| --- | --- |
| `facetCount` field in the artifact | 84 |
| `.facets` keys actually present in the artifact | 78 |
| addresses routed live per `facetAddresses()` | 84 |
| live addresses recorded under **no** `.facets` key | **7** |

(77 of the 78 keys map to a live routed address; the 78th is
`diamondCutFacet`, which the constructor installs outside the `facetAddresses()`
enumeration and so is correctly absent from it.)

The seven unrecorded implementations, by address and routed selector count:

```
0x3480d4cf57a54a387e6d97c694ede7526f68b5cd   2 selectors
0x5e0b36b7c9c766d1d1aef32e007262c1cb9fe69b   1
0xc3a16f0465660a8ddaf7a7b898971161e99e78ca   2
0x64fd15903602ab91d55d205e6f751d8d1155d6d9   3
0x8f81848718c090a0b04c83ba952434fa95c61bdd   1
0x953381520af2482c8d339021b66d3f2f69b3245f   1
0xe1616a1c9e893d1c06be36ddeaaed4d1dc128c28   1
```

Separately, `contracts/deployments/base-sepolia/deployment_source.json` names
a **different diamond entirely** (`0x725C7912956b254030A2DBF152B2F739C46C07c0`)
and a `deployedAt` of 2026-05-11. It is stale.

**This is the `writeFacet`-omission class that #1793 catalogued and #1800
closed.** The guard #1800 added — `DeployDiamond` Step 7b, which reads the
artifact back and requires every address `facetAddresses()` reports to appear
under some `.facets` key — would **fail** on an artifact in this state. The
live deployment predates that guard, which is exactly why it is in this
state.

**No address is lost.** Every implementation stays recoverable on-chain via
`DiamondLoupeFacet.facetAddress(bytes4)` / `facetAddresses()`, and from the
broadcast logs. The cost is inventory accuracy, not funds.

**Remedy:** the refresh-and-re-export that this session could not perform
(§6) is the fix — a `DeployDiamond` or `RefreshAllFacetsInPlace` run today
writes all the keys and the Step 7b readback then holds the artifact honest
from here on.

---

## 6. What could not be done here, and why

The request had two halves. The verification half is above. The other half —
**refresh the contracts on Base Sepolia and re-export the ABIs** — cannot be
done from this session container, and is reported rather than approximated:

| Blocker | Detail |
| --- | --- |
| No Foundry | `forge` is not installed, and `foundryup` is refused by the environment's egress policy (403 on both the GitHub attestations and releases hosts). Without `forge`, neither a deploy nor `forge inspect` — which is the only thing that generates the ABI JSONs — can run. |
| No deployer key | The Base Sepolia admin/deployer key is not present in this environment, by design. |
| No funded RPC | No write-capable Base Sepolia endpoint with a funded account. |
| Insufficient memory | The `default` Foundry profile needs ≈17.7 GB RSS on this codebase; this container has 15 GB. Even with `forge` present, the build the export needs would not complete. |

Nothing was therefore merged to `main` on that half: an ABI re-export that
has not actually run `forge inspect` would be a fabricated artifact, and a
"refreshed" deployment record with no deploy behind it would be worse than
the stale one it replaced.

**The refresh remains the right next action** — §5 is the direct consequence
of not having done it — and it needs an operator-side run with `forge`, the
deployer key and a funded RPC, followed by
`contracts/script/exportFrontendAbis.sh` and
`contracts/script/exportFrontendDeployments.sh`.

---

## 7. Ledger

The full 63-row ledger, with per-scenario verdicts and observed numbers, is
regenerated as `contracts/script/fork-scenarios/last-run.json` on every run
(untracked). Scenario ids map to the driver's files:

| Ids | File | Covers |
| --- | --- | --- |
| A1.* | `01-config-and-vault.mjs` | deployment config, per-user vault, Diamond-internal gating |
| A2.* | `02-lifecycle-fees.mjs` | offer → accept → fees → repay → claim, position NFTs |
| A3.* | `03-forced-close.mjs` | time-based default, HF liquidation, depth-floor finding |
| A4.* | `04-early-exit.mjs` | preclose, partial repay, lender sale listing |
| A5.* | `05-gates.mjs` | sanctions, KYC, illiquid dual consent |
| A6.* | `06-collateral-and-refinance.mjs` | surplus-collateral release, refinance consent + the four-NFT invariant |

The `INFO` rows are: the live facet count (A1.6, an observation feeding §5),
the depth-floor flip (A3.10, written up as a finding in §2.4), and the two
post-claim NFT readbacks (A2.16, written up in §1.4). A3.2 records this
deployment's effective grace window (3 days) rather than asserting it, since
the window is per-deployment config — what the suite asserts there is the
ORDERING A3.1 → A3.3, not that any particular day lands inside grace.

---

## 8. Follow-ups this run raises

1. **Refresh Base Sepolia and re-export the ABIs + deployments** (operator —
   §6), which also repairs the artifact drift in §5 and the stale
   `deployment_source.json` — tracked as **#2313**.
2. **Re-seed the mock `tLIQ` pool with more depth** so HF liquidation is
   exercisable on the testnet through a collateral price move (§2.4) —
   tracked as **#2314**.

Two items were on this list in the first revision of this document and have
been **withdrawn**, because scouting `apps/app` afterwards found both already
shipped — stating full-term interest in the preclose quote (§3.1, done
tri-state via `EarlyRepayOptionsCard` + the three `closeEarlyCost*` strings)
and distinguishing *repaid* from *repaid and claimed* (§1.3, done via the
Claims page, `ClaimAllCard` and the close-early confirmation copy). They are
recorded as withdrawn rather than deleted: a verification record that quietly
drops a claim it made is harder to trust than one that says it was wrong.
Both observations remain in their sections as protocol shapes a *new* surface
must honour.
