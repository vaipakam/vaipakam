## Thread — Forced close-out says when internal matching is switched off (PR #<n>)

The lender's forced close-out card warns, on every state a match could
overtake, that the protocol looks for an opposing position at the moment the
transaction runs and may settle the loan that way instead. On a deployment
with internal matching switched off, that cannot happen: the protocol never
looks. The card used to say it anyway, because the only read it had was "is
there a candidate", which answers no in both cases.

The card now reads the deployment's internal-matching setting in the same
block as every other fact behind it. When the setting is off, the warning is
replaced by a plain statement that internal matching is switched off on this
deployment, so the outcome described is the one that happens unless that
setting changes before the transaction runs, and the matcher-incentive line
(paid only by a match) is withheld. When the setting is on, or cannot be read
(for example on a Diamond built before the setting had a read), the card is
unchanged. The routing decision itself does not change: the candidate read
already accounted for the setting. Closes #2082.

> Caveat: a Diamond without the setting's read keeps the "a match may appear" warning, which is true whichever way the setting stands.
