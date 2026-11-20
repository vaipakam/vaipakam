## alpha05 cleans every token name and symbol by the shared rule (PR #<n>)

A token's name and symbol are written by whoever deployed it, so a hostile
token could carry a right-to-left override, an invisible character or a line
break to reorder or disguise what sits beside it. alpha05 now passes every
symbol and name through the shared token-label rule as it reads them, from the
token itself, from the public ranking lists and from the platform token's own
facts. Control, bidi and zero-width characters are removed, the label is kept
to one line and capped (20 characters for a symbol, 40 for a name), and it is
shown as plain text, never as a link. A symbol that cleans to nothing shows
the token's short address instead.

Because the rule runs once at the read, every screen that names a token gets
it, and none can show the raw value. The asset-trust check also compares the
cleaned forms, so an invisible character cannot make a copy look different
from the token it imitates.
