## The keeper's kill-switch does not stop everything, and now says so

No behaviour has changed. What changed is a description that was misleading in a way that mattered.

The keeper's master switch was documented as disabling "autonomous actions". In fact it disables six of the periodic jobs — the ones that lend, liquidate, extend loans, and move reward budget — and leaves one alone: the daily oracle snapshot, which keeps signing and keeps spending gas whenever a signing key is present, switch or no switch.

**That gap is deliberate and has been affirmed rather than closed.** The snapshot is a public good rather than a risk-taking action — anyone can trigger it, permissionlessly, and the protocol wants the price series unbroken. Gating it would punch holes in that series every time the keeper was switched off for some unrelated reason, which is a worse outcome than the gas it costs.

What was wrong was only the wording, and the practical consequence of getting it wrong: an operator flipping the switch to stop the keeper spending money would have found it still spending. The documentation now states the exception plainly, names the six jobs the switch does cover, and gives the actual answer for a full stop — remove the signing key, at which point the snapshot skips as well and every gated job reports the missing key on its next run.

A second job is called out in the same place, and the switch is narrower there than it looks: the liquidity-confidence pass always runs, and consults the switch only when deciding whether to send a transaction. It keeps reading, and it keeps updating its own bookkeeping either way — deliberately, so the counter it maintains stays continuous. So the switch stops what that job spends, not what it stores.
