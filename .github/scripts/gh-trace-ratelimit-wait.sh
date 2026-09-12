#!/usr/bin/env bash
# Read a `GH_DEBUG=api` trace and say whether the LAST response in it was a
# rate limit — and if so, how long to wait before the same request would be
# worth repeating.
#
#   bash .github/scripts/gh-trace-ratelimit-wait.sh <trace-file>
#     stdout : "<seconds>\t<reason>"   (only when the trace shows a limit)
#     exit 0 : the last response matched a supported rate-limit shape; stdout
#              says how long to wait
#     exit 1 : no supported rate-limit shape was recognised. That is ALL it
#              says — not that a retry would be pointless. A 503 with
#              Retry-After exits 1 and might well succeed on a retry; this
#              script only refuses to call it a rate limit.
#     exit 2 : no response could be read from the trace at all
#
#   bash .github/scripts/gh-trace-ratelimit-wait.sh --selftest
#
# WHY A PARSER AND NOT A SLEEP. `/rate_limit` does not report the bucket a
# GraphQL request is metered against: on run 34673730486 the failed request's
# own headers said `X-Ratelimit-Remaining: 0` / `X-Ratelimit-Used: 5000` while
# `/rate_limit`, read 200 ms later, said 5000 remaining (#2129). The only
# trustworthy evidence is the FAILED RESPONSE itself — its status, headers
# and body — and gh surfaces that only through its debug trace. So the
# decision to wait is read from there and never from `/rate_limit`. The
# LENGTH of the wait is read from a header where one names it, and is a
# fixed local default (`MESSAGE_ONLY_WAIT`) where the response states a
# limit but no header names a wait; the reason string says which.
#
# WHY THE LAST RESPONSE. A paginated listing writes one response per page into
# the trace; the failure is the last one. Each response carries the full header
# set, so the last occurrence of each header belongs to the last response.
#
# WHAT COUNTS AS A LIMIT is stated ONCE, in the comment block headed "TWO
# SHAPES" directly above the code that applies it, and pinned by the
# self-test cases beneath. It is deliberately not repeated here: this header
# used to carry a second copy, and the two drifted apart (#2149 r7).
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

  # The status line is the first line of the last response — taken by
  # parameter expansion, NOT by piping the response through `head -n 1`:
  # with a body larger than the pipe buffer, `head` exits after one line
  # while `printf` is still writing, `pipefail` turns the SIGPIPE into 141,
  # and `set -e` ends the analysis with no verdict — on exactly the large
  # GraphQL responses a limited listing can carry (#2149 r4).
  local status_line status
  status_line=${last%%$'\n'*}
  status=$(printf '%s\n' "$status_line" | sed -E 's/^[[:space:]]*<?[[:space:]]*HTTP\/[0-9.]+[[:space:]]+([0-9]{3}).*/\1/')

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
  #               `Retry-After` or a body saying "secondary rate limit". When
  #               the primary headers beside it show a bucket that is NOT
  #               exhausted, they describe something that is not the problem
  #               and are not used for the wait. When they show `Remaining:
  #               0`, BOTH shapes match, and the overlap rule below applies:
  #               the longer of the two waits.
  #
  # Anything else — a 503 with `Retry-After`, a 401, a body mentioning a
  # limit on a status that is neither 403 nor 429 — matches no supported
  # shape and exits 1, which says exactly that and nothing about whether a
  # retry would help (see the exit-code contract at the top). A 503 is the
  # nameable miss: transient, and a retry might well succeed, but calling it
  # a rate limit is precisely the misdiagnosis the trace evidence exists to
  # prevent.
  # Each shape that matches contributes its own wait; when both match — a
  # 403/429 whose bucket is spent AND which carries Retry-After — the retry
  # has to outlast BOTH, so the longer wait is the wait (#2149 r3). Giving
  # either shape precedence would retry while the other limit still holds.
  local primary_wait='' primary_reason='' secondary_wait='' secondary_reason=''
  # Header values are validated as decimal digits and normalised through
  # `10#` before use or output: a zero-padded `Retry-After: 08` passes an
  # `-eq` self-comparison and then blows up as octal in the caller's
  # arithmetic — "value too great for base" — leaving the step with neither
  # its retry nor its diagnostic (#2149 r11).
  if [ "${remaining:-}" = "0" ]; then
    if [[ "${reset:-}" =~ ^[0-9]+$ ]]; then
      reset=$(( 10#$reset ))
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
    if [[ "${retry:-}" =~ ^[0-9]+$ ]]; then
      secondary_wait=$(( 10#$retry ))
      secondary_reason="secondary limit — retry-after $secondary_wait s"
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
      # Name the secondary wait it beat as what it actually was — a
      # Retry-After reading or the default — never as a header that may not
      # have existed (#2149 r9).
      reason="both limits — $primary_reason (not shorter than the secondary wait: $secondary_reason)"
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
  expect() { # expect <label> <trace-text> <now> <exit> [<seconds> [<reason-substring>]]
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
    # The reason string is operator-facing evidence, so what it CLAIMS is
    # part of the contract: a case may pin a phrase it must carry.
    if [ "$#" -ge 6 ]; then
      case "${out#*	}" in
        *"$6"*) check "$1: reason says '$6'" 0 ;;
        *)      check "$1: reason says '$6' (got '${out#*	}')" 1 ;;
      esac
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
  # Both shapes, but the secondary side is body-only: the reset wins over a
  # DEFAULT, and the reason must say it beat a default — not a Retry-After
  # that was never there (#2149 r9).
  expect "both limits, secondary side body-only — the reset, and the reason names the default" \
'< HTTP/2.0 403 Forbidden
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' \
    1789188167 0 360 'default wait'

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

  # A refusal that matches no supported shape: exit 1, and nothing more is
  # claimed about it.
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

  # ZERO-PADDED HEADER VALUES (#2149 r11). `Retry-After: 08` passes an `-eq`
  # self-comparison and is then octal in the caller's `$(( ))` — "value too
  # great for base". The wait must come out as a plain decimal, and the
  # reason must carry the normalised number, not the literal.
  expect "zero-padded Retry-After is normalised to decimal" \
'< HTTP/2.0 429 Too Many Requests
< Retry-After: 08' \
    1789188167 0 8 'retry-after 8 s'
  expect "zero-padded X-Ratelimit-Reset is normalised too" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 01789188527' \
    1789188167 0 360
  # A Retry-After that is not a number at all (the HTTP-date form is legal)
  # still marks the secondary shape, but names no usable wait: the default.
  expect "non-numeric Retry-After falls back to the default, not to arithmetic" \
'< HTTP/2.0 429 Too Many Requests
< Retry-After: Sat, 12 Sep 2026 05:00:00 GMT' \
    1789188167 0 "$MESSAGE_ONLY_WAIT" 'default wait'

  # A LARGE BODY ON THE LIMITED RESPONSE (#2149 r4). A limited GraphQL page
  # can still carry data, and a body past the pipe buffer is where a
  # `head -n 1` reading the status line exits early, `pipefail` reports 141
  # and `set -e` ends the analysis with no verdict. 200 KB, well past any
  # pipe buffer; the verdict must be the same as for a small one.
  local big
  big=$(head -c 200000 /dev/zero | tr '\0' 'x')
  expect "a 200 KB body on the limited response still yields a verdict" \
"< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527
{\"data\":{\"padding\":\"$big\"},\"message\":\"API rate limit already exceeded for user ID 275282153.\"}" \
    1789188167 0 360

  if [ "$fail" -ne 0 ]; then echo "gh-trace-ratelimit-wait selftest: FAILED" >&2; return 1; fi
  echo "gh-trace-ratelimit-wait selftest: all passed"
}

case "${1:-}" in
  --selftest) selftest ;;
  '') echo "usage: $0 <trace-file> | --selftest" >&2; exit 64 ;;
  *) analyse "$1" "$(date -u +%s)" ;;
esac
