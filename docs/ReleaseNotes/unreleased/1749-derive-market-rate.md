## Connected app — the minimum-collateral figure stops using the previous pair's prices (PR #1760)

The create-offer form shows a minimum collateral amount derived from live oracle
prices for both assets and the collateral's on-chain risk profile. Those figures
carried no record of which pair or which network they were fetched for, so
changing either asset — or switching networks — left the previous pair's prices
and borrowing cap on screen until the new reads returned, with the minimum
recalculated from them in the meantime.

The reads are now labelled with the pair and network they answer for, and the
form reports that it is still working rather than showing a figure derived from
the wrong inputs. Re-selecting a pair after moving away re-prices it rather than
reusing quotes taken earlier.
