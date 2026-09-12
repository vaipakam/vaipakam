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
  set +e
  ( cd "$work"
    export PATH="$work/bin:$PATH" PROJECT_NUMBER=1 PROJECT_OWNER=vaipakam LIST_LIMIT=4000 "$@"
    bash "$work/step.sh" ) > "$work/out.txt" 2>&1
  rc=$?
  set -e
  return $rc
}

mkdir -p "$work/bin"
SECRET='ghp_SuperSecretTokenValue1234567890'

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

if [ "$fail" -ne 0 ]; then
  echo "board-reconcile list-step fixtures: FAILED" >&2
  exit 1
fi
echo "board-reconcile list-step fixtures: all passed"
