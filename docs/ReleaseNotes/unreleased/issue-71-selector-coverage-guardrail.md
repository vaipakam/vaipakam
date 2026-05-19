## Thread — Selector-coverage guardrail + a pre-deploy sanity gate (PR #<n>)

The Diamond routes each function call to a facet by selector, and that
selector→facet routing is hand-maintained — when a new external function
is added to a facet, a developer has to remember to add its selector to
the deploy script's cut list. If that step is missed, the function still
exists on the facet contract but the Diamond never routes it: every call
reverts with an opaque `FunctionDoesNotExist`, silently, until someone
hits it at runtime. The facet-count check added earlier (Issue #69)
catches a whole *facet* being left out; it cannot catch a facet that is
present but missing some of its *selectors*.

This change adds `SelectorCoverageTest`, a guardrail that closes that
gap. For every facet it reads the authoritative selector set straight
from the compiled artifact and asserts each one is actually cut into the
Diamond by the deploy script — failing the test run, and naming the
offending function, if any selector is unrouted. There is no second
hand-maintained list for it to drift against; the compiler's output is
the source of truth. The same test also checks that no two facet
functions collide on a 4-byte selector — a collision would make the
Diamond impossible to cut at all.

On its very first run the guardrail caught real, pre-existing drift on
`main`. The entire T-034 *Periodic Interest Payment* feature — the
permissionless settler entry point and its two companion views — had
been added to the repayment facet and wired into the test harness, but
never added to the production deploy script's cut list. Any real deploy
would therefore have shipped a Diamond on which that whole feature was
unreachable. A public pagination-limit constant on the dashboard facet
was unrouted for the same reason. Both have been wired into the deploy
cut list as part of this change, so the feature is now reachable on a
fresh deploy.

The deploy-time guardrails are now grouped under a `test/deploy/`
directory as a named "deploy-sanity" suite — this selector-coverage
check alongside the existing EIP-170 facet-size check (Issue #66) — and
both draw their facet list from one shared source so they cannot drift
onto different facet sets.

A new `predeploy-check.sh` script is the single pre-deploy gate. It runs
the build, the deploy-sanity suite, a lint pass over the deploy shell
scripts (syntax, optional shellcheck, a guard against stale LayerZero
deploy variables removed during the CCIP migration, and a check that
each script still orchestrates the Diamond deploy), and an
ABI-export-in-sync check that every committed per-facet ABI matches the
compiled contract. It is wired in as a preflight step inside all three
deploy scripts, so a deploy cannot proceed past a failing sanity check;
the mainnet script additionally runs the full regression suite, since a
mainnet deploy must not ship contracts whose tests are red. The script
is also runnable standalone for a dry pre-check.

A companion deploy-*integration* test — one that actually executes the
deploy and loupe-asserts the resulting Diamond, dynamically subsuming
the static checks — is tracked separately as Issue #72.

Closes #71.
