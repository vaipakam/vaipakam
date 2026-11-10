## Thread — alpha05: trust tiers and token search in the pair picker (PR #TBD)

Part of #3446.

When you choose a token to borrow or lend in the new app, it now shows where that token ranks by market value, from two public lists of tokens. The match is by the token's contract address on the network, never by its name, since anyone can name a token anything. A blue chip is in the top 20 and is priced by the protocol; then come the top 100, 200, 300 and 500.

A token outside the top 500 carries a warning that it is used at your own risk. A token that shares a ranked token's name or symbol at another address is labelled a possible copy and shows the real token's address, and when the two lists disagree on where a token lives, it is shown as unverified with both addresses. Test tokens and test networks say so.

Each tier shows the date of the list it came from, and a refresh that failed is stated, so an old list never reads as current. The tier is a guide only: what the protocol does with a token is unchanged and still shown beside it.

The "another token" field now also searches by name or symbol. Ranked tokens come first, each with its tier and full address, and picking one fills in the address.
