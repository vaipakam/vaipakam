## Thread — The remittance-ack pass reads its ledger window in one go (PR #1994)

The keeper drives the acknowledgement that finalises each cross-chain reward
remittance. To find which remittances are still waiting, it walks a bounded
window of the reservation ledger and asks after each one in turn — up to two
hundred separate requests per tick, on a pass whose actual work, sending the
acknowledgements, is a small fraction of its traffic. The window is now read in
one request per hundred reservations. Its bounds, and the order the results are
processed in, are unchanged.

One behaviour needed preserving deliberately, and it is the reason this change
carries a test rather than just a measurement. In the old shape a failed read
threw, which abandoned the whole scan for that chain — so neither the frontier
that marks "everything below here is finished" nor the rotating cursor advanced
past a reservation whose status had never been read. A batched read does not
throw; it hands back a per-entry failure. The obvious translation, skipping the
failed entry and carrying on, would have quietly moved the cursor past an
unread reservation and dropped it from the scan until the window came round
again. So a failed entry still aborts the scan, and a test asserts that no scan
progress is recorded when one occurs.

Against the profiling fixture the pass drops from 249 requests per tick to 51.
What remains is the acknowledgement path itself, which is already capped at five
sends per tick — the share of the pass's traffic that is transaction submission
rises from 8% to about half, which is the intended shape: what is left is work,
not scanning.

Refs #1896.
