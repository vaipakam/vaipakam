## The launch deploy no longer puts a price on VPFI (#884)

The platform can give a lender their fee discount in two different ways, and
which one it uses depends on a single setting: whether VPFI has a configured
price. With no price set, the discount is simply taken off the fee — the lender
gets it outright, and no VPFI moves. With a price set, part of that same
discount is only available to a lender who actually pays the fee in VPFI.

The intended posture for launch has always been the first one: no price, discount
taken off the fee. The deploy scripts did the opposite. The step that configures
the price ran automatically as part of every deployment, so a platform that was
supposed to launch unpriced would come up priced, and lenders would silently be
on the second model rather than the first.

This was hiding behind a check that looked like it was watching for exactly this.
The check confirmed the price was unset — and it was, at the moment it looked.
The step that set it ran immediately afterwards. The check was true and the
deployment was still wrong, which is the most expensive kind of green.

Setting a price is now something an operator asks for deliberately, the same way
every other one-way switch on the platform works. A launch deployment leaves VPFI
unpriced, and the discount is delivered the way the design always said it would
be.

Two documentation errors turned up in the same area and are fixed with it: the
deployment runbook described this step as running on one network only when it
actually runs on all of them, and it listed the step as part of the standard
launch sequence, which it no longer is.
