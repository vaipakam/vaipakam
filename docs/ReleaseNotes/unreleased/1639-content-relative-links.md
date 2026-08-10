## Thread — Relative links in published documents now fail the build (PR #1654)

Markdown under the marketing site's content directory is rendered by the
single-page app at a route, so a link written relatively is resolved by
the browser against that route rather than against the repository. A
reference to a neighbouring runbook file therefore asks the site for a
path that has no route and no published asset — and because the site is
configured to serve the app shell for anything it does not recognise, the
reader gets a page with a success status instead of the document they
clicked, and no error anywhere.

That failure is invisible from both sides, which is why this adds a check
rather than only a correction. In the repository the link looks right and
works. On the site it produces a page rather than a missing-page error,
so nobody reports it — a reader who lands on the app shell assumes they
misread the link. A one-off sweep would fix today's instances and none of
tomorrow's.

The constraint worth stating, because it is what rules relative links out
entirely: the same bytes have to work in two places. A contributor
reading the file in the repository needs a link that resolves there; a
reader on the site needs one that resolves over the web. Only an absolute
address satisfies both. The check therefore accepts absolute web
addresses, mail links, in-page anchors and site-absolute routes, and
rejects everything else. Whether a site-absolute route actually exists is
a separate question with a separate failure mode and is tracked
separately.

A sweep of all four published document sets — the admin runbook, the
whitepaper, the user guides and the overview, thirty-two files across ten
languages — found exactly one offender, in the admin runbook, pointing at
the flash-loan liquidator rollout runbook. It now uses an absolute
address. Because that file is a mirror of a canonical copy kept elsewhere
in the repository, the correction was made to the canonical and
re-synced; the check knows about that relationship and, when it finds a
problem in a mirrored file, names the canonical as the place to fix it
rather than sending someone to edit a generated copy.

The check reads the documents with a real markdown parser rather than
matching text, so a link shown inside a code block or inline code — being
displayed, not followed — is not reported, and a reference-style link is
caught at its definition. It also refuses to pass when it finds no
documents at all, so a moved content directory cannot read as a clean
result forever.

Closes #1639.
