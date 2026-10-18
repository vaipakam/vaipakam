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

Once a day, per chain, the service:

1. downloads Treasury's `sdn_advanced.xml` and keeps it on disk, named by
   publication date and hash, as the record of what was parsed;
2. parses it **in pieces** (about 150 MB resident for the 128 MB 2026-10
   file, never the whole file in memory) with the same parser and refusals as
   `packages/contracts/scripts/ofac-sanctions-diff.mjs`;
3. reads the list at the chain's finalized block;
4. sends the publication's **additions**, and for a new publication declares
   its **delistings** outstanding on-chain without applying them, so the list
   says which publication it follows and what of it still awaits the Safe;
5. reports to the journal and, when configured, the ops Telegram chat.
   Outstanding delistings are reported on every run until the Safe applies
   them.

It **never delists, never rolls back, and never runs on a mainnet**: the
mainnet adder host is not decided, and the runner refuses any chain id outside
the contracts' testnet set. Every refusal of the diff tool stops the run
before anything is sent — a malformed or moved record, a delisting the file
does not support, more delistings than the cap, an older or conflicting
publication — as do a list that moved past the finalized block and a key that
is not the list's adder.

On a testnet the list is a **rehearsal target**: `DeploySanctionsList` deploys
it beside the Diamond's `TestnetSanctionsOverlay`, and the Diamond does not
screen against it. Nothing a user sees changes.

## 2. Where it runs

On an always-on machine — today the keeper's Oracle Cloud VM — as its own
systemd units, beside the keeper and separate from it:

- its own **key**, appointed adder and nothing else. It is never the keeper's
  key, never the owner, never a remover;
- its own **dynamic user** per run, which reads only its own env file;
- a **memory cap** (`MemoryMax=384M`) and low CPU and IO weights, so an
  unexpected growth fails the adder's run and never the keeper;
- **manual deploys of a named commit on main**. A merge does not deploy it:
  the adder signs compliance updates, so what it runs is a deliberate choice.

## 3. Install

### 3.1 Once per chain: the list and the key

1. Create the adder key (a fresh EOA, used for nothing else) and fund it with
   a little gas on the chain.
2. Deploy the list and appoint the roles, from a machine holding the admin and
   deployer keys:

   ```bash
   cd contracts
   SANCTIONS_ADDER_ADDRESS=0x… SANCTIONS_REMOVER_ADDRESS=0x<the Safe> \
     forge script script/DeploySanctionsList.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"            # dry run
   SANCTIONS_ADDER_ADDRESS=0x… SANCTIONS_REMOVER_ADDRESS=0x<the Safe> \
     forge script script/DeploySanctionsList.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow
   ```

   It refuses an adder equal to the remover or the owner, records the list as
   `sanctionsList` in the chain's artifact, and reuses a recorded list the
   admin still owns. Then export deployments
   (`bash contracts/script/exportFrontendDeployments.sh`) and commit.

### 3.2 On the machine

```bash
C=<full commit sha on main>
curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/ops/sanctions-adder/install.sh"
sudo bash install.sh "$C"
```

`install.sh` builds the release from exactly that commit (the contracts
package, with dependencies pinned by the lockfile and no install scripts run),
checks it with `sanctions-adder.mjs --check`, switches
`/opt/vaipakam-sanctions-adder/current` to it, and installs the units from the
same commit. It never starts anything.

### 3.3 Cut over a chain

```bash
sudo cp /etc/vaipakam/sanctions-adder/example.env.template /etc/vaipakam/sanctions-adder/base-sepolia.env
sudo chmod 600 /etc/vaipakam/sanctions-adder/base-sepolia.env
sudoedit /etc/vaipakam/sanctions-adder/base-sepolia.env     # RPC, chain id, list, adder key
sudo systemctl start vaipakam-sanctions-adder@base-sepolia.service
journalctl -u vaipakam-sanctions-adder@base-sepolia -n 50
sudo systemctl enable --now vaipakam-sanctions-adder@base-sepolia.timer
```

The instance name is the chain's slug; each chain has its own env file, state
directory and timer, so one chain's failure never stops another's run.

## 4. Operating it

- **Last run:** `/var/lib/vaipakam-sanctions-adder/<chain>/last-run.json`, and
  the journal. A run is `applied` only once its transactions are final and
  still in the blocks they were included in. A run that stops part-way is
  `stopped`, and lists each transaction it broadcast as final, included but
  not final, or broadcast with no receipt (it may still land); check those
  before acting. The file also records whether the ops alert was delivered,
  and a failed delivery fails the unit, so it shows in
  `systemctl --failed`.
- **Kept publications:** the same directory, `sdn-<date>-<hash>.xml`, newest
  14 by default.
- **Delistings awaiting the Safe:** the run's report names them and the file
  they came from. Confirm each against OFAC's Recent Actions notice, then run
  the diff tool on that exact file and send its remover calls from the Safe:

  ```bash
  cd /opt/vaipakam-sanctions-adder/current/packages/contracts
  sudo /usr/local/bin/node scripts/ofac-sanctions-diff.mjs \
    --xml /var/lib/vaipakam-sanctions-adder/base-sepolia/sdn-<date>-<hash>.xml \
    --rpc "$RPC" --chain-id 84532 --list 0x<list> --confirm-delist 0xA,0xB
  ```

  It prints the remover's calldata; it signs nothing.

- **A refused run** sends nothing and says why in the journal and the chat.
  The next run retries; a refusal that repeats needs a person.
- **Stop it:** `systemctl disable --now vaipakam-sanctions-adder@<chain>.timer`.
  To take the key's power away, the owner calls `setAdder(<key>, false)`.
- **Move to a new commit:** re-run `install.sh` with it. The previous release
  is kept; re-running `install.sh` with its commit is the rollback.

## 5. Residual risk, stated

A stolen adder key can list arbitrary addresses (blocking those wallets from
opening new positions; closing out stays open) or record a publication dated
in the future, which stalls later updates until the owner authorizes a
rollback. Both are recoverable by the owner and the Safe. The key cannot
delist and cannot appoint anyone. That bound is why the adder alone runs
unattended.
