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

<a id="dashboard.your-vault"></a>

### Tu Vault

Un contrato actualizable por usuario —tu bóveda privada en esta
cadena— creado para ti la primera vez que participas en un
préstamo. Un vault por dirección por cadena. Mantiene saldos
ERC-20, ERC-721 y ERC-1155 vinculados a tus posiciones de préstamo.
No hay mezcla de fondos: los activos de otros usuarios nunca están
en este contrato.

El vault es el único lugar donde residen el colateral, los activos
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
- Saldo en vault.
- Tu cuota del suministro circulante (después de restar los saldos
  en poder del protocolo).
- Tope de minteo restante.

Vaipakam transporta VPFI entre cadenas sobre Chainlink CCIP. **Base
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
tu vault en eventos terminales. Por defecto: desactivado.
Desactivado significa que pagas el 100% de cada comisión en el
activo principal; activado significa que se aplica el descuento
ponderado por tiempo.

Escalera de niveles:

| Nivel | VPFI mínimo en vault                  | Descuento                          |
| ----- | -------------------------------------- | ---------------------------------- |
| 1     | ≥ `{liveValue:tier1Min}`               | `{liveValue:tier1DiscountBps}`%    |
| 2     | ≥ `{liveValue:tier2Min}`               | `{liveValue:tier2DiscountBps}`%    |
| 3     | ≥ `{liveValue:tier3Min}`               | `{liveValue:tier3DiscountBps}`%    |
| 4     | > `{liveValue:tier4Min}`               | `{liveValue:tier4DiscountBps}`%    |

El nivel se calcula contra tu saldo de vault **posterior al cambio** en el
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
  protocolo sobre tu saldo de vault, más todas las recompensas de
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

Las ofertas cerradas llevan uno de varios estados distintos. Algunos
ya están expuestos como chips de filtro en la página Mis Ofertas;
otros son terminales del lado del indexer que recibirán tratamiento
de UI dedicado en trabajos de seguimiento:

- **Filled** — aceptada por una contraparte; la referencia del
  préstamo de la oferta es el id del préstamo resultante.
- **Cancelled** — la oferta alcanzó el estado Cancelled por
  cualquiera de los dos caminos: retirada por el creador antes
  de la aceptación, O limpiada sin permisos vía
  `OfferCancelFacet.cancelOffer` una vez que
  `LibVaipakam.isOfferExpired(offer)` es verdadero (el reembolso
  igualmente se enruta al creador, sin importar quién inició la
  llamada de cancelación).
- **Sold** — la oferta optó por el flujo borrow-OR-sell de venta
  paralela (ver Crear Oferta → Permitir venta opcional) y un
  comprador en marketplace ejecutó el listado del NFT colateral
  antes de que ningún prestamista aceptara. La oferta lleva el
  estado on-chain `consumed_by_sale`; la columna de tasa de la
  fila muestra la tasa a la que se publicó la oferta y la celda
  de colateral renderiza la forma NFT (token id para ERC-721,
  cantidad de copias para ERC-1155). La dapp también surface la
  fila en el feed de Actividad como `Offer sold via OpenSea`
  para el prestatario (creador de la oferta). El evento on-chain
  en sí es
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  tanto el id de la oferta COMO la dirección del executor están
  indexados on-chain, pero la dirección del prestatario / creador
  NO. La coincidencia de wallet del prestatario para el feed de
  Actividad es agregada por el indexer en tiempo de ingestión
  (hace un join con la fila de la oferta para buscar el creador),
  así el filtro por wallet encuentra al prestatario sin que el
  evento en sí los indexe.
- **Fully Filled (estado del indexer, sin chip todavía)** — solo
  para Range-orders. Cuando el matching de relleno parcial
  consume el presupuesto restante de la oferta (el último match
  completa el rango por completo, o un match parcial deja un
  remanente sub-dust), `OfferMatchFacet` emite
  `OfferClosed(FullyFilled | Dust)` y el indexer marca la fila
  de la oferta con `status = 'fullyFilled'`. El estado `accepted`
  del contrato y la etiqueta Filled on-chain de arriba están
  reservados para el terminal de aceptación directa, por lo
  que `fullyFilled` es distinto del lado del indexer. El
  `MyOfferStatus` de la dapp aún no expone este terminal como
  su propio chip de filtro — `useMyOffers` actualmente ignora
  las filas con estado de indexer `fullyFilled` — así que una
  oferta de rango completamente llena efectivamente cae fuera
  de la vista Mis Ofertas hasta que llegue el chip dedicado.
  La superficie del chip está en cola como un seguimiento de
  UI separado.

Las ofertas pasadas-GTT (Good-Til-Time) que nunca alcanzaron un
evento terminal aún no están expuestas como un chip de estado
distinto en la dapp; actualmente caen bajo Active hasta que el
indexer registre un terminal. Un chip Expired dedicado está en
cola como seguimiento de UI separado.


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
vault. La aceptación la realiza un prestamista; esto financia el
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
En la aceptación, el principal se mueve de tu vault al vault del
prestatario como parte de la inicialización del préstamo.

<a id="create-offer.lending-asset:borrower"></a>

#### Si eres el prestatario

El activo principal y el monto que quieres del prestamista, además
de la tasa de interés (APR en %) y la duración en días. La tasa se
fija al momento de la oferta; la duración determina la ventana de
gracia antes de que el préstamo pueda entrar en default. Tu
colateral queda bloqueado en tu vault al momento de la creación
de la oferta y permanece bloqueado hasta que un prestamista acepte
y se abra el préstamo (o hasta que canceles).

<a id="create-offer.nft-details"></a>

### Detalles del NFT

Campos del sub-tipo de alquiler. Especifica el contrato del NFT y
el id del token (y la cantidad para ERC-1155), además de la tarifa
diaria de alquiler en el activo principal. En la aceptación, el
protocolo debita el alquiler prepagado desde el vault del
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
Tu colateral se bloquea en tu vault al momento de la creación de
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

<a id="create-offer.borrow-or-sell"></a>

### Permitir venta opcional de este NFT en OpenSea (solo ofertas de prestatario con colateral NFT)

Si estás publicando una **oferta de prestatario** con **colateral
ERC-721 o ERC-1155** y un **principal ERC-20**, la dapp expone un
opt-in `Borrow or sell` debajo de la sección de colateral. Marcarlo
marca la oferta como elegible para un listado de venta paralela de
tu NFT colateral en OpenSea — una sola oferta que puede ser
ejecutada YA SEA por un prestamista (tomas el préstamo) O por un
comprador en marketplace (vendes el NFT). El listado NO se
desmonta en la aceptación del prestamista si ya estaba publicado:
si un prestamista ejecuta primero, tomas el préstamo, el listado
existente en OpenSea se traslada a través de la inicialización del
préstamo hasta su expiración Seaport original, y una ejecución
posterior en marketplace antes de esa expiración dispara la cascada
de liquidación del diamond para cerrar el préstamo con los ingresos
de la venta (ver Escenario B abajo). Para ofertas GTT ordinarias
esta expiración es el Good-Til-Time original de la oferta; la
aceptación del prestamista no extiende ni vuelve a publicar el
listado para el término completo del préstamo. Si un comprador en
marketplace ejecuta primero, nunca se crea un préstamo (Escenario
A). Los dos escenarios terminan en estados distintos de la oferta:
el Escenario A marca la oferta con `consumed_by_sale` vía
`markOfferConsumedBySale` (aparece bajo el filtro Sold), y la
aceptación del prestamista está gateada contra cualquier oferta
que ya haya sido marcada. En el Escenario B la oferta ya está en
estado `Accepted` para cuando aterriza la ejecución del
marketplace; el contrato deliberadamente deja el estado de la
oferta en `Accepted` y solo liquida el préstamo desde la venta —
la oferta no transita a Sold por segunda vez.

**Naturaleza de dos pasos.** Optar a la creación de la oferta
solamente activa la bandera de elegibilidad en la oferta. Conseguir
un listado realmente comprable en OpenSea es un PASO DOBLE SEPARADO
que la dapp NO automatiza hoy:

1. **Registrar + cablear en el diamond.** Llama a
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` mientras la oferta esté activa y antes de cualquier
   aceptación de prestamista. Una vez que la oferta sea aceptada,
   cancelada, o consumida por venta, esta llamada revierte como
   terminal; marcar el opt-in solo no es suficiente para crear un
   listado que pueda trasladarse al Escenario B. El ask también
   debe cubrir el piso pre-préstamo: principal más intereses
   peor-caso a través de la duración del préstamo y la ventana de
   gracia, recorte de tesorería sobre ese interés, el buffer de
   seguridad configurado, y todos los montos de fee-legs. Asks
   bajo-piso revierten en este paso. El argumento `feeLegs` es el
   ÚNICO lugar donde esta llamada registra las obligaciones de
   tarifas de protocolo OpenSea y royalties de creador: el diamond
   resta cada monto de fee-leg de los ingresos del vendedor y
   añade el destinatario + monto absoluto al array de
   consideration de Seaport. Pasar `feeLegs: []` en una colección
   con tarifas obligatorias produce una forma de orden que el paso
   de publicación de OpenSea rechazará (faltan los ítems de
   consideration de destinatarios de tarifas) y un fill directo
   en Seaport enrutará el ask completo al vendedor en lugar de
   dividir las tarifas como la colección requiere. Los usuarios
   avanzados deben fetch el calendario de tarifas obligatorias
   de OpenSea para la colección (el parser de tarifas in-repo en
   `apps/defi/src/lib/openseaFeeSchedule.ts` es la referencia) y pasar
   montos absolutos derivados contra el ask antes de llamar. El
   facet internamente construye los `OrderComponents` canónicos
   de Seaport a partir de esos inputs (más valores que retiene
   en `CollateralListingExecutor.offerContext` — la dirección del
   vault del prestatario, asset principal, campos de colateral,
   startTime, endTime) y el `Seaport.getCounter` actual del vault,
   deriva el orderHash vía `Seaport.getOrderHash`, lo retorna,
   registra el binding ERC-1271 del vault a ese hash, y otorga la
   aprobación del conduit de Seaport para el NFT colateral. El
   evento `PostParallelSaleListing` emitido expone los args de
   entrada (`offerId`, prestatario, orderHash, askPrice, datos
   de executor / conduit, salt, fee legs); NO retorna los
   campos por-contexto, así que reconstruir OrderComponents
   off-chain requiere las lecturas adicionales descritas en el
   paso 2 abajo. **Importante:** en este punto la orden ya es
   EJECUTABLE vía Seaport. Un bot mirando los eventos del
   contrato MÁS esas lecturas puede reconstruir los
   OrderComponents y llamar `Seaport.fulfillOrder` directamente
   — el listado no necesita aparecer en la UI de marketplace
   de OpenSea para que el camino de fill on-chain funcione.
   Si no quieres que contrapartes ejecuten al ask actual antes
   de que aterrice el paso 2, ya sea ejecuta el paso 2
   inmediatamente después del paso 1 O llama
   `releaseParallelSaleLock` para invalidar el binding antes
   de cualquier fill no intencionado.
2. **Publicar en OpenSea.** Reconstruye los mismos OrderComponents
   que el facet construyó. El evento `PostParallelSaleListing` por
   sí solo no es suficiente: emite `offerId`, prestatario,
   orderHash, askPrice, datos de executor / conduit, salt, y fee
   legs, pero la forma de orden offer-keyed también necesita
   valores retenidos en el storage `OfferContext` del executor
   (dirección del vault del prestatario, asset principal, campos
   de colateral, startTime, endTime) más el contador Seaport del
   vault del prestatario (el contador del offerer —
   `LibPrepayOrder.buildAndHashOfferMem` hashea
   `Seaport.getCounter(ctx.borrowerVault)`, NO el contador del
   bidder). Este es el mismo contexto usado por el camino
   offer-order de `LibPrepayOrder.buildAndHashOfferMem`, y es
   diferente de la forma de orden prepay-listing loan-keyed. Lee
   ambos antes de publicar:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     retorna el struct `OfferContext` persistido para ese hash.
   - `Seaport.getCounter(borrowerVault)` retorna el contador
     canónico de Seaport para el offerer del vault.
   Con esos campos en mano el struct OrderComponents reproduce
   exactamente el que el diamond hasheó. Antes de POSTear, añade
   el campo solo-API `parameters.totalOriginalConsiderationItems`
   — la API de OpenSea lo requiere aunque NO sea parte del struct
   Seaport que produce el hash canónico; los publishers in-repo
   (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) lo inyectan antes de
   llamar al endpoint. Para órdenes validadas por ERC-1271,
   OpenSea acepta el campo `signature` como `0x` (bytes vacíos)
   — el callback on-chain del vault `isValidSignature(orderHash,
   '')` ignora los bytes de la firma y retorna el valor mágico
   EIP-1271 para cualquier orderHash que el diamond haya
   registrado previamente (del paso 1). HAZ POST del JSON al
   endpoint de listings de OpenSea (`POST
   /api/v2/orders/{chain}/{protocol}/listings`, según los docs
   oficiales de [Create Listing](https://docs.opensea.io/reference/post_listing)
   — este es el mismo endpoint que usan los publishers propios
   de Vaipakam en `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts`). Solo después de este
   paso el listado aparece en la UI de marketplace de OpenSea
   y se vuelve descubrible para compradores casuales. Vaipakam
   no automatiza actualmente este envío para el camino
   parallel-sale — exponer la publicación de listados
   end-to-end está rastreado como seguimiento.

Los usuarios avanzados que sigan el camino manual hoy necesitan
AMBOS pasos para obtener visibilidad en OpenSea; correr solo el
paso 1 produce una orden que es ejecutable directamente a través
de Seaport (por un bot o contraparte que reconstruya los
componentes desde el evento) pero invisible en la UI de
marketplace de OpenSea.

**Modo de fill forzado a All-or-Nothing.** Optar fija
automáticamente el modo de fill de la oferta a `Aon` — modos de
fill Partial o IOC con la opción de venta paralela activada
crearían múltiples préstamos contra el colateral de una sola
oferta, contra lo que el contrato gatea. El toggle está oculto en
ofertas de prestamista, colateral ERC-20, principales NFT, y
cualquier otra forma que el `_validatePostParallelSale` del
contrato rechazaría, así que no puedes marcarlo accidentalmente
en una oferta no elegible.

**Lo que ve un comprador.**

- *Antes de que ningún prestamista acepte* (Escenario A): un
  comprador que ejecute el listado de OpenSea paga el precio
  listado. En colecciones con tarifas obligatorias, Seaport
  enruta los legs de tarifa de protocolo OpenSea y tarifa de
  creador directamente a sus destinatarios configurados primero;
  el executor pasa solo los **ingresos netos** (precio listado
  menos esos legs de tarifa de marketplace / creador) al diamond.
  El diamond pone en escrow ese monto neto en tu vault, el NFT
  se transfiere al comprador, y la oferta se marca
  `consumed_by_sale` (visible como estado "Sold" distinto en Mis
  Ofertas, Actividad, y Detalles de Oferta). Nunca se creó un
  préstamo; te quedas con los ingresos netos de la venta.
- *Después de que un prestamista acepte* (Escenario B): el
  listado se traslada a través de la inicialización del préstamo
  — ni el bloqueo del NFT del prestatario ni el listado se
  desmontan. Una ejecución posterior por comprador dispara la
  cascada de liquidación del diamond en una sola transacción
  Seaport. Misma nota de fee-leg que el Escenario A: en
  colecciones con tarifas obligatorias, Seaport enruta los legs
  de tarifa de protocolo OpenSea y tarifa de creador
  directamente a sus destinatarios configurados primero, y el
  executor pasa solo los **ingresos netos** (precio de venta
  menos tarifas de marketplace / creador) a la cascada del
  diamond. La cascada entonces enruta ese monto neto: el
  prestamista recibe su entitlement de liquidación (que
  `LibEntitlement.settlementInterest` calcula como el cupón
  completo cuando el préstamo se creó con `useFullTermInterest
  = true`, o el interés pro-rata acumulado al timestamp de
  liquidación de otra manera — el gate es la política del
  préstamo, no si la venta sucede antes o después de la madurez
  programada), el recorte de tesorería va a tesorería, y el
  resto se deposita DIRECTAMENTE en el vault del actual holder
  del NFT de posición del prestatario (vía
  `LibUserVault.getOrCreate` + un depósito al vault). No se
  crea reclamo en el Claim Center — revisa tu balance del vault
  después de que aterrice la venta.

**Lo que no puedes combinarlo con.** Dos clases de conflicto
distintas, superficializadas en diferentes etapas del protocolo:

- *Bloque en tiempo de publicación (listado sibling loan-keyed).*
  Si el préstamo ya tiene un listado parallel-sale trasladándose
  desde la creación de la oferta Y el prestatario luego llama
  `NFTPrepayListingFacet.postPrepayListing` (o
  `updatePrepayListing`) para publicar un SEGUNDO listado prepay
  loan-keyed sobre el mismo préstamo, el diamond revierte con
  `SiblingParallelSaleListingLive`. La aprobación de conduit
  para el NFT del prestatario es un solo slot — correr ambos
  listados concurrentemente crearía una aprobación ambigua. El
  prestatario ve el revert en la llamada de publicar/actualizar;
  nada se ejecuta.
- *Bloque en tiempo de fill (offset abierto de PrecloseFacet).*
  Si el préstamo tiene una oferta offset abierta de
  PrecloseFacet Y un comprador luego intenta ejecutar el listado
  parallel-sale, el `_settleLoanFromParallelSale` del diamond
  revierte con `ParallelSaleBlockedByOpenOffsetOffer`. El listado
  sigue siendo válido en OpenSea pero cualquier intento de fill
  revierte hasta que se borre el enlace offset. La dapp NO
  surface actualmente un banner / notificación dedicado en la
  página de Detalles del Préstamo para esta combinación; los
  usuarios verán fills revertir y pueden necesitar inspeccionar
  la razón del revert en un block explorer para diagnosticar. El
  camino de limpieza es la superficie ordinaria de cancelación
  de oferta — llama
  `OfferCancelFacet.cancelOffer(offsetOfferId)` para cancelar la
  oferta offset, lo que libera el enlace offset y desbloquea el
  fill parallel-sale (PrecloseFacet no tiene un punto de entrada
  separado de cancelación; el offset está bound a la oferta
  enlazada, así que cancelar la oferta enlazada lo borra). Una
  superficie UI dedicada para el conflicto está en cola como
  seguimiento de UX separado.


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
  envía un paquete Chainlink CCIP al receptor canónico en Base, que
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
- Saldo de VPFI en vault más la diferencia hasta el siguiente
  nivel.
- Porcentaje de descuento al nivel actual.
- Bandera de consentimiento a nivel de billetera.

Nota que el VPFI en vault también acumula 5% APR vía el pool de
staking —no hay acción separada de "stake". Depositar VPFI en tu
vault ES hacer staking.

<a id="buy-vpfi.buy"></a>

### Paso 1 — Compra VPFI con ETH

Envía la compra. En la cadena canónica, el protocolo mintea
directamente. En cadenas espejo, el adaptador de compra recibe el
pago, envía un mensaje cross-chain, y el receptor ejecuta la
compra en Base y puentea VPFI de vuelta. La comisión del puente más el
costo de la red de verificadores se cotiza en vivo y se muestra
en el formulario. El VPFI no se auto-deposita en vault —el Paso
2 es una acción explícita del usuario por diseño.

<a id="buy-vpfi.deposit"></a>

### Paso 2 — Deposita VPFI en tu vault

Un paso de depósito explícito separado, desde tu billetera a tu
vault en la misma cadena. Requerido en cada cadena —incluso la
canónica— porque el depósito en vault siempre es una acción
explícita del usuario por especificación. En cadenas donde está
configurado Permit2, la app prefiere el camino de firma única
sobre el patrón clásico de approve + deposit; hace fallback limpio
si Permit2 no está configurado en esa cadena.

<a id="buy-vpfi.unstake"></a>

### Paso 3 — Saca VPFI del staking en tu vault

Retira VPFI desde tu vault de vuelta a tu billetera. No hay
etapa de aprobación —el protocolo es dueño del vault y se debita
a sí mismo. El retiro dispara una refijación inmediata de la
tasa de descuento al nuevo (más bajo) saldo, aplicado a cada
préstamo abierto en el que estés. No hay ventana de gracia donde
aún aplique el nivel anterior.

---

## Recompensas

<a id="rewards.overview"></a>

### Sobre las recompensas

Dos flujos:

- **Pool de staking** — el VPFI en vault acumula al 5% APR
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
VPFI —retira VPFI desde el vault de vuelta a tu billetera. El
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

Prestamista, prestatario, vault del prestamista, vault del
prestatario y los dos NFTs de posición (uno por cada lado). Cada
NFT es un ERC-721 con metadatos on-chain; transferirlo transfiere
el derecho a reclamar. Los contratos de vault son
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
  colateral salga de tu vault.
- **Reclamar como prestatario** — sólo en estados terminales. Devuelve el
  colateral en repago total, o el reembolso de VPFI Loan
  Initiation Fee no usado en default / liquidación. Quema el NFT
  de posición de prestatario.

---

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Hacer match a ofertas de OpenSea sobre un prepay listing

Una vez que tu prepay listing esté vivo en el marketplace de
OpenSea, los compradores casuales a veces colocarán **ítem
offers** directamente sobre tu token — bids ligados a tu
colateral específico, no a cualquier token en la colección.
Vaipakam surface estos item offers en la página de Detalles del
Préstamo en tiempo real — un panel separado bajo "List collateral
on OpenSea" con una fila por oferta entrante. El panel aplica un
**umbral de buffer** — el entitlement de liquidación del
prestamista (que YA INCLUYE principal más el cupón completo en
préstamos full-term-interest o el interés pro-rata de otra manera
— ver `PrepayListingFacet.getPrepayContext().lenderLeg`), más el
recorte de tesorería, más un buffer de seguridad — y **engrisa**
ofertas que no lo claren. Puedes ver el interés del mercado en
cada nivel pero solo puedes hacer Match a ofertas que el
protocolo realmente liquidará.

Las ofertas colección-amplias / criteria (bids que cualquier
token en la colección puede satisfacer) permanecen en OpenSea
pero **no aparecen** en el panel Match de la dapp — la
consideration multi-leg que el protocolo liquida no puede
reconstruirse contra una oferta criteria sin plomería del lado
del contrato que no está en v1. Si tu única demanda entrante es
colección-amplia, el camino práctico hoy es esperar un bid
ítem-específico O dejar el listado en tu ask fijo y dejar que
cualquier comprador lo ejecute directamente. No puedes liquidar
manualmente un bid colección-amplio tú mismo — el NFT colateral
vive en tu vault de Vaipakam, y las órdenes Seaport del lado de
Vaipakam son la única forma de liquidación autorizada.

En colecciones que aplican tarifas de protocolo de OpenSea y/o
royalties de creador, la dapp SÍ renderiza el panel de ofertas —
el fetch del calendario de tarifas desde la API de OpenSea se
trata como asesor; los datos reales de fulfillment se fetcean
EN TIEMPO DE CLICK DE MATCH. El panel Match se renderiza
independientemente del estado del fetch del calendario de tarifas;
el fetch de fulfillment en tiempo de click es el gate. Si ese
fetch falla (rate limit, caída de API, o forma de colección no
soportada), el handler del lado de la dapp del click ABORTA
antes de que se construya cualquier transacción
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` — sin calldata,
sin prompt de firma, sin revert. La función on-chain en sí no es
un selector que retorne `bool`; cuando sí corre retorna un
`bytes32` orderHash o revierte. Así que el panel de una colección
con tarifas obligatorias puede mostrar ofertas que puedes
explorar pero no todas son clickeables-para-match en un momento
dado.

Cuando encuentras una oferta aceptable y haces click en **Match
offer**, la dapp abre el modal **Confirm Match**, que reitera el
matched value (el monto bruto de la oferta de OpenSea — NO el
monto neto al que el diamond liquida; en colecciones con tarifas
obligatorias
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` calcula
`effectiveAsk = offerValue - bidderFeeTotal` antes de correr la
división prestamista / tesorería / prestatario, así que el neto
que el diamond realmente distribuye es menor que el headline del
modal) y da una explicación genérica del flujo atomic-match.
Después de confirmar, la dapp envía una sola transacción
`matchOpenSeaOffer` que paquetiza la oferta del bidder con una
contra-orden recién construida del lado del diamond en una sola
llamada `matchAdvancedOrders` de Seaport — el fulfillment del
bidder, el leg lado-listing de la contra-orden (haya o no tenido
un prepay listing v1 previo vivo; el camino atómico soporta
`existingHash == 0`), y la cascada de liquidación del diamond
aterrizan atómicamente en un bloque. La transacción ya sea tiene
éxito completamente (préstamo liquidado, NFT transferido,
ingresos de venta divididos) o revierte completamente (nada se
mueve), y NO HAY ventana entre la rotación del listing y la
liquidación en la que un comprador tercero pudiera entrar al
precio matched.

> **Sin ventana de carrera — atómico por construcción.** Este es
> el cierre estructural del patrón v1 de dos pasos "cancel +
> post": bajo v1 la dapp rotaría el listing como una transacción
> separada `updatePrepayListing`, dejando el precio rotado vivo
> en OpenSea hasta que el `fulfillOrder` del bidder aterrice en
> un bloque posterior — cualquiera mirando el mempool podría
> snipear al bidder fuera del precio que pujó. El camino atómico
> cierra ese hueco vinculando ambas órdenes en una llamada
> Seaport match: o el bidder ejecuta al precio acordado o la
> transacción entera revierte.

**Lo que aún quieres verificar antes de hacer click en Match:**

- **Confirma el matched value en el modal.** El modal surface el
  monto bruto de la oferta de OpenSea. En colecciones con
  tarifas obligatorias, el diamond liquida contra el effective
  ask neto después de legs de tarifa de marketplace / creador
  del lado del bidder, así que el valor del modal puede ser
  mayor que el monto usado para la división prestamista /
  tesorería / prestatario. La dirección del bidder y la división
  precisa no están desglosadas ni en el modal NI en la fila del
  panel OpenSea Offers (la fila muestra valor, payment token,
  tipo de oferta, bidder truncado, y end time). La división se
  aplica on-chain por el diamond en la liquidación — el buffer
  de liquidación del protocolo garantiza que el effective ask
  cubra el entitlement de liquidación del prestamista (que ya
  incluye principal más el cupón completo en préstamos
  full-term-interest o el interés pro-rata de otra manera) más
  el recorte de tesorería, así que la división siempre es al
  menos neutral para ti. Si quieres ver la división proyectada
  antes de confirmar, el diamond expone
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  como una vista llamable — retorna los legs de prestamista y
  tesorería que la cascada de liquidación enrutará al timestamp
  dado, y el resto es tuyo.
- **Revisa la postura de tarifas de OpenSea para la colección.**
  Si la colección aplica tarifas de protocolo de OpenSea o
  royalties de creador, el camino atómico necesita plomería
  SignedZone `extraData` / criteria-resolver que la dapp fetcha
  vía el proxy de fulfillment-data de OpenSea del agente (PR
  #349) EN TIEMPO DE CLICK DE MATCH. El panel Match se renderiza
  independientemente del estado del fetch del calendario de
  tarifas; el fetch de fulfillment en tiempo de click es el
  gate. Si ese fetch falla (rate limit, caída de API, forma de
  colección no soportada), el handler del click del lado de la
  dapp aborta antes de construir la transacción on-chain
  `matchOpenSeaOffer` — no se construye calldata, no se dispara
  prompt de firma, no se muestra banner por adelantado. Puedes
  reintentar el click después (el fetch puede haber sido solo un
  blip transitorio de API), o ejecutar el listing directamente
  en OpenSea al ask listado mientras tanto.


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
vault durante todo el proceso —no hay ventana sin garantizar.
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
excedente en la nueva oferta se entrega a tu vault como
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
