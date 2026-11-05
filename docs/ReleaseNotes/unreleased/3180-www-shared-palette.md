## Website — one brand palette shared with the connected app (#3180 follow-up)

The website now draws every brand colour from the same file the new connected app uses, the shared palette in the lib package, instead of defining its own. The owner decided on 2026-11-05 that the website and the app should look like one product, and chose the website logo's navy and green over the indigo both surfaces had been painting their controls with. The app moved onto the shared palette with its scaffold; this change moves the website.

What a visitor sees: in the light theme the primary buttons, links, active tabs, the consent switch and the section eyebrows are navy, the colour of the logo mark; in the dark theme they are the logo's green, with navy text on filled controls. Tints and hover tones are mixed from the brand colour, so nothing in the website's stylesheets names an indigo value any more.

The palette keeps two tokens on purpose: the brand as text (which must read against the page) and the brand as a fill (which must carry its own text colour). The website's filled controls use the fill pair, so the dark theme's green button carries navy text rather than white, which would not have met the contrast floor.

A test on the website's side pins the shared palette against the website's own backgrounds: every rendered brand pair, and the primary and secondary text on the page and on a card, at or above 4.5:1 in both themes. The app has the same test against its surfaces. A brand token retuned for one surface set can fail on the other, which is why each side checks its own, and the test refuses a brand token redefined in the website's stylesheet so the two surfaces cannot drift apart again.

Advances #3180.
