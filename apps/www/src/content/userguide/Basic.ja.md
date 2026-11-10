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

<a id="chapter.dashboard"></a>

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
protocol fee の割引を受けられます。このカードでは、接続中の
chain について次の内容を確認できます:

- ウォレットに今いくらの VPFI があるか。
- vault にいくらあるか (これが割引 tier の判定に
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

Vaipakam は、vault に置いてある VPFI の量に応じて protocol fees
の割引を適用できます。borrower にとっての割引は、loan の開始時に
loan 自身の asset で差し引かれる、より安い Loan Initiation Fee
です — そのために VPFI が使われることはありません。この switch は
「はい、お願いします」という同意 toggle です。一度 on にすれば
十分です。

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

報酬は **プラットフォーム・インタラクション** から得られます
— 参加しているローンに対して、どちら側でも、毎日少しずつ獲得
されます。あなたがいるチェーン上で VPFI で支払われ、ブリッジ
は不要です。

行の右側に小さなシェブロン矢印があります。それをクリックす
ると、Claim Center 内の完全な請求カードに直接ジャンプします。

まだ何も獲得していない場合でも、カードは
*合計獲得額: 0 VPFI* と開始方法のヒントとともに表示されます。
あなたは何も間違っていません — 表示する履歴がないだけです。


---

<a id="chapter.offer-book"></a>

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
一部 (`{liveValue:treasuryFeeBps}`%) は settlement 時に protocol treasury へ送られます。
この rate は loan の作成時に固定されるため、後から protocol fee が変更されても、すでに開いている loan は開始時の rate のままです。

---

<a id="chapter.create-offer"></a>

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

<a id="chapter.claim-center"></a>

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
を返します。ただし interest 部分から treasury cut が差し引かれます。
この cut の割合は loan 作成時に固定されたもので、その後の
プロトコル手数料の変更は影響しません。現在のレートで作成された
loan の cut は `{liveValue:treasuryFeeBps}`% です。loan が settle されると (repaid、defaulted、
または liquidated)、すぐに claimable になります。claim は
あなたの lender position NFT を atomically に consume します
— 完了すると、その side の loan は完全に close されます。

<a id="claim-center.claims:borrower"></a>

#### あなたが borrower の場合

loan を full repay した場合、borrower claim は最初に lock した
collateral を返します。default または liquidation の場合も、いちど確認してください。
債務とその清算にかかる費用に必要なぶんの価値だけが取られ、それを
超える分はあなたのものとして記録されます。その形は loan の終わり方
によります。collateral が取引所を通して売られた場合、残りは loan
自体の asset で届きます。売られずに引き渡された場合は、collateral
そのものがあなたを待ちます。引き渡し方は複数あり、loan の終わり方には関係ありません: liquidator が割引で直接引き取る場合、
close-out が売られずにプロトコル内部で反対側の position とマッチした場合、そして売却そのものが成立しなかった場合です — そのときは collateral が来ます。claim 時に lender が通る見積もりを持ち込まないかぎりで、持ち込めば loan 自体の
asset で支払われます。大半は持ち込みません。通常の liquidation も
default も、取引所に向かう前にその内部マッチを探します。つまりこの二つは結果が一定ではないということで、終わり方から推測せず claim
を読んでください。割引での引き取りは例外で、逆向きに確定しています: 売ることがないので、残るのは常に collateral です。価格を付けられない collateral の
default では、バスケット全体が失われ何も残りません。
この経路ではそれが結果ではなくルールです。
claim はあなたの borrower position NFT を consume します。逆は成り立ち
ません。liquidation のあとに NFT が残っていることは、何かが待っている
証拠ではありません。残余がなかった場合、受け取るものはなく、claim しようとすると
拒否され、それでも NFT は残りうるということです。NFT を
約束と受け取らず、claim が何と言っているかを読んでください。

---

<a id="chapter.activity"></a>

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

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI を入手する

VPFI は自由に transfer できます。VPFI が取引されている open
market で入手するか、bridge で持ち込んでください — VPFI は
Chainlink CCIP token なので、official bridge を使って supported
chains 間を移動し、あなたが接続している chain の wallet に届き
ます。

<a id="buy-vpfi.discount-status"></a>

### あなたの VPFI Discount Status

現在どの discount tier にいるかをすばやく確認できます。Tier は
**vault** に入っている VPFI の量で決まります (wallet balance
ではありません)。このカードでは、(a) 次の tier に上がるまでに
vault へあとどれだけ VPFI が必要か、(b) Dashboard の consent
switch が on かどうかも見られます — discount は on の間だけ
適用されます。

<a id="buy-vpfi.deposit"></a>

### VPFI を vault に入金する

wallet にある VPFI は discount tier の判定に count されません。
fee discount を unlock するには、自分で VPFI を vault に move
する必要があります。これは必ず明示的な click です — アプリ
があなたの VPFI を勝手に動かすことはありません。1 transaction
(対応 chain では single signature) で完了します。

<a id="buy-vpfi.unstake"></a>

### vault から VPFI を引き出しする

VPFI を wallet に戻したいときは、このカードで vault から
withdraw します。注意: VPFI を引き出すと discount tier は
**即座に**下がります。open loans がある場合、その瞬間以降の
discount math は低い tier で計算されます。

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards について

Vaipakam は **プラットフォーム・インタラクション報酬** を支払
います: あなたが関わる loan で実際に settle した interest 1 ドル
ごとに、community-wide reward pool の daily share を得られます。

rewards は VPFI で支払われ、接続中の chain 上で直接 mint され
ます。bridge も chain switching も不要です。

<a id="rewards.claim"></a>

### Rewards を Claim する

button 1 つで、accrued した rewards を 1 transaction でまとめて
claim できます。interaction-pool の share は 1 日に 1 回 settle
されるため、前回の settlement 以降に earned 分がある場合、それ
は次の daily window が閉じた少し後に live になります。

---

<a id="chapter.loan-details"></a>

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
  interest 部分から loan 作成時に固定された treasury cut
  (現在のレートで作成された loan は `{liveValue:treasuryFeeBps}`%)
  が引かれます。あなたの lender NFT を consume します。
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
  collateral を返します。default でも surplus が残ることがあります。
  collateral は債務とその清算費用に必要なぶんだけが取られ、それを
  超えて預けていた分はあなたの claim として記録されます。それが何かは経路によります —
  Claim Center の節を参照してください。

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### Alerts について

collateral の price が下がると、loan の safety score
(Health Factor) も一緒に下がります。Alerts に opt in すると、
誰かに liquidate される**前に**注意を受け取れます。小さな
off-chain service が 5 分ごとにあなたの loans を見守り、score
が danger band を越えた瞬間に ping します。gas cost はなく、
on-chain では何も起きません。

<a id="alerts-inbox"></a>

### アラートの受信箱

アラートのページには、プロトコルのインデックスが、いま使っているネットワーク上のあなたのウォレット向けに保持しているアラートが新しい順に並びます。無料で、登録も必要ありません。アラートは、ローンの開始、一部または全額の返済、デフォルトや清算、期日の接近、猶予期間への突入や終了、ヘルスが1.5、1.2、1.05を下回ったとき、そして報酬エントリーの請求期限が近づいたときや過ぎたときに書かれます。各アラートはローンのページ（チェーンから読み直します）を開き、報酬の場合は Claims を開きます。上部のウォレットの横にあるベルは、このブラウザーで最後にページを開いてから届いたアラートの数を示します。インデックスを読めないときは、空の受信箱を表示せず、そのことを伝えます。Telegram、プッシュ、ヘルス警告、支払いリマインダーは受信箱のすぐ下で設定します。各アラートは書かれた時点の状況を示します。現在の状況はローンを開いて確認してください。

<a id="alerts-channels"></a>

### Telegram、プッシュ、警告

受信箱の下で、アラートページはアプリの外で届くアラートを設定します。変更はどれもウォレットでの無料の署名で、トランザクションではありません。Telegram を連携するには「Telegram を連携」を押し、1 回限りのコードを 10 分以内に Vaipakam ボットへ送り、続けてテストアラートを送ります。そのメッセージがチャットに届けば連携は機能しています。プッシュは、アラートサービスが今送信できると答えたときだけ表示されます。プッシュアプリで Vaipakam チャンネルを購読する必要もあり、停止するにはそこで購読を解除します。Telegram かプッシュを設定すると、ヘルス警告はヘルス 1.5、1.2、1.05 で常に有効です。支払いリマインダーはオフとオンを切り替えられます。ページはこのブラウザーで行ったことを示します。別の端末で行った連携や設定が存在する場合もあります。

<a id="alerts-paid-push"></a>

### 有料のプッシュアラート

一部のネットワークでは、アラートサービスがローンに関するプッシュアラートに VPFI で少額の手数料をかけます。手数料をかけられるのは、事前にオンチェーンで同意した場合だけで、同意した上限までです。「有料のプッシュアラート」の欄には、このネットワークの手数料と、ここでサービスが手数料をかけるかどうかが表示されます。手数料はボールトの空き VPFI から、ローンの各側につき最大 1 回、そのローンについて最初の有料プッシュアラートが送られたときに差し引かれます。差し引かれた手数料は返金されず、Telegram のアラートは無料です。上限内の値上げは、改めて確認されずに適用されます。同意はいつでも取り消せます。

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics について

1つのネットワーク上のプロトコルを、ウォレットなしで見られる
ページです。対象はアプリが読み取っているネットワークです。何も
接続する必要はありません。ページは2つの公開情報源に基づき、各
数値がどちらから来たかを示します。キーなしで誰でも照会できる
公開インデクサーと、プラットフォームのコントラクトそのものです。
数値を鵜呑みにする必要はありません。

<a id="public-dashboard.loans-offers"></a>

### ローンとオファー

状態別のローン件数(アクティブ、返済済み、デフォルト、清算済み
など)と状態別のオファー件数で、公開インデクサーから取得します。
インデクサーが報告しなかった件数は「報告なし」と表示され、ゼロと
表示されることはありません。数えるのはオンチェーンのオファーのみ
で、ガス不要の署名済み注文はここでは数えません(Offer Book には
表示されます)。オファーの合計は現在記録されているオファーで、
累計ではありません。

<a id="public-dashboard.recycling"></a>

### リサイクル勘定とループクロージャー

各日の報酬プールがどこから来て、そのうちどれだけが引き出された
か、そしてクレームで支払われた報酬 VPFI のうちどれだけがプラット
フォーム内にとどまっているかを示します。公開インデクサーの帳簿
記録です。まだ分からない数値は、ゼロを表示せずにそのことを示し
ます。

<a id="public-dashboard.transparency"></a>

### 透明性と情報源

プラットフォームのコントラクトのアドレス(ブロックエクスプローラー
で開くリンク付き)、ネットワーク、インデクサーが最後に読み取った
ブロックとそれがどれだけ前か。インデクサーの数値はそのブロック
時点までのものなので、経過時間を表示しています。

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI トークン

インデクサーではなく、プラットフォームのコントラクトから直接読み
取ります。VPFI トークンのアドレスと、このネットワーク上の供給量
です。VPFI が発行されるネットワークでは、供給量の上限、上限内で
まだミントできる量、ミントを許可された唯一のアドレスも表示します。
ブリッジで VPFI が届くネットワークでは、そのネットワークの供給量
のみを表示します。

<a id="public-dashboard.fees"></a>

### 手数料とトレジャリー

これもコントラクトから読み取ります。記録開始以降、過去1日、過去1
週間にプロトコルが記録した手数料と、その送り先のトレジャリーアドレ
スです。ページは読み取ったブロック、その読み取りの経過時間、呼び出
した関数を示し、手数料の数値が実際の徴収額より少なくなりうる理由を
すべて記載します。基準通貨が変更された後は以前の手数料が旧単位のま
ま残り、合計が多くも少なくもずれることがあります。ページはこのこと
も記載します。読み取れなかった数値は、ゼロを表示せずにそのことを示
します。

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.next-app"></a>

## 次のアプリ

Vaipakam アプリの次のバージョンは、現在のアプリと並んで
1 ページずつ作られています。まだ作られていないページはそう
表示し、そのページを引き続き提供している現在のアプリへ案内
します。この章では、すでに作られたページを説明します。

<a id="advanced-mode"></a>

### Basic と Advanced

Basic は多くの人に必要なものを表示します。Advanced では、
exit と精算のツール、自動化、署名済み注文、keeper の状態、
会計の詳細が加わります。モードを切り替えても、あなたが与える
べき同意、あなたを止めているもの、その解決方法が隠れることは
ありません。説明する文のすぐ後にある情報ボタン (i) は、どれも完全な
説明を開き、その
「詳しく読む」リンクは、今のモードでこのガイドを開きます。

<a id="wallet"></a>

### あなたの wallet と数字の出どころ

アプリは、あなたの loan、vault、claim を、まず wallet 自身の
ネットワーク接続を通じて読み取ります。wallet が接続を提供
しない場合にだけ、読み取り専用のプロキシを使います。あなた
自身の数字が共有インデックスから取られることはありません。
上部に表示されるアドレスとネットワークが、ページ上のすべての
数字の持ち主です。wallet がアプリの対応していないネットワーク
にある場合、切り替えるまであなたのものは何も表示されません。上部のアドレスを選ぶと、全体の表示、コピー、アプリが対応する別の network への切り替え、接続の解除ができます。アプリは Ethereum mainnet を一切読まないため、ネームサービスの名前ではなくアドレスそのものを表示します。

<a id="deployments"></a>

### デプロイが対応している機能

アプリは操作を提示する前に、あなたのネットワーク上の
プロトコル contract が今どの機能に対応しているかを読み取り
ます。アップグレードでこの一覧は変わることがあり、読み取る
ことで、アプリは失敗する代わりに何が変わったかを伝えられ
ます。一覧が読み取れない間は、署名の手順は提示されません。

<a id="home-start"></a>

### Home: やることを選ぶ

Home は「やりたいこと…」から始まります。借りる、貸す、NFT を
借りる、自分の NFT を貸す、持っているものを管理する、の中から
選びます。どれを選んでも案内付きのページが開きます。借りると
貸すでは、まず条件の合うオファーが表示され、合うものがなければ
自分のオファーを出せます。NFT のレンタルは両方の側を扱います。
他の人の NFT を使うことも、vault に入れたまま自分の NFT を
誰かに使ってもらうこともできます。wallet を接続すると、Home
には非表示にできる短い入門カードも 3 枚表示されます。

<a id="home-status"></a>

### Home: プロトコルの状態

Home は、あなたのネットワークでプロトコルが動いているかどうか
を常に表示します。インシデントで一時停止している間は、新しい
ポジション、claim、引き出し、清算、デフォルト、keeper の手順が
止まります。全額返済、一部返済、担保の追加は引き続き可能で、
停止していた時間はすべての未完了 loan の期日に加算されます。
自動停止は決まった時間だけ続き、次の自動停止はクールダウンの
後にしか始まりません。keeper サービスは単独で停止されることが
ありますが、それがあなた自身の操作を止めることはありません。
状態が読み取れないときは、動いていると決めつけず、Home の上部
にそう表示します。

<a id="home-payouts"></a>

### Home: 受け取り可能

loan が終了し、今 claim すれば支払いを受けられるとき、受け取り
可能になります。貸し手には返済、借り手には返却される担保
(またはその残り)、レンタル終了時には返却される NFT です。
Home はそれらを最初に並べ、Claims へ案内します。Claims では
受け取る前にすべての金額を確認できます。

<a id="home-loans"></a>

### Home: あなたの loan

進行中の各 loan には、あなたの立場、条件、担保、次の期限が、
急ぐものから順に表示されます。loan は期日に返済期限を迎えます。
その後に猶予期間があり、借り手はまだ延滞料を付けて返済できます。
猶予期間が終わると誰でもデフォルトを開始でき、loan は担保から
精算されます。health factor は担保の価値と債務を比べたもので、
1 を下回ると loan は清算される可能性があります。価格のない資産の
loan には health factor がありません。あなたのオファーから
開かれた loan はまとめて表示されます。

利息を定期的に支払う loan には、期日当日までの支払い時点もあります。支払い時点の猶予期間が終わっても未払いの利息は、担保を売却して支払われることがあり、loan はそのまま続きます。Home は次の支払い時点を表示し、未払いのものを先頭に置きます。期日と同じ日の支払い時点でも同様です。その猶予期間は loan の猶予期間より先に終わることがあるためです。プロトコルはこの精算を停止できます。その場合、Home は支払い時点で担保が売却されないことを示します。

<a id="home-exposure"></a>

### Home: 貸しと借り

貸しと借りの両方があるとき、Home は今日の価値で両方を比べます。
NFT や価格のない資産など、評価できない loan は数だけ示して
除外し、それらが答えを変えられない場合にだけ、大きい方を
示します。

<a id="home-faucet"></a>

### Home: テスト資産

テストネットでは、Home が本物のお金を使わずに借入・貸出・レンタルを試せるテスト用トークンと NFT を用意しています。これらに価値はなく、プロトコルではなくテスト用トークンのコントラクトが発行します。テスト用トークンの一部にはテスト価格があり、それを使うローンにはヘルスファクターがあります。価格のないものもあり、その場合デフォルトでは担保そのものが引き渡されます。テスト用 NFT は貸し出せます。発行のたびに先に受領書が表示され、その後チェーン上で結果が確認されます。

<a id="home-fee-discount"></a>

### Home: 手数料割引

手数料割引は、ウォレット全体に対するネットワークごとの一つの設定です。オフの間は、保有する VPFI の量に関係なく手数料は割り引かれません。オンの間は、借りるときに払う手数料と、貸し手として得る利息にかかる手数料が、各手数料が課される時点の VPFI 割引ティアに応じて減額されます。ティア 0 では割引はありません。ネットワークによっては貸し手の割引がボールトの VPFI で支払われ、どちらになるかは確定前に受領書に表示されます。オンにするには現行の利用規約への同意が必要ですが、オフにするのに必要になることはありません。プロトコルが一時停止している間は、どちらの方向にも変更できません。流動性のない貸出資産のローンでは借入手数料は満額のままで、割引が手数料の半分を超えることはありません。

<a id="home-rewards"></a>

### Home: リワード

リワードは、このネットワークでの貸し借りに対する利用リベートで、リワード日ごとに数えられ VPFI で支払われます。アプリはまずクレームをプレビューとして実行するため、Home には今クレームした場合に支払われる額がそのまま表示されます。プレビューを実行できないときは、その旨を明記した下限値を代わりに表示し、正確な額が出せるまでクレームを提示しません。1 回のクレームで支払われるのは最大 30 リワード日分で、残りがあれば Home が再度のクレームを提示します。途中で止めても問題ありません。クレームはすぐに使える状態でボールトに届き、ボールトが受け取れない場合はウォレットに届きます。クレームがボールトを開設することはありません。あるリワード日がネットワーク横断の確定や、このネットワークへの資金の到着をまだ待っている場合、Home は失敗するクレームを提示する代わりにその日を示します。リワードは利息でも利回りでもなく、クレームによって何かがステーキングや再投資されることはありません。 まれに、クレームが何も支払わないまま、何も支払われなかった報酬日を先へ進めることがあります。その後の日を支払えるようにするためで、Home はそのことを伝えたうえでクレームを提示します。

<a id="home-rewards-expiry"></a>

### Home: リワードの削除日

未請求のリワードが削除されうるネットワークでは、Home はリワードのうち最も早い削除予定日の見積もりと、その前の最後の 90 日間には最終通知を表示します。それより前にクレームすれば、リワードは必ず保持されます。見積もりは現状では実際の日付より後になることはありません。リワードをクレームできない期間は実際の日付を後ろへずらしますが、ネットワークのクレーム期間の変更によって早まることもあるため、頼る前にもう一度確認してください。すべてのリワードを確認できなかった場合、Home は期限のものがないとは言わず、その旨を表示します。ネットワークが何も削除しない場合、日付は表示されません。

<a id="home-rewards-held"></a>

### Home: 保留中のリワード

制裁チェックがウォレットにフラグを立てると、フラグが続く間は何も支払われません。フラグ以前に得たリワードはそのウォレットのために保留され、ロックされていますが失われてはおらず、フラグが外れると解放されます。そのとき Home はその残高だけをそのままクレームできるよう提示します。フラグが確定している間に得たリワードは永久に没収され、ボールトの VPFI は動かせません。ウォレットがまだフラグ付きかどうかを読み取れない場合、何も解放されません。

<a id="borrow-start"></a>

### Borrow: 仕組み

借りるには、貸し手が出しているオファーを受けます。オファーは、あるトークンの金額、金利、期間、そして貸し手が求める担保からなります。受けると、1回のトランザクションでローンが始まります。担保はウォレットからあなた自身のボールトに移り、ローンが続く間ロックされます。金額は、少額の組成手数料を差し引いてウォレットに届きます。期日までに元本と利息を返済します。合うオファーがないときは、自分の借入リクエストを出して貸し手を待つこともできます。

<a id="borrow-pair"></a>

### Borrow: トークンを選ぶ

まず、借りるものとロックするものを選びます。アプリがネットワーク上のトークンを提案しますが、トークンアドレスを貼り付けることもできます。トークンの安全性チェックは行われないため、貼り付けたアドレスはご自身で確認してください。アプリは各トークンについて、プロトコルが今どう扱っているかを読み取ります。流動性のあるトークンには価格があり、ローンにはヘルスファクターがあって、担保の価値が下がると清算されることがあります。流動性のないトークンは価値ゼロとして扱われ、デフォルト時には貸し手が担保そのものを受け取ります。プロトコルがあるトークンの価格を信頼していない間は、そのトークンでの新規ローンは停止されます。既存のローンには影響しません。

<a id="borrow-offers"></a>

### Borrow: オファーを選ぶ

ページには、選んだ2つのトークンについて貸し手が出しているオファーが、プロトコルから直接読み取って表示されます。各オファーには、金額・金利・期間、求められる担保、現在価格でのローン・トゥ・バリュー、利息のかかり方、利払いスケジュールの有無、オファーの終了時期、手数料差し引き後に受け取る額が示されます。オファーは丸ごと、貸し手の上限金額と最低金利で受けます。プロトコルが拒否するオファーには理由が表示され、ボタンは出ません。並び順は便宜上のもので、助言ではありません。

ページはまず借りる二つの方法を示します。今すぐオファーを受けるか、リクエストで自分の金利を決めて貸し手を待つかです。オファーは金利ごとにまとめられ、低い順に並びます。各段にはオファーの数とそれぞれの金額が表示され、金額が合計されることはありません。オファーは一つを丸ごと受けるからです。受け入れる最高金利を入力でき、これはオファーを隠すだけで、隠した数を示します。リクエストの横には、このペアに待機している貸し手が表示されます。マッチングサービスは条件が貸し手の上限内に収まるときにその資金でリクエストを成立させるため、成立する可能性は高いものの、即時でも保証でもありません。

<a id="borrow-review"></a>

### Borrow: 確認と署名

ウォレットが開く前に、確認画面ですべての数字が示されます。受け取る額、手数料、ロックする額、金利、期日に支払う額、猶予期間、そして失う可能性のあるものです。リスク開示と規約に同意するチェックを入れます。確定前に数字が変わるとチェックは外れます。次にウォレットが、費用のかからない条件への署名、必要な場合は担保額ちょうどの承認、そして受諾の送信を求めます。送信の前にアプリは試行実行を行います。承認の後に止まった場合、アプリは承認を元に戻すよう求め、戻ったかどうかを伝えます。完了後、アプリは開始されたローン、届いた額、ロックされた額をチェーン上で確認します。ローン期間中の条件も、既定値であっても一つずつ示します。一部返済、担保の売却、借り換えや関連ローンの有無です。返済額は一時停止がない場合の金額です。一時停止があると期日はその分だけ後ろにずれ、その間も利息は発生し続けます。確認画面には、プロトコルが現在その金額と担保をいくらと評価するかも表示されます。これらの数字は参考情報で、価格とともに変わります。

<a id="borrow-fee"></a>

### Borrow: 組成手数料

ローンを始めるには、金額のわずかな割合が一度だけ、借りるトークンで、受け取る額から差し引かれます。適用される料率は確認画面に表示されます。利息は金額全体にかかります。手数料割引がオンで、借りるトークンに流動性がある場合、あなたの割引ティアが手数料を下げます。この手数料のために VPFI が取られたり保持されたりすることはなく、後から返金されることもありません。 受諾を自分で送信するため、手数料のうちプロトコルがマッチの送信者に支払うわずかな分が、金額と一緒にあなたに戻ります。確認画面に表示されます。

<a id="borrow-risks"></a>

### Borrow: リスク

ローンでは担保を失うことがあります。猶予期間の終わりまでに返済しないと、ローンはデフォルトとなり、貸し手には担保から支払われます。プロトコルが売却できる場合は売却され、できない場合はそのまま引き渡されます。流動性のある担保の場合、価値が下がってヘルスファクターが 1 を下回ると、誰でもローンを清算でき、担保を失います。全期間利息の場合、早期に返済しても全期間分の利息がかかります。利払いスケジュールがある場合、支払われなかった期間は担保の一部を売却して支払われます。ローンが返済または決済されるまで、担保はロックされたままです。

<a id="borrow-request"></a>

### Borrow: 自分のリクエストを出す

合うオファーがないときは、2つのトークンについて自分の借入リクエストを出せます。正確な金額、支払う金利、期間、ロックする担保を指定します。掲載すると担保はウォレットからあなた自身のボールトに移り、リクエストが開いている間そこに置かれます。貸し手がリクエストを受けると、改めて確認されることなく、あなたの条件ですぐにローンが始まります。金額は組成手数料を差し引いてウォレットに届きます。掲載の5分後からキャンセルでき、担保はウォレットに戻ります。期限が切れたリクエストはもう受けられません。担保は、あなたか誰かが閉じるまでボールトに残り、その後あなたのウォレットにだけ戻ります。次のアプリのオファーページができるまでは、リクエストの確認・キャンセル・クローズは現在のアプリのオファーページで行います。確認画面は、何かがロックされる前にそのことを伝えます。入力した各金額の下に、プロトコルが現在その金額をいくらと評価するかを、プロトコル自身の単位で表示します。価格のない資産については、数字の代わりにそのことを示します。

<a id="borrow-request-terms"></a>

### Borrow: リクエストの条件

1人の貸し手が全額を受けるか、誰も受けないかのどちらかです。数字は入力どおりに正確に読まれます。トークンの桁数を超える小数は四捨五入せずに拒否され、金利は年100%まで、小数第2位まで指定できます。選べる期間はネットワークが認める最長のものまでで、日数を直接入力することもできます。リクエストは、受けられるかキャンセルされるまで、または選んだ日数（最長1年）の間開いています。通常の選択である全期間利息は、早く返済しても全額かかります。日割りはローンが続いた期間の分だけです。フォームには、今貸し手が受けた場合に今日の手数料率で受け取る額と、期日に支払う額が表示されます。

<a id="borrow-request-review"></a>

### Borrow: リクエストの確認と掲載

ウォレットが開く前に、アプリはプロトコルにリクエストを試行実行させるので、確認画面にはプロトコル自身の答えが示されます。今ロックするもの、金額・金利・期間、受け取る額と手数料の決まり方（貸し手が受けた時点で有効な手数料率から、その時点の手数料割引ティアの分を引いたもの。表示額は今日の率によります）、支払う額、ローン期間中のすべての条件、リクエストの期限、ローン・トゥ・バリュー、承認が必要かどうかが並びます。リスク開示と規約に同意するチェックを入れます。必要ならウォレットが担保額ちょうどを承認し、アプリがもう一度試行してから掲載します。承認の後に止まった場合、アプリは承認を元に戻すよう求め、戻ったかどうかを伝えます。完了後、アプリは記録されたリクエストとロックされた担保をチェーン上で確認します。

<a id="borrow-nft-collateral"></a>

### Borrow: NFT を担保にする

リクエストではトークンの代わりに NFT を 1 つロックできます。ロックするものとしてコレクションを選びます（テスト用コレクションには NFT の印があり、アドレスを貼り付けることもできます）。アドレスがトークンか NFT コレクションかは、そのコントラクトから読み取ります。次に NFT の番号、つまりトークン ID を入力します。ウォレットやコレクションのページに表示されています。フォームは、ウォレットがそれを保有しているかをすぐに示します。プロトコルは NFT を、他の場所での売値にかかわらずゼロと評価します。NFT を担保にしたローンには LTV も価格による清算もなく、猶予期間の終わりまでに返済しなければ、貸し手はその NFT 自体を受け取ります。掲載時、ウォレットはプロトコルにその NFT 1 つだけを承認し、コレクションの残りは決して承認しません。NFT を金庫へ移すと、その承認は自動的に消えます。承認の後でリクエストが止まった場合、アプリは承認を元に戻すよう求め、戻ったかどうかを伝えます。数量のある NFT（マルチトークンのコレクション）も同じように、数量付きで使えます。トークンの番号とロックする数を入力すると、フォームはウォレットの保有数を示します。このようなコレクションは 1 つのトークンだけを承認できず、そこにあるあなたのトークンすべてしか承認できません。そのため掲載時はこのリクエストのためだけに承認を与え、リクエストが通ったかどうかにかかわらず、その後もう 1 回のウォレット操作で取り消します。以前から与えていた承認は、設定したままにします。NFT を求める貸し手のオファーを受けるのは、当面引き続き現在のアプリで行います。

<a id="borrow-request-range"></a>

### Borrow: 金額の範囲（上級）

上級モードでは、リクエストに範囲を設定できます。貸し手が貸せる最小額と最大額をあなたの一つの金利で示し、必要なら最小のローン用に少ない担保を指定できます。リクエストを直接引き受ける貸し手は最小額を貸し、そのために設定した担保だけをロックし、残りはあなたのウォレットに戻ります。ネットワークでマッチングがオンの間は、マッチングによって最大額まで多く貸すことができます。レビューはオンかどうかを示し、オフの間は範囲が一度だけ満たされることを伝えます。プロトコルは、今日の価格で担保が支えられない最大額を拒否し、レビューは支えられる上限を示します。レビューは両端の LTV を表示し、今日の価格では貸し手が直接引き受けられない場合に警告します。上級モードで設定したオプションは基本モードに切り替えても有効です。フォームがその旨を示し、解除もできます。マッチでロックされるのは、そのレンダーが求める担保だけです（最低でもフロア分）。そのため確認画面は、最大のマッチを担保すべての場合からフロアのみの場合まで示し、マッチしたローンは直接の受け入れよりリスクが高い状態で始まりうると警告します。マッチングがオンの間、マッチがロックしない担保は後のマッチのためにリクエストに残り、リクエストが閉じるか、あなたがキャンセルしたときにだけウォレットに戻ります。

<a id="borrow-request-fill"></a>

### Borrow: リクエストの約定方法（上級）

既定の「部分」では、リクエストが約定、キャンセル、失効のいずれかになるまで、マッチングが一件以上のローンで満たせます。「全部か無か」は全額の一回の約定だけを認めるため、範囲とは併用できません。「即時またはキャンセル」は部分と同様に満たしますが、リクエストが失効するまでなので、有効期限が必要です。約定方法は投稿後に変更できません。変えるにはリクエストをキャンセルして新しく投稿してください。プロトコルでは、リクエストが開いている間、マッチですでに使われた分を下回らない範囲で金額、金利、担保を変更できますが、このアプリはまだその操作を提供していないため、現時点で変更するにはキャンセルして投稿し直す必要があります。

<a id="borrow-request-cadence"></a>

### Borrow: 利息の支払いスケジュール（上級）

上級モードでは、リクエストの利息を返済時の一括ではなく、毎月・四半期ごと・半年ごと・毎年のスケジュールで支払うようにできます。フォームはプロトコルがあなたの条件で認めるスケジュールだけを提示し、選べないものにはその理由を表示します。理由は、ネットワークで定期利息がオフになっている、資産に価格がない、ローンの価値がプロトコルのしきい値より低い（両方の数値を表示）、または期間がローンより短くない、のいずれかです。確認画面には各期間の利息と、支払いが遅れた期間の猶予期間が表示されます。猶予期間の終わりまでに期間の利息が支払われないと、誰でもあなたの担保の一部を売却してそれを支払うことができ、ローンは継続します。スケジュールは投稿後に変更できません。他の上級オプションと同じく、ベーシックに切り替えても適用され続け、フォームにもそう表示されます。

<a id="borrow-request-tariff"></a>

### Borrow: フル手数料タリフ（上級）

上級モードでは、リクエストにフル手数料タリフを付けられます。各ローンが開くときにあなたの保管庫から VPFI で取られる手数料で、ローン手数料の割引を10ポイント上乗せします（プロトコルの上限は50%）。ローン手数料そのものは引き続き貸付資産で課され、タリフは返金されません。フォームはプロトコルがタリフをオンにしている間だけ選択肢を出し、金額と期間に対する今日のタリフを表示します。1件のローンが取れる VPFI の上限（空欄なら最大のローンに対する今日のタリフ）と、開くときにタリフを取れないローンの扱い（拒否する、またはタリフなしで開く）を決めます。ローンがタリフを取れるのは、その時点でタリフがオンで、貸付資産に価格と流動性があり、タリフが上限内で、保管庫に十分な空き VPFI がある場合だけです。タリフはリクエストの投稿後に2つ目のトランザクションで設定されるため、その確定前にリクエストを受けた貸し手はタリフなしでローンを開きます。誰も受けないリクエストへのバックストップ融資は、このアプリではまだ提供していません。

<a id="lend-start"></a>

### Lend: 仕組み

貸し出すには、借り手の公開中のリクエストに資金を出します。リクエストは、あるトークンの金額、借り手が支払う利率、期間、そして借り手がすでに自分のボールトにロックした担保で構成されます。資金を出すと、1回のトランザクションでローンが開始されます。金額はあなたのウォレットから出て、借り手は組成手数料を差し引いた額を受け取り、担保はローンが終わるまであなたのためにロックされたままになります。ローンのあなたの側はウォレット内のポジショントークンで、それを持つ人が返済を受けます。借り手は期日までに金額と利息を返済し、プロトコルは利息から自らの取り分を受け取ります。合うリクエストがないときは、同じページから自分の貸出オファーを出せます。

<a id="lend-offers"></a>

### Lend: リクエストを選ぶ

まず、貸すものと受け入れる担保を選びます。両者は別のトークンである必要があり、このページで選べるのはトークンだけです。ページには、そのペアで公開中の借入リクエストが、プロトコル自体から読み取って一覧表示されます。各リクエストには、金額、利率と期間、ロックされた担保、今日の価格でのローン資産価値比率、利息の課し方、利息スケジュールの有無、借り手の手数料のうちあなたに戻る額が表示されます。リクエストは丸ごと資金提供されます。範囲が指定されている場合は、借り手の最小金額を最高利率で貸します。プロトコルが拒否するリクエストについては、ページが理由を示し、ボタンは表示しません。あなた自身のリクエスト、NFT を含むリクエスト、進行中のローンの売却は、件数のみ表示され一覧には出ません。並び順（資金提供できるものが先、次に利率の高い順）は便宜上のもので、助言ではありません。

<a id="lend-review"></a>

### Lend: 確認と署名

ウォレットが開く前に、確認画面はすべての数値を示します。ウォレットから出る額、借り手が受け取る額、手数料とそのうちのあなたの取り分、あなたのために保持される担保、利率、期日に支払われる利息、そのうちのプロトコルの取り分、あなたに戻る額、猶予期間、そして失う可能性のあるものです。ライフサイクルの各条件も、既定値であっても明示します。ウォレットの残高が金額に満たない場合は、不足額を示し、署名は提示しません。リスク開示と利用規約に同意するためにボックスにチェックを入れます。確認前に数値が変わるとチェックは外れます。その後ウォレットは、費用のかからない条件への署名、必要な場合は金額ちょうどの承認、そしてアプリがまずドライランで試す受諾の送信を求めます。承認の後で止まった場合、アプリは承認を元に戻すよう求め、戻ったかどうかを伝えます。その後アプリは、開始したローン、ウォレットから出た額、戻ってきた額をチェーン上で確認します。

<a id="lend-fee"></a>

### Lend: 手数料とプロトコルの取り分

組成手数料は借り手が負担します。金額のわずかな割合が、貸し出す資産で一度だけ課され、借り手が受け取る額から差し引かれます。あなたは全額を貸し、借り手はそれを利息とともに全額返済します。受諾をあなた自身が送信するため、その手数料のごく一部、つまりプロトコルがマッチの送信者に支払う取り分があなたのウォレットに戻ります。確認画面に表示されます。借り手が Full 手数料タリフを選び、ローン開始時にそれが適用されると、手数料は下がり、その取り分も下がります。利息が支払われるとき、プロトコルはローン開始時に有効な料率で自らの取り分を受け取ります。手数料割引の設定がオンの間は、あなたの手数料割引ティアがその取り分を下げることがあります。確認画面には今日の料率と、その取り分の上限が表示されます。

<a id="lend-risks"></a>

### Lend: リスク

貸し出しでお金を失うことがあります。猶予期間の終わりまでに借り手が返済しない場合、ローンはデフォルトとなり、担保から支払われます。プロトコルが可能な場合はあなたのために売却され、できない場合はそのまま引き渡されます。売却で得られる額が、あなたへの債務を下回ることもあります。流動性のある担保では、ヘルスファクターが 1 を下回ると誰でもローンを清算できます。売却はまずあなたに返済しますが、急落すると債務を下回る額しか残らないこともあります。流動性のないトークンは価値ゼロとされるため、価格に基づく清算はなく、デフォルト時にはその価値にかかわらず担保をすべて受け取ります。ローンが終わる前に金額を取り戻すことはできません。早く抜けるには、ポジションを別の貸し手に売却します。日割り利息では、早期返済だと受け取る額が減ります。一時停止は期日を後ろにずらし、その間も利息は発生し続けます。

<a id="lend-offer"></a>

### Lend: 自分のオファーを出す

合うリクエストがないときは、2つのトークンについて自分の貸出オファーを出せます。貸す正確な金額、求める金利、期間、借り手がロックすべき担保を指定します。掲載すると金額はウォレットからあなた自身のボールトに移り、オファーが開いている間そこにロックされます。借り手がオファーを受けると、改めて確認されることなく、あなたの条件ですぐにローンが始まります。借り手は組成手数料を差し引いた金額を受け取り、借り手の担保はあなたのために借り手のボールトにロックされます。ネットワークでマッチングがオンの間は、誰でもあなたのオファーを借り手のリクエストとマッチさせることもでき、パートを設定していなければ、そのローンはあなたの金利で全額を貸し、担保は少なくともあなたが求める量になります。マッチングが今オンかどうかは確認画面に示されます。掲載の5分後からキャンセルでき、金額はウォレットに戻ります。期限が切れたオファーはもう受けられません。金額は、あなたか誰かが閉じるまでボールトに残り、その後あなたのウォレットにだけ戻ります。次のアプリのオファーページができるまでは、オファーの確認・キャンセル・クローズは現在のアプリのオファーページで行います。確認画面は、何かがロックされる前にそのことを伝えます。

<a id="lend-offer-terms"></a>

### Lend: オファーの条件

詳細モードでパートを設定しない限り、1人の借り手が全額を受けるか、誰も受けないかのどちらかで、借り手はあなたが決めた担保をちょうどロックしなければなりません。フォームには、ウォレットにある貸出トークンの残高が表示されます。数字は入力どおりに正確に読まれます。トークンの桁数を超える小数は四捨五入せずに拒否され、金利は年100%まで、小数第2位まで指定できます。選べる期間はネットワークが認める最長のものまでです。オファーは、受けられるかキャンセルされるまで、または選んだ日数（最長1年）の間開いています。通常の選択である全期間利息では、早期返済があっても受け取る利息は減りません。日割りはローンが続いた期間の分だけです。借り手による一部の早期返済を認めることもできます。フォームには、今借り手が受けた場合に期日に借り手があなたに支払う額が表示されます。詳細モードでは、オファーをパートに分けて貸すこと、約定方式を指定すること、利息をスケジュールで支払うこと、フル手数料タリフを付けることもできます。

<a id="rate-check"></a>

### 金利を最近のローンと比べる

投稿フォーム（貸し手のオファーと借り手のリクエスト）の両方で、金利欄の下に、同じペア・同じ期間で直近30日に始まったローンの中央の金利と、その件数が表示されます。あなたの金利がそこから5ポイントを超えて離れていると、アプリは警告し、どちらに働くかを示します。市場より大きく低い貸し手、または市場より大きく高い借り手は、金利が動いたときに真っ先に取られるオファーを出すことになります。逆の方向では、オファーが誰にも取られずに残るかもしれません。警告だけなので、そのまま投稿できます。比べる最近のローンがないとき、担保がNFTのとき、プロトコルのインデックスを読めないときは、黙らずにその旨を表示します。

<a id="public-queue"></a>

### 公開待ち行列のあるネットワーク

Ethereum、BNB Chain、Polygon（および BNB Testnet と Polygon Amoy）では、送信したトランザクションは取り込まれる前に公開の待ち行列で待ちます。その待ち行列を見ている人（ボットを含む）は誰でもそれを見て先に動けます。キャンセルが届く前にオファーを取る、返済が届く前にローンに手を出す、といったことです。そのためこれらのネットワークでは、オファーの投稿・受諾・キャンセル、返済、担保の追加のレビューで、ウォレットが開く前にその旨を表示します。トランザクションを非公開で送れるウォレットもあります。ウォレットのネットワーク設定やセキュリティ設定を確認してください。アプリがその経路を代わりに選ぶことはできず、通常の方法で送っても変わるのは、届く前に誰がトランザクションを見られるかだけです。Base、Arbitrum、Optimism には公開待ち行列がないため、何も表示されません。

<a id="lend-offer-parts"></a>

### Lend: パートに分けて貸すオファー（上級）

詳細モードでは、貸出オファーをパートに分けて貸せます。入力した金額は全額のままです。掲載すると全額がロックされ、オファーを直接受ける借り手は全額を借ります。そのうえで、1回のマッチで貸せる最小パートを指定します。ネットワークでマッチングがオンの間は、マッチャーがあなたのオファーを複数の借り手に貸すことができ、各ローンは最小パートから残額までの間で、あなたの金利になります。各マッチは、そのパートに見合う割合の担保を少なくとも求めます（端数切り捨て）。確認画面には最小パートが求める担保が示されます。マッチが一度パートを貸すと、残りを直接受けられる借り手はいなくなり、貸せるのは追加のマッチだけです。オファーをキャンセルすれば残りを取り戻せます。残額が最小パートを下回ると、プロトコルはそれをあなたのウォレットに返してオファーを閉じます。マッチングが今オンかどうかは確認画面に示され、オフの間は全額を受ける借り手だけがローンを始められます。約定方式はリクエストと同じで、既定は部分約定、全部か無しは全額で1件のローンのみ（パート不可）、即時またはキャンセルには期限が必要です。約定方式は掲載後に変更できません。全額に今日の価格で必要な量より少ない担保しか求めないオファーはプロトコルが拒否し、確認画面は求められる最小量を示します。詳細モードで設定したオプションは Basic に切り替えても有効のままで、フォームがそれを伝え、消去もできます。

<a id="lend-offer-schedule"></a>

### Lend: オファーの利息の支払いスケジュール（上級）

上級モードでは、貸出オファーにもリクエストと同じく利息の支払いスケジュールを付けられます。毎月、四半期ごと、6か月ごと、毎年のいずれかです。フォームはあなたの条件でプロトコルが認めるスケジュールだけを出し、閉じているものにはその理由を表示します。パートを設定すると、プロトコルは掲載時に最小パートを確認するため、最小パートがしきい値を下回ると細かいスケジュールは閉じます。各ローンは開くときにも改めて確認されます。確認画面には、借り手が全額を受けた場合の各期の利息と、パートがあれば最小パートのローンの各期の利息、支払われなかった期の猶予期間が表示されます。猶予期間の終わりまでに支払われない期があれば、誰でも借り手の担保の一部を売ってあなたに支払うことができ、ローンは続きます。スケジュールは掲載後に変更できません。

<a id="lend-offer-tariff"></a>

### Lend: オファーのフル手数料タリフ（上級）

上級モードでは、貸出オファーにフル手数料タリフを付けられます。オファーから各ローンが開くときにあなたの保管庫から VPFI で取られる手数料で、そのローンの金額と期間で決まります。その代わり、そのローンの利息に対するプロトコルの取り分の割引が10ポイント上乗せされます（上限は50%）。取り分そのものは引き続き貸付資産で取られます。上乗せはローンの期間中有効で、ローンが新しい期間に延長されると、その期間には付きません。上乗せは貸し手ポジションに属するため、利息が支払われる時点でそれを保有している人が受け取ります。タリフは返金されません。フォームには、全額（オファーが開く最大のローン）に対する今日のタリフが表示されます。1件のローンが取ってよい VPFI の上限と、タリフを取れないローンを拒否するかタリフなしで開くかを決めます。ローンがタリフを取れるのは、その時点でタリフがオンで、貸付資産に価格があり流動的で、タリフがあなたの上限内にあり、保管庫に十分な空き VPFI がある場合だけです。タリフは掲載後の2つ目のトランザクションで設定されるため、その確定前に借り手やマッチによってオファーから開いたローンはタリフなしで開きます。

<a id="lend-offer-review"></a>

### Lend: オファーの確認と掲載

ウォレットが開く前に、アプリはプロトコルにオファーを試行実行させるので、確認画面にはプロトコル自身の答えが示されます。今ロックする額、借り手が受ける金額、借り手がロックすべき担保、金利と期間、今日の手数料率で借り手が受け取る額、期日の利息、そのうちのプロトコルの取り分とあなたに戻る額、ローン期間中のすべての条件、オファーの期限、今日の価格でのローン・トゥ・バリュー、承認が必要かどうかが並びます。ウォレットの残高が金額に満たない場合は、不足額を示し、署名は提示しません。リスク開示と規約に同意するチェックを入れます。必要ならウォレットが金額ちょうどを承認し、アプリがもう一度試行してから掲載します。承認の後に止まった場合、アプリは承認を元に戻すよう求め、戻ったかどうかを伝えます。完了後、アプリは記録されたオファーとボールトにロックされた金額をチェーン上で確認します。

<a id="lend-offer-fee"></a>

### Lend: オファーにかかる手数料

オファーの掲載に手数料はかかりません。組成手数料は借り手のものです。金額のわずかな割合で、借り手があなたのオファーを受けたときにその時点の料率で貸出資産で一度だけ課され、借り手が受け取る額から差し引かれます。あなたは全額を貸し、借り手は利息とともに全額を返済します。利息が支払われるとき、プロトコルはローン開始時に有効な料率で自らの取り分を受け取ります。手数料割引の設定がオンの間は、あなたの手数料割引ティアがその取り分を下げることがあります。確認画面には今日の料率とその取り分の上限が示されます。料率を読めない場合は、数値を示さずにそう伝えます。

<a id="positions"></a>

### Positions: あなたのローンポジション

Positions は、このネットワークであなたが貸した、または借りたすべてのローンを、ウォレットが保有するポジショントークンから一覧にします。そのため、他の人に移転したポジションは一覧から外れます。最初に受け取り可能な支払いが並び、Claims を開きます。次に進行中のローンが、Home と同じく期限の迫ったものから並びます。最後に終了したローンが、終了の仕方とともに並びます: 返済済み、デフォルト、清算済み、またはマッチングで終了。支払いがまだ残っている終了ローンは Claims へ案内します。

すべて・貸した・借りたで、3 つの一覧を同時に絞り込めます。Positions が「何もない」と表示するのは、すべてを読み終えたときだけです。一覧を最後まで読めなかった場合はそう表示します。各ローンはそれぞれのページを開き、そこであなたが取れる操作が分かります。一覧そのものが署名することはありません。

<a id="position"></a>

### Position: 1 件のローン

各ローンには専用のページがあります。最初にローンの状態、次にあなたの役割が表示されます: ポジショントークンは売却や移転ができるため、ウォレットが今保有している側です。どちらの側も保有していなければ、閲覧しているだけです。あなたに関わる期限は、あなたの側に向けた文で示します。猶予期間が終わると、誰でもデフォルトを開始できるとページが示します。これはプロトコルが確認したときだけです。

その下に、ローンの日付（現在の期間の返済期日（停止分の加算前）、プロトコル停止中に加算された時間、返済期日、猶予期間の終了）、現在の条件（一部返済で残りの元本が減ります）、ヘルスファクター、担保の保管場所が並びます。読み取れなかった数値は不明と表示します。担保に価格がない場合、デフォルト時は貸し手が担保そのものを受け取ることになり、ページにもそう表示されます。ネットワークが清算しきい値のすぐ上に、別のローンとの内部マッチング用の範囲を確保している場合、ページはそれを示します。その範囲では外部への売却でローンを閉じることはできません。NFTレンタルには担保がありません。デフォルトすると借り手の利用が終わり、前払いの賃料はプロトコルの取り分を差し引いて貸し手へ、バッファはトレジャリーへ渡ります。最初の操作は全額返済、一部返済、担保の追加と引き出しで、その他の操作は今後の更新で追加されます。

<a id="repay"></a>

### 全額を返済する

進行中のローンでは、ページから全額返済ができます。貸し手以外なら誰でも返済できます。借り手ポジションを保有していない場合、支払っても担保を受け取る権利は得られません。担保を受け取れるのはそのポジションの保有者だけです。猶予期間が終わると返済は止まり（ローンはデフォルトに進みます）、swap-to-repay の注文が保留中の間も止まります。

返済額は毎秒増え、プロトコルは返済が確定した時点の金額を受け取ります。確認画面には 2 つの数値が表示されます。今の金額と、約 30 分後の金額です。ウォレットは 2 つ目の数値をちょうど承認します。すでにそれより多く（無制限も含む）承認している場合は、返済のあいだその数値まで下げます。返済そのものには上限がないためです。承認が制限するのは金額で、時間ではありません。後から確定した返済は、返済額がまだ承認額に収まる間だけ成立し、収まらなければ拒否されて何も動きません。全期間の利息がかかるローンでは返済期日まで金額が増えないため、後の返済も成立することがあります。返済で使われなかった承認分は、その後に元へ戻されます。その後、借り手は担保を、貸し手は元本と利息を Claims で受け取ります。

<a id="interest-schedule"></a>

### 利息スケジュール

利息スケジュールのあるローンは、満期時だけでなく各期間（1か月、四半期、6か月、1年）ごとに利息を支払います。ページには現在の期間が表示されます: 期間の終了日、猶予期間の終了日、その期間の利息、支払済みの額、残りの未払い額です。期間の利息は現在の元本と金利で計算されるため、一部返済で減ります。

期間とその猶予が終わると、誰でもその期間を精算できます。支払済みの期間はチェックポイントを進めるだけです。不足が残る期間では、未払い額と売却費用を賄うのに必要な分だけ借り手の担保が売却されます。ページには今精算できるかどうかが表示されます。ネットワークの定期精算スイッチがオフのときはその名前を示し（その場合は何も精算できず、担保も売却されません）、プロトコルの一時停止中はそれも示します（精算は止まり、停止時間は期間の日付に加算されます）。一時停止は期間の日付を停止時間だけ後ろにずらしますが、1期間に必要な利息は1期間分のままです。利息は停止中も発生し続け、返済で支払われた利息はすべてその期間に算入されます。

<a id="partial-repay"></a>

### ローンの一部を返済する

借り手ポジションの保有者は、ローンの条件が許す場合、実行中のローンのページから元本の一部を返済できます。返済する元本の額を入力します。プロトコルは貸付トークンごとの最小額以上、かつ元本全額未満を受け付けます(全額の返済は「全額返済」です)。前回利息が支払われてから発生した利息が上乗せされます。ローンは減った元本で続き、返済期日は動きません。

確認画面には、返済額、利息、残る元本、承認でカバーされる額が表示されます。期日前の日割りローンでは利息は正確です。全期間利息のローン、または期日後は「最大」と表示されます。アプリが読むプロトコルの数値には残りの期間分や延滞料も含まれますが、一部返済ではそれらは請求されないためです。ローンに対する借り換えリクエストや借り手ポジションのオフセットオファーが有効な間、および猶予期間の終了後は、一部返済は保留されます。

<a id="add-collateral"></a>

### 担保を追加する

借り手ポジションの保有者は、進行中のローンのページから担保を追加できます。担保を追加するとローンのヘルスファクターが上がり LTV が下がるため、清算から遠ざかります。追加できるのはローンがすでに持つのと同じトークンだけで、プロトコルは他のトークンを受け付けず、現在価格を付けている担保に限って追加を受け付けます。金額を入力すると、フォームにウォレットの保有額が表示されます。

確認画面には、追加前と追加後の担保、保管場所（あなたのボールト。ローン終了までローンに紐付けられます）、現在のヘルスファクターと LTV が表示されます。既存の承認額で足りない場合、ウォレットはちょうどその金額を承認し、アプリはまず追加をドライランで試します。完了後、アプリは追加後のヘルスファクターと LTV をプロトコル自身の数値で表示します。プロトコルが一時停止中でも担保の追加はできます。フォールバック中のローンは、追加によってプロトコルの開始時の上限を回復すれば進行中に戻ります。回復しない場合、担保は追加されますがローンはフォールバックのままです。追加した担保は、ローンが清算またはデフォルトになると他の担保と一緒に失われることがあります。借り手ポジションを引き継いでいてローンがフォールバック中の場合、追加分はローンに記録された借り手のボールトに入り、ローンを進行中に戻した場合にのみあなたのボールトへ移ります。

<a id="take-back-collateral"></a>

### 担保の引き出し

ローンの進行中、借り手ポジションの保有者は、ローンに必要な分を超える担保をローンのページから引き出せます。プロトコルは、ヘルスファクターがローンの最低値以上に、LTVが開始時の上限以内に収まるように引き出せる上限を計算します。この上限は価格や利息の発生に応じて変わり、入力中のフォームに表示されます。担保を引き出すと、ローンは清算に近づきます。

確認画面には、現在と引き出し後の担保、担保がボールトからウォレットへ送られること、現在の上限、ローンの現在のヘルスファクターとLTVが表示されます。承認は不要なので、アプリが引き出しをドライランで試した後、ウォレットの確認は1回です。プロトコルは引き出しの確定時に上限を再確認します。価格が動いて金額が収まらなくなっていれば拒否され、何も動きません。プロトコルの一時停止、保留中のスワップ返済注文、有効なリファイナンス依頼、貸し手の売却出品があると引き出せません。また、プロトコルが価格を付けているトークンの担保だけが引き出せます。アカウントで保護モードがオンの場合、担保はウォレットに届く前に、アカウントの遅延期間だけ支払いキューで待機します。レビューはそのことを示します。

<a id="collect-a-payout"></a>

### 支払いを受け取る

ローンが終わると、プロトコルは各側に支払うべきものを記録し、各ポジションの保有者がローンのページか Claims から受け取ります。支払いは現在ポジションを保有している人に対して行われるため、購入したポジションはあなたに支払われます。貸し手の受取額は元本と利息、またはデフォルトや清算で回収された額で、貸し手のために保留された資金と、レンタルの場合は貸し出していた NFT が加わります。借り手の受取額は返還される担保または残余で、借り手のために保留された余剰が加わります。受け取るとポジショントークンはバーンされ、双方が受け取るとローンは精算済みになります。

確認画面には、請求が行う支払いのすべて、貸し手ポジションの過去の売り手が先に受け取る分(稼いだが未払いの利息)、そして支払いの届く先が表示されます。届く先はウォレット、または保護モードがオンの場合はアカウントの支払いキューかボールトです。承認は不要なので、アプリが請求をドライランで試した後、ウォレットは一度だけ確認を求めます。プロトコルの一時停止中はすべての請求が止まります。ローンがフォールバック中の間、借り手の受け取りは貸し手が受け取るまで待ち、貸し手の受け取りでフォールバックは終わります。借り手はもう回復できません。完了カードには取引が実際に支払った内容が表示されます。

<a id="claim-everything"></a>

### すべてを受け取る

Claims の先頭には「すべてを受け取る」があり、今受け取れる支払いをすべて一つの取引にまとめます。表示されるのは、あなたがポジションを保有する終了済みローンの支払い、インタラクション報酬、常設オファーのまだ貸し出されていない資金、ボールト内の自由な VPFI、そして受取人であれば引き出し可能な給与です。各支払いにはスイッチがあり、どれでも除外できます。ボールトの自由な VPFI は手数料割引ティアを決めるため、オンにしない限りオフです。まだ貸し出し中の常設オファーの資金も同様です。売却したポジションから受け取る利息と、フォールバック中のローンは、それぞれ個別に受け取ります。取引内で各支払いは個別に実行され、プロトコルが拒否したものはスキップされて一覧に残り、残りはそのまま支払われます。一つの取引で受け取れるのは最大 30 件で、残りは二つ目の取引を待ちます。ウォレットから出ていくものはないため、ウォレットの確認は試行のあとに一度だけで、完了カードには各支払いが受け取られたかスキップされたか、そしてお金がどこに届いたかが表示されます。一時停止中はすべての受け取りが止まります。

<a id="payout-queue"></a>

### キューで待っている支払い

保護モードがオンの場合、ボールトからウォレットへ出ていくものはすべて、支払いキューでアカウントの遅延期間を待ちます。「請求」にはそこで待っているものが、早く期限が来る順に、それぞれ短いリクエストコード付きで表示されます。支払いに関するすべての通知は同じコードを表示するので、メッセージとリクエストを照合できます。各行には、何を支払うか、どこへ行くか、いつ解放できるかが表示されます。支払いの期限が来れば誰でも解放でき、記録された送り先にしか支払われません。その送り先がもう許可されていない場合、解放すると代わりに取り消されます。あなた、またはセカンダリ署名者の一人は、一時停止中でもいつでも支払いを取り消すことができ、資産はボールトに残ります。アカウントが承認を必要とする場合は、各支払いを先にセカンダリ署名者が承認します。署名者はアドバンストモードでアカウントのアドレスを貼り付けて見つけます。一時停止中は、それが終わるか、長い一時停止の後に緊急退出路が開くまで、解放は保留されます。各操作でウォレットの確認は一度だけで、完了カードにはトランザクションが行ったことが表示されます。

<a id="seller-interest"></a>

### 売却したポジションの利息

貸し手ポジションを売却しても、保有中に得てまだ支払われていない利息は、ローンに対する請求としてあなたのものに残ります。Claims には、そのような請求を持つすべてのローンが、プロトコルの利息取り分を差し引いた受取額と、すでにボールトで待っている額とともに表示されます。ローンが続いている間、各利息の支払いはまず未決の請求を古い順に、各売り手自身のボールトへ支払います。あなたのボールトに何か届くまでは、引き出せるものはありません。ローンが終了すると、引き出しはまず貸し手側の回収額を分配します。最初に保有者の元本、次に各売り手の請求を古い順に。そのときすべての未決の請求が閉じ、支払われなかった分は未払いのまま残ります。ローンはアプリのインデックスから見つかります。一覧できない場合は、ローン番号で検索してください。番号での検索はチェーンだけを読みます。承認は不要なので、ウォレットの確認はドライランの後に一度だけで、完了カードに取引が支払った内容が表示されます。

<a id="frozen-proceeds"></a>

### 支払いが凍結されたとき

制裁スクリーニングがあなたのウォレットにフラグを立てても、プロトコルはあなたへの支払いを何も取り上げず、ローンの完了を止めることもありません。相手方は自分の側が回収した分を通常どおり受け取ります。あなたの取り分はボールトにロックされた状態で保管され、ウォレットがリストから外れると解放されます。そのとき Claims とローンのページには「凍結中、リスト解除待ち」と表示され、受け取りボタンは出ません。スクリーニングを読み取れず、あなたのウォレットが以前にフラグ付きと確認されている場合、凍結された支払いはスクリーニングが再び応答するまでロックされたままです。その間にあなたのウォレットに支払われるべき額も、プロトコルが引き続きフラグ付きとして扱うため、同じように保留されます。フラグ付きと確認されたことのないウォレットが障害だけで凍結されることはありません。進行中のローンでは、ローンが既に支払い、貸し手が受け取るまで貸し手ポジションのために確保されている額もローンのページに表示されます。返済済みのローンは、借り手がまだ受け取っていない余剰を待っているときにそう表示します。

<a id="extension-reserves"></a>

### 延長用リザーブ

ローンの借り手ポジションを保有していれば、そのローンのトークンを延長のために自分のボールトに取り分けておけます。延長は、キーパーによるものでもあなた自身によるものでも、まずこのリザーブから引き落とされます。リザーブはあなたのものです。Claims には残りがあるすべてのローンが表示され、延長がまだそこから引き落とせるかどうかも示されます。引き落とせるのは、ローンが進行中で、あなたがその借り手ポジションを保有している間だけです。プロトコルが一時停止していない限り、ローンの状態にかかわらず、いつでもリザーブ全額を取り戻せます。ローンがまだ進行中なら、次の延長はその後、そのトークンのあなたの他の残高から引き落とされます。ローンはアプリのインデックスから見つかります。一覧にできない場合は、番号でローンを検索してください。承認は不要なので、ウォレットの確認は試行のあとに一度だけで、完了カードにはお金がどこに届いたかが表示されます。

<a id="vault-holdings"></a>

### あなたのボールト

ボールトのページは、接続中のネットワーク上にあるあなた自身のボールトを表示します。完全なアドレスと、エクスプローラーへのリンクです。ボールトはプロトコルがあなたのウォレットのためだけに保持するコントラクトで、中身が他の人の資産とまとめられることはなく、資産はプロトコルのルールによってのみ出ていきます。まだボールトがない場合はそう表示され、作成を提案します。最初の入金やオファーでも自動的に作成されます。作成では何も動かず承認も求められないため、ウォレットの確認は一度だけです。各資産にはプロトコルの三つの数値が表示されます。「ボールト内」（プロトコルがそこであなたのものと数える量）、「今すぐ引き出し可能」、「ポジションが保持中」（ローン、オファー、請求、リザーブ、待機中の支払いが押さえている量）です。通常の送金でボールトに届いたトークンは数えられず、引き取るまで引き出せません。その行にそう表示され、引き取りまたは放棄の手続きへのリンクがあります。このページは、あなたが入金した資産と、ローン、あなたが作成したオファー、常設オファーが指す資産を一覧にします。そのため通常の送金で届いたトークンは、そのいずれかが指す場合にだけ表示されます。少額の行と空の行は、件数を示すスイッチの後ろに隠れます。ボールト内のVPFIは手数料割引ティアを決めます。そのために保有しても担保にはならず、ローンやオファーに担保として差し入れたVPFIは保持中として表示されます。自由に引き出せる分がある資産には「引き出す」ボタンがあります。

<a id="vault-deposit"></a>

### ボールトに入金する

ボールトページの入金は、トークンやNFTをウォレットからあなた自身のボールトへ、どのローンとも関係なく移します。入金するものを選びます。候補のトークンやテスト用コレクション、または貼り付けたアドレスです。トークンか、NFTか、マルチトークンのコレクションかはそのコントラクトから読み取ります。次に数量、NFTのトークンID、またはトークンIDと個数を入力します。まだ同意していない利用規約が有効な場合、アプリは先にその同意を求めます。同意していないウォレットに切り替えた場合も、署名の前に改めて求めます。レビューには、ウォレットから何が出て、どのボールトに入るかが示されます。まだボールトがなければ、入金がそれを作成します。トークンは数量ちょうどの承認を、NFTはそのトークン1つだけの承認を求めます。マルチトークンのコレクションは、入金の直後にもう1回のウォレット操作で取り消す承認を求めます。プロトコルはウォレットが送信する前に入金を確認し、全額が届かないトークン（送金時に手数料を差し引くものなど）を拒否します。入金が成立しなかった場合、アプリは承認を元に戻すよう求めます。届いた分はあなたのものとして計上されます。保護モードがオフならすぐに引き出せます。オンなら引き出しはアカウントの待機時間を待ち、アカウントがロック中は何も出せません。どちらに当たるかはレビューに示されます。プロトコルが一時停止中は入金できません。

<a id="vault-withdraw"></a>

### ボールトからの引き出し

ボールトページの資産の「引き出す」は、自由に引き出せる分をウォレットに戻します。自由とは、ローン、オファー、請求、常設オファー、キュー中の支払いのいずれにも押さえられていないことで、プロトコル自身の数値が決め、フォームはそれを表示し、超える額を拒否します。入金記録がコレクションしか示さないNFTは、そのコレクションの下でトークンIDを入力して引き出します。アプリは署名するウォレットにだけ引き出します。レビューには、どのボールトから何が出て、どこへ行くかが示されます。保護モードがオフならすぐにウォレットに届きます。オンなら、プロトコルはアカウントの待機時間のあいだキューに入れ、アカウントが求める場合はセカンダリ署名者の承認も必要です。キュー中の引き出しは請求ページの支払いキューから取り消せ、その場合はボールトに残ります。アカウントがロック中は何も引き出せません。ウォレットから何も出ず、承認も求められません。プロトコルが一時停止中は、エスケープルートが開くまで引き出しは閉じています。「プロトコルが一時停止しているとき」を参照してください。

<a id="vault-safety"></a>

### アカウントの安全

ボールトページの「アカウントの安全」カードは、アカウントが保護モードかどうか、その遅延、各リリースに副署名者の承認が必要か、ポジションNFTが保護されているか、キューで待つ支払いの数、そしてまだ保留中のすべての変更を示します。保護モードをオンにすると、ボールトからウォレットへのすべての支払いが遅延を待つため、ウォレットを奪った泥棒があなたが気づく前にボールトを空にすることはできません。他人のボールトからあなたへの支払いは代わりにあなたのボールトに入り、あなたが他人に払うものは遅れません。ベーシックモードでは遅延はプロトコルが許す最短の2日で、ポジションNFTの保護はオフのままです。アドバンスドモードでは最長5日まで選べ、ポジションNFTも保護できます。「今すぐロック」はキュー中のすべての支払いを取り消し（資産はボールトに残ります）、新しいポジションを止め、保留中のすべての変更を破棄します。返済と担保の追加は引き続きでき、ロックは一時停止中でも機能します。ロック解除は、アカウントの遅延の後にのみ有効になる申請です。期限が来たら「期限の来た変更を適用」が、ほかの期限の来た変更とともにそれを適用します。支払いキューはカードの下に表示されます。このネットワークのプロトコルに保護モードがなければ、カードは利用できないと伝えます。読み取れない場合、カードは操作を出さず、オフだと思い込まないよう伝えます。各操作でウォレットの確認は1回で、完了カードはプロトコルが記録した内容を示します。

<a id="vault-escape"></a>

### プロトコルが一時停止しているとき

プロトコルが一時停止している間、ボールトページは上部でそのことを伝えます。引き出しは閉じていますが、全額・一部の返済と担保の追加は引き続きできます。管理者による一時停止であれば、そのエスケープルートがいつ開くかも、プロトコルの報告どおりにカウントダウン付きで示します。ルートが開くと、自由な分がある資産の「引き出す」は、あなたのものをそのままウォレットへ戻します。レビューにはエスケープルートを通ることが示され、このルートはローン、オファー、請求が押さえているものを決して戻しません。保護モードがオンなら、引き出しはいつもどおり支払いキューでアカウントの遅延を待ちます。自動の一時停止や、まだ開始されていないプロトコルはエスケープルートを開かず、ページは予定されたルートがないことを伝えます。

<a id="my-offers"></a>

### あなたのオファー

オファーページには、接続中のネットワークであなたが作成したすべてのオファーと、いまあなたがポジショントークンを持っているすべてのオファーが、新しい順に並びます。それぞれにプロトコルが報告する状態（オープン、成立、売却済み、期限切れ、取消済み）が表示され、一覧の上のフィルターが状態ごとの件数を数えます。借入リクエストは、誰かが受け入れる前に担保がマーケットプレイスの出品で売れた場合に売却済みと表示されます。ローンは開かれず、売却代金は作成者のボールトに入ります。オープンのオファーは、貸す資産や担保を成立か取消までボールトに留め、期限切れのオファーは片付けられるまでそこに留めます。何も成立していないオファーをプロトコルが取り消すと条件が消去されるため、ページには番号と状態だけが表示されます。あなたが作ったオファーのポジショントークンを別のウォレットが持っていても、あなたは取り消せ、返却分はあなたに戻ります。別のウォレットが作ったものをあなたが持っている場合、期限前に取り消せるのはそのウォレットだけです。あなたのオファーの下にはオファーブックがあり、次で説明します。

<a id="offer-book"></a>

### オファーブック

あなたのオファーの下のオファーブックには、ネットワーク上のすべての公開中のオファーが新しい順に並び。ウォレットを接続した後にのみ読み込みます。タブでトークンのローンとNFTのレンタルを分け、フィルターで貸し手のオファー、借り手のリクエスト、またはその両方を表示し、接続後は自分のオファーを隠せます。古いオファーは「古いオファーを表示」で読み込みます。フィルターは読み込んだ分に適用され、件数の行がその数を示します。ブックはプロトコルのインデックスから来ており、チェーンより数分遅れることがあるため、オファーを指し示すだけです。チェーンが保持する状態を見るにはオファーを開いてください。期限を過ぎたオファーには期限切れのタグが付き、誰でも片付けられ、ロックしていた資産は作成者に戻ります。インデックスを読めない場合、ブックはオファーがないと表示する代わりにそう伝えます。

<a id="offer-detail"></a>

### オファーのページ

各オファーには専用のページがあり、ウォレットを接続した後にチェーンから読み込みます。投稿者、金額、成立済みの分、担保、期間、オファーの期限が表示されます。そこから公開中のローンオファーを丸ごと受けられます。手順は「借りる」「貸す」と同じ確認と同意です。貸し手のオファーから借りるか、借り手のリクエストに資金を出します。取り消しと片付けは、あなたのオファーと同じようにそこで使えます。レンタル、NFT担保のオファー、進行中のローンの売却、早期終了のオファーは当面は現在のアプリで受け、ページからリンクしています。確認している間、オファーは予約されません。ほかの誰かが先に受けたり取り消したりすることがあります。

<a id="offer-cancel"></a>

### オファーを取り消す

あなたが作ったオープンのオファーで「取り消す」を押すと、ブックから外し、ボールトにまだ留めているものを返します。貸付オファーなら未貸出の額またはNFT、リクエストなら未使用の担保、レンタルリクエストなら前払いの料金とバッファです。何も成立していないオファーは最初の5分間は取り消せません。取消が誰かの受諾と競合しないためです。確認画面にいつ取り消せるかが表示され、時間が来れば自動で解除されます。成立済みの部分は成立したままです。期限切れのオファーには「片付ける」ボタンがあり、同じように留めていたものを返します。期限切れのオファーは誰でも片付けられ、返却分は常に作成者に戻ります。確認画面は何がどこへ戻るかを示します。保護モードなしならすぐにウォレットへ、保護モードありならアカウントの遅延のあいだ支払いキューで待つか、ロック中はボールトに留まります。進行中のローンに結びついたオファーなど、アプリが返却額を算出できない場合はそう示し、完了カードが実際に動いたものを示します。プロトコルが一時停止中は取り消せません。ウォレットから出ていくものはなく承認も求めないので、ウォレットの確認は1回です。

<a id="risk-access"></a>

### Risk Access: あなたのリスクレベル

すべてのアカウントは最も低いリスクレベル（ブルーチップ資産のみ）から始まり、引き上げられるのはあなた自身だけです。ペアには、よりリスクの高いトークンのレベルが必要です。ブルーチップのトークンは何も不要、その他の流動性のあるトークンは「流動性のある資産」、流動性のないトークンは「流動性のないものを含むすべての資産」に加えて、そのペアそのものへのあなたの同意が必要です。オファーの受諾やリクエストの掲載にこうした手順が必要なとき、確認画面はその場でそれを伝え、専用の明細付きの一回のウォレット確認として提示します。何が変わるか、どのペアに及ぶか、いつ有効になるか、資金は動かないこと。レベルの引き上げやペアへの同意には、プロトコルが定める待機期間がある場合があります。引き上げたレベルについてはアプリがチェーンから読んだ有効になる時刻を示し、同意についてはプロトコルがその時刻をまだ公開していないと伝えます。どちらの場合も同じ手順を二度提示することはありません。二度目は待機をやり直させるからです。レベルの引き下げは常に即時に有効です。プロトコルが新しいリスク条件を公表すると、あなたのレベルと同意は再確認するまで数えられません。厳格モードをオンにしている場合、流動性のある各ペアにもあなたの確認が必要です。貸し手自身のリスクレベルによるブロックは貸し手側のものとして表示されます。あなたのアカウントで変えられることはありません。

<a id="terms-gate"></a>

### 利用規約の確認

利用規約のバージョンが有効になっている場合、手数料割引をオンにするなど新しいことを始める操作の前に、アプリはその規約への同意を求め、どの操作が求めたのかを示します。バージョン、本文のフィンガープリント、そしてそのバージョンそのもの（本文は決して変わりません）へのリンクが表示されます。同意はウォレットでの確認一回で、資金は動きません。同意済みかどうかを読み取れない場合、アプリはそう伝えて再試行できるようにし、未同意として扱うことはありません。返済、請求、自分の資産の引き出し、自分のオファーの取り消し、同意のオフは決して妨げられません。

<a id="settings"></a>

### 設定

設定はメニューのいちばん下にあります。モード、テーマ、言語はウォレットなしで使え、このブラウザに保存されます。テーマは選ぶまで端末の設定に従い、まだ翻訳されていない言語は翻訳されるまで英語で表示されます。ウォレットを接続すると、このネットワークで同意した利用規約のバージョン、または適用中でまだ同意していないバージョンがあることが表示されます。同意を求められるのは、それが必要な最初の操作のときで、設定画面では求められません。手数料割引の設定はホームと同じものです。設定画面では、このブラウザがアプリのために保存している内容、秘密の情報は保存しないこと、アプリがエラーレポートや診断情報を送信しないことも説明しています。設定では、このブラウザにあるアプリの記録をファイルとしてダウンロードしたり、このサイトがここに保存しているものをすべて消去したりすることもできます。消去する前に削除される項目の数が表示され、消去するとウォレットの接続が切れ、モード、テーマ、言語が初期設定に戻り、削除された内容が表示されます。オンチェーンのポジション、アラートサービス側のアラート設定、紹介サイト、ウォレットアプリには影響しません。

設定では、このネットワークでのあなたのリスクレベル、このネットワークがそれを適用しているかどうか、厳格モードがオンかどうかも言葉で表示します。新しいリスク条件によってレベルが数えられなくなった場合は、そこでウォレットの一手順で再確認できます。レベルの引き上げ・引き下げや厳格モードのオン・オフは **Advanced** モードで行います。どの変更も専用の明細付きの一回のウォレット確認で、資金は動きません。引き下げは即時に有効になり、新しいレベルより上のペアを新しいオファーとリクエストに対して閉じます（あなた自身の未成立のものも含みます）。すでにあるローンには影響しません。引き上げにはプロトコルの待機期間がかかる場合があり、アプリはいつから数えられるかを示します。

設定では、このネットワークであなたのウォレットがプロトコルに与えている継続的な承認も一覧にします。トークンをあなたに再確認せずにどれだけ動かせるか、または NFT コレクション全体や一つの NFT への承認です。どれも一回のウォレット確認で取り消せ、資金は動きません。一覧は提案された資産と、ここでのあなたの預け入れ・ローン・オファーが示すすべての資産を確認し、別のトークンを追加して確認することもできます。それ以外のトークンへの承認はそこには見つからないため、残りはウォレットで確認できます。同じ資産を別の承認も対象にしている場合（1 つの NFT に対するコレクション全体の承認など）、確認画面はそれが取り消し後も残ることを示します。

設定では、このネットワークでキーパーがあなたのウォレットのために動けるかどうかと、承認したキーパーも表示されます。最初はすべてオフです。キーパーが動けるのは、キーパーアクセスがオンで、そのアクションを持っている間だけです。ローンに対する手順には、さらにそのローンまたはオファーがキーパーを指定している必要があります。キーパーがあなたの資金を受け取ることはなく、請求・引き出し・送金は一切できません。キーパーアクセスのオフとキーパーの削除は、どちらのモードでもウォレットでの確認 1 回で行えます。アクセスのオン、キーパーの承認、できることの変更は **Advanced** モードで行います。

アプリはスマートフォンやパソコンにインストールすることもできます。ホーム画面やアプリ一覧から開け、オファー、ポジション、ボールト、アラートへのショートカットが付きます。ブラウザの「アプリをインストール」または「ホーム画面に追加」を使うか（iPhone や iPad では Safari の共有から「ホーム画面に追加」）、**Advanced** モードでブラウザが対応している場合は設定の「アプリをインストール」を使います。アプリは速く開くために自身のコードファイルのコピーを保持しますが、ポジションやすべての数値は常にネットワークから読み取ります。

<a id="rent-review"></a>

### レンタル：NFTを借りる

メニューの「レンタル」には、所有者があなたのネットワークで貸し出しているNFTが並びます。テストネットワークで何も出ていなければ、テスト用のNFTとトークンを得られるフォーセットを案内します。レンタルで得るのは決まった日数だけNFTを使う権利で、NFTそのものではありません。NFTは所有者のボールトに残り、レンタルが終わるまであなたを利用者として記録します。出品を開いて「このNFTを借りる」を選びます。確認画面には、ウォレットからあなた自身のボールトへ移るものが表示されます。全期間の日額料金と、出品時に決まったレンタル料の小さな割合であるバッファです。料金ルール（日割り：使った日数分で、途中の日は1日と数えます。または全期間）、期限内に終えたときに戻るもの、猶予期間、バッファから引かれる延滞料も表示されます。レンタルには担保もヘルスファクターもありません。ウォレットの残高がレンタル料とバッファの合計に足りなければ、ウォレットの操作の前にそう表示されます。続いてウォレットが、無料の条件への署名、必要ならその額ちょうどの承認、そしてレンタルの開始を求めます。開始はアプリがまず試行で確かめます。その後アプリはチェーン上で、始まったレンタル、ボールトへの支払い、あなたがNFTの利用者になったことを確認します。

<a id="rent-risks"></a>

### レンタル：リスク

借りたNFTがあなたのものになることはなく、使う権利はレンタルの終了とともに終わります。レンタル料とバッファはレンタルのためにボールトに留まり、開いている間は引き出せません。合意したすべての日が精算されると（精算は誰でもできます）、レンタルは自動で終わり、バッファを請求できます。それまではそのポジションページから自分で終えてください。猶予期間中に終えるとバッファから延滞料が引かれます。猶予期間を過ぎるとレンタルはデフォルトとなり、ボールトに残るレンタル料は所有者へ、バッファはプロトコルへ渡り、あなたには何も戻りません。全期間の料金ルールでは、早く終えても全期間分を支払います。

<a id="rent-list"></a>

### レンタル：自分のNFTを貸し出す

「レンタル」で「NFTを貸し出す」を押すと短いフォームが開きます。コレクション（テストネットワークではテスト用コレクション、または貼り付けたアドレス）、トークン番号、マルチトークンのコレクションなら数量、借り手が支払うトークン、日額料金（1つの数値）、期間（日数）、料金ルール（日割りか全期間）、出品を開いておく期間です。担保や金利の欄はありません。レンタルにはどちらもないからです。確認画面には、NFTがウォレットからあなた自身のボールトへ移ること、借り手が前払いする額、この出品が今日の設定で固定するバッファの割合、受け取るもの（支払期日のレンタル料からプロトコルの取り分を引いたもの。取り分は借り手が出品を受けたときに固定されます）、猶予期間、デフォルト時の扱いが表示されます。ウォレットにそのNFTがなければ、ウォレットの操作の前にそう表示されます。続いてウォレットが、そのトークン1つだけをプロトコルが動かせるようにする承認（マルチトークンのコレクションではこの出品のためだけにコレクション全体を承認し、後でもう1回の操作で取り消します）と、出品の投稿を求めます。投稿はアプリがまず試行で確かめます。その後アプリはチェーン上で出品が記録され、NFTがボールトに届いたことを確認し、出品のページへのリンクを示します。

<a id="rent-list-risks"></a>

### レンタル：貸し出しのリスク

出品が開いている間と貸し出し中は、NFTはあなたのボールトに留まり、出品かレンタルが終わるまで引き出せません。まだ誰も借りていなければ、最初の5分を過ぎた後に出品のページから取り消せます。貸し出した後は、レンタルが終わるまで借り手がNFTを使う権利を持ち、早めに取り戻すことはできません。終わった日が精算されるたびに、プロトコルの取り分を引いたレンタル料があなたのボールトに入ります。精算は誰でもできます。合意したすべての日が精算されると、レンタルは自動で終わり、借り手はバッファを請求できます。それまでは借り手が終えるか、猶予期間の後なら誰でもデフォルトとして終えられます。借り手が終えた場合、まだ精算されていないレンタル料と延滞料を、プロトコルの取り分を引いて請求でき、残りのバッファは借り手に戻ります。デフォルトの場合は、残りのレンタル料をその取り分を引いて請求でき、バッファはプロトコルへ渡ります。一時停止中は日々の精算が止まり、延滞料とデフォルトの期日は後ろにずれますが、借り手の利用期間は延びません。期限切れの出品は、閉じられるまでNFTをボールトに残します。

<a id="rent-request"></a>

### レンタル：NFTの借り入れを申し込む

レンタルの「レンタル希望を出す」は、出品と同じ短いフォームを借り手向けの言葉で開きます。コレクションとトークン番号（マルチトークンのコレクションでは数量も）、支払いに使うトークン、日額料金（1つの数値）、日数での期間、レンタル料のルール、希望を開いておく期間です。確認画面では、期間全体のレンタル料とバッファが今あなたのウォレットからあなた自身のボールトへ移ること、この希望が今日の設定で固定するバッファの割合、期間はオーナーが希望を受けた時から始まること、そして受けたオーナーがあなたの追加の操作なしにすぐレンタルを開始することを示します。ウォレットの残高が足りないか、そのNFTをすでに持っている場合は、ウォレットの操作の前にそう伝えます。まだ存在しないトークンはその旨を示します。その後ウォレットがレンタル料とバッファをちょうどその額だけ承認して希望を出し、アプリはそれを先にドライランで試します。最後にアプリはチェーン上で希望が記録され、レンタル料とバッファがボールトに届いたことを確かめ、希望のページへのリンクを示します。

<a id="rent-request-risks"></a>

### レンタル：レンタル希望のリスク

希望が開いている間、レンタル料とバッファはあなたのボールトに留まり、取り消すか希望が終わるまで引き出せません。まだどのオーナーも受けていなければ、最初の5分を過ぎた後に希望のページから取り消せ、両方ともウォレットに戻ります。受けたオーナーは、まさにこの条件ですぐレンタルを開始します。あなたが持つのはNFTを使う権利で、NFTそのものではありません。合意したすべての日が精算されると（精算は誰でもできます）、レンタルは自動で終わり、バッファを請求できます。それまではポジションのページから終えてください。遅れて終えるとバッファから延滞料が引かれ、デフォルトになるとレンタル料はオーナーへ、バッファはプロトコルへ渡ります。期限切れの希望は、閉じられるまでレンタル料とバッファをボールトに残します。バッファの割合は、希望がチェーンに記録される時点のプロトコル設定です。確認後に変わった場合、ウォレットがちょうどこの金額を承認していれば高い割合は拒否され、以前の承認でまかなえれば引き落とされます。結果には実際に動いた額が示されます。

<a id="rent-take"></a>

### レンタル：借り手の希望を受ける

借り手のレンタル希望は、決まった条件でNFTを1つ借りたいという申し込みで、借り手はレンタル料とバッファをすでに自分のボールトに入れています。そのページはその旨を示し、「あなたのNFTを貸し出す」を表示します。確認画面には、NFTがあなたのウォレットからあなた自身のボールトへ移ること、借り手が誰か、そして借り手が今から期間中そのNFTを使う権利を得ること（NFTそのものではありません）が表示されます。希望が定める日額料金、期間、料金ルール、借り手のボールトにすでにあるレンタル料とバッファ、あなたが受け取るもの（レンタル料からプロトコルの取り分を引いた額。取り分はレンタル開始時に決まり、終わった日が精算されるたびにあなたのボールトに入り、残りは終了時に入ります）、猶予期間、デフォルト時に起きることも表示されます。ウォレットにそのNFTがない、または数量が足りない場合は、ウォレットの操作の前にそう伝え、持てば自動で読み直します。続いてウォレットが、無料の条件への署名、その1つのトークンをプロトコルが動かす許可（マルチトークンのコレクションでは、このレンタルに限りコレクション全体で、後でもう1つの手順で取り消します）、そしてレンタルの開始を求めます。開始はアプリがまずドライランで試します。その後アプリはチェーン上で、始まったレンタル、NFTがあなたのボールトに届いたこと、ボールトが借り手を利用者として記録していることを確認し、レンタルへのリンクを示します。

<a id="rent-take-risks"></a>

### レンタル：希望を受けるリスク

NFTはレンタルの間ずっとあなたのボールトに留まり、レンタルが開いている間は引き出せません。借り手はレンタルが終わるまでそれを使う権利を持ち、あなたがその権利を早く取り戻すことはできません。条件は希望のものです。日額料金、期間、料金ルール、バッファは変えられません。終わった日が精算されるたびに、プロトコルの取り分を引いたレンタル料があなたのボールトに入ります。精算は誰でもできます。合意したすべての日が精算されると、レンタルは自動で終わり、借り手はバッファを請求できます。それまでは借り手が終えるか、猶予期間の後なら誰でもデフォルトとして終えられます。借り手が終えた場合、まだ精算されていないレンタル料と延滞料を、プロトコルの取り分を引いて請求でき、残りのバッファは借り手に戻ります。デフォルトの場合は、残りのレンタル料をその取り分を引いて請求でき、バッファはプロトコルへ渡ります。一時停止中は日々の精算が止まり、延滞料とデフォルトの期日は後ろにずれますが、借り手の利用期間は延びません。自分のバッファを記録していない希望は、レンタル開始時に今日の設定を使います。

<a id="rent-close"></a>

### レンタル：レンタルを終える

進行中のレンタルのページでは、借り手のあなたに「レンタルを終える」が表示されます。終了すると、未払いのレンタル料と延滞料は、あなたが自分のボールトに前払いしたレンタル料とバッファから支払われます。ウォレットからは何も引かれず、承認も要りません。確認画面には、今終える場合と少し先のある時点で終える場合のレンタル料が、料金ルールで数えて表示されます（日割り：開始から使った日数、途中の日は1日と数え、精算済みの日を除く。全期間：まだ精算されていない合意済みのすべての日）。あわせて精算済みの日数、延滞料、請求としてあなたに戻る額、そして所有者が受け取る額（レンタル料と延滞料からプロトコルの取り分を引いた額）も表示されます。前払い分で終了をまかなえない場合は、ウォレットが開く前に確認画面がそう伝えます。そのあとウォレットが一度だけレンタルの終了を求め、アプリはまずドライランで試します。終了後、アプリはレンタルが終わったこと、あなたに記録された請求、あなたの利用が終わったことをチェーン上で確認します。戻る分は Claims ページで受け取ってください。

<a id="rent-close-risks"></a>

### レンタル：終えるときのリスク

終了すると、合意した日が残っていても、NFTを使う権利はすぐに終わり、取り消せません。レンタル料は終了がチェーンに記録された時点で数えるため、それより前に始まった日は1日分として支払います。全期間の料金ルールでは、どれだけ早く終えても、まだ精算されていない合意済みのすべての日を支払います。期間が終わったあとはバッファから延滞料が引かれます。レンタル料全体の1%に、遅れた日ごとに0.5%を加え、上限は5%で、バッファを超えることはありません。猶予期間を過ぎるとプロトコルは終了を拒み、そのあとレンタルは、残りの日が1日ずつ精算されて終わるか（誰でも行えます）、デフォルトで終わるか、先に起きたほうで終わります。確認画面が示す後の時点は期限でも上限でもありません。後で記録された終了はその時点で数えるため、より多くのレンタル料や高い延滞料が引かれ、戻る分が減ることがあります。戻る分は受け取るまで、請求としてあなた自身のボールトに残ります。

<a id="rewards-vpfi"></a>

### リワード：ボールトの VPFI

メニューのリワードには、このネットワークでのリワード、VPFI、手数料割引への同意が表示されます。リワードは Home に表示される利用リベートで、同じ方法でクレームします。その下に VPFI が表示されます：ウォレット内の分、自分のボールトで計上済みの分、今すぐ引き出せる分、ローン・オファー・請求・支払いのために保留中の分です。計上済みの VPFI が手数料割引ティアを決め、そのティアは同意がオンの間だけ手数料を下げます。入金せずにボールトへ直接送られた VPFI は計上されず、ティアを上げることはありません。ページにはそれが表示され、取り込むための Vault ページが案内されます。「VPFI を入金」は、ウォレットだけが管理する自分のボールトへウォレットから VPFI を移します。まだなら先に規約への同意を求め、最初の入金でボールトが作られます。「VPFI を引き出す」は、自由な VPFI をウォレットへ戻します。各確認画面には、その操作がティアに何をするか、同意がオンかどうかが示され、その後アプリがチェーン上で結果を確かめます。VPFI が設定されていないネットワークでは、ページがその旨を示し、どちらも提示しません。ティアを決めるのは VPFI のホームネットワークにあるボールトの VPFI だけです。他のネットワークはそこで算出されたティアのコピーを適用するため、そこではページと各確認画面が、VPFI を動かしてもティアは変わらないと示します。

<a id="rewards-vpfi-risks"></a>

### リワード：VPFI を動かすリスク

ティアは今日の残高ではありません。現在の保有が最低日数続くまではゼロです。その後は、最近の日を重く見る日々の保有の平均に従います。それとは別に、現在の保有期間中のいずれかの日に持っていた最も低いティアを超えることはなく、さかのぼるのは最大 30 日です。そのため入金がティアを上げるのは時間がたってからで、短期間の上乗せでは上がりません。計上済み VPFI の一部を引き出すとティアが下がることがあり、すべて引き出すと保有期間は次の入金から数え直しになります。ローン・オファー・請求・支払いのために保留中の VPFI は、解放されるまで引き出せません。保護されたアカウントの引き出しは、先にその待機時間を待ちます。保護されたアカウントの引き出しが計上済み VPFI とティアを変えるのは解放されたときだけで、取り消された引き出しはどちらも変えません。ボールトの VPFI は担保ではなく、どのローンも裏付けません。プロトコルは VPFI を販売せず、価格を示さず、保有に対して何も支払いません。

<a id="rewards-tier"></a>

### リワード：手数料割引ティア

VPFI の下に、プロトコルがいま手数料に適用している手数料割引ティアと、それで差し引かれる割合が、プロトコル自体から読み取って表示されます。手数料割引への同意がオフの間は、どのティアも適用されません。新しい保有は時間がたってから完全に数えられるため、保有ルールによってティアが計上済み VPFI だけで得られるティアより低く抑えられているときは、ページがそう示します。VPFI のホームネットワークでは、表に各ティアが示されます：必要な計上済み VPFI、その割引、その割引を適用したローン開始手数料と受け取る利息にかかる手数料で、ネットワークの現在の設定から計算されます。各ティアはその数値から始まりますが、最上位だけはその数値をわずかに超えたところから始まります。割引が手数料の半分を超えることはありません。ほかのネットワークでは、ホームネットワークから送られたティアが表示され、表は表示されません。

<a id="rewards-vpfi-sign"></a>

### リワード：承認の代わりに署名

ウォレットがすでに VPFI について Permit2（多くのアプリが署名でトークンを移すために使う共有コントラクト）を承認している場合、VPFI 預け入れの確認画面に「承認の代わりに署名」が表示されます。このとき、ちょうどその金額の 1 回限りの送金に署名し（有効期間 30 分）、預け入れを送信します。ウォレットの操作は 2 回で、プロトコルへの承認はありません。署名は 1 回だけ、ご自身のウォレットが送るトランザクションでのみ、ご自身の保管庫への入金にのみ使えます。使われなければ失効します。アプリが Permit2 自体の承認を求めることはありません。その承認は期限がなく、他のアプリとも共有されるためです。それがない場合、確認画面はちょうどその金額の通常の承認のままです。Permit2 のないネットワークでは、この選択肢は表示されません。
