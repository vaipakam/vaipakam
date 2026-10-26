## Keeper reads the auto-extend window from the contract (#2738, #2921)

The contract now states each loan's auto-extend window itself and refuses an
extension outside it, or one whose new term would make the loan defaultable
sooner. The keeper's auto-extend pass now asks the contract for that window
instead of working it out on its own, and leaves the term rules to the
contract, which refuses a bad term before anything is sent.

The live testnet Diamonds were deployed before that contract change, so they
neither state the window nor enforce it. On those chains the keeper keeps
applying its own copy of the same rules, so a loan there is still only
extended close to its due date. The keeper checks which kind of Diamond it is
talking to once per chain per run. Its own copy is removed at the all-waves
fresh deploy (#2921).
