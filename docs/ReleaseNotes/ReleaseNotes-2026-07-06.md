# Release Notes — 2026-07-06

A large consolidation day across three surfaces. The alpha02 naive-user
app shipped its remaining trust-and-safety batch: in-app support-ticket
capture end to end (durable record, metadata-only operator alert,
enforced retention, a Privacy Policy bumped to Version 3 on the public
site), token-risk badges on the shared book with guided-match
exclusion, Permit2 signature approvals with a silent classic fallback,
pre-sign transaction simulation, the diagnostics/support drawer, the
on-chain book catch-up, the write-path kill switch, alert rails, the
CoinGecko reputation fallback, and the copy/legal honesty pass. The
connected app (defi) picked up the reverse-ported resilience wins
(WebSocket-first transport, honest allowance reads, accurate
wallet-rejection classification) and two bug fixes (stale /app/loans
links with a locale-preserving redirect, ABI-derived catch-up topics).
The contracts side landed the bulk dashboard read views and the #998
liquidation/reward/close-out threads. Full detail per thread below.

## Thread — Bulk wallet-dashboard read views (#1025 / PR #<n>)

The Diamond gained two Aave-`UiPoolDataProvider`-style bulk read views so a
connected wallet can hydrate its whole dashboard in one or two batched
`eth_call`s instead of a per-position fan-out. Before this change, the
chain-authoritative own-positions view read each enumerated offer with two
calls (fetch the offer, then derive its lifecycle state) and each held loan
with one fat full-record call — a heavy or griefed inventory could spray
hundreds of round trips and, worse, a single oversized response could fail the
entire refresh.

`getOffersWithState(offerIds)` returns one lean, dashboard-shaped record per id
— the exact fields the offer row renders — with each record already carrying
its canonical lifecycle state (Open / Accepted / Cancelled / ConsumedBySale),
so the two-call-per-offer pattern collapses to a single batch call.
`getLoansBatch(loanIds)` does the same for loans, returning the lean loan
summary plus the two counterparty addresses in place of the full 48-field
record. Both views are strictly positional and never de-duplicate their input:
a wallet that holds both sides of the same loan passes that loan id twice and
gets two aligned rows back, so neither role is hidden. An unknown or
already-closed id yields a blank record in place rather than reverting the whole
batch, and each view hard-caps its input length (returning a named
"batch too large" error) so a mis-sized caller sees an actionable failure
instead of silently degrading. Callers chunk their id set to stay under the cap;
the reference frontend's existing 200-id page size sits comfortably within it.

Internally, the offer lifecycle-state derivation that previously lived privately
on one facet was promoted into the shared metrics-types library, so the new bulk
view and the existing single-offer state view now share one definition and can
never disagree about an offer's state. That move is wire-compatible — the state
value is still a `uint8` on the ABI boundary and every selector is unchanged —
but it does shift the exported ABI's human-readable type label for the affected
signatures, which is why the metrics facet's committed ABI JSON shows a
cosmetic, no-runtime-effect diff alongside the new dashboard-facet surface.

The views live on the existing dashboard facet (no new facet, and it stays
within the contract-size limit), and the frontend ABI bundle was re-exported in
the same change so the committed package never lags the deployed surface.
Switching the reference app's own-positions reads onto these batch views (with a
graceful fall-back to the per-id path on older deploys) is a separate follow-up.
Closes #1025.

## Thread — Spec-conformance Tranche 1: tier liquidation-threshold gradient + $50k tier probe (#999, #1007 / PR #<n>)

The first tranche of the #998 spec-conformance fixes corrects how a loan's
liquidation threshold is chosen from its collateral's liquidity tier.

Previously the per-tier liquidation thresholds ran the wrong way: the thinnest
tier got the *highest* threshold (90%) and the deepest tier the lowest (80%), so
thin-market collateral was only liquidatable once it reached 90% LTV — leaving
too little cushion to absorb swap slippage, the handling fee, and the liquidator
bonus without bad debt. Because the threshold is snapshotted onto every liquid
loan at origination regardless of whether the optional depth-tiered regime is
switched on, this affected essentially every liquid-collateral loan. The
gradient is now flipped to run the way the specification and whitepaper always
described it — deeper liquidity earns a higher tolerated pre-liquidation LTV —
with defaults of 80% for Tier 1 (thinnest), 85% for Tier 2, and 90% for Tier 3
(deepest). The governance setter that tunes these thresholds now enforces the
matching ascending order. Loans already open keep the threshold they were
originated under; the platform is pre-live, so no live loans carry the old
values.

A companion fix makes the Tier-1 depth probe actually count. Tier assignment
measures how much an asset can absorb at $5k, $50k, $500k, and $5M; the $50k
(Tier-1) probe was being computed but never consulted, so any asset that could
absorb just $5k was silently promoted to Tier 1. Now an asset must clear the
$50k probe to earn Tier 1; one that clears only the $5k floor is treated as
untierable (Tier 0). Untierable liquid collateral receives the most conservative
Tier-1 liquidation threshold and the most conservative initiation cap, never a
deeper tier's more permissive settings — closing the gap where the previously
inert `tier1SizePad` governance knob had no effect.

No external interfaces changed. Closes #999 and #1007 under the #998 umbrella.

## Thread — Spec-conformance Tranche 2: interaction-reward lifecycle close-out (#1002, #969 / PR #<n>)

The second tranche of the #998 spec-conformance fixes closes two ways the
interaction-reward accrual could pay for interest that was never really earned.

Previously a reward entry became claimable purely because the calendar passed
the loan's contracted maturity and the global reward denominator for those days
finalized — independent of whether the loan had actually closed. A borrower who
intended to default could therefore wait past maturity, claim the full-window
reward, and only then default, side-stepping the specification's rule that
borrower rewards accrue only on a clean repayment and that neither side can
claim while the loan is still live. Each reward entry now carries an explicit
"closed" marker that is set only when the loan is actually closed (or the lender
position is sold); a reward is claimable or sweepable only once that marker is
set. The entry's day-window remains the accrual bound, but it no longer doubles
as the "is the loan over?" signal.

Second, the early-close paths that flip a loan to Repaid without going through
ordinary repayment — direct preclose, offset completion, and refinance — did not
tell the reward system the loan had closed, so both parties' entries kept
accruing to the original contracted end date. After a refinance this
double-counted the same principal because the new loan registered its own fresh
entries while the old loan's stayed open. These paths now close the old loan's
reward entries at the moment they settle it. The exiting lender is always paid in
full and never forfeits; the borrower side is clean only when the close happens
within the loan's grace window — a late preclose or refinance (past grace, before
anyone triggered default) is treated as a non-clean close and forfeits the
borrower reward, the same way an ordinary post-grace close does. The
obligation-transfer path (which keeps the loan open under a new borrower and a
re-originated term) splits the reward windows at the transfer point: the exiting
borrower and the unchanged lender keep what they earned before the transfer, and
fresh entries covering the continuing loan are opened under the new rate and
duration, so the incoming borrower only earns from the transfer forward and never
inherits the previous borrower's history.

As a safety net, a reward entry also becomes claimable once its loan simply
reaches a terminal status even if the closing path did not explicitly notify the
reward system, so no terminal path can ever freeze a reward forever; while a loan
sits in a liquidation/default status that fallback also routes the borrower's
reward to treasury rather than paying it out, and the permissionless forfeit
sweep is guarded so it can only ever touch genuinely-forfeited entries (never a
payable one). Offset completion now applies the same in-grace/late clean-vs-
forfeit rule as the direct-preclose and refinance paths.

The complete, precise close-out of every terminal path is deliberately scoped as
a dedicated follow-up rather than rushed here: explicitly notifying the reward
system from the internal-match-liquidation, prepay-sale, and other close paths
(so the borrower forfeit is durable across a later Settled transition and the
accrual window is trimmed to the real close day), and re-anchoring reward entries
to the current position-NFT holder before an obligation transfer or offset
completes. Those paths are no worse than before this change — where a path is not
yet explicitly wired, its rewards remain claimable exactly as they were — and the
platform is pre-live, so there is no historical reward state to migrate. This
change lands the claim gate, the ordinary-close wiring (repay, preclose,
refinance, and the existing liquidation/default paths), and the safety net; the
remaining precision work is tracked under the same umbrella.

Because the preclose facet is already at the contract-size ceiling, the reward
bookkeeping for those paths runs through a small internal hook rather than being
inlined; the hook is best-effort by design, so reward accounting can never block
a borrower from reclaiming their collateral on a preclose.

A separate, narrower reward finding — that the per-user reward cap is currently
enforced over each entry's whole window rather than strictly per calendar day
(#1008 / S13) — is intentionally deferred to its own follow-up, because a correct
per-user-per-day cap needs a dedicated accounting design. It is a mild
over-relaxation, not a safety issue, and nothing in this change alters it.

Closes #1002 and #969 under the #998 umbrella. A known follow-up: on an
obligation transfer the re-pointed entry still reflects the original loan's
interest rate and window rather than the re-originated term.

## Thread — Spec-conformance Tranche 3: fallback cure + mode-aware refinance + replacement-term rounding (#1000, #1003, #1032 / PR #<n>)

Three close-out fixes from the #998 spec-conformance review.

A borrower whose loan has slipped into the collateral-fallback state (because a
time-based default fired and the automated sale couldn't execute) is promised, in
two places in the specification, that they may still fully repay to cancel the
fallback and reclaim their collateral before the lender's claim executes.
Previously that cure was unreachable: full repayment was blocked once the loan
passed its grace window, but the fallback state only ever exists past the grace
window, so the cure always reverted and the borrower was forced into the fallback
premium the cure exists to avoid. Full repayment now cures a fallback loan even
past grace — the cure payment makes the lender whole (principal plus interest,
including grace-period accrual, plus late fees), so there is no lender-side harm.

Second, refinancing a loan now settles the exiting lender's interest the same
mode-aware way an ordinary early repayment does, instead of always charging the
full contracted term. If the loan was written on full-term-interest terms the
exiting lender still receives their full-term maximum and is strictly whole; but
if the loan was written on pro-rata terms, the borrower now pays only the
interest actually accrued, rather than being penalised with the full term simply
for refinancing rather than repaying directly. The two "early close" doors —
direct preclose and refinance — no longer disagree, and any interest already
settled through the periodic path is credited so it is never charged twice.

Third, the obligation-transfer and offset flows re-originate the loan with a
fresh start time, and their replacement-term check compared whole-day remaining
counts. Because the elapsed time was rounded down, the remaining count rounded
up, letting a replacement term carry the new maturity up to a day past the
original loan's maturity and quietly extend the lender's exposure. Those checks
now compare the actual maturities with second precision, so a replacement term
can never mature later than the loan it replaces.

Closes #1000, #1003, and #1032 under the #998 umbrella. The related offset
Step-1/Step-2 double-pay finding (S3 / #1001) is handled separately, as it
touches the offset payment-timing and cancel-unwind logic more deeply.

## Thread — Telegram alerts arrive in the retail app, framed as outcomes

The retail app's Settings now carries an Alerts card. Linking Telegram
takes one tap (or copying a short code to the bot) — and the one-tap
path now genuinely works: the bot understands the payload Telegram
sends when the user presses Start, where before only the hand-typed
code was recognised. From then on
the platform can reach the user while the site is closed — which is
when repayment deadlines and loan risk actually happen. The controls
are plain-language outcome toggles — "message me before an interest
payment comes due", "message me if my loan gets risky" — with
sensible risk thresholds behind them; the raw health-factor numbers
are editable only in Advanced mode, using the same defaults the pro
app exposes directly. Switching the risk toggle off still leaves a
last-moment warning right before a loan would be liquidated, and the
card says so. The interest-payment toggle is a REAL opt-out: the
alert service now stores it and BOTH due-date lanes honor it before
sending anything — the interest-payment reminder and the pre-grace
"no refinance match found" warning alike. Because that switch
silences real warnings, turning it OFF asks the wallet for the same
free ownership signature that linking does — and the toggle's stored
value only changes when the user actually flips it, so opening the
card on a fresh device can never silently undo an opt-out (or
opt-in) made elsewhere.

The card carries one honest privacy sentence — linking stores the
wallet address, the alert preferences from the card, and the
Telegram chat id on the alert service, plus a small delivery record
per alert sent (which loan, which level, when) so the user is never
messaged twice about the same event — and an Unlink that actually
removes the Telegram connection: the alert service gained a
dedicated unlink endpoint alongside this feature, and unlink stays
reachable even for a wallet linked from another device. Starting a
link — and unlinking — now asks the wallet for a free signature
first: proof the request comes from the wallet's owner, so nobody
can point another wallet's alerts at their own Telegram chat, and
nobody can silently switch off another wallet's risk warnings
either. The pro app's alerts page gained the same proof step for
linking.
A borrower viewing their active loan sees a one-line nudge pointing
at the alert setup. Users who prefer wallet-native push can enable
Push delivery (recorded service-side) and open the platform's Push
Protocol channel from the same card — both halves of what Push
delivery actually requires. In builds where no alerts backend is
configured, the card says exactly that and sends nothing — the
feature fails closed rather than pointing at the wrong environment.

No "something to claim" toggle ships yet on purpose: the backend has
no claim-ready detector, and the retail surface does not promise
messages that cannot arrive.

Due-date reminder messages now deep-link to the loan page every
current app actually serves (`/loans/N` on the pro app, aliased on
the retail app) instead of a historical URL shape that landed on a
not-found page.

## Thread — positions hydrate in one read instead of one per position

The retail app's chain-authoritative "My positions" discovery now
hydrates all of a wallet's offers and loans through the protocol's
batch views: one network read per 250 positions instead of two reads
per offer and one per loan. Nothing changes in what the user sees —
the same rows, the same statuses, the same freshness — but the page
leans far less on the public RPC endpoint, which matters exactly when
a wallet holds many positions and the per-row fan-out used to be
noisiest.

On networks whose deployment doesn't carry the batch views yet, the
app detects that in-flight and quietly uses the previous per-position
reads — the switch activates by itself once the upgraded views are
deployed, with no app release needed. Single-position lookups (a deep
link to one offer) keep the direct single read: a batch of one gains
nothing.

### Offer Book: just-ended offers vanish even while the cache lags (alpha02)

The shared Offer Book (and every guided flow that reads it — borrow
and lend matching, rentals, early exit) now double-checks the chain
before rendering (#1029). The market cache is refreshed continuously,
but during any ingest lag it could briefly keep showing an offer that
was just accepted, cancelled, matched, or consumed by a loan sale —
inviting a user to pick it and hit a doomed transaction. The app now
scans the slice of chain history the cache hasn't ingested yet and
strips any offer the chain already marked as ended.

The check is deliberately one-sided and fail-open: it only removes
ghost rows (brand-new offers surface on the next cache refresh,
seconds later), and if the scan itself fails for any reason the book
simply renders the cache state it always rendered — the safety layer
can never make the book unavailable. If the cache is very far behind,
the scan steps aside entirely rather than hammering the network, and
the existing "this list may be behind" note covers that state.

Porting this from the primary app also fixed a latent bug there in
passing: the event signatures the primary app scans for had silently
drifted from the deployed contracts. alpha02 derives them from the
compiled contract ABI, so a future contract change breaks tests
loudly instead of silently disabling the safety net.

### Market-listing check on pasted token addresses (alpha02)

Pasting an unknown token address into an offer form now also asks the
wider market about it, alongside the existing security screen
(#1036, the final layer of the token screen):

- A listed token shows its market name, symbol, and rank — a quick
  identity check that the address really is the token you meant.
- A listed-but-small token (outside the top 200) gets a plain-words
  caution: smaller tokens move harder and disappear faster.
- An address with no market listing at all says so — not as an
  accusation, but as a prompt to verify the contract address with the
  project before dealing in it.

This is a soft signal only: it never blocks anything (the security
screen keeps that job), it stays silent when the lookup itself fails,
and it doesn't appear on test networks — where no test token has a
market listing and the line would only teach people to ignore it.

### Copy and legal honesty batch (alpha02)

Three small alignment items from the spec-vs-app audit (#1030):

- The mandatory consent line ("I understand and agree to the Risk
  Disclosures and Vaipakam Terms") now carries real links: "Risk
  Disclosures" opens a new plain-language risk section on the Help
  page, and "Vaipakam Terms" opens the marketing site's Terms of
  Service — both in a new tab so the flow being signed is not lost.
  Previously both phrases were dead text.
- The Help page now states the platform disclaimer exactly as the
  specification mandates it — "Vaipakam is a decentralized,
  non-custodial protocol. No KYC is required. Users are responsible
  for their own regulatory compliance." — instead of a paraphrase
  that dropped the KYC sentence.
- Wallet addresses with an ENS name now display that name (the
  connected-wallet chip and the offer book's "by …" attribution);
  everything else keeps the shortened address. Pure display sugar —
  names never participate in any check or verdict, and asset
  addresses deliberately stay hex.

### Support drawer: connection health + report-a-problem (alpha02)

The naive-user app now has a Support button on every page — a small
floating control that opens a health-check panel (#1028 item 4, the
last item of that card; the lightweight port of the primary app's
diagnostics drawer).

The panel answers the questions a user actually has when the app
feels broken: which network am I on, is the blockchain connection
responding, is the market-data cache up to date (with the reassurance
that their own positions load directly from the chain when it isn't),
what app build is this, and what was the last error recorded on this
device. Checks only run while the panel is open — nothing polls in
the background.

From the panel, "Report an issue" opens a pre-filled GitHub issue
carrying exactly what the panel showed — page, network, connection
statuses, build, and the last recorded error — and a copy-to-clipboard
button covers users without a GitHub account. Reports are redacted by
construction: the wallet address is shortened to its first and last
characters, error text is length-capped, and no browser fingerprint is
included.

The app's crash-recovery card now records the error it caught into a
session-scoped slot, so a report filed after a crash automatically
includes what went wrong — closing the loop the error boundary's
original "console-only" note left open.

## Thread — a page crash is never a blank screen (alpha02 ErrorBoundary)

Until now, any unexpected error thrown while a page rendered unmounted
the whole app and left the user staring at a blank white page — the
worst possible moment being right after signing a transaction. The
retail app now contains such failures: the failed page is replaced by
a plain recovery card that says the fault is display-side, that funds
and on-chain positions are unaffected, and that a just-signed
transaction may still have gone through (check My positions after
reloading), with reload and go-home actions. The navigation around the
page stays alive, and simply navigating to another page recovers
without a full reload. A second, outer safety net covers failures in
the shell itself.

Verified by deliberately crashing a page in a local build: the card
rendered with the reassurance copy and the failing component named,
the navigation remained usable, moving to another page recovered
cleanly, and healthy pages were untouched.

## Thread — faucet gains a second illiquid token (tILQ2) so both-unpriced deals are testable

The Get-test-assets page swaps its "Second liquid test token (tLQ2)"
card for a new "Second illiquid test token (tILQ2)". The faucet now
dispenses two oracle-priced tokens (tLIQ, mWETH) and two unpriced
tokens (tILQ, tILQ2), so a reviewer can run a deal where NEITHER the
lending asset nor the collateral has a price — the fully-consent-based
path: both sides must explicitly agree, no health factor applies, and
a default hands the collateral over in kind. Previously that scenario
required hand-pasting a token address; the second liquid pairing the
tLQ2 card used to explain (health-factor, liquidation, and refinance
demos need two different liquid tokens) is now covered by pairing tLIQ
with mWETH, and the tLIQ card says so.

The new token is a plain mintable test ERC-20 deployed on Base Sepolia
with deliberately NO price-feed or pool wiring — that absence is what
classifies it illiquid to the protocol. The tLQ2 token itself remains
on-chain with its oracle wiring intact (existing offers and loans that
reference it are untouched); it simply no longer appears on the
faucet. The functional spec's faucet passage now states the intent
directly: at least two liquid and two illiquid test tokens so both
both-liquid and both-unpriced deals are testable from faucet supply
alone.

## Thread — independent token-security screening (honeypot / pump-and-dump defense)

Deals carrying tokens from outside the curated list are now screened
through an independent contract-security service (GoPlus) before they
can be accepted. The accept side is deliberately the primary defense:
a malicious actor creates their offer directly against the contracts —
never through our website — so the only screen that can protect the
person accepting is on the accept review itself. Both legs of a loan
deal and the rental prepayment token are checked; a token flagged as
a honeypot, sell-restricted, a counterfeit of a well-known token,
able to self-destruct, giving its owner per-address tax control,
owner-blacklistable-and-pausable, carrying punitive buy/sell taxes,
or taking ANY fee on plain transfers (the protocol's vault
accounting cannot absorb fee-on-transfer tokens) blocks acceptance
with the reasons in plain words — because a token like that can be
impossible to sell or transfer no matter what the deal terms say,
which is exactly the harm the unpriced-asset consent warnings cannot
catch. Softer structural risks — upgradeable proxies, hidden or
reclaimable ownership, owner-modifiable taxes or transfer limits,
anti-whale limits, trading cooldowns, whitelists, minting and
balance-rewrite powers — are disclosed as warnings. "Couldn't verify" is never treated as clean:
a token whose contract source is unverified, or whose critical
honeypot check the screen could not evaluate, is blocked outright
(those are precisely the least-checkable tokens); secondary trade
checks or taxes the screen could not evaluate are disclosed as
warnings rather than assumed clear, and an outage of the
screening service holds acceptance back with a working retry — the
check re-probes on its own and the review offers a "Check again"
button. Softer owner-power findings become warnings the user
knowingly proceeds past — and consent is re-collected whenever the
disclosed warning text changes, not just when a verdict first
appears. The verdict is re-checked at signing time so a flag landing
after review still aborts before any signature; a warning that was
never shown on the review screen aborts the signing too, and the
review then displays it so consent can be given against what is
actually known.

Pasting an unknown token address when building an offer surfaces the
same verdict immediately at entry, and posting an offer is gated the
same way accepting one is — the creator's own tokens go into vault
custody at the requested amount, so a flagged or unverifiable token
holds the post button and is re-verified at signing time before any
approval can mine. Curated tokens are pre-vetted and
exempt; test networks — which the security service does not index —
show an honest "not covered here" notice instead of blocking, so
faucet-token testing keeps working. The screening service's public
endpoint needs no account or key, and verdicts are cached so browsing
stays inside its rate limits. Risk badges on the offer-book and
guided-match cards follow as the final slice of this work.

## Thread — operators can pause new-position flows without a code change

The retail app gained a write-path kill switch: by setting one deploy
variable, the operators can switch off posting offers, accepting
offers, listing NFTs, renting NFTs, or depositing VPFI — individually
or all at once — while an incident or suspected bug is investigated.
A switched-off flow explains itself with a banner in plain words and
reassures the user that everything already theirs is unaffected.

The switch is deliberately one-sided: only flows that OPEN a new
position can be paused. Repayments, claims, and withdrawals are
structurally outside the switch's reach — an operator precaution must
never be able to trap funds or make a borrower miss a deadline. This
mirrors the same tier principle the sanctions gate follows: entry
paths can close, exit paths stay open.

## Thread — offer deep links work the moment the transaction mines

Sharing or opening a "?offer=" deep link right after posting an offer
could show "We couldn't find that offer" for the length of the
indexing service's ingest window — the offer page resolved its id
from the indexed data alone. It now falls back to reading the offer
live from the chain when the indexed lookup misses (the same fallback
the loan page has had since the claim-center work), so a link works
the moment the transaction mines. A true not-found (no such offer id)
still reads as not found, and a transport failure still reads as
unavailable. Found by live-testing the two-illiquid-token flow on
Base Sepolia.

### Fewer wallet prompts: gasless Permit2 approvals (alpha02)

Posting an offer, accepting one, renting an NFT, and depositing VPFI
previously needed a separate token-approval transaction before the
real one. For wallets that already hold a standing Permit2 approval
for the token — set once by the first Permit2-based app the wallet
ever used, such as Uniswap — that approval transaction is now
replaced by a free Permit2 signature (#1038):

- Posting an offer becomes one signature plus one transaction — no
  waiting for an approval to mine between prompts.
- Accepting an offer or renting becomes two instant signatures (the
  terms consent and the permit) plus one transaction — a single gas
  payment.
- The permit path itself never needs the double-approval dance some
  tokens force (resetting an old approval to zero first) — it only
  engages when no approval exists at all. A wallet holding a leftover
  partial approval keeps the classic sequence, including that
  clean-up reset.
- Hygiene bonus: a permit authorises one exact pull and expires in 30
  minutes — no standing allowance is left behind.

The permit path only engages when both preconditions hold, checked
live at submit time: no approval for the protocol exists at all (with
a sufficient standing allowance the app keeps the single-transaction
classic path — fewer prompts still; and a leftover partial allowance
also keeps the classic path, so its clean-up step still resets the
stale approval rather than leaving it behind), and the wallet's
Permit2 approval covers the amount (without it the permit variant
cannot work on-chain, so attempting it would only waste a doomed
transaction). Wallets without a Permit2 approval never see a permit
prompt and keep exactly the flow they had before. If the wallet
declines the permit signature — or can't produce one — the app falls
back to the classic approve-then-act sequence automatically: the new
path is an upgrade, never a gate. The pre-submission confirmation
count shown on the review never under-promises: the permit path
matches it or finishes early, and if a declined permit prompt forces
the classic sequence, the live step counter widens to count the extra
interaction honestly instead of repeating a step.

One safety subtlety carried deliberately: the automatic fallback ends
at the signature step. Once the permit transaction itself has been
handed to the wallet, any failure surfaces as an error instead of
silently retrying the classic way — an ambiguous network failure
could sit on top of a transaction that still confirms (executing the
action twice), and a definite rejection usually means the action
itself can no longer succeed, so a classic retry would only pay for
an approval it cannot use. Retrying manually re-runs all the checks.

## Thread — wallet-prompt narration reaches the manage and VPFI surfaces

The last slice of the signing-transparency work: the loan detail
page's actions (repay in full or partially, add collateral, close
early, claim) and the VPFI vault deposit now narrate their two-step
sequences too. While an action runs, the page shows which prompt the
wallet is on — "Approving in your wallet…" then "Submitting…" —
instead of buttons that merely grey out, and the VPFI deposit button
itself reports the same stages. These are inline two-prompt actions,
so they get the live narration without the full pre-disclosure
roadmap the offer and rental review screens carry.

## Thread — wallet-prompt roadmap reaches the rental flows

The signing-transparency treatment shipped for the offer flows now
covers both sides of NFT rentals. Listing an NFT pre-discloses its
one or two confirmations (the one-time collection permission — named
as such, and dropped from the list when it already stands — then the
listing transaction). Renting pre-discloses its two to four
confirmations: the free terms signature, the prepayment approval
(with the two-confirmation reset case and the "still checking"
uncertainty state named honestly), and the rental transaction. Both
buttons report live position — "Signing terms… (1 of 3)",
"Approving… (2 of 3)" — while the sequence runs, and both submissions
carry the same double-click guard the offer flows gained.

Remaining under the same card: the repayment and VPFI deposit
surfaces (two-prompt flows) get the staged labels next.

## Thread — every wallet prompt announced before it happens (offer flows)

Creating an offer asks for up to three wallet confirmations and
accepting one for up to four (sign the terms, approve the token —
twice when the wallet needs an old approval reset to zero first —
then submit) — and until now the app never said so: the whole sequence ran
behind one flat "Waiting for wallet…" spinner, so the second and third
prompts could read as something going wrong, or worse, something
suspicious.

The review screen now carries a roadmap before the first prompt:
"You'll confirm N times in your wallet, in this order", with each
step named in plain words — the free terms signature, the token
approval (including the honest "two confirmations" case where the
wallet requires an old approval reset to zero first), and the final
transaction. The count is live: an approval already in place drops
out of the list, down to "One wallet confirmation finishes this."
While the sequence runs, the button reports position — "Signing
terms… (1 of 3)", "Approving… (2 of 3)", "Submitting… (3 of 3)" —
instead of the undifferentiated wait.

This covers the offer post and accept flows the concern was raised
about; the rental, repayment, and VPFI surfaces follow under the same
card, and the deeper prompt-reduction path (signature-based approvals)
is tracked separately.

### Send a support ticket from inside the app (alpha02)

The Support panel (the round button in the corner of every page) can
now send a message straight to the team (#1040 phase 1):

- Write what happened in your own words, optionally leave an email
  for a reply, and send — you get a ticket number back immediately.
- With one explicit tick, the report attaches the panel's own health
  details (network, connection checks, app version, the last recorded
  error) — the details that usually hold the cause. Nothing is
  attached without that tick, and your full wallet address is never
  part of the health details.
- Prefer email, or want to add more later? Every path offers a
  prefilled email to support@vaipakam.com carrying your ticket
  number, and the Help page gains a "Need a human?" section with the
  same address.
- Honest failure states: if too many messages went out, the panel
  says to wait a minute; if the support inbox can't take the message,
  it says nothing was lost and hands you the email path instead —
  the app never claims a ticket number it didn't get.
- What sending stores is stated next to the button, before anything
  is sent: the message, the reply address if given, the consented
  health details, and the ticket number.

- What sending stores also names the page and network context that
  travels with every ticket, so nothing rides along unstated even
  when the health-details box is left unticked.

Operators are notified of each new ticket over Telegram (the
operations alert channel) — the notification carries the ticket
number and context flags only, never your message text or email —
so a ticket is seen even if the follow-up email is never written. A
failed alert is retried once, and a daily operational report of
open tickets backstops it, so a ticket can never sit unseen
indefinitely. Wallet addresses in the page field and health details
are shortened again on the server, whatever the sending app did.
Tickets are deleted automatically no later than 12 months after
submission (earlier on request, via support@vaipakam.com — the
policy's contact section now names that address) — and they are
excluded from the long-lived monthly and yearly backup archives, so
a ticket's backup copies live only in the 30-day nightly tier and
the deletion promise holds everywhere. A ticket sent from an
unsupported network now carries the wallet's actual network id, the
key fact for exactly those reports. The policy also gains an
"Alert subscriptions" section naming Telegram's role in delivering
the alert messages users already opt into — a pre-existing flow the
policy had under-disclosed. The Privacy Policy (bumped to Version 3,
both the source document and the public /privacy page) gains a
matching "Support tickets" section and now names every processor
involved: Telegram for the metadata-only operator alert, and
Backblaze for the encrypted nightly backups (ciphertext only) that
support tickets join alongside the other off-chain records — so a
storage incident cannot silently drop them, and the restore runbook
covers them too. In builds where no support backend is configured,
the panel says so and offers the email path — it never pretends.

### Risk badges on the offer book and matcher; flagged offers leave the shortlist (alpha02)

The independent token-security screen already guards the accept
review (a deal with a flagged token cannot be signed). It now also
warns EARLIER, while the user is still browsing (#1036):

- Offer Book rows and guided-match cards wear a compact badge when a
  non-curated token in the offer carries a concrete finding: **Risk
  flagged** (dangerous — the review will refuse it), **Caution**
  (owner powers or taxes — the review shows details), or **Not
  screened** (the check could not run — extra care).
- The guided matcher no longer recommends offers whose token is
  flagged as dangerous: they are withheld from the shortlist, and the
  list says how many were hidden — never a silently thinner set of
  matches. Caution-tier and unscreened offers stay listed, wearing
  their badge.
- The Offer Book itself never hides rows — a browse surface must not
  misrepresent what the market holds; enforcement stays at the accept
  review.
- One batched security lookup now screens a whole page of offers at
  once, and every verdict is shared with the review gates — each
  token is screened once per session, whichever surface asked first.

On test networks the security screen has no data, so badges stay off
there (every faucet token would otherwise be marked); the accept-
review posture on test networks is unchanged.

## Thread — a free dry run under every review, before the wallet asks

The retail app's review step now runs the exact transaction it is
about to request as a free, read-only dry run against the chain —
before the wallet prompt, before any gas. The verdict appears as one
plain line under the review: a quiet "dry run passed", or a clear
heads-up that this exact transaction just failed in rehearsal — with
the reason, and the reassurance that nothing was sent and no gas was
spent. Flows whose submission grants a token or NFT approval first
show "an approval will be requested first — expected, not a problem"
instead of a false alarm, since the rehearsal cannot see the approval
that hasn't happened yet.

The dry run is a heads-up, never a gate: it does not disable the sign
button, and when it can't reach the network it says so quietly and
steps aside. It covers posting lending and borrowing offers, listing
an NFT for rent, VPFI vault deposits and withdrawals, and listing a
loan for sale. Accepting an offer and posting a refinance request are
deliberately not previewed: their transactions embed pieces that only
exist at signing time (a signed terms attestation; live loan state
written moments earlier), so a rehearsal would routinely fail for
reasons that are not real — and a warning that cries wolf teaches
people to ignore it.

# Connected app (defi) — resilience ports from alpha02 (#1031)

Three hardening behaviours proven on the alpha02 surface now also apply
to the connected app:

- **WebSocket-first RPC transport.** Each chain can carry an optional
  WebSocket endpoint (derived from the same env naming as the HTTP
  endpoint: `*_RPC_URL` → `*_WSS_URL`). When one is configured, the app
  connects over WebSocket and silently falls back to batched HTTP if
  the socket can't connect or drops. No behaviour change on chains
  without a configured WebSocket URL.
- **Honest allowance reads.** The Allowances page no longer silently
  omits a token whose allowance read failed. Failed reads are counted
  and surfaced in a warning banner (translated in all ten languages)
  with a retry button, so "no allowance shown" can't be mistaken for
  "no allowance granted".
- **Accurate wallet-rejection detection in diagnostics.** The journey
  log now recognises a wallet rejection wrapped inside a library error
  (the common shape modern wallets produce) instead of only the bare
  top-level rejection code. Rejections a user made in their wallet are
  classified as wallet events rather than misfiled as contract
  reverts, which keeps the Diagnostics drawer's story truthful.

### Fixed: dead loan links and a blind live-tail in the pro app

Two defi-side fixes (#1057, #1064):

- Several places still pointed at the loan-details page's old address
  from before the app's routes were flattened — the "View loan"
  button on offer details, claim rows, activity rows, the offers
  table, and the rewards history, plus the loan links inside
  keeper-sent Telegram/Push alerts. All landed on "page not found".
  Every link now uses the current address, and the old address keeps
  working as a redirect so alert messages delivered before this fix
  still land on the loan.
- The pro app's near-realtime catch-up (the scan that bridges the gap
  between the market cache and the chain head) recognised events by
  hand-typed signatures that had silently drifted from the deployed
  contracts — a drifted signature matches nothing, so the catch-up
  went quietly blind. The event signatures are now derived from the
  compiled contract definitions themselves (the same single-source
  rule the indexer and alpha02 already follow), and a renamed event
  now fails loudly in tests instead of silently matching nothing.

## Thread — security headers: alpha02 gains its set; defi + www's broken sets repaired

The retail app now ships browser security headers: a Content-Security
Policy whose script sources carry NO third-party hosts (the app loads
no analytics and no external fonts, so its policy is tighter than the
pro app's — though inline/eval script remains allowed for wallet-SDK
compatibility, with nonce-tightening left as a follow-up), clickjacking
protection that still allows embedding inside the Safe multisig
dapp-browser, MIME-sniffing and referrer hardening, and deploy-cache
rules — the app shell revalidates on every load so a redeploy can
never leave a wallet-connected client running stale code against
changed contract artifacts, while the content-hashed bundles stay
long-cached.

Porting the pro app's header file surfaced a real production bug: the
file in both apps/defi and apps/www had been markdown-mangled at some
point — the catch-all path rule read `/_` instead of `/*`, so the
ENTIRE security-header block (CSP, nosniff, referrer policy,
clickjacking rules) applied to no path at all, and the immutable-cache
rule for hashed assets was similarly dead. Verified live before the
fix: defi.vaipakam.com served no CSP and no nosniff header (only the
intact entry-point revalidation rule worked). Both files are repaired
— the same protections those apps always intended are now actually
served, including the Safe-subdomain frame allowlist which had also
degraded into a literal underscore hostname.
