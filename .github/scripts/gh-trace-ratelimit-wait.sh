#!/usr/bin/env bash
# Read a `GH_DEBUG=api` trace and say whether the LAST response in it is the
# one rate-limit shape this account has ever been observed to hit on the
# board listing — and if so, how long to wait before the same request would
# be worth repeating.
#
#   bash .github/scripts/gh-trace-ratelimit-wait.sh <trace-file>
#     stdout : "<seconds>\t<reason>"   (only when the shape matched)
#     exit 0 : the last response matched the supported shape; stdout says how
#              long to wait
#     exit 1 : it did not. That is ALL it says — not that a retry would be
#              pointless, and not that the response was no kind of limit.
#              The misses this accepts are named at the rule, below.
#     exit 2 : no response could be read from the trace at all
#
#   bash .github/scripts/gh-trace-ratelimit-wait.sh --selftest
#
# WHY A PARSER AND NOT A SLEEP. `/rate_limit` does not report the bucket a
# GraphQL request is metered against: on run 34673730486 the failed request's
# own headers said `X-Ratelimit-Remaining: 0` / `X-Ratelimit-Used: 5000` while
# `/rate_limit`, read 200 ms later, said 5000 remaining (#2129). The only
# trustworthy evidence is the FAILED RESPONSE itself, and gh surfaces that
# only through its debug trace. So the decision to wait, and the length of
# the wait, are read from there and never from `/rate_limit`.
#
# WHY THE LAST RESPONSE. A paginated listing writes one response per page into
# the trace; the failure is the last one. Each response carries the full header
# set, so the last occurrence of each header belongs to the last response.
#
# WHAT COUNTS AS A LIMIT is stated ONCE, in the comment block headed "THE ONE
# SHAPE" directly above the code that applies it, and pinned by the self-test
# cases beneath. It is deliberately not repeated here (#2149 r7).
#
# The wait this prints is bounded by MAX_WAIT (below) and NOT otherwise
# capped here. How long a job is willing to stand still is the job's
# decision, and it is made where the job can say so.
set -euo pipefail

# The largest wait this script will ever print — one day. A header value is
# an untrusted string, and the list of what one can contain does not end
# (#2149 r11–r13: zero padding, values near the 64-bit limit, exact-bound
# values). So the OUTPUT is bounded instead of the input being enumerated:
# every number is read by one normaliser, every wait passes one clamp, and a
# clamp that bit says so in the reason. The caller's own cap then refuses it.
MAX_WAIT=86400

# header_int <value> — the one normaliser for a numeric header. Prints the
# value as a plain decimal and returns 0, or prints nothing and returns 1 if
# it is not a run of digits (surrounding whitespace ignored). Leading zeros
# are dropped FIRST, so `0000000000000001` is 1 and a padded `0` is 0; only
# THEN is the length bounded — a run of more than fifteen significant digits
# is a number larger than any sane header and is represented by a
# fifteen-digit ceiling, which is what makes `10#` safe (fifteen digits
# cannot overflow) and lets clamp_wait treat it like any oversized wait.
header_int() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}; v=${v%"${v##*[![:space:]]}"}
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  v=${v#"${v%%[!0]*}"}
  [ -n "$v" ] || v=0
  if [ "${#v}" -gt 15 ]; then printf '%s' 999999999999999; return 0; fi
  printf '%s' "$(( 10#$v ))"
}

# clamp_wait <seconds> — prints "<seconds> <clamped>" where <clamped> is 1
# if the bound was applied and 0 if the value came through unchanged. The
# flag is tracked, not inferred from the output: a wait of exactly MAX_WAIT
# was not clamped and must not be reported as if it were (#2149 r13).
clamp_wait() {
  local w=$1 c=0
  if [ "$w" -lt 0 ]; then w=0; c=1; fi
  if [ "$w" -gt "$MAX_WAIT" ]; then w=$MAX_WAIT; c=1; fi
  printf '%s %s' "$w" "$c"
}

# Where the trace formats its lines: gh prefixes response headers with `< `
# and echoes the JSON body verbatim. Both prefixes are optional here, so a
# trace that dropped them (or a fixture that never had them) still parses.
last_header() { # last_header <header-name-lowercase>  (the response text on stdin)
  # An absent header is an empty answer, not a failure: under `pipefail` a
  # grep with no match fails the pipeline, and a `var=$(...)` of a failing
  # pipeline is fatal under `set -e` — which is how the first version of this
  # returned 1 on every trace that lacked a header, while its own self-test,
  # running under `set +e`, kept passing.
  { grep -aiE "^[[:space:]]*<?[[:space:]]*$1:" || true; } | tail -n 1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+$//'
}

analyse() { # analyse <trace> <now-epoch>  -> prints "<seconds>\t<reason>", exit as documented
  local trace=$1 now=$2
  # Cut the trace down to the LAST response — everything from its status
  # line on. Reading "the last occurrence of each header" over the whole
  # trace would be almost the same thing, but not quite: a limited page
  # followed by a good one must be judged by the good one.
  local last_status
  last_status=$({ grep -aniE '^[[:space:]]*<?[[:space:]]*HTTP/' "$trace" || true; } | tail -n 1 | cut -d: -f1)
  [ -n "${last_status:-}" ] || return 2
  local last
  last=$(tail -n "+$last_status" "$trace")
  local remaining reset retry
  remaining=$(printf '%s\n' "$last" | last_header 'x-ratelimit-remaining')
  reset=$(printf '%s\n' "$last" | last_header 'x-ratelimit-reset')
  retry=$(printf '%s\n' "$last" | last_header 'retry-after')

  # THE ONE SHAPE. This script recognises exactly the shape the board listing
  # has been observed to fail with — twice, on 2026-09-12, both times the
  # same (#2129, #2134) — and nothing else:
  #
  #   the bucket is spent: `X-Ratelimit-Remaining` is 0, and
  #   `X-Ratelimit-Reset` names the epoch second it refills.
  #
  # GraphQL answers this with HTTP 200 and the error in the body, REST with
  # 403, so the status is not part of the shape. The wait is the time to the
  # reset, which belongs to THIS bucket precisely because remaining is 0.
  #
  # An earlier version also recognised a SECONDARY shape — 403/429 with
  # `Retry-After` or an abuse-detection body — and eleven review rounds of
  # edges followed: which header wins when both appear, a `Retry-After`
  # that is a date, a body with no header, a default that was a guess
  # presented as a reading. None of it was ever observed on this listing.
  # It is deleted, and these are the NAMED MISSES, accepted on purpose:
  #
  #   - a secondary limit (403/429 with `Retry-After` or a "secondary rate
  #     limit" body) is NOT retried; it exits 1 and the diagnostic shows its
  #     headers, so an operator sees exactly what it was;
  #   - a spent bucket whose reset header is missing or unreadable is NOT
  #     retried either — a wait with no stated length would be a guess;
  #   - a 503 with `Retry-After`, a 401, anything else: exit 1, which says
  #     only that the shape did not match.
  #
  # NUMBERS. Both headers are read through `header_int` and the wait through
  # `clamp_wait`; a `Retry-After` beside the shape is reported as present and
  # unused, never parsed.
  local remaining_n reset_n
  remaining_n=$(header_int "${remaining:-}") || return 1
  [ "$remaining_n" = "0" ] || return 1
  reset_n=$(header_int "${reset:-}") || return 1

  local wait clamped
  read -r wait clamped <<<"$(clamp_wait $(( reset_n - now )))"
  local reason="remaining 0, reset at $(date -u -d "@$reset_n" +%Y-%m-%dT%H:%M:%SZ)"
  [ "$clamped" -eq 0 ] || reason="$reason (wait clamped to ${MAX_WAIT}s)"
  [ -z "${retry:-}" ] || reason="$reason; a Retry-After header was also present and is not used"
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
  expect() { # expect <label> <trace-text> <now> <exit> [<seconds> [<reason-substring>|!<absent-substring>]]
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
    # part of the contract: a case may pin a phrase it must carry, or — with
    # a leading `!` — one it must not.
    if [ "$#" -ge 6 ]; then
      local want=$6
      case "$want" in
        !*) want=${want#!}
            case "${out#*	}" in
              *"$want"*) check "$1: reason must NOT say '$want' (got '${out#*	}')" 1 ;;
              *)         check "$1: reason does not say '$want'" 0 ;;
            esac ;;
        *)  case "${out#*	}" in
              *"$want"*) check "$1: reason says '$want'" 0 ;;
              *)         check "$1: reason says '$want' (got '${out#*	}')" 1 ;;
            esac ;;
      esac
    fi
  }

  # The shape from run 34673730486: 200, remaining 0, a reset six minutes out.
  expect "the observed shape (HTTP 200, remaining 0, reset six minutes out)" \
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

  # ── the named misses: none of these is the shape ──────────────────────────
  expect "a secondary limit (403 + Retry-After, healthy bucket) is a named miss" \
'< HTTP/2.0 403 Forbidden
< Retry-After: 60
< X-Ratelimit-Remaining: 4998
< X-Ratelimit-Reset: 1789191767
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' \
    1789188167 1
  expect "a secondary body with no headers is a named miss" \
'< HTTP/2.0 403 Forbidden
{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' \
    1789188167 1
  expect "429 with Retry-After is a named miss" \
'< HTTP/2.0 429 Too Many Requests
< Retry-After: 30
< X-Ratelimit-Remaining: 4990' \
    1789188167 1
  expect "a spent bucket with NO reset header is a named miss (no guessed wait)" \
'< HTTP/2.0 403 Forbidden
< X-Ratelimit-Remaining: 0
{"message":"API rate limit exceeded for user ID 275282153."}' \
    1789188167 1
  expect "a spent bucket with an unreadable reset is a named miss" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: soon' \
    1789188167 1
  expect "503 with Retry-After is not the shape" \
'< HTTP/2.0 503 Service Unavailable
< Retry-After: 120
{"message":"Service unavailable"}' \
    1789188167 1
  expect "a limit-shaped body on a 200 with remaining > 0 is not the shape" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 12
{"message":"API rate limit exceeded for user ID 275282153."}' \
    1789188167 1
  expect "a 401 is not the shape" \
'< HTTP/2.0 401 Unauthorized
< X-Ratelimit-Remaining: 4998
{"message":"Bad credentials"}' \
    1789188167 1
  expect "an unreadable trace" \
'=== some future debug format nothing here knows ===' \
    1789188167 2

  # The shape with a Retry-After beside it: the shape decides the wait and
  # the header is reported as present and unused — never parsed.
  expect "the shape beside a Retry-After — the reset, and the header is named as unused" \
'< HTTP/2.0 403 Forbidden
< Retry-After: 600
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1789188527' \
    1789188167 0 360 'Retry-After header was also present and is not used'

  # Header names are matched case-insensitively — gh has spelled them both ways.
  expect "lower-case header names" \
'< HTTP/2.0 200 OK
< x-ratelimit-remaining: 0
< x-ratelimit-reset: 1789188527' \
    1789188167 0 360

  # ── numbers: one normaliser, one clamp (#2149 r11–r13) ─────────────────────
  expect "zero-padded reset is normalised" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 01789188527' \
    1789188167 0 360
  expect "zero-padded Remaining is still an exhausted bucket" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 00
< X-Ratelimit-Reset: 1789188527' \
    1789188167 0 360
  # Leading zeros are dropped BEFORE the length bound (#2149 r13): sixteen
  # characters of padding do not make a small number a ceiling, and sixteen
  # zeros are still zero.
  expect "a reset padded past fifteen characters is still its value" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 0000001789188527' \
    1789188167 0 360
  expect "Remaining padded past fifteen characters is still an exhausted bucket" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0000000000000000
< X-Ratelimit-Reset: 1789188527' \
    1789188167 0 360
  # THE OUTPUT IS BOUNDED. A reset far out is clamped to MAX_WAIT and says so.
  expect "a reset a year out is clamped to MAX_WAIT" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 1820724167' \
    1789188167 0 "$MAX_WAIT" 'clamped'
  expect "a reset near INT64_MAX is clamped to MAX_WAIT, not wrapped" \
'< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: 9223372036854775807' \
    1789188167 0 "$MAX_WAIT" 'clamped'
  # A wait of EXACTLY MAX_WAIT was not clamped and must not say it was
  # (#2149 r13): the flag is tracked, not inferred from the output.
  expect "a reset exactly MAX_WAIT away is not reported as clamped" \
"< HTTP/2.0 200 OK
< X-Ratelimit-Remaining: 0
< X-Ratelimit-Reset: $(( 1789188167 + MAX_WAIT ))" \
    1789188167 0 "$MAX_WAIT" '!clamped'

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
