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
Because prose failed three times in a row on this exact proposition, inside a
single pull request: each sweep wrote a narrower claim than the last, and each
was falsified within a round. A fact that cannot be kept true by careful writing
has to be checked instead of asserted.

WHY THIS SCRIPT IS PARANOID ABOUT ITSELF
----------------------------------------
The first version of this checker was itself vacuous in three independent ways,
all found by attacking it rather than reading it:

  * Its scan roots were CWD-relative. `predeploy-check.sh` cds into `contracts/`
    before invoking it, so the roots resolved to `contracts/contracts/src`,
    `os.walk` walked nothing, and the gate printed OK having examined zero
    files. Roots are now resolved from `__file__`, and scanning zero files or
    zero comments is a HARD FAILURE — a check that finds nothing must prove it
    looked.
  * It joined comment lines without stripping their `///` prefixes, so the
    multi-line case it was written to catch produced text like
    `reported + released - /// consumed` and matched nothing. Delimiters are now
    stripped before joining.
  * It only considered lines that BEGIN with a comment token, so any retired
    formula in a trailing comment (`uint256 avail; // reported - consumed`) was
    invisible. Inline comment text is now extracted too.

Each of those made the checker report success while examining less than it
claimed, which is the same defect class it exists to prevent.

DELIBERATE MENTIONS
-------------------
A comment may legitimately name a retired form — to REJECT it, or to describe
what an older revision did. Mark such a block with

    formula-check:allow <reason>

The reason must be on the SAME LINE as the marker. Reading it from the joined
block made the requirement vacuous: a marker followed by any further comment
text looked reasoned, so an unexplained exemption passed.

USAGE
    python3 contracts/script/check-commitment-formula.py [--list]
Runs correctly from any working directory. Exit 0 when clean, 1 otherwise.
"""

import os
import re
import sys

MARKER = "formula-check:allow"

# Resolved from THIS FILE, never from the caller's cwd — see the header.
_HERE = os.path.dirname(os.path.abspath(__file__))          # contracts/script
_CONTRACTS = os.path.dirname(_HERE)                          # contracts
ROOTS = (os.path.join(_CONTRACTS, "src"), os.path.join(_CONTRACTS, "test"))

# An operand is any identifier CONTAINING the word — production comments quote
# real ledger names (`chainReportedRecycled[c]`), not the shorthand.
_ID = r"\w*%s\w*(?:\[[^\]\n]*\])?"
_REPORTED = _ID % "reported"
_RELEASED = _ID % "released"
_CONSUMED = _ID % "consumed"
_DASH = r"[-−]"

RE_ADDITION = re.compile(
    r"\(?\s*(%s)\s*\+\s*(%s)\s*\)?\s*%s\s*(%s)" % (_REPORTED, _RELEASED, _DASH, _CONSUMED),
    re.I,
)
RE_BARE_SUB = re.compile(
    r"(%s)\s*%s\s*(%s)(?!\s*%s\s*%s)" % (_REPORTED, _DASH, _CONSUMED, _DASH, _RELEASED),
    re.I,
)
RE_BARE_CMP = re.compile(r"(%s)\s*(?:<=|≤)\s*(%s)" % (_CONSUMED, _REPORTED), re.I)
RE_BARE_PROSE = re.compile(r"reported[- ]minus[- ]consumed", re.I)

# Identifiers that ALREADY encode the release adjustment are correct, not
# retired: `consumedMinusReleased <= reported` is the right bound written with a
# normalized name. Flagging it would force a block-wide exemption and blind the
# checker to a real defect elsewhere in that block.
_ALREADY_NET = ("minusreleased", "lessreleased", "netofreleased", "claimnet", "netclaim")


def _is_already_net(identifier):
    norm = identifier.lower().replace("_", "").replace(" ", "")
    if any(h in norm for h in _ALREADY_NET):
        return True
    return norm.startswith("net")


def comment_text(path):
    """Yield (start_line, joined_comment_text, marker_lines) per comment run.

    Extracts comment CONTENT — delimiters stripped — from both comment-only
    lines and trailing comments, then joins contiguous runs. Joined because a
    formula split across two lines is one statement; stripped because leaving
    the `///` in place is what made the joining useless.
    """
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.read().split("\n")

    extracted = []  # (line_no, text) for every line carrying comment content
    in_block = False
    for n, raw in enumerate(lines, 1):
        s = raw.strip()
        if in_block:
            body = s
            if "*/" in body:
                body = body.split("*/", 1)[0]
                in_block = False
            extracted.append((n, body.lstrip("*").strip()))
            continue
        if s.startswith("/*"):
            body = s[2:]
            if "*/" in body:
                body = body.split("*/", 1)[0]
            else:
                in_block = True
            extracted.append((n, body.lstrip("*").strip()))
            continue
        if "//" in s:
            # trailing OR whole-line; either way take what follows the slashes
            body = s.split("//", 1)[1]
            extracted.append((n, body.lstrip("/").strip()))
            continue
        extracted.append((n, None))

    i = 0
    while i < len(extracted):
        if extracted[i][1] is None:
            i += 1
            continue
        start = extracted[i][0]
        buf, marks = [], []
        while i < len(extracted) and extracted[i][1] is not None:
            body = extracted[i][1]
            buf.append(body)
            if MARKER in body:
                marks.append(body)
            i += 1
        yield start, " ".join(buf), marks


def _violations_in(text):
    kinds = []
    for m in RE_ADDITION.finditer(text):
        if not _is_already_net(m.group(3)):
            kinds.append("ADDITION")
            break
    for m in RE_BARE_SUB.finditer(text):
        if not _is_already_net(m.group(2)):
            kinds.append("BARE")
            break
    if "BARE" not in kinds:
        for m in RE_BARE_CMP.finditer(text):
            if not _is_already_net(m.group(1)):
                kinds.append("BARE")
                break
    if "BARE" not in kinds and RE_BARE_PROSE.search(text):
        kinds.append("BARE")
    return kinds


def scan():
    violations, allowed = [], []
    files = blocks = 0
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames if d not in ("lib", "out", "cache", "node_modules")
            ]
            for fn in sorted(filenames):
                if not fn.endswith(".sol"):
                    continue
                files += 1
                path = os.path.relpath(os.path.join(dirpath, fn))
                for line, text, marks in comment_text(os.path.join(dirpath, fn)):
                    blocks += 1
                    kinds = _violations_in(text)
                    if not kinds:
                        continue
                    if marks:
                        reason = marks[0].split(MARKER, 1)[1].strip(" *-/")
                        if len(reason) < 10:
                            violations.append(
                                (path, line, "EMPTY-MARKER",
                                 "%s carries no reason on its own line (found %r)"
                                 % (MARKER, reason))
                            )
                        else:
                            allowed.append((path, line, ",".join(kinds), reason[:90]))
                        continue
                    violations.append((path, line, ",".join(kinds), text[:150]))
    return violations, allowed, files, blocks


def main():
    violations, allowed, files, blocks = scan()

    # A check that finds nothing must prove it looked. The first version of this
    # script reported OK from a wrong cwd having walked zero directories.
    if files == 0 or blocks == 0:
        print(
            "check-commitment-formula: FAILED — scanned %d file(s) and %d comment "
            "block(s). Expected thousands. The roots are %r; if those do not exist, "
            "this script has been moved and its root resolution needs updating."
            % (files, blocks, ROOTS),
            file=sys.stderr,
        )
        return 1

    if "--list" in sys.argv:
        print("Deliberate mentions (%d):" % len(allowed))
        for path, line, kind, reason in allowed:
            print("  %s:%d  [%s]  %s" % (path, line, kind, reason))
        print()

    if not violations:
        print(
            "check-commitment-formula: OK — %d file(s), %d comment block(s) scanned; "
            "no retired availability form stated (%d deliberate mention(s) marked)."
            % (files, blocks, len(allowed))
        )
        return 0

    print("check-commitment-formula: %d comment block(s) state a RETIRED "
          "availability form (of %d scanned in %d file(s)):\n"
          % (len(violations), blocks, files), file=sys.stderr)
    for path, line, kind, text in violations:
        print("  %s:%d  [%s]" % (path, line, kind), file=sys.stderr)
        print("      %s" % text, file=sys.stderr)
    print(
        "\nThe correct shapes are `sat(consumed - released) <= reported` and\n"
        "`reported - sat(consumed - released) - netRepatriationDraw`, both\n"
        "subtraction-first. If a mention is deliberate — rejecting the form, or\n"
        "describing a past revision — add `%s <reason>` on one line." % MARKER,
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
