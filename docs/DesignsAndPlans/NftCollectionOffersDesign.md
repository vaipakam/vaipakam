# NFT collection offers — design

**Status:** owner direction 2026-11-15: build the full version before the feature freeze (collection, range, list, traits, a fill count, and signed offers together). Card #3328. Design for review before build.
**Related:** the signed offer book and its typed-list sets (#3327), the acceptance-terms binding, the illiquid-collateral consent and the risk-access gate, `SecondaryDebtMarketDesign.md` (#3667, which refuses platform position tokens as collateral).

## 1. Why

A lender offer against NFT collateral names one exact token. A lender who would lend the same amount against any token of a collection has to post one offer per token, and re-post each time one is taken. Scouting the code on 2026-11-15 confirmed it: the offer, the signed offer and the loan each carry a single collateral token id, and the acceptance check requires the accepted id to equal the offer's. In practice the NFT side of the book stays empty.

Every established NFT lending venue lets a lender make one offer against a whole collection, or against the tokens that share a trait, for several loans.

## 2. What a lender can offer

A lender offer against ERC-721 or ERC-1155 collateral names a **collateral set** and a **number of loans**:

| Set kind | Meaning | What the offer stores |
| --- | --- | --- |
| Single | One token id (today's offer). | The id. |
| Collection | Any token of the contract. | Nothing more. |
| Range | Any id from a low to a high bound, inclusive. | The two bounds. |
| Listed set | Any id in a stated set, of any size. | The set's root, the number of ids in it, a label, and the hash of the published list. |

Collection and Range may also carry a short **exclusion list** (up to 32 ids, stored on the offer) for tokens the lender will not take.

**Traits are a listed set.** Token traits are not on-chain for almost any collection, so the contract cannot check "has trait X" without trusting someone's word. An offer for a trait is therefore an offer for the list of ids that have it, with the trait written as the set's label ("Background: Gold"). Nobody has to be trusted for it to work: the borrower proves their token is in the set, and that is all the contract checks. Section 5 covers what the lender is and is not told.

For ERC-1155 the offer also fixes the quantity per loan, as it does today.

## 3. Fills

- The offer states the **principal per loan** and the **number of loans** it will fund. The lender's vault holds principal for all of them, reserved to the offer as offer principal is today.
- **Each fill is its own loan** against the one token the borrower locks, at the offer's terms. Nothing is shared between fills.
- A borrower accepts by naming their token and, for a listed set, giving the proof that it is in the set. The acceptance-terms binding names that exact token; the check changes from "equals the offer's id" to "is in the offer's set and not excluded".
- A token already locked under a loan cannot be offered again, because it is in a vault under a lien. Platform position tokens are refused as collateral for every set kind (#3667 part A).
- The illiquid-collateral rules apply per fill. The lender's consent, given once when the offer is posted, covers every token in the set and says so in those words. The borrower consents at each accept. The risk-access gate is checked for both at each fill.
- **A finite expiry is mandatory** for every kind but Single, with a governed maximum (starting at 30 days). A standing offer on a whole collection is a standing bid at a fixed amount; it must not outlive the lender's attention.
- The lender may cancel at any time, or lower the number of loans. The count is lowered in one call to a new lower number. Unused principal is released on cancel, expiry or reduction by exactly the route an ordinary offer's refund takes (the same custody, the same outflow policy, the same events); there is no second route. Raising the number or the amount is a new offer.
- The fees are those of any loan, charged per fill. Each fill emits the existing loan events; the offer's own event states the set and, per fill, how many remain.

## 4. Matching and borrower offers

- A borrower's offer still names its one token. A matcher may pair it with a lender's set offer when the token is in the set, supplying the proof; the match core's existing compatibility checks apply to everything else.
- The Auto-lend standing instructions are for ERC-20 collateral and are unchanged. A collection offer is the NFT counterpart, with its own explicit end.
- NFT rental offers are unaffected: the set applies to collateral only.

## 5. The listed set: what is checked and what is stated

A listed set is identified on-chain by a root. The contract checks only that the borrower's token is in it, by a proof of bounded depth (up to 20 steps, enough for a million ids).

What the platform does so a lender does not sign blind:

- **The list is published.** For up to 256 ids the full list is written in the offer's creation event. For a larger set the offer stores the hash of the list file, the app and indexer keep the file, and anyone can recompute the root from it. An offer whose list file is not available is shown as "list not published" and hidden from the default book.
- **The count is stated, and checked off-chain against the list.** A root does not reveal how many ids are under it, and the contract does not enforce the count; it stores the count and the list hash as the lender gave them. The check is made where the list is: before the lender signs or posts, the app recomputes the root from the list and compares the number of distinct ids, the list's hash and the root with the offer; the indexer does the same before an offer enters the book, and an offer that fails any of the three is shown as "list does not match" and kept out of the default book. The review states that the count is the app's check of the published list and not something the contract enforces.
- **The label is a description, not a check.** The contract does not know whether the listed ids have the trait. The app says so beside the label: "The platform checks that a token is in the lender's list. It does not check the list against the trait." The app builds trait lists from the collection's public metadata and shows the lender the ids before they sign or post; the Console offers an independent recompute of any offer's root from its list.
- **Who carries the risk.** A wrong list can only hurt the lender who posted it. A borrower's position is the same whatever the list holds: their own token, the stated amount, the stated terms.

The typed-list decision for signed offer sets (#3327 part 2) was made so a wallet shows every offer in a set. A list of thousands of token ids cannot be shown that way; the published list, the count and the recompute are what stand in for it, and the review says plainly that the wallet will show a root.

## 6. Signed offers

The signed offer carries the same fields: the set kind, the bounds or the root with its count and list hash, the hash of the exclusion list, and the number of loans. It also carries a signed **start time**. The per-offer fill ledger counts fills, so a signed collection offer cannot be filled more times than it states, and the existing cancels (by nonce, by offer, by the co-signer's refusal) stop it.

- **The lifetime is measured from the signed start time, not from the fill.** A signed offer exists on-chain only when it is filled, so a limit checked at the fill would let an offer signed long ago be held back and used in its last days. For a set kind, a fill requires the start time to be in the past, and the offer's expiry and signature deadline to be no later than the start time plus the maximum expiry. An offer withheld for months is simply expired.
- **A signed offer reserves nothing.** As with every signed offer today, the funds are checked in the lender's vault at each fill; nothing is set aside when it is signed, because nothing on-chain exists yet. A signed collection offer for several loans is therefore a statement of how many the lender is willing to fund, not a guarantee that the funds are there: a fill that finds the free balance short is refused and changes nothing, and several signed offers may point at the same funds. The lender's review and the book say so ("not reserved; filled while funds are free"), and the book shows the lender's free balance beside the offer. A lender who wants every loan guaranteed posts the on-chain form, which reserves principal for all of them (section 3).
- A vault-backed signed offer may state any number of loans up to a governed maximum.
- A wallet-backed signed offer (funds pulled by a single-use permit) states one loan, as wallet-backed fills are single-offer today.
- A signed collection offer may sit inside a typed-list offer set like any other signed offer.

## 7. Limits

Governed, bounded, behind the Timelock delay: the maximum number of loans per offer (starting at 50), the maximum expiry (30 days), the exclusion list size (32), the proof depth (20). The per-wallet open-offer cap counts a collection offer once.

## 8. Contract changes

| Where | Change |
| --- | --- |
| Offer record and creation | The set kind and its data, the exclusion list, the number of loans and fills so far; mandatory expiry for set kinds; principal reserved for all loans. |
| One library for set membership | `contains(offer, tokenId, proof)`, used by accept, match, previews and the signed path. No second copy. |
| Accept, match and their previews | Membership in place of id equality; the loan records the actual token. Previews return the same refusals as execution. |
| Signed offer type and its hash | The new fields, in the typed data the lender signs. |
| Offer cancel, expiry, mutate | Release of unused principal; lowering the number of loans. |
| Views | The set, remaining loans, and for a token: whether a given offer would take it. |
| Indexer and app | The published list, the "would take my token" lookup across the book, the lender's review. Separate follow-up work for the app thread. |

The accept and create facets are near the size limit; the membership library is reached through a host with room, and a facet is split along a seam if needed. Run the storage-layout guard's `write` and the deploy-sanity suite.

### How a fill runs (settled with the builder, 2026-11-15)

- **The collection offer is a parent lender offer.** It is an ordinary offer record (the lender, the terms, the principal per loan) whose principal lien reserves every loan; the set, the number of loans and the fills so far are in a side record. It is created through the same creation route as any offer and counts once toward the open-offer cap.
- **A fill draws a one-token lender slice from the parent** and opens the loan through an existing path: the borrower's own fill through the ordinary accept, a matcher's pairing through the ordinary match core. Membership is checked once, before the slice is drawn. Every origination check therefore runs per fill with no second copy of the rules. Moving principal from the parent's lien to the slice's is one step with no moment in which it is free, and a failed fill leaves the parent's count and lien exactly as they were. The slice opens and closes in the same transaction, emits the events any offer does, and never counts toward the open-offer cap.
- **The parent is refused by every ordinary route** (accept, match, both previews, edit, direct loan sale) with a named reason that points to the collection entries. It fills only through its own entries, on a facet of their own.
- **A matcher's pairing is open to anyone**, so it carries a row in the permissionless-steps ledger.
- **The signed form is a new capability, not a field addition.** Signed and materialized offers refuse NFT collateral today. Section 6 therefore needs a materialization route that admits NFT collateral for a vault-backed slice; the signed-offer creation code moves to its own facet along that seam, and the typed-data change is made together with #3327 part 2. It is built after the on-chain form.
- **Found while scouting, fixed first:** the match core did not compare NFT token ids outside a refinance. It now requires an NFT leg, collateral or rented token, to name the same token and quantity on both offers.

## 9. Tests

1. Each set kind: a token inside is accepted, one outside is refused; range bounds inclusive; exclusion wins over inclusion.
2. Listed set: valid proof, wrong proof, proof for another root, depth limit; the count and list hash are stored as given and not enforced on-chain. App and indexer: a list whose distinct-id count, hash or recomputed root differs from the offer is flagged and kept out of the default book.
3. Fills: exactly the stated number succeed, the next is refused; each loan carries its own token and consent; the reserved principal falls by one loan per fill.
4. Cancel, expiry and lowering the count release exactly the unused principal; no fill after expiry.
5. A token already under a lien, and a platform position token, are refused for every kind.
6. A match of a borrower's single-token offer with a set offer; previews agree with execution on every path.
7. ERC-1155: the fixed quantity per fill.
8. Signed: the hash covers every new field, the start time included; a fill before the start time, and one whose expiry or deadline is past start plus the maximum, is refused, including an offer first submitted long after signing; a fill with the vault short is refused and a later one with funds succeeds; the fill ledger stops at the stated count; cancel by nonce; a wallet-backed offer with more than one loan is refused; inside a typed-list set.
9. The acceptance-terms binding names the actual token and refuses a different one.
10. Risk-access gate and illiquid consent per fill, both sides.

## 10. Alternatives considered

1. **Collection, range and a short readable list only; no traits, no signed form** (the first proposal). Smaller to build and audit, but leaves out the two things NFT lenders use most. Set aside on the owner's direction.
2. **A trait attester:** a named service signs "token T has trait X", and offers accept its word. Reads well in a wallet, but adds a party whose error or compromise lets a wrong token through, and someone has to run it for every collection. Rejected in favour of the published list, which needs no one's word.
3. **Read traits on-chain.** Possible for the few collections with on-chain metadata; no general answer. Can be added later as one more set kind.
4. **Lists stored fully on-chain.** Readable without an indexer, but a trait list can be thousands of ids. Kept only as the event publication for small lists.
5. **One shared sum instead of a number of loans** (the lender funds "up to X in total" at varying amounts per token). Needs a price per token, which the platform does not have for NFTs. Rejected: a fixed amount per loan is the honest shape.
6. **No mandatory expiry.** Rejected: a forgotten collection offer is a fixed bid that others can hit after the market has moved.

## 11. Recommendation

The four set kinds with traits as labelled listed sets, a number of loans per offer, mandatory expiry, and the signed form with the same fields, built together.

## 12. Open items for the builder to raise, not decide silently

Settled with the builder on 2026-11-15:

- The existing fill ledger counts the principal filled, one loan's amount per fill; the side record keeps the number filled and the number stated.
- The list file for a large set is kept in the indexer's store under the hash the offer carries. The contract stores only the hash. The book filter of section 5 (list missing, or count, hash or root not matching) is indexer and app work, tracked with the matcher work (#3688).
- ERC-1155 uses the offer's fixed quantity per fill and nothing more.
