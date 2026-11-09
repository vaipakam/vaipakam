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

<a id="chapter.dashboard"></a>

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
प्रोटोकॉल fees पर discount मिलता है। जिस chain से आप जुड़े हैं,
यह कार्ड वहाँ की ये बातें दिखाता है:

- अभी आपके wallet में कितना VPFI है।
- आपके vault में कितना है (जो आपके discount tier में गिना जाता है)।
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

Vaipakam आपके vault में रखे VPFI के आधार पर protocol fees पर
discount दे सकता है। Borrower के लिए यह discount बस एक कम Loan
Initiation Fee है, जो loan शुरू होते समय loan के अपने asset में ली
जाती है — इसके लिए कोई VPFI खर्च नहीं होता। यह switch आपकी "हाँ,
ऐसा करें" वाली सहमति है। इसे बस एक बार चालू करना होता है।

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

पुरस्कार **प्लेटफ़ॉर्म-इंटरैक्शन** से आते हैं — हर उस ऋण के लिए
जिसमें आप शामिल हैं, किसी भी तरफ, आप हर दिन थोड़ा-सा कमाते हैं।
आप जिस चेन पर हैं उस पर VPFI में भुगतान किया जाता है, बिना ब्रिज
के।

पंक्ति में दाईं ओर एक छोटा शेवरॉन तीर है। Claim Center में पूर्ण
दावा कार्ड पर सीधे जाने के लिए उस पर क्लिक करें।

अगर आपने अभी तक कुछ भी नहीं कमाया है, तो कार्ड
*कुल अर्जित: 0 VPFI* के साथ-साथ शुरू करने के लिए एक संकेत के
साथ रेंडर होता है। आपने कुछ गलत नहीं किया है — दिखाने के लिए
कोई इतिहास नहीं है।


---

<a id="chapter.offer-book"></a>

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
का छोटा हिस्सा (`{liveValue:treasuryFeeBps}`%) settlement के समय protocol treasury में
जाता है।
यह rate loan बनते समय तय हो जाता है, इसलिए protocol fee में बाद का कोई
बदलाव पहले से खुले loan को उसी rate पर छोड़ देता है जिस पर वह शुरू हुआ था।

---

<a id="chapter.create-offer"></a>

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

<a id="chapter.claim-center"></a>

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
है, ब्याज वाले हिस्से पर treasury cut घटाकर। यह cut का प्रतिशत आपके
loan के बनते समय तय हो जाता है — बाद में protocol fee बदलने से यह
नहीं बदलता। मौजूदा दर पर बने loans पर यह cut
`{liveValue:treasuryFeeBps}`% है। loan settle होते
ही — repay, default या liquidation के बाद — यह claimable हो जाता
है। claim आपके lender position NFT को atomically consume करता है
— transaction land होते ही loan का वह पक्ष पूरी तरह close हो
जाता है।

<a id="claim-center.claims:borrower"></a>

#### यदि आप borrower हैं

यदि आपने loan पूरी तरह चुका दिया है, तो आपका borrower claim
वह collateral लौटा देता है जो आपने शुरुआत में लॉक किया था।
default या liquidation पर भी एक बार देख लें। कर्ज़ और उसे बंद करने की लागत जितना मूल्य ही लिया जाता है, और
उससे ऊपर जो कुछ है वह आपके नाम दर्ज होता है। वह किस रूप में होगा
यह इस पर निर्भर है कि loan कैसे ख़त्म हुआ: अगर collateral exchange
के ज़रिए बेचा गया, तो बचा हुआ आपको loan के अपने asset में मिलता है।
और अगर उसे सौंपा गया, तो collateral खुद आपका इंतज़ार करता है। एक से ज़्यादा चीज़ें उसे सौंपती हैं, चाहे loan किसी भी तरह ख़त्म हुआ हो:
liquidator का छूट पर सीधे ले लेना, वह close-out जो बेचे जाने के बजाय
protocol के भीतर किसी विपरीत position से match हो जाता है, या ऐसी बिक्री जो हो ही न सकी — वहाँ collateral मिलता है, बशर्ते lender claim करते समय कोई चलने वाला
quote न लाए — वह लाए तो भुगतान loan के अपने asset में होता है;
ज़्यादातर में कोई quote होता ही नहीं। सामान्य liquidation और default, दोनों exchange
जाने से पहले वही अंदरूनी match खोजते हैं, इसलिए इन दोनों में से किसी
का नतीजा हमेशा एक-सा नहीं होता; loan कैसे बंद हुआ इससे अंदाज़ा लगाने
के बजाय claim पढ़ें। छूट पर सीधे ले लेना अपवाद है, और वह उल्टी दिशा
में तय है: वह कभी बेचता नहीं, इसलिए हमेशा collateral ही छोड़ता है। अक्सर —
ऐसे collateral पर default में जिसकी कीमत हम नहीं आँक सकते — पूरी
basket चली जाती है और कुछ नहीं बचता, इस रास्ते पर यही नियम है, कोई दुर्भाग्यपूर्ण नतीजा नहीं।
claim आपके borrower position NFT को consume
करता है। उल्टा सच नहीं है: liquidation के बाद NFT का बचा रहना इस बात
का सबूत नहीं कि कुछ आपका इंतज़ार कर रहा है। अगर कुछ बचा ही नहीं, तो
लेने को कुछ नहीं होता, कोशिश अस्वीकार हो जाती है, और NFT फिर भी रह
सकता है। NFT को वादा मानने के
बजाय claim क्या कहता है वह पढ़ें।

---

<a id="chapter.activity"></a>

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

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI पाना

VPFI freely transferable है। इसे open market पर जहाँ भी वह trade
होता है वहाँ हासिल करें, या bridge करके लाएँ — VPFI एक Chainlink
CCIP token है, इसलिए वह official bridge का उपयोग करके supported
chains के बीच move करता है और आप जिस chain से जुड़े हैं उसी पर
आपके wallet में आता है।

<a id="buy-vpfi.discount-status"></a>

### आपकी VPFI Discount Status

यह कार्ड तुरंत बताता है कि आप अभी किस discount tier में हैं।
Tier आपके **vault** में रखे VPFI से तय होता है, wallet balance
से नहीं। कार्ड यह भी बताता है: (a) अगले tier तक पहुँचने के लिए
vault में और कितना VPFI चाहिए, और (b) Dashboard पर consent
switch चालू है या नहीं — discount तभी लागू होता है जब वह चालू
हो।

<a id="buy-vpfi.deposit"></a>

### अपने vault में VPFI deposit करें

आपके wallet में रखा VPFI discount tier में नहीं गिना जाता। fee
discount unlock करने के लिए आपको उसे खुद vault में move करना
होगा। यह हमेशा आपकी स्पष्ट action होती है — ऐप आपकी मर्ज़ी के
बिना आपका VPFI कभी move नहीं करता। एक transaction (या supported
chains पर एक signature) और काम पूरा।

<a id="buy-vpfi.unstake"></a>

### vault से VPFI निकालें

कुछ VPFI वापस wallet में चाहिए? यह कार्ड उसे vault से वापस भेज
देता है। ध्यान रहे: VPFI निकालते ही आपका discount tier
**तुरंत** घट सकता है। यदि आपके open loans हैं, तो उसी पल से
discount math lower tier के आधार पर चलने लगती है।

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards के बारे में

Vaipakam आपको एक **platform-interaction reward** देता है: जिस loan
में आप शामिल हैं उसमें settle हुए ब्याज के हर dollar पर आप
community-wide reward pool का daily हिस्सा कमाते हैं।

Rewards VPFI में मिलते हैं, सीधे उसी chain पर mint होकर जहाँ आप
हैं। कोई bridge नहीं, कोई chain switch नहीं।

<a id="rewards.claim"></a>

### Rewards Claim करें

एक button आपके accrued rewards को एक ही transaction में claim
कर देता है। interaction-pool का हिस्सा दिन में एक बार settle होता
है, इसलिए यदि आपने पिछली settlement के बाद कुछ कमाया है, तो वह
अगले daily window बंद होने के थोड़ी देर बाद live होगा।

---

<a id="chapter.loan-details"></a>

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
  आपके loan के बनते समय तय हुआ treasury cut घटाकर (मौजूदा दर पर बने
  loans के लिए `{liveValue:treasuryFeeBps}`%)। यह आपके lender NFT को
  consume करता है।
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
  collateral लौटाता है। Default में भी surplus बच सकता है:
  collateral में से उतना ही लिया जाता है जितना कर्ज़ और उसे बंद
  करने की लागत माँगे, उससे ज़्यादा जो आपने रखा था वह आपके claim
  के रूप में दर्ज होता है। वह क्या होगा यह रास्ते पर निर्भर है —
  Claim Center भाग देखें।

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### Alerts के बारे में

जब आपके collateral की कीमत गिरती है, तो आपके loan का safety
score — यानी Health Factor — भी गिर सकता है। Alerts आपको opt-in
करने देते हैं ताकि liquidation से **पहले** आपको heads-up मिल
जाए। एक छोटी off-chain service हर पाँच मिनट में आपके loans देखती
है और score danger band पार करते ही आपको ping करती है। कोई gas
cost नहीं; on-chain कुछ नहीं बदलता।

<a id="alerts-inbox"></a>

### Alerts इनबॉक्स

Alerts पेज उन alerts की सूची दिखाता है जो प्रोटोकॉल का index आपके wallet के लिए उस नेटवर्क पर रखता है जिस पर आप हैं, सबसे नए पहले। यह मुफ़्त है और किसी चीज़ के लिए साइन अप नहीं करना पड़ता। Alert तब लिखा जाता है जब कोई loan शुरू होता है, आंशिक या पूरा चुकाया जाता है, डिफ़ॉल्ट होता है या liquidate होता है, अपनी due date के पास आता है, अपनी grace अवधि में जाता है या उससे निकलता है, या उसकी health 1.5, 1.2 या 1.05 से नीचे जाती है, और जब कोई reward entry अपनी claim की आख़िरी तारीख़ के पास आती है या उसे पार कर जाती है। हर alert loan खोलता है, जिसका पेज उसे chain से पढ़ता है, या reward के लिए Claims। ऊपर आपके wallet के पास की घंटी गिनती है कि इस browser में पिछली बार पेज खोलने के बाद कितने alerts आए। अगर index पढ़ा नहीं जा सकता, तो पेज खाली इनबॉक्स दिखाने के बजाय यही बताता है। Telegram, push, health चेतावनियाँ और भुगतान रिमाइंडर इनबॉक्स के ठीक नीचे सेट किए जाते हैं। हर अलर्ट बताता है कि लिखे जाते समय स्थिति कैसी थी; अभी की स्थिति देखने के लिए ऋण खोलें।

<a id="alerts-channels"></a>

### Telegram, push और चेतावनियाँ

इनबॉक्स के नीचे, Alerts पेज वे अलर्ट सेट करता है जो app के बाहर आप तक पहुँचते हैं। हर बदलाव आपके वॉलेट में एक मुफ़्त हस्ताक्षर है, लेनदेन नहीं। Telegram जोड़ने के लिए Telegram जोड़ें दबाएँ, एक बार का कोड दस मिनट के भीतर Vaipakam bot को भेजें, फिर एक टेस्ट अलर्ट भेजें: जब वह संदेश आपकी चैट तक पहुँचता है तो लिंक काम करता माना जाता है। Push तभी दिया जाता है जब अलर्ट सेवा कहती है कि वह अभी भेज सकती है; आप अपने push app में Vaipakam चैनल की सदस्यता भी लेते हैं, और रोकने के लिए वहीं सदस्यता छोड़ते हैं। Telegram या push सेट होने के बाद health चेतावनियाँ हमेशा चालू रहती हैं, health 1.5, 1.2 और 1.05 पर। भुगतान रिमाइंडर बंद और चालू किए जा सकते हैं। पेज बताता है कि इस browser ने क्या किया है; किसी दूसरे डिवाइस से किया गया लिंक या सेटिंग मौजूद हो सकती है।

<a id="alerts-paid-push"></a>

### सशुल्क push अलर्ट

कुछ नेटवर्क पर अलर्ट सेवा किसी loan के push अलर्ट के लिए VPFI में छोटा शुल्क लेती है। वह आपसे शुल्क तभी ले सकती है जब आप पहले on-chain सहमति दें, और उतनी ही सीमा तक जितना देने पर आपने सहमति दी। सशुल्क push अलर्ट वाला हिस्सा इस नेटवर्क का शुल्क और यह दिखाता है कि सेवा यहाँ शुल्क लेती है या नहीं। शुल्क आपके vault के मुक्त VPFI से लिया जाता है, हर loan side पर अधिकतम एक बार, जब उस loan का पहला सशुल्क push अलर्ट भेजा जाता है; लिया गया शुल्क वापस नहीं होता, और Telegram अलर्ट मुफ़्त हैं। आपकी सीमा के भीतर शुल्क बढ़ने पर दोबारा पूछे बिना शुल्क लिया जाता है। आप सहमति कभी भी वापस ले सकते हैं।

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics के बारे में

एक नेटवर्क पर प्रोटोकॉल का बिना वॉलेट वाला दृश्य: वह नेटवर्क
जिसे ऐप पढ़ रहा है। आपको कुछ भी कनेक्ट करने की ज़रूरत नहीं।
पेज दो सार्वजनिक स्रोतों पर टिका है और हर आँकड़े का स्रोत बताता
है — सार्वजनिक इंडेक्सर, जिसे कोई भी बिना कुंजी के पूछ सकता है,
और खुद प्लेटफ़ॉर्म कॉन्ट्रैक्ट — ताकि आपको किसी आँकड़े पर आँख
मूँदकर भरोसा न करना पड़े।

<a id="public-dashboard.loans-offers"></a>

### लोन और ऑफ़र

स्थिति के अनुसार लोन की गिनती (सक्रिय, चुकाए गए, डिफ़ॉल्ट,
लिक्विडेट आदि) और ऑफ़र की गिनती, सार्वजनिक इंडेक्सर से। जो
गिनती इंडेक्सर ने नहीं बताई, वह "रिपोर्ट नहीं हुआ" दिखती है,
शून्य कभी नहीं। यहाँ केवल ऑन-चेन ऑफ़र गिने जाते हैं: बिना गैस
वाले साइन किए ऑर्डर यहाँ नहीं गिने जाते, हालाँकि वे Offer Book
में दिखते हैं। ऑफ़र का कुल वे ऑफ़र हैं जो अभी रिकॉर्ड में हैं,
अब तक की कुल गिनती नहीं।

<a id="public-dashboard.recycling"></a>

### रीसाइक्लिंग खाता और लूप क्लोज़र

हर दिन का रिवॉर्ड पूल कहाँ से आया और उसमें से कितना निकाला गया,
और क्लेम से दिए गए रिवॉर्ड VPFI का कितना हिस्सा प्लेटफ़ॉर्म के
भीतर रहता है। ये सार्वजनिक इंडेक्सर के बहीखाते के रिकॉर्ड हैं;
जो आँकड़ा अभी पता नहीं, वह शून्य दिखाने के बजाय यही बताता है।

<a id="public-dashboard.transparency"></a>

### पारदर्शिता और स्रोत

प्लेटफ़ॉर्म कॉन्ट्रैक्ट का पता, ब्लॉक एक्सप्लोरर में खोलने के
लिंक के साथ, नेटवर्क, इंडेक्सर का पढ़ा हुआ आख़िरी ब्लॉक और वह
कितनी देर पहले था। इंडेक्सर के आँकड़े उतने ही ताज़ा हैं जितना वह
ब्लॉक, इसीलिए उसकी उम्र दिखाई जाती है।

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI टोकन

सीधे प्लेटफ़ॉर्म कॉन्ट्रैक्ट से पढ़ा गया, इंडेक्सर से नहीं: VPFI
टोकन का पता और इस नेटवर्क पर उसकी आपूर्ति। जिस नेटवर्क पर VPFI
जारी होता है, वहाँ पेज आपूर्ति की सीमा, उसके भीतर अभी और कितना
मिंट हो सकता है, और मिंट करने की अनुमति वाला एकमात्र पता भी
दिखाता है। जिस नेटवर्क पर VPFI ब्रिज से पहुँचता है, वहाँ केवल उस
नेटवर्क की आपूर्ति दिखती है।

<a id="public-dashboard.fees"></a>

### शुल्क और ट्रेज़री

यह भी कॉन्ट्रैक्ट से पढ़ा जाता है: रिकॉर्ड शुरू होने से अब तक,
पिछले दिन में और पिछले हफ़्ते में प्रोटोकॉल द्वारा दर्ज शुल्क, और
वह ट्रेज़री पता जहाँ वे जाते हैं। पेज पढ़ा गया ब्लॉक, उस रीडिंग की
उम्र और बुलाए गए फ़ंक्शन बताता है, और हर वह कारण बताता है जिससे
शुल्क के आँकड़े वास्तव में वसूली गई राशि से कम हो सकते हैं। संदर्भ
मुद्रा बदलने के बाद पहले के शुल्क पुरानी इकाई में रहते हैं, जिससे
कोई योग किसी भी दिशा में खिसक सकता है; पेज यह भी बताता है। जो
आँकड़ा पढ़ा नहीं जा सका, वह शून्य दिखाने के बजाय यही बताता है।

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.next-app"></a>

## अगला ऐप

Vaipakam ऐप का अगला संस्करण मौजूदा ऐप के साथ-साथ, एक-एक पेज करके
बन रहा है। जो पेज अभी नहीं बना है, वह यह बताता है और आपको मौजूदा
ऐप पर भेजता है, जो उसे अब भी चलाता है। यह अध्याय उन पेजों को
समझाता है जो बन चुके हैं।

<a id="advanced-mode"></a>

### Basic और Advanced

Basic वह दिखाता है जिसकी ज़्यादातर लोगों को ज़रूरत होती है।
Advanced exit और settlement के टूल, automation, signed orders,
keeper की स्थिति और हिसाब-किताब का विवरण जोड़ता है। मोड बदलने से
वह सहमति कभी नहीं छिपती जो आपको देनी है, न वह जो आपको रोक रहा है,
न उसे ठीक करने का तरीका। जिस वाक्य को वह समझाता है उसके बाद आने वाला हर जानकारी बटन (i)
पूरी व्याख्या खोलता है,
और उसका "और पढ़ें" लिंक इस गाइड को आपके मौजूदा मोड में खोलता है।

<a id="wallet"></a>

### आपका wallet और आपके आँकड़े कहाँ से आते हैं

ऐप आपके loans, vault और claims को सबसे पहले आपके wallet के अपने
नेटवर्क कनेक्शन से पढ़ता है। केवल तब, जब wallet कोई कनेक्शन नहीं
देता, वह एक read-only proxy का उपयोग करता है। आपके अपने आँकड़े
कभी साझा index से नहीं लिए जाते। ऊपर दिखाया गया पता और नेटवर्क
वही हैं जिनसे पेज का हर आँकड़ा जुड़ा है। अगर आपका wallet ऐसे
नेटवर्क पर है जिसे ऐप नहीं चलाता, तो बदलने तक आपका कुछ भी नहीं
दिखाया जाता।

<a id="deployments"></a>

### deployment क्या-क्या सपोर्ट करता है

कोई भी action दिखाने से पहले ऐप पढ़ता है कि आपके नेटवर्क पर
protocol contract अभी कौन-से functions सपोर्ट करता है। upgrade से
यह सूची बदल सकती है, और इसे पढ़ने से ऐप असफल होने के बजाय बता
सकता है कि क्या बदला। अगर सूची पढ़ी नहीं जा सकती, तो कोई signing
step नहीं दिखाया जाता।

<a id="home-start"></a>

### Home: काम चुनना

Home "मैं चाहता/चाहती हूँ…" से शुरू होता है: उधार लेना, उधार देना,
NFT किराए पर लेना, अपना NFT किराए पर देना, या जो आपके पास है उसे
संभालना। हर विकल्प एक guided पेज खोलता है। उधार लेना और देना
पहले मेल खाते offers दिखाते हैं, और कोई न जमे तो आपको अपना offer
डालने देते हैं। किराया दोनों पक्षों को कवर करता है: किसी और का
NFT इस्तेमाल करना, या अपना NFT vault में रखते हुए किसी को इस्तेमाल
करने देना। wallet जुड़ा होने पर Home तीन छोटे शुरुआती कार्ड भी
दिखाता है, जिन्हें आप छिपा सकते हैं।

<a id="home-status"></a>

### Home: protocol की स्थिति

Home हमेशा बताता है कि आपके नेटवर्क पर protocol चल रहा है या नहीं।
किसी घटना के कारण pause होने पर नई positions, claims, withdrawals,
liquidations, defaults और keeper के steps रुक जाते हैं। पूरा
repayment, आंशिक repayment और collateral जोड़ना खुले रहते हैं, और
pause का समय हर खुले loan की due date में जुड़ जाता है। automatic
pause एक तय समय तक चलता है, और नया pause cooldown के बाद ही शुरू
हो सकता है। keeper सेवा को अलग से pause किया जा सकता है; यह आपके
अपने कामों को कभी नहीं रोकता। अगर स्थिति पढ़ी नहीं जा सकती, तो
Home यह मानने के बजाय कि सब चल रहा है, ऊपर यही बताता है।

<a id="home-payouts"></a>

### Home: लेने के लिए तैयार

payout तब तैयार होता है जब loan खत्म हो चुका हो और claim करने पर
आपको अभी भुगतान मिले: lender के लिए repayment, borrower के लिए
वापस मिलने वाला collateral (या उसका बचा हिस्सा), या किराया खत्म
होने पर लौटाया गया NFT। Home इन्हें सबसे पहले दिखाता है और आपको
Claims पर भेजता है, जहाँ लेने से पहले हर रकम दिखती है।

<a id="home-loans"></a>

### Home: आपके loans

हर चालू loan आपकी भूमिका, उसकी शर्तें, उसका collateral और अगली
समय-सीमा दिखाता है, सबसे ज़रूरी पहले। loan अपनी due date पर देय
होता है। उसके बाद grace period चलता है, जिसमें borrower late fee
देकर अब भी चुका सकता है। grace period खत्म होने पर कोई भी default
शुरू कर सकता है, जो loan को collateral से निपटाता है। health
factor collateral के मूल्य की तुलना कर्ज़ से करता है: 1 से नीचे
होने पर loan liquidate हो सकता है। जिस asset का कोई price नहीं, उस
loan का health factor नहीं होता। आपके किसी offer से खुले loans
एक साथ दिखाए जाते हैं।

जिस loan में ब्याज समय-समय पर चुकाया जाता है, उसमें due date तक (उस दिन समेत) भुगतान-बिंदु भी होते हैं। किसी भुगतान-बिंदु का grace period खत्म होने पर भी बाकी ब्याज collateral बेचकर चुकाया जा सकता है, और loan खुला रहता है; Home अगला भुगतान-बिंदु दिखाता है और बकाया वाले को सबसे पहले रखता है, चाहे वह due date पर ही पड़े, क्योंकि उसका grace period loan के grace period से पहले खत्म हो सकता है। protocol यह settlement बंद कर सकता है; तब Home बताता है कि भुगतान-बिंदु पर कोई collateral नहीं बेचा जाता।

<a id="home-exposure"></a>

### Home: दिया गया और लिया गया

जब आप उधार देते भी हैं और लेते भी हैं, तो Home दोनों पक्षों की
तुलना आज के मूल्य से करता है। जिन loans का मूल्य नहीं आँका जा
सकता, जैसे NFTs या बिना price वाले assets, उन्हें गिना जाता है और
अलग रखा जाता है, और Home बड़ा पक्ष तभी बताता है जब वे जवाब न
बदल सकें।

<a id="home-faucet"></a>

### Home: टेस्ट एसेट

टेस्ट नेटवर्क पर Home टेस्ट टोकन और NFT देता है, ताकि आप असली पैसे के बिना उधार लेना, उधार देना और किराये पर लेना-देना आज़मा सकें। इनकी कोई कीमत नहीं होती और इन्हें प्रोटोकॉल नहीं, टेस्ट टोकन कॉन्ट्रैक्ट मिंट करते हैं। कुछ टेस्ट टोकन की एक टेस्ट कीमत होती है, इसलिए उनमें बने लोन का हेल्थ फैक्टर होता है; बाकी की कोई कीमत नहीं होती, इसलिए डिफ़ॉल्ट पर कोलैटरल ही सौंप दिया जाता है। टेस्ट NFT किराये पर दिए जा सकते हैं। हर मिंट से पहले एक रसीद दिखती है, और बाद में नतीजा चेन पर जाँचा जाता है।

<a id="home-fee-discount"></a>

### Home: फीस छूट

फीस छूट आपके पूरे वॉलेट के लिए हर नेटवर्क पर एक ही सेटिंग है। जब यह बंद हो, तो आपके पास कितना भी VPFI हो, फीस पर कोई छूट नहीं मिलती। जब यह चालू हो, तो उधार लेते समय की फीस और लेंडर के रूप में कमाए ब्याज पर लगने वाली फीस, हर फीस लगने के समय के आपके VPFI डिस्काउंट टियर के हिसाब से घटती है; टियर 0 पर कोई छूट नहीं होती। कुछ नेटवर्क पर लेंडर की छूट आपकी वॉल्ट के VPFI से चुकाई जाती है, और पुष्टि करने से पहले रसीद बताती है कि कौन-सा तरीका लागू है। इसे चालू करने के लिए मौजूदा शर्तें स्वीकार करनी होती हैं; बंद करने के लिए कभी नहीं। प्रोटोकॉल रुका हो तो इसे किसी भी दिशा में नहीं बदला जा सकता। किसी इलिक्विड लेंडिंग एसेट वाले लोन पर उधार लेने की पूरी फीस ही लगती है, और कोई भी छूट कभी फीस के आधे से ज़्यादा नहीं होती।

<a id="home-rewards"></a>

### Home: रिवॉर्ड

रिवॉर्ड इस नेटवर्क पर आपके लेंडिंग और बॉरोइंग के लिए उपयोग-आधारित छूट हैं, जो हर रिवॉर्ड दिन के हिसाब से गिने जाते हैं और VPFI में दिए जाते हैं। Home ठीक वही दिखाता है जो अभी किया गया क्लेम देगा, क्योंकि ऐप पहले क्लेम को प्रीव्यू के रूप में चलाता है। अगर वह प्रीव्यू नहीं चल पाता, तो Home उसकी जगह एक निचली सीमा दिखाता है, जिस पर यही लिखा होता है, और सटीक रकम निकल पाने तक क्लेम नहीं देता। एक क्लेम अधिकतम 30 रिवॉर्ड दिन देता है; और बचे हों तो Home फिर से क्लेम करने का विकल्प देता है, और बीच में रुकना सुरक्षित है। क्लेम आपके वॉल्ट में पहुँचता है, इस्तेमाल के लिए तैयार, या वॉल्ट उसे न ले सके तो आपके वॉलेट में; क्लेम कभी वॉल्ट नहीं खोलता। जब कोई रिवॉर्ड दिन अभी नेटवर्कों में अंतिम होने का, या इस नेटवर्क तक अपनी फंडिंग पहुँचने का इंतज़ार कर रहा हो, तो Home विफल होने वाला क्लेम देने के बजाय उस दिन का नाम बताता है। रिवॉर्ड ब्याज या यील्ड नहीं हैं, और क्लेम करने से कभी कुछ स्टेक या दोबारा निवेश नहीं होता। कभी-कभी कोई क्लेम कुछ नहीं चुकाता, फिर भी उन रिवॉर्ड दिनों से आगे बढ़ता है जिन्होंने आपको कुछ नहीं चुकाया, ताकि उनके बाद के दिन चुकाए जा सकें; Home यह बताता है और फिर भी उसे पेश करता है।

<a id="home-rewards-expiry"></a>

### Home: रिवॉर्ड हटने की तारीखें

जिस नेटवर्क पर बिना क्लेम किए रिवॉर्ड हटाए जा सकते हैं, वहाँ Home आपके रिवॉर्ड में सबसे जल्दी हटने की अनुमानित तारीख दिखाता है, और उससे पहले के आख़िरी 90 दिनों में अंतिम सूचना। उससे पहले क्लेम करने पर रिवॉर्ड हमेशा बना रहता है। मौजूदा स्थिति में अनुमान असली तारीख से कभी बाद का नहीं होता: जिस समय रिवॉर्ड क्लेम नहीं किया जा सकता, वह असली तारीख को आगे खिसकाता है, लेकिन नेटवर्क की क्लेम अवधि में बदलाव उसे पहले कर सकता है, इसलिए भरोसा करने से पहले दोबारा जाँचें। अगर हर रिवॉर्ड जाँचा नहीं जा सका, तो Home यह बताता है, यह नहीं कहता कि कुछ भी बाकी नहीं है। जहाँ नेटवर्क कुछ नहीं हटाता, वहाँ कोई तारीख नहीं दिखाई जाती।

<a id="home-rewards-held"></a>

### Home: रोके गए रिवॉर्ड

अगर सैंक्शन जाँच आपके वॉलेट को फ़्लैग करती है, तो फ़्लैग रहने तक उसे कुछ नहीं दिया जाता। फ़्लैग से पहले कमाए गए रिवॉर्ड उसके लिए रोक लिए जाते हैं, लॉक हैं पर खोए नहीं, और वॉलेट के फ़्लैग न रहने पर जारी कर दिए जाते हैं; तब Home ठीक उसी बैलेंस को अलग से क्लेम करने का विकल्प देता है। फ़्लैग पक्का होने तक कमाए गए रिवॉर्ड हमेशा के लिए ज़ब्त हो जाते हैं और आपके वॉल्ट का VPFI हिलाया नहीं जा सकता। अगर यह न पढ़ा जा सके कि वॉलेट अब भी फ़्लैग है या नहीं, तो कुछ भी जारी नहीं होता।

<a id="borrow-start"></a>

### Borrow: यह कैसे काम करता है

उधार लेने के लिए आप किसी लेंडर का खुला ऑफ़र स्वीकार करते हैं: किसी एक टोकन की राशि, एक दर, एक अवधि और वह कोलैटरल जो लेंडर माँगता है। इसे स्वीकार करते ही एक ही ट्रांज़ैक्शन में लोन खुल जाता है। आपका कोलैटरल आपके वॉलेट से आपके अपने वॉल्ट में जाता है और लोन खुला रहने तक वहीं लॉक रहता है, और राशि, एक छोटी इनिशिएशन फ़ीस घटाकर, आपके वॉलेट में आती है। आप नियत तारीख़ तक राशि और ब्याज लौटाते हैं। जब कोई ऑफ़र फ़िट न हो, तो आप अपना उधार अनुरोध पोस्ट करके लेंडर का इंतज़ार भी कर सकते हैं।

<a id="borrow-pair"></a>

### Borrow: टोकन चुनना

पहले चुनें कि क्या उधार लेना है और क्या लॉक करना है। ऐप नेटवर्क के टोकन सुझाता है, या आप टोकन पता पेस्ट कर सकते हैं; टोकन-सुरक्षा की कोई जाँच नहीं चलती, इसलिए पेस्ट किया पता ख़ुद जाँचें। हर टोकन के लिए ऐप पढ़ता है कि प्रोटोकॉल अभी उसके बारे में क्या कहता है। लिक्विड टोकन की क़ीमत होती है, इसलिए लोन का हेल्थ फ़ैक्टर होता है और कोलैटरल का मूल्य गिरने पर उसे लिक्विडेट किया जा सकता है। इलिक्विड टोकन का मूल्य शून्य माना जाता है, और डिफ़ॉल्ट पर लेंडर को कोलैटरल ख़ुद मिलता है। जब प्रोटोकॉल किसी टोकन की क़ीमत पर भरोसा नहीं करता, तब तक उस पर नए लोन बंद रहते हैं; पहले से खुले लोन प्रभावित नहीं होते।

<a id="borrow-offers"></a>

### Borrow: ऑफ़र चुनना

पेज आपके दोनों टोकन के लिए लेंडर्स के खुले ऑफ़र दिखाता है, जो सीधे प्रोटोकॉल से पढ़े जाते हैं। हर ऑफ़र में राशि, दर और अवधि, माँगा गया कोलैटरल, आज की क़ीमतों पर लोन-टू-वैल्यू, ब्याज कैसे लगता है, कोई ब्याज शेड्यूल, ऑफ़र कब ख़त्म होता है और फ़ीस के बाद आपको क्या मिलेगा, दिखता है। ऑफ़र पूरा स्वीकार होता है, लेंडर की पूरी राशि और सबसे कम दर पर। अगर प्रोटोकॉल किसी ऑफ़र को मना करेगा, तो पेज कारण बताता है और कोई बटन नहीं दिखाता। क्रम सुविधा के लिए है, सलाह नहीं।

<a id="borrow-review"></a>

### Borrow: समीक्षा और साइन करना

वॉलेट खुलने से पहले समीक्षा हर आँकड़ा दिखाती है: आपको क्या मिलेगा, फ़ीस, आप क्या लॉक करेंगे, दर, नियत तारीख़ पर कितना देना होगा, ग्रेस अवधि और आप क्या खो सकते हैं। जोखिम प्रकटीकरण और शर्तों से सहमति के लिए आप एक बॉक्स टिक करते हैं; पुष्टि से पहले आँकड़े बदलें तो टिक हट जाता है। फिर वॉलेट आपसे शर्तों पर साइन करने को कहता है, जिसकी कोई लागत नहीं, ज़रूरत हो तो ठीक कोलैटरल जितनी मंज़ूरी देने को, और स्वीकृति भेजने को, जिसे ऐप पहले ड्राई रन में आज़माता है। अगर मंज़ूरी के बाद यह रुक जाए, तो ऐप मंज़ूरी वापस रखने को कहता है और बताता है कि ऐसा हुआ या नहीं। बाद में ऐप चेन पर खुला लोन, आई राशि और लॉक हुआ कोलैटरल जाँचता है। यह ऋण की अवधि की शर्तें भी बताता है, हर एक को तब भी जब वह डिफ़ॉल्ट हो: आंशिक चुकौती, संपार्श्विक की बिक्री, और कोई पुनर्वित्त या जुड़ा हुआ ऋण। देय राशि यह मानती है कि कोई विराम नहीं होगा: विराम नियत तारीख को आगे खिसका देता है और उस दौरान ब्याज चलता रहता है।

<a id="borrow-fee"></a>

### Borrow: इनिशिएशन फ़ीस

लोन खोलने की लागत राशि का एक छोटा हिस्सा है, एक बार, उधार लिए टोकन में, और आपको मिलने वाली राशि से काटी जाती है; समीक्षा लागू दर दिखाती है। ब्याज पूरी राशि पर देना होता है। फ़ीस डिस्काउंट चालू हो और उधार लिया टोकन लिक्विड हो, तो आपका डिस्काउंट टियर फ़ीस घटाता है। इस फ़ीस के लिए कोई VPFI न लिया जाता है न रखा जाता है, और बाद में कुछ लौटाया नहीं जाता। चूँकि स्वीकृति आप ख़ुद भेजते हैं, फ़ीस का एक छोटा हिस्सा, जो प्रोटोकॉल मैच जमा करने वाले को देता है, राशि के साथ आपको वापस मिलता है; समीक्षा इसे दिखाती है।

<a id="borrow-risks"></a>

### Borrow: जोखिम

लोन से आपका कोलैटरल जा सकता है। अगर ग्रेस अवधि के अंत तक आपने नहीं लौटाया, तो लोन डिफ़ॉल्ट होता है और लेंडर को आपके कोलैटरल से भुगतान होता है: जहाँ प्रोटोकॉल कर सके वहाँ बेचकर, जहाँ नहीं वहाँ जैसा है वैसा सौंपकर। लिक्विड कोलैटरल का मूल्य इतना गिरे कि हेल्थ फ़ैक्टर 1 से नीचे चला जाए, तो कोई भी लोन लिक्विडेट कर सकता है और आप कोलैटरल खोते हैं। फ़ुल-टर्म ब्याज में जल्दी लौटाने पर भी पूरी अवधि का ब्याज देना होता है। ब्याज शेड्यूल हो, तो छूटी अवधि आपके कोलैटरल का हिस्सा बेचकर चुकाई जाती है। लोन लौटाए या निपटाए जाने तक आपका कोलैटरल लॉक रहता है।

<a id="borrow-request"></a>

### Borrow: अपना अनुरोध पोस्ट करना

जब कोई ऑफ़र फ़िट न हो, तो आप अपने दोनों टोकन के लिए अपना उधार अनुरोध पोस्ट कर सकते हैं: सटीक राशि, आप जो दर देंगे, अवधि और वह कोलैटरल जो आप लॉक करेंगे। पोस्ट करते ही कोलैटरल आपके वॉलेट से आपके अपने वॉल्ट में जाता है और अनुरोध खुला रहने तक वहीं रहता है। जो लेंडर इसे स्वीकार करता है, वह आपसे दोबारा पूछे बिना आपकी शर्तों पर तुरंत लोन खोल देता है; राशि, इनिशिएशन फ़ीस घटाकर, आपके वॉलेट में आती है। पोस्ट करने के पाँच मिनट बाद से आप रद्द कर सकते हैं, और कोलैटरल आपके वॉलेट में लौट आता है। समाप्त हो चुका अनुरोध अब स्वीकार नहीं किया जा सकता; उसका कोलैटरल आपके वॉल्ट में तब तक रहता है जब तक आप या कोई और उसे बंद न करे, और फिर केवल आपके वॉलेट में लौटता है। जब तक अगले ऐप का ऑफ़र पेज नहीं बनता, आप अनुरोध को मौजूदा ऐप के ऑफ़र पेज पर देखते, रद्द करते और बंद करते हैं; समीक्षा यह बात कुछ भी लॉक होने से पहले बताती है।

<a id="borrow-request-terms"></a>

### Borrow: अनुरोध की शर्तें

पूरी राशि एक ही लेंडर लेता है, या कोई नहीं। हर आँकड़ा ठीक वैसे ही पढ़ा जाता है जैसा आप लिखते हैं: टोकन के दशमलव से ज़्यादा अंक अस्वीकार होते हैं, कभी राउंड नहीं होते, और दर सालाना 100% तक, दो दशमलव तक हो सकती है। दी गई अवधियाँ नेटवर्क की अनुमति वाली सबसे लंबी अवधि पर रुकती हैं; आप अवधि दिनों में भी लिख सकते हैं। अनुरोध तब तक खुला रहता है जब तक स्वीकार या रद्द न हो, या आपके चुने दिनों तक, अधिकतम एक साल। पूरी अवधि का ब्याज, सामान्य विकल्प, जल्दी चुकाने पर भी पूरा देना होता है; अनुपातिक ब्याज केवल उतने समय का लगता है जितना लोन खुला रहे। फ़ॉर्म दिखाता है कि अगर कोई लेंडर अभी इसे स्वीकार करे तो आज की फ़ीस दर पर आपको कितना मिलेगा और नियत तारीख़ पर कितना देना होगा।

<a id="borrow-request-review"></a>

### Borrow: अनुरोध की समीक्षा और पोस्ट करना

वॉलेट खुलने से पहले ऐप प्रोटोकॉल से आपका अनुरोध ड्राई रन में आज़माने को कहता है, इसलिए समीक्षा प्रोटोकॉल का अपना जवाब दिखाती है। इसमें होता है: आप अभी क्या लॉक करेंगे, राशि, दर और अवधि, आपको क्या मिलेगा और फ़ीस कैसे तय होती है (लेंडर के स्वीकार करते समय लागू फ़ीस दर, उस समय के आपके फ़ीस-छूट स्तर को घटाकर; दिखाया गया आँकड़ा आज की दर पर है), आप कितना देंगे, लोन की हर शर्त, अनुरोध कब समाप्त होगा, लोन-टू-वैल्यू और क्या मंज़ूरी चाहिए। जोखिम प्रकटीकरण और शर्तों से सहमति के लिए आप एक बॉक्स टिक करते हैं। ज़रूरत हो तो वॉलेट ठीक कोलैटरल जितनी मंज़ूरी देता है, ऐप अनुरोध को फिर से आज़माता है, और तभी उसे पोस्ट करता है। अगर मंज़ूरी के बाद यह रुक जाए, तो ऐप मंज़ूरी वापस रखने को कहता है और बताता है कि ऐसा हुआ या नहीं। बाद में ऐप चेन पर दर्ज अनुरोध और लॉक हुआ कोलैटरल जाँचता है।

<a id="borrow-nft-collateral"></a>

### Borrow: NFT को कोलैटरल के रूप में

एक अनुरोध टोकन की जगह एक NFT लॉक कर सकता है। लॉक करने के लिए कलेक्शन चुनें (टेस्ट कलेक्शन NFT के रूप में चिह्नित हैं, या कोई पता पेस्ट करें); कोई पता टोकन है या NFT कलेक्शन, यह उसके कॉन्ट्रैक्ट से पढ़ा जाता है। फिर NFT का नंबर, यानी उसकी टोकन आईडी, लिखें जो आपके वॉलेट या कलेक्शन के पेज पर दिखती है; फ़ॉर्म तुरंत बताता है कि आपका वॉलेट उसे रखता है या नहीं। प्रोटोकॉल NFT का मूल्य शून्य मानता है, चाहे वह कहीं और कितने में भी बिके: उस पर लिए लोन का कोई लोन-टू-वैल्यू नहीं होता और कीमत आधारित लिक्विडेशन नहीं होता, और अगर आप ग्रेस अवधि खत्म होने तक नहीं चुकाते तो लेंडर को वही NFT मिलता है। पोस्ट करते समय आपका वॉलेट प्रोटोकॉल को केवल उसी एक NFT की मंज़ूरी देता है, आपके बाकी कलेक्शन की कभी नहीं, और उसे आपकी वॉल्ट में ले जाना वह मंज़ूरी अपने आप हटा देता है; अगर मंज़ूरी के बाद अनुरोध रुक जाए, तो ऐप उसे वापस करने को कहता है और बताता है कि ऐसा हुआ या नहीं। जो NFT मात्रा में आते हैं (मल्टी-टोकन कलेक्शन), वे भी इसी तरह, एक मात्रा के साथ काम करते हैं: टोकन का नंबर और उसमें से कितने लॉक करने हैं लिखें, और फ़ॉर्म बताता है कि आपके वॉलेट में कितने हैं। ऐसा कलेक्शन एक टोकन की मंज़ूरी नहीं दे सकता, केवल उसमें आपके सभी टोकनों की; इसलिए पोस्ट करना यह मंज़ूरी सिर्फ़ इसी अनुरोध के लिए देता है और बाद में एक और वॉलेट चरण में उसे वापस ले लेता है, चाहे अनुरोध पूरा हुआ हो या नहीं; जो मंज़ूरी आप पहले से दे चुके थे, वह वैसी ही छोड़ दी जाती है। NFT माँगने वाले लेंडर ऑफ़र को लेना अभी भी मौजूदा ऐप में ही होता है।

<a id="borrow-request-range"></a>

### Borrow: राशि की सीमा (उन्नत)

उन्नत मोड में एक अनुरोध एक सीमा स्वीकार कर सकता है: सबसे छोटी और सबसे बड़ी राशि जो ऋणदाता उधार दे सकता है, आपकी एक ही दर पर, और चाहें तो सबसे छोटे ऋण के लिए कम संपार्श्विक। अनुरोध को सीधे लेने वाला ऋणदाता सबसे छोटी राशि उधार देता है और केवल उसके लिए तय संपार्श्विक लॉक करता है; बाकी आपके वॉलेट में लौट आता है। नेटवर्क पर मैचिंग चालू रहने तक मैच सबसे बड़ी राशि तक अधिक उधार दे सकते हैं; समीक्षा बताती है कि यह चालू है या नहीं, और बंद रहने पर सीमा केवल एक बार भरती है। प्रोटोकॉल वह सबसे बड़ी राशि अस्वीकार करता है जिसे आज की कीमतों पर आपका संपार्श्विक नहीं संभालता, और समीक्षा बताती है कि वह अधिकतम कितना संभालता है। समीक्षा दोनों सिरों पर ऋण-से-मूल्य दिखाती है, और चेतावनी देती है जब आज की कीमतों पर कोई ऋणदाता अनुरोध को सीधे नहीं ले सकता। उन्नत मोड में चुने गए विकल्प बेसिक में जाने पर भी लागू रहते हैं: फ़ॉर्म यह बताता है और उन्हें हटाने देता है। मैच केवल उतना कोलैटरल लॉक करता है जितना उसका ऋणदाता माँगता है, कम से कम फ़्लोर; इसलिए समीक्षा सबसे बड़े मैच को आपके पूरे कोलैटरल से लेकर केवल फ़्लोर तक बताती है, और चेतावनी देती है कि मैच किया गया ऋण सीधे ऋण से अधिक जोखिम पर शुरू हो सकता है। मैचिंग चालू रहने तक, जो संपार्श्विक मैच लॉक नहीं करता वह बाद के मैचों के लिए अनुरोध के साथ रहता है और आपके वॉलेट में तभी लौटता है जब अनुरोध बंद हो या आप उसे रद्द करें।

<a id="borrow-request-fill"></a>

### Borrow: अनुरोध कैसे भरता है (उन्नत)

डिफ़ॉल्ट आंशिक मोड मैचों को अनुरोध एक या अधिक ऋणों में तब तक भरने देता है जब तक वह भर न जाए, रद्द न हो या समाप्त न हो। सब या कुछ नहीं पूरी राशि की केवल एक भराई की अनुमति देता है, इसलिए इसे सीमा के साथ नहीं चुना जा सकता। तुरंत या रद्द आंशिक की तरह भरता है, लेकिन केवल अनुरोध समाप्त होने तक, इसलिए इसे समाप्ति तिथि चाहिए। भराई मोड पोस्ट करने के बाद नहीं बदला जा सकता; बदलने के लिए अनुरोध रद्द करें और नया पोस्ट करें। अनुरोध खुला रहने तक प्रोटोकॉल राशियाँ, दर और संपार्श्विक बदलने देता है, पर मैच जितना उपयोग कर चुके हैं उससे कभी नीचे नहीं; यह ऐप अभी यह सुविधा नहीं देता, इसलिए फ़िलहाल बदलाव का मतलब रद्द करके फिर से पोस्ट करना है।

<a id="borrow-request-cadence"></a>

### Borrow: ब्याज की अनुसूची (उन्नत)

उन्नत मोड में अनुरोध का ब्याज चुकौती पर एक साथ देने के बजाय एक अनुसूची पर दिया जा सकता है: हर महीने, हर तिमाही, हर छह महीने या हर साल। फ़ॉर्म केवल वही अनुसूचियाँ देता है जिनकी प्रोटोकॉल आपकी शर्तों पर अनुमति देता है, और हर बंद अनुसूची के नीचे कारण बताता है: नेटवर्क पर आवधिक ब्याज बंद है, किसी एसेट की कोई कीमत नहीं है, ऋण का मूल्य प्रोटोकॉल की सीमा से कम है (दोनों आँकड़े दिखाए जाते हैं), या अवधि ऋण से छोटी नहीं है। समीक्षा में हर अवधि का ब्याज और छूटी हुई अवधि को मिलने वाली मोहलत दिखती है। यदि मोहलत खत्म होने तक किसी अवधि का भुगतान नहीं होता, तो कोई भी उसे चुकाने के लिए आपके कोलैटरल का एक हिस्सा बेच सकता है, और ऋण खुला रहता है। पोस्ट करने के बाद अनुसूची बदली नहीं जा सकती। दूसरे उन्नत विकल्पों की तरह, बेसिक में जाने पर भी यह लागू रहती है, और फ़ॉर्म यह बताता है।

<a id="borrow-request-tariff"></a>

### Borrow: फुल फ़ीस टैरिफ़ (उन्नत)

उन्नत मोड में अनुरोध फुल फ़ीस टैरिफ़ ले सकता है: VPFI में एक शुल्क, जो हर ऋण खुलते समय आपके वॉल्ट से लिया जाता है, और ऋण शुल्क की छूट में दस अंक जोड़ता है, प्रोटोकॉल की 50% सीमा तक। ऋण शुल्क स्वयं अब भी उधार दी गई संपत्ति में लिया जाता है, और टैरिफ़ लौटाया नहीं जाता। फ़ॉर्म इसे तभी देता है जब प्रोटोकॉल ने इसे चालू रखा हो, और आपकी राशि व अवधि के लिए आज का टैरिफ़ दिखाता है। आप तय करते हैं कि एक ऋण अधिकतम कितना VPFI ले सकता है (खाली छोड़ने पर सबसे बड़े ऋण का आज का टैरिफ़), और जो ऋण खुलते समय टैरिफ़ नहीं ले सकता उसका क्या हो: वह अस्वीकार हो, या उसके बिना खुले। ऋण इसे तभी ले सकता है जब उस समय टैरिफ़ चालू हो, उधार दी गई संपत्ति का मूल्य हो और वह तरल हो, उसका टैरिफ़ आपकी अधिकतम सीमा में हो, और आपके वॉल्ट में पर्याप्त मुक्त VPFI हो। टैरिफ़ अनुरोध पोस्ट होने के बाद दूसरे लेन-देन से सेट होता है, इसलिए उस लेन-देन की पुष्टि से पहले अनुरोध लेने वाला ऋणदाता इसके बिना ऋण खोलता है। जिन अनुरोधों को कोई नहीं लेता उनके लिए बैकस्टॉप ऋण यह ऐप अभी नहीं देता।

<a id="lend-start"></a>

### Lend: यह कैसे काम करता है

उधार देने के लिए आप किसी उधारकर्ता के खुले अनुरोध को फ़ंड करते हैं: एक टोकन की राशि, वह दर जो वे चुकाएँगे, एक अवधि, और वह कोलैटरल जिसे उधारकर्ता पहले ही अपने वॉल्ट में लॉक कर चुका है। इसे फ़ंड करने से एक ही ट्रांज़ैक्शन में लोन खुल जाता है। राशि आपके वॉलेट से जाती है, उधारकर्ता को वह अपनी इनिशिएशन फ़ीस घटाकर मिलती है, और कोलैटरल लोन खत्म होने तक आपके लिए लॉक रहता है। लोन में आपका पक्ष आपके वॉलेट में एक पोज़िशन टोकन है, और जिसके पास वह है उसी को भुगतान मिलता है। उधारकर्ता नियत तारीख तक राशि और ब्याज लौटाता है, और प्रोटोकॉल ब्याज में अपना हिस्सा रखता है। जब कोई अनुरोध फ़िट न हो, तो आप इसी पेज से अपना लेंडिंग ऑफ़र पोस्ट कर सकते हैं।

<a id="lend-offers"></a>

### Lend: अनुरोध चुनना

पहले चुनें कि आप क्या उधार देंगे और कौन-सा कोलैटरल स्वीकार करेंगे; दोनों अलग टोकन होने चाहिए, और यह पेज केवल टोकन देता है। पेज उस जोड़ी के खुले उधार अनुरोधों की सूची दिखाता है, जो सीधे प्रोटोकॉल से पढ़ी जाती है। हर एक में राशि, दर और अवधि, लॉक किया गया कोलैटरल, आज की कीमतों पर लोन-टू-वैल्यू, ब्याज कैसे लगता है, कोई ब्याज शेड्यूल, और उधारकर्ता की फ़ीस का कितना हिस्सा आपको वापस मिलता है, यह दिखता है। अनुरोध पूरा फ़ंड होता है: अगर उसमें एक सीमा है, तो आप उधारकर्ता की सबसे छोटी राशि उनकी सबसे ऊँची दर पर देते हैं। जब प्रोटोकॉल किसी अनुरोध को मना करेगा, तो पेज कारण बताता है और कोई बटन नहीं देता। आपके अपने अनुरोध, NFT वाले अनुरोध और चल रहे लोन की बिक्री गिनी जाती हैं, सूचीबद्ध नहीं। क्रम (पहले वे अनुरोध जिन्हें आप फ़ंड कर सकते हैं, फिर सबसे ऊँची दर) सुविधा के लिए है, सलाह नहीं।

<a id="lend-review"></a>

### Lend: समीक्षा और साइन करना

आपका वॉलेट खुलने से पहले समीक्षा हर आँकड़ा दिखाती है: आपके वॉलेट से क्या जाता है, उधारकर्ता को क्या मिलता है, फ़ीस और उसमें आपका हिस्सा, आपके लिए रखा गया कोलैटरल, दर, नियत तारीख पर बकाया ब्याज, उसमें प्रोटोकॉल का हिस्सा, आपको क्या वापस मिलता है, ग्रेस पीरियड और आप क्या खो सकते हैं। यह हर लाइफ़साइकिल शर्त भी बताती है, भले वह डिफ़ॉल्ट हो। अगर आपके वॉलेट में राशि से कम है, तो समीक्षा बताती है कि कितना कम है और साइन का विकल्प नहीं देती। आप जोखिम प्रकटीकरण और शर्तों से सहमति के लिए एक बॉक्स टिक करते हैं; पुष्टि से पहले आँकड़े बदलें तो बॉक्स हट जाता है। फिर आपका वॉलेट शर्तों पर साइन करने को कहता है, जिसकी कोई लागत नहीं, ज़रूरत हो तो ठीक राशि की अनुमति देने को, और स्वीकृति भेजने को, जिसे ऐप पहले ड्राई रन के रूप में आज़माता है। अगर अनुमति के बाद प्रक्रिया रुकती है, तो ऐप अनुमति वापस करने को कहता है और बताता है कि ऐसा हुआ या नहीं। बाद में ऐप चेन पर खुला लोन, आपके वॉलेट से गई राशि और वापस आई राशि जाँचता है।

<a id="lend-fee"></a>

### Lend: फ़ीस और प्रोटोकॉल का हिस्सा

इनिशिएशन फ़ीस उधारकर्ता की है: राशि का एक छोटा हिस्सा, उधार दी गई संपत्ति में एक बार लिया जाता है और उधारकर्ता को मिलने वाली राशि से काटा जाता है। आप पूरी राशि उधार देते हैं, और उधारकर्ता उसे ब्याज सहित पूरा लौटाता है। क्योंकि स्वीकृति आप खुद भेजते हैं, उस फ़ीस का एक छोटा हिस्सा, जो प्रोटोकॉल मैच भेजने वाले को देता है, आपके वॉलेट में वापस आता है; समीक्षा उसे दिखाती है। अगर उधारकर्ता ने Full फ़ीस टैरिफ़ चुना है और लोन खुलते समय वह लागू होता है, तो फ़ीस कम होती है, और वह हिस्सा भी। ब्याज चुकाए जाने पर प्रोटोकॉल अपना हिस्सा रखता है, उस दर पर जो लोन खुलते समय लागू हो; जब तक आपकी फ़ीस-डिस्काउंट सेटिंग चालू है, आपका फ़ीस-डिस्काउंट टियर वह हिस्सा घटा सकता है। समीक्षा आज की दर और वह अधिकतम दिखाती है जो यह हिस्सा ले सकता है।

<a id="lend-risks"></a>

### Lend: जोखिम

उधार देने में आपका पैसा जा सकता है। अगर ग्रेस पीरियड के अंत तक उधारकर्ता ने नहीं चुकाया, तो लोन डिफ़ॉल्ट होता है और आपको कोलैटरल से भुगतान मिलता है: जहाँ प्रोटोकॉल कर सके वहाँ आपके लिए बेचा जाता है, जहाँ नहीं वहाँ जैसा है वैसा सौंपा जाता है, और बिक्री से आपके बकाये से कम मिल सकता है। लिक्विड कोलैटरल के साथ, हेल्थ फ़ैक्टर 1 से नीचे जाते ही कोई भी लोन को लिक्विडेट कर सकता है; बिक्री पहले आपको चुकाती है, पर तेज़ गिरावट में आपके बकाये से कम बच सकता है। इलिक्विड टोकन का मूल्य शून्य माना जाता है, इसलिए कीमत-आधारित लिक्विडेशन नहीं होता, और डिफ़ॉल्ट पर आपको पूरा कोलैटरल मिलता है, उसकी जो भी कीमत हो। लोन खत्म होने से पहले आप राशि वापस नहीं ले सकते; जल्दी निकलने का मतलब है अपनी पोज़िशन किसी दूसरे ऋणदाता को बेचना। प्रो-राटा ब्याज में जल्दी चुकाने से आपको कम मिलता है। विराम नियत तारीख आगे खिसकाता है, और उस दौरान ब्याज बढ़ता रहता है।

<a id="lend-offer"></a>

### Lend: अपना ऑफ़र पोस्ट करना

जब कोई अनुरोध फ़िट न हो, तो आप अपने दोनों टोकन के लिए अपना लेंडिंग ऑफ़र पोस्ट कर सकते हैं: वह सटीक राशि जो आप उधार देंगे, आप जो दर माँगते हैं, अवधि और वह कोलैटरल जो उधारकर्ता को लॉक करना होगा। पोस्ट करते ही राशि आपके वॉलेट से आपके अपने वॉल्ट में जाती है और ऑफ़र खुला रहने तक वहीं लॉक रहती है। जो उधारकर्ता इसे स्वीकार करता है, वह आपसे दोबारा पूछे बिना आपकी शर्तों पर तुरंत लोन खोल देता है: उसे इनिशिएशन फ़ीस घटाकर राशि मिलती है, और उसका कोलैटरल आपके लिए उसके वॉल्ट में लॉक हो जाता है। जब तक नेटवर्क पर मैचिंग चालू है, कोई भी आपके ऑफ़र को किसी उधारकर्ता के अनुरोध से मैच भी कर सकता है; हिस्से तय न हों तो ऐसा लोन आपकी दर पर आपकी पूरी राशि उधार देता है, कम से कम उतने कोलैटरल के बदले जितना आप माँगते हैं। समीक्षा बताती है कि मैचिंग अभी चालू है या नहीं। पोस्ट करने के पाँच मिनट बाद से आप रद्द कर सकते हैं, और राशि आपके वॉलेट में लौट आती है। समाप्त हो चुका ऑफ़र अब स्वीकार नहीं किया जा सकता; उसकी राशि आपके वॉल्ट में तब तक रहती है जब तक आप या कोई और उसे बंद न करे, और फिर केवल आपके वॉलेट में लौटती है। जब तक अगले ऐप का ऑफ़र पेज नहीं बनता, आप ऑफ़र को मौजूदा ऐप के ऑफ़र पेज पर देखते, रद्द करते और बंद करते हैं; समीक्षा यह बात कुछ भी लॉक होने से पहले बताती है।

<a id="lend-offer-terms"></a>

### Lend: ऑफ़र की शर्तें

जब तक आप Advanced मोड में हिस्से तय नहीं करते, एक उधारकर्ता पूरी राशि लेता है, या कोई नहीं लेता, और उसे ठीक वही कोलैटरल लॉक करना होता है जो आप तय करते हैं। फ़ॉर्म दिखाता है कि आपके वॉलेट में उधार दिए जाने वाले टोकन का कितना है। हर अंक ठीक वैसा ही पढ़ा जाता है जैसा आप टाइप करते हैं: टोकन से ज़्यादा दशमलव अस्वीकार होते हैं, कभी राउंड नहीं होते, और दर दो दशमलव तक सालाना 100% तक जाती है। दी गई अवधियाँ नेटवर्क की अनुमति वाली सबसे लंबी अवधि पर रुकती हैं। ऑफ़र स्वीकार या रद्द होने तक खुला रहता है, या आपके चुने दिनों तक, अधिकतम एक साल। पूरी अवधि का ब्याज, जो आम चुनाव है, का अर्थ है कि जल्दी चुकाने से आपकी कमाई कम नहीं होती; आनुपातिक ब्याज आपको केवल लोन खुले रहने के समय का भुगतान करता है। आप उधारकर्ता को कुछ हिस्सा पहले चुकाने की अनुमति भी दे सकते हैं। फ़ॉर्म दिखाता है कि अगर उधारकर्ता अभी ऑफ़र ले, तो नियत तारीख पर वह आपको कितना देगा। Advanced मोड में ऑफ़र हिस्सों में भी उधार दिया जा सकता है, उसका फ़िल मोड तय किया जा सकता है, ब्याज अनुसूची से लिया जा सकता है और उस पर फुल फ़ीस टैरिफ़ लिया जा सकता है।

<a id="rate-check"></a>

### अपनी दर की हाल के ऋणों से तुलना

पोस्ट करने के दोनों फ़ॉर्म, ऋणदाता का ऑफ़र और उधारकर्ता का अनुरोध, में दर के नीचे ऐप उन ऋणों की मध्य दर दिखाता है जो पिछले 30 दिनों में उसी जोड़ी और उसी अवधि पर शुरू हुए, और उनकी संख्या भी। अगर आपकी दर पाँच अंक से ज़्यादा दूर है, तो ऐप चेतावनी देता है और बताता है कि इसका असर किस ओर है: बाज़ार से बहुत नीचे वाला ऋणदाता, या बाज़ार से बहुत ऊपर वाला उधारकर्ता, वह ऑफ़र पोस्ट करता है जो दरें बदलने पर सबसे पहले लिया जाता है; दूसरी ओर, ऑफ़र बिना लिए पड़ा रह सकता है। यह सिर्फ़ चेतावनी है, आप फिर भी पोस्ट कर सकते हैं। जब तुलना के लिए हाल का कोई ऋण न हो, ज़मानत NFT हो, या प्रोटोकॉल का इंडेक्स पढ़ा न जा सके, तो फ़ॉर्म चुप रहने के बजाय यही बताता है।

<a id="public-queue"></a>

### सार्वजनिक कतार वाले नेटवर्क

Ethereum, BNB Chain और Polygon (और BNB Testnet तथा Polygon Amoy) पर, आपका भेजा लेन-देन शामिल होने से पहले एक सार्वजनिक कतार में रुकता है, और उस कतार पर नज़र रखने वाला कोई भी, बॉट समेत, उसे देखकर पहले कदम उठा सकता है: आपका रद्द करना पहुँचने से पहले ऑफ़र ले लेना, या आपका भुगतान पहुँचने से पहले ऋण पर कार्रवाई करना। इसलिए इन नेटवर्कों पर ऑफ़र पोस्ट करने, लेने या रद्द करने, भुगतान करने और ज़मानत जोड़ने की समीक्षा वॉलेट खुलने से पहले यह बताती है। कुछ वॉलेट लेन-देन को निजी तौर पर भेज सकते हैं; अपने वॉलेट की नेटवर्क या सुरक्षा सेटिंग देखें। ऐप आपके लिए यह रास्ता नहीं चुन सकता, और सामान्य तरीके से भेजने से सिर्फ़ यह बदलता है कि पहुँचने से पहले लेन-देन कौन देख सकता है। Base, Arbitrum और Optimism में कोई सार्वजनिक कतार नहीं है, इसलिए वहाँ कुछ नहीं दिखता।

<a id="lend-offer-parts"></a>

### Lend: हिस्सों में दिया जाने वाला ऑफ़र (उन्नत)

Advanced मोड में लेंडिंग ऑफ़र हिस्सों में उधार दिया जा सकता है। आप जो राशि लिखते हैं वह पूरी राशि ही रहती है: पोस्ट करने पर पूरी राशि लॉक होती है, और आपका ऑफ़र सीधे लेने वाला उधारकर्ता पूरी राशि उधार लेता है। आप वह सबसे छोटा हिस्सा जोड़ते हैं जो एक मैच उधार दे सकता है। जब तक नेटवर्क पर मैचिंग चालू है, मैच करने वाले आपका ऑफ़र कई उधारकर्ताओं को उधार दे सकते हैं, हर लोन सबसे छोटे हिस्से और बची राशि के बीच, आपकी दर पर। हर मैच कम से कम आपके कोलैटरल का वह हिस्सा माँगता है जो उसके हिस्से के अनुपात में हो, नीचे की ओर पूर्णांकित, और समीक्षा दिखाती है कि सबसे छोटा हिस्सा कितना माँगता है। एक बार किसी मैच ने कोई हिस्सा उधार दे दिया, तो कोई उधारकर्ता बाकी को सीधे नहीं ले सकता; केवल और मैच ले सकते हैं, और आप बाकी वापस लेने के लिए ऑफ़र रद्द कर सकते हैं। जब सबसे छोटे हिस्से से कम बचता है, तो प्रोटोकॉल उसे आपके वॉलेट में लौटाकर ऑफ़र बंद कर देता है। समीक्षा बताती है कि मैचिंग अभी चालू है या नहीं; बंद रहने तक केवल पूरी राशि लेने वाला उधारकर्ता लोन खोलता है। फ़िल मोड अनुरोध की तरह काम करता है: डिफ़ॉल्ट रूप से आंशिक, पूरी राशि के एक लोन के लिए सब या कुछ नहीं (इसलिए कोई हिस्सा नहीं), या तुरंत या रद्द, जिसके लिए समाप्ति चाहिए; पोस्ट करने के बाद इसे बदला नहीं जा सकता। जो ऑफ़र आज की कीमतों पर पूरी राशि की ज़रूरत से कम कोलैटरल माँगता है उसे प्रोटोकॉल अस्वीकार करता है, और समीक्षा बताती है कि कम से कम कितना चाहिए। Advanced में तय विकल्प Basic पर जाने पर भी लागू रहते हैं: फ़ॉर्म यह बताता है और आपको उन्हें हटाने देता है।

<a id="lend-offer-schedule"></a>

### Lend: ऑफ़र पर ब्याज की अनुसूची (उन्नत)

उन्नत मोड में लेंडिंग ऑफ़र पर भी अनुरोध की तरह ब्याज की अनुसूची लगाई जा सकती है: हर महीने, हर तिमाही, हर छह महीने या हर साल। फ़ॉर्म आपकी शर्तों के लिए वही अनुसूचियाँ देता है जिनकी प्रोटोकॉल अनुमति देता है, और हर बंद अनुसूची के नीचे कारण बताता है। हिस्सों के साथ, प्रोटोकॉल पोस्ट करते समय सबसे छोटे हिस्से की जाँच करता है, इसलिए उसकी सीमा से कम सबसे छोटा हिस्सा बारीक अनुसूचियाँ बंद कर देता है; हर ऋण खुलते समय फिर जाँचा जाता है। समीक्षा दिखाती है कि अगर उधारकर्ता पूरी राशि ले तो हर अवधि का ब्याज कितना है, हिस्सों के साथ सबसे छोटे हिस्से के ऋण पर कितना है, और छूटी अवधि को कितनी मोहलत मिलती है। अगर कोई अवधि मोहलत के अंत तक नहीं चुकाई जाती, तो कोई भी उधारकर्ता के कोलैटरल का हिस्सा बेचकर आपको भुगतान कर सकता है, और ऋण खुला रहता है। पोस्ट करने के बाद अनुसूची बदली नहीं जा सकती।

<a id="lend-offer-tariff"></a>

### Lend: ऑफ़र पर फुल फ़ीस टैरिफ़ (उन्नत)

उन्नत मोड में लेंडिंग ऑफ़र फुल फ़ीस टैरिफ़ ले सकता है: VPFI में एक शुल्क, जो ऑफ़र से हर ऋण खुलते समय आपके वॉल्ट से लिया जाता है और उस ऋण की राशि और अवधि के हिसाब से तय होता है। बदले में, उस ऋण के ब्याज पर प्रोटोकॉल के हिस्से की छूट में दस अंक और जुड़ते हैं, उसकी 50% सीमा तक; वह हिस्सा अब भी उधार दी गई संपत्ति में लिया जाता है। अतिरिक्त अंक ऋण की अवधि तक रहते हैं: अगर ऋण नई अवधि के लिए बढ़ाया जाता है, तो उस अवधि के लिए वे समाप्त हो जाते हैं। वे ऋणदाता पोज़िशन के होते हैं, इसलिए ब्याज चुकाए जाते समय जो उसे रखता है वही उन्हें पाता है। टैरिफ़ वापस नहीं होता। फ़ॉर्म पूरी राशि, यानी ऑफ़र जो सबसे बड़ा ऋण खोलता है, के लिए आज का टैरिफ़ दिखाता है। आप तय करते हैं कि एक ऋण अधिकतम कितना VPFI ले सकता है, और जो ऋण टैरिफ़ नहीं ले सकता वह अस्वीकार हो या उसके बिना खुले। कोई ऋण इसे तभी ले सकता है जब उस क्षण टैरिफ़ चालू हो, उधार दी गई संपत्ति की कीमत हो और वह तरल हो, उसका टैरिफ़ आपकी अधिकतम सीमा में हो, और आपके वॉल्ट में पर्याप्त मुक्त VPFI हो। टैरिफ़ ऑफ़र पोस्ट होने के बाद दूसरे लेनदेन से लगाया जाता है, इसलिए उसकी पुष्टि से पहले किसी उधारकर्ता या मैच से ऑफ़र से खुला ऋण उसके बिना खुलता है।

<a id="lend-offer-review"></a>

### Lend: ऑफ़र की समीक्षा और पोस्ट करना

आपका वॉलेट खुलने से पहले ऐप प्रोटोकॉल से आपके ऑफ़र का ड्राई रन करवाता है, इसलिए समीक्षा प्रोटोकॉल का अपना जवाब दिखाती है। इसमें आप अभी क्या लॉक करते हैं, उधारकर्ता कितनी राशि लेता है, उसे कितना कोलैटरल लॉक करना है, दर और अवधि, आज की फ़ीस दर पर उधारकर्ता को क्या मिलेगा, नियत तारीख पर ब्याज, उसमें प्रोटोकॉल का हिस्सा और आपको क्या वापस मिलता है, लोन के जीवनकाल की हर शर्त, ऑफ़र कब समाप्त होता है, आज की कीमतों पर लोन-टू-वैल्यू और क्या मंज़ूरी चाहिए, यह सब होता है। अगर आपके वॉलेट में राशि से कम है, तो समीक्षा बताती है कि कितना कम है और कोई सिग्नेचर नहीं देती। आप जोखिम प्रकटीकरण और शर्तों से सहमत होने के लिए एक बॉक्स पर टिक करते हैं। ज़रूरत हो तो आपका वॉलेट ठीक उतनी राशि की मंज़ूरी देता है, ऐप ऑफ़र को फिर आज़माता है, और तभी उसे पोस्ट करता है। अगर मंज़ूरी के बाद यह रुक जाए, तो ऐप मंज़ूरी वापस पहले जैसी करने को कहता है और बताता है कि ऐसा हुआ या नहीं। इसके बाद ऐप चेन पर दर्ज ऑफ़र और आपके वॉल्ट में लॉक हुई राशि की जाँच करता है।

<a id="lend-offer-fee"></a>

### Lend: आपके ऑफ़र पर फ़ीस

ऑफ़र पोस्ट करने पर आपसे कोई फ़ीस नहीं ली जाती। इनिशिएशन फ़ीस उधारकर्ता की है: राशि का एक छोटा हिस्सा, जब कोई उधारकर्ता आपका ऑफ़र लेता है तब उस समय की दर पर उधार दी गई संपत्ति में एक बार लिया जाता है और उसे मिलने वाली राशि से काटा जाता है। आप पूरी राशि उधार देते हैं, और उधारकर्ता उसे ब्याज सहित पूरा लौटाता है। ब्याज चुकाए जाने पर प्रोटोकॉल अपना हिस्सा रखता है, उस दर पर जो लोन खुलते समय लागू हो; जब तक आपकी फ़ीस-डिस्काउंट सेटिंग चालू है, आपका फ़ीस-डिस्काउंट टियर वह हिस्सा घटा सकता है। समीक्षा आज की दर और वह अधिकतम दिखाती है जो यह हिस्सा ले सकता है; अगर वह दर पढ़ी न जा सके, तो समीक्षा कोई अंक दिखाने के बजाय यही बताती है।

<a id="positions"></a>

### Positions: आपकी लोन पोज़िशन

Positions इस नेटवर्क पर आपके दिए या लिए गए हर लोन को आपके वॉलेट में रखे पोज़िशन टोकन से दिखाता है, इसलिए किसी और को ट्रांसफ़र की गई पोज़िशन आपकी सूची से हट जाती है। सबसे पहले लेने के लिए तैयार भुगतान आते हैं, जो Claims खोलते हैं। फिर चालू लोन आते हैं, सबसे ज़रूरी समय-सीमा पहले, जैसे Home पर। आख़िर में समाप्त लोन आते हैं, हर एक के साथ यह कि वह कैसे समाप्त हुआ: चुकाया गया, डिफ़ॉल्ट हुआ, सेटल हुआ या मैच से बंद हुआ। जिस समाप्त लोन का भुगतान अभी बाकी है, वह आपको Claims पर भेजता है।

सभी, दिए गए और लिए गए तीनों सूचियों को एक साथ छांटते हैं। Positions तभी कहता है कि आपके पास कुछ नहीं है जब उसने सब कुछ पढ़ लिया हो; अगर कोई सूची पूरी नहीं पढ़ी जा सकी, तो वह यह बताता है। हर लोन अपना पेज खोलता है, जो दिखाता है कि आपके लिए कौन-सी कार्रवाइयाँ खुली हैं। सूची खुद कभी कुछ साइन नहीं करती।

<a id="position"></a>

### Position: एक लोन

हर लोन का अपना पेज है। यह लोन की स्थिति से शुरू होता है, फिर आपकी भूमिका: वह पक्ष जो आपका वॉलेट अभी रखता है, क्योंकि पोज़िशन टोकन बेचे या ट्रांसफ़र किए जा सकते हैं। अगर आप कोई पक्ष नहीं रखते, तो आप लोन देख रहे हैं। आपसे जुड़ी समय-सीमा आपके पक्ष के लिए लिखी जाती है। ग्रेस अवधि खत्म होने पर पेज बताता है कि अब कोई भी डिफ़ॉल्ट शुरू कर सकता है, और केवल तब जब प्रोटोकॉल इसकी पुष्टि करे।

इसके नीचे लोन की तारीखें (मौजूदा अवधि की देय तिथि, किसी भी विराम-क्रेडिट से पहले, प्रोटोकॉल रुकने के दौरान जोड़ा गया समय, देय तिथि और ग्रेस अवधि का अंत), अभी की शर्तें (आंशिक भुगतान बाकी मूलधन घटाता है), उसका हेल्थ फ़ैक्टर और उसकी कोलैटरल कहाँ रखी है, यह आता है। जो आंकड़ा पढ़ा नहीं जा सका, वह अज्ञात दिखाया जाता है। अगर कोलैटरल की कोई कीमत नहीं है, तो डिफ़ॉल्ट पर ऋणदाता को कोलैटरल ही मिलती है, और पेज यह बताता है। अगर नेटवर्क लिक्विडेशन सीमा के ठीक ऊपर किसी दूसरे लोन से आंतरिक मिलान के लिए एक दायरा रखता है, तो पेज यह बताता है: उस दायरे में कोई बाहरी बिक्री लोन बंद नहीं कर सकती। NFT किराये में कोई कोलैटरल नहीं होती: डिफ़ॉल्ट होने पर किरायेदार का उपयोग खत्म होता है, पहले चुकाया किराया प्रोटोकॉल का हिस्सा घटाकर ऋणदाता को जाता है, और बफ़र ट्रेज़री को जाता है। पूरा चुकाना, आंशिक भुगतान, कोलैटरल जोड़ना और उसे वापस लेना इसकी पहली कार्रवाइयाँ हैं; बाकी आगे के अपडेट में आएँगी।

<a id="repay"></a>

### पूरा चुकाएँ

चालू लोन पर पेज उसे पूरा चुकाने का विकल्प देता है। ऋणदाता को छोड़कर कोई भी चुका सकता है। अगर उधारकर्ता की पोज़िशन आपके पास नहीं है, तो भुगतान से आपको कोलैटरल पर कोई अधिकार नहीं मिलता: उसे केवल पोज़िशन का धारक ही ले सकता है। ग्रेस अवधि खत्म होने के बाद (तब लोन डिफ़ॉल्ट में जाता है) और swap-to-repay ऑर्डर लंबित रहने तक चुकाना रुका रहता है।

बकाया हर सेकंड बढ़ता है, और प्रोटोकॉल वह राशि लेता है जो आपके भुगतान की पुष्टि के क्षण की होती है। समीक्षा दो आंकड़े दिखाती है: अभी की लागत, और लगभग तीस मिनट बाद की लागत। आपका वॉलेट ठीक दूसरा आंकड़ा अनुमोदित करता है। अगर आपने पहले से ज़्यादा अनुमोदित किया था, असीमित भी, तो भुगतान के लिए उसे इसी आंकड़े तक घटा दिया जाता है, क्योंकि भुगतान अपनी कोई अधिकतम सीमा नहीं लेता। अनुमोदन राशि को सीमित करता है, समय को नहीं: बाद में पुष्टि होने वाला भुगतान तभी पूरा होता है जब बकाया अब भी उसके भीतर हो, वरना वह अस्वीकार हो जाता है और कुछ नहीं हिलता। पूरी अवधि का ब्याज लेने वाले लोन पर नियत तारीख से पहले राशि नहीं बढ़ती, इसलिए बाद का भुगतान भी पूरा हो सकता है। अनुमोदन का जो हिस्सा भुगतान में इस्तेमाल नहीं होता, वह बाद में वापस कर दिया जाता है। फिर उधारकर्ता कोलैटरल और ऋणदाता मूलधन व ब्याज Claims पर लेते हैं।

<a id="interest-schedule"></a>

### ब्याज अनुसूची

ब्याज अनुसूची वाले लोन पर हर अवधि (एक महीना, एक तिमाही, छह महीने या एक साल) में ब्याज देय होता है, सिर्फ़ अंत में नहीं। उसका पेज मौजूदा अवधि दिखाता है: यह कब ख़त्म होती है, इसकी ग्रेस अवधि कब ख़त्म होती है, इस पर कितना ब्याज देय है, कितना चुकाया गया और कितना अभी बाकी है। किसी अवधि का ब्याज अभी के मूलधन और दर पर गिना जाता है, इसलिए आंशिक भुगतान इसे घटाता है।

जब कोई अवधि और उसकी ग्रेस ख़त्म हो जाती है, तो कोई भी उसे सेटल कर सकता है। चुकाई गई अवधि सिर्फ़ चेकपॉइंट आगे बढ़ाती है; जो अवधि अभी अधूरी है, उसमें उधारकर्ता की बस उतनी कोलैटरल बेची जाती है जितनी बकाया और बिक्री के शुल्क को पूरा करे। पेज बताता है कि सेटल करना अभी खुला है या नहीं। जब नेटवर्क का आवधिक सेटलमेंट स्विच बंद हो तो पेज उसका नाम लेता है (तब कुछ भी सेटल नहीं हो सकता और कोई कोलैटरल नहीं बिकती), और प्रोटोकॉल रुका रहे तब तक उसका भी (सेटलमेंट रुक जाता है, और रुका हुआ समय अवधि की तारीखों में जुड़ जाता है)। रुकावट अवधि की तारीखों को रुके हुए समय जितना आगे खिसकाती है, पर एक अवधि का बकाया ब्याज एक अवधि जितना ही रहता है; रुकावट के दौरान भी ब्याज जुड़ता रहता है, और किसी भुगतान से चुकाया गया हर ब्याज उस अवधि में गिना जाता है।

<a id="partial-repay"></a>

### ऋण का कुछ हिस्सा चुकाना

उधारकर्ता पोज़िशन का धारक चल रहे ऋण के पेज से उसके मूलधन का कुछ हिस्सा चुका सकता है, जब ऋण की शर्तें इसकी अनुमति देती हों। मूलधन का हिस्सा लिखें: प्रोटोकॉल उधार दिए गए टोकन के लिए कम से कम अपना न्यूनतम हिस्सा और पूरे मूलधन से कम राशि लेता है (पूरा चुकाना "पूरा चुकाएं" है)। ऋण का ब्याज पिछली बार चुकाए जाने के बाद से जमा हुआ ब्याज ऊपर से जोड़ा जाता है। ऋण कम मूलधन के साथ चलता रहता है, और उसकी देय तिथि नहीं बदलती।

समीक्षा हिस्सा, ब्याज, बचा हुआ मूलधन और अनुमोदन क्या कवर करता है, यह दिखाती है। देय तिथि से पहले आनुपातिक (प्रो-राटा) ऋण पर ब्याज सटीक होता है। पूरी अवधि वाले ऋण पर, या देय तिथि के बाद, "अधिकतम" लिखा आता है: ऐप जो प्रोटोकॉल आंकड़ा पढ़ता है उसमें अवधि का बाकी हिस्सा या विलंब शुल्क भी गिना जाता है, जो आंशिक भुगतान नहीं लेता। जब तक ऋण पर पुनर्वित्त अनुरोध या उधारकर्ता पोज़िशन पर ऑफ़सेट ऑफ़र सक्रिय है, और अनुग्रह अवधि खत्म होने के बाद, आंशिक भुगतान रुका रहता है।

<a id="add-collateral"></a>

### कोलैटरल जोड़ना

उधारकर्ता पोज़िशन का धारक चल रहे लोन के पेज से उसमें कोलैटरल जोड़ सकता है। कोलैटरल जोड़ने से लोन का हेल्थ फ़ैक्टर बढ़ता है और लोन-टू-वैल्यू घटता है, जिससे वह लिक्विडेशन से और दूर रहता है। आप वही टोकन और जोड़ते हैं जो लोन में पहले से है: प्रोटोकॉल कोई दूसरा टोकन नहीं लेता, और टॉप-अप केवल उस कोलैटरल के लिए लेता है जिसकी वह अभी कीमत आंकता है। राशि लिखें; फ़ॉर्म दिखाता है कि आपके वॉलेट में कितना है।

समीक्षा अभी और बाद की कोलैटरल, वह कहाँ रखी है (आपके वॉल्ट में, लोन खत्म होने तक उससे बंधी), और लोन का अभी का हेल्थ फ़ैक्टर और लोन-टू-वैल्यू दिखाती है। अगर आपका मौजूदा अनुमोदन राशि को पहले से नहीं ढकता, तो वॉलेट ठीक उतनी ही राशि का अनुमोदन करता है, और ऐप पहले टॉप-अप को ड्राई रन के रूप में आज़माता है। बाद में ऐप टॉप-अप के बाद प्रोटोकॉल का अपना हेल्थ फ़ैक्टर और लोन-टू-वैल्यू दिखाता है। प्रोटोकॉल रुका हो, तब भी कोलैटरल जोड़ना खुला रहता है। फ़ॉलबैक में पड़ा लोन फिर से चालू हो जाता है अगर टॉप-अप प्रोटोकॉल की शुरुआती सीमाएँ बहाल कर दे; वरना कोलैटरल जुड़ जाती है और लोन फ़ॉलबैक में ही रहता है। जोड़ी गई कोलैटरल बाकी के साथ खो सकती है, अगर लोन लिक्विडेट हो या डिफ़ॉल्ट करे। अगर आपने उधारकर्ता पोज़िशन ली है और लोन फ़ॉलबैक में है, तो टॉप-अप लोन में दर्ज उधारकर्ता के वॉल्ट में जाता है, और आपके वॉल्ट में तभी आता है जब वह लोन को फिर से चालू कर दे।

<a id="take-back-collateral"></a>

### कोलैटरल वापस लेना

लोन चलते रहने तक, उधारकर्ता पोज़िशन का धारक लोन के पेज से उतना कोलैटरल वापस ले सकता है जो लोन की ज़रूरत से ज़्यादा है। प्रोटोकॉल अधिकतम राशि ऐसे निकालता है कि हेल्थ फ़ैक्टर लोन के न्यूनतम पर या उससे ऊपर रहे और लोन-टू-वैल्यू शुरुआती सीमा के भीतर रहे। यह सीमा कीमतों के साथ और ब्याज जुड़ने के साथ बदलती है, और फ़ॉर्म टाइप करते समय इसे दिखाता है। कोलैटरल वापस लेने से लोन लिक्विडेशन के करीब जाता है।

समीक्षा अभी और बाद का कोलैटरल, यह कि वह आपके वॉल्ट से आपके वॉलेट में जाता है, अभी की सीमा, और लोन का अभी का हेल्थ फ़ैक्टर और लोन-टू-वैल्यू दिखाती है। कोई अनुमोदन नहीं चाहिए, इसलिए ऐप के निकासी को ड्राई रन में आज़माने के बाद आपका वॉलेट एक बार पूछता है। निकासी पक्की होते समय प्रोटोकॉल अपनी सीमाएँ फिर जाँचता है: अगर कीमतें बदल गईं और राशि अब नहीं बैठती, तो वह अस्वीकार होती है और कुछ नहीं हिलता। प्रोटोकॉल का विराम, लंबित स्वैप-टू-रिपे ऑर्डर, खड़ा रीफ़ाइनेंस अनुरोध या ऋणदाता की बिक्री सूची इसे रोकती है, और प्रोटोकॉल केवल उसी टोकन का कोलैटरल वापस लेने देता है जिसकी वह कीमत लगाता है। अगर आपके खाते में सुरक्षित मोड चालू है, तो कोलैटरल आपके वॉलेट तक पहुँचने से पहले खाते की देरी तक उसकी भुगतान कतार में रुकती है, और समीक्षा यह बताती है।

<a id="collect-a-payout"></a>

### भुगतान प्राप्त करना

जब कोई ऋण समाप्त होता है, तो प्रोटोकॉल दर्ज करता है कि हर पक्ष को क्या मिलना है, और हर पोज़िशन का धारक उसे ऋण के पेज से या Claims से प्राप्त करता है। यह उसे भुगतान करता है जो अभी पोज़िशन रखता है, इसलिए आपकी खरीदी हुई पोज़िशन आपको भुगतान करती है। ऋणदाता का भुगतान मूलधन और ब्याज है, या वह जो डिफ़ॉल्ट या लिक्विडेशन से वसूल हुआ, साथ में ऋणदाता के लिए रोकी गई राशि और किराये पर दिए जाने की स्थिति में किराये पर दिया गया NFT। उधारकर्ता का भुगतान लौटाया गया कोलैटरल या बचा हुआ हिस्सा है, साथ में उधारकर्ता के लिए रोका गया अधिशेष। प्राप्त करने पर आपका पोज़िशन टोकन बर्न हो जाता है, और दोनों पक्षों के प्राप्त कर लेने पर ऋण निपट जाता है।

समीक्षा में दावा जो भी भुगतान करता है उसकी सूची होती है, ऋणदाता पोज़िशन के पिछले विक्रेता पहले क्या लेते हैं (कमाया हुआ पर न चुकाया गया ब्याज), और भुगतान कहाँ पहुँचता है: आपके वॉलेट में, या सुरक्षित मोड चालू होने पर आपके खाते की भुगतान कतार या आपके वॉल्ट में। किसी अनुमति की ज़रूरत नहीं, इसलिए ऐप के दावे को ड्राई रन के रूप में आज़माने के बाद आपका वॉलेट एक बार पूछता है। प्रोटोकॉल का विराम हर दावे को रोक देता है। जब तक ऋण फ़ॉलबैक में है, उधारकर्ता का भुगतान तब तक रुकता है जब तक ऋणदाता प्राप्त न कर ले, और ऋणदाता का प्राप्त करना फ़ॉलबैक समाप्त कर देता है: उधारकर्ता उसे अब ठीक नहीं कर सकता। अंतिम कार्ड दिखाता है कि लेन-देन ने वास्तव में क्या भुगतान किया।

<a id="claim-everything"></a>

### सब कुछ क्लेम करें

Claims की शुरुआत «सब कुछ क्लेम करें» से होती है: हर वह भुगतान जो आप अभी ले सकते हैं, एक ही लेनदेन में इकट्ठा। इसमें उन समाप्त ऋणों के भुगतान हैं जिनकी पोज़िशन आपके पास है, इंटरैक्शन रिवॉर्ड, आपके स्थायी ऑफ़रों की बिना उधार दी गई पूँजी, आपके वॉल्ट का मुक्त VPFI और, यदि आप प्राप्तकर्ता हैं, तो निकाली जा सकने वाली पेरोल। हर भुगतान का एक स्विच है, इसलिए आप किसी को भी छोड़ सकते हैं। वॉल्ट का मुक्त VPFI तब तक बंद रहता है जब तक आप उसे चालू न करें, क्योंकि यही आपका फ़ीस-छूट स्तर तय करता है; यही बात उस स्थायी ऑफ़र की पूँजी पर लागू है जो अभी भी उधार दे रहा है। बेची गई पोज़िशन से आपको देय ब्याज, और फ़ॉलबैक में पड़ा ऋण, अलग से लिए जाते हैं। लेनदेन के भीतर हर भुगतान अपने आप चलता है: जिसे प्रोटोकॉल अस्वीकार करे वह छोड़ दिया जाता है और सूची में बना रहता है, बाकी फिर भी भुगतान होते हैं। एक लेनदेन में अधिकतम 30 भुगतान होते हैं; बाकी दूसरे लेनदेन की प्रतीक्षा करते हैं। आपके वॉलेट से कुछ नहीं निकलता, इसलिए आपका वॉलेट एक परीक्षण के बाद एक बार पूछता है, और समापन कार्ड हर भुगतान को लिया गया या छोड़ा गया दिखाता है और बताता है कि पैसा कहाँ पहुँचा। विराम हर क्लेम को रोक देता है।

<a id="payout-queue"></a>

### आपकी कतार में प्रतीक्षारत भुगतान

सुरक्षित मोड चालू होने पर, आपके वॉल्ट से आपके वॉलेट की ओर जाने वाली हर चीज़ भुगतान कतार में आपके खाते की देरी पूरी होने तक प्रतीक्षा करती है। क्लेम्स वहाँ प्रतीक्षारत चीज़ों की सूची दिखाता है, सबसे पहले आने वाली ऊपर, हर एक के साथ एक छोटा अनुरोध कोड: किसी भुगतान के बारे में हर अलर्ट वही कोड दिखाता है, ताकि आप संदेश को अनुरोध से मिला सकें। हर पंक्ति बताती है कि वह क्या भुगतान करती है, कहाँ जाती है और कब जारी की जा सकती है। भुगतान देय होने पर कोई भी उसे जारी कर सकता है, और वह केवल अपने दर्ज गंतव्य को ही भुगतान करता है; अगर वह गंतव्य अब अनुमत नहीं है, तो जारी करने पर वह रद्द हो जाता है। आप, या आपका कोई द्वितीयक हस्ताक्षरकर्ता, किसी भी समय भुगतान रद्द कर सकते हैं, विराम के दौरान भी, और संपत्ति आपके वॉल्ट में रहती है। अगर आपके खाते में स्वीकृति आवश्यक है, तो हर भुगतान को पहले एक द्वितीयक हस्ताक्षरकर्ता स्वीकृत करता है; हस्ताक्षरकर्ता एडवांस्ड मोड में आपके खाते का पता चिपकाकर उसे ढूँढता है। विराम जारी करने को तब तक रोकता है जब तक वह समाप्त न हो या लंबे विराम के बाद उसका निकास मार्ग न खुल जाए। हर कार्रवाई आपके वॉलेट से एक बार पूछती है, और समापन कार्ड दिखाता है कि लेन-देन ने क्या किया।

<a id="seller-interest"></a>

### बेची गई पोज़िशन से मिलने वाला ब्याज

जब आप ऋणदाता पोज़िशन बेचते हैं, तो उसे रखने के दौरान कमाया गया और अभी तक न मिला ब्याज ऋण पर एक दावे के रूप में आपका ही रहता है। Claims हर उस ऋण को दिखाता है जिस पर आपका ऐसा दावा है, साथ में प्रोटोकॉल के ब्याज हिस्से के बाद आपको कितना मिलना है और आपकी वॉल्ट में पहले से क्या प्रतीक्षा कर रहा है। जब तक ऋण चल रहा है, हर ब्याज भुगतान पहले खुले दावों को, सबसे पुराने से शुरू करके, हर विक्रेता की अपनी वॉल्ट में चुकाता है; जब तक आपकी वॉल्ट तक कुछ नहीं पहुँचता, निकालने को कुछ नहीं है। ऋण समाप्त होने पर, निकासी पहले ऋणदाता पक्ष की वसूली को बाँटती है: पहले धारक का मूलधन, फिर हर विक्रेता का दावा, सबसे पुराने से शुरू करके। तब सभी खुले दावे बंद हो जाते हैं, और जो किसी दावे को नहीं मिलता वह अदत्त रहता है। ऋण ऐप के इंडेक्स से मिलते हैं; अगर वह उन्हें सूचीबद्ध न कर पाए, तो ऋण को उसकी संख्या से खोजें, जो केवल चेन से पढ़ी जाती है। किसी स्वीकृति की ज़रूरत नहीं, इसलिए आपका वॉलेट एक ड्राई रन के बाद एक बार पूछता है, और अंतिम कार्ड दिखाता है कि लेन-देन ने क्या चुकाया।

<a id="frozen-proceeds"></a>

### जब भुगतान फ़्रीज़ हो

यदि प्रतिबंध जाँच आपके वॉलेट को चिह्नित करती है, तो प्रोटोकॉल आपका बकाया कुछ भी नहीं लेता और किसी भी ऋण को बंद होने से नहीं रोकता: दूसरे पक्ष को फिर भी वह मिलता है जो उसका पक्ष वसूल करता है। आपका हिस्सा एक वॉल्ट में, लॉक करके रखा जाता है, और आपका वॉलेट सूची से हटते ही जारी होता है। तब Claims और ऋण का पेज "फ़्रीज़, सूची से हटने की प्रतीक्षा में" दिखाते हैं और वसूलने का कोई बटन नहीं देते। यदि जाँच पढ़ी नहीं जा सकती और आपका वॉलेट पहले चिह्नित होने की पुष्टि पा चुका है, तो फ़्रीज़ भुगतान तब तक लॉक रहता है जब तक जाँच फिर से उत्तर न दे, और उस दौरान आपके वॉलेट को देय भुगतान भी इसी तरह रोककर रखा जाता है, क्योंकि प्रोटोकॉल उसे अब भी चिह्नित मानता है; केवल रुकावट से ऐसा कोई वॉलेट कभी फ़्रीज़ नहीं होता जिसके चिह्नित होने की कभी पुष्टि नहीं हुई। चल रहे ऋण पर, ऋण का पेज यह भी दिखाता है कि ऋण ने पहले से जो चुकाया है वह ऋणदाता पोज़िशन के लिए आरक्षित है, जब तक ऋणदाता उसे वसूल न ले, और चुकाया गया ऋण बताता है जब वह ऐसे अधिशेष की प्रतीक्षा में हो जिसे उधारकर्ता ने अभी नहीं वसूला।

<a id="extension-reserves"></a>

### विस्तार रिज़र्व

यदि आपके पास किसी ऋण की उधारकर्ता पोज़िशन है, तो आप ऋण का टोकन उसके विस्तारों के लिए अपने ही वॉल्ट में अलग रख सकते हैं। कोई भी विस्तार, कीपर का या आपका अपना, पहले उसी रिज़र्व से लेता है। रिज़र्व आपका ही रहता है। Claims हर वह ऋण दिखाता है जिसमें आपका कुछ रिज़र्व बचा है, और बताता है कि क्या कोई विस्तार अब भी उससे ले सकता है: केवल तब तक जब तक ऋण चल रहा है और उसकी उधारकर्ता पोज़िशन आपके पास है। प्रोटोकॉल रुका न हो तो आप पूरा रिज़र्व कभी भी वापस ले सकते हैं, ऋण की स्थिति चाहे जो हो; यदि ऋण अभी चल रहा है, तो उसका अगला विस्तार तब टोकन के आपके दूसरे बैलेंस से लेता है। ऋण ऐप के इंडेक्स में मिलते हैं; यदि वह उन्हें सूचीबद्ध न कर पाए, तो ऋण को उसकी संख्या से खोजें। किसी अनुमोदन की ज़रूरत नहीं, इसलिए आपका वॉलेट एक बार पूछता है, एक परीक्षण के बाद, और समापन कार्ड दिखाता है कि पैसा कहाँ पहुँचा।

<a id="vault-holdings"></a>

### आपका वॉल्ट

वॉल्ट पेज उस नेटवर्क पर आपका अपना वॉल्ट दिखाता है जिससे आप जुड़े हैं: उसका पूरा पता, एक्सप्लोरर के लिंक के साथ। यह एक कॉन्ट्रैक्ट है जिसे प्रोटोकॉल केवल आपके वॉलेट के लिए रखता है; इसमें रखी कोई चीज़ किसी और की संपत्ति के साथ मिलाई नहीं जाती, और संपत्तियाँ इससे केवल प्रोटोकॉल के नियमों से बाहर जाती हैं। अगर आपके पास अभी वॉल्ट नहीं है, तो पेज यह बताता है और एक बनाने की पेशकश करता है; आपकी पहली जमा या ऑफ़र वैसे भी इसे बना देगा। इसे बनाने से कुछ नहीं हिलता और कोई मंज़ूरी नहीं माँगी जाती, इसलिए आपका वॉलेट एक बार पूछता है। हर संपत्ति प्रोटोकॉल के तीन आँकड़े दिखाती है: आपके वॉल्ट में (जिसे प्रोटोकॉल वहाँ आपका मानता है), अभी निकालने के लिए मुक्त, और आपकी पोज़िशन द्वारा रोका गया (जो आपके ऋण, ऑफ़र, दावे, रिज़र्व या कतार में लगे भुगतान रोकते हैं)। साधारण ट्रांसफ़र से आपके वॉल्ट में भेजा गया टोकन गिना नहीं जाता और जब तक आप उसे अपनाते नहीं, निकाला नहीं जा सकता; पंक्ति यह बताती है और उस जगह से जोड़ती है जहाँ आप उसे अपनाते या अस्वीकार करते हैं। पेज आपकी जमा की गई संपत्तियाँ और आपके ऋणों, आपके बनाए ऑफ़रों तथा स्थायी ऑफ़रों में नामित संपत्तियाँ सूचीबद्ध करता है, इसलिए साधारण ट्रांसफ़र से भेजा गया टोकन तभी दिखता है जब इनमें से कोई उसका नाम ले। छोटी और खाली पंक्तियाँ एक स्विच के पीछे छिपी रहती हैं जो उनकी गिनती बताता है। आपके वॉल्ट का VPFI आपकी शुल्क-छूट श्रेणी तय करता है; इसके लिए रखने से वह गिरवी नहीं होता, और जो VPFI आप किसी ऋण या ऑफ़र में गिरवी रखते हैं वह रोका हुआ दिखता है। जिस एसेट में कुछ मुक्त है, उस पर निकासी का बटन है।

<a id="vault-deposit"></a>

### अपने वॉल्ट में जमा करें

वॉल्ट पेज पर जमा करना किसी टोकन या NFT को आपके वॉलेट से आपके अपने वॉल्ट में ले जाता है, किसी भी ऋण से बाहर। चुनें कि क्या जमा करना है: कोई सुझाया गया टोकन या टेस्ट संग्रह, या कोई पता पेस्ट करें; वह टोकन है, NFT है या मल्टी-टोकन संग्रह, यह उसके कॉन्ट्रैक्ट से पढ़ा जाता है। फिर राशि, NFT की टोकन आईडी, या टोकन आईडी और संख्या लिखें। यदि ऐसी सेवा की शर्तें लागू हैं जिन्हें आपने स्वीकार नहीं किया, तो ऐप पहले उन्हें माँगता है, और यदि आप ऐसे वॉलेट पर बदलते हैं जिसने उन्हें स्वीकार नहीं किया, तो हस्ताक्षर से पहले फिर माँगता है। समीक्षा बताती है कि आपके वॉलेट से क्या निकलता है और किस वॉल्ट में जाता है; यदि अभी आपका वॉल्ट नहीं है, तो जमा उसे बना देता है। टोकन ठीक उसी राशि की स्वीकृति माँगता है, NFT केवल उसी एक टोकन की, और मल्टी-टोकन संग्रह ऐसी स्वीकृति माँगता है जो जमा के तुरंत बाद एक और वॉलेट चरण में वापस ले ली जाती है। प्रोटोकॉल आपके वॉलेट के भेजने से पहले जमा की जाँच करता है, और ऐसा टोकन अस्वीकार करता है जो पूरा नहीं पहुँचता, जैसे ट्रांसफ़र पर शुल्क काटने वाला टोकन। यदि जमा पूरा नहीं होता, तो ऐप स्वीकृति वापस रखने को कहता है। जो पहुँचता है वह आपका गिना जाता है। सुरक्षित मोड के बिना आप उसे तुरंत निकाल सकते हैं; उसके साथ, निकासी आपके खाते की देरी पूरी होने तक रुकती है, और खाता लॉक रहने तक कुछ नहीं निकलता। समीक्षा बताती है कि कौन-सा लागू है। प्रोटोकॉल रुका होने पर जमा बंद रहता है।

<a id="vault-withdraw"></a>

### अपने वॉल्ट से निकासी

वॉल्ट पेज पर किसी एसेट की निकासी उसका मुक्त हिस्सा आपके वॉलेट में वापस लाती है। मुक्त का अर्थ है जिसे कोई ऋण, ऑफ़र, दावा, स्थायी ऑफ़र या कतार में रुका भुगतान न रोके; प्रोटोकॉल का अपना आँकड़ा तय करता है, और फ़ॉर्म उसे दिखाकर उससे अधिक को अस्वीकार करता है। जिस NFT को आपका जमा रिकॉर्ड केवल उसके संग्रह से जानता है, उसे उस संग्रह के नीचे उसकी टोकन आईडी लिखकर निकाला जाता है। ऐप केवल उसी वॉलेट में निकासी करता है जो हस्ताक्षर करता है। समीक्षा बताती है कि किस वॉल्ट से क्या निकलता है और कहाँ जाता है। सुरक्षित मोड के बिना यह तुरंत आपके वॉलेट में पहुँचता है। उसके साथ, प्रोटोकॉल इसे आपके खाते की देरी तक कतार में रखता है, और यदि आपका खाता माँगता है तो द्वितीयक हस्ताक्षरकर्ता की स्वीकृति के साथ; कतार में रुकी निकासी को आप दावे पेज की भुगतान कतार से रद्द कर सकते हैं, तब वह आपके वॉल्ट में ही रहती है। खाता लॉक रहने तक कुछ भी नहीं निकाला जा सकता। आपके वॉलेट से कुछ नहीं निकलता और कोई स्वीकृति नहीं माँगी जाती। प्रोटोकॉल रुका होने पर निकासी तब तक बंद रहती है जब तक उसका आपात निकास मार्ग न खुल जाए; देखें: जब प्रोटोकॉल रुका हो।

<a id="vault-safety"></a>

### खाते की सुरक्षा

वॉल्ट पेज पर खाते की सुरक्षा कार्ड दिखाता है कि आपका खाता संरक्षित मोड में चलता है या नहीं, उसकी देरी, क्या हर रिलीज़ के लिए किसी द्वितीयक हस्ताक्षरकर्ता की मंज़ूरी चाहिए, क्या आपके पोज़िशन NFT सुरक्षित हैं, उसकी कतार में कितने भुगतान रुके हैं, और हर बदलाव जो अभी लंबित है। संरक्षित मोड चालू करने पर आपके वॉल्ट से आपके वॉलेट तक हर भुगतान एक देरी तक रुकता है, ताकि आपका वॉलेट हथियाने वाला चोर आपके ध्यान देने से पहले आपका वॉल्ट खाली न कर सके; किसी और के वॉल्ट से आपको मिलने वाला भुगतान आपके वॉल्ट में आता है, और जो आप दूसरों को देते हैं उसमें कोई देरी नहीं होती। बेसिक मोड में देरी वह सबसे छोटी है जिसकी प्रोटोकॉल अनुमति देता है, दो दिन, और पोज़िशन NFT की सुरक्षा बंद रहती है; एडवांस्ड मोड में आप पाँच दिन तक चुन सकते हैं और अपने पोज़िशन NFT सुरक्षित कर सकते हैं। अभी लॉक करें हर रुका भुगतान रद्द करता है (एसेट आपके वॉल्ट में रहते हैं), नई पोज़िशन रोकता है और हर लंबित बदलाव हटा देता है; चुकाना और कोलैटरल जोड़ना चलता रहता है, और लॉक विराम के दौरान भी काम करता है। अनलॉक एक अनुरोध है जो आपके खाते की देरी के बाद ही लागू होता है; देय होने पर देय बदलाव लागू करें उसे लागू करता है, साथ में हर दूसरा देय बदलाव भी। आपकी भुगतान कतार कार्ड के नीचे दिखती है। अगर इस नेटवर्क के प्रोटोकॉल में संरक्षित मोड नहीं है, तो कार्ड कहता है कि यह उपलब्ध नहीं है; अगर इसे पढ़ा न जा सके, तो कार्ड कोई नियंत्रण नहीं देता और कहता है कि इसे बंद न मानें। हर कार्रवाई आपके वॉलेट से एक बार पूछती है, और अंतिम कार्ड दिखाता है कि प्रोटोकॉल ने क्या दर्ज किया।

<a id="vault-escape"></a>

### जब प्रोटोकॉल रुका हो

जब तक प्रोटोकॉल रुका है, वॉल्ट पेज ऊपर यह बताता है: निकासी बंद है, जबकि पूरा और आंशिक भुगतान और कोलैटरल जोड़ना खुला रहता है। अगर यह प्रशासनिक विराम है, तो यह भी बताता है कि उसका आपात निकास मार्ग कब खुलेगा, जैसा प्रोटोकॉल बताता है, उलटी गिनती के साथ। मार्ग खुलने के बाद, जिस भी एसेट में कुछ मुक्त है उस पर निकासी आपका हिस्सा सीधे आपके वॉलेट में लौटाती है; समीक्षा बताती है कि यह आपात निकास मार्ग से जाती है, और यह मार्ग कभी वह नहीं लौटाता जिसे कोई ऋण, ऑफ़र या दावा रोके हुए है। संरक्षित मोड चालू हो तो आपकी निकासी पहले की तरह भुगतान कतार में आपके खाते की देरी तक रुकती है। स्वचालित विराम, या अभी लॉन्च न हुआ प्रोटोकॉल, कोई आपात निकास मार्ग नहीं खोलता, और पेज बताता है कि कोई तय नहीं है।

<a id="my-offers"></a>

### आपके ऑफ़र

ऑफ़र पेज उस नेटवर्क पर आपके बनाए हर ऑफ़र को, और हर उस ऑफ़र को जिसका पोज़िशन टोकन अभी आपके पास है, सबसे नया पहले दिखाता है। हर ऑफ़र वह स्थिति दिखाता है जो प्रोटोकॉल बताता है: खुला, पूरा, बिका, समाप्त या रद्द, और सूची के ऊपर के फ़िल्टर हर स्थिति गिनते हैं। उधार का अनुरोध बिका हुआ दिखता है जब उसका गिरवी किसी के स्वीकार करने से पहले उसकी मार्केटप्लेस लिस्टिंग से बिक गया हो: कोई लोन नहीं खुला, और बिक्री की रकम उसके बनाने वाले के वॉल्ट में गई। खुला ऑफ़र जो उधार देता या गिरवी रखता है, उसे पूरा या रद्द होने तक आपके वॉल्ट में रखता है; समाप्त ऑफ़र उसे तब तक वहीं रखता है जब तक उसे साफ़ न किया जाए। जब प्रोटोकॉल ऐसा ऑफ़र रद्द करता है जिसका कुछ भी पूरा नहीं हुआ, तो वह उसकी शर्तें मिटा देता है, इसलिए पेज केवल उसका नंबर और स्थिति दिखाता है। अगर आपके बनाए ऑफ़र का पोज़िशन टोकन किसी और वॉलेट के पास है, तब भी आप उसे रद्द कर सकते हैं और वापसी आपको मिलती है; अगर आपके पास किसी और वॉलेट का बनाया ऑफ़र है, तो समाप्ति से पहले केवल वही वॉलेट उसे रद्द कर सकता है। आपके ऑफ़र के नीचे ऑफ़र बुक है, जिसका वर्णन आगे है।

<a id="offer-book"></a>

### ऑफ़र बुक

आपके ऑफ़र के नीचे, ऑफ़र बुक नेटवर्क का हर खुला ऑफ़र दिखाती है, सबसे नया पहले; इसे वॉलेट जोड़ने के बाद ही पढ़ा जाता है। टैब किसी टोकन के लोन को NFT किराये से अलग करते हैं, एक फ़िल्टर ऋणदाताओं के ऑफ़र, उधारकर्ताओं के अनुरोध या दोनों दिखाता है, और जुड़ने के बाद आप अपने ऑफ़र छिपा सकते हैं। पुराने ऑफ़र “पुराने ऑफ़र दिखाएँ” से लोड होते हैं; फ़िल्टर पढ़े गए ऑफ़र पर लागू होते हैं, और गिनती वाली पंक्ति बताती है कि वे कितने हैं। बुक प्रोटोकॉल के इंडेक्स से आती है, जो चेन से कुछ मिनट पीछे हो सकता है, इसलिए यह केवल ऑफ़र की ओर इशारा करती है: किसी ऑफ़र को खोलकर देखें कि चेन उसे कैसे रखती है। समाप्ति निकल चुके ऑफ़र पर समाप्त का टैग लगता है; कोई भी उसे साफ़ कर सकता है, और जो उसने लॉक किया था वह उसके निर्माता को लौटता है। अगर इंडेक्स पढ़ा नहीं जा सकता, तो बुक यही कहती है, न कि यह दिखाती है कि कोई ऑफ़र नहीं है।

<a id="offer-detail"></a>

### किसी ऑफ़र का पेज

हर ऑफ़र का अपना पेज है, जो वॉलेट जुड़ने के बाद चेन से पढ़ा जाता है। इसमें दिखता है कि उसे किसने डाला, रकम, कितना पहले भर चुका है, कोलैटरल, अवधि और ऑफ़र कब समाप्त होता है। वहाँ से आप किसी खुले लोन ऑफ़र को पूरा ले सकते हैं, उसी समीक्षा और सहमति से जो उधार लें और उधार दें में है: किसी ऋणदाता के ऑफ़र से उधार लें, या किसी उधारकर्ता के अनुरोध को फ़ंड करें। रद्द करें और साफ़ करें वहाँ वैसे ही काम करते हैं जैसे आपके ऑफ़र पर। किराये, NFT कोलैटरल वाले ऑफ़र, चल रहे लोन की बिक्री और जल्दी बंद करने वाले ऑफ़र अभी मौजूदा ऐप में लिए जाते हैं, और पेज उसका लिंक देता है। समीक्षा के दौरान ऑफ़र आपके लिए आरक्षित नहीं होता; कोई और उसे पहले ले या रद्द कर सकता है।

<a id="offer-cancel"></a>

### ऑफ़र रद्द करें

आपके बनाए खुले ऑफ़र पर रद्द करें उसे बुक से हटाता है और वह लौटाता है जो वह अब भी आपके वॉल्ट में रोके है: उधार ऑफ़र की बिना उधार दी गई राशि या उसका NFT, अनुरोध की बिना इस्तेमाल गिरवी, या किराया अनुरोध का पहले से चुकाया शुल्क और बफ़र। जिस ऑफ़र का कुछ भी पूरा नहीं हुआ, उसे पहले पाँच मिनट में रद्द नहीं किया जा सकता, ताकि रद्द करना किसी की स्वीकृति से होड़ न करे; समीक्षा बताती है कि कब कर सकेंगे, और रोक अपने आप हटा देती है। जो हिस्सा पूरा हो चुका, वह पूरा ही रहता है। समाप्त ऑफ़र पर साफ़ करें बटन होता है जो उसी तरह रोकी गई चीज़ लौटाता है; कोई भी समाप्त ऑफ़र साफ़ कर सकता है, और वापसी हमेशा उसके बनाने वाले को जाती है। समीक्षा बताती है कि क्या लौटता है और कहाँ: सुरक्षित मोड के बिना यह तुरंत आपके वॉलेट में पहुँचता है; उसके साथ यह भुगतान कतार में आपके खाते की देरी तक रुकता है, या खाता लॉक रहने तक आपके वॉल्ट में रहता है। जहाँ ऐप वापसी का आकार नहीं बता सकता, जैसे चल रहे ऋण से जुड़े ऑफ़र में, समीक्षा यह कहती है और अंतिम कार्ड दिखाता है कि क्या चला। प्रोटोकॉल रुका हो तो रद्द करना बंद रहता है। आपके वॉलेट से कुछ नहीं निकलता और कोई अनुमोदन नहीं माँगा जाता, इसलिए आपका वॉलेट एक बार पूछता है।

<a id="risk-access"></a>

### Risk Access: आपका जोखिम स्तर

हर खाता सबसे कम जोखिम स्तर पर शुरू होता है, केवल ब्लू-चिप एसेट, और केवल आप ही इसे बढ़ा सकते हैं। किसी जोड़ी को उसके अधिक जोखिम वाले टोकन का स्तर चाहिए: ब्लू-चिप टोकन को कुछ नहीं चाहिए, अन्य लिक्विड टोकन को “लिक्विड एसेट” चाहिए, और एक इलिक्विड टोकन को “कोई भी एसेट, इलिक्विड सहित” के साथ उसी जोड़ी के लिए आपकी सहमति चाहिए। जब कोई ऑफ़र लेने या अनुरोध पोस्ट करने के लिए ऐसा कदम चाहिए, तो समीक्षा वहीं यह बताती है और इसे अपनी रसीद के साथ एक वॉलेट पुष्टि के रूप में देती है: क्या बदलता है, किन जोड़ियों पर लागू होता है, कब प्रभावी होता है, और कि कोई धन नहीं हिलता। स्तर बढ़ाने या किसी जोड़ी पर सहमति देने के बाद प्रोटोकॉल की तय प्रतीक्षा अवधि हो सकती है; बढ़ाए गए स्तर के लिए ऐप चेन से पढ़ा गया प्रभावी होने का समय दिखाता है, सहमति के लिए बताता है कि प्रोटोकॉल अभी वह समय प्रकाशित नहीं करता, और एक ही कदम दोबारा कभी नहीं देता, क्योंकि दूसरा कदम प्रतीक्षा फिर से शुरू कर देगा। स्तर घटाना हमेशा तुरंत प्रभावी होता है। जब प्रोटोकॉल नई जोखिम शर्तें प्रकाशित करता है, तो आपका स्तर और सहमतियाँ तब तक नहीं गिनी जातीं जब तक आप उन्हें फिर से पुष्टि न करें। यदि आपने सख़्त मोड चालू किया है, तो हर लिक्विड जोड़ी को भी आपकी स्वीकृति चाहिए। ऋणदाता के अपने जोखिम स्तर से आने वाली रुकावट उनकी बताई जाती है: आपके खाते में कुछ भी उसे नहीं बदलेगा।

<a id="terms-gate"></a>

### शर्तों की पुष्टि

जहाँ सेवा की शर्तों का कोई संस्करण लागू हो, वहाँ ऐप कुछ नया शुरू करने वाली कार्रवाई से पहले, जैसे फीस छूट चालू करना, आपसे उसे स्वीकार करने को कहता है और बताता है कि किस कार्रवाई ने पूछा। वह संस्करण, उसके पाठ का फिंगरप्रिंट और उसी संस्करण का लिंक दिखाता है, जिसका पाठ कभी नहीं बदलता। स्वीकार करना वॉलेट में एक पुष्टि है और इसमें कोई फंड नहीं हिलता। अगर ऐप यह नहीं पढ़ पाता कि आपने स्वीकार किया है या नहीं, तो वह यह बताता है और दोबारा कोशिश करने देता है, इसे इनकार नहीं मानता। चुकाना, क्लेम करना, अपने एसेट निकालना, अपने ऑफ़र रद्द करना और कोई सहमति बंद करना कभी नहीं रोका जाता।

<a id="settings"></a>

### सेटिंग्स

सेटिंग्स मेनू के सबसे नीचे है। मोड, थीम और भाषा के लिए वॉलेट नहीं चाहिए और ये इसी ब्राउज़र में रहते हैं। जब तक आप कोई थीम नहीं चुनते, थीम आपके डिवाइस के अनुसार चलती है, और जिस भाषा का अनुवाद अभी नहीं हुआ वह अनुवाद होने तक अंग्रेज़ी दिखाती है। वॉलेट जुड़ा हो तो सेटिंग्स दिखाती है कि आपने इस नेटवर्क पर Terms of Service का कौन-सा version स्वीकार किया, या कि कोई version लागू है जिसे आपने अभी स्वीकार नहीं किया; यह उस पहले काम पर पूछा जाता है जिसे इसकी ज़रूरत हो, वहाँ कभी नहीं। शुल्क छूट की सेटिंग वही है जो Home पर है। सेटिंग्स यह भी बताती है कि यह ब्राउज़र ऐप के लिए क्या रखता है, कि कुछ भी गोपनीय नहीं रखा जाता, और कि ऐप कोई error report या diagnostics नहीं भेजता। सेटिंग्स इस ब्राउज़र में ऐप के रिकॉर्ड एक फ़ाइल में डाउनलोड भी कर सकती है, या यह साइट यहाँ जो कुछ रखती है वह सब मिटा सकती है। मिटाने से पहले यह बताती है कि कितनी चीज़ें हटेंगी; मिटाने पर आपका वॉलेट डिस्कनेक्ट होता है, मोड, थीम और भाषा default पर लौट आते हैं, और फिर दिखता है कि क्या हटाया गया। on-chain आपकी positions, alert service के पास आपकी alert settings, marketing साइट और आपका wallet app प्रभावित नहीं होते।

सेटिंग्स इस नेटवर्क पर आपका जोखिम स्तर शब्दों में भी दिखाती है, यह भी कि क्या यह नेटवर्क उसे लागू करता है, और क्या सख़्त मोड चालू है। अगर नई जोखिम शर्तों के कारण आपका स्तर गिना जाना बंद हो गया है, तो आप वहीं एक वॉलेट कदम में उसकी फिर से पुष्टि कर सकते हैं। स्तर बढ़ाने या घटाने, या सख़्त मोड चालू या बंद करने के लिए **Advanced** मोड में जाएँ: हर बदलाव अपनी रसीद के साथ एक वॉलेट पुष्टि है और कोई धन नहीं हिलाता। घटाना तुरंत प्रभावी होता है और नए स्तर से ऊपर की जोड़ियों को नए ऑफ़र और अनुरोधों के लिए बंद कर देता है, आपके अपने खुले ऑफ़र भी; आपके मौजूदा ऋण प्रभावित नहीं होते। बढ़ाने में प्रोटोकॉल की प्रतीक्षा अवधि लग सकती है, और ऐप बताता है कि वह कब से गिना जाएगा।

सेटिंग्स उन स्थायी अनुमतियों की सूची भी दिखाती है जो आपका वॉलेट इस नेटवर्क पर प्रोटोकॉल को देता है: किसी टोकन की कितनी मात्रा वह आपसे दोबारा पूछे बिना ले जा सकता है, या किसी पूरे NFT संग्रह या एक NFT पर अनुमति। हर अनुमति एक वॉलेट पुष्टि में वापस ली जा सकती है, जो कोई धन नहीं हिलाती। सूची सुझाए गए एसेट और हर उस एसेट की जाँच करती है जिसका नाम यहाँ आपकी जमा, ऋण और ऑफ़र लेते हैं, और आप जाँच के लिए कोई और टोकन जोड़ सकते हैं; किसी अन्य टोकन की अनुमति वहाँ नहीं मिलती, इसलिए बाकी आपका वॉलेट दिखा सकता है। अगर कोई दूसरी अनुमति भी उसी एसेट को कवर करती है, जैसे किसी एक NFT के लिए पूरे कलेक्शन की अनुमति, तो समीक्षा बताती है कि वह वापस लेने के बाद भी बनी रहती है।

सेटिंग्स यह भी दिखाती हैं कि इस नेटवर्क पर कीपर आपके वॉलेट की ओर से काम कर सकते हैं या नहीं, और आपने किन कीपरों को मंज़ूरी दी है। शुरुआत में सब बंद रहता है। कीपर तभी काम करता है जब कीपर एक्सेस चालू हो और उसके पास वह कार्रवाई हो; किसी लोन पर कदम के लिए यह भी ज़रूरी है कि वह लोन या ऑफ़र उस कीपर का नाम दे। कीपर को आपके फंड कभी नहीं मिलते और वह कुछ भी क्लेम, निकाल या ट्रांसफ़र नहीं कर सकता। कीपर एक्सेस बंद करना या किसी कीपर को हटाना दोनों मोड में एक वॉलेट पुष्टि से हो जाता है; एक्सेस चालू करने, कीपर को मंज़ूरी देने या उसकी कार्रवाइयाँ बदलने के लिए **Advanced** मोड में जाएँ।

आप ऐप को अपने फ़ोन या कंप्यूटर पर इंस्टॉल भी कर सकते हैं, ताकि यह होम स्क्रीन या ऐप सूची से खुले, ऑफ़र, पोज़िशन, वॉल्ट और अलर्ट के शॉर्टकट के साथ। अपने ब्राउज़र का Install app या Add to Home Screen विकल्प इस्तेमाल करें (iPhone या iPad पर: Safari, फिर Share, फिर Add to Home Screen), या **Advanced** मोड में सेटिंग्स का Install the app, जहाँ आपका ब्राउज़र इसे पेश करे। ऐप तेज़ी से खुलने के लिए अपनी कोड फ़ाइलों की कॉपी रखता है; आपकी पोज़िशन और हर आंकड़ा हमेशा नेटवर्क से पढ़ा जाता है।

<a id="rent-review"></a>

### किराया: NFT किराये पर लेना

मेनू में किराया उन NFT की सूची दिखाता है जिन्हें मालिकों ने आपके नेटवर्क पर किराये के लिए रखा है; किसी टेस्ट नेटवर्क पर कुछ न हो तो यह टेस्ट NFT और टेस्ट टोकन के लिए फ़ॉसेट की ओर ले जाता है। किराया आपको तय दिनों तक NFT इस्तेमाल करने का अधिकार देता है, NFT खुद कभी नहीं: वह मालिक के वॉल्ट में रहता है, जो किराया ख़त्म होने तक आपको उसका उपयोगकर्ता दर्ज करता है। कोई लिस्टिंग खोलें और “यह NFT किराये पर लें” चुनें। समीक्षा दिखाती है कि आपके वॉलेट से आपके अपने वॉल्ट में क्या जाता है: पूरी अवधि का दैनिक शुल्क और एक बफ़र, यानी किराये का छोटा हिस्सा जो लिस्टिंग ने पोस्ट होते समय तय किया था। यह किराये का नियम भी दिखाती है (अनुपातिक, यानी जितने दिन आप इस्तेमाल करें, अधूरा दिन पूरा गिना जाता है, या पूरी अवधि), समय पर बंद करने पर क्या लौटता है, ग्रेस अवधि और बफ़र से लिया जाने वाला विलंब शुल्क। किराये में न कोई कोलैटरल है न हेल्थ फ़ैक्टर। अगर आपके वॉलेट में किराया और बफ़र से कम है, तो समीक्षा किसी भी वॉलेट चरण से पहले यह बताती है। फिर आपका वॉलेट आपसे शर्तों पर हस्ताक्षर करने को कहता है, जिसकी कोई लागत नहीं, ज़रूरत हो तो ठीक इतनी राशि की मंज़ूरी देने को, और किराया शुरू करने को, जिसे ऐप पहले ड्राई रन में आज़माता है। इसके बाद ऐप चेन पर जाँचता है कि किराया शुरू हुआ, भुगतान आपके वॉल्ट में गया और अब आप NFT के उपयोगकर्ता हैं। किरायेदार का अनुरोध स्वीकार करना अभी मौजूदा ऐप में होता है।

<a id="rent-risks"></a>

### किराया: जोखिम

किराये का NFT कभी आपका नहीं होता, और उसे इस्तेमाल करने का आपका अधिकार किराये के साथ ख़त्म हो जाता है। किराया और बफ़र किराये के लिए आपके वॉल्ट में रहते हैं और उसके खुले रहते निकाले नहीं जा सकते। किराया अपनी अवधि के अंत में अपने आप बंद नहीं होता: उसे मौजूदा ऐप में उसके पेज से बंद करें, क्योंकि नया ऐप अभी किराया बंद नहीं कर सकता। ग्रेस अवधि में बंद करने पर बफ़र से विलंब शुल्क लगता है; ग्रेस अवधि के बाद किराया डिफ़ॉल्ट हो जाता है, आपके वॉल्ट में बचा किराया मालिक को और बफ़र प्रोटोकॉल को जाता है, और आपको कुछ वापस नहीं मिलता। पूरी अवधि वाले किराये में जल्दी बंद करने पर भी पूरी अवधि देनी होती है।

<a id="rent-list"></a>

### किराया: अपना NFT किराये पर देना

किराया पेज पर “NFT किराये पर दें” एक छोटा फ़ॉर्म खोलता है: कलेक्शन (टेस्ट नेटवर्क पर टेस्ट कलेक्शन, या चिपकाया गया पता), टोकन का नंबर और मल्टी-टोकन कलेक्शन में मात्रा; वह टोकन जिसमें किरायेदार भुगतान करते हैं; दैनिक शुल्क, एक ही आँकड़ा; अवधि दिनों में; किराये का नियम, अनुपातिक या पूरी अवधि; और लिस्टिंग कितने समय खुली रहे। कोलैटरल या ब्याज के कोई फ़ील्ड नहीं हैं: किराये में दोनों नहीं होते। समीक्षा दिखाती है कि NFT आपके वॉलेट से आपके अपने वॉल्ट में जाता है, किरायेदार पहले से क्या देता है, बफ़र का वह हिस्सा जो यह लिस्टिंग आज की सेटिंग पर तय करती है, आपको क्या मिलता है (देय किराया, प्रोटोकॉल का हिस्सा घटाकर, जो किरायेदार के लिस्टिंग लेने पर तय होता है), ग्रेस अवधि और डिफ़ॉल्ट पर क्या होता है। अगर आपके वॉलेट में NFT नहीं है, तो समीक्षा किसी भी वॉलेट चरण से पहले यह बताती है। फिर आपका वॉलेट आपसे प्रोटोकॉल को वह एक टोकन हिलाने की अनुमति देने को कहता है (मल्टी-टोकन कलेक्शन में पूरा कलेक्शन, केवल इस लिस्टिंग के लिए, बाद में एक और चरण में वापस ली जाती है) और लिस्टिंग पोस्ट करने को, जिसे ऐप पहले ड्राई रन में आज़माता है। इसके बाद ऐप चेन पर जाँचता है कि लिस्टिंग दर्ज हुई और NFT आपके वॉल्ट में पहुँचा, और लिस्टिंग के पेज का लिंक देता है।

<a id="rent-list-risks"></a>

### किराया: किराये पर देने के जोखिम

लिस्टिंग खुली रहने तक और किराये पर रहने तक NFT आपके वॉल्ट में रहता है, और लिस्टिंग या किराया ख़त्म होने तक आप उसे निकाल नहीं सकते। जब तक किसी ने उसे किराये पर नहीं लिया, आप पहले पाँच मिनट के बाद उसके पेज से लिस्टिंग रद्द कर सकते हैं। किराये पर जाने के बाद किराया ख़त्म होने तक NFT इस्तेमाल करने का अधिकार किरायेदार के पास रहता है, और आप उसे पहले वापस नहीं ले सकते। किराया अपने आप बंद नहीं होता: किरायेदार उसे बंद करता है, या ग्रेस अवधि के बाद कोई भी उसे डिफ़ॉल्ट के रूप में बंद कर सकता है; तब किराया आपको और बफ़र प्रोटोकॉल को जाता है। समाप्त हुई लिस्टिंग बंद होने तक NFT को आपके वॉल्ट में रखती है।

<a id="rent-request"></a>

### किराया: कोई NFT किराये पर माँगना

किराया पेज पर, किराये का अनुरोध पोस्ट करें वही छोटा फ़ॉर्म खोलता है जो लिस्टिंग के लिए है, आपके लिए किरायेदार के रूप में लिखा हुआ: कलेक्शन और टोकन का नंबर (मल्टी-टोकन कलेक्शन में मात्रा भी), वह टोकन जिसमें आप भुगतान करते हैं, दैनिक शुल्क एक ही संख्या में, दिनों में अवधि, किराये का नियम और अनुरोध कितने समय तक खुला रहे। समीक्षा दिखाती है कि पूरी अवधि का किराया और एक बफ़र अभी आपके वॉलेट से आपके अपने वॉल्ट में जाते हैं, वह बफ़र हिस्सा जो यह अनुरोध आज की सेटिंग पर तय करता है, कि अवधि तब से चलती है जब कोई मालिक अनुरोध स्वीकार करे, और कि स्वीकार करने वाला मालिक किराया तुरंत शुरू कर देता है, आपकी ओर से बिना किसी और कदम के। अगर आपके वॉलेट में बहुत कम है, या वही NFT पहले से है, तो समीक्षा किसी भी वॉलेट कदम से पहले यह बताती है; जो टोकन अभी मौजूद नहीं है, उसका उल्लेख किया जाता है। फिर आपका वॉलेट ठीक किराया और बफ़र स्वीकृत करता है और अनुरोध पोस्ट करता है, जिसे ऐप पहले ड्राई रन के रूप में आज़माता है। उसके बाद ऐप चेन पर जाँचता है कि अनुरोध दर्ज हुआ और किराया व बफ़र आपके वॉल्ट में पहुँचे, और अनुरोध के पेज का लिंक देता है।

<a id="rent-request-risks"></a>

### किराया: किराये के अनुरोध के जोखिम

अनुरोध खुला रहने तक किराया और बफ़र आपके वॉल्ट में रहते हैं, और जब तक आप उसे रद्द न करें या वह ख़त्म न हो, आप उन्हें निकाल नहीं सकते। जब तक किसी मालिक ने उसे स्वीकार नहीं किया, आप पहले पाँच मिनट के बाद उसके पेज से अनुरोध रद्द कर सकते हैं, और वे आपके वॉलेट में लौट आते हैं। स्वीकार करने वाला मालिक किराया तुरंत ठीक इन्हीं शर्तों पर शुरू करता है: आपके पास NFT इस्तेमाल करने का अधिकार होता है, NFT ख़ुद कभी नहीं। किराया अपने आप बंद नहीं होता: उसे उसके पोज़िशन पेज से बंद करें। देर से बंद करने पर बफ़र से विलंब शुल्क कटता है, और डिफ़ॉल्ट होने पर किराया मालिक को और बफ़र प्रोटोकॉल को जाता है। समय-सीमा बीत चुका अनुरोध बंद होने तक किराया और बफ़र आपके वॉल्ट में रखता है।
