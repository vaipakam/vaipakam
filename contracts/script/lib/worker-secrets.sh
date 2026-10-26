#!/usr/bin/env bash
# shellcheck shell=bash
#
# The ONE check that a Cloudflare Worker can read a chain's RPC secret
# (#2763, #1492). Sourced by deploy-chain.sh, deploy-testnet.sh and
# deploy-mainnet.sh, which each carried their own copy until #2763.
#
# Why it exists: a Worker whose RPC binding is empty drops that chain from
# its round-robin, so D1 stays silently empty for that chain until somebody
# notices missing rows (the May-2026 rehearsal). The phase refuses instead.
#
# Two defects the copies shared, both fixed here:
#
#   1. The count `$(… | grep -c NAME || echo 0)` printed "0" twice when the
#      name was absent (grep -c prints 0 AND exits non-zero), so the value
#      was "0\n0", the `= 0` refusal never matched, and a missing secret
#      passed. The same pattern was fixed for the facet count in
#      sentinel-reads.sh (#2548).
#   2. The copies grepped `wrangler secret list` in the Worker directory,
#      i.e. per-Worker secrets. Every Stage 3 Worker binds its RPC_* values
#      from the account's Secrets Store (`secrets_store_secrets` in its
#      wrangler.jsonc), which that listing cannot see: a correctly
#      provisioned store failed the check, and a stale per-Worker secret the
#      Worker no longer reads passed it (#1492).
#
# So the check now asks the Worker's OWN config where it reads the binding
# from, and looks in that store. Every Stage 3 Worker binds every RPC it
# reads from the store, so its config is also the declaration of which chains
# it reads: a chain whose RPC it does not bind is a chain it does not serve.
# That is a refusal for the indexer and the agent, which must serve every
# chain the protocol is deployed on, and a stated skip for the keeper, which
# acts only on the chains its config binds (it deliberately omits Polygon and
# Polygon Amoy). A listing that cannot be read refuses with its own message,
# never as "absent" and never as "present".

_WORKER_SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _store_secret_names <worker_dir> <store_id>
#   Prints every secret name in the store whose scopes include "workers",
#   one per line, walking every page. Returns 1 when a page cannot be read.
_store_secret_names() {
  local worker_dir="$1" store_id="$2" page=1 out rows names
  while :; do
    out=$(cd "$worker_dir" && pnpm exec wrangler secrets-store secret list "$store_id" \
      --remote --per-page 100 --page "$page" 2>/dev/null) || return 1
    # Table rows are `│ NAME │ ID │ COMMENT │ SCOPES │ STATUS │ …`. Each data
    # row is printed as `<scope-ok> <name>`: the page size is a count of ALL
    # the store's entries, so whether another page exists is judged on every
    # row, and only the names with the workers scope are kept.
    rows=$(printf '%s\n' "$out" | awk -F'│' '
      NF > 6 {
        name = $2; scopes = $5
        gsub(/^[ \t]+|[ \t]+$/, "", name)
        if (name != "" && name != "Name") print (scopes ~ /workers/ ? "1" : "0"), name
      }')
    [ -n "$rows" ] || break
    names=$(printf '%s\n' "$rows" | awk '$1 == "1" { print $2 }')
    [ -n "$names" ] && printf '%s\n' "$names"
    [ "$(printf '%s\n' "$rows" | wc -l)" -lt 100 ] && break
    page=$((page + 1))
  done
  return 0
}

# worker_serves_only_bound_chains <worker_name>
#   True for a Worker whose chain set is whatever its config binds: a chain it
#   binds no RPC for is outside that set, reported rather than refused. The
#   indexer and the agent are not such Workers: every chain the protocol is
#   deployed on must be indexed and served, so an unbound chain refuses there.
worker_serves_only_bound_chains() {
  case "$1" in
    vaipakam-keeper) return 0 ;;
    *)               return 1 ;;
  esac
}

# verify_rpc_secret_on_worker <worker_dir> <worker_name> <binding> <chain_id>
#   Returns 0 when the Worker can read <binding>, or when <binding> is outside
#   the chain set of a Worker that serves only its bound chains; 1 (after
#   printing why and how to fix it) otherwise.
verify_rpc_secret_on_worker() {
  local worker_dir="$1" worker_name="$2" binding="$3" chain_id="$4"
  local where kind store_id secret_name names

  if ! where=$(node "$_WORKER_SECRETS_DIR/worker-secret-binding.mjs" "$worker_dir" "$binding"); then
    echo "  ✗ FAIL: cannot read where $worker_name binds $binding (see the error above)."
    return 1
  fi
  read -r kind store_id secret_name <<<"$where"

  if [ "$kind" = "unbound" ]; then
    if worker_serves_only_bound_chains "$worker_name"; then
      echo "  · $worker_name binds no $binding in $worker_dir/wrangler.jsonc, so it does"
      echo "    not act on chainId=$chain_id; nothing to check. If it should, bind"
      echo "    $binding there from the Secrets Store."
      return 0
    fi
    echo "  ✗ FAIL: $worker_name binds no $binding in $worker_dir/wrangler.jsonc,"
    echo "    so it cannot read chainId=$chain_id at all, and this Worker must serve"
    echo "    every chain the protocol is deployed on. Add the chain to this Worker"
    echo "    (the $binding binding under secrets_store_secrets, as the other RPC"
    echo "    bindings there are, and the chain's entry in the Worker's chain list),"
    echo "    create the store entry if it is missing, and redeploy the Worker."
    return 1
  fi

  if ! names=$(_store_secret_names "$worker_dir" "$store_id"); then
    echo "  ✗ FAIL: could not list Secrets Store $store_id, which $worker_name"
    echo "    reads $binding from. Check the wrangler login (or CLOUDFLARE_API_TOKEN)"
    echo "    can read the account's Secrets Store, then re-run. Not reading the"
    echo "    store is not evidence the secret is there."
    return 1
  fi
  if printf '%s\n' "$names" | grep -Fxq -- "$secret_name"; then
    echo "  ✓ $worker_name reads $binding from Secrets Store entry $secret_name, which exists"
    return 0
  fi
  echo "  ✗ FAIL: $worker_name binds $binding to Secrets Store entry $secret_name"
  echo "    (store $store_id), and the store has no such entry with the workers scope."
  echo
  echo "  The Worker's chain-config filter drops any chain whose RPC binding"
  echo "  is empty, so chainId=$chain_id will silently never be queried."
  echo "  Create the entry before re-running (wrangler prompts for the value,"
  echo "  so it never lands in shell history):"
  echo
  echo "    cd $worker_dir"
  echo "    pnpm exec wrangler secrets-store secret create $store_id \\"
  echo "      --name $secret_name --scopes workers --remote"
  echo
  echo "  RPC URLs carry API keys: they live only in the store, never in the"
  echo "  repo. Mainnet needs a paid tier so the cron is not throttled."
  return 1
}

# rpc_secret_for_slug <chain_slug>
#   Prints the RPC binding name every Worker reads for that chain. Returns 1,
#   printing nothing, for a slug with no known binding. The one map; the
#   three deploy scripts each kept their own copy until #2763.
rpc_secret_for_slug() {
  case "${1:?chain_slug}" in
    base-sepolia)  echo "RPC_BASE_SEPOLIA" ;;
    sepolia)       echo "RPC_SEPOLIA" ;;
    arb-sepolia)   echo "RPC_ARB_SEPOLIA" ;;
    op-sepolia)    echo "RPC_OP_SEPOLIA" ;;
    bnb-testnet)   echo "RPC_BNB_TESTNET" ;;
    polygon-amoy)  echo "RPC_POLYGON_AMOY" ;;
    ethereum)      echo "RPC_ETH" ;;
    base)          echo "RPC_BASE" ;;
    arbitrum)      echo "RPC_ARB" ;;
    optimism)      echo "RPC_OP" ;;
    bnb)           echo "RPC_BNB" ;;
    polygon)       echo "RPC_POLYGON" ;;
    *)             return 1 ;;
  esac
}

# check_chain_rpc_secret <worker_dir> <worker_name> <chain_slug> <chain_id>
#   The deploy scripts' call: maps the slug and verifies the Worker can read
#   the binding. A slug with no known binding refuses rather than skipping
#   the check, so a chain is never deployed with its Workers unverified
#   because nobody added it to the map.
check_chain_rpc_secret() {
  local worker_dir="$1" worker_name="$2" chain_slug="$3" chain_id="$4" binding
  echo
  echo "  RPC-secret check: $worker_name, chainId=$chain_id"
  if ! binding=$(rpc_secret_for_slug "$chain_slug"); then
    echo "  ✗ FAIL: no RPC binding is known for chain slug '$chain_slug'. Add it to"
    echo "    rpc_secret_for_slug in contracts/script/lib/worker-secrets.sh (and bind"
    echo "    it in each Worker's wrangler.jsonc) before deploying this chain."
    return 1
  fi
  verify_rpc_secret_on_worker "$worker_dir" "$worker_name" "$binding" "$chain_id"
}
