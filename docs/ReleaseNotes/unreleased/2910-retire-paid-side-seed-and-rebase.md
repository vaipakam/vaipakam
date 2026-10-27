## Rewards — the paid-side seed and rebase are retired (PR #2944)

Every chain that runs delivered reward accounting keeps two running totals:
how much reward funding has been delivered to it and how much it has paid
out. Two one-time administrative calls existed for a Diamond upgraded in
place from a build that did not keep the paid total. They wrote a
reconstructed paid figure into it, and on the canonical chain they set the
delivered total to match. Each had a one-shot guard. Until the second one had
run, the custody activation refused, every pre-activation funding, relocation
and release refused too, and the all-facets refresh had a bootstrap mode that
asked the operator for the reconstructed figure.

Every chain reaches this build by a fresh deploy, and a fresh deploy starts
with both totals at zero: there is no paid history to import. The deploy only
ever called both writers with zero, to close them. They are removed together
with everything that served them:

- the two administrative writers, their events, the two "has it run" views
  and the seven refusals they could raise;
- the activation's and the pre-activation custody writers' requirement that
  the rebase had run, and its two refusals. The activation still verifies, on
  the canonical chain, that delivered equals paid, which a fresh deploy
  starts at;
- in the deploy, the step that closed both guards;
- in the all-facets refresh and its testnet wrapper, the bootstrap mode: the
  pause-epoch and reconstructed-figure answers, the preflight checks on them,
  the seed and rebase calls and the "bootstrap complete" exit. The wrapper now
  exports only the reward-role answer the role backfill needs;
- in the activation script, the check that the rebase had run.

What an operator sees: the refresh no longer takes the paid-total answers and
has no bootstrap mode, and activation no longer waits for a rebase. A mirror
that ends up paying out more than it was delivered (a deficit) still gets the
same restitution split when it is next funded. The two storage flags keep
their places, marked retired, so the storage layout is unchanged.

Refs #2910.
