## Shared RiskCallout component — the canonical state-mutating-confirm risk shape (Issue #215)

Per the UX direction ADR landed via PR #201 (`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`, Tier A.12), the canonical visual idiom for "this state-mutating action carries risk; confirm you understand" is a single shape — a coloured-band wrapper around localised risk disclosures with an inline consent checkbox, modelled on the DEX "slippage too high, increase tolerance" inline-warning convention.

Pre-#215, four pages (`CreateOffer`, `OfferBook`, `BorrowerPreclose`, `LenderEarlyWithdrawal`) each duplicated the same nine-line pattern — `<RiskDisclosures />` followed by a `<label className="checkbox-row">` wrapping `<input type="checkbox">` and `<RiskConsentLabel/>`. The duplication meant each consumer page could drift independently in spacing, behaviour, or accessibility wiring.

This release adds the shared `RiskCallout` component
(`apps/defi/src/components/app/RiskCallout.tsx`) plus its stylesheet
and a Vitest unit suite. The component composes the existing
`RiskDisclosures` body for the localised copy and `RiskConsentLabel`
for the consent text — so this PR adds the canonical wrapper around
existing pieces rather than duplicating any translation strings or
disclosure logic.

Consumers migrate from the nine-line pattern to a single
`<RiskCallout consent={...} onConsentChange={...} />` call in the
per-page rework cards that depend on this one (#204 CreateOffer,
#206 OfferDetails, #210 Refinance, #211 BorrowerPreclose,
#212 LenderEarlyWithdrawal, #218 BuyVPFI). This PR ships the
component alone with no consumer migrations — each consuming
sub-card lands its own minimal diff that swaps the duplicated
block for `RiskCallout`.

Accessibility shape recorded in the component's JSDoc and exercised
by the test suite: the wrapper carries `role="region"` with an
`aria-labelledby` pointing at a visually-hidden heading inside the
band, the checkbox uses `htmlFor` / `id` pairing rather than nesting
inside the label, and the input carries `aria-required="true"` to
announce the consent gate to screen readers.

The component also exposes an `extra` slot so per-flow risk details
(an early-withdrawal haircut chip, a refinance preview line, a buy-
flow cross-chain disclosure) can render INSIDE the colour band
between the disclosures body and the consent row — keeping the
per-flow content close to the consent gate it pertains to, without
forcing the shared component to know about every flow's specifics.

Tests: 10 unit cases covering consent state both directions, the
disabled state, the aria-required wiring, the labelled-region
contract, the extra-slot rendering, className passthrough, and
unique-id generation across multiple co-mounted instances. The test
mocks `react-i18next` so the suite stays focused on the component's
own behaviour; the localised disclosure content is exercised by
`RiskDisclosures`'s own coverage.

Closes #215. Unblocks the six consuming sub-cards (#204, #206, #210, #211, #212, #218) per the #166 ADR's dependency graph.
