## Thread — T-068: deploy-script broadcasting phases gated behind preflight

The tiered mainnet and testnet deploy scripts run as a sequence of named
phases (`preflight`, `contracts`, `ccip-wire`, `configure`, `handover`,
…), each invoked as a deliberate operator action. The `preflight` phase
held the two checks that must hold before any on-chain broadcast — that
the configured RPC actually serves the expected chain, and (on mainnet)
that the operator has attested to signing from a hardware wallet — but
nothing forced `preflight` to run first. An operator could invoke a
broadcasting phase directly and skip both checks, so a mispointed RPC
URL could send a deploy to the wrong network unnoticed.

Those critical checks are now factored into a gate that runs at the top
of every broadcasting phase — `contracts`, `ccip-wire`, `swap-adapters`,
`configure`, and `handover` — not only in the optional `preflight`
phase. The RPC-serves-the-right-chain check is re-run every time, so it
reflects the current `.env` rather than whatever was true whenever
`preflight` last ran; the mainnet hardware-signer attestation is
enforced on every mainnet broadcast. The check was implemented as a
re-run rather than a "preflight already ran" marker precisely so it
cannot go stale. `preflight` itself still runs the gate plus its fuller
informational checks. The testnet script gets the same gate minus the
hardware-signer leg, which has no testnet analogue.

Closes #62.
