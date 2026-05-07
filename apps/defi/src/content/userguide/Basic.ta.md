# Vaipakam — பயனர் வழிகாட்டி (Basic Mode)

ஆப்பில் உள்ள ஒவ்வொரு கார்டையும் நட்பான, எளிய தமிழில் விளக்கும்
வழிகாட்டி இது. ஒவ்வொரு பகுதியும் கார்டு தலைப்பின் அருகிலுள்ள
`(i)` info icon-உடன் தொடர்புடையது.

> **நீங்கள் Basic பதிப்பைப் படிக்கிறீர்கள்.** இது ஆப்பின்
> **Basic** mode-உடன் பொருந்தும் (குறைந்த கட்டுப்பாடுகள்,
> எளிய தோற்றம், பாதுகாப்பான default settings). மேலும்
> தொழில்நுட்ப ரீதியான விரிவான விளக்கம் தேவை எனில், ஆப்பை
> **Advanced** mode-க்கு மாற்றுங்கள் — Settings திறக்கவும்
> (மேல்-வலது மூலையில் gear icon) → **Mode** → **Advanced**.
> அதன்பின் ஆப்பினுள் உள்ள (i) "Learn more" links Advanced
> guide-ஐத் திறக்கத் தொடங்கும்.

---

## Dashboard

<a id="dashboard.your-vault"></a>

### உங்கள் Vault

உங்கள் **vault**-ஐ Vaipakam-க்குள் இருக்கும் தனிப்பட்ட
பெட்டகமாக நினைத்துக் கொள்ளுங்கள். அதை நீங்கள் மட்டுமே
கட்டுப்படுத்தும் ஒரு சிறிய contract நிர்வகிக்கிறது. நீங்கள்
loan-இல் பங்கேற்கும் போதெல்லாம் — collateral வைப்பாக வைத்தாலும்,
ஒரு asset-ஐக் கடனாகக் கொடுத்தாலும் — assets உங்கள் wallet-இலிருந்து
இந்தப் பெட்டகத்திற்குச் செல்கின்றன. அவை யாருடைய பணத்துடனும்
கலக்கப்படாது. loan முடிந்த பிறகு, அவற்றை நேரடியாக இங்கிருந்தே
claim செய்து திரும்பப் பெறலாம்.

நீங்கள் vault-ஐ "உருவாக்க" வேண்டியதில்லை; முதன்முதலில்
தேவைப்படும் போது ஆப்பே ஒன்றை உருவாக்கிவிடும். உருவான பிறகு,
இந்தச் chain-இல் அது உங்களுக்கான dedicated இடமாகத் தொடர்ந்து
இருக்கும்.

<a id="dashboard.your-loans"></a>

### உங்கள் Loans

இந்தச் chain-இல் நீங்கள் பங்கேற்கும் ஒவ்வொரு loan-மும் இங்கே
காண்பிக்கப்படும் — நீங்கள் lender (asset-ஐக் கடனாக வழங்குபவர்)
ஆக இருந்தாலும், borrower (கடன் பெற்றவர்) ஆக இருந்தாலும். ஒவ்வொரு
வரிசையும் ஒரு தனி position. அதை கிளிக் செய்தால் முழுப் படம்
தெரியும்: loan எவ்வளவு ஆரோக்கியமாக உள்ளது, collateral-ஆக எது
lock செய்யப்பட்டுள்ளது, எவ்வளவு வட்டி சேர்ந்துள்ளது, நேரம்
வரும்போது repay, claim அல்லது liquidate செய்ய வேண்டிய பட்டன்கள்.

நீங்கள் இரண்டு வேறு roles-இல் இருந்தால் (ஒரு loan-இல் கடன்
கொடுத்தும், இன்னொன்றில் கடன் வாங்கியும் இருந்தால்), இரண்டும்
இங்கேயே தோன்றும் — அதே இடம், வேறு வரிசைகள்.

<a id="dashboard.vpfi-panel"></a>

### இந்தச் chain-இல் VPFI

**VPFI** என்பது protocol-இன் சொந்த token. அதை உங்கள் vault-இல்
வைத்திருந்தால் protocol fees-இல் discount கிடைக்கும்; கூடவே
சிறிய passive yield-ம் (5% APR) கிடைக்கும். நீங்கள் இணைந்துள்ள
chain-இல், இந்தக் கார்டு பின்வரும் விஷயங்களை காட்டுகிறது:

- இப்போது உங்கள் wallet-இல் எவ்வளவு VPFI உள்ளது.
- உங்கள் vault-இல் எவ்வளவு உள்ளது (அது "staked" எனக் கணக்கிடப்படும்).
- மொத்த VPFI supply-இல் உங்கள் பங்கு எவ்வளவு.
- மொத்தமாக இன்னும் எவ்வளவு VPFI mint செய்ய முடியும் (protocol-க்கு
  ஒரு hard cap உள்ளது).

Vaipakam பல chains-இல் இயங்குகிறது. அவற்றில் ஒன்று (Base) புதிய
VPFI mint செய்யப்படும் **canonical** chain; மற்றவை cross-chain
bridge மூலம் ஒத்திசைக்கப்பட்ட நகல்களை வைத்திருக்கும் **mirrors**.
பயனர் பார்வையில் இதைப் பற்றி தனியாக யோசிக்க வேண்டியதில்லை —
நீங்கள் எந்தச் chain-இல் இருந்தாலும், அங்கே காட்டப்படும் balance
அந்தச் chain-இல் உண்மையானதே.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount இசைவு

Vaipakam உங்கள் vault-இல் வைத்துள்ள VPFI-இன் ஒரு பகுதியைப்
பயன்படுத்தி protocol fees-இல் discount வழங்க முடியும். இந்த
switch தான் "ஆம், அதைச் செய்யலாம்" என்ற toggle. இதை ஒரு முறை
ON செய்தால் போதும்.

discount எவ்வளவு பெரியது என்பது நீங்கள் vault-இல் எவ்வளவு VPFI
வைக்கிறீர்கள் என்பதைப் பொறுத்தது:

- **Tier 1** — `{liveValue:tier1Min}` VPFI அல்லது அதற்கு மேல் → `{liveValue:tier1DiscountBps}`% off
- **Tier 2** — `{liveValue:tier2Min}` VPFI அல்லது அதற்கு மேல் → `{liveValue:tier2DiscountBps}`% off
- **Tier 3** — `{liveValue:tier3Min}` VPFI அல்லது அதற்கு மேல் → `{liveValue:tier3DiscountBps}`% off
- **Tier 4** — `{liveValue:tier4Min}` VPFI-க்கு மேல் → `{liveValue:tier4DiscountBps}`% off

switch-ஐ எப்போது வேண்டுமானாலும் OFF செய்யலாம். vault-இலிருந்து
VPFI-ஐ எடுத்துவிட்டால், உங்கள் tier real-time-இல் குறையும்.

> **Blockchain network gas பற்றிய note.** மேலே உள்ள discount
> Vaipakam-ன் **protocol fees** (Yield Fee, Loan Initiation Fee)
> மீது மட்டுமே apply ஆகும். ஒவ்வொரு on-chain action-ம் தேவைப்படும்
> சிறிய **gas fee** (offer create, accept, repay, claim போது
> blockchain validators-க்கு pay செய்யப்படுவது) - அது தனி charge,
> network-க்கு செல்கிறது, Vaipakam-க்கு அல்ல. Protocol அதற்கு
> discount கொடுக்க முடியாது, ஏனெனில் அதை protocol எப்போதும்
> receive செய்வதில்லை.

<a id="dashboard.rewards-summary"></a>

### உங்கள் VPFI வெகுமதிகள்

இந்த அட்டை நெறிமுறையிலிருந்து சம்பாதித்த ஒவ்வொரு VPFI
வெகுமதியையும் ஒரே இடத்தில் ஒன்றிணைக்கிறது. மேலே உள்ள பெரிய
எண் ஒருங்கிணைந்த மொத்தம் — நீங்கள் ஏற்கனவே கோரியதைச் சேர்த்து
கோரிக்கைக்காகக் காத்திருப்பதையும்.

இரண்டு வெகுமதி ஓடைகள் உள்ளன, மேலும் அட்டை மொத்தத்தை ஒவ்வொன்
றாகப் பிரிக்கிறது:

- **ஸ்டேக்கிங் வருமானம்** — உங்கள் Vaipakam Vaultவில் வைத்திருக்கும்
  எந்தவொரு VPFI-ல் தானாகவே சம்பாதிக்கப்படுகிறது. விகிதம் Buy
  VPFI பக்கத்தில் காட்டப்பட்ட நெறிமுறை APR ஆகும்.
- **இயங்குதள தொடர்பு வெகுமதிகள்** — நீங்கள் பங்கேற்கும்
  ஒவ்வொரு கடனுக்கும், எந்தப் பக்கத்திலும், ஒவ்வொரு நாளும்
  கொஞ்சம் சம்பாதிக்கப்படுகிறது. நீங்கள் இருக்கும் சங்கிலியில்
  VPFI-ல் செலுத்தப்படுகிறது, பாலம் தேவையில்லை.

ஒவ்வொரு வரிசையின் வலதுபுறத்திலும் ஒரு சிறிய ஷெவ்ரான் அம்பு
உள்ளது. அந்த ஓடைக்கான முழு கோரிக்கை அட்டைக்கு நேரடியாகச்
செல்ல அதைக் கிளிக் செய்யவும் — ஸ்டேக்கிங் Buy VPFI பக்கத்தில்
வாழ்கிறது, இயங்குதள தொடர்பு Claim Center-ல் வாழ்கிறது.

நீங்கள் இன்னும் எதையும் சம்பாதிக்கவில்லை என்றால், அட்டை
*மொத்த சம்பாதித்தது: 0 VPFI* உடன் தொடங்குவதற்கான குறிப்புடன்
வழங்கப்படுகிறது. நீங்கள் எதையும் தவறாகச் செய்யவில்லை —
காண்பிக்க வரலாறு இல்லை.


---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

சந்தைப் பட்டியல்கள் நீளமாக இருக்கலாம். loan எந்த asset-இல்
உள்ளது, அது lender offer-ஆ அல்லது borrower offer-ஆ, மேலும் சில
மற்ற settings அடிப்படையில் filters பட்டியலைச் சுருக்குகின்றன.
உங்கள் சொந்த active offers எப்போதும் பக்கத்தின் மேலே தெரியும் —
filters மற்றவர்களின் offers-ஐ மட்டுமே பாதிக்கும்.

<a id="offer-book.your-active-offers"></a>

### உங்கள் Active Offers

**நீங்கள்** post செய்த, இன்னும் யாரும் accept செய்யாத offers.
offer இங்கே இருக்கும் வரை அதை இலவசமாக cancel செய்ய முடியும்.
யாராவது accept செய்தவுடன், position உண்மையான loan-ஆக மாறி
Dashboard-இன் "உங்கள் Loans"-க்கு நகரும்.

<a id="offer-book.lender-offers"></a>

### Lender Offers

கடன் கொடுக்க முன்வந்துள்ளவர்களின் posts. ஒவ்வொன்றும் கூறுகின்றன:
"நான் asset Y-இன் X அலகுகளை Z% வட்டியில் D நாட்களுக்கு கடனாகக்
கொடுப்பேன், இவ்வளவு collateral-க்குப் பதிலாக".

இவற்றில் ஒன்றை accept செய்யும் borrower அந்த loan-இன் பதிவு
செய்யப்பட்ட borrower ஆகிறார்: borrower-இன் collateral vault-இல்
lock செய்யப்படுகிறது, principal asset borrower-இன் wallet-க்கு
வருகிறது, borrower repay செய்யும் வரை வட்டி சேர்ந்துக்கொண்டே
இருக்கும்.

protocol acceptance-இன் போது borrower பக்கத்தில் ஒரு
பாதுகாப்பு விதியை அமலாக்குகிறது: collateral loan-ஐ விட
குறைந்தது 1.5× மதிப்புள்ளதாக இருக்க வேண்டும். (இந்த எண்ணை
**Health Factor 1.5** என்கிறோம்.) borrower-இன் collateral
போதுமானதாக இல்லாவிட்டால், loan ஆரம்பிக்காது.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

ஏற்கனவே தங்கள் collateral-ஐ lock செய்துவிட்டு, யாராவது loan-ஐ
fund செய்வதற்காகக் காத்திருக்கும் borrowers-இன் posts.

இவற்றில் ஒன்றை accept செய்யும் lender loan-ஐ fund செய்கிறார்:
lender-இன் asset borrower-க்குச் செல்கிறது, lender அந்த loan-இன்
பதிவு செய்யப்பட்ட lender ஆகிறார், மற்றும் காலகட்டம் முழுவதும்
offer-இன் நிர்ணயிக்கப்பட்ட rate-இல் வட்டி ஈட்டுகிறார். வட்டியில் ஒரு
சிறிய பகுதி (1%) settlement-இல் protocol treasury-க்குச்
செல்கிறது.

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

எந்த side-ல் offer உருவாக்குகிறீர்கள் என்பதைத் தேர்ந்தெடுக்கவும்:

- **Lender** — lender ஒரு asset-ஐ வழங்கி, அது outstanding-ஆக
  இருக்கும் வரை வட்டி ஈட்டுகிறார்.
- **Borrower** — borrower collateral-ஐ lock செய்து, அதற்குப்
  பதிலாக மற்றொரு asset-ஐ கோருகிறார்.

"rentable" NFTs-க்கான ஒரு **Rental** sub-option-உம் உள்ளது
(தற்காலிகமாக delegate செய்யக்கூடிய ஒரு சிறப்பு வகை NFT).
Rentals-இல் பணம் கடனாக வழங்கப்படுவதில்லை — NFT-தான் தினசரி
கட்டணத்திற்கு வாடகைக்கு விடப்படுகிறது.

<a id="create-offer.lending-asset"></a>

### Lending Asset

இங்கே உள்ள asset, தொகை, வட்டி rate (APR %-இல்), மற்றும் காலம்
(நாட்களில்). offer post செய்யப்படும் தருணத்தில் rate fix ஆகும்;
பிறகு யாராலும் அதை மாற்ற முடியாது. காலம் முடிந்ததும் ஒரு குறுகிய
grace window இருக்கும் — அதற்குள் borrower repay செய்யாவிட்டால்,
loan default ஆகலாம்; அப்போது lender-இன் collateral claim
செயல்படும்.

<a id="create-offer.lending-asset:lender"></a>

#### நீங்கள் lender எனில்

நீங்கள் வழங்கத் தயாராக உள்ள principal asset மற்றும் தொகை, கூடவே
வட்டி rate (APR %-இல்) மற்றும் காலம் (நாட்களில்). rate offer
நேரத்தில் fix ஆகும்; loan default ஆகும்முன் உள்ள grace window-ஐ
காலம் தீர்மானிக்கிறது.

<a id="create-offer.lending-asset:borrower"></a>

#### நீங்கள் borrower எனில்

lender-இடமிருந்து நீங்கள் பெற விரும்பும் principal asset மற்றும்
தொகை, கூடவே வட்டி rate (APR %-இல்) மற்றும் காலம் (நாட்களில்).
rate offer நேரத்தில் fix ஆகும்; loan default ஆகும்முன் உள்ள grace
window-ஐ காலம் தீர்மானிக்கிறது.

<a id="create-offer.nft-details"></a>

### NFT Details

ஒரு rental offer-க்கு, இந்தக் கார்டு தினசரி rental fee-ஐ
அமைக்கிறது. accept செய்யும் போது, renter முழு rental செலவையும்
முன்கூட்டியே செலுத்துகிறார்; ஒப்பந்தம் சற்று நீளமானால் சமாளிக்க
சிறிய 5% buffer-உம் சேரும். NFT முழுக்க vault-இலேயே இருக்கும் —
renter-க்கு பயன்படுத்தும் உரிமை இருக்கும், ஆனால் அதை நகர்த்த
முடியாது.

<a id="create-offer.collateral"></a>

### Collateral

loan-ஐ பாதுகாக்க lock செய்யப்படும் சொத்து. இரண்டு வகைகள்:

- **Liquid** — live price feed (Chainlink + போதுமான ஆழமான
  on-chain pool) கொண்ட நன்கு அறியப்பட்ட token. protocol இதன்
  மதிப்பை real-time-இல் கணக்கிட முடியும்; loan-க்கு எதிராக
  விலை நகர்ந்தால் position-ஐ தானாக liquidate செய்ய முடியும்.
- **Illiquid** — NFTs, அல்லது price feed இல்லாத tokens.
  protocol இவற்றின் மதிப்பை கணக்கிட முடியாது. எனவே default-இல்
  lender முழு collateral-ஐயும் பெறுகிறார். offer உருவாக்குவதற்கு
  முன் lender மற்றும் borrower இருவரும் இதை ஏற்கும் box-ஐ tick
  செய்ய வேண்டும்.

<a id="create-offer.collateral:lender"></a>

#### நீங்கள் lender எனில்

loan-ஐ பாதுகாக்க borrower எவ்வளவு lock செய்ய வேண்டும் என்று
நீங்கள் விரும்புகிறீர்கள். Liquid ERC-20s (Chainlink feed + ≥$1M
v3 pool depth) LTV/HF கணக்கீடுகளைக் கிடைக்கச் செய்கின்றன;
illiquid ERC-20s மற்றும் NFTs-க்கு on-chain valuation இல்லை, மேலும்
default-இல் முழு collateral lender-க்கு செல்லும் முடிவை இரு
பக்கங்களும் ஏற்க வேண்டும்.

<a id="create-offer.collateral:borrower"></a>

#### நீங்கள் borrower எனில்

loan-ஐ பாதுகாக்க நீங்கள் எவ்வளவு lock செய்யத் தயாராக உள்ளீர்கள்.
Liquid ERC-20s (Chainlink feed + ≥$1M v3 pool depth) LTV/HF
கணக்கீடுகளைக் கிடைக்கச் செய்கின்றன; illiquid ERC-20s மற்றும்
NFTs-க்கு on-chain valuation இல்லை, மேலும் default-இல் முழு
collateral lender-க்கு செல்லும் முடிவை இரு பக்கங்களும் ஏற்க
வேண்டும்.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Vaipakam-இல் கடன் வழங்குவதும் கடன் வாங்குவதும் உண்மையான
ஆபத்துகளை உடையவை. offer-இல் கையெழுத்திடுவதற்கு முன், கையெழுத்திடும்
பக்கத்திடமிருந்து இந்தக் கார்டு வெளிப்படையான ஒப்புதலைக் கேட்கிறது.
கீழே உள்ள ஆபத்துகள் இரு பக்கங்களுக்கும் பொருந்தும்; role-specific
tabs ஒவ்வொரு ஆபத்தும் எந்தப் பக்கத்தை எப்படிப் பாதிக்கிறது என்பதை
காட்டுகின்றன.

Vaipakam non-custodial. chain-இல் உறுதியாகிவிட்ட transaction-ஐ
திருப்ப ஒரு support desk இல்லை. கையெழுத்திடுவதற்கு முன் இவற்றை
கவனமாகப் படியுங்கள்.

<a id="create-offer.risk-disclosures:lender"></a>

#### நீங்கள் lender எனில்

- **Smart-contract ஆபத்து** — contracts மாற்றமுடியாத code; தெரியாத
  bug ஒன்று funds-ஐ பாதிக்கலாம்.
- **Oracle ஆபத்து** — பழைய அல்லது manipulate செய்யப்பட்ட price
  feed காரணமாக, collateral உங்கள் principal-ஐ ஈடுகட்டும்
  புள்ளியைத் தாண்டியும் liquidation தாமதமாகலாம். நீங்கள்
  முழுமையாக ஈடு செய்யப்படாமல் போகலாம்.
- **Liquidation slippage** — liquidation சரியான நேரத்தில்
  செயல்பட்டாலும், DEX swap quote-ஐ விட மோசமான விலையில்
  நிறைவேறலாம்; அதனால் உண்மையில் உங்களுக்கு கிடைப்பது குறையலாம்.
- **Illiquid collateral** — default-இல் collateral உங்களுக்கு
  முழுவதுமாக transfer ஆகும், ஆனால் அது loan-ஐ விட குறைவான
  மதிப்புடையதாக இருந்தால் உங்களுக்கு மேற்கொண்டு உரிமை இல்லை.
  offer உருவாக்கத்தின் போது இந்த trade-off-க்கு நீங்கள் ஒப்புதல்
  அளித்தீர்கள்.

<a id="create-offer.risk-disclosures:borrower"></a>

#### நீங்கள் borrower எனில்

- **Smart-contract ஆபத்து** — contracts மாற்றமுடியாத code; தெரியாத
  bug ஒன்று உங்கள் lock செய்யப்பட்ட collateral-ஐ பாதிக்கலாம்.
- **Oracle ஆபத்து** — பழைய அல்லது manipulate செய்யப்பட்ட price
  feed காரணமாக, உண்மைச் சந்தை விலை பாதுகாப்பாக இருந்தாலும் தவறான
  தருணத்தில் உங்களுக்கு எதிராக liquidation trigger ஆகலாம்.
- **Liquidation slippage** — liquidation செயல்படும் போது, DEX
  swap உங்கள் collateral-ஐ எதிர்பார்த்ததை விட மோசமான விலையில்
  விற்கலாம்.
- **Illiquid collateral** — default-இல் உங்கள் முழு collateral-ம்
  lender-க்கு transfer ஆகும், உங்களுக்கு திரும்ப எந்த உரிமையும்
  இருக்காது. offer உருவாக்கத்தின் போது இந்த trade-off-க்கு
  நீங்கள் ஒப்புதல் அளித்தீர்கள்.

<a id="create-offer.advanced-options"></a>

### Advanced Options

தேவைப்படுபவர்களுக்கான கூடுதல் settings — பெரும்பாலான பயனர்கள்
இவற்றை default-ஆகவே விடலாம். offer expire ஆகும்முன் எவ்வளவு நேரம்
திறந்திருக்கும், இந்த குறிப்பிட்ட offer-க்கு VPFI fee discount-ஐ
பயன்படுத்த வேண்டுமா, மேலும் சில role-specific toggles போன்றவை
இங்கே இருக்கும். உங்கள் முதல் offer-இல் இவற்றை மாற்றாமல் விடுவது
பாதுகாப்பான தேர்வு.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

ஒரு loan முடிந்த பிறகு — repay ஆனாலும், default ஆனாலும்,
liquidate ஆனாலும் — அதன் முடிவில் உங்களுக்கு சேர வேண்டிய பகுதி
தானாக wallet-க்குச் செல்லாது. அதற்கு **Claim**-ஐ கிளிக் செய்ய
வேண்டும். இந்தச் chain-இல் உங்களுக்காக இன்னும் claim செய்யப்படாத
ஒவ்வொரு claim-ஐயும் இந்தப் பக்கம் காட்டுகிறது.

ஒரே பயனரிடம் lender claims (அவர் fund செய்த loans-இலிருந்து) மற்றும்
borrower claims (அவர் எடுத்த loans-இலிருந்து) இரண்டும் ஒரே நேரத்தில்
இருக்கலாம் — இரண்டும் ஒரே பட்டியலில் தோன்றும். கீழே உள்ள இரண்டு
role-specific tabs ஒவ்வொரு claim வகையும் என்ன திருப்பித் தருகிறது
என்பதை விளக்குகின்றன.

<a id="claim-center.claims:lender"></a>

#### நீங்கள் lender எனில்

உங்கள் lender claim loan-இன் principal-ஐயும் சேர்ந்த வட்டியையும்
திருப்பித் தருகிறது; வட்டி பகுதியில் இருந்து 1% treasury-க்கு
கழிக்கப்படும். loan settle ஆனவுடன் — repay செய்யப்பட்டாலும்,
default ஆனாலும், liquidate ஆனாலும் — அது claimable ஆகிவிடும்.
claim உங்கள் lender position NFT-ஐ atomic-ஆக consume செய்கிறது —
transaction உறுதியாகிவிட்டவுடன், loan-இன் அந்தப் பக்கம்
முழுவதுமாக மூடப்படும்.

<a id="claim-center.claims:borrower"></a>

#### நீங்கள் borrower எனில்

நீங்கள் loan-ஐ முழுமையாக repay செய்திருந்தால், உங்கள் borrower
claim ஆரம்பத்தில் lock செய்த collateral-ஐ திருப்பித் தரும்.
default அல்லது liquidation நடந்தால், Loan Initiation Fee-இல்
பயன்படுத்தப்படாத VPFI rebate மட்டும் திரும்ப வரும் — collateral
ஏற்கனவே lender-க்குச் சென்றிருக்கும். claim உங்கள் borrower
position NFT-ஐ atomic-ஆக consume செய்கிறது.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

நீங்கள் இணைந்துள்ள chain-இல் உங்கள் wallet சம்பந்தப்பட்ட
ஒவ்வொரு on-chain நிகழ்வும் — நீங்கள் post செய்த அல்லது accept
செய்த ஒவ்வொரு offer, ஒவ்வொரு loan, ஒவ்வொரு repayment, ஒவ்வொரு
claim, ஒவ்வொரு liquidation. இவை அனைத்தும் chain-இலிருந்தே live-ஆக
படிக்கப்படுகின்றன; offline ஆகக்கூடிய மைய server இல்லை. புதியவை
முதலில் வரும், transaction-ஆல் குழுமியிருக்கும்; எனவே ஒரே
click-இல் நடந்த செயல்கள் ஒன்றாகத் தெரியும்.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI வாங்குதல்

Buy பக்கம் protocol-இன் ஆரம்பகட்ட நிர்ணய rate-இல் ETH-ஐ VPFI-ஆக
swap செய்ய அனுமதிக்கிறது. ஆதரிக்கப்படும் எந்தச் chain-இலிருந்தும்
இதை செய்யலாம் — உள்ளுக்குள் trade-ஐ உங்களுக்காக route செய்கிறோம்.
VPFI எப்போதும் நீங்கள் இணைந்திருக்கும் அதே chain-இல் உங்கள்
wallet-க்குத் திரும்பும். networks மாற்றத் தேவையில்லை.

<a id="buy-vpfi.discount-status"></a>

### உங்கள் VPFI Discount Status

தற்போது நீங்கள் எந்த discount tier-இல் இருக்கிறீர்கள் என்பதை
விரைவாகப் பார்க்கலாம். Tier உங்கள் **vault**-இல் (wallet-இல்
அல்ல) எவ்வளவு VPFI உள்ளது என்பதிலிருந்து கணக்கிடப்படுகிறது.
அடுத்த tier-க்கு செல்ல vault-இல் இன்னும் எவ்வளவு VPFI தேவை,
Dashboard-இல் உள்ள consent switch ON-ஆ என்பதையும் இந்தக் கார்டு
காட்டும் — discount அது ON ஆக இருக்கும் போது மட்டுமே பொருந்தும்.

உங்கள் vault-இல் உள்ள அதே VPFI தானாக "stake" செய்யப்பட்டும்
உள்ளது, மற்றும் 5% APR ஈட்டுகிறது.

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH-உடன் VPFI வாங்கவும்

எவ்வளவு ETH செலவிட விரும்புகிறீர்கள் என்பதைத் தட்டச்சு செய்து,
Buy-ஐ அழுத்தி, transaction-இல் கையெழுத்திடுங்கள். அதுவே போதும்.
தவறான பயன்பாட்டைத் தடுக்க per-purchase cap மற்றும் rolling
24-hour cap உள்ளன — form-இன் அருகே live எண்கள் தெரியும், எனவே
எவ்வளவு limit மீதமுள்ளது தெளிவாக இருக்கும்.

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI-ஐ உங்கள் vault-இல் deposit செய்யவும்

VPFI வாங்கினால் அது உங்கள் wallet-இல் வரும், vault-இல் அல்ல.
fee discount மற்றும் 5% staking yield பெற, அதை நீங்களே vault-க்கு
நகர்த்த வேண்டும். இது எப்போதும் வெளிப்படையான one-click action —
நீங்கள் அனுமதிக்காமல் ஆப் உங்கள் VPFI-ஐ நகர்த்தாது. ஒரு
transaction (அல்லது ஆதரிக்கும் chains-இல் ஒரு signature) போதும்.

<a id="buy-vpfi.unstake"></a>

### Step 3 — vault-இலிருந்து VPFI-ஐ unstake செய்யவும்

உங்கள் wallet-க்கு கொஞ்சம் VPFI திரும்ப வேண்டுமா? இந்தக் கார்டு
அதை vault-இலிருந்து உங்களுக்குத் திருப்பி அனுப்பும். கவனிக்க:
VPFI வெளியெடுத்தால் உங்கள் discount tier **உடனடியாக** குறையும்.
திறந்த loans இருந்தால், அந்த தருணத்திலிருந்து discount கணக்கீடு
குறைந்த tier-க்கு மாறிவிடும்.

---

## Rewards

<a id="rewards.overview"></a>

### Rewards பற்றி

Vaipakam இரண்டு காரணங்களுக்காக உங்களுக்கு rewards வழங்குகிறது:

1. **Staking** — vault-இல் வைத்திருக்கும் VPFI தானாக 5% APR
   ஈட்டுகிறது.
2. **Interaction** — நீங்கள் பங்கேற்கும் loan உண்மையில் settle
   செய்யும் ஒவ்வொரு டாலர் வட்டிக்கும், community-wide reward
   pool-இன் தினசரி பங்கில் இருந்து உங்களுக்கு rewards கிடைக்கும்.

இரண்டும் VPFI-இலேயே வழங்கப்படும்; நீங்கள் இணைந்துள்ள chain-இல்
நேரடியாக mint செய்யப்படும். bridges இல்லை, chain மாற்றங்கள்
இல்லை.

<a id="rewards.claim"></a>

### Rewards-ஐ Claim செய்யவும்

ஒரு பட்டன் ஒரே transaction-இல் இரு reward streams-லிருந்தும்
எல்லாவற்றையும் claim செய்கிறது. Staking rewards எப்போதும்
real-time-இல் claim செய்யலாம். interaction-pool பங்கு நாளுக்கு
ஒரு முறை settle ஆகிறது; எனவே கடைசி settlement-க்கு பிறகு நீங்கள்
ஏதாவது ஈட்டியிருந்தால், மொத்தத்தின் interaction பகுதி அடுத்த
daily window முடிந்த சிறிது நேரத்திற்குப் பிறகே live ஆகும்.

<a id="rewards.withdraw-staked"></a>

### Stake செய்யப்பட்ட VPFI-ஐ Withdraw செய்யவும்

VPFI-ஐ உங்கள் vault-இலிருந்து wallet-க்கு நகர்த்துங்கள். wallet-இல்
வந்தவுடன் அது 5% APR ஈட்டுவதை நிறுத்தும்; உங்கள் discount tier-க்கும்
கணக்கிடப்படாது. Buy VPFI பக்கத்தில் உள்ள "unstake" step போலவே —
அதே action, வசதிக்காக இங்கேயும் உள்ளது.

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (இந்தப் பக்கம்)

ஒரு loan பற்றிய அனைத்தும் ஒரே பக்கத்தில். அது திறக்கப்பட்ட
நிபந்தனைகள், இப்போது அது எவ்வளவு ஆரோக்கியமாக உள்ளது, இரு
பக்கங்களிலும் யார் இருக்கிறார்கள், உங்கள் role அடிப்படையில்
நீங்கள் பயன்படுத்தக்கூடிய பட்டன்கள் — repay, claim, liquidate,
close early, refinance.

<a id="loan-details.terms"></a>

### Loan Terms

loan-இன் நிலையான விவரங்கள்: எந்த asset கடனாக வழங்கப்பட்டது,
எவ்வளவு, வட்டி rate, காலம், இதுவரை எவ்வளவு வட்டி சேர்ந்துள்ளது.
loan திறந்த பிறகு இவை எதுவும் மாறாது. (வேறு நிபந்தனைகள்
வேண்டுமெனில் refinance செய்யலாம் — ஆப் ஒரு புதிய loan-ஐ உருவாக்கி,
அதே transaction-இல் பழையதைச் செலுத்திவிடும்.)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

இந்த loan-இன் collateral மற்றும் live risk எண்கள் — Health Factor
மற்றும் LTV. **Health Factor** என்பது ஒரு பாதுகாப்பு score: 1-க்கு
மேல் இருந்தால் collateral loan-ஐ வசதியாக ஈடுகட்டுகிறது; 1-க்கு
அருகில் வந்தால் ஆபத்து அதிகரிக்கும், loan liquidate செய்யப்படலாம்.
**LTV** என்பது "எவ்வளவு கடன் வாங்கப்பட்டது vs. வைக்கப்பட்ட சொத்தின்
மதிப்பு". position unsafe ஆகும் thresholds அதே கார்டில் இருக்கும்.

collateral illiquid ஆக இருந்தால் (NFT அல்லது live price feed இல்லாத
token), இந்த எண்களை கணக்கிட முடியாது. offer உருவாக்கும்போது இரு
பக்கங்களும் அந்த முடிவை ஏற்றுக் கொண்டுள்ளனர்.

<a id="loan-details.collateral-risk:lender"></a>

#### நீங்கள் lender எனில்

இது borrower-இன் collateral — அதுவே உங்கள் பாதுகாப்பு. HF 1-க்கு
மேல் இருக்கும் வரை, நீங்கள் நன்றாக ஈடுகட்டப்பட்டுள்ளீர்கள்.
HF குறையும்போது பாதுகாப்பு மெலிதாகிறது; அது 1-ஐ கடந்தால்,
எவரும் (நீங்கள் உட்பட) liquidation-ஐ trigger செய்யலாம். DEX swap
collateral-ஐ உங்கள் principal asset-ஆக மாற்றி உங்களுக்கு திருப்பிச்
செலுத்தும். illiquid collateral-இல், default முழு collateral-ஐ
உங்களுக்குத் transfer செய்கிறது — அதன் உண்மையான மதிப்பு எதுவாக
இருந்தாலும் அதை நீங்கள் ஏற்க வேண்டும்.

<a id="loan-details.collateral-risk:borrower"></a>

#### நீங்கள் borrower எனில்

இது நீங்கள் lock செய்த collateral. HF-ஐ 1-க்கு பாதுகாப்பாக மேலே
வைத்திருக்கவும் — அது 1-க்கு அருகில் வந்தால் liquidation ஆபத்து
அதிகரிக்கும். மேலும் collateral சேர்ப்பதன் மூலம் அல்லது loan-இன்
ஒரு பகுதியை repay செய்வதன் மூலம் HF-ஐ மீண்டும் உயர்த்தலாம். HF
1-ஐ கடந்தால், எவரும் liquidation-ஐ trigger செய்யலாம்; DEX swap
உங்கள் collateral-ஐ slippage காரணமாக எதிர்பார்த்ததை விட மோசமான
விலையில் விற்று lender-க்கு repay செய்யும். illiquid collateral-இல்,
default உங்கள் முழு collateral-ஐ lender-க்கு transfer செய்கிறது;
பின்னர் உங்களுக்கு மீதம் எந்த உரிமையும் இருக்காது.

<a id="loan-details.parties"></a>

### Parties

இந்த loan-இல் உள்ள இரண்டு wallet addresses — lender மற்றும் borrower
— மேலும் அவர்களின் assets-ஐ வைத்திருக்கும் vault vaults. loan
திறந்தபோது ஒவ்வொரு பக்கத்துக்கும் ஒரு "position NFT" கிடைத்தது.
அந்த NFT _தான்_ அந்தப் பக்கத்தின் இறுதி பங்கை claim செய்யும் உரிமை
— அதை பாதுகாப்பாக வைத்திருங்கள். holder அதை வேறொருவருக்கு transfer
செய்தால், புதிய holder-தான் claim செய்ய முடியும்.

<a id="loan-details.actions"></a>

### Actions

இந்த loan-இல் கிடைக்கும் ஒவ்வொரு பட்டனும் இங்கே இருக்கும். நீங்கள்
காணும் set, இந்த குறிப்பிட்ட loan-இல் உங்கள் role-ஐப் பொறுத்தது —
கீழே உள்ள role-specific tabs ஒவ்வொரு பக்கத்தின் options-ஐ
பட்டியலிடுகின்றன. இப்போது கிடைக்காத பட்டன்கள் grey ஆக இருக்கும்;
ஏன் கிடைக்கவில்லை என்பதைச் சொல்லும் சிறிய tooltip-உடன்.

<a id="loan-details.actions:lender"></a>

#### நீங்கள் lender எனில்

- **Claim** — loan settle ஆனவுடன் (repaid, defaulted, அல்லது
  liquidated), principal மற்றும் வட்டியைத் திருப்பித் தரும்; வட்டியில்
  இருந்து 1% treasury-க்கு கழிக்கப்படும். உங்கள் lender NFT-ஐ consume
  செய்கிறது.
- **Initiate Early Withdrawal** — loan நடுவிலேயே உங்கள் lender NFT-ஐ
  மற்றொரு buyer-க்கு விற்பனைக்காக list செய்யுங்கள். அந்த buyer
  உங்கள் பக்கத்தை எடுத்துக் கொள்கிறார்; நீங்கள் sale proceeds-உடன்
  வெளியேறுகிறீர்கள்.
- **Liquidate** — HF 1-க்கு கீழே குறையும் போது அல்லது grace
  period முடியும் போது எவரும் (நீங்கள் உட்பட) இதை trigger
  செய்யலாம்.

<a id="loan-details.actions:borrower"></a>

#### நீங்கள் borrower எனில்

- **Repay** — முழுமையாகவோ பகுதியளவிலோ. பகுதியளவு repayment உங்கள்
  outstanding-ஐக் குறைத்து HF-ஐ மேம்படுத்தும்; முழு repayment loan-ஐ
  மூடி, Claim மூலம் உங்கள் collateral-ஐ unlock செய்யும்.
- **Preclose** — loan-ஐ முன்கூட்டியே மூடவும். Direct path:
  இப்போது உங்கள் wallet-இலிருந்து முழு outstanding-ஐயும்
  செலுத்துங்கள். Offset path: collateral-இன் ஒரு பகுதியை DEX-இல்
  விற்று, repay செய்ய அந்த வருமானத்தைப் பயன்படுத்தி, மிச்சம்
  இருப்பதைத் திரும்பப் பெறுங்கள்.
- **Refinance** — புதிய நிபந்தனைகளுடன் புதிய loan-க்கு roll
  செய்யவும்; protocol புதிய principal-இலிருந்து பழைய loan-ஐ ஒரே
  transaction-இல் செலுத்துகிறது. collateral vault-ஐ விட்டு
  வெளியேறாது.
- **Claim** — loan settle ஆனவுடன், முழு repayment-இல் உங்கள்
  collateral-ஐ திருப்பித் தருகிறது, அல்லது default-இல் loan-
  initiation fee-இலிருந்து மீதமுள்ள VPFI rebate.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

நீங்கள் ஒரு offer-ஐ accept செய்யும் போது, உங்கள் wallet சில
நேரங்களில் Vaipakam-ஐ ஒரு குறிப்பிட்ட token-ஐ உங்கள் சார்பாக
நகர்த்த "approve" செய்கிறது. சில wallets இந்த approvals-ஐ
தேவையானதை விட நீண்ட நேரம் திறந்தபடி வைத்திருக்கலாம். இந்தப்
பக்கம் இந்த chain-இல் Vaipakam-க்கு நீங்கள் வழங்கிய ஒவ்வொரு
approval-ஐயும் பட்டியலிடுகிறது; அவற்றில் எதையும் ஒரு click-இல்
OFF செய்யவும் அனுமதிக்கிறது. Non-zero approvals (உண்மையில் live-ஆக
உள்ளவை) மேலே தோன்றும்.

சுத்தமான approvals பட்டியலை வைத்திருப்பது நல்ல பாதுகாப்பு பழக்கம்
— Uniswap அல்லது 1inch-இலும் அதே நடைமுறை.

---

## Alerts

<a id="alerts.overview"></a>

### Alerts பற்றி

உங்கள் collateral-இன் விலை குறையும்போது, உங்கள் loan-இன்
பாதுகாப்பு score (அதன் Health Factor) கூட குறையும். யாராவது
உங்களை liquidate செய்வதற்கு **முன்** heads-up பெற Alerts-இல்
opt-in செய்யலாம். ஒரு சிறிய off-chain service ஒவ்வொரு ஐந்து
நிமிடங்களுக்கும் உங்கள் loans-ஐ கவனிக்கிறது; score danger band-ஐ
கடக்கும் தருணத்தில் உங்களுக்கு ping செய்கிறது. gas செலவு இல்லை;
on-chain எதுவும் நடக்காது.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

watcher பயன்படுத்தும் danger bands. அதிக ஆபத்துள்ள band-க்குள்
முதலில் நுழையும் போது ஒரு முறை alert வரும். அடுத்த ping, நீங்கள்
அதைவிட ஆழமான band-ஐ கடந்தால் மட்டுமே வரும். நீங்கள் மீண்டும்
பாதுகாப்பான band-க்கு திரும்பினால் ladder reset ஆகும். Defaults
சாதாரண loans-க்கு tune செய்யப்பட்டுள்ளன; மிக அதிக volatility
உள்ள collateral வைத்திருந்தால், உயர்ந்த thresholds அமைக்க
விரும்பலாம்.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

pings உண்மையில் எங்கே செல்ல வேண்டும் என்பதைக் கட்டுப்படுத்தும்
இடம் இது. Telegram (ஒரு bot உங்களுக்கு DM செய்யும்), Push Protocol
(உங்கள் wallet-க்கு நேரடி notifications), அல்லது இரண்டையும்
தேர்ந்தெடுக்கலாம். இரு rails-மும் மேலே உள்ள அதே threshold ladder-ஐ
பகிர்ந்து கொள்கின்றன — அவற்றை தனித்தனியாக tune செய்ய வேண்டியதில்லை.

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### ஒரு NFT-ஐ Verify செய்யவும்

Vaipakam position NFTs சில நேரங்களில் secondary markets-இல்
தோன்றலாம். வேறு holder-இடமிருந்து வாங்குவதற்கு முன், NFT contract
address மற்றும் token ID-ஐ இங்கே paste செய்யவும். verifier
உறுதிப்படுத்துவது: (a) அது உண்மையில் Vaipakam mint செய்ததா, (b)
underlying loan எந்த chain-இல் உள்ளது, (c) அந்த loan எந்த state-இல்
உள்ளது, மற்றும் (d) NFT-ஐ on-chain தற்போது யார் வைத்திருக்கிறார்கள்.

position NFT _தான்_ loan-இலிருந்து claim செய்யும் உரிமை. போலியான
NFT-ஐ — அல்லது ஏற்கனவே settle ஆன position-ஐ — முன்கூட்டியே
கண்டுபிடிப்பது மோசமான trade-இலிருந்து உங்களைப் பாதுகாக்கும்.

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers பற்றி

ஒரு "keeper" என்பது உங்கள் loans-இல் குறிப்பிட்ட maintenance
actions-ஐ உங்களுக்காகச் செய்ய நீங்கள் நம்பும் wallet — early
withdrawal-ஐ முடிப்பது, refinance-ஐ finalize செய்வது போன்றவை.
keepers ஒருபோதும் உங்கள் பணத்தை செலவிட முடியாது — repaying,
collateral சேர்ப்பது, claim செய்வது, liquidate செய்வது எல்லாம்
user-only actions ஆகவே இருக்கும். நீங்கள் 5 keepers வரை approve
செய்யலாம்; master switch-ஐ எப்போது வேண்டுமானாலும் OFF செய்து
அனைவரையும் ஒரே நேரத்தில் disable செய்யலாம்.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

பட்டியலில் உள்ள ஒவ்வொரு keeper-க்கும் **நீங்கள் tick செய்த actions-ஐ
மட்டுமே** செய்ய முடியும். எனவே "complete early withdrawal" மட்டும்
அனுமதிக்கப்பட்ட keeper, உங்கள் சார்பாக புதிய ஒன்றை தொடங்க முடியாது
— நீங்கள் தொடங்கியதை மட்டுமே முடிக்க முடியும். மனம் மாறினால்
ticks-ஐ edit செய்யவும்; keeper-ஐ முழுவதுமாக நீக்க விரும்பினால்,
அவர்களைப் பட்டியலில் இருந்து நீக்கவும்.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics பற்றி

முழு protocol-ஐ wallet இல்லாமலேயே பார்க்கும் வெளிப்படையான view:
மொத்த lock செய்யப்பட்ட மதிப்பு, loan volumes, default rates, VPFI
supply, சமீபத்திய activity. அனைத்தும் on-chain data-இலிருந்து live
கணக்கிடப்படுகின்றன — இந்தப் பக்கத்தில் உள்ள எந்த எண்ணுக்கும்
பின்னால் private database இல்லை.

<a id="public-dashboard.combined"></a>

### Combined — All Chains

ஒவ்வொரு ஆதரிக்கப்பட்ட chain-இலிருந்தும் சேர்த்த protocol-wide
மொத்தங்கள். "X chains covered, Y unreachable" என்ற சிறிய வரி,
பக்கம் load ஆனபோது எந்த chain network offline-ஆக இருந்தது என்பதை
சொல்லும் — அப்படியானால், அந்த chain கீழே உள்ள per-chain table-இல்
flag செய்யப்படும்.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

அதே மொத்தங்கள், chain வாரியாகப் பிரிக்கப்பட்டவை. எந்த chain-இல்
அதிக TVL உள்ளது, பெரும்பாலான loans எங்கே நடக்கின்றன, அல்லது ஒரு
chain எப்போது நின்றுள்ளது என்பதைப் புரிந்துகொள்ள உதவும்.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

இந்த chain-இல் VPFI-இன் live state — மொத்த supply எவ்வளவு, உண்மையில்
circulating-இல் எவ்வளவு உள்ளது (protocol-held balances-ஐக் கழித்த
பிறகு), cap-இன் கீழ் இன்னும் எவ்வளவு mint செய்ய முடியும். design
படி, அனைத்து chains-இலும் supply bounded-ஆகவே இருக்கும்.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

இந்தப் பக்கத்தில் உள்ள ஒவ்வொரு எண்ணையும் blockchain-இலிருந்து
நேரடியாக re-derive செய்ய முடியும். இந்தக் கார்டு snapshot block,
data எவ்வளவு சமீபத்தில் fetch செய்யப்பட்டது, ஒவ்வொரு metric எந்த
contract address-இலிருந்து வந்தது என்பதைக் காட்டும். யாராவது ஒரு
எண்ணை verify செய்ய விரும்பினால், தொடங்க வேண்டிய இடம் இதுதான்.

---

## Refinance

இந்தப் பக்கம் borrower-க்கு மட்டும் — refinance-ஐ borrower தான் தனது
loan-இல் தொடங்குகிறார்.

<a id="refinance.overview"></a>

### Refinancing பற்றி

Refinancing உங்கள் தற்போதைய loan-ஐ collateral-ஐத் தொடாமல் புதிய
loan-க்கு roll செய்கிறது. புதிய நிபந்தனைகளுடன் நீங்கள் ஒரு புதிய
borrower-side offer post செய்கிறீர்கள்; lender accept செய்தவுடன்,
protocol பழைய loan-ஐ செலுத்தி, ஒரே transaction-இல் புதிய loan-ஐ
open செய்கிறது. உங்கள் collateral பாதுகாப்பின்றி விடப்படும் தருணம்
எதுவும் இருக்காது.

<a id="refinance.position-summary"></a>

### உங்கள் தற்போதைய position

நீங்கள் refinance செய்யும் loan-இன் snapshot — outstanding எவ்வளவு,
எவ்வளவு வட்டி சேர்ந்துள்ளது, அது எவ்வளவு ஆரோக்கியமாக உள்ளது, என்ன
lock செய்யப்பட்டுள்ளது. புதிய offer-ஐ விவேகமாக size செய்ய இந்த
எண்களைப் பயன்படுத்துங்கள்.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — புதிய offer-ஐ Post செய்யவும்

refinance-க்கு நீங்கள் விரும்பும் asset, தொகை, rate, மற்றும்
காலத்துடன் borrower offer post செய்கிறீர்கள். அது list ஆகியிருக்கும்
வரை, பழைய loan வழக்கம்போல இயங்கிக் கொண்டே இருக்கும் — வட்டி இன்னும்
சேரும், உங்கள் collateral அப்படியே இருக்கும். மற்ற பயனர்கள் இந்த
offer-ஐ Offer Book-இல் பார்ப்பார்கள்.

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

ஒரு lender உங்கள் refinance offer-ஐ accept செய்தவுடன், Complete-ஐ
கிளிக் செய்யவும். protocol பின்னர் atomic-ஆக செய்கிறது: புதிய
principal-இலிருந்து பழைய loan-ஐ திருப்பிச் செலுத்துகிறது, புதிய
loan-ஐ open செய்கிறது, முழு நேரமும் உங்கள் collateral-ஐ lock-ஆகவே
வைத்திருக்கிறது. ஒரு transaction, இரண்டு state மாற்றங்கள், exposure
window இல்லை.

---

## Preclose

இந்தப் பக்கம் borrower-க்கு மட்டும் — preclose-ஐ borrower தான் தனது
loan-இல் தொடங்குகிறார்.

<a id="preclose.overview"></a>

### Preclose பற்றி

Preclose என்பது "எனது loan-ஐ முன்கூட்டியே மூடவும்". உங்களுக்கு
இரண்டு பாதைகள் உள்ளன:

- **Direct** — இப்போது உங்கள் wallet-இலிருந்து முழு outstanding
  balance-ஐயும் செலுத்துங்கள்.
- **Offset** — உங்கள் collateral-இன் சிலதை DEX-இல் விற்று
  loan-ஐ செலுத்த அந்த வருமானத்தைப் பயன்படுத்துங்கள். மிச்சம்
  இருப்பதை திரும்பப் பெறுவீர்கள்.

உங்களிடம் cash இருந்தால் Direct மலிவு. cash இல்லாமல், ஆனால் loan-ஐ
இனி தொடர விரும்பாத சூழலில் Offset உதவும்.

<a id="preclose.position-summary"></a>

### உங்கள் தற்போதைய position

நீங்கள் முன்கூட்டியே மூடப் போகும் loan-இன் snapshot — outstanding,
சேர்ந்த வட்டி, தற்போதைய ஆரோக்கியம். முன்கூட்டியே மூடுவது fee-fair
— flat penalty இல்லை; protocol-இன் time-weighted VPFI கணிதம்
கணக்கீட்டை கையாள்கிறது.

<a id="preclose.in-progress"></a>

### Offset In Progress

நீங்கள் சமீபத்தில் ஒரு offset preclose-ஐ தொடங்கியிருக்கிறீர்கள்;
swap step இன்னும் mid-flight-இல் உள்ளது. அதை complete செய்யலாம்
(வருமானம் loan-ஐ settle செய்து, ஏதேனும் மிச்சம் இருந்தால்
உங்களுக்குத் திரும்பும்), அல்லது — நீங்கள் யோசிக்கும் நேரத்தில்
விலை மாறிவிட்டால் — cancel செய்து புதிய quote-இல் மீண்டும்
முயற்சி செய்யலாம்.

<a id="preclose.choose-path"></a>

### ஒரு பாதையைத் தேர்ந்தெடுக்கவும்

இப்போது loan-ஐ செலுத்த cash இருந்தால் **Direct**-ஐத்
தேர்ந்தெடுக்கவும். வெளியேறும் போதே collateral-இன் சிலதை விற்க
விரும்பினால் **Offset**-ஐத் தேர்ந்தெடுக்கவும். இரு பாதைகளும்
loan-ஐ முழுமையாக மூடும்; preclose மூலம் பாதி மட்டும் மூட முடியாது.

---

## Early Withdrawal (Lender)

இந்தப் பக்கம் lender-க்கு மட்டும் — early withdrawal-ஐ lender தான்
தனது loan-இல் தொடங்குகிறார்.

<a id="early-withdrawal.overview"></a>

### Lender Early Exit பற்றி

காலம் முடிவதற்கு முன் loan-இலிருந்து வெளியேற விரும்பினால், protocol
மூலம் உங்கள் lender NFT-ஐ விற்பனைக்காக list செய்யலாம். buyer அதற்காக
உங்களுக்கு பணம் செலுத்துகிறார்; பதிலாக loan-இன் உங்கள் பக்கத்தை
எடுத்துக்கொள்கிறார் — இறுதி repayment + வட்டியை அவர் சேகரிப்பார்.
நீங்கள் உங்கள் பணத்துடன், buyer செலுத்திய premium ஏதேனும் இருந்தால்
அதனுடனும் வெளியேறுகிறீர்கள்.

<a id="early-withdrawal.position-summary"></a>

### உங்கள் தற்போதைய position

நீங்கள் வெளியேறப் போகும் loan-இன் snapshot — principal, இதுவரை
சேர்ந்த வட்டி, மீதமுள்ள நேரம், borrower-இன் தற்போதைய health score.
buyer உங்கள் NFT-க்கு எவ்வளவு மதிப்பு என முடிவு செய்யும்போது பார்க்கும்
முக்கிய எண்கள் இவைதான்.

<a id="early-withdrawal.initiate-sale"></a>

### Sale-ஐ தொடங்கவும்

நீங்கள் asking price-ஐ அமைக்கிறீர்கள்; protocol உங்கள் lender NFT-ஐ
list செய்கிறது; பிறகு buyer-க்காக காத்திருக்கிறீர்கள். buyer accept
செய்தவுடன், வருமானம் உங்கள் wallet-க்கு வந்து சேரும், loan தொடர்ந்து
இயங்கும் — ஆனால் நீங்கள் இனி அதில் பங்கேற்கவில்லை. listing திறந்தே
இருந்து fill ஆகாத வரை, அதை cancel செய்யலாம்.
