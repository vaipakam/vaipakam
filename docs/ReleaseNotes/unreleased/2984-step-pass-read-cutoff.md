## Thread — reward step passes stop reading in time to send

The keeper's operating rule says every pass stops reading early enough to leave time for the actions those reads feed. Three of the reward step passes did not do this: the reward-day close-out, zeroed-day recovery and the return transport. Their reads ran right up to the run's send deadline. So a slow node could use the whole run on reads, the sends were then refused at the deadline, and the next run would repeat it.

All three now read through one shared reader. It stops every read at the run's read cutoff, which is the send deadline less the send reserve. A read not yet started is refused there, and a read still in flight is abandoned there. Either way the pass treats the value as unread and picks it up next run. Each pass used to carry its own copy of that reader; there is now one. Nothing else about the passes changes. Refs #2984.

> Caveat: the protocol upkeep pass moves onto the same reader once its own PR (#3011) merges.
