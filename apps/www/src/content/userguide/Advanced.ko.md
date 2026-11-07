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

<a id="chapter.dashboard"></a>

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

wallet-level opt-in flag로, 보유한 VPFI를 수수료 할인으로 바꿔 줍니다.
**차입자로서**는 할인이 Loan Initiation Fee 자체를 직접 깎아주는 방식이며
loan이 accept될 때 lending asset으로 부과되고, 이를 위해 vault에서 차감되는
것은 없습니다. **대여자로서**는 이자 수수료 할인이 settlement 시 적용되며,
VPFI 가격 기준이 설정되어 있으면 vault에서 VPFI로 정산할 수도 있어 대출
자산 수수료 전액을 그대로 가질 수 있습니다.
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
balance를 기준으로 calculate됩니다. 실제로 부과되는 rate는 settlement
시점의 tier에서 결정되며, 각 loan의 자체 기간에 대해 별도의 average를
내지 않습니다. 방어 장치는 tier 자체입니다. tier는 최대 30일의 최근
window — protocol 설정이며, 현재 holding이 시작된 날부터 세고, 최근
날짜에 더 큰 가중치를 둡니다 — 동안의 일별 balance에 대한
time-weighted average이고, 그 average는 다시 그 holding이 시작된 이후
한 번이라도 내려간 가장 낮은 tier까지 끌어내려집니다. 이쪽은 최대
30일을 거슬러 봅니다.

**이 둘은 서로 다른 look-back이며, 보통 뒤쪽이 더 깁니다.** averaging
window는 설정 가능하고 30일보다 짧게 둘 수도 있지만, 가장 낮은 tier의
look-back은 거기에 묶여 있지 않고 현재 holding 전체(최대 30일)에
걸칩니다. 따라서 averaging window가 14일이어도, 20일 전의 하락은
average 밖에 있으면서 여전히 tier를 눌러 둡니다.

0보다 큰 balance를 **끊김 없이** 최소 일수 동안 hold하기 전까지 tier는
완전히 0이며, 이 역시 protocol 설정입니다. 이 기간은 balance가 0에서
양수로 바뀔 때 시작되고, 다시 0이 될 때만 처음부터 다시 셉니다. 이미
가지고 있던 holding에 더 넣는 것으로는 초기화되지 않습니다.

그래서 withdraw는 내가 관여하는 모든 open loans에 즉시 영향을 미칩니다
— 이전 (높은) tier가 계속 적용되는 grace window는 없습니다. 이는 loan
종료 직전에 VPFI를 top up해 full-tier discount를 받고 몇 초 뒤
withdraw하는 exploit pattern을 막습니다. 어떤 규칙이 막는지 보십시오.
오래 hold해 온 사람은 최소 보유 기간을 이미 충족했으므로, 일을 하는
것은 가장 낮은 tier 규칙입니다. average로는 할 수 없는 일입니다.
average는 늦은 top up으로 끌어올릴 수 있지만 최솟값은 그럴 수 없기
때문입니다.

그 특정 pattern에 대해서는 현재 규칙이 둘 중 더 강합니다. 다만 **모든
면에서** 더 엄격한 것은 아닙니다. 가장 낮은 tier의 look-back이 최대
30일까지만 거슬러 가므로, 긴 loan의 초기 낮은 tier 기간은 결국 계산에서
빠지지만, loan 전체에 걸친 average였다면 그대로 남았을 것입니다. 이번
변경은 짧은 top up에 대한 방어를 강화하고 기억을 짧게 만들었습니다.

**위 내용은 lender yield fee에 대한 것입니다.** 차입자의 개시 수수료율은
loan이 accept될 때 한 번만 읽히며, 이후 withdraw나 top up으로 바뀌지 않습니다.

discount는 settlement 시 lender yield fee와 borrower의 Loan Initiation
Fee에 적용됩니다. 후자에서는 **당신이 lending asset으로 내는 수수료
자체를 직접 깎아주는 방식**이며, loan이 accept될 때 적용됩니다. 그
수수료를 내기 위해 vault에서 VPFI가 빠져나가지 않으며, 이후에 claim할
rebate도 없습니다.

> **Loan Initiation Fee rebate를 기다리고 있다면 이 부분을 읽어
> 주세요.** 이전 모델은 수수료 전액을 VPFI로 선취해 loan 존속 기간
> 동안 보관했다가 claim할 때 일부를 돌려주었습니다. **이 경로는
> 삭제되었습니다.** 이 경로로 개설된 loan은 하나도 없으므로, 어떤
> loan에도 initiation fee에 대해 보관된 VPFI나 받을 rebate가
> 없습니다 — 기다린다면 결코 도착할 수 없는 돈을 기다리는
> 것입니다.

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

connected wallet의 VPFI rewards 전체 그림을 하나의 view로 보여 주는
summary card입니다. headline figure는 pending interaction rewards와
lifetime-claimed interaction rewards의 합계입니다.

breakdown row는 pending + claimed를 보여 주고, native page의 full
claim card로 이어지는 chevron deep-link를 제공합니다:

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
card를 숨기면 새 users는 Claim Center에 들어가기 전까지 rewards
program을 알아차리기 어렵습니다.

---

<a id="chapter.offer-book"></a>

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
없습니다. interest에 대한 `{liveValue:treasuryFeeBps}`% treasury cut은 terminal settlement에서
debit되며 upfront가 아닙니다.
이 rate는 loan이 생성될 때 고정되므로, 이후 protocol fee가 바뀌어도 이미 열려 있는 loan은 시작할 때의 rate를 유지합니다.

<a id="offer-book.borrower-offers"></a>

### Borrower Offers

이미 collateral을 vault에 lock한 borrowers의 active offers입니다.
accept하는 쪽은 lender입니다. acceptance는 principal asset으로 loan을
fund하고 position NFTs를 mint합니다. initiation 시 같은 HF ≥ 1.5 gate가
적용됩니다. fixed APR은 offer creation 시 set되고 loan lifetime 동안
immutable입니다 — refinance는 기존 loan을 변경하지 않고 새 loan을
만듭니다.

---

<a id="chapter.create-offer"></a>

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
  interest에 대한 `{liveValue:treasuryFeeBps}`% treasury cut을 뺀 net입니다.
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
  transfer합니다. residual claim은 전혀 없습니다.

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
   `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]**가 참조), 호출 전 ask에 대해
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
   (`apps/indexer/src/openseaPublish.ts`)는 endpoint 호출 전에
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
  creator fee를 뺀 것)만 diamond의 워터폴로 전달합니다. 판매는 담보로 자금을 조달한 상환이므로, diamond는 그 net 금액을
  fill 시점의 상환과 정확히 같은 방식으로 결제합니다: 대출은 상환
  완료가 되고; 렌더의 몫(대출이 `useFullTermInterest = true`로
  생성된 경우 전체 쿠폰, 그렇지 않으면 그때까지 누적된 이자, 여기에
  렌더의 yield-fee 할인이 있으면 그만큼)은 렌더의 볼트에 놓여 일반
  렌더 클레임을 통해 현재 렌더 포지션 보유자에게 지급되며;
  트레저리는 그 할인을 뺀 컷을 받고; 나머지는 현재 대출자 포지션
  보유자의 지갑으로 전송됩니다. 나머지를 그 지갑으로 지급할 수 없으면 나머지는
  보류되어 Claim Center의 일반 대출자 클레임을 통해 지급됩니다.
  렌더는 판매 자체 안에서 지급받지 않으므로, 렌더의 지갑에 관한
  어떤 것도 판매를 막을 수 없습니다.

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


<a id="chapter.claim-center"></a>

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
- accrued interest에서, loan 생성 시 고정된 treasury cut(현재
  요율로 생성된 loan은 `{liveValue:treasuryFeeBps}`%)을 뺀 금액.
  consent가 on이면 그 cut 자체가 time-weighted VPFI fee-discount
  accumulator에 의해 더 줄어듭니다.

loan이 terminal state(Settled, Defaulted, 또는 Liquidated)에 도달하는
즉시 claimable해집니다. Lender position NFT는 같은 transaction에서
burn됩니다.

<a id="claim-center.claims:borrower"></a>

#### 내가 borrower인 경우

Borrower claim은 loan이 어떻게 정산되었는지에 따라 다음을
반환합니다:

- **full repayment / preclose / refinance** — 내 collateral basket.
  Loan Initiation Fee rebate는 함께 오지 않습니다: 할인은 acceptance
  시점에 이미 수수료에서 차감되었습니다.
- **loan을 정산하는 prepay sale** — collateral은 구매자에게 가고 내게
  돌아오지 않습니다. 받는 것은 매각가에서 lender 몫, treasury 컷,
  listing에 붙은 seller fee를 뺀 금액이며, borrower position NFT
  보유자에게 지급됩니다.
- **swap-to-repay** — collateral은 빚을 갚기 위해, 여러분이 정한 상한
  까지 팔립니다. 상한을 넉넉히 두면 빚이 엄밀히 필요로 한 것보다 더
  소모될 수 있고, 소모되지 않은 몫은 돌아옵니다. loan 자체 asset의
  잉여는 보통 claim으로 기다리지 않고 borrower NFT 보유자에게 곧바로
  지급됩니다 — 다만 그 보유자가 제재로 동결된 경우에는 claim으로
  묶여 있게 됩니다.
- **HF-liquidation 또는 default** — 그래도 확인해 보세요. surplus가 남아
  있을 수 있습니다. liquidator와 lender, treasury를 충당할
  만큼의 가치만 가져가고 나머지는 내 claim으로 기록됩니다. 그 형태는 한 가지로 갈립니다. collateral이
  팔렸는가, 넘겨졌는가. 팔린 경우 — 즉 거래소를 거쳐 밖으로 나간
  경우 — 잔여는 loan의 principal asset으로 도착합니다. 넘겨진
  경우 남는 것은 collateral 그 자체이며, vault에 encumbered
  상태로 있습니다. 넘기는 경로는 여럿이고, 모두 loan이 어떻게 끝났는지와는 무관합니다: liquidator가 할인된 값에 직접 가져가는
  경우, close-out이 거래소로 가지 않고 내부에서 반대편 position과 매칭되는 경우, 그리고 매각 자체가 성사되지 못한 경우 — 그때는 collateral이 옵니다 — claim 시점에 lender가 통하는 견적을 가져오지 않는 한 그렇고, 가져오면
  loan의 asset으로 지급됩니다. 대부분의 claim은 견적을 아예 가져오지 않습니다. 일반 liquidation도 시간 기반
  default도 거래소로 가기 전에 그 내부 매칭을 먼저 시도하므로, 이 두 경로는 결과가 늘 같지는 않습니다 —
  그래서 경로가 아니라 claim을 읽어야 합니다. 할인 경로는 오히려 예측 가능합니다. 다만 반대 방향으로: 팔지도
  매칭하지도 않으므로 언제나 collateral이 남습니다. 부분
  liquidation은 애초에 close-out이 아닙니다 — loan은 열린 채로 남고
  claim도 만들어지지 않습니다. 어느 쪽인지 추측하지 말고 claim을
  확인하세요. 비유동 자산의
  default에서는 바스켓 전체가 나가 아무것도 남지 않습니다. 이 경로에서는
  그것이 우연이 아니라 규칙입니다.

Borrower position NFT는 claim할 때 burn되며 loan이 정리될 때가 아닙니다 —
따라서 liquidation이 남긴 surplus는 나중에도 받아 갈 수 있습니다. 다만 NFT가
남아 있다는 것 자체가 surplus의 증거는 아닙니다. liquidation이 아무것도
남기지 않았다면 받아 갈 것이 없고, claim은 거절되며, NFT는 그대로 남을
수 있습니다. NFT가 아니라 claim을 읽으세요.

---

<a id="chapter.activity"></a>

## Activity

<a id="activity.feed"></a>

### Activity Feed

active chain에서 내 wallet과 관련된 on-chain events입니다. protocol logs
에서 sliding block window로 live sourced됩니다. backend cache는 없습니다
— page load마다 다시 fetch합니다. events는 transaction hash별로 group되어
multi-event transaction(예: accept + initiate가 같은 block 내에서 발생)이
함께 표시됩니다. 최신 순입니다. offers, loans, repayments, claims,
liquidations, NFT mints / burns, VPFI vault deposits / withdrawals를 표시합니다.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI 얻기

VPFI는 자유롭게 transferable합니다. VPFI가 거래되는 open market
어디서든 취득하거나, bridge로 가져올 수 있습니다: VPFI는 Chainlink
CCIP cross-chain token이므로 official bridge를 사용해 supported chains
사이를 이동하며, bridge한 chain의 내 wallet으로 도착합니다.

<a id="buy-vpfi.discount-status"></a>

### 내 VPFI Discount Status

Live status:

- 현재 tier (0~4).
- Vault VPFI 잔액에 다음 tier까지의 차이.
- 현재 tier에서의 할인 비율.
- wallet-level consent flag.

vault VPFI는 deposit되어 있는 동안 discount tier에 count됩니다 —
아래 explicit deposit step 외에 별도의 locking action은 없습니다.

<a id="buy-vpfi.deposit"></a>

### VPFI를 vault에 입금

wallet에서 같은 chain의 내 vault로 옮기는 별도의 explicit deposit
step입니다. 모든 chain에서 필요합니다 — canonical에서도 — vault deposit
spec상 항상 explicit user action이기 때문입니다. Permit2가 configured된
chain에서는 앱이 classic approve + deposit pattern보다 single-signature
path를 prefer합니다. 해당 chain에서 Permit2가 configured되어 있지 않다면
cleanly fall back합니다.

<a id="buy-vpfi.unstake"></a>

### vault에서 VPFI withdraw

VPFI를 vault에서 wallet으로 다시 withdraw합니다. approval leg는 없습니다
— protocol이 vault owner이며 자기 자신을 debit합니다. withdraw는 새로운
(낮은) balance로 fee-discount rate를 즉시 re-stamp하고, 내가 관여하는
모든 open loans에 적용됩니다. 이전 tier가 계속 apply되는 grace window는
없습니다.

<a id="buy-vpfi.cross-chain-tier"></a>

### VPFI tier가 체인 사이를 이동하는 방식

VPFI는 canonical 체인인 Base의 vault에 보유하며, tier를 계산하는 것은
Base입니다. 다른 체인에서 빌리거나 빌려주면 그 체인은 tier의 사본을
적용합니다. 이 사본은 tier를 바꾸는 입금, 출금 또는 다른 작업이 있을
때마다 Base가 Chainlink CCIP로 보냅니다.

알아 둘 점은 세 가지입니다.

- **시간이 지나서만 오른 tier는 Base에서 작업이 있어야 전달됩니다.**
  입금이나 출금 없이 보유 기간이 채워지거나 평균이 따라잡으면 Base의
  값은 즉시 최신이 됩니다. 다른 체인은 Base에서의 다음 입금 또는
  출금(금액 무관) 때 이를 알게 됩니다.
- **낮아진 tier가 먼저 전달됩니다.** 프로토콜은 낮아진 tier를 즉시
  보내고, 높아진 tier의 비용은 체인당 하루에 한 번까지만 부담합니다.
  이후 CCIP 배송에는 보통 몇 분이 걸립니다. 도착할 때까지 그 체인은
  이전 tier를 계속 적용합니다.
- **사본은 만료될 수 있습니다.** 새 사본 없이 60일(기본값)이 지나거나
  tier 표 변경이 그 체인에 도달하면, 오래된 사본으로는 그 체인에서
  할인을 받을 수 없습니다. 새 사본은 tier가 바뀔 때만 보내집니다.

사용하는 체인뿐 아니라 Base에서도 필요한 할인 스위치를 포함한 전체
규칙은 아래 "VPFI 할인의 작동 방식" 장에 있습니다. 배송 설계는
[tier 배송 설계 문서](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
(영어)에 있습니다.

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Rewards 소개

**interaction pool**은 fixed daily emission의 per-day pro-rata share를
지급합니다. 그날의 loan volume에 대한 내 settled-interest contribution
으로 weighted됩니다. daily windows는 window close 후 첫 claim 또는
settlement에서 lazily finalise됩니다.

Rewards는 active chain에서 직접 mint됩니다 — user에게 cross-chain
round-trip은 없습니다. cross-chain reward aggregation은 protocol contracts
사이에서만 일어납니다.

<a id="rewards.claim"></a>

### Rewards Claim

단일 transaction으로 accrued rewards를 claim합니다. interaction rewards는
관련 daily window가 finalise될 때까지 zero입니다(해당 chain에서 다음
non-zero claim 또는 settlement로 trigger되는 lazy finalisation). window가
아직 finalise 중일 때는 UI가 button을 guard해 users가 under-claim하지
않도록 합니다.

<a id="rewards.withdraw-staked"></a>

### Vault VPFI 인출

VPFI 섹션의 "vault에서 VPFI withdraw"와 같은 interface입니다 — vault에서
wallet으로 VPFI를 다시 withdraw합니다. withdraw된 VPFI는 즉시 discount
accumulator에서 빠집니다(모든 open loan에서 post-balance re-stamp).

---

<a id="chapter.loan-details"></a>

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
Illiquid collateral의 경우 default는 collateral 전체를 lender에게
transfer하며, claim할 수 있는 것은 없습니다.

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

- **Lender로 claim** — terminal state 전용. Principal plus interest에서
  loan 생성 시 고정된 treasury cut(현재 요율로 생성된 loan은
  `{liveValue:treasuryFeeBps}`%)을 빼고 반환합니다(consent가 on이면
  time-weighted VPFI yield-fee discount로 더 줄어듭니다). Lender position NFT를 burn합니다.
- **Early withdrawal 시작** — 선택한 asking price로 lender position NFT를
  sale listing합니다. sale을 complete한 buyer가 내 side를 인수하고, 나는
  proceeds를 받습니다. sale이 fill되기 전에는 cancel할 수 있습니다.
- 관련 action permission을 가진 keeper에게 delegate할 수도 있습니다 —
  Keeper Settings를 참조하세요.

<a id="loan-details.actions:borrower"></a>

#### 내가 borrower인 경우

- **Repay** — full 또는 partial. Partial repayment는 outstanding을 줄이고
  HF를 끌어올립니다. Full repayment는 terminal settlement를
  trigger합니다.
- **Preclose direct** — 지금 wallet에서 outstanding amount를 지불하고,
  collateral을 release합니다.
- **Preclose offset** — protocol의 swap router를 통해 collateral 일부를
  팔고, proceeds에서 repay하며, 나머지를 돌려받습니다. two-step:
  initiate, 그 후 complete.
- **Refinance** — 새 terms로 borrower offer를 게시합니다. lender가 accept하면
  complete refinance가 collateral이 vault를 떠나지 않은 채 loans를
  atomically swap합니다.
- **Borrower로 claim** — terminal state 전용. full repayment 시 collateral을
  반환합니다. default / liquidation 시에도 surplus가 남을 수 있습니다. collateral은
  빚과 그것을 정리하는 비용에 필요한 만큼만 가져가기 때문입니다 — 위의
  Claim Center 절을 참고하세요. Borrower position NFT를 burn합니다.

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
land합니다. 트랜잭션은 완전히 성공하거나 (대출 상환 완료로 종료, NFT 전송,
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

<a id="chapter.how-liquidation-actually-works"></a>

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

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Public Analytics 소개

지갑이 필요 없는 단일 체인 페이지입니다. 앱이 가리키는 체인(지갑이
연결되지 않았으면 기본 읽기 체인)을 읽습니다. 체인 간 합산이나
내보내기는 없습니다. 체인을 비교하려면 각 체인에서 페이지를 여세요.
출처는 두 가지이며, 쓰이는 곳마다 표시됩니다.

- 인덱서의 키 없는, CORS가 열린 읽기 API — 대출, 오퍼, 리사이클링,
  루프 클로저 수치
- 공개 RPC를 통한 Diamond 자체의 뷰 함수 — VPFI 토큰과 수수료 수치

어느 출처든 직접 조회해 페이지가 보여주는 내용을 재현할 수
있습니다.

<a id="public-dashboard.loans-offers"></a>

### 대출과 오퍼

`/loans/stats`의 상태별 대출 카운터(정산 대기, 내부 매칭, 나머지
구분을 포함해 부분의 합이 총계가 됩니다), ERC-20과 NFT 렌탈 소계
(자산 유형을 아직 읽지 못한 활성 대출은 따로 표시), 그리고
`/offers/stats`의 오퍼 카운터입니다. 오퍼는 `offers` 테이블만
해당하며 가스 없는 서명 주문은 세지 않습니다. 취소된 오퍼는
인덱스에서 빠지므로 오퍼 합계는 누적 수치가 아닙니다. 없는 카운터는
"보고되지 않음", 불가능한 값은 "보고되었지만 사용할 수 있는 건수가
아님"으로 표시하며, 어느 쪽도 0으로 표시하지 않습니다.

<a id="public-dashboard.recycling"></a>

### 리사이클링 계정과 루프 클로저

리사이클링 계정(`/metrics/recycling`)은 프로그램의 각 날짜별
풀, 그 재원, 인출액을 프로그램 고유의 일 번호로 보여줍니다. 확정되지
않은 날은 풀 없이, 활성화되지 않은 날은 추정치로 표시됩니다. 루프
클로저(`/metrics/loop-closure`)는 UTC 날짜별로 클레임이 지급한 양,
볼트에 남은 양, 흡수된 양을 기록이 도달한 시점과 함께 보여줍니다.
표시 정밀도보다 작은 양수 금액은 그렇다고 표시하고, 비율은 내림하며,
알 수 없는 수치는 절대 0으로 표시하지 않습니다.

<a id="public-dashboard.transparency"></a>

### 투명성과 출처

익스플로러 링크가 있는 Diamond 주소, 체인, 인덱서 커서의 블록과
경과 시간입니다. 인덱서에서 온 모든 수치는 이 커서 시점까지만
최신입니다. 두 응답을 합칠 때는 더 오래된 커서를 표시합니다.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI 토큰

Diamond의 `getVPFISnapshot()`에서 이 체인의 토큰 주소와
`totalSupply`를 가져옵니다. 정식(canonical) 체인에서는 상한, 여유분
(`cap − totalSupply`, 아직 발행할 수 있는 양), 민터도 보여줍니다.
미러 체인의 스냅샷에는 상한도 민터도 없습니다(공급은 CCIP 토큰 풀을
통해 들어옵니다). 그래서 페이지는 로컬 공급량을 보여주고 상한과
민터는 정식 체인의 것이라고 밝히며, 0을 표시하지 않습니다. 연결되지
않은 토큰과 읽을 수 없는 스냅샷은 따로 표시합니다.

<a id="public-dashboard.fees"></a>

### 수수료와 트레저리

`getTreasuryMetrics()`, `getTreasury()`, `getNumeraireSymbol()`
에서 가져오며, 스냅샷과 같은 Multicall3 집계에서 읽고 하나의 블록에
고정합니다. 페이지는 그 블록과 경과 시간을 보여줍니다.

- 수수료 장부가 시작된 이후, 그리고 최근 24시간과 7일의 수수료.
  각 수수료는 기록 시점에 뉴메레르로 평가되며 다시 평가되지
  않습니다.
- 기록 시점에 프로토콜이 평가할 수 없었던 수수료는 0으로 기록되고,
  기간 합계는 최신 장부 항목을 최대 10,000개까지만 훑습니다. 이
  두 가지는 수치를 적게 보이게만 할 수 있고, 페이지는 이를
  밝힙니다.
- 뉴메레르가 바뀌면 이전 항목은 옛 단위로 남으므로, 그 이후의 합계는
  현재 기호 아래 두 단위의 금액을 더하게 되어 어느 방향으로든 어긋날
  수 있습니다. 페이지는 이전 수수료가 옛 단위로 계산된다고 밝힙니다.
- 트레저리 주소. 외부 주소라면 수수료는 징수될 때 빠져나가며 그
  잔액은 표시하지 않습니다. Diamond 자신이 트레저리라면 보유액을
  표시하며, 이는 열린 대출에 나타나는 자산만으로 평가하고 트레저리를
  대신해 다른 곳에 둔 금액을 포함합니다.

실패한 뷰 함수는 "읽을 수 없음"으로 표시되며 다른 항목을 가리지
않습니다.

---

<a id="chapter.refinance"></a>

## Refinance

이 페이지는 borrower 전용입니다 — refinance는 borrower가 자신의 loan에서
시작합니다.

<a id="refinance.overview"></a>

### Refinancing 소개

Refinance는 기존 loan을 새 principal로 atomically repay하고 새 terms로 fresh
loan을 open합니다. 모두 한 번의 transaction에서 이루어집니다. collateral은
내내 vault에 머뭅니다 — unsecured window는 없습니다. 새 loan은 다른 loan과
마찬가지로 initiation 시 HF ≥ 1.5 gate를 clear해야 합니다.

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
3. 옛 loan을 repaid로 표시. position NFTs는 burn되지 않고, 둘 다
   Loan Repaid 상태로 보유자에게 남습니다. 옛 lender는 자신의 NFT로
   상환금을 claim하고, 옛 borrower NFT는 영수증으로 남습니다.
4. 새 position NFTs mint.

새 terms에서 HF가 1.5 미만이면 revert합니다.

---

<a id="chapter.preclose"></a>

## Preclose

이 페이지는 borrower 전용입니다 — preclose는 borrower가 자신의 loan에서
시작합니다.

<a id="preclose.overview"></a>

### Preclose 소개

borrower-driven early termination입니다. 두 가지 paths:

- **Direct** — outstanding amount(principal + accrued interest)를 wallet에서
  지불하고 collateral을 release합니다.
- **Offset** — protocol의 4-DEX swap failover를 통해 collateral 일부를
  principal asset으로 swap하기 위해 offset을 initiate합니다. Offset을 complete하면
  proceeds로 repay하고 나머지 collateral은 나에게 돌아옵니다.

flat early-close penalty는 없습니다.

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.stuck-token-recovery"></a>

## 묶인 토큰(Stuck-Token) 복구

이 섹션은 대부분의 사용자가 필요로 하지 않는 특수 사례(EDGE CASE)를 다룹니다. 아래의 복구 링크를 클릭하기 전에 이 내용을 모두 읽으십시오 — 잘못된 소스를 신고하면 프로토콜의 제재 정책(sanctions policy)에 따라 Vault가 잠길 수 있습니다.

<a id="stuck-recovery.what"></a>

### "묶인 토큰"(stuck token)의 의미

내 Vaipakam Vault 프록시는 내부 프로토콜 저장소입니다. 입금 주소가 아닙니다. 모든 프로토콜 지원 입금은 오퍼 생성, 대출 수락 또는 입금 작업의 일부로 지갑에서 볼트로 자금을 가져오는 Vaipakam의 패싯 진입점을 통해 흐릅니다. 해당 흐름 외부에서 볼트에 도착한 토큰 — 지갑에서 직접 `IERC20.transfer`를 하거나 볼트 주소를 복사하여 붙여넣은 CEX 출금 등 — 은 프로토콜 장부 없이 그곳에 머물게 됩니다. 자산 뷰어는 프로토콜이 추적하는 잔액만 보여줌으로써 이를 숨깁니다.

토큰이 묶이는 두 가지 경로:

1. **직접 보낸 경우.** 대시보드나 블록 탐색기에서 볼트 주소를 복사하여 CEX 출금 필드나 지갑의 토큰 전송 양식에 붙여넣고 제출한 경우입니다. 토큰은 프로토콜의 입금 경로를 거치지 않고 볼트에 도달했습니다.

2. **제3자가 보낸 경우 ("dust attack").** 누군가 내 주소를 자신의 평판과 연결하려는 목적으로 플래그가 지정된 지갑에서 내 볼트로 소량을 전송한 경우입니다. 이는 비허가형 체인의 유명 주소를 대상으로 하는 실제 공격 벡터입니다.

<a id="stuck-recovery.taint-poisoning"></a>

### "오염 독식"(taint poisoning) 소개

제3자 발신자가 제재 목록에 있는 경우, 비록 내가 들어온 토큰에 손을 대지 않았더라도 일반적인 온체인 분석 도구는 내 볼트를 "제재 인접"으로 표시할 수 있습니다. 온체인에서 이를 취소할 방법은 없습니다 — 전송 이벤트는 영구적입니다. Vaipakam의 내부(INTERNAL) 장부는 영향을 받지 않으므로(프로토콜 중개 입금만 추적하며, 더스트는 카운터에 들어오지 않음), 대출 / 입금 / 클레임은 정상적으로 계속 작동합니다. 하지만 우리 회계 방식을 이해하지 못하는 외부 도구는 경고를 표시할 수 있습니다.

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

1. [복구 페이지](https://defi.vaipakam.com/recover)를 방문하십시오.
2. 토큰 컨트랙트 주소, 보낸 소스, 금액을 입력하십시오.
3. 화면의 안내를 주의 깊게 검토하십시오.
4. "CONFIRM"을 입력하여 서명을 활성화하십시오.
5. 지갑에서 EIP-712 안내에 서명하십시오.
6. 트랜잭션을 제출하십시오.

두 가지 결과:

- **소스가 깨끗함** → 토큰이 볼트의 기록 잔액에 추가됩니다. 평소처럼 볼트에서 출금하세요. 보호 계정 모드가 켜져 있으면 지급 지연이 적용됩니다.
- **소스에 플래그 지정됨** → 토큰이 볼트에 머물고, 내 볼트는 프로토콜의 제재 정책에 따라 잠깁니다. 나중에 제재 오라클에서 주소가 제거되면 잠금은 자동으로 해제됩니다.

<a id="stuck-recovery.disown"></a>

### 요청하지 않은 토큰 소유권 포기 (준법 감시 감사 추적)

볼트의 특정 토큰 잔액이 내 것이 아니라는 온체인 기록을 남기고 싶다면 프로토콜은 `disownUntracked(kind, asset, tokenId)` 함수를 제공합니다. 이 함수는 이벤트(`UntrackedDisowned`)를 발생시키고 다른 것은 변경하지 않습니다 — 토큰은 이전처럼 볼트에 남습니다. CEX나 규제 기관이 "이 자금을 받았습니까?"라고 물을 때 온체인 이벤트를 제시하여 대응하는 데 유용합니다.

소유권 포기 함수는 현재 직접 컨트랙트 호출을 통해서만 노출되며, Vaipakam 프런트엔드에서는 버튼으로 표시되지 않습니다. 블록 탐색기의 "Write Contract" UI나 컨트랙트 상호작용 도구를 사용하여 호출하십시오.

<a id="chapter.how-vpfi-discounts-work"></a>

## VPFI 할인의 작동 방식

canonical 체인인 Base의 vault에 VPFI를 보유하면, 플랫폼이 운영되는
모든 체인에서 프로토콜 자체 수수료가 할인됩니다. 더 많이, 더 오래
보유할수록 tier가 높아지고 할인도 커집니다. tier 목록은 위의
[Tier ladder](#dashboard.fee-discount-consent)에 있으며, governance가
바꿀 수 있습니다.

할인이 적용되는 대상:

- **대여자로서**는 벌어들인 이자에서 프로토콜이 떼는 이자 수수료입니다.
  이자가 settlement될 때마다(예: 상환, preclose, refinance) loan 시작
  시점이 아니라 그 순간의 tier로 읽습니다.
- **차입자로서**는 loan이 시작될 때 부과되는 Loan Initiation Fee입니다.
  accept 시점에 한 번만 읽고 그 loan에 고정됩니다. lending asset이
  liquid할 때만 적용되며, illiquid loan은 수수료 전액을 냅니다.

할인은 loan 자산으로 수수료 자체에서 차감되며, 이를 위해 vault에서
VPFI가 빠져나가지 않습니다. 유일한 예외는 VPFI 가격 기준을 설정한
배포에서의 대여자 할인으로, 이 경우 vault의 VPFI로 정산될 수 있습니다.
출시 시점에는 설정된 것이 없습니다. 이 장은 이 보유 할인을 다룹니다.
별도의 유료 수수료 모드인 "Full"은 배포가 켜지 않는 한 꺼져 있습니다.

<a id="vpfi-discounts.turning-on"></a>

### 할인 켜기

할인은 opt-in입니다. 스위치는 VPFI 페이지에 있고, 체인마다 하나씩
있습니다. 각 체인이 자체 설정을 갖기 때문입니다.

- **수수료가 부과되는 체인에서는** 스위치가 켜져 있어야 합니다. 꺼져
  있으면 tier와 관계없이 그 체인은 수수료 전액을 부과합니다.
- **Base에서도** 그곳에서 빌리거나 빌려주지 않더라도 스위치가 켜져
  있어야 합니다. 꺼져 있는 동안 Base는 다른 모든 체인에 당신의 tier를
  0으로 보냅니다.

Base에서 할인을 끄면, 다른 모든 체인에서도 적용이 멈추도록 앱이 이어서 tier 업데이트를 보냅니다. 그러면 Base가 그
체인들에 당신의 tier를 0으로 보냅니다. 이 두 번째 단계가 실패하면 페이지에 표시되며, 다른 체인은 새 tier가 보내질
때까지 마지막 tier를 유지합니다. 다른 체인에서 끄면 그 체인만 바뀝니다.

VPFI는 프로토콜이 당신의 vault에 기록할 때 인정됩니다. VPFI 페이지를 통해 입금한 VPFI와 프로토콜이 vault로
전달한 VPFI rewards가 여기에 해당합니다. vault 주소로 직접 보낸 토큰은 프로토콜이 추적하지 않으며 tier를
올리지 않습니다.

<a id="vpfi-discounts.tier-calculation"></a>

### tier 계산 방식

tier는 세 가지 별도 검사로 정해지며, 세 가지를 모두 통과해야 합니다.

1. **최소 보유 기간.** 현재 보유가 최소 3일 지속될 때까지 tier는 0으로
   유지됩니다. 보유는 vault 잔액이 0을 넘는 순간 시작되어 다시 0이 될
   때까지 이어집니다. 추가로 넣어도 시계는 다시 시작되지 않지만, 전부
   인출하면 다시 시작됩니다. (3일은 기본값이며 governance가 2~14일로
   설정할 수 있습니다.)
2. **최근에 가중치를 둔 평균.** 잔액은 최근 30일에 걸쳐 평균되며,
   마지막 7일은 그 이전 날보다 세 배로 계산됩니다. 평균은 현재 보유가
   시작되기 전으로는 거슬러 올라가지 않으므로, 새 보유자가 아무것도
   갖지 않았던 날 때문에 희석되지 않습니다. (기간, 최근 일수, 가중치는
   governance 설정이며, 기간은 14~30일입니다.)
3. **지금까지 닿은 가장 낮은 tier.** 평균과는 별도로, tier는 현재 보유
   기간 중 잔액이 도달한 가장 낮은 tier보다 높을 수 없으며, 최대
   30일까지 거슬러 봅니다. 각 날의 최저점으로 계산하므로, 같은 날 안에
   내려갔다가 회복한 경우도 내려간 것으로 봅니다.

실제로는 다음을 뜻합니다.

- loan settlement 직전에 입금해도 tier가 바로 오르지 않습니다. 추가한
  금액이 먼저 평균에 반영되어야 하고, 닿았던 최저점이 여전히 상한이
  됩니다.
- tier 하한 아래로 내려가는 출금은 tier를 즉시 낮춥니다.
- 30일보다 오래된 하락은 더 이상 상한이 되지 않습니다.

<a id="vpfi-discounts.other-chains"></a>

### 다른 체인에서의 tier

tier는 Base가 계산합니다. 다른 모든 체인은 Base가 Chainlink CCIP로 보내는 사본을 적용합니다. Base는
Base에서 다음 중 하나가 일어날 때 tier 기록을 갱신합니다. VPFI가 vault에 들어오거나 나갈 때(입금, 출금 또는
vault로 전달된 rewards), 당신이 대출자나 차입자인 대출이 시작될 때, 대출 단계에서 당신의 VPFI가 묶이거나 풀릴
때, 또는 tier 갱신 호출을 할 때입니다. 갱신할 때마다 사본 내용이 바뀌는 경우 다른 체인에 새 사본이 보내집니다.

각 체인은 따로 배송됩니다. 닿지 않는 체인이 다른 체인을 붙잡지 않으며,
**배송을 보낼 수 없어도 당신 자신의 작업은 절대 실패하지 않습니다**.
Base의 tier는 즉시 최신이 되고, 다른 각 체인에는 도착할 때까지 업데이트가
미배송 상태로 남습니다.

이 배송 비용은 프로토콜이 부담하지만, 한도가 하나 있습니다.

- **낮아진 tier**는 예산으로 지불할 수 있는 한 즉시 보내집니다. 도착할
  때까지 그 체인은 이전의 더 높은 tier를 계속 적용합니다.
- **높아진 tier**나 tier 표 변경은 체인당 하루에 한 번까지만 비용이
  지불됩니다(governance 설정으로 1시간~7일). 그때까지 그 체인은 이전
  tier를 유지합니다.
- 이 대기로 보류된 업데이트나 예산으로 지불하지 못한 업데이트는
  **대기가 끝나도 저절로 다시 보내지지 않습니다**. Base에서 티어 기록이
  다음으로 업데이트될 때, 또는 누군가 대신 배송 호출을 할 때 전송됩니다.
- 이 호출은 누구나 할 수 있습니다. 대기가 끝나고 예산으로 지불할 수
  있으면 프로토콜이 지불하고, 그 전에는 호출자가 크로스체인 수수료를
  내고 더 빨리 보낼 수 있습니다. 컨트랙트는 이 호출을 지원하지만 앱은
  아직 제공하지 않습니다.

다음의 경우 사본은 인정되지 않으며, 그 체인에서는 할인이 없습니다.

- 체인의 최대 경과 기간(기본 60일, 30일 미만 불가)보다 오래된 경우.
- 그 체인이 현재 알고 있는 tier 표보다 오래된 표로 만들어진 경우.

사본은 그 안의 내용이 바뀔 때만 다시 보내집니다. 즉 tier, 그 할인, 유효 기간, tier 표의 버전 중 하나입니다.
따라서 tier 표가 바뀐 뒤에는 tier가 같더라도(0이 아니라면) Base에서 tier 기록의 다음 갱신이 모든 체인에 새
사본을 보냅니다. 이 중 아무것도 바뀌지 않았다면, 사본이 만료된 체인은 무언가 바뀔 때까지 할인을 적용하지 않습니다.

시간만 지나 tier가 올랐다면(보유 기간을 채웠거나 평균이 따라잡은 경우), tier 기록의 다음 갱신 전까지 Base에서는
아무것도 감지되지 않습니다. tier 갱신 호출로 원할 때 언제든 그 갱신을 할 수 있으며, 앱이 대신 호출하는 것은 할인을 끌
때뿐입니다.

<a id="vpfi-discounts.operators"></a>

### 운영자용

할인의 크로스체인 부분에는 다음 설정이 필요합니다. 자체 배포를 운영하는
사람을 위해 여기에 적어 둡니다.

**Base에서:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`. 이것이 없으면 Base는
  tier를 계산하지만 어디에도 보내지 않습니다.
- `VaipakamRewardMessenger`를 가리키는
  `RewardReporterFacet.setRewardMessenger`, 그리고 다른 모든 체인을 나열한
  messenger의 `setBroadcastDestinations`.
- 자금이 있는 broadcast 예산:
  `ProtocolBroadcastFacet.topUpBroadcastBudget()`(payable). 예산이 비어
  있어도 아무것도 막지 않습니다. 지불할 수 없는 배송은 미배송으로 남고
  이유와 함께 `TierPushDeferred`를 내보내며,
  `getTierPushStatus(user)`는 사용자별로 각 체인의 상태를 보여 줍니다.
  예산이 부족하면 다른 체인이 오래된 tier를 더 오래 적용하므로, 연기를
  지켜보고 충전하세요.
- 유료 인상의 간격 창: `setTierPushSpacingSec`(기본 1일, 1시간~7일).

**다른 각 체인에서:**

- `RewardReporterFacet.setRewardMessenger(addr)`: 그 체인이 tier
  업데이트를 받아들이는 유일한 발신자.
- `RewardReporterFacet.setBaseChainId(chainId)`: Base의 EVM 체인 ID
  (mainnet 8453, Base Sepolia 84532). CCIP chain selector가 아닙니다.
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: 사본이 인정되는 기간
  (기본 60일, 30일 미만 값은 거부됨). 낮추면 다음 읽기부터 적용됩니다.

**tier 표 변경:**

- Base의 `setVpfiTierThresholds`와 `setVpfiTierDiscountBps`는 표의
  버전을 올립니다. 다른 체인은 어느 사용자의 것이든 새 버전을 담은 첫
  tier 업데이트로 이를 알게 됩니다. 그때부터 예전 표로 만든 사본은 그
  사용자 자신의 업데이트가 도착할 때까지 할인 없음으로 처리되며, 이
  업데이트는 인상이므로 간격 창마다 한 번까지만 지불됩니다. 표를 바꾸기
  전에 예산을 충전하세요.
- `setTwaMinStakedDays`는 버전을 올리지 않고 최소 보유 기간을 바꿉니다.
  다음 읽기부터 적용됩니다.

<a id="chapter.next-app"></a>

## 다음 앱

Vaipakam 앱의 다음 버전은 현재 앱과 나란히 한 페이지씩 만들어지고
있습니다. 아직 만들어지지 않은 페이지는 그렇다고 알리고, 그것을
계속 제공하는 현재 앱으로 연결합니다. 만들어진 페이지의 모든
숫자는 체인에서 읽으며 출처를 밝힙니다. 읽을 수 없는 숫자는 0이
아니라 알 수 없음으로 표시됩니다.

<a id="advanced-mode"></a>

### Basic과 Advanced

Basic은 대부분의 사람에게 필요한 기능을 보여 줍니다. Advanced는
exit 및 정산 도구, 자동화, 서명된 주문, keeper 상태, 회계 세부
정보를 더합니다. 모드는 브라우저에 저장되는 표시 선택입니다.
보여 주는 양을 바꿀 뿐 프로토콜이 허용하는 것을 바꾸지 않으며,
동의, 차단 요인, 해결 방법을 숨기지 않습니다.

<a id="wallet"></a>

### 당신의 wallet과 숫자의 출처

당신 자신의 상태(loan, 오퍼, vault, claim)는 체인에서 읽습니다.
먼저 wallet의 프로바이더, 다음으로 읽기 전용 RPC 프록시, 마지막으로
네트워크의 공개 엔드포인트입니다. 동기화 줄은 응답한 출처와 페이지
에서 가장 오래된 읽기의 경과 시간을 알려 주며, 새로고침은 모두를
다시 읽습니다. 인덱스는 전체 숫자(마켓과 기록)에만 쓰이며, 그
블록 높이와 경과 시간을 함께 보여 줍니다. 지원하지 않는 네트워크에
있는 wallet은 전환할 때까지 자신의 것을 아무것도 보지 못합니다.

<a id="deployments"></a>

### 배포가 지원하는 기능

앱은 체인마다 하나의 Diamond에 연결하고, 작업을 제시하기 전에
loupe를 통해 라우팅된 셀렉터를 읽습니다. facet 갱신 후에는 이
집합이 바뀝니다. 가정하지 않고 읽기 때문에 앱은
`FunctionDoesNotExist`로 실패하는 대신 빠진 기능을 지목할 수
있습니다. 집합을 읽을 수 없는 동안에는 서명 단계가 제시되지
않습니다.

<a id="home-start"></a>

### Home: 할 일 고르기

Home은 프로토콜 용어가 아니라 할 일로 시작합니다. 빌리기,
빌려주기, NFT 대여하기, NFT 대여해 주기, 가진 것 관리하기입니다.
빌리기와 빌려주기는 맞는 오퍼부터 열고, 없으면 직접 오퍼를 올리는
쪽으로 이어집니다. 대여는 NFT 대여의 양쪽을 다루며, NFT는 내내
vault에 있습니다. 연결된 wallet에는 숨길 수 있는 시작 카드 세
장도 보이며, 숨김 선택은 브라우저에 저장됩니다.

<a id="home-status"></a>

### Home: 프로토콜 상태

Home은 페이지가 설명하는 체인의 전역 중지, 자동 중지 기간, keeper
중지를 읽고 어떤 경우든 결과를 밝힙니다. 전역 중지는 새 포지션,
claim, 출금, 청산, 디폴트, keeper가 수행하는 정산을 멈춥니다. 전액
및 부분 상환과 담보 추가는 계속 가능하며, 중지된 시간은 열린 모든
loan의 기한에 더해집니다. 자동 중지 기간은 끝나는 시각을
보여 줍니다. 관리자 중지가 있다면 그보다 오래 지속되며, 새 자동
중지 기간은 쿨다운 이후에만 열립니다. keeper 중지는 서비스가 당신을
대신해 실행하는 단계만 멈춥니다. 읽을 수 없는 상태는, 이전 응답
이후 실패한 재읽기를 포함해, 위쪽에 알 수 없음으로 표시됩니다.
개별 자산도 중지될 수 있으며, 해당 흐름이 그것을 알려 줍니다.

<a id="home-payouts"></a>

### Home: 수령 준비 완료

Home은 대출자 쪽과 차입자 쪽의 claim 가능 뷰를 페이지 단위로
훑으며, 각 지급을 loan과 입장으로 표시합니다. 금액은 보여 주지
않습니다. 지급은 여러 자산과 여러 경로로 이뤄질 수 있고, 각 금액은
수령 전에 Claims에서 밝힙니다. 훑기가 끝까지 가지 못하면, Home은
표시된 것보다 더 있을 수 있다고 알립니다.

<a id="home-loans"></a>

### Home: 내 loan

Active 또는 FallbackPending 상태의 각 loan은 입장, 조건, 담보,
단계와 함께 긴급한 순서로 표시됩니다. 유예 종료, 유예 중,
폴백, 기한을 읽을 수 없음, 3일 안에 만기, 진행 중 순입니다. 만기와
유예 종료는 프로토콜의 loan 시계에서 가져오며 중지된 시간이 이미
포함되어 있고, 0이 아니면 표시됩니다. health factor는 대시보드
뷰의 1e18 스케일 값입니다. 0은 값 없음(가격이 없는 자산 또는 읽기
실패)을 뜻하며 그렇게 표시됩니다. 같은 오퍼에서 같은 입장, 같은
ERC-20으로 열린 loan이 두 개 이상이면 묶어서 보여 줍니다. 원금은
합산, 이자율은 원금으로 가중해 내림, 가격이 있는 loan 중 가장 낮은
health factor를 보여 주고, 가격이 없는 것은 개수를 셉니다.

이자를 주기적으로 내는 loan에는 만기일 당일까지 납부 시점도 있습니다. 납부 시점의 유예 기간이 끝났는데도 남은 이자는 담보를 팔아 낼 수 있으며, loan은 계속 열려 있습니다. Home은 다음 납부 시점을 보여 주고, 밀린 것을 맨 앞에 둡니다. 만기일과 같은 날의 납부 시점도 마찬가지인데, 그 유예 기간이 loan의 유예 기간보다 먼저 끝날 수 있기 때문입니다. 프로토콜은 이 정산을 끌 수 있으며, 그러면 Home은 납부 시점에 담보가 팔리지 않는다고 알려 줍니다.

<a id="home-exposure"></a>

### Home: 빌려준 것과 빌린 것

각 loan의 원금은 프로토콜의 단일 가치 평가 규칙으로 현재 가격의
뉴머레르 단위로 평가됩니다. 부채는 올림, 당신이 빌려준 loan은
내림입니다. 가치를 매길 수 없는 loan(NFT 또는 가격이 없는 자산)은
추정하지 않고 개수로 셉니다. 평가되지 않은 loan이 답을 바꿀 수
없을 때만 더 큰 쪽을 알려 주고, 그렇지 않으면 평가된 합계와
개수를 보여 줍니다.

<a id="home-faucet"></a>

### Home: 테스트 자산

배포 기록이 테스트 자산을 공개하는 테스트넷에서 Home은 이를 나열합니다. 테스트 가격 피드와 풀에 연결된 테스트 ERC-20(유동성 있음), 일부러 둘 다 없이 둔 것(유동성 없음: 이것으로 된 대출은 가격이 없고 채무 불이행은 현물로 정산됨), 그리고 ERC-4907 대여 NFT입니다. 발행은 Diamond가 아니라 모의 토큰 컨트랙트를 호출합니다. 토큰은 1,000개, NFT는 새 무작위 토큰 ID로 하나를 발행하며, 지갑을 열기 전에 그 ID가 발행되지 않았는지 확인합니다. 결과는 잔액이나 `ownerOf`를 다시 읽어 측정하고, 토큰 발행 뒤에는 `wallet_watchAsset`을 제안합니다. 테스트 NFT는 소유자나 승인된 운영자만 소각할 수 있습니다.

<a id="home-fee-discount"></a>

### Home: 수수료 할인

`setVPFIDiscountConsent`는 이 체인의 Diamond에 지갑별 플래그 하나를 설정합니다. 꺼져 있으면 보유 등급 할인은 0입니다. 켜져 있으면 차입자의 대출 개시 수수료가 수락 시 대출 자산으로 줄어들고(VPFI 가격 경로는 차입자 쪽에 절대 관여하지 않음), 대출자의 수익 수수료는 정산할 때마다 그 시점의 실효 등급으로 할인됩니다. 지급 방식은 `getVPFIDiscountConfig`를 따릅니다. VPFI 환율과 기준 자산이 모두 설정되어 있으면 할인된 수수료가 대출자의 볼트에서 VPFI로 차감되고 대출자는 이자를 모두 받습니다. 그렇지 않으면 재무 수수료 자체가 줄고 VPFI는 움직이지 않습니다. 정산 시 이 차감이 실행될 수 없으면(유효한 시세가 없거나, 볼트에 추적되는 자유 VPFI가 부족하거나, 그 VPFI가 담보로 잠겨 있는 경우) 그 정산의 수수료에는 보유 등급 할인이 적용되지 않습니다. 호출은 `whenNotPaused`이므로 전역 일시 중지는 양방향 모두를 막습니다. 켜기에는 약관이 필요하고 끄기에는 필요 없으며, 둘 다 미러에 등급을 전송하지 않습니다. 차입자 할인은 수락 시 대출 자산이 유동적일 때만 적용되며(비유동 대출은 LIF 전액을 냄), 모든 할인은 수수료의 50%로 제한됩니다.

<a id="home-rewards"></a>

### Home: 리워드

헤드라인 수치는 `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`로, Vault 수령처로 클레임을 실행하고 항상 revert합니다. `InteractionRewardsSimulation(paid, fromDay, toDay)`가 정확한 수치를 담고, 그 밖의 revert는 클레임 자체의 거절 (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`)이며 이름으로 표시됩니다. 어떤 소스도 미리보기를 실행할 수 없을 때에만 Home은 하한인 `previewInteractionRewards`를 읽고 클레임을 보류합니다. 정확한 수치가 0이어도 클레임은 제공됩니다. 프로토콜은 아무것도 지급하지 않는 클레임을 아무것도 지급하지 않은 보상일을 넘어설 때에만 허용하며, Home은 그렇다고 알려 줍니다. Home은 `claimInteractionRewardsTo(2)`로 클레임하며, 호출당 최대 `MAX_INTERACTION_CLAIM_DAYS`(30)일을 지급합니다. 완료된 클레임의 블록 또는 그 이후에 읽은 미리보기가 여전히 금액을 답하면 Home은 나머지를 제공합니다. 보상 항목만으로 지급하는 클레임은 날짜 범위를 밝히지 않으며(0에서 0), Home은 날짜 대신 그렇다고 알려 줍니다. Vault 수령처는 컨트랙트 지갑을 포함한 모든 계정에 전달됩니다. Default 수령처는 컨트랙트 호출자에게는 지갑으로 지급하기 때문입니다. 볼트에 입금되며, 입금을 완료할 수 없을 때(아직 볼트 없음)는 지갑으로 돌아갑니다. 결과는 영수증에서 읽습니다. `InteractionRewardsClaimed`가 지급액을 알려 주고, 같은 트랜잭션에서 지갑과 `getUserVaultAddress(user)`로 간 VPFI `Transfer` 로그가 도착한 곳을 알려 줍니다. 그 합이 지급액과 맞지 않으면 수령처는 알 수 없음으로 표시됩니다. 누적 클레임 금액은 표시되지 않습니다. 이를 위한 사용자별 인덱스 경로가 아직 없기 때문입니다.

<a id="home-rewards-expiry"></a>

### Home: 리워드 제거 날짜

`ConfigFacet.getRewardClaimHorizonDays()`가 0이면 호라이즌이 꺼져 있어 날짜를 표시하지 않습니다. 그렇지 않으면 Home은 `getUserSoonestRewardExpiry(user, offset, 200, 50)`을 페이지별로, 모두 같은 블록에서, 최대 10페이지까지 읽습니다. `nextOffset >= total`이면 탐색이 완료되며, 도중에 멈춘 탐색은 "기한 없음"이 아니라 불완전하다고 표시합니다. 최종 알림은 가장 이른 예상치의 90일 전부터 표시됩니다. 예상치는 해당 블록에서 엔트리의 `expiresAt`이며, 청구를 실행할 수 없는 시간은 실제 제거를 늦추고, 호라이즌의 거버넌스 변경은 앞당길 수 있습니다. 엔트리가 제거할 금액은 Home에 표시하지 않습니다.

<a id="home-rewards-held"></a>

### Home: 보류된 리워드

`getSanctionsHeldReward(user)`는 보류 잔액이고 `getRewardSanctionsStatus(user)`는 그 판정(Deliver, Hold, Confirmed)입니다. 잔액이 있고 판정이 Deliver이면 Home은 `claimHeldInteractionRewards(2)`을 제시합니다. 이 호출은 새로 발생한 미지급분을 정산하지 않고 보류 잔액만 정확히 지급하며 `InteractionRewardsClaimed(user, 0, 0, paid)`를 발생시킵니다. 지갑이 금지된 동안에는 `SanctionedAddress`로 revert합니다. 서명 전 재확인은 둘 다 다시 읽고 발신자로서 호출을 시뮬레이션합니다. 플래그가 확정된 동안 얻은 날은 영구히 몰수됩니다.

<a id="borrow-start"></a>

### Borrow: 작동 방식

Borrow는 ERC-20 담보에 대한 ERC-20 대출자 오퍼(`offerType` 0)를 `acceptOffer(offerId, terms, signature)`로 직접 수락합니다. 한 번의 트랜잭션으로 차입자의 볼트가 없으면 열고, 담보를 그 안으로 옮기고, 개시 수수료를 뺀 원금을 지갑으로 보내며, `LoanInitiated`를 발생시킵니다. 차입자는 요청(`offerType` 1)을 올릴 수도 있습니다. NFT 측, 페어 동의, 고급 옵션은 이후 업데이트에서 제공됩니다.

<a id="borrow-pair"></a>

### Borrow: 토큰 고르기

각 토큰의 분류는 실시간으로 읽습니다. 먼저 `getAssetPriceStatus(asset)`(Divergent는 불신으로 읽고 새 대출을 막음), 다음으로 `checkLiquidityOnActiveNetwork(asset)`(0 유동, 1 비유동). `OraclePriceDivergence` 또는 `OracleCrossCheckDivergence` revert는 불신으로 읽고, 그 밖의 실패는 이유와 함께 읽을 수 없음으로 표시합니다. 추천 목록은 배포 기록의 래핑된 네이티브 토큰과 테스트 토큰이며, 붙여 넣은 주소는 형식만 확인합니다.

<a id="borrow-offers"></a>

### Borrow: 오퍼 고르기

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)`가 페어의 열린 오퍼 ID와 총수를 줍니다. 각 ID에 대해 페이지는 `getOffer`, `getOfferState`, 지갑이 있으면 `previewAccept(offerId, wallet)`를 읽으며, 그 `errorCode`가 프로토콜의 거절입니다. LTV는 오늘 가격 기준 `calculateLTV`이며, 비유동이거나 가격이 없는 측은 없는 이유를 밝힙니다. 직접 수락은 대출자의 `amountMax`를 `interestRateBps`로 묶습니다. 차입 요청, NFT 측이 있는 오퍼, 본인 오퍼는 세기만 하고 목록에 넣지 않습니다.

<a id="borrow-review"></a>

### Borrow: 검토와 서명

검토는 오퍼, 그 상태, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, 두 분류, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, 지갑의 볼트·잔액·승인액, `previewOfferAcceptBlock`, 할인 동의를 읽고, 지갑이 열리기 직전에 다시 읽습니다. 지갑은 저장된 오퍼로 만든 EIP-712 `AcceptTerms`(도메인 `Vaipakam AcceptOffer`, 버전 1)에 새 128비트 nonce와 30분 기한으로 서명합니다. 비유동 확인은 검토가 비유동으로 보여 준 측만 지정합니다. 승인액이 부족할 때만 담보 금액만큼 정확히 승인하고, 서명과 함께 `acceptOffer`를 모의 실행한 뒤 보냅니다. 승인 뒤에 멈추면 다른 변경이 없는 한 앱은 승인액을 이전 값으로 되돌립니다. 결과는 이 오퍼와 지갑의 `LoanInitiated`와 영수증의 `Transfer` 로그에서 읽습니다. 허용량은 첫 지갑 요청 직전에 다시 읽으며, 재설정은 그 값으로 되돌립니다. 전송된 수락이 revert되거나 지갑이 취소 또는 대체하면 거래 추적기가 같은 재설정을 합니다. 검토 화면은 `allowsPartialRepay`, `allowsPrepayListing`, `parallelSaleOrderHash`와 함께 `allowsParallelSale`, `refinanceTargetLoanId`, 연결된 대출을 표시하고, 갚을 금액을 일시 중지가 없는 경우로 표시합니다. 일시 중지 동안에도 이자는 붙고 만기일만 늦춰지기 때문입니다. 각 승인 단계는 영수증이 포함된 블록에서 다시 읽은 허용량으로 판단하며, 영수증 상태로는 판단하지 않습니다. 0이 아닌 허용량을 다른 0이 아닌 값으로 바꾸는 것을 거부하는 토큰(`approve` 시험 실행으로 확인)에는 먼저 0으로 가는 단계가 들어가며, 검토 화면은 이를 추가 프롬프트로 셉니다. 약관 동의는 지갑이 열리기 직전에 다시 읽습니다. 두 판매 경로 모두 담보를 NFT로 등록하므로, 토큰 담보에서는 부여된 등록·판매 허가가 이 대출이 쓸 수 없는 것으로 표시됩니다.

<a id="borrow-fee"></a>

### Borrow: 개시 수수료

수수료는 `previewAccept`의 `lifEstimate`입니다. 원금에 대한 `getLoanInitiationFeeBps`를 빌리는 토큰으로 받아 전달액에서 차감하며, 동의가 켜져 있고 빌리는 토큰이 유동이면 보유 티어 할인으로 낮아지고, 티어는 수락 시점에 고정됩니다. 이 페이지는 Full 요금제를 선택하지 않습니다. 수수료를 위해 VPFI를 징수하거나 환불하지 않습니다. 제출자 몫(수수료의 `getLifMatcherFeeBps`)은 보낸 사람에게 지급되며, 직접 수락에서는 차입자이므로 지갑은 수수료를 뺀 원금에 그 몫을 더해 받습니다.

<a id="borrow-risks"></a>

### Borrow: 위험

유예 기간이 끝난 대출(만기일 뒤 `getEffectiveGraceSeconds`, 일시 정지 시간만큼 늦춰짐)은 누구나 연체 처리할 수 있습니다. 유동 담보는 대출자를 위해 매각되고 비유동 담보는 그대로 이전됩니다. 유동 담보는 헬스 팩터가 1 아래로 내려가면 청산될 수도 있습니다. `useFullTermInterest`는 조기 상환 시 전체 기간 이자를 부과하고, 이자 일정은 놓친 기간을 담보 강제 매각으로 정산합니다.

<a id="borrow-request"></a>

### Borrow: 직접 요청 올리기

요청은 차입자의 지갑에서 보내는 `offerType` 1, 양쪽 ERC-20의 `createOffer`입니다. `collateralAmount`를 차입자의 볼트로 옮기고(볼트가 없으면 만들고) `OfferCreated(offerId, creator, 1)`를 발생시킵니다. 대출자는 `acceptOffer`로 받습니다. 수수료를 뺀 원금은 차입자의 지갑으로, 수수료 중 송신자 몫은 보낸 대출자에게 갑니다. `cancelOffer`는 생성자에게는 생성 후 `MIN_OFFER_CANCEL_DELAY`(5분)부터, 누구에게나 요청이 만료된 뒤 열려 있으며, 담보는 항상 생성자에게 돌아갑니다.

<a id="borrow-request-terms"></a>

### Borrow: 요청의 조건

Basic은 단일 값 요청을 올립니다: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 0, `periodicInterestCadence` 0, `allowsPrepayListing`과 `allowsParallelSale`은 false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true. 금액은 기본 단위로 정확히 변환되고 이자율은 최대 10,000 bps입니다. `durationDays`는 `getProtocolConfigBundle`에서 읽은 설정 최대값으로 제한됩니다. `expiresAt`은 0(취소할 때까지 유효)이거나, 검토를 열 때 최신 블록에서 정한 시각으로 최대 `MAX_OFFER_EXPIRY_HORIZON`(365일) 뒤까지입니다. `useFullTermInterest` 기본값은 true, `allowsPartialRepay`는 false입니다.

<a id="borrow-request-review"></a>

### Borrow: 요청 검토와 게시

검토 화면은 지갑에서 `createOffer`를 시뮬레이션하고 양쪽 분류, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, 최장 기간, 지갑의 볼트·잔액·승인액, 양쪽이 유동적이면 `calculateLTV`를 읽으며, 매 블록과 지갑이 열리기 직전에 다시 읽습니다. 승인액이 부족한 동안 시뮬레이션은 담보 인출까지만 갈 수 있으므로, 토큰의 인출 오류나 프로토콜 오류 이름이 없는 revert는 해결할 승인으로 표시하고, 이름이 있는 프로토콜 오류는 거절로 봅니다. 정확한 금액을 승인한 뒤 `createOffer`를 다시 시뮬레이션하고 보냅니다. 승인 뒤 멈추면, 다른 변경이 없을 때 승인액을 이전 값으로 되돌립니다. 결과는 이 지갑의 `OfferCreated`와 볼트로의 담보 `Transfer`에서 읽습니다.

<a id="borrow-nft-collateral"></a>

### Borrow: NFT를 담보로

담보의 표준은 `supportsInterface`로 읽습니다(ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`). revert는 어느 쪽도 아닌 것으로 보며, 읽기에 실패하면 요청을 제시하지 않습니다. ERC-721 요청은 `collateralAssetType` 1, `collateralTokenId`에 입력한 ID, `collateralQuantity` 1, `collateralAmount` = `collateralAmountMax` = 0을 보냅니다. 위험 페어는 그 토큰 ID를 키로 합니다. 검토는 한 블록에서 `ownerOf`, `getApproved`, `isApprovedForAll(wallet, Diamond)`를 읽으며, 다른 지갑이 보유한 토큰이나 revert하는 `ownerOf`는 요청을 막습니다. 어느 승인도 없으면 드라이 런은 토큰의 `ERC721InsufficientApproval`에서 멈추고, 이는 필요한 승인으로 표시됩니다. 승인은 `approve(Diamond, id)`이며, 영수증 블록에서 `getApproved`가 Diamond를 읽을 때만 완료로 봅니다. 그 뒤에 멈추면 승인이 여전히 Diamond를 가리키고 지갑이 여전히 토큰을 보유하는 동안에만 이전 주소로 되돌립니다. ERC-721에서는 `setApprovalForAll`을 결코 요청하지 않습니다. 결과는 `OfferCreated`와 지갑에서 금고로 가는 토큰 자체의 `Transfer`(topic 4개)를 읽습니다. ERC-1155 요청은 `collateralAssetType` 2, 토큰 ID, 입력한 수량의 `collateralQuantity`(1부터 2^128−1까지), 두 금액 모두 0을 보냅니다. 검토는 한 블록에서 `balanceOf(wallet, id)`와 `isApprovedForAll(wallet, Diamond)`를 읽으며, 잔고가 수량보다 적으면 요청을 막고, 승인이 없으면 드라이 런은 `ERC1155MissingApprovalForAll`에서 멈춥니다. 유일한 승인은 `setApprovalForAll(Diamond, true)`이며, 영수증 블록에서 다시 읽힐 때 완료로 보고, 요청이 채굴되거나 멈춘 뒤 `setApprovalForAll(Diamond, false)`로 거둡니다(부여 블록보다 이전은 결코 읽지 않음). 단, 지갑이 이전부터 승인해 둔 경우는 예외입니다. 결과는 지갑에서 금고로 가는 토큰의 `TransferSingle`/`TransferBatch`를 합산합니다. NFT를 요구하는 대출자 오퍼는 여전히 현재 앱으로 갑니다.

<a id="borrow-request-range"></a>

### Borrow: 범위가 있는 요청

범위는 `amount`(최소)를 `amountMax`(최대)보다 작게, `interestRateBps` = `interestRateBpsMax`(하나의 이자율)로, `collateralAmount`(가장 작은 대출의 하한)를 `collateralAmountMax`(게시할 때 금고로 옮겨짐) 이하로 보냅니다. 하한이 비어 있으면 둘을 같게 보냅니다. 범위는 ERC-20 담보에서만 제공됩니다. 직접 `acceptOffer`는 `collateralAmount`를 담보로 `amount`를 `interestRateBpsMax`로 빌려주고 `collateralAmountMax − collateralAmount`를 지갑으로 돌려줍니다. `getPartialFillEnabled`가 true인 동안 `matchOffers`는 양 끝 사이에서 체결합니다. `createOffer` 모의 실행은 가장 큰 끝에서 오퍼 한도를 적용하고 `MaxLendingAboveCeiling(provided, ceiling)`으로 거부하며, 검토 화면이 그 상한을 보여 줍니다. 직접 수락 끝은 (`amount`, `collateralAmount`)에서 단일 값 요청의 두 번째 모의 실행으로 확인하고, 한도 이전에 멈춘 응답은 알 수 없음으로 표시합니다. 각 끝의 LTV는 `calculateLTV(lending, amount, collateral, collateralAmount)`이며, `ZeroCollateral`은 가치 없는 담보로 읽습니다. 표시되는 대출 시작 건전성 지수는 `getDepthTieredLtvEnabled`가 false인 동안 `getMinHealthFactor`, true인 동안 1.0입니다. 매칭은 대출자의 비례 요구량을 잠그며, 담보가 범위이면 `collateralAmount` 까지 올리고 그렇지 않으면 요구량 그대로입니다. 그래서 가장 큰 매칭은 `collateralAmountMax` 와 `collateralAmount` 두 경우 모두로 표시됩니다(담보 범위가 없으면 더 적게 잠글 수 있다고 표시). 이를 제한하는 것은 대출 시작 시점의 검사뿐이며, 그 검사를 읽지 못하면 그 사실을 표시하고 빼지 않습니다. 계층형 체계에서는 검사가 등급의 LTV 상한도 적용합니다. `getPartialFillEnabled`가 true인 동안 매칭이 잠그지 않은 담보는 이후 매칭을 위해 금고에 남으며, 요청이 닫힐 때(남은 용량이 `amount` 아래로 떨어질 때)나 `cancelOffer`가 실행될 때에만 환불됩니다.

<a id="borrow-request-fill"></a>

### Borrow: 요청의 체결 방식

`fillMode`는 0(Partial), 1(AON), 2(IOC) 중 하나이며 게시 후 바꿀 수 없습니다. AON은 `amount` = `amountMax`를 요구하고(`AonRequiresSingleValueAmount`), IOC는 `expiresAt` ≠ 0을 요구합니다(`IocRequiresExpiry`). 양식은 거부되는 조합을 제공하지 않습니다. 금액, 이자율, 담보는 열린 요청에서 `setOfferAmount`, `setOfferRate`, `setOfferCollateral`, `modifyOffer`로 바꿀 수 있지만 `amountFilled`나 `collateralAmountFilled` 아래로는 바꿀 수 없습니다. 이 앱은 아직 이를 호출하지 않습니다.

<a id="borrow-request-cadence"></a>

### Borrow: 요청의 이자 일정

`periodicInterestCadence` 는 0(None)부터 4(Annual)까지이며, 기간은 30·90·180·365일입니다. 양식은 `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` 가 허용하는 것을 제시합니다. 이 함수는 `createOffer` 가 적용하는 규칙을 `amount`(범위의 최소값)로 평가해 실행합니다. 각 거부는 리버트 데이터에서 표시됩니다: `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid`, 또는 `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`. 한 기간의 이자는 `principal × rate × intervalDays / (10000 × 365)` 입니다. 미납 기간은 유예 `getEffectiveGraceSeconds(intervalDays − 1)` 가 지나면 누구나 `settlePeriodicInterest` 로 정산할 수 있으며, 담보를 팔고 대출은 유지됩니다. 키퍼 패스 `periodicSettle` 의 활성 상태는 기능 서비스가 보고하는 대로 표시되며 기본값은 알 수 없음입니다. 일정은 게시 후 바꿀 수 없습니다.

<a id="borrow-request-tariff"></a>

### Borrow: 요청의 풀 수수료 요율

옵트인은 `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`로, 작성자가 `createOffer` 뒤에 보내며, 대출자가 요청을 받은 뒤에는 `OfferAlreadyAccepted`로 거절됩니다. `maxCStar`는 0보다 커야 합니다(`FullTariffMaxCStarRequired`). 양식은 스위치를 `getFeeEntitlementConfig()`에서, 요율을 `quoteCStar(lendingAsset, principal, durationDays)`에서 보여 주며, 범위라면 `amount`와 `amountMax`에서 읽습니다. 최대치의 기본값은 `amountMax`에서의 견적입니다. 각 수락에서 부과는 그 대출의 원금으로 산정한 `C*`를 가져가지만, 스위치가 켜져 있고, 원금에 가격과 유동성이 있으며, `C* ≤ maxCStar`이고, 금고의 자유 VPFI(`getTrackedVPFIBalance`로 상한을 둔 금고 잔액에서 유효한 담보권을 뺀 값, `getFreeBalance` 경유)로 충당될 때만입니다. 그렇지 않으면 `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`로 되돌려지며, `allowDowngrade`라면 요율 없이 대출이 열립니다. 차입자의 대출 수수료 할인은 `FULL_MODE_FEE_DISCOUNT_BONUS_BPS`(1000)만큼 오르고 `MAX_FEE_DISCOUNT_BPS`(5000)가 상한입니다. 검토 화면은 모든 대출이 거절될 선택을 막고, 옵트인은 `getOffer`를 다시 읽어 측정합니다(`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`). 채워지지 않은 요청에 대한 백스톱 대출은 이 앱에서 아직 제공하지 않습니다.

<a id="lend-start"></a>

### Lend: 작동 방식

Lend는 ERC-20 담보에 대한 ERC-20 차입 요청(`offerType` 1)을 대출자가 보내는 `acceptOffer(offerId, terms, signature)`로 직접 받습니다. 한 번의 트랜잭션으로 원금은 Diamond에 대한 승인 아래 대출자의 지갑에서 대출자의 볼트로 인출되고, 차입자는 개시 수수료를 뺀 금액을 받으며, 차입자의 볼트에 이미 있는 담보가 대출의 담보가 되고, `LoanInitiated`가 발생하며 대출자와 차입자에게 각각 포지션 NFT가 주어집니다. 대출 오퍼(`offerType` 0)는 같은 페이지에서 게시합니다. NFT 측은 이후 업데이트에서 추가됩니다.

<a id="lend-offers"></a>

### Lend: 요청 고르기

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)`가 쌍의 열린 오퍼 id를 줍니다. 각각에 대해 페이지는 `getOffer`, `getOfferState`, `getOfferLinkedLoanId`와, 지갑이 있으면 `previewAccept(offerId, wallet)`를 읽으며, 그 `errorCode`가 프로토콜의 거절 사유입니다. 직접 수락은 요청의 `amount`(최소치)를 `interestRateBpsMax`로 확정하고, 담보인정비율은 그 금액에 대한 오늘 가격 기준 `calculateLTV`입니다. 대출자 오퍼, NFT 측, 읽는 사람 자신의 요청, 대출자 포지션 매각 수단(`getOfferLinkedLoanId`가 0이 아닌 차입자 측 오퍼)은 개수만 세고 목록에 넣지 않습니다. 순서는 자금 제공 가능 먼저, 그다음 이율 내림차순, 그다음 금액 내림차순입니다.

<a id="lend-review"></a>

### Lend: 검토와 서명

검토 화면은 Borrow와 같은 것(오퍼, 그 상태, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, 두 분류, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, 지갑의 볼트, `previewOfferAcceptBlock`, 수수료 할인 동의)에 더해 `getTreasuryFeeBps`를 읽고, 잔액과 승인액은 대출자가 내는 쪽인 대출 자산에서 측정합니다. 그 자산이 부족하면 서명이 막히며, 대출자 포지션 매각 수단도 마찬가지입니다. 지갑은 EIP-712 `AcceptTerms`(도메인 `Vaipakam AcceptOffer`, 버전 1)에 서명하고, 승인액이 모자랄 때만 원금만큼 정확히 승인하며(0이 아닌 값끼리의 변경을 거부하는 토큰은 먼저 0으로 바꾸는 단계를 둡니다), `acceptOffer`를 시뮬레이션한 뒤 보냅니다. 중간에 멈춘 흐름이 남긴 승인은 Borrow와 같이 재설정됩니다. 결과로 이 오퍼의 `LoanInitiated`, 지갑에서 나간 원금의 `Transfer`, 매처 몫이 돌아오는 `Transfer`를 읽습니다.

<a id="lend-fee"></a>

### Lend: 수수료와 프로토콜의 몫

수수료는 `previewAccept`의 `lifEstimate`이며 차입자가 부담합니다. 대출 자산으로 원금의 `getLoanInitiationFeeBps`이고, 차입자에게 전달되는 금액에서 빠지며, 수락 시 차입자의 보유 등급 할인으로, 그리고 `creatorFull`이 설정되고 부과가 성공하면 Full 요율 보너스로 낮아집니다. 제출자의 몫(수수료의 `getLifMatcherFeeBps`)은 보낸 사람, 여기서는 대출자에게 지급됩니다. 이자에 대한 프로토콜의 몫은 `getTreasuryFeeBps`로, 대출이 열릴 때 대출별로 고정됩니다(`treasuryFeeBpsAtInit`). 동의가 켜져 있으면 대출자의 보유 등급 할인이 이자 정산 시 이를 낮춥니다. 검토 화면은 오늘의 요율과, 그 요율에서의 몫을 상한으로 보여 줍니다.

<a id="lend-risks"></a>

### Lend: 위험

유예 종료(만기일로부터 `getEffectiveGraceSeconds` 후이며, 일시 정지 시간만큼 뒤로 밀립니다)가 지난 대출은 누구나 디폴트 처리할 수 있습니다. 유동 담보는 대출자를 위해 매각되고, 비유동 담보는 그대로 이전됩니다. 양쪽이 모두 유동적이면 건전성 지수가 1 아래일 때 대출을 청산할 수 있으며, 매각은 대출자에게 먼저 지급합니다. 비유동인 쪽이 있으면 가격 기반 청산이 없고, 디폴트 시 대출자가 담보 전부를 받습니다. `useFullTermInterest`는 조기 상환 시 이자의 하한을 두며, 없으면 이자는 일할 계산입니다. 정기 이자 일정에서는 놓친 기간을 담보의 강제 매각으로 대출자에게 지급합니다. 대출자의 포지션 NFT가 청구권을 지니며, 이를 이전하면 대출도 이전됩니다.

<a id="lend-offer"></a>

### Lend: 직접 오퍼 올리기

대출 오퍼는 대출자의 지갑에서 보내는 `offerType` 0의 `createOffer`이며, 양쪽 모두 ERC-20입니다. 대출 자산의 `amountMax`를 대출자의 볼트로 인출하고(볼트가 없으면 만들고), `OfferCreated(offerId, creator, 0)`를 발생시킵니다. 차입자는 `acceptOffer`로 받습니다. 차입자의 담보는 차입자의 볼트로 인출되고, 수수료를 뺀 원금이 차입자의 지갑으로 가며, 수수료 중 전송자의 몫은 전송자인 차입자에게 갑니다. `getPartialFillEnabled`가 true인 동안에는 `matchOffers`가 차입자의 요청과 짝지을 수도 있으며, 이때 단일 값 대출 오퍼는 자신의 이자율로 금액 전부를 빌려주고 담보는 적어도 `collateralAmount`입니다. `cancelOffer`는 생성 후 `MIN_OFFER_CANCEL_DELAY`(5분)부터 생성자가, 오퍼가 만료된 뒤에는 누구나 호출할 수 있으며, 금액은 항상 생성자에게 돌아갑니다.

<a id="lend-offer-terms"></a>

### Lend: 오퍼의 조건

부분이 없는 대출 오퍼는 단일 값입니다. `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`(차입자가 잠가야 할 유일한 담보량), `fillMode` 0(Advanced가 다른 방식을 정하지 않은 경우, 다음 절 참고), `periodicInterestCadence` 0(고급에서 일정을 정하지 않는 한), `allowsPrepayListing`과 `allowsParallelSale`은 false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent`는 true이며, 고급에서 선택하지 않는 한 Full 요금제는 설정하지 않습니다. 금액은 기본 단위로 정확히 파싱되고 이자율은 최대 10,000 bps입니다. `durationDays`는 `getProtocolConfigBundle`에서 읽은 설정 최댓값으로 제한됩니다. `expiresAt`은 0(취소할 때까지 열림)이거나 검토 화면이 열릴 때 최신 블록 기준으로 정한 시각이며, 최대 `MAX_OFFER_EXPIRY_HORIZON`(365일) 뒤까지입니다. `useFullTermInterest`의 기본값은 true, `allowsPartialRepay`의 기본값은 false입니다.

<a id="lend-offer-parts"></a>

### Lend: 부분으로 빌려주는 오퍼

부분은 `amount`(한 번의 매칭이 빌려줄 수 있는 가장 작은 부분)를 `amountMax`(전체 금액, `createOffer`가 볼트로 가져감)보다 작게 보냅니다. `collateralAmount` = `collateralAmountMax`는 `amountMax` 기준의 유일한 요구 사항으로 남고(그렇지 않으면 `LenderCollateralRangeNotAllowed`), `interestRateBps` = `interestRateBpsMax`입니다. 대출 오퍼에 대한 직접 `acceptOffer`는 `collateralAmount`에 대해 `amountMax`를 빌려주며, `amountFilled`가 0인 동안에만 가능합니다(매칭 후에는 `OfferPartiallyFilled`). `getPartialFillEnabled`가 true인 동안 `matchOffers`는 금액 겹침 구간의 중간값(최소 `amount`)을 이자율 겹침 구간의 중간값으로, 적어도 `collateralAmount × matchAmount ÷ amountMax`(내림, 차입자의 담보 범위가 높일 수 있음)에 대해 빌려줍니다. `amountMax − amountFilled`가 `amount` 아래로 떨어지면 나머지는 대출자의 지갑으로 인출되고 오퍼는 닫힙니다(`OfferClosed`, 사유 `Dust` 또는 `FullyFilled`). 일부 체결된 오퍼에 대한 `cancelOffer`는 대기 시간을 건너뛰고 `amountMax − amountFilled`를 돌려줍니다. `fillMode`는 요청과 같이 0, 1, 2이며, AON은 `amount` = `amountMax`, IOC는 만료가 필요하고, 게시 후에는 바뀌지 않습니다. 두 레그가 모두 유동적이면 `createOffer`는 `amountMax`에서의 하한보다 낮은 `collateralAmount`를 `MinCollateralBelowFloor(provided, floor)`로 거부하며, 검토 화면이 그 하한을 보여 줍니다. LTV는 (`amountMax`, `collateralAmount`)에서의 `calculateLTV` 하나만 표시되며, 부분도 반올림을 빼면 같은 비율입니다.

<a id="lend-offer-schedule"></a>

### Lend: 오퍼의 이자 지급 일정

대출 오퍼의 `periodicInterestCadence`는 요청의 규칙(위)을 따르며, `previewCadenceAdmission`는 오퍼의 `amount`, 즉 가장 작은 부분(부분이 없으면 전체 금액)으로 평가합니다. `createOffer`는 그 값으로 `requireCadenceAdmitted`를 통해 허용하고, 각 대출의 개시 시점에 자기 원금으로 다시 확인합니다(`requireOriginationCadenceAdmitted`). 검토 화면은 한 기간의 이자를 `amountMax`(직접 인수)로, 부분이 있으면 `amount`로도 보여 줍니다. 놓친 기간은 유예 기간 후 누구나 `settlePeriodicInterest`로 정산할 수 있습니다. 담보를 팔아 그 기간의 이자를 대출자에게 지급하며, 대출은 계속 열려 있습니다.

<a id="lend-offer-tariff"></a>

### Lend: 오퍼의 풀 수수료 요율

대출자의 옵트인도 같은 `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`이며, `createOffer` 후에 보냅니다. 오퍼가 전부 인수되거나 닫히면 `OfferAlreadyAccepted`로 거절됩니다. 일부만 매칭된 오퍼는 아직 받아들이며, 이후 대출에 적용됩니다. 견적은 `amount`와 `amountMax`에서의 `quoteCStar`이고, 최대치의 기본값은 `amountMax`에서의 견적입니다. 각 대출은 원금으로 가격이 매겨져 하나씩 `maxCStar`와 비교되며, 조건은 요청과 같습니다(`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`, 또는 허용된 경우 하향). 대출자 확인에는 금고의 현재 사용 가능한 VPFI를 씁니다. 요율이 부과되면 대출의 `lenderMode`가 Full로 기록되고, 이후 대출자 수익 수수료가 정산될 때마다 프로토콜 몫에 대한 포지션 보유자의 할인에 `FULL_MODE_FEE_DISCOUNT_BONUS_BPS`(1000)가 더해집니다. 상한은 `MAX_FEE_DISCOUNT_BPS`(5000)이며, 보유 할인 동의 여부와 관계없습니다. 제자리 연장(`repriceFeeEntitlementOnExtension`)은 새 기간에 대해 이 기록을 None으로 바꿉니다.

<a id="lend-offer-review"></a>

### Lend: 오퍼 검토와 게시

검토 화면은 지갑에서 `createOffer`를 시뮬레이션하고, 두 자산의 분류, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, 최장 기간, 지갑의 볼트, 대출 자산(대출자가 잠그는 쪽)의 잔액과 승인액, 양쪽이 유동적일 때의 `calculateLTV`를 읽습니다. 매 블록과 지갑이 열리기 직전에 다시 읽습니다. 승인액이 부족한 동안 시뮬레이션은 금액 인출까지만 닿으므로, 토큰의 인출 오류, `VaultDepositFailed`(데이터 없이 되돌려진 인출을 프로토콜이 감싼 것으로, WETH가 승인 부족일 때 그렇습니다), 또는 프로토콜 오류 이름이 없는 되돌림은 해결할 승인으로 표시됩니다. 요청 검토와 같은 규칙이며, 그 밖의 이름 있는 프로토콜 오류는 거부입니다. 정확한 승인 뒤 `createOffer`를 다시 시뮬레이션하고 보냅니다. 승인 뒤에 멈추면, 다른 변경이 없을 때 승인액을 이전 값으로 되돌립니다. 결과로 이 지갑의 `offerType` 0 `OfferCreated`와 금액이 볼트로 들어간 `Transfer`를 읽습니다.

<a id="lend-offer-fee"></a>

### Lend: 오퍼에 붙는 수수료

`createOffer`는 대출자에게 아무것도 부과하지 않습니다. 표시되는 수수료는 차입자의 것으로, 대출 자산 기준 금액의 `getLoanInitiationFeeBps`입니다. `acceptOffer`가 실행될 때 적용되는 요율로 계산되고, 그때 차입자의 보유 등급 할인만큼 낮아지며, 차입자에게 보내는 금액에서 빠집니다. 표시된 금액은 오늘의 요율 기준입니다. 이자 중 프로토콜의 몫은 `getTreasuryFeeBps`이며, 대출이 열릴 때 대출별로 고정됩니다(`treasuryFeeBpsAtInit`). 동의가 켜져 있으면 이자 정산 때 대출자의 보유 등급 할인이 이를 낮춥니다. 검토 화면은 오늘의 요율과 그 요율에서의 몫을 상한으로 보여 줍니다. `getTreasuryFeeBps`를 읽지 못하면 그렇다고 밝히고, 몫이나 돌아올 금액은 표시하지 않습니다.

<a id="positions"></a>

### Positions: 목록을 읽는 방법

Positions는 하나의 공유 리더로 Home과 같은 보유 목록을 읽습니다. `getUserPositionLoansPaginated`가 지갑이 보유한 포지션 NFT를 순회하고, `getLoansBatch`가 이를 불러오며, 각 측은 보유한 토큰(`lenderTokenId` 또는 `borrowerTokenId`)으로 정해지고 대출 생성 시 기록된 당사자로 정하지 않습니다. 상태가 Active 또는 FallbackPending인 대출은 진행 중이며, 기한, 건전성 지수, 그룹화는 Home에서 설명한 대로입니다. 그 밖의 모든 상태는 종료로, 최신 대출 id부터 `LoanStatus` 이름으로 표시합니다: Repaid, Defaulted, Settled, InternalMatched(매칭으로 종료). 앱이 모르는 상태 번호는 번호 그대로 표시합니다. 지급금은 Home에서 설명한 claimables 규칙을 따릅니다: 다른 사람에게서 받은 종료 대출의 보유 포지션은 개수로 세며 추측하지 않습니다.

측 선택은 지급금, 진행 중, 종료 행을 보유한 측으로 거릅니다. "없음"은 포지션 순회와 지급금 순회가 모두 끝나고 최신 읽기가 성공했을 때만 표시합니다. 한도에서 멈춘 순회는 불완전하다고 알립니다. 행은 `/positions/<id>`를 열고, 그곳에서 자격 판정이 각 작업을 결정합니다. 목록은 트랜잭션을 보내지 않습니다.

<a id="position"></a>

### Position: 대출을 읽는 방법

페이지는 `getLoanDetails(loanId)`와 대출자·차입자 포지션 NFT의 `ownerOf`를 읽습니다. 역할은 지갑이 지금 보유한 토큰입니다. 진행 중인 대출(Active 또는 FallbackPending)에 대해서는 `getLoanDeadlines`(원래 만기, 일시 중지 크레딧, 만기, 유예 종료), 상환 주기가 있으면 `getPeriodicInterestEnabled`와 함께 `previewPeriodicSettle`, `isLoanDefaultable`, `calculateHealthFactor`, `calculateLTV`를 읽고, 모든 대출에 대해 `getLoanCollateralLien`과 `isSaleVehicleLoan`을 읽습니다. 각 읽기는 독립적이며, 실패한 읽기는 0이 아니라 알 수 없음으로 표시하고, 날짜를 `startTime`과 `durationDays`로 계산하지 않습니다.

요율은 대출의 스냅샷입니다: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit`(판매용 대출에는 없음), `liquidationLtvBpsAtInit`. 한쪽이 Illiquid(`principalLiquidity` 또는 `collateralLiquidity`)인 대출에는 가격 기반 수치가 없습니다: 프로토콜이 그 대출의 `calculateHealthFactor`와 `calculateLTV`를 거부하며, 페이지는 알 수 없음 대신 그렇게 알립니다. `principal`은 아직 남은 원금이며(부분 상환이 이를 줄임), `interestRateBps`와 `collateralAmount`도 바뀔 수 있으므로 조건은 현재 값으로 표시됩니다. 종료 시 상각된 원금은 그렇게 표시됩니다. `getPeriodicInterestEnabled`가 false이면 페이지는 체크포인트에서 담보가 매각되지 않는다고 알립니다. 진행 중인 대출에서 `collateralLiquidity`가 Illiquid이면 현물 경고가 추가됩니다: 채무 불이행 시 판매 없이 담보가 대출자에게 이전됩니다. 이 페이지는 아직 트랜잭션을 보내지 않습니다.

<a id="risk-access"></a>

### Risk Access: 내 위험 등급

스위치는 `getRiskAccessGateEnabled`입니다. 흐름에 필요한 단계는 프로토콜 자체의 답입니다. 수락에서는 `previewCreatorBlock`이 대출자가 차단되지 않았음을 보인 뒤 `previewOfferAcceptBlock`(1 = 등급 부족, 2 = 쌍 동의, 3 = 엄격 모드 확인, 4 = 예전에는 수락 시 확인이 대신하던 비유동 페어로, 2와 같이 차단하며 페어 동의로 해제됩니다), 요청에서는 `createOffer` 모의 실행의 `RiskTierTooLow`, `IlliquidPairNotConsented`, `MidTierPairNotAcknowledged`입니다. 단계는 한 블록에서 쌍의 `pairRequiredRiskLevel`(오퍼는 `acceptMidTierAckPair`), `getVaultRiskTier`, `getEffectiveRiskTier`, `getCurrentRiskTermsVersion`과 비교한 `getVaultRiskTierVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown`, `getRiskTierMutationNonce`를 읽고, 쌍에 대해서는 `isPairConsentPending`과 `hasIlliquidPairConsent`, 또는 `isMidTierAckPending`과 `midTierStrictBlocked`를 읽습니다. 등급 올리기는 쌍에 필요한 최소 등급으로의 `setVaultRiskTierChecked(level, nonce, termsVersion)`이며, 검토 후 다른 등급 쓰기나 약관 변경이 있었다면 아무것도 바꾸지 않고 거부됩니다. 쌍 단계는 `setIlliquidPairConsent(pair, true)` 또는 `setMidTierPairAck(pair)`입니다. 대기 중인 등급 올리기나 보류 중인 쌍 단계는 다시 제시하지 않습니다. 보류 중인 쌍 단계가 언제 효력이 생기는지 돌려주는 읽기는 없으므로, 검토 화면은 그 시각을 읽을 수 없다고 알립니다. 그 시각은 단계 자체의 완료 카드만 영수증 블록 시각과 대기 기간의 합으로 보여 줍니다. 결과는 영수증 블록에서 다시 읽습니다.

<a id="terms-gate"></a>

### 이용약관 확인

`getCurrentTos`는 작업 대상 체인에서 시행 중인 버전과 내용 해시를 돌려줍니다. 버전 0은 약관이 없다는 뜻이며 아무것도 제한되지 않습니다. `hasAcceptedCurrentTerms`가 false인 지갑은 새로운 노출 전에 확인 요청을 받고, 본문이 절대 바뀌지 않는 버전 고정 페이지 `/terms/v<N>`로 연결됩니다. 동의하면 `acceptTerms(version, hash)`를 한 번 호출합니다. 지갑을 열기 전에 이 쌍을 다시 읽으므로 더 새 버전이 표시된 것을 대체하고, 다른 탭에서 한 동의가 있으면 작업이 그대로 이어집니다. 읽기 실패는 '확인할 수 없음'이며 다시 시도할 수 있고, '미동의'가 되지 않습니다. 빠져나가는 작업은 절대 제한되지 않습니다.
