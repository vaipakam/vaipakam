## Keeper — private route: several endpoints, a provider method, and a timed public fallback (PR #3529)

Advances #3408 (keeper side). On a public-mempool chain the keeper's protective transactions (the Telegram LOCK, forced sales, liquidations, every send its key makes on that chain) already went through a private submission endpoint (#3240). That route now matches the owner's 2026-11-09 decision.

A chain's private route can name several endpoints, tried in the order the operator wrote them, each with the same signed transaction and eight seconds to answer, so a later endpoint is the fallback for an earlier one. An endpoint may be called with a provider's private-transaction method instead of an ordinary raw submission. That is how the RPC provider the keeper already uses offers private submission on Ethereum mainnet, with free private endpoints behind it.

On a chain the operator allows a public fallback, a transaction a private endpoint accepted but that is still unmined after a stated time (a new setting, 24 to 300 seconds, default 60) is sent once through the chain's ordinary RPC as the same signed bytes. It goes out on the first tick after that time. Each accepted private send is recorded with its bytes in the keeper's private database (keeper migration 0008), so the copy survives a restart. No copy is sent in the last minute of the keeper's seven-minute nonce window, which counts from when the nonce was recorded before the first private attempt, because once the window has passed a later send may hold the nonce; such a send is reported with its outcome stated as unknown, and its record is kept until that report is made.

Every public fallback, whether every endpoint failed or the accepted send did not land, now posts an ops alert naming the transaction (one per chain per ten minutes, every one logged), because the transaction is public from then on. The per-tick route line names each chain's endpoints in order by provider domain only, and the method where it is not the ordinary one.

Nothing changes until an operator sets these values: no testnet chain has a private route today, so the change ships disarmed. Keeper migration 0008 must be applied before the machine runs this build (the keeper's deploy applies it).

Not in this change, and tracked on #3408: relaying users' signed lock and cancel messages waits for the signed-lock entry of #3423; the sanctions adder is a separate service with its own sender; the guardian and watcher pause transactions are not sent by the keeper; and Polygon PoS has no keeper chain entry yet.

> Caveat: the inclusion fallback runs on the minute tick, so a public copy can go out up to a minute after the stated time.
