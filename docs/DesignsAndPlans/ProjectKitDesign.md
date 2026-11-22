# The project kit: for token projects and NFT rental projects

**Status:** functional and technical design, 2026-11-22. Approved in outline by the owner on 2026-11-22: one kit with a guide on the site, and a track for NFT rental beside the token track. Nothing here changes a contract.

**Related:** `FeaturesOverExistingPartsDesign.md` sections 6 (renting access, #3772), 7 (the embedded lending kit, #3773) and 8 (the public data feed, #3774), `IntegratorFeeShareDesign.md` section 5, `ProgressiveRiskAccessDesign.md`, the issuer powers check (#3433, #3875, #3876) and the launch list (#3824).

A project that wants its token or its NFT collection used on the platform gets a **project kit**: a guide on the site, one page of facts about any asset, ready-made links into the platform's own forms, and one documented way to read who may use a rented item. The kit is built from parts that exist. It adds no listing, no mark of approval, no score, no launch feature, no campaign and no fee.

## 1. What the scout found

Read in the code at main `bb16284219`.

**For a token**

- There is no listing step. A token's standing is read on chain: `OracleFacet.getAssetPriceStatus` says whether it has a usable price (priced, no price available, or a price its sources disagree on), `getLiquidityTier` gives the depth tier measured now (0 to 3), `ConfigFacet.getKeeperTier` gives the tier the keeper relay has confirmed, and `getEffectiveLiquidityTier` gives the lower of the two, which is what a new loan uses. A newly priced asset opens at tier 1 until the relay confirms more, and the relay can only lower a tier.
- No read says which pool test held a token at its tier. The depth test and the two price-agreement tests run inside one private function and only the tier comes out.
- An asset with no usable price is valued at zero. It can be used only in a hand-made offer, where each party has raised its own access level and holds a standing consent for that exact pair, past a wait (`ProgressiveRiskAccessDesign.md`). Auto-lend slots and the instant market refuse it.
- `AdminFacet.isAssetPaused`, `CollateralConcentrationFacet.getConcentration` and the opening limit of a tier (`getEffectiveTierMaxInitLtvBps`) are public reads.
- The app already has the parts of a facts display: the trust line from the public rankings (`shared/offers/trust.ts`, matched by address, with the possible-copy rule), the issuer powers line (`IssuerPowersLine.tsx`), the label cleaner (`@vaipakam/lib/tokenLabel`), the NFT standard read (`shared/nft/useStandard.ts`) and a transfer probe.

**For an NFT rental**

- The item stays in its owner's vault for the whole rental. The renter prepays the rent and a buffer, and rent reaches the owner day by day.
- Every rental step writes the renter through one route, `VaultFactoryFacet.vaultSetRentalUser`. For an ERC-721 the vault keeps one record for the item and, where the collection reports the user role with an expiry (ERC-4907) through ERC-165, also asks the collection to set that user. For an ERC-1155 the vault keeps one record per rental, up to 64 active rentals of one token in one vault, and asks the collection nothing.
- The renter recorded is the borrower named when the rental opens, and the expiry is the rental's original end. An early end clears the record.
- **One event from one address.** The Diamond emits `VaultRentalUpdated(lender, nftContract, tokenId, loanId, user, expires, quantity, activeTotalQuantity, minActiveExpires)` on every change, with the owner, the collection and the token id indexed. A zero user and quantity is a clearing. The rental is named by its loan id.
- **What a vault answers:** `userOf` (the first active user), `userExpires` (the earliest active expiry) and `userQuantity` (the units rented out across active rentals). These are totals. No read on the vault lists the rentals of one token or gives the units one user holds; the vault's own comment calls that a future helper. The vault's code has 676 bytes of room (`VaultOutflowPolicyDesign.md` section 3.7), so nothing is added to it for this kit.
- `VaultDepositoryFacet.getVaultOwner(vault)` says whose vault an address is, and returns the zero address for an address that is no vault of the platform.
- The index does not follow `VaultRentalUpdated`. It knows a rental as a loan row with an NFT as the lent asset. So a read of rentals by collection, with the recorded user and expiry, does not exist yet.

**The cards this builds on**

- The embedded lending kit (#3773) is on main: `packages/lend-kit` and the app's `/kit` page. It has three link kinds: borrow against an asset, lend an amount, and rent a token. The package is not yet published to a registry. A link works without the package.
- A rental pays no loan initiation fee, so a link to a rental can carry an integrator's id as attribution only. No share applies. The kit already says so (`SHARE_RULE.rent`).
- The rental category for access tokens (#3772) and the public data feed (#3774) are designed and not yet on main. The issuer powers store is in review, and the check in the browser before a first posting (#3875) is carded.
- The site's word check and claim ledger belong to the site wording build and are not on main yet. The guide depends on them.
- NFT rentals are part of the base platform in the launch list's proposal (#3824). No part of the kit needs a switch of its own, because no part changes a contract.

## 2. Rules that bind every part

1. **The contracts stay uncurated.** No token or collection is approved, listed, verified or refused. A token's standing comes from the tier rules and nothing else.
2. **Facts, never a verdict.** The kit shows what the chain and public lists say about an asset, with the source and the block or time of the reading. It never says an asset is safe, trusted, verified or recommended, and it never ranks projects.
3. **The platform hosts no campaign.** No reward programme in a project's token, no promoted placement, no featured projects.
4. **No pooling and no sharing.** Nothing here gathers funds, covers one user's loss from another's, or shares interest.
5. **Fees stay as they are.** No listing fee, no rental royalty, no fee for one project. A project's site can receive only the existing integrator share, under the existing rules.
6. **The same guards for every front end.** To the contracts a project's site is a website and a project is a user. Nothing gives a project a power an ordinary user lacks.
7. **Wording.** The site wording rules and the rewards wording rules apply to every page.

# Part I. Functional design

## 3. The "For projects" guide

Four pages on the public site, written and translated like the user guides.

| Page | What it covers |
| --- | --- |
| How the platform treats any token | There is no listing. How standing is read (price, depth tier, the relay's confirmation). What an asset with no usable price can and cannot do. What the platform never does for a project. |
| Your token | What a project can do today as an ordinary user: lend another asset against its token so holders can borrow, lend its token out, and link its users to a pre-filled form. What it takes for a token to have a usable price and a tier, stated as facts about feeds and depth. A link to the check page. |
| Your collection today | The rental track for a collection that exists (section 7). |
| Building a collection that rents well | The rental track for a new collection (section 7). |

Every page carries one fixed statement that a project may quote in full: **"Anyone can use any token on the platform. The platform does not list, review or endorse tokens or projects."**

The pages give no advice on pricing, token sales or rewards, and make no claim about demand. Each claim on a page has a row in the claim ledger naming the feature it rests on, so a page does not describe a part that is not built or not switched on. The guide therefore ships page by page as its parts land (section 16).

## 4. The check page

A public page of the app where anyone enters a network and an address and sees what the platform reads about that asset now. It needs no wallet.

**The page opens with:** "This page shows what the platform reads about an asset. It is not a review. Nothing here says an asset is safe."

**For a token**

| Row | What it says | Source |
| --- | --- | --- |
| The asset | Its name and symbol as its own code states them, cleaned, marked as the token's own claim | The token |
| Price | Has a usable price, has none, or has one its sources disagree on | `getAssetPriceStatus` |
| Tier now | The tier measured on chain, the tier the relay has confirmed, and the tier a new loan uses, which is the lower | `getLiquidityTier`, `getKeeperTier`, `getEffectiveLiquidityTier` |
| What holds it there | One of: no usable price; no pool passed the platform's depth and price tests; the relay has not confirmed a higher tier; nothing, it is at the top tier | Worked out from the two rows above |
| What that tier allows | The opening limit for the tier. For tier 0: valued at zero, usable only in a hand-made offer under each party's standing consent, refused by Auto-lend slots and the instant market | `getEffectiveTierMaxInitLtvBps`, fixed text |
| New positions | Open, or paused for this asset (exits stay open) | `isAssetPaused` |
| Share already pledged | The concentration reading and whether it lowers the opening limit now | `getConcentration` |
| Issuer powers | Each check as found, not found or could not be told | The shared check (#3433), run in the reader's browser |
| Public lists | Each list's rank for this address and the time of the list, or "not ranked", with the existing possible-copy line | The index's rankings read |

The "what holds it there" row says only what the reads support. Where the tier is 0 with a usable price, the row says that no pool passed and that the platform's read does not say which test failed.

**For a collection**

| Row | What it says | Source |
| --- | --- | --- |
| The collection | Its name as its own code states it, cleaned, marked as its own claim | The collection |
| Standard | ERC-721 or ERC-1155, or "could not be told" | ERC-165 |
| How a rental is recorded | "Carries a user role: a rental sets the user on the item, and the owner's vault records it too", or "No user role: recorded by the owner's vault only", or for ERC-1155 "Recorded by the owner's vault, one record per rental" | ERC-165, fixed text |
| As collateral | Valued at zero. A loan against it needs each party's standing consent | Fixed text |
| Issuer powers | The checks that apply to this standard | The shared check |
| One item (optional token id) | Its owner now. If the owner is a vault of the platform: whose vault it is, the user recorded, until when, and for ERC-1155 the units rented out | The collection, `getVaultOwner`, the vault's reads |

**Rules for the page**

- Every row names its source and the block it was read at. A row that could not be read says "not read". A check the page does not make says "not checked".
- A finding reads "the code has this function". It never reads as what an issuer will do.
- The page writes nothing. The address and the network travel in the link, so opening a link runs the reading again. There is no saved result, no pass state, no score and nothing to embed. The page sets no preview image or preview text that carries a finding, and a project's site cannot show it inside a frame: the app's frame policy allows only the app itself and the wallet app origins it already lists.
- Where the platform's own checker holds a stored reading of the asset, the page states that reading's block beside its own, and names any check where the two differ. Parties in the app see the stored reading, so a project sees what a counterparty sees.

## 5. Ready-made links

The kit's link formats, documented on the guide for a project's own pages. A link only fills in the platform's own form. The user always meets the platform's review, with every figure read from the chain, before signing.

| Link | State | Can the project's id bring a share? |
| --- | --- | --- |
| Borrow against this token or item | Exists | Yes, where the id is registered: a share of the loan initiation fee, under the integrator rules. The user's fee is the same either way |
| Lend this token | Exists | No. Attribution only |
| Lend against this token | New: the lend link gains an optional collateral | No. Attribution only |
| Rent this item | Exists | No. A rental pays no initiation fee |
| Offer this item for rent | New: a fourth link kind | No. A rental pays no initiation fee |

The guide says, for each link, whether a share can apply, in the kit's own words. The share is called a share of the fee on loans the site brings, and nothing else.

## 6. The rental reader

A project needs one dependable answer to "who may use this item now, and until when?"

**The authority is the platform's record:** the owner's vault and the Diamond's event. A collection's own user role, where it has one, is a copy the platform asks the collection to keep. The guide promises nothing about that copy beyond the expiry the platform set on it.

| Case | The answer on chain | The answer off chain |
| --- | --- | --- |
| ERC-721, with or without a user role | Read the item's owner. If `getVaultOwner(owner)` is not zero, the owner is a platform vault: ask it `userOf` and `userExpires` for the item. The vault's owner is the item's owner for everything else | The feed route, or the event |
| ERC-1155 | Not available per user today: a vault answers the units rented out in total, not the units one user holds | The feed route, or the event |

Three ways to read it, all documented:

1. **Two feed routes** inside the public data feed (section 12): the active rentals of one collection, and what one address may use in one collection.
2. **Reference code** in the kit package that answers "may this address use this item now?" from the feed, or from the chain directly by folding the event.
3. **The steps written out** for a project that checks inside its own contract, with a short example for the ERC-721 case. The example is documentation. The platform deploys no reader contract.

The guide states the ERC-1155 limit plainly: a project that must enforce use rights for ERC-1155 items inside its own contract cannot do so from the platform's reads today.

## 7. The NFT rental track

Both rental pages open with the same two lists.

- **The platform enforces:** the item stays in its owner's vault; the renter's right is recorded for the agreed days; rent moves from the renter's prepayment to the owner day by day; the right ends at the agreed time; the item is the owner's again at the end with no action by the renter.
- **The project controls:** whether its game or service honours the recorded renter. A project that reads plain ownership sees the vault and not the renter.

**Your collection today** asks one question: what does your product read to decide who may use an item?

- *It reads the user role on the item.* Nothing to change. A rental shows as the item's user for the period.
- *It reads plain ownership.* During a listing and a rental the owner is a vault. Change the read to the rental reader of section 6.
- *Its items are ERC-1155.* Read the feed or follow the event, and count the units each player may use.

Two more points, stated plainly:

- **Treat a vaulted item as its owner's.** An item listed for rent sits in the owner's vault. A project that gives holders perks, snapshots or votes should count the vault's owner (`getVaultOwner`), or its owners lose those while they list.
- **Decide what a renter may not do.** Selling, burning, merging and one-way upgrades belong to the owner. The platform cannot enforce a project's own rules.

**Building a collection that rents well** is a short list, each with its reason:

- Carry the user role with an expiry on ERC-721 items. Read the user for use rights and the owner for ownership rights. Rentals then work with no integration.
- Let a contract hold an item. A collection that allows transfers only to plain wallets cannot be vaulted, so it cannot be rented or used as collateral here.
- Deliver exactly what is sent. The platform refuses a deposit that does not arrive whole.
- Know what the check page will show. A function that can pause, freeze or take items is shown to every renter and lender as a fact.
- For ERC-1155 items, read the platform's rental record, since that standard has no user role of its own.

**What a project gains,** stated without promises: owners can let an item out by the day without giving it up; players can use an item for a fixed daily fee without buying it; a project's own site can send users into the platform's forms. No share of any fee applies to a rental.

## 8. The guards

The kit invites more unfamiliar assets, so these go with it.

1. **Public figures say how unfamiliar assets are counted.** For every public figure (the feed's totals and rates, the rate curve of #3751, the totals on the app's analytics page):
   - An asset with no usable price is shown in its own units on its own line. It is never added into a value total. A total says it covers priced assets only and gives the number of positions left out.
   - A loan or a rental with one address on both sides is left out of rate and rent figures and counted on its own line. The rule sees one address on both sides only. It cannot see two wallets of one person, and the figure says so.
   - Each figure states its block and what it leaves out.
2. **The access wait is never zero on a mainnet** (#3266, with the deploy check of #3717). The guide's token page does not ship before #3266 is done.
3. **A written rule for the per-asset pause.** It is the one place the platform acts on a named asset. The rule: it is used only where an asset's own code is shown to take, freeze or block what vaults hold, or to break a close-out. It is never used for an asset's price, its reputation, or at anyone's request. Exits stay open. Each use is published with its reason. Lifting it goes through the delayed route.
4. **The steps where a user takes on an asset show the same facts as the check page.** One facts panel, used by the check page, the standing consent for a pair, the first posting of an asset (#3875) and a rental listing or acceptance (#3772). One component, so the four cannot differ.
5. **Names in rental listings are cleaned** with the label cleaner used for tokens, shown as the collection's own claim, with the address beside the name and a link to the check page. No public ranking of collections is read, so no copied-name line is shown for a collection. The page says a name proves nothing.
6. **The check page keeps no result** (section 4).

# Part II. Technical design

## 9. The shared facts library

One module in `@vaipakam/lib`, `assetFacts`, of pure functions over a read client:

- `readTokenFacts(client, diamond, asset)`: the reads of section 4's token table, made at one block, returning each row as a value or as `notRead` with the reason. The "what holds it there" row is a pure function of the price status and the three tiers, with its own table of cases in the tests.
- `readCollectionFacts(client, diamond, collection, tokenId?)`: the standard and the user role through ERC-165 (`0xad092b5c` for the user role), and for a token id the owner, `getVaultOwner` and the vault's three reads.
- The issuer powers rows come from the shared check functions of #3433 (`issuerPowerChecks`), called with the same client and block. This module does not copy them.
- Nothing in the module writes, stores or calls the index. The rankings read stays where it is and is passed in.

The app's existing trust line, issuer powers line and NFT standard read stay as they are and are composed by the panel. Where one of them duplicates a read of this module, the builder moves the read here and leaves one copy.

## 10. The app

- **A page `/check`** in the app the kit's links open, reading `?chain=<id>&address=<0x…>` and an optional `&tokenId=`. It asks for no wallet and reads through the app's read-only client. An address that is not a contract, or a network the app does not serve, is answered by name.
- **The `AssetFacts` panel** renders the rows of section 4 from the library. The check page shows it whole. The consent steps of guard 4 show the same panel, collapsed to its headline rows with the rest one tap away.
- **No result leaves the page.** No request that writes, no storage of a reading, no share button, static page metadata, and the app's frame policy unchanged (`frame-ancestors` lists the app itself and the wallet app origins of `safeOrigins.ts`, nothing else), pinned by a test.
- **The stored reading** is read from the index's issuer powers route where the index holds one, and compared check by check.
- Copy for every row goes through the app's copy file and the wording checks.

## 11. The kit package

- `LendRequest` gains an optional `collateral` (an address). The lend link carries it as `collateral=<0x…>`, and the app's `/kit` page fills the collateral of the lending form with it.
- A fourth action, `list`: `{ action: 'list', chainId, asset, tokenId, quantity?, integrator? }`, opening the app's "list for rent" form with the item filled in. Its share rule is `no-fee`.
- Both are additions inside link version 1. The app and the package parse with the same function, so they change together, and the field-coverage test of the `/kit` page fails until each new field has a home.
- **Rental reading code** as a second entry of the package: `rentalsOfCollection`, `mayUse(collection, tokenId, user)` from the feed, and `mayUseOnChain` that reads the ERC-721 case from the chain and folds `VaultRentalUpdated` for ERC-1155. It reads only. It carries the Diamond address per network from the published deployments, never from a caller's input alone.
- The README gains the two links, the rental reader and the written-out contract steps of section 6.
- Publishing the package to a registry needs an account step by the owner. Until then the guide documents the link, which needs no package.

## 12. The index

**A table of rental rights,** rebuilt from chain events: one row per rental, keyed by network and loan id, with the collection, the token id, the owner, the recorded user, the expiry, the quantity, and the block and log position of the last update. A handler for `VaultRentalUpdated` writes it. A clearing sets the row's quantity to zero and keeps the row. The table is classified as rebuilt from chain events, so a reorganisation and a new deployment clear and rebuild it like the loan tables.

**Two routes in the public data feed** (`/public/v1`, with #3774's rules for the catalogue, the limit, the parameter list and the field-name test):

- `GET /public/v1/rentals/by-collection?chainId=&collection=[&tokenId=][&cursor=]`: each active rental's token id, user, expiry, quantity, rental id and owner, with the block the answer is true at. Active means not cleared and not past its expiry at that block's time.
- `GET /public/v1/rentals/may-use?chainId=&collection=&user=[&tokenId=]`: the active rentals in one collection that name one address as user. This read takes an address, and this design names it as public for that reason: it always carries a collection, and no route lists an address's rentals across collections or lists the addresses that rent.

Both answer from the one table. Neither returns anything the app keeps privately for a wallet.

**The figure rules of guard 1** are applied in the reads behind the feed's totals and rates, the rate curve and the analytics totals: a priced-only value total with the count left out, own-unit lines for assets with no usable price, a separate line for one-address loans and rentals, and a "leaves out" statement in each answer. Whether an asset has a usable price is taken from the same read the index already uses to value a row. Where that read is missing for an asset, the asset counts as having no usable price.

## 13. The site

- Four routes under `/for-projects`, with content beside the user guides, in English first and then the nine other languages, and included in the prerender, the sitemap and the plain-text index like the guides.
- One component renders the fixed statement, so every page carries the same sentence in every language.
- Each claim on a page has a row in the claim ledger of the site wording build, naming the feature it rests on: rentals, the check page, each link kind, each feed route, the access category, the integrator registry, and the non-zero access wait. A page is published when its rows are true.
- Links to the check page and to the kit's link formats use the app's origin from the site's existing configuration.

## 14. The per-asset pause rule

Written into the incident runbook, the admin keys and pause guide, and the threat model by the governance thread, in the words of guard 3. Where the runbook already names a use of the per-asset pause that the rule does not cover, the governance thread reports it before changing either. Publication of each use is a public note with the asset, the time and the reason. The contract's event carries no reason and is not changed.

## 15. Tests

1. The facts library: each row for a priced token at each tier, a token with no usable price, a token whose sources disagree, a paused asset, and a failed read of each row (the row says "not read", the others still render). The "what holds it there" table case by case.
2. Collection facts: ERC-721 with and without the user role, ERC-1155, a contract that answers ERC-165 falsely or reverts, an item in a platform vault with a live rental, with an expired one, and an item in a plain wallet.
3. The check page: opens with no wallet; a second open of the same link reads again; no request writes; no finding in the page metadata; the frame policy lists no origin beyond today's; the stored reading's block and a differing check are shown.
4. The four steps of guard 4 render the same panel from the same reads.
5. The kit: the two new link forms round-trip through the builder and the parser; a link with an unknown field is refused by name; the field-coverage test covers the new fields; the share rule table has a row for every action.
6. The rental table: an opening, a daily update, a clearing, two concurrent ERC-1155 rentals of one token, a reorganisation that removes an update, and an expiry with no clearing event (the row stops being active by time).
7. The feed routes: the route list, parameters and field names pinned; a parameter not listed is refused; `may-use` without a collection is refused; the table-source test accepts the rental table.
8. The reference code agrees with the feed and with the chain for each case of test 6.
9. The figure rules: a total with an unpriced asset present, a one-address loan and rental, and the "leaves out" text.
10. The site: the fixed statement is present on each page in each language; a claim whose ledger row is false fails the build; the word check passes.

## 16. What is built, by whom, and in what order

| Part | Where | Card |
| --- | --- | --- |
| The figure rules of guard 1 | The index, with #3774 and #3751 | #3879 |
| The per-asset pause rule | Runbook, pause guide, threat model | #3880 |
| The facts library, the check page and the facts panel at the consent steps | `@vaipakam/lib` and the app, after the issuer powers store and #3875 | #3881 |
| The rental rights table and the two feed routes | The index, with #3774 | #3882 |
| The two new links, the rental reading code and the kit's documentation | The kit package and the app's `/kit` page | #3883 |
| The four guide pages and their translations | The site, after the site wording build's word check and claim ledger | #3884 |
| Contracts | None | |

**Order.** The figure rules and the pause rule first, because they are guards. Then the check page and the rental table with its routes. Then the kit's additions. The guide pages last, each when the parts it describes work.

## 17. Alternatives considered

- **Two kits, one for tokens and one for collections.** Rejected: a game or a marketplace often has both, and the rules are the same.
- **A separate developer site.** Rejected for now: a second site to keep true.
- **A report run on the platform's servers and stored per asset.** Rejected: a stored report becomes a certificate that a project shows around. The same reason rules out a score, a badge and an embeddable result.
- **A check page only for a connected wallet.** Rejected: a project team and its users should be able to read it without connecting anything.
- **A view on the contracts that names the pool test holding a token at its tier.** Not built now: it is a contract change for a row the page can state honestly without it. It can be carded later if projects ask which test they fail.
- **Reading rentals by collection from the loan rows the index already holds.** Rejected: the recorded user and expiry are what a project must honour, and only the event states them.
- **A small reader contract outside the Diamond for the ERC-721 cases.** Not built now: the two reads it would wrap are short, and the written steps cover them. It can be carded later if projects that enforce on chain ask for one address to call.
- **A per-user read on the vault for ERC-1155 rentals.** Not built now: the vault's code has no room. It can be considered when the vault's code is split for the Stage B3 work.
- **An index of rentals by renter kept on chain.** Rejected: a write on every rental step for a question the event answers.
- **A feed route listing everything an address rents.** Rejected: the feed lists no addresses by activity. The `may-use` route is tied to one collection.
- **A wrapped rental token issued by the platform, a hosted marketplace per project, a rental royalty.** Rejected: the vault is already the adapter, the kit's links already keep users on a project's site up to the review, and fees stay as they are.

## 18. Recommendation

Build the kit as six pieces in the order of section 16, with no contract change. Every piece is a display of facts that already exist or a documented way to read them.

## 19. What is not built

A listing programme, an application form or a "verified" mark. A score or a rating. Launch tools of any kind. Reward campaigns in a project's token hosted by the platform. Loss cover or a bond posted by an issuer. A featured or partner section, logos or promoted placement. A fee, a royalty or a share for one project. A power for a project that an ordinary user lacks.

## 20. Open items for the builders to raise, not decide silently

- Which read the index uses today to decide that an asset has a usable price, and whether it can state "no usable price" for every asset in a total.
- Whether the app's read-only client can run every issuer powers check the check page needs without a wallet, and what the page says for a check it cannot run.
- The exact form of the "list for rent" hand-off for an ERC-1155 quantity.
- Any place where the site's configuration does not yet know the app's origin per network.
- Any existing use of the per-asset pause in the runbook that guard 3's rule would forbid.
