# Vaipakam에 오신 것을 환영합니다

Vaipakam은 피어투피어 lending 플랫폼입니다. 자산을 lend하고
interest를 얻을 수 있습니다. 자산을 borrow하려면 collateral을
제공합니다. NFTs를 rent하면 owner가 daily fees를 받습니다. 모든
과정은 두 wallet 사이에서 직접 이루어지며, loan이나 rental이 끝날
때까지 smart contracts가 자산을 escrow에 보관합니다.

이 페이지는 **친절한 전체 안내**입니다. 기술적인 깊이가 필요하다면
화면별 도움말이 있는 **User Guide** 탭을 보거나, 전체 whitepaper가
있는 **Technical** 탭을 열어보세요. 우선 "이게 무엇이고 어떻게
쓰는가"만 알고 싶다면 계속 읽으면 됩니다.

---

## 무엇을 할 수 있나요

Vaipakam은 네 가지 유형의 사용자를 위한 플랫폼입니다.

- **Lenders** — USDC, ETH, USDT 등 사용하지 않는 asset을 가지고
  있습니다. 안전성을 유지하면서 그 asset으로 interest를 얻고 싶을
  때 lender offer를 올립니다. borrower가 accept하면, 당신의 조건에
  따라 interest를 얻습니다.
- **Borrowers** — 며칠, 몇 주, 몇 달 동안 cash가 필요하지만
  collateral을 팔고 싶지는 않은 사용자입니다. 가격이 오를 것으로
  기대하거나, 손에서 놓고 싶지 않은 NFT일 수 있습니다. collateral을
  post하고 loan을 받은 뒤 agreed rate로 repay합니다.
- **NFT owners** — 게임이나 앱 안에서 utility를 주는 가치 있는 NFT를
  가지고 있습니다. 팔면 그 utility를 영원히 잃게 됩니다. rent로
  내놓으면 ownership은 유지하면서 다른 사람이 며칠 동안 사용할 수
  있고, 당신은 daily rent를 받습니다.
- **NFT renters** — game asset, membership pass, domain 같은 NFT에
  temporary access가 필요하지만 full price를 내고 싶지는 않은
  사용자입니다. NFT를 rent하고 rental window 동안 사용하며, asset은
  owner가 계속 보유합니다.

가입할 필요가 없습니다. profile을 채울 필요도 없습니다. wallet을
connect하면 lend, borrow, rent를 바로 시작할 수 있습니다.

---

## Loan은 어떻게 작동하나요 (구체적인 예)

Base의 wallet에 **1,000 USDC**가 있다고 가정해봅시다. 이 자산으로
interest를 얻고 싶다면 전체 lifecycle은 다음과 같습니다.

### Step 1 — Offer 만들기

Vaipakam app을 열고 wallet을 connect한 뒤 **Create Offer**를 click
합니다. 당신은 lender이므로 다음 내용을 입력합니다.

- **1,000 USDC**를 lend합니다
- **8% APR**을 원합니다
- Acceptable collateral: **WETH**, **maximum 70% LTV**
- Loan duration: **30 days**

transaction 하나에 sign합니다. 1,000 USDC가 wallet에서
**personal escrow**로 이동합니다. 이 escrow는 당신만 control하는
private vault입니다. borrower가 offer를 accept할 때까지 자산은 그곳에
머뭅니다.

### Step 2 — Borrower가 accept합니다

아마 한 시간쯤 뒤, 다른 사용자가 **Offer Book**에서 당신의 offer를
봅니다. 그 사용자는 WETH를 가지고 있고, 이를 담보로 한 달 동안 USDC를
borrow하고 싶어합니다. **Accept**를 click하고, 예를 들어 $1,500
상당의 WETH를 post합니다. LTV는 약 67%로 당신의 70% cap보다 낮기
때문에 offer가 accept됩니다.

Accept되는 순간:

- 당신의 1,000 USDC가 당신의 escrow에서 상대의 escrow로 이동합니다
- 상대의 WETH는 collateral로 상대 escrow에 lock됩니다
- 양쪽 모두 position NFT를 받습니다 — 당신의 NFT는 "1,000 USDC +
  interest를 받을 권리"를, 상대의 NFT는 "repay하면 WETH를 돌려받을
  권리"를 나타냅니다
- Loan clock이 시작됩니다

Loaned amount에서 작은 **Loan Initiation Fee (0.1%)**가 차감되어
protocol treasury로 routed됩니다. 그래서 borrower는 1,000 USDC가
아니라 999 USDC를 받습니다. (이 fee를 **VPFI**로 pay할 수도 있고,
그 경우 borrower는 1,000 USDC 전액을 받습니다 — VPFI는 아래에서 더
설명합니다.)

### Step 3 — 시간이 지나고 borrower가 repay합니다

30일 뒤 borrower는 principal plus interest를 갚아야 합니다.

```
Interest = 1,000 USDC × 8% × (30 / 365) = ~6.58 USDC
```

borrower가 **Repay**를 click하고 transaction에 sign하면, 1,006.58
USDC가 loan settlement로 이동합니다. 여기서:

- 당신은 **1,005.51 USDC**를 받습니다 (principal + interest에서
  interest 부분에만 적용되는 1% Yield Fee를 뺀 금액)
- Treasury는 **1.07 USDC**를 Yield Fee로 받습니다
- Borrower의 WETH는 unlock됩니다

dashboard에 **Claim** button이 보입니다. click하면 1,005.51 USDC가
settlement에서 당신의 wallet으로 이동합니다. borrower도 claim하면
WETH가 borrower의 wallet으로 돌아갑니다. loan은 close됩니다.

### Step 4 — Borrower가 repay하지 않으면?

문제가 생길 수 있는 경우는 두 가지이며, protocol은 각각을 자동으로
처리합니다.

**Loan 중간에 collateral price가 급락하는 경우.** Vaipakam은 각
loan의 **Health Factor**를 추적합니다. 이는 collateral value와 debt를
비교하는 하나의 숫자입니다. 이 값이 1.0 아래로 내려가면 누구나 —
정말 누구나, 지나가던 bot도 — **Liquidate**를 call할 수 있습니다.
protocol은 collateral을 최대 네 개의 DEX aggregators(0x, 1inch,
Uniswap, Balancer)로 route하고, best fill을 선택해 당신에게 owed
amount를 pay하며, liquidator에게 작은 bonus를 주고, 남은 금액이
있으면 borrower에게 돌려줍니다.

**Borrower가 due date 이후 사라지는 경우.** configurable한 **grace
period**가 지난 뒤(short loans는 1시간, year-long loans는 2주),
누구나 **Default**를 call할 수 있습니다. 같은 liquidation path가
실행됩니다.

드물게 모든 aggregator가 나쁜 price를 반환하거나 collateral이 크게
crash한 경우가 있습니다. 이때 protocol은 나쁜 market에 *억지로 dump
하지 않습니다*. 대신 당신은 collateral itself plus 작은 premium을
받고, 원하는 시점에 hold하거나 sell할 수 있습니다. 이 **fallback
path**는 upfront documented되어 있으며 loan terms의 일부로 accept하게
됩니다.

### Step 5 — 누구나 repay할 수 있습니다

친구나 delegated keeper가 borrower의 loan을 대신 pay off하고 싶다면
가능합니다. 단, collateral은 여전히 borrower에게 돌아갑니다(도와준
third party에게 가지 않습니다). 이는 one-way door입니다. 다른 사람의
loan을 갚아도 그 사람의 collateral을 받을 수는 없습니다.

---

## NFT rentals는 어떻게 작동하나요

Flow는 loan과 같지만 두 가지 차이가 있습니다.

- **NFT는 escrow에 남아 있습니다**; renter가 직접 hold하지 않습니다.
  대신 protocol은 **ERC-4907**을 사용해 rental window 동안 renter에게
  NFT의 "user rights"를 부여합니다. compatible games와 apps는 user
  rights를 읽기 때문에, renter는 NFT를 own하지 않고도 play, log in,
  utility 사용을 할 수 있습니다.
- **Daily fees는 prepaid pool에서 auto-deduct됩니다.** renter는 전체
  rental을 upfront로 prepay하고 5% buffer를 더합니다. 매일 protocol은
  그날의 fee를 owner에게 release합니다. renter가 일찍 종료하고 싶다면
  unused days는 refund됩니다.

rental이 끝나면(expiry 또는 default로), NFT는 owner의 escrow로
돌아갑니다. owner는 다시 list하거나 wallet으로 claim back할 수
있습니다.

---

## 무엇이 나를 보호하나요?

Vaipakam에서 lending과 borrowing은 risk-free가 아닙니다. 하지만
protocol에는 여러 보호 layer가 내장되어 있습니다.

- **Per-user escrow.** 당신의 assets는 당신 자신의 vault에 보관됩니다.
  protocol은 이를 다른 users의 funds와 pool하지 않습니다. 따라서 다른
  user에게 영향을 주는 bug가 당신의 자산을 drain할 수 없습니다.
- **Health Factor enforcement.** loan은 origination 시점에 collateral이
  loan value의 최소 1.5×일 때만 start할 수 있습니다. loan 중간에 price가
  borrower에게 불리하게 움직이면, collateral이 debt보다 낮아지기 전에
  누구나 liquidate할 수 있습니다 — lender를 보호하기 위해서입니다.
- **Multi-source price oracle.** Prices는 먼저 Chainlink에서 오고,
  Tellor, API3, DIA와 cross-check됩니다. configured threshold보다 크게
  disagree하면 loan은 open될 수 없고, ongoing position도 unfairly
  liquidate될 수 없습니다. price를 조작하려면 attacker는 **same block
  안에서 여러 independent oracles**를 corrupt해야 합니다.
- **Slippage cap.** Liquidations는 6%보다 나쁜 slippage로 collateral을
  dump하는 것을 거부합니다. market이 너무 thin하면 protocol은 fallback
  하여 collateral을 직접 당신에게 넘깁니다.
- **L2 sequencer awareness.** L2 chains에서는 chain의 sequencer가
  downtime에서 막 돌아온 직후 liquidation이 잠시 pause됩니다. attackers가
  stale-price window를 악용해 당신에게 피해를 주는 것을 막기 위해서입니다.
- **Pause switches.** 모든 contract에는 emergency pause levers가 있어,
  무언가 이상해 보일 때 operator가 몇 초 안에 new business를 멈출 수
  있습니다. 동시에 existing users는 자신의 positions를 safely wind down
  할 수 있습니다.
- **Independent audits.** 모든 chain의 모든 contract는 third-party
  security review 이후에만 ship됩니다. Audit reports와 bug bounty scope는
  public입니다.

그래도 자신이 무엇에 sign하는지 이해해야 합니다. 각 loan 전에 나오는
combined **risk consent**를 읽어보세요. abnormal-market fallback path와
illiquid collateral의 in-kind settlement path를 설명합니다. consent box를
tick하기 전에는 app이 accept를 허용하지 않습니다.

---

## 비용은 얼마인가요?

fees는 두 가지이며, 둘 다 작습니다.

- **Yield Fee — 1%** lender로서 얻는 **interest**의 1%입니다
  (principal의 1%가 아닙니다). 1,000 USDC를 30-day 8% APR로 lending하는
  loan에서는 lender가 약 6.58 USDC interest를 얻고, 그중 약 0.066 USDC가
  Yield Fee입니다.
- **Loan Initiation Fee — 0.1%** lending amount의 0.1%이며, origination
  시 borrower가 pay합니다. 1,000 USDC loan에서는 1 USDC입니다.

두 fee 모두 escrow에 VPFI를 hold하면 **최대 24% discount**를 받을 수
있습니다(아래 참고). default나 liquidation에서는 recovered interest에
Yield Fee가 collect되지 않습니다 — protocol은 failed loan에서 profit하지
않습니다.

withdrawal fees, idle fees, streaming fees, principal에 대한
"performance" fees는 없습니다. protocol이 가져가는 것은 위의 두 fee
뿐입니다.

---

## VPFI란 무엇인가요?

**VPFI**는 Vaipakam의 protocol token입니다. 세 가지 일을 합니다.

### 1. Fee discounts

어떤 chain의 escrow에 VPFI를 hold하면, 그 chain에서 참여하는 loans의
protocol fees가 discount됩니다.

| Escrow의 VPFI | Fee discount |
|---|---|
| 100 – 999 | 10% |
| 1,000 – 4,999 | 15% |
| 5,000 – 20,000 | 20% |
| 20,000 초과 | 24% |

discount는 lender fees와 borrower fees 모두에 적용됩니다. discount는
**loan의 life 전체에 걸쳐 time-weighted**되므로, loan이 끝나기 직전에
top up해서 calculation을 game할 수 없습니다. 실제로 해당 tier를 hold한
시간에 비례해 discount를 얻습니다.

### 2. Staking — 5% APR

escrow에 있는 모든 VPFI는 자동으로 5% annual yield의 staking rewards를
얻습니다. 별도의 staking action도, lock-up도, "unstake" 대기 시간도
없습니다. VPFI를 escrow로 move하면 그 순간부터 earn합니다. 밖으로
move하면 accrual은 멈춥니다.

### 3. Platform interaction rewards

매일 고정된 VPFI pool이 protocol을 통해 이동한 **interest**에 비례해
lenders와 borrowers에게 distributed됩니다. lender로서 interest를
earned했거나, borrower로서 cleanly interest를 paid했다면(no late fees,
no default) share를 얻습니다.

reward pool은 처음 6개월 동안 가장 크고, 이후 7년에 걸쳐 taper됩니다.
early users가 가장 큰 emissions를 받습니다.

### VPFI를 얻는 방법

세 가지 방법이 있습니다.

- **Earn it** — 참여해서 얻기(위의 interaction rewards).
- **Buy it** — **Buy VPFI** page에서 fixed rate
  (`1 VPFI = 0.001 ETH`)로 구매하기. fixed-rate program은 per wallet
  per chain으로 capped됩니다.
- **Bridge it** — VPFI는 LayerZero OFT V2 token이므로 official bridge를
  사용해 supported chains 사이를 이동할 수 있습니다.

---

## 어떤 chains인가요?

Vaipakam은 각 supported chain에서 independent deployment로 실행됩니다:
**Ethereum**, **Base**, **Arbitrum**, **Optimism**, **Polygon zkEVM**,
**BNB Chain**.

Base에서 open된 loan은 Base에서 settle됩니다. Arbitrum에서 open된 loan은
Arbitrum에서 settle됩니다. cross-chain debt는 없습니다. chains를 넘나드는
것은 VPFI token과 daily reward denominator뿐입니다(활발한 chains와 조용한
chains 사이에서도 rewards가 fair하도록 하기 위해서입니다).

---

## 어디서 시작하나요?

**lend**하고 싶다면:

1. Vaipakam app을 열고 wallet을 connect합니다.
2. **Create Offer**로 이동해 "Lender"를 선택합니다.
3. asset, amount, APR, accepted collateral, duration을 set합니다.
4. 두 transactions에 sign합니다(하나는 approval, 하나는 create). 그러면
   offer가 live됩니다.
5. borrower가 accept하기를 기다립니다. dashboard에 active loans가
   표시됩니다.

**borrow**하고 싶다면:

1. app을 열고 wallet을 connect합니다.
2. **Offer Book**에서 자신의 collateral과 지불 가능한 APR에 맞는 offer를
   browse합니다.
3. **Accept**를 click하고 두 transactions에 sign하면, loan amount가
   wallet으로 들어옵니다(0.1% Loan Initiation Fee 차감 후).
4. due date plus grace period 전에 repay합니다. collateral이 unlock되어
   wallet으로 돌아옵니다.

**NFT를 rent하거나 list**하고 싶다면:

flow는 같지만 **Create Offer** page에서 ERC-20 lending 대신 "NFT rental"을
선택합니다. form이 안내해줍니다.

**VPFI로 passive yield**만 얻고 싶다면, **Dashboard** page에서 VPFI를
escrow에 deposit하면 됩니다. 그게 전부입니다 — staking은 그 순간부터
automatic입니다.

---

## 우리가 *하지 않는* 것

다른 DeFi platforms가 하지만, Vaipakam은 의도적으로 **하지 않는** 것들이
있습니다.

- **No pooled lending.** 각 loan은 양쪽이 sign한 terms를 가진 두 specific
  wallets 사이에서만 이루어집니다. shared liquidity pool도, utilization
  curve도, surprise rate spikes도 없습니다.
- **No proxy custody.** 당신의 assets는 shared vault가 아니라 당신 자신의
  escrow에 있습니다. protocol은 당신이 sign한 actions에서만 이를 move합니다.
- **No leveraged loops by default.** 원한다면 borrowed funds를 새 lender
  offer로 repost할 수 있지만, protocol은 automatic looping을 UX에 build하지
  않습니다. 우리는 이것을 footgun이라고 봅니다.
- **No surprise upgrades.** Escrow upgrades는 gated됩니다. mandatory upgrades는
  app에 표시되어 당신이 explicit하게 apply합니다. 당신의 vault가 뒤에서
  몰래 rewrite되는 일은 없습니다.

---

## 더 알고 싶다면

- **User Guide** tab은 app의 모든 screen을 card by card로 설명합니다.
  "이 button은 무엇을 하나요?" 같은 질문에 좋습니다.
- **Technical** tab은 전체 whitepaper입니다. "liquidation engine은 실제로
  어떻게 작동하나요?" 같은 질문에 좋습니다.
- **FAQ** page는 가장 흔한 짧은 질문들을 다룹니다.
- Discord와 GitHub repo는 모두 app footer에서 link되어 있습니다.

이것이 Vaipakam입니다. wallet을 connect하면 바로 시작할 수 있습니다.
