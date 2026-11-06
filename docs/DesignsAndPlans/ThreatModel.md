# Vaipakam threat model

Status: living document, first published with #3204's design (2026-11-06).
It describes **what the platform defends against, how, and what is left
over**. The "planned" items are tracked as public issues, and each is
referenced by number. It deliberately gives no exploit detail for anything
not yet fixed: those are worked through privately and land here as a line
once they ship.

This document follows the repository's standing principle: say what is
known, say what is not, and never imply a certainty the system does not have.
A "residual" below is a stated limit, not a bug report.

## 1. What is protected

- **User custody.** Every user's assets sit in their own vault: one proxy per
  user, no commingling. Loan collateral, rental prepayments and sale proceeds
  are liened inside that vault, not moved to the Diamond (#2141). This is the
  asset that matters most.
- **Loan state and its money.** Principal, interest, fees, collateral, claims
  and each position's status. A wrong number here is a wrong payout.
- **Protocol-held value.** The treasury (an external multisig on mainnet),
  the reward pool custody, and the backstop.
- **The user's decision.** What a user is shown before signing must match
  what the transaction does.

## 2. Who might attack, and from where

| Actor | Can do | Cannot do, by construction |
| --- | --- | --- |
| Any external account | Call every permissionless entry point; front-run; spam offers; trigger due liquidations and defaults within their rules | Move another user's vault funds; change any setting |
| A counterparty | Act within the loan's terms; delay their own steps | Reach anyone else's funds, or their own loan's beyond its lien |
| A thief holding a user's key | Act as that user | Beat protected mode's delays and second keys, when the user has turned them on (§4.3) |
| A compromised keeper key | Submit the permissionless steps the keeper runs | Redirect funds. The keeper role is narrow and is reviewed in the #3235 census |
| A compromised admin multisig | Queue changes behind the 48h Timelock | Act without the delay; the Pauser Safe can cancel a queued change |
| A compromised guardian (Pauser Safe) | Pause, and (after #3204) revoke a vault version while paused | Unpause, register code, or move funds |
| A faulty or malicious facet | Whatever the Diamond can call | After #3205: pay a vault's funds anywhere but a declared destination |
| A compromised front end, DNS, RPC proxy or indexer | Show a user false information | Change what a signed transaction does. Accepts are bound to signed terms |
| Cross-chain transport | Deliver or withhold messages | Forge messages without compromising the transport's own verifiers or a messenger owner key; token movement is rate-limited per lane |
| An oracle or a swap router | Report a bad price; return a bad route | Push a forced sale past its on-chain minimum-output floor |

## 3. Trust boundaries

1. **Wallet → Diamond.** The user's signature or transaction is the only
   authority for their own actions. Signed accepts bind the exact terms.
2. **Diamond → vault.** A vault accepts calls only from the Diamond. Today
   each rule about where vault funds may go lives in the facet path that
   moves them. #3205 replaces that with one policy and a second, independent
   check inside the vault itself.
3. **Governance → Diamond.** After handover, every admin role and the owner
   sit on the Timelock (48h delay). The Pauser Safe holds pause and cancel
   only, and unpausing is the Timelock's.
4. **Chain → off-chain services.** The keeper, indexer, agent and app read
   chain state. None of them can move user funds, and the app must say when
   a figure it shows comes from a service rather than the chain.
5. **Chain ↔ chain.** Cross-chain messages are authenticated by the
   transport and by per-channel peers, paused by a guardian, and rate-limited
   for token value.

## 4. Defences

### 4.1 In place

- **Per-user vaults with liens.** No pooled user custody; a loan's assets
  are bound to that loan.
- **Health-factor and LTV gates at initiation**, and liquidation with a
  minimum-output floor.
- **Sanctions screening** of state-creating and fund-receiving entry points,
  while close-outs stay open so an unflagged counterparty can be made whole.
- **Progressive risk access** (#671). A wallet starts at the lowest tier and
  opts up, and an opt-up takes effect only after a 48h cooldown. An illiquid
  deal needs a standing pair consent armed 48h ahead (#3231), so a stolen key
  cannot open a risky position on the spot.
- **Protected mode** (opt-in). Second keys, a delay on settings and
  outflows, a lock, and an alert channel whose removal is itself delayed
  (#3246 part 1).
- **Pause.** One switch stops new positions and owner outflows. Close-outs
  stay open, and the pause cannot hold an escape withdrawal past its window,
  which protects users from the admin.
- **Outdated vaults never trap a counterparty** (#3178). Close-outs land;
  only the owner's own outflows wait for the upgrade.
- **Governance delay.** A 48h Timelock on every admin change, a canceller,
  and a revoke-only emergency role.
- **Storage-layout guard.** No in-place upgrade can silently move a field.
- **Deploy-time guards.** Every facet is size-checked, every selector is
  routed, and the deploy refuses to finish with an unrecorded facet.

### 4.2 Planned (tracked)

| Defence | Card |
| --- | --- |
| One timelocked pointer for every vault's code; the guardian can revoke a version while paused, but only to code already registered | #3204 ([design](VaultCentralImplementationDesign.md)) |
| One vault outflow policy: typed destinations, a lien the vault itself recorded, payouts to the owner's own wallet when not protected, just-in-time approvals, signed orders that follow the pause | #3205 |
| Outflow circuit breaker: per-asset caps over a rolling window held in each vault's own storage, a delay on large wallet withdrawals for every account, and an automatic pause on an outflow spike | #3206 |
| Protected mode guards commitments, not only withdrawals: off-band rates, below-par lender sales, NFT listings below the owner's minimum, and two price sources agreeing before a forced sale | #3227 |
| Above a liquid-value threshold, adding value needs protected mode or a signed, versioned decline | #3233 |
| A census of value paths a pause does not stop, with a test for each | #3235 |
| A recovery address and clawback for protected mode | #3246 |
| A per-loan settlement conservation invariant | #3241 |
| Offer-book spam bounds | #3242 |
| Alert and page for queued governance changes | #3237 |
| Served-build integrity and domain hardening for the app | #3236 |
| Private transaction submission for forced sales where the mempool is public | #3240 |
| Bounds on the sanctions list's adder key | #3239 |
| Mainnet operations baseline (keeper host, credential scope) | #3243 |

Mainnet also waits on an external audit after code freeze and a live bug
bounty.

## 5. Residuals

Each line says what still gets through **after** the planned work above
lands.

- **A user's every key stolen together.** Protected mode cannot tell the
  thief from the owner. The #3206 delays slow wallet outflows, and #3246's
  clawback to a cold recovery address breaks the tie in the owner's favour,
  unless the recovery key is stolen too.
- **Small accounts.** Below the liquid-value thresholds there is, by design,
  no delay and no prompt.
- **A Diamond flaw and a vault flaw at the same moment.** The pause stops a
  drain only from the next transaction on. #3206's per-vault caps bound the
  loss per vault per window.
- **Prices inside the forced-sale cap.** A coordinated move in both price
  sources, within the liquidation slippage cap, is not detected.
- **Governance multisig compromise.** Changes wait 48h, but an open loan
  cannot always exit in 48h. The vault-side checks (#3205) bound what any
  change can make a vault do, and noticing depends on #3237.
- **Misleading reads.** A lying indexer or proxy can show a misleading list.
  It cannot change what a signed accept does.
- **Cross-chain message-only effects** (reward accounting, acknowledgements)
  have no quantified per-lane bound yet; this is tracked with #1277 and #912.
- **External routers change under the protocol.** This is bounded by the
  on-chain minimum-output floor, not by the router.
- **Old vault code** keeps running for its owner's own payouts until #3204
  lands (accepted with #3178).

## 6. Keeping this current

Update this document in the same PR as any change that adds a defence,
removes one, or changes a residual. A shipped planned item moves from §4.2 to
§4.1. A new threat gets a line in §2 or §5 when its card is public.
