### alpha05: a one-size offer no longer promises to fill in parts (#3520)

The guided Borrow and Lend forms offered "Partial" and "Immediate or cancel" even when the amount had one size. The protocol fills a match only between an offer's smallest and largest amount, so an offer of one size only ever fills whole, whatever its fill mode says.

Now one rule in the posting model decides it for both forms. A fill mode that fills in parts needs a range. Without one, the form shows "All or none" as the mode, greys the other two with the reason, and posts the offer as all or none, which is what it does. With a range, the form carries the mode chosen for it, as before. The review states a fill mode only for a range, where it is a choice.

The desk order ticket already applied this rule through its smallest single fill. Offers posted before this change keep the mode they were posted with; they fill the same way.

Closes #3520
