## Protected account mode — an owner's own withdrawal never ends held (PR #<n>)

With protected account mode on, every payout from a vault passes the payout gate. When the account is locked, or its queue of waiting payouts and transfers is full, the gate keeps the amount in the vault instead of queuing it. A settlement relies on that: it must never fail because of the payee's account state. Until now, though, two routes the owner starts went through the same gate: the VPFI withdrawal and the release of surplus loan collateral. On a locked account or a full queue, either one reported success while paying nothing and queuing nothing.

Each of those routes now asks the same question first, and refuses when the answer is no. The depository withdrawal already refused in this case. So an owner's own withdrawal ends one of three ways: paid, queued or refused. Settlements keep the hold.

The rule lives in one place in the protected-account library, and each voluntary route calls it. The collateral release checks it only when the release goes to the account's own manager. A release to another holder of the position never passes the gate.

This is fresh-deploy material, like the rest of protected account mode.
