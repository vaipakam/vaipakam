# ToDo Tasks

## Instructions

- Look into the tasks with unticked checkbox and need to work on it
- Always ask if there is a better apporach and if anything need to be discussed
- Once completed the task, tick the checkbox and move it after the last task with unticked checkbox (just before the tasks with ticked checkbox starts)

---

- [ ] Defer: Group languages based on the locality of that continent and display only those group belonging to that continent. Note: exception is for japanese can be displayed together with western countries too
- [ ] Borrower can pay interest at any time but it is mandatory to pay complete interest at the end of 1 (or each) year completion, the cumulative paid interest for that year should be equal or more than a full year accured interest, otherwise system will use collateral to pay interst to lender after grace period of 2 weeks (buy selling the required collateral asset to but lending asset), this may incur higher fees and may also drastically change the HF/LTV and may triger liquidation too.
- [ ] For pyth, if we provide only price feed for ETH/USD, ETH/EUR, ETH/JPY, ETH/XAU and all other asset can be checked with respect to ETH right, so that it is not required for us to configure all the asset price feed right?
- [ ] tooltips provided inside the list of offers and loans in both dashboard page and offer book is not fully visible, may need to wrap it.

- [ ] in card `Lender Yield-Fee Discount` in loan view page, provide `consent not given in dashboard` kind of info, so that users will know that they need to enable `discount tier` by providing consent to use the staked / deposited VPFI in their escrow.

- [ ] Bring the filter `status` inside the card `Your Offers` in dashboard page, just before `new offer` button

- [ ] Collateral asset and amount is not shown in the list of loans in the `Your Loans` card in the dashboard page

- [ ] From claim center there should be a link to respective loan view page from the Loan ID that is displayed in the claim center page

- [ ] Change the icons for Loans as lender and loans as borrower, it looks nice but we need to either have different icon or need to remove the icon, because the icon for `as lender` shows green and trending higher, but for `as borrower` shows amber colour and graph trending down (which is not good to look from borrower perspective)

- [ ] Where ever we show redacted address, we should provide an option to copy the full address with animation. the one in the list of assets in the card `Asset-wise Breakdown` in Analytics page.

- [ ] Provide notification, not only on HF health, but also on all other major transactions based on user config. Also mention that notification also costs user (if any)

- [ ] Provide colour gradients in the left side panel inside the app and also in each and every card in the app
      Also the cards in Buy VPI page, NFT Veifier page and Analytics page.

- [ ] Check if all the links in the page is working fine including the links in footer and in all other places

- [ ] Need to have a separate ID for each reported error on github from our website, so that we can cross check with that id in our system to see if that error really come from website and thats the error that it really said or is it just manually created issue post or any thing in the error has been modified except for the section that says `<!-- Please describe in your own words what you were trying to do. -->` from user. so that on real dispute if any we can cross check it from our end. hope in defi no such things are supported, but still we need to have things in place.

- [ ] Bring the

```
Data rights (GDPR / CCPA)
Download my data and Delete my data
```

in a separate page inside the app and provide a link in the left side panel, provide download and clear button in Report issue (diagnostics. because the ) drawer Delete my data deletes even the cookies and all other related data. Just caution the user, before deleting my data, what happens after deleting it.

- [ ] Move Terms of service and privacy policy to required folder inside /frontend

In "translation pending" notice, say like this is available only in English. don't say it may be avialble in future update.

Center the connect wallet inside the button which is on top bar, so that in mobile it matches launch app button appearance

- [ ] In mobile inside app in top bar, the chain selector is appearing near the connect wallet button even before the wallet got connected, I hope that chain selector is not required at all, as of now we already combined with wallet connect button, what do you say?

- [ ] Is it possible to ensure even for cross chain that only after the required ETH received in treasury, the equivalent amount of VPFI will be minted and send to the same wallet from where the ETH has been came from?

---

- [x] Update frontend/wrangler.jsonc file to have all required en.local variables in it, so that before deployment we will run a script to update these variables in cloudflare, add that in appropriate runnook, because not all the variables are baked into VITE during wrangler run deploy, so it is the required step. All while deploying the contract (or immediately after contract deployment) it self, script or a .sh file should update values in frontend/wrangler.jsonc file, what do you say? Let me know if there is a better approach.
- [x] The new offer created globally should appear automatically in offer book, based on the sort that we have already defined, hope the sort is not customisable by user, in offer book page.
- [x] we need to provide slider to adjust the lending amount and collateral amount. also based on it, we should also show HF/LTV visually with animation, this need to be shown during offer creation in advanced mode, like the one that is shown in loan view page in `Liquidation-price projection` card, inside card `Collateral & Risk`, enhace for offer creation if possible.
- [x] Is there any contract that went beyond max size limit that has been reported by anvil, don't we need to fix it?
- [x] Got the below message while reporting a bug on github (`Whoa there! Your request URL is too long.`) — trim unnecessary details and/or cut events from 15+5 to 10+2; if it exceeds the threshold of x characters, x needs to be configurable.
- [x] Need to set a pause policy in such a way that, after abnormal activity or due to any circumstances, if the system has to be paused and if it is not done within 15 min, can it be paused automatically?
- [x] Make the 15 min auto-pause by bot admin-configurable (later by governance), flag for auto-pause and a config for 15 min (to change duration); 15 min reasonable? — landed at 30 min default, governance-tunable within [5 min, 2 h], no enable/disable flag (always-armed safety net), separate WATCHER_ROLE.
- [x] Provide multiple language
- [x] we may also need to provide permission matching for bots to find two offers with matching conditions between lender offer and borrwer offer with same lending and borrowing asset type. and we may need to get max and min for duration, lending asset amount and borrowing asset amount from both lender and borrower during offer creation. together with with lender specifying min collateral amount (to have healthy HF and LTV) as he is the risk taker. Once these are all available, bots can match the offers based on conditions and the loan will be active. any way both users (lender and borrower) have provided consent during the offer creation itself. we should HF/LTV for worst case case condition based on max / min lending / collateral asset amount during offer creation, we may need to provide sliders and make things easy to understand. also system should decide on how much min collateral asset amount (minCollateralAmount) will be allowed based on lender max lending asset amount and provide him option to set minimum collateral amount required, only above the system set minCollateralAmount, also providing option for max collateral amount (contract should revert if min collateral is provided by lender is below minCollateralAmount). Like wise for borrower, system need to set max lending amount (maxLendingAmount) based on min collateral amount beyond which the borrower can't move the slider to ask for more (contract should revert if max lending amount is provided by borrower is above maxLendingAmount), but borrower can still set max lending amount below the system set maxLendingAmount, also borrower can set minimum lending asset amount he needs. so the current values without range will look like only a maximum lending amount available and minimum collateral amount needed by lender and likewise for borrower, it is minimum lending amount needed and maximum collateral amount available. loan fields cannot have min and max values, only offers can have min and max values for lending asset amount, collateral asset amount, duration and interest. we can put these under advanced mode in front end. What do you say?
- [x] update the release notes in docs/ReleaseNotes-2026-04-25.md and create new relase notes for today
- [x] inside the app, When the 3 line icon is clicked on the left top, the expanded left side panel only shows `icon only logo`, but it should show full horizontal logo
- [x] the create offer button and accept offer button need to be enabled only after clicking the checkbox for `I have read and agree to the Risk Disclosures above.`
- [x] The error that is shown to the user may be short, but when user clicks on report to github page, the error information should atleat have second level of verbose information in it.
