#!/usr/bin/env bash
# FIRST statement, before ANY assignment: the declarations `load_env_file`
# compares each `.env` name against (see lib/load-env.sh and deploy-chain.sh).
# shellcheck disable=SC2046
__lenv_baseline="$(declare -p $(compgen -v) 2>/dev/null)"
#
# with-env.sh — run a hand-typed command with contracts/.env loaded AS DATA.
#
# #1939. The runbooks used to say `set -a; source .env; set +a` before a
# credential-bearing forge run. `source` EXECUTES the file in the operator's
# shell, and anything it exports (`BASH_ENV`, `NODE_OPTIONS`, …) runs again in
# every child that carries the deploy keys. The deploy wrappers stopped doing
# that in #1938; this gives a typed command the same reader, `load_env_file`
# (lib/load-env.sh): plain `NAME=value` lines only, nothing expanded, the
# startup-hook and request-redirect names refused, and nothing exported unless
# the whole file parses.
#
# USAGE (from contracts/)
#   bash script/with-env.sh 'COMMANDS'
#       Runs COMMANDS in bash with the settings exported. Single-quote them, so
#       `$NAME` is expanded by that bash, after the load, not by your shell
#       before it.
#   bash script/with-env.sh
#       Opens an interactive bash holding the settings, for a runbook section
#       of several commands. `exit` returns to your own shell, which never
#       held them.
#
# A refused file stops here with a line number and no content, and nothing
# runs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$#" -gt 1 ]; then
  echo "Error: pass the commands as ONE single-quoted argument, or none for a shell." >&2
  exit 2
fi

# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
if ! load_env_file "$CONTRACTS_DIR/.env"; then
  echo "contracts/.env was NOT loaded (see the error above); nothing was run." >&2
  exit 1
fi
unset __lenv_baseline

if [ "$#" -eq 1 ]; then
  exec bash -c "$1"
fi
echo "with-env: a shell holding contracts/.env (read as data). Type \`exit\` when done." >&2
exec bash -i
