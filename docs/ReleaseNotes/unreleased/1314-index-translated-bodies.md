## Thread — Search engines index only the language copies that are translated (PR #<n>)

Every page on the marketing site still has a copy under each language's
address, so a visitor who picks Spanish keeps Spanish navigation everywhere.
What changes is what the site tells search engines. A copy whose body fell
back to English, which today is the Terms, the Privacy Policy and the
whitepaper in every language other than English, now names the English page
as its canonical and is left out of the sitemap and of the language
alternates. Before, those copies were advertised as Spanish, French and so on
while their text was English, which offered search engines English duplicates
as localized pages.

One declaration says where each page's body comes from: a per-language file
(the guides, the overview, the whitepaper, the protocol console reference), a
text written in English only (the legal pages), or the page's translated
interface strings (everything else). A copy is indexed when its body exists
in its language, so a translated whitepaper or legal text joins the index by
itself the moment its file is added, with no list to update. The pages read
that declaration at runtime and the sitemap reads it at build time, and the
prerender step now checks every page it snapshots against the sitemap's
answer, so a deploy stops if the two ever disagree. The language alternates
moved into the same per-page step that sets the canonical and the robots
directive, since all three are one decision about the page. Closes #1314.
