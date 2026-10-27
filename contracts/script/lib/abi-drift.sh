#!/usr/bin/env bash
#
# abi-drift.sh — classify how a committed ABI differs from the compiled one.
# Sourced, never executed.
#
# Why the classes matter (#1564): every facet that imports IVaipakamErrors
# carries the whole shared error list, so adding or removing ONE custom error
# changes every such facet's ABI. Compared whole, the keeper bot's committed
# ABIs therefore read "stale" after nearly every contract PR, while the bot's
# calls are unaffected. A warning that is always on is a warning nobody reads,
# and it buries the drift that does break the bot: a function whose
# selector, arguments or result changed.
#
# So the drift is split into what it can break:
#   calls  — a function, constructor, fallback or receive entry differs.
#            Calldata the bot encodes, or a result it decodes, may no longer
#            match the Diamond.
#   decode — only error or event entries differ. Every call still encodes
#            and decodes correctly; what degrades is naming: a revert or
#            event the committed ABI does not list surfaces as raw bytes.
#   none   — identical, entry order and key order aside.
#
# An ABI that does not parse is reported as `calls`: nothing about it can be
# vouched for.

# abi_entries <file> <kind>
#   Print one canonical line (keys sorted) per ABI entry of <kind>, sorted:
#   `calls` = function/constructor/fallback/receive entries, `decode` =
#   error/event entries, `other` = any other entry (solc emits none today).
#   Fails when <file> is not a JSON array.
abi_entries() {
  local file="$1" kind="$2" filter
  case "$kind" in
    calls) filter='select(.type == "function" or .type == "constructor" or .type == "fallback" or .type == "receive")' ;;
    decode) filter='select(.type == "error" or .type == "event")' ;;
    other) filter='select((.type == "function" or .type == "constructor" or .type == "fallback" or .type == "receive" or .type == "error" or .type == "event") | not)' ;;
    *) echo "abi_entries: unknown kind '$kind'" >&2; return 2 ;;
  esac
  local out
  jq -e 'type == "array" and all(.[]; type == "object")' "$file" >/dev/null 2>&1 || return 1
  out="$(jq -S -c ".[] | $filter" "$file")" || return 1
  [ -z "$out" ] || printf '%s\n' "$out" | LC_ALL=C sort
}

# abi_drift_kind <committed-file> <compiled-file>
#   Print `none`, `decode` or `calls` (see the header).
abi_drift_kind() {
  local committed="$1" compiled="$2" a b
  if ! a="$(abi_entries "$committed" calls)" || ! b="$(abi_entries "$compiled" calls)"; then
    echo calls
    return 0
  fi
  if [ "$a" != "$b" ]; then
    echo calls
    return 0
  fi
  # An entry of a type outside both classes is never ignored: nothing is
  # known about what it can break, so it counts as call drift. Checked
  # before the decode class so a mixed difference is never reported as the
  # milder one.
  if [ "$(abi_entries "$committed" other)" != "$(abi_entries "$compiled" other)" ]; then
    echo calls
    return 0
  fi
  if [ "$(abi_entries "$committed" decode)" != "$(abi_entries "$compiled" decode)" ]; then
    echo decode
    return 0
  fi
  echo none
}
