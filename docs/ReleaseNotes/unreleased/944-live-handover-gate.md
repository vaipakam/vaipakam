## Thread — Live handover check and bot-role rotation (PR #2660)

The governance handover is now proven against the deployed chain. A new
read-only phase, `handover-gate`, in both the mainnet and testnet deploy
ceremonies, rebuilds the complete list of accounts holding every role on
the Diamond and on the Timelock from the chain's own role events since the
deployment block, confirms each one directly, and fails on any holder the
governance plan does not name. The Diamond's role registry cannot list its
members, so asking "does the deploy key still hold this role?" could never
find a third key holding it; reading the history can. The check refuses a
history it cannot prove complete. It also checks the Diamond owner, that
every role is administered by the role root, the Timelock's delay, floor,
proposer, canceller and executor, every cross-chain contract's owner and
pending owner (the Chainlink token pool by its ownership events, since its
pending owner is private), each guardian, and the VPFI Cross-Chain Token
administrator. On a production chain anything it cannot check fails; on a
testnet it is reported as not checked. The old exit gate,
`DeployerZeroRolesTest`, built its own throwaway Diamond and never read the
chain, so it passed whatever the chain held; it stays as a unit check of
the model only.

The handover itself now finishes the job. Before, the keeper, watcher and
notification-biller roles stayed on the deploy key "until the bot keys are
set up", a step nothing ever ran, so the deploy key kept those powers for
good. The handover now grants them to the keys in `KEEPER_ADDRESS`,
`WATCHER_ADDRESS` and `NOTIF_BILLER_ADDRESS` (the zero address leaves one
unheld on purpose) and the deploy key renounces every role it held. All
three variables are required, a bot key may not be the admin, either Safe,
the Timelock or the Diamond, and the handover script and the live check
read one shared plan so they cannot drift apart.

Closes #944 and #669. Nothing was run on any chain: this is tooling for the
next fresh deploy, tested on local Diamonds only.
