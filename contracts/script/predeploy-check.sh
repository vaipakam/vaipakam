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
#      current `forge inspect <Facet> abi`. A stale committed ABI ships
#      consumers that mis-decode the deployed contract. Frontend ABIs
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
echo "[predeploy 1/4] forge build"
if forge build; then
  echo "  ✓ contracts compile"
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
  if forge test --no-match-path "test/invariants/*"; then
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
    local label="$1" dir="$2" hard="$3" drift=0 checked=0
    if [ ! -d "$dir" ]; then
      echo "  · $label — $dir not present, skipping"
      return 0
    fi
    local f name fresh
    for f in "$dir"/*.json; do
      [ -e "$f" ] || continue
      name="$(basename "$f" .json)"
      case "$name" in _source|deployments) continue ;; esac
      fresh="$(forge inspect "$name" abi --json 2>/dev/null)" || continue
      checked=$((checked + 1))
      if ! diff -q \
        <(jq -S . "$f" 2>/dev/null) \
        <(printf '%s' "$fresh" | jq -S . 2>/dev/null) >/dev/null 2>&1; then
        if [ "$hard" -eq 1 ]; then
          echo "  ✗ $label — $name.json is stale vs the compiled ABI" >&2
        else
          echo "  ⚠ $label — $name.json is stale vs the compiled ABI" >&2
        fi
        drift=$((drift + 1))
      fi
    done
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
    "$REPO_ROOT/packages/contracts/src/abis" 1
  check_abi_dir "keeper-bot ABIs" \
    "$REPO_ROOT/../vaipakam-keeper-bot/src/abis" 0
fi

# ── Verdict ───────────────────────────────────────────────────────────
echo
if [ "$FAIL" -ne 0 ]; then
  echo "✗ pre-deploy sanity check FAILED — do not deploy until the" >&2
  echo "  problems above are resolved." >&2
  exit 1
fi
echo "✓ pre-deploy sanity check passed — safe to proceed with the deploy."
