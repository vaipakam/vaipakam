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

## Dashboard

<a id="dashboard.your-escrow"></a>

### 내 Escrow

**escrow**는 Vaipakam 안에 있는 내 전용 금고라고 생각하면 됩니다.
나만을 위해 준비되는 작은 contract입니다. loan에 참여할 때마다 —
collateral을 넣든 asset을 빌려주든 — assets는 wallet에서 이 금고로
이동합니다. 다른 사람의 자금과 섞이지 않습니다. loan이 끝나면 여기서
직접 claim해 되찾습니다.

escrow를 직접 "만들" 필요는 없습니다. 처음 필요해지는 순간 앱이
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

**VPFI**는 protocol 자체 token입니다. escrow에 넣어 두면 protocol
fees 할인을 받고, 작은 passive yield(5% APR)도 얻습니다. 이 카드는
현재 연결된 chain에 대해 다음을 보여줍니다:

- 지금 wallet에 있는 VPFI 양.
- escrow에 있는 양("staked"로 간주됩니다).
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

Vaipakam은 escrow에 둔 VPFI 일부를 사용해 protocol fees 할인을 적용할
수 있습니다. 이 switch는 "네, 그렇게 해 주세요"라는 consent toggle
입니다. 한 번만 켜면 됩니다.

할인의 크기는 escrow에 얼마나 많은 VPFI를 보관하느냐에 따라
달라집니다:

- **Tier 1** — `{liveValue:tier1Min}` VPFI 이상 → `{liveValue:tier1DiscountBps}`% off
- **Tier 2** — `{liveValue:tier2Min}` VPFI 이상 → `{liveValue:tier2DiscountBps}`% off
- **Tier 3** — `{liveValue:tier3Min}` VPFI 이상 → `{liveValue:tier3DiscountBps}`% off
- **Tier 4** — `{liveValue:tier4Min}` VPFI 초과 → `{liveValue:tier4DiscountBps}`% off

스위치는 언제든 끌 수 있습니다. escrow에서 VPFI를 인출하면
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

두 가지 보상 스트림이 있으며 카드는 각각에 따라 합계를 분류
합니다:

- **스테이킹 수익** — 에스크로에 보관하는 모든 VPFI에 대해
  자동으로 획득됩니다. 비율은 Buy VPFI 페이지에 표시되는 프
  로토콜 APR입니다.
- **플랫폼 상호작용 보상** — 양쪽 어느 쪽이든 참여하는 각
  대출에 대해 매일 조금씩 획득됩니다. 현재 체인의 VPFI로 지
  급되며 브리지가 필요 없습니다.

각 행 오른쪽에 작은 셰브론 화살표가 있습니다. 클릭하면 해당
스트림의 전체 청구 카드로 바로 이동합니다 — 스테이킹은 Buy
VPFI 페이지에, 플랫폼 상호작용은 Claim Center에 있습니다.

아직 아무것도 획득하지 않았어도 카드는 *총 획득액: 0 VPFI*
와 시작하는 방법에 대한 힌트와 함께 렌더링됩니다. 잘못한
것이 없습니다 — 표시할 기록이 없을 뿐입니다.


---

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
됩니다. borrower의 collateral은 escrow에 lock되고, principal asset은
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
의 rate로 interest를 얻습니다. interest의 작은 일부(1%)는 settlement
시 protocol treasury로 갑니다.

---

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
길어질 경우에 대비해 작은 5% buffer도 냅니다. NFT 자체는 계속 escrow
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
다만 interest 부분에서 1% treasury cut이 차감됩니다. loan이 settle되는
즉시(repaid, defaulted, 또는 liquidated) claimable이 됩니다. claim은
lender position NFT를 atomically consume합니다 — 완료되면 그 side의
loan은 완전히 close됩니다.

<a id="claim-center.claims:borrower"></a>

#### 내가 borrower인 경우

loan을 full repay했다면 borrower claim은 시작할 때 lock한 collateral을
돌려줍니다. default 또는 liquidation 시에는 Loan Initiation Fee에서
unused VPFI rebate만 반환됩니다 — collateral 자체는 이미 lender에게
갔습니다. claim은 borrower position NFT를 atomically consume합니다.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

연결된 chain에서 내 wallet과 관련된 모든 on-chain events를 보여줍니다
— 내가 게시하거나 accept한 offers, loans, repayments, claims,
liquidations. 모두 chain 자체에서 live로 읽어옵니다. 내려갈 수 있는
central server는 없습니다. 최신 순으로 표시되고 transaction별로 묶여,
한 번의 click으로 한 일은 함께 보입니다.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI 구매

Buy 페이지에서는 protocol의 early-stage fixed rate로 ETH를 VPFI로
swap할 수 있습니다. supported chain 어디서든 가능합니다 — 내부적으로
trade를 route합니다. VPFI는 항상 내가 연결한 같은 chain의 wallet으로
돌아옵니다. network를 바꿀 필요가 없습니다.

<a id="buy-vpfi.discount-status"></a>

### 내 VPFI Discount Status

현재 어느 discount tier에 있는지 빠르게 확인합니다. Tier는
**escrow** 안의 VPFI 양으로 결정됩니다(wallet balance가 아닙니다).
이 카드는 (a) 다음 tier로 올라가려면 escrow에 VPFI가 얼마나 더
필요한지, (b) Dashboard의 consent switch가 켜져 있는지도 알려줍니다
— discount는 켜져 있을 때만 적용됩니다.

escrow의 VPFI는 자동으로 "스테이킹"되어 5% APR을 얻습니다.

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH로 VPFI 구매

쓰고 싶은 ETH amount를 입력하고 Buy를 누른 뒤 transaction에 sign하면
됩니다. 남용 방지를 위해 per-purchase cap과 rolling 24-hour cap이
있습니다 — form 옆에 live numbers가 표시되어 얼마나 남았는지 확인할
수 있습니다.

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI를 escrow에 입금

VPFI를 구매하면 wallet에 들어가며 escrow에는 들어가지 않습니다.
fee discount와 5% staking yield를 얻으려면 직접 escrow로 옮겨야
합니다. 이는 항상 명시적인 click입니다 — 앱은 요청 없이 VPFI를
옮기지 않습니다. 한 번의 transaction(또는 지원되는 chain에서는
single signature)이면 됩니다.

<a id="buy-vpfi.unstake"></a>

### Step 3 — escrow에서 VPFI unstake

VPFI를 wallet으로 다시 가져오고 싶다면 이 카드에서 escrow로부터
withdraw하면 됩니다. 주의: VPFI를 빼면 discount tier가 **즉시**
떨어집니다. open loans가 있다면, 이 시점부터 discount math는 더 낮은
tier로 계산됩니다.

---

## Rewards

<a id="rewards.overview"></a>

### Rewards 소개

Vaipakam은 두 가지에 대해 rewards를 지급합니다:

1. **Staking** — escrow에 둔 VPFI는 자동으로 5% APR을 earn합니다.
2. **Interaction** — 내가 관여한 loan에서 실제 settle된 interest
   1달러마다 community-wide reward pool의 daily share를 받습니다.

둘 다 VPFI로 지급되며, 연결된 chain 위에서 직접 mint됩니다. bridge도,
chain switching도 필요 없습니다.

<a id="rewards.claim"></a>

### Rewards Claim

button 하나로 두 reward streams를 한 번의 transaction에서 모두 claim
합니다. Staking rewards는 항상 real time으로 claim 가능합니다.
interaction-pool share는 하루에 한 번 settle되므로, 마지막 settlement
이후 earned된 부분이 있다면 total의 interaction 부분은 다음 daily
window가 닫힌 직후에 live가 됩니다.

<a id="rewards.withdraw-staked"></a>

### Staked VPFI 인출

VPFI를 escrow에서 wallet으로 옮깁니다. wallet에 들어가면 5% APR
accrual이 멈추고 discount tier에도 count되지 않습니다. Buy VPFI
페이지의 "unstake"와 같은 action입니다 — 편의를 위해 여기에도 둔
것입니다.

---

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
보관하는 escrow vaults입니다. loan이 open될 때 양쪽은 "position NFT"도
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
  principal과 interest를 돌려받습니다. interest에는 1% treasury cut이
  적용됩니다. lender NFT를 consume합니다.
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
  escrow를 떠나지 않습니다.
- **Claim** — loan이 settle되면 full repayment 시 collateral을 돌려주고,
  default 시 loan-initiation fee에서 남은 VPFI rebate를 돌려줍니다.

---

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

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics 소개

wallet 없이 볼 수 있는 protocol 전체의 transparent view입니다: total
value locked, loan volumes, default rates, VPFI supply, recent activity.
모두 on-chain data에서 live로 계산됩니다 — 이 페이지의 어떤 숫자 뒤에도
private database는 없습니다.

<a id="public-dashboard.combined"></a>

### Combined — All Chains

모든 supported chains를 합산한 protocol-wide totals입니다. 작은 "X
chains covered, Y unreachable" 줄은 page load 시 어떤 chain network가
offline이었는지 알려줍니다 — 그런 chain이 있다면 아래 per-chain table에
flag됩니다.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

같은 totals를 chain별로 나눈 view입니다. 어느 chain에 TVL이 가장 많은지,
loans가 어디서 가장 많이 일어나는지, 특정 chain이 stalled되었는지
살펴보는 데 유용합니다.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

이 chain의 VPFI live state입니다 — total supply, 실제 circulating
amount(protocol-held balances 차감 후), cap 아래에서 아직 mint 가능한
양. 모든 chains에 걸쳐 supply는 설계상 bounded로 유지됩니다.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

이 페이지의 모든 숫자는 blockchain에서 직접 re-derive할 수 있습니다.
이 카드는 snapshot block, data fetch 시점, 각 metric이 나온 contract
address를 보여 줍니다. 숫자를 verify하려면 여기서 시작하면 됩니다.

---

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
