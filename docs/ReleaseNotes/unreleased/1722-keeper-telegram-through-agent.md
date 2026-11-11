## Keeper — Telegram alerts and LOCK requests go through the agent (PR #3576)

The keeper no longer holds the user-facing bot token or any chat id. Every
owner Telegram message it used to send itself (health-factor band warnings,
pre-grace warnings, protected-vault alerts) is now posted to the agent's
keeper routes as typed data, and the agent writes it in the owner's language
and sends it to the chat linked to the wallet then, or answers that no chat
is linked. Push is unchanged: the keeper still sends it, with the same
wording the agent renders. The keeper's own band memory remains the only
guard against a repeated warning, as the agent does not filter alerts.

The Telegram LOCK step works the agent's requests instead of the shared
table: it asks the agent for a chain's open requests (which is also how the
agent learns a keeper able to sign is working them), locks the vault as
before, and reports how each ended. The agent records the outcome and
answers in the chat, so the keeper sends no LOCK answer of its own. An
answer the agent recorded but could not deliver is not sent again, and the
run line says so; a report the agent already had is named as such. Releases
still wait on any account with an open request, now read from the agent.

Every request names the Diamond the keeper serves on that chain. An agent
serving another Diamond refuses it, and the keeper treats that refusal like
the epoch fence's own: the chain's run stops rather than act for a deployment
the two disagree on.

The Push text of a payout alert no longer suggests sending LOCK: only the
agent knows whether the owner linked a chat, so the suggestion travels in
the Telegram message alone. A token symbol is reduced to plain characters
before it is put in an alert, so an odd symbol cannot get the alert refused.

Configuration: the keeper needs `AGENT_ORIGIN` (a plain var) and
`KEEPER_AGENT_TOKEN` (the same value the agent holds, written to both
together). Without them no Telegram alert is sent, the LOCK step does not
run, and each run says so. The keeper's `TG_BOT_TOKEN` binding and its
dead Telegram link helpers are removed. Advances #1722; follows the agent's
move of this state into its own storage.

> Caveat: the keeper machine needs `AGENT_ORIGIN` and `KEEPER_AGENT_TOKEN` set, and its old `TG_BOT_TOKEN` line deleted, before its Telegram messages resume.
