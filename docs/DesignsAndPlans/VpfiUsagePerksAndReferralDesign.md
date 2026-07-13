# VPFI usage-earned perks + referral mechanic (E-2)

**Status:** design for **legal glance → per-perk build**. Card: #1204.
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
| Offer listing visibility boost (book sort weight, badge) | **Spend-gated**: per-listing VPFI fee | permanent (→ recycle bucket) |

Rules:

- Spend-gated perks are consumable purchases; VPFI routes to the treasury
  **recycle bucket** (`VpfiRecycled` event, per
  [`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md)).
- Hold-gated perks reuse the existing effective-tier machinery (TWA +
  mirror cache) — no new tier system.
- No perk may alter risk parameters, matching fairness for already-posted
  offers' *terms*, or settlement outcomes. Perks touch convenience and
  visibility only. (Visibility boost must be disclosed in the book UI —
  "boosted" badge — so unboosted users aren't misled.)

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
3. Whether visibility boost ships at all (owner may judge it against the
   neutral-book ethos).

## Tests

Per-perk: gate honored, spend routed to recycle bucket, no effect on
settlement math. Referral: credit only on clean close; caps; expiry;
sanctions-flagged wallets earn nothing (Tier-1 consistency).
