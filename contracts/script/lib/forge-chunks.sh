#!/usr/bin/env bash
#
# forge-chunks.sh — the ONE implementation of "split a directory's test
# suites into `forge test --match-path` chunks". Sourced, never executed.
#
# Two callers, one rule (#2712):
#   - `run-regression.sh` chunks the top-level suites and every subdirectory
#     so no compile unit crosses the viaIR whole-unit stack ceiling (#601).
#   - `predeploy-check.sh` step 2 chunks the deploy-sanity suite so its
#     compile fits the CI runner's memory: run as one invocation it peaked at
#     14.7 GB of solc on a 16 GB runner; in two it peaks under 10 GB.
#
# Both callers used to carry their own chunk loop. Keep it here: when the
# ceiling or the runner moves again there is one place to fix it.
#
# Why brace globs of exact stems: globset's `*` crosses `/`, so a pattern
# like `test/*.t.sol` also matches every subdirectory. `test/{A,B}.t.sol`
# matches exactly the files named, which is what makes a chunk a chunk.

# forge_test_stems <dir>
#   Print the stem of every `*.t.sol` directly in <dir> (not below it), one
#   per line, sorted. The sort keeps chunk membership stable between runs.
forge_test_stems() {
  find "$1" -maxdepth 1 -name '*.t.sol' -printf '%f\n' | sed 's/\.t\.sol$//' | LC_ALL=C sort
}

# forge_chunk_globs <dir> <size> [stem...]
#   Print one `--match-path` glob per chunk of at most <size> stems, in the
#   order given. Prints nothing for an empty stem list; a caller that must
#   not pass having run nothing checks for that itself.
forge_chunk_globs() {
  local dir="$1" size="$2"; shift 2
  if ! [[ "$size" =~ ^[1-9][0-9]*$ ]]; then
    echo "forge_chunk_globs: chunk size must be a positive integer, got '$size'" >&2
    return 1
  fi
  local chunk=() stem
  for stem in "$@"; do
    chunk+=("$stem")
    if (( ${#chunk[@]} == size )); then
      _forge_chunk_glob "$dir" "${chunk[@]}"
      chunk=()
    fi
  done
  if (( ${#chunk[@]} > 0 )); then
    _forge_chunk_glob "$dir" "${chunk[@]}"
  fi
}

# A one-file chunk is written as its plain path rather than a one-member
# brace, so the glob never depends on how the matcher treats `{A}`.
_forge_chunk_glob() {
  local dir="$1"; shift
  if (( $# == 1 )); then
    echo "$dir/$1.t.sol"
  else
    echo "$dir/{$(IFS=,; echo "$*")}.t.sol"
  fi
}
