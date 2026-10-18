#!/usr/bin/env bash
# artifact-code-check.sh — refuse to record a PHANTOM deployment artifact as a
# retired Diamond (#2548).
#
# `forge script --broadcast` runs its simulation first, and DeployDiamond
# writes `deployments/<slug>/addresses.json` during that simulation — before
# any transaction is sent. A run killed between the two leaves an artifact
# whose addresses are the CREATE addresses the broadcast WOULD have produced:
# well-formed, plausible, and with no code behind any of them.
#
# A later `--fresh` used to archive that file like any other, and archiving
# RECORDS the artifact's Diamond in the committed `archive-manifest.json`
# first ("record, then move"). Since #2545 the indexer derives retired
# deployments from that manifest and seeds them as real epochs, so a phantom
# would enter the indexer's history as a Diamond that was never deployed.
#
# The check is the operation it guards: the Diamond address is the one the
# archive is about to record, and the code read is against this chain's RPC.
# An RPC that cannot answer is a refusal too — the archive cannot prove the
# Diamond exists, so it does not claim it did.
#
# Sourced by deploy-testnet.sh and deploy-mainnet.sh.

# require_artifact_diamond_has_code <addresses.json> <rpc_url> <chain_slug>
#   Returns 0 when the artifact names no Diamond (nothing to record) or when
#   its Diamond has code. Otherwise prints the recovery steps and returns 1.
require_artifact_diamond_has_code() {
  local artifact="${1:?artifact}" rpc="${2:?rpc_url}" slug="${3:?chain_slug}"
  local diamond code
  [ -f "$artifact" ] || return 0
  diamond=$(jq -r '.diamond // empty' "$artifact" 2>/dev/null || true)
  [ -n "$diamond" ] && [ "$diamond" != "null" ] || return 0
  if ! code=$(cast code "$diamond" --rpc-url "$rpc" 2>/dev/null); then
    echo "ERROR: could not read the code at $slug's recorded Diamond $diamond — refusing to record it as a retired deployment without proof it exists." >&2
    return 1
  fi
  if [ -z "$code" ] || [ "$code" = "0x" ]; then
    cat >&2 <<EOF
ERROR: $artifact names Diamond $diamond, which has NO CODE on this chain.

That is the shape a killed \`forge script\` leaves: the simulation writes the
artifact before any broadcast. Archiving it would record a Diamond that was
never deployed in archive-manifest.json, and the indexer seeds retired
deployments from that manifest. Nothing has been archived or recorded.

To recover:
  1. Make sure no forge process from the killed run is still alive.
  2. Clear its live-publication marker. The marker's token is under
     livePublicationsInProgress.$slug in contracts/deployments/archive-manifest.json:
       node packages/contracts/scripts/archive-manifest.mjs live-end \\
         contracts/deployments/archive-manifest.json $slug <token>
     (or let the next deploy take it over with live-begin --force, which
     first proves the old run's process group is gone).
  3. Remove the phantom artifact:  rm $artifact
  4. Re-run the deploy.
EOF
    return 1
  fi
  return 0
}
