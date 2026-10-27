## Feed bindings: bridged tokens proved from the canonical bridge (PR #2965)

The feed-bindings drafting tool resolves which token a price feed means from
three independent lists, and drafts a binding only where all three name the
same address. On Arbitrum, Polygon, Base and Optimism most of the tokens are
bridged from Ethereum, and many review entries were a token that one list
simply omitted. The tool now also asks each chain's canonical bridge which
token stands for the Ethereum token that Ethereum's own reviewed file already
settled for the same symbol. Arbitrum's gateway router and Polygon's child
chain manager answer that directly. On Base and Optimism a bridged token's
own report could be forged by anyone deploying a token. There, the proof is
the standard bridge's ledger on Ethereum: the token holding more than half of
what the bridge has locked for the Ethereum token.

The proof is evidence beside the lists, never a replacement for them. It
confirms a drafted binding. It sends one back to review when the bridge names
a different deployed token, as with Polygon's native USDC against bridged
USDC.e, where choosing between native and bridged stays a person's call. It
settles a review entry only where at least two lists name the bridge's token
and no list names another. Run against the current files, it settles 24
review entries (Arbitrum 5, Polygon 6, Base 7, Optimism 6) and sends
Polygon's two USDC bindings to review. The bindings files themselves change
only when the drafting run is repeated with the source keys, which happens on
the owner's machine.

Refs #2880.
