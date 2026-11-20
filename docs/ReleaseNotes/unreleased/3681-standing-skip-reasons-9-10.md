# Standing-instruction alerts name the last two skip reasons

When the platform skips a borrower's standing instruction, it records why.
Before this change, the borrower's alert covered only the first eight reasons.
A skip for either of the two newer reasons sent no alert at all.

The alert now covers both, in all ten languages:

- **Refused payment.** The interest payment was tried, but a delivery refused it, so nothing moved.
- **Sanctions-flagged wallet.** The wallet that owns the reserve is flagged by the sanctions list the platform checks, so the automatic top-up may not add collateral. The alert also says that interest payments and repayment stay open. Only the flagged wallet receives this alert.
