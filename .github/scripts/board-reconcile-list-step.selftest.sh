#!/usr/bin/env bash
# Fixtures for the `List board items` step of
# `.github/workflows/project-board-reconcile.yml`.
#
# WHY THIS EXISTS (#2129). That step's failure branch is a diagnostic: when the
# board listing fails it must print evidence that distinguishes "the account is
# rate limited, wait" from "the token cannot read the project, fix the secret".
# Those need opposite responses, and for four consecutive scheduled runs the log
# said neither — it printed a healthy `5000` from `/rate_limit` and gh's opaque
# `unknown owner type`, and three different explanations were argued from that
# pair and two withdrawn.
#
# A diagnostic that is only exercised when something breaks is a diagnostic
# nobody has seen work. These fixtures run it on demand, against a stubbed `gh`,
# and assert what it does in each situation below. No count is stated here on
# purpose — the scenarios are the list, and an earlier revision of this line
# said "four" and was wrong within the hour.
#
# THE STEP IS EXTRACTED FROM THE WORKFLOW, never copied here: a copy would pass
# while the real step drifted, which is the failure mode the whole issue is
# about. Extraction failing is itself a failure, so a renamed step cannot make
# this quietly test nothing.
#
#   bash .github/scripts/board-reconcile-list-step.selftest.sh
#
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
workflow="$repo_root/.github/workflows/project-board-reconcile.yml"
step_name='List board items'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ── extract the step body ────────────────────────────────────────────────────
# Deterministic for this file's shape: find `- name: <step>`, then its `run: |`,
# then take the indented block that follows. Dependency-free on purpose — this
# has to run anywhere the workflow does.
awk -v want="$step_name" '
  $0 ~ "^[[:space:]]*- name: " want "[[:space:]]*$" { in_step = 1; next }
  in_step && $0 ~ "^[[:space:]]*- name: " { exit }
  in_step && $0 ~ "^[[:space:]]*run: \\|[[:space:]]*$" {
    in_run = 1
    match($0, /^[[:space:]]*/); run_indent = RLENGTH
    next
  }
  in_run {
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }
    match($0, /^[[:space:]]*/)
    if (RLENGTH <= run_indent) exit
    print substr($0, run_indent + 3)
  }
' "$workflow" > "$work/step.sh"

if [ ! -s "$work/step.sh" ]; then
  echo "FAIL: could not extract the '$step_name' step from $workflow" >&2
  echo "      (renamed? reshaped? this fixture must not pass without it)" >&2
  exit 1
fi

fail=0
check() { # check <label> <condition-description> <0|1 result>
  if [ "$3" -eq 0 ]; then
    printf '  ok    %s\n' "$2"
  else
    printf '  FAIL  %s\n' "$2" >&2
    fail=1
  fi
}

run_step() { # run_step <scenario-env...> ; output lands in "$work/out.txt"
  # RUN IT IN THE TEMPORARY DIRECTORY. The step writes `board.json` and
  # `list-trace.txt` relative to the working directory — in the real job that
  # is the runner's checkout and they are discarded with it, but a fixture
  # inheriting the caller's directory drops both into the repository every
  # time anyone runs it. Caught by the repo's own untracked-file check after
  # the first run here.
  : > "$work/calls.txt"
  : > "$work/sleeps.txt"
  set +e
  ( cd "$work"
    export PATH="$work/bin:$PATH" PROJECT_NUMBER=1 PROJECT_OWNER=vaipakam LIST_LIMIT=4000 \
      RETRY_WAIT_CAP_SECONDS=900 RETRY_MARGIN_SECONDS=5 "$@"
    bash "$work/step.sh" ) > "$work/out.txt" 2>&1
  rc=$?
  set -e
  return $rc
}
attempts() { grep -c 'item-list' "$work/calls.txt" || true; }

mkdir -p "$work/bin"
SECRET='ghp_SuperSecretTokenValue1234567890'

# THE REAL PARSER, not a stub. The step reads its retry decision from
# `.github/scripts/gh-trace-ratelimit-wait.sh` at a checkout-relative path, so
# the fixture's working directory carries a copy of the real file. A stub here
# would let the step and the parser drift apart while both of their fixtures
# stay green — the same hazard the extraction above exists to close.
mkdir -p "$work/.github/scripts"
cp "$repo_root/.github/scripts/gh-trace-ratelimit-wait.sh" "$work/.github/scripts/"

# `sleep` IS stubbed: the retry waits for whatever reset the trace named, and
# a fixture that really waited a minute per scenario would not get run. The
# stub records what it was asked for, which is what the assertions read.
cat > "$work/bin/sleep" <<'SH'
#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/../sleeps.txt"
SH
chmod +x "$work/bin/sleep"

# ── scenario 1: the listing is refused ───────────────────────────────────────
# The shape that actually happened, and the one the old log could not describe:
# `/rate_limit` reports a HEALTHY table while the request itself came back 403
# with the limit headers set. A diagnostic that reads only `/rate_limit` prints
# "5000" here and says nothing true.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{"graphql":{"limit":5000,"remaining":5000}}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ -n "\${GH_DEBUG:-}" ]; then
    cat >&2 <<'TRACE'
> POST /graphql HTTP/1.1
> Authorization: token $SECRET
< HTTP/2.0 403 Forbidden
< Retry-After: 60
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Resource: graphql
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}
TRACE
  fi
  echo "unknown owner type" >&2
  exit 1
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "refused listing:"
run_step && rc=0 || rc=$?
check r "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
grep -q '403 Forbidden' "$work/out.txt" && s=0 || s=1
check r "the failed request's HTTP status is shown" "$s"
grep -q 'X-Ratelimit-Remaining: 0' "$work/out.txt" && s=0 || s=1
check r "the failed request's rate-limit header is shown" "$s"
grep -q 'Retry-After: 60' "$work/out.txt" && s=0 || s=1
check r "retry-after is shown" "$s"
grep -q 'secondary rate limit' "$work/out.txt" && s=0 || s=1
check r "the error body is shown" "$s"
# gh's OWN summary line — `unknown owner type` — is deliberately NOT carried,
# and this pins the trade rather than hiding it. It sits on the same stream as
# the trace, is not an HTTP line, and separating it from response payload would
# need a guess about which stderr lines are gh's; on a public repository that
# guess is the disclosure. It also adds nothing the status and headers do not
# say better — it was the ONLY thing the old log had, which is precisely why
# that log could not distinguish "wait" from "fix the secret".
grep -q 'unknown owner type' "$work/out.txt" && s=1 || s=0
check r "gh's unstructured summary line is NOT carried (the trade, pinned)" "$s"
# The point of the whole change: the trace contradicts the table, and BOTH are
# printed, so the reader can see which one to believe.
grep -q '"remaining":5000' "$work/out.txt" && s=0 || s=1
check r "the (misleading) rate_limit table is still shown, labelled" "$s"
grep -qF "$SECRET" "$work/out.txt" && s=1 || s=0
check r "the token does NOT appear anywhere in the output" "$s"
# STRONGER than the redaction this replaced: the Authorization line is not
# matched by the allow-list, so it never reaches the output to be redacted.
# The `sed` underneath stays as defence in depth and is now unreachable — which
# is the right shape, since a redaction is only as good as its pattern.
grep -qi 'authorization' "$work/out.txt" && s=1 || s=0
check r "no Authorization line reaches the output at all" "$s"
# The refusal names a Retry-After, so this is a limit and the step tries ONCE
# more after that wait plus the margin — and no more, whatever the second
# answer is. The stub refuses both times; two attempts, one sleep of 65.
[ "$(attempts)" -eq 2 ] && s=0 || s=1
check r "exactly two attempts were made ($(attempts))" "$s"
[ "$(cat "$work/sleeps.txt")" = "65" ] && s=0 || s=1
check r "it waited Retry-After + margin = 65 s (got '$(tr '\n' ' ' < "$work/sleeps.txt")')" "$s"
grep -q 'first attempt was rate limited' "$work/out.txt" && s=0 || s=1
check r "the diagnostic says the failure shown is the retry" "$s"

# ── scenario 2: the listing succeeds ─────────────────────────────────────────
# The trace holds the whole board listing on success, so it must be discarded
# UNREAD — printing it would put hundreds of items, and the request headers,
# into every green log.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  [ -n "\${GH_DEBUG:-}" ] && echo "Authorization: token $SECRET" >&2
  [ -n "\${GH_DEBUG:-}" ] && echo "< HTTP/2.0 200 OK" >&2
  echo "{\"items\":[{\"a\":1},{\"a\":2}],\"totalCount\":\${FAKE_TOTAL:-2}}"
  exit 0
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "successful listing:"
run_step && rc=0 || rc=$?
check s "the step succeeds" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
grep -q 'board items: 2 (totalCount 2)' "$work/out.txt" && s=0 || s=1
check s "the board count is reported" "$s"
grep -qE 'HTTP/2.0 200|request trace' "$work/out.txt" && s=1 || s=0
check s "the trace is NOT printed" "$s"
grep -qF "$SECRET" "$work/out.txt" && s=1 || s=0
check s "the token does NOT appear anywhere in the output" "$s"

# ── scenario 3: a paginated listing that fails on a LATER page ───────────────
# The shape the first two scenarios missed, and both round-2 findings lived in
# the gap. A GraphQL connection serves at most 100 items per page, so a board
# past 900 items is a dozen requests: when one fails, everything before it is
# successful pages and their bodies, and the trace is far larger than the cap.
#
# A prefix bound gets this exactly wrong twice over — it prints board contents
# and cuts off the 403 and its headers — and `head` closing the pipe hands
# `sed` a SIGPIPE that `pipefail` turns into an exit from the middle of the
# branch, so the group never closes and the rate-limit table never runs.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{"graphql":{"limit":5000,"remaining":5000}}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ -n "\${GH_DEBUG:-}" ]; then
    for page in \$(seq 1 12); do
      echo "> POST /graphql HTTP/1.1 (page \$page)" >&2
      echo "> Authorization: token $SECRET" >&2
      echo "< HTTP/2.0 200 OK" >&2
      # A page of board items: bulky, and the thing a prefix bound would show.
      for i in \$(seq 1 100); do
        echo "{\"id\":\"PVTI_page\${page}_item\${i}\",\"title\":\"BOARD_ITEM_BODY padding padding padding padding\"}" >&2
      done
    done
    cat >&2 <<'TRACE'
> POST /graphql HTTP/1.1 (page 13)
< HTTP/2.0 403 Forbidden
< Retry-After: 60
< X-Ratelimit-Remaining: 0
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}
TRACE
  fi
  echo "unknown owner type" >&2
  exit 1
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "paginated listing failing on a later page:"
run_step && rc=0 || rc=$?
check p "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
# The branch must RUN TO THE END. Under the prefix bound it died at the pipe
# and none of these three reached the log.
grep -q '403 Forbidden' "$work/out.txt" && s=0 || s=1
check p "the FAILED page's status survives" "$s"
grep -q 'X-Ratelimit-Remaining: 0' "$work/out.txt" && s=0 || s=1
check p "the failed page's rate-limit header survives" "$s"
grep -q 'secondary rate limit' "$work/out.txt" && s=0 || s=1
check p "the error body survives" "$s"
grep -q '::endgroup::' "$work/out.txt" && s=0 || s=1
check p "the log group is closed" "$s"
grep -q '"remaining":5000' "$work/out.txt" && s=0 || s=1
check p "the rate_limit table is still collected afterwards" "$s"
grep -q '::error::listing the board failed' "$work/out.txt" && s=0 || s=1
check p "the error annotation is still emitted" "$s"
# NONE. Not "not many" — the earlier version of this assertion accepted 228 of
# 1,200 card records reaching the log, and this repository is public while the
# board spans repositories and carries Drafts that exist nowhere else. Any byte
# window admits some; only an allow-list admits none (#2139 r3).
printed=$(grep -c 'BOARD_ITEM_BODY' "$work/out.txt" || true)
[ "$printed" -eq 0 ] && s=0 || s=1
check p "NO board item bodies reach the log ($printed of 1200)" "$s"
grep -qF "$SECRET" "$work/out.txt" && s=1 || s=0
check p "the token does NOT appear anywhere in the output" "$s"
# The limit is on the LAST page, behind eleven good ones — the parser must
# read the last response, not the first, or this never retries.
[ "$(attempts)" -eq 2 ] && s=0 || s=1
check p "the limit on the last page is still seen as one: two attempts ($(attempts))" "$s"

# ── scenario 4: a trace the filter does not recognise ────────────────────────
# The failure mode an allow-list introduces, and the reason it is safe anyway.
# If gh's debug format changes, nothing matches — and the group must SAY that
# rather than print an empty box, which would read as "nothing went wrong at
# the transport level". It must still not fall back to printing the trace: the
# trace is exactly what carries board contents.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ -n "\${GH_DEBUG:-}" ]; then
    echo "=== some future debug format nothing here knows ===" >&2
    echo "title: BOARD_ITEM_BODY a private card title" >&2
  fi
  echo "unknown owner type" >&2
  exit 1
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "unrecognised trace format:"
run_step && rc=0 || rc=$?
check u "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
grep -q 'no status line, rate-limit header or error message recognised' "$work/out.txt" && s=0 || s=1
check u "the group says it recognised nothing, rather than showing an empty box" "$s"
grep -q 'BOARD_ITEM_BODY' "$work/out.txt" && s=1 || s=0
check u "it does NOT fall back to printing the trace" "$s"
grep -q '::error::listing the board failed' "$work/out.txt" && s=0 || s=1
check u "the branch still runs to the end" "$s"
# An unreadable trace states no limit, so there is nothing to wait for and
# the step must not guess one: one attempt, no sleep.
[ "$(attempts)" -eq 1 ] && s=0 || s=1
check u "no retry is attempted on a trace that states no limit ($(attempts) attempt)" "$s"
[ ! -s "$work/sleeps.txt" ] && s=0 || s=1
check u "and nothing was waited for" "$s"

# ── scenario 5: the listing is truncated ─────────────────────────────────────
# This guard sits AFTER the call, so restructuring the call is exactly the edit
# that drops it silently. It is here to notice that.
#
# ITS OWN STUB, deliberately. This scenario used to inherit whichever stub ran
# last, and inserting a scenario above it handed it a `gh` that always fails —
# so it stopped exercising truncation at all and said so only because the
# assertion happened to be specific. A scenario that depends on the order of
# the ones before it is a scenario that can be made vacuous by an edit
# somewhere else.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  echo "{\"items\":[{\"a\":1},{\"a\":2}],\"totalCount\":\${FAKE_TOTAL:-2}}"
  exit 0
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "truncated listing:"
run_step FAKE_TOTAL=970 && rc=0 || rc=$?
check t "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
grep -q 'raise LIST_LIMIT' "$work/out.txt" && s=0 || s=1
check t "the truncation error names the remedy" "$s"

# ── scenario 6: rate limited, then the bucket refills ────────────────────────
# The case the retry exists for, in the exact shape run 34673730486 recorded:
# HTTP 200 — GraphQL puts the error in the body — with the request's own
# headers saying `Remaining: 0` and naming a reset a few seconds out. The
# first call is refused, the second (after the reset) succeeds, and the step
# must come out GREEN with the board counted.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{"graphql":{"limit":5000,"remaining":5000}}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ "\$(grep -c item-list "\$(dirname "\$0")/../calls.txt")" -eq 1 ]; then
    if [ -n "\${GH_DEBUG:-}" ]; then
      echo "> POST /graphql HTTP/1.1" >&2
      echo "< HTTP/2.0 200 OK" >&2
      echo "< X-Ratelimit-Remaining: 0" >&2
      echo "< X-Ratelimit-Reset: \$(( \$(date -u +%s) + 10 ))" >&2
      echo "< X-Ratelimit-Resource: graphql" >&2
      echo '{"message":"API rate limit already exceeded for user ID 275282153."}' >&2
    fi
    echo "unknown owner type" >&2
    exit 1
  fi
  echo '{"items":[{"a":1},{"a":2},{"a":3}],"totalCount":3}'
  exit 0
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "rate limited, then refilled:"
run_step && rc=0 || rc=$?
check w "the step SUCCEEDS" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
[ "$(attempts)" -eq 2 ] && s=0 || s=1
check w "two attempts ($(attempts))" "$s"
# The reset was ten seconds out at the time the stub wrote it; by the time the
# step did the subtraction a second may have ticked. Margin is 5 on top.
slept=$(cat "$work/sleeps.txt")
{ [ "$slept" = "15" ] || [ "$slept" = "14" ]; } && s=0 || s=1
check w "it waited until the reset the FAILED REQUEST named, plus margin (got '$slept')" "$s"
grep -q '::warning::board listing was rate limited' "$work/out.txt" && s=0 || s=1
check w "the wait is announced, with the reason, as a warning" "$s"
grep -q 'succeeded on the retry' "$work/out.txt" && s=0 || s=1
check w "the log says the retry is what succeeded" "$s"
grep -q 'board items: 3 (totalCount 3)' "$work/out.txt" && s=0 || s=1
check w "the board count comes from the successful attempt" "$s"
grep -q '::error::' "$work/out.txt" && s=1 || s=0
check w "no error annotation is left behind by the first attempt" "$s"
grep -q '::group::gh project item-list' "$work/out.txt" && s=1 || s=0
check w "the failure diagnostic is NOT printed for a run that recovered" "$s"

# ── scenario 7: rate limited, reset further away than the cap ───────────────
# Same refusal, but the reset is an hour out. The job says so and stops: a
# sweep is six-hourly, and a runner parked for an hour is not a fix.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{"graphql":{"limit":5000,"remaining":5000}}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ -n "\${GH_DEBUG:-}" ]; then
    echo "< HTTP/2.0 200 OK" >&2
    echo "< X-Ratelimit-Remaining: 0" >&2
    echo "< X-Ratelimit-Reset: \$(( \$(date -u +%s) + 3600 ))" >&2
    echo '{"message":"API rate limit already exceeded for user ID 275282153."}' >&2
  fi
  echo "unknown owner type" >&2
  exit 1
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "rate limited, reset beyond the cap:"
run_step && rc=0 || rc=$?
check c "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
[ "$(attempts)" -eq 1 ] && s=0 || s=1
check c "one attempt only ($(attempts))" "$s"
[ ! -s "$work/sleeps.txt" ] && s=0 || s=1
check c "nothing was waited for" "$s"
grep -q 'over RETRY_WAIT_CAP_SECONDS=900, so NOT retried' "$work/out.txt" && s=0 || s=1
check c "the log names the cap and says the wait was not taken" "$s"
grep -q 'X-Ratelimit-Remaining: 0' "$work/out.txt" && s=0 || s=1
check c "the failed request's evidence is still printed" "$s"

# ── scenario 7b: the reset is inside the cap, the margin takes it over ───────
# The cap bounds the whole stand-still. A reset 897 s out passes a naive
# `wait <= cap` check and then sleeps 902 s once the margin is added — which
# is the configured bound not being enforced (#2149 r1). Compare the total.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{"graphql":{"limit":5000,"remaining":5000}}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ -n "\${GH_DEBUG:-}" ]; then
    echo "< HTTP/2.0 200 OK" >&2
    echo "< X-Ratelimit-Remaining: 0" >&2
    echo "< X-Ratelimit-Reset: \$(( \$(date -u +%s) + 897 ))" >&2
    echo '{"message":"API rate limit already exceeded for user ID 275282153."}' >&2
  fi
  echo "unknown owner type" >&2
  exit 1
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "rate limited, reset inside the cap but margin over it:"
run_step && rc=0 || rc=$?
check m "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
[ "$(attempts)" -eq 1 ] && s=0 || s=1
check m "one attempt only ($(attempts))" "$s"
[ ! -s "$work/sleeps.txt" ] && s=0 || s=1
check m "nothing was waited for (got '$(tr '\n' ' ' < "$work/sleeps.txt")')" "$s"
grep -qE 'the wait would be (901|902)s, over RETRY_WAIT_CAP_SECONDS=900' "$work/out.txt" && s=0 || s=1
check m "the log states the TOTAL wait, margin included, against the cap" "$s"

# ── scenario 8: rate limited, waited, rate limited again ────────────────────
# ONE retry, not a loop. If the bucket is empty again after its own reset,
# something else is draining it faster than it refills, and a third attempt
# is how a bounded wait becomes an unbounded one.
cat > "$work/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\$1" = "api" ] && [ "\$2" = "rate_limit" ]; then
  if [ "\$3" = "--jq" ]; then echo 5000; exit 0; fi
  echo '{"resources":{"graphql":{"limit":5000,"remaining":5000}}}'; exit 0
fi
if [ "\$1" = "project" ] && [ "\$2" = "item-list" ]; then
  echo item-list >> "\$(dirname "\$0")/../calls.txt"
  if [ -n "\${GH_DEBUG:-}" ]; then
    echo "< HTTP/2.0 200 OK" >&2
    echo "< X-Ratelimit-Remaining: 0" >&2
    echo "< X-Ratelimit-Reset: \$(( \$(date -u +%s) + 3 ))" >&2
    echo '{"message":"API rate limit already exceeded for user ID 275282153."}' >&2
  fi
  echo "unknown owner type" >&2
  exit 1
fi
exit 0
SH
chmod +x "$work/bin/gh"

echo "rate limited twice:"
run_step && rc=0 || rc=$?
check a "the step fails" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
[ "$(attempts)" -eq 2 ] && s=0 || s=1
check a "exactly two attempts — the second refusal is NOT retried ($(attempts))" "$s"
[ "$(wc -l < "$work/sleeps.txt" | tr -d ' ')" -eq 1 ] && s=0 || s=1
check a "one wait, not two" "$s"
grep -q 'this is the retry after' "$work/out.txt" && s=0 || s=1
check a "the diagnostic says the evidence shown is the retry's" "$s"
grep -q '::error::listing the board failed' "$work/out.txt" && s=0 || s=1
check a "the error annotation is emitted" "$s"

if [ "$fail" -ne 0 ]; then
  echo "board-reconcile list-step fixtures: FAILED" >&2
  exit 1
fi
echo "board-reconcile list-step fixtures: all passed"
