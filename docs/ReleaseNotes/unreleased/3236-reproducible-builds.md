### Rebuilding a commit now gives the same site files (#3236)

The connected app, the new app (alpha05) and the marketing site used to stamp the moment of the build into their files: the bundle, the service worker, the sitemap and robots.txt. Two builds of the same commit therefore never matched, so there was no way to check that the site being served is the site a commit produces.

Each build now stamps the time of the commit it was built from (or `SOURCE_DATE_EPOCH`, when set). Two builds of one commit with the same build variables now produce byte-identical files; this was checked by building each of the three sites twice. A build that cannot read its commit falls back to the clock and says so in its log.

The Help page and diagnostics still show this time beside the commit, which now means when that commit was made, not when the bundle was assembled. The sitemap's last-modified date is the commit's date.

This is the first step of an automatic served-build check: a scheduled job can rebuild the deployed commit and compare it with what the custom domain serves. The incident runbook's Detect step says when a rebuild comparison is valid.
