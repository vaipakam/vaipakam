## Fast inner-loop forge build via `quick` foundry profile (Issue #185)

`forge build` under the default profile takes 14-19 min cold and uses
~8 GB RSS — for any iteration loop where you only care about "does
my contract change compile?", that's a wall hit hard enough to stall
focused work. (The blocker surfaced during the #183 implementation
session.)

Adds a new `[profile.quick]` to `contracts/foundry.toml` that drops
`test/` and `script/` from the compile set and keeps `src/` + `lib/`.
viaIR + optimizer stay ON — several `src/` facets (e.g.,
`EscrowFactoryFacet.sol:631`) structurally need viaIR to compile
(stack-too-deep otherwise), so dropping it isn't an option without
refactoring src/. The win comes from the LOC reduction alone — `src/`
is roughly half the project's Solidity, and the lib's tests were
already skipped under the default profile.

Measured (cold cache, on the dev box that motivated this card):

| Run | Default profile | Quick profile |
|---|---|---|
| Cold | 14-19 min, ~8 GB RSS | **44 s, ~677 MB RSS** |
| Warm cache | (recompile of cache hits) | **<1 s, ~104 MB RSS** |
| Incremental rebuild after touching 1 src/ file | (cache miss cascade) | **<1 s, ~104 MB RSS** |

**Usage** (per CLAUDE.md "Executing forge" section):

- Inner-loop "did my change compile?" → `FOUNDRY_PROFILE=quick forge build`
- Tests / scripts / regression / predeploy → `forge build` / `forge test`
  (default profile, unchanged)
- CI is unchanged — every gate runs under the default profile.

**Constraint**: do NOT use `FOUNDRY_PROFILE=quick` with `forge test`.
Tests need viaIR + optimizer parity with src/ to reproduce production
bytecode, and the quick profile's `test/**` skip would empty test
discovery.

This is the narrow, urgent half of the broader test-suite cleanup
([#168](https://github.com/vaipakam/vaipakam/issues/168)). #168
continues to track the deeper wins (mock dedup, SetupTest refactor,
drop redundant scenarios) that also speed up the default profile.
