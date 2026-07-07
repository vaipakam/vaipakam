# ENS name lookups stop hitting a rate-limited default endpoint (alpha02)

The address-to-name display sugar (a wallet address with an ENS name
shows the name instead of hex) resolves on Ethereum mainnet, which is
not one of the app's working networks. That lookup client had been
riding the chain library's built-in default endpoint — a free shared
server that started answering "too many requests" the moment a list
page's first paint asked for a name per counterparty row. The failure
was cosmetic (the short hex form always renders when a lookup fails)
but wasteful and noisy.

Two changes, in the same spirit as the RPC diet:

- **The name-lookup client now uses explicitly chosen endpoints** —
  the same operator-overridable Ethereum RPC setting every other
  chain read uses, with a second public endpoint behind it so a
  throttled primary degrades to the fallback instead of to a dropped
  name. The library default is never contacted, and the CI guard that
  watches a parked page's traffic now also fails if it ever is.
- **Each address's name is resolved at most once per session.** Names
  effectively never change mid-session, so re-resolving on every
  screen revisit was pure waste — results are now kept for the whole
  session, and a failed lookup is not retried in a loop.

Nothing visible changes: named wallets still show their names, and
everything else shows the short hex form as before.
