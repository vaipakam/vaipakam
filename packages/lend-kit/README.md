# @vaipakam/lend-kit

Open the platform's own borrow, lend or rent flow for your user, in their own
wallet, pre-filled. The kit builds a link and opens it. That is all it does.

- It holds no key and signs nothing.
- It renders no form. Your user always sees the platform's review screen,
  with every figure read from the chain, before anything is signed.
- It never shows a rate as yours.

## The three entry points

| Entry point | What it opens | Can your id bring a share? |
| --- | --- | --- |
| `borrowAgainstLink` | Borrow, with the asset your user holds as collateral (an NFT names its `tokenId`, an ERC-1155 also a `quantity`) | Yes, when your id is registered: a share of the loan initiation fee above the platform's floor. Your user's fee is the same either way. |
| `lendLink` | Lend, with a token and an amount in base units | No. A lender's action never names an integrator; your id is attribution only. |
| `rentLink` | The rental of one token | No. A rental pays no initiation fee. |

An unregistered, suspended or flagged id is not an error. The flow opens the
same way, no share is paid, and the review says so.

The share is a share of the fee on loans you bring. It is not earnings,
income or a revenue share, and should never be described that way.

## A worked example

```ts
import { borrowAgainstLink, openKit } from '@vaipakam/lend-kit';

const link = borrowAgainstLink('https://alpha05.vaipakam.com', {
  chainId: 84532,
  asset: '0xYourCollection…',
  tokenId: 42n,
  integrator: '0xYourRegisteredId…',
});

// A button in your page:
if (!openKit(link)) showLinkToCopy(link); // a blocked pop-up: show the link instead
```

## The link alone

No dependency is needed. The link is
`<app>/kit?v=1&action=<borrow|lend|rent>&chain=<id>&asset=<0x…>` plus, as
the action needs, `tokenId`, `quantity`, `lending` (the asset to borrow),
`amount` (base units) and `integrator`. The app refuses a link it cannot
read and names why; it never guesses a missing value.
