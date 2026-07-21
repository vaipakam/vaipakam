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
user-visible JSX attributes (title, aria-label, placeholder, alt, …). The
attribute/object-key allowlist is backed by a camelCase-suffix rule
(`*Label`, `*Title`, `*Body`, `*Hint`, …) so a component's typed
copy-field family (the offer-flow side copy, step labels, take/submit
labels) is covered as a whole without enumerating every field name, while
lowercase look-alikes like `context` stay untouched. Hardcoded values
passed into a catalog template through the codebase's established
branch-alias pattern (`const text = copy.desk.ticket; text.method('…')`)
are followed via a single-file, lexically-scoped alias map — both function
parameters and block-local declarations that reuse a common variable name
are respected, so ordinary code is never mis-flagged and a real alias call
after a shadowing block still is — and prose inside tagged templates or
object-spread prop bags is scanned the same as its direct form.
Because the parse makes "is this rendered?" unambiguous, the detector can
flag even a single prose word without the false positives that blocked
the regex — a template literal assigned to a className or a route is
simply never in a scanned position. A standalone TypeScript-compiler
script was chosen over an ESLint rule because alpha02 deliberately runs no
ESLint toolchain; the script stays wired into the same `typecheck` lane.

Running the new detector on the tree found several dozen pre-existing
hardcoded strings the regex had missed (the committed baseline currently
freezes 48 occurrences across 19 files, most of them advanced Rate-Desk
copy and hardcoded fallback labels passed into catalog templates).
Rather than block the tooling change on extracting them all, they are
frozen in a file-scoped, occurrence-counted baseline (the standard
lint-ratchet: existing debt grandfathered, any new violation — new file,
new string, or new duplicate — blocked; the check also fails if a
baselined string is extracted without lowering its count, so burn-down
stays honest). Their burn-down is tracked as a follow-up. A unit test
suite pins the detector against the exact bug shapes from the previous
release so the guardrail cannot silently regain its blind spot. Scope is
limited to `apps/alpha02`.
