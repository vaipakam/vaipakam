## Thread — The website and the next app go back to indigo (PR #3316)

The website and the next connected app share one brand palette, and that palette is indigo again. It had been the logo's navy and green since 2026-11-05; the owner found the earlier indigo easier on the eyes. Buttons, links, the active navigation item, tinted chips and the keyboard focus ring take the indigo in both light and dark themes, from the one shared palette file, so the two surfaces still match. The logo keeps its own navy and green.

Every text colour on a brand colour still meets the accessibility contrast floor (4.5:1) in both themes, checked by each surface's contrast test. The website's check that no stylesheet writes a brand colour out by hand now reads the brand colours from the shared file, instead of naming the colours the palette once held, so it keeps working whatever the palette is.

Epic #3180.
