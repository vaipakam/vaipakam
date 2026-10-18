#!/usr/bin/env bash
# ccip-lanes.sh — resolve the active chain's CCIP lane list (#2548).
#
# `ConfigureCcip.s.sol` reads one `CCIP_LANE_CHAIN_IDS`, but its value differs
# per chain: the hub lists every spoke, each spoke lists the hub. A single
# `.env` entry therefore cannot serve every chain, and until now it had to be
# typed on the command line for every `ccip-wire` run. The router, RMN proxy
# and both registries already resolve from `<VAR>_<SLUG>`; this gives the lane
# list the same shape, so one `.env` carries every chain's topology.
#
# Precedence, chosen so a typo cannot silently wire the wrong topology:
#   - `CCIP_LANE_CHAIN_IDS_<SLUG>` set, bare unset  -> the per-chain value
#   - bare set, per-chain unset                     -> the bare value (a
#     one-off command-line override, the documented flow before #2548)
#   - both set and EQUAL                            -> that value
#   - both set and DIFFERENT                        -> hard error: two
#     sources disagree about this chain's lanes, and picking either one
#     would be a guess
#
# Unlike the router and registries, a bare value with no per-chain entry is
# NOT an error here. A bare router can only ever be one chain's address, so
# it is refused; a lane list typed for the run in hand is exactly the usage
# this variable has always had.
#
# Sourced by deploy-testnet.sh and deploy-mainnet.sh.

# resolve_ccip_lane_chain_ids <SLUG_UPPER>
#   Exports CCIP_LANE_CHAIN_IDS for the slug. Returns 1, with a message on
#   stderr, when the two sources disagree. Leaves it unset when neither is
#   set, so the caller's own "unset" guard reports it.
resolve_ccip_lane_chain_ids() {
  local slug="${1:?slug}"
  local slug_var="CCIP_LANE_CHAIN_IDS_${slug}"
  local per_chain="${!slug_var:-}" bare="${CCIP_LANE_CHAIN_IDS:-}"
  if [ -n "$per_chain" ] && [ -n "$bare" ] && [ "$per_chain" != "$bare" ]; then
    echo "Error: $slug_var=$per_chain and CCIP_LANE_CHAIN_IDS=$bare disagree about this chain's lanes." >&2
    echo "       Unset one of them; the deploy will not guess which topology you meant." >&2
    return 1
  fi
  if [ -n "$per_chain" ]; then
    export CCIP_LANE_CHAIN_IDS="$per_chain"
  fi
  return 0
}
