## Terms acceptance now links the exact text it records (PR TBD)

The app's Terms gate records a wallet's acceptance against a specific
version and a fingerprint of that version's exact text. But the link it
offered — "read the Terms" — pointed at one mutable page. During a
Terms rollout the new text is published before the on-chain version
flips, so for that whole window the page showed the NEW terms while the
gate recorded acceptance of the OLD ones: a user could read one
document and sign for another, and nothing anywhere could notice.

The marketing site now keeps every published Terms version at its own
permanent address, frozen forever, with the current version still at
the familiar unversioned address. The gate links the pinned address for
the exact version it is asking the wallet to accept, so the text read
and the text recorded are the same document even mid-rollout — and an
acceptance recorded years ago stays one click from the text it bound.

A superseded version announces itself as superseded and points at the
current one. Each version's page also publishes a fingerprint of its
canonical source, checked automatically against that source on every
build, so what the page claims to be can be compared with what the
acceptance prompt displays. And a pinned address for a version the site
has not published yet says so honestly — telling the reader not to
accept text they cannot see — instead of failing as a bare error page.

Closes #1998.
