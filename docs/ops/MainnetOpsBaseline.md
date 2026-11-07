# Mainnet operations baseline (#3243)

The contracts get an audit before mainnet. The machines and credentials that
operate them need the same care. The testnet setup is right for testnets: one
small VM that a development session can reach, and deploy credentials on the
owner's desktop next to automated sessions. This document is the bar a
mainnet deployment must clear instead, and the record that shows it was
cleared. The mainnet readiness checklist
([`DeploymentRunbook.md`](DeploymentRunbook.md) §6) links here, and readiness
is not declared until every item below is checked.

Nothing here changes a testnet. Testnet credentials and machines stay as they
are. A mainnet credential is never put on a testnet machine, and a testnet
machine is never promoted to mainnet; the mainnet host is set up new.

## 1. The keeper host

What the keeper already brings, and needs no extra step: the unit runs as a
throwaway system user with the signing key handed over through `LoadCredential`.
The env file stays `0600 root:root` in a `0750` directory. The process gets an
empty environment and a read-only system with no home directories, devices or
extra namespaces. The updater installs only a bundle whose build provenance it
has verified, and load-checks it with no network before switching
([`KeeperMachine.md`](KeeperMachine.md) §1, §3).

What the mainnet host adds:

- [ ] **A dedicated machine.** The keeper is the only workload. No
      development tools, no checkout of the repository, no build toolchain
      (the updater never builds). Its size is set with headroom for the
      mainnet chain count, not the testnet VM's 1 GB.
- [ ] **No automated session on the host.** No Claude Code remote session,
      CI runner or other agent runs on the mainnet keeper host, as any user.
      The testnet VM's remote session is a testnet convenience. On mainnet,
      changes reach the host only through the signed release the updater
      verifies, and an operator's own login.
- [ ] **Updates.** Unattended security updates are on (Ubuntu:
      `unattended-upgrades` with the security pocket). A reboot needed by an
      update is taken in a planned window, because the keeper's stop waits
      for its in-flight tick (§6 of the keeper runbook).
- [ ] **Firewall.** Inbound is denied by default at the host (`ufw default
      deny incoming`) and at the provider's network layer. The keeper needs no
      inbound port. SSH is opened only if it is the login route, and only from
      the operator's addresses.
- [ ] **Login policy.** Either no SSH (provider console only), or SSH with
      keys only: `PasswordAuthentication no`, `PermitRootLogin no`,
      `KbdInteractiveAuthentication no`, and one named account per operator,
      each with its own key. `sudo` needs that operator's password. No shared
      account and no agent forwarding.
- [ ] **Key files.** The env file and every key file are `0600 root:root`,
      read only by the services that load them. A backup of the keeper key, if
      kept, is held offline by the owner, never on another machine a session
      can read.
- [ ] **A separate key per role.** The keeper's signing key is used by the
      keeper and nothing else: it is never a deployer, admin, multisig owner,
      treasury or sanctions key. The sanctions adder and delister
      (`ops/sanctions/`) each have their own key and units. The keeper key
      holds only the gas it needs, topped up on a schedule, so a leak loses at
      most that.
- [ ] **Host monitoring.** An alert reaches the operator chat (the ops bot,
      not the user bot) when the keeper stops ticking, when the host's memory,
      disk or swap passes a threshold, when the updater fails to verify a
      release, and when the keeper's gas balance runs low. The keeper's own
      signing-key alert (#3119) does not replace these: it needs a running
      keeper to send it.
- [ ] **Private submission decided.** For each mainnet chain, the owner has
      recorded whether the keeper sends through a private submission route
      (`PRIVATE_TX_RPCS`, #3240) and whether it may fall back to the public
      RPC. Chains with a public mempool (Ethereum, and BNB Chain if it is ever
      served) are the candidates. Base, Arbitrum and OP Mainnet use a
      sequencer with no public mempool. The decision and its date go in the
      table below.

| Chain | Private route | Fallback to public | Decided by, on |
| --- | --- | --- | --- |
| Ethereum | not decided | not decided | |
| Base | not decided | not decided | |
| Arbitrum | not decided | not decided | |
| OP Mainnet | not decided | not decided | |
| Polygon | not decided | not decided | |

## 2. Production credentials

- [ ] **Scoped per service.** Each production credential does one job for one
      service: a Cloudflare token per Worker and per action (deploy one
      Worker, edit one Secrets Store, read analytics), never one account-wide
      edit token shared between them. The keeper's database token is its own.
      An RPC provider key is per service too (keeper, indexer, agent, the
      read-only RPC proxy), so one leak is rotated without touching the
      others.
- [ ] **Off machines automated sessions can read.** No production credential
      sits in a file, environment, keyring or shell history that an automated
      session (Claude Code, CI, an agent) can read. Testnet deploy keys and the
      testnet Cloudflare tokens may stay where they are. Mainnet deploy and
      admin actions are signed by the multisig, never by a key on a desktop
      ([`MainnetMultisigSetup.md`](MainnetMultisigSetup.md)).
- [ ] **CI holds no production secret** beyond what its workflow needs, set
      as an environment secret behind a protected environment where GitHub
      allows it.
- [ ] **Every production credential is in the rotation record** below,
      under a class name and a holder, never its value or a location an
      attacker could use.

## 3. Rotation record

One row per credential. A row records who holds the credential, where in
general terms it is kept (a password manager, a Secrets Store, a host env
file), when it was last rotated, and how to rotate it. It never records a
value. Rotate on schedule, and at once after any suspected exposure: a value
pasted into a chat or ticket, a machine lost or reimaged, a session or person
who had access leaving, or a provider's breach notice. After a rotation,
confirm the old value no longer works.

| Credential | Used by | Held in | Rotate every | Last rotated | How |
| --- | --- | --- | --- | --- | --- |
| Keeper signing key | keeper host | host env file | on exposure; new key per fresh host | not yet recorded | a REVOCATION, not a gas sweep: on every chain revoke `KEEPER_ROLE` from the old key and grant it to the new one, on Base also `setRewardRemittanceKeeper` to the new key (a separate authority), swap the env file and restart, read both back per chain, then sweep the old key's gas; full procedure in [`AdminKeysAndPause.md`](AdminKeysAndPause.md) "Off-chain operator keys" and [`OffChainRestore.md`](OffChainRestore.md) §1 step 6 |
| User bot token (`TG_BOT_TOKEN`) | keeper, agent | Secrets Store, host env file | 12 months | not yet recorded | BotFather `/revoke`, set the new token in both places |
| Ops bot token (`TG_OPS_BOT_TOKEN`) | keeper, mesh watcher, backups | Secrets Store, host env file | 12 months | not yet recorded | BotFather `/revoke`, set it everywhere it is listed in CLAUDE.md "Two Telegram bots" |
| Push channel key (`PUSH_CHANNEL_PK`) | keeper, agent | Secrets Store, host env file | on exposure | not yet recorded | a signer swap only when `PUSH_CHANNEL_ADDRESS` is set on both senders and the exposed key is a DELEGATE of that channel, with the owner key held separately and not exposed; then add the new delegate and remove the old. An exposed owner key, or an unset `PUSH_CHANNEL_ADDRESS`, means a new staked channel and moving subscribers: [`IncidentRunbook.md`](IncidentRunbook.md) §4 |
| Sanctions adder key | sanctions adder | its host env file | on exposure | not yet recorded | grant the new key the adder role, revoke the old |
| Sanctions delister key | sanctions delister | its host env file | on exposure | not yet recorded | as the adder |
| RPC provider keys (`RPC_*`, `RPC_PROXY_*`) | each service | Secrets Store, host env file | 12 months | not yet recorded | provider console, per service |
| Private submission endpoint (`PRIVATE_TX_RPCS`) | keeper | host env file | with its provider key | not yet recorded | provider console |
| Aggregator keys (`ZEROEX_API_KEY`, `ONEINCH_API_KEY`) | keeper, agent | Secrets Store, host env file | 12 months | not yet recorded | provider console |
| Cloudflare tokens (deploy, Secrets Store, D1) | per service | password manager, host env file | 12 months | not yet recorded | Cloudflare dashboard, one token per job |
| Backup storage keys and archive key | backup Worker | Secrets Store; archive key offline | 12 months | not yet recorded | see [`OffChainRestore.md`](OffChainRestore.md) |

## 4. Recording the result

When every box above is checked and the rotation record has a date in each
row, tick the matching line in the mainnet readiness checklist. Name the
person and date there. This file stays the record: a later change to a host
or a credential updates its row or box here in the same change.
