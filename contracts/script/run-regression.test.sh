#!/usr/bin/env bash
#
# run-regression.test.sh — tests for run-regression.sh's plan, sharding and
# shard verification (#2770). Runs in seconds: `forge` is replaced by a stub
# on PATH that records each `--match-path` it is given, so nothing compiles.
# The plan is built from the real test tree, so these tests also prove the
# current tree shards cleanly.
#
#   bash contracts/script/run-regression.test.sh
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/run-regression.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A FORK_URL_* in the caller's environment would change the plan; every run
# here starts without one.
for v in $(compgen -e | grep '^FORK_URL_' || true); do unset "$v"; done
unset CHUNK_SIZE SUBDIR_CHUNK_SIZE

mkdir -p "$WORK/bin"
cat > "$WORK/bin/forge" <<'STUB'
#!/usr/bin/env bash
# Stub forge: record the --match-path glob, fail when it equals $STUB_FAIL_GLOB.
while (( $# )); do
  if [ "$1" = "--match-path" ]; then echo "$2" >> "$STUB_LOG"; [ "$2" = "${STUB_FAIL_GLOB:-}" ] && exit 1; fi
  shift
done
exit 0
STUB
chmod +x "$WORK/bin/forge"
export PATH="$WORK/bin:$PATH"

PASS=0 FAILS=0
ok()   { echo "ok   - $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL - $1" >&2; FAILS=$((FAILS+1)); }
expect() { # expect <name> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (exit $3, expected $2)"; fi
}

rr() { STUB_LOG="$WORK/forge.log" bash "$SCRIPT" "$@"; }

# ── The plan ────────────────────────────────────────────────────────────────
rr --list-chunks > "$WORK/plan.tsv" 2>/dev/null; expect "--list-chunks succeeds on the tree" 0 $?
cut -f2 "$WORK/plan.tsv" > "$WORK/plan.globs"
TOTAL=$(wc -l < "$WORK/plan.globs")
if (( TOTAL >= 4 )); then ok "plan has $TOTAL chunks"; else bad "plan has only $TOTAL chunks"; fi
if [ "$(sort "$WORK/plan.globs" | uniq -d | wc -l)" -eq 0 ]; then ok "no chunk appears twice in the plan"; else bad "a chunk appears twice in the plan"; fi
if [ ! -e "$WORK/forge.log" ]; then ok "--list-chunks runs no forge"; else bad "--list-chunks invoked forge"; fi

# ── Unsharded run: every chunk, in plan order ───────────────────────────────
rm -f "$WORK/forge.log"
rr > /dev/null 2>&1; expect "unsharded run passes with a passing forge" 0 $?
if cmp -s "$WORK/forge.log" "$WORK/plan.globs"; then ok "unsharded run runs exactly the plan, in order"; else bad "unsharded run differs from the plan"; fi

# ── Three shards: a partition of the plan, verified ─────────────────────────
mkdir -p "$WORK/m3"
: > "$WORK/union"
for i in 1 2 3; do
  rm -f "$WORK/forge.log"
  rr --shard "$i/3" --manifest "$WORK/m3/shard-$i.tsv" > /dev/null 2>&1; expect "shard $i/3 passes" 0 $?
  cat "$WORK/forge.log" >> "$WORK/union" 2>/dev/null || true
done
if [ "$(sort "$WORK/union")" = "$(sort "$WORK/plan.globs")" ]; then ok "three shards run every chunk exactly once"; else bad "three shards do not partition the plan"; fi
rr --verify-shards "$WORK/m3" > /dev/null 2>&1; expect "--verify-shards accepts a complete set" 0 $?

# Round-robin: shard 1 takes plan positions 0, 3, 6, ...
awk 'NR%3==1' "$WORK/plan.globs" > "$WORK/expect1"
grep -P '^(pass|fail)\t' "$WORK/m3/shard-1.tsv" | cut -f2 > "$WORK/got1"
if cmp -s "$WORK/expect1" "$WORK/got1"; then ok "shard 1/3 takes every third chunk from the first"; else bad "shard 1/3 took the wrong chunks"; fi

# ── What --verify-shards must refuse ────────────────────────────────────────
refuse() { # refuse <name> <dir>
  rr --verify-shards "$2" > /dev/null 2>"$WORK/err"
  if [ $? -ne 0 ]; then ok "refuses: $1"; else bad "accepted: $1"; fi
}
copy_set() { rm -rf "$WORK/$1"; cp -r "$WORK/m3" "$WORK/$1"; }

copy_set missing; rm "$WORK/missing/shard-2.tsv"
refuse "a shard left out of the set" "$WORK/missing"

copy_set dup; cp "$WORK/dup/shard-1.tsv" "$WORK/dup/shard-1-again.tsv"
refuse "the same shard reported twice" "$WORK/dup"

copy_set cut; sed -i '/^complete\t/d' "$WORK/cut/shard-3.tsv"
refuse "a manifest that never recorded completing" "$WORK/cut"

copy_set dropped; sed -i '0,/^pass\t/{/^pass\t/d}' "$WORK/dropped/shard-2.tsv"
refuse "a chunk no shard ran" "$WORK/dropped"

copy_set extra; printf 'pass\ttest/NotInThePlan.t.sol\n' >> "$WORK/extra/shard-1.tsv"
refuse "a chunk the plan does not contain" "$WORK/extra"

copy_set twice; grep -P '^pass\t' "$WORK/twice/shard-1.tsv" | head -1 >> "$WORK/twice/shard-2.tsv"
refuse "a chunk run by two shards" "$WORK/twice"

mkdir -p "$WORK/empty"
refuse "an empty manifest directory" "$WORK/empty"

# A shard split a different number of ways.
copy_set mixedn
rm -f "$WORK/forge.log"
rr --shard 1/2 --manifest "$WORK/mixedn/shard-1.tsv" > /dev/null 2>&1
refuse "manifests that disagree on N" "$WORK/mixedn"

# A shard whose environment changed the plan.
copy_set otherplan
CHUNK_SIZE=7 rr --shard 2/3 --manifest "$WORK/otherplan/shard-2.tsv" > /dev/null 2>&1
refuse "a shard cut from a different plan (CHUNK_SIZE)" "$WORK/otherplan"
CHUNK_SIZE=7 rr --verify-shards "$WORK/m3" > /dev/null 2>&1
if [ $? -ne 0 ]; then ok "refuses: a verifier whose own plan differs"; else bad "accepted: a verifier whose own plan differs"; fi

# A shard narrowed by a forge filter is not a shard of the regression.
copy_set filtered
rr --shard 3/3 --manifest "$WORK/filtered/shard-3.tsv" --match-test testNothing > /dev/null 2>&1
refuse "a shard narrowed by a forge filter" "$WORK/filtered"

# A failing chunk fails its shard AND the verification.
FAIL_GLOB=$(sed -n 2p "$WORK/plan.globs")
mkdir -p "$WORK/red"
for i in 1 2 3; do
  STUB_FAIL_GLOB="$FAIL_GLOB" rr --shard "$i/3" --manifest "$WORK/red/shard-$i.tsv" > /dev/null 2>&1
  rc=$?
  if [ "$i" = 2 ]; then expect "the shard holding a red chunk fails" 1 $rc; fi
done
refuse "a set containing a failed chunk" "$WORK/red"
if grep -qF "chunk FAILED: $FAIL_GLOB" "$WORK/err"; then ok "the refusal names the failed chunk"; else bad "the refusal does not name the failed chunk"; fi

# ── Argument checks ─────────────────────────────────────────────────────────
for spec in 0/3 4/3 3 a/b 1/0 ""; do
  rr --shard "$spec" > /dev/null 2>&1
  expect "rejects --shard '$spec'" 2 $?
done
rr --list-chunks --shard 1/2 > /dev/null 2>&1; expect "rejects --shard with --list-chunks" 2 $?
rr --verify-shards "$WORK/m3" -vvv > /dev/null 2>&1; expect "rejects forge arguments with --verify-shards" 2 $?

# predeploy-check.sh passes the shard through, and only with --full.
bash "$HERE/predeploy-check.sh" --shard 1/2 > /dev/null 2>&1; expect "predeploy-check refuses --shard without --full" 2 $?
bash "$HERE/predeploy-check.sh" --full --shard > /dev/null 2>&1; expect "predeploy-check refuses --shard with no value" 2 $?

echo
echo "$PASS passed, $FAILS failed"
(( FAILS == 0 ))
