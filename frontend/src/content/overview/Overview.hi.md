# Vaipakam में आपका स्वागत है

Vaipakam एक peer-to-peer lending प्लेटफ़ॉर्म है। आप assets lend करके
interest कमा सकते हैं। आप assets borrow करके collateral जमा कर सकते
हैं। आप NFTs rent पर दे सकते हैं, और owner को daily fees मिलती हैं।
हर चीज़ सीधे दो wallets के बीच होती है; smart contracts loan या
rental समाप्त होने तक assets को vault में सुरक्षित रखते हैं।

यह पेज आपका **friendly tour** है। अगर आप तकनीकी गहराई चाहते हैं, तो
हर screen की मदद के लिए **User Guide** tab देखें, या पूरे whitepaper
के लिए **Technical** tab खोलें। अगर आप बस यह समझना चाहते हैं कि
"यह क्या है और मैं इसे कैसे इस्तेमाल करूं" — तो आगे पढ़ें।

---

## आप क्या कर सकते हैं

Vaipakam चार तरह के लोगों के लिए है:

- **Lenders** — आपके पास कोई asset (USDC, ETH, USDT, आदि) idle पड़ा
  है। आप चाहते हैं कि वह सुरक्षित रहते हुए interest कमाए। आप lender
  offer post करते हैं; borrower उसे accept करता है; और आप अपनी terms
  पर interest कमाते हैं।
- **Borrowers** — आपको कुछ दिनों, हफ्तों या महीनों के लिए cash चाहिए,
  लेकिन आप अपना collateral बेचना नहीं चाहते। शायद आपको लगता है कि
  उसकी value बढ़ेगी, या वह ऐसा NFT है जिससे आप अलग नहीं होना चाहते।
  आप collateral post करते हैं, loan लेते हैं, और agreed rate पर repay
  करते हैं।
- **NFT owners** — आपके पास कोई valuable NFT है जो game या app में
  utility देता है। उसे बेचना उस utility को हमेशा के लिए खो देना होगा।
  उसे rent पर देकर कोई और कुछ दिनों तक उसका उपयोग कर सकता है, जबकि
  ownership आपके पास रहती है और आपको daily rent मिलता है।
- **NFT renters** — आप किसी NFT (game asset, membership pass, domain)
  का temporary access चाहते हैं, पर पूरा price नहीं देना चाहते। आप उसे
  rent करते हैं, rental window में उपयोग करते हैं, और asset owner के
  पास ही रहता है।

Sign up नहीं। Profile भरना नहीं। Wallet connect करें और आप lend,
borrow या rent कर सकते हैं।

---

## Loan कैसे काम करता है (ठोस उदाहरण)

मान लीजिए आपके Base wallet में **1,000 USDC** है और आप उस पर interest
कमाना चाहते हैं। पूरा lifecycle कुछ ऐसा दिखता है।

### Step 1 — Offer बनाना

आप Vaipakam app खोलते हैं, wallet connect करते हैं, और **Create
Offer** पर click करते हैं। आप lender हैं, इसलिए आप ये details भरते
हैं:

- मैं **1,000 USDC** lend कर रहा हूं
- मुझे **8% APR** चाहिए
- Acceptable collateral: **WETH**, **maximum 70% LTV** के साथ
- Loan duration: **30 days**

आप एक transaction sign करते हैं। आपके 1,000 USDC आपके wallet से आपके
**Vaipakam Vault** में जाते हैं — एक private vault जिसे केवल आप
control करते हैं। कोई borrower आपकी offer accept करे, तब तक funds
वहीं रहते हैं।

### Step 2 — Borrower accept करता है

शायद एक घंटे बाद कोई और आपकी offer को **Offer Book** में देखता है।
उसके पास WETH है और वह उसके against एक महीने के लिए USDC borrow करना
चाहता है। वह **Accept** पर click करता है और, मान लीजिए, $1,500 के
बराबर WETH post करता है। यह लगभग 67% LTV है — आपकी 70% cap से नीचे,
इसलिए offer accept हो जाती है।

Accept होते ही:

- आपके 1,000 USDC आपके vault से उसके vault में जाते हैं
- उसका WETH collateral के रूप में उसके vault में lock हो जाता है
- आप दोनों को position NFT मिलता है — आपका कहता है "मुझे 1,000 USDC
  + interest मिलना है"; उसका कहता है "repay करने पर मेरा WETH मुझे
  वापस मिलना है"
- Loan clock चलना शुरू हो जाता है

Loaned amount से एक छोटी **Loan Initiation Fee (0.1%)** ली जाती है और
protocol treasury को भेजी जाती है। इसलिए borrower को 1,000 नहीं, 999
USDC मिलते हैं। (आप fee को **VPFI** में pay कर सकते हैं; तब borrower
को पूरे 1,000 मिलते हैं — VPFI के बारे में नीचे और है।)

### Step 3 — समय बीतता है; borrower repay करता है

30 दिनों के बाद borrower को principal plus interest repay करना होता
है:

```
Interest = 1,000 USDC × 8% × (30 / 365) = ~6.58 USDC
```

वह **Repay** पर click करता है, transaction sign करता है, और 1,006.58
USDC loan settlement में move होते हैं। इसमें से:

- आपको **1,005.51 USDC** मिलते हैं (principal + interest, interest
  वाले हिस्से पर केवल 1% Yield Fee घटाकर)
- Treasury को **1.07 USDC** Yield Fee के रूप में मिलते हैं
- Borrower का WETH unlock हो जाता है

आपके dashboard पर **Claim** button दिखता है। आप click करते हैं और
1,005.51 USDC settlement से आपके wallet में move हो जाते हैं।
Borrower claim करता है, उसका WETH उसके wallet में लौटता है, और loan
close हो जाता है।

### Step 4 — अगर borrower repay नहीं करता तो?

दो चीज़ें गलत हो सकती हैं, और protocol दोनों को automatically handle
करता है।

**Collateral price loan के बीच में crash हो जाता है।** Vaipakam हर
loan का **Health Factor** track करता है — एक single number जो
collateral value को debt से compare करता है। अगर यह 1.0 से नीचे चला
जाता है, तो कोई भी — हां, कोई भी, यहां तक कि कोई passing bot भी —
**Liquidate** call कर सकता है। Protocol collateral को चार DEX
aggregators तक route करता है (0x, 1inch, Uniswap, Balancer), best
fill लेता है, आपको owed amount pay करता है, liquidator को छोटा bonus
देता है, और जो भी leftover हो उसे borrower को लौटा देता है।

**Borrower due date के बाद गायब हो जाता है।** Configurable **grace
period** के बाद (short loans के लिए एक घंटा, year-long loans के लिए
दो हफ्ते), कोई भी **Default** call कर सकता है। वही liquidation path
चलता है।

Rare cases में — जब हर aggregator bad price देता है, या collateral
बहुत ज़्यादा crash हो चुका होता है — protocol खराब market में *dump
करने से इंकार* करता है। इसके बदले आपको collateral itself plus एक छोटा
premium मिलता है, और आप उसे hold कर सकते हैं या जब चाहें sell कर सकते
हैं। यह **fallback path** पहले से documented है और loan terms के
हिस्से के रूप में आप इसे accept करते हैं।

### Step 5 — कोई भी repay कर सकता है

अगर कोई friend या delegated keeper आपके borrower का loan pay off
करना चाहता है, तो वह कर सकता है। Collateral फिर भी borrower को ही
वापस जाता है (helpful third party को नहीं)। यह one-way door है:
किसी और का loan pay करने से आपको उसका collateral नहीं मिलता।

---

## NFT rentals कैसे काम करते हैं

Flow loan जैसा ही है, बस दो differences हैं:

- **NFT vault में रहता है**; renter उसे सीधे hold नहीं करता। इसके
  बजाय protocol **ERC-4907** का इस्तेमाल करके rental window के लिए
  renter को NFT पर "user rights" देता है। Compatible games और apps
  user rights पढ़ते हैं, इसलिए renter NFT को own किए बिना play, log
  in या उसकी utility use कर सकता है।
- **Daily fees prepaid pool से auto-deduct होती हैं।** Renter पूरी
  rental upfront plus 5% buffer prepay करता है। हर दिन protocol उस
  दिन की fee owner को release करता है। अगर renter जल्दी end करना
  चाहता है, तो unused days refund होते हैं।

Rental end होने पर (expiry या default से), NFT owner के vault में
वापस जाता है। Owner फिर उसे re-list कर सकता है या अपने wallet में
claim back कर सकता है।

---

## मेरी सुरक्षा कैसे होती है?

Vaipakam पर lending और borrowing risk-free नहीं है। लेकिन protocol
में कई built-in protection layers हैं:

- **Per-user vault.** आपके assets आपकी अपनी vault में रहते हैं।
  Protocol उन्हें दूसरे users के funds के साथ pool नहीं करता। इसका
  मतलब है कि किसी दूसरे user को affect करने वाला bug आपके funds drain
  नहीं कर सकता।
- **Health Factor enforcement.** Loan तभी start हो सकता है जब
  origination पर collateral loan value का कम से कम 1.5× हो। अगर loan
  के बीच में price borrower के खिलाफ move करता है, तो collateral debt
  से कम होने से पहले कोई भी liquidate कर सकता है — lender की
  protection के लिए।
- **Multi-source price oracle.** Prices पहले Chainlink से आते हैं,
  फिर Tellor, API3 और DIA के साथ cross-check होते हैं। अगर वे
  configured threshold से ज्यादा disagree करते हैं, तो loan open
  नहीं हो सकता और ongoing position unfairly liquidate नहीं हो सकती।
  Fake price बनाने के लिए attacker को **same block में कई independent
  oracles** corrupt करने होंगे।
- **Slippage cap.** Liquidations collateral को 6% से ज्यादा slippage
  पर dump करने से refuse करती हैं। अगर market बहुत thin है, तो
  protocol fallback करके आपको collateral directly देता है।
- **L2 sequencer awareness.** L2 chains पर, जब chain का sequencer
  downtime से अभी-अभी वापस आया हो, liquidation थोड़ी देर pause होती
  है ताकि attackers stale-price window का इस्तेमाल करके आपको नुकसान
  न पहुंचा सकें।
- **Pause switches.** हर contract में emergency pause levers हैं ताकि
  operator कुछ गलत दिखने पर seconds में new business रोक सके, जबकि
  existing users अपनी positions safely wind down कर सकें।
- **Independent audits.** हर chain पर हर contract third-party
  security review के बाद ही ship होता है। Audit reports और bug bounty
  scope public हैं।

फिर भी आपको समझना चाहिए कि आप किस चीज़ के लिए sign कर रहे हैं। हर
loan से पहले आने वाला combined **risk consent** पढ़ें — यह
abnormal-market fallback path और illiquid collateral के in-kind
settlement path को समझाता है। Consent box tick किए बिना app आपको
accept नहीं करने देगा।

---

## लागत कितनी है?

सिर्फ दो fees हैं, और दोनों छोटी हैं:

- **Yield Fee — `{liveValue:treasuryFeeBps}`%** उस **interest** का
  जो आप lender के रूप में कमाते हैं (principal का नहीं)। 1,000 USDC
  के 30-day 8% APR loan पर lender ~6.58 USDC interest कमाता है,
  जिसमें से ~0.066 USDC default rate पर Yield Fee है।
- **Loan Initiation Fee — `{liveValue:loanInitiationFeeBps}`%**
  lending amount का, origination पर borrower द्वारा paid। 1,000 USDC
  loan पर यह default rate पर 1 USDC है।

दोनों fees को vault में VPFI hold करके **`{liveValue:tier4DiscountBps}`%
तक discount** किया जा सकता है (नीचे देखें)। Default या liquidation पर
recovered interest पर कोई Yield Fee collect नहीं होती — protocol
failed loan से profit नहीं करता।

कोई withdrawal fees नहीं, कोई idle fees नहीं, कोई streaming fees
नहीं, principal पर कोई "performance" fees नहीं। Protocol सिर्फ ऊपर
बताई गई दो fees लेता है।

> **Blockchain network gas fee पर note।** जब आप offer create
> करते हैं, loan accept करते हैं, repay करते हैं, claim करते हैं,
> या कोई और on-chain action करते हैं, तब आप blockchain validators
> को एक छोटी **network gas fee** भी pay करते हैं जो आपकी
> transaction को block में include करते हैं। वह gas fee network
> को जाती है, **Vaipakam को नहीं** — यह वही fee है जो आप उसी chain
> पर कोई भी token भेजने पर pay करते। यह amount chain और उस वक्त
> की network congestion पर depend करती है, आपके loan के size पर
> नहीं। ऊपर बताई गई protocol fees (Yield Fee
> `{liveValue:treasuryFeeBps}`%, Loan Initiation Fee
> `{liveValue:loanInitiationFeeBps}`%) पूरी तरह network gas से अलग
> हैं और सिर्फ यही दो charges protocol खुद collect करता है।

---

## VPFI क्या है?

**VPFI** Vaipakam का protocol token है। यह तीन काम करता है:

### 1. Fee discounts

अगर आप किसी chain पर अपने vault में VPFI hold करते हैं, तो उस chain
पर जिन loans में आप participate करते हैं उनकी protocol fees पर
discount मिलता है:

| Vault में VPFI | Fee discount |
|---|---|
| `{liveValue:tier1Min}` – `{liveValue:tier2Min}` (excl.) | `{liveValue:tier1DiscountBps}`% |
| `{liveValue:tier2Min}` – `{liveValue:tier3Min}` (excl.) | `{liveValue:tier2DiscountBps}`% |
| `{liveValue:tier3Min}` – `{liveValue:tier4Min}` | `{liveValue:tier3DiscountBps}`% |
| `{liveValue:tier4Min}` से ऊपर | `{liveValue:tier4DiscountBps}`% |

Discounts lender और borrower दोनों fees पर लागू होते हैं। Discount
**loan की पूरी life में time-weighted** होता है, इसलिए loan end होने
से ठीक पहले top up करके calculation game नहीं की जा सकती — discount
आपको उसी अनुपात में मिलता है जितने समय तक आपने सच में उस tier को hold
किया।

### 2. Staking — 5% APR

आपके vault में रखा कोई भी VPFI automatically 5% annual yield पर
staking rewards कमाता है। कोई separate staking action नहीं, कोई
lock-up नहीं, कोई "unstake" wait नहीं। VPFI को vault में move करें
और वह उसी moment से earn करता है। उसे बाहर move करें और accrual रुक
जाता है।

### 3. Platform interaction rewards

हर दिन, VPFI का एक fixed pool lenders और borrowers में उस **interest**
के proportion में distribute होता है जो protocol से गुजरा। अगर आपने
lender के रूप में interest earn किया, या borrower के रूप में cleanly
interest pay किया (no late fees, no default), तो आपको अपना share
मिलता है।

Reward pool पहले छह महीनों में सबसे बड़ा होता है और सात साल में
धीरे-धीरे taper होता है। Early users को सबसे बड़े emissions मिलते
हैं।

### VPFI कैसे पाएं

तीन रास्ते:

- **Earn it** — participate करके (ऊपर बताए interaction rewards)।
- **Buy it** — **Buy VPFI** page पर fixed rate
  (`1 VPFI = 0.001 ETH`) पर। Fixed-rate program per wallet per chain
  capped है।
- **Bridge it** — VPFI एक LayerZero OFT V2 token है, इसलिए official
  bridge का इस्तेमाल करके supported chains के बीच move करता है।

---

## किन chains पर?

Vaipakam हर supported chain पर independent deployment के रूप में चलता
है: **Ethereum**, **Base**, **Arbitrum**, **Optimism**, **Polygon
zkEVM**, **BNB Chain**।

Base पर open हुआ loan Base पर ही settle होता है। Arbitrum पर open हुआ
loan Arbitrum पर ही settle होता है। Cross-chain debt नहीं है। Chains
के बीच सिर्फ VPFI token और daily reward denominator cross करते हैं,
ताकि busy और quiet chains के बीच rewards fair रहें।

---

## कहां से शुरू करें

अगर आप **lend** करना चाहते हैं:

1. Vaipakam app खोलें और wallet connect करें।
2. **Create Offer** पर जाएं, "Lender" चुनें।
3. अपना asset, amount, APR, accepted collateral और duration set करें।
4. दो transactions sign करें (एक approval, एक create) और आपकी offer
   live हो जाती है।
5. Borrower के accept करने का इंतज़ार करें। Dashboard आपके active
   loans दिखाता है।

अगर आप **borrow** करना चाहते हैं:

1. App खोलें, wallet connect करें।
2. **Offer Book** में ऐसी offer browse करें जो आपके collateral और
   आपके pay कर सकने वाले APR से match करती हो।
3. **Accept** पर click करें, दो transactions sign करें, और loan amount
   आपके wallet में आ जाता है (0.1% Loan Initiation Fee घटाकर)।
4. Due date plus grace period से पहले repay करें। आपका collateral
   unlock होकर आपके wallet में वापस आ जाता है।

अगर आप **NFT rent या list** करना चाहते हैं:

Flow वही है, लेकिन **Create Offer** page पर आप ERC-20 lending की जगह
"NFT rental" चुनते हैं। Form आपको step by step guide करेगा।

अगर आप सिर्फ **अपने VPFI पर passive yield** कमाना चाहते हैं, तो उसे
**Dashboard** page पर अपने vault में deposit करें। बस इतना ही —
staking उसी moment से automatic है।

---

## हम क्या *नहीं* करते

कुछ चीज़ें जो दूसरे DeFi platforms करते हैं और हम जानबूझकर **नहीं**
करते:

- **No pooled lending.** हर loan दो specific wallets के बीच होता है,
  उन terms के साथ जिन पर दोनों ने sign किया है। कोई shared liquidity
  pool नहीं, कोई utilization curve नहीं, कोई surprise rate spikes नहीं।
- **No proxy custody.** आपके assets आपके अपने vault में रहते हैं,
  shared vault में नहीं। Protocol उन्हें सिर्फ उन actions पर move
  करता है जिन्हें आप sign करते हैं।
- **No leveraged loops by default.** अगर आप चाहें तो borrowed funds
  को नई lender offer के रूप में repost कर सकते हैं, लेकिन protocol
  automatic looping को UX में build नहीं करता। हमें लगता है कि यह
  footgun है।
- **No surprise upgrades.** Vault upgrades gated हैं; mandatory
  upgrades app में दिखते हैं ताकि आप उन्हें explicitly apply करें।
  आपके vault को आपके पीछे से rewrite नहीं किया जाता।

---

## और जानना चाहते हैं?

- **User Guide** tab app की हर screen को card-by-card समझाता है।
  "यह button क्या करता है?" जैसे सवालों के लिए अच्छा है।
- **Technical** tab पूरा whitepaper है। "Liquidation engine असल में
  कैसे काम करता है?" जैसे सवालों के लिए अच्छा है।
- **FAQ** page सबसे common one-liners संभालता है।
- Discord और GitHub repo दोनों app footer से linked हैं।

यही Vaipakam है। Wallet connect करें और आप अंदर हैं।
