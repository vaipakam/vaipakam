# The project kit: for token projects and NFT rental projects

**Status:** functional and technical design, 2026-11-22. Approved in outline by the owner on 2026-11-22: one kit with a guide on the site, and a track for NFT rental beside the token track. The kit itself changes no contract. Writing the pause rule down showed one contract change, #3887. The design differs from the approved outline in one place: the per-asset pause rule has a second reason (guard 3 in section 8), because the incident runbook already relies on it.

**Related:** `FeaturesOverExistingPartsDesign.md` sections 6 (renting access, #3772), 7 (the embedded lending kit, #3773) and 8 (the public data feed, #3774), `IntegratorFeeShareDesign.md` section 5, `ProgressiveRiskAccessDesign.md`, the issuer powers check (#3433, #3875, #3876) and the launch list (#3824).

A project that wants its token or its NFT collection used on the platform gets a **project kit**: a guide on the site, one page of facts about any asset, ready-made links into the platform's own forms, and one documented way to read who may use a rented item. The kit is built from parts that exist. It adds no listing, no mark of approval, no score, no launch feature, no campaign and no fee.

## 1. What the scout found

Read in the code at main `bb16284219`.

**For a token**

- There is no listing step. A token's standing is read on chain: `OracleFacet.getAssetPriceStatus` says whether it has a usable price (priced, no price available, or a price its sources disagree on), `getLiquidityTier` gives the depth tier measured now (0 to 3), `ConfigFacet.getKeeperTier` gives the tier the keeper relay has confirmed, and `getEffectiveLiquidityTier` gives the lower of the two, which is what a new loan uses. A newly priced asset opens at tier 1 until the relay confirms more, and the relay can only lower a tier.
- No read says which pool test held a token at its tier. The depth test and the two price-agreement tests run inside one private function and only the tier comes out.
- Three reads decide three things. `checkLiquidity` decides valuation, the tier decides a tiered asset's opening limit, and the access level decides which vaults may use an asset. A liquid asset can sit at tier 0: it is valued at its price, its opening limit comes from its own ceiling and the health factor floor, and it needs the custom access level. A numeraire asset and the wrapped native asset are open to every vault at any tier.
- An asset that is not liquid (no usable price, or no pool past the liquidity floor) is valued at zero. It can be used only in a hand-made offer, where each party has raised its own access level and holds a standing consent for that exact pair, past a wait (`ProgressiveRiskAccessDesign.md`). Auto-lend slots and the instant market refuse it.
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
| How the platform treats any token | There is no listing. How standing is read (price, depth tier, the relay's confirmation). How an asset is valued, what limit a loan against it opens at and which vaults may use it, as three separate reads. What an asset that is not liquid can and cannot do. What the platform never does for a project. |
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
| Counts as liquid | Liquid: it is valued at its price in a loan's checks. Not liquid: it is valued at zero, a loan with it needs each party's standing consent, and Auto-lend slots and the instant market do not take it | `checkLiquidity` |
| Tier now | The tier measured on chain, the tier the relay has confirmed, and the tier a new loan uses, which is the lower | `getLiquidityTier`, `getKeeperTier`, `getEffectiveLiquidityTier` |
| What holds it there | One of: no usable price; not liquid, because no pool passed the liquidity floor; liquid, but no pool passed the first tier's depth test; the relay has not confirmed a higher tier; nothing, it is at the top tier | Worked out from the three rows above |
| Opening limit | The most a new loan may borrow against it now, and whether that comes from its tier or, for a liquid asset with no tier, from the asset's own ceiling and the health factor floor. Not shown for an asset that is not liquid | `getConcentration` (the cap in force and the regime cap) |
| Access category | Which access setting a vault needs to use it: every vault, the broad setting, or the custom setting. A liquid asset at tier 0 needs the custom setting. A numeraire asset and the wrapped native asset are open to every vault at any tier | `pairRequiredRiskLevel`, asked for the asset against the wrapped native asset |
| New positions | Open, or paused for this asset (every close-out stays open; a sale waits for the pause to lift) | `isAssetPaused` |
| Share already pledged | The concentration reading and whether it lowers the opening limit now | `getConcentration` |
| Issuer powers | Each check as found, not found or could not be told | The shared check (#3433), run in the reader's browser |
| Public lists | Each list's rank for this address and the time of the list, or "not ranked", with the existing possible-copy line | The index's rankings read |

Three different reads decide three different things, and the page keeps them apart: liquidity decides how the asset is valued, the tier decides the opening limit of a tiered asset, and the access category decides which vaults may use it. A tier of 0 alone does not say an asset is valued at zero, because a liquid asset can sit at tier 0. No statement on the page is drawn from the tier where another read decides it.

The "what holds it there" row says only what the reads support. Where the tier is 0 with a usable price, the row says which of the two cases the liquidity read shows, and that the platform's read does not say which pool or which test failed.

**For a collection**

| Row | What it says | Source |
| --- | --- | --- |
| The collection | Its name as its own code states it, cleaned, marked as its own claim | The collection |
| Standard | ERC-721 or ERC-1155, or "could not be told" | ERC-165 |
| How a rental is recorded | "Carries a user role: a rental sets the user on the item, and the owner's vault records it too", or "No user role: recorded by the owner's vault only", or for ERC-1155 "Recorded by the owner's vault, one record per rental" | ERC-165, fixed text |
| As collateral | Valued at zero. A loan against it needs each party's standing consent | Fixed text |
| Issuer powers | The checks that apply to this standard | The shared check |
| One ERC-721 item (optional token id) | Its owner now. If the owner is a vault of the platform: whose vault it is, the user recorded and until when | The collection's owner read, `getVaultOwner`, the vault's reads |
| One ERC-1155 item (optional token id) | An ERC-1155 item has no single owner, so nothing is read from the collection alone. The page lists the active rentals of that item from the rental routes of section 12: each owner's vault, the user, the units and the end time, with the block. With an optional holder address in the link, it also reads that holder's vault on chain: the units rented out and the earliest end time | The rental feed, and for a named holder `getVaultOwner` and the vault's reads |

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
   - The index reads no price, and none is added for these figures. Its figures therefore carry no value total: each asset's amounts are given in that asset's own units, and the answer says "no value total; each asset in its own units". A surface that has its own price read and shows a value total covers priced assets only, says so, gives the number of positions left out, and shows an asset with no usable price in its own units on its own line.
   - No figure is a mean across assets or across terms. A rate figure is given per lending asset and per term range. The single mean rate the loan statistics route returns today is removed, from that route and from the feed's fields.
   - A loan or a rental opened with one address on both sides is left out of rate and rent figures and counted on its own line. The test is the two parties named when the loan was opened, because the rate was set then. A later sale or change of holder moves a loan neither into the figures nor out of them. A figure taken from a sale or a takeover applies the same test to that event's own two parties. The rule sees one address on both sides only. It cannot see two wallets of one person, and the figure says so.
   - Each figure states its block and what it leaves out.
2. **The access wait is never zero on a mainnet** (#3266, with the deploy check of #3717). The guide's token page does not ship before #3266 is done.
3. **A written rule for the per-asset pause.** It is the one place the platform acts on a named asset. The rule:
   - It is used for one of two reasons only. The first: the asset's own code is shown to take, freeze or block what vaults hold, or to break a close-out. The second: the platform's own reading of the asset (its price sources, its liquidity reading, or a limit taken from an outside reading) is shown to be wrong or under manipulation, so that new positions would open on false numbers. A pause for the second reason lasts while the reading is wrong. After the handover the per-asset pause is the only step that acts on one asset at once, which is why the second reason is in the rule: without it a faulty reading of one asset could be answered at once only by pausing the whole platform.
   - It is never used because an asset's market price rose or fell, for an asset's reputation or its issuer's conduct, or at anyone's request.
   - The rule says what the pause stops as the code has it. It stops new positions in the asset. A lender's exit by sale is one of them, because a sale opens the position for a buyer, so a sale waits for the pause to lift. Every close-out stays open: repayment, claims, withdrawal, default, liquidation, cancelling an offer and taking capital out of a slot.
   - Steps that only add the borrower's own backing to an open loan or pay it down are to stay open as well: adding collateral, funding a loan's reserves, and the standing top-up, interest payment and repayment at the due date. The code refuses or skips them under the pause today. #3887 changes that, and until it is built the written rule says what the code does.
   - Each use is published with its reason. Lifting it is the admin's or the unpauser's step, which after the handover goes through the delayed route. Before the handover the admin lifts it directly, and the rule says so.
4. **The steps where a user takes on an asset show the same facts as the check page.** One facts panel, used by the check page, the standing consent for a pair, the first posting of an asset (#3875) and a rental listing or acceptance (#3772). One component, so the four cannot differ.
5. **Names in rental listings are cleaned** with the label cleaner used for tokens, shown as the collection's own claim, with the address beside the name and a link to the check page. No public ranking of collections is read, so no copied-name line is shown for a collection. The page says a name proves nothing.
6. **The check page keeps no result** (section 4).

# Part II. Technical design

## 9. The shared facts library

One module in `@vaipakam/lib`, `assetFacts`, of pure functions over a read client:

- `readTokenFacts(client, diamond, asset)`: the reads of section 4's token table, made at one block, returning each row as a value or as `notRead` with the reason. The "what holds it there" row is a pure function of the price status, the liquidity read and the three tiers, with its own table of cases in the tests. The valuation statement is a function of the liquidity read only, the opening limit of the concentration read only, and the access category of the access read only.
- `readCollectionFacts(client, diamond, collection, tokenId?, holder?)`: the standard and the user role through ERC-165 (`0xad092b5c` for the user role). For an ERC-721 token id: the owner, `getVaultOwner` and the vault's reads. For an ERC-1155 token id the module reads nothing from the collection, because that standard has no owner read for an item. With a `holder`, it reads that holder's vault for the item's rented units and earliest end time. The list of an ERC-1155 item's active rentals comes from the rental feed and is passed in by the page, like the rankings read.
- The issuer powers rows come from the shared check functions of #3433 (`issuerPowerChecks`), called with the same client and block. This module does not copy them.
- Nothing in the module writes, stores or calls the index. The rankings read stays where it is and is passed in.

The app's existing trust line, issuer powers line and NFT standard read stay as they are and are composed by the panel. Where one of them duplicates a read of this module, the builder moves the read here and leaves one copy.

## 10. The app

- **A page `/check`** in the app the kit's links open, reading `?chain=<id>&address=<0x…>`, an optional `&tokenId=`, and for an ERC-1155 item an optional `&holder=<0x…>`. It asks for no wallet and reads through the app's read-only client. An address that is not a contract, or a network the app does not serve, is answered by name.
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
- `GET /public/v1/rentals/may-use?chainId=&collection=&user=[&tokenId=]`: the active rentals in one collection that name one address as user.

**Why both routes are public.** They return only what the chain already makes public. Every row comes from a `VaultRentalUpdated` event, and an ERC-721 renter can also be read from the lender's vault. The routes are a convenience over that data and add nothing to it. This design does not claim that they hide who rents: the by-collection route lists every renter of a collection, and anyone can read every collection, or the events themselves, and work out everything one address rents.

**What the routes never do.** They never join anything the platform keeps privately for a wallet: an alert link, a subscription, an app setting, or anything else that is not rebuilt from chain events. Both answer from the one rental table and from nothing else, and a test holds that (section 15, test 7). Each takes exactly one collection, and `may-use` exactly one address. Neither takes a list of addresses or a wildcard.

**The figure rules of guard 1** are applied in the reads behind the feed's totals and rates, the loan statistics, the offer statistics, the rate candles and the rate curve. The index reads no price today and gets no price read for this, so each of those answers gives amounts per asset in the asset's own units with the "no value total" line. The mean rate field leaves the loan statistics route. Loans opened with one address on both sides leave the rate figures and the rate candles and are counted on their own line. The opening parties are taken from the loan's opening event and stored with the loan row, so a later change of lender or borrower does not change the answer. The rental table of this section follows the same rule when a rent figure is first built from it. Each answer carries its "leaves out" statement.

## 13. The site

- Four routes under `/for-projects`, with content beside the user guides, in English first and then the nine other languages, and included in the prerender, the sitemap and the plain-text index like the guides.
- One component renders the fixed statement, so every page carries the same sentence in every language.
- The guide's rental pages and the site's privacy page say plainly that renting is public on chain, like any other wallet activity: the collection, the item, the renter's address and the end time can be read by anyone, from the chain and from the public data feed.
- The word check and the claim ledger are built by #3886, before or together with these pages.
- Each claim on a page has a row in the claim ledger of the site wording build, naming the feature it rests on: rentals, the check page, each link kind, each feed route, the access category, the integrator registry, and the non-zero access wait. A page is published when its rows are true.
- Links to the check page and to the kit's link formats use the app's origin from the site's existing configuration.

## 14. The per-asset pause rule

Written into the incident runbook, the admin keys and pause guide, and the threat model by the governance thread, in the words of guard 3. Publication of each use is a public note with the asset, the time and the reason. The contract's event carries no reason and is not changed.

What the governance thread found on main, and what is done with each:

- The incident runbook offers the per-asset pause as the step that acts at once when the narrower switches are behind the delay, for incidents that include a wrong price reading and a manipulated outside reading. That use is kept, as the rule's second reason. The runbook's note is rewritten to name the two reasons and nothing wider.
- The admin keys and pause guide calls it a "reserve pause / blacklist". Both words go. It is "the per-asset pause", with a pointer to the rule. It is not a list of refused assets, and "reserve" has one meaning on this platform.
- Older design documents call it a way to remove an asset or to exclude a bad actor. They stay as records. Each gets one line at that place saying the rule replaces that reading: the pause is never used for an asset's reputation or for anyone's conduct.
- One older design lists it as a step that stops a liquidation route. The runbook already corrects this, because the pause does not stop a liquidation. That design gets a pointer to the correction.
- The pause refuses a lender's sale and, today, the steps that add backing or pay a loan down. Guard 3 states the first as the rule and #3887 opens the second.

## 15. Tests

1. The facts library: each row for a priced token at each tier, a liquid token at tier 0 (valued at its price, opening limit from the regime cap, custom access), a numeraire asset at tier 0 (open to every vault), a token with no usable price, a token whose sources disagree, a paused asset, and a failed read of each row (the row says "not read", the others still render). The "what holds it there" table case by case.
2. Collection facts: ERC-721 with and without the user role, ERC-1155 with no holder given (no owner read is attempted), with a holder given, and with the rental feed unavailable (the list says "not read"), a contract that answers ERC-165 falsely or reverts, an item in a platform vault with a live rental, with an expired one, and an item in a plain wallet.
3. The check page: opens with no wallet; a second open of the same link reads again; no request writes; no finding in the page metadata; the frame policy lists no origin beyond today's; the stored reading's block and a differing check are shown.
4. The four steps of guard 4 render the same panel from the same reads.
5. The kit: the two new link forms round-trip through the builder and the parser; a link with an unknown field is refused by name; the field-coverage test covers the new fields; the share rule table has a row for every action.
6. The rental table: an opening, a daily update, a clearing, two concurrent ERC-1155 rentals of one token, a reorganisation that removes an update, and an expiry with no clearing event (the row stops being active by time).
7. The feed routes: the route list, parameters and field names pinned; a parameter not listed is refused; `may-use` without a collection or without a user is refused, and so is a list of addresses or a wildcard in either parameter; the table-source test allows the event-built rental table behind both routes and nothing else, so a join to a table that holds anything kept privately for a wallet fails the build.
8. The reference code agrees with the feed and with the chain for each case of test 6.
9. The figure rules: amounts per asset in own units with the "no value total" line; no mean-rate field in the loan statistics or the feed; a loan opened with one address on both sides is out of the rate figures and the candles and on its own line; a loan sold to its own borrower after opening stays in; a loan opened one-address and later sold stays out; the "leaves out" text.
10. The site: the fixed statement is present on each page in each language; a claim whose ledger row is false fails the build; the word check passes; the "renting is public on chain" statement is present on the rental pages and the privacy page.

## 16. What is built, by whom, and in what order

| Part | Where | Card |
| --- | --- | --- |
| The figure rules of guard 1 | The index, with #3774 and #3751 | #3879 |
| The per-asset pause rule | Runbook, pause guide, threat model | #3880 |
| Steps that add backing or pay a loan down stay open under the per-asset pause | Contracts, with the batch | #3887 |
| The facts library, the check page and the facts panel at the consent steps | `@vaipakam/lib` and the app, after the issuer powers store and #3875 | #3881 |
| The rental rights table and the two feed routes | The index, with #3774 | #3882 |
| The two new links, the rental reading code and the kit's documentation | The kit package and the app's `/kit` page | #3883 |
| The site's word check and claim ledger | The site's typecheck | #3886 |
| The four guide pages and their translations | The site, after or together with #3886 | #3884 |
| Contracts | None for the kit itself. #3887 is a change the pause rule showed to be needed. | |

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
- **A feed route listing everything an address rents across collections.** Not built: a project asks about its own collection, so nothing needs it. This is not a privacy line. The same facts are public in the chain's events and anyone can assemble that list.
- **Keeping the rental routes behind a key or out of the public feed.** Rejected: it would suggest the data is private when the chain publishes it, and it would stand between a project and a read it needs.
- **A per-asset pause rule with the first reason only.** Rejected: after the handover the narrower switches wait for the delay, so a faulty reading of one asset could be answered at once only by pausing the whole platform.
- **A wrapped rental token issued by the platform, a hosted marketplace per project, a rental royalty.** Rejected: the vault is already the adapter, the kit's links already keep users on a project's site up to the review, and fees stay as they are.

## 18. Recommendation

Build the kit as the pieces in the order of section 16. The kit itself changes no contract; #3887 is the one contract change, and it comes from writing the pause rule down. Every piece is a display of facts that already exist or a documented way to read them.

## 19. What is not built

A listing programme, an application form or a "verified" mark. A score or a rating. Launch tools of any kind. Reward campaigns in a project's token hosted by the platform. Loss cover or a bond posted by an issuer. A featured or partner section, logos or promoted placement. A fee, a royalty or a share for one project. A power for a project that an ordinary user lacks.

## 20. Open items for the builders to raise, not decide silently

- Answered by the builder's scout: the index reads no price, so its figures carry no value total (guard 1).
- Whether the app's read-only client can run every issuer powers check the check page needs without a wallet, and what the page says for a check it cannot run.
- The exact form of the "list for rent" hand-off for an ERC-1155 quantity.
- Any place where the site's configuration does not yet know the app's origin per network.
- Answered by the governance thread's scout: see section 14.
