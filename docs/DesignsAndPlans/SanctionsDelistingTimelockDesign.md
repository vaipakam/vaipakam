# Sanctions delisting — bot proposes, Safe vetoes, RedStone agrees (#2443)

Status: built (contracts, tests, testnet deploy script). The delister bot and
the CCIP clearance wiring are follow-ups, listed in §7.

## 1. Decisions this records

All from the owner, 2026-10-18, in the "Open GitHub issues plan" thread:

- **D-A — Bot proposes, Safe vetoes.** Delisting may be automated, but a
  multisig must be able to stop any single delisting before it happens.
- **D-B — RedStone must agree.** A wallet is delisted only while RedStone's
  Sanctions Oracle, the only independent on-chain list available, does not
  flag it.
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
   5. RedStone clears every address (§4).

   Then it calls `SanctionsList.applyUpdate` as a **repeat of the recorded
   publication**, delisting the batch and lowering `pendingDelistings` by its
   size. The list's own rules (version, publication order, pending counts)
   apply unchanged.

## 4. The RedStone gate

| Where | How | Failure |
| --- | --- | --- |
| The list composes RedStone as its secondary on this chain | `secondary.isSanctioned(a)` read live at execution | A revert propagates (fail closed); `true` reverts `StillSanctioned` |
| Otherwise, a clearance source is configured | The newest CCIP clearance per address, which must be from the current source epoch, observed at or after `eta`, at most `clearanceMaxAge` old (1 hour to 7 days, default 1 day), and unflagged | `ClearanceMissingOrStale` or `StillSanctioned` |
| Neither | none | `ClearanceUnavailable`: automated delisting is closed and only the Safe's direct delist remains |

**Why "at or after `eta`".** A designation RedStone makes during the window
must be caught. A clearance read when the proposal was made would miss it.

**The clearance path:**

- **`SanctionsClearanceAttestor`**, deployed on a chain where RedStone runs,
  is permissionless and ownerless.
  - `attest(destChainId, accounts)` reads `oracle.isSanctioned` for each
    address. A revert propagates, so an unreadable oracle never yields "not
    flagged".
  - It sends `(version, accounts, flagged, asOf)` through the chain's
    `ICrossChainMessenger`, and passes on the messenger's fee refund.
  - A caller chooses which addresses are read, never the answer.
- **The timelock's `onCrossChainMessage`** accepts a message only when all of
  these hold:
  - it comes from the configured messenger;
  - the source chain and sender are the configured attestor (on top of the
    messenger's own lane and peer authentication);
  - it carries no tokens and has a known wire version.

  It keeps the newest reading per address, because CCIP may deliver out of
  order, and clamps a future source timestamp to the local clock. Changing the
  source bumps an epoch, so readings from the old source stop counting.

## 5. What each key can do if stolen

| Key | Can | Cannot |
| --- | --- | --- |
| Proposer (delister bot) | Propose wrongful delistings, which the Safe can veto and RedStone must still clear; withdraw proposals | Shorten the window, skip the RedStone check, lift a veto |
| Adder | List addresses; record a publication | Delist |
| Safe (remover) | Delist directly; veto; cancel | — (it is the multisig) |
| Owner (admin) | Appoint or revoke the proposer and the timelock's remover role; set the delay, the clearance source and its max age; veto | Delist without appointing itself |

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
  - after `eta`, requests the attestation on the RedStone chain;
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
