#!/usr/bin/env bash
# retired-deployment.sh — tell the indexer which Diamond a chain's rows came
# from when a fresh redeploy retires it (#1566, Codex #2545 r1–r6).
#
# The indexer owns deployment epochs (apps/indexer/src/deploymentEpoch.ts): it
# resets a chain's chain-scoped rows itself when the bundle names a different,
# newer Diamond than the one it adopted. What it cannot know on its own is
# which Diamond the rows that exist today came from. THE RECORD OF THAT IS THE
# COMMITTED ARCHIVE INVENTORY, `contracts/deployments/archive-manifest.json`,
# which every `--fresh` redeploy writes BEFORE it moves the artifact ("record
# first, then move"). Nothing untracked carries it (Codex #2545 r6): the
# indexer's own deploy (`deploy-shared-d1.mjs apply`) derives the retired
# Diamonds from the manifest and the live bundle and seeds them between the
# migration apply and the publish, so a deploy from a clean checkout of the
# merged tree seeds exactly what the repository records.
#
# This helper is the deploy scripts' best-effort IMMEDIATE seed through the
# same single statement source (apps/indexer/scripts/lib/
# retiredDeploymentSeed.mjs), for a database whose schema already carries the
# table. Loud on failure, never fatal: the indexer's deploy seeds regardless.
#
# Sourced by deploy-testnet.sh and deploy-chain.sh.

# seed_retired_deployments_now <repo_root>
seed_retired_deployments_now() {
  local repo_root="${1:?repo_root}"
  local seed="$repo_root/apps/indexer/scripts/lib/retiredDeploymentSeed.mjs"
  if ! command -v node >/dev/null 2>&1 || [ ! -d "$repo_root/apps/indexer/node_modules" ]; then
    echo "    ⚠ node or apps/indexer/node_modules missing here — the indexer's deploy seeds from archive-manifest.json"
    return 0
  fi
  if ( cd "$repo_root/apps/indexer" && node "$seed" apply --from-manifest ); then
    echo "    ✓ retired Diamond(s) recorded for the indexer — its next pass under the new bundle resets the chain"
  else
    echo "    ⚠ not recorded yet (migration 0063 not applied, or wrangler not authenticated) — the indexer's deploy"
    echo "      seeds from archive-manifest.json before publishing; to do it by hand afterwards:"
    echo "      (cd apps/indexer && node scripts/lib/retiredDeploymentSeed.mjs apply --from-manifest)"
  fi
}
