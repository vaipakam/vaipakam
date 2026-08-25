#!/usr/bin/env python3
"""#1932 — every flag the deploy wrappers parse must survive `.env`.

The wrappers parse CLI flags into shell variables and THEN source a shared
`.env` with `set -a`, which exports every assignment in that file. Any name the
file happens to mention therefore overwrites what the operator just typed — in
both directions: a stale value arms a flag nobody passed, and an explicit flag
is discarded when the file sets it off.

`CLI_OWNED_VARS` + the restore loop is the fix. This check exists because the
fix is a LIST, and a list of names that must match another list of names is the
thing that goes stale: #1920 protected one variable and left seven with the
identical exposure, which is how #1932 came to be filed at all.

The property checked is set EQUALITY, not containment, in both directions:

  * a case-block variable missing from `CLI_OWNED_VARS` is the #1932 bug
    reappearing — and for `CONFIRM_PURGE_MAINNET` that means a `.env` line can
    arm a mainnet purge nobody confirmed;
  * a name in `CLI_OWNED_VARS` that no flag sets is dead weight that makes the
    list look more complete than it is, and would silently keep "protecting" a
    flag after it was renamed.

Exits non-zero with the offending names. Finding no case block, or an empty
list, is a HARD ERROR rather than a pass: a check that scanned nothing has not
verified anything, and reporting that as success is worse than not running.
"""
import re
import sys
from pathlib import Path

SCRIPTS = ("deploy-mainnet.sh", "deploy-testnet.sh")

# Assignment of an ALL-CAPS shell name, matched only after the line's comment
# tail is removed. An earlier revision matched against the raw block and got
# both halves wrong at once: it read `CONFIGURE_VPFI_PEG=1` out of an
# explanatory COMMENT and reported it unprotected, while missing real
# assignments like `CONFIRM_PURGE_MAINNET=1` whose lines it failed to anchor.
# A checker that reports the wrong names is worse than one that does not run,
# because the names look specific enough to act on.
ASSIGN = re.compile(r'\b([A-Z][A-Z0-9_]{2,})=')


def strip_comment(line: str) -> str:
    """Drop a `#` comment tail, ignoring `#` inside single or double quotes."""
    out, quote = [], None
    for ch in line:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            out.append(ch)
        elif ch == '#':
            break
        else:
            out.append(ch)
    return ''.join(out)


def case_block(text: str) -> str:
    start = re.search(r'case\s+"\$1"\s+in', text)
    if not start:
        raise SystemExit("FAIL: no `case \"$1\" in` block found — parser drifted")
    end = text.find("esac", start.end())
    if end == -1:
        raise SystemExit("FAIL: unterminated case block")
    return text[start.end():end]


def declared(text: str) -> list:
    m = re.search(r'CLI_OWNED_VARS=\(([^)]*)\)', text)
    if not m:
        raise SystemExit("FAIL: no CLI_OWNED_VARS=( ... ) declaration found")
    names = m.group(1).split()
    if not names:
        raise SystemExit("FAIL: CLI_OWNED_VARS is empty")
    return names


def main() -> int:
    here = Path(__file__).resolve().parent
    bad = 0
    for name in SCRIPTS:
        text = (here / name).read_text()
        body = '\n'.join(strip_comment(l) for l in case_block(text).splitlines())
        parsed = set(ASSIGN.findall(body))
        listed = set(declared(text))
        if not parsed:
            raise SystemExit(f"FAIL: {name} — case block assigned no variables; parser drifted")
        missing = sorted(parsed - listed)
        extra = sorted(listed - parsed)
        if missing or extra:
            bad = 1
            if missing:
                print(f"  x {name} — flag-set but NOT protected from .env: {', '.join(missing)}",
                      file=sys.stderr)
            if extra:
                print(f"  x {name} — protected but set by no flag: {', '.join(extra)}",
                      file=sys.stderr)
        else:
            print(f"  ok {name} — all {len(parsed)} flag-set variables survive .env")
    return bad


if __name__ == "__main__":
    sys.exit(main())
