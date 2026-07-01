## Thread — Deploy-script hardening follow-ups (PR #855, Closes #855)

Four operator-facing deploy/ops hardening fixes that were deferred from the
testnet-deploy-hardening work (#853) to cap that PR's review loop. None change
the already-live Base/Arb Sepolia deploy; they close footguns in the
mainnet/multi-chain deploy scripts and the incident-pause tooling.

The `--phase ccip-wire` step now hard-errors if `CCIP_GUARDIAN` is unset. The
cross-chain configure silently skips wiring the incident guardian onto every
`GuardianPausable` contract when that address is missing, and setting a guardian
is owner-only — so once ownership hands over to the governance timelock, the
fast Pauser-Safe pause lever can no longer freeze those contracts during an
incident. Requiring it at wire-time (while the admin still owns them) keeps the
containment path intact. `CCIP_GUARDIAN` is a single global address (typically
the Pauser Safe), documented in the CCIP infra reference.

A canonical VPFI redeploy now has a third, non-destructive option. Previously a
Diamond/CCIP redeploy on the canonical chain could only either abort (a token
already exists) or mint a second 23M supply (forking the token). Setting
`VPFI_TOKEN_REUSE_ADDRESS` to the existing canonical token now carries it forward
— it is recorded for the new deploy and the mint is skipped — with a loud
reminder that the operator must rotate the token's minter to the new diamond
afterward (owner-only).

Two smaller fixes: the post-deploy configure now skips VPFI registration
gracefully when no VPFI token was deployed (a `--skip-vpfi` deploy), so the
configure spell no longer reverts; and the emergency-unpause helper now routes
its calldata through the governance timelock (unpause is owner-only /
UNPAUSER_ROLE by the asymmetric-pause design) instead of mislabeling it as a
Pauser-Safe action — which would have reverted for the cross-chain contracts.
