## Keeper — the "delivery not whole" alert counts from when the keeper found it (PR #TBD)

The keeper warns the operators when a reward-budget delivery that has reached a mirror is still not fully indexed or proven. It allowed ten minutes from the delivery's arrival. On Arbitrum Sepolia the first two batch deliveries were indexed 8.8 and 9.4 minutes after they arrived, one slow scan away from a false alarm. BNB Testnet's took 4.4 minutes.

The cause is where the keeper learns about a delivery. It reads the indexer's record, and the indexer records a block only once the chain calls it settled. Arbitrum declares blocks settled minutes after they are made, because that waits on its posting to Ethereum; BNB does so almost at once. So on Arbitrum the keeper first saw each delivery one scan later, and most of its ten minutes had gone before it could act. This is inferred from the indexer's settled-block rule and the scan times; the settled-head lag itself was not measured here.

The allowance now starts when the keeper first finds the delivery, measured on the keeper's own clock: a delivery is reported only if the scan that found it and the next full scan both leave it incomplete. The bound sits half a scan away from the scans on either side of it, so a late or early scan cannot tip a normal delivery into an alert. The alert names when each delivery arrived and when it was found. A delivery the indexer has not recorded yet raises nothing from this alert, as before. The keeper's scheduled passes whose alerts are measured in scans are now scheduled from their own cadence, so the two can no longer disagree. Nothing on chain changes.

Closes #2775.
