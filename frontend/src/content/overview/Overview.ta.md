# Vaipakam-க்கு வரவேற்கிறோம்

Vaipakam என்பது peer-to-peer lending platform. நீங்கள் assets-ஐ lend செய்து
interest சம்பாதிக்கலாம். Assets-ஐ borrow செய்யும்போது collateral வைக்கலாம்.
NFTs-ஐ rent செய்யலாம்; owner-க்கு daily fees கிடைக்கும். எல்லாம் இரண்டு wallets
இடையே நேரடியாக நடக்கும்; loan அல்லது rental முடியும் வரை smart contracts assets-ஐ
escrow-ல் பாதுகாப்பாக வைத்திருக்கும்.

இந்தப் பக்கம் ஒரு **friendly tour**. Technical depth வேண்டும் என்றால், ஒவ்வொரு
screen-க்கும் உதவும் **User Guide** tab-ஐப் பாருங்கள்; முழு whitepaper-க்கு
**Technical** tab-ஐத் திறக்கலாம். "இது என்ன, எப்படி பயன்படுத்துவது" என்பதையே
அறிய விரும்பினால் - தொடர்ந்து படியுங்கள்.

---

## Vaipakam-ல் நீங்கள் என்ன செய்யலாம்

Vaipakam நான்கு வகையான பயனர்களுக்காக உள்ளது:

- **Lenders** - உங்களிடம் USDC, ETH, USDT போன்ற asset ஒன்று idle-ஆக இருக்கலாம்.
  அது பாதுகாப்பாக இருந்தபடியே interest சம்பாதிக்க வேண்டும் என நினைக்கிறீர்கள்.
  நீங்கள் lender offer post செய்கிறீர்கள்; borrower accept செய்கிறார்; உங்கள்
  terms-ல் நீங்கள் interest பெறுகிறீர்கள்.
- **Borrowers** - சில நாட்கள், வாரங்கள், அல்லது மாதங்களுக்கு cash தேவைப்படலாம்;
  ஆனால் உங்கள் collateral-ஐ sell செய்ய விரும்பவில்லை. அது விலை உயரும் என
  நினைக்கலாம், அல்லது பிரிய முடியாத NFT ஆக இருக்கலாம். நீங்கள் collateral post
  செய்கிறீர்கள்; loan பெறுகிறீர்கள்; agreed rate-ல் repay செய்கிறீர்கள்.
- **NFT owners** - in-game அல்லது in-app utility தரும் valuable NFT உங்களிடம்
  இருக்கலாம். அதை விற்றால் அந்த utility-ஐ நிரந்தரமாக இழப்பீர்கள். Rent-க்கு
  விடுவது, ownership உங்களிடமே இருந்தபடி மற்றொருவர் சில நாட்கள் பயன்படுத்தவும்,
  நீங்கள் daily rent பெறவும் உதவுகிறது.
- **NFT renters** - game asset, membership pass, domain போன்ற NFT-க்கு முழு விலை
  செலுத்தாமல் temporary access வேண்டும். நீங்கள் அதை rent செய்து rental window-ல்
  பயன்படுத்துகிறீர்கள்; asset owner-டமே இருக்கும்.

Sign up தேவையில்லை. Profile நிரப்பத் தேவையில்லை. Wallet connect செய்தால் lend,
borrow, அல்லது rent செய்யலாம்.

---

## Loan எப்படி செயல்படுகிறது (குறிப்பிட்ட உதாரணம்)

Base-ல் உங்கள் wallet-ல் **1,000 USDC** இருக்கிறது என்று வைத்துக்கொள்ளுங்கள்.
அதன் மூலம் interest சம்பாதிக்க விரும்புகிறீர்கள். முழு lifecycle இதுபோல் இருக்கும்.

### Step 1 — Offer உருவாக்குங்கள்

Vaipakam app-ஐத் திறந்து, wallet connect செய்து, **Create Offer**-ஐ click
செய்கிறீர்கள். நீங்கள் lender என்பதால், இவற்றை நிரப்புகிறீர்கள்:

- நான் **1,000 USDC** lend செய்கிறேன்
- எனக்கு **8% APR** வேண்டும்
- ஏற்கக்கூடிய collateral: **WETH**, **maximum 70% LTV** உடன்
- Loan duration: **30 days**

நீங்கள் ஒரு transaction sign செய்கிறீர்கள். உங்கள் 1,000 USDC wallet-லிருந்து
உங்கள் **personal escrow**-க்கு நகர்கிறது. இது நீங்கள் மட்டுமே control செய்யும்
private vault. Borrower உங்கள் offer-ஐ accept செய்யும் வரை funds அங்கேயே இருக்கும்.

### Step 2 — Borrower accept செய்கிறார்

ஒரு மணி நேரம் கழித்து, வேறு ஒருவர் உங்கள் offer-ஐ **Offer Book**-ல் பார்க்கலாம்.
அவரிடம் WETH உள்ளது; அதனை எதிராக வைத்து ஒரு மாதத்திற்கு USDC borrow செய்ய
விரும்புகிறார். அவர் **Accept** click செய்து, உதாரணமாக $1,500 மதிப்புள்ள WETH-ஐ
post செய்கிறார். இது சுமார் 67% LTV - உங்கள் 70% cap-க்கு கீழே இருப்பதால், offer
accept ஆகிறது.

அவர் accept செய்த உடனே:

- உங்கள் 1,000 USDC உங்கள் escrow-லிருந்து அவருடைய escrow-க்கு நகர்கிறது
- அவருடைய WETH collateral-ஆக அவருடைய escrow-ல் lock ஆகிறது
- இருவருக்கும் position NFT கிடைக்கும் - உங்களுடையது "எனக்கு 1,000 USDC +
  interest வரவேண்டும்" என்று குறிக்கும்; அவருடையது "repay செய்தபின் என் WETH
  திரும்ப கிடைக்க வேண்டும்" என்று குறிக்கும்
- Loan clock தொடங்குகிறது

Loaned amount-லிருந்து சிறிய **Loan Initiation Fee (0.1%)** எடுக்கப்பட்டு protocol
treasury-க்கு செல்கிறது. அதனால் borrower 1,000 அல்ல, 999 USDC பெறுகிறார். (நீங்கள்
fee-ஐ **VPFI**-யில் செலுத்தினால் borrower முழு 1,000 பெறலாம் - VPFI பற்றி கீழே
பார்க்கலாம்.)

### Step 3 — காலம் கடக்கிறது; borrower repay செய்கிறார்

30 நாட்கள் கழித்து, borrower principal plus interest repay செய்ய வேண்டும்:

```
Interest = 1,000 USDC × 8% × (30 / 365) = ~6.58 USDC
```

அவர் **Repay** click செய்து transaction sign செய்கிறார்; 1,006.58 USDC loan
settlement-க்கு நகர்கிறது. அதிலிருந்து:

- நீங்கள் **1,005.51 USDC** பெறுகிறீர்கள் (principal + interest, ஆனால் interest
  portion-ல் மட்டும் 1% Yield Fee கழித்த பின்)
- Treasury **1.07 USDC**-ஐ Yield Fee-ஆக பெறுகிறது
- Borrower-ன் WETH unlock ஆகிறது

உங்கள் dashboard-ல் **Claim** button தெரியும். அதை click செய்தால் 1,005.51 USDC
settlement-லிருந்து உங்கள் wallet-க்கு நகர்கிறது. Borrower claim செய்தால் WETH
அவரது wallet-க்கு திரும்பும். Loan close ஆகிறது.

### Step 4 — Borrower repay செய்யாவிட்டால்?

இரண்டு விஷயங்கள் தவறாகலாம்; protocol ஒவ்வொன்றையும் automatic-ஆக கையாளும்.

**Loan நடுவில் collateral price crash ஆகிறது.** Vaipakam ஒவ்வொரு loan-க்கும்
**Health Factor**-ஐ track செய்கிறது. இது collateral value-ஐ debt-உடன் ஒப்பிடும்
ஒரு single number. அது 1.0-க்கு கீழே சென்றால், யாரும் - ஆம், யாரும், ஒரு passing
bot கூட - **Liquidate** call செய்யலாம். Protocol collateral-ஐ அதிகபட்சம் நான்கு
DEX aggregators (0x, 1inch, Uniswap, Balancer) வழியாக route செய்து, சிறந்த fill-ஐ
எடுத்து, உங்களுக்கு வரவேண்டிய தொகையை செலுத்தி, liquidator-க்கு சிறிய bonus கொடுத்து,
மீதமுள்ளதை borrower-க்கு திருப்புகிறது.

**Borrower due date கடந்தும் காணாமல் போகிறார்.** Configurable **grace period**
கழித்த பின் - short loans-க்கு ஒரு மணி நேரம், year-long loans-க்கு இரண்டு வாரங்கள் -
யாரும் **Default** call செய்யலாம். அதே liquidation path இயங்கும்.

அரிதான நேரங்களில் - ஒவ்வொரு aggregator-மும் மோசமான price தரும்போது, அல்லது collateral
கடுமையாக crash ஆனபோது - protocol மோசமான market-ல் *dump செய்ய மறுக்கும்*. அதற்கு
பதிலாக, உங்களுக்கு collateral தானே ஒரு small premium உடன் கிடைக்கும்; அதை நீங்கள் hold
செய்யலாம் அல்லது வேண்டிய நேரத்தில் sell செய்யலாம். இந்த **fallback path** முன்கூட்டியே
documented; loan terms-ன் ஒரு பகுதியாக அதை நீங்கள் accept செய்கிறீர்கள்.

### Step 5 — யாரும் repay செய்யலாம்

ஒரு நண்பர் அல்லது delegated keeper borrower-ன் loan-ஐ pay off செய்ய விரும்பினால்,
அவர்கள் செய்யலாம். Collateral borrower-க்கே திரும்பும்; உதவிய third party-க்கு அல்ல.
இது one-way door: வேறொருவரின் loan-ஐ செலுத்துவதால் அவர்களின் collateral உங்களுக்கு
கிடைக்காது.

---

## NFT rentals எப்படி செயல்படுகின்றன

Loan போலவே flow இருக்கும், ஆனால் இரண்டு வேறுபாடுகள் உள்ளன:

- **NFT escrow-லேயே இருக்கும்**; renter அதை நேரடியாக hold செய்யமாட்டார். அதற்கு
  பதிலாக, protocol **ERC-4907** மூலம் rental window-க்கு renter-க்கு NFT-யின்
  "user rights" வழங்கும். Compatible games மற்றும் apps user rights-ஐ read செய்வதால்,
  renter ownership இல்லாமலேயே play, log in, அல்லது NFT utility-ஐ பயன்படுத்தலாம்.
- **Daily fees prepaid pool-லிருந்து auto-deduct ஆகும்.** Renter முழு rental-ஐ
  upfront-ஆக, கூடுதலாக 5% buffer உடன் prepay செய்கிறார். ஒவ்வொரு நாளும் protocol
  அந்த நாளுக்கான fee-ஐ owner-க்கு release செய்கிறது. Renter early end செய்ய
  விரும்பினால், unused days refund ஆகும்.

Rental முடிந்ததும் (expiry மூலம் அல்லது default மூலம்), NFT owner-ன் escrow-க்கு
திரும்பும். பின்னர் owner அதை மீண்டும் list செய்யலாம் அல்லது wallet-க்கு claim செய்து
எடுத்துக்கொள்ளலாம்.

---

## என்னை பாதுகாப்பது என்ன?

Vaipakam-ல் lending மற்றும் borrowing risk-free அல்ல. ஆனால் protocol-ல் பல பாதுகாப்பு
layers built in ஆக உள்ளன:

- **Per-user escrow.** உங்கள் assets உங்கள் சொந்த vault-ல் இருக்கும். Protocol
  அவற்றை மற்ற users-ன் funds-உடன் pool செய்யாது. இதன் பொருள், மற்றொரு user-ஐ
  பாதிக்கும் bug உங்கள் funds-ஐ drain செய்ய முடியாது.
- **Health Factor enforcement.** Origination நேரத்தில் collateral loan value-ன்
  குறைந்தது 1.5× ஆக இருந்தால்தான் loan தொடங்கும். Loan நடுவில் price borrower-க்கு
  எதிராக நகர்ந்தால், collateral debt-ஐ விட குறையும்முன் யாரும் liquidate செய்யலாம் -
  இதனால் lender பாதுகாக்கப்படுகிறார்.
- **Multi-source price oracle.** Prices முதலில் Chainlink-லிருந்து வருகிறது; பின்னர்
  Tellor, API3, DIA ஆகியவற்றுடன் cross-check செய்யப்படுகிறது. அவை configured
  threshold-ஐ விட அதிகமாக disagree செய்தால், loan open ஆகாது; ongoing position-ஐ
  unfair-ஆக liquidate செய்ய முடியாது. Fake price உருவாக்க attacker ஒரே block-ல்
  **பல independent oracles**-ஐ corrupt செய்ய வேண்டி வரும்.
- **Slippage cap.** Liquidations collateral-ஐ 6% slippage-ஐ விட மோசமாக dump செய்ய
  மறுக்கும். Market மிக thin ஆக இருந்தால், protocol உங்களுக்கு collateral-ஐ நேரடியாக
  வழங்கும் fallback-க்கு மாறும்.
- **L2 sequencer awareness.** L2 chains-ல், chain sequencer downtime-இலிருந்து
  இப்போதுதான் திரும்பியிருந்தால் liquidation சிறிது நேரம் pause ஆகும்; stale-price
  window-ஐ attackers உங்களுக்கு எதிராக பயன்படுத்த முடியாது.
- **Pause switches.** ஒவ்வொரு contract-க்கும் emergency pause levers உள்ளன. ஏதாவது
  தவறாகத் தெரிந்தால் operator சில seconds-ல் new business-ஐ stop செய்ய முடியும்;
  அதே நேரத்தில் existing users தங்கள் positions-ஐ safely wind down செய்யலாம்.
- **Independent audits.** ஒவ்வொரு chain-லுள்ள ஒவ்வொரு contract-மும் third-party
  security review முடிந்த பிறகே ship ஆகும். Audit reports மற்றும் bug bounty scope
  public.

இருப்பினும், நீங்கள் எதற்கு sign செய்கிறீர்கள் என்பதை புரிந்துகொள்ள வேண்டும். ஒவ்வொரு
loan-க்கும் முன் தோன்றும் combined **risk consent**-ஐ படியுங்கள் - அது
abnormal-market fallback path மற்றும் illiquid collateral-க்கான in-kind settlement
path-ஐ விளக்குகிறது. Consent box tick செய்யும்வரை app accept செய்ய அனுமதிக்காது.

---

## செலவு எவ்வளவு?

இரண்டு fees மட்டும்; இரண்டும் மிகச் சிறியது:

- **Yield Fee — 1%** நீங்கள் lender-ஆக சம்பாதிக்கும் **interest**-ல் 1% மட்டும்
  (principal-ல் 1% அல்ல). 1,000 USDC-க்கு 30-day 8% APR loan எடுத்தால், lender
  சுமார் 6.58 USDC interest பெறுகிறார்; அதில் சுமார் 0.066 USDC Yield Fee.
- **Loan Initiation Fee — 0.1%** lending amount-ல் 0.1%, origination நேரத்தில்
  borrower செலுத்துவார். 1,000 USDC loan-க்கு இது 1 USDC.

இரண்டு fees-மும் escrow-ல் VPFI hold செய்வதன் மூலம் **24% வரை discount** பெறலாம்
(கீழே பார்க்கவும்). Default அல்லது liquidation நேரத்தில் recovered interest-ல் Yield
Fee வசூலிக்கப்படாது - failed loan-இலிருந்து protocol profit செய்யாது.

Withdrawal fees இல்லை, idle fees இல்லை, streaming fees இல்லை, principal-ல்
"performance" fees இல்லை. Protocol எடுக்கும் பணம் மேலுள்ள இரண்டு numbers மட்டும்.

---

## VPFI என்றால் என்ன?

**VPFI** என்பது Vaipakam-ன் protocol token. இது மூன்று விஷயங்களை செய்கிறது:

### 1. Fee discounts

ஒரு chain-ல் உங்கள் escrow-ல் VPFI hold செய்தால், அந்த chain-ல் நீங்கள் பங்கேற்கும்
loans-ன் protocol fees-க்கு discount கிடைக்கும்:

| Escrow-ல் VPFI | Fee discount |
|---|---|
| 100 – 999 | 10% |
| 1,000 – 4,999 | 15% |
| 5,000 – 20,000 | 20% |
| 20,000-க்கு மேல் | 24% |

Discounts lender மற்றும் borrower fees இரண்டிற்கும் பொருந்தும். Discount **loan life
முழுவதும் time-weighted** ஆக கணக்கிடப்படும்; loan முடிவதற்கு முன் திடீரென top up
செய்வதால் calculation-ஐ game செய்ய முடியாது - நீங்கள் tier-ஐ உண்மையில் hold செய்த
காலத்திற்கு proportional-ஆக discount பெறுகிறீர்கள்.

### 2. Staking — 5% APR

உங்கள் escrow-ல் இருக்கும் எந்த VPFI-யும் தானாகவே 5% annual yield-ல் staking
rewards சம்பாதிக்கும். தனி staking action இல்லை, lock-up இல்லை, "unstake" wait
இல்லை. VPFI-ஐ escrow-க்கு நகர்த்தும் நொடியிலிருந்து அது earn செய்யும். வெளியே
நகர்த்தினால் accrual நிற்கும்.

### 3. Platform interaction rewards

ஒவ்வொரு நாளும், fixed pool of VPFI lenders மற்றும் borrowers-க்கு protocol வழியாக
நகர்ந்த **interest**-க்கு proportional-ஆக distribute செய்யப்படுகிறது. நீங்கள்
lender-ஆக interest சம்பாதித்திருந்தால், அல்லது borrower-ஆக interest-ஐ clean-ஆக
செலுத்தியிருந்தால் (late fees இல்லை, default இல்லை), உங்களுக்கு share கிடைக்கும்.

Reward pool முதல் ஆறு மாதங்களில் மிகப் பெரியதாக இருக்கும்; பின்னர் ஏழு ஆண்டுகளில்
மெல்ல taper ஆகும். Early users-க்கு மிகப் பெரிய emissions கிடைக்கும்.

### VPFI பெறும் வழிகள்

மூன்று paths:

- **Earn it** - பங்கேற்பதன் மூலம் (மேலுள்ள interaction rewards).
- **Buy it** - **Buy VPFI** page-ல் fixed rate (`1 VPFI = 0.001 ETH`) மூலம்.
  Fixed-rate program ஒவ்வொரு wallet-க்கும் ஒவ்வொரு chain-க்கும் capped.
- **Bridge it** - VPFI ஒரு LayerZero OFT V2 token; அதனால் official bridge மூலம்
  supported chains இடையே நகரும்.

---

## எந்த chains ஆதரிக்கப்படுகின்றன?

Vaipakam ஒவ்வொரு supported chain-லும் independent deployment-ஆக இயங்குகிறது:
**Ethereum**, **Base**, **Arbitrum**, **Optimism**, **Polygon zkEVM**,
**BNB Chain**.

Base-ல் opened loan Base-லேயே settle ஆகும். Arbitrum-ல் opened loan Arbitrum-லேயே
settle ஆகும். Cross-chain debt இல்லை. Chains கடக்கும் ஒரே விஷயம் VPFI token மற்றும்
daily reward denominator. அது busy chains மற்றும் quiet chains இடையே rewards fair-ஆக
இருப்பதை உறுதி செய்கிறது.

---

## எங்கிருந்து தொடங்கலாம்

நீங்கள் **lend** செய்ய விரும்பினால்:

1. Vaipakam app-ஐ திறந்து wallet connect செய்யுங்கள்.
2. **Create Offer**-க்கு சென்று "Lender" தேர்வு செய்யுங்கள்.
3. Asset, amount, APR, accepted collateral, duration ஆகியவற்றை set செய்யுங்கள்.
4. இரண்டு transactions sign செய்யுங்கள் (one approval, one create); உங்கள் offer
   live ஆகும்.
5. Borrower accept செய்வதை காத்திருக்குங்கள். Dashboard உங்கள் active loans-ஐ காட்டும்.

நீங்கள் **borrow** செய்ய விரும்பினால்:

1. App-ஐ திறந்து wallet connect செய்யுங்கள்.
2. உங்கள் collateral மற்றும் நீங்கள் செலுத்தக்கூடிய APR-க்கு match ஆகும் offer-ஐ
   **Offer Book**-ல் browse செய்யுங்கள்.
3. **Accept** click செய்து, இரண்டு transactions sign செய்யுங்கள்; loan amount
   உங்கள் wallet-ல் கிடைக்கும் (0.1% Loan Initiation Fee கழித்த பின்).
4. Due date plus grace period-க்கு முன் repay செய்யுங்கள். உங்கள் collateral wallet-க்கு
   unlock ஆகும்.

நீங்கள் **NFT rent செய்ய அல்லது list செய்ய** விரும்பினால்:

அதே flow, ஆனால் **Create Offer** page-ல் ERC-20 lending-க்கு பதிலாக "NFT rental"
தேர்வு செய்யுங்கள். Form உங்களை படிப்படியாக வழிநடத்தும்.

உங்கள் VPFI-ல் **passive yield சம்பாதிக்க** மட்டும் விரும்பினால், **Dashboard** page-ல்
அதை உங்கள் escrow-க்கு deposit செய்யுங்கள். அதுதான் - staking அந்த நொடியிலிருந்து
automatic.

---

## நாங்கள் திட்டமிட்டு *செய்யாத* விஷயங்கள்

மற்ற DeFi platforms செய்யும் சில விஷயங்களை நாங்கள் திட்டமிட்டு **செய்யவில்லை**:

- **No pooled lending.** ஒவ்வொரு loan-மும் இரண்டு குறிப்பிட்ட wallets இடையே, அவர்கள்
  இருவரும் sign செய்த terms-ன் அடிப்படையில் நடக்கும். Shared liquidity pool இல்லை,
  utilization curve இல்லை, surprise rate spikes இல்லை.
- **No proxy custody.** உங்கள் assets shared vault-ல் அல்ல, உங்கள் சொந்த escrow-ல்
  இருக்கும். நீங்கள் sign செய்யும் actions-ல் மட்டுமே protocol அவற்றை நகர்த்தும்.
- **No leveraged loops by default.** நீங்கள் விரும்பினால் borrowed funds-ஐ புதிய
  lender offer-ஆக rebroadcast செய்யலாம்; ஆனால் protocol UX-ல் automatic looping-ஐ
  build செய்யாது. அது footgun என்று நாங்கள் நினைக்கிறோம்.
- **No surprise upgrades.** Escrow upgrades gated; mandatory upgrades app-ல் தோன்றி
  நீங்கள் explicit-ஆக apply செய்ய வேண்டியவையாக இருக்கும். உங்கள் vault-ஐ உங்கள் பின்னால்
  எதுவும் rewrite செய்யாது.

---

## மேலும் அறிய வேண்டுமா?

- **User Guide** tab app-ன் ஒவ்வொரு screen-ஐ card by card விளக்குகிறது. "இந்த button
  என்ன செய்கிறது?" போன்ற கேள்விகளுக்கு நல்லது.
- **Technical** tab முழு whitepaper. "Liquidation engine உண்மையில் எப்படி வேலை
  செய்கிறது?" போன்ற கேள்விகளுக்கு நல்லது.
- **FAQ** page மிகவும் பொதுவான one-liners-ஐ கையாளுகிறது.
- Discord மற்றும் GitHub repo இரண்டும் app footer-ல் linked.

இதுதான் Vaipakam. Wallet connect செய்தால், நீங்கள் உள்ளே.
