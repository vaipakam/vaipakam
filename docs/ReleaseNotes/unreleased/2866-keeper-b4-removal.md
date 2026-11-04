## Keeper — the B4 day-report path is removed (#2866)

The keeper's day-close pass carried a second report path for the live testnets, whose reward messengers and Diamonds were deployed before PR #2790 and send the older B4 day report (PR #2867). At the all-waves fresh deploy every served chain runs the one report shape (#2621), so that path is gone.

The pass now checks one thing about each end's reward messenger: whether its code carries the day-report quote. A messenger that does not, on the mirror or on Base, holds every close with the report-channel alert and says which end lacks it. An unreadable messenger also holds the close, as before. The fee is always quoted along the route `closeDay` names.

This merges with the all-waves fresh deploy. Merged earlier, the keeper would stop closing mirror days on the testnets that still run pre-#2790 messengers.
