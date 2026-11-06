# Vaipakam — 사용자 가이드 (Basic Mode)

앱의 각 카드를 친절하고 쉬운 한국어로 설명합니다. 각 섹션은
카드 제목 옆의 `(i)` info icon과 연결되어 있습니다.

> **Basic 버전을 읽고 있습니다.** 앱의 **Basic** 모드(컨트롤을
> 줄이고 안전한 기본값을 둔 단순한 화면)에 맞춘 안내입니다. 더
> 기술적이고 자세한 walkthrough가 필요하다면 앱을 **Advanced**
> 모드로 전환하세요 — Settings 열기(우측 상단 톱니바퀴 아이콘)
> → **Mode** → **Advanced**. 그 뒤 앱 안의 (i) "Learn more"
> 링크는 Advanced 가이드를 열게 됩니다.

---

<a id="chapter.dashboard"></a>

## Dashboard

<a id="dashboard.your-vault"></a>

### 내 Vault

**vault**는 Vaipakam 안에 있는 내 전용 금고라고 생각하면 됩니다.
나만을 위해 준비되는 작은 contract입니다. loan에 참여할 때마다 —
collateral을 넣든 asset을 빌려주든 — assets는 wallet에서 이 금고로
이동합니다. 다른 사람의 자금과 섞이지 않습니다. loan이 끝나면 여기서
직접 claim해 되찾습니다.

vault를 직접 "만들" 필요는 없습니다. 처음 필요해지는 순간 앱이
만들어 줍니다. 한 번 생성되면 그 chain 위의 내 전용 보관 장소로
계속 남습니다.

<a id="dashboard.your-loans"></a>

### 내 Loans

이 chain에서 내가 참여한 모든 loan이 여기 표시됩니다 — 내가
lender(asset을 빌려주는 쪽)이든 borrower(빌린 쪽)이든 같습니다.
각 행은 하나의 position입니다. 클릭하면 loan의 건강 상태, collateral
로 lock된 것, 누적된 interest, 그리고 때가 되었을 때 repay / claim /
liquidate할 수 있는 buttons까지 한눈에 볼 수 있습니다.

서로 다른 loan에서 한쪽은 lender이고 다른 한쪽은 borrower인 경우도
같은 곳에 각각 다른 행으로 표시됩니다.

<a id="dashboard.vpfi-panel"></a>

### 이 chain의 VPFI

**VPFI**는 protocol 자체 token입니다. vault에 넣어 두면 protocol
fees 할인을 받습니다. 이 카드는 현재 연결된 chain에 대해 다음을
보여줍니다:

- 지금 wallet에 있는 VPFI 양.
- vault에 있는 양(discount tier에 count됩니다).
- 전체 VPFI 공급량 중 내 비중.
- 전체적으로 얼마나 더 mint될 수 있는지(protocol에 hard cap이
  있습니다).

Vaipakam은 여러 chains에서 동작합니다. 그중 Base가 새 VPFI가 mint되는
**canonical** chain이고, 나머지는 cross-chain bridge로 동기화되는
**mirrors**입니다. 사용자 입장에서는 깊게 신경 쓸 필요가 없습니다 —
어떤 chain에 연결되어 있든, 보이는 잔액은 그 chain 위에 실제로
존재합니다.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount 동의

Vaipakam은 vault에 둔 VPFI 양에 따라 protocol fees 할인을 적용할 수
있습니다. borrower에게 이 할인은 loan이 시작될 때 loan 자체의 asset으로
떼어 가는 더 낮은 Loan Initiation Fee일 뿐이며 — 이를 위해 VPFI가
쓰이지는 않습니다. 이 switch는 "네, 그렇게 해 주세요"라는 consent
toggle입니다. 한 번만 켜면 됩니다.

할인의 크기는 vault에 얼마나 많은 VPFI를 보관하느냐에 따라
달라집니다:

- **Tier 1** — `{liveValue:tier1Min}` VPFI 이상 → `{liveValue:tier1DiscountBps}`% off
- **Tier 2** — `{liveValue:tier2Min}` VPFI 이상 → `{liveValue:tier2DiscountBps}`% off
- **Tier 3** — `{liveValue:tier3Min}` VPFI 이상 → `{liveValue:tier3DiscountBps}`% off
- **Tier 4** — `{liveValue:tier4Min}` VPFI 초과 → `{liveValue:tier4DiscountBps}`% off

스위치는 언제든 끌 수 있습니다. vault에서 VPFI를 인출하면
tier가 실시간으로 떨어집니다.

> **Blockchain network gas 관련 안내.** 위의 discount는 Vaipakam의
> **protocol fees**(Yield Fee, Loan Initiation Fee)에 적용됩니다.
> 모든 on-chain action에 필요한 작은 **gas fee** (offer create,
> accept, repay, claim 등을 할 때 blockchain validators에게 pay하는
> 것)는 별도의 charge로, network로 가며 Vaipakam에게 가지 않습니다.
> protocol은 그것을 결코 receive하지 않기 때문에 그것에 discount를
> 적용할 수 없습니다.

<a id="dashboard.rewards-summary"></a>

### 내 VPFI 보상

이 카드는 프로토콜에서 획득한 모든 VPFI 보상을 한 곳에 모아
보여줍니다. 상단의 큰 숫자는 결합 합계입니다 — 이미 청구한
것과 청구를 기다리는 것의 합계입니다.

보상은 **플랫폼 상호작용**에서 나옵니다 — 양쪽 어느 쪽이든
참여하는 각 대출에 대해 매일 조금씩 획득됩니다. 현재 체인의
VPFI로 지급되며 브리지가 필요 없습니다.

행 오른쪽에 작은 셰브론 화살표가 있습니다. 클릭하면 Claim
Center의 전체 청구 카드로 바로 이동합니다.

아직 아무것도 획득하지 않았어도 카드는 *총 획득액: 0 VPFI*
와 시작하는 방법에 대한 힌트와 함께 렌더링됩니다. 잘못한
것이 없습니다 — 표시할 기록이 없을 뿐입니다.


---

<a id="chapter.offer-book"></a>

## Offer Book

<a id="offer-book.filters"></a>

### Filters

market list는 길어질 수 있습니다. filters를 쓰면 loan의 asset,
lender offer인지 borrower offer인지, 그리고 몇 가지 다른 기준으로
좁혀 볼 수 있습니다. 내 active offers는 항상 페이지 상단에 그대로
보입니다 — filters는 다른 사람의 offers에만 영향을 줍니다.

<a id="offer-book.your-active-offers"></a>

### 내 Active Offers

**내가** 게시했고 아직 아무도 accept하지 않은 offers입니다. 여기
있는 동안에는 무료로 cancel할 수 있습니다. 누군가 accept하면 그
position은 실제 loan이 되고, Dashboard의 "내 Loans"로 이동합니다.

<a id="offer-book.lender-offers"></a>

### Lender Offers

빌려주려는 사람들의 posts입니다. 각각의 의미는 "asset Y를 X units,
Z% interest로 D일 동안 빌려주겠다. 대신 이만큼의 collateral을 넣어
달라"입니다.

이 중 하나를 accept한 borrower는 그 loan의 borrower-of-record가
됩니다. borrower의 collateral은 vault에 lock되고, principal asset은
borrower의 wallet에 도착하며, borrower가 repay할 때까지 interest가
누적됩니다.

protocol은 acceptance 시 borrower 쪽에 한 가지 safety rule을 강제합니다:
collateral 가치는 loan의 최소 1.5배여야 합니다. (이 숫자를
**Health Factor 1.5**라고 합니다.) borrower의 collateral이 부족하면
loan은 시작되지 않습니다.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

이미 collateral을 lock했고 loan을 fund해 줄 사람을 기다리는 borrowers
의 posts입니다.

이 중 하나를 accept한 lender가 loan을 fund합니다. lender의 asset은
borrower에게 가고, lender는 lender-of-record가 되며, 기간 동안 offer
의 rate로 interest를 얻습니다. interest의 작은 일부(`{liveValue:treasuryFeeBps}`%)는 settlement
시 protocol treasury로 갑니다.
이 rate는 loan이 생성될 때 고정되므로, 이후 protocol fee가 바뀌어도 이미 열려 있는 loan은 시작할 때의 rate를 유지합니다.

---

<a id="chapter.create-offer"></a>

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

어느 side로 offer를 만들지 선택합니다:

- **Lender** — lender는 asset을 공급하고 loan이 미상환인 동안
  interest를 얻습니다.
- **Borrower** — borrower는 collateral을 lock하고 그 대가로 다른
  asset을 요청합니다.

"rentable" NFT(일시적으로 delegate할 수 있는 특수 NFT)를 위한
**Rental** sub-option도 있습니다. Rental은 돈을 빌려주는 것이
아닙니다 — NFT 자체를 daily fee로 빌려주는 흐름입니다.

<a id="create-offer.lending-asset"></a>

### Lending Asset

대상이 되는 asset과 amount, interest rate(APR %), duration(일수)입니다.
rate는 offer가 게시될 때 fixed되며 누구도 나중에 변경할 수 없습니다.
duration이 끝난 뒤에는 짧은 grace window가 적용됩니다 — 그때까지
borrower가 repay하지 않으면 loan은 default될 수 있고 lender의
collateral claim이 시작됩니다.

<a id="create-offer.lending-asset:lender"></a>

#### 내가 lender인 경우

내가 제공할 principal asset과 amount, interest rate(APR %), duration
(일수)입니다. rate는 offer 시점에 fixed되고, duration은 loan이 default
될 수 있기 전 grace window를 정합니다.

<a id="create-offer.lending-asset:borrower"></a>

#### 내가 borrower인 경우

lender에게서 받고 싶은 principal asset과 amount, interest rate(APR %),
duration(일수)입니다. rate는 offer 시점에 fixed되고, duration은 loan이
default될 수 있기 전 grace window를 정합니다.

<a id="create-offer.nft-details"></a>

### NFT Details

rental offer에서는 이 카드가 daily rental fee를 설정합니다. renter는
acceptance 시 rental cost 전체를 upfront으로 지불하고, deal이 조금
길어질 경우에 대비해 작은 5% buffer도 냅니다. NFT 자체는 계속 vault
안에 있습니다 — renter는 사용할 권리는 있지만 NFT를 move할 수는
없습니다.

<a id="create-offer.collateral"></a>

### Collateral

loan을 secure하기 위해 lock되는 것입니다. 두 가지 유형이 있습니다:

- **Liquid** — live price feed가 있는 잘 알려진 token
  (Chainlink + 충분히 깊은 on-chain pool). protocol이 real time으로
  가치를 산정할 수 있고, 가격이 loan에 불리하게 움직이면 position을
  자동으로 liquidate할 수 있습니다.
- **Illiquid** — NFT 또는 price feed가 없는 토큰. 프로토콜이
  이를 평가할 수 없으므로 default 시 lender가 collateral 전체를
  가져갑니다. offer를 만들기 전에 lender와 borrower 모두 이 조건에
  동의해야 합니다.

<a id="create-offer.collateral:lender"></a>

#### 내가 lender인 경우

borrower에게 loan의 security로 얼마를 lock하게 할지입니다. Liquid
ERC-20s(Chainlink feed + ≥$1M v3 pool depth)에는 LTV/HF math가
적용됩니다. illiquid ERC-20s와 NFTs에는 on-chain valuation이 없으며,
양 당사자가 full-collateral-on-default outcome에 동의해야 합니다.

<a id="create-offer.collateral:borrower"></a>

#### 내가 borrower인 경우

loan의 security로 얼마를 lock할 의향이 있는지입니다. Liquid ERC-20s
(Chainlink feed + ≥$1M v3 pool depth)에는 LTV/HF math가 적용됩니다.
illiquid ERC-20s와 NFTs에는 on-chain valuation이 없으며, 양 당사자가
full-collateral-on-default outcome에 동의해야 합니다.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

Vaipakam에서 lending / borrowing을 하는 일에는 실제 risk가 따릅니다.
offer에 sign하기 전에, 이 카드는 sign하는 side의 명시적인
acknowledgement를 요청합니다. 아래 risks는 양쪽 모두에 적용됩니다.
아래 role-specific tabs는 각 risk가 어느 쪽에 어떻게 더 크게 작용하는지
짚어 줍니다.

Vaipakam은 non-custodial입니다. 이미 처리된 transaction을 되돌려 줄
support desk는 없습니다. sign하기 전에 신중히 읽어 주세요.

<a id="create-offer.risk-disclosures:lender"></a>

#### 내가 lender인 경우

- **Smart-contract 위험** — contracts는 immutable code입니다. 알려지지
  않은 bug가 funds에 영향을 줄 수 있습니다.
- **Oracle 위험** — 오래되었거나 조작된 price feed는 collateral이
  principal을 cover하지 못하는 지점을 지나서까지 liquidation을 지연시킬
  수 있습니다. 전액 회수하지 못할 수 있습니다.
- **Liquidation slippage** — liquidation이 제때 실행되더라도 DEX swap이
  quote보다 나쁜 가격에 체결되어 실제 recovery가 줄어들 수 있습니다.
- **Illiquid collateral** — default 시 collateral 전체가 나에게
  transfer되지만, 그 value가 loan보다 낮다면 추가 claim은 없습니다.
  offer creation 시 이 trade-off에 동의한 것입니다.

<a id="create-offer.risk-disclosures:borrower"></a>

#### 내가 borrower인 경우

- **Smart-contract 위험** — contracts는 immutable code입니다. 알려지지
  않은 bug가 locked collateral에 영향을 줄 수 있습니다.
- **Oracle 위험** — 오래되었거나 조작된 price feed는 real-market price
  기준으로는 안전했을 순간에도 나에 대한 liquidation을 trigger할 수
  있습니다.
- **Liquidation slippage** — liquidation이 실행되면 DEX swap이 예상보다
  나쁜 가격에 내 collateral을 팔 수 있습니다.
- **Illiquid collateral** — default 시 collateral 전체가 lender에게
  transfer되며, 나에게 돌아올 residual claim은 없습니다. offer creation
  시 이 trade-off에 동의한 것입니다.

<a id="create-offer.advanced-options"></a>

### Advanced Options

원하는 사용자만 쓰면 되는 추가 settings입니다 — 대부분은 그대로 두면
됩니다. offer가 expire되기까지 얼마나 열려 있을지, 이 특정 offer에
VPFI fee discount를 사용할지, 몇 가지 role-specific toggles 등이
있습니다. 첫 offer에서는 건너뛰어도 괜찮습니다.

---

<a id="chapter.claim-center"></a>

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

loan이 끝난 뒤 — repay되었든, default되었든, liquidated되었든 —
결과에서 내 몫이 wallet으로 자동 이동하지는 않습니다. 받으려면
**Claim**을 클릭해야 합니다. 이 페이지는 이 chain에서 아직 처리하지
않은 모든 claim의 목록입니다.

한 사용자가 lender claims(내가 fund한 loans)와 borrower claims(내가
빌린 loans)를 동시에 가질 수 있습니다 — 둘 다 같은 list에 표시됩니다.
아래 role-specific tabs는 각 claim이 무엇을 돌려주는지 설명합니다.

<a id="claim-center.claims:lender"></a>

#### 내가 lender인 경우

lender claim은 loan의 principal과 accrued interest를 돌려줍니다.
다만 interest 부분에서 treasury cut이 차감됩니다. 이 cut의 비율은
loan 생성 시점에 고정되며, 이후 프로토콜 수수료가 바뀌어도 변하지
않습니다. 현재 요율로 생성되는 loan의 cut은
`{liveValue:treasuryFeeBps}`%입니다. loan이 settle되는
즉시(repaid, defaulted, 또는 liquidated) claimable이 됩니다. claim은
lender position NFT를 atomically consume합니다 — 완료되면 그 side의
loan은 완전히 close됩니다.

<a id="claim-center.claims:borrower"></a>

#### 내가 borrower인 경우

loan을 full repay했다면 borrower claim은 시작할 때 lock한 collateral을
돌려줍니다. default 또는 liquidation 시에도 한 번 확인해 보세요. 빚과 그것을
정리하는 비용에 필요한 만큼의 가치만 가져가며, 그것을 넘는 몫은 내
것으로 기록됩니다. 그 형태는 loan이 어떻게 끝났는지에 따라 다릅니다:
collateral이 거래소를 거쳐 팔렸다면 남은 몫은 loan 자체의 asset으로
도착합니다. 팔리지 않고 넘겨졌다면 collateral 자체가 여러분을 기다립니다.
넘기는 경우는 여럿이며, loan이 어떻게 끝났는지와는 무관합니다: liquidator가 할인된 값에 직접 가져가는 경우,
close-out이 팔리지 않고 프로토콜 내부에서 반대편 position과 매칭되는 경우, 그리고 매각 자체가 성사되지 못한 경우 — 그때는 collateral이 옵니다 — claim 시점에 lender가 통하는 견적을 가져오지 않는 한 그렇고, 가져오면
loan 자체의 asset으로 지급됩니다. 대부분은 견적을 가져오지 않습니다. 일반 liquidation도 default도
거래소로 가기 전에 그 내부 매칭을 먼저 찾으므로, 이 둘은 결과가 늘 같지는 않습니다 — 어떻게 끝났는지로 짐작하지 말고
claim을 읽으세요. 할인된 값의 직접 인수는 예외이고, 반대 방향으로 예측 가능합니다: 팔지 않으므로 언제나
collateral이 남습니다.
값을 매길 수 없는 collateral에 대한 default에서는
바스켓 전체가 나가 아무것도 남지 않는 경우가 많지만, 이 경로에서는 그것이 우연이 아니라 규칙입니다.
claim은 borrower position NFT를 consume합니다. 그 역은 성립하지
않습니다. liquidation 이후 NFT가 남아 있다는 사실은 무언가가 기다리고
있다는 증거가 아닙니다. 남은 것이 없으면 받아 갈 것도 없고, claim을 시도하면
거절되며, NFT는 그대로 남을 수 있습니다.
NFT를 약속으로 받아들이지 말고 claim이 무엇이라 말하는지 읽으세요.

---

<a id="chapter.activity"></a>

## Activity

<a id="activity.feed"></a>

### Activity Feed

연결된 chain에서 내 wallet과 관련된 모든 on-chain events를 보여줍니다
— 내가 게시하거나 accept한 offers, loans, repayments, claims,
liquidations. 모두 chain 자체에서 live로 읽어옵니다. 내려갈 수 있는
central server는 없습니다. 최신 순으로 표시되고 transaction별로 묶여,
한 번의 click으로 한 일은 함께 보입니다.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI 얻기

VPFI는 자유롭게 transferable합니다. VPFI가 거래되는 open market
어디서든 취득하거나, bridge로 가져올 수 있습니다 — VPFI는
Chainlink CCIP token이므로 official bridge를 사용해 supported chains
사이를 이동하며, 내가 연결한 chain의 wallet으로 도착합니다.

<a id="buy-vpfi.discount-status"></a>

### 내 VPFI Discount Status

현재 어느 discount tier에 있는지 빠르게 확인합니다. Tier는
**vault** 안의 VPFI 양으로 결정됩니다(wallet balance가 아닙니다).
이 카드는 (a) 다음 tier로 올라가려면 vault에 VPFI가 얼마나 더
필요한지, (b) Dashboard의 consent switch가 켜져 있는지도 알려줍니다
— discount는 켜져 있을 때만 적용됩니다.

<a id="buy-vpfi.deposit"></a>

### VPFI를 vault에 입금

wallet에 있는 VPFI는 discount tier에 count되지 않습니다. fee
discount를 unlock하려면 직접 VPFI를 vault로 옮겨야 합니다. 이는
항상 명시적인 click입니다 — 앱은 요청 없이 VPFI를 옮기지
않습니다. 한 번의 transaction(또는 지원되는 chain에서는 single
signature)이면 됩니다.

<a id="buy-vpfi.unstake"></a>

### vault에서 VPFI withdraw

VPFI를 wallet으로 다시 가져오고 싶다면 이 카드에서 vault로부터
withdraw하면 됩니다. 주의: VPFI를 빼면 discount tier가 **즉시**
떨어집니다. open loans가 있다면, 이 시점부터 discount math는 더 낮은
tier로 계산됩니다.

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards 소개

Vaipakam은 **platform-interaction reward**를 지급합니다: 내가 관여한
loan에서 실제 settle된 interest 1달러마다 community-wide reward
pool의 daily share를 받습니다.

Rewards는 VPFI로 지급되며, 연결된 chain 위에서 직접 mint됩니다.
bridge도, chain switching도 필요 없습니다.

<a id="rewards.claim"></a>

### Rewards Claim

button 하나로 accrued rewards를 한 번의 transaction에서 claim합니다.
interaction-pool share는 하루에 한 번 settle되므로, 마지막 settlement
이후 earned된 부분이 있다면 다음 daily window가 닫힌 직후에 live가
됩니다.

---

<a id="chapter.loan-details"></a>

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (이 페이지)

하나의 loan에 관한 모든 것을 한 페이지에 모았습니다. 어떤 terms로
open되었는지, 지금 얼마나 healthy한지, 각 side에 누가 있는지, 그리고
내 role에서 누를 수 있는 모든 buttons — repay, claim, liquidate,
close early, refinance.

<a id="loan-details.terms"></a>

### Loan Terms

loan의 fixed parts입니다: 어떤 asset이 빌려졌는지, amount, interest
rate, duration, 그리고 지금까지 accrued된 interest. loan이 open된
이후로는 이 중 어떤 것도 바뀌지 않습니다. (다른 terms가 필요하면
refinance합니다 — 앱이 새 loan을 만들고 같은 transaction에서 이 loan을
갚습니다.)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

이 loan의 collateral과 live risk numbers — Health Factor와 LTV입니다.
**Health Factor**는 하나의 safety score입니다: 1을 넘으면 collateral이
loan을 충분히 cover한다는 뜻이고, 1에 가까울수록 위험해져 loan이
liquidate될 수 있습니다. **LTV**는 "빌린 amount vs. 맡긴 것의 value"
입니다. position이 unsafe해지는 thresholds도 같은 카드에서 확인할 수
있습니다.

collateral이 illiquid(NFT 또는 live price feed가 없는 token)라면 이
numbers는 계산할 수 없습니다. 양쪽 모두 offer creation 시 그 outcome에
동의한 상태입니다.

<a id="loan-details.collateral-risk:lender"></a>

#### 내가 lender인 경우

이것은 borrower의 collateral — 나를 보호하는 buffer입니다. HF가 1을
넘는 동안에는 충분히 cover됩니다. HF가 내려갈수록 protection은
약해집니다. 1 아래로 떨어지면 누구든(나 포함) liquidation을 trigger할
수 있고, DEX swap이 collateral을 내 principal asset으로 바꿔 상환합니다.
illiquid collateral의 경우 default 시 collateral 전체가 나에게
transfer됩니다 — 실제 value가 얼마인지는 내가 감수합니다.

<a id="loan-details.collateral-risk:borrower"></a>

#### 내가 borrower인 경우

이것은 내가 lock한 collateral입니다. HF를 1보다 충분히 위에
유지하세요 — 1에 가까워질수록 liquidation risk가 커집니다. 보통
collateral을 추가하거나 loan의 일부를 repay하면 HF를 다시 올릴 수
있습니다. HF가 1 아래로 떨어지면 누구든 liquidation을 trigger할 수
있고, DEX swap이 slippage를 받은 가격으로 collateral을 팔아 lender에게
상환합니다. illiquid collateral의 경우 default 시 collateral 전체가
lender에게 transfer되며, 나에게 돌아올 residual claim은 없습니다.

<a id="loan-details.parties"></a>

### Parties

이 loan의 두 wallet address — lender와 borrower — 그리고 각자의 assets를
보관하는 vault vaults입니다. loan이 open될 때 양쪽은 "position NFT"도
받았습니다. 그 NFT _자체_ 가 해당 side의 outcome을 claim할 권리입니다
— 안전하게 보관하세요. holder가 다른 사람에게 transfer하면 새 holder가
대신 claim할 수 있습니다.

<a id="loan-details.actions"></a>

### Actions

이 loan에서 사용할 수 있는 모든 buttons입니다. 보이는 set은 이 특정
loan에서의 내 role에 따라 달라집니다 — 아래 role-specific tabs가 각
side의 options를 정리합니다. 지금 사용할 수 없는 buttons는 greyed out
되고, 이유를 설명하는 작은 tooltip이 표시됩니다.

<a id="loan-details.actions:lender"></a>

#### 내가 lender인 경우

- **Claim** — loan이 settle되면(repaid, defaulted, 또는 liquidated)
  principal과 interest를 돌려받습니다. interest에는 loan 생성 시
  고정된 treasury cut(현재 요율로 생성된 loan은
  `{liveValue:treasuryFeeBps}`%)이 적용됩니다. lender NFT를
  consume합니다.
- **Initiate Early Withdrawal** — loan 중간에 lender NFT를 다른 buyer에게
  sale listing합니다. buyer가 내 side를 이어받고, 나는 sale proceeds를
  받고 exit합니다.
- **Liquidate** — HF가 1 아래로 떨어지거나 grace period가
  만료되면 누구든(나 포함) 이를 trigger할 수 있습니다.

<a id="loan-details.actions:borrower"></a>

#### 내가 borrower인 경우

- **Repay** — full 또는 partial. Partial repayment는 outstanding을 줄이고
  HF를 개선합니다. Full repayment는 loan을 close하고 Claim을 통해
  collateral을 unlock합니다.
- **Preclose** — loan을 조기 close합니다. Direct path: 지금 wallet에서
  outstanding 전액을 지불합니다. Offset path: collateral 일부를 DEX에서
  팔고 그 proceeds로 repay한 뒤 남은 것을 돌려받습니다.
- **Refinance** — 새 terms의 새 loan으로 갈아탑니다. protocol이 한 번의
  transaction으로 새 principal에서 옛 loan을 갚습니다. collateral은
  vault를 떠나지 않습니다.
- **Claim** — loan이 settle되면 full repayment 시 collateral을 돌려주고,
  default 시에도 surplus가 남을 수 있습니다: collateral은 빚과 그것을
  정리하는 비용에 필요한 만큼만 가져가며, 그보다 많이 맡긴 몫은 내
  claim으로 기록됩니다. 그것이 무엇인지는 경로에 따라 다릅니다 —
  Claim Center 절을 참고하세요.

---

<a id="chapter.allowances"></a>

## Allowances

<a id="allowances.list"></a>

### Allowances

offer를 accept할 때 wallet이 Vaipakam에게 특정 token을 대신 move할 수
있도록 "approve"하는 경우가 있습니다. 일부 wallets는 이런 approvals를
필요 이상으로 오래 남겨 두기도 합니다. 이 페이지는 이 chain에서
Vaipakam에 부여한 모든 approvals를 보여 주고, 원하는 항목을 one click
으로 끌 수 있게 해 줍니다. Non-zero approvals(실제로 live인 것)가 위에
표시됩니다.

clean한 approvals list를 유지하는 것은 좋은 hygiene입니다 — Uniswap이나
1inch에서도 마찬가지입니다.

---

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### Alerts 소개

collateral price가 떨어지면 loan의 safety score(Health Factor)도 함께
떨어집니다. Alerts에 opt in하면 누군가가 liquidate하기 **전에** 미리
알림을 받을 수 있습니다. 작은 off-chain service가 5분마다 loans를
감시하다가 score가 danger band를 넘는 순간 ping합니다. gas 비용은 없고,
on-chain에서는 아무 일도 일어나지 않습니다.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

watcher가 사용하는 danger bands입니다. 더 위험한 band로 들어가면 한
번 fire됩니다. 다음 ping은 더 깊은 band를 다시 넘을 때만 발생합니다.
더 안전한 band로 돌아오면 ladder가 reset됩니다. 기본값은 typical loans에
맞춰져 있습니다. 변동성이 큰 collateral을 넣었다면 thresholds를 더 높게
잡는 것이 좋을 수 있습니다.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

알림이 실제로 어디로 갈지 정합니다. Telegram(bot DM), Push Protocol
(wallet direct notification), 또는 둘 다 선택할 수 있습니다. 두 rails는
위의 같은 threshold ladder를 공유합니다 — 따로 tune하지 않습니다.

---

<a id="chapter.nft-verifier"></a>

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### NFT 검증

Vaipakam의 position NFTs는 가끔 secondary markets에 등장합니다. 다른
holder에게서 사기 전에 NFT contract address와 token ID를 여기에 붙여
넣으세요. verifier는 (a) 정말 Vaipakam이 mint한 것인지, (b) underlying
loan이 어느 chain에 있는지, (c) 그 loan이 어떤 state인지, (d) NFT를
현재 누가 on-chain에서 보유하는지 확인합니다.

position NFT _자체_ 가 loan에서 claim할 권리입니다. fake이거나 이미
settled된 position을 알아차리면 나쁜 trade를 피할 수 있습니다.

---

<a id="chapter.keeper-settings"></a>

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers 소개

"keeper"는 내 loans에서 특정 maintenance actions를 대신 수행하도록
trust한 wallet입니다 — early withdrawal 완료, refinance finalise 같은
작업입니다. keeper는 내 돈을 사용할 수 없습니다 — repay, add collateral,
claim, liquidate는 모두 user-only입니다. 최대 5 keepers까지 approve할
수 있고, master switch를 언제든 off로 바꿔 모두 한 번에 disable할 수
있습니다.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

list의 각 keeper는 **내가 check한 actions만** 수행할 수 있습니다.
따라서 "complete early withdrawal"만 허용된 keeper는 내 대신 새로
시작할 수 없고 — 내가 시작한 것을 끝낼 수만 있습니다. 마음이 바뀌면
checks를 수정하세요. keeper를 완전히 없애고 싶다면 list에서 remove하면
됩니다.

---

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics 소개

한 네트워크에서 프로토콜을 지갑 없이 볼 수 있는 화면입니다. 대상
네트워크는 앱이 읽고 있는 네트워크입니다. 아무것도 연결할 필요가
없습니다. 페이지는 두 가지 공개 출처를 사용하고 각 수치가 어디에서
왔는지 밝힙니다. 키 없이 누구나 조회할 수 있는 공개 인덱서와
플랫폼 컨트랙트 자체입니다. 그래서 어떤 수치도 그냥 믿을 필요가
없습니다.

<a id="public-dashboard.loans-offers"></a>

### 대출과 오퍼

상태별 대출 건수(활성, 상환, 연체, 청산 등)와 상태별 오퍼 건수로,
공개 인덱서에서 가져옵니다. 인덱서가 보고하지 않은 건수는 "보고되지
않음"으로 표시되며 0으로 표시되지 않습니다. 온체인 오퍼만 셉니다.
가스 없는 서명 주문은 Offer Book에는 보이지만 여기서는 세지
않습니다. 오퍼 합계는 현재 기록된 오퍼이며, 누적 건수가 아닙니다.

<a id="public-dashboard.recycling"></a>

### 리사이클링 계정과 루프 클로저

매일의 리워드 풀이 어디에서 왔고 그중 얼마가 인출되었는지, 그리고
클레임으로 지급된 리워드 VPFI 중 얼마가 플랫폼 안에 남는지를
보여줍니다. 공개 인덱서의 장부 기록입니다. 아직 알 수 없는 수치는
0을 표시하지 않고 그 사실을 알려줍니다.

<a id="public-dashboard.transparency"></a>

### 투명성과 출처

플랫폼 컨트랙트 주소(블록 익스플로러에서 여는 링크 포함), 네트워크,
인덱서가 마지막으로 읽은 블록과 그 시점이 얼마나 지났는지입니다.
인덱서의 수치는 그 블록 시점까지만 최신이므로 경과 시간을
표시합니다.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI 토큰

인덱서가 아니라 플랫폼 컨트랙트에서 직접 읽습니다. VPFI 토큰의
주소와 이 네트워크의 공급량입니다. VPFI가 발행되는 네트워크에서는
공급 상한, 상한 내에서 아직 발행할 수 있는 양, 발행이 허용된 유일한
주소도 보여줍니다. 브리지로 VPFI가 들어오는 네트워크에서는 그
네트워크의 공급량만 보여줍니다.

<a id="public-dashboard.fees"></a>

### 수수료와 트레저리

이것도 컨트랙트에서 읽습니다. 기록 시작 이후, 최근 하루, 최근
일주일 동안 프로토콜이 기록한 수수료와 수수료가 가는 트레저리
주소입니다. 페이지는 읽은 블록, 그 읽기의 경과 시간, 호출한
함수를 밝히고, 수수료 수치가 실제 징수액보다 적을 수 있는 모든
이유를 적어 둡니다. 기준 통화가 바뀐 뒤에는 이전 수수료가 옛
단위로 남아 합계가 어느 방향으로든 어긋날 수 있으며, 페이지는
이것도 밝힙니다. 읽을 수 없었던 수치는 0을 표시하지 않고 그
사실을 알려줍니다.

---

<a id="chapter.refinance"></a>

## Refinance

이 페이지는 borrower 전용입니다 — refinance는 borrower가 자신의 loan에서
시작합니다.

<a id="refinance.overview"></a>

### Refinancing 소개

Refinancing은 collateral을 건드리지 않고 기존 loan을 새 loan으로
갈아타는 흐름입니다. 새 terms로 borrower-side offer를 게시합니다.
lender가 accept하면 protocol이 한 번의 transaction에서 옛 loan을 갚고
새 loan을 open합니다. collateral이 보호 없이 노출되는 순간은 없습니다.

<a id="refinance.position-summary"></a>

### 내 현재 포지션

refinance하는 loan의 snapshot입니다 — outstanding, accrued interest,
health, lock된 collateral. 이 numbers를 참고해 새 offer size를
합리적으로 정하세요.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — 새 offer 게시

refinance에 원하는 asset, amount, rate, duration으로 borrower offer를
게시합니다. listed되어 있는 동안에도 옛 loan은 정상적으로 계속
진행됩니다 — interest는 계속 accrue되고, collateral은 그대로 있습니다.
다른 users는 이 offer를 Offer Book에서 볼 수 있습니다.

<a id="refinance.step-2-complete"></a>

### Step 2 — 완료

lender가 refinance offer를 accept하면 Complete를 클릭합니다. protocol은
atomically 하게 새 principal로 옛 loan을 갚고, 새 loan을 open하며, 그
동안 collateral을 계속 lock해 둡니다. one transaction, two-state change,
exposure window 없음입니다.

---

<a id="chapter.preclose"></a>

## Preclose

이 페이지는 borrower 전용입니다 — preclose는 borrower가 자신의 loan에서
시작합니다.

<a id="preclose.overview"></a>

### Preclose 소개

Preclose는 "내 loan을 일찍 close하기"입니다. 두 가지 paths가 있습니다:

- **Direct** — 지금 wallet에서 outstanding balance 전액을 지불합니다.
- **Offset** — DEX에서 collateral 일부를 팔고, 그 proceeds로 loan을
  갚습니다. 남은 것은 돌려받습니다.

cash가 있다면 Direct가 더 저렴합니다. cash는 없지만 loan도 더 이상
유지하고 싶지 않을 때는 Offset이 선택지입니다.

<a id="preclose.position-summary"></a>

### 내 현재 포지션

조기 close할 loan의 snapshot입니다 — outstanding, accrued interest,
current health. 조기 close는 fee-fair입니다 — flat penalty는 없고,
protocol의 time-weighted VPFI math가 accounting을 처리합니다.

<a id="preclose.in-progress"></a>

### Offset In Progress

방금 offset preclose를 시작했고 swap step이 mid-flight 상태입니다.
complete하면 proceeds가 loan을 settle하고 나머지는 내게 돌아옵니다.
가격이 생각하는 사이 움직였다면 cancel하고 fresh quote로 다시 시도할
수 있습니다.

<a id="preclose.choose-path"></a>

### 경로 선택

지금 loan을 갚을 cash가 있다면 **Direct**를 선택하세요. exit하면서
collateral 일부를 팔고 싶다면 **Offset**을 선택하세요. 어느 path든
loan은 완전히 close됩니다. preclose에서는 half-close가 불가능합니다.

---

<a id="chapter.early-withdrawal-lender"></a>

## Early Withdrawal (Lender)

이 페이지는 lender 전용입니다 — early withdrawal은 lender가 자신의
loan에서 시작합니다.

<a id="early-withdrawal.overview"></a>

### Lender Early Exit 소개

duration이 끝나기 전에 loan에서 exit하고 싶다면 protocol을 통해 lender
NFT를 sale listing할 수 있습니다. buyer가 그것을 사면 loan의 내 side를
이어받습니다 — buyer가 최종 repayment + interest를 collect합니다. 나는
받은 payment를 가지고 exit합니다.

<a id="early-withdrawal.position-summary"></a>

### 내 현재 포지션

exit하려는 loan의 snapshot입니다 — principal, 지금까지 accrued된
interest, 남은 시간, borrower의 current health score. buyer가 내 NFT의
value를 판단할 때 보는 numbers입니다.

<a id="early-withdrawal.initiate-sale"></a>

### 판매 시작

asking price를 설정하면 protocol이 lender NFT를 list하고 buyer를
기다립니다. buyer가 accept하면 proceeds가 wallet에 도착하고 loan은
계속됩니다 — 다만 나는 더 이상 그 side에 있지 않습니다. listing이
open 상태이고 unfilled인 동안에는 cancel할 수 있습니다.

<a id="chapter.next-app"></a>

## 다음 앱

Vaipakam 앱의 다음 버전은 현재 앱과 나란히 한 페이지씩 만들어지고
있습니다. 아직 만들어지지 않은 페이지는 그렇다고 알려 주고, 그
페이지를 계속 제공하는 현재 앱으로 안내합니다. 이 장에서는 이미
만들어진 페이지를 설명합니다.

<a id="advanced-mode"></a>

### Basic과 Advanced

Basic은 대부분의 사람에게 필요한 것을 보여 줍니다. Advanced는
exit 및 정산 도구, 자동화, 서명된 주문, keeper 상태, 회계 세부
정보를 더합니다. 모드를 바꿔도 당신이 해야 하는 동의, 당신을 막고
있는 것, 그것을 해결하는 방법은 절대 숨겨지지 않습니다. 설명하는 문장 바로 뒤의 모든 정보 버튼 (i)은
전체 설명을 열고, 그 안의 "더 읽기" 링크는 지금
사용하는 모드로 이 가이드를 엽니다.

<a id="wallet"></a>

### 당신의 wallet과 숫자의 출처

앱은 당신의 loan, vault, claim을 먼저 wallet 자체의 네트워크
연결을 통해 읽습니다. wallet이 연결을 제공하지 않을 때만 읽기
전용 프록시를 사용합니다. 당신의 숫자는 절대 공유 인덱스에서
가져오지 않습니다. 위쪽에 표시된 주소와 네트워크가 페이지의 모든
숫자가 속한 곳입니다. wallet이 앱이 지원하지 않는 네트워크에
있으면, 전환할 때까지 당신의 것은 아무것도 표시되지 않습니다.

<a id="deployments"></a>

### 배포가 지원하는 기능

앱은 어떤 작업을 제시하기 전에, 당신의 네트워크에 있는 프로토콜
contract가 지금 어떤 기능을 지원하는지 읽습니다. 업그레이드로 이
목록이 바뀔 수 있으며, 이를 읽기 때문에 앱은 실패하는 대신 무엇이
바뀌었는지 알려 줄 수 있습니다. 목록을 읽을 수 없으면 서명 단계는
제시되지 않습니다.

<a id="home-start"></a>

### Home: 할 일 고르기

Home은 "하고 싶은 일…"로 시작합니다. 빌리기, 빌려주기, NFT
대여하기, 내 NFT 대여해 주기, 가진 것 관리하기 중에서 고릅니다.
각 선택은 안내 페이지를 엽니다. 빌리기와 빌려주기는 먼저 맞는
오퍼를 보여 주고, 맞는 것이 없으면 직접 오퍼를 올리게 해 줍니다.
대여는 양쪽을 모두 다룹니다. 다른 사람의 NFT를 쓰거나, vault에
그대로 둔 채 다른 사람이 내 NFT를 쓰게 할 수 있습니다. wallet을
연결하면 Home에 숨길 수 있는 짧은 시작 카드 세 장도 표시됩니다.

<a id="home-status"></a>

### Home: 프로토콜 상태

Home은 당신의 네트워크에서 프로토콜이 작동 중인지 항상 알려
줍니다. 사고로 일시 중지된 동안에는 새 포지션, claim, 출금, 청산,
디폴트, keeper 단계가 멈춥니다. 전액 상환, 부분 상환, 담보 추가는
계속 가능하며, 중지된 시간은 열린 모든 loan의 만기일에 더해집니다.
자동 중지는 정해진 시간 동안만 지속되고, 새 자동 중지는 쿨다운
이후에만 시작할 수 있습니다. keeper 서비스는 따로 중지될 수
있지만, 그것이 당신이 직접 하는 일을 막지는 않습니다. 상태를 읽을
수 없으면 Home은 작동 중이라고 가정하지 않고 위쪽에 그렇게
표시합니다.

<a id="home-payouts"></a>

### Home: 수령 준비 완료

loan이 끝났고 지금 claim하면 지급을 받을 수 있을 때 수령 준비가
된 것입니다. 대출자에게는 상환금, 차입자에게는 돌려받는 담보(또는
남은 부분), 대여가 끝나면 돌아오는 NFT입니다. Home은 이를 가장
먼저 보여 주고 Claims로 안내하며, Claims에서는 수령 전에 모든
금액을 보여 줍니다.

<a id="home-loans"></a>

### Home: 내 loan

진행 중인 각 loan은 당신의 입장, 조건, 담보, 다음 기한을 가장
급한 것부터 보여 줍니다. loan은 만기일에 상환 기한이 됩니다. 그
뒤에 유예 기간이 이어지며, 이 기간에는 차입자가 연체료를 내고
여전히 상환할 수 있습니다. 유예 기간이 끝나면 누구나 디폴트를
시작할 수 있고, loan은 담보로 정산됩니다. health factor는 담보의
가치와 부채를 비교한 값으로, 1 아래로 떨어지면 loan이 청산될 수
있습니다. 가격이 없는 자산의 loan에는 health factor가 없습니다.
당신의 오퍼에서 열린 loan들은 함께 표시됩니다.

이자를 주기적으로 내는 loan에는 만기일 당일까지 납부 시점도 있습니다. 납부 시점의 유예 기간이 끝났는데도 남은 이자는 담보를 팔아 낼 수 있으며, loan은 계속 열려 있습니다. Home은 다음 납부 시점을 보여 주고, 밀린 것을 맨 앞에 둡니다. 만기일과 같은 날의 납부 시점도 마찬가지인데, 그 유예 기간이 loan의 유예 기간보다 먼저 끝날 수 있기 때문입니다. 프로토콜은 이 정산을 끌 수 있으며, 그러면 Home은 납부 시점에 담보가 팔리지 않는다고 알려 줍니다.

<a id="home-exposure"></a>

### Home: 빌려준 것과 빌린 것

빌려주기와 빌리기를 모두 하고 있으면 Home은 오늘의 가치로 두
쪽을 비교합니다. NFT나 가격이 없는 자산처럼 가치를 매길 수 없는
loan은 개수만 세고 제외하며, 그것들이 답을 바꿀 수 없을 때만 더
큰 쪽을 알려 줍니다.

<a id="home-faucet"></a>

### Home: 테스트 자산

테스트 네트워크에서 Home은 실제 돈 없이 빌리기, 빌려주기, 대여를 해볼 수 있도록 테스트 토큰과 NFT를 제공합니다. 이것들은 가치가 없으며 프로토콜이 아니라 테스트 토큰 컨트랙트가 발행합니다. 일부 테스트 토큰에는 테스트 가격이 있어 그 토큰으로 된 대출에는 건전성 지수가 있고, 가격이 없는 토큰으로 된 대출은 채무 불이행 시 담보 자체가 넘어갑니다. 테스트 NFT는 대여할 수 있습니다. 발행할 때마다 먼저 영수증이 표시되고, 결과는 이후 체인에서 확인됩니다.

<a id="home-fee-discount"></a>

### Home: 수수료 할인

수수료 할인은 지갑 전체에 적용되는 네트워크별 설정 하나입니다. 꺼져 있는 동안에는 VPFI를 얼마나 보유하든 수수료가 할인되지 않습니다. 켜져 있는 동안에는 빌릴 때 내는 수수료와 대출자로서 받는 이자에 붙는 수수료가, 각 수수료가 부과되는 시점의 VPFI 할인 등급에 따라 줄어듭니다. 0등급에서는 할인이 없습니다. 일부 네트워크에서는 대출자 할인이 볼트의 VPFI로 지급되며, 어느 쪽인지는 확인 전에 영수증에 표시됩니다. 켜려면 현재 약관에 동의해야 하지만 끌 때는 그럴 필요가 없습니다. 프로토콜이 일시 중지된 동안에는 어느 방향으로도 바꿀 수 없습니다. 비유동 대출 자산의 대출은 여전히 차입 수수료 전액을 내며, 어떤 할인도 수수료의 절반을 넘지 않습니다.

<a id="home-rewards"></a>

### Home: 리워드

리워드는 이 네트워크에서의 대출과 차입에 대한 이용 리베이트로, 리워드 일 단위로 집계되어 VPFI로 지급됩니다. 앱이 먼저 청구를 미리보기로 실행하므로, Home은 지금 청구하면 지급될 금액을 정확히 보여 줍니다. 미리보기를 실행할 수 없으면 Home은 그 대신 그렇다고 표시한 하한값을 보여 주고, 정확한 금액을 계산할 수 있을 때까지 청구를 제시하지 않습니다. 한 번의 청구는 최대 30 리워드 일을 지급하며, 남은 것이 있으면 Home이 다시 청구하기를 제시합니다. 중간에 멈춰도 안전합니다. 청구는 바로 쓸 수 있는 상태로 볼트에 전달되며, 볼트가 받을 수 없으면 지갑으로 전달됩니다. 청구가 볼트를 새로 여는 일은 없습니다. 어떤 리워드 일이 아직 네트워크 간 확정이나 이 네트워크로의 자금 도착을 기다리고 있으면, Home은 실패할 청구를 제시하는 대신 그날을 알려 줍니다. 리워드는 이자나 수익이 아니며, 청구가 무언가를 스테이킹하거나 재투자하는 일은 없습니다. 가끔 클레임이 아무것도 지급하지 않으면서, 아무것도 지급되지 않은 보상일을 넘어서기도 합니다. 그 뒤의 날을 지급할 수 있게 하기 위해서이며, Home은 그렇다고 알리고 클레임을 그대로 제공합니다.

<a id="home-rewards-expiry"></a>

### Home: 리워드 제거 날짜

청구하지 않은 리워드가 제거될 수 있는 네트워크에서는 Home이 리워드 중 가장 이른 예상 제거 날짜를 보여 주고, 그 전 마지막 90일 동안에는 최종 알림을 보여 줍니다. 그 전에 청구하면 리워드는 항상 유지됩니다. 현재 상태에서 예상 날짜는 실제 날짜보다 늦지 않습니다. 리워드를 청구할 수 없는 시간은 실제 날짜를 뒤로 미루지만, 네트워크의 청구 기간이 바뀌면 앞당겨질 수 있으니 의지하기 전에 다시 확인하세요. 모든 리워드를 확인하지 못했다면 Home은 기한이 없다고 말하는 대신 그렇게 알려 줍니다. 네트워크가 아무것도 제거하지 않는 경우 날짜는 표시되지 않습니다.

<a id="home-rewards-held"></a>

### Home: 보류된 리워드

제재 검사가 지갑에 플래그를 지정하면, 플래그가 유지되는 동안에는 아무것도 지급되지 않습니다. 플래그 이전에 얻은 리워드는 그 지갑을 위해 보류되며, 잠겨 있지만 잃은 것은 아니고, 지갑의 플래그가 해제되면 풀려납니다. 그때 Home은 그 잔액만 정확히 따로 청구하도록 제시합니다. 플래그가 확정된 동안 얻은 리워드는 영구히 몰수되고 볼트의 VPFI는 옮길 수 없습니다. 지갑이 아직 플래그 상태인지 읽을 수 없으면 아무것도 풀려나지 않습니다.

<a id="borrow-start"></a>

### Borrow: 작동 방식

빌리려면 대출자가 올린 열린 오퍼를 수락합니다. 오퍼는 한 토큰의 금액, 이자율, 기간, 그리고 대출자가 요구하는 담보로 이루어집니다. 수락하면 한 번의 트랜잭션으로 대출이 시작됩니다. 담보는 지갑에서 본인의 볼트로 옮겨져 대출이 열려 있는 동안 잠기고, 금액은 소액의 개시 수수료를 뺀 뒤 지갑으로 들어옵니다. 만기일까지 원금과 이자를 상환합니다. 맞는 오퍼가 없으면 직접 차입 요청을 올리고 대출자를 기다릴 수도 있습니다.

<a id="borrow-pair"></a>

### Borrow: 토큰 고르기

먼저 빌릴 것과 잠글 것을 고릅니다. 앱이 네트워크의 토큰을 추천하며, 토큰 주소를 붙여 넣을 수도 있습니다. 토큰 안전성 검사는 하지 않으니 붙여 넣은 주소는 직접 확인하세요. 앱은 각 토큰에 대해 프로토콜이 지금 어떻게 보는지 읽어 옵니다. 유동 토큰은 가격이 있어 대출에 헬스 팩터가 있고, 담보 가치가 떨어지면 청산될 수 있습니다. 비유동 토큰은 가치가 0으로 평가되며, 연체 시 대출자는 담보 자체를 받습니다. 프로토콜이 어떤 토큰의 가격을 신뢰하지 않으면 다시 신뢰할 때까지 그 토큰으로 새 대출이 막힙니다. 이미 열린 대출은 영향을 받지 않습니다.

<a id="borrow-offers"></a>

### Borrow: 오퍼 고르기

페이지는 선택한 두 토큰에 대한 대출자들의 열린 오퍼를 프로토콜에서 직접 읽어 보여 줍니다. 각 오퍼에는 금액, 이자율과 기간, 요구 담보, 오늘 가격 기준 담보인정비율(LTV), 이자 계산 방식, 이자 일정 여부, 오퍼 종료 시점, 수수료를 뺀 수령액이 표시됩니다. 오퍼는 대출자의 전체 금액과 최저 이자율로 통째로 수락됩니다. 프로토콜이 거절할 오퍼는 이유를 표시하고 버튼을 보여 주지 않습니다. 정렬 순서는 편의를 위한 것이며 조언이 아닙니다.

<a id="borrow-review"></a>

### Borrow: 검토와 서명

지갑이 열리기 전에 검토 화면이 모든 숫자를 보여 줍니다. 받을 금액, 수수료, 잠글 담보, 이자율, 만기일에 갚을 금액, 유예 기간, 그리고 잃을 수 있는 것입니다. 위험 고지와 약관에 동의하는 상자에 체크합니다. 확인 전에 숫자가 바뀌면 체크가 해제됩니다. 이어서 지갑이 비용이 들지 않는 조건 서명, 필요하면 담보 금액만큼의 정확한 승인, 그리고 수락 전송을 요청하며, 앱은 전송 전에 모의 실행을 먼저 합니다. 승인 뒤에 멈추면 앱은 승인을 원래대로 돌려 달라고 요청하고 그렇게 되었는지 알려 줍니다. 그 뒤 앱은 열린 대출, 들어온 금액, 잠긴 담보를 체인에서 확인합니다. 대출 기간 동안의 조건도 기본값이더라도 하나씩 표시합니다: 부분 상환, 담보 매각, 그리고 재융자나 연결된 대출 여부입니다. 갚을 금액은 일시 중지가 없다고 가정한 금액입니다: 일시 중지가 있으면 만기일이 그만큼 늦춰지고 그동안에도 이자는 계속 붙습니다.

<a id="borrow-fee"></a>

### Borrow: 개시 수수료

대출을 열면 금액의 작은 비율이 한 번, 빌리는 토큰으로, 받는 금액에서 차감됩니다. 적용 요율은 검토 화면에 표시됩니다. 이자는 전체 금액에 대해 냅니다. 수수료 할인이 켜져 있고 빌리는 토큰이 유동 토큰이면 할인 티어가 수수료를 낮춥니다. 이 수수료를 위해 VPFI를 가져가거나 보관하지 않으며, 나중에 환불되는 것도 없습니다. 수락을 직접 보내므로, 프로토콜이 매칭 제출자에게 지급하는 수수료의 작은 몫이 금액과 함께 돌아옵니다. 검토 화면에 표시됩니다.

<a id="borrow-risks"></a>

### Borrow: 위험

대출로 담보를 잃을 수 있습니다. 유예 기간이 끝날 때까지 상환하지 않으면 대출은 연체 처리되고 대출자는 담보에서 지급받습니다. 프로토콜이 팔 수 있으면 팔아서, 그렇지 않으면 그대로 넘겨서 지급합니다. 유동 담보는 가치가 떨어져 헬스 팩터가 1 아래로 내려가면 누구나 대출을 청산할 수 있고, 담보를 잃게 됩니다. 전체 기간 이자 방식에서는 일찍 갚아도 전체 기간의 이자를 냅니다. 이자 일정이 있으면 놓친 기간은 담보 일부를 팔아 지급합니다. 대출이 상환되거나 정산될 때까지 담보는 잠긴 상태로 남습니다.

<a id="borrow-request"></a>

### Borrow: 직접 요청 올리기

맞는 오퍼가 없으면 두 토큰에 대해 직접 차입 요청을 올릴 수 있습니다. 정확한 금액, 낼 이자율, 기간, 잠글 담보를 정합니다. 게시하면 담보가 지갑에서 내 볼트로 옮겨지고, 요청이 열려 있는 동안 그곳에 남습니다. 대출자가 요청을 받으면 다시 묻지 않고 내 조건으로 바로 대출이 열리며, 금액은 개설 수수료를 뺀 뒤 지갑에 도착합니다. 게시 5분 뒤부터 취소할 수 있고, 담보는 지갑으로 돌아옵니다. 만료된 요청은 더 이상 받을 수 없으며, 담보는 나나 다른 누군가가 닫을 때까지 볼트에 남았다가 내 지갑으로만 돌아갑니다. 다음 앱의 오퍼 페이지가 만들어지기 전까지는 요청을 현재 앱의 오퍼 페이지에서 확인하고 취소하고 닫습니다. 검토 화면은 무엇이든 잠기기 전에 이를 알려 줍니다.

<a id="borrow-request-terms"></a>

### Borrow: 요청의 조건

한 대출자가 금액 전부를 받거나, 아무도 받지 않습니다. 모든 숫자는 입력한 그대로 정확히 읽힙니다. 토큰의 소수 자릿수를 넘는 값은 반올림하지 않고 거부되며, 이자율은 연 100%까지 소수 둘째 자리로 정할 수 있습니다. 고를 수 있는 기간은 네트워크가 허용하는 최장 기간까지이며, 기간을 일 수로 입력할 수도 있습니다. 요청은 받거나 취소될 때까지, 또는 고른 일 수(최대 1년) 동안 열려 있습니다. 보통의 선택인 전체 기간 이자는 일찍 갚아도 모두 내야 하고, 일할 이자는 대출이 열려 있던 기간만큼만 냅니다. 양식에는 지금 대출자가 받는다면 오늘의 수수료율로 받을 금액과 만기일에 갚을 금액이 표시됩니다.

<a id="borrow-request-review"></a>

### Borrow: 요청 검토와 게시

지갑이 열리기 전에 앱은 프로토콜에 요청을 모의 실행하게 하므로, 검토 화면에는 프로토콜 자체의 답이 나옵니다. 지금 잠글 담보, 금액·이자율·기간, 받을 금액과 수수료가 정해지는 방식(대출자가 받는 시점에 적용되는 수수료율에서 그때의 수수료 할인 등급만큼 뺀 값이며, 표시된 금액은 오늘의 요율 기준), 갚을 금액, 대출 기간의 모든 조건, 요청 만료 시점, 담보 대비 대출 비율, 승인이 필요한지가 표시됩니다. 위험 고지와 약관에 동의하는 상자에 체크합니다. 필요하면 지갑이 담보 금액만큼 정확히 승인하고, 앱이 요청을 다시 모의 실행한 뒤에야 게시합니다. 승인 뒤에 멈추면 앱은 승인을 원래대로 돌려 달라고 요청하고 그렇게 되었는지 알려 줍니다. 그 뒤 앱은 기록된 요청과 잠긴 담보를 체인에서 확인합니다.

<a id="borrow-nft-collateral"></a>

### Borrow: NFT를 담보로

요청은 토큰 대신 NFT 하나를 잠글 수 있습니다. 잠글 대상으로 컬렉션을 고르세요(테스트 컬렉션은 NFT로 표시되며, 주소를 붙여 넣을 수도 있습니다). 주소가 토큰인지 NFT 컬렉션인지는 그 컨트랙트에서 읽습니다. 그런 다음 NFT의 번호, 즉 토큰 ID를 입력하세요. 지갑이나 컬렉션 페이지에 표시됩니다. 양식은 지갑이 그 NFT를 보유하는지 바로 알려 줍니다. 프로토콜은 NFT를 다른 곳에서의 가격과 관계없이 0으로 평가합니다. NFT를 담보로 한 대출에는 LTV도 가격 기반 청산도 없으며, 유예 기간이 끝날 때까지 상환하지 않으면 대출자가 그 NFT 자체를 받습니다. 게시할 때 지갑은 프로토콜에 그 NFT 하나만 승인하며, 컬렉션의 나머지는 결코 승인하지 않습니다. NFT를 금고로 옮기면 그 승인은 저절로 사라집니다. 승인 후 요청이 멈추면 앱은 승인을 되돌리도록 요청하고 되돌려졌는지 알려 줍니다. 수량으로 발행되는 NFT(멀티 토큰 컬렉션)도 수량과 함께 같은 방식으로 작동합니다. 토큰 번호와 잠글 수량을 입력하면 양식이 지갑의 보유 수량을 알려 줍니다. 이런 컬렉션은 토큰 하나만 승인할 수 없고 그 안의 모든 토큰만 승인할 수 있으므로, 게시할 때 이 요청만을 위해 승인을 주고, 요청이 성사되었든 아니든 그 뒤 지갑 단계 하나를 더 거쳐 승인을 거둡니다. 이미 주었던 승인은 설정한 그대로 둡니다. NFT를 요구하는 대출자 오퍼를 받는 것은 당분간 여전히 현재 앱에서 합니다.

<a id="borrow-request-range"></a>

### Borrow: 금액 범위 (고급)

고급 모드에서는 요청에 범위를 둘 수 있습니다. 대출자가 빌려줄 수 있는 최소 금액과 최대 금액을 하나의 이자율로 정하고, 원하면 가장 작은 대출을 위한 더 적은 담보를 정할 수 있습니다. 요청을 직접 수락하는 대출자는 최소 금액을 빌려주고 그에 정한 담보만 잠그며, 나머지는 지갑으로 돌아갑니다. 네트워크에서 매칭이 켜져 있는 동안에는 매칭이 최대 금액까지 더 많이 빌려줄 수 있습니다. 검토 화면은 켜져 있는지와, 꺼져 있는 동안에는 범위가 한 번만 채워진다는 점을 알려 줍니다. 프로토콜은 오늘 가격으로 담보가 감당하지 못하는 최대 금액을 거부하며, 검토 화면은 감당할 수 있는 최대치를 보여 줍니다. 검토 화면은 양쪽 끝의 LTV를 보여 주고, 오늘 가격으로 대출자가 요청을 직접 수락할 수 없으면 경고합니다. 고급 모드에서 정한 옵션은 기본 모드로 바꿔도 계속 적용되며, 양식이 이를 알리고 지울 수 있게 합니다. 매칭은 그 대출자가 요구하는 담보만 잠그며, 최소한 하한만큼은 잠급니다. 그래서 검토 화면은 가장 큰 매칭을 담보 전체부터 하한만 있는 경우까지 보여 주고, 매칭된 대출이 직접 수락보다 더 위험하게 시작될 수 있다고 경고합니다.

<a id="borrow-request-fill"></a>

### Borrow: 요청이 채워지는 방식 (고급)

기본값인 부분 체결은 요청이 채워지거나 취소되거나 만료될 때까지 매칭이 하나 이상의 대출로 요청을 채우게 합니다. 전부 아니면 전무는 전체 금액의 한 번 체결만 허용하므로 범위와 함께 쓸 수 없습니다. 즉시 또는 취소는 부분 체결처럼 채우지만 요청이 만료될 때까지만이므로 만료 기한이 필요합니다. 범위와 체결 방식은 게시 후 바꿀 수 없으며, 바꾸려면 요청을 취소하고 새로 게시하세요.

<a id="risk-access"></a>

### Risk Access: 내 위험 등급

모든 계정은 가장 낮은 위험 등급인 블루칩 자산 전용에서 시작하며, 이를 올릴 수 있는 사람은 본인뿐입니다. 한 쌍에는 더 위험한 토큰의 등급이 필요합니다. 블루칩 토큰은 아무것도 필요 없고, 다른 유동성 토큰은 “유동성 자산”, 비유동성 토큰은 “비유동성을 포함한 모든 자산”과 함께 바로 그 쌍에 대한 본인의 동의가 필요합니다. 오퍼 수락이나 요청 게시에 이런 단계가 필요하면, 검토 화면이 그 자리에서 알려 주고 자체 영수증과 함께 한 번의 지갑 확인으로 제시합니다. 무엇이 바뀌는지, 어떤 쌍에 적용되는지, 언제 효력이 생기는지, 자금은 움직이지 않는다는 것입니다. 등급을 올리거나 쌍에 동의하면 프로토콜이 정한 대기 기간이 있을 수 있습니다. 올린 등급에 대해서는 앱이 체인에서 읽은 효력 발생 시각을 보여 주고, 동의에 대해서는 프로토콜이 그 시각을 아직 공개하지 않는다고 알리며, 같은 단계를 두 번 제시하지 않습니다. 두 번째 단계는 대기를 다시 시작하게 하기 때문입니다. 등급 낮추기는 언제나 즉시 효력이 있습니다. 프로토콜이 새 위험 약관을 공개하면, 다시 확인할 때까지 등급과 동의는 인정되지 않습니다. 엄격 모드를 켰다면 유동성 쌍마다 본인의 확인도 필요합니다. 대출자 본인의 위험 등급 때문에 생긴 차단은 대출자의 것으로 표시됩니다. 내 계정에서 바꿀 수 있는 것은 없습니다.

<a id="terms-gate"></a>

### 이용약관 확인

이용약관 버전이 시행 중이면, 앱은 수수료 할인을 켜는 것처럼 새로운 것을 시작하는 작업 전에 약관 동의를 요청하고 어떤 작업이 요청했는지 알려 줍니다. 버전, 본문의 지문, 그리고 본문이 절대 바뀌지 않는 바로 그 버전으로의 링크를 보여 줍니다. 동의는 지갑에서 한 번 확인하는 것이며 자금은 움직이지 않습니다. 동의 여부를 읽을 수 없으면 앱은 그렇다고 알리고 다시 시도하게 하며, 이를 거부로 취급하지 않습니다. 상환, 청구, 내 자산 출금, 내 오퍼 취소, 동의 끄기는 절대 막히지 않습니다.
