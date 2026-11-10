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

<a id="alerts-inbox"></a>

### 알림 받은편지함

알림 페이지는 프로토콜의 인덱스가 지금 사용 중인 네트워크에서 내 지갑을 위해 보관하는 알림을 최신순으로 보여 줍니다. 무료이며 가입할 것도 없습니다. 대출이 시작될 때, 일부 또는 전액 상환될 때, 채무 불이행이 되거나 청산될 때, 만기가 다가올 때, 유예 기간에 들어가거나 끝날 때, 건전성이 1.5, 1.2 또는 1.05 아래로 떨어질 때, 그리고 보상 항목의 청구 기한이 다가오거나 지났을 때 알림이 기록됩니다. 각 알림은 체인에서 다시 읽는 대출 페이지를 열거나, 보상이면 Claims를 엽니다. 상단 지갑 옆의 종 아이콘은 이 브라우저에서 마지막으로 페이지를 연 뒤 도착한 알림 수를 셉니다. 인덱스를 읽을 수 없으면 빈 받은편지함 대신 그렇다고 알려 줍니다. 텔레그램, 푸시, 건전성 경고와 상환 알림은 받은편지함 바로 아래에서 설정합니다. 각 알림은 작성된 시점의 상황을 알려 줍니다. 지금 상태는 대출을 열어 확인하세요.

<a id="alerts-channels"></a>

### 텔레그램, 푸시, 경고

받은편지함 아래에서 알림 페이지는 앱 밖에서 받는 알림을 설정합니다. 모든 변경은 지갑에서 하는 무료 서명이며 거래가 아닙니다. 텔레그램을 연결하려면 텔레그램 연결을 누르고, 일회용 코드를 10분 안에 Vaipakam 봇에 보낸 뒤 테스트 알림을 보내세요. 그 메시지가 채팅에 도착하면 연결이 작동하는 것입니다. 푸시는 알림 서비스가 지금 보낼 수 있다고 답할 때만 제공됩니다. 푸시 앱에서 Vaipakam 채널도 구독해야 하며, 멈추려면 그곳에서 구독을 해지합니다. 텔레그램이나 푸시를 설정하면 건전성 경고는 건전성 1.5, 1.2, 1.05에서 항상 켜져 있습니다. 상환 알림은 끄고 켤 수 있습니다. 페이지는 이 브라우저에서 한 일을 보여 주며, 다른 기기에서 한 연결이나 설정이 있을 수 있습니다.

<a id="alerts-paid-push"></a>

### 유료 푸시 알림

일부 네트워크에서는 알림 서비스가 대출에 관한 푸시 알림에 VPFI로 소액 수수료를 받습니다. 먼저 온체인에서 동의한 경우에만, 동의한 최대 금액까지만 수수료를 받을 수 있습니다. 유료 푸시 알림 섹션에는 이 네트워크의 수수료와 이곳에서 서비스가 수수료를 받는지가 표시됩니다. 수수료는 금고의 자유 VPFI에서, 대출의 각 측마다 최대 한 번, 그 대출에 관한 첫 유료 푸시 알림이 보내질 때 빠져나갑니다. 이미 받은 수수료는 환불되지 않으며, 텔레그램 알림은 무료입니다. 한도 안에서 수수료가 오르면 다시 묻지 않고 적용됩니다. 동의는 언제든 철회할 수 있습니다.

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
있으면, 전환할 때까지 당신의 것은 아무것도 표시되지 않습니다. 위쪽의 주소를 선택하면 전체 주소를 보고, 복사하고, 앱이 지원하는 다른 network로 전환하거나 연결을 끊을 수 있습니다. 앱은 Ethereum mainnet에서 아무것도 읽지 않으므로 네임 서비스 이름이 아닌 주소 자체를 보여 줍니다.

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

선택한 각 토큰에는 두 개의 공개 토큰 목록에 따른 시가총액 순위도 표시됩니다. 일치 여부는 네트워크상의 토큰 컨트랙트 주소로 판단하며, 이름으로는 절대 판단하지 않습니다. 블루칩은 상위 20위 안에 있고 프로토콜이 가격을 매기는 토큰이며, 그다음이 상위 100, 200, 300, 500위입니다. 상위 500위 밖의 토큰은 본인 책임으로 사용하는 것으로 표시됩니다. 순위에 든 토큰의 이름이나 심볼을 다른 주소에서 쓰는 토큰은 진짜 토큰의 주소와 함께 '복제 가능성'으로 표시되고, 두 목록이 토큰의 위치에 대해 서로 다르면 '미확인'으로 표시됩니다. 목록의 날짜가 표시되며, 갱신에 실패한 경우 그 사실도 알려 줍니다. 테스트 네트워크에서는 토큰에 시장 가치도 순위도 없습니다. 토큰을 찾으려면 '다른 토큰' 칸에 이름이나 심볼을 입력하세요. 순위에 든 토큰이 먼저 나오며 각각 등급과 전체 주소가 함께 표시되고, 하나를 고르면 주소가 채워집니다. 이름이 아니라 주소를 확인하세요. 등급은 참고용일 뿐이며 프로토콜이 하는 일은 아무것도 바꾸지 않습니다.

<a id="borrow-offers"></a>

### Borrow: 오퍼 고르기

페이지는 선택한 두 토큰에 대한 대출자들의 열린 오퍼를 프로토콜에서 직접 읽어 보여 줍니다. 각 오퍼에는 금액, 이자율과 기간, 요구 담보, 오늘 가격 기준 담보인정비율(LTV), 이자 계산 방식, 이자 일정 여부, 오퍼 종료 시점, 수수료를 뺀 수령액이 표시됩니다. 오퍼는 대출자의 전체 금액과 최저 이자율로 통째로 수락됩니다. 프로토콜이 거절할 오퍼는 이유를 표시하고 버튼을 보여 주지 않습니다. 정렬 순서는 편의를 위한 것이며 조언이 아닙니다.

페이지는 먼저 빌리는 두 가지 방법을 알려 줍니다. 지금 오퍼를 받거나, 요청으로 직접 금리를 정하고 대출자를 기다리는 것입니다. 오퍼는 금리별로 묶여 가장 낮은 금리가 먼저 나오며, 각 단계는 오퍼가 몇 개인지와 각 오퍼의 금액을 보여 줍니다. 오퍼는 하나를 통째로 받으므로 금액을 합산하지 않습니다. 받아들일 최고 금리를 입력할 수 있으며, 이는 오퍼를 숨기기만 하고 몇 개를 숨겼는지 알려 줍니다. 요청 옆에는 이 쌍을 위해 대기 중인 대출자가 표시됩니다. 매칭 서비스는 요청 조건이 대출자의 한도에 맞을 때 그 자금으로 요청을 채우므로, 채워질 가능성은 높지만 즉시도 보장도 아닙니다. 이 네트워크에서 이 대출자들과의 매칭이 꺼져 있으면 페이지가 대신 그렇게 알리고, 그 상태를 읽을 수 없으면 요청이 체결될지 알 수 없다고 알립니다. 본인의 상시 오퍼는 절대 집계되지 않습니다. 상시 대출자는 전체 기간의 이자를 부과하고 부분 상환을 받지 않는 요청만 체결합니다. 요청 양식에서 이를 배제하는 선택을 하면 그렇게 알려 줍니다. 프로토콜이 이 네트워크의 모든 키퍼를 일시 중지했다면, 페이지는 재개될 때까지 매칭 서비스가 요청을 체결하지 않는다고 알립니다. 다만 대출자는 여전히 자신의 상시 오퍼로 요청을 체결할 수 있습니다. 상시 대출자는 일정에 따라 이자를 내는 요청도 체결하지 않습니다. 자신이 고른 체결자에게만 체결을 허용하는 대출자는 체결 가능성 없이 따로 표시됩니다. 매칭 서비스가 그중 하나인지 알 수 없기 때문입니다. 프로토콜이 일시 중지된 동안에는 재개될 때까지 어떤 요청도 게시되거나 체결되지 않는다고 페이지에 표시됩니다.

<a id="borrow-review"></a>

### Borrow: 검토와 서명

지갑이 열리기 전에 검토 화면이 모든 숫자를 보여 줍니다. 받을 금액, 수수료, 잠글 담보, 이자율, 만기일에 갚을 금액, 유예 기간, 그리고 잃을 수 있는 것입니다. 위험 고지와 약관에 동의하는 상자에 체크합니다. 확인 전에 숫자가 바뀌면 체크가 해제됩니다. 이어서 지갑이 비용이 들지 않는 조건 서명, 필요하면 담보 금액만큼의 정확한 승인, 그리고 수락 전송을 요청하며, 앱은 전송 전에 모의 실행을 먼저 합니다. 승인 뒤에 멈추면 앱은 승인을 원래대로 돌려 달라고 요청하고 그렇게 되었는지 알려 줍니다. 그 뒤 앱은 열린 대출, 들어온 금액, 잠긴 담보를 체인에서 확인합니다. 대출 기간 동안의 조건도 기본값이더라도 하나씩 표시합니다: 부분 상환, 담보 매각, 그리고 재융자나 연결된 대출 여부입니다. 갚을 금액은 일시 중지가 없다고 가정한 금액입니다: 일시 중지가 있으면 만기일이 그만큼 늦춰지고 그동안에도 이자는 계속 붙습니다. 검토 화면에는 프로토콜이 지금 금액과 담보를 얼마로 평가하는지도 표시됩니다. 이 수치는 참고용이며 가격에 따라 바뀝니다.

<a id="borrow-fee"></a>

### Borrow: 개시 수수료

대출을 열면 금액의 작은 비율이 한 번, 빌리는 토큰으로, 받는 금액에서 차감됩니다. 적용 요율은 검토 화면에 표시됩니다. 이자는 전체 금액에 대해 냅니다. 수수료 할인이 켜져 있고 빌리는 토큰이 유동 토큰이면 할인 티어가 수수료를 낮춥니다. 이 수수료를 위해 VPFI를 가져가거나 보관하지 않으며, 나중에 환불되는 것도 없습니다. 수락을 직접 보내므로, 프로토콜이 매칭 제출자에게 지급하는 수수료의 작은 몫이 금액과 함께 돌아옵니다. 검토 화면에 표시됩니다.

<a id="borrow-risks"></a>

### Borrow: 위험

대출로 담보를 잃을 수 있습니다. 유예 기간이 끝날 때까지 상환하지 않으면 대출은 연체 처리되고 대출자는 담보에서 지급받습니다. 프로토콜이 팔 수 있으면 팔아서, 그렇지 않으면 그대로 넘겨서 지급합니다. 유동 담보는 가치가 떨어져 헬스 팩터가 1 아래로 내려가면 누구나 대출을 청산할 수 있고, 담보를 잃게 됩니다. 전체 기간 이자 방식에서는 일찍 갚아도 전체 기간의 이자를 냅니다. 이자 일정이 있으면 놓친 기간은 담보 일부를 팔아 지급합니다. 대출이 상환되거나 정산될 때까지 담보는 잠긴 상태로 남습니다.

<a id="borrow-request"></a>

### Borrow: 직접 요청 올리기

맞는 오퍼가 없으면 두 토큰에 대해 직접 차입 요청을 올릴 수 있습니다. 정확한 금액, 낼 이자율, 기간, 잠글 담보를 정합니다. 게시하면 담보가 지갑에서 내 볼트로 옮겨지고, 요청이 열려 있는 동안 그곳에 남습니다. 대출자가 요청을 받으면 다시 묻지 않고 내 조건으로 바로 대출이 열리며, 금액은 개설 수수료를 뺀 뒤 지갑에 도착합니다. 게시 5분 뒤부터 취소할 수 있고, 담보는 지갑으로 돌아옵니다. 만료된 요청은 더 이상 받을 수 없으며, 담보는 나나 다른 누군가가 닫을 때까지 볼트에 남았다가 내 지갑으로만 돌아갑니다. 다음 앱의 오퍼 페이지가 만들어지기 전까지는 요청을 현재 앱의 오퍼 페이지에서 확인하고 취소하고 닫습니다. 검토 화면은 무엇이든 잠기기 전에 이를 알려 줍니다. 입력한 각 금액 아래에 프로토콜이 지금 그 금액을 자체 단위로 얼마로 평가하는지 표시합니다. 가격이 없는 자산은 숫자 대신 그 사실을 알려 줍니다.

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

고급 모드에서는 요청에 범위를 둘 수 있습니다. 대출자가 빌려줄 수 있는 최소 금액과 최대 금액을 하나의 이자율로 정하고, 원하면 가장 작은 대출을 위한 더 적은 담보를 정할 수 있습니다. 요청을 직접 수락하는 대출자는 최소 금액을 빌려주고 그에 정한 담보만 잠그며, 나머지는 지갑으로 돌아갑니다. 네트워크에서 매칭이 켜져 있는 동안에는 매칭이 최대 금액까지 더 많이 빌려줄 수 있습니다. 검토 화면은 켜져 있는지와, 꺼져 있는 동안에는 범위가 한 번만 채워진다는 점을 알려 줍니다. 프로토콜은 오늘 가격으로 담보가 감당하지 못하는 최대 금액을 거부하며, 검토 화면은 감당할 수 있는 최대치를 보여 줍니다. 검토 화면은 양쪽 끝의 LTV를 보여 주고, 오늘 가격으로 대출자가 요청을 직접 수락할 수 없으면 경고합니다. 고급 모드에서 정한 옵션은 기본 모드로 바꿔도 계속 적용되며, 양식이 이를 알리고 지울 수 있게 합니다. 매칭은 그 대출자가 요구하는 담보만 잠그며, 최소한 하한만큼은 잠급니다. 그래서 검토 화면은 가장 큰 매칭을 담보 전체부터 하한만 있는 경우까지 보여 주고, 매칭된 대출이 직접 수락보다 더 위험하게 시작될 수 있다고 경고합니다. 매칭이 켜져 있는 동안 매칭이 잠그지 않은 담보는 이후 매칭을 위해 요청에 남으며, 요청이 닫히거나 취소할 때에만 지갑으로 돌아옵니다.

<a id="borrow-request-fill"></a>

### Borrow: 요청이 채워지는 방식 (고급)

기본값인 부분 체결은 요청이 채워지거나 취소되거나 만료될 때까지 매칭이 하나 이상의 대출로 요청을 채우게 합니다. 전부 아니면 전무는 전체 금액의 한 번 체결만 허용하므로 범위와 함께 쓸 수 없습니다. 즉시 또는 취소는 부분 체결처럼 채우지만 요청이 만료될 때까지만이므로 만료 기한이 필요합니다. 체결 방식은 게시 후 바꿀 수 없으며, 바꾸려면 요청을 취소하고 새로 게시하세요. 프로토콜은 요청이 열려 있는 동안 매칭이 이미 사용한 만큼 아래로는 내리지 않는 선에서 금액, 이자율, 담보를 바꿀 수 있게 하지만, 이 앱은 아직 이를 제공하지 않으므로 지금은 변경하려면 취소하고 다시 게시해야 합니다.

<a id="borrow-request-cadence"></a>

### Borrow: 이자 지급 일정 (고급)

고급 모드에서는 요청의 이자를 상환 시 한꺼번에 내는 대신 매월, 분기마다, 6개월마다 또는 매년 일정에 따라 낼 수 있습니다. 양식은 프로토콜이 당신의 조건에 허용하는 일정만 제시하고, 닫힌 일정마다 그 이유를 보여 줍니다. 이유는 네트워크에서 정기 이자가 꺼져 있거나, 자산에 가격이 없거나, 대출 가치가 프로토콜의 기준보다 낮거나(두 수치를 모두 표시), 기간이 대출보다 짧지 않은 경우입니다. 검토 화면에는 각 기간의 이자와 미납 기간에 주어지는 유예 기간이 표시됩니다. 유예 기간이 끝날 때까지 기간 이자가 지급되지 않으면 누구나 당신의 담보 일부를 팔아 그 이자를 낼 수 있으며, 대출은 계속 유지됩니다. 일정은 게시 후 바꿀 수 없습니다. 다른 고급 옵션과 마찬가지로 기본 모드로 전환해도 계속 적용되며, 양식에 그렇게 표시됩니다.

<a id="borrow-request-tariff"></a>

### Borrow: 풀 수수료 요율 (고급)

고급 모드에서는 요청에 풀 수수료 요율을 붙일 수 있습니다. 각 대출이 열릴 때 금고에서 VPFI로 가져가는 수수료로, 대출 수수료 할인을 10포인트 더해 줍니다(프로토콜 상한 50%). 대출 수수료 자체는 계속 대출 자산으로 부과되며, 요율은 환불되지 않습니다. 양식은 프로토콜이 이를 켜 둔 동안에만 선택지를 보여 주고, 금액과 기간에 대한 오늘의 요율을 표시합니다. 대출 하나가 가져갈 수 있는 VPFI 최대치(비워 두면 가장 큰 대출에 대한 오늘의 요율)와, 열릴 때 요율을 낼 수 없는 대출을 어떻게 할지(거절하거나 요율 없이 열기)를 정합니다. 대출은 그 순간 요율이 켜져 있고, 대출 자산에 가격과 유동성이 있으며, 요율이 최대치 이내이고, 금고에 자유 VPFI가 충분할 때만 요율을 냅니다. 요율은 요청을 게시한 뒤 두 번째 트랜잭션으로 설정되므로, 그 트랜잭션이 확정되기 전에 요청을 받은 대출자는 요율 없이 대출을 엽니다. 아무도 받지 않는 요청에 대한 백스톱 대출은 이 앱에서 아직 제공하지 않습니다.

<a id="lend-start"></a>

### Lend: 작동 방식

대출해 주려면 차입자의 공개 요청에 자금을 댑니다. 요청은 한 토큰의 금액, 차입자가 낼 이율, 기간, 그리고 차입자가 이미 자신의 볼트에 잠가 둔 담보로 이루어집니다. 자금을 대면 한 번의 트랜잭션으로 대출이 열립니다. 금액은 지갑에서 나가고, 차입자는 개시 수수료를 뺀 금액을 받으며, 담보는 대출이 끝날 때까지 당신을 위해 잠겨 있습니다. 대출에서 당신의 몫은 지갑에 있는 포지션 토큰이며, 그것을 가진 사람이 상환을 받습니다. 차입자는 만기일까지 금액과 이자를 갚고, 프로토콜은 이자에서 자신의 몫을 가져갑니다. 맞는 요청이 없으면 같은 페이지에서 직접 대출 오퍼를 올릴 수 있습니다.

<a id="lend-offers"></a>

### Lend: 요청 고르기

먼저 빌려줄 것과 받아들일 담보를 고릅니다. 두 토큰은 서로 달라야 하며, 이 페이지에서는 토큰만 고를 수 있습니다. 페이지는 그 쌍에 열려 있는 차입 요청을 프로토콜에서 직접 읽어 보여 줍니다. 각 요청에는 금액, 이율과 기간, 잠긴 담보, 오늘 가격 기준 담보인정비율, 이자 부과 방식, 이자 일정 여부, 차입자의 수수료 중 당신에게 돌아오는 금액이 표시됩니다. 요청은 통째로 자금을 받습니다. 범위가 지정되어 있으면 차입자의 최소 금액을 최고 이율로 빌려줍니다. 프로토콜이 거절할 요청이면 페이지가 이유를 알리고 버튼을 보여 주지 않습니다. 당신의 요청, NFT가 포함된 요청, 진행 중인 대출의 매각은 개수만 세고 목록에는 넣지 않습니다. 순서(자금을 댈 수 있는 요청 먼저, 그다음 높은 이율)는 편의를 위한 것이며 조언이 아닙니다.

<a id="lend-review"></a>

### Lend: 검토와 서명

지갑이 열리기 전에 검토 화면은 모든 수치를 보여 줍니다. 지갑에서 나가는 금액, 차입자가 받는 금액, 수수료와 그중 당신의 몫, 당신을 위해 보관되는 담보, 이율, 만기일에 갚을 이자, 그중 프로토콜의 몫, 당신에게 돌아오는 금액, 유예 기간, 그리고 잃을 수 있는 것입니다. 각 수명 주기 조건도 기본값일 때조차 명시합니다. 지갑 잔액이 금액보다 적으면 얼마가 부족한지 알리고 서명을 제시하지 않습니다. 위험 고지와 약관에 동의하려면 상자에 체크합니다. 확인 전에 수치가 바뀌면 체크가 해제됩니다. 이어서 지갑은 비용이 들지 않는 조건 서명, 필요하면 금액만큼의 정확한 승인, 그리고 앱이 먼저 시험 실행해 보는 수락 전송을 요청합니다. 승인 뒤에 멈추면 앱이 승인을 되돌리자고 묻고, 되돌려졌는지 알려 줍니다. 그 후 앱은 체인에서 열린 대출, 지갑에서 나간 금액, 돌아온 금액을 확인합니다.

<a id="lend-fee"></a>

### Lend: 수수료와 프로토콜의 몫

개시 수수료는 차입자가 부담합니다. 금액의 작은 비율이 대출 자산으로 한 번 부과되어 차입자가 받는 금액에서 빠집니다. 당신은 금액 전체를 빌려주고, 차입자는 이를 이자와 함께 전액 갚아야 합니다. 수락을 당신이 직접 보내므로, 그 수수료의 작은 몫, 즉 프로토콜이 매치를 제출한 사람에게 주는 몫이 당신의 지갑으로 돌아옵니다. 검토 화면에 표시됩니다. 차입자가 Full 수수료 요율을 선택했고 대출이 열릴 때 적용되면 수수료가 낮아지고 그 몫도 낮아집니다. 이자가 지급될 때 프로토콜은 대출이 열릴 때 적용되던 요율로 자신의 몫을 가져갑니다. 수수료 할인 설정이 켜져 있는 동안에는 당신의 수수료 할인 등급이 그 몫을 낮출 수 있습니다. 검토 화면은 오늘의 요율과 그 몫의 최대치를 보여 줍니다.

<a id="lend-risks"></a>

### Lend: 위험

대출해 주다가 돈을 잃을 수 있습니다. 유예 기간이 끝날 때까지 차입자가 갚지 않으면 대출은 디폴트가 되고 담보에서 지급받습니다. 프로토콜이 할 수 있으면 당신을 위해 매각하고, 할 수 없으면 그대로 넘겨주며, 매각 대금이 받을 금액보다 적을 수 있습니다. 유동 담보라면 건전성 지수가 1 아래로 떨어지는 즉시 누구나 대출을 청산할 수 있습니다. 매각은 당신에게 먼저 갚지만, 급락하면 받을 금액보다 적게 남을 수 있습니다. 비유동 토큰은 가치가 0으로 평가되어 가격 기반 청산이 없으며, 디폴트 시 가치와 상관없이 담보 전부를 받습니다. 대출이 끝나기 전에는 금액을 되찾을 수 없습니다. 일찍 빠지려면 포지션을 다른 대출자에게 팔아야 합니다. 일할 이자라면 조기 상환 시 받는 금액이 줄어듭니다. 일시 정지는 만기일을 뒤로 미루며, 그동안에도 이자는 계속 쌓입니다.

<a id="lend-offer"></a>

### Lend: 직접 오퍼 올리기

맞는 요청이 없으면 두 토큰에 대해 직접 대출 오퍼를 올릴 수 있습니다. 빌려줄 정확한 금액, 받을 이자율, 기간, 차입자가 잠가야 할 담보를 정합니다. 게시하면 금액이 지갑에서 내 볼트로 옮겨지고, 오퍼가 열려 있는 동안 그곳에 잠겨 있습니다. 차입자가 오퍼를 받으면 다시 묻지 않고 내 조건으로 바로 대출이 열립니다. 차입자는 개시 수수료를 뺀 금액을 받고, 차입자의 담보는 나를 위해 차입자의 볼트에 잠깁니다. 네트워크에서 매칭이 켜져 있는 동안에는 누구든 내 오퍼를 차입자의 요청과 매칭할 수도 있으며, 부분을 설정하지 않았다면 그 대출은 내 이자율로 금액 전부를 빌려주고 담보는 적어도 내가 요구한 만큼입니다. 매칭이 지금 켜져 있는지는 검토 화면이 알려 줍니다. 게시 5분 뒤부터 취소할 수 있고, 금액은 지갑으로 돌아옵니다. 만료된 오퍼는 더 이상 받을 수 없으며, 금액은 나나 다른 누군가가 닫을 때까지 볼트에 남았다가 내 지갑으로만 돌아갑니다. 다음 앱의 오퍼 페이지가 만들어지기 전까지는 오퍼를 현재 앱의 오퍼 페이지에서 확인하고 취소하고 닫습니다. 검토 화면은 무엇이든 잠기기 전에 이를 알려 줍니다.

<a id="lend-offer-terms"></a>

### Lend: 오퍼의 조건

고급 모드에서 부분을 설정하지 않는 한, 한 차입자가 금액 전부를 받거나 아무도 받지 않으며, 차입자는 내가 정한 담보를 정확히 잠가야 합니다. 양식에는 지갑에 있는 대출 토큰의 잔액이 표시됩니다. 모든 숫자는 입력한 그대로 정확히 읽힙니다. 토큰의 소수 자릿수를 넘는 값은 반올림하지 않고 거부되며, 이자율은 연 100%까지 소수 둘째 자리로 정할 수 있습니다. 고를 수 있는 기간은 네트워크가 허용하는 최장 기간까지입니다. 오퍼는 받거나 취소될 때까지, 또는 고른 일 수(최대 1년) 동안 열려 있습니다. 보통의 선택인 전체 기간 이자에서는 일찍 갚아도 내가 버는 이자가 줄지 않고, 일할 이자는 대출이 열려 있던 기간만큼만 받습니다. 차입자가 일부를 일찍 갚도록 허용할 수도 있습니다. 양식에는 지금 차입자가 받는다면 만기일에 차입자가 내게 갚을 금액이 표시됩니다. 고급 모드에서는 오퍼를 부분으로 나누어 빌려주거나, 체결 방식을 정하거나, 이자를 일정에 따라 받거나, 풀 수수료 요율을 붙일 수도 있습니다.

<a id="rate-check"></a>

### 최근 대출과 금리 비교하기

게시 양식 두 가지, 대출자의 오퍼와 차입자의 요청 모두에서 금리 칸 아래에 같은 페어와 같은 기간으로 최근 30일 안에 시작된 대출의 중간 금리와 그 건수가 표시됩니다. 내 금리가 5포인트보다 더 떨어져 있으면 앱이 경고하고 어느 쪽으로 작용하는지 알려 줍니다. 시장보다 훨씬 낮은 대출자나 시장보다 훨씬 높은 차입자는 금리가 움직일 때 가장 먼저 체결되는 오퍼를 내게 되고, 반대 방향이면 오퍼가 아무도 받지 않은 채 남을 수 있습니다. 경고일 뿐이며 그대로 게시할 수 있습니다. 비교할 최근 대출이 없거나, 담보가 NFT이거나, 프로토콜의 인덱스를 읽을 수 없으면 양식은 침묵하지 않고 그렇다고 알려 줍니다.

<a id="public-queue"></a>

### 공개 대기열이 있는 네트워크

Ethereum, BNB Chain, Polygon(및 BNB Testnet과 Polygon Amoy)에서는 보낸 트랜잭션이 포함되기 전에 공개 대기열에서 기다리며, 그 대기열을 지켜보는 누구든, 봇을 포함해, 그것을 보고 먼저 행동할 수 있습니다. 취소가 도착하기 전에 오퍼를 가져가거나 상환이 도착하기 전에 대출에 손을 쓰는 식입니다. 그래서 이런 네트워크에서는 오퍼 게시·수락·취소, 상환, 담보 추가의 검토가 지갑이 열리기 전에 이를 알려 줍니다. 트랜잭션을 비공개로 보낼 수 있는 지갑도 있으니 지갑의 네트워크 또는 보안 설정을 확인하세요. 앱이 그 경로를 대신 고를 수는 없으며, 평소대로 보내도 바뀌는 것은 도착하기 전에 누가 트랜잭션을 볼 수 있는지뿐입니다. Base, Arbitrum, Optimism에는 공개 대기열이 없어 아무것도 표시되지 않습니다.

<a id="lend-offer-parts"></a>

### Lend: 부분으로 빌려주는 오퍼 (고급)

고급 모드에서는 대출 오퍼를 부분으로 나누어 빌려줄 수 있습니다. 입력한 금액은 여전히 전체 금액입니다. 게시하면 전부 잠기고, 오퍼를 직접 받는 차입자는 전부를 빌립니다. 여기에 한 번의 매칭이 빌려줄 수 있는 가장 작은 부분을 정합니다. 네트워크에서 매칭이 켜져 있는 동안에는 매칭하는 사람이 내 오퍼를 여러 차입자에게 빌려줄 수 있으며, 각 대출은 가장 작은 부분과 남은 금액 사이이고 내 이자율을 따릅니다. 각 매칭은 그 부분에 맞는 비율의 담보를 적어도 요구하며(내림), 검토 화면은 가장 작은 부분이 요구하는 담보를 보여 줍니다. 매칭이 한 부분을 빌려주고 나면 어떤 차입자도 나머지를 직접 받을 수 없고, 추가 매칭만 가능합니다. 오퍼를 취소하면 나머지를 돌려받을 수 있습니다. 남은 금액이 가장 작은 부분보다 적어지면 프로토콜이 이를 내 지갑으로 돌려주고 오퍼를 닫습니다. 검토 화면은 매칭이 지금 켜져 있는지 알려 주며, 꺼져 있는 동안에는 전부를 받는 차입자만 대출을 열 수 있습니다. 체결 방식은 요청과 같습니다. 기본은 부분 체결이고, 전부 아니면 무효는 전체 금액에 대한 대출 하나만 허용하며(그래서 부분 불가), 즉시 또는 취소는 만료가 필요합니다. 체결 방식은 게시 후 바꿀 수 없습니다. 전체 금액이 오늘 가격으로 필요로 하는 것보다 적은 담보를 요구하는 오퍼는 프로토콜이 거부하며, 검토 화면은 요구되는 최소량을 알려 줍니다. 고급 모드에서 정한 옵션은 Basic으로 바꿔도 계속 적용되며, 양식이 이를 알리고 지울 수 있게 합니다.

<a id="lend-offer-schedule"></a>

### Lend: 오퍼의 이자 지급 일정 (고급)

고급 모드에서는 대출 오퍼에도 요청처럼 이자 지급 일정을 붙일 수 있습니다. 매월, 분기마다, 6개월마다, 매년 중 하나입니다. 양식은 내 조건에서 프로토콜이 허용하는 일정만 보여 주고, 닫힌 일정마다 그 이유를 표시합니다. 부분을 설정하면 프로토콜은 게시할 때 가장 작은 부분을 확인하므로, 가장 작은 부분이 기준액보다 작으면 더 잦은 일정은 닫힙니다. 각 대출은 열릴 때 다시 확인됩니다. 검토 화면에는 차입자가 전부를 받을 때의 기간별 이자와, 부분이 있으면 가장 작은 부분 대출의 기간별 이자, 놓친 기간의 유예 기간이 표시됩니다. 유예 기간이 끝날 때까지 어떤 기간의 이자가 지급되지 않으면 누구나 차입자의 담보 일부를 팔아 내게 지급할 수 있으며, 대출은 계속 열려 있습니다. 일정은 게시 후 바꿀 수 없습니다.

<a id="lend-offer-tariff"></a>

### Lend: 오퍼의 풀 수수료 요율 (고급)

고급 모드에서는 대출 오퍼에 풀 수수료 요율을 붙일 수 있습니다. 오퍼에서 각 대출이 열릴 때 금고에서 VPFI로 가져가는 수수료로, 그 대출의 금액과 기간으로 정해집니다. 그 대가로 그 대출의 이자에 대한 프로토콜 몫의 할인이 10포인트 더해집니다(상한 50%). 그 몫은 계속 대출 자산으로 가져갑니다. 추가 포인트는 대출 기간 동안 유효하며, 대출이 새 기간으로 연장되면 그 기간에는 적용되지 않습니다. 추가 포인트는 대출자 포지션에 속하므로, 이자가 지급될 때 그 포지션을 보유한 사람이 받습니다. 요율은 환불되지 않습니다. 양식은 전체 금액, 즉 오퍼가 여는 가장 큰 대출에 대한 오늘의 요율을 표시합니다. 대출 하나가 가져갈 수 있는 VPFI의 최대치와, 요율을 받을 수 없는 대출을 거절할지 요율 없이 열지를 정합니다. 대출은 그 순간 요율이 켜져 있고, 대출 자산에 가격이 있고 유동적이며, 요율이 내 최대치 이내이고, 금고에 사용 가능한 VPFI가 충분할 때만 요율을 받을 수 있습니다. 요율은 게시 후 두 번째 거래로 설정되므로, 그 거래가 확정되기 전에 차입자나 매칭으로 오퍼에서 열린 대출은 요율 없이 열립니다.

<a id="lend-offer-review"></a>

### Lend: 오퍼 검토와 게시

지갑이 열리기 전에 앱은 프로토콜에 오퍼를 모의 실행하게 하므로, 검토 화면에는 프로토콜 자체의 답이 나옵니다. 지금 잠글 금액, 차입자가 받는 금액, 차입자가 잠가야 할 담보, 이자율과 기간, 오늘의 수수료율로 차입자가 받을 금액, 만기일의 이자, 그중 프로토콜의 몫과 내게 돌아올 금액, 대출 기간의 모든 조건, 오퍼 만료 시점, 오늘 가격 기준 담보 대비 대출 비율, 승인이 필요한지가 표시됩니다. 지갑 잔액이 금액보다 적으면 얼마가 부족한지 알리고 서명을 제시하지 않습니다. 위험 고지와 약관에 동의하는 상자에 체크합니다. 필요하면 지갑이 금액만큼 정확히 승인하고, 앱이 오퍼를 다시 모의 실행한 뒤에야 게시합니다. 승인 뒤에 멈추면 앱은 승인을 원래대로 돌려 달라고 요청하고 그렇게 되었는지 알려 줍니다. 그 뒤 앱은 기록된 오퍼와 볼트에 잠긴 금액을 체인에서 확인합니다.

<a id="lend-offer-fee"></a>

### Lend: 오퍼에 붙는 수수료

오퍼를 게시해도 수수료는 없습니다. 개시 수수료는 차입자의 몫입니다. 금액의 작은 비율로, 차입자가 내 오퍼를 받을 때 그 시점의 요율로 대출 자산에서 한 번 부과되며, 차입자가 받는 금액에서 빠집니다. 나는 금액 전부를 빌려주고, 차입자는 이자와 함께 전액을 갚습니다. 이자가 지급될 때 프로토콜은 대출이 열릴 때 적용되던 요율로 자신의 몫을 가져갑니다. 수수료 할인 설정이 켜져 있는 동안에는 내 수수료 할인 등급이 그 몫을 낮출 수 있습니다. 검토 화면에는 오늘의 요율과 그 몫이 가져갈 수 있는 최대치가 표시됩니다. 요율을 읽을 수 없으면 숫자 대신 그렇다고 알려 줍니다.

<a id="positions"></a>

### Positions: 내 대출 포지션

Positions는 이 네트워크에서 내가 빌려주거나 빌린 모든 대출을 지갑이 보유한 포지션 토큰으로 보여 줍니다. 그래서 다른 사람에게 이전한 포지션은 목록에서 사라집니다. 먼저 수령할 수 있는 지급금이 나오며, Claims를 엽니다. 다음으로 진행 중인 대출이 Home과 같이 가장 급한 기한 순으로 나옵니다. 마지막으로 종료된 대출이 종료 방식과 함께 나옵니다: 상환됨, 채무 불이행, 정산됨, 또는 매칭으로 종료됨. 지급금이 아직 남아 있는 종료 대출은 Claims로 안내합니다.

전체, 빌려줌, 빌림으로 세 목록을 한 번에 좁힐 수 있습니다. Positions는 모든 것을 읽은 뒤에만 아무것도 없다고 말하며, 목록을 끝까지 읽지 못했다면 그렇게 알려 줍니다. 각 대출은 자체 페이지를 열고, 그 페이지에서 내가 할 수 있는 작업을 보여 줍니다. 목록 자체는 아무것도 서명하지 않습니다.

진행 중인 대출이 두 건 이상이면 맨 앞에 요약이 나옵니다. 각 쪽마다 토큰별로 아직 갚아야 하거나 아직 빌려준 원금(서로 다른 토큰의 금액은 절대 합산하지 않으며, NFT 대여는 건수로 셉니다), 다음 상환 기한 날짜와 해당 대출 링크, 그리고 기한이 지났거나 폴백 상태인 대출을 각각 링크와 함께 보여줍니다. 이 합계에는 이자가 포함되지 않으며, 각 대출 페이지에서 지금 상환하는 데 드는 금액을 확인할 수 있습니다. 대여의 경우 그 날짜는 선불 임대료로 종료되는 날이므로 상환이라고 부르지 않습니다.

<a id="position"></a>

### Position: 대출 하나

각 대출에는 전용 페이지가 있습니다. 먼저 대출 상태가 나오고, 이어서 내 역할이 나옵니다: 포지션 토큰은 판매하거나 이전할 수 있으므로, 지금 지갑이 보유한 측입니다. 어느 측도 보유하지 않으면 보기만 하는 것입니다. 나와 관련된 기한은 내 측에 맞게 표시됩니다. 유예 기간이 끝나면 이제 누구나 채무 불이행을 시작할 수 있다고 페이지가 알리며, 이는 프로토콜이 확인할 때만입니다.

그 아래에 대출의 날짜(일시 중지 보상 전의 현재 기간 만기일, 프로토콜이 일시 중지된 동안 더해진 시간, 만기일, 유예 기간 종료), 현재 조건(부분 상환은 남은 원금을 줄입니다), 건전성 지수, 담보가 보관된 곳이 나옵니다. 읽지 못한 수치는 알 수 없음으로 표시됩니다. 담보에 가격이 없으면 채무 불이행 시 대출자는 담보 자체를 받으며, 페이지가 이를 알립니다. 네트워크가 청산 임계값 바로 위에 다른 대출과의 내부 매칭용 구간을 두면 페이지가 이를 알립니다. 그 구간에서는 외부 매각으로 대출을 닫을 수 없습니다. NFT 대여에는 담보가 없습니다. 채무 불이행 시 임차인의 사용이 끝나고, 선지급 대여료는 프로토콜 몫을 뺀 뒤 대출자에게, 버퍼는 트레저리로 갑니다. 첫 작업은 전액 상환, 일부 상환, 담보 추가와 회수이며, 나머지 작업은 이후 업데이트에서 추가됩니다.

<a id="repay"></a>

### 전액 상환

진행 중인 대출에서는 페이지가 전액 상환을 제공합니다. 대출자를 제외한 누구나 상환할 수 있습니다. 차입자 포지션을 보유하지 않았다면 상환해도 담보에 대한 권리는 생기지 않으며, 담보는 그 포지션의 보유자만 받을 수 있습니다. 유예 기간이 끝나면(대출은 채무 불이행으로 넘어갑니다) 그리고 swap-to-repay 주문이 대기 중인 동안에는 상환이 보류됩니다.

갚아야 할 금액은 초 단위로 늘어나며, 프로토콜은 상환이 확정되는 순간의 금액을 가져갑니다. 검토 화면에는 두 수치가 나옵니다: 지금의 금액과 약 30분 뒤의 금액입니다. 지갑은 두 번째 수치를 정확히 승인합니다. 이미 더 많이(무제한 포함) 승인해 두었다면, 상환 자체에는 상한이 없으므로 상환을 위해 그 수치로 낮춥니다. 승인은 시간이 아니라 금액을 제한합니다. 늦게 확정된 상환은 갚을 금액이 아직 승인 안에 들 때만 처리되고, 그렇지 않으면 거부되어 아무것도 이동하지 않습니다. 전체 기간 이자를 받는 대출은 만기일 전까지 금액이 늘지 않으므로 늦은 상환도 처리될 수 있습니다. 상환에 쓰이지 않은 승인분은 이후 원래대로 되돌려집니다. 그다음 차입자는 담보를, 대출자는 원금과 이자를 Claims에서 받습니다.

대출이 만기일을 지나 유예 기간에 있으면, 검토 화면이 체인의 시계로 유예 기간 종료까지 카운트다운합니다. 그 후에는 프로토콜이 상환을 거부하고 누구나 디폴트를 신청할 수 있으며, 먼저 채굴되는 거래가 이깁니다. 그러니 상환은 충분히 일찍 보내세요. 한 시간 이하가 남으면 검토 화면이 지금 보내라고 알려 줍니다. 일부 상환도 같은 카운트다운을 보여 줍니다.

<a id="interest-schedule"></a>

### 이자 일정

이자 일정이 있는 대출은 만기에만이 아니라 매 기간(한 달, 분기, 6개월 또는 1년)마다 이자를 냅니다. 페이지에는 현재 기간이 표시됩니다: 언제 끝나는지, 유예 기간이 언제 끝나는지, 그 기간의 이자, 지금까지 낸 금액, 아직 남은 금액입니다. 기간 이자는 현재 원금과 이율로 계산되므로 부분 상환은 이를 줄입니다.

기간과 그 유예가 끝나면 누구나 그 기간을 정산할 수 있습니다. 납부된 기간은 체크포인트만 앞으로 옮깁니다. 아직 부족한 기간은 미납액과 매각 비용을 충당할 만큼만 차입자의 담보를 매각합니다. 페이지는 지금 정산할 수 있는지 알려 줍니다. 네트워크의 정기 정산 스위치가 꺼져 있으면 그 이름을 밝히고(그때는 아무것도 정산할 수 없고 담보도 매각되지 않음), 프로토콜이 일시 중지된 동안에는 그것도 밝힙니다(정산이 멈추고, 중지된 시간은 기간의 날짜에 더해짐). 일시 중지는 기간의 날짜를 중지된 시간만큼 뒤로 미루지만, 한 기간이 내야 할 이자는 한 기간 분으로 유지됩니다. 이자는 중지 중에도 계속 쌓이며, 상환으로 낸 이자는 모두 그 기간에 반영됩니다.

<a id="partial-repay"></a>

### 대출 일부 상환

차입자 포지션 보유자는 대출 조건이 허용하는 경우 진행 중인 대출 페이지에서 원금의 일부를 상환할 수 있습니다. 상환할 원금을 입력하세요. 프로토콜은 대여 토큰의 최소 금액 이상, 원금 전액 미만을 받습니다(전액 상환은 "전액 상환"입니다). 대출 이자가 마지막으로 지급된 이후 쌓인 이자가 더해집니다. 대출은 줄어든 원금으로 계속되며 만기일은 바뀌지 않습니다.

검토 화면에는 상환액, 이자, 남는 원금, 승인이 감당하는 금액이 표시됩니다. 만기 전 일할 계산 대출에서는 이자가 정확합니다. 전체 기간 이자 대출이거나 만기가 지난 경우에는 "최대"로 표시됩니다. 앱이 읽는 프로토콜 수치에는 남은 기간 이자나 연체료도 포함되지만, 일부 상환에서는 이를 청구하지 않기 때문입니다. 대출에 대한 재융자 요청이나 차입자 포지션의 상계 오퍼가 활성 상태인 동안, 그리고 유예 기간이 끝난 뒤에는 일부 상환이 보류됩니다.

<a id="add-collateral"></a>

### 담보 추가

차입자 포지션 보유자는 진행 중인 대출의 페이지에서 담보를 추가할 수 있습니다. 담보를 추가하면 대출의 헬스 팩터가 오르고 LTV가 내려가 청산에서 더 멀어집니다. 대출이 이미 가진 것과 같은 토큰만 추가할 수 있습니다. 프로토콜은 다른 토큰을 받지 않으며, 현재 가격을 매기는 담보에 한해서만 추가를 받습니다. 금액을 입력하면 양식에 지갑 보유량이 표시됩니다.

검토 화면은 추가 전후의 담보, 보관 위치(대출이 끝날 때까지 대출에 묶인 내 볼트), 현재 헬스 팩터와 LTV를 보여 줍니다. 기존 승인액이 부족하면 지갑이 정확히 그 금액만 승인하고, 앱은 먼저 추가를 드라이 런으로 시도합니다. 이후 앱은 추가 후의 헬스 팩터와 LTV를 프로토콜 자체 수치로 보여 줍니다. 프로토콜이 일시 중지된 동안에도 담보 추가는 열려 있습니다. 폴백 상태의 대출은 추가로 프로토콜의 개시 한도를 회복하면 다시 진행 중이 됩니다. 그렇지 않으면 담보는 추가되지만 대출은 폴백 상태로 남습니다. 추가한 담보는 대출이 청산되거나 디폴트되면 나머지와 함께 잃을 수 있습니다. 차입자 포지션을 넘겨받았고 대출이 폴백 상태라면, 추가분은 대출에 기록된 차입자의 볼트로 가며, 대출을 다시 진행 중으로 되돌릴 때에만 당신의 볼트로 옮겨집니다.

<a id="take-back-collateral"></a>

### 담보 회수

대출이 진행되는 동안 차입자 포지션 보유자는 대출에 필요한 양을 넘는 담보를 대출 페이지에서 회수할 수 있습니다. 프로토콜은 건강 지수가 대출의 최소값 이상으로, LTV가 개시 시 상한 이내로 유지되도록 회수 가능한 최대치를 계산합니다. 이 한도는 가격과 이자 누적에 따라 달라지며, 입력하는 동안 양식에 표시됩니다. 담보를 회수하면 대출이 청산에 가까워집니다.

검토 화면에는 현재와 회수 후의 담보, 담보가 볼트에서 지갑으로 간다는 점, 현재 한도, 대출의 현재 건강 지수와 LTV가 표시됩니다. 승인이 필요 없으므로, 앱이 회수를 모의 실행으로 시험한 뒤 지갑이 한 번 확인을 요청합니다. 프로토콜은 회수가 확정될 때 한도를 다시 확인합니다. 가격이 움직여 금액이 더 이상 맞지 않으면 거부되고 아무것도 이동하지 않습니다. 프로토콜 일시 중지, 대기 중인 스왑 상환 주문, 유효한 리파이낸스 요청, 대출자의 매각 등록이 있으면 회수할 수 없으며, 프로토콜은 가격을 매기는 토큰의 담보만 회수하게 합니다. 계정에 보호 모드가 켜져 있으면, 담보는 지갑에 도착하기 전에 계정의 지연 시간 동안 지급 대기열에서 기다리며, 검토가 이를 알립니다.

<a id="collect-a-payout"></a>

### 지급금 받기

대출이 끝나면 프로토콜은 각 측에 지급할 금액을 기록하고, 각 포지션의 보유자가 대출 페이지나 Claims에서 이를 받습니다. 지급은 지금 포지션을 보유한 사람에게 이루어지므로, 구매한 포지션은 당신에게 지급합니다. 대출자의 지급금은 원금과 이자, 또는 디폴트나 청산으로 회수된 금액이며, 대출자를 위해 보관된 자금과 대여의 경우 대여된 NFT가 더해집니다. 차입자의 지급금은 돌려받는 담보 또는 남은 금액이며, 차입자를 위해 보관된 잉여금이 더해집니다. 받으면 포지션 토큰이 소각되고, 양측이 모두 받으면 대출은 정산됩니다.

검토 화면에는 청구가 하는 모든 지급, 대출자 포지션의 이전 판매자가 먼저 받는 금액(벌었지만 받지 못한 이자), 그리고 지급이 도착하는 곳이 표시됩니다. 도착지는 지갑이거나, 보호 모드가 켜져 있으면 계정의 지급 대기열 또는 금고입니다. 승인이 필요 없으므로 앱이 청구를 시뮬레이션해 본 뒤 지갑은 한 번만 묻습니다. 프로토콜이 일시 중지되면 모든 청구가 멈춥니다. 대출이 폴백 상태인 동안 차입자의 지급은 대출자가 받을 때까지 기다리며, 대출자가 받으면 폴백이 끝나 차입자는 더 이상 이를 회복할 수 없습니다. 완료 카드에는 거래가 실제로 지급한 내용이 표시됩니다.

<a id="claim-everything"></a>

### 모두 받기

Claims는 ‘모두 받기’로 시작합니다. 지금 받을 수 있는 모든 지급을 하나의 거래로 모읍니다. 포지션을 보유한 종료된 대출의 지급, 상호작용 보상, 상시 오퍼의 아직 대출되지 않은 자본, 볼트의 자유 VPFI, 그리고 수령인이라면 인출 가능한 급여가 표시됩니다. 지급마다 스위치가 있어 어느 것이든 뺄 수 있습니다. 볼트의 자유 VPFI는 수수료 할인 등급을 정하므로 직접 켜지 않으면 꺼져 있고, 아직 대출 중인 상시 오퍼의 자본도 마찬가지입니다. 판매한 포지션에서 받을 이자와 폴백 상태의 대출은 각각 따로 받습니다. 거래 안에서 각 지급은 따로 실행되어, 프로토콜이 거부한 지급은 건너뛰고 목록에 남으며 나머지는 그대로 지급됩니다. 한 거래에는 최대 30건이 들어가고 나머지는 두 번째 거래를 기다립니다. 지갑에서 나가는 것이 없으므로 지갑은 시험 실행 후 한 번만 요청하고, 완료 카드에 각 지급이 받아졌는지 건너뛰었는지와 돈이 어디에 도착했는지 표시됩니다. 일시 중지 중에는 모든 수령이 멈춥니다.

<a id="payout-queue"></a>

### 대기열에서 기다리는 지급

보호 모드가 켜져 있으면 금고에서 지갑으로 나가는 모든 것이 지급 대기열에서 계정의 지연 시간을 기다립니다. 청구 페이지는 그곳에서 기다리는 항목을 가장 빠른 것부터, 각각 짧은 요청 코드와 함께 보여 줍니다. 지급에 관한 모든 알림은 같은 코드를 표시하므로 메시지와 요청을 맞춰 볼 수 있습니다. 각 행에는 무엇을 지급하는지, 어디로 가는지, 언제 해제할 수 있는지가 표시됩니다. 지급 기한이 되면 누구나 해제할 수 있으며, 기록된 목적지에만 지급됩니다. 그 목적지가 더 이상 허용되지 않으면 해제하는 대신 취소됩니다. 본인 또는 보조 서명자 중 한 명은 일시 중지 중에도 언제든 지급을 취소할 수 있으며, 자산은 금고에 남습니다. 계정이 승인을 요구하면 보조 서명자가 각 지급을 먼저 승인합니다. 서명자는 고급 모드에서 계정 주소를 붙여 넣어 계정을 찾습니다. 일시 중지는 끝나거나 긴 일시 중지 후 비상 출구가 열릴 때까지 해제를 보류합니다. 각 작업은 지갑에 한 번만 묻고, 완료 카드는 트랜잭션이 한 일을 보여 줍니다.

<a id="seller-interest"></a>

### 판매한 포지션의 이자

대출자 포지션을 판매해도, 보유하는 동안 벌었지만 아직 받지 못한 이자는 대출에 대한 청구권으로 여전히 당신의 것입니다. Claims는 그런 청구권이 있는 모든 대출을, 프로토콜의 이자 몫을 뺀 받을 금액과 이미 볼트에서 기다리는 금액과 함께 보여 줍니다. 대출이 진행되는 동안 각 이자 지급은 열린 청구권을 오래된 순서대로 먼저, 각 판매자 자신의 볼트로 지급합니다. 당신의 볼트에 무언가 도착하기 전까지는 출금할 것이 없습니다. 대출이 끝나면 출금은 먼저 대출자 측이 회수한 금액을 나눕니다. 먼저 보유자의 원금, 그다음 각 판매자의 청구권을 오래된 순서대로. 이때 열린 청구권은 모두 닫히고, 받지 못한 부분은 미지급으로 남습니다. 대출은 앱의 인덱스에서 찾습니다. 목록을 가져올 수 없으면 대출 번호로 조회하세요. 번호 조회는 체인만 읽습니다. 승인이 필요 없으므로 지갑은 시험 실행 후 한 번만 묻고, 완료 카드에 거래가 지급한 내용이 표시됩니다.

<a id="frozen-proceeds"></a>

### 지급이 동결되었을 때

제재 검사가 지갑에 표시를 하더라도, 프로토콜은 당신에게 지급될 것을 아무것도 가져가지 않으며 어떤 대출의 종료도 막지 않습니다. 상대방은 자기 쪽이 회수한 만큼을 그대로 받습니다. 당신의 몫은 볼트에 잠긴 채 보관되고, 지갑이 목록에서 해제되면 풀립니다. 이때 Claims와 대출 페이지에는 "동결됨, 목록 해제 대기 중"이 표시되며 수령 버튼은 나오지 않습니다. 검사를 읽을 수 없고 지갑이 이전에 표시된 것으로 확인된 경우, 동결된 지급은 검사가 다시 응답할 때까지 잠겨 있습니다. 그동안 지갑에 지급될 금액도 프로토콜이 계속 표시된 지갑으로 취급하므로 같은 방식으로 보관됩니다. 표시된 것으로 확인된 적이 없는 지갑은 장애만으로 동결되지 않습니다. 진행 중인 대출에서는 대출이 이미 지급했고 대출자가 수령할 때까지 대출자 포지션을 위해 예약된 금액도 대출 페이지에 표시되며, 상환된 대출은 차입자가 아직 수령하지 않은 잉여금을 기다릴 때 그렇다고 알려 줍니다.

<a id="extension-reserves"></a>

### 연장 예비금

대출의 차입자 포지션을 보유하고 있다면, 대출의 토큰을 연장에 대비해 자신의 볼트에 따로 떼어 둘 수 있습니다. 연장은 키퍼가 하든 직접 하든 먼저 이 예비금에서 차감됩니다. 예비금은 당신의 것으로 남습니다. Claims는 예비금이 남아 있는 모든 대출을 보여 주고, 연장이 아직 거기서 차감할 수 있는지 알려 줍니다. 대출이 진행 중이고 당신이 그 차입자 포지션을 보유하는 동안에만 가능합니다. 프로토콜이 일시 중지되지 않은 동안에는 대출 상태와 관계없이 언제든 예비금 전부를 돌려받을 수 있으며, 대출이 아직 진행 중이면 다음 연장은 그때부터 해당 토큰의 다른 잔액에서 차감됩니다. 대출은 앱의 인덱스에서 찾으며, 목록을 만들 수 없으면 번호로 대출을 조회하세요. 승인이 필요 없으므로 지갑은 시험 실행 후 한 번만 요청하고, 완료 카드에 돈이 어디에 도착했는지 표시됩니다.

<a id="vault-holdings"></a>

### 내 볼트

볼트 페이지는 연결된 네트워크에 있는 내 볼트를 보여 줍니다. 전체 주소와 익스플로러 링크입니다. 볼트는 프로토콜이 내 지갑만을 위해 유지하는 컨트랙트로, 안의 자산은 다른 사람의 자산과 합쳐지지 않으며 프로토콜의 규칙에 따라서만 나갑니다. 아직 볼트가 없으면 페이지가 그렇게 알리고 만들기를 제안합니다. 첫 예치나 첫 오퍼도 어차피 볼트를 만듭니다. 만들 때는 아무것도 이동하지 않고 승인도 요청하지 않으므로 지갑은 한 번만 묻습니다. 자산마다 프로토콜의 세 가지 수치가 표시됩니다. 볼트 안(프로토콜이 그곳에서 내 것으로 세는 양), 지금 출금 가능, 포지션이 보유 중(대출, 오퍼, 청구, 예비금, 대기 중인 지급이 묶어 둔 양)입니다. 일반 전송으로 볼트에 들어온 토큰은 세지 않으며, 인수하기 전에는 출금할 수 없습니다. 해당 행이 그렇게 알리고 인수하거나 거부하는 곳으로 연결합니다. 페이지는 내가 예치한 자산과 대출, 내가 만든 오퍼, 상시 오퍼가 가리키는 자산을 나열하므로, 일반 전송으로 들어온 토큰은 그중 하나가 가리킬 때만 보입니다. 작은 행과 빈 행은 개수를 알려 주는 스위치 뒤에 숨겨집니다. 볼트의 VPFI는 수수료 할인 등급을 정합니다. 그 목적으로 보유한다고 담보가 되지는 않으며, 대출이나 오퍼에 담보로 맡긴 VPFI는 보유 중으로 표시됩니다. 출금 가능한 몫이 있는 자산마다 출금 버튼이 있습니다.

<a id="vault-deposit"></a>

### 볼트에 예치하기

볼트 페이지의 예치는 토큰이나 NFT를 지갑에서 내 볼트로, 어떤 대출과도 무관하게 옮깁니다. 예치할 것을 고르세요. 추천 토큰이나 테스트 컬렉션, 또는 붙여 넣은 주소입니다. 토큰인지, NFT인지, 멀티 토큰 컬렉션인지는 그 컨트랙트에서 읽습니다. 그다음 수량, NFT의 토큰 ID, 또는 토큰 ID와 개수를 입력합니다. 아직 동의하지 않은 서비스 약관이 시행 중이면 앱이 먼저 동의를 요청하며, 동의하지 않은 지갑으로 바꾸면 서명 전에 다시 요청합니다. 검토 화면은 지갑에서 무엇이 나가고 어느 볼트로 들어가는지 알려 줍니다. 아직 볼트가 없으면 예치가 볼트를 만듭니다. 토큰은 정확히 그 수량만큼의 승인을, NFT는 그 토큰 하나에 대한 승인만을, 멀티 토큰 컬렉션은 예치 직후 지갑 단계 하나로 되돌리는 승인을 요청합니다. 프로토콜은 지갑이 보내기 전에 예치를 확인하고, 전송 시 수수료를 떼는 토큰처럼 전액이 도착하지 않는 토큰은 거부합니다. 예치가 이루어지지 않으면 앱이 승인을 되돌리도록 요청합니다. 도착한 것은 내 것으로 계산됩니다. 보호 모드가 꺼져 있으면 바로 출금할 수 있고, 켜져 있으면 출금이 계정의 대기 시간을 기다리며 계정이 잠긴 동안에는 아무것도 나가지 않습니다. 어느 쪽인지는 검토 화면이 알려 줍니다. 프로토콜이 일시 중지된 동안에는 예치가 닫혀 있습니다.

<a id="vault-withdraw"></a>

### 볼트에서 출금

볼트 페이지의 자산에서 출금을 누르면 출금 가능한 몫이 지갑으로 돌아갑니다. 출금 가능하다는 것은 대출, 오퍼, 청구, 상시 오퍼, 대기 중인 지급 어느 것도 붙잡고 있지 않다는 뜻이며, 프로토콜 자체의 수치가 결정하고 양식은 그 수치를 보여 주며 그보다 많은 금액을 거부합니다. 예치 기록이 컬렉션으로만 알려 주는 NFT는 그 컬렉션 아래에서 토큰 ID를 입력해 출금합니다. 앱은 서명하는 지갑으로만 출금합니다. 검토 화면은 어느 볼트에서 무엇이 나가고 어디로 가는지 알려 줍니다. 보호 모드가 꺼져 있으면 바로 지갑에 도착합니다. 켜져 있으면 프로토콜이 계정의 대기 시간 동안 대기열에 넣고, 계정이 요구하면 보조 서명자의 승인도 필요합니다. 대기 중인 출금은 청구 페이지의 지급 대기열에서 취소할 수 있으며, 그러면 볼트에 그대로 남습니다. 계정이 잠긴 동안에는 아무것도 출금할 수 없습니다. 지갑에서 나가는 것은 없고 승인도 요청하지 않습니다. 프로토콜이 일시 중지된 동안에는 비상 탈출 경로가 열릴 때까지 출금이 닫힙니다. '프로토콜이 일시 중지되었을 때'를 참고하세요.

<a id="vault-safety"></a>

### 계정 안전

볼트 페이지의 계정 안전 카드는 계정이 보호 모드로 운영되는지, 그 지연 기간, 각 해제에 보조 서명자의 승인이 필요한지, 포지션 NFT가 보호되는지, 대기열에 몇 건의 지급이 기다리는지, 그리고 아직 보류 중인 모든 변경을 보여 줍니다. 보호 모드를 켜면 볼트에서 지갑으로 가는 모든 지급이 지연 기간을 기다리므로, 지갑을 빼앗은 도둑이 사용자가 알아차리기 전에 볼트를 비울 수 없습니다. 다른 사람의 볼트에서 사용자에게 오는 지급은 대신 사용자의 볼트로 들어가며, 사용자가 남에게 갚을 것은 지연되지 않습니다. 기본 모드에서 지연 기간은 프로토콜이 허용하는 가장 짧은 2일이고 포지션 NFT 보호는 꺼진 상태로 유지됩니다. 고급 모드에서는 최대 5일까지 고르고 포지션 NFT도 보호할 수 있습니다. 지금 잠그기는 대기 중인 모든 지급을 취소하고(자산은 볼트에 남습니다), 새 포지션을 막고, 보류 중인 모든 변경을 버립니다. 상환과 담보 추가는 계속 되며, 잠금은 일시 중지 중에도 작동합니다. 잠금 해제는 계정의 지연 기간이 지난 뒤에만 효력이 생기는 요청입니다. 기한이 되면 기한이 된 변경 적용이 다른 기한이 된 변경과 함께 이를 적용합니다. 지급 대기열은 카드 아래에 표시됩니다. 이 네트워크의 프로토콜에 보호 모드가 없으면 카드는 사용할 수 없다고 알립니다. 읽을 수 없으면 카드는 아무 조작도 제공하지 않고 꺼져 있다고 가정하지 말라고 알립니다. 각 작업은 지갑에 한 번 묻고, 완료 카드는 프로토콜이 기록한 내용을 보여 줍니다.

<a id="vault-escape"></a>

### 프로토콜이 일시 중지되었을 때

프로토콜이 일시 중지된 동안 볼트 페이지는 맨 위에서 이를 알립니다. 출금은 닫혀 있고, 전액·부분 상환과 담보 추가는 계속 열려 있습니다. 관리자 일시 중지라면 비상 탈출 경로가 언제 열리는지도 프로토콜이 알려 주는 대로 카운트다운과 함께 보여 줍니다. 경로가 열리면 출금 가능한 몫이 있는 자산에서 출금을 눌러 자신의 것을 지갑으로 바로 돌려받을 수 있습니다. 검토 화면은 비상 탈출 경로를 통한다고 알려 주며, 이 경로는 대출, 오퍼, 청구가 붙잡고 있는 것은 절대 돌려주지 않습니다. 보호 모드가 켜져 있으면 출금은 평소처럼 지급 대기열에서 계정의 지연 기간을 기다립니다. 자동 일시 중지나 아직 출시되지 않은 프로토콜은 비상 탈출 경로를 열지 않으며, 페이지는 예정된 경로가 없다고 알립니다.

<a id="protection-addresses"></a>

### 저장된 주소

Protection 페이지(계정 보안 카드에서 연결)는 지급을 맡길 수 있는 주소를 네트워크와 지갑별로 보관합니다. 이 목록은 이 브라우저에만 저장되며, 다른 브라우저나 기기에는 각자의 목록이 있습니다. 직접 관리하는 지갑을 저장하려면 이름을 붙이고 주소를 붙여 넣으세요. 페이지는 주소를 전부 보여 주고 확인했다고 체크하도록 요청합니다. 그러면 링크가 만들어집니다. 그 주소를 가진 지갑 앱에서 링크를 열고, 그 지갑을 연결해 서명하세요. 서명은 아무것도 옮기지 않으며 비용도 들지 않습니다. 표시된 코드를 페이지에 다시 붙여 넣으면 지갑이 검증됨으로 저장됩니다. 거래소 입금 주소는 서명할 수 없으므로, 세 가지 위험을 받아들이면 거래소 이름으로 미검증 상태로 저장됩니다. 주소가 틀리면 보낸 것을 잃고, 거래소가 볼트에서 보낸 입금을 반영하지 않을 수 있으며, 거래소가 나중에 그 주소를 다른 사람에게 줄 수 있습니다. 앱이 자금이나 권한을 받을 주소를 입력받는 모든 곳에서, 이미 쓰는 주소와 앞 세 글자와 뒤 세 글자가 같고 나머지가 다른 주소는 거부합니다. 주소 포이즈닝은 바로 이렇게 기록에서 복사하는 사람을 속이기 때문입니다.

<a id="protection-destinations"></a>

### 지급 대상

보호 모드가 켜져 있으면 Protection 페이지에 지급 대상도 표시됩니다. 내 지갑 외에, 보호된 지급이 갈 수 있는 주소를 최대 다섯 개까지 둘 수 있습니다. 지급 대상은 저장된 주소에서만 고를 수 있습니다. 추가를 요청해도 처음에는 아무것도 바뀌지 않습니다. 계정의 지연 기간이 지나야 쓸 수 있고, 그 뒤 한 번의 지연 기간 안에 활성화해야 하며, 그러지 않으면 만료되어 다시 요청할 수 있습니다. 대기 중인 요청은 본인이나 보조 서명자가 취소할 수 있고, 잠금은 모든 요청을 취소합니다. 지급 대상을 제거하면 즉시 적용되며 그 대상으로 대기 중인 모든 지급이 취소됩니다. 자산은 볼트에 남습니다. 각 변경은 지갑에 한 번만 확인을 요청하고, 검토 화면은 주소를 전부 보여 주며, 완료 카드는 프로토콜이 기록한 내용을 보여 줍니다. 보호 모드가 꺼져 있으면 지급은 내 지갑으로만 가고, 페이지는 지급 대상이 적용되지 않는다고 알려 줍니다.

<a id="protection-signers"></a>

### 보조 서명자

보호 모드가 켜져 있으면 Protection 페이지에 보조 서명자도 표시됩니다. 하드웨어 지갑처럼 계정을 지키기 위해 갖고 있는 다른 지갑입니다. 서명자는 대기 중인 변경을 취소하고, 계정을 잠그고, 대기열의 지급을 취소하거나 공동 서명이 필요할 때 공동 서명하고, 지급 대상을 제거할 수 있으며, 다른 서명자들과 함께 기본 지갑 교체를 승인할 수 있습니다. 볼트에서 무엇이든 옮기거나, 포지션을 열거나, 지급 대상이나 서명자를 추가하는 것은 절대 할 수 없습니다. 서명자는 서명으로 통제권을 증명한 저장된 지갑 중에서만 고를 수 있습니다. 요청해도 처음에는 아무것도 바뀌지 않습니다. 페이지가 보여 주는 링크를 요청받은 지갑이 열어 자신의 키로 수락합니다. 지연 기간이 지나고 수락되면, 다음 지연 기간 안에 요청을 활성화해야 합니다. 그렇지 않으면 만료되며, 다시 요청하기 전에 취소해야 합니다. 서명자 제거도 지연 기간을 기다리며, 다른 서명자가 제거를 취소할 수 있습니다. 모든 지급에 서명자의 공동 서명을 요구할 수도 있습니다. 켜는 것은 즉시, 끄는 것은 지연 기간을 기다리며, 마지막 서명자를 제거해도 꺼집니다. 서명자는 최대 다섯 명까지 둘 수 있습니다.

<a id="my-offers"></a>

### 내 오퍼

오퍼 페이지는 연결된 네트워크에서 내가 만든 모든 오퍼와, 지금 내가 포지션 토큰을 가진 모든 오퍼를 최신순으로 보여 줍니다. 각 오퍼에는 프로토콜이 보고하는 상태(열림, 체결, 매각, 만료, 취소)가 표시되고, 목록 위 필터가 상태별 개수를 셉니다. 차입 요청은 누군가 수락하기 전에 담보가 마켓플레이스 등록으로 팔렸을 때 매각으로 표시됩니다. 대출은 열리지 않았고, 판매 대금은 만든 사람의 볼트로 들어갔습니다. 열린 오퍼는 빌려주거나 담보로 잡은 자산을 체결되거나 취소될 때까지 내 볼트에 두고, 만료된 오퍼는 정리될 때까지 그대로 둡니다. 아무것도 체결되지 않은 오퍼를 프로토콜이 취소하면 조건이 지워지므로, 페이지에는 번호와 상태만 표시됩니다. 내가 만든 오퍼의 포지션 토큰을 다른 지갑이 가지고 있어도 나는 취소할 수 있고 반환분은 내게 옵니다. 다른 지갑이 만든 오퍼를 내가 가지고 있다면 만료 전에는 그 지갑만 취소할 수 있습니다. 내 오퍼 아래에는 오퍼 북이 있으며, 다음에서 설명합니다.

<a id="offer-book"></a>

### 오퍼 북

내 오퍼 아래의 오퍼 북은 네트워크의 모든 열린 오퍼를 최신순으로 보여 주며, 지갑을 연결한 뒤에만 읽습니다. 탭으로 토큰 대출과 NFT 임대를 나누고, 필터로 대출자의 오퍼, 차입자의 요청 또는 둘 다를 보며, 연결한 뒤에는 내 오퍼를 숨길 수 있습니다. 이전 오퍼는 「이전 오퍼 보기」로 불러옵니다. 필터는 읽어 온 오퍼에 적용되며, 개수 줄이 그 수를 알려 줍니다. 오퍼 북은 체인보다 몇 분 늦을 수 있는 프로토콜의 인덱스에서 오므로 오퍼를 가리킬 뿐입니다. 체인이 보관한 그대로 보려면 오퍼를 여세요. 만료가 지난 오퍼에는 만료 태그가 붙고, 누구나 정리할 수 있으며, 잠겨 있던 자산은 생성자에게 돌아갑니다. 인덱스를 읽을 수 없으면 오퍼가 없다고 보여 주는 대신 그렇다고 알려 줍니다.

<a id="offer-detail"></a>

### 오퍼 페이지

모든 오퍼에는 자체 페이지가 있으며, 지갑을 연결한 뒤 체인에서 읽습니다. 게시자, 금액, 이미 체결된 양, 담보, 기간, 오퍼가 만료되는 시점을 보여 줍니다. 그곳에서 열린 대출 오퍼를 통째로 받을 수 있으며, 빌리기·빌려주기와 같은 검토와 동의를 거칩니다. 대출자의 오퍼에서 빌리거나 차입자의 요청에 자금을 댑니다. 취소와 정리는 내 오퍼에서와 똑같이 그곳에서 작동합니다. 임대, NFT 담보 오퍼, 진행 중인 대출의 매각, 조기 종료 오퍼는 당분간 현재 앱에서 받으며, 페이지에서 링크합니다. 검토하는 동안 오퍼는 예약되지 않으므로 다른 사람이 먼저 받거나 취소할 수 있습니다.

<a id="offer-cancel"></a>

### 오퍼 취소

내가 만든 열린 오퍼에서 취소를 누르면 북에서 내리고 내 볼트에 아직 묶어 둔 것을 돌려줍니다. 대출 오퍼는 빌려주지 않은 금액이나 NFT, 요청은 쓰지 않은 담보, 대여 요청은 선불 요금과 버퍼입니다. 아무것도 체결되지 않은 오퍼는 처음 5분 동안 취소할 수 없어, 취소가 누군가의 수락과 경쟁하지 않습니다. 검토 화면이 언제 가능한지 알려 주고 시간이 지나면 스스로 해제합니다. 이미 체결된 부분은 그대로 체결된 상태로 남습니다. 만료된 오퍼에는 정리 버튼이 있어 같은 방식으로 묶어 둔 것을 돌려줍니다. 만료된 오퍼는 누구나 정리할 수 있으며 반환분은 항상 만든 사람에게 갑니다. 검토 화면은 무엇이 어디로 돌아오는지 알려 줍니다. 보호 모드가 없으면 즉시 지갑으로, 있으면 계정의 지연 시간 동안 지급 대기열에서 기다리거나 계정이 잠긴 동안 볼트에 남습니다. 진행 중인 대출에 묶인 오퍼처럼 앱이 반환액을 계산할 수 없으면 그렇게 알리고, 완료 카드가 실제로 움직인 것을 보여 줍니다. 프로토콜이 일시 중지된 동안에는 취소할 수 없습니다. 지갑에서 나가는 것이 없고 승인도 요청하지 않으므로 지갑은 한 번만 묻습니다.

<a id="offers-price-guard"></a>

### 가격 변동 보호

토큰 담보에 대한 토큰 오퍼에는 가격 변동 보호를 걸 수 있습니다. 오퍼가 오더북에서 기다리는 동안 가격은 움직이고, 누군가 시장이 자신에게 유리하게 움직인 순간에 그 오퍼를 받아 갈 수 있습니다. 오퍼 페이지에서 0.5%에서 50% 사이의 한도를 정하면, 보호를 건 이후 담보 대비 원금 비율이 그 한도보다 많이 움직인 동안이나 페어의 시장이 안정되지 않은 동안 오퍼는 체결을 거부합니다. 오퍼를 보는 사람은 누구나 보호와 지금 체결이 가능한지를 볼 수 있습니다. 이미 올린 오퍼에 걸면 기록된 순간부터만 보호합니다. 아무것도 옮기지 않으며, 오퍼가 열려 있는 동안 바꾸거나 해제할 수 있습니다. 고급 모드에서는 오퍼를 올릴 때 보호를 함께 걸 수도 있어, 오퍼가 목록에 오르는 순간부터 보호됩니다.

<a id="risk-access"></a>

### Risk Access: 내 위험 등급

모든 계정은 가장 낮은 위험 등급인 블루칩 자산 전용에서 시작하며, 이를 올릴 수 있는 사람은 본인뿐입니다. 한 쌍에는 더 위험한 토큰의 등급이 필요합니다. 블루칩 토큰은 아무것도 필요 없고, 다른 유동성 토큰은 “유동성 자산”, 비유동성 토큰은 “비유동성을 포함한 모든 자산”과 함께 바로 그 쌍에 대한 본인의 동의가 필요합니다. 오퍼 수락이나 요청 게시에 이런 단계가 필요하면, 검토 화면이 그 자리에서 알려 주고 자체 영수증과 함께 한 번의 지갑 확인으로 제시합니다. 무엇이 바뀌는지, 어떤 쌍에 적용되는지, 언제 효력이 생기는지, 자금은 움직이지 않는다는 것입니다. 등급을 올리거나 쌍에 동의하면 프로토콜이 정한 대기 기간이 있을 수 있습니다. 올린 등급에 대해서는 앱이 체인에서 읽은 효력 발생 시각을 보여 주고, 동의에 대해서는 프로토콜이 그 시각을 아직 공개하지 않는다고 알리며, 같은 단계를 두 번 제시하지 않습니다. 두 번째 단계는 대기를 다시 시작하게 하기 때문입니다. 등급 낮추기는 언제나 즉시 효력이 있습니다. 프로토콜이 새 위험 약관을 공개하면, 다시 확인할 때까지 등급과 동의는 인정되지 않습니다. 엄격 모드를 켰다면 유동성 쌍마다 본인의 확인도 필요합니다. 대출자 본인의 위험 등급 때문에 생긴 차단은 대출자의 것으로 표시됩니다. 내 계정에서 바꿀 수 있는 것은 없습니다.

<a id="terms-gate"></a>

### 이용약관 확인

이용약관 버전이 시행 중이면, 앱은 수수료 할인을 켜는 것처럼 새로운 것을 시작하는 작업 전에 약관 동의를 요청하고 어떤 작업이 요청했는지 알려 줍니다. 버전, 본문의 지문, 그리고 본문이 절대 바뀌지 않는 바로 그 버전으로의 링크를 보여 줍니다. 동의는 지갑에서 한 번 확인하는 것이며 자금은 움직이지 않습니다. 동의 여부를 읽을 수 없으면 앱은 그렇다고 알리고 다시 시도하게 하며, 이를 거부로 취급하지 않습니다. 상환, 청구, 내 자산 출금, 내 오퍼 취소, 동의 끄기는 절대 막히지 않습니다.

<a id="settings"></a>

### 설정

설정은 메뉴 맨 아래에 있습니다. 모드, 테마, 언어는 지갑 없이 쓸 수 있고 이 브라우저에 저장됩니다. 테마는 직접 고르기 전까지 기기 설정을 따르고, 아직 번역되지 않은 언어는 번역될 때까지 영어로 표시됩니다. 지갑을 연결하면 이 네트워크에서 동의한 서비스 약관 버전, 또는 시행 중이지만 아직 동의하지 않은 버전이 있다는 것이 표시됩니다. 동의는 그것이 필요한 첫 작업에서 요청되며, 설정에서는 요청되지 않습니다. 수수료 할인 설정은 홈에 있는 것과 같습니다. 설정은 이 브라우저가 앱을 위해 보관하는 것, 비밀 정보는 보관하지 않는다는 것, 앱이 오류 보고나 진단 정보를 보내지 않는다는 것도 알려 줍니다. 설정에서는 이 브라우저에 있는 앱의 기록을 파일로 내려받거나, 이 사이트가 여기에 보관하는 모든 것을 지울 수도 있습니다. 지우기 전에 몇 개 항목이 삭제되는지 알려 주며, 지우면 지갑 연결이 끊기고 모드, 테마, 언어가 기본값으로 돌아간 뒤 삭제된 내용이 표시됩니다. 온체인 포지션, 알림 서비스에 있는 알림 설정, 소개 사이트, 지갑 앱에는 영향이 없습니다.

설정에서는 이 네트워크에서의 내 위험 등급, 이 네트워크가 그것을 적용하는지, 엄격 모드가 켜져 있는지도 말로 보여 줍니다. 새 위험 약관 때문에 등급이 인정되지 않게 되었다면, 그곳에서 지갑 단계 한 번으로 다시 확인할 수 있습니다. 등급을 올리거나 낮추거나 엄격 모드를 켜고 끄려면 **Advanced** 모드로 바꾸세요. 모든 변경은 자체 영수증이 있는 한 번의 지갑 확인이며 자금을 움직이지 않습니다. 낮추기는 즉시 효력이 생기고, 새 등급보다 위인 쌍을 새 오퍼와 요청에 대해 닫습니다. 내가 열어 둔 것도 포함됩니다. 이미 있는 대출에는 영향이 없습니다. 올리기는 프로토콜의 대기 기간이 걸릴 수 있으며, 앱이 언제부터 인정되는지 보여 줍니다.

설정에서는 이 네트워크에서 내 지갑이 프로토콜에 주고 있는 상시 승인도 보여 줍니다. 다시 묻지 않고 토큰을 얼마나 옮길 수 있는지, 또는 NFT 컬렉션 전체나 NFT 하나에 대한 승인입니다. 각각은 자금을 움직이지 않는 한 번의 지갑 확인으로 철회할 수 있습니다. 목록은 제안된 자산과 여기서 내 예치, 대출, 오퍼가 가리키는 모든 자산을 확인하며, 다른 토큰을 추가해 확인할 수도 있습니다. 그 밖의 토큰에 대한 승인은 그곳에서 찾을 수 없으므로 나머지는 지갑에서 볼 수 있습니다. 다른 승인이 같은 자산도 다루는 경우(NFT 하나에 대한 컬렉션 전체 승인 등), 검토 화면은 그 승인이 철회 후에도 남는다고 알려 줍니다.

설정에서는 이 네트워크에서 키퍼가 당신의 지갑을 대신해 움직일 수 있는지와 승인한 키퍼도 보여줍니다. 처음에는 모두 꺼져 있습니다. 키퍼는 키퍼 접근이 켜져 있고 해당 작업을 가지고 있을 때만 움직이며, 대출에 대한 단계는 그 대출이나 오퍼가 키퍼를 지정해야 합니다. 키퍼는 당신의 자금을 절대 받지 않으며 아무것도 청구, 출금, 이전할 수 없습니다. 키퍼 접근을 끄거나 키퍼를 제거하는 것은 어느 모드에서든 지갑 확인 한 번으로 할 수 있습니다. 접근을 켜거나 키퍼를 승인하거나 할 수 있는 일을 바꾸려면 **Advanced** 모드로 바꾸세요.

앱을 휴대폰이나 컴퓨터에 설치할 수도 있습니다. 홈 화면이나 앱 목록에서 열리고 오퍼, 포지션, 금고, 알림 바로가기가 생깁니다. 브라우저의 앱 설치 또는 홈 화면에 추가 옵션을 쓰거나(iPhone이나 iPad: Safari에서 공유, 홈 화면에 추가), **Advanced** 모드에서 브라우저가 제공하는 경우 설정의 앱 설치를 쓰세요. 앱은 더 빨리 열리도록 자체 코드 파일의 사본을 보관하며, 당신의 포지션과 모든 수치는 항상 네트워크에서 읽습니다.

<a id="rent-review"></a>

### 대여: NFT 빌리기

메뉴의 대여에는 소유자가 내 네트워크에서 대여로 내놓은 NFT가 표시됩니다. 테스트 네트워크에 아무것도 없으면 테스트 NFT와 테스트 토큰을 받을 수 있는 포싯을 안내합니다. 대여로 얻는 것은 정해진 날수 동안 NFT를 쓸 권리이며, NFT 자체는 아닙니다. NFT는 소유자의 볼트에 남고, 볼트는 대여가 끝날 때까지 나를 사용자로 기록합니다. 대여 오퍼를 열고 "이 NFT 빌리기"를 고르세요. 검토 화면은 내 지갑에서 내 볼트로 옮겨지는 것을 보여 줍니다. 전체 기간의 일일 요금과, 오퍼를 올릴 때 정해진 대여료의 작은 몫인 버퍼입니다. 요금 규칙(일할: 쓴 날수만큼이며 하루를 다 못 채워도 하루로 셈, 또는 전체 기간), 제때 종료하면 돌아오는 것, 유예 기간, 버퍼에서 떼는 연체료도 보여 줍니다. 대여에는 담보도 건전성 지수도 없습니다. 지갑 잔액이 대여료와 버퍼의 합보다 적으면 지갑 단계 전에 그렇게 알려 줍니다. 그다음 지갑이 비용이 들지 않는 조건 서명, 필요하면 정확히 그 금액의 승인, 그리고 대여 시작을 요청합니다. 시작은 앱이 먼저 시험 실행으로 확인합니다. 이후 앱은 체인에서 시작된 대여, 내 볼트로 들어온 금액, 내가 이제 NFT의 사용자라는 점을 확인합니다.

<a id="rent-risks"></a>

### 대여: 위험

빌린 NFT는 절대 내 것이 되지 않으며, 쓸 권리는 대여가 끝나면 함께 끝납니다. 대여료와 버퍼는 대여를 위해 내 볼트에 머물고, 대여가 열려 있는 동안 출금할 수 없습니다. 약정한 모든 날이 정산되면(정산은 누구나 할 수 있습니다) 대여는 저절로 종료되고 버퍼를 청구할 수 있습니다. 그 전에는 해당 포지션 페이지에서 직접 종료하세요. 유예 기간 중에 종료하면 버퍼에서 연체료를 뗍니다. 유예 기간이 지나면 대여는 디폴트되어 내 볼트에 남은 대여료는 소유자에게, 버퍼는 프로토콜로 가고 나에게는 아무것도 돌아오지 않습니다. 전체 기간 요금이면 일찍 종료해도 전체 기간을 냅니다.

<a id="rent-list"></a>

### 대여: 내 NFT를 대여로 내놓기

대여에서 "NFT 대여로 내놓기"를 누르면 짧은 양식이 열립니다. 컬렉션(테스트 네트워크에서는 테스트 컬렉션, 또는 붙여 넣은 주소), 토큰 번호와 멀티 토큰 컬렉션이면 수량, 대여자가 지불할 토큰, 일일 요금(하나의 값), 기간(일), 요금 규칙(일할 또는 전체 기간), 오퍼를 열어 둘 기간입니다. 담보나 이자 칸은 없습니다. 대여에는 둘 다 없기 때문입니다. 검토 화면은 NFT가 내 지갑에서 내 볼트로 옮겨진다는 점, 대여자가 미리 내는 금액, 이 오퍼가 오늘 설정으로 고정하는 버퍼 비율, 내가 받는 것(지급할 대여료에서 프로토콜 몫을 뺀 금액이며, 그 몫은 대여자가 오퍼를 받을 때 고정됨), 유예 기간, 디폴트 시 처리를 보여 줍니다. 지갑에 그 NFT가 없으면 지갑 단계 전에 그렇게 알려 줍니다. 그다음 지갑이 프로토콜이 그 토큰 하나만 옮기도록 허용하는 승인(멀티 토큰 컬렉션이면 이 오퍼만을 위해 컬렉션 전체를 승인하고 나중에 한 단계 더 거쳐 거둬들임)과 오퍼 게시를 요청합니다. 게시는 앱이 먼저 시험 실행으로 확인합니다. 이후 앱은 체인에서 오퍼가 기록되고 NFT가 내 볼트에 도착했는지 확인하고 오퍼 페이지로 연결합니다.

<a id="rent-list-risks"></a>

### 대여: 대여로 내놓을 때의 위험

오퍼가 열려 있는 동안과 대여 중에는 NFT가 내 볼트에 머물며, 오퍼나 대여가 끝날 때까지 출금할 수 없습니다. 아무도 빌리지 않았다면 처음 5분이 지난 뒤 오퍼 페이지에서 취소할 수 있습니다. 대여된 뒤에는 대여가 끝날 때까지 대여자가 NFT를 쓸 권리를 가지며, 일찍 되찾을 수 없습니다. 끝난 하루가 정산될 때마다 프로토콜 몫을 뺀 대여료가 내 볼트로 들어옵니다. 정산은 누구나 할 수 있습니다. 약정한 모든 날이 정산되면 대여는 저절로 종료되고, 대여자는 버퍼를 청구할 수 있습니다. 그 전에는 대여자가 종료하거나, 유예 기간이 지나면 누구나 디폴트로 종료할 수 있습니다. 대여자가 종료하면 아직 정산되지 않은 대여료와 연체료를 프로토콜 몫을 빼고 청구할 수 있으며, 남은 버퍼는 대여자에게 돌아갑니다. 디폴트가 되면 남은 대여료를 그 몫을 빼고 청구할 수 있으며, 버퍼는 프로토콜로 갑니다. 일시 중지 중에는 매일의 정산이 멈추고 연체료와 디폴트 기한이 뒤로 밀리지만, 대여자의 사용 기간은 늘어나지 않습니다. 만료된 오퍼는 닫힐 때까지 NFT를 내 볼트에 둡니다.

<a id="rent-request"></a>

### 대여: NFT 대여 요청하기

대여 페이지의 대여 요청 올리기는 오퍼와 같은 짧은 양식을 대여자인 나에게 맞춘 말로 엽니다. 컬렉션과 토큰 번호(멀티 토큰 컬렉션이면 수량도), 지불할 토큰, 하나의 숫자로 된 일일 요금, 일 단위 기간, 대여료 규칙, 요청을 열어 둘 기간입니다. 검토 화면은 전체 기간의 대여료와 버퍼가 지금 내 지갑에서 내 볼트로 옮겨진다는 것, 이 요청이 오늘의 설정으로 고정하는 버퍼 비율, 기간은 소유자가 요청을 받아들일 때부터 시작된다는 것, 그리고 받아들인 소유자가 내 추가 단계 없이 곧바로 대여를 시작한다는 것을 보여 줍니다. 지갑의 잔액이 부족하거나 그 NFT를 이미 가지고 있으면 지갑 단계 전에 알려 주며, 아직 존재하지 않는 토큰은 따로 표시합니다. 그다음 지갑이 대여료와 버퍼를 정확히 그만큼만 승인하고 요청을 올리며, 앱은 먼저 이를 드라이런으로 시험합니다. 이후 앱은 체인에서 요청이 기록되고 대여료와 버퍼가 볼트에 도착했는지 확인하고, 요청 페이지로 연결합니다.

<a id="rent-request-risks"></a>

### 대여: 대여 요청의 위험

요청이 열려 있는 동안 대여료와 버퍼는 내 볼트에 머물며, 요청을 취소하거나 끝날 때까지 출금할 수 없습니다. 아직 어떤 소유자도 받아들이지 않았다면 처음 5분이 지난 뒤 요청 페이지에서 취소할 수 있고, 둘 다 지갑으로 돌아옵니다. 받아들인 소유자는 정확히 이 조건으로 곧바로 대여를 시작합니다. 내가 갖는 것은 NFT를 쓸 권리이며, NFT 자체는 결코 아닙니다. 약정한 모든 날이 정산되면(정산은 누구나 할 수 있습니다) 대여는 저절로 종료되고 버퍼를 청구할 수 있습니다. 그 전에는 포지션 페이지에서 종료하세요. 늦게 종료하면 버퍼에서 연체료가 빠지고, 디폴트가 되면 대여료는 소유자에게, 버퍼는 프로토콜로 갑니다. 만료된 요청은 닫힐 때까지 대여료와 버퍼를 볼트에 남깁니다. 버퍼 비율은 요청이 기록되는 시점의 프로토콜 설정입니다. 검토 후에 바뀌면, 지갑이 정확히 이 금액만 승인했을 때 더 높은 비율은 거부되고, 이전 승인이 이를 덮으면 인출되며, 결과에 실제로 옮겨진 금액이 표시됩니다.

<a id="rent-take"></a>

### 대여: 대여자의 요청 받기

대여자의 요청은 정해진 조건으로 NFT 하나를 빌리고 싶다는 글이며, 대여자는 대여료와 버퍼를 이미 자신의 볼트에 넣어 두었습니다. 요청 페이지는 이를 알리고 "내 NFT 빌려주기"를 보여 줍니다. 검토 화면은 NFT가 내 지갑에서 내 볼트로 옮겨진다는 점, 대여자가 누구인지, 그리고 대여자가 지금부터 기간 동안 NFT를 쓸 권리를 얻을 뿐 NFT 자체는 얻지 않는다는 점을 보여 줍니다. 요청이 정한 일일 요금, 기간, 요금 규칙, 대여자의 볼트에 이미 있는 대여료와 버퍼, 내가 받는 것(대여료에서 대여 시작 때 정해지는 프로토콜 몫을 뺀 금액이 끝난 하루가 정산될 때마다 내 볼트로 들어오고, 나머지는 종료 때 들어옴), 유예 기간, 디폴트 시 일어나는 일도 보여 줍니다. 내 지갑에 그 NFT가 없거나 수량이 모자라면 지갑 단계 전에 그렇게 알려 주고, 갖게 되면 스스로 다시 읽습니다. 그다음 지갑이 비용이 들지 않는 조건 서명, 프로토콜이 그 토큰 하나를 옮기도록 허용(멀티 토큰 컬렉션은 이 대여에 한해 컬렉션 전체이며, 이후 한 단계 더 거쳐 거둬들임), 그리고 대여 시작을 요청합니다. 시작은 앱이 먼저 시험 실행으로 확인합니다. 이후 앱은 체인에서 시작된 대여, NFT가 내 볼트에 도착했는지, 내 볼트가 대여자를 사용자로 기록했는지 확인하고 대여로 가는 링크를 보여 줍니다.

<a id="rent-take-risks"></a>

### 대여: 요청을 받을 때의 위험

NFT는 대여 기간 내내 내 볼트에 머물며, 대여가 열려 있는 동안 출금할 수 없습니다. 대여자는 대여가 끝날 때까지 그것을 쓸 권리를 가지며, 나는 그 권리를 일찍 되찾을 수 없습니다. 조건은 요청의 것입니다. 일일 요금, 기간, 요금 규칙, 버퍼는 바꿀 수 없습니다. 끝난 하루가 정산될 때마다 프로토콜 몫을 뺀 대여료가 내 볼트로 들어옵니다. 정산은 누구나 할 수 있습니다. 약정한 모든 날이 정산되면 대여는 저절로 종료되고, 대여자는 버퍼를 청구할 수 있습니다. 그 전에는 대여자가 종료하거나, 유예 기간이 지나면 누구나 디폴트로 종료할 수 있습니다. 대여자가 종료하면 아직 정산되지 않은 대여료와 연체료를 프로토콜 몫을 빼고 청구할 수 있으며, 남은 버퍼는 대여자에게 돌아갑니다. 디폴트가 되면 남은 대여료를 그 몫을 빼고 청구할 수 있으며, 버퍼는 프로토콜로 갑니다. 일시 중지 중에는 매일의 정산이 멈추고 연체료와 디폴트 기한이 뒤로 밀리지만, 대여자의 사용 기간은 늘어나지 않습니다. 자체 버퍼를 기록하지 않은 요청은 대여가 시작될 때 오늘의 설정을 따릅니다.

<a id="rent-close"></a>

### 대여: 대여 종료하기

진행 중인 대여의 페이지는 대여자인 나에게 대여 종료하기를 보여 줍니다. 종료하면 밀린 대여료와 연체료가 내 볼트에 미리 낸 대여료와 버퍼에서 지급되므로 지갑에서는 아무것도 빠져나가지 않고 승인도 필요 없습니다. 검토 화면은 지금 종료할 때와 조금 뒤의 한 시점에 종료할 때의 대여료를 대여료 규칙대로 세어 보여 줍니다(일할: 시작 후 쓴 날, 하루 중 일부도 하루로 세고 이미 정산된 날은 뺌; 전체 기간: 아직 정산되지 않은 약정일 전부). 이미 정산된 날, 연체료, 청구로 나에게 돌아오는 금액, 소유자가 받는 금액(대여료와 연체료에서 프로토콜 몫을 뺀 금액)도 보여 줍니다. 선납금으로 종료를 감당할 수 없으면 지갑이 열리기 전에 검토 화면이 알려 줍니다. 그다음 지갑이 대여 종료를 한 번 요청하며, 앱은 먼저 드라이런으로 시험합니다. 이후 앱은 대여가 종료되었는지, 나에게 기록된 청구, 내 사용이 끝났는지를 체인에서 확인합니다. 돌아오는 금액은 Claims 페이지에서 받으세요.

<a id="rent-close-risks"></a>

### 대여: 종료의 위험

종료하면 약정일이 남아 있어도 NFT를 쓸 권리가 즉시 끝나며 되돌릴 수 없습니다. 대여료는 종료가 체인에 기록되는 시점에 세므로 그 전에 시작된 날은 하루로 냅니다. 전체 기간 요금이면 아무리 일찍 종료해도 아직 정산되지 않은 약정일을 모두 냅니다. 기간이 끝난 뒤에는 버퍼에서 연체료를 뗍니다. 전체 대여료의 1%에 늦은 날마다 0.5%를 더하며, 최대 5%이고 버퍼를 넘지 않습니다. 유예 기간이 지나면 프로토콜이 종료를 거절하며, 이후 대여는 남은 날이 하루씩 정산되어 끝나거나(누구나 할 수 있습니다) 디폴트로 끝나며, 먼저 일어나는 쪽으로 끝납니다. 검토 화면이 보여 주는 이후 시점은 기한도 한도도 아닙니다. 더 늦게 기록된 종료는 그 시점에 계산되므로 대여료나 연체료가 더 나가고 돌아오는 금액이 줄 수 있습니다. 돌아오는 금액은 받을 때까지 청구로 내 볼트에 남습니다.

<a id="rewards-vpfi"></a>

### 리워드: 볼트의 VPFI

메뉴의 리워드는 이 네트워크에서의 리워드, VPFI, 수수료 할인 동의를 보여 줍니다. 리워드는 Home에 표시되는 이용 리베이트이며 같은 방법으로 청구합니다. 그 아래에 VPFI가 표시됩니다: 지갑에 있는 양, 내 볼트에 집계된 양, 지금 출금할 수 있는 양, 대출·오퍼·청구·지급을 위해 묶인 양입니다. 집계된 VPFI가 수수료 할인 등급을 정하며, 등급은 동의가 켜져 있는 동안에만 수수료를 낮춥니다. 입금 없이 볼트로 직접 보낸 VPFI는 집계되지 않으며 등급을 올리지 않습니다. 페이지는 이를 보여 주고 이를 편입할 수 있는 Vault 페이지를 안내합니다. 'VPFI 입금'은 지갑에서 내 지갑만 제어하는 내 볼트로 VPFI를 옮기며, 아직 약관에 동의하지 않았다면 먼저 동의를 요청합니다. 첫 입금이 볼트를 만듭니다. 'VPFI 출금'은 자유로운 VPFI를 지갑으로 되돌립니다. 각 검토 화면은 그 작업이 등급에 미치는 영향과 동의가 켜져 있는지를 알려 주고, 이후 앱이 체인에서 결과를 확인합니다. VPFI가 설정되지 않은 네트워크에서는 페이지가 그렇다고 알리고 둘 다 제공하지 않습니다. 등급을 정하는 것은 VPFI의 홈 네트워크에 있는 볼트의 VPFI뿐입니다. 다른 네트워크는 그곳에서 계산된 등급의 사본을 적용하므로, 그곳에서는 페이지와 각 검토 화면이 VPFI를 옮겨도 등급이 바뀌지 않는다고 알려 줍니다.

<a id="rewards-vpfi-risks"></a>

### 리워드: VPFI 이동의 위험

등급은 오늘의 잔액이 아닙니다. 현재 보유가 최소 일수 동안 이어질 때까지는 0입니다. 그 뒤에는 최근 날짜에 더 큰 가중치를 두는 일별 보유량 평균을 따릅니다. 이와 별도로, 현재 보유 기간 중 어느 날이든 가졌던 가장 낮은 등급을 넘지 않으며, 거슬러 보는 기간은 최대 30일입니다. 따라서 입금은 시간이 지나야 등급을 올리고, 잠깐의 추가 입금으로는 오르지 않습니다. 집계된 VPFI 일부를 출금하면 등급이 낮아질 수 있고, 모두 출금하면 보유 기간이 다음 입금부터 다시 시작됩니다. 대출·오퍼·청구·지급을 위해 묶인 VPFI는 풀릴 때까지 출금할 수 없으며, 보호 계정의 출금은 먼저 지연 시간을 기다립니다. 보호 계정의 출금은 풀릴 때에만 집계된 VPFI와 등급을 바꾸며, 취소된 출금은 둘 다 바꾸지 않습니다. 볼트의 VPFI는 담보가 아니며 어떤 대출도 뒷받침하지 않습니다. 프로토콜은 VPFI를 판매하지 않고, 가격을 제시하지 않으며, 보유에 대해 아무것도 지급하지 않습니다.

<a id="rewards-tier"></a>

### 리워드: 수수료 할인 등급

VPFI 아래에 프로토콜이 지금 수수료에 적용하는 수수료 할인 등급과 그로 인해 줄어드는 비율이 프로토콜에서 직접 읽어 표시됩니다. 수수료 할인 동의가 꺼져 있는 동안에는 어떤 등급도 적용되지 않습니다. 새 보유는 시간이 지나야 온전히 계산되므로, 보유 규칙 때문에 등급이 집계된 VPFI만으로 얻을 등급보다 낮게 유지될 때 페이지가 이를 알려 줍니다. VPFI의 홈 네트워크에서는 표가 각 등급을 보여 줍니다: 필요한 집계 VPFI, 그 할인, 그리고 그 할인을 적용한 대출 개시 수수료와 받은 이자에 대한 수수료로, 네트워크의 현재 설정으로 계산됩니다. 각 등급은 그 수치에서 시작하지만, 최상위 등급만은 그 수치를 바로 넘어서부터 시작합니다. 어떤 할인도 수수료의 절반을 넘지 않습니다. 다른 네트워크에서는 홈 네트워크에서 보낸 등급이 표시되며, 표는 표시되지 않습니다. 페이지는 등급을 낮추고 있는 보유 규칙을 알려 주고, 동의가 꺼져 있으면 켰을 때 어떤 등급이 적용될지 알려 줍니다.

<a id="rewards-vpfi-sign"></a>

### 리워드: 승인 대신 서명

지갑이 이미 VPFI에 대해 Permit2(여러 앱이 서명으로 토큰을 옮길 때 쓰는 공용 컨트랙트)를 승인해 두었다면, VPFI 예치 검토 화면에 "승인 대신 서명"이 표시됩니다. 이 경우 정확히 그 금액의 1회용 전송에 서명하고(30분간 유효) 예치를 보냅니다. 지갑 단계는 두 번이며 프로토콜에 대한 승인은 없습니다. 서명은 한 번만, 본인 지갑이 보내는 트랜잭션에서만, 본인 보관함으로만 쓰일 수 있으며, 쓰이지 않으면 만료됩니다. 앱은 Permit2 자체를 승인하라고 요청하지 않습니다. 그 승인은 기한이 없고 다른 앱과 공유되기 때문입니다. 그것이 없으면 검토 화면은 정확히 그 금액에 대한 일반 승인을 그대로 씁니다. Permit2가 없는 네트워크에서는 이 선택지가 표시되지 않습니다.

<a id="desk-markets"></a>

### Rate desk: 마켓과 금리 래더

메뉴의 Advanced 아래에 있는 Rate desk는 이 네트워크의 열린 토큰 대출 오퍼를 마켓별로 묶어 보여 줍니다. 마켓은 하나의 기간 동안 담보 토큰 하나에 대해 빌려주는 토큰 하나의 조합입니다. 각 마켓은 대출자 오퍼와 차입자 요청이 몇 개인지, 그리고 양쪽의 최고 금리를 보여 줍니다. 마켓을 고르면 금리 래더가 나타납니다. 대출자 오퍼는 가장 낮은 금리부터 위로, 차입자 요청은 가장 높은 금리부터 아래로 놓입니다. 각 금리에는 그 금리에 있는 오퍼 수와 열린 금액의 합계가 표시됩니다. 이 합계는 깊이이며 한 번에 받을 수 있는 금액이 아닙니다. 모든 오퍼는 각자의 담보와 조건으로 따로 받아집니다. 중간 금리는 가장 좋은 두 금리의 한가운데이며, 앱이 계산한 값이지 프로토콜이 보고하는 값이 아닙니다. Rate desk는 프로토콜의 인덱스를 읽는데, 인덱스는 체인보다 몇 분 늦을 수 있고, 오퍼의 자체 페이지는 받기 전에 체인에서 확인합니다. 서명된 주문은 마켓 수에는 포함되지만 래더에는 아직 나오지 않습니다. Basic 모드에서는 위쪽 카드가 이 페이지가 무엇인지 알려 주고, 같은 일을 단계별로 하는 Borrow와 Lend로 연결합니다.
