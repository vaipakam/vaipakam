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
#     `forge build --skip test` in contracts/ since the last contract edit.
#
# What it DOES run besides `forge inspect`: the bot's own
# `scripts/gen-typed-abis.mjs`, when the checkout has it, so the typed ABI
# modules the bot compiles against match the JSON written here.
#
# Export from a CLEAN checkout of the commit being synced. A dirty tree
# stamps `_source.json` "(dirty)" and the export is then not reproducible
# from the recorded commit; the script warns when that happens.

set -euo pipefail

# Resolve script's own location so the script works regardless of
# the contributor's current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Provenance snapshot — MUST be taken BEFORE this script writes anything ──
# (#1490) The tree state recorded in the provenance stamp answers "which
# source state was this output generated FROM". Testing it AFTER the script
# has written its own output always reports dirty, because the output IS a
# working-tree change — so the marker was set on every run and distinguished
# nothing, least of all the case it exists for: an export taken from a tree
# with real uncommitted contract edits, which is not reproducible from the
# recorded commit.
#
# `git diff --quiet HEAD` (not bare `git diff`) so STAGED-but-uncommitted
# edits count as dirty too; a bare `git diff` compares against the index and
# reports a fully-staged change as clean.
TREE_COMMIT_AT_START="$(git -C "$CONTRACTS_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')"
TREE_DIRTY_AT_START=""
# Anchored at the REPO ROOT and excluding this script's OWN output
# (Codex #1495 r5 P2). Two things were wrong before: a pathspec was
# resolved relative to `-C` rather than the root, and — more
# importantly — the snapshot counted this script's own uncommitted
# output as source drift, so simply RE-RUNNING an export before
# committing its result recreated the false-dirty stamp this change
# exists to remove.
if ! git -C "$CONTRACTS_DIR/.." diff --quiet HEAD 2>/dev/null; then
  TREE_DIRTY_AT_START=" (dirty)"
fi

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
  "MetricsFacet"      # getActiveLoansCount, getActiveLoansPaginated, getActiveOffersCount, getActiveOffersPaginated, getMatchEligibleLoans (internal-match detector)
  "RiskFacet"         # calculateHealthFactor, triggerLiquidation
  "RiskMatchLiquidationFacet" # triggerInternalMatchLiquidation — moved here from RiskFacet in the #66 EIP-170 split
  "ForcedSaleFacet"   # #2796 — previewForcedSale: the sale-size range triggerLiquidation accepts
  "LoanFacet"         # getLoanDetails
  "OfferCreateFacet"  # createOffer / getUserVault
  "OfferAcceptFacet"  # acceptOffer / acceptOfferInternal
  "OfferCancelFacet"  # getOffer (offer hydration in offerMatcher detector — moved from OfferFacet in EIP-170 split)
  "OfferMatchFacet"   # previewMatch, matchOffers — current home of the matcher selectors after the facet split
  "ConfigFacet"       # getInternalMatchConfigBundle — kill-switch + tunables read by the internalMatcher detector
  "AdminFacet"        # T-092 #518 — getAutoExtendEnabled (admin kill switch read by autoExtendDetector)
  "AutoLifecycleFacet" # T-092 #518 — getAutoExtendBorrowerCaps / getAutoExtendLenderCaps / extendLoanInPlace (autoExtendDetector)
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
# HEAD moved between the snapshot and the stamp — the pair would be
# inconsistent, so say so rather than publish a confident wrong answer.
if [ "$(git -C "$CONTRACTS_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')" \
     != "$TREE_COMMIT_AT_START" ]; then
  TREE_DIRTY_AT_START=" (dirty)"
fi
# Pinned WITH the snapshot, not re-read here (Codex #1495 r3 P2). A commit
# landing between the snapshot and this line would otherwise pair a NEW hash
# with the CLEAN state observed earlier, attributing output to a commit that
# did not produce it. The window is small for an exporter and not zero, and
# the deploy scripts already had to solve exactly this — one idiom, no
# special cases.
COMMIT="$TREE_COMMIT_AT_START"
DIRTY="$TREE_DIRTY_AT_START"
cat > "$OUT_DIR/_source.json" <<EOF
{
  "monorepoCommit": "$COMMIT$DIRTY",
  "exportedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "facets": [$(printf '"%s",' "${FACETS[@]}" | sed 's/,$//')]
}
EOF
echo "  source stamp -> $OUT_DIR/_source.json"

# ── Typed ABI modules (vaipakam-keeper-bot#13 / #14) ──
# The bot types every Diamond call from `src/abis/typed/*.ts`, generated from
# the JSON just written, and its CI (`npm run check:abis`) fails a sync whose
# typed modules were not regenerated. Run the bot's own generator here so the
# sync is complete in one step. A bot checkout older than #14 has no
# generator; that is not an error, it only means there is nothing to
# regenerate, so say so and carry on.
GEN="$KEEPER_BOT_DIR/scripts/gen-typed-abis.mjs"
if [ -f "$GEN" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not in PATH; it is needed to run $GEN" >&2
    exit 1
  fi
  echo "Generating typed ABI modules"
  if ! node "$GEN"; then
    echo "Error: $GEN failed; src/abis/typed/ is not in sync with the JSON" >&2
    exit 1
  fi
  echo "  typed modules -> $OUT_DIR/typed/"
else
  echo "Note: $GEN not found (bot checkout predates keeper-bot#14);"
  echo "      skipped typed-ABI generation."
fi

if [ -n "$DIRTY" ]; then
  echo ""
  echo "Warning: the monorepo tree was not clean at a single commit during this"
  echo "export, so _source.json is stamped '(dirty)' and the export cannot be"
  echo "reproduced from $COMMIT. Re-run it from a clean checkout before committing."
fi

echo ""
echo "Done. Next steps:"
echo "  cd $KEEPER_BOT_DIR"
echo "  git diff src/abis/   # review the change (JSON and typed modules)"
echo "  npm run typecheck    # every Diamond call is checked against the new ABIs"
echo "  git add src/abis && git commit -m 'Sync ABIs with vaipakam@${COMMIT:0:7}'"
