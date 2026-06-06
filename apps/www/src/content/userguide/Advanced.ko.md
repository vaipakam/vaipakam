# Vaipakam — 사용자 가이드 (Advanced Mode)

앱의 각 카드에 대한 정확하고 기술적으로 신뢰할 수 있는 설명입니다.
각 섹션은 카드 제목 옆의 `(i)` info icon과 연결되어 있습니다.

> **Advanced 버전을 읽고 있습니다.** 앱의 **Advanced** 모드(더
> 밀도 높은 controls, diagnostics, protocol configuration 세부사항)에
> 맞춘 안내입니다. 더 쉽고 평이한 walkthrough를 원하면 앱을
> **Basic** 모드로 전환하세요 — Settings 열기(우측 상단 톱니바퀴
> 아이콘) → **Mode** → **Basic**. 그 뒤 앱 안의 (i) "Learn more"
> 링크는 Basic 가이드를 열게 됩니다.

---

## Dashboard

<a id="dashboard.your-vault"></a>

### 내 Vault

user별 upgradable contract — 이 chain 위의 내 전용 vault — 입니다.
처음 loan에 참여할 때 나를 위해 생성됩니다. address당, chain당
하나의 vault입니다. 내 loan positions와 연결된 ERC-20, ERC-721,
ERC-1155 balances를 보관합니다. pooling은 없습니다: 다른 user의 assets는
이 contract에 절대 들어가지 않습니다.

vault는 collateral, 빌려준 assets, locked VPFI가 보관되는 유일한
장소입니다. protocol은 모든 deposit / withdrawal에서 이 vault를
검증합니다. implementation은 protocol owner가 update할 수 있지만,
오직 timelock을 통해서만 가능합니다 — 즉시는 절대 아닙니다.

<a id="dashboard.your-loans"></a>

### 내 Loans

이 chain에서 connected wallet과 관련된 모든 loan입니다 — lender side,
borrower side, 또는 별개 positions에서 양쪽인 경우도 포함합니다.
protocol의 view methods가 내 address에 대해 live로 calculate합니다.
각 row는 full position page로 deep-link되며, HF, LTV, accrued interest,
role과 loan status에 따라 활성화되는 actions, block explorer에 붙여
넣을 수 있는 on-chain loan id를 함께 보여 줍니다.

<a id="dashboard.vpfi-panel"></a>

### 이 chain의 VPFI

active chain의 connected wallet에 대한 live VPFI accounting:

- Wallet 잔액.
- Vault 잔액.
- circulating supply 중 내 share(protocol-held balances 차감 후).
- 남은 mintable cap.

Vaipakam은 Chainlink CCIP 위에서 VPFI를 cross-chain으로 전송합니다.
**Base가 canonical chain**입니다 — 그곳에서 canonical adapter가
lock-on-send / release-on-receive semantics를 실행합니다. 다른 모든
supported chains는 mirrors로 동작하며, incoming bridge packets에서는
mint하고 outgoing packets에서는 burn합니다. design상 bridging 중에도
모든 chains 합산 supply는 invariant로 유지됩니다.

April 2026 industry incident 이후 hardened된 cross-chain 메시지 검증
정책은 **3 required + 2 optional verifiers, threshold 1-of-2**
입니다. 기본 단일 verifier 구성은 deploy gate에서 거부됩니다.

<a id="dashboard.fee-discount-consent"></a>

### Fee-discount 동의

wallet-level opt-in flag입니다. terminal events에서 protocol이 fee의
discounted portion을 vault에서 debit한 VPFI로 settle할 수 있게 합니다.
기본값: off. off는 모든 fee의 100%를 principal asset으로 지불한다는
뜻이고, on은 time-weighted discount가 적용된다는 뜻입니다.

Tier ladder:

| Tier | Min vault VPFI                         | Discount                          |
| ---- | --------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`                | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`                | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`                | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`                | `{liveValue:tier4DiscountBps}`%   |

Tier는 VPFI를 deposit하거나 withdraw하는 순간의 **post-change** vault
balance를 기준으로 calculate되고, 각 loan의 전체 기간에 대해
time-weighted 처리됩니다. Unstake는 내가 관여하는 모든 open loans에
대해 새로운 (낮은) balance로 rate를 즉시 re-stamp합니다 — 이전 (높은)
tier가 계속 적용되는 grace window는 없습니다. 이는 loan 종료 직전에
VPFI를 top up해 full-tier discount를 받고 몇 초 뒤 withdraw하는 exploit
pattern을 막습니다.

discount는 settlement 시 lender yield fee와 borrower의 Loan Initiation
Fee에 적용됩니다(이는 borrower가 claim할 때 VPFI rebate로 지급됩니다).

> **Network gas는 별개입니다.** 위의 discount는 Vaipakam의
> **protocol fees**(yield fee `{liveValue:treasuryFeeBps}`%,
> Loan Initiation Fee `{liveValue:loanInitiationFeeBps}`%)에
> 적용됩니다. 모든 on-chain action에 필요한 **blockchain network
> gas fee**(Base / Sepolia / Arbitrum 등에서 offer create / accept
> / repay / claim / withdraw 등을 할 때 validators에게 pay하는
> 것)는 protocol charge가 아닙니다. Vaipakam은 그것을 결코 receive
> 하지 않고 network가 받습니다. tier나 rebate를 apply할 수 없으며,
> submission 시점의 chain 혼잡도에 따라 달라지고 loan size나 당신의
> VPFI tier에 의존하지 않습니다.

<a id="dashboard.rewards-summary"></a>

### 내 VPFI Rewards

connected wallet의 VPFI rewards 전체 그림을 두 reward streams에 걸쳐
하나의 view로 보여 주는 summary card입니다. headline figure는 pending
staking rewards, lifetime-claimed staking rewards, pending interaction
rewards, lifetime-claimed interaction rewards의 합계입니다.

stream별 breakdown rows는 pending + claimed를 보여 주고, native page의
full claim card로 이어지는 chevron deep-link를 제공합니다:

- **Staking yield** — vault balance에 대해 protocol APR로 accrue된
  pending VPFI와, 이 wallet에서 이전에 claim한 모든 staking rewards.
  Buy VPFI page의 staking claim card로 deep-link됩니다.
- **Platform-interaction rewards** — 내가 참여한 모든 loan(lender side
  또는 borrower side)에서 accrue된 pending VPFI와, 이전에 claim한 모든
  interaction rewards. Claim Center의 interaction claim card로
  deep-link됩니다.

lifetime-claimed numbers는 각 wallet의 on-chain claim history에서
reconstruct됩니다. query할 수 있는 on-chain running total이 없으므로,
이 chain에서 wallet의 과거 claim events를 walk해 합산합니다. 새 browser
cache는 historic walk가 끝날 때까지 zero(또는 partial total)를 표시할 수
있고, 이후 올바른 값으로 갱신됩니다. trust model은 underlying claim
cards와 동일합니다.

card는 connected wallets에 대해 항상 render됩니다. 모든 값이 zero인
상태에서도 마찬가지입니다. empty-state hint는 의도적입니다 — zero에서
card를 숨기면 새 users는 Buy VPFI 또는 Claim Center에 들어가기 전까지
rewards programs를 알아차리기 어렵습니다.

---

## Offer Book

<a id="offer-book.filters"></a>

### Filters

Lender / borrower offer lists 위의 client-side filters입니다. asset,
side, status, 그 밖의 axes로 filter할 수 있습니다. filters는 "내 Active
Offers"에 영향을 주지 않습니다 — 그 list는 항상 전체가 표시됩니다.

<a id="offer-book.your-active-offers"></a>

### 내 활성 오퍼

당신이 만든 오픈 오퍼(상태 Active, 만료가 아직 도달하지 않음).
수락 전 언제든지 취소 가능 — 취소 호출은 무료입니다. 수락하면
오퍼가 Accepted로 바뀌고 대출 초기화가 트리거되어, 두 개의
포지션 NFT(렌더용 하나, 대출자용 하나)가 민팅되고 대출이
Active 상태로 열립니다.

마감된 오퍼는 여러 구별된 상태 중 하나를 가집니다. 일부는 이미
My Offers 페이지에서 필터 칩으로 노출되어 있으며; 다른 일부는
후속 작업에서 전용 UI 처리를 받을 인덱서 측 터미널입니다:

- **Filled** — 카운터파티에 의해 수락됨; 오퍼의 대출 참조는
  결과 대출 id입니다.
- **Cancelled** — 오퍼가 두 경로 중 하나를 통해 Cancelled
  상태에 도달: 수락 전 생성자에 의해 철회됨, 또는
  `LibVaipakam.isOfferExpired(offer)`가 true가 되면
  `OfferCancelFacet.cancelOffer`를 통해 권한 없이 정리됨
  (취소 호출을 시작한 사람과 관계없이 환불은 여전히 생성자에게
  라우팅됨).
- **Sold** — 오퍼가 borrow-OR-sell 병렬 판매 플로우에 옵트인
  되었으며(오퍼 생성 → 선택적 판매 허용 참조) 어떤 렌더도
  수락하기 전에 마켓플레이스 구매자가 NFT 담보 리스팅을
  fill했습니다. 오퍼는 온체인 상태 `consumed_by_sale`을 가지며;
  행의 레이트 열은 오퍼가 게시된 레이트를 표시하고 담보 셀은
  NFT 모양(ERC-721의 토큰 id, ERC-1155의 복사 수)을 렌더링
  합니다. 앱은 또한 Activity 피드에서 행을 대출자(오퍼
  생성자)를 위해 `Offer sold via OpenSea`로 노출합니다. 온체인
  이벤트 자체는
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)`
  — 오퍼 id와 executor 주소 모두 온체인으로 인덱싱되지만,
  대출자 / 생성자 주소는 그렇지 않습니다. Activity 피드를 위한
  대출자의 지갑 매칭은 인덱서가 인제스션 시간에 추가합니다
  (생성자를 조회하기 위해 오퍼 행을 join), 그래서 per-지갑
  필터가 이벤트 자체가 그들을 인덱싱하지 않아도 대출자를
  찾습니다.
- **Fully Filled (인덱서 상태, 아직 칩 없음)** — Range 주문
  전용. 부분 채움 매칭이 오퍼의 남은 예산을 소비할 때(마지막
  매치가 범위를 완전히 채우거나, 부분 매치가 sub-dust 잔여를
  남김), `OfferMatchFacet`이 `OfferClosed(FullyFilled | Dust)`를
  emit하고 인덱서가 오퍼 행에 `status = 'fullyFilled'`를
  스탬프합니다. 컨트랙트의 `accepted` 상태와 위의 온체인
  Filled 라벨은 direct-accept 터미널용으로 예약되어 있어,
  `fullyFilled`는 인덱서 측에서 구별됩니다. 앱의
  `MyOfferStatus`는 아직 이 터미널을 자체 필터 칩으로 노출하지
  않으며 — `useMyOffers`는 현재 `fullyFilled` 인덱서 상태의
  행을 무시합니다 — 그래서 fully-filled range 오퍼는 전용 칩이
  올 때까지 My Offers 뷰에서 사실상 완전히 사라집니다. 칩
  서피스는 별도의 UI 후속 작업으로 큐에 있습니다.

터미널 이벤트에 도달한 적이 없는 past-GTT(GTT 만료 시각) 오퍼는
아직 앱에서 구별된 상태 칩으로 노출되지 않으며; 현재는
인덱서가 터미널을 기록할 때까지 Active 아래에 속합니다.
전용 Expired 칩은 별도의 UI 후속 작업으로 큐에 있습니다.


<a id="offer-book.lender-offers"></a>

### Lender Offers

creator가 빌려줄 의향이 있는 active offers입니다. accept하는 쪽은
borrower입니다. initiation 시 hard gate가 있습니다: borrower의 collateral
basket은 lender의 principal request에 대해 최소 1.5 Health Factor를
만들어야 합니다. HF math는 protocol 자체 규칙이며 gate는 우회할 수
없습니다. interest에 대한 1% treasury cut은 terminal settlement에서
debit되며 upfront가 아닙니다.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

이미 collateral을 vault에 lock한 borrowers의 active offers입니다.
accept하는 쪽은 lender입니다. acceptance는 principal asset으로 loan을
fund하고 position NFTs를 mint합니다. initiation 시 같은 HF ≥ 1.5 gate가
적용됩니다. fixed APR은 offer creation 시 set되고 loan lifetime 동안
immutable입니다 — refinance는 기존 loan을 변경하지 않고 새 loan을
만듭니다.

---

## Create Offer

<a id="create-offer.offer-type"></a>

### Offer Type

creator가 offer의 어느 side에 있는지 선택합니다:

- **Lender** — lender는 principal asset과 borrower가 충족해야 하는
  collateral spec을 지정합니다.
- **Borrower** — borrower는 collateral을 사전에 lock합니다.
  lender가 accept하고 fund합니다.
- **Rental** 하위 유형 — ERC-4907 (rentable ERC-721) 및
  rentable ERC-1155 NFTs용. debt loan이 아니라 rental flow를 통합니다.
  renter는 전체 rental cost(duration × daily fee)에 5% buffer/margin을 더해
  upfront로 지불합니다.

<a id="create-offer.lending-asset"></a>

### Lending Asset

debt offer에서는 asset, principal amount, fixed APR, duration(일수)을
지정합니다:

- **Asset** — 빌려주는 / 빌리는 ERC-20.
- **금액** — principal, asset의 native decimals 단위.
- **APR** — basis points(1%의 1/100) 단위의 고정 연이율.
  acceptance 시 snapshot되며 이후에는 변하지 않습니다.
- **일 단위 기간** — default가 trigger 가능해지기 전의
  grace window를 설정합니다.

accrued interest는 loan의 start time부터 terminal settlement까지 초 단위로
계속 calculate됩니다.

<a id="create-offer.lending-asset:lender"></a>

#### 내가 lender인 경우

내가 offer할 principal asset과 amount, interest rate(APR %), duration
(일수)입니다. rate는 offer 시점에 fixed되고, duration은 loan이 default
가능해지기 전 grace window를 설정합니다. acceptance 시 loan initiation의
일부로 principal이 내 vault에서 borrower의 vault로 move됩니다.

<a id="create-offer.lending-asset:borrower"></a>

#### 내가 borrower인 경우

lender에게서 받고 싶은 principal asset과 amount, interest rate(APR %),
duration(일수)입니다. rate는 offer 시점에 fixed되고, duration은 loan이
default 가능해지기 전 grace window를 설정합니다. 내 collateral은 offer
creation 시 vault에 lock되고, lender가 accept해 loan이 open될 때까지
(또는 내가 cancel할 때까지) lock된 채 유지됩니다.

<a id="create-offer.nft-details"></a>

### NFT Details

Rental sub-type fields입니다. NFT contract와 token id(ERC-1155는 quantity
포함), principal asset 단위의 daily rental fee를 지정합니다. acceptance
시 protocol은 renter의 vault에서 prepaid rental을 custody로 debit합니다
— duration × daily fee에 5% buffer/margin을 더한 금액입니다. NFT 자체는
delegated state로 이동합니다(ERC-4907 user rights 또는 ERC-1155 rental
hook equivalent를 통해). renter는 이용 권한은 갖지만 NFT를 transfer할
수 없습니다.

<a id="create-offer.collateral"></a>

### Collateral

offer의 collateral asset spec입니다. liquidity는 두 classes로 나뉩니다:

- **Liquid** — registered Chainlink price feed가 있고, current tick에서
  ≥ $1M depth의 Uniswap V3 / PancakeSwap V3 / SushiSwap V3 pool이
  적어도 하나 있는 asset입니다. LTV와 HF math가 적용됩니다. HF-based
  liquidation은 collateral을 4-DEX failover (0x → 1inch → Uniswap V3 →
  Balancer V2)로 route합니다.
- **Illiquid** — 위 조건을 통과하지 못하는 모든 것. on-chain에서는
  $0으로 valued됩니다. HF math는 없습니다. default 시 collateral 전체가
  lender에게 transfer됩니다. offer를 submit하려면 양 당사자가 offer
  creation / acceptance 시 illiquid-collateral risk를 명시적으로
  acknowledge해야 합니다.

price oracle은 primary Chainlink feed 위에 세 독립 sources(Tellor,
API3, DIA)로 구성된 secondary quorum을 두고, soft 2-of-N decision rule을
사용합니다. Pyth는 평가되었지만 채택되지 않았습니다.

<a id="create-offer.collateral:lender"></a>

#### 내가 lender인 경우

borrower에게 loan의 security로 얼마를 lock하게 할지입니다. Liquid
ERC-20s(Chainlink feed plus ≥ $1M v3 pool depth)에는 LTV / HF math가
적용됩니다. Illiquid ERC-20s와 NFTs에는 on-chain valuation이 없으며,
양 당사자가 full-collateral-on-default outcome에 동의해야 합니다. loan
initiation 시 HF ≥ 1.5 gate는 acceptance 시 borrower가 제시한 collateral
basket에 대해 calculate됩니다 — 여기서 requirement size가 borrower의 HF
headroom을 직접 결정합니다.

<a id="create-offer.collateral:borrower"></a>

#### 내가 borrower인 경우

loan의 security로 내가 얼마나 lock할 의향이 있는지입니다. Liquid
ERC-20s(Chainlink feed plus ≥ $1M v3 pool depth)에는 LTV / HF math가
적용됩니다. Illiquid ERC-20s와 NFTs에는 on-chain valuation이 없으며,
양 당사자가 full-collateral-on-default outcome에 동의해야 합니다.
borrower offer에서는 내 collateral이 offer creation 시 vault에 lock되고,
lender offer에서는 acceptance 시 lock됩니다. 어느 경우든 loan initiation
시 HF ≥ 1.5 gate는 내가 제시한 basket으로 clear해야 합니다.

<a id="create-offer.risk-disclosures"></a>

### Risk Disclosures

submission 전 acknowledgement gate입니다. 같은 risk profile이 양쪽에
적용됩니다. 아래 role-specific tabs는 offer의 어느 side에서 sign하는지에
따라 각 risk가 어떻게 작용하는지 설명합니다. Vaipakam은 non-custodial
입니다: 이미 처리된 transaction을 되돌릴 admin key는 없습니다. Pause
levers는 cross-chain-facing contracts에만 존재하고 timelock-gated이며,
assets를 move할 수 없습니다.

<a id="create-offer.risk-disclosures:lender"></a>

#### 내가 lender인 경우

- **Smart-contract 위험** — contract code는 runtime에서 immutable입니다.
  audited되었지만 formally verified되지는 않았습니다.
- **Oracle 위험** — Chainlink staleness 또는 pool-depth divergence는
  collateral이 principal을 cover하지 못하는 지점을 지나서까지 HF-based
  liquidation을 지연시킬 수 있습니다. secondary quorum (Tellor + API3 +
  DIA, soft 2-of-N)은 큰 drift를 잡지만 작은 skew는 여전히 recovery를
  줄일 수 있습니다.
- **Liquidation slippage** — 4-DEX failover는 가능한 최선의 execution으로
  route하지만 specific price를 보장할 수 없습니다. Recovery는 slippage와
  interest에 대한 1% treasury cut을 뺀 net입니다.
- **Illiquid-collateral defaults** — default time에 collateral 전체가
  나에게 transfer됩니다. asset value가 principal + accrued interest보다
  낮다면 recourse는 없습니다.

<a id="create-offer.risk-disclosures:borrower"></a>

#### 내가 borrower인 경우

- **Smart-contract 위험** — contract code는 runtime에서 immutable입니다.
  bugs는 locked collateral에 영향을 줄 수 있습니다.
- **Oracle 위험** — stale data 또는 manipulation은 real-market price로는
  안전했을 순간에도 나에 대한 HF-based liquidation을 trigger할 수
  있습니다. HF formula는 oracle output에 반응합니다 — 1.0을 넘는 bad
  tick 하나면 충분합니다.
- **Liquidation slippage** — liquidation이 trigger되면 swap이 내
  collateral을 slippage-hit price로 팔 수 있습니다. swap은 permissionless
  입니다 — HF가 1.0 아래로 떨어지는 순간 누구든 trigger할 수 있습니다.
- **Illiquid-collateral defaults** — default는 collateral 전체를 lender에게
  transfer합니다. residual claim은 없습니다. borrower로서 claim 시점에
  받는 unused VPFI Loan Initiation Fee rebate만 남습니다.

<a id="create-offer.advanced-options"></a>

### Advanced Options

덜 자주 쓰는 controls:

- **Expiry** — 이 timestamp 이후 offer가 self-cancel됩니
  다. 기본값 ≈ 7일.
- **이 offer에 fee discount 사용** — 이 특정 offer에 대한 wallet-level
  fee-discount consent의 local override.
- offer creation flow에서 exposed되는 side-specific options.

defaults는 대부분의 users에게 합리적입니다.

<a id="create-offer.borrow-or-sell"></a>

### 이 NFT의 OpenSea 옵션 판매 허용 (NFT 담보 대출자 오퍼 전용)

**ERC-721 또는 ERC-1155 담보**와 **ERC-20 원금**으로 **대출자
오퍼**를 게시하는 경우, 앱은 담보 섹션 아래에 `Borrow or sell`
옵트인을 노출합니다. 이것을 체크하면 오퍼가 OpenSea에서
NFT 담보의 병렬 판매 리스팅에 적격으로 표시됩니다 — 단일
오퍼가 렌더(당신이 대출을 받음) 또는 마켓플레이스 구매자
(당신이 NFT를 판매함) 중 하나에 의해 fill될 수 있습니다.
리스팅이 이미 게시되어 있다면 렌더 수락 시 리스팅이 철거되지
않습니다: 렌더가 먼저 fill하면 당신은 대출을 받고, 기존 OpenSea
리스팅은 대출 초기화를 통해 원래 Seaport 만료까지 이월되며,
해당 만료 전 후속 마켓플레이스 fill은 diamond의 결제
워터폴을 트리거하여 판매 수익으로 대출을 종료합니다 (아래
시나리오 B 참조). 일반 GTT 오퍼의 경우 이 만료는 오퍼의 원래
GTT 만료 시각입니다; 렌더 수락은 리스팅을 전체 대출 기간 동안
연장하거나 다시 게시하지 않습니다. 마켓플레이스 구매자가 먼저
fill하면 대출이 절대 생성되지 않습니다 (시나리오 A). 두 시나리오
는 서로 다른 오퍼 상태로 끝납니다: 시나리오 A는
`markOfferConsumedBySale`을 통해 오퍼에 `consumed_by_sale`을
스탬프합니다 (Sold 필터 아래에 표시됨), 렌더 수락은 이미
스탬프된 오퍼에 대해 게이트됩니다. 시나리오 B에서는 마켓플레이스
fill이 도착할 때까지 오퍼가 이미 `Accepted` 상태입니다;
컨트랙트는 의도적으로 오퍼 상태를 `Accepted`에 두고 판매에서
대출만 결제합니다 — 오퍼는 두 번째로 Sold로 전이하지 않습니다.

**2단계 특성.** 오퍼 생성 시간의 옵트인은 오퍼에 적격성 플래그를
설정할 뿐입니다. OpenSea에서 실제로 구매 가능한 리스팅을
얻는 것은 앱이 오늘 자동화하지 않는 별도의 두 부분 단계
입니다:

1. **diamond에서 등록 + 와이어.**
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)`를 오퍼가 여전히 활성이고 렌더 수락 전에 호출합니다.
   오퍼가 수락되거나, 취소되거나, 판매로 소비되면 이 호출은
   터미널로 revert됩니다; 옵트인 체크만으로는 시나리오 B로
   이월할 수 있는 리스팅을 만들기에 충분하지 않습니다. ask도
   pre-loan floor를 커버해야 합니다: 원금 + 대출 기간과 grace
   윈도우를 통한 최악의 경우 오퍼 이자, 그 이자에 대한 트레저리
   컷, 구성된 안전 버퍼, 모든 fee-leg 금액. 플로어 이하 ask는
   이 단계에서 revert됩니다. `feeLegs` 인수는 이 호출이
   OpenSea 프로토콜 수수료와 크리에이터 로열티 의무를 기록하는
   유일한 장소입니다: diamond는 각 fee-leg 금액을 판매자
   수익에서 빼고 수신자 + 절대 금액을 Seaport consideration
   배열에 추가합니다. fee-enforced 컬렉션에서 `feeLegs: []`를
   전달하면 OpenSea publish 단계가 거부하는 주문 형태를 생성
   하고 (fee-recipient consideration 항목이 누락됨), 직접 Seaport
   fill은 컬렉션이 요구하는 대로 수수료를 분할하는 대신 전체
   ask를 판매자에게 라우팅합니다. 고급 사용자는 컬렉션의
   OpenSea required-fee 일정을 조회해야 하며 (in-repo fee parser
   `apps/defi/src/lib/openseaFeeSchedule.ts`가 참조), 호출 전 ask에 대해
   파생된 절대 금액을 전달해야 합니다. Facet은 내부적으로
   이러한 입력 (플러스
   `CollateralListingExecutor.offerContext`에 보유하는 값 —
   대출자 볼트 주소, 원금 자산, 담보 필드, startTime, endTime)과
   볼트에 대한 현재 `Seaport.getCounter`로부터 canonical Seaport
   OrderComponents를 빌드하고, `Seaport.getOrderHash`를 통해
   orderHash를 도출하고, 반환하고, 볼트의 ERC-1271 바인딩을
   그 해시에 등록하고, NFT 담보에 대한 Seaport conduit 승인을
   부여합니다. emit된 `PostParallelSaleListing` 이벤트는 입력
   인수를 노출합니다 (`offerId`, 대출자, orderHash, askPrice,
   executor / conduit 데이터, salt, fee legs); per-context 필드를
   echo하지 않으므로, 오프체인에서 OrderComponents를 재구성하려면
   아래 단계 2에서 설명하는 추가 읽기가 필요합니다. **중요:**
   이 시점에서 주문은 이미 Seaport를 통해 FILLABLE입니다.
   컨트랙트의 이벤트와 그 읽기를 보는 봇은 OrderComponents를
   재구성하고 `Seaport.fulfillOrder`를 직접 호출할 수 있습니다 —
   온체인 fill 경로가 작동하기 위해 리스팅이 OpenSea의 마켓
   플레이스 UI에 나타날 필요가 없습니다. 단계 2가 land하기
   전에 카운터파티가 현재 ask에 fill하는 것을 원하지 않는다면,
   단계 1 직후 단계 2를 실행하거나 의도하지 않은 fill 전에
   `releaseParallelSaleLock`을 호출하여 바인딩을 무효화합니다.
   fee-enforced 컬렉션의 경우, 이 단계를 호출하기 전에 컬렉션의
   필수 OpenSea / 크리에이터 수수료 일정에서 `feeLegs`를 채웁니다.
   필수, 0이 아닌 수수료 행만 사용하십시오; 목록을 프로토콜이
   지원하는 fee-leg 수로 제한하십시오; 각 행을 선택한 ask 가격
   에서 원금 자산의 절대 고정 금액으로 변환하십시오; 그리고
   나열된 수수료 수신자를 leg 수신자로 사용하십시오. 선택한
   ask에서 필수 수수료가 0으로 반올림되면, ask는 해당 컬렉션
   에 너무 작고 post를 시도해서는 안 됩니다. 빈 배열을 전달
   하는 것은 fee-free 컬렉션에만 유효합니다. fee-enforced
   컬렉션에서는 OpenSea 게시에 실패하거나 마켓플레이스의 필수
   consideration 형태를 충족할 수 없는 주문을 생성할 수 있습니다.
2. **OpenSea에 publish.** facet이 빌드한 동일한 OrderComponents를
   재구성합니다. `PostParallelSaleListing` 이벤트만으로는
   충분하지 않습니다: 이는 `offerId`, 대출자, orderHash,
   askPrice, executor / conduit 데이터, salt, fee legs를
   emit하지만, offer-keyed 주문 형태는 executor의 `OfferContext`
   스토리지에 보유된 값 (대출자 볼트 주소, 원금 자산, 담보 필드,
   startTime, endTime)과 대출자 볼트의 Seaport 카운터 (offerer의
   카운터 — `LibPrepayOrder.buildAndHashOfferMem`은
   `Seaport.getCounter(ctx.borrowerVault)`를 해시, 입찰자의
   카운터가 아님)도 필요합니다. 이는
   `LibPrepayOrder.buildAndHashOfferMem` offer-order 경로가
   사용하는 것과 동일한 컨텍스트이며, loan-keyed prepay-listing
   주문 형태와는 다릅니다. 게시하기 전에 둘 다 읽으십시오:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`는
     해당 해시에 대한 영구화된 `OfferContext` 구조체를 반환합니다.
   - `Seaport.getCounter(borrowerVault)`는 볼트 offerer에 대한
     canonical Seaport 카운터를 반환합니다.
   이러한 필드를 손에 들면 OrderComponents 구조체가 diamond가
   해시한 것을 정확히 재현합니다. POST하기 전에 API 전용 필드
   `parameters.totalOriginalConsiderationItems`를 추가합니다 —
   OpenSea의 API는 canonical 해시를 생성하는 Seaport 구조체의
   일부가 아니지만 이를 요구합니다; in-repo 게시자
   (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`)는 endpoint 호출 전에
   이를 inject합니다. ERC-1271로 검증된 주문의 경우 OpenSea는
   `signature` 필드를 `0x` (빈 바이트)로 수락합니다 — 볼트의
   온체인 `isValidSignature(orderHash, '')` 콜백은 signature
   바이트를 무시하고 diamond가 이전에 등록한 (단계 1에서) 모든
   orderHash에 대해 EIP-1271 매직 값을 반환합니다. JSON을
   OpenSea listings endpoint에 POST합니다 (`POST
   /api/v2/orders/{chain}/{protocol}/listings`, 공식
   [Create Listing](https://docs.opensea.io/reference/post_listing)
   문서에 따라 — 이는 Vaipakam 자체 게시자
   `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts`가 사용하는 동일한
   endpoint). 이 단계 후에만 리스팅이 OpenSea의 마켓플레이스
   UI에 나타나고 캐주얼 구매자가 발견할 수 있게 됩니다.
   Vaipakam은 현재 parallel-sale 경로에 대해 이 제출을 자동화
   하지 않으며 — end-to-end 리스팅 게시 표면화는 후속 작업으로
   추적됩니다.

오늘 수동 경로를 따르는 고급 사용자는 OpenSea 가시성을 얻기
위해 두 단계 모두 필요합니다; 단계 1만 실행하면 Seaport를
통해 직접 fillable한 주문이 생성되지만 (이벤트에서 구성요소를
재구성하는 봇이나 카운터파티에 의해) OpenSea 마켓플레이스 UI
에서는 보이지 않습니다.

**Fill 모드는 All-or-Nothing으로 강제.** 옵트인은 오퍼의 fill
모드를 자동으로 `Aon`에 고정합니다 — parallel-sale이 활성화된
partial / IOC fill 모드는 단일 오퍼의 담보에 대해 여러 대출을
생성하게 되며, 컨트랙트가 이를 게이트합니다. 토글은 렌더
오퍼, ERC-20 담보, NFT 원금, 그리고 컨트랙트의
`_validatePostParallelSale`이 거부할 다른 형태에서 숨겨져
있어, 부적격 오퍼에서 실수로 체크할 수 없습니다.

**구매자가 보는 것.**

- *어떤 렌더도 수락하기 전* (시나리오 A): OpenSea 리스팅을
  fill하는 구매자는 listed price를 지불합니다. fee-enforced
  컬렉션에서 Seaport는 OpenSea protocol-fee와 creator-fee leg을
  먼저 구성된 수신자에게 직접 라우팅합니다; executor는 **net
  proceeds** (listed price에서 해당 마켓플레이스 / creator fee leg을
  뺀 것)만 diamond로 전달합니다. Diamond는 그 net 금액을 당신의
  볼트에 에스크로하고, NFT는 구매자에게 전송되며, 오퍼는
  `consumed_by_sale`로 마크됩니다 (My Offers, Activity, Offer
  Details에 구별된 "Sold" 상태로 표시). 대출이 절대 생성되지
  않았습니다; 당신은 net 판매 수익을 유지합니다.
- *렌더가 수락한 후* (시나리오 B): 리스팅은 대출 초기화를
  통해 이월됩니다 — 대출자 NFT 잠금도 리스팅도 철거되지
  않습니다. 후속 구매자 fill은 diamond의 결제 워터폴을 Seaport
  트랜잭션에서 트리거합니다. 시나리오 A와 동일한 fee-leg 참고:
  fee-enforced 컬렉션에서 Seaport는 OpenSea protocol-fee와
  creator-fee leg을 먼저 구성된 수신자에게 직접 라우팅하고,
  executor는 **net proceeds** (판매 가격에서 마켓플레이스 /
  creator fee를 뺀 것)만 diamond의 워터폴로 전달합니다. 워터폴은
  그 다음 그 net 금액을 라우팅합니다: 렌더는 결제 entitlement를
  받습니다 (`LibEntitlement.settlementInterest`가 대출이
  `useFullTermInterest = true`로 생성된 경우 전체 쿠폰으로
  계산, 그렇지 않으면 결제 타임스탬프에 누적된 pro-rata 이자
  로 계산 — 게이트는 대출 정책이며, 판매가 예정된 만기 전후인지
  여부가 아님), 트레저리 컷은 트레저리로 가며, 나머지는 현재
  대출자 포지션 NFT 보유자의 볼트에 직접 입금됩니다
  (`LibUserVault.getOrCreate` + 볼트 입금 통해). Claim Center
  클레임은 생성되지 않습니다 — 판매가 land한 후 볼트 잔액을
  확인하십시오.

**결합할 수 없는 것.** 두 가지 구별된 충돌 클래스가 다른
프로토콜 단계에서 표면화됩니다:

- *Publish 시간 블록 (자매 loan-keyed 리스팅).* 대출에 이미
  오퍼 생성에서 이월된 parallel-sale 리스팅이 있고 대출자가
  그런 다음 동일한 대출에 두 번째 loan-keyed prepay 리스팅을
  게시하기 위해 `NFTPrepayListingFacet.postPrepayListing` (또는
  `updatePrepayListing`)을 호출하면, diamond는
  `SiblingParallelSaleListingLive`로 revert합니다. 대출자
  NFT에 대한 conduit 승인은 단일 슬롯입니다 — 두 리스팅을
  동시에 실행하면 모호한 승인이 생성됩니다. 대출자는 publish /
  update 호출에서 revert를 봅니다; 아무것도 fill되지 않습니다.
- *Fill 시간 블록 (열린 PrecloseFacet offset).* 대출에 열린
  PrecloseFacet offset 오퍼가 있고 구매자가 나중에 parallel-sale
  리스팅을 fill하려고 하면, diamond의
  `_settleLoanFromParallelSale`은
  `ParallelSaleBlockedByOpenOffsetOffer`로 revert합니다.
  리스팅은 OpenSea에서 유효하게 유지되지만 offset 링크가
  지워질 때까지 fill 시도는 revert합니다. 앱은 현재 Loan
  Details 페이지에서 이 조합에 대한 전용 배너 / 알림을 표면화
  하지 않으며; 사용자는 fill이 revert하는 것을 보게 되고 진단을
  위해 블록 탐색기에서 revert 이유를 검사해야 할 수도 있습니다.
  정리 경로는 일반 offer-cancel 표면입니다 — offset 오퍼를
  취소하기 위해 `OfferCancelFacet.cancelOffer(offsetOfferId)`를
  호출하면 offset 링크를 해제하고 parallel-sale fill을 차단
  해제합니다 (PrecloseFacet에는 별도의 취소 진입점이 없습니다;
  offset은 링크된 오퍼에 바운드되어 있으므로 링크된 오퍼를
  취소하면 지워집니다). 충돌에 대한 전용 UI 표면은 별도의 UX
  후속 작업으로 큐에 있습니다.


## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims는 설계상 pull-style입니다 — terminal events는 funds를 protocol
custody에 남기고, position NFT holder가 claim call을 통해 move합니다.
두 종류의 claims가 같은 wallet에 동시에 있을 수 있습니다. 아래
role-specific tabs가 각각을 설명합니다.

각 claim은 holder의 position NFT를 atomically burn합니다. NFT *자체* 가
bearer instrument입니다 — claim 전에 transfer하면 새 holder가 collect할
권리를 갖습니다.

<a id="claim-center.claims:lender"></a>

#### 내가 lender인 경우

Lender claim은 다음을 반환합니다:

- 이 chain의 내 wallet으로 돌아오는 principal.
- accrued interest minus 1% treasury cut. consent가 on이면 그 cut 자체가
  time-weighted VPFI fee-discount accumulator에 의해 더 줄어듭니다.

loan이 terminal state(Settled, Defaulted, 또는 Liquidated)에 도달하는
즉시 claimable해집니다. Lender position NFT는 같은 transaction에서
burn됩니다.

<a id="claim-center.claims:borrower"></a>

#### 내가 borrower인 경우

Borrower claim은 loan이 어떻게 정산되었는지에 따라 다음을
반환합니다:

- **full repayment / preclose / refinance** — 내 collateral basket과
  Loan Initiation Fee에서 나온 time-weighted VPFI rebate를 받습니다.
- **HF-liquidation 또는 default** — unused VPFI Loan Initiation Fee
  rebate만 반환됩니다. 이 terminal paths에서는 명시적으로 preserve되지
  않는 한 0입니다. collateral은 이미 lender에게 갔습니다.

Borrower position NFT는 같은 transaction에서 burn됩니다.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain에서 내 wallet과 관련된 on-chain events입니다. protocol logs
에서 sliding block window로 live sourced됩니다. backend cache는 없습니다
— page load마다 다시 fetch합니다. events는 transaction hash별로 group되어
multi-event transaction(예: accept + initiate가 같은 block 내에서 발생)이
함께 표시됩니다. 최신 순입니다. offers, loans, repayments, claims,
liquidations, NFT mints / burns, VPFI buys / stakes / unstakes를 표시합니다.

---

## Buy VPFI

<a id="buy-vpfi.overview"></a>

### VPFI 구매

두 가지 paths:

- **Canonical (Base)** — protocol의 canonical buy flow를 직접 call합니다.
  VPFI를 Base의 내 wallet에 직접 mint합니다.
- **Off-canonical** — local-chain buy adapter가 Base의 canonical receiver에
  Chainlink CCIP packet을 보냅니다. receiver는 Base에서 purchase를 execute하고
  cross-chain token standard를 통해 result를 다시 bridge합니다. L2-to-L2
  pairs에서 end-to-end latency는 ≈ 1분입니다. VPFI는 **origin** chain의
  wallet에 land합니다.

Adapter rate limits(post-hardening): request당 50,000 VPFI, rolling
24 hours 기준 500,000 VPFI. governance가 timelock을 통해 tune할 수
있습니다.

<a id="buy-vpfi.discount-status"></a>

### 내 VPFI Discount Status

Live status:

- 현재 tier (0~4).
- Vault VPFI 잔액에 다음 tier까지의 차이.
- 현재 tier에서의 할인 비율.
- wallet-level consent flag.

vault VPFI는 staking pool을 통해 자동으로 5% APR도 accrue합니다 —
별도의 "stake" action은 없습니다. VPFI를 vault에 deposit하는 것 자체가
staking입니다.

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH로 VPFI 구매

purchase를 submit합니다. canonical chain에서는 protocol이 직접 mint합니다.
Mirror chains에서는 buy adapter가 payment를 받고 cross-chain message를
보내며, receiver가 Base에서 purchase를 execute한 뒤 VPFI를 다시 bridge합니다.
Bridge fee와 verifier-network cost는 form에서 live quote로 표시됩니다.
VPFI는 vault에 자동 deposit되지 않습니다 — Step 2는 설계상 explicit
user action입니다.

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI를 vault에 입금

wallet에서 같은 chain의 내 vault로 옮기는 별도의 explicit deposit
step입니다. 모든 chain에서 필요합니다 — canonical에서도 — vault deposit
spec상 항상 explicit user action이기 때문입니다. Permit2가 configured된
chain에서는 앱이 classic approve + deposit pattern보다 single-signature
path를 prefer합니다. 해당 chain에서 Permit2가 configured되어 있지 않다면
cleanly fall back합니다.

<a id="buy-vpfi.unstake"></a>

### Step 3 — vault에서 VPFI unstake

VPFI를 vault에서 wallet으로 다시 withdraw합니다. approval leg는 없습니다
— protocol이 vault owner이며 자기 자신을 debit합니다. withdraw는 새로운
(낮은) balance로 fee-discount rate를 즉시 re-stamp하고, 내가 관여하는
모든 open loans에 적용됩니다. 이전 tier가 계속 apply되는 grace window는
없습니다.

---

## Rewards

<a id="rewards.overview"></a>

### Rewards 소개

두 streams:

- **Staking pool** — vault에 보관된 VPFI는 5% APR로 지속적으로 accrue하며
  per-second compounding됩니다.
- **Interaction pool** — fixed daily emission의 per-day pro-rata share입니다.
  그날의 loan volume에 대한 내 settled-interest contribution으로 weighted됩니다.
  daily windows는 window close 후 첫 claim 또는 settlement에서 lazily finalise됩니다.

두 streams 모두 active chain에서 직접 mint됩니다 — user에게 cross-chain
round-trip은 없습니다. cross-chain reward aggregation은 protocol contracts
사이에서만 일어납니다.

<a id="rewards.claim"></a>

### Rewards Claim

단일 transaction으로 두 streams를 함께 claim합니다. Staking rewards는 항상
available합니다. interaction rewards는 관련 daily window가 finalise될 때까지
zero입니다(해당 chain에서 다음 non-zero claim 또는 settlement로 trigger되는
lazy finalisation). window가 아직 finalise 중일 때는 UI가 button을 guard해
users가 under-claim하지 않도록 합니다.

<a id="rewards.withdraw-staked"></a>

### Staked VPFI 인출

Buy VPFI 페이지의 "Step 3 — Unstake"와 같은 interface입니다 — vault에서
wallet으로 VPFI를 다시 withdraw합니다. withdraw된 VPFI는 즉시 staking pool
에서 빠져나갑니다(그 amount의 rewards는 같은 block에서 accrue를 멈춥니다).
또한 discount accumulator에서도 즉시 빠집니다(모든 open loan에서
post-balance re-stamp).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (이 페이지)

protocol에서 live-derived된 single-loan view입니다. risk engine의 live HF와
LTV도 함께 표시합니다. terms, collateral risk, parties, role과 loan status로
활성화되는 actions, inline keeper status를 render합니다.

<a id="loan-details.terms"></a>

### Loan Terms

loan의 immutable parts:

- Principal (asset과 amount).
- APR (offer 생성 시 고정).
- 일 단위 기간.
- 시작 시간과 종료 시간 (= 시작 시간 + 기간).
- accrued interest — start 이후 경과한 seconds로 live calculate.

Refinance는 이 values를 변경하지 않고 새 loan을 만듭니다.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risk

Live risk math.

- **Health Factor** = (collateral USD value × liquidation threshold) /
  debt USD value. HF가 1.0 미만이면 position은 liquidatable해집니다.
- **LTV** = debt USD value / collateral USD value.
- **Liquidation threshold** = position이 liquidatable해지는 LTV입니다.
  collateral basket의 volatility class에 따라 달라집니다. high-volatility
  collapse trigger는 110% LTV입니다.

Illiquid collateral의 on-chain USD value는 zero입니다. HF와 LTV는 "n/a"가
되고, 유일한 terminal path는 default 시 full collateral transfer입니다
— 양 당사자가 offer creation 시 illiquid-risk acknowledgement로 동의했습니다.

<a id="loan-details.collateral-risk:lender"></a>

#### 내가 lender인 경우

이 loan을 secure하는 collateral basket이 내 protection입니다. HF가 1.0을
넘으면 position이 liquidation threshold 대비 over-collateralised되어 있다는
뜻입니다. HF가 1.0을 향해 drift할수록 protection은 약해집니다. HF가 1.0
아래로 떨어지면 누구든(나 포함) liquidate call을 할 수 있고, protocol은
4-DEX failover를 통해 collateral을 내 principal asset으로 route합니다.
Recovery는 slippage 후 net입니다.

Illiquid collateral의 경우 default time에 basket 전체가 나에게 transfer됩니다
— open market에서 실제 value가 얼마인지는 내가 감수하는 risk입니다.

<a id="loan-details.collateral-risk:borrower"></a>

#### 내가 borrower인 경우

내 locked collateral입니다. HF를 1.0보다 충분히 위에 유지하세요 —
volatility를 견디기 위한 common safety margin은 1.5입니다. HF를 끌어올리는
levers:

- **Collateral 추가** — basket을 top up합니다. User-only action.
- **부분 상환** — debt를 줄이고 HF를 끌어올립니다.

HF가 1.0 아래로 떨어지면 누구든 HF-based liquidation을 trigger할 수 있고,
swap은 slippage-hit price로 내 collateral을 팔아 lender에게 상환합니다.
Illiquid collateral의 경우 default는 collateral 전체를 lender에게 transfer합니다
— claim할 수 있는 것은 unused VPFI Loan Initiation Fee rebate뿐입니다.

<a id="loan-details.parties"></a>

### Parties

Lender, borrower, lender vault, borrower vault, 그리고 두 position NFTs
(각 side에 하나씩). 각 NFT는 on-chain metadata를 가진 ERC-721입니다. 이를
transfer하면 claim할 권리도 transfer됩니다. Vault contracts는 address별로
deterministic합니다 — deployments를 넘어 같은 address입니다.

<a id="loan-details.actions"></a>

### Actions

protocol이 role별로 gated한 action interface입니다. 아래 role-specific tabs가
각 side에서 사용할 수 있는 actions를 나열합니다. disabled actions는 gate에서
derived된 hover reason을 표시합니다("Insufficient HF", "Not yet expired",
"Loan locked" 등).

role과 관계없이 누구나 사용할 수 있는 permissionless actions:

- **Liquidation trigger** — HF가 1.0 아래로 떨어질 때.
- **Default mark** — full repayment 없이 grace period가 expire되었을 때.

<a id="loan-details.actions:lender"></a>

#### 내가 lender인 경우

- **Lender로 claim** — terminal state 전용. Principal plus interest minus 1%
  treasury cut을 반환합니다(consent가 on이면 time-weighted VPFI yield-fee
  discount로 더 줄어듭니다). Lender position NFT를 burn합니다.
- **Early withdrawal 시작** — 선택한 asking price로 lender position NFT를
  sale listing합니다. sale을 complete한 buyer가 내 side를 인수하고, 나는
  proceeds를 받습니다. sale이 fill되기 전에는 cancel할 수 있습니다.
- 관련 action permission을 가진 keeper에게 delegate할 수도 있습니다 —
  Keeper Settings를 참조하세요.

<a id="loan-details.actions:borrower"></a>

#### 내가 borrower인 경우

- **Repay** — full 또는 partial. Partial repayment는 outstanding을 줄이고
  HF를 끌어올립니다. Full repayment는 time-weighted VPFI Loan Initiation Fee
  rebate를 포함한 terminal settlement를 trigger합니다.
- **Preclose direct** — 지금 wallet에서 outstanding amount를 지불하고,
  collateral을 release하며, rebate를 settle합니다.
- **Preclose offset** — protocol의 swap router를 통해 collateral 일부를
  팔고, proceeds에서 repay하며, 나머지를 돌려받습니다. two-step:
  initiate, 그 후 complete.
- **Refinance** — 새 terms로 borrower offer를 게시합니다. lender가 accept하면
  complete refinance가 collateral이 vault를 떠나지 않은 채 loans를
  atomically swap합니다.
- **Borrower로 claim** — terminal state 전용. full repayment 시 collateral을
  반환하거나, default / liquidation 시 unused VPFI Loan Initiation Fee
  rebate를 반환합니다. Borrower position NFT를 burn합니다.

---

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Prepay 리스팅에서 OpenSea 오퍼 매칭

prepay 리스팅이 OpenSea의 마켓플레이스에서 라이브가 되면, 캐주얼
구매자가 때때로 당신의 토큰에 직접 **item offers**를 배치합니다 —
컬렉션의 어떤 토큰이 아닌 당신의 특정 담보에 묶인 입찰입니다.
Vaipakam은 이러한 item offers를 Loan Details 페이지에 실시간
으로 표면화합니다 — "OpenSea에 담보 리스팅" 아래의 별도
패널에 incoming offer당 한 행씩. 패널은 **buffer threshold**를
적용합니다 — 렌더의 결제 entitlement (이미 원금 + 전체 쿠폰
(full-term-interest 대출) 또는 pro-rata 이자 (그렇지 않으면)
포함 — 참조 `PrepayListingFacet.getPrepayContext().lenderLeg`),
플러스 트레저리 컷, 플러스 안전 버퍼 — 이를 클리어하지 않는
오퍼를 **회색 처리**합니다. 모든 수준에서 시장 관심을 볼 수
있지만 프로토콜이 실제로 결제할 오퍼만 Match할 수 있습니다.

컬렉션 전체 / criteria 오퍼 (컬렉션의 모든 토큰이 fulfill할 수
있는 입찰)는 OpenSea에 남아 있지만 앱의 Match 패널에는 **표시
되지 않습니다** — 프로토콜이 결제하는 multi-leg consideration은
v1에 없는 컨트랙트 측 plumbing 없이 criteria 오퍼에 대해
재구성될 수 없습니다. 유일한 인바운드 수요가 컬렉션 전체라면,
오늘의 실용적 경로는 item-specific 입찰를 기다리거나 리스팅을
고정 ask로 두고 어떤 구매자든 직접 fulfill할 수 있게 두는
것입니다. 컬렉션 전체 입찰를 수동으로 직접 결제할 수 없습니다 —
담보 NFT가 당신의 Vaipakam 볼트에 있고, Vaipakam 측 Seaport
주문이 유일하게 승인된 결제 형태입니다.

OpenSea 프로토콜 수수료 및/또는 크리에이터 로열티를 강제하는
컬렉션에서 앱은 오퍼 패널을 렌더링합니다 — OpenSea API에서의
fee-schedule 조회는 advisory로 처리되며; 실제 fulfillment 데이터는
MATCH 클릭 시간에 조회됩니다. Match 패널은 fee-schedule 조회
상태에 관계없이 렌더링되며; 클릭 시간 fulfillment-data 조회가
게이트입니다. 그 조회가 실패하면 (rate limit, API 중단, 또는
지원되지 않는 컬렉션 형태), 앱 측 Match 클릭 핸들러가 어떤
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` 트랜잭션이
구성되기 전에 ABORT합니다 — calldata 없음, signature 프롬프트
없음, revert 없음. 온체인 함수 자체는 `bool` 반환 셀렉터가 아니며;
실행되면 `bytes32` orderHash를 반환하거나 revert합니다. 따라서
fee-enforced 컬렉션의 패널은 탐색할 수 있는 오퍼를 표시할 수
있지만 그 모두가 주어진 순간에 clickable-to-match인 것은
아닙니다.

수용 가능한 오퍼를 찾고 **오퍼 매칭**를 클릭하면, 앱이
**매칭 확인** 모달을 엽니다. 이는 매칭 값 (gross
OpenSea 오퍼 금액 — diamond가 결제할 net 금액이 아님;
fee-enforced 컬렉션에서
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer`는 lender /
treasury / borrower 분할을 실행하기 전에 `effectiveAsk =
offerValue - bidderFeeTotal`을 계산하므로, diamond가 실제로
분배하는 net는 모달의 헤드라인보다 작습니다)를 다시 표시하고
atomic-match 플로우의 일반적인 설명을 제공합니다. 확인 후,
앱은 입찰자의 오퍼를 새로 구성된 diamond 측 카운터 주문과
단일 Seaport `matchAdvancedOrders` 호출에 묶는 단일
`matchOpenSeaOffer` 트랜잭션을 보냅니다 — 입찰자의 fulfillment,
카운터 주문의 listing 측 leg (이전 v1 prepay 리스팅이 라이브
였는지 여부에 관계없이; atomic 경로는 `existingHash == 0`을
지원), diamond의 결제 워터폴이 모두 한 블록에 atomic으로
land합니다. 트랜잭션은 완전히 성공하거나 (대출 결제, NFT 전송,
판매 수익 분할) 완전히 revert (아무것도 움직이지 않음)하며,
리스팅 회전과 결제 사이에 제3자 구매자가 matched price에
개입할 수 있는 **창이 없습니다**.

> **레이스 윈도우 없음 — 구조상 atomic.** 이는 v1 두 단계
> "cancel + post" 패턴의 구조적 폐쇄입니다: v1 하에서 앱은
> 리스팅을 별도의 `updatePrepayListing` 트랜잭션으로 회전하고,
> 회전된 가격을 OpenSea에 라이브로 두어 입찰자의
> `fulfillOrder`가 나중 블록에서 land할 때까지 — mempool을
> 보는 누구든지 입찰자를 입찰한 가격에서 snipe할 수 있었습니다.
> Atomic 경로는 두 주문을 하나의 Seaport match 호출에 바인딩
> 하여 그 구멍을 닫습니다: 입찰자가 합의된 가격에 fill하거나
> 전체 트랜잭션이 revert합니다.

**Match를 클릭하기 전에 여전히 확인하고 싶은 것:**

- **모달에서 매칭 값 확인.** 모달은 gross OpenSea 오퍼
  금액을 표면화합니다. fee-enforced 컬렉션에서 diamond는 입찰자
  측 마켓플레이스 / creator fee leg 후의 net effective ask에
  대해 결제하므로, 모달 값은 lender / treasury / borrower 분할에
  사용된 금액보다 클 수 있습니다. 입찰자 주소와 정확한 분할은
  모달이나 OpenSea Offers 패널 행 (행은 value, payment token,
  offer 종류, 잘린 입찰자, end time을 표시)에서 분리되어 있지
  않습니다. 분할은 결제 시 diamond에 의해 온체인으로 강제됩니다 —
  프로토콜의 결제 버퍼는 effective ask가 렌더의 결제 entitlement
  (이미 원금 + 전체 쿠폰 (full-term-interest 대출) 또는
  pro-rata 이자 (그렇지 않으면) 포함) + 트레저리 컷을 커버하는
  것을 보장하므로, 분할은 항상 최소한 당신에게 중립적입니다.
  확인하기 전에 예상 분할을 보고 싶다면, diamond는
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`를
  callable 뷰로 노출합니다 — 주어진 타임스탬프에서 결제
  워터폴이 라우팅할 lender와 treasury leg을 반환하며, 나머지는
  당신의 것입니다.
- **컬렉션에 대한 OpenSea의 fee posture 확인.** 컬렉션이
  OpenSea 프로토콜 수수료나 크리에이터 로열티를 강제하면,
  atomic 경로는 앱이 agent의 OpenSea fulfillment-data 프록시
  (PR #349)를 통해 MATCH 클릭 시간에 조회하는 SignedZone
  `extraData` / criteria-resolver plumbing이 필요합니다. Match
  패널은 fee-schedule 조회 상태에 관계없이 렌더링되며; 클릭
  시간의 fulfillment-data 조회가 게이트입니다. 그 조회가
  실패하면 (rate limit, API 중단, 지원되지 않는 컬렉션 형태),
  앱 측 클릭 핸들러는 온체인 `matchOpenSeaOffer` 트랜잭션을
  구성하기 전에 abort합니다 — calldata가 빌드되지 않고,
  signature 프롬프트가 발생하지 않으며, 사전에 배너가 표시되지
  않습니다. 나중에 클릭을 재시도하거나 (조회가 일시적인 API blip
  이었을 수 있음), 그 사이 OpenSea에 listed ask로 직접 리스팅을
  fulfill할 수 있습니다.

---

## 청산(Liquidation)의 실제 작동 방식

오퍼 시점에 동의한 Risk Disclosures는 최악의 결과를 두 문장으로 요약하고 있습니다. 이 섹션에서는 그 이면의 메커니즘을 설명합니다. 이는 왜 현물(in-kind) 폴백이 존재하는지, 그리고 대출이 실제로 네 가지 갈래 중 어떤 경로를 따르는지 이해하는 데 도움이 됩니다.

분할을 결정하는 컨트랙트 함수는 `LibFallback.computeFallbackEntitlements`입니다. 이 함수는 네 가지 케이스를 순서대로 확인하며, 가장 먼저 일치하는 케이스가 실행됩니다.

<a id="liquidation-mechanics.case-1"></a>

### 케이스 1 — 오라클 사용 가능, 담보 가치 ≥ 미상환 금액

정상적인 경로입니다. Chainlink 가격 피드가 반응하고 있고, Soft 2-of-N 보조 쿼럼(Tellor + API3 + DIA)이 이견을 보이지 않았으며, 압류된 담보가 오라클 가격 기준으로 미상환 금액을 충당할 수 있는 경우입니다.

발생하는 일:

- 렌더는 오라클 가격 기준으로 (원금 + 발생 이자 + 3% 폴백 보너스)에 해당하는 가치의 **담보 자산**을 받습니다. 사실상 렌더는 대출 자산이 아닌 담보 자산으로 공정 가치만큼 전액 상환을 받게 됩니다.
- 트레저리는 원금의 2% 프리미엄을 담보 자산으로 받습니다.
- 대출자는 담보의 **나머지**를 돌려받습니다. 이는 렌더의 청구액을 충당하고 남은 초과 담보분으로, 실질적인 환급입니다.

계산 예시: 0.6 WETH($3,000 담보, $1,000 부채)에 대한 1,000 USDC 대출. 오라클이 ETH 가격을 $5,000 / WETH로 평가할 때; 부채 + 이자 + 보너스 = $1,050. 렌더는 0.21 WETH($1,050 상당), 트레저리는 0.004 WETH(2% 프리미엄인 $20 상당), 대출자는 나머지 약 0.386 WETH를 받습니다.

<a id="liquidation-mechanics.case-2"></a>

### 케이스 2 — 오라클 사용 가능, 담보 가치 < 미상환 금액

언더워터(자산 가치 하락) 경로입니다. 오라클은 작동하지만, 압류된 담보의 가치가 오라클 가격 기준으로도 미상환 금액보다 낮은 경우입니다. 자산 가치가 급락하여 HF가 반응하기 전에 담보 가치가 떨어지는 변동성 장세에서 흔히 발생합니다.

발생하는 일:

- 렌더는 압류된 담보 **전체**를 담보 자산으로 받습니다.
- 트레저리는 아무것도 받지 못합니다.
- 대출자는 아무것도 받지 못합니다 — 환급할 나머지가 없기 때문입니다.

렌더가 부족분을 감수합니다. 대출자, 프로토콜 또는 제3자에 대해 더 이상의 청구권은 존재하지 않습니다. 이는 Risk Disclosures의 "회수 금액이 대출한 자산보다 적을 수 있습니다"라는 문구가 구체적으로 경고하는 상황입니다.

계산 예시: 위와 같은 1,000 USDC / 0.6 WETH 대출에서 ETH가 $1,500 / WETH로 급락한 경우. 담보는 $900, 부채는 $1,050. 렌더는 0.6 WETH 전체($900 상당)를 받고, 트레저리는 0, 대출자는 0을 받습니다.

<a id="liquidation-mechanics.case-3"></a>

### 케이스 3 — 오라클 쿼럼 사용 불가 (UNAVAILABLE)

다크 쿼럼 경로입니다. Chainlink 데이터가 만료(stale)되었고 2-of-N 보조 쿼럼도 합의에 실패한 경우입니다(모든 보조 오라클이 오프라인이거나 메인 오라클과 일치하지 않음). 프로토콜이 대출 양측에 대해 신뢰할 수 있는 가격을 알 수 없으므로 공정한 분할을 계산할 수 없습니다.

발생하는 일:

- 렌더는 **계산된 가치와 관계없이** 압류된 담보 **전체**를 담보 자산으로 받습니다(어떤 수치도 신뢰할 수 없기 때문).
- 트레저리는 아무것도 받지 못합니다.
- 대출자는 아무것도 받지 못합니다.

지급 방식은 케이스 2와 같지만 이유는 근본적으로 다릅니다. 프로토콜이 "담보 가치가 부채보다 낮다"고 판단하는 것이 아니라, "여기서 어떤 숫자도 믿을 수 없으므로 렌더가 전체 담보 바스켓을 가져가고 그 시장 가치가 얼마가 되든 감수한다"고 결정하는 것입니다.

감사인이 사후 분석에서 두 경로를 구분할 수 있도록 별도의 온체인 이벤트(`LiquidationFallbackOracleUnavailable`)가 발생합니다.

<a id="liquidation-mechanics.case-4"></a>

### 케이스 4 — 어느 한 쪽에 비유동적(Illiquid) 자산이 있는 경우

비유동적 자산 경로입니다. 대출 자산이나 담보 자산, 또는 둘 다 프로토콜 분류상 Liquid(유동적) 자격이 없는 경우입니다(Chainlink 피드가 없거나 거래량 기준을 넘는 Uniswap V3 스타일의 집중 유동성 풀이 없음). NFT 담보나 롱테일 토큰에서 흔히 발생합니다.

디폴트 시 발생하는 일:

- 렌더는 시장 가치와 관계없이 **담보 전체**를 현물로 받습니다.
- "미상환 금액"과 "나머지" 사이의 구분이 없습니다 — 오라클 가격을 적용할 수 없기 때문입니다.
- 자산 가치는 미상환 금액보다 상당히 높거나 낮을 수 있습니다. 재판매 가능성에 대한 보증은 없습니다.

오퍼 생성 시 양 당사자가 이에 동의했습니다 — Risk Disclosures의 비유동적 자산 조항이 바로 이 케이스를 다룹니다. 양측이 비유동적 자산이 포함된 대출을 의도적으로 선택하지 않는 한 이 경로에 도달할 수 없습니다.

<a id="liquidation-mechanics.why-in-kind"></a>

### 왜 현금이 아닌 현물(in-kind)인가요?

프로토콜이 항상 대출 자산으로 스왑하지 않고 담보 자산 단위로 지급하는 데에는 세 가지 이유가 있습니다.

- **시퀀서 / DEX 장애**: 프로토콜이 안전하게 스왑을 실행할 수 없을 때(슬리피지 > 6%, 유동성 부족, DEX 리버트, 시퀀서 중단 등), 가장 안전한 조치는 이미 보유한 것(압류된 담보)을 직접 전달하는 것입니다. 어떤 대가를 치르더라도 스왑을 강제하면 손실이 확정될 수 있습니다.
- **블랙 스완 상황**: 변동성이 극심할 때는 오라클 사용 가능 경로가 몇 분 만에 사라질 수 있습니다. 현물 폴백을 미리 준비해 두면 모든 가격 소스가 불안정한 상황에서도 프로토콜 기능을 유지할 수 있습니다.
- **카운터파티 페어 복구**: 클레임 시점에 렌더(또는 키퍼 봇)는 전체 4-DEX 페일오버를 통해 두 번째 리트라이 기회를 얻습니다. 그때까지 상황이 정상화되었다면, 청산 시 시도했던 것과 동일한 라우팅 인프라를 통해 현물 담보를 대출 자산으로 매도할 수 있습니다.

<a id="liquidation-mechanics.claim-time-retry"></a>

### 클레임 시점 리트라이

`ClaimFacet.claimAsLenderWithRetry`를 통해 대출이 `FallbackPending` 상태일 때 렌더(또는 렌더의 NFT를 대신하는 키퍼)는 스왑 어댑터 호출 목록(0x → 1inch → Uniswap V3 → Balancer V2)을 순위별로 제공하여 재시도할 수 있습니다. 라이브러리는 목록을 순회하며 첫 번째 성공 시 커밋하고, 렌더 및 대출자 클레임을 원금 자산 수익으로 재작성합니다.

전적으로 실패하면 기록된 담보 분할이 그대로 유지되며 대출은 최종적으로 Defaulted 상태로 전이됩니다. 이 시점에서 렌더는 현물 담보를 가져가며 외부 채널을 통해 자유롭게 매도할 수 있습니다.

<a id="liquidation-mechanics.internal-match-rescue"></a>

### 클레임 전 내부 매칭 구조

외부 스왑이 실행되기 전 — HF 청산 시, 시간 기반 디폴트 시, 그리고 클레임 시점에 — 프로토콜은 먼저 DEX 개입 없이 이 대출을 정산할 수 있는 **반대 방향 대출**(opposing-direction loan)이 존재하는지 확인합니다.

대출 A가 WETH를 팔아 USDC를 얻어야 하고 대출 B가 USDC를 팔아 WETH를 얻어야 한다면, 두 대출은 프로토콜 오라클 가격으로 직접 매칭될 수 있습니다. A의 담보가 B의 부채를 충당하고 그 반대도 마찬가지입니다. 애그리게이터도, 슬리피지도, 스왑 수수료도 없습니다. 대출자는 담보를 훨씬 더 많이 지킬 수 있고, 렌더는 오라클 가격으로 전액 상환을 받습니다.

이 내부 매칭 경로는 자동으로 실행됩니다:

- **HF 청산 시** — 키퍼가 청산을 호출하고 반대 카운터파티가 존재할 때, 프로토콜은 스왑 대신 내부 정산을 수행합니다. 키퍼는 여전히 매칭 인센티브를 받습니다.
- **시간 기반 디폴트 시** — 디폴트 스왑 전에 동일한 확인을 수행합니다.
- **클레임 시 시점** — 렌더가 `FallbackPending`에 묶인 대출을 클레임할 때, 프로토콜은 반대 카운터파티를 다시 확인합니다. 이는 진정한 두 번째 기회입니다. 매칭 가능한 대출 풀은 계속 늘어나기 때문에, 청산이 처음 실패했을 때는 없었던 카운터파티가 클레임 시점에는 존재할 수 있습니다.

청산 시 스왑이 일시적인 이유(슬리피지 급등, DEX 리버트, 만료된 오라클 틱)로 실패하여 `FallbackPending`에 들어간 대출은 구조 1순위 후보입니다. 기초 담보는 대개 여전히 유동성이 풍부하며 반대 대출을 통해 깔끔하게 처리될 수 있습니다. 프로토콜은 오라클이 자산 가격을 제시할 수 있기만 하면 되며, 내부 매칭은 DEX를 거치지 않으므로 DEX 깊이(depth)는 필요하지 않습니다.

반대 카운터파티가 존재하지 않으면 프로토콜은 위에서 설명한 외부 애그리게이터 경로로 넘어갑니다. 내부 매칭은 가능할 때만 실행되는 최적화(strictly-better-when-available)이며, 정산을 방해하는 요소가 아닙니다.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

이 chain에서 wallet이 protocol에 부여한 모든 ERC-20 allowance를 나열합니다.
candidate-token list를 on-chain allowance views에 대해 scan해 source합니다.
Revoke는 allowance를 zero로 set합니다.

Exact-amount approval policy에 따라 protocol은 unlimited allowances를
요구하지 않으므로 typical revocation list는 짧습니다.

참고: Permit2-style flows는 single signature를 사용해 protocol의 per-asset
allowance를 우회합니다. 따라서 여기 list가 clean해도 향후 deposits를
막지 않습니다.

---

## Alerts

<a id="alerts.overview"></a>

### Alerts 소개

off-chain watcher가 wallet과 관련된 모든 active loans를 5-minute cadence로
poll하고, 각각의 live Health Factor를 읽은 뒤 unsafe direction으로 band를
cross하면 configured channels를 통해 한 번 alert를 fire합니다. on-chain state도
gas도 없습니다. Alerts는 advisory입니다 — funds를 move하지 않습니다.

<a id="alerts.threshold-ladder"></a>

### Threshold Ladder

user-configured HF bands의 ladder입니다. 더 risky한 band로 crossing하면
한 번 fire하고 다음 deeper threshold를 arm합니다. band 위로 다시 올라가면
re-arm됩니다. default: 1.5 → 1.3 → 1.1. 높은 values는 volatile collateral에
적합합니다. ladder의 목적은 HF가 1.0 아래로 떨어져 liquidation이 trigger되기
전에 경고하는 것입니다.

<a id="alerts.delivery-channels"></a>

### Delivery Channels

두 rails:

- **Telegram** — wallet의 short address, loan id, 현재 HF가 포함된 bot
  direct message.
- **Push Protocol** — Vaipakam Push channel을 통한 wallet-direct notification.

둘 다 threshold ladder를 공유합니다. drift를 피하기 위해 per-channel warning
levels는 의도적으로 expose되지 않습니다. Push channel publishing은 현재
channel creation까지 stub 상태입니다.

---

## NFT Verifier

<a id="nft-verifier.lookup"></a>

### NFT 검증

NFT contract address와 token id가 주어지면 verifier는 다음을 fetch합니다:

- 현재 owner(또는 token이 이미 burn된 경우 burn signal).
- on-chain JSON metadata.
- Protocol cross-check: metadata에서 underlying loan id를 derive하고,
  state를 confirm하기 위해 protocol에서 loan details를 읽습니다.

표시되는 내용: Vaipakam이 mint한 것인가? 어느 chain인가? loan status는?
현재 holder는 누구인가? fake, 이미 claimed된(burned) position, 또는 loan이
settled되었고 claim 진행 중인 position을 식별할 수 있습니다.

position NFT는 bearer instrument입니다 — secondary market에서 매수하기 전에
verify하세요.

---

## Keeper Settings

<a id="keeper-settings.overview"></a>

### Keepers 소개

wallet당 최대 5 keepers까지 둘 수 있는 keeper allowlist입니다. 각 keeper는
loan의 **내 side**에서 specific maintenance calls를 authorise하는 action
permissions set을 가집니다. Money-out paths(repay, claim, add collateral,
liquidate)는 설계상 user-only이며 delegate할 수 없습니다.

action time에는 두 가지 추가 gates가 apply됩니다:

1. master keeper-access switch — allowlist를 건드리지 않고 모든 keeper를
   disable하는 one-flip emergency brake.
2. per-loan opt-in toggle. Offer Book 또는 Loan Details interface에서 설정.

keeper는 네 조건이 모두 충족될 때만 act할 수 있습니다: approved,
master switch on, per-loan toggle on, 그리고 해당 keeper에 specific action
permission이 설정되어 있음.

<a id="keeper-settings.approved-list"></a>

### Approved Keepers

현재 expose된 action permissions:

- **Loan sale 완료** (lender side, secondary-market exit).
- **Offset 완료** (borrower side, collateral sale을 통한 preclose의 second leg).
- **Early withdrawal 시작** (lender side, position을 sale listing).
- **Preclose 시작** (borrower side, preclose flow 시작).
- **Refinance** (borrower side, 새 borrower offer에서 atomic loan swap).

frontend가 아직 reflect하지 않은 on-chain permissions는 명확한
"permission invalid" revert를 받습니다. Revocation은 모든 loans에서 즉시
적용됩니다 — waiting period는 없습니다.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics 소개

supported chains 각각에서 on-chain protocol view calls로부터 live로
calculate되는 wallet-free aggregator입니다. backend 없음, database 없음.
CSV / JSON export가 available합니다. verifiability를 위해 각 metric 뒤의
protocol address와 view function이 표시됩니다.

<a id="public-dashboard.combined"></a>

### Combined — All Chains

Cross-chain rollup입니다. header는 covered된 chains 수와 errored된 chains
수를 report하므로 fetch 시 unreachable RPC가 명확히 드러납니다. 하나 이상의
chain이 errored인 경우 per-chain table이 어느 chain인지 flag합니다 — TVL
totals는 계속 report되지만 gap은 acknowledge됩니다.

<a id="public-dashboard.per-chain"></a>

### Per-Chain Breakdown

Combined metrics의 per-chain split입니다. TVL concentration, mismatched
VPFI mirror supplies(mirror supplies의 sum은 canonical adapter의 locked
balance와 같아야 함), 또는 stalled chain을 spot하는 데 유용합니다.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI Token Transparency

active chain의 on-chain VPFI accounting:

- total supply, ERC-20에서 직접 읽음.
- circulating supply — total supply minus protocol-held balances(treasury,
  reward pools, in-flight bridge packets).
- 남은 mintable cap — canonical chain에서만 meaningful합니다. Mirror chains는
  cap에 대해 "n/a"를 report합니다. 그곳의 mints는 cap이 아니라 bridge-driven
  이기 때문입니다.

Cross-chain invariant: 모든 mirror chains에 걸친 mirror supplies의 sum은
canonical adapter의 locked balance와 같습니다. watcher가 이를 monitor하고
drift에 alert합니다.

<a id="public-dashboard.transparency"></a>

### Transparency & Source

각 metric에 대해 page가 list하는 것:

- snapshot으로 사용된 block number.
- data freshness(chains 간 최대 지연 시간).
- protocol address와 view function call.

이 page의 어떤 number든 RPC + block + protocol address + function name에서
누구나 re-derive할 수 있습니다 — 그것이 기준입니다.

---

## Refinance

이 페이지는 borrower 전용입니다 — refinance는 borrower가 자신의 loan에서
시작합니다.

<a id="refinance.overview"></a>

### Refinancing 소개

Refinance는 기존 loan을 새 principal로 atomically repay하고 새 terms로 fresh
loan을 open합니다. 모두 한 번의 transaction에서 이루어집니다. collateral은
내내 vault에 머뭅니다 — unsecured window는 없습니다. 새 loan은 다른 loan과
마찬가지로 initiation 시 HF ≥ 1.5 gate를 clear해야 합니다.

옛 loan의 unused Loan Initiation Fee rebate는 swap의 일부로 올바르게
settle됩니다.

<a id="refinance.position-summary"></a>

### 내 현재 포지션

refinance하는 loan의 snapshot입니다 — 현재 principal, 지금까지 accrued된
interest, HF / LTV, collateral basket. 새 offer는 최소한 outstanding
amount(principal + accrued interest)에 맞춰 size해야 합니다. 새 offer의
surplus는 free principal로 vault에 deliver됩니다.

<a id="refinance.step-1-post-offer"></a>

### Step 1 — 새 offer 게시

target terms로 borrower offer를 게시합니다. 기다리는 동안 옛 loan은 계속
interest를 accrue하고 collateral은 locked 상태로 유지됩니다. offer는 public
Offer Book에 표시되며 어떤 lender든 accept할 수 있습니다. acceptance 전에는
cancel할 수 있습니다.

<a id="refinance.step-2-complete"></a>

### Step 2 — 완료

새 lender가 accept한 후 atomic 정산:

1. accepting lender에게서 새 loan을 fund.
2. 옛 loan을 full repay(principal + interest, treasury cut 후).
3. 옛 position NFTs burn.
4. 새 position NFTs mint.
5. 옛 loan의 unused Loan Initiation Fee rebate settle.

새 terms에서 HF가 1.5 미만이면 revert합니다.

---

## Preclose

이 페이지는 borrower 전용입니다 — preclose는 borrower가 자신의 loan에서
시작합니다.

<a id="preclose.overview"></a>

### Preclose 소개

borrower-driven early termination입니다. 두 가지 paths:

- **Direct** — outstanding amount(principal + accrued interest)를 wallet에서
  지불하고, collateral을 release하며, unused Loan Initiation Fee rebate를
  settle합니다.
- **Offset** — protocol의 4-DEX swap failover를 통해 collateral 일부를
  principal asset으로 swap하기 위해 offset을 initiate합니다. Offset을 complete하면
  proceeds로 repay하고 나머지 collateral은 나에게 돌아옵니다. 같은 rebate
  settlement입니다.

flat early-close penalty는 없습니다. time-weighted VPFI math가 fairness를
처리합니다.

<a id="preclose.position-summary"></a>

### 내 현재 포지션

preclose하는 loan의 snapshot입니다 — outstanding principal, accrued interest,
현재 HF / LTV. preclose flow는 exit 시 HF ≥ 1.5를 **요구하지 않습니다**
(이는 closure이며 re-init이 아닙니다).

<a id="preclose.in-progress"></a>

### Offset In Progress

상태: offset initiated, swap이 실행 중입니다(또는 quote는
consumed되었지만 final settle이 pending). 두 exits:

- **Offset 완료** — realised proceeds로 loan을 settle하고 나머지를 돌려줍니다.
- **Offset 취소** — abort합니다. collateral은 locked 상태로 유지되고 loan은
  unchanged입니다. initiate와 complete 사이에 swap이 나에게 불리하게 움직였을 때
  사용합니다.

<a id="preclose.choose-path"></a>

### 경로 선택

Direct path는 principal asset의 wallet liquidity를 사용합니다. Offset path는
DEX swap을 통해 collateral을 사용합니다 — principal asset이 손에 없거나
collateral position에서도 exit하고 싶을 때 적합합니다. Offset slippage는
liquidation에 쓰이는 것과 같은 4-DEX failover로 bound됩니다 (0x → 1inch →
Uniswap V3 → Balancer V2).

---

## Early Withdrawal (Lender)

이 페이지는 lender 전용입니다 — early withdrawal은 lender가 자신의 loan에서
시작합니다.

<a id="early-withdrawal.overview"></a>

### Lender Early Exit 소개

lender positions를 위한 secondary-market mechanism입니다. 선택한 price로
position NFT를 sale listing합니다. acceptance 시 buyer가 payment하고,
lender NFT ownership이 buyer에게 transfer되며, buyer가 모든 future
settlement(terminal claim 등)의 lender of record가 됩니다. 나는 sale proceeds를
받고 exit합니다.

Liquidations는 user-only로 남으며 sale을 통해 delegate되지 않습니다 —
transfer되는 것은 claim할 권리뿐입니다.

<a id="early-withdrawal.position-summary"></a>

### 내 현재 포지션

snapshot입니다 — outstanding principal, accrued interest, 남은 시간,
borrower side의 현재 HF / LTV. 이 값들이 buyer market이 기대하는 fair
price를 결정합니다: buyer의 payoff는 terminal에서 principal plus interest이며,
남은 시간 동안의 liquidation risk를 차감해 평가됩니다.

<a id="early-withdrawal.initiate-sale"></a>

### 판매 시작

asking price로 protocol을 통해 position NFT를 sale listing합니다. buyer가 sale을
complete합니다. sale fill 전에는 cancel할 수 있습니다. "complete loan sale"
permission을 가진 keeper에게 delegate할 수도 있습니다. initiate step 자체는
user-only로 남습니다.

---

## 묶인 토큰(Stuck-Token) 복구

이 섹션은 대부분의 사용자가 필요로 하지 않는 특수 사례(EDGE CASE)를 다룹니다. 아래의 복구 링크를 클릭하기 전에 이 내용을 모두 읽으십시오 — 잘못된 소스를 신고하면 프로토콜의 제재 정책(sanctions policy)에 따라 Vault가 잠길 수 있습니다.

<a id="stuck-recovery.what"></a>

### "묶인 토큰"(stuck token)의 의미

내 Vaipakam Vault 프록시는 내부 프로토콜 저장소입니다. 입금 주소가 아닙니다. 모든 프로토콜 지원 입금은 오퍼 생성, 대출 수락 또는 스테이킹 작업의 일부로 지갑에서 볼트로 자금을 가져오는 Vaipakam의 패싯 진입점을 통해 흐릅니다. 해당 흐름 외부에서 볼트에 도착한 토큰 — 지갑에서 직접 `IERC20.transfer`를 하거나 볼트 주소를 복사하여 붙여넣은 CEX 출금 등 — 은 프로토콜 장부 없이 그곳에 머물게 됩니다. 자산 뷰어는 프로토콜이 추적하는 잔액만 보여줌으로써 이를 숨깁니다.

토큰이 묶이는 두 가지 경로:

1. **직접 보낸 경우.** 대시보드나 블록 탐색기에서 볼트 주소를 복사하여 CEX 출금 필드나 지갑의 토큰 전송 양식에 붙여넣고 제출한 경우입니다. 토큰은 프로토콜의 입금 경로를 거치지 않고 볼트에 도달했습니다.

2. **제3자가 보낸 경우 ("dust attack").** 누군가 내 주소를 자신의 평판과 연결하려는 목적으로 플래그가 지정된 지갑에서 내 볼트로 소량을 전송한 경우입니다. 이는 비허가형 체인의 유명 주소를 대상으로 하는 실제 공격 벡터입니다.

<a id="stuck-recovery.taint-poisoning"></a>

### "오염 독식"(taint poisoning) 소개

제3자 발신자가 제재 목록에 있는 경우, 비록 내가 들어온 토큰에 손을 대지 않았더라도 일반적인 온체인 분석 도구는 내 볼트를 "제재 인접"으로 표시할 수 있습니다. 온체인에서 이를 취소할 방법은 없습니다 — 전송 이벤트는 영구적입니다. Vaipakam의 내부(INTERNAL) 장부는 영향을 받지 않으므로(프로토콜 중개 입금만 추적하며, 더스트는 카운터에 들어오지 않음), 대출 / 스테이킹 / 클레임은 정상적으로 계속 작동합니다. 하지만 우리 회계 방식을 이해하지 못하는 외부 도구는 경고를 표시할 수 있습니다.

<a id="stuck-recovery.dont-recover"></a>

### 복구하지 말아야 할 때

토큰을 직접 보내지 않았다면 **복구하지 마십시오**. 복구하려면 발신자 주소를 신고해야 합니다. 해당 주소가 제재 목록에 있는 경우, 오라클에서 소스가 삭제될 때까지 내 볼트는 프로토콜의 제재 정책에 따라 잠깁니다.

보내지 않은 토큰은 내 것이 아닙니다. 실제로 소유하지 않은 "깨끗한" 주소를 신고하여 복구하려는 것도 나쁜 생각입니다 — 프로토콜은 온체인 신고를 검증할 수 없지만, 외부 오라클 도구가 나중에 이견을 보일 수 있습니다.

안전한 방법은 요청하지 않은 더스트를 무시하는 것입니다. 이는 프로토콜 잔액이나 활성 대출 / 오퍼에 영향을 주지 않습니다.

<a id="stuck-recovery.when-recover"></a>

### 복구해야 할 때

실수로 토큰을 직접 보냈고, 소스 지갑을 직접 제어하며, 소스가 제재 목록에 없음을 알고 있는 경우(자체 EOA, 출금한 CEX 핫월렛 등)입니다.

<a id="stuck-recovery.flow"></a>

### 복구 흐름

1. [복구 페이지](/app/recover)를 방문하십시오.
2. 토큰 컨트랙트 주소, 보낸 소스, 금액을 입력하십시오.
3. 화면의 안내를 주의 깊게 검토하십시오.
4. "CONFIRM"을 입력하여 서명을 활성화하십시오.
5. 지갑에서 EIP-712 안내에 서명하십시오.
6. 트랜잭션을 제출하십시오.

두 가지 결과:

- **소스가 깨끗함** → 토큰이 내 EOA로 반환됩니다.
- **소스에 플래그 지정됨** → 토큰이 볼트에 머물고, 내 볼트는 프로토콜의 제재 정책에 따라 잠깁니다. 나중에 제재 오라클에서 주소가 제거되면 잠금은 자동으로 해제됩니다.

<a id="stuck-recovery.disown"></a>

### 요청하지 않은 토큰 소유권 포기 (준법 감시 감사 추적)

볼트의 특정 토큰 잔액이 내 것이 아니라는 온체인 기록을 남기고 싶다면 프로토콜은 `disown(token)` 함수를 제공합니다. 이 함수는 이벤트(`TokenDisowned`)를 발생시키고 다른 것은 변경하지 않습니다 — 토큰은 이전처럼 볼트에 남습니다. CEX나 규제 기관이 "이 자금을 받았습니까?"라고 물을 때 온체인 이벤트를 제시하여 대응하는 데 유용합니다.

소유권 포기 함수는 현재 직접 컨트랙트 호출을 통해서만 노출되며, Vaipakam 프런트엔드에서는 버튼으로 표시되지 않습니다. 블록 탐색기의 "Write Contract" UI나 컨트랙트 상호작용 도구를 사용하여 호출하십시오.

