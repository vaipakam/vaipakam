#!/usr/bin/env bash
#
# Fold pending release-note fragments into a dated file, then remove them.
#
#   bash docs/ReleaseNotes/assemble.sh                     # today, UTC
#   bash docs/ReleaseNotes/assemble.sh 2026-05-20          # an explicit day
#   bash docs/ReleaseNotes/assemble.sh --allow-mixed-dates # take every pending
#   bash docs/ReleaseNotes/assemble.sh --force-append      # append even where
#                                                          # a duplicate is suspected
#
# THIS FILE IS THE ENTRY POINT, NOT THE IMPLEMENTATION (#1877).
#
# It stays because every caller, document and CI job invokes the
# assembler this way, and there is no reason to make them all change.
# The work is in `assemble.py`, and the arguments pass through
# untouched — this shim adds no behaviour of its own, deliberately, so
# there is nothing here that can drift from what the tests exercise.
#
# Why the implementation moved: the shell version reached ~2,600 lines
# and forty-six review rounds, and the findings had stopped being about
# the design. They were about its application — a guard one step too
# late, a check that answered for startup rather than for the moment
# that mattered, two lists describing one fact and disagreeing. That is
# what a program too large to hold in one head produces.
#
# The transactional core is also precisely what a shell is worst at.
# Rename, stat, hash, temporary file, signal window: each is a
# subprocess whose failure has to be routed by hand at every call site,
# and the missed routing was the recurring finding. In Python they raise.
#
# `assemble.test.sh` drives the command line rather than any internal,
# so it moved across unchanged and its assertions are what proves the
# behaviour did not.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
IMPL="$DIR/assemble.py"

if [ ! -f "$IMPL" ]; then
  echo "Error: $IMPL is missing." >&2
  echo "" >&2
  echo "This script is a thin entry point; the assembler itself lives in that" >&2
  echo "file. Restore it from git before assembling." >&2
  exit 1
fi

# Named explicitly rather than relying on a shebang: the file is invoked
# as an argument here, so its executable bit is irrelevant and a
# checkout that lost it still works.
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Error: neither python3 nor python found." >&2
  echo "" >&2
  echo "Release-note assembly is implemented in Python (#1877). Install it," >&2
  echo "or run '$IMPL' with an interpreter directly." >&2
  exit 1
fi

exec "$PY" "$IMPL" "$@"
