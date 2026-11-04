# Fresh testnet deploy — lessons and hardening plan

Status: proposal, from the all-waves fresh deploy of 3–4 November 2026
(Base Sepolia and Arbitrum Sepolia, then BNB testnet). Nothing here is built
yet. Each lesson names what happened, what it cost, and the script change
that removes it. The last section proposes one root change that covers most
of them.

## What went wrong, and the change for each

**1. A diamond cut went out with too little gas.** On Arbitrum Sepolia,
transaction 115 of 171 in DeployDiamond (a diamond cut adding about seventy
selectors) was sent with a 46,338 gas limit: the simulation's estimate with the
130% pad applied. The real cost was about 1.9 million, so it ran out of gas and
left a half-built Diamond. Other cuts in the same run were sent with correct
limits, so the cause is not proven: the estimate taken for that one
transaction was wrong. Recovery meant a second full contracts phase (about 30
minutes, mostly the pre-deploy gate) and an archive entry for an empty
Diamond. *Change:* give every diamond cut in DeployDiamond an explicit gas
limit derived from its selector count, so it never depends on an estimate. In
addition, after each broadcast the phase reads the run's receipts and stops at
the first failed one, naming the transaction, before any later step builds on
it.

**2. An interrupted run needs hand recovery.** When the session restarted
mid-deploy, BNB testnet was left with its old artifact archived, a new
unpublished Diamond on-chain, and a live-publication marker that blocks every
later census. Recovering took five manual steps: end the marker with the run's
token, restore the artifact, remove the archive entry, set the archive
directory aside, and check the chain. *Change:* a `recover` phase that does
exactly this when the new Diamond was never published, and refuses (with the
facts) when it was.

**3. A fresh deploy silently drops records that do not belong to the
Diamond.** The rehearsal sanctions list, its delisting timelock, the clearance
attestor and the oracle stand-in are standalone contracts that outlive a
Diamond. Archiving the artifact removed their entries, and the sanctions
services read them from the deployments bundle. *Change:* the contracts phase
carries a declared list of Diamond-independent keys into the new artifact, and
verify fails if any key from the archived artifact disappeared without being
on a declared "retire" list.

**4. Topology was typed by hand on every run.** Base's expected-source list
(which must include Base itself), each mirror's link to Base, Base's map of
mirrors, and each chain's lane list were all passed as environment values per
run. One was wrong on the first try (Base left out of its own list) and was
refused only in simulation. Narrowing Base's lanes while BNB was deferred meant
editing the operator `.env` file, because `.env` outranks the shell
environment. *Change:* derive all four from one committed topology file (see
below).

**5. A mirror's reward custody activation needs a token address the artifact
already has.** The activation script reads the VPFI token as `.vpfiToken`. A
mirror records it as `.vpfiMirror`, so the run stopped until the address was
passed by hand. *Change:* the shared deployments reader falls back to
`.vpfiMirror` on a mirror chain.

**6. Restoring the testnet's operating settings was manual.** Service
capacity, its escrow, the arming fee, the capacity curves, auto-extend, lender
intents, the routing perk, fee entitlement, the reward grace, the remittance
keeper and the keeper role were read off the archived Diamonds and written one
transaction at a time. The rewards launch anchor was set by hand. *Change:* a
committed testnet settings profile and a `settings` phase that applies it,
then verifies it by reading every setting back.

**7. Ordering lived in the operator's head.** Reward custody activation needs
the manual pause, so it has to run after configure and before launch. The mock
swap rig has to come before configure. *Change:* encode the order in the
phases: a `custody` phase that refuses after launch, and the existing
testnet-mocks phase.

**8. BNB testnet had three traps of its own.** Its node refuses a priority
tip under 0.1 gwei, and the script's gas pin set only the gas price, so the
first CCIP wiring run sent nothing (forge offered a 1 wei tip). The mock-rig
script reads `BNB_TESTNET_WETH` while the operator file names it
`BNB_TESTNET_WETH_ADDRESS`. Its swap-adapter phase has no mock rig in front of
configure, so the first configure left the chain without a priced quote asset
besides WETH, which launch refuses. Configure had to run a second time after
the rig. *Change:* the gas pin sets the tip as well. One name is used for
WETH everywhere. The phase order gives every testnet the rig before
configure, whichever real adapter it also carries.

**9. Records written before the settings they describe.** The Base artifact
from the first commit records the reward grace as 14,400 seconds, because
configure wrote it before the old 43,200 was restored on-chain. *Change:* the
`settings` phase below writes the artifact last, from what it reads back.

**10. Smaller ones.** The ABI sync's alert export and the typechecks need the
workspace dependencies installed, which a fresh worktree lacks, so preflight
should check for them. The pre-deploy gate ran in full once per chain (about
30 minutes each) on an unchanged tree, so the gate's verdict should be recorded
against the tree's hash and reused by the other chains in the same deploy.

## The better approach: one committed topology and settings file

Most of the above comes from one gap: the shape of the testnet mesh and its
operating posture exist only in operator memory, the `.env` file and command
lines. The proposal is a single committed file (for example
`contracts/deployments/testnet-topology.json`). It names the chains, each
chain's reward role, the lanes, the records to carry across a fresh deploy,
the bot-role holders, and the settings profile. The reward launch anchor is
always stated explicitly per relaunch, never defaulted.

- Lanes, expected sources and the reward cross-links are derived from it, so
  deferring a chain is a reviewed edit to one file instead of a `.env` change.
- `--fresh` carries forward the records it lists, and verify checks them.
- The `settings` phase applies the profile and proves it by reading it back.
- A deploy of the whole mesh becomes one ordered command, with each phase
  still idempotent and individually re-runnable, and each stopping at the
  first failed receipt.

Mainnet differs only in the profile values and in the handover, which the file
would mark as required there and absent on testnets.
