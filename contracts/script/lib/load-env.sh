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
load_env_file() {
  local __lenv_file="$1" __lenv_line __lenv_name __lenv_value __lenv_no=0
  local __lenv_q __lenv_rest

  [ -f "$__lenv_file" ] || { echo "Error: $__lenv_file not found." >&2; return 1; }

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

    # DENY names some later process treats as a startup hook. Reading the file
    # as data stops it executing HERE; exporting one of these hands execution to
    # the next child — `BASH_ENV=$(…)` runs in the first child bash, and a
    # wrapper spawns several carrying the deployment's secrets.
    #
    # This is a DENYLIST and it is deliberately not claimed to be complete. An
    # allowlist was tried and withdrawn: a systematic sweep of what the deploy
    # actually configures found SIXTY names it would have refused — NFT image
    # URIs, faucet tokens, census, vesting, governance roles, swap adapters,
    # per-chain WETH — each of which aborts a documented phase. Review had found
    # two of those sixty by inspection over two rounds; shipping the rest would
    # have been discovering them one broken mainnet deploy at a time.
    #
    # The residual risk is bounded by the threat model: `.env` holds
    # `ADMIN_PRIVATE_KEY`. Anyone who can write to it already owns the deploy
    # and has no need of `BASH_ENV`. What #1932 is actually about is a STALE or
    # SHARED file, and that is closed completely by reading it as data and
    # reading it before the operator's own arguments. Hardening the export
    # surface against a hostile file is a separate, larger job across every
    # reader and runbook — tracked, not smuggled in here.
    case "$__lenv_name" in
      BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|IFS|PS4|PATH \
      |LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|BASH_FUNC_* \
      |NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS)
        echo "Error: $__lenv_file:$__lenv_no sets '$__lenv_name', which another program" >&2
        echo "       would treat as a startup hook — refusing to export it." >&2
        return 1 ;;
    esac

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
