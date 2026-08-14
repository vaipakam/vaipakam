# apps/defi: six data-fetching gates now declare everything they actually read

Parts of the lending app that fetch data on a schedule declare, alongside the
fetch, the list of things that should make it fetch again — the connected
wallet, the selected chain, and so on. Six of those lists were incomplete: the
code read a value but did not list it, so a change to that value alone would not
prompt a refetch.

None of the six is a bug a user could have hit today, and this note deliberately
does not claim otherwise. In every case the undeclared value moves together with
one that *was* declared — the vault address is derived from the wallet, the
diamond address and the chain client are both derived from the selected chain —
so a change to the missing value has always dragged a declared one along with
it. What was wrong was the reasoning, not the behaviour: the correctness of each
of these depended on a coincidence that nothing in the code enforces and that a
future refactor could quietly break.

They are now declared. Concretely:

- The vault assets page re-reads balances when the wallet or the diamond address
  changes, not only when the derived vault address does. This one closes a
  genuine, if narrow, window: immediately after a wallet switch the vault
  lookup has not resolved yet, so the previous vault address is still in hand
  and the per-account reads would have stayed on the old account until it did.
- The offers list re-classifies and re-caches against the chain it is actually
  reading, rather than relying on the event feed happening to change at the same
  moment. The snapshot cache is keyed by chain, so a chain identifier captured
  from an earlier render is precisely what would file one chain's offers under
  another chain's key.
- The protocol-config read declares the chain client it uses.
- The liquidity preflight compares the collateral amount directly instead of
  converting it to text first. The conversion was unnecessary — amounts of this
  kind already compare correctly by value — and it made the entry impossible for
  the checker to verify, which is why a blanket suppression had been sitting
  above the whole list. That suppression is gone.

The sixth is a genuine false alarm, and is now marked as one with the reasoning
written down. A terms-of-service check keeps a counter that it bumps whenever the
wallet or chain changes, so that a read already in flight for the *previous*
wallet can tell it has been superseded and discard its result. The checker warns
that the counter may have changed by the time the bump runs and suggests working
from a copy taken earlier. Following that advice would break the mechanism
outright: the bump has to land on the live counter, because that is the value
every in-flight read compares itself against. Bumping a stale copy would leave
the live one untouched and let a previous wallet's result apply. The changed
value is the entire point.

No behaviour change is expected on any of the six.
