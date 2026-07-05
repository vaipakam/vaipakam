## Thread — Telegram alerts arrive in the retail app, framed as outcomes

The retail app's Settings now carries an Alerts card. Linking Telegram
takes one tap (or copying a short code to the bot), and from then on
the platform can reach the user while the site is closed — which is
when repayment deadlines and loan risk actually happen. The controls
are plain-language outcome toggles — "message me before a repayment or
interest payment is due", "message me if my loan gets risky" — with
sensible risk thresholds behind them; the raw health-factor numbers
are editable only in Advanced mode, using the same defaults the pro
app exposes directly. Switching the risk toggle off still leaves one
last-moment warning right before a loan would be liquidated, and the
card says so.

The card carries one honest privacy sentence — linking stores the
wallet address and Telegram chat id together on the alert service,
nothing more — and an Unlink button that actually removes it: the
alert service gained a dedicated unlink endpoint alongside this
feature. A borrower viewing their active loan sees a one-line nudge
pointing at the alert setup. Users who prefer wallet-native push can
open the platform's Push Protocol channel from the same card. In
builds where no alerts backend is configured, the card says exactly
that and sends nothing — the feature fails closed rather than
pointing at the wrong environment.

No "something to claim" toggle ships yet on purpose: the backend has
no claim-ready detector, and the retail surface does not promise
messages that cannot arrive.
