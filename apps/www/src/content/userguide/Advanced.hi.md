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

<a id="chapter.dashboard"></a>

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

Wallet-level opt-in flag, जो आपके VPFI holding को fee discount में
बदल देता है। **Borrower के रूप में** discount, Loan Initiation Fee में
ही सीधी कटौती है जो loan accept होते समय lending asset में ली जाती है;
इसके लिए आपके vault से कुछ नहीं काटा जाता। **Lender के रूप में** yield
discount settlement पर लागू होता है, और यदि VPFI का price reference
कॉन्फ़िगर हो तो उसे आपके vault से VPFI में चुकाया जा सकता है, जिससे पूरी
fee lending asset में आपके पास रह जाती है। Default: off. Off का मतलब है कि आप
हर fee का 100% principal asset में चुकाते हैं; on का मतलब है
कि time-weighted discount लागू होगा।

Tier ladder:

| Tier | Min vault VPFI                         | Discount                          |
| ---- | --------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`                | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`                | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`                | `{liveValue:tier4DiscountBps}`%   |

Tier आपके VPFI deposit या withdraw करते ही **post-change** vault
balance के against calculate होता है। जो rate असल में लगती है, वह
settlement के समय आपके उसी क्षण के tier से तय होती है — हर loan की अपनी
अवधि पर कोई अलग average नहीं लिया जाता। असली सुरक्षा tier में ही है: यह
हाल की एक window — ज़्यादा से ज़्यादा 30 दिन, protocol की एक setting,
और आपकी मौजूदा holding जिस दिन से शुरू हुई उसी से गिनी हुई, जिसमें हाल
के दिनों का वज़न ज़्यादा है — के आपके दैनिक balance का time-weighted
average है। फिर उस average को उस holding के शुरू होने के बाद से आप जिस
सबसे नीचे के tier तक गिरे, वहीं तक घटा दिया जाता है; यह पीछे 30 दिन तक
देखता है।

**ये दो अलग-अलग look-back हैं, और दूसरा आमतौर पर लंबा होता है।**
averaging window configurable है और 30 दिन से कम भी हो सकती है; सबसे
नीचे के tier वाला look-back उससे बंधा नहीं — वह आपकी पूरी मौजूदा holding
पर फैलता है, अधिकतम 30 दिन। इसलिए 14 दिन की averaging window के साथ भी,
20 दिन पहले की गिरावट आपका tier नीचे रखती है, भले ही वह average से बाहर हो।

जब तक आप **लगातार** शून्य से ऊपर का balance कम-से-कम तय दिनों तक hold
नहीं करते, तब तक आपका tier शून्य ही रहता है; यह भी protocol की setting
है। वह घड़ी तब शुरू होती है जब आपका balance शून्य से ऊपर जाता है, और
तभी दोबारा शुरू होती है जब वह वापस शून्य हो जाए — पहले से मौजूद holding
में जोड़ने से वह reset नहीं होती।

इसीलिए withdraw आपके हर खुले loan पर तुरंत असर करता है — कोई grace
window नहीं जहाँ आपका पुराना (ऊँचा) tier जारी रहे। इससे वह exploit
pattern बंद होता है जहाँ कोई user loan खत्म होने से ठीक पहले VPFI top up
करके पूरा-tier discount ले और कुछ seconds बाद withdraw कर ले। ध्यान
दीजिए कि उसे कौन सा नियम बंद करता है: लंबे समय से hold करने वाले ने
minimum period पहले ही पूरा कर लिया है, तो काम सबसे नीचे के tier वाला
नियम करता है — जो एक average नहीं कर सकता, क्योंकि average को देर से
किया गया top up ऊपर खींच सकता है, minimum को नहीं।

उस ख़ास pattern के विरुद्ध मौजूदा नियम दोनों में मज़बूत है। यह **हर
लिहाज़ से** ज़्यादा सख़्त नहीं है: चूँकि सबसे नीचे के tier वाला look-back
अधिकतम 30 दिन पीछे जाता है, किसी लंबे loan के शुरुआती नीचे-tier महीने
आख़िरकार गिनती से बाहर हो जाते हैं, जबकि पूरे loan पर लिया गया average
उन्हें बनाए रखता। इस बदलाव ने थोड़े समय के top up के ख़िलाफ़ बचाव मज़बूत
किया और याददाश्त छोटी कर दी।

**यह lender के yield fee के बारे में है।** Borrower की initiation fee की दर
loan accept होते समय एक बार पढ़ी जाती है; उसके बाद न withdraw से बदलती है, न
top up से।

discount lender के yield fee पर settlement के समय और borrower
की Loan Initiation Fee पर लागू होता है — वहाँ यह **उस fee में
सीधी कटौती** है जो आप lending asset में चुकाते हैं, और यह loan
accept होते समय लागू होती है। वह fee चुकाने के लिए आपके vault से
कोई VPFI नहीं लिया जाता, और बाद में claim करने के लिए कोई rebate
नहीं होता।

> **अगर आप Loan Initiation Fee के rebate का इंतज़ार कर रहे हैं,
> तो यह पढ़ें।** पुराने model में पूरी fee पहले VPFI में ली जाती
> थी, loan की पूरी अवधि तक custody में रखी जाती थी, और claim के
> समय उसका एक हिस्सा लौटाया जाता था। **वह रास्ता हटा दिया गया
> है।** उस रास्ते पर कभी कोई loan खोला ही नहीं गया, इसलिए किसी भी
> loan की initiation fee के बदले कोई VPFI custody में नहीं है और
> कोई rebate बकाया नहीं है — उसका इंतज़ार करना ऐसे पैसे का इंतज़ार
> करना होगा जो आ ही नहीं सकता।

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

यह summary card connected wallet की VPFI rewards picture को एक
ही view में दिखाता है। headline figure pending interaction
rewards और lifetime-claimed interaction rewards का योग है।

breakdown row pending + claimed दिखाती है और अपनी native page
पर पूरी claim card के लिए chevron deep-link देती है:

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
से rewards program नए users को तब तक दिखाई नहीं देगा जब तक वे
Claim Center तक न पहुँचें।

---

<a id="chapter.offer-book"></a>

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
अपना है — gate bypass नहीं किया जा सकता। ब्याज पर `{liveValue:treasuryFeeBps}`% treasury
cut terminal settlement पर debit होती है, upfront नहीं।
यह rate loan बनते समय तय हो जाता है, इसलिए protocol fee में बाद का कोई
बदलाव पहले से खुले loan को उसी rate पर छोड़ देता है जिस पर वह शुरू हुआ था।

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

<a id="chapter.create-offer"></a>

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
  पर `{liveValue:treasuryFeeBps}`% treasury cut के बाद net होती है।
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
  collateral lender को transfer कर देता है और claim करने को कुछ
  भी नहीं बचता।

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
   `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** reference है) और call करने
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
   Fee-enforced collections के लिए, इस step को call करने से पहले
   collection के required OpenSea / creator fee schedule से
   `feeLegs` को populate करें। केवल required, non-zero fee rows
   का उपयोग करें; list को protocol-supported fee-leg count तक
   सीमित करें; प्रत्येक row को chosen ask price पर principal
   asset में absolute fixed amount में convert करें; और listed
   fee recipient को leg recipient के रूप में उपयोग करें। यदि
   chosen ask पर एक required fee zero पर round हो जाती है, तो
   ask उस collection के लिए बहुत छोटा है और post प्रयास नहीं
   किया जाना चाहिए। एक empty array pass करना केवल fee-free
   collections के लिए valid है। Fee-enforced collections पर यह
   एक ऐसा order produce कर सकता है जो OpenSea publication में
   fail हो जाता है या marketplace के required consideration shape
   को satisfy नहीं कर सकता।
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
   (`apps/indexer/src/openseaPublish.ts`) endpoint call करने से
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
  fees) को diamond के waterfall में pass करता है। Sale collateral से funded एक repayment है, इसलिए diamond उस net
  amount को ठीक वैसे settle करता है जैसे fill के पल में एक repayment
  करता: loan repaid हो जाता है; lender का due (loan
  `useFullTermInterest = true` के साथ create हुआ हो तो full coupon,
  अन्यथा अब तक accrued interest, plus कोई भी lender yield-fee
  discount) lender के vault में रखा जाता है और ordinary lender claim
  के ज़रिए current lender-position holder को दिया जाता है; treasury को
  उस discount के बाद अपना cut मिलता है; और बाकी current
  borrower-position holder के wallet में भेजा जाता है। यदि बाकी
  उस wallet को नहीं दिया जा सकता, तो उसे hold किया जाता है और Claim Center में
  ordinary borrower claim के ज़रिए दिया जाता है। Lender को sale के
  अंदर कभी payment नहीं होता, इसलिए lender के wallet की कोई बात sale
  को रोक नहीं सकती।

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


<a id="chapter.claim-center"></a>

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
- accrued interest, आपके loan के बनते समय तय हुआ treasury cut
  घटाकर (मौजूदा दर पर बने loans के लिए
  `{liveValue:treasuryFeeBps}`%)। consent on होने पर वह cut आपके
  time-weighted VPFI fee-discount accumulator द्वारा कम होती है।

loan जैसे ही terminal state (Settled, Defaulted, या Liquidated)
तक पहुँचता है, claimable हो जाता है। Lender position NFT उसी
transaction में burn होता है।

<a id="claim-center.claims:borrower"></a>

#### यदि आप borrower हैं

Borrower claim इस आधार पर return करता है कि loan कैसे settle
हुआ:

- **पूरा repayment / preclose / refinance** — आपकी collateral
  basket वापस। इसके साथ कोई Loan Initiation Fee rebate नहीं आता:
  आपका discount acceptance के समय ही fee में से घटा दिया गया था।
- **loan को settle करने वाली prepay sale** — collateral खरीदार को
  जाता है, आपको वापस नहीं। आपको बिक्री मूल्य में से lender का हक,
  treasury कटौती और listing पर लगे seller fees घटाकर मिलता है, जो
  borrower position NFT रखने वाले को चुकाया जाता है।
- **Swap-to-repay** — कर्ज़ चुकाने के लिए आपका collateral बेचा
  जाता है, आपकी तय की हुई सीमा तक। सीमा उदारता से रखें तो कर्ज़ की
  सख़्त ज़रूरत से ज़्यादा भी खर्च हो सकता है; जो खर्च नहीं होता वह
  आपको वापस मिलता है। loan के अपने asset में बचा surplus आम तौर पर
  claim की तरह इंतज़ार करने के बजाय सीधे borrower NFT धारक को
  चुकाया जाता है — बशर्ते वह धारक sanctions freeze में न हो; उस
  स्थिति में वह claim के रूप में रोक लिया जाता है।
- **HF-liquidation या default** — फिर भी देख लें, surplus बचा
  हो सकता है। Liquidator, lender और treasury को चुकाने भर का मूल्य ही लिया
  जाता है, और बाकी आपके claim के रूप में दर्ज होता है। उसका रूप एक ही बात पर टिका है: collateral
  बेचा गया या सौंपा गया। बेचा गया — यानी exchange के ज़रिए बाहर
  भेजा गया — तो बचा हुआ आपको loan के principal asset में मिलता है।
  सौंपा गया, तो जो बचता है वह collateral ही है, आपके vault में
  encumbered। एक से ज़्यादा चीज़ें उसे सौंपती हैं, और इनमें से कोई भी इस पर निर्भर
  नहीं कि loan किस तरह बंद हुआ: liquidator का छूट पर सीधे ले लेना, वह
  close-out जो exchange भेजे जाने के बजाय अंदरूनी तौर पर किसी विपरीत
  position से match हो जाता है, और वह बिक्री जो पूरी ही न हो सकी — वहाँ collateral मिलता है, बशर्ते lender claim करते समय कोई चलने वाला
  quote न लाए — वह लाए तो भुगतान loan के asset में होता है;
  ज़्यादातर claim में कोई quote होता ही नहीं। सामान्य liquidation और समय-आधारित
  default, दोनों exchange तक पहुँचने से पहले वही अंदरूनी match
  आज़माते हैं, इसलिए इन दोनों में से किसी का नतीजा हमेशा एक-सा नहीं
  होता; यही वजह है कि रास्ता नहीं, claim पढ़ना चाहिए। छूट वाला
  रास्ता ज़रूर तय है, पर उल्टी दिशा में: वह न बेचता है न match करता
  है, इसलिए वह हमेशा collateral ही छोड़ता है। आंशिक liquidation तो बंद होना है ही नहीं —
  loan खुला रहता है और कोई claim बनता ही नहीं। अनुमान लगाने के बजाय
  claim देखें। Illiquid asset के default में आम तौर पर पूरी
  basket चली जाती है और कुछ नहीं बचता — इस रास्ते पर यही नियम है, कोई दुर्भाग्यपूर्ण
  नतीजा नहीं।

Borrower position NFT तब burn होता है जब आप claim करते हैं, तब
नहीं जब loan resolve होता है — इसलिए liquidation से बचा surplus
बाद में भी लेने के लिए मौजूद रहता है। पर NFT का बचा रहना अपने आप में
surplus का सबूत नहीं है: अगर liquidation ने कुछ छोड़ा ही नहीं, तो
लेने को कुछ नहीं होता, claim करना अस्वीकार हो जाता है, और NFT फिर भी
रह सकता है। NFT नहीं, claim पढ़ें।

---

<a id="chapter.activity"></a>

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain पर आपके wallet से जुड़ी on-chain events, sliding
block window में protocol logs से live sourced। कोई backend
cache नहीं — हर page load फिर से fetch करता है। Events transaction
hash के हिसाब से group होती हैं ताकि multi-event transactions
(जैसे accept + initiate एक ही block में) साथ रहें। सबसे नई
events पहले। offers, loans, repayments, claims, liquidations,
NFT mints / burns, और VPFI vault deposits / withdrawals दिखाता है।

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI पाना

VPFI freely transferable है। इसे open market पर जहाँ भी वह
trade होता है वहाँ हासिल करें, या bridge करके लाएँ: VPFI एक
Chainlink CCIP cross-chain token है, इसलिए वह official bridge
का उपयोग करके supported chains के बीच move करता है और आप जिस
chain पर bridge करते हैं उसी पर आपके wallet में land करता है।

<a id="buy-vpfi.discount-status"></a>

### आपकी VPFI Discount Status

Live status:

- मौजूदा tier (0 से 4)।
- Vault VPFI balance साथ में अगले tier तक का अंतर।
- मौजूदा tier पर discount प्रतिशत।
- Wallet-level consent flag।

जब तक VPFI deposited रहता है तब तक वह आपके discount tier में
गिना जाता है — नीचे दिए explicit deposit step के अलावा कोई
अलग locking action नहीं है।

<a id="buy-vpfi.deposit"></a>

### अपने vault में VPFI deposit करें

एक explicit deposit step, आपके wallet से उसी chain पर
आपके vault तक। हर chain पर ज़रूरी — canonical पर भी — क्योंकि
vault deposit spec के अनुसार हमेशा explicit user action है।
जिन chains पर Permit2 configured है, app classic approve +
deposit pattern की जगह single-signature path prefer करता है;
यदि उस chain पर Permit2 configured नहीं है, तो यह clean fallback
करता है।

<a id="buy-vpfi.unstake"></a>

### vault से VPFI निकालें

VPFI को अपने vault से अपने wallet में वापस withdraw करें।
कोई approval leg नहीं — protocol vault का owner है और खुद को
debit करता है। withdraw fee-discount rate को नए (कम) balance
पर तुरंत re-stamp करता है, जो आपके हर खुले loan पर लागू होता
है। कोई grace window नहीं जहाँ पुराना tier अभी भी apply हो।

<a id="buy-vpfi.cross-chain-tier"></a>

### आपका VPFI tier chains के बीच कैसे पहुँचता है

आप VPFI को canonical chain, Base, पर अपने vault में रखते हैं, और आपका
tier Base ही तय करता है। जब आप किसी दूसरी chain पर borrow या lend करते
हैं, तो वह chain आपके tier की एक copy लागू करती है। यह copy Base हर उस
deposit, withdrawal या दूसरी action के बाद Chainlink CCIP से भेजता है जो
आपका tier बदलती है।

तीन बातें जानने योग्य:

- **सिर्फ़ समय बीतने से बढ़े tier को पहुँचने के लिए Base पर एक action
  चाहिए।** बिना deposit या withdrawal के जब आपकी holding अवधि पूरी हो
  जाती है या आपका औसत बराबर आ जाता है, तो Base का अपना आँकड़ा तुरंत
  अपडेट हो जाता है। दूसरी chains को यह Base पर आपके अगले deposit या
  withdrawal से पता चलता है, रकम चाहे जितनी हो।
- **कम हुआ tier पहले पहुँचता है।** Protocol कम हुआ tier तुरंत भेजता है
  और बढ़े हुए tier का ख़र्च हर chain पर दिन में ज़्यादा से ज़्यादा एक
  बार उठाता है। उसके बाद CCIP से पहुँचने में आम तौर पर कुछ मिनट लगते
  हैं। पहुँचने तक वह chain आपका पिछला tier ही लागू करती रहती है।
- **Copy पुरानी पड़ सकती है।** 60 दिन (default) तक कोई नई copy न आए,
  या tier table का कोई बदलाव उस chain तक पहुँच जाए, तो पुरानी copy पर
  वहाँ कोई discount नहीं मिलता। नई copy तभी भेजी जाती है जब आपका tier
  बदलता है।

पूरे नियम, जिनमें वह discount switch भी शामिल है जो आपकी इस्तेमाल की
chain के साथ Base पर भी चालू होना चाहिए, नीचे "VPFI Discount कैसे काम
करते हैं" chapter में हैं। Delivery का design
[tier delivery design document](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
(अंग्रेज़ी में) में है।

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards के बारे में

**Interaction pool** एक fixed daily emission का per-day
pro-rata हिस्सा देता है, उस दिन के loan volume में आपके
settled-interest contribution से weighted। Daily windows
window close के बाद पहले claim या settlement पर lazily
finalise होती हैं।

Rewards सीधे active chain पर mint होते हैं — user के लिए कोई
cross-chain round-trip नहीं। Cross-chain reward aggregation
केवल protocol contracts के बीच होती है।

<a id="rewards.claim"></a>

### Rewards Claim करें

एक ही transaction आपके accrued rewards को claim करती है।
Interaction rewards तब तक zero रहते हैं जब तक relevant daily
window finalise नहीं होती (lazy finalisation, जो उस chain पर
अगले non-zero claim या settlement से trigger होती है)। window
अभी finalise हो रही हो तो UI button guard करता है, ताकि users
under-claim न करें।

<a id="rewards.withdraw-staked"></a>

### vault से VPFI withdraw करें

VPFI section के "vault से VPFI निकालें" जैसा ही interface
— vault से VPFI को आपके wallet में वापस withdraw करें। निकला
हुआ VPFI तुरंत discount accumulator से बाहर हो जाता है (हर खुले
loan पर post-balance re-stamp)।

---

<a id="chapter.loan-details"></a>

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
collateral lender को transfer कर देता है और claim करने के लिए कुछ
नहीं बचता।

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
  interest लौटाता है, आपके loan के बनते समय तय हुआ treasury cut
  घटाकर (मौजूदा दर पर बने loans के लिए
  `{liveValue:treasuryFeeBps}`%; consent on होने पर time-weighted
  VPFI yield-fee discount से और कम)। Lender
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
  settlement trigger करता है।
- **Preclose direct** — अपने wallet से अभी outstanding amount
  चुकाएँ और collateral release करें।
- **Preclose offset** — protocol के swap router के ज़रिए
  collateral का कुछ हिस्सा बेचें, proceeds से चुकाएँ, और बाक़ी
  वापस लौटाएँ। दो-step: initiate, फिर complete।
- **Refinance** — नई terms के लिए borrower offer पोस्ट करें;
  एक बार lender accept कर ले, complete refinance loans को
  atomic रूप से swap कर देता है, आपका collateral आपके vault
  से कभी बाहर नहीं जाता।
- **Claim as borrower** — सिर्फ़ terminal states में। पूरे repayment पर
  collateral लौटाता है; default / liquidation पर भी surplus बच
  सकता है, क्योंकि collateral में से उतना ही लिया जाता है जितना
  कर्ज़ और उसे बंद करने की लागत माँगे — ऊपर का Claim Center भाग
  देखें। Borrower position NFT को burn करता है।

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
Transaction या तो पूरी तरह succeed होती है (loan repaid के रूप में बंद, NFT
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

<a id="chapter.how-liquidation-actually-works"></a>

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

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics के बारे में

बिना वॉलेट वाला, एक चेन का पेज: यह वही चेन पढ़ता है जिस पर ऐप
है (वॉलेट कनेक्ट न हो तो डिफ़ॉल्ट रीड चेन)। कोई क्रॉस-चेन जोड़ या
एक्सपोर्ट नहीं है; चेन की तुलना के लिए हर चेन पर पेज खोलें। दो
स्रोत, जहाँ इस्तेमाल हों वहाँ चिह्नित:

- इंडेक्सर का बिना कुंजी, खुले CORS वाला रीड API — लोन, ऑफ़र,
  रीसाइक्लिंग और लूप-क्लोज़र के आँकड़े;
- सार्वजनिक RPC पर Diamond के अपने व्यू फ़ंक्शन — VPFI टोकन और
  शुल्क के आँकड़े।

पेज जो दिखाता है उसे दोहराने के लिए किसी भी स्रोत से सीधे पूछा जा
सकता है।

<a id="public-dashboard.loans-offers"></a>

### लोन और ऑफ़र

`/loans/stats` से स्थिति के अनुसार लोन काउंटर, जिनमें सेटलमेंट
लंबित, आंतरिक रूप से मैच हुए और शेष की श्रेणियाँ भी हैं, ताकि हिस्से
कुल के बराबर हों; ERC-20 और NFT किराये के उप-योग, जिनमें ऐसा कोई भी
सक्रिय लोन अलग से बताया जाता है जिसका एसेट प्रकार अभी पढ़ा नहीं
गया; और `/offers/stats` से ऑफ़र काउंटर। ऑफ़र केवल `offers` तालिका
हैं — बिना गैस वाले साइन किए ऑर्डर नहीं गिने जाते — और रद्द ऑफ़र
इंडेक्स से हट जाते हैं, इसलिए ऑफ़र का कुल अब तक का आँकड़ा नहीं है।
अनुपस्थित काउंटर "रिपोर्ट नहीं हुआ" दिखाता है और असंभव काउंटर
"रिपोर्ट हुआ, पर उपयोग योग्य गिनती नहीं"; कोई भी 0 नहीं दिखता।

<a id="public-dashboard.recycling"></a>

### रीसाइक्लिंग खाता और लूप क्लोज़र

रीसाइक्लिंग खाता (`/metrics/recycling`) प्रोग्राम के हर दिन का
पूल, उसकी फ़ंडिंग और निकासी दिखाता है, प्रोग्राम के अपने दिन-क्रमांक
से चिह्नित; अंतिम न हुआ दिन बिना पूल के दिखता है और सक्रिय न किया
गया दिन अनुमान के रूप में चिह्नित होता है। लूप क्लोज़र
(`/metrics/loop-closure`) हर UTC दिन के लिए दिखाता है कि क्लेम ने
क्या दिया, वॉल्ट में क्या रहा और क्या वापस समाहित हुआ, उस क्षण के
सापेक्ष जहाँ तक रिकॉर्ड पहुँचता है। दिखाई जाने वाली सटीकता से कम
धनात्मक राशियाँ चिह्नित होती हैं, हिस्से नीचे की ओर पूर्णांकित
होते हैं, और अज्ञात आँकड़ा कभी शून्य नहीं दिखता।

<a id="public-dashboard.transparency"></a>

### पारदर्शिता और स्रोत

एक्सप्लोरर लिंक के साथ Diamond का पता, चेन, और इंडेक्सर कर्सर का
ब्लॉक और उम्र। इंडेक्सर का हर आँकड़ा उतना ही ताज़ा है जितना वह
कर्सर, उससे ज़्यादा नहीं; दो प्रतिक्रियाएँ मिलाने पर पुराना कर्सर
बताया जाता है।

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI टोकन

Diamond पर `getVPFISnapshot()` से: इस चेन पर टोकन का पता और
`totalSupply`। कैनॉनिकल चेन पर सीमा, गुंजाइश (`cap − totalSupply`,
यानी अभी और कितना मिंट हो सकता है) और मिंटर भी। मिरर चेन पर
स्नैपशॉट में न सीमा होती है न मिंटर — वहाँ आपूर्ति CCIP टोकन पूल
से आती है — इसलिए पेज स्थानीय आपूर्ति दिखाता है और बताता है कि सीमा
और मिंटर कैनॉनिकल चेन के हैं, शून्य दिखाने के बजाय। बिना बँधा टोकन
और न पढ़ा जा सका स्नैपशॉट अलग-अलग बताए जाते हैं।

<a id="public-dashboard.fees"></a>

### शुल्क और ट्रेज़री

`getTreasuryMetrics()`, `getTreasury()` और `getNumeraireSymbol()`
से, स्नैपशॉट वाले उसी Multicall3 एग्रीगेट में पढ़े गए और एक ब्लॉक
पर स्थिर, जिसे पेज उसकी उम्र के साथ बताता है:

- शुल्क बही शुरू होने से अब तक, और पिछले 24 घंटे और 7 दिन के
  शुल्क, हर एक दर्ज होते समय न्यूमेरेयर में आँका गया और फिर कभी
  दोबारा नहीं आँका गया;
- जिस शुल्क को प्रोटोकॉल दर्ज करते समय नहीं आँक सका, वह 0 दर्ज होता
  है, और विंडो के योग अधिकतम पिछली 10,000 प्रविष्टियाँ पढ़ते हैं —
  दोनों केवल आँकड़ा घटा सकते हैं, और पेज यह बताता है;
- न्यूमेरेयर बदलने पर पहले की प्रविष्टियाँ पुरानी इकाई में रहती हैं,
  इसलिए उसके बाद योग मौजूदा प्रतीक के नीचे दो इकाइयों की राशियाँ
  जोड़ते हैं और किसी भी दिशा में गलत हो सकते हैं; पेज बताता है कि
  पहले के शुल्क पुरानी इकाई में गिने गए हैं;
- ट्रेज़री पता। अगर यह बाहरी पता है, तो शुल्क वसूली पर ही निकल
  जाते हैं और इसका कोई बैलेंस नहीं दिखाया जाता। अगर Diamond खुद
  अपनी ट्रेज़री है, तो रखी गई राशि दिखाई जाती है, जिसे केवल खुले
  लोन में दिखने वाले एसेट पर आँका जाता है और जिसमें ट्रेज़री की ओर
  से कहीं और रखी गई राशियाँ भी शामिल हैं।

जो फ़ंक्शन विफल होता है वह "पढ़ा नहीं जा सका" दिखाता है और बाकी को
नहीं छिपाता।

---

<a id="chapter.refinance"></a>

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
3. पुराने loan को repaid mark करता है। उसके position NFTs burn नहीं
   होते: दोनों अपने holders के पास Loan Repaid status के साथ रहते हैं।
   पुराना lender अपने NFT से repayment claim करता है, और पुराना
   borrower NFT receipt के रूप में रहता है।
4. नए position NFTs mint करता है।

यदि नई terms पर HF 1.5 से नीचे होगा तो transaction revert करता है।

---

<a id="chapter.preclose"></a>

## Preclose

यह page सिर्फ़ borrower के लिए है — preclose borrower अपने loan
पर initiate करता है।

<a id="preclose.overview"></a>

### Preclose के बारे में

borrower-driven early termination. दो रास्ते:

- **Direct** — अपने wallet से outstanding amount (principal +
  accrued interest) चुकाएँ और collateral release करें।
- **Offset** — collateral का हिस्सा protocol के 4-DEX swap
  failover के ज़रिए principal asset के लिए बेचने के लिए
  offset initiate करें, proceeds से चुकाने के लिए offset
  complete करें, और बाक़ी collateral आपको वापस।

कोई flat early-close penalty नहीं।

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.stuck-token-recovery"></a>

## फंसे हुए टोकन (Stuck-Token) की रिकवरी

यह सेक्शन एक ऐसी विशेष स्थिति (EDGE CASE) को कवर करता है जिसकी अधिकांश उपयोगकर्ताओं को कभी आवश्यकता नहीं होगी। नीचे दिए गए रिकवरी लिंक पर क्लिक करने से पहले इसे पूरा पढ़ें — गलत स्रोत की घोषणा करने से प्रोटोकॉल की प्रतिबंध नीति (sanctions policy) के तहत आपका Vault लॉक हो सकता है।

<a id="stuck-recovery.what"></a>

### "फंसा हुआ टोकन" (stuck token) का क्या अर्थ है

आपका Vaipakam Vault प्रॉक्सी आंतरिक प्रोटोकॉल स्टोरेज है। यह कोई डिपॉजिट एड्रेस (deposit address) नहीं है। हर प्रोटोकॉल-समर्थित डिपॉजिट Vaipakam के फ़ैसेट एंट्री पॉइंट्स के माध्यम से होता है, जो ऑफ़र बनाने, लोन स्वीकार करने या deposit operation के हिस्से के रूप में आपके वॉलेट से आपके वॉल्ट में फंड खींचते हैं। वे टोकन जो उस फ्लो के बाहर वॉल्ट में पहुँचते हैं — जैसे वॉलेट से सीधे `IERC20.transfer` या CEX विड्रॉल जिसमें आपके वॉल्ट एड्रेस को कॉपी-पेस्ट किया गया हो — वे प्रोटोकॉल बुककीपिंग के बिना वहाँ पड़े रहते हैं। एसेट व्यूअर केवल प्रोटोकॉल-ट्रैक किए गए बैलेंस को दिखाकर उन्हें छिपा देता है।

टोकन दो तरह से फंस सकते हैं:

1. **आपने उन्हें खुद भेजा है।** आपने अपने वॉल्ट एड्रेस को (डैशबोर्ड या ब्लॉक एक्सप्लोरर से) CEX विड्रॉल फ़ील्ड या वॉलेट के सेंड-टोकन फ़ॉर्म में कॉपी किया और सबमिट कर दिया। टोकन प्रोटोकॉल के डिपॉजिट पाथ से गुजरे बिना आपके वॉल्ट में पहुँच गए।

2. **किसी तीसरे पक्ष ने उन्हें भेजा है ("dust attack")।** किसी ने एक फ्लैग्ड वॉलेट (flagged wallet) से आपके वॉल्ट में थोड़ी मात्रा ट्रांसफर की, इस उम्मीद में कि आपका एड्रेस उनकी प्रतिष्ठा के साथ जुड़ जाए। यह बिना अनुमति वाली चेन्स (permissionless chains) पर हाई-प्रोफ़ाइल एड्रेस के खिलाफ एक वास्तविक हमला है।

<a id="stuck-recovery.taint-poisoning"></a>

### "टेंट पॉइजनिंग" (taint poisoning) के बारे में

यदि तीसरा पक्ष भेजने वाला किसी प्रतिबंध सूची (sanctions list) में है, तो सामान्य ऑन-चेन एनालिटिक्स टूल आपके वॉल्ट को "प्रतिबंध-समीप" (sanctions-adjacent) के रूप में फ्लैग कर सकते हैं, भले ही आपने आने वाले टोकन को कभी छुआ न हो। ऑन-चेन इसे पूर्ववत करने का कोई तरीका नहीं है — ट्रांसफर इवेंट स्थायी है। Vaipakam की आंतरिक (INTERNAL) बुककीपिंग अप्रभावित है (हम केवल प्रोटोकॉल-मध्यस्थता वाले डिपॉजिट को ट्रैक करते हैं, धूल/डस्ट हमारे काउंटर में कभी नहीं आती), इसलिए आपके लोन / deposits / क्लेम सामान्य रूप से काम करते रहेंगे। लेकिन बाहरी टूल जो हमारे अकाउंटिंग को नहीं समझते हैं, वे चेतावनी दिखा सकते हैं।

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

1. [रिकवरी पेज](https://defi.vaipakam.com/recover) पर जाएं।
2. टोकन कॉन्ट्रैक्ट एड्रेस, वह सोर्स जिससे आपने भेजा था, और राशि दर्ज करें।
3. स्क्रीन पर दी गई पावती (acknowledgment) को ध्यान से पढ़ें।
4. साइनिंग सक्षम करने के लिए "CONFIRM" टाइप करें।
5. अपने वॉलेट में EIP-712 पावती पर साइन करें।
6. ट्रांजेक्शन सबमिट करें।

दो परिणाम संभव हैं:

- **सोर्स क्लीन है** → टोकन आपके वॉल्ट के दर्ज बैलेंस में जोड़ दिए जाते हैं। उन्हें हमेशा की तरह वॉल्ट से निकालें; यदि संरक्षित खाता मोड चालू है, तो उसका भुगतान विलंब लागू होता है।
- **सोर्स फ्लैग्ड है** → टोकन वॉल्ट में ही रहते हैं, और आपका वॉल्ट प्रोटोकॉल की प्रतिबंध नीति के तहत लॉक हो जाता है। यदि एड्रेस को बाद में प्रतिबंध ओरेकल से हटा दिया जाता है, तो लॉक स्वतः हट जाता है।

<a id="stuck-recovery.disown"></a>

### अवांछित टोकन को त्यागना (compliance audit trail)

यदि आप एक सार्वजनिक ऑन-चेन रिकॉर्ड चाहते हैं जो यह पुष्टि करे कि आपके वॉल्ट में कुछ टोकन बैलेंस आपका नहीं है, तो प्रोटोकॉल `disownUntracked(kind, asset, tokenId)` फ़ंक्शन प्रदान करता है। यह एक इवेंट (`UntrackedDisowned`) उत्सर्जित करता है और कुछ भी नहीं बदलता — टोकन पहले की तरह वॉल्ट में ही रहते हैं। यह अनुपालन विवादों (compliance disputes) में उपयोगी है यदि कोई CEX या रेगुलेटर पूछता है "क्या आपको ये फंड मिले?": आप ऑन-चेन इवेंट की ओर इशारा कर सकते हैं।

डिसओन (disown) फ़ंक्शन अभी के लिए केवल सीधे कॉन्ट्रैक्ट कॉल के माध्यम से उपलब्ध है; Vaipakam फ्रंटएंड इसे बटन के रूप में नहीं दिखाता है। इसे कॉल करने के लिए ब्लॉक-एक्सप्लोरर "Write Contract" UI या कॉन्ट्रैक्ट-इंटरैक्शन टूल का उपयोग करें।

<a id="chapter.how-vpfi-discounts-work"></a>

## VPFI Discount कैसे काम करते हैं

Canonical chain, Base, पर आपके vault में रखा VPFI आपको protocol की अपनी
fees पर discount दिलाता है, उन सभी chains पर जहाँ platform चलता है। आप
जितना ज़्यादा और जितने लंबे समय तक रखते हैं, आपका tier उतना ऊँचा और
discount उतना बड़ा होता है। Tiers ऊपर दिए
[Tier ladder](#dashboard.fee-discount-consent) में हैं; governance इन्हें
बदल सकता है।

Discount किस पर लगता है:

- **Lender के रूप में**, उस yield fee पर जो protocol आपके कमाए ब्याज से
  रखता है। यह हर बार ब्याज settle होने पर पढ़ा जाता है, जैसे repayment,
  preclose या refinance पर, उस समय के आपके tier से, न कि loan शुरू होने
  के समय के tier से।
- **Borrower के रूप में**, loan शुरू होने पर लगने वाली Loan Initiation
  Fee पर। यह accept के समय सिर्फ़ एक बार पढ़ा जाता है और उस loan के साथ
  तय रहता है। यह तभी लागू होता है जब lending asset liquid हो; illiquid
  loan पूरी fee देता है।

Discount fee में से ही, loan के asset में घटा दिया जाता है, और इसके लिए
आपके vault से कोई VPFI बाहर नहीं जाता। एकमात्र अपवाद उस deployment पर
lender का discount है जिसने VPFI का price reference configure किया हो:
वहाँ इसे आपके vault से VPFI में चुकाया जा सकता है। Launch पर ऐसा कोई
configure नहीं है। यह chapter इसी holding discount के बारे में है। एक
अलग paid fee mode, "Full", तब तक बंद रहता है जब तक कोई deployment उसे
चालू न करे।

<a id="vpfi-discounts.turning-on"></a>

### Discount चालू करना

Discount opt-in है। Switch VPFI page पर है, और हर chain का अपना एक switch
है, क्योंकि हर chain अपनी setting ख़ुद रखती है:

- **जिस chain पर fee लगती है**, वहाँ switch चालू होना चाहिए, वरना वह chain
  आपके tier से अलग, पूरी fee लेती है।
- **Base पर** भी switch चालू होना चाहिए, चाहे आप वहाँ कभी borrow या lend
  न करें। जब तक वह बंद है, Base बाकी सभी chains को आपका tier शून्य
  भेजता है।

जब आप Base पर discount बंद करते हैं, तो app तुरंत एक tier update भेजता
है ताकि बाकी सभी chains भी उसे लागू करना बंद कर दें: तब Base उन्हें आपका
tier शून्य भेजता है। अगर यह दूसरा कदम विफल हो, तो page यह बताता है, और
दूसरी chains आपका आख़िरी tier तब तक रखती हैं जब तक कोई नया न भेजा जाए।
किसी दूसरी chain पर इसे बंद करने से सिर्फ़ वही chain बदलती है।

VPFI तब गिना जाता है जब protocol उसे आपके vault में दर्ज करता है: जो आप
VPFI page के ज़रिए deposit करते हैं, और वे VPFI rewards जो protocol आपके
vault में पहुँचाता है। आपके vault के address पर सीधे भेजे गए tokens
protocol track नहीं करता, और वे आपका tier नहीं बढ़ाते।

<a id="vpfi-discounts.tier-calculation"></a>

### आपका tier कैसे तय होता है

आपका tier तीन अलग-अलग जाँचों से आता है, और तीनों पास होनी चाहिए:

1. **न्यूनतम holding अवधि।** जब तक आपकी मौजूदा holding कम से कम 3 दिन
   न चल जाए, आपका tier शून्य रहता है। Holding उस पल शुरू होती है जब
   आपका vault balance शून्य से ऊपर जाता है, और तब तक चलती है जब तक वह
   फिर शून्य न हो जाए। और जोड़ने से घड़ी दोबारा शुरू नहीं होती; सब
   निकाल लेने से होती है। (3 दिन default है; governance इसे 2 से 14
   दिन के बीच रख सकता है।)
2. **हाल के दिनों को ज़्यादा वज़न देने वाला औसत।** आपके balance का औसत
   पिछले 30 दिनों पर लिया जाता है, जिसमें आख़िरी 7 दिन पहले के दिनों से
   तीन गुना गिने जाते हैं। औसत आपकी मौजूदा holding शुरू होने से पहले
   तक कभी नहीं जाता, इसलिए नए holder का औसत उन दिनों से कम नहीं होता
   जब उसके पास कुछ नहीं था। (Window, हाल के दिन और वज़न governance
   settings हैं; window 14 से 30 दिन तक हो सकती है।)
3. **अब तक छुआ गया सबसे निचला tier।** औसत से अलग, आपका tier उस सबसे
   निचले tier से ऊपर नहीं हो सकता जिस तक मौजूदा holding के दौरान आपका
   balance पहुँचा, अधिकतम 30 दिन पीछे देखते हुए। हर दिन का सबसे निचला
   बिंदु गिना जाता है, इसलिए एक ही दिन में गिरकर वापस आना भी गिरावट ही
   माना जाता है।

व्यवहार में इसका मतलब:

- Loan settle होने से ठीक पहले deposit करने से आपका tier तुरंत नहीं
  बढ़ता। जोड़ी गई रकम को पहले औसत में आना होता है, और आपका छुआ हुआ सबसे
  निचला बिंदु अब भी सीमा रहता है।
- जो withdrawal आपको किसी tier की सीमा से नीचे ले जाए, वह आपका tier
  तुरंत घटा देता है।
- 30 दिन से पुरानी गिरावट अब आपको सीमित नहीं करती।

<a id="vpfi-discounts.other-chains"></a>

### दूसरी chains पर आपका tier

आपका tier Base तय करता है। बाकी सभी chains उसकी वह copy लागू करती हैं जो
Base Chainlink CCIP से भेजता है। Base आपका tier record तब update करता है
जब Base पर इनमें से कुछ होता है: VPFI आपके vault में आता है या उससे
निकलता है (deposit, withdrawal, या उसमें पहुँचाए गए rewards); कोई loan
शुरू होता है जिसमें आप lender या borrower हैं; loan का कोई कदम आपका VPFI
रोकता या छोड़ता है; या आप tier-refresh call करते हैं। हर update के बाद,
अगर copy बदलती, तो बाकी chains को नई copy भेजी जाती है।

हर chain को अलग से भेजा जाता है। जिस chain तक पहुँचा न जा सके, वह
दूसरों को नहीं रोकती, और **जो delivery निकल न सके, वह आपकी अपनी action
को कभी विफल नहीं करती**: Base पर आपका tier तुरंत अपडेट होता है, और हर
दूसरी chain पर update पहुँचने तक बकाया रहता है।

इन deliveries का ख़र्च protocol उठाता है, एक सीमा के साथ:

- **कम हुआ tier** तुरंत भेजा जाता है, जब तक budget उसका ख़र्च उठा सके।
  पहुँचने तक वह chain आपका पिछला, ऊँचा tier लागू करती रहती है।
- **बढ़ा हुआ tier**, या tier table में बदलाव, हर chain पर दिन में
  ज़्यादा से ज़्यादा एक बार भुगतान पाता है (1 घंटे से 7 दिन के बीच की
  governance setting)। तब तक वह chain आपका पिछला tier रखती है।
- इस प्रतीक्षा के कारण रुका update, या जिसे budget चुका नहीं सका,
  **प्रतीक्षा ख़त्म होने पर अपने-आप दोबारा नहीं भेजा जाता**। वह Base पर
  आपके tier record के अगले update के साथ जाता है, या तब जब कोई आपके लिए
  delivery call करता है।
- यह call कोई भी कर सकता है। प्रतीक्षा बीत जाने और budget के चुका सकने पर
  protocol भुगतान करता है; उससे पहले जल्दी पहुँचाने के लिए call करने वाला
  cross-chain fee चुकाता है। Contracts यह call देते हैं; app अभी नहीं देता।

कोई copy गिनी जाना बंद हो जाती है, और उस chain पर कोई discount नहीं
मिलता, जब:

- वह chain की अधिकतम आयु से पुरानी हो (default 60 दिन, कभी 30 से कम
  नहीं); या
- वह उस tier table से पुरानी table से बनी हो जो वह chain अब जानती है।

Copy दोबारा तभी भेजी जाती है जब उसमें कुछ बदलता: आपका tier, उसका
discount, वह कितने समय तक मान्य रहती है, या tier table का version। इसलिए
tier table बदलने के बाद, Base पर आपके tier record का अगला update हर
chain को नई copy भेजता है, भले ही आपका tier वही हो, जब तक वह शून्य न हो।
अगर इनमें से कुछ नहीं बदला, तो जिस chain की copy पुरानी पड़ गई है वह तब
तक कोई discount नहीं देती जब तक कुछ न बदले।

अगर आपका tier सिर्फ़ समय बीतने से बढ़ा है — holding अवधि पूरी हो गई या
औसत बराबर आ गया — तो Base को आपके tier record के अगले update तक इसका पता
नहीं चलता। Tier-refresh call से आप जब चाहें यह update कर सकते हैं; app
इसे आपकी ओर से सिर्फ़ तब करता है जब आप discount बंद करते हैं।

<a id="vpfi-discounts.operators"></a>

### Operators के लिए

Discount के cross-chain हिस्से को यह configuration चाहिए। यह उन लोगों के
लिए यहाँ दिया गया है जो अपना deployment चलाते हैं।

**Base पर:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`। इसके बिना Base tier तय
  करता है लेकिन उन्हें कहीं नहीं भेजता।
- `VaipakamRewardMessenger` की ओर इशारा करता
  `RewardReporterFacet.setRewardMessenger`, और messenger का
  `setBroadcastDestinations` जिसमें बाकी सभी chains हों।
- Fund किया हुआ broadcast budget:
  `ProtocolBroadcastFacet.topUpBroadcastBudget()` (payable)। ख़ाली budget
  कुछ नहीं रोकता। जिस delivery का ख़र्च वह न उठा सके, वह बकाया रहती है
  और कारण के साथ `TierPushDeferred` emit करती है, और
  `getTierPushStatus(user)` किसी user के लिए हर chain की स्थिति दिखाता
  है। कम budget का मतलब है कि दूसरी chains पुराने tiers ज़्यादा देर तक
  लागू करेंगी, इसलिए deferrals पर नज़र रखें और top up करें।
- Paid बढ़ोतरी की spacing window: `setTierPushSpacingSec` (default 1 दिन,
  1 घंटे से 7 दिन)।

**हर दूसरी chain पर:**

- `RewardReporterFacet.setRewardMessenger(addr)`: वह अकेला sender जिसके
  tier updates वह chain स्वीकार करती है।
- `RewardReporterFacet.setBaseChainId(chainId)`: Base का EVM chain id
  (mainnet पर 8453, Base Sepolia पर 84532), उसका CCIP chain selector
  नहीं।
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: copy कितनी देर तक गिनी
  जाती है (default 60 दिन; 30 दिन से कम मान अस्वीकार होते हैं)। इसे घटाना
  अगली read से लागू होता है।

**Tier table बदलना:**

- Base पर `setVpfiTierThresholds` और `setVpfiTierDiscountBps` table का
  version आगे बढ़ाते हैं। दूसरी chain को नया version उस पहले tier update
  से पता चलता है जिसमें वह हो, चाहे वह किसी भी user का हो। तब से पुरानी
  table से बनी हर copy उस user का अपना update पहुँचने तक बिना discount
  के मानी जाती है, और ये updates बढ़ोतरी हैं जिनका भुगतान हर spacing
  window में ज़्यादा से ज़्यादा एक बार होता है। Table बदलने से पहले
  budget भर दें।
- `setTwaMinStakedDays` version आगे बढ़ाए बिना न्यूनतम holding अवधि बदलता
  है। यह अगली read से लागू होता है।

<a id="chapter.next-app"></a>

## अगला ऐप

Vaipakam ऐप का अगला संस्करण मौजूदा ऐप के साथ-साथ, एक-एक पेज करके
बन रहा है। जो पेज अभी नहीं बना, वह यह बताता है और उसे चलाने वाले
मौजूदा ऐप से जोड़ता है। बने हुए पेज का हर आँकड़ा chain से पढ़ा जाता
है और अपना स्रोत बताता है; जो आँकड़ा पढ़ा न जा सके, वह अज्ञात
दिखाया जाता है, शून्य कभी नहीं।

<a id="advanced-mode"></a>

### Basic और Advanced

Basic वे क्षमताएँ दिखाता है जिनकी ज़्यादातर लोगों को ज़रूरत होती
है। Advanced exit और settlement के टूल, automation, signed orders,
keeper की स्थिति और हिसाब-किताब का विवरण जोड़ता है। मोड आपके
browser में रखा गया एक display विकल्प है: यह बदलता है कि कितना
दिखे, न कि protocol आपको क्या करने देता है, और यह कभी कोई सहमति,
रुकावट या उपाय नहीं छिपाता।

<a id="wallet"></a>

### आपका wallet और आपके आँकड़े कहाँ से आते हैं

आपकी अपनी स्थिति (loans, offers, vault, claims) chain से पढ़ी जाती
है: पहले wallet के provider से, फिर read-only RPC proxy से, फिर
नेटवर्क के public endpoint से। sync पंक्ति उस स्रोत का नाम बताती है
जिसने जवाब दिया, और पेज के सबसे पुराने read की उम्र भी; Refresh सब
दोबारा पढ़ता है। index केवल दुनिया के आँकड़ों (market और history)
के लिए इस्तेमाल होता है, उसकी block height और उम्र के साथ। बिना
सपोर्ट वाले नेटवर्क पर wallet बदलने तक अपना कुछ नहीं देखता।

<a id="deployments"></a>

### deployment क्या-क्या सपोर्ट करता है

ऐप हर chain पर एक Diamond से जुड़ता है और कोई action दिखाने से
पहले loupe के ज़रिए उसके routed selectors पढ़ता है। facet refresh के
बाद यह सेट बदलता है; इसे मान लेने के बजाय पढ़ने से ऐप
`FunctionDoesNotExist` पर असफल होने के बजाय गायब function का नाम
बता सकता है। जब तक सेट पढ़ा न जा सके, कोई signing step नहीं दिखाया
जाता।

<a id="home-start"></a>

### Home: काम चुनना

Home protocol के शब्द से नहीं, काम से शुरू होता है: उधार लेना, उधार
देना, NFT किराए पर लेना, NFT किराए पर देना, या जो आपके पास है उसे
संभालना। उधार लेना और देना मेल खाते offers पर खुलते हैं, वरना अपना
offer डालने की ओर ले जाते हैं। किराया NFT rental के दोनों पक्षों को
कवर करता है, और NFT पूरे समय vault में रहता है। जुड़ा हुआ wallet
तीन छिपाए जा सकने वाले शुरुआती कार्ड भी देखता है; छिपाने का चुनाव
browser में रखा जाता है।

<a id="home-status"></a>

### Home: protocol की स्थिति

Home उस chain पर global pause, automatic pause window और keeper pause
पढ़ता है जिसका वर्णन पेज करता है, और हर हाल में नतीजा बताता है।
global pause नई positions, claims, withdrawals, liquidations, defaults
और keeper द्वारा किया जाने वाला settlement रोक देता है; पूरा और
आंशिक repayment तथा collateral जोड़ना खुले रहते हैं, और pause का समय
हर खुले loan की समय-सीमाओं में जोड़ा जाता है। automatic pause window
अपना अंत-समय दिखाता है; admin pause, अगर हो, उससे लंबा चलता है, और
नया automatic window cooldown के बाद ही खुलता है। keeper pause केवल
वे steps रोकता है जो सेवा आपकी ओर से चलाती है। जो स्थिति पढ़ी न जा
सके, जिसमें पहले के जवाब के बाद असफल हुआ दोबारा-read भी शामिल है,
वह ऊपर अज्ञात के रूप में दिखती है। अलग-अलग assets भी pause हो सकते
हैं; जिन flows को उनकी ज़रूरत है, वे यह बताते हैं।

<a id="home-payouts"></a>

### Home: लेने के लिए तैयार

Home lender और borrower दोनों पक्षों के claimable views को पेज-दर-पेज
देखता है और हर payout को loan और भूमिका से बताता है। यह कोई रकम
नहीं दिखाता: payout एक से अधिक assets में और एक से अधिक रास्तों से
दिया जा सकता है, और हर रकम लेने से पहले Claims पर बताई जाती है।
अगर यह जाँच अंत से पहले रुक जाए, तो Home बताता है कि दिखाए गए से
ज़्यादा हो सकते हैं।

<a id="home-loans"></a>

### Home: आपके loans

हर Active या FallbackPending loan उसकी भूमिका, शर्तों, collateral और
चरण के साथ, ज़रूरत के क्रम में दिखाया जाता है: grace खत्म, grace में,
fallback, समय-सीमा पढ़ी न जा सकी, तीन दिन में देय, चालू। due date और
grace का अंत protocol की loan clock से आते हैं और उनमें pause का समय
पहले से शामिल है, जो शून्य न होने पर दिखाया जाता है। health factor
dashboard view का 1e18-scaled पाठ है; 0 का अर्थ है कोई पाठ नहीं
(बिना price वाला asset, या असफल read), और वैसा ही दिखाया जाता है।
एक ही offer से, एक ही भूमिका में और एक ही ERC-20 में खुले दो या
अधिक loans समूह में दिखते हैं: principal जोड़ा जाता है, दर principal
से भारित और नीचे की ओर पूर्णांकित होती है, और priced loans में सबसे
कम health factor दिखता है, बिना price वालों की गिनती के साथ।

जिस loan में ब्याज समय-समय पर चुकाया जाता है, उसमें due date तक (उस दिन समेत) भुगतान-बिंदु भी होते हैं। किसी भुगतान-बिंदु का grace period खत्म होने पर भी बाकी ब्याज collateral बेचकर चुकाया जा सकता है, और loan खुला रहता है; Home अगला भुगतान-बिंदु दिखाता है और बकाया वाले को सबसे पहले रखता है, चाहे वह due date पर ही पड़े, क्योंकि उसका grace period loan के grace period से पहले खत्म हो सकता है। protocol यह settlement बंद कर सकता है; तब Home बताता है कि भुगतान-बिंदु पर कोई collateral नहीं बेचा जाता।

<a id="home-exposure"></a>

### Home: दिया गया और लिया गया

हर loan का principal protocol के एकमात्र मूल्यांकन नियम से मौजूदा
prices पर numeraire में आँका जाता है: कर्ज़ ऊपर की ओर पूर्णांकित,
आपका दिया loan नीचे की ओर। जिस loan का मूल्य नहीं आँका जा सकता (NFT
या बिना price वाला asset), उसे गिना जाता है, अनुमान नहीं लगाया
जाता। बड़ा पक्ष तभी बताया जाता है जब बिना मूल्य वाले loans जवाब न
बदल सकें; वरना Home आँके गए कुल योग और गिनती दिखाता है।

<a id="home-faucet"></a>

### Home: टेस्ट एसेट

जिस टेस्टनेट का deployment रिकॉर्ड टेस्ट एसेट प्रकाशित करता है, वहाँ Home उन्हें सूचीबद्ध करता है: टेस्ट प्राइस फ़ीड और पूल से जुड़े टेस्ट ERC-20 (लिक्विड), जानबूझकर दोनों के बिना छोड़े गए टोकन (इलिक्विड: उनमें बने लोन की कोई कीमत नहीं होती और डिफ़ॉल्ट वस्तु के रूप में निपटता है), और ERC-4907 रेंटल NFT। मिंट mock टोकन कॉन्ट्रैक्ट को कॉल करता है, Diamond को कभी नहीं: 1,000 पूरे टोकन, या एक नई रैंडम token id वाला एक NFT, जिसकी id वॉलेट खुलने से पहले अनमिंटेड जाँची जाती है। नतीजा बैलेंस या `ownerOf` दोबारा पढ़कर मापा जाता है, और टोकन मिंट के बाद `wallet_watchAsset` पेश किया जाता है। टेस्ट NFT को सिर्फ़ उसका मालिक या मंज़ूर ऑपरेटर ही बर्न कर सकता है।

<a id="home-fee-discount"></a>

### Home: फीस छूट

`setVPFIDiscountConsent` इस चेन के Diamond पर हर वॉलेट का एक फ़्लैग सेट करता है। बंद होने पर होल्ड-टियर छूट 0 है। चालू होने पर, बॉरोअर की लोन इनिशिएशन फीस स्वीकार होते समय लेंडिंग एसेट में घटती है (VPFI प्राइसिंग रास्ता कभी बॉरोअर पाथ का हिस्सा नहीं होता), और लेंडर की यील्ड फीस पर हर सेटलमेंट के समय उस वक़्त लागू प्रभावी टियर से छूट मिलती है। भुगतान का तरीका `getVPFIDiscountConfig` से तय होता है: VPFI दर और उसका रेफ़रेंस एसेट दोनों सेट हों तो छूट वाली फीस लेंडर की वॉल्ट से VPFI में कटती है और लेंडर पूरा ब्याज रखता है; वरना ट्रेज़री फीस ही घट जाती है और कोई VPFI नहीं हिलता। अगर किसी सेटलमेंट पर यह कटौती नहीं हो पाती (कोई ताज़ा भाव नहीं, वॉल्ट में दर्ज मुक्त VPFI कम, या वह VPFI कोलैटरल के रूप में लॉक), तो उस सेटलमेंट की फीस पर कोई होल्ड-टियर छूट नहीं मिलती। कॉल `whenNotPaused` है, इसलिए ग्लोबल पॉज़ इसे दोनों दिशाओं में बंद कर देता है। चालू करना शर्तों से बंधा है, बंद करना नहीं, और दोनों में से कोई भी mirrors को टियर नहीं भेजता। बॉरोअर की छूट तभी लागू होती है जब स्वीकार होते समय लेंडिंग एसेट लिक्विड हो (इलिक्विड लोन पूरी LIF देता है), और हर छूट फीस के 50% तक सीमित है।

<a id="home-rewards"></a>

### Home: रिवॉर्ड

मुख्य आंकड़ा `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)` है, जो क्लेम को Vault गंतव्य के साथ चलाता है और हमेशा revert करता है: `InteractionRewardsSimulation(paid, fromDay, toDay)` सटीक आंकड़ा देता है, और कोई भी दूसरा revert क्लेम का अपना इनकार है (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`), जो नाम से दिखाया जाता है। केवल तब जब कोई भी स्रोत पूर्वावलोकन नहीं चला सकता, Home `previewInteractionRewards` पढ़ता है, जो एक निचली सीमा है, और क्लेम रोक लेता है। शून्य का सटीक आंकड़ा भी पेश किया जाता है: प्रोटोकॉल कुछ न चुकाने वाले क्लेम की अनुमति तभी देता है जब वह उन रिवॉर्ड दिनों से आगे बढ़ता है जिन्होंने कुछ नहीं चुकाया, और Home यह बताता है। Home `claimInteractionRewardsTo(2)` से क्लेम करता है, जो प्रति कॉल अधिकतम `MAX_INTERACTION_CLAIM_DAYS` (30) दिन चुकाता है; जब पूरे हुए क्लेम के ब्लॉक पर या उसके बाद पढ़ा गया पूर्वावलोकन अब भी कोई आंकड़ा देता है, तो Home बाकी पेश करता है। केवल रिवॉर्ड एंट्री से चुकाया गया क्लेम कोई दिन-सीमा नहीं बताता (0 से 0), और Home दिन दिखाने के बजाय यह बताता है। Vault गंतव्य हर खाते के लिए दिया जाता है, कॉन्ट्रैक्ट वॉलेट सहित, क्योंकि Default गंतव्य कॉन्ट्रैक्ट कॉलर को उसके वॉलेट में चुकाता है: वॉल्ट में क्रेडिट होता है, और क्रेडिट पूरा न हो सके (अभी कोई वॉल्ट नहीं) तो वॉलेट में। परिणाम रसीद से पढ़ा जाता है: `InteractionRewardsClaimed` बताता है कि कितना चुकाया गया, और उसी लेन-देन के वॉलेट और `getUserVaultAddress(user)` को गए VPFI `Transfer` लॉग बताते हैं कि वह कहाँ पहुँचा; जब वे चुकाई गई राशि के बराबर नहीं होते, तो गंतव्य अज्ञात बताया जाता है। अब तक का कुल क्लेम नहीं दिखाया जाता: इसके लिए अभी कोई प्रति-उपयोगकर्ता इंडेक्स रूट नहीं है।

<a id="home-rewards-expiry"></a>

### Home: रिवॉर्ड हटने की तारीखें

`ConfigFacet.getRewardClaimHorizonDays()` का 0 होना मतलब होराइज़न बंद है और कोई तारीख नहीं दिखाई जाती। नहीं तो Home `getUserSoonestRewardExpiry(user, offset, 200, 50)` को पेज-दर-पेज, हर पेज एक ही ब्लॉक पर, दस पेज तक पढ़ता है; `nextOffset >= total` होने पर पढ़ना पूरा होता है, और पहले रुकने वाली पढ़ाई को अधूरा बताया जाता है, कभी "कुछ बाकी नहीं" नहीं। अंतिम सूचना सबसे जल्दी वाले अनुमान से 90 दिन के भीतर दिखती है। अनुमान उस ब्लॉक पर एंट्री का `expiresAt` है: जिस समय क्लेम चलाया नहीं जा सकता वह असली हटाव को आगे खिसकाता है, और होराइज़न में गवर्नेंस बदलाव उसे पहले कर सकता है। एंट्री जो रकम हटाएगी वह Home पर नहीं दिखाई जाती।

<a id="home-rewards-held"></a>

### Home: रोके गए रिवॉर्ड

`getSanctionsHeldReward(user)` रोका गया बैलेंस है और `getRewardSanctionsStatus(user)` उसका फ़ैसला (Deliver, Hold या Confirmed)। बैलेंस और Deliver फ़ैसले के साथ Home `claimHeldInteractionRewards(2)` देता है, जो कोई नया बकाया निपटाए बिना ठीक रोका गया बैलेंस देता है और `InteractionRewardsClaimed(user, 0, 0, paid)` एमिट करता है; वॉलेट प्रतिबंधित रहने तक यह `SanctionedAddress` के साथ revert करता है। साइन करने से पहले की जाँच दोनों को फिर पढ़ती है और कॉल को भेजने वाले के रूप में सिम्युलेट करती है। पक्के फ़्लैग के दौरान कमाए गए दिन हमेशा के लिए ज़ब्त हो जाते हैं।

<a id="borrow-start"></a>

### Borrow: यह कैसे काम करता है

Borrow ERC-20 कोलैटरल के बदले ERC-20 के लेंडर ऑफ़र (`offerType` 0) को सीधे `acceptOffer(offerId, terms, signature)` से स्वीकार करता है। एक ट्रांज़ैक्शन में यह उधारकर्ता का वॉल्ट न हो तो खोलता है, कोलैटरल उसमें खींचता है, इनिशिएशन फ़ीस घटाकर प्रिंसिपल वॉलेट को देता है, और `LoanInitiated` उत्सर्जित करता है। उधारकर्ता अनुरोध (`offerType` 1) भी पोस्ट कर सकता है; NFT पक्ष, पेयर सहमतियाँ और एडवांस्ड विकल्प बाद के अपडेट में आएँगे।

<a id="borrow-pair"></a>

### Borrow: टोकन चुनना

हर टोकन की श्रेणी लाइव पढ़ी जाती है: पहले `getAssetPriceStatus(asset)` (Divergent अविश्वसनीय माना जाता है और नए लोन बंद करता है), फिर `checkLiquidityOnActiveNetwork(asset)` (0 लिक्विड, 1 इलिक्विड)। `OraclePriceDivergence` या `OracleCrossCheckDivergence` का revert अविश्वसनीय माना जाता है; कोई और विफलता कारण सहित अपठनीय दिखती है। सुझाई सूची डिप्लॉयमेंट रिकॉर्ड का रैप्ड नेटिव टोकन और टेस्ट टोकन है; पेस्ट किया पता केवल रूप के लिए जाँचा जाता है।

<a id="borrow-offers"></a>

### Borrow: ऑफ़र चुनना

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` पेयर के खुले ऑफ़र id और कुल संख्या देता है। हर एक के लिए पेज `getOffer`, `getOfferState` और वॉलेट होने पर `previewAccept(offerId, wallet)` पढ़ता है, जिसका `errorCode` प्रोटोकॉल का इनकार है। लोन-टू-वैल्यू आज की क़ीमतों पर `calculateLTV` है; इलिक्विड या बिना क़ीमत वाला पक्ष बताता है कि क्यों नहीं है। सीधी स्वीकृति लेंडर का `amountMax` `interestRateBps` पर बाँधती है। उधार अनुरोध, NFT पक्ष वाले और अपने ऑफ़र गिने जाते हैं, सूचीबद्ध नहीं होते।

<a id="borrow-review"></a>

### Borrow: समीक्षा और साइन करना

समीक्षा ऑफ़र, उसकी स्थिति, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, दोनों श्रेणियाँ, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, वॉलेट का वॉल्ट, बैलेंस और मंज़ूरी, `previewOfferAcceptBlock` और डिस्काउंट सहमति पढ़ती है, और वॉलेट खुलने से ठीक पहले फिर पढ़ती है। वॉलेट संग्रहीत ऑफ़र से बना EIP-712 `AcceptTerms` (डोमेन `Vaipakam AcceptOffer`, संस्करण 1) नए 128-बिट nonce और 30 मिनट की समय-सीमा के साथ साइन करता है; इलिक्विड स्वीकारोक्ति केवल उस पक्ष का नाम लेती है जिसे समीक्षा ने इलिक्विड दिखाया। मंज़ूरी कम हो तभी ठीक कोलैटरल जितनी मंज़ूरी आती है, फिर `acceptOffer` सिग्नेचर के साथ सिम्युलेट होकर भेजा जाता है। मंज़ूरी के बाद रुकने पर, अगर किसी और ने उसे नहीं बदला, तो ऐप उसे पिछले मूल्य पर लौटाता है। परिणाम इस ऑफ़र और वॉलेट के लिए `LoanInitiated` और रसीद के `Transfer` लॉग पढ़ता है। पहले वॉलेट संकेत से ठीक पहले अनुमति (allowance) फिर से पढ़ी जाती है, और रीसेट वही मान बहाल करता है; भेजी गई स्वीकृति जो revert हो जाए, या जिसे वॉलेट रद्द कर दे या बदल दे, उसे भी लेनदेन ट्रैकर से वही रीसेट मिलता है। समीक्षा `allowsPartialRepay`, `allowsPrepayListing`, `parallelSaleOrderHash` के साथ `allowsParallelSale`, `refinanceTargetLoanId` और जुड़ा हुआ ऋण बताती है, और देय राशि को बिना विराम वाला मामला बताती है, क्योंकि विराम के दौरान ब्याज बढ़ता रहता है जबकि नियत तारीख खिसकती है। हर अनुमोदन चरण को उसकी रसीद वाले ब्लॉक पर दोबारा पढ़ी गई अनुमति से आँका जाता है, रसीद की स्थिति से कभी नहीं। जो टोकन एक गैर-शून्य अनुमति को दूसरी गैर-शून्य अनुमति में बदलने से मना करता है (यह `approve` के ड्राई रन से पता चलता है), उसके लिए पहले शून्य का एक चरण होता है, जिसे समीक्षा एक अतिरिक्त प्रॉम्प्ट के रूप में गिनती है। वॉलेट खुलने से ठीक पहले शर्तों की स्वीकृति फिर से पढ़ी जाती है। दोनों बिक्री मार्ग संपार्श्विक को NFT के रूप में सूचीबद्ध करते हैं, इसलिए टोकन संपार्श्विक पर दी गई लिस्टिंग या बिक्री की अनुमति को ऐसी अनुमति बताया जाता है जिसका यह ऋण उपयोग नहीं कर सकता।

<a id="borrow-fee"></a>

### Borrow: इनिशिएशन फ़ीस

फ़ीस `previewAccept` का `lifEstimate` है: प्रिंसिपल का `getLoanInitiationFeeBps`, उधार टोकन में, दी गई राशि से कटी हुई, सहमति चालू हो और उधार टोकन लिक्विड हो तो होल्ड-टियर डिस्काउंट से घटी हुई, टियर स्वीकृति के समय तय। यह पेज कभी Full टैरिफ़ नहीं चुनता। फ़ीस के लिए कोई VPFI न लिया जाता है न लौटाया जाता है। भेजने वाले का हिस्सा, फ़ीस का `getLifMatcherFeeBps`, प्रेषक को जाता है, जो सीधी स्वीकृति में उधारकर्ता है, इसलिए वॉलेट को फ़ीस घटाकर प्रिंसिपल और यह हिस्सा मिलता है।

<a id="borrow-risks"></a>

### Borrow: जोखिम

ग्रेस समाप्ति के बाद का लोन (नियत तारीख़ के बाद `getEffectiveGraceSeconds`, जिसे पॉज़ का समय आगे खिसकाता है) कोई भी डिफ़ॉल्ट करवा सकता है: लिक्विड कोलैटरल लेंडर के लिए बेचा जाता है, इलिक्विड जैसा है वैसा ट्रांसफ़र होता है। हेल्थ फ़ैक्टर 1 से नीचे होने पर लिक्विड कोलैटरल लिक्विडेट भी हो सकता है। `useFullTermInterest` जल्दी चुकाने पर पूरी अवधि का ब्याज लेता है; ब्याज शेड्यूल छूटी अवधि को कोलैटरल की ज़बरन बिक्री से निपटाता है।

<a id="borrow-request"></a>

### Borrow: अपना अनुरोध पोस्ट करना

अनुरोध उधारकर्ता के वॉलेट से भेजा गया `createOffer` है, `offerType` 1 के साथ, दोनों पक्ष ERC-20। यह `collateralAmount` को उधारकर्ता के वॉल्ट में ले जाता है, वॉल्ट न हो तो बनाता है, और `OfferCreated(offerId, creator, 1)` जारी करता है। लेंडर इसे `acceptOffer` से स्वीकार करता है: फ़ीस घटाकर मूलधन उधारकर्ता के वॉलेट में जाता है, और फ़ीस में भेजने वाले का हिस्सा उस लेंडर को जाता है जिसने इसे भेजा। `cancelOffer` निर्माता के लिए बनने के `MIN_OFFER_CANCEL_DELAY` (5 मिनट) बाद से खुला है, और अनुरोध समाप्त होने पर किसी के लिए भी; कोलैटरल हमेशा निर्माता को लौटता है।

<a id="borrow-request-terms"></a>

### Borrow: अनुरोध की शर्तें

Basic एकल-मान अनुरोध पोस्ट करता है: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 0, `periodicInterestCadence` 0, `allowsPrepayListing` और `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true। राशियाँ बेस इकाइयों में सटीक बदली जाती हैं और दर अधिकतम 10,000 bps है। `durationDays` की सीमा `getProtocolConfigBundle` से पढ़ा गया कॉन्फ़िगर किया गया अधिकतम है। `expiresAt` 0 है (रद्द होने तक खुला) या समीक्षा खुलते समय नवीनतम ब्लॉक से तय समय, अधिकतम `MAX_OFFER_EXPIRY_HORIZON` (365 दिन) आगे। `useFullTermInterest` डिफ़ॉल्ट रूप से true है और `allowsPartialRepay` false।

<a id="borrow-request-review"></a>

### Borrow: अनुरोध की समीक्षा और पोस्ट करना

समीक्षा वॉलेट से `createOffer` का सिमुलेशन करती है और दोनों वर्ग, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, अधिकतम अवधि, वॉलेट का वॉल्ट, बैलेंस और अलाउंस, और दोनों पक्ष लिक्विड हों तो `calculateLTV` पढ़ती है; हर ब्लॉक और वॉलेट खुलने से ठीक पहले यह फिर पढ़ी जाती है। अलाउंस कम रहने तक सिमुलेशन केवल कोलैटरल खींचने तक पहुँचता है, इसलिए टोकन की खींचने की त्रुटि या बिना प्रोटोकॉल त्रुटि-नाम वाला revert पूरी करनी वाली मंज़ूरी के रूप में दिखता है, और नामित प्रोटोकॉल त्रुटि अस्वीकृति है। सटीक मंज़ूरी के बाद `createOffer` का फिर सिमुलेशन होता है और उसे भेजा जाता है; मंज़ूरी के बाद रुकने पर, अगर कुछ और न बदला हो, अलाउंस पिछले मान पर लौटाया जाता है। परिणाम इस वॉलेट के `OfferCreated` और वॉल्ट में कोलैटरल के `Transfer` से पढ़ा जाता है।

<a id="borrow-nft-collateral"></a>

### Borrow: NFT को कोलैटरल के रूप में

कोलैटरल का स्टैंडर्ड `supportsInterface` से पढ़ा जाता है (ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`); revert को दोनों में से कोई नहीं माना जाता, और विफल रीड पर कोई अनुरोध नहीं दिया जाता। ERC-721 अनुरोध `collateralAssetType` 1, `collateralTokenId` में लिखी गई आईडी, `collateralQuantity` 1 और `collateralAmount` = `collateralAmountMax` = 0 भेजता है; रिस्क पेयर उसी टोकन आईडी से बंधा है। समीक्षा एक ही ब्लॉक पर `ownerOf`, `getApproved` और `isApprovedForAll(wallet, Diamond)` पढ़ती है; किसी और के पास रखा टोकन, या revert करने वाला `ownerOf`, अनुरोध रोकता है। किसी भी मंज़ूरी के बिना ड्राई रन टोकन के `ERC721InsufficientApproval` पर रुकता है, जिसे देने वाली मंज़ूरी के रूप में दिखाया जाता है। मंज़ूरी `approve(Diamond, id)` है, जो तभी गिनी जाती है जब रसीद के ब्लॉक पर `getApproved` Diamond पढ़े; बाद में रुकने पर उसे पिछले पते पर तभी लौटाया जाता है जब वह अब भी Diamond पढ़े और वॉलेट के पास टोकन हो। ERC-721 के लिए `setApprovalForAll` कभी नहीं माँगा जाता। परिणाम `OfferCreated` और टोकन का अपना `Transfer` (चार topics) वॉलेट से वॉल्ट तक पढ़ता है। ERC-1155 अनुरोध `collateralAssetType` 2, टोकन id, लिखी गई मात्रा के रूप में `collateralQuantity` (1 से 2^128−1) और दोनों राशियाँ 0 भेजता है। समीक्षा एक ही ब्लॉक पर `balanceOf(wallet, id)` और `isApprovedForAll(wallet, Diamond)` पढ़ती है; मात्रा से कम बैलेंस अनुरोध रोक देता है, और मंज़ूरी के बिना ड्राई रन `ERC1155MissingApprovalForAll` पर रुकता है। एकमात्र मंज़ूरी `setApprovalForAll(Diamond, true)` है, जो अपनी रसीद के ब्लॉक पर वापस पढ़ी जाने पर गिनी जाती है, और अनुरोध के माइन होने या रुकने के बाद `setApprovalForAll(Diamond, false)` से वापस ली जाती है (मंज़ूरी के ब्लॉक से पहले कभी नहीं पढ़ते हुए), जब तक वॉलेट ने उसे पहले से न दिया हो। परिणाम वॉलेट से वॉल्ट तक टोकन के `TransferSingle`/`TransferBatch` को जोड़ता है। NFT माँगने वाले लेंडर ऑफ़र अब भी मौजूदा ऐप पर जाते हैं।

<a id="borrow-request-range"></a>

### Borrow: सीमा वाला अनुरोध

सीमा `amount` (सबसे छोटी) को `amountMax` (सबसे बड़ी) से कम, `interestRateBps` = `interestRateBpsMax` (एक ही दर), और `collateralAmount` (सबसे छोटे ऋण की न्यूनतम सीमा) को `collateralAmountMax` (पोस्ट करते समय वॉल्ट में लिया जाता है) के बराबर या कम भेजती है; खाली न्यूनतम सीमा दोनों को बराबर भेजती है। सीमाएँ केवल ERC-20 संपार्श्विक के लिए दी जाती हैं। सीधा `acceptOffer` `collateralAmount` के बदले `interestRateBpsMax` पर `amount` उधार देता है और `collateralAmountMax − collateralAmount` वॉलेट में लौटाता है; `getPartialFillEnabled` true रहने तक `matchOffers` दोनों सिरों के बीच भरता है। `createOffer` का ड्राई रन सबसे बड़े सिरे पर ऑफ़र सीमा लागू करता है और `MaxLendingAboveCeiling(provided, ceiling)` से अस्वीकार करता है, जिसकी ऊपरी सीमा समीक्षा दिखाती है। सीधे सिरे की जाँच (`amount`, `collateralAmount`) पर एकल-मान अनुरोध के दूसरे ड्राई रन से होती है; सीमा से पहले रुकने वाला उत्तर अज्ञात बताया जाता है। हर सिरे का ऋण-से-मूल्य `calculateLTV(lending, amount, collateral, collateralAmount)` है, और `ZeroCollateral` को मूल्यहीन संपार्श्विक पढ़ा जाता है। दिखाया गया ऋण-आरंभ हेल्थ फ़ैक्टर `getDepthTieredLtvEnabled` false रहने पर `getMinHealthFactor` है, और true रहने पर 1.0। मैच ऋणदाता की आनुपातिक आवश्यकता लॉक करता है, कोलैटरल रेंज होने पर `collateralAmount` तक बढ़ाकर, वरना आवश्यकता पर ही छोड़कर; इसलिए सबसे बड़ा मैच `collateralAmountMax` और `collateralAmount` दोनों पर दिखाया जाता है (या, कोलैटरल रेंज के बिना, कम लॉक कर सकने वाला); इसे केवल ऋण-आरंभ जाँच सीमित करती है, और उस जाँच को पढ़ने में विफलता बताई जाती है, कभी छोड़ी नहीं जाती। स्तरीकृत व्यवस्था में जाँच स्तर की लोन-टू-वैल्यू सीमा भी लागू करती है। `getPartialFillEnabled` true रहने तक, जो संपार्श्विक मैच लॉक नहीं करता वह बाद के मैचों के लिए वॉल्ट में रहता है और केवल तब लौटाया जाता है जब अनुरोध बंद हो (उसकी शेष क्षमता `amount` से कम हो जाए) या `cancelOffer` चले।

<a id="borrow-request-fill"></a>

### Borrow: अनुरोध का भराई मोड

`fillMode` 0 (Partial), 1 (AON) या 2 (IOC) है और पोस्ट करने के बाद नहीं बदलता। AON के लिए `amount` = `amountMax` चाहिए (`AonRequiresSingleValueAmount`), और IOC के लिए `expiresAt` ≠ 0 चाहिए (`IocRequiresExpiry`); फ़ॉर्म अस्वीकार होने वाला कोई रूप नहीं देता। खुले अनुरोध पर राशियाँ, दर और संपार्श्विक `setOfferAmount`, `setOfferRate`, `setOfferCollateral` और `modifyOffer` से बदले जा सकते हैं, पर कभी `amountFilled` या `collateralAmountFilled` से नीचे नहीं; यह ऐप अभी इन्हें कॉल नहीं करता।

<a id="borrow-request-cadence"></a>

### Borrow: अनुरोध की ब्याज अनुसूची

`periodicInterestCadence` 0 (None) से 4 (Annual) तक होता है, जिनकी अवधियाँ 30, 90, 180 और 365 दिन हैं। फ़ॉर्म वही देता है जिसकी `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` अनुमति देता है; यह वही नियम चलाता है जिसे `createOffer` लागू करता है, `amount` (रेंज के सबसे छोटे सिरे) पर मूल्यांकित। हर अस्वीकृति उसके रिवर्ट डेटा से बताई जाती है: `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid`, या `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`। एक अवधि का ब्याज `principal × rate × intervalDays / (10000 × 365)` है। मोहलत `getEffectiveGraceSeconds(intervalDays − 1)` बीतने के बाद कोई भी `settlePeriodicInterest` से छूटी अवधि का निपटान कर सकता है; इसमें कोलैटरल बिकता है और ऋण खुला रहता है। कीपर पास `periodicSettle` की सक्रियता वैसी दिखाई जाती है जैसी क्षमता सेवा बताती है, डिफ़ॉल्ट रूप से अज्ञात। पोस्ट करने के बाद अनुसूची बदली नहीं जा सकती।

<a id="borrow-request-tariff"></a>

### Borrow: अनुरोध का फुल फ़ीस टैरिफ़

ऑप्ट-इन `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)` है, जिसे निर्माता `createOffer` के बाद भेजता है, और कोई ऋणदाता अनुरोध ले ले तो यह `OfferAlreadyAccepted` से अस्वीकार होता है; `maxCStar` शून्य से अधिक होना चाहिए (`FullTariffMaxCStarRequired`)। फ़ॉर्म स्विच `getFeeEntitlementConfig()` से और टैरिफ़ `quoteCStar(lendingAsset, principal, durationDays)` से दिखाता है, सीमा के लिए `amount` और `amountMax` पर; सीमा का डिफ़ॉल्ट `amountMax` पर का कोट है। हर स्वीकृति पर शुल्क `C*` लेता है, उस ऋण के मूलधन पर आँका गया, केवल तब जब स्विच चालू हो, मूलधन का मूल्य हो और वह तरल हो, `C* ≤ maxCStar` हो, और वॉल्ट का मुक्त VPFI उसे पूरा करे (`getTrackedVPFIBalance` से सीमित वॉल्ट शेष, सक्रिय ग्रहणाधिकार घटाकर, `getFreeBalance` द्वारा); वरना यह `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed` या `FeeEntitlementTariffAboveAuth` से रिवर्ट होता है, जब तक `allowDowngrade` ऋण को इसके बिना खुलने न दे। उधारकर्ता की ऋण शुल्क छूट `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) बढ़ती है, `MAX_FEE_DISCOUNT_BPS` (5000) तक सीमित। समीक्षा ऐसा चुनाव रोकती है जिसमें हर ऋण अस्वीकार होगा, और ऑप्ट-इन `getOffer` दोबारा पढ़कर मापा जाता है (`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`)। अधूरे अनुरोधों के लिए बैकस्टॉप ऋण यह ऐप अभी नहीं देता।

<a id="lend-start"></a>

### Lend: यह कैसे काम करता है

Lend किसी ERC-20 के ERC-20 कोलैटरल वाले उधार अनुरोध (`offerType` 1) को सीधे लेता है, ऋणदाता द्वारा भेजे गए `acceptOffer(offerId, terms, signature)` से। एक ट्रांज़ैक्शन में मूलधन ऋणदाता के वॉलेट से, Diamond को दी गई अनुमति के तहत, ऋणदाता के वॉल्ट में खींचा जाता है; उधारकर्ता को वह इनिशिएशन फ़ीस घटाकर मिलता है; उधारकर्ता के वॉल्ट में पहले से रखा कोलैटरल लोन का कोलैटरल बन जाता है; और `LoanInitiated` जारी होता है, ऋणदाता और उधारकर्ता के एक-एक पोज़िशन NFT के साथ। लेंडिंग ऑफ़र (`offerType` 0) इसी पेज से पोस्ट होता है; NFT पक्ष बाद के अपडेट में आएँगे।

<a id="lend-offers"></a>

### Lend: अनुरोध चुनना

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` जोड़ी के खुले ऑफ़र की ids देता है। हर एक के लिए पेज `getOffer`, `getOfferState`, `getOfferLinkedLoanId` और, वॉलेट होने पर, `previewAccept(offerId, wallet)` पढ़ता है, जिसका `errorCode` प्रोटोकॉल का इनकार है। सीधा लेना अनुरोध के `amount` (उसका न्यूनतम) को `interestRateBpsMax` पर बाँधता है, और लोन-टू-वैल्यू उस राशि पर आज की कीमतों से `calculateLTV` है। ऋणदाता ऑफ़र, NFT पक्ष, पाठक के अपने अनुरोध और ऋणदाता-पोज़िशन बिक्री वाहन (शून्य से भिन्न `getOfferLinkedLoanId` वाला उधारकर्ता-पक्ष ऑफ़र) गिने जाते हैं, सूचीबद्ध नहीं। क्रम: फ़ंड करने योग्य पहले, फिर दर घटते क्रम में, फिर राशि घटते क्रम में।

<a id="lend-review"></a>

### Lend: समीक्षा और साइन करना

समीक्षा वही पढ़ती है जो Borrow की (ऑफ़र, उसकी स्थिति, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, दोनों वर्ग, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, वॉलेट का वॉल्ट, `previewOfferAcceptBlock` और फ़ीस-डिस्काउंट सहमति), साथ में `getTreasuryFeeBps`, और बैलेंस व अनुमति उधार दी गई संपत्ति पर मापती है, वह पक्ष जो ऋणदाता चुकाता है। उसमें कमी साइन रोकती है, वैसे ही ऋणदाता-पोज़िशन बिक्री वाहन भी। वॉलेट EIP-712 `AcceptTerms` (डोमेन `Vaipakam AcceptOffer`, संस्करण 1) साइन करता है, अनुमति कम होने पर ही ठीक मूलधन की अनुमति देता है (ऐसे टोकन के लिए पहले शून्य का चरण जो एक गैर-शून्य मान से दूसरे में बदलाव मना करता है), और `acceptOffer` सिम्युलेट करके भेजा जाता है; रुके हुए फ़्लो से बची अनुमति Borrow की तरह रीसेट होती है। परिणाम इस ऑफ़र के लिए `LoanInitiated`, वॉलेट से मूलधन का `Transfer` और मैचर हिस्से का वापसी `Transfer` पढ़ता है।

<a id="lend-fee"></a>

### Lend: फ़ीस और प्रोटोकॉल का हिस्सा

फ़ीस `previewAccept` का `lifEstimate` है, और यह उधारकर्ता की है: उधार दी गई संपत्ति में मूलधन का `getLoanInitiationFeeBps`, उधारकर्ता को दी जाने वाली राशि से काटा गया, स्वीकृति पर उधारकर्ता के होल्ड-टियर डिस्काउंट से और, जब `creatorFull` सेट हो और शुल्क सफल हो, Full टैरिफ़ बोनस से घटाया गया। भेजने वाले का हिस्सा, फ़ीस का `getLifMatcherFeeBps`, प्रेषक को मिलता है, यहाँ ऋणदाता को। ब्याज में प्रोटोकॉल का हिस्सा `getTreasuryFeeBps` है, हर लोन के लिए खुलते समय तय (`treasuryFeeBpsAtInit`); सहमति चालू होने पर ऋणदाता का होल्ड-टियर डिस्काउंट ब्याज निपटान के समय इसे घटाता है। समीक्षा आज की दर दिखाती है, और उस दर पर हिस्से को ऊपरी सीमा के रूप में।

<a id="lend-risks"></a>

### Lend: जोखिम

ग्रेस के अंत के बाद का लोन (`getEffectiveGraceSeconds` नियत तारीख के बाद, जिसे विराम का समय आगे खिसकाता है) कोई भी डिफ़ॉल्ट कर सकता है: लिक्विड कोलैटरल ऋणदाता के लिए बेचा जाता है, इलिक्विड कोलैटरल जैसा है वैसा स्थानांतरित होता है। दोनों पक्ष लिक्विड हों तो हेल्थ फ़ैक्टर 1 से नीचे होते ही लोन लिक्विडेट हो सकता है, और बिक्री पहले ऋणदाता को चुकाती है। इलिक्विड पक्ष कीमत-आधारित लिक्विडेशन को रोकता है, और डिफ़ॉल्ट पर ऋणदाता को पूरा कोलैटरल मिलता है। `useFullTermInterest` जल्दी चुकाने पर ब्याज की न्यूनतम सीमा लगाता है; इसके बिना ब्याज प्रो-राटा है। आवधिक-ब्याज शेड्यूल छूटी हुई अवधि को कोलैटरल की ज़बरन बिक्री से ऋणदाता को चुकाता है। ऋणदाता का पोज़िशन NFT दावा रखता है: उसे स्थानांतरित करना लोन को स्थानांतरित करना है।

<a id="lend-offer"></a>

### Lend: अपना ऑफ़र पोस्ट करना

लेंडिंग ऑफ़र `offerType` 0 वाला `createOffer` है, दोनों पक्ष ERC-20, जो ऋणदाता के वॉलेट से भेजा जाता है। यह उधार दी गई संपत्ति का `amountMax` ऋणदाता के वॉल्ट में खींचता है, वॉल्ट न हो तो बनाता है, और `OfferCreated(offerId, creator, 0)` जारी करता है। उधारकर्ता इसे `acceptOffer` से स्वीकार करता है: उसका कोलैटरल उसके वॉल्ट में खिंचता है, फ़ीस घटाकर मूलधन उसके वॉलेट में जाता है, और फ़ीस में भेजने वाले का हिस्सा भेजने वाले के रूप में उसे मिलता है। जब तक `getPartialFillEnabled` true है, `matchOffers` इसे किसी उधारकर्ता के अनुरोध से जोड़ भी सकता है; तब एकल-मूल्य वाला लेंडर ऑफ़र अपनी दर पर अपनी पूरी राशि उधार देता है, कम से कम अपने `collateralAmount` के बदले। `cancelOffer` निर्माण के `MIN_OFFER_CANCEL_DELAY` (5 मिनट) बाद से निर्माता के लिए, और ऑफ़र समाप्त होने के बाद किसी के भी लिए खुला है; राशि हमेशा निर्माता को लौटती है।

<a id="lend-offer-terms"></a>

### Lend: ऑफ़र की शर्तें

हिस्सों के बिना लेंडिंग ऑफ़र एकल-मूल्य वाला होता है: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (वह एक कोलैटरल जो उधारकर्ता को लॉक करना है), `fillMode` 0, जब तक Advanced कोई और तय न करे (अगला भाग), `periodicInterestCadence` 0 (जब तक Advanced अनुसूची न तय करे), `allowsPrepayListing` और `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true, और कोई Full टैरिफ़ नहीं (जब तक Advanced इसे न चुने)। राशियाँ ठीक-ठीक बेस यूनिट में पार्स होती हैं और दर अधिकतम 10,000 bps है। `durationDays` की सीमा `getProtocolConfigBundle` से पढ़े गए कॉन्फ़िगर किए अधिकतम से तय होती है। `expiresAt` 0 (रद्द होने तक खुला) या समीक्षा खुलते समय नवीनतम ब्लॉक से तय समय है, अधिकतम `MAX_OFFER_EXPIRY_HORIZON` (365 दिन) आगे। `useFullTermInterest` डिफ़ॉल्ट रूप से true और `allowsPartialRepay` false है।

<a id="lend-offer-parts"></a>

### Lend: हिस्सों में दिया जाने वाला ऑफ़र

हिस्से `amount` (एक मैच द्वारा उधार दिया जा सकने वाला सबसे छोटा हिस्सा) को `amountMax` (पूरी राशि, जिसे `createOffer` वॉल्ट में खींचता है) से कम भेजते हैं; `collateralAmount` = `collateralAmountMax` एकमात्र शर्त बनी रहती है, `amountMax` के लिए (वरना `LenderCollateralRangeNotAllowed`), और `interestRateBps` = `interestRateBpsMax`। लेंडिंग ऑफ़र पर सीधा `acceptOffer` `collateralAmount` के बदले `amountMax` उधार देता है, और केवल तब तक जब तक `amountFilled` 0 है (मैच के बाद `OfferPartiallyFilled`)। जब तक `getPartialFillEnabled` true है, `matchOffers` राशि के ओवरलैप का मध्य बिंदु, कम से कम `amount`, दर के ओवरलैप के मध्य बिंदु पर, कम से कम `collateralAmount × matchAmount ÷ amountMax` (नीचे की ओर पूर्णांकित; उधारकर्ता की कोलैटरल रेंज इसे बढ़ा सकती है) के बदले उधार देता है। जब `amountMax − amountFilled` `amount` से नीचे जाता है, तो बाकी राशि ऋणदाता के वॉलेट में निकाल दी जाती है और ऑफ़र बंद होता है (`OfferClosed`, कारण `Dust` या `FullyFilled`)। आंशिक रूप से भरे ऑफ़र पर `cancelOffer` प्रतीक्षा अवधि छोड़ देता है और `amountMax − amountFilled` लौटाता है। `fillMode` अनुरोध की तरह 0, 1 या 2 है: AON के लिए `amount` = `amountMax` चाहिए, IOC के लिए समाप्ति चाहिए, और पोस्ट करने के बाद यह नहीं बदलता। दोनों पक्ष तरल हों तो `createOffer` `amountMax` पर न्यूनतम सीमा से कम `collateralAmount` को `MinCollateralBelowFloor(provided, floor)` से अस्वीकार करता है, जिसकी सीमा समीक्षा दिखाती है। एक ही लोन-टू-वैल्यू दिखाया जाता है, (`amountMax`, `collateralAmount`) पर `calculateLTV`: पूर्णांकन को छोड़कर हर हिस्से का अनुपात वही है।

<a id="lend-offer-schedule"></a>

### Lend: ऑफ़र पर ब्याज की अनुसूची

लेंडिंग ऑफ़र का `periodicInterestCadence` अनुरोध के नियम (ऊपर) का पालन करता है, और `previewCadenceAdmission` ऑफ़र के `amount` पर आँका जाता है: उसका सबसे छोटा हिस्सा, या हिस्सों के बिना पूरी राशि। `createOffer` उसे वहीं `requireCadenceAdmitted` से स्वीकार करता है, और हर ऋण की शुरुआत उसके अपने मूलधन को फिर जाँचती है (`requireOriginationCadenceAdmitted`)। समीक्षा एक अवधि का ब्याज `amountMax` (सीधा लेना) पर और हिस्सों के साथ `amount` पर बताती है। छूटी अवधि को मोहलत के बाद कोई भी `settlePeriodicInterest` से निपटा सकता है: ऋणदाता को उस अवधि का ब्याज देने के लिए कोलैटरल बेचा जाता है, और ऋण खुला रहता है।

<a id="lend-offer-tariff"></a>

### Lend: ऑफ़र पर फुल फ़ीस टैरिफ़

ऋणदाता की सहमति वही `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)` है, जो `createOffer` के बाद भेजी जाती है। ऑफ़र पूरा ले लिए जाने या बंद होने के बाद यह `OfferAlreadyAccepted` से अस्वीकार होती है; आंशिक रूप से मैच हुआ ऑफ़र इसे अब भी लेता है, अपने बाद के ऋणों के लिए। कोटेशन `amount` और `amountMax` पर `quoteCStar` है, और सीमा का डिफ़ॉल्ट `amountMax` पर कोटेशन है। हर ऋण अपने मूलधन पर आँका जाकर अलग से `maxCStar` से जाँचा जाता है, अनुरोध जैसी ही शर्तों पर (`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`, या अनुमति हो तो डाउनग्रेड); ऋणदाता की जाँच वॉल्ट के मौजूदा मुक्त VPFI का उपयोग करती है। लिया गया टैरिफ़ ऋण के `lenderMode` को Full दर्ज करता है, और फिर ऋणदाता की हर यील्ड-फ़ीस निपटान पर प्रोटोकॉल के हिस्से पर पोज़िशन धारक की छूट में `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) जुड़ता है, `MAX_FEE_DISCOUNT_BPS` (5000) की सीमा तक, होल्ड-छूट सहमति हो या न हो। जगह पर अवधि बढ़ाना (`repriceFeeEntitlementOnExtension`) नई अवधि के लिए इस दर्ज को None कर देता है।

<a id="lend-offer-review"></a>

### Lend: ऑफ़र की समीक्षा और पोस्ट करना

समीक्षा वॉलेट से `createOffer` का सिमुलेशन करती है और दोनों वर्ग, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, अधिकतम अवधि, वॉलेट का वॉल्ट, उधार दी गई संपत्ति (वह पक्ष जिसे ऋणदाता लॉक करता है) पर उसका बैलेंस और अलाउंस, और दोनों पक्ष लिक्विड हों तो `calculateLTV` पढ़ती है; हर ब्लॉक और वॉलेट खुलने से ठीक पहले यह फिर पढ़ी जाती है। अलाउंस कम रहने तक सिमुलेशन केवल राशि खींचने तक पहुँचता है, इसलिए टोकन की खींचने की त्रुटि, `VaultDepositFailed` (बिना डेटा revert हुए खिंचाव पर प्रोटोकॉल का आवरण, जैसा WETH कम अलाउंस पर करता है) या बिना प्रोटोकॉल त्रुटि-नाम वाला revert पूरी करनी वाली मंज़ूरी के रूप में दिखता है, वही नियम जो अनुरोध की समीक्षा में है; कोई भी दूसरी नामित प्रोटोकॉल त्रुटि अस्वीकृति है। सटीक मंज़ूरी के बाद `createOffer` का फिर सिमुलेशन होता है और उसे भेजा जाता है; मंज़ूरी के बाद रुकने पर, अगर कुछ और न बदला हो, अलाउंस पिछले मान पर लौटाया जाता है। परिणाम इस वॉलेट के `offerType` 0 वाले `OfferCreated` और वॉल्ट में राशि के `Transfer` से पढ़ा जाता है।

<a id="lend-offer-fee"></a>

### Lend: आपके ऑफ़र पर फ़ीस

`createOffer` ऋणदाता से कुछ नहीं लेता। दिखाई गई फ़ीस उधारकर्ता की है: उधार दी गई संपत्ति में राशि का `getLoanInitiationFeeBps`, उस दर पर जो `acceptOffer` चलने के समय लागू हो, तब उधारकर्ता के होल्ड-टियर डिस्काउंट से घटाई जाती है और उसकी डिलीवरी से काटी जाती है; दिखाया गया अंक आज की दर पर है। ब्याज में प्रोटोकॉल का हिस्सा `getTreasuryFeeBps` है, जो हर लोन के खुलने पर तय होता है (`treasuryFeeBpsAtInit`); सहमति चालू हो तो ब्याज निपटाते समय ऋणदाता का होल्ड-टियर डिस्काउंट उसे घटाता है। समीक्षा आज की दर और उस दर पर हिस्सा ऊपरी सीमा के रूप में दिखाती है; `getTreasuryFeeBps` पढ़ने में विफलता बताई जाती है, और न हिस्सा न वापसी राशि दिखाई जाती है।

<a id="positions"></a>

### Positions: सूची कैसे पढ़ी जाती है

Positions एक साझा रीडर से वही इन्वेंटरी पढ़ता है जो Home पढ़ता है: `getUserPositionLoansPaginated` वॉलेट में रखे पोज़िशन NFT पर चलता है, `getLoansBatch` उन्हें लोड करता है, और हर पक्ष रखे गए टोकन (`lenderTokenId` या `borrowerTokenId`) से तय होता है, लोन बनते समय दर्ज पक्ष से कभी नहीं। Active या FallbackPending स्थिति वाले लोन चालू हैं, उन्हीं समय-सीमाओं, हेल्थ फ़ैक्टर और समूह के साथ जो Home में बताए गए हैं। बाकी हर स्थिति समाप्त है, सबसे नया लोन id पहले, `LoanStatus` के नाम से: Repaid, Defaulted, Settled या InternalMatched (मैच से बंद); जो स्थिति संख्या ऐप नहीं जानता, वह संख्या के रूप में दिखती है। भुगतान Home में बताए गए claimables नियम का पालन करते हैं: किसी और से मिली, समाप्त लोन की रखी पोज़िशन गिनी जाती है, अनुमान नहीं लगाया जाता।

पक्ष का चुनाव भुगतान, चालू और समाप्त पंक्तियों को रखे गए पक्ष से छांटता है। "कुछ नहीं" तभी कहा जाता है जब पोज़िशन और भुगतान दोनों की पूरी गिनती हुई हो और आख़िरी पढ़ाई सफल रही हो; अपनी सीमा पर रुकी गिनती अधूरी बताई जाती है। एक पंक्ति `/positions/<id>` खोलती है, जहाँ पात्रता निर्णय हर कार्रवाई तय करता है; सूची कोई ट्रांज़ैक्शन नहीं भेजती।

<a id="position"></a>

### Position: एक लोन कैसे पढ़ा जाता है

पेज ऋणदाता और उधारकर्ता के पोज़िशन NFT के लिए `getLoanDetails(loanId)` और `ownerOf` पढ़ता है; भूमिका वह टोकन है जो वॉलेट अभी रखता है। चालू लोन (Active या FallbackPending) के लिए यह `getLoanDeadlines` (मूल परिपक्वता, विराम क्रेडिट, परिपक्वता, ग्रेस का अंत), कैडेंस होने पर `getPeriodicInterestEnabled` के साथ `previewPeriodicSettle`, `isLoanDefaultable`, `calculateHealthFactor` और `calculateLTV` पढ़ता है; हर लोन के लिए `getLoanCollateralLien` और `isSaleVehicleLoan`। हर पढ़ाई अलग है: विफल पढ़ाई अज्ञात दिखती है, शून्य कभी नहीं, और कोई तारीख `startTime` और `durationDays` से नहीं निकाली जाती।

दरें लोन के स्नैपशॉट हैं: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (सेल वाहन पर कोई नहीं) और `liquidationLtvBpsAtInit`। जिस लोन का कोई पक्ष Illiquid हो (`principalLiquidity` या `collateralLiquidity`), उसकी कोई कीमत-आधारित रीडिंग नहीं होती: प्रोटोकॉल उसके लिए `calculateHealthFactor` और `calculateLTV` अस्वीकार करता है, और पेज अज्ञात के बजाय यही बताता है। `principal` वह है जो अभी बाकी है (आंशिक भुगतान इसे घटाता है), और `interestRateBps` व `collateralAmount` भी बदल सकते हैं, इसलिए शर्तें अभी जैसी हैं वैसी दिखाई जाती हैं; बंद होने पर बट्टे खाते डाला गया मूलधन ऐसा ही बताया जाता है। `getPeriodicInterestEnabled` false होने पर पेज बताता है कि किसी चेकपॉइंट पर कोलैटरल नहीं बेची जाती। चालू लोन पर `collateralLiquidity` Illiquid होने पर वस्तु-रूप चेतावनी जुड़ती है: डिफ़ॉल्ट बिना बिक्री के कोलैटरल ऋणदाता को सौंप देता है। पेज अभी कोई ट्रांज़ैक्शन नहीं भेजता।

<a id="risk-access"></a>

### Risk Access: आपका जोखिम स्तर

स्विच `getRiskAccessGateEnabled` है। किसी प्रवाह को कौन-सा कदम चाहिए, यह प्रोटोकॉल का अपना उत्तर है: स्वीकृति के लिए `previewOfferAcceptBlock` (1 = स्तर बहुत कम, 2 = जोड़ी सहमति, 3 = सख़्त मोड स्वीकृति, 4 = वह इलिक्विड पेयर जिसे पहले स्वीकृति की स्वीकारोक्ति कवर करती थी; यह 2 की तरह रोकता है और पेयर सहमति इसे हटाती है), जब `previewCreatorBlock` दिखाए कि ऋणदाता रुका नहीं है; अनुरोध के लिए `createOffer` के ड्राई रन का `RiskTierTooLow`, `IlliquidPairNotConsented` या `MidTierPairNotAcknowledged`। कदम एक ही ब्लॉक में पढ़ता है: जोड़ी के लिए `pairRequiredRiskLevel` (ऑफ़र के लिए `acceptMidTierAckPair`), `getVaultRiskTier`, `getEffectiveRiskTier`, `getCurrentRiskTermsVersion` के सामने `getVaultRiskTierVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown` और `getRiskTierMutationNonce`, और जोड़ी के लिए `hasIlliquidPairConsent` के साथ `isPairConsentPending`, या `midTierStrictBlocked` के साथ `isMidTierAckPending`। स्तर बढ़ाना `setVaultRiskTierChecked(level, nonce, termsVersion)` है, जोड़ी की ज़रूरत के न्यूनतम स्तर तक, इसलिए समीक्षा के बाद कोई और स्तर-लेखन या शर्तों का बदलाव आ गया हो तो यह बिना कुछ बदले अस्वीकार होता है। जोड़ी का कदम `setIlliquidPairConsent(pair, true)` या `setMidTierPairAck(pair)` है। प्रतीक्षा में चल रही वृद्धि या लंबित जोड़ी कदम दोबारा नहीं दिया जाता। कोई रीड यह नहीं बताता कि लंबित जोड़ी कदम कब प्रभावी होगा, इसलिए समीक्षा बताती है कि वह यह समय नहीं पढ़ सकती; केवल उसी कदम का समापन कार्ड इसे देता है, रसीद के ब्लॉक के समय और प्रतीक्षा अवधि से। परिणाम रसीद के ब्लॉक पर वापस पढ़ा जाता है।

<a id="terms-gate"></a>

### शर्तों की पुष्टि

`getCurrentTos` उस चेन पर लागू संस्करण और कंटेंट हैश लौटाता है जिस पर कार्रवाई होनी है; संस्करण 0 का मतलब है कोई शर्तें नहीं, और कुछ भी नहीं रुकता। जिस वॉलेट का `hasAcceptedCurrentTerms` false है, उससे नए एक्सपोज़र से पहले पूछा जाता है, और प्रॉम्प्ट `/terms/v<N>` से जोड़ता है, यानी संस्करण-पिन किया पेज जिसका पाठ कभी नहीं बदलता। स्वीकार करना `acceptTerms(version, hash)` को एक बार कॉल करता है। वॉलेट खुलने से पहले यह जोड़ी दोबारा पढ़ी जाती है, इसलिए नया संस्करण दिखाए गए की जगह ले लेता है और किसी दूसरे टैब में दी गई स्वीकृति कार्रवाई को आगे बढ़ने देती है। पढ़ने में विफलता का मतलब है "पुष्टि नहीं हो सकती", दोबारा कोशिश के साथ, कभी "स्वीकार नहीं किया" नहीं। बाहर निकलने वाली कार्रवाइयाँ कभी नहीं रुकतीं।
