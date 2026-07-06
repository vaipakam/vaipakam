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

Operators are notified of each new ticket over the internal ops
channel — the notification carries the ticket number and context
flags only, never your message text or email — so a ticket is seen
even if the follow-up email is never written. The Privacy Policy
gains a matching "Support tickets" section (what a ticket stores,
the optional reply email, the metadata-only operator notification,
and the retention window), and support tickets join the nightly
off-chain backup set so a storage incident cannot silently drop
them. In builds where no support backend is configured, the panel
says so and offers the email path — it never pretends.
