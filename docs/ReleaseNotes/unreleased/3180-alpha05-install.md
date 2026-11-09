## Thread — alpha05 can be installed as an app (PR #<n>)

The new app can now be installed to a phone's home screen or a computer's
app list. It carries a manifest with its name, icons and four shortcuts:
Offers, Positions, Vault and Alerts.

In Advanced mode, Settings has an Install the app section. Where the
browser has offered to install the app, a button opens the browser's own
prompt and the page states its answer. Where it has not, the page says
which case this is: the app is already installed, the device is an iPhone or
iPad (install through Safari's Share menu), or the browser has not offered
it. It never shows a button that would do nothing.

A deployed build now keeps copies of its own code files on the device so it
opens faster, and only once the page has used each file, so a phone never
downloads parts of the app the reader does not visit. Page loads, prices,
balances, positions and every request to another service are never answered
from saved copies; they always go to the network, so a new deploy is seen
at once and its files replace the old ones. The section says so, and says
when a browser cannot keep files.

Your data in this browser now counts these saved files on their own, and
erasing removes them too; they come back as the app is used.

Advances #3180.
