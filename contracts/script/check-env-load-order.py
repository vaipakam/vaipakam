#!/usr/bin/env python3
"""#1932 / #1938 — every deploy wrapper must load `.env` BEFORE it parses
anything the operator typed.

`.env` is SOURCED, which is to say EXECUTED. The first version of this fix
parsed flags and then restored them after the source, and that cannot be made
to work: the file can redefine the restore list, mark a target `readonly` so
`printf -v` fails, `set +e` so the failure is not fatal, or define
`printf() { :; }` so every restore silently no-ops. Codex #1938 demonstrated
three of those against successive versions.

Loading first removes the contest instead of trying to win it — whatever the
file sets is overwritten by the parse that runs afterwards. The property is
therefore ORDERING, and ordering is what this checks:

    line(`source "$CONTRACTS_DIR/.env"`)  <  line(first CLI parse)

for `NAME="$1"` positionals and for the `case "$1" in` flag block alike.

This replaced a checker that compared a hand-maintained list of protected names
against the parsed flags. That check could only ever be as complete as the list,
and it certified its own blind spot: it read only the `case` block, so it
reported "all 8 protected" while `CHAIN_SLUG` — a positional — sat unprotected.
An ordering property has no list to fall behind, covers every current and future
flag at once, and cannot be satisfied by a file that executes code.

Missing either landmark is a HARD ERROR, not a pass: a check that cannot find
what it measures has measured nothing.
"""
import re
import sys
from pathlib import Path

WRAPPERS = ("deploy-mainnet.sh", "deploy-testnet.sh", "deploy-chain.sh")

SOURCE = re.compile(r'^\s*set -a; source "\$CONTRACTS_DIR/\.env"; set \+a')
POSITIONAL = re.compile(r'^\s*([A-Z][A-Z0-9_]{2,})="\$1"')
CASE = re.compile(r'^\s*case "\$1" in')


def main() -> int:
    here = Path(__file__).resolve().parent
    bad = 0
    for name in WRAPPERS:
        lines = (here / name).read_text().splitlines()

        src = [i for i, l in enumerate(lines, 1) if SOURCE.search(l)]
        if len(src) != 1:
            print(f"  x {name} — expected exactly one `.env` source line, found {len(src)}",
                  file=sys.stderr)
            bad = 1
            continue

        parses = [(i, m.group(1)) for i, l in enumerate(lines, 1)
                  for m in [POSITIONAL.search(l)] if m]
        parses += [(i, 'case "$1"') for i, l in enumerate(lines, 1) if CASE.search(l)]
        if not parses:
            print(f"  x {name} — no CLI parse found; this checker has stopped measuring",
                  file=sys.stderr)
            bad = 1
            continue

        early = [(i, what) for i, what in parses if i < src[0]]
        if early:
            bad = 1
            for i, what in sorted(early):
                print(f"  x {name}:{i} — `{what}` parsed BEFORE .env is sourced "
                      f"(source is line {src[0]}); .env can override it",
                      file=sys.stderr)
        else:
            print(f"  ok {name} — .env sourced at {src[0]}, "
                  f"all {len(parses)} CLI parses after it")
    return bad


if __name__ == "__main__":
    sys.exit(main())
