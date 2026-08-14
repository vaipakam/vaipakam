# A swap-to-repay panel kept using the wallet you had connected when it loaded

The panel that tracks a swap-to-repay intent refreshes itself every fifteen
seconds so a fill or a cancellation shows up without a reload. When the indexer
is unavailable it falls back to reading the chain directly and fills in the
missing pieces itself, including stamping the record with whoever is connected.

That stamp was captured once, when the refresh loop started, and reused on every
tick afterwards. Switch wallets with the panel open and it carried on labelling
the intent with the previous account — indefinitely, because nothing else about
the loan had changed to prompt a fresh read.

Worth being precise about the consequence, because it is smaller than it sounds:
nothing currently displays that field or decides anything from it. The cancel
button is enabled by the intent's deadline, not by who committed it. So there
was no wrong thing on screen today. What there was is a value quietly disagreeing
with reality, in a fallback path that only runs when something else is already
broken, waiting for the first person to read it.

The refresh now takes the connected wallet into account, so switching accounts
re-reads rather than reusing the old stamp. Wallet switches are rare, so this
costs nothing in practice.
