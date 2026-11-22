## Troubleshooting — a transaction explainer for operators

An operator can now ask what a transaction did, or what an attempt that was never sent would do, and get the answer in plain words and as data. The explainer lists each function entered, in order and by depth, with its arguments and the gas it used; each event emitted, in the order it was emitted, with the events a failed inner call undid marked as undone; and where the transaction stopped: the error, its values, and the error catalogue's meaning and who can act on it. When a caller turned one error into another, both are shown, with the place the first was raised.

The trace comes from the node when it offers one. When it does not, the command rebuilds the moment on a local copy of the chain: the state at the end of the parent block, the block's earlier transactions applied in their order, then this one. The rebuilt run is compared with the chain's receipt (success, gas used and every event). When they agree the output says it matched; when they do not, it is headed "approximate replay: what happened on chain is not shown here" and lists what differed. With neither a trace nor a rebuild, it shows the receipt's events and says that the functions and the code that ran are not known, giving the Diamond's route for the called function at the start and the end of the block instead.

Which code ran is read from the trace itself, from the address each Diamond call was forwarded to, so a refresh later in the same block cannot change the answer. An address the deployment record does not know is shown as an address and said to be unknown (the facet history, a later card, will name code a refresh replaced). Calls and events that match none of the checkout's ABIs are counted and said to come from a different build or from outside code.

The explainer is a pure function in the shared library, so the case file and the failed transaction record can reuse it; the command around it reads the node endpoint from the environment, never prints it, sends nothing and holds no key.

Closes #3917.
