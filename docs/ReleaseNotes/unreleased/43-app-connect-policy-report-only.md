## Thread — the connected app's connection list, published as a report first (#43)

The connected app's content policy still allows network requests to any secure host, so a script that got onto the page could send what it reads anywhere. The narrow list is now built and sent beside it as a report-only policy: the app's own address, the indexer and its live channel and the alert service this build is configured with, the chain endpoint of each supported network (and its live socket where one is configured), the name-lookup endpoints, the two token-screening services, and the hosts the WalletConnect and Coinbase Wallet connectors need. A request outside the list is reported by the browser and still made, so nothing can break yet. It moves into the enforced policy once a deployed build has been driven clean under it, because a wallet host missed from an enforced list would silently break that wallet. That staging was an owner decision.

Every address the app connects to is now resolved in one place, from the build's settings, and the build writes the list from that same place, so the policy cannot describe a different deployment from the one it ships with. The five copies of the alert-service address rule became one. A configured address that is not a plain secure origin stops the build.

The live review drives now fail on any content-policy report or refusal the page raises, whatever else they check, which is how a missing host is found before the list is enforced. No report is sent to any server: it would carry the page a visitor was on.

Part of #43.
