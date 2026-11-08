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

<a id="chapter.dashboard"></a>

## Dashboard

<a id="dashboard.your-vault"></a>

### உங்கள் Vault

ஒரு upgradeable per-user contract — இந்த chain-இல் உங்கள் தனிப்பட்ட
vault — நீங்கள் முதன்முதலில் loan-இல் பங்கேற்கும்போது உங்களுக்காக
உருவாக்கப்படுகிறது. ஒரு address-க்கு, ஒரு chain-க்கு ஒரு vault.
உங்கள் loan positions-உடன் இணைக்கப்பட்ட ERC-20, ERC-721, மற்றும்
ERC-1155 balances-ஐ இது வைத்திருக்கும். கலப்பு (commingling) இல்லை:
மற்ற பயனர்களின் assets இந்த contract-இல் ஒருபோதும் இருக்காது.

Vault என்பது collateral, கடனாக வழங்கப்பட்ட assets, மற்றும் உங்கள்
locked VPFI இருக்கும் இடம். ஒவ்வொரு deposit மற்றும் withdrawal-க்கும்
protocol இதையே சரிபார்க்கிறது. Implementation-ஐ protocol owner upgrade
செய்ய முடியும், ஆனால் timelock வழியாக மட்டுமே — உடனடி upgrade
ஒருபோதும் இல்லை.

<a id="dashboard.your-loans"></a>

### உங்கள் Loans

இந்த chain-இல் இணைக்கப்பட்ட wallet தொடர்புடைய ஒவ்வொரு loan-மும் —
நீங்கள் lender பக்கத்தில் இருந்தாலும், borrower பக்கத்தில்
இருந்தாலும், அல்லது வெவ்வேறு positions-இல் இரு பக்கங்களிலும் இருந்தாலும்.
உங்கள் address-க்கு எதிராக protocol-இன் view methods-இலிருந்து live ஆக
கணக்கிடப்படுகிறது. ஒவ்வொரு row-வும் HF, LTV, accrued interest, உங்கள்
role மற்றும் loan status-க்கு ஏற்ப திறக்கப்படும் actions, block
explorer-இல் paste செய்யக்கூடிய on-chain loan id ஆகியவற்றுடன் முழு
position page-க்கு deep-link செய்கிறது.

<a id="dashboard.vpfi-panel"></a>

### இந்த chain-இல் VPFI

Active chain-இல் இணைக்கப்பட்ட wallet-க்கான live VPFI accounting:

- Wallet balance.
- Vault balance.
- Circulating supply-இல் உங்கள் பங்கு (protocol வசம் உள்ள balances-ஐக்
  கழித்த பிறகு).
- மீதமுள்ள mintable cap.

Vaipakam VPFI-ஐ Chainlink CCIP மூலம் cross-chain அனுப்புகிறது. **Base
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

இது wallet-level opt-in flag; உங்கள் VPFI வைத்திருப்பை fee தள்ளுபடியாக
மாற்றுகிறது. **Borrower-ஆக**, தள்ளுபடி என்பது Loan Initiation Fee-இலேயே
நேரடியான குறைப்பு; loan accept ஆகும்போது lending asset-இல் வசூலிக்கப்படும்,
அதற்காக உங்கள் vault-இலிருந்து எதுவும் கழிக்கப்படாது. **Lender-ஆக**, பலன்
தள்ளுபடி settlement-இல் பொருந்தும்; VPFI விலை மேற்கோள் அமைக்கப்பட்டிருந்தால்
உங்கள் vault-இலிருந்து VPFI-ஆகவும் தீர்க்கப்படலாம் — அப்போது lending
asset-இல் கட்டணம் முழுவதும் உங்களிடமே இருக்கும். Default: off. Off என்றால் ஒவ்வொரு
fee-இன் 100%-ஐயும் principal asset-இல் செலுத்துகிறீர்கள்; on என்றால்
time-weighted discount பொருந்தும்.

Tier ladder:

| Tier | குறைந்தபட்ச vault VPFI                  | Discount                          |
| ---- | ---------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                 | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`                 | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`                 | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`                 | `{liveValue:tier4DiscountBps}`%   |

நீங்கள் VPFI-ஐ deposit அல்லது withdraw செய்யும் தருணத்தில், உங்கள்
**post-change** vault balance அடிப்படையில் tier கணக்கிடப்படுகிறது.
உண்மையில் வசூலிக்கப்படும் rate, settlement நேரத்தில் உங்கள் அப்போதைய
tier-இலிருந்து தீர்மானிக்கப்படுகிறது; ஒவ்வொரு loan-இன் சொந்த காலத்திற்குத்
தனியாக எந்த average-ம் எடுக்கப்படுவதில்லை. பாதுகாப்பு tier-இலேயே உள்ளது:
அதிகபட்சம் 30 நாட்கள் கொண்ட சமீபத்திய window — இது protocol-இன் ஒரு
setting; உங்கள் தற்போதைய holding தொடங்கிய நாளிலிருந்து கணக்கிடப்படும்,
சமீபத்திய நாட்களுக்கு அதிக எடை — அதில் உங்கள் தினசரி balance-இன்
time-weighted average. அந்த average பிறகு, அந்த holding தொடங்கியதிலிருந்து
நீங்கள் எப்போதாவது இறங்கிய மிகக் குறைந்த tier வரை தாழ்த்தப்படும்; இது
அதிகபட்சம் 30 நாட்கள் பின்நோக்கிப் பார்க்கும்.

**இவை இரண்டு தனித்தனி பின்நோக்கல்கள்; பொதுவாக இரண்டாவதே நீளமானது.**
averaging window-ஐ 30 நாட்களுக்கும் குறைவாக அமைக்க முடியும்; ஆனால் மிகக்
குறைந்த tier-இன் பின்நோக்கல் அதனுடன் பிணைக்கப்படவில்லை — அது உங்கள் முழு
தற்போதைய holding-ஐயும் தழுவும், அதிகபட்சம் 30 நாட்கள். எனவே 14 நாள்
averaging window இருந்தாலும், 20 நாட்களுக்கு முந்தைய இறக்கம் average-க்கு
வெளியே இருந்தும் உங்கள் tier-ஐ கீழே வைத்திருக்கும்.

பூஜ்ஜியத்திற்கு மேற்பட்ட balance-ஐ **தொடர்ச்சியாக** குறைந்தபட்ச
நாட்களுக்கு hold செய்யும் வரை உங்கள் tier முற்றிலும் பூஜ்ஜியமே; இதுவும்
protocol-இன் setting. உங்கள் balance பூஜ்ஜியத்திலிருந்து மேலே செல்லும்போது
அந்தக் கணக்கு தொடங்கும், மீண்டும் பூஜ்ஜியத்தை அடைந்தால் மட்டுமே மறுபடி
தொடங்கும் — ஏற்கனவே உள்ள holding-இல் சேர்ப்பது அதை reset செய்யாது.

எனவே ஒரு withdraw, நீங்கள் ஈடுபட்டுள்ள ஒவ்வொரு open loan-க்கும்
உடனடியாகப் பாதிக்கிறது — பழைய (உயர்ந்த) tier தொடரும் grace window இல்லை.
loan முடிவதற்கு சற்று முன் VPFI-ஐ top up செய்து full-tier discount-ஐப்
பெற்று, சில நொடிகளில் withdraw செய்யும் exploit pattern-ஐ இது தடுக்கிறது.
எந்த விதி அதைத் தடுக்கிறது என்பதைக் கவனியுங்கள்: நீண்ட காலமாக hold
செய்பவருக்கு குறைந்தபட்ச காலம் ஏற்கனவே நிறைவேறிவிட்டது, எனவே வேலையைச்
செய்வது மிகக் குறைந்த tier விதிதான் — ஒரு average-ஆல் அதைச் செய்ய முடியாது,
ஏனெனில் தாமதமான top up ஒரு average-ஐ மேலே இழுக்கலாம், குறைந்தபட்சத்தை
இழுக்க முடியாது.

அந்தக் குறிப்பிட்ட pattern-க்கு எதிராக தற்போதைய விதியே வலிமையானது. ஆனால்
இது **எல்லா வகையிலும்** கடுமையானது அல்ல: மிகக் குறைந்த tier-இன் பின்நோக்கல்
அதிகபட்சம் 30 நாட்கள் மட்டுமே செல்வதால், நீண்ட loan-இன் ஆரம்பகால குறைந்த
tier மாதங்கள் இறுதியில் கணக்கில் வராமல் போகும்; loan முழுவதற்கும் எடுக்கும்
average அவற்றைத் தக்கவைத்திருக்கும். இந்த மாற்றம் குறுகிய top up-க்கு எதிரான
பாதுகாப்பை இறுக்கியது, நினைவகத்தைச் சுருக்கியது.

**மேலே சொன்னது lender yield fee பற்றியது.** Borrower-ன் தொடக்கக் கட்டண
விகிதம் loan accept ஆகும்போது ஒரே ஒரு முறை படிக்கப்படுகிறது; அதன் பிறகு
withdraw-ஓ top up-ஓ அதை மாற்றாது.

Discount settlement-இல் lender yield fee-க்கு பொருந்தும்; borrower-க்கு
Loan Initiation Fee-ல் பொருந்தும் — அங்கே அது நீங்கள் lending asset-இல்
செலுத்தும் **கட்டணத்திலேயே நேரடியான குறைப்பு**, loan accept ஆகும்போது
பொருந்துகிறது. அந்தக் கட்டணத்தைச் செலுத்த உங்கள் vault-இலிருந்து VPFI
எடுக்கப்படுவதில்லை; பின்னர் claim செய்ய rebate எதுவும் இல்லை.

> **Loan Initiation Fee rebate-க்காகக் காத்திருந்தால், இதைப் படியுங்கள்.**
> முந்தைய model முழுக் கட்டணத்தையும் VPFI-ஆக முன்கூட்டியே எடுத்து, loan
> முழு காலத்திற்கும் custody-இல் வைத்து, claim செய்யும்போது ஒரு பகுதியைத்
> திருப்பித் தந்தது. **அந்த வழி நீக்கப்பட்டுவிட்டது.** அந்த வழியில்
> எந்த loan-உம் ஒருபோதும் திறக்கப்படவில்லை; எனவே எந்த loan-க்கும்
> அதன் initiation fee-க்கு எதிராக VPFI எதுவும் custody-இல் இல்லை,
> rebate எதுவும் நிலுவையில் இல்லை — அதற்குக் காத்திருப்பது வர
> முடியாத பணத்திற்குக் காத்திருப்பதாகும்.

> **Network gas தனியானது.** மேலே உள்ள discount Vaipakam-ன்
> **protocol fees** (yield fee `{liveValue:treasuryFeeBps}`%,
> Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%) மீது
> apply ஆகும். ஒவ்வொரு on-chain action-ம் தேவைப்படும் **blockchain
> network gas fee** (Base / Sepolia / Arbitrum போன்ற chain-களில்
> offer create / accept / repay / claim / withdraw போது
> validators-க்கு pay செய்யப்படுவது) protocol charge அல்ல.
> Vaipakam அதை எப்போதும் receive செய்வதில்லை; network receive
> செய்கிறது. அதற்கு tier அல்லது rebate apply செய்ய முடியாது,
> மற்றும் அது submission நேரத்தின் chain congestion-ஐ பொறுத்தது,
> loan size அல்லது உங்கள் VPFI tier-ஐ அல்ல.

<a id="dashboard.rewards-summary"></a>

### உங்கள் VPFI rewards

இணைக்கப்பட்ட wallet-க்கான VPFI rewards நிலையை ஒரே view-இல் காட்டும்
summary card. headline number என்பது pending interaction rewards
மற்றும் lifetime-claimed interaction rewards ஆகியவற்றின் கூட்டுத்தொகை.

breakdown row pending + claimed-ஐ காட்டி, அதன் native page-இல் உள்ள
full claim card-க்கு chevron deep-link கொடுக்கும்:

- **Platform-interaction rewards** — நீங்கள் lender side அல்லது borrower
  side-ல் பங்கேற்ற ஒவ்வொரு loan-லிருந்தும் accrue ஆகும் pending VPFI,
  மேலும் முன்பு claim செய்த அனைத்து interaction rewards. Claim Center-இன்
  interaction claim card-க்கு deep-link ஆகிறது.

lifetime-claimed numbers ஒவ்வொரு wallet-இன் on-chain claim history-இலிருந்து
reconstruct செய்யப்படுகின்றன. query செய்யக்கூடிய on-chain running total
இல்லாததால், இந்த chain-இல் wallet-இன் பழைய claim events-ஐ walk செய்து
கூட்டுகிறது. fresh browser cache, historic walk முடியும் வரை zero அல்லது
partial total-ஐ காட்டலாம்; பின்னர் சரியான value-க்கு update ஆகும்.
underlying claim cards-க்கு இருக்கும் trust model இதற்கும் அதே.

card connected wallets-க்கு எப்போதும் render ஆகும்; எல்லா values-மும்
zero என்ற நிலையிலும். empty-state hint திட்டமிட்டதே — zero-வில் card-ஐ
மறைத்தால் புதிய users Claim Center-க்கு செல்லும் வரை rewards program
கண்ணில் படாது.

---

<a id="chapter.offer-book"></a>

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Lender / borrower offer lists-க்கு client-side filters. Asset, side,
status, மற்றும் சில மற்ற axes அடிப்படையில் filter செய்யலாம். Filters
"Your Active Offers"-ஐ பாதிக்காது — அந்த list எப்போதும் முழுமையாகத்
தெரியும்.

<a id="offer-book.your-active-offers"></a>

### உங்கள் செயல்படும் offers

நீங்கள் உருவாக்கிய திறந்த offers (நிலை Active, காலாவதி இன்னும்
எட்டவில்லை). ஏற்பதற்கு முன் எந்த நேரத்திலும் ரத்து செய்யலாம் —
ரத்து call இலவசம். ஏற்பது offer-ஐ Accepted-க்கு மாற்றுகிறது
மற்றும் loan initialization-ஐ trigger செய்கிறது, இது இரண்டு
position NFTs (ஒன்று lender-க்கு, ஒன்று borrower-க்கு) mint
செய்து loan-ஐ Active நிலையில் திறக்கிறது.

மூடப்பட்ட offers பல distinct நிலைகளில் ஒன்றை கொண்டுள்ளன. சில
ஏற்கனவே My Offers பக்கத்தில் filter chips-ஆக exposed உள்ளன;
பிற indexer-side terminals-ஆக உள்ளன, அவை follow-up வேலையில்
dedicated UI treatment பெறும்:

- **Filled** — counterparty-ஆல் ஏற்கப்பட்டது; offer-இன் loan
  reference என்பது resulting loan id ஆகும்.
- **Cancelled** — offer Cancelled நிலையை இரண்டு வழிகளில் ஒன்றில்
  அடைந்தது: ஏற்பதற்கு முன் creator-ஆல் திரும்பப் பெறப்பட்டது,
  அல்லது `LibVaipakam.isOfferExpired(offer)` true ஆனவுடன்
  `OfferCancelFacet.cancelOffer` மூலம் permissionlessly cleanup
  செய்யப்பட்டது (cancel call-ஐ யார் initiate செய்தாலும் refund
  இன்னும் creator-க்கே route செய்யப்படுகிறது).
- **Sold** — offer borrow-OR-sell parallel-sale flow-க்கு opt-in
  செய்யப்பட்டது (Offer உருவாக்கு → விருப்ப sale-ஐ அனுமதி-ஐ பார்க்கவும்)
  மற்றும் எந்த lender-ம் ஏற்பதற்கு முன் ஒரு marketplace buyer
  NFT collateral listing-ஐ fill செய்தார். Offer on-chain
  status `consumed_by_sale`-ஐ கொண்டுள்ளது; row-இன் rate column
  offer post செய்யப்பட்ட rate-ஐ காட்டுகிறது மற்றும் collateral
  cell NFT shape-ஐ (ERC-721-க்கு token id, ERC-1155-க்கு copy
  count) render செய்கிறது. dapp மேலும் borrower (offer creator)-
  க்காக Activity feed-இல் row-ஐ `Offer sold via OpenSea`-ஆக
  surface செய்கிறது. On-chain event தானே
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  offer id மற்றும் executor address இரண்டும் on-chain indexed,
  ஆனால் borrower / creator address இல்லை. Activity feed-க்கான
  borrower-இன் wallet match-ஐ indexer ingestion time-இல் சேர்க்கிறது
  (offer row-ஐ join செய்து creator-ஐ look up செய்கிறது),
  எனவே per-wallet filter event தானே அவர்களை index செய்யாமலேயே
  borrower-ஐ கண்டறிகிறது.
- **Fully Filled (indexer state, இன்னும் chip இல்லை)** — Range-
  orders மட்டுமே. partial-fill matching offer-இன் மீதமுள்ள
  budget-ஐ consume செய்யும்போது (கடைசி match range-ஐ முழுமையாக
  fill செய்கிறது, அல்லது partial match sub-dust remainder-ஐ
  விட்டுச் செல்கிறது), `OfferMatchFacet`
  `OfferClosed(FullyFilled | Dust)`-ஐ emit செய்கிறது மற்றும்
  indexer offer row-இல் `status = 'fullyFilled'`-ஐ stamp
  செய்கிறது. Contract-இன் `accepted` state மற்றும் மேலே உள்ள
  on-chain Filled label direct-accept terminal-க்கு reserved,
  எனவே `fullyFilled` indexer side-இல் distinct ஆகும். dapp-இன்
  `MyOfferStatus` இந்த terminal-ஐ அதன் சொந்த filter chip-ஆக
  இன்னும் expose செய்யவில்லை — `useMyOffers` தற்போது
  `fullyFilled` indexer status உள்ள rows-ஐ ignore செய்கிறது —
  எனவே fully-filled range offer dedicated chip வரும் வரை My
  Offers view-இல் இருந்து effectively முழுவதுமாக விழுந்துவிடுகிறது.
  Chip surface ஒரு separate UI follow-up-ஆக queue-இல் உள்ளது.

Terminal event-ஐ அடையாத Past-GTT (GTT முடிவு நேரம்) offers dapp-இல்
distinct status chip-ஆக இன்னும் expose செய்யப்படவில்லை; indexer
terminal-ஐ record செய்யும் வரை அவை தற்போது Active கீழ் வருகின்றன.
Dedicated Expired chip ஒரு separate UI follow-up-ஆக queue-இல்
உள்ளது.


<a id="offer-book.lender-offers"></a>

### Lender Offers

கடன் கொடுக்கத் தயாராக உள்ள creators-களிடமிருந்து Active offers.
Acceptance borrower-ஆல் செய்யப்படுகிறது. Initiation-இல் ஒரு கடினமான
gate உள்ளது: borrower-இன் collateral basket, lender-இன் principal
request-க்கு எதிராக குறைந்தபட்சம் 1.5 Health Factor உருவாக்க வேண்டும்.
HF math protocol-இன் சொந்த கணக்கீடு — இந்த gate-இன் மீற முடியாது.
Interest-இன் `{liveValue:treasuryFeeBps}`% treasury cut terminal settlement-இல் debit செய்யப்படும்,
முன்கூட்டியே அல்ல.
இந்த rate loan உருவாக்கப்படும்போதே நிலைநிறுத்தப்படுகிறது; எனவே protocol
fee-ல் பிறகு ஏற்படும் மாற்றம், ஏற்கனவே திறந்திருக்கும் loan-ஐ அது தொடங்கிய
rate-லேயே விட்டுவிடும்.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

ஏற்கனவே vault-இல் collateral-ஐ lock செய்துள்ள borrowers-களிடமிருந்து
Active offers. Acceptance lender-ஆல் செய்யப்படுகிறது; அது principal
asset மூலம் loan-ஐ fund செய்து position NFTs-ஐ mint செய்கிறது.
Initiation-இல் அதே HF ≥ 1.5 gate. நிலையான APR offer creation-இல்
அமைக்கப்பட்டு loan-இன் வாழ்நாள் முழுவதும் immutable — refinance,
தற்போதைய loan-ஐ மாற்றாமல் புதிய loan-ஐ உருவாக்கும்.

---

<a id="chapter.create-offer"></a>

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
உங்கள் vault-இலிருந்து borrower-இன் vault-க்கு நகர்கிறது.

<a id="create-offer.lending-asset:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

நீங்கள் lender-இடமிருந்து விரும்பும் principal asset மற்றும் amount,
கூடவே interest rate (APR %-இல்) மற்றும் duration (days-இல்). Rate offer
time-இல் fixed; duration loan default ஆகும்முன் உள்ள grace window-ஐ
அமைக்கும். உங்கள் collateral offer-creation time-இல் vault-இல் lock
செய்யப்படுகிறது; lender accept செய்து loan திறக்கும் வரை (அல்லது நீங்கள்
cancel செய்யும் வரை) lock-இல் இருக்கும்.

<a id="create-offer.nft-details"></a>

### NFT Details

Rental-sub-type fields. NFT contract மற்றும் token id-ஐ (ERC-1155-க்கு
quantity-யையும்) குறிப்பிடுகிறது, கூடவே principal asset-இல் daily rental
fee. Acceptance-இல், protocol prepaid rental-ஐ renter-இன் vault-இலிருந்து
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
pool depth) LTV / HF math-இப் பெறுகின்றன; illiquid ERC-20s மற்றும்
NFTs-க்கு on-chain valuation இல்லை, மேலும் full-collateral-on-default
outcome-ஐ இரு parties-களும் ஏற்க வேண்டும். Loan initiation-இல் HF ≥
1.5 gate, acceptance-இல் borrower வழங்கும் collateral basket-க்கு எதிராக
கணக்கிடப்படுகிறது — இங்கே requirement-ஐ அமைப்பது borrower-இன் HF
headroom-ஐ நேரடியாக நிர்ணயிக்கும்.

<a id="create-offer.collateral:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

Loan-ஐப் பாதுகாக்க நீங்கள் எவ்வளவு lock செய்யத் தயாராக உள்ளீர்கள்.
Liquid ERC-20s (Chainlink feed + ≥ $1M v3 pool depth) LTV / HF math-இப்
பெறுகின்றன; illiquid ERC-20s மற்றும் NFTs-க்கு on-chain valuation இல்லை,
மேலும் full-collateral-on-default outcome-ஐ இரு parties-களும் ஏற்க
வேண்டும். borrower offer-இல், உங்கள் collateral offer-creation time-இல்
vault-இல் lock செய்யப்படுகிறது; lender offer-இல், offer-acceptance
time-இல் lock செய்யப்படுகிறது. எப்படியிருந்தாலும், நீங்கள் வழங்கும்
basket மூலம் loan initiation-இல் HF ≥ 1.5 gate clear ஆக வேண்டும்.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Submit செய்வதற்கு முன் வரும் acknowledgement gate இது. அதே risk profile
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
  liquidation-இத் தாமதப்படுத்தும். Secondary quorum (Tellor + API3 +
  DIA, soft 2-of-N) பெரிய drift-இப் பிடிக்கும்; ஆனால் சிறிய skew இன்னும்
  recovery-இ குறைக்கலாம்.
- **Liquidation slippage** — 4-DEX failover சாத்தியமான சிறந்த
  execution-க்கு route செய்கிறது, ஆனால் குறிப்பிட்ட விலையை
  உத்தரவாதம் செய்ய முடியாது. Recovery, slippage மற்றும் interest-இன்
  மீதான `{liveValue:treasuryFeeBps}`% treasury cut-க்குப் பிறகுதான்.
- **Illiquid-collateral defaults** — default time-இல் collateral
  உங்களுக்கு முழுமையாக transfer ஆகிறது. Asset-இன் மதிப்பு principal
  கூடவே accrued interest-ஐ விட குறைவாக இருந்தால் உங்களுக்கு recourse
  இல்லை.

<a id="create-offer.risk-disclosures:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

- **Smart-contract risk** — contract code runtime-இல் immutable; bugs
  locked collateral-இப் பாதிக்கலாம்.
- **Oracle risk** — stale data அல்லது manipulation, real-market price
  பாதுகாப்பாக இருக்கும் போது உங்களுக்கு எதிராக HF-based liquidation-இத்
  தூண்டலாம். HF formula oracle output-க்கு பதிலளிக்கும்; 1.0-ஐ
  தாண்டும் ஒரே ஒரு bad tick போதும்.
- **Liquidation slippage** — liquidation fire ஆகும்போது, swap உங்கள்
  collateral-ஐ slippage-ஆல் பாதிக்கப்பட்ட விலையில் விற்கலாம். Swap
  permissionless — உங்கள் HF 1.0-க்குக் கீழே drop ஆகும் கணத்தில் யாரும்
  trigger செய்யலாம்.
- **Illiquid-collateral defaults** — Default உங்கள் முழு collateral-ஐ
  lender-க்கு transfer செய்கிறது; claim செய்ய எதுவுமே மீதியில்லை.

<a id="create-offer.advanced-options"></a>

### Advanced Options

அரிதாகப் பயன்படுத்தப்படும் controls:

- **Expiry** — இந்த timestamp-க்குப் பிறகு offer தானாக cancel
  ஆகிறது. Default ≈ 7 days.
- **Use fee discount for this offer** — இந்த குறிப்பிட்ட offer-க்கு
  wallet-level fee-discount consent-இன் local override.
- Offer creation flow-ஆல் வெளிப்படுத்தப்பட்ட side-specific options.

பெரும்பாலான பயனர்களுக்கு defaults பொருத்தமானவை.

<a id="create-offer.borrow-or-sell"></a>

### இந்த NFT-ஐ OpenSea-இல் optional-ஆக விற்க அனுமதி (NFT-collateral உள்ள borrower offers மட்டுமே)

நீங்கள் **ERC-721 அல்லது ERC-1155 collateral** மற்றும் **ERC-20
principal**-உடன் **borrower offer**-ஐ post செய்கிறீர்கள் என்றால்,
dapp collateral section-க்கு கீழே ஒரு `Borrow or sell` opt-in-ஐ
expose செய்கிறது. அதைத் தேர்ந்தெடுக்கப்பது offer-ஐ OpenSea-இல்
உங்கள் NFT collateral-இன் parallel-sale listing-க்கு eligible-ஆக
mark செய்கிறது — ஒரு single offer-ஐ ஒரு lender (நீங்கள் loan-ஐ
எடுக்கிறீர்கள்) அல்லது ஒரு marketplace buyer (நீங்கள் NFT-ஐ
விற்கிறீர்கள்) மூலம் fill செய்ய முடியும். listing already post
செய்யப்பட்டிருந்தால் lender acceptance-ல் listing teardown
செய்யப்படவில்லை: lender முதலில் fill செய்தால் நீங்கள் loan-ஐ
எடுக்கிறீர்கள், existing OpenSea listing loan initiation
மூலம் அதன் original Seaport expiry வரை carry over ஆகிறது, மற்றும்
அந்த expiry-க்கு முன்னர் ஒரு later marketplace fill diamond-இன்
settlement waterfall-ஐ trigger செய்கிறது sale proceeds-இல் இருந்து
loan-ஐ close செய்வதற்காக (கீழே Scenario B-ஐ பார்க்கவும்).
சாதாரண GTT offers-க்கு இந்த expiry என்பது offer-இன் original
GTT முடிவு நேரம் ஆகும்; lender acceptance listing-ஐ full loan term-க்கு
extend செய்யவில்லை அல்லது repost செய்யவில்லை. ஒரு marketplace
buyer முதலில் fill செய்தால், எந்த loan-ம் உருவாக்கப்படவில்லை
(Scenario A). இரண்டு scenarios வெவ்வேறு offer states-இல் முடிகின்றன:
Scenario A offer-ஐ `markOfferConsumedBySale` மூலம்
`consumed_by_sale`-உடன் stamp செய்கிறது (Sold filter-ஐ கீழே
காட்டுகிறது), மற்றும் lender acceptance ஏற்கனவே stamp
செய்யப்பட்ட எந்த offer-க்கும் எதிராக gated. Scenario B-இல்
marketplace fill land ஆகும் நேரத்தில் offer ஏற்கனவே `Accepted`
state-இல் உள்ளது; contract intentionally offer status-ஐ
`Accepted`-இல் விட்டுவிட்டு sale-இல் இருந்து loan-ஐ மட்டுமே
settle செய்கிறது — offer இரண்டாம் முறை Sold-க்கு transition
ஆகாது.

**இரு-step nature.** Offer creation time-இல் opt-in offer-இல்
eligibility flag-ஐ மட்டுமே set செய்கிறது. OpenSea-இல் உண்மையில்
buyable listing-ஐ பெறுவது dapp இன்று automate செய்யாத ஒரு
SEPARATE TWO-PART step ஆகும்:

1. **Diamond-இல் record + wire செய்.**
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)`-ஐ offer இன்னும் active-ஆக இருக்கும்போது மற்றும்
   எந்த lender acceptance-க்கும் முன் call செய்யவும். Offer
   accepted, cancelled, அல்லது consumed by sale ஆனவுடன், இந்த
   call terminal-ஆக revert ஆகிறது; opt-in-ஐ tick செய்வது மட்டும்
   Scenario B-க்கு carry over ஆக listing உருவாக்க போதாது. Ask
   pre-loan floor-ஐ-ம் cover செய்ய வேண்டும்: principal plus
   worst-case offer interest loan duration மற்றும் grace
   window மூலம், அந்த interest-இல் treasury cut, configured
   safety buffer, மற்றும் அனைத்து fee-leg amounts. Under-floor
   asks இந்த step-இல் revert ஆகின்றன. `feeLegs` argument-தான்
   இந்த call OpenSea protocol-fee மற்றும் creator-royalty
   obligations-ஐ record செய்யும் ONLY இடம்: diamond ஒவ்வொரு
   fee-leg amount-ஐ seller proceeds-இல் இருந்து கழித்து
   recipient + absolute amount-ஐ Seaport consideration array-க்கு
   append செய்கிறது. Fee-enforced collection-இல் `feeLegs: []`-ஐ
   pass செய்வது OpenSea publish step reject செய்யும் order shape-ஐ
   produce செய்கிறது (fee-recipient consideration items
   missing), மற்றும் direct Seaport fill collection require
   செய்கின்றபடி fees-ஐ split செய்வதற்கு பதிலாக full ask-ஐ
   seller-க்கு route செய்யும். Advanced users collection-க்கான
   OpenSea required-fee schedule-ஐ fetch செய்ய வேண்டும் (in-repo
   fee parser `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** reference) மற்றும்
   call செய்வதற்கு முன் ask-க்கு எதிராக derived absolute amounts-ஐ
   pass செய்ய வேண்டும். Facet internally அந்த inputs-இல் இருந்து
   canonical Seaport OrderComponents-ஐ build செய்கிறது (plus
   `CollateralListingExecutor.offerContext`-இல் வைத்திருக்கும்
   values — borrower vault address, principal asset, collateral
   fields, startTime, endTime) மற்றும் vault-க்கான current
   `Seaport.getCounter`, `Seaport.getOrderHash` மூலம் orderHash-ஐ
   derive செய்கிறது, அதை return செய்கிறது, vault-இன் ERC-1271
   binding-ஐ அந்த hash-உடன் register செய்கிறது, மற்றும் NFT
   collateral-க்காக Seaport conduit approval-ஐ grant செய்கிறது.
   Emit செய்யப்பட்ட `PostParallelSaleListing` event input
   args-ஐ expose செய்கிறது (`offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, fee legs); இது
   per-context fields-ஐ echo செய்யவில்லை, எனவே off-chain-இல்
   OrderComponents-ஐ reconstruct செய்வதற்கு கீழே step 2-இல்
   விவரிக்கப்பட்ட additional reads தேவை. **முக்கியம்:** இந்த
   point-இல் order ஏற்கனவே Seaport மூலம் FILLABLE ஆகும்.
   contract-இன் events-ஐ பார்க்கும் ஒரு bot plus அந்த reads
   OrderComponents-ஐ reconstruct செய்யலாம் மற்றும்
   `Seaport.fulfillOrder`-ஐ நேரடியாக call செய்யலாம் — on-chain
   fill path வேலை செய்ய listing OpenSea-வின் marketplace UI-இல்
   தோன்ற வேண்டியதில்லை. Step 2 land ஆவதற்கு முன் counterparties
   current ask-இல் fill செய்ய நீங்கள் விரும்பவில்லை என்றால்,
   step 1-க்கு பிறகு உடனடியாக step 2-ஐ run செய்யவும் அல்லது எந்த
   unintended fill-க்கு முன் binding-ஐ invalidate செய்ய
   `releaseParallelSaleLock`-ஐ call செய்யவும்.
   Fee-enforced collections-க்கு, இந்த step-ஐ call செய்வதற்கு
   முன் collection-இன் required OpenSea / creator fee schedule-இல்
   இருந்து `feeLegs`-ஐ populate செய்யவும். Required, non-zero
   fee rows-ஐ மட்டுமே பயன்படுத்தவும்; list-ஐ protocol-supported
   fee-leg count-க்கு cap செய்யவும்; ஒவ்வொரு row-ஐயும் chosen
   ask price-இல் principal asset-இல் absolute fixed amount-ஆக
   convert செய்யவும்; மற்றும் listed fee recipient-ஐ leg
   recipient-ஆக பயன்படுத்தவும். Chosen ask-இல் required fee
   zero-க்கு round ஆனால், ask அந்த collection-க்கு மிகவும்
   சிறியதாக உள்ளது மற்றும் post முயற்சிக்கப்படக் கூடாது. Empty
   array-ஐ pass செய்வது fee-free collections-க்கு மட்டுமே
   valid. Fee-enforced collections-இல் இது OpenSea publication-இல்
   fail ஆகும் அல்லது marketplace-இன் required consideration shape-ஐ
   satisfy செய்ய முடியாத ஒரு order-ஐ produce செய்யலாம்.
2. **OpenSea-இல் publish செய்.** Facet build செய்த அதே
   OrderComponents-ஐ reconstruct செய்யவும். `PostParallelSaleListing`
   event மட்டும் போதாது: இது `offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, மற்றும் fee legs-ஐ
   emit செய்கிறது, ஆனால் offer-keyed order shape-க்கு executor-இன்
   `OfferContext` storage-இல் வைத்திருக்கும் values (borrower
   vault address, principal asset, collateral fields, startTime,
   endTime) plus borrower vault-இன் Seaport counter (offerer-இன்
   counter — `LibPrepayOrder.buildAndHashOfferMem`
   `Seaport.getCounter(ctx.borrowerVault)`-ஐ hash செய்கிறது,
   bidder-இன் counter அல்ல) தேவை. இது
   `LibPrepayOrder.buildAndHashOfferMem` offer-order path-ஐ
   பயன்படுத்தும் அதே context, மற்றும் இது loan-keyed
   prepay-listing order shape-இல் இருந்து வேறுபடுகிறது. Post
   செய்வதற்கு முன் இரண்டையும் read செய்யவும்:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     அந்த hash-க்கான persisted `OfferContext` struct-ஐ return
     செய்கிறது.
   - `Seaport.getCounter(borrowerVault)` vault offerer-க்கான
     canonical Seaport counter-ஐ return செய்கிறது.
   அந்த fields கையில் இருந்தால் OrderComponents struct diamond
   hash செய்த அதையே reproduce செய்கிறது. POST செய்வதற்கு முன்,
   API-only field `parameters.totalOriginalConsiderationItems`-ஐ
   add செய்யவும் — OpenSea-வின் API இதை require செய்கிறது,
   canonical hash-ஐ produce செய்யும் Seaport struct-இன் பகுதி
   அல்ல என்றாலும்; in-repo publishers
   (`apps/indexer/src/openseaPublish.ts`) endpoint call செய்வதற்கு
   முன் இதை inject செய்கின்றனர். ERC-1271-validated orders-க்கு
   OpenSea `signature` field-ஐ `0x` (empty bytes)-ஆக accept
   செய்கிறது — vault-இன் on-chain `isValidSignature(orderHash,
   '')` callback signature bytes-ஐ ignore செய்து diamond முன்னர்
   register செய்த எந்த orderHash-க்கும் EIP-1271 magic value-ஐ
   return செய்கிறது (step 1-இல் இருந்து). JSON-ஐ OpenSea
   listings endpoint-க்கு POST செய்யவும் (`POST
   /api/v2/orders/{chain}/{protocol}/listings`, official
   [Create Listing](https://docs.opensea.io/reference/post_listing)
   docs படி — இது Vaipakam-இன் own publishers
   `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts`-இல் பயன்படுத்தும் அதே
   endpoint). இந்த step-க்கு பிறகுதான் listing OpenSea-வின்
   marketplace UI-இல் தோன்றுகிறது மற்றும் casual buyers-க்கு
   discoverable ஆகிறது. Vaipakam தற்போது parallel-sale path-க்கு
   இந்த submission-ஐ automate செய்யவில்லை — end-to-end listing
   publication-ஐ surface செய்வது follow-up-ஆக tracked.

இன்று manual path-ஐ பின்பற்றும் advanced users-க்கு OpenSea
visibility-க்கு இரண்டு steps-ம் தேவை; step 1-ஐ மட்டும் run
செய்வது Seaport மூலம் directly fillable-ஆக ஒரு order-ஐ produce
செய்கிறது (event-இல் இருந்து components-ஐ reconstruct செய்யும்
bot அல்லது counterparty-ஆல்) ஆனால் OpenSea marketplace UI-இல்
invisible.

**Fill mode All-or-Nothing-க்கு கட்டாயமாக்கப்படுகிறது.** Opt-in
offer-இன் fill mode-ஐ automatically `Aon`-இல் pin செய்கிறது —
parallel-sale enabled-உடன் partial / IOC fill modes ஒற்றை
offer-இன் collateral-க்கு எதிராக multiple loans-ஐ உருவாக்கும்,
இதை contract gate செய்கிறது. Toggle lender offers, ERC-20
collateral, NFT principals, மற்றும் contract-இன்
`_validatePostParallelSale` reject செய்யும் வேறு எந்த shape-இலும்
hidden, எனவே ineligible offer-இல் தற்செயலாக tick செய்ய முடியாது.

**Buyer என்ன பார்க்கிறார்.**

- *எந்த lender-ம் accept செய்வதற்கு முன்* (Scenario A): OpenSea
  listing-ஐ fill செய்யும் buyer listed price-ஐ pay செய்கிறார்.
  Fee-enforced collections-இல் Seaport OpenSea protocol-fee
  மற்றும் creator-fee legs-ஐ முதலில் அவர்களின் configured
  recipients-க்கு directly route செய்கிறது; executor diamond-க்கு
  **net proceeds** (listed price minus அந்த marketplace /
  creator fee legs)-ஐ மட்டுமே pass செய்கிறது. Diamond அந்த net
  amount-ஐ உங்கள் vault-இல் escrow செய்கிறது, NFT buyer-க்கு
  transfer ஆகிறது, மற்றும் offer `consumed_by_sale`-உடன் mark
  ஆகிறது (My Offers, Activity, மற்றும் Offer Details-இல்
  distinct "Sold" status-ஆக visible). எந்த loan-ம் உருவாக்கப்படவில்லை;
  நீங்கள் net sale proceeds-ஐ வைத்திருக்கிறீர்கள்.
- *Lender accept செய்த பிறகு* (Scenario B): listing loan
  initialization மூலம் carry over ஆகிறது — borrower NFT lock
  அல்லது listing teardown செய்யப்படவில்லை. Later buyer fill
  diamond-இன் settlement waterfall-ஐ ஒரு Seaport transaction-இல்
  trigger செய்கிறது. Scenario A போன்ற அதே fee-leg note:
  fee-enforced collections-இல் Seaport OpenSea protocol-fee
  மற்றும் creator-fee legs-ஐ முதலில் அவர்களின் configured
  recipients-க்கு directly route செய்கிறது, மற்றும் executor
  diamond-இன் waterfall-க்கு **net proceeds** (sale price minus
  marketplace / creator fees)-ஐ மட்டுமே pass செய்கிறது.
  Sale என்பது collateral மூலம் funded ஆன ஒரு repayment, எனவே diamond
  அந்த net amount-ஐ fill நேரத்தில் ஒரு repayment செய்வது போலவே
  settle செய்கிறது: loan repaid ஆகிறது; lender-இன் due (loan
  `useFullTermInterest = true`-உடன் உருவாக்கப்பட்டிருந்தால் full
  coupon, இல்லையெனில் இதுவரை accrued interest, கூடவே lender-இன்
  yield-fee discount இருந்தால் அது) lender-இன் vault-இல் வைக்கப்பட்டு,
  ordinary lender claim மூலம் current lender-position holder-க்கு
  கொடுக்கப்படுகிறது; treasury அந்த discount கழித்த தன் cut-ஐ
  பெறுகிறது; மீதி current borrower-position holder-இன் wallet-க்கு
  அனுப்பப்படுகிறது. மீதியை அந்த wallet-க்கு கொடுக்க முடியாவிட்டால், அது hold
  செய்யப்பட்டு Claim Center-இல் ordinary borrower claim மூலம்
  கொடுக்கப்படுகிறது. Lender-க்கு sale-க்குள் ஒருபோதும் payment
  நடப்பதில்லை, எனவே lender-இன் wallet பற்றிய எதுவும் sale-ஐ
  நிறுத்த முடியாது.

**இதை எதனுடன் combine செய்ய முடியாது.** வெவ்வேறு protocol
stages-இல் surface செய்யப்படும் இரண்டு distinct conflict
classes:

- *Publish-time block (sibling loan-keyed listing).* Loan
  ஏற்கனவே offer-create-இல் இருந்து carry over ஆகும்
  parallel-sale listing-ஐ கொண்டுள்ளது மற்றும் borrower பின்னர்
  அதே loan-இல் SECOND loan-keyed prepay listing-ஐ post செய்ய
  `NFTPrepayListingFacet.postPrepayListing`-ஐ (அல்லது
  `updatePrepayListing`-ஐ) call செய்தால், diamond
  `SiblingParallelSaleListingLive`-உடன் revert ஆகிறது.
  Borrower-இன் NFT-க்கான conduit approval ஒற்றை slot — இரண்டு
  listings-ஐ concurrent-ஆக run செய்வது ambiguous approval-ஐ
  உருவாக்கும். Borrower publish / update call-இல் revert-ஐ
  பார்க்கிறார்; எதுவும் fill ஆகவில்லை.
- *Fill-time block (open PrecloseFacet offset).* Loan-இல் open
  PrecloseFacet offset offer உள்ளது மற்றும் ஒரு buyer பின்னர்
  parallel-sale listing-ஐ fill செய்ய முயற்சித்தால், diamond-இன்
  `_settleLoanFromParallelSale` `ParallelSaleBlockedByOpenOffsetOffer`-உடன்
  revert ஆகிறது. Listing OpenSea-இல் valid-ஆக இருக்கும் ஆனால்
  offset link clear ஆகும் வரை எந்த fill attempt-ம் revert
  ஆகிறது. Dapp தற்போது இந்த combination-க்கு Loan Details
  page-இல் dedicated banner / notification-ஐ surface
  செய்யவில்லை; users fills revert ஆவதை பார்ப்பார்கள் மற்றும்
  diagnose செய்ய block explorer-இல் revert reason-ஐ inspect
  செய்ய வேண்டியிருக்கலாம். Cleanup path ordinary offer-cancel
  surface — offset offer-ஐ cancel செய்ய
  `OfferCancelFacet.cancelOffer(offsetOfferId)`-ஐ call
  செய்யவும், இது offset link-ஐ release செய்கிறது மற்றும்
  parallel-sale fill-ஐ unblock செய்கிறது (PrecloseFacet-க்கு
  separate cancellation entry point இல்லை; offset linked
  offer-உடன் bound, எனவே linked offer-ஐ cancel செய்வது அதை
  clear செய்கிறது). Conflict-க்கான dedicated UI surface
  separate UX follow-up-ஆக queue-இல் உள்ளது.


<a id="chapter.claim-center"></a>

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims வடிவமைப்பில் pull-style — terminal events funds-இன் protocol
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
- Accrued interest-இல் இருந்து, உங்கள் loan உருவாக்கப்பட்டபோது
  நிலைநிறுத்தப்பட்ட treasury cut கழிக்கப்படும் (தற்போதைய
  விகிதத்தில் உருவாக்கப்படும் loans-க்கு
  `{liveValue:treasuryFeeBps}`%). Consent on ஆக இருக்கும்போது cut-ஐ
  உங்கள் time-weighted VPFI fee-discount accumulator குறைக்கிறது.

Loan terminal state-ஐ (Settled, Defaulted, அல்லது Liquidated) எட்டியவுடன்
claimable. Lender position NFT அதே transaction-இல் burn செய்யப்படும்.

<a id="claim-center.claims:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

Loan எவ்வாறு settle ஆனது என்பதைப் பொறுத்து borrower claim திருப்பித்
தருவது:

- **Full repayment / preclose / refinance** — உங்கள் collateral
  basket திரும்ப. அதனுடன் Loan Initiation Fee rebate எதுவும்
  வராது: உங்கள் தள்ளுபடி acceptance-இன்போதே கட்டணத்திலிருந்து
  கழிக்கப்பட்டுவிட்டது.
- **loan-ஐ settle செய்யும் prepay sale** — collateral வாங்குபவருக்குச்
  செல்லும், உங்களுக்குத் திரும்பாது. விற்பனை விலையிலிருந்து lender-ன்
  உரிமை, treasury வெட்டு, listing-இல் இருந்த seller fees ஆகியவை போக
  மீதி உங்களுக்கு — borrower position NFT வைத்திருப்பவருக்குச்
  செலுத்தப்படும்.
- **Swap-to-repay** — கடனை ஈடுசெய்ய உங்கள் collateral, நீங்கள்
  நிர்ணயிக்கும் உச்சவரம்பு வரை விற்கப்படும். வரம்பைத் தாராளமாக
  வைத்தால், கடன் கண்டிப்பாகக் கோரியதை விட அதிகம் செலவாகலாம்;
  செலவாகாதது உங்களுக்குத் திரும்பும். loan-ன் சொந்த asset-இல் உள்ள
  உபரி வழக்கமாக claim-ஆகக் காத்திராமல் நேரடியாக borrower NFT
  வைத்திருப்பவருக்குச் செலுத்தப்படும் — அவர் sanctions freeze-இல்
  இருந்தால் மட்டும் அது claim-ஆகத் தடுத்து வைக்கப்படும்.
- **HF-liquidation அல்லது default** — இருந்தாலும் பார்த்துவிடுங்கள்;
  surplus மிச்சம் இருக்கலாம். Liquidator, lender, treasury ஆகியோருக்குத்
  தேவையான மதிப்பு மட்டுமே எடுக்கப்படும்; மீதி உங்கள் claim ஆகப்
  பதிவாகும். அதன் வடிவம் ஒரே ஒன்றைப் பொறுத்தது:
  collateral விற்கப்பட்டதா, அல்லது கையளிக்கப்பட்டதா. விற்கப்பட்டால் —
  அதாவது exchange வழியாக வெளியே அனுப்பப்பட்டால் — மீதி உங்களுக்கு
  loan-இன் principal asset-இல் வந்து சேரும். கையளிக்கப்பட்டால், எஞ்சுவது
  collateral-ஏ, உங்கள் vault-இல் encumbered ஆக. ஒன்றுக்கு மேற்பட்ட வழிகள் அதைக் கையளிக்கின்றன; loan எப்படி முடிந்தது
  என்பதைப் பொறுத்தது அல்ல அவை: liquidator தள்ளுபடியில் நேரடியாக
  எடுத்துக்கொள்வது, exchange-க்கு அனுப்பப்படாமல் உள்ளகமாக எதிர்த்திசை
  position-உடன் பொருத்தப்படும் close-out, மற்றும் நிறைவேறாத ஒரு விற்பனை — அங்கு collateral உங்களுக்கு வரும் — claim செய்யும்போது lender வேலை
  செய்யும் ஒரு quote கொண்டுவந்தால் ஒழிய; அப்படி வந்தால் loan-இன்
  asset-இலேயே பணம் வரும். பெரும்பாலான claim-களில் quote எதுவும்
  இருப்பதில்லை. வழக்கமான
  liquidation-உம் கால-அடிப்படை default-உம் exchange-ஐ நாடும் முன்
  அந்த உள்ளகப் பொருத்தத்தை முயல்கின்றன; எனவே இவ்விரு வழிகளிலும்
  எதுவும் எப்போதும் ஒரே வடிவத்தில் முடிவதில்லை; அதனால்தான் வழியை
  அல்ல, claim-ஐப் படிக்க வேண்டும். தள்ளுபடி வழி மட்டும் உறுதியானது,
  ஆனால் எதிர்த்திசையில்: அது விற்பதுமில்லை, பொருத்துவதுமில்லை; எனவே
  அது எப்போதும் collateral-ஐயே விட்டுச்செல்லும். பகுதி liquidation என்பது close-out-ஏ அல்ல —
  loan திறந்தே இருக்கும், claim-உம் உருவாகாது. எது என்று ஊகிக்காமல்
  claim-ஐப் பாருங்கள். Illiquid asset-இன்
  default-இல் முழு basket-உம் போய்விடும், எதுவும் மிஞ்சாது —
  இந்த வழியில் அதுவே விதி, விளைவு அல்ல.

Borrower position NFT நீங்கள் claim செய்யும்போது burn ஆகும், loan
தீரும்போது அல்ல — எனவே liquidation விட்டுச்சென்ற surplus பின்னரும்
பெறக் கிடைக்கும். ஆனால் NFT எஞ்சியிருப்பது surplus இருப்பதற்குச் சான்று
அல்ல: liquidation ஒன்றும் விட்டுச்செல்லவில்லை என்றால், பெறுவதற்கு எதுவும்
இல்லை, claim மறுக்கப்படும், NFT இருந்தாலும் இருக்கும்.
NFT-ஐ அல்ல, claim-ஐப் படியுங்கள்.

---

<a id="chapter.activity"></a>

## Activity

<a id="activity.feed"></a>

### Activity Feed

Active chain-இல் உங்கள் wallet தொடர்புடைய on-chain events, sliding block
window-இல் protocol logs-இலிருந்து live ஆக sourced. Backend cache இல்லை —
ஒவ்வொரு page load-உம் மீண்டும் fetch செய்கிறது. Multi-event transactions
(உதாரணமாக, ஒரே block-இல் உறுதியாகும் accept + initiate) ஒன்றாகத்
தெரிய, events transaction hash மூலம் group செய்யப்படுகின்றன. Newest
first. Offers, loans, repayments, claims, liquidations, NFT mints மற்றும்
burns, VPFI vault deposits / withdrawals ஆகியவை காட்டப்படும்.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI பெறுதல்

VPFI சுதந்திரமாக transfer செய்யக்கூடியது. அது trade ஆகும் எந்த
open market-இலும் அதை வாங்கலாம், அல்லது bridge மூலம் கொண்டுவரலாம்:
VPFI ஒரு Chainlink CCIP cross-chain token; அதனால் official bridge
மூலம் ஆதரிக்கப்படும் chains இடையே நகர்ந்து, நீங்கள் bridge செய்த
chain-இல் உங்கள் wallet-க்கு வந்துசேரும்.

<a id="buy-vpfi.discount-status"></a>

### உங்கள் VPFI Discount Status

Live status:

- தற்போதைய tier (0 முதல் 4 வரை).
- Vault VPFI balance கூடவே அடுத்த tier-க்கான gap.
- தற்போதைய tier-இல் Discount percentage.
- Wallet-level consent flag.

Vault VPFI deposit ஆகி இருக்கும் வரை அது உங்கள் discount tier-க்கு
கணக்கிடப்படும் — தனி "stake" action இல்லை.

<a id="buy-vpfi.deposit"></a>

### VPFI-ஐ உங்கள் vault-க்கு deposit செய்யுங்கள்

உங்கள் wallet-இலிருந்து அதே chain-இல் உள்ள vault-க்கு தனியான explicit
deposit step. Spec-இன் படி vault deposit எப்போதும் explicit user action
ஆகவே இருக்க வேண்டும்; எனவே ஒவ்வொரு chain-இலும் — canonical-இலும் கூட —
இது தேவை. Permit2 configure செய்யப்பட்ட chains-களில், App classic approve
+ deposit pattern-க்கு பதிலாக single-signature path-ஐ விரும்புகிறது; அந்த
chain-இல் Permit2 configure செய்யப்படவில்லை என்றால் cleanly fall back
ஆகும்.

<a id="buy-vpfi.unstake"></a>

### உங்கள் vault-இலிருந்து VPFI-ஐ unstake செய்யுங்கள்

VPFI-ஐ உங்கள் vault-இலிருந்து மீண்டும் wallet-க்கு withdraw செய்யுங்கள்.
தனி approval leg இல்லை — Protocol vault-ஐ வைத்திருக்கிறது மற்றும்
தன்னையே debit செய்கிறது. Withdraw, நீங்கள் ஈடுபட்டுள்ள ஒவ்வொரு open
loan-க்கும் புதிய (குறைந்த) balance அடிப்படையில் உடனடி fee-discount rate
re-stamp-ஐத் தூண்டும். பழைய tier தொடரும் grace window இல்லை.

<a id="buy-vpfi.cross-chain-tier"></a>

### உங்கள் VPFI tier chain-களுக்கு இடையே எப்படிச் செல்கிறது

நீங்கள் VPFI-ஐ canonical chain ஆன Base-இல் உள்ள உங்கள் vault-இல்
வைத்திருக்கிறீர்கள்; உங்கள் tier-ஐக் கணக்கிடுவது Base. வேறொரு chain-இல்
நீங்கள் கடன் வாங்கும்போதோ கொடுக்கும்போதோ, அந்த chain உங்கள் tier-இன்
ஒரு நகலைப் பயன்படுத்துகிறது. உங்கள் tier-ஐ மாற்றும் ஒவ்வொரு deposit,
withdrawal அல்லது பிற செயலுக்குப் பிறகும் Base இந்த நகலை Chainlink CCIP
வழியாக அனுப்புகிறது.

தெரிந்துகொள்ள வேண்டிய மூன்று விஷயங்கள்:

- **காலம் கடந்ததால் மட்டுமே உயர்ந்த tier, செல்ல Base-இல் ஒரு செயல்
  தேவை.** Deposit அல்லது withdrawal இல்லாமல் உங்கள் holding காலம்
  நிறைவடைந்தாலோ உங்கள் சராசரி ஈடுகொடுத்தாலோ, Base-இன் சொந்த மதிப்பு
  உடனே புதுப்பிக்கப்படும். மற்ற chain-கள் அதை Base-இல் உங்கள் அடுத்த
  deposit அல்லது withdrawal-இன்போது (எந்தத் தொகையானாலும்) அறிகின்றன.
- **குறைந்த tier முதலில் செல்கிறது.** Protocol குறைந்த tier-ஐ உடனே
  அனுப்புகிறது; உயர்ந்த tier-க்கு ஒவ்வொரு chain-க்கும் நாளொன்றுக்கு
  அதிகபட்சம் ஒருமுறை மட்டுமே செலவை ஏற்கிறது. அதன் பிறகு CCIP வழியாகச்
  சேர பொதுவாகச் சில நிமிடங்கள் ஆகும். சேரும்வரை அந்த chain உங்கள் முந்தைய
  tier-ஐயே பயன்படுத்துகிறது.
- **நகல் காலாவதியாகலாம்.** புதிய நகல் இல்லாமல் 60 நாட்கள் (default)
  கடந்தால், அல்லது tier table மாற்றம் அந்த chain-ஐ அடைந்தால், பழைய நகல்
  அங்கே தள்ளுபடி தராது. உங்கள் tier மாறும்போது மட்டுமே புதிய நகல்
  அனுப்பப்படும்.

நீங்கள் பயன்படுத்தும் chain-இல் மட்டுமல்லாமல் Base-இலும் தேவைப்படும்
தள்ளுபடி switch உட்பட முழு விதிகளும் கீழே உள்ள "VPFI தள்ளுபடிகள் எப்படி
வேலை செய்கின்றன" அத்தியாயத்தில் உள்ளன. Delivery வடிவமைப்பு
[tier delivery வடிவமைப்பு ஆவணத்தில்](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
(ஆங்கிலத்தில்) உள்ளது.

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards பற்றி

**Interaction pool** ஒரு நிலையான daily emission-இன் per-day pro-rata
share-ஐ வழங்குகிறது, அந்த நாளின் loan volume-க்கு உங்கள்
settled-interest பங்களிப்பால் weighted. Window close-க்குப் பிறகு
முதல் claim அல்லது settlement-இல் daily windows lazy ஆக finalise
ஆகின்றன.

Rewards active chain-இல் நேரடியாக mint செய்யப்படுகின்றன — பயனருக்கு
cross-chain round-trip இல்லை. Cross-chain reward aggregation protocol
contracts-களுக்குள் மட்டுமே நடக்கும்.

<a id="rewards.claim"></a>

### Rewards Claim செய்யுங்கள்

ஒரே transaction உங்கள் accrued rewards-ஐ claim செய்கிறது. relevant
daily window finalise ஆகும் வரை interaction rewards zero (அந்த
chain-இல் அடுத்த non-zero claim அல்லது settlement தூண்டும் lazy
finalisation வரை). Window இன்னும் finalise ஆகிக் கொண்டிருக்கும்போது
UI button-ஐ guard செய்கிறது, எனவே பயனர்கள் under-claim செய்வதில்லை.

<a id="rewards.withdraw-staked"></a>

### Vault-இலிருந்து VPFI-ஐ Withdraw செய்யுங்கள்

VPFI section-இல் "உங்கள் vault-இலிருந்து VPFI-ஐ unstake செய்யுங்கள்"-க்கு
இணையான interface — Vault-இலிருந்து மீண்டும் wallet-க்கு VPFI withdraw
செய்யுங்கள். Withdrawn VPFI discount accumulator-இலிருந்து உடனடியாக
வெளியேறும் (ஒவ்வொரு open loan-இல் post-balance re-stamp).

---

<a id="chapter.loan-details"></a>

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (இந்த page)

Protocol-இலிருந்து live ஆக derive செய்யப்பட்ட single-loan view, கூடவே
risk engine-இலிருந்து live HF மற்றும் LTV. Terms, collateral risk,
parties, உங்கள் role மற்றும் loan-இன் status-ஆல் கட்டுப்படுத்தப்பட்ட
actions, inline keeper status ஆகியவற்றை render செய்கிறது.

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
"n/a" ஆகக் காட்டப்படும். ஒரே terminal path default-இல் முழு collateral transfer —
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
volatility-ஐத் தாங்க பொதுவான safety margin 1.5. HF-ஐ உயர்த்தும்
levers:

- **Add collateral** — Basket-ஐ top up செய்யுங்கள். User-only action.
- **Partial repay** — Debt-ஐக் குறைக்கிறது, HF-ஐ உயர்த்துகிறது.

HF 1.0-க்குக் கீழே சென்றவுடன், யாரும் HF-based liquidation-ஐ trigger
செய்யலாம்; swap உங்கள் collateral-ஐ slippage-ஆல் பாதிக்கப்பட்ட விலையில்
விற்று lender-க்கு திருப்பிச் செலுத்தும். Illiquid collateral-இல்,
default உங்கள் முழு collateral-ஐ lender-க்கு transfer செய்கிறது; claim
செய்ய எதுவும் மீதியில்லை.

<a id="loan-details.parties"></a>

### Parties

Lender, borrower, lender vault, borrower vault, மற்றும் இரண்டு position
NFTs (ஒவ்வொரு பக்கத்திற்கும் ஒன்று). ஒவ்வொரு NFT-யும் on-chain metadata
கொண்ட ERC-721; அதை transfer செய்வது claim உரிமையையும் transfer செய்கிறது.
Vault contracts ஒரு address-க்கு deterministic — deploys-களில் அதே address.

<a id="loan-details.actions"></a>

### Actions

Action interface protocol-ஆல் role அடிப்படையில் gated. கீழே உள்ள
role-specific tabs ஒவ்வொரு பக்கத்துக்கும் கிடைக்கும் actions-ஐ
பட்டியலிடுகின்றன. Disabled actions, gate-இலிருந்து derive செய்யப்பட்ட
hover-reason-ஐ காட்டும் ("Insufficient HF", "Not yet expired", "Loan
locked" போன்றவை).

Role-இப் பொருட்படுத்தாமல் யாரும் செய்யக்கூடிய permissionless actions:

- **Trigger liquidation** — HF 1.0-க்குக் கீழே drop ஆகும்போது.
- **Mark defaulted** — Full repayment இல்லாமல் grace period முடிவடைந்தபோது.

<a id="loan-details.actions:lender"></a>

#### நீங்கள் lender-ஆக இருந்தால்

- **Claim as lender** — Terminal state-இல் மட்டும். Principal மற்றும் interest minus
  உங்கள் loan உருவாக்கப்பட்டபோது நிலைநிறுத்தப்பட்ட treasury cut-ஐ
  கழித்து திருப்பித் தருகிறது (தற்போதைய விகிதத்தில் உருவாக்கப்படும்
  loans-க்கு `{liveValue:treasuryFeeBps}`%; consent on ஆக
  இருக்கும்போது உங்கள் time-weighted VPFI yield-fee discount-ஆல்
  மேலும் குறையும்).
  Lender position NFT-ஐ burn செய்கிறது.
- **Initiate early withdrawal** — asking price-இல் lender position NFT-ஐ
  விற்பனைக்கு list செய்கிறது. விற்பனையை நிறைவு செய்யும் buyer உங்கள்
  பக்கத்தை எடுத்துக்கொள்கிறார்; நீங்கள் proceeds-ஐப் பெறுகிறீர்கள்.
  sale fill ஆகும்முன் cancel செய்யலாம்.
- Relevant action permission வைத்திருக்கும் ஒரு keeper-க்கு optional-ஆக
  delegatable — Keeper Settings-ஐப் பார்க்கவும்.

<a id="loan-details.actions:borrower"></a>

#### நீங்கள் borrower-ஆக இருந்தால்

- **Repay** — Full அல்லது partial. Partial repayment outstanding-ஐக் குறைத்து
  HF-ஐ உயர்த்துகிறது; full terminal settlement-ஐத் தூண்டுகிறது.
- **Preclose direct** — இப்போது உங்கள் wallet-இலிருந்து outstanding
  amount-இல் செலுத்துங்கள், collateral-ஐ release செய்யுங்கள்.
- **Preclose offset** — Protocol-இன் swap router வழியாக சில collateral-ஐ
  விற்று, proceeds-இலிருந்து திருப்பிச் செலுத்தி, மீதியை திருப்பித்
  தருகிறது. Two-step: initiate, பிறகு complete.
- **Refinance** — புதிய terms-க்கு ஒரு borrower offer post செய்யுங்கள்;
  ஒரு lender accept செய்தவுடன், complete refinance, collateral உங்கள்
  vault-ஐ விட்டு வெளியேறாமல் loans-ஐ atomically swap செய்கிறது.
- **Claim as borrower** — Terminal state-இல் மட்டும். Full repayment-இல் collateral-ஐ,
  திருப்பித் தருகிறது; default / liquidation-இல் surplus மிச்சம்
  இருக்கலாம் — கடனுக்கும் அதை முடிக்கும் செலவுக்கும் தேவையான அளவு
  collateral மட்டுமே எடுக்கப்படுவதால்; மேலே உள்ள Claim Center பகுதியைப்
  பார்க்கவும். Borrower position NFT-ஐ burn செய்கிறது.

---

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Prepay listing-இல் OpenSea offers-இல் match செய்தல்

உங்கள் prepay listing OpenSea-வின் marketplace-இல் live ஆனவுடன்,
casual buyers சில சமயங்களில் உங்கள் token-இல் நேரடியாக **item
offers**-ஐ place செய்வார்கள் — collection-இல் உள்ள எந்த token-உடன்
அல்ல, உங்கள் specific collateral-உடன் tied bids. Vaipakam இந்த
item offers-ஐ Loan Details page-இல் real-time-இல் surface
செய்கிறது — "OpenSea-இல் collateral-ஐ list செய்" கீழே per incoming offer
ஒரு row-உடன் separate panel. Panel ஒரு **buffer threshold**-ஐ
apply செய்கிறது — lender-இன் settlement entitlement (இது
ஏற்கனவே principal plus full coupon (full-term-interest loans-இல்)
அல்லது pro-rata interest (இல்லாதபோது)-இல் include செய்கிறது —
`PrepayListingFacet.getPrepayContext().lenderLeg`-ஐ பார்க்கவும்),
plus treasury cut, plus safety buffer — மற்றும் அதை clear
செய்யாத offers-ஐ **greys out** செய்கிறது. நீங்கள் ஒவ்வொரு
level-இலும் market interest-ஐ பார்க்கலாம் ஆனால் protocol
actually settle செய்யும் offers-ஐ மட்டுமே Match செய்ய முடியும்.

Collection-wide / criteria offers (collection-இல் உள்ள எந்த
token-ம் fulfill செய்யக்கூடிய bids) OpenSea-இல் தங்கும் ஆனால்
dapp-இன் Match panel-இல் **தோன்றாது** — protocol settle செய்யும்
multi-leg consideration v1-இல் இல்லாத contract-side plumbing
இல்லாமல் criteria offer-க்கு எதிராக reconstruct செய்ய முடியாது.
உங்கள் only inbound demand collection-wide என்றால், இன்றைய
practical path item-specific bid-க்காக காத்திருப்பது அல்லது
listing-ஐ உங்கள் fixed ask-இல் விட்டுவிட்டு எந்த buyer-ம் அதை
directly fulfill செய்ய அனுமதிப்பது. Collection-wide bid-ஐ
manually நீங்களே settle செய்ய முடியாது — collateral NFT உங்கள்
Vaipakam vault-இல் வாழ்கிறது, மற்றும் Vaipakam-side Seaport
orders-தான் ஒரே authorised settlement shape ஆகும்.

OpenSea protocol fees மற்றும்/அல்லது creator royalties-இல் enforce
செய்யும் collections-இல், dapp offers panel-ஐ render செய்கிறது
— OpenSea API-இல் இருந்து fee-schedule fetch advisory-ஆக
கருதப்படுகிறது; actual fulfillment data MATCH CLICK TIME-இல்
fetch செய்யப்படுகிறது. Match panel fee-schedule fetch status-ஐ
பொருட்படுத்தாமல் render ஆகிறது; click-time fulfillment-data
fetch-தான் gate. அந்த fetch fail ஆனால் (rate limit, API
outage, அல்லது unsupported collection shape), dapp-side Match
click handler எந்த `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
transaction-இல் construct செய்யப்படுவதற்கு முன் ABORT ஆகிறது —
calldata இல்லை, signature prompt இல்லை, revert இல்லை. On-chain
function தானே `bool`-returning selector அல்ல; அது run ஆகும்போது
`bytes32` orderHash-ஐ return செய்கிறது அல்லது revert ஆகிறது.
எனவே fee-enforced collection-இன் panel browse செய்யக்கூடிய
offers-இல் காட்டலாம் ஆனால் அவை அனைத்தும் ஒரு given moment-இல்
clickable-to-match அல்ல.

நீங்கள் ஒரு acceptable offer-இல் கண்டறிந்து **Offer-ஐ match செய்**-இல்
click செய்தால், dapp **Match-ஐ உறுதி செய்** modal-ஐ திறக்கிறது,
இது match செய்யப்பட்ட value-இல் (gross OpenSea offer amount — diamond
settle செய்யும் net amount அல்ல; fee-enforced collections-இல்
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` lender /
treasury / borrower split-இல் run செய்வதற்கு முன் `effectiveAsk =
offerValue - bidderFeeTotal`-இல் கணக்கிடுகிறது, எனவே diamond
actually distribute செய்யும் net modal-இன் முக்கியமாக காட்டப்படும் amount-இல் விட
சிறியதாக இருக்கும்) மீண்டும் கூறுகிறது மற்றும் atomic-match
flow-இன் generic explanation-இல் கொடுக்கிறது. Confirm செய்த
பிறகு, dapp ஒரு single `matchOpenSeaOffer` transaction-இல்
அனுப்புகிறது இது bidder-இன் offer-இல் freshly-constructed
diamond-side counter-order-உடன் ஒற்றை Seaport
`matchAdvancedOrders` call-இல் bundle செய்கிறது — bidder-இன்
fulfilment, counter-order-இன் listing-side leg (உங்களுக்கு
prior v1 prepay listing live இருந்திருந்தாலும் இல்லாவிட்டாலும்;
atomic path `existingHash == 0`-இல் support செய்கிறது), மற்றும்
diamond-இன் settlement waterfall எல்லாம் ஒரு block-இல் atomic-ஆக
land ஆகின்றன. Transaction either முழுமையாக success ஆகிறது
(loan repaid-ஆக மூடப்படுகிறது, NFT transferred, sale proceeds split) அல்லது
முழுமையாக revert ஆகிறது (எதுவும் நகராது), மற்றும் listing
rotation மற்றும் settlement-க்கு இடையில் ஒரு third-party buyer
matched price-இல் step in செய்யக்கூடிய **window இல்லை**.

> **Race window இல்லை — atomic by construction.** இது v1
> two-step "cancel + post" pattern-இன் structural close-out:
> v1 கீழ் dapp listing-ஐ separate `updatePrepayListing`
> transaction-ஆக rotate செய்யும், rotated price-இல் OpenSea-இல்
> bidder-இன் `fulfillOrder` later block-இல் land ஆகும் வரை
> live-ஆக விட்டுவிடும் — mempool-இல் பார்க்கும் யாரும் bidder-இல்
> அவர் bid செய்த price-இல் இருந்து snipe செய்யலாம். Atomic
> path இரண்டு orders-ஐ ஒரு Seaport match call-இல் bind
> செய்வதன் மூலம் அந்த hole-இல் closes செய்கிறது: either bidder
> agreed price-இல் fills செய்கிறார் அல்லது whole transaction
> revert ஆகிறது.

**Match-ஐ click செய்வதற்கு முன் நீங்கள் verify செய்ய விரும்புபவை:**

- **Modal-இல் match செய்யப்பட்ட value-இல் confirm செய்.** Modal gross
  OpenSea offer amount-இல் surface செய்கிறது. Fee-enforced
  collections-இல், diamond bidder-side marketplace / creator
  fee legs-க்கு பிறகு net effective ask-க்கு எதிராக settle
  செய்கிறது, எனவே modal value lender / treasury / borrower
  split-க்கு பயன்படுத்தப்பட்ட amount-இல் விட அதிகமாக இருக்கலாம்.
  Bidder address மற்றும் precise split modal-இலோ OpenSea
  Offers panel row-இலோ broken out இல்லை (row value, payment
  token, offer kind, truncated bidder, மற்றும் end time-இல்
  காட்டுகிறது). Split settlement-இல் diamond-ஆல் on-chain
  enforce செய்யப்படுகிறது — protocol-இன் settlement buffer
  effective ask lender-இன் settlement entitlement-இல் (இது
  ஏற்கனவே principal plus full coupon (full-term-interest
  loans-இல்) அல்லது pro-rata interest (இல்லாதபோது)-இல் include
  செய்கிறது) plus treasury cut-இல் cover செய்கிறது என்பதை
  guarantee செய்கிறது, எனவே split எப்போதும் உங்களுக்கு
  குறைந்தபட்சம் neutral. Confirm செய்வதற்கு முன் projected
  split-இல் பார்க்க விரும்பினால், diamond
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`-இல்
  callable view-ஆக expose செய்கிறது — இது given timestamp-இல்
  settlement waterfall route செய்யும் lender மற்றும் treasury
  legs-இல் return செய்கிறது, மற்றும் remainder உங்களுடையது.
- **Collection-க்கான OpenSea-வின் fee posture-இல் check செய்.**
  Collection OpenSea protocol fees அல்லது creator royalties-இல்
  enforce செய்தால், atomic path-க்கு SignedZone `extraData` /
  criteria-resolver plumbing தேவை, இதை dapp agent-இன் OpenSea
  fulfillment-data proxy (PR #349) மூலம் MATCH CLICK TIME-இல்
  fetch செய்கிறது. Match panel fee-schedule fetch status-இல்
  பொருட்படுத்தாமல் render ஆகிறது; click-time fulfillment-data
  fetch-தான் gate. அந்த fetch fail ஆனால் (rate limit, API
  outage, unsupported collection shape), dapp-side click handler
  on-chain `matchOpenSeaOffer` transaction-இல் construct
  செய்வதற்கு முன் abort ஆகிறது — calldata build ஆகாது,
  signature prompt fire ஆகாது, banner-இல் முன்னதாக காட்டப்படாது.
  பின்னர் click-இல் retry செய்யலாம் (fetch வெறும் transient API
  blip-ஆக இருக்கலாம்), அல்லது இதற்கிடையில் OpenSea-இல் listed
  ask-இல் listing-இல் நேரடியாக fulfill செய்யலாம்.

---

<a id="chapter.how-liquidation-actually-works"></a>

## Liquidation உண்மையில் எப்படி செயல்படுகிறது

Offer உருவாக்கும் போது நீங்கள் ஒப்புக்கொண்ட Risk Disclosures, மோசமான விளைவை இரண்டு வாக்கியங்களில் விளக்குகின்றன. இந்த பகுதி அதன் பின்னணியில் உள்ள தொழில்நுட்ப முறைகளை விளக்குகிறது — in-kind fallback ஏன் உள்ளது என்பதைப் புரிந்துகொள்ள அல்லது உங்கள் loan நான்கு வழிகளில் எதை எடுக்கும் என்பதை அறிய இது பயனுள்ளதாக இருக்கும்.

split-ஐ தீர்மானிக்கும் contract function 'LibFallback.computeFallbackEntitlements' ஆகும். இது நான்கு வழிகளை வரிசையாகப் பார்க்கிறது; முதலில் பொருந்தும் வழியே செயல்படுத்தப்படும்.

<a id="liquidation-mechanics.case-1"></a>

### Case 1 — Oracle கிடைக்கிறது, collateral மதிப்பு ≥ பாக்கித் தொகை

இது ஒரு சாதாரண வழி. Chainlink price feeds பதிலளிக்கின்றன, Soft 2-of-N secondary quorum (Tellor + API3 + DIA) முரண்படவில்லை, மேலும் பறிமுதல் செய்யப்பட்ட collateral, oracle விலையில் கணக்கிடும்போது பாக்கித் தொகையை விட அதிகமாக உள்ளது.

என்ன நடக்கும்:

- கடனாளர் (lender) பாக்கித் தொகைக்கு (principal + accrued interest + 3% fallback bonus) இணையான **collateral asset**-ஐ oracle விலையில் பெறுகிறார். நடைமுறையில்: கடனாளர் நியாயமான மதிப்பில், கடன் வழங்கிய asset-க்கு பதிலாக collateral asset-இல் முழுமையாக ஈடு செய்யப்படுகிறார்.
- Treasury, principal-இல் 2% பிரீமியத்தைப் பெறுகிறது, இதுவும் collateral-இல் மதிப்பிடப்படும்.
- கடன் பெறுபவர் (borrower) எஞ்சியிருக்கும் collateral-ஐத் திரும்பப் பெறுகிறார். இது ஒரு உண்மையான பணத்தைத் திரும்பப் பெறுதல் — lender-ன் கோரிக்கையை ஈடுகட்டத் தேவையில்லாத over-collateralisation இது.

எடுத்துக்காட்டு: 1000 USDC கடன், 0.6 WETH ($3000 collateral, $1000 கடன்) பிணையத்தில். Oracle ETH விலையை $5000 / WETH என காட்டுகிறது; கடன் + வட்டி + போனஸ் = $1050. Lender 0.21 WETH ($1050 மதிப்பு), treasury 0.004 WETH ($20 மதிப்புள்ள 2% பிரீமியம்), borrower மீதமுள்ள ~0.386 WETH-ஐப் பெறுகிறார்.

<a id="liquidation-mechanics.case-2"></a>

### Case 2 — Oracle கிடைக்கிறது, collateral மதிப்பு < பாக்கித் தொகை

இது collateral மதிப்பு குறைந்த நிலை. Oracle வேலை செய்கிறது, ஆனால் பறிமுதல் செய்யப்பட்ட collateral, oracle விலையில் கூட பாக்கித் தொகையை விட குறைவாக உள்ளது. Collateral மதிப்பு HF எதிர்வினை காட்டுவதை விட வேகமாக குறையும் சந்தர்ப்பங்களில் இது நடக்கும்.

என்ன நடக்கும்:

- Lender பறிமுதல் செய்யப்பட்ட **அனைத்து** collateral-ஐயும் பெறிறார்.
- Treasury-க்கு எதுவும் கிடைக்காது.
- Borrower-க்கு எதுவும் கிடைக்காது — திரும்பப் பெற எஞ்சிய தொகை இல்லை.

Lender இந்த இழப்பை ஏற்கிறார். Borrower, protocol அல்லது எந்த மூன்றாம் தரப்பினரிடமும் மேலதிகக் கோரிக்கை வைக்க முடியாது. Risk Disclosures-இல் உள்ள "மீட்பு தொகை கடன் கொடுத்த asset-ஐ விட குறைவாக இருக்கலாம்" என்ற எச்சரிக்கை இதைக் குறிக்கிறது.

எடுத்துக்காட்டு: அதே 1000 USDC / 0.6 WETH கடன், ஆனால் ETH விலை $1500 / WETH ஆக குறைகிறது. Collateral இப்போது $900; கடன் $1050. Lender அனைத்து 0.6 WETH ($900 மதிப்பு) பெறுகிறார், treasury 0, borrower 0.

<a id="liquidation-mechanics.case-3"></a>

### Case 3 — Oracle quorum கிடைக்கவில்லை

இது oracle தரவு கிடைக்காத நிலை. Chainlink staleness அதிகபட்ச எல்லையைத் தாண்டிவிட்டது மற்றும் 2-of-N secondary quorum முடிவெடுக்க முடியவில்லை (அனைத்து secondary-களும் ஆஃப்லைனில் உள்ளன அல்லது primary-உடன் முரண்படுகின்றன). Protocol-இடம் இரு பக்கங்களுக்கும் நம்பகமான விலை இல்லை, எனவே நியாயமான பிரிப்பை கணக்கிட முடியாது.

என்ன நடக்கும்:

- கணக்கிடப்பட்ட மதிப்பைத் பொருட்படுத்தாமல், பறிமுதல் செய்யப்பட்ட **அனைத்து** collateral-ஐயும் lender பெறுகிறார் (ஏனெனில் எந்த கணக்கீடும் நம்பகமானதல்ல).
- Treasury-க்கு எதுவும் கிடைக்காது.
- Borrower-க்கு எதுவும் கிடைக்காது.

இது Case 2-ஐப் போன்றே இருந்தாலும், ஒரு அடிப்படை காரணத்திற்காக இந்த நிலை எட்டப்படுகிறது: protocol "collateral கடனை விட மதிப்பு குறைந்தது" என்று முடிவு செய்யவில்லை — மாறாக "இங்கே எந்த எண்ணையும் நம்ப முடியாது, எனவே lender அனைத்து collateral-ஐயும் பெற்றுக்கொண்டு, அதன் சந்தை மதிப்பு என்னவாக இருந்தாலும் அதை ஏற்கட்டும்" என்று முடிவு செய்கிறது.

தணிக்கையாளர்கள் பின்னாளில் இந்த இரு வழிகளையும் வேறுபடுத்திப் பார்க்க 'LiquidationFallbackOracleUnavailable' என்ற தனி on-chain event வெளியிடப்படுகிறது.

<a id="liquidation-mechanics.case-4"></a>

### Case 4 — ஏதேனும் ஒரு பக்கத்தில் Illiquid asset உள்ளது

இது illiquid-asset வழி. கடன் வழங்கும் asset, collateral asset அல்லது இரண்டுமே protocol-ன் தரம் பிரிப்பில் Liquid ஆக தகுதி பெறவில்லை (Chainlink feed இல்லை, அல்லது போதிய அளவு கொண்ட Uniswap-V3 போன்ற pool இல்லை). இது பொதுவாக NFT collateral மற்றும் சிறிய tokens-களுக்கு நடக்கும்.

Default நேரத்தில் என்ன நடக்கும்:

- சந்தை மதிப்பைத் பொருட்படுத்தாமல், lender **முழு collateral**-ஐயும் பெறிறார்.
- "பாக்கித் தொகை" மற்றும் "எஞ்சிய தொகை" என்று பிரிக்க முடியாது — oracle விலையை இதைப் பயன்படுத்த முடியாது.
- Asset-ன் மதிப்பு கடனை விட அதிகமாகவோ அல்லது குறைவாகவோ இருக்கலாம். அதை மீண்டும் விற்பதற்கான எந்த உத்தரவாதமும் இல்லை.

Offer உருவாக்கப்படும்போது இரு தரப்பினரும் இதற்குச் சம்மதித்துள்ளனர் — Risk Disclosures-இல் உள்ள illiquid-asset விதி சரியாக இதையே விளக்குகிறது. Illiquid asset-ஐப் பயன்படுத்தி கடன் வழங்க இரு தரப்பினரும் தெரிந்தே தேர்வு செய்தால் ஒழிய இந்த வழியை எட்ட முடியாது.

<a id="liquidation-mechanics.why-in-kind"></a>

### ஏன் in-kind, ஏன் எப்போதும் பணமாக இல்லை?

Protocol எப்போதும் கடன் வழங்கிய asset-க்கு மாற்றாமல், ஏன் collateral asset-ஆகவே வழங்குகிறது என்பதற்கு மூன்று காரணங்கள் உள்ளன:

- **Sequencer / DEX செயலிழப்பு**: Protocol-ஆல் பாதுகாப்பாக ஒரு swap-இல் செய்ய முடியாதபோது (slippage > 6%, குறைந்த அளவு, DEX மாற்றம், sequencer முடக்கம்), சிறந்த வழி தன்னிடம் உள்ள பறிமுதல் செய்யப்பட்ட collateral-இல் நேரடியாக வழங்குவதே ஆகும். எந்த விலையிலும் swap செய்ய கட்டாயப்படுத்துவது நஷ்டத்தை உருவாக்கும்.
- **Black-swan சூழல்**: சந்தை சரிவுகளில், oracle விலைகள் சில நிமிடங்களில் மறைந்துவிடும். In-kind fallback-இல் முன்கூட்டியே வைத்திருப்பது, விலை ஆதாரங்கள் குறைந்தாலும் protocol செயல்பட உதவுகிறது.
- **Counterparty-pair மீட்பு**: Claim நேரத்தில், lender (அல்லது அவர்களின் keeper bot) 4-DEX failover-இல் மீண்டும் முயற்சி செய்ய வாய்ப்பு பெறுகிறார். அதற்குள் நிலைமை சீராகிவிட்டால், அவர்கள் collateral-இல் கடன் வழங்கிய asset-க்கு மாற்றிக் கொள்ளலாம்.

<a id="liquidation-mechanics.claim-time-retry"></a>

### Claim-time retry

loan 'FallbackPending' நிலையில் இருக்கும்போது, lender (அல்லது lender-இன் NFT மூலம் செயல்படும் ஒரு keeper) 4-DEX failover (0x → 1inch → Uniswap V3 → Balancer V2) முயற்சிகளைத் தர முடியும். Library ஒவ்வொன்றாக முயற்சி செய்து, முதல் வெற்றியில் lender + borrower claims-இல் principal-asset ஆக மாற்றுகிறது.

முழுமையாகத் தோல்வியடைந்தால், பதிவு செய்யப்பட்ட collateral பிரிப்பு அப்படியே இருக்கும் மற்றும் loan 'Defaulted' நிலைக்கு மாறும் — அந்த நிலையில் lender in-kind collateral-இல் பெற்றுக்கொண்டு அதை எங்கும் விற்றுக்கொள்ளலாம்.

<a id="liquidation-mechanics.internal-match-rescue"></a>

### Pre-claim internal-match rescue

எந்த வெளிப்புற swap-இல் இயங்கும் முன் — HF-liquidation, காலாவதி default மற்றும் claim நேரத்தின் போது — protocol முதலில் இந்த loan-இல் DEX உதவியின்றி தீர்க்கக்கூடிய **எதிர் திசையில் ஒரு loan** உள்ளதா என்று பார்க்கிறது.

Loan A, WETH-இல் விற்று USDC பெற வேண்டும் மற்றும் Loan B, USDC-இல் விற்று WETH பெற வேண்டும் என்றால், இரண்டையும் நேரடியாகப் பொருத்தலாம்: A-இன் collateral B-இன் கடனை மறைக்கும் மற்றும் நேர்மாறாக, protocol-இன் oracle விலையில். Slippage இல்லை, swap fee இல்லை. Borrower அதிக அளவு collateral-இல் தக்கவைத்துக் கொள்கிறார்; lender oracle விலையில் முழுமை பெறுகிறார்.

இந்த internal-match வழி தானாகவே இயங்கும்:

- **At HF-liquidation-இல்** — ஒரு keeper liquidate call செய்யும்போது எதிர் loan இருந்தால், protocol வெளிப்புற swap செய்யாமல் உள்நாட்டிலேயே தீர்க்கிறது. Keeper இன்னும் matcher ஊக்கத்தொகையைப் பெறுவார்.
- **At காலாவதி default-இல்** — default swap-இல் முன் அதே சோதனை நடக்கும்.
- **At claim நேரத்தில்** — 'FallbackPending'-இல் சிக்கியுள்ள loan-இல் lender claim செய்யும்போது, protocol மீண்டும் எதிர் loan உள்ளதா என்று பார்க்கிறது. இது ஒரு உண்மையான இரண்டாவது வாய்ப்பு: பொருத்தக்கூடிய loans-களின் எண்ணிக்கை தொடர்ந்து வளர்ந்து கொண்டே இருக்கிறது, எனவே முதலில் liquidation தோல்வியடைந்தபோது இல்லாத ஒரு loan நீங்கள் claim செய்யும்போது இருக்கலாம்.

வெளிப்புற swap தற்காலிகமாகத் தோல்வியடைந்ததால் (தற்காலிக slippage spike, DEX மாற்றம், பழைய oracle tick) 'FallbackPending'-இல் விழுந்த ஒரு loan, இந்த மீட்புக்கு சிறந்த தகுதியுடையது — அதன் பின்னணியில் உள்ள collateral பொதுவாக இன்னும் திரவமாக (liquid) இருக்கும், மேலும் ஒரு எதிர் loan அதைச் சுத்தமாகத் தீர்க்க முடியும். Protocol-க்கு oracle விலை மட்டுமே தேவை; DEX ஆழம் (depth) தேவலையில்லை, ஏனெனில் internal match ஒருபோதும் DEX-இல் தொடாது.

எதிர் loan இல்லை என்றால், protocol மேலே விவரிக்கப்பட்ட வெளிப்புற aggregator வழிக்குச் செல்லும். Internal-match என்பது ஒரு சிறந்த தேர்வு (optimization), அது ஒருபோதும் தடையல்ல.

---

<a id="chapter.allowances"></a>

## Allowances

<a id="allowances.list"></a>

### Allowances

இந்த chain-இல் உங்கள் wallet protocol-க்கு வழங்கிய ஒவ்வொரு ERC-20
allowance-ஐயும் பட்டியலிடுகிறது. On-chain allowance views-க்கு எதிராக
candidate-token list-ஐ scan செய்வதன் மூலம் sourced. Revoking allowance-ஐ
zero-ஆக அமைக்கும்.

Exact-amount approval policy-இன் படி, protocol ஒருபோதும் unlimited
allowances-ஐ கேட்காது; எனவே வழக்கமான revocation list குறுகியது.

குறிப்பு: Permit2-style flows ஒரே signature-ஐப் பயன்படுத்தி protocol-இன்
per-asset allowance-ஐத் தாண்டிச் செல்கின்றன. எனவே இங்கே clean list இருந்தாலும்
எதிர்கால deposits தடுக்கப்படாது.

---

<a id="chapter.alerts"></a>

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
channel publishing தற்போது channel creation வரை stub நிலையில் உள்ளது.

---

<a id="chapter.nft-verifier"></a>

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### ஒரு NFT-ஐ Verify செய்யுங்கள்

NFT contract address மற்றும் token id கொடுக்கப்பட்டால், verifier fetch
செய்துவது:

- Token ஏற்கனவே burn செய்யப்பட்டிருந்தால் தற்போதைய owner (அல்லது
  ஒரு burn signal).
- On-chain JSON metadata.
- ஒரு protocol cross-check: metadata-இலிருந்து underlying loan id-இல்
  derive செய்து state-இல் உறுதிப்படுத்த protocol-இலிருந்து loan
  details-இல் படிக்கிறது.

இது வெளிப்படுத்துவது: Vaipakam-ஆல் mint செய்யப்பட்டதா? எந்த chain?
loan status? தற்போதைய holder? counterfeit NFT, ஏற்கனவே claim செய்யப்பட்ட
(burned) position, அல்லது loan settle ஆகி claimable நிலையில் இருக்கும்
position ஆகியவற்றைக் கண்டறிய உதவும்.

Position NFT bearer instrument — secondary market-இல் வாங்குவதற்கு முன்
verify செய்யுங்கள்.

---

<a id="chapter.keeper-settings"></a>

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers பற்றி

5 keepers வரை கொண்ட per-wallet keeper allowlist. ஒவ்வொரு keeper-க்கும்
**உங்கள் பக்கத்தில்** loan-இல் குறிப்பிட்ட maintenance calls-இல் authorise
செய்யும் action permission set இருக்கும். Money-out paths (repay, claim,
add collateral, liquidate) design-ஆல் user-only; delegate செய்ய முடியாது.

Action time-இல் இரண்டு கூடுதல் gates பொருந்தும்:

1. Master keeper-access switch — allowlist-இல் தொடாமல் ஒவ்வொரு keeper-இல்
   disable செய்யும் one-flip emergency brake.
2. Offer Book அல்லது Loan Details interface-இல் அமைக்கப்பட்ட per-loan
   opt-in toggle.

ஒரு keeper, நான்கு நிபந்தனைகளும் பூர்த்தியானபோது மட்டுமே act செய்ய
முடியும்: approved, master switch on, per-loan toggle on, மற்றும் அந்த
keeper-க்கு குறிப்பிட்ட action permission அமைக்கப்பட்டிருப்பது.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

தற்போது வெளிப்படுத்தப்பட்ட Action permissions:

- **Complete loan sale** (lender side, secondary-market exit).
- **Complete offset** (borrower side, collateral sale வழியாக preclose-இன்
  இரண்டாவது leg).
- **Initiate early withdrawal** (lender side, position-இல் விற்பனைக்கு
  list செய்).
- **Initiate preclose** (borrower side, preclose flow-இல் kick off செய்).
- **Refinance** (borrower side, ஒரு புதிய borrower offer-இல் atomic
  loan swap).

Frontend இன்னும் reflect செய்யாத on-chain permissions சேர்க்கப்பட்டால்,
அவை தெளிவான "invalid permission" revert-இல் பெறும். Revocation அனைத்து
loans-களிலும் உடனடி — காத்திருப்புக் காலம் இல்லை.

---

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics பற்றி

வாலட் இல்லாத, ஒரே செயின் பக்கம்: ஆப் சுட்டும் செயினைப் படிக்கிறது
(வாலட் இணைக்கப்படவில்லை என்றால் இயல்பான வாசிப்புச் செயின்).
செயின்களுக்கு இடையிலான தொகுப்போ ஏற்றுமதியோ இல்லை; செயின்களை ஒப்பிட
ஒவ்வொன்றிலும் பக்கத்தைத் திறக்கவும். இரண்டு மூலங்கள், பயன்படும்
இடத்தில் குறிக்கப்பட்டவை:

- இன்டெக்சரின் சாவி இல்லாத, திறந்த CORS வாசிப்பு API — கடன், ஆஃபர்,
  மறுசுழற்சி, லூப் மூடல் எண்கள்;
- பொது RPC வழியாக Diamond-இன் சொந்த வியூ செயல்பாடுகள் — VPFI
  டோக்கன் மற்றும் கட்டண எண்கள்.

பக்கம் காட்டுவதை மீண்டும் உருவாக்க எந்த மூலத்தையும் நேரடியாக
வினவலாம்.

<a id="public-dashboard.loans-offers"></a>

### கடன்களும் ஆஃபர்களும்

`/loans/stats`-இலிருந்து நிலைவாரியான கடன் கவுண்டர்கள், தீர்வு
நிலுவை, உள்ளே பொருத்தப்பட்டவை, மீதம் ஆகிய பிரிவுகள் உட்பட, எனவே
பகுதிகள் மொத்தத்துக்குச் சமம்; ERC-20, NFT வாடகை உட்கூட்டுத்தொகைகள்,
சொத்து வகை இன்னும் படிக்கப்படாத செயலில் உள்ள கடன் தனியாகக்
குறிப்பிடப்படும்; `/offers/stats`-இலிருந்து ஆஃபர் கவுண்டர்கள்.
ஆஃபர்கள் என்பவை `offers` அட்டவணை மட்டுமே — கேஸ் இல்லாத கையொப்பமிட்ட
ஆர்டர்கள் எண்ணப்படுவதில்லை — ரத்தான ஆஃபர்கள் குறியீட்டிலிருந்து
நீங்குகின்றன, எனவே ஆஃபர் மொத்தம் எல்லாக் காலத்துக்குமான எண் அல்ல.
இல்லாத கவுண்டர் "தெரிவிக்கப்படவில்லை" என்றும், சாத்தியமற்றது
"தெரிவிக்கப்பட்டது, ஆனால் பயன்படுத்தக்கூடிய எண்ணிக்கை அல்ல"
என்றும் காட்டும்; எதுவும் 0 ஆகக் காட்டப்படுவதில்லை.

<a id="public-dashboard.recycling"></a>

### மறுசுழற்சிக் கணக்கும் லூப் மூடலும்

மறுசுழற்சிக் கணக்கு (`/metrics/recycling`) திட்டத்தின் ஒவ்வொரு
நாளுக்கும் குளம், அதன் நிதி, எடுக்கப்பட்டது ஆகியவற்றைத் திட்டத்தின்
சொந்த நாள் எண்ணுடன் பட்டியலிடுகிறது; இறுதியாகாத நாள் குளம் இல்லாமல்
காட்டப்படும், செயல்படுத்தப்படாத நாள் மதிப்பீடாகக் குறிக்கப்படும்.
லூப் மூடல் (`/metrics/loop-closure`) ஒவ்வொரு UTC நாளுக்கும்
கிளெய்ம்கள் வழங்கியது, வால்ட்களில் தங்கியது, உள்வாங்கப்பட்டது
ஆகியவற்றைப் பதிவு எட்டும் கணத்துடன் காட்டுகிறது. காட்சித்
துல்லியத்துக்குக் கீழ் உள்ள நேர்மறைத் தொகைகள் குறிக்கப்படும், பங்குகள்
கீழ்நோக்கி முழுமையாக்கப்படும், தெரியாத எண் ஒருபோதும் பூஜ்ஜியமாகக்
காட்டப்படாது.

<a id="public-dashboard.transparency"></a>

### வெளிப்படைத்தன்மையும் மூலமும்

எக்ஸ்ப்ளோரர் இணைப்புடன் Diamond முகவரி, செயின், இன்டெக்சர்
கர்சரின் பிளாக்கும் வயதும். இன்டெக்சரின் ஒவ்வொரு எண்ணும் அந்தக்
கர்சர் அளவுக்கே புதியது, அதற்கு மேல் அல்ல; இரண்டு பதில்கள்
இணைக்கப்படும்போது பழைய கர்சர் குறிப்பிடப்படும்.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI டோக்கன்

Diamond-இல் உள்ள `getVPFISnapshot()`-இலிருந்து: இந்த செயினில்
டோக்கன் முகவரியும் `totalSupply`-உம். கேனானிக்கல் செயினில் வரம்பு,
இடைவெளி (`cap − totalSupply`, இன்னும் மின்ட் செய்யக்கூடியது), மின்டர்
ஆகியவையும். மிரர் செயினில் ஸ்னாப்ஷாட்டில் வரம்போ மின்டரோ இல்லை —
அங்கே வழங்கல் CCIP டோக்கன் பூல் வழியாக வருகிறது — எனவே பக்கம்
உள்ளூர் வழங்கலைக் காட்டி, வரம்பும் மின்டரும் கேனானிக்கல் செயினுக்கு
உரியவை என்று சொல்கிறது, பூஜ்ஜியங்களைக் காட்டாமல். இணைக்கப்படாத
டோக்கனும் படிக்க முடியாத ஸ்னாப்ஷாட்டும் தனித்தனியாகக்
குறிப்பிடப்படும்.

<a id="public-dashboard.fees"></a>

### கட்டணங்களும் கருவூலமும்

`getTreasuryMetrics()`, `getTreasury()`, `getNumeraireSymbol()`
ஆகியவற்றிலிருந்து, ஸ்னாப்ஷாட் படிக்கப்பட்ட அதே Multicall3 தொகுப்பில்
படிக்கப்பட்டு, ஒரே பிளாக்கில் நிலைநிறுத்தப்பட்டவை; அந்த பிளாக்கை
அதன் வயதுடன் பக்கம் குறிப்பிடுகிறது:

- கட்டணப் பேரேடு தொடங்கியதிலிருந்தும், கடந்த 24 மணி நேரம், 7
  நாட்களிலும் உள்ள கட்டணங்கள், ஒவ்வொன்றும் பதிவாகும்போது
  நியூமரேரில் மதிப்பிடப்பட்டு, மீண்டும் மதிப்பிடப்படுவதில்லை;
- பதிவின்போது புரோட்டோகால் மதிப்பிட முடியாத கட்டணம் 0 எனப்
  பதியப்படும், சாளரக் கூட்டுத்தொகைகள் அதிகபட்சம் சமீபத்திய 10,000
  பதிவுகளையே படிக்கும் — இவ்விரண்டும் எண்ணைக் குறைக்க மட்டுமே
  முடியும், பக்கம் அதைச் சொல்கிறது;
- நியூமரேர் மாற்றம் முந்தைய பதிவுகளைப் பழைய அலகிலேயே விடும்; ஆகவே
  அதன் பிறகு கூட்டுத்தொகைகள் தற்போதைய குறியீட்டின் கீழ் இரண்டு
  அலகுகளின் தொகைகளைக் கூட்டுவதால் எந்தத் திசையிலும் விலகலாம்;
  முந்தைய கட்டணங்கள் பழைய அலகில் கணக்கிடப்பட்டவை என்று பக்கம்
  சொல்கிறது;
- கருவூல முகவரி. அது வெளி முகவரி என்றால், கட்டணங்கள் வசூலாகும்போதே
  வெளியேறும், அதற்கு இருப்பு எதுவும் காட்டப்படாது. Diamond தானே
  கருவூலம் என்றால், வைத்திருக்கும் தொகை காட்டப்படும்; அது திறந்த
  கடன்களில் தோன்றும் சொத்துகளின் மேல் மட்டுமே மதிப்பிடப்பட்டு,
  கருவூலத்தின் சார்பில் வேறிடத்தில் வைக்கப்பட்ட தொகைகளையும்
  உள்ளடக்கும்.

தோல்வியடையும் செயல்பாடு "படிக்க முடியவில்லை" என்று காட்டும்,
மற்றவற்றை மறைக்காது.

---

<a id="chapter.refinance"></a>

## Refinance

இந்த page borrower-only — Refinance, borrower-இன் loan-இல் borrower-ஆல்
initiate செய்யப்படுகிறது.

<a id="refinance.overview"></a>

### Refinancing பற்றி

Refinance, புதிய principal-இல் இருந்து உங்கள் தற்போதைய loan-இல் atomically
pay off செய்து, புதிய terms-உடன் புதிய loan-இல் திறக்கும் — எல்லாம் ஒரே
transaction-இல். Collateral முழுவதும் உங்கள் vault-இலேயே தங்கும் —
unsecured window இல்லை. மற்ற எந்த loan போலவே, புதிய loan initiation-இல்
HF ≥ 1.5 gate clear ஆக வேண்டும்.

<a id="refinance.position-summary"></a>

### உங்கள் தற்போதைய Position

Refinance செய்யப்படும் loan-இன் snapshot — தற்போதைய principal, இதுவரை
accrued interest, HF / LTV, மற்றும் collateral basket. புதிய offer
குறைந்தபட்சம் outstanding amount-இல் (principal + accrued interest) size
செய்ய வேண்டும்; புதிய offer-இல் excess ஏதேனும் இருந்தால் அது free
principal-ஆக உங்கள் vault-க்கு வழங்கப்படும்.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — புதிய Offer-ஐ Post செய்யுங்கள்

உங்கள் target terms-உடன் borrower offer post செய்கிறது. நீங்கள்
காத்திருக்கும்போது பழைய loan interest accrue செய்யத் தொடரும்; collateral
lock-ஆகவே இருக்கும். Offer public Offer Book-இல் தோன்றும், எந்த lender-உம்
accept செய்யலாம். Acceptance-க்கு முன் cancel செய்யலாம்.

<a id="refinance.step-2-complete"></a>

### Step 2 — Complete

புதிய lender accept செய்த பிறகு atomic settlement:

1. Accepting lender-இல் இருந்து புதிய loan-இல் fund செய்கிறது.
2. பழைய loan-இல் முழுமையாக repay செய்கிறது (principal + interest, treasury
   cut கழித்து).
3. பழைய loan-ஐ repaid என mark செய்கிறது. அதன் position NFTs burn
   ஆவதில்லை: இரண்டும் Loan Repaid நிலையுடன் அவற்றின் holders-இடமே
   இருக்கின்றன. பழைய lender தன் NFT மூலம் repayment-ஐ claim
   செய்கிறார், பழைய borrower NFT ஒரு receipt-ஆக இருக்கிறது.
4. புதிய position NFTs-ஐ mint செய்கிறது.

புதிய terms-இல் HF 1.5-க்குக் கீழே இருந்தால் revert ஆகிறது.

---

<a id="chapter.preclose"></a>

## Preclose

இந்த page borrower-only — Preclose, borrower-இன் loan-இல் borrower-ஆல்
initiate செய்யப்படுகிறது.

<a id="preclose.overview"></a>

### Preclose பற்றி

Borrower-driven early termination. இரண்டு paths:

- **Direct** — உங்கள் wallet-இல் இருந்து outstanding amount (principal
  + accrued interest)-இல் செலுத்துங்கள், collateral-இல் release செய்யுங்கள்.
- **Offset** — Principal asset-க்கான protocol-இன் 4-DEX swap failover
  வழியாக collateral-இன் ஒரு பகுதியை விற்க offset-இல் initiate செய்யுங்கள்;
  proceeds-இல் இருந்து repay செய்ய offset-இல் complete செய்யுங்கள்; collateral
  மீதம் இருந்தால் அது உங்களுக்குத் திரும்பும்.

Flat early-close penalty இல்லை.

<a id="preclose.position-summary"></a>

### உங்கள் தற்போதைய Position

Preclose செய்யப்படும் loan-இன் snapshot — outstanding principal, accrued
interest, தற்போதைய HF / LTV. Preclose flow exit-இல் HF ≥ 1.5
**தேவையில்லை** (இது closure, re-init அல்ல).

<a id="preclose.in-progress"></a>

### Offset In Progress

State: offset initiate செய்யப்பட்டுள்ளது; swap execution-இல் உள்ளது
(அல்லது quote consume செய்யப்பட்டுள்ளது, ஆனால் final settle pending).
இரண்டு exits:

- **Complete offset** — realised proceeds-இல் இருந்து loan-இல் settle
  செய்கிறது, மீதியைத் திருப்பித் தருகிறது.
- **Cancel offset** — Aborts; collateral lock-ஆகவே இருக்கிறது, loan
  மாறாது. Initiate மற்றும் complete-க்கு இடையே swap உங்களுக்கு எதிராக
  நகர்ந்தபோது இதைப் பயன்படுத்துங்கள்.

<a id="preclose.choose-path"></a>

### ஒரு Path-ஐத் தேர்ந்தெடுக்கவும்

Direct path principal asset-இல் wallet liquidity-இல் consume செய்கிறது.
Offset path DEX swap வழியாக collateral-இல் consume செய்கிறது; உங்களிடம்
principal asset கையில் இல்லாதபோது அல்லது collateral position-இல் இருந்தும்
exit செய்ய விரும்பினால் இது preferred. Offset slippage, liquidations-க்கு
பயன்படுத்தப்படும் அதே 4-DEX failover-ஆல் (0x → 1inch → Uniswap V3 →
Balancer V2) வரம்புக்குள் வைக்கப்படுகிறது.

---

<a id="chapter.early-withdrawal-lender"></a>

## Early Withdrawal (Lender)

இந்த page lender-only — Early withdrawal, lender-இன் loan-இல் lender-ஆல்
initiate செய்யப்படுகிறது.

<a id="early-withdrawal.overview"></a>

### Lender Early Exit பற்றி

Lender positions-களுக்கான secondary-market mechanism. நீங்கள் தேர்ந்தெடுத்த
விலையில் உங்கள் position NFT-இல் விற்பனைக்கு list செய்கிறீர்கள்; acceptance-இல்,
buyer payment செய்கிறார், lender NFT-இன் ownership buyer-க்கு transfer ஆகிறது,
மற்றும் எதிர்கால settlement-களுக்கு (terminal-இல் claim போன்றவை) buyer
lender of record ஆகிறார். நீங்கள் sale proceeds-உடன் வெளியேறுகிறீர்கள்.

Liquidations user-only-ஆகவே இருக்கும்; sale வழியாக delegate செய்யப்படாது
— claim செய்யும் உரிமை மட்டுமே transfer ஆகும்.

<a id="early-withdrawal.position-summary"></a>

### உங்கள் தற்போதைய Position

Snapshot — outstanding principal, accrued interest, மீதமுள்ள நேரம்,
borrower side-இன் தற்போதைய HF / LTV. buyer market எதிர்பார்க்கும் fair
price-இல் அமைக்கும் முக்கிய எண்கள் இவை: buyer-இன் payoff terminal-இல்
principal மற்றும் interest, மீதமுள்ள நேரத்தின் liquidation risk-இல் கழித்து.

<a id="early-withdrawal.initiate-sale"></a>

### Sale-ஐ Initiate செய்யுங்கள்

உங்கள் asking price-இல் protocol வழியாக position NFT-இல் விற்பனைக்கு list
செய்கிறது. buyer sale-இல் complete செய்கிறார்; sale fill ஆகும்முன் நீங்கள்
cancel செய்யலாம். "Complete loan sale" permission வைத்திருக்கும் keeper-க்கு
optional-ஆக delegatable; initiate step user-only-ஆகவே இருக்கும்.

---

<a id="chapter.stuck-token-recovery"></a>

## சிக்கிய Token-களை மீட்டெடுத்தல் (Stuck-Token Recovery)

இந்த பகுதி பெரும்பாலான பயனர்களுக்குத் தேவைப்படாத ஒரு விளிம்பு நிலை (EDGE CASE). கீழே உள்ள மீட்பு இணைப்பைக் கிளிக் செய்வதற்கு முன் இதை முழுமையாகப் படிக்கவும் — தவறான ஆதாரத்தை (source) அறிவிப்பது protocol-ன் பொருளாதாரத் தடைக் கொள்கையின் (sanctions policy) கீழ் உங்கள் vault-ஐ முடக்கலாம்.

<a id="stuck-recovery.what"></a>

### "சிக்கிய token" என்பதன் அர்த்தம்

உங்கள் Vaipakam Vault proxy என்பது உள்நாட்டு சேமிப்பு இடம். இது ஒரு deposit முகவரி (address) அல்ல. Protocol ஆதரிக்கும் ஒவ்வொரு deposit-ம் Vaipakam-ன் facet வழிகள் வழியாகவே நடக்கும், அவை offer உருவாக்கத்தின் ஒரு பகுதியாக உங்கள் wallet-இலிருந்து vault-க்கு பணத்தை இழுக்கும். அந்த வழிகளுக்கு வெளியே vault-க்கு வரும் tokens — அதாவது ஒரு wallet-இலிருந்து நேரடி `IERC20.transfer` அல்லது உங்கள் vault முகவரியைப் பயன்படுத்தி செய்யப்படும் CEX withdrawal — protocol கணக்கில் வராமல் அங்கே தங்கும். Asset Viewer protocol-ஆல் கண்காணிக்கப்படும் இருப்பை மட்டுமே காட்டும் என்பதால், இவை அங்கே தெரியாது.

Tokens இரண்டு வழிகளில் சிக்கிக் கொள்கின்றன:

1. **நீங்களாகவே அவற்றை அனுப்புதல்.** CEX withdrawal-ல் அல்லது wallet-ன் token அனுப்பும் படிவத்தில் உங்கள் vault முகவரியைத் (Dashboard அல்லது block explorer-லிருந்து) தவறுதலாகக் கொடுத்து அனுப்பிவிடுதல். Tokens protocol-ன் deposit பாதை வழியாகச் செல்லாமல் உங்கள் vault-ஐ வந்தடையும்.

2. **மூன்றாம் தரப்பினர் அனுப்புதல் ("dust attack").** யாராவது அடையாளப்படுத்தப்பட்ட (flagged) ஒரு wallet-லிருந்து உங்கள் vault-க்கு சிறிய அளவு தொகையை அனுப்புதல். இது ஒரு தாக்குதல் முறையாகும்.

<a id="stuck-recovery.taint-poisoning"></a>

### "Taint poisoning" பற்றி

அனுப்பிய மூன்றாம் தரப்பினர் பொருளாதாரத் தடைகள் பட்டியலில் (sanctions list) இருந்தால், நீங்கள் அந்த tokens-ஐத் தொடாவிட்டாலும் பொதுவான on-chain ஆய்வு கருவிகள் உங்கள் vault-ஐ "பொருளாதாரத் தடை தொடர்புடையது" எனக் காட்டலாம். இதைத் தவிர்க்க on-chain வழி எதுவுமில்லை. Vaipakam-ன் உள் கணக்குகள் இதனால் பாதிக்கப்படாது (நாங்கள் protocol வழியிலான deposits-ஐ மட்டுமே கணக்கிடுகிறோம்), எனவே உங்கள் loans / stake / claims வழக்கம் போல் செயல்படும். ஆனால் வெளிப்புறக் கருவிகள் எச்சரிக்கைகளைக் காட்டலாம்.

<a id="stuck-recovery.dont-recover"></a>

### எப்போது மீட்கக் கூடாது

நீங்கள் அந்த tokens-ஐ அனுப்பவில்லை என்றால், **அவற்றை மீட்க முயற்சிக்காதீர்கள்**. மீட்பதற்கு நீங்கள் அனுப்பியவரின் முகவரியை அறிவிக்க வேண்டும். அந்த முகவரி பொருளாதாரத் தடைகள் பட்டியலில் இருந்தால், அது நீக்கப்படும் வரை உங்கள் vault முடக்கப்படும்.

நீங்கள் அனுப்பாத tokens உங்களுக்குச் சொந்தமானவை அல்ல. உங்களுக்குத் தெரியாத முகவரியைத் தெரிந்த முகவரி என்று கூறி மீட்பதும் தவறானது — protocol-ஆல் அதைச் சரிபார்க்க முடியாது என்றாலும், வெளிப்புறக் கருவிகள் பின்னர் முரண்படலாம்.

யாரோ அனுப்பிய சிறிய தொகையைப் புறக்கணிப்பதே பாதுகாப்பானது. இது உங்கள் protocol இருப்பு அல்லது loans / offers-ஐப் பாதிக்காது.

<a id="stuck-recovery.when-recover"></a>

### எப்போது மீட்கலாம்

நீங்களே தவறுதலாக tokens-ஐ அனுப்பிவிட்டீர்கள், அந்த wallet உங்கள் கட்டுப்பாட்டில் உள்ளது, மேலும் அந்த முகவரி எந்தப் பொருளாதாரத் தடைகள் பட்டியலிலும் இல்லை என்று உங்களுக்குத் தெரியும் (உங்களுடைய சொந்த EOA, CEX wallet போன்றவை).

<a id="stuck-recovery.flow"></a>

### மீட்பு வழிமுறை

1. [மீட்புப் பக்கத்திற்கு](https://defi.vaipakam.com/recover)ச் செல்லவும்.
2. Token contract முகவரி, நீங்கள் அனுப்பிய wallet முகவரி மற்றும் தொகையை உள்ளிடவும்.
3. திரையில் உள்ள நிபந்தனைகளைக் கவனமாகப் படிக்கவும்.
4. கையொப்பமிடுவதை (signing) அனுமதிக்க "CONFIRM" என்று டைப் செய்யவும்.
5. உங்கள் wallet-ல் EIP-712 ஒப்புதலில் கையொப்பமிடவும்.
6. Transaction-ஐச் சமர்ப்பிக்கவும்.

இரண்டு விளைவுகள்:

- **Source சுத்தமாக இருந்தால்** → tokens உங்கள் vault-இன் பதிவு செய்யப்பட்ட இருப்பில் சேர்க்கப்படும். வழக்கம் போல் vault-இலிருந்து எடுக்கவும்; பாதுகாக்கப்பட்ட கணக்கு முறை இயக்கத்தில் இருந்தால், அதன் பணம் செலுத்தும் தாமதம் பொருந்தும்.
- **Source அடையாளப்படுத்தப்பட்டிருந்தால்** → tokens vault-லேயே தங்கும், உங்கள் vault முடக்கப்படும். அந்த முகவரி பட்டியலிலிருந்து நீக்கப்பட்டால் முடக்கம் தானாகவே நீங்கும்.

<a id="stuck-recovery.disown"></a>

### வேண்டாத tokens-ஐத் துறத்தல் (compliance audit trail)

உங்கள் vault-இல் உள்ள ஒரு குறிப்பிட்ட token இருப்பு உங்களுடையது அல்ல என்று பொதுவான on-chain பதிவை வைக்க விரும்பினால், protocol `disownUntracked(kind, asset, tokenId)` என்ற வசதியை வழங்குகிறது. இது ஒரு event-ஐ (`UntrackedDisowned`) வெளியிடும் மற்றும் வேறு எதையும் மாற்றாது — tokens முன்பைப் போலவே vault-இல் இருக்கும். "நீங்கள் இந்தப் பணத்தைப் பெற்றீர்களா?" என்று ஒழுங்குமுறை அமைப்புகள் கேட்டால், இந்த event-ஐ ஆதாரமாகக் காட்டலாம்.

Disown வசதி தற்போது நேரடியாக contract call மூலம் மட்டுமே கிடைக்கிறது; Vaipakam frontend-ல் இதற்கான பட்டன் இல்லை. Use a block-explorer "Write Contract" UI or a contract-interaction tool to call it.

<a id="chapter.how-vpfi-discounts-work"></a>

## VPFI தள்ளுபடிகள் எப்படி வேலை செய்கின்றன

Canonical chain ஆன Base-இல் உள்ள உங்கள் vault-இல் வைத்திருக்கும் VPFI,
platform இயங்கும் ஒவ்வொரு chain-இலும் protocol-இன் சொந்தக் கட்டணங்களில்
உங்களுக்குத் தள்ளுபடி தருகிறது. எவ்வளவு அதிகமாகவும், எவ்வளவு நீண்ட
காலமும் வைத்திருக்கிறீர்களோ, அவ்வளவு உயர்ந்த tier, அவ்வளவு பெரிய
தள்ளுபடி. Tier-கள் மேலே உள்ள
[Tier ladder](#dashboard.fee-discount-consent)-இல் உள்ளன; governance
அவற்றை மாற்றலாம்.

தள்ளுபடி எதற்குப் பொருந்தும்:

- **Lender-ஆக**, நீங்கள் ஈட்டும் வட்டியிலிருந்து protocol வைத்துக்கொள்ளும்
  yield fee-க்கு. வட்டி settle ஆகும் ஒவ்வொரு முறையும் (உதாரணமாக
  repayment, preclose அல்லது refinance) அது படிக்கப்படுகிறது — loan
  தொடங்கியபோது இருந்த tier-ஆல் அல்ல, அந்தக் கணத்தின் tier-ஆல்.
- **Borrower-ஆக**, loan தொடங்கும்போது வசூலிக்கப்படும் Loan Initiation
  Fee-க்கு. Accept-இன்போது ஒருமுறை மட்டுமே படிக்கப்பட்டு அந்த loan-உடன்
  நிலையாக இருக்கும். Lending asset liquid ஆக இருந்தால் மட்டுமே
  பொருந்தும்; illiquid loan முழுக் கட்டணத்தையும் செலுத்தும்.

தள்ளுபடி கட்டணத்திலிருந்தே, loan-இன் asset-இல் கழிக்கப்படுகிறது;
அதற்காக உங்கள் vault-இலிருந்து எந்த VPFI-உம் வெளியேறாது. ஒரே விதிவிலக்கு,
VPFI விலை மேற்கோளை அமைத்த deployment-இல் lender-இன் தள்ளுபடி: அங்கே அது
உங்கள் vault-இலிருந்து VPFI-ஆகத் தீர்க்கப்படலாம். Launch-இல் எதுவும்
அமைக்கப்படவில்லை. இந்த அத்தியாயம் இந்த holding தள்ளுபடியைப் பற்றியது.
"Full" என்ற தனியான கட்டண முறை, ஒரு deployment அதை இயக்காதவரை அணைந்தே
இருக்கும்.

<a id="vpfi-discounts.turning-on"></a>

### தள்ளுபடியை இயக்குதல்

தள்ளுபடி opt-in ஆகும். Switch VPFI பக்கத்தில் உள்ளது; ஒவ்வொரு chain-க்கும்
ஒன்று, ஏனெனில் ஒவ்வொரு chain-உம் தன் அமைப்பைத் தானே வைத்திருக்கிறது:

- **கட்டணம் வசூலிக்கப்படும் chain-இல்** switch இயங்கியிருக்க வேண்டும்;
  இல்லையெனில் உங்கள் tier எதுவானாலும் அந்த chain முழுக் கட்டணத்தையும்
  வசூலிக்கும்.
- **Base-இலும்** switch இயங்கியிருக்க வேண்டும், நீங்கள் அங்கே ஒருபோதும்
  கடன் வாங்காவிட்டாலும் கொடுக்காவிட்டாலும். அது அணைந்திருக்கும்வரை,
  Base மற்ற எல்லா chain-களுக்கும் உங்கள் tier-ஐப் பூஜ்யமாக அனுப்புகிறது.

நீங்கள் Base-இல் தள்ளுபடியை அணைக்கும்போது, மற்ற எல்லா chain-களும் அதைப்
பயன்படுத்துவதை நிறுத்த app உடனே ஒரு tier update-ஐ அனுப்புகிறது: அப்போது
Base அவற்றுக்கு உங்கள் tier-ஐப் பூஜ்யமாக அனுப்புகிறது. இந்த இரண்டாவது
படி தோல்வியடைந்தால் பக்கம் அதைச் சொல்லும்; புதியது அனுப்பப்படும்வரை மற்ற
chain-கள் உங்கள் கடைசி tier-ஐ வைத்திருக்கும். வேறு எந்த chain-இல் அதை
அணைத்தாலும் அந்த chain மட்டுமே மாறும்.

Protocol உங்கள் vault-இல் பதிவுசெய்யும் VPFI கணக்கில் வரும்: VPFI
பக்கத்தின் வழியாக நீங்கள் deposit செய்வதும், protocol உங்கள்
vault-க்குள் வழங்கும் VPFI rewards-உம். உங்கள் vault முகவரிக்கு நேரடியாக
அனுப்பப்படும் token-களை protocol கண்காணிப்பதில்லை; அவை உங்கள் tier-ஐ
உயர்த்தாது.

<a id="vpfi-discounts.tier-calculation"></a>

### உங்கள் tier எப்படிக் கணக்கிடப்படுகிறது

உங்கள் tier மூன்று தனித்தனிச் சோதனைகளால் தீர்மானிக்கப்படுகிறது; மூன்றும்
தேற வேண்டும்:

1. **குறைந்தபட்ச holding காலம்.** உங்கள் தற்போதைய holding குறைந்தது 3
   நாட்கள் நீடிக்கும்வரை உங்கள் tier பூஜ்யமாகவே இருக்கும். உங்கள் vault
   இருப்பு பூஜ்யத்துக்கு மேல் செல்லும் கணத்தில் holding தொடங்கி, அது
   மீண்டும் பூஜ்யமாகும்வரை நீடிக்கிறது. மேலும் சேர்ப்பது கடிகாரத்தை
   மீண்டும் தொடங்காது; முழுவதையும் எடுப்பது தொடங்கும். (3 நாட்கள்
   default; governance இதை 2 முதல் 14 வரை அமைக்கலாம்.)
2. **சமீபத்திய நாட்களுக்கு அதிக எடை தரும் சராசரி.** உங்கள் இருப்பு
   கடந்த 30 நாட்களுக்குச் சராசரியாக்கப்படுகிறது; கடைசி 7 நாட்கள்
   அதற்கு முந்தைய நாட்களைவிட மூன்று மடங்கு கணக்கிடப்படுகின்றன. சராசரி
   உங்கள் தற்போதைய holding தொடங்குவதற்கு முன்பு வரை ஒருபோதும் செல்லாது;
   எனவே புதிய holder எதுவும் வைத்திருக்காத நாட்களால் நீர்த்துப்போவதில்லை.
   (Window, சமீபத்திய நாட்கள், எடை ஆகியவை governance அமைப்புகள்; window
   14 முதல் 30 நாட்கள் வரை இருக்கலாம்.)
3. **நீங்கள் தொட்ட மிகக் குறைந்த tier.** சராசரியிலிருந்து தனியாக,
   தற்போதைய holding-இன்போது உங்கள் இருப்பு எட்டிய மிகக் குறைந்த tier-ஐ
   விட உங்கள் tier உயர இருக்க முடியாது; அதிகபட்சம் 30 நாட்கள் பின்னோக்கிப்
   பார்க்கப்படும். ஒவ்வொரு நாளின் மிகக் குறைந்த புள்ளி கணக்கிடப்படுவதால்,
   ஒரே நாளில் இறங்கி மீண்டு வருவதும் ஒரு இறக்கமாகவே கருதப்படும்.

நடைமுறையில் இதன் பொருள்:

- Loan settle ஆவதற்குச் சற்று முன் செய்யும் deposit உங்கள் tier-ஐ உடனே
  உயர்த்தாது. சேர்த்த தொகை முதலில் சராசரிக்குள் வர வேண்டும்; நீங்கள்
  தொட்ட மிகக் குறைந்த புள்ளி இன்னும் உங்களுக்கு வரம்பாக இருக்கும்.
- ஒரு tier-இன் வரம்புக்குக் கீழே கொண்டுசெல்லும் withdrawal உங்கள்
  tier-ஐ உடனே குறைக்கும்.
- 30 நாட்களுக்கு முந்தைய இறக்கம் இனி உங்களைக் கட்டுப்படுத்தாது.

<a id="vpfi-discounts.other-chains"></a>

### மற்ற chain-களில் உங்கள் tier

உங்கள் tier-ஐ Base கணக்கிடுகிறது. மற்ற எல்லா chain-களும் Base, Chainlink
CCIP வழியாக அனுப்பும் நகலைப் பயன்படுத்துகின்றன. Base-இல் இவற்றில் ஒன்று
நிகழும்போது Base உங்கள் tier பதிவைப் புதுப்பிக்கிறது: VPFI உங்கள்
vault-க்குள் வருகிறது அல்லது வெளியேறுகிறது (deposit, withdrawal, அல்லது
அதற்குள் வழங்கப்படும் rewards); நீங்கள் lender அல்லது borrower ஆக உள்ள
ஒரு கடன் தொடங்குகிறது; ஒரு கடன் படி உங்கள் VPFI-ஐ நிறுத்தி வைக்கிறது
அல்லது விடுவிக்கிறது; அல்லது நீங்கள் tier-refresh call செய்கிறீர்கள்.
நகல் மாறும் என்றால், ஒவ்வொரு புதுப்பிப்பும் மற்ற chain-களுக்குப் புதிய
நகலை அனுப்பும்.

ஒவ்வொரு chain-க்கும் தனித்தனியாக அனுப்பப்படுகிறது. அடைய முடியாத ஒரு
chain மற்றவற்றைத் தடுக்காது; **அனுப்ப முடியாத delivery உங்கள் சொந்தச்
செயலை ஒருபோதும் தோல்வியடையச் செய்யாது**: Base-இல் உங்கள் tier உடனே
புதுப்பிக்கப்படும்; மற்ற ஒவ்வொரு chain-க்கும் update சேரும்வரை நிலுவையில்
இருக்கும்.

இந்த delivery-களுக்கான செலவை protocol ஏற்கிறது, ஒரு வரம்புடன்:

- **குறைந்த tier**, budget செலுத்த முடியும்வரை உடனே அனுப்பப்படும்.
  சேரும்வரை அந்த chain உங்கள் முந்தைய, உயர்ந்த tier-ஐயே பயன்படுத்தும்.
- **உயர்ந்த tier** அல்லது tier table மாற்றத்துக்கு, ஒவ்வொரு chain-க்கும்
  நாளொன்றுக்கு அதிகபட்சம் ஒருமுறை மட்டுமே செலவு ஏற்கப்படும் (1 மணி
  நேரம் முதல் 7 நாட்கள் வரையிலான governance அமைப்பு). அதுவரை அந்த chain
  உங்கள் முந்தைய tier-ஐ வைத்திருக்கும்.
- இந்தக் காத்திருப்பால் நிறுத்தி வைக்கப்பட்ட update, அல்லது budget-ஆல்
  செலுத்த முடியாத update, **காத்திருப்பு முடிந்ததும் தானாக மீண்டும்
  அனுப்பப்படாது**. Base-இல் உங்கள் tier பதிவின் அடுத்த புதுப்பிப்புடன், அல்லது
  யாராவது உங்களுக்காக delivery அழைப்பைச் செய்யும்போது அது அனுப்பப்படும்.
- அந்த அழைப்பை யார் வேண்டுமானாலும் செய்யலாம். காத்திருப்பு முடிந்து budget
  செலுத்த முடிந்தால் protocol செலுத்தும்; அதற்கு முன் விரைவில் சேர்க்க அழைப்பவர்
  cross-chain கட்டணத்தைச் செலுத்துவார். Contract-கள் இந்த அழைப்பை
  வழங்குகின்றன; app இன்னும் இதை வழங்கவில்லை.

பின்வரும் நிலைகளில் ஒரு நகல் கணக்கில் வராது; அந்த chain தள்ளுபடி தராது:

- அது chain-இன் அதிகபட்ச வயதைவிடப் பழையதாக இருந்தால் (default 60 நாட்கள்,
  ஒருபோதும் 30-க்குக் குறைவில்லை); அல்லது
- அந்த chain இப்போது அறிந்த tier table-ஐவிடப் பழைய table-இல் அது
  உருவாக்கப்பட்டிருந்தால்.

நகலில் ஏதாவது மாறும்போது மட்டுமே அது மீண்டும் அனுப்பப்படும்: உங்கள்
tier, அதன் தள்ளுபடி, அது எவ்வளவு காலம் செல்லுபடியாகும், அல்லது tier
table-இன் பதிப்பு. ஆகவே tier table மாறிய பிறகு, உங்கள் tier அதேபோல்
இருந்தாலும், அது பூஜ்யமாக இல்லாதவரை, Base-இல் உங்கள் tier பதிவின் அடுத்த
புதுப்பிப்பு ஒவ்வொரு chain-க்கும் புதிய நகலை அனுப்பும். இவற்றில் எதுவும்
மாறவில்லையெனில், நகல் காலாவதியான chain ஏதாவது மாறும்வரை எந்தத்
தள்ளுபடியும் தராது.

காலம் கடந்ததால் மட்டுமே உங்கள் tier உயர்ந்தால் — holding காலம்
நிறைவடைந்தது, அல்லது சராசரி ஈடுகொடுத்தது — உங்கள் tier பதிவின் அடுத்த
புதுப்பிப்பு வரை Base-இல் எதுவும் அதைக் கவனிக்காது. நீங்கள்
விரும்பும்போது tier-refresh call அந்தப் புதுப்பிப்பைச் செய்யும்; நீங்கள்
தள்ளுபடியை அணைக்கும்போது மட்டுமே app அதை உங்களுக்காகச் செய்கிறது.

<a id="vpfi-discounts.operators"></a>

### Operator-களுக்கு

தள்ளுபடியின் cross-chain பகுதிக்கு இந்த configuration தேவை. சொந்த
deployment-ஐ இயக்குபவர்களுக்காக இங்கே பட்டியலிடப்பட்டுள்ளது.

**Base-இல்:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`. இது இல்லாமல் Base
  tier-களைக் கணக்கிடும், ஆனால் எங்கும் அனுப்பாது.
- `VaipakamRewardMessenger`-ஐச் சுட்டும்
  `RewardReporterFacet.setRewardMessenger`, மற்ற எல்லா chain-களையும்
  பட்டியலிடும் messenger-இன் `setBroadcastDestinations`.
- நிதியூட்டப்பட்ட broadcast budget:
  `ProtocolBroadcastFacet.topUpBroadcastBudget()` (payable). காலியான
  budget எதையும் தடுக்காது. அது செலுத்த முடியாத ஒவ்வொரு delivery-உம்
  நிலுவையில் இருந்து காரணத்துடன் `TierPushDeferred`-ஐ emit செய்கிறது;
  `getTierPushStatus(user)` ஒரு user-க்கு ஒவ்வொரு chain-இன் நிலையையும்
  காட்டுகிறது. Budget குறைவாக இருந்தால் மற்ற chain-கள் பழைய tier-களை
  நீண்ட நேரம் பயன்படுத்தும்; எனவே deferral-களைக் கவனித்து top up செய்யுங்கள்.
- செலுத்தப்படும் உயர்வுகளுக்கான spacing window: `setTierPushSpacingSec`
  (default 1 நாள், 1 மணி நேரம் முதல் 7 நாட்கள்).

**மற்ற ஒவ்வொரு chain-இலும்:**

- `RewardReporterFacet.setRewardMessenger(addr)`: அந்த chain tier
  update-களை ஏற்கும் ஒரே அனுப்புநர்.
- `RewardReporterFacet.setBaseChainId(chainId)`: Base-இன் EVM chain id
  (mainnet-இல் 8453, Base Sepolia-வில் 84532); அதன் CCIP chain selector
  அல்ல.
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: ஒரு நகல் எவ்வளவு காலம்
  கணக்கில் வரும் (default 60 நாட்கள்; 30 நாட்களுக்குக் குறைவான மதிப்புகள்
  மறுக்கப்படும்). குறைத்தால் அடுத்த read-இலிருந்து நடைமுறைக்கு வரும்.

**Tier table-ஐ மாற்றுதல்:**

- Base-இல் `setVpfiTierThresholds`, `setVpfiTierDiscountBps` ஆகியவை
  table-இன் version-ஐ முன்னகர்த்துகின்றன. எந்த user-உடையதாக இருந்தாலும்,
  புதிய version-ஐச் சுமக்கும் முதல் tier update-இலிருந்து மற்றொரு chain
  அதை அறிகிறது. அப்போதிருந்து, பழைய table-இல் உருவான ஒவ்வொரு நகலும் அந்த
  user-இன் சொந்த update சேரும்வரை தள்ளுபடி இல்லை எனக் கருதப்படும்; அந்த
  update-கள் உயர்வுகள் என்பதால் ஒவ்வொரு spacing window-க்கும் அதிகபட்சம்
  ஒருமுறை மட்டுமே செலுத்தப்படும். Table-ஐ மாற்றுவதற்கு முன் budget-ஐ
  நிரப்புங்கள்.
- `setTwaMinStakedDays` version-ஐ முன்னகர்த்தாமல் குறைந்தபட்ச holding
  காலத்தை மாற்றுகிறது. அடுத்த read-இலிருந்து நடைமுறைக்கு வரும்.

<a id="chapter.next-app"></a>

## அடுத்த ஆப்

Vaipakam ஆப்பின் அடுத்த பதிப்பு, தற்போதைய ஆப்புடன் சேர்ந்து, ஒவ்வொரு
பக்கமாக உருவாக்கப்படுகிறது. இன்னும் உருவாக்கப்படாத பக்கம் அதைச்
சொல்லி, அதை இன்னும் வழங்கும் தற்போதைய ஆப்புடன் இணைக்கும்.
உருவாக்கப்பட்ட பக்கத்தின் ஒவ்வொரு எண்ணும் chain-இலிருந்து
படிக்கப்பட்டு தன் மூலத்தைக் குறிப்பிடும்; படிக்க முடியாத எண்
பூஜ்யமாக அல்ல, தெரியாதது என்றே காட்டப்படும்.

<a id="advanced-mode"></a>

### Basic மற்றும் Advanced

பெரும்பாலானோருக்குத் தேவையான திறன்களை Basic காட்டுகிறது. Advanced,
exit மற்றும் settlement கருவிகள், தானியக்கம், கையொப்பமிட்ட orders,
keeper நிலை மற்றும் கணக்கு விவரங்களைச் சேர்க்கிறது. mode என்பது
உங்கள் browser-இல் சேமிக்கப்படும் காட்சித் தேர்வு: எவ்வளவு
காட்டப்படுகிறது என்பதை மாற்றுமே தவிர, protocol உங்களை எதைச் செய்ய
அனுமதிக்கிறது என்பதை அல்ல; அது ஒப்புதலையோ, தடையையோ, தீர்வையோ
ஒருபோதும் மறைக்காது.

<a id="wallet"></a>

### உங்கள் wallet மற்றும் உங்கள் எண்கள் எங்கிருந்து வருகின்றன

உங்கள் சொந்த நிலை (loans, offers, vault, claims) chain-இலிருந்து
படிக்கப்படுகிறது: முதலில் wallet-இன் provider வழியாக, பிறகு
read-only RPC proxy வழியாக, பிறகு network-இன் பொது endpoint வழியாக.
sync வரி பதில் அளித்த மூலத்தையும், பக்கத்தின் மிகப் பழைய
வாசிப்பின் வயதையும் குறிப்பிடும்; Refresh அனைத்தையும் மீண்டும்
படிக்கும். index உலக எண்களுக்கு (சந்தை மற்றும் வரலாறு) மட்டுமே
பயன்படுகிறது, அதன் block உயரம் மற்றும் வயதுடன். சேவை இல்லாத
network-இல் உள்ள wallet மாறும் வரை தன்னுடையது எதையும் காணாது.

<a id="deployments"></a>

### deployment எதை ஆதரிக்கிறது

ஆப் ஒவ்வொரு chain-க்கும் ஒரு Diamond-உடன் இணைந்து, எந்தச் செயலையும்
வழங்கும் முன் loupe வழியாக அதன் routed selectors-ஐப் படிக்கிறது.
facet refresh-க்குப் பிறகு இந்தத் தொகுப்பு மாறும்; அதைக் கருதாமல்
படிப்பதால், `FunctionDoesNotExist` உடன் தோல்வியடைவதற்குப் பதிலாக,
இல்லாத function-ஐ ஆப் பெயரிட்டுச் சொல்ல முடியும். தொகுப்பைப் படிக்க
முடியாத வரை, எந்த signing படியும் வழங்கப்படாது.

<a id="home-start"></a>

### Home: ஒரு வேலையைத் தேர்ந்தெடுத்தல்

Home protocol சொல்லுடன் அல்ல, ஒரு வேலையுடன் தொடங்குகிறது: கடன்
வாங்குதல், கடன் கொடுத்தல், NFT-ஐ வாடகைக்கு எடுத்தல், NFT-ஐ
வாடகைக்கு விடுதல், அல்லது உங்களிடம் உள்ளதை நிர்வகித்தல். கடன்
வாங்குதலும் கொடுத்தலும் பொருந்தும் offers-உடன் திறந்து, இல்லையெனில்
உங்கள் சொந்த offer-ஐ இடுவதற்குச் செல்லும். வாடகை NFT rental-இன்
இரு பக்கங்களையும் உள்ளடக்கும்; NFT முழு நேரமும் vault-இல்
இருக்கும். இணைக்கப்பட்ட wallet மறைக்கக்கூடிய மூன்று தொடக்க
அட்டைகளையும் காணும்; மறைத்தல் browser-இல் சேமிக்கப்படும்.

<a id="home-status"></a>

### Home: protocol நிலை

பக்கம் விவரிக்கும் chain-இல் உள்ள global pause, தானியங்கி pause
சாளரம் மற்றும் keeper pause-ஐ Home படித்து, எல்லா நிலைகளிலும்
முடிவைச் சொல்கிறது. global pause புதிய positions, claims,
withdrawals, liquidations, defaults மற்றும் keeper செய்யும்
settlement-ஐ நிறுத்தும்; முழு மற்றும் பகுதித் திருப்பிச்
செலுத்துதலும் collateral சேர்த்தலும் திறந்தே இருக்கும்;
இடைநிறுத்த நேரம் திறந்திருக்கும் ஒவ்வொரு loan-இன்
காலக்கெடுக்களிலும் வரவு வைக்கப்படும். தானியங்கி pause சாளரம் தன்
முடிவு நேரத்தைக் காட்டும்; admin pause இருந்தால் அது அதைவிட நீண்டு
நீடிக்கும், புதிய தானியங்கி சாளரம் cooldown-க்குப் பிறகே திறக்கும்.
keeper pause, சேவை உங்கள் சார்பில் இயக்கும் படிகளை மட்டுமே
நிறுத்தும். படிக்க முடியாத நிலை, முந்தைய பதிலுக்குப் பிறகு தோல்வியடைந்த
மறுவாசிப்பு உட்பட, மேலே தெரியாதது என்று காட்டப்படும். தனித்தனி
assets-உம் இடைநிறுத்தப்படலாம்; அவை தேவைப்படும் flows அதைச் சொல்லும்.

<a id="home-payouts"></a>

### Home: பெறத் தயார்

Home lender மற்றும் borrower பக்கங்களின் claimable views-ஐப் பக்கம்
பக்கமாகக் கடந்து, ஒவ்வொரு payout-ஐயும் loan மற்றும் பக்கத்தால்
குறிப்பிடும். அது எந்தத் தொகையையும் காட்டாது: ஒரு payout ஒன்றுக்கு
மேற்பட்ட assets-இலும், ஒன்றுக்கு மேற்பட்ட வழிகளிலும் செலுத்தப்படலாம்;
ஒவ்வொரு தொகையும் பெறும் முன் Claims-இல் சொல்லப்படும். கடந்து செல்லல்
முடிவுக்கு முன் நின்றால், காட்டப்பட்டதைவிட அதிகம் இருக்கலாம் என்று
Home சொல்லும்.

<a id="home-loans"></a>

### Home: உங்கள் loans

ஒவ்வொரு Active அல்லது FallbackPending loan-உம் அதன் பக்கம்,
நிபந்தனைகள், collateral மற்றும் நிலையுடன், அவசர வரிசையில்
காட்டப்படும்: grace முடிந்தது, grace-இல், fallback, காலக்கெடு
படிக்க முடியவில்லை, மூன்று நாட்களில் செலுத்த வேண்டியது, நடப்பில்.
due date மற்றும் grace முடிவு protocol-இன் loan clock-இலிருந்து
வருகின்றன; அவற்றில் இடைநிறுத்த நேரம் ஏற்கனவே சேர்ந்துள்ளது, அது
பூஜ்யமல்லாதபோது காட்டப்படும். health factor என்பது dashboard view-இன்
1e18 அளவிலான வாசிப்பு; 0 என்றால் வாசிப்பு இல்லை (விலை இல்லாத asset,
அல்லது தோல்வியடைந்த வாசிப்பு), அப்படியே காட்டப்படும். ஒரே offer-இலிருந்து,
ஒரே பக்கத்தில், ஒரே ERC-20-இல் திறக்கப்பட்ட இரண்டு அல்லது அதற்கு மேற்பட்ட
loans குழுவாக்கப்படும்: principal கூட்டப்படும், வட்டி principal-ஆல்
எடையிடப்பட்டு கீழ்நோக்கி முழுமையாக்கப்படும், விலையுள்ள loans-இல் மிகக்
குறைந்த health factor காட்டப்படும், விலையில்லாதவை எண்ணப்படும்.

வட்டியைக் காலமுறையாகச் செலுத்தும் loan-க்கு, due date வரை (அன்றும் சேர்த்து) செலுத்தும் புள்ளிகளும் உண்டு. ஒரு செலுத்தும் புள்ளியின் grace period முடிந்தும் நிலுவையில் உள்ள வட்டி, collateral-ஐ விற்றுச் செலுத்தப்படலாம்; loan திறந்தே இருக்கும். Home அடுத்த செலுத்தும் புள்ளியைக் காட்டி, நிலுவையில் உள்ளதை முதலில் வைக்கும்; அது due date அன்றே வந்தாலும் அப்படியே, ஏனெனில் அதன் grace period loan-இன் grace period-க்கு முன்பே முடியலாம். protocol இந்த settlement-ஐ நிறுத்தலாம்; அப்போது செலுத்தும் புள்ளியில் collateral எதுவும் விற்கப்படாது என்று Home சொல்லும்.

<a id="home-exposure"></a>

### Home: கொடுத்ததும் வாங்கியதும்

ஒவ்வொரு loan-இன் principal-உம், protocol-இன் ஒரே மதிப்பீட்டு
விதியின் மூலம், தற்போதைய விலைகளில் numeraire-இல் மதிப்பிடப்படுகிறது:
கடன் மேல்நோக்கி, நீங்கள் கொடுத்த loan கீழ்நோக்கி முழுமையாக்கப்படும்.
மதிப்பிட முடியாத loan (NFT அல்லது விலை இல்லாத asset) எண்ணப்படும்,
ஊகிக்கப்படாது. மதிப்பிடப்படாத loans பதிலை மாற்ற முடியாதபோது மட்டுமே
பெரிய பக்கம் குறிப்பிடப்படும்; இல்லையெனில் Home மதிப்பிடப்பட்ட
மொத்தங்களையும் எண்ணிக்கையையும் காட்டும்.

<a id="home-faucet"></a>

### Home: சோதனைச் சொத்துகள்

deployment பதிவு சோதனைச் சொத்துகளை வெளியிடும் சோதனை நெட்வொர்க்கில், Home அவற்றைப் பட்டியலிடும்: சோதனை விலை ஃபீடும் பூலும் இணைக்கப்பட்ட சோதனை ERC-20-கள் (லிக்விட்), வேண்டுமென்றே இரண்டும் இல்லாமல் விடப்பட்டவை (இலிக்விட்: அவற்றில் உள்ள கடன்களுக்கு விலை இல்லை, தவறுதல் பொருளாகவே தீர்க்கப்படும்), ERC-4907 வாடகை NFT-கள். உருவாக்கம் mock டோக்கன் ஒப்பந்தத்தை அழைக்கும், Diamond-ஐ ஒருபோதும் அல்ல: 1,000 முழு டோக்கன்கள், அல்லது வாலெட் திறக்கும் முன் உருவாக்கப்படாதது என்று சரிபார்க்கப்பட்ட புதிய சீரற்ற token id-உடன் ஒரு NFT. இருப்பு அல்லது `ownerOf`-ஐ மீண்டும் படித்து முடிவு அளவிடப்படும்; டோக்கன் உருவாக்கத்துக்குப் பின் `wallet_watchAsset` வழங்கப்படும். சோதனை NFT-ஐ அதன் உரிமையாளரோ அனுமதிக்கப்பட்ட இயக்குநரோ மட்டுமே எரிக்க முடியும்.

<a id="home-fee-discount"></a>

### Home: கட்டணத் தள்ளுபடி

`setVPFIDiscountConsent` இந்தச் சங்கிலியின் Diamond-இல் ஒவ்வொரு வாலெட்டுக்கும் ஒரு கொடியை அமைக்கும். அணைக்கப்பட்டால் hold-tier தள்ளுபடி 0. இயக்கப்பட்டால், கடன் வாங்குபவரின் கடன் தொடக்கக் கட்டணம் ஏற்கும்போது கடன் சொத்திலேயே குறையும் (VPFI விலை வழி கடன் வாங்குபவர் பாதையின் பகுதியாக ஒருபோதும் இருக்காது); கடன் கொடுப்பவரின் yield கட்டணம் ஒவ்வொரு தீர்வின்போதும் அப்போது நடைமுறையில் உள்ள பயனுள்ள நிலைப்படி தள்ளுபடி பெறும். வழங்கும் முறை `getVPFIDiscountConfig`-ஐப் பின்பற்றும்: VPFI விகிதமும் அதன் குறிப்புச் சொத்தும் இரண்டும் அமைக்கப்பட்டிருந்தால், தள்ளுபடி செய்யப்பட்ட கட்டணம் கடன் கொடுப்பவரின் வால்ட்டிலிருந்து VPFI-ஆகக் கழிக்கப்படும், அவர் முழு வட்டியையும் வைத்துக்கொள்வார்; இல்லையெனில் கருவூலக் கட்டணமே குறையும், VPFI நகராது. ஒரு தீர்வின்போது இந்தக் கழிப்பு நடக்க முடியாவிட்டால் (நடப்பு விலை இல்லை, வால்ட்டில் பதிவான கட்டற்ற VPFI போதாது, அல்லது அந்த VPFI பிணையாகப் பூட்டப்பட்டுள்ளது), அந்தத் தீர்வின் கட்டணத்துக்கு hold-tier தள்ளுபடி கிடைக்காது. அழைப்பு `whenNotPaused` என்பதால், உலகளாவிய இடைநிறுத்தம் இரு திசைகளிலும் அதை மூடும். இயக்குவது விதிமுறைகளுக்கு உட்பட்டது, அணைப்பது அல்ல; இரண்டுமே mirrors-க்கு நிலையை அனுப்பாது. கடன் வாங்குபவர் தள்ளுபடி, ஏற்கும்போது கடன் சொத்து திரவமாக இருந்தால் மட்டுமே பொருந்தும் (திரவமற்ற கடன் முழு LIF-ஐச் செலுத்தும்); ஒவ்வொரு தள்ளுபடியும் கட்டணத்தின் 50%-க்கு வரம்பிடப்பட்டது.

<a id="home-rewards"></a>

### Home: வெகுமதிகள்

தலைப்பு எண்ணிக்கை `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`, இது கோரலை Vault இலக்குடன் இயக்கி எப்போதும் revert செய்கிறது: `InteractionRewardsSimulation(paid, fromDay, toDay)` சரியான எண்ணிக்கையைச் சுமக்கிறது, வேறு எந்த revert-உம் கோரலின் சொந்த மறுப்பு (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`), அது பெயரால் காட்டப்படுகிறது. எந்த மூலமும் முன்னோட்டத்தை இயக்க முடியாதபோது மட்டுமே Home கீழ் வரம்பான `previewInteractionRewards`-ஐப் படித்து கோரலை நிறுத்தி வைக்கிறது. சரியான எண்ணிக்கை பூஜ்ஜியமாக இருந்தாலும் கோரல் வழங்கப்படுகிறது: எதையும் செலுத்தாத கோரலை, எதையும் செலுத்தாத வெகுமதி நாட்களைக் கடந்து முன்னேறும்போது மட்டுமே நெறிமுறை அனுமதிக்கிறது, Home அதைச் சொல்கிறது. Home `claimInteractionRewardsTo(2)` மூலம் கோருகிறது, இது ஒரு அழைப்புக்கு அதிகபட்சம் `MAX_INTERACTION_CLAIM_DAYS` (30) நாட்களைச் செலுத்துகிறது; முடிந்த கோரலின் தொகுதியிலோ அதற்குப் பிறகோ படித்த முன்னோட்டம் இன்னும் ஒரு தொகையைத் தந்தால் Home மீதியை வழங்குகிறது. வெகுமதி பதிவுகளில் இருந்து மட்டும் செலுத்தும் கோரல் நாள் வரம்பைக் குறிப்பிடுவதில்லை (0 முதல் 0), Home நாட்களுக்குப் பதிலாக அதைச் சொல்கிறது. Vault இலக்கு ஒப்பந்த வாலெட் உட்பட ஒவ்வொரு கணக்குக்கும் அனுப்பப்படுகிறது, ஏனெனில் Default இலக்கு ஒப்பந்த அழைப்பாளருக்கு அதன் வாலெட்டில் செலுத்துகிறது: வால்ட்டில் வரவு வைக்கப்படுகிறது, வரவை முடிக்க முடியாதபோது (இன்னும் வால்ட் இல்லை) வாலெட்டுக்குத் திரும்புகிறது. முடிவு ரசீதில் இருந்து படிக்கப்படுகிறது: `InteractionRewardsClaimed` செலுத்தியதைத் தருகிறது, அதே பரிவர்த்தனையில் வாலெட்டுக்கும் `getUserVaultAddress(user)`-க்கும் சென்ற VPFI `Transfer` பதிவுகள் அது எங்கே சேர்ந்தது என்பதைத் தருகின்றன; அவை செலுத்திய தொகைக்குச் சமமாகாதபோது இலக்கு தெரியாதது எனக் கூறப்படுகிறது. மொத்தமாகக் கோரியது காட்டப்படுவதில்லை: அதற்கான பயனர்வாரி அட்டவணை வழி இன்னும் இல்லை.

<a id="home-rewards-expiry"></a>

### Home: வெகுமதி நீக்கத் தேதிகள்

`ConfigFacet.getRewardClaimHorizonDays()` 0 என்றால் horizon அணைக்கப்பட்டுள்ளது, தேதி காட்டப்படாது. இல்லையெனில் Home `getUserSoonestRewardExpiry(user, offset, 200, 50)`-ஐப் பக்கம் பக்கமாக, எல்லாப் பக்கங்களும் ஒரே பிளாக்கில், அதிகபட்சம் பத்துப் பக்கங்கள் படிக்கும்; `nextOffset >= total` ஆனதும் வாசிப்பு முழுமையாகும்; முன்பே நின்ற வாசிப்பு "எதுவும் நிலுவையில் இல்லை" என்று அல்ல, முழுமையற்றது என்று அறிவிக்கப்படும். மிக விரைவான மதிப்பீட்டுக்கு 90 நாட்களுக்குள் இறுதி அறிவிப்பு காட்டப்படும். மதிப்பீடு அந்த பிளாக்கில் உள்ளீட்டின் `expiresAt`: கோரிக்கையை இயக்க முடியாத நேரம் உண்மையான நீக்கத்தைத் தள்ளிப்போடும், horizon-இல் ஆளுகை மாற்றம் அதை முன்னதாக்கலாம். உள்ளீடு நீக்கும் தொகை Home-இல் காட்டப்படாது.

<a id="home-rewards-held"></a>

### Home: நிறுத்திவைக்கப்பட்ட வெகுமதிகள்

`getSanctionsHeldReward(user)` நிறுத்திவைக்கப்பட்ட இருப்பு, `getRewardSanctionsStatus(user)` அதன் முடிவு (Deliver, Hold அல்லது Confirmed). இருப்பும் Deliver முடிவும் இருந்தால், Home `claimHeldInteractionRewards(2)`-ஐ வழங்கும்; அது புதிதாகச் செலுத்த வேண்டியதைத் தீர்க்காமல் நிறுத்திவைக்கப்பட்ட இருப்பை மட்டும் துல்லியமாக வழங்கி `InteractionRewardsClaimed(user, 0, 0, paid)`-ஐ வெளியிடும்; வாலெட் தடைசெய்யப்பட்டிருக்கும் வரை `SanctionedAddress` உடன் revert ஆகும். கையொப்பமிடுவதற்கு முந்தைய மறுசரிபார்ப்பு இரண்டையும் மீண்டும் படித்து, அனுப்புநராக அழைப்பை உருவகப்படுத்தும். உறுதிசெய்யப்பட்ட குறியின் போது ஈட்டிய நாட்கள் நிரந்தரமாகப் பறிமுதல் செய்யப்படும்.

<a id="borrow-start"></a>

### Borrow: இது எப்படி வேலை செய்கிறது

Borrow, ERC-20 பிணையத்துக்கு எதிரான ஒரு ERC-20 கடன் வழங்குநர் சலுகையை (`offerType` 0) `acceptOffer(offerId, terms, signature)` மூலம் நேரடியாக ஏற்கிறது. ஒரே பரிவர்த்தனையில், கடன் வாங்குபவருக்கு வால்ட் இல்லையெனில் அதைத் திறந்து, பிணையத்தை அதில் இழுத்து, தொடக்கக் கட்டணம் கழித்த அசலை வாலட்டுக்கு வழங்கி, `LoanInitiated` வெளியிடுகிறது. கடன் வாங்குபவர் ஒரு கோரிக்கையையும் (`offerType` 1) வெளியிடலாம்; NFT பக்கங்கள், இணை ஒப்புதல்கள், மேம்பட்ட விருப்பங்கள் பின்னர் வரும்.

<a id="borrow-pair"></a>

### Borrow: டோக்கன்களைத் தேர்ந்தெடுத்தல்

ஒவ்வொரு டோக்கனின் வகையும் நேரடியாகப் படிக்கப்படுகிறது: முதலில் `getAssetPriceStatus(asset)` (Divergent நம்பப்படாததாகக் கொள்ளப்பட்டு புதிய கடன்களை மூடும்), பிறகு `checkLiquidityOnActiveNetwork(asset)` (0 திரவம், 1 திரவமற்றது). `OraclePriceDivergence` அல்லது `OracleCrossCheckDivergence` revert நம்பப்படாததாகக் கொள்ளப்படும்; வேறு எந்தத் தோல்வியும் காரணத்துடன் படிக்க முடியாததாகக் காட்டப்படும். பரிந்துரைப் பட்டியல் வரிசைப்படுத்தல் பதிவின் wrapped native டோக்கனும் சோதனை டோக்கன்களும்; ஒட்டிய முகவரி வடிவத்துக்கு மட்டும் சரிபார்க்கப்படும்.

<a id="borrow-offers"></a>

### Borrow: ஒரு சலுகையைத் தேர்ந்தெடுத்தல்

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` இணையின் திறந்த சலுகை id-களையும் மொத்தத்தையும் தருகிறது. ஒவ்வொன்றுக்கும் பக்கம் `getOffer`, `getOfferState`, வாலட் இருந்தால் `previewAccept(offerId, wallet)` ஆகியவற்றைப் படிக்கிறது; அதன் `errorCode` நெறிமுறையின் மறுப்பு. கடன்-மதிப்பு விகிதம் இன்றைய விலைகளில் `calculateLTV`; திரவமற்ற அல்லது விலையற்ற பக்கம் ஏன் இல்லை என்று சொல்லும். நேரடி ஏற்பு கடன் வழங்குநரின் `amountMax`-ஐ `interestRateBps`-இல் பிணைக்கிறது. கடன் கோரிக்கைகள், NFT பக்கச் சலுகைகள், சொந்தச் சலுகைகள் எண்ணப்படும், பட்டியலிடப்படாது.

<a id="borrow-review"></a>

### Borrow: மதிப்பாய்வும் கையொப்பமும்

மதிப்பாய்வு சலுகை, அதன் நிலை, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, இரு வகைகள், `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, வாலட்டின் வால்ட், இருப்பு, ஒப்புதல், `previewOfferAcceptBlock`, தள்ளுபடி ஒப்புதல் ஆகியவற்றைப் படித்து, வாலட் திறக்கும் முன் மீண்டும் படிக்கிறது. சேமித்த சலுகையிலிருந்து உருவான EIP-712 `AcceptTerms`-ஐ (domain `Vaipakam AcceptOffer`, பதிப்பு 1) புதிய 128-பிட் nonce, 30 நிமிடக் காலக்கெடுவுடன் வாலட் கையொப்பமிடுகிறது; திரவமற்ற ஒப்புகை மதிப்பாய்வு திரவமற்றதாகக் காட்டிய பக்கத்தை மட்டுமே பெயரிடும். ஒப்புதல் போதாதபோது மட்டும் சரியாகப் பிணையத் தொகைக்கு ஒப்புதல், பின் `acceptOffer` கையொப்பத்துடன் சோதித்து அனுப்பப்படும். ஒப்புதலுக்குப் பின் நின்றால், வேறெதுவும் மாற்றாதிருந்தால் ஆப் அதை முந்தைய மதிப்புக்குத் திருப்பும். விளைவு இந்தச் சலுகைக்கும் வாலட்டுக்குமான `LoanInitiated`-ஐயும் ரசீதின் `Transfer` பதிவுகளையும் படிக்கிறது. முதல் வாலட் கோரிக்கைக்குச் சற்று முன் அனுமதி (allowance) மீண்டும் படிக்கப்படும், மீட்டமைப்பு அந்த மதிப்பையே திரும்ப வைக்கும்; அனுப்பப்பட்ட ஏற்பு revert ஆனாலும், வாலட் அதை ரத்து செய்தாலும் அல்லது மாற்றினாலும், பரிவர்த்தனை கண்காணிப்பு அதே மீட்டமைப்பைச் செய்யும். மதிப்பாய்வு `allowsPartialRepay`, `allowsPrepayListing`, `parallelSaleOrderHash` உடன் `allowsParallelSale`, `refinanceTargetLoanId` மற்றும் இணைக்கப்பட்ட கடனைக் காட்டுகிறது; செலுத்த வேண்டிய தொகையை இடைநிறுத்தம் இல்லாத நிலை எனக் குறிக்கிறது, ஏனெனில் இடைநிறுத்தத்தின்போது வட்டி சேரும், நிலுவைத் தேதி மட்டும் நகரும். ஒவ்வொரு ஒப்புதல் படியும் அதன் ரசீது சேர்ந்த பிளாக்கில் மீண்டும் படிக்கப்பட்ட அனுமதியால் மதிப்பிடப்படுகிறது, ரசீதின் நிலையால் ஒருபோதும் அல்ல. பூஜ்ஜியமல்லாத ஒரு அனுமதியை மற்றொன்றாக மாற்ற மறுக்கும் டோக்கனுக்கு (`approve` சோதனை ஓட்டத்தால் கண்டறியப்படுகிறது) முதலில் பூஜ்ஜியத்துக்கு ஒரு படி சேர்க்கப்படுகிறது; மதிப்பாய்வு அதைக் கூடுதல் கோரிக்கையாக எண்ணுகிறது. வாலட் திறப்பதற்குச் சற்று முன் விதிமுறைகளின் ஏற்பு மீண்டும் படிக்கப்படுகிறது. இரண்டு விற்பனை வழிகளும் பிணையை NFT ஆகப் பட்டியலிடுகின்றன; எனவே டோக்கன் பிணையில் வழங்கப்பட்ட பட்டியல் அல்லது விற்பனை அனுமதி இந்தக் கடன் பயன்படுத்த முடியாத ஒன்றாகக் கூறப்படுகிறது.

<a id="borrow-fee"></a>

### Borrow: தொடக்கக் கட்டணம்

கட்டணம் `previewAccept`-இன் `lifEstimate`: அசலின் `getLoanInitiationFeeBps`, கடன் டோக்கனில், வழங்கப்படுவதிலிருந்து கழிக்கப்படும்; ஒப்புதல் இயக்கத்திலும் கடன் டோக்கன் திரவமாகவும் இருந்தால் வைத்திருப்பு நிலைத் தள்ளுபடியால் குறையும், நிலை ஏற்கும் நேரத்தில் நிர்ணயிக்கப்படும். இந்தப் பக்கம் Full கட்டண முறையைத் தேர்வதில்லை. கட்டணத்துக்கு VPFI வசூலிக்கப்படுவதோ திருப்பித் தரப்படுவதோ இல்லை. சமர்ப்பிப்பவரின் பங்கு, கட்டணத்தின் `getLifMatcherFeeBps`, அனுப்புநருக்குச் செல்கிறது; நேரடி ஏற்பில் அது கடன் வாங்குபவர், எனவே வாலட் கட்டணம் கழித்த அசலுடன் அந்தப் பங்கையும் பெறுகிறது.

<a id="borrow-risks"></a>

### Borrow: இடர்கள்

சலுகைக் காலம் முடிந்த கடனை (நிலுவைத் தேதிக்குப் பின் `getEffectiveGraceSeconds`; இடைநிறுத்த நேரம் அதைத் தள்ளும்) யார் வேண்டுமானாலும் தவறியதாக்கலாம்: திரவப் பிணையம் கடன் வழங்குநருக்காக விற்கப்படும், திரவமற்றது அப்படியே மாற்றப்படும். ஹெல்த் ஃபேக்டர் 1-க்குக் கீழ் சென்றால் திரவப் பிணையம் லிக்விடேட்டும் செய்யப்படலாம். `useFullTermInterest` முன்கூட்டிய செலுத்தலில் முழுக்கால வட்டியை வசூலிக்கும்; வட்டி அட்டவணை தவறிய காலத்தைப் பிணையத்தின் கட்டாய விற்பனையால் தீர்க்கும்.

<a id="borrow-request"></a>

### Borrow: உங்கள் சொந்தக் கோரிக்கையை வெளியிடுதல்

கோரிக்கை என்பது கடன் வாங்குபவரின் வாலட்டிலிருந்து அனுப்பப்படும் `offerType` 1, இரு பக்கமும் ERC-20 கொண்ட `createOffer` ஆகும். அது `collateralAmount`-ஐக் கடன் வாங்குபவரின் வால்ட்டுக்கு எடுக்கிறது (வால்ட் இல்லையெனில் உருவாக்குகிறது), `OfferCreated(offerId, creator, 1)`-ஐ வெளியிடுகிறது. கடன் வழங்குநர் அதை `acceptOffer` மூலம் ஏற்கிறார்: கட்டணம் கழித்த அசல் கடன் வாங்குபவரின் வாலட்டுக்கும், கட்டணத்தில் அனுப்புநரின் பங்கு அனுப்பிய கடன் வழங்குநருக்கும் செல்கிறது. `cancelOffer` உருவாக்கியவருக்கு உருவாக்கி `MIN_OFFER_CANCEL_DELAY` (5 நிமிடம்) பிறகிலிருந்தும், கோரிக்கை காலாவதியானதும் யாருக்கும் திறந்திருக்கும்; பிணையம் எப்போதும் உருவாக்கியவருக்கே திரும்பும்.

<a id="borrow-request-terms"></a>

### Borrow: கோரிக்கையின் நிபந்தனைகள்

Basic ஒற்றை-மதிப்புக் கோரிக்கையை வெளியிடுகிறது: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 0, `periodicInterestCadence` 0, `allowsPrepayListing`, `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true. தொகைகள் அடிப்படை அலகுகளுக்குத் துல்லியமாக மாற்றப்படுகின்றன; விகிதம் அதிகபட்சம் 10,000 bps. `durationDays` `getProtocolConfigBundle`-இலிருந்து படிக்கும் அமைக்கப்பட்ட அதிகபட்சத்தால் வரம்பிடப்படுகிறது. `expiresAt` 0 (ரத்தாகும் வரை திறந்திருக்கும்) அல்லது மதிப்பாய்வு திறக்கும்போது சமீபத்திய பிளாக்கிலிருந்து நிர்ணயிக்கப்படும் நேரம், அதிகபட்சம் `MAX_OFFER_EXPIRY_HORIZON` (365 நாட்கள்) முன்னால். `useFullTermInterest` இயல்பாக true, `allowsPartialRepay` false.

<a id="borrow-request-review"></a>

### Borrow: கோரிக்கையை மதிப்பாய்வு செய்து வெளியிடுதல்

மதிப்பாய்வு வாலட்டிலிருந்து `createOffer`-ஐ உருவகப்படுத்தி, இரு வகைகள், `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, அதிகபட்சக் காலம், வாலட்டின் வால்ட், இருப்பு, ஒப்புதல் தொகை, இரு பக்கமும் நீர்மையாக இருந்தால் `calculateLTV` ஆகியவற்றைப் படிக்கிறது; ஒவ்வொரு பிளாக்கிலும், வாலட் திறக்கும் முன்பும் மீண்டும் படிக்கப்படுகிறது. ஒப்புதல் போதாத வரை உருவகப்படுத்தல் பிணையத்தை இழுக்கும் படி வரை மட்டுமே செல்லும்; எனவே டோக்கனின் இழுப்புப் பிழை அல்லது நெறிமுறைப் பிழைப் பெயர் இல்லாத revert தீர்க்க வேண்டிய ஒப்புதலாகக் காட்டப்படுகிறது, பெயருள்ள நெறிமுறைப் பிழை மறுப்பு ஆகும். சரியான ஒப்புதலுக்குப் பின் `createOffer` மீண்டும் உருவகப்படுத்தப்பட்டு அனுப்பப்படுகிறது; ஒப்புதலுக்குப் பின் நின்றால், வேறு எதுவும் மாற்றாதிருந்தால் ஒப்புதல் முந்தைய மதிப்புக்குத் திருப்பப்படுகிறது. முடிவு இந்த வாலட்டின் `OfferCreated`, வால்ட்டுக்குள் பிணையத்தின் `Transfer` ஆகியவற்றிலிருந்து படிக்கப்படுகிறது.

<a id="borrow-nft-collateral"></a>

### Borrow: NFT-ஐ பிணையமாக

பிணையத்தின் தரநிலை `supportsInterface` மூலம் படிக்கப்படுகிறது (ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`); revert இரண்டுமில்லை எனக் கொள்ளப்படும், தோல்வியடைந்த வாசிப்பு எந்தக் கோரிக்கையையும் வழங்காது. ERC-721 கோரிக்கை `collateralAssetType` 1, `collateralTokenId` உள்ளிட்ட ஐடி, `collateralQuantity` 1, `collateralAmount` = `collateralAmountMax` = 0 ஆகியவற்றை அனுப்புகிறது; இடர் ஜோடி அந்த டோக்கன் ஐடியுடன் பிணைக்கப்படுகிறது. மதிப்பாய்வு ஒரே பிளாக்கில் `ownerOf`, `getApproved`, `isApprovedForAll(wallet, Diamond)` ஆகியவற்றைப் படிக்கிறது; வேறொருவர் வைத்திருக்கும் டோக்கன் அல்லது revert ஆகும் `ownerOf` கோரிக்கையைத் தடுக்கும். எந்த ஒப்புதலும் இல்லாவிட்டால் சோதனை ஓட்டம் டோக்கனின் `ERC721InsufficientApproval`-இல் நிற்கும்; அது தர வேண்டிய ஒப்புதலாகக் காட்டப்படும். ஒப்புதல் `approve(Diamond, id)`; ரசீதின் பிளாக்கில் `getApproved` Diamond-ஐப் படித்தால் மட்டுமே அது கணக்கில் கொள்ளப்படும்; பிறகு நின்றால், அது இன்னும் Diamond-ஐப் படித்து வாலெட் இன்னும் டோக்கனை வைத்திருக்கும் வரை மட்டுமே முந்தைய முகவரிக்கு மீட்டமைக்கப்படும். ERC-721-க்கு `setApprovalForAll` ஒருபோதும் கேட்கப்படாது. விளைவு `OfferCreated`-ஐயும் வாலெட்டிலிருந்து வால்ட்டுக்கான டோக்கனின் சொந்த `Transfer`-ஐயும் (நான்கு topics) படிக்கிறது. ERC-1155 கோரிக்கை `collateralAssetType` 2, டோக்கன் id, உள்ளிட்ட அளவாக `collateralQuantity` (1 முதல் 2^128−1 வரை), இரு தொகைகளும் 0 என அனுப்புகிறது. மதிப்பாய்வு ஒரே பிளாக்கில் `balanceOf(wallet, id)`-ஐயும் `isApprovedForAll(wallet, Diamond)`-ஐயும் படிக்கிறது; அளவை விடக் குறைந்த இருப்பு கோரிக்கையைத் தடுக்கிறது, ஒப்புதல் இல்லையெனில் சோதனை ஓட்டம் `ERC1155MissingApprovalForAll`-இல் நிற்கிறது. ஒரே ஒப்புதல் `setApprovalForAll(Diamond, true)`; அதன் ரசீதின் பிளாக்கில் திரும்பப் படிக்கப்படும்போது கணக்கில் கொள்ளப்படும், கோரிக்கை மைன் ஆன பிறகோ நின்ற பிறகோ `setApprovalForAll(Diamond, false)` மூலம் திரும்பப் பெறப்படும் (ஒப்புதலின் பிளாக்குக்கு முன் ஒருபோதும் படிக்காமல்), வாலெட் முன்பே அதைத் தந்திருந்தால் தவிர. விளைவு வாலெட்டிலிருந்து வால்ட்டுக்கான டோக்கனின் `TransferSingle`/`TransferBatch`-ஐக் கூட்டுகிறது. NFT கேட்கும் கடன் கொடுப்பவர் சலுகைகள் இன்னும் தற்போதைய செயலிக்குச் செல்கின்றன.

<a id="borrow-request-range"></a>

### Borrow: வரம்புடைய கோரிக்கை

வரம்பு `amount` (மிகச் சிறியது) ஐ `amountMax` (மிகப் பெரியது) க்குக் கீழாகவும், `interestRateBps` = `interestRateBpsMax` (ஒரே விகிதம்) ஆகவும், `collateralAmount` (மிகச் சிறிய கடனுக்கான தளம்) ஐ `collateralAmountMax` (இடுகையிடும்போது வால்ட்டுக்கு எடுக்கப்படுவது) க்குச் சமமாகவோ குறைவாகவோ அனுப்பும்; தளம் காலியாக இருந்தால் இரண்டும் சமமாக அனுப்பப்படும். வரம்புகள் ERC-20 பிணையத்துக்கு மட்டுமே வழங்கப்படுகின்றன. நேரடி `acceptOffer` `collateralAmount` க்கு எதிராக `interestRateBpsMax` இல் `amount` ஐ வழங்கி, `collateralAmountMax − collateralAmount` ஐ வாலெட்டுக்குத் திருப்பும்; `getPartialFillEnabled` true ஆக இருக்கும் வரை `matchOffers` இரு முனைகளுக்கிடையே நிரப்பும். `createOffer` சோதனை ஓட்டம் மிகப் பெரிய முனையில் சலுகை வரம்பைப் பயன்படுத்தி `MaxLendingAboveCeiling(provided, ceiling)` மூலம் மறுக்கும்; அதன் உச்சவரம்பை மதிப்பாய்வு காட்டும். நேரடி முனை (`amount`, `collateralAmount`) இல் ஒற்றை மதிப்புக் கோரிக்கையின் இரண்டாம் சோதனை ஓட்டத்தால் சரிபார்க்கப்படும்; வரம்புக்கு முன் நிற்கும் பதில் தெரியாதது எனக் குறிக்கப்படும். ஒவ்வொரு முனையின் கடன்-மதிப்பு விகிதம் `calculateLTV(lending, amount, collateral, collateralAmount)`, மேலும் `ZeroCollateral` மதிப்பற்ற பிணையமாகப் படிக்கப்படும். காட்டப்படும் கடன் தொடக்க ஆரோக்கியக் காரணி `getDepthTieredLtvEnabled` false ஆக இருக்கும்போது `getMinHealthFactor`, true ஆக இருக்கும்போது 1.0. ஒரு பொருத்தம் கடன் வழங்குநரின் விகிதாசாரத் தேவையைப் பூட்டுகிறது; பிணையம் வரம்பாக இருந்தால் `collateralAmount` வரை உயர்த்துகிறது, இல்லையெனில் தேவையிலேயே விடுகிறது; எனவே மிகப்பெரிய பொருத்தம் `collateralAmountMax` மற்றும் `collateralAmount` இரண்டிலும் காட்டப்படுகிறது (பிணைய வரம்பு இல்லையெனில், குறைவாகப் பூட்டக்கூடியதாக); அதைக் கடன் தொடக்கச் சரிபார்ப்பு மட்டுமே வரம்பிடுகிறது, அந்தச் சரிபார்ப்பைப் படிக்கத் தவறினால் அது கூறப்படும், ஒருபோதும் விடப்படாது. அடுக்கு முறையில், சரிபார்ப்பு அடுக்கின் கடன்-மதிப்பு உச்சவரம்பையும் பயன்படுத்துகிறது. `getPartialFillEnabled` true ஆக இருக்கும் வரை, பொருத்தம் பூட்டாத பிணையம் பின்வரும் பொருத்தங்களுக்காக வால்ட்டில் இருக்கும்; கோரிக்கை மூடும்போது (அதன் மீதமுள்ள கொள்ளளவு `amount` க்குக் கீழே குறையும்போது) அல்லது `cancelOffer` இயங்கும்போது மட்டுமே திருப்பப்படும்.

<a id="borrow-request-fill"></a>

### Borrow: கோரிக்கையின் நிரப்பும் முறை

`fillMode` 0 (Partial), 1 (AON) அல்லது 2 (IOC); இடுகையிட்ட பிறகு மாறாது. AON க்கு `amount` = `amountMax` தேவை (`AonRequiresSingleValueAmount`), IOC க்கு `expiresAt` ≠ 0 தேவை (`IocRequiresExpiry`); மறுக்கப்படும் எந்த வடிவத்தையும் படிவம் வழங்காது. திறந்த கோரிக்கையில் தொகைகள், வட்டி விகிதம், பிணையம் ஆகியவற்றை `setOfferAmount`, `setOfferRate`, `setOfferCollateral`, `modifyOffer` மூலம் மாற்றலாம், ஆனால் `amountFilled` அல்லது `collateralAmountFilled` க்குக் கீழே ஒருபோதும் இல்லை; இந்தச் செயலி இன்னும் அவற்றை அழைப்பதில்லை.

<a id="borrow-request-cadence"></a>

### Borrow: கோரிக்கையின் வட்டி அட்டவணை

`periodicInterestCadence` 0 (None) முதல் 4 (Annual) வரை; காலங்கள் 30, 90, 180, 365 நாட்கள். `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` அனுமதிப்பதையே படிவம் வழங்குகிறது; அது `createOffer` செயல்படுத்தும் விதியை `amount` (வரம்பின் சிறிய முனை) மதிப்பில் இயக்குகிறது. ஒவ்வொரு மறுப்பும் அதன் ரிவர்ட் தரவிலிருந்து கூறப்படுகிறது: `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid`, அல்லது `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`. ஒரு காலத்தின் வட்டி `principal × rate × intervalDays / (10000 × 365)`. சலுகைக் காலம் `getEffectiveGraceSeconds(intervalDays − 1)` கடந்த பின், தவறிய காலத்தை யார் வேண்டுமானாலும் `settlePeriodicInterest` மூலம் தீர்க்கலாம்; அது பிணையத்தை விற்கிறது, கடன் திறந்தே இருக்கும். கீப்பர் பாஸ் `periodicSettle` இயக்க நிலை, திறன் சேவை தெரிவிப்பது போலவே காட்டப்படுகிறது; இயல்பாகத் தெரியாது. பதிவிட்ட பிறகு அட்டவணையை மாற்ற முடியாது.

<a id="borrow-request-tariff"></a>

### Borrow: கோரிக்கையின் முழு கட்டண விகிதம்

தேர்வு `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`; உருவாக்கியவர் `createOffer`-க்குப் பின் அனுப்புவது; கடன் வழங்குநர் கோரிக்கையை ஏற்றதும் `OfferAlreadyAccepted` மூலம் மறுக்கப்படும்; `maxCStar` பூஜ்ஜியத்தை விட அதிகமாக இருக்க வேண்டும் (`FullTariffMaxCStarRequired`). படிவம் சுவிட்சை `getFeeEntitlementConfig()`-இலிருந்தும் விகிதத்தை `quoteCStar(lendingAsset, principal, durationDays)`-இலிருந்தும் காட்டுகிறது, வரம்புக்கு `amount`, `amountMax` இரண்டிலும்; உச்சவரம்பின் இயல்பு மதிப்பு `amountMax`-இல் உள்ள மதிப்பீடு. ஒவ்வொரு ஏற்பிலும், அந்தக் கடனின் அசலில் கணக்கிட்ட `C*`-ஐ வசூல் எடுக்கும்; சுவிட்ச் இயக்கத்தில் இருந்து, அசலுக்கு விலையும் நீர்மையும் இருந்து, `C* ≤ maxCStar` ஆக இருந்து, பெட்டகத்தின் கட்டற்ற VPFI (`getTrackedVPFIBalance` வரம்புக்குட்பட்ட பெட்டக இருப்பு, செயலில் உள்ள பிணைகள் கழித்து, `getFreeBalance` வழியாக) அதை ஈடுசெய்தால் மட்டுமே; இல்லையெனில் `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed` அல்லது `FeeEntitlementTariffAboveAuth` மூலம் திரும்பும், `allowDowngrade` கடனை அது இல்லாமல் திறக்க விட்டால் தவிர. கடன் வாங்குபவரின் கடன் கட்டணத் தள்ளுபடி `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) உயரும், `MAX_FEE_DISCOUNT_BPS` (5000) உச்சவரம்புடன். ஒவ்வொரு கடனும் மறுக்கப்படும் தேர்வை மதிப்பாய்வு தடுக்கிறது; `getOffer`-ஐ மீண்டும் படித்து தேர்வு அளக்கப்படுகிறது (`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`). நிரப்பப்படாத கோரிக்கைகளுக்கான பின்னிருப்புக் கடனை இந்தச் செயலி இன்னும் வழங்கவில்லை.

<a id="lend-start"></a>

### Lend: இது எப்படி வேலை செய்கிறது

Lend, ERC-20 பிணையத்துக்கு எதிரான ERC-20 கடன் கோரிக்கையை (`offerType` 1), கடனளிப்பவர் அனுப்பும் `acceptOffer(offerId, terms, signature)` மூலம் நேரடியாக ஏற்கிறது. ஒரே பரிவர்த்தனையில் அசல், Diamond-க்கான அனுமதியின் கீழ், கடனளிப்பவரின் வாலட்டிலிருந்து கடனளிப்பவரின் வால்ட்டுக்கு இழுக்கப்படுகிறது; கடன் வாங்குபவர் தொடக்கக் கட்டணம் கழித்து அதைப் பெறுகிறார்; கடன் வாங்குபவரின் வால்ட்டில் ஏற்கெனவே உள்ள பிணையம் கடனின் பிணையமாகிறது; `LoanInitiated` வெளியிடப்படுகிறது, கடனளிப்பவருக்கும் கடன் வாங்குபவருக்கும் தலா ஒரு நிலை NFT உடன். கடன் சலுகை (`offerType` 0) அதே பக்கத்திலிருந்து வெளியிடப்படுகிறது; NFT பக்கங்கள் பின்வரும் புதுப்பிப்பில் வரும்.

<a id="lend-offers"></a>

### Lend: ஒரு கோரிக்கையைத் தேர்ந்தெடுத்தல்

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` இணையின் திறந்த சலுகை ids-ஐத் தருகிறது. ஒவ்வொன்றுக்கும் பக்கம் `getOffer`, `getOfferState`, `getOfferLinkedLoanId`, வாலட் இருந்தால் `previewAccept(offerId, wallet)` ஆகியவற்றைப் படிக்கிறது; அதன் `errorCode` நெறிமுறையின் மறுப்பு. நேரடி ஏற்பு கோரிக்கையின் `amount`-ஐ (அதன் குறைந்தபட்சம்) `interestRateBpsMax`-இல் பிணைக்கிறது, கடன்-மதிப்பு விகிதம் அந்தத் தொகையின் மீது இன்றைய விலைகளில் `calculateLTV`. கடனளிப்பவர் சலுகைகள், NFT பக்கங்கள், வாசிப்பவரின் சொந்தக் கோரிக்கைகள், கடனளிப்பவர்-நிலை விற்பனை வாகனங்கள் (பூஜ்ஜியமற்ற `getOfferLinkedLoanId` கொண்ட கடன் வாங்குபவர் பக்கச் சலுகை) எண்ணப்படுகின்றன, பட்டியலிடப்படுவதில்லை. வரிசை: நிதி அளிக்கக்கூடியவை முதலில், பிறகு விகிதம் இறங்குவரிசையில், பிறகு தொகை இறங்குவரிசையில்.

<a id="lend-review"></a>

### Lend: மதிப்பாய்வும் கையொப்பமும்

மதிப்பாய்வு Borrow படிப்பதையே படிக்கிறது (சலுகை, அதன் நிலை, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, இரு வகைகள், `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, வாலட்டின் வால்ட், `previewOfferAcceptBlock`, கட்டணத் தள்ளுபடி ஒப்புதல்), கூடவே `getTreasuryFeeBps`; இருப்பையும் அனுமதியையும் கடன் சொத்தில், அதாவது கடனளிப்பவர் செலுத்தும் பக்கத்தில், அளக்கிறது. அதில் பற்றாக்குறை கையொப்பத்தைத் தடுக்கிறது, கடனளிப்பவர்-நிலை விற்பனை வாகனமும் அப்படியே. வாலட் EIP-712 `AcceptTerms`-இல் (டொமைன் `Vaipakam AcceptOffer`, பதிப்பு 1) கையொப்பமிடுகிறது, அனுமதி குறைவாக இருக்கும்போது மட்டும் சரியாக அசலுக்கு ஒப்புதல் அளிக்கிறது (பூஜ்ஜியமற்ற மதிப்புகளுக்கு இடையிலான மாற்றத்தை மறுக்கும் டோக்கனுக்கு முதலில் பூஜ்ஜியப் படியுடன்), `acceptOffer` உருவகப்படுத்தப்பட்டு அனுப்பப்படுகிறது; நின்றுபோன ஓட்டம் விட்டுச்செல்லும் அனுமதி Borrow-இல் போலவே மீட்டமைக்கப்படுகிறது. முடிவு இந்தச் சலுகைக்கான `LoanInitiated`, வாலட்டிலிருந்து அசலின் `Transfer`, பொருத்துநர் பங்கின் திரும்பும் `Transfer` ஆகியவற்றைப் படிக்கிறது.

<a id="lend-fee"></a>

### Lend: கட்டணமும் நெறிமுறையின் பங்கும்

கட்டணம் `previewAccept`-இன் `lifEstimate`, அது கடன் வாங்குபவருடையது: கடன் சொத்தில் அசலின் `getLoanInitiationFeeBps`, கடன் வாங்குபவருக்கான விநியோகத்திலிருந்து கழிக்கப்படுகிறது, ஏற்பின்போது கடன் வாங்குபவரின் வைப்பு-நிலைத் தள்ளுபடியாலும், `creatorFull` அமைக்கப்பட்டு வசூல் வெற்றியடைந்தால் Full தீர்வை போனஸாலும் குறைக்கப்படுகிறது. சமர்ப்பிப்பவரின் பங்கு, கட்டணத்தின் `getLifMatcherFeeBps`, அனுப்புநருக்கு, இங்கே கடனளிப்பவருக்கு, செலுத்தப்படுகிறது. வட்டியில் நெறிமுறையின் பங்கு `getTreasuryFeeBps`, ஒவ்வொரு கடனுக்கும் தொடங்கும்போது நிலைநிறுத்தப்படுகிறது (`treasuryFeeBpsAtInit`); ஒப்புதல் இயக்கத்தில் இருந்தால், வட்டி தீர்க்கப்படும்போது கடனளிப்பவரின் வைப்பு-நிலைத் தள்ளுபடி அதைக் குறைக்கிறது. மதிப்பாய்வு இன்றைய விகிதத்தையும், அந்த விகிதத்தில் பங்கை மேல் வரம்பாகவும் காட்டுகிறது.

<a id="lend-risks"></a>

### Lend: இடர்கள்

சலுகை முடிவைத் தாண்டிய கடனை (நிலுவைத் தேதிக்குப் பின் `getEffectiveGraceSeconds`, இடைநிறுத்த நேரம் அதைத் தள்ளிப்போடும்) யார் வேண்டுமானாலும் தவறியதாக்கலாம்: திரவப் பிணையம் கடனளிப்பவருக்காக விற்கப்படுகிறது, திரவமற்ற பிணையம் உள்ளபடியே மாற்றப்படுகிறது. இரு பக்கங்களும் திரவமாக இருந்தால், ஆரோக்கியக் காரணி 1-க்குக் கீழே இருக்கும்போது கடனைக் கலைக்கலாம், விற்பனை முதலில் கடனளிப்பவருக்குச் செலுத்தும். திரவமற்ற பக்கம் விலை அடிப்படையிலான கலைப்பைத் தவிர்க்கிறது, தவறினால் கடனளிப்பவர் முழுப் பிணையத்தையும் பெறுகிறார். `useFullTermInterest` முன்கூட்டிய திருப்பிச் செலுத்தலில் வட்டிக்குக் குறைந்தபட்ச வரம்பு வைக்கிறது; அது இல்லாவிட்டால் வட்டி விகிதாசாரம். கால வட்டி அட்டவணை, தவறிய காலத்தைப் பிணையத்தின் கட்டாய விற்பனை மூலம் கடனளிப்பவருக்குத் தீர்க்கிறது. கடனளிப்பவரின் நிலை NFT உரிமையைத் தாங்குகிறது: அதை மாற்றுவது கடனை மாற்றுவதாகும்.

<a id="lend-offer"></a>

### Lend: உங்கள் சொந்தச் சலுகையை வெளியிடுதல்

கடன் சலுகை என்பது `offerType` 0 உடன் கூடிய `createOffer`, இரு பக்கமும் ERC-20, கடனளிப்பவரின் வாலட்டிலிருந்து அனுப்பப்படுகிறது. அது கடன் சொத்தின் `amountMax`-ஐக் கடனளிப்பவரின் வால்ட்டுக்குள் இழுக்கிறது, வால்ட் இல்லையென்றால் உருவாக்குகிறது, `OfferCreated(offerId, creator, 0)`-ஐ வெளியிடுகிறது. கடன் வாங்குபவர் அதை `acceptOffer` மூலம் ஏற்கிறார்: அவரது பிணையம் அவரது வால்ட்டுக்குள் இழுக்கப்படுகிறது, கட்டணம் கழித்த அசல் அவரது வாலட்டுக்குச் செல்கிறது, கட்டணத்தில் அனுப்புநரின் பங்கு அனுப்புநர் என்ற முறையில் அவருக்குச் செல்கிறது. `getPartialFillEnabled` true ஆக இருக்கும் வரை, `matchOffers` அதை ஒரு கடன் வாங்குபவரின் கோரிக்கையுடனும் இணைக்கலாம்; அப்போது ஒற்றை மதிப்புக் கடனளிப்பவர் சலுகை தனது விகிதத்தில் தனது முழுத் தொகையையும் கொடுக்கிறது, அதன் `collateralAmount`-க்குக் குறையாமல். `cancelOffer` உருவாக்கியதிலிருந்து `MIN_OFFER_CANCEL_DELAY` (5 நிமிடங்கள்) பிறகு உருவாக்கியவருக்கும், சலுகை காலாவதியானவுடன் எவருக்கும் திறந்திருக்கும்; தொகை எப்போதும் உருவாக்கியவருக்கே திரும்பும்.

<a id="lend-offer-terms"></a>

### Lend: சலுகையின் நிபந்தனைகள்

பகுதிகள் இல்லாத கடன் சலுகை ஒற்றை மதிப்புடையது: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (கடன் வாங்குபவர் பூட்ட வேண்டிய ஒரே பிணையம்), `fillMode` 0 (Advanced வேறொன்றை அமைக்காவிட்டால்; அடுத்த பகுதி), `periodicInterestCadence` 0 (மேம்பட்டதில் அட்டவணை அமைக்காவிட்டால்), `allowsPrepayListing`, `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true, மேம்பட்டதில் தேர்ந்தெடுக்காவிட்டால் Full தீர்வை இல்லை. தொகைகள் அடிப்படை அலகுகளில் துல்லியமாகப் பாகுபடுத்தப்படுகின்றன, விகிதம் அதிகபட்சம் 10,000 bps. `durationDays` `getProtocolConfigBundle`-இலிருந்து படிக்கப்படும் அமைக்கப்பட்ட அதிகபட்சத்தால் வரம்பிடப்படுகிறது. `expiresAt` 0 (ரத்து செய்யும் வரை திறந்திருக்கும்) அல்லது மதிப்பாய்வு திறக்கும்போது சமீபத்திய பிளாக்கிலிருந்து நிர்ணயிக்கப்படும் நேரம், அதிகபட்சம் `MAX_OFFER_EXPIRY_HORIZON` (365 நாட்கள்) முன்னால். `useFullTermInterest` இயல்பாக true, `allowsPartialRepay` false.

<a id="lend-offer-parts"></a>

### Lend: பகுதிகளாகக் கொடுக்கப்படும் சலுகை

பகுதிகள் `amount`-ஐ (ஒரு பொருத்துதல் கொடுக்கக்கூடிய மிகச்சிறிய பகுதி) `amountMax`-க்கு (முழுத் தொகை, `createOffer` அதை வால்ட்டுக்குள் இழுக்கிறது) கீழே அனுப்புகின்றன; `collateralAmount` = `collateralAmountMax` ஒரே தேவையாகவே இருக்கும், `amountMax`-க்குக் கணக்கிடப்பட்டு (இல்லையெனில் `LenderCollateralRangeNotAllowed`), `interestRateBps` = `interestRateBpsMax`. கடன் சலுகையின் நேரடி `acceptOffer` `collateralAmount`-க்கு எதிராக `amountMax`-ஐக் கொடுக்கிறது, `amountFilled` 0 ஆக இருக்கும் வரை மட்டும் (பொருத்துதலுக்குப் பிறகு `OfferPartiallyFilled`). `getPartialFillEnabled` true ஆக இருக்கும் வரை, `matchOffers` தொகை மேல்படிவின் நடுப்புள்ளியை, குறைந்தது `amount`, விகித மேல்படிவின் நடுப்புள்ளியில், குறைந்தது `collateralAmount × matchAmount ÷ amountMax`-க்கு எதிராகக் கொடுக்கிறது (கீழ்நோக்கி முழுமையாக்கப்பட்டு; கடன் வாங்குபவரின் பிணைய வரம்பு அதை உயர்த்தலாம்). `amountMax − amountFilled` `amount`-க்குக் கீழே குறையும்போது, மீதி கடன் கொடுப்பவரின் வாலட்டுக்கு எடுக்கப்பட்டு சலுகை மூடப்படுகிறது (`OfferClosed`, காரணம் `Dust` அல்லது `FullyFilled`). பகுதியாக நிரம்பிய சலுகையில் `cancelOffer` காத்திருப்பைத் தவிர்த்து `amountMax − amountFilled`-ஐத் திருப்புகிறது. `fillMode` கோரிக்கையில் உள்ளது போல 0, 1 அல்லது 2: AON-க்கு `amount` = `amountMax` தேவை, IOC-க்குக் காலாவதி தேவை, வெளியிட்ட பிறகு அது மாறாது. இரு பக்கங்களும் திரவமாக இருந்தால், `amountMax`-இல் உள்ள கீழ்வரம்புக்குக் கீழான `collateralAmount`-ஐ `createOffer` `MinCollateralBelowFloor(provided, floor)` மூலம் மறுக்கிறது; அந்த வரம்பை மதிப்பாய்வு காட்டுகிறது. ஒரே கடன்-மதிப்பு விகிதம் காட்டப்படுகிறது, (`amountMax`, `collateralAmount`)-இல் `calculateLTV`: முழுமையாக்கலைத் தவிர ஒவ்வொரு பகுதிக்கும் அதே விகிதம்.

<a id="lend-offer-schedule"></a>

### Lend: சலுகையின் வட்டி அட்டவணை

கடன் சலுகையின் `periodicInterestCadence` கோரிக்கையின் விதியை (மேலே) பின்பற்றுகிறது, `previewCadenceAdmission` சலுகையின் `amount`-இல் மதிப்பிடப்படுகிறது: அதன் மிகச்சிறிய பகுதி, அல்லது பகுதிகள் இல்லாவிட்டால் முழுத் தொகை. `createOffer` அதை அங்கே `requireCadenceAdmitted` மூலம் ஏற்கிறது, ஒவ்வொரு கடனின் தொடக்கமும் அதன் சொந்த அசலை மீண்டும் சரிபார்க்கிறது (`requireOriginationCadenceAdmitted`). மதிப்பாய்வு ஒரு காலத்தின் வட்டியை `amountMax`-இல் (நேரடி ஏற்பு), பகுதிகளுடன் `amount`-இலும் கூறுகிறது. தவறிய காலத்தை அதன் சலுகைக் காலத்துக்குப் பிறகு யார் வேண்டுமானாலும் `settlePeriodicInterest` மூலம் தீர்க்கலாம்: அந்தக் காலத்தின் வட்டியைக் கடன் கொடுப்பவருக்குச் செலுத்தப் பிணையம் விற்கப்படுகிறது, கடன் திறந்தே இருக்கும்.

<a id="lend-offer-tariff"></a>

### Lend: சலுகையின் முழு கட்டண விகிதம்

கடன் கொடுப்பவரின் விருப்பத் தேர்வும் அதே `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, `createOffer`-க்குப் பிறகு அனுப்பப்படுகிறது. சலுகை முழுமையாக ஏற்கப்பட்டதும் அல்லது மூடப்பட்டதும் அது `OfferAlreadyAccepted` உடன் மறுக்கப்படுகிறது; பகுதியாகப் பொருத்தப்பட்ட சலுகை அதன் பிந்தைய கடன்களுக்காக இன்னும் அதை ஏற்கிறது. மதிப்பீடு `amount`, `amountMax`-இல் `quoteCStar`, உச்சவரம்பின் இயல்புநிலை `amountMax`-இல் உள்ள மதிப்பீடு. ஒவ்வொரு கடனும் அதன் அசலில் விலையிடப்பட்டு தனியாக `maxCStar`-உடன் சரிபார்க்கப்படுகிறது, கோரிக்கையின் அதே நிபந்தனைகளில் (`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`, அல்லது அனுமதித்தால் தரக்குறைப்பு); கடன் கொடுப்பவரின் சரிபார்ப்பு பெட்டகத்தின் தற்போதைய கட்டற்ற VPFI-ஐப் பயன்படுத்துகிறது. எடுக்கப்பட்ட விகிதம் கடனின் `lenderMode`-ஐ Full எனக் குறிக்கிறது, பின்னர் கடன் கொடுப்பவரின் ஒவ்வொரு விளைச்சல்-கட்டணத் தீர்வும் நெறிமுறையின் பங்கில் நிலை வைத்திருப்பவரின் தள்ளுபடியுடன் `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000)-ஐச் சேர்க்கிறது, `MAX_FEE_DISCOUNT_BPS` (5000) உச்சவரம்புடன், வைத்திருப்புத் தள்ளுபடி ஒப்புதல் இருந்தாலும் இல்லாவிட்டாலும். இடத்திலேயே நீட்டிப்பு (`repriceFeeEntitlementOnExtension`) புதிய காலத்துக்கு அந்தக் குறியை None ஆக்குகிறது.

<a id="lend-offer-review"></a>

### Lend: சலுகையை மதிப்பாய்வு செய்து வெளியிடுதல்

மதிப்பாய்வு வாலட்டிலிருந்து `createOffer`-ஐ உருவகப்படுத்தி, இரு வகைகள், `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, அதிகபட்சக் காலம், வாலட்டின் வால்ட், கடன் சொத்தில் (கடனளிப்பவர் பூட்டும் பக்கம்) அதன் இருப்பும் ஒப்புதல் தொகையும், இரு பக்கமும் நீர்மையாக இருந்தால் `calculateLTV` ஆகியவற்றைப் படிக்கிறது; ஒவ்வொரு பிளாக்கிலும், வாலட் திறக்கும் முன்பும் மீண்டும் படிக்கப்படுகிறது. ஒப்புதல் போதாத வரை உருவகப்படுத்தல் தொகையை இழுக்கும் படி வரை மட்டுமே செல்லும்; எனவே டோக்கனின் இழுப்புப் பிழை, `VaultDepositFailed` (தரவு இல்லாமல் revert ஆன இழுப்பை நெறிமுறை சுற்றியது, ஒப்புதல் போதாதபோது WETH அப்படிச் செய்கிறது) அல்லது நெறிமுறைப் பிழைப் பெயர் இல்லாத revert தீர்க்க வேண்டிய ஒப்புதலாகக் காட்டப்படுகிறது, கோரிக்கையின் மதிப்பாய்வில் உள்ள அதே விதி; பெயருள்ள வேறு எந்த நெறிமுறைப் பிழையும் மறுப்பு ஆகும். சரியான ஒப்புதலுக்குப் பின் `createOffer` மீண்டும் உருவகப்படுத்தப்பட்டு அனுப்பப்படுகிறது; ஒப்புதலுக்குப் பின் நின்றால், வேறு எதுவும் மாற்றாதிருந்தால் ஒப்புதல் முந்தைய மதிப்புக்குத் திருப்பப்படுகிறது. முடிவு இந்த வாலட்டின் `offerType` 0 உடைய `OfferCreated`, வால்ட்டுக்குள் தொகையின் `Transfer` ஆகியவற்றிலிருந்து படிக்கப்படுகிறது.

<a id="lend-offer-fee"></a>

### Lend: உங்கள் சலுகைக்கான கட்டணங்கள்

`createOffer` கடனளிப்பவரிடம் எதையும் வசூலிப்பதில்லை. காட்டப்படும் கட்டணம் கடன் வாங்குபவருடையது: கடன் சொத்தில் தொகையின் `getLoanInitiationFeeBps`, `acceptOffer` இயங்கும்போது நடைமுறையில் உள்ள விகிதத்தில், அப்போது கடன் வாங்குபவரின் வைத்திருப்பு நிலைத் தள்ளுபடியால் குறைக்கப்பட்டு, அவருக்கு வழங்கப்படுவதிலிருந்து கழிக்கப்படுகிறது; காட்டப்படும் எண் இன்றைய விகிதத்தைப் பயன்படுத்துகிறது. வட்டியில் நெறிமுறையின் பங்கு `getTreasuryFeeBps`, ஒவ்வொரு கடனும் தொடங்கும்போது நிர்ணயிக்கப்படுகிறது (`treasuryFeeBpsAtInit`); ஒப்புதல் இயக்கத்தில் இருந்தால், வட்டி தீர்க்கப்படும்போது கடனளிப்பவரின் வைத்திருப்பு நிலைத் தள்ளுபடி அதைக் குறைக்கிறது. மதிப்பாய்வு இன்றைய விகிதத்தையும் அந்த விகிதத்தில் பங்கையும் மேல் வரம்பாகக் காட்டுகிறது; `getTreasuryFeeBps` படிப்பது தோல்வியுற்றால் அது சொல்லப்படுகிறது, பங்கோ திரும்பும் தொகையோ காட்டப்படுவதில்லை.

<a id="positions"></a>

### Positions: பட்டியல் எப்படிப் படிக்கப்படுகிறது

Positions ஒரே பகிர்ந்த வாசிப்பான் மூலம் Home படிக்கும் அதே இருப்பைப் படிக்கிறது: `getUserPositionLoansPaginated` வாலட் வைத்திருக்கும் நிலை NFT-களைக் கடந்து செல்கிறது, `getLoansBatch` அவற்றை ஏற்றுகிறது, ஒவ்வொரு பக்கமும் வைத்திருக்கும் டோக்கனிலிருந்து (`lenderTokenId` அல்லது `borrowerTokenId`) வருகிறது, கடன் தொடங்கியபோது பதிவான தரப்பிலிருந்து ஒருபோதும் அல்ல. Active அல்லது FallbackPending நிலையிலுள்ள கடன்கள் நடப்பில் உள்ளவை; அவற்றின் கெடுக்கள், ஆரோக்கியக் காரணி, குழுவாக்கம் Home-இல் விவரித்தபடி. மற்ற ஒவ்வொரு நிலையும் முடிந்ததாகும், புதிய கடன் id முதலில், `LoanStatus` பெயரில்: Repaid, Defaulted, Settled, அல்லது InternalMatched (பொருத்தத்தால் மூடப்பட்டது); செயலிக்குத் தெரியாத நிலை எண் எண்ணாகவே காட்டப்படும். கொடுப்பனவுகள் Home-இல் விவரித்த claimables விதியைப் பின்பற்றுகின்றன: வேறொருவரிடமிருந்து பெற்ற, முடிந்த கடனின் நிலை எண்ணப்படுகிறது, ஊகிக்கப்படுவதில்லை.

பக்கத் தேர்வு கொடுப்பனவுகள், நடப்பு, முடிந்த வரிசைகளை வைத்திருக்கும் பக்கத்தால் வடிகட்டுகிறது. நிலைகளின் கடப்பும் கொடுப்பனவுகளின் கடப்பும் முழுமையாக முடிந்து, சமீபத்திய வாசிப்பு வெற்றிபெற்றால் மட்டுமே "எதுவுமில்லை" என்று சொல்லப்படும்; வரம்பில் நின்ற கடப்பு முழுமையற்றது என்று சொல்லப்படும். ஒரு வரிசை `/positions/<id>`-ஐத் திறக்கும்; அங்கே தகுதித் தீர்ப்பு ஒவ்வொரு செயலையும் முடிவு செய்யும்; பட்டியல் எந்தப் பரிவர்த்தனையையும் அனுப்பாது.

<a id="position"></a>

### Position: ஒரு கடன் எப்படிப் படிக்கப்படுகிறது

பக்கம் `getLoanDetails(loanId)`-ஐயும், கடன் கொடுத்தவர் மற்றும் வாங்கியவர் நிலை NFT-களின் வைத்திருப்பவரையும் படிக்கிறது (deployment பதிவுசெய்யும் PositionNFT ஒப்பந்தத்தில் `ownerOf`, அல்லது #3205-க்கு முந்தைய deployment-இல் Diamond-இலேயே); பங்கு என்பது வாலட் இப்போது வைத்திருக்கும் டோக்கன். நடப்புக் கடனுக்கு (Active அல்லது FallbackPending) `getLoanDeadlines` (நிறுத்தக் கடனுக்கு முந்தைய தற்போதைய காலக் கெடு, நீட்டிப்போ கடன்பெறுநர் மாற்றமோ இதை மாற்றும், நிறுத்தக் கடன், கெடு, சலுகை முடிவு), அட்டவணை இருந்தால் `getPeriodicInterestEnabled` உடன் `previewPeriodicSettle`, `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`), `calculateHealthFactor`, `calculateLTV` ஆகியவற்றைப் படிக்கிறது; ஒவ்வொரு கடனுக்கும் `getLoanCollateralLien`, `isSaleVehicleLoan`. ஒவ்வொரு வாசிப்பும் தனித்தது: தோல்வியுற்றது தெரியாதது என்று காட்டப்படும், பூஜ்யமாக ஒருபோதும் அல்ல; எந்தத் தேதியும் `startTime`, `durationDays`-இலிருந்து கணக்கிடப்படாது.

விலை உள்ள கடனுக்கு அது `getInternalMatchConfigBundle`-ஐயும் படிக்கும். உள் பொருத்தம் இயக்கத்தில் இருக்கும்போது, கடன்-மதிப்பு விகிதம் அதன் வரம்பிலிருந்து வரம்பு + `externalLiquidationPriorityWindowBps` வரை உள்ள கடன் உள் பொருத்தத்துக்காக ஒதுக்கப்படும்; வெளி கலைப்பு வழிகள் அனைத்தும் மறுக்கும் (`InternalMatchOnlyBand`); பக்கம் அந்த வரம்பைச் சொல்லும். 0 ஆன `loanInitiationFeeBpsAtInit` (விகிதம் பதியப்படும் முன் தொடங்கிய கடன்) பதியப்படவில்லை என்றும், 0 ஆன `treasuryFeeBpsAtInit` தீர்வு பயன்படுத்தும் பழைய 1% விகிதம் என்றும் காட்டப்படும். பொருளாகக் கொடுக்கும் எச்சரிக்கை ERC-20 கடனுக்கு மட்டுமே: NFT வாடகைக்குப் பிணையம் இல்லை; அது தவறினால் வாடகைதாரரின் பயன்பாடு முடியும், முன்செலுத்திய வாடகை கருவூலப் பங்கு போக கடன் கொடுத்தவருக்குச் செல்லும், இடையகத் தொகை கருவூலத்துக்குச் செல்லும்; பக்கம் அதற்குப் பதில் இதைச் சொல்லும்.

விகிதங்கள் கடனின் நிலைப்படங்கள்: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (விற்பனை வாகனத்தில் இல்லை), `liquidationLtvBpsAtInit`. ஒரு பக்கம் Illiquid ஆக உள்ள கடனுக்கு (`principalLiquidity` அல்லது `collateralLiquidity`) விலை சார்ந்த அளவீடு இல்லை: நெறிமுறை அதற்கு `calculateHealthFactor`, `calculateLTV` இரண்டையும் மறுக்கிறது; பக்கம் தெரியாதது என்பதற்குப் பதிலாக அதைச் சொல்லும். `principal` என்பது இன்னும் செலுத்த வேண்டிய அசல் (பகுதித் திருப்பிச் செலுத்தல் அதைக் குறைக்கும்); `interestRateBps`, `collateralAmount` ஆகியவையும் மாறலாம், எனவே நிபந்தனைகள் இப்போதைய நிலையில் காட்டப்படும்; பதிவில் அசல் இல்லாத முடிந்த கடன், உள் பொருத்தம் அதை ஈடுசெய்ததா என்பதைச் சொல்லும், இல்லையெனில் எதுவும் பதிவாகவில்லை என்பதை மட்டும் சொல்லும்; NFT வாடகை அதன் நாள் வாடகையையும் (`principal`, `prepayAsset` இல்) முன்கூட்டியே திருப்பினாலும் மீதமுள்ள ஒவ்வொரு நாளுக்கும் கட்டணம் உண்டா என்பதையும் (`useFullTermInterest`) காட்டும். `getPeriodicInterestEnabled` false ஆக இருந்தால், சோதனைப் புள்ளியில் பிணையம் விற்கப்படாது என்று பக்கம் சொல்லும். நடப்புக் கடனில் `collateralLiquidity` Illiquid ஆக இருந்தால் பொருள் வடிவ எச்சரிக்கை சேரும்: தவறல் விற்பனையின்றி பிணையத்தைக் கடன் கொடுத்தவருக்கு மாற்றும். அதன் முதல் பரிவர்த்தனை முழுத் திருப்பிச் செலுத்துதல், கீழே காண்க.

<a id="repay"></a>

### முழுமையாகத் திருப்பிச் செலுத்துதல்: தொகை எப்படி நிர்ணயிக்கப்படுகிறது

செயல் ஒரே விதியைப் பின்பற்றுகிறது: Active அல்லது FallbackPending ERC-20 கடனுக்கு, `loan.lender` அல்லாத, `ownerOf(lenderTokenId)` அல்லாத எந்த வாலட்டுக்கும் `repayLoan` வழங்கப்படும் (`LenderCannotRepayOwnLoan`); Active கடனில் பயனுள்ள சலுகைக் கால முடிவுக்குப் பிறகு நிறுத்தப்படும் (`RepaymentPastGracePeriod`), வாங்கியவர் நிலையின் திறந்த வழி `SwapToRepayIntent` ஆக இருக்கும்போதும் நிறுத்தப்படும் (Diamond-இல் `positionRoute(borrowerTokenId)`, அல்லது #3205-க்கு முந்தைய deployment-இல் `positionLock(borrowerTokenId)`). கடன் கொடுத்தவரின் விற்பனைப் பட்டியல், மறுநிதியளிப்புக் கோரிக்கை, உலகளாவிய இடைநிறுத்தம் ஆகியவை அதை நிறுத்தாது. வாடகைகள் இங்கே இன்னும் வழங்கப்படவில்லை.

மதிப்பாய்வு `calculateRepaymentAmount(loanId)`-ஐ சமீபத்திய பிளாக்கில் படிக்கிறது, பிறகு பிளாக் நேரத்தை `min(now + 30 நிமிடங்கள், சலுகைக் கால முடிவு)` என மாற்றி மீண்டும் படிக்கிறது; அதே கோரிக்கை தான் இயங்கிய பிளாக் நேரத்தையும் படிக்கிறது, மாற்றத்தைப் புறக்கணித்த இணைப்பு தவிர்க்கப்படும். அங்கீகாரம் சரியாக இரண்டாவது எண்; வாலட் திறக்கும் முன் அழைப்பு உருவகப்படுத்தப்படுகிறது; ரசீதுக்குப் பிறகு திருப்பிச் செலுத்துதல் கடனை விட்ட நிலை அதன் `LoanRepaid` பதிவிலிருந்து படிக்கப்படுகிறது (பிளாக்கில் அல்ல; அங்கே பிந்தைய கோரல் ஏற்கனவே அதைத் தீர்த்திருக்கலாம்), செலுத்துதல் `Transfer` பதிவுகளிலிருந்து அளக்கப்படுகிறது, allowance அங்கீகாரம் கழித்தல் செலுத்துதலைக் காட்டினால் அது முந்தைய மதிப்புக்குத் திருப்பப்படுகிறது. அந்த எண்ணைவிட அதிகமான allowance, வரம்பற்றது உட்பட, அதுவரை குறைக்கப்படும்; `repayLoan(loanId)` எந்த உச்சவரம்பையோ காலக்கெடுவையோ எடுப்பதில்லை; பின்னர் மீட்டமைப்பு பெரிய மதிப்பைத் திருப்பித் தருகிறது.

<a id="interest-schedule"></a>

### வட்டி அட்டவணை: எப்படிப் படிக்கப்படுகிறது

சுழற்சி உள்ள Active ERC-20 கடனுக்கு, அட்டை `previewPeriodicSettle(loanId)` (சுழற்சி, `periodEndAt`, `graceEndsAt`, `expected`, `paidByBorrower`, `shortfall`, `canSettleNow`), `getPeriodicInterestEnabled()`, `paused()` ஆகியவற்றைப் படித்து, படித்த பிளாக் நேரத்தைச் சொல்லும். `expected` என்பது இப்போதைய `principal`, `interestRateBps` இல் ஒரு முழுக் காலம்; `periodEndAt` இல் கடனின் நிறுத்தக் கடன் சேர்ந்துள்ளது.

முன்னோட்டத்தின் `canSettleNow` சுவிட்சையும் நிறுத்தத்தையும் கணக்கில் எடுக்காது, எனவே அட்டை அவற்றை `settlePeriodicInterest` இன் சொந்த வரிசையில் இணைக்கிறது: அணைப்பு (`PeriodicInterestDisabled`), நிறுத்தம் (`whenNotPaused`), பிறகு காலத்தின் நேரம் (`graceEndsAt` க்கு முன் `PeriodicSettleNotDue`). சுவிட்ச் இயங்கி நெறிமுறை நிறுத்தப்படாதபோது மட்டுமே விற்பனை அறிவிக்கப்படும்; படிக்க முடியாத சுவிட்சோ நிறுத்தமோ தெரியாதது என்று சொல்லப்படும். குறைவு பூஜ்யமாக இருந்தால், தீர்வு சோதனைப் புள்ளியை மட்டும் முன்னகர்த்தும். கீப்பரின் `PERIODIC_SETTLE` இயக்கம் செயலிக்குத் தெரிவிக்கப்படுவதில்லை, எனவே தீர்ப்பது யாருக்கும் திறந்திருக்கிறது என்றும் கீப்பரின் நிலை தெரியாது என்றும் அட்டை சொல்லும்.

<a id="partial-repay"></a>

### கடனின் ஒரு பகுதியைச் செலுத்துதல்: தொகை எப்படிக் கணக்கிடப்படுகிறது

`repayPartial(loanId, amount)` அசலில் `amount` மற்றும் `interestAccrualStart` முதல் சேர்ந்த வட்டியை (எந்தக் காலமுறை வரவும் கழித்து) எடுக்கிறது. இது வட்டியை முதலில் விற்பனைக்கு முந்தைய வட்டி இன்னும் நிலுவையில் உள்ள முந்தைய வைத்திருப்பவர்களுக்குச் செலுத்துகிறது (`paySellersFirst`), பின்னர் தற்போதைய கடன் கொடுப்பவர் நிலை வைத்திருப்பவருக்கு, கருவூலப் பங்கைப் பிரித்து (நெறிமுறை முடக்க வேண்டிய வைத்திருப்பவர் என்றால், அவரது பங்கு அதற்குப் பதிலாகக் கடன் கொடுப்பவரின் வால்ட்டில் பூட்டி வைக்கப்படும், `freezeOrPayActiveLenderFromPayer`); `principal` ஐக் குறைக்கிறது, வட்டிக் கடிகாரத்தை மீண்டும் தொடங்குகிறது, நடப்புக் காலத்திற்கு வரவு வைக்கிறது; முதிர்வுத் தேதி ஒருபோதும் நகராது. சலுகைக் காலம் முடிந்த பின், `principal × minPartialBps / 10000` (`getAssetRiskParams`) க்குக் கீழ், முழு அசல் அல்லது அதற்கு மேல் (`PartialWouldRetireFullPrincipal`), செயலில் உள்ள இன்டென்ட் கமிட் அல்லது மறுநிதியளிப்புக் கோரிக்கை இருக்கும்போது, திரவக் கடனில் ஆரோக்கியக் காரணி மோசமடையும்போது இது மறுக்கிறது.

அழைப்புக்கு முன் பகுதிச் செலுத்தலின் வட்டியை எந்த view-வும் தருவதில்லை (#3299), எனவே மதிப்பாய்வு இப்போதும் சற்றுப் பின்னரும் படித்த `calculateRepaymentAmount` கழித்தல் `principal` ஐப் பயன்படுத்துகிறது. முதிர்வு வரை விகிதாசாரக் கடனுக்கு இது துல்லியம்; `useFullTermInterest` உடன் மீதக் காலக் குறைந்தபட்ச வட்டியையும், முதிர்வுக்குப் பின் தாமதக் கட்டணத்தையும் சேர்ப்பதால் "அதிகபட்சம்" எனக் காட்டப்படுகிறது. ஒப்புதல் சரியாகப் பகுதியும் அந்த மேல் எண்ணிக்கையும் ஆகும். முடிவு அட்டை செலுத்துதலின் சொந்த `PartialRepaid` பதிவிலுள்ள `newPrincipal` (தொகுதியில் `principal` அல்ல; அங்கே பிந்தைய பரிவர்த்தனை அதை மாற்றலாம்), வாலட்டிலிருந்து வெளியேறியது, பின்னர் `previewPeriodicSettle` ஆகியவற்றை அளக்கிறது. பகுதித் தொகை, அல்லது பகுதித் தொகையும் துல்லியமான வட்டியும் வாலட்டில் குறைவாக இருக்கும்போது மட்டுமே மதிப்பாய்வு அதை மறுக்கிறது; மேல் வரம்பு எண் மட்டும் இருப்பை மிஞ்சினால், கட்டணம் அனுப்பப்படுவதற்குச் சற்று முன் செய்யப்படும் சோதனை ஓட்டம் முடிவு செய்கிறது.

<a id="add-collateral"></a>

### பிணையம் சேர்த்தல்: எவை சரிபார்க்கப்படுகின்றன

`addCollateral(loanId, amount)` கடனின் சொந்தப் பிணைய டோக்கனில் சரியாக `amount`-ஐ அழைப்பவரிடமிருந்து கடன் வாங்குபவரின் வால்ட்டுக்கு எடுக்கிறது, `collateralAmount`-ஐயும் பிணைய உரிமையையும் உயர்த்துகிறது, புதிய ஆரோக்கியக் காரணி மற்றும் LTV உடன் `CollateralAdded`-ஐ வெளியிடுகிறது. நடப்பிலுள்ள swap-to-repay உறுதிப்பாடு, `ownerOf(borrowerTokenId)` அல்லாத அழைப்பவர், Active-ஓ FallbackPending-ஓ இல்லாத கடன், வாடகை, இடைநிறுத்தப்பட்ட பிணையச் சொத்து (`isAssetPaused`), `checkLiquidity` Liquid எனக் காட்டாத பிணையம் ஆகியவற்றை இது மறுக்கிறது. இதில் `whenNotPaused` இல்லை. வைப்பு பதிவான `loan.borrower` இன் வால்ட்டுக்குச் செல்கிறது: Active கடன் முதலில் மாற்றப்பட்ட நிலையை வைத்திருப்பவருக்கு ஒருங்கிணைக்கிறது (`consolidateToHolder`), எனவே அது வைத்திருப்பவரின் வால்ட்; FallbackPending கடன் சரியாகும் வரை ஒருங்கிணைக்கப்படாது, எனவே மதிப்பாய்வு பதிவான வால்ட்டைக் குறிப்பிடுகிறது. சேர்த்த டோக்கன்கள் `collateralAmount` இல் கணக்கிடப்படுகின்றன, அதைக் கலைப்பும் தவறுதலும் பயன்படுத்துகின்றன, மதிப்பாய்வு அதைச் சொல்கிறது.

ஆப் இந்த உள்ளீடுகளைப் படிக்கிறது; இரண்டு சொத்துச் சரிபார்ப்புகளும் கடனின் தொடக்க வகுப்பிலிருந்து அல்ல, நேரடியாக; உலர் ஓட்டமே நெறிமுறையின் இறுதி முடிவு. சேர்ப்புக்குப் பிந்தைய ஆரோக்கியக் காரணியை எந்தக் காட்சியும் தருவதில்லை; எனவே மதிப்பாய்வு இப்போதைய `calculateHealthFactor`, `calculateLTV` ஆகியவற்றைக் காட்டுகிறது, முடிவு அட்டை புதிய எண்களைப் பரிவர்த்தனையின் `CollateralAdded` பதிவிலிருந்து படிக்கிறது. FallbackPending கடனில், புதிய ஆரோக்கியக் காரணி கடனின் குறைந்தபட்சத்தை அடைந்து LTV அதன் தொடக்க வரம்புக்குள் இருந்தால் சேர்ப்பு அதைச் சரிசெய்கிறது; முடிவு அட்டை `LoanCuredFromFallback`-ஐச் சரிபார்க்கிறது. தொகைக்குச் சமமான அல்லது அதிகமான தற்போதைய ஒப்புதல் அப்படியே விடப்படுகிறது, ஏனெனில் சரியாக அந்தத் தொகையே எடுக்கப்படுகிறது; சிறியது சரியாக அந்தத் தொகைக்கு உயர்த்தப்பட்டு, சேர்ப்பு நடக்காவிட்டால் திருப்பி வைக்கப்படுகிறது.

<a id="take-back-collateral"></a>

### பிணையத்தைத் திரும்பப் பெறுதல்: என்ன சரிபார்க்கப்படுகிறது

`partialWithdrawCollateral(loanId, amount)` கடன் வாங்குபவரின் வால்ட்டிலிருந்து அழைப்பவரின் வாலட்டுக்குப் பிணையத்தில் `amount` அனுப்பி, `collateralAmount` மற்றும் பிணைய உரிமையைக் குறைத்து, புதிய ஆரோக்கியக் காரணி மற்றும் LTV உடன் `PartialCollateralWithdrawn` வெளியிடுகிறது. இதில் `whenNotPaused` உள்ளது; இது வரிசையாக மறுக்கிறது: தடைசெய்யப்பட்ட அழைப்பவர், நடப்பு ஸ்வாப்-டு-ரிபே கமிட், நடப்பு மறுநிதியளிப்புக் கோரிக்கை (`RefinanceRequestOpen`), இணைந்த விற்பனைப் பட்டியல் (`SaleListingActive`), `ownerOf(borrowerTokenId)` அல்லாத அழைப்பவர், Active இல்லாத கடன், பிணையத்தைவிட அதிகமான தொகை, `checkLiquidity` Liquid எனக் காட்டாத பிணையம், குறைந்தபட்ச ஆரோக்கியக் காரணிக்குக் கீழோ தொடக்க LTV வரம்புக்கு மேலோ செல்லும் முடிவு.

படிவம் தொகையை `calculateMaxWithdrawable` உடன் சரிபார்க்கிறது; Active இல்லாத கடனுக்கோ திரவமற்ற பிணையத்துக்கோ இது பூஜ்யம், வட்டி சேரச் சேரக் குறையும். இணைந்த விற்பனைப் பட்டியலை எந்தக் காட்சியும் காட்டாததால், மதிப்பாய்வு திரும்பப் பெறுதலை ஒத்திகையாக இயக்கி அந்த மறுப்பைக் குறிப்பிடுகிறது; அனுப்பும்போது மீண்டும் இயக்குகிறது. நிறைவு அட்டை மீதமுள்ள பிணையத்தையும் புதிய எண்களையும் பரிவர்த்தனையின் `PartialCollateralWithdrawn` பதிவிலிருந்தும், பெற்ற தொகையை வாலட்டுக்கான டோக்கனின் `Transfer` இலிருந்தும் படிக்கிறது. பாதுகாக்கப்பட்ட கணக்கு முறையில் உள்ள அழைப்பாளருக்கு, வால்ட்டின் செலுத்தல் வாயில் திரும்பப்பெறுதலைச் செலுத்தாமல் கணக்கின் தாமதக் காலம் வரை வரிசையில் வைக்கிறது (`PayoutQueued`), எனவே மதிப்பாய்வு `getProtectedAccount` ஐப் படிக்கிறது, நிறைவு அட்டை அந்தப் பதிவைப் படிக்கிறது.

<a id="collect-a-payout"></a>

### கொடுப்பனவைப் பெறுதல்: என்ன சரிபார்க்கப்படுகிறது

`claimAsLender(loanId)` மற்றும் `claimAsBorrower(loanId)` இரண்டிலும் `whenNotPaused` உள்ளது; அவை அந்தத் தரப்புக்குப் பதிவான தரப்பினரின் (`loan.lender` / `loan.borrower`) பெட்டகத்திலிருந்து அழைப்பவருக்குச் செலுத்துகின்றன; அழைப்பவர் அந்தத் தரப்பின் நிலை டோக்கனின் `ownerOf` ஆக இருக்க வேண்டும். கடன் கொடுப்பவர் Repaid, Defaulted, FallbackPending அல்லது InternalMatched கடனில் கோரலாம்; கடன் வாங்குபவர் Repaid, Defaulted அல்லது InternalMatched இல் மட்டும். கடன் கொடுப்பவரின் கோரிக்கை, ஏற்கெனவே கோரப்பட்ட வரியை (`AlreadyClaimed`) வைத்திருப்பவர் சரிபார்ப்புக்கு முன்பும், திறந்தது எதுவும் இல்லாத தரப்பை (`NothingToClaim`) அதற்குப் பின்பும் மறுக்கிறது; கட்டாய முடிப்பு பூஜ்ஜியத்தில் பதிவு செய்த வரியும் இயங்கி நிலையை மூடுகிறது. கடன் வாங்குபவரின் கோரிக்கை, பிணைய வரியும் உபரி வரியும் இரண்டும் காலியாகவோ கோரப்பட்டோ இருந்தால் மட்டுமே மறுக்கிறது; ஒவ்வொன்றையும் அதன் சொந்தக் கொடியின்படி செலுத்துகிறது; வேறு டோக்கனில் கடனின் உரிமையின் கீழ் இன்னும் உள்ள பிணையமும் உடன் செலுத்தப்படுகிறது.

மதிப்பாய்வு `getClaimable` (கடன் கொடுப்பவர் வரி முந்தைய விற்பனையாளர்களைக் கழித்த பின்; அருகில் `getSellersShareOfLenderClaim`), `getBorrowerSurplusClaim`, `getLoanCollateralLien` ஆகியவற்றைப் படித்து, கோரிக்கையை முன்னோட்டமாக இயக்குகிறது; அது தடைச் சரிபார்ப்புகளையும் பயன்படுத்துகிறது. பட்டியல் நிலை டோக்கனைப் பின்தொடர்கிறது: `getUserDashboardClaimables` பதிவான தரப்பினரின் கோரிக்கைகளைப் பட்டியலிடுகிறது; எனவே பட்டியலிட்ட வரி வாலெட் அந்தத் தரப்பை வைத்திருக்கும் வரை மட்டுமே இருக்கும்; வேறொருவரிடமிருந்து பெற்ற முடிந்த கடனின் நிலைக்குக் கோரிக்கை நேரடியாகப் படிக்கப்படுகிறது. இறுதி அட்டை `LenderFundsClaimed` / `BorrowerFundsClaimed`, `BorrowerSurplusClaimed`, `LoanSettled` மற்றும் வாலெட்டுக்கான டோக்கன் பரிமாற்றங்களைப் படிக்கிறது; பாதுகாக்கப்பட்ட கணக்கு முறையில் உள்ள அழைப்பவருக்கு `PayoutQueued` (கணக்கின் சொந்தப் பெட்டகம்), `PayoutHeldInVault` (பூட்டப்பட்ட கணக்கு அல்லது நிரம்பிய வரிசை) அல்லது `PaymentCreditedToVault` (வேறு தரப்பினரின் பெட்டகம்) ஆகியவற்றைப் படிக்கிறது. FallbackPending கடனில், கடன் கொடுப்பவரின் கோரிக்கை கோரும் நேரத்தில் உள் பொருத்தத்தை இயக்கி வரியை மாற்றி எழுதலாம்; எனவே இறுதி அட்டை பரிமாற்றங்களை நெறிமுறையின் சொந்தப் பதிவுடன் ஒப்பிடுகிறது.

<a id="claim-everything"></a>

### அனைத்தையும் பெறுக: என்ன சரிபார்க்கப்படுகிறது

தொகுப்பு `multicall(calls)` வழியாகச் செல்கிறது; அது ஒவ்வொரு அழைப்பையும் நெறிமுறைக்குள்ளேயே `delegatecall` மூலம் இயக்குவதால் `msg.sender` உங்கள் வாலெட்டாகவே இருக்கிறது, ஒவ்வொரு அழைப்பும் தன் சொந்த விதிகளைச் சரிபார்க்கிறது. இது அதிகபட்சம் 30 அழைப்புகளை ஏற்கிறது; செயலி ஒவ்வொன்றையும் `allowFailure` உடன் அனுப்புவதால், மறுக்கப்பட்ட அழைப்பு மட்டும் திரும்பும், தொகுப்பு தொடரும். அழைப்புகள்: `claimAsLender` / `claimAsBorrower(loanId)`; நிறுத்திவைக்கப்பட்ட வெகுமதியையும் விடுவிக்கும் `claimInteractionRewardsTo(Vault)`, அல்லது வெகுமதி முன்னோட்டம் முடிய முடியாமல் `getRewardSanctionsStatus` Deliver எனப் படிக்கும்போது `claimHeldInteractionRewards(Vault)`; `getLenderIntentsByOwner` இலிருந்து ஒவ்வொரு நோக்கத்தின் `availableCapital` க்கும் `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)`; VPFI இன் `freeHolding` க்கு `withdrawVPFIFromVault(amount)`; வாலெட்டே பயனாளியாக உள்ள `getPayrollStream` இன் ஒவ்வொரு ஓட்டத்துக்கும் `getWithdrawableSalary` அளவில் `withdrawSalary(streamId)`. FallbackPending கடனின் மீதான கடன் கொடுப்பவர் கோரல் விலக்கப்படுகிறது, ஏனெனில் கோரும் நேரப் பொருத்தமே அது செலுத்துவதைத் தீர்மானிக்கிறது. மதிப்பாய்வு தொகுப்பைச் சோதனை ஓட்டமாக இயக்கி ஒவ்வொரு அழைப்பின் `success` மற்றும் திரும்பல் தரவைப் படிக்கிறது, மறுக்கப்பட்ட அழைப்பை அதன் குறிவிலக்கப்பட்ட பிழையுடன் விலக்குகிறது, அனுப்பும்போது மீண்டும் இயக்குகிறது. முடிவு அட்டை ஒவ்வொரு அழைப்பின் சொந்த நிகழ்வை (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`) படிக்கிறது; நிகழ்வு இல்லாத அழைப்பு தவிர்க்கப்பட்டது. வாலெட்டுக்கான டோக்கன் பரிமாற்றங்களும், பாதுகாக்கப்பட்ட பயன்முறைக்கான `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault` உம், பெறப்பட்ட அழைப்புகள் முழுவதும் டோக்கன் வாரியாகக் கூட்டப்படுகின்றன. இடைநிறுத்தமும் (ஒவ்வொரு அழைப்பிலும் `whenNotPaused`) குறிக்கப்பட்ட வாலெட்டும் கையொப்பத்துக்கு முன் தொகுப்பை நிறுத்துகின்றன.

<a id="payout-queue"></a>

### கொடுப்பனவு வரிசை: என்ன சரிபார்க்கப்படுகிறது

பட்டியல் `getPendingPayoutIds(account)`, ஒவ்வொரு வரிக்கும் `getPendingPayout(id)` மற்றும் `requestCode(id)` உடன்; எச்சரிக்கைகள் பயன்படுத்தும் அதே பகிரப்பட்ட காட்சியாக்கியால் குறியீடு ஆறு base32 எழுத்துகளாகக் காட்டப்படுகிறது, வரிகள் உலாவியின் கடிகாரத்தின்படி அல்லாமல் சமீபத்திய தொகுதியின் நேர முத்திரைக்கு எதிராக `releaseAt` வரிசையில் அமைகின்றன. `releasePayout(id)` யாரும் அழைக்கலாம், இடைநிறுத்தத்தின்போது `isEscapeOpen()` ஆகும் வரை மறுக்கப்படும். பெறுநர் மேலாளரும் அல்லாத (கணக்கு, அல்லது ஓய்வுக்குப் பின் அதன் கட்டுப்பாட்டாளர்) `getAllowlist`-இலும் இல்லாத வரிசை வரி, நேரச் சரிபார்ப்புக்கு முன்பே, செலுத்தப்படுவதற்குப் பதிலாக ரத்து செய்யப்படும்; இல்லையெனில் வரி உரிய நேரத்தை அடைந்திருக்க வேண்டும், கணக்கு பூட்டப்படாமல் இருக்க வேண்டும் (`ProtectedVaultLocked`), `requireCosign` இயக்கத்தில் இருக்கும் வரை இணைக் கையொப்பம் பெற்றிருக்க வேண்டும் (`CosignRequired`), பெறுநர் மீண்டும் சரிபார்க்கப்படுவார். `cancelPayout(id)` மேலாளர் அல்லது ஒரு கையொப்பமிடுபவருக்கு உரியது (`NotManagerOrSigner`), இடைநிறுத்தத்தின்போதும் வேலை செய்யும், சொத்தை மீண்டும் எடுக்கும் வகையில் வைப்புப் பேரேட்டில் வரவு வைக்கும். `cosignPayout(id)` `getProtectedSigners`-இல் உள்ள ஒரு கையொப்பமிடுபவருக்கு உரியது (`NotSigner`); கணக்குக்கு அது தேவைப்படும்போதும் வரி இன்னும் இணைக் கையொப்பம் பெறாதபோதும் மட்டுமே பயன்பாடு அதை வழங்குகிறது. ஒவ்வொரு செயலும் மதிப்பாய்வில் முன்சோதனையாகவும், அனுப்பும்போது மீண்டும் இயங்கும். நிறைவு அட்டை அந்த id-க்கான `PayoutReleased` (தொகை மற்றும் நெறிமுறை அளந்த `delivered`), `PayoutCancelled`, `PayoutCosigned` ஆகியவற்றைப் படிக்கிறது. keeper-இன் `protectedAccount` சுற்று உரிய வரிகளை விடுவிக்கிறதா என்பது திறன் சேவையின் பதில், இயல்பாக அறியப்படாதது. பூட்டு வரிசையின் ஒவ்வொரு வரியையும் ரத்து செய்யும்.

<a id="seller-interest"></a>

### நீங்கள் விற்ற நிலையின் வட்டி: என்ன சரிபார்க்கப்படுகிறது

விற்பனை, விற்பனையாளர் ஈட்டி இன்னும் பெறாத வட்டியை ஒரு உரிமைகோரலாகப் பதிவு செய்கிறது: `getInterestLedger(loanId)` திறந்த உரிமைகோரல்களைப் பழையது முதலில், ஒவ்வொன்றின் மொத்தத் தொகையுடன் பட்டியலிடுகிறது. `claimAsSeller(loanId)` இல் `whenNotPaused` மற்றும் தடைகள் சோதனை உள்ளன. திறந்த உரிமைகோரல்கள் உள்ள Repaid, Defaulted, Settled அல்லது InternalMatched கடனில், அது முதலில் கடன் வழங்குநர் மீட்டதைப் பிரிக்கிறது (`getSellersShareOfLenderClaim`), ஒவ்வொரு உரிமைகோரலுக்கும் அதன் நிகரத் தொகை வரை செலுத்துகிறது (மொத்தத்திலிருந்து கடனின் `treasuryFeeBpsAtInit` பங்கைக் கழித்து, கீழ்நோக்கி முழுமையாக்கி; கடன் எதையும் பதிவு செய்யாத இடத்தில் பழைய 1%) அனைத்தையும் மூடுகிறது; FallbackPending கடன் பிரிக்கப்படுவதில்லை. பின் அசல் டோக்கனுக்கும், வேறுபட்டால் கடன் வழங்குநர் உரிமைகோரல் டோக்கனுக்கும், `getSellerInterestHeld(loanId, seller, asset)` ஐ விற்பனையாளரின் சொந்த வால்ட்டிலிருந்து அவரது வாலட்டுக்கு எடுக்கிறது; அது பூஜ்ஜியமானால் `NothingToClaimAsSeller` என மறுக்கிறது. வாலட்டை விற்பனையாளராகப் பதிவுசெய்த குறியீட்டுச் செயல்பாடுகளிலிருந்து (`SellerInterestClaimRecorded`, `SellerInterestPaid`, `SellerInterestClaimClosed`, `SellerInterestWithdrawn`) ஆப் கடன்களைப் பட்டியலிடுகிறது; எண் மூலம் தேடுவது சங்கிலியை மட்டுமே படிக்கிறது. அசல் டோக்கனில், மதிப்பாய்வு பங்கிலிருந்து வாலட்டின் பகுதியைத் துல்லியமாகக் கணக்கிடுகிறது; வேறு டோக்கனில் பிரிப்பு மதிப்பின்படி, இயங்கும்போது முடிவாகும் எனக் கூறப்படுகிறது. எடுப்பு மதிப்பாய்வில் சோதனை ஓட்டமாகவும் அனுப்பும்போது மீண்டும் இயங்குகிறது. இறுதி அட்டை `SellerInterestClaimClosed` (செலுத்தியது, வரவு வைத்தது, முழுமையாகச் செலுத்தியது) மற்றும் `SellerInterestWithdrawn` ஐப் படிக்கிறது; பாதுகாப்பு முறை செலுத்தலை வரிசையில் வைத்த அல்லது வைத்திருந்த இடத்தில் `PayoutQueued` அல்லது `PayoutHeldInVault` ஐயும் படிக்கிறது.

<a id="frozen-proceeds"></a>

### உறைந்த கொடுப்பனவுகள்: என்ன சரிபார்க்கப்படுகிறது

ஆப் `getSanctionsOracle` (பூஜ்யம் என்றால் இந்தச் சங்கிலியில் சோதனை இல்லை), `sanctionsStatus(wallet)` (Clean, Flagged, அல்லது சோதனை revert ஆகும்போது Unavailable), மற்றும் `isSanctionsConfirmedFlagged(wallet)` ஆகியவற்றைப் படிக்கிறது; கடைசியது, `refreshSanctionsFlag` ஒரு உறுதியான வாசிப்பிலிருந்து ஒத்திசைக்கும் பதிவேடு. Flagged, அல்லது வாலெட் பதிவுசெய்யப்பட்ட நிலையில் Unavailable, உறைந்ததாகப் படிக்கப்படும்; பதிவில்லாத Unavailable அப்படிப் படிக்கப்படாது. `claimAsLender`, `claimAsBorrower` இரண்டும் `whenNotPaused`-க்குப் பின் அழைப்பவரைச் சோதித்து, தடங்கலை அனுமதிக்கின்றன; பதிவுசெய்யப்பட்ட ஒரு தரப்புக்காக நெறிமுறை கொடுப்பனவை உறைய வைத்த பக்கம் fail-closed முறையில் விடுவிக்கப்படுகிறது: அப்போது நிலையை யார் வைத்திருந்தாலும், அந்தத் தரப்பு Clean எனப் படிக்கப்படும் வரை `SanctionedAddress` அல்லது `SanctionsOracleUnavailable` உடன் revert ஆகிறது. அந்தப் பதிவுசெய்யப்பட்ட தரப்பைக் காட்டும் view எதையும் நெறிமுறை வைத்திருக்கவில்லை, எனவே அங்கே ஆப் சோதனை ஓட்டத்தைச் சார்ந்து, அதன் மறுப்பை அதே சொற்களில் சொல்கிறது. `claimAsSeller` குறியிடப்பட்ட விற்பனையாளரையும், தடங்கலின்போது பதிவுசெய்யப்பட்டவரையும் மறுக்கிறது. கடன் நடக்கும் வரை, குறியிடப்பட்ட வைத்திருப்பவருக்காக ஒதுக்கப்பட்ட கடன் வழங்குநர் பங்கு `getClaimable(loanId, true)`-இன் `heldForLender`-இல் சேர்கிறது; கடன் வழங்குநரின் உரிமைகோரல் அதைச் செலுத்தும் வரை பதிவில் உள்ள கடன் வழங்குநரின் வால்ட்டில் ஒதுக்கப்பட்டிருக்கும். குறியிடப்பட்ட கடன் வாங்கியவருக்குத் திருப்பிச் செலுத்துதல் திறந்தே இருக்கும்; பிணையம் சேர்ப்பது இல்லை.

<a id="extension-reserves"></a>

### நீட்டிப்பு இருப்புகள்: என்ன சரிபார்க்கப்படுகிறது

`fundExtendReserve(loanId, amount)` கடன் வாங்குநர் நிலையை வைத்திருப்பவரின் வாலெட்டிலிருந்து கடனின் அசல் டோக்கனை அவருடைய சொந்த வால்ட்டில் வைப்பு செய்து அந்தக் கடனுக்காக ஒதுக்குகிறது. இதில் `whenNotPaused` மற்றும் தடைகள் சோதனை உள்ளன; கடன் Active ஆகவும், ERC-20 கடனாகவும், காலமுறை இடைவெளி இல்லாததாகவும் இல்லாவிட்டால் இது மறுக்கப்படும். `getExtendFunding(loanId, holder)` டோக்கன், `reserved`, வைத்திருப்பவரின் மற்ற இலவச இருப்பு, ஒரு நீட்டிப்பு இப்போதும் சாளரத்தின் முடிவிலும் வசூலிப்பது ஆகியவற்றைத் தருகிறது; ஒரு நீட்டிப்பு தற்போதைய வைத்திருப்பவரின் வால்ட்டிலிருந்து மட்டுமே, முதலில் இருப்பிலிருந்து, வசூலிக்கும். `withdrawExtendReserve(account, loanId, amount)` இல் `whenNotPaused` உள்ளது; அழைப்பவர் கணக்கின் மேலாளராக (அதன் சொந்த வாலெட், அல்லது மாற்றீட்டுக்குப் பின் அதன் கட்டுப்பாட்டாளர்) இருக்க வேண்டும் எனக் கோருகிறது, அழைப்பவரைச் சோதிக்கிறது (தடங்கலின்போது திறந்திருக்கும்), ஒதுக்கியதைவிட அதிகமானால் `ExtendReserveInsufficient` உடன் திரும்புகிறது; கடனின் நிலை எதுவாயினும் இது திறந்திருக்கும். வாலெட்டின் பெயரில் பதிவான குறியீட்டின் செயல்பாட்டிலிருந்து (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`) செயலி கடன்களைப் பட்டியலிடுகிறது; எண்ணால் தேடுவது சங்கிலியை மட்டுமே படிக்கிறது. மதிப்பாய்வு படித்த முழு இருப்பையும் அது திரும்பப் பெறுகிறது, அழைப்பை மதிப்பாய்விலும் அனுப்பும்போதும் சோதனை ஓட்டமாக இயக்குகிறது, முடிவு அட்டை `ExtendReserveWithdrawn` (தொகை, ஒதுக்கப்பட்டே இருப்பது) ஐப் படிக்கிறது; பாதுகாக்கப்பட்ட பயன்முறை கொடுப்பனவை வரிசையில் வைத்த அல்லது நிறுத்திவைத்த இடத்தில் `PayoutQueued` அல்லது `PayoutHeldInVault` உடன்.

<a id="vault-holdings"></a>

### உங்கள் பெட்டகம்: எது படிக்கப்படுகிறது

பெட்டகம் `VaultFactoryFacet.getUserVaultAddress(wallet)`; `getOrCreateUserVault(wallet)` அதை உருவாக்குகிறது (நிலை-1 தடைச் சோதனை, இடைநிறுத்தத் தடை இல்லை), இறுதி அட்டை `UserVaultCreated` ஐப் படிக்கிறது. ஒவ்வொரு சொத்துக்கும், ஒரே பிளாக்கில்: பெட்டகத்தின் சொந்த இருப்பு (ERC-20 `balanceOf`, ERC-721 `ownerOf`, ERC-1155 `balanceOf`), `getTrackedHolding`, `withdrawableNow`, `untrackedHolding`. «உங்கள் பெட்டகத்தில்» என்பது இருப்புக்கும் கண்காணிக்கப்பட்ட இருப்புக்கும் இடையே சிறியது; «இப்போது எடுக்கத் தயார்» என்பது திருப்பி அளிக்கப்பட்டபடியே `withdrawableNow` (வைப்பு இருப்பு, `freeHolding` ஆல் வரம்பிடப்பட்டது: கண்காணிக்கப்பட்டது கழித்தல் பிணைப்புகள் கழித்தல் பாதுகாப்பு முறை ஒதுக்கீடு); «உங்கள் நிலைகள் வைத்திருப்பவை» என்பது கணக்கிடப்பட்ட எண் கழித்தல் அது. சொத்துகள் `getDepositoryAssets(wallet, offset, limit)` இலிருந்து வருகின்றன, திருப்பி அளிக்கப்பட்ட மொத்தம் வரை பக்கம் பக்கமாகப் படிக்கப்படுகின்றன (அதற்கு முன் ஒரு வெற்றுப் பக்கம் முழுமையற்றதாகப் படிக்கப்படும்), பட்டியலிலுள்ள ஒவ்வொரு ஒப்பந்தத்தின் தரநிலையும் ERC-165 மூலம் படிக்கப்படுகிறது, மேலும் `getUserLoansPaginated(wallet)`-இலுள்ள ஒவ்வொரு கடனின், வாலெட் நிலையை வைத்திருக்கும் ஒவ்வொரு கடனின் பகுதிகள் (கடனாகத் தந்த சொத்து, பிணையம், வாடகையின் முன்செலுத்திய கட்டண டோக்கன்) ஒரே பிளாக்கில் `getLoanDetails` மூலம் படிக்கப்பட்டு, இதுவரை உருவாக்கிய ஒவ்வொரு சலுகையின் பகுதிகளுடனும் (`getUserOffersPaginated(wallet)`, ஒவ்வொன்றும் `getOffer` மூலம் படிக்கப்படுகிறது) சேர்க்கப்படுகின்றன; ஒரு சலுகையின் வைப்பு, அதன் நிலை NFT மாற்றப்பட்ட பிறகும் உருவாக்கியவரின் வால்ட்டில் இருக்கும். `getLenderIntentsByOwner(wallet)`-இல் உள்ள ஒவ்வொரு நிலையான சலுகையும் கடன் கொடுக்கும் சொத்தும், ரத்து செய்யப்பட்டவை உட்பட, சேர்க்கப்படுகிறது: ஒன்றுக்கு நிதியளிப்பது அந்தச் சொத்தை வைப்புப் பதிவில் இடம்பெறாமல் வால்ட்டில் வைக்கிறது. பதிவு NFT டோக்கன் அடையாளங்களை வைத்திருப்பதில்லை; எனவே வைப்பிலிட்ட ஒவ்வொரு NFT தொகுப்பும் ஒரு குறிப்பில் பெயரிடப்படுகிறது, ஒரு கடனோ சலுகையோ குறிப்பிடும் டோக்கன் மட்டுமே எண்களுடன் பட்டியலிடப்படுகிறது. தூசு என்பது பூஜ்யத்தை விட அதிகமான, ஒரு முழு டோக்கனின் 1e-11 ஐ விடக் குறைவான கணக்கிடப்பட்ட எண்.

<a id="vault-deposit"></a>

### உங்கள் பெட்டகத்தில் வைப்பிடுதல்

வைப்பு என்பது `VaultDepositoryFacet.depositToVault(kind, asset, tokenId, amount)`: kind 0 என்பது ERC-20, 1 ERC-721, 2 ERC-1155; ERC-20-க்கு டோக்கன் அடையாளம் 0, ERC-721-க்குத் தொகை 1. இது `whenNotPaused`, அழைப்பவரைச் சோதிக்கிறது (Tier-1), மாற்றீட்டால் ஓய்வுபெற்ற வாலெட்டை மறுக்கிறது (`requireManager`). மதிப்பாய்வு ஒரே பிளாக்கில் `getUserVaultAddress`, `paused`, தடைச் சோதனை நிலை, `getProtectedAccount(wallet)`, வாலெட்டின் இருப்பு மற்றும் அனுமதியைப் படிக்கிறது; படிக்க முடியாத இடைநிறுத்தம், சோதனை அல்லது ஓய்வு சொல்லப்படுகிறது, சோதனை ஓட்டம் முடிவு செய்கிறது. அனுமதி ERC-20-க்குத் துல்லியமான `approve` (டோக்கனை முதலில் பூஜ்யமாக்க வேண்டியபோது இரண்டு படிகள்), ERC-721-க்கு `approve(diamond, tokenId)`, அல்லது ERC-1155-க்கு `setApprovalForAll(diamond, true)`; முன்பே வழங்கப்படாவிட்டால் வைப்புக்குப் பின் திரும்பப் பெறப்படும். சோதனை ஓட்டம் அனுமதிக்குப் பின் நடக்கிறது; ERC-20 முழு வருகைச் சோதனையுடன் (`LibDelivery.pullExact`) எடுக்கப்படுவதால், பரிமாற்றக் கட்டண டோக்கன் தோல்வியடைகிறது. முடிவு அட்டை `VaultDeposited(account, asset, kind, tokenId, amount)`-ஐயும் பெட்டகத்துக்குள் டோக்கனின் சொந்தப் பரிமாற்றப் பதிவுகளையும் படிக்கிறது. இந்த வைப்புக்கு permit வழி இல்லை. `getProtectedAccount(wallet)`-இலிருந்து மதிப்பாய்வு `enabled`, `locked`, `delaySeconds`, `requireCosign` ஆகியவற்றையும் வைத்திருக்கிறது; வைப்பு மீண்டும் எப்படி வெளியேறலாம் என்பதை ரசீது சொல்கிறது: உடனே, தாமதத்துக்குப் பின் (தேவைப்படும் இடத்தில் இரண்டாம் கையொப்பமிடுபவருடன்), அல்லது கணக்கு பூட்டப்பட்டிருக்கும் வரை இல்லை; அதை `depositToVault` மறுப்பதில்லை. கையொப்பமிடும் முன் கடைசிச் சரிபார்ப்பு `hasAcceptedCurrentTerms`-ஐ மீண்டும் படித்து, ஏற்காத பதிப்பை மறுக்கிறது.

<a id="vault-withdraw"></a>

### உங்கள் பெட்டகத்திலிருந்து எடுத்தல்

எடுப்பு `VaultDepositoryFacet.withdrawFromVault(account, kind, asset, tokenId, amount, recipient)` ஆகும்; `account`, `recipient` இரண்டும் இணைக்கப்பட்ட வாலெட். அதன் வரம்பு `withdrawableNow(account, kind, asset, tokenId)` (இல்லையெனில் `AmountExceedsFree`); அது `requireManager(account)`-ஐச் சரிபார்க்கிறது, அழைப்பவரையும் (Tier-1) பெறுநரையும் சோதிக்கிறது, கணக்கு பாதுகாக்கப்பட்டு `isEscapeOpen` உண்மையாக இருந்தால் தவிர இடைநிறுத்தத்தில் மறுக்கப்படுகிறது. மதிப்பாய்வு ஒரே பிளாக்கில் `getUserVaultAddress`, `paused`, `isEscapeOpen`, தடைநிலை, `getProtectedAccount(wallet)`, `withdrawableNow` ஆகியவற்றைப் படித்து, பிறகு அழைப்பைச் சோதனை ஓட்டம் செய்கிறது. பாதுகாப்பு முறை இல்லையெனில் பெட்டக வழிகள் உடனே வாலெட்டுக்குச் செலுத்துகின்றன; இருந்தால், `LibProtectedAccount.queuePayout` செலுத்துதலை `delaySeconds` வரை வரிசையில் வைத்து, `ProtectedVaultLocked`, `RecipientNotAllowlisted`, `TooManyPendingRows` ஆகியவற்றை மறுக்கிறது. நிறைவு அட்டை `VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, queued)`, `PayoutQueued`, பெட்டகத்திலிருந்து வாலெட்டுக்குச் சென்ற டோக்கனின் சொந்தப் பரிமாற்றப் பதிவுகள் ஆகியவற்றைப் படிக்கிறது. டோக்கன் அடையாளங்கள் இல்லாமல் வைப்புப் பதிவு குறிப்பிடும் தொகுப்பு, டோக்கன் அடையாளத்தைத் தட்டச்சிட்டு எடுக்கப்படுகிறது; படிவத்தின் வரம்பு அந்த டோக்கனுக்கான `withdrawableNow`, ஒவ்வொரு பிளாக்கிலும் மீண்டும் படிக்கப்படுகிறது.

<a id="vault-safety"></a>

### கணக்குப் பாதுகாப்பு

அட்டை ஒரே தொகுதியில் `getProtectedAccount(wallet)`, `getProtectedDelayBounds()`, `paused`, தடைகள் நிலை, `getPendingPayoutIds(wallet)` ஆகியவற்றைப் படிக்கிறது; `FunctionDoesNotExist` revert கிடைக்கவில்லை என்று படிக்கப்படுகிறது. இயக்குவது `enableProtectedMode(delaySeconds, protectNfts)`: உடனடியாக நடைமுறைக்கு வரும், இடைநிறுத்தத்தின் போதோ ஏற்கெனவே இயங்கினாலோ மறுக்கப்படும், தாமதம் வரம்புகளுக்குள் (இரண்டு முதல் ஐந்து நாட்கள்) இருக்க வேண்டும், பெட்டகம் இல்லையெனில் அதை உருவாக்கும். இப்போதே பூட்டு என்பது `lockVault(wallet)`: இடைநிறுத்தத்தின் போதும் திறந்தது, காத்திருக்கும் ஒவ்வொரு வரிசையையும் ரத்து செய்கிறது (`PayoutCancelled`), நிலுவையிலுள்ள ஒவ்வொரு மாற்றத்தையும் கைவிடுகிறது, மேலாளர் முன்மொழிந்த மாற்றீட்டைச் செல்லாததாக்குகிறது. பூட்டு நீக்கக் கோருவது `requestUnlock(wallet)`, இடைநிறுத்தத்தின் போதோ `cooldownUntil` க்கு முன்போ மறுக்கப்படும், `pendingUnlockAt` ஐ இப்போதைய நேரத்துடன் `delaySeconds` சேர்த்த நேரமாக அமைக்கிறது. நிலுவையான மாற்றங்களைப் பயன்படுத்து என்பது `finalizeSettingChanges(wallet)`, நேரம் வந்த ஒவ்வொரு மாற்றத்தையும் ஒரே நேரத்தில் பயன்படுத்துகிறது; திறந்த வரிசை எதுவும் இல்லாத வரை அணைத்தல் காத்திருக்கும் (`PendingRowsExist`). ஒவ்வொரு செயலும் மதிப்பாய்வின் போதும் வாலெட் திறக்கும் முன் மீண்டும் சோதனை ஓட்டமாக இயக்கப்படுகிறது; நிறைவு அட்டை Diamond இன் பதிவுகளிலிருந்து `ProtectedModeEnabled`, `VaultLocked`, `PayoutCancelled`, `SettingChangeRequested`, `SettingChangeApplied` ஆகியவற்றைப் படிக்கிறது.

<a id="vault-escape"></a>

### நெறிமுறை இடைநிறுத்தப்பட்டிருக்கும் போது

அறிவிப்பு ஒரே தொகுதியில் `paused`, `VaultPayoutFacet.isEscapeOpen`, `escapeOpensAt` (கைமுறை இடைநிறுத்தம் தொடங்கிய நேரத்துடன் அது தொடங்கியபோதிருந்த தப்பிக்கும் காலம் சேர்ந்தது; எதுவும் நடைமுறையில் இல்லையெனில் அல்லது Diamond ஒருபோதும் தொடங்கப்படவில்லையெனில் பூஜ்யம்), `getProtectedAccount(wallet)` ஆகியவற்றைப் படித்து, தொகுதியின் நேரத்தைக் கொண்டு கவுண்ட்டவுன் செய்கிறது. வழி மூடியிருக்கும் இடைநிறுத்தத்தில் `withdrawFromVault` `EnforcedPause` உடன் revert ஆகிறது, இடைநிறுத்தம் அதை நிறுத்துகிறது என்று மதிப்பாய்வு சொல்கிறது. `isEscapeOpen` உண்மையானதும், பாதுகாக்கப்பட்ட கணக்கு தொடர்ந்து `withdrawFromVault` ஐயே பயன்படுத்துகிறது, அது வரிசையில் சேர்ப்பதைத் தொடர்கிறது; வேறு எந்த வாலெட்டின் எடுப்பும் `escapeWithdraw(kind, asset, tokenId, amount)` ஐ அழைக்கிறது; அது பாதுகாக்கப்பட்ட கணக்கை மறுக்கிறது (`EscapeNotForProtected`), தடைசெய்யப்பட்ட பெறுநரை மறுக்கிறது, வாலெட்டின் சொந்த வைப்பு இருப்பாலும் தடையற்ற எண்ணாலும் வரம்பிடப்படுகிறது, அழைத்தவருக்கே செலுத்துகிறது. நிறைவு அட்டை `EscapeWithdrawal(account, asset, tokenId, amount)` ஐயும், பெட்டகத்திலிருந்து வாலெட்டுக்கு டோக்கனின் சொந்த மாற்றத்தையும் படிக்கிறது. இடைநிறுத்தம், வழி, அல்லது வழி திறந்திருக்கும் போது முறை படிக்க முடியவில்லையெனில், எந்த எடுப்பும் அனுப்பப்படாது.

<a id="my-offers"></a>

### உங்கள் சலுகைகள்

பட்டியல் `getUserOffersPaginated(wallet)` (ரத்தான ஐடியையும் வைத்திருக்கும் உருவாக்குநர் குறியீடு) மற்றும் `getUserPositionOffersPaginated(wallet)` (வாலட் நிலை டோக்கனை வைத்திருக்கும் சலுகைகள்) ஆகியவற்றின் ஒன்றியம்; நிலைக்கு நிலை பதிலளிக்கும் `MetricsDashboardFacet.getOffersWithState` வழியாக அதிகபட்சம் 250 கொண்ட தொகுதிகளாகப் படிக்கப்படுகிறது. ஒவ்வொரு வரியும் கேட்ட ஐடியுடன் பொருத்தப்படுகிறது: எதுவும் நிறைவேறாமல் ரத்தான சலுகையின் பதிவு நீக்கப்படுவதால், காட்சி ஐடி 0 மற்றும் பெறப்பட்ட நிலை ரத்தானது எனத் தெரிவிக்கிறது, வரி மீண்டும் கட்டிய நிபந்தனைகளுக்குப் பதிலாக எதையும் காட்டாது. பகுதி நிறைவுக்குப் பின் ரத்தான சலுகை `accepted` அமைக்கப்பட்ட பதிவை வைத்திருக்கும், நிறைவேறியதாகப் படிக்கப்படும். வடிகட்டி எண்ணிக்கைகள் படித்த வரிகளின் மேல் கணக்கிடப்படுகின்றன; எந்தக் குறியீட்டையாவது இறுதி வரை படிக்க முடியவில்லையெனில், பட்டியல் முழுமையற்றதாக இருக்கலாம் எனப் பக்கம் சொல்கிறது.

<a id="offer-book"></a>

### சலுகை புத்தகம்

புத்தகம் குறியீட்டாளரின் `GET /offers/active?chainId&limit=50&before=<offerId>` ஐப் படிக்கிறது; சலுகை id படி புதியது முதலில், `nextBefore` மூலம் பக்கம் பக்கமாக. காலாவதியான சலுகையைக் குறியீட்டாளர் `active` ஆகவே வைத்திருக்கிறது (சங்கிலியில் காலாவதி சோம்பலாகக் கணிக்கப்படுகிறது), எனவே `expiresAt` கடந்த வரிசைக்குக் காலாவதியானது எனக் குறி இடப்படும். `isSaleVehicle`, `isOffsetVehicle`, `refinanceTargetLoanId` (null = படிக்கப்படவில்லை) வகையைக் குறிக்கின்றன, `positionFlow.movedSinceOpened` நகர்ந்த பிணைந்த நிலையைக் குறிக்கிறது (#3205). ஒவ்வொரு புலமும் துல்லியமாகப் பகுக்கப்படுகிறது; தோல்வியடையும் வரிசை படிக்கப்படாதது என எண்ணப்படுகிறது. தாவல் `assetType` (0 = ERC-20 கடன், இல்லையெனில் வாடகை), பக்கம் `offerType`. வினவல் புஷ் ரெயிலால் செல்லாததாக்கப்பட்டு, தெரியும் வரை ஒவ்வொரு 60 வினாடிக்கும் மீண்டும் படிக்கப்படுகிறது; குறியீட்டுத் தோல்வி கூறப்படுகிறது, ஒருபோதும் வெற்றுப் புத்தகமாக அல்ல.

<a id="offer-detail"></a>

### ஒரு சலுகையின் பக்கம்

`/offers/:id` ஒரே தொகுதியில் `OfferCancelFacet.getOffer(id)`, `MetricsFacet.getOfferState(id)`, `getOfferLinkedLoanId(id)` ஆகியவற்றைப் படிக்கிறது; வாலட் இணைக்கப்பட்டிருந்தால் அதன் வழியாக, இல்லையெனில் படிக்க மட்டுமான ப்ராக்ஸி வழியாக. பூஜ்ய உருவாக்குநர் என்றால் பதிவு நீக்கப்பட்டது (எதுவும் நிரப்பப்படாத ரத்து) அல்லது ஒருபோதும் எழுதப்படவில்லை; நெறிமுறை சலுகை எண்ணிக்கையை வைத்திருப்பதில்லை, எனவே எது என்று பக்கம் சொல்வதில்லை. பூஜ்யமல்லாத இணைந்த கடன், கடன் விற்பனையை (கடன் வாங்குபவர் சலுகை) அல்லது ஈடுசெய்தலை (கடன் கொடுப்பவர் சலுகை) குறிக்கிறது; கடன் வாங்குபவர் சலுகையின் `refinanceTargetLoanId` மறுநிதியளிப்புக் கோரிக்கையைக் குறிக்கிறது. எடுத்தல் பகிரப்பட்ட `acceptOffer` ஓட்டத்தை (கையொப்பமிட்ட `AcceptTerms`, துல்லியமான அனுமதி, சோதனை ஓட்டம், அளவிடப்பட்ட முடிவு) அதன் சொந்தச் சேமிப்புச் சாவியின் கீழ் இயக்குகிறது; ரத்தும் சுத்தமும் பகிரப்பட்ட `cancelOffer` ஓட்டத்தை இயக்குகின்றன. வாடகைகள், NFT பிணையம், கடன் விற்பனைகள், ஈடுசெய்தல்கள் தற்போதைய செயலிக்கு இணைக்கின்றன.

<a id="offer-cancel"></a>

### ஒரு சலுகையை ரத்து செய்தல்

மதிப்பாய்வு ஒரே தொகுதியில் `getOffer(id)`, `getOffersWithState([id])`, `getOfferLinkedLoanId(id)`, `paused()` மற்றும் உருவாக்குநரின் `getProtectedAccount` ஆகியவற்றைப் படித்து, பின் `OfferCancelFacet.cancelOffer(id)` ஐ சோதனை ஓட்டம் செய்கிறது. உருவாக்குநரின் மேலாளர் எப்போது வேண்டுமானாலும், `expiresAt` கடந்தபின் யார் வேண்டுமானாலும் ரத்து செய்ய ஃபேசெட் அனுமதிக்கிறது; அது `OfferAlreadyAccepted`, `OfferAlreadyConsumedBySale` ஆகியவற்றை மறுக்கிறது, `amountFilled == 0` கொண்ட சலுகை 300 விநாடிகளுக்குள் புதியதாகவும் காலாவதியாகாமலும் இருந்தால் `CancelCooldownActive` என மறுக்கிறது, மேலும் அது `whenNotPaused`. திருப்பித் தொகை ஃபேசெட்டின் சொந்தக் கிளைகளால் கணக்கிடப்படுகிறது: ERC-20 கடன் சலுகை கடன் சொத்தின் `(amountMax அல்லது amount) - amountFilled` ஐத் தருகிறது; NFT கடன் சலுகை அதன் டோக்கனை, அல்லது ERC-1155 அளவை; கடன் கோரிக்கை பயன்படுத்தாத அடமானம் `(collateralAmountMax அல்லது collateralAmount) - collateralAmountFilled` அல்லது அதன் NFT, `refinanceCarryOver` அடமானத்தைக் கடனில் வைத்தால் எதுவும் இல்லை; வாடகைக் கோரிக்கை `amount × durationDays` உடன் `rentalBufferBpsAtCreate` இடைவெளி. `getOfferLinkedLoanId` மூலம் கடனுடன் இணைந்த சலுகை, அல்லது பதிவான இடைவெளி பூஜ்யமான வாடகைக் கோரிக்கை (அப்போது நெறிமுறை தற்போதைய விகிதத்தைப் பயன்படுத்துகிறது), கையொப்பத்துக்கு முன் கணக்கிடப்படுவதில்லை. ஒவ்வொரு திருப்பித் தொகையும் வால்ட் திரும்பப் பெறுதல் வழியாக உருவாக்குநரின் வால்ட்டை விட்டு வெளியேறுகிறது, எனவே பாதுகாக்கப்பட்ட பயன்முறை அதை வரிசையில் சேர்க்கிறது, அல்லது கணக்கு பூட்டியிருக்கும் வரை வால்ட்டில் வைக்கிறது. நிலை டோக்கன் ஓய்வு பெறுகிறது. முடிவு அட்டை `OfferCanceled(offerId, creator)`, உருவாக்குநருக்கான நெறிமுறையின் செலுத்துதல் பதிவு, உருவாக்குநருக்கு டோக்கனின் சொந்தப் பரிமாற்றம் ஆகியவற்றைப் படிக்கிறது.

<a id="risk-access"></a>

### Risk Access: உங்கள் இடர் நிலை

சுவிட்ச் `getRiskAccessGateEnabled`. ஒரு செயல்முறைக்கு எந்தப் படி தேவை என்பது நெறிமுறையின் சொந்தப் பதில்: ஏற்புக்கு, கடன் வழங்குநர் தடுக்கப்படவில்லை என `previewCreatorBlock` காட்டிய பின் `previewOfferAcceptBlock` (1 = நிலை குறைவு, 2 = ஜோடி ஒப்புதல், 3 = கண்டிப்பு முறை ஒப்புகை, 4 = முன்பு ஏற்பின் ஒப்புகை உள்ளடக்கிய திரவமற்ற ஜோடி; இது 2 போலவே தடுக்கிறது, ஜோடி ஒப்புதல் அதை நீக்குகிறது); கோரிக்கைக்கு, `createOffer` சோதனை ஓட்டத்தின் `RiskTierTooLow`, `IlliquidPairNotConsented` அல்லது `MidTierPairNotAcknowledged`. படி ஒரே பிளாக்கில் ஜோடிக்கான `pairRequiredRiskLevel` (சலுகைக்கு `acceptMidTierAckPair`), `getVaultRiskTier`, `getEffectiveRiskTier`, `getCurrentRiskTermsVersion`-க்கு எதிரான `getVaultRiskTierVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown`, `getRiskTierMutationNonce` ஆகியவற்றையும், ஜோடிக்கு `hasIlliquidPairConsent` உடன் `isPairConsentPending` அல்லது `midTierStrictBlocked` உடன் `isMidTierAckPending` ஆகியவற்றையும் படிக்கிறது. நிலை உயர்த்தல் என்பது ஜோடிக்குத் தேவையான குறைந்தபட்ச நிலைக்கான `setVaultRiskTierChecked(level, nonce, termsVersion)`; மதிப்பாய்வுக்குப் பின் வேறு நிலை எழுதுதலோ விதிமுறை மாற்றமோ வந்திருந்தால் அது எதையும் மாற்றாமல் மறுக்கப்படும். ஜோடிப் படி `setIlliquidPairConsent(pair, true)` அல்லது `setMidTierPairAck(pair)`. இன்னும் காத்திருக்கும் உயர்த்தலோ நிலுவையிலுள்ள ஜோடிப் படியோ மீண்டும் வழங்கப்படாது. நிலுவையிலுள்ள ஜோடிப் படி எப்போது நடைமுறைக்கு வரும் என்பதைத் தரும் வாசிப்பு எதுவும் இல்லை; எனவே அந்த நேரத்தைப் படிக்க முடியாது என்று மதிப்பாய்வு சொல்கிறது; அந்தப் படியின் நிறைவு அட்டை மட்டுமே ரசீது பிளாக்கின் நேரம் மற்றும் காத்திருப்புக் காலத்திலிருந்து அதைத் தருகிறது. விளைவு ரசீதின் பிளாக்கில் மீண்டும் படிக்கப்படுகிறது.

<a id="terms-gate"></a>

### விதிமுறைகள் உறுதிப்படுத்தல்

`getCurrentTos` செயல் நடக்கும் சங்கிலியில் நடைமுறையில் உள்ள பதிப்பையும் உள்ளடக்க ஹாஷையும் தரும்; பதிப்பு 0 என்றால் விதிமுறைகள் இல்லை, எதுவும் தடுக்கப்படாது. `hasAcceptedCurrentTerms` false ஆக உள்ள வாலெட்டிடம் புதிய வெளிப்பாட்டுக்கு முன் கேட்கப்படும்; அந்தக் கேள்வி, உரை ஒருபோதும் மாறாத பதிப்பு-நிலையான பக்கமான `/terms/v<N>`-க்கு இணைக்கும். ஏற்பது `acceptTerms(version, hash)`-ஐ ஒருமுறை அழைக்கும். வாலெட் திறக்கும் முன் அந்த ஜோடி மீண்டும் படிக்கப்படும்; அதனால் புதிய பதிப்பு காட்டப்பட்டதை மாற்றும், வேறு தாவலில் செய்த ஏற்பு செயலைத் தொடர விடும். படிப்பு தோல்வி என்றால் "உறுதிப்படுத்த முடியவில்லை", மீண்டும் முயலலாம்; ஒருபோதும் "ஏற்கவில்லை" அல்ல. வெளியேறும் செயல்கள் ஒருபோதும் தடுக்கப்படாது.
