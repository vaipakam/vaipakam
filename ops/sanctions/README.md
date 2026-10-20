# Sanctions services

Two unattended services keep a `SanctionsList` current with OFAC's SDN list
(#2443), each with its own key, env file and units:

- the **adder** lists OFAC's new designations with the list's adder key;
- the **delister** proposes OFAC's delistings to the
  `SanctionsDelistingTimelock` with the timelock's proposer key. The Safe may
  veto any of them during the waiting window, and none executes while
  RedStone's Sanctions Oracle flags the address.

Both run from **one release** of a named commit on main, installed by one
`install.sh`, so they always read a publication with the same parser.

The list splits its signers by direction (owner decisions 2026-10-18, "Bot
adds, Safe removes" and "Bot proposes, Safe vetoes"):

| Role | Who | May |
| --- | --- | --- |
| owner | the admin | appoint and remove adders, removers and proposers; authorize a rollback; veto |
| adder | the adder's key | list addresses; record a publication |
| remover | the Safe (a multisig) | delist directly; veto or cancel any proposal |
| remover | the timelock | delist a proposal once its window has passed, nothing vetoes it and RedStone clears it |
| proposer | the delister's key | propose delistings to the timelock; withdraw or reconfirm its own |

## 1. The adder

Once a day it:

1. downloads Treasury's `sdn_advanced.xml` **once** and keeps it on disk,
   named by publication date and hash, as the record of what was parsed;
2. parses it once, **in pieces** (about 150 MB resident for the 128 MB
   2026-10 file, never the whole file in memory), with the same parser and
   refusals as `packages/contracts/scripts/ofac-sanctions-diff.mjs`, so every
   chain follows the same publication;
3. for every configured chain, concurrently and independently, reads the list
   at the finalized block, sends the publication's **additions**, and for a
   new publication declares its **delistings** outstanding on-chain without
   applying them, so the list says which publication it follows and what of
   it is still to be delisted. One chain's failure never stops another's;
4. reports once, with a section per chain, to the journal and, when
   configured, the ops Telegram chat. Outstanding delistings are reported on
   every run until they are applied.

It **never delists, never rolls back, and never runs on a mainnet**. Every
refusal of the diff tool stops the run before anything is sent — a malformed
or moved record, a delisting the file does not support, more delistings than
the cap, an older or conflicting publication — as do a list that moved past
the finalized block and a key that is not the list's adder alone (also a
remover or the owner).

## 2. The delister

Every hour it, for every configured chain with a timelock recorded:

1. reads the timelock, the list and every pending proposal;
2. only when there is **publication work** (a delisting the list declares
   outstanding that no proposal covers and that could be proposed now, one of
   its own proposals left behind by a newer publication, or a proposal with a
   step to take — a clearance to request, an answer to relay, an execution)
   downloads OFAC's **two** exports of the publication once for
   every chain: `sdn_advanced.xml` (the file the list records by hash) and the
   plain `SDN.XML`, read by a separate parser
   (`packages/contracts/scripts/ofac-sdn-plain.mjs`). An unchanged chain is
   re-checked at least once a day, so a delisting the Safe vetoed does not
   cost a 150 MB download every hour; a failed download, a pair of files from
   two different publications, or a run that sent anything on that chain
   (inclusion is not finality) is read again the next hour;
3. moves every pending proposal on as far as it can go: discards one whose
   proposer the owner removed; withdraws one of its own that can no longer
   execute (an address vetoed, flagged by RedStone, already delisted another
   way, or no longer delisted by OFAC's newer file); reconfirms one of its own
   onto a newer publication (the window is kept); after the window, on the
   cross-chain route, requests RedStone's answer (only once the attestor's
   chain is reachable from here, since a request costs a CCIP fee and its
   answer must be relayed back) and relays it back; and
   executes it once the timelock reports it ready. Each of those steps, for
   anyone's proposal, needs a reading of OFAC's files made in that same state
   that supports delisting every address the proposal names: with a failed,
   stale or newer download, files that disagree, or the list mid-update, none
   is taken, and another proposer's proposal naming an address the files do
   not support is named for the Safe to veto. None is taken either while the
   timelock is not a remover of the list: revoking that role is the owner's
   one-call shutdown of the route, and stops requests, relays and executions,
   not only new proposals;
4. proposes the rest: the delistings **both files** support (the advanced
   file's diff, with its witness that the address's digits are gone from the
   file, and the plain file, which must not mention the address at all),
   minus addresses already proposed or vetoed by the Safe (its own decision,
   noted in the journal), and those RedStone flags now (named for the Safe),
   within what the list declares outstanding;
5. reports to the journal every run, and to the ops chat when something was
   sent or failed or needs a person, repeated once a day while it lasts.

It refuses, and leaves for a person: a key that is not the timelock's
proposer alone — the timelock's owner, or the adder, remover or owner of the
list recorded on ANY chain it has an RPC for, the attestor's chain included,
checked before the key is used on that chain at all (a chain with no
timelock whose list it holds a role on is reported refused, and fails the
run); a recorded timelock that serves another list; publication work against
a file the list does not record, a delisting the advanced file still
witnesses, a count that differs from what the list declares outstanding, two
OFAC files that disagree, or a digital-currency value in either file that is
not a readable address (it may be a damaged copy of an address being
delisted, so every unattended delisting waits for a person while one is
there). An address only one file supports, or that RedStone flags, is named
in the report and left for the Safe. It **never lists, never delists by itself, never lifts a veto, and
never runs on a mainnet**.

**Which RedStone check applies** is the timelock's own `clearanceRoute()`:
`Local` where the list composes RedStone on this chain, `CrossChain` through
Chainlink CCIP to a `SanctionsClearanceAttestor` where RedStone runs, or
`Unavailable`, in which case nothing can execute, the delister proposes
nothing, and its report says the delistings await the Safe. On the cross-chain
route the delister's key pays both CCIP fees (the request on the timelock's
chain, the reply on the attestor's), so it needs native gas on both, and the
attestor's chain needs an RPC in the env file even when no timelock lives
there.

On a testnet both services work against a **rehearsal** list:
`DeploySanctionsList` deploys it beside the Diamond's
`TestnetSanctionsOverlay`, and the Diamond does not screen against it. Nothing
a user sees changes.

## 3. Where they run

On an always-on machine — today the keeper's Oracle Cloud VM — as their own
systemd units, beside the keeper and separate from it and from each other:

- their own **keys**: the adder key is appointed adder and nothing else; the
  delister key is appointed proposer and nothing else. Neither is the
  keeper's key, the owner, or a remover;
- their own **env files**, `/etc/vaipakam/sanctions-adder.env` and
  `/etc/vaipakam/sanctions-delister.env`, beside the keeper's `keeper.env`
  and held the same way (root-only, 0600): the key and one RPC per chain,
  under the keeper's RPC names. No contract address is ever set there: each
  comes from the installed release's `deployments.json` (`sanctionsList`,
  `sanctionsDelistingTimelock`), and the attestor from the timelock itself;
- their own **dynamic user** per run, which reads only its own env file;
- a **memory cap** (`MemoryMax=384M`) and low CPU and IO weights, so an
  unexpected growth fails that service's run and never the keeper;
- **manual deploys of a named commit on main**. A merge does not deploy them:
  they sign compliance transactions, so what they run is a deliberate choice.

## 4. Install

### 4.1 Once per service: the key

Create each key (a fresh EOA, used for nothing else). The same adder key is
the adder on every chain and the same delister key the proposer on every
chain; fund each with a little gas on each chain (the delister also pays the
CCIP fees on a cross-chain route).

### 4.2 Once per chain: the list, then the timelock

From the machine holding the admin and deployer keys, with the role addresses
in `contracts/.env` beside `ADMIN_PRIVATE_KEY` (`SANCTIONS_ADDER_ADDRESS`,
`SANCTIONS_REMOVER_ADDRESS` = the Safe, `SANCTIONS_DELISTER_ADDRESS`):

```bash
cd contracts
forge script script/DeploySanctionsList.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"                    # dry run
forge script script/DeploySanctionsList.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow
forge script script/DeploySanctionsDelisting.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"               # dry run
forge script script/DeploySanctionsDelisting.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow
```

The first refuses an adder equal to the remover or the owner and records the
list as `sanctionsList`. The second deploys the timelock for that list,
appoints it a remover and the delister key its proposer, and records it as
`sanctionsDelistingTimelock`; it configures no RedStone check. Both reuse what
is already recorded. Then export deployments
(`bash contracts/script/exportFrontendDeployments.sh`), commit, and merge: the
services read the addresses from the release they run, so a new contract
reaches them with the next install.

### 4.3 On the machine

```bash
C=<full commit sha on main>
curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/ops/sanctions/install.sh"
sudo bash install.sh "$C"
```

`install.sh` builds the release from exactly that commit (the contracts
package, with dependencies pinned by the lockfile and no install scripts run),
checks it with `sanctions-adder.mjs --check` and `sanctions-delister.mjs
--check`, switches `/opt/vaipakam-sanctions/current` to it, and installs both
services' units from the same commit. The checks run on every install, a
rollback included, and each runs the way the unit runs that service: as a
throwaway dynamic user, with an empty environment, through a link to the
release, and it must print its `release ok` line. A release the service could
not read, or a script that would not run when started through `current`,
therefore stops the install and leaves `current` where it was. It creates each env file from its
template (0600, root-only) only if it does not exist, and never overwrites
one. It never starts or enables anything. A machine that ran the adder-only
installer of #2557 has its old `/opt/vaipakam-sanctions-adder` removed once
the units point at the new release.

### 4.4 Cut over, one service at a time

```bash
sudoedit /etc/vaipakam/sanctions-adder.env      # the adder key, and one RPC per chain
sudo systemctl start vaipakam-sanctions-adder.service
journalctl -u vaipakam-sanctions-adder -n 80
sudo systemctl enable --now vaipakam-sanctions-adder.timer

sudoedit /etc/vaipakam/sanctions-delister.env   # the delister key, and one RPC per chain
sudo systemctl start vaipakam-sanctions-delister.service
journalctl -u vaipakam-sanctions-delister -n 80
sudo systemctl enable --now vaipakam-sanctions-delister.timer
```

A run that worked ends its journal with its report and writes
`last-run.json` in its state directory (§5). A run that exits with neither did
not do its work, even when systemd reports it finished successfully: stop
there, and don't enable that timer.

Each key is typed once, on the machine that uses it, and never copied between
machines. Adding a chain later is one RPC line (and its contracts recorded in
the installed release).

## 5. Operating them

- **Last run:** `/var/lib/vaipakam-sanctions-adder/last-run.json` and
  `/var/lib/vaipakam-sanctions-delister/last-run.json`, and the journal, with
  one section per chain. Any chain refused, stopped or partly failed, or an
  alert not delivered, fails the unit, so it shows in `systemctl --failed`.
  An alert Telegram refuses is recorded with Telegram's own reason (for
  example "chat not found": a wrong `TG_OPS_CHAT_ID`, or a bot that is not a
  member of that chat).
  For the delister, "partly failed" includes work a chain needed that an
  error put off (no conclusive reading of OFAC's files it needed, such as a
  failed download or two files that disagree, or candidates it could not
  check), reported as NOT DONE; work that waits by design (a
  window, RedStone's answer, the adder recording a newer publication) does
  not fail it.
- **The adder** marks a chain `applied` only once ONE reading of the list,
  at one finalized block, holds exactly the update it planned: at the
  update's last version, the planned addresses (the reading the update was
  built on plus every addition, nothing more and nothing removed), this
  publication, and the outstanding counts the update declared. That is the
  same reading every update is computed from (one snapshot, every read
  pinned to the finalized block's hash), and nothing is carried from one
  reading to the next, since two readings may come from different servers.
  Finality is a fact about the list, never about a transaction: no reading
  can say which transaction produced the list's state, so the report names
  the transactions it sent and the reading that holds the update. No
  transaction receipt decides it, since a load-balanced RPC can answer a
  receipt and the finalized block from replicas on different forks. So from
  the first broadcast the list decides, however the sends ended: when every
  transaction was broadcast and none is known to have failed (the last
  receipt may simply never have come), the run waits for finality just as
  when every receipt came; otherwise one transaction was never sent or is
  known to have listed nothing, and one reading of the list says what it
  holds. A reading that holds exactly the planned update makes the chain
  `applied` either way, and the report still names the transactions no
  receipt confirmed. A failed read is read again every 15 seconds, for up to
  40 minutes. "This publication" means the same date AND file hash, the pair
  the list records; this file's hash recorded under another date is a
  conflicting record, reported as such and never as this publication. A
  chain that stops part-way is `stopped`: it lists each transaction it broadcast as
  included (not confirmed final), included and reverted, or broadcast with
  no receipt (it may still land), and says why it stopped: the list at the
  update's last version holds something else (other updates took its
  versions, so it can never apply as planned), the list had already moved
  past it before a reading showed it (its outcome is unknown), the list
  never reached it (it may still land), or the list could not be read
  (unknown). Check those before acting. Every report, a refused or stopped
  one included, states what the last finalized reading of the list declares
  outstanding and for which publication, from the reading taken after its
  last broadcast, and says it is unknown when no such reading could be
  taken. This run's delistings are named
  only for the reading they were computed from or the update's planned
  outcome; for any other state of the list, even of the same publication,
  the report gives the count and the command that works them out from the
  list itself. Every run rebuilds from
  the list at the finalized block, so the next run follows whatever really
  happened.
- **The delister** lists each transaction it sent as included, reverted,
  refused by the node (not broadcast), failed (not sent), or broadcast with
  its outcome unknown, and every pending proposal's state. "Refused" needs
  both the node naming why it will not take the transaction and its answer
  "not found" for the hash; anything less is unknown. The adder reads a send
  the same way. After an unknown
  outcome it sends nothing more on that chain that run. It waits for inclusion only: the next run reads the chain again, and
  every step it takes is refused on-chain if it no longer applies. Its state
  directory also holds caches only (`evaluations.json`, `relay.json`,
  `last-alert.json`); deleting them costs a download, never a wrong action.
- **State files that cannot be written** (a full disk, a permission): both
  services write every state file whole (a temporary file renamed over the
  old) and never let a failed write stop the run's report. The delister
  names the file under STATE NOT SAVED in the journal, the chat and
  last-run.json; either service fails its unit for it.
- **Kept publications:** each service's state directory,
  `sdn-<date>-<hash>.xml` (and, for the delister, `sdn-plain-<date>-<hash>.xml`),
  newest 14.
- **Delistings the delister leaves for the Safe** — RedStone flags them, the
  two files disagree, or no RedStone check is configured — and any delisting
  the Safe decides to make itself: confirm each against OFAC's Recent Actions
  notice, then run the diff tool on that exact file and send its remover
  calls from the Safe:

  ```bash
  cd /opt/vaipakam-sanctions/current/packages/contracts
  sudo /usr/local/bin/node scripts/ofac-sanctions-diff.mjs \
    --xml /var/lib/vaipakam-sanctions-adder/sdn-<date>-<hash>.xml \
    --rpc "$RPC" --chain-id 84532 --list 0x<list> --confirm-delist 0xA,0xB
  ```

  The adder's report prints this command with the chain id and list filled
  in. It prints the remover's calldata; it signs nothing.
- **Veto a proposal:** from the Safe, `cancel(id)` on the timelock (vetoes
  every address in it), or `setVetoed([addresses], true)` before or after a
  proposal. A veto sticks until the Safe or the owner lifts it.
- **A refused run** says why in the journal and the chat. The next run
  retries; a refusal that repeats needs a person.
- **Stop one:** `systemctl disable --now vaipakam-sanctions-<service>.timer`;
  to stop one chain, remove its RPC line. To take a key's power away on a
  chain, the owner calls `setAdder(<key>, false)` on that chain's list, or
  `setProposer(<key>, false)` on its timelock (which also voids every proposal
  that key made).
- **Move to a new commit:** re-run `install.sh` with it. The previous release
  is kept; re-running `install.sh` with its commit is the rollback. Never roll
  back to a commit from before #2586: its services skip their work when started
  through `current`, and report success. The installer from #2586 on refuses
  one, because its check fails; an older installer would not. That works
  between commits that carry this kit; a commit from before the adder and the
  delister shared it is refused by name, and goes back through that commit's
  own `ops/sanctions-adder/install.sh` after
  `systemctl disable --now vaipakam-sanctions-delister.timer`. Moving off the
  adder-only layout waits while the adder is mid-run, since it deletes the
  release that run executes from.

## 6. Residual risk, stated

A stolen **adder** key can list arbitrary addresses (blocking those wallets
from opening new positions; closing out stays open) or record a publication
dated in the future, which stalls later updates until the owner authorizes a
rollback. Both are recoverable by the owner and the Safe. The key cannot
delist and cannot appoint anyone.

A stolen **delister** key can propose wrongful delistings, no more in total
than the publication declares outstanding. Each waits out the window, during
which the Safe can veto it, and executes only if a current RedStone clears it.
It cannot shorten the window, skip the RedStone check, lift a veto or touch
another proposer's proposals, and the owner removing it voids everything it
queued.

Those bounds are why these two keys alone run unattended.
