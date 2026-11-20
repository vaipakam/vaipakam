## Indexer, agent and app fixes — one cleaning rule for token names and symbols

A token's name and symbol are written by whoever deployed the token, so every surface that shows or exports one is to clean it with one shared rule in the shared library, instead of each surface keeping its own. The rule removes control and format characters (the bidi overrides that can visually reorder an address beside the label, zero-width characters, line breaks), keeps the label to one line, and caps its length at 20 characters for a symbol and 40 for a name. The result is always plain text, and a surface never renders it as a link.

For exports there is one more step: a label starting with `=`, `+`, `-` or `@` gets a leading apostrophe, so a spreadsheet opening the file reads it as text and never as a formula. The statements card and the public data feed, neither of which has shipped yet, are to use this export form, and alpha05 imports the same rule from the shared library.

The stuck-token recovery page, which had its own narrower version of the rule, now uses the shared one. It also removes the other Unicode format characters and folds line breaks to a space.

The rule comes from the design security review of the statements card and the public feed. Alerts carry no token names, so nothing live was exposed.
