## Governance alerts say what a queued change does (#3237)

The ops watcher's alert for an operation queued in, or executed by, the governance timelock used to show only the called function's four-byte code. It now carries a plain-words line saying what the call does, for example "Grants PAUSER_ROLE to 0x… on the diamond", along with any native amount the timelock sends.

The line comes from the shared governance decoder that the public queued-changes page also uses, so an alert and the page describe a change in the same words. The watcher decodes the changes governance is expected to make: cutting the Diamond's code, its roles, ownership and pause, the timelock's own roles and delay, and the sanctions list's and delisting timelock's settings. A call to any other function is still alerted, named by its function code together with its exact call data, and is never guessed at.
