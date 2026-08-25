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
# `CONFIGURE_VPFI_PEG` and `SKIP_VPFI` are on that list deliberately even
# though the wrappers force both: `.env.example` tells operators a stale value
# "is inert at launch", and deploy-mainnet.sh promises a stale
# `CONFIGURE_VPFI_PEG` "is forced off". Refusing them would replace documented,
# harmless inertness with a hard deploy failure — a hardening change breaking a
# behaviour the documentation guarantees. They load, and the forcing downstream
# is what makes them not decide anything.
#
# The allowlist is `.env.example` — the documented configuration surface —
# plus the handful below that the scripts read but that file does not yet
# declare. Adding a setting means documenting it, which was already the rule.
__lenv_extra_allowed="FORK_URL_MAINNET FORK_URL_BASE_SEPOLIA POST_HANDOVER
UNPAUSE_TIMELOCK_DELAY UNPAUSE_TIMELOCK_SALT SYNC_FORCE FORGE_GAS_MULTIPLIER
BASE_REWARD_DEPLOYMENT MIRROR_REWARD_DEPLOYMENTS CCIP_ROUTER CCIP_RMN_PROXY
CONFIGURE_VPFI_PEG SKIP_VPFI"

# Name SHAPES this project configures. Needed because `.env.example` documents
# only the testnet chains: EVERY mainnet RPC name (`ETHEREUM_RPC_URL`,
# `BASE_RPC_URL`, …) is absent from it, so a documented-names-only allowlist
# refused exactly the settings `deploy-mainnet.sh` requires — the outage I said
# I had checked for and had not (Codex #1938 r6).
#
# My check could not have found them: the wrappers reach those names through
# `RPC_VAR="ETHEREUM_RPC_URL"` and `${!RPC_VAR}`, so they never appear as a
# direct expansion, and I looked for direct expansions.
#
# The shapes stay fail-closed. No runtime startup hook is spelled like any of
# them: `NODE_OPTIONS`, `BASH_ENV`, `PYTHONSTARTUP`, `PERL5OPT`, `LD_PRELOAD`
# and a lowercase `lineno` all match none.
__lenv_allowed_shapes="*_RPC_URL *_PRIVATE_KEY *_API_KEY *_ADDRESS *_DEPLOY_BLOCK
CCIP_* VPFI_* FORK_URL_* *_CHAIN_ID *_ETHERSCAN_KEY"

# Internals carry a `__lenv_` prefix so nothing in the loaded file can collide
# with them. The allowlist already refuses a lowercase `lineno`; this is the
# second lock on the same door, because the first one was picked.
load_env_file() {
  local __lenv_file="$1" __lenv_line __lenv_name __lenv_value __lenv_no=0
  local __lenv_allowed __lenv_ex __lenv_ok __lenv_shape __lenv_q __lenv_rest

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

    __lenv_ok=0
    case "$__lenv_allowed" in *" $__lenv_name "*) __lenv_ok=1 ;; esac
    if [ "$__lenv_ok" = "0" ]; then
      for __lenv_shape in $__lenv_allowed_shapes; do
        # shellcheck disable=SC2254
        case "$__lenv_name" in $__lenv_shape) __lenv_ok=1; break ;; esac
      done
    fi
    if [ "$__lenv_ok" = "0" ]; then
      echo "Error: $__lenv_file:$__lenv_no sets '$__lenv_name', which is neither a documented" >&2
      echo "       setting nor a recognised configuration name. Add it to .env.example." >&2
      return 1
    fi

    # Quoted value: strip the quotes AND any comment after them, as `source`
    # would. Unquoted: strip an inline comment. The loader must not change the
    # meaning of a file that already worked under `source`.
    # A quoted value must CLOSE, and after the closing quote only whitespace or
    # a comment may follow. The previous version took everything up to the
    # first closing quote and discarded the rest, so
    # `RPC="https://…/v2/"$ALCHEMY_API_KEY` silently exported the prefix alone —
    # a truncated endpoint, or a credential quietly changed, with no warning.
    # It also accepted an unterminated quote. Both refuse now (Codex #1938 r6).
    case "$__lenv_value" in
      \"*|\'*)
        __lenv_q="${__lenv_value:0:1}"
        __lenv_rest="${__lenv_value:1}"
        case "$__lenv_rest" in
          *"$__lenv_q"*) : ;;
          *) echo "Error: $__lenv_file:$__lenv_no has an unterminated quote." >&2
             return 1 ;;
        esac
        __lenv_value="${__lenv_rest%%"$__lenv_q"*}"
        __lenv_rest="${__lenv_rest#*"$__lenv_q"}"
        case "$__lenv_rest" in
          '' | [[:space:]]*'#'* | [[:space:]] | '#'*) : ;;
          *[![:space:]]*) echo "Error: $__lenv_file:$__lenv_no has text after the closing quote;" >&2
             echo "       composite values are not supported — quote the whole value." >&2
             return 1 ;;
        esac
        ;;
      *' #'*)   __lenv_value="${__lenv_value%% #*}" ;;
      *$'\t#'*) __lenv_value="${__lenv_value%%$'\t#'*}" ;;
    esac
    __lenv_value="${__lenv_value%"${__lenv_value##*[![:space:]]}"}"

    export "$__lenv_name=$__lenv_value"
  done < "$__lenv_file"
}
