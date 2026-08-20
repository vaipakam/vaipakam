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
Every version of this checker so far has been vacuous in some way, and every one
of those holes was found by ATTACKING it rather than reading it. That track
record is the reason `check-commitment-formula.selftest.sh` exists and is the
reason to run it after any change here:

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

  * Its `net` exemption matched any identifier merely STARTING with `net`, so
    `networkConsumedCumulative <= networkReportedCumulative` — a genuinely
    retired bound — was waved through. A prefix is not a meaning.
  * It only found block comments that OPEN a line, missing
    `uint256 x; /* reported - consumed */`.
  * It waived the ADDITION form when the consumed operand was already net, but
    `reported + released - consumedMinusReleased` restores releases twice and is
    worse, not better.
  * It missed the commuted bound `consumed <= released + reported`, which
    overflows exactly as the uncommuted one does.
  * Its exemptions were BLOCK-scoped, so one marked historical mention licensed
    every other occurrence in the same NatSpec block — including a newly
    introduced false one. Exemptions are now scoped to the occurrence, within
    a few lines of the marker.
  * It validated only the AGGREGATE scan count, so one dead root was hidden by
    the other's thousands of blocks. Every root must now yield something.

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
# `reported + (released - consumed)` is the same unsafe statement regrouped, and
# in Solidity the inner subtraction ALSO underflows when released < consumed.
RE_ADDITION_PAREN = re.compile(
    r"(%s)\s*\+\s*\(\s*(%s)\s*%s\s*(%s)\s*\)" % (_REPORTED, _RELEASED, _DASH, _CONSUMED),
    re.I,
)
RE_BARE_SUB = re.compile(
    r"(%s)\s*%s\s*(%s)(?!\s*%s\s*%s)" % (_REPORTED, _DASH, _CONSUMED, _DASH, _RELEASED),
    re.I,
)
RE_BARE_CMP = re.compile(r"(%s)\s*(?:<=|≤)\s*(%s)" % (_CONSUMED, _REPORTED), re.I)
# The same false invariant reads naturally in the other direction.
RE_BARE_CMP_REV = re.compile(r"(%s)\s*(?:>=|≥)\s*(%s)" % (_REPORTED, _CONSUMED), re.I)
# The same unsafe bound commutes: `consumed <= released + reported` overflows on
# a hostile near-max report exactly as `reported + released` does.
RE_ADD_CMP = re.compile(
    r"(%s)\s*(?:<=|≤)\s*\(?\s*(?:%s\s*\+\s*%s|%s\s*\+\s*%s)"
    % (_CONSUMED, _RELEASED, _REPORTED, _REPORTED, _RELEASED),
    re.I,
)
RE_BARE_PROSE = re.compile(r"reported[- ]minus[- ]consumed", re.I)

# Identifiers that ALREADY encode the release adjustment are correct, not
# retired: `consumedMinusReleased <= reported` is the right bound written with a
# normalized name. Flagging it would force a block-wide exemption and blind the
# checker to a real defect elsewhere in that block.
# EXPLICIT shapes only. An earlier version also exempted any identifier merely
# STARTING with `net`, which waved through `networkConsumedCumulative <=
# networkReportedCumulative` — a genuinely retired bound whose name says nothing
# about releases. A prefix is not a meaning.
_ALREADY_NET = (
    "minusreleased",
    "lessreleased",
    "netofreleased",
    "netofrelease",
    "claimnet",
    "netclaim",
    "netconsumed",
    "consumednet",
)


def _is_already_net(identifier):
    """True only when the NAME itself encodes the release subtraction."""
    norm = identifier.lower().replace("_", "").replace(" ", "")
    return any(h in norm for h in _ALREADY_NET)


def comment_pieces(path):
    """Yield (start_line, joined_text, offsets, markers) per contiguous run.

    `offsets` maps each joined-text character offset back to its SOURCE LINE, so
    a violation can be attributed to the line that wrote it. That attribution is
    what makes an exemption occurrence-scoped instead of block-scoped: one marked
    historical mention must not license a newly introduced false statement
    fifteen lines later in the same NatSpec block.

    Comment CONTENT is extracted — delimiters stripped — from comment-only lines,
    trailing `//` comments, and block comments whether they open the line or
    follow code. Leaving the `///` in place is what made an earlier version's
    joining useless; only handling `/*` at line start is what made its
    block-comment coverage a subset of the real shapes.
    """
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.read().split("\n")

    extracted = []  # (line_no, comment_body_or_None)
    in_block = False
    for n, raw in enumerate(lines, 1):
        s_ = raw.strip()
        if in_block:
            body = s_
            if "*/" in body:
                body, in_block = body.split("*/", 1)[0], False
            extracted.append((n, body.lstrip("*").strip()))
            continue
        # A block comment may open anywhere on the line, not only at its start.
        bi = s_.find("/*")
        li = s_.find("//")
        if bi != -1 and (li == -1 or bi < li):
            body = s_[bi + 2:]
            if "*/" in body:
                body = body.split("*/", 1)[0]
            else:
                in_block = True
            extracted.append((n, body.lstrip("*").strip()))
            continue
        if li != -1:
            extracted.append((n, s_[li:].lstrip("/").strip()))
            continue
        extracted.append((n, None))

    i = 0
    while i < len(extracted):
        if extracted[i][1] is None:
            i += 1
            continue
        start_line = extracted[i][0]
        parts, offsets, markers = [], [], {}
        pos = 0
        while i < len(extracted) and extracted[i][1] is not None:
            ln, body = extracted[i]
            if MARKER in body:
                markers[ln] = body.split(MARKER, 1)[1].strip(" *-/")
            parts.append(body)
            offsets.append((pos, ln))
            pos += len(body) + 1
            i += 1
        yield start_line, " ".join(parts), offsets, markers


def _line_of(offsets, offset):
    line = offsets[0][1]
    for off, ln in offsets:
        if off <= offset:
            line = ln
        else:
            break
    return line


# How far an exemption reaches from its marker. Deliberately tight: a marker is
# an annotation on ONE mention, not a licence for the block it happens to sit in.
_MARKER_WINDOW = 3


def _find_violations(text, offsets, markers):
    """Return [(kind, source_line, exempt_reason_or_None)] for every occurrence.

    A marker is CONSUMED by exactly one source line — the nearest unclaimed
    occurrence within the window. Without consumption a marked historical
    mention exempted every match near it, so a new false statement one line
    later rode the old marker's licence; that is the block-scoping hole again,
    just smaller. Binding is per LINE rather than per match, because one
    sentence can legitimately trip two patterns at once (a bare form and an
    addition form named in the same breath) and should not need two markers.
    """
    matches = []
    def add(kind, offset):
        matches.append((offset, kind))

    for m in RE_ADDITION.finditer(text):
        add("ADDITION", m.start())
    for m in RE_ADDITION_PAREN.finditer(text):
        add("ADDITION", m.start())
    for m in RE_ADD_CMP.finditer(text):
        add("ADDITION", m.start())
    for m in RE_BARE_SUB.finditer(text):
        if not _is_already_net(m.group(2)):
            add("BARE", m.start())
    for m in RE_BARE_CMP.finditer(text):
        if not _is_already_net(m.group(1)):
            add("BARE", m.start())
    for m in RE_BARE_CMP_REV.finditer(text):
        if not _is_already_net(m.group(2)):
            add("BARE", m.start())
    for m in RE_BARE_PROSE.finditer(text):
        add("BARE", m.start())

    matches.sort()
    claimed = {}      # source line -> reason, for lines an exemption covers
    used = set()      # marker lines already spent
    out = []
    for offset, kind in matches:
        ln = _line_of(offsets, offset)
        if ln in claimed:
            out.append((kind, ln, claimed[ln]))
            continue
        best, best_d = None, None
        for mline in markers:
            if mline in used:
                continue
            d = abs(mline - ln)
            if d <= _MARKER_WINDOW and (best_d is None or d < best_d):
                best, best_d = mline, d
        if best is None:
            out.append((kind, ln, None))
        else:
            used.add(best)
            claimed[ln] = markers[best]
            out.append((kind, ln, markers[best]))
    return out


def scan():
    violations, allowed = [], []
    per_root = {}
    for root in ROOTS:
        files = blocks = 0
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames if d not in ("lib", "out", "cache", "node_modules")
            ]
            for fn in sorted(filenames):
                if not fn.endswith(".sol"):
                    continue
                files += 1
                full = os.path.join(dirpath, fn)
                path = os.path.relpath(full)
                for line, text, offsets, markers in comment_pieces(full):
                    blocks += 1
                    for kind, srcline, reason in _find_violations(text, offsets, markers):
                        if reason is None:
                            violations.append((path, srcline, kind, text[:150]))
                        elif len(reason) < 10:
                            violations.append(
                                (path, srcline, "EMPTY-MARKER",
                                 "%s carries no reason on its own line (found %r)"
                                 % (MARKER, reason))
                            )
                        else:
                            allowed.append((path, srcline, kind, reason[:90]))
        per_root[root] = (files, blocks)
    return violations, allowed, per_root


def main():
    violations, allowed, per_root = scan()

    # EVERY root must have been walked. An aggregate count hides the case where
    # one root is missing, mistyped or unreadable while the other still returns
    # thousands of blocks — which reinstates the zero-directory failure for half
    # the promised scope.
    dead = [r for r, (f, b) in per_root.items() if f == 0 or b == 0]
    if dead:
        print(
            "check-commitment-formula: FAILED — these scan roots yielded nothing:\n"
            + "\n".join(
                "  %s  (%d file(s), %d comment block(s))" % (r, per_root[r][0], per_root[r][1])
                for r in dead
            )
            + "\nA check that finds nothing must prove it looked. If this script "
            "moved, fix its root resolution.",
            file=sys.stderr,
        )
        return 1

    files = sum(f for f, _ in per_root.values())
    blocks = sum(b for _, b in per_root.values())

    if "--list" in sys.argv:
        print("Deliberate mentions (%d):" % len(allowed))
        for path, line, kind, reason in allowed:
            print("  %s:%d  [%s]  %s" % (path, line, kind, reason))
        print()

    if not violations:
        print(
            "check-commitment-formula: OK — %d file(s), %d comment block(s) scanned "
            "across %d root(s); no retired availability form stated (%d deliberate "
            "mention(s) marked)." % (files, blocks, len(per_root), len(allowed))
        )
        return 0

    print("check-commitment-formula: %d occurrence(s) of a RETIRED availability "
          "form (of %d comment block(s) in %d file(s)):\n"
          % (len(violations), blocks, files), file=sys.stderr)
    for path, line, kind, text in violations:
        print("  %s:%d  [%s]" % (path, line, kind), file=sys.stderr)
        print("      %s" % text, file=sys.stderr)
    print(
        "\nThe correct shapes are `sat(consumed - released) <= reported` and\n"
        "`reported - sat(consumed - released) - netRepatriationDraw`, both\n"
        "subtraction-first. If a mention is deliberate — rejecting the form, or\n"
        "describing a past revision — add `%s <reason>` on one line, WITHIN %d\n"
        "lines of the mention it explains." % (MARKER, _MARKER_WINDOW),
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
