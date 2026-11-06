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
न उसे ठीक करने का तरीका। हर "क्यों?" लिंक पूरी व्याख्या खोलता है,
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

उधार लेने के लिए आप किसी लेंडर का खुला ऑफ़र स्वीकार करते हैं: किसी एक टोकन की राशि, एक दर, एक अवधि और वह कोलैटरल जो लेंडर माँगता है। इसे स्वीकार करते ही एक ही ट्रांज़ैक्शन में लोन खुल जाता है। आपका कोलैटरल आपके वॉलेट से आपके अपने वॉल्ट में जाता है और लोन खुला रहने तक वहीं लॉक रहता है, और राशि, एक छोटी इनिशिएशन फ़ीस घटाकर, आपके वॉलेट में आती है। आप नियत तारीख़ तक राशि और ब्याज लौटाते हैं। अपना उधार अनुरोध पोस्ट करना बाद के अपडेट में आएगा।

<a id="borrow-pair"></a>

### Borrow: टोकन चुनना

पहले चुनें कि क्या उधार लेना है और क्या लॉक करना है। ऐप नेटवर्क के टोकन सुझाता है, या आप टोकन पता पेस्ट कर सकते हैं; टोकन-सुरक्षा की कोई जाँच नहीं चलती, इसलिए पेस्ट किया पता ख़ुद जाँचें। हर टोकन के लिए ऐप पढ़ता है कि प्रोटोकॉल अभी उसके बारे में क्या कहता है। लिक्विड टोकन की क़ीमत होती है, इसलिए लोन का हेल्थ फ़ैक्टर होता है और कोलैटरल का मूल्य गिरने पर उसे लिक्विडेट किया जा सकता है। इलिक्विड टोकन का मूल्य शून्य माना जाता है, और डिफ़ॉल्ट पर लेंडर को कोलैटरल ख़ुद मिलता है। जब प्रोटोकॉल किसी टोकन की क़ीमत पर भरोसा नहीं करता, तब तक उस पर नए लोन बंद रहते हैं; पहले से खुले लोन प्रभावित नहीं होते।

<a id="borrow-offers"></a>

### Borrow: ऑफ़र चुनना

पेज आपके दोनों टोकन के लिए लेंडर्स के खुले ऑफ़र दिखाता है, जो सीधे प्रोटोकॉल से पढ़े जाते हैं। हर ऑफ़र में राशि, दर और अवधि, माँगा गया कोलैटरल, आज की क़ीमतों पर लोन-टू-वैल्यू, ब्याज कैसे लगता है, कोई ब्याज शेड्यूल, ऑफ़र कब ख़त्म होता है और फ़ीस के बाद आपको क्या मिलेगा, दिखता है। ऑफ़र पूरा स्वीकार होता है, लेंडर की पूरी राशि और सबसे कम दर पर। अगर प्रोटोकॉल किसी ऑफ़र को मना करेगा, तो पेज कारण बताता है और कोई बटन नहीं दिखाता। क्रम सुविधा के लिए है, सलाह नहीं।

<a id="borrow-review"></a>

### Borrow: समीक्षा और साइन करना

वॉलेट खुलने से पहले समीक्षा हर आँकड़ा दिखाती है: आपको क्या मिलेगा, फ़ीस, आप क्या लॉक करेंगे, दर, नियत तारीख़ पर कितना देना होगा, ग्रेस अवधि और आप क्या खो सकते हैं। जोखिम प्रकटीकरण और शर्तों से सहमति के लिए आप एक बॉक्स टिक करते हैं; पुष्टि से पहले आँकड़े बदलें तो टिक हट जाता है। फिर वॉलेट आपसे शर्तों पर साइन करने को कहता है, जिसकी कोई लागत नहीं, ज़रूरत हो तो ठीक कोलैटरल जितनी मंज़ूरी देने को, और स्वीकृति भेजने को, जिसे ऐप पहले ड्राई रन में आज़माता है। अगर मंज़ूरी के बाद यह रुक जाए, तो ऐप मंज़ूरी वापस रखने को कहता है और बताता है कि ऐसा हुआ या नहीं। बाद में ऐप चेन पर खुला लोन, आई राशि और लॉक हुआ कोलैटरल जाँचता है।

<a id="borrow-fee"></a>

### Borrow: इनिशिएशन फ़ीस

लोन खोलने की लागत राशि का एक छोटा हिस्सा है, एक बार, उधार लिए टोकन में, और आपको मिलने वाली राशि से काटी जाती है; समीक्षा लागू दर दिखाती है। ब्याज पूरी राशि पर देना होता है। फ़ीस डिस्काउंट चालू हो और उधार लिया टोकन लिक्विड हो, तो आपका डिस्काउंट टियर फ़ीस घटाता है। इस फ़ीस के लिए कोई VPFI न लिया जाता है न रखा जाता है, और बाद में कुछ लौटाया नहीं जाता।

<a id="borrow-risks"></a>

### Borrow: जोखिम

लोन से आपका कोलैटरल जा सकता है। अगर ग्रेस अवधि के अंत तक आपने नहीं लौटाया, तो लोन डिफ़ॉल्ट होता है और लेंडर को आपके कोलैटरल से भुगतान होता है: जहाँ प्रोटोकॉल कर सके वहाँ बेचकर, जहाँ नहीं वहाँ जैसा है वैसा सौंपकर। लिक्विड कोलैटरल का मूल्य इतना गिरे कि हेल्थ फ़ैक्टर 1 से नीचे चला जाए, तो कोई भी लोन लिक्विडेट कर सकता है और आप कोलैटरल खोते हैं। फ़ुल-टर्म ब्याज में जल्दी लौटाने पर भी पूरी अवधि का ब्याज देना होता है। ब्याज शेड्यूल हो, तो छूटी अवधि आपके कोलैटरल का हिस्सा बेचकर चुकाई जाती है। लोन लौटाए या निपटाए जाने तक आपका कोलैटरल लॉक रहता है।

<a id="terms-gate"></a>

### शर्तों की पुष्टि

जहाँ सेवा की शर्तों का कोई संस्करण लागू हो, वहाँ ऐप कुछ नया शुरू करने वाली कार्रवाई से पहले, जैसे फीस छूट चालू करना, आपसे उसे स्वीकार करने को कहता है और बताता है कि किस कार्रवाई ने पूछा। वह संस्करण, उसके पाठ का फिंगरप्रिंट और उसी संस्करण का लिंक दिखाता है, जिसका पाठ कभी नहीं बदलता। स्वीकार करना वॉलेट में एक पुष्टि है और इसमें कोई फंड नहीं हिलता। अगर ऐप यह नहीं पढ़ पाता कि आपने स्वीकार किया है या नहीं, तो वह यह बताता है और दोबारा कोशिश करने देता है, इसे इनकार नहीं मानता। चुकाना, क्लेम करना, अपने एसेट निकालना, अपने ऑफ़र रद्द करना और कोई सहमति बंद करना कभी नहीं रोका जाता।
