## Thread — Testnet deploy-flow hardening (PR #853)

A batch of real deploy-flow fixes surfaced while deploying the protocol fresh
to Base Sepolia, Arbitrum Sepolia and BNB testnet over public drpc RPCs. Each
one unblocked a concrete failure the operator would otherwise hit at broadcast
time. The `DeployDiamond` diamondCut is now applied in small batches (the old
fixed two-half split reached ~17.7M gas per half at 61 facets — over drpc's
per-transaction send cap), a gas-estimate multiplier pads every broadcast so a
batched cut clears that ceiling, and the L2-block reader falls back to an
`ARB_L2_DEPLOY_BLOCK` override on Arbitrum because forge's simulator does not
emulate the `ArbSys` precompile that returns the real L2 block number.

The canonical VPFI token now has a first-class place in the deploy sequence.
A new `DeployVPFIToken` script mints the 23M canonical supply behind a UUPS
proxy and records it, and it is wired into the contracts phase **before** the
cross-chain step — the canonical CCIP LockRelease pool wraps that existing
token, so it must exist first (previously the operator had to hand-deploy it).
The token deploy is hard-guarded to the canonical chain ids (Base / Base
Sepolia) and refuses to overwrite an already-recorded token unless the operator
explicitly opts into a redeploy, so it can never mint a second supply or run on
a mirror chain by mistake. A companion `ConfigureVPFIToken` step (folded into
the post-deploy `DiamondConfigSpell`) performs the admin-gated diamond wiring —
registering the token and flagging the chain canonical — so the diamond can
actually mint and use VPFI; on mirror chains it is a clean no-op. The mainnet
handover now also rotates the canonical token's owner to the governance
timelock alongside the rest of the cross-chain stack, closing a gap where a
post-handover admin key could still upgrade or re-mint canonical VPFI outside
governance.

The automated fresh-deploy D1 purge is also part of this thread: `--phase
cf-indexer --fresh` now purges the chain's stale indexer rows after a fresh
contract redeploy (the diamond address changed, so old rows keyed by chain id
would otherwise still surface), and the misleading forge `--retries`/`--delay`
knobs were removed — those govern contract-verification retries, not
`eth_sendRawTransaction`, so they gave a false sense of send-retry protection;
transient RPC send failures are recovered by re-running the phase (with
`--resume`) instead.
