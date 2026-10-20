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

`forge build` writes each root's `storageLayout` because foundry.toml carries
`extra_output = ["storageLayout"]`, and each source's AST because it sets
`ast = true`.

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
