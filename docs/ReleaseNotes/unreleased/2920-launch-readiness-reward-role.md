## Launch — readiness now checks that a chain runs the reward role meant for it

Launch readiness had no check on the reward role. The reward configure step
decides it from the chain (Base is the canonical reward chain, every other
chain that runs rewards is a mirror), but if that step never ran or stopped
partway, nothing at launch noticed. A Base Diamond left unconfigured would
launch, and the zeroed-day lapse schedule check added for #2909 would report
"does not apply", which was true of the stored role and hid that the role
itself was wrong.

Readiness, which the launch script, the post-deploy verify phases and the
on-chain launch gate all read, now has a tenth check. The launch declares the
role it expects, and the check compares the chain against that:

- Canonical on Base and Base Sepolia.
- Mirror on any other chain whose deployment records a reward messenger.
- No reward stack (the Diamond stays unconfigured) when the deployment records
  no reward messenger, as on a deploy that skips the VPFI and cross-chain
  stack.

A detached role is never the intent, so it is always NOT MET. A launch that
declares no role reports the check as NOT CHECKED, never met, so a production
launch refuses it. On a production chain the expected role travels in the
Timelock proposal with the other declared values, and the proposal printout
names it for the Governance Safe to review.

The rule for which chain is Base now lives in one place, used by both the
reward configure step and the launch, so the two cannot disagree.

Nothing moves funds. The launch gate's input gains one field, so a launch gate
deployed from this build has a new address; every chain reaches this build by
fresh deploy.

Closes #2920.
