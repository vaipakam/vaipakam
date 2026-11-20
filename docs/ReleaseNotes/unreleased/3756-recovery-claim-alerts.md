# Recovery claim alerts (#3756)

When the recovery address of a protected account asks for the account, the owner and every signer now hear about it on Telegram and Push: when the claim is asked for, at the half-way point of its wait, seven days before and one day before it may run. They also hear how it ended: cancelled (and by whom), dropped (and why), lapsed, or run. Each message carries the claim's own times, which never move, and a link to the app where the claim can be cancelled.

The claim is held by the account's vault, whose events the indexer does not yet record, so the keeper reads each protected account's vault directly, a slice of accounts per scan, and keeps what it has announced. A reminder that comes due while the keeper is down is not sent late: a "seven days left" is only sent within half a day of its time. When the vault's own record of why a claim ended cannot be read, the message says so rather than naming a reason.

The alerts are part of the protected-account pass's owner alerts step and ship disarmed, under the existing `PROTECTED_ALERTS_ENABLED` flag. Arming them is the owner's step.
