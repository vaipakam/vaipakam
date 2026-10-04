## Thread — Typed amounts are sent exactly as typed, everywhere (PR #<n>)

The take-back-collateral form (#2389) was the first to refuse an amount with
more decimal places than its token allows instead of quietly rounding it. This
change brings every other money input in the connected app onto the same rule:
the offer amount and collateral on the guided lend and borrow forms, the Rate
Desk order ticket and its amend fields, adding collateral, partial repayment,
the offset exit's collateral, VPFI deposits and withdrawals, the rental daily
fee, both Full-tariff fee ceilings, and the stuck-token recovery amount.
Before, most of these fed the typed text through a parser that rounds, so a
review could echo one figure while the transaction carried a slightly
different one.

Each of those inputs now shows one shared hint when the amount is too
precise, naming the token and how many decimal places it accepts, and the
step or button that would act on it stays unavailable until the amount is
fixed. The shared offer builder refuses such an amount outright as a
backstop, so no path can turn it into a rounded offer. The add-collateral and
partial-repayment actions now send the exact amount the review showed rather
than re-reading the text box at signing time.

A new unit test fails the build if any app source imports the rounding parser
again. The only exception is the faucet, which mints fixed whole-unit
presets that nobody types. Closes #2390.
