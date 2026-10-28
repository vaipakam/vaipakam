## Thread — Every user-guide chapter has a stable anchor (PR #<n>)

Each chapter of the Basic and Advanced user guides, in all ten languages, now
carries its own anchor, named after the English title (for example
`chapter.how-vpfi-discounts-work`) and identical in every edition. A link can
therefore name a chapter and land on it in the reader's own language, as it
already could for the sections inside a chapter.

The four sections of "How VPFI Discounts Work" also get anchors in every
edition. They had none while that chapter existed only in English, so the
contents list could offer only the chapter itself; now each section is
listed and linkable like the rest of the guide.

The guide's anchor-parity check now requires every chapter to carry one.
Before, a chapter heading had no identity beyond its translated title, so an
edition that dropped one chapter and gained a different one passed both the
anchor comparison and the chapter count. With every chapter anchored, the
anchor comparison catches that directly, and the count is a backstop.

Closes #1597.
