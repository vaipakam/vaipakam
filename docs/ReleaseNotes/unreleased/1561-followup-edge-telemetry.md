## Thread — The recovery live review stops failing on Cloudflare's own beacon (PR #1566)

The post-deploy review driver for the stuck-token recovery page fails the run if
anything tries to write while it is browsing — the review claims to be read-only,
so an attempted transaction or backend call underneath otherwise-green checks is
a finding in its own right, not noise.

One thing it was catching is not a write by anything we ship: Cloudflare injects
its own monitoring beacon into pages it serves, and that beacon posts. It is
correct to block it during a read-only run, and useless to fail on it — it says
nothing about whether the page under review tried to change anything, and it
fires on the marketing site the driver opens in a second tab, which is a
different app entirely.

Left alone, this would have made every future production run of the driver
report a failure that nobody could act on, which is the reliable way to get a
check ignored — and the real violation it exists to catch ignored along with it.
The beacon is now reported as expected and excluded from the verdict, as a
narrow exemption for Cloudflare's reserved edge path rather than a relaxation of
the rule. Any other blocked request still fails.

Confirmed on the run immediately after the guide fix reached production: all
fifteen checks pass, with the beacon listed as expected. Under the previous
behaviour that same run would have reported failure.
