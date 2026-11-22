# Deploy rehearsal on local forks

Status: functional and technical design. Nothing is built. Approved in outline by the owner on 2026-11-22.
Scope: deploy tooling only (`contracts/script/`, `packages/anvil-harness`, the local runners of the indexer, the keeper and the apps). No file under `contracts/src/` changes, so no deployed bytecode changes.

A fresh deploy has never run anywhere before its live broadcast. This design makes one command run the whole deploy on local forks of the target chains, run the off-chain stack and a short set of real flows against the result, read the end state back against a committed statement of what it should be, and write a verdict. The real deploy goes ahead only on a green verdict for the same inputs. The same readback then runs against the live chains after the real deploy.

## 1. What the scout found

1. **About a third of a fresh deploy is in no script.** `deploy-testnet.sh` (2,664 lines) and `deploy-mainnet.sh` (2,294 lines) mirror each other phase for phase, and the operator runs each phase by hand. `docs/ops/TestnetFreshDeployGuide.md` then lists the steps the scripts do not do (its sections 3.7, 3.8 and 5.1 to 5.6): reward custody activation, carrying the standalone sanctions records, the bot roles and the keeper address record, the Terms version, funding the reward pool, the rewards anchor, arming the first capped day, waiting for that day, the mirrors' launch after Base's broadcast lands, restoring the operating settings, and reconciling the artifact by hand. Several are marked unverified in the guide. Both misses of the 2026-11-16 deploy (a switch left off, records not committed) were in this hand part. A rehearsal that ran only the script's phases would not have caught them.
2. **The statement of what a deployed chain should look like is already carded.** #3111 proposes one committed desired-state file per environment, a plan step, phases that apply it and a census that reads it back. `FreshDeployHardeningPlan.md` records which lessons of the 2026-11-03 deploy are built. #3109 is the Arbitrum gas fault. The daily launch check (#3824) compares each chain with the launch list. This design adds no second file: its expected-state manifest is #3111's file and its readback is #3111's census, widened.
3. **Every operator script signs with a key read from the environment.** `DEPLOYER_PRIVATE_KEY` and `ADMIN_PRIVATE_KEY` are named more than fifty times across the script files, each read followed by `vm.startBroadcast(key)`, and the shell sends a few transactions with `cast send --private-key`. One script already broadcasts as an address with no key (`RepriceTestnetMock`, driven by `rehearse-reprice-anvil.sh` on a fork of Base Sepolia with the owner impersonated). That is the precedent this design generalizes.
4. **Records can be redirected, but only by a wrapper.** `ArtifactRootBase.setArtifactRootOverride` sends a script's records to `deployments/.forge-test/…`. It is allowed on chain 31337, under `forge test`, or on a node carrying the harness's local-node marker. It is set per script instance and never from the environment, because `vm.setEnv` is shared by every parallel test. A plain `forge script script/DeployDiamond.s.sol`, which is what the operator script runs, has no way to set it.
5. **The shell and forge write outside that root.** The shell writes `.markers`, `.history`, `.archive`, the carried records and `archive-manifest.json` under `contracts/deployments/`, the exported ABIs and bundle under `packages/contracts/src/`, and the sibling keeper bot checkout. Forge writes `broadcast/<script>/<chainId>/run-latest.json` and a copy under its cache. A fork keeps the real chain id, so a rehearsal's journal would land exactly where the real one does, and `forge script --resume` sends whatever plan `run-latest.json` holds. A rehearsal journal left in place could therefore be sent to the real chain later. Every output has to move.
6. **The pieces of a local cross-chain lane exist.** `packages/anvil-harness/src/ccipLane.ts` relays messages between two local nodes through the real router, with the stand-in ramps of `script/e2e/E2ELocalCcip.sol`. On a fork the real router and ramps are already there, and nothing delivers between forks.
7. **The off-chain stack already runs against local chains, in three different ways.** The keeper's scenarios run the real indexer pass (`runChainIndexerForChain`) into a local database built from the real migrations and run the keeper's own tick, with the deployments bundle redirected at one import. alpha05's scenarios use a stand-in for the indexer and the read proxy. `deploy-shared-d1.mjs` takes no arguments on purpose, so its apply path cannot be pointed at a local database today.
8. **The staged flows change settings.** The positive-flow modules point the Diamond's price and sanctions sources at mocks they deploy (`RehearsalChain`). They must run after the readback, never before.
9. **A fresh deploy needs time to pass.** The first capped reward day must be later than today, launch on Base waits for that day, and each mirror launches only after a broadcast from Base has landed. On a fork these are clock steps and relayed messages.
10. **CI covers two scripts.** The "Deploy smoke" step runs `DeployDiamond` and `Launch` on a bare local node. The scenario suites build their chains with their own wrappers (`script/e2e/`), not with the operator script.

## 2. Rules

1. **One code path.** The rehearsal runs the same commands the operator runs. There is no second script and no wrapper that inherits the real ones.
2. **Every difference is declared and sits at one seam.** There are six (section 5). The run prints them at the start and in the report. A seventh needs a change to this design.
3. **No real key.** A rehearsal never reads a deployer, admin, treasury or bot key.
4. **Nothing outside the run's scratch folder changes.** This is checked as a whole at the end, not by listing outputs.
5. **A step done by hand is not rehearsed.** So every step of a deploy is a command in the plan. A run with a step it could not execute is not green.
6. **One readback, used three times:** on the forks, on the live chains after the real deploy, and (for the rows they share) by the daily launch check.
7. **The verdict says what it did not cover.** Limits are printed in every report (section 10).

# Part I. Functional design

## 3. The plan: every step is a command

The plan is the ordered list of steps for one deploy: the chain, the command, who signs, and what the step waits for (nothing, a time, or a cross-chain message landing). It is printed by the plan step of #3111 from the desired-state file and the script's own phase table. It is not typed by hand.

- The rehearsal executes exactly the plan. The real deploy is the operator running the same commands in the same order, and each phase's marker records it, as today.
- The steps the guide lists as manual become phases, each refusing to run out of order: reward custody activation and its record; the carried records; the bot roles, the keeper address record and the remittance keeper; the Terms version; funding the reward pool; the rewards anchor (Base first, then the mirrors, one value); arming the first capped day on Base; the settings profile, applied and then proven by reading it back, with the artifact written last from what was read. The hardening plan already names the custody, settings and records phases. This design adds the roles, Terms and the three reward steps.
- Until a step has its phase, the plan carries it as a manual step with its exact command text, and the rehearsal runs that text on the fork. A manual step with no command text is reported as not covered, and the verdict is not green.
- The plan has a digest, which covers the desired-state file it was derived from. The verdict records it and the gate compares it, so a plan or a file that changed after the rehearsal is a different deploy.

## 4. What one rehearsal run does

1. **Prepare.** Record the commit, a digest of the working tree, a digest of the non-secret inputs, and the plan's digest. Start one fork per target chain at a recorded block, with the real chain id. Copy the committed deployment records into the scratch folder, so `--fresh` archives a copy and every script reads its neighbours' records from there.
2. **Deploy.** Run the plan, step by step, stopping at the first failed step. Each broadcast is followed by the receipt check the script already has.
3. **Read back.** Compare the end state with the desired-state file (section 6). This runs on the state the deploy left, before anything else touches it.
4. **Off-chain stack and smoke flows** (section 7). This stage is allowed to change the forks, and it lists what it changed.
5. **Report and verdict** (section 8). Confirm nothing outside the scratch folder changed. Stop the forks.

The forks start from the real chains' state: the previous Diamond with its open offers and loans, the standing sanctions records, the token, the real routers and the real balances. The role addresses are not topped up, so a deploy that would run out of gas money on the real chain fails in the rehearsal as well.

## 5. The six declared differences

| # | What differs | In the real deploy | In the rehearsal |
| --- | --- | --- | --- |
| 1 | The network | The chain's RPC | A local fork of it, same chain id, at a recorded block |
| 2 | The signer | The role's key | The role's address, impersonated on the fork. No key is read |
| 3 | Where files go | The committed folders | One scratch folder for the run |
| 4 | Waiting | Real time | A clock step, applied to every fork together |
| 5 | Cross-chain delivery | The messaging network | A local relay that delivers only what the source chain sent |
| 6 | Publishing off-chain | Workers published, the shared database migrated | Dry runs, and a local database built from zero |

Each is switched in one place (sections 11 to 16). A run against a real RPC cannot enter rehearsal mode, and a run against a fork cannot leave it.

## 6. The readback

The desired-state file states what a fresh deploy on each chain must end with. The readback compares it with the chain and with the run's records, row by row. Each row is one of: met, not met, or cannot be read. Any row that is not met or cannot be read fails the readback.

What it compares:

- **Settings and switches:** the pause state after launch, the Terms version, hash and minimum age, each switch the file names (the access gate, the depth-tiered limits, the instant market, the master flags), the fee settings, the reward grace and the operating profile.
- **Roles:** the admin, the pauser, and each bot role on its named wallet. On a chain past the handover, the handover gate's own check.
- **Rewards:** custody activated, the pool funded with the stated amount, the anchor equal on every chain, the first capped day, Base's expected sources.
- **Cross-chain wiring:** each lane in both directions, the peers of each channel, the pool's rate limits and their admin, the token's registration.
- **Sources:** the sanctions source and the delisting route's clearance source, the price guard and the feed bindings, the swap routes.
- **Code:** the routed selector set equals the set this commit's deploy script builds, with none missing and none extra.
- **Records:** every address the run created is in the chain's records or on a short list of addresses that are deliberately not recorded, each with its reason. The storage-layout record and its anchor are written. The archive manifest names the retired Diamond. No carried record was dropped. The set of chains that received transactions equals the plan's chain set, which is the check that catches a deploy sent to a chain nobody meant.

It reuses the comparisons that exist: the launch report and its requirement checks, the handover gate, the storage-layout record check and the launch list check of #3824. It adds only the rows none of them covers.

One row is information and never a failure: the addresses the rehearsal produced. With the same deployer address and the same starting nonce, the real deploy creates the same addresses, so a difference after the real deploy shows that the two runs did not send the same transactions.

After the real deploy the same readback runs against the live chains with the real records. It replaces the hand check. A setting changed on purpose later is changed in the file in a reviewed commit.

## 7. The off-chain stack and the smoke flows

All of this runs after the readback and reads the scratch records through a bundle built from them.

- **The indexer:** a local database built from zero by the indexer's own deploy path (every shared migration applied and verified, the retired Diamonds seeded from the archive manifest), then the real per-chain pass from the deploy block. It must adopt the new Diamond on each chain and report it on its health route.
- **The keeper:** one tick of every pass on the arming list for each chain. A pass that throws fails the stage. A pass that needs an outside service the rehearsal does not reach is reported by name as not rehearsed.
- **alpha05:** a short subset of its scenarios against the forks and the local indexer: connect, read the book, post an offer, accept it, see the loan, repay, claim.
- **The Workers' publish steps** run as dry runs. Nothing is published.
- **Flows on chain:** the staged positive-flow modules, with their waits as clock steps.
- **Across chains:** one reward day closed, finalized and broadcast from Base and received on each mirror, and the platform token sent out to a mirror and back.

What this stage changes on the forks is listed in the report: test actors funded, the bot roles granted to bot keys made for the run, the flows' mock sources, and the clock.

## 8. The verdict and the gate

The report is a plain file and a machine-readable verdict: the commit, the tree digest, the input digest, the plan digest, the chain set, the fork block and time per chain, every step with its result, every transaction with its sender and gas used, the readback rows, the off-chain and smoke results, the six differences, and the limits.

The first broadcasting step of a deploy (the contracts phase with `--fresh`, and its mainnet equivalent) refuses unless a green verdict exists whose commit, tree digest, input digest, plan digest and chain set equal the present ones, and whose forks are less than 24 hours old. It is checked once per chain, at that chain's first broadcasting step, so the later steps of a launch that spans two days are not turned away by the age. An override exists for emergencies. It needs a stated reason, and the reason is written into the deploy's record.

The verdict is a local file. It guards against mistakes, not against someone who means to skip it. That is stated in the gate's own message.

## 9. The CI companion

The same mode runs in CI on bare local nodes: no fork, no secret, development keys, the harness's local lane, the mock rig. It runs on a pull request that touches the deploy scripts, the desired-state file or the harness, and on request. It keeps the script path from rotting between deploys. The "Deploy smoke" step stays as it is, because it runs on every contract change and this job does not. It is its own job with the shared forge cache. It is never a verdict for the gate.

## 10. Limits, printed in every report

- A local fork does not charge gas the way Arbitrum does. The rehearsal records gas used per transaction so a later mismatch is visible. The fault of 2026-11-03 is fixed in the scripts under #3109.
- On a fork of Arbitrum, `block.number` is the L2 number, where the real chain reports an L1-based number.
- A fork is a snapshot. State that changes between the fork block and the real deploy is not covered, which is why the verdict ages out.
- The relay stands in for the messaging network's own verification and execution. Its failures and delays are not rehearsed.
- After a clock step the real price feeds on a fork are stale. The rehearsal re-stamps their last answers with the fork's time and never changes an answer. It lists each feed it re-stamped.
- Sequencer behaviour, finality and node quirks are not covered.

# Part II. Technical design

## 11. Entering rehearsal mode

`--rehearse` on `deploy-testnet.sh` and `deploy-mainnet.sh`, and one driver, `contracts/script/rehearse.sh`, that prepares the forks, runs the plan with `--rehearse` on every step, and runs the later stages. The driver is the only new entry point. It contains no deploy logic.

Two tests decide the mode, and both must agree:

- **The flag**, which exports `VAIPAKAM_REHEARSAL=1` and the scratch folder.
- **The node.** It must answer on a loopback address (the harness's `assertLoopbackUrl`) and carry the local-node marker that `ArtifactRootBase` already reads: code at a keyless address that only a development node can place.

The flag with a node that fails either test is refused. Without the flag, the deploy scripts refuse a node that carries the marker, and a record write on such a node is refused unless a scenario wrapper redirected it (section 13). So there is no way to rehearse against a real chain and no way to run a real deploy against a fork.

## 12. The signer seam

One library, `script/lib/Signers.sol`, is the only place a script starts a broadcast.

- `Signers.start(role)` for the roles the scripts sign as, today `DEPLOYER` and `ADMIN`. In a real run it reads `<ROLE>_PRIVATE_KEY`, requires that the key's address equals `<ROLE>_ADDRESS`, and broadcasts with the key. In a rehearsal it reads only `<ROLE>_ADDRESS` and broadcasts as that address, which the fork has impersonated, with forge's unlocked sending.
- The address check in the real run is what ties the two together: the address the rehearsal impersonated is the address the real key gives, or the real run stops before its first transaction. `DEPLOYER_ADDRESS` joins `ADMIN_ADDRESS` and `TREASURY_ADDRESS` in the operator's environment file. It is a public value. A plan step that another wallet signs (the treasury wallet moving the reward funding to the admin, for one) names that wallet's address the same way.
- The shell gets the same seam as one function, used for every `cast send`.
- A guard in the pre-deploy check refuses any operator script that reads a key variable or starts a broadcast outside the library. It reads the compiler's AST, as the other guards do. The scenario fixtures and the flow modules keep their own test keys and are outside the guard by folder.
- In a rehearsal the driver pins every variable named `*_PRIVATE_KEY` to zero in the environment of each command. A value already in the environment wins over the `.env` file forge loads by itself, so no key reaches forge, and a script that still asked for one would fail on the zero. The loader also refuses to load those names in this mode.
- Only the role addresses are impersonated, one by one. A transaction from any other sender fails. A probe on the pinned forge showed that one script run with unlocked sending broadcasts as both roles, that the journal records each sender, and that the node refuses a sender it was not told to impersonate. So no script is split by role.

The test actors of the flows and the bot keys of the smoke stage are keys made for the run and funded on the fork. Their identity does not matter. This answers the second open question of the outline: impersonation for the roles, keys made for the run for everyone else.

## 13. The output root

One scratch folder per run, `contracts/deployments/.forge-test/rehearsal/<run>/`, holding the copied deployment records, the broadcast journals, forge's run cache, the built bundle and ABIs, the local databases, the logs, the report and the verdict. The folder is already ignored by git and already inside the one path a script may write.

- **Solidity.** `Deployments.artifactRoot()`, the bottom of the path API, gains one rule: outside a test, on a node carrying the marker, the root is the scratch root from the environment, which must pass the two existing total tests (it starts with the scratch prefix and contains no parent segment). On such a node with no scratch root, every write is refused. The environment is read only outside the test context, so the reason it was avoided (parallel tests sharing one process) does not arise. A wrapper's own override still wins, so the scenario suites are unchanged.
- **Shell.** One variable replaces each hard-coded `contracts/deployments` and `packages/contracts/src` path in the two deploy scripts, the export scripts and the manifest writer. The sibling keeper bot export is skipped in a rehearsal and reported.
- **Forge.** Forge keeps a script's run file under its cache folder, beside the compile cache, with no separate setting. So for each command the broadcast folder and the cache folder are both set to the scratch folder, and the driver seeds the scratch cache with a copy of the real compile cache's index. The real cache is never written, and nothing recompiles, because the driver's build before the first step uses the same profile and flags as the steps. A step that does recompile writes compiled output outside the scratch folder, and the check below fails the run for it. That is the intended result, since it means the tree changed during the run. The receipt check reads the same broadcast variable.
- **The check.** The driver builds everything first. Then, before the first step, it records every file in the working tree by path and content hash: tracked, untracked and ignored alike. That includes the ignored deployment state a real deploy keeps beside the records (the phase markers, the history, the archives and the carry-forward file under `contracts/deployments/<chain>/`) and forge's `broadcast/` and run cache folders. After the last step it compares. Any difference outside the scratch folder fails the run and is listed. This is one comparison over everything, so a write nobody thought of is still caught. If a tool is found to rewrite a compile output during a run, that path is left out by name in a committed list with its reason. A test refuses a list entry at or under `contracts/deployments`, a broadcast folder or a run cache, so the list can never hide deploy state.

## 14. The forks, the clock and the prices

- **Launcher.** A function in `packages/anvil-harness` starts one node per chain from the chain's RPC at a block a safe depth behind the head, on loopback, with the real chain id, places the marker and impersonates the role addresses. The node prints its fork URL, which carries a provider key, so the launcher captures its output and never echoes it. Every log and the report pass through one redactor that replaces each RPC value from the environment with its variable name.
- **Clock.** One helper moves every fork to the same time. A plan step that waits for a time becomes a call to it. The forks never drift apart, because reward days on Base and the mirrors are compared across chains.
- **Prices.** After a clock step, each aggregator the deployment reads is re-stamped: its last answer, unchanged, at the fork's time. A mock feed is re-stamped through its setter and a real aggregator by a storage write. Five rules hold it:
  - The list of feeds is read from the fork: every source the price guard holds for a bound asset (the primary feed, the second source, and the registry's rate and market feeds). It is never kept by hand.
  - A storage write counts only when it is proven. The driver reads the feed through the guard's own call before and after: the answer, the decimals and the round are equal and only the times moved. A feed whose write cannot be proven has the repository's mock feed code placed at its address with the same answer and decimals, and is listed as replaced. A feed with neither fails the run by name at the clock step, so it never shows up later as a stale-price refusal in a smoke flow.
  - The sequencer status feed is not re-stamped. Its answer says the sequencer is up, and its start time only has to be old. Moving that time to the fork's time would put the fork inside the recovery window, and every price read would be refused.
  - A source priced by a signed update with its own publish time cannot be re-stamped as a round. It gets its own named mechanism, or the run is not green while a bound asset needs it.
  - The report lists each feed with its address, the mechanism, and the answer and time before and after, under the "waiting" difference. The re-stamp exists only in the rehearsal driver and uses calls a real node refuses.
- **Arbitrum.** The scripts already take the deploy block from the node. The fork's `block.number` difference is a stated limit.

## 15. The relay between forks

Option (a) of the outline, made exact.

- **Source side: untouched.** The real router, on-ramp and fee logic run. The real fee is charged to the sender.
- **Destination side: one stand-in.** The code at the real off-ramp's address is replaced on the fork by the harness's off-ramp. The router's and the pools' checks of who may deliver then pass unchanged, and the real pool releases or mints, with its real rate limits.
- **The relay** reads the source on-ramp's message events and hands each message, as emitted, to the stand-in on the destination fork. It never composes a message. It calls the receiver with the message's own gas limit, so a receiver that would run out of gas on the real lane fails here too.
- A delivery whose receiver call fails is a failed step. Each message's id, fee, gas limit and gas used go in the report.
- A plan step that waits for a message names it, and the relay delivers before the step continues.
- The builder confirms the ramp versions on each lane from the routers on the forks and extends the stand-in to the message format found.

## 16. The off-chain runners

- **The bundle.** `exportFrontendDeployments.sh` and the ABI export write into the scratch folder (section 13). The existing redirects take that file: the one the keeper's scenarios use, which also covers the indexer pass they run, and the build-time one of the app and alpha05.
- **The indexer's deploy path.** `deploy-shared-d1.mjs` gets a second, separately named entry for a local database: it applies and verifies every migration and seeds the retired Diamonds exactly as `apply` does, and publishes nothing. It is its own script name, in keeping with that file's rule of taking no arguments.
- **The indexer and the keeper** run as the keeper's scenario harness runs them today: the real per-chain indexer pass and the real tick, with outbound requests narrowed to the forks. The arming list (which keeper passes are armed on which chain) is added to the desired-state file, which today names the role holders only. This answers the third open question: every pass that will be armed, each for one tick, with passes that need an outside service named as not rehearsed.
- **alpha05** gets a mode for its scenarios that takes the fork URLs and the bundle and starts no chain of its own, with the local indexer in place of its stand-in for the subset.
- **The flows.** `RehearsalChain` accepts a node carrying the marker, so no chain id needs to be allowed by hand.

## 17. The readback's shape

A read-only forge script per chain plus one node script for the records, both writing rows in one format: the row's id, the chain, what the file expects, what was found, the result, and which comparison produced it. The row meanings live in one library, shared with the launch check's rows where they overlap, so a row cannot mean two things.

The records comparison reads the run's broadcast journals: every created address, including the ones a transaction created internally, must be in the chain's records or on the not-recorded list. After the real deploy it reads the real journals.

## 18. The verdict and the gate, exactly

- **Tree digest:** the commit plus a hash of every tracked file as it is on disk, excluding `contracts/deployments`, the one directory boundary the deploy scripts already use for this. The pre-deploy gate records its own verdict against the same digest, so it runs once per tree and not once per chain (hardening lesson 10).
- **Input digest:** a hash over a canonical input set, worked out the same way in a rehearsal and in the real deploy. The set is the names and values of the variables the deploy reads, less three kinds left out by name: the key variables, the RPC values, and the variables the declared differences of section 5 set (the rehearsal flag, the scratch root and the path variable, and forge's broadcast and cache settings). Those last ones differ between a rehearsal and its real deploy by design, so hashing them would make every digest unequal. Addresses, lane lists, gas pins and settings stay in, so a change to any of them is a different deploy. A variable a deploy script reads that is in neither the input set nor the left-out list fails the run, so a new input cannot sit outside the digest unnoticed.
- **The regression is not run again.** The rehearsal reuses the pre-deploy gate's recorded verdict for the tree and refuses without one.
- **The gate** is one function in each deploy script, called at the top of the first broadcasting phase of a fresh deploy. It prints which of the five values differ, or the forks' age.
- **The override** is `--without-rehearsal "<reason>"`. The reason goes into the phase marker and the chain's history record.

## 19. In-place refreshes

The fourth open question. The end state is that every in-place change to a live chain is rehearsed on a fork of that chain first: the refresh script runs against the fork, then the readback's code rows, the storage-layout record check and a set of close-out probes on open loans (each simulated, none sent). On mainnet after the one fresh deploy this is the rehearsal that matters most, because the chain then holds users' positions.

The gate binds refreshes on the testnets as well as on mainnet, with the same override. The testnets are where the mainnet procedure is practised, and the platform is pre-live, so there is no interim rule. It is its own card, built after the fresh-deploy rehearsal.

## 20. Tests

1. Rehearsal mode is refused against a non-loopback URL, and against a loopback node with no marker.
2. A real-mode run is refused against a node carrying the marker.
3. On a marker node with no scratch root, a record write reverts.
4. The signer library: a key whose address differs from the role's address stops a real run. In a rehearsal no key variable is read.
5. The signer guard fails on a script that reads a key or starts a broadcast outside the library.
6. The tree check fails when a step writes outside the scratch folder, including under `broadcast/` and into a chain's ignored markers, history, archive or carry-forward file. The list of compile outputs left out refuses an entry under the deployment records.
7. The redactor: a log line holding an RPC value comes out with the variable's name.
8. The relay delivers only emitted messages, applies the message's gas limit, and fails the step on a failed receiver.
9. The readback fails on each kind of row: a switch off, a role missing, a record dropped, an address not recorded, a chain outside the plan.
10. The gate refuses on each of the five differing values and on an old fork, and accepts the override only with a reason. The input digest of a rehearsal equals that of a real run with the same inputs, and a variable read outside the input set and the left-out list fails the run.
11. The driver's plan and stages are tested with stub commands, as the regression runner's plan is.

## 21. Build split and order

| Card | What | Suggested builder |
| --- | --- | --- |
| #3891 | The mode: the driver, the node tests, the signer library and guard, the output root, the fork launcher, the clock, the report and verdict | local testing thread |
| #3892 | The relay between forks | keeper thread |
| #3893 | The readback, on #3111's file | local testing thread |
| #3894 | The indexer and keeper runners for a rehearsal | keeper thread |
| #3895 | alpha05's rehearsal mode and smoke subset | alpha05 thread |
| #3896 | The gate on the real deploy, the smoke flows, reuse of the pre-deploy gate's verdict, and the CI companion | local testing thread |
| #3897 | Rehearsing an in-place refresh | local testing thread, later |
| #3111 | The desired-state file, the plan, and the hand steps as phases | local testing thread (existing card) |
| #3109 | The Arbitrum gas fault | governance thread (existing card) |

Order: #3891 first, since everything runs inside it. #3111's file and plan beside it, because #3893 and the arming list read them. #3892 and #3894 can start with #3891. #3893 and #3895 after #3891. #3896 last. #3897 follows once a fresh deploy has been gated. A first useful run needs #3891, #3892, #3893 and the plan with manual steps carried as command text.

The fifth open question, how these merge: none of them touches `contracts/src/`, so none changes audited bytecode, and they go through the normal pull request flow, not the contract batch. They should land before the batch's fresh deploy so that deploy is the first one gated. #3891's change to the operator scripts is one line per broadcast, and held branches that add facets to the deploy script rebase over it.

## 22. Alternatives considered

- **Three declared differences, as the outline had it.** Not enough. Waiting, cross-chain delivery and publishing differ as well, and leaving them undeclared would hide them. Six, each at one seam.
- **A new expected-state manifest.** Rejected: #3111's desired-state file is the same statement. Two files would disagree.
- **Rehearse only the script's phases and keep the hand steps by hand.** Rejected: the hand steps are where the last deploy's misses were.
- **Keys made for the run in place of the roles.** Rejected for the roles: the admin owns state that already exists on the fork, and the deployer's address and nonce decide the new addresses. Kept for test actors and bot keys.
- **Setting the record root from the environment in each script.** Rejected: one rule at the bottom of the path API cannot be forgotten by a new script.
- **Listing the files a rehearsal may write.** Rejected: a list misses the write nobody thought of. One comparison of the tree before and after covers all of them.
- **The harness's local lane on the forks** (option (b) of the outline). Rejected: it replaces the router settings the rehearsal exists to test.
- **Impersonating the off-ramp from the relay instead of replacing its code.** Rejected: the release and the delivery would be separate transactions, where the real off-ramp does both in one.
- **Running the smoke flows before the readback.** Rejected: the flows change the price and sanctions sources.
- **A verdict committed to the repository.** Rejected: it would put a machine's local run in the history and delay the deploy for a review that checks nothing. The deploy record carries the verdict's digest.
- **More forge tests, a staging Diamond on the real testnets, or a hosted fork service.** Rejected in the outline, for the reasons given there.

## 23. Recommendation

Build #3891 to #3896 and finish #3111 and #3109, in the order of section 21, with #3897 after them, through the normal pull request flow. Gate fresh deploys and in-place refreshes on testnets and on mainnet, with the stated override. Treat a deploy step with no command as a defect in the plan.

## 24. What is not built

- No change to any contract under `contracts/src/`.
- No published Worker, no write to the shared database and no transaction on a real chain during a rehearsal.
- No model of Arbitrum's gas, of the messaging network's own checks, or of sequencer behaviour.
- No verdict from CI.

## 25. Open items for the builders to raise, not decide silently

1. Settled 2026-11-22 by the builder's probe: forge's unlocked sending carries two senders in one script run on the pinned version (section 12).
2. Settled 2026-11-22: the run file cannot move without the cache folder, so both move and the compile cache's index is copied in (section 13).
3. The ramp versions on each lane and the message format the stand-in must read.
4. Settled 2026-11-22: the re-stamp mechanism and its five rules (section 14).
5. Settled 2026-11-22: a verdict is valid for 24 hours on a testnet and on a mainnet (section 8). The figure changes by a change to this design, never by a flag. If a second rehearsal with one chain already live turns out not to be the same deploy, the builder raises it under #3896.
6. Any deploy step found that has no command. One is settled (2026-11-22): the operating settings the guide restores by hand and that no owner decision records (service capacity and its escrow, the arming fee, the capacity curves, the routing perk, fee entitlement). On a testnet the desired-state file carries the values of the deployment being replaced, each row marked as carried and not an owner decision, checked against what the live chains read, with any difference reported and not resolved silently. On a mainnet each of those rows needs the owner's decision, and the plan refuses a mainnet file that still holds a row marked as carried.
