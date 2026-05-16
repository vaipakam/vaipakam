# How the Vaipakam Treasury Works — A Plain-Language Guide

**Who this is for:** Anyone — users, the community, the curious — who
wants to understand where the protocol's money goes and how the team
gets paid, without reading contract code.

**The short version:** Vaipakam earns small fees when people lend and
borrow. Those fees collect in a protocol-owned treasury. The treasury
can be tidied up into stable assets, and it pays the founder a normal,
transparent **salary** — not a secret cut of your fees. Everything
happens on-chain where anyone can see it, and nothing can be drained
quietly.

> This is an explainer, not the legal or technical source of truth.
> The precise rules are in
> [`TreasuryFunctionalSpec.md`](TreasuryFunctionalSpec.md) (for
> auditors) and [`TreasuryAndFounderDistribution.md`](TreasuryAndFounderDistribution.md)
> (the design rationale).

---

## 1. What is "the treasury"?

Every time a loan is repaid, Vaipakam keeps a small fee — for example
1% of the interest. Those fees don't go to a person. They collect in
the **treasury**, which is the protocol's own smart contract. Think of
it as the protocol's bank account, owned by the protocol itself.

The treasury exists so Vaipakam can sustain itself: pay for
development, security audits, marketing, and to build a reserve that
makes the protocol resilient.

## 2. Fees arrive in many different tokens — so the treasury tidies up

People lend and borrow lots of different tokens, so fees pile up as a
jumble of many assets. Periodically, the protocol can **convert** those
scattered fee tokens into a small, stable set of **reserve assets** —
expected to be assets like ETH, wrapped Bitcoin, and VPFI (Vaipakam's
own token).

A few things keep this honest and safe:

- **It only runs occasionally.** A conversion is allowed only once
  enough value has built up, or enough time has passed — so it isn't
  spamming tiny trades.
- **The converted assets stay in the treasury.** Converting does *not*
  send money to anyone. It just turns a messy pile into a tidy one,
  still owned by the protocol.
- **It's price-protected.** Each trade has a minimum-output guard, so
  the treasury can't be drained through a bad swap.
- **The reserve set and the split are fully governance-controlled.**
  Which assets the treasury converts into — and what percentage goes
  to each — is a configurable list. Governance can add a reserve asset,
  remove one, or re-weight the split; every such change is checked so
  the percentages always add up to exactly 100%.

## 3. How the founder gets paid — a salary, in the open

This is the part people rightly care about. Vaipakam is built by a
solo founder who, until launch, has worked unpaid. They need a real
income. Here's how that's done — and, just as importantly, how it's
*not* done.

**How it is NOT done.** The protocol does **not** automatically send a
slice of your fees to the founder on every transaction. That pattern —
an automatic, hardcoded cut to an insider — is exactly what has caused
trust disasters and legal trouble elsewhere in crypto. Vaipakam
deliberately rejected it.

**How it IS done.** The founder is paid a **salary** — a fixed, agreed
amount that flows steadily from the treasury, like a paycheck that
accrues every second. The key safeguards:

- **It's a budget, not a faucet.** The salary only pays out money that
  governance has *deliberately set aside* for it. If that budget isn't
  topped up, the salary simply stops. The founder can never withdraw
  more than what was explicitly funded.
- **It's a fixed rate for work** — not a percentage of how much you
  trade. Your activity does not increase what the founder earns. The
  protocol code has *no connection* between your fees and the salary's
  funding.
- **It's adjustable and pausable** by governance — and the rate can
  only change going forward, never retroactively.
- **It's all on-chain.** Anyone can see the salary rate, how much has
  been funded, and how much has been withdrawn.

In short: the founder is an employee of the protocol, paid a visible
wage — not a hidden beneficiary skimming your transactions.

## 4. Token grants vest slowly

The founder, future team members, and early contributors also receive
VPFI token grants — their ownership stake. These don't unlock all at
once: each grant sits in a **vesting wallet** that releases the tokens
gradually over years, with an initial waiting period. This keeps the
team's incentives tied to Vaipakam's long-term success — they do well
only if the protocol does well, over time.

Importantly, the pools set aside for future team members and testers
are **not** the founder's to take. If those people never join, those
tokens are simply never created — they don't quietly become a
founder bonus.

## 5. Who's in control — and the guardrails

- **At launch**, an admin key operates these functions, so the
  protocol can be tuned during the early period.
- **Soon after**, control moves behind a **48-hour timelock** — any
  change is announced on-chain 48 hours before it can take effect, so
  the community can see it coming.
- **Eventually**, the community governs these decisions by vote.

Throughout, the hard guarantees hold: the treasury's conversion keeps
money *inside* the protocol; the salary can only pay what was
deliberately budgeted; and every action emits a public on-chain record.

## 6. What this means for you

- The fees you pay fund the protocol's future — development, audits,
  security, growth — not an insider's wallet.
- The founder earns a transparent salary you can inspect at any time,
  structured the way a responsible company pays staff.
- Nothing about the treasury can happen silently or be reversed in
  your favour's absence — it's all visible, rate-limited, and
  increasingly community-controlled.

Vaipakam's goal here is simple: be a protocol you can trust *because*
you can check, not because you're asked to.
