## Thread — the accept-time token screen is now proven on Anvil (PR #PRNUM)

The signed-fill card's token screen, added in #2726, was covered only by unit tests of its rules. A new end-to-end scenario now drives the card itself against one signed order on the local Anvil chain, with the token-security service mocked to answer each case. It shows that a blocking verdict holds the Fill button even with consent ticked; that a check which cannot run holds the button, offers "Check again", and voids any consent given while it was held; and that a warning which changes after the user consented is refused before the wallet is asked to sign anything, after which the card shows the new warning and the order fills once the user consents to what is now shown.

The GoPlus-screened test server and its mock now live in one shared helper, used by both this scenario and the existing token-badge scenario, so the two cannot drift apart. No app behaviour changed. Closes #2934.
