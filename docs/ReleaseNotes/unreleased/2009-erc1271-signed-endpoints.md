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
the signed request names — any network the service can talk to,
whether or not Vaipakam is deployed there, since the check needs
only the account's own contract — or, for the erasure requests, whose frozen
wording predates the idea of naming a network, the network the app
sends alongside, which chooses only where the check runs and never
what it proves. The detection workaround in the erasure card is gone:
every account type gets the signature controls.

One distinction is kept deliberately honest. When the service cannot
REACH the account's network to check a signature, it says so — a
dedicated "could not verify right now" answer, with its own message
in the app — rather than calling the signature invalid, which it has
no grounds to say and which would send the user into retries that
cannot succeed. That honesty is defended in depth: the service makes
the verification call itself, so a network refusing or failing that
call reaches it as exactly that — never disguised as a wrong
signature; a network must prove it is the network the request named
before either answer counts; and when a request names no network,
the number the service will consult is capped — with the capped case
also reported as "could not fully check", never as a rejection a
skipped network might have contradicted.

The on-chain checks also cost the service calls to networks it pays
for, on requests nobody has yet proven anything about — so they are
metered per caller, the way the service's other abusable surfaces
already are. An ordinary wallet's instant verification is never
charged against that budget.

Authority proven by one network's account contract stays scoped to
that network. A smart account can have different controllers on
different networks, so a signature its Base contract approved must
not disturb what its Arbitrum contract governs: unlinking Telegram
alerts under such a signature disconnects that network's alerts
only, and an erasure request erases that network's records only —
with the signed wording, the service's confirmation, and the app's
message all saying that scope plainly, so nobody reads a one-network
action as a wallet-wide one. The confirmation NAMES the network the
service says it covered — never "the network you are connected to",
because the wallet can be on a different network by the time the
message renders. An ordinary wallet's signature proves
the one keyholder everywhere and keeps the wallet-wide behaviour.
The retention check still answers for the wallet as a whole: legal
holds have no per-network granularity for the answer to narrow to.

The admin-only legal-hold endpoint keeps its ordinary-wallet-only
verification by design: that flow derives WHO is calling from the
signature itself, which only ordinary signatures can do, and the
protocol admin is an ordinary wallet.

Closes #2009.
