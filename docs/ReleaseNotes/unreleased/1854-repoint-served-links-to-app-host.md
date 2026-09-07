## Thread — the links that could move, moved; the claims that had gone stale, went

`app.vaipakam.com` is bound and serving the connected app. Three places
in the tree still said it was not, and that stale premise had been
load-bearing: it was the stated reason the user-guide recovery links, the
indexer's API catalog and the AI-crawler surface all still advertised the
legacy `defi.vaipakam.com` host. Those three link surfaces now point at
`app.vaipakam.com`, and the claims that held them back are corrected.

What moved is narrower than it first looks, and the reason is worth
keeping. The two automated-consumer pointers at the app home moved. The
ten localized user-guide recovery links did **not**, and are now
explicitly coupled to the legacy host being retired rather than to the
new one coming up. `/recover` is the one flow carrying durable
per-origin safety state: the pending-recovery marker lives in browser
storage, which is same-origin, and that pending card is the only safe
landing for a broadcast whose receipt could not be read. A user
mid-recovery who followed a repointed link would arrive where the marker
cannot be seen, meet a blank form, and could broadcast a second recovery
— the exact double-recovery the card exists to prevent. The risk is
asymmetric, which settles the ordering: a fresh user sent to the
still-served legacy host loses nothing.

The verification method matters more than it sounds, and one half of it
was initially mistaken for the other. Both hosts return an identical 200
SPA shell for every path, including paths that do not exist, so a
status-code probe proves nothing; identity was established by asset hash
instead, and the route table in source is the authority on what exists.
But confirming a page RENDERS is not evidence that state carries across
to it — that distinction is what the recovery links turn on, and it is
now written down beside them.

Two blockers were re-checked rather than assumed. **#1960 is cleared**:
the app serves its own Data Rights route, which was the whole concern —
the marketing site's export/erase controls could never have stood in for
it, because browser storage is same-origin and they run on the other
origin. **#1959 stands**: Analytics and the Protocol Console are still
unported, so `defi.vaipakam.com` cannot be retired or blanket-redirected;
it remains the only host serving them. The note on that now also says
what it does *not* block — those two links never travelled through the
`APP_TARGET` switch, so they are not what is holding the flip.

Deliberately NOT in this change, and each for a stated reason. The
`APP_TARGET` flip waits on the app's Vpfi page gaining a deposit anchor
equivalent to the legacy `#step-2`; flipping first would regress the
landing position the marketing CTA promises. The agent's
`FRONTEND_ORIGIN` entry-zero move waits because it is one decision with
the Frame paths beside it and changes live notification deep links, which
wants its own review. Retiring the legacy host waits on #1959.

Separately observed while verifying, and operator-side rather than
anything this diff can reach: four Cloudflare Workers Builds
(`vaipakam-alpha`, `-alpha01`, `-alpha02`, `-defi`) fail on every push to
`main` and are the only red checks there. No wrangler config in the tree
names any of them — they are dashboard git integrations pointed at
directories deleted in #1854/#1958, so no repository change can turn them
green. Disconnecting those four build integrations is safe and
independent of retiring the hosts they are named for.
