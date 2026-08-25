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
# ANY path ending in `.env`, however it is spelled — `$CONTRACTS_DIR/.env`,
# `"$SCRIPT_DIR/../.env"`, a bare relative path. Codex #1938 r4 bypassed a
# version of this that hard-coded the `$CONTRACTS_DIR` spelling.
SOURCING = re.compile(r'(?:^|;|\s)(?:source|\.)\s+\S*\.env\b')
LOADER = re.compile(r'\bload_env_file\b')
# The GATE must be as wide as the predicate. A version of this widened the
# sourcing pattern to any `.env` path and left this one pinned to
# `$CONTRACTS_DIR`, so a helper sourcing `"$SCRIPT_DIR/../.env"` was not even
# considered — the file was skipped before the check ran. That is the fifth
# time in this PR that half a guard was widened and its sibling left behind,
# which is the argument for keeping both patterns adjacent and identical in
# shape.
MENTIONS_ENV = re.compile(r'\S*\.env\b')


def main() -> int:
    here = Path(__file__).resolve().parent
    checked = bad = 0
    # RECURSIVE, and over the whole script tree rather than one directory —
    # a version of this scanned only `script/*.sh`, so a helper under `lib/`
    # could have sourced `.env` unseen (Codex #1938 r5).
    for path in sorted(here.rglob("*.sh")):
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
        elif any(LOADER.search(l) for l in text.splitlines()
                 if not l.lstrip().startswith('#')):
            print(f"  ok {path.name} — reads .env as data")
        else:
            # Mentions `.env` but does not source it. That is the property this
            # guard is about, so it passes. An earlier arm here FAILED such
            # files on the theory that an unexplained mention might be a third
            # way of reading the file — and it flagged two scripts whose only
            # mention is `cp .env.example .env` in a comment. A guard that
            # fires on prose gets ignored, and an ignored guard is worse than
            # a narrow one. The property is "nothing SOURCES .env"; anything
            # more is a model of how files might be read, and every model this
            # PR has written has been walked around.
            print(f"  ok {path.name} — mentions .env, does not source it")

    if checked == 0:
        print("  x found no script referencing .env — this checker has stopped "
              "measuring anything", file=sys.stderr)
        return 1
    return bad


if __name__ == "__main__":
    sys.exit(main())
