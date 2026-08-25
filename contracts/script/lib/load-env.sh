# shellcheck shell=bash
# ── Read `.env` as DATA, never as code ────────────────────────────────────
#
# #1932 / #1938. The deploy wrappers used `set -a; source .env; set +a`, which
# EXECUTES the file in the deployment shell. Three successive attempts to make
# that safe all failed, and the failures were not variations — each showed the
# same thing from a new angle:
#
#   1. `.env` redefining the list of protected names disarmed the restore loop.
#   2. `readonly NAME=1` made `printf -v` fail, and `set +e` in the same file
#      stopped the failure being fatal.
#   3. `printf() { :; }` turned every restore into a silent no-op.
#   4. Loading BEFORE parsing did not help either: `set -- base --fresh …`
#      inside the file replaces the caller's `$@`, so the file can supply the
#      command line it is supposed to lose to.
#
# There is no ordering, no restore and no re-assertion that survives arbitrary
# code running in the same shell. The only fix is to stop running it.
#
# This loader reads the file line by line and exports plain `NAME=value` pairs.
# No `source`, no `eval`, no command substitution, no `$` expansion of values —
# an RPC URL containing `$` survives intact, which the old path could mangle.
#
# A line it cannot parse is a HARD ERROR rather than a skip. A skipped line is a
# setting the operator believes is in effect and is not, which on a deploy path
# is the same class of defect as the one this replaces.
load_env_file() {
  local file="$1" line name value lineno=0

  [ -f "$file" ] || { echo "Error: $file not found." >&2; return 1; }

  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"                       # tolerate CRLF checkouts
    line="${line#"${line%%[![:space:]]*}"}"    # strip leading whitespace
    case "$line" in
      '' | '#'*) continue ;;
      'export '*) line="${line#export }" ;;
    esac

    name="${line%%=*}"
    value="${line#*=}"

    case "$line" in *=*) : ;; *)
      echo "Error: $file:$lineno is not NAME=value and was not loaded: $line" >&2
      return 1 ;;
    esac
    case "$name" in
      '' | [0-9]* | *[!A-Za-z0-9_]*)
        echo "Error: $file:$lineno has an invalid variable name '$name'." >&2
        return 1 ;;
    esac

    # Matching outer quotes are stripped, as `source` would have done, so an
    # existing quoted `.env` keeps working.
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac

    export "$name=$value"
  done < "$file"
}
