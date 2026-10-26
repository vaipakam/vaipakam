# Keeper: caught errors become text only through the shared redacting formatter (#2759)

The keeper used to turn caught errors into log lines, alert text and stored
reasons with the raw error text. viem puts the full RPC URL, API key
included, into its error messages, so those lines could carry a provider key
into logs that more people can read than the secret store.

Every one of the keeper's 70 such places now goes through the shared
formatter the agent, indexer and Push rail already use. A log line keeps the
message, the cause chain and the first stack frames; text stored in a field
keeps the message and the cause chain. Either way every URL and credential is
removed and the length is bounded. The keeper's own decisions that read an
error's text (a refusal name such as `PartialLeavesDust` or
`KeeperAccessRequired`) read the same redacted text, which keeps revert names
and selectors intact.

The repository check that refuses raw error text in server-side code now covers
the keeper as well, so a new site fails CI instead of reaching a log.
