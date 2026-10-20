# Storage-layout guard (#1274, #2092)

## Why

A Diamond refreshed in place keeps its storage and swaps its facets. A UUPS
proxy upgraded in place keeps its storage and swaps its implementation. Either
way, if the new code lays a field out anywhere other than where the old code
wrote it, every read of that field returns some other field's bytes. Nothing
reverts to say so.

The repository stated the rule ("append-only post-launch") only in comments.
#2092 measured what that was worth. Across the testnets' lifetime,
`LibVaipakam.Storage` had fields removed on 2026-06-23 and on 2026-08-16, and
nothing would have stopped a refresh across either.

## What the compiler says happened

The guard was validated by replaying those removals through it, with the
compiler's own layout of each side (solc 0.8.29, the repository's settings):

| Change | Lines of the old layout gone | Top-level fields moved |
| --- | --- | --- |
| #711 (2026-06-23), 7 fields removed | 586 | 325, from slot 53 on |
| #714 (2026-06-23), 7 fields removed | 572 | 315, from slot 56 on |
| #715 (2026-06-23), 1 field removed | 171 | 81, from slot 217 on |
| #1771 (2026-08-16), `baseAuthorizedMessenger` removed | **1** | **0** |

The guard refuses all four. The last row corrects #2092, which counted
declaration indices and reported 310 fields shifted by #1771. The removed field
was an `address` packed into slot 212 behind a `uint16`, so its removal moved
nothing; only its own line is gone. The June removals did move hundreds of
fields. The Diamonds running today on Base Sepolia, Arbitrum Sepolia and BNB
testnet were deployed fresh on 2026-10-17 and 2026-10-18, after all four. Their
in-place refreshes since then were append-only. Main at each deploy (`719172ce`
and `872545d4`) and at the 2026-10-19 refresh (`dc72b36`) gives a ledger that is
wholly included in today's: the Diamond's seven namespaces have gained 9 lines
and lost none.

## Design

### The compiler is the source, through roots

Every layout that survives an upgrade is a **root**, listed in
`contracts/storage-layout/roots.json`:

- **Namespaces.** These are the Diamond's storage structs at hashed positions:
  `LibVaipakam.Storage`, `LibERC721`, `LibAccessControl`, `LibPausable`,
  `LibReentrancyGuard`, diamond-3's `LibDiamond`, and the cross-chain
  `GuardianPausable` storage. A library struct has no state variable, so the
  compiler never reports its layout. Each one therefore gets a **probe**, a
  never-deployed contract in `src/storage-layout/StorageLayoutProbes.sol`
  that declares one variable of the struct. The struct's position comes from
  the source constant. Three forms are evaluated: a literal, `keccak256("…")`,
  and the ERC-7201 formula. A literal that disagrees with the ERC-7201
  derivation in its own comment is refused.
- **UUPS implementations.** These are the 13 contracts behind `ERC1967Proxy`s;
  their own state variables are the layout.

`forge build` writes each root's `storageLayout` because foundry.toml carries
`extra_output = ["storageLayout"]`.

### The ledger

`contracts/script/storage-layout-guard.mjs` flattens each layout into
**lines**. Each line states one fact a live contract depends on:

- `L|region|slot|offset|type|path`: a value of this type lives here, as this
  field.
- `M|region|slot|offset|keyType|path`: this mapping is keyed by this type. Its
  values live in region `region@slot[keyType]`.
- `D|…|path` and `W|elementRegion|bytes`: a dynamic array, and the stride of
  its elements. `W` also covers fixed arrays of structs.
- `E|enum|index|member`: the enum's Nth member, parsed from the source.
- `P|root|position`: where a namespace sits.

The rule is **set inclusion**: every line of the old ledger must be in the new
one. Appending a field only adds lines. Inserting, removing, reordering,
retyping, moving a namespace or changing an element stride removes at least
one line. No case analysis is needed for nested structs. A struct that grows
in place moves whatever follows it, and those lines go missing. A struct that
grows at the tail, or as a mapping's value, moves nothing and passes.

`__gap` arrays are free space and contribute no lines. A new field may take a
slot a gap gives up. Shrinking a gap by the wrong amount moves the field after
it, which is then caught.

### Why lines carry the field name

Position and type alone cannot tell two changes apart. Inserting a `uint256`
into a run of `uint256`s leaves the same set of (slot, type) pairs as appending
one. Yet every field after the insertion now reads its neighbour's value. Only
the name says which field a slot belongs to, so the name is part of the line.

So a rename also removes a line. It must be **declared** in
`contracts/storage-layout/renames.json`, anchored on the field's exact old
line (region, slot, offset, old path), with a reason. A declaration is
permanent and is honoured everywhere, because a chain refreshed long after the
rename still needs it. It applies only to a ledger that has that field at that
anchor, so a later, unrelated field that reuses the old name is never rewritten.
Enum member renames are declared by index. A field given a new meaning under a
new name is a **repurpose**: a break, not a rename to declare.

### Deliberate breaks

A break that is intended is acknowledged in
`contracts/storage-layout/breaks.ack.json`. Each entry names the sha256 of the
exact base golden file it was measured against, the exact lines it accepts, and
why. It goes inert as soon as the base changes, so it cannot outlive the
comparison it was written for. Only CI honours one. An acknowledgement means
nothing may be upgraded in place across this change, which is why the
deploy-time check (below) never reads one. A malformed entry is an error, not
an acknowledgement that quietly accepts nothing or everything.

### Completeness

A layout nobody lists is a layout nobody checks, so the guard refuses:

- a `.slot :=` storage pointer in `src/` that no root names. Each pointer is
  resolved to the struct its function returns and the position constant it is
  set from, and a pointer that cannot be resolved is refused too;
- a namespace root whose position file has no pointer joining the probe's
  struct to the root's constant, since the probe might then describe some
  other storage;
- a concrete contract inheriting `UUPSUpgradeable`, at any depth, that is not
  a UUPS root, and a UUPS root that no longer inherits it;
- any facet, the Diamond proxy or `DiamondCutFacet` that declares an ordinary
  state variable, because that would write at the Diamond's slot 0 onwards.

OpenZeppelin's own ERC-7201 namespaces inside the upgradeable library are not
roots. They live in the audited submodule, and a bump of it is a re-audit (see
"Dependabot — off-chain only" in CLAUDE.md).

## Where it runs

- **`predeploy-check.sh` step 1b**, after the build. It checks that the
  committed `contracts/storage-layout/layout.golden.json` matches the code just
  compiled and that the tree is complete. Node is a required dependency there,
  like python3 for step 2c: a gate that skips a storage check when an
  interpreter is missing is the failure #2092 describes.
- **CI, contracts-fast.** The job fetches the base commit's golden file (the PR
  base, or the pre-push tip on `main`) and passes it as `STORAGE_LAYOUT_BASE`,
  so the append-only comparison runs before merge. A base without a golden file
  is the change that introduces the guard. Any other failure to read one fails
  the job.
- **Tests:** `packages/contracts/scripts/storage-layout-guard.test.mjs`, run by
  the workspaces job. viem is available there to cross-check the guard's own
  Keccak-256. The guard itself has no dependencies, because nothing on the
  predeploy path installs the pnpm workspace.

Changing a contract's storage therefore means running
`node contracts/script/storage-layout-guard.mjs write` after `forge build` and
committing the golden file with the change.

## Not in this change: the deploy-time refusal (#2092 item 1)

CI stops a break from merging unnoticed. It cannot stop a refresh of a chain
whose Diamond was deployed from older code than the base. That needs each
chain's own record. The follow-up records the golden ledger at every deploy and
refresh in `contracts/deployments/<slug>/`. It then makes the in-place scripts
(`RefreshAllFacetsInPlace`, `RedeployFacets`, `ReplaceStaleFacets`,
`UpgradeVaultImplementation`) refuse a target whose recorded ledger is not
included in the new one, after applying declared renames. It never applies
acknowledgements.

## Decisions answered here

- **#1274 item 2 (`__gap` slots): none added to the Diamond's namespaces.** The
  functional spec already states that the main storage struct needs no `__gap`.
  A namespace's tail can always grow, and the guard rejects growth anywhere
  else. An inline struct in the middle of `Storage`, such as `protocolCfg`,
  cannot grow in place, and the guard says so. A new field goes at the tail of
  `Storage`. Adding a gap now would itself be a layout break on the live
  testnets.
- **#2092 item 3 (per-chain audit): moot for today's Diamonds.** All three
  active testnets were deployed fresh on 2026-10-17 and 2026-10-18, after every
  break measured above, and their layouts have only been appended to since
  then.
