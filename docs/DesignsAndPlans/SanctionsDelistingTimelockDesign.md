# Sanctions delisting — bot proposes, Safe vetoes, RedStone agrees (#2443)

Status: built (contracts, tests, testnet deploy script). The delister bot and
the CCIP clearance wiring are follow-ups, listed in §7.

## 1. Decisions this records

All from the owner, 2026-10-18, in the "Open GitHub issues plan" thread:

- **D-A — Bot proposes, Safe vetoes.** Delisting may be automated, but a
  multisig must be able to stop any single delisting before it happens.
- **D-B — RedStone must agree.** A wallet is delisted only while RedStone's
  Sanctions Oracle, the only independent on-chain list available, does not
  flag it. (Codex round 1 on #2562 added the corollary built here: RedStone
  must also be current, or "does not flag it" says nothing — §4.)
- **D-C — Proposals come from OFAC's files.** The bot reads the advanced XML
  (the file the list records) and the plain `SDN.XML`, which a separate parser
  reads, and proposes only what both support.
- **D-D — CCIP carries the RedStone check to other chains.** Where RedStone
  is not deployed, the check is made on a chain where it is and the answer is
  sent over Chainlink CCIP, per address, at the time of the delisting.
- **D-E — The Safe keeps its direct delist** for emergencies, and can cancel
  any proposal during the waiting window.
- **D-F — A Safe veto sticks** (2026-10-18, after asking whether the bot would
  re-propose a vetoed wallet): the bot cannot propose a vetoed wallet again
  until the Safe or the owner lifts the veto.

## 2. Why a separate contract

`SanctionsList` already splits signers by direction: an adder may only list,
a remover may also delist. The timelock is appointed as a **second remover**,
beside the Safe. That keeps the list unchanged (no redeploy, no migration, its
audit surface untouched) and makes the automated route removable in one call:
the owner revokes the timelock's remover role.

## 3. The flow

1. **Propose** (`propose`, proposer only). The batch must:
   - name the publication the list records (`sourceHash`,
     `sourcePublicationDate`);
   - contain only addresses the list's own record holds (`listedByOwnList`);
   - contain at most 100 addresses, none already in a pending proposal or
     vetoed;
   - fit, **together with every pending proposal**, within the publication's
     declared outstanding delistings (`pendingDelistings`). The timelock
     keeps the running total as `reservedDelistings` and frees a proposal's
     share when it is cancelled, discarded or executed.

   That last rule is what bounds a stolen proposer key: it cannot queue more
   delistings than OFAC's file calls for, so the Safe never has to sift a
   flood. (Codex round 3 on #2562: the earlier rule checked each batch alone,
   so many small batches could exceed the file.)

   The proposal's `eta` is `now + delay`. `delay` is set by the owner,
   between 1 and 30 days, 48 hours by default, and is fixed per proposal when
   it is made.
2. **Window.** The Safe (any remover of the list) or the owner may `cancel`,
   which **vetoes** every address in the proposal. `setVetoed` vetoes, or
   lifts a veto on, any address at any time, including before a proposal. A
   proposer may `cancel` its own proposal too, which only withdraws and
   vetoes nothing.
3. **A proposal belongs to its proposer's key.** If the owner removes that
   proposer, its pending proposals can no longer execute
   (`ProposerRemoved`), and anyone may `discard` them, which frees their
   addresses and their share of the outstanding delistings. A discard vetoes
   nothing: removing a key says the key is untrusted, not that every address
   it named was wrong. So revoking a compromised bot is one call, and nothing
   it queued survives it. The same rule runs the other way: only the
   proposer that made a proposal, while still appointed, may withdraw or
   `reconfirm` it (`NotItsProposer`). With several proposer keys, one cannot
   withdraw another's batches and refill the freed share itself, or move
   another's proposal to a publication it has not re-checked. (Codex round 4
   on #2562.)
4. **New publication during the window.** The adder runs daily, so the list
   can move to a newer OFAC file before `eta`. Execution then refuses
   (`PublicationChanged`). The bot re-checks the addresses against the new
   file and calls `reconfirm`, which moves the proposal to it **without
   restarting the window**: the decision the Safe was given time to veto has
   not changed.
5. **Execute** (anyone, after `eta`). Checks run in this order, and
   `checkExecutable` / `readiness` run the same sequence for bots and
   surfaces:
   1. pending and matured;
   2. its proposer still appointed;
   3. publication unchanged;
   4. **the publication's additions all applied** (`pendingAdditions` is 0);
   5. within `pendingDelistings`;
   6. not vetoed;
   7. a current RedStone clears every address (§4).

   Then it calls `SanctionsList.applyUpdate` as a **repeat of the recorded
   publication**, delisting the batch and lowering `pendingDelistings` by its
   size. The list's own rules (version, publication order, pending counts)
   apply unchanged.

   **Additions first.** A publication can both add and remove. The adder
   applies its additions unattended within the day, so waiting for them costs
   nothing, and it means the list never shows a publication's delistings
   while its new designations are still missing. It also lets the update pass
   zero additions outstanding without asserting anything it has not checked.

## 4. The RedStone check

Two things must hold for every execution, whichever route reads RedStone:

- **RedStone does not flag any address in the batch.**
- **RedStone is current.** Its own `getLastUpdateBlockTimestamp()` must be
  known (not missing, reverting, zero or in the future) and no older than
  `oracleMaxAge` (owner-set, 1 to 30 days, default 7). A frozen oracle keeps
  answering, and answers "not flagged" for every address it never listed —
  the same failure that retired Chainalysis's oracle from this design. One
  reading rule, `LibOracleFreshness`, serves the list's `secondaryLastUpdate`,
  this check and the attestor. RedStone publishes no update cadence for this
  oracle, so the default is generous; a quieter oracle closes the automated
  route and leaves the Safe's direct delist.

**Which route applies** is one view, `clearanceRoute()`, that execution, the
bot, the deploy script and any surface all read, so none can report a posture
the contract does not have:

| `clearanceRoute()` | When | How | Failure |
| --- | --- | --- | --- |
| `Local` | The list composes RedStone as its secondary on this chain (wins over a configured source) | Freshness, then `secondary.isSanctioned(a)`, read live at execution | `OracleFreshnessUnknown(Local)` / `OracleStale(Local, …)`; a read revert propagates (fail closed); `true` reverts `StillSanctioned` |
| `CrossChain` | Otherwise, a clearance source is configured | The proposal's current request (below), answered `Cleared` with a known, recent oracle time | `ClearanceNotRequested`, `ClearanceExpired`, `ClearanceNotAnswered`, `ClearanceFlagged`, `OracleFreshnessUnknown(CrossChain)`, `OracleStale(CrossChain, …)` |
| `Unavailable` | Neither | none | `ClearanceUnavailable`: automated delisting is closed and only the Safe's direct delist remains |

**The cross-chain request.** A designation RedStone makes during the window
must be caught, so the reading has to be taken after the window ends.
Comparing the attestor chain's timestamp with this chain's cannot prove that:
the two clocks are independent. Nor can a value the timelock derives and the
attestor echoes, since whatever the timelock can compute, someone can predict
(Codex round 2 on #2562 found one such lead, round 3 another). So the proof is
causal, and carried by the transport itself:

- After `eta`, anyone may call `requestClearance(id)` and pay the CCIP fee
  (`quoteClearanceRequest`; the call's overpayment is refunded, and only
  that: `LibFeeRefund` returns the balance growth since the call began, so
  value the contract holds for any other reason never goes to a caller). The timelock itself
  sends `(version, REQUEST, requestId, accounts)` to the attestor through its
  `ICrossChainMessenger`.
- The attestor reads RedStone **when that request arrives**. CCIP delivers a
  message only after the sending chain has finalized it, and the request was
  sent after the window, so the reading post-dates the window by causality.
  Nobody can obtain a reading for a request the timelock did not send: the
  attestor accepts inbound messages only from its messenger, which
  authenticates the lane and the channel peer.
- The attestor records the hash of the reply it owes and emits the reply in
  full (`ClearanceRead`). Anyone may then `sendReply` with that exact reply
  and pay its fee (`quoteReply`). A caller chooses when the reply is sent,
  never what it says. This split keeps the attestor free of any balance.
- The request is usable for `clearanceMaxAge` after it is sent (1 hour to 7
  days, default 1 day), on this chain's clock. A new one may be sent only
  when the proposal has none under the current source or the current one has
  expired, so nobody can keep voiding an answer in flight. A replaced
  request is forgotten: an answer to it is ignored.
- An answer counts only for the proposal's exact batch (its `accountsHash`).
- One flagged answer marks the request `Flagged` for good. Two answers to one
  request can disagree only if one was forged past the transport or RedStone
  is inconsistent; whichever arrives first, the result fails closed.
- Among "not flagged" answers, the freshest oracle time is kept, clamped to
  this chain's clock. Clock skew between chains is seconds against an
  `oracleMaxAge` of days, so it is the one clock comparison left, and it is
  bounded.

**The two contracts' inbound checks:**

- **`SanctionsClearanceAttestor`**, deployed where RedStone runs, has no owner
  and no configuration beyond the oracle and messenger fixed at deploy. Its
  `onCrossChainMessage` reverts unless the call is from its messenger and the
  message carries no tokens, a known version, the request kind, and 1 to 100
  non-zero addresses; each inbound message is read once. An oracle read that
  reverts reverts the arrival (CCIP records a failed message, manually
  re-executable), so an unreadable oracle never produces "not flagged". The
  reply carries the oracle's own last-update time (0 when unknown).
- **The timelock's `onCrossChainMessage`** reverts unless it comes from the
  configured messenger, the source chain and sender are the configured
  attestor (on top of the messenger's own authentication), and it carries no
  tokens, a known version, the response kind and matching array lengths. A
  well-formed answer that carries no evidence about a live proposal — an
  unknown or superseded request, a closed proposal, other addresses — is
  ignored with `ClearanceIgnored` and its reason rather than reverted.
  Changing the source bumps an epoch, which voids every outstanding request.

Both accept native value only as their messenger's fee refund.

## 5. What each key can do if stolen

| Key | Can | Cannot |
| --- | --- | --- |
| Proposer (delister bot) | Propose wrongful delistings, up to the publication's outstanding count in total, which the Safe can veto and a current RedStone must still clear; withdraw or reconfirm its own proposals | Shorten the window, skip the RedStone check, lift a veto, exceed what OFAC's file calls for, keep anything alive once the owner removes it, touch another proposer's proposals |
| Adder | List addresses; record a publication | Delist |
| Safe (remover) | Delist directly; veto; cancel | — (it is the multisig) |
| Owner (admin) | Appoint or revoke the proposer and the timelock's remover role; set the delay, the clearance source, the request lifetime and the oracle's max age; veto | Delist without appointing itself |
| Anyone | Request a clearance, send an owed reply, execute a matured proposal, discard a removed proposer's proposals | Choose what RedStone answers, send a request in the timelock's name, delist before the window ends |

## 6. Stated limits

- The contract cannot read OFAC's files. That a proposed address really left
  the SDN list is the bot's off-chain check (§7). On-chain, what is enforced
  is that the address is listed, that the publication is the recorded one,
  that all pending batches fit its declared delistings, that its additions
  are applied, the window, the veto, and RedStone.
- RedStone's coverage is its own. "RedStone does not flag it" is a necessary
  condition, not proof of delisting.
- A vetoed address that OFAC's file still calls for stays counted in the
  list's `pendingDelistings`. That is deliberate: the list keeps saying the
  publication is not fully applied, rather than hiding the disagreement.
- The window is measured on this chain's clock, which its block producer
  sets within the chain's own rules, like any timelock.

## 7. Follow-ups

- **Delister bot** (separate PR): it downloads both OFAC files, requires the
  advanced file's hash to equal the list's, and requires both files to carry
  the same publication date. Its candidates are the diff's delistings, each
  absent from the plain file and passing the witness check, minus addresses
  already proposed, vetoed, or flagged by RedStone. It then:
  - proposes the candidates;
  - on the cross-chain route, after `eta`, calls `requestClearance` on the
    timelock's chain; once the request arrives, reads the reply from the
    attestor's `ClearanceRead` event and calls `sendReply` on the RedStone
    chain;
  - executes matured proposals once `readiness` reports ready;
  - reconfirms after a new publication.

  It is configured and installed the way the adder is (#2557): one root-only
  file, `/etc/vaipakam/sanctions-delister.env`, holding its own key (never the
  adder's, the keeper's, the owner's or the Safe's) and one RPC per chain
  under the keeper's names; the timelock and list addresses come from the
  installed release's `deployments.json`, never from the file; one run reads
  the OFAC files once and serves every chain. The key needs native gas on
  both chains of a cross-chain route, for the two CCIP fees.
- **CCIP clearance wiring** (with the bot): deploy the attestor where RedStone
  runs; register it as the clearance channel's handler there with the
  timelock as peer, and the timelock as handler on its own chain with the
  attestor as peer (both directions now carry a message); call
  `setClearanceSource`.
- **Mainnet:** follows the adder host decision.
