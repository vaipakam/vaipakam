## Thread — two defi UI regressions fixed: chain-switch error banner + lender early-withdrawal reachability (PR follows)

Two genuine bugs that were surfaced (and deliberately left visible) during the
#1076 test-suite repair are now fixed, and their covering tests un-skipped.

**Connected-user error banner (#1090).** When a connected wallet's chain
switch failed or was rejected, the red error banner never appeared — the
"clear transient errors once connected" effect in the wallet context was keyed
on both the connection status and the error itself, so it wiped *any* error the
moment one was set while already connected. Since only a connected wallet can
trigger a chain switch, the "Chain switch rejected or failed." message was
erased on the very next render before it could be shown. The effect now fires
only on the disconnected→connected transition (tracked via the previous
status), so it still clears a stale pre-connection error once you connect, but
an error raised *while* connected — a rejected chain switch, an RPC failure —
now stays on screen.

**Lender early-withdrawal reachability (#1091).** A lender viewing their own
active loan could never reach the Early-Withdrawal control. The entire loan
actions card was gated on the "repay" availability flag, which is false for the
lender (repaying your own loan is disallowed), yet the lender-only
Early-Withdrawal action — and the public Trigger-Default action, which a lender
can also invoke once a loan is overdue — were nested inside that repay-gated
card. The card now renders whenever *any* of its actions is available, while
the repay-specific section stays gated on the repay flag so it remains hidden
from the lender (who cannot repay their own loan). Lenders can now reach their
early-exit control, and either party can reach Trigger-Default on an overdue
loan.

Both are app-behaviour fixes in `apps/defi`; no contract changes. Closes #1090
and #1091.
