#!/usr/bin/env python3
"""#1932 / #1938 — no operator script may SOURCE `.env`.

`source` executes the file in the calling shell. Three rounds of review showed
that cannot be made safe by any amount of care around it:

  1. `.env` redefining the protected-name list disarmed the restore loop.
  2. `readonly NAME=1` made `printf -v` fail; `set +e` in the same file stopped
     the failure being fatal.
  3. `printf() { :; }` turned every restore into a silent no-op.
  4. Loading before parsing did not help: `set -- base --fresh …` replaces the
     caller's `$@`, so the file supplies the command line it should lose to.

Each fix closed one door in a room with arbitrary code in it. `lib/load-env.sh`
reads the file as DATA instead — plain `NAME=value`, no `source`, no `eval`, no
expansion — and this asserts nobody reintroduces the executing form.

THE PREDICATE IS DELIBERATELY CRUDE, and that is the point. Its predecessor
checked an ordering property by recognising CLI parser forms, and Codex bypassed
it with `while getopts` — the third time a guard here certified its own blind
spot (the first read only `case "$1"` blocks and missed a positional; the second
scanned two wrappers while a third had no protection at all). "Does this file
source `.env`" needs no model of shell parsing to answer, so it has nowhere to
be incomplete.

Finding zero scripts to check is a HARD ERROR: a guard that scanned nothing has
verified nothing, which is how the earlier versions reported success.
"""
import re
import sys
from pathlib import Path

# Any form of executing the file: `source X`, `. X`, with or without `set -a`.
SOURCING = re.compile(r'(?:^|;|\s)(?:source|\.)\s+"?\$\{?CONTRACTS_DIR\}?/\.env"?')
LOADER = re.compile(r'\bload_env_file\b')
MENTIONS_ENV = re.compile(r'\$\{?CONTRACTS_DIR\}?/\.env')


def main() -> int:
    here = Path(__file__).resolve().parent
    checked = bad = 0
    for path in sorted(here.glob("*.sh")):
        text = path.read_text()
        if not MENTIONS_ENV.search(text):
            continue
        checked += 1
        offenders = [i for i, line in enumerate(text.splitlines(), 1)
                     if SOURCING.search(line) and not line.lstrip().startswith('#')]
        if offenders:
            bad = 1
            for i in offenders:
                print(f"  x {path.name}:{i} — SOURCES .env; use `load_env_file` "
                      f"(lib/load-env.sh) so the file is read as data",
                      file=sys.stderr)
        elif not LOADER.search(text):
            bad = 1
            print(f"  x {path.name} — references .env but neither sources it nor "
                  f"calls `load_env_file`; unclear how it is read", file=sys.stderr)
        else:
            print(f"  ok {path.name} — reads .env as data")

    if checked == 0:
        print("  x found no script referencing .env — this checker has stopped "
              "measuring anything", file=sys.stderr)
        return 1
    return bad


if __name__ == "__main__":
    sys.exit(main())
