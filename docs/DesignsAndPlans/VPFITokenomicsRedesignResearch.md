# VPFI Tokenomics Redesign — Research Findings & Roadmap

> **Status:** Research complete. **Phase-1 (admin-controlled) design DECIDED — see §9.** Code not started.
> **Tracking cards:** [#694](https://github.com/vaipakam/vaipakam/issues/694) (this research + roadmap) · prerequisite [#687](https://github.com/vaipakam/vaipakam/issues/687) (securities-risk removals).
> **Date:** 2026-06-22.
> **Source:** multi-agent deep-research sweep — 22 sources, 25 claims adversarially verified (19 confirmed, 6 refuted).
>
> ⚠️ **All legal conclusions in this document are informational, not legal advice. Confirm with securities counsel before acting.**

---

## 1. Purpose

Card [#687](https://github.com/vaipakam/vaipakam/issues/687) — the **prerequisite to this work, NOT yet implemented** — targets removal of the two highest securities-law-risk features from VPFI tokenomics:

1. the **issuer-priced fixed-rate primary token sale** (users paid ETH → received VPFI from a protocol reserve at an admin-set price), and
2. the **5% APR passive staking yield** paid on vault-held VPFI.

> ⚠️ **These surfaces still exist in the tree** (`VPFIDiscountFacet` buy config, `StakingRewardsFacet`, and "5% APR" copy) until #687 lands. Phase 1 is **blocked on the actual removal work** — do not treat the high-risk paths as already gone.

This document answers the follow-on question: **how do mature DeFi lending protocols, DEXs, and NFT-finance platforms give a token genuine value and distribute it WITHOUT recreating those two fact patterns?** Each concept below carries an explicit **ADOPT / ADAPT / AVOID** recommendation for Vaipakam.

### What VPFI is (current state)
- Utility + future-governance ERC20; 230M hard cap; 23M initial mint.
- EIP-2535 Diamond architecture; multi-chain via Chainlink CCIP.
- **Kept** after #687: fee-discount tiers (consumptive utility — benefit only when you transact), cross-chain bridging, future governance, and a usage-based "interaction rewards" emission pool (rewards for actively lending/borrowing).

---

## 2. Controlling legal framework

The **SEC/CFTC Interpretation of March 17, 2026** is the governing framework, corroborated across multiple Am Law firm client alerts (WilmerHale, Sidley, and Fintech & Digital Assets — see [§10 Sources](#10-sources)). *(The §10 Hunton link is the 2018 airdrop-enforcement note, not a 2026-Interpretation analysis, so it is not counted here.)*

Key carve-outs and boundaries it establishes:

- **No-consideration airdrops** — distributions where recipients give the issuer no money, goods, services, or other consideration **fail Howey's "investment of money" prong**. **Scope limit:** the carve-out addresses only that one prong, and applies to airdrops of an asset that is *itself* a non-security crypto asset — it is **not** a blanket "an airdrop is never a security" rule. For VPFI specifically, whose "digital tools" mapping is only an inference (§4.7), an airdrop is defensible on the investment-of-money prong but is **not automatically** non-security ahead of counsel/classification work. The carve-out does **not** extend to arrangements requiring recipients to perform tasks, make purchases, or otherwise provide value. Participation must be **unforeseeable**: *"If recipients can foresee the basis for an airdrop and take action expecting to receive it, that would constitute bargained-for consideration."*
- **Protocol staking** — this discussion is about **PoS network protocol staking of a non-security digital commodity**, where rewards come from the *network protocol* and the service provider has no discretion over staking decisions and offers no fixed/guaranteed returns. It is generally **not** a securities offering only within that frame; "guaranteed rewards" or "broader discretion" fall outside it. **Do NOT generalize this to token-holder reward products:** a VPFI vault-staking yield is outside this protocol-staking frame entirely (VPFI is not a PoS network and the rewards would come from the operator, not a network protocol), so it cannot be rescued merely by making it "ministerial."
- **Issuer sales** with managerial-effort promises remain securities. The 2026 release **raised the bar**: representations must be "explicit and unambiguous."
- **Five-part taxonomy:** digital commodities, digital collectibles, **digital tools**, stablecoins, digital securities.

> **Load-bearing caveat:** this is an interpretation / staff-statement set, **NOT** binding APA rulemaking. It is rescindable by future SEC leadership without notice-and-comment, does **not** bind federal courts, and **private-litigation risk persists** independent of SEC posture. The 2025–2026 environment is unusually favorable and fast-moving; a posture defensible in mid-2026 may shift.

---

## 3. Per-concept recommendations (summary table)

| # | Concept | Verdict | Confidence |
|---|---------|---------|------------|
| 1 | No-consideration retroactive airdrop | **ADOPT** | High |
| 2 | Usage-based interaction rewards | **KEEP + tighten** (lower-confidence, counsel-gated mechanics — §9.2/§6; NOT the zero-consideration airdrop posture) | High (mechanic) / lower (legal) |
| 3 | Passive / guaranteed staking yield | **AVOID** (confirms #687) | High |
| 4 | Issuer-priced primary sale | **AVOID** (confirms #687) | High |
| 5 | Real-yield value accrual (fee switch / revenue share) | **ADAPT — lean buyback-and-burn** | High (comparable) / lower (legal line) |
| 6 | Progressive decentralization + governance utility | **ADAPT — strategic frame** | High |
| 7 | "Digital tools" target classification | **ANCHOR narrative** | Medium |

---

## 4. Findings in detail

### 4.1 No-consideration retroactive airdrops — **ADOPT**
**Claim (verified 3-0):** the most legally defensible retail distribution mechanism and the safe archetype for distributing VPFI; bargained-for or foreseeable participation reintroduces securities risk.

**Evidence.** Per the 2026 Interpretation, no-consideration distributions fail Howey's "investment of money" element. The enforcement counter-example is *In re Tomahawk Exploration* (2018): a "bounty program" distributing tokens for promotional services / to create a trading market **was** a securities sale because *"the lack of monetary consideration for free shares does not mean there was not a sale"* when *"the donor receives some real benefit."* Direction of travel is favorable: Commissioner Peirce's May 2025 proposed airdrop-exemption framework. *(An earlier draft also cited EO 14178 here; that order is a broad digital-asset policy/working-group directive, **not** an airdrop safe-harbor proposal, so it is dropped to avoid overstating the legal support for this ADOPT verdict.)*

**Recommendation.** ADOPT a **retroactive, snapshot-based, no-cost** VPFI airdrop with **NO pre-announced eligibility criteria** — this is the archetype. **AVOID** any bounty/referral/promotional-service distribution where Vaipakam receives marketing value, or that is announced in advance (recreates the Tomahawk fact pattern and the foreseeability problem).

**Caveats.** SEC interpretations/staff statements, not binding rulemaking — rescindable; private-litigation risk persists.

---

### 4.2 Usage-based interaction rewards — **KEEP + tighten**
**Claim (verified 3-0):** usage/service-based "interaction rewards" sit on the defensible side of the line — but framing discipline is essential.

**Evidence.** Under the 2026 framework, protocol rewards can be defensible as compensation-for-services, but the operative test is **"efforts of others," not literal passivity.** The verifier explicitly **refuted** the broad claim that service-based rewards are *categorically* safe.

**Recommendation.** KEEP the usage-based interaction-rewards pool, but:
- tie rewards strictly to **completed lending/borrowing transactions** (consideration for actual usage);
- make rates **variable and discretion-free**;
- **never** market them as "yield" or "APR" on holdings.

**Caveats.** Even amount-and-duration "stake for more tokens" models (e.g. some NFT-rental platforms' staking) are a passive time-locked yield pattern Vaipakam should **not** emulate.

---

### 4.3 Passive / guaranteed staking yield — **AVOID** (confirms #687)
**Claim (verified 3-0):** the highest-risk securities fact pattern; removal of the 5% APR passive staking yield was correct.

**Evidence.** The SEC charged Coinbase (June 2023) with an unregistered securities offering for its staking-as-a-service program: it pools customers' stakeable assets, stakes the pool, and provides a portion of the rewards, so customers *"earn profits from the proof-of-stake mechanism AND Coinbase's efforts"* (SDNY denied Coinbase's motion to dismiss the staking claim in 2024). Under the 2026 framework, protocol staking is outside the safe harbor where there are "guaranteed rewards" or "broader discretion." Vaipakam's removed 5% APR passive yield on vault-held VPFI is exactly the disqualifying pattern.

**Recommendation.** AVOID anything resembling a fixed/guaranteed-APR yield on held VPFI, in any form.

**Caveats.** The Coinbase case was voluntarily dismissed in 2025, but the legal theory and 2024 MTD ruling stand as cautionary precedent.

---

### 4.4 Issuer-priced primary sale — **AVOID** (confirms #687)
**Claim (verified 3-0):** an issuer-priced primary token sale is the classic Howey investment-contract pattern; it should not be reintroduced in any form.

**Evidence.** A non-security token becomes an investment contract *"when an issuer offers it by inducing an investment of money in a common enterprise with [explicit] representations or promises to undertake essential managerial efforts from which a purchaser would reasonably expect to derive profits."* The "efforts of others" prong lives in the **issuer's representations**. Vaipakam's removed feature (users pay ETH, receive VPFI from a reserve at an admin-set price, with the team building the platform whose success drives token value) is precisely this pattern.

**Recommendation.** AVOID reintroducing any issuer-priced primary sale. For **treasury capital**, the **common market pattern** (a counsel-review option, **not** a verified-defensible path here) is **private rounds to accredited / non-US investors or SAFTs** (exempt private placements) — not a retail issuer sale. Its defensibility was not independently verified in this research (see caveat); treat it as the direction mature protocols take, to be confirmed with counsel.

**Caveats.** **Uncited counsel question (not a verified source):** it is *arguable* that a fixed-price sale *alone*, absent explicit managerial-effort/profit promises, does not *automatically* become a security — but this nuance is **not** backed by a source in §10 (an earlier draft attributed it to Paul Weiss without a link) and should be treated as a question for counsel, not a relied-upon position. Regardless, for a core team building a platform the managerial-effort element is hard to disclaim, so avoidance is the prudent call. SAFT/private-placement defensibility was **not** independently verified in this research; confirm with counsel.

---

### 4.5 Real-yield value accrual (fee switch / revenue share) — **ADAPT, lean buyback-and-burn**
**Claim (verified 3-0):** veTokenomics / real-yield in ETH (the leading NFT-lending protocol's vote-escrow model) is the most directly comparable NFT-finance value-accrual template — usable for governance and revenue-sharing, but the lock-for-rewards mechanic must be framed as fee-share-for-active-participation, not lock-for-passive-yield.

**Evidence.** The closest major NFT-lending comparable uses a Curve-style vote-escrow design: users lock the governance token → receive a non-transferable vote-escrow position (max 4-year lock), granting **both** governance rights (voting on which NFTs are accepted as collateral) **and** a revenue share paid in **ETH** (100% of ETH income collected from NFT-backed loans = 30% of borrowing interest, plus shares of other revenue). This is "real yield" (sharing actual protocol revenue in ETH) rather than inflationary token emissions.

**Recommendation.** ADAPT selectively.
- **Defensible elements to borrow:** (a) share **real protocol revenue** (interest/fees Vaipakam actually earns), not minted VPFI; (b) use the token for **genuine governance** over collateral/risk parameters.
- **Risk element to handle:** "lock token → revenue share" can read as the same passive-yield pattern the SEC targets if framed as a guaranteed return on a locked holding. To stay defensible: make any fee-share **(i)** governance-controlled via a fee switch the DAO turns on (not an admin-promised yield), **(ii)** variable/discretion-free, never advertised as a fixed APR, and **(iii)** ideally tied to active governance participation.
- **Safest path given #687:** deliver value accrual via **buyback-and-burn** — the treasury uses real revenue to buy and burn VPFI, benefiting all holders **structurally** without a per-holder yield promise. Preferred over fee-share / veToken revenue-share for now.

**Caveats.** The comparable's veToken revenue share is currently **paused** (its V2 shifted strategy) — design template, not a live endorsement. The fee-switch, buyback-and-burn-vs-distribute, and ve(3,3)/gauge/bribe-market legal-framing comparisons were **not** independently verified by primary sources and remain partially open. The legal line between a governance-gated fee-share and a passive-yield security is genuinely uncertain and fact-specific.

---

### 4.6 Progressive decentralization + governance utility — **ADAPT (strategic frame)**
**Claim (verified 3-0):** the primary mechanism mature protocols use to **reduce holder reliance on the team's "efforts of others"** — a risk-reduction *process*, **not** a verified mechanism that flips a token's legal status (see caveat: sufficient decentralization is not statutory and the flip is not guaranteed).

**Evidence.** The canonical framework is a three-stage sequence: (1) achieve product/market fit under centralized team control; (2) introduce community participation with incentive alignment; (3) reach sufficient decentralization via widespread token distribution and community ownership ("exit to the community by airdropping tokens"). Post-launch, *"provided the network is sufficiently decentralized, the nature of the token can change from security to non-security"* because holders "no longer rely on the efforts of others."

**Recommendation.** ADAPT as the governance roadmap:
- **(a)** make economic parameters (fee BPS, emission schedule, the 230M cap) **immutable or governance-controlled** rather than admin-controlled, so value does not depend on ongoing team decisions — the same point as the #687 remove-vs-disable rationale, with a real Howey payoff;
- **(b)** make VPFI genuinely useful for governance (vote on collateral listings, risk params, the fee switch) — the NFT-lending comparable's "vote on accepted collateral" is a directly applicable template for our Diamond;
- **(c)** sequence the airdrop and governance handoff as the stage-3 "exit to community."

**Caveats.** "Sufficient decentralization" is nowhere in statute; SEC v. LBRY and SEC v. Telegram rejected attempts to escape securities status, and consumptive utility alone does not defeat investment-contract status. **The claim that merely "removing dependency" flips the status was REFUTED in verification** — decentralization is necessary framing, not a guaranteed legal outcome. It is a process, not a switch, and is fact-specific.

---

### 4.7 "Digital tools" target classification — **ANCHOR narrative**
**Claim (verified 3-0, medium confidence):** VPFI's consumptive fee-discount tiers map to the 2026 taxonomy's "digital tools" category (value from utility, not financial rights).

**Evidence.** The 2026 Interpretation's five-part taxonomy defines "digital tools" as deriving value from *"utility rather than financial rights,"* and "digital commodities" as deriving value from *"the programmatic operation of a functional crypto system… rather than from an expectation of profits based on the essential managerial efforts of others."*

**Recommendation.** KEEP the fee-discount tiers and explicitly design/communicate VPFI toward the "digital tools" archetype — value derived from **consumptive utility** (cheaper fees only when you transact), not from holding for appreciation. Treat this as a **design target and supporting argument** for VPFI's non-security character (it should anchor the narrative) — **not** a dispositive one: VPFI is a transferable ERC20 with a published Phase-2 value-accrual roadmap, and utility alone does not defeat investment-contract status (§4.7 caveat).

**Caveats.** Mapping VPFI specifically onto "digital tools" is an inference, not an SEC classification. The verifier **refuted** a related broader claim that utility tokens categorically carry lower securities risk — utility alone does not defeat investment-contract status (LBRY). Treat the taxonomy as a design target, not a safe harbor.

---

## 5. Refuted claims (do NOT rely on these)

These were killed in adversarial verification and must not anchor the design:

1. *"Removing holder reliance on the team's efforts makes the asset stop being a security."* (0-3) — decentralization is necessary framing, not a guaranteed outcome.
2. *"Utility tokens categorically carry lower securities risk."* (refuted) — utility alone does not defeat investment-contract status.
3. *"Service/usage-based rewards are categorically not securities."* (0-3) — the "efforts of others" theory still applies; framing matters.
4. *"A token is not a security simply if it lacks passive-yield / future-income rights."* (0-3) — necessary but not sufficient.

---

## 6. Open questions for counsel

1. The precise line between a defensible governance-gated **fee-switch** real-yield share and a passive-yield security — does **buyback-and-burn** (benefiting all holders structurally) avoid the per-holder-yield problem more cleanly than buyback-and-distribute or a veToken revenue share?
2. How to raise **treasury capital** legally without a retail issuer sale — do SAFTs / Reg D / Reg S private rounds to accredited and non-US investors carry materially lower enforcement risk, and what lockup/vesting is expected?
3. For the usage-based **interaction-rewards** pool, what design details (variable vs fixed rate, claim mechanics, no "APR" marketing, strict tie to completed transactions) are needed so it reads as consideration-for-usage rather than an emission-based yield?
4. What concrete, sequenced milestones constitute **"sufficient decentralization"** for VPFI governance (parameter immutability vs DAO control, multisig→timelock handoff, distribution breadth), and which economic parameters should be immutable at launch versus governance-controlled later?

---

## 7. Not firmly established (lower confidence)

The following requested dimensions were **not** covered by verified primary-source claims; recommendations touching them rest on general knowledge plus the verified Howey/airdrop/staking principles, at lower confidence: fee-switch mechanics in detail; buyback-and-burn vs buyback-and-distribute legal framing; ve(3,3)/gauge-voting/bribe-incentive markets; emission decay-curve design; how SAFTs/private rounds achieve their legal defensibility.

---

## 8. Roadmap / next actions

Candidate child cards (owner to confirm split):

- **Card A — Buyback-and-burn value accrual.** Treasury uses real protocol revenue to buy + burn VPFI. **Phase 2 — do this AFTER decentralization, not first.** (An earlier draft said "do this first"; that contradicts the decided §9.1/§9.5 sequence, which defers **all** value-accrual until control actually decentralizes — implementing a value-accrual engine while the admin still holds the keys *increases* exposure. Among Phase-2 value-accrual options it is the lowest-ambiguity one, but it is still Phase 2.) Write design doc under `docs/DesignsAndPlans/` when that phase opens.
- **Card B — Retroactive airdrop + progressive-decentralization roadmap.** Snapshot design (no foreseeable criteria), governance-utility wiring (vote on collateral/risk/fee switch), parameter-immutability schedule.
- **Card C — Interaction-reward hardening.** Enforce completed-transaction tie, variable rate, de-"APR" all copy. May fold into [#687](https://github.com/vaipakam/vaipakam/issues/687).
- **Card D — DAO-governed liquidity gauge [Phase 2 only].** Community-voted VPFI/ETH liquidity incentives, gated on decentralization. **Phase 1 explicitly AVOIDS operator-run LP / market-making / pool seeding** (operator fostering a market for its own token + LP-reward-as-yield reintroduce the removed risks); §9.2 forbids team-seeded liquidity. Liquidity must form organically in Phase 1; this card is NOT a Phase-1 item.

Also pending from #687: reallocate the freed **1%** (sale) + **24%** (staking) supply pools, or reduce the 230M cap accordingly.

---

## 9. Phase 1 (Admin-Controlled) — Minimal-Footprint Design (DECIDED)

The platform launches under **admin control** (parameters, treasury, and operations all held by the operator; governance and decentralization come later). This section is the **decided** tokenomics for that phase, optimized to **minimize mandatory legal/compliance overhead** — i.e. structured so that nothing in it *triggers* an obligation that would require a registration, license, or ongoing counsel engagement to satisfy.

### 9.1 Governing principle
Admin control is the **"efforts of others"** prong of Howey at its strongest. Therefore, during this phase the token must carry **no profit expectation at all** — its only defensible legal identity is a **pure consumptive "digital tool."** Every value-accrual mechanism (buyback-and-burn, fee-switch/real-yield, vote-escrow, governance) is **deferred to Phase 2**, gated on actual decentralization. Adding any of them while the admin holds the keys *increases* exposure; doing less with the token is the cheaper and safer path.

### 9.2 Decided levers

| Lever | Phase-1 decision |
|---|---|
| Token role | VPFI = consumptive **fee-discount tool only**; no other on-chain economic right. |
| Launch | **VPFI launches now** as the utility tool (uses existing token; not deferred to a points program). |
| Primary sale | **None.** No issuer sale in any form. |
| Yield / staking | **None.** No fixed/passive yield. |
| Value accrual (buyback / fee-share / ve) | **Deferred to Phase 2** (post-decentralization). |
| Governance | **None live** in Phase 1; admin-controlled. Not marketed as a future value driver. |
| Distribution | **No issuer sale:** (a) usage-based interaction rewards — a **variable usage rebate** tied strictly to *completed* lend/borrow transactions, never labelled "APR/yield". **Lower-confidence design, not settled:** users supply principal/collateral and pay/earn fees and can foresee the reward once live, so it is **outside** the zero-consideration airdrop posture; its defensibility rests on counsel-reviewed mechanics (§6) — *argued* as a service/usage reward, **not** "no investment of money"; (b) optional **no-consideration** retroactive airdrop with no pre-announced criteria (the genuinely zero-cash-in path — itself gated per §2/§4.1). |
| Treasury / runway | **Bootstrapped** from protocol fee revenue (ETH/stables) only. **No capital raise** — explicitly NOT a private placement (avoids the expensive-counsel lane). |
| Operator compensation | Vested/timelocked founder/team allocation. **Affiliate secondary-market sales are NOT a decided low-overhead lever** — while the operator still controls parameters and VPFI has no live governance/value-accrual, founder/team sales can read as issuer/affiliate distribution or capital formation rather than neutral user transfers. Gate any realization on **lockups + counsel review + Phase 2**, not on Phase-1 ad-hoc selling. Still **no team-seeded liquidity or market-making** (a team-made market is itself an enforcement hook). |
| Marketing | No profit / yield / returns / appreciation / investment / price language anywhere. VPFI = fee-discount tool. (Reinforces the existing retail-copy policy.) |
| Compliance scaffolding | Keep existing **free** measures: on-chain ToS (LegalFacet), sanctions screening, retail KYC-off. "Nothing added" applies to the **token-distribution** surface only — it is **not** a protocol-wide conclusion: if the independent MSB/VASP/BSA analysis (§9.3) finds covered lending activity, AML-program / KYC obligations there are a separate matter. |

### 9.3 How each regime stays minimal
*(These reduce the *token-level* surface; each still needs the bounded counsel review in §9.4 — none is a self-certified clearance.)*
- **Securities:** no sale + no yield + consumptive-only + no team-made market **reduces the token-level profit-expectation surface**. It does not eliminate it: a transferable ERC20 launched under admin control with a published Phase-2 governance/value-accrual roadmap can still support a fact-specific profit-expectation argument, and VPFI's own classification remains an inference pending counsel (§4.7).
- **Money transmission / VASP:** the VPFI distribution adds **no token-*sale* custody trigger** (the operator never *sells* VPFI). Custody nuance: the kept fee-discount path's `depositVPFIToVault` does move users' VPFI into Diamond-controlled per-user vault proxies, so the no-custody framing is scoped to "no token-sale custody," not a blanket "never custodies." This does **NOT** clear the protocol's broader money-transmission/VASP posture — the Phase-1 lending product still accepts, routes, and pays ETH/stables/collateral through admin-controlled contracts, which needs its own MSB/VASP analysis independent of the token.
- **MiCA / financial-promotion (EU/UK):** Phase 1 still **distributes VPFI to public EU/UK users** (via completed-txn rewards + the optional airdrop), so "no public offer" is **not** a categorical given — especially where rewards are tied to fee-generating transactions. This still requires a MiCA / financial-promotion **exemption analysis** (white-paper / approved-promotion triggers), not reliance on disciplined marketing alone.
- **AML:** sanctions-screening + retail KYC-off is at the floor **for token distribution only**. It is **not** a conclusion for the protocol as a whole — if the independent MSB/VASP/BSA analysis (above) finds covered activity, AML-program / customer-identification obligations could exceed sanctions screening.

### 9.4 Honest cost note
Minimal-spend ≠ zero-legal. The highest-ROI legal spend for a lean launch is a **single bounded review** (a few hours) sanity-checking *this exact* no-sale/no-yield/consumptive-utility design against the **operator's home jurisdiction, the US, and the EU/UK** (the last unless those users are geofenced out — §9.3 flags the MiCA/financial-promotion analysis as mandatory while EU/UK distribution is open) — far cheaper than any registration/structuring, and not an ongoing engagement. The private-placement/SAFT route is deliberately avoided precisely because it *requires* costly counsel.

**Optional discretionary measure:** a frontend US-geoblock + ToS representation **reduces** frontend-access and marketing exposure for near-zero cost — it does **not** *remove* US enforcement or private-litigation risk: the contracts stay permissionless, so US users can still reach them via other frontends / direct calls, and regulators can still assess issuer conduct + marketing. Not *required* after #687; in mild tension with the permissionless ethos; left as an operator risk-tolerance call.

### 9.5 Transition to Phase 2
Phase-2 items (governance, then buyback-and-burn, then any fee-share) unlock **only as control actually decentralizes** — economic params move admin → timelock → DAO, distribution broadens, multisig handoff completes. Sequence is load-bearing: **decentralize first, add token value-accrual second.**

---

## 10. Sources

Verified during the research sweep:

- SEC/CFTC 2026 Interpretation analyses:
  - https://www.wilmerhale.com/en/insights/client-alerts/20260324-the-secs-new-framework-for-crypto-assets-under-howey
  - https://www.sidley.com/en/insights/newsupdates/2026/03/sec-releases-landmark-interpretation-on-application-of-us-securities-laws-to-crypto-assets
  - https://www.fintechanddigitalassets.com/2026/04/sec-clarifies-the-application-of-the-securities-laws-to-cryptoassets/
- Airdrop enforcement & litigation:
  - https://www.hunton.com/blockchain-legal-resource/sec-brings-enforcement-case-involving-airdrop-securities
  - https://cryptonews.com/news/defi-education-fund-apparel-firm-sue-sec-over-unwritten-airdrop-securities-rule/
- Staking enforcement:
  - https://www.sec.gov/newsroom/press-releases/2023-102
- Progressive decentralization / sufficient decentralization:
  - https://a16zcrypto.com/posts/article/progressive-decentralization-crypto-product-management/
  - https://variant.fund/articles/sufficient-decentralization/
- NFT-finance comparable (vote-escrow / real-yield):
  - https://docs.benddao.xyz/portal/faq/tokenomics
  - https://medium.com/@mint-ventures/benddao-the-crisis-and-opportunities-of-the-nft-lending-avant-garde-30f6ff734ae2
- veTokenomics overviews:
  - https://www.coingecko.com/learn/vetokens-and-vetokenomics
  - https://docs.velodrome.finance/tokenomics
  - https://outlierventures.io/article/vegood-vebad-and-veugly/
- Buyback / fee-switch context:
  - https://www.dlnews.com/articles/defi/uniswap-dao-to-activate-fee-switch-and-burn-100m-uni-tokens/
  - https://cryptodaily.co.uk/2026/05/aave-buybacks-protocol-revenue-defi-tokens
  - https://cryptodaily.co.uk/2026/05/defi-revenue-tokens-fees-burns-buybacks-over-tvl

**Research stats:** 5 search angles · 22 sources fetched · 104 claims extracted · 25 verified · 19 confirmed · 6 refuted.
