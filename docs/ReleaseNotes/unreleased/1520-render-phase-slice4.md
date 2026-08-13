# Three screens stop showing a stale first frame

Three places where the page painted one frame of the previous state before
correcting itself.

The NFT verifier's search box now follows the token you navigated to in the same
update as the verdict. Using back/forward or an in-page link previously left the
box holding the old token id beside the new token's result, which read as the
page having mismatched the two.

The activity feed's "show more" depth now resets as the wallet or network
changes, rather than one frame later. Switching accounts previously rendered the
new account's feed once at whatever depth the old one had been expanded to —
a visible jump, and briefly more of the new account's rows than the first page
is meant to reveal.

The trading desk's default market is now chosen as the market list arrives,
instead of after a frame showing the empty 30-day book. Nothing about which
market is chosen has changed — only that the wrong one is never displayed.

None of these change what the screens end up showing. They remove the moment
where the screen showed something else first.
