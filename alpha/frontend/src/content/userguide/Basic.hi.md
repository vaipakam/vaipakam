# Vaipakam — उपयोगकर्ता मार्गदर्शिका (Basic Mode)

ऐप के हर कार्ड की सरल, साफ़ और व्यवहारिक व्याख्या। हर सेक्शन
किसी कार्ड के शीर्षक के पास दिखने वाले `(i)` info icon से जुड़ा
हुआ है।

> **आप Basic वर्ज़न पढ़ रहे हैं।** यह ऐप के **Basic** मोड से
> मेल खाता है — यानी कम नियंत्रणों वाला सरल दृश्य और सुरक्षित
> डिफ़ॉल्ट। ज़्यादा तकनीकी और विस्तृत walkthrough चाहिए तो ऐप को
> **Advanced** मोड में बदलें — Settings खोलें (ऊपर-दाएँ कोने
> में gear icon) → **Mode** → **Advanced**। इसके बाद ऐप के भीतर
> मौजूद (i) "Learn more" लिंक Advanced गाइड खोलेंगे।

---

## Dashboard

<a id="dashboard.your-vault"></a>

### आपका Vault

अपने **vault** को Vaipakam के भीतर अपनी निजी तिजोरी समझें। यह
एक छोटा contract है, और इस पर नियंत्रण आपके पास रहता है। जब भी
आप किसी loan में शामिल होते हैं — चाहे गिरवी रखकर, या कोई asset
उधार देकर — assets आपके wallet से इस तिजोरी में चले जाते हैं।
वे कभी किसी और के पैसों के साथ नहीं मिलते। loan समाप्त होने पर
आप उन्हें सीधे इसी तिजोरी से claim कर लेते हैं।

आपको vault खुद "बनाने" की ज़रूरत नहीं है; पहली बार ज़रूरत
पड़ने पर ऐप इसे आपके लिए बना देता है। एक बार बन जाने के बाद यह
इस chain पर आपका स्थायी, अलग-थलग vault रहता है।

<a id="dashboard.your-loans"></a>

### आपके Loans

इस chain पर जिन भी loans में आप शामिल हैं, वे सब यहाँ दिखते हैं
— चाहे आप lender हों (जो asset उधार देता है) या borrower (जो
उधार लेता है)। हर पंक्ति एक अलग position है। उस पर क्लिक करने
पर पूरी तस्वीर खुलती है: loan कितना स्वस्थ है, गिरवी के रूप में
क्या लॉक है, कितना ब्याज जुड़ चुका है, और ज़रूरत पड़ने पर repay,
claim या liquidate करने के बटन।

यदि आपके पास दोनों तरह की भूमिकाएँ हों — किसी loan में आपने
उधार दिया और किसी दूसरे में लिया — दोनों यहीं दिखेंगे, बस
अलग-अलग पंक्तियों में।

<a id="dashboard.vpfi-panel"></a>

### इस chain पर VPFI

**VPFI** प्रोटोकॉल का अपना token है। इसे vault में रखने से
प्रोटोकॉल fees पर discount मिलता है और एक छोटा passive yield
(5% APR) भी कमाया जाता है। जिस chain से आप जुड़े हैं, यह कार्ड
वहाँ की ये बातें दिखाता है:

- अभी आपके wallet में कितना VPFI है।
- आपके vault में कितना है (जो "staked" गिना जाता है)।
- कुल VPFI supply में आपकी हिस्सेदारी कितनी है।
- कुल कितना VPFI अभी और mint हो सकता है (प्रोटोकॉल का hard cap
  है)।

Vaipakam कई chains पर चलता है। उनमें से एक (Base) **canonical**
chain है, जहाँ नया VPFI mint होता है; बाकी **mirrors** हैं, जो
cross-chain bridge के ज़रिए synchronized copies रखती हैं। आपके
लिए बात सरल है: आप जिस chain पर हैं, वहाँ दिख रहा balance उसी
chain पर वास्तविक है।

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount की सहमति

Vaipakam आपके vault में रखे VPFI का उपयोग करके protocol fees
पर discount दे सकता है। यह switch आपकी "हाँ, ऐसा करें" वाली
सहमति है। इसे बस एक बार चालू करना होता है।

discount कितना बड़ा होगा यह इस पर निर्भर करता है कि आप vault
में कितना VPFI रखते हैं:

- **Tier 1** — `{liveValue:tier1Min}` या उससे ज़्यादा VPFI → `{liveValue:tier1DiscountBps}`% off
- **Tier 2** — `{liveValue:tier2Min}` या उससे ज़्यादा VPFI → `{liveValue:tier2DiscountBps}`% off
- **Tier 3** — `{liveValue:tier3Min}` या उससे ज़्यादा VPFI → `{liveValue:tier3DiscountBps}`% off
- **Tier 4** — `{liveValue:tier4Min}` से ज़्यादा VPFI → `{liveValue:tier4DiscountBps}`% off

आप switch कभी भी बंद कर सकते हैं। यदि आप vault से VPFI निकालते
हैं, तो आपका tier real time में नीचे आ जाता है।

> **Blockchain network gas पर note.** ऊपर बताया गया discount
> Vaipakam की **protocol fees** (Yield Fee, Loan Initiation Fee)
> पर apply होता है। हर on-chain action के साथ जो छोटी **gas fee**
> लगती है (जब आप offer create, accept, repay, claim करते हैं तब
> blockchain validators को pay की जाती है) - वह एक अलग charge है
> जो network को जाती है, Vaipakam को नहीं। Protocol उस पर discount
> नहीं दे सकता क्योंकि वह उसे कभी receive नहीं करता।

<a id="dashboard.rewards-summary"></a>

### आपके VPFI पुरस्कार

यह कार्ड प्रोटोकॉल से अर्जित किए गए हर VPFI पुरस्कार को एक
स्थान पर एक साथ लाता है। ऊपर का बड़ा संख्या संयुक्त कुल है —
जो आपने पहले से दावा किया है और जो दावा करने की प्रतीक्षा
कर रहा है।

दो पुरस्कार धाराएं हैं और कार्ड कुल को प्रत्येक के अनुसार
विभाजित करता है:

- **स्टेकिंग प्रतिफल** — Vault में रखे किसी भी VPFI पर
  स्वचालित रूप से अर्जित। दर Buy VPFI पेज पर दिखाया गया
  प्रोटोकॉल APR है।
- **प्लेटफ़ॉर्म-इंटरैक्शन पुरस्कार** — हर ऋण के लिए जिसमें
  आप शामिल हैं, हर तरफ, थोड़ा-सा रोज़ अर्जित। आप जिस चेन
  पर हैं उस पर VPFI में भुगतान किया जाता है, बिना ब्रिज के।

प्रत्येक पंक्ति में दाईं ओर एक छोटा शेवरॉन तीर है। उस धारा के
पूर्ण दावा कार्ड पर सीधे जाने के लिए उस पर क्लिक करें —
स्टेकिंग Buy VPFI पेज पर रहती है, प्लेटफ़ॉर्म-इंटरैक्शन Claim
Center पर रहती है।

अगर आपने अभी तक कुछ भी नहीं कमाया है, तो कार्ड
*कुल अर्जित: 0 VPFI* के साथ-साथ शुरू करने के लिए एक संकेत के
साथ रेंडर होता है। आपने कुछ गलत नहीं किया है — दिखाने के लिए
कोई इतिहास नहीं है।


---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

बाज़ार की सूचियाँ लंबी हो सकती हैं। Filters उन्हें asset,
offer के पक्ष (lender या borrower), और कुछ दूसरे मानदंडों के
आधार पर छोटा कर देते हैं। आपकी अपनी active offers हमेशा पेज के
ऊपर दिखती रहती हैं — filters सिर्फ़ यह बदलते हैं कि दूसरे लोगों
की कौन-सी offers आपको दिखें।

<a id="offer-book.your-active-offers"></a>

### आपकी Active Offers

वे offers जो **आपने** पोस्ट की हैं और जिन्हें अभी तक किसी ने
स्वीकार नहीं किया। जब तक offer यहाँ है, आप उसे बिना शुल्क cancel
कर सकते हैं। कोई स्वीकार कर ले तो position वास्तविक loan बन
जाती है और Dashboard के "आपके Loans" में चली जाती है।

<a id="offer-book.lender-offers"></a>

### Lender Offers

उन लोगों की posts जो उधार देने को तैयार हैं। हर offer मोटे तौर
पर यह कहती है: "मैं asset Y की X units, Z% ब्याज पर, D दिनों के
लिए उधार दूँगा — बदले में इतना collateral चाहिए।"

इनमें से कोई offer स्वीकार करने वाला borrower उस loan का
borrower-of-record बन जाता है: borrower का collateral vault में
लॉक हो जाता है, principal asset उसके wallet में पहुँचता है, और
ब्याज repayment तक जुड़ता रहता है।

acceptance के समय protocol borrower की तरफ़ एक सुरक्षा नियम
लागू करता है: collateral की कीमत loan से कम से कम 1.5× होनी
चाहिए। (इसे **Health Factor 1.5** कहा जाता है।) यदि borrower
का collateral पर्याप्त नहीं है, तो loan शुरू ही नहीं होता।

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

उन borrowers की posts जिन्होंने अपना collateral पहले ही लॉक कर
दिया है और loan fund करने के लिए किसी lender का इंतज़ार कर रहे
हैं।

इनमें से कोई offer स्वीकार करने वाला lender loan को fund करता
है: lender का asset borrower को जाता है, lender lender-of-record
बनता है, और अवधि भर offer के तय rate पर ब्याज कमाता है। ब्याज
का छोटा हिस्सा (1%) settlement के समय protocol treasury में
जाता है।

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

अपना पक्ष चुनें:

- **Lender** — lender asset देता है और loan बकाया रहने तक ब्याज
  कमाता है।
- **Borrower** — borrower collateral लॉक करता है और उसके बदले
  दूसरा asset मांगता है।

"rentable" NFTs (ऐसी NFTs जिन्हें अस्थायी रूप से उपयोग-अधिकार
दिए जा सकते हैं) के लिए एक **Rental** sub-option भी है। Rentals
में पैसा उधार नहीं दिया जाता — NFT खुद दैनिक fee पर किराए पर
दी जाती है।

<a id="create-offer.lending-asset"></a>

### Lending Asset

जो asset और राशि इस deal में है, साथ में ब्याज दर (APR % में)
और दिनों में अवधि। rate offer पोस्ट करते समय fix हो जाता है;
बाद में कोई इसे बदल नहीं सकता। अवधि पूरी होने के बाद एक छोटी
grace window मिलती है — यदि borrower तब तक repay नहीं करता, तो
loan default हो सकता है और lender का collateral claim सक्रिय हो
जाता है।

<a id="create-offer.lending-asset:lender"></a>

#### यदि आप lender हैं

जो principal asset और राशि आप offer करने को तैयार हैं, साथ में
ब्याज दर (APR % में) और दिनों में अवधि। rate offer के समय fix
होता है; अवधि वही grace window तय करती है जिसके बाद loan default
हो सकता है।

<a id="create-offer.lending-asset:borrower"></a>

#### यदि आप borrower हैं

जो principal asset और राशि आप lender से चाहते हैं, साथ में ब्याज
दर (APR % में) और दिनों में अवधि। rate offer के समय fix होता
है; अवधि वही grace window तय करती है जिसके बाद loan default हो
सकता है।

<a id="create-offer.nft-details"></a>

### NFT Details

rental offer में यह कार्ड daily rental fee तय करता है। स्वीकार
करते समय renter पूरी rental cost पहले से चुकाता है, साथ में 5%
का छोटा buffer, ताकि deal थोड़ा लंबा चले तो भी कमी न पड़े। NFT
पूरे समय vault में रहता है — renter को उपयोग का अधिकार मिलता
है, लेकिन वह NFT को कहीं transfer नहीं कर सकता।

<a id="create-offer.collateral"></a>

### Collateral

loan को सुरक्षित रखने के लिए जो asset लॉक होता है। इसके दो
प्रकार हैं:

- **Liquid** — ऐसा जाना-पहचाना token जिसका live price feed हो
  (Chainlink + पर्याप्त गहरा on-chain pool)। protocol इसका
  real-time मूल्य निकाल सकता है और price loan के खिलाफ जाने पर
  position को अपने-आप liquidate कर सकता है।
- **Illiquid** — NFTs, या ऐसे tokens जिनका price feed नहीं है।
  protocol इनका मूल्य भरोसे से नहीं निकाल सकता, इसलिए default
  होने पर lender पूरा collateral लेता है। offer बनाने से पहले
  lender और borrower दोनों को इस परिणाम पर सहमति देनी होती है।

<a id="create-offer.collateral:lender"></a>

#### यदि आप lender हैं

आप borrower से loan की सुरक्षा के लिए कितना collateral लॉक
करवाना चाहते हैं। Liquid ERC-20s (Chainlink feed + ≥$1M v3 pool
depth) पर LTV/HF math लागू होती है; illiquid ERC-20s और NFTs का
on-chain valuation नहीं होता, इसलिए दोनों पक्षों को "default पर
पूरा collateral" वाले परिणाम को स्वीकार करना पड़ता है।

<a id="create-offer.collateral:borrower"></a>

#### यदि आप borrower हैं

आप loan की सुरक्षा के लिए कितना collateral लॉक करने को तैयार
हैं। Liquid ERC-20s (Chainlink feed + ≥$1M v3 pool depth) पर
LTV/HF math लागू होती है; illiquid ERC-20s और NFTs का on-chain
valuation नहीं होता, इसलिए दोनों पक्षों को "default पर पूरा
collateral" वाले परिणाम को स्वीकार करना पड़ता है।

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Vaipakam पर lending और borrowing में वास्तविक जोखिम हैं। offer
sign करने से पहले यह कार्ड sign करने वाले पक्ष से साफ़
acknowledgement मांगता है। नीचे दिए जोखिम दोनों पक्षों पर लागू
होते हैं; role-specific tabs यह दिखाती हैं कि कौन-सा जोखिम किस
पक्ष को अधिक प्रभावित करता है।

Vaipakam non-custodial है। ऐसा कोई support desk नहीं है जो
confirm हो चुकी transaction को उलट दे। sign करने से पहले इन्हें
ध्यान से पढ़ें।

<a id="create-offer.risk-disclosures:lender"></a>

#### यदि आप lender हैं

- **Smart-contract जोखिम** — contracts immutable code हैं; कोई
  अज्ञात bug funds को प्रभावित कर सकता है।
- **Oracle जोखिम** — पुराना या manipulate किया गया price feed
  liquidation को उस बिंदु से आगे टाल सकता है जहाँ collateral अब
  आपके principal को पूरा cover नहीं करता। संभव है पूरी recovery
  न मिले।
- **Liquidation slippage** — liquidation समय पर trigger हो जाए,
  तब भी DEX swap quote से खराब price पर execute हो सकती है,
  जिससे वास्तविक recovery घट सकती है।
- **Illiquid collateral** — default पर पूरा collateral आपके
  पास आ जाता है, लेकिन यदि उसकी क़ीमत loan से कम है तो आपका
  कोई अतिरिक्त दावा नहीं रहता। offer बनाते समय आपने इसी trade-off
  को स्वीकार किया था।

<a id="create-offer.risk-disclosures:borrower"></a>

#### यदि आप borrower हैं

- **Smart-contract जोखिम** — contracts immutable code हैं; कोई
  अज्ञात bug आपके locked collateral को प्रभावित कर सकता है।
- **Oracle जोखिम** — पुराना या manipulate किया गया price feed
  ग़लत समय पर आपके ख़िलाफ़ liquidation शुरू कर सकता है, जबकि
  वास्तविक बाज़ार क़ीमत सुरक्षित रही होती।
- **Liquidation slippage** — liquidation trigger होने पर DEX swap
  आपके collateral को अपेक्षा से खराब price पर बेच सकती है।
- **Illiquid collateral** — default पर आपका पूरा collateral
  lender के पास चला जाता है, और आपके पास कोई बचा हुआ दावा नहीं
  रहता। offer बनाते समय आपने इसी trade-off को स्वीकार किया था।

<a id="create-offer.advanced-options"></a>

### Advanced Options

जिन उपयोगकर्ताओं को finer control चाहिए, उनके लिए अतिरिक्त
settings — ज़्यादातर लोग इन्हें default पर ही छोड़ते हैं। जैसे
offer expire होने से पहले कितनी देर open रहे, इस specific offer
पर fee discount के लिए VPFI इस्तेमाल करना है या नहीं, और कुछ
role-specific toggles। पहली offer में इन्हें छोड़ देना सुरक्षित
है।

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

loan पूरा होने के बाद — चाहे repay हुआ हो, default हुआ हो या
liquidate — परिणाम में आपका हिस्सा अपने-आप wallet में नहीं आता।
उसे लेने के लिए आपको **Claim** क्लिक करना होता है। यह पेज इस
chain पर आपके सभी pending claims की सूची है।

एक उपयोगकर्ता के पास एक साथ lender claims (जिन loans को उसने
fund किया) और borrower claims (जो loans उसने लिए) दोनों हो
सकते हैं — दोनों इसी सूची में दिखते हैं। नीचे की role-specific
tabs बताती हैं कि हर claim किस तरह की चीज़ लौटाता है।

<a id="claim-center.claims:lender"></a>

#### यदि आप lender हैं

आपका lender claim loan का principal और accrued interest लौटाता
है, ब्याज वाले हिस्से पर 1% treasury cut घटाकर। loan settle होते
ही — repay, default या liquidation के बाद — यह claimable हो जाता
है। claim आपके lender position NFT को atomically consume करता है
— transaction land होते ही loan का वह पक्ष पूरी तरह close हो
जाता है।

<a id="claim-center.claims:borrower"></a>

#### यदि आप borrower हैं

यदि आपने loan पूरी तरह चुका दिया है, तो आपका borrower claim
वह collateral लौटा देता है जो आपने शुरुआत में लॉक किया था।
default या liquidation पर, सिर्फ़ Loan Initiation Fee से बचा
हुआ कोई VPFI rebate लौट सकता है — collateral पहले ही lender के
पास जा चुका होता है। claim आपके borrower position NFT को
atomically consume करता है।

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

जिस chain से आप जुड़े हैं, उस पर आपके wallet से जुड़ी हर
on-chain घटना — आपने जो offers post या accept कीं, loans,
repayments, claims और liquidations। यह सब सीधे chain से live
पढ़ा जाता है; बीच में कोई central server नहीं है जो बंद पड़
सके। सबसे नई activity पहले दिखती है, और events transaction के
हिसाब से grouped रहते हैं ताकि एक ही click में हुए काम साथ दिखें।

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI ख़रीदना

Buy पेज आपको protocol के fixed early-stage rate पर ETH से VPFI
खरीदने देता है। आप यह किसी भी supported chain से कर सकते हैं —
route पर्दे के पीछे संभाल लिया जाता है। VPFI हमेशा उसी chain पर
आपके wallet में आता है जिससे आप जुड़े हैं। network बदलने की
ज़रूरत नहीं।

<a id="buy-vpfi.discount-status"></a>

### आपकी VPFI Discount Status

यह कार्ड तुरंत बताता है कि आप अभी किस discount tier में हैं।
Tier आपके **vault** में रखे VPFI से तय होता है, wallet balance
से नहीं। कार्ड यह भी बताता है: (a) अगले tier तक पहुँचने के लिए
vault में और कितना VPFI चाहिए, और (b) Dashboard पर consent
switch चालू है या नहीं — discount तभी लागू होता है जब वह चालू
हो।

आपके vault में जो VPFI है वह स्वतः "staked" भी है और 5% APR
कमाता है।

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH से VPFI ख़रीदें

जितनी ETH खर्च करनी है, उतनी दर्ज करें, Buy दबाएँ और transaction
sign करें। बस। abuse रोकने के लिए per-purchase cap और 24-hour
rolling cap है — form के पास live numbers दिखते हैं, ताकि आपको
पता रहे कि आपकी allowance कितनी बची है।

<a id="buy-vpfi.deposit"></a>

### Step 2 — अपने vault में VPFI deposit करें

VPFI खरीदने पर वह आपके wallet में आता है, vault में नहीं। fee
discount और 5% staking yield पाने के लिए आपको उसे खुद vault में
move करना होगा। यह हमेशा आपकी स्पष्ट action होती है — ऐप आपकी
मर्ज़ी के बिना आपका VPFI कभी move नहीं करता। एक transaction
(या supported chains पर एक signature) और काम पूरा।

<a id="buy-vpfi.unstake"></a>

### Step 3 — vault से VPFI unstake करें

कुछ VPFI वापस wallet में चाहिए? यह कार्ड उसे vault से वापस भेज
देता है। ध्यान रहे: VPFI निकालते ही आपका discount tier
**तुरंत** घट सकता है। यदि आपके open loans हैं, तो उसी पल से
discount math lower tier के आधार पर चलने लगती है।

---

## Rewards

<a id="rewards.overview"></a>

### Rewards के बारे में

Vaipakam आपको दो तरह की activity के लिए reward देता है:

1. **Staking** — vault में रखा VPFI स्वतः 5% APR कमाता है।
2. **Interaction** — जिस loan में आप शामिल हैं, उसमें settle हुए
   ब्याज के हर dollar पर आप community-wide reward pool का daily
   हिस्सा कमाते हैं।

दोनों rewards VPFI में मिलते हैं, सीधे उसी chain पर जहाँ आप हैं।
कोई bridge नहीं, कोई chain switch नहीं।

<a id="rewards.claim"></a>

### Rewards Claim करें

एक button दोनों reward streams को एक ही transaction में claim
कर देता है। Staking rewards real time में claimable रहते हैं।
interaction-pool का हिस्सा दिन में एक बार settle होता है, इसलिए
यदि आपने पिछली settlement के बाद कुछ कमाया है, तो total का
interaction हिस्सा अगले daily window बंद होने के थोड़ी देर बाद
live होगा।

<a id="rewards.withdraw-staked"></a>

### Staked VPFI निकालें

VPFI को vault से वापस wallet में भेजें। wallet में आने के बाद
वह 5% APR कमाना बंद कर देता है और आपके discount tier में भी नहीं
गिना जाता। यह Buy VPFI पेज के "unstake" step जैसा ही action है
— सुविधा के लिए यहाँ भी उपलब्ध है।

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (यह पेज)

एक ही loan की पूरी जानकारी एक जगह। loan किन terms पर open हुआ,
अभी कितना healthy है, दोनों तरफ कौन है, और आपकी भूमिका के हिसाब
से आप कौन-से actions कर सकते हैं — repay, claim, liquidate,
early close या refinance।

<a id="loan-details.terms"></a>

### Loan Terms

loan के fixed हिस्से: कौन-सा asset उधार दिया गया, कितनी राशि,
interest rate, duration, और अब तक कितना ब्याज accrued हुआ है।
loan open होने के बाद ये terms नहीं बदलते। (यदि अलग terms चाहिए,
तो refinance करें — ऐप नया loan बनाता है और इसी transaction में
पुराने loan को चुका देता है।)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

इस loan का collateral और live risk numbers — Health Factor और
LTV। **Health Factor** एक safety score है: 1 से ऊपर मतलब
collateral loan को आराम से cover कर रहा है; 1 के पास मतलब risk
बढ़ रहा है और loan liquidate हो सकता है। **LTV** बताता है:
"कितना उधार लिया गया बनाम रखे गए collateral की कीमत"। position
कब unsafe होती है, उसके thresholds इसी card पर दिखते हैं।

यदि collateral illiquid है (NFT या बिना live price feed
वाली token), तो ये संख्याएँ निकाली नहीं जा सकतीं। दोनों पक्ष
offer बनाते समय इस परिणाम पर सहमत हुए थे।

<a id="loan-details.collateral-risk:lender"></a>

#### यदि आप lender हैं

यह borrower का collateral है — आपकी सुरक्षा। जब तक HF 1 से ऊपर
है, आप अच्छी तरह covered हैं। HF गिरने पर protection कमज़ोर
होती है; यदि यह 1 से नीचे जाता है, तो कोई भी (आप भी) liquidation
trigger कर सकता है, और DEX swap collateral को आपके principal
asset में बदलकर repayment करता है। illiquid collateral में default
होने पर पूरा collateral आपको मिलता है — उसकी market value जो भी
हो।

<a id="loan-details.collateral-risk:borrower"></a>

#### यदि आप borrower हैं

यह आपका locked collateral है। HF को सुरक्षित रूप से 1 से ऊपर
रखें — इसके करीब आते ही liquidation risk बढ़ता है। आम तौर पर
आप collateral जोड़कर या loan का हिस्सा repay करके HF को वापस
ऊपर ला सकते हैं। यदि HF 1 से नीचे जाता है, तो कोई भी liquidation
trigger कर सकता है, और DEX swap आपके collateral को slippage से
प्रभावित कीमतों पर बेचकर lender को repay करेगा। illiquid
collateral में default होने पर आपका पूरा collateral lender को
चला जाता है; कोई leftover claim नहीं बचता।

<a id="loan-details.parties"></a>

### Parties

इस loan पर दो wallet addresses होते हैं — lender और borrower —
और वे vault vaults जो उनके assets रखते हैं। loan खुलने पर हर
पक्ष को एक "position NFT" भी मिला था। वही NFT _उस पक्ष के
outcome पर अधिकार_ है — उसे सुरक्षित रखें। यदि holder उसे किसी
और को transfer कर देता है, तो claim करने का अधिकार नए holder को
मिल जाता है।

<a id="loan-details.actions"></a>

### Actions

इस loan पर उपलब्ध सभी buttons। आप कौन-से buttons देखते हैं, यह
इस specific loan में आपकी भूमिका पर निर्भर करता है — नीचे की
role-specific tabs हर पक्ष के options बताती हैं। जो buttons अभी
available नहीं हैं वे greyed out रहेंगे, और tooltip में कारण
दिखेगा।

<a id="loan-details.actions:lender"></a>

#### यदि आप lender हैं

- **Claim** — loan settle होने के बाद (repay, default या
  liquidation), principal और interest unlock करता है, ब्याज पर
  1% treasury cut घटाकर। यह आपके lender NFT को consume करता है।
- **Initiate Early Withdrawal** — मध्य-loan में किसी और
  ख़रीदार को बेचने के लिए अपना lender NFT लिस्ट करें।
  ख़रीदार आपका पक्ष ले लेता है; आप sale की रकम लेकर निकल
  जाते हैं।
- **Liquidate** — कोई भी (आप समेत) तब इसे शुरू कर सकता है जब
  HF 1 से नीचे गिरे या grace period ख़त्म हो जाए।

<a id="loan-details.actions:borrower"></a>

#### यदि आप borrower हैं

- **Repay** — पूरा या आंशिक। partial repayment आपका outstanding
  घटाता है और HF सुधारता है; full repayment loan बंद करता है और
  Claim के ज़रिए आपका collateral unlock करता है।
- **Preclose** — loan को जल्दी बंद करें। Direct path: अपने
  wallet से अभी पूरा outstanding चुकाएँ। Offset path:
  collateral का कुछ हिस्सा DEX पर बेचें, उस रकम से चुकाएँ,
  जो बचे वह वापस लें।
- **Refinance** — नई शर्तों के साथ नए loan में रोल करें;
  प्रोटोकॉल एक transaction में नए principal से पुराने loan
  को चुका देता है। collateral कभी vault से बाहर नहीं जाता।
- **Claim** — loan settle होने के बाद full repayment पर आपका
  collateral लौटाता है, या default में loan-initiation fee से बचा
  हुआ कोई VPFI rebate।

---

## Allowances

<a id="allowances.list"></a>

### Allowances

जब आप कोई offer accept करते हैं, तो आपका wallet कभी-कभी Vaipakam
को आपकी ओर से कोई specific token move करने की "approval" देता
है। कुछ wallets ये approvals ज़रूरत से ज़्यादा देर तक open रख
देते हैं। यह पेज इस chain पर Vaipakam को दी गई आपकी हर approval
दिखाता है और एक click में उन्हें revoke करने देता है। Non-zero
approvals (जो सच में live हैं) ऊपर दिखती हैं।

साफ़ approvals list अच्छी wallet hygiene है — Uniswap या 1inch
पर भी यही समझदारी है।

---

## Alerts

<a id="alerts.overview"></a>

### Alerts के बारे में

जब आपके collateral की कीमत गिरती है, तो आपके loan का safety
score — यानी Health Factor — भी गिर सकता है। Alerts आपको opt-in
करने देते हैं ताकि liquidation से **पहले** आपको heads-up मिल
जाए। एक छोटी off-chain service हर पाँच मिनट में आपके loans देखती
है और score danger band पार करते ही आपको ping करती है। कोई gas
cost नहीं; on-chain कुछ नहीं बदलता।

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

watcher जिन danger bands का उपयोग करता है। किसी अधिक जोखिम वाले
band में प्रवेश करने पर alert एक बार fire होता है। अगला ping
तभी आएगा जब अगला और अधिक जोखिम वाला band cross हो। यदि HF फिर
से सुरक्षित band में लौट आता है, तो ladder reset हो जाती है।
Defaults सामान्य loans के लिए tuned हैं; बहुत volatile collateral
हो तो thresholds ऊँचे रखना बेहतर हो सकता है।

<a id="alerts.delivery-channels"></a>

### Delivery Channels

pings वास्तव में कहाँ पहुँचें। आप Telegram चुन सकते हैं (bot DM
भेजता है), Push Protocol चुन सकते हैं (wallet notifications), या
दोनों। दोनों channels वही threshold ladder साझा करते हैं — इन्हें
अलग-अलग tune नहीं किया जाता।

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### NFT verify करें

Vaipakam position NFTs कभी-कभी secondary markets पर दिखती हैं।
किसी दूसरे holder से खरीदने से पहले, यहाँ NFT contract address
और token ID paste करें। verifier पुष्टि करता है: (a) क्या इसे
वाकई Vaipakam ने mint किया था, (b) underlying loan किस chain पर
है, (c) loan अभी किस state में है, और (d) NFT का current on-chain
owner कौन है।

position NFT _ही_ loan से claim करने का अधिकार है। नकली NFT —
या ऐसी position जो पहले ही settle हो चुकी है — पहचान लेना आपको
खराब trade से बचा सकता है।

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers के बारे में

"keeper" एक wallet है जिस पर आप अपने loans पर कुछ खास maintenance
actions के लिए भरोसा कर सकते हैं — जैसे early withdrawal पूरा
करना या refinance finalize करना। keepers आपका पैसा निकाल या खर्च
नहीं कर सकते — repayment, collateral जोड़ना, claim करना और
liquidation जैसे paths user-only रहते हैं। आप 5 तक keepers approve
कर सकते हैं, और master switch बंद करके सबको एक साथ disable कर
सकते हैं।

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

list में हर keeper **केवल वही actions कर सकता है जिन्हें आपने
tick किया है**। इसलिए जिसे सिर्फ़ "complete early withdrawal" की
permission है, वह आपकी ओर से early withdrawal शुरू नहीं कर सकता
— वह केवल वही पूरा कर सकता है जिसे आपने शुरू किया हो। मन बदलने
पर ticks edit करें; किसी keeper को पूरी तरह हटाना हो तो उसे list
से निकाल दें।

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics के बारे में

पूरे protocol का wallet-free, transparent view: कुल locked value,
loan volumes, default rates, VPFI supply और recent activity। यह
सब live on-chain data से निकाला जाता है — इस page पर किसी संख्या
के पीछे private database नहीं है।

<a id="public-dashboard.combined"></a>

### Combined — All Chains

protocol-wide totals, सभी supported chains को जोड़कर। छोटी "X
chains covered, Y unreachable" line बताती है कि page load होते
समय कोई chain unreachable थी या नहीं — यदि हाँ, तो वही chain
नीचे per-chain table में flag होती है।

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

वही totals, chain-by-chain विभाजित। इससे पता चलता है कि सबसे
ज़्यादा TVL किस chain पर है, loan volume कहाँ अधिक है, या कौन-सी
chain उस समय जवाब नहीं दे रही।

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

इस chain पर VPFI की live state — total supply, circulating supply
(protocol-held balances घटाने के बाद), और cap के भीतर कितना और
mintable है। design के अनुसार, सभी chains में कुल supply bounded
रहती है।

<a id="public-dashboard.transparency"></a>

### Transparency & Source

इस page की हर संख्या blockchain से दोबारा derive की जा सकती है।
यह card snapshot block, data की freshness, और हर metric किस
contract address से आया — सब दिखाता है। कोई figure verify करनी
हो तो शुरुआत यहीं से करें।

---

## Refinance

यह पेज सिर्फ़ borrower के लिए है — refinance borrower अपने loan
पर शुरू करता है।

<a id="refinance.overview"></a>

### Refinancing के बारे में

Refinancing आपके मौजूदा loan को collateral खोले बिना नए loan में
roll कर देती है। आप नई terms के साथ एक fresh borrower-side offer
post करते हैं; जैसे ही कोई lender accept करता है, protocol एक
transaction में पुराना loan repay करके नया loan open कर देता है।
ऐसा कोई moment नहीं आता जब आपका collateral unsecured हो।

<a id="refinance.position-summary"></a>

### आपकी मौजूदा position

जिस loan को refinance कर रहे हैं उसका snapshot — कितना outstanding
है, कितना interest accrued है, position कितनी healthy है, और क्या
locked है। नई offer को सही size देने के लिए इन्हीं numbers का
उपयोग करें।

<a id="refinance.step-1-post-offer"></a>

### Step 1 — नई offer पोस्ट करें

आप refinance के लिए desired asset, amount, rate और duration के
साथ borrower offer post करते हैं। जब तक यह listed है, पुराना loan
सामान्य रूप से चलता रहता है — interest accrue होता रहता है और
collateral locked रहता है। दूसरे users इस offer को Offer Book में
देखते हैं।

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

एक बार कोई lender आपकी refinance offer accept कर ले, Complete
पर click करें। protocol फिर atomically: नए principal से पुराने
loan को repay करता है, नया loan खोलता है, और पूरे समय आपका
collateral locked रखता है। एक transaction, दो state changes,
exposure window नहीं।

---

## Preclose

यह पेज सिर्फ़ borrower के लिए है — preclose borrower अपने loan
पर शुरू करता है।

<a id="preclose.overview"></a>

### Preclose के बारे में

Preclose का मतलब है: "मेरा loan समय से पहले बंद कर दें"। आपके
पास दो रास्ते हैं:

- **Direct** — अपने wallet से अभी पूरा outstanding balance repay
  करें।
- **Offset** — DEX पर collateral का कुछ हिस्सा बेचें और proceeds
  से loan repay करें। जो बचता है वह आपको वापस मिलता है।

Direct आम तौर पर सस्ता है यदि आपके पास cash है। Offset तब काम
आता है जब cash नहीं है, लेकिन आप loan खुला भी नहीं रखना चाहते।

<a id="preclose.position-summary"></a>

### आपकी मौजूदा position

जिस loan को जल्दी बंद कर रहे हैं उसका snapshot — outstanding,
accrued interest और current health। early close fee-fair है —
कोई flat penalty नहीं; protocol का time-weighted VPFI math
हिसाब संभालता है।

<a id="preclose.in-progress"></a>

### Offset In Progress

आपने offset preclose शुरू किया है और swap step अभी बीच में है।
आप इसे complete कर सकते हैं (proceeds loan settle करते हैं और
बाकी आपको लौटता है), या — यदि price बदल गया हो — cancel करके
fresh quote पर फिर कोशिश कर सकते हैं।

<a id="preclose.choose-path"></a>

### एक रास्ता चुनें

**Direct** चुनें यदि आपके पास अभी loan repay करने के लिए cash है।
**Offset** चुनें यदि exit करते समय collateral का हिस्सा बेचना
बेहतर है। दोनों paths loan को पूरी तरह बंद करते हैं; preclose में
loan आधा-बंद नहीं रहता।

---

## Early Withdrawal (Lender)

यह पेज सिर्फ़ lender के लिए है — early withdrawal lender अपने
loan पर शुरू करता है।

<a id="early-withdrawal.overview"></a>

### Lender Early Exit के बारे में

यदि आप अवधि पूरी होने से पहले loan से बाहर निकलना चाहते हैं, तो
आप अपना lender NFT protocol के ज़रिए sale के लिए list कर सकते
हैं। buyer आपको इसके लिए भुगतान करता है; बदले में वह loan में
आपका पक्ष ले लेता है — final repayment + interest वही claim
करेगा। आप sale proceeds लेकर बाहर हो जाते हैं।

<a id="early-withdrawal.position-summary"></a>

### आपकी मौजूदा position

जिस loan से आप exit कर रहे हैं उसका snapshot — principal,
accrued interest, बचा हुआ समय, और borrower का current health
score। buyer आपकी NFT की कीमत तय करते समय इन्हीं numbers को
देखेगा।

<a id="early-withdrawal.initiate-sale"></a>

### बिक्री शुरू करें

आप asking price set करते हैं, protocol आपकी lender NFT list करता
है, और आप buyer का इंतज़ार करते हैं। buyer accept करते ही amount
आपके wallet में आती है और loan चलता रहता है — लेकिन अब वह आपका
पक्ष नहीं रहता। जब तक listing open और unfilled है, आप उसे cancel
कर सकते हैं।
