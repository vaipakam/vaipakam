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

# ── Verdict ───────────────────────────────────────────────────────────
echo
if [ "$FAIL" -ne 0 ]; then
  echo "✗ pre-deploy sanity check FAILED — do not deploy until the" >&2
  echo "  problems above are resolved." >&2
  exit 1
fi
echo "✓ pre-deploy sanity check passed — safe to proceed with the deploy."
