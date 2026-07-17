## Thread — RL-6: legal evidence pack + rewards copy-rules release gate (PR #TBD)

The recycling loop-closure design (RL-6, ratified 2026-07-16) found the
stack's legal argument asserted from first principles but the external
precedent set recorded nowhere in the repo. This lands the evidence pack
as a new appendix in the VPFI tokenomics research doc: the Fuse no-action
letter (SEC Corp Fin, 2025-11-24 — the first no-action relief for a
rewards token, recorded with the counsel-letter-versus-staff-response
attribution and its partial-analogy scope preserved), the Corp Fin
protocol-staking statement (2025-05-29 — cited only for the
determinism/no-operator-discretion property the loop must keep, never as
applicable to token-holder rewards), and a condensed production-protocol
benchmark table. The "hand any future counsel two documents" package is
now explicit: release 33-11412 plus the Fuse letter, benchmark as
context.

The design's four copy rules (usage rebate / fee discount / program
longevity — never yield, APY, income, deflation, scarcity, or price; own
activity, never passive holding; no market touch; deterministic
bookkeeping) are restated as a release-gate checklist in the same
appendix, and the project instructions now require every PR touching a
user-facing recycling/rewards surface to pass it before merge — under
33-11412 issuer representations are the dominant factor, making this the
cheapest legal insurance in the program. Docs-only; no code, spec, or ABI
surface touched. Closes #1304.
