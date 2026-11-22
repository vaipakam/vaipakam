#!/usr/bin/env bash
# env-values.sh ENV_FILE NAME... — prints each named variable as the deploy
# resolves it: ENV_FILE read by the deploy loader (load-env.sh) over this
# process's environment, key variables dropped. Output is NUL-separated
# name/value pairs, only for names that are set. Used by deploy-plan.mjs so
# the plan and the deploy share one .env parser (#3891).
# Exit 3: the loader could not be sourced; 4: the loader refused the file.
__lenv_baseline="$(declare -p $(compgen -v) 2>/dev/null)"
# shellcheck source=load-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh" || exit 3
load_env_file "$1" --drop-key-vars >&2 || exit 4
shift
for n in "$@"; do
  if [ -n "${!n+set}" ]; then printf '%s\0%s\0' "$n" "${!n}"; fi
done
