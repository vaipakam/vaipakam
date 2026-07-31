#!/usr/bin/env bash
#
# predeploy-check.sh — pre-deploy sanity gate for the Vaipakam contracts.
#
# Run this before deploying to any chain. It fails (exit non-zero) on the
# first sign of a problem so a broken build, an over-size facet, an uncut
# selector, a selector collision, a malformed deploy script, or a stale
# committed ABI can never reach a broadcast.
#
# Checks:
#
#   1. forge build — the contracts compile.
#
#   2. Forge test suite:
#        • default            — the deploy-sanity suite (test/deploy/*):
#            FacetSizeLimitTest    (every facet within EIP-170; #66),
#            SelectorCoverageTest  (every facet selector cut into the
#                                   Diamond + no 4-byte selector
#                                   collision; #71).
#        • with `--full`      — the entire regression suite (invariants
#            excluded — run those separately; they are slow). Use for a
#            mainnet preflight: do not deploy contracts whose tests are
#            red. `deploy-mainnet.sh` passes `--full`.
#
#   3. Deploy shell-script lint — `deploy-{chain,testnet,mainnet}.sh`:
#        • `bash -n` syntax check.
#        • `shellcheck` at error severity, if shellcheck is installed.
#        • each script references `DeployDiamond.s.sol`.
#        • stale-LayerZero-residue guard — the CCIP migration (T-068
#          Phase 6.4) removed the old LZ deploy variables; this stops
#          them creeping back in.
#
#   4. ABI-export-in-sync — every committed per-facet ABI JSON matches
#      current `forge inspect <Facet> abi`, AND every facet the export
#      script's `FACETS=(...)` list expects has a committed JSON (a
#      *missing* required ABI — a facet added without committing its
#      JSON, or a JSON deleted — is caught here, not just a stale one).
#      A stale or missing committed ABI ships consumers that mis-decode
#      (or cannot bind) the deployed contract. Frontend ABIs
#      (packages/contracts/src/abis) ship inside this monorepo, so drift
#      there fails the gate. Keeper-bot ABIs (the sibling
#      vaipakam-keeper-bot repo, when checked out) are re-synced and
#      redeployed on their own cadence — drift there is advisory, not a
#      contract-deploy blocker.
#
# Usage:
#   bash script/predeploy-check.sh            # deploy-sanity suite only
#   bash script/predeploy-check.sh --full     # + full regression
#
# It is also invoked automatically as a preflight step inside
# `deploy-chain.sh`, `deploy-testnet.sh` and `deploy-mainnet.sh`, so a
# deploy physically cannot proceed past a failing sanity check.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
cd "$CONTRACTS_DIR"

# ── Arguments ─────────────────────────────────────────────────────────
MODE_FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) MODE_FULL=1 ;;
    *) echo "predeploy-check.sh: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

FAIL=0

# ── 1. Build ──────────────────────────────────────────────────────────
# `--skip test` is load-bearing, not an optimisation (#636). A deploy
# preflight only needs `src/` + the deploy/config `script/`s to compile —
# the test compile is exercised by step [2] below. A bare `forge build`
# compiles `src/` + ALL `test/` + ALL `script/` in one non-sparse solc
# unit; this codebase sits right at the viaIR whole-unit stack ceiling, so
# the standalone deploy scripts tip it over with `Variable size is N too
# deep in the stack` — a compilation-unit-size limit, NOT a code bug (see
# CLAUDE.md "Local full regression" + Issue #636). Skipping the test files
# keeps the unit under the ceiling while still validating every contract a
# deploy actually touches.
echo "[predeploy 1/4] forge build (--skip test — see #636)"
if forge build --skip test; then
  echo "  ✓ contracts compile (src + scripts)"
else
  echo "  ✗ forge build failed" >&2
  FAIL=1
fi

# ── 2. Forge test suite ───────────────────────────────────────────────
echo
if [ "$MODE_FULL" -eq 1 ]; then
  echo "[predeploy 2/4] full forge regression (mainnet preflight)"
  # Invariants are excluded — they are slow (100 runs) and run as their
  # own pass; this gate is "the regression is green before a deploy".
  # `--match-path 'test/*.t.sol'` forces a SPARSE compile (only the matched
  # tests + their dependency closure) rather than the non-sparse
  # `--no-match-path`-only form, which pulls in the standalone deploy
  # scripts and trips the same viaIR whole-unit ceiling as step [1] (#636 /
  # #601). globset's `*` crosses `/`, so `test/*.t.sol` still matches every
  # current + future `*.t.sol` anywhere under `test/` — same coverage, just
  # compiled sparsely. Mirrors `run-regression.sh`.
  if forge test --match-path "test/*.t.sol" --no-match-path "test/invariants/*"; then
    echo "  ✓ full regression passes"
  else
    echo "  ✗ regression failed — do not deploy red contracts" >&2
    FAIL=1
  fi
else
  echo "[predeploy 2/4] deploy-sanity forge suite (test/deploy/*)"
  if forge test --match-path "test/deploy/*"; then
    echo "  ✓ FacetSizeLimitTest + SelectorCoverageTest pass"
  else
    echo "  ✗ deploy-sanity suite failed — a facet is over EIP-170, a" >&2
    echo "    facet selector is not cut into the Diamond, or two" >&2
    echo "    selectors collide. See the test output above (UNCUT /" >&2
    echo "    COLLISION lines name the offending functions)." >&2
    FAIL=1
  fi
fi

# ── 2b. Sanctions frozen-claimant register-coverage (source scan, #1132) ──
# Complements the compiled-artifact deploy-sanity suite above with a SOURCE
# scan: every deferred-claim / held-credit write in src/ must be co-located
# with a side-matched fail-closed frozen-claimant register (S10 central
# enforcement). Fails the gate on any un-registered write.
echo
echo "[predeploy 2b/4] sanctions register-coverage guardrail (#1132)"
if command -v node >/dev/null 2>&1; then
  if node "$SCRIPT_DIR/check-sanctions-register-coverage.mjs"; then
    : # the script prints its own ✓ line
  else
    echo "  ✗ a deferred-claim / held write is missing its co-located" >&2
    echo "    fail-closed frozen-claimant register (S10) — see the" >&2
    echo "    offenders above." >&2
    FAIL=1
  fi
else
  echo "  · node not installed — skipping (CI's contracts-fast job enforces it)"
fi

# ── 3. Deploy shell-script lint ───────────────────────────────────────
echo
echo "[predeploy 3/4] deploy shell-script lint"
DEPLOY_SH=(deploy-chain.sh deploy-testnet.sh deploy-mainnet.sh)

# 3a. bash -n syntax.
for s in "${DEPLOY_SH[@]}"; do
  if bash -n "$SCRIPT_DIR/$s" 2>/dev/null; then
    echo "  ✓ $s — bash -n syntax OK"
  else
    echo "  ✗ $s — bash -n syntax error" >&2
    FAIL=1
  fi
done

# 3b. shellcheck (error severity only) — advisory if not installed.
if command -v shellcheck >/dev/null 2>&1; then
  for s in "${DEPLOY_SH[@]}"; do
    if shellcheck --severity=error "$SCRIPT_DIR/$s"; then
      echo "  ✓ $s — shellcheck (error severity) clean"
    else
      echo "  ✗ $s — shellcheck found error-level issues" >&2
      FAIL=1
    fi
  done
else
  echo "  · shellcheck not installed — skipping (install it for deeper lint)"
fi

# 3c. Each deploy script must orchestrate the Diamond deploy.
for s in "${DEPLOY_SH[@]}"; do
  if grep -q 'DeployDiamond.s.sol' "$SCRIPT_DIR/$s"; then
    echo "  ✓ $s — references DeployDiamond.s.sol"
  else
    echo "  ✗ $s — no reference to DeployDiamond.s.sol (renamed/removed?)" >&2
    FAIL=1
  fi
done

# 3d. Provenance-stamp ordering (#1490). Any script that writes a
# `monorepoCommit` stamp must snapshot the working-tree state BEFORE it
# writes its own output — otherwise the dirty marker is set on every run by
# the script's own artifacts and distinguishes nothing, which is exactly the
# state #1490 found: six of the seven stamping scripts, six always-dirty
# stamps. (The seventh, `exportAbis.sh`, writes into a SIBLING checkout, so
# its own output never dirtied the tree it tested — it was correct, and is
# held to the same idiom only so no script here is a special case.)
#
# Checks the property DIRECTLY rather than by counting `git diff` calls. An
# earlier revision grepped for the literal `git diff --quiet`, which matched
# only the explanatory COMMENTS — every real call is spelled
# `git -C "$SOMEWHERE" diff --quiet HEAD`, so the check was counting its own
# prose and would have passed a late recomputation written the way the
# scripts actually write it (Codex #1495 r1 P2). Counting was also the wrong
# idea outright: `deploy-mainnet.sh` legitimately calls `git diff --quiet` a
# second time to REFUSE a dirty mainnet deploy, which is a gate, not a stamp.
#
# So instead: find the variable actually interpolated into the stamp, and
# require that it is assigned exactly once, from the snapshot, and that the
# snapshot precedes the first write.
#
# COVERAGE LIMIT, stated rather than implied: "first write" is found by
# looking for `forge inspect`, `python3 - `, `jq ` and `cat > "$`. A script
# writing by some other means is checked for the idiom but NOT for ordering.
# Widen the pattern rather than trusting silence.
# Discovery keys on the SHAPE of the emission, never on the NAMES of the
# interpolated variables (Codex #1495 r5 P2). Matching a variable containing
# `DIRTY` meant an ordinary rename silently dropped a script from this list
# while the non-empty check stayed green — so a rename bypassed every
# predicate below without a single failure. Discovery finds the file; the
# parser below validates the variables.
STAMPING_SH=()
while IFS= read -r f; do STAMPING_SH+=("$(basename "$f")"); done < <(
  grep -rlE 'monorepoCommit"?:? "?\$' "$SCRIPT_DIR"/*.sh 2>/dev/null \
    | grep -v '/predeploy-check\.sh$' | sort
)
if [ ${#STAMPING_SH[@]} -eq 0 ]; then
  echo "  ✗ no provenance-stamping scripts matched — pattern drifted?" >&2
  FAIL=1
else
  for s in "${STAMPING_SH[@]}"; do
    f="$SCRIPT_DIR/$s"
    # The dirty variable is the SECOND interpolation in the stamp value.
    # EVERY emission, not just the first (Codex #1495 r7 P2).
    # `exportSubgraphAbis.sh` already stamps twice — an ABI bundle and a
    # per-chain manifest — so a `head -1` parser validated one pair and let a
    # second, independently-assigned pair bypass every predicate. Scripts that
    # stamp more than once are exactly where a refactor would introduce a late
    # read, since the second emission is the one nobody remembers.
    dirty_vars="$(sed -nE 's/.*monorepoCommit"?:? "?\$[A-Za-z_][A-Za-z0-9_]*\$([A-Za-z_][A-Za-z0-9_]*).*/\1/p' "$f" | sort -u)"
    commit_vars="$(sed -nE 's/.*monorepoCommit"?:? "?\$([A-Za-z_][A-Za-z0-9_]*)\$[A-Za-z_][A-Za-z0-9_]*.*/\1/p' "$f" | sort -u)"
    dirty_var="$(echo "$dirty_vars" | head -1)"
    # The COMMIT half must be pinned with the snapshot too (Codex #1495 r3
    # P2). Pairing an early dirty reading with a late `rev-parse` lets a
    # commit landing in between attribute output to a commit that did not
    # produce it — and that half went unchecked for a whole round because the
    # guard only knew about the dirty half.
    commit_var="$(echo "$commit_vars" | head -1)"
    # Any emission whose variables are NOT the ones validated below is an
    # unvalidated second stamp; reject rather than silently ignore it.
    extra_pairs=0
    for v in $dirty_vars; do [ "$v" = "$dirty_var" ] || extra_pairs=1; done
    for v in $commit_vars; do [ "$v" = "$commit_var" ] || extra_pairs=1; done
    # Anchor on the ACTUAL git state read, not the empty initializer (Codex
    # #1495 r2 P2). Anchoring on `TREE_DIRTY_AT_START=""` meant an edit that
    # left the initializer early while moving the `git diff` conditional after
    # the first write still passed — the same mistake as the guard this
    # replaced, which anchored on a grep for prose instead of the command.
    # `TREE_DIRTY_AT_START=" (dirty)"` sits INSIDE that conditional, so it
    # moves with it.
    snap_line="$(grep -n '^[[:space:]]*TREE_DIRTY_AT_START=" (dirty)"' "$f" | head -1 | cut -d: -f1)"
    snap_init="$(grep -c '^TREE_DIRTY_AT_START=""' "$f" || true)"
    # ANY reset to empty, at any indentation, anywhere (Codex #1495 r5 P2).
    # Counting only the column-zero initializer let a later
    # `if true; then TREE_DIRTY_AT_START=""; fi` clear a dirty run while every
    # other predicate stayed green — a dirty tree stamped clean, the precise
    # outcome this guard exists to prevent.
    # Count EVERY assignment-to-empty anywhere in the file and require exactly
    # one — the column-zero initializer. Anything else is a reset. A first
    # attempt enumerated the shapes a reset might take (leading whitespace, or
    # after a `;`) and missed `if true; then TREE_DIRTY_AT_START=""; fi`
    # entirely, which is why this counts rather than pattern-matches: an
    # enumeration of bad forms is only ever as good as the imagination behind
    # it, whereas "exactly one, in the right place" has no gaps.
    snap_empty_total="$(grep -cF 'TREE_DIRTY_AT_START=""' "$f" || true)"
    # The COMMIT snapshot needs the same placement check as the dirty one
    # (Codex #1495 r6 P2): verifying that the stamp derives from
    # TREE_COMMIT_AT_START says nothing about WHERE that variable is
    # populated, so moving its assignment late restored the very late-read
    # this check exists to forbid.
    commit_snap_line="$(grep -n '^TREE_COMMIT_AT_START=' "$f" | head -1 | cut -d: -f1)"
    commit_snap_total="$(grep -oE '(^|[;[:space:]])TREE_COMMIT_AT_START=' "$f" | wc -l | tr -d ' ')"
    first_write="$(grep -nE 'forge inspect|python3 - |jq |cat > "\$' "$f" \
      | grep -v '^[0-9]*:#' | head -1 | cut -d: -f1)"
    if [ "$extra_pairs" -ne 0 ]; then
      echo "  ✗ $s — emits more than one provenance stamp with DIFFERENT variables; every emission must use the validated pair (#1490)" >&2
      FAIL=1
      continue
    fi
    if [ -z "$dirty_var" ]; then
      echo "  ✗ $s — cannot identify the stamp's dirty variable (#1490)" >&2
      FAIL=1
      continue
    fi
    # Every assignment of that variable, anywhere in the file.
    # Counted anywhere on the LINE, not just at line start (Codex #1495 r6 P2).
    # A line-anchored count missed `if true; then DIRTY=""; fi`, so an inline
    # reset forced the stamp clean with every predicate green. Same defect I
    # had already fixed for the snapshot variable and not for these two —
    # fixing one instance of a class and leaving its siblings, again.
    assigns="$(grep -oE "(^|[;[:space:]])${dirty_var}=" "$f" | wc -l | tr -d ' ')"
    commit_from_snap="$(grep -cE "^[[:space:]]*${commit_var}=\"\\\$TREE_COMMIT_AT_START\"" "$f" || true)"
    # TOTAL assignments too, symmetric with the dirty variable (Codex #1495 r4
    # P2). Checking only "is assigned from the snapshot once" let a LATE
    # reassignment from `rev-parse` sit alongside it and pass — the same
    # half-a-property blind spot that let the commit half through in r3.
    commit_assigns="$(grep -oE "(^|[;[:space:]])${commit_var}=" "$f" | wc -l | tr -d ' ')"
    from_snap="$(grep -cE "^[[:space:]]*${dirty_var}=\"\\\$TREE_DIRTY_AT_START\"" "$f" || true)"
    if [ -z "$snap_line" ] || [ "$snap_init" -ne 1 ] || [ "$snap_empty_total" -ne 1 ]; then
      echo "  ✗ $s — stamps monorepoCommit but has no TREE_DIRTY_AT_START snapshot (#1490)" >&2
      FAIL=1
    elif [ "$assigns" -ne 1 ] || [ "$from_snap" -ne 1 ]; then
      echo "  ✗ $s — \$$dirty_var must be assigned exactly once, from the snapshot (found $assigns assignment(s), $from_snap from snapshot) (#1490)" >&2
      FAIL=1
    elif [ -z "$commit_snap_line" ] || [ "$commit_snap_total" -ne 1 ] \
         || { [ -n "$first_write" ] && [ "$commit_snap_line" -gt "$first_write" ]; }; then
      echo "  ✗ $s — TREE_COMMIT_AT_START must be assigned exactly once, before the first write (#1490)" >&2
      FAIL=1
    elif [ "$commit_from_snap" -ne 1 ] || [ "$commit_assigns" -ne 1 ]; then
      echo "  ✗ $s — \$$commit_var must be pinned from \$TREE_COMMIT_AT_START, not re-read at stamp time (#1490)" >&2
      FAIL=1
    elif [ -n "$first_write" ] && [ "$snap_line" -gt "$first_write" ]; then
      echo "  ✗ $s — the git state read at line $snap_line comes AFTER the first write at line $first_write (#1490)" >&2
      FAIL=1
    else
      echo "  ✓ $s — stamp derives from a snapshot taken before the first write"
    fi
  done
fi

# 3d. Stale LayerZero deploy-residue guard. T-068 Phase 6.4 stripped the
#     old LZ deploy variables when the cross-chain layer moved to CCIP.
#     `lzEid` / `LayerZero` are deliberately NOT banned — the LZ endpoint
#     id is still recorded as inert chain metadata in addresses.json.
LZ_RESIDUE='BASE_EID|LOCAL_EID|RewardOApp|OFTAdapter'
for s in "${DEPLOY_SH[@]}"; do
  if grep -nE "$LZ_RESIDUE" "$SCRIPT_DIR/$s" >/dev/null 2>&1; then
    echo "  ✗ $s — stale LayerZero deploy residue (removed in T-068" >&2
    echo "    Phase 6.4 — the CCIP migration):" >&2
    grep -nE "$LZ_RESIDUE" "$SCRIPT_DIR/$s" | sed 's/^/      /' >&2
    FAIL=1
  else
    echo "  ✓ $s — no stale LayerZero deploy residue"
  fi
done

# ── 4. ABI-export-in-sync ─────────────────────────────────────────────
echo
echo "[predeploy 4/4] committed ABIs match the compiled contracts"
if ! command -v jq >/dev/null 2>&1; then
  echo "  ✗ jq not installed — required to compare ABIs" >&2
  FAIL=1
else
  # Compare one committed per-facet ABI JSON against `forge inspect`.
  # A non-facet JSON (no resolvable contract) is skipped.
  #
  # `hard` arg: 1 = drift fails the gate (frontend ABIs ship inside this
  # monorepo, so a contract deploy must not outrun them); 0 = drift is
  # advisory only (the keeper bot is a separately-deployed sibling repo —
  # its ABIs are re-synced and redeployed on their own cadence, so a
  # contract deploy must not be hard-blocked on that repo's state, but
  # the operator is still told to re-sync it).
  check_abi_dir() {
    local label="$1" dir="$2" hard="$3" export_script="$4" drift=0 checked=0
    if [ ! -d "$dir" ]; then
      echo "  · $label — $dir not present, skipping"
      return 0
    fi
    local f name fresh
    for f in "$dir"/*.json; do
      [ -e "$f" ] || continue
      name="$(basename "$f" .json)"
      # Allowlisted non-contract metadata files — intentionally not ABIs.
      case "$name" in _source|deployments) continue ;; esac
      if ! fresh="$(forge inspect "$name" abi --json 2>/dev/null)"; then
        # No resolvable contract for this JSON. For a hard dir that is a
        # failure — a facet renamed/removed but its committed ABI left
        # behind would otherwise ship stale selectors while the gate
        # stayed green. For an advisory dir, skip quietly.
        if [ "$hard" -eq 1 ]; then
          echo "  ✗ $label — $name.json has no resolvable contract" >&2
          echo "    (facet renamed/removed? delete the stale JSON, or" >&2
          echo "    allowlist it in predeploy-check.sh)" >&2
          drift=$((drift + 1))
        fi
        continue
      fi
      # Compare the COMMITTED content (git HEAD) against `forge inspect`,
      # not the working-tree file. The deploy's consumers receive the
      # committed/published package, not the local working tree — a
      # regenerated-but-uncommitted JSON would otherwise read in-sync
      # here while the committed state is still stale.
      local rel
      rel="$(git -C "$dir" ls-files --full-name -- "$name.json" 2>/dev/null)"
      if [ -z "$rel" ]; then
        # Untracked — reported by the FACETS cross-check below as
        # "present but UNTRACKED". Skip the content compare (no committed
        # content to read).
        continue
      fi
      checked=$((checked + 1))
      if ! diff -q \
        <(git -C "$dir" show "HEAD:$rel" 2>/dev/null | jq -S . 2>/dev/null) \
        <(printf '%s' "$fresh" | jq -S . 2>/dev/null) >/dev/null 2>&1; then
        if [ "$hard" -eq 1 ]; then
          echo "  ✗ $label — committed $name.json is stale vs the compiled ABI" >&2
        else
          echo "  ⚠ $label — committed $name.json is stale vs the compiled ABI" >&2
        fi
        drift=$((drift + 1))
      fi
    done
    # Cross-check the directory against the export script's `FACETS=(...)`
    # list — catch a required ABI that is missing OR present-but-untracked.
    # The loop above only sees files that exist, so a missing one would
    # otherwise pass silently; and consumers receive the committed /
    # published package state, not the local working tree, so a
    # generated-but-uncommitted JSON must not pass either — require the
    # file to be git-tracked.
    if [ -n "$export_script" ] && [ -f "$export_script" ]; then
      local expected why
      for expected in $(sed -n '/FACETS=(/,/^)/p' "$export_script" \
                          | grep -oE '"[A-Za-z0-9_]+"' | tr -d '"'); do
        git -C "$dir" ls-files --error-unmatch -- "$expected.json" \
          >/dev/null 2>&1 && continue
        if [ -f "$dir/$expected.json" ]; then
          why="present but UNTRACKED (not committed)"
        else
          why="MISSING"
        fi
        if [ "$hard" -eq 1 ]; then
          echo "  ✗ $label — required ABI $expected.json is $why" >&2
        else
          echo "  ⚠ $label — required ABI $expected.json is $why" >&2
        fi
        drift=$((drift + 1))
      done
    fi
    if [ "$drift" -eq 0 ]; then
      echo "  ✓ $label — $checked facet ABI(s) in sync"
    elif [ "$hard" -eq 1 ]; then
      echo "    re-run exportFrontendAbis.sh and commit the result" >&2
      FAIL=1
    else
      echo "    advisory — re-sync the keeper-bot repo (exportAbis.sh)" >&2
      echo "    before the keeper bot is redeployed; not a" >&2
      echo "    contract-deploy blocker." >&2
    fi
  }
  check_abi_dir "frontend ABIs" \
    "$REPO_ROOT/packages/contracts/src/abis" 1 \
    "$SCRIPT_DIR/exportFrontendAbis.sh"
  check_abi_dir "keeper-bot ABIs" \
    "$REPO_ROOT/../vaipakam-keeper-bot/src/abis" 0 \
    "$SCRIPT_DIR/exportAbis.sh"
fi

# ── [4b] deployments.json facet-key drift (#1356) ────────────────────
# Every facet key a deploy script writes into addresses.json
# (`Deployments.writeFacet("<key>", ...)`) must exist as a typed field on
# the TS `Deployment` type — an untyped key is invisible to every consumer
# of `@vaipakam/contracts/deployments` (frontend + the three Workers), so
# the deploy would record an address nobody can read. Hard failure.
# The reverse direction (typed keys no script writes) is advisory: some
# fields are written by chain-specific tooling outside script/*.s.sol.
echo
echo "[predeploy 4b] deploy-script facet keys match the TS Deployment type"
DEPLOYMENTS_TS="$REPO_ROOT/packages/contracts/src/deployments.ts"
if [ ! -f "$DEPLOYMENTS_TS" ]; then
  echo "  · $DEPLOYMENTS_TS not present, skipping"
else
  # Two call shapes write facet keys: literal `writeFacet("<key>", ...)`
  # AND the in-place refresh path's `Item("<key>", ...)` entries, whose
  # keys reach writeFacet through a variable (`items[i].key`) — harvesting
  # only the literal writeFacet calls would let a typo'd refresh key bypass
  # the hard gate entirely (Codex #1411 r1).
  # Newline-tolerant (Codex #1411 r2): several refresh entries wrap the
  # key onto the line after `Item(`, so the sources are flattened before
  # matching — a single-line grep silently omitted those keys.
  WRITTEN_KEYS="$(cat "$SCRIPT_DIR"/*.s.sol | tr '\n' ' ' \
    | grep -oE '(writeFacet|Item)\(\s*"[A-Za-z0-9]+"' \
    | sed -E 's/.*"([A-Za-z0-9]+)".*/\1/' | sort -u)"
  TYPED_KEYS="$(grep -oE '^[[:space:]]+[A-Za-z0-9]+Facet\?' "$DEPLOYMENTS_TS" \
    | sed -E 's/[[:space:]]+//; s/\?//' | sort -u)"
  MISSING="$(comm -23 <(printf '%s\n' "$WRITTEN_KEYS") <(printf '%s\n' "$TYPED_KEYS") || true)"
  if [ -n "$MISSING" ]; then
    echo "  ✗ facet keys written by deploy scripts but MISSING from the TS type:" >&2
    printf '      %s\n' $MISSING >&2
    echo "    add them to packages/contracts/src/deployments.ts (Deployment type)" >&2
    FAIL=1
  else
    echo "  ✓ every written facet key is typed on Deployment"
  fi
  UNWRITTEN="$(comm -13 <(printf '%s\n' "$WRITTEN_KEYS") <(printf '%s\n' "$TYPED_KEYS") || true)"
  if [ -n "$UNWRITTEN" ]; then
    echo "  · advisory — typed facet keys no script/*.s.sol writes:"
    printf '      %s\n' $UNWRITTEN
  fi
fi

# ── Verdict ───────────────────────────────────────────────────────────
echo
if [ "$FAIL" -ne 0 ]; then
  echo "✗ pre-deploy sanity check FAILED — do not deploy until the" >&2
  echo "  problems above are resolved." >&2
  exit 1
fi
echo "✓ pre-deploy sanity check passed — safe to proceed with the deploy."
