## Thread — The UX sweep now fails when a route never loaded (PR #1648)

The whole-site UX sweep in the live review tier is mostly an evidence
generator: it visits every route in three passes, captures full-page
screenshots, the console stream, network timings and a devtools probe,
and leaves the judging to whoever reads the artifacts afterwards. Until
now its exit code spoke to exactly one thing — whether the sweep had
stayed read-only. A route that never loaded was written into the report
and otherwise passed silently, so a run where a page timed out or errored
still reported PASS in the pre-release batch table.

That is coverage the run did not have. When a navigation fails the sweep
deliberately records null artifacts for that route, because the browser
would still be showing the previous page and a screenshot would describe
the wrong surface. So a failed route contributes no screenshot, no
landmarks and no devtools capture — and a PASS row next to it claims the
surface was reviewed when nothing about it was ever seen. The sweep now
accumulates those failures across every session and pass, publishes them
in the report next to a count of the routes it attempted, prints a
"Routes: N/M loaded" tally on every run whether or not anything broke,
and exits with the failure code if the count is non-zero. It still
carries on to the remaining routes after one fails — stopping at the
first bad route would throw away the evidence the sweep exists to gather.

"Never loaded" turns out to be three shapes, and only the first of them
looks like a failure at the time. The obvious case is a navigation that
throws — a timeout, a refused connection. The second is a route whose
document comes back with a 404 or a 502: the browser reports that as a
perfectly successful navigation, so it would have been counted among the
loaded routes and logged as a fast, quiet, clean visit. The third is a
route that redirects away, either because the server sends the reader
somewhere else or because the application itself navigates on load — the
page that finally answers is a healthy one, captures perfectly, and is
simply not the page under review. All three now count, and the wording
throughout is careful about the difference in what evidence each leaves:
only the thrown case has nothing to look at, because nothing committed
and a screenshot would show the previous page; the other two leave a
perfectly good record of the wrong thing.

Catching the redirect case exposed a quieter problem in the shared
launcher every live review driver uses. To work around a sandbox whose
gateway interferes with browser traffic, the launcher intercepts each
page request, fetches it itself, and hands the result back to the
browser. Its fetch was following redirects internally and returning the
final content — which was then served to the browser under the
originally requested address. The effect was that a redirect became
completely invisible: the page displayed another route's content while
both the address bar and the recorded response still read as the route
that had been asked for. No driver could have detected a redirect, and
the new check could never have fired. The launcher now hands the
redirect back to the browser and lets it follow, which is what would
have happened with no interception at all.

Two choices are worth recording. The failure is reported as FAIL rather
than BLOCKED, and is checked before the session-setup branch, on the same
precedence the read-only violation already follows: something the run
actually observed outranks a session that never started. And timeouts
count. The argument against was real — a 45-second budget against a live
testnet makes some timeouts environmental, and turning those into batch
failures re-creates the habitual-red problem the three-verdict contract
exists to remove. The argument that won is that a route which cannot load
in 45 seconds is a finding whoever caused it, and burying it in a report
nobody opens is how it stays one. If transient timeouts do become
habitually red, the fix is a smarter wait or an honest budget, not an
exit code that overstates what the run proved.

Everything else stays evidence. Console errors, slow responses, heavy
payloads and the horizontal-overflow probe are judgements a reviewer
makes from the artifacts, and none of them move the exit code.

Closes #1626.
