# Record: prices (PRC)

For each statement: its sources, its mark, and the approval hash of the text the owner
approved. Marks: K kept, C changed, N new. A dropped rule has no statement and is listed
under "Dropped".
The fuller drafting record, with each read of each draft, is kept with the project's records.

Sources that are files were read at commit `32a165d59d` of the main branch or earlier on the
day the sections were drafted, with the designs as amended on 2026-11-22.
"Owner decision" and "owner's answer" name the owner's own words on that date.

Short names: UD `docs/DesignsAndPlans/UnitOfAccountChangeDesign.md`, whose guards are cited by
the letter and number the design gives them;
PG `docs/DesignsAndPlans/PriceGuardDesign.md`;
OP `docs/DesignsAndPlans/OraclePolicy.md`;
LS `docs/DesignsAndPlans/LoanSettingsSnapshotDesign.md`;
RC `docs/DesignsAndPlans/RatePricedCollateralDesign.md`;
FR `docs/DesignsAndPlans/FeedRegistryDesign.md`;
MR `docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md`, section 5;
LM `docs/DesignsAndPlans/LiquiditySpoofingThreatModel.md`;
CC `docs/DesignsAndPlans/CollateralConcentrationDesign.md`;
PR `docs/FunctionalSpecs/ProjectDetailsREADME.md`;
OA the owner's answer of 2026-11-22, 13:30 UTC, on the three price rules.

## Statements

| Id | Mark | Sources | Approved |
| --- | --- | --- | --- |
| PRC-001 | K | UD "1. One unit record, one rule": every figure kept in the unit, and "There is no moment at which a threshold in one unit meets a price in another". Principle P5. | 34c3f1735855853d |
| PRC-002 | C | PG "Why": one guard that both the platform and the vaults read. PG "Trust model": "The Diamond holds no write path into the guard". Changed by the amendment to UD for the retirement of a price version: the platform's main address alone carries out the raise of the guard's floor, inside a retirement's execute. UD section 5 and the vault statements changed by the owner's answer of 2026-11-22 11:03 UTC: a vault's guard is the platform's. | 87521a5b8250dd85 |
| PRC-003 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 13:30 UTC. | 623078683df238ad |
| PRC-010 | C | PG "What moves": "The status split: Priced, Unavailable (missing) and Divergent (distrusted)". Changed: the line between "no price" and "distrusted" is the presence of a primary source. PR "Oracle-Unavailable Fallback Branch" counts "no feed, or a stale or non-positive answer" as no usable price. Here only "no feed" is no price. Changed with the owner's approval of 2026-11-22, 13:30 UTC. | 6724beeb49fd403b |
| PRC-011 | C | PLT-080, and PG: "a missing price takes the lender-first in-kind path, and a distrusted price refuses". The pair rule is kept from PR: a price the sources disagree on refuses a default "except where the other leg has no usable price at all: there the missing-price rule wins". Changed with the owner's approval of 2026-11-22, 13:30 UTC. | 70e992f49e011c6f |
| PRC-012 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 13:30 UTC. | f38aa42c49c841eb |
| PRC-014 | K | OP: the read that "reports the three outcomes (priced, unavailable, distrusted)". PG: the guard exposes a view that does not fail. That a preview reads by the step's rule: UD, the previews of a replacement. | ffe97834af1b5155 |
| PRC-015 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 13:30 UTC. | f8c275d948f29e34 |
| PRC-016 | N | New. Raised by threat PRC-T02; the conflict read. Approved by the owner on 2026-11-22, 13:30 UTC. | ff4057df58c6d1d0 |
| PRC-018 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 13:30 UTC. | 6e28c57f0d5ee446 |
| PRC-020 | K | LS: a loan keeps the price settings it was opened under. UD section 5: "A read that has no loan .. reads the old guard at its newest version", and a loan opened since a replacement is read at its own. | faa6899afa9b312a |
| PRC-021 | K | PG "How the Diamond reads it": "A missing or mismatched guard is a deploy defect, never 'no price': reading it as unavailable would hand a lender the whole collateral on a price nobody looked up". UD section 2: "Every ordinary price read refuses a guard in another unit, and that stays so". UD, the guard's floor: the guard refuses a read at a version below its floor. | e8d685f809ef95e1 |
| PRC-022 | C | UD section 2, "Reading a guard that is not the platform's". Changed with the owner's approval of 2026-11-22, 13:30 UTC. | de535ca559732bea |
| PRC-030 | N | New. Raised by threat PRC-T15; the conflict read. Approved by the owner on 2026-11-22, 13:30 UTC. | f82c2c8574ba3067 |
| PRC-031 | N | New. Raised by threat PRC-T15. Approved by the owner on 2026-11-22, 13:30 UTC. | 8ce63dc53fdefe56 |
| PRC-040 | K | PR, "A price read never depends on the caller's gas": every read of the guard is handed one fixed amount, and a transaction that cannot supply it fails. UD section 3: "Every read of the old guard and of a proposed guard is handed the fixed read budget", "A step that reads two guards hands each its own budget, and the least gas the step needs is stated with both in it". | 21a071292f8c29cd |
| PRC-041 | C | UD section 3, "A read that ran out of gas is no answer". PR, same paragraph: a read that cannot be handed its whole fixed amount fails by name. Changed with the owner's approval of 2026-11-22, 13:30 UTC. | 5d0c69ab602053cd |
| PRC-100 | C | OP "Primary source": an asset resolves to a feed directly, or through the route of the network's coin, and one with neither cannot be priced. PR, the denominator the feeds are quoted in. RC section 2: the third route. Changed with the owner's approval of 2026-11-22, 13:30 UTC. | bd49f5cde052d148 |
| PRC-101 | K | PR, the wrapped coin's special case: priced from the coin's own feed. | aaa956e499a7ef15 |
| PRC-103 | C | OP "Per-feed overrides", the least answer. PR, valuation precision: "A price of zero must be refused rather than used". Changed: distrusted, not "no price". Changed with the owner's approval of 2026-11-22, 13:30 UTC. | fbf233445e3545fb |
| PRC-104 | K | PR "Peg-Aware Stable Staleness": the peg is one of the feeds' unit or a registered reference. PR, the register of feeds: an entry carries the feed's own update window. | e720826d4c7b5189 |
| PRC-110 | K | PR, the cross-check: unset, too old, unsure or not positive it is skipped, and a difference beyond its bound is a distrusted price. | c5fab3cc65e5995e |
| PRC-111 | N | New. Raised by threat PRC-T06. Approved by the owner on 2026-11-22, 13:30 UTC. | 9f43367ecbf8c161 |
| PRC-112 | N | New. Raised by threat PRC-T06. Approved by the owner on 2026-11-22, 13:30 UTC. | aa79780c85456f22 |
| PRC-120 | K | OP "Quorum rule", step 1, and "When a source reads as unavailable" | 4e604d9d4a70cd7f |
| PRC-121 | K | OP "Quorum rule", step 2. PR "Secondary Oracle Quorum" | b5c7dd281973f3cc |
| PRC-122 | K | LS "What is not versioned": "A mute only refuses more: the source's agreement stops counting and its disagreement still refuses. A removal also drops the source's refusals, so it loosens the quorum". | bb6e5afaf416483d |
| PRC-123 | K | PR, the dispute buffer: only a report made at least the buffer before the read, age still measured from the read, and no reading on a network younger than the buffer. | de9be153812b64e6 |
| PRC-124 | N | New. Raised by threat PRC-T06; the conflict read. Approved by the owner on 2026-11-22, 13:30 UTC. | a1f6ee58493f3bdb |
| PRC-132 | N | New. Raised by threat PRC-T05; the conflict read. Approved by the owner on 2026-11-22, 13:30 UTC. | e75b12a3d3a85eec |
| PRC-135 | K | OP, the sequencer check: no price while the sequencer is down or inside the recovery window. PLT-090 owns the outage and the window. The last sentence: PR, "carries on without one that fails". | 0e33fc4f29386d2c |
| PRC-140 | K | PR, "Secondary Oracle Identity Comes With the Feed Registration", and OP: the token's own symbol is never read, the wrapped coin is the coin, and a register that cannot answer is no identity. | 163e92ad512ddbd6 |
| PRC-150 | K | RC section 2: the price is the underlying's price times the rate, and the underlying keeps every check. RC section 3: the two kinds of rate source, an underlying priced by a feed and never by another rate. RC safeguard 4: the lower of the rate price and the market price. RC section 5: a binding is versioned. | 56bdd7bcb44ce79d |
| PRC-151 | K | RC safeguard 1: the rate may not jump up, the bound counted as at most one day, anyone may record. Safeguard 2: a drop is taken at once. RC section 5: the accepted rate is measured state shared by every version with the binding. | d60df3f95550e51b |
| PRC-152 | K | RC safeguard 2: a fall past the bound marks the price distrusted, the lowest rate since the fall, the observation time, and that whoever confirms chooses no number. | 16453919aa55d9a2 |
| PRC-153 | C | RC safeguard 3: a stale rate or a failed reader call "gives no price, handled like any missing feed". Changed by the line of section 1: the token has a route, so it is a distrusted price, of the silent kind. Changed with the owner's approval of 2026-11-22, 13:30 UTC. | 89a896fc3ccd96dd |
| PRC-154 | K | RC section 5: a mute is a stop that reaches every loan at once and leaves the price distrusted, not missing. Unmuting waits the delay. | f69c5460e57f7c10 |
| PRC-155 | K | RC section 3, "How a binding starts" | f548b72dd9ae6c81 |
| PRC-156 | K | RC section 2, "Collateral only". PR: an offer, a loan and a lender intent that would lend one are refused. | b9bd955f66659252 |
| PRC-157 | N | New. Raised by threats PRC-T18, PRC-T19. Approved by the owner on 2026-11-22, 13:30 UTC. | 2fc2c7734bb5aa50 |
| PRC-200 | K | PG "Trust model": not upgradeable, a new guard is a new deploy; "First settings": the constructor takes the full config, checked once. UD section 2: one step for every replacement of the guard. | d9bb112dfd7bb279 |
| PRC-201 | K | PG "Trust model": every entry is proposed by the owner and executed by anyone once the delay has passed, the owner or the guardian may cancel, one change is pending per entry and each waits the delay set when it was proposed; "Not configurable by the Diamond" | a73dbaaf15544753 |
| PRC-202 | N | New. Raised by threat PRC-T17; the conflict read. Approved by the owner on 2026-11-22, 14:31 UTC. | 50ad53c8c06cca29 |
| PRC-210 | K | PG "One fast lever": the guardian may disable a secondary source at once, stop-only, re-enabling waits the delay, and a stop cancels a re-enable waiting or due. LS section 4, "What is not versioned": a stop applies to every version at once and a restore only restores a source the version already named. RC section 5: the mute of a rate source. | d17cb9638d45fe54 |
| PRC-211 | N | New. Raised by threats PRC-T02, PRC-T17, PRC-T19. Approved by the owner on 2026-11-22, 14:31 UTC. | 5c7f214976156f51 |
| PRC-213 | K | LS section 2, rule 4, "Dead-source removal", and section 4, "What is not versioned": a removal drops the source's refusals, waits 48 hours and not the guard's delay, can be cancelled, reaches every open loan, and is announced as a retirement is. | 0eb1c57524485cd5 |
| PRC-214 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 14:31 UTC. | b41a06e020dcdb95 |
| PRC-215 | N | New. Raised by threats PRC-T17, PRC-T19, PRC-T31. Approved by the owner on 2026-11-22, 14:31 UTC. | 340f57088d4c8340 |
| PRC-216 | N | New. Raised by threat PRC-T31. Approved by the owner on 2026-11-22, 14:31 UTC. | 72dbc7679715f9bd |
| PRC-217 | N | New. Raised by threats PRC-T31, PRC-T20, PRC-T02. Approved by the owner on 2026-11-22, 14:31 UTC. | 5adf356020fb75f8 |
| PRC-220 | C | FR section 4, "Roles" and "Every change waits a delay the Safe can veto": the delay, the guardian's veto, no instant removal, the proposer's scope, every proposal published, the entries listable. Changed: a proposal may carry several entries, which take effect together or not at all. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 80cee8fbbb86840a |
| PRC-223 | C | FR section 4, "Roles": the proposer executes a proposal whose delay has passed. Changed: anyone carries out a change that is due. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 2b469b03b9271ffd |
| PRC-221 | C | FR section 4, "Checks on every add or replace", and PR, the register of feeds: an entry carries the feed's update window, the move it publishes on and its category. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 72e4111ab17b0014 |
| PRC-222 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 14:31 UTC. | 88e166f221db8f96 |
| PRC-224 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 14:31 UTC. | 5dc67de69b99fae5 |
| PRC-225 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 14:31 UTC. | ee2e59ee01889fd9 |
| PRC-230 | C | LS section 4: a price version is the pair of the guard's count and the register's count, every setting is readable as of a version, and a read at the newest version is the ordinary read. Changed: one proposal makes one version however many entries it carries, and a register's first entries are its first count. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 3633bdfaa9c58b3d |
| PRC-231 | N | New. Raised by threat PRC-T16. Approved by the owner on 2026-11-22, 14:31 UTC. | e6db54d40598e68b |
| PRC-232 | K | LS section 4, "What is not versioned": the stop state of a source, the sequencer check and the constants in code. | 4e40b37ae0b4c454 |
| PRC-233 | K | LS section 4, "Retired price versions are refused by the guard itself": the floor, the register it was set against, a version on a later register, and versions never compared across guards. | e5270f52800df94e |
| PRC-234 | N | New. Raised by threats PRC-T07, PRC-T08, PRC-T17. Approved by the owner on 2026-11-22, 14:31 UTC. | ecbbe8f45d1cfb90 |
| PRC-235 | C | UD section 5, "A standing bound on versions", and LS section 4: a change that would make one more version waits for a retirement, a version counts as retired from the execute, and an alert fires one below the most. Changed: the last place is taken only by the owner. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 3fe5521f40eb439d |
| PRC-236 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 14:31 UTC. | 9c3c1506ea46e695 |
| PRC-237 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 14:31 UTC. | 55088c4a8bf35e70 |
| PRC-250 | K | LS section 2, rules 1 to 3, and section 3: one set recorded when a loan opens, its three parts, the price part never split, every read made for a loan uses its own set. | b48a04813e2e0b1a |
| PRC-251 | C | LS section 2, rule 4: "Four things can still reach an open loan, and nothing else". Changed: five, with the replacement of the guard (UD section 5, worked out at each read and never written). Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 8d39652700119ea9 |
| PRC-252 | C | LS section 2 and section 9: a refinance makes a new loan, an extension or a renewal in place moves the loan to the current set and each cap says so, a sale keeps the set and the buyer's preview states it. Changed: stated by agreement and not by which step writes a loan's start. A step that changes who holds a side and no term keeps the set. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | bcfadc249906df25 |
| PRC-253 | C | UD section 5: the version a loan is read at on a guard is the record's own where the record names that guard, else the version the guard was applied at, each followed through that guard's own retirements. Changed: once a floor has taken effect a loan's version is the higher of its own and the floor, so nothing is written for a retired price version. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 50c01f5245a15100 |
| PRC-254 | C | LS section 4, "The vault's own check": a vault keeps no copy of a loan's settings, accepts only the guard its code names and a version the guard still answers, so its bound holds against the most lenient live version. Changed: a version with no source for an asset the lien holds as priced gives the vault a refusal. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 74eb668cef6a1f58 |
| PRC-255 | N | New. Raised by threat PRC-T20. Approved by the owner on 2026-11-22, 14:31 UTC. | 15b1623de6c062bf |
| PRC-260 | K | LS section 7: governance may retire one part, the wait of at least 7 days, the cancel, anyone executes, a retirement of a price version retires every older one. A whole guard is replaced, not retired (UD section 2) | 70bb65f33637a1b6 |
| PRC-261 | C | LS section 7: the current value cannot be retired, the new value is made current first, the retirement names its replacement, and it lapses if the current value changes during the notice. Changed: the named replacement is not retired and is newer than every value retired. It need not be current, and the retirement no longer lapses when a newer value is made. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 060a29234fe16bfb |
| PRC-262 | K | LS section 7: the proposal is the announcement, published with every difference, both parties told with the date and the loan's reading at the named value, and a chained retirement told as well. | 79827363a2cdde3b |
| PRC-263 | N | New. Raised by threats PRC-T16, PRC-T17. Approved by the owner on 2026-11-22, 14:31 UTC. | cd971e67377babb1 |
| PRC-264 | C | LS section 7: the loan moves to the replacement its retirement named and not to whatever is current, chained retirements are followed, one sync step that anyone may take and every step takes first, and a read of a loan not yet synced answers as if it had been. Changed: the move is for a route part or a marketplace part. A retired price version needs no move. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 3a391cbe57f17456 |
| PRC-265 | N | New. Raised by threat PRC-T16. Approved by the owner on 2026-11-22, 14:31 UTC. | 20081416887eec87 |
| PRC-270 | K | UD section 5, "The versions must agree", and LS section 7: the paged check inside the check window, the bound across assets, the middle within the tolerance of one, the named version vouching for every asset in use, and the exemption. | 8807938385b401f1 |
| PRC-271 | K | UD section 5, "A settling time, and a floor that comes by the clock", and LS section 4: the raise names its retirement and the exact floor, lapses with it, is executed by the platform alone, and takes effect a stated wait after the execute with no second call. | 50315bdb3c21504f |
| PRC-272 | K | UD section 5, the same paragraph and "Why two times": both readings for the settling time on the loan clock, the floor's wait never shorter than it, and no second key after a retirement. | 031615f98e6c1d58 |
| PRC-273 | N | New. Raised by threat PRC-T07. Approved by the owner on 2026-11-22, 14:31 UTC. | d11ca0f383b305e8 |
| PRC-274 | K | UD section 5, "One at a time": not inside the settling time of a replacement, not before the floor of an earlier retirement has taken effect, and a setting changed after the execute changes neither the floor nor the moved loans. Open in a pause: LS section 4, the cure for a version whose source has died. | 2809bdba2d667a5f |
| PRC-280 | K | LS section 7, "Consent": both holders approve the exact set, an approval names the set, and no one-sided step moves a loan's price part. | 689dd70a2dc11f45 |
| PRC-281 | C | LS section 7: refused where the set is no longer current or the loan is past its default or held after a failed sale. UD section 5 and the note of section 1: a move or an extension that would land a loan on a version with no source for an asset its own version priced is refused. Changed: the ground is an asset the loan holds as priced, and an asset the loan holds as unpriced stays on its route on any set. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 4f43985371405b98 |
| PRC-282 | C | UD section 5: from a proposal on, both holders of a loan whose caps allow an extension get a notice that names the loan, the earliest date an extension can run, and that it ends the loan's second key. Changed: the same notice is owed where an extension will be refused for a dropped source, and the skip is published. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 8bf67f2d5e99c227 |
| PRC-300 | K | UD section 2: every replacement goes through one step, a replacement that keeps the unit has a rate of exactly one, and if any check fails the whole transaction fails. | bd908822e0e74f2a |
| PRC-301 | K | UD section 2, "The registry's part": only the platform's main address executes a pending price guard, and the registry reads nothing from a proposed guard and knows nothing about units. VLT-220. | bc039d613c69bbdb |
| PRC-302 | K | UD section 2, "Three addresses are fixed once" | 9a7a933f24b996b9 |
| PRC-303 | N | New. Raised by threats PRC-T08, PRC-T17. Approved by the owner on 2026-11-22, 14:31 UTC. | dddddce4760a52d7 |
| PRC-310 | C | UD section 3, step 1, and G1: one replacement may be pending at a time. Changed: the proposal lists every figure fixed in the proposed guard's code that differs from the guard in force. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | d66a618515dbf80f |
| PRC-311 | C | UD G1: a guard that has been the platform's before is refused at the proposal and at the apply. UD section 5: the step refuses a proposed guard whose floor names another executor. VLT-245. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 7a5061d0716eb7ce |
| PRC-312 | K | UD section 3, step 2. G1: the wait is at least the price guard's own. | ad2e347e869f5097 |
| PRC-313 | K | UD section 2, "The Diamond's part" | 5c83879377d720a0 |
| PRC-314 | K | UD section 3, step 3. | 040b1636612218a7 |
| PRC-315 | C | UD section 4, "The assets in use": the six kinds. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 3ee445a3af545331 |
| PRC-316 | C | UD G15, and "The assets in use": the joining is the one seam where the proposed guard is read. Changed: a first use as unpriced is never refused by a replacement. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | a979e2921399b62b |
| PRC-317 | N | New. Raised by threat PRC-T09. Approved by the owner on 2026-11-22, 14:31 UTC. | a4c0a307d7fc1772 |
| PRC-320 | K | UD section 4, "Two guards' prices are never compared unconverted, nor with a rate fixed earlier" and "A read that ran out of gas is no answer". | e779774c9b60c1f8 |
| PRC-321 | C | UD section 3, step 4. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 124248b9b11e9564 |
| PRC-322 | K | UD G3. | f8f5287700b24c6e |
| PRC-323 | K | UD G4 and G5. | 9cab19270576e643 |
| PRC-324 | K | UD section 4, "When the old guard is wrong, not dead" | 02b6a60d48d37a6d |
| PRC-325 | K | UD G6. | cf6debcc9b8fef7e |
| PRC-326 | K | UD section 3, step 5, and section 5: the step records the price version it applied the new guard at. | e61887ed3570c650 |
| PRC-327 | N | New. Raised by threats PRC-T07, PRC-T17. Approved by the owner on 2026-11-22, 14:31 UTC. | 11bd119e36c96f24 |
| PRC-328 | K | UD section 4, "What a replacement can still move", and step 3 for the preview of each threshold. | 1d6664225a262a11 |
| PRC-329 | K | UD G12, and "In a pause" | 706a235a61cb938d |
| PRC-330 | K | UD G14, and section 5, "One change retires the guard": the step chooses nothing, and a vault change cancelled alone leaves the step refused. | e1cc6027268a3b3c |
| PRC-331 | K | UD section 5: every replacement ends every pin, the version differs in the guard's address alone, and the second key is never the vault's. | 9afe00d405432d6c |
| PRC-340 | C | UD G13, and section 5 for the version each guard is read at. Changed: both readings are needed on every asset not exempt, the step waits where the old guard cannot vouch, and the caller brings every reading. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 0009ccd954acd400 |
| PRC-341 | C | UD G13: a step that prices an amount, and its five cases. Changed: the step also waits where the old guard cannot vouch for an asset of the pair that is not exempt. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 78d58b3d026e2f1e |
| PRC-342 | N | New. Raised by threat PRC-T07. Approved by the owner on 2026-11-22, 14:31 UTC. | 0b4e37d90ce30fe6 |
| PRC-343 | N | New. Raised by threat PRC-T07. Approved by the owner on 2026-11-22, 14:31 UTC. | a5d7c7465e0acfd2 |
| PRC-344 | K | UD section 5, the table: hourly checkpoints, and an offer's recorded guard prices. | 0b471c9dbe04d048 |
| PRC-350 | C | UD G16, and section 4, "Open loans move with the guard, and older loans keep a second key". Changed: the test is by agreement, the time the loan took its set, and not by the loan's start. A change of who holds a side neither gives nor ends a key. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 6df71727f9ac8f9a |
| PRC-351 | C | UD G16 and "A band". Changed in one sentence: where the replaced guard cannot vouch the key is not met. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 02ede1c95f50d15d |
| PRC-352 | N | New. Raised by threat PRC-T11. Approved by the owner on 2026-11-22, 14:31 UTC. | c645af14bd263f05 |
| PRC-353 | C | UD section 4, "An end when the old guard cannot vouch". Changed by OA: only silence is recorded and only silence ends a key. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 8e25a842641dafab |
| PRC-354 | N | New. Raised by threats PRC-T11, PRC-T14. Approved by the owner on 2026-11-22, 14:31 UTC. | 6275bc9ccc1f568c |
| PRC-355 | K | UD section 4, "A key outlives a later replacement", and section 5 for the version each key reads. | a00200797a746ca7 |
| PRC-356 | C | UD section 4, "An end when the old guard is silent". Changed with the owner's approval of 2026-11-22, 14:31 UTC. | a9f2156e745750fd |
| PRC-357 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 14:31 UTC. | 7d311e0f4f11f303 |
| PRC-360 | K | UD section 4, "A change without the old guard" | b4b3f540c9436cf3 |
| PRC-361 | N | New. Raised by threat PRC-T12. Approved by the owner on 2026-11-22, 14:31 UTC. | 21520182d29c5ff7 |
| PRC-362 | K | UD section 4, "Correcting an unchecked rate". | 7c5f5097af9bcef5 |
| PRC-400 | K | UD section 1: one unit record, its four parts, the scale that starts at one, and the rate as the number of new units for one old unit. | 3aa7478be83a0fe4 |
| PRC-401 | C | UD section 1, "one rule": the five kinds and the one way each is read. Changed: the kind follows from where a figure comes from. A figure measured and added up over time is kept as weights are, and the record of fees is one. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 5cebb8faa885fd8b |
| PRC-402 | C | UD section 1: a setter takes its figure in the unit in force and converts before the range check, and a change converts every figure by changing one stored number. Changed: a change of a figure that waits is converted when it is proposed, and the proposal publishes both figures. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 40055ffafad29cd8 |
| PRC-403 | C | UD section 1, "Rounding is stated per figure". Changed: rounding holds for every read through the scale as well, and a rate per unit rounds down. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | aa7b32491002f75f |
| PRC-404 | N | New. Raised by threat PRC-T17. Approved by the owner on 2026-11-22, 14:31 UTC. | 14b9b87c62b4defd |
| PRC-405 | N | New. Raised by threat PRC-T17. Approved by the owner on 2026-11-22, 14:31 UTC. | ba126874f3904cb8 |
| PRC-406 | N | New. Raised by threat PRC-T13. Approved by the owner on 2026-11-22, 14:31 UTC. | 767b2855f688fbb0 |
| PRC-410 | K | UD section 2: a change of unit is a replacement whose proposal names a unit and a rate, and the step writes the unit record at the apply. Section 3, step 2, for the wait. | eb5feca9015e8b69 |
| PRC-411 | K | UD G7, and "Correcting an unchecked rate": the rate as corrected stays inside the range one change may have. | 2478ac8ecc833fdf |
| PRC-412 | K | UD G8. | a0344305b57847a2 |
| PRC-413 | C | UD section 5, the table: thresholds, rates per unit, the fee record, the daily prices, the hourly checkpoints and the reward weights. Changed: the record of fees is kept as weights are. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 6ffba27309cb6e4b |
| PRC-414 | K | UD section 1, "The sizes of the liquidity test", and "Two things the next guard needs" | 9c10abde2ea252a6 |
| PRC-420 | K | UD section 1, "Reward weights" | a7ebb97c8e9035c5 |
| PRC-421 | C | UD section 1, "Reward weights": weights are summed for each change of unit, always, and a replacement that keeps the unit starts no new sum. Changed: the record of fees is summed the same way. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 7a5821e91096c6f7 |
| PRC-422 | K | UD "Correcting an unchecked rate": the factor of a sum, and a later change built on an unchecked one. | 4cab6f0312c88d0a |
| PRC-423 | C | UD "Correcting an unchecked rate": the factor of a reward day is one figure for every network, and a closed day stays as paid. Changed: "one figure for every network" is left to the reward rules, with the edge found in its review. Each network sends its own product of rates and its own scale with its sums. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | ef60c254bfa1e386 |
| PRC-424 | C | UD section 1, "Reward weights", last sentences, and G6 for the stated drift. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 62f4de0a118748df |
| PRC-430 | C | UD section 6. Changed: a correction names one rate for every network that applied the change unchecked, and an added network takes the product of rates too. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 85d480afb287321d |
| PRC-431 | N | New. Raised by threat PRC-T13. Approved by the owner on 2026-11-22, 14:31 UTC. | 004a9a1faaa4e2ec |
| PRC-432 | C | UD section 6: a network behind, what drifts while it is, and the two ways out. Changed: no refusal on a network that is behind, a keeper pass backs the apply on every network, and the check across networks reports a difference of scale and each network's readiness. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | 0da46197567032c7 |
| PRC-440 | K | UD section 8: the map, what it covers, and that it is built with the rule. | 97337aea160f90c2 |
| PRC-441 | K | UD section 8: the check and what it refuses. | 7fb0320cbe1fdea2 |
| PRC-450 | K | UD section 7: the app, the notices and the Terms. | c09f73d139a356c1 |
| PRC-451 | C | UD section 7: the indexer and the keeper. Changed: the liquidation, default and periodic settlement passes never stand down for a change of unit. Only a pass that compares against the keeper's own configuration does. Changed with the owner's approval of 2026-11-22, 14:31 UTC. | a0c5d27b93cfdb78 |
| PRC-500 | K | PR, liquid asset criteria 1, 2 and 5: a price path and the test at the floor size, judged from the active network alone. MR decision 2: no list and no per-asset step admits an asset. PLT-123. | aed0fdb9a7942887 |
| PRC-501 | C | PR, "Liquidity Determination Process", point 5: a temporary failure of a check treats the asset as not liquid. Changed by the owner's price rules of 2026-11-22 (PRC-011, PRC-012): a distrusted price refuses the step and is never read as no price. A pool that cannot be read still counts for nothing, as PR states. | dd74eafa30b5bd1a |
| PRC-502 | N | New. Raised by threat PRC-T24. Approved by the owner on 2026-11-22, 15:05 UTC. | 15372bf1c2436232 |
| PRC-503 | K | PR, "Illiquid Assets": every unique token is not liquid, and its worth to the platform is nothing. | cd385f40d72dc5cb |
| PRC-504 | K | RC, and the note section 2 left for this section: the depth test is made on the token itself, and its tier is no higher than its underlying asset's. | 58678b87c5579553 |
| PRC-510 | K | PR, criterion 2 and the "Slippage and Depth-Tiered LTV Risk Model": the loss of a sale of a stated size below the trusted price, the fee as charged, a tiny sale overstated and never understated. MR decision 5 for the sizes and the budget. | 9808099498560ac0 |
| PRC-511 | K | PR, criterion 3, and MR decisions 2, 4 and 8: one pool against one quote asset, the named venues, the fee cap, no route through two pools and the safe error that follows. | dca88ea84f22af75 |
| PRC-512 | C | PR, risk model: an asset is never quoted against itself, the list names a quote besides the wrapped coin, a quote with no price is skipped, and the launch check. Changed: being on the list gives an asset no standing. PR, "Progressive Risk Access", counts a listed quote asset in the deepest class by its place on the list, which PLT-123 does not allow. Changed with the owner's approval of 2026-11-22, 15:05 UTC. | fceae10957240a56 |
| PRC-513 | K | The owner's decision of 2026-11-08 (PR, criterion 4; LM, status): depth is credited only as the average a pool held over the window, read from its own record, and a pool with no such record never counts. | 2fd96a005490ccde |
| PRC-514 | K | PR, criterion 4, the two reads: the lower of present and average at an opening, the average alone at a close-out, valued at the trusted price. | 83620efbe68404e8 |
| PRC-515 | K | PR, criterion 4 and the two guards of the risk model: a pool's present price agrees with the trusted price and with its own average inside the band at an opening, and a close-out applies neither check. | fccbef002d026f50 |
| PRC-516 | N | New. Raised by threat PRC-T21. Approved by the owner on 2026-11-22, 15:05 UTC. | 4bddf7b00d057a69 |
| PRC-517 | N | New. Raised by threat PRC-T26. Approved by the owner on 2026-11-22, 15:05 UTC. | 9cc011100c824377 |
| PRC-518 | N | New. Raised by threat PRC-T30. Approved by the owner on 2026-11-22, 15:05 UTC. | 30102a1c2a04eebd |
| PRC-519 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 15:05 UTC. | cdafb7479c2000aa |
| PRC-520 | K | PR, risk model, and MR decision 5: no tier or one of three, each size passed in turn, and a larger size never makes up for a smaller one. | e0b8619b429638f2 |
| PRC-521 | C | MR decision 9 and section 9.ii: a confidence tier kept by the keeper, raised a step at a time after a window, lowered at once, never above the measured tier. Changed with the owner's approval of 2026-11-22, 15:05 UTC. | 00ca3bf71e54e37e |
| PRC-522 | C | PR, risk model: the effective tier is the lower of the two. Changed with PRC-521: with the keeper down every asset reads with no tier, where the decision of 2026-05-13 left each at the first tier. Changed with the owner's approval of 2026-11-22, 15:05 UTC. | 67b175bf9715f565 |
| PRC-523 | N | New. Raised by threat PRC-T23. Approved by the owner on 2026-11-22, 15:05 UTC. | e24af5ab7b9fe472 |
| PRC-524 | N | New. Raised by threats PRC-T22, PRC-T28, PRC-T29. Approved by the owner on 2026-11-22, 15:05 UTC. | 50ad91911b8d7b28 |
| PRC-525 | K | PR, "Discount Fixed at Loan Start", and CC section 3: a loan records its tier at opening, and nothing later changes an open loan. | 22f9b2cf510913ec |
| PRC-526 | N | New. Raised by threats PRC-T28, PRC-T29; the conflict read. Approved by the owner on 2026-11-22, 15:05 UTC. | 553eb338e0b11b39 |
| PRC-527 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 15:05 UTC. | a5667a6cc22eda00 |
| PRC-528 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 15:05 UTC. | c2c30163c800d8b0 |
| PRC-529 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 15:05 UTC. | 85b781ba7ec17a8f |
| PRC-530 | K | PR, "Illiquid Assets" and "Handling of Illiquid Assets on Default": worth nothing, no health factor, the whole collateral to the lender on default. | e663bafda3ad673d |
| PRC-531 | K | PR, "On-Chain Precedence" and "Acceptance Term Binding": the reading on the chain decides, and the consent names the asset. | b072ef265e2e3518 |
| PRC-532 | C | PR, "On-Chain Verification". Changed by N1 of the re-read of price sections 3 to 5: a record agreed ahead carries each asset's standing, and a fill under the other standing is refused. Changed with the owner's approval of 2026-11-22, 15:05 UTC. | 46c6aa93e1dbe379 |
| PRC-533 | C | PR, "Explicit Storage": each asset's liquidity is recorded with the loan. Changed: it holds for the loan's life, and an asset with a price that fell short of the depth test is held as unpriced. PRC-016 names only an asset with no source, so it needs the words. Changed with the owner's approval of 2026-11-22, 15:05 UTC. | e5a37f8deb399387 |
| PRC-534 | N | New. Raised by threats PRC-T25, PRC-T20. Approved by the owner on 2026-11-22, 15:05 UTC. | 5d445a3243ed3398 |
| PRC-535 | N | New. Raised by threat PRC-T28. Approved by the owner on 2026-11-22, 15:05 UTC. | 8821edf48ebbf4b9 |
| PRC-540 | N | New. Raised by threats PRC-T27, PRC-T28. Approved by the owner on 2026-11-22, 15:05 UTC. | 1fdb630c52b0f61e |
| PRC-541 | N | New. Raised by the conflict read; the security review. Approved by the owner on 2026-11-22, 15:05 UTC. | 9ff50eb3d3490037 |
| PRC-542 | N | New. Raised by threats PRC-T22, PRC-T23, PRC-T28. Approved by the owner on 2026-11-22, 15:05 UTC. | a530257fc638bd78 |
| PRC-543 | N | New. Raised by threat PRC-T40; the conflict read. Approved by the owner on 2026-11-22, 15:05 UTC. | 16213d4a91750f30 |
| PRC-550 | K | PR, risk model, the last point: every figure is bounded and changed under a delay, and the quick levers only take away. | 078e5698fd92ab7e |
| PRC-551 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 15:05 UTC. | 3dc6cb92c4091bb7 |
| PRC-600 | K | PR, the valuing rule: one rule for every value, the debt side rounds up, the collateral side and a value set against a threshold round down. PRC-011 for a distrusted price. | d954fbcc665fc350 |
| PRC-601 | K | PR, risk model and "LTV Breach": the two ratios, the health read against the line the loan recorded. PRC-253 and PRC-340 for the version and the settling time. | 2ff653812d4705c3 |
| PRC-602 | K | PR, the valuing rule: a bound a preview derives is one the binding check accepts. | b98a18542228fdcc |
| PRC-603 | N | New. Raised by threat PRC-T33; the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | 3c8d93f99b502d35 |
| PRC-610 | K | PR, risk model, "Per-Tier Liquidation Thresholds", "Per-Tier Discount Bounds" and the forced-sale floor: what a tier gives, set for all tiers in one step with the order kept. PRC-522 for the effective tier. | 0efcda3d3564d2ab |
| PRC-611 | C | PR, risk model: the switch, the health floor and the lower floor while the caps are on. Changed by the owner's approval of liquidity point 2 on 2026-11-22: collateral with no tier is no longer refused while the caps are on (PRC-615). Changed again by the owner's approval of point 4 (M1, option b) on 2026-11-22: with the caps off the tier's cap still holds and the higher health floor is added, where PR says no tier cap applies. | 784619a83314e797 |
| PRC-612 | C | PR, risk model: a default and a ceiling for each tier, a usable peer reading in place of the default, cut to the ceiling at the read, the notice for an ageing reading. Changed by the owner's approval of point 4 (M1, option b): a reading that stops being usable leaves the lower of it and the default, where PR returns to the default. Changed with the owner's approval of 2026-11-22, 16:24 UTC. | dc9a1c59d58033a5 |
| PRC-613 | K | PR, risk model: the refresh open to anyone, two platforms agreeing within the band, the lowest of those that agree, two reference assets, the median less the haircut. | 847bc4b50aeb5c82 |
| PRC-614 | K | PR, "Per-Tier Liquidation Thresholds" and "LTV Breach": the line of each tier, recorded on the loan at its opening. | ad534585ac75f970 |
| PRC-615 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | b4113fb6d9dab986 |
| PRC-616 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | a2d3ca41a950c0fd |
| PRC-617 | N | New. Raised by threats PRC-T32, PRC-T39; the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | 491822fa9e536616 |
| PRC-618 | N | New. Raised by the security review. Approved by the owner on 2026-11-22, 16:24 UTC. | 6b1e73dfc96b1e98 |
| PRC-619 | N | New. Raised by threats PRC-T32, PRC-T39. Added on the security review's read, under the owner's approval of 2026-11-22, 16:24 UTC. | 25d90c479aebbba8 |
| PRC-620 | C | PR, "Discount Fixed at Loan Start", "LTV Breach", "Optional Per-Asset Initiation-LTV Ceiling" (each loan records the cap it was admitted under) and CC section 3 (the level of concentration). Changed: the health floor is recorded too, and no extension moves a recorded figure. Changed with the owner's approval of 2026-11-22, 16:24 UTC. | 1a1b611a9cfb8e91 |
| PRC-621 | K | LS section 9, "What stays live": depth and tier, the checkpoints and the calm test. PRC-550 for the figures of the liquidity test. | 10a3f228c98a32d1 |
| PRC-622 | N | New. Raised by threat PRC-T25; the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | 7e730f11b485702d |
| PRC-623 | N | New. Raised by the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | 4499dc7268e8b3b9 |
| PRC-624 | N | New. Raised by threats PRC-T34, PRC-T25; the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | a45e3fc286c93ea8 |
| PRC-630 | K | CC section 2 and PR, "Collateral Concentration": the amount pledged under live liens, held collateral counted, the ratio against the size of the tier. Changed only by liquidity point 2: the floor size for collateral with no tier. | 1541c5c19578fad0 |
| PRC-631 | C | CC section 3, rules 1 and 2: the warning, the record and no eligibility for the reserve. Changed: the level a loan records is measured against the size the exposure limit uses (PRC-540), so a keeper's silence marks no loan for its life. Changed with the owner's approval of 2026-11-22, 16:24 UTC. | 5a07fcd57c1ae446 |
| PRC-632 | C | CC section 3, rule 3 and "How rule 3 applies in each regime". Changed by liquidity point 2: collateral with no tier is lowered by the step as the shallowest tier is, where CC left it at a cap of nothing. Changed with the owner's approval of 2026-11-22, 16:24 UTC. | d0435d76e1e1ddf0 |
| PRC-633 | K | CC sections 3 and 4: new loans only, nothing refused, an extension in place not judged, the thresholds read live. | 880191431ce84bae |
| PRC-634 | N | New. Raised by threat PRC-T35; the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | ce25d7794e57adcd |
| PRC-635 | N | New. Raised by threat PRC-T35. Added on the security review's read, under the owner's approval of 2026-11-22, 16:24 UTC. | 3a96b5ec43a1de42 |
| PRC-636 | N | New. Raised by the security review. Added on the security review's read, under the owner's approval of 2026-11-22, 16:24 UTC. | e46f9a3fde32b2a0 |
| PRC-637 | N | New. Raised by the security review. Added on the security review's read, under the owner's approval of 2026-11-22, 16:24 UTC. | 244790fe3d1e4589 |
| PRC-638 | N | New. Raised by threat PRC-T42. Added on the security review's read, under the owner's approval of 2026-11-22, 16:24 UTC. | 9e7ec94807d80177 |
| PRC-640 | K | LS section 9 and PR: one series for each asset, the first caller writes, each slot names its version. | fd3c401d27ab27e3 |
| PRC-641 | K | PR, the forced-sale floor and the price-move guard: one calm rule, the bound against each of the last two hourly checkpoints. LS section 9: both ends at the slot's version. | 9c6341925fca1b56 |
| PRC-642 | K | PR: what cannot be established is not calm. LS section 9: a slot at a retired version, which only a daily slot is read long enough to reach (small point). PRC-344 for a replacement. PRC-401 for a change of unit. | eecf7f3f19f6eb43 |
| PRC-643 | N | New. Raised by threat PRC-T36; the conflict read. Approved by the owner on 2026-11-22, 16:24 UTC. | dd731bb2bf766bef |
| PRC-650 | C | PR, "a forced sale's slippage floor is tighter where the sale is safe to tighten": the tight floor of each tier, the calm test and the coverage. Changed with PRC-522: the tier is the effective tier, where PR reads the depth alone. Changed with the owner's approval of 2026-11-22, 16:24 UTC. | 1f5cb5d87f227b86 |
| PRC-651 | K | PR, the same rule: a missing input only returns a sale to the full floor, for every kind of forced sale. | 8891f42f2935a72d |
| PRC-660 | C | PR, risk model, the bounded settings. Changed: no setting of this section gives a named asset a figure of its own (worded so since the references of PRC-613 are named), which drops the per-asset ceiling on the cap, the per-asset cap on the liquidation bonus and the per-asset thresholds of concentration. Changed with the owner's approval of 2026-11-22, 16:24 UTC. | 01f143eb4240433d |

220 statements. Kept: 90. Changed: 55. New: 75.

## Approvals

- Sections 1 and 2 were approved by the owner on 2026-11-22 at 13:30 UTC, on his answer of
  11:18 UTC and the three points put to him.
- Sections 3, 4 and 5 were approved by the owner on 2026-11-22 at 14:31 UTC.
- Section 6 was approved by the owner on 2026-11-22 at 15:05 UTC.
- Section 7 was approved by the owner on 2026-11-22 at 16:24 UTC, on the condition that the
  security review passed it, which it did at 16:26 UTC.

## Changed after an approval

These changes were made after the approval above, and are entered with this folder for the
owner's confirmation. Each was read for conflict before it was entered.

- Section 7: PRC-612, PRC-613, PRC-615, PRC-617, PRC-618 and PRC-632 were tightened, and
  PRC-619, PRC-635, PRC-636, PRC-637 and PRC-638 added, on the security review's reads of
  16:34 to 18:17 UTC on 2026-11-22. Each only tightens a rule of the approved section.
- Section 6: PRC-521 and PRC-541 were changed, and PRC-543 added, with the owner's approval
  of the points of section 7.
- Sections 1 to 4: a keeper pass that a statement owes is cited under the keeper's own code.
  Form only.
- PRC-225, PRC-344, PRC-414, PRC-520, PRC-525, PRC-526 and PRC-540 cite by id rules of sections
  6 and 7 that they cited in the owed form.
- Nine statements of the approved sections 1 to 3 are held outside this folder, under ids in
  the held range, at the security review's request. Five figures they alone use are held with
  them. Citations of the held statements are removed from the text of this folder, and three
  sentences are shortened with them.

## Dropped

- PR, "Liquidity Determination Process", point 1 (what an interface checks first) is not a
  rule of the platform. PRC-501 says a preview shows the answer its step would act on.
- PR, point 5, "treated as illiquid" on a temporary failure: dropped for a price by the owner's
  rules of 2026-11-22 (PRC-501).
- MR decision 9, "a new asset always starts at the first tier": replaced in PRC-521.
- PR, risk model: "Tier 0 collateral cannot support a new borrow" while the caps are on.
  Replaced by the owner's approval of 2026-11-22 (PRC-526, PRC-615).
- PR, "Optional Per-Asset Initiation-LTV Ceiling", the per-asset cap on the liquidation bonus,
  and the per-asset thresholds of CC section 2: dropped in PRC-660.
- A line at which collateral counts as collapsed is stated by no decision or design read for
  these sections. It is left to the close-out rules.

## Retired ids

None.

## Owed

References to rules of a domain that is not entered yet. Each is replaced by a statement id
when that domain is entered.

| Owed | Cited by |
| --- | --- |
| APP owed: how a value and its unit are shown | PRC-450 |
| APP owed: the notice of a change that reaches an open loan | PRC-262, PRC-314, PRC-344 |
| APP owed: the notice that new loans on an asset are stopped | PRC-636 |
| APP owed: the preview of a change of the guard or its register | PRC-237 |
| AUT owed: how a lowering of a confidence tier is published, with its grounds | PRC-543 |
| AUT owed: the settings of the liquidity test and their ranges | PRC-550 |
| AUT owed: the settings of the risk figures and their ranges | PRC-660 |
| AUT owed: the step that sets a pledged amount right | PRC-637 |
| DPL owed: the daily launch check and what it reports | PRC-111, PRC-132, PRC-222, PRC-237 |
| DPL owed: the launch check across networks | PRC-432 |
| DPL owed: the launch check of the quote list | PRC-512 |
| DPL owed: the launch check of the three fixed executors | PRC-302 |
| DPL owed: the launch check's report of each asset's two tiers | PRC-529 |
| EXT owed: the marketplace part of a loan's settings | PRC-250 |
| FCL owed: a sale that cannot be made | PRC-534 |
| FCL owed: an asset whose primary source has ended | PRC-012, PRC-016, PRC-018, PRC-353 |
| FCL owed: the check that collateral can still be sold | PRC-514 |
| FCL owed: the classing of the close-out's figures | PRC-623 |
| FCL owed: the default of a loan with an asset held as unpriced | PRC-530 |
| FCL owed: the discount of each tier | PRC-610 |
| FCL owed: the discounted route refuses a loan with no tier at its opening | PRC-535 |
| FCL owed: the least output of a forced sale | PRC-510 |
| FCL owed: the most a forced sale may lose | PRC-650 |
| FCL owed: the route part of a loan's settings | PRC-250 |
| FEE owed: the reserve for a lender's shortfall | PRC-631 |
| IDX owed: a stored value and its change number | PRC-451 |
| KOP owed: a keeper pass on an unknown change number | PRC-451 |
| KOP owed: the alert for a short pledged amount | PRC-635 |
| KOP owed: the alert for an ageing peer reading | PRC-612 |
| KOP owed: the alert for confidence tiers not renewed | PRC-529 |
| KOP owed: the alert on a guard's unretired price versions | PRC-235 |
| KOP owed: the keeper pass that carries out a retirement | PRC-260 |
| KOP owed: the keeper pass that carries out due changes of the guard and its register | PRC-201 |
| KOP owed: the keeper pass that checks and applies a replacement | PRC-321 |
| KOP owed: the keeper pass that ends a silent key | PRC-353 |
| KOP owed: the keeper pass that keeps the confidence tier | PRC-521 |
| KOP owed: the keeper pass that keeps the cross-check's reading fresh | PRC-110 |
| KOP owed: the keeper pass that moves loans off a retired part | PRC-264 |
| KOP owed: the keeper pass that records the accepted rates | PRC-151 |
| KOP owed: the keeper pass that writes the price checkpoints | PRC-640 |
| LON owed: what a loan owes at a moment | PRC-601 |
| OFR owed: the consent that names an asset as not liquid | PRC-531 |
| OFR owed: the price-move guard of an offer | PRC-641 |
| OPN owed: the check of that consent when a loan opens | PRC-531 |
| RWD owed: how a reward weight earns | PRC-420 |
| RWD owed: the factor of a reward day | PRC-423 |
| XCH owed: what a message between networks carries | PRC-431 |
