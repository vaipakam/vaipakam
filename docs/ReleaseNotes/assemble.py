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
HEADING_RE = re.compile(rb"^#{1,6} ")
SKIP_NAMES = {"README.md", "_TEMPLATE.md"}


class Refuse(Exception):
    """A pre-publication refusal: report, then exit 1 with nothing consumed."""


class AbortAfterWrite(Exception):
    """A failure in the clearing step, after the dated file is published."""


def out_line(msg: str = "") -> None:
    print(msg)


def err(msg: str = "") -> None:
    print(msg, file=sys.stderr)


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
        return subprocess.run(
            ["git", "-C", cwd or self.dir, *args], capture_output=True, text=True
        )

    def select_by_day(self) -> None:
        """Keep only the fragments belonging to the day being assembled.

        A fragment belongs to the day its PR merged, in UTC. Local time
        is a trap: at +05:30 every merge after 18:30 UTC reads as
        tomorrow, which misfiled fragments twice before this existed.
        """
        if self.allow_mixed:
            return

        if self.git("rev-parse", "--is-inside-work-tree").returncode != 0:
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
                err("Error: a .git entry exists but git cannot read this work tree.")
                err("Fragment dates are unavailable, and assembling would consume every")
                err("pending fragment under a date nothing verified. Repair the checkout,")
                err("or pass --allow-mixed-dates to assemble without dating.")
                raise SystemExit(1)
            err("note: not a git work tree — cannot date fragments, assembling all pending.")
            return

        root = self.git("rev-parse", "--show-toplevel").stdout.strip()

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
            cdir = self.git("rev-parse", "--git-common-dir").stdout.strip()
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
        for raw in data.split(b"\n"):
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
            for raw in data.split(b"\n"):
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
        appended = body if body.endswith(b"\n") else body + b"\n"
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

    # ── markerless duplicate-heading guard ───────────────────────────────

    def check_markerless_duplicates(self) -> None:
        if not os.path.isfile(self.out) or self.out_copy is None:
            return
        base = os.path.basename(self.out)
        out_data = checked(
            f"checking {base} for assembly markers",
            lambda: open(self.out_copy, "rb").read(),
        )
        out_has_markers = any(
            MARKER_RE.match(line.decode("utf-8", errors="replace"))
            for line in out_data.split(b"\n")
            if line.startswith(MARKER_PREFIX.encode())
        )
        normalised = b"\n".join(
            ln[:-1] if ln.endswith(b"\r") else ln for ln in out_data.split(b"\n")
        )

        suspect = []
        for f in self.frags:
            body = checked(
                f"reading {self.frag_name[f]}",
                lambda p=self.frag_snap[f]: open(p, "rb").read(),
            )
            checked(f"checking {base} for a repeated heading", lambda: None)
            if True:
                for raw in body.split(b"\n"):
                    line = raw[:-1] if raw.endswith(b"\r") else raw
                    if HEADING_RE.match(line):
                        if any(line == other for other in normalised.split(b"\n")):
                            suspect.append(self.frag_name[f])
                        break

        if suspect and not out_has_markers and not self.force:
            err(f"Error: {os.path.basename(self.out)} carries no assembly markers at all, and already")
            err("contains the heading of a fragment about to be appended. It may have been")
            err("written by an older version of this script whose run was interrupted, in")
            err("which case appending would duplicate it — and nothing in the file can say:")
            err("")
            for s in suspect:
                err(f"  {s}")
            err("")
            err(f"Read that section of {os.path.basename(self.out)} and then either:")
            err("  - it is already there  -> delete the fragment(s) by hand")
            err("  - it is a new section  -> re-run with --force-append")
            self.refuse_reporting_consumed()

        if suspect:
            err(f"Note: {os.path.basename(self.out)} already contains these headings; appending anyway")
            err("(their fragments are not recorded as folded in, so the text differs):")
            for s in suspect:
                err(f"  {s}")
            err("Check for a superseded copy of that section while reviewing.")
            err("")

    # ── building the replacement ─────────────────────────────────────────

    def build(self) -> None:
        self.workdir = tempfile.mkdtemp(prefix=f".assemble-{self.date}.", dir=self.dir)
        self.work = os.path.join(self.workdir, "replacement")

        if os.path.isfile(self.out):
            st = os.stat(self.out)
            if st.st_uid != os.getuid():
                err(f"Error: {os.path.basename(self.out)} is owned by uid {st.st_uid}, not by you.")
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
            if st.st_gid != new_gid:
                err(f"Error: {os.path.basename(self.out)} has group {st.st_gid}; a new file here")
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
        try:
            with HoldSignals():
                fd, p = tempfile.mkstemp(prefix=".probe.", dir=self.unrel)
                self.probe = p
                os.close(fd)
            os.remove(p)
            self.probe = None
        except OSError:
            self.probe = None
            err(f"Error: entries can no longer be created in {self.unrel}.")
            self.refuse_reporting_consumed()

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
        already, pending = self.classify(marker_seen, marker_where)

        if already:
            self.clear_already_assembled(already)
        if not pending:
            self.nothing_pending()

        self.frags = pending
        self.check_markerless_duplicates()
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
        run.cleanup()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
