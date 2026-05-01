# Vaipakamへようこそ

Vaipakamは、ピアツーピアのレンディングプラットフォームです。
資産を貸して利息を得ることができます。資産を借りる場合は担保
を差し入れます。NFTをレンタルすれば、所有者は日次の利用料を
受け取ります。すべては2つのウォレットの間で直接行われ、loan
やrentalが終了するまで、smart contractsが資産をescrowで保持
します。

このページは**やさしい全体案内**です。技術的な詳細を知りたい
場合は、画面ごとの説明がある**User Guide**タブ、または完全な
whitepaperを載せた**Technical**タブを見てください。まずは「これ
は何で、どう使うのか」を知りたいだけなら、このまま読み進めて
ください。

---

## できること

Vaipakamは、主に4種類のユーザーのためにあります。

- **Lenders** — USDC、ETH、USDTなど、使っていないassetを持って
  いる人です。安全性を保ちながら、そのassetにinterestを生ませ
  たい場合に、lender offerを出します。borrowerがそれをacceptす
  ると、あなたの条件でinterestを得られます。
- **Borrowers** — 数日、数週間、数か月だけ資金が必要で、担保を
  売りたくない人です。値上がりを期待しているassetや、手放したく
  ないNFTを担保にできます。collateralをpostし、loanを受け取り、
  agreed rateで返済します。
- **NFT owners** — ゲーム内やアプリ内でutilityを持つ価値あるNFT
  を持っている人です。売却すると、そのutilityも失います。rentに
  出せば、ownershipを保ったまま、別の人に数日間使ってもらい、
  daily rentを受け取れます。
- **NFT renters** — game asset、membership pass、domainなどのNFT
  に一時的にアクセスしたい人です。full priceを払わずにrentし、
  rental windowの間だけ使い、assetのownershipはownerに残ります。

登録は不要です。プロフィール入力もありません。walletをconnect
すれば、lend、borrow、rentを始められます。

---

## Loanの流れ（具体例）

Base上のwalletに**1,000 USDC**があるとします。これでinterestを
得たい場合、全体のlifecycleは次のようになります。

### Step 1 — Offerを作成する

Vaipakam appを開き、walletをconnectして、**Create Offer**を
clickします。あなたはlenderなので、次の内容を入力します。

- **1,000 USDC**をlendする
- **8% APR**を希望する
- Acceptable collateral: **WETH**、**maximum 70% LTV**
- Loan duration: **30 days**

1つのtransactionにsignします。あなたの1,000 USDCはwalletから
**personal escrow**へ移動します（あなたのみがcontrolするprivate
vaultです）。borrowerがofferをacceptするまで、そこに保管され
ます。

### Step 2 — Borrowerがacceptする

おそらく1時間後、別のユーザーが**Offer Book**であなたのofferを
見つけます。その人はWETHを持っていて、それを担保に1か月間USDCを
borrowしたいと考えています。**Accept**をclickし、たとえば
$1,500相当のWETHをpostします（LTVは約67%で、あなたの70% capを
下回るため、offerはacceptされます）。

Acceptされた瞬間に:

- あなたの1,000 USDCが、あなたのescrowから相手のescrowへ移動します
- 相手のWETHはcollateralとして相手のescrowにlockされます
- 双方にposition NFTが発行されます — あなたのNFTは「1,000 USDC
  + interestを受け取る権利」、相手のNFTは「repay後にWETHを取り
  戻す権利」を表します
- Loan clockが動き始めます

Loaned amountから小さな**Loan Initiation Fee (0.1%)**が差し引か
れ、protocol treasuryへ送られます。そのためborrowerが受け取る
のは1,000 USDCではなく999 USDCです。（このfeeを**VPFI**で支払う
こともでき、その場合borrowerは1,000 USDCを全額受け取ります —
VPFIについては後述します。）

### Step 3 — 時間が経ち、borrowerがrepayする

30日後、borrowerはprincipal plus interestをあなたに返す必要が
あります。

```
Interest = 1,000 USDC × 8% × (30 / 365) = ~6.58 USDC
```

borrowerが**Repay**をclickし、transactionにsignすると、1,006.58
USDCがloan settlementへ移動します。そこから:

- あなたは**1,005.51 USDC**を受け取ります（principal + interest
  から、interest部分にのみかかる1% Yield Feeを差し引いた額）
- Treasuryは**1.07 USDC**をYield Feeとして受け取ります
- BorrowerのWETHはunlockされます

dashboardに**Claim** buttonが表示されます。clickすると、1,005.51
USDCがsettlementからあなたのwalletへ移動します。borrowerもclaim
すると、WETHが相手のwalletへ戻ります。これでloanはcloseされます。

### Step 4 — Borrowerがrepayしなかったら？

問題は大きく2つあり、protocolはそれぞれを自動的に処理します。

**Loan中にcollateral priceが急落する場合。** Vaipakamは各loanの
**Health Factor**を追跡します（collateral valueとdebtを比較する
1つの数値です）。これが1.0を下回ると、誰でも — そう、通りすがり
のbotであっても — **Liquidate**をcallできます。Protocolはcollateral
を最大4つのDEX aggregators（0x、1inch、Uniswap、Balancer）へroute
し、best fillを取り、あなたにowed amountを支払い、liquidatorに小
さなbonusを与え、残りがあればborrowerへ返します。

**Borrowerがdue dateを過ぎても戻ってこない場合。** configurableな
**grace period**の後（short loansなら1時間、year-long loansなら
2週間）、誰でも**Default**をcallできます。同じliquidation pathが
実行されます。

まれに、すべてのaggregatorが悪いpriceを返す、またはcollateralが
大きくcrashしていることがあります。その場合、protocolは悪いmarket
へ*無理にdumpすることを拒否*します。代わりに、あなたはcollateral
itself plus小さなpremiumを受け取り、好きなタイミングでholdまたは
sellできます。この**fallback path**は事前にdocumentedされており、
loan termsの一部としてacceptします。

### Step 5 — 誰でもrepayできる

友人やdelegated keeperがborrowerのloanをpay offしたい場合、それ
は可能です。ただしcollateralはborrowerに戻ります（親切なthird
partyには戻りません）。これはone-way doorです。他人のloanを支
払っても、その人のcollateralは手に入りません。

---

## NFT rentalsの仕組み

Flowはloanと同じですが、違いが2つあります。

- **NFTはescrowに残ります**。renterが直接holdすることはありませ
  ん。代わりにprotocolは**ERC-4907**を使い、rental windowの間、
  renterにNFTの"user rights"を与えます。対応するgamesやappsは
  user rightsを読み取るため、renterはNFTをownせずにplay、log in、
  utilityの利用ができます。
- **Daily feesはprepaid poolからauto-deductされます。** renterは
  rental全額をupfrontで支払い、さらに5% bufferを加えます。毎日、
  protocolはその日のfeeをownerへreleaseします。renterが早く終了
  したい場合、unused daysはrefundされます。

Rentalが終了すると（expiryまたはdefaultにより）、NFTはownerの
escrowへ戻ります。ownerは再度listするか、自分のwalletへclaim back
できます。

---

## 何が自分を守ってくれるのか？

Vaipakamでのlendingやborrowingはrisk-freeではありません。ただし、
protocolには複数の保護layerがあります。

- **Per-user escrow.** あなたのassetsは自分専用のvaultに置かれま
  す。Protocolが他のusersのfundsとpoolすることはありません。その
  ため、別のuserに影響するbugがあなたの資産をdrainすることはでき
  ません。
- **Health Factor enforcement.** Loanは、origination時点でcollateral
  がloan valueの少なくとも1.5×ある場合にのみstartできます。loan中
  にpriceがborrowerに不利に動いた場合でも、collateralがdebtを下回
  る前に誰でもliquidateできます — lenderを守るためです。
- **Multi-source price oracle.** PricesはまずChainlinkから取得され、
  Tellor、API3、DIAとcross-checkされます。configured thresholdを
  超えてdisagreeする場合、loanはopenできず、ongoing positionも
  unfairly liquidateできません。priceを偽造するには、attackerは
  **same block内で複数のindependent oracles**をcorruptする必要が
  あります。
- **Slippage cap.** Liquidationsは6%を超えるslippageでcollateralを
  dumpすることを拒否します。marketが薄すぎる場合、protocolは
  fallbackしてcollateralを直接あなたへ渡します。
- **L2 sequencer awareness.** L2 chainsでは、chainのsequencerが
  downtimeから戻った直後、liquidationが短時間pauseされます。これ
  により、attackersがstale-price windowを悪用してあなたに損害を
  与えることを防ぎます。
- **Pause switches.** 各contractにはemergency pause leversがあり、
  何か異常が見えたとき、operatorは数秒でnew businessを止められ
  ます。一方でexisting usersはpositionsをsafeにwind downできます。
- **Independent audits.** 各chainの各contractは、third-party security
  review後にのみshipされます。Audit reportsとbug bounty scopeは
  publicです。

それでも、自分が何にsignしているのか理解しておくべきです。各loan
の前に表示されるcombined **risk consent**を読んでください。そこ
ではabnormal-market fallback pathと、illiquid collateralのin-kind
settlement pathが説明されています。consent boxをtickするまで、app
はacceptを許可しません。

---

## Costはどれくらい？

Feesは2つだけで、どちらも小さいものです。

- **Yield Fee — 1%** lenderとして得る**interest**の1%です（principal
  の1%ではありません）。1,000 USDC、30-day、8% APRのloanでは、
  lenderは約6.58 USDCのinterestを得て、そのうち約0.066 USDCが
  Yield Feeになります。
- **Loan Initiation Fee — 0.1%** lending amountの0.1%で、origination
  時にborrowerが支払います。1,000 USDC loanなら1 USDCです。

どちらのfeeも、escrowにVPFIをholdすることで**最大24% discount**を
受けられます（下記参照）。Defaultやliquidationの場合、recovered
interestにYield Feeはかかりません — protocolはfailed loanから
profitしません。

Withdrawal fees、idle fees、streaming fees、principalへの
"performance" feesはありません。Protocolが取るのは上記2つのfee
だけです。

---

## VPFIとは？

**VPFI**はVaipakamのprotocol tokenです。3つの役割があります。

### 1. Fee discounts

あるchain上のescrowにVPFIをholdしていると、そのchainで参加する
loansのprotocol feesがdiscountされます。

| Escrow内のVPFI | Fee discount |
|---|---|
| 100 – 999 | 10% |
| 1,000 – 4,999 | 15% |
| 5,000 – 20,000 | 20% |
| 20,000超 | 24% |

Discountsはlender feesとborrower feesの両方に適用されます。
Discountは**loanのlife全体でtime-weighted**されるため、loan終了
直前にtop upしてcalculationをgameすることはできません。実際に
そのtierをholdしていた時間に比例してdiscountを得ます。

### 2. Staking — 5% APR

Escrow内にあるVPFIは、自動的に5% annual yieldのstaking rewardsを
得ます。別のstaking actionは不要です。lock-upもなく、"unstake"
の待ち時間もありません。VPFIをescrowへmoveすれば、その瞬間から
earnし始めます。外へmoveするとaccrualは止まります。

### 3. Platform interaction rewards

毎日、固定poolのVPFIが、protocolを通じて動いた**interest**に比例
してlendersとborrowersへdistributedされます。lenderとしてinterest
を得た場合、またはborrowerとしてcleanly interestを支払った場合
（no late fees, no default）、shareを得られます。

Reward poolは最初の6か月が最も大きく、その後7年かけてtaperして
いきます。Early usersほど大きなemissionsを受け取ります。

### VPFIの入手方法

3つの方法があります。

- **Earn it** — 参加することで得る（上記のinteraction rewards）。
- **Buy it** — **Buy VPFI** pageでfixed rate
  (`1 VPFI = 0.001 ETH`)で購入する。fixed-rate programはper wallet
  per chainでcappedです。
- **Bridge it** — VPFIはLayerZero OFT V2 tokenなので、official bridge
  を使ってsupported chains間を移動できます。

---

## どのchains？

Vaipakamは、supported chainごとにindependent deploymentとして動作
します: **Ethereum**, **Base**, **Arbitrum**, **Optimism**,
**Polygon zkEVM**, **BNB Chain**。

BaseでopenしたloanはBaseでsettleします。Arbitrumでopenしたloanは
Arbitrumでsettleします。cross-chain debtはありません。chainsを
またぐのはVPFI tokenとdaily reward denominatorだけです（busyな
chainsとquietなchainsの間でrewardsをfairにするため）。

---

## どこから始める？

**lend**したい場合:

1. Vaipakam appを開き、walletをconnectします。
2. **Create Offer**へ行き、"Lender"を選びます。
3. asset、amount、APR、accepted collateral、durationをsetします。
4. 2つのtransactionsにsignします（1つはapproval、1つはcreate）。
   これでofferはliveになります。
5. borrowerがacceptするのを待ちます。dashboardにactive loansが
   表示されます。

**borrow**したい場合:

1. appを開き、walletをconnectします。
2. **Offer Book**で、自分のcollateralと支払えるAPRに合うofferを
   browseします。
3. **Accept**をclickし、2つのtransactionsにsignすると、loan amount
   がwalletに入ります（0.1% Loan Initiation Feeを差し引いた額）。
4. due date plus grace periodまでにrepayします。collateralはunlock
   され、walletに戻ります。

**NFTをrentまたはlist**したい場合:

Flowは同じですが、**Create Offer** pageでERC-20 lendingではなく
"NFT rental"を選びます。formが案内してくれます。

**VPFIでpassive yield**だけを得たい場合は、**Dashboard** pageで
VPFIをescrowへdepositします。それだけです — stakingはその瞬間から
automaticです。

---

## 私たちが*しない*こと

他のDeFi platformsが行うことのうち、Vaipakamが意図的に**しない**
ものがあります。

- **No pooled lending.** 各loanは、両者がsignしたtermsを持つ2つの
  specific walletsの間だけで成立します。shared liquidity poolも、
  utilization curveも、surprise rate spikesもありません。
- **No proxy custody.** あなたのassetsはshared vaultではなく、自分
  のescrowに置かれます。Protocolは、あなたがsignしたactionsでのみ
  それらをmoveします。
- **No leveraged loops by default.** 望むならborrowed fundsを新しい
  lender offerとしてrepostできますが、protocolはautomatic looping
  をUXに組み込みません。これはfootgunだと考えています。
- **No surprise upgrades.** Escrow upgradesはgatedです。mandatory
  upgradesはappに表示され、あなたが明示的にapplyします。あなたの
  vaultが背後で勝手に書き換えられることはありません。

---

## もっと知りたい場合

- **User Guide** tabは、appの各screenをcardごとに説明します。
  「このbuttonは何をするの？」という質問に向いています。
- **Technical** tabは完全なwhitepaperです。「liquidation engineは
  実際どう動くの？」という質問に向いています。
- **FAQ** pageは、よくある短い質問に答えます。
- DiscordとGitHub repoは、どちらもapp footerからlinkされています。

これがVaipakamです。Walletをconnectすれば、すぐに始められます。
