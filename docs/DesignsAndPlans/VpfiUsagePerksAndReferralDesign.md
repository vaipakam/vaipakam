# VPFI usage-earned perks + referral mechanic (E-2)

**Status:** legal glance **DISCHARGED** (owner, 2026-08-03); the spend-gated
absorption channel is **BUILT** (`PerkFacet`, `RecycleSource.SpendGatedPerk`).
**All owner decisions are SETTLED (2026-09-07)** — see "Decisions" below;
#1204 no longer gates the recycling programme. Remaining is ENGINEERING and
OPERATIONS, not a decision: the per-perk **effects** (starting with priority
solver routing), and then setting each perk's price as the last step of
shipping it. Prices are an arming action, and a non-zero one is only safe once
that perk's effect is deployed and verified — the deploy default of zero means
"not for sale". Referral is deferred for Phase 1. Card: #1204.
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

## Decisions — all settled

1. ~~Perk prices / tier mapping~~ — **DECIDED 2026-09-07: no decision is
   needed to SHIP.** Price zero is the deploy default and means "not for
   sale", so the channel is already dark-by-default and pricing is an
   ARMING action, not a build input. **Priority solver routing is armed
   first and alone**; every other catalog entry stays unpriced until its
   own effect is built. Prices remain governance-config, bounded.

   ⚠️ **Arming order, and it is a fund-safety rule rather than a
   preference.** "Armed first" means first AMONG THE PERKS — never before
   its own effect exists. `purchasePerk` moves the buyer's VPFI into
   recycling immediately and irreversibly, and there is no refund; a
   priced perk whose consumer is not deployed therefore sells nothing for
   real money. Priority solver routing has **no production consumer of
   `consumePerkCredit` / `getPerkEntitlement` outside `PerkFacet` today**,
   so it is not armable yet.

   **The gate: a non-zero price may be configured for a perk only once
   that perk's effect is deployed on that chain and verified to consume
   the entitlement.** Governance sets the price as the LAST step of
   shipping a perk, not the first — the deploy default of zero is what
   makes that safe by construction, and nothing about "armed first"
   relaxes it.
2. ~~Referral credit size + caps + expiry~~ — **DEFERRED for Phase 1
   (owner, 2026-09-07).** A recorded deferral, which §6 of the completion
   plan counts as a decided state — not an omission. The reasons are the
   ones this section already gives: referral is the legally heaviest piece
   here (#694's *Tomahawk* pattern is why it pays fee credits rather than
   tokens at all), it needs its own glance, and a fee-credit ledger with
   caps and expiry is a liability surface that buys the recycling
   programme nothing — the absorption channel is already built and
   crediting without it. Re-opening it is a new scoping decision, not a
   continuation of this one.
3. ~~Whether visibility boost ships at all~~ — **DECIDED 2026-08-31: it does
   not ship.** See the ruling above.

**Programme status (2026-09-07):** the absorption half — the thing the VPFI
recycling programme depends on — is BUILT and crediting, and with the two
decisions above settled #1204 no longer gates that programme. What remains
is per-perk EFFECT work (starting with priority solver routing) plus the
deferred referral half; both are product work that belongs on their own
cards rather than under the recycling umbrella.

## Tests

Per-perk: gate honored, spend routed to recycle bucket, no effect on
settlement math. Referral: credit only on clean close; caps; expiry;
sanctions-flagged wallets earn nothing (Tier-1 consistency).
