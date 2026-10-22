## Thread — the Timelock is now the only way to change who controls the protocol (PR #TBD)

Owner decision D1 (2026-10-16) is now built. After handover the role root
(`DEFAULT_ADMIN_ROLE`) sits on the Timelock alongside Diamond ownership and the
delayed admin roles. Before this change the governance Safe held the role root
directly, which meant it could re-grant any Timelock-held role to a hot key, or
hand the whole Diamond to a new admin, in one transaction with no delay. The
48-hour review window was therefore advisory. Now every grant, every rotation
of the role root, every full admin handover and every facet or vault upgrade
waits out the Timelock delay in public (#934, #897, #909).

The governance Safe keeps one direct power, through a new emergency revoker
role: it can remove a role from a compromised hot key (a keeper, watcher or
pauser key) immediately, logging a reason. It cannot grant anything, cannot
remove the role root, and cannot remove any role from the Diamond owner, so a
compromised Safe can neither take governance nor disarm it. The Diamond owner
and the role root are also kept together: ownership can only move to a
non-zero address that already holds the role root, and the current owner can
never lose the role root (#906). That closes the old footgun where a
`transferOwnership` to the zero address bricked upgrades for good, or moved
ownership while leaving the role root behind.

The Timelock itself is hardened (#938). Its delay can never be lowered below
the value it was deployed with, so one queued operation can no longer turn it
into a pass-through. An independent canceller (the Pauser Safe) can veto a
queued operation, and is mandatory on mainnet. The Timelock always administers
itself. The vault-implementation upgrade event now carries the new code's hash
so reviewers can check a queued upgrade against audited bytecode. The audit
intake and the governance docs now say plainly that governance can move vault
funds through an upgrade, and that the protection is that such a change is
public and delayed, not that it is impossible.

Operators: rename `DEFAULT_ADMIN_ADDRESS` to `EMERGENCY_REVOKER_ADDRESS` in the
deploy `.env` (the handover refuses the old name), and set
`TIMELOCK_CANCELLER` to the Pauser Safe before a mainnet timelock deploy.
Nothing changes on the live testnets until their next fresh deploy.

Closes #934, #897, #909, #938, #906.
