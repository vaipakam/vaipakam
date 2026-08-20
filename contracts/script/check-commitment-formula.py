#!/usr/bin/env python3
"""check-commitment-formula.py — no comment may state a retired availability form.

WHY THIS EXISTS
---------------
The per-chain commitment bound has ONE correct shape:

    sat(consumed - released) <= reported            (SS7 #6, subtraction-first)

and the availability read that enforces it is

    reported - sat(consumed - released) - netRepatriationDraw

Two other shapes keep reappearing in comments, and both are wrong:

  * the BARE form `reported - consumed` / `consumed <= reported`, which predates
    B3's release term. It is FALSE: a commitment released un-spent is
    legitimately re-committable, so `consumed` is deliberately unbounded by
    `reported`.
  * the ADDITION form `reported + released - consumed`, algebraically equal to
    the correct one over the reals and DIFFERENT over uint256 — a reported
    cumulative is unbounded, so the sum overflows on a hostile report and
    reverts instead of comparing.

WHY A SCRIPT AND NOT A SENTENCE
-------------------------------
Because prose has now failed three times in a row on this exact proposition,
inside a single pull request:

  1. A sweep corrected four sites in `contracts/src` and recorded that the code
     side was swept.
  2. An adversarial review found four more, all describing `_mirrorAvailable`
     by its pre-B3 formula — one of them in a comment block the first pass had
     already edited.
  3. Review then found four more still, two of them the addition form, in
     `contracts/src` AND `contracts/test`. The verifying grep had searched only
     `src`, and only for the subtraction phrasing, so it structurally could not
     see either class.

The design record's own rule says a count is itself a claim and goes stale. The
answer to a claim nobody can keep true by hand is to stop asserting it and start
CHECKING it: this script is the assertion, and it is re-evaluated on every run.

DELIBERATE MENTIONS
-------------------
A comment may legitimately name a retired form — to REJECT it, or to describe
what an older revision did. Mark such a block with

    formula-check:allow <reason>

on any line of the block. The reason must be on the SAME LINE as the marker and
is read by humans, not by this script; a marker with nothing after it is itself
an error, because an unexplained exemption is how the hole reopens.

The same-line requirement is not fussiness. Reading the reason from the joined
block made this check VACUOUS — a marker followed by any further comment text
looked reasoned, so mutant C below passed. That was found by mutating the guard,
not by reading it, which is the only way such a hole is ever found.

USAGE
    python3 contracts/script/check-commitment-formula.py [--list]
Exit 0 when clean, 1 when a block states a retired form without a marker.
"""

import os
import re
import sys

ROOTS = ("contracts/src", "contracts/test")
MARKER = "formula-check:allow"

COMMENT_START = ("//", "*", "/*", "///")

# The retired shapes. Written to match the prose forms as well as the code-ish
# ones, because a comment saying "reported-minus-consumed" is exactly as wrong
# as one saying `reported - consumed`.
RETIRED = [
    (
        "ADDITION",
        re.compile(
            r"reported\w*\s*\+\s*released\w*\s*[-−]\s*consumed"
            r"|\(\s*reported\w*\s*\+\s*released\w*\s*\)\s*[-−]\s*consumed",
            re.I,
        ),
    ),
    (
        "BARE",
        re.compile(
            r"reported\w*\s*[-−]\s*consumed\w*(?!\s*[-−]\s*released)"
            r"|reported[- ]minus[- ]consumed"
            r"|consumed\w*\s*(?:<=|≤)\s*reported",
            re.I,
        ),
    ),
]


def comment_blocks(path):
    """Yield (start_line, joined_text, raw_lines) for each run of comment lines.

    Joined, because a formula split across two lines is still one statement and
    a line-at-a-time scan cannot see it — which is how the addition form
    survived an earlier sweep.
    """
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.read().split("\n")
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith(COMMENT_START):
            start, buf = i, []
            while i < len(lines) and lines[i].strip().startswith(COMMENT_START):
                buf.append(lines[i].strip())
                i += 1
            yield start + 1, " ".join(buf), buf
        else:
            i += 1


def scan(list_all=False):
    violations, allowed = [], []
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames if d not in ("lib", "out", "cache", "node_modules")
            ]
            for fn in sorted(filenames):
                if not fn.endswith(".sol"):
                    continue
                path = os.path.join(dirpath, fn)
                for line, text, raw in comment_blocks(path):
                    hits = [name for name, rx in RETIRED if rx.search(text)]
                    if not hits:
                        continue
                    if MARKER in text:
                        reason = ""
                        for rl in raw:
                            if MARKER in rl:
                                reason = rl.split(MARKER, 1)[1].strip(" *-/")
                                break
                        if len(reason) < 10:
                            violations.append(
                                (path, line, "EMPTY-MARKER",
                                 "%s carries no reason on its own line "
                                 "(found %r)" % (MARKER, reason))
                            )
                        else:
                            allowed.append((path, line, ",".join(hits), reason[:90]))
                        continue
                    violations.append((path, line, ",".join(hits), text[:150]))
    return violations, allowed


def main():
    list_all = "--list" in sys.argv
    violations, allowed = scan(list_all)

    if list_all:
        print("Deliberate mentions (%d):" % len(allowed))
        for path, line, kind, reason in allowed:
            print("  %s:%d  [%s]  %s" % (path, line, kind, reason))
        print()

    if not violations:
        print(
            "check-commitment-formula: OK — no comment states a retired "
            "availability form (%d deliberate mentions marked)." % len(allowed)
        )
        return 0

    print("check-commitment-formula: %d comment block(s) state a RETIRED "
          "availability form:\n" % len(violations), file=sys.stderr)
    for path, line, kind, text in violations:
        print("  %s:%d  [%s]" % (path, line, kind), file=sys.stderr)
        print("      %s" % text, file=sys.stderr)
    print(
        "\nThe correct shapes are `sat(consumed - released) <= reported` and\n"
        "`reported - sat(consumed - released) - netRepatriationDraw`, both\n"
        "subtraction-first. If a mention is deliberate — rejecting the form, or\n"
        "describing a past revision — add `%s <reason>` to the block."
        % MARKER,
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
