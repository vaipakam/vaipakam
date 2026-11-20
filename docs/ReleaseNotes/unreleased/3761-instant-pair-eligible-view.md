## Thread — Instant-market pair eligibility read (PR #3768)

Anyone can now ask the contracts whether the instant market serves a pair. The answer states two things separately: whether the market's switch is on, and whether the pair qualifies (two different assets, both blue-chip). The lend form that opens on Auto-lend with instant-market consents pre-selected (#3761) needs this answer before it shows the consents. Until now the app could get it only by trying the consent write and reading which refusal came back.

The read uses the one pair rule that the consents and the instant borrow already enforce; it is not a second copy, so the read cannot disagree with them. A pair that qualifies reads as qualifying even while the market is switched off, so the app can tell "not offered here" apart from "switched off for now".

Advances #3761.
