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

**Grounded:** the HF≥1.5 floor at loan init is real and unconditional for
liquid assets — `_maybeRunInitialRiskGates` only *skips* `_checkInitialLtvAndHf`
on the **`!bothLiquid && mutualIlliquidConsent`** branch
([`LoanFacet.sol:474-487`](../../contracts/src/facets/LoanFacet.sol#L474)).
So any asset that classifies `Liquid` (tier ≥ 1) is already protected by
the quantitative gate; the categorical-loss path is reachable only via
the illiquid bypass. The card's quantitative-vs-categorical distinction
is **code-accurate**. The two L1 sub-options (user-elected *strict mode*
per-vault flag → require per-pair acks even for mid-tier; *notional-
threshold gate* → large mid-tier loans require a fresh pair ack) are
additive flags; both are optional and default-off (see §11 / O3).

### RD-2 — Plain pull-claim of unusual collateral is GATED with a one-time pair-ack

The card: applies ONLY to the holder-initiated pull-claim
(`claimAsLender` / `claimAsBorrower`); the holder satisfies the ack in the
same flow so no value is trapped. **Push-payouts / #594 consolidation that
run inside a counterparty's tx remain UNGATED** (gating them would brick
the counterparty's close-out — the #667/C2 DoS class). The transferee
(new owner) must ack before claiming.

**Grounded:**
- Pull-claim entries: [`ClaimFacet.claimAsLender(uint256):205`](../../contracts/src/facets/ClaimFacet.sol#L205)
  and [`ClaimFacet.claimAsBorrower(uint256):990`](../../contracts/src/facets/ClaimFacet.sol#L990).
  Both resolve the **current** NFT holder — `claimAsLender` via
  `IERC721(address(this)).ownerOf(loan.lenderTokenId)`
  ([`ClaimFacet.sol:344`](../../contracts/src/facets/ClaimFacet.sol#L344)),
  `claimAsBorrower` via `LibAuth.requireBorrowerNftOwner(loan)`
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

**Pair-consent setter takes the RAW typed assets, not an opaque `bytes32`**
(Codex r1 P2, L4Yj): `setIlliquidPairConsent(lendingAsset, lendingAssetType,
tokenId, collateralAsset, collateralAssetType, collateralTokenId, …sig)` and
computes the key on-chain. Passing a pre-hashed `bytes32 pairKey` would make
the EIP-712 prompt unrenderable (the wallet must show the concrete `<A>/<B>`
pair the user is unlocking) and prevent the contract from validating the key.

### Asset → required level (derived)

| Vault level (default = **0 BlueChipOnly**) | Asset allowed (derived) |
|---|---|
| **0 BlueChipOnly** (default) | `getEffectiveLiquidityTier == 3` (deep, keeper-promoted) |
| **1 BroadLiquid** (explicit opt-in) | `getEffectiveLiquidityTier >= 1` (oracle + protocol risk params still apply) |
| **2 IlliquidCustom** (strongest opt-in) | any, incl. tier 0 / `checkLiquidity == Illiquid` — **and** `illiquidPairConsent[pairKey] == true` |

The gate evaluates against `min(tier(lendingAsset), tier(collateralAsset))`
— **the RISKIER leg governs** (Codex r1 P1, L235). The tier scale is inverted
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
  before binding — not just the acceptor. **For an `IlliquidCustom` pair, also
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
  both offers' creators at create-time, and at match assert only that each
  *paired offer* still satisfies its creator's recorded tier (recompute is
  cheap, defends against a post-create re-lock). See §11.

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

| Action | Site | Current-owner resolution |
|---|---|---|
| Refinance | [`RefinanceFacet.refinanceLoan:129`](../../contracts/src/facets/RefinanceFacet.sol#L129) | `LibERC721.ownerOf(oldLoan.borrowerTokenId)` ([`:189`](../../contracts/src/facets/RefinanceFacet.sol#L189)) |
| Preclose | [`PrecloseFacet.precloseDirect:160`](../../contracts/src/facets/PrecloseFacet.sol#L160) | via `requireKeeperFor(INIT_PRECLOSE, …)` ([`:174`](../../contracts/src/facets/PrecloseFacet.sol#L174)) |
| Obligation transfer | [`PrecloseFacet.transferObligationViaOffer:473`](../../contracts/src/facets/PrecloseFacet.sol#L473) | `LibERC721.ownerOf(loan.borrowerTokenId)` ([`:656`](../../contracts/src/facets/PrecloseFacet.sol#L656)) |
| Swap-to-repay | [`SwapToRepayFacet.swapToRepayFull:199`](../../contracts/src/facets/SwapToRepayFacet.sol#L199) | `LibAuth.requireBorrowerNftOwner(loan)` ([`:233`](../../contracts/src/facets/SwapToRepayFacet.sol#L233)) |
| Keeper delegation | [`ProfileFacet.setKeeperAccess:315`](../../contracts/src/facets/ProfileFacet.sol#L315) | per-`msg.sender` opt-in; auth resolves to current owner in `requireKeeperFor` |

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
  `setVaultRiskTier(RiskAccessLevel level, address user, uint256 nonce,
  uint256 deadline, bytes sig)` and `setIlliquidPairConsent(address lendingAsset,
  uint8 lendingAssetType, uint256 tokenId, address collateralAsset, uint8
  collateralAssetType, uint256 collateralTokenId, bool consent, address user,
  uint256 nonce, uint256 deadline, bytes sig)` — the typed assets (not an opaque
  `bytes32`, L4Yj) let the wallet render the concrete pair, and `user`/`nonce`/
  `deadline`/`sig` are what make the wrong-domain / expired / replay tests
  enforceable. They are **deliberate standalone txs**, separable in the wallet
  prompt.
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
  - **Self-submit caveat (mirrors #662 O5):** ship **self-submit only**
    (`msg.sender == recovered signer == the account whose tier changes`),
    so the digest binds to one account (no cross-ERC-1271 replay). Relay is
    deferred — a relayed risk-unlock has no economic front-run (no matcher
    cut), so the only requirement when relay is added is binding the tier
    change to the signed `user`, not `msg.sender`.
  - **Contract-vault unlock path (Codex r3 P2, L437):** protocol contract
    accounts that originate offers via `setLenderIntent` / `matchIntent` (the
    backstop vault, aggregator adapters) do NOT implement `isValidSignature`,
    so the EIP-712 self-submit path can't unlock *their* vault. Two acceptable
    resolutions: (a) those contracts only ever transact blue-chip assets, so
    they never need to opt up (verify per-contract); or (b) expose an
    **owner-gated, signature-free** `setVaultRiskTierFor(account, level)`
    callable only by the contract's own owner/governance, for these
    known-protocol accounts. Pick per-account at implementation; default (a).
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
  **Re-stamp the cooldown anchor on every RE-RAISE** (Codex r3 P2, L455):
  each raise writes `unlockedAt[user][level] = block.timestamp` (and the
  per-pair anchor on a pair re-consent). Otherwise a stale, already-aged
  timestamp from an earlier opt-up would let a revoke→re-raise skip the
  cooldown entirely.
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
mapping(address => mapping(bytes32 => uint64)) midTierPairAck;             // L1 SOFT mid-tier ack — SEPARATE map (Codex r2 L475); stores the ack TIMESTAMP not a bool (Codex r3 P3 L473: RD-1 wants {pairKey, timestamp, consentVersion}; 0 = not acked), version in riskConsentVersion. Never reuse illiquidPairConsent for L1 acks.
mapping(address => mapping(uint256 => bool)) riskAccessNonceUsed;          // EIP-712 anti-replay (dedicated)
mapping(address => mapping(uint8 => uint64)) riskTierUnlockedAt;           // cooldown anchor PER LEVEL (Codex r2 L473): a single ts would let a BroadLiquid→IlliquidCustom raise overwrite the broad unlock
mapping(address => mapping(bytes32 => uint64)) pairConsentUnlockedAt;      // cooldown anchor (per-pair)
mapping(address => mapping(bytes32 => bytes32)) riskConsentVersion;        // {level/pair → consentVersionHash} (Codex r2 P3 L476): detect later terms-revisions
mapping(address => bool) riskStrictMode;                                   // optional RD-1 flag (default-off)
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
  `setVaultRiskTier`, `setIlliquidPairConsent`, **`setMidTierPairAck`** (the L1
  strict-mode soft-ack setter, present iff `riskStrictMode` ships — Codex r3 P3
  L499; writes the `midTierPairAck` timestamp map, never `illiquidPairConsent`),
  the admin-only `setRiskAccessUnlockCooldown`, and views. All asset-pair
  APIs take the **raw typed assets** — `(lendingAsset, lendingAssetType,
  tokenId, collateralAsset, collateralAssetType, collateralTokenId)` — NOT two
  bare addresses (Codex r2 L498), so they can recompute the tokenId-inclusive
  pair key + the wallet can render the concrete pair:
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
    pair-ack gate **only** when the claimed collateral classifies illiquid
    (RD-2). Self-resolvable in-flow.
  - Ongoing risk-adding actions: refinance (current NFT owner);
    **obligation-transfer gated on the INCOMING obligee `offer.creator`**, not
    the exiting owner (Codex r2 L512). Pure close-out exits (preclose-direct,
    swap-to-repay-full) NOT gated (D4).
- **Explicitly NOT modified (must stay ungated — §5c):**
  `ConsolidationFacet`, the push-payout paths inside `repayLoan` /
  `markDefaulted` / `triggerDefault`, position-NFT `_transfer`.
- **Match path:** enforce at create-time per side (D3); the matcher's own
  vault is not gated.

## 10. ABI / deploy-sanity / frontend / spec impact

- **ABI re-export + deploy-sanity:** new external selectors
  (`setVaultRiskTier`, `setIlliquidPairConsent`, **`setRiskAccessUnlockCooldown`**
  — the RD-3 per-deploy tunable; Codex r2 L527 — and the views) on the new
  facet (or `ProfileFacet`). Per CLAUDE.md: add the facet to
  `DiamondFacetNames.cutFacetNames()`, add its `_get<Facet>Selectors()` to
  `SelectorCoverageTest._populateRoutedSet()` + the `DeployDiamond` /
  `HelperTest` selector lists, append to `exportFrontendAbis.sh`'s
  `FACETS=(...)` and the `packages/contracts/src/abis/index.ts` barrel.
  New custom **errors** (`RiskAccessTooLow`, `IlliquidPairNotConsented`,
  `RiskUnlockCooldownActive`, `RiskAccessSignatureInvalid`,
  `RiskAccessDeadlineExpired`) are in the ABI → re-export catches them
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
  match, optionally re-assert each offer still satisfies its creator's
  recorded tier (defends a post-create re-lock). This mirrors #662's
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
- **Derived-classification, no curation:** changing only on-chain liquidity
  (e.g. pausing the asset → tier 0) flips the required level without any
  governance list write.
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
  offer's creator still satisfies the recorded tier (defends post-create
  re-lock), or trust the create-time stamp? (Recommend re-assert; cheap
  view.)

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
