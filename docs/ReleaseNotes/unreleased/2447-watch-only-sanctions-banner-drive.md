## Live review — the sanctions banner drive no longer holds a key

The post-deploy drive that watches the sanctions banner for a flagged test
wallet only ever read, but it injected a signing wallet and so needed that
wallet's private key in the operator's wallet file. It now injects a
watch-only wallet over the flagged address: the page sees the wallet
connected, no key exists in the process, and every signing or sending
request is refused and recorded as a failure. A new `SANCTIONS_ADDRESS`
setting names the wallet directly, in which case no wallet file is read at
all; without it the drive still looks up the role's address in the file.

The position-observe drive carried its own copy of the same watch-only
provider. Both drives, and every other drive, now install the wallet
through one shared piece of the driver, which answers the page only from
its own site origin (a request from a foreign frame is refused and, in the
position drive, reported as a read-only violation). The rule for what a
watch-only wallet answers, forwards or refuses also lives in one place and
has its own tests.

Closes #2447
