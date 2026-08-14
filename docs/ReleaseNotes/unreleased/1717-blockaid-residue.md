## Removed references to a security vendor the product no longer uses (#1717)

The pre-sign transaction preview — the panel that checks, before you approve,
whether a transaction would succeed or fail — was originally built on a
third-party scanning service, briefly moved to a second one, and now uses
neither. It runs the check directly against the chain from the browser and
reports the outcome. It does not itemise what the transaction would change;
that richer view was the departed vendor's, and describing the current panel
as showing "what a transaction will do" overstates it. That change shipped some time
ago, but references to the original vendor were left behind in several places.

Most of them were harmless bookkeeping. One was not.

A completed security due-diligence questionnaire prepared for a partner
described the product as routing transaction previews through a server-side
proxy for that vendor, and stated that the associated API keys were held
server-side. Neither is true: there is no such proxy, and there is no key. The
questionnaire's own covering text notes that access to that partner's service
can be suspended depending on the answers given, which makes an inaccurate
answer in it a different kind of problem from a stale comment.

The original wording has been struck through rather than rewritten, with a
correction recorded alongside it. That preserves what was written in case the
document was actually sent — quietly editing a compliance answer to match
reality afterwards would destroy the only record of what a partner was told.
**Whether it was sent, and therefore whether a proactive correction is owed,
needs a human decision and is flagged in the document rather than assumed
either way.**

The rest:

- The design document defining how the background services were split apart
  contains a table recording where each module of the old combined service was
  routed. It named two modules that have since been deleted, and placed a third
  against a service other than the one it now lives in. Rather than rewrite the
  rows, the table is now explicitly labelled for what it is — a record of the
  split as it happened, not a description of any service as it stands today —
  with every original row kept and each later change noted beside it. It also
  now says plainly that it cannot be used to work out what a service is capable
  of, and points at where to look instead.

  That last point turned out to matter more than the deletions: three
  notification modules the table assigns to one service also exist in the
  transaction-signing one, which a single-destination column cannot express.
  Anyone using the table to bound what the signing service can do would have
  concluded it cannot send notifications, which is the opposite of true. The
  sizing inventory earlier in the same document names the two deleted modules
  as well, and is deliberately left unedited: it is the evidence the split
  decision rested on, and is marked as a snapshot of that moment.
- Twenty translated user-facing strings across ten languages named the vendor
  in warnings that are never displayed. Removed — they were dead weight that
  translators would keep maintaining, naming a company the project has no
  relationship with.
- A handful of code comments and one glossary entry.

Their unused siblings in the same translation block were left in place; whether
that whole block is dead is a separate question from this one.

No behaviour changes — no rendered text, and no runtime code path, was
affected.
