# Record: the platform's rules (PLT)

For each statement: its sources, its mark, and the approval hash of the text the owner
approved. Marks: K kept, C changed, N new. A dropped rule has no statement and is listed
under "Dropped".
The fuller drafting record, with each read of each draft, is kept with the project's records.

Sources that are files were read at commit `eac673217e` of the main branch unless a line says
otherwise. "Owner decision" names the owner's own words on that date.

Short names: PD `docs/DesignsAndPlans/PayoutDestinationRuleDesign.md`,
OP `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md`,
PR `docs/FunctionalSpecs/ProjectDetailsREADME.md`,
D2 `docs/DesignsAndPlans/GlobalPauseD2Design.md`,
TA `docs/DesignsAndPlans/TermsAcceptanceEnforcementDesign.md`,
PK `docs/DesignsAndPlans/ProjectKitDesign.md`,
FL `docs/DesignsAndPlans/FlashLendingDesign.md`.

## Statements

| Id | Mark | Sources | Approved |
| --- | --- | --- | --- |
| PLT-001 | K | Owner decision 2026-11-19 ("all to the vault, one Withdraw"). PD "2. The rule", item 1, and "4.2 Own action, or someone else's" | afeaf51a8287a43f |
| PLT-002 | K | PD "2. The rule", item 2; "4.3 One door to a wallet"; "4.6", the rows for the recovery address and a caller's unspent fee. Changed with section 7: an account's recovery address is paid from that account only by the steps of a recovery, which it cites (VLT-624). Confirmed by the owner with section 7 on 2026-11-23, 06:03 UTC. | 43ff89d54575a440 |
| PLT-003 | K | PD "2. The rule", item 3, and "4.6" (the last paragraph for the protected payee). OP "3.7.4", the row for an integrator's or a referred user's share: a budget set from the opening fee, paid to a vault. | eeff9c5e4204b2cd |
| PLT-004 | K | PD "4.1": "No step names a payee" | edc27ee9cfde63fe |
| PLT-010 | K | Owner decision 2026-11-19 (idle funds are never routed outside, except a loan that completes in one transaction). FL "2. The rule", item 1, as amended 2026-11-19 (the part not lent of a lending balance). For the treasury: the repository's architecture notes, the treasury row ("deploys nothing into external yield venues") | 8cffcc379e45ed4a |
| PLT-011 | K | Owner decisions 2026-11-19 and 2026-11-20. `docs/DesignsAndPlans/BorrowingDesign.md`. OP "3.7.2", "A borrowing holds no lien" | aaa92e54580d28b5 |
| PLT-012 | K | Owner decision 2026-11-19 (no pooling, no shared interest; a third party gathering funds above the platform is outside the rule) | c57e6266d54388cf |
| PLT-013 | K | OP "3.7", "What the vault promises after B3". Restated for the vault as VLT-080. | f5ea99cdf5a94567 |
| PLT-020 | K | Owner decision 2026-11-19, 18:56 UTC (card 19:05 UTC): no campaign, no advice to move, no comparison with another lender's rate, facts the platform can substantiate, neutral ids. `docs/DesignsAndPlans/DefaultPathsDesign.md` for a pre-selected setting shown before signing. | f1e8ae0a6b7e07c6 |
| PLT-030 | K | Owner decisions 2026-11-17 (the fee levels) and 2026-11-19, 17:25 UTC (the same for every loan) | d458e4e81bfbbb89 |
| PLT-040 | K | Owner decision 2026-10-20. D2 "The decision", and "3. Gating": "Everything else stays paused" | 2bb86315fa95250f |
| PLT-041 | K | D2 "The decision", "Stays open". The exception: PR, "The platform does not support tokens that deliver less than they send". Changed: one exception, for a part repayment while the loan's lien is split. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:17 UTC. | c1f98711330d312d |
| PLT-042 | K | D2 "The decision", "Time credit", and "2. One loan clock" | 27b33f7062e0baab |
| PLT-043 | K | D2 "5. What the credit does not cover". OP "3.7.2", item 3: interest accrues for as long as a loan is open. | a1e4a0fee4436c9f |
| PLT-050 | K | PK "8. The guards", item 3, the fourth and sixth points (cards #3880, #3887, #3909) | d4b06cae05ee27bc |
| PLT-051 | K | PK "8. The guards", item 3, the fourth and fifth points. Changed: one exception, for a part repayment while the loan's lien is split. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:17 UTC. | def67bb3bd0abae0 |
| PLT-060 | K | PR "16. Regulatory Compliance Considerations": "Address-Level Sanctions Screening", and "Sanctioned Proceeds and Position Freeze" for the position token. | 672dd9be7c5bfaac |
| PLT-061 | K | PR same section, "Sanctions Wind-Down Carve-Out". Changed: one exception, for a part repayment while the loan's lien is split. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:17 UTC. | b44899231211720f |
| PLT-062 | K | PR same section, "Sanctioned Proceeds and Position Freeze" and "Central Freeze Enforcement" | 046519acf50e53fa |
| PLT-063 | K | PR same section, "Sanctions Wind-Down Carve-Out", its last sentence. | 8d9f8e111aa5acaa |
| PLT-064 | K | PR same section, "Secondary-Market Protection" | 77b197cda0ff54fb |
| PLT-065 | C | Kept: PR same section: "Sanctions Oracle Availability" (#1006), "Fail-Closed Frozen-Proceeds Release", "Confirmed-Flagged Position Movement". Changed: a step that opens a position or takes a new commitment is refused while the screen cannot be read. The owner approved as option 2 on 2026-11-22 09:17 UTC. | 76bf8e6d9047f133 |
| PLT-070 | K | TA "3. The rule" and "3.1 Where it is checked" | a129b6fad9475aa1 |
| PLT-071 | K | TA "3.2 What is never checked" | a84484a4df342ca5 |
| PLT-072 | K | TA "3.2", "A run of a standing instruction", and "3.1", "A refused fill does not cancel anything". Owner ruling 2026-11-20. | e7ed2e105a3c51ba |
| PLT-080 | K | `docs/DesignsAndPlans/PriceGuardDesign.md`. PR "A Distrusted Price Refuses The Close-Out; It Never Gives The Lender Everything" (owner decision 2026-10-22) | 1bad4ed4dc829725 |
| PLT-090 | K | PR "Loan Deadlines Wait Out An L2 Sequencer Outage (#3410, owner decision 2026-11-09)". The release note of 2026-11-11. | 0a2951c0e46a4037 |
| PLT-091 | K | Same paragraph: the due date, the interest and a periodic deadline are not moved; only the latest outage is known. | 9aa7d79488a94490 |
| PLT-100 | N | New. Raised by mistakes VLT-M13, PLT-M01. Approved by the owner on 2026-11-22, 09:17 UTC. | a6838f6b5c479fcc |
| PLT-101 | N | New. Raised by mistake VLT-M14. Approved by the owner on 2026-11-22, 09:17 UTC. | 69a275ed34d08d81 |
| PLT-102 | N | New. Raised by mistake VLT-M14. Approved by the owner on 2026-11-22, 09:17 UTC. | 751c493b45e45da6 |
| PLT-110 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 09:17 UTC. | 7158e0b83a48b355 |
| PLT-111 | K | PR, "Reentrancy Guards: Applied to all functions involving external calls or asset transfers", and "Re-entry and pause protections apply consistently across value-moving flows" | 081cf2fac29246de |
| PLT-112 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 09:17 UTC. | 643804c642d5c2c6 |
| PLT-120 | K | Owner decision 2026-11-22 on events: one fact, one event, and every skip and fallback. `docs/DesignsAndPlans/RefactorRulesDesign.md`, "6. Rule 2" | 7a944a6484283637 |
| PLT-121 | K | Owner directive 2026-09-09, as `AGENTS.md` records it under "Standing principle": funds and lifecycle state get stated, never implied. | a565c6bf2894a25d |
| PLT-122 | K | The owner's standing rule that a liquidation makes the lender whole first (owner decision 2026-10-20 for the sale routes). PK "8. The guards", item 3: "a lender is made whole first and every close-out stays open" | 1d4c5df852c66ea4 |
| PLT-123 | C | PR, the liquid and illiquid asset rules: an asset with no price is valued at nothing, is handed over whole on a default, and needs both parties' consent. The owner's standing rule that the contracts do not curate assets. Changed: where this statement said that the one step acting on a named asset is its pause, it cites PLT-124. The wording is entered for the owner's confirmation with this folder, under his approval of the price rules on 2026-11-22 (13:30, 15:05 and 16:24 UTC). | 443f90f117e905df |
| PLT-124 | N | New. Raised by threat PLT-T17 and by the conflict read of PLT-123: the owner's principle that no asset is gated, as a never. Entered for his confirmation with this folder, under his adoption of the principles on 2026-11-22. | c1a75ec627d268c1 |
| PLT-125 | N | New. Raised by the conflict read of PLT-123. Each step it lists was approved by the owner on 2026-11-22 (13:30, 15:05 and 16:24 UTC) with the price rules. As one statement it is entered for his confirmation with this folder. The list stays open until the domains to come are entered: a step they bring joins it by a change the owner confirms. | 93fc0b9d6e824215 |
| PLT-126 | N | New. Raised by the conflict read of PLT-123. Each step it lists was approved by the owner on 2026-11-22 (13:30, 14:31, 15:05 and 16:24 UTC) with the price rules. As one statement it is entered for his confirmation with this folder. Open in the same way as PLT-125. | b5e1e88951eb2ba8 |

41 statements. Kept: 31. Changed: 2. New: 8.

## Approvals

- The platform's rules were approved by the owner on 2026-11-22 at 09:17 UTC, with his answers
  to the six questions put to him.

## Changed after an approval

These changes were made after the approval above, and are entered with this folder for the
owner's confirmation. Each was read for conflict before it was entered.

- PLT-123 is reworded, and PLT-124, PLT-125 and PLT-126 are new. PLT-123 said that the one
  step which acts on a named asset is its pause. The owner has since approved the steps of the
  price rules that name an asset. PLT-124 states, as a never, that no step names an asset to
  admit it or to give it better terms than its readings earn. PLT-125 lists the steps that
  take from a named asset. PLT-126 lists the steps that give an asset a source for a reading
  or name it as a reference, and says that they admit no asset and refuse none.
- PLT-041, PLT-051 and PLT-061 each name one exception: while a loan's lien is split, only a
  repayment of all the loan owes is taken (VLT-155).
- A keeper pass that a statement owes is cited under the keeper's own code, where the draft he
  read cited it under the authority rules. Form only.

## Mistakes answered

| Mistake | Answer | Statement |
| --- | --- | --- |
| PLT-M01 | Refuse | PLT-100 |
| VLT-M14 | Warn only | PLT-101 |

## Retired ids

None.

## Owed

References to rules of a domain that is not entered yet. Each is replaced by a statement id
when that domain is entered.

| Owed | Cited by |
| --- | --- |
| APP owed: the tests of each surface | PLT-020, PLT-121 |
| AUT owed: when the per-asset pause may be placed, and how each use is published. | PLT-051 |
| DPL owed: where that is allowed | PLT-065 |
| FCL owed: the order among the lender's side, the fees and a caller's reward. | PLT-122 |
| FEE owed: the schedule, and how it applies to an NFT rental. | PLT-030 |
