## Operations — the mainnet operations baseline (PR #<n>)

A new runbook, `docs/ops/MainnetOpsBaseline.md`, sets the bar the machines and
credentials must clear before mainnet. The mainnet readiness checklist now
includes it. Nothing changes on any testnet.

The keeper host gets its own section. It lists the hardening the keeper's
service already brings, then what a mainnet host adds:

- a dedicated machine with no automated session on it;
- unattended security updates;
- a deny-by-default firewall;
- key-only logins, one account per operator;
- root-only key files;
- a separate key per role, with the keeper key holding only gas;
- monitoring that alerts the operator chat when the keeper stops ticking or
  the host runs short.

It also records, per chain, the owner's decision on private submission
(#3240).

Production credentials are to be scoped to one service and one job each, and
kept off any machine an automated session can read. A rotation record lists
every bot token, signing key and service credential: who holds it, where it
is kept in general terms, when it was last rotated and how to rotate it. It
never records a value. Each one is rotated on schedule and at once after any
suspected exposure.

This addresses #3243. Its boxes are ticked when the mainnet host is set up.
