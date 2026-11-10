## Thread — alpha05 keeps a connected session's console clean (PR #3481)

With a wallet connected, the new app's console filled with refused requests to an outside Ethereum mainnet endpoint. The wallet picker's connected surfaces (its button, its account page and its avatar) each looked up a name-service name for the address on Ethereum mainnet. Because the app serves no mainnet, they read it from a public endpoint the page never names, and that endpoint refuses the app's origin. One connected walk over the main pages made 167 such requests, and every report from the page's list of allowed destinations was one of them.

The wallet picker is now used only to connect. Once a wallet is connected, the address chip opens the app's own account panel. It shows the full address with a copy action, the network, a switch to each other network the app serves, and disconnect. The app shows the address itself and reads nothing on Ethereum mainnet.

The live-update channel no longer logs a failed connection when the page stops needing it while it is still opening. It now waits for the connection to open and then closes it.

A new live driver walks the main pages with a watch-only wallet connected, on desktop and phone, and fails on any console error or warning from the app, any report against the allowed-destination list, or any failed request. The deployment review the rulebook requires is now taken connected.

Closes #3476. Advances #3180.
