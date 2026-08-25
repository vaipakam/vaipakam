# shellcheck shell=bash
# ── Read `.env` as DATA, against an ALLOWLIST ─────────────────────────────
#
# #1932 / #1938. Two separate properties, both needed, both learned the hard
# way over five review rounds:
#
#   1. NEVER `source` it. Sourcing executes the file in this shell. Four
#      demonstrated ways through a restore-afterwards design: redefine the
#      restore list; `readonly` a target so `printf -v` fails; `set +e` so the
#      failure is not fatal; `printf() { :; }`; and finally `set -- …`, which
#      supplies the command line the file was supposed to lose to.
#
#   2. LOAD BEFORE PARSING. Reading as data does not stop a plain `FRESH=1`
#      overwriting a parsed `0` — the original #1932 bug. I removed the
#      ordering once on the reasoning that data-loading made it unnecessary;
#      it does not.
#
# ── Why an ALLOWLIST, having argued for a denylist and been wrong ─────────
#
# The denylist blocked names the SHELL acts on. It missed the ones every other
# runtime acts on (`NODE_OPTIONS=--require=…` runs code in the first `node`
# the deploy starts), and it missed this loader's OWN locals: a file setting
# `lineno=BASH_VERSINFO[$(touch /tmp/owned)]` was picked up by the counter and
# executed at the next `$(( ))`. Verified — the marker appeared.
#
# Those are not oversights to patch. A denylist has to enumerate every name
# any current or future child process treats as executable, which is open
# ended; an allowlist enumerates what THIS project configures, which is
# written down already. The failure modes are asymmetric and that is the
# whole argument: an allowlist that is short a name STOPS the deploy with a
# message naming it, and a denylist that is short a name runs the payload.
#
# The allowlist is `.env.example` — the documented configuration surface —
# plus the handful below that the scripts read but that file does not yet
# declare. Adding a setting means documenting it, which was already the rule.
__lenv_extra_allowed="FORK_URL_MAINNET FORK_URL_BASE_SEPOLIA POST_HANDOVER
UNPAUSE_TIMELOCK_DELAY UNPAUSE_TIMELOCK_SALT SYNC_FORCE FORGE_GAS_MULTIPLIER
BASE_REWARD_DEPLOYMENT MIRROR_REWARD_DEPLOYMENTS CCIP_ROUTER CCIP_RMN_PROXY"

# Internals carry a `__lenv_` prefix so nothing in the loaded file can collide
# with them. The allowlist already refuses a lowercase `lineno`; this is the
# second lock on the same door, because the first one was picked.
load_env_file() {
  local __lenv_file="$1" __lenv_line __lenv_name __lenv_value __lenv_no=0
  local __lenv_allowed __lenv_ex

  [ -f "$__lenv_file" ] || { echo "Error: $__lenv_file not found." >&2; return 1; }

  __lenv_ex="$(dirname "$__lenv_file")/.env.example"
  [ -f "$__lenv_ex" ] || { echo "Error: $__lenv_ex missing; cannot validate .env." >&2; return 1; }
  __lenv_allowed=" $(sed 's/#.*//' "$__lenv_ex" \
      | grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' \
      | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=$//' \
      | tr '\n' ' ')$(echo $__lenv_extra_allowed) "

  while IFS= read -r __lenv_line || [ -n "$__lenv_line" ]; do
    __lenv_no=$((__lenv_no + 1))
    __lenv_line="${__lenv_line%$'\r'}"
    __lenv_line="${__lenv_line#"${__lenv_line%%[![:space:]]*}"}"
    case "$__lenv_line" in
      '' | '#'*) continue ;;
      'export '*) __lenv_line="${__lenv_line#export }" ;;
    esac

    case "$__lenv_line" in *=*) : ;; *)
      echo "Error: $__lenv_file:$__lenv_no is not NAME=value: $__lenv_line" >&2
      return 1 ;;
    esac
    __lenv_name="${__lenv_line%%=*}"
    __lenv_value="${__lenv_line#*=}"

    case "$__lenv_name" in '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "Error: $__lenv_file:$__lenv_no invalid variable name '$__lenv_name'." >&2
      return 1 ;;
    esac

    case "$__lenv_allowed" in
      *" $__lenv_name "*) : ;;
      *) echo "Error: $__lenv_file:$__lenv_no sets '$__lenv_name', which is not a documented setting." >&2
         echo "       Add it to .env.example if it is one; nothing else is loaded." >&2
         return 1 ;;
    esac

    # Quoted value: strip the quotes AND any comment after them, as `source`
    # would. Unquoted: strip an inline comment. The loader must not change the
    # meaning of a file that already worked under `source`.
    case "$__lenv_value" in
      \"*)  __lenv_value="${__lenv_value#\"}"; __lenv_value="${__lenv_value%%\"*}" ;;
      \'*)  __lenv_value="${__lenv_value#\'}"; __lenv_value="${__lenv_value%%\'*}" ;;
      *' #'*)   __lenv_value="${__lenv_value%% #*}" ;;
      *$'\t#'*) __lenv_value="${__lenv_value%%$'\t#'*}" ;;
    esac
    __lenv_value="${__lenv_value%"${__lenv_value##*[![:space:]]}"}"

    export "$__lenv_name=$__lenv_value"
  done < "$__lenv_file"
}
