### Send a support ticket from inside the app (alpha02)

The Support panel (the round button in the corner of every page) can
now send a message straight to the team (#1040 phase 1):

- Write what happened in your own words, optionally leave an email
  for a reply, and send — you get a ticket number back immediately.
- With one explicit tick, the report attaches the panel's own health
  details (network, connection checks, app version, the last recorded
  error) — the details that usually hold the cause. Nothing is
  attached without that tick, and your full wallet address is never
  part of the health details.
- Prefer email, or want to add more later? Every path offers a
  prefilled email to support@vaipakam.com carrying your ticket
  number, and the Help page gains a "Need a human?" section with the
  same address.
- Honest failure states: if too many messages went out, the panel
  says to wait a minute; if the support inbox can't take the message,
  it says nothing was lost and hands you the email path instead —
  the app never claims a ticket number it didn't get.
- What sending stores is stated next to the button, before anything
  is sent: the message, the reply address if given, the consented
  health details, and the ticket number.

- What sending stores also names the page and network context that
  travels with every ticket, so nothing rides along unstated even
  when the health-details box is left unticked.

Operators are notified of each new ticket over Telegram (the
operations alert channel) — the notification carries the ticket
number and context flags only, never your message text or email —
so a ticket is seen even if the follow-up email is never written. A
failed alert is retried once, and a daily operational report of
open tickets backstops it, so a ticket can never sit unseen
indefinitely. Wallet addresses in the page field and health details
are shortened again on the server, whatever the sending app did.
Tickets are deleted automatically no later than 12 months after
submission (earlier on request). The Privacy Policy gains a
matching "Support tickets" section and now names every processor
involved: Telegram for the metadata-only operator alert, and
Backblaze for the encrypted nightly backups (ciphertext only) that
support tickets join alongside the other off-chain records — so a
storage incident cannot silently drop them, and the restore runbook
covers them too. In builds where no support backend is configured,
the panel says so and offers the email path — it never pretends.
