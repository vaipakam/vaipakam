### Fewer wallet prompts: gasless Permit2 approvals (alpha02)

Posting an offer, accepting one, renting an NFT, and depositing VPFI
previously needed a separate token-approval transaction before the
real one. For wallets that already hold a standing Permit2 approval
for the token — set once by the first Permit2-based app the wallet
ever used, such as Uniswap — that approval transaction is now
replaced by a free Permit2 signature (#1038):

- Posting an offer becomes one signature plus one transaction — no
  waiting for an approval to mine between prompts.
- Accepting an offer or renting becomes two instant signatures (the
  terms consent and the permit) plus one transaction — a single gas
  payment.
- The permit path itself never needs the double-approval dance some
  tokens force (resetting an old approval to zero first) — it only
  engages when no approval exists at all. A wallet holding a leftover
  partial approval keeps the classic sequence, including that
  clean-up reset.
- Hygiene bonus: a permit authorises one exact pull and expires in 30
  minutes — no standing allowance is left behind.

The permit path only engages when both preconditions hold, checked
live at submit time: no approval for the protocol exists at all (with
a sufficient standing allowance the app keeps the single-transaction
classic path — fewer prompts still; and a leftover partial allowance
also keeps the classic path, so its clean-up step still resets the
stale approval rather than leaving it behind), and the wallet's
Permit2 approval covers the amount (without it the permit variant
cannot work on-chain, so attempting it would only waste a doomed
transaction). Wallets without a Permit2 approval never see a permit
prompt and keep exactly the flow they had before. If the wallet
declines the permit signature — or can't produce one — the app falls
back to the classic approve-then-act sequence automatically: the new
path is an upgrade, never a gate. The pre-submission confirmation
count shown on the review never under-promises: the permit path
matches it or finishes early, and if a declined permit prompt forces
the classic sequence, the live step counter widens to count the extra
interaction honestly instead of repeating a step.

One safety subtlety carried deliberately: the automatic fallback ends
at the signature step. Once the permit transaction itself has been
handed to the wallet, any failure surfaces as an error instead of
silently retrying the classic way — an ambiguous network failure
could sit on top of a transaction that still confirms (executing the
action twice), and a definite rejection usually means the action
itself can no longer succeed, so a classic retry would only pay for
an approval it cannot use. Retrying manually re-runs all the checks.
