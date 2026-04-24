# Release Notes — 2026-04-23 and 2026-04-24

Functional record of everything delivered across the two working sessions,
written as plain-English user-facing / operator-facing descriptions — no
code. Grouped by area, not by chronology.

## Privacy & consent

**Custom cookie-consent banner, Google Consent Mode v2 compatible.** On
a first visit, a banner slides up from the bottom with three equally-
prominent choices — *Reject all*, *Customize*, *Accept all*. Essential
cookies (session, anti-abuse) stay on regardless; everything else —
analytics, personalization, advertising — is off until the user
explicitly opts in. A "Customize" view lets users toggle each category
independently. Choices persist across visits. A "Cookie settings" link
in the footer re-opens the banner at any time so users can change or
revoke consent. Under the hood, tracking defaults are denied before
Google's tag loader fires, so no tracking cookies are created before a
decision is made.

**Advanced Consent Mode defaults.** Two defensive settings layered
on top of the banner, per Google's Advanced Consent Mode guidance:
`ads_data_redaction` ensures ad-click identifiers (gclid / dclid)
are redacted in outbound network requests while advertising consent is
denied, and `url_passthrough` preserves conversion attribution via URL
parameters instead of cookies when cookies are denied.

## Wallet connection (ConnectKit on top of wagmi v2)

**Mobile wallet apps open directly on tap.** When a mobile user taps a
wallet in our connect picker, they're sent straight to that wallet's
mobile app via a universal deep-link. QR fallback is still available
for cross-device pairing.

**First-connect chain prompt removed.** The picker used to force a chain
selection at connect time, which was the most common cause of
"connect button does nothing" on iOS. Removed.

**Unsupported-chain connections no longer silently refused.** A user
connected to a chain Vaipakam doesn't support can still sign in; they
see a switch-chain banner afterward rather than a blank no-op.

**WalletConnect project-ID check at startup.** A console warning fires
loudly in production if `VITE_WALLETCONNECT_PROJECT_ID` is missing from
the deployment environment, so a mis-config can't ship silently and
leave mobile users stuck on a raw QR.

## Site chrome and UX polish

- Left-side panel toggle now collapses instantly on click (previously
  required a second interaction).
- Removed a horizontal scrollbar that appeared inside the app layout even
  when content fit the viewport.
- "No wallet detected" is now shown as a yellow warning instead of a red
  error, matching how it actually affects the user.
- Analytics page: "Total NFTs rented" now shows in both the combined-all-
  chains summary and the per-chain breakdown.
- Buy VPFI link from the home page — fixed.

## Governance-config visibility on the app

**Live on-chain governance parameters now surface on loan-detail pages.**
A Lender-Discount card on each loan shows the effective time-weighted
VPFI discount for the current lender, computed client-side by
extrapolating the open-loan window against the on-chain discount curve.
Pages that need the protocol's fallback-split (lender / borrower)
configuration now read it from a shared hook rather than making a
custom contract call.

## Safe-app embed

**Vaipakam can be loaded as a Safe app inside a Safe multisig UI.** The
app auto-detects the Safe iframe context, auto-connects via the Safe
postMessage handshake (no wallet prompt needed), and the connected
"wallet" becomes the Safe itself. Content-Security-Policy headers
explicitly allow Safe's dapp-browser origins as frame ancestors. Outside
a Safe context the connector is a no-op — the normal browser flow is
unaffected.

## Internal migration: ethers → wagmi v2 + viem (not user-visible, unlocks future work)

The frontend has been migrated end-to-end from ethers.js to wagmi v2 +
viem. No change to any user flow, but the migration unlocks: first-class
mobile wallet deep-linking, built-in multicall batching, direct JSON-RPC
control for the log-indexer (which fixed several "chain switch broken"
bugs from public RPCs rejecting the old request shape), and a clean path
to future features like gasless transactions and smart-account / session-
key flows. The compatibility shim and the `ethers` dependency have been
removed entirely.

## Security sprint — item #1: Safe + Timelock + Guardian handover

**Three-role governance model installed across all privileged surfaces.**

- **Owner** (Governance Safe — e.g. 4/7 signers). Holds all slow
  admin surfaces: `diamondCut`, facet swaps, `setZeroExProxy`, LZ
  `setConfig`, UUPS upgrades, `setGuardian`, `unpause`. Every action
  goes through a 48-hour Timelock before executing — so any hostile
  proposal has a public 48h warning window during which it can be
  cancelled.
- **Guardian** (incident-response Safe — e.g. 2/3 signers). Can ONLY
  pause. Direct call, no timelock. Exists to close the detect-to-freeze
  window that a 48h timelock would otherwise introduce: in the April
  2026 cross-chain bridge incident, a 46-minute pause blocked ~$200M of
  follow-up drain, which under a pure timelock would have been impossible.
- **KYC Ops** (may be the same Safe as Guardian). Holds `KYC_ADMIN_ROLE`
  for per-user tier bumps — a same-hour operational surface, not a
  48h-grade action.

**Guardian-pause surface on every LayerZero OApp.** The canonical OFT
adapter, every mirror OFT, the buy-adapter / buy-receiver, and the
reward OApp all accept `pause()` calls from either the Guardian OR the
Owner. Unpause is deliberately Owner-only so a compromised Guardian
cannot race the incident team to re-enable a live contract. The shared
abstract uses ERC-7201 namespaced storage so the new guardian slot is
immune to inheritance-order drift across upgrades.

**Three new deploy scripts (run once per chain, in order):**

1. **Grant Ops Roles.** Seeds the Guardian Safe with `PAUSER_ROLE` and
   the KYC-ops Safe with `KYC_ADMIN_ROLE` on the Diamond. Must run
   before the ownership transfer, otherwise those roles get stranded.
2. **Transfer Admin to Timelock.** Moves the Diamond's owner and the
   five admin roles (`DEFAULT_ADMIN`, `ADMIN`, `ORACLE_ADMIN`, `RISK_ADMIN`,
   `ESCROW_ADMIN`) to the Timelock, and renounces every role the deployer
   EOA still holds — including the ops roles. This prevents the deploy
   hot-wallet from retaining any operational authority after handover.
3. **Migrate OApp Governance.** For each LayerZero contract on the
   chain plus the VPFI token: installs the Guardian Safe as guardian,
   then proposes the Timelock as new Ownable2Step owner.

After the scripts run, the Governance Safe schedules and then (48h
later) executes an `acceptOwnership()` call through the Timelock on
each two-step contract. From that point onward, every admin action
flows Safe → Timelock → Diamond/OApp.

**Operational runbook.** `docs/GovernanceRunbook.md` documents the full
sequence: Safe pre-flight, per-chain migration, readback verification,
day-to-day flows for routine admin actions, pause, unpause, signer
rotation, Guardian rotation, and full Timelock rotation.

**Automated verification.**

- Unit tests (`LZGuardian.t.sol`) cover the guardian/owner pause logic,
  ERC-7201 slot stability, and a 1,000-case fuzz of the authority check.
- Integration tests (`GovernanceHandover.t.sol`) simulate the full
  handover and assert every invariant listed in the runbook: Diamond
  owner is the Timelock, Timelock holds all admin roles, deployer has
  zero residual authority, Guardian can pause every OApp without
  waiting 48h, Guardian cannot unpause, attacker addresses revert on
  every surface. Idempotency is also asserted.
- The integration test caught a real gap in the original migration
  script: the deploy EOA was retaining `PAUSER_ROLE` and `KYC_ADMIN_ROLE`
  after handover. The script was updated to renounce both, with a
  sanity-check that a replacement holder already exists so a skipped
  Grant-Ops-Roles step is caught at tx-execution time rather than
  silently stranding the role.

## Security sprint — item #2: MEV protection on liquidation

Audit-of-record verdict: **already protected on-chain.** The two
liquidation paths (`RiskFacet.triggerLiquidation` and
`DefaultedFacet`) both construct the 0x swap calldata themselves
with an oracle-derived `minOutputAmount` (94% of expected proceeds,
i.e. a 6% slippage ceiling). The liquidator has no caller-controlled
input into the minimum — `triggerLiquidation` takes only a loan ID.
Sandwich attacks on the swap revert atomically because the slippage
guard is enforced by the DEX call itself.

**Invariant test (`LiquidationMinOutputInvariant.t.sol`)** locks this
guarantee in: exact-calldata `expectCall` assertion that the swap is
invoked with the oracle-derived `minOutputAmount`, across both a
deterministic case and a fuzz of caller identities. Any future refactor
that accidentally lets a caller influence the min-output floor fails
the test.

**L2 circuit breaker.** On L2s, HF-based liquidation already reverts
if the Chainlink sequencer-uptime feed reports the sequencer down or
still inside its 1-hour post-recovery grace window — so stale L2 prices
can't be sandwiched.

**Keeper delegation surfaced from loan detail.** The on-chain
`setLoanKeeperAccess` already lets a lender or borrower toggle keeper
execution on their side of an existing loan at any point in the loan's
life. Previously the toggle was only reachable from an advanced-mode
view. A basic-mode summary row now appears on every loan-detail page,
showing the viewer's current per-side flag with a one-click
Enable/Disable and a link to the full keeper-whitelist manager. So
borrowers and lenders can turn keeper delegation on or off at any
moment during a live loan without hunting for it.

**New on-chain surface: per-offer keeper toggle.** Symmetric to the
per-loan toggle, offer creators can now call `setOfferKeeperAccess` to
flip the keeper-access flag on an offer they've posted, at any point
before the offer is accepted. Before this change, the flag was
set-at-creation and immutable short of cancelling and re-posting. The
OfferBook row for a user's own offer now exposes a `Keepers: on/off`
toggle that fires this function and optimistically updates the list.

**MEV-protection UI education was deliberately NOT shipped.** Decision
of record: most users don't know what MEV or Flashbots is, and asking
them to reconfigure their wallet's RPC is poor UX. Instead, the protocol
exposes the existing Keeper system as the defensive lever, accessible
anytime during a loan's life. A protocol-operated "auto-defender"
bot that acts as a pre-whitelisted keeper for opted-in users has been
captured as a Phase 2 product decision (not a security deliverable) —
the scope and liability of running an operational bot service is too
large for a security sprint.

## Google Analytics / GTM integration (groundwork)

Google Analytics is integrated via gtag.js below `<head>`, with every
tracking category denied-by-default through Consent Mode v2 (see
Privacy & consent above). Inline consent defaults fire before the gtag
loader executes, so no pixels or cookies are created before the user's
choice lands.

## What's coming next (Security sprint — items #3 and #4)

### Item #3 — Oracle hardening (~6–7 days, multi-phase)

Today's system uses Chainlink-only for prices, with a two-tier
staleness window (2h for volatile feeds, 25h for stable pegs) and a
sequencer circuit breaker on L2s. The hardening plan:

- **Phase 3.1** — per-feed staleness override + minimum-valid-answer
  floor. Lets governance tighten freshness bounds for specific feeds
  (e.g. high-value collateral) and reject obviously-broken prices
  (a feed returning 1 during an incident). No new oracle dependencies.
- **Phase 3.2** — add Pyth (or Redstone) as a secondary source with a
  deviation check. If the two sources disagree by more than a
  governance-configured bound, the price read reverts — closing the
  single-point-of-failure class of exploit.
- **Phase 3.3** — documentation + readback test.

### Item #4 — Legal surface (~7–8 days, multi-phase)

Today's compliance surface is a country filter. Gaps:

- **Phase 4.1** — Terms of Service signing flow. Users sign a versioned
  ToS hash once per wallet; frontend gates the `/app` routes behind
  acceptance.
- **Phase 4.2** — Privacy Policy page and footer link.
- **Phase 4.3** — Chainalysis Sanctions Oracle integration: an
  address-level check at offer creation and loan initiation, on every
  chain where the oracle is deployed.
- **Phase 4.4** — "Delete my data" and "Download my data" buttons in
  the diagnostics drawer, for GDPR data-subject-rights compliance.

## Security sprint — item #3 Phase 3.1: per-feed staleness + min-answer floor

**Governance can now tighten or relax the oracle freshness budget on a
per-feed basis, and install a minimum-valid-answer floor on any feed.**
The previous model used two global constants — 2 hours for volatile
feeds, 25 hours for stable / peg-aware feeds — which meant every
Chainlink aggregator got the same tolerance regardless of its
underlying asset's volatility or business criticality. That's fine as
a default, inadequate for edge cases.

The new per-feed override lets the owner (the Timelock, after
handover) do three things without redeploying:

- **Tighten staleness on high-value collateral.** A 30-minute override
  on the WBTC or WETH feed reduces the blind window an attacker has
  during a sudden price move, at the cost of more frequent
  governance-initiated feed-config reviews.
- **Relax staleness on slow-heartbeat feeds.** A commodity or
  off-US-market-hours fiat feed can have an override longer than 2
  hours without needing the stable-peg trick, so it doesn't revert
  overnight or on weekends.
- **Reject obviously-broken readings.** A minimum-valid-answer floor
  catches the class of incidents where a compromised aggregator
  returns `1` or another nonsensical near-zero value — the override's
  min-answer check reverts before the bad price ever reaches
  downstream code.

When an override is active on a feed, the freshness path bypasses the
implicit stable-peg relaxation (which would otherwise let a
stablecoin-like feed be 25 hours old if it still read near $1). Once
an operator has taken explicit responsibility for a feed's budget, the
contract respects that explicit choice exactly. Passing
`maxStaleness = 0` to the setter clears the override entirely — both
fields reset — and the global two-tier defaults resume.

**Administration.** A new `OracleAdminFacet.setFeedOverride(feed,
maxStaleness, minValidAnswer)` writes the override under
ORACLE_ADMIN_ROLE. Readback via `OracleAdminFacet.getFeedOverride(feed)`
returns both fields for UI / monitoring surfacing. A
`FeedOverrideSet(feed, maxStaleness, minValidAnswer)` event fires on
every install and on every clear, so off-chain monitoring has a
reliable signal that a freshness budget changed. After the Timelock
handover completes, these become 48-hour-gated governance actions,
publicly observable via `CallScheduled` on the timelock.

**Verification.** Nine Foundry tests in `FeedOverride.t.sol` cover:
admin gating (non-owner reverts), zero-feed rejection, storage
roundtrip, clear-on-`maxStaleness=0`, tighter override rejects a
90-minute-old price that the global 2h ceiling would accept, looser
override accepts a 4-hour-old price that the global ceiling rejects,
min-valid-answer floor rejects a below-floor reading even when the
feed is fresh, min-valid-answer floor accepts at the floor exactly,
and clearing the override restores global two-tier behaviour. All
green; the full 80-suite forge test run also passes.

**Scope of what this does and does not do.** Phase 3.1 is the
single-oracle-hardening slice — it closes the "frozen or broken
single feed" class of risk. It does NOT address a compromised-but-
plausible-looking feed (one where the aggregator itself is forging
signed rounds that pass staleness AND answer-floor checks). That
broader class is what Phase 3.2 addresses by requiring a second,
independent source to agree within a configurable deviation.

## Security sprint — item #4 Phase 4.1 + 4.2: Terms acceptance + Privacy

**On-chain Terms of Service gate for `/app` routes.** Before a
connected wallet can use any `/app/*` page, it must sign a one-time
transaction recording its acceptance of the current Terms of Service.
The tx is a plain function call on a new `LegalFacet`, carrying the
exact version number and content hash the user was shown. Key
properties:

- **Cryptographically anchored.** The acceptance record is stored
  on-chain, time-stamped by the block, and indexed by the wallet
  address that signed. No cookie, no localStorage flag — the
  acceptance cannot be forged or silently cleared.
- **Version-bumping invalidates prior acceptances.** Governance can
  publish a new Terms version by calling `setCurrentTos(version,
  hash)` from an ADMIN_ROLE address (timelock-gated after the
  governance handover). Every existing user then sees the acceptance
  modal again on next `/app` visit and must re-sign before the
  frontend re-opens. Previous on-chain positions are unaffected —
  the gate is a frontend gate, not a protocol-level gate.
- **Gate-disabled state.** `currentTosVersion == 0` is the
  "pre-launch / testnet" posture: the gate code is live and runs but
  every wallet is implicitly accepted, so the frontend can ship the
  gating path without it firing. Governance sets the version to `1`
  at mainnet-launch to atomically activate the gate for all wallets.
- **Hash drift protection.** The acceptance record stores both
  version AND content hash. If governance ever has to correct a
  typo in the published Terms text, the corresponding version bump
  also invalidates every prior acceptance whose stored hash no
  longer matches — so no one is left holding a signature against
  text that's been silently edited.

**Frontend experience.** On first connect (or after a version bump),
the user sees a compact modal explaining the one-time tx, with a link
out to the full `/terms` page, a link to `/privacy`, and a "Sign &
Accept" button that fires the on-chain tx against the current pair.
No bypass paths. The gate is mounted on the app layout's render tree
so every `/app/*` route inherits it.

**Public Terms of Service + Privacy Policy.** `/terms` and `/privacy`
are full-text public pages; no wallet required. Source of truth for
the Terms is `docs/TermsOfService.md` — governance hashes this file's
content and posts it via `setCurrentTos`, and the JSX page mirrors
the same text verbatim so users see what they're signing. Privacy
Policy is a companion document (no on-chain signature required)
covering:

- What Vaipakam collects (on-chain activity, client-side diagnostics
  telemetry, Google Analytics only-on-consent, essential cookies)
  and what it deliberately does NOT collect (KYC documents, email,
  phone, ad identifiers, tracking pixels beyond GA).
- Who data is shared with (Google only with consent; no sales, no
  rental; narrow legal-compliance exception).
- GDPR / UK GDPR / CCPA rights and how to exercise them on
  Vaipakam — the "Delete my data" and "Download my data" buttons
  ship as part of Phase 4.4.
- Data transfer, retention, and change policy.

**Footer links.** The footer now carries a "Terms", "Privacy", and
"Cookie settings" link row alongside the existing copyright and
license notice. The Privacy page also has a clickable
"consent banner" reference that re-opens the banner mid-page.

**Verification.** 14 Foundry tests in `LegalFacet.t.sol` cover the
gate-disabled initial state, governance install, strict version
increase enforcement, user acceptance path, event emission, storage
roundtrip, rejection of mismatched version OR mismatched hash,
re-acceptance as a no-op that refreshes the timestamp, version-bump
invalidation of prior acceptances (including the same-version /
hash-drift edge case), and admin gating on `setCurrentTos`. A
1,000-case fuzz confirms any non-matching `(version, hash)` tuple
reverts. `tsc -b --force` green on the frontend.

**What Phase 4.1/4.2 do NOT yet include.** Address-level sanctions
screening against a Chainalysis oracle (Phase 4.3) and GDPR
delete/export UI buttons (Phase 4.4). Both remain scheduled.

## Security sprint — item #3 Phase 3.2: Pyth secondary oracle + deviation check

**Protocol-level defence against a single-oracle compromise.** Phase
3.1 tightened the Chainlink path; Phase 3.2 closes the "what if
Chainlink itself is manipulated" class of exploit by requiring a
second, independent oracle source (Pyth) to agree with Chainlink
within a configurable tolerance before a price is accepted. The
pattern is the same one Aave v3, Morpho Blue, and Euler v2 use for
high-value markets.

**How it works.**

- Governance installs the chain's Pyth contract address once per
  chain via `OracleAdminFacet.setPythEndpoint`. Canonical per-chain
  addresses are published by Pyth; Vaipakam's runbook will pin them
  before any mainnet rollout.
- Governance installs a Pyth secondary-feed configuration for each
  asset that should get the double-check, via
  `OracleAdminFacet.setPythFeedConfig(asset, priceId,
  maxDeviationBps, maxStaleness)`. Typical values: 5% deviation
  tolerance on volatile majors, 1% on stables, 30–120-second
  staleness window.
- Whenever `OracleFacet.getAssetPrice(asset)` is called and the
  asset has a Pyth feed configured, it reads BOTH oracles,
  normalizes Pyth's scaled reading into the primary Chainlink feed's
  decimals, and reverts `OraclePriceDivergence` if the two disagree
  beyond the configured tolerance. A stale, missing, or negative
  Pyth reading reverts `PythPriceUnavailable` — fail-closed by
  design, so a silent fall-through to single-source data cannot
  happen.
- When Pyth is NOT configured for an asset (the default),
  `getAssetPrice` behaves exactly as it did in Phase 3.1: Chainlink
  only.

**Two-transaction user flow.** Pyth is a pull oracle — its on-chain
state only refreshes when someone posts a signed update payload from
Pyth's off-chain network (Hermes). For price-reading Diamond actions,
the frontend now submits two sequential transactions from the same
wallet in nonce order:

1. `IPyth(endpoint).updatePriceFeeds{value: fee}(updateData)` —
   primes Pyth's on-chain storage with a fresh signed update.
2. The actual Diamond action (`initiateLoan`, `triggerLiquidation`,
   `addCollateral`, `refinance`, etc.).

Same EOA + same block = nonce-ordered delivery, so the Pyth price
cannot stale out between the two. This matches the pattern every
major Pyth-integrated protocol uses (Synthetix, Perennial,
Hyperliquid). The cost is one extra signature prompt; the benefit is
that the protocol-level defence is real — no attacker-manipulated
single-oracle read can produce a price the contract accepts.

**Why the two-tx pattern vs. a single-tx bundler.** An earlier design
for Phase 3.2 attempted to bundle the Pyth update and the Diamond
action into one atomic tx via a `PriceUpdateFacet` that
delegatecalled the inner action. The approach failed on Solidity's
automatic non-payable guard: `delegatecall` preserves `msg.value`, so
any non-payable action function reverts on receiving the outer tx's
value (which carries the Pyth update fee). The only clean fixes were
to mark every price-reading action function as `payable` — a large
surface change — or to break the `msg.sender` chain, which would
sink the existing authority checks. The two-tx pattern sidesteps
both, matches industry practice, and keeps the protocol surface
unchanged.

**Frontend helpers.** A new `lib/pyth.ts` module fetches signed
update payloads from Pyth's Hermes relayer (free, public, no API
key) and quotes the on-chain update fee. A `useWriteWithPythUpdate`
hook composes the two-tx flow: it reads the chain's configured Pyth
endpoint, fetches the update for the requested feed ids, submits tx
1, then submits tx 2. When the chain has no Pyth endpoint configured
or the feed list is empty, tx 1 is skipped — no user-visible change
vs. the existing single-tx flow. Integration into specific action
paths (loan initiation, liquidation, etc.) follows incrementally as
each page is wired.

**What this does NOT include (deliberately dropped from scope).** An
earlier proposal added a frontend CoinGecko / CoinMarketCap sanity
check as defence-in-depth. Dropped: any frontend check is trivially
bypassable via DevTools or a custom frontend, so it doesn't raise
the security floor. The on-chain Pyth deviation check is the only
layer that actually enforces a bound on what prices the protocol
accepts.

**Verification.** 16 Foundry tests in `PythDeviation.t.sol` cover:
admin gating (non-owner reverts on both setters), setter rejection
of obvious misconfig (zero asset, zero or ≥100% deviation, zero
staleness), clear-on-zero-priceId, fall-through to Chainlink when
no per-asset config OR no global Pyth endpoint, agreement passes
within tolerance, agreement passes at the boundary, divergence
reverts, stale Pyth reverts, missing Pyth reverts, zero or negative
Pyth reading reverts. All green.

## Security sprint — item #4 Phase 4.3: Chainalysis sanctions oracle

**Address-level sanctions screening joins the country-filter and
KYC-tier controls already in place.** A Chainalysis-style on-chain
oracle (the same one Aave, Compound, Maker, and most regulated DeFi
deployments use) is now queried at the two boundaries where Vaipakam
enters a new business relationship: offer creation and offer
acceptance. If the querying address is flagged — or if accepting an
offer would pair the acceptor with a creator that has since been
flagged — the transaction reverts at the protocol layer with a
`SanctionedAddress(who)` error.

**Deliberate scope choice: block "new business", not "ongoing".** The
check fires on `createOffer` (caller) and `acceptOffer` (both caller
and offer creator). It does NOT fire on `repay`, `addCollateral`,
`claim`, or any other loan-wind-down path — if a counterparty gets
sanctioned mid-loan, the other side must still be able to service
the loan to completion. This matches how regulated DeFi deployments
interpret OFAC compliance: block new relationships with sanctioned
persons, let existing relationships unwind.

**Oracle is per-chain, governance-installed, and optional.** Only
some chains have a Chainalysis oracle deployed — Ethereum, Base,
Arbitrum, Optimism, Polygon, BNB Chain. Mainnet deploys set the
per-chain oracle address via `ProfileFacet.setSanctionsOracle`
(owner-only; timelock-gated after the governance handover). Chains
without an oracle leave the slot at zero and the check becomes a
no-op — no brick on chains Chainalysis hasn't reached. An oracle
outage (the read reverts) is also fail-open: the alternative would
brick every protocol interaction on the chain whenever Chainalysis
has an availability incident, which over-reacts to a vendor gap.

**Frontend pre-flight check.** A new `useSanctionsCheck(address)`
hook and `<SanctionsBanner>` component show a red warning BEFORE a
user signs a doomed tx:

- On the **Create Offer** page, the warning renders against the
  connected wallet — users see "Your wallet: sanctions-screening
  match" before they waste gas on a revert.
- On the **Offer Book** accept-review modal, the check runs against
  BOTH the connected wallet AND the offer creator — matching the
  two-sided on-chain check. A would-be acceptor sees "Offer creator:
  sanctions-screening match" if the original author has been flagged
  between when they posted and now.

Both banners render nothing when no oracle is configured on the
active chain (silent UX on chains the feature doesn't cover) or
when the checked addresses are clean.

**Disclaimers shipped alongside.** The banner body is explicit that
Vaipakam does not maintain its own sanctions list — match disputes
route to Chainalysis directly, not to the Vaipakam team. This is
also reflected in the Terms of Service (`Prohibited use` section).

**Verification.** 12 new Foundry tests in `SanctionsOracle.t.sol`
cover: admin gating on `setSanctionsOracle` (non-owner reverts,
owner can set and clear), gate disabled = every address clean, gate
enabled + flagged address = `isSanctionedAddress` returns true,
oracle-outage fail-open returns false, `createOffer` reverts for
flagged caller, `acceptOffer` reverts for flagged acceptor,
`acceptOffer` reverts for now-flagged creator (the
post-offer-creation flag edge case). All 59 tests in the file green
(inherits 47 from the parent risk suite). Full forge suite green
(see regression gate).

## Security sprint — item #3 Phase 3.3 + item #4 Phase 4.4: docs + GDPR buttons

**New documentation.** Two new operator-facing pages under `/docs/`,
both written as standing playbooks rather than change-logs:

- `docs/OraclePolicy.md` — pin of the Chainlink-primary + Pyth-
  secondary model, per-chain recommended defaults (which chains use
  Pyth, which stay Chainlink-only, which use the stable-peg
  relaxation), per-feed override config, fail-closed semantics,
  two-tx user flow for Pyth-gated actions, verification checklist
  for pre-mainnet readback.
- `docs/MEVProtection.md` — enumeration of what the protocol
  actually enforces on-chain (liquidation slippage guard, oracle
  deviation check, L2 sequencer circuit breaker) vs. what remains
  user-level (defensive borrower / lender txs getting front-run).
  Documents the Keeper system as the main user-side MEV mitigation
  and records two decisions of record: no frontend sanity-banner
  (bypassable via DevTools), no protocol-operated auto-defender bot
  yet (deferred to Phase 5 product-decision).

Both files pair with the existing `GovernanceRunbook.md` as a
pre-mainnet reading set for new operators, auditors, and signers.

**GDPR data-subject-rights surface.** Two new buttons in the
Diagnostics drawer, under a "Data rights (GDPR / CCPA)" heading
distinct from the pre-existing support / debug buttons:

- **Download my data.** Exports every Vaipakam-namespaced entry in
  both `localStorage` and `sessionStorage` as a single JSON file —
  journey-log telemetry, consent-banner choice, cached event
  indexes. The export includes the browser user agent and a
  timestamp, and carries an embedded explanatory note so a user
  or regulator reading it later has the context without needing a
  separate document. Implements the Privacy Policy's "right to
  access" commitment.
- **Delete my data.** Two-step confirm that erases every
  Vaipakam-namespaced entry from both storages. On confirm the
  page reloads so every hook / banner rehydrates from the empty
  state: consent banner reappears, ToS gate re-prompts (if the
  on-chain gate is active), journey buffer starts fresh. The
  confirm dialog is explicit that on-chain positions are not
  affected — blockchain state is public and cannot be erased by
  any frontend action. Implements the "right to erasure" commitment.

**Verification.** Frontend `tsc -b --force` green. Full forge
suite (unchanged by these phases) still passes 1367/0/5.

**What's left after this phase.** The security sprint is complete
for items #1–#4. Phase 5 (borrower LIF discount → time-weighted
via claim flow) is queued and awaits a deliberate kick-off —
project memory records the decision and scope at
`memory/project_phase5_borrower_lif_discount.md`.

## Phase 5: borrower LIF discount becomes time-weighted + claim-based

**The old behaviour.** Until this phase, a borrower who held VPFI
in escrow and had consented to the platform VPFI-discount could
pay a tier-discounted Loan Initiation Fee (LIF) in VPFI instead of
the flat 0.1% in the lending asset — the discount was applied
upfront, priced off an instantaneous tier lookup of the borrower's
escrow VPFI balance at the moment the loan was accepted. That made
it gameable: a borrower could top up to tier-3 right before the
accept transaction, pocket the full discount, and unstake the VPFI
in the next block, earning a 0.075% fee against ~0 seconds of
actual VPFI-holding. The lender-side yield-fee discount already
used a time-weighted model that closed this gap; the borrower side
lagged behind.

**What changed.** The borrower VPFI-fee path now charges the
**full 0.1% LIF** up front in VPFI and moves the discount to the
back end. When a loan closes properly (normal repay, borrower
preclose, refinance), the protocol measures how much of the
loan's lifetime the borrower actually held VPFI, computes the
time-weighted average discount BPS over that window, and credits
the borrower a VPFI **rebate** equal to that average against what
they paid. On default or HF-based liquidation the rebate is
forfeited — the full up-front VPFI flushes to treasury. On
refinance the old loan pays out its rebate at settlement and the
new loan starts a fresh window with its own snapshot.

**How rebates are delivered.** The rebate is paid in VPFI, the
same medium the borrower originally funded the fee in. It shows
up alongside the normal borrower claim: the borrower claim path
now transfers both the collateral (or refund) and any pending
VPFI rebate in one transaction, and the NFT burns after. The
Claim Center surfaces a "+ rebate <N> VPFI" line under the main
claim row whenever a loan is eligible. Loans that took the
normal lending-asset fee path never accrue a rebate — that route
still exists and is unchanged, just no longer the only way for
a discount-conscious borrower to participate.

**Who holds the VPFI between init and settlement.** The Diamond
now custody-holds the borrower's up-front VPFI for the full loan
lifetime. Old behaviour pushed it straight to the treasury; new
behaviour retains it so settlement can split the held amount
between the borrower's rebate and the treasury's share without
needing treasury to pre-approve outbound transfers. The per-loan
custody bookkeeping carries two numbers: the amount held while
the loan is live, and the amount claimable once the loan settles
properly. Both zero out when the loan reaches terminal state or
the claim runs.

**The stamp-refresh correctness fix.** The same update that ships
Phase 5 also fixes a latent bug in the shared time-weighted
accumulator that backed the lender yield-fee discount. The old
accumulator, on every escrow-VPFI balance change, closed the
just-ended period correctly at the previous tier but then re-
stamped the next period's BPS against the pre-mutation balance
instead of the post-mutation one. A user could therefore unstake
down to tier-0 and keep earning the high-tier stamp on the new
period until the next balance change — the exact gaming vector
Phase 5 was meant to close on the borrower side. The accumulator
now re-stamps against the post-mutation balance, so a balance
drop takes effect immediately for every open loan's time-weighted
average. This affects both the lender yield-fee discount and the
new borrower LIF rebate; lenders who were unknowingly benefiting
from the stale stamp will earn correctly-sized discounts going
forward.

**Frontend surfacing.** The OfferBook accept-review modal
explains the new flow explicitly — "you pay the full 0.1% LIF
up front in VPFI; the discount is earned time-weighted over the
loan's lifetime and paid back as a VPFI rebate on proper close."
The same language appears on the CreateOffer borrower-tip card
("earn up to a 24% VPFI rebate"), and the Claim Center row adds
the rebate line when applicable. The tier-aware preview keeps
showing tier 1–4 positioning so a user can see how much rebate
they'd earn at full-term hold, but no longer labels the up-front
fee itself as discounted.

**Storage layout.** Two additions, both append-only at the tail
of their structs so existing slots are untouched. The Loan struct
gains a borrower-side anchor mirroring the already-present
lender anchor. The diamond's global storage gains a mapping
keyed by loan id carrying the per-loan held-VPFI and claimable-
rebate pair. In-flight loans that predate the upgrade have zero-
valued entries and are silently ineligible for the rebate —
they never paid VPFI up front, so there's nothing to split.

**Settlement coverage.** Five loan-terminal paths are wired:
repay (proper close → rebate credited), preclose direct (same),
preclose-via-offset (same — the original borrower still earned
the held time), refinance (old loan settles properly, new loan
gets a fresh anchor), default (full forfeit), HF liquidation
(full forfeit). Late-but-repaid loans route through the normal
repay path and still get the rebate — lateness penalises via
the late fee, not via rebate eligibility.

**Diamond-cut update.** The new view function
`getBorrowerLifRebate(loanId)` is registered against the Diamond
in both the test setup harness (`HelperTest.getClaimFacetSelectors`)
and the production deploy script (`DeployDiamond._getClaimSelectors`).
Mainnet upgrade flow must include a `diamondCut` add-selector
operation for this entry — without it the frontend's claim-center
rebate probe falls through to its "old ABI" branch and treats every
loan as having zero rebate.

**Verification.** Forge build clean (full re-compile after struct
changes — `bytes4` selector tables and `LibVaipakam.Storage` /
`Loan` layout extensions all type-check). Existing
`VPFIDiscountFacetTest.t.sol` regression: 24/25 pass; the one
flagged test was the upgraded
`testAcceptOfferWithVPFIDiscountApplied` whose new assertions
exercise the just-added `getBorrowerLifRebate` selector — it
flagged because the test-harness diamond cut also needs the
new selector. Selector wired into `HelperTest` and re-run
expected to clear it. New Phase 5 test additions (tier-gaming
verification, long-hold, partial-hold, per-settlement-path
coverage, claim-flow, default / liquidation no-rebate) are the
next commit.

## Frontend / UX fixes shipped alongside Phase 5

These are independent quality-of-life fixes batched with the same
Phase 5 commit, so the deploy doesn't need a separate frontend
release.

**Sidebar stuck-expanded after click.** The collapsed icon-rail
sidebar would expand on hover (and on `:focus-within`, for keyboard
accessibility). Clicking a navigation item left the link focused,
so `:focus-within` kept the rail expanded after the cursor had
already moved away — the rail only collapsed when the user clicked
somewhere else and dropped the focus. The mouse-leave handler now
blurs any focused descendant on exit, which collapses the rail
immediately for mouse users. Keyboard-only navigation never fires
mouseleave, so tabbing between icons still works correctly.

**Offer Book tab counts.** The "Open" / "Closed / Filled" tab
headers used the raw log-index ID counts, which can include stale
entries when an offer is canceled or accepted between event
indexing and the tab render. The active tab now shows the verified
count from the actual fetch; the inactive tab gets validated by a
parallel `getOffer` multicall across its full ID list (filtering
out zero-creator and accepted-status mismatches the same way
`fetchBatch` does). Both numbers now match what the user sees
after switching tabs.

**Offer Book pagination.** The "Lender Offers" and "Borrower Offers"
single-side tabs gain real pagination: a Previous / Page X of Y /
Next control under the table when there are more rows than the
per-side cap. Page resets on tab change, filter change, perSide
change, or status-view change. The "Both Sides" tab stays on the
existing top-N-of-each-side layout so the two columns stay
aligned without competing paginators.

**Error alert dismiss button.** Every `ErrorAlert` (the shared
component used across pages) now renders a dismiss `X` next to the
"Report on GitHub" link. Default behaviour hides the alert locally
via internal state; the dismissed state resets when the message
changes so a fresh error always surfaces. Pages that need
authoritative state clearing can opt in via the new `onDismiss`
prop; no existing caller had to change.

## Phase 6: keeper per-action authorization

**The old model.** Before this phase, keeper authority was a single
boolean: the user had a master `setKeeperAccess(true)` switch, a
whitelist of up to five keeper addresses via `approveKeeper`, and
per-offer / per-loan "keepers enabled" bools. Only two entry points
actually accepted keeper callers (completeLoanSale and completeOffset
— the two step-2 completion helpers) and the authority was all-or-
nothing: a whitelisted keeper could either drive both step-2s on a
loan or neither. Adding a new delegable action required expanding
the whitelist semantic for every user.

**What changed.** Each whitelisted keeper now carries a **per-action
bitmask** that lists exactly which actions they're authorised to
drive. Five actions are delegable today (three newly opened, two
pre-existing):

  - CompleteLoanSale (early-withdraw step 2 — existing)
  - CompleteOffset (preclose-via-offset step 2 — existing)
  - InitEarlyWithdraw (createLoanSaleOffer — **new**)
  - InitPreclose (preclose direct + transferObligationViaOffer +
    offsetWithNewOffer — **new**, three sites, one action bit)
  - Refinance (refinanceLoan — **new**)

Repay, add collateral, and claim stay user-only by explicit design —
they're money-out operations, not delegable.

**Per-loan keeper selection.** The old single "keepers enabled on
this loan" bool is replaced by a per-keeper-per-loan enable mapping.
The offer creator enables specific keepers on their offer pre-
acceptance; those enables latch into the live loan at acceptance,
and each NFT holder can edit the loan-level enable list afterwards.
Authority at call time requires all three gates to pass: user's
master switch + per-loan keeper enabled + keeper's action bit set.
Any one of the three failing blocks the call.

**Canonical LibAuth helper.** The two per-side helpers
(`requireLenderNFTOwnerOrKeeper`, `requireBorrowerNFTOwnerOrKeeper`)
are replaced by a single `requireKeeperFor(action, loan, lenderSide)`
that every keeper-accepting entry point calls. This centralises the
three-gate check in one place and makes the "which actions does this
entry point allow keepers on" question trivial to read by grep.

**Storage layout (pre-launch — no migration).** Because we're pre-
launch the storage was refactored in place rather than appended:

  - The `approvedKeepers[user][keeper] = bool` mapping became
    `approvedKeeperActions[user][keeper] = uint8` (action bitmask —
    five bits used, three spare for future actions).
  - New `loanKeeperEnabled[loanId][keeper]` mapping for per-loan
    enables.
  - New `offerKeeperEnabled[offerId][keeper]` mapping for pre-
    acceptance enables, latched into `loanKeeperEnabled` at
    acceptance via the creator's bounded whitelist iteration.
  - The `lenderKeeperAccessEnabled` and `borrowerKeeperAccessEnabled`
    per-loan bools were removed from the Loan struct — redundant
    under the per-keeper enable model. Same for the single
    `keeperAccessEnabled` bool on the Offer struct and
    CreateOfferParams.
  - The master per-user `keeperAccessEnabled[user]` switch remains —
    useful as a one-tx "pause all keepers for me" emergency lever
    without tearing down the whitelist.

**Facet wiring.** Seven entry points now gate via the new helper:

| Facet | Function | Required action |
|---|---|---|
| EarlyWithdrawalFacet | createLoanSaleOffer | InitEarlyWithdraw |
| EarlyWithdrawalFacet | completeLoanSale | CompleteLoanSale |
| PrecloseFacet | precloseDirect | InitPreclose |
| PrecloseFacet | transferObligationViaOffer | InitPreclose |
| PrecloseFacet | offsetWithNewOffer | InitPreclose |
| PrecloseFacet | completeOffset | CompleteOffset |
| RefinanceFacet | refinanceLoan | Refinance |

**API changes on ProfileFacet**:

  - `approveKeeper(keeper)` → `approveKeeper(keeper, uint8 actions)`
    — action bitmask is mandatory on add. `InvalidKeeperActions`
    reverts on zero or out-of-range bits.
  - New `setKeeperActions(keeper, uint8 actions)` — edit the bitmask
    on an existing whitelisted keeper (reverts if keeper isn't on
    the list).
  - `setLoanKeeperAccess(loanId, enabled)` → `setLoanKeeperEnabled(
    loanId, keeper, enabled)` — per-keeper-per-loan toggle.
  - `setOfferKeeperAccess(offerId, enabled)` → `setOfferKeeperEnabled(
    offerId, keeper, enabled)` — same pre-acceptance flavour.
  - `isApprovedKeeper(user, keeper)` kept for backward-friendly
    "any action set" reads; new `getKeeperActions(user, keeper)`
    returns the raw bitmask.
  - Added `isLoanKeeperEnabled(loanId, keeper)` + `isOfferKeeperEnabled(
    offerId, keeper)` views for frontend rendering.

**Onboarding UX.** The frontend per-offer / per-loan keeper selector
shows the user's global whitelist as a checklist. Empty whitelist
deep-links to the KeeperSettings page with a "no keepers added yet
— add some first" prompt. This closes the flow-of-control gap
where users who didn't know keepers were a thing couldn't find
their way to the settings page.

**Diamond-cut update.** The `ProfileFacet` selector table grows from
17 to 22 function selectors (five new, two replaced). The mainnet
upgrade `diamondCut` operation must add the new selectors in the
same transaction as removing the old ones (`setLoanKeeperAccess`
and `setOfferKeeperAccess`). Both the test harness
(`HelperTest.getProfileFacetSelectors`) and the production deploy
script (`DeployDiamond._getProfileSelectors`) were updated.

**Verification.** Forge build clean after the 10-file src-side
refactor. Existing `VPFIDiscountFacetTest` regression holds at
25/25 after the selector table + test-helper migration. **15 new
Phase 6 targeted tests** added and green (9 in `ProfileFacetTest`,
6 in `PrecloseFacetTest`) covering:

- `InvalidKeeperActions` reverts on zero bitmask + on bits outside
  `KEEPER_ACTION_ALL` (0x1F).
- `approveKeeper` records the bitmask correctly + rejects
  duplicate adds with `KeeperAlreadyApproved`.
- `setKeeperActions` replaces (not OR-merges) the bitmask,
  rejects zero (must use `revokeKeeper`), and rejects un-approved
  keepers.
- `revokeKeeper` clears the bitmask to zero and restores
  `isApprovedKeeper == false`.
- `KeeperWhitelistFull` fires at the 6th `approveKeeper` call per
  user (MAX_APPROVED_KEEPERS = 5).
- Per-action isolation: a keeper with the correct action bit
  passes the gate, a keeper with the wrong action bit
  (`REFINANCE` vs. `INIT_PRECLOSE`) is rejected with
  `KeeperAccessRequired`, a keeper without per-loan enable is
  rejected, and a keeper with all gates green but the user's
  master switch off is still rejected.
- `setLoanKeeperEnabled` / `setOfferKeeperEnabled` auth: non-NFT-
  owners rejected; post-acceptance edits blocked.

Full forge regression: **1384 passed / 0 failed / 5 skipped** (up
from the pre-Phase-6 baseline of 1367). The 5 previously-failing
`test*RevertsNotNFTOwner` tests across the three strategic-flow
facets were updated to expect `KeeperAccessRequired()` instead of
`NotNFTOwner()`, reflecting the unified `requireKeeperFor` gate
that merged the two prior helpers.

## Security + Legal sprint — (A) and (B) audit confirmation

Before planning the next sprints a full audit against the broader
industry checklist (Aave/Compound/Maker/Morpho/Euler standards)
was run. Both the Security-first track (A) and the Legal/compliance
track (B) are already complete in this release cycle — itemised
confirmation here so future sprints can start from a settled
baseline.

**(A) Security-first track — shipped**:

- **Admin-action timelock + Safe over Diamond owner.** A 48h OZ
  `TimelockController` sits behind a multi-sig Safe. Every
  `diamondCut`, `setZeroExProxy`, allowance-target change, or
  config setter is Safe-proposed → 48h delay → executed. Deploy
  + handover scripts live in `contracts/script/DeployTimelock.s.sol`
  + `contracts/script/TransferAdminToTimelock.s.sol` +
  `contracts/script/MigrateOAppGovernance.s.sol` (the last
  migrates every LayerZero OApp/OFT + the VPFI token to the same
  governance). `GovernanceHandover.t.sol` is the regression gate
  asserting no deployer-EOA role leaks survive handover.
- **Oracle redundancy + staleness bounds.** Chainlink primary with
  per-feed `maxStaleness` overrides (Phase 3.1), plus a Pyth
  secondary with a configurable deviation check that fails closed
  on divergence (Phase 3.2). L2 sequencer-health circuit breaker
  gates every feed read on rollup chains.
- **MEV-protected liquidation.** On-chain `minOutputAmount` guard
  enforced in `RiskFacet` and `DefaultedFacet` — oracle-derived at
  94% of expected proceeds (6% slippage ceiling). Users route
  their own wallets through Flashbots Protect or MEV Blocker per
  the `docs/MEVProtection.md` runbook; the 6% gate holds
  regardless. Phase 7a will make the 6% ceiling governance-
  configurable inside a 1–20% range.

**(B) Legal/compliance track — shipped**:

- **Terms-of-Service signing flow.** `LegalFacet.acceptTerms(version,
  hash)` is an on-chain, wallet-signed record bound to the current
  ToS version + content hash. The `LegalGate` frontend component
  wraps every app page and re-prompts on version bumps. Admin
  `updateCurrentTos` is ADMIN_ROLE + Timelock-gated so ToS
  changes can't be silently rolled out.
- **Privacy Policy + GDPR export/delete.** Per-user "Download my
  data" and "Delete my data" buttons ship in the Diagnostics
  drawer (Phase 4.4). Export packs every Vaipakam-namespaced
  localStorage/sessionStorage entry with a timestamp + user-agent
  + explanatory note. Delete wipes both storages and reloads so
  every hook/banner/cache rehydrates empty. The public policy
  page is at `docs/PrivacyPolicy.md`.
- **OFAC on-chain sanctions screen.** `ProfileFacet.setSanctionsOracle`
  wires per-chain Chainalysis oracle; `isSanctionedAddress` is
  checked on both sides of `acceptOffer` (catches the "creator
  was clean when they posted but got flagged before anyone
  matched" edge case). Fail-open on oracle outage — conservative
  policy vs. Chainalysis having a hiccup. Frontend pre-flight
  banner so users see the warning before signing a doomed tx.

**Implication.** A and B are both behind us. The next sprints are
about competitive UX polish ((C)) and growth ((D)); the
protocol's mainnet-defensibility bar is already cleared.

## Phase 7 scoping — swap + liquidity redundancy (queued)

All 7 design questions resolved; implementation pending Phase 6
tests + docs wrap. Ships as two independent sub-phases.

**Phase 7a — swap router redundancy.** Gearbox-style ordered
multi-adapter: **0x → 1inch v6 → direct Uniswap V3 → direct Curve
stableswap**. Each adapter is a thin ~30-LOC wrapper under a
common `LibMultiVenueSwap.swap(...)` dispatcher. Atomic within a
liquidation tx; ~2× gas on the fallback path only. Replaces the
current single-router setup in `RiskFacet`, `DefaultedFacet`, and
`ClaimFacet._attemptRetrySwap`.

**Phase 7b — liquidity-check redundancy.** OR-logic across
**Uniswap V3 + Curve + Balancer V2**. A token is Liquid iff any
one of the three venues returns a pool with depth ≥
`MIN_LIQUIDITY_USD`. Balancer coverage is load-bearing for
ERC-4626 LSTs (weETH, rsETH, etc.) and stablecoin pairs that
Curve doesn't carry.

**No per-asset whitelist** — the platform is open for any ERC-20.
This is a deliberate Morpho-Blue / Euler-v2 philosophy choice
rather than the Aave/Compound governance-whitelist model. The
Liquid vs Illiquid classification is automatic from the three-
venue depth check, so the protocol still picks the correct code
path at liquidation time (swap vs full-collateral transfer) for
any asset.

**Slippage ceiling becomes governance-configurable.** The current
hardcoded 6% moves to `ProtocolConfig.maxLiquidationSlippageBps`
with a 1–20% (100–2000 bps) range enforced in the setter.
Governance path is admin multisig → Timelock → Diamond for now;
transitions to full on-chain governance later. Default stays at
600 bps (6%).

**Readback test.** LZConfig.t.sol-style assertion suite verifies
every expected (chain, venue) mapping resolves to the right
pool factory / router / registry before a mainnet deploy ships.

Effort estimate: 7a ≈ 3.5 days; 7b ≈ 3 days. Parallel wallclock ≈
4 days.

## Phase 8 scoping — UX polish sprint ((C) on the audit list)

The (C) audit found 5 of 6 UX-parity items missing and 1 partial,
so (C) warrants a full sprint. Splitting into two sub-phases by
effort + review window:

**Phase 8a — highest-leverage, no contract changes (~1 week)**:

- **ENS / Basenames resolution** everywhere addresses render. Use
  viem's `getEnsName` on mainnet reads + Base's basename resolver.
  Per-session cache. Current state: every address renders as
  `0x1234…abcd`; replaces with `nick.eth` / `nick.base.eth` where
  available, falls back to the shortened hex when not.
- **Liquidation-price calculator with what-if slider.**
  `RiskGauge` already renders the current HF with a liquidation-
  threshold tooltip. Phase 8a adds:
  1. The **projected liquidation price** of each collateral asset
     ("your position liquidates if ETH drops below $X") computed
     off `calculateHealthFactor` + current oracle prices.
  2. A **what-if slider** letting the borrower model the impact
     of adding collateral, partial repayment, or collateral-price
     moves ("if I add Y more collateral, liquidation moves to
     $Z"; "if ETH drops 10%, HF becomes W").
  Pure UI math — no contract changes.
- **Health-factor alerts via Telegram AND Push Protocol.** User
  picks one or both channels in Settings. Both rails ship so
  every user can use whichever they prefer without install
  friction:
  - **Telegram bot**: user pastes their @handle, a small off-
    chain watcher polls active loans and pings when HF drops
    below configurable thresholds. Universal, no wallet plug-in
    needed.
  - **Push Protocol**: fully on-chain, no hosted infra. Users
    with Push wallet integration installed get native in-wallet
    notifications.
  Per-user thresholds (e.g., warn at HF 1.5, alert at 1.2,
  critical at 1.05) stored in the user's own local preferences;
  the off-chain watcher reads them via signed get-settings.
- **Revoke-allowance UI in-app.** Settings gains an "Allowances"
  page covering three asset sets:
  1. **Diamond allowances** — live `allowance(user, diamond)`
     for every asset tracked by MetricsFacet or that the user
     has ever offered / collateralised.
  2. **User-interacted asset list** — derived from indexed
     events (OfferCreated, LoanInitiated, Repaid, etc.) so
     every token the user has touched through Vaipakam is
     surfaced even if no live allowance remains.
  3. **Canonical assets** — the standard ETH/WETH/USDC/USDT/
     DAI/WBTC/VPFI list per chain, to catch any stale approval
     the user might have set outside the app but forgotten.
  Each row has a "Revoke" button that sets allowance to 0.
  Mirrors Uniswap / 1inch's in-app revoke flows.

**Phase 8b — contract changes + external API integration (~1 week)**:

- **Permit2 integration** for one-click `acceptOffer` + `createOffer`.
  `OfferFacet` learns to accept a Permit2 signature payload and
  calls the Uniswap Permit2 router's `permitTransferFrom`
  instead of requiring a separate `approve` tx. Huge flow win —
  one signature vs. two wallet popups.
- **Transaction simulation preview.** Pre-flight simulation via
  Blockaid or Tenderly's API. Before the wallet's confirm screen
  shows, render "this transaction will: transfer X, receive Y,
  update HF to Z". Client-side only. Closes the "blind signing"
  UX gap.

Total Phase 8 effort: ~10 days, split into two 1-week sub-phases
for independent review and ship cadence.

## Growth sprint ((D)) — queued behind Phase 8

Per the industry audit, the growth items (points/leaderboards,
Farcaster Frames, PWA manifest, public keeper-bot reference repo)
are net-additive and cleanly follow Phase 8's UX polish. No
security or defensibility implications; pure optional lift. Will
scope separately once Phase 8 is in hand.

## Documentation convention going forward

Every completed phase gets a functional write-up appended here, in the
same plain-English style. No code — function names and tables stay in
the code base, this file is for describing behaviour to a non-engineer

reader (auditor, partner team, regulator). Each new working day's
deliveries land in a fresh dated file under `docs/ReleaseNotes-…md`.

**Continued in [`ReleaseNotes-2026-04-25.md`](./ReleaseNotes-2026-04-25.md)** —
covers Phase 8a (ENS handle resolution, liquidation-price calculator,
Health-Factor alert infrastructure, allowance revoke surface), Phase 8b
(Uniswap Permit2 single-tx flows + Blockaid transaction-scan preview),
and Phase 7a (4-DEX swap failover replacing the single-0x liquidation
path).
reader.
