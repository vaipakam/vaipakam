#!/usr/bin/env bash
# retired-deployment.sh — tell the indexer which Diamond a chain's rows came
# from when a fresh redeploy retires it (#1566, Codex #2545 r1–r3).
#
# The indexer owns deployment epochs (apps/indexer/src/deploymentEpoch.ts): it
# resets a chain's chain-scoped rows itself when the bundle names a different,
# newer Diamond than the one it adopted. What it cannot know on its own is
# which Diamond the rows that exist today came from. A `--fresh` redeploy
# therefore RECORDS the retired Diamond, in two places, so the record cannot be
# lost to ordering:
#
#   1. a marker file under the chain's deployments `.markers/`, read by the
#      indexer's own deploy (`deploy-shared-d1.mjs apply`, via
#      INDEXER_RETIRED_DEPLOYMENTS_FILE), which seeds it between the migration
#      apply and the publish — the one moment the table is guaranteed to exist
#      and the new code guaranteed not to be running;
#   2. a best-effort seed right away, for a database whose schema already
#      carries the table (every redeploy after the first under migration 0063).
#
# The seed statement lives in ONE place —
# apps/indexer/scripts/lib/retiredDeploymentSeed.mjs — and is never retyped here.
#
# Sourced by deploy-testnet.sh and deploy-chain.sh. Requires jq (the deploy
# scripts already do) and node for the immediate seed.

# write_retired_deployment_marker <markers_dir> <chain_id> <diamond> <deploy_block>
#   Append-or-replace this chain's entry in <markers_dir>/retired-deployments.json
#   (a JSON array of { chainId, diamond, deployBlock }). Prints the path.
write_retired_deployment_marker() {
  local markers_dir="${1:?markers_dir}" cid="${2:?chain_id}" diamond="${3:?diamond}" block="${4:-0}"
  [ -n "$block" ] && [ "$block" != "null" ] || block=0
  mkdir -p "$markers_dir"
  local file="$markers_dir/retired-deployments.json"
  local existing='[]'
  [ -s "$file" ] && existing=$(cat "$file")
  printf '%s' "$existing" | jq --argjson cid "$cid" --arg d "$diamond" --argjson b "$block" \
    '(if type == "array" then . else [.] end) | map(select(.chainId != $cid)) + [{chainId: $cid, diamond: $d, deployBlock: $b}]' \
    > "$file.tmp" && mv "$file.tmp" "$file"
  printf '%s\n' "$file"
}

# seed_retired_deployments_now <repo_root> <file>
#   Best-effort immediate seed through the single statement source. Loud on
#   failure (prints the statement to run after the indexer deploy), never
#   fatal: the indexer's deploy seeds from the same file regardless.
seed_retired_deployments_now() {
  local repo_root="${1:?repo_root}" file="${2:?file}"
  local seed="$repo_root/apps/indexer/scripts/lib/retiredDeploymentSeed.mjs"
  if ! command -v node >/dev/null 2>&1 || [ ! -d "$repo_root/apps/indexer/node_modules" ]; then
    echo "    ⚠ node or apps/indexer/node_modules missing here — the indexer's deploy will seed from $file"
    return 0
  fi
  if ( cd "$repo_root/apps/indexer" && node "$seed" apply "$file" ); then
    echo "    ✓ retired Diamond recorded — the indexer's next pass under the new bundle resets this chain"
  else
    echo "    ⚠ not recorded yet (migration 0063 not applied, or wrangler not authenticated) — the indexer's deploy"
    echo "      seeds it from $file before publishing; to do it by hand afterwards:"
    ( cd "$repo_root/apps/indexer" && node "$seed" print "$file" 2>/dev/null | sed 's/^/      /' ) || true
  fi
}
