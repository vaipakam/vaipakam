## Thread — The cross-chain sanctions clearance is wired on the testnets (PR #<n>)

The clearance route rehearsed in the previous change is now live on the three
test networks, with the owner's go-ahead. BNB testnet hosts the clearance
attestor and the labelled stand-in it reads in place of RedStone's Sanctions
Oracle, and its CCIP lanes to Base Sepolia and Arbitrum Sepolia are open. The
delisting timelocks on Base Sepolia and Arbitrum Sepolia now take their
clearance from that attestor, and both report automated delisting as open.
The clearance they wait for is the stand-in's answer, not RedStone's: the
stand-in flags only what the test network's admin flags and is only as current
as the admin's last update to it.

The BNB testnet deployment record and the shared deployments bundle now carry
the attestor and the stand-in, so the sanctions services and the app read the
same addresses the chain uses. The Base Sepolia and Arbitrum Sepolia records
are unchanged: their timelocks were already recorded, and only their on-chain
clearance source moved. The delister service's key now also holds 0.1 test
BNB on BNB testnet. Part of #2443, which stays open for the mainnet adder host
and RedStone's terms.
