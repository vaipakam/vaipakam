# shellcheck shell=bash
# ── The shell half of a deploy rehearsal (#3891, design §11-§13) ──────────
#
# A deploy rehearsal runs the REAL deploy script, phase by phase, against a
# local fork of the target chain started by `script/rehearse.sh`. The fork
# keeps the real chain id, so every per-chain branch of the deploy takes the
# path it takes on the real chain. Six things differ, each declared once:
# the network (a fork), the signer (impersonated role addresses, no key), the
# output root (a scratch folder), the clock, CCIP (a local relay) and the
# off-chain publishing (dry runs). This file carries the first three for the
# shell; `script/lib/ArtifactRoot.sol` and `script/lib/Signers.sol` carry the
# same rules for Solidity, and the two halves must agree.
#
# Entering the mode needs BOTH tests, and either alone is refused:
#   - the flag: `--rehearse` on the deploy script, with the run's scratch
#     folder exported by the driver as VAIPAKAM_REHEARSAL_ROOT;
#   - the node: the RPC answers on a loopback address AND carries the
#     local-node marker (code at a keyless address only a dev node can place).
# Without the flag, a node carrying the marker is refused, so a real deploy
# can never run against a fork and a rehearsal can never reach a real chain.
#
# The functions below are the only places the deploy scripts:
#   - decide the mode (rehearsal_prescan, rehearsal_enter, rehearsal_refuse_marker_node);
#   - resolve where records and forge's outputs go (RECORDS_ROOT, BROADCAST_ROOT);
#   - send a transaction from the shell (vk_cast_send) or name a role's address
#     (vk_role_address);
#   - run `forge script` (the `forge` function, which adds forge's unlocked
#     sending to a broadcasting script in a rehearsal and changes nothing in a
#     real run).
#
# Nothing here prints a key, an RPC URL or a value read from `.env`.

# The marker, byte for byte as in ArtifactRoot.sol and the harness's fixture.ts.
# Address: the low 20 bytes of keccak256("vaipakam.e2e.local-node-marker").
REHEARSAL_MARKER_ADDRESS="0x58d3f406f8290e7ca4c3867124476ec6d128985b"
REHEARSAL_MARKER_CODE="0xfe76616970616b616d20653265206c6f63616c206e6f6465"
REHEARSAL_SCRATCH_PREFIX="deployments/.forge-test/rehearsal/"

# Defaults for a real run. rehearsal_enter replaces them.
REHEARSE="${REHEARSE:-0}"

# rehearsal_prescan "$@" — sets REHEARSE=1 when the operator's arguments carry
# `--rehearse`. Read-only and run BEFORE `.env` is loaded, because the loader
# must already know whether to leave the key variables out (design §12). The
# argument parser still owns the flag; this only peeks.
rehearsal_prescan() {
  local a
  for a in "$@"; do
    [ "$a" = "--rehearse" ] && REHEARSE=1
  done
  return 0
}

# rehearsal_env_load_flags — the loader options this mode needs, one per line.
rehearsal_env_load_flags() {
  [ "$REHEARSE" = 1 ] && printf '%s\n' --drop-key-vars
  return 0
}

# rehearsal_is_loopback_url URL — the harness's assertLoopbackUrl, in shell:
# http(s) to 127.0.0.1, localhost or ::1, with an optional port and path.
rehearsal_is_loopback_url() {
  local url="$1" rest host
  case "$url" in
    http://*) rest="${url#http://}" ;;
    https://*) rest="${url#https://}" ;;
    *) return 1 ;;
  esac
  # No credentials in the authority: `http://127.0.0.1@evil.example` has the
  # host after the `@`.
  rest="${rest%%/*}"
  case "$rest" in *@*) return 1 ;; esac
  case "$rest" in
    \[::1\] | \[::1\]:*) return 0 ;;
  esac
  host="${rest%%:*}"
  if [ "$rest" != "$host" ]; then
    # Whatever follows the host must be a port and nothing else.
    case "${rest#*:}" in '' | *[!0-9]*) return 1 ;; esac
  fi
  case "$host" in
    127.0.0.1 | localhost) return 0 ;;
  esac
  return 1
}

# rehearsal_node_has_marker RPC — TRUE when the node carries the marker.
rehearsal_node_has_marker() {
  local code
  code=$(cast code "$REHEARSAL_MARKER_ADDRESS" --rpc-url "$1" 2>/dev/null) || return 1
  [ "$(printf '%s' "$code" | tr 'A-F' 'a-f')" = "$REHEARSAL_MARKER_CODE" ]
}

# rehearsal_root_ok ROOT — the Solidity rule's two total tests: under the
# rehearsal scratch prefix, and no `..` segment.
rehearsal_root_ok() {
  local root="$1"
  case "$root" in "$REHEARSAL_SCRATCH_PREFIX"?*) : ;; *) return 1 ;; esac
  case "/$root/" in */../*) return 1 ;; esac
  return 0
}

# rehearsal_refuse_marker_node RPC — a REAL run's check: refuse a node that
# carries the marker. Called by every phase that talks to a node.
rehearsal_refuse_marker_node() {
  [ "$REHEARSE" = 1 ] && return 0
  if rehearsal_node_has_marker "$1"; then
    echo "Error: this node carries the local-node marker, so it is a local fork, not the chain it presents." >&2
    echo "       A real deploy never runs against a fork; to rehearse, run script/rehearse.sh." >&2
    return 1
  fi
  return 0
}

# rehearsal_key_var_names ENV_FILE — every name ending in PRIVATE_KEY that the
# environment or the file carries, one per line, names only.
rehearsal_key_var_names() {
  {
    compgen -v | grep -E 'PRIVATE_KEY$' || true
    if [ -f "$1" ]; then
      sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*PRIVATE_KEY)[[:space:]]*=.*/\2/p' "$1"
    fi
  } | sort -u
}

# rehearsal_enter RPC CONTRACTS_DIR ENV_FILE — enter rehearsal mode or refuse.
# Exports the flag, pins every key variable to zero, and points the record
# root and forge's broadcast and cache folders at the run's scratch folder.
rehearsal_enter() {
  local rpc="$1" contracts_dir="$2" env_file="$3" v
  [ "$REHEARSE" = 1 ] || return 0
  if ! rehearsal_root_ok "${VAIPAKAM_REHEARSAL_ROOT:-}"; then
    echo "Error: --rehearse needs VAIPAKAM_REHEARSAL_ROOT under $REHEARSAL_SCRATCH_PREFIX with no '..' segment." >&2
    echo "       Run the rehearsal through script/rehearse.sh, which prepares the folder." >&2
    return 1
  fi
  if ! rehearsal_is_loopback_url "$rpc"; then
    echo "Error: --rehearse refuses a node that is not on this machine (127.0.0.1, localhost or ::1)." >&2
    return 1
  fi
  if ! rehearsal_node_has_marker "$rpc"; then
    echo "Error: --rehearse refuses a node without the local-node marker; only a fork started by script/rehearse.sh carries it." >&2
    return 1
  fi
  for v in DEPLOYER_ADDRESS ADMIN_ADDRESS; do
    if [ -z "${!v:-}" ]; then
      echo "Error: --rehearse needs $v: a rehearsal signs as the role's stated address, never with a key." >&2
      return 1
    fi
  done
  export VAIPAKAM_REHEARSAL=1
  export VAIPAKAM_REHEARSAL_ROOT
  # Pin every key variable to zero. Forge reads `.env` by itself and keeps a
  # value already in the environment, so this is what keeps a key away from
  # forge, not only from this shell. A script that still asked for a key
  # would get zero, and Signers refuses a zero key outside a rehearsal.
  while IFS= read -r v; do
    [ -n "$v" ] && export "$v=0"
  done < <(rehearsal_key_var_names "$env_file")

  RECORDS_ROOT="$contracts_dir/$VAIPAKAM_REHEARSAL_ROOT"
  mkdir -p "$RECORDS_ROOT/.forge/broadcast" "$RECORDS_ROOT/.forge/cache"
  BROADCAST_ROOT="$RECORDS_ROOT/.forge/broadcast"
  export FOUNDRY_BROADCAST="$BROADCAST_ROOT"
  # Forge caches a forked chain's state on disk keyed by chain id and block
  # number. A fork keeps the real chain id, so a cached reading of the REAL
  # chain at the same block would stand in for the fork's state (without the
  # marker, without the run's own transactions). A rehearsal never uses it.
  export FOUNDRY_NO_STORAGE_CACHING=true
  export FOUNDRY_CACHE_PATH="$RECORDS_ROOT/.forge/cache"
  # Forge keeps a script's run file beside its compile cache, so the cache
  # moves with the broadcast folder. Seed the scratch cache with the real
  # compile index so nothing recompiles; the real cache is never written.
  if [ ! -f "$FOUNDRY_CACHE_PATH/solidity-files-cache.json" ] && [ -f "$contracts_dir/cache/solidity-files-cache.json" ]; then
    cp "$contracts_dir/cache/solidity-files-cache.json" "$FOUNDRY_CACHE_PATH/"
  fi
  echo "  · rehearsal: records, journals and forge's run cache go to $VAIPAKAM_REHEARSAL_ROOT"
  return 0
}

# rehearsal_set_roots CONTRACTS_DIR — the real run's roots. Call before
# rehearsal_enter, which replaces them.
rehearsal_set_roots() {
  RECORDS_ROOT="$1/deployments"
  BROADCAST_ROOT="${FOUNDRY_BROADCAST:-$1/broadcast}"
}

# vk_role_address ROLE — the role's address. A rehearsal reads only
# <ROLE>_ADDRESS. A real run derives it from <ROLE>_PRIVATE_KEY and requires it
# to equal <ROLE>_ADDRESS when that is set (Signers.sol enforces the stated
# address on a real chain; this mirrors it for the shell's own sends).
vk_role_address() {
  local role="$1" addr_var="${1}_ADDRESS" key_var="${1}_PRIVATE_KEY" derived stated
  stated="${!addr_var:-}"
  if [ "$REHEARSE" = 1 ]; then
    [ -n "$stated" ] || { echo "Error: a rehearsal needs $addr_var" >&2; return 1; }
    printf '%s\n' "$stated"
    return 0
  fi
  [ -n "${!key_var:-}" ] || { echo "Error: $key_var is not set" >&2; return 1; }
  derived=$(cast wallet address --private-key "${!key_var}" 2>/dev/null) || {
    echo "Error: $key_var is not a valid key (value withheld)" >&2; return 1; }
  if [ -n "$stated" ] && [ "$(printf '%s' "$stated" | tr 'A-F' 'a-f')" != "$(printf '%s' "$derived" | tr 'A-F' 'a-f')" ]; then
    echo "Error: $addr_var is not the address of $key_var" >&2
    return 1
  fi
  printf '%s\n' "$derived"
}

# vk_cast_send ROLE cast-send-args... — the one way the deploy scripts send a
# transaction from the shell. A real run signs with <ROLE>_PRIVATE_KEY; a
# rehearsal sends from <ROLE>_ADDRESS, which the fork has impersonated.
vk_cast_send() {
  local role="$1" key_var="${1}_PRIVATE_KEY" addr
  shift
  addr=$(vk_role_address "$role") || return 1
  if [ "$REHEARSE" = 1 ]; then
    cast send --unlocked --from "$addr" "$@"
  else
    cast send --private-key "${!key_var}" "$@"
  fi
}

# forge — shadows the binary for the deploy scripts that source this file. In
# a rehearsal, a broadcasting `forge script` gets forge's unlocked sending with
# the deployer as the default sender; the script's own Signers calls choose
# each transaction's sender among the impersonated role addresses, and the
# fork refuses any other. Every other forge call, and every call in a real
# run, passes through unchanged.
forge() {
  local a broadcasting=0
  if [ "$REHEARSE" = 1 ] && [ "${1:-}" = script ]; then
    for a in "$@"; do [ "$a" = "--broadcast" ] && broadcasting=1; done
    if [ "$broadcasting" = 1 ]; then
      command forge "$@" --unlocked --sender "$DEPLOYER_ADDRESS"
      return
    fi
  fi
  command forge "$@"
}
