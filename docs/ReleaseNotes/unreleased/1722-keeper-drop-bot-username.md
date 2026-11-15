## Keeper: unused Telegram bot handle setting removed (#1722 follow-up)

The keeper used to declare a `TG_BOT_USERNAME` setting, carried over from when it ran the user-facing Telegram bot. No keeper code ever read it. Since #1722 the agent owns the user bot completely, so the keeper's code, its Worker config and its machine env template no longer list the setting.

Nothing changes in behaviour. An operator can delete the line from the keeper machine's env file. The ops bot settings (`TG_OPS_BOT_TOKEN`, `TG_OPS_CHAT_ID`) stay: the keeper's operator alerts still use them.
