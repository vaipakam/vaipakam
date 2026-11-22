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
PR `docs/FunctionalSpecs/ProjectDetailsREADME.md`.

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
| VLT-014 | K | VO "Deposits", second item. OP "3.3", the Owner row. | d116a34de38c0548 |
| VLT-015 | K | Owner decision 2026-11-06, OP "2", "A vault-held lien record". OP "3.3", Counterparty. | b7b14f4a32941939 |
| VLT-016 | K | OP "3.7.2", item 3, "The ceiling is computed at the moment of each step" (ruled 2026-11-20). The carried-interest bound: OP "3.7.2", item 3, its second paragraph. | dc438a4d10414cbd |
| VLT-017 | K | OP "3.7.4", the payment to the other side. The valuation made once, when the split is recorded: OP's open items answered 2026-11-20, "The backstop's buyout" | e590a4412baf7aa6 |
| VLT-018 | K | OP "3.7.4", same row, last sentence. | 1fe50cbf7c936035 |
| VLT-019 | K | OP "3.3", Incentive, Treasury, Backstop. OP "3.7.4", the budget rows. An inviter's and an integrator's amounts are written as parts of the opening fee, PLT-003. | 393d97e7f9502f2e |
| VLT-020 | K | OP "3.7.4", the non-party row. | ac23fbb851e449c3 |
| VLT-030 | K | Owner decision 2026-11-06, OP "2", "Own wallet only". PD "2", item 2. | c670965df6fb42e1 |
| VLT-031 | K | Same. Mistake VLT-M16. | 9cffcb5cd0780641 |
| VLT-032 | K | VO "Vault-owned authority and signed changes". OP "3.7.9". Mistake VLT-M17. | 3a79893b427a1c4f |
| VLT-033 | K | OP "2", "A vault-held lien record". OP "3.3", Counterparty, layer 2. OP "3.7.5", first paragraph. Restated to say where the amount rests, PD "4.2" | 083113d207f247a4 |
| VLT-034 | K | PD "4.2", second item. OP "3.7.2", item 5. | f66339ae53745aeb |
| VLT-035 | K | PD "4.2", first item. | 9624ceaf5d3ba45e |
| VLT-037 | K | OP "3.7.2", item 5. PD "2.1", "Held for a position" | 354569a4cf2ac465 |
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
| VLT-100 | K | VO "Deposits, ownership, and free funds", first two items. PLT-012. | 485872fd3b63b5db |
| VLT-101 | C | Kept: OP "3.7.1", OP "3.7.9", VO "Vault-owned authority and signed changes", first item. OP "3.7.5", first paragraph, and PD "4.7" for the holder's voice. Changed: the old line that a vault "takes instructions from one caller only" and "has no separate owner record" (VO "Deposits", fifth item) is dropped, because the later decisions gave the vault its own owner record. Changed with the owner's approval of 2026-11-22, 09:56 UTC. | dfa0c4582871a784 |
| VLT-102 | N | New. Raised by mistake VLT-M01; the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. | c99107d25b7c4953 |
| VLT-103 | K | OP "3.7.2", "One record, not two", which also names the pledged total. The market's lending figures are the instant market's ledger. | b6965fe0dbc6c969 |
| VLT-110 | K | OP "3.7.2", item 1. PR "Tracked Vault Holdings (every asset kind)" | 806601436e113d78 |
| VLT-111 | K | OP "3.7.2", item 1. PR "Depository Vault", for a reward and a payment put into the vault. The fee of a loan for one transaction: the one-transaction loan design, as VLT-043. | b53ee1bcc7fed01d |
| VLT-112 | K | OP "3.7.2", item 1, "It falls by a withdrawal or a new commitment", and item 4 for a repayment and a purchase paid from free balance, item 5 for an amount held in the paying vault. PR "Depository Vault", for a fee A payment under a standing commitment: the due-date plan design, "the payment reserve first, then other free vault balance". | 5be285355a0be2e8 |
| VLT-113 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 09:56 UTC. | a04a618377baf4a0 |
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
| VLT-140 | C | OP "3.7.2", item 2, last sentence, and OP "3.7.4", the row on a mandate or a reserve: "the owner's own call". A loan reserve: PR "Standing Instructions", "The reserve belongs to whoever deposited it .. whether or not they still hold the position .. an extension draws only the current holder's reserve". Drawn only while its owner holds the token: the same line, the due-date plan design ("live for the current holder") and the exit instruction's skip "the holder is no longer the wallet that set it". Changed: the statement lists the commitments it covers. Entered for the owner's confirmation with this folder, under his approval of the section on 2026-11-22, 09:56 UTC. | 96405e4a0da8b919 |
| VLT-141 | K | OP "3.7.2", item 2 (the lending mandate, a loan's two reserves) and "A borrowing holds no lien". | b40abafdeab3eb70 |
| VLT-142 | K | OP "3.7.4", the rows "A lien released into free balance", "A payment to the other side" and "What is left of a lien". OP "3.7.6". OI "The backstop's buyout". | 04ab51fecb99b961 |
| VLT-143 | K | OI "The held-amount families" (the custody after a failed sale stays under the collateral lien) and "The backstop's buyout" (the split, the slice, valued once when the split is recorded). | 57d23fc09c024da1 |
| VLT-144 | K | OI "The backstop's buyout", all of it. | a9d74d00dc452037 |
| VLT-145 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. | dbad134acc8a3c2b |
| VLT-146 | K | OI "The ceiling and the date", last sentence. `docs/DesignsAndPlans/LendingBalanceDesign.md` "6.2": who gives notice, the date as the earlier of the notice date and the term's end, what clears a notice, and that it is not withdrawn. | 5ed0056ef53f9e92 |
| VLT-147 | K | PR "Liquidation fallback": the collateral leaves the vault "only to settle the fallback (the lender claim, a retry, an internal match or the keeper backstop)", "or returns to the ordinary collateral lock if the borrower cures first"; "if the borrower adds collateral .. and the loan again satisfies the required LTV and Health Factor thresholds, the loan may continue as an active loan". | 62c52bf7689f9efa |
| VLT-148 | K | OI "The NFT rental", for the close. | 788dcaea90d33ad6 |
| VLT-150 | K | OP "3.7.2", item 4, first paragraph. The backstop's vault as a payer: OI "The backstop's buyout" "The backstop's fixed address": as a lender the backstop acts through an ordinary vault it owns (VLT-210, the re-read's E1). | 60aa67d617db94ce |
| VLT-151 | K | OP "3.7.2", item 4, "The purpose is set by the paying vault". | 20ddbb8a46e333f5 |
| VLT-152 | K | OP "3.7.2", item 5, last sentence. | f647cca085b0b246 |
| VLT-153 | K | OP "3.7.2", item 4, first paragraph, from "What arrives is held for the position" | 96a6ebc0bd1f8e83 |
| VLT-154 | K | PD "4.1" and "4.2": what is released to a position's holder goes to the holder's vault. OP "3.7.2", item 4, names purposes only for a payment for a position, so a release carries none. | 04284a17f34193db |
| VLT-160 | N | New. Raised by mistake VLT-M13. Approved by the owner on 2026-11-22, 09:56 UTC. | c5c35b915fb95041 |
| VLT-161 | K | VO "Deposits", third item: a vault may deliver an NFT to another vault and "this does not open receipt to arbitrary senders". OP "3.7.1", "An NFT is sent, never pulled", for the owner's own send. OI "The receive hooks", for the listing escrow and the rental return. Mistake VLT-M12. | f2c6751496fd8c2c |
| VLT-162 | K | PR "Tracked Vault Holdings" and "Adopting and Disowning Untracked Assets". | b4e301f641cde729 |
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
| VLT-185 | C | OP "3.7.5", first paragraph: a lien's "actions need the new holder's authorization". Its first item: a record "accepted only from the replaced token's holder or that holder's genuine vault". PD "4.7". The three forms are written here: the sources give the rule and not the form. Changed with the owner's approval of 2026-11-22, 09:56 UTC. | 871101e506326d9a |
| VLT-200 | N | New. Raised by mistake VLT-M03; the conflict read. Approved by the owner on 2026-11-22, 09:56 UTC. | ce96f91032126dad |
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

145 statements. Kept: 117. Changed: 11. New: 17.

## Approvals

- Section 1 was approved by the owner on 2026-11-22 at 09:17 UTC.
- Sections 2 and 3 were approved by the owner on 2026-11-22 at 09:56 UTC.
- The statements of section 3 that follow from the change of the unit of account were written
  from the owner's answer of 2026-11-22 at 11:03 UTC, which approved that design.
- VLT-246 was approved by the owner on 2026-11-22 at 14:31 UTC, and reworded with his approval
  of 15:05 UTC.

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
- VLT-140 lists the commitments it covers. VLT-115 and the model of a lien cite the statements
  that state a release of a lien (VLT-035, VLT-131).
- Two statements of the approved sections are held outside this folder, under ids in the held
  range, at the security review's request. Citations of them are removed from this folder.

## Mistakes answered

| Mistake | Answer | Statement |
| --- | --- | --- |
| VLT-M01 | Warn only | VLT-102 |
| VLT-M02 | Undo | VLT-162 |
| VLT-M03 | Bound | VLT-200 |
| VLT-M08 | Refuse | VLT-071 |
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
| VLT-M32 | Undo | VLT-183 |
| VLT-M37 | Undo | VLT-230 |
| VLT-M38 | Refuse | VLT-171 |
| VLT-M39 | Warn only | VLT-173 |
| VLT-M40 | Refuse | VLT-172 |
| VLT-M41 | Undo | VLT-174 |
| VLT-M42 | Refuse | VLT-012 |

## Retired ids

None.

## Owed

References to rules of a domain that is not entered yet. Each is replaced by a statement id
when that domain is entered.

| Owed | Cited by |
| --- | --- |
| AUT owed: a change to the platform is tested against every registered version first. | VLT-227 |
| AUT owed: who governs the version registry | VLT-222 |
| DPL owed: a launch is refused until the endpoints fixed in the vault code and those the platform is configured with agree. | VLT-244 |
| DPL owed: the first version and its launch check | VLT-225 |
| DPL owed: the treasury's address is never the platform's own | VLT-042 |
| DPL owed: which of the two holds between each pair of networks. | VLT-102 |
| EXT owed: the ends an exit adds | VLT-142 |
| EXT owed: whether a sale clears it. | VLT-146 |
| FCL owed: rounding, lender first | VLT-147 |
| FEE owed: the share's size. | VLT-143 |
| FEE owed: the treasury vault's own rules. | VLT-212 |
| LON owed: what such a fall does to a lien | VLT-113 |
| RNT owed: its size and payee | VLT-148 |
| VLT owed: beyond the reserve, a protected account draws only from its Ready balance | VLT-145 |
