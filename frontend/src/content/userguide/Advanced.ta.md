# Vaipakam — பயனர் வழிகாட்டி (Advanced Mode)

App-இல் உள்ள ஒவ்வொரு card-க்கும் துல்லியமான, தொழில்நுட்ப ரீதியாக
சரியான விளக்கங்கள். ஒவ்வொரு பகுதியும் card தலைப்பின் அருகிலுள்ள
`(i)` info icon-உடன் தொடர்புடையது.

> **நீங்கள் Advanced பதிப்பைப் படிக்கிறீர்கள்.** இது App-இன்
> **Advanced** mode-உடன் பொருந்துகிறது (அடர்த்தியான controls,
> diagnostics, protocol-config விவரங்கள்). நட்பான, எளிய தமிழ்
> விளக்கத்திற்கு, App-ஐ **Basic** mode-க்கு மாற்றுங்கள் —
> Settings (மேல் வலதுபுறத்தில் உள்ள gear icon) → **Mode** →
> **Basic** திறக்கவும். அதன் பிறகு App-க்குள் உள்ள (i)
> "Learn more" links Basic வழிகாட்டியைத் திறக்கத் தொடங்கும்.

---

## Dashboard

<a id="dashboard.your-escrow"></a>

### உங்கள் Escrow

ஒரு upgradeable per-user contract — இந்த chain-இல் உங்கள் தனிப்பட்ட
vault — நீங்கள் முதன்முதலில் loan-இல் பங்கேற்கும்போது உங்களுக்காக
உருவாக்கப்படுகிறது. ஒரு address-க்கு, ஒரு chain-க்கு ஒரு escrow.
உங்கள் loan positions-உடன் இணைக்கப்பட்ட ERC-20, ERC-721, மற்றும்
ERC-1155 balances-ஐ இது வைத்திருக்கும். கலப்பு (commingling) இல்லை:
மற்ற பயனர்களின் assets இந்த contract-இல் ஒருபோதும் இருக்காது.

Escrow என்பது collateral, கடனாக வழங்கப்பட்ட assets, மற்றும் உங்கள்
locked VPFI இருக்கும் இடம். ஒவ்வொரு deposit மற்றும் withdrawal-க்கும்
protocol இதையே சரிபார்க்கிறது. Implementation-ஐ protocol owner upgrade
செய்ய முடியும், ஆனால் timelock வழியாக மட்டுமே — உடனடி upgrade
ஒருபோதும் இல்லை.

<a id="dashboard.your-loans"></a>

### உங்கள் Loans

இந்த chain-இல் இணைக்கப்பட்ட wallet தொடர்புடைய ஒவ்வொரு loan-மும் —
நீங்கள் lender பக்கத்தில் இருந்தாலும், borrower பக்கத்தில்
இருந்தாலும், அல்லது வெவ்வேறு positions-இல் இரு பக்கங்களிலும் இருந்தாலும்.
உங்கள் address-க்கு எதிராக protocol-இன் view methods-இலிருந்து
நேரடியாக கணக்கிடப்படுகிறது. ஒவ்வொரு row-வும் HF, LTV, accrued interest,
உங்கள் role மற்றும் loan-இன் status-ஆல் கட்டுப்படுத்தப்பட்ட action
surface, மற்றும் block explorer-இல் paste செய்யக்கூடிய on-chain loan id
கொண்ட முழுமையான position page-க்கு deep-link செய்கிறது.

<a id="dashboard.vpfi-panel"></a>

### இந்த chain-இல் VPFI

Active chain-இல் இணைக்கப்பட்ட wallet-க்கான live VPFI accounting:

- Wallet balance.
- Escrow balance.
- Circulating supply-இல் உங்கள் பங்கு (protocol வசம் உள்ள balances-ஐக்
  கழித்த பிறகு).
- மீதமுள்ள mintable cap.

Vaipakam VPFI-ஐ LayerZero V2 மூலம் cross-chain அனுப்புகிறது. **Base
தான் canonical chain** — அங்குள்ள canonical adapter lock-on-send /
release-on-receive semantics-ஐ இயக்குகிறது. ஆதரிக்கப்படும் மற்ற ஒவ்வொரு
chain-மும் mirror-ஐ இயக்குகிறது: inbound bridge packet வந்தால் mint
செய்கிறது, outbound-இல் burn செய்கிறது. அனைத்து chains-களிலும் உள்ள
மொத்த supply, bridging காரணமாக கட்டமைப்பு ரீதியாக மாறாமல் இருக்கும்.

ஏப்ரல் 2026 industry incident-க்குப் பிறகு cross-chain
message-verification policy கடினப்படுத்தப்பட்டது: **3 required + 2
optional verifiers, threshold 1-of-2**. Single-verifier default deploy
gate-இல் நிராகரிக்கப்படும்.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount consent

இது wallet-level opt-in flag. Terminal events-இல் fee-இன் discounted
பகுதியை உங்கள் escrow-இலிருந்து debit செய்யப்படும் VPFI மூலம் settle
செய்ய protocol-ஐ அனுமதிக்கிறது. Default: off. Off என்றால் ஒவ்வொரு
fee-இன் 100%-ஐயும் principal asset-இல் செலுத்துகிறீர்கள்; on என்றால்
time-weighted discount பொருந்தும்.

Tier ladder:

| Tier | குறைந்தபட்ச escrow VPFI | Discount |
| ---- | ----------------------- | -------- |
| 1    | ≥ 100                   | 10%      |
| 2    | ≥ 1,000                 | 15%      |
| 3    | ≥ 5,000                 | 20%      |
| 4    | > 20,000                | 24%      |

நீங்கள் VPFI-ஐ deposit அல்லது withdraw செய்யும் தருணத்தில், உங்கள்
**post-change** escrow balance அடிப்படையில் tier கணக்கிடப்பட்டு,
பிறகு ஒவ்வொரு loan-இன் வாழ்நாள் முழுவதும் time-weighted ஆகிறது. ஒரு
unstake, நீங்கள் ஈடுபட்டுள்ள ஒவ்வொரு open loan-க்கும் புதிய குறைந்த
balance அடிப்படையில் rate-ஐ உடனடியாக re-stamp செய்கிறது — பழைய
(உயர்ந்த) tier தொடரும் grace window இல்லை. loan முடிவதற்கு சற்று முன்
VPFI-ஐ top up செய்து, full-tier discount-ஐப் பிடித்து, சில நொடிகளில்
withdraw செய்யும் gaming pattern-ஐ இது மூடுகிறது.

Discount settlement-இல் lender yield fee-க்கு பொருந்தும்; borrower-க்கு
Loan Initiation Fee-ல் பொருந்தும் (borrower claim செய்யும்போது VPFI
rebate ஆக வழங்கப்படும்).

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Lender / borrower offer lists-க்கு client-side filters. Asset, side,
status, மற்றும் சில மற்ற axes அடிப்படையில் filter செய்யலாம். Filters
"Your Active Offers"-ஐ பாதிக்காது — அந்த list எப்போதும் முழுமையாகத்
தெரியும்.

<a id="offer-book.your-active-offers"></a>

### உங்கள் Active Offers

நீங்கள் உருவாக்கிய Open offers (status Active, expiry இன்னும்
எட்டப்படவில்லை). Acceptance-க்கு முன் எந்த நேரத்திலும் cancel செய்யலாம்
— cancel call free. Acceptance offer-ஐ Accepted நிலைக்கு மாற்றி loan
initiation-ஐத் தூண்டும்; அது இரண்டு position NFTs-ஐ (ஒன்று lender-க்கு,
ஒன்று borrower-க்கு) mint செய்து loan-ஐ Active state-இல் திறக்கும்.

<a id="offer-book.lender-offers"></a>

### Lender Offers

கடன் கொடுக்கத் தயாராக உள்ள creators-களிடமிருந்து Active offers.
Acceptance borrower-ஆல் செய்யப்படுகிறது. Initiation-இல் ஒரு கடினமான
gate உள்ளது: borrower-இன் collateral basket, lender-இன் principal
request-க்கு எதிராக குறைந்தபட்சம் 1.5 Health Factor உருவாக்க வேண்டும்.
HF math protocol-இன் சொந்த கணக்கீடு — இந்த gate-ஐ bypass செய்ய முடியாது.
Interest-இன் 1% treasury cut terminal settlement-இல் debit செய்யப்படும்,
முன்கூட்டியே அல்ல.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

ஏற்கனவே escrow-இல் collateral-ஐ lock செய்துள்ள borrowers-களிடமிருந்து
Active offers. Acceptance lender-ஆல் செய்யப்படுகிறது; அது principal
asset மூலம் loan-ஐ fund செய்து position NFTs-ஐ mint செய்கிறது.
Initiation-இல் அதே HF ≥ 1.5 gate. நிலையான APR offer creation-இல்
அமைக்கப்பட்டு loan-இன் வாழ்நாள் முழுவதும் immutable — refinance,
தற்போதைய loan-ஐ மாற்றாமல் புதிய loan-ஐ உருவாக்கும்.

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

Creator எந்தப் பக்கத்தில் இருக்கிறார் என்பதைத் தேர்ந்தெடுக்கிறது:

- **Lender** — lender principal asset-ஐயும், borrower சந்திக்க வேண்டிய
  collateral spec-ஐயும் வழங்குகிறார்.
- **Borrower** — borrower collateral-ஐ முன்கூட்டியே lock செய்கிறார்;
  ஒரு lender accept செய்து fund செய்கிறார்.
- **Rental** sub-type — ERC-4907 (rentable ERC-721) மற்றும் rentable
  ERC-1155 NFTs-க்கு. Debt loan-க்குப் பதிலாக rental flow-க்கு வழிநடத்தப்படுகிறது;
  renter முழு rental cost-ஐயும் (duration × daily fee), கூடவே 5%
  buffer-ஐயும் முன்கூட்டியே செலுத்துகிறார்.

<a id="create-offer.lending-asset"></a>

### Lending Asset

ஒரு debt offer-க்கு, நீங்கள் asset, principal amount, fixed APR, மற்றும்
duration (days-இல்) ஆகியவற்றைக் குறிப்பிடுகிறீர்கள்:

- **Asset** — கடன் கொடுக்கப்படும் / பெறப்படும் ERC-20.
- **Amount** — Principal, asset-இன் native decimals-இல் குறிப்பிடப்படுகிறது.
- **APR** — basis points-இல் (ஒரு சதவிகிதத்தின் நூறில் ஒரு பகுதி)
  fixed annual rate; acceptance-இல் snapshot செய்யப்பட்ட பிறகு reactive
  அல்ல.
- **Days-இல் Duration** — default trigger செய்ய முடியும்முன் உள்ள grace
  window-ஐ அமைக்கும்.

Loan start time-இலிருந்து terminal settlement வரை ஒவ்வொரு second-க்கும்
accrued interest தொடர்ச்சியாக கணக்கிடப்படுகிறது.

<a id="create-offer.lending-asset:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

நீங்கள் வழங்கத் தயாராக உள்ள principal asset மற்றும் amount, கூடவே
interest rate (APR %-இல்) மற்றும் duration (days-இல்). Rate offer
time-இல் fixed; duration loan default ஆகும்முன் உள்ள grace window-ஐ
அமைக்கும். Acceptance-இல், loan initiation-இன் ஒரு பகுதியாக principal
உங்கள் escrow-இலிருந்து borrower-இன் escrow-க்கு நகர்கிறது.

<a id="create-offer.lending-asset:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

நீங்கள் lender-இடமிருந்து விரும்பும் principal asset மற்றும் amount,
கூடவே interest rate (APR %-இல்) மற்றும் duration (days-இல்). Rate offer
time-இல் fixed; duration loan default ஆகும்முன் உள்ள grace window-ஐ
அமைக்கும். உங்கள் collateral offer-creation time-இல் escrow-இல் lock
செய்யப்படுகிறது; lender accept செய்து loan திறக்கும் வரை (அல்லது நீங்கள்
cancel செய்யும் வரை) lock-இல் இருக்கும்.

<a id="create-offer.nft-details"></a>

### NFT Details

Rental-sub-type fields. NFT contract மற்றும் token id-ஐ (ERC-1155-க்கு
quantity-யையும்) குறிப்பிடுகிறது, கூடவே principal asset-இல் daily rental
fee. Acceptance-இல், protocol prepaid rental-ஐ renter-இன் escrow-இலிருந்து
custody-க்கு debit செய்கிறது — duration × daily fee, கூடவே 5% buffer.
NFT delegated state-க்கு நகர்கிறது (ERC-4907 user rights வழியாக, அல்லது
இணையான ERC-1155 rental hook வழியாக), எனவே renter-க்கு rights இருக்கும்,
ஆனால் NFT-ஐ transfer செய்ய முடியாது.

<a id="create-offer.collateral"></a>

### Collateral

Offer-இல் உள்ள collateral asset spec. இரண்டு liquidity classes:

- **Liquid** — பதிவு செய்யப்பட்ட Chainlink price feed மற்றும் தற்போதைய
  tick-இல் ≥ $1M depth கொண்ட குறைந்தபட்சம் ஒரு Uniswap V3 / PancakeSwap V3
  / SushiSwap V3 pool. LTV மற்றும் HF math பொருந்தும்; ஒரு HF-based
  liquidation collateral-ஐ ஒரு 4-DEX failover (0x → 1inch → Uniswap V3
  → Balancer V2) வழியாக route செய்கிறது.
- **Illiquid** — மேற்கூறியதில் தோல்வியடையும் எதுவும். On-chain-இல் $0
  ஆக மதிப்பிடப்படும். HF math இல்லை. Default-இல், முழு collateral-உம்
  lender-க்கு transfer செய்யப்படும். Offer உறுதியாக உருவாக, offer
  creation / acceptance-இல் இரு பக்கங்களும் illiquid-collateral risk-ஐ
  வெளிப்படையாக ஒப்புக்கொள்ள வேண்டும்.

Price oracle-க்கு, primary Chainlink feed-க்கு மேலாக soft 2-of-N decision
rule பயன்படுத்தும் மூன்று independent sources (Tellor, API3, DIA) கொண்ட
secondary quorum உள்ளது. Pyth மதிப்பாய்வு செய்யப்பட்டு ஏற்கப்படவில்லை.

<a id="create-offer.collateral:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

Loan-ஐப் பாதுகாக்க borrower எவ்வளவு lock செய்ய வேண்டும் என்று
நீங்கள் விரும்புகிறீர்கள். Liquid ERC-20s (Chainlink feed + ≥ $1M v3
pool depth) LTV / HF math-ஐப் பெறுகின்றன; illiquid ERC-20s மற்றும்
NFTs-க்கு on-chain valuation இல்லை, மேலும் full-collateral-on-default
outcome-ஐ இரு parties-களும் ஏற்க வேண்டும். Loan initiation-இல் HF ≥
1.5 gate, acceptance-இல் borrower வழங்கும் collateral basket-க்கு எதிராக
கணக்கிடப்படுகிறது — இங்கே requirement-ஐ அமைப்பது borrower-இன் HF
headroom-ஐ நேரடியாக நிர்ணயிக்கும்.

<a id="create-offer.collateral:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

Loan-ஐப் பாதுகாக்க நீங்கள் எவ்வளவு lock செய்யத் தயாராக உள்ளீர்கள்.
Liquid ERC-20s (Chainlink feed + ≥ $1M v3 pool depth) LTV / HF math-ஐப்
பெறுகின்றன; illiquid ERC-20s மற்றும் NFTs-க்கு on-chain valuation இல்லை,
மேலும் full-collateral-on-default outcome-ஐ இரு parties-களும் ஏற்க
வேண்டும். borrower offer-இல், உங்கள் collateral offer-creation time-இல்
escrow-இல் lock செய்யப்படுகிறது; lender offer-இல், offer-acceptance
time-இல் lock செய்யப்படுகிறது. எப்படியிருந்தாலும், நீங்கள் வழங்கும்
basket மூலம் loan initiation-இல் HF ≥ 1.5 gate clear ஆக வேண்டும்.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Submit செய்வதற்கு முன் வரும் acknowledgement gate இது. அதே risk surface
இரு பக்கங்களுக்கும் பொருந்தும்; கீழே உள்ள role-specific tabs, நீங்கள்
offer-இன் எந்தப் பக்கத்தில் sign செய்கிறீர்கள் என்பதன்படி ஒவ்வொரு risk
எப்படி வேறுபட்டு தாக்குகிறது என்பதை விளக்குகின்றன. Vaipakam
non-custodial: chain-இல் உறுதியாகிவிட்ட transaction-ஐ மாற்றக் கூடிய
admin key இல்லை. Pause levers cross-chain-facing contracts-களில் மட்டுமே
உள்ளன; அவை timelock-க்குக் கட்டுப்பட்டவை, assets-ஐ நகர்த்த முடியாது.

<a id="create-offer.risk-disclosures:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

- **Smart-contract risk** — contract code runtime-இல் immutable; audit
  செய்யப்பட்டிருக்கிறது, ஆனால் formally verified இல்லை.
- **Oracle risk** — Chainlink staleness அல்லது pool-depth divergence,
  collateral, principal-ஐ மறைக்கும் புள்ளியைத் தாண்டும் வரை HF-based
  liquidation-ஐத் தாமதப்படுத்தும். Secondary quorum (Tellor + API3 +
  DIA, soft 2-of-N) பெரிய drift-ஐப் பிடிக்கும்; ஆனால் சிறிய skew இன்னும்
  recovery-ஐ குறைக்கலாம்.
- **Liquidation slippage** — 4-DEX failover சாத்தியமான சிறந்த
  execution-க்கு route செய்கிறது, ஆனால் குறிப்பிட்ட விலையை
  உத்தரவாதம் செய்ய முடியாது. Recovery, slippage மற்றும் interest-இன்
  மீதான 1% treasury cut-க்குப் பிறகுதான்.
- **Illiquid-collateral defaults** — default time-இல் collateral
  உங்களுக்கு முழுமையாக transfer ஆகிறது. Asset-இன் மதிப்பு principal
  கூடவே accrued interest-ஐ விட குறைவாக இருந்தால் உங்களுக்கு recourse
  இல்லை.

<a id="create-offer.risk-disclosures:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

- **Smart-contract risk** — contract code runtime-இல் immutable; bugs
  locked collateral-ஐப் பாதிக்கலாம்.
- **Oracle risk** — staleness அல்லது manipulation, real-market price
  பாதுகாப்பாக இருக்கும் போது உங்களுக்கு எதிராக HF-based liquidation-ஐத்
  தூண்டலாம். HF formula oracle output-க்கு react ஆகிறது; 1.0-ஐ
  தாண்டும் ஒரே ஒரு bad tick போதும்.
- **Liquidation slippage** — liquidation fire ஆகும்போது, swap உங்கள்
  collateral-ஐ slippage-ஆல் பாதிக்கப்பட்ட விலையில் விற்கலாம். Swap
  permissionless — உங்கள் HF 1.0-க்குக் கீழே drop ஆகும் கணத்தில் யாரும்
  trigger செய்யலாம்.
- **Illiquid-collateral defaults** — Default உங்கள் முழு collateral-ஐ
  lender-க்கு transfer செய்கிறது. Leftover claim இல்லை; எஞ்சியுள்ள
  unused VPFI Loan Initiation Fee rebate மட்டும் claim time-இல்
  borrower-ஆக சேகரிக்க முடியும்.

<a id="create-offer.advanced-options"></a>

### Advanced Options

அரிதாகத் தேவைப்படும் knobs:

- **Expiry** — இந்த timestamp-க்குப் பிறகு offer தானாக cancel
  ஆகிறது. Default ≈ 7 days.
- **Use fee discount for this offer** — இந்த குறிப்பிட்ட offer-க்கு
  wallet-level fee-discount consent-இன் local override.
- Offer creation flow-ஆல் வெளிப்படுத்தப்பட்ட side-specific options.

பெரும்பாலான பயனர்களுக்கு defaults பொருத்தமானவை.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims வடிவமைப்பில் pull-style — terminal events funds-ஐ protocol
custody-இல் விட்டுவிடும்; position NFT holder அவற்றை நகர்த்த claim call
செய்கிறார். இரண்டு வகையான claims ஒரே wallet-இல் ஒரே நேரத்தில் இருக்கலாம்.
கீழே உள்ள role-specific tabs ஒவ்வொன்றையும் விளக்குகின்றன.

ஒவ்வொரு claim-வும் holder-இன் position NFT-ஐ atomically burn செய்கிறது.
NFT *தான்* bearer instrument — claim செய்வதற்கு முன் அதை transfer
செய்தால், collect செய்யும் உரிமை புதிய holder-க்கு செல்கிறது.

<a id="claim-center.claims:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

Lender claim திருப்பித் தருவது:

- இந்த chain-இல் உங்கள் principal மீண்டும் wallet-க்கு.
- Accrued interest minus 1% treasury cut. Consent on ஆக இருக்கும்போது
  cut-ஐ உங்கள் time-weighted VPFI fee-discount accumulator குறைக்கிறது.

Loan terminal state-ஐ (Settled, Defaulted, அல்லது Liquidated) எட்டியவுடன்
claimable. Lender position NFT அதே transaction-இல் burn செய்யப்படும்.

<a id="claim-center.claims:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

Loan எவ்வாறு settle ஆனது என்பதைப் பொறுத்து borrower claim திருப்பித்
தருவது:

- **Full repayment / preclose / refinance** — உங்கள் collateral basket
  திரும்ப, கூடவே Loan Initiation Fee-இலிருந்து time-weighted VPFI
  rebate.
- **HF-liquidation அல்லது default** — unused VPFI Loan Initiation Fee
  rebate மட்டும்; இந்த terminal paths-களில் explicitly preserve
  செய்யப்படாவிட்டால் அது zero ஆகும். Collateral ஏற்கனவே lender-க்கு
  நகர்ந்திருக்கும்.

Borrower position NFT அதே transaction-இல் burn செய்யப்படும்.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

Active chain-இல் உங்கள் wallet தொடர்புடைய on-chain events, sliding block
window-இல் protocol logs-இலிருந்து live ஆக sourced. Backend cache இல்லை —
ஒவ்வொரு page load-உம் re-fetch செய்கிறது. Multi-event transactions
(உதாரணமாக, ஒரே block-இல் உறுதியாகும் accept + initiate) ஒன்றாகத்
தெரிய, events transaction hash மூலம் group செய்யப்படுகின்றன. Newest
first. Offers, loans, repayments, claims, liquidations, NFT mints மற்றும்
burns, VPFI buys / stakes / unstakes ஆகியவை காட்டப்படும்.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI வாங்குதல்

இரண்டு paths:

- **Canonical (Base)** — Protocol-இல் canonical buy flow-க்கு நேரடி
  call. Base-இல் உங்கள் wallet-க்கு VPFI-ஐ நேரடியாக mint செய்கிறது.
- **Off-canonical** — Local-chain buy adapter Base-இல் canonical
  receiver-க்கு ஒரு LayerZero packet அனுப்புகிறது, அது Base-இல் buy-ஐ
  செய்து cross-chain token standard வழியாக result-ஐ திருப்பி bridge
  செய்கிறது. End-to-end latency L2-to-L2 pairs-களில் ≈ 1 minute. VPFI
  உங்கள் **origin** chain-இல் உங்கள் wallet-க்கு வந்து சேருகிறது.

Adapter rate limits (post-hardening): ஒரு request-க்கு 50,000 VPFI
மற்றும் rolling 24 hours-இல் 500,000 VPFI. Timelock வழியாக governance-ஆல்
tunable.

<a id="buy-vpfi.discount-status"></a>

### உங்கள் VPFI Discount Status

Live status:

- தற்போதைய tier (0 முதல் 4 வரை).
- Escrow VPFI balance கூடவே அடுத்த tier-க்கான gap.
- தற்போதைய tier-இல் Discount percentage.
- Wallet-level consent flag.

Escrow VPFI staking pool வழியாக 5% APR-ஐயும் accrue செய்கிறது என்பதை
கவனியுங்கள் — தனி "stake" action இல்லை. VPFI-ஐ உங்கள் escrow-க்கு
deposit செய்வதே staking.

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH-உடன் VPFI வாங்கு

Buy-ஐ submit செய்கிறது. Canonical chain-இல், protocol நேரடியாக mint
செய்கிறது. Mirror chains-களில், buy adapter payment எடுத்து cross-chain
message அனுப்புகிறது; receiver Base-இல் buy-ஐ execute செய்து VPFI-ஐ
திரும்ப bridge செய்கிறது. Bridge fee மற்றும் verifier-network cost live
ஆக quote செய்யப்பட்டு form-இல் காட்டப்படும். VPFI தானாக உங்கள் escrow-க்கு
deposit ஆகாது — Step 2 design-ஆல் வெளிப்படையான user action.

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI-ஐ உங்கள் escrow-க்கு deposit செய்யுங்கள்

உங்கள் wallet-இலிருந்து அதே chain-இல் உள்ள escrow-க்கு தனியான explicit
deposit step. Spec-இன் படி escrow deposit எப்போதும் explicit user action
ஆகவே இருக்க வேண்டும்; எனவே ஒவ்வொரு chain-இலும் — canonical-இலும் கூட —
இது தேவை. Permit2 configure செய்யப்பட்ட chains-களில், App classic approve
+ deposit pattern-க்கு பதிலாக single-signature path-ஐ விரும்புகிறது; அந்த
chain-இல் Permit2 configure செய்யப்படவில்லை என்றால் gracefully fall back
ஆகும்.

<a id="buy-vpfi.unstake"></a>

### Step 3 — உங்கள் escrow-இலிருந்து VPFI-ஐ unstake செய்யுங்கள்

VPFI-ஐ உங்கள் escrow-இலிருந்து மீண்டும் wallet-க்கு withdraw செய்யுங்கள்.
தனி approval leg இல்லை — Protocol escrow-ஐ வைத்திருக்கிறது மற்றும்
தன்னையே debit செய்கிறது. Withdraw, நீங்கள் ஈடுபட்டுள்ள ஒவ்வொரு open
loan-க்கும் புதிய (குறைந்த) balance அடிப்படையில் உடனடி fee-discount rate
re-stamp-ஐத் தூண்டும். பழைய tier தொடரும் grace window இல்லை.

---

## Rewards

<a id="rewards.overview"></a>

### Rewards பற்றி

இரண்டு streams:

- **Staking pool** — Escrow வசம் உள்ள VPFI 5% APR-இல் தொடர்ச்சியாக
  accrue ஆகிறது, per-second compounding-உடன்.
- **Interaction pool** — ஒரு நிலையான daily emission-இன் per-day
  pro-rata share, அந்த நாளின் loan volume-க்கு உங்கள் settled-interest
  பங்களிப்பால் weighted. Window close-க்குப் பிறகு முதல் claim அல்லது
  settlement-இல் daily windows lazy ஆக finalise ஆகின்றன.

இரண்டு streams-களும் active chain-இல் நேரடியாக mint செய்யப்படுகின்றன —
பயனருக்கு cross-chain round-trip இல்லை. Cross-chain reward aggregation
protocol contracts-களுக்குள் மட்டுமே நடக்கும்.

<a id="rewards.claim"></a>

### Rewards Claim செய்யுங்கள்

ஒரே transaction இரண்டு streams-களையும் ஒரே நேரத்தில் claim செய்கிறது.
Staking rewards எப்போதும் கிடைக்கும்; relevant daily window finalise
ஆகும் வரை interaction rewards zero (அந்த chain-இல் அடுத்த non-zero
claim அல்லது settlement தூண்டும் lazy finalisation வரை). Window இன்னும்
finalise ஆகிக் கொண்டிருக்கும்போது UI button-ஐ guard செய்கிறது, எனவே
பயனர்கள் under-claim செய்வதில்லை.

<a id="rewards.withdraw-staked"></a>

### Staked VPFI-ஐ Withdraw செய்யுங்கள்

Buy VPFI page-இல் "Step 3 — Unstake"-க்கு இணையான surface — Escrow-இலிருந்து
மீண்டும் wallet-க்கு VPFI withdraw செய்யுங்கள். Withdrawn VPFI staking
pool-ஐ உடனடியாக விட்டு வெளியேறும் (அந்த amount-க்கு rewards accrue ஆவது
அந்த block-இல் நிற்கும்) மற்றும் discount accumulator-இலிருந்தும் உடனடியாக
வெளியேறும் (ஒவ்வொரு open loan-இல் post-balance re-stamp).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (இந்த page)

Protocol-இலிருந்து live ஆக derive செய்யப்பட்ட single-loan view, கூடவே
risk engine-இலிருந்து live HF மற்றும் LTV. Terms, collateral risk,
parties, உங்கள் role மற்றும் loan-இன் status-ஆல் கட்டுப்படுத்தப்பட்ட
action surface, inline keeper status ஆகியவற்றை render செய்கிறது.

<a id="loan-details.terms"></a>

### Loan Terms

Loan-இன் immutable parts:

- Principal (asset மற்றும் amount).
- APR (offer creation-இல் fixed).
- Days-இல் Duration.
- Start time மற்றும் end time (start time + duration).
- Start-இலிருந்து கடந்த seconds அடிப்படையில் live ஆக கணக்கிடப்பட்ட Accrued
  interest.

Refinance, இந்த values-ஐ மாற்றாமல் ஒரு புதிய loan-ஐ உருவாக்குகிறது.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

Live risk math:

- **Health Factor** = (collateral USD value × liquidation threshold) /
  debt USD value. HF 1.0-க்குக் கீழே சென்றால், position liquidatable
  ஆகும்.
- **LTV** = debt USD value / collateral USD value.
- **Liquidation threshold** = position liquidatable ஆகும் LTV;
  collateral basket-இன் volatility class-ஐப் பொறுத்தது. High-volatility
  collapse trigger 110% LTV.

Illiquid collateral-க்கு zero on-chain USD value உள்ளது; HF மற்றும் LTV
"n/a" ஆகும். ஒரே terminal path default-இல் முழு collateral transfer —
இரு parties-களும் illiquid-risk acknowledgement வழியாக offer creation-இல்
consent தந்துள்ளனர்.

<a id="loan-details.collateral-risk:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

இந்த loan-ஐப் பாதுகாக்கும் collateral basket-தான் உங்கள் பாதுகாப்பு.
HF 1.0-க்கு மேல் இருந்தால், position liquidation threshold-க்கு ஒப்பிடும்போது
over-collateralised. HF 1.0-ஐ நோக்கி drift ஆகும்போது, உங்கள் பாதுகாப்பு
மெலிதாகிறது. HF 1.0-க்குக் கீழே சென்றவுடன், யாரும் (நீங்களும் சேர்த்து)
liquidate call செய்யலாம்; protocol 4-DEX failover வழியாக collateral-ஐ
உங்கள் principal asset-க்கு route செய்கிறது. Recovery slippage-க்குப்
பிறகே கிடைக்கும்.

Illiquid collateral-க்கு, default-இல் basket default time-இல் உங்களுக்கு
முழுமையாக transfer ஆகிறது — open market-இல் அதன் உண்மையான மதிப்பு
எதுவாக இருந்தாலும் அதை நீங்கள் ஏற்க வேண்டும்.

<a id="loan-details.collateral-risk:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

இது உங்கள் locked collateral. HF-ஐ 1.0-க்கு மேல் பாதுகாப்பாக வைத்திருங்கள் —
volatility-ஐத் தாங்க பொதுவான buffer target 1.5. HF-ஐ உயர்த்தும்
levers:

- **Add collateral** — Basket-ஐ top up செய்யுங்கள். User-only action.
- **Partial repay** — Debt-ஐக் குறைக்கிறது, HF-ஐ உயர்த்துகிறது.

HF 1.0-க்குக் கீழே சென்றவுடன், யாரும் HF-based liquidation-ஐ trigger
செய்யலாம்; swap உங்கள் collateral-ஐ slippage-ஆல் பாதிக்கப்பட்ட விலையில்
விற்று lender-க்கு திருப்பிச் செலுத்தும். Illiquid collateral-இல்,
default உங்கள் முழு collateral-ஐ lender-க்கு transfer செய்கிறது — claim
செய்ய உங்களுக்கு unused VPFI Loan Initiation Fee rebate மட்டுமே மீதியாகும்.

<a id="loan-details.parties"></a>

### Parties

Lender, borrower, lender escrow, borrower escrow, மற்றும் இரண்டு position
NFTs (ஒவ்வொரு பக்கத்திற்கும் ஒன்று). ஒவ்வொரு NFT-யும் on-chain metadata
கொண்ட ERC-721; அதை transfer செய்வது claim உரிமையையும் transfer செய்கிறது.
Escrow contracts ஒரு address-க்கு deterministic — deploys-களில் அதே address.

<a id="loan-details.actions"></a>

### Actions

Action surface protocol-ஆல் role அடிப்படையில் gated. கீழே உள்ள
role-specific tabs ஒவ்வொரு பக்கத்துக்கும் கிடைக்கும் actions-ஐ
பட்டியலிடுகின்றன. Disabled actions, gate-இலிருந்து derive செய்யப்பட்ட
hover-reason-ஐ காட்டும் ("Insufficient HF", "Not yet expired", "Loan
locked" போன்றவை).

Role-ஐப் பொருட்படுத்தாமல் யாரும் செய்யக்கூடிய permissionless actions:

- **Trigger liquidation** — HF 1.0-க்குக் கீழே drop ஆகும்போது.
- **Mark defaulted** — Full repayment இல்லாமல் grace period முடிவடைந்தபோது.

<a id="loan-details.actions:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

- **Claim as lender** — Terminal-only. Principal மற்றும் interest minus
  1% treasury cut-ஐ திருப்பித் தருகிறது (consent on ஆக இருக்கும்போது
  உங்கள் time-weighted VPFI yield-fee discount-ஆல் மேலும் குறையும்).
  Lender position NFT-ஐ burn செய்கிறது.
- **Initiate early withdrawal** — asking price-இல் lender position NFT-ஐ
  விற்பனைக்கு list செய்கிறது. விற்பனையை நிறைவு செய்யும் buyer உங்கள்
  பக்கத்தை எடுத்துக்கொள்கிறார்; நீங்கள் proceeds-ஐப் பெறுகிறீர்கள்.
  விற்பனை fill ஆவதற்கு முன் cancellable.
- Relevant action permission வைத்திருக்கும் ஒரு keeper-க்கு optional-ஆக
  delegatable — Keeper Settings-ஐப் பார்க்கவும்.

<a id="loan-details.actions:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

- **Repay** — Full அல்லது partial. Partial repayment outstanding-ஐக் குறைத்து
  HF-ஐ உயர்த்துகிறது; full terminal settlement-ஐத் தூண்டுகிறது,
  time-weighted VPFI Loan Initiation Fee rebate உட்பட.
- **Preclose direct** — இப்போது உங்கள் wallet-இலிருந்து outstanding
  amount-ஐ செலுத்துங்கள், collateral-ஐ release செய்யுங்கள், rebate-ஐ
  settle செய்யுங்கள்.
- **Preclose offset** — Protocol-இன் swap router வழியாக சில collateral-ஐ
  விற்று, proceeds-இலிருந்து திருப்பிச் செலுத்தி, மீதியை திருப்பித்
  தருகிறது. Two-step: initiate, பிறகு complete.
- **Refinance** — புதிய terms-க்கு ஒரு borrower offer post செய்யுங்கள்;
  ஒரு lender accept செய்தவுடன், complete refinance, collateral உங்கள்
  escrow-ஐ விட்டு வெளியேறாமல் loans-ஐ atomically swap செய்கிறது.
- **Claim as borrower** — Terminal-only. Full repayment-இல் collateral-ஐ,
  அல்லது default / liquidation-இல் unused VPFI Loan Initiation Fee
  rebate-ஐ திருப்பித் தருகிறது. Borrower position NFT-ஐ burn செய்கிறது.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

இந்த chain-இல் உங்கள் wallet protocol-க்கு வழங்கிய ஒவ்வொரு ERC-20
allowance-ஐயும் பட்டியலிடுகிறது. On-chain allowance views-க்கு எதிராக
candidate-token list-ஐ scan செய்வதன் மூலம் sourced. Revoking allowance-ஐ
zero-ஆக அமைக்கும்.

Exact-amount approval policy-இன் படி, protocol ஒருபோதும் unlimited
allowances-ஐ கேட்காது; எனவே வழக்கமான revocation list குறுகியது.

குறிப்பு: Permit2-style flows ஒரே signature-ஐப் பயன்படுத்தி protocol-இல்
per-asset allowance-ஐத் தவிர்க்கின்றன. எனவே இங்கே clean list இருந்தாலும்
எதிர்கால deposits தடுக்கப்படாது.

---

## Alerts

<a id="alerts.overview"></a>

### Alerts பற்றி

ஒரு off-chain watcher, உங்கள் wallet தொடர்புடைய ஒவ்வொரு active loan-ஐயும்
5-minute cadence-இல் poll செய்கிறது, ஒவ்வொன்றுக்கும் live Health Factor-ஐ
படிக்கிறது, unsafe direction-இல் band crossing ஏற்பட்டால் configured
channels வழியாக ஒருமுறை fire ஆகிறது. On-chain state இல்லை, gas இல்லை.
Alerts advisory — அவை funds-ஐ நகர்த்தாது.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

User-configured HF bands-இன் ladder. அதிக ஆபத்துள்ள band-க்குள் crossing
ஒரு முறை fire ஆகி அடுத்த deeper threshold-ஐ arm செய்கிறது; மீண்டும்
மேலுள்ள band-க்கு திரும்பினால் அது re-arm ஆகும். Defaults: 1.5 → 1.3
→ 1.1. Volatile collateral-க்கு உயர்ந்த எண்கள் பொருத்தமானவை. Ladder-இன்
ஒரே வேலை, HF 1.0-க்குக் கீழே drop ஆகி liquidation trigger ஆகும்முன்
உங்களுக்கு வெளியேறும் வாய்ப்பு தருவது.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

இரண்டு rails:

- **Telegram** — Wallet-இன் short address, loan id, மற்றும் தற்போதைய
  HF-உடன் bot direct message.
- **Push Protocol** — Vaipakam Push channel வழியாக wallet-direct
  notification.

இரண்டும் threshold ladder-ஐப் பகிர்ந்து கொள்கின்றன; drift-ஐத் தவிர்க்க
per-channel warning levels வேண்டுமென்றே வெளிப்படுத்தப்படவில்லை. Push
channel publishing தற்போது channel creation-க்காக காத்திருப்பதால் stub
செய்யப்பட்டுள்ளது.

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### ஒரு NFT-ஐ Verify செய்யுங்கள்

NFT contract address மற்றும் token id கொடுக்கப்பட்டால், verifier fetch
செய்வது:

- Token ஏற்கனவே burn செய்யப்பட்டிருந்தால் தற்போதைய owner (அல்லது
  ஒரு burn signal).
- On-chain JSON metadata.
- ஒரு protocol cross-check: metadata-இலிருந்து underlying loan id-ஐ
  derive செய்து state-ஐ உறுதிப்படுத்த protocol-இலிருந்து loan
  details-ஐப் படிக்கிறது.

இது வெளிப்படுத்துவது: Vaipakam-ஆல் mint செய்யப்பட்டதா? எந்த chain?
loan status? தற்போதைய holder? counterfeit NFT, ஏற்கனவே claim செய்யப்பட்ட
(burned) position, அல்லது loan settle ஆகி claimable நிலையில் இருக்கும்
position ஆகியவற்றைக் கண்டறிய உதவும்.

Position NFT bearer instrument — secondary market-இல் வாங்குவதற்கு முன்
verify செய்யுங்கள்.

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers பற்றி

5 keepers வரை கொண்ட per-wallet keeper whitelist. ஒவ்வொரு keeper-க்கும்
**உங்கள் பக்கத்தில்** loan-இல் குறிப்பிட்ட maintenance calls-ஐ authorise
செய்யும் action permission set இருக்கும். Money-out paths (repay, claim,
add collateral, liquidate) design-ஆல் user-only; delegate செய்ய முடியாது.

Action time-இல் இரண்டு கூடுதல் gates பொருந்தும்:

1. Master keeper-access switch — allowlist-ஐத் தொடாமல் ஒவ்வொரு keeper-ஐயும்
   disable செய்யும் one-flip emergency brake.
2. Offer Book அல்லது Loan Details surface-இல் அமைக்கப்பட்ட per-loan
   opt-in toggle.

ஒரு keeper, நான்கு நிபந்தனைகளும் true ஆக இருக்கும்போது மட்டுமே act செய்ய
முடியும்: approved, master switch on, per-loan toggle on, மற்றும் அந்த
keeper-க்கு குறிப்பிட்ட action permission set.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

தற்போது வெளிப்படுத்தப்பட்ட Action permissions:

- **Complete loan sale** (lender side, secondary-market exit).
- **Complete offset** (borrower side, collateral sale வழியாக preclose-இன்
  இரண்டாவது leg).
- **Initiate early withdrawal** (lender side, position-ஐ விற்பனைக்கு
  list செய்).
- **Initiate preclose** (borrower side, preclose flow-ஐ kick off செய்).
- **Refinance** (borrower side, ஒரு புதிய borrower offer-இல் atomic
  loan swap).

Frontend இன்னும் reflect செய்யாத on-chain permissions சேர்க்கப்பட்டால்,
அவை தெளிவான "invalid permission" revert-ஐப் பெறும். Revocation அனைத்து
loans-களிலும் உடனடி — காத்திருப்புக் காலம் இல்லை.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics பற்றி

ஆதரிக்கப்படும் ஒவ்வொரு chain-இலும் on-chain protocol view calls-இலிருந்து
live ஆக கணக்கிடப்படும் wallet-free aggregator. Backend இல்லை, database
இல்லை. CSV / JSON export கிடைக்கும்; verifiability-க்காக protocol address
மற்றும் ஒவ்வொரு metric-ஐ backing செய்யும் view function காட்டப்படும்.

<a id="public-dashboard.combined"></a>

### Combined — அனைத்து Chains

Cross-chain rollup. எத்தனை chains cover செய்யப்பட்டன, எத்தனை error ஆனது
என்பதை header report செய்கிறது; எனவே fetch time-இல் unreachable RPC
இருந்தால் அது explicit. ஒன்று அல்லது அதற்கு மேற்பட்ட chains error ஆனால்,
per-chain table எது என்பதை குறிக்கும் — TVL totals இன்னும் report
செய்யப்படும், ஆனால் gap தெளிவாக ஒப்புக்கொள்ளப்படும்.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

Combined metrics-இன் per-chain split. TVL concentration, mismatched VPFI
mirror supplies (mirror supplies-இன் கூட்டுத்தொகை canonical adapter-இன்
locked balance-க்கு சமமாக இருக்க வேண்டும்), அல்லது stalled chains-ஐக்
கண்டறிய உதவும்.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

Active chain-இல் on-chain VPFI accounting:

- ERC-20-இலிருந்து நேரடியாக படிக்கப்பட்ட Total supply.
- Circulating supply — Total supply minus protocol வசம் உள்ள balances
  (treasury, reward pools, in-flight bridge packets).
- மீதமுள்ள mintable cap — canonical chain-இல் மட்டுமே அர்த்தமுள்ளது;
  mirror chains cap-க்கு "n/a" report செய்கின்றன, ஏனெனில் அங்கு mints
  bridge-driven, cap-இலிருந்து mint செய்யப்படவில்லை.

Cross-chain invariant: அனைத்து mirror chains-களின் mirror supplies
கூட்டுத்தொகை canonical adapter-இன் locked balance-க்கு சமம். watcher இதை
கண்காணித்து drift ஏற்பட்டால் alert அனுப்புகிறது.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

ஒவ்வொரு metric-க்கும் page காட்டுவது:

- Snapshot-ஆகப் பயன்படுத்தப்பட்ட block number.
- Data freshness (chains-களில் max staleness).
- Protocol address மற்றும் view function call.

இந்த page-இல் உள்ள எந்த எண்ணையும் RPC + block + protocol address +
function name-இலிருந்து யாரும் re-derive செய்யலாம் — அதுதான் தரநிலை.

---

## Refinance

இந்த page borrower-only — Refinance, borrower-இன் loan-இல் borrower-ஆல்
initiate செய்யப்படுகிறது.

<a id="refinance.overview"></a>

### Refinancing பற்றி

Refinance, புதிய principal-இலிருந்து உங்கள் தற்போதைய loan-ஐ atomically
pay off செய்து, புதிய terms-உடன் புதிய loan-ஐ திறக்கும் — எல்லாம் ஒரே
transaction-இல். Collateral முழுவதும் உங்கள் escrow-இலேயே தங்கும் —
unsecured window இல்லை. மற்ற எந்த loan போலவே, புதிய loan initiation-இல்
HF ≥ 1.5 gate clear ஆக வேண்டும்.

பழைய loan-இன் unused Loan Initiation Fee rebate, swap-இன் ஒரு பகுதியாக
சரியாக settle செய்யப்படும்.

<a id="refinance.position-summary"></a>

### உங்கள் தற்போதைய Position

Refinance செய்யப்படும் loan-இன் snapshot — தற்போதைய principal, இதுவரை
accrued interest, HF / LTV, மற்றும் collateral basket. புதிய offer
குறைந்தபட்சம் outstanding amount-ஐ (principal + accrued interest) size
செய்ய வேண்டும்; புதிய offer-இல் excess ஏதேனும் இருந்தால் அது free
principal-ஆக உங்கள் escrow-க்கு வழங்கப்படும்.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — புதிய Offer-ஐ Post செய்யுங்கள்

உங்கள் target terms-உடன் borrower offer post செய்கிறது. நீங்கள்
காத்திருக்கும்போது பழைய loan interest accrue செய்யத் தொடரும்; collateral
lock-ஆகவே இருக்கும். Offer public Offer Book-இல் தோன்றும், எந்த lender-உம்
accept செய்யலாம். Acceptance-க்கு முன் cancel செய்யலாம்.

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

புதிய lender accept செய்த பிறகு atomic settlement:

1. Accepting lender-இலிருந்து புதிய loan-ஐ fund செய்கிறது.
2. பழைய loan-ஐ முழுமையாக repay செய்கிறது (principal + interest, treasury
   cut கழித்து).
3. பழைய position NFTs-ஐ burn செய்கிறது.
4. புதிய position NFTs-ஐ mint செய்கிறது.
5. பழைய loan-இன் unused Loan Initiation Fee rebate-ஐ settle செய்கிறது.

புதிய terms-இல் HF 1.5-க்குக் கீழே இருந்தால் revert ஆகிறது.

---

## Preclose

இந்த page borrower-only — Preclose, borrower-இன் loan-இல் borrower-ஆல்
initiate செய்யப்படுகிறது.

<a id="preclose.overview"></a>

### Preclose பற்றி

Borrower-driven early termination. இரண்டு paths:

- **Direct** — உங்கள் wallet-இலிருந்து outstanding amount (principal
  + accrued interest)-ஐ செலுத்துங்கள், collateral-ஐ release செய்யுங்கள்,
  unused Loan Initiation Fee rebate-ஐ settle செய்யுங்கள்.
- **Offset** — Principal asset-க்கான protocol-இன் 4-DEX swap failover
  வழியாக collateral-இன் ஒரு பகுதியை விற்க offset-ஐ initiate செய்யுங்கள்;
  proceeds-இலிருந்து repay செய்ய offset-ஐ complete செய்யுங்கள்; collateral
  மீதம் இருந்தால் அது உங்களுக்குத் திரும்பும். அதே rebate settlement.

Flat early-close penalty இல்லை. Time-weighted VPFI math fairness-ஐ
கையாளுகிறது.

<a id="preclose.position-summary"></a>

### உங்கள் தற்போதைய Position

Preclose செய்யப்படும் loan-இன் snapshot — outstanding principal, accrued
interest, தற்போதைய HF / LTV. Preclose flow exit-இல் HF ≥ 1.5
**தேவையில்லை** (இது closure, re-init அல்ல).

<a id="preclose.in-progress"></a>

### Offset In Progress

State: offset initiate செய்யப்பட்டுள்ளது; swap mid-execution-இல் உள்ளது
(அல்லது quote consume செய்யப்பட்டுள்ளது, ஆனால் final settle pending).
இரண்டு exits:

- **Complete offset** — realised proceeds-இலிருந்து loan-ஐ settle
  செய்கிறது, மீதியைத் திருப்பித் தருகிறது.
- **Cancel offset** — Aborts; collateral lock-ஆகவே இருக்கிறது, loan
  மாறாது. Initiate மற்றும் complete-க்கு இடையே swap உங்களுக்கு எதிராக
  நகர்ந்தபோது இதைப் பயன்படுத்துங்கள்.

<a id="preclose.choose-path"></a>

### ஒரு Path-ஐத் தேர்ந்தெடுக்கவும்

Direct path principal asset-இல் wallet liquidity-ஐ consume செய்கிறது.
Offset path DEX swap வழியாக collateral-ஐ consume செய்கிறது; உங்களிடம்
principal asset கையில் இல்லாதபோது அல்லது collateral position-இலிருந்தும்
exit செய்ய விரும்பினால் இது preferred. Offset slippage, liquidations-க்கு
பயன்படுத்தப்படும் அதே 4-DEX failover-ஆல் (0x → 1inch → Uniswap V3 →
Balancer V2) bound செய்யப்படுகிறது.

---

## Early Withdrawal (Lender)

இந்த page lender-only — Early withdrawal, lender-இன் loan-இல் lender-ஆல்
initiate செய்யப்படுகிறது.

<a id="early-withdrawal.overview"></a>

### Lender Early Exit பற்றி

Lender positions-களுக்கான secondary-market mechanism. நீங்கள் தேர்ந்தெடுத்த
விலையில் உங்கள் position NFT-ஐ விற்பனைக்கு list செய்கிறீர்கள்; acceptance-இல்,
buyer pay செய்கிறார், lender NFT-இன் ownership buyer-க்கு transfer ஆகிறது,
மற்றும் எதிர்கால settlement-களுக்கு (terminal-இல் claim போன்றவை) buyer
lender of record ஆகிறார். நீங்கள் sale proceeds-உடன் வெளியேறுகிறீர்கள்.

Liquidations user-only-ஆகவே இருக்கும்; sale வழியாக delegate செய்யப்படாது
— claim செய்யும் உரிமை மட்டுமே transfer ஆகும்.

<a id="early-withdrawal.position-summary"></a>

### உங்கள் தற்போதைய Position

Snapshot — outstanding principal, accrued interest, மீதமுள்ள நேரம்,
borrower side-இன் தற்போதைய HF / LTV. buyer market எதிர்பார்க்கும் fair
price-ஐ அமைக்கும் முக்கிய எண்கள் இவை: buyer-இன் payoff terminal-இல்
principal மற்றும் interest, மீதமுள்ள நேரத்தின் liquidation risk-ஐக் கழித்து.

<a id="early-withdrawal.initiate-sale"></a>

### Sale-ஐ Initiate செய்யுங்கள்

உங்கள் asking price-இல் protocol வழியாக position NFT-ஐ விற்பனைக்கு list
செய்கிறது. buyer sale-ஐ complete செய்கிறார்; sale fill ஆகும்முன் நீங்கள்
cancel செய்யலாம். "Complete loan sale" permission வைத்திருக்கும் keeper-க்கு
optional-ஆக delegatable; initiate step user-only-ஆகவே இருக்கும்.
