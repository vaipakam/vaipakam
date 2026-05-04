#!/usr/bin/env bash
#
# exportAbis.sh — Phase 9.A keeper-bot ABI sync.
#
# Runs `forge inspect <Facet> abi` for every facet the public
# keeper-bot reads, and writes the resulting JSON files into the
# sibling `vaipakam-keeper-bot` checkout's `src/abis/` directory.
# That keeps the public repo's hand-imported ABIs in lockstep with
# whatever's in the monorepo without making the public repo a
# submodule of this one.
#
# Usage:
#   bash contracts/script/exportAbis.sh
#       # defaults to KEEPER_BOT_DIR=../../vaipakam-keeper-bot
#
#   KEEPER_BOT_DIR=/abs/path/to/checkout bash contracts/script/exportAbis.sh
#
# When to run:
#   - After every contract change that adds/modifies/removes a
#     selector the bot reads (currently:
#     MetricsFacet.getActiveLoansCount, getActiveLoansPaginated;
#     RiskFacet.calculateHealthFactor, triggerLiquidation;
#     LoanFacet.getLoanDetails).
#   - Before tagging a release in either repo.
#
# What it does NOT do:
#   - Doesn't commit anything. The script only writes files; the
#     contributor is expected to review the diff and commit in the
#     keeper-bot repo themselves.
#   - Doesn't run forge build first. Assumes you've already run
#     `forge build` in contracts/ since the last contract edit.

set -euo pipefail

# Resolve script's own location so the script works regardless of
# the contributor's current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default sibling layout: monorepo at /work/vaipakam, keeper-bot at
# /work/vaipakam-keeper-bot. Override by exporting KEEPER_BOT_DIR.
KEEPER_BOT_DIR="${KEEPER_BOT_DIR:-$CONTRACTS_DIR/../../vaipakam-keeper-bot}"

if [ ! -d "$KEEPER_BOT_DIR" ]; then
  echo "Error: keeper-bot dir not found at: $KEEPER_BOT_DIR" >&2
  echo "" >&2
  echo "Either:" >&2
  echo "  1. Clone vaipakam-keeper-bot to that path, or" >&2
  echo "  2. Override the path:" >&2
  echo "       KEEPER_BOT_DIR=/abs/path bash contracts/script/exportAbis.sh" >&2
  exit 1
fi

# Resolve to absolute (realpath isn't on macOS by default; cd+pwd is).
KEEPER_BOT_DIR="$(cd "$KEEPER_BOT_DIR" && pwd)"
OUT_DIR="$KEEPER_BOT_DIR/src/abis"
mkdir -p "$OUT_DIR"

cd "$CONTRACTS_DIR"

if ! command -v forge >/dev/null 2>&1; then
  echo "Error: forge not in PATH. Install Foundry: https://book.getfoundry.sh/getting-started/installation" >&2
  exit 1
fi

# Facets the keeper-bot consumes. Keep this list narrow — the bot
# reads only the surface it actually uses, so additions here are
# meaningful and should be paired with a bot-side update.
FACETS=(
  "MetricsFacet"      # getActiveLoansCount, getActiveLoansPaginated, getActiveOffersCount, getActiveOffersPaginated
  "RiskFacet"         # calculateHealthFactor, triggerLiquidation
  "LoanFacet"         # getLoanDetails
  "OfferFacet"        # createOffer / acceptOffer (kept for completeness — pre-2026-04 the matcher fns lived here)
  "OfferCancelFacet"  # getOffer (offer hydration in offerMatcher detector — moved from OfferFacet in EIP-170 split)
  "OfferMatchFacet"   # previewMatch, matchOffers — current home of the matcher selectors after the facet split
)

echo "Exporting ABIs to $OUT_DIR"
for facet in "${FACETS[@]}"; do
  out="$OUT_DIR/$facet.json"
  # `--json` is required — recent foundry versions default to a
  # pretty table on `forge inspect`, which is not parseable.
  if ! forge inspect "$facet" abi --json > "$out"; then
    echo "Error: forge inspect $facet abi --json failed" >&2
    exit 1
  fi
  echo "  $facet -> $out"
done

# Stamp the keeper-bot's abis dir with the monorepo commit hash so
# auditors can correlate a published bot release with a specific
# contracts state.
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
echo "  cd $KEEPER_BOT_DIR"
echo "  git diff src/abis/   # review the change"
echo "  npm run typecheck    # confirm bot still builds"
echo "  git commit -am 'Sync ABIs with vaipakam@${COMMIT:0:7}'"
