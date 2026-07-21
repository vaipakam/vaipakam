## Thread — alpha02: AST-based hardcoded-string detector (#1365)

The `apps/alpha02` guardrail that fails CI when a user-visible string is
hardcoded instead of routed through the copy catalog was a line-based
regex scanner. It had been hardened five times and still had a
structural blind spot: a real prose word sitting next to an
interpolation — `expires {date}`, `{collateral} collateral (borrower's)`,
`Offer #{id} · waiting for the other side to accept`. These render
through JSX with values spliced mid-sentence, so there is no clean
`>text<` node and no quoted literal, and a per-line regex cannot blank
`${...}` boundaries precisely or tell a rendered word from a code token.
The previous release shipped a dozen such strings that the regex passed
clean, surfacing only when a user viewing the app in Chinese saw English
fragments.

This replaces the regex scanner with a detector that parses each `.tsx`
with the TypeScript compiler and inspects the exact rendered positions
the syntax tree exposes: JSX text children, string/template literals used
as JSX children (including inside conditionals), and a small allowlist of
user-visible JSX attributes (title, aria-label, placeholder, alt, …).
Because the parse makes "is this rendered?" unambiguous, the detector can
flag even a single prose word without the false positives that blocked
the regex — a template literal assigned to a className or a route is
simply never in a scanned position. A standalone TypeScript-compiler
script was chosen over an ESLint rule because alpha02 deliberately runs no
ESLint toolchain; the script stays wired into the same `typecheck` lane.

Running the new detector on the tree found roughly two dozen pre-existing
hardcoded strings the regex had missed. Rather than block the tooling
change on extracting them all, they are frozen in a file-scoped baseline
(the standard lint-ratchet: existing debt grandfathered, any new
violation blocked) and their burn-down is tracked in a follow-up. A unit
test pins the detector against the exact bug shapes from the previous
release so the guardrail cannot silently regain its blind spot. Scope is
limited to `apps/alpha02`.
