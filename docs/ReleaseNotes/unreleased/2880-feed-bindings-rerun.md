## Feed bindings — redrafted with bridge proofs (PR #2971)

The reviewed feed-bindings files for Ethereum, Base, Optimism, Arbitrum and Polygon were redrafted with the bridge-provenance check from #2965, against the price-feed directory as it stood on the day of the run. On each L2, an entry the market-data sources and token lists had left for review is now drafted when the chain's canonical bridge names the same token those sources name and no source names a different one. The bridge's evidence (method, the Ethereum original and the bridged address) is recorded beside each such binding, so a reviewer can check it.

Drafted bindings rose from 18 to 25 on Base, 15 to 21 on Optimism, 18 to 23 on Arbitrum and 20 to 26 on Polygon; Ethereum is unchanged at 69. The rest stay in review, including natively issued stablecoins, which no bridge can prove. Refs #2880.

> Caveat: these files are drafting inputs. A binding reaches a chain only through the feed registry's delayed, guardian-vetoable change, so nothing here changes what any deployed Diamond prices today.
