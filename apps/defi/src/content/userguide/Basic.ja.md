# Vaipakam — ユーザーガイド (Basic Mode)

アプリ内の各カードについて、親しみやすく平易な日本語で説明します。
各セクションは、カード名の横にある `(i)` info icon に対応しています。

> **Basic 版を読んでいます。** これはアプリの **Basic** モード
> (操作項目を絞り、安全寄りの初期設定にしたシンプルな表示) に
> 対応しています。より技術的で詳しい walkthrough を読みたい場合
> は、アプリを **Advanced** モードに切り替えてください —
> Settings を開く (右上の歯車アイコン) → **Mode** →
> **Advanced**。その後、アプリ内の (i) "Learn more" リンクは
> Advanced ガイドを開くようになります。

---

## Dashboard

<a id="dashboard.your-vault"></a>

### あなたの Vault

**vault** は、Vaipakam の中にあるあなた専用の金庫だと考えて
ください。あなただけのために用意される小さな contract です。
loan に参加するとき — 担保を入れる場合でも、資産を貸し出す
場合でも — 資産はいったん wallet からこの金庫へ移動します。
他の人のお金と混ざることはありません。loan が終わったら、
そこから直接 claim して取り戻せます。

vault を自分で「作成」する必要はありません。必要になった
最初のタイミングでアプリが用意します。一度できると、その
chain 上のあなた専用の置き場所として残ります。

<a id="dashboard.your-loans"></a>

### あなたの Loans

この chain 上で、あなたが関わっているすべての loan がここに
表示されます。あなたが lender (貸す側) でも、borrower (借りる
側) でも同じです。各行が 1 つの position です。クリックすると、
loan の健康状態、担保として lock されているもの、発生している
interest、そして必要なタイミングで repay / claim / liquidate
するためのボタンまで、全体を確認できます。

別々の loan で、片方では貸し、別の片方では借りている場合も、
同じ場所に別々の行として表示されます。

<a id="dashboard.vpfi-panel"></a>

### このチェーン上の VPFI

**VPFI** は protocol 独自の token です。vault に入れておくと、
protocol fee の割引を受けられ、さらに小さな passive yield
(5% APR) も得られます。このカードでは、接続中の chain について
次の内容を確認できます:

- ウォレットに今いくらの VPFI があるか。
- vault にいくらあるか (これが「staked」として
  カウントされます)。
- 全 VPFI 供給量に占めるあなたのシェア。
- 全体としてあと何 VPFI が mint 可能か (protocol には hard cap
  があります)。

Vaipakam は複数の chains で動きます。そのうち Base が、新しい
VPFI が mint される **canonical** chain です。その他の chains
は、cross-chain bridge で同期される **mirrors** です。使う側
としては深く意識しなくて大丈夫です — どの chain に接続して
いても、表示される残高はその chain 上に実際に存在します。

<a id="dashboard.fee-discount-consent"></a>

### 手数料割引の同意

Vaipakam は、vault に置いてある VPFI の一部を使って protocol
fees の割引を適用できます。この switch は「はい、それを使って
ください」という同意 toggle です。一度 on にすれば十分です。

割引の大きさは、vault に保有する VPFI の量で決まります:

- **Tier 1** — `{liveValue:tier1Min}` VPFI 以上 → `{liveValue:tier1DiscountBps}`% off
- **Tier 2** — `{liveValue:tier2Min}` VPFI 以上 → `{liveValue:tier2DiscountBps}`% off
- **Tier 3** — `{liveValue:tier3Min}` VPFI 以上 → `{liveValue:tier3DiscountBps}`% off
- **Tier 4** — `{liveValue:tier4Min}` VPFI 超 → `{liveValue:tier4DiscountBps}`% off

switch はいつでも off にできます。vault から VPFI を引き出す
と、tier はその場で下がります。

> **Blockchain network gasに関する注意。** 上記のdiscountは
> Vaipakamの**protocol fees**（Yield Fee、Loan Initiation Fee）
> に適用されます。すべてのon-chain actionに必要な小さな**gas fee**
> （offer create、accept、repay、claimなどの際にblockchain validators
> へ支払うもの）は別の費用で、networkへ行くものでありVaipakamへは
> 行きません。protocolは決して受け取らないため、それに対するdiscount
> はできません。

<a id="dashboard.rewards-summary"></a>

### あなたの VPFI 報酬

このカードはプロトコルから獲得したすべての VPFI 報酬を 1 つ
の場所にまとめます。一番上の大きな数字は合計です — すでに請
求した分と請求待ちの分の合計です。

報酬ストリームは 2 つあり、カードはそれぞれの合計を分解しま
す：

- **ステーキング利回り** — Vaultに保管している VPFI に
  対して自動的に獲得されます。レートは Buy VPFI ページに表示
  されるプロトコル APR です。
- **プラットフォーム・インタラクション報酬** — 参加しているす
  べてのローンに対して、どちら側でも、毎日少しずつ獲得されま
  す。あなたがいるチェーン上で VPFI で支払われ、ブリッジは不
  要です。

各行の右側に小さなシェブロン矢印があります。それをクリック
すると、そのストリームの完全な請求カードに直接ジャンプしま
す — ステーキングは Buy VPFI ページにあり、プラットフォー
ム・インタラクションは Claim Center にあります。

まだ何も獲得していない場合でも、カードは
*合計獲得額: 0 VPFI* と開始方法のヒントとともに表示されます。
あなたは何も間違っていません — 表示する履歴がないだけです。


---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

market の list は長くなることがあります。Filters を使うと、
loan の asset、lender offer か borrower offer か、その他の
条件で絞り込めます。あなた自身の active offers は常にページ
上部に表示されたままです — filters が影響するのは、他の人の
offers だけです。

<a id="offer-book.your-active-offers"></a>

### あなたのアクティブな Offers

**あなた**が投稿し、まだ誰にも accept されていない offers です。
ここにある間は無料で cancel できます。誰かが accept すると、
その position は実際の loan になり、Dashboard の「あなたの
Loans」に移ります。

<a id="offer-book.lender-offers"></a>

### Lender Offers

貸し出したい人の posts です。それぞれの内容は、「asset Y を
X units、interest Z%、期間 D 日で貸します。その代わり、これ
だけの collateral を入れてください」という意味です。

これを accept した borrower は、その loan の borrower-of-record
になります。borrower の collateral は vault に lock され、
principal asset が borrower の wallet に届き、borrower が
repay するまで interest が積み上がります。

protocol は acceptance 時に borrower 側へ 1 つの safety rule
を課します: collateral は loan の少なくとも 1.5 倍の価値が
必要です。(この数字を **Health Factor 1.5** と呼びます。)
borrower の collateral が足りなければ、loan は開始されません。

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

すでに collateral を lock し、loan を fund してくれる人を
待っている borrowers の posts です。

これを accept した lender は loan を fund します。lender の
asset が borrower に渡り、lender は lender-of-record になり、
期間中 offer の rate で interest を得ます。interest の小さな
一部 (1%) は settlement 時に protocol treasury へ送られます。

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

どちらの side で offer を作るか選びます:

- **Lender** — lender は asset を提供し、その loan が継続して
  いる間、利息を得ます。
- **Borrower** — borrower は collateral を lock し、それを担保に
  別の asset を request します。

「rentable」NFT (一時的に delegate できる特別な NFT) のための
**Rental** sub-option もあります。Rental ではお金を貸すのでは
ありません — NFT そのものを日額 fee で貸し出します。

<a id="create-offer.lending-asset"></a>

### Lending Asset

対象になる asset と amount、interest rate (APR %) と duration
(日数) です。rate は offer 投稿時に fixed され、後から誰も
変更できません。duration が終わると短い grace window があり
ます — その時点までに borrower が repay していなければ、loan
は default 可能になり、lender の collateral claim が有効に
なります。

<a id="create-offer.lending-asset:lender"></a>

#### あなたが lender の場合

あなたが offer する principal asset と amount、interest rate
(APR %) と duration (日数) です。rate は offer 時に fixed され、
duration は loan が default 可能になるまでの grace window を
決めます。

<a id="create-offer.lending-asset:borrower"></a>

#### あなたが borrower の場合

lender から受け取りたい principal asset と amount、interest
rate (APR %) と duration (日数) です。rate は offer 時に fixed
され、duration は loan が default 可能になるまでの grace window
を決めます。

<a id="create-offer.nft-details"></a>

### NFT Details

rental offer では、このカードで daily rental fee を設定します。
renter は accept 時に rental cost 全額を前払いし、deal が少し
長引いた場合に備えて小さな 5% buffer も支払います。NFT 自体は
ずっと vault に置かれます — renter は使う権利を持ちますが、
NFT を move することはできません。

<a id="create-offer.collateral"></a>

### Collateral

loan を安全にするために lock されるものです。2 種類あります:

- **Liquid** — live price feed (Chainlink + 十分な深さの
  on-chain pool) を持つ、よく知られた token。protocol は
  その価値を real time で評価でき、価格が loan に不利に動いた
  ときは position を自動的に liquidate できます。
- **Illiquid** — NFTs、または price feed のない tokens。
  protocol はこれらを評価できないため、default 時には lender
  が collateral 全体を受け取ります。offer を作る前に、lender
  と borrower の双方がこの条件に同意する必要があります。

<a id="create-offer.collateral:lender"></a>

#### あなたが lender の場合

borrower にどれだけ lock してもらうかです。Liquid ERC-20s
(Chainlink feed + ≥$1M の v3 pool depth) には LTV/HF math が
適用されます。Illiquid ERC-20s と NFTs には on-chain valuation
がなく、default 時に collateral 全体が移る outcome について、
双方の同意が必要です。

<a id="create-offer.collateral:borrower"></a>

#### あなたが borrower の場合

loan の担保として、あなたが lock してもよい amount です。
Liquid ERC-20s (Chainlink feed + ≥$1M の v3 pool depth) には
LTV/HF math が適用されます。Illiquid ERC-20s と NFTs には
on-chain valuation がなく、default 時に collateral 全体が移る
outcome について、双方の同意が必要です。

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Vaipakam で lending / borrowing を行うことには、現実の risk
があります。offer に sign する前に、このカードでは sign する
side から明示的な acknowledgement を求めます。下の risks は
両方の side に関係します。role-specific tabs では、それぞれの
risk がどちらにどう効きやすいかを説明します。

Vaipakam は non-custodial です。完了した transaction を support
desk が巻き戻すことはできません。sign する前に、ここをよく
読んでください。

<a id="create-offer.risk-disclosures:lender"></a>

#### あなたが lender の場合

- **Smart-contract リスク** — contracts は immutable code です。
  未知の bug が funds に影響する可能性があります。
- **Oracle リスク** — 古い、または操作された price feed により、
  collateral が principal を cover できなくなった後まで
  liquidation が遅れる可能性があります。全額回収できないことも
  あります。
- **Liquidation slippage** — liquidation が予定どおり起きても、
  DEX swap が quote より悪い price で成立し、実際の回収額が
  減る可能性があります。
- **Illiquid collateral** — default 時に collateral は丸ごと
  あなたへ transfer されます。ただし、それが loan より低い価値
  しかなければ、それ以上の claim はありません。offer 作成時に
  この trade-off に同意しています。

<a id="create-offer.risk-disclosures:borrower"></a>

#### あなたが borrower の場合

- **Smart-contract リスク** — contracts は immutable code です。
  未知の bug が locked collateral に影響する可能性があります。
- **Oracle リスク** — 古い、または操作された price feed により、
  real-market price では安全だったはずのタイミングで、あなたに
  対する liquidation が trigger される可能性があります。
- **Liquidation slippage** — liquidation が起きると、DEX swap
  が想定より悪い price であなたの collateral を売る可能性が
  あります。
- **Illiquid collateral** — default 時には collateral 全体が
  lender へ transfer され、あなたに戻る residual claim は
  ありません。offer 作成時にこの trade-off に同意しています。

<a id="create-offer.advanced-options"></a>

### Advanced Options

必要な人向けの追加 settings です — ほとんどの人はそのままで
大丈夫です。offer が expire するまでの時間、この特定の offer
で VPFI fee discount を使うかどうか、role-specific toggles
などがあります。最初の offer では skip して問題ありません。

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

loan が終わった後 — repay、default、liquidate のどれで終わった
場合でも — 結果として受け取れる分が自動で wallet に入るわけ
ではありません。取り出すには **Claim** をクリックします。この
ページには、この chain 上であなたがまだ claim していないものが
一覧表示されます。

同じ user が lender claims (自分が fund した loans から) と
borrower claims (自分が借りた loans から) を同時に持つことも
あります。どちらも同じ list に表示されます。下の role-specific
tabs では、それぞれの claim が何を返すかを説明します。

<a id="claim-center.claims:lender"></a>

#### あなたが lender の場合

あなたの lender claim は、loan の principal と accrued interest
を返します。ただし interest 部分から 1% の treasury cut が
差し引かれます。loan が settle されると (repaid、defaulted、
または liquidated)、すぐに claimable になります。claim は
あなたの lender position NFT を atomically に consume します
— 完了すると、その side の loan は完全に close されます。

<a id="claim-center.claims:borrower"></a>

#### あなたが borrower の場合

loan を full repay した場合、borrower claim は最初に lock した
collateral を返します。default または liquidation の場合に
戻るのは、Loan Initiation Fee からの unused VPFI rebate だけ
です — collateral 自体はすでに lender に渡っています。claim は
あなたの borrower position NFT を atomically に consume します。

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

接続中の chain 上で、あなたの wallet に関わる on-chain events
すべてを表示します — あなたが投稿または accept した offers、
loans、repayments、claims、liquidations。すべて chain から
live に読み取られます。落ちる可能性のある central server は
ありません。新しいものが先に表示され、transaction ごとに
group されるので、同じ click で行った操作はまとまって見えます。

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI を購入する

Buy ページでは、protocol の early-stage fixed rate で ETH を
VPFI に swap できます。supported chain ならどこからでも実行
できます — 裏側で routing します。VPFI は必ず、あなたが接続
している同じ chain の wallet に戻ってきます。network を切り
替える必要はありません。

<a id="buy-vpfi.discount-status"></a>

### あなたの VPFI Discount Status

現在どの discount tier にいるかをすばやく確認できます。Tier は
**vault** に入っている VPFI の量で決まります (wallet balance
ではありません)。このカードでは、(a) 次の tier に上がるまでに
vault へあとどれだけ VPFI が必要か、(b) Dashboard の consent
switch が on かどうかも見られます — discount は on の間だけ
適用されます。

vault にある同じ VPFI は自動的に "staked" 扱いになり、5% APR
を earn します。

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH で VPFI を購入する

使いたい ETH amount を入力し、Buy を押して、transaction に
sign します。それだけです。abuse 防止のため、per-purchase cap
と rolling 24-hour cap があります — 残りの上限は form の横に
live 表示されます。

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI を vault に入金する

VPFI を買うと、まず wallet に入ります。vault には入りません。
fee discount と 5% staking yield を得るには、自分で vault に
move する必要があります。これは必ず明示的な click です — アプリ
があなたの VPFI を勝手に動かすことはありません。1 transaction
(対応 chain では single signature) で完了します。

<a id="buy-vpfi.unstake"></a>

### Step 3 — vault から VPFI をアンステークする

VPFI を wallet に戻したいときは、このカードで vault から
withdraw します。注意: VPFI を引き出すと discount tier は
**即座に**下がります。open loans がある場合、その瞬間以降の
discount math は低い tier で計算されます。

---

## Rewards

<a id="rewards.overview"></a>

### Rewards について

Vaipakam では、次の 2 つに対して rewards が支払われます:

1. **Staking** — vault に置いている VPFI は、自動的に 5% APR
   を earn します。
2. **Interaction** — あなたが関わる loan で実際に settle した
   interest 1 ドルごとに、community-wide reward pool の daily
   share を得られます。

どちらも VPFI で支払われ、接続中の chain 上で直接 mint され
ます。bridge も chain switching も不要です。

<a id="rewards.claim"></a>

### Rewards を Claim する

button 1 つで、両方の reward streams を 1 transaction でまとめて
claim できます。Staking rewards はいつでも real time に claim
可能です。interaction-pool の share は 1 日に 1 回 settle される
ため、前回の settlement 以降に earned 分がある場合、total の
interaction 部分は次の daily window が閉じた少し後に live に
なります。

<a id="rewards.withdraw-staked"></a>

### ステーキング済みの VPFI を引き出す

VPFI を vault から wallet に戻します。wallet に戻ると 5% APR
を earn しなくなり、discount tier にも count されなくなります。
Buy VPFI ページの "unstake" と同じ action です — 便利なように
ここにも置いてあります。

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (このページ)

1 つの loan について、必要な情報を 1 ページにまとめています。
open されたときの terms、現在の health、各 side にいる人、そして
あなたの role で押せるすべての buttons — repay、claim、liquidate、
close early、refinance。

<a id="loan-details.terms"></a>

### Loan Terms

loan の fixed parts です: どの asset が貸されたか、amount、
interest rate、duration、そしてこれまでに accrued した interest。
loan が open している間、これらは変わりません。(別の terms が
必要なら refinance します — アプリは新しい loan を作り、同じ
transaction で今の loan を返済します。)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

この loan の collateral と、live risk numbers — Health Factor
と LTV です。**Health Factor** は 1 つの safety score です:
1 より上なら collateral が loan を十分 cover している状態、
1 に近づくほど risk が高く、loan が liquidate される可能性が
あります。**LTV** は「借りた amount」と「差し入れた value」の
比率です。position が unsafe になる thresholds も同じカードで
確認できます。

collateral が illiquid (NFT、または live price feed のない token)
の場合、これらの numbers は計算できません。その outcome には
offer 作成時に両 side が同意しています。

<a id="loan-details.collateral-risk:lender"></a>

#### あなたが lender の場合

これは borrower の collateral — あなたを守る buffer です。HF が
1 より上にある限り、十分に cover されています。HF が下がるほど
protection は弱くなります。1 を下回ると誰でも (あなたを含めて)
liquidation を trigger でき、DEX swap が collateral をあなたの
principal asset に変換して返済します。Illiquid collateral では、
default 時に collateral 全体があなたへ transfer されます —
それにどれだけの価値があるかは、そのままあなたが引き受けます。

<a id="loan-details.collateral-risk:borrower"></a>

#### あなたが borrower の場合

これはあなたの locked collateral です。HF は 1 より十分上に
保ってください — 1 に近づくほど liquidation risk が高まります。
通常は collateral を追加するか、loan の一部を repay することで
HF を戻せます。HF が 1 を下回ると誰でも liquidation を trigger
でき、DEX swap が slippage を受けた price であなたの collateral
を売って lender に返済します。Illiquid collateral では、default
時に collateral 全体が lender へ transfer され、あなたに戻る
residual claim はありません。

<a id="loan-details.parties"></a>

### Parties

この loan に関わる 2 つの wallet addresses — lender と borrower
— そして、それぞれの assets を保管する vault vaults です。loan
が open したとき、各 side は "position NFT" も受け取っています。
その NFT _こそ_ が、その side の outcome を claim する権利です
— 大切に扱ってください。誰かに transfer すると、新しい holder
が代わりに claim できます。

<a id="loan-details.actions"></a>

### Actions

この loan で使えるすべての buttons です。表示される set は、
この loan でのあなたの role によって変わります — 下の
role-specific tabs で各 side の options を確認できます。今は
使えない buttons は greyed out され、理由を示す小さな tooltip
が表示されます。

<a id="loan-details.actions:lender"></a>

#### あなたが lender の場合

- **Claim** — loan が settle された後 (repaid、defaulted、
  または liquidated)、principal と interest を戻します。ただし
  interest 部分から 1% treasury cut が引かれます。あなたの
  lender NFT を consume します。
- **Initiate Early Withdrawal** — loan の途中で lender NFT を
  他の buyer 向けに sale listing します。buyer があなたの side
  を引き継ぎ、あなたは sale proceeds を受け取って exit します。
- **Liquidate** — HF が 1 を下回るか grace period が切れたとき、
  誰でも (あなたを含めて) trigger できます。

<a id="loan-details.actions:borrower"></a>

#### あなたが borrower の場合

- **Repay** — full または partial. Partial repayment は outstanding
  を減らし、HF を改善します。Full repayment は loan を close し、
  Claim 経由で collateral を unlock します。
- **Preclose** — loan を早期に close します。Direct path:
  wallet から outstanding を今すぐ全額支払います。Offset path:
  collateral の一部を DEX で売り、その proceeds で repay し、
  残りを取り戻します。
- **Refinance** — 新しい terms の loan に乗り換えます。protocol
  は 1 transaction で、新しい principal から古い loan を返済
  します。collateral は vault から出ません。
- **Claim** — loan が settle された後、full repayment なら
  collateral を返し、default なら loan-initiation fee からの
  leftover VPFI rebate を返します。

---

## Allowances

<a id="allowances.list"></a>

### Allowances

offer を accept するとき、wallet が Vaipakam に「この特定の
token を代わりに move してよい」と approve することがあります。
一部の wallets は、こうした approvals を必要以上に長く残しがち
です。このページでは、この chain 上で Vaipakam に与えた approvals
を一覧し、任意のものを one click で off にできます。Non-zero
approvals (実際に live なもの) が上に表示されます。

clean な approvals list を保つのは、Uniswap や 1inch と同じく
良い hygiene です。

---

## Alerts

<a id="alerts.overview"></a>

### Alerts について

collateral の price が下がると、loan の safety score
(Health Factor) も一緒に下がります。Alerts に opt in すると、
誰かに liquidate される**前に**注意を受け取れます。小さな
off-chain service が 5 分ごとにあなたの loans を見守り、score
が danger band を越えた瞬間に ping します。gas cost はなく、
on-chain では何も起きません。

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

watcher が使う danger bands です。より危険な band に入ると
一度だけ fire します。次の ping は、さらに深い band に入った
ときだけです。より安全な band まで戻ると ladder は reset され
ます。defaults は typical loans 向けに調整されています。かなり
volatile な collateral を入れているなら、thresholds を高めに
してもよいでしょう。

<a id="alerts.delivery-channels"></a>

### Delivery Channels

通知をどこへ送るかを選びます。Telegram (bot が DM します)、
Push Protocol (wallet への direct notification)、または両方を
選べます。どちらの rails も上の threshold ladder を共有します
— 別々には tune しません。

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### NFT を検証する

Vaipakam の position NFTs は secondary markets に出てくることが
あります。他の holder から買う前に、NFT contract address と
token ID をここへ貼り付けてください。verifier は、(a) 本当に
Vaipakam が mint したものか、(b) underlying loan がどの chain
上にあるか、(c) その loan がどの state にあるか、(d) NFT を
on-chain で今誰が持っているか、を確認します。

position NFT _こそ_ が loan から claim する権利です。fake、または
すでに settled した position を見抜ければ、悪い trade を避けられ
ます。

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers について

"keeper" は、あなたの loans に対して特定の maintenance actions
を代わりに実行してよいと trust した wallet です — early
withdrawal の complete、refinance の finalise などです。keeper
があなたのお金を使うことはできません — repay、add collateral、
claim、liquidate はすべて user-only のままです。最大 5 keepers
まで approve でき、master switch を off にすれば全員を一度に
disable できます。

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

list 上の各 keeper は、**あなたが check した actions だけ**実行
できます。たとえば "complete early withdrawal" だけ許可された
keeper は、あなたの代わりに新しく開始することはできません —
あなたが開始したものを完了できるだけです。気が変わったら
checks を編集してください。keeper を完全に外したい場合は、
list から remove します。

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics について

wallet 不要で見られる、protocol 全体の透明な view です: total
value locked、loan volumes、default rates、VPFI supply、recent
activity。すべて on-chain data から live に計算されます — この
ページのどの数字にも private database はありません。

<a id="public-dashboard.combined"></a>

### Combined — All Chains

supported chains すべてを合計した protocol-wide totals です。
小さな "X chains covered, Y unreachable" の行は、page load 時に
どこかの chain network が offline だったかを示します — もし
あれば、該当 chain が下の per-chain table で flag されます。

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

同じ totals を chain ごとに分けた view です。どの chain に最も
TVL があるか、どこで loans が多く起きているか、どこかの chain
が stalled していないかを見るのに便利です。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

この chain 上の VPFI の live state です — total supply、実際に
circulating している量 (protocol-held balances を差し引いた後)、
そして cap の下でまだどれだけ mint 可能か。設計上、全 chains
を通じて supply は bounded に保たれます。

<a id="public-dashboard.transparency"></a>

### Transparency & Source

このページのどの数字も、blockchain から直接 re-derive できます。
このカードには snapshot block、data がいつ fetch されたか、各
metric がどの contract address から来たかが表示されます。数字を
verify したいなら、ここから始めます。

---

## Refinance

このページは borrower 専用です — refinance は borrower が自分の
loan に対して開始します。

<a id="refinance.overview"></a>

### Refinancing について

Refinancing は、collateral に触れずに既存の loan を新しい loan
へ乗り換える flow です。新しい terms で borrower-side offer を
投稿します。lender が accept すると、protocol が古い loan を
返済し、1 transaction で新しい loan を open します。collateral
が無防備になる瞬間はありません。

<a id="refinance.position-summary"></a>

### あなたの現在のポジション

refinance する loan の snapshot です — outstanding、accrued
interest、health、lock されているもの。新しい offer の size を
決めるときは、この numbers を参考にしてください。

<a id="refinance.step-1-post-offer"></a>

### Step 1 — 新しい offer を投稿する

refinance で希望する asset、amount、rate、duration の borrower
offer を投稿します。listed されている間も、古い loan は通常どおり
動き続けます — interest は accrue し、collateral はそのまま
です。他の users はこの offer を Offer Book で見られます。

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

lender が refinance offer を accept したら、Complete をクリック
します。protocol は atomically に、新しい principal から古い
loan を返済し、新しい loan を open し、その間ずっと collateral
を lock したままにします。1 transaction、2 state changes、exposure
window なしです。

---

## Preclose

このページは borrower 専用です — preclose は borrower が自分の
loan に対して開始します。

<a id="preclose.overview"></a>

### Preclose について

Preclose は「loan を早く close する」ための flow です。2 つの
paths があります:

- **Direct** — outstanding balance を今すぐ wallet から全額
  支払います。
- **Offset** — collateral の一部を DEX で売り、その proceeds で
  loan を返済します。残った分はあなたに戻ります。

cash があるなら Direct のほうが安く済みます。cash はないけれど
loan を走らせ続けたくもない、というときは Offset が選択肢です。

<a id="preclose.position-summary"></a>

### あなたの現在のポジション

早期 close する loan の snapshot です — outstanding、accrued
interest、現在の health。早期 close は fee-fair です — flat
penalty はなく、protocol の time-weighted VPFI math が accounting
を処理します。

<a id="preclose.in-progress"></a>

### Offset In Progress

少し前に offset preclose を開始し、swap step が mid-flight の
状態です。complete すれば proceeds で loan が settle され、残り
はあなたに戻ります。考えている間に price が動いた場合は、cancel
して新しい quote でやり直すこともできます。

<a id="preclose.choose-path"></a>

### 道を選ぶ

今すぐ loan を返済できる cash があるなら **Direct** を選びます。
exit するついでに collateral の一部を売りたいなら **Offset** を
選びます。どちらの path でも loan は full close されます。
preclose で half-close はできません。

---

## Early Withdrawal (Lender)

このページは lender 専用です — early withdrawal は lender が
自分の loan に対して開始します。

<a id="early-withdrawal.overview"></a>

### Lender Early Exit について

duration が終わる前に loan から exit したい場合、protocol 経由で
lender NFT を sale listing に出せます。buyer がそれを買うと、
loan のあなたの side を引き継ぎます — buyer が最終的な repayment
+ interest を collect します。あなたは受け取った payment とともに
exit します。

<a id="early-withdrawal.position-summary"></a>

### あなたの現在のポジション

exit しようとしている loan の snapshot です — principal、これまで
の accrued interest、残り時間、borrower の現在の health score。
buyer があなたの NFT の value を判断するときに見る numbers です。

<a id="early-withdrawal.initiate-sale"></a>

### 販売を開始する

asking price を設定すると、protocol があなたの lender NFT を
list し、buyer を待ちます。buyer が accept すると、proceeds が
あなたの wallet に届き、loan は続きます — ただし、あなたはもう
その side から外れています。listing が open で unfilled の間は
cancel できます。
