## Thread — Close the 6 surviving HIGH-severity Code Scanning alerts (PR #<n>)

Closed the six HIGH-severity Code Scanning alerts that were still open
after PR #136's Slither sweep — two Slither HIGHs and four CodeQL HIGHs.
This is Phase 2 of issue #148 (Code Scanning queue triage).

### Slither (2 HIGHs)

Both alerts were `msg-value-loop` on `VaipakamRewardMessenger.broadcastGlobal`.
PR #136 had placed a `// slither-disable-next-line` directive on the
inner `sendMessage{value: fee}` statement, which silenced the
per-statement match but not the function-level one Slither also raises
when `msg.value` is read inside any for-loop. Replaced the next-line
directive with a `// slither-disable-start msg-value-loop` /
`// slither-disable-end msg-value-loop` block wrapping the whole
function, keeping the existing rationale comment in place so the
audit trail is preserved at the call site. The pattern is intentional
(bounded fan-out, cumulative `spent` counter + `msg.value` pre-check),
and the per-statement suppression for `arbitrary-send-eth` /
`msg-value-loop` stays inside the loop body for redundancy.

### CodeQL (4 HIGHs)

All four flagged vendored OpenZeppelin Certora verification tooling
under `contracts/lib/openzeppelin-contracts-upgradeable/certora/` —
exactly the same false-positive class the Slither
`filter_paths` already excluded. Added a CodeQL equivalent: a new
`.github/codeql/codeql-config.yml` with `paths-ignore: contracts/lib/**`,
wired into `.github/workflows/codeql.yml` via the `config-file` input
on the `init` step. After this lands the four CodeQL alerts auto-close
on the next CodeQL run.

After this PR merges, the Code Scanning HIGH-severity count drops from
6 to 0; the remaining triage work (Phases 3-5 — 187 Slither MEDIUMs,
215 Slither LOWs, 154 uncategorised Slither informational findings,
6 CodeQL MEDIUMs) continues under #148.
