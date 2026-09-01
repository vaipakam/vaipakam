## Thread — You can now read a support report before sending it (PR #<n>)

The Diagnostics drawer offers to open a support report as a pre-filled GitHub
issue. The details it carries — the last error, where it happened, which
network, a shortened wallet — travel in the link itself, which means they
reach GitHub the moment the form opens, whether or not anyone goes on to file
the issue. That is the right design for a report someone has decided to send.
It puts a lot of weight on the step before the decision.

The drawer shows a summary of what it holds, and the summary is deliberately
short: it renders the first few hundred characters of an error message and
none of the technical trace, while the report carries several times more of
both. So the honest way to check a report was to copy it, read it, and then
decide whether GitHub could have it. "Copy details" was that step.

It could fail without saying anything. A browser can refuse an app access to
the clipboard — a hardened privacy setting, a denied permission, a page not
served securely — and when that happened the button did not copy, did not
report an error, and did not even change its label. Nothing was on the
clipboard and nothing said so. The only way left to see what the report
contained was to open the report, which is the act of disclosing it.

**The report is now readable in the drawer.** A "Show full report" control
displays exactly what the link would carry, so it can be read, and selected
and copied by hand, without the clipboard and without sending anything. Copy
details stays as the convenience it was always meant to be.

**And a refused clipboard now says so — and opens that view.** Reporting the
failure on its own would have been more honest and no more useful; the point
of the step is to see the report, so the failure message arrives with the
report already on screen and names the remedy that is now in front of you.

**One more button was claiming a success it had not had.** On the testnet
faucet, the button that copies a newly minted token's ID changed to "Copied."
without waiting to find out whether the copy worked, so on a browser that
refuses the clipboard it said the ID was copied when it was not. Someone told
that stops reading the ID displayed just above it and pastes whatever their
clipboard held before. It now confirms only a real copy, and otherwise points
at the ID on screen.

The two are the same mistake facing opposite ways: one stayed silent when it
should have spoken, the other spoke when it had nothing to say. A control that
reports on its own success is worth no more than the accuracy of that report.
