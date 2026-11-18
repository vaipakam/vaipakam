## Thread — Integrator share of the initiation fee

A front end, wallet or aggregator that brings a borrower to the platform can now be registered as an integrator and paid a part of the loan initiation fee. The borrower pays the same fee either way, and the treasury keeps the same floor: the share comes out of the part of the fee above the floor, which was otherwise the reserve's. The default rate is 10% of that part, at most 50%, and one per-loan ceiling (60% by default, settable from 40% to 70%) bounds the matcher's, the integrator's and, later, the inviter's shares together.

Only the borrower's own action names an integrator: its own offer, its signed acceptance of a lender's offer, or a signed offer. A match, a fill or an Auto-lend fill of a borrower's offer reads that offer's integrator. The share is delivered into the integrator's own platform vault as one isolated step, so a token that refuses the transfer cannot stop the loan from opening; a share that is not delivered, or an integrator that is unregistered, suspended or is the borrower itself, goes to the reserve. One event states each named integrator's outcome.

The registry is a new facet. Adding, changing and removing an entry wait the administrator's delay; the guardian can suspend one at once. Each entry carries a public record of loans brought and loans that defaulted within a week of opening, and anyone can read the whole list together with the platform's own contracts on the chain. The offer and loan records now name the integrator, and a lender can attribute a standing intent to the integrator it came through, which earns nothing.

The signed acceptance terms, the signed offer and the offer-creation parameters each gained an integrator field, so front ends and the indexer need the new ABIs. Design and build notes: `docs/DesignsAndPlans/IntegratorFeeShareDesign.md`. Closes #3682; advances #3719 and #3720.

A borrow preview can now point to one standing lender offer and have the platform check it against the borrower's quote: not checked, not comparable, refused by name, or checked with the rate and amount and whether it beats the quote. A borrower with a posted request is checked through the match preview; one without, through the accept preview, which can take only an offer of exactly the borrower's amount. The check never claims an offer is the best available.

> Caveat: the loans-opened-with-a-warning counter stays at zero until the loan warnings mask (#3685) exists; a test fails as soon as the mask appears, so the counter is connected in that change.
