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

The page now renders the canonical Terms document itself — the exact
bytes its published fingerprint covers — rather than a hand-maintained
copy of it; review of the first draft found the old copy had already
drifted from the document it claimed to mirror, which is precisely the
class of silent divergence this whole change exists to end. An older
version announces that a newer one has been published and points at it,
worded carefully: during a rollout the version being accepted can lag
the newest published text, and the old page may be exactly the document
a pending acceptance records. Each version's page publishes a
fingerprint of its canonical source, checked automatically against that
source on every build — including builds triggered by edits to the
canonical document alone. And a pinned address for a version the site
has not published yet says so honestly — telling the reader not to
accept text they cannot see — instead of failing as a bare error page.
Archived versions are kept out of search indexes so the unversioned
address remains the one search results carry.

Closes #1998.
