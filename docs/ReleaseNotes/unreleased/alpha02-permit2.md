### Fewer wallet prompts: gasless Permit2 approvals (alpha02)

Posting an offer, accepting one, renting an NFT, and depositing VPFI
previously needed a separate token-approval transaction before the
real one. Where the wallet supports typed-data signing, that approval
transaction is now replaced by a free Permit2 signature (#1038):

- Posting an offer becomes one signature plus one transaction — no
  waiting for an approval to mine between prompts.
- Accepting an offer or renting becomes two instant signatures (the
  terms consent and the permit) plus one transaction — a single gas
  payment.
- The double-approval case some tokens force (resetting an old
  approval to zero first) disappears entirely on the permit path.
- Hygiene bonus: a permit authorises one exact pull and expires in 30
  minutes — no standing allowance is left behind.

The permit path only engages when an approval would actually be
needed; with a sufficient standing allowance the app keeps the
single-transaction classic path (fewer prompts still). If the wallet
declines the permit signature — or can't produce one — the app falls
back to the classic approve-then-act sequence automatically: the new
path is an upgrade, never a gate. The pre-submission confirmation
count shown on the review never under-promises: the permit path
matches it or finishes early.

One safety subtlety carried deliberately: if a permit transaction was
broadcast but its confirmation timed out, the app surfaces the error
instead of silently retrying the classic way — retrying on top of a
transaction that may still confirm could execute the action twice.
