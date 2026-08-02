## alpha02 — self-sovereign Risk access page (PR #<n>)

The main app's risk-access settings now exist on the alpha02 site too,
rebuilt in its plain-language style. A new wallet-gated page, reachable
from Settings, lets each user choose how risky the assets in their
deals are allowed to be. Everyone starts at the safest level
("Blue-chip only" — the most established, deepest-liquidity assets) and
nothing moves up unless the user explicitly raises it; the two higher
levels explain in plain words what they additionally allow, including
that deals with unpriced assets settle in-kind on a default.

The page is honest about enforcement: on the current network the
protocol's enforcement switch is off, so it says the choice is saved
on-chain and that whatever level is ACTIVE at the time is what applies
once enforcement turns on — a saved higher choice that is still
cooling down, or that a risk-terms change re-locked, does not spring
into force just because enforcement was enabled.

The trust rules the main app's version earned through review carry
over: the level controls never render over a failed read (choosing a
level blind could restart a safety cooldown), a chosen-but-not-yet-
active level is labelled as "cooling down" versus "risk terms changed —
confirm again" only when the supporting on-chain reads are trustworthy,
and the one-click re-confirm is offered only in the terms-changed case.
Strict mode — an opt-in that adds one extra deliberate confirmation to
every mid-tier deal — is shown here too, with one honest limit: this
app can't collect that extra confirmation yet, so turning strict mode
ON is not offered (it would lock the user out of their own mid-tier
deals once enforcement is on). Turning it OFF always works here — the
recovery path for anyone who enabled it in the main app — including
the note that a recent turn-off keeps the extra confirmation in force
through the safety cooldown.

The page ships with unit tests for the state classification and an
automated end-to-end test that drives the real contract on a forked
network: raising the level, lowering it back, and disabling strict
mode from a vault that had it enabled.
