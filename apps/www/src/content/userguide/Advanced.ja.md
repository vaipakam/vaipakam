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

### あなたのアクティブなオファー

あなたが作成したオープンなオファー(ステータス Active、有効期限
未到達)。受諾前であればいつでもキャンセル可能 — キャンセル
コールは無料です。受諾するとオファーが Accepted に変わり、ローン
初期化がトリガーされ、2つのポジション NFT(レンダー用と
ボロワー用)がミントされ、ローンが Active 状態でオープンします。

クローズドオファーはいくつかの異なるステータスのうちの 1 つを
保持します。一部はすでに My Offers ページのフィルタチップとして
公開されています。他は インデクサー 側のターミナルで、後続作業で
専用 UI 処理を受けます:

- **Filled** — カウンターパーティが受諾;オファーのローン参照は
  結果ローン id です。
- **Cancelled** — オファーは 2 つの経路のいずれかで Cancelled
  状態に到達: 受諾前にクリエイターが取り下げ、または
  `LibVaipakam.isOfferExpired(offer)` が true になった時点で
  `OfferCancelFacet.cancelOffer` 経由でパーミッションレスに
  クリーンアップ(誰がキャンセルコールを開始したかに関わらず
  返金はクリエイターにルーティングされます)。
- **Sold** — オファーが borrow-OR-sell の並行販売フローに
  オプトインされ(オファー作成 → 任意売却を許可 を参照)、
  レンダーが受諾する前にマーケットプレイス購入者が NFT 担保
  リスティングを fill しました。オファーはオンチェーンステータス
  `consumed_by_sale` を持ち;行のレートカラムはオファーが
  ポストされたレートを示し、担保セルは NFT 形状(ERC-721 の
  トークン id、ERC-1155 のコピー数)をレンダリングします。
  アプリ は Activity フィードにも行を `Offer sold via OpenSea`
  としてボロワー(オファー作成者)向けに公開します。オンチェーン
  イベント自体は
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  オファー id と executor アドレスの両方がオンチェーンで
  インデックスされていますが、ボロワー / 作成者アドレスは
  インデックスされていません。Activity フィードのための
  ボロワーのウォレットマッチは ingestion 時に インデクサー によって
  追加されます(オファー行を join して作成者を look up します)、
  したがって per-ウォレット フィルタはイベント自体が彼らをインデックス
  することなくボロワーを見つけます。
- **Fully Filled (インデクサー 状態、チップはまだなし)** — Range
  オーダーのみ。パーシャルフィルマッチングがオファーの残予算を
  消費するとき(最後のマッチが範囲を完全に fill する、または
  パーシャルマッチが sub-dust の残余を残す)、`OfferMatchFacet`
  が `OfferClosed(FullyFilled | Dust)` を emit し、インデクサー が
  オファー行に `status = 'fullyFilled'` をスタンプします。
  コントラクトの `accepted` 状態と上記のオンチェーン Filled
  ラベルは direct-accept ターミナル用に予約されているため、
  `fullyFilled` は インデクサー 側で区別されます。アプリ の
  `MyOfferStatus` はまだこのターミナルを独自のフィルタチップ
  として公開していません — `useMyOffers` は現在
  `fullyFilled` インデクサー ステータスの行を無視します — したがって
  fully-filled な range オファーは専用チップが land するまで
  実質的に My Offers ビューから完全に外れます。チップサーフェスは
  別の UI フォローアップとしてキューに入っています。

ターミナルイベントに到達したことのない過去 GTT(GTT 有効期限)
オファーはまだ アプリ で個別のステータスチップとして公開されて
いません;現在 インデクサー がターミナルを記録するまで Active の下
に分類されます。専用 Expired チップは別の UI フォローアップ
としてキューに入っています。


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

<a id="create-offer.borrow-or-sell"></a>

### この NFT の OpenSea でのオプション販売を許可(NFT 担保のボロワーオファーのみ)

**ERC-721 または ERC-1155 担保** と **ERC-20 元本** で
**ボロワーオファー** をポストする場合、アプリ は担保セクションの
下に `Borrow or sell` オプトインを公開します。これをチェック
すると、オファーは OpenSea でのあなたの NFT 担保の並行販売
リスティングの対象としてマークされます — 一つのオファーが
レンダー(あなたはローンを取る)またはマーケットプレイス購入者
(あなたは NFT を売る)のいずれかによって fill できます。
リスティングがすでにポストされている場合、レンダー受諾時に
リスティングは取り外されません: レンダーが最初に fill すると、
あなたはローンを取り、既存の OpenSea リスティングはローン
初期化を通じて元の Seaport 有効期限まで持ち越され、その期限
前の後のマーケットプレイス fill が diamond の決済ウォーター
フォールをトリガーして販売収益からローンをクローズします
(下の Scenario B を参照)。通常の GTT オファーの場合、この
有効期限はオファーの元の GTT 有効期限 です;レンダー受諾は
リスティングをローン全期間に対して延長または repost しません。
マーケットプレイス購入者が最初に fill すると、ローンは決して
作成されません(Scenario A)。2 つのシナリオは異なるオファー
状態で終了します: Scenario A は `markOfferConsumedBySale`
経由でオファーを `consumed_by_sale` でマーク(Sold フィルタの
下に表示)し、レンダー受諾はすでにマークされたオファーに対して
ゲートされます。Scenario B ではマーケットプレイス fill が
land する時点でオファーはすでに `Accepted` 状態です;
コントラクトは意図的にオファーステータスを `Accepted` のままに
し、販売からローンのみを決済します — オファーは Sold に 2 回目の
遷移をしません。

**二段階の性質。** オファー作成時のオプトインはオファーに
適格性フラグを設定するだけです。OpenSea で実際に購入可能な
リスティングを取得することは、アプリ が今日自動化していない
別の二部ステップです:

1. **diamond に record + wire。**
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` をオファーがまだアクティブで、レンダーの受諾前に
   呼び出します。オファーが受諾、キャンセル、または販売で
   消費されると、このコールはターミナルとして revert します;
   オプトインをチェックするだけでは Scenario B に持ち越せる
   リスティングを作成するには不十分です。ask はプレローン
   フロアもカバーする必要があります: 元本 + ローン期間と猶予
   ウィンドウを通じた最悪ケースのオファー利息、その利息に対する
   トレジャリーカット、設定された安全バッファ、すべての fee-leg
   金額。フロア以下の ask はこのステップで revert します。
   `feeLegs` 引数はこのコールが OpenSea プロトコル料金とクリエイター
   ロイヤリティの義務を記録する唯一の場所です: diamond は各
   fee-leg 金額をセラー収益から差し引き、recipient + 絶対金額を
   Seaport の consideration 配列に追加します。fee-enforced
   コレクションで `feeLegs: []` を渡すと、OpenSea publish ステップ
   が拒否するオーダー形状(fee-recipient consideration アイテム
   が欠落)を生成し、直接の Seaport fill はコレクションが要求する
   ように料金を分割する代わりに全 ask をセラーにルーティング
   します。上級ユーザーはコレクションの OpenSea required-fee
   スケジュールを 取得 する必要があり(in-repo fee parser
   `apps/defi/src/lib/openseaFeeSchedule.ts` がリファレンス)、コール前に
   ask に対して導出された絶対金額を渡す必要があります。Facet は
   内部的にこれらの入力(プラス
   `CollateralListingExecutor.offerContext` に保持される値 —
   ボロワーボルトアドレス、元本アセット、担保フィールド、
   startTime、endTime)とボルトの現在の `Seaport.getCounter`
   から canonical な Seaport OrderComponents を構築し、
   `Seaport.getOrderHash` 経由で orderHash を導出し、それを返し、
   ボルトの ERC-1271 バインディングをそのハッシュに登録し、NFT
   担保に対する Seaport conduit 承認を付与します。emit される
   `PostParallelSaleListing` イベントは入力引数を公開します
   (`offerId`、ボロワー、orderHash、askPrice、executor /
   conduit データ、salt、fee legs);per-context フィールドは
   echo しないため、オフチェーンで OrderComponents を再構築するには
   下のステップ 2 で説明する追加の read が必要です。**重要:**
   この時点でオーダーはすでに Seaport 経由で FILLABLE です。
   コントラクトのイベントとそれらの read を監視する bot は
   OrderComponents を再構築し `Seaport.fulfillOrder` を直接
   呼び出すことができます — オンチェーン fill パスが機能する
   ために、リスティングが OpenSea のマーケットプレイス UI に
   表示される必要はありません。ステップ 2 が land する前に
   カウンターパーティが現在の ask で fill することを望まない場合、
   ステップ 1 の直後にステップ 2 を実行するか、意図しない fill の
   前に `releaseParallelSaleLock` を呼び出してバインディングを
   無効化します。
2. **OpenSea で publish。** facet が構築したのと同じ
   OrderComponents を再構築します。`PostParallelSaleListing`
   イベント単独では不十分です: それは `offerId`、ボロワー、
   orderHash、askPrice、executor / conduit データ、salt、
   fee legs を emit しますが、offer-keyed なオーダー形状は
   executor の `OfferContext` ストレージに保持される値
   (ボロワーボルトアドレス、元本アセット、担保フィールド、
   startTime、endTime)プラスボロワーボルトの Seaport カウンタ
   (offerer のカウンタ — `LibPrepayOrder.buildAndHashOfferMem`
   は `Seaport.getCounter(ctx.borrowerVault)` をハッシュ化、
   入札者 のカウンタではない)も必要です。これは
   `LibPrepayOrder.buildAndHashOfferMem` の offer-order パスが
   使用するのと同じコンテキストで、loan-keyed の prepay-listing
   オーダー形状とは異なります。ポストする前に両方を読み取ります:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     はそのハッシュの永続化された `OfferContext` 構造体を返します。
   - `Seaport.getCounter(borrowerVault)` はボルト offerer の
     canonical な Seaport カウンタを返します。
   これらのフィールドを手にすれば OrderComponents 構造体は
   diamond がハッシュ化したのとまったく同じものを再現します。
   POST する前に、API 専用フィールド
   `parameters.totalOriginalConsiderationItems` を追加します
   — OpenSea の API はそれを要求しますが、canonical ハッシュを
   生成する Seaport 構造体の一部ではありません;in-repo
   パブリッシャー(`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`)はエンドポイント呼び出し
   前にこれを inject します。ERC-1271 検証されたオーダーの場合、
   OpenSea は `signature` フィールドを `0x`(空バイト)として
   受け入れます — ボルトのオンチェーン
   `isValidSignature(orderHash, '')` コールバックは signature
   バイトを無視し、diamond が以前に登録した任意の orderHash
   (ステップ 1 から)に対して EIP-1271 マジックバリューを返します。
   JSON を OpenSea listings エンドポイント(`POST
   /api/v2/orders/{chain}/{protocol}/listings`、公式
   [Create Listing](https://docs.opensea.io/reference/post_listing)
   ドキュメントに従って — これは Vaipakam 独自のパブリッシャー
   `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` が使用するのと同じ
   エンドポイント)に POST します。このステップの後にのみ
   リスティングが OpenSea のマーケットプレイス UI に表示され、
   カジュアルな購入者に見つけられるようになります。Vaipakam は
   現在 parallel-sale パスのためのこの送信を自動化していません
   — リスティング publish のエンドツーエンド表面化はフォロー
   アップとして追跡されています。

今日マニュアルパスに従う上級ユーザーは OpenSea の可視性を
得るために両方のステップが必要です;ステップ 1 だけを実行すると、
Seaport 経由で直接 fillable な(イベントからコンポーネントを
再構築する bot やカウンターパーティによって)が OpenSea
マーケットプレイス UI 上で不可視なオーダーが生成されます。

**Fill モードは All-or-Nothing に強制。** オプトインはオファーの
fill モードを自動的に `Aon` にピン留めします — parallel-sale
有効化された partial / IOC fill モードは単一のオファーの担保に
対して複数のローンを作成することになり、コントラクトはそれを
ゲートします。トグルはレンダーオファー、ERC-20 担保、NFT 元本、
およびコントラクトの `_validatePostParallelSale` が拒否する
他の形状では非表示なので、不適格なオファーで誤ってチェック
することはできません。

**購入者が見るもの。**

- *レンダーが受諾する前*(Scenario A): OpenSea リスティングを
  fill する購入者は listed price を支払います。fee-enforced
  コレクションでは、Seaport は OpenSea protocol-fee と
  creator-fee レッグを最初に設定された受信者に直接ルーティング
  します;executor は **net proceeds**(listed price からそれらの
  マーケットプレイス / creator fee レッグを引いたもの)のみを diamond に
  渡します。Diamond はその net 額をあなたのボルトでエスクロー
  し、NFT は購入者に転送され、オファーは `consumed_by_sale`
  でマークされます(My Offers、Activity、Offer Details で
  個別の "Sold" ステータスとして表示)。ローンは決して作成
  されませんでした;あなたは net 販売収益を保持します。
- *レンダーが受諾した後*(Scenario B): リスティングはローン
  初期化を通じて持ち越されます — ボロワー NFT ロックも
  リスティングも取り外されません。後の購入者 fill は diamond の
  決済ウォーターフォールを Seaport トランザクションで
  トリガーします。Scenario A と同じ fee-leg ノート: fee-enforced
  コレクションでは、Seaport は OpenSea protocol-fee と
  creator-fee レッグを最初に設定された受信者に直接ルーティング
  し、executor は **net proceeds**(販売価格から マーケットプレイス /
  creator fees を引いたもの)のみを diamond のウォーターフォール
  に渡します。ウォーターフォールはその net 額をルーティング
  します: レンダーは決済 entitlement を受け取り
  (`LibEntitlement.settlementInterest` がローンが
  `useFullTermInterest = true` で作成された場合はフルクーポン
  として計算し、それ以外の場合は決済タイムスタンプで発生した
  pro-rata 利息として計算 — ゲートはローンポリシーであり、
  販売がスケジュールされた満期の前か後かではない)、トレジャリー
  カットはトレジャリーに行き、残りは現在のボロワーポジション
  NFT 保持者のボルトに直接デポジットされます
  (`LibUserVault.getOrCreate` + ボルトデポジット経由)。
  Claim Center クレームは作成されません — 販売が land した後に
  ボルト残高を確認してください。

**組み合わせられないもの。** 2 つの異なる競合クラス、異なる
プロトコル段階で表面化されます:

- *publish 時ブロック(兄弟 loan-keyed リスティング)。* ローンに
  すでにオファー作成から持ち越された parallel-sale リスティング
  があり、ボロワーが同じローンで 2 番目の loan-keyed prepay
  リスティングをポストするために `NFTPrepayListingFacet.postPrepayListing`
  (または `updatePrepayListing`)を呼び出すと、diamond は
  `SiblingParallelSaleListingLive` で revert します。ボロワーの
  NFT に対する conduit 承認は単一スロットです — 両方のリスティング
  を同時に実行すると、曖昧な承認が作成されます。ボロワーは
  publish / update 呼び出しで revert を見ます;何も fill しません。
- *fill 時ブロック(open PrecloseFacet オフセット)。* ローンに
  open な PrecloseFacet オフセットオファーがあり、購入者が
  後で parallel-sale リスティングを fill しようとすると、
  diamond の `_settleLoanFromParallelSale` は
  `ParallelSaleBlockedByOpenOffsetOffer` で revert します。
  リスティングは OpenSea で有効なままですが、オフセットリンク
  がクリアされるまで fill 試行は revert します。アプリ は現在、
  Loan Details ページにこの組み合わせに対する専用バナー /
  通知を表面化していません;ユーザーは fills が revert するのを
  見て、診断のためにブロックエクスプローラで revert 理由を
  検査する必要があるかもしれません。クリーンアップパスは通常の
  offer-cancel サーフェスです — オフセットオファーをキャンセル
  するために `OfferCancelFacet.cancelOffer(offsetOfferId)` を
  呼び出します。これによりオフセットリンクが解放され、
  parallel-sale fill のブロックが解除されます(PrecloseFacet には
  個別のキャンセルエントリポイントがありません;オフセットは
  リンクされたオファーにバウンドされているため、リンクされた
  オファーをキャンセルするとクリアされます)。競合のための
  専用 UI サーフェスは別の UX フォローアップとしてキューに
  入っています。


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

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### prepay リスティング上の OpenSea オファーをマッチング

prepay リスティングが OpenSea のマーケットプレイスで稼働すると、
カジュアルな購入者があなたのトークンに直接 **item offers** を
配置することがあります — コレクション内の任意のトークンでは
なく、あなたの特定の担保に結びついた 入札。Vaipakam はこれらの
item offers を Loan Details ページにリアルタイムで表面化します
— "OpenSea に担保を出品" の下に、incoming offer ごとに 1
行の別パネルがあります。パネルは **buffer threshold** を適用
します — レンダーの決済 entitlement(これは元本プラス
フルクーポン(フルタームインタレストローン)または pro-rata
利息(それ以外)をすでに含む — 参照
`PrepayListingFacet.getPrepayContext().lenderLeg`)、プラス
トレジャリーカット、プラス安全バッファ — そして閾値を満たさない
オファーを **グレー表示** します。あらゆるレベルで市場の関心を
見ることができますが、プロトコルが実際に決済するオファーのみ
Match できます。

コレクション全体 / criteria オファー(コレクション内の任意の
トークンが履行できる 入札)は OpenSea に残りますが アプリ の
Match パネルには **表示されません** — プロトコルが決済する
multi-leg consideration は v1 にないコントラクト側の plumbing
なしでは criteria オファーに対して再構築できません。唯一の
inbound demand がコレクション全体の場合、今日の実用的なパスは
item-specific 入札 を待つか、リスティングを固定 ask に残し、
任意の購入者が直接履行するのを許可することです。コレクション
全体の 入札 を手動で自分で決済することはできません — 担保 NFT
は Vaipakam ボルトに存在し、Vaipakam 側の Seaport オーダーが
唯一認可された決済形態です。

OpenSea プロトコル料金や creator royalties を強制するコレクション
では、アプリ はオファーパネルをレンダリングします — OpenSea API
からの fee-schedule 取得 は advisory として扱われ;実際の
fulfillment data は MATCH CLICK TIME に 取得 されます。Match
パネルは fee-schedule 取得 ステータスに関係なくレンダリングし;
click-time の fulfillment-data 取得 がゲートです。その 取得 が
失敗した場合(rate limit、API ダウン、またはサポートされていない
コレクション形状)、アプリ 側の Match click ハンドラーは任意の
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` トランザクション
が構築される前に ABORT します — calldata なし、signature プロンプト
なし、revert なし。オンチェーン関数自体は `bool` を返すセレクター
ではありません;実行されると `bytes32` の orderHash を返すか
revert します。したがって fee-enforced コレクションのパネルは
ブラウズできるオファーを表示することがありますが、それらすべてが
特定の瞬間に clickable-to-match であるとは限りません。

許容可能なオファーを見つけて **オファーをマッチ** をクリックすると、
アプリ は **マッチを確認** モーダルを開きます。これは matched
value(gross OpenSea オファー額 — diamond が決済する net 額
ではない;fee-enforced コレクションでは
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` が lender /
treasury / borrower 分割を実行する前に `effectiveAsk =
offerValue - bidderFeeTotal` を計算するため、diamond が実際に
分配する net 額はモーダルのヘッドラインより小さい)を再表示し、
atomic-match フローの一般的な説明を提供します。確認後、アプリ は
入札者 のオファーを新たに構築された diamond 側のカウンター
オーダーと一緒に単一の Seaport `matchAdvancedOrders` 呼び出しに
バンドルする単一の `matchOpenSeaOffer` トランザクションを送信
します — 入札者 の履行、カウンターオーダーの listing-side
レッグ(以前の v1 prepay リスティングが稼働していたかどうかに
かかわらず;atomic パスは `existingHash == 0` をサポート)、
diamond の決済ウォーターフォールがすべて 1 つのブロックで
atomic に land します。トランザクションは完全に成功する(ローン
決済、NFT 転送、販売収益分割)か完全に revert する(何も動かない)
かのいずれかであり、リスティング rotation と決済の間にサード
パーティ購入者が matched price で介入できる **ウィンドウは
ありません**。

> **レースウィンドウなし — 構造上 atomic。** これは v1 の二段階
> "cancel + post" パターンの構造的なクローズアウトです: v1 の
> 下では アプリ はリスティングを別の `updatePrepayListing`
> トランザクションとして rotate し、rotate された価格を OpenSea
> 上で 入札者 の `fulfillOrder` が後のブロックで land するまで
> ライブのままにします — mempool を監視する誰でも 入札者 を
> 彼らが 入札 した価格から snipe できました。Atomic パスは両方の
> オーダーを単一の Seaport match 呼び出しにバインドすることで
> その穴を閉じます: 入札者 が合意された価格で fill するか、
> トランザクション全体が revert するかのいずれかです。

**Match をクリックする前にまだ確認したいこと:**

- **モーダルで マッチ値 を確認。** モーダルは gross OpenSea
  オファー額を表面化します。fee-enforced コレクションでは、
  diamond は 入札者 側の マーケットプレイス / creator fee レッグの後の
  net effective ask に対して決済するため、モーダル値は lender /
  treasury / borrower 分割に使用される額より大きい可能性が
  あります。入札者 アドレスと正確な分割はモーダルにも OpenSea
  Offers パネル行(行は value、payment token、offer 種類、
  truncated 入札者、end time を表示)にも分解されていません。
  分割は決済時に diamond によりオンチェーンで強制されます —
  プロトコルの決済バッファは effective ask が lender の決済
  entitlement(これは元本プラスフルクーポン(フルタームインタレスト
  ローン)または pro-rata 利息(それ以外)をすでに含む)プラス
  トレジャリーカットをカバーすることを保証するため、分割は
  常に少なくともあなたにとってニュートラルです。確認前に予測
  分割を見たい場合、diamond は
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  を callable ビューとして公開します — 与えられたタイムスタンプ
  で決済ウォーターフォールがルーティングする lender と treasury
  レッグを返し、残りはあなたのものです。
- **コレクションの OpenSea fee posture を確認。** コレクションが
  OpenSea プロトコル料金や creator royalties を強制する場合、
  atomic パスは アプリ がエージェントの OpenSea fulfillment-data
  プロキシ(PR #349)経由で MATCH CLICK TIME に 取得 する
  SignedZone `extraData` / criteria-resolver plumbing を必要と
  します。Match パネルは fee-schedule 取得 ステータスに関係
  なくレンダリングし;click-time の fulfillment-data 取得 が
  ゲートです。その 取得 が失敗した場合(rate limit、API ダウン、
  サポートされていないコレクション形状)、アプリ 側の click
  ハンドラーはオンチェーン `matchOpenSeaOffer` トランザクション
  を構築する前に abort します — calldata は構築されず、
  signature プロンプトは発火せず、バナーは事前に表示されません。
  click を後で再試行するか(取得 は一時的な API blip だった
  可能性があります)、その間に OpenSea で listed ask で直接
  リスティングを履行することができます。


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
