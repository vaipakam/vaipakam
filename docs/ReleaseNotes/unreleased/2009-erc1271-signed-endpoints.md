## Smart-contract wallets can now use every signed control (PR TBD)

Every signed request the support service accepts — the diagnostics
erasure and its retention check, linking and unlinking Telegram
alerts, the test alert, muting due-date reminders — used to be
verifiable only for an ordinary wallet: the service recovered a plain
signature and required it to match. A smart-contract wallet account —
a Safe, a smart wallet, deployed or not yet deployed — signs
differently, by having its own on-chain account approve the message,
and every one of its requests ended in failure. The erasure card
worked around it by detecting such wallets and pointing them at
email; the alert controls did not even do that.

The service now verifies those signatures properly, against the
network the account lives on, through one shared verifier used by the
whole family. An ordinary wallet's signature still verifies instantly
with no network call; a smart account's is checked with the network
the signed request names — or, for the erasure requests, whose frozen
wording predates the idea of naming a network, the network the app
sends alongside, which chooses only where the check runs and never
what it proves. The detection workaround in the erasure card is gone:
every account type gets the signature controls.

One distinction is kept deliberately honest. When the service cannot
REACH the account's network to check a signature, it says so — a
dedicated "could not verify right now" answer, with its own message
in the app — rather than calling the signature invalid, which it has
no grounds to say and which would send the user into retries that
cannot succeed.

The admin-only legal-hold endpoint keeps its ordinary-wallet-only
verification by design: that flow derives WHO is calling from the
signature itself, which only ordinary signatures can do, and the
protocol admin is an ordinary wallet.

Closes #2009.
