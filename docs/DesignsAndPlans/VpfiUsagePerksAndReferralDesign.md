# VPFI usage-earned perks + referral mechanic (E-2)

**Status:** legal glance **DISCHARGED** (owner, 2026-08-03); the spend-gated
absorption channel is **BUILT** (`PerkFacet`, `RecycleSource.SpendGatedPerk`).
Remaining: per-perk effects, and the pricing decisions below. Card: #1204.
Umbrella: #1221. Legal frame: #694.

## Objective

Give VPFI demand beyond fee-discount tiers, using only fee-for-service and
price-schedule shapes — never returns.

## Perk catalog (each independently shippable)

| Perk | Gate shape | Absorption |
| --- | --- | --- |
| Reduced notification fees | Hold-gated (tier) | indirect (higher tier demand) |
| Priority solver routing for intents | **Spend-gated**: flat VPFI fee per priority window | permanent (→ recycle bucket) |
| Higher auto-lifecycle limits (auto-lend caps, intent batch sizes) | Hold-gated (tier) | indirect |
| ~~Offer listing visibility boost (book sort weight, badge)~~ | ~~**Spend-gated**: per-listing VPFI fee~~ | **DROPPED — owner decision 2026-08-31** |

Rules:

- Spend-gated perks are consumable purchases; VPFI routes to the treasury
  **recycle bucket** (`VpfiRecycled` event, per
  [`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md)).
- Hold-gated perks reuse the existing effective-tier machinery (TWA +
  mirror cache) — no new tier system.
- No perk may alter risk parameters, matching fairness for already-posted
  offers' *terms*, or settlement outcomes. Perks touch convenience only.

### DECIDED 2026-08-31 (owner): the visibility boost does NOT ship

Open decision 3 below asked whether the listing-visibility boost should ship
at all, "against the neutral-book ethos". **The ethos wins: it is dropped.**

The reasoning is worth keeping, because it also constrains future perks. Every
other perk on this list is bought by a user and spends itself on that user —
a faster route, a higher limit, a cheaper notification. The visibility boost is
the one that spends itself on *everyone else*: it reorders what other
participants see, so its value comes precisely from making unboosted offers
less visible. A "boosted" badge discloses that but does not undo it, and a book
whose ordering can be bought is no longer neutral. That is a property of the
marketplace, not a feature of one account.

**The rule this sets, for any perk proposed later:** a perk may change what its
buyer gets, never what other participants see. Convenience, capacity and price
are purchasable; position in a shared view is not.

The absorption channel does not depend on this. Priority solver routing remains
the spend-gated perk, and `PerkFacet` is perk-agnostic — it sells entitlements
at a governance-set price, so dropping one perk removes a catalog entry rather
than any mechanism.

## Referral — the legally careful part

#694's research flags promotional/bounty token distributions as the
*Tomahawk* enforcement pattern: a "free" token for marketing-valuable acts
is bargained-for consideration, losing the airdrop carve-out. Therefore:

**Referral pays in FEE CREDITS, not tokens.** A referrer earns a bps
credit against their own future protocol fees (capped per referee and
globally per epoch) when a referred wallet completes its first clean loan.
A fee credit is a price reduction on services — no token is distributed,
no securities-shaped fact pattern, and the Ecosystem bucket is only the
*accounting* budget that absorbs the forgone fee revenue.

- Referee link: signed referral code bound at first vault creation;
  self-referral blocked by the existing self-trade identity rules
  (multi-wallet self-referral is the same off-chain-analytics problem as
  multi-wallet self-trading — monitored, not on-chain-prevented).
- Credits expire (e.g. 12 months) so the liability is bounded.
- No credit for mere sign-ups — only completed clean loans (usage-based,
  consistent with the interaction-reward frame).

## Open decisions

1. Perk prices / tier mapping (governance-config, bounded).
2. Referral credit size + caps + expiry.
3. ~~Whether visibility boost ships at all~~ — **DECIDED 2026-08-31: it does
   not ship.** See the ruling above.

## Tests

Per-perk: gate honored, spend routed to recycle bucket, no effect on
settlement math. Referral: credit only on clean close; caps; expiry;
sanctions-flagged wallets earn nothing (Tier-1 consistency).
