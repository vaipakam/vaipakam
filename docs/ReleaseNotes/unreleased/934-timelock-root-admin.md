## Thread — the Timelock is now the only way to change who controls the protocol (PR #2642)

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

Two operational consequences follow from putting the root on the Timelock.
Giving a role to a new key after handover, for example a replacement keeper or
watcher key, is now a Timelock operation and waits out the delay; taking a role
away from a compromised key stays immediate through the emergency revoker. And
on a Diamond refreshed in place rather than freshly deployed, nobody holds the
emergency revoker role until the root admin grants it, because the role is
handed out at initialisation and handover, which do not re-run on a refresh.

The emergency revoker role is never granted at initialisation. Only the
handover gives it out, straight to the governance Safe, so no handover path can
leave it behind on the deployer's hot key. The Timelock's canceller is taken
from the same `PAUSER_ADDRESS` setting the handover uses for the Pauser Safe,
there is no separate setting to mistype, and the handover refuses a Timelock
whose canceller is not that Safe. On a mainnet both Safes must be deployed
contracts.

There is now one handover procedure. The two older scripts (a separate
"grant ops roles" step and "transfer admin to timelock") are retired: they split
the roles differently from the canonical handover, left the deployer holding the
unpause role, and did not know the new topology. The governance runbook, the
mainnet multisig setup guide and the Base Sepolia deploy guide now walk the one
procedure, and the Tenderly ABI files carry the new upgrade event and Timelock
constructor (#936, #650).

Operators: rename `DEFAULT_ADMIN_ADDRESS` to `EMERGENCY_REVOKER_ADDRESS` in the
deploy `.env` (the handover refuses the old name). Make sure `PAUSER_ADDRESS` is
the Pauser Safe before deploying a Timelock, and do not set
`TIMELOCK_CANCELLER` (the Timelock deploy refuses it). Nothing changes on the
live testnets until their next fresh deploy.

Closes #934, #897, #909, #938, #906, #936.
