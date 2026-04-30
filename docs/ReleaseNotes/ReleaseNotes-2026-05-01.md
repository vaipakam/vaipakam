# Release Notes — 2026-05-01

Functional record of work delivered on 2026-05-01, written as
plain-English user-facing / operator-facing descriptions — no
code. Continues from
[`ReleaseNotes-2026-04-30.md`](./ReleaseNotes-2026-04-30.md).

Coverage at a glance: **matcher kickback BPS made
governance-tunable** (the 1% slice of LIF the Range Orders
matching path pays third-party bots is now an admin/governance
config knob, not a hard-coded constant); **ABI re-export sync**
to both the keeper-bot and the frontend after the contract
changes; and **OfferFacet split for EIP-170** so the contract
can deploy on real chains where the 24576-byte runtime-bytecode
ceiling is enforced (Range Orders Phase 1 pushed the facet to
~28KB; mainnet had been blocked behind anvil's
`--code-size-limit 50000` override).

## Matcher kickback BPS — governance-tunable

The Range Orders matcher fee — the slice of any LIF that flows
to treasury, which is paid out to the third-party bot/relayer
that submitted the match — was a hard-coded `100` BPS (1%) at
the contract level. The original Phase 1 plan called the fee
"economics revisit" a Phase 2 item with the explicit note:
*"dial up to 5-10% of LIF if needed to attract community bot
operators."* The constant made that revisit a contract upgrade.

Today's change moves it into governance config:

- New `ProtocolConfig.lifMatcherFeeBps` (`uint16`) field. Default
  zero means "use the library default" (`LIF_MATCHER_FEE_BPS =
  100`); any non-zero value overrides.
- New accessor `LibVaipakam.cfgLifMatcherFeeBps()` follows the
  same fallback shape as the dozen other governance-tuned BPS
  configs in the codebase (`cfgTreasuryFeeBps`,
  `cfgLoanInitiationFeeBps`, etc.).
- New admin setter `ConfigFacet.setLifMatcherFeeBps(uint16)`
  with a `MAX_FEE_BPS = 5000` (50%) sanity cap so a misfire
  can't starve treasury. Emits `LifMatcherFeeBpsSet(newBps)`
  for indexers.
- The field is included in `getProtocolConfigBundle`'s return
  tuple so the frontend's `useProtocolConfig` hook surfaces it
  without an extra RPC.
- `LibOfferMatch.matcherShareOf` switched from `pure` to `view`
  and now reads `cfgLifMatcherFeeBps()` instead of the constant.
  Both callers (synchronous lender-asset path in
  `OfferFacet._acceptOffer` and the deferred VPFI path in
  `LibVPFIDiscount.settleBorrowerLifProper` / `forfeitBorrowerLif`)
  pick up the live value automatically.
- `OfferFacet.matchOffers`'s synchronous `OfferMatched` event
  computation was also updated to read from cfg, so the event's
  `lifMatcherFee` field reflects the current governance setting
  not a stale constant.

Frontend `BundleTuple` + `ProtocolConfig` interface extended.
`BootstrapAnvil`'s post-flip readback destructure extended.
`ConfigFacetTest`'s bundle destructure extended. Selector cut
added to `DeployDiamond._getConfigSelectors` (index 20) and
`HelperTest.getConfigFacetSelectors` so fresh deploys + tests
pick up the new setter.

Governance path: ADMIN_ROLE today, transferable to a Timelock
at any time — same shape as every other governance-tuned knob.
No contract change needed when ADMIN_ROLE rotates to a DAO.

Verification: `forge test --no-match-path "test/invariants/*"` →
**1402/1407 passing, 0 failed, 5 skipped** at the same baseline
as before the change.

## Permissioning model for Range Orders matching

Discussion landed on the question of whether to ship the
matching path as permissioned-now-permissionless-later (gate to
our reference bot during the bake, flip a flag to open it up
later). After review, **shipped permissionless** — the existing
implementation has zero caller restrictions on `matchOffers`,
matching the well-precedented model already in place for
liquidations. Reasons:

1. **Composability is the win.** The whole point of the 1%
   matcher kickback economic incentive is to attract a market
   of community bot operators. A whitelist nukes that market.
2. **Audit-friendlier shape.** Adding caller-gating expands the
   security model from "anyone can call this without harm"
   (which is robustly true: matchOffers can't steal funds, only
   facilitate a match between two consenting offers) to
   "whitelist must be defended" — strictly worse audit shape.
3. **You can still win the matching race during the bake**
   without a gate: faster bot poll interval, private mempool
   (Flashbots Protect / MEV Blocker), pre-funded gas reserves.
   Excluding others is the wrong tool for "we want to be
   first."
4. **Already permissionless** — adding the gate would be
   feature-creep we'd have to remove.

If a critical bug ever forces a controlled rollback, the
existing `pause()` lever is the actual emergency mechanism — it
freezes every state-changing path, not just matching, which is
the right granularity for an incident.

## ABI sync — keeper-bot + frontend

Per the project's standing convention (every contract-touching
PR ships with a fresh ABI re-export), both consumers were
synced after the lifMatcherFeeBps change:

- Keeper-bot: `bash contracts/script/exportAbis.sh
  KEEPER_BOT_DIR=…` regenerated the four facet JSONs
  (`MetricsFacet`, `RiskFacet`, `LoanFacet`, `OfferFacet`) plus
  the `_source.json` provenance stamp pointing at
  `vaipakam@9e9683d`. Bot's `npm run typecheck` clean.
- Frontend: `bash contracts/script/exportFrontendAbis.sh`
  regenerated all 28 per-facet JSONs (the full Diamond surface
  the frontend imports). Frontend's `tsc -b --noEmit` clean.

No selector deltas in either sync that affect existing
consumers — the only ABI change was the `getProtocolConfigBundle`
return tuple growing one slot (now 14-tuple including the
matcher BPS) and a new `setLifMatcherFeeBps` setter selector.
Frontend `useProtocolConfig` already updated to read the new
slot; bot doesn't consume the bundle so its sync is purely
provenance.

## Offer-creation HF / LTV live preview (Tier 2 #4)

Until today, an offer creator typed an amount and a collateral
amount blind: there was no live indication of where their
choice would land on the Health Factor or LTV curve until they
hit submit, watched the on-chain `LoanFacet.initiateLoan`
reject, and tried again. The dashboard's existing
**Liquidation-price projection** card already does the exact
right shape of work for an *active* loan; this change brings
the same idea into the *creation* flow.

What landed (Advanced mode only, ERC-20 / ERC-20 pairs only —
NFT-rental loans don't have a meaningful HF):

- A new **Risk preview** card renders inside the Collateral
  card on `Create Offer`. It reads the collateral asset's
  on-chain liquidation threshold (the same bps the on-chain HF
  formula uses) plus live oracle prices for both the lending
  and the collateral leg, and computes the projected Health
  Factor and LTV for the user's typed amounts.
- For a **Range Orders** offer (where the user has set a
  separate maximum amount above the minimum), the card renders
  HF and LTV at *both* ends of the range — labelled "best" and
  "worst" — so the user can see the worst-case position before
  publishing.
- A clear amber warning fires when the worst-case HF dips
  below the on-chain initiation floor of 1.5: at that point
  partial fills at the upper end of the range will revert with
  `HFTooLow`. The fix is mechanical (add collateral or tighten
  the ceiling) and the message says so.
- A "Collateral can drop X% before liquidation" line, derived
  the same way the existing Liquidation-price projection card
  does it, so the user has a concrete intuition for how much
  market move their offer can absorb.
- Two-way bound **sliders** for lending amount, lending amount
  max (when range mode is on), and collateral amount, mirroring
  the number inputs above. Drag the slider → the input value
  updates → the HF / LTV bars animate. The bars use the same
  shared component (`HealthFactorGauge` / `LTVBar`) and CSS
  transitions as everywhere else in the app, so the visual
  feedback is consistent with what the user sees on the
  dashboard and the loan view page.
- The card bails to a placeholder message while inputs are
  empty, and to a single-line "oracle unavailable" notice if a
  feed reverts — never to a broken `—` row. The on-chain HF
  check is still authoritative; the preview is a *guide*, not
  a guarantee.

The on-chain side of this is already correct (the HF gate at
`LoanFacet.initiateLoan` was always there); this is purely a
front-end pre-flight. Net effect: fewer "why did my loan get
rejected" support questions, and a friendlier ramp into Range
Orders for users who don't yet have an intuition for how a
[min, max] range maps to risk.

## Outstanding for the testnet redeploy gate

Before fresh testnet diamonds can land:

1. **OfferFacet split for EIP-170** — flagged for the next
   commit on `feat/range-orders-phase1`. The Range Orders Phase
   1 work pushed the facet's runtime bytecode to ~28KB, and
   anvil bootstrap currently relies on `--code-size-limit
   50000` + `forge --disable-code-size-limit` to deploy. Real
   testnets / mainnet enforce the 24576-byte ceiling. Plan:
   extract the matching surface (`matchOffers` + `previewMatch`
   + the matchOverride storage management) into a new
   `OfferMatchFacet`, share `_acceptOffer` plumbing via a thin
   internal-cross-facet entry point on OfferFacet. Conceptually
   the right cut anyway — matching is bot-facing and
   semantically distinct from create / accept / cancel.
2. **wrangler.jsonc env sync runbook** — fresh testnet diamond
   addresses need to land in the Cloudflare Worker's vars
   block automatically rather than being manually copied. Plan:
   small `bash contracts/script/syncFrontendEnv.sh` that
   rewrites `frontend/wrangler.jsonc` from `frontend/.env.local`.
   Idempotent.

Both land before the next testnet redeploy.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes/ReleaseNotes-…md`. No code. Function names,
tables, and exact selectors live in the codebase; this file
describes behaviour to a non-engineer reader (auditor, partner
team, regulator).
