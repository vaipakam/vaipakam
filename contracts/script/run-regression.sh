#!/usr/bin/env bash
#
# run-regression.sh — local full-regression gate, run in compile-bounded CHUNKS
# so no single `solc` invocation forms the over-threshold compilation unit that
# trips viaIR "Variable size is N too deep in the stack".
#
# WHY CHUNKS (not one sparse pass): this codebase sits AT the viaIR whole-unit
# stack ceiling. The bare `forge test --no-match-path "test/invariants/*"` is
# non-sparse (compiles src+all-test+all-script) and fails outright. A single
# sparse `--match-path 'test/*.t.sol'` pass (matched files + deps, no standalone
# scripts) bought headroom for a while, but ordinary feature growth (#591)
# re-crossed even that. So we split the suite into chunks small enough that
# each `forge test --match-path` invocation stays under the ceiling. Foundry
# caches `src` across invocations, so only the first chunk pays the full src
# compile; the rest add just their own test files. See Issue #601 / #605.
#
# COVERAGE — CANNOT MISS A SUITE: the chunk set is DERIVED FROM `find`, so any
# new `*.t.sol` is picked up automatically. An exhaustiveness guard cross-checks
# every non-invariant test file against the chunks and ABORTS if one is
# uncovered — so a new suite can never be silently skipped.
#
# Forces FOUNDRY_PROFILE=default so a stray quick/cifast in the caller's env
# can't narrow the suite and still report green.
#
# USAGE:
#   bash script/run-regression.sh              # full suite minus invariants
#   bash script/run-regression.sh --invariants # ALSO run the invariant suites
#   CHUNK_SIZE=20 bash script/run-regression.sh # smaller chunks if a chunk trips

set -uo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

export FOUNDRY_PROFILE=default
# IO-priority boost only — `nice -n -10` (raised CPU priority) needs privileges
# operators/sandboxes lack and a failing nice would abort the run.
PREFIX=(ionice -c 2 -n 0)

CHUNK_SIZE="${CHUNK_SIZE:-25}"

RUN_INVARIANTS=0
FORGE_ARGS=()
for a in "$@"; do
  case "$a" in
    --invariants) RUN_INVARIANTS=1 ;;
    *) FORGE_ARGS+=("$a") ;;
  esac
done

# Subdirectories that hold *.t.sol (excluding invariants, which run separately).
# A new such subdir must be added here; the exhaustiveness guard fails loudly
# if one appears that isn't covered.
SUBDIRS=(scenarios deploy fork seaport token)

# ── Top-level suites, chunked ────────────────────────────────────────────────
# `test/*.t.sol` recurses under globset (its `*` crosses `/`), so we CANNOT use
# it to mean "top-level only". Instead enumerate the top-level files explicitly
# (find -maxdepth 1) and pass each chunk as a brace glob of exact file stems —
# no slashes inside the brace, so no recursion ambiguity.
mapfile -t TOP < <(find test -maxdepth 1 -name '*.t.sol' -printf '%f\n' | sed 's/\.t\.sol$//' | sort)

FAILED=0
run() {  # run(label, glob...)
  local label="$1"; shift
  echo ""
  echo "===== $label : forge test --match-path '$*' ====="
  "${PREFIX[@]}" forge test --match-path "$*" "${FORGE_ARGS[@]}" || { echo "CHUNK FAILED: $label" >&2; FAILED=1; }
}

n=0; chunk=()
flush() {
  (( ${#chunk[@]} == 0 )) && return
  local joined; joined=$(IFS=,; echo "${chunk[*]}")
  run "top-level chunk #$1" "test/{$joined}.t.sol"
  chunk=()
}
ci=0
for stem in "${TOP[@]}"; do
  chunk+=("$stem"); n=$((n+1))
  if (( n % CHUNK_SIZE == 0 )); then ci=$((ci+1)); flush "$ci"; fi
done
ci=$((ci+1)); flush "$ci"

# ── Subdirectory suites — chunked PER subdir (like the top-level suites) ──────
# One glob per subdir (`test/$sub/*.t.sol`) was ceiling-safe on 2026-07-01, but
# ordinary growth pushed the `fork` subdir ALONE over the viaIR whole-unit stack
# ceiling by 2026-07-13 ("Variable size is 1 too deep") — its 5 heavy sources
# (2 Seaport-fork + 2 mainnet-fork + Permit2-fork, each pulling large src/ deps)
# now exceed one compile unit. So subdirs are chunked the SAME way the top-level
# suites are: each subdir's files are split into `SUBDIR_CHUNK_SIZE`-file brace
# globs, keeping every compile unit small. Foundry caches src/ across
# invocations, so this is the same total compile, just in ceiling-safe units.
# Future-proof: a newly-added subdir file is picked up by `find` and chunked
# automatically. Tune down via SUBDIR_CHUNK_SIZE=N if a chunk ever trips.
# (fork tests self-skip when their FORK_URL_* envs are unset, so once a chunk
# COMPILES the fork suite passes trivially — the ceiling was the only blocker.)
SUBDIR_CHUNK_SIZE="${SUBDIR_CHUNK_SIZE:-3}"
for sub in "${SUBDIRS[@]}"; do
  mapfile -t SUBFILES < <(find "test/$sub" -maxdepth 1 -name '*.t.sol' -printf '%f\n' | sed 's/\.t\.sol$//' | sort)
  (( ${#SUBFILES[@]} == 0 )) && continue

  # `fork` subdir: each file needs a SPECIFIC fork RPC and self-skips without it
  # (`vm.envOr("FORK_URL_*", "")` → early return), so with no URL it adds zero
  # coverage. Gate each file by the URL IT needs (Codex #1201) so setting only
  # one URL never drags in — and tries to COMPILE — the other's files:
  #   • *Seaport* sources need FORK_URL_BASE_SEPOLIA (Base-Sepolia fork). They
  #     ALSO exceed the viaIR bounded-compile ceiling on current main (even a
  #     single Seaport file trips "Variable size N too deep" — full build only,
  #     #601/#603), so absent that URL they must not be compiled here at all.
  #   • the mainnet-fork sources (Oracle / Permit2 / Liquidation) need
  #     FORK_URL_MAINNET; they DO compile+skip cleanly in a bounded chunk.
  # A file whose URL is unset is dropped (still "covered" by the exhaustiveness
  # guard below). Both unset → the whole subdir is skipped, keeping the default
  # no-URL pre-deploy gate green. NOTE: when FORK_URL_BASE_SEPOLIA IS set, the
  # Seaport chunk still needs the src-level lean-DTO ceiling fix to compile —
  # this gate does not pretend otherwise.
  if [ "$sub" = "fork" ]; then
    kept=()
    for stem in "${SUBFILES[@]}"; do
      case "$stem" in
        *Seaport*)
          if [ -n "${FORK_URL_BASE_SEPOLIA:-}" ]; then kept+=("$stem")
          else echo "  fork: skip $stem (needs FORK_URL_BASE_SEPOLIA)"; fi ;;
        *)
          if [ -n "${FORK_URL_MAINNET:-}" ]; then kept+=("$stem")
          else echo "  fork: skip $stem (needs FORK_URL_MAINNET)"; fi ;;
      esac
    done
    if (( ${#kept[@]} == 0 )); then
      echo ""
      echo "===== subdir (fork) : SKIPPED — no matching FORK_URL_* set"
      echo "      (each fork test self-skips without its RPC; Seaport also exceeds the"
      echo "       viaIR bounded-compile ceiling — full build only. See #601/#603.)"
      continue
    fi
    SUBFILES=("${kept[@]}")
  fi
  sn=0; schunk=(); sci=0
  sflush() {
    (( ${#schunk[@]} == 0 )) && return
    local joined; joined=$(IFS=,; echo "${schunk[*]}")
    run "subdir ($sub #$1)" "test/$sub/{$joined}.t.sol"
    schunk=()
  }
  for stem in "${SUBFILES[@]}"; do
    schunk+=("$stem"); sn=$((sn+1))
    if (( sn % SUBDIR_CHUNK_SIZE == 0 )); then sci=$((sci+1)); sflush "$sci"; fi
  done
  sci=$((sci+1)); sflush "$sci"
done

# ── Optional invariants pass ─────────────────────────────────────────────────
if (( RUN_INVARIANTS )); then
  run "invariants" "test/invariants/*.t.sol"
fi

# ── Exhaustiveness guard ─────────────────────────────────────────────────────
# Every non-invariant test file must be either top-level OR under a covered
# subdir. Anything else (a new subdir, a nested path) is uncovered → fail.
shopt -s nullglob
declare -A COVERED=()
for f in test/*.t.sol; do COVERED["$f"]=1; done
for d in "${SUBDIRS[@]}"; do for f in test/"$d"/*.t.sol; do COVERED["$f"]=1; done; done
MISSED=()
while IFS= read -r f; do [[ -n "${COVERED[$f]:-}" ]] || MISSED+=("$f"); done \
  < <(find test -name '*.t.sol' ! -path 'test/invariants/*' | sort)
if (( ${#MISSED[@]} > 0 )); then
  echo "" >&2
  echo "ERROR: ${#MISSED[@]} non-invariant test file(s) not covered by any chunk — add the dir to SUBDIRS:" >&2
  printf '  %s\n' "${MISSED[@]}" >&2
  FAILED=1
fi

echo ""
if (( FAILED )); then echo "REGRESSION: FAILURES above ^^^" >&2; exit 1; fi
echo "REGRESSION: green (all chunks + exhaustiveness guard)"
