# Vaipakam — 用户指南 (Advanced Mode)

这是 App 中每张 card 的精确、技术准确说明。每个章节都对应 card
标题旁边的 `(i)` info icon。

> **您正在阅读 Advanced 版本。** 它对应 App 的 **Advanced** 模式
> (更密集的 controls、diagnostics、protocol-config 详情)。如需更
> 友好、更易懂的说明，请将 App 切换到 **Basic** 模式 — 打开
> Settings (右上角的齿轮图标) → **Mode** → **Basic**。之后 App 内
> 的 (i) "Learn more" 链接会开始打开 Basic 指南。

---

<a id="chapter.dashboard"></a>

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

<a id="chapter.offer-book"></a>

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

<a id="chapter.create-offer"></a>

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


<a id="chapter.claim-center"></a>

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

<a id="chapter.activity"></a>

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

<a id="chapter.vpfi"></a>

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

<a id="chapter.rewards"></a>

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

<a id="chapter.loan-details"></a>

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

<a id="chapter.how-liquidation-actually-works"></a>

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

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### 关于 Public Analytics

一个无需钱包的单链页面：它读取应用所指向的链（未连接钱包时为默认
读取链）。没有跨链汇总，也没有导出；要比较各链，请在每条链上分别
打开页面。两个来源，在使用处各自标明：

- 索引器无需密钥、开放 CORS 的读取 API——借贷、报价、回收和闭环
  数据；
- 通过公共 RPC 调用 Diamond 自身的视图函数——VPFI 代币与费用
  数据。

任一来源都可以直接查询，以复现页面显示的内容。

<a id="public-dashboard.loans-offers"></a>

### 借贷与报价

来自 `/loans/stats` 的按状态借贷计数，包括待结算、内部撮合和其余
类别，使各部分之和等于总数；ERC-20 与 NFT 租赁的小计，其中资产类型
尚未读取的活跃借贷会单独列出；以及来自 `/offers/stats` 的报价计数。
报价仅指 `offers` 表——免 Gas 的签名订单不计入——且已取消的报价会
从索引中移除，因此报价总数不是累计数字。缺失的计数显示"未报告"，
不可能的值显示"已报告，但不是可用的计数"；两者都不会显示为 0。

<a id="public-dashboard.recycling"></a>

### 回收账户与闭环

回收账户（`/metrics/recycling`）按计划自己的日序号列出每个计划日的
奖励池、其资金来源和提取额；未最终确定的日子不显示奖励池，未启用的
日子标为估算。闭环（`/metrics/loop-closure`）按 UTC 日显示领取支付
了多少、留在金库中多少、回收吸收了多少，并标明记录所到达的时刻。
低于显示精度的正数金额会加以标注，比例向下取整，未知数字绝不显示
为零。

<a id="public-dashboard.transparency"></a>

### 透明度与来源

Diamond 地址（附浏览器链接）、链，以及索引器游标的区块和时长。
每个来自索引器的数字都只新到这个游标为止；合并两个响应时，标明的是
较旧的游标。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI 代币

来自 Diamond 上的 `getVPFISnapshot()`：此链上的代币地址和
`totalSupply`。在规范链上，还包括上限、余量（`cap − totalSupply`，
即仍可铸造的数量）和铸造者。在镜像链上，快照不含上限和铸造者——那里
的供应通过 CCIP 代币池到达——因此页面显示本链供应量，并说明上限和
铸造者属于规范链，而不是显示零。未绑定的代币与无法读取的快照会分别
说明。

<a id="public-dashboard.fees"></a>

### 费用与金库

来自 `getTreasuryMetrics()`、`getTreasury()` 和
`getNumeraireSymbol()`，与快照在同一个 Multicall3 聚合中读取，并固定
在一个区块上，页面会标明该区块及其时长：

- 自费用账本开始以来，以及过去 24 小时和 7 天的费用，每笔在记录时
  以计价单位计值，之后不再重新计值；
- 协议在记录时无法计值的费用记为 0，时间窗口的合计最多只扫描最近
  10,000 条账本记录——这两者都只会使数字偏低，页面对此加以说
  明；
- 计价单位更换后之前的记录仍保留旧单位，因此更换之后的合计会在当前符
  号下把两种单位的金额相加，可能偏高也可能偏低；页面会说明之前的费用
  按旧单位计算；
- 金库地址。如果是外部地址，费用在收取时即转出，页面不显示其余额。
  如果 Diamond 本身就是金库，则显示其持有额，仅按出现在未结借贷中的
  资产计值，并包括代表金库存放在其他地方的金额。

失败的视图函数显示"无法读取"，且不会隐藏其他内容。

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.stuck-token-recovery"></a>

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

- **来源干净** → 代币会计入您 vault 的记录余额。请照常从 vault 提取；如果开启了受保护账户模式，将适用其付款延迟。
- **来源被标记** → 代币留在 vault 中，您的 vault 根据协议的制裁政策被锁定。如果该地址后续被从制裁预言机中移除，锁定会自动解除。

<a id="stuck-recovery.disown"></a>

### 声明弃权未经请求的代币（合规审计追踪）

如果您希望在链上保留一份公开记录，声明您 vault 中的某些代币余额**不**属于您，协议提供了 `disownUntracked(kind, asset, tokenId)` 函数。它会发出一个事件 (`UntrackedDisowned`)，除此之外不改变任何内容——代币仍像以前一样留在 vault 中。在合规纠纷中，如果 CEX 或监管机构询问“您是否收到了这些资金？”，这很有用：您可以指向该链上事件。

目前 `disown` 函数仅通过直接合约调用公开；Vaipakam 前端尚未提供对应按钮。请使用区块链浏览器的“Write Contract”界面或合约交互工具进行调用。

<a id="chapter.how-vpfi-discounts-work"></a>

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

<a id="vpfi-discounts.turning-on"></a>

### 开启折扣

折扣需要主动开启（opt-in）。开关位于 VPFI 页面，每条链各有一个，因为
每条链保存自己的设置：

- **在收取费用的链上**，开关必须打开；否则无论您的 tier 是多少，该链
  都会收取全额费用。
- **在 Base 上**，即使您从不在那里借入或借出，开关也必须打开。开关
  关闭期间，Base 会向所有其他链发送您的 tier 为零。

当您在 Base 上关闭折扣时，应用会紧接着发送一次 tier 更新，让所有其他链也停止使用折扣：Base 会向它们发送您的 tier 为零。如果第二步失败，页面会说明，其他链会保留您最后的 tier，直到有新的 tier 发出。在其他任何链上关闭折扣，只会改变那一条链。

当协议把 VPFI 记录在您的 vault 中时，它才计入：包括您通过 VPFI 页面存入的 VPFI，以及协议发放到您 vault 中的 VPFI rewards。直接发送到您 vault 地址的代币不受协议跟踪，不会提高您的 tier。

<a id="vpfi-discounts.tier-calculation"></a>

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

<a id="vpfi-discounts.other-chains"></a>

### 您在其他链上的 tier

tier 由 Base 计算。所有其他链都使用 Base 通过 Chainlink CCIP 发送的副本。当 Base 上发生以下任一情况时，Base 会更新您的 tier 记录：VPFI 进入或离开您的 vault（存入、取出，或发放到其中的 rewards）；一笔以您为出借人或借款人的贷款开始；某个贷款步骤冻结或释放您的 VPFI；或您调用 tier 刷新。每次更新时，如果副本内容会变化，Base 会向其他链发送新副本。

每条链单独送达。无法送达的链不会拖住其他链，并且**送达无法发出时，
绝不会导致您自己的操作失败**：您在 Base 上的 tier 立即更新，其他每条
链在送达之前都处于"待送达"状态。

这些送达由协议付费，但有一个限制：

- **较低的 tier** 只要预算付得起，就会立即发送。送达之前，该链继续
  使用您之前较高的 tier。
- **较高的 tier** 或 tier 表的变更，每条链每天最多付费一次（governance
  设置，1 小时到 7 天之间）。在此之前，该链保留您之前的 tier。
- 因这段等待而被搁置的更新，或预算无法支付的更新，**等待结束后不会自动重发**。它会随着您在 Base 上等级记录的下一次更新发出，或在有人为您发起送达调用时发出。
- 任何人都可以发起该调用。等待结束且预算足以支付时，由协议支付；在此之前，调用者支付跨链费用以提前送达。合约提供这一调用；应用目前尚未提供。

在以下情况下，副本不再计入，该链也就不提供折扣：

- 副本早于该链的最长有效期（默认 60 天，不少于 30 天）；或
- 副本基于比该链现在所知更旧的 tier 表生成。

只有当副本中的内容会发生变化时，副本才会重新发送：您的 tier、其折扣、有效期限，或 tier 表的版本。因此在 tier 表变更后，即使您的 tier 不变（只要不为零），您在 Base 上的 tier 记录的下一次更新都会向每条链发送一份新副本。如果这些都没有变化，副本已过期的链在有变化之前不会给予折扣。

如果您的 tier 只是因为时间推移而上升（持有期已满或平均值已追上），Base 要到您的 tier 记录下一次更新时才会察觉。tier 刷新调用可以随时进行这次更新；应用只会在您关闭折扣时替您调用。

<a id="vpfi-discounts.operators"></a>

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

<a id="chapter.next-app"></a>

## 下一版应用

Vaipakam 应用的下一版正在与当前版本并行、一页一页地构建。尚未
构建的页面会如实说明，并链接到仍在提供该页面的当前应用。已构建
页面上的每个数字都从链上读取并注明来源；无法读取的数字显示为
未知，绝不显示为零。

<a id="advanced-mode"></a>

### Basic 与 Advanced

Basic 显示大多数人需要的功能。Advanced 增加退出与结算工具、
自动化、签名订单、keeper 状态和账务明细。模式是保存在浏览器中的
显示选择：它只改变显示多少，不改变协议允许你做什么，也绝不隐藏
同意、阻碍或补救办法。

<a id="wallet"></a>

### 你的 wallet 与数字的来源

你自己的状态（loan、报价、vault、claim）从链上读取：先经由
wallet 的提供方，再经由只读 RPC 代理，最后经由网络的公共端点。
同步行会注明作出响应的来源，以及页面上最早一次读取距今多久；
"刷新"会重新读取全部内容。索引只用于全局数字（市场和历史），
并显示其区块高度和时效。处于不支持网络上的 wallet 在切换之前
看不到任何属于自己的内容。

<a id="deployments"></a>

### 部署支持哪些功能

应用在每条链上绑定一个 Diamond，并在提供任何操作之前通过 loupe
读取其已路由的选择器。facet 刷新之后这个集合会改变；读取而不是
假定它，应用就能指出缺失的功能，而不是以 `FunctionDoesNotExist`
失败。在集合无法读取期间，不会提供任何签名步骤。

<a id="home-start"></a>

### Home：选择要做的事

Home 以要做的事开头，而不是协议术语：借入、出借、租用 NFT、出租
NFT，或管理你已有的内容。借入和出借先打开匹配的报价，没有时转向
发布你自己的报价。租赁涵盖 NFT 租赁的双方，NFT 始终存放在 vault
中。已连接的 wallet 还会看到三张可隐藏的入门卡片，隐藏选择保存在
浏览器中。

<a id="home-status"></a>

### Home：协议状态

Home 读取页面所描述链上的全局暂停、自动暂停窗口和 keeper 暂停，
并在任何情况下都说明结果。全局暂停会停止新仓位、claim、提取、
清算、违约和由 keeper 执行的结算；全额和部分还款以及追加抵押品
仍然可用，暂停时间会计入每笔未结 loan 的期限。自动暂停窗口会显示
结束时间；如有管理员暂停，它会持续得更久，新的自动窗口只能在冷却期
之后开启。keeper 暂停只会停止服务代你执行的步骤。无法读取的状态，
包括在先前答复之后失败的重新读取，都会在顶部显示为未知。单个资产
也可能被暂停；涉及它的流程会加以说明。

<a id="home-payouts"></a>

### Home：可领取

Home 逐页遍历出借方和借款方两侧的可领取视图，并按 loan 和角色
列出每笔款项。它不显示金额：一笔款项可能以多种资产、经多条路径
支付，每笔金额会在领取前由 Claims 说明。如果遍历在结尾之前停止，
Home 会说明实际可能比显示的更多。

<a id="home-loans"></a>

### Home：你的 loan

每笔处于 Active 或 FallbackPending 状态的 loan 都会连同角色、
条款、抵押品和阶段一起列出，并按紧急程度排序：宽限期已过、宽限期
内、fallback、期限无法读取、三天内到期、进行中。到期日和宽限期
结束时间来自协议的 loan 时钟，已包含暂停时间，非零时会显示出来。
health factor 是仪表盘视图中按 1e18 缩放的读数；读数为 0 表示没有
读数（资产没有价格，或读取失败），并照此显示。从同一报价、同一
角色、同一 ERC-20 开出的两笔或以上 loan 会合并：本金相加，利率按
本金加权并向下取整，显示有价格的 loan 中最低的 health factor，
没有价格的则计数。

定期付息的 loan 在到期日之前（含到期日当天）还有付息节点。付息节点的宽限期结束时仍未支付的利息，可以通过出售抵押品来支付，loan 仍保持未结；Home 会显示下一个付息节点，并把欠付的排在最前，即使它恰好落在到期日，因为它的宽限期可能早于 loan 的宽限期结束。协议可以关闭这项结算；此时 Home 会说明付息节点不会出售抵押品。

<a id="home-exposure"></a>

### Home：借出与借入

每笔 loan 的本金都按协议唯一的估值规则、以当前价格折算为计价
单位：债务向上取整，你出借的 loan 向下取整。无法估值的 loan
（NFT 或没有价格的资产）只计数，不作估算。只有在未估值的 loan
不可能改变结论时才指出哪一边更大；否则 Home 显示已估值的合计和
数量。

<a id="home-faucet"></a>

### Home：测试资产

在部署记录公布了测试资产的测试网上，Home 会列出它们：接入测试价格源和资金池的测试 ERC-20（流动），刻意两者都不接入的测试 ERC-20（非流动：以其计价的贷款没有价格，违约以实物结算），以及 ERC-4907 租赁 NFT。铸造调用的是模拟代币合约，从不调用 Diamond：代币为 1,000 个整数单位，NFT 则使用一个新的随机 token id 铸造一枚，并在打开钱包前确认该 id 尚未铸造。结果通过回读余额或 `ownerOf` 来测量，代币铸造成功后会提供 `wallet_watchAsset`。测试 NFT 只能由其所有者或获批准的操作者销毁。

<a id="home-fee-discount"></a>

### Home：手续费折扣

`setVPFIDiscountConsent` 会在本链的 Diamond 上为每个钱包设置一个标志。关闭时，持有等级折扣为 0。开启时，借款人的贷款发起费在接受时以出借资产减少（VPFI 定价路径从不进入借款人路径），出借人的收益手续费在每次结算时按当时生效的实际等级打折。交付方式取决于 `getVPFIDiscountConfig`：若 VPFI 汇率及其参考资产都已设置，打折后的手续费以 VPFI 从出借人的金库扣除，出借人保留全部利息；否则直接减少国库手续费本身，不移动 VPFI。若某次结算时无法执行该扣除（没有有效报价、金库中已记录的可用 VPFI 不足，或该 VPFI 作为抵押被锁定），该次结算的手续费不享受持有等级折扣。该调用为 `whenNotPaused`，因此全局暂停会在两个方向上都将其关闭。开启受服务条款约束，关闭则不受约束，且两者都不会向镜像链广播等级。借款人折扣仅在接受时出借资产具备流动性时适用（非流动贷款支付全额 LIF），且任何折扣都以手续费的 50% 为上限。

<a id="home-rewards"></a>

### Home: 奖励

标题数字是 `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`，它以 Vault 交付目标执行领取并始终 revert：`InteractionRewardsSimulation(paid, fromDay, toDay)` 携带确切数字，其他任何 revert 都是领取本身的拒绝 (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`)，按名称显示。只有在任何来源都无法运行预览时，Home 才读取下限 `previewInteractionRewards`，并暂不提供领取。确切数字为零时仍会提供领取：协议只在领取越过未支付任何金额的奖励日时才允许一次不支付任何金额的领取，Home 会说明这一点。Home 通过 `claimInteractionRewardsTo(2)` 领取，每次调用最多支付 `MAX_INTERACTION_CLAIM_DAYS`（30）天；在已完成领取的区块或之后读取的预览若仍给出金额，Home 就提供剩余部分。仅从奖励条目支付的领取不标明日期范围（0 到 0），Home 会说明这一点而不显示日期。Vault 交付目标会传给每个账户，包括合约钱包，因为 Default 目标会把合约调用者的款项付到其钱包：款项记入金库，记入无法完成时（尚无金库）退回钱包。结果从回执读取：`InteractionRewardsClaimed` 给出支付金额，同一交易中发往钱包和 `getUserVaultAddress(user)` 的 VPFI `Transfer` 日志给出款项到达何处；两者合计与支付金额不符时，目的地标为未知。累计领取额不显示：目前还没有对应的按用户索引路由。

<a id="home-rewards-expiry"></a>

### Home: 奖励移除日期

`ConfigFacet.getRewardClaimHorizonDays()` 为 0 表示期限未启用，不显示日期。否则 Home 会逐页读取 `getUserSoonestRewardExpiry(user, offset, 200, 50)`，所有页都在同一区块，最多十页；当 `nextOffset >= total` 时遍历完成，提前停止的遍历会标明不完整，绝不显示为没有到期。最终通知在最早估计日期前 90 天内显示。估计值是该区块上条目的 `expiresAt`：领取无法执行的时间会推后实际移除，治理对期限的修改可能使其提前。Home 不显示该条目将移除的金额。

<a id="home-rewards-held"></a>

### Home: 暂扣的奖励

`getSanctionsHeldReward(user)` 是暂扣余额，`getRewardSanctionsStatus(user)` 是其判定（Deliver、Hold 或 Confirmed）。有余额且判定为 Deliver 时，Home 提供 `claimHeldInteractionRewards(2)`，它只支付恰好的暂扣余额而不结算任何新欠款，并发出 `InteractionRewardsClaimed(user, 0, 0, paid)`；钱包被禁止期间它会以 `SanctionedAddress` revert。签名前的复核会重新读取二者，并以发送者身份模拟该调用。标记确认期间赚得的天数将被永久没收。

<a id="borrow-start"></a>

### Borrow: 如何运作

Borrow 通过 `acceptOffer(offerId, terms, signature)` 直接接受以 ERC-20 抵押借入 ERC-20 的出借人报价（`offerType` 0）。一笔交易内：借款人没有金库时为其开立金库，将抵押品转入其中，把扣除发起费后的本金交付到钱包，并发出 `LoanInitiated`。借款人也可以发布请求（`offerType` 1）；NFT 一侧、交易对同意和高级选项将在后续更新中提供。

<a id="borrow-pair"></a>

### Borrow: 选择代币

每种代币的类别实时读取：先读 `getAssetPriceStatus(asset)`（Divergent 视为不受信任并关闭新贷款），再读 `checkLiquidityOnActiveNetwork(asset)`（0 为有流动性，1 为无流动性）。以 `OraclePriceDivergence` 或 `OracleCrossCheckDivergence` 回滚视为不受信任；其他任何失败都显示为无法读取并附上原因。推荐列表为部署记录中的包装原生代币和测试代币；粘贴的地址只检查格式。

<a id="borrow-offers"></a>

### Borrow: 选择报价

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` 返回该交易对的公开报价 id 和总数。对每个 id，页面读取 `getOffer`、`getOfferState`，有钱包时还读取 `previewAccept(offerId, wallet)`，其中 `errorCode` 即协议的拒绝原因。贷款价值比为按今日价格计算的 `calculateLTV`；无流动性或无价格的一侧会说明为何没有。直接接受按出借人的 `amountMax` 和 `interestRateBps` 绑定。借款请求、带 NFT 一侧的报价和自己的报价只计数，不列出。

<a id="borrow-review"></a>

### Borrow: 审核与签名

审核读取报价、其状态、`previewAccept`、`getOfferLinkedLoanId`、`getCurrentRiskTermsHash`、两种类别、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、钱包的金库、余额和授权额度、`previewOfferAcceptBlock` 以及折扣同意，并在钱包打开前再读一次。钱包签署由已存储报价构建的 EIP-712 `AcceptTerms`（域 `Vaipakam AcceptOffer`，版本 1），附带新的 128 位 nonce 和 30 分钟期限；无流动性确认只指明审核中显示为无流动性的一侧。仅当授权额度不足时才批准与抵押品完全相同的额度，然后用签名模拟 `acceptOffer` 再发送。若在批准后中止，且额度未被其他操作改变，应用会把它恢复为原值。结果从该报价和钱包的 `LoanInitiated` 以及收据中的 `Transfer` 日志读取。授权额度会在第一次钱包请求之前重新读取，重置时恢复的就是这个值；已发送但回滚（revert）的接受交易，或被钱包取消或替换的接受交易，也会由交易跟踪器做同样的重置。审核页列出 `allowsPartialRepay`、`allowsPrepayListing`、带 `parallelSaleOrderHash` 的 `allowsParallelSale`、`refinanceTargetLoanId` 以及关联贷款，并将应还金额标注为无暂停情形，因为暂停期间利息照常累计，只是到期日后移。 每个授权步骤都以在其回执所在区块读回的授权额度来判断，从不依据回执状态。对于拒绝把一个非零授权额度改为另一个非零值的代币（通过 `approve` 的试运行判断），会先加一步归零，审核界面将其计为一次额外提示。条款接受情况会在钱包打开前再次读取。 两种出售途径都以 NFT 形式挂出抵押品，因此在代币抵押品上，已授予的挂单或出售许可会被说明为该贷款无法使用。

<a id="borrow-fee"></a>

### Borrow: 发起费

费用为 `previewAccept` 的 `lifEstimate`：本金乘以 `getLoanInitiationFeeBps`，以所借代币收取，从交付金额中扣除；同意开启且所借代币有流动性时按持有等级折扣降低，等级在接受时确定。本页从不选择 Full 费率。该费用不收取 VPFI，也不返还。 提交者份额（费用的 `getLifMatcherFeeBps`）支付给发送交易的一方，在直接接受中即借款人，因此钱包收到扣除费用后的本金再加上这部分份额。

<a id="borrow-risks"></a>

### Borrow: 风险

超过宽限期的贷款（到期后 `getEffectiveGraceSeconds`，暂停时间会使其顺延）任何人都可以触发违约：有流动性的抵押品为出借人出售，无流动性的抵押品原样转移。健康因子低于 1 时，有流动性的抵押品也可能被清算。`useFullTermInterest` 在提前还款时收取全期利息；付息计划通过强制出售抵押品来结清未付期次。

<a id="borrow-request"></a>

### Borrow：发布你自己的请求

请求是从借款人钱包发送的 `createOffer`，`offerType` 为 1，两侧均为 ERC-20。它把 `collateralAmount` 转入借款人的金库（若没有金库则先创建），并发出 `OfferCreated(offerId, creator, 1)`。出借人用 `acceptOffer` 接受：扣除费用后的本金进入借款人钱包，费用中归发送者的份额归发送交易的出借人。`cancelOffer` 在创建后 `MIN_OFFER_CANCEL_DELAY`（5 分钟）起对创建者开放，请求过期后对任何人开放；抵押品始终退回创建者。

<a id="borrow-request-terms"></a>

### Borrow：请求的条款

Basic 发布单一数值的请求：`amount` = `amountMax`，`interestRateBps` = `interestRateBpsMax`，`collateralAmount` = `collateralAmountMax`，`fillMode` 0，`periodicInterestCadence` 0，`allowsPrepayListing` 和 `allowsParallelSale` 为 false，`refinanceTargetLoanId` 0，`creatorRiskAndTermsConsent` 为 true。金额精确换算为基本单位，利率最多 10,000 bps。`durationDays` 以 `getProtocolConfigBundle` 中读取的配置上限为界。`expiresAt` 为 0（取消前一直有效），或在打开审核时依最新区块确定的时间，最多为 `MAX_OFFER_EXPIRY_HORIZON`（365 天）之后。`useFullTermInterest` 默认为 true，`allowsPartialRepay` 默认为 false。

<a id="borrow-request-review"></a>

### Borrow：审核并发布请求

审核从钱包模拟 `createOffer`，并读取两侧的类别、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、最长期限、钱包的金库、余额和授权额度，两侧均为流动资产时还读取 `calculateLTV`；每个区块以及钱包打开前都会重新读取。授权额度不足时，模拟只能走到划转抵押品这一步，因此代币的划转错误或没有协议错误名的回滚会显示为待完成的批准，而有名称的协议错误则视为拒绝。完成精确批准后，再次模拟 `createOffer` 并发送；批准后若中止，且没有其他改动，授权额度会恢复为原值。结果读取此钱包的 `OfferCreated` 以及抵押品转入金库的 `Transfer`。

<a id="borrow-nft-collateral"></a>

### Borrow：以 NFT 作为抵押品

抵押品的标准通过 `supportsInterface` 读取（ERC-721 `0x80ac58cd`，ERC-1155 `0xd9b67a26`）；回滚视为两者都不是，读取失败则不提供请求。ERC-721 请求发送 `collateralAssetType` 1、`collateralTokenId` 为输入的 ID、`collateralQuantity` 1，以及 `collateralAmount` = `collateralAmountMax` = 0；风险交易对以该代币 ID 为键。审核在同一区块读取 `ownerOf`、`getApproved` 和 `isApprovedForAll(wallet, Diamond)`；由其他钱包持有的代币或回滚的 `ownerOf` 会阻止请求。在没有任何授权时，试运行会停在代币的 `ERC721InsufficientApproval`，显示为待完成的授权。授权为 `approve(Diamond, id)`，只有当回执所在区块的 `getApproved` 读到 Diamond 时才算完成；之后若停止，只有在授权仍指向 Diamond 且钱包仍持有该代币时，才会恢复为之前的地址。对于 ERC-721，从不请求 `setApprovalForAll`。结果读取 `OfferCreated` 以及该代币自身从钱包到金库的 `Transfer`（四个 topic）。ERC-1155 请求发送 `collateralAssetType` 2、代币 ID、等于所输入数量的 `collateralQuantity`（1 到 2^128−1），两个金额均为 0。审核在同一区块读取 `balanceOf(wallet, id)` 和 `isApprovedForAll(wallet, Diamond)`；余额低于数量会阻止请求，没有授权时试运行会停在 `ERC1155MissingApprovalForAll`。唯一的授权是 `setApprovalForAll(Diamond, true)`，在其回执所在区块读回时才算完成，并在请求上链或停止后以 `setApprovalForAll(Diamond, false)` 收回（从不早于授予所在区块读取），除非钱包此前已授予。结果汇总该代币从钱包到金库的 `TransferSingle`/`TransferBatch`。要求 NFT 的出借人报价仍转至当前应用。

<a id="borrow-request-range"></a>

### Borrow: 带范围的请求

范围发送的 `amount`（最小）低于 `amountMax`（最大），`interestRateBps` = `interestRateBpsMax`（同一利率），`collateralAmount`（最小贷款的下限）不高于 `collateralAmountMax`（发布时转入金库）；下限留空则两者相同。范围仅对 ERC-20 抵押品提供。直接 `acceptOffer` 以 `collateralAmount` 为抵押、按 `interestRateBpsMax` 出借 `amount`，并把 `collateralAmountMax − collateralAmount` 退回钱包；`getPartialFillEnabled` 为 true 期间，`matchOffers` 在两端之间成交。`createOffer` 的模拟在最大端应用报价上限，并以 `MaxLendingAboveCeiling(provided, ceiling)` 拒绝，审核会显示其上限。直接端通过在 (`amount`, `collateralAmount`) 处对单值请求的第二次模拟来检查；在上限之前停止的回答标为未知。每一端的贷款价值比为 `calculateLTV(lending, amount, collateral, collateralAmount)`，`ZeroCollateral` 视为毫无价值的抵押品。显示的贷款起始健康因子在 `getDepthTieredLtvEnabled` 为 false 时为 `getMinHealthFactor`，为 true 时为 1.0。撮合锁定出借人按比例计算的要求额：抵押品为区间时提高到 `collateralAmount`，否则保持要求额；因此最大撮合会同时按 `collateralAmountMax` 和 `collateralAmount` 显示（若无抵押品区间，则显示为可能锁定更少）。只有贷款开始时的检查约束它；读取该检查失败时会明确说明，绝不省略。在分层体制下，该检查还会应用该层级的贷款价值比上限。`getPartialFillEnabled` 为 true 期间，撮合未锁定的抵押品会留在金库中供后续撮合使用，只有在请求关闭（剩余容量低于 `amount`）或执行 `cancelOffer` 时才会退还。

<a id="borrow-request-fill"></a>

### Borrow: 请求的成交方式

`fillMode` 为 0（Partial）、1（AON）或 2（IOC），发布后不可更改。AON 要求 `amount` = `amountMax`（`AonRequiresSingleValueAmount`），IOC 要求 `expiresAt` ≠ 0（`IocRequiresExpiry`）；表单不会提供被拒绝的组合。金额、利率和抵押品可在请求开放期间通过 `setOfferAmount`、`setOfferRate`、`setOfferCollateral` 和 `modifyOffer` 更改，但不能低于 `amountFilled` 或 `collateralAmountFilled`；本应用尚未调用它们。

<a id="borrow-request-cadence"></a>

### Borrow: 请求的利息计划

`periodicInterestCadence` 取值 0（None）到 4（Annual），周期分别为 30、90、180 和 365 天。表单提供 `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` 允许的计划；它执行 `createOffer` 强制的规则，并按 `amount`（区间的最小端）估值。每个拒绝都根据其回滚数据说明：`PeriodicInterestDisabled`、`CadenceNotAllowedForIlliquid` 或 `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`。一个周期的利息为 `principal × rate × intervalDays / (10000 × 365)`。宽限期 `getEffectiveGraceSeconds(intervalDays − 1)` 过后，任何人都可以通过 `settlePeriodicInterest` 结算逾期周期；它会出售抵押品，贷款继续有效。keeper 流程 `periodicSettle` 的启用状态按能力服务的报告显示，默认为未知。计划在发布后不能更改。

<a id="borrow-request-tariff"></a>

### Borrow: 请求的全额费用档

选择加入使用 `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`，由创建者在 `createOffer` 之后发送；一旦有出借人接受请求，就会以 `OfferAlreadyAccepted` 拒绝；`maxCStar` 必须大于零（`FullTariffMaxCStarRequired`）。表单从 `getFeeEntitlementConfig()` 显示开关，从 `quoteCStar(lendingAsset, principal, durationDays)` 显示费用档，范围请求则在 `amount` 和 `amountMax` 处读取；上限默认取 `amountMax` 处的报价。每次接受时，收费按该笔贷款本金计算 `C*`，仅当开关开启、本金有价格且具流动性、`C* ≤ maxCStar`，并且金库的可用 VPFI 足以支付（金库余额以 `getTrackedVPFIBalance` 为上限，减去有效留置，经由 `getFreeBalance`）时才收取；否则以 `FeeEntitlementDisabled`、`FeeEntitlementFullOptInFailed` 或 `FeeEntitlementTariffAboveAuth` 回滚，除非 `allowDowngrade` 允许贷款不带费用档开立。借款人的贷款费用折扣提高 `FULL_MODE_FEE_DISCOUNT_BONUS_BPS`（1000），上限为 `MAX_FEE_DISCOUNT_BPS`（5000）。审阅会阻止导致每笔贷款都被拒绝的选择，选择加入通过重新读取 `getOffer` 来测量（`creatorFull`、`creatorMaxCStar`、`creatorAllowFullDowngrade`）。对于未成交的请求，本应用尚未提供兜底出借。

<a id="lend-start"></a>

### Lend: 如何运作

Lend 通过出借人发送的 `acceptOffer(offerId, terms, signature)`，直接接受以 ERC-20 抵押的 ERC-20 借款请求（`offerType` 1）。在一笔交易中，本金在对 Diamond 的授权下从出借人的钱包转入出借人的金库；借款人收到扣除发起费后的金额；已在借款人金库中的抵押品成为贷款的抵押品；并发出 `LoanInitiated`，出借人和借款人各得一枚仓位 NFT。出借报价（`offerType` 0）在同一页面发布；NFT 一方将在后续更新中推出。

<a id="lend-offers"></a>

### Lend: 选择请求

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` 给出该交易对公开报价的 id。对每一个，页面读取 `getOffer`、`getOfferState`、`getOfferLinkedLoanId`，以及在连接钱包时读取 `previewAccept(offerId, wallet)`，其 `errorCode` 即协议的拒绝原因。直接接受按 `interestRateBpsMax` 锁定请求的 `amount`（其最小值），贷款价值比为该金额按今日价格计算的 `calculateLTV`。出借人报价、NFT 一方、读者自己的请求以及出借人仓位出售载体（`getOfferLinkedLoanId` 非零的借款方报价）只计数，不列出。排序：可出资的在前，然后按利率降序，再按金额降序。

<a id="lend-review"></a>

### Lend: 审核与签名

审核读取与 Borrow 相同的内容（报价、其状态、`previewAccept`、`getOfferLinkedLoanId`、`getCurrentRiskTermsHash`、两种类别、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、`getLifMatcherFeeBps`、钱包的金库、`previewOfferAcceptBlock` 和费用折扣同意），外加 `getTreasuryFeeBps`，并在出借资产（出借人支付的一方）上测量余额和授权额度。该资产不足会阻止签名，出借人仓位出售载体同样如此。钱包签署 EIP-712 `AcceptTerms`（域 `Vaipakam AcceptOffer`，版本 1），仅在授权额度不足时精确批准本金（对拒绝在非零值之间变更的代币，先加一步归零），然后模拟并发送 `acceptOffer`；中止的流程留下的授权会像 Borrow 那样被重置。结果读取此报价的 `LoanInitiated`、本金从钱包转出的 `Transfer`，以及撮合份额返还的 `Transfer`。

<a id="lend-fee"></a>

### Lend: 费用与协议份额

费用即 `previewAccept` 的 `lifEstimate`，由借款人承担：以出借资产计的本金的 `getLoanInitiationFeeBps`，从交付给借款人的金额中扣除，在接受时因借款人的持有等级折扣而降低，并在设置了 `creatorFull` 且收费成功时因全额费用档奖励而降低。提交者份额，即费用的 `getLifMatcherFeeBps`，支付给发送者，此处为出借人。协议在利息中的份额为 `getTreasuryFeeBps`，在每笔贷款开立时固定（`treasuryFeeBpsAtInit`）；同意开启时，出借人的持有等级折扣会在利息结算时降低它。审核显示今日费率，并以该费率下的份额作为上限。

<a id="lend-risks"></a>

### Lend: 风险

超过宽限期结束（到期日后 `getEffectiveGraceSeconds`，暂停时间会使其推后）的贷款，任何人都可以将其违约：具流动性的抵押品为出借人出售，缺乏流动性的抵押品按原样转移。两方都具流动性时，健康因子低于 1 即可清算贷款，出售所得先支付出借人。任何一方缺乏流动性都会排除基于价格的清算，违约时出借人获得全部抵押品。`useFullTermInterest` 为提前还款设定利息下限；没有它则按比例计息。定期计息计划会通过强制出售抵押品向出借人结清错过的期次。出借人的仓位 NFT 承载债权：转让它就转让了贷款。

<a id="lend-offer"></a>

### Lend：发布您自己的报价

出借报价是出借人钱包发送的 `createOffer`，`offerType` 为 0，两侧均为 ERC-20。它把出借资产的 `amountMax` 转入出借人的金库（若无金库则先创建），并发出 `OfferCreated(offerId, creator, 0)`。借款人以 `acceptOffer` 接受：其抵押品转入其金库，扣除费用后的本金进入其钱包，费用中发送者的份额作为发送者支付给借款人。当 `getPartialFillEnabled` 为 true 时，`matchOffers` 也可以把它与借款人的请求配对；此时单一数值的出借报价按其利率出借全部金额，抵押品至少为其 `collateralAmount`。创建后 `MIN_OFFER_CANCEL_DELAY`（5 分钟）起创建者可调用 `cancelOffer`，报价过期后任何人都可调用；金额始终退回创建者。

<a id="lend-offer-terms"></a>

### Lend：报价的条款

未设部分时，出借报价为单一数值：`amount` = `amountMax`，`interestRateBps` = `interestRateBpsMax`，`collateralAmount` = `collateralAmountMax`（借款人必须锁定的唯一抵押品数量），`fillMode` 0（除非 Advanced 设置了其他方式，见下一节），`periodicInterestCadence` 0（除非 Advanced 设置了付息计划），`allowsPrepayListing` 和 `allowsParallelSale` 为 false，`refinanceTargetLoanId` 0，`creatorRiskAndTermsConsent` 为 true，且不设 Full 方案（除非 Advanced 选择了它）。金额被精确解析为基础单位，利率最多 10,000 bps。`durationDays` 受从 `getProtocolConfigBundle` 读取的配置最大值限制。`expiresAt` 为 0（取消前一直开放），或在审核打开时从最新区块确定的时间，最多提前 `MAX_OFFER_EXPIRY_HORIZON`（365 天）。`useFullTermInterest` 默认为 true，`allowsPartialRepay` 默认为 false。

<a id="lend-offer-parts"></a>

### Lend：分部分出借的报价

分部分时发送的 `amount`（一次撮合可出借的最小部分）小于 `amountMax`（全部金额，由 `createOffer` 拉入金库）；`collateralAmount` = `collateralAmountMax` 仍是唯一要求，按 `amountMax` 计（否则为 `LenderCollateralRangeNotAllowed`），且 `interestRateBps` = `interestRateBpsMax`。直接对出借报价调用 `acceptOffer` 时，以 `collateralAmount` 出借 `amountMax`，且仅在 `amountFilled` 为 0 时可行（撮合后为 `OfferPartiallyFilled`）。当 `getPartialFillEnabled` 为 true 时，`matchOffers` 出借金额重叠区间的中点（至少为 `amount`），利率取利率重叠区间的中点，抵押品至少为 `collateralAmount × matchAmount ÷ amountMax`（向下取整；借款人的抵押品区间可能提高它）。当 `amountMax − amountFilled` 低于 `amount` 时，剩余部分被提取到出借人的钱包，报价关闭（`OfferClosed`，原因为 `Dust` 或 `FullyFilled`）。对部分成交的报价调用 `cancelOffer` 不受冷却期限制，并退回 `amountMax − amountFilled`。`fillMode` 与请求相同，为 0、1 或 2：AON 要求 `amount` = `amountMax`，IOC 要求设置到期时间，发布后不可更改。两边都为流动资产时，若 `collateralAmount` 低于 `amountMax` 对应的下限，`createOffer` 以 `MinCollateralBelowFloor(provided, floor)` 拒绝，审核会显示该下限。审核只显示一个贷款价值比，即 (`amountMax`, `collateralAmount`) 处的 `calculateLTV`：任一部分的比率相同，仅有取整差异。

<a id="lend-offer-schedule"></a>

### Lend：报价的利息支付计划

出借报价的 `periodicInterestCadence` 遵循请求的规则（见上文），`previewCadenceAdmission` 按报价的 `amount` 估值：即最小部分，未设部分时为全部金额。`createOffer` 在此通过 `requireCadenceAdmitted` 准入，每笔贷款开立时还会再次检查其自身本金（`requireOriginationCadenceAdmitted`）。审核按 `amountMax`（直接承接）列出一期利息，分部分时还按 `amount` 列出。错过的一期在宽限期后可由任何人通过 `settlePeriodicInterest` 结算：出售抵押品向出借人支付该期利息，贷款保持开放。

<a id="lend-offer-tariff"></a>

### Lend：报价的全额费用档

出借人的选择同样是 `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`，在 `createOffer` 之后发送。一旦报价被全部承接或关闭，它会以 `OfferAlreadyAccepted` 被拒绝；部分撮合的报价仍可设置，适用于其之后的贷款。报价按 `quoteCStar` 在 `amount` 和 `amountMax` 计价，上限默认取 `amountMax` 处的报价。每笔贷款单独按其本金计价并对照 `maxCStar` 检查，条件与请求相同（`FeeEntitlementDisabled`、`FeeEntitlementFullOptInFailed`、`FeeEntitlementTariffAboveAuth`，或在允许时降级）；出借人的检查使用金库当前的可用 VPFI。收取费用档后，贷款的 `lenderMode` 被标记为 Full，此后每次出借人收益费结算都会把 `FULL_MODE_FEE_DISCOUNT_BONUS_BPS`（1000）加到仓位持有人对协议份额的折扣上，上限为 `MAX_FEE_DISCOUNT_BPS`（5000），无论是否开启持有折扣同意。原地延期（`repriceFeeEntitlementOnExtension`）会在新期限内把标记设为 None。

<a id="lend-offer-review"></a>

### Lend：审核并发布报价

审核从钱包模拟 `createOffer`，并读取两种资产的类别、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、`getTreasuryFeeBps`、最长期限、钱包的金库、钱包在出借资产（出借人锁定的一侧）上的余额和授权，以及两侧均为流动资产时的 `calculateLTV`；每个区块以及钱包打开前都会重新读取。授权不足时，模拟只能到达金额的转入，因此代币的转入错误、`VaultDepositFailed`（协议对无数据回退的转入的包装，WETH 在授权不足时就是这样）或没有协议错误名的回退，都显示为需要清除的批准，与请求的审核规则相同；其他任何具名协议错误都是拒绝。精确批准后再次模拟 `createOffer` 并发送；批准后中止时，若授权未被其他操作改变，则把授权恢复为之前的值。结果读取该钱包 `offerType` 为 0 的 `OfferCreated`，以及金额转入金库的 `Transfer`。

<a id="lend-offer-fee"></a>

### Lend：您报价的费用

`createOffer` 不向出借人收取任何费用。显示的费用由借款人承担：出借资产金额的 `getLoanInitiationFeeBps`，按 `acceptOffer` 执行时生效的费率计算，届时由借款人的持有等级折扣降低，并从其到账金额中扣除；显示的数字按今天的费率计算。协议在利息中的份额为 `getTreasuryFeeBps`，在每笔贷款开立时固定（`treasuryFeeBpsAtInit`）；在同意开启时，出借人的持有等级折扣会在结算利息时降低该份额。审核显示今天的费率，以及按该费率计算的份额作为上限；`getTreasuryFeeBps` 读取失败时会说明，且不显示份额或返还金额。

<a id="positions"></a>

### Positions：列表如何读取

Positions 通过一个共享读取器读取与 Home 相同的持仓清单：`getUserPositionLoansPaginated` 遍历钱包持有的仓位 NFT，`getLoansBatch` 批量加载，每一方由所持代币（`lenderTokenId` 或 `borrowerTokenId`）决定，绝不依据发起时记录的当事人。状态为 Active 或 FallbackPending 的贷款为进行中，其期限、健康因子与分组如 Home 中所述。其他所有状态均为已结束，按贷款 id 从新到旧排列，以 `LoanStatus` 命名：Repaid、Defaulted、Settled 或 InternalMatched（因撮合而关闭）；应用不认识的状态编号按编号显示。待领款项遵循 Home 中所述的 claimables 规则：钱包从他人处收到的已结束贷款仓位只计数，不做猜测。

方向选择按所持一方筛选待领款项、进行中和已结束的行。只有当仓位遍历和待领款项遍历都已完成且最新读取成功时，才会显示“没有”；在上限处停止的遍历会标明不完整。每一行打开 `/positions/<id>`，由资格判定决定每项操作；列表不发送任何交易。

<a id="position"></a>

### Position：贷款如何读取

页面读取 `getLoanDetails(loanId)`，并对出借人和借款人的仓位 NFT 调用 `ownerOf`；角色即钱包现在持有的代币。对进行中的贷款（Active 或 FallbackPending），读取 `getLoanDeadlines`（暂停补偿前当前期限的到期，展期或借款人转接会改写它、暂停补偿、到期、宽限结束），有付息周期时读取 `previewPeriodicSettle` 和 `getPeriodicInterestEnabled`，以及 `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`)、`calculateHealthFactor` 和 `calculateLTV`；对每笔贷款读取 `getLoanCollateralLien` 和 `isSaleVehicleLoan`。每次读取相互独立：失败的读取显示为未知，绝不显示为零，也不会用 `startTime` 和 `durationDays` 推算日期。

对有价格的贷款，它还读取 `getInternalMatchConfigBundle`。内部撮合开启时，贷款价值比处于其阈值到阈值加 `externalLiquidationPriorityWindowBps` 之间的贷款会保留给内部撮合，所有外部清算途径都会拒绝（`InternalMatchOnlyBand`），页面会说明这个区间。`loanInitiationFeeBpsAtInit` 为 0（费率被记录之前开立的贷款）显示为未记录，`treasuryFeeBpsAtInit` 为 0 显示为结算采用的 1% 旧费率。实物交付警告仅适用于 ERC-20 贷款：NFT 租赁没有抵押品，违约时租用方的使用权终止，预付租金扣除金库份额后付给出借人，缓冲金转入金库，页面会改为说明这一点。

费率均为贷款快照：`treasuryFeeBpsAtInit`、`loanInitiationFeeBpsAtInit`（出售载体贷款为无）和 `liquidationLtvBpsAtInit`。任一方为 Illiquid（`principalLiquidity` 或 `collateralLiquidity`）的贷款没有基于价格的读数：协议会拒绝该贷款的 `calculateHealthFactor` 和 `calculateLTV`，页面会说明这一点而不是显示未知。`principal` 是尚欠的本金（部分还款会减少它），`interestRateBps` 和 `collateralAmount` 也可能变化，因此条款按当前状态显示；记录中没有本金的已结束贷款会说明是否由内部撮合覆盖，否则只说明没有记录；NFT 租赁会显示每日租金（`principal`，以 `prepayAsset` 计）以及提前归还是否仍按每个剩余天数收费（`useFullTermInterest`）。`getPeriodicInterestEnabled` 为 false 时，页面会说明在检查点不会出售抵押品。进行中贷款的 `collateralLiquidity` 为 Illiquid 时，会加上实物交割警告：违约时抵押品不经出售直接转给出借人。它的第一笔交易是全额还款，见下文。

<a id="repay"></a>

### 全额还款：金额如何确定

该操作遵循一条规则：对 Active 或 FallbackPending 的 ERC-20 贷款，`repayLoan` 提供给既不是 `loan.lender` 也不是 `ownerOf(lenderTokenId)` 的任何钱包（`LenderCannotRepayOwnLoan`）；Active 贷款过了实际宽限期结束时间后暂停（`RepaymentPastGracePeriod`），`positionLock(borrowerTokenId)` 为 `SwapToRepayIntent` 期间也暂停。出借人的出售挂单、再融资请求和全局暂停都不会暂停它。租赁暂不在此提供。

确认页在最新区块读取 `calculateRepaymentAmount(loanId)`，再把区块时间覆盖为 `min(now + 30 分钟, 宽限期结束)` 读取一次；同一请求还会读取其实际运行的区块时间，忽略覆盖的连接会被跳过。批准额恰好是第二个数字，打开钱包前会模拟调用；收据之后，从其 `LoanRepaid` 日志读取还款使贷款所处的状态（而非该区块的状态，同一区块中随后的领取可能已将其结清），根据 `Transfer` 日志计量付款，当 allowance 显示为批准额减去付款时，将其恢复为之前的值。高于该数字的 allowance（包括无限额度）同样会降到这个数字，因为 `repayLoan(loanId)` 不设上限也不设期限；之后的恢复会还原原来的较大值。

<a id="interest-schedule"></a>

### 利息计划：如何读取

对于有付息周期的 Active ERC-20 贷款，卡片读取 `previewPeriodicSettle(loanId)`（周期、`periodEndAt`、`graceEndsAt`、`expected`、`paidByBorrower`、`shortfall`、`canSettleNow`）、`getPeriodicInterestEnabled()` 和 `paused()`，并显示读取时的区块时间。`expected` 是按当前 `principal` 和 `interestRateBps` 计算的一个完整周期；`periodEndAt` 包含贷款的暂停补偿。

预览的 `canSettleNow` 不考虑开关和暂停，因此卡片按 `settlePeriodicInterest` 自身的顺序把它们组合起来：关闭（`PeriodicInterestDisabled`）、暂停（`whenNotPaused`），然后是周期时间（`graceEndsAt` 之前为 `PeriodicSettleNotDue`）。只有在开关打开且协议未暂停时才会提示出售；无法读取的开关或暂停状态显示为未知。不足额为零时，结算只推进检查点。守护程序的 `PERIODIC_SETTLE` 是否启用不会报告给应用，因此卡片说明结算对任何人开放，而守护程序的状态未知。

<a id="risk-access"></a>

### Risk Access：你的风险等级

开关是 `getRiskAccessGateEnabled`。一个流程需要哪一步，由协议自身的回答决定：接受报价时，在 `previewCreatorBlock` 显示贷方未被阻挡之后，看 `previewOfferAcceptBlock`（1 = 等级过低，2 = 交易对同意，3 = 严格模式确认，4 = 过去由接受时的确认覆盖的非流动交易对；它与 2 一样构成阻止，交易对同意可解除）；发布请求时，看 `createOffer` 模拟执行返回的 `RiskTierTooLow`、`IlliquidPairNotConsented` 或 `MidTierPairNotAcknowledged`。该步骤在同一区块内读取交易对的 `pairRequiredRiskLevel`（报价则用 `acceptMidTierAckPair`）、`getVaultRiskTier`、`getEffectiveRiskTier`、对照 `getCurrentRiskTermsVersion` 的 `getVaultRiskTierVersion`、`getRiskTierUnlockAt`、`getRiskAccessUnlockCooldown` 和 `getRiskTierMutationNonce`，对交易对则读取 `isPairConsentPending` 与 `hasIlliquidPairConsent`，或 `isMidTierAckPending` 与 `midTierStrictBlocked`。提高等级使用 `setVaultRiskTierChecked(level, nonce, termsVersion)`，提高到该交易对所需的最低等级；若审核之后有其他等级写入或条款变更，交易会被拒绝且不改变任何内容。交易对步骤是 `setIlliquidPairConsent(pair, true)` 或 `setMidTierPairAck(pair)`。仍在等待中的等级提高或仍待生效的交易对步骤不会再次提供。没有任何读取接口返回待生效交易对步骤的生效时间，因此审核界面会说明无法读取该时间；只有该步骤本身的完成卡片会给出它，即收据所在区块时间加等待期。结果在收据所在区块读回。

<a id="terms-gate"></a>

### 服务条款确认

`getCurrentTos` 返回操作所在链上生效的版本和内容哈希；版本 0 表示没有条款，任何操作都不受限制。`hasAcceptedCurrentTerms` 为 false 的钱包会在新增敞口前被询问，提示中链接到 `/terms/v<N>`，这是按版本固定、文本永不改变的页面。接受会调用一次 `acceptTerms(version, hash)`。打开钱包前会重新读取这对数值，因此更新的版本会替换当前显示的版本，而在其他标签页中完成的接受会让操作继续。读取失败表示“无法确认”，可以重试，绝不等同于“未接受”。退出类操作从不受限。
