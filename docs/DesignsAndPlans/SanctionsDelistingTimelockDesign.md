# Sanctions delisting — bot proposes, Safe vetoes, RedStone agrees (#2443)

Status: built (contracts, tests, testnet deploy script, delister bot). The
CCIP clearance wiring is built for TESTNETS as a rehearsal against a labelled
stand-in for RedStone (D-G, §7); running it on the live testnets waits on the
owner's go-ahead for each chain. A mainnet clearance route waits on RedStone's
terms.

Testnet deployments (2026-10-19, recorded in each chain's deployment artifact
as `sanctionsDelistingTimelock`): Base Sepolia and Arbitrum Sepolia, one
timelock each for that chain's rehearsal list. On both the admin owns the
timelock, the delister bot key is its only proposer, the delay is the default
48 hours, and the timelock is a remover of the list beside the existing one
(the Safe on Base Sepolia, the admin on Arbitrum Sepolia). Neither has a
RedStone check, so every execution refuses until the clearance wiring is run;
delistings meanwhile stay with each list's existing remover.

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
  reads, and proposes only what both support. For the AUTOMATED route this
  replaces the operator's confirmation against OFAC's Recent Actions notice
  that the update tool requires of a direct removal (`--confirm-delist`,
  #2543 r21): the card the owner answered offered "keep manual" (the Safe
  delists after an operator confirms each address against OFAC's notice)
  against "bot proposes, Safe vetoes" (a delister key proposes after two OFAC
  files agree), and the owner chose the second with both files as the source.
  The second file, the Safe's window and RedStone's agreement are what stand
  between a damaged file and a removal on this route. A removal the Safe
  applies directly keeps the notice confirmation.
- **D-D — CCIP carries the RedStone check to other chains.** Where RedStone
  is not deployed, the check is made on a chain where it is and the answer is
  sent over Chainlink CCIP, per address, at the time of the delisting.
- **D-E — The Safe keeps its direct delist** for emergencies, and can cancel
  any proposal during the waiting window.
- **D-F — A Safe veto sticks** (2026-10-18, after asking whether the bot would
  re-propose a vetoed wallet): the bot cannot propose a vetoed wallet again
  until the Safe or the owner lifts the veto.
- **D-G — Rehearse the cross-chain route on testnets with a stand-in**
  (2026-10-20, after RedStone's oracle was found only on Ethereum mainnet):
  a testnet-only contract answers in RedStone's place so request, reading and
  reply run on live testnet contracts. It is named as a stand-in on-chain and
  in every report, and each live deploy waits on the owner's go-ahead.

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

- **Delister bot — built** (`packages/contracts/scripts/sanctions-delister.mjs`,
  installed with the adder from `ops/sanctions/`). An hourly oneshot with its
  own key, which must be the timelock's proposer and nothing else (not the
  timelock's owner, nor the adder, remover, owner or pending owner of the
  list recorded on any chain the bot has an RPC for — the attestor's chain
  included, checked in the one client lookup every read and send goes
  through, before the key is used there), and a timelock that serves the
  list the release records; a chain failing either is refused. Nor may the
  key control anything else a delisting's outcome depends on: the owner or
  pending owner of the timelock, of the oracle the clearance is read from,
  or, on the cross-chain route, of the messenger at either end. A key that
  could also decide the clearance would leave only the Safe's veto between a
  stolen copy and a delisting. Which contracts are judged follows from the
  route alone, never from what a run managed to read, and any whose
  controller cannot be read refuses the chain for that run — request, relay
  and execution alike. That includes an attestor chain the bot cannot read
  (no RPC, an RPC serving another chain, a key holding a role on that
  chain's list): a clearance answer already delivered would otherwise let a
  proposal execute while the far side's control was never checked. There is
  no exemption for an oracle that does not identify itself: on the test
  networks the only clearance oracle is the stand-in, which answers both
  reads, and a mainnet release that reads RedStone decides how its control
  is established when it identifies RedStone. Per chain, each run:
  - discards a removed proposer's proposals; withdraws its own proposals that
    can no longer complete (vetoed, flagged by RedStone, already delisted
    another way, beyond the outstanding count, or no longer called for by a
    newer publication); reconfirms its own proposals onto a newer
    publication after re-checking every address in them;
  - after `eta`, requests the clearance (the CCIP fee plus a 10% margin);
    once RedStone's chain has read it, relays the `ClearanceRead` payload with
    `sendReply` on that chain, after checking its hash against the attestor's
    record; executes once `readiness` reports ready;
  - proposes the remaining delistings, in batches within the list's
    outstanding count. A candidate must be a delisting in the diff of the
    advanced file whose hash the list records, pass the witness check, and be
    absent from the plain SDN.XML, read by its own parser. The two files must
    carry the same publication date and list the same addresses (the plain
    file may also carry addresses the advanced file marks false), neither may
    carry a digital-currency value its parser reports as malformed (one may
    be a damaged copy of a delisting the 40-digit witness cannot see; with
    no person on this route, any such value stops every delisting), and the
    diff's delistings must number exactly the list's `pendingDelistings`.
    Addresses already proposed or vetoed by the Safe are left out (a veto is
    the Safe's own decision, so it is only noted); those RedStone flags today,
    or that only one file supports, are reported for the Safe; an unreadable
    RedStone answer skips the address for that run.

  Publication-derived steps wait while the list's latest version is not the
  finalized one. Every step that moves a proposal toward a delisting —
  requesting the clearance, relaying RedStone's answer, executing — is
  taken, whoever proposed it, only on a conclusive reading of OFAC's files
  made in that same chain state (a proposal reaching a new stage forces a new
  reading), and only when that reading supports delisting every address the
  proposal names. The contract checks a proposal's publication hash and date,
  the outstanding count, vetoes and RedStone, never the addresses against
  OFAC's files, so the bot is the only check on them: another proposer's
  proposal naming an address the reading does not support is never moved on
  and is reported for the Safe to veto, and the bot withdraws its own. A
  failed, stale or newer download, files that disagree, or a same-day
  reissue the adder will not apply by itself, and nothing moves; nor does
  anything while the timelock is not a remover of the list (`readiness` does
  not check the list's own authorization, so the bot does: without the role
  every request and relay would be paid for and every execution revert).
  Between OFAC
  publishing and the bot's next reading anyone may still execute a matured
  proposal, and the RedStone check is then the guard. With no RedStone check configured (every testnet today) the
  route is unavailable, so the bot proposes nothing and reports that the
  delistings await the Safe. The OFAC files are downloaded only when a chain
  has publication work, and a chain whose state is unchanged is re-checked
  daily; only a conclusive reading of a chain the run left untouched is
  remembered, so a failed download, two files from different publications, or
  any send (inclusion is not finality) means the next hour reads again. Every transaction is simulated, recorded by hash before broadcast,
  and reported as included, reverted, refused by the node, failed or unknown; one failure never stops the
  other steps, except that a transaction with an unknown outcome stops further sends on that chain
  for the run, so a later one cannot take its nonce. An unexpected error on one chain becomes that
  chain's report, with every send it already made, and a state file that cannot be written is
  reported and fails the run; neither can stop the report of what was sent. The key needs native
  gas on both chains of a cross-chain route, for the two CCIP fees.
- **CCIP clearance wiring — built for testnets (D-G)**,
  `contracts/script/ConfigureSanctionsClearance.s.sol`, run once per chain,
  attestor chain first. On the attestor chain it deploys (or reuses) a
  `TestnetSanctionsOracleStandIn` owned by the admin and a
  `SanctionsClearanceAttestor` reading it, wires a CCIP lane to each timelock
  chain, registers the attestor as the handler of the clearance channel
  (`keccak256("vaipakam.ccip.channel.sanctions-clearance")`) and sets each
  timelock as that channel's peer for its chain. On each timelock chain it
  wires the lane back, registers the timelock as the channel's handler with
  the attestor as peer, and calls `setClearanceSource` only when the source
  differs (each call voids requests in flight). Every step reads first and is
  skipped when already in place; a handler, peer or lane already set to
  something else stops the run, since re-pointing one needs the messenger's
  drain. Both new addresses are recorded in the attestor chain's artifact
  (`sanctionsOracleStandIn`, `sanctionsClearanceAttestor`).

  The testnet rehearsal hosts both on **BNB testnet** (97) for the Base
  Sepolia and Arbitrum Sepolia timelocks; Base↔BNB already has a lane, and
  the run adds Arbitrum↔BNB on both messengers. Three properties of the
  stand-in carry the honesty of the rehearsal:
  - **No mainnet.** Its constructor refuses any chain outside the testnet
    allowlist, and the wiring script refuses a mainnet before reading
    anything.
  - **It says what it is.** `isTestnetStandIn()` answers true and
    `STAND_IN_FOR` names RedStone's oracle. The delister asks every oracle it
    reads, through either route, whether it is the stand-in, and names the
    answer in every action, note and report line: "the testnet stand-in for
    RedStone" (with "NOT RedStone" on the report's oracle line) when the
    oracle itself answers that it is, and "the clearance oracle" for any
    other, whether it answers false or gives no answer. It never names an
    oracle RedStone: the delister runs on test networks only, where RedStone
    has no deployment, and RedStone's oracle carries no marker a run could
    read, so the only way to name it would be to infer it from a call that
    failed, which an RPC fault can imitate. A mainnet release must identify
    RedStone from the address it is recorded under. The attestor chain's own
    report names the oracle its attestor reads, even though no timelock lives
    there. Facts are read from the same address the report names. Who
    controls the stand-in is read too, never assumed: each run reads its
    owner and any pending owner, and the report names the owner as the one
    who flags and re-publishes, states a pending transfer, and says when
    ownership was renounced and nobody can re-publish it. The wiring and
    deploy scripts print a timelock's clearance check the same way, through
    one library (`script/lib/SanctionsClearanceReport.sol`): "clearance
    check", never "RedStone check"; the stand-in only on its own answer; and
    on a cross-chain route, that the attestor's oracle lives on another chain
    the run does not read, plus what that chain's artifact records.
  - **Its freshness is its owner's.** `getLastUpdateBlockTimestamp()` is the
    owner's last write (deploy, a flag change, or `markUpdated`), never the
    block's time. Left alone longer than a timelock's `oracleMaxAge`
    (default 7 days) it closes that timelock's automated route exactly as a
    frozen RedStone would, and the delister names the remedy. On the
    cross-chain route a stale clearance carries the oracle's update time as
    of the request, so the remedy is judged from the oracle's update time
    NOW: a fresh request alone when it has updated since, its owner (as read)
    re-publishing the stand-in when it has not, and a conditional
    instruction when the current time could not be read.
  - **Only the admin's stand-in is reused, nothing is wired through a
    contract another account could take over, and nothing is replaced while
    it still holds a role.** The wiring script reuses a recorded stand-in
    only while it answers as the stand-in, the admin owns it, and no
    ownership transfer is pending (one rule, `script/lib/AdminControl.sol`,
    shared by every sanctions deploy and configure script). An attestor
    binds its oracle for good, so binding one another account could take
    over would hand that account the clearance. The same rule gates every
    recorded contract a script writes through: the wiring script's messenger
    and timelock, and `DeploySanctionsDelisting`'s list. A pending owner
    there could accept and re-point whatever the run just wired, so the run
    refuses until the transfer is cancelled or completed. Failing the rule
    means "do not reuse", never "replace silently": when a replacement
    attestor would be needed while the old one still handles the clearance
    channel, the run stops,
    at the script's read of the channel or else at the messenger's own
    check. Nothing a refused run deployed is recorded: every sanctions
    deploy and configure script writes its artifact only after every step
    of the run has succeeded, because Forge executes the whole script
    before broadcasting and sends nothing when a step reverts, while an
    artifact written during that execution would survive the revert. The
    script does not copy the messenger's rules into an up-front check of
    its own; a copy could never be complete, and the messenger's refusals
    bind either way. `DeploySanctionsDelisting` applies the same rule to
    the timelock: it never deploys a second timelock beside a recorded one that
    is still a remover of the list, so a list never has two automated
    delisting routes. A list itself is never replaced: it holds the
    listings every consumer reads, with its adder, removers and timelock
    attached, so `DeploySanctionsList` refuses an unfit recorded list
    (another owner, a pending transfer, a secondary) instead of deploying an
    empty one, and starting a new list is the operator's deliberate act
    (remove the list record and the timelock record that serves it). A
    chain's records stay one bound set (`script/lib/SanctionsRecords.sol`):
    a timelock is bound to its list for good, so `DeploySanctionsList` never
    starts a new list while a timelock is still recorded, and the wiring
    script wires only a timelock that serves the recorded list, as the
    delister already refuses one that does not. Every route report (the two scripts, the delister)
    also says whether automated delisting is open at all: it is closed
    while the timelock is not a remover of its list, the owner's one-step
    shutdown, whatever clearance check is wired.

  A fork test (`contracts/test/fork/SanctionsClearanceLiveForkTest.t.sol`,
  gated on `FORK_URL_BNB_TESTNET` plus each timelock chain's URL) runs the
  script against forks of the three live testnets and drives a drill
  proposal through request, reading, reply and execution on each timelock
  chain, plus a stand-in flag that refuses the delisting. It delivers each
  CCIP message from the source router's captured `ccipSend` to the
  destination messenger as that chain's router, after checking the router
  lists an off-ramp for the source lane: Chainlink's local fork simulator
  cannot parse these lanes' newer on-ramp event. A live delisting on the
  testnets still needs an OFAC delisting to propose, so until one appears
  the fork drill is the end-to-end proof.

  For the bot on a cross-chain route: its key needs native gas on the
  attestor chain (tBNB on the rehearsal) for the reply's CCIP fee as well as
  on each timelock chain, and the attestor chain needs an RPC in its env.
- **Mainnet:** follows the adder host decision.
