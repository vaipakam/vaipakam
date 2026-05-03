# Vaipakam — Guía del usuario (Modo avanzado)

Explicaciones precisas y técnicamente rigurosas de cada tarjeta de la
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

Un contrato actualizable por usuario —tu bóveda privada en esta
cadena— creado para ti la primera vez que participas en un
préstamo. Un escrow por dirección por cadena. Mantiene saldos
ERC-20, ERC-721 y ERC-1155 vinculados a tus posiciones de préstamo.
No hay mezcla de fondos: los activos de otros usuarios nunca están
en este contrato.

El escrow es el único lugar donde residen el colateral, los activos
prestados y tu VPFI bloqueado. El protocolo lo verifica en cada
depósito y retiro. La implementación puede actualizarla el dueño del
protocolo, pero solamente a través de un timelock —nunca de forma
instantánea.

<a id="dashboard.your-loans"></a>

### Tus préstamos

Cada préstamo en el que participa la billetera conectada en esta
cadena —ya estés del lado prestamista, del lado prestatario, o en
ambos mediante posiciones distintas. Se calcula en vivo a partir de
los métodos de vista del protocolo para tu dirección. Cada fila
enlaza a la página completa de la posición, con HF, LTV, interés
acumulado, las acciones habilitadas según tu rol y el estado del
préstamo, y el id de préstamo on-chain que puedes pegar en un
explorador de bloques.

<a id="dashboard.vpfi-panel"></a>

### VPFI en esta cadena

Contabilidad VPFI en vivo para la billetera conectada en la cadena
activa:

- Saldo en billetera.
- Saldo en escrow.
- Tu cuota del suministro circulante (después de restar los saldos
  en poder del protocolo).
- Tope de minteo restante.

Vaipakam transporta VPFI entre cadenas sobre LayerZero V2. **Base
es la cadena canónica** —el adaptador canónico allí aplica la
semántica de bloquear al enviar / liberar al recibir. Cualquier
otra cadena soportada ejecuta un espejo que mintea cuando llega un
paquete entrante del puente y quema al salir. Por construcción, el
suministro total en todas las cadenas se mantiene invariante bajo
bridging.

La política de verificación de mensajes cross-chain, endurecida tras
el incidente del sector de abril de 2026, es de **3 verificadores
requeridos + 2 opcionales, umbral 1-de-2**. La configuración por
defecto de un solo verificador se rechaza en el gate de despliegue.

<a id="dashboard.fee-discount-consent"></a>

### Consentimiento de descuento en comisiones

Una bandera de opt-in a nivel de billetera que permite al protocolo
liquidar la porción descontada de una comisión en VPFI debitado de
tu escrow en eventos terminales. Por defecto: desactivado.
Desactivado significa que pagas el 100% de cada comisión en el
activo principal; activado significa que se aplica el descuento
ponderado por tiempo.

Escalera de niveles:

| Nivel | VPFI mínimo en escrow                  | Descuento                          |
| ----- | -------------------------------------- | ---------------------------------- |
| 1     | ≥ `{liveValue:tier1Min}`               | `{liveValue:tier1DiscountBps}`%    |
| 2     | ≥ `{liveValue:tier2Min}`               | `{liveValue:tier2DiscountBps}`%    |
| 3     | ≥ `{liveValue:tier3Min}`               | `{liveValue:tier3DiscountBps}`%    |
| 4     | > `{liveValue:tier4Min}`               | `{liveValue:tier4DiscountBps}`%    |

El nivel se calcula contra tu saldo de escrow **posterior al cambio** en el
momento en que depositas o retiras VPFI, y luego se pondera por
tiempo a lo largo de la vida útil de cada préstamo. Un retiro
vuelve a fijar la tasa al nuevo saldo más bajo inmediatamente para
cada préstamo abierto en el que estés —no hay ventana de gracia
donde tu nivel anterior (más alto) aún se aplique. Esto cierra el
patrón de abuso en el que un usuario podría recargar VPFI justo
antes del cierre de un préstamo, capturar el descuento del nivel
completo y retirar segundos después.

El descuento se aplica a la comisión por rendimiento del prestamista
en la liquidación, y a la Loan Initiation Fee del prestatario
(entregada como un reembolso de VPFI cuando el prestatario reclama).

> **El gas de red es independiente.** El descuento anterior se
> aplica a las **comisiones del protocolo** de Vaipakam (Comisión
> sobre Rendimiento `{liveValue:treasuryFeeBps}`%, Loan Initiation
> Fee `{liveValue:loanInitiationFeeBps}`%). La **comisión de gas de
> la red blockchain** que requiere cada acción on-chain — pagada a
> los validadores en Base / Sepolia / Arbitrum / etc. al crear una
> oferta, aceptar, repagar, reclamar, retirar, etc. — no es un cargo
> del protocolo. Vaipakam nunca la recibe; la red sí. No puede
> aplicársele tier ni reembolso, y varía con la congestión de la
> cadena en el momento del envío, no con el tamaño del préstamo ni
> con tu nivel de VPFI.

<a id="dashboard.rewards-summary"></a>

### Tus recompensas VPFI

Tarjeta de resumen aspiracional que muestra, en una sola vista, el
panorama combinado de recompensas VPFI de la billetera conectada en
ambos flujos de recompensa. La cifra principal es la suma de:
recompensas de staking pendientes, recompensas de staking reclamadas
históricamente, recompensas de interacción pendientes y recompensas
de interacción reclamadas históricamente.

Las filas de desglose por flujo muestran pendiente + reclamado y un
enlace profundo con chevron hacia la tarjeta de reclamación completa
en su página nativa:

- **Rendimiento de staking** — VPFI pendiente acumulado al APR del
  protocolo sobre tu saldo de escrow, más todas las recompensas de
  staking que hayas reclamado previamente desde esta billetera.
  Enlaza a la tarjeta de reclamación de staking en la página Comprar
  VPFI.
- **Recompensas de interacción con la plataforma** — VPFI pendiente
  acumulado en todos los préstamos en los que hayas participado
  (lado prestamista o prestatario), más todas las recompensas de
  interacción que hayas reclamado previamente. Enlaza a la tarjeta
  de reclamación de interacción en el Centro de reclamaciones.

Los números reclamados históricamente se reconstruyen desde el
historial on-chain de reclamaciones de cada billetera. No existe un
total acumulado on-chain que consultar, así que la cifra se suma
recorriendo los eventos de reclamación previos de la billetera en
esta cadena. Un caché de navegador nuevo muestra cero (o un total
parcial) hasta que se completa el recorrido histórico; entonces el
número salta a su valor correcto. El modelo de confianza es el mismo
que el de las tarjetas de reclamación subyacentes.

La tarjeta siempre se muestra para billeteras conectadas, incluso
cuando todos los valores son cero. La pista del estado vacío es
intencional —ocultar la tarjeta en cero haría invisibles los
programas de recompensas para usuarios nuevos hasta que entraran a
Comprar VPFI o al Centro de reclamaciones.

---

## Libro de ofertas

<a id="offer-book.filters"></a>

### Filtros

Filtros del lado cliente sobre las listas de ofertas de
prestamista / prestatario. Filtra por activo, lado, estado y
algunos otros ejes. Los filtros no afectan a "Tus ofertas activas"
— esa lista siempre se muestra completa.

<a id="offer-book.your-active-offers"></a>

### Tus ofertas activas

Ofertas abiertas (estado Active, expiración aún no alcanzada) que
creaste. Cancelables en cualquier momento antes de la aceptación
—la cancelación es gratuita. La aceptación cambia la oferta a
Accepted y dispara la inicialización del préstamo, que mintea los
dos NFTs de posición (uno para el prestamista y otro para el
prestatario) y abre el préstamo en estado Active.

<a id="offer-book.lender-offers"></a>

### Ofertas de prestamistas

Ofertas activas de creadores dispuestos a prestar. La aceptación la
realiza un prestatario. Hay un gate rígido en la inicialización: la
canasta de colateral del prestatario debe producir un Health Factor
de al menos 1,5 frente al monto principal solicitado por el
prestamista. La matemática de HF es del propio protocolo —el gate
no es eludible. El 1% de tesorería sobre los intereses se debita en
la liquidación terminal, no por adelantado.

<a id="offer-book.borrower-offers"></a>

### Ofertas de prestatarios

Ofertas activas de prestatarios que ya bloquearon su colateral en
escrow. La aceptación la realiza un prestamista; esto financia el
préstamo con el activo principal y mintea los NFTs de posición.
Mismo gate de HF ≥ 1,5 en la inicialización. La APR fija se
establece en la oferta al crearse y es inmutable durante toda la
vida del préstamo —el refinance crea un préstamo nuevo en lugar de
modificar el existente.

---

## Crear oferta

<a id="create-offer.offer-type"></a>

### Tipo de oferta

Selecciona en qué lado de la oferta está el creador:

- **Prestamista** — el prestamista aporta el activo principal y
  una especificación de colateral que el prestatario debe
  cumplir.
- **Prestatario** — el prestatario bloquea el colateral por
  adelantado; un prestamista acepta y financia.
- Sub-tipo **Alquiler** — para NFTs ERC-4907 (ERC-721 alquilable)
  y ERC-1155 alquilables. Se enruta por el flujo de alquiler en
  lugar de un préstamo de deuda; el arrendatario pre-paga el
  costo total del alquiler (duración × tarifa diaria) más un
  margen del 5%.

<a id="create-offer.lending-asset"></a>

### Activo prestado

Para una oferta de deuda especificas el activo, el monto principal,
la APR fija y la duración en días:

- **Activo** — el ERC-20 que se presta / pide prestado.
- **Monto** — principal, denominado en los decimales nativos del
  activo.
- **APR** — tasa anual fija en basis points (centésimas de
  porcentaje), fijada como instantánea en la aceptación y sin cambios
  posteriores.
- **Duración en días** — fija la ventana de gracia antes de que
  un default sea invocable.

El interés acumulado se calcula continuamente por segundo desde el
inicio del préstamo hasta la liquidación terminal.

<a id="create-offer.lending-asset:lender"></a>

#### Si eres el prestamista

El activo principal y el monto que estás dispuesto a ofrecer,
además de la tasa de interés (APR en %) y la duración en días. La
tasa se fija al momento de la oferta; la duración determina la
ventana de gracia antes de que el préstamo pueda entrar en default.
En la aceptación, el principal se mueve de tu escrow al escrow del
prestatario como parte de la inicialización del préstamo.

<a id="create-offer.lending-asset:borrower"></a>

#### Si eres el prestatario

El activo principal y el monto que quieres del prestamista, además
de la tasa de interés (APR en %) y la duración en días. La tasa se
fija al momento de la oferta; la duración determina la ventana de
gracia antes de que el préstamo pueda entrar en default. Tu
colateral queda bloqueado en tu escrow al momento de la creación
de la oferta y permanece bloqueado hasta que un prestamista acepte
y se abra el préstamo (o hasta que canceles).

<a id="create-offer.nft-details"></a>

### Detalles del NFT

Campos del sub-tipo de alquiler. Especifica el contrato del NFT y
el id del token (y la cantidad para ERC-1155), además de la tarifa
diaria de alquiler en el activo principal. En la aceptación, el
protocolo debita el alquiler prepagado desde el escrow del
arrendatario hacia custodia —eso es duración × tarifa diaria, más
un margen del 5%. El NFT mismo pasa a un estado delegado (vía los
derechos de uso de ERC-4907, o el hook equivalente de alquiler de
ERC-1155), de modo que el arrendatario tiene derechos pero no
puede transferir el NFT.

<a id="create-offer.collateral"></a>

### Colateral

Especificación del activo de colateral en la oferta. Dos clases de
liquidez:

- **Líquido** — tiene un feed de precio de Chainlink registrado
  Y al menos un pool de Uniswap V3 / PancakeSwap V3 / SushiSwap V3
  con ≥ $1M de profundidad en el tick actual. Aplica la matemática
  de LTV y HF; una liquidación basada en HF enruta el colateral
  por un failover de 4 DEX (0x → 1inch → Uniswap V3 → Balancer
  V2).
- **Ilíquido** — cualquier cosa que falle lo anterior. Valorado
  en $0 on-chain. Sin matemática de HF. En default, el colateral
  íntegro se transfiere al prestamista. Ambas partes deben
  reconocer explícitamente el riesgo de colateral ilíquido en la
  creación / aceptación de la oferta para que la oferta quede
  registrada.

El oráculo de precios tiene un quórum secundario de tres fuentes
independientes (Tellor, API3, DIA) usando una regla de decisión
suave 2-de-N por encima del feed primario de Chainlink. Pyth fue
evaluado y no adoptado.

<a id="create-offer.collateral:lender"></a>

#### Si eres el prestamista

Cuánto quieres que el prestatario bloquee para asegurar el
préstamo. Los ERC-20 líquidos (feed de Chainlink más ≥ $1M de
profundidad en pool v3) entran en la matemática de LTV / HF; los
ERC-20 ilíquidos y los NFTs no tienen valoración on-chain y
requieren que ambas partes consientan un resultado de
colateral-completo-en-default. El gate de HF ≥ 1,5 en la
inicialización del préstamo se calcula contra la canasta de
colateral que el prestatario presenta en la aceptación —
dimensionar aquí el requisito fija directamente el margen de HF
del prestatario.

<a id="create-offer.collateral:borrower"></a>

#### Si eres el prestatario

Cuánto estás dispuesto a bloquear para asegurar el préstamo. Los
ERC-20 líquidos (feed de Chainlink más ≥ $1M de profundidad en
pool v3) entran en la matemática de LTV / HF; los ERC-20 ilíquidos
y los NFTs no tienen valoración on-chain y requieren que ambas
partes consientan un resultado de colateral-completo-en-default.
Tu colateral se bloquea en tu escrow al momento de la creación de
la oferta en una oferta de prestatario; en una oferta de
prestamista, tu colateral se bloquea en el momento de la
aceptación. En cualquier caso, el gate de HF ≥ 1,5 en la
inicialización del préstamo debe superarse con la canasta que
presentes.

<a id="create-offer.risk-disclosures"></a>

### Divulgaciones de riesgo

Gate de reconocimiento antes de enviar. La misma superficie de
riesgo aplica a ambos lados; las pestañas específicas por rol más
abajo explican cómo impacta cada riesgo según el lado de la oferta
que firmes. Vaipakam es non-custodial: no hay clave de admin que
pueda revertir una transacción ya ejecutada. Existen palancas de
pausa sólo en contratos expuestos a cross-chain, sujetas a un
timelock, y no pueden mover activos.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si eres el prestamista

- **Riesgo de smart contract** — el código del contrato es
  inmutable en runtime; auditado pero no formalmente verificado.
- **Riesgo de oráculo** — la obsolescencia de Chainlink o la
  divergencia en la profundidad de los pools puede demorar una
  liquidación basada en HF más allá del punto donde el colateral
  cubre el principal. El quórum secundario (Tellor + API3 + DIA,
  suave 2-de-N) captura derivas grandes, pero un sesgo pequeño aún
  puede erosionar la recuperación.
- **Slippage de liquidación** — el failover de 4 DEX enruta a la
  mejor ejecución que pueda encontrar, pero no puede garantizar
  un precio específico. La recuperación es neta de slippage y del
  1% de tesorería sobre intereses.
- **Defaults con colateral ilíquido** — el colateral se transfiere
  íntegro a ti en el momento del default. No tienes recurso si el
  activo vale menos que el principal más los intereses
  acumulados.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si eres el prestatario

- **Riesgo de smart contract** — el código del contrato es
  inmutable en runtime; los bugs afectarían al colateral
  bloqueado.
- **Riesgo de oráculo** — datos obsoletos o manipulación pueden
  disparar una liquidación basada en HF en tu contra cuando el
  precio real de mercado se hubiera mantenido seguro. La fórmula
  de HF es reactiva a la salida del oráculo; un único tick malo
  que cruce 1,0 es suficiente.
- **Slippage de liquidación** — cuando se dispara una liquidación,
  el swap puede vender tu colateral a precios mermados por
  slippage. El swap es permissionless —cualquiera puede
  dispararlo en el instante en que tu HF cae por debajo de 1,0.
- **Defaults con colateral ilíquido** — el default transfiere
  todo tu colateral al prestamista. No hay reclamación residual;
  sólo cualquier reembolso de VPFI Loan Initiation Fee no usado,
  que cobras como prestatario al reclamar.

<a id="create-offer.advanced-options"></a>

### Opciones avanzadas

Ajustes menos habituales:

- **Caducidad** — la oferta se auto-cancela tras este timestamp.
  Por defecto ≈ 7 días.
- **Usar descuento de comisión para esta oferta** — override
  local del consentimiento de descuento a nivel de billetera para
  esta oferta específica.
- Opciones específicas por lado expuestas por el flujo de
  creación de ofertas.

Los valores por defecto son razonables para la mayoría de usuarios.

---

## Centro de reclamaciones

<a id="claim-center.claims"></a>

### Fondos reclamables

Las reclamaciones son de tipo pull por diseño —los eventos
terminales dejan los fondos en custodia del protocolo y el poseedor
del NFT de posición llama a reclamar para moverlos. Ambos tipos de
reclamación pueden estar en la misma billetera al mismo tiempo. Las
pestañas específicas por rol más abajo describen cada una.

Cada reclamación quema el NFT de posición del poseedor de forma
atómica. El NFT *es* el instrumento al portador —transferirlo
antes de reclamar le da al nuevo poseedor el derecho a cobrar.

<a id="claim-center.claims:lender"></a>

#### Si eres el prestamista

La reclamación del prestamista devuelve:

- Tu principal de vuelta a tu billetera en esta cadena.
- Los intereses acumulados menos el 1% de tesorería. Ese corte se
  reduce a su vez por tu acumulador de descuento de comisiones
  VPFI ponderado por tiempo cuando el consentimiento está
  activado.

Reclamable apenas el préstamo alcanza un estado terminal (Settled,
Defaulted o Liquidated). El NFT de posición de prestamista se
quema en la misma transacción.

<a id="claim-center.claims:borrower"></a>

#### Si eres el prestatario

La reclamación del prestatario devuelve, dependiendo de cómo se
liquidó el préstamo:

- **Repago total / preclose / refinance** — tu canasta de
  colateral de vuelta, más el reembolso de VPFI ponderado por
  tiempo de la Loan Initiation Fee.
- **Liquidación por HF o default** — sólo el reembolso de VPFI
  Loan Initiation Fee no usado, que en estos caminos terminales
  es cero a menos que se preserve explícitamente. El colateral
  ya se movió al prestamista.

El NFT de posición de prestatario se quema en la misma
transacción.

---

## Actividad

<a id="activity.feed"></a>

### Feed de actividad

Eventos on-chain que involucran a tu billetera en la cadena
activa, obtenidos en vivo de los logs del protocolo sobre una
ventana deslizante de bloques. No hay caché de backend —cada
carga vuelve a obtener los datos. Los eventos se agrupan por hash de
transacción para que las txns multi-evento (por ejemplo, accept +
initiate cayendo en el mismo bloque) se mantengan juntas. Los más
nuevos primero. Muestra ofertas, préstamos, repagos,
reclamaciones, liquidaciones, mints y burns de NFT, y compras /
stakes / unstakes de VPFI.

---

## Comprar VPFI

<a id="buy-vpfi.overview"></a>

### Comprando VPFI

Dos caminos:

- **Canónico (Base)** — llamada directa al flujo canónico de
  compra en el protocolo. Mintea VPFI directamente a tu billetera
  en Base.
- **No canónico** — el adaptador de compra de la cadena local
  envía un paquete LayerZero al receptor canónico en Base, que
  realiza la compra en Base y puentea el resultado de regreso vía
  el estándar de token cross-chain. Latencia end-to-end ≈ 1 min
  en pares L2-a-L2. El VPFI llega a tu billetera en la cadena de
  **origen**.

Límites de tasa del adaptador (post-endurecimiento): 50.000 VPFI
por solicitud y 500.000 VPFI como ventana móvil de 24 horas. Ajustables
por gobernanza a través de un timelock.

<a id="buy-vpfi.discount-status"></a>

### Tu estado de descuento VPFI

Estado en vivo:

- Nivel actual (0 a 4).
- Saldo de VPFI en escrow más la diferencia hasta el siguiente
  nivel.
- Porcentaje de descuento al nivel actual.
- Bandera de consentimiento a nivel de billetera.

Nota que el VPFI en escrow también acumula 5% APR vía el pool de
staking —no hay acción separada de "stake". Depositar VPFI en tu
escrow ES hacer staking.

<a id="buy-vpfi.buy"></a>

### Paso 1 — Compra VPFI con ETH

Envía la compra. En la cadena canónica, el protocolo mintea
directamente. En cadenas espejo, el adaptador de compra recibe el
pago, envía un mensaje cross-chain, y el receptor ejecuta la
compra en Base y puentea VPFI de vuelta. La comisión del puente más el
costo de la red de verificadores se cotiza en vivo y se muestra
en el formulario. El VPFI no se auto-deposita en escrow —el Paso
2 es una acción explícita del usuario por diseño.

<a id="buy-vpfi.deposit"></a>

### Paso 2 — Deposita VPFI en tu escrow

Un paso de depósito explícito separado, desde tu billetera a tu
escrow en la misma cadena. Requerido en cada cadena —incluso la
canónica— porque el depósito en escrow siempre es una acción
explícita del usuario por especificación. En cadenas donde está
configurado Permit2, la app prefiere el camino de firma única
sobre el patrón clásico de approve + deposit; hace fallback limpio
si Permit2 no está configurado en esa cadena.

<a id="buy-vpfi.unstake"></a>

### Paso 3 — Saca VPFI del staking en tu escrow

Retira VPFI desde tu escrow de vuelta a tu billetera. No hay
etapa de aprobación —el protocolo es dueño del escrow y se debita
a sí mismo. El retiro dispara una refijación inmediata de la
tasa de descuento al nuevo (más bajo) saldo, aplicado a cada
préstamo abierto en el que estés. No hay ventana de gracia donde
aún aplique el nivel anterior.

---

## Recompensas

<a id="rewards.overview"></a>

### Sobre las recompensas

Dos flujos:

- **Pool de staking** — el VPFI en escrow acumula al 5% APR
  continuamente, con capitalización por segundo.
- **Pool de interacción** — cuota diaria pro-rata de una emisión
  diaria fija, ponderada por tu contribución de intereses
  liquidados al volumen de préstamos de ese día. Las ventanas
  diarias se finalizan de forma lazy en la primera reclamación o
  liquidación después del cierre de ventana.

Ambos flujos se mintean directamente en la cadena activa —no hay
ida y vuelta cross-chain para el usuario. La agregación cross-chain
de recompensas ocurre sólo entre contratos del protocolo.

<a id="rewards.claim"></a>

### Reclamar recompensas

Una sola transacción reclama ambos flujos a la vez. Las
recompensas de staking siempre están disponibles; las recompensas
de interacción son cero hasta que la ventana diaria relevante se
finalice (finalización lazy disparada por la siguiente
reclamación o liquidación distinta de cero en esa cadena). La UI bloquea
el botón mientras la ventana aún se está finalizando para que los
usuarios no reclamen de menos.

<a id="rewards.withdraw-staked"></a>

### Retirar VPFI stakeado

Superficie idéntica al "Paso 3 — Unstake" en la página Comprar
VPFI —retira VPFI desde el escrow de vuelta a tu billetera. El
VPFI retirado sale del pool de staking inmediatamente (las
recompensas dejan de acumularse para ese monto en ese bloque) y
sale del acumulador de descuento inmediatamente (refijación
posterior al saldo en cada préstamo abierto).

---

## Detalles del préstamo

<a id="loan-details.overview"></a>

### Detalles del préstamo (esta página)

Vista de un único préstamo derivada en vivo del protocolo, más HF
y LTV en vivo del motor de riesgo. Muestra términos, riesgo de
colateral, partes, las acciones habilitadas por tu rol y el estado
del préstamo, y el estado de keeper en línea.

<a id="loan-details.terms"></a>

### Términos del préstamo

Partes inmutables del préstamo:

- Principal (activo y monto).
- APR (fijada en la creación de la oferta).
- Duración en días.
- Tiempo de inicio y tiempo de fin (tiempo de inicio + duración).
- Interés acumulado, calculado en vivo desde los segundos
  transcurridos desde el inicio.

El refinance crea un préstamo nuevo en lugar de modificar estos
valores.

<a id="loan-details.collateral-risk"></a>

### Colateral y riesgo

Matemática de riesgo en vivo.

- **Health Factor** = (valor USD del colateral × umbral de
  liquidación) / valor USD de la deuda. Un HF por debajo de 1,0
  hace la posición liquidable.
- **LTV** = valor USD de la deuda / valor USD del colateral.
- **Umbral de liquidación** = el LTV en el que la posición se
  vuelve liquidable; depende de la clase de volatilidad de la
  canasta de colateral. El gatillo de colapso de alta
  volatilidad es del 110% LTV.

El colateral ilíquido tiene valor USD on-chain de cero; HF y LTV
pasan a "n/a" y el único camino terminal es la transferencia
completa del colateral en default —ambas partes consintieron en
la creación de la oferta vía el reconocimiento de riesgo de
iliquidez.

<a id="loan-details.collateral-risk:lender"></a>

#### Si eres el prestamista

La canasta de colateral que asegura este préstamo es tu
protección. Un HF por encima de 1,0 significa que la posición
está sobrecolateralizada respecto del umbral de liquidación. A
medida que HF deriva hacia 1,0, tu protección se estrecha. Una
vez que HF cae por debajo de 1,0, cualquiera (tú incluido) puede
llamar a liquidar, y el protocolo enruta el colateral por el
failover de 4 DEX para tu activo principal. La recuperación es
neta de slippage.

Para colateral ilíquido, en default la canasta se transfiere
íntegra a ti en el momento del default —cuánto vale en realidad
en el mercado abierto es problema tuyo.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si eres el prestatario

Tu colateral bloqueado. Mantén HF cómodamente por encima de 1,0
— un objetivo común de margen es 1,5 para aguantar volatilidad.
Palancas para subir HF:

- **Agregar colateral** — recargar la canasta. Acción sólo de
  usuario.
- **Repago parcial** — reduce deuda, sube HF.

Una vez que HF cae por debajo de 1,0, cualquiera puede disparar
una liquidación basada en HF; el swap vende tu colateral a
precios mermados por slippage para repagar al prestamista. Sobre
colateral ilíquido, el default transfiere todo tu colateral al
prestamista —sólo queda por reclamar cualquier reembolso de VPFI
Loan Initiation Fee no usado.

<a id="loan-details.parties"></a>

### Partes

Prestamista, prestatario, escrow del prestamista, escrow del
prestatario y los dos NFTs de posición (uno por cada lado). Cada
NFT es un ERC-721 con metadatos on-chain; transferirlo transfiere
el derecho a reclamar. Los contratos de escrow son
determinísticos por dirección —misma dirección entre despliegues.

<a id="loan-details.actions"></a>

### Acciones

Superficie de acciones, limitada por rol por el protocolo. Las
pestañas específicas por rol más abajo enumeran las acciones
disponibles de cada lado. Las acciones deshabilitadas muestran
una razón en hover derivada del gate ("HF insuficiente", "Aún no
expirado", "Préstamo bloqueado", etc.).

Acciones permissionless disponibles para cualquiera independiente
del rol:

- **Disparar liquidación** — cuando HF cae por debajo de 1,0.
- **Marcar default** — cuando el periodo de gracia ha expirado
  sin repago total.

<a id="loan-details.actions:lender"></a>

#### Si eres el prestamista

- **Reclamar como prestamista** — sólo en estados terminales. Devuelve
  principal más intereses menos el 1% de tesorería (reducido aún
  más por tu descuento de yield-fee VPFI ponderado por tiempo
  cuando el consentimiento está activado). Quema el NFT de
  posición de prestamista.
- **Iniciar retiro anticipado** — pone el NFT de posición de
  prestamista a la venta a un precio que tú eliges. Un comprador
  que complete la venta se hace cargo de tu lado; recibes lo
  recaudado. Cancelable antes de que la venta se complete.
- Opcionalmente delegable a un keeper que tenga el permiso de
  acción relevante —ver Configuración de keepers.

<a id="loan-details.actions:borrower"></a>

#### Si eres el prestatario

- **Repagar** — total o parcial. El parcial reduce el saldo
  pendiente y sube HF; el total dispara la liquidación terminal,
  incluyendo el reembolso de VPFI Loan Initiation Fee ponderado
  por tiempo.
- **Preclose directo** — paga el monto pendiente desde tu
  billetera ahora, libera colateral, liquida el reembolso.
- **Preclose offset** — vende parte del colateral vía el router
  de swap del protocolo, repaga con lo recibido, y devuelve el
  remanente. Dos pasos: iniciar, luego completar.
- **Refinanciar** — publica una oferta de prestatario con nuevos
  términos; una vez que un prestamista acepta, completar el
  refinance intercambia los préstamos atómicamente sin que el
  colateral salga de tu escrow.
- **Reclamar como prestatario** — sólo en estados terminales. Devuelve el
  colateral en repago total, o el reembolso de VPFI Loan
  Initiation Fee no usado en default / liquidación. Quema el NFT
  de posición de prestatario.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Lista cada allowance ERC-20 que tu billetera ha otorgado al
protocolo en esta cadena. Obtenida escaneando una lista candidata
de tokens contra las vistas de allowance on-chain. Revocar pone
el allowance a cero.

Conforme a la política de aprobación de monto exacto, el
protocolo nunca pide allowances ilimitados, así que la lista
típica de revocación es corta.

Nota: los flujos al estilo Permit2 omiten el allowance por
activo en el protocolo usando una sola firma en su lugar, así que
una lista limpia aquí no impide depósitos futuros.

---

## Alertas

<a id="alerts.overview"></a>

### Sobre las alertas

Un watcher off-chain sondea cada préstamo activo que involucra a
tu billetera con una cadencia de 5 minutos, lee el Health Factor
en vivo de cada uno, y al cruzar una banda en dirección insegura
dispara una vez vía los canales configurados. No hay estado
on-chain ni gas. Las alertas son informativas —no mueven fondos.

<a id="alerts.threshold-ladder"></a>

### Escalera de umbrales

Una escalera de bandas de HF configurada por el usuario. Cruzar
a una banda más peligrosa dispara una alerta una vez y arma el
siguiente umbral más profundo; cruzar de vuelta por encima de una
banda la rearma. Por defecto: 1,5 → 1,3 → 1,1. Números más altos son
apropiados para colateral volátil. El único trabajo de la
escalera es sacarte antes de que HF caiga por debajo de 1,0 y
dispare la liquidación.

<a id="alerts.delivery-channels"></a>

### Canales de envío

Dos canales:

- **Telegram** — DM de bot con la dirección corta de la
  billetera, el id del préstamo y el HF actual.
- **Push Protocol** — notificación directa a la billetera vía el
  canal Vaipakam Push.

Ambos comparten la escalera de umbrales; los niveles de
advertencia por canal no se exponen intencionalmente para evitar
deriva. La publicación del canal Push está actualmente como stub,
pendiente de la creación del canal.

---

## Verificador de NFTs

<a id="nft-verifier.lookup"></a>

### Verificar un NFT

Dada una dirección de contrato de NFT y un id de token, el
verificador obtiene:

- El propietario actual (o una señal de quemado si el token ya
  está quemado).
- Los metadatos JSON on-chain.
- Una verificación cruzada del protocolo: deriva el id de
  préstamo subyacente desde los metadatos y lee los detalles del
  préstamo desde el protocolo para confirmar el estado.

Muestra: ¿minteado por Vaipakam? ¿qué cadena? ¿estado del
préstamo? ¿poseedor actual? Te permite detectar una falsificación,
una posición ya reclamada (quemada), o una posición cuyo préstamo
se liquidó y está en medio del proceso de reclamación.

El NFT de posición es el instrumento al portador —verifica antes
de comprar en un mercado secundario.

---

## Configuración de keepers

<a id="keeper-settings.overview"></a>

### Sobre los keepers

Una allowlist de keepers por billetera de hasta 5 keepers. Cada
keeper tiene un conjunto de permisos de acción autorizando
llamadas de mantenimiento específicas sobre **tu lado** de un
préstamo. Los caminos de salida-de-dinero (repagar, reclamar,
agregar colateral, liquidar) son sólo de usuario por diseño y no
pueden delegarse.

Se aplican dos gates adicionales en el momento de la acción:

1. El interruptor maestro de acceso a keepers —un freno de
   emergencia de un solo cambio que deshabilita a todos los
   keepers sin tocar la allowlist.
2. Un toggle de opt-in por préstamo, configurado en la
   superficie del Libro de ofertas o de Detalles del préstamo.

Un keeper puede actuar sólo cuando las cuatro condiciones son
verdaderas: aprobado, interruptor maestro encendido, toggle
por-préstamo encendido y el permiso de acción específico
configurado en ese keeper.

<a id="keeper-settings.approved-list"></a>

### Keepers aprobados

Permisos de acción actualmente expuestos:

- **Completar venta de préstamo** (lado prestamista, salida del
  mercado secundario).
- **Completar offset** (lado prestatario, segunda etapa del
  preclose vía venta de colateral).
- **Iniciar retiro anticipado** (lado prestamista, pone la
  posición a la venta).
- **Iniciar preclose** (lado prestatario, dispara el flujo de
  preclose).
- **Refinanciar** (lado prestatario, intercambio atómico de
  préstamo sobre una nueva oferta de prestatario).

Permisos añadidos on-chain que el frontend aún no refleja
obtienen un revert claro de "permiso inválido". La revocación es
instantánea en todos los préstamos —no hay periodo de espera.

---

## Dashboard de analítica pública

<a id="public-dashboard.overview"></a>

### Sobre la analítica pública

Un agregador sin necesidad de billetera, calculado en vivo a
partir de llamadas view del protocolo on-chain a través de cada
cadena soportada. Sin backend, sin base de datos. Disponible
exportación CSV / JSON; la dirección del protocolo más la función
view que respalda cada métrica se muestra para fines de
verificabilidad.

<a id="public-dashboard.combined"></a>

### Combinado — Todas las cadenas

Rollup cross-chain. La cabecera informa cuántas cadenas se
cubrieron y cuántas fallaron, de modo que un RPC inalcanzable en el
momento de la consulta queda explícito. Cuando una o más cadenas fallaron,
la tabla por cadena marca cuáles —los totales de TVL aún se
reportan, pero reconocen el hueco.

<a id="public-dashboard.per-chain"></a>

### Desglose por cadena

División por cadena de las métricas combinadas. Útil para
detectar concentración de TVL, suministros de espejos VPFI
desalineados (la suma de los suministros espejo debería igualar
el saldo bloqueado del adaptador canónico), o cadenas estancadas.

<a id="public-dashboard.vpfi-transparency"></a>

### Transparencia del token VPFI

Contabilidad VPFI on-chain en la cadena activa:

- Suministro total, leído directamente del ERC-20.
- Suministro circulante — suministro total menos saldos en poder
  del protocolo (tesorería, pools de recompensas, paquetes del
  puente in-flight).
- Tope de minteo restante — sólo significativo en la cadena
  canónica; las cadenas espejo reportan "n/a" para el tope
  porque los mints allí son impulsados por puente, no minteados
  desde el tope.

Invariante cross-chain: la suma de los suministros espejo a
través de todas las cadenas espejo iguala al saldo bloqueado del
adaptador canónico. Un watcher monitorea esto y alerta sobre
deriva.

<a id="public-dashboard.transparency"></a>

### Transparencia y fuente

Para cada métrica, la página lista:

- El número de bloque usado como instantánea.
- Frescura de los datos (antigüedad máxima entre cadenas).
- La dirección del protocolo y la llamada de función view.

Cualquiera puede re-derivar cualquier número de esta página desde
RPC + bloque + dirección del protocolo + nombre de función —ese
es el listón.

---

## Refinanciar

Esta página es sólo para prestatarios —el refinance lo inicia el
prestatario sobre su préstamo.

<a id="refinance.overview"></a>

### Sobre refinanciar

El refinance paga atómicamente tu préstamo existente con un
nuevo principal y abre un préstamo fresco con los nuevos
términos, todo en una transacción. El colateral se queda en tu
escrow durante todo el proceso —no hay ventana sin garantizar.
El nuevo préstamo debe pasar el gate de HF ≥ 1,5 en la
inicialización, igual que cualquier otro préstamo.

El reembolso no usado de la Loan Initiation Fee del préstamo
viejo se liquida correctamente como parte del intercambio.

<a id="refinance.position-summary"></a>

### Tu posición actual

Snapshot del préstamo que se está refinanciando —principal actual,
intereses acumulados hasta ahora, HF / LTV y la canasta de
colateral. La nueva oferta debería dimensionarse al menos al
monto pendiente (principal + intereses acumulados); cualquier
excedente en la nueva oferta se entrega a tu escrow como
principal libre.

<a id="refinance.step-1-post-offer"></a>

### Paso 1 — Publica la nueva oferta

Publica una oferta de prestatario con tus términos objetivo. El
préstamo viejo sigue acumulando intereses mientras esperas; el
colateral permanece bloqueado. La oferta aparece en el Libro de
ofertas público y cualquier prestamista puede aceptarla. Puedes
cancelar antes de la aceptación.

<a id="refinance.step-2-complete"></a>

### Paso 2 — Completar

Liquidación atómica después de que el nuevo prestamista ha
aceptado:

1. Financia el nuevo préstamo desde el prestamista que acepta.
2. Repaga el préstamo viejo en su totalidad (principal +
   intereses, menos el corte de tesorería).
3. Quema los NFTs de posición viejos.
4. Mintea los NFTs de posición nuevos.
5. Liquida el reembolso no usado de la Loan Initiation Fee del
   préstamo viejo.

Revierte si HF bajo los nuevos términos quedaría por debajo de
1,5.

---

## Cierre anticipado

Esta página es sólo para prestatarios —el preclose lo inicia el
prestatario sobre su préstamo.

<a id="preclose.overview"></a>

### Sobre el preclose

Una terminación anticipada impulsada por el prestatario. Dos
caminos:

- **Directo** — paga el monto pendiente (principal + intereses
  acumulados) desde tu billetera, libera colateral, liquida el
  reembolso no usado de la Loan Initiation Fee.
- **Offset** — inicia el offset para vender parte del colateral
  vía el failover de swap de 4 DEX del protocolo por el activo
  principal, completa el offset para repagar con lo recibido, y
  el remanente del colateral te vuelve. Misma liquidación de
  reembolso.

No hay penalización fija de cierre anticipado. La matemática VPFI
ponderada por tiempo maneja la equidad.

<a id="preclose.position-summary"></a>

### Tu posición actual

Snapshot del préstamo en preclose —principal pendiente,
intereses acumulados, HF / LTV actuales. El flujo de preclose
**no** requiere HF ≥ 1,5 al salir (es un cierre, no una
re-init).

<a id="preclose.in-progress"></a>

### Offset en progreso

Estado: el offset se ha iniciado, el swap está en ejecución
(o la cotización fue consumida pero el settlement final está
pendiente). Dos salidas:

- **Completar offset** — liquida el préstamo desde lo recaudado,
  devuelve el remanente.
- **Cancelar offset** — aborta; el colateral queda bloqueado, el
  préstamo sin cambios. Úsalo cuando el swap se movió contra ti
  entre iniciar y completar.

<a id="preclose.choose-path"></a>

### Elige un camino

El camino directo consume liquidez de billetera en el activo
principal. El camino offset consume colateral vía swap en DEX;
preferido cuando no tienes el activo principal a la mano o
cuando quieres salir también de la posición de colateral. El
slippage del offset está limitado por el mismo failover de 4 DEX
usado para liquidaciones (0x → 1inch → Uniswap V3 → Balancer V2).

---

## Retiro anticipado (prestamista)

Esta página es sólo para prestamistas —el retiro anticipado lo
inicia el prestamista sobre su préstamo.

<a id="early-withdrawal.overview"></a>

### Sobre la salida anticipada del prestamista

Un mecanismo de mercado secundario para posiciones de prestamista.
Pones a la venta tu NFT de posición a un precio elegido; en la
aceptación, el comprador paga, la propiedad del NFT de prestamista
se transfiere al comprador, y el comprador se convierte en el
prestamista de registro para toda liquidación futura (claim al
final, etc.). Tú recibes lo recaudado por la venta.

Las liquidaciones siguen siendo sólo de usuario y NO se delegan a
través de la venta —sólo se transfiere el derecho a reclamar.

<a id="early-withdrawal.position-summary"></a>

### Tu posición actual

Snapshot —principal pendiente, intereses acumulados, tiempo
restante, HF / LTV actuales del lado del prestatario. Estos fijan
el precio justo que el mercado de compradores esperará: el payoff
del comprador es principal más intereses al final, menos riesgo
de liquidación durante el tiempo restante.

<a id="early-withdrawal.initiate-sale"></a>

### Iniciar la venta

Pone el NFT de posición a la venta vía el protocolo a tu precio
de oferta. Un comprador completa la venta; puedes cancelar antes
de que la venta se complete. Opcionalmente delegable a un keeper
que tenga el permiso de "completar venta de préstamo"; el paso
de iniciar en sí permanece sólo de usuario.
