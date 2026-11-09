## Thread — alpha05 sets up Telegram, push and health warnings (PR #3420)

The new app (alpha05) now sets up the alerts that reach a wallet outside the
app. The Alerts page has a section under the inbox for Telegram, push, health
warnings and payment reminders. Until now the page sent people to the current
app for this.

Every change is a free wallet signature over a plain message that names what
it does: link Telegram, unlink it, send a test alert, or save a setting. The
words come from the same shared source the alert service checks them
against, so what the wallet shows and what the service checks cannot differ.
A save carries only the setting it changes. The service accepts each signed
request once, and the page asks for a fresh signature when one is refused as
already used. A declined signature sends nothing.

Telegram is linked with a one-time code that lasts ten minutes. The link
counts as proven only after a test alert reaches the chat. Unlinking says
which networks it covered: every network for an ordinary wallet, or one
network for a smart-account wallet. It also says when protected mode keeps a
chat receiving alerts until the protection delay passes. Push is offered
only when the alert service says it can send right now, and the page says
when push would carry payment reminders but not health warnings. Health
warnings are always on once a channel is set up. Their three levels are
fixed in Basic and can be edited in Advanced. Payment reminders can be
switched off and on.

The alert service does not report back what it has stored, so each card
states what this browser has done and when, and says that a link or setting
made on another device may exist. Linking Telegram and switching push on ask
for the Terms first; switching anything off never does.

Advances #3180. The paid-push consent is the next part of Alerts.
