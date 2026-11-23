## Thread — Node capability check per network (PR #3842)

A new read-only operator command asks the node behind each network what it can answer. It checks a trace of one transaction, a trace of a call that was never sent, a trace filter over the platform's contracts, a call at a past block, and every receipt of a block in one request. For each, it records how far back the node reaches, and it measures what a full block scan would cost per day.

The result is committed per network under `ops/node-capability/results/`. The failed transaction record reads it to choose between a trace filter and a block scan, and the transaction explainer reads how far back a replay can reach. Nothing is assumed: a network whose node answers no trace filter is marked for block-scan mode, with the measured daily cost.

The command sends no transaction, holds no key, and never prints or writes a node endpoint, host or key. It runs on the always-on machine against the nodes the services use.

Closes #3913
