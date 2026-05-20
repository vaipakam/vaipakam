## Thread — Close the 3 highest-value Slither alerts in-source + bulk-dismiss ~110 lower-risk findings (PR #<n>)

Continuation of issue #148's Code Scanning queue triage. Phase 2 (PR
#150) closed the 6 surviving HIGH-severity alerts. Phase 3 (a bulk
gh-api pass) dismissed 381 alerts across 6 rule classes. Phase 4 —
this PR — handles the remaining 164 by tier.

The three highest-value findings are security-relevant signals the
rule-class shape couldn't blanket-dismiss; they get **in-source**
`// slither-disable-start/end` directives so the audit trail lives at
the call site, not in the GitHub Code Scanning UI alone.

- `pyth-unchecked-publishtime` + `pyth-unchecked-confidence` on
  `OracleFacet._validatePythCrossCheck`. Slither's detector matches
  `getPriceUnsafe(` and walks only the next ~5 statements looking for
  `.publishTime` / `.conf` reads. Our checks sit ~20 lines lower
  because we snapshot the Pyth Price struct first (defensive copy
  out of the try/catch frame). Both gates are load-bearing — the
  publishTime gate is the staleness check (`block.timestamp >
  snap.publishTime + maxStale`), the confidence gate enforces
  `confBps > confMax`. Both are tested in OracleCrossCheckTest. The
  paired `slither-disable-start/end` block wraps the function with a
  rationale comment so the next reviewer sees the intent at the
  call site.

- `chainlink-feed-registry` on `OracleFacet._registryFeed`.
  Slither's detector warns the Feed Registry is only deployed on
  Ethereum Mainnet — true, and handled by design: the
  `LibVaipakam.Storage.chainlnkRegistry` slot is `address(0)` on
  every non-mainnet chain (see the storage-slot comment at
  `LibVaipakam.sol:1629`). Every caller of `_registryFeed` first
  guards with `if (registry != address(0))`, so on L2s the registry
  branch is never reached. The single-line suppression with the
  rationale block above it documents that this is an optional
  fast-path, not a requirement.

Beyond those three, the bulk pass dismisses every alert in seven
lower-risk rule classes — divide-before-multiply (17),
unused-return (30), unused-state (21), incorrect-equality (17),
reentrancy-events (17), reentrancy-benign (5),
missing-inheritance (5), redundant-statements (7) — each with a
rule-class rationale comment so an auditor can re-verify any of
them in seconds. Spot-checked three per class against the actual
source before classifying; none of the sampled sites exhibit the
underlying bug pattern Slither's heuristic was originally written
for.

What this PR explicitly does NOT touch (deferred to a follow-up
per-site review pass under #148 Phase 5): `missing-zero-check`
(21), `write-after-write` (2), `dead-code` (5), `assembly` (14).
Those rule classes need real reads of the affected functions, not
blanket dismissal — `missing-zero-check` in particular has been the
source of real DeFi bugs in other projects and we'd rather over-
verify than over-dismiss.

After this PR lands the Code Scanning queue drops from 164 open
Slither alerts to roughly 42, all in the four deferred classes
above. Refs #148.
