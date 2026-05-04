# Treasury Management and Founder Distribution — Design Document

**Status:** Design proposal pending review.
**Audience:** Founders, legal counsel, governance designers, and the
contracts engineer who will eventually implement T-056.
**Companion docs:**
- [`docs/ToDo.md`](../ToDo.md) — T-056 implementation entry.
- [`docs/ops/GovernanceRunbook.md`](../ops/GovernanceRunbook.md) —
  operational summary (Treasury and founder distribution policy section).
- [`docs/internal/Tokenomics.md`](../internal/Tokenomics.md) — VPFI
  genesis allocation breakdown (when it lands).

---

## 1. Executive summary

This document captures the proposed design for two coupled questions:

1. **How does the protocol convert accumulated operating fees into a
   stable target asset mix?**
2. **How do founders capture protocol value?**

The original sketch (T-056 first draft) was: convert treasury tokens
to ETH / WBTC / VPFI in admin-configurable ratios, and on every
conversion send a hardcoded founder's-cut percentage to a
`.env`-configured address.

After surveying 15 major DeFi protocols and reviewing four classes of
risk (securities, tax, operational, sanctions), this document
**recommends dropping the per-tx auto-route to a founder address**
entirely. The chosen design instead:

- Keeps the Diamond as the treasury.
- Accumulates fees in their original tokens via the existing
  `treasuryBalances[asset]` ledger.
- Converts to ETH / WBTC / VPFI in aggregated batches, triggered
  when EITHER an accumulated USD-value threshold OR a maximum-time-
  since-last-conversion threshold is crossed.
- Captures founder value via a **genesis VPFI allocation** vested
  over 4 years through a separate vester contract — decoupled from
  operating revenue mechanics.
- Funds founding-team operating expenses via **discretionary,
  governance-approved** budget grants from the converted treasury.

This shape is what the entire established DeFi industry converged on,
and it carries dramatically lower legal / operational risk than the
original sketch.

The design has open questions — most notably the exact ratio in the
target asset mix, the conversion thresholds, and the founder
allocation percentage. Those need decisions before implementation.

---

## 2. The original sketch and why we're not adopting it

### 2.1 The sketch

> Treasury holds collected fees in various tokens. On each fee
> accrual or each conversion, route a configurable percentage to
> the founder's address (set in `.env`). Conversion happens
> per-transaction. Make the Diamond the treasury.

### 2.2 The four classes of risk

#### A. Securities exposure

The SEC's Howey test for whether something is an investment contract
asks four things, the most relevant of which is "expectation of
profits derived from the efforts of others." Hardcoded auto-routing
of protocol-fee revenue to a single insider address strengthens that
prong because it ties user activity directly to founder compensation
in a deterministic, automated way.

Multiple 2023-2024 SEC actions (Coinbase staking-as-a-service,
Kraken staking program, BlockFi yield product) cited automated
revenue distribution from user activity to operators / pool managers
as a key factor in the "investment contract" analysis. The pattern
that survives regulatory scrutiny is **discretionary distribution by
governance**, not **automated payment to insiders**.

A contract that auto-routes a percentage of user-paid fees to a
hardcoded founder address looks structurally identical to the
revenue-share programs that have been litigated against, regardless
of how the founders earned their position.

#### B. Tax fragility

Every fee accrual = a separate realization event for the founder.
For a protocol with thousands of loans / month, that's potentially
thousands of taxable receipts per year. In multiple tokens. With
conversion math that has to be recomputed at each event for cost
basis tracking.

US tax treatment in particular is hostile to this pattern:
- Each receipt is a separate realization event.
- Cost basis is the fair-market-value at receipt.
- Disposing later (selling to USD) creates a second taxable event
  with potential capital gains.
- Reporting becomes a manual reconstruction exercise across many
  tokens and many events.

By contrast, **aggregated periodic distributions** create one
realization event per cycle, with a clean cost basis at distribution
time. Founders can plan tax timing.

#### C. Operational fragility — the SushiSwap "Chef Nomi" case study

This is the textbook cautionary tale and the closest direct precedent
for what the original T-056 sketch proposes.

**Background**: SushiSwap launched in August 2020 as a fork of
Uniswap V2. Its initial design included a `developerFund` that
**automatically received 10% of all SUSHI emissions** at every
inflation event. The fund's recipient address was hardcoded.

**The incident**: On September 5, 2020 — three weeks after launch —
the pseudonymous founder "Chef Nomi" withdrew the entire
developerFund balance (~13.7 million SUSHI worth ~$14 million at
the time) to a personal address, sold ~38,000 ETH worth of SUSHI on
the open market, crashing the price.

**The fallout**:
- Community uproar.
- SUSHI price dropped ~70% in 24h.
- Trust in the project nearly killed.
- FTX's Sam Bankman-Fried (then a SUSHI holder) coordinated a
  governance handover from Chef Nomi to a 9-of-12 multisig.
- Six days later, Chef Nomi tweeted an apology and returned the
  $14 million.
- The protocol redesigned the dev fund to multisig / DAO control.

**The lesson protocols took**: Even with full transparency,
hardcoded auto-routes to a single insider address create
operational fragility that's not worth the marginal benefit. The
pattern itself — not the specific actor — is what fails.

Vaipakam's proposed `.env`-configured founder address is
structurally identical to SushiSwap's `developerFund`. Same risk
profile.

#### D. Sanctions surface

A hardcoded founder address creates a permanent target. There are
two failure modes:

1. **Erroneous sanctions flagging**: the August 2022 Tornado Cash
   sanctions designation triggered Chainalysis to flag hundreds of
   wallets that had received as little as 0.1 ETH from the mixer in
   unsolicited dust attacks. If a founder address gets flagged
   (correctly or otherwise), the protocol's revenue auto-route
   becomes a sanctions-violation channel. Recovery requires an
   on-chain code change.

2. **Compromise**: a single hardcoded address means a single
   compromise point. With an N-of-M multisig, compromise of one
   signer doesn't drain the address.

A multisig (Safe) destination, controlled by founders + advisors
+ optionally a delay timer, eliminates both failure modes.

### 2.3 Centralization optics

Independent of the legal questions, the optics of "auto-route a
percentage of every user fee to a founder's address hardcoded in
environment variables" are bad. Even if the math is generous to
users and the founders are good actors, the design choice
broadcasts:

- "Our protocol has a permanent insider beneficiary."
- "User fees flow to a fixed insider address by default."
- "There's no ongoing governance check on the insider's revenue
  capture."

This is exactly the criticism that gets levied against DeFi
projects with concentrated ownership patterns. Clean genesis
vesting + governance-approved discretionary payments avoid the
optics entirely.

---

## 3. Industry survey — what 15 major DeFi protocols actually do

### 3.1 Allocation and vesting at genesis

Every major protocol surveyed treats founders identically: **upfront
genesis allocation, vested over 3-5 years, decoupled from operating
revenue**.

| Protocol | Founder/team allocation | Vesting | Per-tx auto-route to founders? |
|---|---|---|---|
| Uniswap (UNI) | 21.5% team + 17.8% investors | 4 years | No |
| Aave (AAVE) | Team allocation upfront | 4 years | No |
| MakerDAO (MKR) | Genesis MKR to founders | Multi-year | No (Foundation dissolved 2021) |
| Curve (CRV) | 30% shareholders + 3% employees + 2% early users | 2-5 years | No |
| Compound (COMP) | 24% founders + 22.25% investors | 4 years | No |
| Synthetix (SNX) | Team / advisors at genesis | Vested | No (SCCP-approved budget) |
| Yearn (YFI) | 0% founder originally; later 6,666 YFI for treasury+team via gov vote | n/a / multi-year | No |
| dYdX | Employees + investors + community | Multi-year | No (v4 fees → validators / stakers) |
| 1inch | 18% team + 21% investors | 4 years | No |
| Lido | Team + investors at genesis | Multi-year | No |
| Balancer (BAL) | Founders + devs + investors + advisors | Multi-year | No |
| Convex (CVX) | 3.3% team + 9.7% investors | 1-3 years | No |
| GMX | 30% founders & team | Vested | No (fees → GMX stakers + GLP LPs) |
| Pendle | 16% team + 7% advisors | Vested | No |
| Frax | Founders at genesis | Vested | No |

**Zero out of fifteen** auto-route operating fees to a hardcoded
founder address. The pattern is universal.

### 3.2 What protocols DO auto-route

Several protocols DO have per-tx auto-distribution mechanisms — but
the legally-acceptable shape always distributes to **token holders**
(which mathematically includes founders, proportional to their
genesis allocation), not to a specific insider class.

| Protocol | Per-tx auto-route | Recipient |
|---|---|---|
| Curve | 50% of swap fees | veCRV stakers (anyone with locked CRV) |
| GMX | 30% of trading fees | GMX stakers; remaining 70% to GLP LPs |
| SushiSwap xSUSHI | 0.05% of every swap | xSUSHI stakers |
| Lido | 10% of staking yield | 5% to node operators + 5% to DAO treasury |
| MakerDAO | Surplus DAI | MKR burn (deflationary, all holders benefit) |

The legal distinction is meaningful:

- **Auto-route to all token holders** = "protocol mechanics
  benefiting all participants proportional to their stake." This
  resembles a coupon-paying instrument with mathematical
  determinism — a structure the legal system has well-developed
  treatment for (via securities law for some, but with clear
  disclosure paths).

- **Auto-route to a hardcoded insider address** = "ongoing
  payment from user activity to a specific person." This
  resembles an unregistered ongoing securities offering; the
  legal system has taken aggressive enforcement positions
  against this shape.

### 3.3 Discretionary governance budgets — the operating-expense pattern

Once a protocol launches and the founding team needs ongoing
compensation for development / operations, the established pattern
is **discretionary governance grants**, not auto-routing.

Examples:

- **Aave Companies** (the dev team formerly called Aave Labs):
  receives a per-quarter operating budget approved by AAVE
  governance. Each budget is a forum proposal with deliverables
  and scope.
- **Yearn yTeam** + strategist payouts: per-strategy and per-team
  payouts approved by YFI governance. 5% management fee + 2%
  performance fee → treasury → discretionary distribution.
- **BGD Labs** (Aave-aligned engineering firm): funded via
  multi-month engagement proposals voted on by AAVE governance.
- **Synthetix Foundation** (now dissolved, succeeded by
  spartanCouncil + grants council): operating budget historically
  approved via SCCP (Synthetix Configuration Change Proposal).
- **Maker Foundation** (dissolved 2021): replaced by core unit
  budgets approved per-quarter by MKR governance.

The defining feature is **discretion**. Governance retains the
ability to:
- Approve a budget for a period and not for the next.
- Set performance milestones that gate further funding.
- Cancel funding if the team underperforms.
- Negotiate scope and amount.

This is structurally different from automated revenue routing.

---

## 4. Vaipakam's chosen design

### 4.1 Treasury accumulation

- **Diamond is the treasury** (`s.treasury == address(this)`).
  Already supported via the configurable `treasury` storage slot.
- **Per-token fee accrual** via the existing
  `LibFacet.recordTreasuryAccrual` path. Already implemented;
  fees from LIF, yield share, liquidation handling, late fees,
  etc. all flow to `treasuryBalances[asset]`.
- **The T-051 chokepoint counter** separates protocol-tracked
  accruals (in `treasuryBalances` and per-user
  `protocolTrackedEscrowBalance`) from raw `balanceOf(diamond)`
  which can include unsolicited dust from direct transfers. The
  conversion math reads `treasuryBalances[token]` (clean), not
  raw balance (potentially polluted).

### 4.2 Aggregated conversion

A new admin-callable function on a TreasuryFacet (or extending
EscrowFactoryFacet, depending on size):

```solidity
function convertTreasuryToTargetMix(
    address[] calldata tokensIn,
    bytes[]   calldata aggregatorCallData,
    uint256[] calldata minOutEth,
    uint256[] calldata minOutWbtc,
    uint256[] calldata minOutVpfi
) external onlyRole(ADMIN_ROLE);
```

- **Routes through 1inch / 0x aggregators** — reuses the existing
  liquidation swap router infrastructure (`LibSwap` and
  per-aggregator adapter facets that landed in Phase 7a).
- **Slippage-bounded** via per-token `minOut` arguments.
- **Output split** into ETH / WBTC / VPFI per a stored ratio
  (`s.treasuryTargetMixBps[]`, three values summing to 10000 BPS).
- **Eligibility gate**: callable only when EITHER condition holds:
  - Accumulated USD-equivalent of any input token >
    `s.treasuryConvertUsdThreshold` (e.g. $10,000 default, knob).
  - Time since last conversion >
    `s.treasuryConvertMaxIntervalDays` (e.g. 30 days default,
    knob).
  Whichever fires first. Prevents both griefing (running the
  function for tiny dust amounts) and stagnation (treasury sits
  inactive for too long).
- **Phase progression**:
  - Phase 1 (initial launch): admin role triggers manually.
  - Phase 2 (post-handover): timelock-gated, 48h delay.
  - Phase 3 (mature governance): governance-proposal-triggered,
    optionally with a public-callable variant after delay so
    anyone can execute the approved conversion.

### 4.3 Founder value capture — genesis vesting

- **VPFI allocation** determined at TGE per the tokenomics
  document. Recommended starting point (subject to revision):
  - Founders / core team: 12-15% of total supply.
  - Vested linearly over 4 years with a 1-year cliff.
- **Vester contract**: deploy a Sablier V2 / Hedgey Finance /
  custom linear-vester per founder address. The vester pulls VPFI
  from the protocol token reserve at TGE, holds it, and releases
  to the founder address linearly over the schedule.
- **One-time funding**: the vester gets funded ONCE at TGE.
  Decoupled from operating revenue mechanics. Founders capture
  protocol success the same way every other VPFI holder does —
  through the value of their token holdings.

### 4.4 Operating budget — governance-discretionary grants

For ongoing development / operations / business work post-launch:

- **Per-quarter or per-milestone proposals** to Vaipakam
  governance.
- Each proposal lists scope, deliverables, requested budget (in
  ETH / WBTC / VPFI), and the destination multisig.
- Governance votes; if approved, the timelock executes the
  treasury transfer to the team's operating multisig.
- Modeled directly on Aave Companies / Yearn yTeam / BGD Labs.

This is the **only** ongoing compensation route coupled to
operating revenue. It's discretionary, transparent, and
controllable.

### 4.5 Token-holder distribution

For each conversion cycle, governance decides how to split the
output ETH / WBTC / VPFI between four destinations:

1. **Operating budget** for the team (per 4.4).
2. **VPFI buyback-and-burn**: buy VPFI from the open market with a
   portion of converted ETH/WBTC, burn it. Deflationary; benefits
   all VPFI holders proportionally, including founders via their
   genesis allocation.
3. **Staker-reward boost**: top up the existing 5% APR staking
   pool. Increases yield to active stakers.
4. **Treasury runway / strategic reserves**: hold ETH / WBTC for
   future operations, integrations, marketing budget, etc.

Governance has full discretion over the split per cycle. This is
the lever that balances ongoing team compensation against
VPFI-holder returns.

### 4.6 Admin knobs to add (Phase 1 implementation)

| Storage slot | Type | Purpose | Setter |
|---|---|---|---|
| `s.treasuryTargetMixBps[]` | `uint16[3]` | ETH / WBTC / VPFI ratios in BPS, summing to 10000. | `setTreasuryTargetMixBps(uint16[3])`, ADMIN_ROLE. |
| `s.treasuryConvertUsdThreshold` | `uint256` | Per-token USD-equivalent threshold for triggering conversion. | `setTreasuryConvertUsdThreshold(uint256)`, ADMIN_ROLE. |
| `s.treasuryConvertMaxIntervalDays` | `uint256` | Max days between conversions, regardless of balance. | `setTreasuryConvertMaxIntervalDays(uint256)`, ADMIN_ROLE. |
| `s.treasuryLastConversionAt` | `uint64` | Timestamp of the last successful conversion. Maintained by the convert function. | (internal) |

All exposed in the `getProtocolConfigBundle` view so the frontend
can surface them.

### 4.7 What the convert function looks like end-to-end

Pseudocode:

```
function convertTreasuryToTargetMix(
    address[] tokensIn,
    bytes[] aggregatorCallData,
    uint256[] minOutEth,
    uint256[] minOutWbtc,
    uint256[] minOutVpfi
) external onlyAdmin {
    // 1. Eligibility gate
    require(eligibleForConversion(), "not eligible yet");

    // 2. For each input token, swap against three target tokens
    //    via the liquidation aggregator router.
    for each token in tokensIn {
        uint256 balance = treasuryBalances[token];
        require(balance > 0, "nothing to convert");

        // Split per target mix:
        uint256 toEth   = balance * targetMixBps[0] / 10000;
        uint256 toWbtc  = balance * targetMixBps[1] / 10000;
        uint256 toVpfi  = balance - toEth - toWbtc;  // remainder

        // Three swaps via aggregator:
        swapVia0xOr1inch(token, ETH,   toEth,   minOutEth);
        swapVia0xOr1inch(token, WBTC,  toWbtc,  minOutWbtc);
        swapVia0xOr1inch(token, VPFI,  toVpfi,  minOutVpfi);

        treasuryBalances[token] = 0;
    }

    // 3. Update last-conversion timestamp.
    s.treasuryLastConversionAt = uint64(block.timestamp);

    emit TreasuryConverted(...);
}
```

The output ETH / WBTC / VPFI sits in the Diamond. Subsequent
governance votes / scheduled timelock calls move it to the
operating multisig / buyback contract / staker pool.

---

## 5. Implementation phases

### Phase 0 — Pre-launch (current state)

- Treasury accrues per-token via existing `recordTreasuryAccrual`.
- No conversion mechanism.
- No founder distribution mechanism.

### Phase 1 — Convert function + first cycles

- Ship the convert function (admin-gated).
- Deploy VPFI vester contract; fund founder grants at TGE.
- Run the first conversion manually after enough fees have
  accumulated.
- Document the cycle outcomes in release notes.

### Phase 2 — Timelock + first governance budget proposals

- Migrate convert function admin to timelock (48h delay).
- Pass first governance budget proposal for the team's
  ongoing operating expenses.
- Establish the per-quarter or per-milestone cadence.

### Phase 3 — Mature governance

- Convert function callable by governance proposal (with public
  execution after delay).
- Buyback-and-burn cadence formalized.
- Staker-reward top-up cadence formalized.
- Founder team operates as a normal governance-funded contributor.

---

## 6. Pre-TGE prerequisites

Before any of this goes live, the following need a securities
lawyer's sign-off:

1. **Genesis allocation distribution**: founder %, employee %,
   investor %, community %. These percentages frame the entire
   structure.
2. **Vesting schedule**: the contract chosen (Sablier / Hedgey /
   custom), the schedule (typically 4 years linear with 1-year
   cliff), and the cap on early-claim mechanics.
3. **Convert function eligibility for non-securities treatment**:
   the function operates on protocol-collected fees only, with no
   path to a hardcoded insider address. Lawyer should confirm
   the design rationale formally.
4. **Discretionary-governance-budget mechanism for the team**:
   documented in a charter making clear governance retains
   discretion. No automatic payouts. Per-quarter cadence with
   sunset clauses.
5. **Sanctions screening path** for any payee multisig (operating
   team, vester recipient, etc.).

---

## 7. Open decisions

The following need explicit decisions before implementation:

1. **Founder allocation percentage**. Industry range is 10-25%.
   What's right for Vaipakam given the current cap table and
   target token distribution?
2. **Vesting schedule shape**. Industry default is 4 years linear
   with 1-year cliff. Should Vaipakam follow or deviate?
3. **Vester contract choice**. Sablier V2 (audited, widely used,
   slightly opinionated UX), Hedgey Finance (cleanly designed,
   newer), custom (full control, audit cost). Recommend
   evaluating Sablier first.
4. **Target asset mix** (ETH / WBTC / VPFI ratios). Subject to
   tokenomics document; not yet specified. Proposed default 40 /
   30 / 30 BPS for Phase 1.
5. **Conversion thresholds**:
   - USD-equivalent threshold: proposed default $10,000, must be
     revisable per chain since threshold relevance varies with
     fee volume.
   - Max-interval days: proposed default 30 days.
6. **Per-cycle distribution split**. After conversion, what
   percentages go to operating budget / buyback / staker reward /
   reserve? Default proposal: 30 / 30 / 30 / 10. But this is
   governance-controlled per cycle, so the default only shapes
   the first proposal.
7. **Buyback mechanism**. Direct purchase from a DEX, or use of a
   bonding curve? Direct purchase is simpler and more transparent.

---

## 8. Open questions for legal review

1. **Securities classification of the convert function itself**.
   Does running an automated treasury conversion (between a
   protocol's own tokens and ETH / WBTC) trigger any swaps-as-
   securities concern? Standard answer: no, but worth confirming.
2. **VPFI buyback-and-burn**. Is buying back the protocol's own
   token from the open market, with treasury funds, considered
   market manipulation? Standard answer: no when transparent and
   pre-announced; but check.
3. **Operating budget grants to multisig**. Do these grants
   require KYC of the multisig signers? If yes, what's the
   process?
4. **Cross-jurisdiction founder tax planning**. If founders are in
   different countries, does the vesting contract design need
   per-jurisdiction adjustments?
5. **Sanctions screening for ongoing distribution**. Should the
   convert function refuse to execute if any of the recipient
   pool addresses (buyback contract, staker reward pool,
   treasury runway) contains a flagged address?

---

## 9. Cross-references

- **T-056** in [`docs/ToDo.md`](../ToDo.md) — implementation
  shape.
- **GovernanceRunbook.md** "Treasury and founder distribution
  policy" section — operational summary.
- **T-051** in
  [`docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md`](EscrowStuckRecoveryDesign.md)
  — the chokepoint counter that lets the Diamond safely double as
  treasury.
- **Phase 7a swap-failover infrastructure** (LibSwap + 0x / 1inch
  / Balancer / Bebop adapters). The convert function reuses this.
- **Tokenomics** in [`docs/internal/Tokenomics.md`](../internal/Tokenomics.md)
  (when it lands) — the genesis VPFI allocation breakdown that
  frames this design's founder grants.

---

## 10. Glossary

- **Auto-route**: an on-chain mechanism where a percentage of
  protocol-collected fees is automatically transferred to a
  specified address on every fee accrual or every conversion.
- **Aggregator (1inch / 0x)**: a routing protocol that finds the
  best price across many DEXs for a given swap.
- **BPS (basis points)**: 1/10000 = 0.01%. Used for the target
  mix ratios and slippage tolerances.
- **Genesis allocation**: the initial token distribution at TGE,
  before any user activity. Founder allocations are part of this.
- **Realization event**: a tax event where income is recognized.
  Each fee accrual to a hardcoded founder address is a separate
  realization event in most jurisdictions.
- **TGE (Token Generation Event)**: the moment a protocol's token
  is created and initial distribution happens. For Vaipakam this
  hasn't occurred yet.
- **Vester contract**: a contract that holds tokens for a
  beneficiary and releases them on a schedule (typically linear
  over 4 years with a 1-year cliff).
- **Howey test**: the US Supreme Court's four-factor test for
  whether a financial arrangement is a securities investment
  contract. Most relevant prong here: "expectation of profits
  derived from the efforts of others."

---

## 11. Decision log

This document is a proposal. Decisions will be recorded here as
they're made.

- **2026-05-04**: Original sketch (T-056 first draft) reviewed
  against industry pattern. Industry survey conducted.
  Per-tx auto-route to founder address rejected. Aggregated
  conversion + genesis vesting + governance budget design
  recommended. Document drafted; pending review by founders
  and legal counsel.
