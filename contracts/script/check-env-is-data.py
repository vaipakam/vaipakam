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
# The ONLY thing these scripts may source is a helper under `script/lib/`.
#
# Three predicates have failed here already, each because it modelled how the
# offending line would be WRITTEN: `case "$1"`-only; `$CONTRACTS_DIR`-only;
# then "command and `.env` on the same physical line", which Codex #1938 r6
# walked past with `env_file="$CONTRACTS_DIR/.env"; source "$env_file"` and
# with a backslash line-continuation.
#
# So this no longer looks for `.env` at all. It asks what each `source` /`.`
# command loads, and permits exactly one answer. A path variable, a line wrap,
# a new spelling — none of them help, because the allowed set is one shape and
# everything else is reported. Continuations are joined before matching.
# COMMAND POSITION: first token, or after a separator that starts a new command
# (`;`, `&&`, `||`, `then`, `else`, `do`, `{`). Anchoring to `^|;` alone missed
# `true && source …` (Codex #1938 r8). The separators are enumerated rather than
# "any punctuation" because the looser version fired on nineteen echoed
# sentences — a full stop reads exactly like the `.` command. This list is the
# narrowest thing that starts a command in shell and does not appear mid-prose.
#
# Four predicates have failed here, each in a new way, and the last two failed
# in OPPOSITE directions: one missed `env_file=…; source "$env_file"` and a
# line-wrap, and its replacement fired on nineteen legitimate lines because a
# sentence-ending period inside an echoed string reads exactly like the `.`
# command. Both failure modes are fatal to a guard — one lets the thing
# through, the other trains people to ignore it.
#
# Anchoring to command position is what separates them: shell sources at the
# start of a command, and prose never is. The `;` alternative is there because
# that is the form the indirect bypass used.
SOURCING = re.compile(r'(?:^|;|&&|\|\||\bthen\b|\belse\b|\bdo\b|\{)\s*(?:source|\.)\s+(\S+)')

LOADER = re.compile(r'\bload_env_file\b')
ALLOWED_SOURCE = re.compile(r'^"?\$\{?(?:SCRIPT_DIR|CONTRACTS_DIR)\}?/(?:script/)?lib/[A-Za-z0-9_.-]+\.sh"?$')

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
        # (line-number, logical-line). Joining continuations renumbers lines,
        # and a guard that reports the wrong line sends the reader hunting —
        # so the FIRST physical line of each logical line is carried along.
        joined, buf, start = [], '', 0
        for lineno, raw in enumerate(text.splitlines(), 1):
            # Drop comment-only lines BEFORE joining continuations — joining
            # first merged a comment onto the code line above it and made the
            # comment look like part of a command.
            if raw.lstrip().startswith('#') and not buf:
                continue
            if not buf:
                start = lineno
            line = buf + raw
            if line.rstrip().endswith('\\'):
                buf = line.rstrip()[:-1]
                continue
            buf = ''
            joined.append((start, line))

        offenders = []
        for i, line in joined:
            if line.lstrip().startswith('#'):
                continue
            for m in SOURCING.finditer(line):
                target = m.group(1)
                if not ALLOWED_SOURCE.match(target):
                    offenders.append((i, target))
        if offenders:
            bad = 1
            for i, target in offenders:
                print(f"  x {path.name}:{i} — sources {target}; only script/lib/*.sh "
                      f"may be sourced. Read .env with `load_env_file`.",
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
