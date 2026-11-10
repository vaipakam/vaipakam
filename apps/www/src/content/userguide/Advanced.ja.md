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

<a id="chapter.dashboard"></a>

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

wallet-level の opt-in flag で、保有する VPFI を手数料の割引に変えます。
**借り手として**は、割引は Loan Initiation Fee そのものの直接的な減額で、
loan の accept 時に lending asset で課されます。そのために vault から
引き落とされるものはありません。**貸し手として**は、イールド割引は
settlement 時に適用され、VPFI の価格参照が設定されていれば vault から
VPFI で決済することもでき、その場合は貸出資産の手数料を全額保持できます。default: off。off は fee の 100% を principal
asset で支払うという意味です。on の場合は time-weighted discount
が適用されます。

Tier ladder:

| Tier | Min vault VPFI                         | Discount                          |
| ---- | --------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`                | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`                | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`                | `{liveValue:tier4DiscountBps}`%   |

Tier は、VPFI を deposit または withdraw した瞬間の **post-change**
vault balance に対して calculate されます。実際に charge される rate
は settlement 時点のあなたの tier から決まり、各 loan 固有の期間に
ついて別途 average を取ることはありません。守りになっているのは tier
そのものです。最長 30 日の直近 window — protocol の設定で、現在の
holding が始まった日から数え、直近の日ほど重く扱われます — における
日次 balance の time-weighted average を取り、その average をさらに、
その holding が始まって以降に一度でも下がった最も低い tier まで
引き下げます。こちらは最大 30 日さかのぼります。

**この二つの遡り方は別物で、たいてい後者のほうが長くなります。**
averaging window は設定可能で 30 日より短くもできますが、最も低い
tier の遡りはそれに連動せず、現在の holding 全体（上限 30 日）に
及びます。したがって averaging window を 14 日にしても、20 日前の
下落は average の外にありながら依然として tier を押し下げます。

ゼロより大きい balance を **連続して** 最低日数だけ hold するまで、
tier はまったくのゼロです。これも protocol の設定です。この日数は
balance がゼロから正に変わったときに始まり、再びゼロに戻ったときだけ
数え直しになります。既存の holding に積み増しても reset されません。

そのため withdraw は、あなたの open loans すべてに即座に効きます —
古い (高い) tier が残る grace window はありません。これにより、loan
終了直前に VPFI を top up して full-tier discount を取り、数秒後に
withdraw する exploit pattern を防ぎます。どの rule が防いでいるかに
注意してください。長く hold している人は最低保有期間をすでに満たして
いるので、仕事をしているのは最も低い tier の rule です。average には
それができません。average は遅い top up で引き上げられますが、最小値
は引き上げられないからです。

その特定の pattern に対しては、現在の rule のほうが強力です。ただし
**あらゆる面で** 厳しいわけではありません。最も低い tier の遡りは
最大 30 日までなので、長い loan の初期の低 tier 期間はやがて履歴から
外れます。loan 全体にわたる average ならそれを保持していました。今回
の変更は短時間の top up への防御を強め、記憶を短くしたのです。

**これは lender yield fee についての説明です。** 借り手の開始手数料の
レートは loan の accept 時に一度だけ読み取られ、その後は withdraw も
top up もそれを動かしません。

discount は settlement 時の lender yield fee と borrower の
Loan Initiation Fee に適用されます。後者では、**lending asset で
支払う手数料そのものの直接的な減額**として、loan の accept 時に
適用されます。その手数料の支払いのために vault から VPFI が
引き落とされることはなく、後から claim できる rebate もありません。

> **Loan Initiation Fee の rebate を待っている場合は、ここを
> 読んでください。** 以前のモデルでは、全額を VPFI で前払いし、
> loan の存続期間中それを保管し、claim 時に一部を返していました。
> **この経路は削除されました。** この経路で開かれた loan は一つも
> ないため、initiation fee に対して VPFI が保管されている loan は
> なく、未受取の rebate もありません。待っても、届きようのない
> お金を待つことになります。

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

connected wallet の VPFI rewards 全体像を 1 つの view にまとめる
summary card です。headline figure は、pending interaction rewards
と lifetime-claimed interaction rewards の合計です。

breakdown row には pending + claimed が表示され、native page 上の
full claim card へ chevron deep-link します:

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
で card を非表示にすると、新しい users は Claim Center に入るまで
rewards program に気づけません。

---

<a id="chapter.offer-book"></a>

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
に対する `{liveValue:treasuryFeeBps}`% treasury cut は terminal settlement 時に debit され、
upfront ではありません。
この rate は loan の作成時に固定されるため、後から protocol fee が変更されても、すでに開いている loan は開始時の rate のままです。

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

<a id="chapter.create-offer"></a>

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
  Recovery は slippage と interest に対する `{liveValue:treasuryFeeBps}`% treasury cut を
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
  全体を lender に transfer します。residual claim はまったく
  ありません。

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
   `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** がリファレンス)、コール前に
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
   fee-enforced コレクションの場合、このステップを呼び出す前に
   コレクションの必須 OpenSea / クリエイター料金スケジュールから
   `feeLegs` を populate します。必須、非ゼロの料金行のみを使用
   します;リストをプロトコルがサポートする fee-leg 数に制限
   します;各行を選択した ask 価格で元本アセットの絶対固定額に
   変換します;リストされた料金受信者を leg 受信者として使用
   します。選択した ask で必須料金がゼロに丸められる場合、ask は
   そのコレクションには小さすぎ、post を試みるべきではありません。
   空の配列を渡すことは fee-free コレクションでのみ有効です。
   fee-enforced コレクションでは、OpenSea パブリケーションに
   失敗するか、マーケットプレイスの必須 consideration 形状を
   満たせない注文を生成する可能性があります。
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
   パブリッシャー(`apps/indexer/src/openseaPublish.ts`)はエンドポイント呼び出し
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
  に渡します。販売は担保で賄われる返済なので、diamond はその net 額を、fill の
  時点での返済とまったく同じように決済します: ローンは返済済みになり;
  レンダーの受取分(ローンが `useFullTermInterest = true` で作成
  された場合はフルクーポン、それ以外はその時点までの発生利息、
  それにレンダーの yield-fee 割引があればその分)はレンダーのボルトに
  置かれ、通常のレンダー claim を通じて現在のレンダーポジション
  保有者に支払われ;トレジャリーはその割引を差し引いたカットを
  受け取り;残りは現在のボロワーポジション保有者のウォレットに
  送られます。残りをそのウォレットに支払えない場合、残りは保留され、
  Claim Center の通常のボロワー claim を通じて支払われます。レンダー
  は販売の中で支払われることはないため、レンダーのウォレットに関する
  何ものも販売を止められません。

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


<a id="chapter.claim-center"></a>

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
- accrued interest から、loan 作成時に固定された treasury cut
  (現在のレートで作成された loan は `{liveValue:treasuryFeeBps}`%)
  を差し引いた額。同意が on の場合、その cut 自体があなたの
  time-weighted VPFI fee-discount accumulator によってさらに減ります。

loan が terminal state (Settled、Defaulted、Liquidated) に達すると
すぐに claimable になります。Lender position NFT は同じ transaction
で burn されます。

<a id="claim-center.claims:borrower"></a>

#### あなたが borrower の場合

Borrower claim は、loan がどう settle されたかによって次を返し
ます:

- **full repayment / preclose / refinance** — あなたの collateral
  basket。Loan Initiation Fee の rebate は付きません。割引は
  acceptance の時点ですでに手数料から差し引かれています。
- **loan を決済する prepay sale** — collateral は買い手に渡り、
  あなたには戻りません。受け取るのは、売却価格から lender の取り分、
  treasury の控除、listing に付いていた seller fee を差し引いた額で、
  borrower position NFT の保有者に支払われます。
- **swap-to-repay** — collateral は債務を賄うために、あなたが定めた
  上限まで売られます。上限を緩く設定すると、債務が厳密に必要とした
  以上に消費されることがあります。消費されなかった分は戻ります。
  loan 自体の asset の余剰は通常、claim として待つのではなく borrower
  NFT 保有者へ直接支払われます — ただしその保有者が制裁による凍結の
  対象である場合は、claim として留め置かれます。
- **HF-liquidation または default** — それでも確認してください。surplus が
  残っている場合があります。liquidator・lender・treasury を
  まかなうぶんの価値だけが取られ、残りがあなたの claim として記録
  されます。その形は一点で決まります。collateral が
  売られたのか、引き渡されたのか。売られた場合 — つまり取引所を
  通して外に出された場合 — 残余は loan の principal asset で
  届きます。引き渡された場合、残るのは collateral そのもので、
  vault に encumbered のままです。引き渡す経路は複数あり、いずれも loan の終わり方には依存しません: liquidator が割引で直接引き取る場合、
  close-out が取引所に出されず内部で反対側の position とマッチした場合、そして売却そのものが成立しなかった場合です — そのときは collateral が来ます。claim 時に lender が通る見積もりを持ち込まないかぎりで、持ち込めば loan の
  asset で支払われます。大半の claim は見積もりを持ち込みません。通常の liquidation も時間ベースの
  default も、取引所に向かう前にその内部マッチを試みます。つまりこの二つの経路は結果が一定ではないということで、だからこそ経路ではなく
  claim を読むべきなのです。割引での引き取りはむしろ確定していますが、向きが逆です: 売りもマッチもしないので、残るのは常に
  collateral です。部分 liquidation はそもそも close-out
  ではありません — loan は開いたままで、claim は作られません。
  どちらかを推測せず、claim を確認してください。Illiquid asset の default ではバスケット全体が失われ何も
  残りません。この経路ではそれがルールであり、結果ではありません。

Borrower position NFT が burn されるのは claim したときであって、loan が
解決したときではありません。liquidation が残した surplus は、あとからでも
受け取れます。ただし NFT が残っていること自体は surplus の証拠ではありません。
liquidation が何も残さなかった場合、受け取るものはなく、claim は拒否され、
それでも NFT は残りうる、ということです。NFT ではなく claim を読んでください。

---

<a id="chapter.activity"></a>

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain 上であなたの wallet に関わる on-chain events です。
protocol logs から sliding block window で live sourced されます。
backend cache はありません — page load ごとに再取得します。
events は transaction hash ごとに group されるため、multi-event
transactions (例: accept + initiate が同じ block 内) はまとまって
表示されます。新しい順です。offers、loans、repayments、claims、
liquidations、NFT mints / burns、VPFI vault deposits / withdrawals
を表示します。

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI を入手する

VPFI は自由に transfer できます。VPFI が取引されている open market
で入手するか、bridge で持ち込んでください: VPFI は Chainlink CCIP
cross-chain token なので、official bridge を使って supported chains
間を移動し、あなたが bridge した chain の wallet に land します。

<a id="buy-vpfi.discount-status"></a>

### あなたの VPFI Discount Status

Live status:

- 現在の tier (0 から 4)。
- Vault VPFI 残高と次の tier までの差分。
- 現在の tier における割引パーセンテージ。
- wallet-level consent flag。

vault VPFI は deposit されている限り discount tier の判定に count
されます — 別の "deposit" action はありません。

<a id="buy-vpfi.deposit"></a>

### VPFI を vault に入金する

wallet から同じ chain 上のあなたの vault へ移す explicit な
deposit step です。すべての chains で必要です — canonical でも —
vault deposit spec では常に explicit user action だからです。
Permit2 が configured されている chains では、app は classic
approve + deposit pattern より single-signature path を prefer
します。その chain で Permit2 が configured されていない場合は、
cleanly fall back します。

<a id="buy-vpfi.unstake"></a>

### vault から VPFI を引き出しする

VPFI を vault から wallet に戻します。approval leg はありません
— protocol が vault owner であり、自身を debit します。withdraw
は新しい (低い) balance で fee-discount rate を即座に re-stamp
し、あなたの open loans すべてに適用されます。古い tier がまだ
apply される grace window はありません。

<a id="buy-vpfi.cross-chain-tier"></a>

### VPFI tier がチェーン間をどう伝わるか

VPFI は canonical チェーンである Base 上の vault に保有し、tier を
計算するのは Base です。別のチェーンで借りたり貸したりすると、その
チェーンは tier のコピーを適用します。このコピーは、tier を変える
入金・出金・その他の操作のたびに、Base が Chainlink CCIP で送ります。

知っておくべき点は 3 つです。

- **時間の経過だけで上がった tier は、Base での操作がないと伝わり
  ません。** 入金も出金もないまま保有期間を満たしたり平均が追い
  ついたりすると、Base 上の値はすぐに最新になります。他のチェーンが
  それを知るのは、Base での次の入金または出金（金額は問いません）の
  ときです。
- **下がった tier が先に伝わります。** プロトコルは下がった tier を
  すぐに送り、上がった tier の費用はチェーンごとに 1 日 1 回までしか
  負担しません。その後の CCIP での配送には通常数分かかります。届く
  までは、そのチェーンは以前の tier を適用し続けます。
- **コピーは期限切れになることがあります。** 新しいコピーがないまま
  60 日（default）が過ぎるか、tier 表の変更がそのチェーンに届くと、
  古いコピーではそのチェーンで割引が受けられなくなります。新しい
  コピーは tier が変わったときにしか送られません。

利用するチェーンだけでなく Base でも必要な割引スイッチを含め、詳しい
ルールは下の「VPFI 割引の仕組み」の章にあります。配送の設計は
[tier 配送の設計文書](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
（英語）にあります。

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards について

**Interaction pool** は、fixed daily emission の per-day pro-rata
share を支払います。その日の loan volume に対するあなたの
settled-interest contribution で weighted されます。Daily windows
は window close 後の最初の claim または settlement で lazily
finalise されます。

rewards は active chain 上で直接 mint されます — user 側の
cross-chain round-trip はありません。Cross-chain reward aggregation
は protocol contracts 間でのみ行われます。

<a id="rewards.claim"></a>

### Rewards を Claim する

1 transaction で accrued した rewards を claim します。Interaction
rewards は、該当する daily window が finalise されるまで zero です
(その chain 上の次の non-zero claim または settlement で trigger
される lazy finalisation)。window がまだ finalise 中のときは UI が
button を guard し、users が under-claim しないようにします。

<a id="rewards.withdraw-staked"></a>

### vault から VPFI を引き出す

VPFI セクションの "vault から VPFI を引き出しする" と同じ
interface です — vault から wallet に VPFI を戻します。withdraw
された VPFI は discount accumulator から即座に外れます (各 open
loan で post-balance re-stamp)。

---

<a id="chapter.loan-details"></a>

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
collateral 全体が lender に transfer され、claim できるものはありません。

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
  から、loan 作成時に固定された treasury cut (現在のレートで
  作成された loan は `{liveValue:treasuryFeeBps}`%) を差し引いて
  返します (consent on の場合は time-weighted VPFI yield-fee
  discount でさらに減ります)。
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
  を trigger します。
- **Preclose direct** — outstanding amount を今すぐ wallet から
  支払い、collateral を release します。
- **Preclose offset** — protocol の swap router 経由で collateral
  の一部を売り、proceeds で repay し、残りを返します。2-step:
  initiate、その後 complete。
- **Refinance** — 新しい terms で borrower offer を投稿します。
  lender が accept したら、complete refinance により loans が
  atomically に swap されます。collateral は vault から出ません。
- **Borrower として claim** — terminal state のみ。full repayment では
  collateral を返します。default / liquidation でも surplus が
  残ることがあります。collateral は債務とその清算費用に必要なぶんだけが
  取られるためです — 上の Claim Center の節を参照してください。
  Borrower position NFT を burn します。

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
を返済済みとしてクローズ、NFT 転送、販売収益分割)か完全に revert する(何も動かない)
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
  クリックを後で再試行するか(取得 は一時的な API blip だった
  可能性があります)、その間に OpenSea で listed ask で直接
  リスティングを履行することができます。

---

<a id="chapter.how-liquidation-actually-works"></a>

## 清算の仕組み

オファー時に同意したリスク開示は、最悪の結果を2つの文で表現しています。このセクションでは、その背後にあるメカニズムについて説明します。これは、なぜ現物（in-kind）フォールバックが存在するのか、あるいはローンが実際に4つの分岐のうちどれを辿るのかを理解するのに役立ちます。

分割を決定するコントラクト関数は `LibFallback.computeFallbackEntitlements` です。これは4つのケースを順番に確認し、最初に一致したものが実行されます。

<a id="liquidation-mechanics.case-1"></a>

### ケース 1 — オラクルが利用可能で、担保価値 ≥ 債務額

正常なパス。Chainlinkの価格フィードが応答しており、ソフト2-of-Nのセカンダリクォーラム（Tellor + API3 + DIA）が不一致を起こしておらず、差し押さえられた担保がオラクル価格で債務をカバーしている場合。

何が起こるか:

- レンダーは、オラクル価格で（元本 + 経過利息 + 3%のフォールバックボーナス）に相当する**担保アセット**を受け取ります。実質的に、レンダーは貸付アセットではなく担保アセットで、適正価格で全額支払いを受けます。
- トレジャリーは、元本の2%のプレミアムを担保アセットで受け取ります。
- ボロワーは、担保の**残額**を返却されます。これは実質的な払い戻しであり、レンダーの請求をカバーするために必要なかった過剰担保分です。

具体例: 0.6 WETH（担保 $3,000、債務 $1,000）に対する 1,000 USDC のローン。オラクルが ETH 価格を $5,000 / WETH と評価。債務 + 利息 + ボーナス = $1,050。レンダーは 0.21 WETH（$1,050 相当）、トレジャリーは 0.004 WETH（2% プレミアムの $20 相当）、ボロワーは残りの約 0.386 WETH を受け取ります。

<a id="liquidation-mechanics.case-2"></a>

### ケース 2 — オラクルが利用可能で、担保価値 < 債務額

アンダーウォーター（債務超過）パス。オラクルは機能していますが、差し押さえられた担保の価値がオラクル価格でも債務額を下回っている場合。ボラティリティの高い資産が暴落し、HFが反応するよりも早く担保価値が下落した場合によく起こります。

何が起こるか:

- レンダーは、差し押さえられた担保の**すべて**を担保アセットで受け取ります。
- トレジャリーは何も受け取りません。
- ボロワーは何も受け取りません。返却される残額がないためです。

レンダーが不足分を吸収します。ボロワー、プロトコル、または第三者に対してそれ以上の請求権は存在しません。これは、リスク開示の「回収額が貸し付けたアセットを下回る可能性がある」という一文が具体的に警告しているケースです。

具体例: 同じ 1,000 USDC / 0.6 WETH のローンで、ETH が $1,500 / WETH まで暴落。担保は $900、債務は $1,050。レンダーは 0.6 WETH すべて（$900 相当）を受け取り、トレジャリーは 0、ボロワーは 0。

<a id="liquidation-mechanics.case-3"></a>

### ケース 3 — オラクルのクォーラムが利用不能（UNAVAILABLE）

ダーククォーラムパス。Chainlinkのデータが古くなり（stale）、かつ2-of-Nのセカンダリクォーラムも合意できない場合（すべてのセカンダリがオフラインか、プライマリと一致しない場合）。プロトコルはローンのどちら側に対しても信頼できる価格を持っていないため、公正な分割を計算できません。

何が起こるか:

- レンダーは、差し押さえられた担保の**すべて**を担保アセットで受け取ります。**計算上の価値に関係なく**実行されます（計算結果が信頼できないため）。
- トレジャリーは何も受け取りません。
- ボロワーは何も受け取りません。

支払いはケース 2 と同じですが、理由は根本的に異なります。プロトコルが「担保価値が債務より低い」と判断しているのではなく、「ここではいかなる数値も信頼できない。したがって、レンダーが差し押さえられたバスケット全体を受け取り、それが市場でいくらになるかはレンダーが引き受ける」と判断しています。

監査人が事後分析で2つのパスを区別できるように、別のオンチェーンイベント（`LiquidationFallbackOracleUnavailable`）が発行されます。

<a id="liquidation-mechanics.case-4"></a>

### ケース 4 — いずれかの側に非流動的（Illiquid）資産がある

非流動的資産パス。貸付アセット、担保アセット、またはその両方が、プロトコルの分類器で Liquid（流動的）とみなされない場合（Chainlinkフィードがない、または出来高しきい値を超える Uniswap V3 型の集中流動性プールがない場合）。NFT担保やロングテールのトークンで一般的です。

デフォルト時に何が起こるか:

- レンダーは、市場価値に関係なく**担保の全額**を現物で受け取ります。
- 「債務額」と「残額」の区分はありません。オラクル価格が適用できないためです。
- アセットの価値は、債務額より大幅に高い場合も低い場合もあります。再販可能性についての保証はありません。

双方がオファー作成時にこれに同意しています。リスク開示の非流動的資産条項がまさにこのケースをカバーしています。双方が意図的に非流動的資産を含むローンを選択しない限り、この分岐に達することはありません。

<a id="liquidation-mechanics.why-in-kind"></a>

### なぜキャッシュではなく現物（in-kind）なのか？

プロトコルが常に貸付アセットにスワップするのではなく、担保アセットの単位で支払う理由は3つあります。

- **シクエンサー / DEXの障害**: プロトコルが安全にスワップを実行できない場合（スリッページ > 6%、流動性の欠如、DEXの revert、シクエンサーのダウン）、最も安全な行動は、すでに持っているもの（差し押さえられた担保）を直接届けることです。いかなる犠牲を払ってもスワップを強制すると、損失が確定してしまいます。
- **ブラックスワン事象**: ボラティリティの連鎖の中では、オラクルが利用可能なパスが数分で消滅することがあります。現物フォールバックを事前に用意しておくことで、すべての価格ソースが劣化した状態でもプロトコルの機能を維持できます。
- **カウンターパーティペアによる回収**: クレム時にレンダー（またはそのキーパーbot）は、4つのDEX failoverを介して2度目のリトライチャンスを得られます。その時までに状況が正常化していれば、清算時と同じルーティングインフラを使用して、現物担保を貸付アセットに売却できます。

<a id="liquidation-mechanics.claim-time-retry"></a>

### クレム時のリトライ

`ClaimFacet.claimAsLenderWithRetry` を使用すると、ローンが `FallbackPending` 状態にあるとき、レンダー（またはレンダーのNFTに代わって行動するキーパー）はスワップアダプターの呼び出しリスト（0x → 1inch → Uniswap V3 → Balancer V2）を優先順位付きで提供し、リトライできます。ライブラリはリストを反復し、最初に成功した時点でコミットし、レンダーとボロワーのクレムを元本アセットの収益に書き換えます。

完全に失敗した場合、記録された担保の分割はそのまま維持され、ローンは最終的に Defaulted 状態に移行します。この時点で、レンダーは現物担保を受け取り、外部の場所を通じて自由に売却できます。

<a id="liquidation-mechanics.internal-match-rescue"></a>

### クレム前の内部マッチング救済

外部スワップが実行される前（HF清算時、時間ベースのデフォルト時、およびクレム時）に、プロトコルはまず、DEXを介さずにこのローンを決済できる**反対方向のローン**が存在するかどうかを確認します。

ローンAがWETHを売ってUSDCを得る必要があり、ローンBがUSDCを売ってWETHを得る必要がある場合、この2つを直接マッチングできます。Aの担保がBの債務をカバーし、その逆も同様です。価格はプロトコルのオラクルに基づきます。アグリゲーターもスリッページもスワップ手数料もありません。ボロワーはより多くの担保を保持でき、レンダーはオラクル価格で全額支払いを受けられます。

この内部マッチングパスは自動的に実行されます。

- **HF清算時**: キーパーが清算を呼び出したとき、反対方向のカウンターパーティが存在すれば、プロトコルはスワップせずに内部で決済します。キーパーは依然としてマッチングインセンティブを獲得します。
- **時間ベースのデフォルト時**: デフォルトスワップの前に同様のチェックが行われます。
- **クレム時**: レンダーが `FallbackPending` でスタックしたローンをクレムするとき、プロトコルは反対方向のカウンターパーティを再チェックします。これは真の「二度目のチャンス」です。マッチング可能なローンのプールは継続的に拡大しているため、清算が最初に失敗したときには存在しなかったカウンターパーティが、クレム時までには存在する可能性があります。

清算時のスワップが一時的な理由（スリッページの一時的な急騰、DEXの revert、古いオラクルティック）で失敗し、`FallbackPending` に入ったローンは、救済の第一候補です。基礎となる担保は通常、依然として完全に流動的であり、反対方向のローンによってクリーンに処理できます。プロトコルはオラクルがアセットの価格を提示できることだけを要求します。内部マッチングはDEXに触れないため、DEXの厚み（depth）は必要ありません。

反対方向のカウンターパーティが存在しない場合、プロトコルは上述の外部アグリゲーターパスへフォールバックします。内部マッチングは、利用可能な場合にのみ実行される最適な（strictly-better-when-available）最適化であり、決済を妨げるものではありません。

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### Alerts について

off-chain watcher が、あなたの wallet に関わる active loans を
5-minute cadence で poll し、それぞれの live Health Factor を読み、
unsafe direction への band crossing で configured channels 経由の
alert を一度 fire します。on-chain state も gas もありません。
Alerts は advisory です — funds は move しません。

<a id="alerts-inbox"></a>

### アラートの受信箱

アラートのページは、接続中のウォレットのネットワークについて、インデックスの受信箱を新しい順に50行ずつ読みます。行は、書き込まれた時点でローンのポジションを持っているウォレット宛てに書かれます。対象は、ローンの開始、一部返済と全額返済（期限前返済、借り換え、スワップ返済、担保売却による完了を含む）、デフォルトまたは清算、内部マッチによる完了、終了したことはわかっても理由をインデックスが判断できないローン、期日7日前と1日前の通知、猶予期間の開始と終了、そしてヘルスが1.5、1.2、1.05を下回ったときです。ヘルスの行はプロトコルのキーパーが書くため、キーパーが動いている間だけ、ヘルスが適用されるローンについてだけ届きます。報酬エントリーの最終通知と失効の行は、そのエントリーの所有者に届きます。行は金額ではなく指し示すものです。ローンのページがチェーンを読みます。別のネットワークやウォレット向けの応答は拒否され、読めない行は数えられ、未知の種類は名前のまま表示されます。ヘッダーの件数は、このブラウザーで既読として記録された最新の ID より大きい ID を持つ行を、インデックス自身がすべての行について数えたものです。ID は書き込み順に増えるだけなので、古いブロックで記録された行も数えられます。ページを開くと、それまでに書かれたすべての行が既読として記録されます。既読の印はこのブラウザーにだけ保存され、前にしか進みません。Telegram、プッシュ、ヘルス警告、支払いリマインダーは受信箱のすぐ下で設定します。行は履歴です。行が書かれた時点のローンまたはエントリーの状態を示し、それが今も続いているとは言いません。報酬の期限切れの行は、エントリーのプログラムへの返還が始まったことを意味し、完了したことを意味しません。

<a id="alerts-channels"></a>

### Telegram、プッシュ、警告

変更はどれも、操作、ウォレット、ネットワーク、時刻を記した平文メッセージへの EIP-191 署名です。アラートサービスは署名付きリクエストを 10 分以内に 1 回だけ受け付け、保存には変更する設定だけが含まれます。サービスはウォレット、ネットワーク、設定、連携後は Telegram のチャット ID を保存しますが、それを返さないため、各カードはこのブラウザーで行ったことを示します。Telegram の連携は、テストアラートがチャットに届いたときにだけ証明されます。通常のウォレットで連携を解除するとすべてのネットワークが解除され、スマートアカウントは署名したネットワークだけを解除し、保護モードが有効なネットワークでは保護の待機期間が過ぎるまでチャットが残ります。プッシュは、両方の送信元が 1 つのチャンネルで送信できるとサービスの状態が示すときだけ表示されます。リマインダーの送信元だけを対象とする場合、警告はプッシュに届かないことがあります。3 本のヘルスラインの既定値は 1.5、1.2、1.05 で、ここで変更でき、それぞれ次の値より上、最後は 1.0 より上にします。Telegram の連携とプッシュの有効化では先に規約を求めますが、オフにするときは求めません。

<a id="alerts-paid-push"></a>

### 有料のプッシュアラート

同意はオンチェーンに保存される上限で、ローンの各側につき支払う VPFI の最大額です。カードには、それが今の手数料をまかなうかについての、コントラクト自身の判定とともに表示されます。Basic では今の手数料で同意し、Advanced では手数料からプロトコルの上限 50 VPFI までの金額を入力できます。上限で同意すると、ガバナンスが設定しうるどの手数料も受け入れることになります。同意できるのは、アラートサービスが手数料をかけると答えたネットワークだけで、制裁チェックで指摘されたウォレットには表示されず、先に利用規約を確認します。最初に確認画面とドライランがあり、ウォレットが開く直前に手数料をもう一度読みます。変わっていれば何も送信しません。取り消しは上限をゼロにするもので、上限が保存されていればいつでも表示されます。プロトコルが一時停止中でも、アラートサービスに問い合わせられなくても同じです。同意の記録を持たないデプロイでは、どちらも表示せず、それでも手数料をかけうるかをカードで伝えます。

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics について

ウォレット不要の単一チェーンのページです。アプリが向いている
チェーン(ウォレット未接続時は既定の読み取りチェーン)を読み取り
ます。チェーン横断の集計やエクスポートはありません。チェーンを
比べるには、それぞれのチェーンでページを開いてください。情報源は
2つで、使われる箇所に明記しています。

- インデクサーのキー不要・CORS 開放の読み取り API — ローン、
  オファー、リサイクル、ループクロージャーの数値
- 公開 RPC 経由の Diamond 自身のビュー関数 — VPFI トークンと
  手数料の数値

どちらも直接照会して、ページの表示を再現できます。

<a id="public-dashboard.loans-offers"></a>

### ローンとオファー

`/loans/stats` からの状態別ローンカウンター(決済保留、内部
マッチ、その他の区分を含み、内訳の合計が総数になります)、ERC-20
と NFT レンタルの小計(資産種別がまだ読み取られていないアクティブ
なローンは別に明示)、そして `/offers/stats` からのオファー
カウンターです。オファーは `offers` テーブルのみで、ガス不要の
署名済み注文は数えません。またキャンセルされたオファーはインデックス
から外れるため、オファー合計は累計ではありません。欠けている
カウンターは「報告なし」、ありえない値は「報告されたが使える件数
ではない」と表示し、いずれも 0 とは表示しません。

<a id="public-dashboard.recycling"></a>

### リサイクル勘定とループクロージャー

リサイクル勘定(`/metrics/recycling`)はプログラムの各日の
プール、その原資、引き出し額を、プログラム独自の日番号で表示
します。未確定の日はプールなし、未アームの日は見積もりとして
示されます。ループクロージャー(`/metrics/loop-closure`)は UTC
日ごとに、クレームの支払額、ボールトに残った額、吸収された額を、
記録が到達している時点とあわせて示します。表示精度未満の正の額は
その旨を表示し、比率は切り捨て、不明な数値はゼロとして表示しま
せん。

<a id="public-dashboard.transparency"></a>

### 透明性と情報源

Diamond のアドレス(エクスプローラーへのリンク付き)、チェーン、
インデクサーのカーソルのブロックと経過時間です。インデクサー由来の
数値はすべて、このカーソル時点までのものです。2つの応答を組み
合わせる場合は、古い方のカーソルを示します。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI トークン

Diamond の `getVPFISnapshot()` から、このチェーン上のトークン
アドレスと `totalSupply` を取得します。カノニカルチェーンでは上限、
余地(`cap − totalSupply`、まだミントできる量)、ミンターも表示
します。ミラーチェーンのスナップショットには上限もミンターもあり
ません(供給は CCIP のトークンプール経由で届きます)。そのため
ページはローカルの供給量を示し、上限とミンターはカノニカル
チェーンのものだと明記し、ゼロは表示しません。トークン未設定と
スナップショット読み取り不可は区別して示します。

<a id="public-dashboard.fees"></a>

### 手数料とトレジャリー

`getTreasuryMetrics()`、`getTreasury()`、`getNumeraireSymbol()`
から取得します。スナップショットと同じ Multicall3 集約で読み取り、
1つのブロックに固定し、ページはそのブロックと経過時間を示します。

- 手数料台帳の開始以降、および過去24時間と7日間の手数料。各手数料
  は記録時にニュメレールで評価され、再評価されません。
- 記録時にプロトコルが評価できなかった手数料は 0 として記録され、
  期間の合計は最新の台帳エントリーを最大10,000件までしか走査し
  ません。この2つは数値を少なく見せる方向にしか働かず、ページはその
  ことを明記します。
- ニュメレールが変更されると以前のエントリーは旧単位のまま残るため、
  変更後の合計は現在の記号のもとで2つの単位の金額を足し合わせ、多く
  も少なくもずれる可能性があります。ページは以前の手数料が旧単位で数
  えられていることを明記します。
- トレジャリーのアドレス。外部アドレスの場合、手数料は徴収時に
  送られ、その残高は表示しません。Diamond 自身がトレジャリーの
  場合は保有額を表示します。これはオープン中のローンに現れる資産
  のみで評価し、トレジャリーに代わって別の場所に置いた額を含み
  ます。

失敗したビュー関数は「読み取れませんでした」と表示し、ほかの表示は
隠しません。

---

<a id="chapter.refinance"></a>

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
3. 古い loan を repaid としてマーク。position NFTs は burn されず、
   両方とも Loan Repaid 状態で保有者の手元に残ります。古い lender は
   自分の NFT で返済を claim し、古い borrower NFT は受領証として残ります。
4. 新しい position NFTs を mint。

新しい terms で HF が 1.5 を下回る場合は revert します。

---

<a id="chapter.preclose"></a>

## Preclose

このページは borrower 専用です — preclose は borrower が自分の
loan に対して開始します。

<a id="preclose.overview"></a>

### Preclose について

borrower-driven early termination です。2 つの paths:

- **Direct** — outstanding amount (principal + accrued interest) を
  wallet から支払い、collateral を release します。
- **Offset** — protocol の 4-DEX swap failover 経由で collateral
  の一部を principal asset に swap するため offset を initiate
  します。Offset を complete すると proceeds で repay し、残りの
  collateral はあなたに返ります。

flat early-close penalty はありません。

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

<a id="chapter.early-withdrawal-lender"></a>

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
listing します。buyer が sale を complete します。sale fill
前なら cancel できます。"complete loan sale" permission を持つ
keeper に delegate することもできます。ただし initiate step
自体は user-only のままです。

---

<a id="chapter.stuck-token-recovery"></a>

## スタックしたトークンのリカバリ

このセクションでは、ほとんどのユーザーには必要のない特殊なケース（エッジケース）について説明します。一番下にあるリカバリリンクをクリックする前に、この内容をすべてお読みください。誤った送信元を申告すると、プロトコルの制裁ポリシー（sanctions policy）に基づいて Vault がロックされる可能性があります。

<a id="stuck-recovery.what"></a>

### 「スタックしたトークン（stuck token）」とは

あなたの Vaipakam Vault プロキシは、プロトコルの内部ストレージです。これは、入金用のアドレス（deposit address）ではありません。プロトコルがサポートするすべての入金は、Vaipakam のファセットエントリポイントを経由し、オファー作成、ローン受諾、またはステーキング操作の一環として、あなたのウォレットから Vault へ資金を引き込みます。これらのフロー以外で Vault に届いたトークン（ウォレットからの直接の `IERC20.transfer` や、Vault のアドレスをコピー＆ペーストした CEX からの出金など）は、プロトコルによる記帳が行われないまま Vault に留まります。アセットビューアーは、プロトコルが追跡している残高のみを表示するため、これらのトークンは表示されません。

トークンがスタックするケースには主に2つあります。

1. **自分で送ってしまった場合**。ダッシュボードやブロックエクスプローラーから自分の Vault アドレスをコピーし、CEX の出金フィールドやウォレットの送金フォームに貼り付けて送信した場合。トークンはプロトコルの入金パスを通らずに Vault に届きます。

2. **第三者が送ってきた場合（「ダスト攻撃」）**。誰かが制裁対象のウォレットからあなたの Vault に少額のトークンを転送し、あなたのアドレスとそのウォレットを関連付けようとする攻撃です。これは、権限のいらない（permissionless）チェーン上の著名なアドレスに対する現実的な攻撃手法です。

<a id="stuck-recovery.taint-poisoning"></a>

### 「テイント・ポイズニング（taint poisoning）」について

もし第三者の送信元が制裁リストに載っている場合、一般的なオンチェーン分析ツールは、あなたがそのトークンに一切触れていなくても、あなたの Vault を「制裁関連（sanctions-adjacent）」としてフラグを立てる可能性があります。オンチェーンでこれを無効にする方法はありません。転送イベントは永久に記録されます。Vaipakam の内部（INTERNAL）記帳には影響ありません（プロトコルを経由した入金のみを追跡しており、ダストはカウントされません）。そのため、あなたのローン、ステーキング、クレムは通常通り機能し続けます。しかし、当社の会計方法を理解していない外部ツールは、警告を表示する可能性があります。

<a id="stuck-recovery.dont-recover"></a>

### リカバリをしてはいけない場合

自分で送ったトークンでない場合は、**リカバリを行わないでください**。リカバリを行うには、送信元のアドレスを申告する必要があります。もしそのアドレスが制裁リストに載っている場合、送信元がオラクルから除外されるまで、あなたの Vault はプロトコルの制裁ポリシーに基づいてロックされます。

あなたが送っていないトークンは、あなたのものではありません。実際には所有していない「クリーンな」アドレスを申告してリカバリを試みるのも避けてください。プロトコルはオンチェーンでの申告を検証できませんが、外部のオラクルツールが後から不一致を指摘する可能性があります。

最も安全な対応は、身に覚えのない少額のトークン（ダスト）を無視することです。これはプロトコルの残高や、アクティブなローンやオファーには影響しません。

<a id="stuck-recovery.when-recover"></a>

### リカバリをすべき場合

誤って自分でトークンを送り、かつ送信元のウォレットを自分で管理しており、その送信元が制裁リストに載っていないことが確実な場合（自分の EOA、出金元の CEX ホットウォレットなど）。

<a id="stuck-recovery.flow"></a>

### リカバリのフロー

1. [リカバリページ](https://defi.vaipakam.com/recover) にアクセスします。
2. トークンのコントラクトアドレス、送金元のソースアドレス、および金額を入力します。
3. 画面上の同意事項をよく読みます。
4. "CONFIRM" と入力して、署名を有効にします。
5. ウォレットで EIP-712 の同意事項に署名します。
6. トランザクションを送信します。

結果は2つのいずれかになります。

- **送信元がクリーンな場合** → トークンは Vault の記録残高に追加されます。通常どおり Vault から出金してください。保護アカウントモードがオンの場合は、その支払い遅延が適用されます。
- **送信元がフラグを立てられている場合** → トークンは Vault に留まり、Vault はプロトコルの制裁ポリシーに基づいてロックされます。アドレスが後に制裁オラクルから削除されれば、ロックは自動的に解除されます。

<a id="stuck-recovery.disown"></a>

### 身に覚えのないトークンの放棄（コンプライアンス監査用）

Vault 内にある特定のトークン残高が自分のものではないという公的なオンチェーン記録を残したい場合、プロトコルは `disownUntracked(kind, asset, tokenId)` 関数を提供しています。これはイベント（`UntrackedDisowned`）を発行しますが、それ以外は何も変更しません。トークンは以前と同様に Vault に留まります。これは、CEX や規制当局から「この資金を受け取ったか」と問われた際のコンプライアンス上の証明として、オンチェーンイベントを提示するのに役立ちます。

放棄（disown）関数は、現在のところコントラクトの直接呼び出しによってのみ利用可能です。Vaipakam のフロントエンドにはボタンとしては表示されません。ブロックエクスプローラーの "Write Contract" UI や、コントラクト操作ツールを使用して呼び出してください。

<a id="chapter.how-vpfi-discounts-work"></a>

## VPFI 割引の仕組み

canonical チェーンである Base 上の vault に VPFI を保有していると、
プラットフォームが動くすべてのチェーンで、プロトコル自身の手数料が
割引になります。保有量が多いほど、また長く保有しているほど tier が
上がり、割引も大きくなります。tier の一覧は上の
[Tier ladder](#dashboard.fee-discount-consent) にあり、governance が
変更できます。

割引の対象:

- **貸し手として**は、得た利息からプロトコルが差し引くイールド手数料
  です。利息が settlement されるたびに（返済、preclose、refinance
  など）、loan 開始時ではなくその時点の tier で読み取られます。
- **借り手として**は、loan 開始時に課される Loan Initiation Fee です。
  accept 時に一度だけ読み取られ、その loan に固定されます。lending
  asset が liquid な場合にのみ適用され、illiquid な loan は手数料を
  全額支払います。

割引は loan の資産建てで手数料そのものから差し引かれ、そのために
vault から VPFI が出ていくことはありません。唯一の例外は、VPFI の
価格参照を設定したデプロイでの貸し手の割引で、その場合は vault から
VPFI で決済されることがあります。ローンチ時点では設定されていません。
この章が扱うのはこの保有割引です。別の有料手数料モード「Full」は、
デプロイが有効にしない限りオフのままです。

<a id="vpfi-discounts.turning-on"></a>

### 割引をオンにする

割引は opt-in です。スイッチは VPFI ページにあり、チェーンごとに
1 つあります。各チェーンがそれぞれ独自の設定を持つからです。

- **手数料が課されるチェーンでは**、スイッチがオンでなければなり
  ません。オフなら、tier に関係なくそのチェーンは手数料を全額課し
  ます。
- **Base でも**、そこで借りたり貸したりしない場合でも、スイッチを
  オンにする必要があります。オフの間、Base は他のすべてのチェーンに
  あなたの tier をゼロとして送ります。

Base で割引をオフにすると、他のすべてのチェーンでも適用が止まるよう、アプリが続けて tier の更新を送ります。Base はそれらのチェーンにあなたの tier をゼロとして送ります。この 2 つ目の手順が失敗した場合はページに表示され、他のチェーンは新しい tier が送られるまで最後の tier を保持します。他のチェーンでオフにした場合は、そのチェーンだけが変わります。

VPFI が数えられるのは、プロトコルが vault 内の残高として記録したときです。VPFI ページから入金した VPFI と、プロトコルが vault に届けた VPFI rewards がこれにあたります。vault のアドレスに直接送られたトークンはプロトコルが追跡しておらず、tier を上げません。

<a id="vpfi-discounts.tier-calculation"></a>

### tier の計算方法

tier は 3 つの別々のチェックで決まり、3 つすべてを満たす必要が
あります。

1. **最低保有期間。** 現在の保有が少なくとも 3 日続くまで、tier は
   ゼロのままです。保有は vault 残高がゼロを超えた時点で始まり、
   ゼロに戻るまで続きます。買い増しても時計はリセットされませんが、
   全額を引き出すとリセットされます。（3 日は default で、governance
   は 2〜14 日に設定できます。）
2. **直近を重視した平均。** 残高は直近 30 日で平均され、最後の 7 日は
   それ以前の日の 3 倍の重みで数えられます。平均は現在の保有が始まる
   前までは遡らないため、新しく保有した人が何も持っていなかった日に
   よって薄められることはありません。（期間、直近の日数、重みは
   governance の設定で、期間は 14〜30 日の範囲です。）
3. **これまでに触れた最も低い tier。** 平均とは別に、tier は現在の
   保有期間中に残高が達した最も低い tier を超えられません。遡るのは
   最大 30 日です。各日の最低点で数えるため、同じ日のうちに下がって
   戻った場合も下がったものとして扱われます。

実際には次のようになります。

- loan の settlement 直前に入金しても、tier はすぐには上がりません。
  追加した分はまず平均に反映される必要があり、触れた最低点による
  上限も残ります。
- tier の下限を下回る出金をすると、tier はすぐに下がります。
- 30 日より前の下落は、もう上限になりません。

<a id="vpfi-discounts.other-chains"></a>

### 他のチェーンでの tier

tier を計算するのは Base です。他のすべてのチェーンは、Base が Chainlink CCIP で送るコピーを適用します。Base があなたの tier 記録を更新するのは、Base で次のいずれかが起きたときです。VPFI が vault に入るか出るとき（入金、出金、または vault に届けられた rewards）、あなたが貸し手または借り手であるローンが始まったとき、ローンの手順であなたの VPFI が保留または解放されたとき、または tier 更新の呼び出しを行ったとき。更新のたびに、コピーの中身が変わる場合は他のチェーンに新しいコピーが送られます。

チェーンごとに個別に配送されます。届かないチェーンが他のチェーンを
足止めすることはなく、**配送が送れなくても、あなた自身の操作が失敗
することはありません**。Base 上の tier はすぐに最新になり、他の各
チェーンには届くまで更新が未配送として残ります。

これらの配送費用はプロトコルが負担しますが、上限が 1 つあります。

- **下がった tier** は、予算で支払える限りすぐに送られます。届く
  までは、そのチェーンは以前のより高い tier を適用し続けます。
- **上がった tier** や tier 表の変更は、チェーンごとに 1 日 1 回まで
  しか費用が負担されません（governance 設定で 1 時間〜7 日）。それ
  までは、そのチェーンは以前の tier を保持します。
- この待機で保留された更新や、予算で支払えなかった更新は、**待機が終わっても自動では再送されません**。Base 上のティア記録が次に更新されたとき、または誰かがあなたのために配送の呼び出しを行ったときに送られます。
- この呼び出しは誰でも行えます。待機が終わり予算で支払える場合はプロトコルが支払い、それより前に早く届けたい場合は呼び出した人がクロスチェーン手数料を支払います。コントラクトはこの呼び出しに対応していますが、アプリはまだ提供していません。

次の場合、コピーは数えられなくなり、そのチェーンでは割引がなくなり
ます。

- チェーンの最大経過期間（default 60 日、30 日未満にはならない）より
  古い場合。
- そのチェーンが現在知っている tier 表より古い表で作られた場合。

コピーが再送されるのは、その中身が変わるときだけです。つまり tier、その割引、有効期間、tier 表のバージョンのいずれかです。そのため tier 表が変わった後は、tier が同じでも（ゼロでない限り）、Base での tier 記録の次の更新ですべてのチェーンに新しいコピーが送られます。どれも変わっていなければ、コピーが期限切れになったチェーンは、何かが変わるまで割引を適用しません。

時間の経過だけで tier が上がった場合（保有期間を満たした、または平均が追いついた）、tier 記録の次の更新まで Base では何も検知されません。tier 更新の呼び出しを行えば、いつでもその更新ができます。アプリがあなたの代わりに呼び出すのは割引をオフにしたときだけです。

<a id="vpfi-discounts.operators"></a>

### 運用者向け

割引のクロスチェーン部分には次の設定が必要です。独自のデプロイを
運用する人のためにここに記載します。

**Base 上:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`。これがないと、Base は
  tier を計算しますがどこにも送りません。
- `VaipakamRewardMessenger` を指す
  `RewardReporterFacet.setRewardMessenger`、および他のすべてのチェーン
  を列挙した messenger の `setBroadcastDestinations`。
- 資金のある broadcast 予算:
  `ProtocolBroadcastFacet.topUpBroadcastBudget()`（payable）。予算が
  空でも何もブロックされません。支払えない配送は未配送のまま残り、
  理由付きで `TierPushDeferred` を発行します。`getTierPushStatus(user)`
  はユーザーごとに各チェーンの状態を示します。予算が不足すると他の
  チェーンが古い tier を長く適用するため、延期を監視して補充して
  ください。
- 有料の引き上げの間隔ウィンドウ: `setTierPushSpacingSec`（default
  1 日、1 時間〜7 日）。

**他の各チェーン上:**

- `RewardReporterFacet.setRewardMessenger(addr)`: そのチェーンが tier
  の更新を受け付ける唯一の送信者。
- `RewardReporterFacet.setBaseChainId(chainId)`: Base の EVM チェーン
  ID（mainnet では 8453、Base Sepolia では 84532）。CCIP の chain
  selector ではありません。
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: コピーが数えられる
  期間（default 60 日。30 日未満の値は拒否されます）。下げた場合は
  次の読み取りから有効です。

**tier 表の変更:**

- Base 上の `setVpfiTierThresholds` と `setVpfiTierDiscountBps` は表の
  バージョンを進めます。他のチェーンは、どのユーザーのものであれ、
  新しいバージョンを持つ最初の tier 更新でそれを知ります。それ以降、
  古い表で作られたコピーは、そのユーザー自身の更新が届くまで割引
  なしとして扱われます。これらの更新は引き上げなので、間隔ウィンドウ
  ごとに 1 回までしか支払われません。表を変更する前に予算を補充して
  ください。
- `setTwaMinStakedDays` はバージョンを進めずに最低保有期間を変更
  します。次の読み取りから有効です。

<a id="chapter.next-app"></a>

## 次のアプリ

Vaipakam アプリの次のバージョンは、現在のアプリと並んで
1 ページずつ作られています。まだ作られていないページはそう
表示し、引き続きそれを提供する現在のアプリへリンクします。
作られたページの数字はすべてチェーンから読み取られ、出どころを
示します。読み取れない数字はゼロではなく不明として表示されます。

<a id="advanced-mode"></a>

### Basic と Advanced

Basic は多くの人に必要な機能を表示します。Advanced では exit と
精算のツール、自動化、署名済み注文、keeper の態勢、会計の詳細が
加わります。モードはブラウザに保存される表示の選択で、表示する
量を変えるだけで、プロトコルが許す内容は変えません。同意、
ブロック要因、その対処が隠れることもありません。

<a id="wallet"></a>

### あなたの wallet と数字の出どころ

あなた自身の状態 (loan、オファー、vault、claim) はチェーンから
読み取ります。まず wallet のプロバイダー、次に読み取り専用の
RPC プロキシ、最後にネットワークの公開エンドポイントです。同期
の行は、応答したソースと、ページ上で最も古い読み取りの経過時間
を示し、「更新」ですべてを読み直します。インデックスは全体の
数字 (マーケットと履歴) にだけ使い、そのブロック高と経過時間を
表示します。対応外のネットワークにある wallet には、切り替える
まで自分のものは何も表示されません。アドレスのチップはアプリ独自のアカウントパネルを開きます。コピー操作付きの完全なアドレス、network、対応する他の各 network への切り替え、接続解除です。wallet の選択画面は接続にだけ使います。接続後のアプリはネームサービスの照会を行わないため、接続中のセッションは Ethereum mainnet を一切読まず、ページの connect-src リスト外のホストにも到達しません。

<a id="deployments"></a>

### デプロイが対応している機能

アプリはチェーンごとに 1 つの Diamond に接続し、操作を提示する前
に loupe を通じてルーティングされたセレクターを読み取ります。
facet の更新後はこの集合が変わります。決めつけずに読み取ること
で、`FunctionDoesNotExist` で失敗する代わりに、欠けている機能を
名指しできます。集合が読み取れない間は、署名の手順は提示され
ません。

<a id="home-start"></a>

### Home: やることを選ぶ

Home はプロトコル用語ではなく、やることから始まります。借りる、
貸す、NFT を借りる、NFT を貸す、持っているものを管理する、です。
借りると貸すは条件の合うオファーから開き、なければ自分の
オファーの作成へ進みます。NFT レンタルは両方の側を扱い、NFT は
最後まで vault に置かれます。接続済みの wallet には非表示にできる
入門カードが 3 枚表示され、非表示の選択はブラウザに保存されます。

<a id="home-status"></a>

### Home: プロトコルの状態

Home は、ページが説明しているチェーン上のグローバル停止、自動
停止の期間、keeper の停止を読み取り、どの場合も結果を表示します。
グローバル停止中は、新しいポジション、claim、引き出し、清算、
デフォルト、keeper による精算が止まります。全額返済と一部返済、
担保の追加は引き続き可能で、停止時間はすべての未完了 loan の
期限に加算されます。自動停止の期間は終了時刻を表示します。管理者
による停止があれば、それはより長く続き、次の自動停止期間は
クールダウンの後にしか始まりません。keeper の停止は、サービスが
あなたの代わりに行う手順だけを止めます。読み取れない状態は、
以前の応答の後に失敗した再読み取りも含め、上部に不明として表示
されます。個別の資産が停止されることもあり、関係する手順はそれを
表示します。

<a id="home-payouts"></a>

### Home: 受け取り可能

Home は貸し手側と借り手側の claim 可能ビューをページごとにたどり、
各支払いを loan と立場で示します。金額は表示しません。支払いは
複数の資産や複数の経路で行われることがあり、各金額は受け取る前に
Claims で示されます。たどる途中で止まった場合、Home は表示以上に
存在する可能性があると伝えます。

<a id="home-loans"></a>

### Home: あなたの loan

Active または FallbackPending の各 loan を、立場、条件、担保、
段階とともに、緊急度順に表示します。猶予切れ、猶予中、
フォールバック、期限が読み取れない、3 日以内に期日、進行中の順
です。期日と猶予の終わりはプロトコルの loan クロックから取得し、
停止時間を含みます。停止時間はゼロでないときに表示されます。
health factor はダッシュボードビューの 1e18 スケールの値です。
0 は値なし (価格のない資産、または読み取りの失敗) を意味し、
そのように表示されます。同じオファーから同じ立場、同じ ERC-20
で開かれた 2 件以上の loan はまとめられます。元本は合計、金利は
元本で加重して切り捨て、価格のある loan の中で最も低い health
factor を示し、価格のないものは件数を示します。

利息を定期的に支払う loan には、期日当日までの支払い時点もあります。支払い時点の猶予期間が終わっても未払いの利息は、担保を売却して支払われることがあり、loan はそのまま続きます。Home は次の支払い時点を表示し、未払いのものを先頭に置きます。期日と同じ日の支払い時点でも同様です。その猶予期間は loan の猶予期間より先に終わることがあるためです。プロトコルはこの精算を停止できます。その場合、Home は支払い時点で担保が売却されないことを示します。

<a id="home-exposure"></a>

### Home: 貸しと借り

各 loan の元本は、プロトコルの唯一の評価ルールで、現在の価格に
よるニューメレール建てで評価されます。債務は切り上げ、あなたが
貸した loan は切り捨てです。評価できない loan (NFT や価格のない
資産) は推測せずに件数として数えます。評価できない loan が答えを
変えられない場合にだけ大きい方を示し、そうでなければ評価済みの
合計と件数を表示します。

<a id="home-faucet"></a>

### Home: テスト資産

デプロイ記録がテスト資産を公開しているテストネットでは、Home がそれらを一覧にします。テスト価格フィードとプールにつながったテスト用 ERC-20（流動性あり）、意図的にどちらも持たないもの（流動性なし: それを使うローンは価格がなく、デフォルトは現物で決済されます）、そして ERC-4907 のレンタル NFT です。発行はモックトークンのコントラクトを呼び出し、Diamond は呼びません。トークンなら 1,000 単位、NFT なら新しいランダムなトークン ID で一つ発行し、その ID が未発行であることをウォレットを開く前に確認します。結果は残高または `ownerOf` を読み直して測定し、トークンの発行後には `wallet_watchAsset` を提案します。テスト用 NFT を焼却できるのは所有者か承認されたオペレーターだけです。

<a id="home-fee-discount"></a>

### Home: 手数料割引

`setVPFIDiscountConsent` は、このチェーンの Diamond にウォレットごとのフラグを一つ設定します。オフなら保有ティア割引は 0 です。オンなら、借り手のローン開始手数料が受諾時に貸出資産で減額され（VPFI の価格経路が借り手側に関わることはありません）、貸し手のイールド手数料は決済のたびにその時点の実効ティアで割り引かれます。支払い方法は `getVPFIDiscountConfig` に従います。VPFI レートと参照資産の両方が設定されていれば、割引後の手数料は貸し手のボールトから VPFI で引き落とされ、貸し手は利息を全額受け取ります。そうでなければトレジャリー手数料そのものが減額され、VPFI は動きません。決済時にこの引き落としができない場合（有効な価格がない、ボールト内の追跡済みの自由な VPFI が足りない、またはその VPFI が担保としてロックされている）、その決済の手数料には保有ティア割引が適用されません。この呼び出しは `whenNotPaused` なので、グローバル一時停止中はどちらの方向にも閉じられます。オンにするには規約が必要でオフには不要、どちらもミラーへティアを送信しません。借り手の割引は受諾時に貸出資産が流動的な場合にのみ適用され（流動性のないローンは LIF を満額支払います）、どの割引も手数料の 50% が上限です。

<a id="home-rewards"></a>

### Home: リワード

見出しの数値は `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)` で、Vault 送付先でクレームを実行し、必ず revert します。`InteractionRewardsSimulation(paid, fromDay, toDay)` が正確な数値を運び、それ以外の revert はクレーム自身の拒否 (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`) で、名前で表示されます。どのソースもプレビューを実行できない場合に限り、Home は下限である `previewInteractionRewards` を読み、クレームを保留します。正確な数値がゼロでもクレームは提示されます。プロトコルが何も支払わないクレームを認めるのは、何も支払わなかった報酬日を先へ進む場合だけで、Home はそのことを伝えます。Home は `claimInteractionRewardsTo(2)` でクレームし、1 回の呼び出しで最大 `MAX_INTERACTION_CLAIM_DAYS`（30）日分を支払います。完了したクレームのブロック以降に読み取ったプレビューがまだ金額を返す場合、Home は残りを提示します。報酬エントリーだけから支払うクレームは日付の範囲を示さないため（0 から 0）、Home は日付の代わりにそのことを伝えます。Vault 送付先はコントラクトウォレットを含むすべてのアカウントに渡されます。Default 送付先はコントラクトの呼び出し元にはウォレットへ支払うためです。ボールトに入金され、入金が完了できない場合（まだボールトがない）はウォレットに戻ります。結果はレシートから読み取ります。`InteractionRewardsClaimed` が支払額を示し、同じトランザクションのウォレットと `getUserVaultAddress(user)` への VPFI `Transfer` ログが届いた先を示します。それらの合計が支払額にならない場合、送付先は不明と表示されます。累計クレーム額は表示されません。そのためのユーザー別インデックスルートがまだないためです。

<a id="home-rewards-expiry"></a>

### Home: リワードの削除日

`ConfigFacet.getRewardClaimHorizonDays()` が 0 ならホライズンは無効で、日付は表示しません。それ以外の場合、Home は `getUserSoonestRewardExpiry(user, offset, 200, 50)` をページごとに、すべて同じブロックで、最大 10 ページまで読みます。`nextOffset >= total` で走査は完了し、途中で止まった走査は「期限のものなし」ではなく不完全と表示します。最終通知は最も早い見積もりの 90 日前から表示されます。見積もりはそのブロック時点のエントリーの `expiresAt` で、クレームが実行できない期間は実際の削除を遅らせ、ホライズンのガバナンス変更は早めることがあります。エントリーが削除する額は Home には表示しません。

<a id="home-rewards-held"></a>

### Home: 保留中のリワード

`getSanctionsHeldReward(user)` が保留残高、`getRewardSanctionsStatus(user)` がその判定（Deliver、Hold、Confirmed）です。残高があり判定が Deliver のとき、Home は `claimHeldInteractionRewards(2)` を提示します。これは新たな未払い分を精算せずに保留残高そのものを支払い、`InteractionRewardsClaimed(user, 0, 0, paid)` を発行します。ウォレットが禁止されている間は `SanctionedAddress` で revert します。署名前の再確認では両方を読み直し、送信者として呼び出しをシミュレートします。フラグ確定中に得た日数分は永久に没収されます。

<a id="borrow-start"></a>

### Borrow: 仕組み

Borrow は、ERC-20 担保に対する ERC-20 の貸し手オファー（`offerType` 0）を `acceptOffer(offerId, terms, signature)` で直接受けます。1回のトランザクションで、借り手のボールトがなければ開設し、担保をそこへ移し、組成手数料を差し引いた元本をウォレットに渡し、`LoanInitiated` を発行します。借り手はリクエスト（`offerType` 1）を出すこともできます。NFT の側、ペアの同意、詳細オプションは今後のアップデートで追加されます。

<a id="borrow-pair"></a>

### Borrow: トークンを選ぶ

各トークンの区分はその場で読み取ります。まず `getAssetPriceStatus(asset)`（Divergent は信頼されていないと読み、新規ローンを止めます）、次に `checkLiquidityOnActiveNetwork(asset)`（0 は流動、1 は非流動）。`OraclePriceDivergence` または `OracleCrossCheckDivergence` での revert は信頼されていないと読み、それ以外の失敗は理由とともに読み取り不能と表示します。提案リストはデプロイ記録のラップドネイティブトークンとテストトークンで、貼り付けたアドレスは形式のみ確認します。

信頼階層はインデックスから `GET /assets/rankings?chainId=<token chain>` を読みます。インデックスは keeper が毎日取得する2つの公開時価総額リスト（各上位500）を提供し、アドレスごとに各リストの順位・名前・シンボルを1件にまとめ、各リストの `listFetchedAt` と最後の実行結果も返します。アプリは小文字のアドレスをキーにし、リスト間で最も良い順位を採ります。順位 ≤ 20 で `getAssetPriceStatus(asset)` が priced ならブルーチップ、次に ≤ 100、200、300、500 です。別のリストが同じシンボルを別のアドレスに載せ、どちらのリストも両方のアドレスを載せていない場合、そのトークンは未確認になります。ランク外のトークンで `symbol()` か `name()` がランク入りのシンボルや名前と一致するものはコピーの可能性、それ以外はランク外です。デプロイ記録のテストトークンはテストと表示され、保存済みリストのないチェーンはテストネットではテストネットワーク、メインネットではリストなしとして扱われます。`listFetchedAt` より後に失敗した `lastRun` は明示されます。階層は表示のみで、オンチェーンの扱いは何も変えません。検索はランク入りのシンボルと名前を部分一致で照合し、最良順位を先に、その後に推奨トークンをシンボルで並べます。`0x` で始まる文字列はアドレスとして解釈されます。

<a id="borrow-offers"></a>

### Borrow: オファーを選ぶ

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` がペアの公開オファー ID と総数を返します。各 ID について `getOffer`、`getOfferState`、ウォレットがあれば `previewAccept(offerId, wallet)` を読みます。その `errorCode` がプロトコルの拒否理由です。ローン・トゥ・バリューは現在価格での `calculateLTV` で、非流動または価格のない側はない理由を示します。直接の受諾は貸し手の `amountMax` を `interestRateBps` で拘束します。借入リクエスト、NFT の側を持つオファー、自分のオファーは数えますが一覧には出しません。

アプリは受諾が拘束する金利（`interestRateBps`）で行をまとめ、低い順に並べます。段の中ではリストの順序を保ちます。最高金利と、Advanced での最高ローン・トゥ・バリューは読み取った行を絞り込むだけです。`calculateLTV` が数値でない行は残し、数に含めます。待機中の貸し手の行は `getActiveLenderIntents(offset, 50)` を最大四ページ読み、ペアのインテントを残し、それぞれ `availableCapital` と `maxExposure` から `livePrincipal` を引いた値の小さい方を取り、`minFillAmount` を下回るものは除きます。数、単独で最大の値、最低の `minRateBps` を示し、Advanced では最大の `maxDurationDays` と `maxInitLtvBps` も示します。マッチングサービスはこれらの上限内でのみインテントでリクエストを成立させるため、成立は保証されません。 この行には`getPartialFillEnabled`と`isLenderIntentEnabled`の両方がtrueであることが必要で、リストの各ページと同じブロックで読み取ります。どちらかがfalseなら、それらに対してリクエストは約定しないとページは示し、どちらかを読み取れなければ、それは分からないと示します。再読み取りに失敗した場合は前回の結果を残し、変わっている可能性があると示します。 `owner`が接続中のアカウントであるintentは除外されます(自分自身とのマッチはself-tradeとして拒否されます)。すべてのintent約定はリクエストの`useFullTermInterest`も必要とし、`allowsPartialRepay`を拒否します(`LenderIntentFullTermRequired`、`LenderIntentPartialRepayNotAllowed`)。この方法は両方を示し、リクエストフォームはどちらかを満たさない選択を、約定の見込みの代わりに示します。`keepersPaused()`も同じブロックで読み取ります。trueの間はプロトコルのマッチングサービスは何も約定させないため、ページは成立の見込みの代わりにそれを示し、貸し手は自分のintentから約定させられること、`requiresKeeperAuth`のないintentは誰でも約定させられることを添えます。読み取れなければ、それは分からないと示します。intentでの約定には、リクエストの`periodicInterestCadence`がなしであることも必要です。intentのスライスはスケジュールを持たず、マッチングはライフサイクル条件の異なる組み合わせを拒否するためです（`LifecycleTermsMismatch`）。リクエストフォームは、スケジュールを選ぶと成立の見込みの代わりにそれを示します。`requiresKeeperAuth`を持つintentは別に集計・表示され、成立の見込みの行は決して適用されません。約定させられるのは貸し手か、貸し手が`KEEPER_ACTION_SIGNED_FILL`を許可したsolverだけで、マッチングサービスがその許可を持つかは読み取らないため、ページは分からないと示します。判定は同じブロックで`paused()`と`aggregatorAdaptersPaused()`も読み取ります。全体の一時停止は他のどの条件よりも優先され、停止中と表示されます。アグリゲーターが一時停止中は、各所有者をそのブロックで`isAggregatorAdapter`により確認し、`matchIntent`が拒否するためそのintentを除外します。確認が読み取れない場合、判定は不明になります。

<a id="borrow-review"></a>

### Borrow: 確認と署名

確認画面は、オファー、その状態、`previewAccept`、`getOfferLinkedLoanId`、`getCurrentRiskTermsHash`、両方の区分、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、ウォレットのボールト・残高・承認額、`previewOfferAcceptBlock`、割引の同意を読み、ウォレットが開く直前にもう一度読みます。ウォレットは保存されたオファーから作った EIP-712 `AcceptTerms`（ドメイン `Vaipakam AcceptOffer`、バージョン 1）に、新しい 128 ビットの nonce と 30 分の期限で署名します。非流動の確認は、確認画面が非流動と示した側だけを指定します。承認額が足りないときだけ担保額ちょうどの承認を行い、署名付きで `acceptOffer` を試行してから送信します。承認後に止まった場合、ほかに変更がなければアプリは承認額を元の値に戻します。結果は、このオファーとウォレットの `LoanInitiated` とレシートの `Transfer` ログから読みます。許可額は最初のウォレット確認の直前に読み直され、リセット時にはその値に戻します。送信後にリバートした承諾や、ウォレットが取り消しまたは置き換えた承諾にも、トランザクション追跡が同じリセットを行います。レビューには `allowsPartialRepay`、`allowsPrepayListing`、`parallelSaleOrderHash` を伴う `allowsParallelSale`、`refinanceTargetLoanId`、関連ローンを示し、返済額は一時停止がない場合の金額と明記します。一時停止中も利息は発生し、期日だけが後ろにずれるためです。 各承認ステップは、レシートが含まれたブロックで読み直した許可額で判定し、レシートのステータスでは判定しません。ゼロでない許可額から別のゼロでない値への変更を拒むトークン（`approve` のドライランで判別）には先にゼロへのステップが入り、確認画面ではそれを追加のプロンプトとして数えます。規約の同意はウォレットが開く直前に再度読み取られます。 どちらの売却経路も担保を NFT として出品するため、トークン担保では、付与された出品・売却の許可はこのローンでは使えないものとして表示されます。確認画面は、プレビューの金額での元本と担保の `getNumeraireValue` を、何も拘束しない行として加えます。

<a id="borrow-fee"></a>

### Borrow: 組成手数料

手数料は `previewAccept` の `lifEstimate` です。元本に対する `getLoanInitiationFeeBps` を借りるトークンで、渡される額から差し引きます。同意がオンで借りるトークンが流動であれば保有ティア割引で下がり、ティアは受諾時点で決まります。このページが Full 料金を選ぶことはありません。手数料のために VPFI を徴収することも返金することもありません。 送信者の取り分（手数料の `getLifMatcherFeeBps`）は送信者に支払われ、直接の受諾では借り手がそれにあたるため、ウォレットには手数料を差し引いた元本にその取り分を加えた額が届きます。

<a id="borrow-risks"></a>

### Borrow: リスク

猶予期間を過ぎたローン（期日から `getEffectiveGraceSeconds` 後。一時停止の時間だけ後ろにずれます）は誰でもデフォルトにできます。流動担保は貸し手のために売却され、非流動担保はそのまま移転されます。流動担保はヘルスファクターが 1 を下回ると清算されることもあります。`useFullTermInterest` は早期返済時に全期間の利息を課し、利払いスケジュールは支払われなかった期間を担保の強制売却で精算します。

<a id="borrow-request"></a>

### Borrow: 自分のリクエストを出す

リクエストは、借り手のウォレットから送る `offerType` 1、両側 ERC-20 の `createOffer` です。`collateralAmount` を借り手のボールトに移し（なければボールトを作成）、`OfferCreated(offerId, creator, 1)` を発行します。貸し手は `acceptOffer` で受けます。手数料を差し引いた元本は借り手のウォレットへ、手数料のうち送信者の取り分は送信した貸し手へ渡ります。`cancelOffer` は作成者には作成から `MIN_OFFER_CANCEL_DELAY`（5分）後から、誰にでもリクエストの期限切れ後に開かれています。担保は常に作成者に戻ります。入力した各金額の下に、フォームは `getNumeraireValue(asset, amount, roundUp)`（元本は切り上げ、担保は切り捨て）を `getNumeraireSymbol` の単位で表示し、入力が止まったときに読み取ります。流動性のない資産は評価ゼロ、争いのある価格は値なし、読み取りの失敗は未読として示されます。

<a id="borrow-request-terms"></a>

### Borrow: リクエストの条件

Basic は単一値のリクエストを出します。`amount` = `amountMax`、`interestRateBps` = `interestRateBpsMax`、`collateralAmount` = `collateralAmountMax`、`fillMode` 0、`periodicInterestCadence` 0、`allowsPrepayListing` と `allowsParallelSale` は false、`refinanceTargetLoanId` 0、`creatorRiskAndTermsConsent` true です。金額は基本単位へ正確に変換され、金利は最大 10,000 bps です。`durationDays` は `getProtocolConfigBundle` から読む設定上の最大値で上限が決まります。`expiresAt` は 0（キャンセルまで有効）か、確認画面を開いた時点の最新ブロックから決めた時刻で、最大 `MAX_OFFER_EXPIRY_HORIZON`（365日）先までです。`useFullTermInterest` の既定は true、`allowsPartialRepay` は false です。

<a id="borrow-request-review"></a>

### Borrow: リクエストの確認と掲載

確認画面はウォレットから `createOffer` をシミュレートし、両方の区分、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、最長期間、ウォレットのボールト・残高・承認額、両側が流動的なら `calculateLTV` を読み、毎ブロックとウォレットが開く直前に読み直します。承認額が足りない間、シミュレーションは担保の引き出しまでしか進めないため、トークンの引き出しエラーやプロトコルのエラー名がない revert は解消すべき承認として示し、名前のあるプロトコルエラーは拒否として扱います。ちょうどの額を承認した後、`createOffer` を再度シミュレートして送信します。承認後に止まった場合、他に変更がなければ承認額を元の値に戻します。結果はこのウォレットの `OfferCreated` と、ボールトへの担保の `Transfer` から読みます。

<a id="borrow-nft-collateral"></a>

### Borrow: NFT を担保にする

担保の規格は `supportsInterface` で読み取ります（ERC-721 `0x80ac58cd`、ERC-1155 `0xd9b67a26`）。revert はどちらでもないとみなし、読み取りの失敗ではリクエストを提示しません。ERC-721 のリクエストは `collateralAssetType` 1、`collateralTokenId` に入力した ID、`collateralQuantity` 1、`collateralAmount` = `collateralAmountMax` = 0 を送ります。リスクペアはそのトークン ID をキーにします。レビューは同じブロックで `ownerOf`、`getApproved`、`isApprovedForAll(wallet, Diamond)` を読みます。他のウォレットが保有するトークンや revert する `ownerOf` はリクエストをブロックします。どちらの承認もない場合、ドライランはトークンの `ERC721InsufficientApproval` で止まり、必要な承認として示されます。承認は `approve(Diamond, id)` で、レシートのブロックで `getApproved` が Diamond を読むときだけ完了とみなします。その後に止まった場合、承認がまだ Diamond を指し、ウォレットがまだトークンを保有している間だけ、以前のアドレスに戻します。ERC-721 では `setApprovalForAll` は決して求めません。結果は `OfferCreated` と、ウォレットから金庫へのトークン自身の `Transfer`（4 つの topic）を読みます。ERC-1155 のリクエストは `collateralAssetType` 2、トークン ID、入力した数量の `collateralQuantity`（1 から 2^128−1）、両方の金額 0 を送ります。確認では同じブロックで `balanceOf(wallet, id)` と `isApprovedForAll(wallet, Diamond)` を読み、残高が数量に満たなければリクエストをブロックします。承認がない場合、ドライランは `ERC1155MissingApprovalForAll` で止まります。唯一の承認は `setApprovalForAll(Diamond, true)` で、レシートのブロックで読み戻せたときに完了とみなし、リクエストがマイニングされるか止まった後に `setApprovalForAll(Diamond, false)` で取り消します（付与のブロックより前は決して読みません）。ただしウォレットが以前から承認していた場合は除きます。結果は、ウォレットから金庫へのトークンの `TransferSingle`/`TransferBatch` を合計します。NFT を求める貸し手のオファーは引き続き現在のアプリで扱います。

<a id="borrow-request-range"></a>

### Borrow: 範囲付きリクエスト

範囲は `amount`（最小）を `amountMax`（最大）より小さく、`interestRateBps` = `interestRateBpsMax`（一つの金利）、`collateralAmount`（最小のローンの下限）を `collateralAmountMax`（投稿時に保管庫へ移される）以下で送ります。下限が空なら両者を同じ値で送ります。範囲は ERC-20 担保の場合だけ提供します。直接の `acceptOffer` は `collateralAmount` を担保に `amount` を `interestRateBpsMax` で貸し、`collateralAmountMax − collateralAmount` をウォレットに戻します。`getPartialFillEnabled` が true の間、`matchOffers` は両端の間で約定します。`createOffer` のドライランは最大の端でオファー上限を適用し、`MaxLendingAboveCeiling(provided, ceiling)` で拒否します。その上限はレビューに表示します。直接の端は (`amount`, `collateralAmount`) での単一値リクエストの二回目のドライランで確認し、上限より前で止まった応答は不明と表示します。各端の LTV は `calculateLTV(lending, amount, collateral, collateralAmount)` で、`ZeroCollateral` は価値のない担保として扱います。表示するローン開始時のヘルスファクターは、`getDepthTieredLtvEnabled` が false の間は `getMinHealthFactor`、true の間は 1.0 です。マッチはレンダーの按分要求額をロックします。担保がレンジのときは `collateralAmount` まで引き上げ、そうでないときは要求額のままです。そのため最大のマッチは `collateralAmountMax` と `collateralAmount` の両方で表示されます（担保レンジがない場合は、より少なくロックしうるものとして表示）。これを制限するのはローン開始時のチェックだけで、そのチェックの読み取りに失敗した場合はその旨を表示し、省略しません。段階制の体制では、チェックはティアのLTV上限も適用します。`getPartialFillEnabled` が true の間、マッチがロックしない担保は後のマッチのために保管庫に残り、リクエストが閉じたとき（残りの容量が `amount` を下回ったとき）または `cancelOffer` の実行時にのみ返金されます。

<a id="borrow-request-fill"></a>

### Borrow: リクエストの約定方法

`fillMode` は 0（Partial）、1（AON）、2（IOC）のいずれかで、投稿後は変更できません。AON は `amount` = `amountMax` を必要とし（`AonRequiresSingleValueAmount`）、IOC は `expiresAt` ≠ 0 を必要とします（`IocRequiresExpiry`）。フォームは拒否される組み合わせを提示しません。金額、金利、担保は、開いているリクエストで `setOfferAmount`、`setOfferRate`、`setOfferCollateral`、`modifyOffer` により変更できますが、`amountFilled` や `collateralAmountFilled` を下回ることはできません。このアプリはまだこれらを呼び出しません。

<a id="borrow-request-cadence"></a>

### Borrow: リクエストの利息スケジュール

`periodicInterestCadence` は 0（None）から 4（Annual）で、期間はそれぞれ 30・90・180・365 日です。フォームは `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` が認めるものを提示します。これは `createOffer` が適用するルールを、`amount`（レンジの最小端）で評価して実行します。拒否はそれぞれリバートデータから表示されます：`PeriodicInterestDisabled`、`CadenceNotAllowedForIlliquid`、または `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`。1期間の利息は `principal × rate × intervalDays / (10000 × 365)` です。支払いが遅れた期間は、猶予 `getEffectiveGraceSeconds(intervalDays − 1)` が過ぎると誰でも `settlePeriodicInterest` で精算でき、担保が売却されローンは継続します。キーパーパス `periodicSettle` の有効状態はケイパビリティサービスの報告どおりに表示され、既定では不明です。スケジュールは投稿後に変更できません。

<a id="borrow-request-tariff"></a>

### Borrow: リクエストのフル手数料タリフ

オプトインは `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)` で、作成者が `createOffer` の後に送り、貸し手がリクエストを受けた後は `OfferAlreadyAccepted` で拒否されます。`maxCStar` はゼロより大きくなければなりません（`FullTariffMaxCStarRequired`）。フォームはスイッチを `getFeeEntitlementConfig()` から、タリフを `quoteCStar(lendingAsset, principal, durationDays)` から表示し、範囲では `amount` と `amountMax` で読みます。上限の既定値は `amountMax` での見積もりです。各受諾で、手数料はそのローンの元本で算定した `C*` を取りますが、それはスイッチがオンで、元本に価格と流動性があり、`C* ≤ maxCStar` で、保管庫の空き VPFI（`getTrackedVPFIBalance` で上限を付けた保管庫残高から有効な担保権を引いたもの、`getFreeBalance` 経由）で足りる場合だけです。そうでなければ `FeeEntitlementDisabled`、`FeeEntitlementFullOptInFailed`、`FeeEntitlementTariffAboveAuth` で巻き戻ります。ただし `allowDowngrade` ならタリフなしでローンが開きます。借り手のローン手数料割引は `FULL_MODE_FEE_DISCOUNT_BONUS_BPS`（1000）上がり、`MAX_FEE_DISCOUNT_BPS`（5000）が上限です。確認画面はすべてのローンが拒否される選択を止め、オプトインは `getOffer` を読み直して測ります（`creatorFull`、`creatorMaxCStar`、`creatorAllowFullDowngrade`）。未充足リクエストへのバックストップ融資は、このアプリではまだ提供していません。

<a id="lend-start"></a>

### Lend: 仕組み

Lend は、ERC-20 担保に対する ERC-20 の借入リクエスト（`offerType` 1）を、貸し手が送る `acceptOffer(offerId, terms, signature)` で直接受けます。1回のトランザクションで、元本は Diamond への承認のもとで貸し手のウォレットから貸し手のボールトへ引き出され、借り手は組成手数料を差し引いた額を受け取り、借り手のボールトにすでにある担保がローンの担保となり、`LoanInitiated` が発行されて、貸し手と借り手にそれぞれポジション NFT が渡ります。貸出オファー（`offerType` 0）は同じページから掲載します。NFT の側は今後のアップデートで追加されます。

<a id="lend-offers"></a>

### Lend: リクエストを選ぶ

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` がペアの公開中オファーの id を返します。各オファーについて、ページは `getOffer`、`getOfferState`、`getOfferLinkedLoanId` と、ウォレットがあれば `previewAccept(offerId, wallet)` を読み取ります。その `errorCode` がプロトコルの拒否理由です。直接の受諾は、リクエストの `amount`（最小額）を `interestRateBpsMax` で確定し、ローン資産価値比率はその金額に対する今日の価格での `calculateLTV` です。貸し手のオファー、NFT の側、閲覧者自身のリクエスト、貸し手ポジションの売却手段（`getOfferLinkedLoanId` がゼロでない借り手側オファー）は件数のみで、一覧には出ません。並び順は、資金提供可能なものが先、次に利率の降順、次に金額の降順です。

<a id="lend-review"></a>

### Lend: 確認と署名

確認画面は Borrow と同じもの（オファー、その状態、`previewAccept`、`getOfferLinkedLoanId`、`getCurrentRiskTermsHash`、両方の分類、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、`getLifMatcherFeeBps`、ウォレットのボールト、`previewOfferAcceptBlock`、手数料割引の同意）に加えて `getTreasuryFeeBps` を読み取り、残高と承認額は貸し手が支払う側である貸出資産で測ります。そこに不足があれば署名はブロックされ、貸し手ポジションの売却手段も同様です。ウォレットは EIP-712 `AcceptTerms`（ドメイン `Vaipakam AcceptOffer`、バージョン 1）に署名し、承認額が足りない場合にのみ元本ちょうどを承認し（ゼロでない値同士の変更を拒むトークンには先にゼロにする手順を入れます）、`acceptOffer` をシミュレーションしてから送信します。途中で止まったフローが残した承認は Borrow と同様にリセットされます。結果として、このオファーの `LoanInitiated`、ウォレットからの元本の `Transfer`、マッチャー取り分が戻る `Transfer` を読み取ります。

<a id="lend-fee"></a>

### Lend: 手数料とプロトコルの取り分

手数料は `previewAccept` の `lifEstimate` で、借り手が負担します。貸出資産での元本の `getLoanInitiationFeeBps` で、借り手への受け渡し額から差し引かれ、受諾時に借り手の保有ティア割引で、また `creatorFull` が設定され課金が成功した場合は Full タリフのボーナスで下がります。送信者の取り分（手数料の `getLifMatcherFeeBps`）は送信者、ここでは貸し手に支払われます。利息に対するプロトコルの取り分は `getTreasuryFeeBps` で、ローン開始時にローンごとに固定されます（`treasuryFeeBpsAtInit`）。同意がオンなら、貸し手の保有ティア割引が利息の精算時にこれを下げます。確認画面には今日の料率と、その料率での取り分が上限として表示されます。

<a id="lend-risks"></a>

### Lend: リスク

猶予の終わり（期日から `getEffectiveGraceSeconds` 後で、一時停止の時間だけ後ろにずれます）を過ぎたローンは、誰でもデフォルトにできます。流動性のある担保は貸し手のために売却され、流動性のない担保はそのまま移転されます。両側に流動性がある場合、ヘルスファクターが 1 を下回るとローンは清算でき、売却はまず貸し手に支払います。流動性のない側があると価格に基づく清算はなく、デフォルト時に貸し手は担保をすべて受け取ります。`useFullTermInterest` は早期返済時の利息に下限を設け、これがなければ利息は日割りです。定期利息のスケジュールでは、未払いの期間は担保の強制売却によって貸し手に支払われます。貸し手のポジション NFT が請求権を持ち、それを移転するとローンも移転します。

<a id="lend-offer"></a>

### Lend: 自分のオファーを出す

貸出オファーは、貸し手のウォレットから送る `offerType` 0 の `createOffer` で、両側とも ERC-20 です。貸出資産の `amountMax` を貸し手のボールトに引き出し（ボールトがなければ作成し）、`OfferCreated(offerId, creator, 0)` を発行します。借り手は `acceptOffer` で受けます。借り手の担保は借り手のボールトに引き出され、手数料を差し引いた元本が借り手のウォレットに届き、手数料のうち送信者の取り分は送信者である借り手に渡ります。`getPartialFillEnabled` が true の間は、`matchOffers` が借り手のリクエストと組み合わせることもあり、その場合、単一値の貸出オファーは自らの金利で全額を貸し、担保は少なくとも `collateralAmount` になります。`cancelOffer` は作成から `MIN_OFFER_CANCEL_DELAY`（5分）後に作成者が、期限切れ後は誰でも呼べます。金額は常に作成者に戻ります。

<a id="lend-offer-terms"></a>

### Lend: オファーの条件

パートがない貸出オファーは単一値です。`amount` = `amountMax`、`interestRateBps` = `interestRateBpsMax`、`collateralAmount` = `collateralAmountMax`（借り手がロックすべき唯一の担保額）、`fillMode` 0（Advanced で別の方式を指定しない場合。次の節を参照）、`periodicInterestCadence` 0（Advanced でスケジュールを指定しない場合）、`allowsPrepayListing` と `allowsParallelSale` は false、`refinanceTargetLoanId` 0、`creatorRiskAndTermsConsent` は true で、Advanced で選ばない限り Full タリフは設定しません。金額は基本単位に正確に解析され、金利は最大 10,000 bps です。`durationDays` は `getProtocolConfigBundle` から読む設定上の最大値で上限が決まります。`expiresAt` は 0（キャンセルまで有効）か、確認画面を開いた時点の最新ブロックから決めた時刻で、最長 `MAX_OFFER_EXPIRY_HORIZON`（365日）先までです。`useFullTermInterest` の既定は true、`allowsPartialRepay` の既定は false です。

<a id="rate-check"></a>

### 金利を最近のローンと比べる

両方の投稿フォームは、同じ貸付資産・担保資産・期間についてインデックスの `/loans/recent` を読み（貸し手の売却用オファーは除外）、直近30日に始まり、インデックスの台帳が裏づける合意金利を持つローンだけを残します（条件が確認されていないローンは除きます）。比較の基準はそれらの金利の中央値で、件数が偶数のときは中央の2つのうち低い方を使い、合意された2つの金利の間に存在しない金利を作りません。そこから5パーセントポイント（500 bps）を超えて離れた金利は、向きを示す警告になります。大きく低い貸し手、または大きく高い借り手は、金利が動いたときに真っ先に取られるオファーを出し、逆の向きではオファーが取られずに残るかもしれません。その幅の内側では、中央値と件数を示す注記になります。1回の読み取りは最新100件までで、上限に達すると最新分だけを読んだと注記します。依頼したペアと期間に絞られていないインデックスの応答は比較せずに拒否し、NFT担保は比較せず、読み取りに失敗したときはそう表示します。レビューを止めることはありません。 インデックスが条件を確認していないこのペアのローンはどの期間にも属しません。インデックスはその件数（`unplaced`）を数え、フォームは比較の横にその件数を示すので、「確認済みのローンなし」が期間不明のローンを隠すことはありません。

<a id="public-queue"></a>

### 公開待ち行列のあるネットワーク

Ethereum、BNB Chain、Polygon（および BNB Testnet と Polygon Amoy）では、送信したトランザクションは取り込まれる前に公開の待ち行列で待ちます。その待ち行列を見ている人（ボットを含む）は誰でもそれを見て先に動けます。キャンセルが届く前にオファーを取る、返済が届く前にローンに手を出す、といったことです。そのためこれらのネットワークでは、オファーの投稿・受諾・キャンセル、返済、担保の追加のレビューで、ウォレットが開く前にその旨を表示します。トランザクションを非公開で送れるウォレットもあります。ウォレットのネットワーク設定やセキュリティ設定を確認してください。アプリがその経路を代わりに選ぶことはできず、通常の方法で送っても変わるのは、届く前に誰がトランザクションを見られるかだけです。Base、Arbitrum、Optimism には公開待ち行列がないため、何も表示されません。 対象ネットワークはアプリ内の一つのルールです（Ethereum 1、BNB Chain 56、BNB Testnet 97、Polygon 137、Polygon Amoy 80002）。アプリが対応するネットワークが未判定ならテストが失敗します。通知はレビュー内、最後の再確認とウォレットの前に、次の操作に限って表示されます：オファーの投稿・受諾・キャンセル、全額返済と一部返済、担保の追加。ヘルプは非公開送信サービスの名前を挙げません。ウォレットがどの経路を使ったかをプロトコルは確認できず、どちらの経路でもトランザクションの効果は同じだからです。

<a id="lend-offer-parts"></a>

### Lend: パートに分けて貸すオファー

パートでは `amount`（1回のマッチで貸せる最小パート）を `amountMax`（全額。`createOffer` がボールトに引き込む）より小さく送ります。`collateralAmount` = `collateralAmountMax` は `amountMax` に対する唯一の要件のままで（そうでなければ `LenderCollateralRangeNotAllowed`）、`interestRateBps` = `interestRateBpsMax` です。貸出オファーへの直接の `acceptOffer` は `collateralAmount` に対して `amountMax` を貸し、それができるのは `amountFilled` が 0 の間だけです（マッチ後は `OfferPartiallyFilled`）。`getPartialFillEnabled` が true の間、`matchOffers` は金額の重なりの中点（最低 `amount`）を、金利の重なりの中点で、少なくとも `collateralAmount × matchAmount ÷ amountMax`（切り捨て。借り手の担保レンジで増えることがあります）に対して貸します。`amountMax − amountFilled` が `amount` を下回ると、残額は貸し手のウォレットに引き出され、オファーは閉じます（`OfferClosed`、理由 `Dust` または `FullyFilled`）。一部約定したオファーへの `cancelOffer` はクールダウンを省き、`amountMax − amountFilled` を返します。`fillMode` はリクエストと同じく 0、1、2 で、AON は `amount` = `amountMax`、IOC は期限を要し、掲載後は変わりません。両方のレッグが流動的なとき、`createOffer` は `amountMax` での下限を下回る `collateralAmount` を `MinCollateralBelowFloor(provided, floor)` で拒否し、確認画面はその下限を示します。表示される LTV は (`amountMax`, `collateralAmount`) での `calculateLTV` ひとつで、パートも端数を除けば同じ比率です。

<a id="lend-offer-schedule"></a>

### Lend: オファーの利息の支払いスケジュール

貸出オファーの `periodicInterestCadence` はリクエストのルール（上記）に従い、`previewCadenceAdmission` はオファーの `amount`、つまり最小パート（パートがなければ全額）で評価されます。`createOffer` はそこで `requireCadenceAdmitted` によって認め、各ローンの組成時には自身の元本で改めて確認します（`requireOriginationCadenceAdmitted`）。確認画面は1期分の利息を `amountMax`（直接の引き受け）で、パートがあれば `amount` でも示します。支払われなかった期は猶予期間の後、誰でも `settlePeriodicInterest` で精算できます。担保を売ってその期の利息を貸し手に支払い、ローンは続きます。

<a id="lend-offer-tariff"></a>

### Lend: オファーのフル手数料タリフ

貸し手のオプトインも同じ `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)` で、`createOffer` の後に送ります。オファーが全額引き受けられるか閉じると `OfferAlreadyAccepted` で拒否されます。一部がマッチしたオファーはまだ受け付け、以後のローンに適用されます。見積もりは `amount` と `amountMax` での `quoteCStar` で、上限の既定値は `amountMax` での見積もりです。各ローンは元本で価格付けされ、個別に `maxCStar` と照合され、条件はリクエストと同じです（`FeeEntitlementDisabled`、`FeeEntitlementFullOptInFailed`、`FeeEntitlementTariffAboveAuth`、または許可されている場合の格下げ）。貸し手の確認には保管庫の現在の空き VPFI を使います。タリフが取られるとローンの `lenderMode` が Full になり、以後の貸し手の利回り手数料の精算ごとに、プロトコルの取り分に対するポジション保有者の割引に `FULL_MODE_FEE_DISCOUNT_BONUS_BPS`（1000）が加わります。上限は `MAX_FEE_DISCOUNT_BPS`（5000）で、保有割引の同意の有無は問いません。その場での延長（`repriceFeeEntitlementOnExtension`）は、新しい期間についてこの記録を None にします。

<a id="lend-offer-review"></a>

### Lend: オファーの確認と掲載

確認画面はウォレットから `createOffer` をシミュレートし、両資産の区分、`getEffectiveGraceSeconds(durationDays)`、`getLoanInitiationFeeBps`、`getTreasuryFeeBps`、最長期間、ウォレットのボールト、貸出資産（貸し手がロックする側）の残高と承認額、両側が流動的な場合の `calculateLTV` を読みます。毎ブロック、およびウォレットが開く直前に読み直します。承認額が足りない間、シミュレーションは金額の引き出しまでしか届かないため、トークンの引き出しエラー、`VaultDepositFailed`（データなしで巻き戻った引き出しをプロトコルが包んだもので、WETH は承認不足でこうなります）、プロトコルのエラー名のない巻き戻しは、解消すべき承認として示されます。これはリクエストの確認と同じ規則で、それ以外の名前付きプロトコルエラーは拒否です。金額ちょうどの承認の後、`createOffer` を再びシミュレートして送信します。承認の後に止まった場合、ほかに変更がなければ承認額を以前の値に戻します。結果として、このウォレットの `offerType` 0 の `OfferCreated` と、金額のボールトへの `Transfer` を読みます。

<a id="lend-offer-fee"></a>

### Lend: オファーにかかる手数料

`createOffer` は貸し手に何も課しません。表示される手数料は借り手のもので、貸出資産での金額の `getLoanInitiationFeeBps` です。`acceptOffer` 実行時に有効な料率で計算され、その時点の借り手の保有ティア割引で下がり、借り手への送金額から差し引かれます。表示額は今日の料率によります。利息のうちプロトコルの取り分は `getTreasuryFeeBps` で、ローン開始時にローンごとに固定されます（`treasuryFeeBpsAtInit`）。同意がオンなら、利息の精算時に貸し手の保有ティア割引がそれを下げます。確認画面は今日の料率と、その料率での取り分を上限として示します。`getTreasuryFeeBps` の読み取りに失敗した場合はそう示し、取り分も戻る額も表示しません。

<a id="positions"></a>

### Positions: 一覧の読み方

Positions は共通のリーダーを通して Home と同じ保有一覧を読みます。`getUserPositionLoansPaginated` がウォレットの保有するポジション NFT をたどり、`getLoansBatch` がそれらを読み込み、各サイドは保有しているトークン（`lenderTokenId` または `borrowerTokenId`）から決まり、組成時に記録された当事者からは決めません。状態が Active または FallbackPending のローンは進行中で、期限・ヘルスファクター・グループ化は Home で説明したとおりです。それ以外の状態はすべて終了扱いで、新しいローン id から順に、`LoanStatus` の名前で示します: Repaid、Defaulted、Settled、InternalMatched（マッチングで終了）。アプリが知らない状態番号は番号のまま表示します。支払いは Home で説明した claimables のルールに従います: 他の人から受け取った終了ローンの保有ポジションは数として示し、推測はしません。

サイドの選択は、支払い・進行中・終了の各行を保有サイドで絞り込みます。「何もない」と表示するのは、ポジションと支払いのたどりが両方完了し、最新の読み取りが成功したときだけです。上限で止まったたどりは不完全と表示します。行は `/positions/<id>` を開き、そこで適格性の判定が各操作を決めます。一覧はトランザクションを送りません。

サイドを選んだ後に進行中の行が2件以上あるときは、最初にまとめカードが表示されます。サイドごとに、ERC-20の`principalAsset`ごとに`principal`を合計し、トークンをまたいで合算することはありません(価値の比較はエクスポージャーの行が担います)。元本がNFTの行はレンタルとして件数で数えます。次の日付は、各行が使うステージのうちまだ来ていない最も早いものです。進行中または期日間近の満期(返済)、または次の定期チェックポイント(利息)で、同じ日付ならローンIDの小さい方を取ります。猶予期間が終わったローン(満期またはチェックポイントで)、猶予期間中のローン、FallbackPendingのローンはIDで列挙され、それぞれ最も深刻なステージの下に一度だけ表示されます。期限を読み取れなかったローンは件数で数えます。利息は含まれません。カードはリスト自身の読み取りだけを使い、走査が途中で止まった場合はそう示します。NFT元本の行の満期はレンタルの終了（`rental-close`）であり、返済ではありません。レンタルは前払い賃料で終了するため、サマリーも各行と同じ呼び方をします。

<a id="position"></a>

### Position: ローンの読み方

ページは `getLoanDetails(loanId)` と、貸し手・借り手のポジション NFT の保有者（デプロイメントが記録する PositionNFT コントラクト上の `ownerOf`。#3205 より前のデプロイメントでは Diamond 自体の `ownerOf`）を読みます。役割はウォレットが今保有しているトークンです。進行中のローン（Active または FallbackPending）では、`getLoanDeadlines`（停止クレジット前の現在の期間の満期。延長や借り手の引き継ぎで書き換わります、停止クレジット、満期、猶予期間の終了）、利払いスケジュールがあれば `getPeriodicInterestEnabled` とともに `previewPeriodicSettle`、`isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`)、`calculateHealthFactor`、`calculateLTV` を読みます。すべてのローンで `getLoanCollateralLien` と `isSaleVehicleLoan` を読みます。各読み取りは独立しており、失敗したものは 0 ではなく不明と表示し、日付を `startTime` と `durationDays` から計算することはありません。

価格のあるローンでは `getInternalMatchConfigBundle` も読みます。内部マッチングが有効な間、LTVがしきい値からしきい値＋`externalLiquidationPriorityWindowBps` までにあるローンは内部マッチング用に確保され、外部の清算ルートはすべて拒否します（`InternalMatchOnlyBand`）。ページはその範囲を示します。`loanInitiationFeeBpsAtInit` が 0（料率が記録される前に開始したローン）の場合は未記録と表示し、`treasuryFeeBpsAtInit` が 0 の場合は決済が適用する従来の1%として表示します。現物引き渡しの警告はERC-20ローンのみが対象です。NFTレンタルには担保がなく、デフォルトすると借り手の利用が終わり、前払いの賃料はトレジャリーの取り分を差し引いて貸し手へ支払われ、バッファはトレジャリーへ送られます。ページは代わりにそれを示します。

料率はローンのスナップショットです: `treasuryFeeBpsAtInit`、`loanInitiationFeeBpsAtInit`（売却用ローンではなし）、`liquidationLtvBpsAtInit`。片側が Illiquid（`principalLiquidity` または `collateralLiquidity`）のローンには価格に基づく値がありません: プロトコルはそのローンの `calculateHealthFactor` と `calculateLTV` を拒否し、ページは不明ではなくその旨を表示します。`principal` は残りの元本です（一部返済で減ります）。`interestRateBps` と `collateralAmount` も変わり得るため、条件は現在の値で表示します。記録上の元本がない終了済みローンは、内部マッチングでカバーされたかどうかを示し、そうでなければ記録がないことだけを示します。NFT レンタルは 1 日あたりの賃料(`principal`、`prepayAsset` 建て)と、早期返却でも残り日数分すべてが請求されるか(`useFullTermInterest`)を表示します。`getPeriodicInterestEnabled` が false の場合、チェックポイントで担保は売却されないと表示します。進行中のローンで `collateralLiquidity` が Illiquid の場合は現物決済の警告を加えます: デフォルト時は売却せずに担保を貸し手へ移転します。最初のトランザクションは全額返済です（下記）。

<a id="repay"></a>

### 全額返済: 金額の決め方

この操作は 1 つのルールに従います: `repayLoan` は、Active または FallbackPending の ERC-20 ローンについて、`loan.lender` でも `ownerOf(lenderTokenId)` でもない任意のウォレットに提示されます（`LenderCannotRepayOwnLoan`）。Active のローンでは実効的な猶予期間の終了後に止まり（`RepaymentPastGracePeriod`）、借り手ポジションの開いているルートが `SwapToRepayIntent` の間も止まります（Diamond 上の `positionRoute(borrowerTokenId)`。#3205 より前のデプロイメントでは `positionLock(borrowerTokenId)`）。貸し手の売却出品、借り換えリクエスト、全体の一時停止では止まりません。レンタルはまだここでは提示しません。

確認画面は `calculateRepaymentAmount(loanId)` を最新ブロックで読み、さらにブロック時刻を `min(now + 30 分, 猶予期間の終了)` に上書きして読みます。同じリクエストで実行時のブロック時刻も読み、上書きを無視した接続は使いません。承認額は 2 つ目の数値ちょうどで、ウォレットを開く前に呼び出しをシミュレーションします。受領後は、返済がローンを残した状態をその `LoanRepaid` ログから読み（ブロック時点の状態ではありません。同じブロックの後続の請求で既に清算済みになっている場合があるためです）、支払額を `Transfer` ログから測り、allowance が承認額から支払額を引いた値を示す場合は以前の値に戻します。その数値を超える allowance（無制限を含む）も同じ数値まで下げます。`repayLoan(loanId)` には上限も期限もないためです。戻す処理では、その後に元の大きい値に戻します。

猶予期間中（`getLoanDeadlines` による `maturity ≤ now ≤ graceEnd`）、全額返済と一部返済の確認画面はチェーンの時計で `graceEnd` までカウントダウンします。チェーンの時刻は、確認画面が読んだブロックのタイムスタンプにその後の経過秒数を足して推定します。`block.timestamp > graceEnd` になると `repayLoan` と `repayPartial` は `RepaymentPastGracePeriod` でリバートし、以後 `triggerDefault` は誰でも呼べるため、遅れた返済はデフォルトと競争になります。残り1時間以下では、今すぐ送るよう表示します。表示のみであり、送信前に読み直す判定がゲートです。一時停止は `graceEnd` を後ろへずらします。ブロックを埋めて返済を猶予期間後まで遅らせる攻撃は、脅威モデルで許容する低リスクとして記録しています。

<a id="interest-schedule"></a>

### 利息スケジュール: 読み取り方

ケイデンスのある Active な ERC-20 ローンについて、カードは `previewPeriodicSettle(loanId)`（ケイデンス、`periodEndAt`、`graceEndsAt`、`expected`、`paidByBorrower`、`shortfall`、`canSettleNow`）、`getPeriodicInterestEnabled()`、`paused()` を読み取り、読み取ったブロック時刻を表示します。`expected` は現在の `principal` と `interestRateBps` での1期間分です。`periodEndAt` にはローンの一時停止クレジットが含まれます。

プレビューの `canSettleNow` はスイッチと一時停止を考慮しないため、カードは `settlePeriodicInterest` 自身の順序でそれらを組み合わせます: オフ（`PeriodicInterestDisabled`）、一時停止（`whenNotPaused`）、次に期間の時刻（`graceEndsAt` より前は `PeriodicSettleNotDue`）。売却を告げるのは、スイッチがオンでプロトコルが停止していないときだけです。読み取れなかったスイッチや一時停止は不明と表示します。不足がゼロなら、精算はチェックポイントを進めるだけです。キーパーの `PERIODIC_SETTLE` の有効化はアプリに報告されないため、カードは精算が誰にでも開かれていること、キーパーの状態は不明であることを表示します。

<a id="partial-repay"></a>

### ローンの一部を返済する: 金額の決まり方

`repayPartial(loanId, amount)` は元本 `amount` と、`interestAccrualStart` 以降に発生した利息(定期クレジット控除後)を受け取ります。利息はまず、売却前の利息がまだ未払いの以前の保有者に支払い(`paySellersFirst`)、次に現在の貸し手ポジション保有者に支払い、トレジャリーの取り分を分け(プロトコルが凍結すべき保有者の場合、その取り分は代わりに貸し手のボールトへロックして預けられます。`freezeOrPayActiveLenderFromPayer`)、`principal` を減らし、利息の時計を再開し、現在の期間に計上します。満期は動きません。猶予期間の終了後、`principal × minPartialBps / 10000`(`getAssetRiskParams`)未満、元本全額以上(`PartialWouldRetireFullPrincipal`)、有効なインテントコミットや借り換えリクエストがあるとき、そして流動性のあるローンでヘルスファクターが悪化するときは拒否します。

呼び出し前に一部返済の利息を返すビューはないため(#3299)、確認画面では今と少し先の時点で読んだ `calculateRepaymentAmount` から `principal` を引いた値を使います。満期までの日割りローンでは正確ですが、`useFullTermInterest` では残り期間の最低利息、満期後は延滞料を含むため「最大」と表示します。承認額は返済額とその上限値の合計ちょうどです。完了カードは、支払い自身の `PartialRepaid` ログの `newPrincipal`（ブロック時点の `principal` ではありません。同じブロックの後続トランザクションで変わりうるためです）、ウォレットからの流出、その後の `previewPeriodicSettle` を測定します。レビューがウォレットを止めるのは、部分額、または部分額と正確な利息に残高が足りないときだけです。上限の数字だけが残高を超える場合は、支払いを送る直前のドライランが判断します。

<a id="add-collateral"></a>

### 担保の追加：何が確認されるか

`addCollateral(loanId, amount)` は、ローン自身の担保トークンをちょうど `amount` だけ呼び出し元から借り手のボールトへ引き出し、`collateralAmount` と担保リーエンを増やし、新しいヘルスファクターと LTV を含む `CollateralAdded` を発行します。進行中の swap-to-repay コミット、`ownerOf(borrowerTokenId)` 以外の呼び出し元、Active でも FallbackPending でもないローン、レンタル、一時停止中の担保資産（`isAssetPaused`）、`checkLiquidity` が Liquid と報告しない担保を拒否します。`whenNotPaused` は付いていません。入金先は記録された `loan.borrower` のボールトです。Active のローンは先に移転済みポジションを保有者へ統合する(`consolidateToHolder`)ため保有者のボールトになり、FallbackPending のローンは回復するまで統合されないため、レビューは記録されたボールトを示します。追加したトークンは清算やデフォルトで消費される `collateralAmount` に含まれ、レビューはそのことを伝えます。

アプリはこれらの入力を読み取り、資産の 2 つの確認はローン開始時の区分ではなく現在の状態で行い、ドライランがプロトコルの最終判断となります。追加後のヘルスファクターを返すビューはないため、確認画面は現在の `calculateHealthFactor` と `calculateLTV` を示し、完了カードは取引の `CollateralAdded` ログから新しい数値を読み取ります。FallbackPending のローンでは、新しいヘルスファクターがローンの最低値に達し、LTV が開始時の上限内に収まると追加によって回復します。完了カードは `LoanCuredFromFallback` を確認します。金額以上の既存の承認はそのまま残します。引き出されるのはちょうどその金額だからです。小さい承認はちょうどその金額まで上げ、追加が成立しなければ元に戻します。

<a id="take-back-collateral"></a>

### 担保の引き出し: 確認される内容

`partialWithdrawCollateral(loanId, amount)` は借り手のボールトから呼び出し元のウォレットへ担保を `amount` 送り、`collateralAmount` と担保リーエンを減らし、新しいヘルスファクターとLTVを含む `PartialCollateralWithdrawn` を発行します。`whenNotPaused` が付いており、次の順に拒否します: 制裁対象の呼び出し元、有効なスワップ返済コミット、有効なリファイナンス依頼(`RefinanceRequestOpen`)、紐づいた売却出品(`SaleListingActive`)、`ownerOf(borrowerTokenId)` 以外の呼び出し元、Active でないローン、担保を超える金額、`checkLiquidity` が Liquid と報告しない担保、最低ヘルスファクターを下回るか開始時のLTV上限を超える結果。

フォームは金額を `calculateMaxWithdrawable` と照合します。これは Active でないローンや非流動的な担保ではゼロで、利息の発生とともに下がります。紐づいた売却出品を返すビューはないため、確認画面で引き出しをドライランし、その拒否を表示します。送信時にも再度実行します。完了カードは、残った担保と新しい数値をトランザクションの `PartialCollateralWithdrawn` ログから、受け取った金額をウォレットへのトークンの `Transfer` から読み取ります。保護アカウントモードの呼び出し元の場合、ボールトの支払いゲートは引き出しを支払わずにアカウントの遅延期間だけキューに入れる(`PayoutQueued`)ため、レビューは `getProtectedAccount` を読み、完了カードはそのログを読みます。

<a id="collect-a-payout"></a>

### 支払いを受け取る: 確認される内容

`claimAsLender(loanId)` と `claimAsBorrower(loanId)` には `whenNotPaused` が付いており、その側に記録された当事者(`loan.lender` / `loan.borrower`)のボールトから呼び出し元へ支払います。呼び出し元はその側のポジショントークンの `ownerOf` でなければなりません。貸し手は Repaid、Defaulted、FallbackPending、InternalMatched のローンで請求でき、借り手は Repaid、Defaulted、InternalMatched のみです。貸し手の請求は、請求済みの行(`AlreadyClaimed`)を保有者確認の前に、未払いのない側(`NothingToClaim`)をその後に拒否します。強制クローズがゼロで記録した行も実行され、ポジションを閉じます。借り手の請求は担保の行と余剰の行の両方が空か請求済みのときだけ拒否し、それぞれを各自のフラグで支払います。別のトークンでローンのリーエン下に残る担保も合わせて支払われます。

確認画面は `getClaimable`(貸し手の行は過去の売り手分を差し引き済みで、`getSellersShareOfLenderClaim` を併記)、`getBorrowerSurplusClaim`、`getLoanCollateralLien` を読み、請求をドライランします。ドライランでは制裁チェックも適用されます。一覧はポジショントークンに従います。`getUserDashboardClaimables` は記録された当事者の請求を列挙するため、列挙された行はウォレットがその側を保有している間だけ残り、他人から受け取った終了済みローンのポジションは請求を直接読みます。完了カードは `LenderFundsClaimed` / `BorrowerFundsClaimed`、`BorrowerSurplusClaimed`、`LoanSettled` と、ウォレットへのトークン送金を読みます。保護アカウントモードの呼び出し元の場合は `PayoutQueued`(アカウント自身のボールト)、`PayoutHeldInVault`(ロック中またはキューが満杯)、`PaymentCreditedToVault`(他の当事者のボールト)を読みます。FallbackPending のローンでは貸し手の請求が請求時の内部マッチを実行して行を書き換えることがあるため、完了カードは送金をプロトコル自身の記録と比較します。

<a id="claim-everything"></a>

### すべてを受け取る：何が確認されるか

一括処理は `multicall(calls)` を通り、各呼び出しをプロトコル自身への `delegatecall` で実行するため、`msg.sender` はあなたのウォレットのままで、各呼び出しが自分のルールを確認します。受け付けるのは最大 30 件で、アプリは各呼び出しを `allowFailure` 付きで送るため、拒否された呼び出しだけが取り消され、一括処理は続きます。呼び出しは `claimAsLender` / `claimAsBorrower(loanId)`、保持中の報酬も解放する `claimInteractionRewardsTo(Vault)`（報酬プレビューが完了できないが `getRewardSanctionsStatus` が Deliver を示す場合は `claimHeldInteractionRewards(Vault)`）、`getLenderIntentsByOwner` の各インテントの `availableCapital` に対する `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)`、VPFI の `freeHolding` に対する `withdrawVPFIFromVault(amount)`、そして受益者がウォレットである `getPayrollStream` の各ストリームに対し `getWithdrawableSalary` の額で `withdrawSalary(streamId)` です。FallbackPending のローンに対する貸し手の請求は、請求時のマッチングが支払額を決めるため除外されます。レビューは一括処理を試行し、各呼び出しの `success` とリバートデータを読み、拒否された呼び出しはデコードしたエラーとともに除外し、送信時にもう一度試行します。完了カードは各呼び出し自身のイベント (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`) を読み、イベントのない呼び出しはスキップされたものです。ウォレットへのトークン送金と、保護モードの `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault` は、受け取った呼び出し全体でトークンごとに合計されます。一時停止（すべての呼び出しにある `whenNotPaused`）とフラグ付きウォレットは、署名前に一括処理を止めます。

<a id="payout-queue"></a>

### 支払いキュー: 確認される内容

一覧は `getPendingPayoutIds(account)` で、各行に `getPendingPayout(id)` と `requestCode(id)` を読みます。コードは通知と同じ共有レンダラーで6文字の base32 として表示され、行はブラウザの時計ではなく最新ブロックのタイムスタンプに対する `releaseAt` の順に並びます。`releasePayout(id)` は誰でも呼び出せますが、一時停止中は `isEscapeOpen()` になるまで拒否されます。受取人が管理者(アカウント、または引退後はそのコントローラー)でもなく `getAllowlist` にも載っていないキュー中の行は、時刻の確認より前に、支払われる代わりに取り消されます。それ以外の場合、行は期限が来ており、アカウントはロックされておらず(`ProtectedVaultLocked`)、`requireCosign` がオンの間は共同署名済み(`CosignRequired`)である必要があり、受取人は再びスクリーニングされます。`cancelPayout(id)` は管理者または署名者のもので(`NotManagerOrSigner`)、一時停止中も使え、資産を再び引き出せるよう預入台帳に計上します。`cosignPayout(id)` は `getProtectedSigners` の署名者のもので(`NotSigner`)、アプリはアカウントがそれを必要とし、行がまだ共同署名されていない間だけ提示します。各操作は確認画面でドライランとして実行され、送信時にも再度実行されます。完了カードはその id の `PayoutReleased`(金額とプロトコルが測定した `delivered`)、`PayoutCancelled`、`PayoutCosigned` を読みます。keeper の `protectedAccount` パスが期限の来た行を解放するかどうかはケイパビリティサービスの回答で、既定では不明です。ロックはキュー中のすべての行を取り消します。

<a id="seller-interest"></a>

### 売却したポジションの利息：確認される内容

売却は、売り手が得てまだ支払われていない利息を請求として記録します。`getInterestLedger(loanId)` は未決の請求を古い順に、それぞれの総額とともに一覧します。`claimAsSeller(loanId)` には `whenNotPaused` と制裁チェックがあります。請求が残る Repaid、Defaulted、Settled、InternalMatched のローンでは、まず貸し手の回収額（`getSellersShareOfLenderClaim`）を分配し、各請求に純額（総額からローンの `treasuryFeeBpsAtInit` の取り分を引いて切り捨て。記録がないローンは従来の 1%）まで支払って、すべてを閉じます。FallbackPending のローンは分配しません。その後、元本トークン、および異なる場合は貸し手請求のトークンについて、`getSellerInterestHeld(loanId, seller, asset)` を売り手自身のボールトから売り手のウォレットへ引き出し、ゼロなら `NothingToClaimAsSeller` で拒否します。アプリは、売り手としてウォレットに紐づくインデックスのアクティビティ（`SellerInterestClaimRecorded`、`SellerInterestPaid`、`SellerInterestClaimClosed`、`SellerInterestWithdrawn`）からローンを一覧し、番号での検索はチェーンだけを読みます。元本トークンでは、レビューは分配額からウォレットの取り分を正確に算出します。別のトークンでは分配は価値ベースで、実行時に決まると明記します。引き出しはレビューでドライランし、送信時にも再度実行します。完了カードは `SellerInterestClaimClosed`（支払額、入金額、全額支払い）と `SellerInterestWithdrawn` を読み、保護モードが支払いをキューに入れた、または保持した場合は `PayoutQueued` または `PayoutHeldInVault` も読みます。

<a id="frozen-proceeds"></a>

### 凍結された支払い：何が確認されるか

アプリは `getSanctionsOracle`（ゼロならこのチェーンにスクリーニングなし）、`sanctionsStatus(wallet)`（Clean、Flagged、またはスクリーニングがリバートしたときの Unavailable）、`isSanctionsConfirmedFlagged(wallet)`（`refreshSanctionsFlag` が確定的な読み取りから同期する登録簿）を読み取ります。Flagged、またはウォレットが登録済みの Unavailable は凍結と読みます。未登録の Unavailable はそう読みません。`claimAsLender` と `claimAsBorrower` は `whenNotPaused` の後に呼び出し元をスクリーニングし、障害は通します。プロトコルが記録した当事者のために支払いを凍結した側は fail-closed で解放され、その当事者が Clean と読まれるまで、その時点で誰がポジションを持っていても `SanctionedAddress` または `SanctionsOracleUnavailable` でリバートします。プロトコルはその記録された当事者を参照するビューを持たないため、アプリはそこではドライランに頼り、その拒否を同じ言葉で伝えます。`claimAsSeller` はフラグ付きの売り手を、また障害中は登録済みの売り手を拒否します。ローンの進行中、フラグ付きの保有者のために保留された貸し手の取り分は `getClaimable(loanId, true)` の `heldForLender` に加算され、貸し手のクレームが支払うまで記録上の貸し手のボールトに確保されます。フラグ付きの借り手でも返済はできますが、担保の追加はできません。

<a id="extension-reserves"></a>

### 延長用リザーブ：何が確認されるか

`fundExtendReserve(loanId, amount)` は、借り手ポジション保有者のウォレットからローンの元本トークンを本人のボールトに預け入れ、そのローン用に確保します。`whenNotPaused` と制裁スクリーニングを伴い、ローンが Active で、ERC-20 ローンで、定期的な利払い間隔がない場合を除き拒否されます。`getExtendFunding(loanId, holder)` はトークン、`reserved`、保有者のその他の自由残高、延長が現時点と期間終了時に請求する額を返します。延長は現在の保有者のボールトからのみ、リザーブを先に請求します。`withdrawExtendReserve(account, loanId, amount)` は `whenNotPaused` を伴い、呼び出し元がアカウントの管理者（本人のウォレット、または置き換え後のコントローラー）であることを求め、呼び出し元をスクリーニングし（障害時は通過）、確保額を超えると `ExtendReserveInsufficient` で取り消されます。ローンの状態にかかわらず利用できます。アプリはウォレットに紐づくインデックスのアクティビティ (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`) からローンを一覧にし、番号での検索はチェーンだけを読みます。レビューが読み取ったリザーブ全額を引き出し、呼び出しをレビュー時と送信時に試行し、完了カードは `ExtendReserveWithdrawn`（金額と、確保されたまま残る額）を読み、保護モードが支払いをキューに入れたり保持したりした場合は `PayoutQueued` または `PayoutHeldInVault` も読みます。

<a id="vault-holdings"></a>

### あなたのボールト：何が読まれるか

ボールトは `VaultFactoryFacet.getUserVaultAddress(wallet)` です。`getOrCreateUserVault(wallet)` がこれを作成し（ティア1の制裁チェック、一時停止ゲートなし）、完了カードは `UserVaultCreated` を読みます。資産ごとに同じブロックで読むのは、ボールト自身の残高（ERC-20 は `balanceOf`、ERC-721 は `ownerOf`、ERC-1155 は `balanceOf`）、`getTrackedHolding`、`withdrawableNow`、`untrackedHolding` です。「ボールト内」は残高と追跡保有量の小さい方、「今すぐ引き出し可能」は返された `withdrawableNow` そのもの（入金保有量を `freeHolding`、つまり追跡量からリーエンと保護モードの留保を引いた量で上限としたもの）、「ポジションが保持中」は計上量からそれを引いたものです。資産は `getDepositoryAssets(wallet, offset, limit)` から、返された総数までページごとに読みます（その前の空ページは不完全として扱います）。一覧の各コントラクトの規格は ERC-165 で読み、さらに `getUserLoansPaginated(wallet)` のすべてのローンと、ウォレットがポジションを保有するすべてのローンの各レッグ（貸し出し資産、担保、レンタルの前払い手数料トークン）を同じブロックで `getLoanDetails` により読み、これまでに作成したすべてのオファー（`getUserOffersPaginated(wallet)`、各件を `getOffer` で読む）の各レッグも加えます。オファーの預け入れは、ポジションNFTを譲渡した後も作成者のボールトに残るためです。`getLenderIntentsByOwner(wallet)` の各常設オファー（取り消し済みを含む）が貸し出す資産も加えます。常設オファーへの資金投入は、入金記録に載せずにその資産をボールトへ入れるためです。記録は NFT のトークンIDを保持しないため、入金済みの NFT コレクションはすべて注記で名前を示し、数値付きで一覧に出るのはローンかオファーが指すトークンだけです。ダストとは、ゼロより大きく、トークン1枚の 1e-11 未満の計上量です。

<a id="vault-deposit"></a>

### ボールトに入金する

入金は `VaultDepositoryFacet.depositToVault(kind, asset, tokenId, amount)` です。kind は 0 が ERC-20、1 が ERC-721、2 が ERC-1155 で、ERC-20 のトークンIDは 0、ERC-721 の数量は 1 です。`whenNotPaused` で、呼び出し元を審査し（Tier-1）、置き換えで退役したウォレットを拒否します（`requireManager`）。レビューは同じブロックで `getUserVaultAddress`、`paused`、制裁審査の状態、`getProtectedAccount(wallet)`、ウォレットの残高と承認を読みます。読めなかった停止・審査・退役はその旨を示し、ドライランが判断します。承認は ERC-20 なら厳密な `approve`（先にゼロへ戻す必要があるトークンは2段階）、ERC-721 なら `approve(diamond, tokenId)`、ERC-1155 なら `setApprovalForAll(diamond, true)` で、すでに付与済みでなければ入金後に取り消します。ドライランは承認の後に実行し、ERC-20 は全額到着の確認（`LibDelivery.pullExact`）付きで引き取るため、送金手数料のあるトークンは失敗します。完了カードは `VaultDeposited(account, asset, kind, tokenId, amount)` と、ボールトへのトークン自身の転送ログを読みます。この入金に permit の経路はありません。レビューは `getProtectedAccount(wallet)` から `enabled`、`locked`、`delaySeconds`、`requireCosign` も保持し、レシートは入金が再び出られる方法を示します。すぐに、待機時間の後に（必要な場合はセカンダリ署名者の承認付きで）、またはアカウントのロック中は出られない、のいずれかで、ロック中でも `depositToVault` は拒否しません。署名前の最後の確認で `hasAcceptedCurrentTerms` を読み直し、未同意のバージョンを拒否します。

<a id="vault-withdraw"></a>

### ボールトからの引き出し

引き出しは `VaultDepositoryFacet.withdrawFromVault(account, kind, asset, tokenId, amount, recipient)` で、`account` と `recipient` はどちらも接続中のウォレットです。上限は `withdrawableNow(account, kind, asset, tokenId)`（超えると `AmountExceedsFree`）で、`requireManager(account)` を確認し、呼び出し元（Tier-1）と受取人を審査します。一時停止中は、保護アカウントで `isEscapeOpen` が真の場合を除き拒否されます。レビューは1つのブロックで `getUserVaultAddress`、`paused`、`isEscapeOpen`、制裁ステータス、`getProtectedAccount(wallet)`、`withdrawableNow` を読み、その後呼び出しをドライランします。保護モードがオフならボールトのルートがすぐにウォレットへ支払い、オンなら `LibProtectedAccount.queuePayout` が `delaySeconds` のあいだ支払いをキューに入れ、`ProtectedVaultLocked`、`RecipientNotAllowlisted`、`TooManyPendingRows` を拒否します。完了カードは `VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, queued)`、`PayoutQueued`、ボールトからウォレットへのトークン自身の転送ログを読みます。入金記録がトークンIDなしで示すコレクションは、トークンIDを入力して引き出し、フォームの上限はそのトークンの `withdrawableNow` で、ブロックごとに読み直します。

<a id="vault-safety"></a>

### アカウントの安全

カードは同じブロックで `getProtectedAccount(wallet)`、`getProtectedDelayBounds()`、`paused`、制裁状況、`getPendingPayoutIds(wallet)` を読みます。`FunctionDoesNotExist` のリバートは利用不可と読みます。オンにするのは `enableProtectedMode(delaySeconds, protectNfts)` で、即時に有効、一時停止中またはすでにオンなら拒否され、遅延は範囲内（2日から5日）でなければならず、ボールトがなければ作成します。「今すぐロック」は `lockVault(wallet)` で、一時停止中も使え、キュー中のすべての行を取り消し（`PayoutCancelled`）、保留中のすべての変更を破棄し、管理者が提案した交代を無効にします。ロック解除の申請は `requestUnlock(wallet)` で、一時停止中や `cooldownUntil` 以前は拒否され、`pendingUnlockAt` を現在時刻に `delaySeconds` を足した時刻に設定します。「期限の来た変更を適用」は `finalizeSettingChanges(wallet)` で、期限の来たすべての変更を一度に適用します。オフへの切り替えは開いた行がなくなるまで待ちます（`PendingRowsExist`）。各操作はレビュー時とウォレットを開く直前にドライランされ、完了カードは Diamond のログから `ProtectedModeEnabled`、`VaultLocked`、`PayoutCancelled`、`SettingChangeRequested`、`SettingChangeApplied` を読みます。

<a id="vault-escape"></a>

### プロトコルが一時停止しているとき

通知は同じブロックで `paused`、`VaultPayoutFacet.isEscapeOpen`、`escapeOpensAt`（手動一時停止の開始時刻に、開始時のエスケープ期間を足したもの。有効な一時停止がない場合や Diamond が一度も開始されていない場合はゼロ）、`getProtectedAccount(wallet)` を読み、ブロック時刻に対してカウントダウンします。ルートが閉じたまま一時停止中は `withdrawFromVault` が `EnforcedPause` でリバートし、レビューは一時停止が止めていると伝えます。`isEscapeOpen` が真になると、保護されたアカウントは引き続き `withdrawFromVault` を使い、キューへの登録が続きます。それ以外のウォレットの引き出しは `escapeWithdraw(kind, asset, tokenId, amount)` を呼びます。これは保護されたアカウントを拒否し（`EscapeNotForProtected`）、禁止された受取人を拒否し、ウォレット自身の入金残高と自由な数値で上限が決まり、呼び出し元に支払います。完了カードは `EscapeWithdrawal(account, asset, tokenId, amount)` と、ボールトからウォレットへのトークン自体の移転を読みます。一時停止、ルート、またはルートが開いている場合のモードが読めなければ、引き出しは送信されません。

<a id="protection-addresses"></a>

### 保存済みアドレス

アドレス帳はチェーンIDとウォレットごとに `localStorage` に保存され、オンチェーンには置かれません。ウォレットは、ドメイン `{name: 'Vaipakam Address Check', version: '1', chainId, verifyingContract: Diamond}` で `AddressControl{account, destination, purpose, nonce, issuedAt}` に署名すると追加されます。32バイトのランダムな nonce を持ち、有効期間は7日です。リクエストは `/protection?prove=<code>` として渡されます。署名ページは、このアプリが扱わないネットワークや Diamond、失効したリクエストを拒否し、接続中のアカウントがそのチェーン上のそのアドレスである場合にだけ署名します。貼り戻された回答は、接続中のウォレット自身の読み取り接続を通じて `verifyTypedData` で検証されるため、スマートウォレットは ERC-1271 で回答します。同じリクエストへの回答である場合にだけ保存されます。アドレス欄はアドレスを全桁表示して先頭と末尾の文字を区切って示し、壊れた EIP-55 チェックサムを拒否し、先頭3桁と末尾3桁の16進数がウォレットのすでに使っているアドレス（自分のアドレス、保存済みと待機中の項目、有効と待機中の支払先、保護署名者、承認済み keeper、ネットワークの keeper）と同じで残りが異なるアドレスを例外なく拒否します。初めてのアドレスには明示的なチェックが必要で、編集するとチェックは外れます。

<a id="protection-destinations"></a>

### 支払先

このセクションは同じブロックで `getProtectedAccount`、`getAllowlist`、`getPendingAllowlistAdditions`（各リクエストとその `maturesAt`）、`getProtectedSigners`、`paused`、および `getPendingPayoutIds` から受取人ごとの待機中の支払いを読み取ります。ブロック時刻にその後の経過秒数を加えた時刻で、リクエストは `maturesAt` より前は待機中、`maturesAt + delay` までは準備完了、その後は失効です。四つの変更は `addAllowlisted`、`cancelAddAllowlisted`、`finalizeAddAllowlisted`、`removeAllowlisted` で、いずれも `(account, destination)` を取ります。確認画面は同じブロックで読み取られ、facet が拒否するものをウォレットを開く前に拒否します。一時停止やロック（追加と有効化の場合）、自分のウォレット、すでに有効または待機中のアドレス、すでに5つの支払先または5つのリクエスト、フラグ付きのアドレス、まだ満期でないか失効したリクエストです。各呼び出しはシミュレーションされ、ウォレットを開く直前に再確認され、それ自身の `AllowlistAddRequested`、`AllowlistAddCancelled`、`AllowlistAdded`、`AllowlistRemoved` ログで計測されます。削除では、それによって発生した `PayoutCancelled` ログも数えます。

<a id="protection-signers"></a>

### セカンダリ署名者

このセクションは1つのブロックで、`getProtectedAccount`(`requireCosign` と `pendingCosignOffAt` を含む)、各署名者の `removeAt` を読む `getSignerChange` 付きの `getProtectedSigners`、`getPendingSignerAdditions`(依頼された各ウォレットとその `maturesAt`、`accepted`)、`paused` を読みます。変更は `addSigner`、`cancelAddSigner`、`finalizeAddSigner`、`requestRemoveSigner`、`cancelRemoveSigner`、`finalizeRemoveSigner`(それぞれ `(account, signer)`)、依頼されたウォレットが承諾リンク(`/protection?signer=<account>&chain=<id>`)から送る `acceptSignerRole(account)`、そして `setRequireCosign(account, on)` です。レビューは facet が拒否するものをウォレットより先に拒否します。一時停止(取り消しを除く)、ロックまたは新しいメインウォレットのクールダウン(依頼、削除、共同署名のオフ)、自分のウォレット、すでに署名者または依頼済みのウォレット、取り消していない失効した依頼、すでに5人の署名者または5件の依頼、承諾していないウォレット、終わっていない待機または過ぎた期間、署名者のいない共同署名です。各呼び出しは試行実行され、ウォレットが開く直前にもう一度確認され、自身の `SignerAddRequested`、`SignerAccepted`、`SignerAddCancelled`、`SignerAdded`、`SignerRemoveRequested`、`SignerRemoveCancelled`、`SignerRemoved`、`CosignRequirementSet`、`SettingChangeRequested` ログから測定されます。待機中の依頼ウォレットはアドレスチェックの既知アドレス一覧に加わります。

<a id="my-offers"></a>

### あなたのオファー

一覧は `getUserOffersPaginated(wallet)`（作成者ごとのインデックスで、取り消したIDも残る）と `getUserPositionOffersPaginated(wallet)`（ウォレットがポジショントークンを持つオファー）の和集合で、`MetricsDashboardFacet.getOffersWithState` を通じて最大250件ずつ読み、位置ごとに対応する答えを受け取ります。各行は問い合わせたIDに対応づけられます。何も成立せずに取り消されたオファーはレコードが削除されるため、ビューはID 0と導出状態「取消済み」を返し、行は条件を再構成せずに何も示しません。部分成立後に取り消されたオファーは `accepted` が立ったままレコードが残り、成立として読まれます。フィルターの件数は読み取った行について数えます。どちらかのインデックスを最後まで読めなかった場合、ページは一覧が不完全かもしれないと示します。

<a id="offer-book"></a>

### オファーブック

ブックはインデクサーの `GET /offers/active?chainId&limit=50&before=<offerId>` を読み、オファーIDの新しい順に `nextBefore` でページ送りします。インデクサーは期限切れのオファーを `active` のままにする（チェーン上の期限は遅延評価）ため、`expiresAt` を過ぎた行には期限切れのタグを付けます。`isSaleVehicle`、`isOffsetVehicle`、`refinanceTargetLoanId`（null = 未読）が種類を、`positionFlow.movedSinceOpened` が移動した紐付きポジションを示します（#3205）。各フィールドは厳密に解析し、失敗した行は未読として数えます。タブは `assetType`（0 = ERC-20 ローン、それ以外はレンタル）、サイドは `offerType` です。クエリはプッシュレールで無効化され、表示中は60秒ごとに再読み込みします。インデックスの障害はそのまま伝え、空のブックとしては表示しません。ブックは対応ネットワークでウォレットを接続した後にのみ要求し、それまではページが接続を求めます。

<a id="offer-detail"></a>

### オファーのページ

`/offers/:id` は1つのブロックで `OfferCancelFacet.getOffer(id)`、`MetricsFacet.getOfferState(id)`、`getOfferLinkedLoanId(id)` を読みます。接続したウォレット経由で読み、ウォレットを接続する前は何も読みません。作成者がゼロなら、記録が削除された（何も成立せずに取り消された）か、書かれたことがないかのどちらかです。プロトコルはオファー数を保持しないため、ページはどちらかを述べません。ゼロ以外の紐付きローンはローン売却（借り手のオファー）またはオフセット（貸し手のオファー）を示し、借り手のオファーの `refinanceTargetLoanId` は借り換えリクエストを示します。受けるときは共有の `acceptOffer` フロー（署名済み `AcceptTerms`、正確な承認、ドライラン、計測結果）を専用のストアキーで実行し、取り消しと片付けは共有の `cancelOffer` フローで行います。レンタル、NFT担保、ローン売却、オフセットは現在のアプリにリンクします。

<a id="offer-cancel"></a>

### オファーを取り消す

確認画面は1つのブロックで `getOffer(id)`、`getOffersWithState([id])`、`getOfferLinkedLoanId(id)`、`paused()` と作成者の `getProtectedAccount` を読み、`OfferCancelFacet.cancelOffer(id)` を試行実行します。ファセットは作成者のマネージャーにはいつでも、`expiresAt` を過ぎれば誰にでも取消を認めます。`OfferAlreadyAccepted`、`OfferAlreadyConsumedBySale` を拒否し、`amountFilled == 0` のオファーが300秒未満で期限内なら `CancelCooldownActive` を返し、`whenNotPaused` です。返却額はファセット自身の分岐で算出します。ERC-20の貸付オファーは貸付資産の `(amountMax または amount) - amountFilled`、NFTの貸付オファーはそのトークンまたはERC-1155の数量、借入リクエストは未使用の担保 `(collateralAmountMax または collateralAmount) - collateralAmountFilled` またはそのNFT（`refinanceCarryOver` で担保がローンに残る場合はなし）、レンタルリクエストは `amount × durationDays` に `rentalBufferBpsAtCreate` のバッファを加えた額です。`getOfferLinkedLoanId` でローンに結びつくオファーや、記録されたバッファがゼロのレンタルリクエスト（その場合プロトコルは現行率を使う）は署名前に算出しません。返却はすべてボールト出金を通じて作成者のボールトから出るため、保護モードではキューに入るか、ロック中はボールトに留まります。ポジショントークンは廃止されます。完了カードは `OfferCanceled(offerId, creator)`、作成者へのプロトコルの支払い記録、作成者へのトークン自身の送金を読みます。

<a id="offers-price-guard"></a>

### 価格変動ガード

ERC-20 担保に対する ERC-20 の開いているオファーでは、作成者がオファーのページから価格変動ガードを設定・変更・解除できます。記録時にプロトコルは両トークンのオラクル価格を記録し、その後は、担保対元本のレートがその水準から上限(0.5%〜50%、どちら向きでも)を超えて動いている間、ペアが直近 2 回の毎時価格チェックのいずれかに対して平穏の範囲を超えて動いている間、または現在の価格やそれらのチェックのいずれかが欠けている間、すべての受け入れが拒否されます。チェックはローン作成時に行われるため、直接の受け入れもマッチングも対象になり、ページは誰に対しても上限、レートの変動幅、今受けられるかどうかを示します。毎時チェックは誰でも書き込めます。プロトコルのキーパーは、開いているガード付きオファーの資産についてそれを書き込む想定です。両トークンについてそれが揃うまで、誰もオファーを受けられません。出したオファーに設定したガードは、記録されたブロックから保護し、それ以前は保護しません。変更すると価格が記録し直されます。何も動かさず、条件も変えません。オファーを出すときに、オファーフォームの上級オプションで設定することもできます。ガードと掲載は一つのトランザクションで行われるため、オファーが保護なしで掲載されることはなく、価格を読めないペアでは両方とも拒否されます。

<a id="risk-access"></a>

### Risk Access: あなたのリスクレベル

スイッチは `getRiskAccessGateEnabled` です。フローに必要な手順はプロトコル自身の回答で決まります。受諾では、`previewCreatorBlock` が貸し手のブロックなしを示したうえで `previewOfferAcceptBlock`（1 = レベル不足、2 = ペアへの同意、3 = 厳格モードの確認、4 = かつて受諾時の確認がカバーしていた非流動ペア。2 と同じくブロックとなり、ペアへの同意で解除されます）。リクエストでは、`createOffer` のドライランの `RiskTierTooLow`、`IlliquidPairNotConsented`、`MidTierPairNotAcknowledged` です。手順は一つのブロックで、ペアの `pairRequiredRiskLevel`（オファーでは `acceptMidTierAckPair`）、`getVaultRiskTier`、`getEffectiveRiskTier`、`getCurrentRiskTermsVersion` に対する `getVaultRiskTierVersion`、`getRiskTierUnlockAt`、`getRiskAccessUnlockCooldown`、`getRiskTierMutationNonce` を読み、ペアについては `isPairConsentPending` と `hasIlliquidPairConsent`、または `isMidTierAckPending` と `midTierStrictBlocked` を読みます。引き上げはペアに必要な最小レベルへの `setVaultRiskTierChecked(level, nonce, termsVersion)` で、確認後に別のレベル書き込みや条件変更があれば何も変えずに拒否されます。ペアの手順は `setIlliquidPairConsent(pair, true)` または `setMidTierPairAck(pair)` です。待機中の引き上げや保留中のペア手順は再提示しません。保留中のペア手順がいつ有効になるかを返す読み取りはないため、確認画面はその時刻を読めないと伝えます。その時刻を示すのは手順自体の完了カードだけで、明細のブロック時刻と待機期間の和から求めます。結果は明細のブロックで読み直します。

<a id="terms-gate"></a>

### 利用規約の確認

`getCurrentTos` は、操作の対象チェーンで有効なバージョンと内容ハッシュを返します。バージョン 0 は規約なしを意味し、何も制限されません。`hasAcceptedCurrentTerms` が false のウォレットには新たなエクスポージャーの前に確認が求められ、本文が決して変わらないバージョン固定ページ `/terms/v<N>` へのリンクが示されます。同意すると `acceptTerms(version, hash)` を一度呼び出します。ウォレットを開く前に組み合わせを読み直すので、新しいバージョンは表示中のものに置き換わり、別のタブで行われた同意があれば操作はそのまま続きます。読み取りの失敗は「確認できない」であり、再試行でき、「未同意」にはなりません。退出は決して制限されません。

<a id="settings"></a>

### 設定

設定には、一度決めておく項目がまとまっています。モードとテーマはこのサイト用にブラウザのストレージに保存され、言語はそこと、プラットフォームの各サイトで共有する `vaipakam_lang` クッキーに保存されます。ページ自体の言語属性は、翻訳が公開されるまで英語のままです。利用規約の行は、接続中のネットワークで `getCurrentTos` とウォレットの同意状況を読みます。適用中の規約なし、バージョンと本文のフィンガープリント付きで同意済み、または適用中で未同意のいずれかで、未同意なら制限のある最初の操作で確認します。読み取りに失敗した場合は「確認できませんでした」と再試行を表示し、「未同意」とは表示しません。手数料割引の切り替えは `setVPFIDiscountConsent` で、ホームと同じ流れです。このビルドには診断情報の収集は含まれていません。ブラウザには、既読のアラート、アラートチャネルの記録、最後に署名したアラート要求の時刻、最後に選んだトークンの組み合わせ、閉じた初回カード、ウォレットコネクタの最後の接続も保存されますが、鍵や署名は保存しません。ダウンロードでは、アプリ自身の記録（`app.` または `alpha05.` で始まるキーと言語）を JSON ファイルに書き出し、それらの記録がひも付くウォレットアドレスを明記し、ウォレットコネクタのセッション項目とこのサイトのデータベースは数だけを記載してコピーしません。消去では、コネクタが記録を書き戻さないよう最初にすべてのウォレット接続を切り、次にこのサイトのローカルストレージとタブごとのストレージを削除し、ブラウザが一覧を出せる場合はデータベースを削除し、`vaipakam_lang` クッキーを設定されうるすべてのドメインで期限切れにします。その後ページを再読み込みし、そのタブに、削除した内容とブラウザが拒否した項目を理由とともに表示します。ウォレットコネクタの「切断済み」マーカーだけを書き戻すため、このサイトをまだ許可しているウォレットが再読み込みで再接続されることはありません。ブラウザがレポートを再読み込みまで保持しない場合、ページは再読み込みせずにその場でレポートを表示します。

リスクアクセスは一つのブロックで `getVaultRiskTier`、`getEffectiveRiskTier`、レベルの条件バージョンと `getCurrentRiskTermsVersion`、`getRiskTierUnlockAt`、`getRiskAccessUnlockCooldown`、`getRiskStrictMode`、`getStrictModeStrictUntil`、`getRiskAccessGateEnabled` を読みます。数えられるレベルと、それが選んだレベルと異なる理由を示します。まだ待機中の引き上げ（数えられる時刻付き）か、条件の変更（確認するまでブルーチップとして数えられる）です。レベルの変更は `setVaultRiskTierChecked` で、読んだ変更カウンターと条件バージョンを指定するため、別の場所からの書き込みや新しい条件があれば拒否され、何も変わりません。引き上げは期間を待ち、待機中に再び提示されることはありません。引き下げは即時です。チェックは成立時にのみ適用されるため、引き下げはそれより上のペアを新しいオファーとリクエストに対して閉じ（あなた自身の未成立のものは受諾できなくなります）、既存のローンには触れません。厳格モードは `setRiskStrictMode` で、オンは即時、オフにしても期間中は適用が続き、ページはいつまでかを示します。チェックがオフのネットワークでは、変更は保存され、チェックがオンになったときにのみ数えられます。ペアごとの同意と確認は、それを必要とするフローに残ります。

承認では、一つのブロックで各 ERC-20 の `allowance(wallet, Diamond)`、Permit2 が展開されている場合はその `allowance(wallet, token, Diamond)`（期限切れのものは一覧に出しません）、各 NFT コレクションの `isApprovedForAll(wallet, Diamond)`、ポジションが示しウォレットがまだ保有する各 ERC-721 トークンの `getApproved` を読みます。確認する資産は、提案された資産、`getDepositoryAssets` の各資産、`getUserLoansPaginated` の各ローンと `getUserOffersPaginated` の各オファーの両側、各常設オファーの貸出資産、そしてあなたが追加したコントラクトです。2^255 以上（Permit2 経由では 2^159 以上）の承認は無制限として表示します。取り消しでは `approve(Diamond, 0)`、Permit2 の `approve(token, Diamond, 0, 0)`、`setApprovalForAll(Diamond, false)`、または `approve(0x0, tokenId)` を送ります。行はウォレットを開く前と明細のブロックで読み直します。最後まで読めなかった記録や応答しない資産はそう明示し、承認なしとして表示することはありません。常設オファーの担保資産も確認され、ウォレットが保有するのに `getApproved` が応答しないトークンは不明として数えられます。受領書は行と同じブロックで同じ資産のもう一方の承認（1 つのトークンには `isApprovedForAll`、コレクションには見つかったトークンの `getApproved`、ERC-20 には Permit2 の `allowance`、Permit2 の承認には ERC-20 の `allowance`）を読み、それが残ることを示すか、不明であると示します。ウォレットが開く前にそれが変わると署名は止まります。

キーパーの項目は、1 つのブロックで `getKeeperAccess`、`getApprovedKeepers`、および承認済みの各キーパー（最大 5 件）の `getKeeperActions` を読み取ります。アクションはプロトコルのビットです。貸し手ポジションの売却の完了（0x01）、オフセットによる早期終了の完了（0x02）、貸し手ポジションの売却の開始（0x04）、早期終了の開始（0x08）、合意した範囲内での延長（0x20）は、ローンまたはオファーがそのキーパーも有効にしている場合にだけローンに作用します。キーパーを必要とする常設の貸付オファーの約定（0x40）、返済されたお金の常設オファーへの再投入（0x80）、保護アカウントのロック（0x100）は、アクセスがオンになればアカウント全体に作用します。ビット 0x10 は廃止済みで拒否されます。変更は `setKeeperAccess`、`approveKeeper`、`setKeeperActions`、`revokeKeeper` のいずれかを送ります。キーパーに多く与える変更は、有効な版があれば規約を求め、取り消しは求めません。プロトコルの一時停止中は、削除を含むすべての変更が拒否されます。このアプリのキーパーはデプロイ記録から示されます。

アプリは 4 つのショートカットとマスカブルアイコンを含む Web マニフェスト（`/manifest.webmanifest`）を備えています。設定 › アプリをインストールでは、ブラウザが `beforeinstallprompt` イベントを発火したあとにだけボタンが表示され、そのプロンプトを開きます。そうでなければ、ページは状況（インストール済み、iOS、提供されていない）を示します。デプロイされたビルドは、そのビルドの出力から書かれた `/sw.js` を登録します。これはページがビルドのハッシュ付き `/assets/` ファイルを初めて取得したときにそのコピーを保持し、以後のそのファイルの要求にはコピーで応え、引き継ぐ際に以前のビルドのストアを削除し、ナビゲーション、別オリジンへの要求、リストにないファイルには決して応えません。「このブラウザ内のデータ」はこれらのストアを数えて消去します。

<a id="rent-review"></a>

### レンタル：NFTを借りる

確認画面は出品を `getOffer`（その `rentalBufferBpsAtCreate`）で、プロトコルの判定と日額料金を `previewAccept` で読み、自分のバッファを記録していない出品に限り `getRiskConfig` を読みます。合計は `amount × durationDays` にその割合を足し、プロトコルと同じく切り捨てたもので、試行が両者の一致を確かめます。レンタルは `acceptOffer` で、署名済みの `AcceptTerms` がNFTを承認済みの非流動側として示し、担保側はありません。利用権は受領ブロックで所有者のボールトから `vaultGetNFTUserOf`（ERC-1155 なら `vaultGetNFTQuantity`）で読み戻します。

<a id="rent-risks"></a>

### レンタル：リスク

借りたNFTがあなたのものになることはなく、使う権利はレンタルの終了とともに終わります。レンタル料とバッファはレンタルのためにボールトに留まり、開いている間は引き出せません。合意したすべての日が精算されると（精算は誰でもできます）、レンタルは自動で終わり、バッファを請求できます。それまではそのポジションページから自分で終えてください。猶予期間中に終えるとバッファから延滞料が引かれます。猶予期間を過ぎるとレンタルはデフォルトとなり、ボールトに残るレンタル料は所有者へ、バッファはプロトコルへ渡り、あなたには何も戻りません。全期間の料金ルールでは、早く終えても全期間分を支払います。

<a id="rent-list"></a>

### レンタル：自分のNFTを貸し出す

フォームはコレクションの規格を ERC-165 の `supportsInterface` で、最長期間を `getProtocolConfigBundle` で読みます。確認画面はトークンを `ownerOf`・`getApproved`・`isApprovedForAll`（ERC-1155 なら `balanceOf`）で、支払いトークンの区分を `getAssetPriceStatus` と流動性チェックで、バッファの割合を `getRiskConfig` で、猶予期間を `getEffectiveGraceSeconds` で、プロトコルの取り分を `getTreasuryFeeBps` で読み、`createOffer` を試行します。`assetType` は 1 か 2、`amount` と `amountMax` はどちらも日額料金、担保と金利の欄はすべて 0、`prepayAsset` は支払いトークンです。投稿は `rentalBufferBpsAtCreate` を記録し、結果はトランザクションの `OfferCreated` ログと、所有者のボールトへ向かうNFT自身の `Transfer`（または `TransferSingle`）ログから読みます。

<a id="rent-list-risks"></a>

### レンタル：貸し出しのリスク

出品が開いている間と貸し出し中は、NFTはあなたのボールトに留まり、出品かレンタルが終わるまで引き出せません。まだ誰も借りていなければ、最初の5分を過ぎた後に出品のページから取り消せます。貸し出した後は、レンタルが終わるまで借り手がNFTを使う権利を持ち、早めに取り戻すことはできません。終わった日が精算されるたびに、プロトコルの取り分を引いたレンタル料があなたのボールトに入ります。精算は誰でもできます。合意したすべての日が精算されると、レンタルは自動で終わり、借り手はバッファを請求できます。それまでは借り手が終えるか、猶予期間の後なら誰でもデフォルトとして終えられます。借り手が終えた場合、まだ精算されていないレンタル料と延滞料を、プロトコルの取り分を引いて請求でき、残りのバッファは借り手に戻ります。デフォルトの場合は、残りのレンタル料をその取り分を引いて請求でき、バッファはプロトコルへ渡ります。一時停止中は日々の精算が止まり、延滞料とデフォルトの期日は後ろにずれますが、借り手の利用期間は延びません。期限切れの出品は、閉じられるまでNFTをボールトに残します。

<a id="rent-request"></a>

### レンタル：NFTの借り入れを申し込む

フォームはコレクションの規格を ERC-165 の `supportsInterface` で、最長期間を `getProtocolConfigBundle` から読みます。確認画面はトークンの保有者を `ownerOf` で（ERC-1155 には保有者の一覧がありません）、支払いトークンの区分を `getAssetPriceStatus` と流動性チェックで、支払いトークンのウォレットの `balanceOf` と `allowance`、バッファの割合を `getRiskConfig` から、猶予期間を `getEffectiveGraceSeconds` から読み、その後 `createOffer` をドライランします。`offerType` は 1、`assetType` は 1 か 2、`amount` と `amountMax` はどちらも日額料金、担保と金利の欄はすべて 0、`prepayAsset` は支払いトークンです。投稿すると `rentalBufferBpsAtCreate` が記録され、日額料金×期間にその割合を加えた額が借り手のボールトへ引き出されます。結果はトランザクションの `OfferCreated` ログと、ボールトへの支払いトークンの `Transfer` ログから読みます。

<a id="rent-request-risks"></a>

### レンタル：レンタル希望のリスク

希望が開いている間、レンタル料とバッファはあなたのボールトに留まり、取り消すか希望が終わるまで引き出せません。まだどのオーナーも受けていなければ、最初の5分を過ぎた後に希望のページから取り消せ、両方ともウォレットに戻ります。受けたオーナーは、まさにこの条件ですぐレンタルを開始します。あなたが持つのはNFTを使う権利で、NFTそのものではありません。合意したすべての日が精算されると（精算は誰でもできます）、レンタルは自動で終わり、バッファを請求できます。それまではポジションのページから終えてください。遅れて終えるとバッファから延滞料が引かれ、デフォルトになるとレンタル料はオーナーへ、バッファはプロトコルへ渡ります。期限切れの希望は、閉じられるまでレンタル料とバッファをボールトに残します。バッファの割合は、希望がチェーンに記録される時点のプロトコル設定です。確認後に変わった場合、ウォレットがちょうどこの金額を承認していれば高い割合は拒否され、以前の承認でまかなえれば引き落とされます。結果には実際に動いた額が示されます。

<a id="rent-take"></a>

### レンタル：借り手の希望を受ける

確認画面は希望を `getOffer`（その `rentalBufferBpsAtCreate`）で、プロトコルの判定を `previewAccept` から、双方のリスク設定、猶予期間を `getEffectiveGraceSeconds` から、プロトコルの取り分を `getTreasuryFeeBps` から読み、バッファを記録していない希望に限り `getRiskConfig` を読みます。`previewAccept` は誰がNFTを持っているかを確かめないため、アプリが `ownerOf`、`getApproved`、`isApprovedForAll`（ERC-1155 では `balanceOf` と `isApprovedForAll`）で読みます。受けることは署名済みの `AcceptTerms` を伴う `acceptOffer` です。プロトコルはNFTを所有者のウォレットから所有者のボールトへ移し、期間の終わりまで借り手を利用者として記録します。結果はトランザクションのログ（この希望から開かれたレンタルと、所有者のボールトへのNFTの `Transfer` または `TransferSingle`）と、レシートのブロックでの `vaultGetNFTUserOf` から読みます。終わった日の分は `autoDeductDaily(loanId)` が支払い、プロトコルが一時停止していない間は誰でも呼び出せます。支払い先は所有者ポジションNFTの保有者のボールトで、残りは終了時に請求します。

<a id="rent-take-risks"></a>

### レンタル：希望を受けるリスク

NFTはレンタルの間ずっとあなたのボールトに留まり、レンタルが開いている間は引き出せません。借り手はレンタルが終わるまでそれを使う権利を持ち、あなたがその権利を早く取り戻すことはできません。条件は希望のものです。日額料金、期間、料金ルール、バッファは変えられません。終わった日が精算されるたびに、プロトコルの取り分を引いたレンタル料があなたのボールトに入ります。精算は誰でもできます。合意したすべての日が精算されると、レンタルは自動で終わり、借り手はバッファを請求できます。それまでは借り手が終えるか、猶予期間の後なら誰でもデフォルトとして終えられます。借り手が終えた場合、まだ精算されていないレンタル料と延滞料を、プロトコルの取り分を引いて請求でき、残りのバッファは借り手に戻ります。デフォルトの場合は、残りのレンタル料をその取り分を引いて請求でき、バッファはプロトコルへ渡ります。一時停止中は日々の精算が止まり、延滞料とデフォルトの期日は後ろにずれますが、借り手の利用期間は延びません。自分のバッファを記録していない希望は、レンタル開始時に今日の設定を使います。

<a id="rent-close"></a>

### レンタル：レンタルを終える

進行中のレンタルのページでは、借り手のあなたに「レンタルを終える」が表示されます。終了すると、未払いのレンタル料と延滞料は、あなたが自分のボールトに前払いしたレンタル料とバッファから支払われます。ウォレットからは何も引かれず、承認も要りません。確認画面には、今終える場合と少し先のある時点で終える場合のレンタル料が、料金ルールで数えて表示されます（日割り：開始から使った日数、途中の日は1日と数え、精算済みの日を除く。全期間：まだ精算されていない合意済みのすべての日）。あわせて精算済みの日数、延滞料、請求としてあなたに戻る額、そして所有者が受け取る額（レンタル料と延滞料からプロトコルの取り分を引いた額）も表示されます。前払い分で終了をまかなえない場合は、ウォレットが開く前に確認画面がそう伝えます。そのあとウォレットが一度だけレンタルの終了を求め、アプリはまずドライランで試します。終了後、アプリはレンタルが終わったこと、あなたに記録された請求、あなたの利用が終わったことをチェーン上で確認します。戻る分は Claims ページで受け取ってください。

確認画面はレンタルを `getLoanDetails` で、日付を `getLoanDeadlines` で、延滞料を `calculateRepaymentAmount` で読みます。レンタルではこの値は延滞料だけです。プロトコルはレンタル料の数値を公開しないため、アプリは `repayLoan` が使うルールで `startTime`・`lastDeductTime`・`durationDays` から数えます。終了は `repayLoan(loanId)` で、借り手だけが猶予期間の終わりまでに呼べます。結果は `LoanRepaid` ログ、`getClaimable(loanId, false)`、レシートのブロックでの `vaultGetNFTUserOf` から読みます。

<a id="rent-close-risks"></a>

### レンタル：終えるときのリスク

終了すると、合意した日が残っていても、NFTを使う権利はすぐに終わり、取り消せません。レンタル料は終了がチェーンに記録された時点で数えるため、それより前に始まった日は1日分として支払います。全期間の料金ルールでは、どれだけ早く終えても、まだ精算されていない合意済みのすべての日を支払います。期間が終わったあとはバッファから延滞料が引かれます。レンタル料全体の1%に、遅れた日ごとに0.5%を加え、上限は5%で、バッファを超えることはありません。猶予期間を過ぎるとプロトコルは終了を拒み、そのあとレンタルは、残りの日が1日ずつ精算されて終わるか（誰でも行えます）、デフォルトで終わるか、先に起きたほうで終わります。確認画面が示す後の時点は期限でも上限でもありません。後で記録された終了はその時点で数えるため、より多くのレンタル料や高い延滞料が引かれ、戻る分が減ることがあります。戻る分は受け取るまで、請求としてあなた自身のボールトに残ります。

<a id="rewards-vpfi"></a>

### リワード：ボールトの VPFI

ページは `getVPFIToken` でトークンを読み、ゼロアドレスはそのネットワークで VPFI が設定されていないことを意味します。1 つのブロックで、ウォレットの `balanceOf`、`getUserVaultAddress` からボールト、`getTrackedVPFIBalance` から計上済み VPFI、`withdrawableNow` から自由な額、ボールト自身の `balanceOf` を読みます。保留中は計上済みから自由な額を引いたもの、未計上はボールト残高のうち計上済みを超える分です。「VPFI を入金」はボールトの汎用 `depositToVault`、「VPFI を引き出す」はその `withdrawFromVault`（プロトコルが一時停止中で緊急退出ルートが開いている間、保護モードでないアカウントでは `escapeWithdraw`）で、VPFI 専用の入口ではありません。汎用ルートもティアのために VPFI を同じように記録し、緊急退出ルートを持つのは汎用ルートだけです。各確認画面は自身のブロックで `getTrackedVPFIBalance` と `getVPFIDiscountConsent` を読み、結果はトランザクションから測定されます。あわせて `isCanonicalVpfiChain` を読みます。VPFI のホームネットワークだけが自身の計上済み VPFI からティアを算出し、他のネットワークはそのティアのキャッシュされたコピーを適用するため、そこではページと各受領書が、操作でティアは変わらないと示します。

<a id="rewards-vpfi-risks"></a>

### リワード：VPFI を動かすリスク

ティアは今日の残高ではありません。現在の途切れない保有が最低日数に達するまではゼロで、その後は最近の日を重く見る日次終値残高の平均に従い、さらに現在の保有期間中のいずれかの日に持っていた最も低いティアで上限が抑えられます（さかのぼるのは最大 30 日）。この 2 つは別々のさかのぼりです。計上済み VPFI の一部を引き出すと、上限が読むその日の最低残高が下がり、すべて引き出すと保有期間は数え直しになります。上乗せでは数え直しになりません。ローン・オファー・請求・支払いのために保留中の VPFI は、解放されるまで引き出せません。保護されたアカウントの引き出しが計上済み VPFI とティアを変えるのは解放されたときだけで、取り消された引き出しはどちらも変えません。ボールトの VPFI は担保ではありません。プロトコルは VPFI を販売せず、価格を示さず、保有に対して何も支払いません。

<a id="rewards-tier"></a>

### リワード：手数料割引ティア

カードは 1 つのブロックで `getVPFIDiscountConsent`、`isCanonicalVpfiChain`、`getEffectiveDiscount` を読みます。`getEffectiveDiscount` は手数料の計算が適用するティアと割引を返します：同意がオフならゼロ、上限は 50%、ほかのネットワークではホームネットワークから送られたコピーです。同じブロックで `explainTier` と `getTwaConfig` も読みます。`explainTier` は同意の有無にかかわらず、計上済み VPFI だけで得られるティア、各保有ルールの数値、有効ティアをそれより低く抑えているルールを返します。カードがそのルールを示すのは、説明が手数料の計算と同じティアになるときだけで、同意がオフのときは、オンにすればどのティアが適用されるかを示します。Advanced では各ルールの数値と `getTwaConfig` が返す設定を表示し、平均の期間と振り返り期間は別々の長さとして示します。表は 1 つのブロックで `getVpfiTierThresholds`、`getVpfiTierDiscountBps`、`getFeesConfig` を読みます。ティア 1〜3 はそのしきい値から、ティア 4 は自身のしきい値を超えたところから始まります。各手数料は基本手数料に（1 − 上限適用後の割引）を掛けたもので、正確に計算されます。表はティアが決まるホームネットワークでのみ表示されます。

<a id="rewards-vpfi-sign"></a>

### リワード：承認の代わりに署名

確認画面は自身のブロックで、Permit2 の正規アドレスにコードがあるかどうかと、VPFI トークンについてウォレットが Permit2 に与えた ERC-20 の `allowance` を読みます。Permit2 がデプロイされ、その allowance が金額を満たすときにだけ「承認の代わりに署名」が提示され、そうでなければ Advanced がどちらが欠けているかを示します。ウォレットは VPFI トークンとちょうどその金額について Permit2 の `PermitTransferFrom` に署名します。spender は Diamond、nonce は `nonceBitmap` で未使用を確認したランダム値、期限は最新ブロックの 30 分後です。アプリは署名付きで `depositVPFIToVaultWithPermit` を試行実行してから送信します。プロトコルは他のトークンの permit を拒否します。結果は、このエントリが `VaultDeposited` の代わりに発行する `VPFIDepositedToVault` と、保管庫へのトークン送金から測定します。どちらの経路でも VPFI は同じように等級に計上されます。
