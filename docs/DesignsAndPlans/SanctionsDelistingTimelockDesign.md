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
   - be no larger than the publication's declared outstanding delistings
     (`pendingDelistings`), and at most 100 addresses;
   - contain no address already in a pending proposal or vetoed.

   The proposal's `eta` is `now + delay`. `delay` is set by the owner,
   between 1 and 30 days, 48 hours by default, and is fixed per proposal when
   it is made.
2. **Window.** The Safe (any remover of the list) or the owner may `cancel`,
   which **vetoes** every address in the proposal. `setVetoed` vetoes, or
   lifts a veto on, any address at any time, including before a proposal. A
   proposer may `cancel` too, which only withdraws and vetoes nothing.
3. **New publication during the window.** The adder runs daily, so the list
   can move to a newer OFAC file before `eta`. Execution then refuses
   (`PublicationChanged`). The bot re-checks the addresses against the new
   file and calls `reconfirm`, which moves the proposal to it **without
   restarting the window**: the decision the Safe was given time to veto has
   not changed.
4. **Execute** (anyone, after `eta`). Checks run in this order:
   1. pending and matured;
   2. publication unchanged;
   3. within `pendingDelistings`;
   4. not vetoed;
   5. a current RedStone clears every address (§4).

   Then it calls `SanctionsList.applyUpdate` as a **repeat of the recorded
   publication**, delisting the batch and lowering `pendingDelistings` by its
   size. The list's own rules (version, publication order, pending counts)
   apply unchanged.

## 4. The RedStone gate

Two things must hold for every execution, whichever route reads RedStone:

- **RedStone does not flag any address in the batch.**
- **RedStone is current.** Its own `getLastUpdateBlockTimestamp()` must be
  known (not missing, reverting, zero or in the future) and no older than
  `oracleMaxAge` (owner-set, 1 to 30 days, default 7). A frozen oracle keeps
  answering, and answers "not flagged" for every address it never listed —
  the same failure that retired Chainalysis's oracle from this design. One
  reading rule, `LibOracleFreshness`, serves the list's `secondaryLastUpdate`,
  this gate and the attestor. RedStone publishes no update cadence for this
  oracle, so the default is generous; a quieter oracle closes the automated
  route and leaves the Safe's direct delist.

| Where | How | Failure |
| --- | --- | --- |
| The list composes RedStone as its secondary on this chain | Freshness, then `secondary.isSanctioned(a)`, read live at execution | `OracleFreshnessUnknown` / `OracleStale`; a read revert propagates (fail closed); `true` reverts `StillSanctioned` |
| Otherwise, a clearance source is configured | The proposal's current challenge (below), answered `Cleared` with a known, recent oracle time | `ClearanceNotRequested`, `ClearanceExpired`, `ClearanceNotAnswered`, `ClearanceFlagged`, `OracleFreshnessUnknown`, `OracleStale` |
| Neither | none | `ClearanceUnavailable`: automated delisting is closed and only the Safe's direct delist remains |

**The cross-chain challenge.** A designation RedStone makes during the window
must be caught, so the reading has to be taken after the window ends. Comparing
the attestor chain's timestamp with this chain's cannot prove that: the two
clocks are independent, and a source clock running ahead would let a reading
taken inside the window pass for one taken after it. So the proof is causal
instead:

- After `eta`, anyone may call `requestClearance(id)`. It issues a challenge
  derived from the previous block's hash (plus the contract, chain, proposal,
  epoch and a nonce), so it cannot be known before it is issued, and it is
  issued only after the window. An answer echoing it was therefore read after
  the window. Stated precisely: the previous block's hash is public one block
  before the challenge is issued, so a caller who predicts that its own
  request lands in the next block can learn the challenge at most one block
  (seconds) early. That lead is bounded by the block time, not by either
  chain's clock.
- The challenge is usable for `clearanceMaxAge` after issue (1 hour to 7 days,
  default 1 day), measured on this chain's clock. A new one may be issued only
  when the proposal has none under the current source or the current one has
  lapsed, so nobody can keep voiding an answer in flight.
- An answer counts only for the proposal's exact batch (its `accountsHash`).
- One flagged answer marks the challenge `Flagged` for good. Two answers to
  one challenge can disagree only if RedStone changed between them; whichever
  arrives first, the result fails closed. A later challenge, after this one
  lapses, is a fresh reading.
- Among "not flagged" answers, the freshest oracle time is kept, clamped to
  this chain's clock. Clock skew between chains is seconds against an
  `oracleMaxAge` of days, so it is the one clock comparison left, and it is
  bounded.

**The clearance path:**

- **`SanctionsClearanceAttestor`**, deployed on a chain where RedStone runs,
  is permissionless and ownerless.
  - `attest(destChainId, challenge, accounts)` reads `oracle.isSanctioned`
    for each address. A revert propagates, so an unreadable oracle never
    yields "not flagged". It also reads the oracle's own last-update time (0
    when unknown).
  - It sends `(version, challenge, accounts, flagged, oracleUpdatedAt)`
    through the chain's `ICrossChainMessenger`, and passes on the messenger's
    fee refund.
  - A caller chooses which addresses are read and which challenge is echoed,
    never the answer.
- **The timelock's `onCrossChainMessage`** reverts unless all of these hold:
  - it comes from the configured messenger;
  - the source chain and sender are the configured attestor (on top of the
    messenger's own lane and peer authentication);
  - it carries no tokens, has a known wire version and matching array lengths.

  A well-formed message that carries no evidence about a live proposal — an
  unknown or superseded challenge, a closed proposal, other addresses — is
  ignored with `ClearanceIgnored` and its reason, not reverted, since anyone
  can make the attestor send one. Changing the source bumps an epoch, which
  voids every outstanding challenge.

## 5. What each key can do if stolen

| Key | Can | Cannot |
| --- | --- | --- |
| Proposer (delister bot) | Propose wrongful delistings, which the Safe can veto and a current RedStone must still clear; withdraw proposals | Shorten the window, skip the RedStone check, lift a veto |
| Adder | List addresses; record a publication | Delist |
| Safe (remover) | Delist directly; veto; cancel | — (it is the multisig) |
| Owner (admin) | Appoint or revoke the proposer and the timelock's remover role; set the delay, the clearance source, the challenge lifetime and the oracle's max age; veto | Delist without appointing itself |

## 6. Stated limits

- The contract cannot read OFAC's files. That a proposed address really left
  the SDN list is the bot's off-chain check (§7). On-chain, what is enforced
  is that the address is listed, that the publication is the recorded one,
  that the batch fits its declared delistings, the window, the veto, and
  RedStone.
- RedStone's coverage is its own. "RedStone does not flag it" is a necessary
  condition, not proof of delisting.
- A vetoed address that OFAC's file still calls for stays counted in the
  list's `pendingDelistings`. That is deliberate: the list keeps saying the
  publication is not fully applied, rather than hiding the disagreement.

## 7. Follow-ups

- **Delister bot** (separate PR): it downloads both OFAC files, requires the
  advanced file's hash to equal the list's, and requires both files to carry
  the same publication date. Its candidates are the diff's delistings, each
  absent from the plain file and passing the witness check, minus addresses
  already proposed, vetoed, or flagged by RedStone. It then:
  - proposes the candidates;
  - after `eta`, calls `requestClearance` on the timelock's chain and then
    `attest` with that challenge on the RedStone chain;
  - executes matured proposals;
  - reconfirms after a new publication.

  It is configured and installed the way the adder is (#2557): one root-only
  file, `/etc/vaipakam/sanctions-delister.env`, holding its own key (never the
  adder's, the keeper's, the owner's or the Safe's) and one RPC per chain
  under the keeper's names; the timelock and list addresses come from the
  installed release's `deployments.json`, never from the file; one run reads
  the OFAC files once and serves every chain.
- **CCIP clearance wiring** (with the bot):
  - deploy the attestor where RedStone runs;
  - register it as the clearance channel's handler there, with the timelock
    as peer, and the mirror image on the timelock's chain;
  - call `setClearanceSource`.
- **Mainnet:** follows the adder host decision.
