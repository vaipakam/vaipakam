# Vaipakam — دليل المستخدم (الوضع المتقدم)

شروحات دقيقة وصحيحة تقنياً لكل بطاقة في التطبيق. كل قسم يقابل
أيقونة معلومات `(i)` بجوار عنوان البطاقة. في الوضع **المتقدم**
يقود رابط "اعرف المزيد →" في كل تلميح إلى هنا. أما الوضع الأساسي
فيشير إلى الدليل الأكثر بساطة.

العناوين أدناه تطابق عناوين البطاقات داخل التطبيق. المرساة HTML
المخفية أسفل كل عنوان تطابق معرّف البطاقة، بحيث يستطيع التطبيق
الربط مباشرة بالفقرة المحددة. وثمة مراجع مضمَّنة إلى `README.md`
و `TokenomicsTechSpec.md` و `CLAUDE.md` والعقود حيث تكون مفيدة.

ملاحظة حول اللغة: قوائم المُقرض / المُقترض في **دفتر العروض**
وتدفق **إنشاء عرض** تصف حالات يقوم فيها المُقرض والمُقترض بأمور
مختلفة على الشاشة نفسها، لذلك تذكر هذه الأقسام الدور صراحةً
تجنباً للالتباس. الأقسام الأخرى تخاطب القارئ مباشرة.

---

## لوحة التحكم

<a id="dashboard.your-escrow"></a>

### حساب الحفظ (Escrow) الخاص بك

proxy قابل للترقية UUPS لكل مستخدم
(`VaipakamEscrowImplementation` خلف `ERC1967Proxy`) يُنشَر لك
أول مرة تشارك فيها بقرض. escrow واحد لكل عنوان لكل سلسلة. يحتفظ
بأرصدة ERC-20 و ERC-721 و ERC-1155 المرتبطة بمواضع قروضك. لا
يوجد خلط — لا توجد أصول مستخدمين آخرين أبداً في هذا العقد.

proxy الـ escrow هو الموضع الكنسي الذي تجلس فيه الضمانة والأصول
المُقرَضة و VPFI المقفل. يصادق الـ Diamond ضدّه عند كل
إيداع/سحب؛ والـ implementation قابل للترقية من قِبَل مالك
البروتوكول مع timelock.

<a id="dashboard.your-loans"></a>

### قروضك

كل قرض يخص المحفظة المتصلة على هذه السلسلة — سواء كنت في جانب
المُقرض، أو جانب المُقترض، أو الاثنين عبر مواضع متمايزة. يُحسب
حياً من view selectors لـ `LoanFacet` على الـ Diamond مقابل
عنوانك. كل صف يربط بصفحة الموضع الكاملة بـ HF و LTV والفوائد
المتراكمة وسطح الإجراءات المُقيَّد بدورك + حالة القرض، و
`loanId` on-chain يمكنك لصقه في مستكشف بلوكات.

<a id="dashboard.vpfi-panel"></a>

### VPFI على هذه السلسلة

محاسبة VPFI الحيّة للمحفظة المتصلة على السلسلة النشطة:

- رصيد المحفظة (يُقرأ من ERC-20).
- رصيد الـ escrow (يُقرأ من proxy escrow الخاص بالمستخدم).
- حصتك من المعروض المتداول (بعد طرح الأرصدة المُحتفَظ بها
  للبروتوكول).
- السقف المتبقّي للسكّ.

ينقل Vaipakam الـ VPFI cross-chain عبر LayerZero V2. **Base هي
السلسلة الكنسية** — يدير `VPFIOFTAdapter` هناك دلالات
lock/release. وأي سلسلة مدعومة أخرى تشغّل `VPFIMirror`، وهو OFT
خالص يسكّ على الباقات الواردة ويحرق على الصادرة. ويبقى المعروض
الإجمالي عبر كل السلاسل ثابتاً تحت الـ bridging بحكم البناء.

سياسة الـ DVN هي **3 مطلوبة + 2 اختيارية، عتبة 1 من 2** بعد
تشديدات أبريل 2026 (راجع `CLAUDE.md` "Cross-Chain Security
Policy"). وتُرفض إعدادات DVN 1/1 الافتراضية عند بوابة النشر.

<a id="dashboard.fee-discount-consent"></a>

### الموافقة على خصم الرسوم

علم opt-in على مستوى المحفظة
(`VPFIDiscountFacet.toggleVPFIDiscountConsent`) يسمح للبروتوكول
بتسوية الجزء المخصوم من الرسم بـ VPFI مسحوب من escrow الخاص بك
عند الأحداث الطرفية. الافتراضي: مُعطَّل. التعطيل يعني أنك تدفع
100% من كل رسم بالأصل الأصلي؛ والتفعيل يعني أن الخصم الموزون
بالزمن يُطبَّق.

سلّم الـ tiers (`VPFI_TIER_TABLE`):

| Tier | الحد الأدنى لـ VPFI في الـ escrow | الخصم |
| ---- | -------------------------------- | ----- |
| 1    | ≥ 100                            | 10%   |
| 2    | ≥ 1,000                          | 15%   |
| 3    | ≥ 5,000                          | 20%   |
| 4    | > 20,000                         | 24%   |

يُحسب الـ tier ضد رصيد escrow **post-mutation** عبر
`LibVPFIDiscount.rollupUserDiscount`، ثم يُوزَن بالزمن على
امتداد عمر كل قرض. unstake يعيد طبع BPS عند الرصيد الجديد
الأدنى فوراً لكل قرض مفتوح أنت طرف فيه (يغلق متجه gaming حيث
كان كود ما قبل Phase-5 يطبع عند رصيد pre-mutation).

يُطبَّق الخصم على yield-fee الخاص بالمُقرض عند التسوية، وعلى
Loan Initiation Fee الخاص بالمُقترض (يُدفع كردّ VPFI مع
`claimAsBorrower`). راجع `TokenomicsTechSpec.md` §5.2b و §6.

---

## دفتر العروض

<a id="offer-book.filters"></a>

### المرشّحات

مرشّحات على جانب الـ client فوق قوائم عروض المُقرض / المُقترض.
ترشيح بحسب عنوان الأصل، والجانب، والحالة، وعدد قليل من المحاور
الأخرى. لا تؤثّر المرشّحات على "عروضك النشطة" — تلك القائمة
تُعرض دائماً بكاملها.

<a id="offer-book.your-active-offers"></a>

### عروضك النشطة

عروض مفتوحة (الحالة = Active، ولم تنتهِ صلاحيتها بعد) حيث
`creator == عنوانك`. قابلة للإلغاء في أي وقت قبل القبول عبر
`OfferFacet.cancelOffer(offerId)`. يقلب القبول حالة العرض إلى
`Accepted` ويشغّل `LoanFacet.initiateLoan` الذي يسكّ NFTs
المواضع الاثنين (واحد لكل من المُقرض والمُقترض) ويفتح القرض في
حالة `Active`.

<a id="offer-book.lender-offers"></a>

### عروض المُقرضين

عروض نشطة حيث المُنشئ مستعد للإقراض. يقوم بالقبول مُقترض؛
يمر عبر `OfferFacet.acceptOffer` → `LoanFacet.initiateLoan`.
بوابة صارمة على الـ Diamond: تُفرض
`MIN_HEALTH_FACTOR = 1.5e18` عند البدء ضد سلة ضمانات المُقترض
باستخدام رياضيات LTV/HF لـ `RiskFacet`. وتُخصم نسبة 1% للخزانة
على الفائدة (`TREASURY_FEE_BPS = 100`) عند التسوية الطرفية لا
سلفاً.

<a id="offer-book.borrower-offers"></a>

### عروض المُقترضين

عروض نشطة من مُقترضين قاموا فعلاً بقفل ضمانتهم في الـ escrow.
يقوم بالقبول مُقرض؛ يموّل القرض بالأصل الأصلي ويسكّ NFTs
المواضع. نفس بوابة HF ≥ 1.5 عند البدء. ويُحدَّد الـ APR الثابت
على العرض عند الإنشاء ويبقى ثابتاً طيلة عمر القرض — وتُنشئ
إعادة التمويل قرضاً جديداً.

---

## إنشاء عرض

<a id="create-offer.offer-type"></a>

### نوع العرض

يحدّد على أي جانب من العرض يقف المُنشئ:

- **Lender** — `OfferFacet.createLenderOffer`. يُقدّم المُقرض
  الأصل الأصلي ومواصفات ضمانة على المُقترض الوفاء بها.
- **Borrower** — `OfferFacet.createBorrowerOffer`. يقفل
  المُقترض الضمانة سلفاً؛ ويقبل المُقرض ويُموّل.
- النوع الفرعي **Rental** — لـ NFTs ERC-4907 (ERC-721 قابل
  للتأجير) و ERC-1155 قابلة للتأجير. يمر عبر تدفّق التأجير لا
  قرض الديون؛ يدفع المستأجر سلفاً
  `duration × dailyFee × (1 + RENTAL_BUFFER_BPS / 1e4)` حيث
  `RENTAL_BUFFER_BPS = 500`.

<a id="create-offer.lending-asset"></a>

### الأصل المُقرَض

يحدّد `(asset, amount, aprBps, durationDays)` لعرض دين:

- `asset` — عنوان عقد ERC-20.
- `amount` — الأصل، مقدَّر بكسور الأصل الأصلية.
- `aprBps` — APR ثابت بـ basis points (1/10,000). snapshot عند
  القبول؛ غير تفاعلي.
- `durationDays` — يحدّد نافذة السماح قبل أن يصبح
  `DefaultedFacet.markDefaulted` قابلاً للاستدعاء.

تُحسب الفائدة المتراكمة باستمرار في كل ثانية من
`loan.startTimestamp` حتى التسوية الطرفية.

<a id="create-offer.lending-asset:lender"></a>

#### إذا كنت المُقرض

الأصل الأصلي والمبلغ الذي ترغب في تقديمه، إضافة إلى معدل الفائدة
(APR بالنسبة المئوية) والمدة بالأيام. يُثبَّت المعدل وقت العرض؛
وتحدد المدة نافذة السماح قبل أن يصبح القرض قابلاً للتعثّر. يمر
عبر `OfferFacet.createLenderOffer`؛ وعند القبول ينتقل الأصل من
escrow الخاص بك إلى escrow المُقترض كجزء من
`LoanFacet.initiateLoan`.

<a id="create-offer.lending-asset:borrower"></a>

#### إذا كنت المُقترض

الأصل الأصلي والمبلغ الذي تريده من المُقرض، إضافة إلى معدل
الفائدة (APR بالنسبة المئوية) والمدة بالأيام. يُثبَّت المعدل
وقت العرض؛ وتحدد المدة نافذة السماح قبل أن يصبح القرض قابلاً
للتعثّر. يمر عبر `OfferFacet.createBorrowerOffer`؛ وتُقفل ضمانتك
في الـ escrow الخاص بك وقت إنشاء العرض وتظل مقفلة حتى يقبل
مُقرض ويُفتح القرض (أو حتى تلغي).

<a id="create-offer.nft-details"></a>

### تفاصيل الـ NFT

حقول النوع الفرعي Rental. تُحدّد عقد الـ NFT + token id (و
الكمية لـ ERC-1155)، إضافة إلى `dailyFeeAmount` بالأصل الأصلي.
وعند القبول يخصم `OfferFacet`
`duration × dailyFeeAmount × (1 + 500 / 10_000)` من escrow
المستأجر إلى الحفظ؛ وينتقل الـ NFT نفسه إلى حالة مفوَّضة عبر
`setUser` الخاص بـ ERC-4907 (أو الـ hook المماثل لـ ERC-1155)
بحيث يكون للمستأجر الحقوق دون أن يستطيع نقل الـ NFT.

<a id="create-offer.collateral"></a>

### الضمانة

مواصفات أصل الضمانة على العرض. صنفان من السيولة:

- **سائلة** — تغذية سعر Chainlink مسجَّلة + ≥ 1 من مصانع V3-clone
  الثلاثة (Uniswap، PancakeSwap، SushiSwap) يعيد pool بعمق
  ≥ 1M$ عند الـ tick الحالي (3-V3-clone OR-logic، Phase 7b.1).
  تُطبَّق رياضيات LTV/HF؛ وتمر التصفية المعتمدة على HF عبر
  `RiskFacet → LibSwap` (failover عبر 4 DEX:
  0x → 1inch → Uniswap V3 → Balancer V2).
- **غير سائلة** — كل ما لا يجتاز ما سبق. مُقدَّر بـ $0 on-chain.
  لا رياضيات HF. وعند التعثّر يُنقل كامل الضمانة إلى المُقرض.
  يجب على كل من المُقرض والمُقترض تنفيذ
  `acceptIlliquidCollateralRisk` عند إنشاء/قبول العرض كي يهبط
  العرض.

نصاب الـ oracle الثانوي (Phase 7b.2): Tellor + API3 + DIA،
قاعدة قرار soft 2-of-N. أُزيلت Pyth.

<a id="create-offer.collateral:lender"></a>

#### إذا كنت المُقرض

كم تريد من المُقترض أن يقفل لتأمين القرض. الـ ERC-20s السائلة
(تغذية Chainlink + عمق pool v3 ≥ 1M$) تخضع لحساب LTV/HF؛ أما
ERC-20s غير السائلة وNFTs فلا يوجد لها تقييم on-chain، وتتطلب
موافقة الطرفين على نتيجة "كامل الضمانة عند التعثّر". تُحسب
بوابة HF ≥ 1.5e18 عند `LoanFacet.initiateLoan` ضد سلة الضمانة
التي يقدّمها المُقترض عند القبول — وحجم المتطلب هنا يحدّد
مباشرةً مساحة الـ HF الإضافية المتاحة للمُقترض.

<a id="create-offer.collateral:borrower"></a>

#### إذا كنت المُقترض

كم أنت مستعد لقفله لتأمين القرض. الـ ERC-20s السائلة (تغذية
Chainlink + عمق pool v3 ≥ 1M$) تخضع لحساب LTV/HF؛ أما ERC-20s
غير السائلة وNFTs فلا يوجد لها تقييم on-chain، وتتطلب موافقة
الطرفين على نتيجة "كامل الضمانة عند التعثّر". تُقفل ضمانتك في
الـ escrow الخاص بك وقت إنشاء العرض على عرض المُقترض؛ وعلى
عرض المُقرض تُقفل ضمانتك وقت قبول العرض. وفي كلا الحالتين يجب
أن تُفتح بوابة HF ≥ 1.5e18 على `LoanFacet.initiateLoan` بالسلة
التي تقدّمها.

<a id="create-offer.risk-disclosures"></a>

### إفصاحات المخاطر

بوابة إقرار قبل الإرسال. ينطبق نفس سطح المخاطر على الجانبين؛
وتشرح علامات التبويب أدناه — كلٌّ لدور — كيف يعضّ كل خطر
بطريقة مختلفة وفقاً للجانب الذي توقّع منه على العرض. Vaipakam
غير حافظ؛ ولا توجد مفتاح إدارة يستطيع عكس معاملة هبطت. تتوفر
أذرع pause على عقود مواجهة LZ فقط، مُقيَّدة بـ timelock؛ ولا
تستطيع تحريك أصول.

<a id="create-offer.risk-disclosures:lender"></a>

#### إذا كنت المُقرض

- **مخاطر العقد الذكي** — رمز ثابت زمن التشغيل؛ مُدقَّق دون
  تحقق رسمي.
- **مخاطر الـ oracle** — قِدم Chainlink أو تباعد عمق pool V3
  قد يؤخّر تصفية مبنيّة على HF بعد النقطة التي تغطّي فيها
  الضمانة الأصل. يلتقط النصاب الثانوي (Tellor + API3 + DIA،
  Soft 2-of-N) الانحرافات الكبيرة، لكن انحرافاً صغيراً قد يقلّص
  الاستردادات.
- **انزلاق التصفية** — failover عبر 4 DEX في `LibSwap`
  (0x → 1inch → Uniswap V3 → Balancer V2) يوجّه إلى أفضل تنفيذ
  يجده، لكنه لا يستطيع ضمان سعر محدد. والاسترداد صافٍ بعد
  الانزلاق وخصم 1% الخزانة على الفائدة.
- **تعثّر الضمانة غير السائلة** — تنتقل الضمانة إليك بالكامل
  وقت `markDefaulted`. ولا يوجد رجوع إذا كانت قيمتها أقل من
  `principal + accruedInterest()`.

<a id="create-offer.risk-disclosures:borrower"></a>

#### إذا كنت المُقترض

- **مخاطر العقد الذكي** — رمز ثابت زمن التشغيل؛ والأخطاء تؤثّر
  على الضمانة المقفلة.
- **مخاطر الـ oracle** — قِدم أو تلاعب قد يطلق تصفية مبنية على
  HF ضدّك في حين أن سعر السوق الحقيقي كان سيبقى آمناً. صيغة الـ
  HF تفاعلية مع مخرجات الـ oracle؛ ويكفي tick سيئ واحد يعبر
  1.0.
- **انزلاق التصفية** — حين ينطلق `RiskFacet → LibSwap`، قد
  يبيع الـ swap ضمانتك بأسعار يأكلها الانزلاق. والـ swap
  permissionless — يمكن لأي شخص تشغيله في اللحظة التي تكون
  فيها HF < 1e18.
- **تعثّر الضمانة غير السائلة** — ينقل `markDefaulted` ضمانتك
  كاملة إلى المُقرض. لا حق متبقٍ — فقط أي ردّ VPFI LIF غير
  مستخدم عبر `claimAsBorrower`.

<a id="create-offer.advanced-options"></a>

### خيارات متقدمة

مقابض أقل شيوعاً:

- `expiryTimestamp` — يلغي العرض نفسه بعد ذلك. الافتراضي ~7
  أيام.
- `useFeeDiscountForThisOffer` — تجاوز محلّي للموافقة على
  مستوى المحفظة لهذا العرض المحدد.
- خيارات خاصة بالدور يكشفها OfferFacet لكل جانب.

القيم الافتراضية معقولة لمعظم المستخدمين.

---

## مركز المطالبات

<a id="claim-center.claims"></a>

### الأموال القابلة للمطالبة

المطالبات على نمط الـ pull بحكم التصميم — تترك الأحداث الطرفية
الأموال في حفظ الـ Diamond / الـ escrow، ويستدعي حامل NFT
الموضع `claimAsLender` / `claimAsBorrower` لتحريكها. يمكن أن
يجلس النوعان من المطالبات في المحفظة نفسها في الوقت نفسه. تصف
علامات التبويب أدناه — كل واحدة لدور — كل نوع.

تحرق كل مطالبة NFT موضع الحامل ذرّياً. الـ NFT _هو_ أداة
الحامل — نقله قبل المطالبة يمنح الحامل الجديد حق التحصيل.

<a id="claim-center.claims:lender"></a>

#### إذا كنت المُقرض

`ClaimFacet.claimAsLender(loanId)` يُعيد:

- `principal` يعود إلى محفظتك على هذه السلسلة.
- `accruedInterest(loan)` ناقصاً 1% الخزانة
  (`TREASURY_FEE_BPS = 100`) — وتُخفَّض هذه الشريحة نفسها
  بمراكم الخصم على رسوم VPFI الموزون بالزمن (Phase 5) عند
  تفعيل الموافقة.

قابل للمطالبة فور بلوغ القرض حالة طرفية (Settled أو Defaulted
أو Liquidated). ويُحرَق NFT موضع المُقرض في المعاملة نفسها.

<a id="claim-center.claims:borrower"></a>

#### إذا كنت المُقترض

`ClaimFacet.claimAsBorrower(loanId)` يُعيد، وفقاً لكيفية تسوية
القرض:

- **سداد كامل / preclose / refinance** — سلة ضمانتك، إضافة إلى
  ردّ VPFI الموزون بالزمن من الـ LIF
  (`s.borrowerLifRebate[loanId].rebateAmount`).
- **تصفية HF أو تعثّر** — فقط ردّ VPFI LIF غير المستخدم (وهو
  على هذه المسارات الطرفية صفر ما لم يُحفظ صراحةً). فقد ذهبت
  الضمانة بالفعل إلى المُقرض.

ويُحرَق NFT موضع المُقترض في المعاملة نفسها.

---

## النشاط

<a id="activity.feed"></a>

### تغذية النشاط

أحداث on-chain تخص محفظتك على السلسلة النشطة، تُجلب حياً من
سجلات الـ Diamond (`getLogs` على نافذة بلوكات منزلقة). لا cache
على الخلفية — كل تحميل يُعيد الجلب. تُجمَّع الأحداث بحسب
`transactionHash` كي تبقى المعاملات متعدّدة الأحداث (مثل accept
+ initiate) معاً. الأحدث أولاً. يُظهر العروض، والقروض،
والسدادات، والمطالبات، والتصفيات، وعمليات mint/burn لـ NFT،
وعمليات شراء / staking / unstake لـ VPFI.

---

## شراء VPFI

<a id="buy-vpfi.overview"></a>

### شراء VPFI

مساران:

- **Canonical (Base)** — استدعاء مباشر لـ
  `VPFIBuyFacet.buyVPFIWithETH` على الـ Diamond. يسكّ VPFI
  مباشرة إلى محفظتك على Base.
- **Off-canonical** — `VPFIBuyAdapter.buy()` على السلسلة
  المحلية يرسل باقة LayerZero إلى `VPFIBuyReceiver` على Base،
  والذي يستدعي الـ Diamond ويعيد إرسال النتيجة OFT. الزمن من
  طرف لطرف ~1 دقيقة على أزواج L2-إلى-L2. يصل الـ VPFI إلى
  محفظتك على سلسلة **الأصل**.

حدود معدّل الـ adapter (بعد التشديد): 50k VPFI لكل طلب،
500k منزلقة كل 24 ساعة. قابلة للضبط عبر `setRateLimits`
(timelock).

<a id="buy-vpfi.discount-status"></a>

### حالة خصم VPFI الخاصة بك

حالة حيّة:

- الـ tier الحالي (0..4، من
  `VPFIDiscountFacet.getVPFIDiscountTier`).
- رصيد VPFI في الـ escrow + الفارق إلى الـ tier التالي.
- خصم BPS عند الـ tier الحالي.
- علم الموافقة على مستوى المحفظة.

لاحظ أن VPFI الـ escrow يجمع أيضاً 5% APR عبر staking pool —
لا يوجد إجراء "stake" منفصل؛ الإيداع في الـ escrow هو staking.

<a id="buy-vpfi.buy"></a>

### الخطوة 1 — اشترِ VPFI بـ ETH

تقديم الشراء. على السلاسل الكنسية يسكّ الـ Diamond مباشرة. وعلى
سلاسل الـ mirror يستلم buy adapter الدفع، ويرسل رسالة LZ،
وينفّذ الـ receiver عملية الشراء على Base ويعيد إرسال VPFI عبر
OFT. تكلفة الجسر + DVN تُعرض حياً عبر
`useVPFIBuyBridge.quote()` وتظهر في النموذج. لا يُودَع VPFI
تلقائياً في الـ escrow — الخطوة 2 صريحة.

<a id="buy-vpfi.deposit"></a>

### الخطوة 2 — أودع VPFI في الـ escrow

`Diamond.depositVPFIToEscrow(amount)`. مطلوب على كل سلسلة —
حتى الكنسية — لأن الإيداع في الـ escrow بحسب المواصفات هو دائماً
إجراء صريح من المستخدم. وعلى السلاسل التي بها Permit2
(Phase 8b)، يفضّل التطبيق مسار التوقيع الواحد
(`depositVPFIToEscrowWithPermit2`) على approve + deposit.
ويتراجع برشاقة إذا لم يكن Permit2 مهيّأً على تلك السلسلة.

<a id="buy-vpfi.unstake"></a>

### الخطوة 3 — أخرج VPFI من الـ escrow

`Diamond.withdrawVPFIFromEscrow(amount)`. لا توجد مرحلة
موافقة — يملك الـ Diamond proxy الـ escrow ويخصم من نفسه. يطلق
استدعاء السحب
`LibVPFIDiscount.rollupUserDiscount(user, postBalance)` بحيث
يُعاد طبع مراكم BPS لكل قرض مفتوح عند الرصيد الجديد (الأدنى)
فوراً. لا توجد نافذة سماح يبقى فيها الـ tier القديم منطبقاً.

---

## المكافآت

<a id="rewards.overview"></a>

### عن المكافآت

تدفّقان:

- **Staking pool** — VPFI المُحتفَظ به في الـ escrow ينمو بـ
  5% APR باستمرار. تركيب لكل ثانية عبر
  `RewardFacet.pendingStaking`.
- **Interaction pool** — حصة pro-rata يومية من إصدار يومي
  ثابت، موزونة بمساهمتك من الفائدة المُسوَّاة في حجم قروض ذلك
  اليوم. وتُغلق نوافذ اليوم بشكل lazy عند أول مطالبة بعد
  إغلاق النافذة.

تُسكّ كلتا المكافأتين مباشرة على السلسلة النشطة (لا round-trip
عبر LZ للمستخدم؛ تجميع المكافآت عبر السلاسل يتم على
`VaipakamRewardOApp` بين عقود البروتوكول فقط).

<a id="rewards.claim"></a>

### المطالبة بالمكافآت

`RewardFacet.claimRewards()` — معاملة واحدة، تطالب بكلا
التدفّقين. الـ staking متاح دائماً؛ والتفاعل يكون `0n` حتى
تُغلق نافذة اليوم المعنية (إغلاق lazy تطلقه أول مطالبة أو تسوية
غير صفرية على تلك السلسلة). تحرس الـ UI الزر حين يكون
`interactionWaitingForFinalization` كي لا يطالب المستخدمون
بأقل من اللازم.

<a id="rewards.withdraw-staked"></a>

### سحب VPFI المُستَيك

سطح مماثل لـ "الخطوة 3 — Unstake" في صفحة شراء VPFI —
`withdrawVPFIFromEscrow`. يخرج الـ VPFI المسحوب من staking
pool فوراً (تتوقف المكافآت عن التراكم لذلك المبلغ من ذلك
البلوك) ويخرج من مراكم الخصم فوراً (إعادة طبع post-balance على
كل قرض مفتوح).

---

## تفاصيل القرض

<a id="loan-details.overview"></a>

### تفاصيل القرض (هذه الصفحة)

عرض قرض واحد مشتق من
`LoanFacet.getLoanDetails(loanId)` إضافة إلى HF/LTV الحيّين من
`RiskFacet.calculateHealthFactor`. يعرض الشروط، ومخاطر الضمانة،
والأطراف، وسطح الإجراءات المُقيَّد بـ
`getLoanActionAvailability(loan, viewerAddress)`، وحالة keeper
المضمَّنة من `useKeeperStatus`.

<a id="loan-details.terms"></a>

### شروط القرض

الأجزاء الثابتة من القرض:

- `principal` (الأصل + المبلغ).
- `aprBps` (مُثبَّت عند إنشاء العرض).
- `durationDays`.
- `startTimestamp` و `endTimestamp` (= `startTimestamp +
durationDays * 1 days`).
- `accruedInterest()` — دالة view، تحسب من `now -
startTimestamp`.

تنشئ إعادة التمويل `loanId` جديداً بدلاً من تعديل هذه القيم.

<a id="loan-details.collateral-risk"></a>

### الضمانة والمخاطر

رياضيات المخاطر الحيّة عبر `RiskFacet`. **Health Factor** هو
`(collateralUsdValue × liquidationThresholdBps / 1e4) /
debtUsdValue`، مُحجَّم إلى 1e18. HF < 1e18 يطلق التصفية
المعتمدة على HF. **LTV** هو `debtUsdValue / collateralUsdValue`.
عتبة التصفية = الـ LTV الذي يصبح عنده الموضع قابلاً للتصفية؛
ويعتمد ذلك على فئة تقلّب سلة الضمانة
(`VOLATILITY_LTV_THRESHOLD_BPS = 11000` لحالة انهيار التقلّب
العالي).

تكون قيمة الضمانة غير السائلة `usdValue == 0` on-chain؛ ويتقلّص
HF/LTV إلى n/a ويصبح المسار الطرفي الوحيد هو النقل الكامل عند
التعثّر — وقد وافق الطرفان عند إنشاء العرض عبر إقرار مخاطر
الإيليكويد.

<a id="loan-details.collateral-risk:lender"></a>

#### إذا كنت المُقرض

سلة الضمانة المؤمِّنة لهذا القرض هي حمايتك. HF > 1e18 يعني أن
الموضع زائد التغطية مقابل عتبة التصفية. ومع انجراف HF نحو
1e18، تترقّق حمايتك؛ وبمجرد أن HF < 1e18 يستطيع أي شخص (بما
فيهم أنت) استدعاء `RiskFacet.triggerLiquidation(loanId)`،
وسيوجّه `LibSwap` الضمانة عبر failover الـ 4 DEX إلى أصلك
الأصلي. والاسترداد صافٍ بعد الانزلاق.

أما الضمانة غير السائلة، فعند التعثّر تنتقل السلة إليك بالكامل
وقت `markDefaulted` — وما تساويه فعلاً مشكلتك.

<a id="loan-details.collateral-risk:borrower"></a>

#### إذا كنت المُقترض

ضمانتك المقفلة. حافظ على HF فوق 1e18 براحة — هدف الـ buffer
الشائع ≥ 1.5e18 لتحمّل التقلّب. روافع لرفع HF:

- `addCollateral(loanId, …)` — تعزيز السلة؛ للمستخدم فقط.
- سداد جزئي عبر `RepayFacet` — يخفض الدين، ويرفع HF.

بمجرد أن HF < 1e18 يمكن لأي شخص تشغيل التصفية المعتمدة على HF؛
ويبيع الـ swap ضمانتك بأسعار يأكلها الانزلاق لتسديد المُقرض.
على الضمانة غير السائلة، ينقل التعثّر ضمانتك كاملة إلى المُقرض
— ولا يبقى للمطالبة سوى أي ردّ VPFI LIF غير مستخدم
(`s.borrowerLifRebate[loanId].rebateAmount`).

<a id="loan-details.parties"></a>

### الأطراف

`(lender, borrower, lenderEscrow, borrowerEscrow,
positionNftLender, positionNftBorrower)`. كل NFT هو ERC-721
بمعرّفات on-chain؛ نقله ينقل حقّ المطالبة. proxies الـ escrow
حتمية لكل عنوان (CREATE2) — نفس العنوان عبر النشر.

<a id="loan-details.actions"></a>

### الإجراءات

سطح الإجراءات، مُقيَّد لكل دور عبر
`getLoanActionAvailability`. تعدّد علامات التبويب أدناه —
كلٌّ لدور — selectors المتاحة لكل جانب. تكشف الإجراءات
المعطَّلة سبب hover مشتقاً من البوابة (`InsufficientHF`،
`NotYetExpired`، `LoanLocked`، إلخ).

إجراءات permissionless متاحة لأي شخص بصرف النظر عن الدور:

- `RiskFacet.triggerLiquidation(loanId)` — حين HF < 1e18.
- `DefaultedFacet.markDefaulted(loanId)` — حين تنقضي فترة
  السماح دون سداد كامل.

<a id="loan-details.actions:lender"></a>

#### إذا كنت المُقرض

- `ClaimFacet.claimAsLender(loanId)` — طرفي فقط. يُعيد principal
  + الفائدة ناقصاً 1% الخزانة (مُخفَّض أكثر بخصم yield-fee
  الـ VPFI الموزون بالزمن عند تفعيل الموافقة). ويحرق NFT موضع
  المُقرض.
- `EarlyWithdrawalFacet.initEarlyWithdrawal(loanId, askPrice)` —
  يدرج NFT المُقرض للبيع بـ `askPrice`. مشترٍ يستدعي
  `completeEarlyWithdrawal(saleId)` يأخذ جانبك؛ وتستلم أنت
  العائد. قابل للإلغاء قبل الإنجاز.
- يمكن تفويضه اختيارياً إلى keeper يحمل بِت الإجراء ذي الصلة
  (`COMPLETE_LOAN_SALE`، إلخ) — راجع إعدادات الـ Keeper.

<a id="loan-details.actions:borrower"></a>

#### إذا كنت المُقترض

- `RepayFacet.repay(loanId, amount)` — كامل أو جزئي. الجزئي
  يخفض المتبقّي ويرفع HF؛ والكامل يطلق التسوية الطرفية، بما
  في ذلك ردّ VPFI LIF الموزون بالزمن عبر
  `LibVPFIDiscount.settleBorrowerLifProper`.
- `PrecloseFacet.precloseDirect(loanId)` — يدفع المتبقّي من
  محفظتك الآن، يفك الضمانة، ويسوّي ردّ الـ LIF.
- `PrecloseFacet.initOffset(loanId, swapParams)` /
  `completeOffset(loanId)` — يبيع جزءاً من الضمانة عبر
  `LibSwap`، يسدّد من العائد، ويعيد المتبقّي.
- تدفق `RefinanceFacet` — انشر عرض مُقترض بشروط جديدة؛
  `completeRefinance(oldLoanId, newOfferId)` يبدّل القروض
  ذرّياً دون مغادرة الضمانة الـ escrow.
- `ClaimFacet.claimAsBorrower(loanId)` — طرفي فقط. يُعيد
  الضمانة عند السداد الكامل، أو ردّ VPFI LIF غير المستخدم عند
  التعثّر / التصفية. ويحرق NFT موضع المُقترض.

---

## التصاريح (Allowances)

<a id="allowances.list"></a>

### التصاريح

تعرض كل `allowance(wallet, diamondAddress)` ERC-20 منحتها
محفظتك للـ Diamond على هذه السلسلة. مصدرها مسح قائمة رموز
مرشَّحة مقابل استدعاءات view لـ `IERC20.allowance`. الإلغاء
يضبط الـ allowance على صفر عبر `IERC20.approve(diamond, 0)`.
وفقاً لسياسة الموافقة بالمبلغ المضبوط، لا يطلب البروتوكول قط
موافقات غير محدودة، فالإلغاءات عادةً قليلة العدد.

ملاحظة: تدفّقات على نمط Permit2 (Phase 8b) تتجاوز موافقة
per-asset على الـ Diamond باستخدام توقيع واحد بدلاً من ذلك،
لذلك القائمة النظيفة هنا لا تستثني الإيداعات المستقبلية.

---

## التنبيهات

<a id="alerts.overview"></a>

### عن التنبيهات

worker Cloudflare off-chain (`hf-watcher`) يستجوب كل قرض نشط
يخص محفظتك بإيقاع 5 دقائق. يقرأ
`RiskFacet.calculateHealthFactor` لكل واحد. وعند عبور شريط في
الاتجاه غير الآمن، يطلق مرة عبر القنوات المهيّأة. لا حالة
on-chain، ولا gas. التنبيهات استشارية — لا تحرّك أموالاً.

<a id="alerts.threshold-ladder"></a>

### سلّم العتبات

سلّم شرائط HF يهيّئه المستخدم. العبور إلى شريط أكثر خطراً
يطلق مرة ويُسلّح العتبة الأعمق التالية. وعبور الرجوع فوق شريط
يعيد تسليحه. الافتراضيات: `1.5 → 1.3 → 1.1`. الأرقام الأعلى
ملائمة للضمانة المتقلبة؛ ومهمة السلّم الوحيدة هي إخراجك قبل
أن تطلق HF < 1e18 التصفية.

<a id="alerts.delivery-channels"></a>

### قنوات التسليم

سكّتان:

- **Telegram** — DM من بوت بالعنوان المختصر للمحفظة + loan id
  + HF الحالي.
- **Push Protocol** — إشعار مباشر للمحفظة عبر قناة Vaipakam
  Push.

تتشاركان سلّم العتبات؛ ولا تُكشف مستويات التحذير لكل قناة عمداً
(تجنّباً للانجراف). نشر قناة Push مُعطَّل مؤقتاً ريثما تُنشأ
القناة — راجع ملاحظات Phase 8a.

---

## مُحقّق الـ NFT

<a id="nft-verifier.lookup"></a>

### تحقّق من NFT

عند `(nftAddress, tokenId)` يُجلب:

- `IERC721.ownerOf(tokenId)` (أو burn-selector `0x7e273289`
  => مُحرَق سلفاً).
- `IERC721.tokenURI(tokenId)` → بيانات JSON on-chain.
- تحقّق متبادل من الـ Diamond: يستنتج `loanId` الأساسي من
  البيانات ويقرأ `LoanFacet.getLoanDetails(loanId)` لتأكيد
  الحالة.

يكشف: minted-by-Vaipakam؟ على أي سلسلة؟ حالة القرض؟ الحامل
الحالي؟ ويسمح برصد تزوير، أو موضع مطالَب به (مُحرَق) سلفاً، أو
موضع تمت تسوية قرضه وهو في mid-claim.

NFT الموضع هو أداة الحامل — تحقّق قبل الشراء على سوق ثانوي.

---

## إعدادات الـ Keeper

<a id="keeper-settings.overview"></a>

### عن الـ Keepers

قائمة keepers بيضاء لكل محفظة (`KeeperSettingsFacet`) تصل إلى
5 keepers (`MAX_KEEPERS = 5`). لكل keeper bitmask إجراءات
(`KEEPER_ACTION_*`) يفوّض استدعاءات صيانة محددة على **جانبك**
من القرض. مسارات خروج الأموال (repay، claim، addCollateral،
liquidate) للمستخدم فقط بحكم التصميم ولا يمكن تفويضها.

تُطبَّق بوابتان إضافيتان وقت الإجراء:

1. مفتاح وصول keeper الرئيسي (مكبح طوارئ بقلب واحد؛ يعطّل كل
   keeper دون لمس قائمة الإذن).
2. toggle الاشتراك لكل قرض (يُضبط في دفتر العروض / تفاصيل
   القرض).

لا يستطيع الـ keeper التصرّف إلا عندما تكون
`(approved, masterOn, perLoanOn, actionBitSet)` كلها true.

<a id="keeper-settings.approved-list"></a>

### الـ Keepers المعتمدون

أعلام bitmask المكشوفة حالياً:

- `COMPLETE_LOAN_SALE` (0x01)
- `COMPLETE_OFFSET` (0x02)
- `INIT_EARLY_WITHDRAW` (0x04)
- `INIT_PRECLOSE` (0x08)
- `REFINANCE` (0x10)

البتات المضافة on-chain دون انعكاسها في الـ frontend تحصل على
revert `InvalidKeeperActions`. الإلغاء هو
`KeeperSettingsFacet.removeKeeper(addr)` وفوري على كل القروض.

---

## لوحة التحليل العام

<a id="public-dashboard.overview"></a>

### عن التحليل العام

مجمِّع بلا محفظة يُحسب حياً من استدعاءات view لـ Diamond
on-chain عبر كل سلسلة مدعومة. لا backend / قاعدة بيانات.
hooks المعنية: `useProtocolStats`، `useTVL`،
`useTreasuryMetrics`، `useUserStats`، `useVPFIToken`. تصدير CSV
/ JSON متاح؛ ويُعرض عنوان الـ Diamond + دالة view لكل مقياس
لإمكانية التحقق.

<a id="public-dashboard.combined"></a>

### مجمّع — كل السلاسل

rollup عبر السلاسل. يُبلّغ الترويسة عن `chainsCovered` و
`chainsErrored` كي يكون RPC غير قابل للوصول وقت الجلب صريحاً.
`chainsErrored > 0` يعني أن جدول الـ per-chain يعلِّم أيها —
وما تزال إجماليات TVL مُبلَّغة لكنها تعترف بالفجوة.

<a id="public-dashboard.per-chain"></a>

### تفصيل لكل سلسلة

تقسيم لكل سلسلة من المقاييس المجمَّعة. مفيد لرصد تركّز TVL،
أو معروضات mirror VPFI غير المتطابقة (يجب أن يساوي مجموعها
رصيد قفل الـ adapter الكنسي)، أو السلاسل المعطَّلة.

<a id="public-dashboard.vpfi-transparency"></a>

### شفافية رمز VPFI

محاسبة VPFI on-chain على السلسلة النشطة:

- `totalSupply()` — أصلي ERC-20.
- المعروض المتداول — `totalSupply()` ناقصاً الأرصدة المُحتفَظ
  بها للبروتوكول (الخزانة، أحواض المكافآت، باقات LZ in-flight).
- السقف المتبقّي للسكّ — مشتق من
  `MAX_SUPPLY - totalSupply()` على الكنسية؛ وتُبلّغ سلاسل الـ
  mirror `n/a` للسقف (السكّ هناك مدفوع عبر الجسر).

ثابت عبر السلاسل: مجموع `VPFIMirror.totalSupply()` عبر كل
سلاسل الـ mirror == `VPFIOFTAdapter.lockedBalance()` على
الكنسية. الـ watcher يراقب وينبّه عند الانجراف.

<a id="public-dashboard.transparency"></a>

### الشفافية والمصدر

لكل مقياس، تُعدَّد:

- رقم البلوك المستخدم كـ snapshot.
- حداثة البيانات (أقصى staleness عبر السلاسل).
- عنوان الـ Diamond واستدعاء دالة view.

يستطيع أي شخص إعادة اشتقاق أي رقم في هذه الصفحة من
`(rpcUrl, blockNumber, diamondAddress, fnName)` — هذا هو
المعيار.

---

## إعادة التمويل

هذه الصفحة للمُقترضين فقط — تُبدأ إعادة التمويل من قِبَل
المُقترض على قرض المُقترض.

<a id="refinance.overview"></a>

### عن إعادة التمويل

`RefinanceFacet` — يسدّد قرضك القائم ذرّياً من principal جديد
ويفتح قرضاً جديداً بالشروط الجديدة، كل ذلك في tx واحدة. تبقى
الضمانة في الـ escrow الخاص بك طوال الوقت — لا نافذة بلا
تأمين. ويجب أن يجتاز القرض الجديد
`MIN_HEALTH_FACTOR = 1.5e18` عند البدء كأي قرض آخر.

يُستدعى `LibVPFIDiscount.settleBorrowerLifProper(oldLoan)` على
القرض القديم كجزء من المبادلة، بحيث يُسجَّل أي ردّ VPFI LIF غير
مستخدم بشكل صحيح.

<a id="refinance.position-summary"></a>

### وضعك الحالي

snapshot للقرض قيد إعادة التمويل — `loan.principal`، و
`accruedInterest()` الحالي، و HF/LTV، وسلة الضمانة. يجب أن
يحجز العرض الجديد على الأقل المتبقّي
(`principal + accruedInterest()`)؛ وأي فائض في العرض الجديد
يُسلَّم إلى الـ escrow الخاص بك بصفته أصلاً حراً.

<a id="refinance.step-1-post-offer"></a>

### الخطوة 1 — انشر العرض الجديد

ينشر عرض مُقترض عبر `OfferFacet.createBorrowerOffer` بشروطك
المستهدفة. ويستمر القرض القديم في تراكم الفوائد؛ وتبقى الضمانة
مقفلة. يظهر العرض في دفتر العروض العام، ويستطيع أي مُقرض
قبوله. يمكنك الإلغاء قبل القبول.

<a id="refinance.step-2-complete"></a>

### الخطوة 2 — الإكمال

`RefinanceFacet.completeRefinance(oldLoanId, newOfferId)` —
ذرّي:

1. يموّل القرض الجديد من المُقرض القابل.
2. يسدّد القرض القديم بالكامل (principal + الفائدة، ناقصاً
   شريحة الخزانة).
3. يحرق NFTs المواضع القديمة.
4. يسكّ NFTs المواضع الجديدة.
5. يسوّي ردّ الـ LIF للقرض القديم عبر
   `LibVPFIDiscount.settleBorrowerLifProper`.

يُجري revert إذا HF < 1.5e18 على الشروط الجديدة.

---

## الإغلاق المبكّر

هذه الصفحة للمُقترضين فقط — يُبدأ الإغلاق المبكّر من قِبَل
المُقترض على قرض المُقترض.

<a id="preclose.overview"></a>

### عن الإغلاق المبكّر

`PrecloseFacet` — إنهاء مبكّر يقوده المُقترض. مساران:

- **مباشر** — `precloseDirect(loanId)`. يدفع
  `principal + accruedInterest()` من محفظتك، ويفك الضمانة.
  يستدعي `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
- **Offset** — `initOffset(loanId, swapParams)` ثم
  `completeOffset(loanId)`. يبيع جزءاً من الضمانة عبر
  `LibSwap` (failover عبر 4 DEX) مقابل الأصل الأصلي، ويسدّد من
  العائد، ويعود ما تبقى من الضمانة إليك. تسوية ردّ الـ LIF
  نفسها.

لا عقوبة ثابتة للإغلاق المبكر. تتولى رياضيات VPFI الموزونة
بالزمن في Phase 5 رياضيات العدالة.

<a id="preclose.position-summary"></a>

### وضعك الحالي

snapshot للقرض الذي يُغلق مبكراً — principal المتبقّي،
الفوائد المتراكمة، HF/LTV الحاليان. لا يتطلب تدفّق الإغلاق
المبكّر **HF ≥ 1.5e18** عند الخروج (هو إغلاق، لا re-init).

<a id="preclose.in-progress"></a>

### Offset قيد التنفيذ

الحالة: هبط `initOffset`، والـ swap في mid-execution (أو
استُهلكت العرضة وما زالت التسوية النهائية معلَّقة). مخرجان:

- `completeOffset(loanId)` — يسوّي القرض من العائد المتحقَّق،
  ويعيد ما تبقى.
- `cancelOffset(loanId)` — إلغاء؛ تبقى الضمانة مقفلة، والقرض
  دون تغيير. استخدمه عندما يكون الـ swap قد تحرّك ضدّك بين
  init و complete.

<a id="preclose.choose-path"></a>

### اختر مساراً

يستهلك المسار المباشر سيولة المحفظة بالأصل الأصلي. ويستهلك
مسار الـ offset الضمانة عبر swap على DEX؛ مفضَّل حين لا يكون
الأصل الأصلي بحوزتك أو حين تريد الخروج من موضع الضمانة أيضاً.
انزلاق الـ offset يمر عبر failover الـ 4 DEX في `LibSwap`
(0x → 1inch → Uniswap V3 → Balancer V2).

---

## السحب المبكّر (المُقرض)

هذه الصفحة للمُقرضين فقط — يُبدأ السحب المبكّر من قِبَل
المُقرض على قرضه.

<a id="early-withdrawal.overview"></a>

### عن الخروج المبكّر للمُقرض

`EarlyWithdrawalFacet` — آلية سوق ثانوي لمواضع المُقرض. تدرج
NFT الموضع للبيع بسعر تختاره؛ وعند القبول يدفع المشتري،
وتنتقل ملكية NFT المُقرض إلى المشتري، ويصبح المشتري هو
المُقرض المسجَّل لكل تسوية مستقبلية (claim عند الطرفي، إلخ).
وتمضي أنت بعائد البيع.

تبقى التصفيات للمستخدم فقط ولا يتم تفويضها عبر البيع — فقط
حقّ المطالبة هو ما يُنقل.

<a id="early-withdrawal.position-summary"></a>

### وضعك الحالي

snapshot — principal المتبقّي، الفوائد المتراكمة، الوقت
المتبقّي، HF/LTV الحاليان لجانب المُقترض. هذه تحدّد السعر
العادل الذي يتوقّعه سوق المشترين: عائد المشتري هو
`principal + interest` عند الطرفي، ناقصاً مخاطر التصفية على
الزمن المتبقّي.

<a id="early-withdrawal.initiate-sale"></a>

### بدء البيع

`initEarlyWithdrawal(loanId, askPrice)`. يدرج NFT الموضع
للبيع عبر البروتوكول؛ و
`completeEarlyWithdrawal(saleId)` هو ما يستدعيه المشتري للقبول.
قابل للإلغاء قبل الإنجاز عبر
`cancelEarlyWithdrawal(saleId)`. يمكن تفويضه اختيارياً إلى
keeper يحمل بِت الإجراء `COMPLETE_LOAN_SALE`؛ يبقى الـ init
نفسه للمستخدم فقط.
