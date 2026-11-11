# Vaipakam governance-minimisation roadmap (#404, #3438)

> Status: **published commitment, pre-audit draft.** First written
> 2026-06-19 for #404 (research verdict: ADOPT a *staged* ossification
> roadmap, not immediate immutability; the research is in
> [`Research-404-OssificationRoadmap.md`](Research-404-OssificationRoadmap.md)).
> Revised 2026-11-11 for #3438 (owner decision 2026-11-09): it now states
> the rule every trusted piece follows today, an inventory of every trusted
> piece, per-component exit criteria, what stays governed for good, how users
> are told, and how a final non-upgradeable version fits the one-fresh-deploy
> rule. It keeps its #404 file name so existing links still resolve; #3438
> asked for `GovernanceMinimisationRoadmap.md`, and one document is cleaner
> than two that would drift apart.

## 0. TL;DR

Vaipakam is upgradeable today, on purpose: before an audit and real-world
use we must be able to fix bugs. Trust in governance shrinks over time on a
published path:

1. **Today, every trusted piece follows one rule** (§1): it can only
   tighten or delay, never move user funds; it is slower than the user's own
   way out; it is visible before it takes effect; and the user can avoid it
   where that is possible. §1 also lists, by name, where the code does not
   yet meet the rule.
2. **An inventory** (§2) lists every role, pointer and upgrade path, who
   holds it after handover, what it can and cannot do, and its delay.
3. **Hardening is per component, not one big switch** (§5): each component
   has its own exit criteria. Pieces that are already non-upgradeable (the
   vault beacon, the position NFT, the registry, the price guard) narrow what
   their owner may still change; the lending core and the vault code finally
   move to a **non-upgradeable version that users opt into** (§6).
4. **Some things stay governed for good** (§7): sanctions screening, the
   price sources offered to new loans, the stop-only pause, and parameters
   for new markets inside fixed bounds.
5. **Users are told** at each step, before it happens (§8).

We deliberately do **not** over-promise immutability we don't have. The
guardian fast-pause (§3) and the timelock shape (§4) are unchanged from the
#404 commitment. Two honesty notes on the delay and the cancel lever:

- The **48–72h** Timelock figure is a deploy commitment with a code-enforced
  floor under it. `DeployTimelock.s.sol` reads `TIMELOCK_MIN_DELAY` from env
  (default `172800` = 48h) and refuses less than 48h on any chain that is not
  a known testnet. Once deployed, the Timelock's delay can never be lowered
  below that deploy-time value (`MIN_DELAY_FLOOR`, #938), even through the
  Timelock itself; a shorter delay needs a new Timelock.
- The guardian-pause **halts user flows** during the delay window but does
  **not** cancel a queued upgrade — the diamond-cut path is intentionally left
  callable while paused (it's the incident recovery lever). Cancelling a
  scheduled timelock op is the **timelock canceller's** lever. Two parties
  hold it (#938): the proposer (the governance multisig) and an **independent
  canceller**, the Pauser Safe, which can cancel but not propose. So
  cancellation no longer assumes the proposer key is uncompromised. The
  limit: the Pauser Safe cannot cancel a single-call operation that removes
  it as canceller, so a captured proposer can remove it, but only after one
  public delay, during which the Pauser Safe can still cancel everything
  else the proposer has queued.

## 1. The rule every trusted piece follows today

Owner decision 2026-11-09 (#3438). Every trusted piece (a role, an owner, a
guardian, a pointer, an upgrade path) is held to four tests:

1. **It can only tighten or delay, never move user funds.** A fast lever
   stops, refuses or postpones; nothing a trusted key does alone sends a
   user's assets anywhere.
2. **It is slower than the user's own way out.** A change that could affect
   what a user holds waits longer than the user needs to leave first.
3. **It is visible in advance.** A queued change is public, and the app and
   alerts show it during its wait (#3237 for the Timelock queue, #3422 for
   vault code).
4. **The user can avoid it where possible.** A loan's external choices
   (price sources, swap routes, marketplace) are fixed when it opens and can
   only be removed, never swapped (#3437); a vault owner may pin a vault
   version and is never moved off it except by a revocation.

**Where the code meets the rule today, and where it does not yet.** Stating
the gaps is part of the commitment; each has an issue.

| Test | Met today | Not yet met | Closed by |
| --- | --- | --- | --- |
| Never moves user funds | The pause, the guardian cancels and the emergency revoker stop things only. The notification biller moves a fixed, consented fee once per loan side (see §5's carve-out). | A Diamond code change (a diamond cut) can change how funds move once its delay ends, and the Diamond still decides some vault outflows by itself. | The vault checks outcomes, not the Diamond's say-so (#3431, #3205 Stage B); the vault-side exit (#3424). |
| Slower than the user's exit | Vault code waits the beacon's code delay, and a pinned vault never takes new code. | The test needs each change's delay to be **strictly longer** than the exit it races, plus a stated margin for the user to act. Neither path meets that. The vault code delay and the escape period are both 3 days today (so new code can land the moment escape opens), and the planned 7 and 7 days would still leave no margin. The Diamond's 48h Timelock delay is far shorter than the 14-day vault-side exit (#3424), so making that exit independent of the Diamond does not make it finish first. | **Vault code:** #3421 and #3441 must set the code delay longer than the escape period plus a published margin; equal figures do not close this. **Diamond:** a faster exit cannot win against 48h, so this closes only when a Diamond change can no longer reach vault assets at all (#3431, #3205 Stage B), with the vault-side exit (#3424) as the route out. Until both hold, this test stays an open gap. |
| Visible in advance | Every delayed change emits an event when it is queued. | No app surface yet shows queued Timelock or vault-code changes to users. | #3237, #3422. |
| Avoidable | Vault pins (#3204). | A loan's price sources and routes follow live settings. | #3437. |

## 2. Inventory: who holds what after handover

As of `main` on 2026-11-11. The canonical handover (`Handover.s.sol`, gate
`HandoverGate.s.sol`) moves every listed authority, and every other owned
contract `ChainContracts.walk` finds, to the holder named here. A contract
owned by the Diamond itself (the backstop vault, the aggregator adapter
proxies) is governed through Diamond code, so through the Diamond's own
holders. This table is per component; the exhaustive per-setter list is
#651's code-derived census, still open.

**Holders.** *Timelock*: the governance Safe proposes, the Timelock executes
after its delay (48h floor), the Pauser Safe may cancel. *Pauser Safe*: fast
stop-only levers. *Governance Safe*: proposer, plus the one zero-delay
emergency revoke. *Bot keys*: the keeper, watcher and notification biller.

### 2.1 The Diamond

| Authority | Holder | Can | Cannot | Delay |
| --- | --- | --- | --- | --- |
| ERC-173 owner (diamond cut, ownership) | Timelock | Add, replace or remove any facet code; a few owner-only setters (the sanctions list pointer, the liquidity-classification factory, tier reference assets, peer-protocol addresses) | Be renounced or moved to the zero address (#906) | Timelock |
| `DEFAULT_ADMIN_ROLE` (role root) | Timelock (D1, #934) | Grant and revoke every other role; `transferAdmin` | Act without the delay | Timelock |
| `ADMIN_ROLE` (about 190 setters) | Timelock | Protocol settings: fees within `MAX_FEE_BPS`, risk and liquidation settings within their ranges, keeper and reward settings, the rate model pointer, the collateral-sale executor pointer | Change an open loan's treasury fee on interest or liquidation discount (both stamped per loan; the initiation fee is charged once, at acceptance); exceed a setter's range. It **can** change, within range, two settings read live when an open loan is liquidated or force-sold: the liquidation handling fee (taken from proceeds that would otherwise return to the borrower) and the liquidator incentive cap. Stamping both per loan is an open gap (#3534) | Timelock |
| `VAULT_ADMIN_ROLE` (about 26 functions) | Timelock | Backstop vault settings and its upgrade; aggregator adapter template; sweep tokens sent to the backstop vault by mistake (never protocol position NFTs); set the vault beacon once | Change the vault beacon after it is set; move code into user vaults (that is the beacon's job) | Timelock |
| `RISK_ADMIN_ROLE`, `KYC_ADMIN_ROLE`, `ORACLE_ADMIN_ROLE` | Timelock | Minimum health factor; KYC tiers (dormant on retail); nothing (`ORACLE_ADMIN_ROLE` gates no function) | — | Timelock |
| `UNPAUSER_ROLE` | Timelock | Lift a pause | — | Timelock |
| `PAUSER_ROLE` | Pauser Safe | Pause at once | Unpause; change any setting | None |
| `EMERGENCY_REVOKER_ROLE` | Governance Safe | Strip a role from a compromised hot key | Grant anything; touch the role root or anything the Timelock holds | None |
| `WATCHER_ROLE` | Watcher bot | `autoPause` for at most 2 hours | Unpause; extend past the cap | None |
| `NOTIF_BILLER_ROLE` | Biller bot | Charge the fixed notification fee the payer consented to, once per side of an open loan | Charge more than the payer's cap, a closed loan, or a flagged wallet | None |
| `KEEPER_ROLE` | Keeper bot | Lower an asset's liquidity tier (never raise it above the baseline); run the keeper-only reward and claim steps | Raise a tier; move funds to itself | None |

User-granted keeper permissions are not governance: each user grants and
revokes them for their own positions (#3353 replaces standing bits with
owner-signed, bounded mandates).

### 2.2 Standalone contracts

| Contract | Upgradeable? | Owner can | Guardian (Pauser Safe) can | Delay |
| --- | --- | --- | --- | --- |
| `VaultBeacon` (code for every user vault, #3204) | No; ownership cannot be renounced | Register a version; propose a current version; propose a revocation naming a successor | Cancel a proposal; while the Diamond is paused, revoke a version onto code already registered | 3 days (`MIN_CODE_DELAY`), 7 days after #3421 |
| `PositionNFT` (#3318) | No; ownership cannot be renounced | Propose a new renderer or transfer check | Cancel the proposal | 3 days (`MIN_COMPONENT_DELAY`) |
| `ProtocolRegistry` (treasury, backstop, price guard, swap adapters, conduits; #3272) | No | Propose a pointer or a set addition; propose a longer delay | Cancel a proposal; remove a set member at once (removal only stops) | 3 to 30 days |
| `PriceGuard` (every price read, #3272) | No | Propose a source or setting change within fixed ranges; raise the delay | Cancel a change; switch off a secondary source at once | 7 to 14 days |
| `VaipakamFeedRegistry` | No | Name proposers; set the delay within range | Veto a proposed feed | 7 to 14 days |
| `SanctionsList` | No | Name the adder and remover keys, the adder's daily cap | — | Listing is immediate (adder, capped per day); delisting by the remover Safe, or a bot proposal through `SanctionsDelistingTimelock` (1 to 30 days, default 2) |
| `VPFIToken` (canonical chain) | Yes (UUPS) | Upgrade; set the minter; unpause | Pause | Timelock |
| Cross-chain contracts (messenger, token pools, rate governor, reward messenger, receivers, mirror token) and the CCIP token-admin role | Some UUPS | Upgrade; lane and rate-limit settings within the governor's bounds. As each token pool's owner it can also set any lane limit **directly** through the pool's own setter, outside the governor's bounds and including switching a limit off (the governor documents this as break-glass authority) | Pause | Timelock |
| `CollateralListingExecutor` | Yes (UUPS, own owner) | Upgrade; approve or remove conduits; sweep stray tokens | — | Timelock once its owner is rotated |
| Backstop vault, aggregator adapter proxies | Yes (UUPS, Diamond-owned) | Through `VAULT_ADMIN_ROLE` | — | Timelock |
| `KeeperBackupUpkeep`, `RiskPremiumRateModel` | No | Step mask and timing; tier premiums | — | Whatever their owner's is: the handover moves every owned contract its walk finds to the Timelock, and #651 confirms none is missed |
| `VaipakamTimelock` | No | Its delay can only rise above the deploy-time floor | Pauser Safe cancels queued operations | — |

## 3. Guardian fast-pause — already in place

The research recommended adding a Diamond-level guardian-pause mirroring the
cross-chain `GuardianPausable` pattern (guardian can pause, only owner-via-
timelock can unpause, guardian can never alter custody). **The core Diamond
already implements this guarantee** — it just isn't named "guardian":

- **Fast-pause (the guardian lever).** `PAUSER_ROLE` can halt the whole
  protocol immediately, with **no timelock delay**
  (`AdminFacet.pause` → `LibPausable`). At handover `PAUSER_ROLE` is held by the
  **Pauser Safe** (granted by `Handover.s.sol`), and the admin EOA's hold on it
  is **renounced** in the same script, which `GovernanceHandover.t.sol` checks.
  `Handover.s.sol:_timelockRoles` deliberately omits
  `PAUSER_ROLE` so it never routes through the timelock. This is the
  detect-to-freeze fast path, on the guardian Safe.
- **Unpause is the deliberate-reset key.** `UNPAUSER_ROLE` is rotated to the
  **Timelock** at handover (`Handover.s.sol:_timelockRoles[1]`), so lifting a
  pause takes the full review-window delay. A compromised or impatient Pauser
  key **cannot un-do its own pause** to race the incident team — exactly the
  cross-chain `GuardianPausable` rationale.
  - **Caveat — closed by D1 (#934, 2026-10-16).** The root
    `DEFAULT_ADMIN_ROLE` is a *general* timelock-bypass, not just an unpause
    one: a holder can `grantRole` `UNPAUSER_ROLE` to any address **and** can
    call `AccessControlFacet.transferAdmin`, which moves ERC-173 ownership and
    every role to a new address in one call. Until D1, handover put that role
    on the **governance Safe** directly, so the delay rested on the Safe's
    honesty and threshold. It now goes to the **timelock**; the Safe keeps
    only `EMERGENCY_REVOKER_ROLE`, which can remove a role from a hot key but
    never the root and never anything the timelock holds. Every role grant,
    every `transferAdmin` and every ownership move is therefore code-bound to
    the delay.
- **The guardian can only halt — never move custody.** `PAUSER_ROLE` gates only
  the pause flag; it has no fund-custody authority. Pausing freezes new state
  transitions; it cannot redirect, seize, or mint.

Net: the asymmetric `PAUSER` (pause, fast, guardian-held) / `UNPAUSER`
(unpause, slow, timelock-held) split **is** the guardian-pause the research
asked for. No new role is added — adding a separate `GUARDIAN_ROLE` would be a
rename of `PAUSER` with no new function (the "check existing primitives before
reinventing" call). The only operational requirement is that `PAUSER_ROLE` is
granted to a credible, fast-reacting guardian Safe at deploy, and that
`UNPAUSER_ROLE` is rotated to the Timelock — which the **canonical**
`Handover.s.sol` arranges (its `_timelockRoles` includes `UNPAUSER_ROLE`
deliberately, and it renounces the deployer's `PAUSER`/`UNPAUSER` holds).

> **Gap closed (#650, #936):** the legacy `TransferAdminToTimelock.s.sol`
> migrated only DEFAULT_ADMIN / ADMIN / ORACLE / RISK / VAULT and left the
> deployer EOA holding `UNPAUSER_ROLE`. It and `GrantOpsRoles.s.sol` are
> retired; `Handover.s.sol` is the only handover, the runbooks point at it, and
> `GovernanceHandover.t.sol` asserts the deployer holds no `UNPAUSER_ROLE`
> (nor the emergency revoker) after it.

## 4. Authority + timelock shape

- **Separated authorities:** a fast-key **guardian/Pauser Safe** (pause only),
  an **upgrade/admin Safe** → **48–72h Timelock** for everything that can move
  custody. The two are distinct keys, so a guardian-key compromise can only
  *halt* user flows (it has no upgrade authority), and an upgrade-key
  compromise still has to wait out the timelock delay — during which the
  guardian halts user activity and the timelock proposer (governance) can
  cancel the queued operation. The guardian does **not** itself block the
  upgrade (the cut path is intentionally not pause-gated, for recovery).
- **Closed by D1 — the root `DEFAULT_ADMIN_ROLE` is timelocked** (#934,
  owner decision 2026-10-16). It used to move to the governance Safe at
  handover, and because it is the `roleAdmin` of `ADMIN_ROLE`,
  `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE` and
  `UNPAUSER_ROLE`, the Safe could grant itself any of them immediately and
  skip the delay. It now moves to the timelock, so the "custody-moving changes
  sit behind the timelock" guarantee is code-enforced for the role-grant path
  too. The timelock's own delay cannot be lowered below its deploy-time value,
  and an independent canceller can veto a queued operation (#938).
- **Ossification cannot be done by renouncing ownership.** The ERC-173 owner
  must always hold `DEFAULT_ADMIN_ROLE`, and ownership can never move to the
  zero address (#906). Hardening therefore never goes through an ownership
  renounce: a component either freezes in place by its own rule (§5), or, for
  the lending core and the vault code, is succeeded by a final version users
  opt into (§6). The vault beacon, the position NFT and the registry refuse a
  renounce for the same reason: an ownerless one could never revoke a bad
  version or remove a bad adapter again.
- **No on-chain quorum yet** (acknowledged gap, shared with #394's governance
  gap). The bounded-steward + timelock-asymmetry + guardian-pause fabric is the
  same one the risk knobs ride on; an on-chain quorum is a later addition, not
  a pre-audit blocker.
- The handover ceremony (role + ownership rotation to the timelock/guardian
  topology) is run by `Handover.s.sol`, exposed as a dedicated phase on **both**
  testnet and mainnet (`deploy-testnet.sh … --phase handover`,
  `deploy-mainnet.sh`). Testnet is where the split is **rehearsed**; mainnet
  cutover is where it takes effect for real value. Operationally, flow-test
  deploys are often left deployer/admin-owned for convenience (EOA keys keep the
  flow tests simple), but that is a per-deploy choice, **not** a claim that
  handover can't run on testnet — it can and should be rehearsed there.

## 5. Staged hardening — per component, with exit criteria

Hardening is component by component (the #3438 recommendation), so progress
is visible and steady rather than one distant event. Each component has its
own exit criteria and moves on its own once they are met.

**Common exit criteria for any step below.** All three must hold, and the
step's revision of this document names the dates:

1. An external audit has signed off on that component's code as it will be
   hardened.
2. A published bake period of live mainnet operation has passed with no
   critical finding on that component. The length is set at audit time and
   published here; it is a minimum, never shortened later.
3. Every issue this document lists as a gap for that component (§1) is
   closed.

| Stage | Component | Today | Hardened state | How it gets there |
| --- | --- | --- | --- | --- |
| A | Vault code (`VaultBeacon`) | Non-upgradeable beacon; versions registered and made current after the code delay; pins | The code delay is 7 days (#3421), every security version declares the version it patches and its review note, and the version list changes only by security patches | The beacon's rules are fixed in its code, so a narrower rule set is a **new beacon** and a new vault family that users move to by choice (§6). Until then the owner commits, here, to registering only security patches once Stage A's criteria are met |
| B | Position NFT (`PositionNFT`) | Non-upgradeable; renderer and transfer check replaceable after 3 days | Transfer check fixed; renderer stays replaceable (display only, moves no value) | A new position NFT can only come with a new lending core (§6); until then the owner proposes no transfer-check change after Stage B's criteria are met, and says so here |
| C | Price sources (`PriceGuard`, `VaipakamFeedRegistry`) | Changes wait 7 to 14 days; a guardian can switch off a secondary source | Stays governed for new loans (§7); open loans keep the sources they opened with (#3437) | #3437 is what takes open loans out of reach; the guard itself stays bounded and delayed |
| D | Protocol pointers (`ProtocolRegistry`) | Pointer changes wait 3 to 30 days; set removal is immediate | Treasury and backstop pointers fixed in code; swap adapter and conduit sets add-only behind the delay, remove-only fast | The registry's rules are fixed in its code, and they keep the owner's power to propose a pointer change and to lower the delay again after waiting the current one. So **fixed** pointers need a new registry without that power, which comes with the final lending core (§6). Until then the delay is raised to its maximum and the owner commits, here, to propose no treasury or backstop change. That is a **revocable pledge, not a code guarantee**: breaking it is visible (every proposal emits an event and waits the delay), but nothing prevents it |
| E | Lending core (the Diamond's facets) | Every facet replaceable after the Timelock delay | A final non-upgradeable lending core, deployed beside the governed one, that users opt into | §6 |
| F | Cross-chain contracts, `VPFIToken` | UUPS behind the Timelock; guardian pause | Upgrade paths frozen in code; lane limits stay bounded settings, with no unbounded owner route | Upgrade each proxy, through the Timelock, to an implementation whose upgrade authorisation always refuses, or replace it with a final deployment, on the same criteria; an owner merely choosing not to upgrade is a pledge, not this state. For the lane limits, move each pool's ownership to a contract that can only forward bounded limit changes (or reach the same through a final deployment), so the pool owner's direct setter no longer bypasses the governor. #651 enumerates the full set |
| G | Collateral-sale executor, backstop vault, aggregator adapters | UUPS, behind the Timelock (the executor through its own owner) | Frozen or replaced by final versions with the lending core | With Stage E: these serve the lending core, so they move with it |

**Freeze candidates must cover the whole surface.** For any component that
freezes in place, the freeze covers adding new code as well as replacing or
removing existing code, and every pointer that could route around it. The
collateral-sale executor is the reminder: freezing its code but not the
Diamond's `setCollateralListingExecutor` pointer would let a new executor be
pointed at. #651's census is the checklist for this.

Guiding rule (the load-bearing line): **anything that *governs* custody —
i.e. can change the rules by which funds move, directly or through a price/risk
input — can only change behind the 48–72h timelock** (delay sized to
detect-and-exit, and a freeze *candidate*, never a free replace).

**Honest carve-out (a custody-moving path that is *not* behind the timelock).**
The rule above governs the *upgrade/parameter* surface. One operational debit
sits outside it: `NotificationFeeFacet.markNotifBilled` (`NOTIF_BILLER_ROLE`) calls
`LibNotificationFee.bill`, which pulls a fixed VPFI notification fee from a
loan party's vault into Diamond custody and credits the recycle bucket (#1346)
— no timelock. It is a fast path *by necessity* (billing happens when a
notification is sent and cannot wait out a delay), so what bounds it is
on-chain authorization, not delay:
- **The payer's own on-chain consent (#2721).** Each wallet records, from its
  own account, the most it agrees to pay per loan side
  (`NotificationFeeFacet.setNotificationFeeConsent`); zero withdraws it, and
  withdrawing works while paused. `bill` refuses a payer with no consent or a
  cap below the configured fee (`NotificationFeeNotConsented`), so consent to
  a lower fee never covers a later, higher one. Before #2721 the opt-in lived
  only off-chain and the contract debited whichever side it was told.
- **Open loans only (#2721).** `bill` refuses a loan that is not `Active`
  (`NotificationBillingLoanNotActive`). Before #2721 every loan ever opened was
  billable, closed / settled / defaulted ones included.
- **Not a flagged wallet (#2769).** Where a sanctions oracle is configured,
  `bill` refuses a payer it flags (`SanctionedAddress`), and refuses every bill
  while the oracle cannot be read (`SanctionsOracleUnavailable`) rather than
  charging a wallet nobody could screen. A flagged wallet's vault is frozen,
  not seized, and consent does not change that.
- **Once per loan side.** The per-side `…NotifBilled` flag still makes a retry
  a no-op, now also after the loan closes or consent is withdrawn.
- **A dedicated bot key, not the admin.** Since #669 `Handover.s.sol` grants
  `NOTIF_BILLER_ROLE` to `NOTIF_BILLER_ADDRESS` and the admin renounces it, so
  it is not left on the ADMIN EOA. (An earlier revision of this paragraph said
  it stayed there until a separate rotation; that described the pre-#669
  handover.)

So the realistic blast radius of a compromised biller key is now an *early*
charge: a clean wallet that already agreed to pay, at most the cap it chose,
once per side of a loan that is still open. That is bounded and consented, and it is
named here rather than hidden. The role still cannot re-point custody rules.

**What "detect-and-exit" does and does not mean (honest):** the delay buys
users a window to *observe* a queued custody-moving change and exit (repay,
withdraw, claim) **while the protocol is unpaused**. It is **not** a guarantee
that exit stays open in every scenario — the user-exit paths (`RepayFacet.repayLoan`,
`ClaimFacet.claimAsLender`, withdrawals) are themselves `whenNotPaused`, so if the
guardian *pauses* during a queued hostile op those exits revert too. Pause and
detect-and-exit are therefore alternative mitigations, not simultaneous ones:
while **unpaused**, the delay is the user's exit window; once **paused**, the
lever is the incident team's **cancellation / remediation** (the timelock
proposer cancels the queued op), not user exit. The guardian's pause buys the
team time to cancel — it does not preserve the exit window it freezes.

## 6. The final version, and the one-fresh-deploy rule

Mainnet gets **one fresh deploy**, and after that only facet refreshes
(owner rule, 2026-11-05): storage must stay upgrade-safe forever, and no
mainnet chain is ever redeployed in place. A final non-upgradeable version
does not break that rule, because it is **not a redeploy of the governed
Diamond**:

- **It is a new, separate deployment beside the governed one.** The governed
  Diamond keeps running. Nothing is migrated for a user, and no setting or
  facet refresh moves anyone across.
- **Users opt in.** A user moves by their own action: close or repay a loan
  on the governed core, then open the next one on the final core; move vault
  assets to a vault of the final family. Open loans finish where they opened.
- **The governed core winds down to close-outs.** Once the final core is
  live, the governed one stops admitting new offers and loans (a stop-only
  change), and keeps repay, claim, default, liquidation and withdrawal open
  for as long as anything remains in it.
- **The final core keeps only what §7 says stays governed**, through bounded
  setters with fixed ranges, and has no code upgrade path at all. Its vault
  family answers to a beacon whose version list is fixed, or to no beacon.
- **Bugs found after that are handled by another opt-in version**, never by
  an upgrade, with the stop-only pause and admission refusal as the levers in
  the meantime. That is the trade the exit criteria in §5 are there to make
  safe.

This keeps the rule's purpose: one deployment's storage is never re-laid,
and no user's position is moved without their action.

## 7. What stays governed, and why

Some levers stay governed even after Stage E, each for a stated reason:

| Lever | Why it stays | How it is bounded |
| --- | --- | --- |
| Sanctions screening | A legal requirement for the retail deploy | Listing is immediate and capped per day; delisting is by the remover Safe or a timelocked proposal; screening blocks new positions, while repayment, default and liquidation stay open so a flagged counterparty cannot trap a clean one. It does **keep power over existing funds**: a flagged wallet's own claims and withdrawals stay blocked, its proceeds held, until it is cleared (`SanctionsAndTermsGateMatrix.md`) |
| Price sources offered to new loans | Markets and feeds change; a feed can be retired by its provider | Delayed (7 to 14 days), quorum-checked, range-bound; open loans keep the sources they opened with (#3437) |
| The pause | The fastest way to stop an exploit in progress | Stop-only; unpause waits the Timelock delay; the watcher's automatic pause lasts at most 2 hours |
| Parameters for new markets | New assets and chains need settings | Every setter has fixed bounds in code; open loans keep the terms stamped at origination (the liquidation handling fee and liquidator incentive cap are still read live until #3534) |

Anything not in this table is a candidate to freeze under §5.

## 8. How users are told

| Step | What users see, and when |
| --- | --- |
| A queued governance change (any time) | The app shows queued Timelock changes and their execution time during the wait (#3237); an alert reaches subscribed users |
| A vault code proposal or revocation | Every vault owner gets an alert when it is proposed, with the delay and how to pin or leave (#3422) |
| A component meets its exit criteria (§5) | This document is revised with the dates, a release note states it, and the app's protocol page says which components are now hardened |
| A final version goes live (§6) | An in-app notice on every governed position says how to move and that nothing moves without the user's action; the governed core's wind-down date is announced at least one bake period ahead |
| A security fix shipped quietly | The incident runbook's procedure for shipping a fix without revealing the bug applies; users are told after the fix is live (`docs/ops/IncidentRunbook.md`, #3409) |

Copy for all of these follows the honesty clause below: it names what can
still change and who can change it, never "immutable" for anything that is
not.

## 9. Sequencing (what is pre- vs post-audit)

- **Before mainnet:** the gaps named in §1 (#3205 Stage B, #3421, #3424,
  #3431, #3437, #3441, with the delay ordering §1 states), the per-loan
  close-out fee stamps (#3534), the user-facing notices (#3237, #3422), and #651's
  census.
- **After the audit and the first bake period:** Stages A, B and D, each on
  its own criteria.
- **Later:** Stage E with F and G, as one opt-in final version (§6).
- **No on-chain voting quorum yet** (acknowledged gap, shared with #394). The Timelock, its independent
  canceller and the bounded setters are the governance fabric; a quorum is a
  later addition if one is ever needed, not a pre-audit blocker.
- **Independent canceller** for queued Timelock operations is in place
  (#938): the Pauser Safe can cancel but not propose.

## 10. Honesty clause

This is **not** an "immutable protocol" claim. Vaipakam is upgradeable today
and will remain so until the staged steps above are taken on a published,
dated schedule. We publish this roadmap so users can see exactly which rules
*can* still change, who can change them, and behind what delay — rather than
implying guarantees we do not yet have. The marketing / user-facing copy must
mirror this framing and never overstate immutability (see the retail-deploy
copy policy).

## 11. Related

- Research + verdict: [`Research-404-OssificationRoadmap.md`](Research-404-OssificationRoadmap.md)
- Governance config + bounded setters: [`GovernanceConfigDesign.md`](GovernanceConfigDesign.md)
- Vault code: [`VaultCentralImplementationDesign.md`](VaultCentralImplementationDesign.md) (#3204)
- Threat model: [`ThreatModel.md`](ThreatModel.md)
- Handover wiring: `contracts/script/Handover.s.sol` (the only handover
  script since #936) and its gate `contracts/script/HandoverGate.s.sol`
- Cross-chain guardian pattern: `contracts/src/crosschain/GuardianPausable.sol`
- Incident runbook: `docs/ops/IncidentRunbook.md`
