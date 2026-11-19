## Thread — The keeper page drops early close and offset completion (#3810)

Since K1 (#3810), early close, obligation handover and the offset request are
the borrower-position holder's own steps, and an offset completes inside the
accept of its offer. A keeper can no longer take either, so the keeper
permissions card stops offering them, and its introduction no longer says a
keeper can start an early close.

The contract's setter still accepts the two old bits, but they grant nothing.
A save from the app now drops them rather than carrying them forward, and
they no longer count as "advanced permissions not shown here". A keeper whose
only permissions were those two bits is revoked when saved with nothing else
ticked.

Part of #3790.
