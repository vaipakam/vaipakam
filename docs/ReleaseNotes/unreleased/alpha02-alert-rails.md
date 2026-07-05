## Thread — Telegram alerts arrive in the retail app, framed as outcomes

The retail app's Settings now carries an Alerts card. Linking Telegram
takes one tap (or copying a short code to the bot), and from then on
the platform can reach the user while the site is closed — which is
when repayment deadlines and loan risk actually happen. The controls
are plain-language outcome toggles — "message me before an interest
payment comes due", "message me if my loan gets risky" — with
sensible risk thresholds behind them; the raw health-factor numbers
are editable only in Advanced mode, using the same defaults the pro
app exposes directly. Switching the risk toggle off still leaves one
last-moment warning right before a loan would be liquidated, and the
card says so. The interest-payment toggle is a REAL opt-out: the
alert service now stores it and BOTH due-date lanes honor it before
sending anything — the interest-payment reminder and the pre-grace
"no refinance match found" warning alike.

The card carries one honest privacy sentence — linking stores the
wallet address, the alert preferences from the card, and the
Telegram chat id on the alert service, plus a small delivery record
per alert sent (which loan, which level, when) so the user is never
messaged twice about the same event — and an Unlink that actually
removes the Telegram connection: the alert service gained a
dedicated unlink endpoint alongside this feature, and unlink stays
reachable even for a wallet linked from another device. Starting a
link — and unlinking — now asks the wallet for a free signature
first: proof the request comes from the wallet's owner, so nobody
can point another wallet's alerts at their own Telegram chat, and
nobody can silently switch off another wallet's risk warnings
either. The pro app's alerts page gained the same proof step for
linking.
A borrower viewing their active loan sees a one-line nudge pointing
at the alert setup. Users who prefer wallet-native push can enable
Push delivery (recorded service-side) and open the platform's Push
Protocol channel from the same card — both halves of what Push
delivery actually requires. In builds where no alerts backend is
configured, the card says exactly that and sends nothing — the
feature fails closed rather than pointing at the wrong environment.

No "something to claim" toggle ships yet on purpose: the backend has
no claim-ready detector, and the retail surface does not promise
messages that cannot arrive.

Due-date reminder messages now deep-link to the loan page every
current app actually serves (`/loans/N` on the pro app, aliased on
the retail app) instead of a historical URL shape that landed on a
not-found page.
