## Thread — Day-close CCIP fee ceiling (PR #<n>)

The keeper's reward day-close pass pays a CCIP fee on three kinds of send: a mirror's daily report to Base, and Base's broadcast of each finalized day, to every mirror or to one. Until now it paid whatever the reward messenger quoted, and the messenger's fee settings are governance-controlled. A fee set wrong, or by a compromised owner, would have been paid from the keeper's unattended key up to eight times per chain per run. No protocol funds were at risk, only the keeper's gas wallet, but the spend had no bound.

The pass now has a per-chain ceiling on what one send may pay, the plain setting `REWARD_DAY_CLOSE_MAX_FEE_WEI`. It takes comma-separated `chainId=wei` entries, plus an optional `*=wei` for every chain not named. Unset, it is 0.002 of the chain's native token everywhere, about 12 to 40 times the report fees read when the pass was armed. A quote above the ceiling is not paid: nothing is sent, the standing refusal alert names the call, the quote and the ceiling, and the day stays owed until the quote falls or the ceiling is raised. A setting that cannot be parsed pays nothing on any chain and is said by the held-steps alert, never replaced by the default. Calls that pay no fee, such as finalizing a day, are not affected, so Base still finalizes a day whose broadcast is held.

The check sits in the one place every send goes through, so no step of the pass can pay past it. It bounds only the keeper's own spending; anyone may still make these permissionless calls.

Closes #2627.
