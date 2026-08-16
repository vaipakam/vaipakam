## Thread — the VPFI vault surface is named for what it is (PR pending)

The page that lets a user deposit VPFI into their vault for a fee discount was
renamed some time ago, and its user-facing copy went with it — every label and
every help summary describes a vault. The identifiers behind them did not
follow: the help-card ids and the translation keys still carried the old
purchase-page name.

Nothing a user reads changes here. The card ids and the English translation
keys now say vault, matching the copy they resolve to and the page component
that has been called the vault page for a while. This removes the last places
in the application where the retired purchase surface was still named, so a
reader of the source is not misled into thinking such a surface exists.

Deliberately not included: the excision ratchet token for the retired route
spelling. Adding it also flags historical developer comments that accurately
record the rename, which want pinning with a reason rather than editing, and
that is a separate piece of bookkeeping.
