## Connected app — asset details no longer flash the previous asset's answer (PR #1753)

Three of the app's asset lookups — liquidity tier, liquid-or-illiquid status,
and on-chain token name/symbol/decimals — kept their "still loading" and "not
applicable" states as stored values that were corrected shortly after the page
had already drawn. Because the correction happened after the draw, switching
from one asset to another showed the previous asset's answer for a frame,
underneath the new asset's name. On the create-offer and offer-book surfaces
that meant a line like "Tier 3 — borrow up to 80%" could appear beside an asset
it did not describe, then change.

The three lookups now label each answer with the asset it was fetched for and
work out what to show at the moment of drawing: the answer if it belongs to the
asset being asked about, "loading" if it does not yet, and "not applicable" when
there is nothing to look up. There is no window in which a stale answer can be
displayed, in either direction — switching to an asset that cannot be looked up,
or switching between two that can.

The second case is the one that mattered and the one the previous approach never
addressed: it reset itself only when the asset became invalid, so moving between
two perfectly valid assets was exactly when the stale reading was shown.

No change to what any of the three lookups reports once it has resolved.
