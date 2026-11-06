## The next app is laid out for phones as well as desktops (PR #3212)

About half of the app's readers are on phones, so the next connected app now treats a phone as a first-class device rather than a narrow desktop. The first live review on a phone found three defects. The header spilled a few pixels sideways, so the page scrolled sideways. The wrapped navigation and controls covered more than a quarter of the screen. The wallet button read "Connecting…" while the wallet picker was merely open, before any wallet had been chosen.

On a phone the header is now one row: the brand mark and the wallet control. The wallet control is never folded away, because the address and network are the identity every figure on the page belongs to. A bar fixed to the bottom of the screen carries the first four destinations of the same navigation the desktop shows, which is still derived from the page map, and a More button. More opens every destination and the mode and theme controls as a sheet above the bar. The sheet closes when a page is chosen, and on Escape, which returns the keyboard to More. This is the bottom navigation the rulebook's accessibility rule already asked for on small screens. From 720 pixels up the bar goes and the whole navigation sits in the header as before.

The wallet button now says "Connecting…" only while the wallet itself is connecting, never while the picker is open and nothing has been chosen.

The app's verification tier now runs every scenario twice, once in a desktop window and once on a phone-sized touch device. A new phone scenario checks the one-row header, the bar and the sheet, and that the page's last line scrolls clear of the bar. Another checks, at the narrowest common phone width, that nothing scrolls sideways before or after connecting. The shared test-wallet package gained an option to open each session with the test run's device; the current app's suite does not use it and is unchanged.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-A11Y. Epic #3180.
