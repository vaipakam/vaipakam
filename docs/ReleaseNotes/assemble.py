#!/usr/bin/env python3
"""
Fold pending release-note fragments into a dated file, then remove them.

This is the implementation; `assemble.sh` is the entry point and calls
it. The behaviour, the messages and the exit codes are the shell
version's, because `assemble.test.sh` drives the command from outside
and its ~990 assertions are the specification.

WHY THIS IS PYTHON (#1877)
--------------------------
The shell version reached ~2,600 lines and forty-six review rounds. The
findings had stopped being about the design and started being about the
application of it: a guard placed one step too late, a check that
answered for startup and not for the moment it mattered, two lists
describing one fact. That is what a program too large to hold in one
head produces, and adding a forty-seventh guard was not going to end it.

The transactional core is the part that kept generating them, and it is
the part a shell is worst at: every primitive it needs — rename, stat,
hash, a temporary file, a signal window — is a subprocess whose failure
has to be routed by hand, and the routing is what kept being missed. In
Python they are library calls that raise, so the failure path is the
language's rather than something reconstructed at each site.

The rewrite was safe to attempt for one reason: the test suite drives
the CLI, not the internals, so it ports across unchanged and every
divergence from the old behaviour shows up as a failing assertion.

WHAT IT DEFENDS AGAINST, AND WHAT IT DOES NOT
---------------------------------------------
IN SCOPE: an ordinary environment behaving awkwardly. A run interrupted
at any point, an editor saving a fragment mid-run, a second assembly
started by mistake, a filesystem refusing something, a filename or a
byte that is legal but awkward. Those happen by accident, routinely, and
each costs text that exists nowhere else.

NOT IN SCOPE: somebody hostile who can already write to this directory.
Not because such attacks are imaginary, but because anyone with that
access can delete the notes, rewrite the published file, or edit this
script — none of which involves racing anything. Hardening against their
most awkward option while the direct ones stay open buys the appearance
of safety rather than the thing.

THE INVARIANT
-------------
A fragment is removed only when its text is demonstrably in the dated
file on disk. Everything else here serves that one sentence.
"""

from __future__ import annotations

import errno
import hashlib
import os
import re
import shutil
import signal
import stat as statmod
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

# ── Constants ────────────────────────────────────────────────────────────────

MARKER_PREFIX = "<!-- assembled-fragment: "
MARKER_RE = re.compile(
    r"^" + re.escape(MARKER_PREFIX) + r"(.+) sha256=([0-9a-f]{64}) -->\r?$"
)
# Markdown allows an ATX heading up to THREE leading spaces; at four it is
# an indented code block. Anchoring on `#` made ` # Thread — x (PR #1)`
# invisible here while GitHub still rendered it as a level-1 heading, so a
# fragment could take the deliberate no-heading allowance and publish the very
# peer-document defect the conformance check exists to stop (#2290 r1).
#
# The delimiter after the marker is a space, a TAB, or the end of the line —
# `#\tTitle` and a bare `#` are both level-1 headings to a Markdown renderer
# (#2290 r2). Requiring a literal space let either through the same allowance,
# which is the second time this regex has turned an exemption into a bypass:
# a check that misses a shape does not merely fail to refuse it, it actively
# permits it via the no-heading branch.
HEADING_RE = re.compile(rb"^ {0,3}#{1,6}(?:[ \t]|$)")
# The three line endings CommonMark recognises. `\r\n` must come first, or a
# CRLF file splits into a trailing empty field per line.
#
# INVARIANT: NOTHING IN THIS FILE SPLITS LINES ANY OTHER WAY, and it is
# pinned by `T217w` rather than left to memory (#2301 r3). Three consecutive
# review rounds each found a different scan still on `\n` alone — the `---`
# check, the markerless duplicate guard, then the two marker scans — because
# a local `split(b"\n")` reads as obviously correct at every call site and is
# wrong only in relation to the others. The failures were not cosmetic: one
# appended a duplicate section and consumed the source, and one published an
# embedded marker record that a later LF-normalisation would make
# authoritative, clearing an unrelated fragment unread.
LINE_END_RE = re.compile(rb"\r\n|\r|\n")
# A BLANK LINE, as CommonMark defines one: empty, or spaces and tabs only.
# NOT `bytes.strip()`, which also treats a vertical tab, a form feed and the
# C0 file/group/record/unit separators as whitespace (#2301 r1). A fragment
# opening with a lone `\x0b` and a heading under it was therefore skipped to
# the heading and accepted — published with a stray control character above
# its title, and in contradiction of the rule that the OPENING line must be
# the heading. Narrowing this can only refuse more, never publish more.
BLANK_RE = re.compile(rb"^[ \t]*$")


def without_markers(data: bytes) -> bytes:
    """`data` with each well-formed assembly-marker line blanked, same length.

    A marker is this script's own record, not section text, and it carries
    the fragment's file name as the filesystem gave it — which may be any
    bytes (T107). So `unreadable_at` must not judge a file by its markers
    (#2328 r1): a non-UTF-8 name in one would otherwise make every other
    pending fragment look unanswerable. Blanked with spaces rather than
    removed, so an offset reported afterwards is still an offset into the
    file.
    """
    out = bytearray(data)
    prefix = os.fsencode(MARKER_PREFIX)
    start = 0
    ends = [(m.start(), m.end()) for m in LINE_END_RE.finditer(data)]
    for line_end, next_start in ends + [(len(data), len(data))]:
        line = data[start:line_end]
        if line.startswith(prefix) and MARKER_RE.match(os.fsdecode(line)):
            out[start:line_end] = b" " * (line_end - start)
        start = next_start
    return bytes(out)


def unreadable_at(data: bytes):
    """Where `data` stops being text a byte comparison can speak for (#2315).

    Returns `(offset, reason)` for the first such byte, or None. Two arms,
    each with a shape only it catches: bytes that are not UTF-8 at all (a
    UTF-16 BOM, a legacy single-byte `é`), and a NUL, which is valid UTF-8
    but is how UTF-16 or UTF-32 WITHOUT a BOM stores plain ASCII. No release
    note has a use for either, and all 86 dated files carry neither.

    This decides whether a comparison can be TRUSTED, not what the bytes
    say. Guessing the other encoding means splitting one file into regions
    of different encodings, and that is inference with no ground truth;
    saying the question cannot be answered is exact.
    """
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as e:
        return e.start, "not valid UTF-8"
    nul = data.find(b"\x00")
    if nul != -1:
        return nul, "a NUL byte"
    return None


# The PR NUMBER, and only it. `_TEMPLATE.md` ships the reference as the
# literal `#NNNN`, and a present-but-unsubstituted one is the defect this
# catches (#2288).
#
# The token stops at the first comma or space, because `(PR #2184, issue
# #2099)` is an established heading shape here — seventeen of them — and
# capturing to the closing parenthesis refused every one (#2290 r1).
#
# And `PR #` is matched WHEREVER it appears in the heading, not only just
# inside the parenthesis. Eight published headings put it last —
# `(T-090 v1.2 #428, PR #<n>)` — so anchoring on `\(PR #` found nothing there
# and the placeholder sailed through as "no reference at all" (#2290 r2).
# Up to the next comma, bracket or space — the shape `(PR #123, issue #99)`
# and `(PR #123)` both need. The token is then required to be ALL DIGITS; see
# `check_heading_conformance` for why that rule stops being refined there.
PR_REF_RE = re.compile(rb"PR #([^,)\s]*)")
# There is deliberately no setext-underline pattern here. `first_heading`
# recognises ATX only; its docstring records why the setext branch was
# removed rather than refined (#2290 r6).


SKIP_NAMES = {"README.md", "_TEMPLATE.md"}


class Refuse(Exception):
    """A pre-publication refusal: report, then exit 1 with nothing consumed."""


class AbortAfterWrite(Exception):
    """A failure in the clearing step, after the dated file is published."""


# Diagnostics are written in UTF-8 regardless of the ambient locale
# (Codex #1898 r2). Nearly every message here carries an em dash or an
# arrow, and under an ASCII stdio encoding — `LC_ALL=C` with the UTF-8
# mode off — `print` raises `UnicodeEncodeError`. That turned a
# no-pending run's successful exit into a traceback, and could raise
# AFTER publication and fragment clearing, where a traceback is the one
# thing this script must never answer with. `backslashreplace` is the
# floor: if a stream genuinely cannot carry a character, the message
# still gets out, degraded rather than fatal.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, ValueError, OSError):
        # A stream that cannot be reconfigured (already detached, or
        # replaced by something without the method) is not worth dying
        # over here — the writes below tolerate it.
        pass


def first_heading(body: bytes) -> tuple[int, bytes] | None:
    """The heading a fragment OPENS with, as `(level, line)`, or None.

    THIS IS A LINT ON THE FRAGMENT'S OPENING LINE, NOT A MARKDOWN PARSER,
    and that distinction is the whole design (#2290 r5).

    It used to SCAN for the first heading anywhere in the fragment. Six
    review findings came out of that, every one the same shape: something
    was misread as a heading or a fence, the scan STOPPED there, and a real
    `#` heading below was never examined — an indented ATX marker (r1), a
    tab delimiter (r2), setext (r3), a YAML fence (self-found), an INDENTED
    `---` taken for a fence (r5), and a list item above a thematic break
    (r5). Each fix bought one case and left the structure that produced it:
    deciding Markdown BLOCK CONTEXT with regexes. That cannot be done —
    whether `---` closes front matter, underlines a heading, or is a
    thematic break depends on everything above it.

    So it no longer scans. `_TEMPLATE.md` puts the heading on the first
    line, every fragment in this repository does the same, and that is the
    line this reads. Nothing is skipped over, so nothing can be masked, and
    a misread at the opening line can only mis-describe that line rather
    than hide another.

    THE WEAKENING IS REAL AND DELIBERATE. A `#` heading further down a
    fragment is no longer examined and would still land in the dated file as
    a peer document title. No fragment does that; it is malformed in a way a
    reader sees; and the alternative is a Markdown parser — a dependency and
    an unbounded surface for a lint on a house convention. Six rounds of
    evidence say the scanning version was the more dangerous of the two,
    because its failures were silent and this one's is visible.

    Recognises ATX only — `## Title`, one to six `#`, up to three leading
    spaces, closed by a space, a tab, or end of line.

    SETEXT IS DELIBERATELY NOT RECOGNISED, and removing it is a root fix
    rather than a gap (#2290 r6). It was added in r4 for a shape nobody had
    observed, and it then produced a finding in each of the three rounds
    that followed: a list above a thematic break read as a heading (r5); the
    markerless-duplicate guard comparing a title line without its underline,
    which refuses a fragment over ordinary prose (r6); and a title wrapped
    across lines before its underline, which this would miss (r6). Each was
    a real edge, and each existed only because the branch did.

    The corpus settles it. Of the 758 distinct fragments ever committed to
    `unreleased/`, 758 open with an ATX heading and ZERO contain a
    setext-shaped pair anywhere. So the branch guarded nothing that has ever
    happened while generating four findings, which is the pattern #2149
    records: an edge-producing speculative branch is removed, not refined.

    The residual is stated plainly, and #2295 changed what it costs: a
    fragment whose title is underlined rather than `#`-prefixed is not
    recognised here, and is therefore REFUSED by `check_heading_conformance`
    rather than published unexamined. Not recognising a shape no longer means
    blessing it — which is what makes reading one line in one form safe.

    IT NORMALISES ONLY WHAT CANNOT CHANGE HOW THE PUBLISHED BYTES RENDER (#2290
    r12). `build()` appends the fragment's raw bytes — through
    `rewrite_links`, whose two substitutions cannot touch an ATX marker —
    so any transformation made here and not there decides about one
    document while publishing another. Skipping leading blank lines passes:
    a heading after blank lines is still a heading. So does splitting on
    all three CommonMark line endings (#2295), which makes this agree with
    the renderer about where the first line ends rather than rewriting
    anything; splitting on `\\n` alone once read a CR-only file as one line
    and ran the PR-reference check over its whole body. A leading BOM and a
    front-matter fence both FAIL the rule, which is why each used to be
    normalised here and no longer is: `BOM + ## Heading` renders
    mid-document as a paragraph, and `---` / `title: x` / `---` as a
    thematic break over a setext heading. Both are refused instead. Whether
    two heading LINES match is a different question from whether a line IS
    a heading; the duplicate guard, which asks the first, records why it
    compares the published form.

    Front matter is NOT skipped — it is refused, by `check_heading_conformance`
    and before this function is reached. An earlier revision skipped it, and
    this paragraph still described that after the behaviour changed (#2290
    r12), which is the opposite of the truth for anyone reading the contract
    here rather than the caller.

    The same holds for raw HTML — `<h1>Title</h1>` renders as a heading on
    GitHub but is not Markdown syntax and is not detected. Zero occurrences
    anywhere in `docs/ReleaseNotes`, checked; and recognising it properly
    means parsing HTML, which is the unbounded surface this function exists
    to avoid. Since #2295 that fragment is refused rather than published, so
    not detecting HTML is a message to its author, not a mangled note.
    """
    # Only what cannot change how the published bytes render is normalised:
    # leading blank lines are skipped and the line is split with the shared
    # `LINE_END_RE`. The rule, and why a BOM and front matter fail it, is in
    # the docstring.
    lines = LINE_END_RE.split(body)
    i = 0
    while i < len(lines) and BLANK_RE.match(lines[i]):
        i += 1
    if i >= len(lines):
        return None
    line = lines[i]
    if HEADING_RE.match(line):
        marker = line.lstrip(b" ")
        return len(marker) - len(marker.lstrip(b"#")), line
    return None


# EVERY BYTE THIS SCRIPT WRITES TO A TERMINAL PASSES HERE (#2302). Messages
# quote author-controlled text back — a fragment's opening line, its file
# name — and a terminal obeys what it is sent: `\x1b[2K\x1b[G` erases the
# refusal and prints whatever follows over it, so a fragment could make a
# refused run LOOK successful. The run itself stayed refused; what was
# forgeable was the operator's account of it.
#
# Fixed at the two writers rather than at each quoting site, because the
# sites are the unbounded side: a file name reaches dozens of messages, and
# the next message to quote something would have to remember. No message
# carries a control character on purpose, so escaping them all costs nothing.
#
# ESCAPED, NOT STRIPPED: a control character in a file name is a fact about
# that file, and hiding it would leave the operator unable to find it.
# Covered: C0, DEL and C1 (C1 because `\x9b` is a one-byte CSI to terminals
# that honour it), plus the bidirectional controls, which reorder a line on
# screen without any escape sequence at all. Printable Unicode — every em
# dash in every heading here — is left alone.
_TERMINAL_UNSAFE_RE = re.compile(
    "[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]"
)


def terminal_safe(msg: str) -> str:
    """`msg` with every control character shown as a visible escape."""
    return _TERMINAL_UNSAFE_RE.sub(
        lambda m: (
            f"\\x{ord(m.group()):02x}"
            if ord(m.group()) < 0x100
            else f"\\u{ord(m.group()):04x}"
        ),
        msg,
    )


# QUOTED AUTHOR TEXT IS CAPPED (#2302). A fragment's opening line is echoed
# whole, and nothing bounds its length; past this many characters the
# message stops being readable, and the file name beside it already says
# where to look. Escaping is `terminal_safe`'s job, at the writers — this
# is only about length.
QUOTE_LIMIT = 160


def capped(text: str) -> str:
    """`text` cut at `QUOTE_LIMIT`, saying how much was left out.

    Applied to the WHOLE author-controlled value a message quotes, never to
    its parts: a list of short pieces each under the limit joins into one
    that is not (#2323 r1 — ten thousand `PR #BAD` tokens made 51 KB).
    """
    if len(text) <= QUOTE_LIMIT:
        return text
    return f"{text[:QUOTE_LIMIT]}… ({len(text) - QUOTE_LIMIT} more characters)"


def quoted(raw: bytes) -> str:
    """Author bytes as shown in a message: decoded, then `capped`."""
    return capped(raw.decode("utf-8", errors="replace"))


def out_line(msg: str = "") -> None:
    print(terminal_safe(msg))


def err(msg: str = "") -> None:
    print(terminal_safe(msg), file=sys.stderr)


# ── Hashing ──────────────────────────────────────────────────────────────────


def frag_hash(path: str) -> str:
    """sha256 of a file's contents.

    Reads in chunks: a fragment is small, but the dated file is not
    necessarily, and a whole-file read is a needless memory spike in a
    tool whose entire job is not to fail.
    """
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def read_mode(path: str) -> str:
    """Permission bits as octal digits, setuid/setgid/sticky included."""
    return format(statmod.S_IMODE(os.stat(path).st_mode), "o")


def git_path(stdout: str) -> str:
    """A path git printed, with only its record terminator removed.

    `.strip()` is wrong for a path: a directory component may legally end
    in a space, and stripping it addresses somewhere that does not exist.
    Git terminates these single-value outputs with one newline (and a
    Windows checkout may add the carriage return), so that is all that
    comes off.
    """
    return stdout.rstrip("\n").rstrip("\r")


def identity_owner(identity: str | None) -> tuple[int, int]:
    """The (uid, gid) recorded inside a `file_identity` string.

    Read back rather than re-stat'ed, so a decision made from the
    baseline and a decision made from the recheck cannot disagree about
    which owner they meant. A missing or malformed identity yields the
    running user, which is the only safe reading: it means the file did
    not exist when this run started, so nothing is being taken from
    anyone.
    """
    if identity:
        m = re.search(r"owner=(\d+):(\d+)$", identity)
        if m:
            return int(m.group(1)), int(m.group(2))
    return os.getuid(), os.getgid()


def file_identity(path: str) -> str:
    """Content + mode + owner, as one comparable string.

    One value on purpose: "is this still the file this run was working
    from?" is a single question, and asking it as three invited an
    answer that was right about two of them.
    """
    st = os.stat(path)
    return (
        f"{frag_hash(path)} mode={format(statmod.S_IMODE(st.st_mode), 'o')} "
        f"owner={st.st_uid}:{st.st_gid}"
    )


# ── Signal windows ───────────────────────────────────────────────────────────


class HoldSignals:
    """Defer INT/TERM across a sequence that must not be interrupted midway.

    The shell version had to block, act, and re-arm by hand at each site,
    and three separate rounds found a site where the re-arm was missing
    or the window was one instruction too wide. A context manager cannot
    be left half-applied.
    """

    def __enter__(self):
        self._old = signal.pthread_sigmask(
            signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM}
        )
        return self

    def __exit__(self, *exc):
        signal.pthread_sigmask(signal.SIG_SETMASK, self._old)
        return False




# ── One place an operation can fail ──────────────────────────────────────────
#
# The shell version had exactly one wrapper — `run_checked` — and every
# fallible step went through it. That is why its failures all read the
# same way, and why a test could name the step it wanted to break.
#
# The port scattered bespoke try/except instead, and the cost showed up
# immediately: thirty-eight cases had nothing single to aim at, and I
# started converting them one at a time. That was patching each path
# rather than restoring the thing the paths used to share.
#
# So the wrapper comes back. Every fallible step names itself, the name
# is the SAME string the shell used, and there is one renderer and one
# handler. A test breaks a step by naming it in `ASSEMBLE_TEST_FAIL`,
# which is the direct equivalent of shimming the command that step used
# to run — and it survives the implementation changing how the step is
# done, which shimming never did.
class StepFailed(Exception):
    """A named operation failed. Rendered and handled in exactly one place."""

    def __init__(self, what: str, code: int = 1):
        super().__init__(what)
        self.what = what
        self.code = code


_FAIL_STEPS = {
    step for step in os.environ.get("ASSEMBLE_TEST_FAIL", "").split("|") if step
}


def checked(what: str, fn, *args, **kwargs):
    """Run one fallible step. Any failure becomes a named StepFailed."""
    if what in _FAIL_STEPS:
        raise StepFailed(what)
    try:
        return fn(*args, **kwargs)
    except OSError as e:
        raise StepFailed(what, e.errno or 1) from e


# ── The test seam ────────────────────────────────────────────────────────────
#
# A named point where a test may act, and nothing else.
#
# The old suite injected faults by shimming whichever command the shell
# happened to spawn — `sed` for the link rewrite, `sync` for the flush,
# `grep` for the marker scan. That worked, and it tested the
# IMPLEMENTATION's choice of subprocess rather than the moment the case
# was really about: a fragment edited during the flush, an output file
# replaced mid-scan. Those moments are still real here; the subprocesses
# are not.
#
# So the moments are named. `ASSEMBLE_TEST_HOOK_DIR` points at a
# directory; if an executable matching the phase name is in it, it runs
# with the run's paths in the environment, and a non-zero exit means
# "this phase failed" — the same fault the shim used to produce.
#
# Deliberately inert unless that variable is set, and it is set by
# nothing but the suite. A seam a test can rely on is worth more than a
# coincidence a test can exploit: the coincidence breaks whenever the
# implementation changes which command it calls, which is exactly what
# just happened to 114 cases.
_HOOK_DIR = os.environ.get("ASSEMBLE_TEST_HOOK_DIR", "")


def test_hook(phase: str, **paths: str) -> None:
    """Run the hook for `phase` if one exists.

    A non-zero exit means the phase failed, and it is RAISED rather than
    returned (Codex #1898 r1). Returning a bool left it to each call
    site to check, four of them did not, and a migrated case could then
    stop injecting the failure it claimed to cover while still passing —
    the seam quietly not checking, which is the failure this whole
    suite is about.
    """
    if not _HOOK_DIR:
        return
    script = os.path.join(_HOOK_DIR, phase)
    if not os.path.isfile(script) or not os.access(script, os.X_OK):
        return
    env = dict(os.environ)
    # The run's own pid, so a case can signal it at a known moment —
    # which is the only way to test that a signal arriving mid-run
    # still reaches the cleanup path.
    env["ASSEMBLE_PID"] = str(os.getpid())
    for key, value in paths.items():
        env[f"ASSEMBLE_{key.upper()}"] = value
    if subprocess.run([script], env=env).returncode != 0:
        raise StepFailed(f"the {phase} phase")


# ── The run ──────────────────────────────────────────────────────────────────


class Assembly:
    def __init__(self, directory: str, date: str, allow_mixed: bool, force: bool):
        self.dir = directory
        self.unrel = os.path.join(directory, "unreleased")
        self.qdir = os.path.join(self.unrel, ".assembled")
        self.lock = os.path.join(self.unrel, ".assemble.lock")
        self.date = date
        self.allow_mixed = allow_mixed
        self.force = force
        self.out = os.path.join(directory, f"ReleaseNotes-{date}.md")

        self.lock_held = False
        self.marker_seen: dict[tuple[str, str, str], bool] = {}
        self.workdir: str | None = None
        self.work: str | None = None
        self.snap: str | None = None
        self.probe: str | None = None

        # What has happened to fragments, in ONE record. Two lists
        # describing the same fact disagreed eventually, which is what
        # let a failure report say "nothing has been consumed" three
        # lines after naming what it had consumed.
        self.consumed: list[str] = []
        self.quarantined: list[str] = []
        self.published = False

        self.out_id: str | None = None
        self.out_mode: str | None = None
        self.out_copy: str | None = None
        self.src_id: dict[str, str] = {}
        self.frag_name: dict[str, str] = {}
        self.frag_snap: dict[str, str] = {}
        self.frag_hash: dict[str, str] = {}
        self.held_paths: list[str] = []
        self.frags: list[str] = []
        self.expected_id: str | None = None
        self.published_id: str | None = None
        self.final_mode: str | None = None
        self.approved_gid: int | None = None

    # ── cleanup ──────────────────────────────────────────────────────────

    def cleanup(self) -> None:
        """Release everything this run holds. Every step is non-fatal.

        A cleanup that can itself fail part way leaves the lock behind,
        which is the one piece of state a later run cannot work around.
        """
        # The seam sits at the TOP of cleanup, because the moment worth
        # testing is a signal arriving while cleanup is part way through
        # (Codex #1898 r2) — before the lock release, which is the one
        # piece of state a later run cannot work around.
        #
        # Its exit code is deliberately ignored, unlike every other
        # phase: cleanup has no failure semantics to enforce — every step
        # in it is non-fatal by design — and a hook that could raise here
        # would introduce the exact abort this seam exists to test for.
        try:
            test_hook("cleanup", out=self.out)
        except StepFailed:
            pass

        probe, self.probe = self.probe, None
        work, self.work = self.work, None
        workdir, self.workdir = self.workdir, None
        snap, self.snap = self.snap, None

        for path, remover in (
            (probe, os.remove),
            (work, os.remove),
        ):
            if path:
                try:
                    remover(path)
                except OSError:
                    pass
        for path in (workdir, snap):
            if path:
                shutil.rmtree(path, ignore_errors=True)

        if self.lock_held:
            self.lock_held = False
            try:
                os.rmdir(self.lock)
            except OSError:
                err("")
                err(f"Warning: could not release the assembly lock at {self.lock}.")
                err("The next run will refuse to start until it is gone. Remove it")
                err(f"with:  rmdir {self.lock}")
                err("(or 'rm -rf' it if something has left files inside.)")

    # ── reporting ────────────────────────────────────────────────────────

    def refuse_reporting_consumed(self) -> None:
        """The ONE reporter. Every refusal ends here so the answer is uniform."""
        err("")
        if self.consumed:
            err("Already removed before this was noticed:")
            for name in self.consumed:
                err(f"  {name}")
            err("")
            if self.published:
                err(
                    f"Their content is in {os.path.basename(self.out)}, which this "
                    "run wrote and"
                )
                err("verified. Nothing needs recovering for these.")
            else:
                err(
                    f"Their text was in {os.path.basename(self.out)} when they went. "
                    "If the change"
                )
                err("above removed it, recover them from git.")
        elif not self.quarantined:
            err("Nothing has been consumed and no fragment has been touched.")

        if self.quarantined:
            err("Moved aside but not removed:")
            for name in self.quarantined:
                err(f"  {name}")
            err("")
            err("These are no longer in the pending pool. Compare each against the")
            err("dated file, then delete it or move it back up a level.")
        err("Nothing further will be consumed. Re-run once the other change has")
        err("settled.")
        raise SystemExit(1)

    def abort_after_write(self, what: str) -> None:
        err("")
        err(f"Error: {what}.")
        err("")
        err(
            f"{os.path.basename(self.out)} HAS ALREADY BEEN WRITTEN — this failure "
            "is in the"
        )
        err("clearing step that follows it, so the run is half done.")
        err("")
        err(
            f"Everything still in {self.unrel} is either uncleared or set aside. "
            "Re-running"
        )
        err("is safe: the markers in the dated file are how the next run recognises")
        err("what is already folded in.")
        self.refuse_reporting_consumed()

    # ── quarantine directory ─────────────────────────────────────────────

    def qdir_device_state(self) -> str:
        try:
            a = os.stat(self.unrel).st_dev
            b = os.stat(self.qdir).st_dev
        except OSError:
            return "unknown"
        return "same" if a == b else "different"

    def qdir_device_complaint(self) -> None:
        err(f"Error: {self.qdir} is not on the same filesystem as {self.unrel}.")
        err("")
        err("Refusing to assemble: setting a fragment aside relies on the move")
        err("being a rename. Across a filesystem boundary it becomes a copy")
        err("followed by a delete, and anything writing to the original path in")
        err("between has its text deleted while the copy keeps the older")
        err("version — the loss setting aside exists to prevent.")

    def probe_qdir(self, at_gate: bool) -> None:
        """Create and remove an entry. Existence was never the question.

        `mkdir -p` succeeds on a directory whatever its mode, and a
        truncating write succeeds on an existing file inside an
        otherwise unwritable one — so the operation tested has to be the
        operation performed: making a directory entry and unlinking it.
        """
        try:
            with HoldSignals():
                fd, path = tempfile.mkstemp(prefix=".probe.", dir=self.qdir)
                self.probe = path
                os.close(fd)
        except OSError:
            if at_gate:
                err(f"Error: entries can no longer be created in {self.qdir}.")
                self.refuse_reporting_consumed()
            err(f"Error: entries cannot be created and removed in {self.qdir}.")
            err("Refusing to assemble: fragments set aside during the run are moved")
            err("there, so this would fail only after the dated file was written.")
            raise SystemExit(1)
        try:
            os.remove(path)
        except OSError:
            self.probe = None
            if at_gate:
                err(f"Error: entries can no longer be removed from {self.qdir}.")
                self.refuse_reporting_consumed()
            err(f"Error: entries cannot be created and removed in {self.qdir}.")
            err("Refusing to assemble: fragments set aside during the run are moved")
            err("there, so this would fail only after the dated file was written.")
            raise SystemExit(1)
        self.probe = None

    def ensure_qdir(self) -> None:
        if os.path.islink(self.qdir) or (
            os.path.exists(self.qdir) and not os.path.isdir(self.qdir)
        ):
            err(f"Error: {self.qdir} exists and is not a directory.")
            err("Refusing to assemble: fragments set aside during the run are moved")
            err("there, and this would fail after the dated file was written.")
            raise SystemExit(1)
        try:
            os.makedirs(self.qdir, exist_ok=True)
        except OSError:
            err(f"Error: could not create {self.qdir}.")
            err("Refusing to assemble: see above; the failure is cheap here and")
            err("expensive later.")
            raise SystemExit(1)

        self.probe_qdir(at_gate=False)

        state = self.qdir_device_state()
        if state == "unknown":
            # "Cannot tell" is not "is wrong". Refusing here would make a
            # working stat a hard dependency for a check guarding an
            # arrangement nobody has — this directory is created inside
            # the pool, so it differs only if something is mounted there.
            err(f"Warning: could not confirm {self.qdir} is on the same filesystem as the")
            err("pool. If it is a mount point, setting a fragment aside is a copy")
            err("and delete rather than a rename, and a concurrent write to the")
            err("original could be lost.")
        elif state == "different":
            self.qdir_device_complaint()
            raise SystemExit(1)

    # ── output path ──────────────────────────────────────────────────────

    def check_out_path(self) -> None:
        if os.path.islink(self.out):
            err(f"Error: {self.out} is a symbolic link.")
            err("Refusing to assemble: the rename would replace the link itself and")
            err("leave its target unchanged, while consuming every fragment.")
            err("Assemble into the real path, or replace the link with a regular file.")
            raise SystemExit(1)
        if os.path.exists(self.out) and not os.path.isfile(self.out):
            err(f"Error: {self.out} exists and is not a regular file.")
            err("Refusing to assemble: the fragments would be consumed and the")
            err("assembled notes would not be at that path.")
            raise SystemExit(1)

    # ── lock ─────────────────────────────────────────────────────────────

    def acquire_lock(self) -> None:
        try:
            with HoldSignals():
                os.mkdir(self.lock)
                self.lock_held = True
        except FileExistsError:
            err("Error: another assembly appears to be running.")
            err("")
            err(f"  lock: {self.lock}")
            err("")
            err("Two overlapping runs share the pending pool, so they can lose a")
            err("fragment entirely or duplicate one across two dated files — even when")
            err("they are assembling different days.")
            err("If no other run is active, the lock is stale from an interrupted run:")
            err(f"  rmdir '{self.lock}'")
            raise SystemExit(1)

    # ── leftovers from earlier runs ──────────────────────────────────────

    def report_leftovers(self) -> None:
        stale_probe, setaside = [], []
        try:
            entries = sorted(os.listdir(self.qdir))
        except OSError:
            entries = []
        for name in entries:
            if name.startswith(".probe."):
                stale_probe.append(name)
            else:
                setaside.append(name)

        if stale_probe:
            err(f"Left in {self.qdir} by an interrupted run:")
            for n in stale_probe:
                err(f"  {n}")
            err("")
            err("These are empty writability-test files, not fragments. Nothing was")
            err("assembled from them and nothing depends on them; delete them.")
            err("")
        if setaside:
            err(f"Set aside by an earlier run, still in {self.qdir}:")
            for n in setaside:
                err(f"  {n}")
            err("")
            err("Each is either a fragment this script had finished folding into a")
            err("dated file when it was interrupted, or one whose bytes CHANGED while")
            err("it was being read.")
            err("")
            err("Those are not the same, and the difference matters (Codex #1863 r26):")
            err("an interrupted one is already in the dated file, but a CHANGED one")
            err("holds the newer text while the dated file holds only what was read")
            err("first — so it may be the sole copy of an edit. Compare each against")
            err("the dated file before deleting it, or move one back to assemble it.")
            err("")

        stale_tmp = sorted(
            n for n in os.listdir(self.dir) if n.startswith(".assemble-")
        )
        if stale_tmp:
            err(f"Left behind by an interrupted run, still in {self.dir}:")
            for n in stale_tmp:
                err(f"  {n}")
            err("")
            err("Each is scratch work from an assembly that was killed outright: a")
            err("dated file built but never renamed into place, or a directory of")
            err("working copies of the fragments. Nothing here depends on them and no")
            err("dated file is missing anything because of them. Delete them once you")
            err("have looked -- otherwise 'git add -A docs/ReleaseNotes/' stages one.")
            err("")

    # ── discovery ────────────────────────────────────────────────────────

    def discover(self) -> None:
        found = []
        for name in os.listdir(self.unrel):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            found.append(os.path.join(self.unrel, name))

        if not found:
            out_line(f"No pending fragments in {self.unrel} — nothing to assemble.")
            raise SystemExit(0)

        for path in found:
            if "\n" in os.path.basename(path):
                err("Error: a fragment filename contains a newline.")
                err("")
                err(f"  {path!r}")
                err("")
                err("Refusing to assemble: fragments are ordered by a newline-delimited")
                err("sort, so such a name would be split into two and the run would fail")
                err("later with a confusing error about a file that does not exist.")
                err("Rename the fragment.")
                raise SystemExit(1)

        # Ordering is a permutation, and here it cannot lose an entry:
        # `sorted` returns a list of the same objects. The shell version
        # piped through `sort(1)`, whose failure was invisible and could
        # silently shorten the pool.
        self.frags = sorted(found)

    # ── UTC-day selection ────────────────────────────────────────────────

    def git(self, *args: str, cwd: str | None = None) -> subprocess.CompletedProcess:
        # `surrogateescape`, not the locale's strict decoder (Codex #1898
        # r2). `git status -z` emits a filename's bytes verbatim, so a
        # fragment whose name carries an undecodable byte made the strict
        # decode raise `UnicodeDecodeError` — a traceback on the DEFAULT
        # date-selecting path, before publication. The same escape the
        # filesystem encoding uses round-trips those bytes through
        # `os.fsencode` when the name is written back out, which is what
        # the marker line and the set-aside rename already do.
        try:
            return subprocess.run(
                ["git", "-C", cwd or self.dir, *args],
                capture_output=True,
                text=True,
                errors="surrogateescape",
            )
        except (FileNotFoundError, NotADirectoryError):
            # NO GIT AT ALL is a different answer from git failing, and
            # the difference matters here (Codex #1898 r3). A genuine
            # export or tarball on a machine with Python but no `git`
            # raised out of the very first probe, so the non-git fallback
            # below — the documented, T6-tested contract that such a tree
            # assembles everything pending — was never reached, and the
            # run exited 1 having written nothing. Reported as a failed
            # probe so the CALLER decides: the work-tree probe reads it as
            # "not a work tree" and consults the filesystem for `.git`,
            # which keeps the refusal for a damaged checkout intact.
            return subprocess.CompletedProcess(
                args=list(args), returncode=127, stdout="", stderr="git: not found"
            )

    def select_by_day(self) -> None:
        """Keep only the fragments belonging to the day being assembled.

        A fragment belongs to the day its PR merged, in UTC. Local time
        is a trap: at +05:30 every merge after 18:30 UTC reads as
        tomorrow, which misfiled fragments twice before this existed.
        """
        if self.allow_mixed:
            return

        probe = self.git("rev-parse", "--is-inside-work-tree")
        if probe.returncode != 0:
            # A .git that exists but cannot be read is damage, not "no
            # repository" — assembling anyway would date every fragment
            # to nothing and then delete it.
            d, damaged = self.dir, False
            while True:
                g = os.path.join(d, ".git")
                if os.path.exists(g) or os.path.islink(g):
                    damaged = True
                    break
                if d == "/":
                    break
                d = os.path.dirname(d)
            if damaged:
                # Still a refusal — a repository we cannot read cannot
                # date anything — but say WHICH of the two it is, or an
                # operator whose only problem is a missing package goes
                # looking for a corrupt checkout.
                if probe.returncode == 127:
                    err("Error: this is a git checkout, but no git executable was found.")
                    err("Fragment dates come from git, so assembling would consume every")
                    err("pending fragment under a date nothing verified. Install git, or")
                    err("pass --allow-mixed-dates to assemble without dating.")
                else:
                    err("Error: a .git entry exists but git cannot read this work tree.")
                    err("Fragment dates are unavailable, and assembling would consume every")
                    err("pending fragment under a date nothing verified. Repair the checkout,")
                    err("or pass --allow-mixed-dates to assemble without dating.")
                raise SystemExit(1)
            if probe.returncode == 127:
                err("note: no git executable — cannot date fragments, assembling all pending.")
            else:
                err("note: not a git work tree — cannot date fragments, assembling all pending.")
            return

        # Only the RECORD TERMINATOR comes off, not arbitrary whitespace
        # (Codex #1898 r2). A checkout whose final path component legally
        # ends in a space had that space stripped, so every later
        # `os.path.relpath` and `git -C` addressed a directory that does
        # not exist and the run refused every tracked fragment with a
        # misleading unreadable-HEAD error.
        top = self.git("rev-parse", "--show-toplevel")
        if top.returncode != 0:
            # CHECKED, like every neighbouring probe (Codex #1898 r3).
            # Ignoring it left `root` as the empty string, so every
            # `relpath`/`ls-tree` lookup addressed nowhere and reported
            # each TRACKED fragment as untracked — which means "written
            # today", so the whole backlog was assembled under whatever
            # date was asked for and then deleted. Codex reproduced a
            # tracked fragment consumed into ReleaseNotes-1999-01-01.md.
            err("Error: could not determine the repository root")
            err(f"(git rev-parse --show-toplevel exited {top.returncode}).")
            err("")
            err("Without it a tracked fragment cannot be distinguished from one")
            err("written today, so every pending fragment would be filed under the")
            err("requested date and then removed. Refusing instead.")
            err("")
            err("Repair the checkout, or pass --allow-mixed-dates to assemble without")
            err("dating.")
            raise SystemExit(1)
        root = git_path(top.stdout)

        shallow_boundary: set[str] = set()
        r = self.git("rev-parse", "--is-shallow-repository")
        if r.returncode != 0:
            err("Error: could not determine whether this repository is shallow")
            err(f"(git rev-parse --is-shallow-repository exited {r.returncode}).")
            err("")
            err("A shallow checkout dates a truncated fragment to the boundary commit")
            err("rather than to itself, so without this answer a fragment could be")
            err("filed under a fabricated date and then deleted. Refusing instead.")
            raise SystemExit(1)
        if r.stdout.strip() == "true":
            cdir = git_path(self.git("rev-parse", "--git-common-dir").stdout)
            common = os.path.realpath(os.path.join(self.dir, cdir)) if cdir else ""
            shallow_file = os.path.join(common, "shallow") if common else ""
            if not shallow_file or not os.access(shallow_file, os.R_OK):
                err("Error: the repository is shallow, but its boundary list could not be")
                err("read, so there is no way to tell a fragment's real date from the")
                err("boundary's. Refusing rather than dating on an unchecked history.")
                err("")
                err("Run 'git fetch --unshallow' (or clone at full depth) and retry, or")
                err("pass --allow-mixed-dates to assemble without dating.")
                raise SystemExit(1)
            with open(shallow_file, encoding="utf-8", errors="replace") as fh:
                shallow_boundary = {ln.strip() for ln in fh if ln.strip()}

        st = self.git("status", "--porcelain=v1", "-z", "-M", "--", self.unrel)
        if st.returncode != 0:
            err("")
            err("Error: could not read the git index, so a staged rename cannot be")
            err("distinguished from a newly written fragment. Assembling now could")
            err("file a renamed fragment under the wrong day and then delete it.")
            err("")
            err("Repair the checkout, or pass --allow-mixed-dates to assemble without")
            err("dating.")
            raise SystemExit(1)

        renamed_from: dict[str, str] = {}
        staged_adds: list[str] = []
        staged_dels: list[str] = []
        fields = st.stdout.split("\0")
        i = 0
        while i < len(fields):
            entry = fields[i]
            i += 1
            if not entry:
                continue
            xy, newpath = entry[:2], entry[3:]
            if "R" in xy:
                if i < len(fields):
                    renamed_from[os.path.join(root, newpath)] = os.path.join(
                        root, fields[i]
                    )
                    i += 1
            elif xy[0] == "A":
                staged_adds.append(os.path.basename(newpath))
            elif xy[0] == "D":
                staged_dels.append(os.path.basename(newpath))

        if staged_adds and staged_dels:
            out_line("note: the index holds both a staged new fragment and a staged deletion:")
            out_line(f"        added:   {' '.join(staged_adds)}")
            out_line(f"        deleted: {' '.join(staged_dels)}")
            out_line("      If that was one fragment renamed and rewritten, git could not pair")
            out_line("      the two (rename detection is by similarity), so the new name will be")
            out_line("      dated to THIS run rather than to when it was written. Commit the")
            out_line("      rename first if that matters.")
            out_line("")

        selected: list[str] = []
        held: list[str] = []
        for f in self.frags:
            name = os.path.basename(f)
            probe_path = ""
            if f in renamed_from:
                probe_path = renamed_from[f]
            else:
                rel = os.path.relpath(f, root)
                ls = self.git("ls-tree", "--name-only", "HEAD", "--", rel, cwd=root)
                if ls.returncode != 0:
                    err("")
                    err(f"Error: cannot read HEAD to check {name} (git exited {ls.returncode}).")
                    err("Whether this fragment is already committed is unknown, so dating")
                    err("it would be a guess. Repair the checkout, or pass")
                    err("--allow-mixed-dates to assemble without dating.")
                    raise SystemExit(1)
                if ls.stdout.strip():
                    probe_path = f

            added = added_sha = ""
            if probe_path:
                log = subprocess.run(
                    ["git", "-C", self.dir, "log", "--no-show-signature", "--follow",
                     "--diff-filter=A", "--format=%H %cd",
                     "--date=format-local:%Y-%m-%d", "-1", "--", probe_path],
                    capture_output=True, text=True, env=dict(os.environ, TZ="UTC"),
                )
                if log.returncode != 0:
                    err("")
                    err(f"Error: cannot read git history for {name} (git exited {log.returncode}).")
                    err("Fragment dates are unavailable, and assembling would consume the")
                    err("fragment under a date nothing verified. Repair the repository, or")
                    err("pass --allow-mixed-dates to assemble without dating.")
                    raise SystemExit(1)
                raw = log.stdout.strip()
                if raw and " " in raw:
                    added_sha, added = raw.split(" ", 1)

            if added_sha and added_sha in shallow_boundary:
                err("")
                err(f"Error: {name} dates to the shallow boundary, not to its own")
                err("add-commit — the history that would answer was truncated away, and")
                err(f"{added} is the boundary's date rather than this fragment's.")
                err("")
                err("Run 'git fetch --unshallow' (or clone at full depth) and retry, or")
                err("pass --allow-mixed-dates to assemble without dating.")
                raise SystemExit(1)

            if not added or added == self.date:
                selected.append(f)
            else:
                held.append(f"{name}  ({added} UTC)")
                self.held_paths.append(f)

        if held:
            out_line(f"Holding back {len(held)} fragment(s) that belong to another UTC day:")
            for h in held:
                out_line(f"  {h}")
            out_line("Run this script again with each of those dates to assemble them.")
            out_line("")
        if not selected:
            err(f"Error: no pending fragment belongs to {self.date} — nothing to assemble.")
            err("Re-run with one of the dates listed above.")
            raise SystemExit(1)
        self.frags = selected

    # ── working copies ───────────────────────────────────────────────────

    def snapshot(self) -> None:
        """Copy each fragment once; read only the copy afterwards."""
        self.snap = tempfile.mkdtemp(prefix=f".assemble-snap-{self.date}.", dir=self.dir)
        for n, f in enumerate(self.frags, start=1):
            name = os.path.basename(f)
            self.frag_name[f] = name

            if os.path.islink(f) or not os.path.isfile(f):
                err(f"Error: {name} is not a regular file.")
                err("")
                err("Refusing to assemble: setting a fragment aside moves it into a")
                err("subdirectory, which changes what a relative link points at — and")
                err("that failure would happen after the dated file was written.")
                err("Replace it with the file itself.")
                raise SystemExit(1)

            dest = os.path.join(self.snap, str(n))
            test_hook("snapshot", fragment=f, out=self.out)
            before = checked(f"reading {name}", frag_hash, f)
            checked(f"taking a working copy of {name}", shutil.copyfile, f, dest)
            after = checked(f"re-reading {name}", frag_hash, f)
            copied = checked(f"checking the working copy of {name}", frag_hash, dest)
            if before != after or copied != before:
                err(f"Error: {name} changed while it was being read.")
                err("")
                err("Refusing to assemble: the copy taken may hold part of one version")
                err("and part of another — text that never existed as a fragment — and")
                err("everything downstream would treat it as authoritative.")
                err("")
                err("Nothing has been consumed. Re-run once whatever is writing it has")
                err("finished.")
                raise SystemExit(1)
            self.frag_snap[f] = dest
            self.frag_hash[f] = copied

            if "-->" in name or "<!--" in name or "--!>" in name:
                err(f"Error: {name} contains an HTML comment delimiter.")
                err("Refusing to assemble: the provenance marker is an HTML comment,")
                err("so such a name would end it early and print the rest of the")
                err("marker as visible text in the published notes.")
                err("Rename the fragment.")
                raise SystemExit(1)

            checked(
                f"checking {name} for embedded marker records",
                self.check_fragment_markers, dest, name,
            )

    def check_fragment_markers(self, snap: str, name: str) -> None:
        """A fragment must not supply a marker record of its own."""
        with open(snap, "rb") as fh:
            data = fh.read()
        prefix = os.fsencode(MARKER_PREFIX)
        for raw in LINE_END_RE.split(data):
            if not raw.startswith(prefix):
                continue
            if b"\0" in raw:
                err(f"Error: {name} has a marker-shaped line containing a null")
                err("byte.")
                err("")
                err("Refusing to assemble: it would be written into the dated file, and")
                err("every later run would then refuse to read that file — leaving")
                err("assembly stuck on something this script had produced itself.")
                raise SystemExit(1)
            text = os.fsdecode(raw)
            if MARKER_RE.match(text):
                err(f"Error: {name} contains a line that is itself an assembly")
                err("marker:")
                err("")
                err(f"  {text}")
                err("")
                err("Refusing to assemble: those records are what a later run trusts to")
                err("decide a fragment is already folded in, so one supplied by a")
                err("fragment could make a DIFFERENT fragment be deleted unread.")
                err("Indent it or quote it in a blockquote if you are documenting the")
                err("format.")
                raise SystemExit(1)

    # ── the recovery index ───────────────────────────────────────────────

    def rewrite_links(self, data: bytes) -> bytes:
        """Two narrow substitutions, applied when a fragment is folded in.

        Written from the fragment's own location, `](../../X)` and
        `](./X)` stop resolving once the text lives one directory up.
        Nothing else is touched — a single-level `](../X)` is already
        correct after assembly, and a bare `](X)` addresses this
        directory, which is also already correct.
        """
        return data.replace(b"](../../", b"](../").replace(b"](./", b"](../")

    def scan_markers(self) -> tuple[dict, dict]:
        """Read EVERY dated file, not just the one being written.

        Which fragments count as already folded in is decided from all
        of them, so a marker appearing in another day's file — or a new
        dated file appearing at all — means those decisions were made on
        stale information.
        """
        marker_seen: dict[tuple[str, str, str], bool] = {}
        marker_where: dict[str, list[str]] = {}

        dated_files = sorted(
            os.path.join(self.dir, n)
            for n in os.listdir(self.dir)
            if n.startswith("ReleaseNotes-") and n.endswith(".md")
        )
        for n, dated in enumerate(dated_files, start=1):
            if not os.path.isfile(dated) or os.path.islink(dated):
                err(f"Error: {dated} is not a regular file.")
                err("Refusing to scan it for assembly markers: the recovery index must")
                err("cover every dated file, and this one cannot be read as one.")
                raise SystemExit(1)

            base = os.path.basename(dated)
            copy = os.path.join(self.snap, f"dated.{n}")
            checked(f"taking a working copy of {base}", shutil.copyfile, dated, copy)
            try:
                ident = file_identity(copy)
            except OSError:
                err(f"Error: {os.path.basename(dated)} -- reading it failed.")
                err("Refusing to assemble: this run's decisions about what is already")
                err("filed come from these files, so it has to be able to tell whether")
                err("one changed underneath it.")
                raise SystemExit(1)
            self.src_id[dated] = ident.split(" ")[0]
            if dated == self.out:
                self.out_copy = copy

            if checked(f"re-reading {base}", frag_hash, dated) != self.src_id[dated]:
                err(f"Error: {os.path.basename(dated)} changed while it was being read.")
                err("Refusing to assemble: the records this run would rely on may be")
                err("from a version that no longer exists.")
                raise SystemExit(1)

            data = checked(
                f"listing marker lines in {base}",
                lambda: open(copy, "rb").read(),
            )
            checked(f"scanning {base} for assembly markers", lambda: None)
            prefix = os.fsencode(MARKER_PREFIX)
            for raw in LINE_END_RE.split(data):
                if not raw.startswith(prefix):
                    continue
                if b"\0" in raw:
                    err(f"Error: {os.path.basename(dated)} holds a marker record containing a")
                    err("null byte.")
                    err("")
                    err("Refusing to assemble: this shell cannot carry that byte, so the")
                    err("record would be read as a DIFFERENT and apparently valid one, and")
                    err("a fragment deleted on the strength of it.")
                    err("")
                    err("Nothing has been consumed. Repair the file by hand.")
                    raise SystemExit(1)
                # SURROGATEESCAPE, not "replace" (Codex #1898 r1).
                # `os.listdir` hands back an undecodable byte as a
                # surrogate; decoding the marker with replacement turns
                # it into U+FFFD, so the name read back could never
                # compare equal to the name on disk and the fragment
                # was folded in again on every run.
                m = MARKER_RE.match(os.fsdecode(raw))
                if not m:
                    continue
                name, digest = m.group(1), m.group(2)
                marker_seen[(digest, name, dated)] = True
                marker_where.setdefault(digest, []).append(
                    f"{name} in {os.path.basename(dated)}"
                )
        test_hook("scan", out=self.out)
        return marker_seen, marker_where

    # ── revalidation ─────────────────────────────────────────────────────

    def assert_output_unchanged(self, what: str) -> None:
        now = ""
        if os.path.islink(self.out):
            now = "__symlink__"
        elif os.path.exists(self.out) and not os.path.isfile(self.out):
            now = "__not-a-regular-file__"
        elif os.path.isfile(self.out):
            try:
                now = file_identity(self.out)
            except OSError:
                err(f"Error: {os.path.basename(self.out)} -- reading it failed.")
                self.refuse_reporting_consumed()
        if now == (self.out_id or ""):
            return

        err(f"Error: {os.path.basename(self.out)} changed while this run was working.")
        err("")
        if not self.out_id:
            err("It did not exist when this run started and does now, so something")
            err("else created it.")
        elif not now:
            err("It existed when this run started and does not now, so something")
            err("else removed it.")
        elif now in ("__symlink__", "__not-a-regular-file__"):
            err("It is no longer a regular file, so it changed shape rather than")
            err("content — and replacing it would not put the notes where they")
            err("belong.")
        elif now.split(" ")[0] != self.out_id.split(" ")[0]:
            err("Its contents differ from the copy this run is working from, so")
            err(f"{what} would discard whatever was written in between.")
        else:
            err(
                f"Its permissions or ownership changed "
                f"({self.out_id.split(' ', 1)[1]} -> {now.split(' ', 1)[1]})."
            )
            err("Replacing it now would put the older ones back, undoing that")
            err("silently — and possibly widening a file someone just restricted.")
        self.refuse_reporting_consumed()

    def assert_sources_unchanged(self, what: str) -> None:
        present = {
            os.path.join(self.dir, n)
            for n in os.listdir(self.dir)
            if n.startswith("ReleaseNotes-") and n.endswith(".md")
        }
        for p in sorted(present):
            if p not in self.src_id:
                err(f"Error: {os.path.basename(p)} appeared while this run was working.")
                err("")
                err("It was not there when the records were read, so this run cannot")
                err("know whether it already holds any of these sections.")
                self.refuse_reporting_consumed()
        if len(present) != len(self.src_id):
            err("Error: a dated file this run had read is gone.")
            self.refuse_reporting_consumed()

        self.assert_output_unchanged(what)

        for p, was in self.src_id.items():
            now = ""
            if os.path.isfile(p) and not os.path.islink(p):
                try:
                    now = file_identity(p).split(" ")[0]
                except OSError:
                    err(f"Error: {os.path.basename(p)} -- reading it failed.")
                    self.refuse_reporting_consumed()
            if now != was:
                err(f"Error: {os.path.basename(p)} changed while this run was working.")
                err("")
                err("This run's decisions about what is already filed were read from")
                err(f"it, so {what} could duplicate a section or delete one that is no")
                err("longer recorded anywhere.")
                self.refuse_reporting_consumed()

    # ── classification ───────────────────────────────────────────────────

    def classify(self, marker_seen: dict, marker_where: dict):
        """Split the pool into already-folded-in, ambiguous, and pending.

        A fragment counts as already folded in only when its marker is
        in THE FILE BEING ASSEMBLED under THE SAME NAME — the signature
        of an interrupted run, since resuming one means re-running for
        the same day. Any other match is ambiguous and stops the run.
        """
        already, pending, ambiguous = [], [], []
        for f in self.frags:
            h = checked(
                f"hashing {self.frag_name[f]}", lambda p=self.frag_snap[f]: frag_hash(p)
            )
            self.frag_hash[f] = h
            if (h, self.frag_name[f], self.out) in marker_seen:
                already.append(f)
            elif h in marker_where:
                ambiguous.append(f)
            else:
                pending.append(f)

        if ambiguous and not self.force:
            err("Error: these fragments have the same contents as something already")
            err("assembled, but not in the one place that would make them the same")
            err("occurrence — same name, in the file being assembled now. A different")
            err("name means a rename or a coincidentally identical note; a different")
            err("dated file means a reused note or a run resumed past UTC midnight.")
            err("Nothing here can tell which:")
            err("")
            for f in ambiguous:
                err(f"  {os.path.basename(f)}")
                err(f"      same bytes as: {'; '.join(marker_where[self.frag_hash[f]])}")
            err("")
            err("  - already folded in, under that other name or into that other")
            err("    dated file          -> delete the fragment(s) by hand")
            err("  - a new note that reads alike -> re-run with --force-append")
            raise SystemExit(1)

        if ambiguous:
            # In DISCOVERY order, not appended after the rest (Codex
            # #1898 r1). Concatenating the classifications emitted a
            # forced 0001-a after a new 0002-b, contradicting the
            # task-id ordering the pool is sorted by and the README
            # documents.
            forced = set(ambiguous)
            pending = [f for f in self.frags if f in forced or f in set(pending)]
        return already, pending

    def assert_section_present(self, f: str) -> None:
        """The marker must not authorise a deletion on its own (#1886).

        A marker attests to the SOURCE fragment. If someone edits the
        dated notes and removes the visible section while leaving the
        invisible comment, the marker still says "already folded in" and
        the only remaining copy of that text gets deleted with a "byte
        for byte" claim attached.

        Checked EXACTLY, not by heuristic. The transformation from
        fragment to assembled section is deterministic — the two link
        substitutions and nothing else — so the bytes that were appended
        can be reconstructed here and looked for. #1886 listed a second
        hash in the marker as the only sound fix and heading-matching as
        the cheap approximation; reconstruction is the sound one without
        the format change, because the assembler owns the transform.
        """
        # The EXACT bytes `build()` appended, marker line included
        # (Codex #1898 r1). Stripping the trailing newline made the
        # original body a PREFIX: a fragment ending `body\n` matched a
        # dated file whose section had been edited to `body extended\n`,
        # so the marker still authorised the deletion while the command
        # claimed the content was there byte for byte. A prefix is not
        # the thing; reconstruct what was written and look for that.
        with open(self.frag_snap[f], "rb") as fh:
            body = self.rewrite_links(fh.read())
        if not body.strip():
            return
        # Including the LEADING SEPARATOR `build()` writes before every
        # fragment (Codex #1898 r2). Starting the reconstruction at the
        # body left the same prefix hole the trailing newline had, only
        # at the other end: a fragment whose body is `body\n` matched a
        # dated file whose section had been edited to `extended body\n`,
        # so the marker still authorised the deletion while the run
        # claimed the section was present byte for byte.
        appended = b"\n" + body if body.endswith(b"\n") else b"\n" + body + b"\n"
        appended += os.fsencode(
            f"{MARKER_PREFIX}{self.frag_name[f]} "
            f"sha256={self.frag_hash[f]} -->\n"
        )
        with open(self.out_copy or self.out, "rb") as fh:
            haystack = fh.read()
        # Line endings normalised on BOTH sides before comparing. The
        # marker scanner already accepts a CRLF-terminated record
        # (`MARKER_RE` ends `\r?$`), so requiring the LF form here made a
        # CRLF dated file look as though its section were missing — and
        # this check refuses on that. Normalising keeps the exact-bytes
        # intent, which is about not matching a PREFIX, while tolerating
        # the same ending difference everything else does.
        if appended.replace(b"\r\n", b"\n") in haystack.replace(b"\r\n", b"\n"):
            return
        name = self.frag_name[f]
        err(f"Error: {os.path.basename(self.out)} carries the marker for {name},")
        err("but not the section it stands for.")
        err("")
        err("Refusing to assemble: that marker is the only reason this run would")
        err("delete the fragment without re-appending it, and the text it")
        err("vouches for is not in the file. Deleting it now would destroy the")
        err("last copy.")
        err("")
        err("Most likely the section was edited or removed from the dated file")
        err("while its marker was left in place. Either restore the section, or")
        err("delete the marker line so this fragment is folded in again.")
        self.refuse_reporting_consumed()

    def clear_already_assembled(self, already: list[str]) -> None:
        self.assert_sources_unchanged("removing the fragments already folded into it")
        for f in already:
            self.assert_section_present(f)

        out_line(
            f"Already assembled into {os.path.basename(self.out)} — removing "
            "without re-appending:"
        )
        for f in already:
            out_line(f"  {os.path.basename(f)} -> already in {os.path.basename(self.out)}")
        out_line("  (an earlier run was interrupted after writing the file but before")
        out_line("   clearing these; their content is already in place, byte for byte)")
        out_line("")

        changed: list[str] = []
        for f in already:
            self.assert_sources_unchanged(f"removing {self.frag_name[f]}")
            qname = self.frag_name[f]
            q = os.path.join(self.qdir, qname)
            if os.path.exists(q) or os.path.islink(q):
                err(f"Error: a set-aside file already exists at {qname}.")
                err("Nothing further will be consumed; move it aside and re-run.")
                self.refuse_reporting_consumed()
            try:
                os.rename(f, q)
            except OSError:
                err(f"Error: could not set aside {self.frag_name[f]}.")
                err("Nothing further will be consumed.")
                self.refuse_reporting_consumed()
            self.quarantined.append(f"{self.frag_name[f]} -> .assembled/{qname}")
            test_hook("recover-moved", out=self.out, fragment=f, quarantine=q)

            try:
                now = frag_hash(q)
            except OSError:
                changed.append(f"{self.frag_name[f]} -> .assembled/{qname}")
                continue
            if now != self.frag_hash[f]:
                changed.append(f"{self.frag_name[f]} -> .assembled/{qname}")
                continue

            self.assert_sources_unchanged(f"removing {self.frag_name[f]}")
            # The quarantine is re-read LAST, so the check nearest the
            # delete is about the thing being deleted: a writer holding
            # the old inode open can still append during the hashes above.
            try:
                if frag_hash(q) != self.frag_hash[f]:
                    changed.append(f"{self.frag_name[f]} -> .assembled/{qname}")
                    continue
            except OSError:
                changed.append(f"{self.frag_name[f]} -> .assembled/{qname}")
                continue

            try:
                os.remove(q)
            except OSError:
                err(f"Error: could not remove {self.frag_name[f]} from the quarantine.")
                self.refuse_reporting_consumed()
            self.consumed.append(self.frag_name[f])
            self.quarantined.pop()

        if changed:
            out_line("")
            err("Kept (changed since this run read them, or unreadable now):")
            for c in changed:
                err(f"  {c}")
            err(f"The version already in {os.path.basename(self.out)} is the older one, so these")
            err("are left for you to compare rather than deleted.")
            out_line("")

    def nothing_pending(self) -> None:
        still = []
        for name in sorted(os.listdir(self.unrel)):
            if not name.endswith(".md") or name in SKIP_NAMES:
                continue
            p = os.path.join(self.unrel, name)
            if p in self.held_paths:
                continue
            still.append(name)
        if still:
            out_line(f"Nothing further to assemble for {self.date} from what this run read.")
            out_line("")
            out_line("These appeared while it was working, and are still pending:")
            for s in still:
                out_line(f"  {s}")
            out_line("Re-run to fold them in.")
            raise SystemExit(0)
        out_line(f"Nothing left to assemble for {self.date}.")
        raise SystemExit(0)

    # ── fragment heading conformance (#2288) ─────────────────────────────

    def check_heading_conformance(self) -> None:
        """Refuse a fragment whose OPENING LINE does not match the template.

        Not "its first heading": the line examined is the fragment's first
        line of content, and a `#` heading further down the file is never
        looked at. That narrowing is what `first_heading` exists to state
        (#2290 r21). Since #2295 the consequence has changed — a fragment
        that opens with prose is REFUSED for opening with prose, rather than
        published on the strength of a heading this check never read.

        THE SHAPE OF THE RULE IS AN ALLOW-LIST, and that is the whole design
        (#2295). Anything that is not recognised as an ATX heading on that
        line is refused. The check therefore does not enumerate bad shapes —
        it names one good one — so a shape nobody has anticipated is closed
        in advance instead of being discovered in a published note. Eleven
        shapes were SHOWN to take the allowance this replaced — each by a
        test or a review reproduction, none of them ever written by an
        author (#2301 r2). What was published, and what motivates the check,
        is the separate matter of headings no check ever looked at.

        The eleven were an indented marker, a tab delimiter, a setext
        underline, a YAML fence, a list above a thematic break, four
        byte-order marks, a CR-only line ending and a heading inside a
        blockquote. Recognising one more per round only moved the boundary:
        the set of things that are not an ATX heading is unbounded, so a rule
        that must enumerate them can always be surprised, and a surprise cost
        a release note and a source file. Refusing inverts the failure
        direction — an unanticipated shape costs its author one message — and
        it cost nothing measurable: all 759 fragments committed before #2295
        open with an ATX heading, so the allowance only ever served test
        fixtures.

        THERE IS NO BYTE-ORDER-MARK CLAUSE, and removing one was the fix
        (#2290 r21). A BOM refusal was added in r11, recognised only UTF-8
        (r15), and twice produced a reproduced data-loss path (r20, r21):
        telling an author to re-save the file is the edit that stopped the
        markerless duplicate guard recognising the copy already published.
        None of those 759 begins with a BOM. A BOM-bearing fragment is
        refused by the allow-list instead, and that message names the LINE, so
        it never PRESCRIBES a re-save — a claim about the message, not the
        operator (#2311 r3): for a UTF-16 opener, re-saving as UTF-8 is the
        obvious response anyway. What survives that remediation is the
        duplicate guard's readability refusal, which reads only the published
        side (#2315).

        `_TEMPLATE.md` opens `## Thread — <short title> (PR #<n>)`. Two
        things about that line are load-bearing the moment the fragment is
        folded, and nothing downstream looks at either — assembly is the last
        step that reads the heading at all:

          - THE LEVEL. A fragment opening at `#` lands in the dated file as a
            second document title rather than nesting under the release
            title, so outlines, generated tables of contents and
            screen-reader heading navigation all read it as a peer document.
          - THE PR REFERENCE. The template ships the placeholder literally,
            and a fragment that keeps it publishes a section nothing can
            trace back to the change it documents.

        ONLY LEVEL 1 IS REFUSED — not "any level but 2" (#2290 r6, measured).
        An earlier revision required exactly level 2, which reads as the
        obvious rule and is wrong against practice: of the 758 distinct
        fragments ever committed, 605 open at `##`, 81 at `#` and **72 at
        `###`**, one of the last in a pull request open at the time this was
        written and owned by other work. Refusing a fifth of every fragment
        ever written, some of it already in flight elsewhere, is how a check
        gets disabled.

        A LEVEL-3 OPENER IS WARNED, NOT IGNORED, and it is not merely untidy
        — an earlier revision of this docstring said it "nests under nothing",
        which is false (#2290 r10). In the assembled file it becomes a CHILD
        of the nearest preceding `##`, which belongs to the fragment folded
        before it, so outlines and screen-reader navigation attribute the
        change to a different change. Two fragments in
        `ReleaseNotes-2026-08-25.md` sit under `## What it does not change` for
        exactly this reason, each presented as something an unrelated change
        does NOT do.

        So the three outcomes are distinct on purpose: level 1 is REFUSED
        (a second document title, unrecoverable once folded), level 3+ is
        WARNED (recoverable by the author, at a moment they can still act),
        and level 2 passes silently.

        Both reached a publishable file in #2286 — two fragments at `#`, one
        still carrying the placeholder — and nothing between authoring and
        publication had ever looked at the line. This is the one place every
        fragment passes through.

        WHAT IT DOES NOT CHECK, deliberately.

        The `Thread —` prefix and the wording after it. Neither has produced a
        defect, and a check on prose would fail correct fragments for style.

        THE PRESENCE of a PR reference. A heading carrying none is refused by
        nothing here; only a reference that is present and not a number is.

        This was reconsidered in r6 and r7 and MEASURED rather than argued,
        because the first version of this paragraph defended it by the cost of
        conforming the test fixtures — which is not a reason to weaken a
        production rule, and a review round said so. The corpus is the reason.

        MEASURED OVER THE FRAGMENTS COMMITTED BEFORE THIS CHANGE, which is a
        real cutoff and not a rounding: the change adds a fragment of its own,
        so it would otherwise be counting itself and the totals below would be
        wrong the moment they were written (#2290 r12). Quoting 759 instead
        would be wrong again as soon as the next fragment lands, so the table
        states a baseline rather than chasing a live number. The conclusions
        are about proportions across hundreds of fragments and no single
        addition moves them.

            distinct fragments with an ATX opening heading     758
              carrying NO `PR #` token at all                  457   (60%)
              carrying a non-numeric token                     235
              carrying only numbers                             66   ( 9%)

            published level-2 section headings                1084
              carrying NO `PR #` token at all                  758   (69%)
              carrying an UNSUBSTITUTED placeholder            179  (1 in 6)

        That last row is the defect itself, already published: 179 sections
        in the dated notes that nothing can trace back to the change they
        describe. It is the motivation for the rule, not an argument about
        its scope. The contributor README states the rule and points here for
        the reasoning and the counts; none of these figures is copied there.

        Read those two rows carefully, because conflating them is easy and a
        review round caught this paragraph doing it. Requiring a reference to
        be PRESENT stops the 457 — six fragments in ten — *in addition to* the
        235 already refused for carrying a placeholder. Nine in ten is the
        combined figure for requiring a NUMERIC reference; six in ten is what
        requiring presence adds.

        The two policies do not have the same cost on the published side
        either, and an earlier revision said "either way … two thirds", which
        flattened them. Against the 1084 published section headings:
        requiring PRESENCE contradicts the 758 that carry no token — about
        seven in ten. Requiring a NUMERIC reference contradicts those plus
        the 179 carrying a placeholder — nearer nine in ten. The stricter
        policy is the more expensive one on both corpora, and saying "either
        way" understated it. The template
        ships `(PR #<n>)`, but the template's convention is not the corpus's
        practice, and a rule that refuses the overwhelming majority of real
        input is the rule that gets deleted — the same mistake this check made
        with `level != 2`, caught the same way.

        So what is refused is exactly the failure the template PRODUCES:
        shipping the placeholder and leaving it unsubstituted. Deleting the
        reference instead of replacing it does defeat the check; there is no
        signal that distinguishes that from the 457 fragments that legitimately
        carry none, and inventing one would refuse them too.

        THE PR-REFERENCE TOKEN MUST BE ALL DIGITS, and nothing subtler — this
        is where the rule stops being refined (#2290 r17). EVERY `PR #` token
        on the line is tested, not just the first, since a `search` would
        accept `(PR #123, PR #TBD)` on its numeric prefix (#2290 r6).

        Five consecutive rounds found an edge in subtler rules, each fix
        opening the next: capture to `)` missed `:`; allowing punctuation
        missed an em dash; testing the first byte accepted `1TBD`; a
        non-alphanumeric boundary accepted `123_TBD`. Every disputed shape was
        hypothetical — across 2,076 published headings, no token begins with
        a digit without being all digits — so the rule was being tuned against
        invented input. It takes the STRICT side because the two directions
        are not symmetric: refusing an ornamented reference costs one message
        to an author who can add a space, while accepting a non-number
        publishes a section nothing can trace and deletes the source. The
        message says "not a plain number" rather than "placeholder", because
        `PR #123:` is not one and telling its author to replace a placeholder
        sends them looking for something that is not there (#2290 r14).

        RUNS BEFORE `clear_already_assembled`, which DELETES fragments. An
        earlier revision ran after it and claimed in this docstring to run
        "before anything is appended or cleared" — a run refused here would
        have left recovered fragments already consumed, and the comment said
        otherwise (#2290 r1).

        SCOPED TO `self.frags`, which is the PENDING set. A fragment in
        `already` has its text in the dated file: its heading was published
        by some earlier run, so refusing it would block the clearing of
        finished work over a decision that can no longer be acted on.

        Reads the SNAPSHOT, like every other content check here, because the
        original may be being edited while this runs.
        """
        bad: list[str] = []
        deep: list[str] = []
        for f in self.frags:
            name = self.frag_name[f]
            body = checked(
                f"reading {name}",
                lambda p=self.frag_snap[f]: open(p, "rb").read(),
            )
            # The first line of content, found with the same line and blank
            # definitions `first_heading` uses (#2295, #2301 r1), so the `---`
            # clause and the message below describe the line actually judged.
            # There is no BOM clause here — see the docstring.
            _first_content = next(
                (ln for ln in LINE_END_RE.split(body) if not BLANK_RE.match(ln)),
                None,
            )
            # `rstrip` of spaces and tabs ONLY (#2290 r14). `---   ` and
            # `---\t` are valid YAML delimiters, and an exact comparison let
            # either through the refusal and on to the no-heading allowance.
            # Leading whitespace is deliberately NOT stripped: an indented
            # `---` is a thematic break rather than a fence, which is the r5
            # finding, and `.strip()` here would re-make that mistake.
            #
            # A DIAGNOSIS, NOT A GATE: `---` is not an ATX heading, so the
            # allow-list below would refuse it anyway. This clause only names
            # the cause — front matter becomes a thematic break once folded.
            if _first_content is not None and _first_content.rstrip(b" \t") == b"---":
                bad.append(
                    f"{name}: opens with `---`, which is front matter in its own "
                    f"file and a thematic break once folded  ->  open with the "
                    f"## heading itself"
                )
                continue
            found = first_heading(body)
            if found is None:
                # The allow-list refusal (#2295): anything that is not an ATX
                # heading. Why the rule names one good shape instead of listing
                # bad ones is the docstring's ALLOW-LIST paragraph.
                shown_open = (
                    quoted(_first_content)
                    if _first_content is not None
                    else "(the file has no content)"
                )
                bad.append(
                    f"{name}: its opening line is not a `#` heading  ->  open "
                    f"with the heading itself, as "
                    f"`## Thread — <title> (PR #<n>)`  ->  {shown_open}"
                )
                continue
            level, first = found
            shown = quoted(first)
            if level == 1:
                # Level, not `#`-count: a setext heading carries no `#` at
                # all, and "opens at #, not ##" describing `Title` over
                # `=====` is a message that sends the reader looking for a
                # character that is not there (#2290 r3). Setext is no longer
                # recognised at all (r6), but "level" remains the honest word
                # for what was measured.
                #
                # Level 3 and deeper are ALLOWED — see the docstring. They are
                # untidy, not a second document title.
                bad.append(
                    f"{name}: opens at level 1, a second document title  ->  {shown}"
                )
                continue
            if level >= 3:
                # Warned, not refused — see the docstring. NO `continue`: a
                # warning must not exempt the fragment from the PR-reference
                # check below, or `### Title (PR #TBD)` would publish its
                # placeholder because the heading was merely deep.
                deep.append(f"{name}: opens at level {level}  ->  {shown}")
            # Every `PR #` token on the line must be all digits; why nothing
            # subtler is the docstring's PR-REFERENCE paragraph.
            bads = [t for t in PR_REF_RE.findall(first) if not t.isdigit()]
            if bads:
                # "Not a plain number", not "placeholder" — see the docstring.
                shown_tok = capped(
                    ", ".join(t.decode("utf-8", errors="replace") for t in bads)
                )
                bad.append(
                    f"{name}: `PR #{shown_tok}` is not a plain number  ->  "
                    f"write the number alone, as `(PR #2290)`  ->  {shown}"
                )
        if not bad:
            if deep:
                err("Warning: these fragment headings open below level 2:")
                err("")
                for line in deep:
                    err(f"  {line}")
                err("")
                err("A ## heading becomes a section of the release. A deeper one becomes")
                err("a SUBSECTION of whatever shallower heading precedes it in the")
                err("finished file, and something always does — the dated file opens")
                err("with its own `# Release Notes` title. WHICH heading that is")
                err("depends on the fold order and on the levels of every fragment")
                err("ahead of yours: another change's ## section, another fragment's")
                err("own ### subheading, or — if nothing else is shallower — the")
                err("release title itself, which leaves your heading skipping a level.")
                err("")
                err("Two published sections were absorbed under another change, and")
                err("one hangs off the title.")
                err("")
                err("WHICH of those you get is not stated here, on purpose. It depends")
                err("on the fold order and on the levels of every fragment ahead of")
                err("yours, this check runs before the file is built, and working it out")
                err("a second time here is how two answers to one question drift apart.")
                err("Open at ## and none of it applies.")
                err("")
                err("Assembly continues — this is a warning, not a refusal.")
                err("")
            return

        err("Error: these fragment headings do not match the template:")
        err("")
        for line in bad:
            err(f"  {line}")
        err("")
        err("  docs/ReleaseNotes/unreleased/_TEMPLATE.md opens:")
        err("    ## Thread — <short title> (PR #<n>)")
        err("")
        err("The LEVEL matters because a fragment opening at # lands in the dated")
        err("file as a second document title instead of nesting under the release")
        err("title. Only level 1 is refused; ### and deeper are untidy, not that.")
        err("The PR NUMBER matters because a section that keeps the placeholder")
        err("cannot be traced to the change it documents. Both of these reached a")
        err("publishable file before this check existed (#2286), and assembly is")
        err("the last step that looks at the heading.")
        err("")
        err("Fix the heading(s) and run again.")
        self.refuse_reporting_consumed()

    # ── markerless duplicate-heading guard ───────────────────────────────

    def check_markerless_duplicates(self) -> None:
        """A HEURISTIC over LEGACY files, and it is scoped as one (#2299).

        The sound mechanism for "was this fragment already folded in?" is the
        assembly marker: `build()` writes one per fragment carrying its
        sha256, so a file written WHOLLY in the marker era answers the
        question about itself and nothing has to be guessed. This exists only
        because 61 of the 84 dated files predate markers, so for those the
        file cannot.

        MARKER COVERAGE IS ASKED PER FRAGMENT, BY NAME (#2312). A heading
        match is only a note when this file records a marker for the SAME
        fragment name; any other match is refused, whatever other markers
        the file carries. A same-name marker whose hash differs from the
        pending text is AMBIGUOUS, and is not claimed to be anything more
        (#2328 r2): it is either the documented edit made after an
        interrupted run, or a new fragment reusing an old file name. Both
        are noted and appended rather than refused because neither loses
        text: the result is two sections, the recorded and the pending. This
        path makes NO claim that the two differ once published — two
        versions differing only in link spellings `rewrite_links` normalises
        publish identical bytes (#2328 r5) — and an earlier revision's claim
        that the hash mismatch ruled that out was withdrawn rather than
        defended with a further check. The note tells the operator to look
        for a superseded copy, which is the right action under either
        reading, and it is keyed on the marker rather than on the heading
        scan, since an edit may retitle the fragment (#2328 r3).

        This used to be a whole-file `any()`: one marker anywhere downgraded
        every refusal to a note. That was sound for a file written wholly in
        the marker era and unsound for a MIXED one — a legacy file that has
        since taken one marked fragment, which is what every one of the 61
        becomes on its next assembly. Its older sections are still
        markerless, a pending fragment matching one of them is exactly the
        interrupted-run case, and the single newer marker suppressed the
        refusal that would catch it: a second copy appended, the source
        consumed. Asking by name needs no map of where each marker's
        coverage begins and ends, which the file does not record.

        The cost is a refusal where a DIFFERENT fragment's title recurs in
        the file. Measured across all 86 dated files, every repeated heading
        line is a subsection (`### Verification`, `## Operator deploy notes`),
        never two fragments' titles; `--force-append` is the override when it
        happens.

        WHAT IT CANNOT DO, stated rather than implied. It does not survive an
        edit TO THE MATCHED HEADING — which is narrower than "an edit". The
        scan compares the fragment's first ATX heading line, byte for byte,
        against the published file's lines, so rewording a published
        section's BODY changes nothing it looks at and the refusal still
        stands. Retitle that section, or reformat the heading line itself,
        and the pending fragment stops matching: a rerun appends a second
        copy and consumes the source — the one outcome here that loses work
        rather than refusing. That is #2298, and it is not a defect in this
        implementation: no comparison of two texts can distinguish "not yet
        published" from "published, then retitled". Only a marker can, by
        recording what was published. The residual is intrinsic, and it
        shrinks as files gain markers.

        ITS ENCODING LIMIT IS CLOSED BY REFUSING, NOT BY DECODING (#2315).
        `HEADING_RE` is a byte pattern, and a legacy interrupted run appended
        fragment bytes verbatim, so a fragment saved in UTF-16 sits in the
        dated file in UTF-16 and no byte comparison can see it. One run was
        always safe — conformance refuses the unreadable pending copy (#2295).
        Two were not: the author re-saves the pending copy as UTF-8, the
        published copy keeps its encoding, this guard matched nothing, and the
        second run appended a duplicate and consumed the source. An earlier
        revision of this docstring stopped at one run and said the limit "no
        longer loses work" (#2311 r2). It was wrong, and so was the finding it
        leaned on, that an encoding-agnostic arm "changed the message, never
        the outcome" — both were tested across one run only.

        The fix does not decode. Doing so means deciding which regions of one
        file are in which encoding, which is inference with no ground truth,
        and a legacy single-byte `é` reaches the same loss too — by a less
        likely route, since its first rerun is refused as a duplicate with
        instructions that do not suggest re-saving. Instead
        `unreadable_at` asks whether the PUBLISHED file is text a byte
        comparison can speak for, and a markerless file that is not is
        refused before any fragment is examined. That is the same question
        this guard already refuses on — "is this fragment already in it?" —
        answered honestly as "cannot tell". It survives the author's re-save
        because it reads only the published side, which the re-save does not
        touch; all 86 dated files pass it, so it refuses nothing real today.
        Marker lines are blanked before it looks (`without_markers`): a
        marker is this script's own record and carries a fragment's file name
        as the filesystem gave it, so a non-UTF-8 name there must not make
        the file read as unreadable (#2328 r1).

        WHAT CONFORMANCE DOES CARRY is the single-run half, and it rests on
        conformance EXISTING rather than on where it sits. `run()` calls this
        first and conformance immediately after, but neither writes: both only
        refuse, and nothing is appended until `build()`, which is after both.
        So a fragment this misses is refused before any append wherever
        conformance runs. RELAXING conformance to admit an opener it cannot
        parse would lose that half too. The two-run half is carried by
        `unreadable_at`, above, and not by conformance at all.

        The order is nonetheless load-bearing, for a different reason and one
        recorded at the call site (#2290 r16): it decides which question the
        operator is asked FIRST, and asking the heading question first sends
        them to a remediation — retitling `# Title` to `## Title` — that
        destroys the very evidence this guard compares. So do not read the
        sequence as this paragraph's invariant, and do not reorder on the
        strength of this paragraph either.

        IT COMPARES THE PUBLISHED FORM, AND THAT IS NOW STRUCTURAL RATHER
        THAN REMEMBERED (#2311 r4). `build()` appends `rewrite_links(raw)`,
        so the fragment is converted to that form here before any comparison
        is made. An earlier revision instead carried the constraint as a note
        to whoever writes #2315's whole-text arm, and exempted the
        heading-anchored comparison shipped alongside it — "unaffected, since
        neither substring can occur in an ATX marker".

        THAT EXEMPTION WAS FALSE, and the way it was reached is the part
        worth keeping. The sentence is true where `first_heading` makes it:
        there the question is whether a line IS a heading, `HEADING_RE` reads
        only the marker, and no `](./` can occur inside `#{1,6}` plus a
        space. It was then reused for a different question — whether two
        heading LINES compare equal — which reads the whole line, everything
        after the marker included. `## [Title](./x)` is a heading by that
        first test and is published as `## [Title](../x)`, so the guard
        matched nothing, appended a second copy and consumed the source.
        Reproduced before the fix and refused after.

        So the correction is not "narrow the claim" but "stop needing it".
        Nothing here now reasons about which substrings can appear where;
        both sides are put in the same form and compared. The general shape
        — a premise carried from the question it was established for to a
        neighbouring one it does not answer — is what produced three of
        #2311's four rounds, and the defence against it is to make the two
        sides identical by construction rather than to argue that a
        difference cannot arise.

        IT FINDS THE FRAGMENT'S FIRST HEADING WHEREVER IT IS — its own scan,
        not `first_heading` (#2290 r12). The two ask different questions.
        Conformance judges the line a fragment OPENS with; this asks whether
        the fragment's text already sits in a markerless dated file, and a
        legacy interrupted run wrote the whole body. Using the opening-only
        parser returned None for a fragment that opens with prose, so the
        guard matched nothing and the run appended a second copy and consumed
        the source — reproduced before the fix. (An earlier revision shared
        `first_heading` on purpose, because a SEPARATE scan had drifted from
        it (#2290 r5); that was right while the two consumers differed by
        accident, and wrong once they asked different things.) The comparison
        is still a whole ATX line, which is exact: r6 showed a two-line
        construct compared by its text alone refusing a fragment because the
        dated file held that sentence as prose.

        BOTH SIDES ARE READ THE SAME WAY, and each rule below exists because
        one side once was not:

          - A LEADING UTF-8 BOM IS STRIPPED from each line on both sides
            (#2290 r20). A BOM-bearing fragment folded into a legacy file sits
            there as `<BOM>## Title`, which `HEADING_RE` cannot match; and an
            operator removing the mark by hand from the pending copy would
            otherwise leave `## Title` facing `<BOM>## Title` — the #2298
            class, where the remedy edits the very text compared. A UTF-16 or
            UTF-32 section is out of its reach, since its heading bytes are
            NUL-interleaved; `unreadable_at` catches that file first —
            refusing it when unmarked, naming it in a note otherwise (#2315).
          - LINES ARE SPLIT WITH `LINE_END_RE` ON BOTH SIDES, once (#2301 r2).
            Teaching `first_heading` about CR-only files while this scan
            still split on `\\n` made a CR-only fragment publishable whose
            heading this could not see: the whole file was one line,
            nothing matched, and a fragment the parent commit had refused
            was appended twice and consumed. A definition of "a line" held
            separately by two scans is a divergence waiting to happen,
            which is why it is shared.
        """
        # NOTHING PENDING, NOTHING TO ASK. The loop below was a no-op then;
        # the readability refusal after it would not be, and must not stop a
        # run that has no fragment the answer could matter to.
        if not self.frags or not os.path.isfile(self.out) or self.out_copy is None:
            return
        base = os.path.basename(self.out)
        out_data = checked(
            f"checking {base} for assembly markers",
            lambda: open(self.out_copy, "rb").read(),
        )
        # The fragments THIS file records, by name — the per-fragment
        # question the docstring's MARKER COVERAGE paragraph explains (#2312).
        # Taken from `scan_markers`, which read this same copy: a second
        # parse here decoded names differently and missed a non-UTF-8 one
        # (#2328 r1).
        marked_here = {name for (_, name, dated) in self.marker_seen if dated == self.out}
        unmarked = [self.frag_name[f] for f in self.frags if self.frag_name[f] not in marked_here]
        # An unreadable file is refused before any fragment is examined —
        # see the docstring's ENCODING paragraphs. Gated like the heading
        # refusal below: only for pending fragments this file records no
        # marker for, and not under `--force-append`, where the operator has
        # already read the file.
        bad = unreadable_at(without_markers(out_data))
        if bad is not None:
            at, why = bad
            if unmarked and not self.force:
                err(f"Error: {base} cannot be read as UTF-8 text (byte {at}: {why}), and")
                err("records no assembly marker for these pending fragments:")
                err("")
                for s in unmarked:
                    err(f"  {s}")
                err("")
                err("An older version of this script appended fragments exactly as saved,")
                err("so a section in another encoding may already hold one of them — and")
                err("comparing against text it cannot read, this check would miss it.")
                err("")
                err(f"Read {base} and then either:")
                err("  - a pending fragment is already there -> delete it by hand")
                err("  - none is                             -> re-run with --force-append")
                err(f"Converting {base} to UTF-8 also lets this check run.")
                self.refuse_reporting_consumed()
            err(f"Note: {base} cannot be read as UTF-8 text (byte {at}: {why});")
            err("any section of it in another encoding was not checked for a pending fragment.")
            err("")
        # One split with the shared `LINE_END_RE` — see the docstring.
        out_lines_raw = LINE_END_RE.split(out_data)

        suspect = []
        for f in self.frags:
            body = checked(
                f"reading {self.frag_name[f]}",
                lambda p=self.frag_snap[f]: open(p, "rb").read(),
            )
            checked(f"checking {base} for a repeated heading", lambda: None)
            # Both sides: BOM-stripped, split with `LINE_END_RE`, and the
            # fragment rewritten to its published form — see the docstring.
            def _debom(b: bytes) -> bytes:
                return b[3:] if b.startswith(b"\xef\xbb\xbf") else b

            out_lines = [_debom(o) for o in out_lines_raw]
            for ln in LINE_END_RE.split(self.rewrite_links(body)):
                line = _debom(ln)
                if not HEADING_RE.match(line):
                    continue
                if any(line == other for other in out_lines):
                    suspect.append(self.frag_name[f])
                break

        refuse = [s for s in suspect if s not in marked_here]
        if refuse and not self.force:
            err(f"Error: {os.path.basename(self.out)} already contains the heading of a fragment")
            err("about to be appended, and records no assembly marker for that fragment. It")
            err("may have been written by an older version of this script whose run was")
            err("interrupted, in which case appending would duplicate it — and nothing in")
            err("the file can say:")
            err("")
            for s in refuse:
                err(f"  {s}")
            err("")
            err(f"Read that section of {os.path.basename(self.out)} and then either:")
            err("  - it is already there  -> delete the fragment(s) by hand")
            err("  - it is a new section  -> re-run with --force-append")
            self.refuse_reporting_consumed()

        # THE SAME-NAME NOTE IS KEYED ON THE MARKER, NOT ON THE HEADING
        # (#2328 r3). A pending fragment this file records under the same
        # name differs from what was recorded — `classify` would have cleared
        # it otherwise — and that ambiguity holds whether or not its heading
        # still matches, since an edit may retitle it. So every such fragment
        # is named, whatever the scan above found.
        same_name = [self.frag_name[f] for f in self.frags if self.frag_name[f] in marked_here]
        if same_name:
            err(f"Note: {base} records an earlier text under the same name for these")
            err("fragments, and the pending text differs, so it is appended as well:")
            for s in same_name:
                err(f"  {s}" + ("   (its heading is already there)" if s in suspect else ""))
            err("That is either an edit made after an interrupted run or a new fragment")
            err("reusing an old file name. Check for a superseded copy while reviewing.")
            err("")
        forced = [s for s in suspect if s not in marked_here]
        if forced:
            err(f"Note: {base} already contains these headings; appending anyway, as")
            err("--force-append was given:")
            for s in forced:
                err(f"  {s}")
            err("")

    # ── building the replacement ─────────────────────────────────────────

    def build(self) -> None:
        self.workdir = tempfile.mkdtemp(prefix=f".assemble-{self.date}.", dir=self.dir)
        self.work = os.path.join(self.workdir, "replacement")

        if os.path.isfile(self.out):
            # From the RECORDED BASELINE, not a fresh stat (Codex #1898
            # r2 P1). Both this check and the whole-identity recheck at
            # the gate used to look at the live metadata: an owner
            # flipped to the runner for the duration of `build()` and
            # restored before `final_gate()` satisfied both, and the
            # rename then installed the replacement under the runner —
            # silently transferring ownership. `self.out_id` is the
            # identity every later decision is compared against, so it is
            # the identity this decision has to be made from too.
            base_uid, base_gid = identity_owner(self.out_id)
            if base_uid != os.getuid():
                err(f"Error: {os.path.basename(self.out)} is owned by uid {base_uid}, not by you.")
                err("")
                err("Refusing to assemble: this script replaces the dated file by")
                err("renaming a new one over it, which would transfer ownership to you")
                err("and leave the current owner unable to change its permissions.")
                err("Ask the owner to run the assembly, or take ownership deliberately")
                err("before re-running.")
                self.refuse_reporting_consumed()
            shutil.copyfile(self.out_copy or self.out, self.work)
            self.final_mode = self.out_mode
            new_gid = os.stat(self.work).st_gid
            if base_gid != new_gid:
                err(f"Error: {os.path.basename(self.out)} has group {base_gid}; a new file here")
                err(f"would take group {new_gid}.")
                err("")
                err("Refusing to assemble: this script replaces the dated file by")
                err("renaming a new one over it, and the replacement takes that group —")
                err("so anyone who reaches the file through its current group would")
                err("quietly lose access.")
                self.refuse_reporting_consumed()
            self.approved_gid = new_gid
        else:
            with open(self.work, "w", encoding="utf-8") as fh:
                fh.write(f"# Release Notes — {self.date}\n")
            umask = os.umask(0)
            os.umask(umask)
            self.final_mode = format(0o666 & ~umask, "o")
            self.approved_gid = os.stat(self.work).st_gid

        test_hook("build", work=self.work or "", out=self.out)

        with open(self.work, "ab") as fh:
            for f in self.frags:
                fh.write(b"\n")
                raw = checked(
                    f"reading the last byte of {self.frag_name[f]}",
                    lambda p=self.frag_snap[f]: open(p, "rb").read(),
                )
                body = self.rewrite_links(raw)
                fh.write(body)
                if not body.endswith(b"\n"):
                    fh.write(b"\n")
                # os.fsencode, not .encode(): a name carrying a
                # surrogate from an undecodable byte raises on the
                # latter, aborting with a traceback before publication.
                fh.write(
                    os.fsencode(
                        f"{MARKER_PREFIX}{self.frag_name[f]} "
                        f"sha256={self.frag_hash[f]} -->\n"
                    )
                )

    # ── the gate ─────────────────────────────────────────────────────────

    def final_gate(self) -> None:
        """Every precondition that must hold AT publication, in one place.

        Gathered here rather than scattered earlier because a check
        sitting before some other long step leaves a gap big enough to
        drive through, and moving them one at a time only relocates the
        gap. What remains after this is a handful of syscalls — a window
        no shell or script can close, and not a defect.
        """
        self.assert_sources_unchanged("replacing it")

        if os.path.islink(self.qdir) or not os.path.isdir(self.qdir):
            err(f"Error: {self.qdir} is no longer a directory.")
            self.refuse_reporting_consumed()
        self.probe_qdir(at_gate=True)
        if self.qdir_device_state() == "different":
            self.qdir_device_complaint()
            self.refuse_reporting_consumed()

        pool_sticky = bool(os.stat(self.unrel).st_mode & statmod.S_ISVTX)
        qdir_sticky = bool(os.stat(self.qdir).st_mode & statmod.S_ISVTX)
        uid = os.getuid()
        for f in self.frags:
            name = self.frag_name[f]
            if os.path.islink(f) or not os.path.isfile(f):
                err(f"Error: {name} is no longer a regular file.")
                err("It changed type while this run was working.")
                self.refuse_reporting_consumed()

            owns_frag = os.stat(f).st_uid == uid
            if (pool_sticky and not owns_frag and os.stat(self.unrel).st_uid != uid) or (
                qdir_sticky and not owns_frag and os.stat(self.qdir).st_uid != uid
            ):
                err(f"Error: {name} is owned by someone else, and")
                err(f"{self.unrel} is sticky.")
                err("")
                err("Refusing to assemble: setting a fragment aside has to remove its")
                err("entry from that directory, which only its owner or the")
                err("directory's owner may do there — so this would fail after the")
                err("dated file was written. Ask its owner to run the assembly.")
                self.refuse_reporting_consumed()

            dest = os.path.join(self.qdir, name)
            if os.path.exists(dest) or os.path.islink(dest):
                err(f"Error: a set-aside file already occupies {dest}.")
                err("")
                err(f"Refusing to assemble: if {name} had to be set aside")
                err("during this run it would have nowhere to go, and that failure")
                err("would happen after the dated file was already written.")
                err("")
                err("Compare that file against the dated notes and remove it, or move")
                err("it elsewhere, then re-run.")
                self.refuse_reporting_consumed()

        if os.path.islink(self.work) or not os.path.isfile(self.work):
            err("Error: the replacement is no longer a regular file.")
            self.refuse_reporting_consumed()
        st = os.stat(self.work)
        if format(statmod.S_IMODE(st.st_mode), "o") != self.final_mode:
            err("Error: the replacement's mode changed while this run was")
            err(f"preparing it ({self.final_mode} -> {format(statmod.S_IMODE(st.st_mode), 'o')}).")
            err("Publishing it would install permissions this run did not choose.")
            self.refuse_reporting_consumed()
        if st.st_gid != self.approved_gid:
            err("Error: the replacement's group changed while this run was")
            err(f"preparing it ({self.approved_gid} -> {st.st_gid}).")
            err("Publishing it would hand the file to a group this run did not")
            err("approve.")
            self.refuse_reporting_consumed()
        # And its CONTENT. The gate had grown checks on type, mode and
        # group, and none on the thing those three exist to protect.
        if frag_hash(self.work) != self.expected_id:
            err("Error: the replacement's content changed while this run was")
            err("preparing it.")
            err("")
            err("Refusing to assemble: publishing it would replace")
            err(f"{os.path.basename(self.out)} with bytes this run did not build, and the")
            err("fragments would then be removed on the strength of them.")
            self.refuse_reporting_consumed()

        # The SOURCE directory too: a rename removes the source entry,
        # so `mv` needs write permission on BOTH.
        # The path stays RECORDED until removal actually succeeds (Codex
        # #1898 r2). Clearing `self.probe` in the failure branch meant a
        # probe that was created but could not be removed — directory
        # permissions changing between the two calls — was dropped from
        # `cleanup()`'s retry list, and `report_leftovers()` never names
        # it because that scanner only looks inside `.assembled`. The
        # printed `git add -A docs/ReleaseNotes/` would then stage it.
        try:
            with HoldSignals():
                fd, p = tempfile.mkstemp(prefix=".probe.", dir=self.unrel)
                self.probe = p
                os.close(fd)
        except OSError:
            self.probe = None
            err(f"Error: entries can no longer be created in {self.unrel}.")
            self.refuse_reporting_consumed()

        try:
            os.remove(p)
            self.probe = None
        except OSError:
            # Distinct from the creation failure above, and deliberately
            # not fatal on its own: creation is what this probe exists to
            # answer, and it succeeded. But the file is real now, so say
            # where it is and leave `cleanup()` holding it.
            err(f"Warning: could not remove the probe file {p}.")
            err("It is left for cleanup to retry; remove it by hand if it survives,")
            err("and do not commit it.")

    def publish(self) -> None:
        os.chmod(self.work, int(self.final_mode, 8))
        got = read_mode(self.work)
        if got != self.final_mode:
            err(f"Error: the replacement could not be given mode {self.final_mode}")
            err(f"(it has {got}).")
            err("")
            err("This happens when a bit cannot be set by you — the set-group-ID bit")
            err("is dropped for a user outside the file's group, and chmod reports")
            err("success anyway. Replacing the file would silently drop it.")
            err("")
            self.refuse_reporting_consumed()

        self.expected_id = frag_hash(self.work)
        # Push the bytes to disk BEFORE the fragments — the only other
        # copy of that text — are removed. Best-effort: it narrows a
        # crash window and cannot corrupt anything by not happening.
        try:
            fd = os.open(self.work, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass
        # The flush is the long step the gate exists to close a window
        # over, so it is the moment a test needs to act in.
        test_hook("flush", work=self.work or "", out=self.out)

        self.final_gate()

        try:
            os.rename(self.work, self.out)
        except OSError:
            err("Error: could not put the assembled file in place.")
            err("")
            err(f"{os.path.basename(self.out)} is untouched — the replacement was built beside")
            err("it and never installed.")
            self.refuse_reporting_consumed()
        self.work = None
        self.published = True
        # The DIRECTORY ENTRY, not just the file (Codex #1898 r1).
        # fsyncing the replacement makes its bytes durable; it says
        # nothing about the rename that put them at $OUT. After a power
        # cut the fragment unlinks could survive while the publication
        # did not — the text gone from both places, which is the one
        # outcome this whole script exists to prevent. Best-effort, like
        # the file flush: it narrows a window and cannot corrupt
        # anything by not happening.
        try:
            dfd = os.open(self.dir, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
        self.published_id = frag_hash(self.out)
        if self.published_id != self.expected_id:
            self.abort_after_write(
                f"{os.path.basename(self.out)} does not hold the bytes this run built"
            )

    def clear(self) -> None:
        """Remove each fragment, re-proving the published file each time.

        N irreversible steps, not one — so the evidence is re-checked
        per fragment rather than once at the top.
        """
        kept: list[str] = []
        for f in self.frags:
            name = self.frag_name[f]
            # A failed READ is the same news as a mismatch, and reaches
            # the operator through the same door (Codex #1898 r1).
            # Letting the OSError escape sent them a generic error rather
            # than being told which fragments had already gone and that
            # the published file is the thing now missing.
            try:
                still = frag_hash(self.out)
            except OSError:
                still = None
            if still != self.published_id:
                self.abort_after_write(
                    f"{os.path.basename(self.out)} is gone or altered since it was written"
                )
            q = os.path.join(self.qdir, name)
            test_hook("clear", out=self.out, fragment=f, quarantine=q)
            if os.path.exists(q) or os.path.islink(q):
                self.abort_after_write(f"a set-aside file already exists at {name}")
            try:
                os.rename(f, q)
            except OSError:
                self.abort_after_write(f"could not set aside {name}")
            self.quarantined.append(f"{name} -> .assembled/{name}")
            # After the move, before the last look: the window in which a
            # writer holding the old inode can still append.
            test_hook("clear-moved", out=self.out, fragment=f, quarantine=q)

            try:
                current = frag_hash(q)
            except OSError:
                self.abort_after_write(
                    f"could not re-hash {name} (now set aside as {name})"
                )
            if current != self.frag_hash[f]:
                # Deliberately NOT moved back: the editor may already
                # have written a new file at the original path, and
                # restoring over it would destroy the very text this
                # branch exists to protect.
                kept.append(f"{name} -> .assembled/{name}")
                continue

            if os.path.islink(self.out) or not os.path.isfile(self.out):
                self.abort_after_write(
                    f"{os.path.basename(self.out)} is no longer a regular file"
                )
            if frag_hash(self.out) != self.published_id:
                self.abort_after_write(
                    f"{os.path.basename(self.out)} is gone or altered since it was written"
                )
            # The quarantine last of all, so the check nearest the delete
            # is the one about the thing being deleted.
            if frag_hash(q) != self.frag_hash[f]:
                kept.append(f"{name} -> .assembled/{name}")
                continue
            try:
                os.remove(q)
            except OSError:
                self.abort_after_write(f"could not remove {name}")
            self.consumed.append(name)
            self.quarantined.pop()

        if kept:
            err("")
            err("Kept (changed while this run was reading them), set aside as:")
            for k in kept:
                err(f"  {k}")
            err("")
            err(f"{os.path.basename(self.out)} holds the version read at the start of the run, and")
            err("these hold newer text. Compare each before deleting it.")
            err("")

    # ── the run, end to end ──────────────────────────────────────────────

    def run(self) -> None:
        self.check_out_path()
        self.ensure_qdir()
        self.acquire_lock()
        self.report_leftovers()
        self.discover()
        self.select_by_day()
        self.snapshot()

        if os.path.isfile(self.out):
            try:
                self.out_id = file_identity(self.out)
                self.out_mode = read_mode(self.out)
            except OSError:
                err(f"Error: {os.path.basename(self.out)} -- reading its current mode failed.")
                err("Refusing to assemble: every later decision about deleting a")
                err("fragment rests on knowing this file has not changed underneath,")
                err("and replacing it would have to guess a mode -- guessing wider")
                err("than it was would expose content that was deliberately")
                err("restricted.")
                raise SystemExit(1)

        marker_seen, marker_where = self.scan_markers()
        # Kept for the duplicate guard, which asks which fragment NAMES this
        # file records (#2312) — from the one parse, not a second one.
        self.marker_seen = marker_seen
        already, pending = self.classify(marker_seen, marker_where)

        # BEFORE the recovery clear, not merely before the append (#2290 r1).
        # `clear_already_assembled` DELETES fragments, so validating after it
        # leaves a refused run with input already consumed — and the docstring
        # claimed the opposite, which is worse than the ordering itself.
        self.frags = pending

        # MARKERLESS RECOVERY IS ASKED FIRST (#2290 r16). Both checks only
        # refuse — neither consumes or writes — so the order is free, and it
        # decides which question the operator is asked to answer first.
        #
        # Asking about the heading first was a trap on a legacy markerless
        # file that already held the fragment: the run refused the heading,
        # the operator changed `# Title` to `## Title` as instructed, and the
        # rerun then searched the dated file for the NEW line, missed the copy
        # already published under the old one, appended a duplicate and
        # consumed the source. The remediation invalidated the evidence the
        # next check depends on. Reproduced before this reorder.
        self.check_markerless_duplicates()
        self.check_heading_conformance()

        if already:
            self.clear_already_assembled(already)
        if not pending:
            self.nothing_pending()
        self.build()
        self.publish()
        self.clear()

        out_line(f"Assembled {len(self.frags)} fragment(s) -> {self.out}")
        out_line("")
        out_line("Next:")
        out_line(f"  - review {self.out} and add an intro paragraph")
        out_line("  - git add -A docs/ReleaseNotes/")
        out_line(f"  - git commit -m 'docs: release notes {self.date}'")


class Terminated(Exception):
    """SIGTERM arrived. Raised so the cleanup path runs."""


def _on_sigterm(_signum, _frame):
    # MASKING IS NOT HANDLING (Codex #1898 r1). `HoldSignals` defers
    # SIGTERM across the two-step windows, but with no handler installed
    # Python restores the DEFAULT disposition when the mask lifts — the
    # process dies immediately, `finally` never runs, and the lock and
    # working directories are left behind for every later run to refuse
    # over. The shell version had a trap for exactly this and the port
    # dropped it, keeping only the half that defers.
    raise Terminated()


def main(argv: list[str]) -> int:
    date = ""
    allow_mixed = force = False
    for a in argv:
        if a == "--allow-mixed-dates":
            allow_mixed = True
        elif a == "--force-append":
            force = True
        elif a.startswith("-"):
            err(f"Error: unknown option '{a}'")
            return 1
        else:
            if date:
                err(f"Error: more than one date given ('{date}' and '{a}')")
                return 1
            date = a

    if not date:
        date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        err(f"Error: date must be YYYY-MM-DD (got '{date}')")
        return 1

    signal.signal(signal.SIGTERM, _on_sigterm)

    directory = os.path.dirname(os.path.realpath(__file__))
    run = Assembly(directory, date, allow_mixed, force)
    try:
        run.run()
    except SystemExit as e:
        return int(e.code or 0)
    except KeyboardInterrupt:
        return 130
    except Terminated:
        return 143
    except StepFailed as sf:
        # ONE renderer for every named step, which is the whole point of
        # having the wrapper: the shell version read the same way at
        # every failure because it had exactly one of these, and the
        # port's scattered handling is what left thirty-eight cases with
        # nothing to aim at.
        err(f"Error: {sf.what} failed (exit {sf.code}).")
        if run.published:
            err("")
            err(f"{os.path.basename(run.out)} HAS ALREADY BEEN WRITTEN — this failure is in the")
            err("clearing step that follows it, so the run is half done.")
        else:
            err("Refusing to assemble: this run replaces a published file and deletes")
            err("the fragments it consumed, so it must not continue on the strength of")
            err("a result it did not get.")
        try:
            run.refuse_reporting_consumed()
        except SystemExit as se:
            return int(se.code or 1)
        return 1
    except OSError as e:
        # The backstop, and the reason it exists: an unexpected failure
        # must speak this script's contract, not Python's. A traceback
        # says nothing about whether a fragment has already been removed
        # or set aside, which is the only question the operator has —
        # and it is the same fault the shell version kept having, where
        # a command failing under `errexit` exited with the tool's own
        # one-line diagnostic and nothing else.
        #
        # Which side of the rename it happened on decides the wording,
        # so the two handlers stay distinct and both are reached from
        # here rather than from each call site. Enumerating the sites
        # was what kept going wrong.
        err("")
        err(f"Error: {e.strerror or e}: {e.filename or ''}".rstrip(": "))
        if run.published:
            err("")
            err(f"{os.path.basename(run.out)} HAS ALREADY BEEN WRITTEN — this failure is in the")
            err("clearing step that follows it, so the run is half done.")
        else:
            err("Refusing to assemble: this run replaces a published file and deletes")
            err("the fragments it consumed, so it must not continue on the strength of")
            err("a result it did not get.")
        try:
            run.refuse_reporting_consumed()
        except SystemExit as se:
            return int(se.code or 1)
        return 1
    finally:
        # Cleanup is the one sequence a signal must not cut into (Codex
        # #1898 r2). The handler installed above raises, and it stays
        # armed inside this `finally`: a SIGTERM arriving mid-`rmtree`
        # raised straight out of cleanup, so the lock release below it
        # never ran and the run left `.assemble.lock` plus both working
        # directories behind — the exact state the handler was added to
        # prevent. Deferring is right HERE, where the earlier objection
        # (that masking is not handling) does not apply: there is no
        # later step left to protect, so a pending TERM has nothing to
        # interrupt once cleanup has finished.
        with HoldSignals():
            run.cleanup()
            # Handed back to the kernel before the mask lifts, so a
            # SIGTERM that arrived during cleanup terminates the process
            # the way the sender asked — rather than raising `Terminated`
            # out of this `finally` and past the return value.
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
