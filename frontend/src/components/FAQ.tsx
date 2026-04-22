import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, Search } from "lucide-react";
import { Link } from "react-router-dom";
import "./FAQ.css";

type Category = "basics" | "users" | "economics" | "integrators";

interface FaqEntry {
  id: string;
  category: Category;
  q: string;
  a: ReactNode;
  searchText: string;
}

const CATEGORIES: { key: Category | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "basics", label: "Getting started" },
  { key: "users", label: "For users" },
  { key: "economics", label: "Economics & VPFI" },
  { key: "integrators", label: "For integrators" },
];

const FAQS: FaqEntry[] = [
  {
    id: "basics-what-is-vaipakam",
    category: "basics",
    q: "What is Vaipakam, in plain English?",
    searchText:
      "intro overview plain english simple beginner lending borrowing p2p peer-to-peer marketplace what is defi",
    a: (
      <>
        <p>
          Vaipakam is a peer-to-peer marketplace for lending crypto and renting
          digital items (NFTs). One person posts an offer with the terms they're
          comfortable with — amount, interest, duration — and another person
          accepts it. No bank, no fund manager, no intermediary sitting between
          you and the counterparty.
        </p>
        <p>
          What keeps everyone honest is a set of smart contracts on a
          blockchain. They hold the assets in individual escrow during the loan
          and release them automatically when the terms are met. You are always
          in control of your own funds; the protocol simply enforces the deal
          you agreed to.
        </p>
      </>
    ),
  },
  {
    id: "basics-wallet",
    category: "basics",
    q: "Do I need a crypto wallet, and what is one?",
    searchText:
      "wallet metamask rabby coinbase connect signing key seed phrase account browse browse-only read-only",
    a: (
      <>
        <p>
          A wallet (MetaMask, Rabby, Coinbase Wallet, and similar) is the app
          that holds the private key controlling your on-chain assets. Think of
          it as your login and your signing pen rolled into one — it's how
          Vaipakam knows that a transaction is really coming from you.
        </p>
        <p>
          You only need a wallet when you want to <em>act</em> on your own
          positions (create an offer, accept a loan, repay, claim). Browsing the
          analytics dashboard and reading loan details works with no wallet at
          all. We never see or store your keys — the wallet lives entirely in
          your browser or extension.
        </p>
      </>
    ),
  },
  {
    id: "basics-collateral",
    category: "basics",
    q: 'Why does borrowing require "collateral"?',
    searchText:
      "collateral secured loan over-collateralized deposit lock pledge trust borrow risk strangers",
    a: (
      <>
        <p>
          Collateral is an asset you lock up for the duration of the loan to
          guarantee you'll repay. Because the lender doesn't know you, they need
          a credible commitment that you won't simply walk away with the
          borrowed funds.
        </p>
        <p>
          Every loan on Vaipakam is <strong>over-collateralized</strong>,
          meaning the collateral you post is worth more than what you borrow. If
          you repay as agreed, you get it all back, no strings attached. If you
          don't, the lender has a protocol-enforced path to claim it.
        </p>
      </>
    ),
  },
  {
    id: "basics-chains",
    category: "basics",
    q: "Why are there so many different blockchains (Base, Polygon, Arbitrum…)?",
    searchText:
      "chain network blockchain ethereum base polygon arbitrum optimism l2 layer-2 different why many fees speed",
    a: (
      <>
        <p>
          A blockchain is the shared ledger that records every transaction.
          Different blockchains — Ethereum, Base, Polygon, Arbitrum, Optimism —
          are independent ledgers, each with its own fees, speed, and set of
          available tokens. They don't automatically share state.
        </p>
        <p>
          Vaipakam runs on several of these, and a single loan lives entirely on
          one chain from start to finish. The chain selector lets you choose
          which one you want to read or transact on. Picking a cheaper L2 like
          Base or Polygon usually means paying much lower gas fees than Ethereum
          mainnet.
        </p>
      </>
    ),
  },
  {
    id: "basics-apr",
    category: "basics",
    q: 'What does "APR" mean on a loan offer?',
    searchText:
      "apr annual percentage rate interest yield cost of borrowing prorated pro-rated duration rate",
    a: (
      <>
        <p>
          APR stands for <strong>Annual Percentage Rate</strong> — the interest
          rate stated on a yearly basis. A loan with a 10% APR over a full year
          would cost the borrower 10% of the principal in interest; the same 10%
          APR over six months costs roughly 5%, and over a month roughly 0.83%.
        </p>
        <p>
          On the offer screen, you'll always see the APR and the duration side
          by side so you can sanity- check the total cost before accepting. The
          exact accrual formula is fixed at the moment the loan starts and can't
          be changed afterwards.
        </p>
      </>
    ),
  },
  {
    id: "basics-position-nft",
    category: "basics",
    q: "Why was I given an NFT when my loan started?",
    searchText:
      "position nft receipt proof claim transferable sell bearer ticket onchain metadata erc721",
    a: (
      <>
        <p>
          Your role in a loan — as lender or borrower — is represented as an NFT
          instead of an entry in a database. It's essentially a permanent,
          transferable receipt: it proves which side of the loan you're on and
          is what you present to claim funds later.
        </p>
        <p>
          Because this receipt is an NFT, you can also transfer it. Lenders who
          want to exit early can sell the position to another lender without
          disturbing the borrower; the loan keeps running unchanged, and the new
          holder simply takes over the right to be repaid.
        </p>
      </>
    ),
  },
  {
    id: "basics-gas",
    category: "basics",
    q: 'What are "gas fees", and why does every action cost a little?',
    searchText:
      "gas fee transaction cost validators miners network eth matic native token post stamp signing",
    a: (
      <>
        <p>
          Gas is the fee the blockchain itself charges to process a transaction.
          It pays the network of computers that validate your transaction and
          add it to the ledger. You pay it in the chain's native token — ETH on
          Ethereum or Base, MATIC on Polygon, and so on.
        </p>
        <p>
          Vaipakam never takes a cut of gas — it goes straight to the network.
          Using an L2 (Base, Arbitrum, Optimism, Polygon) usually keeps gas at a
          few cents per action, which is why most users prefer them over
          Ethereum mainnet for day-to-day activity.
        </p>
      </>
    ),
  },
  {
    id: "basics-custody",
    category: "basics",
    q: "Who actually holds my money while a loan is active?",
    searchText:
      "custody non-custodial escrow holding safe safety smart contract audited trust open source uups isolated",
    a: (
      <>
        <p>
          Nobody holds it in the traditional sense. Your assets live in a
          smart-contract escrow that only you and the protocol's own rules can
          move. Each user has their own isolated escrow — funds are never pooled
          with strangers — and every release of those funds follows a rule that
          was published on-chain before you ever clicked "accept".
        </p>
        <p>
          The contracts are open source and have been audited. Vaipakam cannot
          freeze, redirect, or claw back your balance; the most we can do is
          pause new actions in an emergency. Your repayment, claim, or exit
          always remains available.
        </p>
      </>
    ),
  },
  {
    id: "basics-vpfi-intro",
    category: "basics",
    q: "What is VPFI, and do I need any to use the app?",
    searchText:
      "vpfi token platform fee discount rewards optional required start using beginners need help",
    a: (
      <>
        <p>
          VPFI is Vaipakam's native platform token. You do <strong>not</strong>{" "}
          need to own any VPFI to lend or borrow — the app works entirely
          without it, and every core feature is open to anyone who shows up.
        </p>
        <p>
          Where VPFI becomes useful is if you become a regular user. Holding it
          in your Vaipakam escrow gets you a discount on platform fees and lets
          you earn passive rewards on top. Think of it as an optional loyalty
          layer, not a gate.
        </p>
      </>
    ),
  },
  {
    id: "assets",
    category: "users",
    q: "What assets can I lend or borrow?",
    searchText:
      "erc-20 erc20 erc-721 erc721 erc-1155 erc1155 nft token collateral principal lend borrow rent lender borrower usdc eth weth wbtc",
    a: (
      <>
        <p>
          Vaipakam supports two loan shapes: ERC-20 loans (lend a fungible
          token) and NFT rentals (rent out an ERC-721 or ERC-1155).
        </p>
        <ul>
          <li>
            <strong>ERC-20 loans:</strong> principal is any ERC-20 (USDC, ETH,
            WBTC, etc.); collateral can be any ERC-20 or any NFT.
          </li>
          <li>
            <strong>NFT rentals:</strong> the rented NFT is the principal;
            collateral is an ERC-20. Native ERC-4907 on the NFT is optional —
            the per-user escrow wrapper exposes a uniform <code>userOf</code> /{" "}
            <code>userExpires</code> / <code>userQuantity</code> surface
            regardless.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "escrow",
    category: "users",
    q: "How does the per-user escrow work?",
    searchText: "escrow uups proxy clone factory isolated commingled vault",
    a: (
      <>
        <p>
          Every user gets their own UUPS upgradeable proxy escrow, deployed on
          first use by the <code>EscrowFactoryFacet</code> (clone-factory
          pattern). Your assets are never commingled with anyone else's.
        </p>
        <p>
          The Diamond orchestrates moves across escrows, but claim rights are
          tied to your Vaipakam position NFT — so escrow custody is strictly
          constrained by on-chain position state.
        </p>
      </>
    ),
  },
  {
    id: "default",
    category: "users",
    q: "What happens if a borrower defaults?",
    searchText:
      "default liquidation grace period health factor dex swap 0x slippage fallback illiquid nft claim",
    a: (
      <>
        <p>There are two distinct liquidation paths:</p>
        <ul>
          <li>
            <strong>Health Factor trigger:</strong> if HF drops below 1.0 (while
            the loan is still live), anyone can call the permissionless DEX
            liquidation. The router swaps collateral via 0x with a 6% max
            slippage, and the liquidator receives a bonus.
          </li>
          <li>
            <strong>Time-based trigger:</strong> once the grace period expires,
            liquid collateral is swapped to repay the lender; illiquid
            collateral (NFTs, or tokens without a qualifying oracle + Uniswap v3
            pool) is transferred directly to the lender via the NFT-claim model.
          </li>
        </ul>
        <p>
          If a DEX swap cannot meet the 6% slippage bound, the fallback route
          delivers collateral-equivalent value to the lender and splits a
          premium (3% to the lender, 2% to treasury) as a distress bonus.
        </p>
      </>
    ),
  },
  {
    id: "early-exit",
    category: "users",
    q: "Can I exit my position early?",
    searchText:
      "early exit preclose refinance transfer offset withdrawal lender borrower sell position repay",
    a: (
      <>
        <p>
          Yes — both sides have exits that protect the counterparty's economics:
        </p>
        <ul>
          <li>
            <strong>Borrower early repayment:</strong> pay principal plus the
            full term's accrued interest at any time; the lender still receives
            the yield they were promised.
          </li>
          <li>
            <strong>Debt transfer / offset:</strong> hand your debt to another
            borrower, or create an offsetting new position that nets down
            exposure without touching the lender.
          </li>
          <li>
            <strong>Lender early withdrawal / sale:</strong> sell your position
            NFT to another lender, or post an offsetting offer. The underlying
            loan keeps running unchanged for the borrower.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "durations",
    category: "users",
    q: "How are loan durations and grace periods determined?",
    searchText: "duration grace period term length days weeks months year",
    a: (
      <>
        <p>
          Loan durations are configurable between 1 day and 1 year. Grace
          periods are derived from the term:
        </p>
        <table className="faq-table">
          <thead>
            <tr>
              <th>Loan term</th>
              <th>Grace period</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Under 1 week</td>
              <td>1 hour</td>
            </tr>
            <tr>
              <td>1 week – 1 month</td>
              <td>1 day</td>
            </tr>
            <tr>
              <td>1 – 3 months</td>
              <td>3 days</td>
            </tr>
            <tr>
              <td>3 – 6 months</td>
              <td>1 week</td>
            </tr>
            <tr>
              <td>6 – 12 months</td>
              <td>2 weeks</td>
            </tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: "chains",
    category: "users",
    q: "Which blockchains are supported?",
    searchText:
      "chains networks base polygon arbitrum optimism ethereum sepolia canonical mirror layerzero bridge",
    a: (
      <>
        <p>
          Phase 1 targets <strong>Base</strong>, <strong>Polygon</strong>,{" "}
          <strong>Arbitrum</strong>, <strong>Optimism</strong>, and{" "}
          <strong>Ethereum mainnet</strong>. Base is the canonical chain for
          VPFI (where the token is minted and the fixed-price buy lives), but
          the in-app Buy VPFI page works from every supported chain — it
          auto-selects a direct buy on Base, or a LayerZero-bridged buy from any
          mirror chain, so you never have to switch networks just to top up.
        </p>
        <p>
          The live deployment today is <strong>Sepolia</strong> while additional
          chains are being rolled out. All aspects of a single loan must occur
          on the same network.
        </p>
      </>
    ),
  },
  {
    id: "sequencer",
    category: "users",
    q: "What if the L2 sequencer goes down?",
    searchText:
      "sequencer downtime uptime feed chainlink base arbitrum optimism pause liquidation grace",
    a: (
      <>
        <p>
          On supported L2s, the protocol reads the Chainlink sequencer uptime
          feed. If the sequencer is reported down, or has been back up for less
          than a 1-hour grace window, oracle-sensitive actions — new loans,
          HF-based liquidations, and rate-dependent quotes — fail-closed.
          Repayments and user-initiated exits keep working so you can never be
          trapped in a position.
        </p>
      </>
    ),
  },
  {
    id: "liquidity-status",
    category: "users",
    q: "How does Vaipakam decide if an asset is liquid or illiquid?",
    searchText:
      "liquidity liquid illiquid classification chainlink oracle uniswap pool depth price feed active network mainnet fallback",
    a: (
      <>
        <p>
          Liquidity is judged{" "}
          <strong>only on the network you're transacting on</strong>. The
          protocol checks two things on that chain: a reliable Chainlink price
          path for the asset, and a sufficiently deep Uniswap v3{" "}
          <code>asset/WETH</code> 0.3% pool. If either fails, the asset is
          marked <strong>illiquid on that network</strong>.
        </p>
        <p>
          There is <em>no Ethereum-mainnet fallback</em>. An asset that's liquid
          on mainnet but not on, say, Base is simply illiquid on Base — the
          protocol will not reach back to mainnet to justify liquid treatment.
          If the asset is illiquid, LTV / Health Factor checks are skipped (the
          collateral is valued at $0), and both parties must accept the combined
          abnormal-market + illiquid-assets risk acknowledgement before the
          offer can proceed.
        </p>
      </>
    ),
  },
  {
    id: "preclose-refinance",
    category: "users",
    q: "What are preclose, refinance, and lender early-withdrawal?",
    searchText:
      "preclose refinance early withdrawal strategic flow transfer lock borrower lender nft exit close loan replace",
    a: (
      <>
        <p>Beyond regular repayment, there are three strategic-exit flows:</p>
        <ul>
          <li>
            <strong>Borrower preclose:</strong> the borrower settles the loan
            ahead of schedule. While the preclose flow is in progress, the
            borrower-side position NFT is <strong>locked for transfer</strong>{" "}
            until the flow completes, is cancelled, or is unwound — you'll see a
            notice about this in the transaction review before you confirm.
          </li>
          <li>
            <strong>Lender early-withdrawal:</strong> the lender exits the loan
            before its natural end. Same transfer-lock rules apply to the
            lender-side NFT for the duration of the flow.
          </li>
          <li>
            <strong>Refinance:</strong> the borrower swaps one active loan for a
            fresh loan with a new lender. By the time the borrower signs the
            refinance transaction, the replacement lender has already accepted
            the new offer and the replacement loan already exists — the on-chain
            refinance call is a single atomic settlement, so there's no
            refinance-specific NFT lock to worry about.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "keepers",
    category: "users",
    q: "What are keepers, and can they take my assets?",
    searchText:
      "keeper keepers role manager delegate automation third party execution whitelist opt-in advanced mode claim nft",
    a: (
      <>
        <p>
          Keepers are optional <strong>delegated role-managers</strong> — they
          can execute the on-chain role you assign them (for example, calling
          <code> repayLoan</code> on your behalf or triggering a default
          settlement), but they <strong>cannot claim your assets</strong>.
          Claims are always locked to whoever currently holds the relevant
          Vaipakam position NFT, which is you unless you've transferred it.
        </p>
        <p>
          Enabling a keeper takes <strong>two opt-ins</strong>, by design:
        </p>
        <ul>
          <li>
            <strong>User-level:</strong> in advanced settings, you must turn on
            keeper access for your side (borrower or lender) and add the keeper
            to your whitelist.
          </li>
          <li>
            <strong>Position-level:</strong> the offer (or accept) flow has to
            have keeper execution enabled for that specific position.
          </li>
        </ul>
        <p>
          If either layer is off, the keeper can't act — flipping the
          position-level flag alone is not enough. You can also enable or
          disable keeper access for an existing loan later, from advanced
          settings, for your own side. Keeper controls only appear in{" "}
          <strong>Advanced mode</strong>; they're intentionally hidden from the
          default everyday workflow.
        </p>
      </>
    ),
  },
  {
    id: "fees",
    category: "economics",
    q: "What fees does the platform charge?",
    searchText:
      "fees initiation yield treasury late bps liquidation borrower lender percent discount",
    a: (
      <>
        <p>Two headline fees, plus a late-payment schedule:</p>
        <ul>
          <li>
            <strong>Loan Initiation Fee — 0.1%</strong> on ERC-20 loans,
            deducted from the lender's principal at loan start. The borrower
            receives 99.9% of the offered amount but still owes the full
            principal.
          </li>
          <li>
            <strong>Yield Fee — 1%</strong> on interest earned by lenders and on
            rental income earned by NFT owners.
          </li>
          <li>
            <strong>Late fees:</strong> 1% flat on the day of miss, plus 0.5%
            per additional day, capped at 5% of principal. Late fees route to
            treasury.
          </li>
        </ul>
        <p>
          VPFI holders can reduce <em>both</em> headline fees via a single
          platform-level consent — see the VPFI discount entry below.
        </p>
      </>
    ),
  },
  {
    id: "vpfi-discount",
    category: "economics",
    q: "How does the VPFI discount work?",
    searchText:
      "vpfi discount tier escrow borrower lender initiation yield fee basis points",
    a: (
      <>
        <p>
          VPFI held in your Vaipakam escrow automatically places you in a
          discount tier. One platform-level consent covers both the borrower
          (initiation) and lender (yield) legs, and the discounted fee is
          auto-deducted in VPFI from your escrow — the borrower then receives
          the full principal and the lender keeps the full interest on the
          discount path.
        </p>
        <table className="faq-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>VPFI in escrow</th>
              <th>Discount</th>
              <th>Effective initiation</th>
              <th>Effective yield fee</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td>≥ 100</td>
              <td>10%</td>
              <td>0.090%</td>
              <td>0.90%</td>
            </tr>
            <tr>
              <td>2</td>
              <td>≥ 1,000</td>
              <td>15%</td>
              <td>0.085%</td>
              <td>0.85%</td>
            </tr>
            <tr>
              <td>3</td>
              <td>≥ 5,000, ≤ 20,000</td>
              <td>20%</td>
              <td>0.080%</td>
              <td>0.80%</td>
            </tr>
            <tr>
              <td>4</td>
              <td>&gt; 20,000</td>
              <td>24%</td>
              <td>0.076%</td>
              <td>0.76%</td>
            </tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: "vpfi-rewards",
    category: "economics",
    q: "How can I earn VPFI rewards?",
    searchText:
      "rewards staking interactions apr escrow yield cap per-user interaction earning",
    a: (
      <>
        <p>
          Two reward surfaces, both keyed to your escrow balance — no extra
          staking contract to manage:
        </p>
        <ul>
          <li>
            <strong>Staking rewards — 5% APR</strong> on VPFI held in escrow
            (24% of total supply = 55.2M VPFI allocated to this pool). Your
            balance accrues continuously while it sits there.
          </li>
          <li>
            <strong>Interaction rewards</strong> pay VPFI on loan interest you
            pay or receive, capped at{" "}
            <strong>0.5 VPFI per 0.001 ETH of interest</strong> per user, drawn
            from the 30% interaction-rewards pool (69M VPFI). The cap prevents
            wash-loan farming.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "tokenomics",
    category: "economics",
    q: "What is the VPFI tokenomics?",
    searchText:
      "tokenomics supply allocation cap mint base layerzero oft early purchase wallet limit founders team auditors treasury",
    a: (
      <>
        <p>
          Hard cap of <strong>230M VPFI</strong>. Genesis mint is{" "}
          <strong>23M (10%)</strong> on Base; the remaining supply unlocks
          against usage and pool drawdowns. Fixed-rate purchase is pinned at{" "}
          <strong>1 VPFI = 0.001 ETH</strong>.
        </p>
        <p>
          Early purchase is capped at 2.3M VPFI (1% of supply), with a
          per-wallet per-chain cap of 30,000 VPFI during the bootstrap window.
          Allocations:
        </p>
        <table className="faq-table">
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Interaction rewards</td>
              <td>30%</td>
            </tr>
            <tr>
              <td>Staking rewards</td>
              <td>24%</td>
            </tr>
            <tr>
              <td>Exchange / market-makers</td>
              <td>14%</td>
            </tr>
            <tr>
              <td>Team</td>
              <td>12%</td>
            </tr>
            <tr>
              <td>Founders</td>
              <td>6%</td>
            </tr>
            <tr>
              <td>Early contributors</td>
              <td>6%</td>
            </tr>
            <tr>
              <td>Platform admins</td>
              <td>3%</td>
            </tr>
            <tr>
              <td>Security auditors</td>
              <td>2%</td>
            </tr>
            <tr>
              <td>Bug bounty</td>
              <td>2%</td>
            </tr>
            <tr>
              <td>Regulatory reserve</td>
              <td>1%</td>
            </tr>
            <tr>
              <td>Early purchase</td>
              <td>1%</td>
            </tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: "nft-positions",
    category: "users",
    q: "What are Vaipakam position NFTs?",
    searchText:
      "nft position erc721 metadata onchain on-chain claim ownership marketplace viewer",
    a: (
      <>
        <p>
          Every offer and every loan mints a unique ERC-721 with{" "}
          <strong>on-chain metadata</strong> (asset types, amounts, rates,
          status). The NFT <em>is</em> the position — it proves ownership and is
          required to claim funds after repayment, default, or liquidation.
          Because metadata is on-chain, any standard NFT marketplace can render
          the current state.
        </p>
      </>
    ),
  },
  {
    id: "integrator-rental",
    category: "integrators",
    q: "How do I read rental state for a Vaipakam-rented NFT?",
    searchText:
      "integrator erc4907 erc-4907 rental user expires quantity wrapper escrow subgraph event listener",
    a: (
      <>
        <p>
          Query the lender's <strong>Vaipakam escrow wrapper</strong> — not the
          underlying NFT — through the Diamond. For ERC-1155 rentals with
          multiple concurrent renters on the same{" "}
          <code>(nftContract, tokenId)</code>, <code>escrowGetNFTQuantity</code>{" "}
          returns the <em>active aggregate</em> quantity and{" "}
          <code>escrowGetNFTUserExpires</code> returns the minimum active
          expiry.
        </p>
        <pre className="faq-code">
          <code>{`// Pull state on demand
escrowGetNFTUserOf(lender, nftContract, tokenId)        returns (address)
escrowGetNFTUserExpires(lender, nftContract, tokenId)   returns (uint64)
escrowGetNFTQuantity(lender, nftContract, tokenId)      returns (uint256)

// Push-style updates: subscribe on the Diamond
event EscrowRentalUpdated(
  address indexed lender,
  address indexed nftContract,
  uint256 indexed tokenId,
  address user,
  uint64  expires,
  uint256 quantity,
  uint256 activeTotalQuantity,
  uint64  minActiveExpires
);`}</code>
        </pre>
        <p>
          The wrapper maintains authoritative rental state even when the
          underlying NFT does <strong>not</strong> implement ERC-4907, so
          integrators get a uniform surface across every rented asset.
        </p>
      </>
    ),
  },
  {
    id: "integrator-subgraph",
    category: "integrators",
    q: "What loan-lifecycle events can I index?",
    searchText:
      "subgraph events loan initiated repaid defaulted liquidated fallback indexer graph thegraph",
    a: (
      <>
        <p>
          The Diamond emits a stable set of lifecycle events that the reference
          subgraph indexes. You can subscribe to these directly or query the
          subgraph:
        </p>
        <ul>
          <li>
            <code>LoanInitiated</code> — loan created, terms frozen
          </li>
          <li>
            <code>LoanRepaid</code> — full or partial repayment posted
          </li>
          <li>
            <code>LoanDefaulted</code> — grace period elapsed, claim path
            unlocked
          </li>
          <li>
            <code>LoanLiquidated</code> — HF-triggered DEX liquidation executed
          </li>
          <li>
            <code>LiquidationFallback</code> — DEX path blocked;
            collateral-equivalent + premium paid out
          </li>
        </ul>
      </>
    ),
  },
];

const LS_KEY = "vaipakam.faq.lastCategory";

export default function FAQ() {
  const [open, setOpen] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | "all">(() => {
    if (typeof window === "undefined") return "all";
    const stored = window.localStorage.getItem(LS_KEY);
    return stored === "basics" ||
      stored === "users" ||
      stored === "economics" ||
      stored === "integrators" ||
      stored === "all"
      ? stored
      : "all";
  });
  const [query, setQuery] = useState("");
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LS_KEY, category);
  }, [category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FAQS.filter((f) => {
      if (category !== "all" && f.category !== category) return false;
      if (!q) return true;
      return (f.q + " " + f.searchText).toLowerCase().includes(q);
    });
  }, [category, query]);

  // Deep-link: open the item matching the URL hash on mount, and whenever hash changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) return;
      const match = FAQS.find((f) => f.id === hash);
      if (match) {
        if (category !== "all" && match.category !== category)
          setCategory("all");
        setOpen(hash);
        requestAnimationFrame(() => {
          buttonRefs.current[hash]?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        });
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // category intentionally omitted — we only react to hash changes, not category state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    setOpen((cur) => (cur === id ? null : id));
    if (typeof window !== "undefined" && window.history.replaceState) {
      window.history.replaceState(null, "", `#${id}`);
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const ids = filtered.map((f) => f.id);
    let nextIdx: number | null = null;
    if (e.key === "ArrowDown") nextIdx = Math.min(index + 1, ids.length - 1);
    else if (e.key === "ArrowUp") nextIdx = Math.max(index - 1, 0);
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = ids.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      buttonRefs.current[ids[nextIdx]]?.focus();
    }
  };

  return (
    <section className="section faq" id="faq">
      <div className="container">
        <div className="faq-header">
          <span className="section-label">FAQ</span>
          <h2 className="section-title">Frequently asked questions</h2>
          <p className="section-subtitle">
            Everything you need to know about lending, borrowing, and building
            on Vaipakam.
          </p>
        </div>

        <div className="faq-toolbar">
          <div className="faq-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search questions…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search FAQ"
            />
          </div>
          <div className="faq-tabs" role="tablist" aria-label="FAQ categories">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                role="tab"
                aria-selected={category === c.key}
                className={`faq-tab ${category === c.key ? "active" : ""}`}
                onClick={() => setCategory(c.key as Category | "all")}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="faq-list">
          {filtered.length === 0 && (
            <div className="faq-empty">
              No questions match “{query}”. Try a different term.
            </div>
          )}
          {filtered.map((faq, i) => {
            const isOpen = open === faq.id;
            return (
              <div
                key={faq.id}
                id={faq.id}
                className={`faq-item ${isOpen ? "open" : ""}`}
              >
                <button
                  ref={(el) => {
                    buttonRefs.current[faq.id] = el;
                  }}
                  className="faq-question"
                  onClick={() => toggle(faq.id)}
                  onKeyDown={(e) => handleKey(e, i)}
                  aria-expanded={isOpen}
                  aria-controls={`${faq.id}-answer`}
                >
                  <span>{faq.q}</span>
                  <ChevronDown
                    size={20}
                    className="faq-chevron"
                    aria-hidden="true"
                  />
                </button>
                <div
                  id={`${faq.id}-answer`}
                  role="region"
                  aria-labelledby={faq.id}
                  className="faq-answer"
                  hidden={!isOpen}
                >
                  <div className="faq-answer-inner">{faq.a}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="faq-cta">
          Still have questions?{" "}
          <a
            href="https://github.com/vaipakam/vaipakam/issues"
            target="_blank"
            rel="noreferrer"
          >
            Open an issue on GitHub
          </a>{" "}
          or <Link to="/discord">ping the team on Discord</Link>.
        </div>
      </div>
    </section>
  );
}
