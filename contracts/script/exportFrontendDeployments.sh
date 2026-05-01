#!/usr/bin/env bash
#
# exportFrontendDeployments.sh — multi-target deployment-artifact sync.
#
# Despite the historical name, this script writes the consolidated
# `deployments.json` to BOTH the frontend AND the hf-watcher Worker
# when both directories are present. They consume the same merged
# shape — every per-chain `contracts/deployments/<chain-slug>/addresses.json`
# folded into a single object keyed by `chainId`. Companion to
# `exportFrontendAbis.sh`: that script syncs per-facet *interfaces*
# (function selectors, struct shapes); this one syncs the per-chain
# *deployed addresses* needed to talk to those interfaces.
#
# Why one script for two consumers:
#   - The merge step is identical for both. Duplicating it across two
#     scripts means a divergent fix later. One source-of-truth merge,
#     two writes.
#   - Operators run a single command after every redeploy; the script
#     auto-detects which targets to write to based on which sibling
#     directories exist.
#
# Targets:
#   - **Frontend** (always required): `<FRONTEND_DIR>/src/contracts/deployments.json`
#     plus a `_deployments_source.json` provenance stamp.
#   - **hf-watcher** (optional, written when present):
#     `<WATCHER_DIR>/src/deployments.json`. The Worker's tsconfig has
#     `resolveJsonModule: true` so this imports natively.
#
# Why a consolidated single file (not per-chain imports):
#   - One JSON import per consumer, one typed lookup, one provenance stamp.
#   - Chain IDs are guaranteed unique by EIP-155 so the top-level key
#     is a stable index. A redeploy on chain N rewrites only that
#     chain's stanza in the merged output.
#   - The contracts side keeps its per-chain directory layout — every
#     deploy script writes to its own `<chain-slug>/addresses.json` so
#     parallel deploys to different chains never conflict. This export
#     step is the merge boundary.
#
# Usage:
#   bash contracts/script/exportFrontendDeployments.sh
#       # auto-detects FRONTEND_DIR=../frontend, WATCHER_DIR=../ops/hf-watcher
#
#   FRONTEND_DIR=/abs/path WATCHER_DIR=/abs/path \
#     bash contracts/script/exportFrontendDeployments.sh
#
#   # Skip the watcher target explicitly:
#   WATCHER_DIR= bash contracts/script/exportFrontendDeployments.sh
#
# When to run:
#   - After every contract deploy / redeploy on any chain.
#   - When a new `contracts/deployments/<chain>/` directory appears.
#   - Alongside `exportFrontendAbis.sh` if facet selectors also changed.
#
# What it does NOT do:
#   - Doesn't commit anything. Review with
#     `git diff frontend/src/contracts/ ops/hf-watcher/src/`
#     and commit alongside the deploy artifacts.
#   - Doesn't run any deploy script. It only reads what the deploy
#     scripts already wrote.
#   - Doesn't synthesize zero-address sentinels for missing fields.
#     A chain's stanza only carries the keys present in its
#     `addresses.json` — consumers narrow on the
#     `isCanonicalVPFI` / `isCanonicalReward` discriminators.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-$CONTRACTS_DIR/../frontend}"

# Watcher target is optional. Auto-detected from the sibling layout
# at `vaipakam/ops/hf-watcher`. Pass `WATCHER_DIR=` (empty) to skip
# explicitly; pass an absolute path to override.
if [ -z "${WATCHER_DIR+set}" ]; then
  # WATCHER_DIR unset — auto-detect.
  CANDIDATE="$CONTRACTS_DIR/../ops/hf-watcher"
  if [ -d "$CANDIDATE" ]; then
    WATCHER_DIR="$(cd "$CANDIDATE" && pwd)"
  else
    WATCHER_DIR=""
  fi
elif [ -n "$WATCHER_DIR" ]; then
  # Explicit path — resolve to absolute.
  if [ ! -d "$WATCHER_DIR" ]; then
    echo "Error: WATCHER_DIR set but not a directory: $WATCHER_DIR" >&2
    exit 1
  fi
  WATCHER_DIR="$(cd "$WATCHER_DIR" && pwd)"
fi

if [ ! -d "$FRONTEND_DIR" ]; then
  echo "Error: frontend dir not found at: $FRONTEND_DIR" >&2
  echo "" >&2
  echo "Override the path:" >&2
  echo "  FRONTEND_DIR=/abs/path bash contracts/script/exportFrontendDeployments.sh" >&2
  exit 1
fi

FRONTEND_DIR="$(cd "$FRONTEND_DIR" && pwd)"
DEPLOYMENTS_DIR="$CONTRACTS_DIR/deployments"
FRONTEND_OUT_DIR="$FRONTEND_DIR/src/contracts"
FRONTEND_OUT_FILE="$FRONTEND_OUT_DIR/deployments.json"
FRONTEND_SOURCE_FILE="$FRONTEND_OUT_DIR/_deployments_source.json"

if [ ! -d "$DEPLOYMENTS_DIR" ]; then
  echo "Error: contracts deployments dir not found: $DEPLOYMENTS_DIR" >&2
  exit 1
fi
if [ ! -d "$FRONTEND_OUT_DIR" ]; then
  echo "Error: frontend contracts output dir not found: $FRONTEND_OUT_DIR" >&2
  echo "Expected the frontend to already have src/contracts/." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 not in PATH (needed for the JSON merge step)." >&2
  exit 1
fi

echo "Merging per-chain addresses.json files into a consolidated JSON"

# Merge step — Python is the right tool here because the per-chain
# JSON files have heterogeneous shapes (canonical-VPFI vs mirror chains
# carry different keys), and we want to preserve that variance in the
# output rather than flatten to a unified schema. `jq` would also work
# but the orchestration is shell-quoting-heavy; Python keeps it readable.
python3 - "$DEPLOYMENTS_DIR" "$FRONTEND_OUT_FILE" <<'PYEOF'
import json
import sys
from pathlib import Path

deployments_dir = Path(sys.argv[1])
out_file = Path(sys.argv[2])

merged: dict[str, dict] = {}
warnings: list[str] = []

for chain_dir in sorted(deployments_dir.iterdir()):
    if not chain_dir.is_dir():
        continue
    addresses_path = chain_dir / "addresses.json"
    if not addresses_path.exists():
        warnings.append(f"  ⚠ {chain_dir.name}: no addresses.json — skipped")
        continue
    try:
        with addresses_path.open() as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        warnings.append(f"  ✗ {chain_dir.name}/addresses.json: malformed JSON ({e}) — skipped")
        continue
    chain_id = data.get("chainId")
    if chain_id is None:
        warnings.append(f"  ✗ {chain_dir.name}/addresses.json: missing 'chainId' — skipped")
        continue
    if not isinstance(chain_id, int):
        warnings.append(f"  ✗ {chain_dir.name}/addresses.json: 'chainId' is not an integer — skipped")
        continue
    key = str(chain_id)
    if key in merged:
        warnings.append(
            f"  ✗ {chain_dir.name}/addresses.json: chainId {chain_id} duplicates "
            f"'{merged[key].get('chainSlug')}' — skipped"
        )
        continue
    merged[key] = data
    print(f"  ✓ {data.get('chainSlug', chain_dir.name)} (chainId={chain_id})")

# Sort keys numerically for stable diffs across exports.
ordered = {k: merged[k] for k in sorted(merged.keys(), key=int)}

with out_file.open("w") as f:
    json.dump(ordered, f, indent=2, sort_keys=True)
    f.write("\n")

if warnings:
    print("", file=sys.stderr)
    for w in warnings:
        print(w, file=sys.stderr)
PYEOF

echo "  → frontend: $FRONTEND_OUT_FILE"

# If the watcher target is present, mirror the same merged JSON into
# the watcher's src/ tree. Same byte content — both consumers share
# the type definition; only the import path differs.
if [ -n "$WATCHER_DIR" ]; then
  WATCHER_OUT_DIR="$WATCHER_DIR/src"
  WATCHER_OUT_FILE="$WATCHER_OUT_DIR/deployments.json"
  if [ ! -d "$WATCHER_OUT_DIR" ]; then
    echo "  ⚠ watcher: src/ not found at $WATCHER_OUT_DIR — skipped" >&2
  else
    cp "$FRONTEND_OUT_FILE" "$WATCHER_OUT_FILE"
    echo "  → watcher:  $WATCHER_OUT_FILE"
  fi
fi

# Provenance stamp — same shape as `_source.json` written by
# exportFrontendAbis.sh so a frontend bundle can be correlated to a
# specific contracts state across both surfaces.
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
DIRTY=""
if ! git diff --quiet HEAD 2>/dev/null; then
  DIRTY=" (dirty)"
fi

# Pluck chainIds from the merged output for the stamp.
CHAIN_IDS_JSON="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
print(json.dumps(sorted(int(k) for k in d.keys())))
' "$FRONTEND_OUT_FILE")"

cat > "$FRONTEND_SOURCE_FILE" <<EOF
{
  "monorepoCommit": "$COMMIT$DIRTY",
  "exportedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "chainIds": $CHAIN_IDS_JSON
}
EOF
echo "  source stamp -> $FRONTEND_SOURCE_FILE"

# Same stamp for the watcher when present.
if [ -n "$WATCHER_DIR" ] && [ -d "$WATCHER_DIR/src" ]; then
  WATCHER_SOURCE_FILE="$WATCHER_DIR/src/_deployments_source.json"
  cat > "$WATCHER_SOURCE_FILE" <<EOF
{
  "monorepoCommit": "$COMMIT$DIRTY",
  "exportedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "chainIds": $CHAIN_IDS_JSON
}
EOF
  echo "  source stamp -> $WATCHER_SOURCE_FILE"
fi

echo ""
echo "Done. Next steps:"
echo "  git diff frontend/src/contracts/deployments.json   # review the change"
if [ -n "$WATCHER_DIR" ] && [ -d "$WATCHER_DIR/src" ]; then
  echo "  git diff ops/hf-watcher/src/deployments.json     # review the watcher change"
fi
echo "  cd $FRONTEND_DIR && node_modules/.bin/tsc -b --noEmit   # confirm frontend still typechecks"
if [ -n "$WATCHER_DIR" ] && [ -d "$WATCHER_DIR/src" ]; then
  echo "  cd $WATCHER_DIR && npx tsc -p . --noEmit          # confirm watcher still typechecks"
fi
echo "  git commit -am 'Sync deployments with contracts@${COMMIT:0:7}'"
