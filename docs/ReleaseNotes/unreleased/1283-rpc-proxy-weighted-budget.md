## RPC proxy — every method shaped, calls charged by weight, upstream answers capped (PR #<n>)

The read-only RPC proxy checked the parameters of one method only, the
log scan. Every other method it serves now has a stated shape, and a call
outside it is refused in place with an invalid-params error instead of
going to the provider. The one that mattered most is the contract call and
gas estimate: they no longer accept a third "state override" parameter,
which would let anyone run arbitrary simulations on the platform's provider
plan. The connected app never sends one, so nothing it does changes.

The proxy's rate limit counted HTTP requests, and one request may carry
fifty calls, so a batch of fifty log scans cost the same as a single
block-number poll. A second per-caller budget now charges the calls a
request actually forwards, by weight: a plain read is one unit, a contract
call two, a gas estimate three, a block with all its transactions five and
a log scan ten. A request takes one slot per twenty-five units, at least
one, from a budget of two hundred slots a minute. Calls the proxy answers
itself (refusals and the chain id) cost nothing. A request over budget is
refused as a whole before the provider is asked, like every other refusal,
and the app falls back to the chain's public endpoint.

The proxy also read each upstream answer in full before looking at it. It
now reads at most 8 MiB and answers with a named "answer too large" error
past that, so one heavy answer cannot hold the Worker's memory.

Advances #1283. The agent's route limits and the signed lock requests from
the same issue land separately.

> Caveat: like the request budget, the new call budget is counted per Cloudflare location, so it bounds what one address spends at one location, not a crowd of addresses; the provider plan's own cap remains the outer bound.
