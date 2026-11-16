### Alerts for standing instructions (#3681)

Borrowers who leave standing instructions on a loan can now be told, on
Telegram and Push, three things about them: the reserve an instruction pays
from is too low for what it will next pay, a collateral top-up ran, or an
instruction was tried and skipped without moving anything.

Each message states only what the chain showed. A short payment reserve says
by how much and when the payment is due, and what the instruction will then do
(a repayment runs only when the reserve covers all of it; an interest payment
pays what is there and the rest stays owed). A top-up states the amount moved,
the health factor before and after, and what is left in the reserve; an after
figure that could not be read is said to be unread. A skip names the reason.
The messages are written in all ten supported languages.

This release adds the message shapes and their wording to the alert service.
The keeper sends them once its standing-instructions pass reports them, which
ships with the contract batch and stays switched off until an owner arms it.
