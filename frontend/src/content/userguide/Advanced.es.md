# Vaipakam — Guía del usuario (Modo avanzado)

Explicaciones precisas y técnicamente exactas de cada tarjeta de la
aplicación. Cada sección corresponde a un icono de información `(i)`
junto al título de una tarjeta.

> **Estás leyendo la versión Avanzada.** Corresponde al modo
> **Avanzado** de la app (controles más densos, diagnósticos y
> detalles de configuración del protocolo). Para una explicación
> más amigable y sencilla, cambia la app al modo **Básico** — abre
> Configuración (icono del engranaje en la esquina superior derecha)
> → **Modo** → **Básico**. Los enlaces "Aprender más" (i) dentro de
> la app abrirán entonces la guía Básica.

---

## Dashboard

<a id="dashboard.your-escrow"></a>

### Tu Escrow

Un proxy UUPS-actualizable por usuario (`VaipakamEscrowImplementation`
detrás de un `ERC1967Proxy`) desplegado para ti la primera vez que
participes en un préstamo. Un escrow por dirección por cadena.
Mantiene saldos ERC-20, ERC-721 y ERC-1155 vinculados a tus
posiciones de préstamo. No hay mezcla de fondos —los activos de
otros usuarios nunca están en este contrato.

El proxy de escrow es el lugar canónico donde residen el colateral,
los activos prestados y el VPFI bloqueado. El Diamond se autentica
contra él en cada depósito/retiro; la implementación es
actualizable por el dueño del protocolo con un timelock.

<a id="dashboard.your-loans"></a>

### Tus préstamos

Cada préstamo que involucra a la billetera conectada en esta cadena
—ya estés del lado prestamista, del lado prestatario, o ambos en
posiciones distintas. Calculado en vivo a partir de los selectores
de vista del `LoanFacet` del Diamond contra tu dirección. Cada fila
enlaza a la página de posición completa con HF, LTV, interés
acumulado, la superficie de acciones limitada por tu rol + el
estado del préstamo, y el `loanId` on-chain que puedes pegar en un
explorador de bloques.

<a id="dashboard.vpfi-panel"></a>

### VPFI en esta cadena

Contabilidad VPFI en vivo para la billetera conectada en la cadena
activa:

- Saldo en billetera (leído del ERC-20).
- Saldo en escrow (leído del proxy de escrow del usuario).
- Tu cuota del suministro circulante (después de restar saldos en
  poder del protocolo).
- Tope de minteo restante.

Vaipakam transporta VPFI cross-chain sobre LayerZero V2. **Base es
la cadena canónica** —`VPFIOFTAdapter` ejecuta allí la semántica
lock/release. Cualquier otra cadena soportada corre `VPFIMirror`,
un OFT puro que mintea en paquetes entrantes y quema en salientes.
El suministro total a través de todas las cadenas es invariante
bajo bridging por construcción.

La política DVN es **3 requeridos + 2 opcionales, umbral 1-de-2**
tras el endurecimiento de abril de 2026 (ver `CLAUDE.md`
"Cross-Chain Security Policy"). La configuración DVN 1/1 por
defecto es rechazada en el gate de despliegue.

<a id="dashboard.fee-discount-consent"></a>

### Consentimiento de descuento en comisiones

Bandera de opt-in a nivel de billetera
(`VPFIDiscountFacet.toggleVPFIDiscountConsent`) que permite al
protocolo liquidar la porción descontada de una comisión en VPFI
debitado de tu escrow en eventos terminales. Por defecto:
desactivado. Desactivado significa que pagas el 100% de cada
comisión en el activo principal; activado significa que se aplica
el descuento ponderado por tiempo.

Escalera de tiers (`VPFI_TIER_TABLE`):

| Tier | VPFI mínimo en escrow | Descuento |
| ---- | --------------------- | --------- |
| 1    | ≥ 100                 | 10%       |
| 2    | ≥ 1,000               | 15%       |
| 3    | ≥ 5,000               | 20%       |
| 4    | > 20,000              | 24%       |

El tier se calcula contra el saldo de escrow **post-mutación** vía
`LibVPFIDiscount.rollupUserDiscount`, y luego se pondera por tiempo
a lo largo de la vida útil de cada préstamo. Un unstake re-estampa
los BPS al nuevo saldo más bajo inmediatamente para cada préstamo
abierto en el que estés (cierra el vector de gameo donde el código
pre-Phase-5 estampaba al saldo pre-mutación).

El descuento aplica a la yield-fee del prestamista en el momento de
la liquidación y a la Loan Initiation Fee del prestatario (entregada
como un reembolso de VPFI junto con `claimAsBorrower`). Ver
`TokenomicsTechSpec.md` §5.2b y §6.

---

## Libro de ofertas

<a id="offer-book.filters"></a>

### Filtros

Filtros del lado cliente sobre las listas de ofertas de
prestamista / prestatario. Filtra por dirección de activo, lado,
estado y algunos otros ejes. Los filtros no afectan a "Tus ofertas
activas" —esa lista siempre se muestra completa.

<a id="offer-book.your-active-offers"></a>

### Tus ofertas activas

Ofertas abiertas (estado = Active, expiración aún no alcanzada)
donde `creator == tu dirección`. Cancelables en cualquier momento
antes de la aceptación vía `OfferFacet.cancelOffer(offerId)`. La
aceptación pasa el estado de la oferta a `Accepted` y dispara
`LoanFacet.initiateLoan`, que mintea los dos NFTs de posición (uno
para el prestamista y otro para el prestatario) y abre el préstamo
en estado `Active`.

<a id="offer-book.lender-offers"></a>

### Ofertas de prestamistas

Ofertas activas donde el creador está dispuesto a prestar. La
aceptación la realiza un prestatario; se enruta vía
`OfferFacet.acceptOffer` → `LoanFacet.initiateLoan`. Gate rígido en
el Diamond: `MIN_HEALTH_FACTOR = 1.5e18` se aplica en la
inicialización contra la canasta de colateral del prestatario
usando la matemática de LTV/HF de `RiskFacet`. El 1% de tesorería
sobre los intereses (`TREASURY_FEE_BPS = 100`) se debita en la
liquidación terminal, no por adelantado.

<a id="offer-book.borrower-offers"></a>

### Ofertas de prestatarios

Ofertas activas de prestatarios que ya bloquearon su colateral en
escrow. La aceptación la realiza un prestamista; financia el
préstamo con el activo principal y mintea los NFTs de posición. Mismo
gate de HF ≥ 1.5 en la inicialización. La APR fija se establece en la
oferta al crearse y es inmutable durante toda la vida del préstamo
—el refinance crea un préstamo nuevo.

---

## Crear oferta

<a id="create-offer.offer-type"></a>

### Tipo de oferta

Selecciona en qué lado de la oferta está el creador:

- **Lender** — `OfferFacet.createLenderOffer`. El prestamista aporta
  el activo principal y una especificación de colateral que el
  prestatario debe cumplir.
- **Borrower** — `OfferFacet.createBorrowerOffer`. El prestatario
  bloquea el colateral por adelantado; un prestamista acepta y
  financia.
- Sub-tipo **Rental** — para NFTs ERC-4907 (ERC-721 alquilable) y
  ERC-1155 alquilables. Se enruta por el flujo de alquiler en lugar
  de un préstamo de deuda; el arrendatario pre-paga
  `duration × dailyFee × (1 + RENTAL_BUFFER_BPS / 1e4)` donde
  `RENTAL_BUFFER_BPS = 500`.

<a id="create-offer.lending-asset"></a>

### Activo prestado

Especifica `(asset, amount, aprBps, durationDays)` para una oferta
de deuda:

- `asset` — dirección del contrato ERC-20.
- `amount` — principal, denominado en los decimales nativos del
  activo.
- `aprBps` — APR fija en basis points (1/10,000). Snapshot al
  aceptar; no reactiva.
- `durationDays` — fija la ventana de gracia antes de que
  `DefaultedFacet.markDefaulted` sea invocable.

El interés acumulado se calcula continuamente por segundo desde
`loan.startTimestamp` hasta la liquidación terminal.

<a id="create-offer.lending-asset:lender"></a>

#### Si eres el prestamista

El activo principal y el monto que estás dispuesto a ofrecer, además
de la tasa de interés (APR en %) y la duración en días. La tasa se
fija al momento de la oferta; la duración determina la ventana de
gracia antes de que el préstamo pueda entrar en default. Se enruta
vía `OfferFacet.createLenderOffer`; en la aceptación, el principal
se mueve de tu escrow al escrow del prestatario como parte de
`LoanFacet.initiateLoan`.

<a id="create-offer.lending-asset:borrower"></a>

#### Si eres el prestatario

El activo principal y el monto que quieres del prestamista, además
de la tasa de interés (APR en %) y la duración en días. La tasa se
fija al momento de la oferta; la duración determina la ventana de
gracia antes de que el préstamo pueda entrar en default. Se enruta
vía `OfferFacet.createBorrowerOffer`; tu colateral queda bloqueado
en tu escrow al momento de la creación de la oferta y permanece
bloqueado hasta que un prestamista acepte y se abra el préstamo (o
hasta que canceles).

<a id="create-offer.nft-details"></a>

### Detalles del NFT

Campos del sub-tipo Rental. Especifica el contrato del NFT + token
id (y cantidad para ERC-1155), además de `dailyFeeAmount` en el
activo principal. En la aceptación, `OfferFacet` debita
`duration × dailyFeeAmount × (1 + 500 / 10_000)` desde el escrow del
arrendatario hacia custodia; el NFT mismo pasa a un estado delegado
vía el `setUser` de ERC-4907 (o el hook equivalente de ERC-1155),
de modo que el arrendatario tiene derechos pero no puede transferir
el NFT.

<a id="create-offer.collateral"></a>

### Colateral

Especificación del activo de colateral en la oferta. Dos clases de
liquidez:

- **Líquido** — feed de precio de Chainlink registrado + ≥ 1 de las
  3 factorías V3-clone (Uniswap, PancakeSwap, SushiSwap) devuelve un
  pool con ≥ $1M de profundidad en el tick actual (3-V3-clone
  OR-logic, Phase 7b.1). Aplica matemática de LTV/HF; la liquidación
  basada en HF se enruta vía `RiskFacet → LibSwap` (failover de 4
  DEX: 0x → 1inch → Uniswap V3 → Balancer V2).
- **Ilíquido** — cualquier cosa que falle lo anterior. Valorado en
  $0 on-chain. Sin matemática de HF. En default, transferencia
  íntegra de colateral al prestamista. Tanto prestamista como
  prestatario deben hacer `acceptIlliquidCollateralRisk` en la
  creación / aceptación de la oferta para que la oferta entre.

Quórum de oráculo de precio secundario (Phase 7b.2): Tellor + API3

- DIA, regla de decisión soft 2-de-N. Pyth removido.

<a id="create-offer.collateral:lender"></a>

#### Si eres el prestamista

Cuánto quieres que el prestatario bloquee para asegurar el préstamo.
Los ERC-20 líquidos (feed de Chainlink + ≥$1M de profundidad en pool
v3) entran en la matemática de LTV/HF; los ERC-20 ilíquidos y los
NFTs no tienen valoración on-chain y requieren que ambas partes
consientan a un escenario de colateral-completo-en-default. El gate
de HF ≥ 1.5e18 en `LoanFacet.initiateLoan` se calcula contra la
canasta de colateral que el prestatario presenta en la aceptación
—dimensionar el requisito aquí fija directamente el headroom de HF
del prestatario.

<a id="create-offer.collateral:borrower"></a>

#### Si eres el prestatario

Cuánto estás dispuesto a bloquear para asegurar el préstamo. Los
ERC-20 líquidos (feed de Chainlink + ≥$1M de profundidad en pool v3)
entran en la matemática de LTV/HF; los ERC-20 ilíquidos y los NFTs
no tienen valoración on-chain y requieren que ambas partes
consientan a un escenario de colateral-completo-en-default. Tu
colateral se bloquea en tu escrow al momento de la creación de la
oferta en una oferta de prestatario; en una oferta de prestamista,
tu colateral se bloquea en el momento de la aceptación. En cualquier
caso, el gate de HF ≥ 1.5e18 en `LoanFacet.initiateLoan` debe
liberarse con la canasta que presentes.

<a id="create-offer.risk-disclosures"></a>

### Divulgaciones de riesgo

Gate de reconocimiento antes de enviar. La misma superficie de
riesgo aplica a ambos lados; las pestañas específicas por rol
explican cómo cada uno golpea distinto dependiendo de qué lado de
la oferta firmas. Vaipakam es no-custodial; no hay clave admin que
pueda revertir una transacción ya enviada. Existen palancas de
pause sólo en contratos cara-a-LZ, limitadas al timelock; no pueden
mover activos.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si eres el prestamista

- **Riesgo de smart contract** — código inmutable en runtime;
  auditado pero no formalmente verificado.
- **Riesgo de oráculo** — la obsolescencia de Chainlink o la
  divergencia en la profundidad de los pools V3 puede demorar una
  liquidación basada en HF más allá del punto donde el colateral
  cubre el principal. El quórum secundario (Tellor + API3 + DIA,
  Soft 2-de-N) atrapa derivas grandes pero un sesgo pequeño aún
  puede erosionar la recuperación.
- **Slippage de liquidación** — el failover de 4 DEX de `LibSwap`
  (0x → 1inch → Uniswap V3 → Balancer V2) enruta a la mejor
  ejecución que pueda encontrar, pero no puede garantizar un precio
  específico. La recuperación es neta de slippage y del 1% de
  tesorería sobre intereses.
- **Defaults con colateral ilíquido** — el colateral se transfiere
  íntegro a ti en el momento de `markDefaulted`. Sin recurso si el
  activo vale menos que `principal + accruedInterest()`.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si eres el prestatario

- **Riesgo de smart contract** — código inmutable en runtime; los
  bugs afectan al colateral bloqueado.
- **Riesgo de oráculo** — la obsolescencia o manipulación puede
  disparar una liquidación basada en HF en tu contra cuando el
  precio real de mercado se hubiera mantenido seguro. La fórmula de
  HF es reactiva a la salida del oráculo; un único tick malo
  cruzando 1.0 es suficiente.
- **Slippage de liquidación** — cuando se dispara `RiskFacet →
LibSwap`, el swap puede vender tu colateral a precios mermados por
  slippage. El swap es permissionless —cualquiera puede dispararlo
  en el instante en que HF < 1e18.
- **Defaults con colateral ilíquido** — `markDefaulted` transfiere
  todo tu colateral al prestamista. Sin reclamación residual —sólo
  cualquier reembolso de VPFI LIF no usado vía `claimAsBorrower`.

<a id="create-offer.advanced-options"></a>

### Opciones avanzadas

Ajustes menos comunes:

- `expiryTimestamp` — la oferta se auto-cancela tras esto. Por
  defecto ~7 días.
- `useFeeDiscountForThisOffer` — override local del consentimiento a
  nivel de billetera para esta oferta específica.
- Opciones específicas por rol que el OfferFacet expone por lado.

Los valores por defecto son sensatos para la mayoría de usuarios.

---

## Centro de reclamaciones

<a id="claim-center.claims"></a>

### Fondos reclamables

Las reclamaciones son de tipo pull por diseño —los eventos
terminales dejan los fondos en custodia del Diamond / escrow y el
poseedor del NFT de posición llama a `claimAsLender` /
`claimAsBorrower` para moverlos. Ambos tipos de reclamación pueden
estar en la misma billetera al mismo tiempo. Las pestañas
específicas por rol describen cada uno.

Cada reclamación quema el NFT de posición del poseedor de forma
atómica. El NFT _es_ el instrumento al portador —transferirlo antes
de reclamar le da al nuevo poseedor el derecho a cobrar.

<a id="claim-center.claims:lender"></a>

#### Si eres el prestamista

`ClaimFacet.claimAsLender(loanId)` devuelve:

- `principal` de vuelta a tu billetera en esta cadena.
- `accruedInterest(loan)` menos el 1% de tesorería
  (`TREASURY_FEE_BPS = 100`) —ese corte se reduce a su vez por tu
  acumulador de descuento de comisiones VPFI ponderado por tiempo
  (Phase 5) cuando el consentimiento está activado.

Reclamable apenas el préstamo alcanza un estado terminal (Settled,
Defaulted o Liquidated). El NFT de posición de prestamista se
quema en la misma transacción.

<a id="claim-center.claims:borrower"></a>

#### Si eres el prestatario

`ClaimFacet.claimAsBorrower(loanId)` devuelve, dependiendo de cómo
se liquidó el préstamo:

- **Repago total / preclose / refinance** — tu canasta de
  colateral de vuelta, más el reembolso de VPFI ponderado por tiempo
  de la LIF (`s.borrowerLifRebate[loanId].rebateAmount`).
- **Liquidación por HF o default** — sólo el reembolso de VPFI LIF
  no usado (que en estos caminos terminales es cero a menos que se
  preserve explícitamente). El colateral ya se movió al prestamista.

El NFT de posición de prestatario se quema en la misma transacción.

---

## Actividad

<a id="activity.feed"></a>

### Feed de actividad

Eventos on-chain que involucran a tu billetera en la cadena activa,
obtenidos en vivo de los logs del Diamond (`getLogs` sobre una
ventana deslizante de bloques). Sin caché de backend —cada carga
re-fetchea. Los eventos se agrupan por `transactionHash` para que
las txns multi-evento (p. ej. accept + initiate) se mantengan
juntas. Los más nuevos primero. Surfacea ofertas, préstamos,
repagos, reclamaciones, liquidaciones, mints/burns de NFT y
compras / stakes / unstakes de VPFI.

---

## Comprar VPFI

<a id="buy-vpfi.overview"></a>

### Comprando VPFI

Dos caminos:

- **Canónico (Base)** — llamada directa a
  `VPFIBuyFacet.buyVPFIWithETH` en el Diamond. Mintea VPFI
  directamente a tu billetera en Base.
- **No canónico** — `VPFIBuyAdapter.buy()` en la cadena local envía
  un paquete de LayerZero a `VPFIBuyReceiver` en Base, que llama al
  Diamond y OFT-envía el resultado de regreso. Latencia
  end-to-end ~1 min en pares L2-a-L2. El VPFI llega a tu billetera
  en la cadena de **origen**.

Límites de tasa del adapter (post-endurecimiento): 50k VPFI por
solicitud, 500k rolling 24h. Ajustable vía `setRateLimits`
(timelock).

<a id="buy-vpfi.discount-status"></a>

### Tu estado de descuento VPFI

Estado en vivo:

- Tier actual (0..4, de
  `VPFIDiscountFacet.getVPFIDiscountTier`).
- Saldo de VPFI en escrow + delta al siguiente tier.
- Descuento BPS en el tier actual.
- Bandera de consentimiento a nivel de billetera.

Nota que el VPFI en escrow también acumula 5% APR vía el pool de
staking —no hay acción separada de "stake"; depositar al escrow es
hacer staking.

<a id="buy-vpfi.buy"></a>

### Paso 1 — Compra VPFI con ETH

Envía la compra. En cadenas canónicas, el Diamond mintea
directamente. En cadenas espejo, el adapter de compra recibe el
pago, envía un mensaje LZ, y el receiver ejecuta la compra en Base

- OFT-envía VPFI de vuelta. La fee del puente + costo DVN se
  cotiza en vivo por `useVPFIBuyBridge.quote()` y se muestra en el
  formulario. El VPFI no se auto-deposita en escrow —el Paso 2 es
  explícito.

<a id="buy-vpfi.deposit"></a>

### Paso 2 — Deposita VPFI en tu escrow

`Diamond.depositVPFIToEscrow(amount)`. Requerido en cada cadena
—incluso canónica— porque el depósito en escrow siempre es una
acción explícita del usuario por especificación. En cadenas con
Permit2 (Phase 8b), la app prefiere el camino de firma única
(`depositVPFIToEscrowWithPermit2`) sobre approve + deposit. Cae con
elegancia si Permit2 no está configurado en esa cadena.

<a id="buy-vpfi.unstake"></a>

### Paso 3 — Saca VPFI del staking en tu escrow

`Diamond.withdrawVPFIFromEscrow(amount)`. Sin etapa de aprobación
—el Diamond es dueño del proxy de escrow y se debita a sí mismo.
La llamada de retiro dispara `LibVPFIDiscount.rollupUserDiscount(user,
postBalance)` para que el acumulador BPS de cada préstamo abierto
se re-estampe al nuevo (más bajo) saldo inmediatamente. No hay
ventana de gracia donde aún aplique el tier viejo.

---

## Recompensas

<a id="rewards.overview"></a>

### Sobre las recompensas

Dos flujos:

- **Pool de staking** — el VPFI en escrow acumula al 5% APR
  continuamente. Capitalización por segundo vía
  `RewardFacet.pendingStaking`.
- **Pool de interacción** — cuota diaria pro-rata de una emisión
  diaria fija, ponderada por tu contribución de intereses
  liquidados al volumen de préstamos de ese día. Las ventanas
  diarias se finalizan de forma lazy en la primera reclamación
  después del cierre de ventana.

Ambas recompensas se mintean directamente en la cadena activa (sin
round-trip LZ para el usuario; la agregación cross-chain de
recompensas ocurre en `VaipakamRewardOApp` sólo entre contratos
del protocolo).

<a id="rewards.claim"></a>

### Reclamar recompensas

`RewardFacet.claimRewards()` —tx única, reclama ambos flujos. El
staking siempre está disponible; la interacción es `0n` hasta que
la ventana diaria relevante se finalice (finalización lazy
disparada por la siguiente reclamación o liquidación no-cero en
esa cadena). La UI bloquea el botón cuando
`interactionWaitingForFinalization` para que los usuarios no
reclamen de menos.

<a id="rewards.withdraw-staked"></a>

### Retirar VPFI stakeado

Superficie idéntica al "Paso 3 — Unstake" en la página Comprar
VPFI —`withdrawVPFIFromEscrow`. El VPFI retirado sale del pool de
staking inmediatamente (las recompensas dejan de acumularse para
ese monto en ese bloque) y sale del acumulador de descuento
inmediatamente (re-estampado del saldo post en cada préstamo
abierto).

---

## Detalles del préstamo

<a id="loan-details.overview"></a>

### Detalles del préstamo (esta página)

Vista de un único préstamo derivada de
`LoanFacet.getLoanDetails(loanId)` más HF/LTV en vivo de
`RiskFacet.calculateHealthFactor`. Renderiza términos, riesgo de
colateral, partes, la superficie de acciones limitada por
`getLoanActionAvailability(loan, viewerAddress)`, y estado de
keeper en línea desde `useKeeperStatus`.

<a id="loan-details.terms"></a>

### Términos del préstamo

Partes inmutables del préstamo:

- `principal` (activo + monto).
- `aprBps` (fijado en la creación de la oferta).
- `durationDays`.
- `startTimestamp`, `endTimestamp` (= `startTimestamp +
durationDays * 1 days`).
- `accruedInterest()` —función view, calcula desde `now -
startTimestamp`.

El refinance crea un `loanId` nuevo en lugar de mutar éstos.

<a id="loan-details.collateral-risk"></a>

### Colateral y riesgo

Matemática de riesgo en vivo vía `RiskFacet`. **Health Factor** es
`(collateralUsdValue × liquidationThresholdBps / 1e4) /
debtUsdValue`, escalado a 1e18. HF < 1e18 dispara la liquidación
basada en HF. **LTV** es `debtUsdValue / collateralUsdValue`. El
umbral de liquidación = el LTV en el que la posición se vuelve
liquidable; depende de la clase de volatilidad de la canasta de
colateral (`VOLATILITY_LTV_THRESHOLD_BPS = 11000` para el caso de
colapso de alta volatilidad).

El colateral ilíquido tiene `usdValue == 0` on-chain; HF/LTV
colapsan a n/a y el único camino terminal es la transferencia
completa en default —ambas partes consintieron en la creación de
la oferta vía el reconocimiento de riesgo de iliquidez.

<a id="loan-details.collateral-risk:lender"></a>

#### Si eres el prestamista

La canasta de colateral que asegura este préstamo es tu protección.
HF > 1e18 significa que la posición está sobre-colateralizada vs. el
umbral de liquidación. A medida que HF deriva hacia 1e18, tu
protección se adelgaza; una vez que HF < 1e18, cualquiera (tú
incluido) puede llamar a `RiskFacet.triggerLiquidation(loanId)` y
`LibSwap` enrutará el colateral por el failover de 4 DEX para tu
activo principal. La recuperación es neta de slippage.

Para colateral ilíquido, en default la canasta se transfiere
íntegra a ti en el momento de `markDefaulted` —cuánto vale en
realidad es problema tuyo.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si eres el prestatario

Tu colateral bloqueado. Mantén HF cómodamente por encima de 1e18 —
el objetivo común de buffer es ≥ 1.5e18 para aguantar volatilidad.
Palancas para subir HF:

- `addCollateral(loanId, …)` —recargar la canasta; sólo usuario.
- Repago parcial vía `RepayFacet` —reduce deuda, sube HF.

Una vez que HF < 1e18, cualquiera puede disparar la liquidación
basada en HF; el swap vende tu colateral a precios mermados por
slippage para repagar al prestamista. Sobre colateral ilíquido, el
default transfiere todo tu colateral al prestamista —sólo queda por
reclamar cualquier reembolso de VPFI LIF no usado
(`s.borrowerLifRebate[loanId].rebateAmount`).

<a id="loan-details.parties"></a>

### Partes

`(lender, borrower, lenderEscrow, borrowerEscrow,
positionNftLender, positionNftBorrower)`. Cada NFT es un ERC-721
con metadatos on-chain; transferirlo transfiere el derecho a
reclamar. Los proxies de escrow son determinísticos por dirección
(CREATE2) —misma dirección entre despliegues.

<a id="loan-details.actions"></a>

### Acciones

Superficie de acciones, limitada por rol vía
`getLoanActionAvailability`. Las pestañas específicas por rol
listadas abajo enumeran los selectores disponibles de cada lado.
Las acciones deshabilitadas surfacean una razón en hover derivada
del gate (`InsufficientHF`, `NotYetExpired`, `LoanLocked`, etc.).

Acciones permissionless disponibles para cualquiera independiente
del rol:

- `RiskFacet.triggerLiquidation(loanId)` —cuando HF < 1e18.
- `DefaultedFacet.markDefaulted(loanId)` —cuando el periodo de
  gracia ha expirado sin repago total.

<a id="loan-details.actions:lender"></a>

#### Si eres el prestamista

- `ClaimFacet.claimAsLender(loanId)` —sólo terminal. Devuelve
  principal + intereses menos el 1% de tesorería (reducido aún
  más por tu descuento de yield-fee VPFI ponderado por tiempo
  cuando el consentimiento está activado). Quema el NFT de
  posición de prestamista.
- `EarlyWithdrawalFacet.initEarlyWithdrawal(loanId, askPrice)` —
  pone el NFT de prestamista a la venta a `askPrice`. Un comprador
  llamando a `completeEarlyWithdrawal(saleId)` se hace cargo de tu
  lado; recibes lo recaudado. Cancelable antes del llenado.
- Opcionalmente delegable a un keeper que tenga el bit de acción
  relevante (`COMPLETE_LOAN_SALE`, etc.) —ver Configuración de
  keepers.

<a id="loan-details.actions:borrower"></a>

#### Si eres el prestatario

- `RepayFacet.repay(loanId, amount)` —total o parcial. El parcial
  reduce el saldo pendiente y sube HF; el total dispara la
  liquidación terminal, incluyendo el reembolso de VPFI LIF
  ponderado por tiempo vía
  `LibVPFIDiscount.settleBorrowerLifProper`.
- `PrecloseFacet.precloseDirect(loanId)` —paga el saldo pendiente
  desde tu billetera ahora, libera colateral, liquida el reembolso
  LIF.
- `PrecloseFacet.initOffset(loanId, swapParams)` /
  `completeOffset(loanId)` —vende parte del colateral vía
  `LibSwap`, repaga con lo recibido, devuelve el remanente.
- Flujo `RefinanceFacet` —publica una oferta de prestatario con
  nuevos términos; `completeRefinance(oldLoanId, newOfferId)`
  intercambia préstamos atómicamente sin que el colateral salga
  del escrow.
- `ClaimFacet.claimAsBorrower(loanId)` —sólo terminal. Devuelve
  el colateral en repago total, o el reembolso de VPFI LIF no
  usado en default / liquidación. Quema el NFT de posición de
  prestatario.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Lista cada `allowance(wallet, diamondAddress)` ERC-20 que tu
billetera ha otorgado al Diamond en esta cadena. Obtenida
escaneando una lista candidata de tokens contra llamadas view de
`IERC20.allowance`. La revocación pone el allowance a cero vía
`IERC20.approve(diamond, 0)`. Conforme a la política de aprobación
de monto exacto, el protocolo nunca pide allowances ilimitados, así
que las revocaciones suelen ser pocas en cantidad.

Nota: los flujos al estilo Permit2 (Phase 8b) bypassean el
allowance por activo en el Diamond usando una sola firma en su
lugar, así que una lista limpia aquí no impide depósitos futuros.

---

## Alertas

<a id="alerts.overview"></a>

### Sobre las alertas

Worker de Cloudflare off-chain (`hf-watcher`) sondea cada préstamo
activo que involucra a tu billetera con una cadencia de 5 minutos.
Lee `RiskFacet.calculateHealthFactor` para cada uno. Al cruzar una
banda en dirección insegura, dispara una vez vía los canales
configurados. Sin estado on-chain, sin gas. Las alertas son
informativas —no mueven fondos.

<a id="alerts.threshold-ladder"></a>

### Escalera de umbrales

Escalera de bandas de HF configurada por el usuario. Cruzar a una
banda más peligrosa dispara una vez y arma el siguiente umbral más
profundo. Cruzar de vuelta por encima de una banda la rearma. Por
defecto: `1.5 → 1.3 → 1.1`. Números más altos son apropiados para
colateral volátil; el único trabajo de la escalera es sacarte
antes de que HF < 1e18 dispare la liquidación.

<a id="alerts.delivery-channels"></a>

### Canales de envío

Dos canales:

- **Telegram** — DM de bot con la dirección corta de la billetera
  - loan id + HF actual.
- **Push Protocol** — notificación directa a la billetera vía el
  canal Vaipakam Push.

Ambos comparten la escalera de umbrales; los warn-levels por canal
no se exponen intencionalmente (para evitar deriva). La publicación
del canal Push está stub-ed pendiente de la creación del canal —
ver notas de Phase 8a.

---

## Verificador de NFTs

<a id="nft-verifier.lookup"></a>

### Verificar un NFT

Dado `(nftAddress, tokenId)`, fetchea:

- `IERC721.ownerOf(tokenId)` (o burn-selector `0x7e273289` =>
  ya quemado).
- `IERC721.tokenURI(tokenId)` → metadatos JSON on-chain.
- Cross-check del Diamond: deriva el `loanId` subyacente desde los
  metadatos y lee `LoanFacet.getLoanDetails(loanId)` para
  confirmar el estado.

Surfacea: ¿minteado por Vaipakam? ¿qué cadena? ¿estado del
préstamo? ¿poseedor actual? Te permite detectar una falsificación,
una posición ya reclamada (quemada), o una posición cuyo préstamo
se liquidó y está mid-claim.

El NFT de posición es el instrumento al portador —verifica antes
de comprar en un mercado secundario.

---

## Configuración de keepers

<a id="keeper-settings.overview"></a>

### Sobre los keepers

Whitelist de keepers por billetera (`KeeperSettingsFacet`) de hasta
5 keepers (`MAX_KEEPERS = 5`). Cada keeper tiene un bitmask de
acciones (`KEEPER_ACTION_*`) autorizando llamadas específicas de
mantenimiento sobre **tu lado** de un préstamo. Los caminos de
salida-de-dinero (repay, claim, addCollateral, liquidate) son sólo
de usuario por diseño y no pueden delegarse.

Aplican dos gates adicionales en el momento de la acción:

1. Interruptor maestro de acceso a keepers (freno de emergencia de
   un solo flip; deshabilita a todos los keepers sin tocar la
   allowlist).
2. Toggle de opt-in por préstamo (configurado en Libro de ofertas /
   Detalles del préstamo).

Un keeper puede actuar sólo cuando `(approved, masterOn, perLoanOn,
actionBitSet)` son todos true.

<a id="keeper-settings.approved-list"></a>

### Keepers aprobados

Banderas de bitmask actualmente expuestas:

- `COMPLETE_LOAN_SALE` (0x01)
- `COMPLETE_OFFSET` (0x02)
- `INIT_EARLY_WITHDRAW` (0x04)
- `INIT_PRECLOSE` (0x08)
- `REFINANCE` (0x10)

Bits añadidos on-chain sin que el frontend los refleje obtienen un
revert `InvalidKeeperActions`. La revocación es
`KeeperSettingsFacet.removeKeeper(addr)` y es instantánea en todos
los préstamos.

---

## Dashboard de analítica pública

<a id="public-dashboard.overview"></a>

### Sobre la analítica pública

Agregador sin necesidad de billetera, calculado en vivo a partir
de llamadas view del Diamond on-chain a través de cada cadena
soportada. Sin backend / base de datos. Hooks involucrados:
`useProtocolStats`, `useTVL`, `useTreasuryMetrics`, `useUserStats`,
`useVPFIToken`. Disponible exportación CSV / JSON; la dirección
del Diamond + función view de cada métrica se muestra para fines
de verificabilidad.

<a id="public-dashboard.combined"></a>

### Combinado — Todas las cadenas

Rollup cross-chain. La cabecera reporta `chainsCovered` y
`chainsErrored` para que un RPC inalcanzable en el momento del
fetch sea explícito. `chainsErrored > 0` significa que la tabla
por-cadena marca cuál —los totales de TVL aún se reportan pero
reconocen el hueco.

<a id="public-dashboard.per-chain"></a>

### Desglose por cadena

División por cadena de las métricas combinadas. Útil para detectar
concentración de TVL, suministros de espejos VPFI desemparejados
(la suma debería igualar el saldo bloqueado del adapter canónico),
o cadenas estancadas.

<a id="public-dashboard.vpfi-transparency"></a>

### Transparencia del token VPFI

Contabilidad VPFI on-chain en la cadena activa:

- `totalSupply()` — nativo de ERC-20.
- Suministro circulante — `totalSupply()` menos saldos en poder
  del protocolo (tesorería, pools de recompensas, paquetes LZ
  in-flight).
- Tope de minteo restante — derivado de `MAX_SUPPLY -
totalSupply()` en canónica; las cadenas espejo reportan `n/a` para
  el tope (los mints allí son impulsados por puente).

Invariante cross-chain: la suma de `VPFIMirror.totalSupply()` a
través de todas las cadenas espejo == `VPFIOFTAdapter.lockedBalance()`
en canónica. El watcher monitorea y alerta sobre deriva.

<a id="public-dashboard.transparency"></a>

### Transparencia y fuente

Para cada métrica, lista:

- El número de bloque usado como snapshot.
- Frescura de los datos (staleness máximo entre cadenas).
- La dirección del Diamond y la llamada de función view.

Cualquiera puede re-derivar cualquier número de esta página desde
`(rpcUrl, blockNumber, diamondAddress, fnName)` —ese es el listón.

---

## Refinanciar

Esta página es sólo para prestatarios —el refinance lo inicia el
prestatario sobre el préstamo del prestatario.

<a id="refinance.overview"></a>

### Sobre refinanciar

`RefinanceFacet` —paga atómicamente tu préstamo existente desde un
principal nuevo y abre un préstamo fresco con los nuevos términos,
todo en una tx. El colateral se queda en tu escrow en todo momento
—sin ventana sin garantizar. El nuevo préstamo debe pasar
`MIN_HEALTH_FACTOR = 1.5e18` en la inicialización igual que
cualquier otro préstamo.

Se llama a `LibVPFIDiscount.settleBorrowerLifProper(oldLoan)` sobre
el préstamo viejo como parte del intercambio, así que cualquier
reembolso de VPFI LIF no usado se acredita correctamente.

<a id="refinance.position-summary"></a>

### Tu posición actual

Snapshot del préstamo siendo refinanciado —`loan.principal`,
`accruedInterest()` actual, HF/LTV, canasta de colateral. La nueva
oferta debería dimensionarse al menos al pendiente (`principal +
accruedInterest()`); cualquier excedente en la nueva oferta se
entrega a tu escrow como principal libre.

<a id="refinance.step-1-post-offer"></a>

### Paso 1 — Publica la nueva oferta

Publica una oferta de prestatario vía
`OfferFacet.createBorrowerOffer` con tus términos objetivo. El
préstamo viejo sigue acumulando intereses; el colateral permanece
bloqueado. La oferta aparece en el Libro de ofertas público y
cualquier prestamista puede aceptarla. Puedes cancelar antes de la
aceptación.

<a id="refinance.step-2-complete"></a>

### Paso 2 — Completar

`RefinanceFacet.completeRefinance(oldLoanId, newOfferId)` —atómico:

1. Financia el préstamo nuevo desde el prestamista que acepta.
2. Repaga el préstamo viejo en su totalidad (principal + intereses,
   menos el corte de tesorería).
3. Quema los NFTs de posición viejos.
4. Mintea los NFTs de posición nuevos.
5. Liquida el reembolso LIF del préstamo viejo vía
   `LibVPFIDiscount.settleBorrowerLifProper`.

Revierte si HF < 1.5e18 sobre los nuevos términos.

---

## Cierre anticipado

Esta página es sólo para prestatarios —el preclose lo inicia el
prestatario sobre el préstamo del prestatario.

<a id="preclose.overview"></a>

### Sobre el preclose

`PrecloseFacet` —terminación anticipada impulsada por el
prestatario. Dos caminos:

- **Directo** — `precloseDirect(loanId)`. Paga
  `principal + accruedInterest()` desde tu billetera, libera
  colateral. Invoca
  `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
- **Offset** — `initOffset(loanId, swapParams)` luego
  `completeOffset(loanId)`. Vende parte del colateral vía
  `LibSwap` (failover de 4 DEX) por el activo principal, repaga
  con lo recibido, el remanente del colateral te vuelve. Misma
  liquidación de reembolso LIF.

Sin penalización fija de cierre anticipado. La matemática VPFI
ponderada por tiempo de Phase 5 maneja la matemática de equidad.

<a id="preclose.position-summary"></a>

### Tu posición actual

Snapshot del préstamo siendo precerrado —principal pendiente,
intereses acumulados, HF/LTV actuales. El flujo de preclose **no**
requiere HF ≥ 1.5e18 al salir (es un cierre, no una re-init).

<a id="preclose.in-progress"></a>

### Offset en progreso

Estado: `initOffset` aterrizó, el swap está en mid-execution (o la
cotización fue consumida pero el settle final está pendiente). Dos
salidas:

- `completeOffset(loanId)` —liquida el préstamo desde lo recaudado,
  devuelve remanente.
- `cancelOffset(loanId)` —aborta; el colateral queda bloqueado, el
  préstamo sin cambios. Úsalo cuando el swap se movió contra ti
  entre init y complete.

<a id="preclose.choose-path"></a>

### Elige un camino

El camino directo consume liquidez de billetera en el activo
principal. El camino offset consume colateral vía swap en DEX;
preferido cuando no tienes el activo principal a la mano o cuando
quieres salir también de la posición de colateral. El slippage del
offset se enruta vía el failover de 4 DEX de `LibSwap` (0x →
1inch → Uniswap V3 → Balancer V2).

---

## Retiro anticipado (prestamista)

Esta página es sólo para prestamistas —el retiro anticipado lo
inicia el prestamista sobre su préstamo.

<a id="early-withdrawal.overview"></a>

### Sobre la salida anticipada del prestamista

`EarlyWithdrawalFacet` —mecanismo de mercado secundario para
posiciones de prestamista. Pones a la venta tu NFT de posición a
un precio elegido; en la aceptación, el comprador paga, la
propiedad del NFT de prestamista se transfiere al comprador, y el
comprador se convierte en el prestamista de registro para toda
liquidación futura (claim al final, etc.). Tú te vas con lo
recaudado por la venta.

Las liquidaciones siguen siendo sólo de usuario y NO se delegan a
través de la venta —sólo se transfiere el derecho a reclamar.

<a id="early-withdrawal.position-summary"></a>

### Tu posición actual

Snapshot —principal pendiente, interés acumulado, tiempo restante,
HF/LTV actuales del lado del prestatario. Estos fijan el precio
justo que el mercado de compradores esperará: el payoff del
comprador es `principal + interest` al final, menos riesgo de
liquidación durante el tiempo restante.

<a id="early-withdrawal.initiate-sale"></a>

### Iniciar la venta

`initEarlyWithdrawal(loanId, askPrice)`. Lista el NFT de posición
a la venta vía el protocolo; `completeEarlyWithdrawal(saleId)` es
lo que un comprador llama para aceptar. Cancelable antes del
llenado vía `cancelEarlyWithdrawal(saleId)`. Opcionalmente
delegable a un keeper que tenga el bit de acción
`COMPLETE_LOAN_SALE`; el init en sí permanece sólo de usuario.
