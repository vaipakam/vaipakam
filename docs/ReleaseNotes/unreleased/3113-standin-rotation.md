## Sanctions — replacing the testnet stand-in carries its flags over (PR #3125)

The keeper can refresh only a stand-in that names it as refresher, and the one on BNB testnet was built before that role existed. An attestor reads one oracle for good, so replacing the stand-in also means a new attestor, and the clearance route on BNB, Base Sepolia and Arbitrum Sepolia has to move to it.

The clearance wiring script can now make that move when it is told which attestor it replaces. It re-points only a channel handler or peer that is that attestor, and anything else still stops the run. Before the new attestor answers anything, the script copies every account the old stand-in flags onto the new one. It rebuilds the list from the old stand-in's own records, refuses if those records don't reach back to its deployment, and checks each account against the old stand-in. Until each timelock's own chain is re-pointed, that timelock gets no new answers, but answers it already holds still count. Those were read from the old stand-in, which keeps the same flags. Re-pointing voids them, and the delister asks again. Running the script again after the rotation carries nothing, so it never re-flags an account the admin has cleared since.

Refs #3113.
