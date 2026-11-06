## Security — removing a Telegram alert chat waits under protected mode (PR #3247)

Protected account mode makes every payout wait a delay. Its alerts, and the Telegram LOCK command, are how the owner sees a payout in time to lock the vault. Until now a thief holding only the owner key could silence them first: an unlink, or linking the thief's own chat in place of the owner's, took effect at once.

Now, while a wallet's account is protected on a network, the chat linked for that network is not removed at once. An unlink, or a link handshake from a different chat, waits the account's own protected delay (two to five days). Until then the chat keeps every alert and is told straight away that a removal is pending and when it takes effect. It can reply CANCEL to stop it, or LOCK to lock the vault. Only that chat can cancel, and only from its private chat with the bot. The agent applies the change on its scheduled tick once the delay has passed, and tells both chats.

Adding a chat where none is linked, or linking the same chat again, stays immediate, because it only adds a listener. Accounts without protected mode keep the immediate unlink. If the agent cannot read whether the account is protected, it changes nothing and says so, so a failed read never silences a protected account. The app says the chat is not unlinked yet and until when it keeps its alerts.

The pending changes live in a new shared table. A fresh Diamond on a network keeps them, because they are the user's own requests. A restore clears them, which only cancels them and keeps the chat linked now.

Part of #3246; the recovery address and clawback in the contracts follow separately.

> Caveat: a Push subscription is held by the Push network, so unsubscribing there is not delayed. Telegram is the channel the protected-mode alerts and LOCK rely on.
> Caveat: a secondary signer cannot yet approve a removal early; a genuine owner who lost the old chat waits the delay.
