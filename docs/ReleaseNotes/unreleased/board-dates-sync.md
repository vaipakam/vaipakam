## The board's Roadmap gets start and target dates

The hourly label sync now also fills two issue fields that the owner created for the Roadmap view: Start Date and Target Date.

Start Date is when work began. For a pull request it is the day it was opened. For an issue it is the earlier of the day its first linked pull request was opened and the day it was first labelled `stage:building`, or the day the issue was opened when neither exists. Target Date is the day an issue or pull request closed. Open items get no invented target date, a value set by hand on an open issue stays, and a reopened item loses only the close date the job wrote.

The job uses the workflow's own token over REST only, writes only values that differ, and caps its reads and writes per run, so the first fill of the whole board spreads over about a dozen hourly runs.
