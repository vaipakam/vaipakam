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
and lost none. (These comparisons were made with the first form of the
ledger. The `C` and `U` lines and the OpenZeppelin roots added since only add
facts; a change that removed a field still removes the same lines.)

## Design

### The compiler is the source, through roots

Every layout that survives an upgrade is a **root**, listed in
`contracts/storage-layout/roots.json`:

- **Namespaces.** These are storage structs at hashed positions: the
  Diamond's `LibVaipakam.Storage`, `LibERC721`, `LibAccessControl`,
  `LibPausable`, `LibReentrancyGuard` and diamond-3's `LibDiamond`; the
  cross-chain `GuardianPausable` storage; and the seven OpenZeppelin ERC-7201
  namespaces the UUPS implementations keep their state in (`Initializable`,
  `ERC20`, `ERC20Capped`, `ERC4626`, `Ownable`, `Ownable2Step`, `Pausable`).
  A struct at a hashed position has no state variable, so the compiler never
  reports its layout. Each one therefore gets a **probe**, a never-deployed
  contract in `src/storage-layout/StorageLayoutProbes.sol` that declares one
  variable of the struct. The struct's position is evaluated from the
  constant's expression in the AST: literals, `keccak256`, `abi.encode` of
  words, `uint256`/`bytes32` conversions, `+ - & | ^ ~` and other constants of
  the same file, which covers the literal, `keccak256("…")` and ERC-7201
  forms however they are written. Anything else is refused. A literal that
  disagrees with the ERC-7201 derivation in the comment above it is refused.
- **UUPS implementations.** These are the 13 contracts behind `ERC1967Proxy`s;
  their own state variables are the layout.

The guard builds the artifacts it reads itself: `forge build --ast
--extra-output storageLayout` under the `quick` profile (src/ and lib/ only),
into `contracts/out-storage-layout`, with its own cache. It never reads the
shared `out/`, so what it checks is always the tree on disk, whatever was built
before it. Neither output is set in foundry.toml. The first version of this
change set both there for every profile; that changed CI's forge cache key, so
the contracts job had no warm cache, and its cold deploy-sanity compile lost
the runner twice. Storage layouts and ASTs do not depend on the optimizer or
on which tests exist, so the narrow build gives the same ledger.

### Source facts come from the AST, never the text

Everything the guard checks about the source is read from the compiler's AST:
which assignments set a storage pointer's slot, which struct the pointer is
typed as, which constant the slot comes from, each constant's value, enum
members, and what each user-defined value type wraps. The first version read
these with regular expressions over comment-stripped source, and its first
review found four ways past them: a qualified base name, a second struct read
at a rooted position, a pointer in a dependency, and spacing. Each was a gap
between what the text looked like and what the compiler had resolved. Reading
the compiler's own resolution closes that whole class instead of patching
each spelling.

Two consequences:

- **Declaration ids are resolved only within their own file.** solc numbers
  AST nodes per compiler run, and forge's incremental builds compile different
  files in different runs, so an id from one artifact means nothing in
  another. A pointer whose position constant is declared in another file is
  therefore refused, not guessed at. Every pointer in the tree today has its
  constant in its own file.
- **An artifact is used only if it was compiled from the file on disk.** Each
  artifact's metadata records the keccak256 of every source it was compiled
  from. The guard hashes the files and ignores an artifact whose source no
  longer exists (forge never prunes those, and CI restores `out/` from a
  cache). It refuses one whose source exists but has changed, because then the
  build did not run. A contract of a root's name compiled from a test, a script
  or a dependency is never the root.

### The ledger

`contracts/script/storage-layout-guard.mjs` flattens each layout into
**lines**. Each line states one fact a live contract depends on:

- `L|region|slot|offset|type|path`: a value of this type lives here, as this
  field.
- `C|region|slot|offset|path`: an inline struct, or a fixed array of
  non-value elements, starts here as this field. Its members already state
  everything its type does; the line exists so a rename of the container can
  be anchored like any other field.
- `M|region|slot|offset|keyType|path`: this mapping is keyed by this type. Its
  values live in region `region@slot[keyType]`.
- `D|…|path` and `W|elementRegion|bytes`: a dynamic array, and the stride of
  its elements. `W` also covers fixed arrays of structs.
- `R|region|slot|offset|struct|path`: a struct that contains itself, through a
  mapping or a dynamic array (a tree node with `mapping(uint256 => Node)
  children`), recurs here. Its members are the lines already written for the
  enclosing instance, so they are recorded once rather than expanded forever.
- `E|enum|index|member`: the enum's Nth member, from its AST declaration.
- `U|valueType|underlying`: what a user-defined value type wraps. The layout
  line names only the value type, so without this a redefinition (`type
  Amount is uint256` becoming `uint128`) at the tail of a struct would move
  nothing and pass.
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
line (region, slot, offset, old path; a value, container, mapping or array
line), with a reason. A declaration is
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
comparison it was written for. A live entry must list only lines the change
actually removes: a line it lists that is still present would pre-authorise a
later removal against the same base, so the guard refuses it. It is read only when the guard is run with
`--honour-acks`, which `predeploy-check.sh` passes only when
`STORAGE_LAYOUT_HONOUR_ACKS=1`, which only CI's merge check sets. An operator
comparing against a deployed chain's layout with `STORAGE_LAYOUT_BASE` alone
never reads one. An acknowledgement means
nothing may be upgraded in place across this change, which is why the
deploy-time check (below) never reads one. A malformed entry is an error, not
an acknowledgement that quietly accepts nothing or everything.

### Completeness

A layout nobody lists is a layout nobody checks, so the guard refuses:

- a `.slot :=` storage pointer, in any source compiled into a `src/` contract
  (dependencies included), that no root names. Each pointer is resolved to
  the struct it is typed as and the position constant its slot is set from:
  the constant itself, or a local initialised once from it, or from a
  parameterless function in the same file that returns it. A local qualifies
  only when the pointer's read is its sole use anywhere in the file, so a
  later assignment, `delete`, tuple write or Yul `:=` is refused without the
  guard having to recognise each form of write. A pointer that
  cannot be resolved is refused too, and so is one whose position comes from
  a virtual function declared more than once in scope, since an override
  moves the namespace;
- a pointer that reads a rooted namespace as any struct other than the one
  its root probes, because that second view's layout is recorded nowhere;
- a namespace root with no pointer joining the probe's struct to the root's
  constant, since the probe might then describe some other storage, and two
  roots at one position;
- a deployable `src/` contract exposing `proxiableUUID()` that is not a UUPS
  root, and a UUPS root that does not expose it. The test reads the compiler's
  method list, so it does not depend on how the contract reaches
  `UUPSUpgradeable`;
- any facet, the Diamond proxy or `DiamondCutFacet` that declares an ordinary
  state variable, because that would write at the Diamond's slot 0 onwards.

One file is exempt, by name and with its reason in `roots.json`:
OpenZeppelin's `StorageSlot.sol`, whose typed accessors take the slot as a
parameter and so define no namespace; the slots they are used with here are
EIP-1967's fixed implementation, admin and beacon slots. The exemption passes
only pointers whose slot is a parameter of their function. Any other pointer
in the file, such as a real namespace a dependency bump adds beside the
accessors, is checked like any pointer elsewhere. An exemption for a file
that no longer has a parameter-slot pointer, or that nothing compiles, is
itself an error.

## Where it runs

- **`predeploy-check.sh` step 1b**, after the build. The guard's command line
  is strict: an unknown flag, a repeated one or a flag without its value stops
  the run, so a typo cannot quietly skip the comparison it asked for. It checks that the
  committed `contracts/storage-layout/layout.golden.json` matches the code just
  compiled and that the tree is complete. Node is a required dependency there,
  like python3 for step 2c: a gate that skips a storage check when an
  interpreter is missing is the failure #2092 describes.
- **Every deploy and in-place change**, against the chain's own record. See
  "The deploy-time refusal" below.
- **CI, contracts-fast.** The job fetches the base commit's golden file (the PR
  base, or the pre-push tip on `main`) and passes it as `STORAGE_LAYOUT_BASE`,
  so the append-only comparison runs before merge. A base without a golden file
  is the change that introduces the guard. Any other failure to read one fails
  the job.
- **Tests:** `packages/contracts/scripts/storage-layout-guard.test.mjs`, run by
  the workspaces job. viem is available there to cross-check the guard's own
  Keccak-256. The guard itself has no dependencies, because nothing on the
  predeploy path installs the pnpm workspace. The source checks are tested
  against a real solc AST, `fixtures/storage-layout-guard/ast.json`, which
  `regen.mjs` there regenerates from the fixture sources beside it; a
  hand-written AST would test the guard against its author's idea of solc.

Changing a contract's storage therefore means running
`node contracts/script/storage-layout-guard.mjs write` (it builds first) and
committing the golden file with the change.

## The deploy-time refusal (#2092 item 1)

CI stops a break from merging unnoticed. It cannot stop a refresh of a chain
whose code is older than the PR's base, because a chain does not run `main`: it
runs whatever last reached it. So each chain carries its own record,
`contracts/deployments/<slug>/storage-layout.json`, a copy of the golden ledger
as it stood when code last reached that chain.

**Who writes it.** `DeployDiamond.run()` writes it at the end of every deploy
that writes the deployment artifact, and every in-place script below rewrites
it after its change. A dry run writes no record, like it writes no artifact.
The guard writes the file (`storage-layout-guard.mjs record --to <file>`), and
that mode refuses a stale golden file, so a record always describes the code
being deployed. A fresh deploy wrapper (`deploy-testnet.sh`,
`deploy-mainnet.sh`, and `deploy-chain.sh --fresh`) moves the old record and
anchor aside with the old `addresses.json`.

**The record is bound to the live chain.** A record is a file in one
checkout, and a chain can be changed from another: a refresh whose new record
was never committed, or two branches that each start from the same record and
add different fields at the same free slot. Checked only against its own
checkout's file, the second of those refreshes would pass and reinterpret the
first one's storage. So beside the record sits its anchor,
`storage-layout.anchor.json`, written with it: the Diamond, a fingerprint of the
code it runs (the loupe's facet address list and the vault template) and the
record's own hash. A change is refused unless the live Diamond still matches
the anchor and the record is the one the anchor names, so a chain changed from
elsewhere fails here instead of being checked against a record that no longer
describes it. Two runs racing from different checkouts can both pass before
either broadcasts, and nothing off-chain can close that, so these scripts are
run one at a time per chain. `AnchorStorageLayoutRecord.s.sol` writes an anchor
on its own, for a chain's one-time seed and for recovery after a change reached
a chain without recording; it refuses unless the operator sets
`ANCHOR_RECORD_DESCRIBES_CHAIN=true`, because writing one asserts that the
record describes what the chain runs.

**Who checks it.** Every script that changes deployed code in place runs
`storage-layout-guard.mjs check --base <record>` before its first transaction
and refuses on a non-zero exit: `RefreshAllFacetsInPlace`,
`RefreshChangedFacetsInPlace`, `RedeployFacets`, `ReplaceStaleFacets`,
`UpgradeOracleFacet`, `MigrateRiskTermsCommitReveal` and
`UpgradeVaultImplementation`. It is the same command CI runs, so declared
renames apply and acknowledgements never do: an acknowledged break means no
chain may be upgraded in place across it. A chain with no record is refused,
because the layout it runs is unknown. `DeployDiamond` runs the plain `check`
first, so a deploy from a checkout with a stale golden file is refused before
anything is sent, rather than failing at the record after `addresses.json`
already names the new Diamond.

**Inside each script, through `--ffi`** (owner decision 2026-10-23). The
refusal sits where the code change happens, so no entry point reaches a chain
around it. Each script calls the guard through `vm.tryFfi`, so these scripts
are run with `--ffi`, and a run without it is refused before its first
transaction. `foundry.toml` enables neither ffi nor a read of
`storage-layout/`: it is part of CI's forge cache key (#2603), and the flag
belongs on these invocations only. The checks sit in each script's one
body (its `runWith` where it has one), so selecting a function with `--sig`
cannot skip them. They skip themselves under `forge test`, which has no ffi
and no chain, and for a run whose artifact root is redirected to a scratch
directory, which is allowed only on Anvil or under test and so holds no live
chain's record. The wrappers that run these scripts pass `--ffi`.

**Why over-recording is safe.** Every comparison is set inclusion (record ⊆
new layout). A record claiming more than a chain runs can only refuse more. So
a record written by a simulation whose broadcast then failed is safe, a curated
refresh may record the whole tree, and a facet-only refresh may record the
UUPS roots too. A record claiming less than the chain runs is the dangerous
direction, which is why a missing record refuses rather than skips.

**Seeded for the live testnets.** Base Sepolia, Arbitrum Sepolia and BNB
testnet were deployed on 2026-10-17 and 2026-10-18 and refreshed on
2026-10-19. Main at each of those points is included in #2600's golden ledger
(measured, #2092 comment of 2026-10-20), #2600's ledger is included in today's
(checked with `check --base` when the records were written), and no break has
been acknowledged since. Their records are therefore today's ledger, anchored to each Diamond as it
ran when the records were written. Ethereum
Sepolia and OP Sepolia are retired and carry no record, so a refresh of either
is refused.

**What it does not cover.**

- A cut or upgrade sent outside these scripts: `cast`, a Safe transaction
  built by `multicallDeploy` (a pure payload builder), or a governance
  proposal. Mainnet takes fresh deploys only (owner decision O1 = A), so no
  in-place path exists there today; when one is built after launch (decision
  D5), its proposal builder must run the same check.
- The record is written in forge's pre-send simulation, like `addresses.json`,
  so it can describe a change whose broadcast then failed part-way. That is
  over-recording, which the paragraph above shows is safe; the operator still
  has to read the broadcast journal to learn what the chain runs.

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
