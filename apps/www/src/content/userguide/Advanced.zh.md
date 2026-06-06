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

这是 wallet-level opt-in flag。它允许 protocol 在 terminal events
时，用从您 vault debit 的 VPFI 来 settle fee 的 discounted 部分。
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
vault balance 计算；随后在每笔 loan 的生命周期内按 time-weighted
方式生效。unstake 会立即对您参与的每笔 open loan，用新的较低
balance re-stamp rate — 没有让旧的 (更高) tier 继续适用的 grace
window。这会关闭一种 exploit pattern：在 loan 即将结束时临时 top up
VPFI 以拿到 full-tier discount，然后几秒钟后 withdraw。

discount 在 settlement 时适用于 lender yield fee，也适用于 borrower
Loan Initiation Fee (borrower claim 时以 VPFI rebate 形式支付)。

> **Network gas 与协议费用是分开的。** 上面的 discount 适用于 Vaipakam 的 **protocol fees**（yield fee `{liveValue:treasuryFeeBps}`%、Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%）。每次 on-chain action 都需要的 **blockchain 网络 gas 费**（在 Base / Sepolia / Arbitrum 等链上 create offer / accept / repay / claim / withdraw 等操作时支付给 validators）不是协议费用。Vaipakam 从不收取，由网络收取。它无法按 tier 处理或 rebate，并且取决于 submission 时该链的拥堵情况，与 loan 大小或您的 VPFI tier 无关。

<a id="dashboard.rewards-summary"></a>

### 您的 VPFI rewards

这张 summary card 会在一个视图里汇总 connected wallet 在两个 reward
streams 中的 VPFI rewards。headline number 是 pending staking
rewards、lifetime-claimed staking rewards、pending interaction rewards
和 lifetime-claimed interaction rewards 的总和。

每个 stream 的 breakdown row 会显示 pending + claimed，并提供一个
chevron deep-link，跳转到对应 native page 上的 full claim card：

- **Staking yield** — 基于您的 vault balance、按 protocol APR accrue
  的 pending VPFI，加上此 wallet 先前 claim 过的所有 staking rewards。
  deep-link 到 Buy VPFI page 上的 staking claim card。
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
进入 Buy VPFI 或 Claim Center 之前很难发现 rewards programs。

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
HF 计算由 protocol 自己执行 — gate 无法被绕过。interest 上的 1%
treasury cut 会在 terminal settlement 时 debit，而不是预先收取。

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
  interest 上 1% treasury cut 后的净额。
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
  转给 lender。没有 leftover claim；只有未使用的 VPFI Loan Initiation
  Fee rebate 可以在 claim time 由 borrower 收取。

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
   `apps/defi/src/lib/openseaFeeSchedule.ts` 是参考）并在调用前传递
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
   部分；in-repo 发布器（`apps/defi/src/lib/openseaPublish.ts`
   + `apps/indexer/src/openseaPublish.ts`）在调用 endpoint 之
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
  给 diamond 的瀑布。然后瀑布路由该净额：出借人收到其结算
  entitlement（`LibEntitlement.settlementInterest` 在贷款以
  `useFullTermInterest = true` 创建时计算为完整票面，否则
  计算为在结算时间戳累积的 pro-rata 利息 — 门控是贷款政策，
  而不是销售是否发生在预定到期之前或之后），国库削减进入
  国库，剩余部分直接存入当前借款人仓位 NFT 持有者的 vault
  （通过 `LibUserVault.getOrCreate` + vault 存款）。不创建
  Claim Center 索赔 — 销售登陆后请检查您的 vault 余额。

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
- Accrued interest 减去 1% treasury cut。当 consent 打开时，cut
  本身又被您的 time-weighted VPFI fee-discount accumulator 减
  少。

loan 一进入 terminal state (Settled、Defaulted 或 Liquidated) 即可
claim。lender position NFT 会在同一 transaction 中 burn。

<a id="claim-center.claims:borrower"></a>

#### 如果您是 borrower

borrower claim 根据 loan 如何 settle 来返回：

- **Full repayment / preclose / refinance** — 您的 collateral
  basket 回来，加上 Loan Initiation Fee 的 time-weighted VPFI
  rebate。
- **HF-liquidation 或 default** — 仅 unused VPFI Loan Initiation
  Fee rebate；在这些 terminal paths 上，除非明确保留，否则为零。
  Collateral 已经移动给 lender。

borrower position NFT 会在同一 transaction 中 burn。

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain 上与您 wallet 相关的 on-chain events，会从 protocol
logs 的 sliding block window 中实时获取。没有 backend cache — 每次
page load 都会重新 fetch。Events 会按 transaction hash 分组，因此
multi-event transactions (例如同一 block 中确认的 accept + initiate)
会保持在一起。最新在前。展示 offers、loans、repayments、claims、
liquidations、NFT mints 和 burns，以及 VPFI buys / stakes / unstakes。

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### 购买 VPFI

两条 paths：

- **Canonical (Base)** — 直接调用 protocol 上的 canonical buy
  flow。在 Base 上直接 mint VPFI 到您的 wallet。
- **Off-canonical** — local-chain buy adapter 向 Base 上的
  canonical receiver 发送 Chainlink CCIP packet，它在 Base 上执行
  buy 并通过 cross-chain token standard 把结果 bridge 回来。在
  L2-to-L2 pairs 上端到端 latency ≈ 1 分钟。VPFI 会落到 **origin**
  chain 上您的 wallet。

Adapter rate limits (post-hardening)：每个 request 50,000 VPFI，
rolling 24 小时内 500,000 VPFI。可由 governance 通过 timelock
调整。

<a id="buy-vpfi.discount-status"></a>

### 您的 VPFI Discount Status

实时状态：

- 当前 tier (0 至 4)。
- Vault VPFI balance，以及到下一 tier 的 gap。
- 当前 tier 的 Discount percentage。
- Wallet 级 consent flag。

请注意 vault VPFI 还通过 staking pool 累积 5% APR — 没有单独的
"stake" 操作。把 VPFI deposit 到您的 vault **就是** staking。

<a id="buy-vpfi.buy"></a>

### Step 1 — 用 ETH 购买 VPFI

提交 buy。在 canonical chain 上，protocol 会直接 mint。在 mirror
chains 上，buy adapter 收款并发送 cross-chain message；receiver
在 Base 上执行 buy，并把 VPFI bridge 回来。bridge fee 和 verifier
network cost 会 live quote 并显示在表单中。VPFI 不会自动 deposit
进您的 vault — Step 2 按设计是明确的 user action。

<a id="buy-vpfi.deposit"></a>

### Step 2 — 把 VPFI deposit 到您的 vault

这是从您的 wallet 到同一 chain 上 vault 的单独 explicit deposit
step。每条 chain 都需要 — 包括 canonical chain — 因为按 spec，
vault deposit 始终必须是 explicit user action。在配置了 Permit2
的 chains 上，App 会优先使用 single-signature path，而不是传统的
approve + deposit pattern；如果该 chain 未配置 Permit2，则会
cleanly fall back。

<a id="buy-vpfi.unstake"></a>

### Step 3 — 从您的 vault unstake VPFI

把 VPFI 从您的 vault withdraw 回 wallet。没有单独的 approval leg
— protocol 持有 vault，并 debit 自身。withdraw 会基于新的 (较低)
balance 立即触发 fee-discount rate re-stamp，并应用到您参与的每笔
open loan。没有让旧 tier 继续适用的 grace window。

---

## Rewards

<a id="rewards.overview"></a>

### 关于 Rewards

两个 streams：

- **Staking pool** — Vault 持有的 VPFI 以 5% APR 持续累积，按秒
  复利。
- **Interaction pool** — 固定 daily emission 的 per-day pro-rata
  份额，按您对当天 loan volume 的 settled-interest 贡献加权。
  Daily windows 会在 window 关闭后的第一次 claim 或 settlement 时
  lazy finalise。

两个 streams 都直接在 active chain 上 mint — 用户不需要 cross-chain
round-trip。Cross-chain reward aggregation 只发生在 protocol
contracts 之间。

<a id="rewards.claim"></a>

### Claim Rewards

单笔 transaction 会同时 claim 两个 streams。Staking rewards 始终可
用；interaction rewards 在相关 daily window finalise 之前为零 (lazy
finalisation 由该 chain 上下一次 non-zero claim 或 settlement 触发)。
当 window 仍在 finalise 时，UI 会 guard button，因此用户不会
under-claim。

<a id="rewards.withdraw-staked"></a>

### 提取 Staked VPFI

与 Buy VPFI 页面上的 "Step 3 — Unstake" 相同的 interface — 把 VPFI
从 vault withdraw 回 wallet。Withdrawn VPFI 会立即退出 staking
pool (该 amount 的 rewards 在该 block 停止 accrue)，也会立即退出
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
illiquid collateral 上，default 会把您的全部 collateral 转给 lender
— 只有未使用的 VPFI Loan Initiation Fee rebate 还留给您 claim。

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
  minus 1% treasury cut (consent on 时，会再由您的 time-weighted
  VPFI yield-fee discount 降低)。会 burn lender position NFT。
- **Initiate early withdrawal** — 以 asking price 把 lender position
  NFT list 出售。完成销售的 buyer 会接管您这一侧；您获得 proceeds。
  sale fill 前可以 cancel。
- 可选地 delegate 给持有相关 action permission 的 keeper — 见 Keeper
  Settings。

<a id="loan-details.actions:borrower"></a>

#### 如果您是 borrower

- **Repay** — full 或 partial。Partial 会减少 outstanding 并提高 HF；
  full 会触发 terminal settlement，包括 time-weighted VPFI Loan
  Initiation Fee rebate。
- **Preclose direct** — 现在从您的 wallet 支付 outstanding amount，
  release collateral，并 settle rebate。
- **Preclose offset** — 通过 protocol 的 swap router 出售部分
  collateral，用 proceeds repay，并返还剩余。两步：initiate，然后
  complete。
- **Refinance** — 为新 terms 发布 borrower offer；一旦 lender accept，
  complete refinance 会 atomically swap loans，collateral 始终不离开
  您的 vault。
- **Claim as borrower** — 仅在 terminal state 可用。full repayment 时返还
  collateral；default / liquidation 时返还 unused VPFI Loan Initiation
  Fee rebate。会 burn borrower position NFT。

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
（贷款结算、NFT 转移、销售收益分割），要么完全 revert（没有
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

旧 loan 未使用的 Loan Initiation Fee rebate 会作为 swap 的一部分
正确 settle。

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
3. Burn 旧 position NFT。
4. Mint 新 position NFT。
5. Settle 旧 loan 未使用的 Loan Initiation Fee rebate。

如果新 terms 下 HF 低于 1.5，则 revert。

---

## Preclose

此页面仅限 borrower — preclose 由 borrower 在自己的 loan 上发起。

<a id="preclose.overview"></a>

### 关于 Preclose

borrower-driven early termination。两条 paths：

- **Direct** — 从您的 wallet 支付 outstanding amount (principal +
  accrued interest)，release collateral，并 settle unused Loan
  Initiation Fee rebate。
- **Offset** — initiate offset，通过 protocol 的 4-DEX swap failover
  为 principal asset 出售一部分 collateral；complete offset，用
  proceeds repay，剩余 collateral 返回给您。同样会进行 rebate
  settlement。

没有 flat early-close penalty。time-weighted VPFI math 会处理公平性。

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
