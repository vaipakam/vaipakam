### Two chapters of the Hindi and Japanese guides were written but unreachable

The Advanced guide chapters on how liquidation actually works and on allowances
were already translated into Hindi and Japanese. Readers of those two languages
could not get to them.

The prose had been indented by two spaces, which in Markdown makes it a
continuation of the bullet point above rather than a chapter of its own. The
result was a hundred-odd lines of correctly translated material that the page
rendered as part of a bullet, that the contents list never offered, and that no
check objected to — the words were all there, in the right order, in the right
file.

Removing that indentation is the entire fix. Nothing was written, translated, or
reworded; the change is whitespace only, and the anchor set of both files is
byte-for-byte what it was. Both editions now carry eighteen chapters like every
other translation, and both chapters appear in the contents list where a reader
would look for them.

That leaves every language short of exactly one chapter, the same one — the
walkthrough of how VPFI discounts work, which exists only in English and is
genuinely a translation job rather than a formatting one.
