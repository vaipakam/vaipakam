## Thread — Position receipts never read as live, and a refinance request stays dead after a handover (branch, no PR yet)

A position token whose position has closed stays with its holder as a receipt. Some paths retire a token without first marking it closed: one example is the borrower token of a matched loan that leaves nothing for the borrower. Such a receipt could still read "Governs Claim Rights: Yes" in its metadata, even though anyone can transfer it. Now every retired token reports a closed position, in its metadata and in the position summary the app reads. The loan's own state still shows what happened to the loan.

A borrower's refinance request lasts only while the borrower position has not moved since the request was recorded. The check compared the token's transfer count, but the count belongs to the token. An obligation handover gives the loan a new borrower token whose count starts at zero again, and that could make a dead request stand again. The request now also records which token it was made against, and a different token counts as moved.

Two other findings from the same review need no change. The position views already skip retired tokens and have paginated forms, which the apps use. The relist cooldown after a dead sale listing is cancelled stays as it is: dropping it when the position moved would let a seller move the token to a second wallet, cancel, and relist at once, which is exactly what the cooldown is there to stop. A genuine new holder waits at most one day to list, and can still sell directly at once.

Advances #3339.
