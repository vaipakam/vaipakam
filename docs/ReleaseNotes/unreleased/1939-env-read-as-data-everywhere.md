## Every deploy-side reader takes the settings file as data (#1939, part 1)

The in-place testnet redeploy carried its own reader for the contracts
settings file, and it exported every name it found, including the names other
programs treat as startup hooks. It now uses the same data reader as the other
deploy wrappers, which refuses those names and exports nothing unless the whole
file parses. Its existing rule is kept: a value the operator already exported
still wins over the file.

The mainnet multisig runbook and the interaction-days script told the operator
to load the file by executing it in their shell. They now use a new small
wrapper that reads the file as data and then runs the command, or opens a
shell for a runbook section. A test covers the reader's two modes and the
wrapper, including that a refused line is never printed, and runs on every
pull request.
