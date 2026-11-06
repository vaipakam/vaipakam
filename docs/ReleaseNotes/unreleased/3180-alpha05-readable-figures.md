# The next app's review table reads cleanly, with shortened figures

The review shown before signing in the next app was hard to read: a long label set the width of the label column and squeezed every value into a narrow strip, and long token amounts broke across lines in the middle of a number. Labels and values now sit in two even columns with a hairline between rows, a number never breaks across lines, and on a phone each label sits above its value.

Token amounts are now written for reading across the app: digit groups (1,000 rather than 1000), and the fraction shortened to four places once there is a whole part, or to four significant digits below one. The cut is always toward zero, never rounded up, so a small amount never reads as zero. A shortened figure is marked approximate (≈), and a review that holds one offers "Show exact figures", which shows every digit in place. A figure the protocol acts on exactly as written, such as an approval or the tariff ceiling, is always shown in full.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-FUNDS. Epic #3180.
