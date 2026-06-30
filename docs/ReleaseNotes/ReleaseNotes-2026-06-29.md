# Release Notes — 2026-06-29

This batch folds the release-note fragments accumulated since 2026-06-27. It spans
three threads of work. **Borrower-facing transparency:** a pre-grace warning banner,
in-kind settlement and interest-mode disclosures, full-term interest disclosure on
refinance, and the OfferDetails child-loan listing. **VPFI tokenomics simplification:**
removal of the fixed-rate VPFI sale and staking-yield paths, buyback dormancy,
staking-terminology and copy sweeps, and mirror-vault canonical awareness. **Near-real-time
data + correctness hardening:** the indexer/​frontend on-chain verification split,
paginated position views, real-time WS push, keeper in-tick partial re-size, multi-intent
auto-lend UI, and best-effort persistence.

It also lands two **compliance audit artifacts** — the Sanctions & Terms-gate action
matrix (#800) and the Keeper no-custody authority matrix (#803). Authoring these from
the canonical specs and comparing against the code surfaced several enforcement gaps
(most notably that the wind-down "unflagged counterparty always recovers" guarantee does
not fully hold, because the recipient-vault sanctions screen reverts close-out deposits
into a flagged loan party's vault) — these are documented in the matrices' Open-gaps
sections and logged in `docs/FunctionalSpecs/_CodeVsDocsAudit.md` for triage, not yet
fixed.

## Pre-grace warning banner on the loan detail page (#545)

Borrowers who rely on auto-refinance to roll their loan now see an inline warning
on the loan detail page when the loan is close to defaulting — even if they never
subscribed to Telegram or push notifications.

When the connected wallet is the loan's borrower, the loan has auto-refinance caps
enabled, and the loan is within the final 24 hours before it enters its grace
period, a prominent banner appears near the loan title. It explains that
auto-refinance is best-effort — if no compatible lender offer is matched before
grace expires, the loan will default — states how many hours remain until grace
begins, and makes clear repayment is accepted until the grace period itself
expires (not merely until maturity). It offers two shortcuts: jump to the
refinance-caps editor (to widen the caps if the market has moved) or open the
repay flow directly. The banner reflects a caps enable/disable immediately, and
the repay shortcut only appears when the repay action is actually available to
the connected wallet.

This mirrors the existing keeper-side pre-grace notification so the warning reaches
anyone who opens the page, not only notification subscribers. It is advisory and
changes no on-chain behaviour or repayment obligation.

It also replaces the earlier, less prominent in-card pre-grace note (which had no
call-to-action and sat lower on the page) so the borrower sees a single, clear,
actionable warning rather than two duplicates.

## OfferDetails lists every loan from a multi-fill offer (#600)

A range / partial-fill offer can be filled many times, producing several loans
from one offer. The offer detail page previously linked only a single loan (the
most recent fill), so to see the rest a user had to go back to the Dashboard's
"Loans by offer" section.

The offer detail page now shows a **"Loans from this offer"** section listing
every child loan, with the same per-offer aggregates the Dashboard already
computes — total principal, amount-weighted average rate, status counts, and
collateral by asset — and each child links to its own loan page. (Health factor
isn't computed for this offer-side view, so the min-HF cell shows "—".) A
single-fill offer keeps the existing "View loan" link; the section also appears
for a lone child of a still-open partial-fill offer that has no header link yet,
so that loan is always reachable.

The complete child list is read from the indexer's activity history of the offer,
covering both direct fills and matcher-driven fills (the latter previously
attributed a lender offer's loans to the counterparty offer; the indexer now also
records the lender side so those children surface here too). It reflects all loans
the offer ever produced regardless of who currently holds them. No on-chain or
contract changes.

The matcher-fill coverage relies on a new indexer field. A one-time database
migration backfills that field for any activity already recorded before this
deploys, so historical matcher-filled lender offers also list their child loans
without a full re-index.

This also corrects a status-label mapping so terminal loans (liquidated /
fully-settled) show the right status and counts here and on the public dashboard.

## Keeper resizes partial liquidations in-tick instead of giving up (#642)

When the reference keeper liquidates only part of an unhealthy loan, the
contract can reject the requested slice for two recoverable reasons: the slice
is a little too large (it would over-correct the loan's health), or it exceeds a
governance-set cap on how much of a loan one liquidation may close. Previously
the keeper reacted to these by either skipping the loan until the next cycle or
jumping straight to a full liquidation.

The keeper now handles both **within the same cycle**:

- If the slice is too large, it shrinks the slice, re-prices the swap for the
  smaller amount, and retries — a few bounded attempts — so a healthy partial
  still goes through instead of waiting for the next cycle.
- If the slice exceeds the close-factor cap, it reads the live cap from the
  contract, clamps the slice to it, re-prices, and retries — only falling back
  to a full liquidation if the cap leaves no usable partial.

To support this, the contract exposes the live close-factor cap through a new
read-only view so the keeper can clamp precisely rather than guess. This is a
keeper-ergonomics improvement only: the on-chain guards remain the safety
boundary (a mis-sized slice simply reverts before any funds move), so there is no
change to liquidation outcomes or user funds — only fewer wasted cycles and fewer
unnecessary escalations to full liquidation.

## Thread — Remove the fixed-rate VPFI sale (legal-surface reduction) (PR #<n>)

The protocol no longer sells VPFI to users at a fixed ETH rate. The
on-chain issuer sale — buying VPFI directly from the protocol with ETH on
the canonical chain, plus the cross-chain "buy on a mirror chain" round
trip — has been removed in full. This is the first step of the VPFI
legal-program excision (#687): an issuer-operated token sale is the single
largest securities-law surface the platform carried, and removing it keeps
VPFI a purely consumptive utility token that users acquire on the open
market or bridge in themselves.

What was removed: the `buyVPFIWithETH` entry point, the bridged-buy ingress
(`processBridgedBuy`), the fixed-rate quote view, the per-wallet / global
sale caps and the sale kill-switch, the "amount sold" tallies, and the two
cross-chain contracts that carried the buy round trip
(`VpfiBuyAdapter` on mirror chains, `VpfiBuyReceiver` on the canonical
chain) together with their CCIP "vpfi-buy" channel, deploy steps, and
handover legs.

What was kept: the consumptive VPFI fee-discount utility is unchanged —
staking VPFI into a vault (`depositVPFIToVault` / `withdrawVPFIFromVault`),
the time-weighted discount tiers, the borrower Loan-Initiation-Fee rebate,
and the lender yield-fee discount all continue to work exactly as before.
The discount quote still needs a VPFI price anchor, so the price field the
sale used to share was renamed (not deleted) into a dedicated discount
config: `setVPFIDiscountRate` / `getVPFIDiscountConfig`, alongside the
existing `setVPFIDiscountETHPriceAsset`. Because the platform is pre-live,
the removed storage fields are dropped outright (a fresh deploy, not an
in-place upgrade).

Part of #687. Follow-ups: #687-B removes the 5% staking yield (keeping the
discount tiers); #687-C confirms the treasury buyback stays dormant; the
frontend buy page, agent buy-watchdog, and marketing / user-guide / i18n
copy that still reference the sale are migrated in a dedicated follow-up.

## Thread — Remove the VPFI 5% staking yield (legal-surface reduction) (PR #<n>)

The protocol no longer pays a 5% APR "staking yield" on vaulted VPFI. An
issuer that pays an ongoing yield on a held token is a textbook
securities-law surface, so this is the second step of the VPFI
legal-program excision (#687, after the fixed-rate sale in #711).

What was removed: the `StakingRewardsFacet` and its `LibStakingRewards`
accrual library in full (claim, preview, reward-per-token accrual, the
staked-balance bookkeeping), the admin staking-APR knob
(`setStakingApr` / `getStakingAprBps` + the `vpfiStakingAprBps` config
field), the staking reward-per-token / paid-out / per-user accrual storage,
the `vpfiStakingPoolCap` constant, the dashboard's staking-pending read,
the two staking-only custom errors, and the connected-app staking UI
(the staking-rewards claim card, the staking-APR hooks, and the staking
rows on the rewards summary).

What was kept — unchanged: the **balance-based** VPFI fee-discount tiers
(they read the vaulted VPFI balance, never the staking accrual), the vault
deposit / withdraw mechanics that back those tiers, and the interaction
rewards. The scout confirmed zero entanglement: every vault-mutation site
already re-stamped the discount accumulator independently of the staking
checkpoint, so removing the staking call left discounts intact.

Because the platform is pre-live, the removed storage fields are dropped
outright (fresh `DeployDiamond`). The freed 24% supply allocation that
backed the staking pool is a separate owner tokenomics decision tracked
under #687 / #694, not changed here.

Part of #687. Follow-ups: #687-C confirms the treasury buyback stays
dormant (and folds in the now-orphaned `stakingPoolBuybackBudget`); the
www marketing / user-guide / whitepaper staking-yield copy + the i18n
locale-key cleanup ride the #712 copy sweep.

## Thread — Confirm the treasury buyback stays dormant + reroute the staking overflow (PR #<n>)

Closes the VPFI legal-program excision (#687, after the fixed-rate sale in
#711 and the 5% staking yield in #714). The treasury buyback stays **dormant**
for Phase 1 (the ratified "Option 2"): there is no automated funding path and
no new admin enable/disable knob — every buyback entry point is already
admin-only and default-off, and the kept reward budgets
(`rewardEmissionsBudget`, `keeperRewardBudget`) degrade gracefully to zero when
their top-up targets are unset.

The one concrete change is reconciling the leftover the staking-yield removal
exposed: the buyback "priority router" used to send any overflow (proceeds past
the rewards + keeper top-up targets) into a staking-pool budget that — now that
the 5% staking yield is gone — has no way to ever be spent. Rather than let a
buyback silently strand VPFI in that dead budget, the overflow tier is removed:
a buyback fill that would deliver more VPFI than the two top-up targets can
absorb now reverts instead of accumulating an unspendable balance. In the
dormant Phase-1 configuration this is never reached (no buyback is committed and
both targets default to zero). The dead `stakingPoolBuybackBudget` budget, its
read-only getter, and the now-unused fourth field of the buyback-split event are
deleted.

Swap-to-repay, which shares the same intent-dispatch plumbing, is unaffected.

Closes #710. Part of #687.

## Thread — VPFI legal-program copy + orphan sweep (PR #<n>)

The final, non-contract half of the #687 VPFI legal-surface excision: the
residual frontend copy, marketing/user-guide/whitepaper text, i18n strings, and
vestigial deployment plumbing left behind once the fixed-rate sale (#711), the
5% staking yield (#714), and the buyback overflow tier (#715) were removed from
the contracts.

What changed:

- **Connected app (apps/defi)** — the VPFI page's i18n namespaces were renamed
  to match the page (`buyVpfi.*` → `vpfiVault.*`, `buyVpfiCards.*` →
  `vpfiVaultCards.*`) across all ten locales, every dead sale/staking-yield key
  was deleted (the old buy-step, the staking-rewards claim strings, the
  staking-APR card-help), in-app `/buy-vpfi` links were repointed to
  `/vpfi-vault`, and `BuyVPFI.tsx` was renamed to `VPFIVaultAndDiscounts.tsx`.

- **Marketing site (apps/www)** — every description of the fixed-rate sale and
  the staking yield was removed or reworded across the overview, both
  user-guide tiers, and the whitepaper in all ten languages, plus the
  marketing page, nav/hero/footer CTAs (route `/buy-vpfi` → `/vpfi`), the i18n
  bundles, and the glossary. The whitepaper allocation table folds the freed
  25% (sale 1% + staking 24%) into a Reserve line **explicitly flagged as a
  pending governance decision** — its final disposition (hold, burn-to-reduce
  the cap, or reallocate) is the owner's call, not asserted here.

- **Shared package + deployment artifacts** — the now-dead `vpfiBuyAdapter` /
  `vpfiBuyReceiver` / `vpfiBuyPaymentToken` deployment keys were dropped from
  the `Deployment` / `ChainConfig` types, the consolidated `deployments.json`,
  and every per-chain `addresses.json`, with the matching reads removed from the
  app config.

- **Keeper bot (sibling repo)** — the per-facet ABIs the bot reads were
  re-synced to the post-excision contract surface (a separate PR there).

Verified: `tsc` green for every workspace (defi/www/agent/keeper/indexer);
all locale JSON valid; no rendered string carries sale or staking-yield copy.

Closes #712. Completes the on-chain + off-chain #687 excision.

### #717 — defi staking-terminology excision (#687-B UI follow-up)

The on-chain `5% APR` staking yield was removed in #687-B (discount tiers and
interaction rewards were kept). This change finishes the job in the connected
app, where "stake / unstake / staking" language lingered even though vault-held
VPFI now only earns a fee-discount tier, never a yield.

What changed for users:

- The VPFI vault page, dashboard CTA, lender-discount card, token-card tooltip,
  navigation, and loan/activity timelines now say **deposit / withdraw / hold**
  instead of "stake / unstake / staking". The underlying action is unchanged —
  moving VPFI into or out of your vault to qualify for the fee-discount tier.
- Copy that implied a staking *yield* (e.g. an empty-state hint, a rewards
  summary heading) was removed or reworded; vault-held VPFI is described purely
  as lowering fees, not as earning interest.
- Two activity/timeline entries for events that no longer exist — the staking
  rewards claim (removed in #687-B) and the fixed-rate VPFI buy (removed in
  #687-A) — were dropped, since those events can never occur again.

Behind the scenes this also removed dead front-end and indexer code that
decoded those two retired events, and deleted the orphaned defi FAQ copy block
(the FAQ now lives only on the marketing site). Translations of the reworded
strings were dropped from the nine non-English bundles so they fall back to the
corrected English until a human re-translation pass (tracked separately).

### #718 — canonical-aware VPFI vault page on mirror chains

VPFI fee-discount tiers are resolved from your vault balance on the canonical
chain and propagated to every other ("mirror") chain. The VPFI vault page's
discount-status card now reflects that correctly when you're connected to a
mirror chain:

- The tier shown is your real effective tier (it was already correct — it reads
  the propagated value), but the card no longer implies the balance shown on the
  current chain is what sets it. The figure shown is now the **protocol-tracked**
  vault balance (the deposit-flow balance the discount math counts — direct
  transfers to the vault are excluded), labelled "Vault VPFI (tracked, this
  chain)", and points to the canonical chain as where the tier is set.
- The "deposit X more to reach the next tier" hint — now computed from the
  tracked balance — is hidden on mirror chains (depositing locally can't raise a
  tier that's driven by the canonical-chain balance). On the canonical chain it
  behaves as before, just based on tracked rather than raw balance so dust can't
  spuriously show "qualifies".
- A short banner on mirror chains explains the model: your tier is set on the
  canonical chain and mirrored here via cross-chain propagation; it applies on
  this chain's loans only once you enable the discount consent on this chain;
  protocol-tracked VPFI you deposit here (through the deposit flow) is what lets
  that discount apply locally; to change your tier, manage VPFI on the canonical
  chain.
- The canonical-chain name shown is derived from the active network's
  environment (testnet vs mainnet), so a testnet-mirror user sees the testnet
  canonical chain rather than the mainnet default.

Deposits and withdrawals stay available on every supported chain — holding
protocol-tracked VPFI locally is what lets the discount apply to that chain's
loans — they're just framed honestly now. The on-chain discount mechanics are
unchanged; this is a display / copy correctness fix.

## Hardening — the app confirms your loans and claimables on-chain, not just from the indexer (#749)

The dashboard's "your loans" and "claimable funds" views start from the indexer's
cached list of which positions a wallet holds, then confirm each one directly
on-chain. Previously the app only consulted the chain *when the indexer returned
nothing* — so if the indexer's cache was briefly stale or incomplete and returned
*some* of a wallet's positions but not all, the missing ones could be hidden from
the user.

Now the app **always** reads the authoritative on-chain list of the wallet's
current position NFTs — using the user's **own** wallet/RPC, never the operator's
— and merges it with the indexer's cached list before confirming each position.
The indexer is treated as a cache that can only *add* candidates to check, never
as the sole source of truth, so a stale or partial cache can no longer hide a loan
or (more importantly) a claimable balance. If the on-chain read itself is
unavailable, the app falls back to the cached list rather than showing nothing.

This is the user-facing half of the indexer security work: the indexer's read
endpoints stay fast and make no on-chain calls of their own, while correctness is
guaranteed by this on-chain confirmation in the app.

## Security — wallet loan/claimable lookups no longer fan out unbounded on-chain calls (#749)

Three public indexer read endpoints — a wallet's loans as lender, as borrower, and
its claimable loans — used to answer by pulling **every** matching loan from the
database (with no row limit) and then making one or two on-chain ownership calls
**per loan** to filter down to the requesting wallet. The page-size limit was only
applied *after* that fan-out, so it didn't bound the work.

Two problems followed. First, an unauthenticated caller could make each request
issue on-chain calls scaling with the **global** number of loans — and by varying
the wallet in the URL to bypass the short edge cache, sustain that load cheaply,
burning the operator's paid RPC quota that the keeper and alert services also rely
on. Second, once the loan table grew past the per-request subrequest ceiling, the
extra ownership calls failed silently and those loans simply **dropped out of the
results** — so the endpoints quietly under-reported for legitimate users at scale.

These endpoints now answer **purely from the indexer's database** — zero on-chain
calls, so the operator's RPC quota is never touched and the work scales only with
the requesting wallet's own holdings. To make that database answer trustworthy
(real funds are at stake for claimables), the indexer's record of *who currently
holds each loan's lender/borrower position* was made authoritative across the
lifecycle cases it previously missed:

- a position NFT **burned** on claim now correctly drops out of the lists (it was
  staying attributed to the last holder);
- a **lender sale** or **borrower-obligation transfer** mid-loan (which mints a
  fresh position token for the new party) now re-points ownership to that party;
- a loan whose offer position NFT was **sold on the secondary market before the
  offer was accepted** is now attributed to the actual holder, not the original
  offer creator.

A chain this indexer doesn't serve now returns a clear "not configured" response
so the app falls back to reading the chain directly rather than showing an empty
list.

(Part of the pre-audit security sweep. The app additionally confirms ownership
on-chain using the **user's own wallet** as the authoritative layer over this
database projection — see the companion frontend change. A separate
defense-in-depth note about escaping reflected on-chain text is tracked on the
frontend. Operational note: the position-owner projection is rebuilt from the
chain's transfer history during normal indexing; an environment that pre-dates the
current-holder columns is brought current by a one-time re-index.)

## Thread — Auto-lend: multi-intent-per-lender management UI (PR #<n>)

Closes #755 (its second and final PR; the first added the contract read
surface). A lender can run **many** standing auto-lend intents at once —
one per `(lending, collateral)` asset pair — but the dapp only ever showed
the single intent for the pair currently picked in the auto-lend card's
asset selectors. A lender with several intents had no way to see them all,
and a **paused** intent (cancelled but still holding reserved capital) was
effectively invisible unless they remembered its exact pair and re-typed it.

What's new on the Dashboard:

- A **"Your auto-lend intents"** overview card that lists every standing
  intent the connected wallet owns across pairs, each row showing the pair,
  whether it's **Active** or **Paused**, the un-lent **Funded** capital, the
  principal currently **On loan**, the max exposure, and the min rate. It
  pages the new per-owner enumeration, so it surfaces paused intents too —
  the ones a lender most needs a way back to. The card **self-hides** when
  the wallet has no intents, so it never adds clutter for users who don't
  auto-lend.
- A **"Manage"** action on each row that selects that pair into the existing
  auto-lend card and scrolls to it. The list itself is **read-only on
  purpose**: every change — resume, edit, top up, withdraw — still runs
  through the one auto-lend card, which enforces the correct ordered enable
  sequence (consent → keeper delegation → registration → fund). This keeps a
  single, audited write path and avoids duplicating the ordering rules in two
  places.

No protocol behaviour changes — this is a read-and-navigate surface over
state that already existed. There is no borrower-side equivalent: the intent
layer is lender-only by design (borrowers participate through the offer
book).

## Thread — Auto-lend: per-owner standing-intent enumeration view (PR #<n>)

Part of #755 (multi-intent-per-lender management UI). The auto-lend layer
already lets a single lender hold **many** standing intents — one per
`(lending, collateral)` pair — but the only on-chain enumeration was the
keeper's **global, funded-active-only** feed (`getActiveLenderIntents`),
which is owner-agnostic and omits paused intents. So the dapp had no clean
way to show a lender *their own* intents. This is the read surface that
gap needs; the management UI that consumes it lands in the follow-up step.

What's new:

- An **enumerable per-owner intent registry**, maintained at the same sites
  as the global feed (register / fund / cancel / withdraw / fill draw-down /
  auto-roll). Its membership is deliberately **broader** than the global
  feed: a key is listed while the intent *exists for the lender to manage* —
  `active` **or** carrying reserved capital — so a **paused** intent
  (cancelled but still holding funded capital the lender can resume or
  withdraw) stays visible. A key drops out only once the intent is **fully
  torn down** (inactive **and** zero reserved capital).
- **`getLenderIntentsByOwner(owner, offset, limit)`** — a paginated, lean
  view (on `LenderIntentFacet`, alongside the other `getLenderIntent*`
  reads) returning every standing intent that owner holds, each with its
  bounds, the un-lent funded capital, the live principal already out on
  loans, and an **`active` flag** so a consumer can tell an active intent
  from a paused one. The flag rides on a **dedicated per-owner row type**,
  not on the shared intent summary the global keeper feed
  (`getActiveLenderIntents`) returns — so the global feed's wire shape is
  left byte-for-byte unchanged and existing keeper/frontend decoders are
  untouched. (The global feed needs no such flag; it lists only active
  intents.)

This is a read-only surface plus per-owner registry bookkeeping — no change
to how intents are registered, funded, filled, rolled, priced, or settled.
The per-owner registry is populated forward-only, at the same sites as the
existing global keeper feed, so the two stay consistent; on a from-scratch
deployment (every deployment to date) every intent is captured.
The lender-facing list/manage UI that pages this view is the next step;
there is no borrower-side equivalent because the intent layer is
lender-only by design (borrowers use the offer book).

## Hardening — large-wallet safety for the on-chain position reads (#769)

The app confirms which loans and offers a wallet holds by asking the chain to
enumerate that wallet's position NFTs. That on-chain view walked the wallet's
*entire* NFT inventory in a single call. Because position NFTs can be transferred
to someone without their consent, an attacker could mint many cheap dust offers
and dump their NFTs onto a victim to bloat that inventory until the single call
grew too large for a node to answer — breaking the victim's loan and claimable
views.

This adds **paginated** variants of those views so the work is done in bounded
slices, and the app now reads them page by page. The cost per call scales with a
fixed page size instead of the whole inventory, so a griefed wallet's reads keep
working no matter how many junk NFTs are pushed onto it. The total work still
scales only with the wallet's own holdings — there's no global amplification.

This is a follow-up to the indexer security work: the indexer's read endpoints
remain fast and make no on-chain calls, while the app's authoritative on-chain
confirmation is now safe even for a deliberately-bloated wallet. No change to any
lending, borrowing, or settlement behaviour.

## Near-real-time UI updates — WebSocket push from the indexer (#757 Phase B)

The connected app already keeps itself fresh by polling the indexer in the
background. This adds a faster, optional path on top: the indexer can now **push**
a small "this changed" signal to the app over a WebSocket the instant it finishes
recording an on-chain change, so the relevant screen refreshes within seconds
instead of waiting for the next poll.

How it works, in plain terms:

- The per-chain ingest component (added in Phase A) now also holds the browser
  connections for that chain. Right after it records a batch of changes, it
  notifies every connected app: "offers changed", "a loan was updated", "new
  activity", and so on.
- The signal carries **only the fact that something changed**, never the data
  itself. The app then re-reads the affected slice through the exact same
  endpoints it already uses — so nothing about what the app trusts, or where it
  reads authoritative data from, changes.
- A new line in the connection-status popover shows whether the page is getting
  **Live** push updates or is on the always-on **Polling** fallback.

This is purely additive and degrades safely: if the WebSocket can't connect, the
deployment doesn't have the realtime channel enabled, or the connection drops,
the app simply keeps polling exactly as it did before — there is no change to the
decentralized read-and-fallback path. The realtime channel is only active when an
operator has enabled the Phase A ingest path; otherwise the app shows "Polling"
and behaves identically to before. No change to any lending, borrowing, or
settlement behaviour.

## Risk disclosure — borrower's full-term interest commitment (#784)

The risk-acknowledgement shown before **creating** and before **accepting** an
offer now states, in plain language, the borrower's interest commitment for that
specific offer:

- For a **full-term-interest** offer (the default), it says the borrower agrees
  to pay the full-term interest amount for the entire agreed term **even if the
  loan is repaid early** — repaying early does not reduce the interest owed.
- For an offer that opted into **pro-rata** interest, it says interest accrues
  only for the time the loan is actually outstanding.
- For a full-term offer that **also allows partial repayment**, the wording is
  qualified: paying down principal early does lower the future interest on the
  reduced balance, while the full-term amount still applies to whatever principal
  remains — so borrowers aren't told early repayment can never reduce interest
  when partial repay is enabled.

The same disclosure now also appears on the borrower-initiated **preclose-offset**
flow, which creates a replacement lender offer inheriting the loan's interest mode
(that replacement offer is always non-partial-repay, so its wording reflects that).

The line is shown only for interest-bearing **ERC-20** loans — **NFT-rental**
offers settle prepaid rental fees rather than APR interest, so it's omitted there.
On the create-offer form, if a disclosure-driving field (interest mode,
partial-repay, or asset type) changes after the user has ticked the consent box,
the acknowledgement is cleared so they re-confirm against the updated wording.

The wording is tailored to the actual interest mode of the offer in front of the
user (sourced from the offer's term-interest setting, not hardcoded), so the
create-offer flow reflects what the creator is setting and the accept-offer flow
reflects what that borrower is committing to. The line appears inside the existing
single combined Risk Disclosures + Terms acknowledgement (no new checkbox), and
is included in the English-original modal shown to non-English users. No change to
any on-chain behaviour, interest calculation, or settlement.

## Thread — In-kind settlement made impossible to miss (PR #__)

Illiquid collateral, NFT collateral, and the oracle-unavailable fallback can
all settle a defaulted loan **in-kind** — the lender receives the raw
collateral asset itself rather than the lending asset, regardless of market
value, with no DEX swap and no LTV-based liquidation. This is intended
protocol behaviour, but it is a user-expectation risk: a lender who assumes
Vaipakam always converts collateral to the lent asset could enter a position
they would have declined with full context. This change closes the remaining
gaps so that downside is surfaced at every point a user commits to or holds
such a position.

What changed, surface by surface:

- **Create Offer / Accept Offer review** — the shared Risk Disclosures block
  now renders an explicit, offer-specific in-kind settlement line whenever the
  offer's collateral is an NFT or an illiquid / no-oracle asset, so the generic
  paragraph is no longer the only signal. The line is threaded through the
  English-original modal as well, so non-English users see it in the binding
  copy too. Create wires it off the chosen collateral asset class; Accept wires
  it off the offer's illiquid flag (the same flag the Offer Book already uses
  for its extra illiquid-leg notice).
- **Loan Details** — for an active loan with an illiquid / no-oracle leg, a
  prominent warning banner now sits at the top of the Collateral & Risk card
  (in addition to the pre-existing one-line risk explainer), keeping the
  in-kind outcome visible for the life of the loan rather than only at offer
  time.
- **NFT Verifier** — a live position NFT whose underlying loan settles in-kind
  now shows a labelled `Settlement on default` line (liquid vs in-kind) and a
  warning, so a prospective buyer of the position sees the downside before
  acquiring it.

All of these disclosures are scoped to **lending loans** (ERC-20 principal).
NFT-principal rentals are deliberately excluded everywhere (Create, Accept, Loan
Details, Verifier): their default model is renter-reset + prepaid-fee payout, not
a collateral-in-kind transfer, so the in-kind copy would mislead. The in-kind
determination is **collateral-driven** — `DefaultedFacet.triggerDefault` routes
the swap-vs-in-kind decision on the collateral's liquidity, so it fires for NFT
collateral or an illiquid ERC-20 collateral, NOT for a liquid collateral whose
only illiquid leg is the principal (so the lending-leg read added in an earlier
round was removed). Create-time uses the collateral's live liquidity; the Accept
review and the NFT Verifier re-read the collateral's LIVE active-network
liquidity (the exact value the default path routes on) rather than the offer/
loan's stored snapshot, which can go stale before accept/default. The Verifier
line renders only while the loan is still Active (a terminal loan can't default).
On Create Offer, submit is held while the ERC-20 collateral's liquidity read is
still resolving, so the disclosure can't be skipped by ticking consent before the
read lands.

The Advanced User Guide's "How Liquidation Actually Works" section (four
fallback branches with worked examples) and the public FAQ's `fallback-mechanics`
and `default` entries already cover the in-kind mechanics in plain language, so
no new guide/FAQ copy was needed for that acceptance criterion.

New `RiskDisclosures` component tests assert the in-kind line appears when (and
only when) the collateral settles in-kind, and that it composes with the
full-term-interest line.

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` gains intent bullets for the
Loan Details active-loan in-kind warning and the NFT Verifier settlement
caveat; the create/accept combined-disclosure requirement was already specced.

Closes #796.

## Thread — Full-term vs pro-rata interest mode kept visible across borrower exits (PR #__)

Early repayment, preclose, refinance, or swap-to-repay may still owe full-term
interest depending on the offer's interest mode. That is intended behaviour for
full-term offers, but a borrower-expectation risk: many users assume early
repayment automatically reduces interest. #784 made the create / accept Risk
Disclosures reflect the offer's actual stored mode; this change carries that
signal through the rest of the borrower journey.

What changed:

- **New `InterestModeBadge`** — a small, reusable chip that reads an offer/loan's
  `useFullTermInterest` flag and shows `Full-term interest` (cautionary tone) or
  `Pro-rata interest` (benign tone), with a hover/focus tooltip explaining the
  consequence. It self-suppresses for non-ERC-20 principal, where the
  distinction isn't meaningful. The chip now appears on **Offer Book** rows
  (next to the rate), **Loan Details** (in the loan terms, for the life of the
  loan), and **both swap-to-repay** surfaces — the atomic panel and the
  best-price intent panel (a full close honours the loan's mode).
- **Mode-aware Direct-preclose warning** — `InterestImplicationWarning` gained an
  optional `fullTermInterest` input. The Direct-preclose warning swaps to
  pro-rata-specific copy when an ERC-20 loan charges pro-rata, instead of always
  asserting full-term. Gated to ERC-20 principal: NFT-rental preclose always
  settles the full rental, so it keeps the full-term-style copy.
- **Refinance stays full-term (deliberately not mode-aware)** — the on-chain
  `RefinanceFacet` computes the old-loan payoff via `LibEntitlement.fullTermInterest`
  unconditionally, so the refinance screen always discloses full-term interest
  and never switches to pro-rata copy — the pre-sign disclosure must match what
  the transaction actually pulls. The stale "rate shortfall" wording was also
  dropped from the refinance copy: that path no longer pulls a shortfall
  (`shortfall = 0`).
- **Repay-in-Full confirmation** — the confirm copy now picks the most accurate
  wording: an overdue (in-grace) loan settles through-today interest plus a late
  fee (which can exceed full-term), a full-term ERC-20 loan settles the full-term
  interest (not just accrued), and other cases keep the generic line.
- **Treasury-fee wording** — the preclose interest warnings no longer hard-code a
  99% / 1% lender/treasury split (the treasury fee is governance-configurable);
  they now refer to "the configured protocol treasury fee".

New component tests cover the full-term / pro-rata / partial-repay combinations
for the badge (label + tooltip selection + the suppressed undefined case) and the
warning (the Direct-preclose mode-aware swap, refinance staying full-term, and
no-op for the other kinds).

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` gains intent bullets for the
at-a-glance interest-mode indicator, the mode-aware Direct-preclose warning, the
always-full-term refinance exception, and the mode-aware repay confirmation.

Closes #797.

## VPFI copy sweep — no more "buy / stake / yield" language (#798)

After the legal-surface excision that removed the fixed-rate VPFI sale and the
staking-yield program, some user-facing copy still implied you could buy VPFI from
the protocol or earn a staking APR on vault-held VPFI. Vault VPFI only ever gives
**fee discounts** now (deposit / withdraw / hold), and interaction rewards are
separate.

This sweeps the **English** (canonical) copy across the connected app and the
marketing site:

- Removed the stale, unused "earn the protocol APR on VPFI in your vault" string
  from the connected app's locale files.
- Rewrote the app FAQ so it no longer describes a fixed-price buy or an in-app
  "Buy VPFI" purchase flow — it now says VPFI is acquired on the open market or
  bridged by the user, and the in-app VPFI Vault is for depositing and holding
  VPFI to earn fee discounts.
- Swept the marketing site's "Stake / Unstake VPFI" labels, taglines, and the
  consent/tooltip copy to deposit / withdraw / hold wording.

No behaviour, route, or contract change — back-compat routes (the old
`/buy-vpfi` link) and code identifiers are intentionally untouched. The
non-English translations still carry the old terms in places and need a separate
translation pass to match the corrected English source.

## Thread — Keeper/automation best-effort limits made persistent and keeper-state visible (PR #__)

Auto-lend, auto-roll, auto-extend, and auto-refinance are best-effort automation
surfaces, not guarantees: if the keeper is paused, disabled, unauthorized, or no
compatible counterparty exists, a loan can still default. Users can mistake an
enabled automation toggle for a guaranteed rescue. The pre-grace warning banner
(#545) and the Alerts CTA (#546) already covered part of this; this change
closes the remaining gaps.

What changed:

- **Auto-lend intent card** — now carries a persistent best-effort notice
  (visible at enablement and while enabled). It distinguishes the two halves:
  fills depend on matching borrower demand within the lender's bounds and need
  no protocol keeper for open intents (any solver may fill — only
  keeper-restricted fills need one), whereas auto-roll of repaid loans is the
  keeper-dependent part. So capital may sit idle, deploy, or stop rolling, and
  the lender stays responsible for monitoring. The card already surfaced the
  fill-path and keeper-access kill-switch banners; this adds the standing
  best-effort framing, plus a banner for the live global delegated-keeper pause
  (auto-roll + keeper-restricted fills suspended while paused; open intents stay
  fillable by any solver).
- **Auto-lifecycle caps card** — the best-effort warning is now **persistent
  while a cap is active**, not just shown during the false→true enable
  transition (it previously disappeared on save). It is keyed on the saved
  on-chain state too, so it stays up during a pending (unsaved or failed)
  disable while the cap is still live. So a borrower/lender keeps seeing that
  auto-refinance / auto-extend is best-effort and not default protection for the
  life of the cap.
- **Keeper kill-switch visibility on the caps card** — when the **borrower**
  holder's master keeper switch is off, OR keeper automation is **globally
  paused** by governance (both unambiguous hard gates — auto-refinance and
  auto-extend execute against the borrower side and `requireKeeperFor` rejects
  every keeper call while paused), the card warns that any enabled cap is inert
  until keeper automation can run again: the master switch on, a keeper approved
  with the right permissions, AND that keeper enabled for this specific loan via
  the per-loan toggles (and a global pause lifted by governance). The two gates
  have different audiences: the master-switch case warns only the borrower
  holder, but the global-pause case warns BOTH the borrower and the lender
  holder, since a global pause makes a lender's own enabled auto-extend cap
  equally inert. The lender's own keeper switch is not treated as a blocker (the
  lender's extend-caps are only their consent surface), and the warning does not
  infer inertness from the approved-keeper count.

New component tests cover the keeper-unavailable warning (both directions) and
the persistent best-effort warning while a saved cap is enabled.

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` — the auto-lend card persistent
best-effort notice, the caps-card persistent (not transition-only) warning, and
the caps-card keeper kill-switch visibility intent.

Closes #799.

## Thread — Sanctions & Terms-gate action matrix (PR #__)

Sanctions screening and the versioned Terms-of-Service gate touch many action
families across the protocol and the dapp, and inconsistent gating is a real
risk class: a compliance bypass, a falsely-blocked recovery path, or a UI that
offers a transaction the protocol will revert. This change captures the intended
behaviour in one place, closes two representative test gaps, and — importantly —
records the **enforcement gaps and remaining test gaps that stay open** as
tracked follow-ups rather than papering over them.

- **New action-matrix spec** —
  `docs/DesignsAndPlans/SanctionsAndTermsGateMatrix.md` documents, per action
  family, the expected sanctions behaviour (Tier-1 BLOCK fresh-value / claims;
  Tier-2 ALLOW wind-down so an unflagged counterparty can be made whole; fail-
  open while the oracle is unset) and the Terms-gate states (disabled at
  `currentTosVersion == 0`; accepted-current; stale after a version bump or
  content-hash drift). It also pins the UI rules: the sanctions banner shows
  only for a flagged connected wallet or relevant counterparty, distinguishes
  blocked fresh-value paths from permitted recovery paths, and points to the
  sanctions-data provider for recourse. The matrix is sourced from the canonical
  specs (ProjectDetailsREADME § Regulatory Compliance Considerations and
  WebsiteReadme), with "verified at / tested by" references to the enforcement
  sites and tests.
- **Two contract test gaps closed** — Tier-1 sanctions reverts on the VPFI
  **deposit** (value-in) and **withdraw** (value-out) paths, which the existing
  `SanctionsOracle.t.sol` suite couldn't reach (its diamond doesn't cut the
  VPFIDiscountFacet selectors). Added in `VPFIDiscountFacetTest.t.sol`.
- **Frontend test** — a `SanctionsBanner` test asserting it shows for a flagged
  address and stays silent for a clean address, while the read is loading, and
  when no wallet is connected (the fail-open posture).

**What the matrix surfaced (now documented, not yet fixed).** Authoring the
matrix from the canonical specs and comparing against the code surfaced several
**enforcement gaps** — most notably that the wind-down "unflagged counterparty
always recovers" guarantee does **not** fully hold: because `getOrCreateUserVault`
screens the recipient vault owner, a flagged *recipient loan party* (e.g. a
flagged lender on full `repayLoan`, or a surplus borrower on liquidation/default)
currently makes the close-out **revert** rather than deferring to a Tier-1 claim.
Other gaps: `addCollateral` screening only the stored `loan.borrower` (not the
payer / current holder), ungated prepay-listing post/update, keeper preclose /
early-withdrawal paths screening only `msg.sender` (not the current NFT holder),
an unscreened `triggerLiquidationDiscounted` recipient, and the default
auto-dispatch matcher bonus. These are recorded in the matrix's *Open gaps* section and in
`_CodeVsDocsAudit.md` for triage — they are not closed by this change.

The sanctions Tier-1/Tier-2 split (borrower-flagged direction), the
blocked-claim-by-flagged-claimant case, and the full Terms-gate lifecycle
(disabled / accept / version-bump + hash-drift invalidation) remain covered by
`SanctionsOracle.t.sol` and `LegalFacet.t.sol` / `LibAcceptTermsTest.t.sol`; the
matrix references those as the existing oracle.

Closes #800.

## Thread — Keeper no-custody boundary: matrix + KEEPER_ACTION_ALL regression (PR #__)

Delegated keepers automate lifecycle actions (refinance, auto-extend, preclose,
intent fill/roll, early-withdrawal/loan-sale completion), but they must never be
custodians: a keeper cannot claim a user's funds, make an owner-only vault
withdrawal, transfer a position NFT, redirect a payout to itself, or weaken a
safety gate. (A keeper-driven action can still move the obligation the user
already owes — e.g. auto-extend forwards the borrower's accrued interest from
their vault to the lender/treasury — and earn the bounded VPFI housekeeping
reward; and a permissionless caller can earn a bounded matcher/liquidator bonus
or buy seized collateral by paying the debt — none of which hands over a user's
principal/collateral.) That boundary was enforced and correct in the code, but it
was reconstructable only from comments scattered across facets, and there was no
test proving it holds for a keeper approved with **every** action bit. This
change makes the boundary auditable from one place and pins the strongest case.

- **New matrix spec** — `docs/DesignsAndPlans/KeeperAuthorityMatrix.md` states
  the keeper delegation model (the three per-keeper gates + the global pause +
  the NFT-owner authority), the allowed delegated surface (action bit →
  function), and the no-custody boundary table (each owner-only /
  diamond-internal gate the keeper bitmask never reaches), plus the
  permissionless-trigger exception (repay / default / liquidation route the
  user's principal / collateral proceeds to the loan's parties — never to the
  caller — while still allowing the caller a bounded matcher / liquidator bonus
  or the purchase of seized collateral by paying the debt). Listed in the
  FunctionalSpecs README.
- **KEEPER_ACTION_ALL regression tests** — `ClaimFacetTest` now approves a keeper
  with `KEEPER_ACTION_ALL`, enables the master switch, and enables it for the
  specific loan, then proves it is **still** rejected (`NotNFTOwner`) on
  `claimAsLender`, `claimAsBorrower`, and `addCollateral`. The pre-existing
  reverts only used a non-keeper non-owner caller; these prove the action
  bitmask never reaches the custody paths.
- **UI copy** — Keeper Settings gains an explicit no-custody line: keepers are
  automation agents, never custodians; even one approved for every action cannot
  claim, withdraw, add/withdraw collateral, transfer a position NFT, redirect
  proceeds, or weaken a safety gate.

The other boundary rows (partial-withdraw owner gate, `vaultWithdrawERC20`
diamond-internal, NFT-transfer ERC-721 ownership, oracle-derived liquidation
min-out) are already pinned by existing tests
(`AddCollateralFacetTest`, `PartialWithdrawalFacetTest`,
`LiquidationMinOutputInvariant.t.sol`); the matrix references them.
(`LenderIntentCapital.t.sol`'s `test_rollIntentLoan_unauthorizedKeeper_reverts`
is cited separately as **allowed-surface** authorization coverage — proving an
unapproved keeper can't act on the AUTO_ROLL surface — not as a custody-boundary
row.) This is a hardening / regression card — no protocol behaviour
changed (test-only contract change; no `contracts/src/` / selector / ABI change).

Closes #803.
