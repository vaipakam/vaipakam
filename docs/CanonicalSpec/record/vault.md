# Record: vaults (VLT)

For each statement: its sources, its mark, and the approval hash of the text the owner
approved. Marks: K kept, C changed, N new. A dropped rule has no statement and is listed
under "Dropped".
The fuller drafting record, with each read of each draft, is kept with the project's records.

Sources that are files were read at commit `eac673217e` of the main branch unless a line says
otherwise. "Owner decision" names the owner's own words on that date.

Short names: OP `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md`;
OI is OP's list "The open items, as the builder's scout answered them (2026-11-20)";
B1 is OP's "Build notes, part 2 Stage B1";
PD `docs/DesignsAndPlans/PayoutDestinationRuleDesign.md`;
VO `docs/FunctionalSpecs/VaultOperations.md` (in section 3, its part "Pause escape and
implementation pinning" unless another is named);
FL `docs/DesignsAndPlans/FlashLendingDesign.md`;
PR `docs/FunctionalSpecs/ProjectDetailsREADME.md`;
RB `docs/DesignsAndPlans/ReadyBalanceDesign.md`;
RA `docs/DesignsAndPlans/RecoveryAddressClawbackDesign.md`;
PT `docs/DesignsAndPlans/ProtectionThresholdDesign.md`;
LK the owner's decision of 2026-11-22 on what a lock ends.
The sources of section 5 were read at commit `4ce59b35aa` of the main branch.

## Statements

| Id | Mark | Sources | Approved |
| --- | --- | --- | --- |
| VLT-001 | K | Owner decision 2026-11-06, OP "2. The decisions", "One policy". The one exception named, VLT-043: PD "4.6" | bcf192be67426314 |
| VLT-002 | K | OP "3.1 One door in the vault": "There is no other way out of a vault". The exception named as in VLT-001. | ed562c357184d37b |
| VLT-003 | K | OP "3.2", item 7. PD "4.1", last paragraph, for a release that moves nothing. The exception named as in VLT-001. | 46407f29251d60b2 |
| VLT-004 | K | Owner decision 2026-11-06, OP "2", "Two keys" | 6ca571dad3ea834e |
| VLT-005 | K | OP "3.7", "Every vault check is an outer bound" | f73dc2b53901c751 |
| VLT-006 | K | VO "Deposits, ownership, and free funds", last item. | f271c0255141293e |
| VLT-010 | K | VO same section, third item. | 8d0ae11c7e6f50f5 |
| VLT-011 | K | VO same section, first, second and fourth items. OP "3.7.2", item 1. PD "2.1 Terms" | 4a72ab3717c08207 |
| VLT-012 | K | OP "3.3", the Owner row, layer 2. Mistakes VLT-M15, M18, M21, M42. | 6c2eeedae248a5f5 |
| VLT-013 | N | New. Raised by mistakes VLT-M15 and VLT-M21: a refusal that says what holds the rest. Approved by the owner on 2026-11-22, 09:17 UTC. | 6401a5aa890c1aa6 |
| VLT-014 | K | VO "Deposits", second item. OP "3.3", the Owner row. Changed with section 4: the watch reads a multi-unit NFT's holding as VLT-354 states. Confirmed by the owner with section 4 on 2026-11-23, 01:42 UTC. | 5f3ea3e8067b8e98 |
| VLT-015 | K | Owner decision 2026-11-06, OP "2", "A vault-held lien record". OP "3.3", Counterparty. | b7b14f4a32941939 |
| VLT-016 | K | OP "3.7.2", item 3, "The ceiling is computed at the moment of each step" (ruled 2026-11-20). The carried-interest bound: OP "3.7.2", item 3, its second paragraph. | dc438a4d10414cbd |
| VLT-017 | K | OP "3.7.4", the payment to the other side. The valuation made once, when the split is recorded: OP's open items answered 2026-11-20, "The backstop's buyout" | e590a4412baf7aa6 |
| VLT-018 | K | OP "3.7.4", same row, last sentence. | 1fe50cbf7c936035 |
| VLT-019 | K | OP "3.3", Incentive, Treasury, Backstop. OP "3.7.4", the budget rows. An inviter's and an integrator's amounts are written as parts of the opening fee, PLT-003. | 393d97e7f9502f2e |
| VLT-020 | K | OP "3.7.4", the non-party row. | ac23fbb851e449c3 |
| VLT-030 | K | Owner decision 2026-11-06, OP "2", "Own wallet only". PD "2", item 2. | c670965df6fb42e1 |
| VLT-031 | K | Same. Mistake VLT-M16. | 9cffcb5cd0780641 |
| VLT-032 | K | VO "Vault-owned authority and signed changes". OP "3.7.9". Mistake VLT-M17. | 3a79893b427a1c4f |
| VLT-033 | K | OP "2", "A vault-held lien record". OP "3.3", Counterparty, layer 2. OP "3.7.5", first paragraph. Restated to say where the amount rests, PD "4.2". Changed after the approval of section 5: the release goes to the holder's own vault, whose owner record names that holder or, once that holder has been replaced there as owner, the owner wallet on record, and never to a wallet. Raised by the review of this folder. Entered for the owner's confirmation with this folder. | fe2ff9d4acec5354 |
| VLT-034 | K | PD "4.2", second item. OP "3.7.2", item 5. | f66339ae53745aeb |
| VLT-035 | K | PD "4.2", first item. | 9624ceaf5d3ba45e |
| VLT-037 | K | OP "3.7.2", item 5. PD "2.1", "Held for a position". Changed after the approval of section 5: an amount held for a position becomes free balance in the same vault only if that vault is the holder's own vault, and is otherwise paid to the holder's own vault. Raised by the review of this folder. Entered for the owner's confirmation with this folder. | 3364a51edb4a3bb4 |
| VLT-038 | K | PD "4.1", the own-balance release. | 3cd7a713bc54c0dd |
| VLT-039 | K | VO "Independent boundaries on value leaving a vault", first item. | 6b45328308c401d2 |
| VLT-040 | K | VO same section, third item. OP "3.7.4", the swap row. | c2682f7685096935 |
| VLT-041 | K | OP "3.7.4", the non-party row. OP "3.7.8", third item. Worded as in VLT-019. | 8cf44bab3e22ea1c |
| VLT-042 | K | OP "3.7.4", the platform-token fee row (ruled 2026-11-20). The last sentence, that the treasury is never the platform's own address, is new and belongs to the deploy domain. | e1c4910379f84357 |
| VLT-043 | K | PD "4.6", the paragraph on a loan for one transaction. FL "2", "4.2", "4.3", "4.7" to "4.9": the own record, the measured return and the screens. | d11c2f2a6fd756b0 |
| VLT-044 | K | OP "3.3" and "3.7.4", the seller's claim. | 9b90fcd1331b1197 |
| VLT-045 | K | OP "3.3", Consolidation. OP "3.7.4", custody moved to a new holder. | 3c38d26d52608837 |
| VLT-050 | N | New as a statement. Its parts are kept: VO "Pause escape and implementation pinning", VO "Optional account protection", and PLT-060. Approved by the owner on 2026-11-22, 09:17 UTC. | f98f3eac12fa4e03 |
| VLT-051 | K | PD "4.4" | ac51a16884d12e07 |
| VLT-052 | N | New. Raised by mistake VLT-M18. Approved by the owner on 2026-11-22, 09:17 UTC. | e3e8e51597f465c7 |
| VLT-053 | K | VO "Optional account protection", the item on voluntary withdrawals. | 16f642fd93147f03 |
| VLT-060 | K | Owner decision 2026-11-06, OP "2", "Just-in-time approvals". OP "3.5", rule 2, for the bound to one lien. OP "7", the residual it names: an allowance a fault leaves open. | 6e0a48c70b5bfa2e |
| VLT-061 | K | OP "3.5", rule 2. | adeef54dbc739024 |
| VLT-062 | K | OP "3.5", rule 2, the two bullets. VO: "An open allowance blocks other vault movements" | 154b01add9a2b568 |
| VLT-063 | K | OP "3.5", rule 2, "Cleanup reconciles it" | 8ec76123f166dd02 |
| VLT-064 | K | OP "3.5", rule 2: "an open entry any caller may use" | ff9135a7c39870ad |
| VLT-065 | K | OP "3.5", rule 3. | 35ac1d8b700ce7fd |
| VLT-066 | K | OP "3.5", rule 1. OP "4. Pause". VO "Independent boundaries", second item. | 674f3fba179b8ad5 |
| VLT-067 | K | OP "3.7.4", the order row. | 22a3322a15f4a1d7 |
| VLT-068 | K | VO "Independent boundaries on value leaving a vault": "No allowance survives a transaction". OP "3.5", rule 2, "Cleanup reconciles it" | 9a437f168ad1451e |
| VLT-070 | K | PR, the paragraph beginning "The platform does not support tokens that deliver less than they send" | d22afb7dbc495feb |
| VLT-071 | K | Same paragraph, its first two items. Mistake VLT-M08. | 33814b8d6e6a0815 |
| VLT-072 | K | OP "3.7.2", item 5. OP "3.7.6" | c7b73606741b97e3 |
| VLT-073 | K | OP "3.7.2", item 5: "An opening or a purchase that cannot be delivered reverts" | 19ba966a8a54b816 |
| VLT-080 | K | OP "3.7", "What the vault promises after B3" | 2c72df9d49d3f32c |
| VLT-081 | K | OP "3.7.1", "A wallet never approves the Diamond" and "An NFT is sent, never pulled". Owner decision 2026-11-20, "sign, then send". Restated as what no step of the platform does. A contract's own send is VLT-116. | 0761e1d24d917af4 |
| VLT-082 | K | OP "3.7.8" | 257052c158c5244d |
| VLT-090 | C | Kept: OP "4. Pause", and PLT-040. Changed: the refusal also states when the escape route opens. Changed with the owner's approval of 2026-11-22, 09:17 UTC. | 8e6d67e4087cec30 |
| VLT-091 | K | VO "Pause escape and implementation pinning", first and second items, with the recovery address. Mistake VLT-M20. | 2c87e3f9463cbbfd |
| VLT-092 | K | Owner decision 2026-11-06, OP "2", "The owner's allowlist never gates protocol classes". VO "Optional account protection": "never delays payments it owes to counterparties", and "A settlement to a locked owner stays in the vault" | d33e7355fb318fae |
| VLT-100 | K | VO "Deposits, ownership, and free funds", first two items. PLT-012. Changed with section 5: a wallet may manage a second vault, one it owns by a replacement. Confirmed by the owner with section 5 on 2026-11-23, 01:42 UTC. | c88a158c48dd1a21 |
| VLT-101 | C | Kept: OP "3.7.1", OP "3.7.9", VO "Vault-owned authority and signed changes", first item. OP "3.7.5", first paragraph, and PD "4.7" for the holder's voice. Changed: the old line that a vault "takes instructions from one caller only" and "has no separate owner record" (VO "Deposits", fifth item) is dropped, because the later decisions gave the vault its own owner record. Changed with the owner's approval of 2026-11-22, 09:56 UTC. Changed with section 5: after a replacement the authority is the owner of VLT-455. Confirmed by the owner with section 5 on 2026-11-23, 01:42 UTC. | d80696fa98bd6779 |
| VLT-102 | N | New. Raised by mistake VLT-M01; the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. | c99107d25b7c4953 |
| VLT-103 | K | OP "3.7.2", "One record, not two", which also names the pledged total. The market's lending figures are the instant market's ledger. | b6965fe0dbc6c969 |
| VLT-110 | K | OP "3.7.2", item 1. PR "Tracked Vault Holdings (every asset kind)" | 806601436e113d78 |
| VLT-111 | K | OP "3.7.2", item 1. PR "Depository Vault", for a reward and a payment put into the vault. The fee of a loan for one transaction: the one-transaction loan design, as VLT-043. | b53ee1bcc7fed01d |
| VLT-112 | K | OP "3.7.2", item 1, "It falls by a withdrawal or a new commitment", and item 4 for a repayment and a purchase paid from free balance, item 5 for an amount held in the paying vault. PR "Depository Vault", for a fee A payment under a standing commitment: the due-date plan design, "the payment reserve first, then other free vault balance". | 5be285355a0be2e8 |
| VLT-113 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 09:56 UTC. Changed with section 4: the watch reads a multi-unit NFT's holding as VLT-354 states. Confirmed by the owner with section 4 on 2026-11-23, 01:42 UTC. | dd05c63d2f5139cb |
| VLT-114 | K | PR "Tracked-Holding Display and Utility Rule" | 3037e12193dac678 |
| VLT-115 | K | OP "3.7.2", item 1, for the releases and the adoption. PR "Depository Vault", for a cancelled payout. The return from the Ready balance: PR "Protected Account Mode" | 1308045399dfb3ff |
| VLT-116 | K | OI "Which vault makes the pull for a payer that is no party to the loan": a contract caller "may send the tokens to its vault's address in the same transaction and pay from free balance under its own call". | 75f65344f8772bf1 |
| VLT-120 | K | OP "3.7.2", item 3, first paragraph, and "The lien therefore records". | 66687c62da4d7bcc |
| VLT-121 | K | OP "3.7.2", item 3, last paragraph: "A lien never opens on the Diamond's word alone". An open offer is named as a commitment drawn on, for a match with no owner present. A top-up from a loan reserve: OP "3.7.2", item 2 "Authorized earlier by the one then entitled". | a9e880d3ae97a4c2 |
| VLT-122 | K | OP "3.7.3", "Each side's token" | fc1dffe3971f79c0 |
| VLT-123 | K | OP "3.7.3", "The paying side". The last sentence: OP "3.7.2", item 5, "An opening or a purchase that cannot be delivered reverts", with VLT-034. | 54c079146b594e20 |
| VLT-124 | K | OP "3.7.7". OP "3.7.3", "The paying side", last sentence. | 8e84b312af55bff7 |
| VLT-125 | K | OP "3.7.3", "The locking side" The release of an unbound lien cites VLT-131. | 7fbdf09a0ba23bab |
| VLT-126 | K | OP "3.7.3", last paragraph. | 946009d52d654a62 |
| VLT-127 | K | OP "3.7.2", item 3, last paragraph. Item 4: "So the principal a lien records as owed" | ee61a21f93b6ec0e |
| VLT-128 | K | OP "3.7.4", the row "A lien released into free balance", for a collateral lien. | 79c79dd6ca9637c1 |
| VLT-129 | K | OP "3.7.2", "A borrowing holds no lien" (ruled 2026-11-20) | 7c1a5ccc97cebe75 |
| VLT-130 | K | Same paragraph, its reason. Owner decisions 2026-11-19 and 2026-11-20 against a shared collateral holding. PLT-011. | 09677a800616ef9c |
| VLT-131 | K | OP "3.7.5", first paragraph. | 7b90ecf200a7ae14 |
| VLT-132 | K | OP "3.7.5", first item: "A lien's other side is replaced only by a record the leaving side made". | f07254535ee942f8 |
| VLT-133 | K | OP "3.7.5", second item. | aec6917c9303df79 |
| VLT-134 | K | OP "3.7.5", third item. | 8857bb088a7e6412 |
| VLT-135 | K | OP "3.7.5", fourth item. | 81330d2c9fc1fec6 |
| VLT-136 | K | OP "3.7.5", fifth item. | af602e8e954f18c2 |
| VLT-137 | K | OP "3.7.3", "A loan that pays off another". OP "3.7.2", item 4, the payment with two purposes. OP "3.7.7" | f688238fee0206e6 |
| VLT-138 | K | Same three places. | ecb9d022946ab557 |
| VLT-139 | K | OP "3.7.3", "An NFT rental". OI "The NFT rental", for the daily rent. | a653b9bc317fa40f |
| VLT-140 | C | OP "3.7.2", item 2, last sentence, and OP "3.7.4", the row on a mandate or a reserve: "the owner's own call". A loan reserve: PR "Standing Instructions", "The reserve belongs to whoever deposited it .. whether or not they still hold the position .. an extension draws only the current holder's reserve". Drawn only while its owner holds the token: the same line, the due-date plan design ("live for the current holder") and the exit instruction's skip "the holder is no longer the wallet that set it". Changed: the statement lists the commitments it covers. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:56 UTC. Changed again with section 5, and after its approval: after a replacement the holding of the wallet whose own vault it is counts as the owner's. The owner confirmed the clause with section 5 on 2026-11-23, 01:42 UTC; its present words, raised by the review of this folder, are entered for his confirmation with this folder. | 245c384b4ac775d8 |
| VLT-141 | K | OP "3.7.2", item 2 (the lending mandate, a loan's two reserves) and "A borrowing holds no lien". | b40abafdeab3eb70 |
| VLT-142 | K | OP "3.7.4", the rows "A lien released into free balance", "A payment to the other side" and "What is left of a lien". OP "3.7.6". OI "The backstop's buyout". | 04ab51fecb99b961 |
| VLT-143 | K | OI "The held-amount families" (the custody after a failed sale stays under the collateral lien) and "The backstop's buyout" (the split, the slice, valued once when the split is recorded). Changed: the record keeps the price read and the amount owed that the slice was valued against. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:56 UTC. | 97a0d326e26f39af |
| VLT-144 | K | OI "The backstop's buyout", all of it. | a9d74d00dc452037 |
| VLT-145 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. Changed with section 4: it cites VLT-333 for the Ready balance. Confirmed by the owner with section 4 on 2026-11-23, 01:42 UTC. | eb59bee3ac1cbcb3 |
| VLT-146 | K | OI "The ceiling and the date", last sentence. `docs/DesignsAndPlans/LendingBalanceDesign.md` "6.2": who gives notice, the date as the earlier of the notice date and the term's end, what clears a notice, and that it is not withdrawn. | 5ed0056ef53f9e92 |
| VLT-147 | K | PR "Liquidation fallback": the collateral leaves the vault "only to settle the fallback (the lender claim, a retry, an internal match or the keeper backstop)", "or returns to the ordinary collateral lock if the borrower cures first"; "if the borrower adds collateral .. and the loan again satisfies the required LTV and Health Factor thresholds, the loan may continue as an active loan". Changed: a scaled slice is bounded by a ceiling the vault works out itself, the repayment of a split lien moved to VLT-155, and the cure to VLT-149. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:56 UTC. | d42a1ca3a096677b |
| VLT-148 | K | OI "The NFT rental", for the close. | 788dcaea90d33ad6 |
| VLT-149 | N | New id. The cure of a split lien, and collateral added short of a cure, moved here from VLT-147 with no change of rule. PR "Liquidation fallback": "if the borrower adds collateral .. and the loan again satisfies the required LTV and Health Factor thresholds, the loan may continue as an active loan". The owner approved these sentences in VLT-147 on 2026-11-22, 09:56 UTC. As a statement of its own it is entered for his confirmation with this folder. | f6c68ddd2eb91a74 |
| VLT-155 | N | New. The refusal of a part repayment while a lien is split, raised by the review of this folder and by the conflict read of VLT-147; mistake VLT-M51. PR "Liquidation fallback": the borrower "may still either add collateral or fully repay the loan". Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:56 UTC. | 0631018db835009f |
| VLT-150 | K | OP "3.7.2", item 4, first paragraph. The backstop's vault as a payer: OI "The backstop's buyout" "The backstop's fixed address": as a lender the backstop acts through an ordinary vault it owns (VLT-210, the re-read's E1). | 60aa67d617db94ce |
| VLT-151 | K | OP "3.7.2", item 4, "The purpose is set by the paying vault". | 20ddbb8a46e333f5 |
| VLT-152 | K | OP "3.7.2", item 5, last sentence. | f647cca085b0b246 |
| VLT-153 | K | OP "3.7.2", item 4, first paragraph, from "What arrives is held for the position" | 96a6ebc0bd1f8e83 |
| VLT-154 | K | PD "4.1" and "4.2": what is released to a position's holder goes to the holder's vault. OP "3.7.2", item 4, names purposes only for a payment for a position, so a release carries none. | 04284a17f34193db |
| VLT-160 | N | New. Raised by mistake VLT-M13. Approved by the owner on 2026-11-22, 09:56 UTC. | c5c35b915fb95041 |
| VLT-161 | K | VO "Deposits", third item: a vault may deliver an NFT to another vault and "this does not open receipt to arbitrary senders". OP "3.7.1", "An NFT is sent, never pulled", for the owner's own send. OI "The receive hooks", for the listing-locker and the rental return. Mistake VLT-M12. Changed with section 4: from the vault's own listing-locker, only the return of a listed lot up to the lot left is tracked. Confirmed by the owner with section 4 on 2026-11-23, 01:42 UTC. | e5af8e8a3c997c8b |
| VLT-162 | K | PR "Tracked Vault Holdings" and "Adopting and Disowning Untracked Assets". Changed with section 4: anything else from the vault's own listing-locker arrives untracked. Confirmed by the owner with section 4 on 2026-11-23, 01:42 UTC. | 6cc10b5335991b8d |
| VLT-163 | N | New. Raised by mistake VLT-M11. Approved by the owner on 2026-11-22, 09:56 UTC. | 8a5a95d081ce919e |
| VLT-170 | K | PR "Adopting and Disowning Untracked Assets". VO "Adopting or disowning an untracked asset", first two items. | f381a4c83a522c7b |
| VLT-171 | K | PR same paragraph: "An adoption can never exceed the untracked part". VO same section, third item, for the wrong standard. Mistake VLT-M38. | b240db6ab235efe3 |
| VLT-172 | K | PR "Sanctions-Aware Adoption": "an unset, unavailable or failing list refuses the adoption". Mistake VLT-M40. | f24985ecfc876ea9 |
| VLT-173 | K | PR "Sanctions-Aware Adoption", from "A flagged source credits nothing". Mistake VLT-M39. | 73f0249d2f913464 |
| VLT-174 | N | New. Raised by mistake VLT-M41. Approved by the owner on 2026-11-22, 09:56 UTC. | a17cadc364f885b9 |
| VLT-175 | C | Old: VO "Adopting or disowning", second item: "A replaced account cannot currently adopt", which the same line calls a gap. Changed to: the owner wallet in force may adopt. Changed with the owner's approval of 2026-11-22, 09:56 UTC. | bde7bd180de491af |
| VLT-176 | K | PR "Adopting and Disowning", last sentence. VO same section, last item. | a85f29596bb1196f |
| VLT-180 | K | VO "Vault-owned authority and signed changes", first and second items. OP "3.7.9" | fe1a325a5d51814c |
| VLT-181 | K | OP "3.7.1", first paragraph and the table. VO same section, first item. | e7e444fd970236fd |
| VLT-182 | K | OP "3.7.1", "An NFT is sent, never pulled" | c5356fe667e21eec |
| VLT-183 | K | VO same section, first item: "can be voided". PR "Protected Account Mode", first paragraph. Mistake VLT-M32. | d86a826ec77e7df3 |
| VLT-184 | K | VO same section, third item. | e94761af6404079c |
| VLT-185 | C | OP "3.7.5", first paragraph: a lien's "actions need the new holder's authorization". Its first item: a record "accepted only from the replaced token's holder or that holder's genuine vault". PD "4.7". The three forms are written here: the sources give the rule and not the form. Changed with the owner's approval of 2026-11-22, 09:56 UTC. Changed with section 5: once the holder's wallet was replaced, the key is the owner the holder's own vault records. Confirmed by the owner with section 5 on 2026-11-23, 01:42 UTC. | 36d953e6b20ac6cb |
| VLT-200 | N | New. Raised by mistake VLT-M03; the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. Changed with section 5: a wallet's own vault is the one its address gives, and one owned by a replacement is a second one. Confirmed by the owner with section 5 on 2026-11-23, 01:42 UTC. Changed again after that approval: wherever a statement speaks of a wallet's, a holder's or a caller's vault, it means its own vault. Raised by the review of this folder. Entered for the owner's confirmation with this folder. | cebf04bb4ed190f3 |
| VLT-201 | K | OI "Which vault makes the pull": "A vault's address is known before the vault exists". VO "Vault-owned authority and signed changes": the address follows from the first owner. OP "3.7.9": a replacement owner wallet controls the same vault. | 57be11f861062259 |
| VLT-202 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. | f656cb7d6925f18a |
| VLT-210 | K | OP "3.4". The sentence on the backstop's vault: OI "The backstop's buyout", "at its address fixed in the vault code" The address half: OP's build notes for #3393 and VO, "Its address is derived from its original owner, so a forged owner record in an unrelated look-alike vault cannot qualify that vault as a protocol payee". | 191a414cff943376 |
| VLT-211 | K | OP "3.4", last two sentences. OP "7", the stated residual. | 18fad7de7a67904b |
| VLT-212 | K | OI "The backstop's buyout", "at its address fixed in the vault code". PR "Backstop": it "holds it in its own isolated vault", lends from its first slot, and its claim "pays its vault". The treasury's vault: the owner's answer of 2026-11-22 09:16 UTC, a treasury vault with its own code. Its own rules are owed to the fee domain. | c848a31baa7a997f |
| VLT-220 | C | VO, third item VO: "no part of the Diamond can change". What the platform can do at the registry: the version registry's design (#3204), its request, capped raise and void entries. Changed by the owner's answer of 2026-11-22 11:03 UTC on the unit of account design: the fourth thing the platform can do at the registry, and the one thing the registry reads of the platform's. | 37d65bd59ed8bb33 |
| VLT-221 | K | VO, third item: "no vault is ever left on old code because nobody upgraded it" | a714ec684e30aa76 |
| VLT-222 | C | VO, fourth item One change at a time, anyone applying a change that has waited, and governance's own cancel: the version registry's design (#3204). Changed by the owner's answer of 2026-11-22 11:03 UTC on the unit of account design: the change that retires a price guard is applied by the replacement step alone. | 54050b32ee296c6b |
| VLT-223 | K | VO, fourth item and last item. | c4b972924414bfbd |
| VLT-224 | C | VO, fourth item, last sentence The successor the pauser names, and either kind of pause: the version registry's design (#3204), "3.3". "At least the wait earlier": PR "Moving the treasury is a vault code change" (#3436). Changed by the owner's answer of 2026-11-22 11:03 UTC on the unit of account design: the successor names the platform's price guard and no other. | b1655f553f8b07e4 |
| VLT-225 | K | VO, fourth item, read with the last: both routes move vaults only onto code that was registered for the full wait. | 5eb0dd2f76a098de |
| VLT-226 | C | VO, fifth item ("A revoked version is never restored") and seventh ("Every code version preserves the append-only vault layout"). That a version must report itself as vault code: the version registry's design (#3204). Changed: the most live versions [PRM-008], so the change that retires a price guard walks a bounded number. Follows from VLT-229. Changed with the owner's approval of 2026-11-22, 09:56 UTC. | 526c6958dd769d33 |
| VLT-227 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. | 226f55b5d5e3fde8 |
| VLT-228 | N | New. Raised by threat VLT-T30; the conflict read; the owner's answer of 2026-11-22, 11:03 UTC, on the design `docs/DesignsAndPlans/UnitOfAccountChangeDesign.md`. Approved by the owner on 2026-11-22, 11:03 UTC. | 60c45c8a9d768131 |
| VLT-229 | N | New. Raised by the conflict read; the owner's answer of 2026-11-22, 11:03 UTC, on the design `docs/DesignsAndPlans/UnitOfAccountChangeDesign.md`. Approved by the owner on 2026-11-22, 11:03 UTC. | b8340e59c4962b8b |
| VLT-230 | K | VO, fifth item. Mistake VLT-M37. | 0f8e2b63b558db2f |
| VLT-231 | C | Mistake VLT-M37, "A version that is not live is refused". Changed: a version registered less than the vault code wait ago is refused too. PR lets a pin name "any registered, non-revoked version". Changed with the owner's approval of 2026-11-22, 09:56 UTC. | 726f855db62b65ad |
| VLT-232 | K | VO, sixth item No delay applies at once and anyone applies after a delay: the registry's design (#3204). A pin change as a safety setting that stays open in a pause: P1, point 5, approved 2026-11-22. | 06010c2401f40ed0 |
| VLT-233 | K | VO, sixth item: "a pending pin change can be cancelled, and none is accepted while the account is locked". The registry's design (#3204): one pending pin change per vault, a signer's cancel, "Entering or leaving protected state voids everything pending" (owner decision 2026-11-07), and a pending pin whose target is revoked lapses. | e971440ea8cde7db |
| VLT-234 | N | New. Raised by the conflict read; the owner's answer of 2026-11-22, 11:03 UTC, on the design `docs/DesignsAndPlans/UnitOfAccountChangeDesign.md`. Approved by the owner on 2026-11-22, 11:03 UTC. | 48391178cc581617 |
| VLT-240 | K | OP "3.6", its superseding note, and B1: the endpoints a vault may pay or approve are constants in its own code. | 4976833482ce13c9 |
| VLT-241 | C | B1, the earlier conduits a version may list. Changed by the owner's answer of 2026-11-22 11:03 UTC on the unit of account design: a version lists no earlier price guard and names one. B1 let a version list earlier price guards too. | 3e2e9226b19f1032 |
| VLT-242 | K | PR "Treasury": the vault code is the only place the treasury is named (#3569) | 889cf4c33553c03e |
| VLT-243 | K | Same paragraph: a fee is never sent to an empty address. | f0ea4b03fb4d3c44 |
| VLT-244 | K | VO, fourth item, read with VLT-224: a registered version can take effect at once in a pause. The launch check is owed to the deploy domain "Registered at least the wait earlier, and not revoked". | 2d2aa84f5a793008 |
| VLT-245 | N | New. Raised by the owner's answer of 2026-11-22, 11:03 UTC, on the design `docs/DesignsAndPlans/UnitOfAccountChangeDesign.md`. Approved by the owner on 2026-11-22, 11:03 UTC. | b9ee2175e0dec5da |
| VLT-246 | N | New. Raised by threat PRC-T20. Approved by the owner on 2026-11-22, 14:31 UTC. | b9e1d78aa7928e20 |
| VLT-300 | K | VO "Deposits, ownership, and free funds", first item. How each kind of asset arrives: VLT-081, VLT-116 and VLT-161, approved. The first deposit creating the vault: VLT-200. | bfa890c7e8badfbf |
| VLT-301 | N | New. Raised by mistake VLT-M04. Approved by the owner on 2026-11-23, 01:42 UTC. | d6b77967f635c02a |
| VLT-302 | N | New. Raised by mistake VLT-M05. Approved by the owner on 2026-11-23, 01:42 UTC. Changed after the approval: the refusal is of a deposit the vault takes, and a contract owner's send inside its own step is booked as a deposit under VLT-116 and needs no permit. Raised by the review of this folder. Entered for the owner's confirmation with this folder. | 47b9b4148ebce0a7 |
| VLT-303 | N | New. Raised by mistake VLT-M06. Approved by the owner on 2026-11-23, 01:42 UTC. | 8d2903874fcc6f83 |
| VLT-304 | N | New. Raised by mistake VLT-M07. Approved by the owner on 2026-11-23, 01:42 UTC. | 39ab0113d7f948b0 |
| VLT-305 | N | New. Raised by mistake VLT-M09. Approved by the owner on 2026-11-23, 01:42 UTC. | c8ccff09c4a0fe2a |
| VLT-306 | K | PLT-040, PLT-050, PLT-060, PLT-065 and PLT-071, applied to a deposit. PR "Sanctions Oracle Availability". PR "Terms Acceptance Enforced by the Contracts": "A vault deposit, a vault opening and an account-safety setting are not checked either". VO "Optional account protection" says a deposit remains subject to the Terms, which is out of date against PR and PLT-071. | 7ed096c8fd8a38f3 |
| VLT-320 | C | Kept: VO "Ready balance (protected accounts)", first, second and sixth items. RB "3", rule 9 (no automatic refill). Changed: RB "3", rule 1, makes the Ready balance a mark on the free balance, read each time. The approved statements VLT-014, VLT-112 and VLT-115 hold it apart from the free balance, and this section follows them. A free balance that fell below the mark and rises again does not bring the Ready balance back. Changed with the owner's approval of 2026-11-23, 01:42 UTC. | 5dd290a1a69ec04e |
| VLT-321 | K | VO "Ready balance", first item. RB "2", the table of spends. | 4b6cf2b332ae0ad4 |
| VLT-333 | K | RB "2", the table of spends, for the three steps and for why a renewal's charge beyond the reserve is held to the Ready balance. Where a draw goes: VLT-121 and VLT-151, approved. | 46a9deb5052e076c |
| VLT-322 | K | RB "3", rule 6. | 32f4f397c2e8deff |
| VLT-323 | C | Kept: RB "2", "Not covered, with the reason", which names the fee paid from the vault in the platform's token. Changed: under RB "3", rule 1, what a fee took from the Ready balance comes back when the free balance rises. Held apart, it does not. Changed with the owner's approval of 2026-11-23, 01:42 UTC. | c75e1902d7c9834c |
| VLT-324 | K | VO "Ready balance", second item. RB "3", rule 4. | b1b1c86736cd1391 |
| VLT-325 | C | Kept: VO "Ready balance", second item. RB "3", rule 2. Mistake VLT-M22. Changed: under RB "3", rule 1, a move that came to count for more than was free keeps counting up as the free balance rises. Held apart, it is fixed at the moment it comes to count. Changed with the owner's approval of 2026-11-23, 01:42 UTC. | 3cd5e8cc53f20a55 |
| VLT-326 | K | VO "Ready balance", second item. RB "3", rules 2 and 3. Open in a pause: follows from VLT-014 and VLT-091 (the escape withdrawal reaches only the protected balance), as VLT-183 keeps a void open. | d80ecc11b9f8d0fa |
| VLT-327 | K | VO "Ready balance", third item. RB "3", rule 5. | 8704aaf9b5414d33 |
| VLT-328 | K | VO "Ready balance", fourth item. RB "3", rule 7. VLT-184 for the one transaction. | 27e190581d0bbfcc |
| VLT-329 | K | VO "Ready balance", fifth item. RB "3", rule 8. | e320472424be4bf4 |
| VLT-330 | K | VO "Ready balance", fifth item. RB "3", rule 8. | a7d76f6775d77ea8 |
| VLT-331 | K | RB "3", rule 8, for the bounds. Mistake VLT-M23. | b51da12c39166611 |
| VLT-332 | K | VO "Ready balance", seventh item. RB "5" | 174183f08c4a6642 |
| VLT-350 | K | OP "3.5", item 3: a listing of a multi-unit NFT first moves exactly the listed id and amount out of the vault, against its lien, into a minimal contract for that one listing, created by the vault with a known code hash. The design names that contract with another word. | c85efde29029f7f0 |
| VLT-351 | K | OP "3.5", item 3: the contract holds nothing else, and it is the listing's offerer. OP, the build notes on spender rights and on order signatures, for the conduit and for whom the contract answers. VLT-066, VLT-067. | bc7c8acb0c64ac2c |
| VLT-352 | K | OP "3.5", item 3: "On cancel or expiry it returns what is left to the vault, which re-opens the lien for it". The lien is stated as never leaving the lot (VLT-350), which is the same outcome in the approved words of VLT-061. Refused by no condition: follows from PLT-041, since a full repayment in a pause ends the lien. | 698fb14812698654 |
| VLT-353 | N | New. Raised by mistakes VLT-M48, VLT-M50. Approved by the owner on 2026-11-23, 01:42 UTC. | a7480576a7c419b5 |
| VLT-354 | K | The reading of what a vault holds of a multi-unit NFT is written once here, for VLT-011, VLT-038, VLT-113 to VLT-115 and VLT-162. OP, the build notes, "The free-balance check reads the tracked holding for NFTs": a lot in the vault's own listing-locker is still the vault's and still under its lien. VLT-014 and VLT-013 for the withdrawal. Mistake VLT-M47. | 46ac393f8ccdeaa1 |
| VLT-355 | N | New. Raised by mistake VLT-M49. The listing-locker obeying only its vault: OP "3.5", item 3. Naming the true source: VLT-170 and VLT-173. Approved by the owner on 2026-11-23, 01:42 UTC. | f2d2e0598142f49a |
| VLT-400 | K | VO "Optional account protection", first item. VO "Recovery address and clawback", first item, and RA "3.5": switching on needs a recovery address set, in force or waiting. The pin delay: VLT-232. Mistake VLT-M33. | 17e92dec0d0ff9e2 |
| VLT-401 | K | VO "Optional account protection", first item, for the bounds. RA "3.5". Mistake VLT-M25. | 82b1197dec4cf845 |
| VLT-402 | C | VO "Delayed changes and account replacement", first item. Mistake VLT-M26. Changed: a change that already waits takes the longer of its own wait and a delay raised since, which no document states. Raised by the security review. Approved by the owner on 2026-11-23, 01:42 UTC. | 96209409eee84539 |
| VLT-403 | K | VO "Delayed changes and account replacement", first item. RA "3.4": switching off removes the signers and keeps the address. VO "Recovery address and clawback": never on a recovered account. | 92d5e95fe14e1489 |
| VLT-410 | K | VO "Delayed changes and account replacement", first item. The list is gathered from VO "Optional account protection", VO "Ready balance" and the position move's item. | d1f8d8df3823620f |
| VLT-411 | C | VO "Delayed changes and account replacement", first item: "may be cancelled meanwhile", "A matured addition expires if not applied within one further delay". VO states the lapse for an addition and for the position move. Here it holds for every loosening change, measured by the delay in force when the wait ended. Changed with the owner's approval of 2026-11-23, 01:42 UTC. | 9723687f60bcd6fc |
| VLT-412 | K | VO "Delayed changes and account replacement", first item. VLT-184, approved. | de284afe31f5fb11 |
| VLT-413 | N | New. Raised by mistake VLT-M28, the conflict read and the security review. An unlock stays open in a pause so that VLT-091 keeps its promise to a locked account. A void in a pause: VLT-183. The Ready balance in a pause: VLT-326. Approved by the owner on 2026-11-23, 01:42 UTC. | da004225c033e313 |
| VLT-414 | N | New. Raised by threat VLT-T39 and the security review. VO "Vault-owned authority and signed changes": "Each lock cancels the work pending at that lock. A later unlock cannot revive it". VLT-184. Approved by the owner on 2026-11-23, 01:42 UTC. | 94e4db0aa7e77d9f |
| VLT-420 | K | VO "Optional account protection", second item. VO "Vault-owned authority and signed changes" for the relayed signature. RA "2", the decision of 2026-11-18, for an approval that can only lock. | 703c475a0b8d4ceb |
| VLT-421 | K | VO "Optional account protection": "A lock cancels queued payouts, applies the position-NFT holder lock, and blocks new payouts and positions". VLT-184 and VLT-328, approved. Mistake VLT-M30. | c226bd24abe3f0ff |
| VLT-422 | K | VO "Optional account protection", the lock's item. The four steps not refused, and the refusal of a part release of collateral and of a deposit into the Ready balance, are stated nowhere: the conflict read and the security review. | 19571c43cb191dee |
| VLT-423 | K | VO "Optional account protection": "It does not block loan servicing. A settlement to a locked owner stays in the vault instead of preventing settlement". LK for the setting that keeps running. | 2b6c3087fc5e9898 |
| VLT-424 | K | VO "Optional account protection": "The owner may ask to unlock, which waits the delay". RA "2", the decision of 2026-11-18: a lock stays firm, no lock lapses by time, and the clawback is the exit. Mistake VLT-M30. | d56364480db094e1 |
| VLT-425 | K | LK, whole. | 7e4f3078d484b79d |
| VLT-430 | K | VO "Optional account protection", second item. RA "3.5". Mistake VLT-M29. | 44911da89b311169 |
| VLT-431 | K | VO "Optional account protection", second item. VO "Delayed changes and account replacement", second item, for the majority. VLT-326. | 1caaee97cbf052c6 |
| VLT-440 | K | VO "Optional account protection", second item. VO "Vault-owned authority and signed changes": "The vault enforces its destinations and lock independently". VLT-050, VLT-180. Mistake VLT-M27. | f120e009d0612693 |
| VLT-441 | K | VO "Optional account protection", third item. | a72f2bab84d96caf |
| VLT-442 | K | VO "Optional account protection", fourth item. | 8d91d3e2b7ecd1fc |
| VLT-450 | C | VO "Delayed changes and account replacement", second item, and its item on an owner-proposed replacement. Mistake VLT-M31. Changed: that the new wallet completes it with its own key, and that it lapses, is stated nowhere. Raised by the conflict read. Approved by the owner on 2026-11-23, 01:42 UTC. | eddf2c5921292d31 |
| VLT-451 | K | VO "Delayed changes and account replacement": "An owner-proposed replacement is cancelled by a lock. While a signer holds a lock, only a signer can cancel the replacement". Mistake VLT-M31. | f05d99f0c90ad07f |
| VLT-452 | K | VO "Delayed changes and account replacement", second and third items. VLT-180, VLT-181. | 7f8ffbf81bdf3319 |
| VLT-453 | N | New. VO names the cool-down ("once the replacement and its cool-down are complete") and states neither its length nor what it refuses. Approved by the owner on 2026-11-23, 01:42 UTC. | 8b13e19e164ea273 |
| VLT-454 | K | VO "Delayed changes and account replacement": "The old wallet holds positions it can no longer use". Mistake VLT-M43. Changed after the approval: the account's position tokens are those held by the wallet whose own vault the account is, so a later replacement never holds fast another wallet's tokens. Raised by the review of this folder. Entered for the owner's confirmation with this folder. | 3b5ca81d38615d6e |
| VLT-455 | K | VO "Delayed changes and account replacement": "Who may act on a position is its holder's manager", and "managing one's own recovered position earns no keeper reward". It adds a case to VLT-185. | 0cd30abdb5f837d2 |
| VLT-456 | K | VO "Delayed changes and account replacement": "A replaced account's open offers can only be cancelled". VO "Optional account protection": "A locked or replaced account cannot post it". That a replaced account opens no position is gathered from both. That it takes no deposit is stated nowhere. | f42f270584342721 |
| VLT-457 | K | VO "Delayed changes and account replacement", the position move, the owner's decision of 2026-11-18. Mistake VLT-M44. | ef4fbf7ff24054d0 |
| VLT-458 | K | VO "Delayed changes and account replacement", the position move. VO "Recovery address and clawback" for a recovered account. Mistakes VLT-M45 and VLT-M46. | 2e9e1150295124dd |
| VLT-459 | K | VO "Delayed changes and account replacement", the position move, its last sentence. | f0fb4465c3c8c670 |
| VLT-460 | C | PT "1" stated a rule that refused an owner's step above a value until the account had decided on protection. The owner took that rule out of the platform on 2026-11-08: the asking and its record are the app's. The statement keeps what is left for the vault. | e8cb64271842b149 |
| VLT-470 | K | VO "Optional account protection": "NFT protection is the position-NFT contract's holder lock", "there is no queue of NFT transfers", "The owner may ask to unlock, which waits the delay, without disabling the account's other protection". The owner's choice of 2026-11-19: the lock is a choice of its own, offered already chosen when protection is switched on. | 1e8e41c9e7ebfc94 |

206 statements. Kept: 159. Changed: 18. New: 29.

## Approvals

- Section 1 was approved by the owner on 2026-11-22 at 09:17 UTC.
- Sections 2 and 3 were approved by the owner on 2026-11-22 at 09:56 UTC.
- The statements of section 3 that follow from the change of the unit of account were written
  from the owner's answer of 2026-11-22 at 11:03 UTC, which approved that design.
- VLT-246 was approved by the owner on 2026-11-22 at 14:31 UTC, and reworded with his approval
  of 15:05 UTC.
- Sections 4 and 5 were approved by the owner on 2026-11-23 at 01:42 UTC, with his answers to
  the points put to him on each.

## Changed after an approval

These changes were made after the approval above, and are entered with this folder for the
owner's confirmation. Each was read for conflict before it was entered.

- The six lifecycle tables of sections 1 to 3 are written as models in the form the folder
  check reads. No statement changed by that.
- VLT-012 also names mistake VLT-M42 among those it answers. The rule is unchanged.
- VLT-222 says that a proposal to revoke the current version names its successor.
- VLT-224 says that a waiting change which names the revoked version ends with the revoke, and
  so does one waiting to make current the version the pauser names as successor. The model of
  a version has the row.
- VLT-229 says that the change which retires a price guard, ended by the pauser's revoke, ends
  as a cancelled one does.
- VLT-233 says what a waiting change of a pin, and a waiting removal, do when the pinned
  version is revoked.
- The tests owed of VLT-222, VLT-224 and VLT-229 name the new sentences.
- VLT-227 says "no later than the rule changes", where it said "before the rule changes".
- VLT-226 bounds the versions registered and not revoked at once, by a proposed figure
  (PRM-008).
- VLT-220, VLT-222, VLT-224 and VLT-241 were changed, and VLT-228, VLT-229, VLT-234 and VLT-245
  written, from the owner's answer on the unit of account.
- VLT-002 and VLT-220 cite by id rules they cited in the owed form.
- VLT-147 bounds a scaled slice. After a part is taken from a split lien, the slice is never
  above a ceiling the vault works out itself: the amount owed it was valued against, less what
  the lender's side has since received from the lien, at the split's own price. The slice and
  the treasury's share together stay within the most the loan can still owe, and the treasury's
  share gives way first. The security review asked for it.
- VLT-143 says that the record of a split keeps the price read and the amount owed that the
  slice was valued against. The bound of VLT-147 reads them.
- VLT-155 is new. While a lien is split, a repayment is of all the loan owes, and a payment
  that leaves principal owed is refused. VLT-147 said "still takes a repayment". The source
  says the borrower may fully repay or add collateral. It answers mistake VLT-M51.
- VLT-149 is a new id. It holds the cure of a split lien and collateral added short of a cure,
  moved from VLT-147 with no change of rule, to keep VLT-147 within a statement's length.
- The record's owed table lists three owed lines of the model of a vault.
- VLT-140 lists the commitments it covers. VLT-115 and the model of a lien cite the statements
  that state a release of a lien (VLT-035, VLT-131).
- VLT-302 says that its refusal is of a deposit the vault takes. A token a contract owner sends
  inside its own step is booked as a deposit under VLT-116 and needs no permit, and a token
  sent outside such a step is untracked (VLT-162). Its test names that case. Raised by the
  review of this folder, after the owner's approval of section 4.
- VLT-454 names the account's position tokens: those held by the wallet whose own vault the
  account is. A later replacement never holds fast the tokens of a wallet that once managed
  the account. VLT-140 reads the same holding, and its test names a token moved to a replaced
  wallet before a second replacement. VLT-033 releases a payment to the holder's own vault,
  whose owner record names that holder or, once that holder has been replaced there as owner,
  the owner wallet on record, and never to a wallet. VLT-037 makes a held amount free balance
  in the same vault only if that vault is the holder's own. VLT-200 says that a wallet's, a
  holder's or a caller's vault, wherever a statement speaks of one, is its own vault. Raised by
  the review of this folder, after the owner's approval of section 5.
- The contract a vault creates for one listing of a multi-unit NFT is called a listing-locker,
  in sections 2 and 4, the mistake list and the outline: one hyphenated word, never two words
  and never the second alone. No rule changes. The owner chose the word after approving
  section 4.
- Two statements of the approved sections, and part of a third, are held outside this folder,
  under ids in the held range, at the security review's request. Citations of them are removed
  from this folder.
- Entered with sections 4 and 5, and confirmed by the owner with them: VLT-161 accepts as
  tracked, from the vault's own listing-locker, only the return of a listed lot up to the
  lot left, and VLT-162 treats anything else from that listing-locker as arriving untracked. The
  watches of VLT-014 and VLT-113 read a multi-unit NFT's holding as VLT-354 states. VLT-145
  cites VLT-333.
- Entered with section 5 in the same way: a wallet's own vault is the one its address gives,
  and a vault it owns by a replacement is a second one, which it manages (VLT-100, VLT-200).
  After a replacement the authority over a position and its lien is the owner the holder's own
  vault records (VLT-101, VLT-185), and a reserve keeps paying the account's own loan (VLT-140).
- The model of a vault cites VLT-420, VLT-411 and VLT-424 for the lock and the unlock, and
  names a keeper the owner approved for locking only. The parameters table names the statements
  that use the account's delay.

## Mistakes answered

| Mistake | Answer | Statement |
| --- | --- | --- |
| VLT-M01 | Warn only | VLT-102 |
| VLT-M02 | Undo | VLT-162 |
| VLT-M03 | Bound | VLT-200 |
| VLT-M04 | Undo | VLT-301 |
| VLT-M05 | Refuse | VLT-302 |
| VLT-M06 | Refuse | VLT-303 |
| VLT-M07 | Refuse | VLT-304 |
| VLT-M08 | Refuse | VLT-071 |
| VLT-M09 | Warn only | VLT-305 |
| VLT-M10 | Undo | VLT-162 |
| VLT-M11 | Warn only | VLT-163 |
| VLT-M12 | Refuse | VLT-161 |
| VLT-M13 | Refuse | VLT-160 |
| VLT-M15 | Refuse | VLT-012 |
| VLT-M16 | Refuse | VLT-031 |
| VLT-M17 | Refuse | VLT-032 |
| VLT-M18 | Refuse | VLT-012 |
| VLT-M19 | Refuse | VLT-090 |
| VLT-M20 | Warn only | VLT-091 |
| VLT-M21 | Refuse | VLT-012 |
| VLT-M22 | Warn only | VLT-325 |
| VLT-M23 | Refuse | VLT-331 |
| VLT-M24 | Refuse | VLT-320 |
| VLT-M25 | Refuse | VLT-401 |
| VLT-M26 | Bound | VLT-402 |
| VLT-M27 | Undo | VLT-440 |
| VLT-M29 | Refuse | VLT-430 |
| VLT-M30 | Undo | VLT-421 |
| VLT-M31 | Undo | VLT-450 |
| VLT-M32 | Undo | VLT-183 |
| VLT-M33 | Bound | VLT-400 |
| VLT-M37 | Undo | VLT-230 |
| VLT-M38 | Refuse | VLT-171 |
| VLT-M39 | Warn only | VLT-173 |
| VLT-M40 | Refuse | VLT-172 |
| VLT-M41 | Undo | VLT-174 |
| VLT-M42 | Refuse | VLT-012 |
| VLT-M43 | Warn only | VLT-454 |
| VLT-M44 | Undo | VLT-457 |
| VLT-M45 | Refuse | VLT-458 |
| VLT-M46 | Refuse | VLT-458 |
| VLT-M47 | Refuse | VLT-354 |
| VLT-M48 | Refuse | VLT-353 |
| VLT-M49 | Undo | VLT-355 |
| VLT-M50 | Refuse | VLT-353 |
| VLT-M51 | Refuse | VLT-155 |

## Retired ids

None.

## Owed

References to rules of a domain that is not entered yet. Each is replaced by a statement id
when that domain is entered.

| Owed | Cited by |
| --- | --- |
| APP owed: the move's warning | VLT-459 |
| APP owed: the protection prompt | VLT-460 |
| AUT owed: a change to the platform is tested against every registered version first. | VLT-227 |
| AUT owed: who governs the version registry | VLT-222 |
| DPL owed: a launch is refused until the endpoints fixed in the vault code and those the platform is configured with agree. | VLT-244 |
| DPL owed: the first version and its launch check | VLT-225 |
| DPL owed: the treasury's address is never the platform's own | VLT-042 |
| DPL owed: which of the two holds between each pair of networks. | VLT-102 |
| EXT owed: the ends an exit adds | VLT-142 |
| EXT owed: what a lock ends of a listing | VLT-425 |
| EXT owed: when a listing ends | VLT-352 |
| EXT owed: whether a sale clears it. | VLT-146 |
| FCL owed: rounding, lender first | VLT-147 |
| FEE owed: the fee paid from a vault in the platform's token | VLT-323 |
| FEE owed: the share's size. | VLT-143 |
| FEE owed: the treasury vault's own rules. | VLT-212 |
| KPR owed: the lock-only approval | VLT-420 |
| LON owed: a standing instruction's skip | VLT-155 |
| LON owed: what a lock ends of a plan | VLT-425 |
| LON owed: what such a fall does to a lien | VLT-113 |
| MKT owed: what a lock ends of a lending slot | VLT-425 |
| OFR owed: what a lock ends of an offer | VLT-425 |
| POS owed: the holder lock | VLT-421, VLT-470 |
| RNT owed: its size and payee | VLT-148 |
| VLT owed: a recovered account | VLT-403, VLT-458 |
| VLT owed: co-signing | VLT-431, VLT-441 |
| VLT owed: the clawback | VLT-424 |
| VLT owed: the payout of a protected account | VLT-327, VLT-400 |
| VLT owed: the payout queue | VLT-403, VLT-421 |
| VLT owed: the recovery address | VLT-400, VLT-414, VLT-430 |
| VLT owed: the refusals of a recovery | Model: a vault |
