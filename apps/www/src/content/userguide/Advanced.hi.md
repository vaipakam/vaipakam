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

### आपके सक्रिय ऑफ़र

खुले ऑफ़र (स्थिति Active, समाप्ति अभी नहीं पहुँची) जो आपने बनाए
हैं। स्वीकृति से पहले किसी भी समय रद्द किए जा सकते हैं — रद्द
कॉल मुफ़्त है। स्वीकृति ऑफ़र को Accepted में बदलती है और लोन
इनिशिएलाइज़ेशन ट्रिगर करती है, जो दो पोज़िशन NFTs (एक लेंडर के
लिए, एक बॉरोअर के लिए) मिंट करती है और लोन को Active स्थिति में
खोलती है।

बंद ऑफ़र कई अलग-अलग स्थितियों में से एक रखते हैं। कुछ पहले से
My Offers पेज पर फ़िल्टर चिप्स के रूप में दिखाए जाते हैं; अन्य
indexer-side टर्मिनल हैं जिन्हें फ़ॉलो-अप काम में dedicated UI
treatment मिलेगा:

- **Filled** — काउंटरपार्टी द्वारा स्वीकार किया गया; ऑफ़र का
  लोन reference resulting loan id है।
- **Cancelled** — ऑफ़र Cancelled स्थिति पर दो में से किसी एक
  रास्ते से पहुँचा: स्वीकृति से पहले creator द्वारा वापस लिया
  गया, या `OfferCancelFacet.cancelOffer` के माध्यम से
  permissionlessly cleanup किया गया जब
  `LibVaipakam.isOfferExpired(offer)` true है (refund अभी भी
  creator को route होता है चाहे किसी ने भी cancel call initiate
  किया हो)।
- **Sold** — ऑफ़र को borrow-OR-sell parallel-sale flow में opt-in
  किया गया (देखें ऑफ़र बनाएँ → वैकल्पिक बिक्री की अनुमति दें) और किसी
  लेंडर के स्वीकार करने से पहले एक marketplace buyer ने NFT
  collateral listing fill किया। ऑफ़र on-chain status
  `consumed_by_sale` रखता है; row का rate column उस rate को
  दिखाता है जिस पर ऑफ़र पोस्ट हुआ था और collateral cell NFT
  shape (ERC-721 के लिए token id, ERC-1155 के लिए copy count)
  render करता है। dapp भी row को Activity feed में
  `Offer sold via OpenSea` के रूप में borrower (offer creator)
  के लिए दिखाता है। on-chain event स्वयं है
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  offer id और executor address दोनों on-chain indexed हैं, लेकिन
  borrower / creator address नहीं। Activity feed के लिए borrower
  की wallet match indexer द्वारा ingestion time पर जोड़ी जाती है
  (वह creator look up करने के लिए offer row को join करता है),
  इसलिए per-wallet filter borrower को ढूँढ लेता है बिना event
  के स्वयं उन्हें index किए।
- **Fully Filled (indexer state, अभी chip नहीं)** — केवल Range-
  orders। जब partial-fill matching ऑफ़र का बचा हुआ budget
  consume करता है (आखिरी match range को पूरी तरह fill करता है,
  या partial match एक sub-dust remainder छोड़ता है),
  `OfferMatchFacet` `OfferClosed(FullyFilled | Dust)` emit करता
  है और indexer ऑफ़र row को `status = 'fullyFilled'` से stamp
  करता है। contract का `accepted` state और ऊपर का on-chain
  Filled label direct-accept terminal के लिए reserved हैं, इसलिए
  `fullyFilled` indexer side पर distinct है। dapp का
  `MyOfferStatus` अभी इस terminal को अपने filter chip के रूप में
  expose नहीं करता — `useMyOffers` वर्तमान में `fullyFilled`
  indexer status वाली rows को ignore करता है — इसलिए एक fully-
  filled range offer effectively My Offers view से बाहर गिर
  जाता है जब तक dedicated chip नहीं आता। chip surface एक अलग
  UI follow-up के रूप में queue में है।

Past-GTT (GTT समाप्ति समय) ऑफ़र जो कभी terminal event पर नहीं पहुँचे
अभी dapp में distinct status chip के रूप में expose नहीं हैं;
वे वर्तमान में Active के अंतर्गत आते हैं जब तक indexer terminal
record नहीं करता। एक dedicated Expired chip अलग UI follow-up के
रूप में queue में है।


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

<a id="create-offer.borrow-or-sell"></a>

### इस NFT की OpenSea पर optional बिक्री की अनुमति दें (केवल NFT-collateral वाले borrower offers)

यदि आप **borrower offer** **ERC-721 या ERC-1155 collateral** और
**ERC-20 principal** के साथ पोस्ट कर रहे हैं, dapp collateral
section के नीचे `Borrow or sell` opt-in expose करती है। इसे
चेक करना ऑफ़र को आपके NFT collateral की OpenSea पर parallel-
sale listing के लिए eligible मार्क करता है — एक single offer
जो या तो एक lender (आप loan लेते हैं) या एक marketplace buyer
(आप NFT बेचते हैं) द्वारा fill किया जा सकता है। यदि listing
पहले से post हुई है तो lender acceptance पर listing teardown
नहीं होती: यदि कोई lender पहले fill करता है, आप loan लेते हैं,
मौजूदा OpenSea listing loan initialization के माध्यम से अपनी
मूल Seaport expiry तक carry होती है, और उस expiry से पहले एक
बाद का marketplace fill diamond के settlement waterfall को
trigger करता है loan को sale proceeds से बंद करने के लिए
(Scenario B नीचे देखें)। साधारण GTT offers के लिए यह expiry
offer का मूल GTT समाप्ति समय है; lender acceptance listing को
पूर्ण loan term के लिए extend या repost नहीं करती। यदि कोई
marketplace buyer पहले fill करता है, कोई loan कभी create नहीं
होता (Scenario A)। दोनों scenarios different offer states पर
समाप्त होते हैं: Scenario A offer को `markOfferConsumedBySale`
के माध्यम से `consumed_by_sale` से mark करता है (यह Sold filter
के नीचे दिखाई देता है), और lender acceptance पहले से marked
किसी भी offer के विरुद्ध gated है। Scenario B में जब marketplace
fill land होती है तब तक offer पहले से `Accepted` state में होता
है; contract जानबूझकर offer status को `Accepted` पर छोड़ता है
और केवल sale से loan settle करता है — offer दूसरी बार Sold में
transition नहीं करता।

**दो-step nature.** Offer creation time पर opt-in केवल offer
पर eligibility flag set करता है। एक वास्तव में खरीदने योग्य
listing OpenSea पर लाना एक SEPARATE TWO-PART step है जिसे dapp
आज automate नहीं करती:

1. **Diamond पर record + wire करें।**
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` call करें जब offer अभी भी active है और किसी lender
   acceptance से पहले। एक बार offer accepted, cancelled, या
   consumed by sale हो जाता है, यह call terminal के रूप में
   revert होती है; केवल opt-in tick करना Scenario B में carry
   होने वाली listing बनाने के लिए पर्याप्त नहीं है। Ask को
   pre-loan floor भी cover करना चाहिए: principal plus worst-case
   offer interest loan duration और grace window के माध्यम से,
   उस interest पर treasury cut, configured safety buffer, और
   सभी fee-leg amounts। Under-floor asks इस step पर revert होते
   हैं। `feeLegs` argument एकमात्र स्थान है जहाँ यह call OpenSea
   protocol-fee और creator-royalty obligations record करती है:
   diamond प्रत्येक fee-leg amount को seller proceeds से घटाता
   है और recipient + absolute amount को Seaport consideration
   array में append करता है। Fee-enforced collection पर
   `feeLegs: []` pass करना एक order shape produce करता है जिसे
   OpenSea publish step reject करेगा (fee-recipient consideration
   items गायब हैं) और direct Seaport fill पूरा ask seller को
   route करेगा बजाय fees को split करने के जैसा collection
   चाहता है। Advanced users को OpenSea required-fee schedule
   collection के लिए fetch करना होगा (in-repo fee parser
   `apps/defi/src/lib/openseaFeeSchedule.ts` reference है) और call करने
   से पहले ask के विरुद्ध derived absolute amounts pass करने
   होंगे। Facet internally उन inputs से canonical Seaport
   OrderComponents build करता है (साथ ही values जो वह
   `CollateralListingExecutor.offerContext` में रखता है —
   borrower vault address, principal asset, collateral fields,
   startTime, endTime) और vault के लिए current `Seaport.getCounter`,
   `Seaport.getOrderHash` के माध्यम से orderHash derive करता है,
   उसे return करता है, vault के ERC-1271 binding को उस hash से
   register करता है, और NFT collateral के लिए Seaport conduit
   approval grant करता है। Emit किया गया `PostParallelSaleListing`
   event input args expose करता है (`offerId`, borrower,
   orderHash, askPrice, executor / conduit data, salt, fee legs);
   यह per-context fields echo नहीं करता, इसलिए off-chain
   OrderComponents reconstruct करने के लिए step 2 में वर्णित
   additional reads चाहिए। **महत्वपूर्ण:** इस point पर order
   पहले से Seaport के माध्यम से FILLABLE है। contract के events
   plus उन reads को देखने वाला bot OrderComponents reconstruct
   कर सकता है और सीधे `Seaport.fulfillOrder` call कर सकता है —
   on-chain fill path काम करने के लिए listing को OpenSea
   marketplace UI पर appear करने की आवश्यकता नहीं है। यदि आप
   नहीं चाहते कि counterparties step 2 land होने से पहले current
   ask पर fill करें, या तो step 1 के तुरंत बाद step 2 run करें
   या किसी unintended fill से पहले binding को invalidate करने के
   लिए `releaseParallelSaleLock` call करें।
2. **OpenSea पर publish करें।** वही OrderComponents reconstruct
   करें जो facet ने बनाए। केवल `PostParallelSaleListing` event
   पर्याप्त नहीं है: यह `offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, और fee legs emit
   करता है, लेकिन offer-keyed order shape को executor के
   `OfferContext` storage में रखे values (borrower vault address,
   principal asset, collateral fields, startTime, endTime) plus
   borrower vault का Seaport counter (offerer का counter —
   `LibPrepayOrder.buildAndHashOfferMem`
   `Seaport.getCounter(ctx.borrowerVault)` hash करता है, NOT
   बोलीदाता का counter) भी चाहिए। यह वही context है जिसे
   `LibPrepayOrder.buildAndHashOfferMem` offer-order path
   उपयोग करता है, और यह loan-keyed prepay-listing order shape
   से अलग है। पोस्ट करने से पहले दोनों पढ़ें:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     उस hash के लिए persisted `OfferContext` struct return करता
     है।
   - `Seaport.getCounter(borrowerVault)` vault offerer के लिए
     canonical Seaport counter return करता है।
   इन fields को हाथ में लेकर OrderComponents struct ठीक उसी को
   reproduce करता है जिसे diamond ने hash किया। POSTing से पहले,
   API-only field `parameters.totalOriginalConsiderationItems`
   add करें — OpenSea की API इसे require करती है भले ही यह
   canonical hash produce करने वाले Seaport struct का हिस्सा
   नहीं है; in-repo publishers
   (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) endpoint call करने से
   पहले इसे inject करते हैं। ERC-1271-validated orders के लिए
   OpenSea `signature` field को `0x` (empty bytes) के रूप में
   accept करती है — vault का on-chain
   `isValidSignature(orderHash, '')` callback signature bytes को
   ignore करता है और किसी भी orderHash के लिए EIP-1271 magic
   value return करता है जिसे diamond ने पहले register किया था
   (step 1 से)। JSON को OpenSea listings endpoint पर POST करें
   (`POST /api/v2/orders/{chain}/{protocol}/listings`, official
   [Create Listing](https://docs.opensea.io/reference/post_listing)
   docs के अनुसार — यह वही endpoint है जिसे Vaipakam के अपने
   publishers `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` में उपयोग करते हैं)।
   केवल इस step के बाद listing OpenSea marketplace UI पर appear
   करती है और casual buyers के लिए discoverable बनती है।
   Vaipakam वर्तमान में parallel-sale path के लिए इस submission
   को automate नहीं करता — end-to-end listing publication surface
   करना follow-up के रूप में tracked है।

जो advanced users आज manual path follow करते हैं उन्हें OpenSea
visibility के लिए दोनों steps चाहिए; केवल step 1 चलाना एक order
produce करता है जो Seaport के माध्यम से सीधे fillable है (bot
या counterparty द्वारा जो event से components reconstruct करता
है) लेकिन OpenSea marketplace UI पर invisible।

**Fill mode forced to All-or-Nothing.** Opt-in स्वचालित रूप से
offer के fill mode को `Aon` पर pin करता है — partial / IOC fill
modes parallel-sale enabled के साथ एक offer के collateral के
विरुद्ध multiple loans create करेंगे, जिसके विरुद्ध contract
gate करता है। Toggle lender offers, ERC-20 collateral, NFT
principals, और किसी भी अन्य shape पर छिपा हुआ है जिसे
contract का `_validatePostParallelSale` reject करेगा, इसलिए आप
इसे ineligible offer पर गलती से tick नहीं कर सकते।

**Buyer क्या देखता है।**

- *किसी lender के accept करने से पहले* (Scenario A): एक buyer
  जो OpenSea listing fill करता है listed price pay करता है।
  Fee-enforced collections पर, Seaport OpenSea protocol-fee और
  creator-fee legs को पहले उनके configured recipients पर सीधे
  route करता है; executor केवल **net proceeds** (listed price
  minus उन marketplace / creator fee legs) diamond को pass
  करता है। Diamond उस net amount को आपके vault में escrow
  करता है, NFT buyer को transfer होता है, और offer
  `consumed_by_sale` से mark होता है (My Offers, Activity, और
  Offer Details में distinct "Sold" status के रूप में दिखाई
  देता है)। कोई loan कभी create नहीं हुआ; आप net sale proceeds
  रखते हैं।
- *किसी lender के accept करने के बाद* (Scenario B): listing
  loan initialization के माध्यम से carry होती है — न तो
  borrower NFT lock और न ही listing teardown होती है। बाद का
  buyer fill diamond के settlement waterfall को एक Seaport
  transaction में trigger करता है। Scenario A जैसा ही fee-leg
  note: fee-enforced collections पर, Seaport OpenSea
  protocol-fee और creator-fee legs को पहले उनके configured
  recipients पर सीधे route करता है, और executor केवल
  **net proceeds** (sale price minus marketplace / creator
  fees) को diamond के waterfall में pass करता है। Waterfall फिर
  उस net amount को route करता है: lender अपना settlement
  entitlement पाता है (जो `LibEntitlement.settlementInterest`
  full coupon के रूप में calculate करता है जब loan
  `useFullTermInterest = true` के साथ create हुआ था, या settlement
  timestamp पर accrued pro-rata interest अन्यथा — gate loan
  policy है, यह नहीं कि sale scheduled maturity से पहले या बाद
  में होती है), treasury cut treasury को जाता है, और remainder
  current borrower-position NFT holder के vault में सीधे deposit
  होता है (`LibUserVault.getOrCreate` + vault deposit के
  माध्यम से)। कोई Claim Center claim create नहीं होता — sale
  land होने के बाद अपना vault balance check करें।

**आप इसे किसके साथ combine नहीं कर सकते।** दो distinct conflict
classes, अलग-अलग protocol stages पर surface होती हैं:

- *Publish-time block (sibling loan-keyed listing).* यदि loan
  के पास पहले से offer-create से carry होती parallel-sale
  listing है और borrower फिर
  `NFTPrepayListingFacet.postPrepayListing` (या
  `updatePrepayListing`) call करता है उसी loan पर SECOND
  loan-keyed prepay listing post करने के लिए, diamond
  `SiblingParallelSaleListingLive` से revert होता है। Borrower
  के NFT के लिए conduit approval single slot है — दोनों
  listings concurrently run करना ambiguous approval create करेगा।
  Borrower publish / update call पर revert देखता है; कुछ fill
  नहीं होता।
- *Fill-time block (open PrecloseFacet offset).* यदि loan के
  पास open PrecloseFacet offset offer है और एक buyer बाद में
  parallel-sale listing को fill करने की कोशिश करता है, diamond
  का `_settleLoanFromParallelSale` `ParallelSaleBlockedByOpenOffsetOffer`
  से revert होता है। Listing OpenSea पर valid रहती है लेकिन
  कोई fill attempt revert होता है जब तक offset link clear
  नहीं होता। Dapp वर्तमान में Loan Details page पर इस combination
  के लिए dedicated banner / notification surface नहीं करती;
  users fills revert होते देखेंगे और diagnose करने के लिए
  block explorer पर revert reason inspect करना पड़ सकता है।
  Cleanup path ordinary offer-cancel surface है —
  `OfferCancelFacet.cancelOffer(offsetOfferId)` call करें offset
  offer को cancel करने के लिए, जो offset link release करता है
  और parallel-sale fill को unblock करता है (PrecloseFacet के पास
  separate cancellation entry point नहीं है; offset linked
  offer से bound है, इसलिए linked offer cancel करना उसे clear
  कर देता है)। Conflict के लिए dedicated UI surface separate
  UX follow-up के रूप में queue में है।


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

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Prepay listing पर OpenSea offers को match करना

एक बार आपकी prepay listing OpenSea marketplace पर live होने के
बाद, casual buyers कभी-कभी आपके token पर सीधे **item offers**
place करेंगे — आपके specific collateral से tied बोलियाँ, collection
के किसी token से नहीं। Vaipakam इन item offers को Loan Details
page पर real-time में दिखाता है — "List collateral on
OpenSea" के नीचे एक separate panel जिसमें per incoming offer एक
row होती है। Panel एक **buffer threshold** apply करता है —
lender का settlement entitlement (जो पहले से principal plus
full coupon (full-term-interest loans पर) या pro-rata interest
(अन्यथा) include करता है — देखें
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus treasury
cut, plus safety buffer — और उन offers को **greys out** करता है
जो इसे clear नहीं करते। आप हर level पर market interest देख
सकते हैं लेकिन केवल वो offers Match कर सकते हैं जिन्हें protocol
वास्तव में settle करेगा।

Collection-wide / criteria offers (बोलियाँ जिन्हें collection में
कोई भी token fulfill कर सकता है) OpenSea पर रहते हैं लेकिन
dapp के Match panel में **appear नहीं होते** — protocol जिस
multi-leg consideration में settle करता है उसे contract-side
plumbing के बिना criteria offer के विरुद्ध reconstruct नहीं
किया जा सकता जो v1 में नहीं है। यदि आपकी एकमात्र inbound
demand collection-wide है, आज practical path item-specific बोली
की प्रतीक्षा करना या listing को अपने fixed ask पर छोड़ना और
किसी भी buyer को इसे directly fulfill करने देना है। आप
collection-wide बोली को manually स्वयं settle नहीं कर सकते —
collateral NFT आपके Vaipakam vault में रहता है, और Vaipakam-side
Seaport orders एकमात्र authorised settlement shape हैं।

उन collections पर जो OpenSea protocol fees और/या creator
royalties enforce करती हैं, dapp offers panel render करती है —
OpenSea API से fee-schedule fetch advisory माना जाता है; actual
fulfillment data MATCH CLICK TIME पर fetch होता है। Match panel
fee-schedule fetch status के बावजूद render होता है; click-time
fulfillment-data fetch gate है। यदि वह fetch fail होता है (rate
limit, API outage, या unsupported collection shape), dapp-side
Match click handler किसी भी
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` transaction के
construct होने से पहले ABORT होता है — कोई calldata नहीं, कोई
signature prompt नहीं, कोई revert नहीं। On-chain function स्वयं
`bool`-returning selector नहीं है; जब यह run होता है तो
`bytes32` order hash return करता है या revert होता है। तो
fee-enforced collection का panel वह offers दिखा सकता है जिन्हें
आप browse कर सकते हैं लेकिन उनमें से सभी given moment में
clickable-to-match नहीं हैं।

जब आप acceptable offer पाते हैं और **ऑफ़र match करें** click करते
हैं, dapp **match पुष्टि करें** modal खोलती है, जो match हुई value
(gross OpenSea offer amount — NOT वह net amount जिस पर diamond
settle करेगा; fee-enforced collections पर
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` lender /
treasury / borrower split run करने से पहले `effectiveAsk =
offerValue - bidderFeeTotal` calculate करता है, इसलिए वह net
जो diamond वास्तव में distribute करता है modal के मुख्य दिखाया गया amount से
छोटा है) पुनः बताता है और atomic-match flow की generic
explanation देता है। Confirm करने के बाद, dapp एक single
`matchOpenSeaOffer` transaction भेजती है जो बोलीदाता के offer को
freshly-constructed diamond-side counter-order के साथ एक
Seaport `matchAdvancedOrders` call में bundle करती है —
बोलीदाता's fulfilment, counter-order का listing-side leg (आपने
prior v1 prepay listing live रखा हो या न रखा हो; atomic path
`existingHash == 0` को support करता है), और diamond के
settlement waterfall सभी एक block में atomically land होते हैं।
Transaction या तो पूरी तरह succeed होती है (loan settled, NFT
transferred, sale proceeds split) या पूरी तरह revert होती है
(कुछ नहीं हिलता), और listing rotation और settlement के बीच
**कोई window नहीं** है जिसमें कोई third-party buyer matched
price पर step in कर सके।

> **कोई race window नहीं — संरचना से atomic.** यह v1 two-step
> "cancel + post" pattern का structural close-out है: v1 के तहत
> dapp listing को separate `updatePrepayListing` transaction के
> रूप में rotate करती, rotated price को OpenSea पर live छोड़ती
> जब तक बोलीदाता का `fulfillOrder` बाद के block में land नहीं
> होता — mempool देखने वाला कोई भी बोलीदाता को उस price से snipe
> कर सकता था जो उसने बोली किया था। Atomic path उस hole को
> दोनों orders को एक Seaport match call में bind करके बंद करता
> है: या तो बोलीदाता agreed price पर fill करता है या पूरी
> transaction revert होती है।

**Match click करने से पहले आप जो verify करना चाहते हैं:**

- **Modal में match हुई value confirm करें।** Modal gross OpenSea
  offer amount दिखाता है। Fee-enforced collections पर,
  diamond बोलीदाता-side marketplace / creator fee legs के बाद
  net effective ask के विरुद्ध settle करता है, इसलिए modal
  value lender / treasury / borrower split के लिए उपयोग की गई
  amount से अधिक हो सकती है। Bidder address और precise split
  modal या OpenSea Offers panel row में break out नहीं हैं
  (row value, payment token, offer kind, truncated बोलीदाता, और
  end time दिखाती है)। Split settlement पर diamond द्वारा
  on-chain enforce होता है — protocol का settlement buffer
  guarantee करता है कि effective ask lender के settlement
  entitlement (जो पहले से principal plus full coupon (full-
  term-interest loans पर) या pro-rata interest (अन्यथा) include
  करता है) plus treasury cut cover करता है, इसलिए split आपके
  लिए हमेशा कम से कम neutral होता है। यदि आप confirming से पहले
  projected split देखना चाहते हैं, diamond
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  को callable view के रूप में expose करता है — यह lender और
  treasury legs return करता है जिन्हें settlement waterfall
  given timestamp पर route करेगा, और remainder आपका है।
- **Collection के लिए OpenSea का fee posture check करें।** यदि
  collection OpenSea protocol fees या creator royalties enforce
  करती है, atomic path को SignedZone `extraData` /
  criteria-resolver plumbing चाहिए जिसे dapp agent के OpenSea
  fulfillment-data proxy (PR #349) के माध्यम से MATCH CLICK
  TIME पर fetch करती है। Match panel fee-schedule fetch status
  के बावजूद render होता है; click-time fulfillment-data fetch
  gate है। यदि वह fetch fail होता है (rate limit, API outage,
  unsupported collection shape), dapp-side click handler
  on-chain `matchOpenSeaOffer` transaction construct करने से
  पहले abort होता है — कोई calldata build नहीं होती, कोई
  signature prompt नहीं fire होता, कोई banner पहले से show नहीं
  होता। आप click बाद में retry कर सकते हैं (fetch केवल
  transient API blip हो सकता है), या इस बीच listing को OpenSea
  पर listed ask पर सीधे fulfill कर सकते हैं।

  ---

  ## लिक्विडेशन (Liquidation) वास्तव में कैसे काम करता है

  ऑफ़र के समय आपने जिन Risk Disclosures को स्वीकार किया था, वे दो वाक्यों में सबसे खराब स्थिति को स्पष्ट करते हैं। यह अनुभाग इसके पीछे की मैकेनिक्स को समझाता है — यह तब उपयोगी है जब आप यह समझना चाहते हैं कि इन-काइंड (in-kind) फ़ॉलबैक क्यों मौजूद है, या आपका लोन वास्तव में चार शाखाओं में से कौन सा रास्ता लेगा।

  अनुबंध का वह फ़ंक्शन जो बँटवारे का निर्णय लेता है, `LibFallback.computeFallbackEntitlements` है। यह क्रम में चार मामलों की जाँच करता है; जो सबसे पहले मेल खाता है, वही ट्रिगर होता है।

  <a id="liquidation-mechanics.case-1"></a>

  ### मामला 1 — Oracle उपलब्ध है, कोलैटरल की कीमत देय राशि के बराबर या उससे अधिक है

  यह स्वस्थ रास्ता है। Chainlink प्राइस फ़ीड्स प्रतिक्रियाशील हैं, सॉफ्ट 2-of-N सेकेंडरी कोरम (Tellor + API3 + DIA) ने असहमति नहीं जताई है, और जब्त किया गया कोलैटरल ओरेकल मूल्य पर आँकने पर बकाया राशि को कवर करता है।

  क्या होता है:

  - लेंडर को ओरेकल मूल्य पर आँका गया (प्रिंसिपल + अर्जित ब्याज + 3% फ़ॉलबैक बोनस) के बराबर मूल्य की **कोलैटरल एसेट** प्राप्त होती है। प्रभावी रूप से: लेंडर को उचित मूल्य पर भुगतान किया जाता है, लेकिन लेंडिंग एसेट के बजाय कोलैटरल एसेट में।
  - ट्रेजरी को प्रिंसिपल का 2% प्रीमियम प्राप्त होता है, जिसे कोलैटरल में आँका जाता है।
  - बॉरोअर को कोलैटरल का **शेष हिस्सा** वापस मिल जाता है। यह एक वास्तविक रिफंड है — यह वह अतिरिक्त कोलैटरल (over-collateralisation) है जिसकी लेंडर के दावे को कवर करने के लिए आवश्यकता नहीं थी।

  उदाहरण: 0.6 WETH ($3000 कोलैटरल, $1000 कर्ज) के बदले 1000 USDC का लोन। ओरेकल ETH की कीमत $5000 / WETH बताता है; कर्ज + ब्याज + बोनस = $1050। लेंडर को 0.21 WETH ($1050 मूल्य का), ट्रेजरी को 0.004 WETH (2% प्रीमियम का $20 मूल्य), बॉरोअर को शेष ~0.386 WETH प्राप्त होता है।

  <a id="liquidation-mechanics.case-2"></a>

  ### मामला 2 — Oracle उपलब्ध है, कोलैटरल की कीमत देय राशि से कम है

  यह घाटे वाला रास्ता है। ओरेकल काम कर रहा है, लेकिन जब्त किया गया कोलैटरल ओरेकल मूल्य पर भी देय राशि से कम है। यह अक्सर अस्थिर एसेट्स की गिरावट में होता है जहाँ कोलैटरल की कीमत इतनी तेज़ी से गिरती है कि HF प्रतिक्रिया नहीं दे पाता।

  क्या होता है:

  - लेंडर को जब्त किया गया **पूरा** कोलैटरल प्राप्त होता है।
  - ट्रेजरी को कुछ नहीं मिलता।
  - बॉरोअर को कुछ नहीं मिलता — रिफंड के लिए कोई शेष राशि नहीं बचती।

  लेंडर कमी को झेलता है। बॉरोअर, प्रोटोकॉल या किसी तीसरे पक्ष के खिलाफ कोई और दावा नहीं रहता। यह वही मामला है जिसके बारे में Risk Disclosures की "रिकवरी उधार दिए गए एसेट से कम हो सकती है" वाली लाइन विशेष रूप से चेतावनी देती है।

  उदाहरण: वही 1000 USDC / 0.6 WETH लोन, लेकिन ETH गिरकर $1500 / WETH पर आ जाता है। कोलैटरल अब $900 है; कर्ज $1050 है। लेंडर को पूरा 0.6 WETH ($900 मूल्य का) प्राप्त होता है, ट्रेजरी 0, बॉरोअर 0।

  <a id="liquidation-mechanics.case-3"></a>

  ### मामला 3 — Oracle कोरम अनुपलब्ध (UNAVAILABLE) है

  यह डार्क-कोरम रास्ता है। Chainlink का डेटा पुराना (stale) हो चुका है और 2-of-N सेकेंडरी कोरम भी सहमत नहीं हो पा रहा है (हर सेकेंडरी या तो ऑफ़लाइन है या प्राइमरी से असहमत है)। प्रोटोकॉल के पास लोन के किसी भी पक्ष के लिए कोई भरोसेमंद कीमत नहीं है, इसलिए वह निष्पक्ष बँटवारे की गणना नहीं कर सकता।

  क्या होता है:

  - लेंडर को जब्त किया गया **पूरा** कोलैटरल प्राप्त होता है, **भले ही उसकी गणना की गई कीमत कुछ भी हो** (क्योंकि कोई भी गणना भरोसेमंद नहीं है)।
  - ट्रेजरी को कुछ नहीं मिलता।
  - बॉरोअर को कुछ नहीं मिलता।

  भुगतान मामला 2 जैसा ही है, लेकिन यहाँ कारण मौलिक रूप से अलग है: प्रोटोकॉल यह तय नहीं कर रहा है कि "कोलैटरल की कीमत कर्ज से कम है" — बल्कि यह तय कर रहा है कि "मैं यहाँ किसी भी नंबर पर भरोसा नहीं कर सकता, इसलिए लेंडर को पूरी जब्त टोकरी मिलती है और वह खुले बाजार में उसकी जो भी कीमत हो, उसे झेलता है।"

  एक अलग ऑन-चेन इवेंट (`LiquidationFallbackOracleUnavailable`) उत्सर्जित किया जाता है ताकि ऑडिटर्स बाद के विश्लेषण में दोनों रास्तों के बीच अंतर कर सकें।

  <a id="liquidation-mechanics.case-4"></a>

  ### मामला 4 — किसी भी तरफ Illiquid एसेट होना

  यह इलिक्विड-एसेट रास्ता है। लेंडिंग एसेट, कोलैटरल एसेट, या दोनों प्रोटोकॉल के क्लासिफायर में लिक्विड (Liquid) के रूप में योग्य नहीं हैं (कोई Chainlink फ़ीड नहीं है, या वॉल्यूम सीमा से ऊपर कोई Uniswap-V3-स्टाइल पूल नहीं है)। यह NFT कोलैटरल और कम वॉल्यूम वाले टोकन के लिए सामान्य है।

  डिफ़ॉल्ट के समय क्या होता है:

  - लेंडर को बाजार मूल्य की परवाह किए बिना **पूरा कोलैटरल** इन-काइंड प्राप्त होता है।
  - "देय राशि" और "शेष" के बीच कोई बँटवारा नहीं होता — ओरेकल मूल्य निर्धारण लागू नहीं किया जा सकता।
  - एसेट की कीमत देय राशि से काफी अधिक या कम हो सकती है। पुनर्विक्रय (resaleability) पर कोई वारंटी नहीं है।

  ऑफ़र बनाए जाने पर दोनों पक्षों ने इसके लिए सहमति दी थी — Risk Disclosures का इलिक्विड-एसेट क्लॉज ठीक इसी मामले को कवर करता है। आप इस शाखा तक तब तक नहीं पहुँच सकते जब तक कि दोनों पक्षों ने जानबूझकर इलिक्विड एसेट से जुड़ा लोन नहीं चुना हो।

  <a id="liquidation-mechanics.why-in-kind"></a>

  ### इन-काइंड (in-kind) क्यों, हमेशा कैश क्यों नहीं?

  तीन कारण हैं कि प्रोटोकॉल हमेशा लेंडिंग एसेट में स्वैप करने के बजाय कोलैटरल एसेट इकाइयों में भुगतान करता है:

  - **Sequencer / DEX आउटेज**: जब प्रोटोकॉल सुरक्षित रूप से स्वैप निष्पादित नहीं कर सकता (slippage > 6%, कम लिक्विडिटी, DEX रिवर्ट, सीक्वेंसर डाउन), तो सबसे सुरक्षित कार्रवाई वह सीधे वितरित करना है जो उसके पास पहले से है — जब्त कोलैटरल। किसी भी कीमत पर स्वैप करने के लिए मजबूर करने से नुकसान हो सकता है।
  - **Black-swan स्थिति**: अस्थिर गिरावट में, ओरेकल-उपलब्ध रास्ता मिनटों के भीतर गायब हो सकता है। इन-काइंड फ़ॉलबैक को पहले से तैयार रखने से प्रोटोकॉल तब भी कार्यात्मक रहता है जब हर प्राइस सोर्स खराब हो।
  - **काउंटरपार्टी-पेयर रिकवरी**: क्लेम के समय लेंडर (या उनका कीपर बॉट) को पूरे 4-DEX फ़ेलओवर पर दूसरा मौका मिलता है। यदि तब तक स्थितियाँ सामान्य हो गई हैं, तो वे उसी रूटिंग इंफ्रास्ट्रक्चर के माध्यम से इन-काइंड कोलैटरल को लेंडिंग एसेट के लिए बेच सकते हैं।

  <a id="liquidation-mechanics.claim-time-retry"></a>

  ### क्लेम-टाइम रिट्राय (Retry)

  `ClaimFacet.claimAsLenderWithRetry` लेंडर (या लेंडर के NFT की ओर से काम करने वाले कीपर) को स्वैप एडेप्टर कॉल (0x → 1inch → Uniswap V3 → Balancer V2) की एक रैंक वाली रिट्राय सूची प्रदान करने की अनुमति देता है जब लोन `FallbackPending` में होता है। लाइब्रेरी सूची को दोहराती है, पहली सफलता पर कमिट करती है, और लेंडर + बॉरोअर क्लेम को प्रिंसिपल-एसेट प्रोसीड्स में बदल देती है।

  पूरी तरह विफल होने पर रिकॉर्ड किया गया कोलैटरल बँटवारा बरकरार रहता है और लोन टर्मिनल रूप से Defaulted में बदल जाता है — जिस बिंदु पर लेंडर इन-काइंड कोलैटरल ले लेता है और उसे किसी भी बाहरी स्थान के माध्यम से बेचने के लिए स्वतंत्र होता है।

  <a id="liquidation-mechanics.internal-match-rescue"></a>

  ### प्री-क्लेम इंटरनल-मैच रेस्क्यू (Rescue)

  किसी भी बाहरी स्वैप के चलने से पहले — HF-liquidation पर, समय-आधारित डिफ़ॉल्ट पर, और क्लेम के समय — प्रोटोकॉल पहले यह जाँचता है कि क्या कोई **विपरीत दिशा वाला लोन** (opposing-direction loan) मौजूद है जो बिना किसी DEX भागीदारी के इसे सेटल कर सके।

  यदि लोन A को USDC के लिए WETH बेचने की ज़रूरत है और लोन B को WETH के लिए USDC बेचने की ज़रूरत है, तो दोनों को सीधे मैच किया जा सकता है: A का कोलैटरल B के कर्ज को कवर करता है और इसके विपरीत, प्रोटोकॉल के ओरेकल मूल्य पर। कोई एग्रीगेटर नहीं, कोई स्लिपेज नहीं, कोई स्वैप शुल्क नहीं। बॉरोअर अपना बहुत अधिक कोलैटरल बचा पाता है; लेंडर को ओरेकल मूल्य पर भुगतान मिल जाता है।

  यह इंटरनल-मैच रास्ता स्वचालित रूप से चलता है:

  - **At HF-liquidation** — जब एक कीपर लिक्विडेट कॉल करता है और एक विपरीत काउंटरपार्टी मौजूद होती है, तो प्रोटोकॉल स्वैपिंग के बजाय आंतरिक रूप से सेटल करता है। कीपर अभी भी मैचर इंसेंटिव कमाता है।
  - **At time-based default** — डिफ़ॉल्ट स्वैप से पहले वही जाँच।
  - **At claim time** — जब एक लेंडर `FallbackPending` में फंसे लोन पर क्लेम करता है, तो प्रोटोकॉल फिर से विपरीत काउंटरपार्टी की जाँच करता है। यह एक वास्तविक दूसरा मौका है: मैच करने योग्य लोन्स का पूल लगातार बढ़ता है, इसलिए एक काउंटरपार्टी जो लिक्विडेशन की पहली विफलता के समय मौजूद नहीं थी, आपके क्लेम करने के समय तक मौजूद हो सकती है।

  एक लोन जो `FallbackPending` में इसलिए पहुँचा क्योंकि उसका लिक्विडेशन स्वैप क्षणिक रूप से विफल हो गया था (स्लिपेज में उछाल, DEX रिवर्ट, पुराना ओरेकल टिक), वह रेस्क्यू का प्रमुख उम्मीदवार है — अंतर्निहित कोलैटरल आमतौर पर अभी भी पूरी तरह से लिक्विड होता है, और एक विपरीत लोन इसे सफाई से साफ़ कर सकता है। प्रोटोकॉल को केवल यह आवश्यकता है कि ओरेकल अभी भी एसेट की कीमत बता सके; इसे DEX में गहराई (depth) की आवश्यकता नहीं है, क्योंकि इंटरनल मैच कभी भी DEX को नहीं छूता है।

  यदि कोई विपरीत काउंटरपार्टी मौजूद नहीं है, तो प्रोटोकॉल ऊपर वर्णित बाहरी-एग्रीगेटर मार्ग पर वापस चला जाता है। इंटरनल-मैच उपलब्ध होने पर एक बेहतर अनुकूलन (optimization) है, कभी भी अवरोधक (blocker) नहीं।

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

## फंसे हुए टोकन (Stuck-Token) की रिकवरी

यह सेक्शन एक ऐसी विशेष स्थिति (EDGE CASE) को कवर करता है जिसकी अधिकांश उपयोगकर्ताओं को कभी आवश्यकता नहीं होगी। नीचे दिए गए रिकवरी लिंक पर क्लिक करने से पहले इसे पूरा पढ़ें — गलत स्रोत की घोषणा करने से प्रोटोकॉल की प्रतिबंध नीति (sanctions policy) के तहत आपका Vault लॉक हो सकता है।

<a id="stuck-recovery.what"></a>

### "फंसा हुआ टोकन" (stuck token) का क्या अर्थ है

आपका Vaipakam Vault प्रॉक्सी आंतरिक प्रोटोकॉल स्टोरेज है। यह कोई डिपॉजिट एड्रेस (deposit address) नहीं है। हर प्रोटोकॉल-समर्थित डिपॉजिट Vaipakam के फ़ैसेट एंट्री पॉइंट्स के माध्यम से होता है, जो ऑफ़र बनाने, लोन स्वीकार करने या स्टेक ऑपरेशन के हिस्से के रूप में आपके वॉलेट से आपके वॉल्ट में फंड खींचते हैं। वे टोकन जो उस फ्लो के बाहर वॉल्ट में पहुँचते हैं — जैसे वॉलेट से सीधे `IERC20.transfer` या CEX विड्रॉल जिसमें आपके वॉल्ट एड्रेस को कॉपी-पेस्ट किया गया हो — वे प्रोटोकॉल बुककीपिंग के बिना वहाँ पड़े रहते हैं। एसेट व्यूअर केवल प्रोटोकॉल-ट्रैक किए गए बैलेंस को दिखाकर उन्हें छिपा देता है।

टोकन दो तरह से फंस सकते हैं:

1. **आपने उन्हें खुद भेजा है।** आपने अपने वॉल्ट एड्रेस को (डैशबोर्ड या ब्लॉक एक्सप्लोरर से) CEX विड्रॉल फ़ील्ड या वॉलेट के सेंड-टोकन फ़ॉर्म में कॉपी किया और सबमिट कर दिया। टोकन प्रोटोकॉल के डिपॉजिट पाथ से गुजरे बिना आपके वॉल्ट में पहुँच गए।

2. **किसी तीसरे पक्ष ने उन्हें भेजा है ("dust attack")।** किसी ने एक फ्लैग्ड वॉलेट (flagged wallet) से आपके वॉल्ट में थोड़ी मात्रा ट्रांसफर की, इस उम्मीद में कि आपका एड्रेस उनकी प्रतिष्ठा के साथ जुड़ जाए। यह बिना अनुमति वाली चेन्स (permissionless chains) पर हाई-प्रोफ़ाइल एड्रेस के खिलाफ एक वास्तविक हमला है।

<a id="stuck-recovery.taint-poisoning"></a>

### "टेंट पॉइजनिंग" (taint poisoning) के बारे में

यदि तीसरा पक्ष भेजने वाला किसी प्रतिबंध सूची (sanctions list) में है, तो सामान्य ऑन-चेन एनालिटिक्स टूल आपके वॉल्ट को "प्रतिबंध-समीप" (sanctions-adjacent) के रूप में फ्लैग कर सकते हैं, भले ही आपने आने वाले टोकन को कभी छुआ न हो। ऑन-चेन इसे पूर्ववत करने का कोई तरीका नहीं है — ट्रांसफर इवेंट स्थायी है। Vaipakam की आंतरिक (INTERNAL) बुककीपिंग अप्रभावित है (हम केवल प्रोटोकॉल-मध्यस्थता वाले डिपॉजिट को ट्रैक करते हैं, धूल/डस्ट हमारे काउंटर में कभी नहीं आती), इसलिए आपके लोन / स्टेक / क्लेम सामान्य रूप से काम करते रहेंगे। लेकिन बाहरी टूल जो हमारे अकाउंटिंग को नहीं समझते हैं, वे चेतावनी दिखा सकते हैं।

<a id="stuck-recovery.dont-recover"></a>

### कब रिकवरी नहीं करनी है

यदि आपने खुद टोकन नहीं भेजे हैं, तो **उन्हें रिकवर न करें**। रिकवर करने के लिए आपको भेजने वाले के एड्रेस की घोषणा करनी होगी। यदि वह एड्रेस प्रतिबंध सूची में है, तो आपका वॉल्ट प्रोटोकॉल की प्रतिबंध नीति के तहत तब तक लॉक हो जाएगा जब तक कि स्रोत को ओरेकल से हटा नहीं दिया जाता।

जो टोकन आपने नहीं भेजे हैं वे आपके नहीं हैं। जिस "क्लीन" एड्रेस के आप वास्तव में मालिक नहीं हैं, उसकी घोषणा करके उन्हें रिकवर करना भी एक बुरा विचार है — प्रोटोकॉल ऑन-चेन घोषणा को सत्यापित नहीं कर सकता, लेकिन बाहरी ओरेकल टूलिंग बाद में असहमत हो सकती है।

सुरक्षित कदम अवांछित डस्ट (dust) को अनदेखा करना है। यह आपके प्रोटोकॉल बैलेंस या किसी सक्रिय लोन/ऑफ़र को प्रभावित नहीं करता है।

<a id="stuck-recovery.when-recover"></a>

### कब रिकवरी करनी है

आपने गलती से खुद टोकन भेजे हैं, आपका सोर्स वॉलेट पर नियंत्रण है, और आप जानते हैं कि सोर्स किसी भी प्रतिबंध सूची में नहीं है (आपका अपना EOA, एक CEX हॉट वॉलेट जिससे आपने विड्रॉल किया था, आदि)।

<a id="stuck-recovery.flow"></a>

### रिकवरी फ्लो (Recovery flow)

1. [रिकवरी पेज](/app/recover) पर जाएं।
2. टोकन कॉन्ट्रैक्ट एड्रेस, वह सोर्स जिससे आपने भेजा था, और राशि दर्ज करें।
3. स्क्रीन पर दी गई पावती (acknowledgment) को ध्यान से पढ़ें।
4. साइनिंग सक्षम करने के लिए "CONFIRM" टाइप करें।
5. अपने वॉलेट में EIP-712 पावती पर साइन करें।
6. ट्रांजेक्शन सबमिट करें।

दो परिणाम संभव हैं:

- **सोर्स क्लीन है** → टोकन आपके EOA में वापस आ जाते हैं।
- **सोर्स फ्लैग्ड है** → टोकन वॉल्ट में ही रहते हैं, और आपका वॉल्ट प्रोटोकॉल की प्रतिबंध नीति के तहत लॉक हो जाता है। यदि एड्रेस को बाद में प्रतिबंध ओरेकल से हटा दिया जाता है, तो लॉक स्वतः हट जाता है।

<a id="stuck-recovery.disown"></a>

### अवांछित टोकन को त्यागना (compliance audit trail)

यदि आप एक सार्वजनिक ऑन-चेन रिकॉर्ड चाहते हैं जो यह पुष्टि करे कि आपके वॉल्ट में कुछ टोकन बैलेंस आपका नहीं है, तो प्रोटोकॉल `disown(token)` फ़ंक्शन प्रदान करता है। यह एक इवेंट (`TokenDisowned`) उत्सर्जित करता है और कुछ भी नहीं बदलता — टोकन पहले की तरह वॉल्ट में ही रहते हैं। यह अनुपालन विवादों (compliance disputes) में उपयोगी है यदि कोई CEX या रेगुलेटर पूछता है "क्या आपको ये फंड मिले?": आप ऑन-चेन इवेंट की ओर इशारा कर सकते हैं।

डिसओन (disown) फ़ंक्शन अभी के लिए केवल सीधे कॉन्ट्रैक्ट कॉल के माध्यम से उपलब्ध है; Vaipakam फ्रंटएंड इसे बटन के रूप में नहीं दिखाता है। इसे कॉल करने के लिए ब्लॉक-एक्सप्लोरर "Write Contract" UI या कॉन्ट्रैक्ट-इंटरैक्शन टूल का उपयोग करें।

