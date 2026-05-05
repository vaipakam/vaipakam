#!/usr/bin/env bash
#
# exportWatcherAbis.sh — hf-watcher ABI sync.
#
# Runs `forge inspect <Facet> abi --json` for every facet the
# Cloudflare hf-watcher worker decodes return-data from, and writes
# the resulting JSON files into `ops/hf-watcher/src/abis/`.
#
# Why this script exists at all:
#
#   The watcher used to carry hand-rolled `as const` ABI tuples in
#   `src/diamondAbi.ts`. When the contract's `Offer` struct gained
#   `periodicInterestCadence` (T-034 — Periodic Interest Payment), the
#   hand-rolled tuple wasn't updated; viem's positional decoder then
#   read `lendingAsset` from the byte position where the cadence enum
#   actually lives, cascading every subsequent field by one slot.
#   Symptom: OfferBook rendered garbage values (5×10^29 ETH amounts,
#   10^7% rates, 5×10^18 days durations) for offers whose Dashboard
#   view was correct, because Dashboard reads via the auto-synced
#   frontend ABI bundle while the OfferBook indexer pipeline went
#   through the watcher's stale tuple. See ReleaseNotes-2026-05-05.md
#   "Watcher offer-decode drift" for the full incident.
#
#   Auto-exporting from `forge inspect` makes the compiled bytecode
#   the single source of truth — a struct-shape change can never
#   silently misalign the watcher's decoder again, because the very
#   next deploy-time export rebuilds the ABI from the compiler's
#   canonical output.
#
# Usage:
#   bash contracts/script/exportWatcherAbis.sh
#       # defaults to WATCHER_DIR=../ops/hf-watcher (this repo's watcher)
#
#   WATCHER_DIR=/abs/path/to/hf-watcher bash contracts/script/exportWatcherAbis.sh
#
# When to run:
#   - Automatically: invoked from deploy-chain.sh / deploy-mainnet.sh
#     after every `forge build`, so any contract change that touches
#     the watcher's read surface is reflected before the deploy ships.
#   - Manually: after editing `LibVaipakam.Offer` / `LibVaipakam.Loan`
#     or any of the facets in FACETS below, before pushing a contract
#     change the watcher depends on.
#
# What it does NOT do:
#   - Doesn't commit anything. Review with `git diff
#     ops/hf-watcher/src/abis/` and commit alongside the contract
#     change.
#   - Doesn't run `forge build` first. Caller (deploy script / human)
#     must build before invoking.
#   - Doesn't redeploy the watcher. After re-export, redeploy via
#     `cd ops/hf-watcher && wrangler deploy` so the live worker picks
#     up the corrected ABI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default sibling layout: monorepo at /work/vaipakam, watcher at
# /work/vaipakam/ops/hf-watcher. Override via WATCHER_DIR.
WATCHER_DIR="${WATCHER_DIR:-$CONTRACTS_DIR/../ops/hf-watcher}"

if [ ! -d "$WATCHER_DIR" ]; then
  echo "Error: watcher dir not found at: $WATCHER_DIR" >&2
  echo "" >&2
  echo "Override the path:" >&2
  echo "  WATCHER_DIR=/abs/path bash contracts/script/exportWatcherAbis.sh" >&2
  exit 1
fi

WATCHER_DIR="$(cd "$WATCHER_DIR" && pwd)"
OUT_DIR="$WATCHER_DIR/src/abis"

mkdir -p "$OUT_DIR"

cd "$CONTRACTS_DIR"

if ! command -v forge >/dev/null 2>&1; then
  echo "Error: forge not in PATH. Install Foundry: https://book.getfoundry.sh/getting-started/installation" >&2
  exit 1
fi

# Facets the watcher decodes return-data from via viem's
# `readContract`. Keep this list MINIMAL — every entry is one more
# place to drift if a facet is renamed without updating this script.
# Today the watcher reads:
#   - getOfferDetails(uint256) on OfferCancelFacet
#   - getLoanDetails(uint256) on LoanFacet
# Add to this list ONLY if the watcher gains a new return-decoding
# code path (events use parseAbi inline + topic-hash routing, so
# they don't need to live here).
FACETS=(
  "OfferCancelFacet"
  "LoanFacet"
)

echo "Exporting watcher ABIs to $OUT_DIR"
fail=0
for facet in "${FACETS[@]}"; do
  out="$OUT_DIR/$facet.json"
  if ! forge inspect "$facet" abi --json > "$out.tmp" 2>/dev/null; then
    echo "  ✗ $facet — forge inspect failed (missing artifact? run 'forge build' first)" >&2
    rm -f "$out.tmp"
    fail=1
    continue
  fi
  mv "$out.tmp" "$out"
  echo "  ✓ $facet"
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "One or more facets failed to export. Fix the missing artifact(s) and re-run." >&2
  exit 1
fi

# Provenance stamp — lets a deployed worker version be correlated
# back to the exact contracts commit it was built against. Same
# pattern as the frontend's _source.json.
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
DIRTY=""
if ! git diff --quiet HEAD 2>/dev/null; then
  DIRTY=" (dirty)"
fi
cat > "$OUT_DIR/_source.json" <<EOF
{
  "monorepoCommit": "$COMMIT$DIRTY",
  "exportedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "facets": [$(printf '"%s",' "${FACETS[@]}" | sed 's/,$//')]
}
EOF
echo "  source stamp -> $OUT_DIR/_source.json"

echo ""
echo "Done. Next steps:"
echo "  git diff ops/hf-watcher/src/abis/   # review the change"
echo "  cd $WATCHER_DIR && npx tsc -p . --noEmit   # confirm watcher still typechecks"
echo "  cd $WATCHER_DIR && wrangler deploy   # ship the corrected ABI to Cloudflare"
echo "  git commit -am 'Sync watcher ABIs with contracts@${COMMIT:0:7}'"
