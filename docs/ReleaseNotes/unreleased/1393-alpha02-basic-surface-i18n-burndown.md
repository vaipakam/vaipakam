## Thread — alpha02: Basic-surface hardcoded strings extracted and translated (#1393)

The last patch of user-visible English on the connected app's Basic
surface — strings that rendered the same in every language because they
were hardcoded in the markup rather than routed through the copy catalog
— was moved into the catalog and translated. These were the occurrences
the AST detector (#1365) had frozen in its baseline; this is the burn-down
that empties that baseline for the Basic surface (the advanced Rate-Desk
copy is a separate later pass, and the release-stage badge stays English
as a proper noun).

The extracted strings: the offer-book row line ("Lend 100 mUSDC at 5%
yearly") and its offer-number chip; the accept-mode banner opener ("You're
accepting lending offer" / "You're funding borrow request"); the two
token-security leg labels (loan asset / collateral); the "Step N of M"
compact step indicator; the "on <chain>" vault-address suffix; the
contract-address accessibility label on the asset picker; the "…? Switch"
path toggle, the prepayment-token security-gate label, and the
network-name fallback on the rental flow; the unknown-collateral-symbol
and unknown-chain-id fallbacks; and the VPFI "warming up" tier explainer —
the last composed from a body template plus interchangeable tier and
"currently" sub-phrases so each language supplies its own wording rather
than gluing English fragments together.

Each new catalog key was translated across all nine active locales (zh,
ta, de, fr, es, ar, ja, ko, hi), reusing each locale's existing
terminology for recurring words like collateral, yearly, and lend/borrow.
English output is byte-for-byte unchanged. With these gone, the
hardcoded-string detector's Basic-surface baseline is empty, so the same
strings cannot be reintroduced untranslated. Scope is limited to
`apps/alpha02`; no other app, package, or contract was changed.
