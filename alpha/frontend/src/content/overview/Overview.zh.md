# 欢迎来到 Vaipakam

Vaipakam 是一个 peer-to-peer lending 平台。你可以 lend assets 并赚取 interest，也可以 borrow assets 并提供 collateral。你还可以 rent NFTs，让 owner 获得 daily fees。所有操作都直接发生在两个 wallets 之间；在 loan 或 rental 结束前，smart contracts 会把 assets 保管在 vault 中。

这一页是一份**友好的导览**。如果你想深入了解技术细节，可以打开 **User Guide** 标签查看每个 screen 的帮助，或打开 **Technical** 标签阅读完整 whitepaper。如果你只是想知道“这是什么、该怎么用”，继续往下看就好。

---

## 你可以在 Vaipakam 做什么

Vaipakam 面向四类用户：

- **Lenders** - 你有一笔闲置 asset，例如 USDC、ETH、USDT 等。你希望它在保持安全的同时赚取 interest。你发布 lender offer；borrower accept；你按照自己设定的 terms 获得 interest。
- **Borrowers** - 你需要几天、几周或几个月的资金，但不想卖掉 collateral。也许你认为它会升值，也许那是一枚你不想失去的 NFT。你 post collateral，获得 loan，并按 agreed rate repay。
- **NFT owners** - 你拥有一枚有价值的 NFT，它可能提供游戏内或应用内的 utility。卖掉它意味着永久失去这种 utility。把它 rent 出去，可以让别人短期使用，同时你保留 ownership 并收取 daily rent。
- **NFT renters** - 你想临时使用某个 NFT，例如 game asset、membership pass 或 domain，但不想支付 full price。你 rent 它，在 rental window 内使用它，而 asset 仍由 owner 保留。

不需要注册，也不需要填写 profile。连接 wallet 后，就可以 lend、borrow 或 rent。

---

## Loan 如何运作（具体例子）

假设你的 Base wallet 里有 **1,000 USDC**，你想用它赚取 interest。完整 lifecycle 如下。

### Step 1 — 创建 offer

你打开 Vaipakam app，连接 wallet，然后点击 **Create Offer**。你是 lender，所以填写：

- 我 lend **1,000 USDC**
- 我希望获得 **8% APR**
- 可接受的 collateral：**WETH**，且 **maximum 70% LTV**
- Loan duration：**30 days**

你签署一笔 transaction。你的 1,000 USDC 会从 wallet 移入你的 **Vaipakam Vault**，也就是只由你控制的 private vault。Funds 会一直停留在那里，直到有 borrower accept 你的 offer。

### Step 2 — Borrower 接受

也许一小时后，其他人在 **Offer Book** 中看到了你的 offer。他们持有 WETH，并希望用它作 collateral borrow 一个月的 USDC。他们点击 **Accept**，并 post 价值约 $1,500 的 WETH。这个 LTV 大约是 67%，低于你的 70% cap，因此 offer 可以被 accept。

他们接受的瞬间：

- 你的 1,000 USDC 从你的 vault 移到他们的 vault
- 他们的 WETH 作为 collateral 锁定在他们的 vault 中
- 你们双方都会收到一个 position NFT - 你的表示“我应收到 1,000 USDC + interest”；他们的表示“我 repay 后应取回我的 WETH”
- Loan clock 开始计时

系统会从 loaned amount 中收取一笔很小的 **Loan Initiation Fee (0.1%)**，并转入 protocol treasury。因此 borrower 收到的是 999 USDC，而不是 1,000。（你也可以用 **VPFI** 支付该 fee，让 borrower 收到完整的 1,000；VPFI 会在下文说明。）

### Step 3 — 时间经过；borrower 还款

30 天后，borrower 需要 repay principal plus interest：

```
Interest = 1,000 USDC × 8% × (30 / 365) = ~6.58 USDC
```

他们点击 **Repay**，签署 transaction，1,006.58 USDC 进入 loan settlement。随后：

- 你收到 **1,005.51 USDC**（principal + interest，扣除仅针对 interest portion 的 1% Yield Fee 后）
- Treasury 收到 **1.07 USDC** 作为 Yield Fee
- Borrower 的 WETH 被 unlock

你的 dashboard 上会出现 **Claim** button。点击后，1,005.51 USDC 会从 settlement 移到你的 wallet。Borrower 点击 claim 后，他们的 WETH 会回到自己的 wallet。Loan 随之 close。

### Step 4 — 如果 borrower 没有还款怎么办？

可能出现两类问题，protocol 会自动处理。

**Loan 期间 collateral price 暴跌。** Vaipakam 会跟踪每笔 loan 的 **Health Factor**，这是一个将 collateral value 与 debt 进行比较的 single number。如果它跌破 1.0，任何人 - 是的，任何人，包括路过的 bot - 都可以调用 **Liquidate**。Protocol 会通过最多四个 DEX aggregators（0x、1inch、Uniswap、Balancer）route collateral，选择最佳 fill，偿还你应得的金额，给 liquidator 一小笔 bonus，并将剩余部分返还给 borrower。

**Borrower 在 due date 后消失。** 在可配置的 **grace period** 结束后，任何人都可以调用 **Default**。短期 loan 的 grace period 可能是一小时，year-long loan 则可能是两周。之后会运行同一条 liquidation path。

在少数情况下 - 例如所有 aggregator 都返回很差的 price，或 collateral 已严重暴跌 - protocol 会*拒绝在糟糕市场中抛售*。相反，你会收到 collateral 本身以及一小笔 premium，之后可以选择 hold，或在合适时 sell。这个 **fallback path** 会提前写明，并作为 loan terms 的一部分由你 accept。

### Step 5 — 任何人都可以 repay

如果朋友或 delegated keeper 想替 borrower pay off loan，他们可以这样做。Collateral 仍会回到 borrower 手中，而不是回到帮忙的 third party 手中。这是一扇单向门：替别人还 loan，不会让你获得对方的 collateral。

---

## NFT rentals 如何运作

流程与 loan 类似，但有两个不同点：

- **NFT 保持在 vault 中**；renter 不会直接持有它。Protocol 会使用 **ERC-4907** 在 rental window 内授予 renter 该 NFT 的 “user rights”。兼容的 games 和 apps 会读取 user rights，因此 renter 可以在不拥有 NFT 的情况下 play、log in，或使用该 NFT 的 utility。
- **Daily fees 会从 prepaid pool 自动扣除。** Renter 预先支付整个 rental 的费用，并额外支付 5% buffer。每天 protocol 都会把当天的 fee release 给 owner。如果 renter 想提前结束，未使用天数会 refund。

Rental 结束后（无论是 expiry 还是 default），NFT 会回到 owner 的 vault。Owner 随后可以重新 list，或 claim 回自己的 wallet。

---

## Vaipakam 如何保护我？

在 Vaipakam 上 lending 和 borrowing 并非 risk-free。但 protocol 内置了多层保护：

- **Per-user vault.** 你的 assets 存放在你自己的 vault 中。Protocol 从不把它们与其他 users 的 funds 混在一个池子里。这意味着即使出现影响其他 user 的 bug，也无法 drain 你的资产。
- **Health Factor enforcement.** 只有当 collateral 在 origination 时至少为 loan value 的 1.5×，loan 才能开始。如果 loan 期间 price 朝 borrower 不利方向移动，任何人都可以在 collateral 价值低于 debt 之前 liquidate，从而保护 lender。
- **Multi-source price oracle.** Prices 首先来自 Chainlink，然后会与 Tellor、API3 和 DIA 交叉核验。如果差异超过 configured threshold，loan 不能 open，ongoing position 也不能被 unfairly liquidated。Attacker 必须在同一个 block 中攻破**多个 independent oracles**，才可能伪造 price。
- **Slippage cap.** Liquidations 会拒绝以超过 6% slippage 的糟糕价格抛售 collateral。如果 market 太薄，protocol 会 fallback，直接把 collateral 给你。
- **L2 sequencer awareness.** 在 L2 chains 上，如果 chain 的 sequencer 刚从 downtime 中恢复，liquidation 会短暂停止，避免 attackers 利用 stale-price window 干扰你。
- **Pause switches.** 每个 contract 都有 emergency pause levers。如果情况异常，operator 可以在几秒内停止 new business，同时允许 existing users 安全地 wind down positions。
- **Independent audits.** 每条 chain 上的每个 contract 都只有在 third-party security review 完成后才会 ship。Audit reports 和 bug bounty scope 都是公开的。

你仍然应该理解自己正在 sign 什么。每笔 loan 之前都会显示 combined **risk consent**；它解释了 abnormal-market fallback path，以及 illiquid collateral 的 in-kind settlement path。只有勾选 consent box 后，app 才会允许你 accept。

---

## 费用是多少？

只有两项 fees，且都很小：

- **Yield Fee — `{liveValue:treasuryFeeBps}`%**，按你作为 lender 赚到的 **interest** 比例收取（不是 principal 的比例）。在一笔 1,000 USDC、30-day、8% APR 的 loan 中，lender 赚取约 6.58 USDC interest，其中按默认费率约 0.066 USDC 是 Yield Fee。
- **Loan Initiation Fee — `{liveValue:loanInitiationFeeBps}`%**，按 lending amount 收取，由 borrower 在 origination 时支付。1,000 USDC loan 在默认费率下的费用是 1 USDC。

这两项 fees 都可以通过在 vault 中持有 VPFI 获得**最高 `{liveValue:tier4DiscountBps}`% discount**（见下文）。在 default 或 liquidation 时，recovered interest 不会收取 Yield Fee - protocol 不会从 failed loan 中获利。

没有 withdrawal fees，没有 idle fees，没有 streaming fees，也没有针对 principal 的 “performance” fees。Protocol 收取的只有上面两个数字。

> **关于 blockchain 网络 gas 费用的说明。** 当你 create offer、accept loan、repay、claim 或进行其他任何 on-chain action 时，你还会向把你的 transaction 写入 block 的 blockchain validators 支付一笔小额 **网络 gas 费**。这笔 gas 费支付给网络，**不归 Vaipakam**——这与你在同一条 chain 上转账任何 token 时支付的费用是同一笔费用。金额取决于 chain 和那一刻的网络拥堵程度，与 loan 大小无关。上面提到的 protocol fees（Yield Fee `{liveValue:treasuryFeeBps}`%、Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%）与网络 gas 完全独立，是协议本身收取的全部费用。

---

## 什么是 VPFI？

**VPFI** 是 Vaipakam 的 protocol token。它有三个用途：

### 1. Fee discounts

如果你在某条 chain 的 vault 中持有 VPFI，它会为你在该 chain 参与的 loans 折抵 protocol fees：

| Vault 中的 VPFI | Fee discount |
|---|---|
| `{liveValue:tier1Min}` – `{liveValue:tier2Min}`（不含） | `{liveValue:tier1DiscountBps}`% |
| `{liveValue:tier2Min}` – `{liveValue:tier3Min}`（不含） | `{liveValue:tier2DiscountBps}`% |
| `{liveValue:tier3Min}` – `{liveValue:tier4Min}` | `{liveValue:tier3DiscountBps}`% |
| `{liveValue:tier4Min}` 以上 | `{liveValue:tier4DiscountBps}`% |

Discounts 适用于 lender 和 borrower fees。Discount 会在 **loan's life 中按时间加权**计算，因此在 loan 结束前临时 top up 不能 game the calculation - 你实际持有该 tier 多久，就按相应比例获得 discount。

### 2. Staking — 5% APR

任何停留在你 vault 中的 VPFI 都会自动获得 5% annual yield 的 staking rewards。不需要单独 staking action，没有 lock-up，也没有 “unstake” wait。把 VPFI 移入 vault，它从那一刻开始 earn；移出后 accrual 停止。

### 3. Platform interaction rewards

每天，一个固定的 VPFI pool 会按照 protocol 中流动的 **interest** 比例分配给 lenders 和 borrowers。如果你作为 lender 赚取了 interest，或作为 borrower cleanly 支付了 interest（没有 late fees、没有 default），你就会获得一份 share。

Reward pool 在最初六个月最大，随后在七年内逐步 taper。Early users 会获得最高的 emissions。

### 如何获得 VPFI

三种路径：

- **Earn it** - 通过参与 protocol 获得（即上面的 interaction rewards）。
- **Buy it** - 在 **Buy VPFI** page 按 fixed rate（`1 VPFI = 0.001 ETH`）购买。Fixed-rate program 对每个 wallet、每条 chain 都有 cap。
- **Bridge it** - VPFI 是 LayerZero OFT V2 token，因此可以通过 official bridge 在 supported chains 间移动。

---

## 支持哪些 chains？

Vaipakam 在每条 supported chain 上都是 independent deployment：**Ethereum**、**Base**、**Arbitrum**、**Optimism**、**Polygon zkEVM**、**BNB Chain**。

在 Base 上 opened loan，就在 Base 上 settle。在 Arbitrum 上 opened loan，就在 Arbitrum 上 settle。没有 cross-chain debt。跨 chain 的只有 VPFI token，以及 daily reward denominator；它确保 busy chains 和 quiet chains 之间的 rewards 保持 fair。

---

## 从哪里开始？

如果你想 **lend**：

1. 打开 Vaipakam app，连接 wallet。
2. 前往 **Create Offer**，选择 “Lender”。
3. 设置 asset、amount、APR、accepted collateral 和 duration。
4. 签署两笔 transactions（一笔 approval，一笔 create），你的 offer 就会 live。
5. 等待 borrower accept。Dashboard 会显示你的 active loans。

如果你想 **borrow**：

1. 打开 app，连接 wallet。
2. 在 **Offer Book** 中浏览与你的 collateral 和可接受 APR 匹配的 offer。
3. 点击 **Accept**，签署两笔 transactions，你会在 wallet 中收到 loan amount（扣除 0.1% Loan Initiation Fee 后）。
4. 在 due date plus grace period 前 repay。你的 collateral 会 unlock 回 wallet。

如果你想 **rent 或 list an NFT**：

流程相同，但在 **Create Offer** page 中选择 “NFT rental”，而不是 ERC-20 lending。Form 会一步步引导你完成。

如果你只是想用自己的 VPFI **earn passive yield**，在 **Dashboard** page 将它 deposit 到你的 vault。就这么简单 - staking 从那一刻起自动开始。

---

## 关于我们有意*不做*的事

其他 DeFi platforms 会做的一些事，我们有意**不做**：

- **No pooled lending.** 每笔 loan 都发生在两个 specific wallets 之间，且条款由双方签署。没有 shared liquidity pool，没有 utilization curve，也没有 surprise rate spikes。
- **No proxy custody.** 你的 assets 在你自己的 vault 中，而不是 shared vault 中。Protocol 只会在你签署的 actions 中移动它们。
- **No leveraged loops by default.** 如果你愿意，可以把 borrowed funds 重新发布成新的 lender offer，但 protocol 不会把 automatic looping 做进 UX。我们认为那是 footgun。
- **No surprise upgrades.** Vault upgrades 受到 gating；mandatory upgrades 会在 app 中出现，由你明确 apply。没有任何东西会在你背后 rewrite 你的 vault。

---

## 还想进一步了解？

- **User Guide** tab 会逐个 card 讲解 app 的每个 screen。适合回答“这个 button 是做什么的？”这类问题。
- **Technical** tab 是完整 whitepaper。适合回答“liquidation engine 实际如何工作？”这类问题。
- **FAQ** page 处理最常见的 one-liners。
- Discord 和 GitHub repo 都可以从 app footer 进入。

这就是 Vaipakam。连接 wallet，你就可以开始了。
