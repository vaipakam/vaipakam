# Running your own agent

You can let another address, a **keeper**, carry out chosen steps for your positions. The keeper can be a program you run yourself. This page explains what a keeper may do, what it can never do, and where to find the open-source reference keeper.

Nothing on this page promises a result or a rate. A keeper only carries out steps you could take yourself, inside limits you set.

<a id="agent.approve"></a>

## Approving a keeper

On the app's Keeper Settings, you can approve up to five keeper addresses and give each one only the actions you choose. You can change a keeper's actions or remove it at any time. While the platform is paused, approving or removing a keeper waits until it resumes.

A keeper can act for you only when all of these hold:

1. the keeper is approved, with that action;
2. your keeper access is on (one switch that turns every keeper off without removing any);
3. for an action on one loan, you have switched keeper actions on for that loan and that keeper;
4. the platform has not paused keepers;
5. your account has not been replaced or recovered (a keeper cannot act for a replaced account).

A keeper acts only inside the limits you set on a loan, an offer, an auto-lend slot or a standing instruction. It never chooses a price of its own.

<a id="agent.never"></a>

## What a keeper can never do

- **Withdraw.** No keeper action withdraws from your vault.
- **Take anything.** A keeper never becomes the lender or the borrower, and no funds, collateral or claim are routed to it from your position.
- **Claim.** Claims belong to whoever holds the position.
- **Add collateral or partly repay** for you. These stay with you.
- **Unlock** a protected account, or release a payout from one.

<a id="agent.actions"></a>

## The actions you can give a keeper

| Action | What it lets the keeper do | What it never lets it do | In the public bot |
| --- | --- | --- | --- |
| Complete a loan sale | Finish the sale of your lender position once a buyer has accepted your listing | Choose the buyer or change the price you listed | Not yet |
| Complete an offset | Finish your early close-out by offset once its new offer is accepted | Change the offer's terms | Not yet |
| Start an early withdrawal | List your lender position for sale | List at a rate above the loan's own rate | Not yet |
| Start an early close-out | Start the early close-out of your borrowing | Route anything to the keeper | Not yet |
| Extend in place | Extend a loan within the limits both its holders consented to | Go past either holder's limits | Yes |
| Fill a keeper-only standing offer | Fill your standing lending offer when you made it keeper-only | Fill it outside its rate, size, term and loan-to-value limits | Not yet |
| Roll repaid loans | Put the repaid amount of a standing offer's loan back into that offer | Send it anywhere else | Not yet |
| Lock a protected account | Lock your protected account, for example on your Telegram LOCK command | Unlock it, or release a payout | Not yet |

Liquidating a loan whose health has fallen too low, and closing a loan after its grace period, are open to anyone and need no approval.

<a id="agent.reference"></a>

## The reference keeper

The platform's reference keeper is open source: [vaipakam-keeper-bot](https://github.com/vaipakam/vaipakam-keeper-bot). It is a Node.js program you run with your own key and your own network connection. Its README has the steps to set it up.

What it runs: the steps anyone may run. It liquidates loans whose health has fallen too low, matches offers that can be matched, and extends loans in place where both holders consented. These need no keeper approval from you.

What it does not run yet: the actions a wallet approves for its own keeper, such as completing a sale or an offset, or starting an early withdrawal or an early close-out. Any approved keeper can carry these out on-chain today, inside the limits in the table above; the public bot does not do so yet, and no date is set. The table's last column says which actions the public bot runs. To have a keeper carry out the others for you, run a keeper that does, approved for exactly those actions.

<a id="agent.keys"></a>

## Your keeper's key

Run a keeper with a key that holds only enough to pay for its transactions. A keeper's key cannot move your funds, but someone who takes it can act with whatever actions you gave that keeper until you remove it. Remove a keeper you no longer run.
