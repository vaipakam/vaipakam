## Thread — the backstop vault can return idle capital again (PR #3064)

The protected-account change (#3088) added the intent's account as the first argument when lender-intent capital is withdrawn. A replacement controller can manage a recovered account, so the withdraw names whose capital it releases. The aggregator adapter was updated to pass itself, but the backstop vault was not. It still called the old three-argument form. No facet routes that selector any more, so the admin's withdrawal of idle backstop capital back to the treasury reverted with "function does not exist" every time. The capital was not lost, but it could not leave the backstop's intent.

The backstop vault now names itself as the account, the same way the adapter does. The vault is the intent's owner and is never a protected account, so the payout comes straight back to it, and from there to the Diamond as before. The pre-deploy full regression found the bug. Nothing in the targeted per-PR suites exercised this path after #3088 merged.

A scan of every interface under `src/` that calls into the Diamond found no other selector the facets no longer route.

The same regression also found a stale keeper-permission test. It still treated bit 0x100 as undefined and expected the full keeper-action set to be 0xEF. #3088 defined that bit as the vault-lock delegation, which makes the set 0x1EF. The test now checks a bit that is still undefined.

This ships with the all-waves fresh deploy. The intended behaviour is unchanged, so no functional spec edit is needed.
