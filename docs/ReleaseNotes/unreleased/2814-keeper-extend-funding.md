## Keeper — the extension pass names an unfunded extension (PR #3073)

A borrower can now keep a reserve for a loan's automatic extensions (#2814).
An extension draws that reserve first, then the holder's other free balance
of the loan's asset, and is refused if the two together fall short of what
it charges.

The keeper's extension pass now checks this before it tries. For a loan
whose two sides have consented and whose extension window is open, it asks
the protocol what the current borrower-position holder has ready and what an
extension now would charge. If the reserve and the other free balance
together fall short, it skips the loan and logs the three figures and the
asset, so an operator can see why the loan was not extended. Before, the
same loan was refused at the send's gas estimate with a generic reason.
Nothing was broadcast in either case, so no gas was ever spent on it.

A deployment built before the reserve has no way to report funding. There the
pass says once per run that the pre-check is off, and the send's estimate
still refuses an unfunded extension. The holder is taken from the borrower's
consent itself, which the protocol only reports as active while its setter
still holds the position, so the check costs one read per candidate loan.

Follows #2814 (closed by #3071).
