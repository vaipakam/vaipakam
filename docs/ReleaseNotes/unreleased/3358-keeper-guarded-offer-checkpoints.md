## Keeper — hourly price checkpoints now cover guarded offers (PR #3501)

The maker's price-move guard (#3358) lets an offer refuse a fill unless both of its assets have an hourly price checkpoint for each of the last two hours. The keeper's price checkpoint pass wrote checkpoints only for the assets of active loans, so a guarded offer in a pair no loan used could never be filled, however calm the market. For the guard a missing checkpoint is not the safe direction it is for the forced-sale floor: it blocks the offer outright.

The pass now also records both assets of every open offer that carries a guard. The shared indexer names the open, unexpired offers whose two legs are ERC-20 (the only offers a guard can be set on), and the Diamond decides which of them carry a guard, read at the same block the run reads its checkpoints at. An offer whose guard was cleared, or whose guard row outlived the offer, is left out.

Each source of assets is read on its own. If the indexer cannot be read for loans, guarded offers are still worked, and the other way round, with the failure named in the run line. On a Diamond from before #3358 the pass says it carries no guard and still writes the loans' assets. The run line now also states how many open offers carry a guard.

Nothing else changes: the pass still sends only assets with no checkpoint for the hour and a price that reads, in the same bounded batches, and it still ships disarmed behind `PRICE_CHECKPOINT_ENABLED`. Advances #3358.

> Caveat: the guard and the pass reach the testnets only at the next all-waves fresh deploy; until the pass is armed there, a guarded offer in a pair nothing else checkpoints cannot be filled.
