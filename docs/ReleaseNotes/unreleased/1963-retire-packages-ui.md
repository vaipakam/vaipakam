## Thread — Retire the orphaned `packages/ui` component package (PR #<n>)

`packages/ui` held five shared React primitives — a token icon, an info
tip, a chain picker, a copyable address and the picker they were built
on. The #1854 cutover deleted `apps/defi`, which had eleven importers and
was the package's last real consumer. Since then nothing imported it and,
more importantly, nothing compiled it: the package had no `tsconfig.json`
and no `typescript` dependency, and its `typecheck` script ran ESLint
only. A step named "typecheck" on a required CI job had stopped
typechecking anything, and ordinary type errors in that source could
reach `main` unopposed.

This retires the package rather than giving it real checking. The choice
turns on the fact that it shipped to nobody: adding a `tsc` pass would
have bought a genuine gate over code with no consumer, and paid for it
with a first run's worth of accumulated errors to triage plus ongoing
maintenance of a library nothing uses. The shipping surfaces confirm the
package was not load-bearing — `apps/app` and `apps/www` carry their own
pickers and never referenced these primitives; `apps/www` held only a
dependency entry it never imported from, which goes with it. The source
stays recoverable from git history if a surface ever wants those
primitives back.

Cleaning up after it reaches a few places worth naming, because each was
making a claim that is no longer true. The CI lint step and its
explanatory comment are gone. The connected-app vitest gate's
change-detector no longer watches a path that cannot exist. The
deployment runbook described `VITE_TOKEN_ICON_URL_TEMPLATE` as "inert
pending a consumer"; with its only reader deleted it is now simply dead,
and the runbook says so. The matching per-chain `tokenIconUrlTemplate`
field on the deployment type is kept — it is optional, no chain stanza
sets it, and removing a typed deployment field is a schema change that
deserves its own review — but it is now documented as having no reader.

Closes #1963. Two related dispositions are deliberately left open: the
`packages/defi-client` package that #1854 orphaned in the same way still
needs its own decision, and the now-readerless `tokenIconUrlTemplate`
field is a candidate for a later schema tidy.
