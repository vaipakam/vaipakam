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
  # FAIL CLOSED: a wrapper that never took the baseline gets no import at all,
  # rather than an import with the wrapper-owned rule silently disabled.
  if [ -z "${__lenv_baseline+set}" ]; then
    echo "Error: load_env_file called without __lenv_baseline." >&2
    echo "       Add \`__lenv_baseline=\"\$(compgen -v)\"\` as the first" >&2
    echo "       statement of the calling script, before any assignment." >&2
    return 1
  fi
  local __lenv_file="$1" __lenv_line __lenv_name __lenv_value __lenv_no=0
  local __lenv_q __lenv_rest __lenv_i __lenv_decl
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
    # CALLER-OWNED / ATTRIBUTED names, derived from the SHELL rather than
    # listed. `declare -p NAME` reports what the shell already holds:
    #
    #   `declare --`  a plain variable the calling script created  -> refuse
    #   `declare -x`  an exported variable inherited from the env  -> allow
    #   `declare -ir` integer / readonly / array attributes        -> refuse
    #
    # Listing names failed five times here — `SCRIPT_DIR` was reserved and
    # `DEPLOY_ROOT`, `SENTINEL_DIR`, `PAUSE_BUDGET_S`, then
    # `TREE_COMMIT_AT_START`, `DEFI_DIR`, `KEEPER_DIR` and the rest were not,
    # and an integer-attributed `OPTIND=BASH_VERSINFO[$(touch …)]` executed on
    # export regardless (Codex #1938 r11). The shell already knows all of this;
    # asking it is closed where a list is not.
    #
    # Exported names are allowed through so a `.env` can still supply the RPC
    # URLs and keys the operator's environment may also carry.
    # Names that MUST exist before this loader can run, refused regardless of
    # how the shell holds them. The derived rule below allows `declare -x`, so
    # that an operator's exported RPC URL can still be overridden by `.env` —
    # but a wrapper variable INHERITED as exported then looked identical, and
    # `SCRIPT_DIR=/tmp/attacker` was accepted, which the wrapper follows into
    # `bash "$SCRIPT_DIR/predeploy-check.sh"` (Codex #1938 r12).
    #
    # Three names, and they are stable: they are the ones this file needs in
    # order to be sourced at all, so the list cannot grow with the callers.
    # WRAPPER-OWNED names, DERIVED — not a list.
    #
    # r12 refused `SCRIPT_DIR`, `CONTRACTS_DIR` and `REPO_ROOT` by name, and I
    # argued that was a closed set because they must exist before this file can
    # be sourced. That was the wrong closure: the wrappers set a dozen more
    # names before they read `.env` — `DEFI_DIR`, `TREE_COMMIT_AT_START` and the
    # rest — and inheriting any of them as EXPORTED made it indistinguishable
    # from operator configuration, so `.env` could replace it. `DEFI_DIR` is a
    # directory a later Cloudflare phase runs `pnpm` from (Codex #1938 r15).
    #
    # So the set is computed instead: each wrapper records its variable names on
    # its FIRST line, before assigning anything, and the difference against the
    # names present now is exactly what the script created. That covers every
    # wrapper variable, including ones added later, with nothing to maintain —
    # and it subsumes the three names above, which are simply members of it.
    # Compare the name's DECLARATION against the baseline, not just its presence.
    # r15 compared name SETS, which misses the case the whole rule exists for: a
    # name INHERITED as exported is already in the baseline, so reassigning it
    # adds no name and clears no attribute, and the difference excluded it — the
    # `declare -x` arm below then let `.env` replace it. That is the r12
    # condition, reopened by my own generalisation (Codex #1938 r16).
    #
    # A declaration differs when the script created the name OR changed its
    # value or attributes, which is exactly "the script owns this".
    __lenv_now_decl="$(declare -p "$__lenv_name" 2>/dev/null || true)"
    __lenv_base_decl="$(printf '%s\n' "$__lenv_baseline" \
      | grep -m1 -E "^declare -[a-zA-Z-]+ ${__lenv_name}=" || true)"
    if [ "$__lenv_now_decl" != "$__lenv_base_decl" ]; then
      echo "Error: $__lenv_file:$__lenv_no sets a name this script created or" >&2
      echo "       changed before reading the file — refusing. (Name withheld.)" >&2
      return 1
    fi

    # And the residual the comparison CANNOT reach: a name inherited as exported
    # that the wrapper never reassigns, or reassigns to the value it already
    # had, is byte-identical to operator configuration. For most names that is
    # fine — an operator exporting an RPC URL is the case the `declare -x` arm
    # deliberately serves. For the three paths this tooling RUNS FROM it is not,
    # because `deploy-mainnet.sh` executes `$SCRIPT_DIR/predeploy-check.sh`.
    #
    # So this arm is NOT redundant with the derived rule and does not subsume
    # it either; they cover different halves. r15 deleted it on the claim that
    # the derived rule replaced it, and that claim was wrong.
    case "$__lenv_name" in
      SCRIPT_DIR|CONTRACTS_DIR|REPO_ROOT)
        echo "Error: $__lenv_file:$__lenv_no sets a path this tooling runs from" >&2
        echo "       — refusing. (Name withheld.)" >&2
        return 1 ;;
    esac

    __lenv_decl="$(declare -p "$__lenv_name" 2>/dev/null || true)"
    if [ -n "$__lenv_decl" ]; then
      case "$__lenv_decl" in
        "declare -x "*) : ;;
        *) echo "Error: $__lenv_file:$__lenv_no sets a name this shell already holds" >&2
           echo "       as script-owned or attributed state — refusing. (Name withheld.)" >&2
           return 1 ;;
      esac
    fi

    case "$__lenv_name" in __lenv_*)
      echo "Error: $__lenv_file:$__lenv_no sets a withheld name, which is this loader's" >&2
      echo "       own internal namespace — refusing." >&2
      return 1 ;;
    esac

    case "$__lenv_name" in '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "Error: $__lenv_file:$__lenv_no invalid variable name a withheld name." >&2
      return 1 ;;
    esac

    # DENY names some later process treats as a startup hook. A SECOND family,
    # which redirects where a credential is sent rather than running anything,
    # is refused just below.
    #
    # The git family is here because the wrappers run `git` thirteen times in
    # deploy-mainnet.sh alone: `GIT_CONFIG_COUNT=1` plus `GIT_CONFIG_KEY_0=core.pager`
    # and a VALUE runs a command with the deployment's credentials (#1938 r12).
    # Every tool a deploy invokes brings its own family of these, which is the
    # argument recorded on #1939 for why a denylist cannot be finished here. Reading the file
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
    #
    # The npm arm is a PREFIX, and case-insensitively so, because npm maps
    # EVERY config key to `npm_config_<key>` in any casing. The finding named
    # two spellings; six were reachable, and three distinct keys reach
    # execution against the `pnpm run` steps in `cf-defi`/`cf-www`/`cf-keeper`/
    # `cf-agent`: `script_shell` directly, and `userconfig`/`globalconfig` by
    # pointing npm at an `.npmrc` that sets it. Listing key names would have
    # closed one of the three (Codex #1938 r13).
    case "$__lenv_name" in
      BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|IFS|PS4|PATH \
      |LD_*|DYLD_*|BASH_FUNC_* \
      |HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|USERPROFILE \
      |NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS \
      |GIT_CONFIG*|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR \
      |GIT_ASKPASS|GIT_PROXY_COMMAND|GIT_ALTERNATE_OBJECT_DIRECTORIES \
      |[Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_*)
        echo "Error: $__lenv_file:$__lenv_no sets a withheld name, which another program" >&2
        echo "       would treat as a startup hook — refusing to export it." >&2
        return 1 ;;
    esac

    # A SECOND family, and it fails differently, so it gets its own message: it
    # does not run anything, it changes WHERE an authenticated tool sends its
    # request. The deploy exports `CLOUDFLARE_API_TOKEN` and then runs wrangler;
    # a `.env` naming the API endpoint delivers that token to a host of the
    # file's choosing, and the proxy variables do the same to every HTTP client
    # the deploy invokes — curl, git, node, wrangler alike — while
    # `NODE_EXTRA_CA_CERTS` makes an interceptor's certificate trusted
    # (Codex #1938 r14).
    case "$__lenv_name" in
      CLOUDFLARE_API_BASE_URL|CF_API_BASE_URL \
      |[Hh][Tt][Tt][Pp]_[Pp][Rr][Oo][Xx][Yy] \
      |[Hh][Tt][Tt][Pp][Ss]_[Pp][Rr][Oo][Xx][Yy] \
      |[Aa][Ll][Ll]_[Pp][Rr][Oo][Xx][Yy]|[Nn][Oo]_[Pp][Rr][Oo][Xx][Yy] \
      |NODE_EXTRA_CA_CERTS)
        echo "Error: $__lenv_file:$__lenv_no sets a withheld name, which redirects where" >&2
        echo "       an authenticated request is sent — refusing to export it." >&2
        echo "       Set it in your own environment if you genuinely need it." >&2
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
        # After the closing quote only WHITESPACE, then optionally a comment.
        # `[[:space:]]*'#'*` accepted `"v" junk # note` because the glob let
        # `junk` sit inside the `*` before the `#` (Codex #1938 r11). Strip the
        # whitespace first, then the remainder must be empty or start with `#`.
        __lenv_rest="${__lenv_rest#"${__lenv_rest%%[![:space:]]*}"}"
        case "$__lenv_rest" in
          '' | '#'*) : ;;
          *) echo "Error: $__lenv_file:$__lenv_no has text after the closing quote;" >&2
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

# Assert that a declaration read as a boolean uses the documented vocabulary.
#
# Every consumer of these flags compares against the literal `1`, so an
# unrecognised value is not REJECTED by them — it silently takes the `0`
# branch. For `POST_HANDOVER` that is the dangerous direction: `0` labels the
# pre-handover direct calls valid on a chain the timelock already owns, so
# `POST_HANDOVER=true` reads as "not handed over" and the operator is handed
# calldata that cannot execute (Codex #1938 r13).
#
# It lives here, beside the loader, so there is ONE implementation of the rule
# and it applies whatever the value's source — `.env`, the environment, or the
# explicit fallback the emergency path recommends. Call it once per script,
# right after the load, BEFORE anything branches on the value.
env_assert_bool() {
  __eab_name="$1"
  eval "__eab_val=\${$__eab_name:-}"
  case "$__eab_val" in
    ''|0|1) return 0 ;;
    *)
      echo "Error: $__eab_name must be 0 or 1." >&2
      echo "       It is read as a boolean, and every reader compares against 1," >&2
      echo "       so any other value would silently be taken as 0 rather than" >&2
      echo "       rejected. (Value withheld.)" >&2
      return 1 ;;
  esac
}
