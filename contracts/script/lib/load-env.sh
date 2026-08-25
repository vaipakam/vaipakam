# shellcheck shell=bash
# ── Read `.env` as DATA ───────────────────────────────────────────────────
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
# The loader accepts any valid identifier EXCEPT: names another program treats
# as a startup hook, names the calling script or the shell owns, and this
# loader's own namespace. An allowlist of documented settings was implemented
# and WITHDRAWN — a systematic sweep found sixty settings it would have refused,
# each aborting a documented deploy phase (#1939 carries that work). The header
# described the allowlist for two rounds after it was removed, which is the
# documentation-drift defect this session merged #1926 to fix.
#
load_env_file() {
  local __lenv_file="$1" __lenv_line __lenv_name __lenv_value __lenv_no=0
  local __lenv_q __lenv_rest __lenv_i
  local __lenv_names=() __lenv_vals=()

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
      # NOTHING from the file reaches the output — not the line, and not the
      # NAME. r9 withheld the line on THIS branch and left the invalid-name
      # branch printing `$__lenv_name`, which is everything before the first
      # `=`: an operator writing `DEPLOYER_PRIVATE_KEY 0xSECRET=` put the key
      # on stderr through the branch the fix had not covered (Codex #1938
      # r10). The same defect, one round later, in the neighbouring branch.
      # Line CONTENT is never printed. `.env` holds `DEPLOYER_PRIVATE_KEY`, and
      # a missing `=` on that line would have put the key on stderr — into any
      # logged terminal or CI-style operator session (Codex #1938 r9). A syntax
      # error must not become a credential disclosure.
      echo "Error: $__lenv_file:$__lenv_no is not NAME=value (content withheld)." >&2
      return 1 ;;
    esac
    __lenv_name="${__lenv_line%%=*}"
    __lenv_value="${__lenv_line#*=}"

    # The loader's OWN namespace. Renaming internals to `__lenv_*` was
    # obscurity, not protection — `.env` can simply name the new spelling, and
    # `export` inside this function writes the LOCAL, so
    # `__lenv_no=BASH_VERSINFO[$(touch …)]` was executed at the next `$(( ))`
    # again once the allowlist that had been catching it was withdrawn
    # (Codex #1938 r8). Unlike the open-ended startup-hook list, this namespace
    # IS closed: it is whatever this file declares, and this file declares only
    # `__lenv_*`.
    # CALLER-OWNED and shell-special names. Reserving only `__lenv_*` protected
    # the loader and left the CALLER exposed: `SCRIPT_DIR=/tmp/old-tools` in a
    # stale `.env` is exported into the wrapper's own variable, and the wrapper
    # then runs `bash "$SCRIPT_DIR/predeploy-check.sh"` — arbitrary code with
    # the deployment's credentials, through a door the hook denylist does not
    # cover (Codex #1938 r9).
    #
    # The bash specials are here for a different reason: `export UID=1000`
    # terminates a non-interactive shell, which defeated both the atomic commit
    # and the emergency path's non-fatal handling.
    case "$__lenv_name" in
      SCRIPT_DIR|CONTRACTS_DIR|REPO_ROOT|ROOT_DIR \
      |UID|EUID|PPID|BASHPID|FUNCNAME|LINENO|RANDOM|SECONDS \
      |BASH_ARGV|BASH_SOURCE|BASH_VERSINFO|BASH_LINENO|PWD|OLDPWD|HOME|HISTFILE)
        echo "Error: $__lenv_file:$__lenv_no sets a withheld name, which the calling" >&2
        echo "       script or the shell itself owns — refusing." >&2
        return 1 ;;
    esac

    case "$__lenv_name" in __lenv_*)
      echo "Error: $__lenv_file:$__lenv_no sets a withheld name, which is this loader's" >&2
      echo "       own internal namespace — refusing." >&2
      return 1 ;;
    esac

    case "$__lenv_name" in '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "Error: $__lenv_file:$__lenv_no invalid variable name a withheld name." >&2
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
        echo "Error: $__lenv_file:$__lenv_no sets a withheld name, which another program" >&2
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

    __lenv_names[${#__lenv_names[@]}]="$__lenv_name"
    __lenv_vals[${#__lenv_vals[@]}]="$__lenv_value"
  done < "$__lenv_file"

  # ATOMIC. Exporting as we went left a rejected file PARTIALLY applied — the
  # settings above the bad line were live, and callers that treat a load
  # failure as non-fatal (the emergency pause path) then ran on half a
  # configuration (Codex #1938 r8). Nothing is exported until the whole file
  # has parsed.
  # PREFLIGHT assignability. Staging made the parse atomic but not the COMMIT:
  # a readonly name aborts the shell mid-export, so earlier pairs are live and
  # the caller never regains control — the emergency path could not even warn
  # (Codex #1938 r9). Check every name is writable before writing any.
  __lenv_i=0
  while [ "$__lenv_i" -lt "${#__lenv_names[@]}" ]; do
    if readonly -p 2>/dev/null | grep -q "declare -[a-zA-Z-]*r[a-zA-Z-]* ${__lenv_names[$__lenv_i]}="; then
      echo "Error: $__lenv_file sets a withheld name, which is readonly here." >&2
      return 1
    fi
    __lenv_i=$((__lenv_i + 1))
  done

  __lenv_i=0
  while [ "$__lenv_i" -lt "${#__lenv_names[@]}" ]; do
    export "${__lenv_names[$__lenv_i]}=${__lenv_vals[$__lenv_i]}"
    __lenv_i=$((__lenv_i + 1))
  done
}
