## Thread — retired "Buy VPFI" shortcut removed (PR #<n>)

The marketing site still served a web-app manifest left over from the retired app. It offered a "Buy VPFI" launcher shortcut to the in-app purchase route that the #687-A excision removed. No page linked the manifest, so no browser could install it, and every shortcut in it pointed at a path the marketing site does not serve. It has been deleted. Three comments that still pointed readers at the retired route now point at the connected app's VPFI vault page, and say plainly that there is no protocol VPFI purchase surface.

The excision check now knows the retired route's spelling. Any new text naming `/app/buy-vpfi` fails it. It deliberately does not ban the bare word pair. That also matches the surviving VPFI marketing page's component and translation-key names, which name nothing a reader can buy. Sorting those belongs to the excision triage (#1728).

The spec's intent that the connected app be installable, with real shortcuts and no purchase entry, was never built. It is now recorded as a gap and tracked in #2687. Closes #1742.
