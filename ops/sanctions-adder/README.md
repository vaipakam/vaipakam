# Sanctions adder

The service that keeps a `SanctionsList` current with OFAC's SDN list,
unattended, using the list's **adder** key (#2443).

## 1. What it is, and what it is not

The list splits its signers by direction (owner decision 2026-10-18, "Bot
adds, Safe removes"):

| Role | Who | May |
| --- | --- | --- |
| owner | the admin | appoint and remove adders and removers; authorize a rollback |
| adder | this service's key | list addresses; record a publication |
| remover | the Safe (a multisig) | delist |

Once a day the service:

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
   it still awaits the Safe. One chain's failure never stops another's;
4. reports once, with a section per chain, to the journal and, when
   configured, the ops Telegram chat. Outstanding delistings are reported on
   every run until the Safe applies them.

A chain is configured by setting its RPC in the one env file. Its list
address is **not** configured: it is the `sanctionsList` the installed
release's `deployments.json` records, so the address the service writes to is
the reviewed, committed one. A chain with an RPC but no recorded list is
reported as skipped.

It **never delists, never rolls back, and never runs on a mainnet**: the
mainnet adder host is not decided, and the runner's chain table holds testnets
only (mainnet RPC names in the file are ignored, and the journal says so). Every refusal of the diff tool stops the run
before anything is sent — a malformed or moved record, a delisting the file
does not support, more delistings than the cap, an older or conflicting
publication — as do a list that moved past the finalized block and a key that
is not the list's adder alone (also a remover or the owner).

On a testnet the list is a **rehearsal target**: `DeploySanctionsList` deploys
it beside the Diamond's `TestnetSanctionsOverlay`, and the Diamond does not
screen against it. Nothing a user sees changes.

## 2. Where it runs

On an always-on machine — today the keeper's Oracle Cloud VM — as its own
systemd units, beside the keeper and separate from it:

- its own **key**, appointed adder and nothing else. It is never the keeper's
  key, never the owner, never a remover;
- its own **env file**, `/etc/vaipakam/sanctions-adder.env`, beside the
  keeper's `keeper.env` and held the same way (root-only, 0600): the key and
  one RPC per chain, under the keeper's RPC names;
- its own **dynamic user** per run, which reads only its own env file;
- a **memory cap** (`MemoryMax=384M`) and low CPU and IO weights, so an
  unexpected growth fails the adder's run and never the keeper;
- **manual deploys of a named commit on main**. A merge does not deploy it:
  the adder signs compliance updates, so what it runs is a deliberate choice.

## 3. Install

### 3.1 Once: the key

Create the adder key (a fresh EOA, used for nothing else). The same key is the
adder on every chain; fund it with a little gas on each.

### 3.2 Once per chain: the list

From the machine holding the admin and deployer keys, with the role addresses
in `contracts/.env` beside `ADMIN_PRIVATE_KEY` (`SANCTIONS_ADDER_ADDRESS`, and
`SANCTIONS_REMOVER_ADDRESS` = the Safe):

```bash
cd contracts
forge script script/DeploySanctionsList.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"                    # dry run
forge script script/DeploySanctionsList.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow
```

It refuses an adder equal to the remover or the owner, records the list as
`sanctionsList` in the chain's artifact, and reuses a recorded list the admin
still owns. Then export deployments
(`bash contracts/script/exportFrontendDeployments.sh`), commit, and merge: the
service reads the list's address from the release it runs, so a new list
reaches it with the next install.

### 3.3 On the machine

```bash
C=<full commit sha on main>
curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/ops/sanctions-adder/install.sh"
sudo bash install.sh "$C"
```

`install.sh` builds the release from exactly that commit (the contracts
package, with dependencies pinned by the lockfile and no install scripts run),
checks it with `sanctions-adder.mjs --check`, switches
`/opt/vaipakam-sanctions-adder/current` to it, and installs the units from the
same commit. The first time, it creates `/etc/vaipakam/sanctions-adder.env`
from the template (0600, root-only); it never overwrites it. It never starts
anything.

### 3.4 Cut over

```bash
sudoedit /etc/vaipakam/sanctions-adder.env      # the adder key, and one RPC per chain
sudo systemctl start vaipakam-sanctions-adder.service
journalctl -u vaipakam-sanctions-adder -n 80
sudo systemctl enable --now vaipakam-sanctions-adder.timer
```

The key is typed once, on the machine that uses it, and never copied between
machines. Adding a chain later is one RPC line (and its list recorded in the
installed release).

## 4. Operating it

- **Last run:** `/var/lib/vaipakam-sanctions-adder/last-run.json`, and the
  journal, with one section per chain. A chain is `applied` only once its
  transactions are final and still in the blocks they were included in. A
  chain that stops part-way is `stopped`, and lists each transaction it
  broadcast as final, included but not final, or broadcast with no receipt
  (it may still land); check those before acting. The file also records
  whether the ops alert was delivered. Any chain refused or stopped, or an
  alert not delivered, fails the unit, so it shows in `systemctl --failed`.
- **Kept publications:** the same directory, `sdn-<date>-<hash>.xml`, newest
  14 by default.
- **Delistings awaiting the Safe:** the run's report names them and the file
  they came from. Confirm each against OFAC's Recent Actions notice, then run
  the diff tool on that exact file and send its remover calls from the Safe:

  ```bash
  cd /opt/vaipakam-sanctions-adder/current/packages/contracts
  sudo /usr/local/bin/node scripts/ofac-sanctions-diff.mjs \
    --xml /var/lib/vaipakam-sanctions-adder/sdn-<date>-<hash>.xml \
    --rpc "$RPC" --chain-id 84532 --list 0x<list> --confirm-delist 0xA,0xB
  ```

  The report prints this command with the chain id and list filled in. It
  prints the remover's calldata; it signs nothing.

- **A refused run** sends nothing and says why in the journal and the chat.
  The next run retries; a refusal that repeats needs a person.
- **Stop it:** `systemctl disable --now vaipakam-sanctions-adder.timer`; to
  stop one chain, remove its RPC line. To take the key's power away on a
  chain, the owner calls `setAdder(<key>, false)` on that chain's list.
- **Move to a new commit:** re-run `install.sh` with it. The previous release
  is kept; re-running `install.sh` with its commit is the rollback.

## 5. Residual risk, stated

A stolen adder key can list arbitrary addresses (blocking those wallets from
opening new positions; closing out stays open) or record a publication dated
in the future, which stalls later updates until the owner authorizes a
rollback. Both are recoverable by the owner and the Safe. The key cannot
delist and cannot appoint anyone. That bound is why the adder alone runs
unattended.
