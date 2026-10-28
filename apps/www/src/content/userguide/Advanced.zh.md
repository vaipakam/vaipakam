# Vaipakam — 用户指南 (Advanced Mode)

这是 App 中每张 card 的精确、技术准确说明。每个章节都对应 card
标题旁边的 `(i)` info icon。

> **您正在阅读 Advanced 版本。** 它对应 App 的 **Advanced** 模式
> (更密集的 controls、diagnostics、protocol-config 详情)。如需更
> 友好、更易懂的说明，请将 App 切换到 **Basic** 模式 — 打开
> Settings (右上角的齿轮图标) → **Mode** → **Basic**。之后 App 内
> 的 (i) "Learn more" 链接会开始打开 Basic 指南。

---

## Dashboard

<a id="dashboard.your-vault"></a>

### 您的 Vault

一个 upgradeable per-user contract — 您在这条 chain 上的私人 vault
— 会在您第一次参与 loan 时为您创建。每个 address、每条 chain 只有
一个 vault。它持有与您 loan positions 相关的 ERC-20、ERC-721 和
ERC-1155 balances。没有混合保管：其他用户的 assets 永远不会进入
这个 contract。

vault 是 collateral、出借 assets 和您锁定的 VPFI 所在的唯一位置。
protocol 在每次 deposit 和 withdrawal 时都会检查它。implementation
可以由 protocol owner upgrade，但只能通过 timelock — 绝不会立即生效。

<a id="dashboard.your-loans"></a>

### 您的 Loans

这条 chain 上与当前连接 wallet 相关的每一笔 loan — 无论您在 lender
一侧、borrower 一侧，还是在不同 positions 中两边都有。数据会从
protocol 的 view methods 针对您的 address live 计算。每一行都会
deep-link 到完整 position 页面，里面包含 HF、LTV、accrued interest、
由您的 role 和 loan status 决定可用性的 actions，以及可粘贴到
block explorer 的 on-chain loan id。

<a id="dashboard.vpfi-panel"></a>

### 这条 chain 上的 VPFI

active chain 上当前连接 wallet 的 live VPFI accounting：

- Wallet balance。
- Vault balance。
- 您在 circulating supply 中的份额 (扣除 protocol-held balances
  之后)。
- 剩余可 mint cap。

Vaipakam 通过 Chainlink CCIP 跨链发送 VPFI。**Base 是 canonical
chain** — 那里的 canonical adapter 使用 lock-on-send /
release-on-receive semantics。其他每条受支持的 chain 都运行一个
mirror：inbound bridge packet 到达时 mint，outbound 时 burn。所有
chains 上的 total supply 在 bridging 下按结构保持不变。

2026 年 4 月的 industry incident 之后，cross-chain
message-verification policy 被强化为 **3 required + 2 optional
verifiers, threshold 1-of-2**。single-verifier default 会在 deploy
gate 被拒绝。

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

这是 wallet-level opt-in flag，把您持有的 VPFI 转化为 fee 折扣。
**作为 borrower**，折扣是对 Loan Initiation Fee 的直接减免，在 loan 被
accept 时以 lending asset 计收，不会从您的 vault 中扣除任何东西。
**作为 lender**，收益费折扣在 settlement 时适用；若已配置 VPFI 价格参考，
也可改为从您的 vault 中以 VPFI 结算，使您保留 lending asset 中的全额费用。
Default：off。off 表示每笔 fee 的 100% 都用 principal asset 支付；
on 则会应用 time-weighted discount。

Tier ladder：

| Tier | 最低 vault VPFI                          | 折扣                                |
| ---- | ----------------------------------------- | ----------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                  | `{liveValue:tier1DiscountBps}`%     |
| 2    | ≥ `{liveValue:tier2Min}`                  | `{liveValue:tier2DiscountBps}`%     |
| 3    | ≥ `{liveValue:tier3Min}`                  | `{liveValue:tier3DiscountBps}`%     |
| 4    | > `{liveValue:tier4Min}`                  | `{liveValue:tier4DiscountBps}`%     |

您 deposit 或 withdraw VPFI 的瞬间，tier 会按您的 **post-change**
vault balance 计算。真正收取的费率，是在 settlement 时按您当下的 tier
得出的；不会再针对每笔 loan 自身的存续期单独取平均。真正的防护在 tier
本身：它是您在最近一个不超过 30 天的窗口内日终 balance 的时间加权平均
—— 该窗口是 protocol 的一项设置，从您当前持有开始之日算起，越近的日子
权重越高 —— 随后这个平均还会被压低到自那次持有开始以来您曾经跌到的最低
tier，这一步最多回看 30 天。

**这是两段不同的回看，通常后一段更长。** 求平均的窗口可以配置，也可以
设成短于 30 天；最低 tier 的回看并不跟随它，而是覆盖您当前持有的全部
时间，上限 30 天。因此即使把求平均的窗口设为 14 天，20 天前的一次下跌
仍会压住您的 tier，尽管它完全落在平均之外。

在您**不间断地**持有大于零的 balance 达到规定的最少天数之前，您的 tier
一直为零；这同样是 protocol 的设置。这个计时在 balance 由零变正时开始，
只有当它重新归零才会重新计时 —— 往已有的持有里追加并不会重置它。

因此 withdraw 会立即作用于您参与的每笔 open loan —— 没有让旧的 (更高)
tier 继续适用的 grace window。这会关闭一种 exploit pattern：在 loan
即将结束时临时 top up VPFI 以拿到 full-tier discount，然后几秒钟后
withdraw。请注意是哪条规则关闭了它：长期持有者早已满足最短持有期，真正
起作用的是最低 tier 规则 —— 这是平均值做不到的，因为平均值会被临近的
top up 拉高，最小值不会。

针对这一特定模式，现行规则比原来的更强。但它**并非在各方面**都更严格：
由于最低 tier 的回看最多只到 30 天，一笔长期 loan 早期的低 tier 阶段
终究会退出这段历史，而按整笔 loan 求平均则会一直保留它们。这次改动加强了
对短暂 top up 的防御，也缩短了记忆。

**以上针对的是 lender yield fee。** Borrower 的发起费费率在 loan 被 accept 时
读取一次，此后 withdraw 或 top up 都不会改变它。

discount 在 settlement 时适用于 lender yield fee，也适用于 borrower
Loan Initiation Fee——就后者而言，它是**对您以 lending asset 支付的费用的直接减免**，在 loan 被 accept 时生效。不会从您的 vault 中扣除 VPFI 来支付该费用，之后也没有任何 rebate 可以 claim。

> **如果您在等待 Loan Initiation Fee 的 rebate，请读这一段。** 早期模型会预先以 VPFI 收取全额费用，在 loan 存续期间托管，并在您 claim 时退回其中一部分。**该路径已被移除。** 从未有任何 loan 在这条路径上开立，因此没有任何 loan 为其 initiation fee 托管 VPFI，也没有待领的 rebate——等待它等于等待一笔不可能到账的钱。

> **Network gas 与协议费用是分开的。** 上面的 discount 适用于 Vaipakam 的 **protocol fees**（yield fee `{liveValue:treasuryFeeBps}`%、Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%）。每次 on-chain action 都需要的 **blockchain 网络 gas 费**（在 Base / Sepolia / Arbitrum 等链上 create offer / accept / repay / claim / withdraw 等操作时支付给 validators）不是协议费用。Vaipakam 从不收取，由网络收取。它无法按 tier 处理或 rebate，并且取决于 submission 时该链的拥堵情况，与 loan 大小或您的 VPFI tier 无关。

<a id="dashboard.rewards-summary"></a>

### 您的 VPFI rewards

这张 summary card 会在一个视图里汇总 connected wallet 的 VPFI
rewards。headline number 是 pending interaction rewards 和
lifetime-claimed interaction rewards 的总和。

breakdown row 会显示 pending + claimed，并提供一个 chevron
deep-link，跳转到对应 native page 上的 full claim card：

- **Platform-interaction rewards** — 您参与过的每笔 loan (lender side
  或 borrower side) 中 accrue 的 pending VPFI，加上先前 claim 过的
  所有 interaction rewards。deep-link 到 Claim Center 中的 interaction
  claim card。

lifetime-claimed numbers 会从每个 wallet 的 on-chain claim history
重建。链上没有可直接 query 的 running total，因此需要 walk 这个
wallet 在本 chain 上过去的 claim events 并求和。fresh browser cache
在 historic walk 完成前可能显示 zero 或 partial total；完成后会更新为
正确值。trust model 与 underlying claim cards 相同。

card 会始终为 connected wallets render，即使所有值都是 zero。这个
empty-state hint 是刻意保留的 — 如果在 zero 时隐藏 card，新 users 在
进入 Claim Center 之前很难发现 rewards program。

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Lender / borrower offer lists 的 client-side filters。可以按 asset、
side、status 和其他几个维度 filter。Filters 不影响 "Your Active
Offers" — 该列表始终完整显示。

<a id="offer-book.your-active-offers"></a>

### 您的活跃报价

您创建的开放报价（状态 Active，尚未到期）。在接受之前可随时取消
— 取消调用是免费的。接受会将报价更改为 Accepted 并触发贷款
初始化，这会铸造两个仓位 NFT（一个给出借人，一个给借款人）
并以 Active 状态开启贷款。

已关闭的报价具有几种不同状态之一。一些已经在 My Offers 页面上
作为过滤器芯片公开；其他是索引器端终端，将在后续工作中获得
专门的 UI 处理：

- **Filled** — 由对手方接受；报价的贷款引用是结果贷款 id。
- **Cancelled** — 报价通过两条路径之一达到 Cancelled 状态：
  在接受前由创建者撤回，或者一旦
  `LibVaipakam.isOfferExpired(offer)` 为 true 后通过
  `OfferCancelFacet.cancelOffer` 无许可清理（无论谁发起取消
  调用，退款都会路由到创建者）。
- **Sold** — 报价已选择加入 borrow-OR-sell 并行销售流程
  （参见 创建报价 → 允许可选出售），并且在任何
  出借人接受之前，市场买家已填充 NFT 抵押品列表。报价持有
  链上状态 `consumed_by_sale`；行的费率列显示报价发布时的
  费率，抵押品单元格呈现 NFT 形状（ERC-721 的令牌 id，
  ERC-1155 的副本数）。应用 还在 Activity 提要中将该行作为
  `Offer sold via OpenSea` 为借款人（报价创建者）显示。
  链上事件本身是
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  offer id 和 executor 地址都在链上索引，但借款人 / 创建者
  地址不是。借款人的 Activity 提要钱包匹配由索引器在
  摄取时添加（它连接报价行以查找创建者），因此 per-钱包
  过滤器找到借款人，无需事件本身对其索引。
- **Fully Filled（索引器 状态，尚无芯片）** — 仅限 Range
  订单。当部分填充匹配消耗报价的剩余预算时（最后一次匹配
  完全填满范围，或部分匹配留下 sub-dust 余额），
  `OfferMatchFacet` 发出 `OfferClosed(FullyFilled | Dust)`，
  索引器 在报价行上盖上 `status = 'fullyFilled'`。合约的
  `accepted` 状态和上面的链上 Filled 标签保留用于
  direct-accept 终端，因此 `fullyFilled` 在索引器端是
  区分的。应用的 `MyOfferStatus` 尚未将此终端作为其自己的
  过滤器芯片公开 — `useMyOffers` 当前忽略具有 `fullyFilled`
  索引器状态的行 — 因此完全填充的范围报价在专用芯片登陆
  之前实际上完全从 My Offers 视图中消失。芯片表面作为单独的
  UI 后续跟进排队。

从未达到终端事件的过去 GTT（GTT 到期时间）报价尚未在应用中
作为不同的状态芯片公开；目前归类在 Active 下，直到索引器
记录终端。专用的 Expired 芯片作为单独的 UI 后续跟进排队。


<a id="offer-book.lender-offers"></a>

### Lender Offers

来自愿意出借的 creators 的 Active offers。Acceptance 由 borrower
执行。initiation 时有一个硬 gate：borrower 的 collateral basket
必须针对 lender 的 principal request 产生至少 1.5 的 Health Factor。
HF 计算由 protocol 自己执行 — gate 无法被绕过。interest 上的 `{liveValue:treasuryFeeBps}`%
treasury cut 会在 terminal settlement 时 debit，而不是预先收取。
该 rate 在 loan 创建时即已固定，因此之后 protocol fee 的调整不会改变一笔已经开启的 loan。

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

来自已经在 vault 中锁定 collateral 的 borrowers 的 Active offers。
Acceptance 由 lender 执行；它用 principal asset fund loan，并 mint
position NFTs。initiation 时同样有 HF ≥ 1.5 gate。固定 APR 在 offer
creation 时设定，并在 loan 的整个生命周期内 immutable — refinance
会创建一笔新 loan，而不是修改现有 loan。

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

选择 creator 站在 offer 的哪一边：

- **Lender** — lender 提供 principal asset 和 borrower 必须满足
  的 collateral spec。
- **Borrower** — borrower 预先锁定 collateral；lender accept 并
  fund。
- **Rental** 子类型 — 用于 ERC-4907 (rentable ERC-721) 和可租赁
  的 ERC-1155 NFT。走 rental flow 而非 debt loan；renter 预付全
  部租赁费用 (duration × daily fee) 加上 5% buffer。

<a id="create-offer.lending-asset"></a>

### Lending Asset

对于 debt offer，您需要指定 asset、principal amount、fixed APR
和 duration (天数)：

- **Asset** — 出借 / 借入的 ERC-20。
- **Amount** — Principal，以 asset 的 native decimals 计。
- **APR** — 以 basis points (百分之一的百分之一) 表示的 fixed annual
  rate，会在 acceptance 时 snapshot，之后不再 reactive。
- **Duration in days** — 设置 default 能被触发之前的 grace window。

Accrued interest 从 loan 的 start time 到 terminal settlement 按
秒持续计算。

<a id="create-offer.lending-asset:lender"></a>

#### 如果您是 lender

您愿意提供的 principal asset 和 amount，加上 interest rate (APR，%)
和 duration (天数)。Rate 在 offer 时固定；duration 设置 loan 能
default 之前的 grace window。在 acceptance 时，作为 loan initiation
的一部分，principal 会从您的 vault 移到 borrower 的 vault。

<a id="create-offer.lending-asset:borrower"></a>

#### 如果您是 borrower

您希望从 lender 获得的 principal asset 和 amount，加上 interest
rate (APR，%) 和 duration (天数)。Rate 在 offer 时固定；duration
设置 loan 能 default 之前的 grace window。在 borrower offer 上，您
的 collateral 会在 offer-creation 时锁定在 vault 中，并保持锁定，
直到 lender accept 后 loan 开启 (或您 cancel)。

<a id="create-offer.nft-details"></a>

### NFT Details

Rental-sub-type fields。指定 NFT contract、token id (以及 ERC-1155
的 quantity)，再加上用 principal asset 表示的 daily rental fee。
acceptance 时，protocol 会把 prepaid rental 从 renter 的 vault
debit 到 custody — 即 duration × daily fee，加上 5% buffer。NFT
本身会进入 delegated state (通过 ERC-4907 user rights，或等效的
ERC-1155 rental hook)，因此 renter 拥有使用权，但不能 transfer NFT
本身。

<a id="create-offer.collateral"></a>

### Collateral

offer 上的 collateral asset spec。两个 liquidity classes：

- **Liquid** — 具有注册的 Chainlink price feed **以及**至少一个
  Uniswap V3 / PancakeSwap V3 / SushiSwap V3 pool 在当前 tick 处
  ≥ $1M depth。LTV 和 HF 计算适用；HF-based liquidation 会通过
  4-DEX failover (0x → 1inch → Uniswap V3 → Balancer V2) 路由
  collateral。
- **Illiquid** — 不符合上述条件的任何东西。on-chain 上估值为
  $0。无 HF 计算。default 时，全部 collateral 会转移给 lender。
  双方必须在 offer creation / acceptance 时明确确认
  illiquid-collateral risk，offer 才能成立。

price oracle 在 primary Chainlink feed 之上，还有一个由三个独立
sources (Tellor、API3、DIA) 组成的 secondary quorum，使用 soft
2-of-N decision rule。Pyth 经评估后未采用。

<a id="create-offer.collateral:lender"></a>

#### 如果您是 lender

您希望 borrower 锁定多少 collateral 来保障 loan。Liquid ERC-20s
(Chainlink feed + ≥ $1M v3 pool depth) 适用 LTV / HF 计算；illiquid
ERC-20s 和 NFTs 没有 on-chain valuation，需要双方同意 default 时
全额 collateral 转移的结果。loan initiation 时的 HF ≥ 1.5 gate 会
针对 borrower 在 acceptance 时提交的 collateral basket 计算 — 在
这里设置 requirement，会直接决定 borrower 的 HF headroom。

<a id="create-offer.collateral:borrower"></a>

#### 如果您是 borrower

您愿意锁定多少 collateral 来保障 loan。Liquid ERC-20s (Chainlink
feed + ≥ $1M v3 pool depth) 适用 LTV / HF 计算；illiquid ERC-20s
和 NFTs 没有 on-chain valuation，需要双方同意 default 时全额
collateral 转移的结果。在 borrower offer 上，您的 collateral 会在
offer-creation 时锁定在 vault 中；在 lender offer 上，collateral
会在 offer-acceptance 时锁定。无论哪种方式，loan initiation 时的
HF ≥ 1.5 gate 都必须用您提交的 basket 通过。

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

提交前的 acknowledgement gate。同样的 risk profile 适用于双方；
下面的 role-specific tabs 会说明，您签署 offer 的不同 side 时，每
个风险会如何以不同方式影响您。Vaipakam 是 non-custodial 的：没有
admin key 可以撤销已经确认的 transaction。Pause levers 只存在于
cross-chain-facing contracts 中，受 timelock 控制，也不能移动 assets。

<a id="create-offer.risk-disclosures:lender"></a>

#### 如果您是 lender

- **Smart-contract risk** — contract 代码 runtime 不可变；已审
  计但未经 formally verified。
- **Oracle risk** — Chainlink staleness 或 pool-depth divergence
  可能将 HF-based liquidation 延迟到 collateral 不再覆盖
  principal 的点之后。secondary quorum (Tellor + API3 + DIA，
  soft 2-of-N) 可以捕捉大幅 drift，但较小的 skew 仍可能削弱
  recovery。
- **Liquidation slippage** — 4-DEX failover 会 route 到它能找到的
  最佳 execution，但不能保证特定价格。Recovery 是扣除 slippage 和
  interest 上 `{liveValue:treasuryFeeBps}`% treasury cut 后的净额。
- **Illiquid-collateral defaults** — collateral 在 default 时全
  额转移给您。如果资产价值低于 principal 和 accrued interest，
  您没有任何追索权。

<a id="create-offer.risk-disclosures:borrower"></a>

#### 如果您是 borrower

- **Smart-contract risk** — contract 代码 runtime 不可变；bug 可能
  影响锁定的 collateral。
- **Oracle risk** — stale data 或操纵可能在真实市场价格本来安全
  时对您触发 HF-based liquidation。HF formula 对 oracle 输出反
  应；单个 bad tick 跨过 1.0 就足够了。
- **Liquidation slippage** — liquidation 触发时，swap 可能以受
  slippage 影响的价格出售您的 collateral。swap 是 permissionless
  的 — 您的 HF 跌破 1.0 的瞬间，任何人都可以 trigger。
- **Illiquid-collateral defaults** — Default 会把您的全部 collateral
  转给 lender，没有任何 leftover claim。

<a id="create-offer.advanced-options"></a>

### Advanced Options

不太常用的 controls：

- **Expiry** — 在此 timestamp 之后 offer 自动取消。Default ≈ 7
  天。
- **Use fee discount for this offer** — 此特定 offer 的 wallet
  级 fee-discount consent 的 local override。
- offer creation flow 暴露的 side-specific options。

对大多数用户而言，defaults 是合理的。

<a id="create-offer.borrow-or-sell"></a>

### 允许在 OpenSea 上选择性出售此 NFT（仅 NFT 抵押品的借款人报价）

如果您发布的是带有 **ERC-721 或 ERC-1155 抵押品** 和 **ERC-20
本金** 的 **借款人报价**，应用会在抵押品部分下方公开
`Borrow or sell` 选择加入选项。勾选它将报价标记为有资格在
OpenSea 上对您的 NFT 抵押品进行并行销售列表 — 一个报价可以
由出借人（您获得贷款）或市场买家（您出售 NFT）填充。如果列表
已经发布，则在出借人接受时不会拆除列表：如果出借人先填充，
您获得贷款，现有的 OpenSea 列表通过贷款初始化继续到其原始
Seaport 到期为止，并且在该到期之前的后续市场填充触发 diamond
的结算瀑布以从销售收益中关闭贷款（见下方场景 B）。对于普通
GTT 报价，此到期是报价的原始 GTT 到期时间；出借人接受不会
为整个贷款期限延长或重新发布列表。如果市场买家先填充，则永远
不会创建贷款（场景 A）。两个场景以不同的报价状态结束：场景 A
通过 `markOfferConsumedBySale` 用 `consumed_by_sale` 戳印
报价（在 Sold 过滤器下显示），并且出借人接受针对已经戳印的
任何报价进行门控。在场景 B 中，市场填充到达时报价已处于
`Accepted` 状态；合约故意将报价状态保留在 `Accepted`，仅从
销售结算贷款 — 报价不会第二次过渡到 Sold。

**两步性质。** 报价创建时的选择加入仅在报价上设置资格标志。
在 OpenSea 上获得实际可购买的列表是应用今天不会自动化的
单独两部分步骤：

1. **在 diamond 上记录 + 连接。** 在报价仍处于活动状态且在
   任何出借人接受之前调用
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)`。一旦报价被接受、取消或被销售消耗，此调用作为
   终端 revert；仅勾选选择加入不足以创建可以传递到场景 B 的
   列表。Ask 还必须覆盖预贷款底价：本金 + 贷款期限和宽限窗口
   内最坏情况的报价利息、该利息上的国库削减、配置的安全
   缓冲，以及所有 fee-leg 金额。低于底价的 ask 在此步骤
   revert。`feeLegs` 参数是此调用记录 OpenSea 协议费和创作者
   版税义务的唯一位置：diamond 从卖方收益中扣除每个 fee-leg
   金额，并将接收者 + 绝对金额附加到 Seaport consideration
   数组。在强制费用集合上传递 `feeLegs: []` 会产生 OpenSea
   发布步骤将拒绝的订单形状（fee-recipient consideration 项
   缺失），并且直接的 Seaport 填充将把完整 ask 路由到卖方，
   而不是按集合要求分割费用。高级用户必须获取集合的 OpenSea
   required-fee 时间表（in-repo fee parser
   `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** 是参考）并在调用前传递
   针对 ask 派生的绝对金额。Facet 在内部从这些输入（加上它在
   `CollateralListingExecutor.offerContext` 中保留的值 —
   借款人 vault 地址、本金资产、抵押品字段、startTime、
   endTime）和 vault 的当前 `Seaport.getCounter` 构建规范
   Seaport OrderComponents，通过 `Seaport.getOrderHash` 派生
   orderHash，返回它，将 vault 的 ERC-1271 绑定注册到该哈希，
   并授予 NFT 抵押品的 Seaport conduit 批准。发出的
   `PostParallelSaleListing` 事件公开输入参数（`offerId`、
   借款人、orderHash、askPrice、executor / conduit 数据、
   salt、fee legs）；它不会回显 per-context 字段，因此在
   链下重建 OrderComponents 需要下面步骤 2 中描述的额外读取。
   **重要：** 此时订单已经可以通过 Seaport FILLABLE。监视
   合约事件加上这些读取的机器人可以重建 OrderComponents 并
   直接调用 `Seaport.fulfillOrder` — 列表无需出现在 OpenSea
   的市场 UI 上即可使链上填充路径工作。如果您不希望对手方
   在步骤 2 登陆之前以当前 ask 填充，要么在步骤 1 之后立即
   运行步骤 2，要么调用 `releaseParallelSaleLock` 在任何
   意外填充之前使绑定无效。
   对于强制费用集合，在调用此步骤之前从集合的必需 OpenSea /
   创作者费用时间表中填充 `feeLegs`。仅使用必需的非零费用行；
   将列表限制为协议支持的 fee-leg 数量；将每行转换为所选 ask
   价格的本金资产中的绝对固定金额；并使用列出的费用接收者作为
   leg 接收者。如果必需费用在所选 ask 处舍入为零，则 ask 对该
   集合而言太小，不应尝试 post。仅对无费用集合传递空数组才有
   效。在强制费用集合上，这可能产生一个在 OpenSea 发布失败或
   无法满足市场所需 consideration 形状的订单。
2. **在 OpenSea 上发布。** 重建 facet 构建的相同 OrderComponents。
   仅 `PostParallelSaleListing` 事件不够：它发出 `offerId`、
   借款人、orderHash、askPrice、executor / conduit 数据、salt
   和 fee legs，但 offer-keyed 订单形状还需要 executor 的
   `OfferContext` 存储中保留的值（借款人 vault 地址、本金
   资产、抵押品字段、startTime、endTime）加上借款人 vault 的
   Seaport 计数器（offerer 的计数器 —
   `LibPrepayOrder.buildAndHashOfferMem` 哈希
   `Seaport.getCounter(ctx.borrowerVault)`，而不是出价人的
   计数器）。这是 `LibPrepayOrder.buildAndHashOfferMem`
   offer-order 路径使用的相同上下文，与 loan-keyed
   prepay-listing 订单形状不同。发布前读取两者：
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     返回该哈希的持久化 `OfferContext` 结构体。
   - `Seaport.getCounter(borrowerVault)` 返回 vault offerer 的
     规范 Seaport 计数器。
   有了这些字段，OrderComponents 结构体准确复制 diamond 哈希
   的内容。POST 之前，添加仅 API 字段
   `parameters.totalOriginalConsiderationItems` — OpenSea 的
   API 需要它，尽管它不是产生规范哈希的 Seaport 结构体的一
   部分；in-repo 发布器（`apps/indexer/src/openseaPublish.ts`）在调用 endpoint 之
   前注入它。对于 ERC-1271 验证的订单，OpenSea 接受
   `signature` 字段为 `0x`（空字节）— vault 的链上
   `isValidSignature(orderHash, '')` 回调忽略签名字节并对
   diamond 之前注册的任何 orderHash 返回 EIP-1271 magic value
   （来自步骤 1）。将 JSON POST 到 OpenSea listings endpoint
   （`POST /api/v2/orders/{chain}/{protocol}/listings`，根据
   官方 [Create Listing](https://docs.opensea.io/reference/post_listing)
   文档 — 这是 Vaipakam 自己的发布器在
   `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` 中使用的相同 endpoint）。
   仅在此步骤之后，列表才会出现在 OpenSea 的市场 UI 上并对
   休闲买家变得可发现。Vaipakam 目前不为 parallel-sale 路径
   自动化此提交 — 端到端列表发布表面跟进。

今天遵循手动路径的高级用户需要两个步骤才能获得 OpenSea 可见性；
仅运行步骤 1 会产生一个通过 Seaport 直接可填充的订单（由从
事件重建组件的机器人或对手方），但在 OpenSea 市场 UI 上不可见。

**填充模式强制为 All-or-Nothing。** 选择加入自动将报价的填充
模式固定为 `Aon` — 启用 parallel-sale 的 partial / IOC 填充
模式将针对单个报价的抵押品创建多个贷款，合约对此进行门控。
切换在出借人报价、ERC-20 抵押品、NFT 本金以及合约的
`_validatePostParallelSale` 将拒绝的任何其他形状上隐藏，因此
您无法在不合格的报价上意外勾选它。

**买家看到的内容。**

- *任何出借人接受之前*（场景 A）：填充 OpenSea 列表的买家支付
  listed price。在强制费用集合上，Seaport 首先将 OpenSea
  protocol-fee 和 creator-fee 腿直接路由到其配置的接收者；
  executor 仅将 **净收益**（listed price 减去这些 市场
  / creator fee 腿）传递给 diamond。Diamond 将该净额托管在
  您的 vault 中，NFT 转移给买家，并且报价标记为
  `consumed_by_sale`（在 My Offers、Activity 和 Offer Details
  中作为不同的 "Sold" 状态可见）。从未创建过贷款；您保留净
  销售收益。
- *出借人接受之后*（场景 B）：列表通过贷款初始化继续 — 借款人
  NFT 锁定和列表都不会拆除。后续买家填充在 Seaport 交易中
  触发 diamond 的结算瀑布。与场景 A 相同的 fee-leg 说明：在
  强制费用集合上，Seaport 首先将 OpenSea protocol-fee 和
  creator-fee 腿直接路由到其配置的接收者，并且 executor 仅将
  **净收益**（销售价格减去 市场 / creator fees）传递
  给 diamond 的瀑布。销售是由抵押品出资的还款，因此 diamond 结算该净额的方式与成交
  那一刻的还款完全相同：贷款变为已还款；出借人应得部分（贷款以
  `useFullTermInterest = true` 创建时为完整票面，否则为截至当时
  累积的利息，再加上出借人的任何 yield-fee 折扣）放入出借人的
  vault，并通过普通的出借人索赔支付给当前出借人仓位持有者；国库
  收取扣除该折扣后的削减；其余部分发送到当前借款人仓位持有者的
  钱包。如果其余部分无法支付到该钱包，将被保留，并通过 Claim Center
  中的普通借款人索赔支付。出借人从不在销售本身中获得付款，因此
  出借人钱包的任何情况都无法阻止销售。

**您无法将其与之组合的内容。** 两个不同的冲突类，在不同的协议
阶段表面化：

- *发布时间块（兄弟 loan-keyed 列表）。* 如果贷款已经有从报价
  创建中继的 parallel-sale 列表，并且借款人然后调用
  `NFTPrepayListingFacet.postPrepayListing`（或
  `updatePrepayListing`）在同一贷款上发布第二个 loan-keyed
  prepay 列表，diamond 以 `SiblingParallelSaleListingLive`
  revert。借款人 NFT 的 conduit 批准是单个槽 — 同时运行两个
  列表会创建模糊的批准。借款人在发布 / 更新调用时看到 revert；
  没有填充。
- *填充时间块（开放 PrecloseFacet offset）。* 如果贷款有
  开放的 PrecloseFacet offset 报价，并且买家稍后尝试填充
  parallel-sale 列表，diamond 的 `_settleLoanFromParallelSale`
  以 `ParallelSaleBlockedByOpenOffsetOffer` revert。列表在
  OpenSea 上仍然有效，但任何填充尝试都会 revert，直到 offset
  链接被清除。应用目前不会在 Loan Details 页面上为此组合
  表面化专用横幅 / 通知；用户会看到填充 revert，可能需要在
  block explorer 上检查 revert 原因以诊断。清理路径是普通的
  offer-cancel 表面 — 调用
  `OfferCancelFacet.cancelOffer(offsetOfferId)` 取消 offset
  报价，这释放 offset 链接并解除 parallel-sale 填充的阻塞
  （PrecloseFacet 没有单独的取消入口点；offset 绑定到链接的
  报价，因此取消链接的报价会清除它）。冲突的专用 UI 表面作为
  单独的 UX 跟进排队。


## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims 按设计是 pull-style — terminal events 会把 funds 留在
protocol custody 中，由 position NFT holder 调用 claim 来移动它们。
两种 claims 可以同时存在于同一个 wallet 中。下面的 role-specific
tabs 会描述每一种。

每次 claim 都会 atomically burn holder 的 position NFT。NFT _就是_
bearer instrument — 在 claim 之前 transfer 它，就会把收取权交给新
holder。

<a id="claim-center.claims:lender"></a>

#### 如果您是 lender

lender claim 会返回：

- 您的 principal 回到这条 chain 上的 wallet。
- Accrued interest 减去 loan 创建时固定的 treasury cut (按当前
  费率创建的 loan 为 `{liveValue:treasuryFeeBps}`%)。当 consent
  打开时，cut 本身又被您的 time-weighted VPFI fee-discount
  accumulator 减少。

loan 一进入 terminal state (Settled、Defaulted 或 Liquidated) 即可
claim。lender position NFT 会在同一 transaction 中 burn。

<a id="claim-center.claims:borrower"></a>

#### 如果您是 borrower

borrower claim 根据 loan 如何 settle 来返回：

- **Full repayment / preclose / refinance** — 您的 collateral
  basket 回来。不会附带任何 Loan Initiation Fee rebate：您的折扣已在
  accept 时直接从费用中扣除。
- **结清该 loan 的 prepay sale** — collateral 归买家，不会退还给您。
  您拿到的是售价减去 lender 应得、treasury 抽成以及 listing 上带的
  卖方费用之后的金额，支付给持有 borrower position NFT 的人。
- **swap-to-repay** — 为偿还债务而卖出您的 collateral，上限由您设定。
  上限设得宽松时，消耗的可能多于债务严格所需；未被消耗的会回到您手中。
  loan 自身 asset 的盈余通常会直接付给 borrower NFT 持有人，而不是作为
  claim 等待——除非该持有人处于制裁冻结之下，那样它会以 claim 的形式
  被扣留。
- **HF-liquidation 或 default** — 仍请查看，可能还有 surplus。系统只取走
  足以支付 liquidator、lender 和 treasury 的那部分价值，余下的会记为您的
  claim。它的形式只取决于一件事：collateral 是被卖出，还是被交出。被卖出——
  也就是经交易所路由出去——剩余会以 loan 的 principal asset 到您手中。
  被交出，剩下的就是 collateral 本身，以 encumbered 状态留在您的
  vault 中。交出它的路径不止一条，而且都与 loan 以哪种方式结束无关：liquidator 按折扣直接拿走，close-out 没有
  送去交易所、而是在内部与一个反向 position 撮合，以及这笔卖出根本没能成交——那里 collateral 会到您手中——除非 lender 在 claim 时带来一份能成交的报价，那样就按 loan 的 asset
  支付；而大多数 claim 根本不带报价。普通 liquidation 和时间型 default
  都会在转向交易所之前先尝试这种内部撮合，所以这两条路径的结果都不是固定的——这正是应当去读
  claim，而不是从结束方式去推断的原因。折扣式拿走反而是确定的，只是方向相反：它既不卖出也不撮合，留给您的始终是 collateral。至于部分 liquidation，它根本不是
  close-out —— loan 仍然开着，也不会产生 claim。请查看 claim，而不要
  假设是哪一种。非流动资产的 default 会拿走整个 basket，什么也不剩
  ——在这条路径上这是规则，不是结果。

borrower position NFT 是在您 claim 时 burn，而不是在 loan 结清时——因此
liquidation 留下的 surplus 之后仍可领取。但 NFT 还在，本身并不证明有
surplus：如果 liquidation 什么也没剩下，就没有可领取的东西，claim 会被拒绝，
而 NFT 仍可能留着。请读 claim，而不是读 NFT。

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain 上与您 wallet 相关的 on-chain events，会从 protocol
logs 的 sliding block window 中实时获取。没有 backend cache — 每次
page load 都会重新 fetch。Events 会按 transaction hash 分组，因此
multi-event transactions (例如同一 block 中确认的 accept + initiate)
会保持在一起。最新在前。展示 offers、loans、repayments、claims、
liquidations、NFT mints 和 burns，以及 VPFI vault deposits / withdrawals。

---

## VPFI

<a id="buy-vpfi.overview"></a>

### 获取 VPFI

VPFI 可自由转让。您可以在 VPFI 交易的任何 open market 上获取它，
或者把它 bridge 进来：VPFI 是 Chainlink CCIP cross-chain token，
因此可以通过 official bridge 在受支持的 chains 间移动，并到达您
bridge 到的那条 chain 上的 wallet。

<a id="buy-vpfi.discount-status"></a>

### 您的 VPFI Discount Status

实时状态：

- 当前 tier (0 至 4)。
- Vault VPFI balance，以及到下一 tier 的 gap。
- 当前 tier 的 Discount percentage。
- Wallet 级 consent flag。

只要 vault VPFI 保持 deposit 状态，它就会计入您的 discount tier
— 除了下面的 explicit deposit step 之外，没有额外的 locking 操作。

<a id="buy-vpfi.deposit"></a>

### 把 VPFI deposit 到您的 vault

这是从您的 wallet 到同一 chain 上 vault 的 explicit deposit
step。每条 chain 都需要 — 包括 canonical chain — 因为按 spec，
vault deposit 始终必须是 explicit user action。在配置了 Permit2
的 chains 上，App 会优先使用 single-signature path，而不是传统的
approve + deposit pattern；如果该 chain 未配置 Permit2，则会
cleanly fall back。

<a id="buy-vpfi.unstake"></a>

### 从您的 vault withdraw VPFI

把 VPFI 从您的 vault withdraw 回 wallet。没有单独的 approval leg
— protocol 持有 vault，并 debit 自身。withdraw 会基于新的 (较低)
balance 立即触发 fee-discount rate re-stamp，并应用到您参与的每笔
open loan。没有让旧 tier 继续适用的 grace window。

<a id="buy-vpfi.cross-chain-tier"></a>

### 您的 VPFI tier 如何在链之间传递

您的 VPFI 存放在 canonical 链 Base 上的 vault 中，由 Base 计算您的
tier。当您在另一条链上借入或借出时，该链会使用您 tier 的一份副本；
每当有改变 tier 的存入、取出或其他操作时，Base 都会通过 Chainlink
CCIP 发送这份副本。

需要了解三点：

- **仅因时间推移而上升的 tier，需要在 Base 上有操作才会传递。** 在没有
  存入或取出的情况下，持有期满或平均值追上时，Base 上的数值会立即
  更新；其他链要等到您下一次在 Base 上存入或取出（金额不限）时才会
  得知。
- **较低的 tier 先传递。** 协议会立即发送较低的 tier，而较高的 tier
  每条链每天最多由协议付费一次。之后经 CCIP 送达通常需要几分钟。送达
  之前，该链继续使用您之前的 tier。
- **副本可能过期。** 若 60 天（默认值）内没有新副本，或者 tier 表的
  变更已到达该链，旧副本在该链上就不再提供折扣。只有当您的 tier 改变
  时才会发送新副本。

完整规则（包括除了您所用的链之外、在 Base 上也需要打开的折扣开关）见
下方"VPFI 折扣如何运作"一章。送达设计见
[tier 送达设计文档](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
（英文）。

---

## Rewards

<a id="rewards.overview"></a>

### 关于 Rewards

**Interaction pool** 按 per-day pro-rata 方式发放固定 daily
emission 的份额，按您对当天 loan volume 的 settled-interest 贡献
加权。Daily windows 会在 window 关闭后的第一次 claim 或 settlement
时 lazy finalise。

Rewards 直接在 active chain 上 mint — 用户不需要 cross-chain
round-trip。Cross-chain reward aggregation 只发生在 protocol
contracts 之间。

<a id="rewards.claim"></a>

### Claim Rewards

单笔 transaction 会 claim 您累计的 rewards。interaction rewards 在
相关 daily window finalise 之前为零 (lazy finalisation 由该 chain
上下一次 non-zero claim 或 settlement 触发)。当 window 仍在 finalise
时，UI 会 guard button，因此用户不会 under-claim。

<a id="rewards.withdraw-staked"></a>

### 从您的 vault 提取 VPFI

与 VPFI 章节中 "从您的 vault withdraw VPFI" 相同的 interface — 把
VPFI 从 vault withdraw 回 wallet。Withdrawn VPFI 会立即退出
discount accumulator (在每笔 open loan 上 post-balance re-stamp)。

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (本页)

从 protocol 实时 derive 的 single-loan view，加上来自 risk engine
的 live HF 和 LTV。它会 render terms、collateral risk、parties、
由您的 role 和 loan status 决定可用性的 actions，以及 inline
keeper status。

<a id="loan-details.terms"></a>

### Loan Terms

loan 的 immutable parts：

- Principal (asset 和 amount)。
- APR (在 offer creation 时固定)。
- 以天为单位的 Duration。
- Start time 和 end time (start time + duration)。
- Accrued interest，基于 start 后经过的秒数 live 计算。

Refinance 创建新 loan 而非修改这些 value。

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

live risk math。

- **Health Factor** = (collateral USD value × liquidation
  threshold) / debt USD value。HF 低于 1.0 时，position 会变得
  liquidatable。
- **LTV** = debt USD value / collateral USD value。
- **Liquidation threshold** = position 变为 liquidatable 时的
  LTV；取决于 collateral basket 的 volatility class。high-
  volatility collapse trigger 是 110% LTV。

Illiquid collateral 没有 on-chain USD value；HF 和 LTV 会显示为
"n/a"。唯一的 terminal path 是 default 时全额 collateral transfer —
双方在 offer creation 时已经通过 illiquid-risk acknowledgement 同意
这一点。

<a id="loan-details.collateral-risk:lender"></a>

#### 如果您是 lender

保障此 loan 的 collateral basket 就是您的保护。HF 高于 1.0 意味着
position 相对 liquidation threshold 是 over-collateralised。当 HF
向 1.0 drift 时，您的保护会变薄。一旦 HF 跌破 1.0，任何人 (包括您)
都可以调用 liquidate，protocol 会通过 4-DEX failover 把 collateral
route 成您的 principal asset。Recovery 是 slippage 之后的净额。

对于 illiquid collateral，default 时 basket 会在 default time 全额
转移给您 — 它在公开市场实际值多少，都由您承担。

<a id="loan-details.collateral-risk:borrower"></a>

#### 如果您是 borrower

这是您锁定的 collateral。请让 HF 安全地高于 1.0 — 抵御 volatility
时，常见的 safety margin 是 1.5。提高 HF 的 levers：

- **Add collateral** — 给 basket top up。User-only action。
- **Partial repay** — 减少 debt，提高 HF。

一旦 HF 跌破 1.0，任何人都可以触发 HF-based liquidation；swap 会
以受 slippage 影响的价格出售您的 collateral 来偿还 lender。在
illiquid collateral 上，default 会把您的全部 collateral 转给 lender，
且没有任何东西留给您 claim。

<a id="loan-details.parties"></a>

### Parties

Lender、borrower、lender vault、borrower vault，以及两个 position
NFTs (双方各一)。每个 NFT 都是带 on-chain metadata 的 ERC-721；
transfer 它，也会 transfer claim 权利。Vault contracts 对 address
是 deterministic 的 — 跨 deploy 仍是同一 address。

<a id="loan-details.actions"></a>

### Actions

Action interface 由 protocol 按 role gated。下面的 role-specific tabs
列出每一方可用的 actions。Disabled actions 会显示从 gate derive
出来的 hover-reason ("Insufficient HF"、"Not yet expired"、"Loan
locked" 等)。

无论 role 如何，所有人都可用的 permissionless actions：

- **Trigger liquidation** — 当 HF 跌破 1.0 时。
- **Mark defaulted** — 当 grace period 在未全额偿还的情况下到
  期时。

<a id="loan-details.actions:lender"></a>

#### 如果您是 lender

- **Claim as lender** — 仅在 terminal state 可用。返回 principal 和 interest
  减去 loan 创建时固定的 treasury cut (按当前费率创建的 loan 为
  `{liveValue:treasuryFeeBps}`%；consent on 时，会再由您的
  time-weighted VPFI yield-fee discount 降低)。会 burn lender position NFT。
- **Initiate early withdrawal** — 以 asking price 把 lender position
  NFT list 出售。完成销售的 buyer 会接管您这一侧；您获得 proceeds。
  sale fill 前可以 cancel。
- 可选地 delegate 给持有相关 action permission 的 keeper — 见 Keeper
  Settings。

<a id="loan-details.actions:borrower"></a>

#### 如果您是 borrower

- **Repay** — full 或 partial。Partial 会减少 outstanding 并提高 HF；
  full 会触发 terminal settlement。
- **Preclose direct** — 现在从您的 wallet 支付 outstanding amount，
  并 release collateral。
- **Preclose offset** — 通过 protocol 的 swap router 出售部分
  collateral，用 proceeds repay，并返还剩余。两步：initiate，然后
  complete。
- **Refinance** — 为新 terms 发布 borrower offer；一旦 lender accept，
  complete refinance 会 atomically swap loans，collateral 始终不离开
  您的 vault。
- **Claim as borrower** — 仅在 terminal state 可用。full repayment 时返还
  collateral；default / liquidation 时也可能还有 surplus，因为系统只取走偿还债务
  和了结它所需的那部分 collateral——参见上文的 Claim Center 一节。会 burn borrower position NFT。

---

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### 在 prepay listing 上匹配 OpenSea 报价

一旦您的 prepay listing 在 OpenSea 的市场上上线，休闲买家
有时会直接在您的令牌上放置 **item offers** — 与您特定的
抵押品相关联的出价，而不是与集合中的任何令牌相关联。
Vaipakam 在 Loan Details 页面上实时显示这些 item offers
— "在 OpenSea 上架抵押品" 下方的一个单独面板，每个
传入报价一行。该面板应用 **缓冲阈值** — 出借人的结算
entitlement（已包括本金 + 完整票面（在 full-term-interest
贷款上）或 pro-rata 利息（否则）— 参见
`PrepayListingFacet.getPrepayContext().lenderLeg`），加上
国库削减，加上安全缓冲 — 并将未达到的报价 **变灰**。您可以
在每个级别看到市场兴趣，但只能匹配协议实际会结算的报价。

集合范围 / criteria 报价（集合中任何令牌都可以满足的出价）
留在 OpenSea 上，但在 应用的 Match 面板中 **不显示** — 协议
结算的多腿 consideration 在没有 v1 中没有的合约端 plumbing 的
情况下无法针对 criteria 报价重建。如果您唯一的入站需求是集合
范围的，今天的实用路径是等待特定项目的出价，或将列表保留在
您的固定 ask 上，让任何买家直接满足它。您无法手动自己结算
集合范围的出价 — 抵押品 NFT 存在于您的 Vaipakam vault 中，
Vaipakam 端 Seaport 订单是唯一授权的结算形式。

在强制 OpenSea 协议费用和/或创作者版税的集合上，应用确实
渲染报价面板 — 来自 OpenSea API 的 fee-schedule 获取被视为
咨询性的；实际的 fulfillment 数据在 MATCH 单击时获取。Match
面板渲染与 fee-schedule 获取状态无关；单击时的 fulfillment-
data 获取是门控。如果该获取失败（速率限制、API 中断或不支持的
集合形状），应用端 Match 单击处理程序在构建任何
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` 交易之前
中止 — 没有 calldata，没有签名提示，没有 revert。链上函数
本身不是返回 `bool` 的选择器；当它运行时返回 `bytes32`
orderHash 或 revert。因此强制费用集合的面板可能会显示可浏览
的报价，但并非所有报价在给定时刻都可点击匹配。

当您找到可接受的报价并单击 **匹配报价** 时，应用会打开
**确认匹配** 模态框，它重申 匹配值（OpenSea 报价
的总金额 — 而不是 diamond 将结算的净金额；在强制费用集合上，
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` 在运行 lender /
treasury / borrower 分割之前计算 `effectiveAsk = offerValue -
bidderFeeTotal`，因此 diamond 实际分配的净额小于模态框的
标题）并提供 atomic-match 流程的通用说明。确认后，应用发送
一个单一的 `matchOpenSeaOffer` 交易，将出价人的报价与新构建的
diamond 端反订单捆绑到单个 Seaport `matchAdvancedOrders` 调用中
— 出价人 的满足、反订单的列表端 leg（无论您之前是否有 v1
prepay listing 上线；atomic 路径支持 `existingHash == 0`）以及
diamond 的结算瀑布都原子地在一个块中登陆。交易要么完全成功
（贷款以已还款关闭、NFT 转移、销售收益分割），要么完全 revert（没有
任何移动），并且在列表轮换和结算之间 **没有窗口** 让第三方
买家以匹配价格介入。

> **没有竞争窗口 — 按构造原子。** 这是 v1 两步 "cancel + post"
> 模式的结构性收尾：在 v1 下，应用会将列表作为单独的
> `updatePrepayListing` 交易轮换，将轮换的价格留在 OpenSea 上
> 直到出价人的 `fulfillOrder` 在后续块中登陆 — 任何监视
> mempool 的人都可以从出价人的出价中 snipe。Atomic 路径通过
> 将两个订单绑定到一个 Seaport match 调用中来关闭该漏洞：
> 要么出价人 以约定价格填充，要么整个交易 revert。

**单击 Match 之前您仍想验证的内容：**

- **在模态框中确认 匹配值。** 模态框显示 OpenSea 报价的
  总金额。在强制费用集合上，diamond 针对出价人端市场
  / creator fee 腿之后的净有效 ask 结算，因此模态值可能高于
  用于 lender / treasury / borrower 分割的金额。出价人地址
  和精确分割在模态框或 OpenSea Offers 面板行（行显示 value、
  payment token、报价类型、截断的出价人 和 end time）中都
  没有分解。分割由 diamond 在结算时在链上强制 — 协议的结算
  缓冲保证有效 ask 覆盖出借人的结算 entitlement（已包括
  本金 + 完整票面（在 full-term-interest 贷款上）或 pro-rata
  利息（否则））加上国库削减，因此分割对您始终至少是中性的。
  如果您希望在确认之前查看预计分割，diamond 将
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  公开为可调用视图 — 它返回结算瀑布将在给定时间戳路由的
  lender 和 treasury 腿，剩余部分归您所有。
- **检查集合的 OpenSea 费用态势。** 如果集合强制 OpenSea
  协议费用或创作者版税，atomic 路径需要 SignedZone
  `extraData` / criteria-resolver plumbing，应用通过 agent 的
  OpenSea fulfillment-data 代理（PR #349）在 MATCH 单击时
  获取。Match 面板渲染与 fee-schedule 获取状态无关；单击时
  的 fulfillment-data 获取是门控。如果该获取失败（速率限制、
  API 中断、不支持的集合形状），应用端单击处理程序在构建
  链上 `matchOpenSeaOffer` 交易之前中止 — 不构建 calldata，
  不触发签名提示，不预先显示横幅。您可以稍后重试单击（获取
  可能只是短暂的 API blip），或同时在 OpenSea 上直接以 listed
  ask 满足列表。

---

## 清算实际运作机制

您在报价时同意的风险披露用两句话概括了最坏情况。本节解释了底层机制——如果您想了解为什么要存在实物退路（in-kind fallback），或者您的贷款实际上会走四个分支中的哪一个，这将非常有用。

决定分割的合约函数是 `LibFallback.computeFallbackEntitlements`。它按顺序遍历四个案例；第一个匹配的案例将被执行。

<a id="liquidation-mechanics.case-1"></a>

### 案例 1 — 预言机可用，抵押品价值 ≥ 应付金额

健康路径。Chainlink 价格喂价响应正常，Soft 2-of-N 次级法定人数（Tellor + API3 + DIA）未产生分歧，且按预言机定价，罚没的抵押品足以覆盖所欠金额。

发生的情况：

- 出借人收到价值（本金 + 应计利息 + 3% 退路奖金）的**抵押资产**，按预言机定价。实际上：出借人按公允价值获得偿付，但以抵押资产而非借贷资产支付。
- 国库收取的本金 2% 的溢价，也以抵押品定价。
- 借款人收到抵押品的**余项**。这是一笔真实的退款——它是覆盖出借人索赔所不需要的超额抵押部分。

示例：一笔 1000 USDC 的贷款，抵押品为 0.6 WETH（3000 美元抵押品，1000 美元债务）。预言机定价 ETH 为 5000 美元/WETH；债务 + 利息 + 奖金 = 1050 美元。出借人收到 0.21 WETH（价值 1050 美元），国库收到 0.004 WETH（2% 溢价，价值 20 美元），借款人收到剩余的约 0.386 WETH。

<a id="liquidation-mechanics.case-2"></a>

### 案例 2 — 预言机可用，抵押品价值 < 应付金额

水下（资不抵债）路径。预言机正常工作，但即使按预言机价格计算，罚没的抵押品价值也低于应付金额。常见于波动资产崩盘，抵押品价值下降速度超过 HF 反应速度的情况。

发生的情况：

- 出借人收到**全部**罚没的抵押资产。
- 国库不收取任何费用。
- 借款人什么也收不到——没有余项可退还。

出借人承担缺口。对借款人、协议或任何第三方不再有进一步的索赔。这就是风险披露中“收回的资产可能少于借出的资产”这一行专门警告的情况。

示例：同样的 1000 USDC / 0.6 WETH 贷款，但 ETH 跌至 1500 美元/WETH。抵押品现价值 900 美元；债务为 1050 美元。出借人收到全部 0.6 WETH（价值 900 美元），国库为 0，借款人为 0。

<a id="liquidation-mechanics.case-3"></a>

### 案例 3 — 预言机法定人数不可用

黑暗预言机路径。Chainlink 的延迟超过了波动上限，且 2-of-N 次级法定人数无法达成一致（每个次级预言机要么离线，要么与主预言机不一致）。协议没有可信的价格来计算贷款的任何一侧，因此无法计算公允分割。

发生的情况：

- 出借人收到**全部**罚没的抵押资产，**无论计算出的价值如何**（因为没有任何计算是可信的）。
- 国库不收取任何费用。
- 借款人什么也收不到。

支付情况与案例 2 相同，但原因根本不同：协议并非判定“抵押品价值低于债务”，而是判定“我不信任这里的任何数字，因此出借人获得整个罚没资产包，并承担其在公开市场上的最终价值”。

会发出不同的链上事件 (`LiquidationFallbackOracleUnavailable`)，以便审计师在事后分析中区分这两条路径。

<a id="liquidation-mechanics.case-4"></a>

### 案例 4 — 任意一侧为非流动性资产

非流动性资产路径。借贷资产、抵押资产或两者都不符合协议分类器中的“流动性”标准（没有 Chainlink 喂价，或没有超过交易量阈值的 Uniswap-V3 式集中流动性池）。常见于 NFT 抵押品和长尾代币。

违约时发生的情况：

- 出借人实物接收**全部抵押品**，无论市场价值如何。
- 不对“所欠金额”和“余项”进行划分——无法应用预言机定价。
- 资产价值可能大幅高于或低于所欠金额。不保证可转售性。

双方在创建报价时都同意了这一点——风险披露中的“非流动性资产”条款涵盖的正是这种情况。除非双方知情选择进行涉及非流动性资产的贷款，否则无法触及此分支。

<a id="liquidation-mechanics.why-in-kind"></a>

### 为什么是实物支付，为什么不总是现金？

协议以抵押资产单位而非总是换成借贷资产进行支付的三个原因：

- **定序器/DEX 停机**：当协议无法安全执行互换（滑点 > 6%、流动性稀缺、DEX 回滚、定序器宕机）时，最安全的操作是直接交付已有的东西——罚没的抵押品。不惜代价强制互换会锁定损失。
- **黑天鹅包络线**：在波动级联中，预言机可用路径可能在几分钟内消失。预设实物退路使协议在每个价格源都退化时仍能保持功能。
- **交易对对手方回收**：在索赔时，出借人（或其 keeper 机器人）可以在完整的 4-DEX failover 上获得第二次尝试机会。如果届时情况已恢复正常，他们可以通过在清算时尝试过的同一路由基础设施，将实物抵押品出售为借贷资产。

<a id="liquidation-mechanics.claim-time-retry"></a>

### 索赔时重试

`ClaimFacet.claimAsLenderWithRetry` 允许出借人（或代表出借人 NFT 的 keeper）在贷款处于 `FallbackPending` 状态时提供互换适配器调用（0x → 1inch → Uniswap V3 → Balancer V2）的排名重试列表。库遍历列表，在第一次成功时提交，并将出借人 + 借款人的索赔重写为本金资产收益。

完全失败将保留记录的抵押品分割原样，并将贷款终端转换为违约 (Defaulted) 状态——此时出借人拿走实物抵押品，并可以自由通过任何外部场所出售。

<a id="liquidation-mechanics.internal-match-rescue"></a>

### 索赔前内部匹配救援

在任何外部互换运行之前——在 HF 清算、基于时间的违约以及索赔时——协议首先检查是否存在可以完全无需 DEX 参与即可结算此贷款的**反向贷款**。

如果贷款 A 需要将 WETH 出售为 USDC，而贷款 B 需要将 USDC 出售为 WETH，则两者可以直接匹配：A 的抵押品覆盖 B 的债务，反之亦然，按协议预言机定价。没有聚合器，没有滑点，没有互换费。借款人保留了远多于其抵押品的资产；出借人按预言机价格获得足额偿付。

此内部匹配路径自动运行：

- **在 HF 清算时** — 当 keeper 调用 liquidate 且存在反向交易对手时，协议在内部结算而非互换。Keeper 仍能赚取撮合激励。
- **在基于时间的违约时** — 在违约互换前进行同样的检查。
- **在索赔时** — 当出借人索赔卡在 `FallbackPending` 状态的贷款时，协议会重新检查是否存在反向交易对手。这是一个真正的第二次机会：可匹配贷款池在不断增长，因此在清算最初失败时不存在的交易对手，在您索赔时可能已经存在。

由于清算时互换*瞬时*失败（暂时的滑点峰值、DEX 回滚、过时的预言机 tick）而进入 `FallbackPending` 的贷款是主要的救援候选对象——底层抵押品通常仍然完全流动，反向贷款可以干净地清除它。协议仅要求预言机仍能对资产定价；它不要求 DEX 具有深度，因为内部匹配从不涉及 DEX。

如果不存在反向交易对手，协议将回退到上述外部聚合器路径。内部匹配是一种只要可用就绝对更好的优化，绝非阻碍。

---

## Allowances

<a id="allowances.list"></a>

### Allowances

列出您 wallet 在这条 chain 上授予 protocol 的每个 ERC-20 allowance。
数据来自对 candidate-token list 扫描 on-chain allowance views。
Revoking 会把 allowance 设为 zero。

按 exact-amount approval policy，protocol 从不要求 unlimited
allowances，所以典型的 revocation list 很短。

注意：Permit2-style flows 通过单个 signature 避免 protocol 上的
per-asset allowance，所以这里的 clean list 不会阻止未来 deposits。

---

## Alerts

<a id="alerts.overview"></a>

### 关于 Alerts

一个 off-chain watcher 会以 5-minute cadence poll 与您 wallet 相关
的每笔 active loan，读取每笔的 live Health Factor，并在 unsafe
direction 出现 band crossing 时，通过配置的 channels fire 一次。
无 on-chain state，无 gas。Alerts 是 advisory — 它们不会移动 funds。

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

用户配置的 HF bands ladder。跨入更危险的 band 会 fire 一次，并 arm
下一个更深的 threshold；回到上方 band 后会 re-arm。Defaults：1.5
→ 1.3 → 1.1。对 volatile collateral，更高的数字更合适。Ladder
唯一的工作，就是在 HF 跌破 1.0、触发 liquidation 之前把您提醒出来。

<a id="alerts.delivery-channels"></a>

### Delivery Channels

两条 rail：

- **Telegram** — 带有 wallet 短地址、loan id 和当前 HF 的 bot
  私信。
- **Push Protocol** — 通过 Vaipakam Push channel 的 wallet
  直达通知。

两者共享 threshold ladder；为避免 drift，per-channel 警告级别
故意不单独暴露。Push channel publishing 当前在等待 channel 创建
期间保持 stub 状态。

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### 验证 NFT

给定一个 NFT contract address 和 token id，verifier 会 fetch：

- 当前 owner (如果 token 已被 burn 则是 burn signal)。
- on-chain JSON metadata。
- 一个 protocol cross-check：从 metadata 派生底层 loan id 并从
  protocol 读取 loan details 以确认 state。

展示：是否由 Vaipakam mint？哪条 chain？loan status？当前 holder？
这可以帮助您发现 counterfeit、已经 claim 过的 (burned) position，
或 loan 已 settle 且处于 claimable 状态的 position。

position NFT 是 bearer instrument — 在 secondary market 购买前请先
verify。

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### 关于 Keepers

每个 wallet 最多 5 个 keepers 的 keeper allowlist。每个 keeper 都有
一个 action permission set，用来授权它对**您这一方**的 loan 执行特定
maintenance calls。Money-out paths (repay、claim、add collateral、
liquidate) 按设计都是 user-only，不能 delegate。

action time 还会应用两个额外 gates：

1. master keeper-access switch — 一个 one-flip emergency brake，
   可以禁用所有 keeper，而不触动 allowlist。
2. 在 Offer Book 或 Loan Details interface 上设置的 per-loan
   opt-in toggle。

只有四个条件都为 true 时，keeper 才能 act：approved、master switch
on、per-loan toggle on，并且该 keeper 具有对应的 action permission。

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

当前暴露的 action permissions：

- **Complete loan sale** (lender 一方，secondary-market exit)。
- **Complete offset** (borrower 一方，通过 collateral sale 进
  行 preclose 的第二段)。
- **Initiate early withdrawal** (lender 一方，将 position list 出售)。
- **Initiate preclose** (borrower 一方，启动 preclose flow)。
- **Refinance** (borrower 一方，对新 borrower offer 进行 atomic
  loan swap)。

frontend 尚未 reflect 的 on-chain permissions 会得到清晰的
"invalid permission" revert。Revocation 会在所有 loans 上即时生效
— 无等待期。

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### 关于 Public Analytics

一个 wallet-free aggregator，从每条受支持 chain 上的 on-chain
protocol view calls 实时计算。无 backend，无 database。提供 CSV /
JSON export；为了 verifiability，会显示 protocol address，以及
backing 每个 metric 的 view function。

<a id="public-dashboard.combined"></a>

### Combined — 所有 Chains

Cross-chain rollup。header 会报告覆盖了多少 chains，以及多少 chains
errored；因此 fetch time 无法到达的 RPC 是 explicit 的。当一条或
多条 chains errored 时，per-chain table 会标记是哪一条 — TVL totals
仍会 report，但 gap 会被明确说明。

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

combined metrics 的 per-chain split。可用于发现 TVL concentration、
mismatched VPFI mirror supplies (mirror supplies 之和应等于 canonical
adapter 的 locked balance)，或 stalled chains。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

active chain 上的 on-chain VPFI 会计：

- Total supply，直接从 ERC-20 读取。
- Circulating supply — Total supply 减去 protocol 持有的 balance
  (treasury、reward pools、in-flight bridge packets)。
- 剩余 mintable cap — 仅在 canonical chain 上有意义；mirror
  chains 对 cap 报告 "n/a"，因为那里的 mint 是 bridge-driven，
  而非从 cap mint。

Cross-chain invariant：所有 mirror chains 上的 mirror supplies 之和
应等于 canonical adapter 的 locked balance。watcher 会监控这一点，
并在出现 drift 时 alert。

<a id="public-dashboard.transparency"></a>

### Transparency & Source

对于每个 metric，页面会列出：

- 用作 snapshot 的 block number。
- 数据 freshness (跨 chain 的最大延迟)。
- protocol 地址和 view function 调用。

任何人都可以从 RPC + block + protocol address + function name 重新
推导此页面上的任何数字 — 这就是验证标准。

---

## Refinance

此页面仅限 borrower — refinance 由 borrower 在自己的 loan 上发起。

<a id="refinance.overview"></a>

### 关于 Refinancing

Refinance 会用新的 principal atomically pay off 您现有的 loan，并
以新 terms open 一笔新 loan，全部在一笔 transaction 中完成。
Collateral 始终留在您的 vault 中 — 没有 unsecured window。与任何
其他 loan 一样，新 loan 必须在 initiation 时通过 HF ≥ 1.5 gate。

<a id="refinance.position-summary"></a>

### 您的当前 Position

正在 refinance 的 loan 的 snapshot — 当前 principal、到目前为止
accrued interest、HF / LTV 和 collateral basket。新 offer 至少需要
size 到 outstanding amount (principal + accrued interest)；新 offer
中的任何 excess 都会作为 free principal 交付到您的 vault。

<a id="refinance.step-1-post-offer"></a>

### Step 1 — 发布新 Offer

发布带有目标 terms 的 borrower offer。在您等待时，旧 loan 继续
accrue interest；collateral 保持锁定。Offer 会出现在 public Offer
Book 中，任何 lender 都可以 accept。acceptance 之前可以 cancel。

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

新 lender accept 之后的 atomic settlement：

1. 由 accepting lender fund 新 loan。
2. 全额 repay 旧 loan (principal + interest，减去 treasury cut)。
3. 将旧 loan 标记为已还款。其 position NFT 不会被 burn：两枚都留在
   持有者手中，状态为 Loan Repaid。旧 lender 用自己的 NFT claim
   还款，旧 borrower NFT 作为收据保留。
4. Mint 新 position NFT。

如果新 terms 下 HF 低于 1.5，则 revert。

---

## Preclose

此页面仅限 borrower — preclose 由 borrower 在自己的 loan 上发起。

<a id="preclose.overview"></a>

### 关于 Preclose

borrower-driven early termination。两条 paths：

- **Direct** — 从您的 wallet 支付 outstanding amount (principal +
  accrued interest)，并 release collateral。
- **Offset** — initiate offset，通过 protocol 的 4-DEX swap failover
  为 principal asset 出售一部分 collateral；complete offset，用
  proceeds repay，剩余 collateral 返回给您。

没有 flat early-close penalty。

<a id="preclose.position-summary"></a>

### 您的当前 Position

正在 preclose 的 loan 的 snapshot — outstanding principal、accrued
interest、当前 HF / LTV。Preclose flow 在 exit 时**不**要求 HF ≥ 1.5
(这是 closure，不是 re-init)。

<a id="preclose.in-progress"></a>

### Offset In Progress

State：offset 已 initiate，swap 仍在执行中 (或 quote 已被
consume，但 final settle pending)。两个 exits：

- **Complete offset** — 用 realised proceeds settle loan，返还
  剩余。
- **Cancel offset** — abort；collateral 保持锁定，loan 不变。当 swap
  在 initiate 和 complete 之间向不利方向移动时使用。

<a id="preclose.choose-path"></a>

### 选择 Path

Direct path 会消耗 wallet 中的 principal asset liquidity。Offset path
通过 DEX swap 消耗 collateral；当您手上没有 principal asset，或也
想退出 collateral position 时，这是 preferred path。Offset slippage
由 liquidations 使用的同一 4-DEX failover (0x → 1inch → Uniswap V3
→ Balancer V2) 约束。

---

## Early Withdrawal (Lender)

此页面仅限 lender — early withdrawal 由 lender 在自己的 loan 上发起。

<a id="early-withdrawal.overview"></a>

### 关于 Lender Early Exit

lender positions 的 secondary-market mechanism。您以选定价格 list
position NFT 出售；acceptance 时，buyer 付款，lender NFT 的 ownership
转给 buyer，buyer 成为未来所有 settlement (terminal 时 claim 等) 的
lender of record。您带着 sale proceeds 离开。

Liquidations 仍然是 user-only，并且**不会**通过 sale delegate — 只有
claim 权利会 transfer。

<a id="early-withdrawal.position-summary"></a>

### 您的当前 Position

Snapshot — outstanding principal、accrued interest、剩余时间，以及
borrower side 当前的 HF / LTV。这些数字会决定 buyer market 预期的
fair price：buyer 的 payoff 是 terminal 时的 principal 和 interest，
再扣除剩余时间里的 liquidation risk。

<a id="early-withdrawal.initiate-sale"></a>

### Initiate the Sale

以您的 asking price 通过 protocol list position NFT 出售。buyer
complete sale；sale fill 前您可以 cancel。可选地 delegate 给持有
"complete loan sale" permission 的 keeper；initiate step 本身保持
user-only。

---

## 被困代币找回

本节涵盖了大多数用户永远不会遇到的**极端情况 (EDGE CASE)**。在点击底部的找回链接之前，请完整阅读本节内容——根据协议的制裁政策，声明错误的来源可能会导致您的 vault 被锁定。

<a id="stuck-recovery.what"></a>

### 什么是“被困代币”

您的 Vaipakam Vault 代理是协议的内部存储，它**不是**存款地址。协议支持的每一项存款都必须通过 Vaipakam 的 Facet 入口点进行，这些入口点会在报价创建、贷款接受或存入操作中，将资金从您的钱包“拉取”到您的 vault。在这些流程之外到达 vault 的代币——例如直接从钱包进行的 `IERC20.transfer` 或复制粘贴 vault 地址进行的 CEX 提现——会在没有协议簿记的情况下停留在那里。资产查看器通过仅显示协议追踪的余额来隐藏这些代币。

代币被困主要有两种方式：

1. **您误操作发送了代币。** 您将 vault 地址（从 Dashboard 或区块链浏览器获取）复制到了 CEX 提现字段或钱包的发送表单中并提交。代币未经过协议的存款路径直接进入了您的 vault。

2. **第三方发送了代币（“粉尘攻击”）。** 有人从被标记的钱包向您的 vault 转入少量代币，试图将您的地址与其声誉关联起来。这是针对无许可链上高知名度地址的一种真实攻击手段。

<a id="stuck-recovery.taint-poisoning"></a>

### 关于“污点污染”

如果第三方发送者在制裁名单上，通用的链上分析工具可能会将您的 vault 标记为“制裁相关”，即使您从未接触过这些转入的代币。链上没有任何方法可以撤销这一操作——转账事件是永久性的。Vaipakam 的**内部**簿记不受影响（我们仅追踪协议介导的存款，粉尘永远不会进入我们的计数器），因此您的贷款/存入/索赔仍可正常进行。但外部工具由于不了解我们的会计机制，可能会显示警告。

<a id="stuck-recovery.dont-recover"></a>

### 何时不应找回

如果您**不是**自己发送的这些代币，**请不要尝试找回它们**。找回操作要求您声明发送者的地址。如果该地址在制裁名单上，您的 vault 将根据协议的制裁政策被锁定，直到该来源从预言机中除名。

不属于您的代币请不要去动。通过声明一个您并不实际拥有的“干净”地址来找回代币同样不明智——协议虽然无法在链上验证您的声明，但外部预言机工具后续可能会产生分歧。

最安全的做法是忽略这些未经请求的粉尘代币。它们不会影响您的协议余额或任何活跃的贷款/报价。

<a id="stuck-recovery.when-recover"></a>

### 何时可以找回

当您因失误亲自发送了代币，且您控制着来源钱包，并且确认该来源不在任何制裁名单上时（例如您自己的 EOA 钱包、您提现的 CEX 热钱包等）。

<a id="stuck-recovery.flow"></a>

### 找回流程

1. 访问 [找回页面](https://defi.vaipakam.com/recover)。
2. 输入代币合约地址、您发送的来源地址和金额。
3. 仔细阅读屏幕上的确认说明。
4. 输入 “CONFIRM” 以启用签名。
5. 在您的钱包中签署 EIP-712 确认。
6. 提交交易。

结果有两种可能：

- **来源干净** → 代币返回您的 EOA 钱包。
- **来源被标记** → 代币留在 vault 中，您的 vault 根据协议的制裁政策被锁定。如果该地址后续被从制裁预言机中移除，锁定会自动解除。

<a id="stuck-recovery.disown"></a>

### 声明弃权未经请求的代币（合规审计追踪）

如果您希望在链上保留一份公开记录，声明您 vault 中的某些代币余额**不**属于您，协议提供了 `disown(token)` 函数。它会发出一个事件 (`TokenDisowned`)，除此之外不改变任何内容——代币仍像以前一样留在 vault 中。在合规纠纷中，如果 CEX 或监管机构询问“您是否收到了这些资金？”，这很有用：您可以指向该链上事件。

目前 `disown` 函数仅通过直接合约调用公开；Vaipakam 前端尚未提供对应按钮。请使用区块链浏览器的“Write Contract”界面或合约交互工具进行调用。

## VPFI 折扣如何运作

在 canonical 链 Base 的 vault 中持有 VPFI，可以让您在平台运行的每条链
上获得协议自身费用的折扣。持有越多、持有越久，tier 越高，折扣越大。
tier 列表见上方的 [Tier ladder](#dashboard.fee-discount-consent)；
governance 可以修改它。

折扣适用于：

- **作为 lender**：协议从您所赚利息中收取的收益费。每次结算利息时
  （例如还款、preclose 或 refinance）都会读取，使用的是当时的 tier，
  而不是 loan 开始时的 tier。
- **作为 borrower**：loan 开始时收取的 Loan Initiation Fee。只在 accept
  时读取一次，并固定在该 loan 上。仅当 lending asset 为 liquid 时适用；
  illiquid 的 loan 支付全额费用。

折扣直接从费用本身扣减，以 loan 的资产计价，不会为此从您的 vault 中
转出任何 VPFI。唯一的例外是在配置了 VPFI 价格参考的部署上，lender 的
折扣可以改为从您的 vault 中以 VPFI 结算；上线时没有配置。本章讨论的是
这种持有折扣。另一种付费费用模式"Full"保持关闭，除非某个部署将其开启。

### 开启折扣

折扣需要主动开启（opt-in）。开关位于 VPFI 页面，每条链各有一个，因为
每条链保存自己的设置：

- **在收取费用的链上**，开关必须打开；否则无论您的 tier 是多少，该链
  都会收取全额费用。
- **在 Base 上**，即使您从不在那里借入或借出，开关也必须打开。开关
  关闭期间，Base 会向所有其他链发送您的 tier 为零。

当您在 Base 上关闭折扣时，应用会紧接着发送一次 tier 更新，让所有其他链也停止使用折扣：Base 会向它们发送您的 tier 为零。如果第二步失败，页面会说明，其他链会保留您最后的 tier，直到有新的 tier 发出。在其他任何链上关闭折扣，只会改变那一条链。

当协议把 VPFI 记录在您的 vault 中时，它才计入：包括您通过 VPFI 页面存入的 VPFI，以及协议发放到您 vault 中的 VPFI rewards。直接发送到您 vault 地址的代币不受协议跟踪，不会提高您的 tier。

### 您的 tier 如何计算

您的 tier 由三项独立的检查决定，三项都必须通过：

1. **最短持有期。** 在您当前的持有持续至少 3 天之前，tier 保持为零。
   持有从 vault 余额超过零的那一刻开始，一直持续到余额回到零。追加
   不会重新计时；全部取出则会。（3 天为默认值；governance 可将其设为
   2 到 14 天。）
2. **侧重近期的加权平均。** 您的余额按最近 30 天取平均，其中最后 7 天
   的权重是之前各天的三倍。平均不会追溯到当前持有开始之前，因此新
   持有者不会被一无所有的日子摊薄。（窗口、近期天数和权重都是
   governance 设置；窗口可为 14 到 30 天。）
3. **您触及过的最低 tier。** 与平均值分开，您的 tier 不能高于当前持有
   期间余额达到过的最低 tier，最多回看 30 天。按每天的最低点计算，
   因此同一天内下跌后又恢复，仍算作一次下跌。

这在实际中意味着：

- 在 loan 结算前夕存入，不会立刻提高您的 tier。新增金额必须先进入
  平均值，而您触及过的最低点仍会限制您。
- 一次让您低于某个 tier 门槛的取出，会立即降低您的 tier。
- 30 天以前的下跌不再限制您。

### 您在其他链上的 tier

tier 由 Base 计算。所有其他链都使用 Base 通过 Chainlink CCIP 发送的
副本。每当有改变您 tier 的存入、取出或其他操作，Base 都会发送新副本。

每条链单独送达。无法送达的链不会拖住其他链，并且**送达无法发出时，
绝不会导致您自己的操作失败**：您在 Base 上的 tier 立即更新，其他每条
链在送达之前都处于"待送达"状态。

这些送达由协议付费，但有一个限制：

- **较低的 tier** 只要预算付得起，就会立即发送。送达之前，该链继续
  使用您之前较高的 tier。
- **较高的 tier** 或 tier 表的变更，每条链每天最多付费一次（governance
  设置，1 小时到 7 天之间）。在此之前，该链保留您之前的 tier。
- 任何人都可以支付跨链费用，让待送达的更新更早送达。合约支持这样做；
  应用目前尚未提供。

在以下情况下，副本不再计入，该链也就不提供折扣：

- 副本早于该链的最长有效期（默认 60 天，不少于 30 天）；或
- 副本基于比该链现在所知更旧的 tier 表生成。

只有当副本中的内容会发生变化时，副本才会重新发送：您的 tier、其折扣、有效期限，或 tier 表的版本。因此在 tier 表变更后，即使您的 tier 不变（只要不为零），您在 Base 上的下一次存入、取出或 tier 刷新都会向每条链发送一份新副本。如果这些都没有变化，副本已过期的链在有变化之前不会给予折扣。

如果您的 tier 只是因为时间推移而上升（持有期已满或平均值已追上），
而没有存入或取出，Base 要到您下一次存入或取出时才会察觉。合约提供了
一个您可以自己调用的 tier 刷新调用；应用只会在您关闭折扣时替您调用。

### 面向运营者

折扣的跨链部分需要以下配置。列在这里，供运行自己部署的人参考。

**在 Base 上：**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`。没有它，Base 会计算
  tier，但不会发送到任何地方。
- 指向 `VaipakamRewardMessenger` 的
  `RewardReporterFacet.setRewardMessenger`，以及 messenger 上列出所有
  其他链的 `setBroadcastDestinations`。
- 有资金的 broadcast 预算：`ProtocolBroadcastFacet.topUpBroadcastBudget()`
  （payable）。预算为空不会阻塞任何操作。它付不起的每次送达都保持
  待送达，并带原因发出 `TierPushDeferred`；`getTierPushStatus(user)`
  显示某个用户在每条链上的状态。预算不足意味着其他链会更长时间地使用
  旧 tier，因此请关注延迟并及时补充。
- 付费上调的间隔窗口：`setTierPushSpacingSec`（默认 1 天，1 小时到
  7 天）。

**在其他每条链上：**

- `RewardReporterFacet.setRewardMessenger(addr)`：该链唯一接受其 tier
  更新的发送方。
- `RewardReporterFacet.setBaseChainId(chainId)`：Base 的 EVM chain id
  （主网 8453，Base Sepolia 84532），而不是它的 CCIP chain selector。
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`：副本计入的时长（默认
  60 天；低于 30 天的值会被拒绝）。调低后在下一次读取时生效。

**修改 tier 表：**

- Base 上的 `setVpfiTierThresholds` 和 `setVpfiTierDiscountBps` 会推进
  表的版本。其他链会从第一条携带新版本的 tier 更新（无论来自哪个用户）
  得知新版本。从那时起，基于旧表生成的每份副本都按无折扣处理，直到该
  用户自己的更新送达；而这些更新属于上调，每个间隔窗口最多付费一次。
  修改表之前请先补充预算。
- `setTwaMinStakedDays` 修改最短持有期，但不推进版本。在下一次读取时
  生效。
