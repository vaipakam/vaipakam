#!/usr/bin/env bash
# Read a `GH_DEBUG=api` trace and say whether the LAST response in it was a
# rate limit — and if so, how long to wait before the same request would be
# worth repeating.
#
#   bash .github/scripts/gh-trace-ratelimit-wait.sh <trace-file>
#     stdout : "<seconds>\t<reason>"   (only when the trace shows a limit)
#     exit 0 : the last response was rate limited; stdout says how long to wait
#     exit 1 : it was not — whatever failed, waiting will not fix it
#     exit 2 : no response could be read from the trace at all
#
#   bash .github/scripts/gh-trace-ratelimit-wait.sh --selftest
#
# WHY A PARSER AND NOT A SLEEP. `/rate_limit` does not report the bucket a
# GraphQL request is metered against: on run 34673730486 the failed request's
# own headers said `X-Ratelimit-Remaining: 0` / `X-Ratelimit-Used: 5000` while
# `/rate_limit`, read 200 ms later, said 5000 remaining (#2129). The only
# trustworthy statement of the limit is the FAILED REQUEST's own headers, and
# gh surfaces those only through its debug trace. So the decision to wait, and
# the length of the wait, are read from there and from nowhere else.
#
# WHY THE LAST RESPONSE. A paginated listing writes one response per page into
# the trace; the failure is the last one. Each response carries the full header
# set, so the last occurrence of each header belongs to the last response.
#
# WHAT COUNTS AS A LIMIT — exactly the two forms this account has received,
# and nothing looser (the rule is spelled out where it is applied, below):
#   - the PRIMARY form: `X-Ratelimit-Remaining: 0`, with `X-Ratelimit-Reset`
#     giving the epoch second the bucket refills. HTTP status is 200 for
#     GraphQL (the error is in the body), 403 for REST.
#   - the SECONDARY form: HTTP 403 or 429 with `Retry-After`, or with a body
#     that says "secondary rate limit". It does NOT show in `/rate_limit`
#     at all (docs/internal/ProjectProcedures.md §3.3).
# A response missing the header that would name its wait gets a fixed
# default, and the reason string says the wait is a default, not a reading.
#
# The wait this prints is NOT capped here. How long a job is willing to stand
# still is the job's decision, and it is made where the job can say so.
set -euo pipefail

# Seconds to wait when the trace says "rate limited" but carries neither a
# reset instant nor a retry-after — the floor GitHub's own guidance gives for
# a secondary limit.
MESSAGE_ONLY_WAIT=60

# Where the trace formats its lines: gh prefixes response headers with `< `
# and echoes the JSON body verbatim. Both prefixes are optional here, so a
# trace that dropped them (or a fixture that never had them) still parses.
last_header() { # last_header <header-name-lowercase>  (the response text on stdin)
  # An absent header is an empty answer, not a failure: under `pipefail` a
  # grep with no match fails the pipeline, and a `var=$(...)` of a failing
  # pipeline is fatal under `set -e` — which is how the first version of this
  # returned 1 on every trace that lacked `Retry-After`, while its own
  # self-test, running under `set +e`, kept passing.
  { grep -aiE "^[[:space:]]*<?[[:space:]]*$1:" || true; } | tail -n 1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+$//'
}

analyse() { # analyse <trace> <now-epoch>  -> prints "<seconds>\t<reason>", exit as documented
  local trace=$1 now=$2
  # Cut the trace down to the LAST response — everything from its status
  # line on. Reading "the last occurrence of each header" over the whole
  # trace would be almost the same thing, but not quite: a body message
  # belongs to one response, and a limited page followed by a good one
  # would otherwise be judged by the earlier page's message.
  local last_status
  last_status=$({ grep -aniE '^[[:space:]]*<?[[:space:]]*HTTP/' "$trace" || true; } | tail -n 1 | cut -d: -f1)
  [ -n "${last_status:-}" ] || return 2
  local last
  last=$(tail -n "+$last_status" "$trace")
  local remaining reset retry message
  remaining=$(printf '%s\n' "$last" | last_header 'x-ratelimit-remaining')
  reset=$(printf '%s\n' "$last" | last_header 'x-ratelimit-reset')
  retry=$(printf '%s\n' "$last" | last_header 'retry-after')
  message=$(printf '%s\n' "$last" \
    | grep -aoE '"message"[[:space:]]*:[[:space:]]*"[^"]{0,300}"' | tail -n 1 || true)

  local status
  status=$(printf '%s\n' "$last" | head -n 1 | sed -E 's/^[[:space:]]*<?[[:space:]]*HTTP\/[0-9.]+[[:space:]]+([0-9]{3}).*/\1/')

  # TWO SHAPES, AND ONLY THESE TWO. The first version of this treated each
  # signal on its own as proof of a limit — a `Retry-After` alone, a body
  # that mentioned "rate limit" alone — and a reviewer found in one round
  # what that admits: a 503 with `Retry-After` read as a limit, and a
  # secondary-limit body next to a healthy primary bucket read as "remaining
  # 0" with the wrong reset (#2149 r2). Adding conditions one at a time is
  # the unbounded road; the bounded rule is the two documented shapes.
  #
  #   PRIMARY   — the bucket is spent: `X-Ratelimit-Remaining: 0`. GraphQL
  #               answers 200 with the error in the body, REST answers 403,
  #               so the status is not part of this shape. The wait is the
  #               time to `X-Ratelimit-Reset`, which belongs to THIS bucket
  #               precisely because remaining is 0.
  #   SECONDARY — an abuse-detection refusal: status 403 or 429 AND either
  #               `Retry-After` or a body saying "secondary rate limit". The
  #               primary headers on such a response describe a bucket that
  #               is NOT the problem, so they are never used for the wait.
  #
  # Anything else — a 503 with `Retry-After`, a 401, a body mentioning a
  # limit on a status that is neither 403 nor 429 — is not a limit, and a
  # wait would not repair it. A 503 is the nameable miss: transient, and a
  # retry might well succeed, but calling it a rate limit is precisely the
  # misdiagnosis the trace evidence exists to prevent.
  # Each shape that matches contributes its own wait; when both match — a
  # 403/429 whose bucket is spent AND which carries Retry-After — the retry
  # has to outlast BOTH, so the longer wait is the wait (#2149 r3). Giving
  # either shape precedence would retry while the other limit still holds.
  local primary_wait='' primary_reason='' secondary_wait='' secondary_reason=''
  if [ "${remaining:-}" = "0" ]; then
    if [ -n "${reset:-}" ] && [ "$reset" -eq "$reset" ] 2>/dev/null; then
      primary_wait=$(( reset - now ))
      [ "$primary_wait" -lt 0 ] && primary_wait=0
      primary_reason="primary limit — remaining 0, reset at $(date -u -d "@$reset" +%Y-%m-%dT%H:%M:%SZ)"
    else
      primary_wait=$MESSAGE_ONLY_WAIT
      primary_reason="primary limit — remaining 0 but no reset header — default wait"
    fi
  fi
  if { [ "$status" = "403" ] || [ "$status" = "429" ]; } \
     && { [ -n "${retry:-}" ] || printf '%s' "$message" | grep -qi 'secondary rate limit'; }; then
    if [ -n "${retry:-}" ] && [ "$retry" -eq "$retry" ] 2>/dev/null; then
      secondary_wait=$retry
      secondary_reason="secondary limit — retry-after $retry s"
    else
      secondary_wait=$MESSAGE_ONLY_WAIT
      secondary_reason="secondary limit stated in the body only, no retry-after — default wait"
    fi
  fi

  local wait reason
  if [ -n "$primary_wait" ] && [ -n "$secondary_wait" ]; then
    if [ "$secondary_wait" -gt "$primary_wait" ]; then
      wait=$secondary_wait
      reason="both limits — $secondary_reason (longer than the primary reset)"
    else
      wait=$primary_wait
      reason="both limits — $primary_reason (not shorter than retry-after)"
    fi
  elif [ -n "$primary_wait" ]; then
    wait=$primary_wait; reason=$primary_reason
  elif [ -n "$secondary_wait" ]; then
    wait=$secondary_wait; reason=$secondary_reason
  else
    return 1
  fi
  printf '%s\t%s\n' "$wait" "$reason"
}

# ── self-test ────────────────────────────────────────────────────────────────
selftest() {
  local work fail=0
  work=$(mktemp -d)
  trap 'rm -rf "$work"' RETURN

  check() { # check <description> <0|1>
    if [ "$2" -eq 0 ]; then printf '  ok    %s\n' "$1"
    else printf '  FAIL  %s\n' "$1" >&2; fail=1; fi
  }
  expect() { # expect <label> <trace-text> <now> <exit> [<seconds>]
    local out rc
    printf '%s\n' "$2" > "$work/t.txt"
    # UNDER `set -e`, as the step runs it. The first version of this harness
    # ran `analyse` with errexit off, and passed while the same function
    # returned 1 on every real trace — an absent header tripped errexit
    # inside a command substitution the harness never had on.
    set +e; out=$( (set -e; analyse "$work/t.txt" "$3") ); rc=$?; set -e
    check "$1: exit $4" "$([ "$rc" -eq "$4" ] && echo 0 || echo 1)"
    if [ "$#" -ge 5 ]; then
      check "$1: waits $5 s (got '${out%%	*}')" "$([ "${out%%	*}" = "$5" ] && echo 0 || echo 1)"
    fi
  }

  # The shape from run 34673730486: 200, remaining 0, a reset six minutes out.
  expect "primary limit on GraphQL (HTTP 200, headers say 0)" \
'> POST /graphql HTTP/1.1
< HTTP/2.0 200 OK
< X-Ratelimit-Limit: 5000
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527
< X-Ratelimit-Resource: graphql
{"message":"API rate limit already exceeded for user ID 275282153."}' \
    1789188167 0 360

  # A reset already in the past is a wait of zero, never a negative one.
  expect "reset already passed" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527' \
    1789188999 0 0

  # Secondary form: the wait is Retry-After, and the primary headers beside it
  # (a healthy bucket, a reset an hour out) are not consulted.
  expect "secondary limit (Retry-After)" \
'< HTTP/2.0 403 Forbidden
< Retry-After: 60
< X-Ratelimit-Remaining: 4998
< X-Ratelimit-Reset: 1789191767
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' \
    1789188167 0 60

  # BOTH SHAPES AT ONCE — the bucket is spent AND Retry-After is present on a
  # 403. The retry has to outlast both, so the longer wait wins, whichever
  # side it is on (#2149 r3).
  expect "both limits, reset further out than Retry-After — the reset" \
'< HTTP/2.0 403 Forbidden
< Retry-After: 60
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527' \
    1789188167 0 360
  expect "both limits, Retry-After further out than the reset — Retry-After" \
'< HTTP/2.0 429 Too Many Requests
< Retry-After: 600
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527' \
    1789188167 0 600

  # A secondary refusal with no Retry-After: the body is the only statement of
  # it, and the wait is the documented default.
  expect "secondary limit stated in the body only" \
'< HTTP/2.0 403 Forbidden
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' \
    1789188167 0 "$MESSAGE_ONLY_WAIT"

  # THE SECONDARY SHAPE NEXT TO A HEALTHY PRIMARY BUCKET (#2149 r2). The
  # primary headers are present and say 4,999 remaining with a reset an hour
  # out; they describe a bucket that is not the problem. The wait is the
  # secondary default, not the primary reset — and remaining is not 0.
  expect "secondary body beside healthy primary headers" \
'< HTTP/2.0 403 Forbidden
< X-Ratelimit-Limit: 5000
< X-Ratelimit-Remaining: 4999
< X-Ratelimit-Reset: 1789191767
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' \
    1789188167 0 "$MESSAGE_ONLY_WAIT"

  expect "429 with Retry-After" \
'< HTTP/2.0 429 Too Many Requests
< Retry-After: 30
< X-Ratelimit-Remaining: 4990' \
    1789188167 0 30

  # `Retry-After` is also how a 503 says "come back later". That is not a
  # rate limit, and calling it one is the misdiagnosis this exists to end —
  # the nameable miss: a retry might well have helped.
  expect "503 with Retry-After is NOT a limit" \
'< HTTP/2.0 503 Service Unavailable
< Retry-After: 120
{"message":"Service unavailable"}' \
    1789188167 1

  # A primary-form message on a status that is neither 403 nor 429, with the
  # bucket not spent: no shape matches.
  expect "a limit-shaped body on a 200 with remaining > 0 is NOT a limit" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 12
{"message":"API rate limit exceeded for user ID 275282153."}' \
    1789188167 1

  # Paginated: eleven good pages, then the limited one. The LAST headers win.
  local pages='' p
  for p in 1 2 3 4 5 6 7 8 9 10 11; do
    pages+="> POST /graphql HTTP/1.1 (page $p)
< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: $((5000 - p))
< X-Ratelimit-Reset: 1789190000
{\"data\":{\"items\":[]}}
"
  done
  expect "paginated, limited on the last page" \
"${pages}> POST /graphql HTTP/1.1 (page 12)
< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527
{\"message\":\"API rate limit already exceeded for user ID 275282153.\"}" \
    1789188167 0 360

  # The opposite order: limited early, fine later — NOT limited now.
  expect "an earlier limited page followed by a good one" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527
{"message":"API rate limit already exceeded for user ID 275282153."}
< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 4999
{"data":{"items":[]}}' \
    1789188167 1

  # A refusal that is not a limit: waiting would not help, so say so.
  expect "a 401 is not a limit" \
'< HTTP/2.0 401 Unauthorized
< X-Ratelimit-Remaining: 4998
{"message":"Bad credentials"}' \
    1789188167 1

  expect "an unreadable trace" \
'=== some future debug format nothing here knows ===' \
    1789188167 2

  # Header names are matched case-insensitively — gh has spelled them both ways.
  expect "lower-case header names" \
'< HTTP/2.0 403 Forbidden
< retry-after: 30' \
    1789188167 0 30

  if [ "$fail" -ne 0 ]; then echo "gh-trace-ratelimit-wait selftest: FAILED" >&2; return 1; fi
  echo "gh-trace-ratelimit-wait selftest: all passed"
}

case "${1:-}" in
  --selftest) selftest ;;
  '') echo "usage: $0 <trace-file> | --selftest" >&2; exit 64 ;;
  *) analyse "$1" "$(date -u +%s)" ;;
esac
