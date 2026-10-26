## Thread — the marketing site ships only the translations it renders (PR #<n>)

The marketing site's translation bundles carried 54 sections of text that belong to the connected app and that the site never shows. That was about 1,060 of its roughly 1,500 strings. English is loaded up front, so every visitor downloaded them on first paint: the English bundle drops from about 138 KB to 49 KB, and each translated language's bundle shrinks by a similar share. Nothing a visitor sees changes.

A new check in the site's typecheck keeps it that way. Every section in the English bundle must be named somewhere in the site's code. No translated bundle may carry a section English does not have. And the code may not reach translations through an implicit prefix the check cannot see. The change reaches the live site with its next deploy. Closes #1767.
