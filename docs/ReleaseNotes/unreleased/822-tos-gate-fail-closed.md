## Terms-of-Service gate now fails CLOSED on a read failure (#822)

The connected-app Terms-of-Service gate is a dapp-side routing gate over the
on-chain acceptance record — it has no per-action on-chain backstop, so if the
UI lets a non-accepting wallet through, nothing else stops it.

Previously the gate could be bypassed: while the on-chain acceptance read was
still loading it rendered the app through, and if that read *failed* (e.g. an RPC
outage) the code treated the unread default version (0) as the genuine
"gate disabled" state and also let the app through. With the gate enabled, a
simple read failure therefore opened the gated routes.

The gate now **fails closed**:

- The acceptance hook only reports "accepted" after a read has actually
  succeeded; a still-loading or errored read is never mistaken for the
  gate-disabled state.
- While the read is in flight the app shows a neutral "verifying" state rather
  than the gated content.
- If the read fails, the app shows a "couldn't verify — retry" state and holds
  the gated routes closed until the read resolves.

The genuine gate-disabled state (no Terms version published on-chain) and the
already-accepted state still pass through immediately once the read succeeds, so
there's no change for the normal case — only the loading / read-failure bypass is
closed. This is the surface the #800 sanctions & Terms-gate matrix flagged as a
confirmed divergence; it is now resolved.

Closes #822.
