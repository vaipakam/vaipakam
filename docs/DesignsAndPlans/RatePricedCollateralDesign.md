# Collateral priced by an exchange rate — design

**Status:** owner approved the feature on 2026-11-15, before the feature freeze. Card #3683. Design for review before build.
**Related:** `PriceGuardDesign.md` (#3272), `FeedRegistryDesign.md` (#2880), `LoanSettingsSnapshotDesign.md` (#3437), `OraclePolicy.md`.

## 1. Why

A large part of what people hold on-chain is no longer a plain token. It is a token that stands for a growing amount of another one: a staked form of a chain's native asset, or a share in a vault. One unit is redeemable for a number of units of the underlying asset, and that number, the **exchange rate**, rises as rewards arrive. These are among the most used collateral assets in on-chain lending.

The platform cannot take them today. Scouting the code on 2026-11-15: the price guard prices a token from a registered market feed for that token, cross-checked by secondary sources. It has no way to say "this token is worth the underlying's price times a rate". Without a registered feed a token is illiquid, valued at zero and lent against only by explicit consent.

## 2. What is added

A second way for the price guard to price a token:

> price of the token = price of its underlying asset × the token's exchange rate

The underlying's price comes through the guard's existing path, with every check it has today. The rate comes from a per-token rate source the guard is told about. The result then passes the same downstream checks as any other price.

Scope of the first version:

- **Collateral only.** A rate-priced token may be posted as collateral. It may not be the lending asset. Every safeguard below errs toward a lower value, which protects the lender when the token is collateral and would do the opposite if it were the debt.
- **Tokens whose balance does not change by itself.** The token must carry its growth in the rate, not in a balance that rebases. Vaults account in fixed balances.
- A short admitted list to start: two or three of the most established staked forms of a chain's native asset, on the chains where they have deep markets.

## 3. The rate source

Each rate-priced token has one binding, held by the price guard and changed only through its delayed changes:

| Field | Meaning |
| --- | --- |
| Underlying | The asset the rate converts into. It must itself be priced by a registered feed, not by another rate. |
| Rate source kind | **Rate feed**: a feed, published by the same network as the price feeds, that reports the token's exchange rate; registered in the feed registry with its heartbeat like any feed. **Token rate**: the token contract's own conversion function, read through a small fixed reader for that token type. |
| Largest rise per day | The most the accepted rate may grow in a day. |
| Largest fall | The size of a single drop that marks the price distrusted. |
| Market feed, optional | A registered market feed for the token itself, where one exists. |

Which kind to use is decided per token and chain. On the chain where the token is issued, the token's own conversion function is the source of truth for redemption. On other chains that function usually does not exist and the rate arrives only as a feed.

**How a binding starts (#3683 build).** A binding is proposed only through its own proposal call, which registers the binding and measures the rate the source reports at that moment as the binding's first accepted rate. From then until execution the rate is recorded under the daily bound like any other, so a rate pushed up at execution gains nothing. Execution records the rate once more, taking the lower of what the source reports and the accepted rate grown by the daily bound, so a delay with no recording in it cannot start the binding high either. While the binding is still pending nothing is priced from it, so a correction larger than the fall bound is taken as the new, lower accepted rate without marking the price distrusted; once the binding executes, the normal fall rule applies.

## 4. Safeguards

1. **The rate may not jump up.** The guard keeps the last accepted rate and its time. A read uses the lower of the reported rate and the last accepted rate grown at the largest daily rise **over the time since it was recorded, counted as at most one day**. An attacker who inflates a vault's share value in one transaction (for example by donating to it) gains nothing: the price moves by at most one day's bound, however old the stored point is. Anyone may call a function that records the current accepted rate (itself bounded the same way), so the stored point keeps up with honest growth; the hourly price checkpoint pass does it. If recording stops for several days the allowance does not build up: the accepted rate then catches up by at most one day's bound per recording and real time elapsed, which undervalues the collateral for a while and never overvalues it.
2. **A drop is taken at once, and a large one stops trust.** A lower rate is used immediately, since it lowers the collateral's value. A single fall larger than the configured bound marks the token's price distrusted, with the same effect a distrusted price has today, until the new level is confirmed. While the price is distrusted the guard keeps the **lowest rate the source has reported since the fall**, starting with the reading that caused it and lowered by every recording after it. Confirming accepts the lower of that lowest rate and the rate the source reports at that moment; whoever confirms chooses no number. From there the rate may rise only under safeguard 1's daily bound, so a rate pushed up just before the confirmation gains nothing. It is allowed only after the source has stayed at or below the pre-fall accepted rate, with no further fall past the bound, for a minimum observation time (a bounded guard setting, starting at six hours), and the accepted rate can never be set above the pre-fall one. The owner or the guardian may confirm on this one rule, and the confirmation is an event. The guardian's part is therefore a choice of timing inside a rule, not a power to set a price; without it a falling asset would stay unpriced for the whole governance delay and none of its loans could be closed out.
3. **A stale rate is not used.** A rate feed older than its heartbeat, or a reader call that fails, gives a distrusted price, and every step that needs the price refuses. It is never read as a missing feed, so a rate source that goes quiet does not move a loan onto the route of an asset with no price (owner decision 2026-11-22).
4. **The market may say less.** Where a market feed for the token exists, the collateral value is the lower of the rate price and the market price. A token can trade below its redemption value when exits are slow, and a forced sale gets the market price.
5. **The underlying keeps every check it has**: staleness, the secondary sources, the sequencer check.
6. **Liquidity is still measured on the token itself.** A rate-priced token is liquid only if it passes the same sale-size and slippage probe as any other, against the token's own pools. A sound rate with no market is still illiquid.
7. **The loan-to-value tier is set per token**, no higher than the underlying's and normally one step lower.

## 5. How it fits the settings a loan carries

Under #3437 a loan carries the price guard's address and price version, and that design's rule 5 says any governance-settable state inside the guard must be versioned or stop-only. The rate binding is such state:

- adding or changing a binding is a delayed guard change that raises the price version, so open loans keep reading the binding they opened with;
- marking a token's price distrusted, and muting a rate source, are stop-only actions that reach every loan at once. A muted rate source leaves the token's price **distrusted**, not missing: a stop must never move a loan onto a different settlement route. Unmuting waits the delay;
- the last accepted rate is measured state, not a setting. It is one value per token, shared by every version that uses the same binding, and a new binding starts its own.

The hourly checkpoints and the calm test read the resulting price and need no change.

## 6. Admission checklist

A token is proposed for the list only with a written answer to each, kept with the proposal:

1. The balance does not rebase; growth is in the rate.
2. The rate can fall only through a loss event (for a staked asset, a penalty), and the size of the largest plausible single loss is stated.
3. The rate source: which kind, who can change the contract behind it and with what delay.
4. The underlying has a registered feed of the quality required for a lending asset.
5. On-chain market depth for the token on that chain, against the sale sizes the platform's tiers assume.
6. How long a redemption takes, and what the token has traded at against its redemption value in past stress.
7. The token contract's upgrade and pause powers.
8. The proposed bounds: largest rise per day, largest fall, loan-to-value tier.

The app's asset page states that the asset is priced from an exchange rate, names the underlying, and shows the bounds.

## 7. Contract changes

| Where | Change |
| --- | --- |
| Price guard | A source kind for a rate-priced token; the binding; the accepted-rate record and its recorder; the lower-of rule with an optional market feed; the distrust flag on a large fall. The readers are separate contracts, so adding a token type does not grow the guard; measure the guard's size against the limit in the same change. |
| Feed registry | Rate feeds registered as their own entry type, so a rate feed can never be read as a price feed or the reverse. |
| Readers | One small fixed contract per token type for the token-rate kind. No settings, no owner. |
| Offer creation and admission | A rate-priced token is refused as the lending asset. |
| Views | Per token: the binding, the reported and accepted rate, the price and which of rate or market set it. |
| Keeper | The hourly checkpoint pass also records accepted rates. |

The price guard work belongs with the rest of #3272 and the as-of reads of #3437, and should be built by the same hands in the same pass.

## 8. Tests

1. Price equals underlying times rate for both source kinds, with decimals of every combination in the admitted list.
2. An inflated rate in one block moves the price by no more than the daily bound; honest growth over many days is followed. After several days with no recording, the first read of an inflated rate still moves the price by no more than one day's bound, and a second recording in the same block adds nothing.
3. A small fall is used at once; a fall past the bound marks the price distrusted and every consumer treats it as such. Confirmation: refused before the observation time; accepts the lowest rate reported since the fall even when the source reports higher at that moment; a rate inflated just before confirming does not raise the accepted rate; recovery afterwards follows the daily bound.
4. A stale feed or failing reader gives a distrusted price, never a missing one.
5. With a market feed, the lower of the two is used in each direction.
6. Refused as a lending asset on create, accept, match and intent paths.
7. A binding change raises the price version; an open loan keeps the old binding; a mute reaches every loan.
8. A rate-priced token with no pool depth is illiquid.
9. The underlying may not itself be rate-priced.
10. The first accepted rate is the one reported at proposal; a rate inflated at execution moves the starting rate by no more than the daily bound, with or without recordings during the delay.
11. A fall past the bound while the binding is pending lowers the accepted rate and marks nothing distrusted; the same fall after execution marks the price distrusted.

## 9. Alternatives considered

1. **Treat such tokens as illiquid.** The status quo. Safe, and it shuts out a large share of the collateral people hold.
2. **Use only a market feed for the token.** Simple where a feed exists, but the market price of these tokens is thinly traded on many chains and easier to push than the underlying's, and on some chains no market feed exists at all.
3. **Use only the rate, ignore the market.** Overvalues the collateral whenever the token trades below its redemption value. Rejected in favour of the lower of the two.
4. **Allow them as lending assets too.** Needs the opposite rounding and bounds everywhere. Left for after the audit.
5. **A general formula engine in the guard** (any price from any chain of sources). More power than is needed and far more to audit. Rejected: one multiplication, one level deep.

## 10. Recommendation

Add the rate-priced source kind to the price guard with the safeguards in section 4, for collateral only, starting with a short admitted list.

## 11. Open items for the builder to raise, not decide silently

- Settled with the builder on 2026-11-15: the build admits no token (each comes later as a governance proposal with its checklist answers; testnets get one mock token); both source kinds ship, with one reader for the standard vault conversion function to start.
- Rate-priced tokens start with concentration thresholds one step tighter, set per token in the concentration settings (`CollateralConcentrationDesign.md`, #3685), not in the guard.
