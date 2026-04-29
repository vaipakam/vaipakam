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

<a id="dashboard.your-escrow"></a>

### 내 Escrow

user별 upgradable contract — 이 chain 위의 내 전용 vault — 입니다.
처음 loan에 참여할 때 나를 위해 생성됩니다. address당, chain당
하나의 escrow입니다. 내 loan positions와 연결된 ERC-20, ERC-721,
ERC-1155 balances를 보관합니다. pooling은 없습니다: 다른 user의 assets는
이 contract에 절대 들어가지 않습니다.

escrow는 collateral, 빌려준 assets, locked VPFI가 보관되는 유일한
장소입니다. protocol은 모든 deposit / withdrawal에서 이 escrow를
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
- Escrow 잔액.
- circulating supply 중 내 share(protocol-held balances 차감 후).
- 남은 mintable cap.

Vaipakam은 LayerZero V2 위에서 VPFI를 cross-chain으로 전송합니다.
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
discounted portion을 escrow에서 debit한 VPFI로 settle할 수 있게 합니다.
기본값: off. off는 모든 fee의 100%를 principal asset으로 지불한다는
뜻이고, on은 time-weighted discount가 적용된다는 뜻입니다.

Tier ladder:

| Tier | Min escrow VPFI | Discount |
| ---- | --------------- | -------- |
| 1    | ≥ 100           | 10%      |
| 2    | ≥ 1,000         | 15%      |
| 3    | ≥ 5,000         | 20%      |
| 4    | > 20,000        | 24%      |

Tier는 VPFI를 deposit하거나 withdraw하는 순간의 **post-change** escrow
balance를 기준으로 calculate되고, 각 loan의 전체 기간에 대해
time-weighted 처리됩니다. Unstake는 내가 관여하는 모든 open loans에
대해 새로운 (낮은) balance로 rate를 즉시 re-stamp합니다 — 이전 (높은)
tier가 계속 적용되는 grace window는 없습니다. 이는 loan 종료 직전에
VPFI를 top up해 full-tier discount를 받고 몇 초 뒤 withdraw하는 exploit
pattern을 막습니다.

discount는 settlement 시 lender yield fee와 borrower의 Loan Initiation
Fee에 적용됩니다(이는 borrower가 claim할 때 VPFI rebate로 지급됩니다).

<a id="dashboard.rewards-summary"></a>

### 내 VPFI Rewards

connected wallet의 VPFI rewards 전체 그림을 두 reward streams에 걸쳐
하나의 view로 보여 주는 summary card입니다. headline figure는 pending
staking rewards, lifetime-claimed staking rewards, pending interaction
rewards, lifetime-claimed interaction rewards의 합계입니다.

stream별 breakdown rows는 pending + claimed를 보여 주고, native page의
full claim card로 이어지는 chevron deep-link를 제공합니다:

- **Staking yield** — escrow balance에 대해 protocol APR로 accrue된
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

### 내 Active Offers

내가 만든 open offers(status Active, expiration 미도달)입니다. acceptance
전에는 언제든 cancel할 수 있습니다 — cancel은 무료입니다. Acceptance는
offer를 Accepted로 바꾸고 loan initiation을 trigger하여 두 position
NFTs(lender용 하나, borrower용 하나)를 mint하고 loan을 Active state로
open합니다.

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

이미 collateral을 escrow에 lock한 borrowers의 active offers입니다.
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
일부로 principal이 내 escrow에서 borrower의 escrow로 move됩니다.

<a id="create-offer.lending-asset:borrower"></a>

#### 내가 borrower인 경우

lender에게서 받고 싶은 principal asset과 amount, interest rate(APR %),
duration(일수)입니다. rate는 offer 시점에 fixed되고, duration은 loan이
default 가능해지기 전 grace window를 설정합니다. 내 collateral은 offer
creation 시 escrow에 lock되고, lender가 accept해 loan이 open될 때까지
(또는 내가 cancel할 때까지) lock된 채 유지됩니다.

<a id="create-offer.nft-details"></a>

### NFT Details

Rental sub-type fields입니다. NFT contract와 token id(ERC-1155는 quantity
포함), principal asset 단위의 daily rental fee를 지정합니다. acceptance
시 protocol은 renter의 escrow에서 prepaid rental을 custody로 debit합니다
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
borrower offer에서는 내 collateral이 offer creation 시 escrow에 lock되고,
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

---

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
  LayerZero packet을 보냅니다. receiver는 Base에서 purchase를 execute하고
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
- Escrow VPFI 잔액에 다음 tier까지의 차이.
- 현재 tier에서의 할인 비율.
- wallet-level consent flag.

escrow VPFI는 staking pool을 통해 자동으로 5% APR도 accrue합니다 —
별도의 "stake" action은 없습니다. VPFI를 escrow에 deposit하는 것 자체가
staking입니다.

<a id="buy-vpfi.buy"></a>

### Step 1 — ETH로 VPFI 구매

purchase를 submit합니다. canonical chain에서는 protocol이 직접 mint합니다.
Mirror chains에서는 buy adapter가 payment를 받고 cross-chain message를
보내며, receiver가 Base에서 purchase를 execute한 뒤 VPFI를 다시 bridge합니다.
Bridge fee와 verifier-network cost는 form에서 live quote로 표시됩니다.
VPFI는 escrow에 자동 deposit되지 않습니다 — Step 2는 설계상 explicit
user action입니다.

<a id="buy-vpfi.deposit"></a>

### Step 2 — VPFI를 escrow에 입금

wallet에서 같은 chain의 내 escrow로 옮기는 별도의 explicit deposit
step입니다. 모든 chain에서 필요합니다 — canonical에서도 — escrow deposit
spec상 항상 explicit user action이기 때문입니다. Permit2가 configured된
chain에서는 앱이 classic approve + deposit pattern보다 single-signature
path를 prefer합니다. 해당 chain에서 Permit2가 configured되어 있지 않다면
cleanly fall back합니다.

<a id="buy-vpfi.unstake"></a>

### Step 3 — escrow에서 VPFI unstake

VPFI를 escrow에서 wallet으로 다시 withdraw합니다. approval leg는 없습니다
— protocol이 escrow owner이며 자기 자신을 debit합니다. withdraw는 새로운
(낮은) balance로 fee-discount rate를 즉시 re-stamp하고, 내가 관여하는
모든 open loans에 적용됩니다. 이전 tier가 계속 apply되는 grace window는
없습니다.

---

## Rewards

<a id="rewards.overview"></a>

### Rewards 소개

두 streams:

- **Staking pool** — escrow에 보관된 VPFI는 5% APR로 지속적으로 accrue하며
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

Buy VPFI 페이지의 "Step 3 — Unstake"와 같은 interface입니다 — escrow에서
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

Lender, borrower, lender escrow, borrower escrow, 그리고 두 position NFTs
(각 side에 하나씩). 각 NFT는 on-chain metadata를 가진 ERC-721입니다. 이를
transfer하면 claim할 권리도 transfer됩니다. Escrow contracts는 address별로
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
  complete refinance가 collateral이 escrow를 떠나지 않은 채 loans를
  atomically swap합니다.
- **Borrower로 claim** — terminal state 전용. full repayment 시 collateral을
  반환하거나, default / liquidation 시 unused VPFI Loan Initiation Fee
  rebate를 반환합니다. Borrower position NFT를 burn합니다.

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
내내 escrow에 머뭅니다 — unsecured window는 없습니다. 새 loan은 다른 loan과
마찬가지로 initiation 시 HF ≥ 1.5 gate를 clear해야 합니다.

옛 loan의 unused Loan Initiation Fee rebate는 swap의 일부로 올바르게
settle됩니다.

<a id="refinance.position-summary"></a>

### 내 현재 포지션

refinance하는 loan의 snapshot입니다 — 현재 principal, 지금까지 accrued된
interest, HF / LTV, collateral basket. 새 offer는 최소한 outstanding
amount(principal + accrued interest)에 맞춰 size해야 합니다. 새 offer의
surplus는 free principal로 escrow에 deliver됩니다.

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
