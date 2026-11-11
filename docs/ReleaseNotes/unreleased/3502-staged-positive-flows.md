## Thread — Positive flows broadcast again, in stages (PR #<n>)

Since the offer-age rule (#3412), an offer or a lender intent can be filled
only once its terms have stood a minimum age (5 seconds by default). Since the
transfer cooldown (#3413), a position NFT cannot move until a few seconds after
value last left its position, so a loan cannot be opened and handed on at once
either. One `forge script --broadcast` cannot wait between its own
transactions: forge simulates the whole run first and then sends every
transaction back to back, so the positive-flow scripts, which post an offer and
then fill it, stopped before sending anything. That left rehearsals with
nothing on chain.

The lifecycle, advanced-credit, lender-intent and position-holder modules now
run in stages. Each scenario is a list of steps, split wherever it fills terms
it posted or moves a position it opened. A new runner, `run-staged.sh`,
broadcasts one stage per `forge script` call and waits between stages for the
longer of the two rules: on a local Anvil it steps the clock, and on a live
chain it waits for the chain's own clock. A read-only finish then prints each
scenario's result and removes the run's record. Scenarios never interleave.
Each runs to its end before the next starts, so a price or an admin switch one
of them moves is never seen by another. A step that moves one puts it back
within the same step.

A stage runs only on top of a stage that landed whole. Forge writes files
before it sends anything, so the record also carries every actor's account
nonce as the stage's simulation left it. The next stage, and the finish,
refuse to continue when any account on the chain differs, and name the record
to remove for a fresh run. Without this check, a broadcast that stopped
part-way would let a later stage act on positions that do not exist.

Two things a broadcast does that a simulation does not are now allowed for.
Interest accrues by the second, so a repayment approves the simulated amount
plus an hour's interest. The runner also gives each stage twice the gas the
simulation measured, because a loan opened and repaid in one step accrues no
interest in the simulation but does on chain, and the fee legs cost more gas
(a measured repayment ran out of gas at forge's default margin).

`PositiveFlows.s.sol` is now documented as a simulation, which is all it can
be until every module is staged. A dry run needs `--skip-simulation`.
Otherwise forge replays the recorded transactions at the chain's own clock,
without the clock steps the scenarios took, and reports a failure after every
scenario has passed. The partial-refresh rehearsal drives its sale scenario
through the staged runner.

Several scenario checks had been failing on main since value began landing in
vaults (#3205 part 2), because they measured wallets. They now measure where
the value actually goes, through one shared vault-balance read:

- the range-match matcher's fee share, worked out from the borrower's vault;
- the treasury's initiation fee, from the borrower's vault plus the matcher's
  share that still returns to the borrower's wallet on a direct accept;
- the collateral and repayment a moved position's new holder receives, which
  arrive in that holder's vault at close-out;
- a full swap-to-repay's lender share, in the lender's vault, and the unsold
  collateral, which never leaves the borrower's vault.

A partial swap-to-repay still pays the lender's part to the lender's wallet,
and a full one pays the borrower's surplus to the borrower's wallet. The
scenarios assert those destinations as they are today; moving them into vaults
belongs to #3268.

The treasury scenario no longer points an external-treasury deployment at the
Diamond to try the withdrawal half. A vault pays treasury fees only to the
treasury fixed in its code (#3431), so after that switch the next accept was
refused. The withdrawal half now runs only on a deployment whose treasury is
the Diamond. #3569 tracks making the treasury setting say that a treasury move
is a vault code change.

Advances #3502. The partial and negative flow scripts, the remaining modules
and the Sepolia seeding scripts are not staged yet. The timed module (cancel
cooldown, periodic checkpoint) keeps its own stages for now, and its open stage
has also stopped since the offer-age rule, because it opens the periodic loan
by filling an offer it just posted. #3574 moves it onto the same runner, so the
tree has one staged pattern, and then stages the rest.

> Caveat: the timed run, the partial flows, the negative flows and the vault, keeper, operator and swap-to-repay modules still stop under `--broadcast` with `TermsAgeNeedsStagedRun`; run them as simulations until #3574 stages them.
