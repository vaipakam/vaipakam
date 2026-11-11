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

<a id="alerts-inbox"></a>

### Alerts इनबॉक्स

Alerts पेज जुड़े हुए wallet के नेटवर्क पर index का इनबॉक्स पढ़ता है, सबसे नए पहले, एक बार में पचास पंक्तियाँ। पंक्ति उस wallet के लिए लिखी जाती है जो लिखे जाते समय loan की position रखता है: loan शुरू हुआ; आंशिक और पूरा भुगतान, जिसमें preclose, refinance, swap-to-repay और collateral बेचकर बंद करना शामिल है; डिफ़ॉल्ट या liquidation; internal match से बंद होना; ऐसा loan जिसका अंत index ने देखा पर यह नहीं बता सका कि कैसे; due date से 7 दिन और 1 दिन पहले की सूचनाएँ; grace शुरू और grace ख़त्म; और health का 1.5, 1.2 और 1.05 से नीचे जाना। Health वाली पंक्तियाँ प्रोटोकॉल का keeper लिखता है, इसलिए वे तभी आती हैं जब वह चल रहा हो, और सिर्फ़ उन loans के लिए जिन पर health लागू होती है। Reward entry की आख़िरी सूचना और समाप्ति की पंक्तियाँ entry के मालिक को जाती हैं। पंक्ति एक संकेत है, कोई रक़म नहीं: loan पेज chain पढ़ता है। किसी दूसरे नेटवर्क या wallet का जवाब अस्वीकार किया जाता है, न पढ़ी जा सकने वाली पंक्तियाँ गिनी जाती हैं, और अनजान प्रकार अपने नाम से दिखाया जाता है। हेडर की गिनती index की अपनी गिनती है, सभी पंक्तियों पर, उन पंक्तियों की जिनकी id इस browser में देखी गई दर्ज सबसे नई id से बड़ी है; id सिर्फ़ लिखे जाने के क्रम में बढ़ती हैं, इसलिए पुराने block वाली पंक्ति भी गिनी जाती है। पेज खोलने पर अब तक लिखी गई सभी पंक्तियाँ देखी गई दर्ज हो जाती हैं। देखा-गया निशान सिर्फ़ इसी browser में रहता है और सिर्फ़ आगे बढ़ता है। Telegram, push, health चेतावनियाँ और भुगतान रिमाइंडर इनबॉक्स के ठीक नीचे सेट किए जाते हैं। हर पंक्ति इतिहास है: वह बताती है कि पंक्ति लिखे जाते समय ऋण या एंट्री की स्थिति क्या थी, यह कभी नहीं कि वह अब भी वैसी है; रिवॉर्ड की समय-सीमा खत्म होने की पंक्ति का अर्थ है कि एंट्री की कार्यक्रम में वापसी शुरू हो गई है, यह नहीं कि वह पूरी हो गई।

<a id="alerts-channels"></a>

### Telegram, push और चेतावनियाँ

हर बदलाव एक सादे संदेश पर EIP-191 हस्ताक्षर है जो कार्रवाई, वॉलेट, नेटवर्क और समय बताता है; अलर्ट सेवा हर हस्ताक्षरित अनुरोध दस मिनट के भीतर एक बार स्वीकार करती है, और सेव में सिर्फ़ वही सेटिंग जाती है जो बदली गई। सेवा वॉलेट, नेटवर्क, सेटिंग्स और जुड़ने के बाद Telegram chat id रखती है; वह इन्हें वापस नहीं बताती, इसलिए हर कार्ड बताता है कि इस browser ने क्या किया। Telegram लिंक तभी सिद्ध होता है जब टेस्ट अलर्ट चैट तक पहुँचे। सामान्य वॉलेट से अनलिंक करने पर हर नेटवर्क हटता है, smart account सिर्फ़ हस्ताक्षरित नेटवर्क हटाता है, और जिस नेटवर्क पर protected mode चालू है वहाँ चैट सुरक्षा अवधि बीतने तक बनी रहती है। Push तभी दिया जाता है जब सेवा की स्थिति कहे कि दोनों भेजने वाले एक चैनल पर भेज सकते हैं; अगर वह सिर्फ़ रिमाइंडर भेजने वाले को कवर करती है, तो चेतावनियाँ push तक शायद न पहुँचें। तीनों health रेखाएँ डिफ़ॉल्ट रूप से 1.5, 1.2 और 1.05 हैं और यहाँ बदली जा सकती हैं, हर एक अगली से ऊपर और आख़िरी 1.0 से ऊपर। Telegram जोड़ने और push चालू करने से पहले शर्तें स्वीकार करनी होती हैं; कुछ भी बंद करने पर कभी नहीं।

<a id="alerts-paid-push"></a>

### सशुल्क push अलर्ट

आपकी सहमति on-chain रखी गई एक सीमा है: हर loan side पर आप अधिकतम कितना VPFI देंगे। कार्ड इसे contract के अपने फ़ैसले के साथ दिखाता है कि यह अभी के शुल्क को पूरा करती है या नहीं। Basic में अभी के शुल्क पर सहमति होती है; Advanced में आप शुल्क से लेकर protocol की 50 VPFI की ऊपरी सीमा तक कोई सीमा लिख सकते हैं, और ऊपरी सीमा पर सहमति governance द्वारा तय किसी भी शुल्क को स्वीकार करती है। सहमति वहीं दी जाती है जहाँ अलर्ट सेवा कहती है कि वह शुल्क लेती है, sanctions जाँच में चिह्नित वॉलेट को कभी नहीं, और पहले Terms पूछे जाते हैं। पहले समीक्षा और dry run होते हैं, और वॉलेट खुलने से ठीक पहले शुल्क फिर पढ़ा जाता है: बदला हो तो कुछ नहीं भेजा जाता। वापस लेना सीमा को शून्य कर देता है और जब भी कोई सीमा रखी हो तब दिया जाता है, protocol रुका हो या अलर्ट सेवा से पूछा न जा सके तब भी। जिस deployment में सहमति का रिकॉर्ड नहीं है वह दोनों में से कुछ नहीं देता, और कार्ड बताता है कि वह फिर भी शुल्क ले सकता है या नहीं।

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

Delivery का ख़र्च कौन उठाता है, यह इस पर निर्भर है कि आपका tier किस ओर
बदला:

- **कम हुआ tier** तुरंत भेजा जाता है और उसका ख़र्च protocol उठाता है, जब
  तक उसका budget चुका सके। पहुँचने तक वह chain आपका पिछला, ऊँचा tier
  लागू करती रहती है।
- **बढ़ा हुआ tier**, किसी chain पर आपकी पहली discount समेत, कभी protocol
  के ख़र्च पर नहीं जाता। वह तब भेजा जाता है जब कोई delivery call से उसकी
  cross-chain fee चुकाता है। तब तक वह chain आपका पिछला tier रखती है। Tier
  table में बदलाव भी बढ़ा हुआ tier माना जाता है।
- जिस update को budget चुका नहीं सका, वह **अपने-आप दोबारा नहीं भेजा
  जाता**। वह Base पर आपके tier record के अगले update के साथ जाता है, या तब
  जब कोई आपके लिए delivery call करता है। बढ़ा हुआ tier delivery call का
  इंतज़ार करता है।
- यह call कोई भी कर सकता है। कम हुए tier का भुगतान protocol करता है; बढ़े
  हुए tier के लिए call करने वाला cross-chain fee चुकाता है। Contracts यह
  call देते हैं; app अभी नहीं देता, इसलिए फ़िलहाल बढ़ा हुआ tier किसी दूसरी
  chain तक सिर्फ़ सीधे contract call से पहुँचता है।

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
  के मानी जाती है, और इनमें से हर update बढ़ा हुआ tier है, जिसे सिर्फ़ भुगतान करने वाला caller पहुँचाता है।
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
सपोर्ट वाले नेटवर्क पर wallet बदलने तक अपना कुछ नहीं देखता। पते वाली chip ऐप का अपना account panel खोलती है: copy action के साथ पूरा पता, network, हर दूसरे सेवा-प्राप्त network पर switch, और disconnect। wallet picker केवल connect करने के लिए है। connect होने के बाद ऐप कोई name-service lookup नहीं करता, इसलिए connected session Ethereum mainnet पर कुछ नहीं पढ़ता और पेज की connect-src सूची के बाहर किसी host तक नहीं पहुँचता।

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

`setVPFIDiscountConsent` इस चेन के Diamond पर हर वॉलेट का एक फ़्लैग सेट करता है। बंद होने पर होल्ड-टियर छूट 0 है। चालू होने पर, बॉरोअर की लोन इनिशिएशन फीस स्वीकार होते समय लेंडिंग एसेट में घटती है (VPFI प्राइसिंग रास्ता कभी बॉरोअर पाथ का हिस्सा नहीं होता), और लेंडर की यील्ड फीस पर हर सेटलमेंट के समय उस वक़्त लागू प्रभावी टियर से छूट मिलती है। भुगतान का तरीका `getVPFIDiscountConfig` से तय होता है: VPFI दर और उसका रेफ़रेंस एसेट दोनों सेट हों तो छूट वाली फीस लेंडर की वॉल्ट से VPFI में कटती है और लेंडर पूरा ब्याज रखता है; वरना ट्रेज़री फीस ही घट जाती है और कोई VPFI नहीं हिलता। अगर किसी सेटलमेंट पर यह कटौती नहीं हो पाती (कोई ताज़ा भाव नहीं, वॉल्ट में दर्ज मुक्त VPFI कम, या वह VPFI कोलैटरल के रूप में लॉक), तो उस सेटलमेंट की फीस पर कोई होल्ड-टियर छूट नहीं मिलती। कॉल `whenNotPaused` है, इसलिए ग्लोबल पॉज़ इसे दोनों दिशाओं में बंद कर देता है। चालू करना शर्तों से बंधा है, बंद करना नहीं, और दोनों में से कोई भी mirrors को टियर नहीं भेजता। बॉरोअर की छूट तभी लागू होती है जब स्वीकार होते समय लेंडिंग एसेट लिक्विड हो (इलिक्विड लोन पूरी LIF देता है), और हर छूट फीस के 50% तक सीमित है। #3562 से, किसी लोन पर लेंडर की hold-tier छूट कभी भी उस छूट से ज़्यादा नहीं होती जो होल्डर के लिए लेंडर पोज़िशन लेते समय दर्ज की गई थी (`lenderEntryDiscount`, जो हर बार लेंडर टोकन को होल्डर मिलने पर लिखी जाती है; एक सामान्य ट्रांसफ़र दर्ज आंकड़े और प्राप्तकर्ता के आंकड़े में से कम वाला रखता है)।

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

भरोसे का स्तर इंडेक्स से `GET /assets/rankings?chainId=<token chain>` पढ़ता है, जो कीपर द्वारा रोज़ लाई गई दो सार्वजनिक मार्केट-कैप सूचियाँ (हर एक की शीर्ष 500) देता है: हर पते के लिए एक प्रविष्टि, जिसमें हर सूची का रैंक, नाम और प्रतीक हो, साथ में हर सूची का `listFetchedAt` और पिछला रन। ऐप छोटे अक्षरों वाले पते पर कुंजी बनाता है और सूचियों में सबसे अच्छा रैंक लेता है: रैंक ≤ 20 और `getAssetPriceStatus(asset)` priced होने पर ब्लू चिप, फिर ≤ 100, 200, 300 और 500। अगर कोई दूसरी सूची उसी प्रतीक को दूसरे पते पर रखती है और कोई सूची दोनों पतों को नहीं रखती, तो टोकन असत्यापित होता है; जिस अक्रमित टोकन का `symbol()` या `name()` किसी क्रमित प्रतीक या नाम से मेल खाए, वह संभावित नकल है; बाकी सब अक्रमित हैं। डिप्लॉयमेंट रिकॉर्ड का टेस्ट टोकन टेस्ट चिह्नित होता है; जिस चेन की कोई सूची संग्रहीत नहीं, वह टेस्टनेट पर टेस्ट नेटवर्क और मेननेट पर बिना सूची के रूप में पढ़ी जाती है। `listFetchedAt` के बाद विफल `lastRun` बताया जाता है। स्तर केवल दिखाने के लिए है और कोई ऑन-चेन व्यवहार नहीं बदलता। खोज क्रमित प्रतीकों और नामों को उपस्ट्रिंग से मिलाती है, सबसे अच्छा रैंक पहले, फिर सुझाए गए टोकन प्रतीक से; `0x` से शुरू होने वाला पाठ पते के रूप में पढ़ा जाता है।

<a id="borrow-offers"></a>

### Borrow: ऑफ़र चुनना

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` पेयर के खुले ऑफ़र id और कुल संख्या देता है। हर एक के लिए पेज `getOffer`, `getOfferState` और वॉलेट होने पर `previewAccept(offerId, wallet)` पढ़ता है, जिसका `errorCode` प्रोटोकॉल का इनकार है। लोन-टू-वैल्यू आज की क़ीमतों पर `calculateLTV` है; इलिक्विड या बिना क़ीमत वाला पक्ष बताता है कि क्यों नहीं है। सीधी स्वीकृति लेंडर का `amountMax` `interestRateBps` पर बाँधती है। उधार अनुरोध, NFT पक्ष वाले और अपने ऑफ़र गिने जाते हैं, सूचीबद्ध नहीं होते।

ऐप पंक्तियों को उस दर से समूहित करता है जिसे स्वीकार बाँधता है (`interestRateBps`), सबसे कम पहले; एक चरण के भीतर सूची का क्रम बना रहता है। सबसे ऊँची दर और Advanced में सबसे ऊँचा लोन-टू-वैल्यू केवल पढ़ी गई पंक्तियों को छानते हैं; जिस पंक्ति का `calculateLTV` कोई आँकड़ा नहीं है, वह रखी और गिनी जाती है। तैयार ऋणदाताओं की पंक्ति `getActiveLenderIntents(offset, 50)` को चार पेज तक पढ़ती है, जोड़ी के इंटेंट रखती है और हर एक के लिए `availableCapital` तथा `maxExposure` घटा `livePrincipal` में से छोटा लेती है; `minFillAmount` से कम वाला हटा दिया जाता है। यह गिनती, सबसे बड़ा एकल आँकड़ा और सबसे कम `minRateBps` दिखाती है, और Advanced में सबसे ऊँचे `maxDurationDays` और `maxInitLtvBps`। एक मिलान सेवा किसी इंटेंट से अनुरोध केवल इन सीमाओं में भरती है, इसलिए भरना गारंटीशुदा नहीं है। इस पंक्ति के लिए `getPartialFillEnabled` और `isLenderIntentEnabled` दोनों true होने चाहिए, जो सूची के हर पेज वाले उसी ब्लॉक पर पढ़े जाते हैं; किसी एक के false होने पर पेज बताता है कि उनके विरुद्ध कोई अनुरोध नहीं भरा जाता, और किसी एक के न पढ़े जाने पर बताता है कि यह पता नहीं है। विफल दोबारा पढ़ने पर पिछला उत्तर रखा जाता है और बताया जाता है कि वह बदल गया हो सकता है। जिन intents का `owner` जुड़ा हुआ खाता है, उन्हें हटा दिया जाता है (अपने ही साथ मिलान self-trade के रूप में अस्वीकार होता है)। हर intent भराई अनुरोध का `useFullTermInterest` भी माँगती है और `allowsPartialRepay` को अस्वीकार करती है (`LenderIntentFullTermRequired`, `LenderIntentPartialRepayNotAllowed`); रास्ता दोनों बताता है, और अनुरोध फ़ॉर्म संभावित भराई की जगह ऐसा चुनाव बताता है जो इनमें से किसी को पूरा नहीं करता। `keepersPaused()` भी उसी ब्लॉक पर पढ़ा जाता है: जब तक यह true है, प्रोटोकॉल की मिलान सेवा कुछ नहीं भरती, इसलिए पेज संभावित भराई की जगह यही बताता है और जोड़ता है कि कोई ऋणदाता अब भी अपने intent से भर सकता है और `requiresKeeperAuth` के बिना वाला intent कोई भी भर सकता है; न पढ़े जाने पर बताता है कि यह पता नहीं है। intent से भराई के लिए अनुरोध का `periodicInterestCadence` भी none होना चाहिए, क्योंकि intent के हिस्से में कोई अनुसूची नहीं होती और मिलान अलग जीवनचक्र शर्तें अस्वीकार करता है (`LifecycleTermsMismatch`); अनुरोध फ़ॉर्म संभावित भराई की जगह चुनी गई अनुसूची बताता है। `requiresKeeperAuth` वाले intent अलग से जोड़े और बताए जाते हैं, और संभावित भराई वाली पंक्ति उन पर कभी लागू नहीं की जाती: उन्हें केवल ऋणदाता या उसके द्वारा `KEEPER_ACTION_SIGNED_FILL` के लिए अधिकृत solver भर सकता है, और मिलान सेवा के पास यह अधिकार है या नहीं, यह पढ़ा नहीं जाता, इसलिए पेज बताता है कि यह पता नहीं है। निर्णय उसी ब्लॉक पर `paused()` और `aggregatorAdaptersPaused()` भी पढ़ता है: वैश्विक विराम हर दूसरी शर्त से ऊपर है और रुका हुआ बताया जाता है, और जब तक एग्रीगेटर रुके हैं, हर अलग मालिक को उसी ब्लॉक पर `isAggregatorAdapter` से जाँचा जाता है और उसके intent छोड़ दिए जाते हैं, क्योंकि `matchIntent` उन्हें अस्वीकार करता है; न पढ़ी गई जाँच निर्णय को अज्ञात बना देती है।

<a id="borrow-review"></a>

### Borrow: समीक्षा और साइन करना

समीक्षा ऑफ़र, उसकी स्थिति, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, दोनों श्रेणियाँ, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, वॉलेट का वॉल्ट, बैलेंस और मंज़ूरी, `previewOfferAcceptBlock` और डिस्काउंट सहमति पढ़ती है, और वॉलेट खुलने से ठीक पहले फिर पढ़ती है। वॉलेट संग्रहीत ऑफ़र से बना EIP-712 `AcceptTerms` (डोमेन `Vaipakam AcceptOffer`, संस्करण 1) नए 128-बिट nonce और 30 मिनट की समय-सीमा के साथ साइन करता है; इलिक्विड स्वीकारोक्ति केवल उस पक्ष का नाम लेती है जिसे समीक्षा ने इलिक्विड दिखाया। मंज़ूरी कम हो तभी ठीक कोलैटरल जितनी मंज़ूरी आती है, फिर `acceptOffer` सिग्नेचर के साथ सिम्युलेट होकर भेजा जाता है। मंज़ूरी के बाद रुकने पर, अगर किसी और ने उसे नहीं बदला, तो ऐप उसे पिछले मूल्य पर लौटाता है। परिणाम इस ऑफ़र और वॉलेट के लिए `LoanInitiated` और रसीद के `Transfer` लॉग पढ़ता है। पहले वॉलेट संकेत से ठीक पहले अनुमति (allowance) फिर से पढ़ी जाती है, और रीसेट वही मान बहाल करता है; भेजी गई स्वीकृति जो revert हो जाए, या जिसे वॉलेट रद्द कर दे या बदल दे, उसे भी लेनदेन ट्रैकर से वही रीसेट मिलता है। समीक्षा `allowsPartialRepay`, `allowsPrepayListing`, `parallelSaleOrderHash` के साथ `allowsParallelSale`, `refinanceTargetLoanId` और जुड़ा हुआ ऋण बताती है, और देय राशि को बिना विराम वाला मामला बताती है, क्योंकि विराम के दौरान ब्याज बढ़ता रहता है जबकि नियत तारीख खिसकती है। हर अनुमोदन चरण को उसकी रसीद वाले ब्लॉक पर दोबारा पढ़ी गई अनुमति से आँका जाता है, रसीद की स्थिति से कभी नहीं। जो टोकन एक गैर-शून्य अनुमति को दूसरी गैर-शून्य अनुमति में बदलने से मना करता है (यह `approve` के ड्राई रन से पता चलता है), उसके लिए पहले शून्य का एक चरण होता है, जिसे समीक्षा एक अतिरिक्त प्रॉम्प्ट के रूप में गिनती है। वॉलेट खुलने से ठीक पहले शर्तों की स्वीकृति फिर से पढ़ी जाती है। दोनों बिक्री मार्ग संपार्श्विक को NFT के रूप में सूचीबद्ध करते हैं, इसलिए टोकन संपार्श्विक पर दी गई लिस्टिंग या बिक्री की अनुमति को ऐसी अनुमति बताया जाता है जिसका यह ऋण उपयोग नहीं कर सकता। समीक्षा प्रीव्यू के अमाउंट पर मूलधन और कोलैटरल का `getNumeraireValue` ऐसी पंक्तियों में जोड़ती है जो किसी बात से नहीं बाँधतीं।

<a id="borrow-fee"></a>

### Borrow: इनिशिएशन फ़ीस

फ़ीस `previewAccept` का `lifEstimate` है: प्रिंसिपल का `getLoanInitiationFeeBps`, उधार टोकन में, दी गई राशि से कटी हुई, सहमति चालू हो और उधार टोकन लिक्विड हो तो होल्ड-टियर डिस्काउंट से घटी हुई, टियर स्वीकृति के समय तय। यह पेज कभी Full टैरिफ़ नहीं चुनता। फ़ीस के लिए कोई VPFI न लिया जाता है न लौटाया जाता है। भेजने वाले का हिस्सा, फ़ीस का `getLifMatcherFeeBps`, प्रेषक को जाता है, जो सीधी स्वीकृति में उधारकर्ता है, इसलिए वॉलेट को फ़ीस घटाकर प्रिंसिपल और यह हिस्सा मिलता है।

<a id="borrow-risks"></a>

### Borrow: जोखिम

ग्रेस समाप्ति के बाद का लोन (नियत तारीख़ के बाद `getEffectiveGraceSeconds`, जिसे पॉज़ का समय आगे खिसकाता है) कोई भी डिफ़ॉल्ट करवा सकता है: लिक्विड कोलैटरल लेंडर के लिए बेचा जाता है, इलिक्विड जैसा है वैसा ट्रांसफ़र होता है। हेल्थ फ़ैक्टर 1 से नीचे होने पर लिक्विड कोलैटरल लिक्विडेट भी हो सकता है। `useFullTermInterest` जल्दी चुकाने पर पूरी अवधि का ब्याज लेता है; ब्याज शेड्यूल छूटी अवधि को कोलैटरल की ज़बरन बिक्री से निपटाता है।

<a id="borrow-request"></a>

### Borrow: अपना अनुरोध पोस्ट करना

अनुरोध उधारकर्ता के वॉलेट से भेजा गया `createOffer` है, `offerType` 1 के साथ, दोनों पक्ष ERC-20। यह `collateralAmount` को उधारकर्ता के वॉल्ट में ले जाता है, वॉल्ट न हो तो बनाता है, और `OfferCreated(offerId, creator, 1)` जारी करता है। लेंडर इसे `acceptOffer` से स्वीकार करता है: फ़ीस घटाकर मूलधन उधारकर्ता के वॉलेट में जाता है, और फ़ीस में भेजने वाले का हिस्सा उस लेंडर को जाता है जिसने इसे भेजा। `cancelOffer` निर्माता के लिए बनने के `MIN_OFFER_CANCEL_DELAY` (5 मिनट) बाद से खुला है, और अनुरोध समाप्त होने पर किसी के लिए भी; कोलैटरल हमेशा निर्माता को लौटता है। हर लिखे गए अमाउंट के नीचे फ़ॉर्म `getNumeraireSymbol` की इकाई में `getNumeraireValue(asset, amount, roundUp)` दिखाता है (मूलधन ऊपर, कोलैटरल नीचे राउंड), जो टाइपिंग रुकने पर पढ़ा जाता है; इलिक्विड एसेट शून्य मूल्य वाला, विवादित कीमत बिना मूल्य और विफल रीड अपठित दिखता है।

<a id="borrow-request-terms"></a>

### Borrow: अनुरोध की शर्तें

Basic एकल-मान अनुरोध पोस्ट करता है: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 1 (AON), `periodicInterestCadence` 0, `allowsPrepayListing` और `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true। राशियाँ बेस इकाइयों में सटीक बदली जाती हैं और दर अधिकतम 10,000 bps है। `durationDays` की सीमा `getProtocolConfigBundle` से पढ़ा गया कॉन्फ़िगर किया गया अधिकतम है। `expiresAt` 0 है (रद्द होने तक खुला) या समीक्षा खुलते समय नवीनतम ब्लॉक से तय समय, अधिकतम `MAX_OFFER_EXPIRY_HORIZON` (365 दिन) आगे। `useFullTermInterest` डिफ़ॉल्ट रूप से true है और `allowsPartialRepay` false।

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

`fillMode` 0 (Partial), 1 (AON) या 2 (IOC) है और पोस्ट करने के बाद नहीं बदलता। AON के लिए `amount` = `amountMax` चाहिए (`AonRequiresSingleValueAmount`), और IOC के लिए `expiresAt` ≠ 0 चाहिए (`IocRequiresExpiry`); फ़ॉर्म अस्वीकार होने वाला कोई रूप नहीं देता। एक आकार वाली पोस्ट AON भेजती है (#3520): `LibOfferMatch` हर मैच को `amount` और `amountMax` के बचे हिस्से के बीच रखता है, इसलिए एक आकार हमेशा पूरा ही भरता है, और Partial और IOC केवल रेंज के साथ दिए जाते हैं। खुले अनुरोध पर राशियाँ, दर और संपार्श्विक `setOfferAmount`, `setOfferRate`, `setOfferCollateral` और `modifyOffer` से बदले जा सकते हैं, पर कभी `amountFilled` या `collateralAmountFilled` से नीचे नहीं; यह ऐप अभी इन्हें कॉल नहीं करता।

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

हिस्सों के बिना लेंडिंग ऑफ़र एकल-मूल्य वाला होता है: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (वह एक कोलैटरल जो उधारकर्ता को लॉक करना है), `fillMode` 1 (AON), जब तक Advanced कोई और तय न करे (अगला भाग), `periodicInterestCadence` 0 (जब तक Advanced अनुसूची न तय करे), `allowsPrepayListing` और `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true, और कोई Full टैरिफ़ नहीं (जब तक Advanced इसे न चुने)। राशियाँ ठीक-ठीक बेस यूनिट में पार्स होती हैं और दर अधिकतम 10,000 bps है। `durationDays` की सीमा `getProtocolConfigBundle` से पढ़े गए कॉन्फ़िगर किए अधिकतम से तय होती है। `expiresAt` 0 (रद्द होने तक खुला) या समीक्षा खुलते समय नवीनतम ब्लॉक से तय समय है, अधिकतम `MAX_OFFER_EXPIRY_HORIZON` (365 दिन) आगे। `useFullTermInterest` डिफ़ॉल्ट रूप से true और `allowsPartialRepay` false है।

<a id="rate-check"></a>

### अपनी दर की हाल के ऋणों से तुलना

दोनों फ़ॉर्म इंडेक्स का `/loans/recent` उसी उधार दी जाने वाली संपत्ति, उसी ज़मानत संपत्ति और उसी अवधि के लिए पढ़ते हैं, ऋणदाता-बिक्री वाहनों को छोड़कर, और वे ऋण रखते हैं जो पिछले 30 दिनों में शुरू हुए और जिनकी तय दर इंडेक्स का लेजर पुष्ट करता है (जिस ऋण की शर्तें पुष्ट नहीं हैं, वह छोड़ दिया जाता है)। तुलना इन दरों की माध्यिका से होती है, सम संख्या पर दो बीच वाली में से छोटी, ताकि दो तय दरों के बीच कोई दर गढ़ी न जाए। इससे 5 प्रतिशत अंक (500 bps) से ज़्यादा दूर की दर दिशा बताने वाली चेतावनी है: बहुत नीचे वाला ऋणदाता या बहुत ऊपर वाला उधारकर्ता वह ऑफ़र पोस्ट करता है जो दरें बदलने पर सबसे पहले लिया जाता है; दूसरी ओर, ऑफ़र बिना लिए पड़ा रह सकता है। इस दायरे के भीतर यह माध्यिका और संख्या वाला नोट है। एक बार की पढ़ाई सबसे नए 100 ऋण कवर करती है; उस सीमा तक पहुँचने पर नोट बताता है कि सिर्फ़ नवीनतम पढ़े गए। माँगी गई जोड़ी और अवधि तक सीमित न होने वाला इंडेक्स उत्तर तुलना के बजाय अस्वीकार किया जाता है, NFT ज़मानत की तुलना नहीं होती, और विफल पढ़ाई यही बताती है। यह समीक्षा को कभी नहीं रोकता। जोड़ी के वे ऋण जिनकी शर्तें इंडेक्स ने पुष्ट नहीं कीं, किसी अवधि में नहीं आते; इंडेक्स उन्हें गिनता है (`unplaced`) और फ़ॉर्म तुलना के साथ वह संख्या बताता है, ताकि "कोई पुष्ट ऋण नहीं" कभी अज्ञात अवधि वाले ऋणों को न छिपाए।

<a id="public-queue"></a>

### सार्वजनिक कतार वाले नेटवर्क

Ethereum, BNB Chain और Polygon (और BNB Testnet तथा Polygon Amoy) पर, आपका भेजा लेन-देन शामिल होने से पहले एक सार्वजनिक कतार में रुकता है, और उस कतार पर नज़र रखने वाला कोई भी, बॉट समेत, उसे देखकर पहले कदम उठा सकता है: आपका रद्द करना पहुँचने से पहले ऑफ़र ले लेना, या आपका भुगतान पहुँचने से पहले ऋण पर कार्रवाई करना। इसलिए इन नेटवर्कों पर ऑफ़र पोस्ट करने, लेने या रद्द करने, भुगतान करने और ज़मानत जोड़ने की समीक्षा वॉलेट खुलने से पहले यह बताती है। कुछ वॉलेट लेन-देन को निजी तौर पर भेज सकते हैं; अपने वॉलेट की नेटवर्क या सुरक्षा सेटिंग देखें। ऐप आपके लिए यह रास्ता नहीं चुन सकता, और सामान्य तरीके से भेजने से सिर्फ़ यह बदलता है कि पहुँचने से पहले लेन-देन कौन देख सकता है। Base, Arbitrum और Optimism में कोई सार्वजनिक कतार नहीं है, इसलिए वहाँ कुछ नहीं दिखता। नेटवर्क ऐप में एक ही नियम हैं (Ethereum 1, BNB Chain 56, BNB Testnet 97, Polygon 137, Polygon Amoy 80002), और अगर ऐप जिस नेटवर्क पर चलता है उसका निर्णय न हो तो एक टेस्ट विफल होता है। सूचना समीक्षा में, आख़िरी दोबारा जाँच और वॉलेट से पहले, सिर्फ़ इन कामों के लिए दिखती है: ऑफ़र पोस्ट करना, लेना या रद्द करना, पूरा और आंशिक भुगतान, और ज़मानत जोड़ना। मदद किसी निजी भेजने वाली सेवा का नाम नहीं लेती, क्योंकि प्रोटोकॉल यह जाँच नहीं सकता कि वॉलेट ने कौन-सा रास्ता लिया, और दोनों रास्तों पर लेन-देन का असर एक ही है।

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

पक्ष चुनने के बाद दो या अधिक चालू पंक्तियाँ होने पर सबसे पहले एक सारांश कार्ड आता है। हर पक्ष के लिए यह हर ERC-20 `principalAsset` के अनुसार `principal` जोड़ता है, कभी अलग-अलग टोकनों को मिलाकर नहीं (मूल्य की तुलना एक्सपोज़र पंक्ति का काम है), और NFT मूलधन वाली पंक्तियों को किराए के रूप में गिनता है। अगली तारीख उन्हीं चरणों में से सबसे पहली आने वाली तारीख है जिनका पंक्तियाँ उपयोग करती हैं: चल रही या जल्द देय परिपक्वता (चुकौती) या आने वाला आवधिक चेकपॉइंट (ब्याज); बराबरी होने पर कम लोन id चुनी जाती है। जिन लोन की ग्रेस अवधि खत्म हो चुकी है (परिपक्वता या किसी चेकपॉइंट पर), ग्रेस अवधि वाले लोन और FallbackPending लोन id के अनुसार सूचीबद्ध होते हैं, हर एक केवल एक बार अपने सबसे गंभीर चरण में; जिन लोन की समय-सीमाएँ पढ़ी नहीं जा सकीं, वे गिने जाते हैं। ब्याज शामिल नहीं है। कार्ड केवल सूची के अपने रीड का उपयोग करता है और अधूरी जाँच बताता है। NFT मूलधन वाली पंक्ति की परिपक्वता किराये का समापन (`rental-close`) है, कभी पुनर्भुगतान नहीं: किराया अपने पहले से चुकाए गए किराये पर बंद होता है, इसलिए सारांश उसे पंक्तियों की तरह ही नाम देता है।

<a id="position"></a>

### Position: एक लोन कैसे पढ़ा जाता है

पेज `getLoanDetails(loanId)` और ऋणदाता व उधारकर्ता के पोज़िशन NFT का धारक पढ़ता है (deployment जिस PositionNFT कॉन्ट्रैक्ट को दर्ज करता है उस पर `ownerOf`, या #3205 से पहले के deployment में ख़ुद Diamond पर); भूमिका वह टोकन है जो वॉलेट अभी रखता है। चालू लोन (Active या FallbackPending) के लिए यह `getLoanDeadlines` (विराम क्रेडिट से पहले मौजूदा अवधि की परिपक्वता, जिसे विस्तार या उधारकर्ता हस्तांतरण बदल देता है, विराम क्रेडिट, परिपक्वता, ग्रेस का अंत), कैडेंस होने पर `getPeriodicInterestEnabled` के साथ `previewPeriodicSettle`, `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`), `calculateHealthFactor` और `calculateLTV` पढ़ता है; हर लोन के लिए `getLoanCollateralLien` और `isSaleVehicleLoan`। हर पढ़ाई अलग है: विफल पढ़ाई अज्ञात दिखती है, शून्य कभी नहीं, और कोई तारीख `startTime` और `durationDays` से नहीं निकाली जाती।

कीमत वाले लोन के लिए यह `getInternalMatchConfigBundle` भी पढ़ता है। आंतरिक मिलान चालू हो तो जिस लोन का लोन-टू-वैल्यू उसकी सीमा से सीमा प्लस `externalLiquidationPriorityWindowBps` तक है, वह आंतरिक मिलान के लिए रोका जाता है और हर बाहरी लिक्विडेशन रास्ता मना करता है (`InternalMatchOnlyBand`); पेज यह दायरा बताता है। 0 वाला `loanInitiationFeeBpsAtInit` (दर दर्ज होने से पहले खुला लोन) दर्ज नहीं के रूप में दिखता है, और 0 वाला `treasuryFeeBpsAtInit` सेटलमेंट की 1% पुरानी दर के रूप में। वस्तु के रूप में सौंपने की चेतावनी केवल ERC-20 लोन के लिए है: NFT किराये में कोई कोलैटरल नहीं होती, और उसका डिफ़ॉल्ट किरायेदार का उपयोग खत्म करता है, पहले चुकाया किराया ट्रेज़री का हिस्सा घटाकर ऋणदाता को देता है और बफ़र ट्रेज़री को भेजता है; पेज इसके बजाय यही बताता है।

दरें लोन के स्नैपशॉट हैं: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (सेल वाहन पर कोई नहीं) और `liquidationLtvBpsAtInit`। जिस लोन का कोई पक्ष Illiquid हो (`principalLiquidity` या `collateralLiquidity`), उसकी कोई कीमत-आधारित रीडिंग नहीं होती: प्रोटोकॉल उसके लिए `calculateHealthFactor` और `calculateLTV` अस्वीकार करता है, और पेज अज्ञात के बजाय यही बताता है। `principal` वह है जो अभी बाकी है (आंशिक भुगतान इसे घटाता है), और `interestRateBps` व `collateralAmount` भी बदल सकते हैं, इसलिए शर्तें अभी जैसी हैं वैसी दिखाई जाती हैं; रिकॉर्ड में बिना मूलधन वाला समाप्त ऋण बताता है कि क्या किसी आंतरिक मिलान ने उसे कवर किया, वरना सिर्फ़ इतना कि कोई दर्ज नहीं है; NFT किराया अपना प्रतिदिन किराया (`principal`, `prepayAsset` में) और यह दिखाता है कि जल्दी लौटाने पर भी हर बचे दिन का शुल्क लगता है या नहीं (`useFullTermInterest`)। `getPeriodicInterestEnabled` false होने पर पेज बताता है कि किसी चेकपॉइंट पर कोलैटरल नहीं बेची जाती। चालू लोन पर `collateralLiquidity` Illiquid होने पर वस्तु-रूप चेतावनी जुड़ती है: डिफ़ॉल्ट बिना बिक्री के कोलैटरल ऋणदाता को सौंप देता है। इसका पहला ट्रांज़ैक्शन पूरा चुकाना है, नीचे देखें।

किसी चल रहे ERC-20 लोन के लेंडर पक्ष के होल्डर के लिए, पेज `lenderHoldDiscountView(loanId, wallet)` पढ़ता है: दर्ज एंट्री (होल्डर, टियर, छूट, समय), वॉलेट का अभी का टियर और छूट, और `holdBps`, जो एंट्री में वॉलेट का नाम होने पर दोनों में से कम वाला और अन्यथा 0 होता है। जिस Diamond में यह view नहीं है वह `FunctionDoesNotExist` के साथ revert करता है, जिसे पेज अभी रिपोर्ट नहीं किया गया बताता है, कभी शून्य नहीं। उसी ब्लॉक पर यह `getVPFIDiscountConsent` (hold हिस्सा तभी गिना जाता है जब यह चालू हो), `getVPFIDiscountConfig` (छूट कैसे दी जाती है) और `getFeeEntitlement(loanId).lenderMode` (Full 50% की सीमा के भीतर 10 अंक जोड़ता है) पढ़ता है।

<a id="repay"></a>

### पूरा चुकाएँ: राशि कैसे तय होती है

कार्रवाई एक नियम मानती है: `repayLoan` किसी Active या FallbackPending ERC-20 लोन के लिए हर उस वॉलेट को दिया जाता है जो न `loan.lender` है न `ownerOf(lenderTokenId)` (`LenderCannotRepayOwnLoan`), Active लोन पर प्रभावी ग्रेस अंत के बाद रोका जाता है (`RepaymentPastGracePeriod`), और तब तक रोका जाता है जब तक उधारकर्ता पोज़िशन का खुला रूट `SwapToRepayIntent` है (Diamond पर `positionRoute(borrowerTokenId)`, या #3205 से पहले के deployment में `positionLock(borrowerTokenId)`)। ऋणदाता की सेल लिस्टिंग, रीफ़ाइनेंस अनुरोध और वैश्विक पॉज़ इसे नहीं रोकते। रेंटल यहाँ अभी नहीं दिए जाते।

समीक्षा `calculateRepaymentAmount(loanId)` को नवीनतम ब्लॉक पर पढ़ती है, और फिर ब्लॉक समय को `min(now + 30 मिनट, ग्रेस अंत)` पर ओवरराइड करके; वही अनुरोध यह भी पढ़ता है कि वह किस ब्लॉक समय पर चला, और जो कनेक्शन ओवरराइड को अनदेखा करता है उसे छोड़ दिया जाता है। अनुमोदन ठीक दूसरा आंकड़ा है, वॉलेट खुलने से पहले कॉल का सिमुलेशन होता है, और रसीद के बाद पुनर्भुगतान ने लोन को जिस स्थिति में छोड़ा, वह उसके `LoanRepaid` लॉग से पढ़ी जाती है (ब्लॉक पर नहीं, जहाँ बाद का कोई दावा उसे पहले ही निपटा चुका हो सकता है), भुगतान `Transfer` लॉग से मापा जाता है, और जब allowance अनुमोदन घटा भुगतान दिखाती है तो उसे पिछले मान पर लौटा दिया जाता है। उस आंकड़े से बड़ी allowance, असीमित भी, उसी तक घटाई जाती है, क्योंकि `repayLoan(loanId)` कोई अधिकतम या समय-सीमा नहीं लेता; बाद में रीसेट बड़ा मान लौटा देता है।

छूट अवधि में (`getLoanDeadlines` से `maturity ≤ now ≤ graceEnd`), पूर्ण और आंशिक पुनर्भुगतान की समीक्षाएँ चेन की घड़ी पर `graceEnd` तक उलटी गिनती करती हैं, जिसका अनुमान पढ़े गए ब्लॉक टाइमस्टैम्प और तब से बीते सेकंड से लगाया जाता है। `block.timestamp > graceEnd` होते ही `repayLoan` और `repayPartial` `RepaymentPastGracePeriod` के साथ विफल होते हैं, और तब से `triggerDefault` सबके लिए खुला है, इसलिए देर से भेजा गया पुनर्भुगतान डिफ़ॉल्ट से होड़ करता है। एक घंटा या कम बचने पर घड़ी कहती है कि अभी भेजें। यह केवल बताती है: भेजने से पहले दोबारा पढ़ा गया निर्णय ही रोक है, और विराम `graceEnd` को आगे खिसकाता है। पुनर्भुगतान को छूट अवधि के पार रोकने के लिए ब्लॉक भरना खतरा मॉडल में स्वीकृत कम जोखिम के रूप में दर्ज है।

<a id="interest-schedule"></a>

### ब्याज अनुसूची: कैसे पढ़ी जाती है

कैडेंस वाले Active ERC-20 लोन के लिए कार्ड `previewPeriodicSettle(loanId)` (कैडेंस, `periodEndAt`, `graceEndsAt`, `expected`, `paidByBorrower`, `shortfall`, `canSettleNow`), `getPeriodicInterestEnabled()` और `paused()` पढ़ता है, और पढ़ा गया ब्लॉक समय बताता है। `expected` मौजूदा `principal` और `interestRateBps` पर एक पूरी अवधि है; `periodEndAt` में लोन का पॉज़ क्रेडिट शामिल है।

प्रीव्यू का `canSettleNow` स्विच और पॉज़ को नहीं देखता, इसलिए कार्ड उन्हें `settlePeriodicInterest` के अपने क्रम में जोड़ता है: बंद (`PeriodicInterestDisabled`), रुका हुआ (`whenNotPaused`), फिर अवधि का समय (`graceEndsAt` से पहले `PeriodicSettleNotDue`)। बिक्री की घोषणा तभी होती है जब स्विच चालू हो और प्रोटोकॉल रुका न हो; न पढ़ा गया स्विच या पॉज़ अज्ञात बताया जाता है। शून्य कमी पर सेटलमेंट सिर्फ़ चेकपॉइंट आगे बढ़ाता है। कीपर का `PERIODIC_SETTLE` चालू होना ऐप को नहीं बताया जाता, इसलिए कार्ड कहता है कि सेटल करना सबके लिए खुला है और कीपर की स्थिति ज्ञात नहीं है।

<a id="partial-repay"></a>

### ऋण का कुछ हिस्सा चुकाना: राशि कैसे तय होती है

`repayPartial(loanId, amount)` मूलधन का `amount` और `interestAccrualStart` के बाद से जमा ब्याज (किसी भी आवधिक क्रेडिट को घटाकर) लेता है। यह ब्याज पहले उन पिछले धारकों को देता है जिनका बिक्री से पहले का ब्याज अभी बाकी है (`paySellersFirst`), फिर वर्तमान ऋणदाता-पोज़िशन धारक को, ट्रेज़री का हिस्सा अलग करके (जिस धारक को प्रोटोकॉल को फ़्रीज़ करना हो, उसका हिस्सा इसके बजाय ऋणदाता वॉल्ट में लॉक करके जमा होता है, `freezeOrPayActiveLenderFromPayer`); यह `principal` घटाता है, ब्याज घड़ी फिर से शुरू करता है और वर्तमान अवधि में जमा करता है; परिपक्वता तिथि कभी नहीं बदलती। यह अनुग्रह अवधि के बाद, `principal × minPartialBps / 10000` (`getAssetRiskParams`) से कम, पूरे मूलधन या उससे अधिक (`PartialWouldRetireFullPrincipal`) पर, सक्रिय इंटेंट कमिट या पुनर्वित्त अनुरोध पर, और तरल ऋण में हेल्थ फ़ैक्टर बिगड़ने पर अस्वीकार करता है।

कोई व्यू कॉल से पहले आंशिक भुगतान का ब्याज नहीं लौटाता (#3299), इसलिए समीक्षा अभी और थोड़ी देर बाद के क्षण पर पढ़ा गया `calculateRepaymentAmount` घटा `principal` उपयोग करती है। यह परिपक्वता तक आनुपातिक ऋण के लिए सटीक है; `useFullTermInterest` के साथ इसमें शेष अवधि का न्यूनतम ब्याज, और परिपक्वता के बाद विलंब शुल्क शामिल होता है, इसलिए इसे "अधिकतम" दिखाया जाता है। अनुमोदन ठीक हिस्सा और वह ऊपरी आंकड़ा है। अंतिम कार्ड भुगतान के अपने `PartialRepaid` लॉग का `newPrincipal` (ब्लॉक पर `principal` नहीं, जिसे वहाँ बाद का कोई लेनदेन बदल सकता है), वॉलेट से निकली राशि और बाद में `previewPeriodicSettle` मापता है। समीक्षा वॉलेट को तभी रोकती है जब उसमें हिस्सा, या हिस्सा और सटीक ब्याज, कम पड़ता हो; जब केवल ऊपरी आंकड़ा शेष से अधिक हो, तो भुगतान भेजने से ठीक पहले का ड्राई रन तय करता है।

<a id="add-collateral"></a>

### कोलैटरल जोड़ना: क्या जाँचा जाता है

`addCollateral(loanId, amount)` लोन के अपने कोलैटरल टोकन की ठीक `amount` राशि कॉलर से उधारकर्ता के वॉल्ट में खींचता है, `collateralAmount` और कोलैटरल लियन बढ़ाता है, और नए हेल्थ फ़ैक्टर और LTV के साथ `CollateralAdded` उत्सर्जित करता है। यह चालू स्वैप-टू-रिपे कमिट, `ownerOf(borrowerTokenId)` के अलावा किसी और कॉलर, ऐसे लोन जो न Active है न FallbackPending, किराये, रुके हुए कोलैटरल एसेट (`isAssetPaused`) और उस कोलैटरल को अस्वीकार करता है जिसे `checkLiquidity` Liquid नहीं बताता। इसमें `whenNotPaused` नहीं है। जमा दर्ज `loan.borrower` के वॉल्ट में जाता है: Active लोन पहले हस्तांतरित पोज़िशन को धारक पर समेकित करता है (`consolidateToHolder`), इसलिए वह धारक का वॉल्ट है, जबकि FallbackPending लोन ठीक होने तक समेकित नहीं होता, इसलिए समीक्षा दर्ज वॉल्ट का नाम बताती है। जोड़े गए टोकन `collateralAmount` में गिने जाते हैं, जिसे लिक्विडेशन और डिफ़ॉल्ट खर्च करते हैं, और समीक्षा यह बताती है।

ऐप ये इनपुट पढ़ता है, दोनों एसेट जाँचें लोन की शुरुआती श्रेणी से नहीं बल्कि अभी की स्थिति से, और ड्राई रन प्रोटोकॉल का अंतिम निर्णय है। कोई व्यू टॉप-अप के बाद का हेल्थ फ़ैक्टर नहीं देता, इसलिए समीक्षा अभी के `calculateHealthFactor` और `calculateLTV` बताती है और अंतिम कार्ड नए आंकड़े लेनदेन के `CollateralAdded` लॉग से पढ़ता है। FallbackPending लोन पर टॉप-अप उसे ठीक कर देता है जब नया हेल्थ फ़ैक्टर लोन के न्यूनतम तक पहुँचे और LTV उसकी शुरुआती सीमा के भीतर हो; अंतिम कार्ड `LoanCuredFromFallback` देखता है। राशि के बराबर या उससे बड़ा मौजूदा अनुमोदन जैसा है वैसा छोड़ा जाता है, क्योंकि ठीक उतनी ही राशि खींची जाती है; छोटा अनुमोदन ठीक उस राशि तक बढ़ाया जाता है और टॉप-अप न होने पर वापस रखा जाता है।

<a id="take-back-collateral"></a>

### कोलैटरल वापस लेना: क्या जाँचा जाता है

`partialWithdrawCollateral(loanId, amount)` उधारकर्ता के वॉल्ट से कोलैटरल की `amount` कॉल करने वाले के वॉलेट में भेजता है, `collateralAmount` और कोलैटरल लियन घटाता है, और नए हेल्थ फ़ैक्टर और LTV के साथ `PartialCollateralWithdrawn` उत्सर्जित करता है। इसमें `whenNotPaused` है और यह क्रम से अस्वीकार करता है: प्रतिबंधित कॉलर, सक्रिय स्वैप-टू-रिपे कमिट, सक्रिय रीफ़ाइनेंस अनुरोध (`RefinanceRequestOpen`), जुड़ी बिक्री सूची (`SaleListingActive`), `ownerOf(borrowerTokenId)` के अलावा कोई कॉलर, Active न होने वाला लोन, कोलैटरल से अधिक राशि, ऐसा कोलैटरल जिसे `checkLiquidity` Liquid नहीं बताता, और ऐसा परिणाम जो न्यूनतम हेल्थ फ़ैक्टर से नीचे या शुरुआती LTV सीमा से ऊपर हो।

फ़ॉर्म राशि को `calculateMaxWithdrawable` से जाँचता है, जो Active न होने वाले लोन या अतरल कोलैटरल के लिए शून्य है और ब्याज जुड़ने पर घटता है। कोई व्यू जुड़ी बिक्री सूची नहीं दिखाता, इसलिए समीक्षा निकासी का ड्राई रन चलाकर वह अस्वीकृति बताती है; भेजते समय यह फिर चलता है। अंतिम कार्ड बचा कोलैटरल और नए आँकड़े ट्रांज़ैक्शन के `PartialCollateralWithdrawn` लॉग से, और मिली राशि टोकन के वॉलेट को `Transfer` से पढ़ता है। सुरक्षित खाता मोड वाले कॉलर के लिए वॉल्ट का भुगतान गेट निकासी को भुगतान करने के बजाय खाते की देरी तक कतार में रखता है (`PayoutQueued`), इसलिए समीक्षा `getProtectedAccount` पढ़ती है और समापन कार्ड वह लॉग पढ़ता है।

<a id="collect-a-payout"></a>

### भुगतान प्राप्त करना: क्या जाँचा जाता है

`claimAsLender(loanId)` और `claimAsBorrower(loanId)` पर `whenNotPaused` लगा है और ये उस पक्ष के लिए दर्ज पार्टी (`loan.lender` / `loan.borrower`) के वॉल्ट से कॉल करने वाले को भुगतान करते हैं, जिसे उस पक्ष के पोज़िशन टोकन का `ownerOf` होना चाहिए। ऋणदाता Repaid, Defaulted, FallbackPending या InternalMatched ऋण पर दावा कर सकता है; उधारकर्ता केवल Repaid, Defaulted या InternalMatched पर। ऋणदाता का दावा पहले से दावा की गई पंक्ति (`AlreadyClaimed`) को धारक जाँच से पहले और बिना किसी खुली राशि वाले पक्ष (`NothingToClaim`) को उसके बाद अस्वीकार करता है; जबरन समापन द्वारा शून्य पर दर्ज पंक्ति फिर भी चलती है और पोज़िशन बंद करती है। उधारकर्ता का दावा तभी अस्वीकार होता है जब उसकी कोलैटरल पंक्ति और अधिशेष पंक्ति दोनों खाली या दावा की गई हों, और हर एक को उसके अपने फ़्लैग पर भुगतान करता है, साथ में किसी दूसरे टोकन में ऋण के लियन के तहत अभी भी रखा कोलैटरल।

समीक्षा `getClaimable` (ऋणदाता पंक्ति पहले से ही पिछले विक्रेताओं को घटाकर, साथ में `getSellersShareOfLenderClaim`), `getBorrowerSurplusClaim` और `getLoanCollateralLien` पढ़ती है, और दावे को ड्राई रन के रूप में चलाती है, जो प्रतिबंध जाँचें भी लागू करता है। सूची पोज़िशन टोकन का अनुसरण करती है: `getUserDashboardClaimables` दर्ज पार्टी के दावे सूचीबद्ध करता है, इसलिए सूचीबद्ध पंक्ति तभी रहती है जब तक वॉलेट उस पक्ष को रखता है, और किसी और से मिली समाप्त ऋण की पोज़िशन का दावा सीधे पढ़ा जाता है। अंतिम कार्ड `LenderFundsClaimed` / `BorrowerFundsClaimed`, `BorrowerSurplusClaimed` और `LoanSettled` तथा वॉलेट को टोकन ट्रांसफ़र पढ़ता है; सुरक्षित खाता मोड वाले कॉलर के लिए वह `PayoutQueued` (खाते का अपना वॉल्ट), `PayoutHeldInVault` (लॉक खाता या भरी कतार) या `PaymentCreditedToVault` (किसी दूसरी पार्टी का वॉल्ट) पढ़ता है। FallbackPending ऋण पर ऋणदाता का दावा दावे के समय आंतरिक मिलान चला सकता है जो पंक्ति को फिर से लिखता है, इसलिए अंतिम कार्ड ट्रांसफ़र की तुलना प्रोटोकॉल के अपने रिकॉर्ड से करता है।

<a id="claim-everything"></a>

### सब कुछ क्लेम करें: क्या जाँचा जाता है

बैच `multicall(calls)` से होकर जाता है, जो हर कॉल को प्रोटोकॉल के भीतर ही `delegatecall` से चलाता है, इसलिए `msg.sender` आपका वॉलेट ही रहता है और हर कॉल अपने नियम खुद जाँचता है। यह अधिकतम 30 कॉल लेता है, और ऐप हर कॉल `allowFailure` के साथ भेजता है, ताकि अस्वीकृत कॉल अकेले वापस हो और बैच चलता रहे। कॉल हैं `claimAsLender` / `claimAsBorrower(loanId)`; `claimInteractionRewardsTo(Vault)`, जो रोके गए रिवॉर्ड को भी जारी करता है, या `claimHeldInteractionRewards(Vault)` जब रिवॉर्ड का पूर्वावलोकन पूरा न हो सके पर `getRewardSanctionsStatus` Deliver पढ़े; `getLenderIntentsByOwner` से हर इंटेंट के `availableCapital` के लिए `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)`; VPFI के `freeHolding` के लिए `withdrawVPFIFromVault(amount)`; और `getPayrollStream` की हर उस स्ट्रीम के लिए `withdrawSalary(streamId)` जिसका लाभार्थी वॉलेट है, `getWithdrawableSalary` के अनुसार। FallbackPending ऋण पर ऋणदाता का क्लेम बाहर रखा जाता है, क्योंकि क्लेम के समय का मिलान तय करता है कि वह क्या देगा। समीक्षा बैच को परीक्षण के रूप में चलाती है और हर कॉल का `success` और रिवर्ट डेटा पढ़ती है, अस्वीकृत कॉल को उसकी डिकोड की गई त्रुटि के साथ बाहर रखती है, और भेजते समय फिर चलाती है। समापन कार्ड हर कॉल की अपनी घटना (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`) पढ़ता है; जिस कॉल की कोई घटना नहीं, वह छोड़ दी गई। वॉलेट को टोकन ट्रांसफ़र, और सुरक्षित मोड के लिए `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault`, लिए गए कॉलों में हर टोकन के हिसाब से जोड़े जाते हैं। विराम (हर कॉल पर `whenNotPaused`) और चिह्नित वॉलेट हस्ताक्षर से पहले बैच रोक देते हैं।

<a id="payout-queue"></a>

### भुगतान कतार: क्या जाँचा जाता है

सूची `getPendingPayoutIds(account)` है, हर पंक्ति के लिए `getPendingPayout(id)` और `requestCode(id)` के साथ; कोड को उसी साझा रेंडरर से छह base32 अक्षरों में दिखाया जाता है जिसका उपयोग अलर्ट करते हैं, और पंक्तियाँ ब्राउज़र की घड़ी नहीं, बल्कि नवीनतम ब्लॉक के टाइमस्टैम्प के सापेक्ष `releaseAt` के क्रम में होती हैं। `releasePayout(id)` बिना अनुमति के कोई भी चला सकता है और विराम के दौरान `isEscapeOpen()` होने तक अस्वीकार होता है। कतार की वह पंक्ति जिसका प्राप्तकर्ता न तो प्रबंधक है (खाता, या सेवानिवृत्त होने के बाद उसका नियंत्रक) और न ही `getAllowlist` में है, समय की जाँच से पहले ही भुगतान के बजाय रद्द हो जाती है; अन्यथा पंक्ति देय होनी चाहिए, खाता अनलॉक होना चाहिए (`ProtectedVaultLocked`) और जब तक `requireCosign` चालू है, सह-हस्ताक्षरित होनी चाहिए (`CosignRequired`), और प्राप्तकर्ता की फिर से जाँच होती है। `cancelPayout(id)` प्रबंधक या किसी हस्ताक्षरकर्ता का है (`NotManagerOrSigner`), विराम के दौरान भी काम करता है, और जमा बही में राशि जोड़ता है ताकि संपत्ति फिर से निकाली जा सके। `cosignPayout(id)` `getProtectedSigners` के किसी हस्ताक्षरकर्ता का है (`NotSigner`); ऐप इसे तभी देता है जब खाते को इसकी आवश्यकता हो और पंक्ति पर अभी सह-हस्ताक्षर न हुआ हो। हर कार्रवाई समीक्षा में ड्राई रन के रूप में और भेजते समय फिर से चलती है। समापन कार्ड उस id के लिए `PayoutReleased` (राशि और प्रोटोकॉल द्वारा मापा गया `delivered`), `PayoutCancelled` और `PayoutCosigned` पढ़ता है। क्या keeper का `protectedAccount` पास देय पंक्तियाँ जारी करता है, यह क्षमता सेवा का उत्तर है, जो डिफ़ॉल्ट रूप से अज्ञात है। लॉक कतार की हर पंक्ति रद्द कर देता है।

<a id="seller-interest"></a>

### बेची गई पोज़िशन का ब्याज: क्या जाँचा जाता है

बिक्री विक्रेता के कमाए और न चुकाए गए ब्याज को एक दावे के रूप में दर्ज करती है: `getInterestLedger(loanId)` खुले दावों को सबसे पुराने से शुरू करके, हर एक की सकल राशि के साथ, सूचीबद्ध करता है। `claimAsSeller(loanId)` में `whenNotPaused` और प्रतिबंध जाँच है। खुले दावों वाले Repaid, Defaulted, Settled या InternalMatched ऋण पर यह पहले ऋणदाता की वसूली बाँटता है (`getSellersShareOfLenderClaim`), हर दावे को उसकी शुद्ध राशि तक चुकाता है (सकल में से ऋण का `treasuryFeeBpsAtInit` हिस्सा घटाकर, नीचे पूर्णांकित; जहाँ ऋण ने कोई दर्ज नहीं किया वहाँ पुराना 1%) और सभी को बंद करता है; FallbackPending ऋण नहीं बँटता। फिर यह मूलधन टोकन के लिए, और अलग होने पर ऋणदाता दावे के टोकन के लिए, `getSellerInterestHeld(loanId, seller, asset)` विक्रेता की अपनी वॉल्ट से उसके वॉलेट में निकालता है, और शून्य होने पर `NothingToClaimAsSeller` से मना करता है। ऐप ऋणों को इंडेक्स की उस गतिविधि से सूचीबद्ध करता है जो वॉलेट के नाम विक्रेता के रूप में दर्ज है (`SellerInterestClaimRecorded`, `SellerInterestPaid`, `SellerInterestClaimClosed`, `SellerInterestWithdrawn`); संख्या से खोज केवल चेन पढ़ती है। मूलधन टोकन में समीक्षा वॉलेट का हिस्सा बँटवारे से ठीक-ठीक निकालती है; दूसरे टोकन में बँटवारा मूल्य के आधार पर होता है और चलने के समय तय बताया जाता है। निकासी समीक्षा में ड्राई रन के रूप में और भेजते समय फिर चलती है। अंतिम कार्ड `SellerInterestClaimClosed` (चुकाया, जमा किया, पूरा चुकाया) और `SellerInterestWithdrawn` पढ़ता है, और जहाँ सुरक्षित मोड ने भुगतान कतार में रखा या रोका वहाँ `PayoutQueued` या `PayoutHeldInVault`।

<a id="frozen-proceeds"></a>

### फ़्रीज़ भुगतान: क्या जाँचा जाता है

ऐप `getSanctionsOracle` (शून्य का अर्थ है इस चेन पर कोई जाँच नहीं), `sanctionsStatus(wallet)` (Clean, Flagged, या जाँच के revert होने पर Unavailable) और `isSanctionsConfirmedFlagged(wallet)` पढ़ता है, वह रजिस्टर जिसे `refreshSanctionsFlag` एक निर्णायक रीड से सिंक करता है। Flagged, या वॉलेट पंजीकृत होने पर Unavailable, फ़्रीज़ माना जाता है; बिना पंजीकरण के Unavailable नहीं। `claimAsLender` और `claimAsBorrower` `whenNotPaused` के बाद कॉलर की जाँच करते हैं और रुकावट को जाने देते हैं; जिस पक्ष का भुगतान प्रोटोकॉल ने किसी दर्ज पक्ष के लिए फ़्रीज़ किया है, वह fail-closed तरीके से जारी होता है, और जब तक वह पक्ष Clean न पढ़े तब तक `SanctionedAddress` या `SanctionsOracleUnavailable` के साथ revert होता है, चाहे तब पोज़िशन किसी के भी पास हो। प्रोटोकॉल उस दर्ज पक्ष का कोई व्यू नहीं देता, इसलिए वहाँ ऐप ड्राई रन पर निर्भर करता है और उसके इनकार को उन्हीं शब्दों में कहता है। `claimAsSeller` चिह्नित विक्रेता को, और रुकावट के दौरान पंजीकृत विक्रेता को, मना करता है। ऋण चलते रहने तक, किसी चिह्नित धारक के लिए रखा गया ऋणदाता हिस्सा `getClaimable(loanId, true)` के `heldForLender` में जुड़ता है, जो दर्ज ऋणदाता के वॉल्ट में तब तक आरक्षित रहता है जब तक ऋणदाता का क्लेम उसे न चुका दे। चिह्नित उधारकर्ता के लिए चुकौती खुली रहती है; संपार्श्विक जोड़ना नहीं।

<a id="extension-reserves"></a>

### विस्तार रिज़र्व: क्या जाँचा जाता है

`fundExtendReserve(loanId, amount)` उधारकर्ता पोज़िशन के धारक के वॉलेट से ऋण का मूलधन टोकन उनके अपने वॉल्ट में जमा करता है और उसे उस ऋण के लिए आरक्षित करता है। इसमें `whenNotPaused` और प्रतिबंध जाँच है, और यह तब तक अस्वीकार होता है जब तक ऋण Active, ERC-20 ऋण और बिना आवधिक अंतराल वाला न हो। `getExtendFunding(loanId, holder)` टोकन, `reserved`, धारक का दूसरा मुक्त बैलेंस, और कोई विस्तार अभी तथा विंडो के अंत में कितना लेगा, लौटाता है; विस्तार केवल वर्तमान धारक के वॉल्ट से लेता है, पहले रिज़र्व से। `withdrawExtendReserve(account, loanId, amount)` में `whenNotPaused` है, यह माँग करता है कि कॉलर खाते का प्रबंधक हो (उसका अपना वॉलेट, या प्रतिस्थापन के बाद उसका नियंत्रक), कॉलर की जाँच करता है (रुकावट में खुला), और आरक्षित से अधिक पर `ExtendReserveInsufficient` से लौटता है; ऋण की स्थिति चाहे जो हो, यह खुला है। ऐप वॉलेट के नाम दर्ज इंडेक्स की गतिविधि से ऋण सूचीबद्ध करता है (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`); संख्या से खोज केवल चेन पढ़ती है। यह समीक्षा द्वारा पढ़ा गया पूरा रिज़र्व निकालता है, कॉल को समीक्षा में और भेजते समय फिर परीक्षण के रूप में चलाता है, और समापन कार्ड `ExtendReserveWithdrawn` (राशि, और जो आरक्षित रहता है) पढ़ता है, साथ में `PayoutQueued` या `PayoutHeldInVault` जहाँ सुरक्षित मोड ने भुगतान को कतार में रखा या रोक रखा।

<a id="vault-holdings"></a>

### आपका वॉल्ट: क्या पढ़ा जाता है

वॉल्ट `VaultFactoryFacet.getUserVaultAddress(wallet)` है; `getOrCreateUserVault(wallet)` इसे बनाता है (टियर-1 प्रतिबंध जाँच, कोई पॉज़ गेट नहीं), और अंतिम कार्ड `UserVaultCreated` पढ़ता है। हर संपत्ति के लिए, एक ही ब्लॉक पर: वॉल्ट का अपना बैलेंस (ERC-20 `balanceOf`, ERC-721 `ownerOf`, ERC-1155 `balanceOf`), `getTrackedHolding`, `withdrawableNow` और `untrackedHolding`। "आपके वॉल्ट में" बैलेंस और ट्रैक की गई होल्डिंग में से छोटा है; "अभी निकालने के लिए मुक्त" वैसा ही `withdrawableNow` है जैसा लौटाया गया (जमा होल्डिंग, `freeHolding` से सीमित: ट्रैक की गई राशि घटा लियन घटा सुरक्षा-मोड अर्मार्क); "आपकी पोज़िशन द्वारा रोका गया" गिनी गई राशि घटा वह है। संपत्तियाँ `getDepositoryAssets(wallet, offset, limit)` से आती हैं, जिसे लौटाए गए कुल तक पेज-दर-पेज पढ़ा जाता है (उससे पहले खाली पेज अधूरा माना जाता है), हर सूचीबद्ध कॉन्ट्रैक्ट का मानक ERC-165 से पढ़ा जाता है, साथ में `getUserLoansPaginated(wallet)` के हर ऋण और हर उस ऋण के लेग (उधार दी गई संपत्ति, संपार्श्विक, किराये का अग्रिम शुल्क टोकन) जिसकी स्थिति वॉलेट के पास है, हर एक उसी ब्लॉक पर `getLoanDetails` से पढ़ा जाता है, और उसके द्वारा कभी बनाए गए हर ऑफ़र के लेग, `getUserOffersPaginated(wallet)` से, हर एक `getOffer` से पढ़ा गया (ऑफ़र की जमा राशि उसके पोज़िशन NFT के ट्रांसफ़र के बाद भी बनाने वाले के वॉल्ट में रहती है)। `getLenderIntentsByOwner(wallet)` के हर स्थायी ऑफ़र की उधार दी जाने वाली संपत्ति भी जोड़ी जाती है, रद्द ऑफ़र भी: किसी को फ़ंड करने से वह संपत्ति जमा रिकॉर्ड में दर्ज हुए बिना वॉल्ट में पहुँचती है। रिकॉर्ड NFT टोकन आईडी नहीं रखता, इसलिए जमा किया गया हर NFT संग्रह एक नोट में नामित होता है, और आँकड़ों के साथ केवल वही टोकन सूचीबद्ध होता है जिसका नाम कोई ऋण या ऑफ़र लेता है। डस्ट वह गिनी गई राशि है जो शून्य से अधिक और एक पूरे टोकन के 1e-11 से कम है।

<a id="vault-deposit"></a>

### अपने वॉल्ट में जमा करें

जमा `VaultDepositoryFacet.depositToVault(kind, asset, tokenId, amount)` है: kind 0 ERC-20, 1 ERC-721, 2 ERC-1155; ERC-20 के लिए टोकन आईडी 0 और ERC-721 के लिए राशि 1 होती है। यह `whenNotPaused` है, कॉल करने वाले की जाँच (Tier-1) करता है और किसी प्रतिस्थापन द्वारा सेवानिवृत्त वॉलेट को अस्वीकार करता है (`requireManager`)। समीक्षा एक ही ब्लॉक पर `getUserVaultAddress`, `paused`, प्रतिबंध-जाँच की स्थिति, `getProtectedAccount(wallet)` तथा वॉलेट का बैलेंस और स्वीकृति पढ़ती है; न पढ़ा गया ठहराव, जाँच या सेवानिवृत्ति बताई जाती है और ड्राई रन तय करता है। स्वीकृति ERC-20 के लिए सटीक `approve` (दो चरण जब टोकन को पहले शून्य करना हो), ERC-721 के लिए `approve(diamond, tokenId)`, या ERC-1155 के लिए `setApprovalForAll(diamond, true)` है, जो जमा के बाद वापस ली जाती है जब तक वह पहले से न दी गई हो। ड्राई रन स्वीकृति के बाद चलता है; ERC-20 पूरी प्राप्ति की जाँच (`LibDelivery.pullExact`) के साथ खींचा जाता है, इसलिए ट्रांसफ़र-शुल्क वाला टोकन विफल होता है। अंतिम कार्ड `VaultDeposited(account, asset, kind, tokenId, amount)` और वॉल्ट में टोकन के अपने ट्रांसफ़र लॉग पढ़ता है। इस जमा के लिए कोई permit मार्ग नहीं है। `getProtectedAccount(wallet)` से समीक्षा `enabled`, `locked`, `delaySeconds` और `requireCosign` भी रखती है, और रसीद बताती है कि जमा फिर कैसे निकल सकता है: तुरंत, देरी के बाद (जहाँ ज़रूरी हो वहाँ द्वितीयक हस्ताक्षरकर्ता के साथ), या खाता लॉक रहने तक नहीं, जिसे `depositToVault` अस्वीकार नहीं करता। हस्ताक्षर से पहले की अंतिम जाँच `hasAcceptedCurrentTerms` फिर से पढ़ती है और अस्वीकृत संस्करण को रोकती है।

<a id="vault-withdraw"></a>

### अपने वॉल्ट से निकासी

निकासी `VaultDepositoryFacet.withdrawFromVault(account, kind, asset, tokenId, amount, recipient)` है, जिसमें `account` और `recipient` दोनों जुड़ा हुआ वॉलेट हैं। इसकी सीमा `withdrawableNow(account, kind, asset, tokenId)` है (अन्यथा `AmountExceedsFree`), यह `requireManager(account)` जाँचती है, कॉल करने वाले (Tier-1) और प्राप्तकर्ता की स्क्रीनिंग करती है, और रुके होने पर अस्वीकार होती है, जब तक खाता सुरक्षित न हो और `isEscapeOpen` सही न हो। समीक्षा एक ब्लॉक पर `getUserVaultAddress`, `paused`, `isEscapeOpen`, प्रतिबंध स्थिति, `getProtectedAccount(wallet)` और `withdrawableNow` पढ़ती है, फिर कॉल का परीक्षण चलाती है। सुरक्षित मोड के बिना वॉल्ट मार्ग तुरंत वॉलेट को भुगतान करते हैं; उसके साथ `LibProtectedAccount.queuePayout` भुगतान को `delaySeconds` तक कतार में रखता है और `ProtectedVaultLocked`, `RecipientNotAllowlisted` तथा `TooManyPendingRows` को अस्वीकार करता है। समापन कार्ड `VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, queued)`, `PayoutQueued` और वॉल्ट से वॉलेट तक टोकन के अपने ट्रांसफ़र लॉग पढ़ता है। जिस संग्रह को जमा रिकॉर्ड टोकन आईडी के बिना जानता है, उसे टोकन आईडी लिखकर निकाला जाता है; फ़ॉर्म की सीमा उस टोकन का `withdrawableNow` है, जो हर ब्लॉक पर पढ़ा जाता है।

<a id="vault-safety"></a>

### खाते की सुरक्षा

कार्ड एक ही ब्लॉक पर `getProtectedAccount(wallet)`, `getProtectedDelayBounds()`, `paused`, प्रतिबंध स्थिति और `getPendingPayoutIds(wallet)` पढ़ता है; `FunctionDoesNotExist` revert को उपलब्ध नहीं माना जाता है। चालू करना `enableProtectedMode(delaySeconds, protectNfts)` है: तुरंत लागू, विराम के दौरान या पहले से चालू होने पर अस्वीकार, देरी सीमाओं के भीतर (दो से पाँच दिन), और वॉल्ट न हो तो यह उसे बना देता है। अभी लॉक करें `lockVault(wallet)` है: विराम में भी खुला, यह हर रुकी पंक्ति रद्द करता है (`PayoutCancelled`), हर लंबित बदलाव हटाता है और प्रबंधक के प्रस्तावित प्रतिस्थापन को निरस्त करता है। अनलॉक का अनुरोध `requestUnlock(wallet)` है, विराम में या `cooldownUntil` से पहले अस्वीकार, और `pendingUnlockAt` को अभी जमा `delaySeconds` पर रखता है। देय बदलाव लागू करें `finalizeSettingChanges(wallet)` है, जो हर देय बदलाव एक साथ लागू करता है; बंद करना तब तक रुकता है जब तक कोई पंक्ति खुली न रहे (`PendingRowsExist`)। हर कार्रवाई समीक्षा पर और वॉलेट खुलने से पहले फिर से ड्राई-रन होती है, और अंतिम कार्ड Diamond के लॉग से `ProtectedModeEnabled`, `VaultLocked`, `PayoutCancelled`, `SettingChangeRequested` और `SettingChangeApplied` पढ़ता है।

<a id="vault-escape"></a>

### जब प्रोटोकॉल रुका हो

सूचना एक ही ब्लॉक पर `paused`, `VaultPayoutFacet.isEscapeOpen`, `escapeOpensAt` (मैनुअल विराम की शुरुआत जमा वह आपात निकास अवधि जिसके साथ वह शुरू हुआ; कोई लागू न हो या Diamond कभी लॉन्च न हुआ हो तो शून्य) और `getProtectedAccount(wallet)` पढ़ती है, और ब्लॉक के समय के हिसाब से उलटी गिनती करती है। मार्ग बंद रहते विराम में `withdrawFromVault` `EnforcedPause` के साथ revert होता है और समीक्षा बताती है कि विराम इसे रोकता है। `isEscapeOpen` सही होते ही संरक्षित खाता `withdrawFromVault` ही इस्तेमाल करता है, जो कतार में डालना जारी रखता है; किसी भी दूसरे वॉलेट की निकासी `escapeWithdraw(kind, asset, tokenId, amount)` बुलाती है, जो संरक्षित खाते को अस्वीकार करता है (`EscapeNotForProtected`), प्रतिबंधित प्राप्तकर्ता को अस्वीकार करता है, वॉलेट की अपनी जमा राशि और मुक्त आँकड़े से सीमित है, और बुलाने वाले को भुगतान करता है। अंतिम कार्ड `EscapeWithdrawal(account, asset, tokenId, amount)` और वॉल्ट से वॉलेट तक टोकन का अपना ट्रांसफ़र पढ़ता है। अगर विराम, मार्ग या खुले मार्ग में मोड पढ़ा न जा सके, तो कोई निकासी नहीं भेजी जाती।

<a id="protection-addresses"></a>

### सहेजे गए पते

पता-पुस्तिका chain id और वॉलेट के अनुसार `localStorage` में रहती है, कभी ऑन-चेन नहीं। कोई वॉलेट तब जुड़ता है जब वह डोमेन `{name: 'Vaipakam Address Check', version: '1', chainId, verifyingContract: Diamond}` में `AddressControl{account, destination, purpose, nonce, issuedAt}` पर हस्ताक्षर करता है, 32-बाइट के यादृच्छिक nonce और सात दिन की अवधि के साथ। अनुरोध `/protection?prove=<code>` के रूप में जाता है। हस्ताक्षर पेज ऐसा नेटवर्क या Diamond अस्वीकार करता है जिसे यह ऐप नहीं परोसता, और समाप्त अनुरोध भी, और केवल तब हस्ताक्षर करता है जब जुड़ा हुआ खाता उसी चेन पर वही पता हो। चिपकाया गया उत्तर जुड़े वॉलेट के अपने पढ़ने वाले कनेक्शन से `verifyTypedData` द्वारा जाँचा जाता है, इसलिए स्मार्ट वॉलेट ERC-1271 से उत्तर देता है, और वह केवल तभी सहेजा जाता है जब वह उसी अनुरोध का उत्तर हो। पता बॉक्स पूरा पता दिखाता है, पहले और आखिरी अक्षर अलग करके, टूटा EIP-55 checksum अस्वीकार करता है, और बिना किसी छूट के हर वह पता अस्वीकार करता है जिसके पहले तीन और आखिरी तीन hex अंक वॉलेट द्वारा पहले से इस्तेमाल किसी पते (अपना पता, सहेजी और प्रतीक्षित प्रविष्टियाँ, सक्रिय और प्रतीक्षित गंतव्य, सुरक्षित हस्ताक्षरकर्ता, स्वीकृत keeper और नेटवर्क का keeper) से मिलते हों पर बाकी अलग हो। नए पते पर स्पष्ट टिक चाहिए, जिसे कोई भी संपादन हटा देता है।

<a id="protection-destinations"></a>

### भुगतान गंतव्य

यह भाग एक ब्लॉक पर `getProtectedAccount`, `getAllowlist`, `getPendingAllowlistAdditions` (हर अनुरोध उसके `maturesAt` के साथ), `getProtectedSigners`, `paused` और `getPendingPayoutIds` से प्रति प्राप्तकर्ता कतारबद्ध भुगतान पढ़ता है। ब्लॉक के समय और उसके बाद बीते सेकंड के अनुसार, अनुरोध `maturesAt` से पहले प्रतीक्षा में, `maturesAt + delay` तक तैयार और उसके बाद समाप्त होता है। चार बदलाव `addAllowlisted`, `cancelAddAllowlisted`, `finalizeAddAllowlisted` और `removeAllowlisted` हैं, हर एक `(account, destination)` लेता है। समीक्षा एक ब्लॉक पर पढ़ी जाती है और वॉलेट से पहले वही अस्वीकार करती है जो facet अस्वीकार करेगा: विराम या लॉक (जोड़ने और सक्रिय करने के लिए), आपका अपना वॉलेट, पहले से सक्रिय या प्रतीक्षित पता, पहले से पाँच गंतव्य या पाँच अनुरोध, चिह्नित पता, अभी परिपक्व न हुआ या समाप्त अनुरोध। हर कॉल का पूर्वाभ्यास होता है, वॉलेट खुलने से ठीक पहले फिर जाँच होती है, और उसे उसके अपने `AllowlistAddRequested`, `AllowlistAddCancelled`, `AllowlistAdded` या `AllowlistRemoved` लॉग से मापा जाता है; हटाने पर उससे हुए `PayoutCancelled` लॉग भी गिने जाते हैं।

<a id="protection-signers"></a>

### द्वितीयक हस्ताक्षरकर्ता

यह भाग एक ही ब्लॉक पर `getProtectedAccount` (`requireCosign` और `pendingCosignOffAt` सहित), हर हस्ताक्षरकर्ता के `removeAt` के लिए `getSignerChange` के साथ `getProtectedSigners`, `getPendingSignerAdditions` (हर अनुरोधित वॉलेट अपने `maturesAt` और `accepted` के साथ) और `paused` पढ़ता है। बदलाव हैं `addSigner`, `cancelAddSigner`, `finalizeAddSigner`, `requestRemoveSigner`, `cancelRemoveSigner` और `finalizeRemoveSigner`, हर एक `(account, signer)` लेता है; `acceptSignerRole(account)`, जिसे अनुरोधित वॉलेट स्वीकार लिंक (`/protection?signer=<account>&chain=<id>`) से भेजता है; और `setRequireCosign(account, on)`। समीक्षा वॉलेट से पहले वह सब मना करती है जो facet मना करेगा: विराम (रद्द करने को छोड़कर), लॉक या नए मुख्य वॉलेट का कूल-डाउन (अनुरोध, हटाने और सह-हस्ताक्षर बंद करने के लिए), आपका अपना वॉलेट, पहले से हस्ताक्षरकर्ता या पहले से अनुरोधित वॉलेट, रद्द न किया गया समाप्त अनुरोध, पहले से पाँच हस्ताक्षरकर्ता या पाँच अनुरोध, स्वीकार न करने वाला वॉलेट, अधूरी प्रतीक्षा या बीती हुई अवधि, और बिना हस्ताक्षरकर्ता के सह-हस्ताक्षर। हर कॉल का पूर्वाभ्यास होता है, वॉलेट खुलने से ठीक पहले फिर पूछा जाता है, और उसके अपने `SignerAddRequested`, `SignerAccepted`, `SignerAddCancelled`, `SignerAdded`, `SignerRemoveRequested`, `SignerRemoveCancelled`, `SignerRemoved`, `CosignRequirementSet` या `SettingChangeRequested` लॉग से मापा जाता है। प्रतीक्षारत अनुरोधित वॉलेट पता-जाँच की ज्ञात पतों की सूची में जुड़ते हैं।

<a id="my-offers"></a>

### आपके ऑफ़र

सूची `getUserOffersPaginated(wallet)` (हर निर्माता का इंडेक्स, जो रद्द आईडी भी रखता है) और `getUserPositionOffersPaginated(wallet)` (वे ऑफ़र जिनका पोज़िशन टोकन वॉलेट के पास है) का संयोजन है, जिसे `MetricsDashboardFacet.getOffersWithState` से अधिकतम 250 के बैच में पढ़ा जाता है, जो स्थिति-दर-स्थिति उत्तर देता है। हर पंक्ति उसी आईडी से मिलाई जाती है जो माँगी गई थी: बिना पूरा हुए रद्द ऑफ़र का रिकॉर्ड मिट जाता है, इसलिए व्यू आईडी 0 और व्युत्पन्न स्थिति रद्द बताता है, और पंक्ति दोबारा बनाई शर्तों की जगह कोई शर्त नहीं दिखाती। आंशिक पूर्ति के बाद रद्द ऑफ़र अपना रिकॉर्ड `accepted` सेट के साथ रखता है और पूरा पढ़ा जाता है। फ़िल्टर गिनती पढ़ी गई पंक्तियों पर होती है; अगर कोई इंडेक्स अंत तक नहीं पढ़ा जा सका, तो पेज बताता है कि सूची अधूरी हो सकती है।

<a id="offer-book"></a>

### ऑफ़र बुक

बुक इंडेक्सर का `GET /offers/active?chainId&limit=50&before=<offerId>` पढ़ती है, ऑफ़र id के अनुसार सबसे नया पहले, `nextBefore` से पेज-दर-पेज। इंडेक्सर समाप्त हो चुके ऑफ़र को `active` रखता है (चेन पर समाप्ति आलसी है), इसलिए जिस पंक्ति का `expiresAt` बीत चुका है उस पर समाप्त का टैग लगता है। `isSaleVehicle`, `isOffsetVehicle` और `refinanceTargetLoanId` (null = पढ़ा नहीं गया) प्रकार का टैग लगाते हैं, और `positionFlow.movedSinceOpened` हिल चुकी बंधी पोज़िशन का (#3205)। हर फ़ील्ड सटीक रूप से पार्स होती है; जो पंक्ति विफल हो, वह अपठित गिनी जाती है। टैब `assetType` है (0 = ERC-20 लोन, अन्यथा किराया), पक्ष `offerType`। क्वेरी पुश रेल से अमान्य होती है और दिखते रहने तक हर 60 सेकंड फिर पढ़ी जाती है; इंडेक्स की विफलता बताई जाती है, कभी खाली बुक नहीं। बुक तभी माँगी जाती है जब किसी समर्थित नेटवर्क पर वॉलेट जुड़ा हो; उससे पहले पेज वॉलेट जोड़ने को कहता है।

<a id="offer-detail"></a>

### किसी ऑफ़र का पेज

`/offers/:id` एक ही ब्लॉक पर `OfferCancelFacet.getOffer(id)`, `MetricsFacet.getOfferState(id)` और `getOfferLinkedLoanId(id)` पढ़ता है, जुड़े हुए वॉलेट के ज़रिए; वॉलेट जुड़ने से पहले कुछ नहीं पढ़ा जाता। शून्य निर्माता का अर्थ है कि रिकॉर्ड हटा दिया गया (कुछ भी भरे बिना रद्दीकरण) या कभी लिखा ही नहीं गया; प्रोटोकॉल ऑफ़र की गिनती नहीं रखता, इसलिए पेज नहीं बताता कि कौन-सा। शून्य से भिन्न जुड़ा लोन लोन बिक्री (उधारकर्ता का ऑफ़र) या ऑफ़सेट (ऋणदाता का ऑफ़र) दर्शाता है; उधारकर्ता के ऑफ़र का `refinanceTargetLoanId` रीफ़ाइनेंस अनुरोध दर्शाता है। लेना साझा `acceptOffer` प्रवाह चलाता है (हस्ताक्षरित `AcceptTerms`, सटीक अनुमोदन, ड्राई रन, मापा गया परिणाम), अपनी स्टोर कुंजी के अंतर्गत; रद्द करना और साफ़ करना साझा `cancelOffer` प्रवाह चलाते हैं। किराये, NFT कोलैटरल, लोन बिक्री और ऑफ़सेट मौजूदा ऐप से लिंक होते हैं।

<a id="offer-cancel"></a>

### ऑफ़र रद्द करें

समीक्षा एक ही ब्लॉक पर `getOffer(id)`, `getOffersWithState([id])`, `getOfferLinkedLoanId(id)`, `paused()` और निर्माता का `getProtectedAccount` पढ़ती है, फिर `OfferCancelFacet.cancelOffer(id)` का परीक्षण-चलन करती है। फ़ैसेट निर्माता के प्रबंधक को कभी भी, और `expiresAt` बीतने पर किसी को भी रद्द करने देता है; यह `OfferAlreadyAccepted`, `OfferAlreadyConsumedBySale`, और `CancelCooldownActive` से मना करता है जब `amountFilled == 0` वाला ऑफ़र 300 सेकंड से नया हो और समाप्त न हुआ हो, और यह `whenNotPaused` है। वापसी फ़ैसेट की अपनी शाखाओं से आँकी जाती है: ERC-20 उधार ऑफ़र उधार संपत्ति का `(amountMax या amount) - amountFilled` लौटाता है; NFT उधार ऑफ़र अपना टोकन, या ERC-1155 मात्रा; उधार अनुरोध अपनी बिना इस्तेमाल गिरवी `(collateralAmountMax या collateralAmount) - collateralAmountFilled`, या अपना NFT, और कुछ नहीं जब `refinanceCarryOver` गिरवी को ऋण में रखता है; किराया अनुरोध `amount × durationDays` और `rentalBufferBpsAtCreate` पर बफ़र। `getOfferLinkedLoanId` से ऋण से जुड़ा ऑफ़र, या शून्य दर्ज बफ़र वाला किराया अनुरोध (तब प्रोटोकॉल अपनी मौजूदा दर लेता है), हस्ताक्षर से पहले आँका नहीं जाता। हर वापसी वॉल्ट निकासी के ज़रिए निर्माता के वॉल्ट से निकलती है, इसलिए सुरक्षित मोड उसे कतार में डालता है, या खाता लॉक रहने तक वॉल्ट में रखता है। पोज़िशन टोकन रिटायर होता है। अंतिम कार्ड `OfferCanceled(offerId, creator)`, निर्माता के लिए प्रोटोकॉल का भुगतान रिकॉर्ड, और निर्माता को टोकन का अपना ट्रांसफ़र पढ़ता है।

<a id="offers-price-guard"></a>

### मूल्य-परिवर्तन सुरक्षा

ERC-20 ज़मानत के बदले ERC-20 के खुले ऑफ़र पर, बनाने वाला ऑफ़र के पेज से मूल्य-परिवर्तन सुरक्षा लगा, बदल या हटा सकता है। दर्ज होते ही प्रोटोकॉल दोनों टोकनों की ओरेकल कीमतें नोट करता है; उसके बाद हर लेन-देन तब तक अस्वीकार होता है जब तक ज़मानत-से-मूलधन दर उस स्तर से सीमा (0.5% से 50%, किसी भी दिशा में) से ज़्यादा बदल चुकी हो, जब तक जोड़ी पिछली दो घंटेवार मूल्य जाँचों में से किसी के मुक़ाबले शांत सीमा से आगे चली गई हो, या जब तक कोई मौजूदा कीमत या इनमें से कोई जाँच ग़ायब हो। जाँच ऋण बनते समय चलती है, इसलिए सीधा लेना और मैच दोनों शामिल हैं, और पेज सबको सीमा, दर कितनी बदली और अभी लेना संभव है या नहीं, दिखाता है। घंटेवार जाँचें कोई भी लिख सकता है, और प्रोटोकॉल का कीपर खुले सुरक्षित ऑफ़रों की संपत्तियों के लिए उन्हें लिखने के लिए बना है; जब तक दोनों टोकनों के लिए वे मौजूद न हों, कोई ऑफ़र नहीं ले सकता। पोस्ट किए ऑफ़र पर लगी सुरक्षा उसी ब्लॉक से बचाती है जिसमें वह दर्ज होती है, पहले से नहीं; बदलने पर कीमतें फिर से दर्ज होती हैं। यह कुछ नहीं हिलाती और कोई शर्त नहीं बदलती। इसे पोस्ट करते समय ऑफ़र फ़ॉर्म के उन्नत विकल्पों में भी लगाया जा सकता है: गार्ड और पोस्ट एक ही लेन-देन में जाते हैं, इसलिए ऑफ़र कभी बिना गार्ड के बुक पर नहीं होता, और जिस जोड़ी की कीमतें पढ़ी नहीं जा सकतीं वह दोनों को अस्वीकार करती है।

<a id="risk-access"></a>

### Risk Access: आपका जोखिम स्तर

स्विच `getRiskAccessGateEnabled` है। किसी प्रवाह को कौन-सा कदम चाहिए, यह प्रोटोकॉल का अपना उत्तर है: स्वीकृति के लिए `previewOfferAcceptBlock` (1 = स्तर बहुत कम, 2 = जोड़ी सहमति, 3 = सख़्त मोड स्वीकृति, 4 = वह इलिक्विड पेयर जिसे पहले स्वीकृति की स्वीकारोक्ति कवर करती थी; यह 2 की तरह रोकता है और पेयर सहमति इसे हटाती है), जब `previewCreatorBlock` दिखाए कि ऋणदाता रुका नहीं है; अनुरोध के लिए `createOffer` के ड्राई रन का `RiskTierTooLow`, `IlliquidPairNotConsented` या `MidTierPairNotAcknowledged`। कदम एक ही ब्लॉक में पढ़ता है: जोड़ी के लिए `pairRequiredRiskLevel` (ऑफ़र के लिए `acceptMidTierAckPair`), `getVaultRiskTier`, `getEffectiveRiskTier`, `getCurrentRiskTermsVersion` के सामने `getVaultRiskTierVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown` और `getRiskTierMutationNonce`, और जोड़ी के लिए `hasIlliquidPairConsent` के साथ `isPairConsentPending`, या `midTierStrictBlocked` के साथ `isMidTierAckPending`। स्तर बढ़ाना `setVaultRiskTierChecked(level, nonce, termsVersion)` है, जोड़ी की ज़रूरत के न्यूनतम स्तर तक, इसलिए समीक्षा के बाद कोई और स्तर-लेखन या शर्तों का बदलाव आ गया हो तो यह बिना कुछ बदले अस्वीकार होता है। जोड़ी का कदम `setIlliquidPairConsent(pair, true)` या `setMidTierPairAck(pair)` है। प्रतीक्षा में चल रही वृद्धि या लंबित जोड़ी कदम दोबारा नहीं दिया जाता। कोई रीड यह नहीं बताता कि लंबित जोड़ी कदम कब प्रभावी होगा, इसलिए समीक्षा बताती है कि वह यह समय नहीं पढ़ सकती; केवल उसी कदम का समापन कार्ड इसे देता है, रसीद के ब्लॉक के समय और प्रतीक्षा अवधि से। परिणाम रसीद के ब्लॉक पर वापस पढ़ा जाता है।

<a id="terms-gate"></a>

### शर्तों की पुष्टि

`getCurrentTos` उस चेन पर लागू संस्करण और कंटेंट हैश लौटाता है जिस पर कार्रवाई होनी है; संस्करण 0 का मतलब है कोई शर्तें नहीं, और कुछ भी नहीं रुकता। जिस वॉलेट का `hasAcceptedCurrentTerms` false है, उससे नए एक्सपोज़र से पहले पूछा जाता है, और प्रॉम्प्ट `/terms/v<N>` से जोड़ता है, यानी संस्करण-पिन किया पेज जिसका पाठ कभी नहीं बदलता। स्वीकार करना `acceptTerms(version, hash)` को एक बार कॉल करता है। वॉलेट खुलने से पहले यह जोड़ी दोबारा पढ़ी जाती है, इसलिए नया संस्करण दिखाए गए की जगह ले लेता है और किसी दूसरे टैब में दी गई स्वीकृति कार्रवाई को आगे बढ़ने देती है। पढ़ने में विफलता का मतलब है "पुष्टि नहीं हो सकती", दोबारा कोशिश के साथ, कभी "स्वीकार नहीं किया" नहीं। बाहर निकलने वाली कार्रवाइयाँ कभी नहीं रुकतीं।

<a id="settings"></a>

### सेटिंग्स

सेटिंग्स में वह सब है जो आप एक बार तय करते हैं। मोड और थीम इस साइट के लिए इस ब्राउज़र के storage में रहते हैं, और भाषा वहाँ तथा platform की साइटों में साझा `vaipakam_lang` cookie में रहती है; अनुवाद आने तक पेज का अपना language attribute अंग्रेज़ी रहता है। Terms वाली पंक्ति जुड़े नेटवर्क पर `getCurrentTos` और वॉलेट की स्वीकृति पढ़ती है: कोई लागू नहीं, version और text के fingerprint के साथ स्वीकृत, या लागू पर स्वीकृत नहीं, जो पहले gated काम पर पूछा जाता है। पढ़ना विफल हो तो "पुष्टि नहीं हो सकी" और फिर से कोशिश, कभी "स्वीकृत नहीं" नहीं। शुल्क छूट का toggle `setVPFIDiscountConsent` है, वही flow जो Home पर है। इस build में कोई diagnostic capture नहीं है। ब्राउज़र यह भी रखता है कि कौन-से अलर्ट देखे गए, alert channels का रिकॉर्ड, पिछले signed alert request का समय, आख़िरी token pair, बंद किए गए first-run cards और wallet connector का आख़िरी connection; कभी कोई key या signature नहीं। डाउनलोड ऐप के अपने रिकॉर्ड की एक JSON फ़ाइल लिखता है (`app.` या `alpha05.` से शुरू होने वाली keys, और भाषा), उन wallet addresses के नाम देता है जिनके तहत ये रिकॉर्ड रखे जाते हैं, और wallet connector के session items तथा इस साइट के databases को गिनता है पर कॉपी नहीं करता। मिटाना पहले हर wallet connection बंद करता है ताकि connector अपने रिकॉर्ड फिर से न लिख दे, फिर इस साइट का local और per-tab storage हटाता है, जहाँ ब्राउज़र सूची दे सके वहाँ इसके databases मिटाता है, और `vaipakam_lang` cookie को हर उस domain पर expire करता है जहाँ वह set हो सकती है; फिर यह reload होता है और उस tab के लिए दिखाता है कि क्या हटाया गया और ब्राउज़र ने किसे मना किया, कारण के साथ। वह केवल वॉलेट कनेक्टर के "डिस्कनेक्टेड" मार्कर वापस लिखता है, ताकि रीलोड ऐसे वॉलेट को फिर से न जोड़े जो अब भी इस साइट को अनुमति देता है; अगर ब्राउज़र रिपोर्ट को रीलोड तक नहीं रखता, तो पेज रुका रहता है और रिपोर्ट वहीं दिखाता है।

रिस्क एक्सेस एक ही ब्लॉक में `getVaultRiskTier`, `getEffectiveRiskTier`, स्तर के शर्त संस्करण की तुलना `getCurrentRiskTermsVersion` से, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown`, `getRiskStrictMode`, `getStrictModeStrictUntil` और `getRiskAccessGateEnabled` पढ़ता है। यह बताता है कि कौन सा स्तर गिना जाता है और वह चुने गए स्तर से क्यों अलग है: कोई बढ़ोतरी जो अभी प्रतीक्षा में है (वह कब से गिनी जाएगी, उस समय के साथ) या शर्तों में बदलाव (पुष्टि होने तक ब्लू-चिप गिना जाता है)। स्तर बदलना `setVaultRiskTierChecked` है, जो पढ़े गए बदलाव काउंटर और शर्त संस्करण का नाम लेता है, ताकि कहीं और से लिखा गया बदलाव या नई शर्तें उसे अस्वीकार कर दें और कुछ न बदले; बढ़ोतरी अवधि तक प्रतीक्षा करती है और प्रतीक्षा के दौरान दोबारा नहीं दी जाती; घटाना तुरंत होता है। जाँच केवल शुरुआत पर लागू होती है, इसलिए घटाना ऊपर की जोड़ियों को नए ऑफ़र और अनुरोधों के लिए बंद करता है (आपके अपने खुले ऑफ़र लिए नहीं जा सकते) और खुले ऋणों को नहीं छूता। सख़्त मोड `setRiskStrictMode` है: चालू तुरंत; बंद करने पर वह अवधि तक लागू रहता है, और पेज बताता है कब तक। जिस नेटवर्क पर जाँच बंद है, वहाँ बदलाव सहेजा जाता है और जाँच चालू होने पर ही गिना जाता है। हर जोड़ी की सहमतियाँ और स्वीकृतियाँ उन्हीं प्रवाहों में रहती हैं जिन्हें उनकी ज़रूरत है।

अनुमतियाँ एक ही ब्लॉक में हर ERC-20 का `allowance(wallet, Diamond)`, जहाँ Permit2 तैनात है वहाँ Permit2 का `allowance(wallet, token, Diamond)` (समाप्त अनुमति सूची में नहीं आती), हर NFT संग्रह के लिए `isApprovedForAll(wallet, Diamond)`, और हर उस ERC-721 टोकन के लिए `getApproved` पढ़ती है जिसका नाम कोई पोज़िशन लेती है और जो अभी भी वॉलेट के पास है। जाँचे जाने वाले एसेट हैं: सुझाए गए एसेट, `getDepositoryAssets` का हर एसेट, `getUserLoansPaginated` के हर ऋण और `getUserOffersPaginated` के हर ऑफ़र के दोनों पक्ष, हर स्थायी ऑफ़र का उधार दिया गया एसेट, और आपका जोड़ा हुआ कोई भी अनुबंध। 2^255 या उससे अधिक (Permit2 के ज़रिए 2^159) की अनुमति असीमित दिखाई जाती है। वापस लेने पर `approve(Diamond, 0)`, Permit2 का `approve(token, Diamond, 0, 0)`, `setApprovalForAll(Diamond, false)` या `approve(0x0, tokenId)` भेजा जाता है; वॉलेट खुलने से पहले और रसीद के ब्लॉक पर पंक्ति फिर से पढ़ी जाती है। अंत तक न पढ़ा गया रिकॉर्ड, या जवाब न देने वाला एसेट, बताया जाता है, कभी "कोई अनुमति नहीं" के रूप में नहीं दिखाया जाता। स्थायी ऑफ़र का कोलैटरल एसेट भी जाँचा जाता है, और वॉलेट के स्वामित्व वाला ऐसा टोकन जिसका `getApproved` जवाब नहीं देता, अज्ञात गिना जाता है। रसीद, पंक्ति के साथ उसी ब्लॉक पर, उसी एसेट की दूसरी अनुमति पढ़ती है (एक टोकन के लिए `isApprovedForAll`, कलेक्शन के लिए मिले टोकनों का `getApproved`, ERC-20 के लिए Permit2 का `allowance`, Permit2 अनुमति के लिए ERC-20 का `allowance`) और बताती है कि वह बनी रहती है, या कि वह अज्ञात है; वॉलेट खुलने से पहले उसमें बदलाव हस्ताक्षर रोक देता है।

कीपर सेक्शन एक ही ब्लॉक पर `getKeeperAccess`, `getApprovedKeepers` और हर मंज़ूर कीपर (अधिकतम पाँच) के लिए `getKeeperActions` पढ़ता है। कार्रवाइयाँ प्रोटोकॉल के बिट हैं। लेंडर पोज़िशन की बिक्री पूरी करना (0x01), ऑफ़सेट से जल्दी बंद करना पूरा करना (0x02), लेंडर पोज़िशन की बिक्री शुरू करना (0x04), जल्दी बंद करना शुरू करना (0x08) और तय सीमाओं में बढ़ाना (0x20) किसी लोन पर तभी काम करते हैं जब वह लोन या ऑफ़र भी उस कीपर को चालू करे; कीपर माँगने वाले स्थायी लेंडिंग ऑफ़र भरना (0x40), चुकाया गया पैसा वापस स्थायी ऑफ़र में डालना (0x80) और सुरक्षित खाते को लॉक करना (0x100) एक्सेस चालू होते ही पूरे खाते के लिए काम करते हैं। बिट 0x10 रिटायर है और अस्वीकार होता है। बदलाव `setKeeperAccess`, `approveKeeper`, `setKeeperActions` या `revokeKeeper` भेजते हैं; जो बदलाव कीपर को ज़्यादा देता है वह लागू संस्करण होने पर शर्तें माँगता है, हटाना कभी नहीं, और प्रोटोकॉल रुका होने पर हर बदलाव, हटाना भी, अस्वीकार होता है। इस ऐप का कीपर डिप्लॉयमेंट रिकॉर्ड से बताया जाता है।

ऐप एक वेब मैनिफ़ेस्ट (`/manifest.webmanifest`) के साथ आता है जिसमें चारों शॉर्टकट और एक मास्केबल आइकन हैं। सेटिंग्स › Install the app में बटन तभी दिखता है जब ब्राउज़र अपना `beforeinstallprompt` इवेंट चलाता है, और वह वही प्रॉम्प्ट खोलता है; वरना पेज स्थिति बताता है (इंस्टॉल है, iOS, या पेश नहीं किया गया)। डिप्लॉय किया गया बिल्ड `/sw.js` रजिस्टर करता है, जो उसी बिल्ड के आउटपुट से लिखा जाता है: पेज जब पहली बार बिल्ड की कोई हैश वाली `/assets/` फ़ाइल माँगता है तो वह उसकी कॉपी रखता है, उस फ़ाइल की बाद की माँगों का जवाब कॉपी से देता है, कमान लेते समय पुराने बिल्ड के स्टोर मिटाता है, और कभी भी नेविगेशन, किसी दूसरे ओरिजिन की माँग या अपनी सूची से बाहर की फ़ाइल का जवाब नहीं देता। "इस ब्राउज़र में आपका डेटा" इन स्टोर को गिनता और मिटाता है।

<a id="rent-review"></a>

### किराया: NFT किराये पर लेना

समीक्षा लिस्टिंग को `getOffer` (उसका `rentalBufferBpsAtCreate`) से, प्रोटोकॉल का फ़ैसला और दैनिक शुल्क `previewAccept` से पढ़ती है, और `getRiskConfig` केवल उस लिस्टिंग के लिए जिसने अपना बफ़र दर्ज नहीं किया। कुल `amount × durationDays` और वह हिस्सा है, प्रोटोकॉल की तरह नीचे की ओर पूर्णांकित, और ड्राई रन साबित करता है कि दोनों मेल खाते हैं। किराया `acceptOffer` है, हस्ताक्षरित `AcceptTerms` के साथ जो NFT को स्वीकार किया गया इलिक्विड पक्ष बताते हैं और कोई कोलैटरल पक्ष नहीं; उपयोग का अधिकार रसीद के ब्लॉक पर मालिक के वॉल्ट से `vaultGetNFTUserOf` से, या ERC-1155 के लिए `vaultGetNFTQuantity` से वापस पढ़ा जाता है।

<a id="rent-risks"></a>

### किराया: जोखिम

किराये का NFT कभी आपका नहीं होता, और उसे इस्तेमाल करने का आपका अधिकार किराये के साथ ख़त्म हो जाता है। किराया और बफ़र किराये के लिए आपके वॉल्ट में रहते हैं और उसके खुले रहते निकाले नहीं जा सकते। तय सभी दिन निपट जाने पर, जो कोई भी कर सकता है, किराया अपने आप बंद हो जाता है और आप अपना बफ़र क्लेम कर सकते हैं। तब तक उसे ख़ुद उसके पोज़िशन पेज से बंद करें। ग्रेस अवधि में बंद करने पर बफ़र से विलंब शुल्क लगता है; ग्रेस अवधि के बाद किराया डिफ़ॉल्ट हो जाता है, आपके वॉल्ट में बचा किराया मालिक को और बफ़र प्रोटोकॉल को जाता है, और आपको कुछ वापस नहीं मिलता। पूरी अवधि वाले किराये में जल्दी बंद करने पर भी पूरी अवधि देनी होती है।

<a id="rent-list"></a>

### किराया: अपना NFT किराये पर देना

फ़ॉर्म कलेक्शन का मानक ERC-165 `supportsInterface` से और सबसे लंबी अवधि `getProtocolConfigBundle` से पढ़ता है। समीक्षा टोकन को `ownerOf`, `getApproved` और `isApprovedForAll` से (ERC-1155 के लिए `balanceOf`), भुगतान टोकन की श्रेणी `getAssetPriceStatus` और लिक्विडिटी जाँच से, बफ़र हिस्सा `getRiskConfig` से, ग्रेस अवधि `getEffectiveGraceSeconds` से और प्रोटोकॉल का हिस्सा `getTreasuryFeeBps` से पढ़ती है, फिर `createOffer` का ड्राई रन करती है: `assetType` 1 या 2, `amount` और `amountMax` दोनों दैनिक शुल्क, हर कोलैटरल और ब्याज फ़ील्ड शून्य और `prepayAsset` भुगतान टोकन। पोस्ट करना `rentalBufferBpsAtCreate` दर्ज करता है; परिणाम लेन-देन के `OfferCreated` लॉग और मालिक के वॉल्ट में NFT के अपने `Transfer` (या `TransferSingle`) लॉग से पढ़ा जाता है।

<a id="rent-list-risks"></a>

### किराया: किराये पर देने के जोखिम

लिस्टिंग खुली रहने तक और किराये पर रहने तक NFT आपके वॉल्ट में रहता है, और लिस्टिंग या किराया ख़त्म होने तक आप उसे निकाल नहीं सकते। जब तक किसी ने उसे किराये पर नहीं लिया, आप पहले पाँच मिनट के बाद उसके पेज से लिस्टिंग रद्द कर सकते हैं। किराये पर जाने के बाद किराया ख़त्म होने तक NFT इस्तेमाल करने का अधिकार किरायेदार के पास रहता है, और आप उसे पहले वापस नहीं ले सकते। हर पूरा हुआ दिन निपटने पर किराया, प्रोटोकॉल का हिस्सा घटाकर, आपके वॉल्ट में आता है; कोई भी उसे निपटा सकता है। तय सभी दिन निपट जाने पर किराया अपने आप बंद हो जाता है, और किरायेदार बफ़र वापस क्लेम कर सकता है। उससे पहले किरायेदार उसे बंद कर सकता है, या ग्रेस अवधि के बाद कोई भी उसे डिफ़ॉल्ट के रूप में बंद कर सकता है। किरायेदार बंद करे, तो आप अभी तक न निपटा किराया और कोई विलंब शुल्क, प्रोटोकॉल का हिस्सा घटाकर, क्लेम कर सकते हैं, और बाकी बफ़र किरायेदार को लौटता है। डिफ़ॉल्ट पर आप बचा किराया, वह हिस्सा घटाकर, क्लेम कर सकते हैं, और बफ़र प्रोटोकॉल को जाता है। प्रोटोकॉल रुका हो तो दैनिक निपटान रुकता है और विलंब शुल्क व डिफ़ॉल्ट की तारीखें आगे खिसकती हैं, पर किरायेदार का इस्तेमाल कभी नहीं बढ़ता। समाप्त हुई लिस्टिंग बंद होने तक NFT को आपके वॉल्ट में रखती है।

<a id="rent-request"></a>

### किराया: कोई NFT किराये पर माँगना

फ़ॉर्म कलेक्शन का मानक ERC-165 `supportsInterface` से और सबसे लंबी अवधि `getProtocolConfigBundle` से पढ़ता है। समीक्षा टोकन का धारक `ownerOf` से पढ़ती है (ERC-1155 की कोई धारक सूची नहीं होती), भुगतान टोकन की श्रेणी `getAssetPriceStatus` और तरलता जाँच से, भुगतान टोकन में वॉलेट का `balanceOf` और `allowance`, बफ़र हिस्सा `getRiskConfig` से और ग्रेस अवधि `getEffectiveGraceSeconds` से, फिर `createOffer` का ड्राई रन करती है, जिसमें `offerType` 1, `assetType` 1 या 2, `amount` और `amountMax` दोनों दैनिक शुल्क, हर कोलैटरल और दर फ़ील्ड शून्य और `prepayAsset` भुगतान टोकन होता है। पोस्ट करना `rentalBufferBpsAtCreate` दर्ज करता है और दैनिक शुल्क गुणा अवधि और वह हिस्सा किरायेदार के वॉल्ट में खींचता है; नतीजा लेनदेन के `OfferCreated` लॉग और वॉल्ट में भुगतान टोकन के `Transfer` लॉग से पढ़ा जाता है।

<a id="rent-request-risks"></a>

### किराया: किराये के अनुरोध के जोखिम

अनुरोध खुला रहने तक किराया और बफ़र आपके वॉल्ट में रहते हैं, और जब तक आप उसे रद्द न करें या वह ख़त्म न हो, आप उन्हें निकाल नहीं सकते। जब तक किसी मालिक ने उसे स्वीकार नहीं किया, आप पहले पाँच मिनट के बाद उसके पेज से अनुरोध रद्द कर सकते हैं, और वे आपके वॉलेट में लौट आते हैं। स्वीकार करने वाला मालिक किराया तुरंत ठीक इन्हीं शर्तों पर शुरू करता है: आपके पास NFT इस्तेमाल करने का अधिकार होता है, NFT ख़ुद कभी नहीं। तय सभी दिन निपट जाने पर, जो कोई भी कर सकता है, किराया अपने आप बंद हो जाता है और आप अपना बफ़र क्लेम कर सकते हैं; तब तक उसे उसके पोज़िशन पेज से बंद करें। देर से बंद करने पर बफ़र से विलंब शुल्क कटता है, और डिफ़ॉल्ट होने पर किराया मालिक को और बफ़र प्रोटोकॉल को जाता है। समय-सीमा बीत चुका अनुरोध बंद होने तक किराया और बफ़र आपके वॉल्ट में रखता है। बफ़र का हिस्सा वह प्रोटोकॉल सेटिंग है जो अनुरोध दर्ज होते समय लागू हो: अगर आपकी समीक्षा के बाद वह बदलती है, तो ऊँचा हिस्सा अस्वीकार होता है जब आपके वॉलेट ने ठीक यही राशि मंज़ूर की हो, और ले लिया जाता है जब कोई पुरानी मंज़ूरी उसे कवर करती हो; परिणाम बताता है कि क्या गया।

<a id="rent-take"></a>

### किराया: किरायेदार का अनुरोध स्वीकार करना

समीक्षा अनुरोध को `getOffer` से पढ़ती है (उसका `rentalBufferBpsAtCreate`), प्रोटोकॉल का फ़ैसला `previewAccept` से, दोनों पक्षों की जोखिम सेटिंग, ग्रेस अवधि `getEffectiveGraceSeconds` से, प्रोटोकॉल का हिस्सा `getTreasuryFeeBps` से, और `getRiskConfig` केवल उस अनुरोध के लिए जिसने बफ़र दर्ज नहीं किया। `previewAccept` यह नहीं जाँचता कि NFT किसके पास है, इसलिए ऐप इसे `ownerOf`, `getApproved` और `isApprovedForAll` से पढ़ता है (ERC-1155 के लिए `balanceOf` और `isApprovedForAll`)। स्वीकार करना हस्ताक्षरित `AcceptTerms` के साथ `acceptOffer` है: प्रोटोकॉल NFT को मालिक के वॉलेट से उसके वॉल्ट में ले जाता है और अवधि ख़त्म होने तक किरायेदार को उसका उपयोगकर्ता दर्ज करता है। नतीजा लेन-देन के लॉग से (इस अनुरोध से खुला किराया और मालिक के वॉल्ट में NFT का `Transfer` या `TransferSingle`) और रसीद के ब्लॉक पर `vaultGetNFTUserOf` से पढ़ा जाता है। हर पूरे हुए दिन का भुगतान `autoDeductDaily(loanId)` करता है, जिसे प्रोटोकॉल न रुका हो तो कोई भी कॉल कर सकता है; यह मालिक पोज़िशन NFT के धारक के वॉल्ट में जाता है, और बाकी बंद होने पर क्लेम होता है।

<a id="rent-take-risks"></a>

### किराया: अनुरोध स्वीकार करने के जोखिम

पूरे किराये के दौरान NFT आपके वॉल्ट में रहता है, और किराया खुला रहते आप उसे निकाल नहीं सकते। किरायेदार के पास किराया ख़त्म होने तक उसे इस्तेमाल करने का अधिकार रहता है, और आप वह अधिकार पहले वापस नहीं ले सकते। शर्तें अनुरोध की अपनी हैं: आप दैनिक शुल्क, अवधि, किराये का नियम या बफ़र नहीं बदल सकते। हर पूरा हुआ दिन निपटने पर किराया, प्रोटोकॉल का हिस्सा घटाकर, आपके वॉल्ट में आता है; कोई भी उसे निपटा सकता है। तय सभी दिन निपट जाने पर किराया अपने आप बंद हो जाता है, और किरायेदार बफ़र वापस क्लेम कर सकता है। उससे पहले किरायेदार उसे बंद कर सकता है, या ग्रेस अवधि के बाद कोई भी उसे डिफ़ॉल्ट के रूप में बंद कर सकता है। किरायेदार बंद करे, तो आप अभी तक न निपटा किराया और कोई विलंब शुल्क, प्रोटोकॉल का हिस्सा घटाकर, क्लेम कर सकते हैं, और बाकी बफ़र किरायेदार को लौटता है। डिफ़ॉल्ट पर आप बचा किराया, वह हिस्सा घटाकर, क्लेम कर सकते हैं, और बफ़र प्रोटोकॉल को जाता है। प्रोटोकॉल रुका हो तो दैनिक निपटान रुकता है और विलंब शुल्क व डिफ़ॉल्ट की तारीखें आगे खिसकती हैं, पर किरायेदार का इस्तेमाल कभी नहीं बढ़ता। जिस अनुरोध ने अपना कोई बफ़र दर्ज नहीं किया, वह किराया शुरू होने पर आज की सेटिंग लेता है।

<a id="rent-close"></a>

### किराया: किराया बंद करना

चल रहे किराये का पेज आपको, किरायेदार के रूप में, किराया बंद करें देता है। बंद करने पर बकाया किराया और कोई विलंब शुल्क उस किराये और बफ़र से चुकता होता है जो आपने पहले से अपने वॉल्ट में जमा किया था, इसलिए आपके वॉलेट से कुछ नहीं लिया जाता और कोई अनुमति नहीं चाहिए। समीक्षा दिखाती है कि अभी बंद करने पर और थोड़ी देर बाद के एक समय पर कितना किराया बकाया होगा, जो किराये के नियम से गिना जाता है (आनुपातिक: शुरुआत से इस्तेमाल हुए दिन, अधूरा दिन पूरा गिना जाता है, पहले से निपटे दिन घटाकर; पूरी अवधि: हर तय दिन जो अभी निपटा नहीं), पहले से निपटे दिन, कोई विलंब शुल्क, क्लेम के रूप में आपको क्या वापस मिलेगा, और मालिक को क्या मिलेगा: किराया और विलंब शुल्क, प्रोटोकॉल का हिस्सा घटाकर। अगर अग्रिम भुगतान बंद करने के लिए काफ़ी नहीं है, तो समीक्षा आपका वॉलेट खुलने से पहले बता देती है। फिर आपका वॉलेट एक बार किराया बंद करने को कहता है, जिसे ऐप पहले ड्राई रन में आज़माता है। उसके बाद ऐप चेन पर जाँचता है कि किराया बंद हुआ, आपके लिए कौन-सा क्लेम दर्ज हुआ और आपका इस्तेमाल ख़त्म हुआ। जो वापस मिलता है उसे Claims पेज पर लें।

समीक्षा किराये को `getLoanDetails` से, उसकी तारीख़ें `getLoanDeadlines` से और विलंब शुल्क `calculateRepaymentAmount` से पढ़ती है, जो किराये पर केवल विलंब शुल्क होता है। प्रोटोकॉल किराये की कोई रकम प्रकाशित नहीं करता, इसलिए ऐप उसे `repayLoan` के नियम से `startTime`, `lastDeductTime` और `durationDays` से गिनता है। बंद करना `repayLoan(loanId)` है, जिसे केवल किरायेदार ग्रेस अवधि ख़त्म होने से पहले बुला सकता है। नतीजा `LoanRepaid` लॉग, `getClaimable(loanId, false)` और रसीद के ब्लॉक पर `vaultGetNFTUserOf` से पढ़ा जाता है।

<a id="rent-close-risks"></a>

### किराया: बंद करने के जोखिम

बंद करते ही NFT इस्तेमाल करने का आपका अधिकार ख़त्म हो जाता है, भले तय दिन बाकी हों, और इसे वापस नहीं लिया जा सकता। किराया तब गिना जाता है जब बंद करना चेन पर दर्ज होता है, इसलिए उससे पहले शुरू हुआ दिन पूरा दिन गिना जाता है; पूरी अवधि वाले किराये में हर तय दिन जो अभी निपटा नहीं, चुकाना पड़ता है, चाहे आप कितना भी जल्दी बंद करें। अवधि ख़त्म होने के बाद आपके बफ़र से विलंब शुल्क लिया जाता है: पूरे किराये का 1% और हर देर वाले दिन का 0.5%, अधिकतम 5% और कभी बफ़र से ज़्यादा नहीं। ग्रेस अवधि के बाद प्रोटोकॉल बंद करना ठुकरा देता है; तब किराया या तो अपने बचे दिनों के एक-एक करके निपटने पर ख़त्म होता है, जो कोई भी कर सकता है, या डिफ़ॉल्ट से, जो भी पहले हो। समीक्षा जो बाद का समय दिखाती है वह कोई समय-सीमा या ऊपरी सीमा नहीं है: जो बंद करना बाद में दर्ज होता है उसकी गिनती तभी होती है, इसलिए ज़्यादा किराया या ज़्यादा विलंब शुल्क लिया जा सकता है और आपको कम वापस मिलता है। जो वापस मिलता है वह आपके अपने वॉल्ट में क्लेम के रूप में तब तक रहता है जब तक आप उसे न लें।

<a id="rewards-vpfi"></a>

### रिवॉर्ड: वॉल्ट में VPFI

पेज `getVPFIToken` से टोकन पढ़ता है; शून्य पता बताता है कि उस नेटवर्क पर VPFI सेट नहीं है। एक ही ब्लॉक पर यह वॉलेट का `balanceOf`, `getUserVaultAddress` से वॉल्ट, `getTrackedVPFIBalance` से गिना गया VPFI, `withdrawableNow` से मुक्त राशि और वॉल्ट का अपना `balanceOf` पढ़ता है। रोका गया हिस्सा गिनी गई राशि में से मुक्त राशि घटाकर है; बिना गिना हिस्सा वॉल्ट का वह बैलेंस है जो गिनी गई राशि से ऊपर है। “VPFI जमा करें” वॉल्ट का सामान्य `depositToVault` है और “VPFI निकालें” उसका `withdrawFromVault` (प्रोटोकॉल रुका हो और एस्केप रूट खुला हो तो, सुरक्षित मोड के बाहर वाले खाते के लिए `escapeWithdraw`), न कि केवल-VPFI वाले रास्ते: सामान्य रास्ते भी स्तर के लिए VPFI को उसी तरह दर्ज करते हैं, और एस्केप रूट केवल उन्हीं में है। हर समीक्षा अपने ब्लॉक पर `getTrackedVPFIBalance` और `getVPFIDiscountConsent` पढ़ती है, और नतीजा ट्रांज़ैक्शन से मापा जाता है। साथ में `isCanonicalVpfiChain` भी पढ़ा जाता है: केवल VPFI का होम नेटवर्क अपने गिने गए VPFI से स्तर तय करता है, और बाकी नेटवर्क उस स्तर की कैश की गई प्रति लागू करते हैं, इसलिए वहाँ पेज और हर रसीद बताती है कि किसी कदम से स्तर नहीं बदलता।

<a id="rewards-vpfi-risks"></a>

### रिवॉर्ड: VPFI ले जाने के जोखिम

स्तर आज का बैलेंस नहीं है। जब तक आपकी मौजूदा लगातार होल्डिंग न्यूनतम दिनों तक न पहुँचे, यह शून्य रहता है; उसके बाद यह रोज़ के अंतिम बैलेंस के हाल-भारित औसत पर चलता है; और इसे आपकी मौजूदा होल्डिंग के किसी भी दिन के सबसे निचले स्तर तक सीमित किया जाता है, अधिकतम 30 दिन पीछे देखकर। ये दो अलग-अलग पीछे देखने की अवधियाँ हैं। गिने गए VPFI का हिस्सा निकालने से उस दिन का सबसे कम बैलेंस घटता है, जिसे यह सीमा पढ़ती है, और सब निकालने पर होल्डिंग समय फिर शुरू होता है। और जोड़ने से यह फिर शुरू नहीं होता। लोन, ऑफ़र, क्लेम या भुगतान के लिए रोका गया VPFI छूटने तक नहीं निकाला जा सकता। सुरक्षित खाते की निकासी आपके गिने गए VPFI और आपके स्तर को तभी बदलती है जब वह छूटती है, और रद्द की गई निकासी इनमें से कुछ नहीं बदलती। आपके वॉल्ट का VPFI कोलैटरल नहीं है। प्रोटोकॉल VPFI नहीं बेचता, उसकी कोई कीमत नहीं बताता और उसे रखने के लिए कुछ नहीं देता।

<a id="rewards-tier"></a>

### रिवॉर्ड: फ़ीस-छूट टियर

एक ही ब्लॉक पर कार्ड `getVPFIDiscountConsent`, `isCanonicalVpfiChain` और `getEffectiveDiscount` पढ़ता है, जो वह टियर और छूट लौटाता है जो फ़ीस पाथ लागू करता है: सहमति बंद होने पर शून्य, 50% पर सीमित, और दूसरे नेटवर्क पर होम नेटवर्क से भेजी गई कॉपी। उसी ब्लॉक पर यह `explainTier` और `getTwaConfig` पढ़ता है। `explainTier` सहमति चाहे जो हो, वह टियर लौटाता है जो केवल गिना गया VPFI देता है, हर होल्डिंग नियम का आँकड़ा और वह नियम जो प्रभावी टियर को उससे नीचे रखता है; कार्ड वह नियम तभी बताता है जब व्याख्या वही टियर देती है जो फ़ीस पाथ लागू करता है, और सहमति बंद होने पर बताता है कि उसे चालू करने पर कौन-सा टियर लागू होता। Advanced हर नियम का आँकड़ा और `getTwaConfig` से मिली सेटिंग्स दिखाता है, जिसमें औसत की अवधि और पीछे देखने की अवधि दो अलग लंबाइयाँ हैं। तालिका एक ही ब्लॉक पर `getVpfiTierThresholds`, `getVpfiTierDiscountBps` और `getFeesConfig` पढ़ती है। टियर 1 से 3 अपनी सीमा से शुरू होते हैं और टियर 4 अपनी सीमा के ऊपर से। हर फ़ीस सूची फ़ीस गुणा एक घटा सीमित छूट है, सटीक रूप से निकाली गई। तालिका केवल होम नेटवर्क पर दिखाई जाती है, जहाँ टियर तय होते हैं।

<a id="rewards-vpfi-sign"></a>

### रिवॉर्ड: स्वीकृति की जगह हस्ताक्षर

अपने ही ब्लॉक पर समीक्षा पढ़ती है कि Permit2 के मानक पते पर कोड है या नहीं, और VPFI टोकन के लिए वॉलेट की Permit2 को दी गई ERC-20 `allowance`। "स्वीकृति की जगह हस्ताक्षर करें" तभी दिया जाता है जब Permit2 तैनात हो और वह allowance राशि को पूरा करे; वरना Advanced बताता है कि दोनों में से क्या कमी है। वॉलेट VPFI टोकन और ठीक उतनी राशि के लिए Permit2 का `PermitTransferFrom` हस्ताक्षरित करता है, Diamond को खर्च करने वाले के रूप में, एक रैंडम nonce के साथ जिसे `nonceBitmap` से अप्रयुक्त जाँचा गया है, और नवीनतम ब्लॉक के 30 मिनट बाद की समय-सीमा के साथ। ऐप हस्ताक्षर के साथ `depositVPFIToVaultWithPermit` का ड्राई रन करता है, फिर उसे भेजता है; प्रोटोकॉल किसी दूसरे टोकन का परमिट अस्वीकार करता है। परिणाम `VPFIDepositedToVault` से मापा जाता है, जिसे यह एंट्री `VaultDeposited` की जगह जारी करती है, और वॉल्ट में टोकन के ट्रांसफ़र से। दोनों रास्ते टियर के लिए VPFI को एक ही तरह गिनते हैं।

<a id="desk-markets"></a>

### Rate desk: बाज़ार और दर सीढ़ियाँ

बाज़ार सूची इंडेक्स का बाज़ार सारांश है: खुले, अवधि-शेष ERC-20 बनाम ERC-20 ऑफ़र में से, बिक्री और ऑफ़सेट वाहनों को छोड़कर, उधार दी गई संपत्ति, गिरवी संपत्ति और अवधि का हर अलग संयोजन, सबसे गहरे पहले और एक सीमा तक, हर तरफ़ की गिनती और सबसे अच्छी दर के साथ (ऋणदाताओं का सबसे कम `interestRateBps`, उधारकर्ताओं का सबसे ऊँचा `interestRateBpsMax`)। इन गिनतियों में सक्रिय हस्ताक्षरित ऑर्डर शामिल हैं, जिन्हें Rate desk सीढ़ी से अलग सूचीबद्ध करता है (अगला भाग); जहाँ किसी बाज़ार की गिनती उसकी सीढ़ी पर सूचीबद्ध संख्या से अलग हो, वहाँ सीढ़ी दोनों बताती है। सीढ़ी `excludeExpired`, `excludeSaleVehicles` और `excludeOffsetVehicles` के साथ इंडेक्स से उस बाज़ार के खुले ऑफ़र 50-50 के अधिकतम चार पेज पढ़ती है, और बताती है कि बाज़ार में इससे अधिक थे। ऋणदाता का ऑफ़र अपनी न्यूनतम दर पर और उधारकर्ता का अनुरोध अपनी अधिकतम सीमा पर रहता है, जो उसकी दर और अधिकतम दर में से ऊँची है। किसी पायदान की खुली राशि हर ऑफ़र की ऊपरी राशि में से भरे गए हिस्से को घटाकर जोड़ती है। ऐप इन्हें भी छोड़ता है और कारण के अनुसार गिनता है: अपनी घड़ी से समाप्त ऑफ़र, इंडेक्स द्वारा अब भी लौटाए गए वाहन, खुलने के बाद हिली ऋण स्थिति से बँधे ऑफ़र (#3205), जिनमें कुछ खुला न बचा हो, और दूसरी शर्तों वाली पंक्तियाँ। मध्य दर सबसे अच्छे ask और सबसे अच्छे bid का औसत है, जो एक बेसिस पॉइंट के दसवें हिस्से तक सटीक रखा जाता है; जब सबसे अच्छा bid सबसे अच्छे ask के बराबर या ऊपर हो, तो सीढ़ी बताती है कि दोनों तरफ़ एक-दूसरे पर चढ़ती हैं, और उसके नीचे मिलान पट्टी मिलाने के लिए एक जोड़ी पेश करती है (नीचे उसका भाग देखें)। हर ऑफ़र अपने पेज से जुड़ता है, जो उसकी स्थिति और शर्तें चेन से पढ़ता है।

<a id="desk-signed-book"></a>

### Rate desk: किसी बाज़ार के हस्ताक्षरित ऑर्डर

सूची बाज़ार के लिए इंडेक्स का `/signed-offers` बिना `signer` के पढ़ती है, इसलिए उसमें हर मेकर के ऑर्डर होते हैं: हर तरफ़ सबसे अच्छी कीमत वाली 100 पंक्तियाँ, `truncated` बताते हुए। हर पंक्ति को मानक वायर रूप में फिर से सीरियलाइज़ होना चाहिए, उसका `orderHash` ऑर्डर से दोबारा गणना किए गए EIP-712 स्ट्रक्ट हैश के बराबर होना चाहिए, उसमें बाज़ार के टोकन और अवधि होने चाहिए, और उसका हस्ताक्षर 65-बाइट ECDSA हस्ताक्षर होना चाहिए; कोई भी दूसरी पंक्ति अपठनीय गिनी जाती है। asks को `interestRateBps` के बढ़ते क्रम में और bids को `interestRateBps` और `interestRateBpsMax` में से बड़े के घटते क्रम में रखा जाता है, बराबर दरों के बीच बुक का क्रम बना रहता है। हर ऑर्डर की स्थिति एक ही ब्लॉक पर उसी नियम से पढ़ी जाती है जो आपके अपने हस्ताक्षरित ऑर्डरों पर लगता है, जिसका वर्णन नीचे है। उसी ब्लॉक पर ऐप हर मेकर और दाँव वाली संपत्ति के लिए एक बार `freeHolding(signer, ERC20, stakeAsset, 0)` पढ़ता है, और हर भरे जा सकने वाले ऑर्डर के लिए उसकी तुलना बाकी हिस्से की भराई से निकलने वाली राशि से करता है: ऋणदाता की अधिकतम सीमा में से भरा हुआ घटाकर, या उधारकर्ता के लिए उस बाकी हिस्से का संपार्श्विक ऑर्डर के अपने अनुपात पर, ऊपर की ओर पूर्णांकित। विफल पठन को अज्ञात बताया जाता है, कभी शून्य नहीं। हर ऑर्डर को अकेले पूरे मुक्त शेष से तौला जाता है, इसलिए एक मेकर के दो ऑर्डर दोनों ढके हुए दिख सकते हैं जबकि वॉल्ट में केवल एक के लिए पर्याप्त हो। किसी और के हस्ताक्षर वाला खुला ऑर्डर पूरा भरा जा सकता है। समीक्षा `previewSignedOfferAccept(order, signature, acceptor)` पढ़ती है, जो उस ऑफ़र का स्वीकृति पूर्वावलोकन लौटाता है जिसे भराई लिखेगी, साथ में ऑर्डर का हैश, स्टेक एसेट, वह स्टेक जो भराई मेकर के वॉल्ट से निकालेगी, और उस वॉल्ट का मुक्त शेष; इसके इनकार (इनमें `SignedOfferMakerShort`, `SignedOfferConsumed` और `SignedOfferNonceUsed`) नाम से बताए जाते हैं और सहमति रोकते हैं। Terms हस्ताक्षर ऑर्डर के हैश से उसके `offerKey` के रूप में बँधा होता है, और भेजा जाता है `acceptSignedOffer(order, signature, terms, termsSignature)`, जो पूरा ऑर्डर खपाता है, मेकर के वॉल्ट से ऑफ़र लिखता है और एक ही लेन-देन में लोन खोलता है। समीक्षा `previewSignedOfferRiskBlocks(order, acceptor)` (#3577) भी पढ़ती है, जो `previewOfferAcceptBlock` के कोड में मेकर की रोक, स्वीकार करने वाले की रोक और वह जोड़ी लौटाता है जिस पर दोनों जाँचे जाते हैं। मेकर की रोक बताई जाती है और कोई कदम दिए बिना सहमति रोकती है; स्वीकार करने वाले की रोक कुछ भी हस्ताक्षर होने से पहले लौटाई गई जोड़ी के लिए जोखिम कदम खोलती है। यदि यह पढ़ना विफल हो (जिस Diamond में यह नहीं है वह `FunctionDoesNotExist` लौटाता है), तो समीक्षा बताती है कि `acceptSignedOffer` का ड्राई रन जाँच करता है, और वहाँ इनकार (`RiskTierTooLow`, `IlliquidPairNotConsented`, `MidTierPairNotAcknowledged`) ऑर्डर की जोड़ी के लिए जोखिम कदम तभी खोलता है जब त्रुटि स्वीकार करने वाले का नाम लेती है। समापन कार्ड ऑर्डर के हैश के लिए Diamond का `SignedOfferFilled` ढूँढता है और उससे लोन पढ़ता है। आंशिक रूप से मिलाया गया ऑर्डर `SignedOfferConsumed` बताता है और नहीं दिया जाता; आपके अपने ऑर्डर भी नहीं। जवाब का `awaitingReplay` उन ऑर्डरों को गिनता है जिन्हें इंडेक्स तब तक रोकता है जब तक पुनर्गठन के बाद का पुनर्निर्माण चेन से उनकी भराइयाँ और रद्दीकरण फिर से पढ़ता है (#3411); शून्य से ऊपर की गिनती सूची के साथ बताई जाती है, और जो मान ऋणेतर पूर्णांक नहीं है उसे अज्ञात बताया जाता है।

<a id="desk-match"></a>

### Rate desk: ओवरलैप का मिलान

पट्टी सीढ़ी के ओवरलैप होने वाले पायदानों की जोड़ी बनाती है: सबसे अच्छे bid पर या उससे नीचे के ऋणदाता ऑफ़र, सबसे अच्छे ask पर या उससे ऊपर के उधारकर्ता अनुरोधों के साथ; एक ही वॉलेट की जोड़ियाँ और वे जोड़ियाँ छोड़ दी जाती हैं जिनकी दर सीमाएँ नहीं मिलतीं: प्रोटोकॉल केवल वहीं मिलान करता है जहाँ दोनों निचली सीमाओं में से ऊँची, दोनों ऊपरी सीमाओं में से निचली के बराबर या उससे नीचे हो। जहाँ दोनों तरफ़ ओवरलैप हों पर कोई सीमा न मिले, वहाँ पट्टी बताती है कि कुछ भी मिलाया नहीं जा सकता। एक ही ब्लॉक पर यह `getPartialFillEnabled`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps` और `getCapacityCurve(0)` पढ़ती है, और केवल स्विच चालू होने पर 12 तक जोड़ियों के लिए `previewMatch(lenderOfferId, borrowerOfferId, matcher, initiator)`, सबसे अच्छी कीमत वाली पहले, आपके वॉलेट को matcher और initiator दोनों रखकर। बिना त्रुटि वाले पूर्वावलोकन की पहली जोड़ी पूर्वावलोकन की राशि, दर (दोनों द्वारा मानी गई सीमा का मध्य) और ज़रूरी कोलैटरल के साथ पेश की जाती है; अन्यथा सबसे अच्छी कीमत वाली जोड़ी का इनकार उसके कारण के साथ बताया जाता है। हिस्सा ऊपरी सीमा के रूप में बताया जाता है, राशि गुणा आरंभ शुल्क दर गुणा matcher दर, क्योंकि शुल्क उधारकर्ता की छूट के बाद लगता है, जिसे पूर्वावलोकन नहीं बताता। जिस वक्र का मुफ़्त स्तर शून्य से ऊपर हो, उसका अर्थ है कि क्षमता सीमा लागू है, और एक मिलान भेजने वाले के विरुद्ध एक भराई गिनता है। समीक्षा हर ब्लॉक पर सेटिंग्स, पूर्वावलोकन और आपका वॉल्ट फिर पढ़ती है और वॉलेट खुलने से पहले `matchOffers` का ड्राई रन करती है; बदले आँकड़े के लिए नई पुष्टि चाहिए। इसके बाद ऐप जोड़ी के लिए आपके वॉलेट को matcher रखकर `OfferMatched` ढूँढता है, और हिस्सा ऋणदाता के वॉल्ट के प्रोत्साहन वर्ग वाले `VaultOutflow` रिकॉर्ड से मापता है, जो ऋण संपत्ति में आपके वॉलेट या वॉल्ट को चुकाए गए हों; ऑफ़र की वापसी या ऋण राशि दूसरा वर्ग है और कभी नहीं गिनी जाती। पहले पहुँचा कोई प्रतिस्पर्धी मिलान किसी ऑफ़र का कम हिस्सा छोड़ सकता है, इसलिए जो ऋण और हिस्सा पूरा होता है वह समीक्षा से छोटा हो सकता है; अंतिम कार्ड बताता है कि क्या पूरा हुआ। सीढ़ी इंडेक्स पढ़ती है, इसलिए मिलाई गई जोड़ी चेन द्वारा लिए जाने के बाद कुछ मिनट तक उस पर दिख सकती है। जुड़े हुए वॉलेट के ऑफ़र वाली जोड़ियाँ भी छोड़ दी जाती हैं, और बैंड यह बताता है: ऐसी जोड़ी का मिलान उस वॉलेट को ऋणदाता या उधारकर्ता बना देगा, और उसकी अपनी राशि ऋण में होगी।

<a id="offer-terms-wait"></a>

### ऑफ़र की शर्तों की न्यूनतम आयु

प्रोटोकॉल किसी ऑफ़र या अनुरोध को तभी पूरा करता है जब उसकी शर्तें `getOffer` के `termsSetAt` के बाद `getMinTermsAgeSec()` सेकंड तक बनी रहें (डिफ़ॉल्ट 5 सेकंड, 1 से 60 सेकंड के बीच एक एडमिन सेटिंग; शर्तों का हर बदलाव इसे फिर से शुरू करता है)। जब तक यह समय पूरा नहीं होता, `previewAccept` `TermsTooFresh` बताता है। तब समीक्षा एक ही ब्लॉक पर `termsSetAt`, न्यूनतम आयु और ब्लॉक का समय पढ़ती है और बताती है कि शर्तों को कितनी देर बने रहना है और उस ब्लॉक पर कितना समय बाकी था; यह कोई सहमति या हस्ताक्षर चरण नहीं दिखाती। समीक्षा हर ब्लॉक पर चेन फिर से पढ़ती है, इसलिए इनकार अपने आप हट जाता है। अगर ये आँकड़े पढ़े नहीं जा सकते, या पढ़े गए ब्लॉक पर कुछ भी बाकी नहीं था, तो वह सामान्य इनकार रखती है, जो कहता है कि यह कुछ सेकंड में हट जाएगा।

<a id="desk-tape"></a>

### Rate desk: अपने ऑफ़र, सौदों की सूची और तय दरों का चार्ट

आपके ऑफ़र सीढ़ी के वे ऑफ़र हैं जिनका निर्माता आपका वॉलेट है, हर एक अपने ऊपरी राशि के सामने `amountFilled` के साथ, जैसा इंडेक्स ने दर्ज किया। सौदों की सूची इंडेक्स का `/loans/recent` पढ़ती है, बाज़ार तक सीमित और `excludeSaleVehicles` के साथ, यानी 20 सबसे नए ऋण, और हर ऋण का खुलते समय का स्नैपशॉट दिखाती है: `initRateBps` और `initPrincipal`, कभी भी चालू `interestRateBps` या `principal` नहीं, जिन्हें आंशिक भुगतान और `LoanExtended` फिर से लिखते हैं। जिस राशि की लेजर पुष्टि नहीं करता, वह पुष्टि-रहित दिखती है। कोई ऋण किसी बाज़ार का तभी है जब इंडेक्स उसे वहाँ रखे (`marketDurationDays`, लेजर से पुष्ट तय अवधि); जोड़ी के बिना रखे गए ऋण गिने जाते हैं, उनकी अवधि का अनुमान कभी नहीं लगाया जाता, और बाज़ार तक सीमित न होने वाला उत्तर अस्वीकार किया जाता है। चार्ट `/loans/rate-candles` पढ़ता है: 7 दिनों पर 1 घंटे के चरण, 30 दिनों पर 4 घंटे के चरण, और 90 दिनों व पूरी अवधि पर दैनिक चरण। हर चरण में पहली, सबसे ऊँची, सबसे कम और आख़िरी तय दर, ऋणों की संख्या, और पुष्ट राशि वाले ऋणों पर जोड़ी गई उधार राशियाँ होती हैं, बाक़ी गिने जाते हैं। केवल ऋण वाले चरण लौटाए जाते हैं। रेखा केवल लगातार चरणों को जोड़ती है, इसलिए ख़ाली चरण अंतराल ही रहता है, और जब इंडेक्स ने केवल सबसे नए ऋण पढ़े हों तो चार्ट बताता है कि उसके सबसे पुराने चरण नहीं खींचे गए। डैश वाली संदर्भ रेखा सीढ़ी से निकाली गई मध्य दर है; कोई बदलाव का आँकड़ा नहीं दिखाया जाता।

<a id="desk-history"></a>

### रेट डेस्क: चालू लोन और डेस्क इतिहास

चालू लोन आपकी अपनी पोज़िशन रीड की वे पंक्तियाँ हैं (Positions के पीछे की `LoanSummary` पंक्तियाँ, हर लोन के हेल्थ फ़ैक्टर और आपकी पोज़िशन NFT के पक्ष के साथ) जिनके दोनों हिस्से ERC-20 टोकन हैं और मार्केट के टोकन व अवधि से मेल खाते हैं। ये कभी इंडेक्स से नहीं पढ़े जाते, और अधूरी रीड बताती है कि कोई लोन छूट सकता है। इतिहास इंडेक्स का `/loans/by-participant` `scope=desk` के साथ पढ़ता है: वे लोन जिनकी उधार दी गई संपत्ति और कोलैटरल दोनों ERC-20 हैं, लेंडर की बिक्री से खुलने वाले हिसाबी लोन को छोड़कर, उस केवल-जोड़ने वाले रिकॉर्ड से कि किसने कौन सा पक्ष रखा (शुरुआत में और हर पोज़िशन ट्रांसफ़र पर लिखा, कभी मिटाया नहीं)। पंक्तियाँ नवीनतम भागीदारी के क्रम में आती हैं; रीडर 21 पंक्तियाँ माँगता है और 20वीं पंक्ति के भागीदारी समय और लोन id से पुराना पेज तभी देता है जब 21वीं आए, इसलिए सीमा पर ठीक खत्म होने वाला पेज कुछ नहीं देता। हर पंक्ति डेस्क दायरे पर फिर जाँची जाती है और अस्वीकृत पंक्ति गिनी जाती है, छोड़ी नहीं जाती। स्थिति इंडेक्स की है (`active`, `repaid`, `defaulted`, `liquidated`, `settled`, `internal_matched`, `fallback_pending` या अज्ञात), और लोन का पेज चेन पढ़ता है।

<a id="desk-ticket"></a>

### रेट डेस्क: ऑर्डर टिकट

टिकट दिखाए गए मार्केट पर `createOffer` से पोस्ट करता है: लेंडिंग एसेट, कोलैटरल एसेट और `durationDays` मार्केट के होते हैं, और टिकट साइड (`offerType`), पूरी राशि `amountMax` के रूप में, जिसमें आंशिक या तुरंत-या-रद्द के लिए `amount` सबसे छोटी एकल फ़िल और सब-या-कुछ-नहीं के लिए पूरी राशि होती है (`LibOfferMatch` हर मैच को `amount` और बची राशि के बीच रखता है, इसलिए एक ही आकार हमेशा पूरा भरता है), `collateralAmount`, एक दर (`interestRateBpsMax` बराबर `interestRateBps`) (एक सटीक दर: `LibOfferMatch` दोनों दर-सीमाओं का मेल चाहता है, इसलिए टिकट उसी पक्ष से मैच होता है जिसकी सीमा में यह दर हो), समाप्ति और `fillMode` (आंशिक, सब-या-कुछ-नहीं या तुरंत-या-रद्द; आख़िरी के लिए सीमित समाप्ति ज़रूरी) देता है। बाक़ी गाइडेड फ़्लो के डिफ़ॉल्ट हैं, जो टिकट पर लिखे हैं: `useFullTermInterest` true, `allowsPartialRepay` false, `periodicInterestCadence` 0, कोई कोलैटरल रेंज नहीं (`collateralFloor` कोलैटरल के बराबर), कोई फ़ीस टैरिफ़ नहीं और कोई प्राइस गार्ड नहीं। समीक्षा खुलते समय `expiresAt` नवीनतम ब्लॉक के टाइमस्टैम्प से तय होता है, या कभी न समाप्त होने वाले ऑफ़र के लिए 0। राशियाँ टोकन के दशमलव पर पढ़ी जाती हैं और कभी राउंड नहीं होतीं; टोकन से ज़्यादा दशमलव टिकट रोक देते हैं। पहली रुकावट तय क्रम में बताई जाती है: वॉलेट, नेटवर्क, मार्केट, रीड्स (`readPostFormInputs`, दोनों टोकन के दशमलव और लागू शर्तें), `maxDurationDays` के सामने अवधि, फिर राशि, कोलैटरल, दर (अधिकतम 100% सालाना) और फ़िल मोड। फ़ीस सूचीबद्ध लोन इनिशिएशन फ़ीस और ट्रेज़री हिस्से से गिनी जाती है; छूट उन्हें सिर्फ़ घटा सकती है। समीक्षा गाइडेड फ़्लो की अपनी पोस्टिंग समीक्षा है, जिसमें पहले शर्तें स्वीकार होती हैं। साइन मोड में टिकट इसके बजाय ऑर्डर साइन करता है (अगला भाग)।

<a id="desk-sign"></a>

### रेट डेस्क: नया ऑर्डर साइन करना

साइन मोड में टिकट उन्हीं `createParams` से एक `SignedOffer` बनाता है जो पोस्ट किया ऑफ़र भेजता है, उस रूप में जिसमें इंडेक्स उसे रखता है (पते छोटे अक्षरों में, संख्याएँ दशमलव टेक्स्ट में), `creatorFull` false, एक यादृच्छिक 128-बिट `nonce` और `expiresAt` के बराबर `deadline` के साथ। यह केवल वही साइन करता है जिसे वॉल्ट-समर्थित `acceptSignedOffer` एक ही बार में भर सके: दोनों तरफ़ ERC-20, `amount` के बराबर `amountMax` और एक ही कोलैटरल राशि के साथ ऑल-ऑर-नन `fillMode` (वरना मैचर इसे टुकड़ों में भर सकता है), कोई फ़ीस टैरिफ़ नहीं और कोई प्राइस गार्ड नहीं; 0 का `expiresAt` अस्वीकार होता है। समीक्षा खुलते ही ऑर्डर और nonce तय हो जाते हैं, और रसीद व सिग्नेचर दोनों उसी एक ऑर्डर को पढ़ते हैं। समीक्षा प्रोटोकॉल से नवीनतम ब्लॉक और `freeHolding(signer, ERC20, stakeAsset, 0)` पढ़ती है; दाँव के मुकाबले कमी बताई जाती है, पर वह कभी रोकती नहीं। वॉलेट `Vaipakam SignedOffer` डोमेन, संस्करण `1`, इस चेन आईडी और Diamond के तहत EIP-712 टाइप्ड डेटा साइन करता है। फिर ऐप `{chainId, order, signature}` को इंडेक्स के `/signed-offers` पर POST करता है: 201 का अर्थ सूचीबद्ध और 200 का पहले से सूचीबद्ध (दोनों को इसी ऑर्डर का हैश लौटाना होता है), `error` कोड वाला 4xx अस्वीकृति है, और बाकी कुछ भी, या कोई जवाब नहीं, अज्ञात है। सूचीबद्ध होना या अस्वीकृति सिग्नेचर हटा देती है; अज्ञात जवाब उसे दोबारा भेजने के लिए ऐप की मेमोरी में रखता है (ब्राउज़र स्टोरेज में नहीं, इसलिए रीलोड करने पर वह खो जाता है)।

<a id="desk-signed"></a>

### रेट डेस्क: हस्ताक्षरित ऑर्डर और चेन पर रद्दीकरण

सूची मार्केट के लिए इंडेक्स का `/signed-offers` पढ़ती है, जिसमें `signer` आपका वॉलेट होता है (हर साइड पर 500 पंक्तियों तक, `truncated` बताया जाता है), ताकि दूसरे मेकर्स की गहराई आपके ऑर्डर बाहर न धकेल सके। हर पंक्ति को दोबारा 31 फ़ील्ड वाले मानक वायर रूप में क्रमबद्ध होना चाहिए, उसका `orderHash` ऑर्डर से दोबारा गणना किए गए EIP-712 स्ट्रक्ट हैश के बराबर होना चाहिए, और उसमें आपका वॉलेट तथा मार्केट के टोकन और अवधि होनी चाहिए; बाकी हर पंक्ति अपठनीय गिनी जाती है। बुक केवल वही ऑर्डर देती है जिन्हें वह सक्रिय और अनसमाप्त मानती है, और दोनों दिशाओं में चेन से पीछे रह सकती है, इसलिए हर ऑर्डर की स्थिति एक ही ब्लॉक पर पढ़ी जाती है: `signedOfferFilledAmount(orderHash)` ऑर्डर की सीमा (`amountMax`, या शून्य होने पर `amount`) तक पहुँचे तो उपयोग हो चुका (सीधा फ़िल और `cancelSignedOffer` दोनों सीमा लिखते हैं), नहीं तो `isSignedOfferNonceUsed(signer, nonce)` रद्द nonce है, नहीं तो समय-सीमा बीती जब ब्लॉक का समय शून्य से अलग `expiresAt` और `deadline` में से पहले वाले से आगे हो, नहीं तो आंशिक रूप से भरा जब वह आँकड़ा शून्य से ऊपर हो (किसी मैच ने एक हिस्सा लिया, बाकी अब भी भरा और रद्द किया जा सकता है), नहीं तो खुला। एक ऑर्डर रद्द करना `cancelSignedOffer(order)` भेजता है (केवल हस्ताक्षरकर्ता); nonce से रद्द करना `invalidateSignedOfferNonce(nonce)` भेजता है, जो तब दिखता है जब दो या अधिक सूचीबद्ध खुले ऑर्डर उसे साझा करते हैं, और वह हर मार्केट में उस nonce से वॉलेट के हस्ताक्षरित हर ऑर्डर को रोकता है। प्रोटोकॉल रुका हो तो दोनों अस्वीकार होते हैं। समीक्षा स्थितियाँ और ठहराव पढ़ती है, फिर आपके वॉलेट से प्रोटोकॉल का अपना ड्राई रन चलाती है। फ़िल जो लेता, वह ऋणदाता का `amountMax` (या शून्य होने पर `amount`) या उधारकर्ता का `collateralAmountMax` (या `collateralAmount`) है। आंशिक रूप से भरे ऑर्डर के लिए समीक्षा भरा हुआ हिस्सा और केवल वह बताती है जो बाकी अब भी ले सकता है: सीमा के नीचे बचा मूलधन, या उधारकर्ता के लिए उसका कोलैटरल ऑर्डर के अपने अनुपात पर, ऊपर की ओर पूर्णांकित। परिणाम लेन-देन के अपने `SignedOfferCancelled` या `SignedOfferNonceBurned` लॉग से पढ़ा जाता है, जो Diamond से निकला हो, और ऑर्डर हैश या nonce तथा आपके वॉलेट से मिलाया जाता है। हस्ताक्षरकर्ता तक सीमित इस पठन में इंडेक्स ऐसे रोके गए ऑर्डरों को `replayPending: true` के साथ सूचीबद्ध करता है; पंक्ति बताती है कि पुनः जाँच पूरी होने तक ऑर्डर साझा बुक से बाहर है, जबकि उसकी स्थिति ऊपर के चेन पठनों से ही आती है; केवल ताज़ा और अब भी भरने योग्य स्थिति ही यह जोड़ती है कि हस्ताक्षर अब भी भरा जा सकता है और रद्दीकरण उपलब्ध रखती है।
