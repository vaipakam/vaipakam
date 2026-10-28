## Thread — Search engines index only the language copies that are translated (PR #3036)

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
answer, so a deploy stops if the two ever disagree. Each help page also picks
the text it shows by that same rule, so a translation that is indexed is the
one served, and the prerender checks the language of the body each page
actually rendered as well as its head. The protocol console reference used
to sit on a separate English-only list in the sitemap and prerender steps,
where a translation could never have been advertised; it now goes through the
same pass as every other page, so its language addresses get prerendered
copies too, canonical to English until a translation exists. The language alternates
moved into the same per-page step that sets the canonical and the robots
directive, since all three are one decision about the page. Closes #1314.
