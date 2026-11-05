## The pause escape period is an admin setting

When the protocol stays under an admin pause long enough, every user may take what is theirs out of their own vault to their own wallet. That period was fixed at three days in the code. It is now an admin setting: three days by default, and anywhere from 49 hours to seven days. The lower bound keeps the escape from opening before a governance fix, which waits 48 hours in the timelock, could land.

A change applies only to pauses that start afterwards. Each admin pause records the period in force when it began, so changing the setting during a pause neither opens the escape early nor closes one users were already promised. A second pause call during the same pause keeps the recorded period too. Setting it to zero restores the default.

Anyone can read the period the next pause will use, the period of the pause now running, and the exact time the running pause's escape opens. The app's banners no longer say "three days"; they say the pause has outlasted the emergency-exit period.

Funds: nothing moves differently. The escape route's rules (what may leave, and to whom) are unchanged; only how long a pause must last before it opens is now configurable.

This adds storage fields at the tail of the pause record and new selectors, so it reaches a chain through a fresh deploy or the all-facets refresh. Closes #3173.
