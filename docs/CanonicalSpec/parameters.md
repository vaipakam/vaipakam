# Parameters

Every figure of the platform is stated here, once, and the statements name it by id.
A figure marked "proposed" is not yet confirmed by the owner. "To be stated" and "to confirm"
mark a bound or a figure that the domain owning it will state.
The ids are permanent.

| Id | Name | Value | Unit | Bounds | Changed by | Delay | Used by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRM-001 | The escape period | 7 | days | 7 to 10, and never shorter than the vault code wait | The admin | Applies only to pauses that start afterwards | VLT-091 |
| PRM-002 | The vault code wait | 7 | days | Fixed | Nobody. A longer wait needs a new version registry | None | Section 3 |
| PRM-003 | The widest sale slippage a vault accepts | 2,500 | basis points | Fixed in the vault code. It equals the ceiling of the sale slippage setting, and a test holds the two equal | Nobody. A new figure needs new vault code | The vault code wait | VLT-040 |
| PRM-004 | The widest liquidation discount a vault accepts | 1,500 | basis points | Fixed in the vault code. It equals the ceiling of the thinnest tier's discount setting, and a test holds the two equal | Nobody. A new figure needs new vault code | The vault code wait | VLT-020 |
| PRM-005 | The longest delay a protected account may choose for its payouts | 5 | days | 2 to 5. Always shorter than the vault code wait | The account's owner, within the bounds. The upper bound: nobody, short of a new version registry with a longer wait | The account's own delay, to lower it | VLT-223, VLT-400, VLT-401, VLT-402 |
| PRM-006 | The longest pin delay that protection sets | 2 | days | Fixed. Only the owner's own authorization raises a vault's pin delay further | The protection settings, up to this figure | The pin delay in force, to lower it | VLT-232 |
| PRM-007 | The earlier conduits one version of the vault code may list | 2 | conduits | Fixed in the vault code | Nobody. A new figure needs new vault code | The vault code wait | VLT-241 |
| PRM-008 | The most versions of the vault code registered and not revoked at once | 8 (proposed) | versions | Fixed in the version registry | Nobody. A new figure needs a new version registry | None | VLT-226, VLT-229 |
| PRM-020 | The read budget handed to each read of a guard that is not the guard in force | Not fixed. Set at the build, from the measured cost of the heaviest read | units of the network's fee measure | Fixed in the platform's code | Nobody. A new figure needs a code change | None | PRC-040 |
| PRM-023 | A feed's least answer | None by default | the feed's own units | Above nil | The guard's owner, feed by feed | The guard's delay | PRC-103 |
| PRM-024 | A feed's own update window | Set with the feed's entry | hours | Never above the window the feed publishes on, and never above 24 hours. The most is fixed in the price guard's code | Whoever changes the register of feeds | The register's delay | PRC-104 |
| PRM-028 | The freshness limit of the cross-check's reading | 300 | seconds | 60 to 3,600 | The guard's owner | The guard's delay | PRC-110 |
| PRM-029 | The cross-check tolerance | 500 | basis points | 100 to 2,000 | The guard's owner | The guard's delay | PRC-110 |
| PRM-030 | How sure of itself the cross-check's reading must be | 100 | basis points | 50 to 500 | The guard's owner | The guard's delay | PRC-110 |
| PRM-031 | The secondary tolerance | 500 | basis points | 100 to 2,000 | The guard's owner | The guard's delay | PRC-120 |
| PRM-032 | The freshness limit of a secondary source's reading | 1 | hour | 60 seconds to 29 hours | The guard's owner | The guard's delay | PRC-120 |
| PRM-033 | The dispute buffer | 20 | minutes | Fixed | Nobody. Shortening it would reopen the gap it closes | None | PRC-123 |
| PRM-034 | The recovery window after a sequencer outage | 1 | hour | Fixed (proposed) | Nobody. A new figure needs a new guard (proposed) | The wait of a replacement | PRC-135 |
| PRM-035 | The largest rise of an exchange rate in a day | Set with the rate binding | basis points a day | To be stated with the binding's range | The guard's owner, binding by binding | The guard's delay | PRC-151 |
| PRM-036 | The largest single fall of an exchange rate | Set with the rate binding | basis points | To be stated with the binding's range | The guard's owner, binding by binding | The guard's delay | PRC-152 |
| PRM-037 | The observation time before a fall is confirmed | 6 | hours | A bounded setting of the guard, range to confirm | The guard's owner | The guard's delay | PRC-152 |
| PRM-038 | The freshness limit of a cross-check reading for an asset | 60 (proposed) | seconds | To be stated, and never above PRM-028 | The guard's owner | The guard's delay | PRC-111 |
| PRM-039 | The price guard's delay | 7 | days | 7 to 14 on a production network | The guard's owner | The delay in force when the change is proposed | PRC-201, PRC-210, PRC-213 |
| PRM-040 | The wait of a removal of a source | 48 | hours | To confirm | Nobody. Fixed in the price guard's code (proposed) | The wait of a replacement | PRC-213 |
| PRM-041 | A retirement's notice | 7 | days | Stated in each proposal, and never below the figure | Nobody. Fixed in platform code (proposed) | None | PRC-260, PRC-262, PRC-263 |
| PRM-042 | The most unretired price versions of a guard | 6 (proposed) | versions | Fixed in the price guard's code (proposed) | Nobody. A new figure needs a new guard | The wait of a replacement | PRC-235, PRC-254 |
| PRM-043 | The settling time | 2 (proposed) | hours | To be stated. Never shorter than the time the hourly checkpoints need | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-272, PRC-273 |
| PRM-044 | The floor's wait | 24 (proposed) | hours | Never shorter than the settling time | Fixed in the price guard's code (proposed) | The wait of a replacement | PRC-271 |
| PRM-045 | The price tolerance | 1% (proposed) | of a price | To be stated | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-270, PRC-316, PRC-322, PRC-325, PRC-341, PRC-351 |
| PRM-046 | The check window | 1 (proposed) | hour | To be stated | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-270 |
| PRM-047 | The register's delay | 7 | days | 7 to 14 on a production network | The register's owner | The delay in force when the change is proposed | PRC-220, PRC-223 |
| PRM-048 | The register's grace | 1 | hour | Fixed | Nobody | None | PRC-221 |
| PRM-049 | The wait of a replacement of the price guard that keeps the unit | To confirm | days | Never shorter than the guard's delay (PRM-039) or the vault code wait (PRM-002) | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-312 |
| PRM-050 | The unit change wait | 14 (proposed) | days | Never shorter than the vault code wait (PRM-002). To be stated | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-312, PRC-360, PRC-362, PRC-410, PRC-412 |
| PRM-051 | The rate drift cap | 5% (proposed) | of a rate | To be stated | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-325 |
| PRM-052 | The older-loan period | 30 (proposed) | days | Never shorter than the settling time (PRM-043) | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-350 |
| PRM-053 | The silence time before a second key ends for an asset | 2 (proposed) | hours | To be stated | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-356 |
| PRM-054 | The most second keys a loan may hold | 5 at the proposed figures | keys | The older-loan period over the shortest wait of a replacement, rounded up | Nobody. It follows from PRM-049 and PRM-052 | None | PRC-355 |
| PRM-055 | The fixed range of the rate of one change of unit, and of the scale after it | To be stated | a rate | Fixed in platform code (proposed). Wide enough for any real pair of units, narrow enough that no figure overflows or rounds to nothing. The scale's range is wider than one rate's | Nobody | None | PRC-411 |
| PRM-056 | The cool-down after a change of unit | 180 (proposed) | days | To be stated | Nobody. Fixed in code (proposed). Each proposal states the figure it runs under | None | PRC-412 |
| PRM-057 | The band a register entry's implied price must lie within | One third to three times a reference price (proposed) | a ratio | Fixed in platform code (proposed). Wide enough that a real feed for the asset always passes, narrow enough that an entry one decimal place out fails | Nobody. Fixed in code (proposed) | None | PRC-224, PRC-225 |
| PRM-058 | The floor size of the depth test | 5,000 | the unit | To be stated by the authority rules | Governance | The delay of the setting | PRC-500, PRC-510, PRC-540, PRC-615, PRC-630 |
| PRM-059 | The depth budget: the most a test sale may lose against the guard's price | 2 | percent | To be stated | Governance | The delay of the setting | PRC-510 |
| PRM-060 | The three tier sizes of the depth test | 50,000, 500,000 and 5,000,000 | the unit | To be stated. Each above the one before | Governance | The delay of the setting | PRC-510, PRC-520, PRC-630 |
| PRM-061 | The fee cap of a pool that counts | 0.3 | percent | To be stated | Governance | The delay of the setting | PRC-511 |
| PRM-062 | The averaging window of a pool's depth and price | 30 | minutes | To be stated | Governance | The delay of the setting | PRC-513, PRC-519 |
| PRM-063 | The consistency band of a pool's price | 3 | percent | To be stated | Governance | The delay of the setting | PRC-515 |
| PRM-064 | The time at depth before a confidence tier rises a step | 24 (proposed) | hours | To be stated | Governance | The delay of the setting | PRC-521, PRC-524, PRC-527 |
| PRM-065 | The confidence age: how long a confidence tier stands without renewal | 2 (proposed) | hours | To be stated. Longer than one interval of the keeper's pass | Governance | The delay of the setting | PRC-524, PRC-527, PRC-529 |
| PRM-066 | The exposure limit: the most pledged in one asset, as a multiple of its measured depth | 20 (proposed) | times | Above the high threshold of concentration | Governance | The delay of the setting | PRC-540 |
| PRM-067 | The stop time: how long the guardian's stop of one asset's price holds | 24 (proposed) | hours | To be stated. Short enough that a stop is no freeze | Nobody. Fixed in code (proposed) | None | PRC-214, PRC-216 |
| PRM-068 | The most assets whose price is stopped at one time | 3 (proposed) | assets | To be stated | Nobody. Fixed in code (proposed) | None | PRC-214 |
| PRM-069 | The health floor of a new loan | 1.5 | a ratio | 1.2 to 2.0 | Governance | The delay of the setting | PRC-611, PRC-615 |
| PRM-070 | The lower health floor of a new loan while the tier caps are on | 1.0 | a ratio | Fixed | Nobody | None | PRC-611 |
| PRM-071 | The default cap of each tier on a new loan's loan-to-value | 50, 60 and 65 | percent | Never above the tier's ceiling (PRM-072) | Governance | The delay of the setting | PRC-612 |
| PRM-072 | The ceiling of each tier's cap | 55, 69 and 82 | percent | Above zero, never above the hard ceiling of 82, and not falling from the first tier to the third | Governance | The delay of the setting | PRC-612, PRC-617 |
| PRM-073 | The haircut taken off each tier's peer reading | 0, 0 and 5 | percentage points | At most 10 | Governance | The delay of the setting | PRC-613 |
| PRM-074 | The usable age of a peer reading | 14 | days | To be stated | Governance | The delay of the setting | PRC-612 |
| PRM-075 | The agreement band between the platforms read for a reference asset | 30 | percentage points | To be stated | Governance | The delay of the setting | PRC-613 |
| PRM-076 | The liquidation line of each tier | 80, 85 and 90 | percent of loan-to-value | Bounded ranges to be stated, and not falling from the first tier to the third | Governance | The delay of the setting | PRC-614 |
| PRM-077 | The step taken off a cap: for collateral with no tier, and at high concentration for the shallowest tier | 10 | percentage points | 5 to 25 | Governance | The delay of the setting | PRC-615, PRC-632 |
| PRM-078 | The caution threshold of concentration | 5 | times the size | 2 to 20 | Governance | The delay of the setting | PRC-631 |
| PRM-079 | The high threshold of concentration | 10 | times the size | Above caution, at most 50, and below the exposure limit (PRM-066) | Governance | The delay of the setting | PRC-632 |
| PRM-080 | The calm bound: how far a pair's rate may lie from the hourly checkpoint of each of the two hours before the current one | 2 | percent | To be stated | Governance | The delay of the setting | PRC-621, PRC-641 |
| PRM-081 | The coverage a tight floor needs: collateral value against all the loan owes | 110 | percent | To be stated | Governance | The delay of the setting | PRC-621, PRC-650 |
| PRM-082 | The tight floor of a forced sale for each tier | 4.5, 3.5 and 2.5 | percent | Each at or above the least of 1 percent (proposed) and below the most a forced sale may lose, and not rising from the first tier to the third | Governance | The delay of the setting | PRC-621, PRC-650 |
| PRM-083 | The least cap for collateral with no tier, also at high concentration | 20 | percent | 10 to 40, below the lowest default cap of a tier, and below the lowest liquidation line by the margin (PRM-084) | Governance | The delay of the setting | PRC-615, PRC-618, PRC-632 |
| PRM-084 | The least margin between a cap for collateral with no tier and the lowest liquidation line of any tier | 10 | percentage points | 5 to 30 | Governance | The delay of the setting | PRC-618 |
| PRM-085 | The least idle period of a Ready balance | 1 | day | Fixed | Nobody | None | VLT-329, VLT-331 |
| PRM-086 | The longest idle period of a Ready balance, and the furthest ahead a Ready balance may be kept counting | 30 | days | Fixed | Nobody | None | VLT-329, VLT-330, VLT-331 |
| PRM-087 | The most signers a protected account may have | 5 | signers | Fixed | Nobody | None | VLT-430 |
| PRM-088 | The most destinations a protected account may name | 5 | destinations | Fixed | Nobody | None | VLT-440 |
| PRM-089 | The least signers an account needs before their majority may replace its owner wallet | 3 | signers | Fixed | Nobody | None | VLT-450 |

The sale slippage setting that lies inside PRM-003, and the liquidation discount of each tier
that lies inside PRM-004, are other parameters. They are owed by the close-out rules.
