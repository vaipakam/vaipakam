# Vaipakam — 用户指南 (Basic Mode)

这是 App 中每张 card 的友好、清晰说明。每个章节都对应 card 标题
旁边的 `(i)` info icon。

> **您正在阅读 Basic 版本。** 它对应 App 的 **Basic** 模式
> (界面更简单、控件更少、默认设置更稳妥)。如果想看更技术化、
> 更详细的 walkthrough，请将 App 切换到 **Advanced** 模式 —
> 打开 Settings (右上角的齿轮图标) → **Mode** → **Advanced**。
> 之后 App 内的 (i) "Learn more" 链接会开始打开 Advanced 指南。

---

## Dashboard

<a id="dashboard.your-escrow"></a>

### 您的 Escrow

把您的 **escrow** 想象成 Vaipakam 里的私人金库。它是一个只由您
控制的小型 contract。每当您参与一笔 loan — 无论是放入 collateral，
还是把某个 asset 借出 — 相关资产都会从您的 wallet 移入这个金库。
它们不会与任何人的资金混在一起。loan 结束后，您可以直接从这里
claim 取回。

您不需要自己 "创建" escrow；第一次需要时，App 会自动帮您创建。
一旦创建，它就会成为您在这条 chain 上的专属位置。

<a id="dashboard.your-loans"></a>

### 您的 Loans

您在这条 chain 上参与的每一笔 loan 都会显示在这里 — 无论您是
lender (提供资产出借的一方)，还是 borrower (借款的一方)。每一行
都是一个 position。点击进入后可以看到完整情况：loan 的健康程度、
锁定为 collateral 的资产、已经累计的利息，以及到时候可用于
repay、claim 或 liquidate 的按钮。

如果您同时处在两种角色里 (例如一笔 loan 中您是 lender，另一笔
loan 中您是 borrower)，两者都会显示在这里 — 同一个页面，不同的行。

<a id="dashboard.vpfi-panel"></a>

### 这条 chain 上的 VPFI

**VPFI** 是 protocol 自己的 token。把一些 VPFI 放在 escrow 里，
可以让您享受 protocol fees 折扣，并获得一小笔被动收益 (5% APR)。
在您当前连接的 chain 上，这张卡会显示：

- 您 wallet 中现在有多少 VPFI。
- escrow 中有多少 (这部分计为 "staked")。
- 您持有的 VPFI 占总 VPFI supply 的份额。
- 总共还剩多少 VPFI 可被 mint (protocol 有硬上限)。

Vaipakam 运行在多条 chains 上。其中一条 (Base) 是 **canonical**
chain，新的 VPFI 会在那里 mint；其他 chains 是 **mirrors**，通过
cross-chain bridge 保持同步。从您的角度看，不需要特别操心这些细节
— 无论您在哪条 chain 上，看到的 balance 都是真实的。

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

Vaipakam 可以使用您放在 escrow 中的部分 VPFI，为您抵扣 protocol
fees。这个开关就是 "好的，请这样做" 的 toggle。通常只需要打开一次。

折扣大小取决于您 escrow 中保留的 VPFI 数量：

- **Tier 1** — `{liveValue:tier1Min}` VPFI 或以上 → 减 `{liveValue:tier1DiscountBps}`%
- **Tier 2** — `{liveValue:tier2Min}` VPFI 或以上 → 减 `{liveValue:tier2DiscountBps}`%
- **Tier 3** — `{liveValue:tier3Min}` VPFI 或以上 → 减 `{liveValue:tier3DiscountBps}`%
- **Tier 4** — 超过 `{liveValue:tier4Min}` VPFI → 减 `{liveValue:tier4DiscountBps}`%

您可以随时关闭这个开关。如果您从 escrow 中提取 VPFI，您的 tier
会实时下降。

> **关于 blockchain 网络 gas 的说明。** 上面的 discount 适用于 Vaipakam 的 **protocol fees**（Yield Fee、Loan Initiation Fee）。每次 on-chain action 都需要支付的小额 **gas fee**（在您 create offer、accept、repay、claim 等操作时支付给 blockchain validators）是另一笔费用，归网络所有，不归 Vaipakam。协议本身从不收到这笔费用，因此无法对其打折。

<a id="dashboard.rewards-summary"></a>

### 您的 VPFI 奖励

此卡片将您从协议中获得的每一项 VPFI 奖励整合在一处。顶部的
大数字是合计 — 您已领取的加上等待领取的。

有两个奖励流，卡片按每一个分类总计：

- **质押收益** — 自动从您托管账户中保留的任何 VPFI 上获得。
  比率是 Buy VPFI 页面上显示的协议 APR。
- **平台交互奖励** — 为您参与的每笔贷款，无论哪一方，每天获
  得一点。在您所在的链上以 VPFI 支付，无需桥接。

每行右侧都有一个小的 V 形箭头。单击它可直接跳转到该流的完整
领取卡 — 质押位于 Buy VPFI 页面，平台交互位于 Claim Center。

如果您还没有获得任何奖励，卡片仍会以 *总收益: 0 VPFI* 加上
如何开始的提示渲染。您没有做错什么 — 只是没有历史记录可显示。


---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

下面的市场列表可能会很长。Filters 会按 loan 使用的 asset、offer
来自 lender 还是 borrower，以及其他几个条件来缩小范围。您自己的
active offers 始终显示在页面顶部 — filters 只影响您看到的其他人
发布的 offers。

<a id="offer-book.your-active-offers"></a>

### 您的 Active Offers

**您**发布、但还没有人接受的 offers。只要 offer 还在这里，就可以
免费 cancel。一旦有人 accept，这个 position 就会变成真正的 loan，
并移到 Dashboard 上的 "Your Loans"。

<a id="offer-book.lender-offers"></a>

### Lender Offers

愿意出借的人发布的 offers。每一条大致表示："我愿意以 Z% 的利率、
D 天的期限，借出 X 单位的资产 Y；作为交换，需要这么多 collateral"。

borrower 接受其中一条后，就会成为这笔 loan 的 borrower-of-record：
borrower 的 collateral 会锁进 escrow，principal asset 会到达
borrower 的 wallet，利息会持续累计，直到 borrower repay。

protocol 会在 acceptance 时对 borrower 一侧强制执行一条安全规则：
collateral 的价值必须至少达到 loan 的 1.5 倍。(这个数字称为
**Health Factor 1.5**。) 如果 borrower 的 collateral 不够，loan
不会启动。

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

已经锁定 collateral、正在等待别人来 fund loan 的 borrowers 所发布
的 offers。

lender 接受其中一条后，就会为 loan 提供资金：lender 的 asset 会
转给 borrower，lender 成为 lender-of-record，并在期限内按 offer
的 rate 赚取利息。settlement 时，利息的一小部分 (1%) 会进入
protocol treasury。

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

选择您要站在哪一边：

- **Lender** — lender 提供一个 asset，并在它借出期间赚取利息。
- **Borrower** — borrower 锁定 collateral，并以此为抵押请求另一种
  asset。

对于 "rentable" NFTs (一种可临时委托的特殊 NFT)，还有一个
**Rental** 子选项。Rentals 不出借资金 — 出租的是 NFT 本身，按日
收费。

<a id="create-offer.lending-asset"></a>

### Lending Asset

这里设置参与 loan 的 asset 和金额，以及 interest rate (APR，%)
和 duration (天数)。rate 会在 offer 发布时固定；之后任何人都不能
更改。duration 结束后会有一个短暂的 grace window — 如果 borrower
仍未 repay，loan 可能进入 default，lender 的 collateral claim 会
启动。

<a id="create-offer.lending-asset:lender"></a>

#### 如果您是 lender

您愿意提供的 principal asset 和金额，加上 interest rate (APR，%)
和 duration (天数)。rate 在 offer 时固定；duration 决定 loan 可
进入 default 之前的 grace window。

<a id="create-offer.lending-asset:borrower"></a>

#### 如果您是 borrower

您希望从 lender 那里获得的 principal asset 和金额，加上 interest
rate (APR，%) 和 duration (天数)。rate 在 offer 时固定；duration
决定 loan 可进入 default 之前的 grace window。

<a id="create-offer.nft-details"></a>

### NFT Details

对于 rental offer，这张卡设置每日 rental fee。renter 在 accept
时会预付全部 rental cost，并额外加上 5% 的小 buffer，以防交易
稍微延长。NFT 本身会全程留在 escrow 中 — renter 有使用权，但不能
移动它。

<a id="create-offer.collateral"></a>

### Collateral

为保障 loan 而锁定的资产。两种类型：

- **Liquid** — 具有实时 price feed 的常见 token (Chainlink +
  足够深的 on-chain pool)。protocol 可以实时估值，并在价格走势
  对 loan 不利时自动 liquidate position。
- **Illiquid** — NFT，或没有价格 feed 的 token。protocol 无法估
  值这些资产，所以 default 时 lender 直接获得全部 collateral。
  在创建 offer 之前，lender 和 borrower 都必须勾选同意此条件。

<a id="create-offer.collateral:lender"></a>

#### 如果您是 lender

您希望 borrower 锁定多少 collateral 来保障 loan。Liquid ERC-20s
(Chainlink feed + ≥$1M v3 pool depth) 适用 LTV/HF 计算；illiquid
ERC-20s 和 NFTs 没有 on-chain valuation，需要双方同意 default 时
全额 collateral 转移的结果。

<a id="create-offer.collateral:borrower"></a>

#### 如果您是 borrower

您愿意锁定多少 collateral 来保障 loan。Liquid ERC-20s (Chainlink
feed + ≥$1M v3 pool depth) 适用 LTV/HF 计算；illiquid ERC-20s 和
NFTs 没有 on-chain valuation，需要双方同意 default 时全额 collateral
转移的结果。

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

在 Vaipakam 上出借和借款都有真实风险。签署 offer 之前，这张卡
会要求签署方明确确认。下面的风险对双方都适用；role-specific tabs
会说明每种风险通常如何影响对应的一方。

Vaipakam 是 non-custodial 的。没有客服可以撤销已经确认的
transaction。签署前请仔细阅读。

<a id="create-offer.risk-disclosures:lender"></a>

#### 如果您是 lender

- **Smart-contract risk** — contracts 是不可变代码；未知 bug 可能
  影响资金。
- **Oracle risk** — 过期或被操纵的 price feed 可能将 liquidation
  延迟到 collateral 已不足以覆盖您的 principal 之后。您可能无法
  获得全额补偿。
- **Liquidation slippage** — 即使 liquidation 按时触发，DEX swap
  也可能以比报价更差的价格成交，减少您实际收回的金额。
- **Illiquid collateral** — default 时 collateral 会全额转移给您；
  但如果它的价值低于 loan，您没有进一步追索权。创建 offer 时，您
  已经同意了这种取舍。

<a id="create-offer.risk-disclosures:borrower"></a>

#### 如果您是 borrower

- **Smart-contract risk** — contracts 是不可变代码；未知 bug 可
  能影响您锁定的 collateral。
- **Oracle risk** — 过期或被操纵的 price feed 可能在错误的时刻
  对您触发 liquidation，即使真实市场价格本来安全。
- **Liquidation slippage** — 当 liquidation 触发时，DEX swap 可
  能以比预期更差的价格出售您的 collateral。
- **Illiquid collateral** — default 时您的 collateral 会全额转移
  给 lender，您不再有后续 claim。创建 offer 时，您已经同意了这种
  取舍。

<a id="create-offer.advanced-options"></a>

### Advanced Options

给需要更多控制的用户准备的额外设置 — 大多数人保持默认即可。比如
offer 在 expire 前保持开放多久、是否在这个特定 offer 上使用 VPFI
fee discount，以及一些 role-specific toggles。第一次创建 offer 时，
可以放心先不动这些选项。

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

loan 结束后 — 无论是已 repay、default，还是 liquidate — 您应得的
份额都不会自动进入 wallet。您需要点击 **Claim**。这个页面列出您
在这条 chain 上所有尚未领取的 claims。

同一个用户可以同时拥有 lender claims (来自他 fund 的 loans) 和
borrower claims (来自他借入的 loans) — 两者会出现在同一个列表中。
下面两个 role-specific tabs 说明每种 claim 会返还什么。

<a id="claim-center.claims:lender"></a>

#### 如果您是 lender

您的 lender claim 会返还 loan 的 principal 和累计利息，并从利息
部分扣除 1% 的 treasury cut。loan 一旦 settle (repaid、defaulted
或 liquidated) 就可以 claim。claim 会 atomically consume 您的
lender position NFT — transaction 确认后，loan 的 lender 这一侧
就完全关闭。

<a id="claim-center.claims:borrower"></a>

#### 如果您是 borrower

如果您已经全额 repay loan，borrower claim 会返还您一开始锁定的
collateral。如果发生 default 或 liquidation，则只返还 Loan
Initiation Fee 中未使用的 VPFI rebate — collateral 本身已经转给
lender。claim 会 atomically consume 您的 borrower position NFT。

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

您 wallet 在当前 chain 上相关的每一个 on-chain 事件 — 您发布或
accept 的每一个 offer、每一笔 loan、每一次 repayment、claim 和
liquidation。所有内容都直接从 chain 实时读取；没有可能离线的中心
服务器。最新事件排在最前，并按 transaction 分组，所以一次点击产生
的相关动作会显示在一起。

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### 购买 VPFI

Buy 页面允许您按 protocol 早期阶段的固定 rate，用 ETH swap 成
VPFI。您可以从任何受支持的 chain 发起 — 底层会为您 route 交易。
VPFI 始终会回到您当前连接的 chain 上的 wallet。无需手动切换网络。

<a id="buy-vpfi.discount-status"></a>

### 您的 VPFI Discount Status

快速查看您当前所在的 discount tier。Tier 根据您 **escrow** 中
(不是 wallet 中) 的 VPFI 数量计算。这张卡还会告诉您：(a) 要
升到下一个 tier，escrow 中还需要多少 VPFI；(b) Dashboard 上的
consent switch 是否为 ON — discount 只有在它 ON 时才会生效。

escrow 中的同一笔 VPFI 也会自动视为 "staked"，并赚取 5% APR。

<a id="buy-vpfi.buy"></a>

### Step 1 — 用 ETH 购买 VPFI

输入您想花费的 ETH 数量，点击 Buy，然后签署 transaction。就这样。
为了防止滥用，系统有 per-purchase cap 和 rolling 24-hour cap —
表单旁边会显示 live 数字，让您知道还剩多少额度。

<a id="buy-vpfi.deposit"></a>

### Step 2 — 把 VPFI 存入您的 escrow

购买 VPFI 后，它会进入您的 wallet，而不是 escrow。要获得 fee
discount 和 5% staking yield，您需要亲自把它移入 escrow。这始终
是一个明确的一键操作 — App 不会在未经您同意的情况下移动您的 VPFI。
一笔 transaction (在支持的 chains 上可以是一笔 signature) 即可完成。

<a id="buy-vpfi.unstake"></a>

### Step 3 — 从 escrow 中 unstake VPFI

想把一些 VPFI 拿回 wallet？这张卡会把它从 escrow 送回给您。
请注意：取出 VPFI 会**立即**降低您的 discount tier。如果您有 open
loans，从这一刻起，discount 计算会切换到较低的 tier。

---

## Rewards

<a id="rewards.overview"></a>

### 关于 Rewards

Vaipakam 会因为两类行为向您发放 rewards：

1. **Staking** — 您保留在 escrow 中的 VPFI 自动赚取 5% APR。
2. **Interaction** — 您参与的 loan 每 settle 一美元利息，都会让
   您获得 community-wide reward pool 的每日份额。

两者都以 VPFI 支付，并直接在您当前连接的 chain 上 mint。无需
bridge，也无需切换 chain。

<a id="rewards.claim"></a>

### Claim Rewards

一个按钮会在单次 transaction 中 claim 两个 reward streams 的全部。
Staking rewards 始终可以 real-time claim。interaction-pool 份额
每天 settle 一次；因此，如果您在上次 settlement 之后又赚到一些，
总额中的 interaction 部分要等到下一个 daily window 关闭后不久才会
live。

<a id="rewards.withdraw-staked"></a>

### 提取 Staked VPFI

把 VPFI 从 escrow 移回您的 wallet。一旦回到 wallet，它就不再赚取
5% APR，也不再计入您的 discount tier。这与 Buy VPFI 页面上的
"unstake" step 是同一个 action — 只是为了方便，也在这里提供。

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (本页)

一笔 loan 的所有关键信息都在这一页。它开启时的 terms、现在的
health 状况、两边分别是谁，以及根据您的 role 可以使用的所有按钮
— repay、claim、liquidate、close early、refinance。

<a id="loan-details.terms"></a>

### Loan Terms

loan 的固定部分：出借的 asset、金额、interest rate、duration，
以及到目前为止累计的 interest。loan 开启后这些都不会改变。(如果
需要不同的 terms，可以 refinance — App 会创建一笔新 loan，并在同一
transaction 中偿还旧 loan。)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

这笔 loan 的 collateral，以及 live risk 指标 — Health Factor 和
LTV。**Health Factor** 是一个安全分数：高于 1 表示 collateral 能
比较从容地覆盖 loan；接近 1 则说明风险升高，loan 可能被 liquidate。
**LTV** 表示 "借了多少 vs. 放入的 collateral 价值"。position 变得
unsafe 的 thresholds 也会显示在同一张 card 上。

如果 collateral 是 illiquid (NFT，或没有 live price feed 的 token)，
这些数字无法计算。双方在创建 offer 时已经同意了这种结果。

<a id="loan-details.collateral-risk:lender"></a>

#### 如果您是 lender

这是 borrower 的 collateral — 也就是您的保护。只要 HF 保持在 1
以上，您就有较好的覆盖。当 HF 下降时，保护会变薄；一旦跌破 1，
任何人 (包括您) 都可以 trigger liquidation，DEX swap 会把 collateral
换成您的 principal asset，用来偿还您。对于 illiquid collateral，
default 会把 collateral 全额转给您 — 它在市场上真实值多少，就由您
承担。

<a id="loan-details.collateral-risk:borrower"></a>

#### 如果您是 borrower

这是您锁定的 collateral。请让 HF 安全地保持在 1 以上 — 当它接近
1 时，您就进入 liquidation 风险区。通常可以通过添加更多 collateral，
或 repay 一部分 loan，把 HF 拉回更安全的位置。如果 HF 跌破 1，任何
人都可以 trigger liquidation；DEX swap 可能会以受 slippage 影响的
价格卖出您的 collateral 来偿还 lender。对于 illiquid collateral，
default 会把您的全部 collateral 转给 lender，您没有后续 claim。

<a id="loan-details.parties"></a>

### Parties

这笔 loan 中的两个 wallet addresses — lender 和 borrower — 以及
分别持有他们资产的 escrow vaults。loan 开启时，每一方还会得到一个
"position NFT"。这个 NFT _就是_ 该方领取最终份额的权利 — 请妥善
保管。如果 holder 把它转给别人，新 holder 就会获得 claim 的权利。

<a id="loan-details.actions"></a>

### Actions

这笔 loan 上可用的每个按钮都会显示在这里。您看到的按钮集合取决于
您在这笔 loan 中的 role — 下面的 role-specific tabs 会列出每一方
的 options。当前不可用的按钮会变灰，并附带一个小 tooltip 说明原因。

<a id="loan-details.actions:lender"></a>

#### 如果您是 lender

- **Claim** — 一旦 loan settle (repaid、defaulted 或 liquidated)，
  返还 principal 和 interest，并从 interest 中扣除 1% treasury
  cut。会 consume 您的 lender NFT。
- **Initiate Early Withdrawal** — 在 loan 中途把您的 lender NFT
  挂牌出售给另一买家。买家接管您这一面；您带着销售所得离开。
- **Liquidate** — 当 HF 跌破 1 或 grace period 到期时，任何人
  (包括您) 都可触发。

<a id="loan-details.actions:borrower"></a>

#### 如果您是 borrower

- **Repay** — 全额或部分。部分 repayment 会降低 outstanding 并改善
  HF；全额 repayment 会关闭 loan，并让您通过 Claim 解锁 collateral。
- **Preclose** — 提前关闭 loan。Direct path：现在从您的 wallet
  支付全部 outstanding。Offset path：在 DEX 上卖出一部分 collateral，
  用所得偿还，剩余部分再取回。
- **Refinance** — 用新条款 roll 进新 loan；protocol 在一笔
  transaction 中用新 principal 偿还旧 loan。Collateral 永不离开
  escrow。
- **Claim** — 一旦 loan settle，若已全额 repayment，则返还您的
  collateral；若 default，则返还 Loan Initiation Fee 中剩余的 VPFI
  rebate。

---

## Allowances

<a id="allowances.list"></a>

### Allowances

当您 accept 一个 offer 时，您的 wallet 有时会 "approve" Vaipakam
代您移动某个特定 token。有些 wallets 会把这些 approvals 保留得比
必要时间更长。这个页面会列出您在这条 chain 上给 Vaipakam 的每一个
approval，并允许您一键关闭其中任何一个。Non-zero approvals (实际
仍然 live 的 approvals) 会排在顶部。

保持 approvals 列表干净是一种很好的安全习惯 — 在 Uniswap 或 1inch
上也是一样。

---

## Alerts

<a id="alerts.overview"></a>

### 关于 Alerts

当您的 collateral 价格下跌时，loan 的安全分数 (Health Factor) 也
会下降。Alerts 让您可以选择在任何人 liquidate 您**之前**收到提醒。
一个小型 off-chain service 每五分钟检查您的 loans，并在分数跨过
danger band 的瞬间 ping 您。没有 gas 成本；on-chain 上不会发生
任何事。

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

watcher 使用的 danger bands。跨入更危险的 band 时会触发一次提醒。
下一次 ping 只会在您跨入更深的 band 时发生。如果您回到更安全的
band，ladder 会 reset。Defaults 适合常规 loans；如果您的 collateral
波动很大，可能需要设置更高的 thresholds。

<a id="alerts.delivery-channels"></a>

### Delivery Channels

这里决定 pings 实际发往哪里。您可以选择 Telegram (bot 会给您发
DM)、Push Protocol (直接向您的 wallet 发送 notification)，或两者
都选。两条 rails 共享上面的同一个 threshold ladder — 不需要分别
调整。

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### 验证 NFT

Vaipakam position NFTs 有时会出现在 secondary markets。向其他
holder 购买之前，请在这里粘贴 NFT contract address 和 token ID。
verifier 会确认：(a) 它是否确实由 Vaipakam mint，(b) underlying
loan 在哪条 chain 上，(c) 该 loan 当前处于什么 state，(d) 链上当前
NFT holder 是谁。

position NFT _就是_ 从 loan 中 claim 的权利。识别假 NFT — 或已经
settle 的 position — 可以帮您避开糟糕的交易。

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### 关于 Keepers

"keeper" 是您信任的 wallet，可以代您对 loans 执行特定 maintenance
actions — 例如 complete early withdrawal、finalize refinance 等。
keepers 永远不能花您的钱 — repay、add collateral、claim、liquidate
都保持 user-only。您最多可以 approve 5 个 keepers，并可以随时关闭
master switch，一次性 disable 所有 keepers。

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

列表中的每个 keeper 只能执行**您为其 tick 的 actions**。所以一个
只被允许 "complete early withdrawal" 的 keeper，不能替您 initiate
新的流程 — 只能完成您已经 initiate 的流程。如果您改变主意，可以
edit ticks；如果想完全移除某个 keeper，就把它从列表中删除。

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### 关于 Public Analytics

整个 protocol 的 wallet-free、透明视图：total value locked、
loan volumes、default rates、VPFI supply、recent activity。一切都
从 on-chain data 实时计算 — 这个页面上的任何数字背后都没有 private
database。

<a id="public-dashboard.combined"></a>

### Combined — 所有 Chains

汇总所有受支持 chains 后得到的 protocol-wide totals。小字
"X chains covered, Y unreachable" 会告诉您页面加载时是否有某条
chain 的 network 离线 — 如果有，对应 chain 会在下面的 per-chain
table 中被标记。

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

相同的 totals，按 chain 拆分。可以用来查看哪条 chain 拥有最高 TVL、
大多数 loans 发生在哪里，或发现某条 chain 是否停滞。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

VPFI 在这条 chain 上的 live state — 总量有多少、实际 circulating
有多少 (扣除 protocol-held balances 后)，以及 cap 下还剩多少可以
mint。按设计，所有 chains 上的 supply 都是 bounded。

<a id="public-dashboard.transparency"></a>

### Transparency & Source

这个页面上的每个数字都可以直接从 blockchain 重新推导出来。这张卡
会列出 snapshot block、data 最近一次 fetch 的时间，以及每个
metric 来自哪个 contract address。如果有人想 verify 某个数字，这
就是起点。

---

## Refinance

此页面仅限 borrower — refinance 由 borrower 在自己的 loan 上发起。

<a id="refinance.overview"></a>

### 关于 Refinancing

Refinancing 会在不动用您 collateral 的情况下，把现有 loan roll
进一笔新 loan。您发布一个使用新 terms 的 borrower-side offer；一旦
lender accept，protocol 会在同一笔 transaction 中偿还旧 loan 并
open 新 loan。您的 collateral 不会出现没有保护的空档。

<a id="refinance.position-summary"></a>

### 您的当前 Position

您正在 refinance 的 loan 的 snapshot — outstanding 有多少、累计
了多少 interest、health 状况如何、锁定了什么。用这些数字来合理
确定新 offer 的 size。

<a id="refinance.step-1-post-offer"></a>

### Step 1 — 发布新 Offer

您发布一个 borrower offer，包含 refinance 想使用的 asset、amount、
rate 和 duration。在它 list 期间，旧 loan 会照常运行 — interest
仍在累计，您的 collateral 保持原状。其他用户会在 Offer Book 中看
到这个 offer。

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

一旦 lender accept 您的 refinance offer，点击 Complete。protocol
随后会 atomically：用新的 principal 偿还旧 loan，open 新 loan，并
在整个过程中保持您的 collateral 锁定。一笔 transaction，两个 state
变化，没有 exposure window。

---

## Preclose

此页面仅限 borrower — preclose 由 borrower 在自己的 loan 上发起。

<a id="preclose.overview"></a>

### 关于 Preclose

Preclose 的意思是 "提前关闭我的 loan"。您有两条 path：

- **Direct** — 现在从您的 wallet 支付全部未偿余额。
- **Offset** — 在 DEX 上出售部分 collateral，用所得偿还 loan。
  剩下的归您。

如果您有 cash，Direct 通常更便宜。如果您没有 cash，但也不想让
loan 继续运行，Offset 就是可用的出口。

<a id="preclose.position-summary"></a>

### 您的当前 Position

您正在提前关闭的 loan 的 snapshot — outstanding、累计 interest、
当前 health。提前关闭是 fee-fair 的 — 没有固定 penalty；protocol
的 time-weighted VPFI math 会处理计算。

<a id="preclose.in-progress"></a>

### Offset In Progress

您刚刚 initiate 了 offset preclose，swap step 还在 mid-flight。您
可以 complete 它 (proceeds 会 settle loan，任何剩余都会返回给您)，
也可以 — 如果价格在您思考期间移动 — cancel 并用新的 quote 重试。

<a id="preclose.choose-path"></a>

### 选择 Path

如果您现在有 cash 可以偿还 loan，选择 **Direct**。如果您希望在
退出时卖出一部分 collateral，选择 **Offset**。两条 paths 都会完全
关闭 loan；preclose 不能只关闭一半。

---

## Early Withdrawal (Lender)

此页面仅限 lender — early withdrawal 由 lender 在自己的 loan 上发起。

<a id="early-withdrawal.overview"></a>

### 关于 Lender Early Exit

如果您想在期限结束前退出 loan，可以通过 protocol 把您的 lender
NFT list 出售。buyer 会为此向您付款；作为回报，他们接管您这一侧
的 position — 之后由他们收取最终 repayment + interest。您带着 sale
proceeds，以及 buyer 支付的任何 premium 离开。

<a id="early-withdrawal.position-summary"></a>

### 您的当前 Position

您正在退出的 loan 的 snapshot — principal、到目前为止累计的
interest、剩余时间，以及 borrower 当前的 health score。buyer 判断
您的 NFT 值多少钱时，会看的就是这些数字。

<a id="early-withdrawal.initiate-sale"></a>

### Initiate the Sale

您设置 asking price，protocol 会 list 您的 lender NFT，然后您等待
buyer。一旦 buyer accept，proceeds 会进入您的 wallet，loan 继续
运行 — 但您不再参与其中。只要 listing 仍然 open 且未成交，您就
可以 cancel。
