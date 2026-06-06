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

### 您的 Active Offers

您创建的 Open offers (status Active，expiry 尚未到达)。acceptance
之前随时可以 cancel — cancel call 免费。Acceptance 会把 offer
切换为 Accepted 并触发 loan initiation；它会 mint 两个 position
NFTs (一个给 lender，一个给 borrower)，并以 Active state 开启 loan。

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

---

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

---

<!-- ────────────────────────────────────────────────────────────── -->
<!-- T-086 #374 — TRANSLATION NEEDED                                -->
<!--                                                                -->
<!--   The three sections below are appended in ENGLISH as the      -->
<!--   translator source. Each block is anchored with a stable      -->
<!--   in-app HTML id (load-bearing for dapp cross-links — DO NOT   -->
<!--   change the anchor strings).                                  -->
<!--                                                                -->
<!--   Native Chinese (Simplified) reviewer: please translate each block     -->
<!--   into Chinese (Simplified) AND move it into the appropriate position   -->
<!--   in the body above:                                           -->
<!--                                                                -->
<!--   1. "Your Active Offers" — REPLACES the existing              -->
<!--      `offer-book.your-active-offers` section in this file      -->
<!--      (current locale content is the pre-OpenSea-feature        -->
<!--      version; the EN-source version below ADDS the closed-     -->
<!--      offer status bullets — Filled / Cancelled / Sold /        -->
<!--      Fully Filled / past-GTT note).                            -->
<!--                                                                -->
<!--   2. "Allow optional sale of this NFT on OpenSea"              -->
<!--      (anchor `create-offer.borrow-or-sell`) — INSERT after     -->
<!--      `create-offer.advanced-options` in the Create Offer       -->
<!--      section. This entire section is NEW in this locale.       -->
<!--                                                                -->
<!--   3. "Matching OpenSea offers on a prepay listing"             -->
<!--      (anchor `matching-opensea-offers-on-a-prepay-listing`)    -->
<!--      — INSERT before the "How Liquidation Actually Works"      -->
<!--      section. This entire section is NEW in this locale.       -->
<!--                                                                -->
<!--   Once the translated sections are placed correctly above,     -->
<!--   delete this banner block and the EN source blocks below it.  -->
<!-- ────────────────────────────────────────────────────────────── -->

## [TRANSLATION NEEDED] EN source — Your Active Offers (target placement: `offer-book.your-active-offers`)

<a id="offer-book.your-active-offers"></a>

### Your Active Offers

Open offers (status Active, expiry not yet reached) you created.
Cancellable any time before acceptance — the cancel call is free.
Acceptance flips the offer to Accepted and triggers loan
initiation, which mints the two position NFTs (one for lender,
one for borrower) and opens the loan in the Active state.

Closed offers carry one of several distinct statuses. Some are
already exposed as filter chips on the My Offers page; others
are indexer-side terminals that will get dedicated UI treatment
in follow-up work:

- **Filled** — accepted by a counterparty; the offer's loan
  reference is the resulting loan id.
- **Cancelled** — the offer reached the Cancelled state via
  either path: withdrawn by the creator before acceptance,
  OR cleaned up permissionlessly via `OfferCancelFacet.cancelOffer`
  once `LibVaipakam.isOfferExpired(offer)` is true (the refund
  still routes to the creator regardless of who initiated the
  cancel call).
- **Sold** — the offer was opted into the borrow-OR-sell
  parallel-sale flow (see Create Offer → Allow optional sale)
  and a marketplace buyer filled the NFT collateral listing
  before any lender accepted. The offer carries the on-chain
  status `consumed_by_sale`; the row's rate column shows the
  rate the offer was posted at and the collateral cell renders
  the NFT shape (token id for ERC-721, copy count for
  ERC-1155). The dapp also surfaces the row in the Activity
  feed as `Offer sold via OpenSea` for the borrower (offer
  creator). The on-chain event itself is
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  both the offer id AND the executor address are indexed on-chain,
  but the borrower / creator address is NOT. The borrower's
  wallet match for the Activity feed is added by the indexer at
  ingestion time (it joins the offer row to look up the creator),
  so the per-wallet filter finds the borrower without the
  event itself indexing them.
- **Fully Filled (indexer state, no chip yet)** — Range-orders
  only. When partial-fill matching consumes the offer's
  remaining budget (the last match fully fills the range, or
  a partial match leaves a sub-dust remainder),
  `OfferMatchFacet` emits `OfferClosed(FullyFilled | Dust)` and
  the indexer stamps the offer row `status = 'fullyFilled'`.
  The contract's `accepted` state and the on-chain Filled
  label above are reserved for the direct-accept terminal, so
  `fullyFilled` is distinct on the indexer side. The dapp's
  `MyOfferStatus` doesn't yet expose this terminal as its own
  filter chip — `useMyOffers` currently ignores rows with the
  `fullyFilled` indexer status — so a fully-filled range offer
  effectively drops out of the My Offers view altogether
  until the dedicated chip lands. The chip surface is queued
  as a separate UI follow-up.

Past-GTT (Good-Til-Time) offers that never reached a terminal
event aren't yet exposed as a distinct status chip in the dapp;
they currently fall under Active until the indexer records a
terminal. A dedicated Expired chip is queued as a separate UI
follow-up.


## [TRANSLATION NEEDED] EN source — Allow optional sale of this NFT on OpenSea (target placement: `create-offer.borrow-or-sell`)

<a id="create-offer.borrow-or-sell"></a>

### Allow optional sale of this NFT on OpenSea (borrower NFT-collateral offers only)

If you're posting a **borrower offer** with **ERC-721 or
ERC-1155 collateral** and an **ERC-20 principal**, the dapp
exposes a `Borrow or sell` opt-in below the collateral
section. Ticking it marks the offer as eligible for a
parallel-sale listing of your NFT collateral on OpenSea — a
single offer that can be filled EITHER by a lender (you take
the loan) OR by a marketplace buyer (you sell the NFT). The
listing is NOT torn down at lender acceptance if it was already
posted: if a lender fills first you take the loan, the existing
OpenSea listing carries through loan initiation until its
original Seaport expiry, and a later marketplace fill before
that expiry triggers the diamond's settlement waterfall to close
the loan from the sale proceeds (see Scenario B below). For
ordinary GTT offers this expiry is the offer's original
Good-Til-Time; lender acceptance does not extend or repost the
listing for the full loan term. If a marketplace buyer fills
first, no loan is ever created (Scenario A). The two scenarios
end at different offer states: Scenario A stamps
the offer with `consumed_by_sale` via `markOfferConsumedBySale`
(it shows up under the Sold filter), and lender acceptance
is gated against any offer that has already been stamped. In
Scenario B the offer is already in the `Accepted` state by
the time the marketplace fill lands; the contract
deliberately leaves the offer status at `Accepted` and only
settles the loan from the sale — the offer doesn't transition
to Sold a second time.

**Two-step nature.** Opting in at offer create time just
sets the eligibility flag on the offer. Getting an actual
buyable listing onto OpenSea is a SEPARATE TWO-PART step
the dapp does NOT automate today:

1. **Record + wire on the diamond.** Call
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` while the offer is still active and before any
   lender acceptance. Once the offer is accepted, cancelled, or
   consumed by sale, this call reverts as terminal; ticking the
   opt-in alone is not enough to create a listing that can carry
   into Scenario B. The ask must also clear the pre-loan floor:
   principal plus worst-case offer interest through the loan
   duration and grace window, treasury cut on that interest, the
   configured safety buffer, and all fee-leg amounts. Under-floor
   asks revert at this step. The `feeLegs` argument is the ONLY
   place this call records OpenSea protocol-fee and creator-
   royalty obligations: the diamond subtracts each fee-leg
   amount from the seller proceeds and appends the recipient +
   absolute amount to the Seaport consideration array.
   Passing `feeLegs: []` on a fee-enforced collection produces
   an order shape that the OpenSea publish step will reject
   (the fee-recipient consideration items are missing) and a
   direct Seaport fill will route the full ask to the seller
   rather than splitting the fees as the collection requires.
   Advanced users must fetch the OpenSea required-fee schedule
   for the collection (the in-repo fee parser at
   `apps/agent/src/openseaFees.ts` is the reference) and pass
   absolute amounts derived against the ask before calling. The facet internally builds the
   canonical Seaport OrderComponents from those inputs, the
   OfferContext values it records for the executor (borrower
   vault address, principal asset, collateral fields, startTime,
   endTime), and the current `Seaport.getCounter` for the vault,
   derives the orderHash via
   `Seaport.getOrderHash`, returns it, registers the vault's
   ERC-1271 binding to that hash, and grants the Seaport
   conduit approval for the NFT collateral. The emitted
   `PostParallelSaleListing` event exposes the input args
   (`offerId`, borrower, orderHash, askPrice, executor /
   conduit data, salt, fee legs); it does NOT echo the
   per-context fields, so reconstructing OrderComponents
   off-chain requires the additional reads described in
   step 2 below. **Important:** at this point the order is
   already FILLABLE via Seaport. A bot watching the
   contract's events PLUS those reads can reconstruct the
   OrderComponents and call `Seaport.fulfillOrder` directly
   — the listing does not need to appear on OpenSea's
   marketplace UI for
   the on-chain fill path to work. If you don't want
   counterparties to fill at the current ask before step 2
   lands, either run step 2 immediately after step 1 OR call
   `releaseParallelSaleLock` to invalidate the binding before
   any unintended fill.
   For fee-enforced collections, populate `feeLegs` from the
   collection's required OpenSea / creator fee schedule before
   calling this step. Use only required, non-zero fee rows; cap
   the list to the protocol-supported fee-leg count; convert each
   row into an absolute fixed amount in the principal asset at the
   chosen ask price; and use the listed fee recipient as the leg
   recipient. If a required fee rounds to zero at the chosen ask,
   the ask is too small for that collection and the post should not
   be attempted. Passing an empty array is valid only for fee-free
   collections. On fee-enforced collections it can produce an order
   that fails OpenSea publication or cannot satisfy the marketplace's
   required consideration shape.
2. **Publish to OpenSea.** Reconstruct the same OrderComponents
   the facet built. The `PostParallelSaleListing` event alone
   isn't sufficient: it emits `offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, and fee legs, but
   the offer-keyed order shape also needs values held in the
   executor's `OfferContext` storage (borrower vault address,
   principal asset, collateral fields, startTime, endTime) plus
   the borrower vault's Seaport counter. This is the same
   context used by the `LibPrepayOrder.buildAndHashOfferMem`
   offer-order path, and it is different from the loan-keyed
   prepay-listing order shape. Read both before posting:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     returns the persisted `OfferContext` struct for that hash.
   - `Seaport.getCounter(borrowerVault)` returns the canonical
     Seaport counter for the vault offerer.
   With those fields in hand the OrderComponents struct
   reproduces exactly the one the diamond hashed. Before POSTing,
   add the API-only `parameters.totalOriginalConsiderationItems`
   field — OpenSea's API requires it even though it's NOT part
   of the Seaport struct that produces the canonical hash; the
   in-repo publishers (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) inject it before
   calling the endpoint. For ERC-1271-validated orders OpenSea
   accepts the `signature` field as `0x` (empty bytes) — the
   vault's on-chain `isValidSignature(orderHash, '')` callback
   ignores the signature bytes and returns the EIP-1271 magic
   value for any orderHash the diamond previously registered
   (from step 1). POST the JSON to the OpenSea listings
   endpoint (`POST /api/v2/orders/{chain}/{protocol}/listings`,
   per the official [Create Listing](https://docs.opensea.io/reference/post_listing)
   docs — this is the same endpoint Vaipakam's own publishers
   in `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` use). Only after this
   step does the listing appear on OpenSea's marketplace UI
   and become discoverable to casual buyers. Vaipakam does
   not currently automate this submission for the
   parallel-sale path — surfacing the listing publication
   end-to-end is tracked as a follow-up.

Advanced users following the manual path today need BOTH steps
to get OpenSea visibility; running step 1 alone produces an
order that's fillable directly through Seaport (by a bot or
counterparty that reconstructs the components from the event)
but invisible on the OpenSea marketplace UI.

**Fill mode is forced to All-or-Nothing.** Opting in
automatically pins the offer's fill mode to `Aon` — partial
or IOC fills would create multiple loans against one
offer's collateral, which the contract gates against. The
toggle is hidden on lender offers, ERC-20 collateral, NFT
principals, and any other shape the contract's
`_validatePostParallelSale` would reject, so you can't
accidentally tick it on an ineligible offer.

**What a buyer sees.**

- *Before any lender accepts* (Scenario A): a buyer who
  fills the OpenSea listing pays the listed price. On
  fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first; the executor passes only the
  **net proceeds** (listed price minus those marketplace /
  creator fee legs) to the diamond. The diamond escrows that
  net amount in your vault, the NFT transfers to the buyer,
  and the offer is marked `consumed_by_sale` (visible as a
  distinct "Sold" status in My Offers, Activity, and Offer
  Details). No loan was ever created; you keep the net sale
  proceeds.
- *After a lender accepts* (Scenario B): the listing
  carries through loan initiation only if it was already
  posted before acceptance, and only until the Seaport order's
  original expiry. Neither the borrower NFT lock nor the listing
  is torn down at acceptance, but lender acceptance also does not
  extend or repost the order for the full loan term. A later buyer
  fill before that expiry triggers the diamond's settlement
  waterfall in one Seaport transaction. Same fee-leg note as Scenario A:
  on fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first, and the executor passes only
  the **net proceeds** (sale price minus marketplace /
  creator fees) into the diamond's waterfall. The waterfall
  then routes that net amount: the lender receives their
  settlement entitlement (which `LibEntitlement.settlementInterest`
  computes as the full coupon when the loan was created with
  `useFullTermInterest = true`, or the pro-rata interest
  accrued to the settlement timestamp otherwise — the gate is
  the loan policy, not whether the sale happens before or
  after scheduled maturity), the treasury cut goes to
  treasury, and the remainder is deposited DIRECTLY into
  the current borrower-position NFT holder's vault (via
  `LibUserVault.getOrCreate` + a vault deposit). No Claim
  Center claim is created — check your vault balance after
  the sale lands.

**What you can't combine it with.** Two distinct conflict
classes, surfaced at different protocol stages:

- *Publish-time block (sibling loan-keyed listing).* If the
  loan already has a parallel-sale listing carrying through
  from offer-create AND the borrower then calls
  `NFTPrepayListingFacet.postPrepayListing` (or `updatePrepayListing`)
  to post a SECOND loan-keyed prepay listing on the same loan,
  the diamond reverts with `SiblingParallelSaleListingLive`.
  The conduit approval for the borrower's NFT is a single
  slot — running both listings concurrently would create an
  ambiguous approval. The borrower sees the revert at the
  publish/update call; nothing fills.
- *Fill-time block (open PrecloseFacet offset).* If the loan
  has an open PrecloseFacet offset offer AND a buyer later
  tries to fill the parallel-sale listing, the diamond's
  `_settleLoanFromParallelSale` reverts with
  `ParallelSaleBlockedByOpenOffsetOffer`. The listing remains
  valid on OpenSea but any fill attempt reverts until the
  offset link is cleared. The dapp does NOT currently surface
  a dedicated banner / notification on the Loan Details page
  for this combination; users will see fills revert and may
  need to inspect the revert reason on a block explorer to
  diagnose. The cleanup path is the ordinary offer-cancel
  surface — call `OfferCancelFacet.cancelOffer(offsetOfferId)`
  to cancel the offset offer, which releases the offset link
  and unblocks the parallel-sale fill (PrecloseFacet has no
  separate cancellation entry point; the offset is bound to
  the linked offer, so cancelling the linked offer clears it).
  A dedicated UI surface for the conflict is queued as a
  separate UX follow-up.



## [TRANSLATION NEEDED] EN source — Matching OpenSea offers on a prepay listing (target placement: `matching-opensea-offers-on-a-prepay-listing`)

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Matching OpenSea offers on a prepay listing

Once your prepay listing is live on OpenSea's marketplace,
casual buyers will sometimes place **item offers** directly
on your token — bids tied to your specific collateral, not
to any token in the collection. Vaipakam surfaces these item
offers on the Loan Details page in real time — a separate
panel under "List collateral on OpenSea" with one row per
incoming offer. The panel applies a **buffer threshold** —
the lender's settlement entitlement (which ALREADY INCLUDES
principal plus the full coupon for full-term-interest loans
or the pro-rata interest otherwise — see
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus the
treasury cut, plus a safety buffer — and **greys out** offers
that don't clear it. You can see market interest at every
level but can only Match offers that the protocol will
actually settle.

Collection-wide / criteria offers (bids that any token in
the collection can fulfill) stay on OpenSea but **don't
appear** in the dapp's Match panel — the multi-leg
consideration the protocol settles into can't be
reconstructed against a criteria offer without contract-side
plumbing that isn't in v1. If your only inbound demand is
collection-wide, the practical path today is to wait for
an item-specific bid OR to leave the listing at your fixed
ask and let any buyer fulfill it directly. You cannot
manually settle a collection-wide bid yourself — the
collateral NFT lives in your Vaipakam vault, and Vaipakam-
side Seaport orders are the only authorised settlement
shape.

On collections that enforce OpenSea protocol fees and/or
creator royalties, the dapp DOES render the offers panel —
the fee-schedule fetch from the OpenSea API is treated as
advisory; the actual fulfillment data is fetched at
Match-click time. If that fulfillment-data fetch fails (rate
limit, API outage, or unsupported collection shape), the
dapp-side Match click handler ABORTS before any
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` transaction
is constructed — no calldata, no signature prompt, no
revert. The on-chain function itself isn't a `bool`-returning
selector; when it does run it returns a `bytes32` order hash
or reverts. So a fee-enforced collection's panel may show
offers you can browse but not all of them are clickable-
to-match in a given moment.

When you find an acceptable offer and click **Match offer**,
the dapp opens the **Confirm Match** modal, which restates the
matched value (the gross OpenSea offer amount the panel showed
— NOT the net amount the diamond will settle at; on
fee-enforced collections `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
computes `effectiveAsk = offerValue - bidderFeeTotal` before
running the lender / treasury / borrower split, so the net the
diamond actually distributes is smaller than the modal's
headline) and gives a generic explanation of the atomic-match
flow. After you
confirm, the dapp sends a single `matchOpenSeaOffer`
transaction that bundles the bidder's offer with a freshly-
constructed diamond-side counter-order into one Seaport
`matchAdvancedOrders` call — the bidder's fulfilment, the
counter-order's listing-side leg (whether or not you had a
prior v1 prepay listing live; the atomic path supports
`existingHash == 0`), and the diamond's settlement waterfall
all land atomically in one block. The transaction either fully succeeds (loan
settled, NFT transferred, sale proceeds split) or fully
reverts (nothing moves), and there is **no window between
listing rotation and settlement** in which a third-party
buyer could step in at the matched price.

> **No race window — atomic by construction.** This is the
> structural close-out of the v1 two-step "cancel + post"
> pattern: under v1 the dapp would rotate the listing as a
> separate `updatePrepayListing` transaction, leaving the
> rotated price live on OpenSea until the bidder's
> `fulfillOrder` landed in a later block — anyone watching
> the mempool could snipe the bidder out of the price they
> bid. The atomic path closes that hole by binding both
> orders into one Seaport match call: either the bidder fills
> at the agreed price or the whole transaction reverts.

**What you still want to verify before clicking Match:**

- **Confirm the matched value in the modal.** The modal
  surfaces the gross OpenSea offer amount. On fee-enforced
  collections, the diamond settles against the net effective
  ask after bidder-side marketplace / creator fee legs, so the
  modal value can be higher than the amount used for the
  lender / treasury / borrower split. The bidder address and
  the precise split aren't broken out in either the modal OR
  the OpenSea Offers panel row (the row shows value, payment
  token, offer kind, truncated bidder, and end time). The split
  is enforced on-chain by the diamond at settlement — the
  protocol's settlement buffer guarantees the effective ask covers
  the lender's settlement entitlement (which already includes
  principal plus the full coupon on full-term-interest loans
  or the pro-rata interest otherwise) plus the
  treasury cut, so the split is always at least neutral for
  you. If you want to see the projected split before
  confirming, the diamond exposes
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  as a callable view — it returns the lender and treasury legs
  the settlement waterfall will route at the given timestamp,
  and the remainder is yours.
- **Check OpenSea's fee posture for the collection.** If the
  collection enforces OpenSea protocol fees or creator
  royalties, the atomic path needs SignedZone `extraData` /
  criteria-resolver plumbing that the dapp fetches via the
  agent's OpenSea fulfillment-data proxy (PR #349) AT MATCH
  CLICK TIME. The Match panel renders regardless of
  fee-schedule fetch status; the click-time fulfillment-data
  fetch is the gate. If that fetch fails (rate limit, API
  outage, unsupported collection shape), the dapp-side click
  handler aborts before constructing the on-chain
  `matchOpenSeaOffer` transaction — no calldata is built,
  no signature prompt fires, no banner is shown in advance.
  You can retry the click later (the fetch may have just
  been a transient API blip), or fill the listing directly
  on OpenSea at the listed ask in the meantime.


