# #671 — Progressive risk access (per-vault tiers + per-pair consent)

**Status:** Design — for Codex review. **Issue:** #671 (epic #670;
mitigation design for backlog #663). **Layers on top of** #662
([`OfferAcceptTermBindingDesign.md`](OfferAcceptTermBindingDesign.md)) —
*complements, does not replace* it. **Sequenced after** #662.

> The card already carries RATIFIED resolved decisions (2026-06-21). This
> doc does not re-decide them — it **grounds** each one against the
> current code + FunctionalSpec and surfaces where the code does **not**
> support a resolved decision exactly as written. Those deltas are called
> out inline and collected in §11.

## 1. Problem / threat model

`acceptorRiskAndTermsConsent` is a single hardcodable bool. #662 binds
that consent to the *specific terms* via an EIP-712 `AcceptTerms` so a
phishing clone cannot swap terms within a tier the user trusts. What #662
does **not** do is reduce a default wallet's *structural* exposure to
exotic assets: a brand-new wallet, with zero prior intent, can still be
walked through accepting an oracle-less dummy-asset offer — the #662
guard makes the prompt *honest*, but an honest prompt for a $0-collateral
loan still funds if the user clicks.

The two #662 phishing scenarios that the **illiquid LTV/HF bypass**
enables (confirmed at
[`LoanFacet._maybeRunInitialRiskGates:474-487`](../../contracts/src/facets/LoanFacet.sol#L474)):

- **Scenario A** — attacker posts a worthless oracle-less token as
  collateral, requests real principal, creator-consent `true`; victim
  "accepts" as lender → real principal leaves, backed by a $0 token.
- **Scenario B** — mirror: worthless principal, valuable collateral
  requested; victim's collateral locks; reclaim needs repaying junk →
  default → full illiquid-collateral transfer to attacker.

With **liquid** assets the HF≥1.5 / LTV gate
([`LoanFacet.sol:474`](../../contracts/src/facets/LoanFacet.sol#L474))
already blocks both. Both scenarios are specific to the **illiquid +
blanket-consent** path.

**The structural fix #671 adds:** sticky, two-dimensional, self-sovereign
**vault state** that makes the default experience blue-chip-liquid-only.
A wallet that never deliberately opted up *cannot* be the victim in A/B
no matter what it signs — the origination gate reverts before any value
moves. This is defense-in-depth *under* #662, not instead of it: #662 is
the per-tx integrity guard; #671 is the per-vault structural floor.

## 2. Why this is permissionless-compatible (load-bearing)

- **Self-sovereign.** The user holds the only key. `setVaultRiskTier` /
  `setIlliquidPairConsent` let any wallet open every door itself in one
  tx. No third party — not governance, not a keeper — can deny or grant
  access. Self-custody of *risk*, analogous to self-custody of *funds*;
  **not** a governance allowlist (consistent with the
  [[no-asset-gating]] decision and the retail-deploy "no KYC / no
  curated list" prohibitions in CLAUDE.md).
- **Derived classification, never curated.** An asset's tier comes
  *only* from existing on-chain signals:
  - [`OracleFacet.checkLiquidity(address) returns (LibVaipakam.LiquidityStatus)`](../../contracts/src/facets/OracleFacet.sol#L134)
    → `{Liquid, Illiquid}` ([`LibVaipakam.sol:640-643`](../../contracts/src/libraries/LibVaipakam.sol#L640)).
  - [`OracleFacet.getEffectiveLiquidityTier(address) returns (uint8)`](../../contracts/src/facets/OracleFacet.sol#L1225)
    = `min(getLiquidityTier(asset), effectiveKeeperTier(asset))`
    ([`OracleFacet.sol:1225-1231`](../../contracts/src/facets/OracleFacet.sol#L1225)),
    returning `0` (illiquid/untierable) through `3` (deepest band).
  - No hand-maintained blue-chip list. The per-asset governance levers are
    the existing `pauseAsset` blacklist (which sets `assetPaused` and blocks
    creation via `LibFacet.requireAssetNotPaused` — it does NOT change
    `getEffectiveLiquidityTier`, which doesn't read the pause flag; Codex r3 P3
    L69) **and** `ConfigFacet.setKeeperTier` (Codex r1 P2, L4Yl), which lets
    `KEEPER_ROLE` promote/demote an asset within its on-chain ceiling and DOES
    move the effective tier — both already in the code, not introduced here.
    Note the interaction: a brand-new asset's stored
    keeper tier defaults such that it is NOT tier-3, so BlueChipOnly excludes it
    until a keeper promotion lifts its *effective* tier to 3 — intentionally
    conservative, but means the blue-chip set is keeper-influenced, not purely
    depth-derived. This is still permissionless-compatible (the keeper can only
    move within the depth-bounded ceiling; it cannot curate an arbitrary list).
- **Marketing framing.** A self-set *safety rail* (spending-limit
  analog), never KYC / identity / permissioning (per the CLAUDE.md
  retail-copy prohibitions).

## 3. Resolved decisions, grounded in code

The card's four resolved decisions (2026-06-21), each checked against the
code:

### RD-1 — Mid-tier (L1) per-pair consent is a SOFT record, not a gate

The card: mid-tier keeps oracle + HF≥1.5 + LTV protection, so its risk is
*quantitative* (depth/slippage) not the *categorical* $0/HF-bypass that
makes illiquid dangerous; a hard gate would be redundant with #662
term-binding and would train click-through. Stamp
`{pairKey, timestamp, consentVersion}` + event on first use of a mid-tier
pair, non-blocking. **Illiquid (L2) keeps the HARD per-pair gate.**

**Grounded:** a quantitative LTV/HF gate at loan init runs for every
liquid-classified leg — `_maybeRunInitialRiskGates` only *skips*
`_checkInitialLtvAndHf` on the **`!bothLiquid && mutualIlliquidConsent`**
branch ([`LoanFacet.sol:474-487`](../../contracts/src/facets/LoanFacet.sol#L474)).
The admission **threshold** is NOT a flat unconditional HF≥1.5, though
(Codex r6 P2 L99): when `depthTieredLtvEnabled` is on, `_checkInitialLtvAndHf`
deliberately **relaxes** the LTV ceiling for deeper-tier liquid assets and
tightens it for thinner liquid pools (the depth-tiered-LTV design). So the
accurate invariant is "*a quantitative gate always runs for liquid legs; its
strictness is tier-dependent when depth-tiering is enabled, a flat HF≥1.5
floor when it is not*." Either way the **categorical-loss** path (full
collateral transfer, no quantitative check at all) is reachable only via
the illiquid bypass. The card's quantitative-vs-categorical distinction
is **code-accurate**. The two L1 sub-options (user-elected *strict mode*
per-vault flag → require per-pair acks even for mid-tier; *notional-
threshold gate* → large mid-tier loans require a fresh pair ack) are
additive flags; both are optional and default-off (see §11 / O3).

### RD-2 — Plain pull-claim of unusual collateral is GATED with a one-time pair-ack

The card: applies ONLY to the holder-initiated pull-claim
(`claimAsLender` / `claimAsBorrower`); the holder satisfies the ack so no
value is trapped. **Push-payouts / #594 consolidation that run inside a
counterparty's tx remain UNGATED** (gating them would brick the
counterparty's close-out — the #667/C2 DoS class). The transferee (new
owner) must ack before claiming.

**Ack flow for ordinary EOAs (Codex r4 P3, L128):** since the existing claim
selectors are unchanged, the ack is a **preceding standalone tx** —
`setIlliquidPairConsent(…)` then `claimAsLender(…)` (two txs; value isn't
trapped because the holder controls both and can ack any time). Optionally add
an **atomic `claimWithPairAck(...)`** convenience variant that takes the ack +
claims in one tx for UX; not required for correctness. Either way RD-2's "no
value trapped" holds — the gate only defers the claim until the holder
deliberately acks, which they can always do.

> **Non-signing contract holders (Codex r9 P2 L126):** the "holder can always
> ack" guarantee assumes the holder can produce a signature for
> `setIlliquidPairConsent`. An EOA or ERC-1271 wallet can; a plain contract that
> implements neither cannot self-submit the signed ack. For such a holder the
> pair ack comes through the same owner-gated `setIlliquidPairConsentFor`
> escape hatch as the tier raise — **but ONLY if it is in `protocolManagedVaults`**
> (a known protocol contract). An *arbitrary* non-signing contract that ends up
> holding a position NFT for an illiquid pair is therefore the one case where
> the claim can't be self-resolved; this is an inherent property of a contract
> that can neither sign nor be governance-managed, not a gate regression (the
> same contract already couldn't have *originated* the position under §7's
> self-submit rule). Flag it in the claim-path docs so integrators route NFT
> custody through signing-capable accounts.

**Grounded:**
- Pull-claim entries: [`ClaimFacet.claimAsLender(uint256):205`](../../contracts/src/facets/ClaimFacet.sol#L205)
  and [`ClaimFacet.claimAsBorrower(uint256):990`](../../contracts/src/facets/ClaimFacet.sol#L990).
  Both resolve the **current** NFT holder — `claimAsLender` /
  `claimAsLenderWithRetry` via the `requireLenderNftOwner(loan)` holder gate
  inside the shared `_claimAsLenderImpl` (Codex r5 P3 L131 — NOT the
  `:344` line, which is the backstop opt-in branch; cite the impl's owner check
  at implementation time), `claimAsBorrower` via `LibAuth.requireBorrowerNftOwner(loan)`
  ([`ClaimFacet.sol:1030`](../../contracts/src/facets/ClaimFacet.sol#L1030))
  + withdraw-to-`msg.sender`
  ([`ClaimFacet.sol:1085-1120`](../../contracts/src/facets/ClaimFacet.sol#L1085)).
  Both are holder-*initiated* (`msg.sender` is the claimant) → a pair-ack
  the claimant can satisfy in the same tx traps no value. **Supported.**
- Push side that MUST stay ungated:
  [`ConsolidationFacet.eagerConsolidateToHolder(uint256, bool):52`](../../contracts/src/facets/ConsolidationFacet.sol#L52)
  / [`eagerConsolidateBothSides(uint256):70`](../../contracts/src/facets/ConsolidationFacet.sol#L70),
  invoked inside the counterparty's tx from
  [`RepayFacet.repayLoan:211-212`](../../contracts/src/facets/RepayFacet.sol#L211),
  [`PrecloseFacet.precloseDirect:216-222`](../../contracts/src/facets/PrecloseFacet.sol#L216),
  and the swap/default close-outs. These pay-to-`ownerOf` flows run inside
  *someone else's* tx; gating them reverts the close-out — exactly the
  #667/C2 DoS class. **The card's dividing line is code-accurate.**

### RD-3 — Unlock cooldown configurable, DEFAULT OFF (0)

A per-deploy-tunable delay between opt-up and first use at that tier;
ships off so no friction by default. **Grounded:** a new
`riskAccessUnlockCooldownSec` field (default `0`) is a **top-level `Storage`
field, NOT inside `protocolCfg`** (Codex r1/r3 — appending to the embedded
`ProtocolConfig` shifts later top-level slots; see §8), read via a
`cfgRiskAccessUnlockCooldownSec()` accessor (same *accessor* shape as
[`cfgTier3SizePad():5008`](../../contracts/src/libraries/LibVaipakam.sol#L5008),
just not the same storage location). Its setter `setRiskAccessUnlockCooldown`
is **admin/governance-only** (a global deploy knob, range-bounded via the
shared typed range-error pattern) — NOT a self-service user setter (Codex r3
L535).
While `0`, the comparison `block.timestamp >= unlockedAt + cooldown`
collapses to "always satisfied" — no behavioural change. **Supported,
purely additive.**

### RD-4 — Tier→signal mapping: BlueChip = `getEffectiveLiquidityTier == 3`

The card states "CONFIRMED BlueChip = `effectiveLiquidityTier == 3`" and
cites `OracleFacet.sol:1755-1757` for "$5M size pad / 65% init-LTV / 82%
liq ceiling; tier 0 = untierable/illiquid."

**Grounded — with a citation correction (delta D1):**
- The selector is `getEffectiveLiquidityTier(address)`
  ([`OracleFacet.sol:1225`](../../contracts/src/facets/OracleFacet.sol#L1225)),
  not a bare `effectiveLiquidityTier`. (`effectiveKeeperTier` is the
  internal `min` operand at
  [`LibVaipakam.sol:5246`](../../contracts/src/libraries/LibVaipakam.sol#L5246).)
- Tier-3 = $5M PAD is confirmed at
  [`LibVaipakam.sol:136`](../../contracts/src/libraries/LibVaipakam.sol#L136)
  — `TIER3_SIZE_PAD_DEFAULT = 5_000_000 * 1e6` with the inline comment
  `// → Tier 3 (65% init-LTV)`. The cited `OracleFacet.sol:1755-1757` is
  the **doc-comment region** of `_liquidityTier`
  ([`:1751`](../../contracts/src/facets/OracleFacet.sol#L1751)), not the
  constant; the load-bearing constant lives in `LibVaipakam`. The
  *value* claim ($5M / 65%) is correct; the line citation should point at
  `LibVaipakam.sol:136`.
- `0` = illiquid/untierable confirmed at
  [`OracleFacet.sol:1228`](../../contracts/src/facets/OracleFacet.sol#L1228)
  (`if (onChain == 0) return 0;`).
- A brand-new asset sits at tier 1 until keeper-promoted (the `min`
  against `effectiveKeeperTier`, default 1 —
  [`LibVaipakam.sol:5246`](../../contracts/src/libraries/LibVaipakam.sol#L5246)),
  so it is excluded from L0 (BlueChipOnly) **by design** — intentionally
  conservative. Code-accurate.

## 4. Two-dimensional consent model

Both dimensions must be satisfied by the **current actor**:

```solidity
enum RiskAccessLevel { BlueChipOnly, BroadLiquid, IlliquidCustom }   // NEW — add to LibVaipakam

mapping(address user => RiskAccessLevel) userRiskAccess;                       // broad tier (default 0 = BlueChipOnly)
mapping(address user => mapping(bytes32 pairKey => bool)) illiquidPairConsent;  // pair-specific (illiquid only)
```

- `RiskAccessLevel` is a **new enum** — none exists today
  (`grep` confirms only `LiquidityStatus` at
  [`LibVaipakam.sol:640`](../../contracts/src/libraries/LibVaipakam.sol#L640)).
  `BlueChipOnly` is the zero-value, so an untouched wallet defaults to the
  most conservative tier with no migration / no initializer — the Solidity
  default-zero *is* the safe default. **Load-bearing: enum order must put
  the safe state at 0.**
- Both mappings append to the **flat** `Storage` struct
  ([`LibVaipakam.sol:2234-4305`](../../contracts/src/libraries/LibVaipakam.sol#L2234),
  slot `VANGKI_STORAGE_POSITION` at
  [`:62`](../../contracts/src/libraries/LibVaipakam.sol#L62)), appended at the
  **true current tail** — NOT near `signedOfferNonceUsed` (`:4079`), which is
  *not* the tail; the struct continues with live fields after it (see §8 for the
  full placement + the pre-live note). The
  struct is flat (no nested structs) — **keep these flat** to avoid
  worsening the viaIR whole-unit stack ceiling (see
  [[viaIR stack-too-deep lever]]).
- **Do NOT make L2 a one-time "unlock everything forever" toggle.**
  IlliquidCustom additionally requires `illiquidPairConsent[pairKey] ==
  true` per asset pair.

**pairKey shape (delta D2 — establish the precedent):** the card spec
proposes `keccak256(chainId, lendingAsset, collateralAsset,
lendingAssetType, collateralAssetType)`. Scout found **no existing
composite-keccak pair key** — the closest precedents are *nested*
mappings (`assetPairActiveOfferIds[lend][coll]` at
[`LibVaipakam.sol:2341`](../../contracts/src/libraries/LibVaipakam.sol#L2341);
`buybackAllowedToken[chainId][token]` at
[`:3712`](../../contracts/src/libraries/LibVaipakam.sol#L3712)), and the
only `keccak`-of-key usage is country pairs hashing *strings*
(`keccak256(bytes(countryA))`,
[`:5507-5508`](../../contracts/src/libraries/LibVaipakam.sol#L5507)).
`block.chainid` is used in keys (buyback) and in the EIP-712 domain
([`LibSignedOffer.sol:150`](../../contracts/src/libraries/LibSignedOffer.sol#L150)).
So the card's composite-keccak key is **a new pattern, not a reuse** — it
is sound (single-word storage key, asset-type-discriminated so the same
two addresses as ERC-20 vs ERC-721 don't alias), but the doc should note
it sets a new precedent. Use `abi.encode` (not `encodePacked`) to avoid
hash-collision ambiguity across the address+enum mix. The `chainId`
component is belt-and-suspenders here (storage is already per-chain) but
matches the EIP-712 domain convention and is cheap.

**Include NFT token IDs in the key (Codex r1 P2, L4Ym):** for ERC-721/1155
legs, distinct `tokenId`s under the *same* contract can have wildly different
value, so a consent for `(coll, id=5)` must NOT authorise `(coll, id=9)`. The
key therefore folds in `tokenId` + `collateralTokenId` (zero for ERC-20):
`keccak256(abi.encode(chainId, lendingAsset, lendingAssetType, tokenId,
collateralAsset, collateralAssetType, collateralTokenId))`. (1155 *quantity* is
NOT in the key — it's an amount, bound by #662's `AcceptTerms`, not an identity.)

**NFT-rental `prepayAsset` is the value-bearing leg — tier + key off it, not the
NFT (Codex r7 P2 L260):** on an NFT-rental offer the `lendingAsset` is the NFT
being rented, but the asset the borrower actually *posts* (and the lender is
exposed to) is the ERC-20 `prepayAsset` (`amount × durationDays` + buffer). So
for `assetType != ERC20` offers the risk **tier** is derived from
`getEffectiveLiquidityTier(prepayAsset)` (the real economic exposure), and the
pair key substitutes `prepayAsset` for the NFT leg:
`keccak256(abi.encode(chainId, prepayAsset, ERC20, 0, collateralAsset,
collateralAssetType, collateralTokenId))`. Tiering the rented NFT itself (always
illiquid) would force every rental into `IlliquidCustom` even when the prepay is
USDC — wrong gate, and it would miss a thin/worthless `prepayAsset` (the actual
risk). The NFT identity is still bound by #662's `AcceptTerms`; #671 gates on the
leg that carries value.

> **Pause-check the prepay leg too (Codex r8 P2 L269):** because rental risk is
> now keyed off `prepayAsset`, the create-time per-asset pause guard
> (`assetPaused`) must also reject a *paused* `prepayAsset` on an NFT-rental
> create — not just the NFT + collateral legs. An admin pausing a compromised
> ERC-20 expects it blocked everywhere it carries value, and for a rental that
> value lives in the prepay leg. Add `prepayAsset` to the create-time pause
> sweep wherever the lend/collateral legs are already checked — **and to the
> ACCEPT-time pause recheck too (Codex r9 P2 L283):** the existing accept path
> already re-screens the lend/collateral legs for pauses (an asset can be paused
> in the window between create and accept), so the rental prepay leg must be
> re-screened there as well, or a prepay-asset paused after offer creation would
> still bind into a loan at accept. **The accept-preview / dry-run surface
> (`previewAccept` and the offer-book UX guard) must mirror this prepay-pause
> check too (Codex r10 P2 L302)** so the frontend shows "prepay asset paused"
> before the user submits, rather than only reverting on-chain.

**Pair-consent setter takes the RAW typed assets, not an opaque `bytes32`**
(Codex r1 P2, L4Yj): `setIlliquidPairConsent(lendingAsset, lendingAssetType,
tokenId, collateralAsset, collateralAssetType, collateralTokenId, prepayAsset,
…sig)` — `prepayAsset` included for the rental-key substitution (Codex r10 P2
L306; `address(0)` for ERC-20), matching the signed digest in §7 — and
computes the key on-chain. Passing a pre-hashed `bytes32 pairKey` would make
the EIP-712 prompt unrenderable (the wallet must show the concrete `<A>/<B>`
pair the user is unlocking) and prevent the contract from validating the key.

### Asset → required level (derived)

| Vault level (default = **0 BlueChipOnly**) | Asset allowed (derived) |
|---|---|
| **0 BlueChipOnly** (default) | `getEffectiveLiquidityTier == 3` (deep, keeper-promoted) |
| **1 BroadLiquid** (explicit opt-in) | `getEffectiveLiquidityTier >= 1` (oracle + protocol risk params still apply) |
| **2 IlliquidCustom** (strongest opt-in) | any, incl. tier 0 / `checkLiquidity == Illiquid` — **and** `illiquidPairConsent[pairKey] == true` |

> **⚠️ WETH-tiering gotcha (Codex r5 P2, L264) — verify before shipping
> BlueChip=tier3.** `_liquidityTier` probes `effectivePaaAssets()` routes and
> skips any quote equal to the asset itself; the reference/numeraire asset
> (WETH) is `checkLiquidity == Liquid` but may **not** reach `getEffectiveLiquidityTier == 3`
> by that route — which would make the default `BlueChipOnly` vault unable to
> transact **WETH itself**, the canonical blue-chip. This must be resolved
> before the tier-3 rule ships: either (a) special-case the numeraire/WETH as
> tier-3-equivalent in the gate, or (b) guarantee a non-WETH PAA route so WETH
> tiers correctly, or (c) define BlueChipOnly as `tier == 3 OR asset ∈
> {reference assets}`. Tracked as **O6**. Until resolved, the default tier would
> be too strict (excludes WETH), not too loose — fail-safe, but unusable.
>
> **Symmetric WETH-fallback hazard (Codex r6 P2 L282):** for a NON-WETH asset
> whose `effectivePaaAssets()` route set has collapsed to the default
> `[wethContract]` fallback, the only depth signal is the asset↔WETH pool. The
> tier derivation MUST treat that WETH-only-route case as **tier-0** (riskiest)
> for every gate — never let the WETH fallback route inflate a thin asset's tier
> toward 3. Otherwise a sparsely-routed token could borrow WETH's blue-chip
> standing and slip past `BlueChipOnly`. The fix is one-sided and conservative:
> a real tier ≥1 requires a genuine non-fallback route; the fallback route alone
> pins the asset at tier-0. This is the gate-side complement to the WETH-itself
> special-casing above — together they make the numeraire blue-chip while
> denying borrowed-credibility to anything whose only route is *through* it.
>
> **Explicit WETH-only lists count too (Codex r7 P2 L293):** the tier-0 rule
> keys off the *resulting route set being `{WETH}` only* — NOT off "did we hit
> the implicit default fallback." A governance-configured `effectivePaaAssets()`
> that explicitly lists just `[wethContract]` for a thin asset is the identical
> hazard and gets the identical tier-0 treatment. So the check is "is the asset's
> effective route set ⊆ {WETH}?" (implicit fallback OR explicit single-entry),
> not "was the fallback branch taken" — otherwise an operator could hand a thin
> token blue-chip standing simply by hard-coding `[WETH]` as its PAA list.

The gate evaluates against `min(tier(lendingLeg), tier(collateralAsset))`
— **the RISKIER leg governs** (Codex r1 P1, L235) — where for an NFT-rental
offer (`assetType != ERC20`) the **lending leg is the ERC-20 `prepayAsset`**, not
the rented NFT (Codex r8 P2 L325, per §4): `min(tier(prepayAsset),
tier(collateralAsset))`. For an ERC-20 offer the lending leg is `lendingAsset`
as before. The tier scale is inverted
(`0` = illiquid/riskiest, `3` = deepest/safest), so the riskier leg is the one
with the **lower** tier and the required level must derive from `min`, not
`max`: `max` would let a tier-3 principal paired with tier-0 collateral pass as
BlueChip while the worthless collateral is the real danger. An acceptor is
exposed to the collateral's quality and vice-versa, so the worse leg sets the
bar.

## 5. Creation-time vs ongoing-action consent

### 5a. Creation-time (acting signer)

Checked at the three origination chokepoints against the acting signer,
on `min(tier(lendingAsset), tier(collateralAsset))`:

- **Every offer-creation entry point, gated against the real `creator`**
  (Codex r1 P1, L251 — `createOffer` is NOT the only one, and on some paths
  `msg.sender != creator`): the gate must live in the shared create chokepoint
  (or be replicated at each) and evaluate `creator`, not `msg.sender` —
  covering `createOffer`, `createOfferWithPermit`, the cross-facet
  `createOfferInternal`, and the **signed-offer materializers** (`SignedOfferFacet`
  / `OfferMatchFacet.matchSignedOffer`, where the signer is the real creator and
  `msg.sender` is the diamond/relayer). `createOffer` already enforces the
  consent bool ([`OfferCreateFacet.sol:872`](../../contracts/src/facets/OfferCreateFacet.sol#L872),
  `RiskAndTermsConsentRequired`) + liquidity check ([`:865-870`](../../contracts/src/facets/OfferCreateFacet.sol#L865));
  the tier gate slots in at the same shared point so no creation path is missed.
  **Exempt lender-sale-vehicle creation (Codex r4 P2, L281):** `createLoanSaleOffer`
  builds a borrower-style sale vehicle *through* `createOffer` so the **current
  lender can EXIT an existing position** — that's a risk-reducing exit, not new
  exposure, so it must be exempt from the create gate (same rationale as the D4
  close-out exemption). **Use a PRE-create signal, not `saleOfferToLoanId`**
  (Codex r5 P2, L303): that marker is written only *after* `createOffer` returns
  (`EarlyWithdrawalFacet.sol:449-456`), so it isn't visible at the create
  chokepoint. The sale flow must set a transient `saleVehicleCreate` flag
  *before* its `createOffer` call and clear it immediately after. **This flag is
  a field on the shared ERC-7201 `Storage` struct (a `bool`, exactly like
  `matchOverride.active` / `signedOfferAcceptor`), NOT a local or calldata arg
  (Codex r7 P2 L338)** — the create gate runs inside `OfferCreateFacet`, a
  *different* facet reached by a cross-facet `createOffer` hop, so a local in
  the sale facet would be invisible there; only shared storage crosses the
  delegatecall boundary. The gate reads `s.saleVehicleCreate` and skips the tier
  check when set; it MUST be cleared in the same tx (a non-false value at rest is
  a bug, same discipline as the other injection slots). A blanket gate at
  `createOffer` would otherwise trap a down-tiered lender trying to sell out.
  **The sale flow must reach creation through the reentrancy-safe internal
  create entry, not the external `nonReentrant` `createOffer` (Codex r8 P2
  L360):** the sale entry already holds the `nonReentrant` lock, so a same-tx
  cross-facet call into the external `createOffer` would re-enter the guard and
  revert. Route through the existing `address(this)`-gated `createOfferInternal`
  (the analogue of `acceptOfferInternal`) which carries no second lock — set
  `saleVehicleCreate` immediately before that internal hop and clear it in the
  `finally`-equivalent after, so the flag's lifetime is exactly the hop and the
  guard is never doubled.
- [`OfferAcceptFacet._acceptOffer:517`](../../contracts/src/facets/OfferAcceptFacet.sol#L517)
  — **the single chokepoint** both `acceptOffer`
  ([`:242`](../../contracts/src/facets/OfferAcceptFacet.sol#L242)) and the
  cross-facet `acceptOfferInternal`
  ([`:284`](../../contracts/src/facets/OfferAcceptFacet.sol#L284)) funnel
  through. The actor is already resolved here — `matchOverride.counterparty`
  / signed-offer acceptor / `msg.sender`
  ([`:622-626`](../../contracts/src/facets/OfferAcceptFacet.sol#L622)) — so
  the tier gate evaluates against the **resolved acceptor**, not
  `msg.sender` blindly. Mirrors exactly where #662's `AcceptTerms` binding
  lands, so the two checks compose at one site.
  **Re-assert the offer creator's tier here too (Codex r1 P2, L4Ye):** an
  offer can be created while the creator's tier/assets are acceptable, then the
  creator re-locks (ratchets down) or the asset is downgraded/paused before
  anyone accepts. So `_acceptOffer` re-checks **both** the resolved acceptor
  AND the stored offer's creator against the (possibly-changed) current tiers
  before binding — not just the acceptor. **Exception — sale-vehicle offers
  (Codex r5 P2, L321):** for a `createLoanSaleOffer` vehicle the stored
  `offer.creator` is the *outgoing lender*, and accepting auto-completes the
  sale (`OfferAcceptFacet.sol:1216-1223`) — i.e. the creator is *exiting*. So
  the creator re-assert is SKIPPED for sale-vehicle offers (only the incoming
  acceptor is gated), symmetric with the create-time sale-vehicle exemption;
  re-gating the exiting seller would trap a down-tiered lender mid-sale. **For
  a (non-sale) `IlliquidCustom` pair, also
  re-check the per-pair `illiquidPairConsent` (and the acceptor's), not only
  the broad `userRiskAccess` tier** (Codex r3 P2, L300): pair consent is the
  second load-bearing dimension and can be *revoked* after offer creation, so a
  tier-only re-assert would miss a revoked pair. Cheap view reads; defends the
  stale-offer window symmetrically with the match-path re-assertion (D3/O5).
- [`OfferMatchFacet.matchOffers:158`](../../contracts/src/facets/OfferMatchFacet.sol#L158)
  / `matchSignedOffer` (
  [`:278`](../../contracts/src/facets/OfferMatchFacet.sol#L278)) — these
  pair **two already-authored offers**, each carrying its creator's own
  consent + tier check from create-time. Consistent with #662's matcher
  analysis (the matcher is not a victim-acceptor; the `matchOverride` slot
  marks the match context). **The tier gate is enforced at *create* time
  on each side; the match does not re-gate the matcher.** This avoids
  gating a permissionless matcher (`matchOffers` is gated only on the
  `partialFillEnabled` master flag + `_assertNotSanctioned(msg.sender)` at
  [`:170`](../../contracts/src/facets/OfferMatchFacet.sol#L170), not
  keeper-only). **Delta D3:** the card lists `matchOffers` as an
  origination enforcement site, but the correct enforcement is at *each
  offer's create*, not at match — re-gating the matcher's own vault would
  punish a third party who never takes a position. Recommend: enforce on
  both offers' creators at create-time, and at match re-assert each *paired
  offer* still satisfies its creator's level **AND, for an `IlliquidCustom`
  pair, the creator's per-pair `illiquidPairConsent`** (Codex r5 P2, L345 —
  pair consent is revocable post-create, so a broad-tier-only match re-check
  would miss a revoked pair, exactly as on the direct-accept path). Recompute
  is cheap. See §11.

The creation-time decision is **re-derivable**, not snapshotted: the tier is
recomputed from current on-chain liquidity + the actor's stored level at each
read (origination, match re-assert), and the existing
`riskAndTermsConsentFromBoth` bool ([`LibVaipakam.sol:1574`](../../contracts/src/libraries/LibVaipakam.sol#L1574))
remains the per-loan consent marker. **No new per-offer/loan snapshot field is
added** (Codex r3 P3, L322 — §8 deliberately adds only user-level state); if a
true point-in-time historical snapshot of the tier-at-creation is ever wanted
for audit, it's an additive per-loan field tracked as an open item, not part of
this design.

### 5b. Ongoing-action (current NFT owner)

For actions that **create new risk or mutate the position**, the gate is
checked against the **current position-NFT owner** — a transferee does
**not** inherit the creator's future-action consents. The canonical owner
resolver is [`LibERC721.ownerOf(uint256):261`](../../contracts/src/libraries/LibERC721.sol#L261),
and keeper auth already resolves against the current owner via
[`LibAuth.requireKeeperFor(uint8, Loan storage, bool):94`](../../contracts/src/libraries/LibAuth.sol#L94)
(resolves `ownerOf(tokenId)` at
[`:100-101`](../../contracts/src/libraries/LibAuth.sol#L100)). The
ongoing-action sites:

(Risk-gated? column added per Codex r5 P3 L374 — pure close-out EXITS are NOT
gated, only risk-adding actions are; see the D4 note below.)

| Action | Site | Current-owner resolution | Risk-gated? |
|---|---|---|---|
| Refinance (roll into new terms) | [`RefinanceFacet.refinanceLoan:129`](../../contracts/src/facets/RefinanceFacet.sol#L129) | `LibERC721.ownerOf(oldLoan.borrowerTokenId)` ([`:189`](../../contracts/src/facets/RefinanceFacet.sol#L189)) | **YES** (adds/rotates exposure) |
| Obligation transfer | [`PrecloseFacet.transferObligationViaOffer:473`](../../contracts/src/facets/PrecloseFacet.sol#L473) | gate the **incoming obligee** `offer.creator`, not `ownerOf(loan.borrowerTokenId)` ([`:656`](../../contracts/src/facets/PrecloseFacet.sol#L656)) | **YES** (incoming obligee) |
| Preclose-direct | [`PrecloseFacet.precloseDirect:160`](../../contracts/src/facets/PrecloseFacet.sol#L160) | via `requireKeeperFor(INIT_PRECLOSE, …)` ([`:174`](../../contracts/src/facets/PrecloseFacet.sol#L174)) | **NO** — exit (D4) |
| Swap-to-repay-full | [`SwapToRepayFacet.swapToRepayFull:199`](../../contracts/src/facets/SwapToRepayFacet.sol#L199) | `LibAuth.requireBorrowerNftOwner(loan)` ([`:233`](../../contracts/src/facets/SwapToRepayFacet.sol#L233)) | **NO** — exit (D4) |
| Keeper delegation | [`ProfileFacet.setKeeperAccess:315`](../../contracts/src/facets/ProfileFacet.sol#L315) | per-`msg.sender` opt-in; auth resolves to current owner in `requireKeeperFor` | n/a (delegation, not a position action) |

**Obligation transfer gates the INCOMING obligee, not the exiting owner**
(Codex r1 P2, L4Yb): in `transferObligationViaOffer`, `ownerOf(loan.borrowerTokenId)`
is still the *exiting* borrower at the gate point (the NFT migrates only later
in the function), and the exiting borrower is *reducing* exposure. The party
acquiring the position is `offer.creator` (the incoming obligee) — so the tier
gate must evaluate **`offer.creator`**, not the current owner. Gating the
current owner would make Alice's risk-reducing exit depend on Alice's tier,
which is backwards.

**Note on ongoing actions that only *reduce* risk (Codex r1 P2, L4-D4):**
preclose and swap-to-repay *close* exposure, not create it. The gate applies to
actions that **add or rotate into new collateral/principal exposure** —
primarily refinance (rolls into a new offer's terms) and obligation transfer
(gated on the incoming obligee, above). A pure close-out (full preclose,
swap-to-repay-full) is NOT gated for the same reason payouts aren't — it lets
the holder *exit* (gating it would trap a holder who later down-tiered). See
§11 / O4 for the open question on which ongoing actions truly need the
gate vs. which are exits.

### 5c. The critical DoS-avoidance rule (load-bearing)

Consent gates may ONLY sit on actions the holder **initiates themselves**.
They must **NEVER** gate a payout that executes inside a *counterparty's*
transaction:

- The #594 consolidation-to-holder push
  ([`ConsolidationFacet.sol:52/70`](../../contracts/src/facets/ConsolidationFacet.sol#L52))
  and any pay-to-`ownerOf` running during another party's
  [`repayLoan`](../../contracts/src/facets/RepayFacet.sol#L211) /
  `triggerDefault` / `markDefaulted` MUST stay ungated — otherwise a
  Level-0 recipient bricks the counterparty's close-out (the C2
  underflow-DoS class, #667).
- Passive receipt of a position NFT is never blocked. A Level-0 vault CAN
  *receive* illiquid assets via transfer / consolidation — harmless
  (receiving ≠ originating).

**Dividing line:** "does this action create/mutate a loan or obligation,
initiated by the actor?" → consent-check the current owner. "Is this
passive receipt or a payout inside someone else's tx?" → **no check**.

## 6. Position-NFT transfer handling

- Transfer is **not** blocked (bearer instrument stays liquid) — the gate
  lives at action sites, not in `_transfer`/`_update`.
- After transfer, the UI shows "this position contains high-risk/custom
  assets" (informational, no second consent — §250/§676).
- Advanced/ongoing actions require the **new** holder's own risk access /
  pair consent (resolved via `LibERC721.ownerOf` at the action site, §5b).
- Keeper auth already resolves against the current NFT owner
  ([`LibAuth.sol:100-101`](../../contracts/src/libraries/LibAuth.sol#L100))
  — keep that. Ensure no keeper permission silently carries to a new
  holder beyond the new holder's own `keeperAccessEnabled` /
  `approvedKeeperActions` (these are keyed on the owner address, so a
  transfer naturally drops the prior owner's grants).

## 7. Unlock as the phishing chokepoint (hardening)

- The setters **carry the full EIP-712 envelope** (Codex r1 P2, L4Yz):
  `setVaultRiskTier(RiskAccessLevel level, address user, bytes32 consentVersion,
  uint256 nonce, uint256 deadline, bytes sig)` and
  `setIlliquidPairConsent(address lendingAsset,
  uint8 lendingAssetType, uint256 tokenId, address collateralAsset, uint8
  collateralAssetType, uint256 collateralTokenId, address prepayAsset, bool
  consent, address user, bytes32 consentVersion, uint256 nonce, uint256
  deadline, bytes sig)` — **`prepayAsset` is in the signed digest (Codex r9 P2
  L538)** so an NFT-rental pair consent commits to the value-bearing ERC-20 leg
  the key is actually built from (§4); `address(0)` for ERC-20 offers. The
  typed assets (not an opaque `bytes32`, L4Yj) let the wallet render the
  concrete pair, and `user`/`nonce`/`deadline`/`sig` are what make the
  wrong-domain / expired / replay tests enforceable. **`consentVersion` is bound
  INTO the signed digest of BOTH setters (Codex r6 P3 L472 + r7 P2 L487)** — the
  tier-raise (`setVaultRiskTier`) and the pair-consent (`setIlliquidPairConsent`)
  each commit the signer to the exact terms revision they were shown, not just
  stored after the fact. The tier-raise version lands in
  the level-keyed `tierConsentVersion`; the pair-consent version
  lands in `illiquidConsentVersion` (the HARD per-pair map); the soft mid-tier
  stamp uses `midTierAckVersion` — three SEPARATE stores (Codex r7 P2 L600) so a
  version write on one dimension can never alias another. A later terms bump
  detects every stale unlock, and a relayer can't substitute a different version
  than the wallet rendered. They are **deliberate standalone txs**, separable in
  the wallet prompt.
  - **Reject a stale signed version before stamping (Codex r9 P2 L635):** each
    setter REQUIRES the caller's signed `consentVersion == currentRiskTermsVersion`
    and reverts `StaleRiskTermsVersion` otherwise — the wallet rendered, and the
    user signed, a SPECIFIC version; if governance bumped the terms in between,
    the user must re-sign against the new text. **Exemption — revocations skip
    the stale-version check (Codex r10 P2 L577):** lowering a tier or revoking a
    pair consent (`consent == false`, or a down-tier `setVaultRiskTier`) is
    risk-REDUCING, so it must succeed regardless of the current terms version —
    requiring a fresh-terms signature to *withdraw* consent would trap a user
    under stale terms. Only risk-INCREASING grants enforce
    `consentVersion == currentRiskTermsVersion`. Without this check a setter would
    happily stamp `currentRiskTermsVersion` even though the signer approved an
    older revision, defeating the whole version mechanism.
  - **Reject a zero terms version (Codex r10 P2 L714):** `currentRiskTermsVersion`
    defaults to `bytes32(0)` and so do all per-user version maps, so the
    equality check must NOT treat "both zero" as a valid match. `setRiskTermsVersion`
    must be called with a non-zero hash at deploy (and the setters revert
    `RiskTermsVersionUnset` while it is zero); a per-user stored version of
    `bytes32(0)` always means "never consented / stale," never "current." This
    closes the bootstrap hole where an unconfigured terms version would let an
    unsigned/never-consented user satisfy the freshness check by default.
  - **Same-level re-consent must refresh ALL granted levels, not just the top
    (Codex r9 P2 L635 + r10 P2 L585):** `setVaultRiskTier` with `level == current
    level` is a valid call (not a revert) whose purpose is to **re-stamp
    `tierConsentVersion[user][L] = currentRiskTermsVersion` for every granted
    `L` in `[BroadLiquid .. currentLevel]`** after a terms bump — not only the
    top level. A user at `IlliquidCustom` has both the L1 and L2 versions go
    stale on a bump, and a later L1-only offer reads the L1 slot, so refreshing
    only the current level would leave the intermediate slot stale and wedge
    that offer. Otherwise a user already at
    `BroadLiquid`/`IlliquidCustom` could never refresh their consent to the new
    terms (the level isn't changing) and would be wedged — either permanently
    flagged stale or, worse, silently treated as current. Same-level calls skip
    the cooldown re-stamp (no new privilege granted) but always refresh the
    version; pair re-consent (`setIlliquidPairConsent` on an already-consented
    pair) behaves identically for `illiquidConsentVersion`.
- **Bundling caveat (Codex r1 P2, L4Y4):** "never bundleable" is NOT
  contract-enforceable for smart-account (AA/Safe) users, who can batch
  `setVaultRiskTier` + `acceptOffer` into one user-approved op; with the default
  cooldown `0` the accept executes immediately after the unlock. So the
  separability is a UX property for EOAs, and the **`riskAccessUnlockCooldownSec`
  cooldown (RD-3) is the actual on-chain mitigation** if a deploy wants to make a
  phished same-op unlock+use impossible. Documented as a known limitation, not a
  guarantee.
- **EIP-712 typed** so the wallet renders "raising your risk level to
  IlliquidCustom" / "consenting to pair <A>/<B>." Reuse the
  `LibSignedOffer` EIP-712 *machinery pattern* —
  [`domainSeparator():144`](../../contracts/src/libraries/LibSignedOffer.sol#L144),
  [`hashStruct():169`](../../contracts/src/libraries/LibSignedOffer.sol#L169)
  (note the 3-chunk `abi.encode` viaIR workaround),
  [`digest():214`](../../contracts/src/libraries/LibSignedOffer.sol#L214),
  [`verify():236`](../../contracts/src/libraries/LibSignedOffer.sol#L236)
  (ERC-1271-capable via OZ `SignatureChecker`) — but with an
  **unlock-specific domain name** (`"Vaipakam RiskAccess"`) + its own
  typehashes, so a signed-offer or accept signature can't be cross-replayed
  as a risk-unlock and the wallet labels the prompt distinctly. Mirrors
  #662 §4c's domain-separation discipline.
  - **Self-submit caveat (mirrors #662 O5):** ship **self-submit only**, but
    verify via **`SignatureChecker.isValidSignatureNow(user, digest, sig)` with
    `user == msg.sender`** — NOT an `ecrecover(...) == msg.sender` equality
    (Codex r6 P2 L497). A naive `recovered signer == msg.sender` check silently
    excludes AA/Safe accounts (ERC-1271 has no recoverable signer), defeating
    the stated ERC-1271 support; `SignatureChecker` accepts both an EOA ECDSA
    sig and a contract `isValidSignature` reply, and pinning `user == msg.sender`
    keeps the digest bound to one self-submitting account (no cross-ERC-1271
    replay). Relay is deferred — a relayed risk-unlock has no economic front-run
    (no matcher cut), so the only requirement when relay is added is binding the
    tier change to the signed `user`, not `msg.sender`.
  - **Contract-vault unlock path (Codex r3 P2, L437):** protocol contract
    accounts that originate offers via `setLenderIntent` / `matchIntent` (the
    backstop vault, aggregator adapters) do NOT implement `isValidSignature`,
    so the EIP-712 self-submit path can't unlock *their* vault. Two acceptable
    resolutions: (a) those contracts only ever transact blue-chip assets, so
    they never need to opt up (verify per-contract); or (b) expose an
    **owner-gated, signature-free** `setVaultRiskTierFor(account, level)`.
    **`account` MUST be constrained to a registered known-protocol contract,
    not an arbitrary address (Codex r8 P2 L574):** the function requires
    `account.code.length > 0` AND `account ∈ s.protocolManagedVaults` (an
    owner-maintained allow-set of the backstop / adapter vaults) — otherwise an
    owner key could unilaterally raise *any user's* tier and bypass the
    self-sovereign, signed self-submit model that is the whole point of §7. It
    is the narrow escape hatch for non-signing protocol contracts only, never a
    governance override of a real user's vault. Pick per-account at
    implementation; default (a).
    If a contract ever needs `IlliquidCustom`, the escape hatch must ALSO
    expose an owner-gated `setIlliquidPairConsentFor(account, …typed assets)`
    (Codex r4 P3, L461) — raising only the broad tier leaves the second required
    dimension (`illiquidPairConsent`) unsettable for a non-signing contract, so
    the level-2 gate would never pass. Default (a) sidesteps both.
    - **Backstop non-blue-chip fills REQUIRE the escape hatch (Codex r6 P2
      L509):** option (a) is the default ONLY for as long as the backstop / an
      adapter genuinely transacts blue-chip-only. The gate is uniform — it does
      NOT special-case protocol contracts — so the moment the backstop is asked
      to fill a mid-tier or illiquid pair (e.g. absorbing a non-blue-chip
      liquidation it must take onto its book), its vault MUST first be raised via
      the owner-gated `setVaultRiskTierFor` (+ `setIlliquidPairConsentFor` for an
      illiquid pair) by governance, exactly like any other account. There is no
      implicit "contracts bypass the tier gate" path; an unraised backstop vault
      reverts on a non-blue-chip fill, which is the intended fail-safe. So (a) is
      a deployment-time assertion to re-verify whenever the backstop's mandate
      widens — not a permanent exemption.
- **Nonce + deadline** for replay protection / signing-window bound. Reuse
  the per-signer nonce pattern of `signedOfferNonceUsed`
  ([`LibVaipakam.sol:4079`](../../contracts/src/libraries/LibVaipakam.sol#L4079))
  with a dedicated `riskAccessNonceUsed` mapping (don't share the namespace
  — a burned signed-offer nonce must not invalidate a risk-unlock and
  vice-versa).
- Store `{level/pair, block.timestamp, consentVersionHash}` + emit events
  (on-chain auditable consent capture + terms-version trail). The
  `consentVersionHash` lets a later terms revision be detected (the
  `consentVersion` from RD-1's soft-record stamp).
- Allow **ratcheting down** (re-lock) — `setVaultRiskTier(BlueChipOnly)`
  and `setIlliquidPairConsent(…, false)` always succeed (no cooldown on
  *reducing* risk; cooldown only gates *first use after raising*).
  **Re-stamp the cooldown anchor on every RE-RAISE, for every level newly
  granted** (Codex r3 P2 L455 + r4 P2 L478): a raise to level `N` writes
  `unlockedAt[user][L] = block.timestamp` **and**
  `tierConsentVersion[user][L] = currentRiskTermsVersion` for **every** `L` in
  `(oldLevel, N]` — not just level `N` (Codex r4 P2 L478 + r8 P2 L606).
  Otherwise a direct `BlueChipOnly → IlliquidCustom` jump leaves the
  intermediate `BroadLiquid` (level 1) anchor at zero/stale (cooldown bypass)
  AND its version unstamped (a tier-1 offer would read a zero version and never
  flag a stale-terms re-consent). (The per-pair anchor + version re-stamp on
  each pair re-consent likewise.)
- **Cooldown (RD-3):** optional `riskAccessUnlockCooldownSec` (default 0)
  between unlock and first use at that tier, so a phished unlock is
  noticeable/cancellable. Store `unlockedAt` per (user, level) or per
  (user, pairKey); the origination gate checks
  `block.timestamp >= unlockedAt + cfgRiskAccessUnlockCooldownSec()`.

## 8. Storage additions

Appended flat at the **actual current `Storage` tail** (Codex r1 P1, L399 —
`signedOfferNonceUsed` is NOT the tail; the struct continues with signed-offer
transient state, lender intents, backstop/swap-pause/liquidation/consolidation
fields). Locate the true last field before appending. *Pre-live note:* the
retail deploy is pre-live (fresh `DeployDiamond` redeploy, the canonical
policy), so slot placement isn't load-bearing for an in-place upgrade — but
appending at the genuine tail is correct hygiene and keeps the diamond
upgrade-safe regardless.

```solidity
enum RiskAccessLevel { BlueChipOnly, BroadLiquid, IlliquidCustom }       // 0 = safe default

mapping(address => RiskAccessLevel) userRiskAccess;                       // broad tier
mapping(address => mapping(bytes32 => bool)) illiquidPairConsent;          // L2 HARD per-pair illiquid ack
mapping(address => mapping(bytes32 => uint64)) midTierPairAck;             // L1 PASSIVE mid-tier record — written BY THE GATE on first mid-tier use (Codex r6 P3 L584). NOT an explicit consent: stores the auto-stamp TIMESTAMP only (0 = never transacted). SEPARATE map (Codex r2 L475); never reuse illiquidPairConsent for L1.
mapping(address => mapping(bytes32 => uint64)) midTierExplicitAck;         // L1 EXPLICIT strict-mode ack — written ONLY by setMidTierPairAck (Codex r8 P2 L716): strict mode reads THIS map, never the passive midTierPairAck, so a gate auto-stamp can't silently satisfy a strict-mode user's required ack.
mapping(address => mapping(uint256 => bool)) riskAccessNonceUsed;          // EIP-712 anti-replay (dedicated)
mapping(address => mapping(uint8 => uint64)) riskTierUnlockedAt;           // cooldown anchor PER LEVEL (Codex r2 L473): a single ts would let a BroadLiquid→IlliquidCustom raise overwrite the broad unlock
mapping(address => mapping(bytes32 => uint64)) pairConsentUnlockedAt;      // cooldown anchor (per-pair)
mapping(address => mapping(uint8 => bytes32)) tierConsentVersion;          // BROAD-tier raise version (Codex r7 P2 L487/L600): {level → consentVersionHash} set by setVaultRiskTier's digest; level-keyed, separate axis from the per-pair maps
mapping(address => mapping(bytes32 => bytes32)) illiquidConsentVersion;    // HARD per-pair illiquid-consent version (Codex r6 P3 L472 + r7 P2 L600): {pairKey → consentVersionHash}; SEPARATE from the soft map below — a hard-consent pairKey and a soft mid-tier pairKey could otherwise alias and a mid-tier re-stamp would silently bump the illiquid-consent version (or vice-versa)
mapping(address => mapping(bytes32 => bytes32)) midTierAckVersion;         // SOFT mid-tier-use version (Codex r7 P2 L600): {pairKey → consentVersionHash} for the non-blocking midTierPairAck stamp; never shares a slot with illiquidConsentVersion
mapping(address => mapping(bytes32 => bytes32)) midTierExplicitAckVersion; // version of the EXPLICIT strict-mode ack (Codex r9 P2 L670): {pairKey → consentVersionHash} captured by setMidTierPairAck. Strict mode requires this == currentRiskTermsVersion (a FRESH ack), so an old setter-ack goes stale on a terms bump just like the unlock versions.
mapping(address => bool) riskStrictMode;                                   // optional RD-1 flag (default-off)
mapping(address => bool) protocolManagedVaults;                            // owner-maintained allow-set (Codex r8 P2 L574 + r9 P2 L595): the ONLY accounts setVaultRiskTierFor / setIlliquidPairConsentFor may target. Maintained via admin addProtocolManagedVault / removeProtocolManagedVault (§9). Empty by default; backstop/adapter vaults added at deploy.
bool saleVehicleCreate;                                                    // TRANSIENT injection flag (Codex r7 P2 L338 + r8 P2 L640): set by the lender-sale flow before its cross-facet createOffer hop, read by the create gate to skip the tier check, cleared same-tx. MUST be false at rest (like matchOverride.active / signedOfferAcceptor).
bytes32 currentRiskTermsVersion;                                           // AUTHORITATIVE global risk-terms version (Codex r8 P2 L716): admin/governance-set hash of the current risk-disclosure text via setRiskTermsVersion (§9). The gate stamps THIS into the per-user version maps; the setters REQUIRE the caller's signed consentVersion == this (reject stale, Codex r9 P2 L635) before stamping; bumping it flags every prior unlock/stamp as stale. Single source of "currentTermsVersion".
uint32 riskAccessUnlockCooldownSec;                                        // TOP-LEVEL field, NOT in protocolCfg (see below); default 0
```

All flat primitives/mappings — no nested structs (viaIR ceiling). The cooldown
is a **top-level `Storage` field, NOT inside `protocolCfg`** (Codex r1 P1,
L411): `ProtocolConfig` is embedded before many live top-level fields and the
code explicitly warns that appending to it shifts subsequent slots. A
range-bounded `setRiskAccessUnlockCooldown` setter + a `cfgRiskAccessUnlockCooldownSec()`
read-accessor mirror the existing bounded-knob pattern of
[`cfgTier3SizePad():5008`](../../contracts/src/libraries/LibVaipakam.sol#L5008).

## 9. Surface delta (which facets change)

- **New facet — `RiskAccessFacet`** (or fold into `ProfileFacet` if size
  permits; `ProfileFacet` already owns `setKeeperAccess` self-config —
  natural home, but check EIP-170 after adding the EIP-712 verify path):
  `setVaultRiskTier`, `setIlliquidPairConsent`, **`setRiskStrictMode(bool)`**
  (the user-facing opt-IN to L1 strict mode — present iff `riskStrictMode`
  ships; without it the flag is permanently false and strict mode is dead,
  Codex r4 P3 L527; **the OFF direction is risk-INCREASING so it carries the
  same EIP-712 signed envelope as the unlock setters — `setRiskStrictMode(bool
  enabled, address user, bytes32 consentVersion, uint256 nonce, uint256
  deadline, bytes sig)` — not a plain setter (Codex r9 P2 L692)**; turning
  strict mode ON may stay a plain self-call. **Disabling strict mode is ALSO
  subject to `riskAccessUnlockCooldownSec` (Codex r10 P2 L737)** — it's a
  risk-increasing privilege change, so on a non-zero deploy cooldown the
  same-op disable+exploit window is closed exactly like a tier raise), and
  **`setMidTierPairAck`** (the L1 EXPLICIT strict-mode ack setter; writes
  `midTierExplicitAck` + `midTierExplicitAckVersion`, NOT the passive
  `midTierPairAck` the gate auto-stamps, and never `illiquidPairConsent` —
  Codex r3 P3 L499 + r9 P2 L695. **When `riskStrictMode` is on this ack
  authorizes a real origination privilege, so it carries the full EIP-712
  signed envelope (assets, user, consentVersion, nonce, deadline, sig) — Codex
  r10 P2 L741 — not a plain self-call**, matching the other privilege-granting
  setters),
  the **admin-only** `setRiskAccessUnlockCooldown`, **`setRiskTermsVersion(bytes32)`**
  (admin/governance-only — bumps `currentRiskTermsVersion`, the single act that
  invalidates every prior unlock/ack on a terms revision, Codex r9 P2 L673), and
  **`addProtocolManagedVault(address)` / `removeProtocolManagedVault(address)`**
  (admin-only — maintain the `protocolManagedVaults` allow-set the escape-hatch
  setters check, Codex r9 P2 L595), and views. All asset-pair
  APIs take the **raw typed assets** — `(lendingAsset, lendingAssetType,
  tokenId, collateralAsset, collateralAssetType, collateralTokenId,
  prepayAsset)` — NOT two bare addresses (Codex r2 L498). **`prepayAsset` is
  included (Codex r8 P2 L665)** so an NFT-rental pair key resolves to the
  value-bearing ERC-20 leg (§4) rather than the rented NFT; it is `address(0)`
  for ERC-20 offers and the key-builder ignores it there. With these the helper
  recomputes the tokenId-inclusive pair key + the wallet can render the concrete
  pair:
  `getVaultRiskTier(address)`, `getIlliquidPairConsent(address, …typed assets)`,
  `requiredLevelForAssets(address, …typed assets)`.
- **New internal library — `LibRiskAccess`** holding the gate helper
  `_assertOriginationAllowed(actor, …typed assets)`,
  `_assertPairConsented(actor, …typed assets)`, and `pairKeyFor(…typed assets)`
  (folds tokenIds + asset types). Call sites invoke the library; logic lives in
  one place (the `_assertNotSanctioned`/`LibAuth` shared-gate pattern).
- **Modified (additive checks, no signature change to existing flows):**
  - **All offer-creation entries** — `createOffer`, `createOfferWithPermit`,
    `createOfferInternal`, the signed-offer materializers — gate against the
    **resolved `creator`** (not `msg.sender`; Codex r2 L504), at the shared
    create chokepoint.
  - [`OfferAcceptFacet._acceptOffer`](../../contracts/src/facets/OfferAcceptFacet.sol#L517)
    — gate the resolved acceptor AND re-assert the offer creator's tier
    (composes with #662's binding at the same site).
  - **Claim entries** — `claimAsLender`, `claimAsBorrower`, **and
    `claimAsLenderWithRetry`** (Codex r2 L510 — it forwards to the same
    `_claimAsLenderImpl`, so gating only the first two leaves a hole): one-time
    pair-ack gate **for EVERY illiquid asset a claim flow withdraws to the
    holder** — not just the singular claimed collateral (Codex r4 P3, L552):
    `claimAsBorrower` can also pay an `extraLienedAsset`, and `claimAsLender`
    can pay held funds / return residual collateral, so each such asset's pair
    must be acked when it classifies illiquid (RD-2). Self-resolvable in-flow.
  - Ongoing risk-adding actions: refinance (current NFT owner);
    **obligation-transfer gated on the INCOMING obligee `offer.creator`**, not
    the exiting owner (Codex r2 L512). Pure close-out exits (preclose-direct,
    swap-to-repay-full) NOT gated (D4).
    - **Refinance must gate BEFORE the replacement loan exists (Codex r6 P2
      L615):** the legacy borrower-direct refinance path accepts a *borrower
      offer* first — which already initiates the new loan via the normal accept
      chokepoint — and only then links it to the old loan. So a refinance gate
      hung on the post-link "refinance" action fires too late (the risk-adding
      loan is already open). The gate therefore lives at the **same origination
      chokepoint as any other accept** (the borrower-offer accept that
      *originates* the refi), evaluated against the party taking on the new
      obligation, so the pair tier is checked before the replacement loan is
      created — not as a separate post-hoc refinance hook. The matched-refinance
      path (#595) gates at its own match origination identically.
  - **Strict-mode ENFORCEMENT (Codex r5 P3 L552 — not just the setter):** when
    `riskStrictMode[actor] == true`, the origination gate additionally requires
    a fresh **`midTierExplicitAck`** (the setter-only map, NOT the passive
    `midTierPairAck` the gate auto-stamps — Codex r8 P2 L716) for the
    **mid-tier (L1)** pair too — i.e. a BroadLiquid user in strict mode must
    have called `setMidTierPairAck` for the pair, not merely have transacted it
    once (which only writes the passive record). Reading the passive map here
    would let the gate's own first-use auto-stamp satisfy the strict-mode
    requirement, defeating it. Without strict mode, L1 needs no per-pair ack
    (the passive record is non-blocking). This is what makes the
    `setRiskStrictMode` flag actually do something.
    - **Soft mid-tier stamp is written BY the gate, not only by the setter
      (Codex r6 P3 L584):** RD-1's non-blocking record is the gate's
      responsibility, not an optional user call. On the first mid-tier (L1)
      origination for a given `pairKey`, the origination gate itself writes
      `midTierPairAck[user][pairKey] = block.timestamp` (and
      `midTierAckVersion[user][pairKey] = currentRiskTermsVersion`) if
      absent — it never reverts a non-strict L1 user, it just records that this
      user transacted this mid-tier pair (for later analytics / a future
      strict-mode retro-ack / consent-version drift detection). `setMidTierPairAck`
      remains the *explicit* path (and the strict-mode prerequisite), but the
      passive stamp guarantees the record exists for every mid-tier user even
      when strict mode is off, so RD-1's "stamp first mid-tier use" is satisfied
      structurally rather than relying on the user remembering to call the setter.
- **Explicitly NOT modified (must stay ungated — §5c):**
  `ConsolidationFacet`, the push-payout paths inside `repayLoan` /
  `markDefaulted` / `triggerDefault`, position-NFT `_transfer`.
- **Match path:** enforce at create-time per side (D3); the matcher's own
  vault is not gated.

## 10. ABI / deploy-sanity / frontend / spec impact

- **ABI re-export + deploy-sanity:** new external selectors — `setVaultRiskTier`,
  `setIlliquidPairConsent`, **`setRiskStrictMode`** + **`setMidTierPairAck`** (iff
  riskStrictMode ships; Codex r5 P3 L596), **`setRiskAccessUnlockCooldown`**
  (admin-only RD-3 tunable; Codex r2 L527), **`setRiskTermsVersion`** +
  **`addProtocolManagedVault` / `removeProtocolManagedVault`** (admin-only;
  Codex r10 P2 L830 — the risk-admin selectors introduced in §8/§9 must be in
  the deploy/ABI coverage too, not just the user-facing setters), the
  contract-account escape-hatch setters (`setVaultRiskTierFor` /
  `setIlliquidPairConsentFor`), and the views — on the new facet (or
  `ProfileFacet`). Per CLAUDE.md: add the facet to
  `DiamondFacetNames.cutFacetNames()`, add its `_get<Facet>Selectors()` to
  `SelectorCoverageTest._populateRoutedSet()` + the `DeployDiamond` /
  `HelperTest` selector lists, append to `exportFrontendAbis.sh`'s
  `FACETS=(...)` and the `packages/contracts/src/abis/index.ts` barrel.
  New custom **errors** (`RiskAccessTooLow`, `IlliquidPairNotConsented`,
  `RiskUnlockCooldownActive`, `RiskAccessSignatureInvalid`,
  `RiskAccessDeadlineExpired`, `StaleRiskTermsVersion`, `RiskTermsVersionUnset`,
  `NotProtocolManagedVault`) are in the ABI → re-export catches them
  (per [[abi-sync-after-contract-changes]]).
- **Indexer:** the new consent-capture events
  (`VaultRiskTierSet`, `IlliquidPairConsented`, `MidTierPairUsed` soft
  stamp) are `state-change/risk-config`-class but are *not* loan/offer
  mutations, so they don't trip the indexer event-coverage guardrail;
  add handlers if the dashboard surfaces the consent trail (optional).
- **Frontend (`apps/defi`):** a self-service "Risk access" settings
  surface (the spending-limit analog) calling the EIP-712 setters; the
  accept/create flows show a derived "this offer needs Level N — raise
  your access" prompt that *links to the standalone unlock tx* (never
  bundled). The single Risk-and-Terms consent checkbox is unchanged
  (§250/§676 — no second consent).
- **FunctionalSpec update (same PR as code):**
  `docs/FunctionalSpecs/ProjectDetailsREADME.md` — the §233/§241/§250
  consent region gains an **intended-behaviour** description of the
  self-sovereign progressive risk-access floor: default BlueChipOnly,
  explicit opt-up, per-pair illiquid ack, the current-owner ongoing-action
  rule, and the load-bearing "never gate a counterparty-tx payout" rule.
  §234's on-chain liquidity-precedence already establishes derived
  classification; this extends it to the *access* dimension. Note it is a
  *safety rail*, not KYC/curation (consistent with the retail-deploy
  prohibitions). Add the new test refs (§12) to the §2219/§2248 test
  inventory. **Per the FunctionalSpec rule, this is sourced from the
  intent in this design doc, not transcribed from the code.**

## 11. Deltas — where the code does NOT support the card as written

Highest-value output. None are blockers; all are citation/placement
corrections the implementation must absorb:

- **D1 — selector name + line.** The card says
  `effectiveLiquidityTier == 3` and cites `OracleFacet.sol:1755-1757`. The
  selector is `getEffectiveLiquidityTier`
  ([`OracleFacet.sol:1225`](../../contracts/src/facets/OracleFacet.sol#L1225));
  the $5M/65% constant lives at
  [`LibVaipakam.sol:136`](../../contracts/src/libraries/LibVaipakam.sol#L136),
  not `OracleFacet.sol:1755-1757` (that range is `_liquidityTier`'s
  doc-comment). The *values* are correct; the references need fixing.
- **D2 — pairKey is a NEW pattern, not a reuse.** No composite-keccak pair
  key exists in the codebase; precedents are *nested* address-mappings and
  string-hashed country pairs (§4). The card's `keccak256(abi.encode(...))`
  composite is sound but novel — flag it as setting a precedent, use
  `abi.encode` (not packed), and keep asset-type discriminators to avoid
  ERC-20/ERC-721 address aliasing.
- **D3 — `matchOffers` is the wrong enforcement point.** The card lists
  `matchOffers` as an origination enforcement site, but `matchOffers` is a
  **permissionless third party**; gating *its* vault punishes the matcher.
  Enforce the tier on **each paired offer's creator at create-time**; at
  match, re-assert each offer still satisfies its creator's recorded tier
  **and, for an `IlliquidCustom` pair, the still-held per-pair
  `illiquidPairConsent`** (Codex r6 P2 L761 — both dimensions, since pair
  consent is revocable; consistent with O5 and the §5a direct path). This
  mirrors #662's
  finding that the matcher carries no `AcceptTerms` and safety rests on
  both sides being self-authored.
- **D4 — pure close-outs may not need the ongoing gate.** Preclose-direct
  and swap-to-repay-full *reduce* the actor's exposure (they exit a
  position). Gating an exit risks trapping a holder who later down-tiered.
  Recommend gating only **risk-*adding*** ongoing actions (refinance roll,
  obligation transfer to a new obligee); treat full close-outs like
  payouts (ungated). Open as O4.

## 12. Test plan

- **Phishing A/B structurally blocked:** a default Level-0 (`BlueChipOnly`)
  victim cannot `acceptOffer` a dummy-illiquid offer even with a hardcoded
  consent bool — reverts `RiskAccessTooLow` *before* any value moves
  (complements #662's `IlliquidAssetNotAcknowledged`).
- **DoS-avoidance regression (acceptance-criterion):** a Level-0 holder
  *receiving* illiquid collateral on a counterparty's default/repay does
  NOT revert the close-out (consolidation/push-payout ungated). Assert the
  counterparty's `repayLoan` / `markDefaulted` succeeds.
- **Pull-claim ack:** a Level-0 transferee attempting `claimAsLender` /
  `claimAsBorrower` of unusual collateral must ack the pair first, then
  completes the claim after ack in the same flow — no value trapped.
- **Transferee non-inheritance:** after position-NFT transfer, the new
  holder's refinance/transfer-obligation requires *their own* tier/pair
  consent; the creator's prior consent does not carry.
- **Tier-3 happy path:** a Level-0 vault transacts a tier-3 asset with no
  opt-up; a tier-1 asset reverts until `setVaultRiskTier(BroadLiquid)`.
- **Derived-classification, no curation:** changing only the on-chain tier
  signal (e.g. a keeper demotion via `setKeeperTier`, or natural depth loss)
  flips the required level without any governance list write. (NOT `pauseAsset`
  — that blocks creation via `requireAssetNotPaused` and does not change
  `getEffectiveLiquidityTier`; Codex r4 P3 L655.)
- **EIP-712 unlock:** valid typed `setVaultRiskTier` / `setIlliquidPairConsent`
  succeed; wrong-domain (signed-offer / accept) signature rejected
  (`RiskAccessSignatureInvalid`); expired deadline rejected; replayed nonce
  rejected.
- **Cooldown:** with `riskAccessUnlockCooldownSec > 0`, first use before
  the window reverts `RiskUnlockCooldownActive`; with default 0, unlock →
  immediate use succeeds (no behavioural change).
- **Ratchet-down:** re-lock to BlueChipOnly / revoke pair consent always
  succeeds, no cooldown on reducing risk.
- **Match path (D3):** two self-authored offers whose creators each
  satisfy their tier match successfully; a matcher with a Level-0 vault is
  NOT blocked.

## 13. Open questions for review

- **O1 — facet placement:** new `RiskAccessFacet` vs. fold into
  `ProfileFacet`? `ProfileFacet` is the natural home (self-config like
  `setKeeperAccess`) but the EIP-712 verify path adds bytecode — check
  EIP-170 before deciding.
- **O2 — pairKey precedent (D2):** ratify the new composite-keccak key
  shape (`abi.encode(chainId, lend, lendType, tokenId, coll, collType,
  collTokenId)` — token IDs are **load-bearing** per §4, do NOT drop them;
  Codex r3 L644), or prefer
  a nested `mapping(address => mapping(address => mapping(bytes32 => bool)))`
  to stay closer to existing nested precedents? (Composite is one storage
  word, cleaner; nested matches house style.)
- **O3 — RD-1 sub-options scope:** ship the L1 *strict mode* + *notional-
  threshold gate* in this PR, or defer? (They are additive flags; recommend
  ship `riskStrictMode` flag, defer the notional-threshold gate which needs
  a USD-notional read at origination.)
- **O4 — which ongoing actions to gate (D4):** gate only risk-*adding*
  actions (refinance roll, obligation transfer), treating full close-outs
  (preclose-direct, swap-to-repay-full) as ungated exits? Confirm.
- **O5 — match re-assertion (D3):** at `matchOffers`, re-assert each
  offer's creator still satisfies the recorded tier **AND, for an
  `IlliquidCustom` pair, still holds the per-pair `illiquidPairConsent`**
  (Codex r6 P2 L761 — pair consent is revocable post-create, so a tier-only
  re-check would miss a revoked pair; this mirrors the §5a direct-accept and
  stale-offer re-assertion exactly), or trust the create-time stamp?
  (Recommend re-assert **both dimensions**; cheap view.)
- **O6 — WETH / default-route tiering (Codex r5 P2 L264, tracked here per
  r10 P2 L329):** resolve how WETH itself reaches tier-3 and how a
  WETH-only effective route set pins a thin asset to tier-0 (§4) before the
  tier-3 `BlueChipOnly` default ships — pick (a) numeraire special-case,
  (b) guaranteed non-WETH PAA route, or (c) `tier==3 OR asset ∈ reference set`.
  This is the one **blocker** open question (the default gate is unusable until
  resolved); O1–O5 are ratification choices, O6 is a must-fix-before-ship.

## 14. Relationship to #662

Layered, not either/or:

- **#662** ([`OfferAcceptTermBindingDesign.md`](OfferAcceptTermBindingDesign.md))
  binds `acceptOffer` to the *specific terms* via an EIP-712 `AcceptTerms`
  — prevents a malicious UI from swapping terms within a tier the user
  already trusts. Covers *all* offer types incl. liquid term-swaps.
- **#671** (this doc) adds the *structural floor* — default
  blue-chip-only, self-sovereign opt-up to broader/illiquid. Reduces
  accidental/structural exposure to exotic assets for any wallet that
  hasn't deliberately opted up.

**Sequence #662 first** (broader — also covers liquid term-swaps), then
layer tiers as the structural floor. The two compose at one site
(`_acceptOffer`, [`:517`](../../contracts/src/facets/OfferAcceptFacet.sol#L517)):
#662's term-binding and #671's tier gate both evaluate against the
resolved acceptor before any value moves.
