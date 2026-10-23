## Thread — One address per app page: trailing slashes redirect (PR #2692)

Asking the connected app for a page with a trailing slash, such as `/vpfi/` instead of `/vpfi`, used to serve the page itself. The response carried a "do not index" header, but the page declared itself indexable. A browser ignored that disagreement. A search crawler that does not run the app saw only the header, so it treated a valid spelling of a public page as withheld.

The app's host now answers every such request with a permanent redirect to the address without the slash, keeping any query string, before anything is served. Each indexable page now has one address, and the header and the page can no longer contradict each other. The site root and deeper per-item addresses are unchanged.

This was checked against the same static-asset server the deployed app runs, and it is checked again on the live site after the next app deploy. Closes #2079.
