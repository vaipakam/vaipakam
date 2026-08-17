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
#        • with `--full`      — the entire regression suite, by DELEGATING
#            to `run-regression.sh` (chunked `--match-path` invocations +
#            an exhaustiveness guard, so no compile unit trips the viaIR
#            stack ceiling and no suite can be silently skipped).
#            Invariants excluded — run those separately; they are slow.
#            Use for a mainnet preflight: do not deploy contracts whose
#            tests are red. `deploy-mainnet.sh` passes `--full`, as does
#            the release-track `mainnet-gate.yml` workflow.
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
#   bash script/predeploy-check.sh --full     # + full (chunked) regression
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
  # DELEGATED to `run-regression.sh` — deliberately NOT a second copy of the
  # regression command (#1620). This branch used to run its own single
  # `forge test --match-path 'test/*.t.sol'` pass. That sparse-compile form
  # was correct when written, but `run-regression.sh` has since recorded
  # that ordinary feature growth (#591) re-crossed the viaIR whole-unit
  # stack ceiling for even that single pass — which is why that script
  # moved to CHUNKED `--match-path` invocations. This branch never followed,
  # so the mainnet preflight (and `mainnet-gate.yml`, which runs this same
  # `--full` path on the release track) was running the form its sibling
  # script documents as outgrown. A ceiling trip here is a COMPILE failure,
  # and it sets the same FAIL=1 as a red test — so it would read as
  # "regression failed, do not deploy" while having tested nothing.
  #
  # One chunking implementation, one exhaustiveness guard, one place to fix
  # when the ceiling moves again. Invariants stay excluded (they are slow —
  # 100 runs — and run as their own pass); plain `run-regression.sh` without
  # `--invariants` is exactly that scope, so the gate's semantics are
  # unchanged. It forces FOUNDRY_PROFILE=default itself.
  if bash "$SCRIPT_DIR/run-regression.sh"; then
    echo "  ✓ full regression passes"
  else
    echo "  ✗ regression failed — do not deploy red contracts" >&2
    FAIL=1
  fi
else
  echo "[predeploy 2/4] deploy-sanity forge suite (test/deploy/*)"
  # `-vv` so PASSING tests print their logs. `FacetSizeLimitTest`'s headroom
  # report (#1780) always passes by design — it reports facets running out of
  # EIP-170 room rather than failing them — and Foundry hides logs from passing
  # tests below `-vv`. Without this the report is invisible in exactly the
  # green run it exists to inform, which is the whole point of it.
  if forge test --match-path "test/deploy/*" -vv; then
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
    # Count emissions BEFORE parsing pairs (Codex #1495 r8 P2): an emission
    # that drops its dirty interpolation matches neither regex, so it vanished
    # from both sets and the remaining valid stamp kept everything looking
    # green. A stamp with no dirty half is exactly the regression worth
    # catching, and it was the one shape that could hide from the checker.
    emissions="$(grep -cE 'monorepoCommit"?:? "?\$' "$f" || true)"
    pairs="$(grep -cE 'monorepoCommit"?:? "?\$[A-Za-z_][A-Za-z0-9_]*\$[A-Za-z_]' "$f" || true)"
    extra_pairs=0
    [ "$emissions" -eq "$pairs" ] || extra_pairs=1
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
#     old LZ deploy variables when the cross-chain layer moved to CCIP,
#     and the follow-up sweep removed the last of it: the eid resolver and
#     its `lzEid` artifact stamp, the dead `.env.example` blocks for
#     deleted scripts, and the LZ inherited-event allowlist.
#
#     `lzEid` IS now banned — it used to be tolerated as "inert chain
#     metadata", but nothing read it, the typed deployment loader already
#     documented it as gone, and an artifact key naming a retired
#     transport is exactly the kind of thing that gets copied forward.
#     `LayerZero` in prose is still allowed: the migration comments that
#     explain why a thing is shaped the way it is are worth keeping.
#
#     `.env.example` is scanned too. It is not a deploy script, but it is
#     what an operator copies, and it was the worst offender — it shipped
#     LZ_ENDPOINT_* and a whole fixed-rate-buy block for deleted scripts
#     while omitting every CCIP_* variable the current deploy requires.
#     The scanned SET matters as much as the pattern. `lzEid` /
#     `lzEidForChain` can only come back from the artifact writer, the
#     deploy script that calls it, or a committed artifact — none of
#     which are shell wrappers. Scanning only the wrappers would have
#     made those two patterns decorative: they would never have matched
#     anything, and the guard would have reported success for a residue
#     it structurally could not see. So the writer, `DeployDiamond`, the
#     per-chain artifacts and the consolidated bundle are all in scope.
LZ_RESIDUE='BASE_EID|LOCAL_EID|RewardOApp|OFTAdapter|LZ_ENDPOINT|REMOTE_EID|LOCAL_OAPP|lzEid|lzEidForChain|VPFI_BUY_RECEIVER_EID|WireVPFIPeers'
LZ_SCAN=(
  "${DEPLOY_SH[@]}"
  "../.env.example"
  "lib/Deployments.sol"
  "DeployDiamond.s.sol"
)
# Committed deployment artifacts + the bundle every consumer imports.
while IFS= read -r _f; do
  LZ_SCAN+=("${_f#"$SCRIPT_DIR/"}")
done < <(ls "$SCRIPT_DIR"/../deployments/*/addresses.json 2>/dev/null)
LZ_SCAN+=("../../packages/contracts/src/deployments.json")

# Comment lines are exempt: a note saying "this variable is gone, do not
# carry it forward" must be allowed to name the thing it retires. The
# comment syntax is per-language — the scan set spans shell, Solidity and
# JSON. Getting this wrong in the strict direction is the dangerous one:
# a Solidity migration note like `// lzEid was removed` would fail every
# preflight, and the fix a hurried operator reaches for is deleting the
# note rather than the residue.
#
# JSON has no comment syntax, so its filter is the shell one (matching
# nothing) — correct by construction: a key in an artifact is never a
# comment.
_lz_hits() {
  case "$1" in
    *.sol) grep -nE "$LZ_RESIDUE" "$1" | grep -vE '^[0-9]+:[[:space:]]*(//|/\*|\*)' ;;
    *)     grep -nE "$LZ_RESIDUE" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' ;;
  esac
}
for s in "${LZ_SCAN[@]}"; do
  [ -f "$SCRIPT_DIR/$s" ] || continue
  if _lz_hits "$SCRIPT_DIR/$s" >/dev/null 2>&1; then
    echo "  ✗ $s — stale LayerZero deploy residue (removed in T-068" >&2
    echo "    Phase 6.4 — the CCIP migration):" >&2
    _lz_hits "$SCRIPT_DIR/$s" | sed 's/^/      /' >&2
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

# ── [4c] facet registry parity (#1793) ───────────────────────────────
# Two checks the Solidity deploy-sanity suite structurally CANNOT do, so
# they live here where both script sources are readable as text:
#
#   1. cut ⇒ writeFacet. Step [4b] validates that every key a script
#      WRITES is typed on `Deployment`; it is blind to a key never written
#      at all, so it reports success for a facet missing from the artifact.
#      That is how thirteen cut facets came to be absent (#1793).
#   2. Refresh key identity. `RefreshScriptFacetParityTest` proves the
#      in-place refresh cuts the same selectors, from the same runtime
#      code, as a real deploy — but says nothing about the artifact KEY
#      each item carries. A typo'd or swapped key passes every assertion
#      there and then mislabels the artifact.
#
# Both pair the two scripts WITHOUT any name-casing heuristic, which is
# what makes them sound: `_buildCut(address(v), _getXSelectors())` and
# `writeFacet("k", address(v))` share the facet VARIABLE, and both scripts
# name the same `_get<X>Selectors()` getter. Bridging contract names to
# camelCase keys instead would break on acronym-initial names like
# `VPFITokenFacet` — a naming heuristic inside a drift guard is just a new
# drift surface.
echo
echo "[predeploy 4c] facet registry parity (cut ⇒ writeFacet, refresh key identity)"
DEPLOY_SOL="$SCRIPT_DIR/DeployDiamond.s.sol"
REFRESH_SOL="$SCRIPT_DIR/RefreshAllFacetsInPlace.s.sol"
if [ ! -f "$DEPLOY_SOL" ] || [ ! -f "$REFRESH_SOL" ]; then
  echo "  · deploy or refresh script not present, skipping"
else
  # Comments stripped, THEN flattened. Both steps are load-bearing:
  #
  #   · flattened, because both scripts wrap these calls across lines and a
  #     single-line grep silently omits those (the trap [4b] hit).
  #   · comments stripped, because otherwise a write disabled the natural way —
  #     `// Deployments.writeFacet("backstopFacet", ...)` — still counts as a
  #     write and check 1 passes on a facet that is no longer recorded. The
  #     mirror image is worse in the other direction: a `_buildCut(...)` inside
  #     an explanatory comment invents a facet that must be written. Stripping
  #     must come FIRST, since flattening destroys the line ends that terminate
  #     `//` comments.
  #
  # Awk state machine rather than perl/python, to add no dependency. It does not
  # model string literals, which is safe here: no key or import path in either
  # script contains `//` or `/*`.
  strip_sol_comments() {
    awk '
      BEGIN { inblk = 0 }
      {
        line = $0; out = ""; i = 1
        while (i <= length(line)) {
          two = substr(line, i, 2)
          if (inblk) { if (two == "*/") { inblk = 0; i += 2 } else { i++ }; continue }
          if (two == "/*") { inblk = 1; i += 2; continue }
          if (two == "//") { break }
          out = out substr(line, i, 1); i++
        }
        print out
      }
    ' "$1" | tr '\n' ' '
  }
  DEPLOY_FLAT="$(strip_sol_comments "$DEPLOY_SOL")"
  REFRESH_FLAT="$(strip_sol_comments "$REFRESH_SOL")"

  CUT_GETTER_VAR="$(printf '%s' "$DEPLOY_FLAT" \
    | grep -oE '_buildCut[[:space:]]*\([[:space:]]*address[[:space:]]*\([A-Za-z0-9_]+\)[[:space:]]*,[[:space:]]*_get[A-Za-z0-9]+Selectors[[:space:]]*\(\)' \
    | sed -E 's/.*address[[:space:]]*\(([A-Za-z0-9_]+)\)[[:space:]]*,[[:space:]]*(_get[A-Za-z0-9]+Selectors)[[:space:]]*\(\)/\2 \1/' \
    | sort -u)"
  WROTE_VAR_KEY="$(printf '%s' "$DEPLOY_FLAT" \
    | grep -oE 'writeFacet[[:space:]]*\([[:space:]]*"[A-Za-z0-9]+"[[:space:]]*,[[:space:]]*address[[:space:]]*\([A-Za-z0-9_]+\)' \
    | sed -E 's/.*"([A-Za-z0-9]+)"[[:space:]]*,[[:space:]]*address[[:space:]]*\(([A-Za-z0-9_]+)\)/\2 \1/' \
    | sort -u)"
  REFRESH_GETTER_KEY="$(printf '%s' "$REFRESH_FLAT" \
    | grep -oE 'Item[[:space:]]*\([[:space:]]*"[A-Za-z0-9]+"[[:space:]]*,[[:space:]]*address[[:space:]]*\([[:space:]]*new[[:space:]]+[A-Za-z0-9_]+[[:space:]]*\([[:space:]]*\)[[:space:]]*\)[[:space:]]*,[[:space:]]*_get[A-Za-z0-9]+Selectors[[:space:]]*\(\)' \
    | sed -E 's/Item[[:space:]]*\([[:space:]]*"([A-Za-z0-9]+)".*[[:space:]](_get[A-Za-z0-9]+Selectors)[[:space:]]*\(\)/\2 \1/' \
    | sort -u)"

  # EXACT coverage of what is there, not a floor (Codex #1798 r1 P1).
  #
  # A minimum-count guard only catches a refactor that breaks EVERY call shape.
  # One registration that stops matching — a key with a character the pattern
  # rejects, `Item("backstop-Facet", ...)` — drops silently out of the harvest,
  # stays far above any floor, and is then absent from every comparison below, so
  # the gate passes while that facet is written under no key at all. Same defect
  # as a vacuity guard that is per-run rather than per-item.
  #
  # So each construct is COUNTED in the source and the count must equal the number
  # of pairs parsed from it. Unparsed occurrences are the failure. No hand-kept
  # totals: both sides are derived, so adding a facet needs no edit here.
  # A helper's own DEFINITION is not a call site: `function _buildCut(` matches
  # the same text as its 73 invocations, which is why this counted 74. Definitions
  # are subtracted rather than the pattern being narrowed, so the count stays
  # correct however the call sites are written.
  count_calls() { # <flattened source> <name>
    _all=$(printf '%s' "$1" | grep -oE "[^A-Za-z0-9_]$2[[:space:]]*\(" | grep -c . || true)
    _def=$(printf '%s' "$1" | grep -oE "function[[:space:]]+$2[[:space:]]*\(" | grep -c . || true)
    echo $((_all - _def))
  }
  N_CUT_CALLS=$(count_calls "$DEPLOY_FLAT" '_buildCut')
  N_WRITE_CALLS=$(count_calls "$DEPLOY_FLAT" 'writeFacet')
  N_ITEM_CALLS=$(count_calls "$REFRESH_FLAT" 'Item')
  N_CUT_PAIRS=$(printf '%s\n' "$CUT_GETTER_VAR" | grep -c . || true)
  N_WRITE_PAIRS=$(printf '%s\n' "$WROTE_VAR_KEY" | grep -c . || true)
  N_ITEM_PAIRS=$(printf '%s\n' "$REFRESH_GETTER_KEY" | grep -c . || true)
  UNPARSED=""
  [ "$N_CUT_PAIRS" -eq "$N_CUT_CALLS" ] || UNPARSED="$UNPARSED
    _buildCut: $N_CUT_CALLS call(s) in DeployDiamond.s.sol, $N_CUT_PAIRS parsed"
  [ "$N_WRITE_PAIRS" -eq "$N_WRITE_CALLS" ] || UNPARSED="$UNPARSED
    writeFacet: $N_WRITE_CALLS call(s) in DeployDiamond.s.sol, $N_WRITE_PAIRS parsed"
  [ "$N_ITEM_PAIRS" -eq "$N_ITEM_CALLS" ] || UNPARSED="$UNPARSED
    Item: $N_ITEM_CALLS call(s) in RefreshAllFacetsInPlace.s.sol, $N_ITEM_PAIRS parsed"
  if [ -n "$UNPARSED" ]; then
    echo "  ✗ some facet registrations could not be parsed, so they would be" >&2
    echo "    invisible to the comparisons below:$UNPARSED" >&2
    echo "    Every call must match the expected shape. Fix the registration (or this" >&2
    echo "    check if a shape legitimately changed) — do not let one drop out." >&2
    FAIL=1
  elif [ "$N_CUT_PAIRS" -lt 50 ] || [ "$N_WRITE_PAIRS" -lt 50 ] || [ "$N_ITEM_PAIRS" -lt 50 ]; then
    # Backstop for the case the counts agree because BOTH sides went to zero.
    echo "  ✗ harvested implausibly few facet registrations — a call shape this" >&2
    echo "    check greps for has probably changed. Fix this check; do not delete it." >&2
    FAIL=1
  else
    # 1. every cut facet is recorded in the artifact
    UNRECORDED="$(comm -23 \
      <(printf '%s\n' "$CUT_GETTER_VAR" | awk '{print $2}' | sort -u) \
      <(printf '%s\n' "$WROTE_VAR_KEY"  | awk '{print $1}' | sort -u) || true)"
    if [ -n "$UNRECORDED" ]; then
      echo "  ✗ facets CUT into the Diamond but never written to addresses.json:" >&2
      printf '      %s\n' $UNRECORDED >&2
      echo "    add a Deployments.writeFacet(\"<key>\", address(<var>)) for each in" >&2
      echo "    DeployDiamond.s.sol — step [4b] cannot see a key that is never written." >&2
      FAIL=1
    else
      echo "  ✓ every cut facet is written to the deployment artifact"
    fi

    # 2. variable ↔ key must be ONE-TO-ONE before anything is built on it
    #    (Codex #1798 r1 P1). The awk map below keys on the variable, so two
    #    writes for one variable silently collapse to whichever key sorts last.
    #    The dangerous direction is the other one: two writes sharing a KEY —
    #    `writeFacet("aggregatorAdapterFactoryFacet", address(backstopFacet))`
    #    next to the correct aggregator write — leave both comparisons below
    #    empty while, at deploy time, the second write overwrites the first key's
    #    address with the wrong facet. The artifact is then confidently wrong,
    #    which is worse than the missing keys this step was written to catch.
    DUP_VARS="$(printf '%s\n' "$WROTE_VAR_KEY" | awk 'NF{print $1}' | sort | uniq -d || true)"
    DUP_KEYS="$(printf '%s\n' "$WROTE_VAR_KEY" | awk 'NF{print $2}' | sort | uniq -d || true)"
    if [ -n "$DUP_VARS" ] || [ -n "$DUP_KEYS" ]; then
      echo "  ✗ writeFacet registrations are not one-to-one:" >&2
      [ -z "$DUP_VARS" ] || { echo "      facet variable(s) written under more than one key:" >&2
                              printf '        %s\n' $DUP_VARS >&2; }
      [ -z "$DUP_KEYS" ] || { echo "      key(s) written from more than one facet variable —" >&2
                              echo "      the later write OVERWRITES the earlier address:" >&2
                              printf '        %s\n' $DUP_KEYS >&2; }
      FAIL=1
    fi

    # 3. the refresh script labels each facet with the deploy's own key
    DEPLOY_GETTER_KEY="$(awk 'NR==FNR{k[$1]=$2;next} ($2 in k){print $1, k[$2]}' \
      <(printf '%s\n' "$WROTE_VAR_KEY") <(printf '%s\n' "$CUT_GETTER_VAR") | sort -u)"
    KEY_DRIFT="$(awk 'NR==FNR{d[$1]=$2;next} ($1 in d) && d[$1]!=$2 {print $1" deploy="d[$1]" refresh="$2}' \
      <(printf '%s\n' "$DEPLOY_GETTER_KEY") <(printf '%s\n' "$REFRESH_GETTER_KEY") || true)"
    if [ -n "$KEY_DRIFT" ]; then
      echo "  ✗ refresh-script facet keys disagree with the deploy script's:" >&2
      printf '      %s\n' "$KEY_DRIFT" >&2
      echo "    the refresh writes its key through items[i].key, so a mismatch" >&2
      echo "    relabels the artifact and consumers report a live facet missing." >&2
      FAIL=1
    else
      echo "  ✓ refresh-script facet keys match the deploy script's"
    fi
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
