# Vaipakam — उपयोगकर्ता मार्गदर्शिका (Advanced Mode)

ऐप के हर कार्ड के लिए सटीक और तकनीकी रूप से भरोसेमंद व्याख्याएँ।
हर सेक्शन कार्ड के शीर्षक के पास दिखने वाले `(i)` info icon से
जुड़ा है।

> **आप Advanced वर्ज़न पढ़ रहे हैं।** यह ऐप के **Advanced** मोड
> से मेल खाता है (ज़्यादा सघन controls, diagnostics, protocol
> कॉन्फ़िगरेशन की बारीकियाँ)। ज़्यादा सरल और आसान भाषा वाले
> walkthrough के लिए, ऐप को **Basic** मोड में बदलें — Settings
> खोलें (ऊपर-दाएँ कोने में gear icon) → **Mode** → **Basic**।
> ऐप के अंदर मौजूद (i) "Learn more" लिंक तब Basic गाइड खोलने
> लगेंगे।

---

## Dashboard

<a id="dashboard.your-vault"></a>

### आपका Vault

प्रति-user एक upgradable contract — इस chain पर आपकी निजी
तिजोरी — जो आपके पहली बार किसी loan में भाग लेने पर बनाया
जाता है। प्रति address, प्रति chain एक vault। इसमें आपकी loan
positions से जुड़े ERC-20, ERC-721, और ERC-1155 balances रहते
हैं। कोई pooling नहीं: इस contract में किसी दूसरे user के
assets कभी नहीं रखे जाते।

Vault ही वह जगह है जहाँ आपका collateral, उधार दिए गए assets
और locked VPFI रहते हैं। protocol हर deposit और withdrawal पर
इसी vault को verify करता है। implementation को protocol owner
update कर सकता है, लेकिन
सिर्फ़ timelock के ज़रिए — कभी तुरंत नहीं।

<a id="dashboard.your-loans"></a>

### आपके Loans

इस chain पर connected wallet से जुड़ा हर loan — चाहे आप lender
side पर हों, borrower side पर हों, या अलग-अलग positions में
दोनों। यह आपके address के लिए protocol के view methods से live
calculate होता है। हर row पूरी position page पर deep-link करती
है, जहाँ HF, LTV, accrued interest, आपकी role और loan status से
enabled actions, और on-chain loan id मिलती है, जिसे आप block
explorer में paste कर सकते हैं।

<a id="dashboard.vpfi-panel"></a>

### इस chain पर VPFI

active chain पर connected wallet के लिए live VPFI लेखा-जोखा:

- Wallet balance.
- Vault balance.
- circulating supply में आपकी हिस्सेदारी (protocol-held
  balances को घटाने के बाद)।
- शेष mintable cap.

Vaipakam VPFI को Chainlink CCIP के ऊपर cross-chain भेजता है।
**Base canonical chain है** — वहाँ canonical adapter
lock-on-send / release-on-receive semantics लागू करता है। हर
दूसरी supported chain mirror चलाती है, जो inbound bridge packet
आने पर mint करती है और outbound पर burn। design के हिसाब से,
bridging के दौरान सभी chains पर कुल supply invariant रहती है।

April 2026 की industry incident के बाद hardened cross-chain
message-verification policy है **3 required + 2 optional
verifiers, threshold 1-of-2**। default single-verifier
configuration deploy gate पर अस्वीकार कर दी जाती है।

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount की सहमति

Wallet-level opt-in flag, जिससे terminal events पर protocol
fee के discounted हिस्से को आपके vault से debit किए गए VPFI
में settle कर सकता है। Default: off. Off का मतलब है कि आप
हर fee का 100% principal asset में चुकाते हैं; on का मतलब है
कि time-weighted discount लागू होगा।

Tier ladder:

| Tier | Min vault VPFI                         | Discount                          |
| ---- | --------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`                | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`                | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`                | `{liveValue:tier4DiscountBps}`%   |

Tier आपके VPFI deposit या withdraw करते ही **post-change**
vault balance के against calculate होता है, फिर हर loan की
पूरी अवधि पर time-weighted किया जाता है। Unstake आपके हर खुले
loan पर तुरंत नए (कम) balance के आधार पर rate को फिर से stamp
कर देता है — कोई grace window नहीं जहाँ आपका पुराना (ऊँचा)
tier जारी रहे। इससे वह exploit pattern बंद होता है जहाँ कोई
user loan खत्म होने से ठीक पहले VPFI top up करके पूरा-tier
discount ले और कुछ seconds बाद withdraw कर ले।

discount lender के yield fee पर settlement के समय और borrower
की Loan Initiation Fee पर लागू होता है (जो VPFI rebate के
रूप में borrower के claim करते समय अदा होती है)।

> **Network gas अलग है।** ऊपर बताया गया discount Vaipakam की
> **protocol fees** (yield fee `{liveValue:treasuryFeeBps}`%,
> Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%) पर
> apply होता है। हर on-chain action के साथ लगने वाली **blockchain
> network gas fee** (Base / Sepolia / Arbitrum आदि के validators
> को offer create / accept / repay / claim / withdraw आदि के समय
> pay की जाती है) protocol charge नहीं है। Vaipakam उसे कभी
> receive नहीं करता; network करता है। उसको tier या rebate नहीं
> लगाया जा सकता, और वह submission के समय की chain congestion पर
> depend करती है, loan के size या आपके VPFI tier पर नहीं।

<a id="dashboard.rewards-summary"></a>

### आपके VPFI Rewards

यह summary card connected wallet की VPFI rewards picture को
दोनों reward streams में एक ही view में दिखाता है। headline
figure इनका योग है: pending staking rewards, lifetime-claimed
staking rewards, pending interaction rewards, और
lifetime-claimed interaction rewards।

हर stream की breakdown rows pending + claimed दिखाती हैं और
अपनी native page पर पूरी claim card के लिए chevron deep-link
देती हैं:

- **Staking yield** — आपके vault balance पर protocol APR से
  accrue हुआ pending VPFI, साथ में इस wallet से पहले claim किए
  गए सभी staking rewards। Buy VPFI page पर staking claim card
  से deep-link करता है।
- **Platform-interaction rewards** — हर loan में accrue हुआ
  pending VPFI जिसमें आपने भाग लिया है (lender या borrower
  side), साथ में पहले claim किए गए सभी interaction rewards।
  Claim Center में interaction claim card से deep-link करता है।

lifetime-claimed numbers हर wallet की on-chain claim history से
reconstruct किए जाते हैं। query करने के लिए कोई on-chain running
total नहीं है, इसलिए figure इस chain पर wallet के पुराने claim
events को walk करके sum होता है। नया browser cache zero (या
partial total) दिखा सकता है जब तक historic walk पूरा न हो; फिर
number सही value पर jump करता है। trust model वही है जो underlying
claim cards का है।

card connected wallets के लिए हमेशा render होता है, सभी values
zero हों तब भी। empty-state hint जानबूझकर है — zero पर card छिपाने
से rewards programs नए users को तब तक दिखाई नहीं देंगे जब तक वे
Buy VPFI या Claim Center तक न पहुँचें।

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Lender / borrower offer lists के ऊपर client-side filters।
asset, side, status और दूसरे axes के हिसाब से offers छाँटें।
Filters "आपकी Active Offers" को प्रभावित नहीं करते — वह list
हमेशा पूरी दिखाई जाती है।

<a id="offer-book.your-active-offers"></a>

### आपकी Active Offers

आपकी बनाई हुई खुली offers (status Active, expiration अभी तक
नहीं पहुँचा)। acceptance से पहले कभी भी cancel की जा सकती हैं
— cancel free है। Acceptance offer को Accepted में बदलता है
और loan initiation trigger करता है, जिससे दोनों position NFTs
mint होते हैं (एक lender के लिए, एक borrower के लिए) और loan
Active state में खुलता है।

<a id="offer-book.lender-offers"></a>

### Lender Offers

Active offers जहाँ creator उधार देने को तैयार है। इन्हें
borrower accept करता है। initiation पर hard gate है: borrower
की collateral basket को lender के principal request के against
कम से कम 1.5 Health Factor बनाना होगा। HF math protocol का
अपना है — gate bypass नहीं किया जा सकता। ब्याज पर 1% treasury
cut terminal settlement पर debit होती है, upfront नहीं।

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

ऐसे borrowers की active offers जिन्होंने अपना collateral
पहले से vault में lock कर दिया है। इन्हें lender accept करता
है; acceptance principal asset से loan fund करती है और
position NFTs mint करती है। initiation पर वही HF ≥ 1.5 gate
लागू होता है। fixed APR offer बनाते समय set होता है और loan
के पूरे जीवनकाल में immutable रहता है — refinance पुराने loan
को बदलता नहीं, बल्कि नया loan बनाता है।

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

यह तय करता है कि creator offer के किस side पर है:

- **Lender** — lender principal asset और एक collateral spec
  देता है जिसे borrower को पूरा करना होता है।
- **Borrower** — borrower पहले से collateral lock कर देता है;
  lender स्वीकार करके fund करता है।
- **Rental** sub-type — ERC-4907 (rentable ERC-721) और
  rentable ERC-1155 NFTs के लिए। यह debt loan के बजाय rental
  flow से होकर जाता है; किरायेदार पूरी rental लागत अग्रिम
  चुकाता है (अवधि × दैनिक शुल्क) साथ ही 5% buffer/margin।

<a id="create-offer.lending-asset"></a>

### Lending Asset

debt offer के लिए आप asset, principal राशि, fixed APR और
दिनों में अवधि specify करते हैं:

- **Asset** — जो ERC-20 उधार दिया / लिया जा रहा है।
- **राशि** — principal, asset के native decimals में।
- **APR** — basis points (एक प्रतिशत के सौवें हिस्से) में
  fixed वार्षिक दर; acceptance पर snapshot होती है और बाद में
  बदलती नहीं।
- **दिनों में अवधि** — वह grace window set करती है जिसके बाद
  default trigger किया जा सकता है।

accrued interest loan के start time से terminal settlement तक
प्रति-second लगातार calculate होता है।

<a id="create-offer.lending-asset:lender"></a>

#### यदि आप lender हैं

जो principal asset और राशि आप offer करने को तैयार हैं, साथ ही
ब्याज दर (APR % में) और दिनों में अवधि। rate offer के समय
fixed होती है; अवधि वह grace window set करती है जिसके बाद loan
default हो सकता है। acceptance पर, loan initiation के हिस्से
के रूप में principal आपके vault से borrower के vault में
move हो जाता है।

<a id="create-offer.lending-asset:borrower"></a>

#### यदि आप borrower हैं

जो principal asset और राशि आप lender से चाहते हैं, साथ ही
ब्याज दर (APR % में) और दिनों में अवधि। rate offer के समय
fixed होती है; अवधि वह grace window set करती है जिसके बाद loan
default हो सकता है। आपका collateral offer बनाते समय आपके
vault में lock हो जाता है और तब तक lock रहता है जब तक कोई
lender accept करके loan नहीं खोल देता (या आप cancel नहीं करते)।

<a id="create-offer.nft-details"></a>

### NFT Details

Rental sub-type fields. NFT contract और token id (और ERC-1155
के लिए quantity), साथ में principal asset में daily rental fee
specify करता है। acceptance पर, protocol renter के vault से
prepaid rental custody में debit करता है — अवधि × daily fee,
साथ में 5% buffer/margin। NFT खुद delegated state में चला जाता है
(ERC-4907 user rights, या ERC-1155 rental hook के equivalent
के ज़रिए), ताकि renter के पास उपयोग-अधिकार हों लेकिन वह NFT
transfer न कर सके।

<a id="create-offer.collateral"></a>

### Collateral

offer पर collateral asset spec. liquidity की दो classes:

- **Liquid** — एक registered Chainlink price feed है AND कम से
  कम एक Uniswap V3 / PancakeSwap V3 / SushiSwap V3 pool है
  जिसका current tick पर ≥ $1M depth है। LTV और HF math लागू
  होती है; HF-आधारित liquidation collateral को 4-DEX failover
  (0x → 1inch → Uniswap V3 → Balancer V2) से route करता है।
- **Illiquid** — जो ऊपर वाली liquid criteria pass न करे।
  on-chain $0 पर valued. कोई HF math नहीं। default पर पूरा
  collateral lender को transfer हो जाता है। दोनों पक्षों को
  offer creation / acceptance पर illiquid-collateral risk साफ़
  तौर पर acknowledge करना होता है, तभी offer land हो सकता है।

price oracle में primary Chainlink feed के ऊपर तीन स्वतंत्र
sources (Tellor, API3, DIA) का secondary quorum है, जो soft
2-of-N decision rule इस्तेमाल करता है। Pyth का मूल्यांकन किया
गया था, लेकिन अपनाया नहीं गया।

<a id="create-offer.collateral:lender"></a>

#### यदि आप lender हैं

आप borrower से loan की सुरक्षा के लिए कितना lock करवाना चाहते
हैं। Liquid ERC-20s (Chainlink feed plus ≥ $1M v3 pool depth)
पर LTV / HF math लागू होती है; illiquid ERC-20s और NFTs का
on-chain valuation नहीं होता और इनके लिए दोनों पक्षों को
full-collateral-on-default outcome पर सहमत होना ज़रूरी है। loan
initiation पर HF ≥ 1.5 gate acceptance के समय borrower की
presented collateral basket के against calculate होता है —
यहाँ requirement का size सीधे borrower के HF headroom को set
करता है।

<a id="create-offer.collateral:borrower"></a>

#### यदि आप borrower हैं

आप loan की सुरक्षा के लिए कितना lock करने को तैयार हैं। Liquid
ERC-20s (Chainlink feed plus ≥ $1M v3 pool depth) पर LTV / HF
math लागू होती है; illiquid ERC-20s और NFTs का on-chain
valuation नहीं होता और इनके लिए दोनों पक्षों को
full-collateral-on-default outcome पर सहमत होना ज़रूरी है।
borrower offer में आपका collateral offer creation के समय आपके
vault में lock होता है; lender offer में आपका collateral
acceptance के समय lock होता है। दोनों ही मामलों में, loan
initiation पर HF ≥ 1.5 gate आपकी presented basket के साथ clear
होना चाहिए।

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

submission से पहले acknowledgement gate. वही risk profile दोनों
पक्षों पर लागू होता है; नीचे की role-specific tabs बताती हैं
कि offer के जिस side पर आप sign कर रहे हैं, उसके हिसाब से हर
risk अलग ढंग से कैसे असर डालता है। Vaipakam non-custodial है:
ऐसी कोई admin key नहीं जो आ चुकी transaction को reverse कर दे।
Pause levers सिर्फ़ cross-chain-facing contracts पर हैं,
timelock-gated हैं, और assets move नहीं कर सकते।

<a id="create-offer.risk-disclosures:lender"></a>

#### यदि आप lender हैं

- **Smart-contract जोखिम** — contract code runtime पर
  immutable है; audited है, लेकिन formally verified नहीं।
- **Oracle जोखिम** — Chainlink staleness या pool-depth
  divergence HF-आधारित liquidation को उस बिंदु से आगे विलंबित
  कर सकती है जहाँ collateral principal को cover करता है।
  secondary quorum (Tellor + API3 + DIA, soft 2-of-N)
  बड़े drift को पकड़ता है, लेकिन छोटा skew फिर भी recovery को
  कम कर सकता है।
- **Liquidation slippage** — 4-DEX failover जो सबसे अच्छा
  execution मिल सके वहाँ route करता है, लेकिन कोई specific
  price guarantee नहीं कर सकता। Recovery slippage और interest
  पर 1% treasury cut के बाद net होती है।
- **Illiquid-collateral defaults** — default time पर पूरा
  collateral आपके पास transfer हो जाता है। यदि asset principal
  plus accrued interest से कम value का है, तो आपके पास कोई
  recourse नहीं।

<a id="create-offer.risk-disclosures:borrower"></a>

#### यदि आप borrower हैं

- **Smart-contract जोखिम** — contract code runtime पर
  immutable है; bugs आपके locked collateral को प्रभावित करेंगे।
- **Oracle जोखिम** — stale data या manipulation आपके ख़िलाफ़
  HF-आधारित liquidation trigger कर सकती है, भले ही वास्तविक
  market price safe रही हो। HF formula oracle output
  पर reactive है; एक ख़राब tick का 1.0 पार करना काफ़ी है।
- **Liquidation slippage** — liquidation trigger होने पर swap
  आपके collateral को slippage-hit prices पर बेच सकता है। swap
  permissionless है — आपका HF 1.0 से नीचे गिरते ही कोई भी उसे
  trigger कर सकता है।
- **Illiquid-collateral defaults** — default आपका पूरा
  collateral lender को transfer कर देता है। कोई residual claim
  नहीं बचता; सिर्फ़ कोई unused VPFI Loan Initiation Fee rebate,
  जिसे आप borrower के रूप में claim time पर लेते हैं।

<a id="create-offer.advanced-options"></a>

### Advanced Options

कम इस्तेमाल होने वाले controls:

- **Expiry** — इस timestamp के बाद offer self-cancels।
  Default ≈ 7 दिन।
- **इस offer के लिए fee discount का इस्तेमाल करें** — इस
  ख़ास offer के लिए wallet-level fee-discount consent का
  local override।
- offer creation flow द्वारा exposed side-specific विकल्प।

Defaults ज़्यादातर उपयोगकर्ताओं के लिए समझदारी भरे हैं।

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims design से pull-style हैं — terminal events funds को
protocol custody में छोड़ते हैं और position NFT holder उन्हें
move करने के लिए claim call करता है। दोनों तरह के claims एक
ही wallet में एक साथ हो सकते हैं। नीचे की role-specific tabs
हर case समझाती हैं।

हर claim atomically holder के position NFT को burn कर देता है।
NFT *ही* bearer instrument है — claim करने से पहले इसे
transfer करना नए holder को collect करने का अधिकार दे देता है।

<a id="claim-center.claims:lender"></a>

#### यदि आप lender हैं

Lender claim वापस देता है:

- आपका principal, इस chain पर आपके wallet में वापस।
- accrued interest minus 1% treasury cut। consent on होने पर वह
  cut आपके time-weighted VPFI fee-discount accumulator
  द्वारा कम होती है।

loan जैसे ही terminal state (Settled, Defaulted, या Liquidated)
तक पहुँचता है, claimable हो जाता है। Lender position NFT उसी
transaction में burn होता है।

<a id="claim-center.claims:borrower"></a>

#### यदि आप borrower हैं

Borrower claim इस आधार पर return करता है कि loan कैसे settle
हुआ:

- **पूरा repayment / preclose / refinance** — आपकी collateral
  basket वापस, साथ में Loan Initiation Fee से time-weighted
  VPFI rebate।
- **HF-liquidation या default** — सिर्फ़ unused VPFI Loan
  Initiation Fee rebate, जो इन terminal paths पर शून्य होता
  है जब तक स्पष्ट रूप से preserve न किया गया हो। Collateral
  पहले ही lender के पास चला गया होता है।

Borrower position NFT उसी transaction में burn होता है।

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain पर आपके wallet से जुड़ी on-chain events, sliding
block window में protocol logs से live sourced। कोई backend
cache नहीं — हर page load फिर से fetch करता है। Events transaction
hash के हिसाब से group होती हैं ताकि multi-event transactions
(जैसे accept + initiate एक ही block में) साथ रहें। सबसे नई
events पहले। offers, loans, repayments, claims, liquidations,
NFT mints / burns, और VPFI buys / stakes / unstakes दिखाता है।

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI ख़रीदना

दो रास्ते:

- **Canonical (Base)** — protocol पर canonical buy flow को
  सीधे call करें। VPFI सीधे Base पर आपके wallet में mint होता
  है।
- **Off-canonical** — local-chain buy adapter Base पर
  canonical receiver को Chainlink CCIP packet भेजता है, जो Base
  पर खरीद करता है और cross-chain token standard के ज़रिए
  result को वापस bridge करता है। L2-to-L2 pairs पर
  end-to-end latency ≈ 1 मिनट। VPFI **origin** chain पर आपके
  wallet में land करता है।

Adapter rate limits (post-hardening): प्रति request 50,000
VPFI और 24-hour rolling window में 500,000 VPFI। governance इन्हें
timelock के ज़रिए tune कर सकती है।

<a id="buy-vpfi.discount-status"></a>

### आपकी VPFI Discount Status

Live status:

- मौजूदा tier (0 से 4)।
- Vault VPFI balance साथ में अगले tier तक का अंतर।
- मौजूदा tier पर discount प्रतिशत।
- Wallet-level consent flag।

ध्यान दें कि vault VPFI staking pool के ज़रिए स्वतः 5% APR
भी जमा करता है — कोई अलग "stake" action नहीं। आपके vault
में VPFI deposit करना ही staking है।

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH से VPFI ख़रीदें

खरीद submit करता है। canonical chain पर protocol सीधे mint
करता है। Mirror chains पर buy adapter payment लेता है,
cross-chain message भेजता है, और Base पर receiver खरीद execute
करके VPFI वापस bridge करता है। Bridge fee plus verifier-network
cost form में live quote होकर दिखती है। VPFI vault में अपने
आप deposit नहीं होता — design के अनुसार Step 2 explicit user
action है।

<a id="buy-vpfi.deposit"></a>

### Step 2 — अपने vault में VPFI deposit करें

एक अलग explicit deposit step, आपके wallet से उसी chain पर
आपके vault तक। हर chain पर ज़रूरी — canonical पर भी — क्योंकि
vault deposit spec के अनुसार हमेशा explicit user action है।
जिन chains पर Permit2 configured है, app classic approve +
deposit pattern की जगह single-signature path prefer करता है;
यदि उस chain पर Permit2 configured नहीं है, तो यह clean fallback
करता है।

<a id="buy-vpfi.unstake"></a>

### Step 3 — vault से VPFI unstake करें

VPFI को अपने vault से अपने wallet में वापस withdraw करें।
कोई approval leg नहीं — protocol vault का owner है और खुद को
debit करता है। withdraw fee-discount rate को नए (कम) balance
पर तुरंत re-stamp करता है, जो आपके हर खुले loan पर लागू होता
है। कोई grace window नहीं जहाँ पुराना tier अभी भी apply हो।

---

## Rewards

<a id="rewards.overview"></a>

### Rewards के बारे में

दो streams:

- **Staking pool** — vault में रखा VPFI लगातार 5% APR पर
  accrue होता है, per-second compounding के साथ।
- **Interaction pool** — एक fixed daily emission का
  per-day pro-rata हिस्सा, उस दिन के loan volume में आपके
  settled-interest contribution से weighted। Daily windows
  window close के बाद पहले claim या settlement पर lazily
  finalise होती हैं।

दोनों streams सीधे active chain पर mint होती हैं — user के
लिए कोई cross-chain round-trip नहीं। Cross-chain reward
aggregation केवल protocol contracts के बीच होती है।

<a id="rewards.claim"></a>

### Rewards Claim करें

एक ही transaction दोनों streams को साथ में claim करती है।
Staking rewards हमेशा available रहते हैं; interaction rewards
तब तक zero रहते हैं जब तक relevant daily window finalise नहीं
होती (lazy finalisation, जो उस chain पर अगले non-zero claim या
settlement से trigger होती है)। window अभी finalise हो रही हो
तो UI button guard करता है, ताकि users under-claim न करें।

<a id="rewards.withdraw-staked"></a>

### Staked VPFI निकालें

Buy VPFI page के "Step 3 — Unstake" जैसा ही interface — vault
से VPFI को आपके wallet में वापस withdraw करें। निकला हुआ VPFI
तुरंत staking pool से बाहर हो जाता है (उस amount के लिए उसी
block में rewards accrue होना बंद) और discount accumulator से
भी तुरंत बाहर होता है (हर खुले loan पर post-balance re-stamp)।

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (यह पेज)

protocol से live-derived single-loan view, साथ में risk engine
से live HF और LTV। यह terms, collateral risk, parties, आपकी
role और loan status से enabled actions, और inline keeper status
render करता है।

<a id="loan-details.terms"></a>

### Loan Terms

loan के immutable parts:

- Principal (asset और राशि)।
- APR (offer creation पर fixed)।
- दिनों में अवधि।
- Start time और end time (start time + अवधि)।
- accrued interest, start से बीते seconds के आधार पर live
  calculate।

Refinance इन values को बदलने के बजाय एक ताज़ा loan
बनाता है।

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

Live risk math.

- **Health Factor** = (collateral USD value × liquidation
  threshold) / debt USD value. 1.0 से नीचे का HF position
  को liquidatable बना देता है।
- **LTV** = debt USD value / collateral USD value.
- **Liquidation threshold** = वह LTV जहाँ position liquidatable
  हो जाती है; यह collateral basket की volatility class पर
  निर्भर है। high-volatility collapse trigger 110% LTV पर है।

Illiquid collateral की on-chain USD value zero है; HF और LTV
"n/a" पर चले जाते हैं और एकमात्र terminal path default
पर full collateral transfer है — दोनों पक्षों ने offer creation
पर illiquid-risk acknowledgement के ज़रिए इसे स्वीकार किया था।

<a id="loan-details.collateral-risk:lender"></a>

#### यदि आप lender हैं

इस loan को secure करने वाली collateral basket आपकी safety
margin है। 1.0 से ऊपर HF का मतलब है कि position liquidation
threshold के मुकाबले over-collateralised है। जैसे-जैसे HF 1.0
की ओर drift करता है, आपकी protection कमज़ोर होती जाती है। HF
1.0 से नीचे जाते ही कोई भी (आप समेत) liquidate call कर सकता
है, और protocol collateral को आपके principal asset में बदलने
के लिए 4-DEX failover route करता है। Recovery slippage के बाद
net होती है।

Illiquid collateral में default time पर पूरी basket आपके पास
transfer हो जाती है — open market में उसकी वास्तविक value का
risk आपके ऊपर है।

<a id="loan-details.collateral-risk:borrower"></a>

#### यदि आप borrower हैं

आपका locked collateral. HF को 1.0 से सुरक्षित दूरी पर रखें —
volatility absorb करने के लिए 1.5 एक common safety margin है।
HF ऊपर लाने के levers:

- **Add collateral** — basket को top up करें। User-only
  action.
- **Partial repay** — debt कम करता है, HF ऊपर लाता है।

HF 1.0 से नीचे जाते ही कोई भी HF-based liquidation trigger कर
सकता है; swap आपके collateral को slippage-hit prices पर बेचकर
lender को चुकाता है। Illiquid collateral पर default आपका पूरा
collateral lender को transfer कर देता है — claim करने के लिए
सिर्फ़ कोई unused VPFI Loan Initiation Fee rebate बचता है।

<a id="loan-details.parties"></a>

### Parties

Lender, borrower, lender vault, borrower vault, और दो
position NFTs (हर पक्ष के लिए एक)। हर NFT on-chain metadata
के साथ ERC-721 है; इसे transfer करने से claim करने का अधिकार
भी transfer होता है। Vault contracts प्रति-address
deterministic हैं — deployments के पार वही address।

<a id="loan-details.actions"></a>

### Actions

protocol द्वारा role के हिसाब से gated action interface। नीचे की
role-specific tabs हर पक्ष के लिए available actions सूचीबद्ध
करती हैं। Disabled actions gate से derived hover reason दिखाते
हैं ("Insufficient HF", "Not yet expired", "Loan locked", आदि)।

भूमिका की परवाह किए बिना सबको available permissionless
actions:

- **Trigger liquidation** — जब HF 1.0 से नीचे गिरता है।
- **Mark defaulted** — जब grace period full repayment के बिना
  expire हो गया हो।

<a id="loan-details.actions:lender"></a>

#### यदि आप lender हैं

- **Claim as lender** — सिर्फ़ terminal states में। Principal plus
  interest minus 1% treasury cut लौटाता है (consent on होने पर
  time-weighted VPFI yield-fee discount से और कम)। Lender
  position NFT को burn करता है।
- **Initiate early withdrawal** — चुनी गई asking price पर
  lender position NFT को बिक्री के लिए list करता है। एक
  ख़रीदार जो sale पूरी करता है आपका पक्ष ले लेता है; आप
  proceeds पाते हैं। Sale fill होने से पहले cancellable।
- वैकल्पिक रूप से उस keeper को delegate किया जा सकता है जिसके
  पास relevant action permission हो — Keeper Settings देखें।

<a id="loan-details.actions:borrower"></a>

#### यदि आप borrower हैं

- **Repay** — पूरा या partial. Partial repayment outstanding
  कम करता है और HF ऊपर लाता है; full repayment terminal
  settlement trigger करता है, जिसमें time-weighted VPFI Loan
  Initiation Fee rebate शामिल है।
- **Preclose direct** — अपने wallet से अभी outstanding amount
  चुकाएँ, collateral release करें, rebate settle करें।
- **Preclose offset** — protocol के swap router के ज़रिए
  collateral का कुछ हिस्सा बेचें, proceeds से चुकाएँ, और बाक़ी
  वापस लौटाएँ। दो-step: initiate, फिर complete।
- **Refinance** — नई terms के लिए borrower offer पोस्ट करें;
  एक बार lender accept कर ले, complete refinance loans को
  atomic रूप से swap कर देता है, आपका collateral आपके vault
  से कभी बाहर नहीं जाता।
- **Claim as borrower** — सिर्फ़ terminal states में। पूरे repayment पर
  collateral लौटाता है, या default / liquidation पर
  unused VPFI Loan Initiation Fee rebate। Borrower
  position NFT को burn करता है।

---

## Allowances

<a id="allowances.list"></a>

### Allowances

इस chain पर आपके wallet ने protocol को दी हर ERC-20 allowance
list करता है। यह candidate-token list को on-chain allowance
views के against scan करके source करता है। Revoke allowance को
zero पर set कर देता है।

Exact-amount approval policy के कारण, protocol कभी unlimited
allowances नहीं माँगता, इसलिए typical revocation list छोटी
रहती है।

ध्यान दें: Permit2-style flows protocol पर per-asset allowance
को bypass करते हैं और इसके बजाय एक ही signature का इस्तेमाल
करते हैं, इसलिए यहाँ एक clean list भविष्य के deposits को नहीं
रोकती।

---

## Alerts

<a id="alerts.overview"></a>

### Alerts के बारे में

एक off-chain watcher आपके wallet से जुड़े हर active loan को
5-minute cadence पर poll करता है, हर loan का live Health Factor
पढ़ता है, और unsafe direction में band crossing होने पर
configured channels के ज़रिए एक बार alert fire करता है। कोई
on-chain state नहीं और कोई gas नहीं। Alerts advisory हैं — वे
funds move नहीं करते।

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

user-configured HF bands की ladder। ज़्यादा risky band में
crossing एक बार fire करती है और अगली deeper threshold को arm
करती है; band से ऊपर वापस crossing उसे फिर से arm करती है।
Defaults: 1.5 → 1.3 → 1.1। ऊँची values volatile collateral के
लिए बेहतर हैं। ladder का उद्देश्य सिर्फ़ इतना है कि HF 1.0 से
नीचे गिरकर liquidation trigger होने से पहले आपको warning मिल
जाए।

<a id="alerts.delivery-channels"></a>

### Delivery Channels

दो रेल:

- **Telegram** — wallet के short address, loan id और मौजूदा
  HF के साथ bot direct message।
- **Push Protocol** — Vaipakam Push channel के ज़रिए
  wallet-direct notification।

दोनों threshold ladder साझा करते हैं; drift से बचने के लिए
per-channel warning levels जानबूझकर expose नहीं किए गए हैं।
Push channel publishing अभी channel creation तक stubbed है।

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### NFT verify करें

NFT contract address और token id देने पर verifier fetch करता
है:

- मौजूदा owner (या burn signal, यदि token पहले से burn हो
  चुका है)।
- on-chain JSON metadata।
- Protocol cross-check: metadata से underlying loan id derive
  करता है और state confirm करने के लिए protocol से loan
  details पढ़ता है।

यह दिखाता है: क्या Vaipakam ने mint किया था? कौन सी chain?
Loan की status क्या है? मौजूदा holder कौन है? इससे आप fake
position, पहले से claimed (burned) position, या ऐसी position
पहचान सकते हैं जिसका loan settle हो चुका है और जो mid-claim
state में है।

position NFT bearer instrument है — secondary market पर ख़रीदने
से पहले verify करें।

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers के बारे में

प्रति wallet अधिकतम 5 keepers की keeper whitelist। हर keeper के
पास action permissions का set होता है, जो आपके loan के **आपके
side** पर specific maintenance calls authorise करता है।
Money-out paths (repay, claim, add collateral, liquidate)
design से user-only हैं और delegate नहीं किए जा सकते।

action time पर दो अतिरिक्त gates apply होते हैं:

1. Master keeper-access switch — एक one-flip emergency
   brake जो allowlist को छुए बिना हर keeper को disable कर
   देता है।
2. Per-loan opt-in toggle, Offer Book या Loan Details
   interface पर सेट किया गया।

एक keeper तभी act कर सकता है जब चारों conditions true हों:
approved, master switch on, per-loan toggle on, और उस keeper
के लिए specific action permission set।

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

वर्तमान में expose की गई action permissions:

- **Loan sale पूरी करें** (lender side, secondary-market
  exit)।
- **Offset पूरा करें** (borrower side, collateral sale के
  ज़रिए preclose का दूसरा leg)।
- **Early withdrawal initiate करें** (lender side, position
  को बिक्री के लिए list करें)।
- **Preclose initiate करें** (borrower side, preclose flow
  शुरू करें)।
- **Refinance** (borrower side, नई borrower offer पर
  atomic loan swap)।

On-chain जोड़ी गई permissions जिन्हें frontend अभी reflect
नहीं करता, उन्हें साफ़ "permission invalid" revert मिलता है।
Revocation सभी loans पर तुरंत लागू है — कोई waiting period
नहीं।

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics के बारे में

हर supported chain पर on-chain protocol view calls से live
calculate होने वाला wallet-free aggregator। कोई backend, कोई
database नहीं। CSV / JSON export available है; verifiability के
लिए हर metric के पीछे protocol address और view function दिखाया
जाता है।

<a id="public-dashboard.combined"></a>

### Combined — All Chains

Cross-chain rollup. Header report करता है कि कितनी chains
covered थीं और कितनी errored, ताकि fetch time पर unreachable
RPC साफ़ दिखे। जब एक या ज़्यादा chains errored हों, तो
per-chain table बताती है कौन सी — TVL totals फिर भी report
होते हैं, लेकिन gap acknowledge किया जाता है।

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

Combined metrics का per-chain split। TVL concentration,
mismatched VPFI mirror supplies (mirror supplies का sum
canonical adapter के locked balance के बराबर होना चाहिए), या
stalled chains spot करने के लिए useful।

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

active chain पर on-chain VPFI accounting:

- Total supply, सीधे ERC-20 से पढ़ा गया।
- Circulating supply — total supply minus protocol-held
  balances (treasury, reward pools, in-flight bridge
  packets)।
- शेष mintable cap — केवल canonical chain पर meaningful;
  mirror chains cap के लिए "n/a" report करती हैं क्योंकि
  वहाँ mints bridge-driven होते हैं, cap से नहीं।

Cross-chain invariant: सभी mirror chains पर mirror supplies
का sum canonical adapter के locked balance के बराबर होता है।
एक watcher इसे monitor करता है और drift पर alert करता है।

<a id="public-dashboard.transparency"></a>

### Transparency & Source

हर metric के लिए page list करता है:

- Snapshot के रूप में इस्तेमाल हुआ block number।
- Data freshness (chains के बीच अधिकतम age/staleness)।
- Protocol address और view function call।

कोई भी इस page की किसी भी संख्या को RPC + block + protocol
address + function name से re-derive कर सकता है — यही bar है।

---

## Refinance

यह page सिर्फ़ borrower के लिए है — refinance borrower अपने
loan पर initiate करता है।

<a id="refinance.overview"></a>

### Refinancing के बारे में

Refinance आपके मौजूदा loan को नए principal से atomically चुका
देता है और नई terms के साथ नया loan खोलता है — सब एक ही
transaction में। Collateral पूरे समय आपके vault में रहता है
— कोई unsecured window नहीं। किसी भी अन्य loan की तरह, नए loan
को initiation पर HF ≥ 1.5 gate clear करना होगा।

पुराने loan की unused Loan Initiation Fee rebate को swap
के हिस्से के रूप में सही ढंग से settle किया जाता है।

<a id="refinance.position-summary"></a>

### आपकी मौजूदा Position

जिस loan को refinance किया जा रहा है उसका snapshot — मौजूदा
principal, अब तक accrued interest, HF / LTV, और collateral
basket। नई offer को कम से कम outstanding amount (principal +
accrued interest) जितना size करना चाहिए; नई offer पर कोई भी
surplus आपके vault में free principal के रूप में deliver होता
है।

<a id="refinance.step-1-post-offer"></a>

### Step 1 — नई offer पोस्ट करें

अपनी target terms के साथ borrower offer पोस्ट करें। पुराना loan
इंतज़ार के दौरान interest accrue करता रहता है; collateral
locked रहता है। offer public Offer Book में दिखती है और कोई भी
lender उसे accept कर सकता है। आप acceptance से पहले cancel कर
सकते हैं।

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

नए lender के accept करने के बाद atomic settlement:

1. Accepting lender से नया loan fund करता है।
2. पुराने loan को पूरा चुकाता है (principal + interest, treasury
   cut घटाकर)।
3. पुराने position NFTs को burn करता है।
4. नए position NFTs mint करता है।
5. पुराने loan की unused Loan Initiation Fee rebate को
   settle करता है।

यदि नई terms पर HF 1.5 से नीचे होगा तो transaction revert करता है।

---

## Preclose

यह page सिर्फ़ borrower के लिए है — preclose borrower अपने loan
पर initiate करता है।

<a id="preclose.overview"></a>

### Preclose के बारे में

borrower-driven early termination. दो रास्ते:

- **Direct** — अपने wallet से outstanding amount (principal +
  accrued interest) चुकाएँ, collateral release करें, unused
  Loan Initiation Fee rebate settle करें।
- **Offset** — collateral का हिस्सा protocol के 4-DEX swap
  failover के ज़रिए principal asset के लिए बेचने के लिए
  offset initiate करें, proceeds से चुकाने के लिए offset
  complete करें, और बाक़ी collateral आपको वापस। वही rebate
  settlement।

कोई flat early-close penalty नहीं। Time-weighted VPFI math
fairness को संभालती है।

<a id="preclose.position-summary"></a>

### आपकी मौजूदा Position

जिस loan को preclose किया जा रहा है उसका snapshot — outstanding
principal, accrued interest, मौजूदा HF / LTV। Preclose flow को
exit पर HF ≥ 1.5 की **ज़रूरत नहीं** (यह closure है, re-init
नहीं)।

<a id="preclose.in-progress"></a>

### Offset In Progress

State: offset initiated है, swap execution में है (या quote
consume हो चुकी है लेकिन final settle pending है)। दो exits:

- **Offset complete करें** — realised proceeds से loan
  settle करता है, बाक़ी लौटाता है।
- **Offset cancel करें** — abort; collateral locked रहता है,
  loan unchanged। इसका इस्तेमाल तब करें जब initiate और
  complete के बीच swap आपके ख़िलाफ़ चला गया हो।

<a id="preclose.choose-path"></a>

### एक रास्ता चुनें

Direct path principal asset में wallet liquidity खर्च करता है।
Offset path DEX swap के ज़रिए collateral खर्च करता है; तब
preferred जब आपके पास principal asset हाथ में न हो या आप
collateral position से भी बाहर निकलना चाहें। Offset slippage
उसी 4-DEX failover द्वारा bound है जो liquidations के लिए
इस्तेमाल होता है (0x → 1inch → Uniswap V3 → Balancer V2)।

---

## Early Withdrawal (Lender)

यह page सिर्फ़ lender के लिए है — early withdrawal lender अपने
loan पर initiate करता है।

<a id="early-withdrawal.overview"></a>

### Lender Early Exit के बारे में

Lender positions के लिए secondary-market mechanism. आप चुनी गई
price पर अपने position NFT को sale के लिए list करते हैं;
acceptance पर buyer payment करता है, lender NFT ownership buyer
को transfer होती है, और buyer सभी future settlements (terminal
claim आदि) के लिए lender of record बन जाता है। आप sale proceeds
लेकर exit कर जाते हैं।

Liquidations user-only रहती हैं और sale के ज़रिए delegate
नहीं की जातीं — केवल claim करने का अधिकार transfer होता है।

<a id="early-withdrawal.position-summary"></a>

### आपकी मौजूदा Position

Snapshot — outstanding principal, accrued interest, बचा हुआ
समय, borrower side का मौजूदा HF / LTV। यही buyer market की
expected fair price तय करते हैं: buyer का payoff terminal
पर principal plus interest है, बचे हुए समय पर liquidation risk
घटाकर।

<a id="early-withdrawal.initiate-sale"></a>

### बिक्री शुरू करें

Position NFT को आपकी asking price पर protocol के ज़रिए sale
के लिए list करता है। कोई buyer sale complete करता है; sale fill
होने से पहले आप cancel कर सकते हैं। वैकल्पिक रूप से उस keeper
को delegate किया जा सकता है जिसके पास "complete loan sale"
permission हो; initiate step खुद user-only ही रहता है।

---

<!-- ────────────────────────────────────────────────────────────── -->
<!-- T-086 #374 — TRANSLATION NEEDED                                -->
<!--                                                                -->
<!--   The three sections below are appended in ENGLISH as the      -->
<!--   translator source. Each block is anchored with a stable      -->
<!--   in-app HTML id (load-bearing for dapp cross-links — DO NOT   -->
<!--   change the anchor strings).                                  -->
<!--                                                                -->
<!--   Native Hindi reviewer: please translate each block     -->
<!--   into Hindi AND move it into the appropriate position   -->
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


