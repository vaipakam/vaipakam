## Thread — Test suites create facets from their built artifacts (PR #2798)

The shared test setup, the invariant base and the individual test suites now
create every Diamond facet from the creation code Foundry already wrote for
it, through the same helper the deploy scripts adopted in #2718, instead of
compiling each facet into every test contract. The Diamonds the tests build
are unchanged: the same facets, the same code and the same addresses.

Most test suites inherit the shared setup, and that setup deployed every
facet, so each suite carried a full copy of all of them for the compiler to
optimize again. A regression chunk of twenty-five suites took six to
seventeen minutes, nearly all of it compiling. Each facet is now compiled
once per build. Run on the forty-five suites this change touches, in four
groups of about twelve, the groups took two and a half to five minutes each,
compile included, and every test passed.

One suite keeps compiling two facets in on purpose: it compares refreshed
code against a fresh copy as an independent check that the artifact in use
is this tree's build. Closes #2789.
