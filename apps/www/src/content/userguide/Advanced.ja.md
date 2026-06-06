# Vaipakam — ユーザーガイド (Advanced Mode)

アプリ内の各カードについて、正確で技術的にも信頼できる解説です。
各セクションは、カードタイトルの横にある `(i)` info icon に対応して
います。

> **Advanced 版を読んでいます。** これはアプリの **Advanced**
> モード (より密度の高い controls、diagnostics、protocol 設定の
> 詳細) に対応しています。よりやさしい平易な walkthrough を読み
> たい場合は、アプリを **Basic** モードに切り替えてください —
> Settings を開く (右上の歯車アイコン) → **Mode** → **Basic**。
> その後、アプリ内の (i) "Learn more" リンクは Basic ガイドを
> 開くようになります。

---

## Dashboard

<a id="dashboard.your-vault"></a>

### あなたの Vault

user ごとの upgradable contract — この chain 上にあるあなた専用の
private vault — です。あなたが最初に loan に参加したタイミングで
作成されます。address ごと、chain ごとに 1 つの vault。
あなたの loan positions に紐づく ERC-20、ERC-721、ERC-1155
balances を保持します。pooling はありません: 他の user の assets
がこの contract に入ることはありません。

vault は、collateral、貸し出された assets、locked VPFI が置かれる
唯一の場所です。protocol は deposit / withdrawal のたびに、この
vault を検証します。implementation は protocol owner が update
できますが、timelock 経由のみです — 即時には変えられません。

<a id="dashboard.your-loans"></a>

### あなたの Loans

この chain 上で connected wallet が関わるすべての loan です —
lender side、borrower side、または別々の positions で両方の場合
も含みます。protocol の view methods から、あなたの address に
対して live に calculate されます。各 row は full position page へ
deep-link し、HF、LTV、accrued interest、role と loan status によって
有効化される actions、block explorer に貼れる on-chain loan id を
表示します。

<a id="dashboard.vpfi-panel"></a>

### このチェーン上の VPFI

active chain 上の connected wallet 向け live VPFI accounting:

- wallet balance。
- vault 残高。
- circulating supply に対するあなたの share (protocol-held balances を差し
  引いた後)。
- 残りの mint 可能 cap。

Vaipakam は Chainlink CCIP 上で VPFI を cross-chain に送ります。
**Base が canonical chain** です — canonical adapter はそこで
lock-on-send / release-on-receive semantics を実行します。support
対象の他の chains は mirrors として動き、incoming bridge packets
では mint、outgoing packets では burn します。design 上、bridging
中も全 chains 合計の supply は invariant に保たれます。

April 2026 の業界 incident 後、cross-chain message-verification
policy は **3 required + 2 optional verifiers、threshold 1-of-2**
に hardened されています。default の single-verifier configuration
は deploy gate で拒否されます。

<a id="dashboard.fee-discount-consent"></a>

### 手数料割引の同意

wallet-level の opt-in flag です。terminal events で、protocol が
fee の discounted portion を vault から debit した VPFI で settle
できるようにします。default: off。off は fee の 100% を principal
asset で支払うという意味です。on の場合は time-weighted discount
が適用されます。

Tier ladder:

| Tier | Min vault VPFI                         | Discount                          |
| ---- | --------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`                | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`                | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`                | `{liveValue:tier4DiscountBps}`%   |

Tier は、VPFI を deposit または withdraw した瞬間の
**post-change** vault balance に対して calculate され、その後
各 loan の全期間にわたって time-weighted されます。Unstake は、
あなたの open loans すべてに対して、新しい (低い) balance を
使って rate を即座に re-stamp します — 古い (高い) tier が残る
grace window はありません。これにより、loan 終了直前に VPFI を
top up して full-tier discount を取り、数秒後に withdraw する
exploit pattern を防ぎます。

discount は settlement 時の lender yield fee と borrower の
Loan Initiation Fee に適用されます (borrower が claim するときに
VPFI rebate として支払われます)。

> **Network gas は別物です。** 上記の discount は Vaipakam の
> **protocol fees**（yield fee `{liveValue:treasuryFeeBps}`%、
> Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%）に
> 適用されます。すべての on-chain action に必要な **blockchain
> network gas fee**（Base / Sepolia / Arbitrum などで offer
> create / accept / repay / claim / withdraw 等を行うときに
> validators へ支払うもの）は protocol の charge ではありません。
> Vaipakam は決して受け取らず、network が受け取ります。tier や
> rebate を適用することはできず、submission 時の chain 混雑度に
> 依存し、loan size や VPFI tier には依存しません。

<a id="dashboard.rewards-summary"></a>

### あなたの VPFI Rewards

connected wallet の VPFI rewards 全体像を、2 つの reward streams
にまたがって 1 つの view にまとめる summary card です。headline
figure は、pending staking rewards、lifetime-claimed staking
rewards、pending interaction rewards、lifetime-claimed interaction
rewards の合計です。

stream ごとの breakdown rows には pending + claimed が表示され、
native page 上の full claim card へ chevron deep-link します:

- **Staking yield** — vault balance に対して protocol APR で accrue
  した pending VPFI と、この wallet から過去に claim したすべての
  staking rewards。Buy VPFI page の staking claim card に deep-link
  します。
- **Platform-interaction rewards** — あなたが参加したすべての loan
  (lender side または borrower side) で accrue した pending VPFI と、
  過去に claim したすべての interaction rewards。Claim Center の
  interaction claim card に deep-link します。

lifetime-claimed numbers は、各 wallet の on-chain claim history から
再構築されます。query できる on-chain running total はないため、この
chain 上の過去の claim events を walk して合計します。新しい browser
cache では、historic walk が完了するまで zero (または partial total)
が表示され、その後正しい値に更新されます。trust model は underlying
claim cards と同じです。

card は connected wallets に対して常に render されます。すべての値が
zero の状態でも同じです。empty-state hint は意図的なものです — zero
で card を非表示にすると、新しい users は Buy VPFI や Claim Center に
入るまで rewards programs に気づけません。

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Lender / borrower offer lists の上にある client-side filters です。
asset、side、status、その他の axes で filter できます。Filters は
「あなたのアクティブな Offers」には影響しません — その list は
常に全件表示されます。

<a id="offer-book.your-active-offers"></a>

### あなたのアクティブな Offers

あなたが作成した open offers (status Active、expiration 未到達)
です。acceptance 前ならいつでも cancel できます — cancel は無料
です。Acceptance は offer を Accepted に変え、loan initiation を
trigger します。これにより 2 つの position NFTs (lender と
borrower に 1 つずつ) が mint され、loan が Active state で open
されます。

<a id="offer-book.lender-offers"></a>

### Lender Offers

creator が貸し出す意思を示している active offers です。accept
するのは borrower です。initiation 時には hard gate があります:
borrower の collateral basket は、lender の principal request に
対して少なくとも 1.5 の Health Factor を作る必要があります。HF
math は protocol 独自のもので、gate は bypass できません。interest
に対する 1% treasury cut は terminal settlement 時に debit され、
upfront ではありません。

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

すでに collateral を vault に lock している borrowers の active
offers です。accept するのは lender です。acceptance により
principal asset で loan が fund され、position NFTs が mint され
ます。initiation 時には同じ HF ≥ 1.5 gate が適用されます。fixed
APR は offer 作成時に set され、loan の lifetime を通じて immutable
です — refinance は既存 loan を変更せず、新しい loan を作成
します。

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

creator が offer のどちらの side にいるかを選択します:

- **Lender** — lender が principal asset と、borrower が満たす
  べき collateral spec を指定します。
- **Borrower** — borrower が前もって collateral を lock します。
  lender が accept して fund します。
- **Rental** サブタイプ — ERC-4907 (rentable ERC-721) と
  rentable ERC-1155 NFTs 用。debt loan ではなく rental flow を
  通ります。renter は rental cost 全額 (duration × daily fee) と
  5% buffer/margin を upfront で支払います。

<a id="create-offer.lending-asset"></a>

### Lending Asset

debt offer では、asset、principal amount、fixed APR、duration
(日数) を指定します:

- **Asset** — 貸し出す / 借りる ERC-20。
- **数量** — principal、その asset の native decimals で表記。
- **APR** — basis points (1% の 1/100) で表す fixed annual rate。
  acceptance 時に snapshot され、その後は変化しません。
- **期間 (日数)** — default を trigger できるようになるまでの
  grace window を set します。

accrued interest は loan の start time から terminal settlement
まで、秒単位で継続的に calculate されます。

<a id="create-offer.lending-asset:lender"></a>

#### あなたが lender の場合

あなたが offer する principal asset と amount、interest rate
(APR %) と duration (日数) です。rate は offer 時に fixed され、
duration は loan が default 可能になるまでの grace window を
決めます。acceptance 時に、loan initiation の一部として principal
はあなたの vault から borrower の vault へ move します。

<a id="create-offer.lending-asset:borrower"></a>

#### あなたが borrower の場合

lender から受け取りたい principal asset と amount、interest rate
(APR %) と duration (日数) です。rate は offer 時に fixed され、
duration は loan が default 可能になるまでの grace window を
決めます。あなたの collateral は offer 作成時に vault に lock
され、lender が accept して loan が open するまで (またはあなたが
cancel するまで) lock されたままです。

<a id="create-offer.nft-details"></a>

### NFT Details

Rental sub-type fields です。NFT contract と token id (ERC-1155
では quantity も)、そして principal asset 建ての daily rental fee
を指定します。acceptance 時に、protocol は prepaid rental を
renter の vault から custody へ debit します — duration × daily
fee と 5% buffer/margin です。NFT 自体は delegated state に移ります
(ERC-4907 user rights、または ERC-1155 rental hook 相当を通じて)。
renter は利用権を持ちますが、NFT を transfer することはできません。

<a id="create-offer.collateral"></a>

### Collateral

offer 上の collateral asset spec です。liquidity は 2 classes:

- **Liquid** — registered Chainlink price feed があり、かつ
  Uniswap V3 / PancakeSwap V3 / SushiSwap V3 のいずれかに
  current tick で ≥ $1M depth の pool が少なくとも 1 つあるもの。
  LTV と HF math が適用されます。HF-based liquidation は collateral
  を 4-DEX failover (0x → 1inch → Uniswap V3 → Balancer V2) で
  route します。
- **Illiquid** — 上記を満たさないもの。on-chain では $0 と評価。
  HF math はありません。default 時には collateral 全体が lender
  に transfer されます。offer を submit するには、offer creation /
  acceptance 時に双方が illiquid-collateral risk を明示的に
  acknowledge する必要があります。

price oracle は primary Chainlink feed に加えて、3 つの独立した
sources (Tellor、API3、DIA) による secondary quorum を持ち、
soft 2-of-N decision rule を使います。Pyth は評価されましたが、
採用されませんでした。

<a id="create-offer.collateral:lender"></a>

#### あなたが lender の場合

borrower に loan の security としてどれだけ lock してもらうか
です。Liquid ERC-20s (Chainlink feed + ≥ $1M v3 pool depth) には
LTV / HF math が適用されます。Illiquid ERC-20s と NFTs には
on-chain valuation がなく、full-collateral-on-default outcome へ
双方の同意が必要です。loan initiation 時の HF ≥ 1.5 gate は、
acceptance 時に borrower が提示した collateral basket に対して
calculate されます — ここでの requirement size が borrower の HF
headroom を直接決めます。

<a id="create-offer.collateral:borrower"></a>

#### あなたが borrower の場合

loan の security として、あなたがどれだけ lock してよいかです。
Liquid ERC-20s (Chainlink feed + ≥ $1M v3 pool depth) には LTV / HF
math が適用されます。Illiquid ERC-20s と NFTs には on-chain
valuation がなく、full-collateral-on-default outcome へ双方の同意
が必要です。borrower offer では、あなたの collateral は offer
creation 時に vault に lock されます。lender offer では、
acceptance 時に lock されます。どちらの場合も、loan initiation
時の HF ≥ 1.5 gate は、あなたが提示する basket で clear する必要
があります。

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

submission 前の acknowledgement gate です。同じ risk profile が
両 side に適用されます。下の role-specific tabs では、あなたが
offer のどちら側で sign しているかによって、それぞれの risk が
どう効くかを説明します。Vaipakam は non-custodial です: 完了した
transaction を巻き戻せる admin key はありません。Pause levers は
cross-chain-facing contracts にのみあり、timelock-gated で、assets
を move することはできません。

<a id="create-offer.risk-disclosures:lender"></a>

#### あなたが lender の場合

- **Smart-contract リスク** — contract code は runtime で
  immutable です。audited ですが、formally verified ではありません。
- **Oracle リスク** — Chainlink staleness や pool-depth divergence
  により、collateral が principal を cover できなくなった後まで
  HF-based liquidation が遅れる可能性があります。secondary quorum
  (Tellor + API3 + DIA、soft 2-of-N) は大きな drift を捕捉しますが、
  小さな skew はなお recovery を削る可能性があります。
- **Liquidation slippage** — 4-DEX failover は可能な限り良い
  execution へ route しますが、specific price は保証できません。
  Recovery は slippage と interest に対する 1% treasury cut を
  差し引いた net です。
- **Illiquid-collateral defaults** — default time に collateral
  全体があなたへ transfer されます。asset が principal + accrued
  interest より低い value しかない場合、recourse はありません。

<a id="create-offer.risk-disclosures:borrower"></a>

#### あなたが borrower の場合

- **Smart-contract リスク** — contract code は runtime で
  immutable です。bugs は locked collateral に影響する可能性が
  あります。
- **Oracle リスク** — staleness や manipulation により、
  real-market price では安全だったはずのタイミングで、あなたに
  対する HF-based liquidation が trigger される可能性があります。
  HF formula は oracle output に反応します。1.0 を越える bad tick
  が 1 つあれば十分です。
- **Liquidation slippage** — liquidation が trigger されると、swap
  があなたの collateral を slippage-hit price で売る可能性が
  あります。swap は permissionless です — HF が 1.0 を下回った
  瞬間、誰でも trigger できます。
- **Illiquid-collateral defaults** — default はあなたの collateral
  全体を lender に transfer します。residual claim はありません。
  残るのは、claim 時に borrower として受け取る unused VPFI Loan
  Initiation Fee rebate だけです。

<a id="create-offer.advanced-options"></a>

### Advanced Options

あまり使われない settings:

- **Expiry** — この timestamp 以降、offer は self-cancel します。
  default は ≈ 7 日です。
- **この offer に手数料割引を使用** — この特定の offer に対する
  wallet-level fee-discount consent の local override です。
- offer creation flow で exposed される side-specific options。

defaults はほとんどの users にとって合理的です。

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims は design 上 pull-style です — terminal events は funds を
protocol custody に残し、position NFT holder が claim call をして
move します。両タイプの claims が同じ wallet に同時に存在する
こともあります。下の role-specific tabs でそれぞれを説明します。

各 claim は holder の position NFT を atomically に burn します。
NFT *こそ* bearer instrument です — claim 前に transfer すると、
新しい holder が collect する権利を得ます。

<a id="claim-center.claims:lender"></a>

#### あなたが lender の場合

Lender claim は次を返します:

- principal がこの chain 上のあなたの wallet に戻ります。
- accrued interest minus 1% treasury cut。同意が on の場合、その
  cut 自体があなたの time-weighted VPFI fee-discount accumulator
  によってさらに減ります。

loan が terminal state (Settled、Defaulted、Liquidated) に達すると
すぐに claimable になります。Lender position NFT は同じ transaction
で burn されます。

<a id="claim-center.claims:borrower"></a>

#### あなたが borrower の場合

Borrower claim は、loan がどう settle されたかによって次を返し
ます:

- **full repayment / preclose / refinance** — あなたの collateral
  basket と、Loan Initiation Fee からの time-weighted VPFI rebate。
- **HF-liquidation または default** — unused VPFI Loan Initiation
  Fee rebate のみ。これらの terminal paths では、明示的に preserve
  されない限り 0 です。Collateral はすでに lender に渡っています。

Borrower position NFT は同じ transaction で burn されます。

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain 上であなたの wallet に関わる on-chain events です。
protocol logs から sliding block window で live sourced されます。
backend cache はありません — page load ごとに再取得します。
events は transaction hash ごとに group されるため、multi-event
transactions (例: accept + initiate が同じ block 内) はまとまって
表示されます。新しい順です。offers、loans、repayments、claims、
liquidations、NFT mints / burns、VPFI buys / stakes / unstakes を
表示します。

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI を購入する

2 つの paths:

- **Canonical (Base)** — protocol の canonical buy flow を直接
  call します。VPFI は Base 上のあなたの wallet に直接 mint され
  ます。
- **Off-canonical** — local-chain buy adapter が Base 上の
  canonical receiver へ Chainlink CCIP packet を送ります。receiver は
  Base で purchase を execute し、cross-chain token standard で
  result を bridge して戻します。L2-to-L2 pairs で end-to-end
  latency は ≈ 1 分です。VPFI は **origin** chain 上のあなたの
  wallet に land します。

Adapter rate limits (post-hardening): request あたり 50,000 VPFI、
rolling 24 hours で 500,000 VPFI。governance が timelock 経由で
tune できます。

<a id="buy-vpfi.discount-status"></a>

### あなたの VPFI Discount Status

Live status:

- 現在の tier (0 から 4)。
- Vault VPFI 残高と次の tier までの差分。
- 現在の tier における割引パーセンテージ。
- wallet-level consent flag。

vault VPFI は staking pool 経由で自動的に 5% APR も accrue します
— 別の "stake" action はありません。VPFI を vault に deposit
すること自体が staking です。

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH で VPFI を購入する

purchase を submit します。canonical chain では protocol が直接
mint します。Mirror chains では buy adapter が payment を受け取り、
cross-chain message を送り、receiver が Base で purchase を execute
して VPFI を bridge して戻します。Bridge fee + verifier-network
cost は form 内で live quote され表示されます。VPFI は vault に
自動 deposit されません — design 上、Step 2 は explicit user action
です。

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI を vault に入金する

wallet から同じ chain 上のあなたの vault へ移す、別の explicit
deposit step です。すべての chains で必要です — canonical でも —
vault deposit spec では常に explicit user action だからです。
Permit2 が configured されている chains では、app は classic
approve + deposit pattern より single-signature path を prefer
します。その chain で Permit2 が configured されていない場合は、
cleanly fall back します。

<a id="buy-vpfi.unstake"></a>

### Step 3 — vault から VPFI をアンステークする

VPFI を vault から wallet に戻します。approval leg はありません
— protocol が vault owner であり、自身を debit します。withdraw
は新しい (低い) balance で fee-discount rate を即座に re-stamp
し、あなたの open loans すべてに適用されます。古い tier がまだ
apply される grace window はありません。

---

## Rewards

<a id="rewards.overview"></a>

### Rewards について

2 つの streams:

- **Staking pool** — vault にある VPFI は 5% APR で継続的に
  accrue し、per-second compounding されます。
- **Interaction pool** — fixed daily emission の per-day pro-rata
  share です。その日の loan volume に対するあなたの settled-interest
  contribution で weighted されます。Daily windows は window close
  後の最初の claim または settlement で lazily finalise されます。

両方の streams は active chain 上で直接 mint されます — user 側の
cross-chain round-trip はありません。Cross-chain reward aggregation
は protocol contracts 間でのみ行われます。

<a id="rewards.claim"></a>

### Rewards を Claim する

1 transaction で両方の streams をまとめて claim します。Staking
rewards は常に available です。Interaction rewards は、該当する
daily window が finalise されるまで zero です (その chain 上の次の
non-zero claim または settlement で trigger される lazy finalisation)。
window がまだ finalise 中のときは UI が button を guard し、users
が under-claim しないようにします。

<a id="rewards.withdraw-staked"></a>

### ステーキング済みの VPFI を引き出す

Buy VPFI ページの "Step 3 — Unstake" と同じ interface です —
vault から wallet に VPFI を戻します。withdraw された VPFI は
即座に staking pool から外れ (その amount の rewards は同じ block
で accrue を停止)、discount accumulator からも即座に外れます
(各 open loan で post-balance re-stamp)。

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (このページ)

protocol から live-derived された single-loan view です。risk
engine からの live HF と LTV も表示します。terms、collateral risk、
parties、role と loan status で有効化される actions、inline
keeper status を render します。

<a id="loan-details.terms"></a>

### Loan Terms

loan の immutable parts:

- Principal (asset と amount)。
- APR (offer 作成時に固定)。
- 期間 (日数)。
- 開始時刻と終了時刻 (= 開始時刻 + 期間)。
- accrued interest。start から経過した seconds で live calculate。

Refinance はこれらの values を変更せず、新しい loan を作成
します。

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

Live risk math.

- **Health Factor** = (collateral USD value × liquidation
  threshold) / debt USD value。HF が 1.0 を下回ると position は
  liquidatable になります。
- **LTV** = debt USD value / collateral USD value。
- **Liquidation threshold** = position が liquidatable になる LTV。
  collateral basket の volatility class に依存します。
  high-volatility collapse trigger は 110% LTV です。

Illiquid collateral の on-chain USD value は zero です。HF と LTV
は "n/a" になり、唯一の terminal path は default 時の full
collateral transfer です — 両当事者は offer creation 時に
illiquid-risk acknowledgement で同意済みです。

<a id="loan-details.collateral-risk:lender"></a>

#### あなたが lender の場合

この loan を secure する collateral basket があなたの protection
です。HF が 1.0 より上なら、position は liquidation threshold に
対して over-collateralised です。HF が 1.0 に向かって drift する
ほど、protection は弱くなります。HF が 1.0 を下回ると、誰でも
(あなたを含めて) liquidate call でき、protocol は collateral を
4-DEX failover 経由であなたの principal asset に route します。
Recovery は slippage 後の net です。

Illiquid collateral では、default time に basket 全体があなたへ
transfer されます — open market で実際にどれだけの value があるか
という risk はあなたが引き受けます。

<a id="loan-details.collateral-risk:borrower"></a>

#### あなたが borrower の場合

あなたの locked collateral です。HF は 1.0 より十分上に保って
ください — volatility を吸収する common safety margin は 1.5 です。
HF を引き上げる levers:

- **担保を追加** — basket を top up します。User-only action。
- **部分返済** — debt を減らし、HF を引き上げます。

HF が 1.0 を下回ると、誰でも HF-based liquidation を trigger でき
ます。swap は lender へ返済するため、slippage-hit price であなたの
collateral を売ります。Illiquid collateral では、default により
collateral 全体が lender に transfer されます — claim できるのは
unused VPFI Loan Initiation Fee rebate のみです。

<a id="loan-details.parties"></a>

### Parties

Lender、borrower、lender vault、borrower vault、そして 2 つの
position NFTs (各 side に 1 つ)。各 NFT は on-chain metadata を
持つ ERC-721 です。transfer すると、claim する権利も transfer
されます。Vault contracts は address ごとに deterministic です
— deployments をまたいでも同じ address です。

<a id="loan-details.actions"></a>

### Actions

role ごとに protocol で gated された action interface です。下の
role-specific tabs で各 side の available actions を確認できます。
disabled actions は gate から derived された hover reason を表示
します ("Insufficient HF"、"Not yet expired"、"Loan locked" など)。

role に関係なく誰でも利用できる permissionless actions:

- **Liquidation をトリガー** — HF が 1.0 を下回ったとき。
- **Default をマーク** — full repayment なしで grace period が
  expire したとき。

<a id="loan-details.actions:lender"></a>

#### あなたが lender の場合

- **Lender として claim** — terminal state のみ。Principal plus interest
  minus 1% treasury cut を返します (consent on の場合は
  time-weighted VPFI yield-fee discount でさらに減ります)。
  Lender position NFT を burn します。
- **Early withdrawal を開始** — 選んだ asking price で lender
  position NFT を sale listing します。sale を complete した buyer
  があなたの side を引き継ぎ、あなたは proceeds を受け取ります。
  sale fill 前は cancel できます。
- 関連する action permission を持つ keeper に delegate することも
  できます — Keeper Settings を参照してください。

<a id="loan-details.actions:borrower"></a>

#### あなたが borrower の場合

- **Repay** — full または partial。Partial repayment は outstanding
  を減らし、HF を上げます。Full repayment は terminal settlement
  を trigger し、time-weighted VPFI Loan Initiation Fee rebate を
  含みます。
- **Preclose direct** — outstanding amount を今すぐ wallet から
  支払い、collateral を release し、rebate を settle します。
- **Preclose offset** — protocol の swap router 経由で collateral
  の一部を売り、proceeds で repay し、残りを返します。2-step:
  initiate、その後 complete。
- **Refinance** — 新しい terms で borrower offer を投稿します。
  lender が accept したら、complete refinance により loans が
  atomically に swap されます。collateral は vault から出ません。
- **Borrower として claim** — terminal state のみ。full repayment では
  collateral を返し、default / liquidation では unused VPFI Loan
  Initiation Fee rebate を返します。Borrower position NFT を burn
  します。

---

## Allowances

<a id="allowances.list"></a>

### Allowances

この chain 上であなたの wallet が protocol に与えた ERC-20
allowance をすべて一覧表示します。candidate-token list を
on-chain allowance views に対して scan して source します。Revoke
は allowance を zero に set します。

Exact-amount approval policy により、protocol は unlimited
allowances を要求しないため、typical revocation list は短めです。

注: Permit2-style flows は protocol への per-asset allowance を
bypass し、代わりに single signature を使います。そのため、ここ
の list が clean でも将来の deposits は妨げられません。

---

## Alerts

<a id="alerts.overview"></a>

### Alerts について

off-chain watcher が、あなたの wallet に関わる active loans を
5-minute cadence で poll し、それぞれの live Health Factor を読み、
unsafe direction への band crossing で configured channels 経由の
alert を一度 fire します。on-chain state も gas もありません。
Alerts は advisory です — funds は move しません。

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

user-configured HF bands の ladder です。より risky な band に
crossing すると一度 fire し、次の deeper threshold を arm します。
band より上に戻ると re-arm されます。default: 1.5 → 1.3 → 1.1。
高い values は volatile collateral に適しています。ladder の目的
は、HF が 1.0 を下回って liquidation が trigger される前に警告
することです。

<a id="alerts.delivery-channels"></a>

### Delivery Channels

2 つの rails:

- **Telegram** — wallet の short address、loan id、現在の HF を
  含む bot direct message。
- **Push Protocol** — Vaipakam Push channel 経由の wallet-direct
  notification。

どちらも threshold ladder を共有します。drift を避けるため、
per-channel warning levels は意図的に expose されていません。
Push channel publishing は現時点では channel creation まで stubbed
です。

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### NFT を検証する

NFT contract address と token id を指定すると、verifier は次を
fetch します:

- 現在の owner (または token がすでに burn されている場合は burn
  signal)。
- on-chain JSON metadata。
- Protocol cross-check: metadata から underlying loan id を derive
  し、state を confirm するために protocol から loan details を
  読み取ります。

表示される内容: Vaipakam が mint したものか? どの chain か?
loan の status は? 現在の holder は? fake、すでに claimed (burned)
の position、または loan が settled 済みで mid-claim の position
を見分けられます。

position NFT は bearer instrument です — secondary market で購入
する前に verify してください。

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers について

wallet ごとに最大 5 keepers までの keeper whitelist です。各 keeper
は、loan の **あなたの side** に対する specific maintenance calls
を authorise する action permissions の set を持ちます。Money-out
paths (repay、claim、add collateral、liquidate) は design 上
user-only で、delegate できません。

action time には追加の 2 gates が apply されます:

1. Master keeper-access switch — allowlist に触れず、すべての
   keeper を disable する one-flip emergency brake。
2. Per-loan opt-in toggle。Offer Book または Loan Details interface
   で設定します。

keeper は 4 つの conditions がすべて true の場合にのみ act できます:
approved、master switch on、per-loan toggle on、その keeper に
specific action permission が set されていること。

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

現在 expose されている action permissions:

- **Loan sale を完了** (lender side、secondary-market exit)。
- **Offset を完了** (borrower side、collateral sale 経由の preclose
  の second leg)。
- **Early withdrawal を開始** (lender side、position を sale listing
  へ)。
- **Preclose を開始** (borrower side、preclose flow を開始)。
- **Refinance** (borrower side、新しい borrower offer 上での atomic
  loan swap)。

frontend がまだ reflect していない on-chain permissions は、明確な
"permission invalid" revert を受け取ります。Revocation はすべての
loans で即時です — waiting period はありません。

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics について

wallet-free aggregator です。supported chains それぞれで on-chain
protocol view calls から live に calculate されます。backend なし、
database なし。CSV / JSON export が available です。verifiability
のため、各 metric の背後にある protocol address と view function
が表示されます。

<a id="public-dashboard.combined"></a>

### Combined — All Chains

Cross-chain rollup です。header は何 chains が covered され、何
chains が errored かを report するため、fetch 時に unreachable な
RPC が明示されます。1 つ以上の chains が errored の場合、per-chain
table が該当 chain を flag します — TVL totals は引き続き report
されますが、gap は acknowledge されます。

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

Combined metrics の per-chain split です。TVL concentration、
mismatched VPFI mirror supplies (mirror supplies の sum は
canonical adapter の locked balance と等しいはず)、または stalled
chains を spot するのに有用です。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

active chain 上の on-chain VPFI accounting:

- total supply、ERC-20 から直接読み取ります。
- circulating supply — total supply minus protocol-held balances
  (treasury、reward pools、in-flight bridge packets)。
- 残りの mintable cap — canonical chain でのみ meaningful です。
  mirror chains は cap について "n/a" を report します。そこでの
  mints は bridge-driven であり、cap に基づくものではないためです。

Cross-chain invariant: すべての mirror chains における mirror
supplies の sum は、canonical adapter の locked balance と等しく
なります。watcher がこれを monitor し、drift で alert します。

<a id="public-dashboard.transparency"></a>

### Transparency & Source

各 metric について page が list するもの:

- snapshot として使われた block number。
- data freshness (chains 間の最大 age/staleness)。
- protocol address と view function call。

この page のどの number も、RPC + block + protocol address +
function name から誰でも re-derive できます — それが基準です。

---

## Refinance

このページは borrower 専用です — refinance は borrower が自分の
loan に対して開始します。

<a id="refinance.overview"></a>

### Refinancing について

Refinance は、あなたの既存 loan を新しい principal で atomically
に返済し、新しい terms の fresh loan を open します。すべて 1 つ
の transaction 内で行われます。collateral は常にあなたの vault
に残ります — unsecured window はありません。新しい loan は、他の
loan と同様に initiation 時に HF ≥ 1.5 gate を clear する必要が
あります。

古い loan の unused Loan Initiation Fee rebate は swap の一部として
正しく settle されます。

<a id="refinance.position-summary"></a>

### あなたの現在のポジション

refinance する loan の snapshot です — 現在の principal、これまで
の accrued interest、HF / LTV、collateral basket。新しい offer は
少なくとも outstanding amount (principal + accrued interest) に
合わせて size するべきです。新しい offer に surplus があれば、
free principal としてあなたの vault に deliver されます。

<a id="refinance.step-1-post-offer"></a>

### Step 1 — 新しい offer を投稿する

target terms で borrower offer を投稿します。古い loan は待っている
間も interest を accrue し続け、collateral は locked のままです。
offer は public Offer Book に表示され、どの lender でも accept
できます。acceptance 前なら cancel できます。

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

新しい lender が accept した後の atomic settlement:

1. accepting lender から新しい loan を fund。
2. 古い loan を full repay (principal + interest、treasury cut 後)。
3. 古い position NFTs を burn。
4. 新しい position NFTs を mint。
5. 古い loan の unused Loan Initiation Fee rebate を settle。

新しい terms で HF が 1.5 を下回る場合は revert します。

---

## Preclose

このページは borrower 専用です — preclose は borrower が自分の
loan に対して開始します。

<a id="preclose.overview"></a>

### Preclose について

borrower-driven early termination です。2 つの paths:

- **Direct** — outstanding amount (principal + accrued interest) を
  wallet から支払い、collateral を release し、unused Loan
  Initiation Fee rebate を settle します。
- **Offset** — protocol の 4-DEX swap failover 経由で collateral
  の一部を principal asset に swap するため offset を initiate
  します。Offset を complete すると proceeds で repay し、残りの
  collateral はあなたに返ります。同じ rebate settlement です。

flat early-close penalty はありません。time-weighted VPFI math が
fairness を処理します。

<a id="preclose.position-summary"></a>

### あなたの現在のポジション

preclose する loan の snapshot です — outstanding principal、
accrued interest、現在の HF / LTV。Preclose flow は exit 時に
HF ≥ 1.5 を **要求しません** (これは closure であり、re-init では
ありません)。

<a id="preclose.in-progress"></a>

### Offset In Progress

status: offset initiated、swap が実行中 (または quote は consumed
されたが final settle が pending) です。2 つの exits:

- **Offset を完了** — realised proceeds で loan を settle し、残り
  を返します。
- **Offset を cancel** — abort します。collateral は locked のまま、
  loan は unchanged です。initiate と complete の間に swap が不利に
  動いた場合に使います。

<a id="preclose.choose-path"></a>

### 経路を選ぶ

Direct path は principal asset の wallet liquidity を使います。
Offset path は DEX swap 経由で collateral を使います。principal
asset が手元にない場合、または collateral position からも exit
したい場合に向いています。Offset slippage は liquidation と同じ
4-DEX failover によって bound されます (0x → 1inch → Uniswap V3 →
Balancer V2)。

---

## Early Withdrawal (Lender)

このページは lender 専用です — early withdrawal は lender が自分の
loan に対して開始します。

<a id="early-withdrawal.overview"></a>

### Lender Early Exit について

Lender positions のための secondary-market mechanism です。選んだ
price で position NFT を sale listing します。acceptance 時に buyer
が payment し、lender NFT ownership が buyer に transfer され、
buyer が future settlements (terminal claim など) すべての lender
of record になります。あなたは sale proceeds を受け取って exit
します。

Liquidations は user-only のままで、sale を通じて delegate され
ません — transfer されるのは claim する権利だけです。

<a id="early-withdrawal.position-summary"></a>

### あなたの現在のポジション

snapshot です — outstanding principal、accrued interest、残り時間、
borrower side の現在の HF / LTV。これらが buyer market の期待する
fair price を決めます: buyer の payoff は terminal 時の
principal plus interest であり、残り時間にわたる liquidation risk
を差し引いて見積もられます。

<a id="early-withdrawal.initiate-sale"></a>

### 販売を開始する

あなたの asking price で、protocol 経由で position NFT を sale
listing します。buyer が sale を complete します。sale fill 前なら
cancel できます。"complete loan sale" permission を持つ keeper に
delegate することもできます。ただし initiate step 自体は user-only
のままです。

---

<!-- ────────────────────────────────────────────────────────────── -->
<!-- T-086 #374 — TRANSLATION NEEDED                                -->
<!--                                                                -->
<!--   The three sections below are appended in ENGLISH as the      -->
<!--   translator source. Each block is anchored with a stable      -->
<!--   in-app HTML id (load-bearing for dapp cross-links — DO NOT   -->
<!--   change the anchor strings).                                  -->
<!--                                                                -->
<!--   Native Japanese reviewer: please translate each block     -->
<!--   into Japanese AND move it into the appropriate position   -->
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


