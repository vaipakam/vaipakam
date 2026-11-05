## Website — the consent banner's icon takes its tint from the shared palette

The privacy-choices banner's shield icon sat on a tint of the retired indigo, left behind as a fallback colour when the website moved onto the shared navy/green palette (PR #3199). It now mixes its tint from the brand colour like every other soft surface on the site, so it reads navy in the light theme and green in the dark one.

The website's palette test now also refuses any stylesheet that names a fallback colour behind a brand token, or any of the retired indigo values, so a leftover of this kind fails the website's typecheck instead of shipping.

Advances #3180.
