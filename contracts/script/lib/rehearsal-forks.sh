# shellcheck shell=bash
# ── A deploy rehearsal's forks, clock and redactor (#3891, design §14) ────
#
# Sourced by `script/rehearse.sh`. The forks live as long as the driver: one
# anvil per chain, forked from the chain's RPC at a block a safe depth behind
# the head, on loopback, with the REAL chain id, carrying the local-node marker
# and with only the role addresses impersonated.
#
# The launcher is shell rather than a function in packages/anvil-harness
# because the forks must outlive every step the driver runs (each a separate
# forge, cast or node process), and the driver is the one process that does.
# The harness's runners (#3894) receive the fork URLs this file prints.
#
# A fork URL carries a provider key. Nothing here echoes one: anvil's output
# goes through rh_redact into the run's log, and every log and the report
# pass through the same redactor.

# shellcheck source=rehearsal.sh
source "$(dirname "${BASH_SOURCE[0]}")/rehearsal.sh"

RH_SAFE_DEPTH="${RH_SAFE_DEPTH:-12}"
RH_FORK_PIDS=()

# rh_secret_names — the environment names whose values must never reach a log:
# every RPC URL and every key variable.
rh_secret_names() {
  compgen -v | grep -E '(RPC_URL|_RPC|RPC_URLS|PRIVATE_KEY|API_KEY|_TOKEN)$' | grep -v '^RH_' || true
}

# rh_redact — a filter: every value of a name rh_secret_names lists is
# replaced by `${NAME}`. Literal matching (no regex), longest value first so a
# URL that contains another is replaced whole. Values shorter than 8
# characters are left alone, since a pinned "0" key would otherwise blank
# every zero in the log.
rh_redact() {
  local n pairs=()
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    local v="${!n:-}"
    [ "${#v}" -ge 8 ] && pairs+=("$n" "$v")
  done < <(rh_secret_names)
  # Unit-separator joined: an environment value cannot carry a NUL, and no
  # URL or key carries U+001F.
  RH_PAIRS="$(printf '%s\037' "${pairs[@]+"${pairs[@]}"}")" awk '
    BEGIN {
      n = split(ENVIRON["RH_PAIRS"], kv, "\037")
      m = 0
      for (i = 1; i + 1 <= n; i += 2) { m++; name[m] = kv[i]; val[m] = kv[i + 1] }
      # longest value first
      for (i = 1; i <= m; i++) for (j = i + 1; j <= m; j++)
        if (length(val[j]) > length(val[i])) { t = val[i]; val[i] = val[j]; val[j] = t; t = name[i]; name[i] = name[j]; name[j] = t }
    }
    {
      line = $0
      for (i = 1; i <= m; i++) {
        out = ""
        while ((p = index(line, val[i])) > 0) {
          out = out substr(line, 1, p - 1) "${" name[i] "}"
          line = substr(line, p + length(val[i]))
        }
        line = out line
      }
      print line
      fflush()
    }'
}

# rh_fork_start SLUG CHAIN_ID RPC_VAR PORT LOG_DIR ADDRESS... — start one fork
# and set RH_LAST_URL to its loopback URL. Every ADDRESS is impersonated;
# nothing else is (`--accounts 0`: anvil's own development accounts, which it
# would otherwise sign for, do not exist on a rehearsal fork). Call it directly, never in `$(...)`: the fork's process id
# must reach this shell so rh_fork_stop_all can stop it.
rh_fork_start() {
  local slug="$1" chain_id="$2" rpc_var="$3" port="$4" log_dir="$5"
  shift 5
  local src="${!rpc_var:-}" url="http://127.0.0.1:$port" head block pid a i
  if [ -z "$src" ]; then
    echo "Error: $slug: $rpc_var is not set, so there is nothing to fork" >&2
    return 1
  fi
  if cast chain-id --rpc-url "$url" >/dev/null 2>&1; then
    echo "Error: $slug: something already answers on $url; a rehearsal needs a fresh node" >&2
    return 1
  fi
  head=$(cast block-number --rpc-url "$src" 2>/dev/null) || {
    echo "Error: $slug: could not read the head block from \$$rpc_var" >&2; return 1; }
  block=$((head - RH_SAFE_DEPTH))
  mkdir -p "$log_dir"
  anvil --fork-url "$src" --fork-block-number "$block" --chain-id "$chain_id" \
    --host 127.0.0.1 --port "$port" --accounts 0 > >(rh_redact > "$log_dir/anvil-$slug.log") 2>&1 &
  pid=$!
  RH_FORK_PIDS+=("$pid")
  for i in $(seq 1 300); do
    if [ "$(cast chain-id --rpc-url "$url" 2>/dev/null)" = "$chain_id" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Error: $slug: the fork exited before it answered (see anvil-$slug.log)" >&2
      return 1
    fi
    sleep 0.2
  done
  [ "$(cast chain-id --rpc-url "$url" 2>/dev/null)" = "$chain_id" ] || {
    echo "Error: $slug: the fork did not answer with chain id $chain_id" >&2; return 1; }
  cast rpc --rpc-url "$url" anvil_setCode "$REHEARSAL_MARKER_ADDRESS" "$REHEARSAL_MARKER_CODE" >/dev/null || return 1
  for a in "$@"; do
    [ -n "$a" ] || continue
    cast rpc --rpc-url "$url" anvil_impersonateAccount "$a" >/dev/null || return 1
  done
  printf '%s\t%s\t%s\t%s\n' "$slug" "$chain_id" "$block" "$url" >> "$log_dir/forks.tsv"
  RH_LAST_URL="$url"
}

# rh_fork_stop_all — stop every fork this driver started.
rh_fork_stop_all() {
  local pid
  for pid in "${RH_FORK_PIDS[@]+"${RH_FORK_PIDS[@]}"}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${RH_FORK_PIDS[@]+"${RH_FORK_PIDS[@]}"}"; do
    wait "$pid" 2>/dev/null || true
  done
  RH_FORK_PIDS=()
}

# rh_clock_set TIMESTAMP URL... — move every fork to the same time and mine a
# block there. The forks never drift apart: reward days on Base and on the
# mirrors are compared across chains. Refuses to move a fork backwards.
rh_clock_set() {
  local ts="$1" url now
  shift
  for url in "$@"; do
    now=$(cast block latest --field timestamp --rpc-url "$url" 2>/dev/null) || return 1
    if [ "$ts" -lt "$now" ]; then
      echo "Error: the clock cannot move a fork backwards ($ts < $now)" >&2
      return 1
    fi
  done
  for url in "$@"; do
    cast rpc --rpc-url "$url" evm_setNextBlockTimestamp "$ts" >/dev/null || return 1
    cast rpc --rpc-url "$url" evm_mine >/dev/null || return 1
  done
}

# rh_clock_align URL... — move every fork to the latest of their times, so a
# run starts with one clock.
rh_clock_align() {
  local url t max=0
  for url in "$@"; do
    t=$(cast block latest --field timestamp --rpc-url "$url" 2>/dev/null) || return 1
    [ "$t" -gt "$max" ] && max=$t
  done
  rh_clock_set "$((max + 1))" "$@"
}
