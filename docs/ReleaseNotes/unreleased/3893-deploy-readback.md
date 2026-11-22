## Local testing — the deploy readback (PR #TBD)

A deployment can now be checked against its desired-state file, row by row. The new readback script compares each chain with `deployments/testnets.desired.json` and with the run's own records. Each row reports what the file expects, what the chain or the records say, the result (met, not met, unreadable or info) and which comparison produced it. Any row that is not met or cannot be read fails the run. The same script runs on the rehearsal's forks and, after the real deploy, on the live chains.

It checks:
- The settings and switches: the Diamond is unpaused after launch, the Terms version and hash, and every setting the file names.
- The roles: the admin holds every grantable role and owns the Diamond, the deployer holds none, and each bot holds its roles. The treasury is the one the vault code names.
- The rewards: role, custody activation, the pool funded with the stated amount, the anchor equal on every chain, the first capped day armed, and Base's expected sources.
- The cross-chain lanes: a CCIP selector and the right peer messenger in each direction.
- The sources: a sanctions source that has code and answers a screen, and the swap routes.
- The deployment getters: every Diamond getter that names another contract must answer an address, unless the file lists it as not deployed on that chain, with a reason.
- The code: the routed selector set equals this commit's facets.
- The records: every address the broadcast journals created is recorded, or listed by name with a reason. The storage-layout record is written, the archive manifest names the retired Diamond, no carried key was dropped, and only the planned chains received transactions.

The rehearsal driver runs the readback as its own stage, after the plan's steps and before anything else touches the forks. It reads the desired file named on the plan's first line, and refuses it if the file changed after the plan was made. A plan that names no desired file is reported as not covered, so its verdict cannot be green. The plan check now also validates the two new lists in the desired file and refuses an entry without a reason.

A getter may answer zero only when the desired file says why, as a recorded fact and never a default. A "by design" entry covers a zero that the canonical/mirror split explains; the four such zeros on the testnets are listed, for design to check. A "venue" entry covers an outside contract missing from the chain. It must cite the venue's own published deployment list and the date it was read, and the row shows that evidence. On mainnet every such entry also needs the owner's recorded acceptance. A getter that reverts always fails. A getter whose rule design has not given yet (today, the rate model) shows as "awaiting ruling": neither met nor failed, and refused outright on mainnet.

Run against today's live testnets, the readback shows where they differ from the next deploy's desired state. That is expected, since the next deploy sets those values.

> Caveat: not yet covered are the token pools' rate limits and their admin, the token's CCIP registration, the delisting route's clearance source and the feed bindings. The script's header says so.

Closes #3893
