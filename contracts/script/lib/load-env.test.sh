#!/usr/bin/env bash
# Cases for lib/load-env.sh's two modes (#1939). Bash only, no network.
#
# Each case runs in a FRESH bash, because the loader compares against the
# declarations the calling script started with (`__lenv_baseline`), exactly as
# a wrapper does on its first line.
#
# Run: bash contracts/script/lib/load-env.test.sh
# shellcheck disable=SC2016 # every case body is a script for the inner bash
set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/load-env.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
# case NAME EXPECTED_STATUS EXPECTED_STDOUT ENV_FILE_BODY SCRIPT [ENV...]
check() {
  local name="$1" want_status="$2" want_out="$3" body="$4" script="$5"
  shift 5
  printf '%s\n' "$body" > "$WORK/.env"
  local out status=0
  out="$(env -i PATH="$PATH" HOME="$WORK" "$@" bash -c '
    __lenv_baseline="$(declare -p $(compgen -v) 2>/dev/null)"
    SCRIPT_DIR="$1"
    source "$SCRIPT_DIR/lib/load-env.sh"
    ENVF="$2"
    '"$script" _ "$(dirname "$(dirname "$LIB")")" "$WORK/.env" 2>/dev/null)" || status=$?
  if [ "$status" = "$want_status" ] && [ "$out" = "$want_out" ]; then
    echo "ok    $name"
  else
    fails=$((fails + 1))
    echo "FAIL  $name"
    echo "      expected status $want_status, output [$want_out]"
    echo "      got      status $status, output [$out]"
  fi
}

# Default mode: the file replaces an exported value (the wrappers' rule).
check 'default mode: the file replaces an exported value' 0 'from-file' \
  'RPC_X=from-file' 'load_env_file "$ENVF" && printf %s "$RPC_X"' RPC_X=exported

check 'default mode: an unset name is filled' 0 'from-file' \
  'RPC_X=from-file' 'load_env_file "$ENVF" && printf %s "$RPC_X"'

# --fill-gaps: the operator's exported value wins; the file fills only gaps.
check '--fill-gaps: a non-empty exported value is kept' 0 'exported' \
  'RPC_X=from-file' 'load_env_file "$ENVF" --fill-gaps && printf %s "$RPC_X"' RPC_X=exported

check '--fill-gaps: an unset name is filled' 0 'from-file' \
  'RPC_X=from-file' 'load_env_file "$ENVF" --fill-gaps && printf %s "$RPC_X"'

check '--fill-gaps: an exported EMPTY value is filled' 0 'from-file' \
  'RPC_X=from-file' 'load_env_file "$ENVF" --fill-gaps && printf %s "$RPC_X"' RPC_X=

# The mode decides which acceptable value wins, never whether a refused name
# is let through.
check '--fill-gaps still refuses a startup hook' 1 '' \
  'BASH_ENV=/tmp/x' 'load_env_file "$ENVF" --fill-gaps'

check '--fill-gaps still refuses a startup hook the operator also exported' 1 '' \
  'NODE_OPTIONS=--require=/tmp/x' 'load_env_file "$ENVF" --fill-gaps' NODE_OPTIONS=

check '--fill-gaps still refuses a name the script created' 1 '' \
  'MINE=from-file' 'MINE=script; load_env_file "$ENVF" --fill-gaps'

check '--fill-gaps is atomic: a bad line exports nothing' 1 '' \
  $'RPC_X=ok\nnot a setting' 'load_env_file "$ENVF" --fill-gaps; s=$?; printf %s "${RPC_X:-}"; exit $s'

check 'an unknown option is refused before the file is read' 1 '' \
  'RPC_X=from-file' 'load_env_file "$ENVF" --keep; s=$?; printf %s "${RPC_X:-}"; exit $s'

# with-env.sh: the runbooks' replacement for `set -a; source .env`, run
# against a copy of the tree whose contracts/.env is a fixture.
TREE="$WORK/tree"
mkdir -p "$TREE/contracts/script/lib"
cp "$LIB" "$TREE/contracts/script/lib/"
cp "$(dirname "$(dirname "$LIB")")/with-env.sh" "$TREE/contracts/script/"
wrap_case() {
  local name="$1" want_status="$2" want_out="$3" body="$4"
  shift 4
  printf '%s\n' "$body" > "$TREE/contracts/.env"
  local out status=0
  out="$(cd "$TREE/contracts" && env -i PATH="$PATH" HOME="$WORK" \
    bash script/with-env.sh "$@" 2>"$WORK/stderr")" || status=$?
  if [ "$status" = "$want_status" ] && [ "$out" = "$want_out" ]; then
    echo "ok    $name"
  else
    fails=$((fails + 1))
    echo "FAIL  $name"
    echo "      expected status $want_status, output [$want_out]"
    echo "      got      status $status, output [$out]"
  fi
}

wrap_case 'with-env: the command sees the settings, expanded after the load' 0 'from-file' \
  'RPC_X=from-file' 'printf %s "$RPC_X"'

wrap_case 'with-env: the file is data, never executed' 0 'absent' \
  'RPC_X=$(touch pwned)' 'test -e pwned && printf pwned || printf absent'

wrap_case 'with-env: a refused file runs nothing' 1 '' \
  $'RPC_X=ok\nBASH_ENV=/tmp/x' 'printf ran'

wrap_case 'with-env: the loader state does not reach the command' 0 '' \
  'RPC_X=ok' 'printf %s "${__lenv_baseline:-}"'

wrap_case 'with-env: more than one argument is refused' 2 '' \
  'RPC_X=ok' 'printf' 'ran'

# A refusal names a line, never its content: a pasted secret with a stray `=`
# reads as a name, so neither the name nor the value may reach the terminal.
wrap_case 'with-env: a refused line is not echoed' 1 '' \
  '0xSECRETKEYMATERIAL nope' 'printf ran'
if grep -q SECRETKEYMATERIAL "$WORK/stderr"; then
  fails=$((fails + 1)); echo "FAIL  the refused line's content reached stderr"
else
  echo "ok    the refused line's content stays off stderr"
fi

if [ "$fails" -gt 0 ]; then
  echo "$fails load-env case(s) failed." >&2
  exit 1
fi
echo "All load-env cases pass."
