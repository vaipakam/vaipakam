## Removed references to a security vendor the product no longer uses (#1717)

The pre-sign transaction preview — the panel that shows what a transaction will
do before you approve it — was originally built on a third-party scanning
service, briefly moved to a second one, and now uses neither. It reads the
outcome directly from the chain in the browser. That change shipped some time
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
  assigned two modules to a service that does not contain them, because both
  modules were deleted after the document was written. A third module was
  listed against the wrong service entirely — it lives with the transaction-
  signing service, not the notifications one. That table is how someone audits
  what a given service can do, so a wrong row there misleads in the direction
  that matters. The sizing inventory earlier in the same document also names
  the two deleted modules, but is deliberately left alone: it is the evidence
  the split decision rested on, and is now marked as a historical snapshot.
- Twenty translated user-facing strings across ten languages named the vendor
  in warnings that are never displayed. Removed — they were dead weight that
  translators would keep maintaining, naming a company the project has no
  relationship with.
- A handful of code comments and one glossary entry.

Their unused siblings in the same translation block were left in place; whether
that whole block is dead is a separate question from this one.

No behaviour changes — no rendered text, and no runtime code path, was
affected.
