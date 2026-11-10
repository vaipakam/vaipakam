# Vaipakam — 用户指南 (Basic Mode)

这是 App 中每张 card 的友好、清晰说明。每个章节都对应 card 标题
旁边的 `(i)` info icon。

> **您正在阅读 Basic 版本。** 它对应 App 的 **Basic** 模式
> (界面更简单、控件更少、默认设置更稳妥)。如果想看更技术化、
> 更详细的 walkthrough，请将 App 切换到 **Advanced** 模式 —
> 打开 Settings (右上角的齿轮图标) → **Mode** → **Advanced**。
> 之后 App 内的 (i) "Learn more" 链接会开始打开 Advanced 指南。

---

<a id="chapter.dashboard"></a>

## Dashboard

<a id="dashboard.your-vault"></a>

### 您的 Vault

把您的 **vault** 想象成 Vaipakam 里的私人金库。它是一个只由您
控制的小型 contract。每当您参与一笔 loan — 无论是放入 collateral，
还是把某个 asset 借出 — 相关资产都会从您的 wallet 移入这个金库。
它们不会与任何人的资金混在一起。loan 结束后，您可以直接从这里
claim 取回。

您不需要自己 "创建" vault；第一次需要时，App 会自动帮您创建。
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

**VPFI** 是 protocol 自己的 token。把一些 VPFI 放在 vault 里，
可以让您享受 protocol fees 折扣。在您当前连接的 chain 上，这张卡
会显示：

- 您 wallet 中现在有多少 VPFI。
- vault 中有多少 (这部分计入您的 discount tier)。
- 您持有的 VPFI 占总 VPFI supply 的份额。
- 总共还剩多少 VPFI 可被 mint (protocol 有硬上限)。

Vaipakam 运行在多条 chains 上。其中一条 (Base) 是 **canonical**
chain，新的 VPFI 会在那里 mint；其他 chains 是 **mirrors**，通过
cross-chain bridge 保持同步。从您的角度看，不需要特别操心这些细节
— 无论您在哪条 chain 上，看到的 balance 都是真实的。

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

Vaipakam 可以根据您放在 vault 中的 VPFI，为您提供 protocol fees
折扣。对 borrower 来说，这个折扣就是更低的 Loan Initiation Fee，在
loan 开始时以 loan 自身的 asset 收取——不会为此花费任何 VPFI。这个开关
就是 "好的，请这样做" 的 toggle。通常只需要打开一次。

折扣大小取决于您 vault 中保留的 VPFI 数量：

- **Tier 1** — `{liveValue:tier1Min}` VPFI 或以上 → 减 `{liveValue:tier1DiscountBps}`%
- **Tier 2** — `{liveValue:tier2Min}` VPFI 或以上 → 减 `{liveValue:tier2DiscountBps}`%
- **Tier 3** — `{liveValue:tier3Min}` VPFI 或以上 → 减 `{liveValue:tier3DiscountBps}`%
- **Tier 4** — 超过 `{liveValue:tier4Min}` VPFI → 减 `{liveValue:tier4DiscountBps}`%

您可以随时关闭这个开关。如果您从 vault 中提取 VPFI，您的 tier
会实时下降。

> **关于 blockchain 网络 gas 的说明。** 上面的 discount 适用于 Vaipakam 的 **protocol fees**（Yield Fee、Loan Initiation Fee）。每次 on-chain action 都需要支付的小额 **gas fee**（在您 create offer、accept、repay、claim 等操作时支付给 blockchain validators）是另一笔费用，归网络所有，不归 Vaipakam。协议本身从不收到这笔费用，因此无法对其打折。

<a id="dashboard.rewards-summary"></a>

### 您的 VPFI 奖励

此卡片将您从协议中获得的每一项 VPFI 奖励整合在一处。顶部的
大数字是合计 — 您已领取的加上等待领取的。

奖励来自 **平台交互** — 为您参与的每笔贷款，无论哪一方，您每天
都会获得一点。在您所在的链上以 VPFI 支付，无需桥接。

该行右侧有一个小的 V 形箭头。单击它可直接跳转到 Claim Center 中
的完整领取卡。

如果您还没有获得任何奖励，卡片仍会以 *总收益: 0 VPFI* 加上
如何开始的提示渲染。您没有做错什么 — 只是没有历史记录可显示。


---

<a id="chapter.offer-book"></a>

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
borrower 的 collateral 会锁进 vault，principal asset 会到达
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
的 rate 赚取利息。settlement 时，利息的一小部分 (`{liveValue:treasuryFeeBps}`%) 会进入
protocol treasury。
该 rate 在 loan 创建时即已固定，因此之后 protocol fee 的调整不会改变一笔已经开启的 loan。

---

<a id="chapter.create-offer"></a>

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
稍微延长。NFT 本身会全程留在 vault 中 — renter 有使用权，但不能
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

<a id="chapter.claim-center"></a>

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
部分扣除 treasury cut。这个 cut 的比例在 loan 创建时即已固定，
之后协议费用的调整不会改变它。按当前费率创建的 loan，其 cut 为
`{liveValue:treasuryFeeBps}`%。loan 一旦 settle (repaid、defaulted
或 liquidated) 就可以 claim。claim 会 atomically consume 您的
lender position NFT — transaction 确认后，loan 的 lender 这一侧
就完全关闭。

<a id="claim-center.claims:borrower"></a>

#### 如果您是 borrower

如果您已经全额 repay loan，borrower claim 会返还您一开始锁定的
collateral。如果发生 default 或 liquidation，也请查看一下。系统只会取走偿还债务
和了结它所需的那部分价值，超出的部分都会记在您名下。它以什么形式存在，
取决于 loan 是如何结束的：如果 collateral 经交易所被卖出，剩余部分
会以 loan 自身的 asset 到您手中。如果它是被交出而非卖出，等着您的
就是 collateral 本身。交出它的情况不止一种，且都与 loan 以哪种方式结束无关：liquidator 按折扣直接拿走，close-out 没有卖出、
而是在协议内部与一个反向 position 撮合，或者这笔卖出根本没能成交——那里 collateral 会给到您——除非 lender 在 claim 时带来一份能成交的报价，那样就按 loan 自身的 asset
支付；而大多数并不带报价。普通 liquidation 和 default 都会在去交易所之前先找这种内部撮合，所以这两种的结果都不是固定的——请读
claim，而不要从结束方式去推断。按折扣直接拿走是例外，而且是反方向的确定：它从不卖出，留给您的始终是 collateral。在无法定价的 collateral 上发生
default 时，整个 basket 都会被取走、什么也不剩——在这条路径上这是规则，而非不走运的结果。
claim 会 consume
您的 borrower position NFT。反过来却不成立：liquidation 之后 NFT 仍在，
并不证明有什么在等着您。如果什么也没剩下，就没有可领取的东西，去 claim 会被拒绝，而
NFT 仍可能留着。请读 claim 本身怎么说，不要把
NFT 当作承诺。

---

<a id="chapter.activity"></a>

## Activity

<a id="activity.feed"></a>

### Activity Feed

您 wallet 在当前 chain 上相关的每一个 on-chain 事件 — 您发布或
accept 的每一个 offer、每一笔 loan、每一次 repayment、claim 和
liquidation。所有内容都直接从 chain 实时读取；没有可能离线的中心
服务器。最新事件排在最前，并按 transaction 分组，所以一次点击产生
的相关动作会显示在一起。

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### 获取 VPFI

VPFI 可自由转让。您可以在 VPFI 交易的任何 open market 上获取它，
或者把它 bridge 进来 — VPFI 是 Chainlink CCIP token，因此可以
通过 official bridge 在受支持的 chains 间移动，并到达您当前连接
的那条 chain 上的 wallet。

<a id="buy-vpfi.discount-status"></a>

### 您的 VPFI Discount Status

快速查看您当前所在的 discount tier。Tier 根据您 **vault** 中
(不是 wallet 中) 的 VPFI 数量计算。这张卡还会告诉您：(a) 要
升到下一个 tier，vault 中还需要多少 VPFI；(b) Dashboard 上的
consent switch 是否为 ON — discount 只有在它 ON 时才会生效。

<a id="buy-vpfi.deposit"></a>

### 把 VPFI 存入您的 vault

放在 wallet 中的 VPFI 不计入 discount tier。要解锁 fee discount，
您需要亲自把 VPFI 移入 vault。这始终是一个明确的一键操作 — App
不会在未经您同意的情况下移动您的 VPFI。一笔 transaction (在支持
的 chains 上可以是一笔 signature) 即可完成。

<a id="buy-vpfi.unstake"></a>

### 从 vault 中 withdraw VPFI

想把一些 VPFI 拿回 wallet？这张卡会把它从 vault 送回给您。
请注意：取出 VPFI 会**立即**降低您的 discount tier。如果您有 open
loans，从这一刻起，discount 计算会切换到较低的 tier。

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### 关于 Rewards

Vaipakam 会向您发放 **平台交互 reward**：您参与的 loan 每实际
settle 一美元利息，都会让您获得 community-wide reward pool 的
每日份额。

Rewards 以 VPFI 支付，并直接在您当前连接的 chain 上 mint。无需
bridge，也无需切换 chain。

<a id="rewards.claim"></a>

### Claim Rewards

一个按钮会在单次 transaction 中 claim 您累计的全部 rewards。
interaction-pool 份额每天 settle 一次；因此，如果您在上次
settlement 之后又赚到一些，它要等到下一个 daily window 关闭后
不久才会 live。

---

<a id="chapter.loan-details"></a>

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
分别持有他们资产的 vault vaults。loan 开启时，每一方还会得到一个
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
  返还 principal 和 interest，并从 interest 中扣除 loan 创建时
  固定的 treasury cut (按当前费率创建的 loan 为
  `{liveValue:treasuryFeeBps}`%)。会 consume 您的 lender NFT。
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
  vault。
- **Claim** — 一旦 loan settle，若已全额 repayment，则返还您的
  collateral；若 default，也可能还有 surplus：系统只取走偿还债务
  和了结它所需的那部分 collateral，您多存入的部分会记为您的 claim。
  具体是什么取决于路径——参见 Claim Center 一节。

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### 关于 Alerts

当您的 collateral 价格下跌时，loan 的安全分数 (Health Factor) 也
会下降。Alerts 让您可以选择在任何人 liquidate 您**之前**收到提醒。
一个小型 off-chain service 每五分钟检查您的 loans，并在分数跨过
danger band 的瞬间 ping 您。没有 gas 成本；on-chain 上不会发生
任何事。

<a id="alerts-inbox"></a>

### 提醒收件箱

提醒页面按从新到旧的顺序，列出协议索引为你的钱包在当前网络上保存的提醒。它是免费的，无需注册任何服务。贷款开始、部分或全部还款、违约或被清算、临近到期、进入或离开宽限期、健康度降到 1.5、1.2 或 1.05 以下时，以及奖励条目临近或超过领取期限时，都会写入一条提醒。每条提醒都会打开对应贷款的页面（该页面从链上读取），奖励则打开 Claims 页面。顶部钱包旁边的铃铛会统计你上次在此浏览器打开该页面之后收到的提醒数量。如果无法读取索引，页面会如实说明，而不是显示空的收件箱。Telegram、推送、健康度警告和还款提醒就在收件箱下方设置。每条提醒说明的是写入时的情况；要查看当前状态，请打开该贷款。

<a id="alerts-channels"></a>

### Telegram、推送与警告

在收件箱下方，提醒页面设置会在应用之外送达你的提醒。每项更改都是钱包中的一次免费签名，而不是交易。要连接 Telegram，请点击“连接 Telegram”，在十分钟内把一次性代码发给 Vaipakam 机器人，然后发送一条测试提醒：这条消息到达你的聊天后，连接即为有效。只有当提醒服务表示现在可以发送时才提供推送；你还需要在推送应用中订阅 Vaipakam 频道，要停止就在那里取消订阅。设置 Telegram 或推送后，健康度警告始终开启，在健康度 1.5、1.2 和 1.05 时提醒。还款提醒可以关闭和开启。页面显示的是此浏览器做过的操作；在其他设备上做的连接或设置可能仍然存在。

<a id="alerts-paid-push"></a>

### 付费推送提醒

在部分网络上，提醒服务会为关于贷款的推送提醒收取少量 VPFI 费用。只有你事先在链上同意后它才能向你收费，并且最多只能收你同意支付的上限。“付费推送提醒”部分会显示此网络上的费用，以及服务是否在这里收费。费用从你金库中的空闲 VPFI 扣除，每笔贷款的每一方最多扣一次，在发送关于该贷款的第一条付费推送提醒时扣除；已扣的费用不退还，Telegram 提醒免费。上限之内的费用上涨无需再次征求同意即可收取。你可以随时撤回同意。

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### 关于 Public Analytics

一个无需钱包、针对单个网络的协议视图：也就是应用正在读取的网络。
你无需连接任何东西。页面基于两个公开来源，并标明每个数字来自哪一个
——任何人无需密钥即可查询的公共索引器，以及平台合约本身——所以你
永远不必凭信任接受一个数字。

<a id="public-dashboard.loans-offers"></a>

### 借贷与报价

按状态统计的借贷笔数（活跃、已还款、违约、已清算等）和按状态统计
的报价笔数，来自公共索引器。索引器未报告的笔数显示为"未报告"，绝不
显示为零。这里只统计链上报价：免 Gas 的签名订单不计入此处，尽管它们
会出现在 Offer Book 中。报价总数是当前记录在册的报价，不是累计数。

<a id="public-dashboard.recycling"></a>

### 回收账户与闭环

每天的奖励池从哪里来、其中提取了多少，以及通过领取支付的奖励 VPFI
中有多少留在平台内部。这些是来自公共索引器的记账记录；尚不清楚的
数字会如实说明，而不是显示为零。

<a id="public-dashboard.transparency"></a>

### 透明度与来源

平台合约地址（附在区块浏览器中打开的链接）、网络、索引器读取的
最后一个区块以及距今多久。索引器的数字只新到那个区块为止，所以会
显示它的时长。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI 代币

直接从平台合约读取，而不是从索引器：VPFI 代币的地址及其在此网络
上的供应量。在发行 VPFI 的网络上，页面还会显示供应上限、上限内仍可
铸造的数量，以及唯一获准铸造的地址。在 VPFI 通过跨链桥到达的网络
上，只显示该网络的供应量。

<a id="public-dashboard.fees"></a>

### 费用与金库

同样从合约读取：协议自记录开始以来、过去一天和过去一周记录的费用，
以及费用流向的金库地址。页面会标明读取的区块、此次读取的时长和调用
的函数，并说明费用数字可能低于实际收取金额的每一个原因。更换参考货
币后，之前的费用仍保留旧单位，可能使合计偏高也可能偏低，页面也会说
明这一点。无法读取的数字会如实说明，而不是显示为零。

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.next-app"></a>

## 下一版应用

Vaipakam 应用的下一版正在与当前版本并行、一页一页地构建。尚未
构建的页面会如实说明，并带你前往仍在提供该页面的当前应用。本章
介绍已经构建好的页面。

<a id="advanced-mode"></a>

### Basic 与 Advanced

Basic 显示大多数人需要的内容。Advanced 增加退出与结算工具、自动化、
签名订单、keeper 状态和账务明细。切换模式绝不会隐藏你需要给出的
同意、阻止你的事项或解决办法。每个紧跟在所解释句子后的信息按钮 (i) 都会打开完整
说明，其中的"阅读更多"链接会以你当前的模式打开本指南。

<a id="wallet"></a>

### 你的 wallet 与数字的来源

应用首先通过你 wallet 自己的网络连接读取你的 loan、vault 和
claim。只有当 wallet 不提供连接时，才会使用只读代理。你自己的
数字从不取自共享索引。顶部显示的地址和网络，就是页面上每个数字
所属的地址和网络。如果你的 wallet 在应用不支持的网络上，在你
切换之前不会显示任何属于你的内容。选择顶部的地址即可查看完整地址、复制、切换到应用支持的其他 network，或断开连接。应用不读取 Ethereum mainnet 上的任何内容，因此显示地址本身，而不是名称服务的名字。

<a id="deployments"></a>

### 部署支持哪些功能

在提供任何操作之前，应用会读取你所在网络上的协议 contract 目前
支持哪些功能。升级可能改变这份列表；读取它，应用就能告诉你哪里
变了，而不是直接失败。如果列表无法读取，就不会提供任何签名步骤。

<a id="home-start"></a>

### Home：选择要做的事

Home 以"我想要……"开始：借入、出借、租用 NFT、出租你的 NFT，或
管理你已有的内容。每个选项都会打开一个引导页面。借入和出借会先
显示匹配的报价，如果没有合适的，可以发布你自己的报价。租赁涵盖
双方：使用别人的 NFT，或在 NFT 留在 vault 中的同时让别人使用你的
NFT。连接 wallet 后，Home 还会显示三张可隐藏的简短入门卡片。

<a id="home-status"></a>

### Home：协议状态

Home 始终说明协议在你的网络上是否正在运行。因事件暂停期间，新
仓位、claim、提取、清算、违约和 keeper 步骤都会停止。全额还款、
部分还款和追加抵押品仍然可用，暂停的时间会加到每笔未结 loan 的
到期日上。自动暂停持续固定时间，新的自动暂停只能在冷却期之后
开始。keeper 服务可以单独暂停，但这绝不会阻止你自己的操作。如果
状态无法读取，Home 会在顶部说明，而不是假定协议正在运行。

<a id="home-payouts"></a>

### Home：可领取

当一笔 loan 已经结束、现在 claim 就能付款给你时，这笔款项就是可
领取的：对出借方是还款，对借款方是退回的抵押品（或剩余部分），
租赁结束时则是归还的 NFT。Home 会把它们列在最前面，并带你前往
Claims，在领取之前那里会显示每一笔金额。

<a id="home-loans"></a>

### Home：你的 loan

每笔进行中的 loan 都会显示你的角色、条款、抵押品和下一个期限，
最紧急的排在最前。loan 在到期日到期。之后是宽限期，在此期间借款方
仍可支付滞纳金后还款。宽限期结束后，任何人都可以发起违约，用抵押品
结清该 loan。health factor 把抵押品的价值与债务相比较：低于 1 时，
loan 可能被清算。没有价格的资产的 loan 没有 health factor。从你的
同一个报价开出的多笔 loan 会合并显示。

定期付息的 loan 在到期日之前（含到期日当天）还有付息节点。付息节点的宽限期结束时仍未支付的利息，可以通过出售抵押品来支付，loan 仍保持未结；Home 会显示下一个付息节点，并把欠付的排在最前，即使它恰好落在到期日，因为它的宽限期可能早于 loan 的宽限期结束。协议可以关闭这项结算；此时 Home 会说明付息节点不会出售抵押品。

<a id="home-exposure"></a>

### Home：借出与借入

当你同时出借和借入时，Home 按今天的价值比较两边。无法估值的
loan（例如 NFT 或没有价格的资产）只计数量并排除在外；只有在它们
不可能改变结论时，Home 才会指出哪一边更大。

<a id="home-faucet"></a>

### Home：测试资产

在测试网络上，Home 提供测试代币和 NFT，让你无需真钱就能试用借款、出借和租赁。它们没有价值，由测试代币合约铸造，而不是由协议铸造。部分测试代币有测试价格，因此以其计价的贷款有健康因子；另一些没有价格，违约时会直接交出抵押品本身。测试 NFT 可以出租。每次铸造都会先显示收据，之后再在链上核对结果。

<a id="home-fee-discount"></a>

### Home：手续费折扣

手续费折扣是针对整个钱包、每个网络各一项的设置。关闭时，无论你持有多少 VPFI，手续费都没有折扣。开启时，借款时支付的手续费会减少，作为出借人所赚利息上的手续费也会减少，减少幅度取决于每笔手续费收取时你的 VPFI 折扣等级；等级 0 没有折扣。在某些网络上，出借人折扣以你金库中的 VPFI 支付，确认前收据会说明适用哪种方式。开启需要已接受当前的服务条款；关闭则从不需要。协议暂停期间，这项设置在两个方向上都无法更改。以非流动出借资产发放的贷款仍需支付全额借款手续费，且任何折扣都不会超过手续费的一半。

<a id="home-rewards"></a>

### Home: 奖励

奖励是对你在此网络上出借和借款的使用返利，按奖励日计算，以 VPFI 支付。应用会先把领取当作预览运行，因此 Home 显示的正是现在领取将支付的金额。如果预览无法运行，Home 会改为显示一个注明为下限的数值，并在能够算出准确金额之前不提供领取。一次领取最多支付 30 个奖励日；如有剩余，Home 会提供再次领取，中途停下是安全的。领取会送入你的金库，可直接使用；金库无法接收时则送入你的钱包；领取绝不会开设金库。当某个奖励日仍在等待跨网络最终确认，或等待其资金到达此网络时，Home 会写明是哪一天，而不是提供一个会失败的领取。奖励不是利息或收益，领取也绝不会质押或再投资任何东西。 偶尔，一次领取不支付任何金额，但会越过未向您支付任何金额的奖励日，以便之后的日期可以支付；Home 会说明这一点并照样提供领取。

<a id="home-rewards-expiry"></a>

### Home: 奖励移除日期

在未领取奖励可能被移除的网络上，Home 会显示你的奖励中最早的预计移除日期，并在此之前的最后 90 天内显示最终通知。在此之前领取，奖励一定会保留。按当前情况，估计日期绝不会晚于实际日期：奖励无法领取的时间会使实际日期推后，但网络领取窗口的变化可能使其提前，因此依赖它之前请再次确认。如果未能检查每一笔奖励，Home 会如实说明，而不是说没有到期的奖励。如果网络不移除任何奖励，则不显示日期。

<a id="home-rewards-held"></a>

### Home: 暂扣的奖励

如果制裁筛查标记了你的钱包，在标记持续期间不会向其支付任何奖励。标记之前赚得的奖励会为其暂扣，处于锁定而非丢失状态，并在钱包不再被标记后释放；届时 Home 会提供单独领取恰好这笔余额。在标记被确认期间赚得的奖励将被永久没收，金库中的 VPFI 也无法转移。如果无法读取钱包是否仍被标记，则不会释放任何奖励。

<a id="borrow-start"></a>

### Borrow: 如何运作

借款时，你接受出借人挂出的公开报价：某种代币的金额、利率、期限，以及出借人要求的抵押品。接受后，一笔交易即可开立贷款。你的抵押品从钱包转入你自己的金库，在贷款存续期间保持锁定；金额扣除一小笔发起费后进入你的钱包。你需在到期日前偿还本金和利息。没有合适的报价时，你也可以发布自己的借款请求，等待出借人。

<a id="borrow-pair"></a>

### Borrow: 选择代币

先选择要借的代币和要锁定的代币。应用会推荐网络上的代币，你也可以粘贴代币地址；不会进行任何代币安全筛查，请自行核对粘贴的地址。对每种代币，应用都会读取协议当前对它的判断。有流动性的代币有价格，因此贷款有健康因子，抵押品贬值时可能被清算。无流动性的代币估值为零，违约时出借人直接获得抵押品本身。当协议不信任某种代币的价格时，在恢复信任之前，以它开立的新贷款会被关闭；已开立的贷款不受影响。

<a id="borrow-offers"></a>

### Borrow: 选择报价

页面列出你所选两种代币上出借人的公开报价，直接从协议读取。每条报价显示金额、利率和期限、要求的抵押品、按今日价格计算的贷款价值比、计息方式、是否有付息计划、报价何时结束，以及扣除费用后你将收到的金额。报价须整体接受，按出借人的全部金额和最低利率。如果协议会拒绝某条报价，页面会说明原因且不显示按钮。排序只是为了方便，不构成建议。

页面首先列出两种借款方式：立即接受一个报价，或通过请求设定你自己的利率并等待出借人。报价按利率分组，最低的在前，每一档显示其中有多少个报价以及每个报价的金额；金额从不相加，因为你一次完整接受一个报价。你可以输入你接受的最高利率，它只会隐藏报价并说明隐藏了多少。在请求旁边，页面显示为你的币对随时待命的出借人：当请求的条款符合他们的限制时，撮合服务会用他们的资金成交该请求，因此成交很可能发生，但既不即时也不保证。

<a id="borrow-review"></a>

### Borrow: 审核与签名

在钱包打开之前，审核页会列出每个数字：你将收到的金额、费用、你要锁定的抵押品、利率、到期日应还金额、宽限期，以及你可能失去的东西。你需要勾选同意风险披露和条款；如果确认前数字发生变化，勾选会被清除。随后钱包会请你签署条款（不产生费用），如有需要，批准与抵押品完全相同的额度，然后发送接受交易；发送前应用会先做一次试运行。如果在批准之后中止，应用会请你把批准恢复原状，并告诉你是否已恢复。完成后，应用会在链上核对开立的贷款、到账金额和锁定的抵押品。它还会列出贷款存续期间的条款，即使是默认值也逐项说明：部分还款、出售抵押品，以及任何再融资或关联贷款。应还金额假定期间没有暂停：暂停会使到期日相应推后，而利息在暂停期间照常累计。审核页还会显示协议现在对该金额和抵押品的估值；这些数字仅供参考，会随价格变动。

<a id="borrow-fee"></a>

### Borrow: 发起费

开立贷款需支付金额的一小部分，一次性、以所借代币收取，并从你收到的金额中扣除；审核页会显示当前费率。利息按全部金额计算。当费用折扣开启且所借代币有流动性时，你的折扣等级会降低这笔费用。这笔费用不会收取或扣留任何 VPFI，之后也不会退还任何款项。 由于接受交易由你自己发送，协议支付给匹配提交者的那一小部分费用会随金额一起返还给你；审核页会显示这笔金额。

<a id="borrow-risks"></a>

### Borrow: 风险

贷款可能让你失去抵押品。如果在宽限期结束前没有还款，贷款将违约，出借人从你的抵押品中获得偿付：协议能出售的就为其出售，不能的就原样移交。对于有流动性的抵押品，如果其价值下跌导致健康因子低于 1，任何人都可以清算该贷款，你会失去抵押品。采用全期利息时，即使提前还款，也要支付整个期限的利息。如果有付息计划，未付的期次会通过出售你的部分抵押品来支付。在贷款还清或结算之前，你的抵押品保持锁定。

<a id="borrow-request"></a>

### Borrow：发布你自己的请求

没有合适的报价时，你可以为这两种代币发布自己的借款请求：确切金额、你愿意支付的利率、期限，以及你锁定的抵押品。发布时，抵押品会从你的钱包转入你自己的金库，在请求开放期间一直留在那里。出借人接受请求后，会按你的条款立即开立贷款，不会再询问你；金额扣除开立费用后到达你的钱包。发布五分钟后你即可取消，抵押品会回到你的钱包。过期的请求不能再被接受；其抵押品留在你的金库中，直到你或任何人将其关闭，之后只会退回你的钱包。在下一版应用的报价页面建成之前，请在当前应用的报价页面跟进、取消和关闭请求；审核页会在锁定任何资产之前说明这一点。在你输入的每个金额下方，表单会显示协议现在以其自身单位对它的估值；对于没有价格的资产，它会说明这一点，而不是给出数字。

<a id="borrow-request-terms"></a>

### Borrow：请求的条款

要么由一位出借人承接全部金额，要么无人承接。每个数字都按你输入的原样精确读取：超过代币小数位数的部分会被拒绝，绝不四舍五入；利率最高为年化 100%，最多两位小数。可选期限以网络允许的最长期限为止；你也可以按天数输入期限。请求一直开放，直到被接受或取消，或在你选择的天数内开放，最长一年。全期利息是常见选择，即使提前还款也需付满；按比例计息只按贷款存续的时间收费。表单会显示若出借人现在接受，按今天的费率你将收到的金额，以及到期日应还的金额。

<a id="borrow-request-review"></a>

### Borrow：审核并发布请求

在钱包打开之前，应用会请协议对你的请求做一次试运行，因此审核页显示的是协议自己的答复。它列出你现在锁定的抵押品、金额、利率和期限、你将收到的金额以及费用如何确定（按出借人接受时生效的费率，减去你当时的费用折扣等级；显示的数字按今天的费率计算）、你应还的金额、贷款存续期间的每项条款、请求何时过期、贷款价值比，以及是否需要批准。你需要勾选同意风险披露和条款。如有需要，钱包会批准与抵押品完全相同的额度，应用再次试运行请求，然后才发布。如果在批准之后中止，应用会请你把批准恢复原状，并告诉你是否已恢复。完成后，应用会在链上核对记录的请求和锁定的抵押品。

<a id="borrow-nft-collateral"></a>

### Borrow：以 NFT 作为抵押品

请求可以锁定一个 NFT 而不是代币。将该系列选为你要锁定的资产（测试系列已标记为 NFT，也可以粘贴地址）；一个地址是代币还是 NFT 系列，从其合约读取。然后输入该 NFT 的编号，即它的代币 ID，可在你的钱包或该系列页面上看到；表单会立即告诉你钱包是否持有它。无论 NFT 在别处售价多少，协议都将其估值为零：以它为抵押的贷款没有贷款价值比，也没有基于价格的清算；如果你在宽限期结束前未还款，出借人将获得该 NFT 本身。发布时，你的钱包只授权协议移动这一个 NFT，绝不授权你系列中的其他 NFT，而把它转入你的金库会自动清除该授权；如果请求在授权后停止，应用会请求恢复授权，并说明是否完成。按数量发行的 NFT（多代币系列）也以同样方式使用，只是带有数量：输入代币编号和要锁定的数量，表单会显示你的钱包持有多少。这类系列无法只授权一个代币，只能授权你在其中的全部代币，因此发布时只为这一个请求授予该授权，并在之后多一步钱包操作将其收回，无论请求是否成功；你此前已给出的授权保持你设置的样子。接受要求 NFT 的出借人报价目前仍在当前应用中完成。

<a id="borrow-request-range"></a>

### Borrow: 金额范围（高级）

在高级模式下，请求可以接受一个范围：出借人可出借的最小和最大金额，按您的同一利率，并可按需为最小的贷款设定较少的抵押品。直接接受请求的出借人出借最小金额，只锁定为其设定的抵押品，其余退回您的钱包。网络开启撮合期间，撮合可以出借更多，最多到最大金额；审核会说明是否开启，以及关闭期间该范围只成交一次。协议会拒绝您的抵押品按今日价格无法支撑的最大金额，审核会给出它能支撑的上限。审核显示两端的贷款价值比，并在出借人按今日价格无法直接接受该请求时发出警告。在高级模式中设定的选项切换到基础模式后仍然有效：表单会说明并允许您清除。撮合只锁定其出借人要求的抵押品，至少为下限；因此审核页会给出最大撮合从全部抵押品到仅下限的范围，并提醒撮合的贷款可能比直接接受的贷款风险更高。撮合开启期间，撮合未锁定的抵押品会留在请求中供后续撮合使用，只有在请求关闭或您取消它时才会退回您的钱包。

<a id="borrow-request-fill"></a>

### Borrow: 请求如何成交（高级）

默认的部分成交允许撮合通过一笔或多笔贷款成交请求，直到成交、取消或失效。全部或全无只允许一次成交全部金额，因此不能与范围同用。立即或取消像部分成交一样成交，但只到请求失效为止，因此需要设置有效期。成交方式在发布后不能更改；如需更改，请取消请求并发布新的请求。请求开放期间，协议允许更改金额、利率和抵押品，但不能低于撮合已使用的部分；本应用尚未提供此功能，因此目前要更改只能取消后重新发布。

<a id="borrow-request-cadence"></a>

### Borrow: 利息支付计划（高级）

在高级模式下，请求可以按计划支付利息，而不是在还款时一次付清：每月、每季度、每半年或每年。表单只提供协议对你的条件允许的计划，并在每个不可选的计划下说明原因：网络上的定期利息已关闭、某项资产没有价格、贷款价值低于协议的门槛（两个数字都会显示），或周期不短于贷款期限。审核页会显示每个周期的利息，以及逾期周期的宽限期。如果某个周期在宽限期结束前未支付，任何人都可以出售你的部分抵押品来支付，贷款继续有效。计划在发布后不能更改。与其他高级选项一样，切换到基础模式后它仍然适用，表单也会提示这一点。

<a id="borrow-request-tariff"></a>

### Borrow: 全额费用档（高级）

在高级模式下，请求可以选择全额费用档：每笔贷款开立时从您的金库中以 VPFI 收取的一笔费用，可让贷款费用的折扣再增加十个百分点，最高至协议的 50% 上限。贷款费用本身仍以出借资产收取，费用档不予退还。表单只在协议开启它时提供此选项，并显示按您的金额和期限计算的今日费用档。您设定一笔贷款最多可收取多少 VPFI（留空则为最大一笔贷款的今日费用档），以及开立时无法收取费用档的贷款如何处理：拒绝，或不带费用档开立。只有在那一刻费用档已开启、出借资产有价格且具流动性、其费用档在您的上限内、且您的金库有足够的可用 VPFI 时，贷款才能收取它。费用档在请求发布后通过第二笔交易设定，因此在该交易确认前接受请求的出借人开立的贷款不带费用档。对于无人接受的请求，本应用尚未提供兜底出借。

<a id="lend-start"></a>

### Lend: 如何运作

出借时，您为借款人的公开请求出资：某种代币的金额、借款人将支付的利率、期限，以及借款人已锁定在自己金库中的抵押品。出资后，贷款在一笔交易中开立。金额从您的钱包转出，借款人收到扣除其发起费后的金额，抵押品在贷款结束前一直为您锁定。您在贷款中的一方是钱包里的一枚仓位代币，持有它的人就是收款人。借款人在到期日前偿还金额加利息，协议从利息中保留其份额。没有合适的请求时，您可以在同一页面改为发布自己的出借报价。

<a id="lend-offers"></a>

### Lend: 选择请求

先选择要出借什么、接受什么抵押品；两者必须是不同的代币，本页面只提供代币。页面列出该交易对的公开借款请求，直接从协议读取。每个请求显示金额、利率和期限、已锁定的抵押品、按今日价格计算的贷款价值比、利息的计收方式、任何利息计划，以及借款人的费用中有多少返还给您。请求须整笔出资：如果它给出一个范围，您按借款人的最高利率出借其最小金额。当协议会拒绝某个请求时，页面会说明原因，且不提供按钮。您自己的请求、含 NFT 的请求以及进行中贷款的出售只计数，不列出。排序（先是您可以出资的请求，再按最高利率）仅为方便，并非建议。

<a id="lend-review"></a>

### Lend: 审核与签名

在您的钱包打开之前，审核会显示每个数字：从您钱包转出的金额、借款人收到的金额、费用及其中您的份额、为您持有的抵押品、利率、到期日应付的利息、其中协议的份额、返还给您的金额、宽限期，以及您可能损失什么。它还会说明每项生命周期条款，即使是默认值。如果您的钱包余额少于该金额，审核会说明差多少，且不提供签名。您勾选一个框以同意风险披露和条款；若确认前数字发生变化，勾选会被清除。随后钱包会请您签署条款（不产生费用），在需要时精确批准该金额，并发送接受交易，应用会先进行试运行。如果在批准后中止，应用会请您撤回批准，并告知是否已撤回。之后，应用会在链上核对它开立的贷款、从您钱包转出的金额以及返还的金额。

<a id="lend-fee"></a>

### Lend: 费用与协议份额

发起费由借款人承担：金额的一小部分，以出借资产收取一次，从借款人收到的金额中扣除。您出借全部金额，借款人须连本带息全额偿还。由于接受交易由您亲自发送，这笔费用中的一小部分，即协议支付给撮合提交者的份额，会返还到您的钱包；审核会显示它。如果借款人选择了全额费用档且贷款开立时生效，费用会更低，这部分份额也会更低。支付利息时，协议按贷款开立时有效的费率保留其份额；在您的费用折扣设置开启期间，您的费用折扣等级可以降低该份额。审核显示今日费率以及该份额的上限。

<a id="lend-risks"></a>

### Lend: 风险

出借可能让您亏钱。如果借款人在宽限期结束前未还款，贷款违约，您从抵押品中获得偿付：协议能出售时为您出售，不能时按原样交给您，而出售所得可能低于您应得的金额。对于具流动性的抵押品，一旦贷款的健康因子低于 1，任何人都可以清算该贷款；出售所得先偿付您，但价格急跌可能使剩余低于您应得的金额。缺乏流动性的代币估值为零，因此没有基于价格的清算，违约时您将获得全部抵押品，无论其价值几何。在贷款结束前您不能收回金额；提前退出意味着把您的仓位卖给另一位出借人。按比例计息时，提前还款会让您收益更少。暂停会使到期日推后，期间利息继续累计。

<a id="lend-offer"></a>

### Lend：发布您自己的报价

没有合适的请求时，您可以为这两种代币发布自己的出借报价：您出借的确切金额、您要求的利率、期限，以及借款人必须锁定的抵押品。发布时，金额会从您的钱包转入您自己的金库，在报价开放期间一直锁定在那里。借款人接受报价后，会按您的条款立即开立贷款，不会再询问您：借款人收到扣除其发起费后的金额，其抵押品为您锁定在其金库中。在网络开启撮合期间，任何人也可以把您的报价与借款人的请求撮合；未设部分时，这样的贷款按您的利率出借您的全部金额，抵押品至少为您要求的数量。审核会说明撮合目前是否开启。发布五分钟后您即可取消，金额会回到您的钱包。过期的报价不能再被接受；其金额留在您的金库中，直到您或任何人将其关闭，之后只会退回您的钱包。在下一版应用的报价页面建成之前，请在当前应用的报价页面跟进、取消和关闭报价；审核页会在锁定任何资产之前说明这一点。

<a id="lend-offer-terms"></a>

### Lend：报价的条款

除非您在高级模式中设置了部分，否则要么由一位借款人承接全部金额，要么无人承接，且借款人必须锁定您设定的确切抵押品数量。表单会显示您钱包中持有多少出借代币。每个数字都按您输入的原样精确读取：超过代币小数位数的部分会被拒绝，绝不四舍五入；利率最高为年化 100%，最多两位小数。可选期限以网络允许的最长期限为止。报价一直开放，直到被接受或取消，或在您选择的天数内开放，最长一年。全期利息是常见选择，意味着提前还款不会减少您的收益；按比例计息只按贷款存续的时间付给您。您也可以允许借款人提前偿还部分款项。表单会显示若借款人现在接受，到期日借款人应还给您的金额。在高级模式中，报价还可以分部分出借、设置成交方式、按计划支付利息并选择全额费用档。

<a id="rate-check"></a>

### 将你的利率与近期贷款比较

在两个发布表单（出借人的报价和借款人的请求）上，利率下方会显示过去 30 天内以相同币对、相同期限开始的贷款的中间利率，以及笔数。如果你的利率偏离超过五个百分点，应用会提醒你，并说明影响的方向：远低于市场的出借人，或远高于市场的借款人，发布的是利率变动时最先被接走的报价；反方向时，报价可能一直无人接受。这只是提醒，你仍然可以发布。没有可比较的近期贷款、抵押品是 NFT，或无法读取协议的索引时，表单会直接说明，而不是保持沉默。

<a id="public-queue"></a>

### 有公开队列的网络

在以太坊、BNB Chain 和 Polygon（以及 BNB Testnet 和 Polygon Amoy）上，你发送的交易在被打包前会在公开队列中等待，任何观察该队列的人（包括机器人）都能看到它并抢先行动：在你的取消到达前接走报价，或在你的还款到达前对贷款采取行动。因此在这些网络上，发布、接受或取消报价，还款以及追加抵押品的审核会在钱包打开前说明这一点。有些钱包可以改为私下发送交易；请查看钱包的网络或安全设置。应用无法替你选择这条路径，按常规方式发送只会改变交易到达前谁能看到它。Base、Arbitrum 和 Optimism 没有公开队列，因此不会显示任何内容。

<a id="lend-offer-parts"></a>

### Lend：分部分出借的报价（高级）

在高级模式中，出借报价可以分部分出借。您输入的金额仍是全部金额：发布时会锁定全部金额，直接承接您报价的借款人借走全部金额。您另外填写一次撮合可出借的最小部分。在网络开启撮合期间，撮合者可以把您的报价出借给多位借款人，每笔贷款介于最小部分和剩余金额之间，按您的利率计息。每笔撮合至少要求与其部分相应比例的抵押品，向下取整，审核会显示最小部分要求的抵押品。一旦某次撮合出借了一部分，任何借款人都不能再直接承接剩余部分；只有更多撮合可以，您也可以取消报价收回剩余部分。剩余金额少于最小部分时，协议会把它退回您的钱包并关闭报价。审核会说明撮合目前是否开启；撮合关闭期间，只有承接全部金额的借款人才能开立贷款。成交方式与请求相同：默认部分成交；全部或不成交只允许一笔覆盖全部金额的贷款（因此不能分部分）；立即成交或取消需要设置到期时间；发布后成交方式不能更改。若报价要求的抵押品少于全部金额按今日价格所需的数量，协议会拒绝，审核会给出它要求的最低数量。在高级模式中设置的选项切换到 Basic 后仍然有效：表单会说明这一点，并让您清除它们。

<a id="lend-offer-schedule"></a>

### Lend：报价的利息支付计划（高级）

在高级模式下，出借报价可以像请求一样设置利息支付计划：每月、每季度、每六个月或每年。表单只提供协议对您的条件允许的计划，并在每个未开放的计划下说明原因。分部分出借时，协议在发布时检查最小部分，因此低于其门槛的最小部分会关闭更细的计划；每笔贷款开立时还会再次检查。审核会显示借款人承接全部金额时每期的利息，分部分时还显示最小部分贷款的每期利息，以及错过一期时的宽限期。如果某一期在宽限期结束前未支付，任何人都可以出售借款人的部分抵押品来向您支付，贷款保持开放。发布后计划不能更改。

<a id="lend-offer-tariff"></a>

### Lend：报价的全额费用档（高级）

在高级模式下，出借报价可以选择全额费用档：从该报价开立的每笔贷款开立时，从您的金库中以 VPFI 收取的一笔费用，按该笔贷款的金额和期限计价。作为回报，协议对该笔贷款利息收取的份额可再享十个百分点的折扣，最高至其 50% 上限；该份额仍以出借资产收取。额外折扣在贷款期限内有效：若贷款延期进入新期限，新期限内不再享有。它属于出借人仓位，因此支付利息时持有该仓位的人获得它。费用档不予退还。表单显示全部金额（报价开立的最大一笔贷款）的今日费用档。您设定一笔贷款最多可收取多少 VPFI，以及无法收取费用档的贷款是被拒绝还是不带费用档开立。只有在那一刻费用档已开启、出借资产有价格且具流动性、其费用档在您的上限之内、且您的金库有足够的可用 VPFI 时，贷款才能收取它。费用档由发布后的第二笔交易设置，因此在其确认前由借款人或撮合从报价开立的贷款不带费用档。

<a id="lend-offer-review"></a>

### Lend：审核并发布报价

在钱包打开之前，应用会请协议对您的报价做一次试运行，因此审核页显示的是协议自己的答复。它列出您现在锁定的金额、借款人承接的金额、借款人必须锁定的抵押品、利率和期限、按今天的费率借款人将收到的金额、到期日的利息、其中协议的份额以及返还给您的金额、贷款存续期间的每项条款、报价何时过期、按今天价格计算的贷款价值比，以及是否需要批准。如果您的钱包余额少于该金额，审核会说明差多少，且不提供签名。您需要勾选同意风险披露和条款。如有需要，钱包会精确批准该金额，应用再次试运行报价，然后才发布。如果在批准之后中止，应用会请您把批准恢复原状，并告诉您是否已恢复。完成后，应用会在链上核对记录的报价和锁定在您金库中的金额。

<a id="lend-offer-fee"></a>

### Lend：您报价的费用

发布报价不向您收取任何费用。发起费由借款人承担：是金额的一小部分，在借款人接受您的报价时以出借资产一次性收取，按当时生效的费率计算，并从借款人收到的金额中扣除。您出借全部金额，借款人须连本带息全额偿还。支付利息时，协议按贷款开立时生效的费率保留其份额；在您的费用折扣设置开启期间，您的费用折扣等级可以降低该份额。审核会显示今天的费率以及该份额最多能拿走多少；如果无法读取该费率，审核会说明这一点，而不显示数字。

<a id="positions"></a>

### Positions：你的借贷仓位

Positions 根据你的钱包持有的仓位代币，列出你在此网络上出借或借入的每一笔贷款，因此你转让给他人的仓位会从列表中移除。最先列出可领取的款项，点击会打开 Claims。接着是进行中的贷款，与 Home 一样，最紧迫的期限排在最前。最后是已结束的贷款，每笔都注明结束方式：已还款、已违约、已结算或因撮合而关闭。仍有待领取款项的已结束贷款会引导你前往 Claims。

全部、出借、借入可同时筛选三个列表。只有在全部读取完成后，Positions 才会说你什么都没有；如果某个列表未能完整读取，它会明确说明。每笔贷款都会打开它自己的页面，显示你可以进行的操作。列表本身从不签署任何内容。

<a id="position"></a>

### Position：一笔贷款

每笔贷款都有自己的页面。页面先显示贷款状态，然后是你的角色：由于仓位代币可以出售或转让，角色取决于你的钱包现在持有哪一方。如果你不持有任何一方，你只是在查看。与你相关的期限会按你的一方来表述。宽限期结束后，页面会说明现在任何人都可以发起违约处理，且仅在协议确认时才会这样显示。

其下是贷款的日期（当前期限在暂停补时之前的到期日、协议暂停期间补加的时间、到期日和宽限期结束时间）、当前的条款（部分还款会减少尚欠的本金）、健康因子以及抵押品的存放位置。无法读取的数字会显示为未知。如果抵押品没有价格，违约时出借人将直接获得抵押品本身，页面会说明这一点。若网络在清算阈值上方保留一段区间用于与另一笔贷款内部撮合，页面会说明：在该区间内，任何外部出售都无法结清这笔贷款。NFT 租赁没有抵押品：违约时租用方的使用权终止，预付租金扣除协议份额后归出借人，缓冲金归金库。全额还款、部分还款、追加和取回抵押品是它的首批操作，其他操作将在后续更新中提供。

<a id="repay"></a>

### 全额还款

对进行中的贷款，页面提供全额还款。除出借人外，任何人都可以还款。如果您不持有借款人头寸，付款不会让您获得抵押品的任何权利：只有该头寸的持有人才能领取。宽限期结束后（贷款随即进入违约），以及有 swap-to-repay 订单待处理期间，还款会被暂停。

欠款按秒增长，协议按您的还款确认那一刻的金额收取。确认页显示两个数字：现在的费用，以及约三十分钟后的费用。您的钱包恰好批准第二个数字。如果您之前批准的额度更大（包括无限额度），还款期间会把它降到这个数字，因为还款本身不设上限。批准限制的是金额，不是时间：之后才确认的还款，只有在欠款仍在批准额度内时才会成交，否则会被拒绝，资金不会移动。对按全期收取利息的贷款，到期日前金额不会增长，因此之后的还款仍可能成交。还款没有用完的批准额度会在之后恢复原状。随后借款人在 Claims 领取抵押品，出借人领取本金和利息。

<a id="interest-schedule"></a>

### 利息计划

有利息计划的贷款在每个周期（一个月、一个季度、六个月或一年）都要付息，而不只是在到期时。其页面显示当前周期：何时结束、宽限期何时结束、本期应付利息、已支付的金额以及仍欠的金额。一个周期的利息按当前的本金和利率计算，因此部分还款会降低它。

一个周期及其宽限期结束后，任何人都可以结算该周期。已付清的周期只会把检查点向前推进；仍有不足的周期，会出售恰好足以覆盖欠款和出售费用的借款人抵押品。页面会说明现在是否可以结算。当网络的定期结算开关关闭时，页面会点名说明（此时无法结算，也不会出售抵押品）；协议暂停期间也会说明（结算停止，暂停时间计入该周期的日期）。暂停会把周期的日期按暂停时长往后推，但一个周期应付的利息仍是一个周期的金额；暂停期间利息照常累积，还款所付的利息都会计入该周期。

<a id="partial-repay"></a>

### 偿还部分贷款

在贷款条款允许时，借款人头寸的持有人可以在进行中贷款的页面上偿还部分本金。输入要偿还的本金：协议接受不低于该出借代币的最低部分、且少于全部本金的金额（全部偿还请用"全额还款"）。自上次支付利息以来累计的利息会另外加上。贷款以较低的本金继续，到期日不变。

审核界面会显示偿还部分、利息、剩余本金以及授权覆盖的金额。按比例计息的贷款在到期日之前，利息是精确的。全期计息的贷款或已过到期日时，会显示"最多"：应用读取的协议数值还包含剩余期限的利息或滞纳金，而部分还款并不收取这些。当贷款有有效的再融资请求、或借款人头寸上有有效的抵消报价时，以及宽限期结束后，部分还款会暂停。

<a id="add-collateral"></a>

### 追加抵押品

借款人头寸的持有人可以在进行中贷款的页面上为其追加抵押品。追加抵押品会提高贷款的健康因子、降低其贷款价值比，使其离清算更远。只能追加贷款已持有的同一种代币：协议不接受其他代币，并且只对它当前能定价的抵押品接受追加。输入数量，表单会显示你钱包中的余额。

审核界面显示追加前后的抵押品、存放位置（你的金库，在贷款结束前锁定于该贷款），以及贷款当前的健康因子和贷款价值比。如果你现有的授权不足以覆盖该数量，钱包会恰好授权这个数量，应用会先以试运行方式尝试追加。完成后，应用会显示协议自己计算的追加后健康因子和贷款价值比。即使协议处于暂停状态，追加抵押品仍然开放。处于回退状态的贷款，如果追加恢复了协议的开仓限额，就会回到进行中；否则抵押品会被追加，贷款仍处于回退状态。若贷款被清算或违约，你追加的抵押品可能与其余抵押品一同损失。如果你接手了借款人头寸且贷款处于回退状态，追加部分会进入贷款记录的借款人的金库，只有当它使贷款回到进行中时才会转入你的金库。

<a id="take-back-collateral"></a>

### 取回抵押品

贷款进行期间，借款人头寸的持有人可以在贷款页面取回超出贷款所需的抵押品。协议会计算可取回的上限，使健康因子不低于贷款的最低值，贷款价值比不超过开立时的上限。该上限随价格和利息累积而变化，输入时表单会显示它。取回抵押品会使贷款更接近清算。

审核会显示当前和取回后的抵押品、抵押品从您的金库转入您的钱包、当前上限，以及贷款当前的健康因子和贷款价值比。无需授权，因此在应用以试运行方式尝试取回后，您的钱包只需确认一次。取回确认时协议会再次检查上限：如果价格变动导致金额不再符合，取回会被拒绝，任何资产都不会移动。协议暂停、待处理的换币还款订单、有效的再融资请求或出借人的出售挂单都会阻止取回，并且协议只允许取回它能定价的代币抵押品。如果你的账户开启了保护模式，抵押品会先在账户的付款队列中等待其延迟期，然后才到达你的钱包，审核会说明这一点。

<a id="collect-a-payout"></a>

### 领取款项

贷款结束后，协议会记录每一方应得的款项，每个头寸的持有人可在贷款页面或“Claims”中领取。款项付给当前持有头寸的人，所以你买下的头寸会付给你。出借人的款项是本金和利息，或违约、清算收回的金额，另加为出借人保留的资金；如果是租赁，还有出租的 NFT。借款人的款项是退回的抵押品或剩余部分，另加为借款人保留的盈余。领取会销毁你的头寸代币，双方都领取后，贷款即告结清。

审核页会列出这笔领取所做的每一项付款、出借人头寸的前任卖家先拿走的部分（已赚取但未支付的利息），以及款项的去向：你的钱包，或在开启保护模式时，进入你账户的付款队列或你的金库。无需授权，因此应用先模拟运行领取之后，钱包只会询问一次。协议暂停时，所有领取都会停止。贷款处于回退状态时，借款人的款项要等出借人领取之后才能领取，而出借人领取会结束回退：借款人将无法再补救。完成卡片会显示这笔交易实际支付了什么。

<a id="claim-everything"></a>

### 全部领取

Claims 页面以「全部领取」开头：把您现在可以领取的每一笔款项汇总到一笔交易中。其中列出您持有头寸的已结束贷款的款项、互动奖励、您常设报价中尚未借出的资金、金库中的可用 VPFI，以及（如果您是收款人）可提取的薪酬。每笔款项都有开关，您可以排除其中任何一笔。金库中的可用 VPFI 决定您的手续费折扣等级，因此除非您打开，否则默认关闭；仍在放贷的常设报价的资金也是如此。您已出售头寸所欠您的利息，以及处于回退（fallback）状态的贷款，需单独领取。每笔款项在交易内各自执行：协议拒绝的款项会被跳过并保留在列表中，其余款项照常支付。一笔交易最多包含 30 笔款项，其余的等待第二笔交易。没有任何资金离开您的钱包，因此您的钱包会在一次试运行后只请求一次，完成卡片会显示每笔款项是已领取还是被跳过，以及资金到达的位置。暂停期间所有领取都会停止。

<a id="payout-queue"></a>

### 在你的队列中等待的款项

开启保护模式后，从你的金库流向你钱包的一切款项都会在付款队列中等待你账户设定的延迟。「领取」页面会列出在那里等待的款项，最早到期的排在前面，每一笔都有一个简短的请求代码：关于某笔款项的每条提醒都会显示同一个代码，方便你把消息与请求对应起来。每一行都会说明它支付什么、去往哪里以及何时可以放行。款项到期后，任何人都可以放行它，而且它只会支付给记录的目的地；如果该目的地已不再被允许，放行会改为取消它。你或你的任一次级签名人都可以随时取消一笔款项，即使在暂停期间也可以，资产会留在你的金库中。如果你的账户要求批准，每笔款项都需先由一位次级签名人批准；签名人在高级模式下粘贴你账户的地址即可找到它。暂停期间，放行会被搁置，直到暂停结束，或在长时间暂停后其应急通道开启。每项操作只会请求你的钱包一次，完成卡片会显示这笔交易做了什么。

<a id="seller-interest"></a>

### 已出售头寸的利息

出售出借人头寸后，您持有期间赚取但尚未收到的利息，仍作为对该贷款的债权归您所有。Claims 列出您持有此类债权的每笔贷款，显示扣除协议利息份额后您应得的金额，以及已在您金库中等待的金额。贷款进行期间，每笔利息付款都先按从旧到新的顺序支付未结债权，付入每位卖方自己的金库；在有款项到达您的金库之前，没有可提取的金额。贷款结束后，提取会先分配出借人一方收回的款项：先是持有人的本金，再按从旧到新的顺序支付每位卖方的债权。此时所有未结债权都会关闭，债权未获支付的部分仍未支付。贷款通过应用的索引找到；如果索引无法列出，可按贷款编号查询，编号查询只读取链上数据。无需任何授权，因此钱包在试运行后只请求一次，完成卡片会显示交易实际支付的内容。

<a id="frozen-proceeds"></a>

### 当一笔付款被冻结时

如果制裁筛查标记了您的钱包，协议不会拿走您应得的任何款项，也绝不会阻止任何贷款结清：对方仍会收到其一方收回的款项。您的份额会被锁定存放在一个金库中，并在您的钱包被移出名单后释放。此时 Claims 和贷款页面会显示“已冻结，等待移出名单”，且不提供领取按钮。如果无法读取筛查，而您的钱包此前已被确认标记，被冻结的付款会保持锁定，直到筛查再次响应，在此期间应付给您钱包的款项也会以同样方式暂存，因为协议仍将其视为已标记；单纯的故障从不会冻结一个从未被确认标记的钱包。对于进行中的贷款，贷款页面还会显示贷款已经支付、在出借人领取之前为出借人头寸预留的金额；已还清的贷款若仍在等待借款人尚未领取的盈余，也会说明。

<a id="extension-reserves"></a>

### 展期储备

如果您持有某笔贷款的借款人头寸，可以把该贷款的代币预留在您自己的金库中用于展期。展期无论由执行者发起还是由您自己发起，都会先从这笔储备中扣取。储备始终属于您。Claims 会列出您仍有剩余储备的每笔贷款，并说明展期是否仍能从中扣取：只有在贷款进行中且您持有其借款人头寸时才可以。只要协议未暂停，无论贷款处于何种状态，您都可以随时取回全部储备；如果贷款仍在进行中，其下一次展期届时将改从您该代币的其他余额中扣取。贷款通过应用的索引查找；如果索引无法列出，请按编号查找贷款。无需授权，因此您的钱包会在一次试运行后只请求一次，完成卡片会显示资金到达的位置。

<a id="vault-holdings"></a>

### 你的金库

金库页面显示你在当前连接网络上的自有金库：完整地址，以及指向区块浏览器的链接。它是协议只为你的钱包保管的合约；其中的资产不会与任何他人的资产混合，资产只会按协议的规则离开。如果你还没有金库，页面会说明并提供创建；你的第一笔存入或第一个报价也会自动创建它。创建不移动任何资产，也不要求任何授权，所以钱包只询问一次。每项资产显示协议给出的三个数字：在你的金库中（协议在那里计为你的数量）、现在可自由提取、被你的头寸占用（你的贷款、报价、领取、储备或排队付款所占用的部分）。通过普通转账进入金库的代币不计入，在你认领之前无法提取；该行会说明这一点，并链接到认领或放弃它的地方。页面列出你存入的资产，以及你的贷款、你创建的报价和常设报价所涉及的资产，因此通过普通转账发送的代币只有在其中之一涉及它时才会显示。小额行和空行隐藏在一个显示其数量的开关后面。金库中的 VPFI 决定你的手续费折扣等级；为此持有并不会将其质押，你质押给贷款或报价的 VPFI 会显示为被占用。有可自由提取部分的每项资产都带有“提取”按钮。

<a id="vault-deposit"></a>

### 存入你的金库

金库页面上的存入功能会把一种代币或一个 NFT 从你的钱包移入你自己的金库，不涉及任何贷款。选择要存入的资产：建议的代币或测试集合，或粘贴一个地址；它是代币、NFT 还是多代币集合，从其合约中读取。然后输入数量、NFT 的代币 ID，或代币 ID 和数量。如果有你尚未接受的服务条款正在生效，应用会先请你接受；如果你切换到尚未接受条款的钱包，签名前会再次请你接受。审阅页说明什么离开你的钱包、进入哪个金库；如果你还没有金库，存入会先创建它。代币需要恰好等于数量的授权，NFT 只需对那一个代币的授权，多代币集合需要的授权会在存入后立即通过再一次钱包操作撤回。协议会在你的钱包发送前检查这笔存入，并拒绝不能全额到账的代币，例如转账时扣费的代币。如果存入没有完成，应用会请你把授权恢复原样。到账的部分计为你的资产。未开启保护模式时可立即提取；开启后，提取需等待账户的延迟期，账户锁定期间什么都不能取出。审阅页会说明适用哪一种。协议暂停期间，存入关闭。

<a id="vault-withdraw"></a>

### 从金库提取

在金库页面的某项资产上点“提取”，会把可自由提取的部分取回你的钱包。可自由提取，指未被任何贷款、报价、索赔、常设报价或排队中的付款占用；由协议自己的数字决定，表单会显示它并拒绝超出部分。存入记录只记下合集的 NFT，可在该合集下输入代币 ID 来提取。应用只提取到签名的钱包。审阅页说明从哪个金库取出什么、去往哪里。未开启保护模式时立即到账。开启后，协议会在账户的延迟期内将其排队，如账户要求，还需次级签名人批准；你可以在“索赔”页面的付款队列中取消排队中的提取，它会留在你的金库中。账户锁定期间无法提取任何东西。不会从你的钱包转出任何东西，也不需要授权。协议暂停期间，提取在其逃生通道开启前一直关闭；参见“协议暂停时”。

<a id="vault-safety"></a>

### 账户安全

金库页面上的“账户安全”卡片显示你的账户是否启用保护模式、它的延迟、每次放行是否需要次级签名人批准、你的仓位 NFT 是否受保护、队列中有多少笔付款在等待，以及每一项仍待生效的更改。开启保护模式后，从你的金库到你钱包的每一笔付款都要等待一段延迟，这样拿走你钱包的窃贼无法在你察觉之前清空你的金库；别人的金库付给你的款项会改为进入你的金库，而你欠别人的款项不会被延迟。在基础模式下，延迟是协议允许的最短时长，两天，仓位 NFT 保护保持关闭；高级模式下你可以选择最长五天，并保护你的仓位 NFT。“立即锁定”会取消每一笔排队中的付款（资产留在你的金库中），停止开设新仓位，并丢弃每一项待生效的更改；还款和追加抵押品照常可用，暂停期间锁定也有效。解锁是一项申请，只有在账户的延迟期过后才生效；到期后，“应用到期更改”会连同其他已到期的更改一起应用它。你的付款队列显示在卡片下方。如果该网络的协议没有保护模式，卡片会说明它不可用；如果无法读取，卡片不提供任何操作，并提醒你不要以为它已关闭。每个操作只请求钱包确认一次，完成卡片显示协议记录的结果。

<a id="vault-escape"></a>

### 协议暂停时

协议暂停期间，金库页面会在顶部说明：提取已关闭，而全额和部分还款以及追加抵押品仍然开放。如果是管理暂停，页面还会按协议的报告显示其逃生通道何时开启，并附倒计时。通道开启后，在任何有可自由提取部分的资产上点“提取”，会把属于你的部分直接取回你的钱包；审阅页会说明它经由逃生通道，而该通道绝不会退回贷款、报价或索赔占用的资产。开启保护模式时，你的提取仍照常在付款队列中等待账户的延迟。自动暂停或尚未启动的协议不会开启逃生通道，页面会说明没有已安排的通道。

<a id="my-offers"></a>

### 你的报价

报价页面按从新到旧列出你在当前连接网络上创建的每一个报价，以及你现在持有其仓位代币的每一个报价。每个报价都显示协议报告的状态：开放、已成交、已售出、已过期或已取消，列表上方的筛选器统计每种状态的数量。借款请求在有人接受之前，其抵押品已通过市场挂单售出时，显示为已售出：没有开出任何贷款，出售所得进入创建者的金库。开放的报价会把它出借或抵押的资产留在你的金库中，直到成交或取消；已过期的报价会一直留着，直到有人清理。当协议取消一个尚未成交任何部分的报价时，会清除它的条款，因此页面只显示它的编号和状态。如果你创建的报价的仓位代币在另一个钱包手中，你仍可以取消它，退回的资产归你；如果你持有另一个钱包创建的报价，到期前只有那个钱包能取消它。你的报价下方是报价簿，下文介绍。

<a id="offer-book"></a>

### 报价簿

你的报价下方是报价簿，按从新到旧列出网络上所有开放的报价，只有在连接钱包后才会读取。标签页把代币贷款和 NFT 租赁分开，筛选器可显示出借人的报价、借款人的请求或两者，连接钱包后还可以隐藏你自己的报价。较早的报价通过“显示更早的报价”加载；筛选只作用于已读取的部分，计数行会说明读取了多少。报价簿来自协议的索引，可能比链慢几分钟，因此它只为你指出报价：打开一个报价即可看到链上保存的状态。已过期的报价会标记为已过期；任何人都可以清理它，它锁定的资产会退回给创建者。如果无法读取索引，报价簿会如实说明，而不是显示没有报价。

<a id="offer-detail"></a>

### 报价页面

每个报价都有自己的页面，连接钱包后从链上读取。页面显示发布者、金额、已成交部分、抵押品、期限以及报价何时失效。你可以在那里整笔接受一个开放的贷款报价，流程与“借款”和“出借”相同的审核与同意：从出借人的报价借款，或为借款人的请求出资。取消和清理在那里的用法与你的报价相同。租赁、以 NFT 作抵押的报价、进行中贷款的出售以及提前结清的报价目前仍在当前应用中接受，页面提供了链接。你审核期间报价不会为你保留；其他人可能先接受或取消它。

<a id="offer-cancel"></a>

### 取消报价

在你创建的开放报价上点击取消，会把它从报价簿撤下，并退回它仍锁在你金库中的资产：借出报价未借出的金额或其 NFT、借款请求未使用的抵押品，或租赁请求预付的费用和缓冲金。尚未成交任何部分的报价在最初五分钟内不能取消，这样取消永远不会与他人的接受抢先；确认页会说明何时可以取消，并到时自动解除限制。已成交的部分保持成交。已过期的报价有一个清理按钮，以同样方式退回它锁定的资产；任何人都可以清理已过期的报价，退回的资产总是归其创建者。确认页会说明退回什么、退到哪里：未开启保护模式时立即到达你的钱包；开启时，它会在付款队列中等待你账户的延迟，或在账户锁定期间留在你的金库中。若应用无法算出退回数额，例如与进行中贷款绑定的报价，确认页会说明这一点，完成卡片会显示实际转移的内容。协议暂停期间不能取消。没有任何资产离开你的钱包，也不要求任何授权，因此钱包只询问一次。

<a id="risk-access"></a>

### Risk Access：你的风险等级

每个账户都从最低的风险等级开始，即仅限蓝筹资产，只有你本人可以提高它。一个交易对需要其中风险较高的代币所要求的等级：蓝筹代币无需任何等级，其他具有流动性的代币需要“流动性资产”，而非流动性代币需要“任何资产，包括非流动性资产”，并且需要你对该确切交易对表示同意。当接受报价或发布请求需要这样的步骤时，审核界面会就地说明，并以一次钱包确认的形式提供，附有其自身的收据：改变什么、覆盖哪些交易对、何时生效，以及不会移动任何资金。提高等级或同意某个交易对，可能需要等待协议设定的期限；对于提高的等级，应用会显示从链上读取的生效时间；对于同意，应用会说明协议尚未公布该时间；并且绝不会两次提供同一步骤，因为第二次会让等待重新开始。降低等级总是立即生效。当协议发布新的风险条款时，你的等级和同意在你再次确认之前不再计算。如果你开启了严格模式，每个具有流动性的交易对也需要你的确认。由贷方自身风险等级造成的阻挡会显示为贷方的问题：你账户中的任何设置都无法改变它。

<a id="terms-gate"></a>

### 服务条款确认

当某个服务条款版本生效时，应用会在开始新事项的操作之前（例如开启手续费折扣）请你接受它，并说明是哪个操作提出的请求。它会显示版本、条款文本的指纹，以及指向该确切版本的链接，该版本的文本永不改变。接受只需在钱包中确认一次，不会移动任何资金。如果应用无法读取你是否已接受，它会如实说明并让你重试，而不会当作未接受。还款、领取、提取你自己的资产、取消你自己的报价以及关闭某项同意，永远不会被拦下。

<a id="settings"></a>

### 设置

设置位于菜单底部。模式、主题和语言无需连接钱包，并保存在此浏览器中。在你选择之前，主题跟随设备；尚未翻译的语言在翻译完成前显示英文。连接钱包后，设置会显示你在此网络上接受的服务条款版本，或有一个生效中的版本你尚未接受；它会在第一个需要它的操作时询问你，绝不在设置里询问。手续费折扣设置与首页上的是同一个。设置还会说明此浏览器为应用保存了什么、不保存任何机密信息，以及应用不发送错误报告或诊断信息。设置还可以把此浏览器中的应用记录下载为文件，或清除此网站在这里保存的全部内容。清除前会说明将删除多少项；清除会断开钱包连接，把模式、主题和语言恢复为默认值，然后显示删除了什么。你在链上的仓位、提醒服务中的提醒设置、官网以及钱包应用都不受影响。

设置还会用文字显示你在此网络上的风险等级、此网络是否执行它，以及严格模式是否开启。如果新的风险条款让你的等级不再计算，你可以在那里用一次钱包步骤再次确认。要提高或降低等级，或开启或关闭严格模式，请切换到 **Advanced** 模式：每项更改都是一次附有自身收据的钱包确认，不会移动任何资金。降低立即生效，并对新的报价和请求关闭高于新等级的交易对，包括你自己尚未成交的那些；你已有的贷款不受影响。提高可能需要等待协议设定的期限，应用会显示它何时开始计算。

设置还会列出你的钱包在此网络上给予协议的长期授权：协议无需再次询问你即可转移某个代币的多少数量，或对整个 NFT 系列或单个 NFT 的授权。每项授权都可以通过一次钱包确认撤回，不会移动任何资金。该列表会检查建议的资产以及你在此处的存款、贷款和报价所涉及的每项资产，你也可以添加其他代币进行检查；对任何其他代币的授权不会在那里显示，因此其余部分可在你的钱包中查看。如果另一项授权也覆盖同一资产，例如针对单个 NFT 的整个系列授权，确认页会说明撤回后它仍然有效。

设置还会显示在此网络上 keeper 能否代表你的钱包行动，以及你批准了哪些 keeper。一切一开始都是关闭的。只有在 keeper 访问开启且它持有该操作时，keeper 才会行动；针对贷款的步骤还需要该贷款或报价指定这个 keeper。keeper 永远不会收到你的资金，也不能领取、提取或转移任何东西。在两种模式下都可以通过一次钱包确认关闭 keeper 访问或移除某个 keeper；要开启访问、批准 keeper 或更改它能做的事，请切换到 **Advanced** 模式。

你也可以把应用安装到手机或电脑上，从主屏幕或应用列表打开，并带有报价、头寸、金库和提醒的快捷方式。使用浏览器的“安装应用”或“添加到主屏幕”选项（iPhone 或 iPad 上：Safari，然后分享，然后添加到主屏幕），或在 **Advanced** 模式下、浏览器提供时使用设置中的“安装应用”。应用会保留自身代码文件的副本以便更快打开；你的头寸和每个数字始终从网络读取。

<a id="rent-review"></a>

### 租用：租一个 NFT

菜单中的“租用”列出所有者在你的网络上挂出出租的 NFT；在测试网络上如果没有任何挂单，页面会引导你去水龙头领取测试 NFT 和测试代币。租用给你的是在固定天数内使用某个 NFT 的权利，而不是 NFT 本身：它留在所有者的金库里，金库会把你登记为使用者，直到租期结束。打开一个挂单并选择“租用这个 NFT”。确认页会显示从你的钱包转入你自己金库的内容：整个租期的日租金，加上一笔缓冲金，即挂单发布时固定的一小部分租金。它还会显示租金规则（按比例，即按你使用的天数计，不满一天按一天算；或全期）、按时结束时退回什么、宽限期，以及从缓冲金中扣除的逾期费。租用没有抵押品，也没有健康因子。如果你的钱包余额少于租金加缓冲金，确认页会在任何钱包步骤之前说明。之后钱包会请你签署条款（不花任何费用）、必要时批准恰好这个金额，并开始租用；应用会先以试运行验证。完成后，应用会在链上核对已开始的租用、转入你金库的付款，以及你现在是该 NFT 的使用者。

<a id="rent-risks"></a>

### 租用：风险

你永远不会拥有租来的 NFT，使用它的权利随租期结束而结束。租金和缓冲金为这次租用留在你的金库中，租用未结束时不能提取。约定的每一天都结算完后（任何人都可以结算），租用会自动结束，你可以领回缓冲金。在此之前请自己在它的持仓页面结束。在宽限期内结束要从缓冲金中扣除逾期费；超过宽限期，租用即违约，你金库中剩余的租金归所有者，缓冲金归协议，你拿不回任何东西。按全期计租时，即使提前结束也要支付整个租期。

<a id="rent-list"></a>

### 租用：把你的 NFT 挂出出租

在“租用”页点击“挂出 NFT 出租”会打开一个简短表单：合集（测试网络上可选测试合集，或粘贴地址）、代币编号，多代币合集还要填数量；租户支付所用的代币；日租金，一个数值；租期天数；租金规则，按比例或全期；以及挂单开放多久。没有抵押或利率字段：租用两者都没有。确认页会显示 NFT 从你的钱包转入你自己的金库、租户需预付多少、本挂单按今天的设置固定的缓冲金比例、你会收到什么（应付租金扣除协议的份额，该份额在租户接受挂单时固定）、宽限期，以及违约时如何处理。如果你的钱包里没有该 NFT，确认页会在任何钱包步骤之前说明。之后钱包会请你允许协议移动这一个代币（多代币合集则为整个合集，仅限这次挂单，之后再用一步撤回），并发布挂单；应用会先以试运行验证。完成后，应用会在链上核对挂单已记录、NFT 已到达你的金库，并给出挂单页面的链接。

<a id="rent-list-risks"></a>

### 租用：挂出出租的风险

挂单开放期间和出租期间，NFT 都留在你的金库中，挂单或租用结束前不能提取。在无人租用时，你可以在挂单的头五分钟过后从其页面取消。出租后，租户在租期结束前拥有使用该 NFT 的权利，你不能提前收回。每结算一个已结束的日子，扣除协议份额后的租金就转入你的金库；任何人都可以结算。约定的每一天都结算完后，租用会自动结束，租户可以领回缓冲金。在此之前，由租户结束，或在宽限期过后任何人都可以按违约结束。如果租户结束租用，你可以领取尚未结算的租金和任何逾期费（扣除协议份额），剩余缓冲金退还租户。如果违约，你可以领取剩余租金（扣除该份额），缓冲金归协议。暂停期间每日结算停止，逾期费和违约的日期顺延，但租户的使用期限不会延长。已过期的挂单会把 NFT 留在你的金库中，直到它被关闭。

<a id="rent-request"></a>

### 租用：申请租用一个 NFT

在租用页面，“发布租用请求”会打开与挂单相同的简短表单，只是以租户的口吻措辞：系列和代币编号（多代币系列还有数量）、你用来支付的代币、以单一数字表示的日租金、以天计的期限、租金规则，以及请求保持开放的时长。审核会显示：整个期限的租金和一笔缓冲金现在就从你的钱包转入你自己的金库；这份请求按今天的设置固定的缓冲比例；期限从业主接受请求时起算；接受请求的业主会立即开始租用，无需你再做任何操作。如果你的钱包余额不足，或已经持有这个 NFT，审核会在任何钱包步骤之前说明；尚不存在的代币会被注明。随后你的钱包恰好批准租金和缓冲金的数额并发布请求，应用会先以试运行的方式尝试。之后应用会在链上核实请求已被记录、租金和缓冲金已到达你的金库，并链接到请求的页面。

<a id="rent-request-risks"></a>

### 租用：租用请求的风险

请求开放期间，租金和缓冲金留在你的金库中，在你取消请求或请求结束之前不能提取。在没有业主接受时，你可以在请求的头五分钟过后从其页面取消，两者会回到你的钱包。接受请求的业主会按完全相同的条款立即开始租用：你持有的是使用该 NFT 的权利，而从来不是 NFT 本身。约定的每一天都结算完后（任何人都可以结算），租用会自动结束，你可以领回缓冲金；在此之前，请在其仓位页面结束它。逾期结束会从缓冲金中扣除逾期费；若违约，租金归业主，缓冲金归协议。已过期的请求会把租金和缓冲金留在你的金库中，直到它被关闭。缓冲金比例取请求上链时协议的设置：若在你审阅后发生变化，当你的钱包只批准了这一确切金额时，更高的比例会被拒绝；若之前的批准足以覆盖，则会被扣取；结果会说明实际转移了什么。

<a id="rent-take"></a>

### 租用：接受租户的请求

租户的请求是按固定条款租用一个 NFT 的请求，租户已经把租金和缓冲金放进了自己的金库。请求页面会说明这一点，并提供“出租你的 NFT”。审核会显示：NFT 从你的钱包转入你自己的金库；租户是谁；租户从现在起在整个期限内获得使用它的权利，而不是 NFT 本身。它还会显示请求固定的日租金、期限和租金规则，已在租户金库中的租金和缓冲金，你将收到什么（租金减去协议份额，份额在租用开始时固定，每结算一个已结束的日子就转入你的金库，其余在结束时转入），宽限期，以及违约会发生什么。如果你的钱包没有这个 NFT，或数量不足，审核会在任何钱包步骤之前说明，并在你持有后自动重新读取。随后钱包会请你签署条款（不花任何费用）、允许协议转移这一个代币（多代币系列则是整个系列，仅限这次租用，之后再用一步收回），并开始租用；应用会先以试运行验证。完成后，应用会在链上核对已开始的租用、NFT 已到达你的金库，以及你的金库把租户登记为使用者，并链接到这次租用。

<a id="rent-take-risks"></a>

### 租用：接受请求的风险

整个租期内 NFT 都留在你的金库中，租用未结束时不能提取。租户在租期结束前拥有使用它的权利，你不能提前收回。条款是请求本身的：日租金、期限、租金规则和缓冲金都不能更改。每结算一个已结束的日子，扣除协议份额后的租金就转入你的金库；任何人都可以结算。约定的每一天都结算完后，租用会自动结束，租户可以领回缓冲金。在此之前，由租户结束，或在宽限期过后任何人都可以按违约结束。如果租户结束租用，你可以领取尚未结算的租金和任何逾期费（扣除协议份额），剩余缓冲金退还租户。如果违约，你可以领取剩余租金（扣除该份额），缓冲金归协议。暂停期间每日结算停止，逾期费和违约的日期顺延，但租户的使用期限不会延长。没有记录自己缓冲比例的请求，会在租用开始时采用当天的设置。

<a id="rent-close"></a>

### 租用：结束租用

进行中的租用页面会向作为租用人的你提供“结束租用”。结束时，所欠租金和逾期费从你预先存入自己金库的租金和缓冲金中支付，所以不会从你的钱包扣款，也不需要授权。审核会显示现在结束以及稍后某一时刻结束时所欠的租金，按计租规则计算（按天计：自开始起使用的天数，不足一天按一天算，减去已结算的天数；全期：所有尚未结算的约定天数），并显示已结算的天数、逾期费、作为待领款项退还给你的金额，以及所有者收到的金额：租金和逾期费扣除协议的份额。如果预付款不足以结束，审核会在你的钱包打开前说明。然后你的钱包只请求一次结束租用，应用会先试运行。之后应用会在链上核对租用已结束、为你记录的待领款项，以及你的使用权已结束。退还的金额请在 Claims 页面领取。

<a id="rent-close-risks"></a>

### 租用：结束的风险

结束会立即终止你使用该 NFT 的权利，即使还有约定天数，而且无法撤销。租金按结束上链的时刻计算，所以在此之前开始的一天按整天支付；按全期计租时，无论多早结束，所有尚未结算的约定天数都要支付。租期结束后会从你的缓冲金中扣除逾期费：全部租金的 1%，每逾期一天再加 0.5%，最多 5%，且绝不超过缓冲金。超过宽限期后，协议会拒绝结束；此后租用要么在剩余天数逐日结算完时结束（任何人都可以结算），要么以违约告终，以先发生者为准。审核显示的稍后时刻既不是截止时间也不是上限：较晚上链的结束按那时计算，因此可能扣除更多租金或更高的逾期费，退还给你的会更少。退还的金额作为待领款项留在你自己的金库中，直到你领取。

<a id="rewards-vpfi"></a>

### 奖励：金库中的 VPFI

菜单中的“奖励”显示你在此网络上的奖励、你的 VPFI 以及你的手续费折扣同意。你的奖励就是 Home 显示的使用返利，领取方式相同。下面显示你的 VPFI：钱包中的、在你自己的金库中已计入的、现在可自由提取的，以及为贷款、报价、领取或付款而占用的。已计入的 VPFI 决定你的手续费折扣等级，而该等级只在你的同意开启时才会降低你的手续费。未经存入、直接发送到金库的 VPFI 不会计入，也绝不会提高你的等级；页面会显示它，并指引你到 Vault 页面将其纳入。“存入 VPFI”把 VPFI 从钱包移入只有你的钱包能控制的自己的金库；如果你还未接受服务条款，会先请你接受；首次存入会创建金库。“提取 VPFI”把可自由提取的 VPFI 转回钱包。每个确认页都会说明此操作对你的等级有何影响以及你的同意是否开启，之后应用会在链上核对结果。在未设置 VPFI 的网络上，页面会如实说明，两者都不提供。只有 VPFI 主网络上你金库中的 VPFI 才决定你的等级；其他网络使用在那里算出的等级副本，因此在这些网络上，页面和每个确认页都会说明移动 VPFI 不会改变等级。

<a id="rewards-vpfi-risks"></a>

### 奖励：移动 VPFI 的风险

你的等级不是你今天的余额。在你当前的持有持续满最少天数之前，它为零。之后它跟随你每日持有量的平均值，近期的日子权重更高。另外，它绝不会超过你在当前持有期间任何一天所处的最低等级，最多回看 30 天。因此存入只会随时间提高你的等级，短暂的追加不会提高它。提取部分已计入的 VPFI 可能降低你的等级，全部提取则会让持有时间从下次存入重新计算。为贷款、报价、领取或付款而占用的 VPFI 在释放之前无法提取，受保护账户的提取会先等待其延迟。受保护账户的提取只有在释放时才会改变已计入的 VPFI 和你的等级，已取消的提取两者都不改变。金库中的 VPFI 不是抵押品，也不为任何贷款提供担保。协议不出售 VPFI，不为其报价，也不因持有而支付任何东西。

<a id="rewards-tier"></a>

### 奖励：你的手续费折扣等级

在 VPFI 下方，页面显示协议现在对你的手续费适用的手续费折扣等级（直接从协议读取），以及它减免多少。只要你的手续费折扣同意处于关闭状态，就不适用任何等级。新的持有需要一段时间才会完全计入，因此当持有规则使你的等级低于仅凭已计入 VPFI 可得到的等级时，页面会说明。在 VPFI 的主网络上，一张表列出每个等级：所需的已计入 VPFI、其折扣，以及按该折扣计算的贷款发起费和所赚利息的手续费，均根据该网络的当前设置计算。每个等级从其数值开始，只有最高等级从略高于其数值处开始。任何折扣都不会超过手续费的一半。在其他网络上，页面显示从主网络发送来的等级，不显示该表。

<a id="rewards-vpfi-sign"></a>

### 奖励：以签名代替授权

如果你的钱包已为 VPFI 授权 Permit2（许多应用用来凭签名转移代币的共享合约），VPFI 存入的审核页会提供“以签名代替授权”。这时你签署一笔恰好为该金额的一次性转账（30 分钟内有效），再发送存入：钱包操作两步，不向协议授予任何授权。该签名只能使用一次，只能用于你自己的钱包发送的交易，且只能转入你自己的金库；未使用则会失效。应用从不要求你授权 Permit2 本身，因为那项授权没有期限，并与其他应用共享。没有它时，审核页仍使用恰好为该金额的常规授权。在没有 Permit2 的网络上，不提供此选项。
