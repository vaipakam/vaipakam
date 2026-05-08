#!/usr/bin/env bash
#
# exportFrontendDeployments.sh — single-target deployment-artifact sync.
#
# Writes the consolidated `deployments.json` (every per-chain
# `contracts/deployments/<chain-slug>/addresses.json` folded into one
# object keyed by `chainId`) into the `@vaipakam/contracts` workspace
# package. Every consumer in the monorepo — apps/{defi,labs} for
# the React surfaces, apps/{keeper,indexer,agent} for the Cloudflare
# Workers — imports from `@vaipakam/contracts/deployments`, so this
# single write reaches everything.
#
# (Pre-Stage-3 this script also wrote a duplicate copy into
# `ops/hf-watcher/src/deployments.json`. After the Stage 3 Worker
# split — see `docs/DesignsAndPlans/Stage3WorkerSplitPlan.md` —
# the three new Workers all import the same `@vaipakam/contracts`
# bundle the frontend reads, so the dual-write target is gone.)
#
# Companion to `exportFrontendAbis.sh`: that script syncs per-facet
# *interfaces* (function selectors, struct shapes); this one syncs
# the per-chain *deployed addresses* needed to talk to those
# interfaces.
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
#       # auto-detects CONTRACTS_PKG_DIR=../packages/contracts
#
#   CONTRACTS_PKG_DIR=/abs/path \
#     bash contracts/script/exportFrontendDeployments.sh
#
# When to run:
#   - After every contract deploy / redeploy on any chain.
#   - When a new `contracts/deployments/<chain>/` directory appears.
#   - Alongside `exportFrontendAbis.sh` if facet selectors also changed.
#
# What it does NOT do:
#   - Doesn't commit anything. Review with
#     `git diff packages/contracts/src/deployments.json` and commit
#     alongside the deploy artifacts.
#   - Doesn't run any deploy script. It only reads what the deploy
#     scripts already wrote.
#   - Doesn't synthesize zero-address sentinels for missing fields.
#     A chain's stanza only carries the keys present in its
#     `addresses.json` — consumers narrow on the
#     `isCanonicalVPFI` / `isCanonicalReward` discriminators.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Default workspace layout: monorepo at /work/vaipakam, deployments
# bundle at /work/vaipakam/packages/contracts/src/deployments.json
# (Stage 1b moved the bundle into the @vaipakam/contracts workspace
# package so every app shares one copy). Operators with custom
# layouts override CONTRACTS_PKG_DIR.
CONTRACTS_PKG_DIR="${CONTRACTS_PKG_DIR:-$CONTRACTS_DIR/../packages/contracts}"

if [ ! -d "$CONTRACTS_PKG_DIR" ]; then
  echo "Error: contracts package dir not found at: $CONTRACTS_PKG_DIR" >&2
  echo "" >&2
  echo "Override the path:" >&2
  echo "  CONTRACTS_PKG_DIR=/abs/path bash contracts/script/exportFrontendDeployments.sh" >&2
  exit 1
fi

CONTRACTS_PKG_DIR="$(cd "$CONTRACTS_PKG_DIR" && pwd)"
DEPLOYMENTS_DIR="$CONTRACTS_DIR/deployments"
FRONTEND_OUT_DIR="$CONTRACTS_PKG_DIR/src"
FRONTEND_OUT_FILE="$FRONTEND_OUT_DIR/deployments.json"
FRONTEND_SOURCE_FILE="$FRONTEND_OUT_DIR/_deployments_source.json"

if [ ! -d "$DEPLOYMENTS_DIR" ]; then
  echo "Error: contracts deployments dir not found: $DEPLOYMENTS_DIR" >&2
  exit 1
fi
if [ ! -d "$FRONTEND_OUT_DIR" ]; then
  echo "Error: contracts package src dir not found: $FRONTEND_OUT_DIR" >&2
  echo "Expected packages/contracts/src/ to exist." >&2
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

# Active-chains allow-list. When `.active-chains` exists the export
# only includes per-chain folders whose chainId appears in the list.
# When it doesn't exist, every folder with a valid `addresses.json`
# is included (the historical behaviour).
#
# Why a dot-prefixed file inside the deployments dir: the export
# script's loop already skips non-directories, so the file slots in
# next to the per-chain folders without colliding. Keeping it
# colocated means a single git diff captures both "what we deployed"
# (per-chain folders) and "what we currently consider live" (this
# allow-list).
#
# Format: one chainId per line, integer; `#` starts a comment;
# blank lines ignored. Example:
#   # Phase 1 testnet trio
#   84532       # base-sepolia
#   421614      # arb-sepolia
#   11155420    # op-sepolia
#
# Folders for chains NOT in the list stay on disk for forensic
# value (audit trail of what was deployed when), but stop being
# crawled by the workers and stop appearing in the frontend's
# chain picker.
allow_list_path = deployments_dir / ".active-chains"
allow_list: set[str] | None = None
if allow_list_path.exists():
    allow_list = set()
    with allow_list_path.open() as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if not line.isdigit():
                print(
                    f"  ✗ .active-chains: '{line}' is not a chainId — ignored",
                    file=sys.stderr,
                )
                continue
            allow_list.add(line)
    print(f"  ⓘ active-chains allow-list: {sorted(int(x) for x in allow_list)}")

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
    if allow_list is not None and key not in allow_list:
        warnings.append(
            f"  ⊘ {chain_dir.name}: chainId {chain_id} not in .active-chains — skipped"
        )
        continue
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

echo "  → $FRONTEND_OUT_FILE"

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

echo ""
echo "Done. Next steps:"
echo "  git diff packages/contracts/src/deployments.json     # review the change"
echo "  pnpm --filter @vaipakam/defi exec tsc -b --noEmit    # confirm consumers still typecheck"
echo "  git commit -am 'Sync deployments with contracts@${COMMIT:0:7}'"
