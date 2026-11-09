## Thread — alpha05 gets a Settings page (PR #3451)

The new app (alpha05) now has a Settings page, reached from the foot of the
menu on every screen size.

Mode, theme and language need no wallet, apply at once and stay in this
browser. The theme follows the device until one is chosen, and the page says
which it is following. The language picker offers the ten languages; one not
translated yet is said to show English until it is.

With a wallet connected, the page shows the Terms of Service state on that
network: none in force, the version accepted with its fingerprint, or a
version in force and not accepted yet. Acceptance is asked at the first
action that needs it, never on this page, and repaying, claiming and
withdrawing never need it. A read that failed says it could not confirm,
which is not the same as not accepted. The fee-discount setting from Home is
here too.

The page says what this browser keeps for the app, that nothing secret is
stored, and that the app sends no error reports or diagnostics. It also
states how many items an erasure would remove, before anything is erased.
Download gives a file of the app's own records in this browser, naming the
wallet addresses they are kept under; the wallet connection's own session
items are counted in it but not copied out.

Erase ends the wallet connection first, then removes everything this site
keeps in the browser, including the language cookie shared with the other
Vaipakam sites. It writes back only the wallet libraries' markers that keep a
wallet disconnected, so the reload cannot reconnect one that still trusts
the site, and reloads so every preference visibly resets. The report of what
was removed, and of anything the browser refused with its reason, stays on
the page for that tab; if the browser will not keep it through the reload,
the page stays and shows it instead. Positions and history on chain, the alert
service's settings, the marketing site and the wallet app are not touched,
and the confirmation says so.

Advances #3180.
