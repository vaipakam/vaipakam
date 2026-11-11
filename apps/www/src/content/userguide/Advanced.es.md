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

<a id="chapter.dashboard"></a>

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

Una bandera de opt-in a nivel de billetera que convierte tu VPFI en
un descuento de comisiones. **Como prestatario**, el descuento es una
reducción directa de la Loan Initiation Fee, cobrada en el activo
prestado al aceptarse el préstamo; no se debita nada de tu vault por
ello. **Como prestamista**, el descuento de rendimiento se aplica en
la liquidación y, si hay una referencia de precio de VPFI configurada,
puede liquidarse en VPFI desde tu vault, dejándote la comisión íntegra
en el activo prestado. Por defecto: desactivado.
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

El nivel se calcula contra tu saldo de vault **posterior al cambio** en
el momento en que depositas o retiras VPFI. La tasa que realmente se
cobra se resuelve en la liquidación a partir de tu nivel en ese
instante: no se toma ningún promedio aparte sobre la vida de cada
préstamo. La salvaguarda es el nivel mismo: un promedio ponderado en el
tiempo de tu saldo diario durante una ventana reciente de como mucho 30
días — un ajuste del protocolo, contada desde el día en que empezó tu
tenencia actual y con los días más recientes pesando más. Ese promedio
se rebaja después al nivel más bajo al que hayas caído en cualquier
momento desde que empezó esa tenencia, mirando hasta 30 días atrás.

**Son dos retrocesos distintos, y el segundo suele ser el más largo.**
La ventana del promedio es configurable y puede fijarse por debajo de
30 días; el retroceso del nivel más bajo no está atado a ella: abarca
toda tu tenencia actual, con un tope de 30 días. Así que con una
ventana de 14 días, una caída de hace 20 días sigue rebajando tu nivel
aunque quede completamente fuera del promedio.

Tu nivel es cero por completo hasta que hayas mantenido un saldo
distinto de cero de forma **continua** durante un número mínimo de
días, también un ajuste del protocolo. Ese contador arranca cuando tu
saldo pasa de cero a positivo y sólo vuelve a empezar si regresa a
cero: añadir a una tenencia que ya tenías no lo reinicia.

Por eso un retiro muerde de inmediato en cada préstamo abierto en el
que estés —no hay ventana de gracia donde tu nivel anterior (más alto)
aún se aplique. Esto cierra el patrón de abuso en el que un usuario
podría recargar VPFI justo antes del cierre de un préstamo, capturar el
descuento del nivel completo y retirar segundos después. Fíjate en qué
regla lo cierra: quien lleva tiempo manteniendo el saldo ya cumplió el
periodo mínimo, así que el trabajo lo hace la regla del nivel más bajo
—algo que un promedio no podría hacer, porque a un promedio lo levanta
una recarga tardía y a un mínimo no.

Frente a ese patrón concreto, la regla actual es la más fuerte de las
dos. **No** es más estricta en todos los aspectos: como el retroceso
del nivel más bajo alcanza como mucho 30 días, los primeros meses de
nivel bajo de un préstamo largo acaban dejando de contar, mientras que
un promedio sobre toda la vida del préstamo los habría conservado. El
cambio reforzó la defensa contra la recarga breve y acortó la memoria.

**Eso vale para la comisión de rendimiento del prestamista.** La tasa del
prestatario para la comisión de iniciación se lee una sola vez al aceptarse el
préstamo; después, ni un retiro ni una recarga la mueven.

El descuento se aplica a la comisión por rendimiento del prestamista
en la liquidación, y a la Loan Initiation Fee del prestatario, donde
es una **reducción directa de la comisión que pagas en el activo
prestado**, aplicada al aceptarse el préstamo. No se retira VPFI de
tu vault para pagar esa comisión, y no hay ningún reembolso que
reclamar después.

> **Si esperas un reembolso de la Loan Initiation Fee, lee esto.**
> Un modelo anterior cobraba la comisión completa en VPFI por
> adelantado, la mantenía en custodia durante toda la vida del
> préstamo y devolvía una parte al reclamar. **Esa vía se ha
> eliminado.** Nunca se abrió ningún préstamo con ella, así que
> ningún préstamo tiene VPFI retenido contra su comisión de inicio
> ni reembolso pendiente: esperarlo sería esperar un dinero que no
> puede llegar.

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
panorama de recompensas VPFI de la billetera conectada. La cifra
principal es la suma de las recompensas de interacción pendientes y
las recompensas de interacción reclamadas históricamente.

La fila de desglose muestra pendiente + reclamado y un enlace
profundo con chevron hacia la tarjeta de reclamación completa en su
página nativa:

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
intencional —ocultar la tarjeta en cero haría invisible el programa
de recompensas para usuarios nuevos hasta que entraran al Centro de
reclamaciones.

---

<a id="chapter.offer-book"></a>

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
otros son terminales del lado del indexador que recibirán tratamiento
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
  comprador en mercado ejecutó el listado del NFT colateral
  antes de que ningún prestamista aceptara. La oferta lleva el
  estado on-chain `consumed_by_sale`; la columna de tasa de la
  fila muestra la tasa a la que se publicó la oferta y la celda
  de colateral renderiza la forma NFT (token id para ERC-721,
  cantidad de copias para ERC-1155). La aplicación también muestra la
  fila en el feed de Actividad como `Offer sold via OpenSea`
  para el prestatario (creador de la oferta). El evento on-chain
  en sí es
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  tanto el id de la oferta COMO la dirección del executor están
  indexados on-chain, pero la dirección del prestatario / creador
  NO. La coincidencia de billetera del prestatario para el feed de
  Actividad es agregada por el indexador en tiempo de ingestión
  (hace un join con la fila de la oferta para buscar el creador),
  así el filtro por billetera encuentra al prestatario sin que el
  evento en sí los indexe.
- **Fully Filled (estado del indexador, sin chip todavía)** — solo
  para órdenes de rango. Cuando el matching de relleno parcial
  consume el presupuesto restante de la oferta (el último match
  completa el rango por completo, o un match parcial deja un
  remanente sub-dust), `OfferMatchFacet` emite
  `OfferClosed(FullyFilled | Dust)` y el indexador marca la fila
  de la oferta con `status = 'fullyFilled'`. El estado `accepted`
  del contrato y la etiqueta Filled on-chain de arriba están
  reservados para el terminal de aceptación directa, por lo
  que `fullyFilled` es distinto del lado del indexador. El
  `MyOfferStatus` de la aplicación aún no expone este terminal como
  su propio chip de filtro — `useMyOffers` actualmente ignora
  las filas con estado de indexador `fullyFilled` — así que una
  oferta de rango completamente llena efectivamente cae fuera
  de la vista Mis Ofertas hasta que llegue el chip dedicado.
  La superficie del chip está en cola como un seguimiento de
  UI separado.

Las ofertas pasadas-GTT (tiempo límite GTT) que nunca alcanzaron un
evento terminal aún no están expuestas como un chip de estado
distinto en la aplicación; actualmente caen bajo Active hasta que el
indexador registre un terminal. Un chip Expired dedicado está en
cola como seguimiento de UI separado.


<a id="offer-book.lender-offers"></a>

### Ofertas de prestamistas

Ofertas activas de creadores dispuestos a prestar. La aceptación la
realiza un prestatario. Hay un gate rígido en la inicialización: la
canasta de colateral del prestatario debe producir un Health Factor
de al menos 1,5 frente al monto principal solicitado por el
prestamista. La matemática de HF es del propio protocolo —el gate
no es eludible. El `{liveValue:treasuryFeeBps}`% de tesorería sobre los intereses se debita en
la liquidación terminal, no por adelantado.
Esa tasa queda fijada al crear el préstamo, así que un cambio posterior
de la comisión del protocolo deja un préstamo ya abierto con la tasa con
la que empezó.

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

<a id="chapter.create-offer"></a>

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
  `{liveValue:treasuryFeeBps}`% de tesorería sobre intereses.
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
  slippage para repagar al prestamista. El swap es permissionless —cualquiera puede
  dispararlo en el instante en que tu HF cae por debajo de 1,0.
- **Defaults con colateral ilíquido** — el default transfiere
  todo tu colateral al prestamista y no queda nada por reclamar.

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
ERC-721 o ERC-1155** y un **principal ERC-20**, la aplicación expone un
opt-in `Borrow or sell` debajo de la sección de colateral. Marcarlo
marca la oferta como elegible para un listado de venta paralela de
tu NFT colateral en OpenSea — una sola oferta que puede ser
ejecutada YA SEA por un prestamista (tomas el préstamo) O por un
comprador en mercado (vendes el NFT). El listado NO se
desmonta en la aceptación del prestamista si ya estaba publicado:
si un prestamista ejecuta primero, tomas el préstamo, el listado
existente en OpenSea se traslada a través de la inicialización del
préstamo hasta su expiración Seaport original, y una ejecución
posterior en mercado antes de esa expiración dispara la cascada
de liquidación del diamond para cerrar el préstamo con los ingresos
de la venta (ver Escenario B abajo). Para ofertas GTT ordinarias
esta expiración es el tiempo límite GTT original de la oferta; la
aceptación del prestamista no extiende ni vuelve a publicar el
listado para el término completo del préstamo. Si un comprador en
mercado ejecuta primero, nunca se crea un préstamo (Escenario
A). Los dos escenarios terminan en estados distintos de la oferta:
el Escenario A marca la oferta con `consumed_by_sale` vía
`markOfferConsumedBySale` (aparece bajo el filtro Sold), y la
aceptación del prestamista está barreraada contra cualquier oferta
que ya haya sido marcada. En el Escenario B la oferta ya está en
estado `Accepted` para cuando aterriza la ejecución del
mercado; el contrato deliberadamente deja el estado de la
oferta en `Accepted` y solo liquida el préstamo desde la venta —
la oferta no transita a Sold por segunda vez.

**Naturaleza de dos pasos.** Optar a la creación de la oferta
solamente activa la bandera de elegibilidad en la oferta. Conseguir
un listado realmente comprable en OpenSea es un PASO DOBLE SEPARADO
que la aplicación NO automatiza hoy:

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
   avanzados deben consulta el calendario de tarifas obligatorias
   de OpenSea para la colección (el parser de tarifas in-repo en
   `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** es la referencia) y pasar
   montos absolutos derivados contra el ask antes de llamar. El
   facet internamente construye los `OrderComponents` canónicos
   de Seaport a partir de esos inputs (plus valores que retiene
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
   — el listado no necesita aparecer en la UI de mercado
   de OpenSea para que el camino de fill on-chain funcione.
   Si no quieres que contrapartes ejecuten al ask actual antes
   de que aterrice el paso 2, ya sea ejecuta el paso 2
   inmediatamente después del paso 1 O llama
   `releaseParallelSaleLock` para invalidar el binding antes
   de cualquier fill no intencionado.
   Para colecciones con tarifas obligatorias, popula `feeLegs` del
   calendario de tarifas requeridas de OpenSea / creador de la
   colección antes de llamar a este paso. Usa solo filas de tarifa
   requeridas, no-cero; limita la lista al conteo de fee-leg
   soportado por el protocolo; convierte cada fila en un monto fijo
   absoluto en el asset principal al precio de ask elegido; y usa
   el destinatario de tarifa listado como destinatario del leg. Si
   una tarifa requerida se redondea a cero al ask elegido, el ask
   es demasiado pequeño para esa colección y el post no debe ser
   intentado. Pasar un array vacío es válido solo para colecciones
   sin tarifa. En colecciones con tarifas obligatorias puede
   producir una orden que falle en la publicación de OpenSea o no
   pueda satisfacer la forma de consideration requerida del
   marketplace.
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
   postor). Este es el mismo contexto usado por el camino
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
   (`apps/indexer/src/openseaPublish.ts`) lo inyectan antes de
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
   paso el listado aparece en la UI de mercado de OpenSea
   y se vuelve descubrible para compradores casuales. Vaipakam
   no automatiza actualmente este envío para el camino
   parallel-sale — exponer la publicación de listados
   end-to-end está rastreado como seguimiento.

Los usuarios avanzados que sigan el camino manual hoy necesitan
AMBOS pasos para obtener visibilidad en OpenSea; correr solo el
paso 1 produce una orden que es ejecutable directamente a través
de Seaport (por un bot o contraparte que reconstruya los
componentes desde el evento) pero invisible en la UI de
mercado de OpenSea.

**Modo de fill forzado a All-or-Nothing.** Optar fija
automáticamente el modo de fill de la oferta a `Aon` — modos de
fill Partial o IOC con la opción de venta paralela activada
crearían múltiples préstamos contra el colateral de una sola
oferta, contra lo que el contrato barreraa. El toggle está oculto en
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
  menos esos legs de tarifa de mercado / creador) al diamond.
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
  menos tarifas de mercado / creador) a la cascada del
  diamond. La venta es un repago financiado con el colateral, así que el
  diamond liquida ese monto neto exactamente como lo haría un repago
  en el momento de la ejecución: el préstamo pasa a repagado; lo que
  se le debe al prestamista (el cupón completo cuando el préstamo se
  creó con `useFullTermInterest = true`, si no el interés acumulado
  hasta ese momento, más cualquier descuento de la tarifa de
  rendimiento del prestamista) se deposita en el vault del
  prestamista y se paga al titular actual de la posición del
  prestamista mediante el reclamo de prestamista ordinario; la
  tesorería recibe su corte neto de ese descuento; y el resto se
  envía a la wallet del titular actual de la posición del
  prestatario. Si el resto no puede pagarse a esa wallet, se retiene y
  se paga mediante el reclamo de prestatario ordinario en el Claim
  Center. Al prestamista nunca se le paga dentro de la venta misma,
  así que nada de la wallet del prestamista puede detenerla.

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
  nothing se ejecuta.
- *Bloque en tiempo de fill (offset abierto de PrecloseFacet).*
  Si el préstamo tiene una oferta offset abierta de
  PrecloseFacet Y un comprador luego intenta ejecutar el listado
  parallel-sale, el `_settleLoanFromParallelSale` del diamond
  revierte con `ParallelSaleBlockedByOpenOffsetOffer`. El listado
  sigue siendo válido en OpenSea pero cualquier intento de fill
  revierte hasta que se borre el enlace offset. La aplicación NO
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


<a id="chapter.claim-center"></a>

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
- Los intereses acumulados menos el recorte de tesorería fijado al
  crear tu préstamo (`{liveValue:treasuryFeeBps}`% para préstamos
  creados a la tasa actual). Ese corte se
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
  colateral de vuelta. No llega con ella ningún reembolso de la
  Loan Initiation Fee: tu descuento ya se restó de la comisión al
  aceptarse el préstamo.
- **Una venta prepay que liquide el préstamo** — el colateral va al
  comprador, no vuelve a ti. Recibes el precio de venta menos el
  derecho del prestamista, el recorte de tesorería y las comisiones
  de vendedor que llevara el listado, pagado a quien tenga el NFT
  de posición de prestatario.
- **Swap-to-repay** — tu colateral se vende para cubrir la deuda,
  hasta un techo que tú fijas. Si lo fijas con holgura puede
  consumirse más de lo que la deuda exigía estrictamente; lo que no
  se consuma vuelve a ti. Un excedente en el activo del propio
  préstamo se paga normalmente de forma directa al titular del NFT
  de prestatario en vez de esperar como reclamación — salvo que ese
  titular esté bajo un bloqueo por sanciones, en cuyo caso queda
  retenido como reclamación.
- **Liquidación por HF o default** — compruébalo igualmente,
  puede quedar un excedente. Sólo se toma el valor suficiente
  para cubrir al liquidador, al prestamista y al tesoro, y el resto
  queda registrado como tu reclamación. Su FORMA depende de una sola cosa: si el
  colateral se VENDIÓ o se ENTREGÓ. Vendido —es decir, enrutado
  hacia fuera por un exchange— y el residuo te llega en el activo
  principal del préstamo. Entregado, y lo que queda es el colateral
  mismo, gravado en tu bóveda. Más de una cosa lo entrega, y ninguna depende de por cuál cierre hayas
  pasado: un liquidador que toma el colateral directamente con
  descuento, un cierre que se casa internamente contra una posición
  opuesta en lugar de ir a un exchange, y una venta que no pudo completarse — ahí el colateral te llega salvo que el prestamista aporte una
  cotización que funcione al reclamar — entonces cobras en el activo
  del préstamo; la mayoría de las reclamaciones no aportan ninguna. Tanto la liquidación
  ordinaria como un default por tiempo intentan ese casamiento
  interno ANTES de acudir a un exchange, así que ninguna de esas dos
  vías acaba siempre igual — por eso lo que hay que leer es la
  reclamación, no la vía. La vía con descuento sí es previsible,
  pero al revés: ni vende ni casa internamente, así que lo que te
  deja es siempre el colateral. Una liquidación
  parcial no es un cierre en absoluto — el préstamo sigue abierto
  y no se crea ninguna reclamación. Consulta la reclamación en
  lugar de suponer cuál tienes. En un default sobre un activo ilíquido suele irse la
  canasta entera y no queda nada — y en esa vía es la regla, no un
  resultado desafortunado.

El NFT de posición de prestatario se quema cuando reclamas, no
cuando se resuelve el préstamo — así que un excedente dejado por
una liquidación sigue ahí para recogerlo después. Que el NFT siga
existiendo no prueba por sí solo que haya excedente: si una
liquidación no dejó nada, no hay nada que recoger, reclamar se
rechaza y el NFT puede quedarse igualmente.
Lee la reclamación, no el NFT.

---

<a id="chapter.activity"></a>

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
reclamaciones, liquidaciones, mints y burns de NFT, y depósitos /
retiros de VPFI en vault.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### Conseguir VPFI

VPFI es libremente transferible. Adquiérelo en el mercado abierto
allá donde se negocie, o muévelo por puente: VPFI es un token
cross-chain de Chainlink CCIP, así que se mueve entre cadenas
compatibles usando el puente oficial y llega a tu billetera en la
cadena hacia la que hiciste el puente.

<a id="buy-vpfi.discount-status"></a>

### Tu estado de descuento VPFI

Estado en vivo:

- Nivel actual (0 a 4).
- Saldo de VPFI en vault más la diferencia hasta el siguiente
  nivel.
- Porcentaje de descuento al nivel actual.
- Bandera de consentimiento a nivel de billetera.

El VPFI en vault cuenta para tu tier de descuento mientras siga
depositado —no hay una acción separada de "stake".

<a id="buy-vpfi.deposit"></a>

### Deposita VPFI en tu vault

Un paso de depósito explícito, desde tu billetera a tu vault en la
misma cadena. Requerido en cada cadena —incluso la canónica— porque
el depósito en vault siempre es una acción explícita del usuario por
especificación. En cadenas donde está configurado Permit2, la app
prefiere el camino de firma única sobre el patrón clásico de approve
+ deposit; hace fallback limpio si Permit2 no está configurado en esa
cadena.

<a id="buy-vpfi.unstake"></a>

### Saca VPFI de tu vault

Retira VPFI desde tu vault de vuelta a tu billetera. No hay
etapa de aprobación —el protocolo es dueño del vault y se debita
a sí mismo. El retiro dispara una refijación inmediata de la
tasa de descuento al nuevo (más bajo) saldo, aplicado a cada
préstamo abierto en el que estés. No hay ventana de gracia donde
aún aplique el nivel anterior.

<a id="buy-vpfi.cross-chain-tier"></a>

### Cómo viaja tu tier de VPFI entre cadenas

Tienes tu VPFI en tu vault en Base, la cadena canónica, y es Base quien
calcula tu tier. Cuando pides prestado o prestas en otra cadena, esa
cadena aplica una copia de tu tier, que Base envía por Chainlink CCIP
después de cada depósito, retiro u otra acción que lo cambie.

Tres cosas que debes saber:

- **Un tier que sube solo con el paso del tiempo necesita una acción
  en Base para viajar.** Cuando termina tu periodo de tenencia, o tu
  promedio alcanza a tu saldo, sin depósito ni retiro, la cifra de Base
  queda al día de inmediato. Las demás cadenas se enteran con tu
  próximo depósito o retiro en Base, de cualquier importe.
- **Un tier más bajo viaja primero.** El protocolo envía un tier más
  bajo de inmediato y paga uno más alto como mucho una vez al día por
  cadena. La entrega por CCIP suele tardar luego unos minutos. Hasta
  que llega, esa cadena sigue aplicando tu tier anterior.
- **Una copia puede caducar.** Tras 60 días sin una copia nueva (el
  valor por defecto), o en cuanto un cambio de la tabla de tiers llega
  a esa cadena, la copia antigua deja de dar descuento allí. Solo se
  envía una copia nueva cuando tu tier cambia.

Las reglas completas, incluido el interruptor de descuento que
necesitas en Base además de en la cadena que uses, están en el
capítulo «Cómo funcionan los descuentos VPFI» más abajo. El diseño de
la entrega está en el
[documento de diseño de la entrega de tiers](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
(en inglés).

---

<a id="chapter.rewards"></a>

## Recompensas

<a id="rewards.overview"></a>

### Sobre las recompensas

El **pool de interacción** paga una cuota diaria pro-rata de una
emisión diaria fija, ponderada por tu contribución de intereses
liquidados al volumen de préstamos de ese día. Las ventanas diarias
se finalizan de forma lazy en la primera reclamación o liquidación
después del cierre de ventana.

Las recompensas se mintean directamente en la cadena activa —no hay
ida y vuelta cross-chain para el usuario. La agregación cross-chain
de recompensas ocurre sólo entre contratos del protocolo.

<a id="rewards.claim"></a>

### Reclamar recompensas

Una sola transacción reclama tus recompensas acumuladas. Las
recompensas de interacción son cero hasta que la ventana diaria
relevante se finalice (finalización lazy disparada por la siguiente
reclamación o liquidación distinta de cero en esa cadena). La UI
bloquea el botón mientras la ventana aún se está finalizando para que
los usuarios no reclamen de menos.

<a id="rewards.withdraw-staked"></a>

### Retirar VPFI de tu vault

Superficie idéntica a "Saca VPFI de tu vault" en la sección VPFI
—retira VPFI desde el vault de vuelta a tu billetera. El VPFI
retirado sale del acumulador de descuento inmediatamente (refijación
posterior al saldo en cada préstamo abierto).

---

<a id="chapter.loan-details"></a>

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
prestamista y no queda nada por reclamar.

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
  principal más intereses menos el recorte de tesorería fijado al
  crear tu préstamo (`{liveValue:treasuryFeeBps}`% para préstamos
  creados a la tasa actual; reducido aún más por tu descuento de
  yield-fee VPFI ponderado por tiempo cuando el consentimiento está
  activado). Quema el NFT de
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
  pendiente y sube HF; el total dispara la liquidación terminal.
- **Preclose directo** — paga el monto pendiente desde tu
  billetera ahora y libera colateral.
- **Preclose offset** — vende parte del colateral vía el router
  de swap del protocolo, repaga con lo recibido, y devuelve el
  remanente. Dos pasos: iniciar, luego completar.
- **Refinanciar** — publica una oferta de prestatario con nuevos
  términos; una vez que un prestamista acepta, completar el
  refinance intercambia los préstamos atómicamente sin que el
  colateral salga de tu vault.
- **Reclamar como prestatario** — sólo en estados terminales. Devuelve el
  colateral en repago total; en default o liquidación puede quedar un
  excedente, ya que sólo se toma el colateral que exigen la deuda y
  el coste de cerrarla — véase la sección del Claim Center más
  arriba. Quema el NFT de posición de prestatario.

---

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Hacer match a ofertas de OpenSea sobre un prepay listing

Una vez que tu prepay listing esté vivo en el mercado de
OpenSea, los compradores casuales a veces colocarán **ítem
offers** directamente sobre tu token — pujas ligados a tu
colateral específico, no a cualquier token en la colección.
Vaipakam muestra estos item offers en la página de Detalles del
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

Las ofertas colección-amplias / criteria (pujas que cualquier
token en la colección puede satisfacer) permanecen en OpenSea
pero **no aparecen** en el panel Match de la aplicación — la
consideration multi-leg que el protocolo liquida no puede
reconstruirse contra una oferta criteria sin plomería del lado
del contrato que no está en v1. Si tu única demanda entrante es
colección-amplia, el camino práctico hoy es esperar un puja
ítem-específico O dejar el listado en tu ask fijo y dejar que
cualquier comprador lo ejecute directamente. No puedes liquidar
manualmente un puja colección-amplio tú mismo — el NFT colateral
vive en tu vault de Vaipakam, y las órdenes Seaport del lado de
Vaipakam son la única forma de liquidación autorizada.

En colecciones que aplican tarifas de protocolo de OpenSea y/o
royalties de creador, la aplicación SÍ renderiza el panel de ofertas —
el consulta del calendario de tarifas desde la API de OpenSea se
trata como asesor; los datos reales de fulfillment se fetcean
EN TIEMPO DE CLICK DE MATCH. El panel Match se renderiza
independientemente del estado del consulta del calendario de tarifas;
el consulta de fulfillment en tiempo de click es el barrera. Si ese
consulta falla (rate limit, caída de API, o forma de colección no
soportada), el handler del lado de la aplicación del click ABORTA
antes de que se construya cualquier transacción
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` — sin calldata,
sin prompt de firma, sin revert. La función on-chain en sí no es
un selector que retorne `bool`; cuando sí corre retorna un
`bytes32` orderHash o revierte. Así que el panel de una colección
con tarifas obligatorias puede mostrar ofertas que puedes
explorar pero no todas son clickeables-para-match en un momento
dado.

Cuando encuentras una oferta aceptable y haces click en **Match
offer**, la aplicación abre el cuadro de confirmación **Confirmar match**, que reitera el
valor emparejado (el monto bruto de la oferta de OpenSea — NO el
monto neto al que el diamond liquida; en colecciones con tarifas
obligatorias
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` calcula
`effectiveAsk = offerValue - bidderFeeTotal` antes de correr la
división prestamista / tesorería / prestatario, así que el neto
que el diamond realmente distribuye es menor que el importe principal mostrado del
cuadro de confirmación) y da una explicación genérica del flujo atomic-match.
Después de confirmar, la aplicación envía una sola transacción
`matchOpenSeaOffer` que paquetiza la oferta del postor con una
contra-orden recién construida del lado del diamond en una sola
llamada `matchAdvancedOrders` de Seaport — el fulfillment del
postor, el leg lado-listing de la contra-orden (haya o no tenido
un prepay listing v1 previo vivo; el camino atómico soporta
`existingHash == 0`), y la cascada de liquidación del diamond
aterrizan atómicamente en un bloque. La transacción ya sea tiene
éxito completamente (préstamo cerrado como repagado, NFT transferido,
ingresos de venta divididos) o revierte completamente (nada se
mueve), y NO HAY ventana entre la rotación del listing y la
liquidación en la que un comprador tercero pudiera entrar al
precio matched.

> **Sin ventana de carrera — atómico por construcción.** Este es
> el cierre estructural del patrón v1 de dos pasos "cancel +
> post": bajo v1 la aplicación rotaría el listing como una transacción
> separada `updatePrepayListing`, dejando el precio rotado vivo
> en OpenSea hasta que el `fulfillOrder` del postor aterrice en
> un bloque posterior — cualquiera mirando el mempool podría
> snipear al postor fuera del precio que pujó. El camino atómico
> cierra ese hueco vinculando ambas órdenes en una llamada
> Seaport match: o el postor ejecuta al precio acordado o la
> transacción entera revierte.

**Lo que aún quieres verificar antes de hacer click en Match:**

- **Confirma el valor emparejado en el cuadro de confirmación.** El cuadro de confirmación muestra el
  monto bruto de la oferta de OpenSea. En colecciones con
  tarifas obligatorias, el diamond liquida contra el effective
  ask neto después de legs de tarifa de mercado / creador
  del lado del postor, así que el valor del cuadro de confirmación puede ser
  mayor que el monto usado para la división prestamista /
  tesorería / prestatario. La dirección del postor y la división
  precisa no están desglosadas ni en el cuadro de confirmación NI en la fila del
  panel OpenSea Offers (la fila muestra valor, payment token,
  tipo de oferta, postor truncado, y end time). La división se
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
  SignedZone `extraData` / criteria-resolver que la aplicación consultaa
  vía el proxy de fulfillment-data de OpenSea del agente (PR
  #349) EN TIEMPO DE CLICK DE MATCH. El panel Match se renderiza
  independientemente del estado del consulta del calendario de
  tarifas; el consulta de fulfillment en tiempo de click es el
  barrera. Si ese consulta falla (rate limit, caída de API, forma de
  colección no soportada), el handler del click del lado de la
  aplicación aborta antes de construir la transacción on-chain
  `matchOpenSeaOffer` — no se construye calldata, no se dispara
  prompt de firma, no se muestra banner por adelantado. Puedes
  reintentar el click después (el consulta puede haber sido solo un
  blip transitorio de API), o ejecutar el listing directamente
  en OpenSea al ask listado mientras tanto.

---

<a id="chapter.how-liquidation-actually-works"></a>

## Cómo funciona realmente la liquidación

Las Divulgaciones de Riesgo que aceptaste al momento de la oferta resumen el resultado en el peor de los casos en dos frases. Esta sección explica la mecánica subyacente, útil si quieres entender POR QUÉ existe el respaldo en especie (in-kind fallback), o cuál de las cuatro ramas tomaría realmente tu préstamo.

La función del contrato que decide la división es `LibFallback.computeFallbackEntitlements`. Recorre cuatro casos en orden; el PRIMERO que coincide es el que se ejecuta.

<a id="liquidation-mechanics.case-1"></a>

### Caso 1 — Oráculo disponible, colateral vale ≥ monto adeudado

El camino saludable. Los feeds de precios de Chainlink responden, el quórum secundario Soft 2-de-N (Tellor + API3 + DIA) no ha discrepado, y el colateral incautado cubre el monto adeudado cuando se valora contra el oráculo.

Qué sucede:

- El prestamista recibe **activos de colateral** por valor de (principal + intereses acumulados + un bono de respaldo del 3%), valorados en el oráculo. En efecto: el prestamista es compensado a valor justo, pagado en el activo de colateral en lugar del activo prestado.
- La tesorería recibe una prima del 2% del principal, también valorada en colateral.
- El prestatario recibe el **remanente** del colateral de vuelta. Este es un reembolso real — es el exceso de colateralización que no fue necesario para cubrir la reclamación del prestamista.

Ejemplo práctico: un préstamo de 1000 USDC contra 0.6 WETH ($3000 de colateral, $1000 de deuda). El oráculo valora el ETH en $5000 / WETH; deuda + intereses + bono = $1050. El prestamista recibe 0.21 WETH (valor de $1050), la tesorería recibe 0.004 WETH (valor de $20 de la prima del 2%), el prestatario recibe los ~0.386 WETH restantes.

<a id="liquidation-mechanics.case-2"></a>

### Caso 2 — Oráculo disponible, colateral vale < monto adeudado

El camino "bajo el agua". El oráculo funciona, pero el colateral incautado vale menos que el monto adeudado incluso al precio del oráculo. Común en caídas de activos volátiles donde el valor del colateral cae más rápido de lo que el HF puede reaccionar.

Qué sucede:

- El prestamista recibe **TODO** el colateral incautado, en el activo de colateral.
- La tesorería no recibe nada.
- El prestatario no recibe nada — no hay remanente para reembolsar.

El prestamista absorbe el déficit. No existe ninguna reclamación posterior contra el prestatario, el protocolo o cualquier tercero. Este es el caso sobre el cual advierte específicamente la línea "la recuperación puede ser menor que el activo prestado" de las Divulgaciones de Riesgo.

Ejemplo práctico: mismo préstamo de 1000 USDC / 0.6 WETH, pero el ETH cae a $1500 / WETH. El colateral ahora vale $900; la deuda es de $1050. El prestamista recibe los 0.6 WETH íntegros (valor de $900), tesorería 0, prestatario 0.

<a id="liquidation-mechanics.case-3"></a>

### Caso 3 — Quórum del oráculo NO DISPONIBLE

El camino del "quórum oscuro". La obsolescencia de Chainlink supera el techo de volatilidad Y el quórum secundario 2-de-N no puede ponerse de acuerdo (cada secundario está fuera de línea o discrepa con el primario). El protocolo no tiene un precio confiable para ninguno de los lados del préstamo, por lo que no puede calcular una división justa.

Qué sucede:

- El prestamista recibe **TODO** el colateral incautado, en el activo de colateral, **independientemente del valor calculado** (porque ningún cálculo es confiable).
- La tesorería no recibe nada.
- El prestatario no recibe nada.

Mismo pago que el Caso 2, pero alcanzado por una razón fundamentalmente diferente: el protocolo no está decidiendo que "el colateral vale menos que la deuda" — está decidiendo "No puedo confiar en ningún número aquí, así que el prestamista recibe la canasta incautada completa y absorbe lo que sea que valga en el mercado abierto".

Se emite un evento on-chain diferente (`LiquidationFallbackOracleUnavailable`) para que los auditores puedan distinguir los dos caminos en el análisis post-mortem.

<a id="liquidation-mechanics.case-4"></a>

### Caso 4 — Activo ilíquido en cualquier lado

El camino de activos ilíquidos. El activo prestado, el activo de colateral, o ambos no califican como Líquidos en el clasificador del protocolo (sin feed de Chainlink, o sin pool de liquidez concentrada tipo Uniswap-V3 por encima del umbral de volumen). Común para colateral NFT y tokens de baja liquidez.

Qué sucede al momento del default:

- El prestamista recibe el **colateral completo** en especie, independientemente del valor de mercado.
- No hay partición entre "monto adeudado" y "remanente" — no se puede aplicar la valoración del oráculo.
- El activo puede valer materialmente más o menos que el monto adeudado. Sin garantía de reventa.

Ambas partes consintieron esto cuando se creó la oferta — la cláusula de activos ilíquidos de las Divulgaciones de Riesgo cubre exactamente este caso. No puedes llegar a esta rama a menos que ambas partes hayan elegido a sabiendas realizar un préstamo que involucre un activo ilíquido.

<a id="liquidation-mechanics.why-in-kind"></a>

### ¿Por qué en especie, por qué no siempre efectivo?

Tres razones por las que el protocolo paga en unidades del activo de colateral en lugar de cambiar siempre al activo prestado:

- **Corte de Secuenciador / DEX**: cuando el protocolo no puede ejecutar un swap de forma segura (slippage > 6%, liquidez escasa, reversión de DEX, secuenciador caído), la acción más segura es entregar lo que ya tiene — el colateral incautado — directamente. Forzar un swap a cualquier costo consolidaría las pérdidas.
- **Escenario de cisne negro**: en cascadas volátiles, un camino con oráculo disponible puede desaparecer en cuestión de minutos. Mantener el respaldo en especie pre-instalado permite que el protocolo siga funcionando incluso cuando cada fuente de precio está degradada.
- **Recuperación por par de contrapartes**: al momento de reclamar, el prestamista (o su bot keeper) obtiene una segunda oportunidad a través del failover completo de 4 DEX. Si las condiciones se han normalizado para entonces, pueden vender el colateral en especie por el activo prestado a través de la misma infraestructura de enrutamiento que intentó el camino al momento de la liquidación.

<a id="liquidation-mechanics.claim-time-retry"></a>

### Reintento al momento de reclamar

`ClaimFacet.claimAsLenderWithRetry` permite que el prestamista (o un keeper que actúe sobre el NFT del prestamista) proporcione una lista de reintentos ordenada de llamadas a adaptadores de swap (0x → 1inch → Uniswap V3 → Balancer V2) cuando el préstamo está en `FallbackPending`. La librería itera la lista, confirma al primer éxito, y reescribe las reclamaciones del prestamista + prestatario a ingresos en el activo principal.

El fracaso total deja intacta la división de colateral registrada y transiciona el préstamo de forma terminal a Defaulted — momento en el cual el prestamista toma el colateral en especie y es libre de venderlo a través de cualquier vía externa.

<a id="liquidation-mechanics.internal-match-rescue"></a>

### Rescate por match interno pre-reclamación

Antes de que se ejecute cualquier swap externo — en la liquidación por HF, en el default por tiempo, Y al momento de reclamar — el protocolo primero verifica si existe un **préstamo en dirección opuesta** que pueda liquidar este sin ninguna intervención de DEX.

Si el préstamo A necesita vender WETH por USDC y el préstamo B necesita vender USDC por WETH, los dos pueden emparejarse directamente: el colateral de A cubre la deuda de B y viceversa, valorado al oráculo del protocolo. Sin agregador, sin slippage, sin comisión de swap. El prestatario conserva mucho más de su colateral; el prestamista es compensado al precio del oráculo.

Este camino de match interno se ejecuta automáticamente:

- **En la liquidación por HF**: cuando un keeper llama a liquidar y existe una contraparte opuesta, el protocolo liquida internamente en lugar de realizar el swap. El keeper sigue ganando un incentivo de matcher.
- **En el default por tiempo**: misma verificación antes del swap por default.
- **Al momento de reclamar**: cuando un prestamista reclama un préstamo estancado en `FallbackPending`, el protocolo vuelve a verificar si hay una contraparte opuesta. Esta es una verdadera segunda oportunidad: el grupo de préstamos emparejables crece continuamente, por lo que una contraparte que no existía cuando la liquidación falló por primera vez puede existir para cuando reclames.

Un préstamo que terminó en `FallbackPending` porque su swap al momento de la liquidación falló *transitoriamente* (un pico momentáneo de slippage, una reversión de DEX, un tick de oráculo obsoleto) es un candidato ideal para el rescate — el colateral subyacente suele ser todavía perfectamente líquido, y un préstamo opuesto puede liquidarlo limpiamente. El protocolo solo requiere que el oráculo aún pueda valorar el activo; no requiere que el DEX tenga profundidad, porque un match interno nunca toca un DEX.

Si no existe una contraparte opuesta, el protocolo cae en el camino del agregador externo descrito anteriormente. El match interno es una optimización de "mejor si está disponible", nunca un bloqueador.

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alertas

<a id="alerts.overview"></a>

### Sobre las alertas

Un watcher off-chain sondea cada préstamo activo que involucra a
tu billetera con una cadencia de 5 minutos, lee el Health Factor
en vivo de cada uno, y al cruzar una banda en dirección insegura
dispara una vez vía los canales configurados. No hay estado
on-chain ni gas. Las alertas son informativas —no mueven fondos.

<a id="alerts-inbox"></a>

### La bandeja de Alertas

La página Alertas lee la bandeja del índice para la wallet conectada en su red, lo más reciente primero, cincuenta filas cada vez. Una fila se escribe para la wallet que tiene la posición del préstamo en el momento de escribirla: préstamo iniciado; devolución parcial y total, incluidos el cierre anticipado, la refinanciación, el swap-to-repay y el cierre por venta de la garantía; impago o liquidación; cierre por emparejamiento interno; un préstamo que el índice vio terminar sin poder decir cómo; los avisos de vencimiento a 7 días y a 1 día; entrada y fin del periodo de gracia; y salud por debajo de 1,5, 1,2 y 1,05. Las filas de salud las escribe el keeper del protocolo, así que solo llegan mientras funciona y solo para préstamos a los que se aplica la salud. Las filas de último aviso y caducidad de una entrada de recompensa van a su dueño. Una fila es un puntero, nunca una cifra: la página del préstamo lee la cadena. Se rechaza una respuesta para otra red u otra wallet, las filas ilegibles se cuentan y un tipo desconocido se muestra por su nombre. El contador de la cabecera es el propio recuento del índice, sobre todas las filas, de las filas cuyo id supera el más reciente registrado como visto en este navegador; los ids solo crecen en orden de escritura, así que una fila con un bloque anterior también cuenta. Abrir la página registra como vistas todas las filas escritas hasta ese momento. La marca de visto vive solo en este navegador y solo avanza. Telegram, push, los avisos de salud y los recordatorios de pago se configuran justo debajo de la bandeja. Una fila es historial: dice cómo estaba el préstamo o la entrada cuando se escribió, nunca que siga así, y una fila de vencimiento de recompensa significa que la devolución de la entrada al programa ha comenzado, no que haya terminado.

<a id="alerts-channels"></a>

### Telegram, push y avisos

Cada cambio es una firma EIP-191 sobre un mensaje en texto claro que nombra la acción, la billetera, la red y la hora; el servicio de alertas acepta cada solicitud firmada una vez en diez minutos, y un guardado lleva solo el ajuste que cambia. El servicio guarda la billetera, la red, los ajustes y, una vez vinculado, el id del chat de Telegram; no los devuelve, así que cada tarjeta indica lo que hizo este navegador. El vínculo de Telegram solo se prueba cuando una alerta de prueba llega al chat. Desvincular con una billetera normal borra todas las redes, una cuenta inteligente solo la red firmada, y una red con el modo protegido activo mantiene el chat hasta que pasa el plazo de protección. Push solo se ofrece cuando el estado del servicio dice que ambos remitentes pueden enviar por un canal; si solo cubre el remitente de recordatorios, los avisos pueden no llegar por push. Las tres líneas de salud son por defecto 1,5, 1,2 y 1,05 y se pueden cambiar aquí, cada una por encima de la siguiente y la última por encima de 1,0. Vincular Telegram y activar push piden primero los Términos; desactivar nunca.

<a id="alerts-paid-push"></a>

### Avisos push de pago

Tu aceptación es un tope guardado en la cadena: lo máximo en VPFI que pagarás por lado del préstamo. La tarjeta lo muestra con el propio juicio del contrato sobre si cubre la comisión actual. En Básico aceptas la comisión actual; en Avanzado puedes escribir un tope desde la comisión hasta el límite del protocolo de 50 VPFI, y aceptar el límite acepta cualquier comisión que la gobernanza pueda fijar. Aceptar solo se ofrece donde el servicio de alertas dice que cobra, nunca a una billetera que el control de sanciones marca, y pide antes los Términos. Primero vienen la revisión y una simulación, y la comisión se vuelve a leer justo antes de abrir tu billetera: si cambió, no se envía nada. Retirar pone el tope a cero y se ofrece siempre que haya un tope guardado, incluso con el protocolo en pausa o sin poder consultar el servicio de alertas. Un despliegue sin el registro de aceptación no ofrece ninguna de las dos cosas, y la tarjeta dice si aún puede cobrar la comisión.

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Dashboard de analítica pública

<a id="public-dashboard.overview"></a>

### Acerca de Public Analytics

Una página sin wallet y de una sola cadena: lee la cadena a la que
apunta la app (la cadena de lectura por defecto si no hay wallet
conectada). No hay agregado entre cadenas ni exportación; para
comparar cadenas, abre la página en cada una. Dos fuentes, cada
una señalada donde se usa:

- la API de lectura del indexador, sin clave y con CORS abierto —
  las cifras de préstamos, ofertas, reciclaje y cierre del ciclo;
- las propias funciones de lectura del Diamond a través de un RPC
  público — las cifras del token VPFI y de comisiones.

Cualquiera de las dos se puede consultar directamente para
reproducir lo que muestra la página.

<a id="public-dashboard.loans-offers"></a>

### Préstamos y ofertas

Contadores de préstamos por estado de `/loans/stats`, incluidos
los grupos de liquidación pendiente, emparejados internamente y
resto, para que las partes sumen el total; los subtotales ERC-20 y
de alquiler de NFT, nombrando aparte cualquier préstamo activo cuyo
tipo de activo aún no se ha leído; y contadores de ofertas de
`/offers/stats`. Las ofertas son solo la tabla `offers` — las
órdenes firmadas sin gas no se cuentan — y las ofertas canceladas
salen del índice, así que el total de ofertas no es una cifra
histórica. Un contador ausente muestra «no informado» y uno
imposible «informado, pero no es un recuento utilizable»; ninguno
se muestra como 0.

<a id="public-dashboard.recycling"></a>

### Cuenta de reciclaje y cierre del ciclo

La cuenta de reciclaje (`/metrics/recycling`) lista el fondo de
cada día del programa, su financiación y lo retirado, etiquetado
con el índice de día propio del programa; un día sin finalizar
aparece sin fondo y un día no activado se marca como estimación.
El cierre del ciclo (`/metrics/loop-closure`) muestra, por día
UTC, lo que pagaron los reclamos, lo que quedó en los vaults y lo
absorbido, frente al momento hasta el que llega el registro. Los
importes positivos por debajo de la precisión mostrada se
etiquetan, las proporciones se redondean hacia abajo y una cifra
desconocida nunca se muestra como cero.

<a id="public-dashboard.transparency"></a>

### Transparencia y fuente

La dirección del Diamond con enlace al explorador, la cadena y el
bloque y la antigüedad del cursor del indexador. Cada cifra del
indexador está tan al día como ese cursor y no más; al combinar
dos respuestas, se indica el cursor más antiguo.

<a id="public-dashboard.vpfi-transparency"></a>

### Token VPFI

De `getVPFISnapshot()` en el Diamond: la dirección del token y el
`totalSupply` en esta cadena. En la cadena canónica, además el
tope, el margen (`cap − totalSupply`, lo que aún se puede acuñar) y
el minter. En una cadena espejo la instantánea no trae tope ni
minter — allí el suministro llega por el token pool de CCIP —, así
que la página muestra el suministro local y dice que el tope y el
minter pertenecen a la cadena canónica, en lugar de mostrar ceros.
Un token no vinculado y una instantánea ilegible se indican por
separado.

<a id="public-dashboard.fees"></a>

### Comisiones y tesorería

De `getTreasuryMetrics()`, `getTreasury()` y
`getNumeraireSymbol()`, leídos en el mismo agregado Multicall3 que
la instantánea y fijados a un bloque, que la página indica con su
antigüedad:

- comisiones desde que empezó el libro de comisiones, y en las
  últimas 24 horas y 7 días, cada una valorada en el numerario al
  registrarse y nunca revalorada;
- una comisión que el protocolo no pudo valorar al registrarse
  consta como 0, y las sumas de ventana recorren como mucho las
  últimas 10.000 entradas — ambas solo pueden quedarse cortas, y la
  página lo dice;
- un cambio de numerario deja las entradas anteriores en la unidad
  antigua, así que después los totales suman importes en dos
  unidades bajo el símbolo actual y pueden desviarse en cualquier
  sentido; la página dice que las comisiones anteriores se cuentan
  en la unidad antigua;
- la dirección de tesorería. Si es una dirección externa, las
  comisiones salen al cobrarse y no se muestra saldo para ella. Si
  el Diamond es su propia tesorería, se muestra lo que tiene,
  valorado solo sobre activos que aparecen en préstamos abiertos e
  incluyendo importes colocados en otro lugar en nombre de la
  tesorería.

Una función que falla muestra «no se pudo leer» y no oculta las
demás.

---

<a id="chapter.refinance"></a>

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
3. Marca el préstamo viejo como repagado. Sus NFTs de posición no
   se queman: ambos quedan con sus titulares, marcados Loan Repaid.
   El prestamista viejo reclama el repago con el suyo, y el NFT del
   prestatario viejo queda como recibo.
4. Mintea los NFTs de posición nuevos.

Revierte si HF bajo los nuevos términos quedaría por debajo de
1,5.

---

<a id="chapter.preclose"></a>

## Cierre anticipado

Esta página es sólo para prestatarios —el preclose lo inicia el
prestatario sobre su préstamo.

<a id="preclose.overview"></a>

### Sobre el preclose

Una terminación anticipada impulsada por el prestatario. Dos
caminos:

- **Directo** — paga el monto pendiente (principal + intereses
  acumulados) desde tu billetera y libera colateral.
- **Offset** — inicia el offset para vender parte del colateral
  vía el failover de swap de 4 DEX del protocolo por el activo
  principal, completa el offset para repagar con lo recibido, y
  el remanente del colateral te vuelve.

No hay penalización fija de cierre anticipado.

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

<a id="chapter.early-withdrawal-lender"></a>

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

---

<a id="chapter.stuck-token-recovery"></a>

## Recuperación de tokens atascados

Esta sección cubre un CASO EXCEPCIONAL que la mayoría de los usuarios nunca necesitarán. Lee todo antes de hacer clic en el enlace de recuperación en la parte inferior — declarar una fuente incorrecta puede bloquear tu vault bajo la política de sanciones del protocolo.

<a id="stuck-recovery.what"></a>

### Qué significa "token atascado"

Tu proxy de Vaipakam Vault es un almacenamiento interno del protocolo. NO es una dirección de depósito. Cada depósito soportado por el protocolo fluye a través de los puntos de entrada de los facets de Vaipakam, que extraen fondos de tu billetera hacia tu vault como parte de una creación de oferta, aceptación de préstamo u operación de staking. Los tokens que llegan al vault FUERA de ese flujo — una transferencia directa `IERC20.transfer` desde una billetera o un retiro de un CEX que copió y pegó la dirección de tu vault — se quedan allí sin contabilidad del protocolo. El Visor de Activos los oculta al mostrar solo el saldo rastreado por el protocolo.

Hay dos formas en que los tokens se atascan:

1. **Los enviaste tú mismo.** Copiaste la dirección de tu vault (desde el Dashboard o un explorador de bloques) en un campo de retiro de un CEX o en un formulario de envío de tokens de una billetera, y lo enviaste. Los tokens llegaron a tu vault sin pasar por la ruta de depósito del protocolo.

2. **Un tercero los envió ("ataque de polvo" o dust attack).** Alguien transfirió una pequeña cantidad a tu vault desde una billetera marcada, con la esperanza de asociar tu dirección con su reputación. Este es un vector de ataque real contra direcciones de alto perfil en cadenas sin permisos.

<a id="stuck-recovery.taint-poisoning"></a>

### Sobre el "envenenamiento por rastro"

Si el remitente tercero está en una lista de sanciones, las herramientas genéricas de análisis on-chain pueden marcar tu vault como "adyacente a sanciones" aunque nunca hayas tocado los tokens entrantes. No hay forma on-chain de deshacer esto — el evento de transferencia es permanente. La contabilidad INTERNA de Vaipakam no se ve afectada (solo rastreamos depósitos mediados por el protocolo, el polvo nunca entra en nuestro contador), por lo que tus préstamos / stakes / reclamaciones continúan funcionando normalmente. Pero las herramientas externas que no entienden nuestra contabilidad pueden mostrar advertencias.

<a id="stuck-recovery.dont-recover"></a>

### Cuándo NO recuperar

Si NO enviaste los tokens tú mismo, **no intentes recuperarlos**. La recuperación requiere que declares la dirección del remitente. Si esa dirección está en la lista de sanciones, tu vault quedará bloqueado bajo la política de sanciones del protocolo hasta que la fuente sea eliminada de la lista por el oráculo.

Los tokens que no enviaste no son tuyos. Recuperarlos declarando una dirección "limpia" que realmente no posees también es una mala idea — el protocolo no puede verificar la declaración on-chain, pero las herramientas externas de oráculo pueden discrepar más adelante.

La medida segura es ignorar el polvo no solicitado. No afecta tu saldo del protocolo ni ningún préstamo u oferta activa.

<a id="stuck-recovery.when-recover"></a>

### Cuándo SÍ recuperar

Enviaste los tokens tú mismo por error, controlas la billetera de origen y sabes que el origen no está en ninguna lista de sanciones (tu propia EOA, una billetera caliente de un CEX de la que retiraste, etc.).

<a id="stuck-recovery.flow"></a>

### Flujo de recuperación

1. Visita la [página de recuperación](https://defi.vaipakam.com/recover).
2. Ingresa la dirección del contrato del token, el origen desde el que enviaste y el monto.
3. Revisa cuidadosamente el reconocimiento en pantalla.
4. Escribe "CONFIRM" para habilitar la firma.
5. Firma el reconocimiento EIP-712 en tu billetera.
6. Envía la transacción.

Dos resultados:

- **Origen limpio** → los tokens se añaden al saldo registrado de tu vault. Retíralos de tu vault como de costumbre; si el modo de cuenta protegida está activo, se aplica su retraso de pago.
- **Origen marcado** → los tokens se quedan en el vault, tu vault queda bloqueado bajo la política de sanciones del protocolo. El bloqueo se levanta automáticamente si la dirección es eliminada posteriormente del oráculo de sanciones.

<a id="stuck-recovery.disown"></a>

### Desautorización de tokens no solicitados (registro de auditoría de cumplimiento)

Si deseas un registro público on-chain que afirme que cierto saldo de tokens en tu vault NO es tuyo, el protocolo proporciona una función `disownUntracked(kind, asset, tokenId)`. Emite un evento (`UntrackedDisowned`) y no cambia nada más — los tokens se quedan en el vault como antes. Útil en disputas de cumplimiento si un CEX o regulador pregunta "¿recibió estos fondos?": puedes señalar el evento on-chain.

La función disown está expuesta solo a través de llamada directa al contrato por ahora; el frontend de Vaipakam no la muestra como un botón. Usa una interfaz "Write Contract" de un explorador de bloques o una herramienta de interacción con contratos para llamarla.

<a id="chapter.how-vpfi-discounts-work"></a>

## Cómo funcionan los descuentos VPFI

El VPFI que tienes en tu vault en Base, la cadena canónica, te da un
descuento en las comisiones propias del protocolo, en todas las
cadenas donde funciona la plataforma. Cuanto más tengas, y cuanto más
tiempo lo hayas tenido, más alto es tu tier y mayor el descuento. Los
tiers están en la [escala de tiers](#dashboard.fee-discount-consent)
más arriba; la gobernanza puede cambiarlos.

A qué se aplica el descuento:

- **Como prestamista**, a la comisión de rendimiento que el protocolo
  retiene de los intereses que ganas. Se lee cada vez que se liquidan
  intereses, por ejemplo en el reembolso, el cierre anticipado o la
  refinanciación, con tu tier en ese momento, no con el que tenías al
  empezar el préstamo.
- **Como prestatario**, a la Loan Initiation Fee que se cobra al
  empezar el préstamo. Se lee una sola vez, al aceptarse, y queda
  fijada para ese préstamo. Solo se aplica si el activo prestado es
  líquido; un préstamo ilíquido paga la comisión completa.

El descuento se resta de la propia comisión, en el activo del
préstamo, y ningún VPFI sale de tu vault por ello. La única excepción
es el descuento del prestamista en un despliegue que configure una
referencia de precio de VPFI: allí puede liquidarse en VPFI desde tu
vault. No hay ninguna configurada en el lanzamiento. Este capítulo
trata de ese descuento por tenencia. Un modo de comisión de pago
distinto, «Full», sigue desactivado salvo que un despliegue lo active.

<a id="vpfi-discounts.turning-on"></a>

### Activar el descuento

El descuento es opcional (opt-in). El interruptor está en la página de
VPFI, y hay uno por cadena, porque cada cadena guarda su propio
ajuste:

- **En la cadena donde se cobra la comisión**, el interruptor debe
  estar activado; si no, esa cadena cobra la comisión completa sea
  cual sea tu tier.
- **En Base**, el interruptor también debe estar activado, aunque
  nunca pidas prestado ni prestes allí. Mientras esté desactivado,
  Base envía a todas las demás cadenas un tier cero para ti.

Cuando desactivas el descuento en Base, la aplicación envía a
continuación una actualización de tier para que todas las demás cadenas
también dejen de aplicarlo: Base les envía entonces un tier cero para
ti. Si ese segundo paso falla, la página lo indica, y las demás cadenas
conservan tu último tier hasta que algo envíe uno nuevo. Desactivarlo en
cualquier otra cadena solo cambia esa cadena.

El VPFI cuenta cuando el protocolo lo registra en tu vault: lo que
depositas desde la página de VPFI y las recompensas VPFI que el
protocolo entrega en tu vault. Los tokens enviados directamente a la
dirección de tu vault no los sigue el protocolo y no suben tu tier.

<a id="vpfi-discounts.tier-calculation"></a>

### Cómo se calcula tu tier

Tu tier sale de tres comprobaciones distintas, y las tres deben
cumplirse:

1. **Un periodo mínimo de tenencia.** Tu tier se queda en cero hasta
   que tu tenencia actual haya durado al menos 3 días. Una tenencia
   empieza en el momento en que el saldo de tu vault supera cero y dura
   hasta que vuelve a cero. Añadir VPFI no reinicia el reloj; retirarlo
   todo, sí. (3 días es el valor por defecto; la gobernanza puede
   fijarlo entre 2 y 14.)
2. **Un promedio ponderado hacia lo reciente.** Tu saldo se promedia
   sobre los últimos 30 días, y los últimos 7 cuentan el triple que los
   anteriores. El promedio nunca se remonta a antes de que empezara tu
   tenencia actual, así que un titular nuevo no se ve diluido por días
   en los que no tenía nada. (La ventana, los días recientes y el peso
   son parámetros de gobernanza; la ventana puede ir de 14 a 30 días.)
3. **El tier más bajo que has tocado.** Aparte del promedio, tu tier
   no puede ser más alto que el tier más bajo que alcanzó tu saldo
   durante la tenencia actual, mirando como mucho 30 días atrás. Cuenta
   el punto más bajo de cada día, así que una bajada y una recuperación
   dentro del mismo día cuentan igualmente como bajada.

Qué significa esto en la práctica:

- Un depósito justo antes de que se liquide un préstamo no sube tu
  tier de inmediato. La cantidad añadida tiene que entrar en el
  promedio, y el punto más bajo que tocaste sigue limitándote.
- Un retiro que te deja por debajo del umbral de un tier baja tu tier
  al instante.
- Una bajada de hace más de 30 días ya no te limita.

<a id="vpfi-discounts.other-chains"></a>

### Tu tier en otras cadenas

Base calcula tu tier. Todas las demás cadenas aplican una copia que Base
envía por Chainlink CCIP. Base actualiza tu registro de tier cuando
ocurre en Base una de estas cosas: entra o sale VPFI de tu vault (un
depósito, un retiro o una recompensa entregada en él); empieza un
préstamo en el que eres prestamista o prestatario; un paso de un
préstamo retiene o libera VPFI tuyo; o haces la llamada para refrescar
el tier. Cada actualización envía a las demás cadenas una copia nueva
cuando la copia cambiaría.

Cada cadena se entrega por separado. Una cadena a la que no se puede
llegar no retiene a las demás, y **una entrega que no puede salir
nunca hace fallar tu propia acción**: tu tier en Base queda al día de
inmediato, y a cada una de las demás cadenas se le debe la
actualización hasta que llega.

El protocolo paga estas entregas, con un límite:

- **Un tier más bajo** se envía de inmediato, siempre que el
  presupuesto pueda pagarlo. Hasta que llega, esa cadena sigue
  aplicando tu tier anterior, más alto.
- **Un tier más alto**, o un cambio de la tabla de tiers, se paga como
  mucho una vez al día por cadena (un parámetro de gobernanza entre 1
  hora y 7 días). Hasta entonces esa cadena conserva tu tier anterior.
- Una actualización retenida por esa espera, o que el presupuesto no
  pudo pagar, **no se reenvía sola cuando termina la espera**. Sale con
  la siguiente actualización de su registro de nivel en Base, o cuando
  alguien hace la llamada de entrega por usted.
- Cualquiera puede hacer esa llamada. Una vez pasada la espera y si el
  presupuesto puede pagarla, la paga el protocolo; antes de eso, quien
  llama paga la comisión cross-chain para entregarla antes. Los contratos
  ofrecen esta llamada; la aplicación todavía no la ofrece.

Una copia deja de contar, y esa cadena no da descuento, cuando:

- es más antigua que la antigüedad máxima de la cadena (60 días por
  defecto, nunca menos de 30); o
- se hizo con una tabla de tiers anterior a la que esa cadena conoce
  ahora.

Una copia solo se reenvía cuando algo en ella cambiaría: tu tier, su
descuento, cuánto tiempo sigue siendo válida o la versión de la tabla de
tiers. Así, tras un cambio en la tabla de tiers, la próxima
actualización de tu registro de tier en Base envía a cada cadena una
copia nueva, aunque tu tier sea el mismo, salvo que sea cero. Si nada de
esto ha cambiado, una cadena cuya copia ha caducado no aplica ningún
descuento hasta que algo cambie.

Si tu tier sube solo porque ha pasado el tiempo —ha terminado el periodo
de tenencia o el promedio ha alcanzado tu saldo—, nada en Base lo nota
hasta la próxima actualización de tu registro de tier. La llamada para
refrescar el tier hace esa actualización cuando tú quieras; la
aplicación solo la hace por ti cuando desactivas el descuento.

<a id="vpfi-discounts.operators"></a>

### Para operadores

La parte cross-chain del descuento necesita esta configuración. Se
detalla aquí para quien opere su propio despliegue.

**En Base:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`. Sin esto, Base calcula
  los tiers pero no los envía a ninguna parte.
- `RewardReporterFacet.setRewardMessenger` apuntando al
  `VaipakamRewardMessenger`, y `setBroadcastDestinations` del
  messenger con todas las demás cadenas.
- Un presupuesto de difusión con fondos:
  `ProtocolBroadcastFacet.topUpBroadcastBudget()` (payable). Un
  presupuesto vacío no bloquea nada. Cada entrega que no puede pagar
  queda pendiente y emite `TierPushDeferred` con el motivo, y
  `getTierPushStatus(user)` muestra el estado de cada cadena para un
  usuario. Un presupuesto escaso hace que las demás cadenas apliquen
  tiers antiguos durante más tiempo: vigila los aplazamientos y
  recarga.
- La ventana de espaciado de las subidas pagadas:
  `setTierPushSpacingSec` (1 día por defecto, de 1 hora a 7 días).

**En cada una de las demás cadenas:**

- `RewardReporterFacet.setRewardMessenger(addr)`: el único remitente
  cuyas actualizaciones de tier acepta la cadena.
- `RewardReporterFacet.setBaseChainId(chainId)`: el id de cadena EVM de
  Base (8453 en mainnet, 84532 en Base Sepolia), no su selector de
  cadena CCIP.
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: cuánto tiempo cuenta
  una copia (60 días por defecto; se rechazan valores por debajo de 30
  días). Bajarlo surte efecto en la siguiente lectura.

**Cambiar la tabla de tiers:**

- `setVpfiTierThresholds` y `setVpfiTierDiscountBps` en Base hacen
  avanzar la versión de la tabla. Otra cadena conoce la nueva versión
  por la primera actualización de tier que la lleve, de cualquier
  usuario. Desde entonces, toda copia hecha con la tabla antigua vale
  cero descuento hasta que llegue la actualización propia de ese
  usuario, y esas actualizaciones son subidas pagadas como mucho una
  vez por ventana de espaciado. Recarga el presupuesto antes de cambiar
  la tabla.
- `setTwaMinStakedDays` cambia el periodo mínimo de tenencia sin hacer
  avanzar la versión. Surte efecto en la siguiente lectura.

<a id="chapter.next-app"></a>

## La próxima app

La próxima versión de la app de Vaipakam se construye página a
página, junto a la actual. Una página aún no construida lo dice y
enlaza a la app actual, que la sigue sirviendo. Cada cifra de una
página construida se lee de la cadena y nombra su fuente; una cifra
que no se puede leer se muestra como desconocida, nunca como cero.

<a id="advanced-mode"></a>

### Basic y Advanced

Basic muestra las capacidades que la mayoría necesita. Advanced
añade las herramientas de salida y liquidación, la automatización,
las órdenes firmadas, la postura de los keepers y el detalle
contable. El modo es una preferencia de visualización guardada en tu
navegador: cambia cuánto se muestra, no lo que el protocolo te
permite, y nunca oculta un consentimiento, un bloqueo ni un remedio.

<a id="wallet"></a>

### Tu wallet y de dónde salen tus cifras

Tu propio estado (loans, ofertas, vault, claims) se lee de la
cadena: primero por el proveedor del wallet, luego por el proxy RPC
de solo lectura y luego por el endpoint público de la red. La línea
de sincronización nombra la fuente que respondió y la antigüedad de
la lectura más vieja de la página, y Actualizar las vuelve a leer
todas. El índice solo se usa para las cifras del mundo (el mercado
y el historial), con su altura de bloque y antigüedad. Un wallet en
una red no atendida no ve nada propio hasta que cambia. El chip de dirección abre el panel de cuenta propio de la app: la dirección completa con una acción de copia, la red, un cambio a cada otra red atendida y la desconexión. El selector de wallets solo se usa para conectar. Una vez conectada, la app no realiza ninguna consulta a un servicio de nombres, así que una sesión conectada no lee nada en la red principal de Ethereum ni llega a ningún host fuera de la lista connect-src de la página.

<a id="deployments"></a>

### Qué admite el despliegue

La app se vincula a un Diamond por cadena y lee sus selectores
enrutados a través del loupe antes de ofrecer cualquier acción. Tras
un refresco de facets ese conjunto cambia; leerlo, en vez de
suponerlo, permite a la app nombrar una función que falta en lugar
de fallar con `FunctionDoesNotExist`. Mientras no se pueda leer, no
se ofrece ningún paso de firma.

<a id="home-start"></a>

### Home: elegir una tarea

Home empieza por una tarea, no por un término del protocolo: pedir
prestado, prestar, alquilar un NFT, alquilar un NFT propio o
gestionar lo que tienes. Pedir prestado y prestar abren con las
ofertas que encajan y, si no, llevan a publicar la tuya. Alquilar
cubre los dos lados de un alquiler de NFT, con el NFT en un vault
todo el tiempo. Un wallet conectado ve también tres tarjetas de
inicio que se pueden ocultar; la elección se guarda en el navegador.

<a id="home-status"></a>

### Home: estado del protocolo

Home lee la pausa global, la ventana de pausa automática y la pausa
de los keepers en la cadena que describe la página, y declara el
resultado en todos los casos. Una pausa global detiene las nuevas
posiciones, los claims, los retiros, las liquidaciones, los defaults
y la liquidación hecha por keepers; el reembolso total y parcial y
añadir colateral siguen abiertos, y el tiempo en pausa se abona a los
plazos de cada loan abierto. Una ventana de pausa automática muestra
su fin; una pausa de administración, si la hay, dura más, y una
nueva ventana automática solo se abre tras un periodo de espera. Una
pausa de keepers solo detiene los pasos que el servicio ejecuta por
ti. Un estado que no se puede leer, incluida una relectura que falló
tras una respuesta anterior, aparece arriba como desconocido. Los
activos individuales también pueden pausarse; los flujos afectados
lo dicen.

<a id="home-payouts"></a>

### Home: listo para cobrar

Home recorre página a página las vistas de claims del lado prestamista
y del lado prestatario y nombra cada pago por loan y lado. No muestra
importe: un pago puede hacerse en más de un activo y por más de una
vía, y Claims es donde se indica cada importe antes de cobrar. Si el
recorrido se detiene antes del final, Home dice que puede haber más
de lo mostrado.

<a id="home-loans"></a>

### Home: tus loans

Cada loan Active o FallbackPending aparece con su lado, condiciones,
colateral y etapa, ordenado por urgencia: gracia vencida, en gracia,
fallback, plazo ilegible, vence en tres días, en curso. El
vencimiento y el fin de la gracia salen del reloj de loans del
protocolo e incluyen ya el tiempo en pausa, que se muestra cuando no
es cero. El health factor es la lectura escalada a 1e18 de la vista
del panel; una lectura de 0 significa ninguna (un activo sin precio o
una lectura fallida) y se muestra así. Dos o más loans abiertos desde
la misma oferta, en el mismo lado y en el mismo ERC-20, se agrupan:
principal sumado, tasa ponderada por principal y redondeada hacia
abajo, y el health factor más bajo entre los loans con precio,
contando los que no lo tienen.

Un loan que paga intereses periódicamente también tiene hitos, hasta su vencimiento incluido. Los intereses aún debidos cuando termina la gracia de un hito pueden pagarse vendiendo colateral, y el loan sigue abierto; Home muestra el próximo hito y pone primero uno pendiente, aunque caiga en el vencimiento, porque su gracia puede terminar antes que la del loan. El protocolo puede desactivar esta liquidación; Home dice entonces que no se vende colateral en un hito.

<a id="home-exposure"></a>

### Home: prestado y pedido

El principal de cada loan se valora en el numerario a precios
actuales mediante la única regla de valoración del protocolo: una
deuda redondeada hacia arriba, un loan que diste redondeado hacia
abajo. Un loan que no se puede valorar (un NFT o un activo sin
precio) se cuenta, no se estima. El lado mayor solo se nombra cuando
los loans sin valorar no podrían cambiar la respuesta; si no, Home
muestra los totales valorados y el recuento.

<a id="home-faucet"></a>

### Home: activos de prueba

En una testnet cuyo registro de despliegue publica activos de prueba, Home los lista: ERC-20 de prueba conectados a un feed de precio y un pool de prueba (líquidos), otros dejados sin ninguno a propósito (ilíquidos: los préstamos en ellos no tienen precio y el impago se liquida en especie) y NFT de alquiler ERC-4907. Una acuñación llama al contrato del token simulado, nunca al Diamond: 1.000 tokens enteros, o un NFT con un token id aleatorio nuevo comprobado como no acuñado antes de abrir la wallet. El resultado se mide leyendo de nuevo el saldo o `ownerOf`, y una acuñación de token ofrece después `wallet_watchAsset`. Un NFT de prueba solo puede quemarlo su dueño o un operador aprobado.

<a id="home-fee-discount"></a>

### Home: descuento en comisiones

`setVPFIDiscountConsent` fija una bandera por wallet en el Diamond de esta cadena. Desactivada, el descuento por tenencia es 0. Activada, la comisión de inicio del préstamo del prestatario se reduce al aceptar, en el activo prestado (la ruta de precio de VPFI nunca forma parte del camino del prestatario), y la comisión sobre el rendimiento del prestamista se descuenta en cada liquidación según el nivel efectivo vigente entonces. La entrega sigue `getVPFIDiscountConfig`: con la tasa de VPFI y su activo de referencia ambos fijados, la comisión descontada se debita en VPFI del vault del prestamista y este conserva todos los intereses; si no, se reduce la propia comisión de la tesorería y no se mueve VPFI. Si ese cargo no puede ejecutarse en una liquidación (sin cotización vigente, con poco VPFI libre registrado en el vault o con ese VPFI bloqueado como garantía), la comisión de esa liquidación no recibe descuento por tenencia. La llamada es `whenNotPaused`, así que la pausa global la cierra en ambos sentidos. Activarla está sujeto a los Términos, desactivarla no, y ninguna de las dos difunde un nivel a los mirrors. El descuento del prestatario solo se aplica si el activo prestado es líquido al aceptar (un préstamo ilíquido paga la LIF completa), y todo descuento está limitado al 50 % de la comisión.

<a id="home-rewards"></a>

### Home: Recompensas

La cifra principal es `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`, que ejecuta el claim con el destino Vault y siempre revierte: `InteractionRewardsSimulation(paid, fromDay, toDay)` lleva la cifra exacta, y cualquier otra reversión es el propio rechazo del claim (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`), mostrado por su nombre. Solo cuando ninguna fuente puede ejecutar la vista previa, Home lee `previewInteractionRewards`, un límite inferior, y retiene el claim. Una cifra exacta de cero se ofrece igualmente: el protocolo permite un claim que no paga nada solo cuando avanza más allá de días de recompensa que no pagaron nada, y Home lo indica. Home reclama mediante `claimInteractionRewardsTo(2)`, que paga como máximo `MAX_INTERACTION_CLAIM_DAYS` (30) días por llamada; cuando una vista previa leída en el bloque del claim terminado o después aún responde con una cifra, Home ofrece el resto. Un claim pagado solo desde entradas de recompensa no nombra un rango de días (0 a 0), y Home lo indica en lugar de mostrar días. El destino Vault se pasa para toda cuenta, incluida una wallet de contrato, porque el destino Default paga a un llamante de contrato en su wallet: se acredita el vault, con retorno a la wallet cuando el abono no puede completarse (aún no hay vault). El resultado se lee del recibo: `InteractionRewardsClaimed` da lo pagado, y los logs `Transfer` de VPFI de la misma transacción hacia la wallet y hacia `getUserVaultAddress(user)` dan dónde llegó; cuando no suman la cifra pagada, el destino se declara desconocido. El total reclamado no se muestra: aún no existe una ruta de índice por usuario para ello.

<a id="home-rewards-expiry"></a>

### Home: Fechas de retirada de recompensas

Un `ConfigFacet.getRewardClaimHorizonDays()` igual a 0 significa que el horizonte está apagado y no se muestra fecha. Si no, Home recorre `getUserSoonestRewardExpiry(user, offset, 200, 50)` página a página, todas en un mismo bloque, hasta diez páginas; el recorrido está completo cuando `nextOffset >= total`, y uno que se detiene antes se declara incompleto, nunca como que nada vence. El aviso final se muestra dentro de los 90 días previos a la estimación más próxima. La estimación es el `expiresAt` de la entrada en ese bloque: el tiempo en que el reclamo no es ejecutable retrasa la retirada real, y un cambio de gobernanza en el horizonte puede adelantarla. El importe que retiraría la entrada no se muestra en Home.

<a id="home-rewards-held"></a>

### Home: Recompensas retenidas

`getSanctionsHeldReward(user)` es el saldo retenido y `getRewardSanctionsStatus(user)` su decisión (Deliver, Hold o Confirmed). Con saldo y decisión Deliver, Home ofrece `claimHeldInteractionRewards(2)`, que paga exactamente el saldo retenido sin liquidar nada nuevo adeudado y emite `InteractionRewardsClaimed(user, 0, 0, paid)`; revierte con `SanctionedAddress` mientras la billetera esté vetada. La comprobación antes de firmar vuelve a leer ambos y simula la llamada como el remitente. Los días ganados con una marca confirmada se pierden para siempre.

<a id="borrow-start"></a>

### Borrow: Cómo funciona

Borrow acepta directamente una oferta de prestamista (`offerType` 0) de un ERC-20 contra garantía ERC-20, con `acceptOffer(offerId, terms, signature)`. En una transacción abre el vault del prestatario si no existe, mete en él la garantía, entrega a la wallet el principal menos la comisión de apertura y emite `LoanInitiated`. Un prestatario también puede publicar una solicitud (`offerType` 1); los lados NFT, los consentimientos por par y las opciones avanzadas llegan en actualizaciones posteriores.

<a id="borrow-pair"></a>

### Borrow: Elegir los tokens

La clase de cada token se lee en vivo: primero `getAssetPriceStatus(asset)` (Divergent se lee como desconfiado y cierra préstamos nuevos), luego `checkLiquidityOnActiveNetwork(asset)` (0 líquido, 1 ilíquido). Un revert `OraclePriceDivergence` u `OracleCrossCheckDivergence` se lee como desconfiado; cualquier otro fallo se muestra como ilegible, con su motivo. La lista sugerida es el token nativo envuelto y los tokens de prueba del registro de despliegue; una dirección pegada solo se comprueba en su forma.

El nivel de confianza lee `GET /assets/rankings?chainId=<token chain>` del índice, que sirve la descarga diaria del keeper de dos listas públicas de capitalización (top 500 cada una): una entrada por dirección con el rango, el nombre y el símbolo de cada lista, más el `listFetchedAt` y la última ejecución de cada lista. La app indexa por la dirección en minúsculas y toma el mejor rango entre listas: blue chip con rango ≤ 20 y `getAssetPriceStatus(asset)` con precio, luego ≤ 100, 200, 300 y 500. Un símbolo que otra lista clasifica en otra dirección, sin que ninguna lista clasifique ambas direcciones, deja el token como no verificado; un token sin clasificar cuyo `symbol()` o `name()` coincide con un símbolo o nombre clasificado es una posible copia; cualquier otro está sin clasificar. Un token de prueba del registro de despliegue se marca como de prueba; una cadena sin lista guardada se lee como red de prueba en un testnet y como sin lista en una mainnet. Se indica un `lastRun` fallido posterior a `listFetchedAt`. El nivel es solo de presentación y no cambia ningún tratamiento on-chain. La búsqueda compara símbolos y nombres clasificados por subcadena, mejor rango primero, y luego los tokens sugeridos por símbolo; un texto que empieza por `0x` se interpreta como dirección.

<a id="borrow-offers"></a>

### Borrow: Elegir una oferta

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` da los ids de ofertas abiertas del par y el total. Para cada una, la página lee `getOffer`, `getOfferState` y, con wallet, `previewAccept(offerId, wallet)`, cuyo `errorCode` es el rechazo del protocolo. La relación préstamo-valor es `calculateLTV` a los precios de hoy; un lado ilíquido o sin precio dice por qué no la hay. Una aceptación directa fija el `amountMax` del prestamista a `interestRateBps`. Las solicitudes de préstamo, las ofertas con lado NFT y las propias se cuentan, no se listan.

La app agrupa las filas por la tasa que fija la toma (`interestRateBps`), la más baja primero; dentro de un escalón se mantiene el orden de la lista. La tasa más alta y, en Advanced, el préstamo sobre valor más alto solo filtran las filas leídas; una fila cuyo `calculateLTV` no es una cifra se conserva y se cuenta. La línea de prestamistas listos lee `getActiveLenderIntents(offset, 50)`, hasta cuatro páginas, conserva las intenciones del par y toma para cada una el menor entre `availableCapital` y `maxExposure` menos `livePrincipal`, descartando la que queda bajo `minFillAmount`. Muestra el número, la mayor cifra individual y el `minRateBps` más bajo, y en Advanced los `maxDurationDays` y `maxInitLtvBps` más altos. Un servicio de emparejamiento llena una solicitud contra una intención solo dentro de esos límites, así que no está garantizado. Esa línea requiere que `getPartialFillEnabled` e `isLenderIntentEnabled` sean ambos true, leídos en el mismo bloque que cada página de la lista; si uno es false, la página dice que ninguna solicitud se llena contra ellos, y si uno no se leyó, dice que no se sabe. Una relectura fallida conserva la última respuesta y dice que puede haber cambiado. Se descartan los intents cuyo `owner` es la cuenta conectada (un emparejamiento consigo mismo se rechaza como self-trade). Todo llenado de intent exige además `useFullTermInterest` de la solicitud y rechaza `allowsPartialRepay` (`LenderIntentFullTermRequired`, `LenderIntentPartialRepayNotAllowed`); la vía indica ambos, y el formulario de solicitud indica una elección que falla alguno en lugar del llenado probable. `keepersPaused()` también se lee en el mismo bloque: mientras es true, el servicio de emparejamiento del protocolo no llena nada, así que la página lo dice en lugar del llenado probable y añade que un prestamista aún puede llenar desde su propio intent y que cualquiera puede llenar uno sin `requiresKeeperAuth`; sin leer, dice que no se sabe. Un llenado de intent también exige que el `periodicInterestCadence` de la solicitud sea ninguno, porque el tramo del intent no lleva calendario y el emparejamiento rechaza condiciones de ciclo de vida distintas (`LifecycleTermsMismatch`); el formulario de solicitud indica un calendario elegido en lugar del llenado probable. Los intents con `requiresKeeperAuth` se agregan y se indican aparte, y la línea del llenado probable nunca se afirma para ellos: solo el prestamista o un solver que autorizó para `KEEPER_ACTION_SIGNED_FILL` puede llenar uno, y no se lee si el servicio de emparejamiento tiene esa autorización, así que la página dice que no se sabe. El veredicto también lee `paused()` y `aggregatorAdaptersPaused()` en el mismo bloque: una pausa global se impone a cualquier otra barrera y se indica como detenido, y mientras los agregadores están en pausa cada propietario distinto se comprueba con `isAggregatorAdapter` en ese bloque y sus intents se excluyen, ya que `matchIntent` los rechaza; una comprobación no leída hace que el veredicto sea desconocido.

<a id="borrow-review"></a>

### Borrow: Revisar y firmar

La revisión lee la oferta, su estado, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, ambas clases, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, el vault, el saldo y la aprobación de la wallet, `previewOfferAcceptBlock` y el consentimiento de descuento, y los vuelve a leer justo antes de abrir la wallet. La wallet firma EIP-712 `AcceptTerms` (dominio `Vaipakam AcceptOffer`, versión 1) construido con la oferta guardada, con un nonce nuevo de 128 bits y un plazo de 30 minutos; un reconocimiento de iliquidez nombra solo un lado que la revisión mostró como ilíquido. Una aprobación de exactamente la garantía sigue solo si la aprobación no alcanza; luego `acceptOffer` se simula con la firma y se envía. Si se detiene tras la aprobación, la app la restablece a su valor anterior cuando nada más la cambió. El resultado lee `LoanInitiated` para esta oferta y esta wallet y los logs `Transfer` del recibo. La autorización se vuelve a leer justo antes del primer aviso, y ese valor es el que restaura un restablecimiento; una aceptación enviada que revierte, o que el wallet cancela o sustituye, recibe el mismo restablecimiento del seguimiento de transacciones. La revisión indica `allowsPartialRepay`, `allowsPrepayListing`, `allowsParallelSale` con `parallelSaleOrderHash`, `refinanceTargetLoanId` y el préstamo vinculado, y marca el importe adeudado como el caso sin pausa, ya que los intereses se acumulan durante una pausa mientras la fecha de vencimiento se desplaza. Cada paso de aprobación se juzga por la asignación leída de nuevo en el bloque de su recibo, nunca por el estado del recibo. Un token que rechaza pasar de una asignación distinta de cero a otra, detectado con una ejecución de prueba de `approve`, recibe primero un paso a cero, que la revisión cuenta como una solicitud más. La aceptación de los Términos se vuelve a leer justo antes de abrir la cartera. Ambas vías de venta listan la garantía como un NFT, así que con garantía en tokens un permiso de listado o venta concedido se indica como uno que el préstamo no puede usar. La revisión añade el `getNumeraireValue` del principal y de la garantía a los importes de la vista previa, como filas que no vinculan nada.

<a id="borrow-fee"></a>

### Borrow: La comisión de apertura

La comisión es el `lifEstimate` de `previewAccept`: `getLoanInitiationFeeBps` del principal, en el token prestado, descontada de lo entregado, reducida por el descuento por nivel de tenencia cuando el consentimiento está activo y el token prestado es líquido, con el nivel fijado al aceptar. Esta página nunca elige la tarifa Full. No se cobra VPFI por la comisión ni se reembolsa. La parte del remitente, `getLifMatcherFeeBps` de la comisión, se paga a quien envía, que en una aceptación directa es el prestatario, así que la wallet recibe el principal menos la comisión más esa parte.

<a id="borrow-risks"></a>

### Borrow: Riesgos

Un préstamo pasado el fin de su gracia (`getEffectiveGraceSeconds` tras el vencimiento, que el tiempo en pausa desplaza) puede declararlo en impago cualquiera: la garantía líquida se vende para el prestamista y la ilíquida se transfiere tal cual. La garantía líquida también puede liquidarse cuando el factor de salud baja de 1. `useFullTermInterest` cobra los intereses del plazo completo al devolver antes; un calendario de intereses salda un periodo impagado con una venta forzosa de garantía.

<a id="borrow-request"></a>

### Borrow: Publicar tu propia solicitud

Una solicitud es `createOffer` con `offerType` 1, ERC-20 en ambos lados, enviada desde la wallet del prestatario. Mueve `collateralAmount` al vault del prestatario, creándolo si no existe, y emite `OfferCreated(offerId, creator, 1)`. Un prestamista la acepta con `acceptOffer`: el principal menos la comisión va a la wallet del prestatario, y la parte de la comisión para quien envía va al prestamista que la envió. `cancelOffer` está abierto al creador desde `MIN_OFFER_CANCEL_DELAY` (5 minutos) tras la creación, y a cualquiera una vez vencida la solicitud; la garantía siempre vuelve al creador. Bajo cada importe escrito, el formulario muestra `getNumeraireValue(asset, amount, roundUp)` (el principal redondeado hacia arriba, la garantía hacia abajo) en la unidad de `getNumeraireSymbol`, leído cuando se pausa la escritura; un activo ilíquido se muestra valorado en nada, un precio en disputa como sin valor y una lectura fallida como no leída.

<a id="borrow-request-terms"></a>

### Borrow: Las condiciones de la solicitud

Basic publica una solicitud de valor único: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 0, `periodicInterestCadence` 0, `allowsPrepayListing` y `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true. Los importes se convierten exactamente a unidades base y la tasa es como máximo 10.000 bps. `durationDays` está limitado por el máximo configurado que se lee de `getProtocolConfigBundle`. `expiresAt` es 0 (abierta hasta cancelarse) o un momento fijado desde el último bloque al abrir la revisión, como mucho `MAX_OFFER_EXPIRY_HORIZON` (365 días) por delante. `useFullTermInterest` es true por defecto y `allowsPartialRepay` false.

<a id="borrow-request-review"></a>

### Borrow: Revisar y publicar una solicitud

La revisión simula `createOffer` desde la wallet y lee ambas clases, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, el plazo máximo, el vault, el saldo y la aprobación de la wallet, y `calculateLTV` cuando ambos lados son líquidos; se vuelve a leer en cada bloque y justo antes de abrir la wallet. Mientras la aprobación no alcanza, la simulación solo llega al cobro de la garantía: un error de cobro del token o una reversión sin nombre de error del protocolo se muestra como la aprobación pendiente, y un error con nombre del protocolo es un rechazo. Tras una aprobación exacta, `createOffer` se simula de nuevo y se envía; una parada tras la aprobación la restablece a su valor anterior si nada más la cambió. El resultado lee `OfferCreated` para esta wallet y el `Transfer` de la garantía al vault.

<a id="borrow-nft-collateral"></a>

### Borrow: un NFT como garantía

El estándar de la garantía se lee con `supportsInterface` (ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`); un revert no cuenta como ninguno, y una lectura fallida no ofrece solicitud. Una solicitud ERC-721 envía `collateralAssetType` 1, `collateralTokenId` el id escrito, `collateralQuantity` 1 y `collateralAmount` = `collateralAmountMax` = 0; el par de riesgo queda ligado a ese id. La revisión lee `ownerOf`, `getApproved` e `isApprovedForAll(wallet, Diamond)` en un mismo bloque; un token en otra billetera, o un `ownerOf` que revierte, bloquea la solicitud. Sin ninguna aprobación, la simulación se detiene en el `ERC721InsufficientApproval` del token, mostrado como la aprobación pendiente. La aprobación es `approve(Diamond, id)` y cuenta solo cuando `getApproved` lee el Diamond en el bloque del recibo; una parada posterior la devuelve a la dirección anterior solo mientras aún lea el Diamond y la billetera aún tenga el token. Para un ERC-721 nunca se pide `setApprovalForAll`. El resultado lee `OfferCreated` y el `Transfer` propio del token (cuatro topics) de la billetera a la bóveda. Una solicitud ERC-1155 envía `collateralAssetType` 2, el id del token, `collateralQuantity` con la cantidad escrita (de 1 a 2^128−1) y ambos importes en 0. La revisión lee `balanceOf(wallet, id)` e `isApprovedForAll(wallet, Diamond)` en un mismo bloque; un saldo menor que la cantidad bloquea la solicitud, y sin la aprobación la simulación se detiene en `ERC1155MissingApprovalForAll`. La única aprobación es `setApprovalForAll(Diamond, true)`, contada cuando se relee en el bloque de su recibo, y retirada con `setApprovalForAll(Diamond, false)` después de que la solicitud se mine o se detenga (sin leer nunca antes del bloque de la concesión), salvo que la billetera ya la hubiera concedido. El resultado suma los `TransferSingle`/`TransferBatch` del token de la billetera a la bóveda. Las ofertas de prestamistas que piden un NFT siguen yendo a la app actual.

<a id="borrow-request-range"></a>

### Borrow: Una solicitud con rango

Un rango envía `amount` (el más pequeño) por debajo de `amountMax` (el más grande), `interestRateBps` = `interestRateBpsMax` (la única tasa) y `collateralAmount` (el mínimo para el préstamo más pequeño) igual o por debajo de `collateralAmountMax` (que se lleva a la bóveda al publicar); un mínimo vacío envía ambos iguales. Los rangos solo se ofrecen con garantía ERC-20. Un `acceptOffer` directo presta `amount` a `interestRateBpsMax` contra `collateralAmount` y devuelve `collateralAmountMax − collateralAmount` a la billetera; `matchOffers` llena entre los extremos mientras `getPartialFillEnabled` sea verdadero. La simulación de `createOffer` aplica el límite de la oferta en el extremo mayor y rechaza con `MaxLendingAboveCeiling(provided, ceiling)`, cuyo techo muestra la revisión. El extremo directo se comprueba con una segunda simulación de una solicitud de valor único en (`amount`, `collateralAmount`); una respuesta que se detiene antes del límite se indica como desconocida. La relación préstamo-valor de cada extremo es `calculateLTV(lending, amount, collateral, collateralAmount)`, y `ZeroCollateral` se lee como una garantía sin valor. El factor de salud de inicio que se muestra es `getMinHealthFactor` mientras `getDepthTieredLtvEnabled` es falso, y 1,0 mientras es verdadero. Un emparejamiento bloquea el requisito prorrateado del prestamista, elevado a `collateralAmount` cuando la garantía es un rango y, si no, dejado en el requisito; por eso el mayor emparejamiento se muestra tanto en `collateralAmountMax` como en `collateralAmount` (o, sin rango de garantía, como capaz de bloquear menos); solo lo limita la comprobación al inicio del préstamo, y una lectura fallida de esa comprobación se indica, nunca se omite. En el régimen escalonado, la comprobación aplica además el tope de préstamo sobre valor del nivel. Mientras `getPartialFillEnabled` sea verdadero, la garantía que un emparejamiento no bloquea queda en la bóveda para emparejamientos posteriores y solo se reembolsa cuando la solicitud se cierra (su capacidad restante cae por debajo de `amount`) o se ejecuta `cancelOffer`.

<a id="borrow-request-fill"></a>

### Borrow: El modo de llenado de una solicitud

`fillMode` es 0 (Partial), 1 (AON) o 2 (IOC) y no puede cambiar después de publicar. AON exige `amount` = `amountMax` (`AonRequiresSingleValueAmount`) e IOC exige `expiresAt` ≠ 0 (`IocRequiresExpiry`); el formulario no ofrece ninguna de las formas rechazadas. Los importes, la tasa y la garantía pueden cambiar en una solicitud abierta mediante `setOfferAmount`, `setOfferRate`, `setOfferCollateral` y `modifyOffer`, nunca por debajo de `amountFilled` o `collateralAmountFilled`; esta aplicación aún no los llama.

<a id="borrow-request-cadence"></a>

### Borrow: El calendario de intereses de una solicitud

`periodicInterestCadence` va de 0 (None) a 4 (Annual), con periodos de 30, 90, 180 y 365 días. El formulario ofrece lo que admite `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)`, que ejecuta la regla que aplica `createOffer`, valorada en `amount` (el extremo menor de un rango). Cada rechazo se indica a partir de sus datos de reversión: `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid` o `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`. Los intereses de un periodo son `principal × rate × intervalDays / (10000 × 365)`. Cualquiera puede liquidar un periodo impagado mediante `settlePeriodicInterest` cuando pasa la gracia `getEffectiveGraceSeconds(intervalDays − 1)`; vende garantía y el préstamo sigue abierto. La activación del paso de keeper `periodicSettle` se muestra tal como la informa el servicio de capacidades, desconocida por defecto. El calendario no puede cambiar después de publicar.

<a id="borrow-request-tariff"></a>

### Borrow: La tarifa de comisión Full de una solicitud

La adhesión es `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, enviada por el creador después de `createOffer` y rechazada con `OfferAlreadyAccepted` cuando un prestamista ya tomó la solicitud; `maxCStar` debe ser mayor que cero (`FullTariffMaxCStarRequired`). El formulario muestra el interruptor de `getFeeEntitlementConfig()` y la tarifa de `quoteCStar(lendingAsset, principal, durationDays)`, en `amount` y `amountMax` para un rango; el tope por defecto es la cotización en `amountMax`. En cada aceptación el cobro toma `C*`, calculado sobre el principal de ese préstamo, solo si el interruptor está activado, el principal tiene precio y es líquido, `C* ≤ maxCStar` y el VPFI libre de la bóveda lo cubre (el saldo de la bóveda limitado por `getTrackedVPFIBalance`, menos los gravámenes activos, mediante `getFreeBalance`); si no, revierte con `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed` o `FeeEntitlementTariffAboveAuth`, salvo que `allowDowngrade` deje abrir el préstamo sin ella. El descuento de la comisión del prestatario sube `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000), con tope en `MAX_FEE_DISCOUNT_BPS` (5000). La revisión bloquea una elección bajo la que todo préstamo sería rechazado, y la adhesión se mide leyendo de nuevo `getOffer` (`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`). Esta aplicación aún no ofrece préstamos de respaldo para solicitudes no cubiertas.

<a id="lend-start"></a>

### Lend: Cómo funciona

Lend toma directamente una solicitud de préstamo (`offerType` 1) de un ERC-20 contra garantía ERC-20, con `acceptOffer(offerId, terms, signature)` enviado por el prestamista. En una transacción, el principal se extrae de la billetera del prestamista, mediante una autorización al Diamond, hacia la bóveda del prestamista; el prestatario lo recibe menos la comisión de apertura; la garantía que ya está en la bóveda del prestatario pasa a ser la garantía del préstamo; y se emite `LoanInitiated`, con un NFT de posición para el prestamista y otro para el prestatario. Una oferta de préstamo (`offerType` 0) se publica desde la misma página; los lados NFT llegarán en una actualización posterior.

<a id="lend-offers"></a>

### Lend: Elegir una solicitud

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` da los ids de las ofertas abiertas del par. Para cada una, la página lee `getOffer`, `getOfferState`, `getOfferLinkedLoanId` y, con billetera, `previewAccept(offerId, wallet)`, cuyo `errorCode` es el rechazo del protocolo. Una toma directa fija el `amount` de la solicitud (su mínimo) a `interestRateBpsMax`, y la relación préstamo-valor es `calculateLTV` sobre ese importe a los precios de hoy. Las ofertas de prestamistas, los lados NFT, las solicitudes propias del lector y los vehículos de venta de posiciones de prestamista (una oferta del lado prestatario con un `getOfferLinkedLoanId` distinto de cero) se cuentan, no se listan. El orden: financiables primero, luego tasa descendente, luego importe descendente.

<a id="lend-review"></a>

### Lend: Revisar y firmar

La revisión lee lo mismo que la de Borrow (la oferta, su estado, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, ambas clases, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, la bóveda de la billetera, `previewOfferAcceptBlock` y el consentimiento de descuento de comisiones) más `getTreasuryFeeBps`, y mide saldo y autorización sobre el activo prestado, el lado que paga el prestamista. Un déficit en él bloquea la firma, igual que un vehículo de venta de posición de prestamista. La billetera firma EIP-712 `AcceptTerms` (dominio `Vaipakam AcceptOffer`, versión 1), aprueba exactamente el principal solo cuando la autorización no alcanza (con un paso a cero antes para un token que rechaza un cambio entre valores no nulos), y `acceptOffer` se simula y se envía; una autorización dejada por un flujo detenido se restablece como en Borrow. El resultado lee `LoanInitiated` para esta oferta, el `Transfer` del principal desde la billetera y el `Transfer` de vuelta de la parte del emparejador.

<a id="lend-fee"></a>

### Lend: La comisión y la parte del protocolo

La comisión es el `lifEstimate` de `previewAccept`, y es del prestatario: `getLoanInitiationFeeBps` del principal en el activo prestado, descontada de la entrega al prestatario, reducida en la aceptación por el descuento por nivel de tenencia del prestatario y, cuando `creatorFull` está activo y el cargo se realiza, por la bonificación de la tarifa Full. La parte de quien envía, `getLifMatcherFeeBps` de la comisión, se paga al remitente, aquí el prestamista. La parte del protocolo en los intereses es `getTreasuryFeeBps`, fijada por préstamo al abrirse (`treasuryFeeBpsAtInit`); el descuento por nivel de tenencia del prestamista, con el consentimiento activado, la reduce al liquidarse los intereses. La revisión muestra la tasa de hoy y la parte a esa tasa como límite superior.

<a id="lend-risks"></a>

### Lend: Riesgos

Un préstamo pasado el fin de su gracia (`getEffectiveGraceSeconds` después de la fecha de vencimiento, que el tiempo en pausa desplaza) puede declararse en impago por cualquiera: la garantía líquida se vende para el prestamista y la ilíquida se transfiere tal cual. Con ambos lados líquidos, el préstamo puede liquidarse cuando el factor de salud baja de 1, y la venta paga primero al prestamista. Un lado ilíquido excluye la liquidación por precio, y en caso de impago el prestamista recibe toda la garantía. `useFullTermInterest` fija un mínimo de intereses en el pago anticipado; sin él, los intereses son prorrateados. Un calendario de intereses periódicos liquida un período impagado mediante una venta forzosa de garantía al prestamista. El NFT de posición del prestamista lleva el derecho de cobro: transferirlo transfiere el préstamo.

<a id="lend-offer"></a>

### Lend: Publicar su propia oferta

Una oferta de préstamo es `createOffer` con `offerType` 0, ERC-20 en ambos lados, enviada desde la billetera del prestamista. Retira `amountMax` del activo prestado a la bóveda del prestamista, creando la bóveda si no existe, y emite `OfferCreated(offerId, creator, 0)`. Un prestatario la acepta con `acceptOffer`: su garantía pasa a su bóveda, el principal menos la comisión va a su billetera, y la parte de la comisión para quien envía le llega a él como remitente. Mientras `getPartialFillEnabled` sea true, `matchOffers` también puede emparejarla con la solicitud de un prestatario; una oferta de prestamista de valor único presta entonces todo su importe a su tasa, contra al menos su `collateralAmount`. `cancelOffer` está abierto al creador desde `MIN_OFFER_CANCEL_DELAY` (5 minutos) después de la creación, y a cualquiera una vez vencida la oferta; el importe siempre vuelve al creador.

<a id="lend-offer-terms"></a>

### Lend: Las condiciones de la oferta

Sin partes, una oferta de préstamo es de valor único: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (la única garantía que un prestatario debe bloquear), `fillMode` 0 salvo que Advanced fije otro (sección siguiente), `periodicInterestCadence` 0 salvo que Advanced fije un calendario, `allowsPrepayListing` y `allowsParallelSale` en false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` en true, y sin tarifa Full salvo que Advanced la elija. Los importes se convierten exactamente a unidades base y la tasa es como máximo 10.000 bps. `durationDays` está limitado por el máximo configurado leído de `getProtocolConfigBundle`. `expiresAt` es 0 (abierta hasta cancelarla) o una hora fijada desde el último bloque al abrirse la revisión, como mucho `MAX_OFFER_EXPIRY_HORIZON` (365 días) después. `useFullTermInterest` es true por defecto y `allowsPartialRepay` false.

<a id="rate-check"></a>

### Comparar tu tasa con préstamos recientes

Los dos formularios leen `/loans/recent` del índice para el mismo activo prestado, el mismo activo de garantía y el mismo plazo, sin los vehículos de venta de prestamistas, y se quedan con los préstamos que empezaron en los últimos 30 días y tienen una tasa acordada que respalda el registro del índice (un préstamo con términos no confirmados queda fuera). La comparación es la mediana de esas tasas, la menor de las dos centrales si el número es par, para no inventar una tasa entre dos acordadas. Una tasa a más de 5 puntos porcentuales (500 bps) es un aviso que indica el sentido: un prestamista muy por debajo, o un prestatario muy por encima, publica la oferta que se toma primero cuando las tasas se mueven; en el otro sentido, la oferta puede quedarse sin tomar. Dentro de ese margen es una nota con la mediana y el número. Una lectura cubre los 100 préstamos más recientes; si llega a ese límite, la nota dice que solo se leyeron los últimos. Una respuesta del índice que no se limite al par y plazo pedidos se rechaza en vez de compararse, la garantía NFT no se compara y una lectura fallida lo dice. Nunca bloquea la revisión. Los préstamos del par cuyos términos el índice no ha confirmado no pertenecen a ningún plazo; el índice los cuenta (`unplaced`) y el formulario indica ese número junto a la comparación, para que «ningún préstamo confirmado» nunca oculte préstamos de plazo desconocido.

<a id="public-queue"></a>

### Redes con cola pública

En Ethereum, BNB Chain y Polygon (y BNB Testnet y Polygon Amoy), una transacción que envías espera en una cola pública antes de incluirse, y cualquiera que observe esa cola, bots incluidos, puede verla y actuar primero: tomar una oferta antes de que llegue tu cancelación o actuar sobre un préstamo antes de que llegue tu pago. Por eso, en esas redes, la revisión de publicar, tomar o cancelar una oferta, pagar y añadir garantía lo indica antes de que se abra tu billetera. Algunas billeteras pueden enviar la transacción de forma privada; busca en los ajustes de red o de seguridad de tu billetera. La app no puede elegir esa ruta por ti, y enviar de la forma habitual solo cambia quién puede ver la transacción antes de que llegue. Base, Arbitrum y Optimism no tienen cola pública, así que allí no se muestra nada. Las redes son una sola regla en la app (Ethereum 1, BNB Chain 56, BNB Testnet 97, Polygon 137, Polygon Amoy 80002), y una prueba falla si una red que la app atiende no está decidida. El aviso aparece en la revisión, antes de la última comprobación y de la billetera, solo para estas operaciones: publicar, tomar o cancelar una oferta, pago total y parcial, y añadir garantía. La ayuda no nombra ningún servicio de envío privado, porque el protocolo no puede verificar qué ruta usó una billetera, y el efecto de la transacción es el mismo por cualquier ruta.

<a id="lend-offer-parts"></a>

### Lend: Una oferta en partes

Las partes envían `amount` (la parte más pequeña que un emparejamiento puede prestar) por debajo de `amountMax` (el importe entero, que `createOffer` mueve a la bóveda); `collateralAmount` = `collateralAmountMax` sigue siendo el único requisito, expresado para `amountMax` (si no, `LenderCollateralRangeNotAllowed`), e `interestRateBps` = `interestRateBpsMax`. Un `acceptOffer` directo de una oferta de préstamo presta `amountMax` contra `collateralAmount`, y solo mientras `amountFilled` sea 0 (`OfferPartiallyFilled` tras un emparejamiento). Mientras `getPartialFillEnabled` sea true, `matchOffers` presta el punto medio del solapamiento de importes, al menos `amount`, al punto medio del solapamiento de tasas, contra al menos `collateralAmount × matchAmount ÷ amountMax` (redondeado hacia abajo; el rango de garantía de un prestatario puede subirlo). Cuando `amountMax − amountFilled` cae por debajo de `amount`, el resto se retira a la billetera del prestamista y la oferta se cierra (`OfferClosed`, motivo `Dust` o `FullyFilled`). `cancelOffer` sobre una oferta parcialmente llena omite la espera y devuelve `amountMax − amountFilled`. `fillMode` es 0, 1 o 2 como en una solicitud: AON exige `amount` = `amountMax`, IOC exige un vencimiento, y no cambia después de publicar. Con ambas patas líquidas, `createOffer` rechaza un `collateralAmount` por debajo del mínimo en `amountMax` con `MinCollateralBelowFloor(provided, floor)`, cuyo mínimo muestra la revisión. Se muestra una sola relación préstamo-valor, `calculateLTV` en (`amountMax`, `collateralAmount`): una parte tiene la misma relación, salvo el redondeo.

<a id="lend-offer-schedule"></a>

### Lend: Un calendario de intereses en una oferta

El `periodicInterestCadence` de una oferta de préstamo sigue la regla de la solicitud (arriba), con `previewCadenceAdmission` valorado en el `amount` de la oferta: su parte más pequeña, o el importe entero sin partes. `createOffer` lo admite ahí mediante `requireCadenceAdmitted`, y la originación de cada préstamo comprueba de nuevo su propio principal (`requireOriginationCadenceAdmitted`). La revisión indica los intereses de un periodo en `amountMax` (una toma directa) y, con partes, en `amount`. Un periodo impagado puede liquidarlo cualquiera mediante `settlePeriodicInterest` tras su gracia: se vende garantía para pagar al prestamista los intereses de ese periodo, y el préstamo sigue abierto.

<a id="lend-offer-tariff"></a>

### Lend: La tarifa de comisión Full en una oferta

La adhesión del prestamista es el mismo `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, enviado después de `createOffer`. Se rechaza con `OfferAlreadyAccepted` una vez que la oferta se toma entera o se cierra; una oferta emparejada en parte todavía la acepta, para sus préstamos posteriores. La cotización es `quoteCStar` en `amount` y `amountMax`, y el tope toma por defecto la cotización en `amountMax`. Cada préstamo se comprueba por sí solo contra `maxCStar`, al precio de su principal, con las mismas condiciones que una solicitud (`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`, o una degradación donde se permita); la comprobación del prestamista usa el VPFI libre actual de la bóveda. Una tarifa cobrada marca el `lenderMode` del préstamo como Full, y cada liquidación de la comisión de rendimiento del prestamista suma entonces `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) al descuento del titular de la posición sobre la parte del protocolo, con tope en `MAX_FEE_DISCOUNT_BPS` (5000), con o sin el consentimiento al descuento por tenencia. Una prórroga en el sitio (`repriceFeeEntitlementOnExtension`) pone la marca en None para el nuevo plazo.

<a id="lend-offer-review"></a>

### Lend: Revisar y publicar una oferta

La revisión simula `createOffer` desde la billetera y lee ambas clases, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, el plazo máximo, la bóveda de la billetera, su saldo y su autorización sobre el activo prestado (el lado que bloquea el prestamista), y `calculateLTV` cuando ambos lados son líquidos; se vuelve a leer en cada bloque y justo antes de abrir la billetera. Mientras la autorización es insuficiente, la simulación solo puede llegar al retiro del importe, así que un error de retiro del token, `VaultDepositFailed` (el envoltorio del protocolo para un retiro revertido sin datos, como hace WETH con una autorización insuficiente) o una reversión sin nombre de error del protocolo se muestra como la aprobación pendiente, con la misma regla que la revisión de una solicitud; cualquier otro error con nombre del protocolo es un rechazo. Tras una aprobación exacta, `createOffer` se simula de nuevo y se envía; una parada tras la aprobación devuelve la autorización a su valor anterior si nada más la cambió. El resultado lee `OfferCreated` para esta billetera con `offerType` 0 y la `Transfer` del importe a la bóveda.

<a id="lend-offer-fee"></a>

### Lend: Las comisiones de su oferta

`createOffer` no cobra nada al prestamista. La comisión mostrada es del prestatario: `getLoanInitiationFeeBps` del importe en el activo prestado, a la tasa vigente cuando se ejecuta `acceptOffer`, reducida entonces por el descuento de nivel de tenencia del prestatario y descontada de lo que se le entrega; la cifra mostrada usa la tasa de hoy. La parte del protocolo sobre los intereses es `getTreasuryFeeBps`, fijada por préstamo al abrirse (`treasuryFeeBpsAtInit`); el descuento de nivel de tenencia del prestamista, con el consentimiento activado, la reduce al liquidar los intereses. La revisión muestra la tasa de hoy y la parte a esa tasa como límite superior; una lectura fallida de `getTreasuryFeeBps` se indica, y no se muestra ninguna parte ni importe de vuelta.

<a id="positions"></a>

### Positions: cómo se lee la lista

Positions lee el mismo inventario que Home mediante un lector compartido: `getUserPositionLoansPaginated` recorre los NFT de posición que guarda la wallet, `getLoansBatch` los carga, y cada lado sale del token que se guarda (`lenderTokenId` o `borrowerTokenId`), nunca de la parte registrada al originarse. Los préstamos con estado Active o FallbackPending están activos, con los plazos, el factor de salud y la agrupación descritos en Home. Cualquier otro estado es terminado, con el id de préstamo más reciente primero, nombrado según `LoanStatus`: Repaid, Defaulted, Settled o InternalMatched (cerrado por un emparejamiento); un número de estado que la app no conoce se muestra como número. Los pagos siguen la regla de reclamables descrita en Home: una posición guardada sobre un préstamo terminado que la wallet recibió de otra persona se cuenta, no se adivina.

La elección de lado filtra los pagos y las filas activas y terminadas por el lado que se guarda. "Nada" se dice solo cuando el recorrido de posiciones y el de pagos se completaron y la última lectura tuvo éxito; un recorrido detenido en su tope se indica como incompleto. Una fila abre `/positions/<id>`, donde el veredicto de elegibilidad decide cada acción; la lista no envía ninguna transacción.

Con dos o más filas activas tras elegir el lado, primero aparece una tarjeta de resumen. Por lado suma `principal` por cada `principalAsset` ERC-20, nunca entre tokens (la comparación de valores queda en la línea de exposición), y cuenta las filas con principal NFT como alquileres. La próxima fecha es la más temprana aún por llegar entre las etapas que usan las filas: un vencimiento en curso o próximo (reembolso) o un punto de control periódico próximo (intereses); un empate va al id de préstamo menor. Los préstamos cuyo periodo de gracia terminó (en el vencimiento o en un punto de control), los préstamos en periodo de gracia y los préstamos FallbackPending se listan por id, cada uno una vez bajo su etapa más grave; los préstamos con plazos no leídos se cuentan. Los intereses se excluyen. La tarjeta usa solo la lectura de la propia lista e indica un recorrido parcial. Un vencimiento en una fila con principal NFT es el cierre de un alquiler (`rental-close`), nunca un reembolso: un alquiler se cierra con su renta prepagada, así que el resumen lo nombra como las filas.

<a id="position"></a>

### Position: cómo se lee un préstamo

La página lee `getLoanDetails(loanId)` y el titular de los NFT de posición del prestamista y del prestatario (`ownerOf` en el contrato PositionNFT que registra el despliegue, o en el propio Diamond para un despliegue anterior a #3205); el papel es el token que la wallet guarda ahora. Para un préstamo activo (Active o FallbackPending) lee `getLoanDeadlines` (vencimiento del plazo actual antes del crédito por pausa, que una extensión o un traspaso del prestatario reescribe, crédito por pausa, vencimiento, fin de la gracia), `previewPeriodicSettle` con `getPeriodicInterestEnabled` cuando tiene calendario, `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`), `calculateHealthFactor` y `calculateLTV`; para todo préstamo, `getLoanCollateralLien` e `isSaleVehicleLoan`. Cada lectura es independiente: una que falla se muestra como desconocida, nunca como cero, y ninguna fecha se calcula a partir de `startTime` y `durationDays`.

Para un préstamo con precio también lee `getInternalMatchConfigBundle`. Con el emparejamiento interno activo, un préstamo cuya relación préstamo-valor va de su umbral hasta el umbral más `externalLiquidationPriorityWindowBps` queda reservado para un emparejamiento interno y toda ruta de liquidación externa lo rechaza (`InternalMatchOnlyBand`); la página indica esa banda. Un `loanInitiationFeeBpsAtInit` de 0 (un préstamo abierto antes de que se guardara la tasa) se muestra como no registrado, y un `treasuryFeeBpsAtInit` de 0 como la tasa heredada del 1% que aplica la liquidación. El aviso de entrega en especie es solo para un préstamo ERC-20: un alquiler de NFT no tiene garantía, y su impago termina el uso del arrendatario, paga el alquiler prepagado al prestamista menos la parte de la tesorería y envía el colchón a la tesorería, lo que la página indica en su lugar.

Las tasas son instantáneas del préstamo: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (ninguna en un vehículo de venta) y `liquidationLtvBpsAtInit`. Un préstamo con un lado ilíquido (`principalLiquidity` o `collateralLiquidity`) no tiene lectura basada en precio: el protocolo rechaza `calculateHealthFactor` y `calculateLTV` para él, y la página lo dice en lugar de mostrar desconocido. `principal` es lo que aún se adeuda (un reembolso parcial lo reduce), y `interestRateBps` y `collateralAmount` también pueden cambiar, así que las condiciones se muestran tal como están ahora; un préstamo terminado sin principal en su registro dice si una compensación interna lo cubrió y, si no, solo que no consta ninguno; un alquiler de NFT muestra su renta diaria (`principal`, en `prepayAsset`) y si devolverlo antes sigue cobrando cada día restante (`useFullTermInterest`). Con `getPeriodicInterestEnabled` en false, la página dice que no se vende garantía en un punto de control. `collateralLiquidity` Illiquid en un préstamo activo añade el aviso en especie: un impago transfiere la garantía al prestamista sin venta. Su primera transacción es el pago completo, abajo.

<a id="repay"></a>

### Pagar el préstamo completo: cómo se calcula

La acción sigue una regla: `repayLoan` se ofrece para un préstamo ERC-20 Active o FallbackPending a cualquier billetera que no sea `loan.lender` ni `ownerOf(lenderTokenId)` (`LenderCannotRepayOwnLoan`), se retiene pasado el fin efectivo del período de gracia en un préstamo Active (`RepaymentPastGracePeriod`) y mientras la ruta abierta de la posición del prestatario sea `SwapToRepayIntent` (`positionRoute(borrowerTokenId)` en el Diamond, o `positionLock(borrowerTokenId)` para un despliegue anterior a #3205). Una venta listada por el prestamista, una solicitud de refinanciación y la pausa global no lo retienen. Los alquileres aún no se ofrecen aquí.

La revisión lee `calculateRepaymentAmount(loanId)` en el último bloque y otra vez con la hora del bloque sustituida por `min(now + 30 minutos, fin de gracia)`; la misma solicitud lee la hora del bloque con la que se ejecutó, y una conexión que ignoró la sustitución se descarta. La aprobación es exactamente la segunda cifra, la llamada se simula antes de abrir la billetera y, tras el recibo, el estado en que la devolución dejó el préstamo se lee de su registro `LoanRepaid` (no en el bloque, donde un cobro posterior ya puede haberlo liquidado), el pago se mide a partir de los registros `Transfer` y la allowance se restablece a su valor anterior cuando marca la aprobación menos el pago. Una allowance mayor que esa cifra, incluida una ilimitada, también se reduce a ella, porque `repayLoan(loanId)` no fija máximo ni plazo; el restablecimiento devuelve después el valor mayor.

En la gracia (`maturity ≤ now ≤ graceEnd` según `getLoanDeadlines`), las revisiones del reembolso total y parcial cuentan hacia atrás hasta `graceEnd` con el reloj de la cadena, estimado como la marca de tiempo del bloque leído más los segundos desde entonces. `repayLoan` y `repayPartial` revierten con `RepaymentPastGracePeriod` en cuanto `block.timestamp > graceEnd`, y desde entonces `triggerDefault` está abierto a cualquiera, así que un reembolso tardío compite con un impago. Con una hora o menos, el reloj dice que se envíe ya. Solo informa: el veredicto que se vuelve a leer antes de enviar es la barrera, y una pausa retrasa `graceEnd`. Llenar bloques para retener un reembolso más allá de la gracia queda registrado como un riesgo bajo aceptado en el modelo de amenazas.

<a id="interest-schedule"></a>

### Calendario de intereses: cómo se lee

Para un préstamo ERC-20 activo con cadencia, la tarjeta lee `previewPeriodicSettle(loanId)` (cadencia, `periodEndAt`, `graceEndsAt`, `expected`, `paidByBorrower`, `shortfall`, `canSettleNow`), `getPeriodicInterestEnabled()` y `paused()`, e indica la hora del bloque leída. `expected` es un período completo con el `principal` y el `interestRateBps` actuales; `periodEndAt` incluye el crédito de pausa del préstamo.

El `canSettleNow` de la vista previa no tiene en cuenta el interruptor ni la pausa, así que la tarjeta los combina en el orden propio de `settlePeriodicInterest`: apagado (`PeriodicInterestDisabled`), en pausa (`whenNotPaused`) y luego el tiempo del período (`PeriodicSettleNotDue` antes de `graceEndsAt`). Solo se anuncia una venta cuando el interruptor está encendido y el protocolo no está en pausa; un interruptor o una pausa sin leer se indican como desconocidos. Con un déficit cero, la liquidación solo adelanta el punto de control. El armado de `PERIODIC_SETTLE` en el keeper no se comunica a la app, así que la tarjeta dice que la liquidación está abierta a cualquiera y que el estado del keeper no se conoce.

<a id="partial-repay"></a>

### Pagar parte de un préstamo: cómo se calcula

`repayPartial(loanId, amount)` toma `amount` de principal más el interés acumulado desde `interestAccrualStart` (neto de cualquier crédito periódico). Paga los intereses primero a los titulares anteriores a los que aún se deben intereses de antes de una venta (`paySellersFirst`) y luego al titular actual de la posición prestamista, separando la parte de la tesorería (a un titular que el protocolo debe congelar se le deposita su parte bloqueada en la bóveda del prestamista, `freezeOrPayActiveLenderFromPayer`); reduce `principal`, reinicia el reloj de intereses y abona el período actual; el vencimiento nunca se mueve. Lo rechaza después del fin del período de gracia, por debajo de `principal × minPartialBps / 10000` (`getAssetRiskParams`), con el principal completo o más (`PartialWouldRetireFullPrincipal`), con un compromiso de intención o una solicitud de refinanciación activos y, en un préstamo líquido, si el factor de salud empeorara.

Ninguna vista devuelve el interés del pago parcial antes de la llamada (#3299), así que la revisión usa `calculateRepaymentAmount` menos `principal`, leído ahora y en un momento algo posterior. Es exacto para un préstamo prorrateado hasta su vencimiento; con `useFullTermInterest` incluye el mínimo del plazo restante y, tras el vencimiento, un recargo por mora, por lo que se muestra como «como máximo». La aprobación es exactamente la parte más esa cifra superior. La tarjeta final mide el `newPrincipal` del propio registro `PartialRepaid` del pago (no `principal` en el bloque, que una transacción posterior allí puede cambiar), la salida de la cartera y después `previewPeriodicSettle`. La revisión solo rechaza la cartera cuando le falta la parte, o la parte más un interés exacto; cuando solo la cifra máxima supera su saldo, decide la simulación justo antes de enviar el pago.

<a id="add-collateral"></a>

### Añadir garantía: qué se comprueba

`addCollateral(loanId, amount)` toma exactamente `amount` del propio token de garantía del préstamo desde quien llama hacia la bóveda del prestatario, sube `collateralAmount` y el gravamen de la garantía, y emite `CollateralAdded` con el nuevo factor de salud y LTV. Rechaza un compromiso de swap-to-repay vigente, a quien llame sin ser `ownerOf(borrowerTokenId)`, un préstamo que no esté Active ni FallbackPending, un alquiler, un activo de garantía en pausa (`isAssetPaused`) y una garantía que `checkLiquidity` no reporte como Liquid. No lleva `whenNotPaused`. El depósito va a la bóveda del `loan.borrower` registrado: un préstamo Active consolida primero una posición transferida en el titular (`consolidateToHolder`), así que es la bóveda del titular; uno FallbackPending no se consolida hasta que se cura, por lo que la revisión nombra la bóveda registrada. Los tokens añadidos cuentan en `collateralAmount`, que la liquidación y el impago consumen, y la revisión lo dice.

La aplicación lee esas entradas, las dos comprobaciones del activo en vivo y no desde la clase de apertura del préstamo, y la simulación es la última palabra del protocolo. Ninguna vista devuelve el factor de salud tras un aporte, así que la revisión muestra `calculateHealthFactor` y `calculateLTV` ahora y la tarjeta final lee las nuevas cifras del registro `CollateralAdded` de la transacción. En un préstamo FallbackPending, el aporte lo cura cuando el nuevo factor de salud alcanza el mínimo del préstamo y el LTV queda dentro de su tope de apertura; la tarjeta final busca `LoanCuredFromFallback`. Una aprobación existente igual o mayor que la cantidad se deja como está, porque se toma exactamente la cantidad; una menor se sube a exactamente la cantidad y se restablece si el aporte no se completa.

<a id="take-back-collateral"></a>

### Retirar garantía: qué se comprueba

`partialWithdrawCollateral(loanId, amount)` envía `amount` de la garantía desde la bóveda del prestatario a la billetera de quien llama, reduce `collateralAmount` y el gravamen de la garantía, y emite `PartialCollateralWithdrawn` con el nuevo factor de salud y LTV. Lleva `whenNotPaused` y rechaza, en orden: a quien llama si está sancionado, un commit de swap-to-repay vigente, una solicitud de refinanciación vigente (`RefinanceRequestOpen`), una venta listada vinculada (`SaleListingActive`), a quien llama si no es `ownerOf(borrowerTokenId)`, un préstamo que no está Active, un importe mayor que la garantía, una garantía que `checkLiquidity` no reporta como Liquid, y un resultado por debajo del factor de salud mínimo o por encima del tope de LTV de apertura.

El formulario comprueba el importe con `calculateMaxWithdrawable`, que es cero para un préstamo que no está Active o con garantía ilíquida, y que baja a medida que se acumulan intereses. Ninguna vista expone una venta listada vinculada, así que la revisión simula el retiro y nombra ese rechazo; el envío lo simula de nuevo. La tarjeta final lee la garantía restante y las nuevas cifras del log `PartialCollateralWithdrawn` de la transacción, y el importe recibido del `Transfer` del token a la billetera. Para quien llama con el modo de cuenta protegida, la compuerta de pagos de la bóveda pone la retirada en cola (`PayoutQueued`) durante el retraso de la cuenta en lugar de pagarla, así que la revisión lee `getProtectedAccount` y la tarjeta final lee ese log.

<a id="collect-a-payout"></a>

### Cobrar un pago: qué se comprueba

`claimAsLender(loanId)` y `claimAsBorrower(loanId)` llevan `whenNotPaused` y pagan desde la bóveda de la parte registrada para ese lado (`loan.lender` / `loan.borrower`) a quien llama, que debe ser `ownerOf` del token de posición de ese lado. El prestamista puede cobrar en un préstamo Repaid, Defaulted, FallbackPending o InternalMatched; el prestatario solo en Repaid, Defaulted o InternalMatched. La reclamación del prestamista rechaza una fila ya cobrada (`AlreadyClaimed`) antes de comprobar al titular y un lado sin nada pendiente (`NothingToClaim`) después; una fila que un cierre forzoso registró en cero se ejecuta igualmente y cierra la posición. La reclamación del prestatario solo rechaza cuando su fila de garantía y su fila de excedente están ambas vacías o cobradas, y paga cada una según su propio indicador, junto con la garantía que sigue bajo el gravamen del préstamo en otro token.

La revisión lee `getClaimable` (la fila del prestamista ya neta de los vendedores anteriores, con `getSellersShareOfLenderClaim` al lado), `getBorrowerSurplusClaim` y `getLoanCollateralLien`, y ejecuta la reclamación en simulación, que también aplica los controles de sanciones. La lista sigue al token de posición: `getUserDashboardClaimables` enumera las reclamaciones de la parte registrada, así que una fila listada se mantiene solo mientras la billetera tenga ese lado, y de una posición mantenida en un préstamo terminado recibida de otra persona se lee la reclamación directamente. La tarjeta final lee `LenderFundsClaimed` / `BorrowerFundsClaimed`, `BorrowerSurplusClaimed` y `LoanSettled`, y las transferencias del token a la billetera; para quien llama en modo de cuenta protegida lee `PayoutQueued` (la bóveda propia de la cuenta), `PayoutHeldInVault` (una cuenta bloqueada o una cola llena) o `PaymentCreditedToVault` (la bóveda de otra parte). En un préstamo FallbackPending la reclamación del prestamista puede ejecutar un emparejamiento interno al cobrar que reescribe la fila, así que la tarjeta final compara las transferencias con el registro del propio protocolo.

<a id="claim-everything"></a>

### Cobrarlo todo: qué se comprueba

El lote pasa por `multicall(calls)`, que ejecuta cada llamada con `delegatecall` dentro del propio protocolo, así que `msg.sender` sigue siendo su billetera y cada llamada comprueba sus propias reglas. Admite como máximo 30 llamadas, y la app envía cada una con `allowFailure`, de modo que una llamada rechazada revierte sola y el lote continúa. Las llamadas son `claimAsLender` / `claimAsBorrower(loanId)`; `claimInteractionRewardsTo(Vault)`, que también libera una recompensa retenida, o `claimHeldInteractionRewards(Vault)` cuando la vista previa de recompensas no puede completarse pero `getRewardSanctionsStatus` indica Deliver; `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)` para el `availableCapital` de cada intención de `getLenderIntentsByOwner`; `withdrawVPFIFromVault(amount)` para el `freeHolding` de VPFI; y `withdrawSalary(streamId)` para cada flujo de `getPayrollStream` cuyo beneficiario es la billetera, según `getWithdrawableSalary`. Se deja fuera el cobro del prestamista sobre un préstamo FallbackPending, porque su emparejamiento al cobrar decide lo que paga. La revisión ejecuta el lote como prueba y lee `success` y los datos de reversión de cada llamada, deja fuera una llamada rechazada con su error decodificado, y lo vuelve a ejecutar al enviar. La tarjeta final lee el evento propio de cada llamada (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`); una llamada sin evento se omitió. Las transferencias de tokens a la billetera, y `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault` en modo protegido, se suman por token entre las llamadas cobradas. La pausa (`whenNotPaused` en cada llamada) y una billetera marcada detienen el lote antes de firmar.

<a id="payout-queue"></a>

### La cola de pagos: qué se comprueba

La lista es `getPendingPayoutIds(account)`, con `getPendingPayout(id)` y `requestCode(id)` por fila; el código se muestra como seis caracteres base32 con el mismo renderizador compartido que usan las alertas, y las filas se ordenan por `releaseAt` frente a la marca de tiempo del último bloque, no el reloj del navegador. `releasePayout(id)` no requiere permiso y se rechaza durante una pausa hasta `isEscapeOpen()`. Una fila en cola cuyo destinatario no es el gestor (la cuenta, o su controlador una vez retirada) ni está en `getAllowlist` se cancela en lugar de pagarse, antes de la comprobación de tiempo; si no, la fila debe haber vencido, la cuenta estar desbloqueada (`ProtectedVaultLocked`) y, mientras `requireCosign` esté activo, estar cofirmada (`CosignRequired`), y el destinatario se vuelve a comprobar. `cancelPayout(id)` corresponde al gestor o a un firmante (`NotManagerOrSigner`), funciona durante una pausa y abona el libro de depósitos para que el activo pueda retirarse de nuevo. `cosignPayout(id)` corresponde a un firmante de `getProtectedSigners` (`NotSigner`); la app solo lo ofrece mientras la cuenta lo exige y la fila aún no está cofirmada. Cada acción se ejecuta en simulación en la revisión y de nuevo al enviar. La tarjeta final lee `PayoutReleased` (el importe y el `delivered` medido por el protocolo), `PayoutCancelled` y `PayoutCosigned` para ese id. Si el paso `protectedAccount` del keeper libera las filas vencidas es la respuesta del servicio de capacidades, desconocida por defecto. Un bloqueo cancela todas las filas en cola.

<a id="seller-interest"></a>

### Intereses de una posición que vendiste: qué se comprueba

Una venta registra los intereses ganados y no pagados del vendedor como un derecho: `getInterestLedger(loanId)` lista los derechos abiertos, el más antiguo primero, cada uno con su importe bruto. `claimAsSeller(loanId)` lleva `whenNotPaused` y el control de sanciones. En un préstamo Repaid, Defaulted, Settled o InternalMatched con derechos abiertos, primero reparte la recuperación del prestamista (`getSellersShareOfLenderClaim`), paga cada derecho hasta su importe neto (bruto menos la parte `treasuryFeeBpsAtInit` del préstamo, redondeado hacia abajo; el 1 % heredado donde el préstamo no registró ninguna) y los cierra todos; un préstamo FallbackPending no reparte. Después retira `getSellerInterestHeld(loanId, seller, asset)` del token principal y, si es distinto, del token del derecho del prestamista, de la bóveda propia del vendedor a su billetera, y rechaza con `NothingToClaimAsSeller` cuando es cero. La app lista los préstamos a partir de la actividad del índice archivada bajo la billetera como vendedora (`SellerInterestClaimRecorded`, `SellerInterestPaid`, `SellerInterestClaimClosed`, `SellerInterestWithdrawn`); la búsqueda por número lee solo la cadena. En el token principal la revisión deriva exactamente la parte de la billetera a partir del reparto; en otro token el reparto es por valor y se indica como decidido al ejecutarse. La retirada se simula en la revisión y otra vez al enviar. La tarjeta final lee `SellerInterestClaimClosed` (pagado, acreditado, pagado por completo) y `SellerInterestWithdrawn`, con `PayoutQueued` o `PayoutHeldInVault` donde el modo protegido puso en cola o retuvo el pago.

<a id="frozen-proceeds"></a>

### Pagos congelados: qué se comprueba

La app lee `getSanctionsOracle` (cero significa que no hay control en esta cadena), `sanctionsStatus(wallet)` (Clean, Flagged o Unavailable cuando el control revierte) e `isSanctionsConfirmedFlagged(wallet)`, el registro que `refreshSanctionsFlag` sincroniza a partir de una lectura definitiva. Flagged, o Unavailable con la billetera registrada, se lee como congelado; Unavailable sin registro, no. `claimAsLender` y `claimAsBorrower` controlan al llamante después de `whenNotPaused` y dejan pasar una caída; un lado cuyo pago el protocolo congeló para una parte registrada se libera de forma fail-closed, revirtiendo con `SanctionedAddress` o `SanctionsOracleUnavailable` hasta que esa parte lea Clean, quienquiera que tenga la posición entonces. El protocolo no ofrece una vista de esa parte registrada, así que la app se apoya ahí en la simulación y expresa su rechazo con las mismas palabras. `claimAsSeller` rechaza a un vendedor marcado, y a uno registrado durante una caída. Mientras un préstamo sigue en curso, la parte del prestamista aparcada para un titular marcado se suma a `heldForLender` en `getClaimable(loanId, true)`, reservada en la bóveda del prestamista registrado hasta que el claim del prestamista la pague. El reembolso sigue abierto para un prestatario marcado; añadir garantía, no.

<a id="extension-reserves"></a>

### Reservas de extensión: qué se comprueba

`fundExtendReserve(loanId, amount)` deposita el token de principal del préstamo desde la billetera del titular de la posición del prestatario en su propia bóveda y lo reserva para ese préstamo. Lleva `whenNotPaused` y el control de sanciones, y se rechaza salvo que el préstamo esté Active, sea un préstamo ERC-20 y no tenga cadencia periódica. `getExtendFunding(loanId, holder)` devuelve el token, `reserved`, el otro saldo libre del titular y lo que una extensión cobraría ahora y al final de la ventana; una extensión cobra solo de la bóveda del titular actual, primero de la reserva. `withdrawExtendReserve(account, loanId, amount)` lleva `whenNotPaused`, exige que quien llama sea el gestor de la cuenta (su propia billetera, o su controlador tras un reemplazo), controla a quien llama (abierto ante una caída) y revierte con `ExtendReserveInsufficient` por encima de lo reservado; está abierta sea cual sea el estado del préstamo. La app lista los préstamos a partir de la actividad del índice registrada bajo la billetera (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`); la búsqueda por número lee solo la cadena. Retira toda la reserva que leyó la revisión, ejecuta la llamada como prueba en la revisión y de nuevo al enviar, y la tarjeta final lee `ExtendReserveWithdrawn` (el importe y lo que sigue reservado), con `PayoutQueued` o `PayoutHeldInVault` donde el modo protegido encoló o retuvo el pago.

<a id="vault-holdings"></a>

### Tu bóveda: qué se lee

La bóveda es `VaultFactoryFacet.getUserVaultAddress(wallet)`; `getOrCreateUserVault(wallet)` la crea (control de sanciones de nivel 1, sin bloqueo por pausa), y la tarjeta final lee `UserVaultCreated`. Por activo, en un mismo bloque: el saldo propio de la bóveda (ERC-20 `balanceOf`, ERC-721 `ownerOf`, ERC-1155 `balanceOf`), `getTrackedHolding`, `withdrawableNow` y `untrackedHolding`. «En tu bóveda» es el menor entre el saldo y la tenencia registrada; «Libre para retirar ahora» es `withdrawableNow` tal como se devuelve (la tenencia de depósito, limitada por `freeHolding`: lo registrado menos los gravámenes menos la reserva del modo protegido); «Retenido por tus posiciones» es la cifra contada menos eso. Los activos salen de `getDepositoryAssets(wallet, offset, limit)`, leído por páginas hasta el total devuelto (una página vacía antes se lee como incompleta), con el estándar de cada contrato listado leído por ERC-165, más los tramos (activo prestado, garantía, el token de la tarifa de alquiler prepagada) de cada préstamo en `getUserLoansPaginated(wallet)` y de cada préstamo cuya posición tiene la billetera, cada uno leído con `getLoanDetails` en el mismo bloque, y los de cada oferta que haya creado, de `getUserOffersPaginated(wallet)`, cada una leída con `getOffer` (el depósito de una oferta queda en el vault de su creador aunque su NFT de posición se transfiera). También se añade el activo prestado de cada oferta permanente en `getLenderIntentsByOwner(wallet)`, incluidas las canceladas: financiar una pone ese activo en el vault sin una entrada en el registro de depósitos. El registro no guarda ids de tokens NFT, así que cada colección NFT depositada se nombra en una nota, y solo un token que nombra un préstamo o una oferta se lista con cifras. El polvo es una cifra contada mayor que cero y menor que 1e-11 de un token entero.

<a id="vault-deposit"></a>

### Depositar en tu bóveda

El depósito es `VaultDepositoryFacet.depositToVault(kind, asset, tokenId, amount)`: kind 0 es ERC-20, 1 ERC-721, 2 ERC-1155; el id del token es 0 para un ERC-20 y la cantidad 1 para un ERC-721. Es `whenNotPaused`, examina a quien llama (Tier-1) y rechaza una billetera retirada por un reemplazo (`requireManager`). La revisión lee, en un mismo bloque, `getUserVaultAddress`, `paused`, la postura de sanciones, `getProtectedAccount(wallet)` y el saldo y la aprobación de la billetera; una pausa, examen o retiro no leídos se declaran y decide la ejecución de prueba. La aprobación es un `approve` exacto de ERC-20 (dos pasos cuando el token debe ponerse antes a cero), `approve(diamond, tokenId)` para un ERC-721, o `setApprovalForAll(diamond, true)` para un ERC-1155, retirado tras el depósito salvo que ya existiera. La ejecución de prueba corre tras la aprobación; un ERC-20 se cobra con comprobación de llegada exacta (`LibDelivery.pullExact`), así que un token con comisión al transferirse revierte. La tarjeta final lee `VaultDeposited(account, asset, kind, tokenId, amount)` y los registros de transferencia del propio token hacia la bóveda. No hay ruta permit para este depósito. De `getProtectedAccount(wallet)` la revisión guarda también `enabled`, `locked`, `delaySeconds` y `requireCosign`, y el recibo dice cómo puede salir de nuevo el depósito: al instante, tras el plazo (con un firmante secundario donde se exija), o no mientras la cuenta está bloqueada, algo que `depositToVault` no rechaza. La última comprobación antes de firmar vuelve a leer `hasAcceptedCurrentTerms` y rechaza una versión no aceptada.

<a id="vault-withdraw"></a>

### Retirar de tu bóveda

El retiro es `VaultDepositoryFacet.withdrawFromVault(account, kind, asset, tokenId, amount, recipient)`, con `account` y `recipient` iguales a la billetera conectada. Lo limita `withdrawableNow(account, kind, asset, tokenId)` (si no, `AmountExceedsFree`), comprueba `requireManager(account)`, examina a quien llama (Tier-1) y al destinatario, y se rechaza en pausa salvo que la cuenta esté protegida e `isEscapeOpen` sea verdadero. La revisión lee, en un bloque, `getUserVaultAddress`, `paused`, `isEscapeOpen`, el estado de sanciones, `getProtectedAccount(wallet)` y `withdrawableNow`, y luego ejecuta la llamada de prueba. Sin el modo protegido las rutas de la bóveda pagan a la billetera al instante; con él, `LibProtectedAccount.queuePayout` pone el pago en cola durante `delaySeconds` y rechaza `ProtectedVaultLocked`, `RecipientNotAllowlisted` y `TooManyPendingRows`. La tarjeta final lee `VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, queued)`, `PayoutQueued` y los propios registros de transferencia del token de la bóveda a la billetera. Una colección que el registro de depósitos nombra sin ids se retira escribiendo el id del token; el límite del formulario es `withdrawableNow` para ese token, leído en cada bloque.

<a id="vault-safety"></a>

### Seguridad de la cuenta

La tarjeta lee, en un mismo bloque, `getProtectedAccount(wallet)`, `getProtectedDelayBounds()`, `paused`, el estado de sanciones y `getPendingPayoutIds(wallet)`; un revert `FunctionDoesNotExist` se lee como no disponible. Activar es `enableProtectedMode(delaySeconds, protectNfts)`: inmediato, rechazado durante una pausa o si ya está activo, con el plazo dentro de los límites (de dos a cinco días), y crea la bóveda si no existe. Bloquear ahora es `lockVault(wallet)`: abierto durante una pausa, cancela cada fila en cola (`PayoutCancelled`), descarta cada cambio pendiente y anula un reemplazo que propuso el gestor. Pedir el desbloqueo es `requestUnlock(wallet)`, rechazado durante una pausa o antes de `cooldownUntil`, y fija `pendingUnlockAt` en ahora más `delaySeconds`. Aplicar los cambios vencidos es `finalizeSettingChanges(wallet)`, que aplica a la vez cada cambio vencido; la desactivación espera hasta que no quede ninguna fila abierta (`PendingRowsExist`). Cada acción se simula en la revisión y otra vez antes de abrir la billetera, y la tarjeta final lee `ProtectedModeEnabled`, `VaultLocked`, `PayoutCancelled`, `SettingChangeRequested` y `SettingChangeApplied` de los registros del Diamond.

<a id="vault-escape"></a>

### Cuando el protocolo está en pausa

El aviso lee, en un mismo bloque, `paused`, `VaultPayoutFacet.isEscapeOpen`, `escapeOpensAt` (el inicio de la pausa manual más el periodo de escape con que empezó; cero si no hay ninguna en vigor o el Diamond nunca se lanzó) y `getProtectedAccount(wallet)`, y cuenta atrás con la hora del bloque. En pausa con la vía cerrada, `withdrawFromVault` revierte con `EnforcedPause` y la revisión dice que la pausa lo detiene. Cuando `isEscapeOpen` es verdadero, una cuenta protegida sigue usando `withdrawFromVault`, que sigue poniendo en cola; el retiro de cualquier otra billetera llama a `escapeWithdraw(kind, asset, tokenId, amount)`, que rechaza una cuenta protegida (`EscapeNotForProtected`), rechaza un destinatario vetado, está limitado por el saldo propio de depósito de la billetera y la cifra libre, y paga a quien llama. La tarjeta final lee `EscapeWithdrawal(account, asset, tokenId, amount)` y la transferencia del propio token de la bóveda a la billetera. Si la pausa, la vía o, con la vía abierta, el modo no se pueden leer, no se envía ningún retiro.

<a id="protection-addresses"></a>

### Direcciones guardadas

La libreta se guarda en `localStorage` por id de cadena y billetera, nunca on-chain. Una billetera entra tras firmar `AddressControl{account, destination, purpose, nonce, issuedAt}` en el dominio `{name: 'Vaipakam Address Check', version: '1', chainId, verifyingContract: Diamond}`, con un nonce aleatorio de 32 bytes y una vigencia de siete días. La solicitud viaja como `/protection?prove=<code>`. La página de firma rechaza una red o un Diamond que esta aplicación no sirve y una solicitud caducada, y solo firma cuando la cuenta conectada es esa dirección en esa cadena. La respuesta pegada se comprueba con `verifyTypedData` mediante la propia conexión de lectura de la billetera conectada, de modo que una billetera inteligente responde por ERC-1271, y solo se guarda si responde a esa misma solicitud. El campo de dirección muestra la dirección completa con sus primeros y últimos caracteres separados, rechaza una suma de control EIP-55 rota y rechaza sin excepción toda dirección cuyos tres primeros y tres últimos dígitos hexadecimales igualan los de una ya usada (la propia, las entradas guardadas y en espera, los destinos activos y en espera, los firmantes protegidos, los keepers aprobados y el keeper de la red) mientras el resto difiere. Una dirección nueva requiere una marca explícita, que cualquier edición borra.

<a id="protection-destinations"></a>

### Destinos de pago

La sección lee, en un bloque, `getProtectedAccount`, `getAllowlist`, `getPendingAllowlistAdditions` (cada solicitud con su `maturesAt`), `getProtectedSigners`, `paused` y los pagos en cola por destinatario de `getPendingPayoutIds`. Una solicitud espera antes de `maturesAt`, está lista hasta `maturesAt + delay` y caduca después, según la hora del bloque más los segundos transcurridos. Los cuatro cambios son `addAllowlisted`, `cancelAddAllowlisted`, `finalizeAddAllowlisted` y `removeAllowlisted`, cada uno con `(account, destination)`. La revisión se lee en un bloque y rechaza antes de la billetera lo que la facet rechazaría: una pausa o un bloqueo (al añadir y al activar), su propia billetera, una dirección ya activa o en espera, ya cinco destinos o cinco solicitudes, una dirección marcada, una solicitud aún no madura o caducada. Cada llamada se simula, se vuelve a comprobar justo antes de abrir la billetera y se mide por su propio log `AllowlistAddRequested`, `AllowlistAddCancelled`, `AllowlistAdded` o `AllowlistRemoved`; una retirada también cuenta los logs `PayoutCancelled` que causó.

<a id="protection-signers"></a>

### Firmantes secundarios

La sección lee, en un mismo bloque, `getProtectedAccount` (con `requireCosign` y `pendingCosignOffAt`), `getProtectedSigners` con `getSignerChange` para el `removeAt` de cada firmante, `getPendingSignerAdditions` (cada cartera pedida con su `maturesAt` y su `accepted`) y `paused`. Los cambios son `addSigner`, `cancelAddSigner`, `finalizeAddSigner`, `requestRemoveSigner`, `cancelRemoveSigner` y `finalizeRemoveSigner`, cada uno con `(account, signer)`; `acceptSignerRole(account)`, enviado por la cartera pedida desde el enlace de aceptación (`/protection?signer=<account>&chain=<id>`); y `setRequireCosign(account, on)`. La revisión rechaza antes de la cartera lo que rechazaría la facet: una pausa (salvo para cancelar), un bloqueo o el periodo de enfriamiento de una nueva cartera principal (al pedir, quitar y desactivar la cofirma), tu propia cartera, una cartera que ya es firmante o ya fue pedida, una solicitud caducada aún no cancelada, cinco firmantes o cinco solicitudes ya, una cartera pedida que no aceptó, una espera no terminada o una ventana vencida, y una cofirma sin firmante. Cada llamada se simula, se vuelve a preguntar justo antes de abrir la cartera y se mide desde su propio registro `SignerAddRequested`, `SignerAccepted`, `SignerAddCancelled`, `SignerAdded`, `SignerRemoveRequested`, `SignerRemoveCancelled`, `SignerRemoved`, `CosignRequirementSet` o `SettingChangeRequested`. Las carteras pedidas en espera se suman a la lista de direcciones conocidas del control de direcciones.

<a id="my-offers"></a>

### Tus ofertas

La lista es la unión de `getUserOffersPaginated(wallet)` (el índice por creador, que conserva un id cancelado) y `getUserPositionOffersPaginated(wallet)` (las ofertas cuyo token de posición tiene la billetera), leídas en lotes de como máximo 250 mediante `MetricsDashboardFacet.getOffersWithState`, que responde posición por posición. Cada fila se asocia al id que se pidió: una oferta cancelada sin nada completado tiene su registro borrado, así que la vista informa id 0 con el estado derivado Cancelada, y la fila no muestra condiciones en lugar de reconstruirlas. Una oferta cancelada tras un llenado parcial conserva su registro con `accepted` activado y se lee como completada. Los recuentos de los filtros se calculan sobre las filas leídas; si alguno de los índices no pudo leerse hasta el final, la página dice que la lista puede estar incompleta.

<a id="offer-book"></a>

### El libro de ofertas

El libro lee `GET /offers/active?chainId&limit=50&before=<offerId>` del indexador, de la más nueva a la más antigua por id de oferta, paginado con `nextBefore`. El indexador mantiene `active` una oferta caducada (el vencimiento es perezoso en la cadena), así que una fila cuyo `expiresAt` ya pasó se marca como vencida. `isSaleVehicle`, `isOffsetVehicle` y `refinanceTargetLoanId` (null = no leído) marcan el tipo, y `positionFlow.movedSinceOpened` una posición vinculada que se movió (#3205). Cada campo se analiza con exactitud; una fila que falla se cuenta como no leída. La pestaña es `assetType` (0 = un préstamo ERC-20; si no, un alquiler) y el lado, `offerType`. La consulta se invalida con el canal push y se vuelve a leer cada 60 s mientras está visible; un fallo del índice se indica, nunca un libro vacío. El libro se solicita solo cuando hay una billetera conectada en una red atendida; antes, la página pide una.

<a id="offer-detail"></a>

### La página de una oferta

`/offers/:id` lee, en un mismo bloque, `OfferCancelFacet.getOffer(id)`, `MetricsFacet.getOfferState(id)` y `getOfferLinkedLoanId(id)`, a través de la billetera conectada; no se lee nada antes de conectar una billetera. Un creador cero significa que el registro se borró (una cancelación sin nada cubierto) o nunca se escribió; el protocolo no lleva un recuento de ofertas, así que la página no dice cuál de los dos. Un préstamo vinculado distinto de cero marca una venta de préstamo (oferta de prestatario) o una compensación (oferta de prestamista); el `refinanceTargetLoanId` de una oferta de prestatario marca una solicitud de refinanciación. Tomarla ejecuta el flujo compartido `acceptOffer` (`AcceptTerms` firmados, aprobación exacta, simulación, resultado medido) con su propia clave de almacenamiento; cancelar y limpiar ejecutan el flujo compartido `cancelOffer`. Los alquileres, la garantía NFT, las ventas de préstamos y las compensaciones enlazan a la app actual.

<a id="offer-cancel"></a>

### Cancelar una oferta

La revisión lee, en un mismo bloque, `getOffer(id)`, `getOffersWithState([id])`, `getOfferLinkedLoanId(id)`, `paused()` y el `getProtectedAccount` del creador, y luego simula `OfferCancelFacet.cancelOffer(id)`. La faceta permite al gestor del creador cancelar en cualquier momento y a cualquiera una vez pasado `expiresAt`; rechaza `OfferAlreadyAccepted`, `OfferAlreadyConsumedBySale` y `CancelCooldownActive` mientras una oferta con `amountFilled == 0` tenga menos de 300 segundos y no haya vencido, y es `whenNotPaused`. La devolución se calcula con las propias ramas de la faceta: una oferta de préstamo ERC-20 devuelve `(amountMax o amount) - amountFilled` del activo prestado; una oferta de préstamo de NFT su token, o su cantidad ERC-1155; una solicitud de préstamo su garantía sin usar `(collateralAmountMax o collateralAmount) - collateralAmountFilled`, o su NFT, y nada cuando `refinanceCarryOver` mantiene la garantía en el préstamo; una solicitud de alquiler `amount × durationDays` más el margen a `rentalBufferBpsAtCreate`. Una oferta ligada a un préstamo por `getOfferLinkedLoanId`, o una solicitud de alquiler con margen registrado en cero (el protocolo usa entonces su tasa actual), no se calcula antes de firmar. Toda devolución sale de la bóveda del creador por el retiro de bóveda, así que el modo protegido la pone en cola, o la mantiene en la bóveda mientras la cuenta está bloqueada. El token de posición se retira. La tarjeta final lee `OfferCanceled(offerId, creator)`, el registro de pago del protocolo para el creador y la propia transferencia del token al creador.

<a id="offers-price-guard"></a>

### Protección ante movimientos de precio

En una oferta abierta de un ERC-20 contra garantía ERC-20, el creador puede fijar, cambiar o quitar una protección ante movimientos de precio desde la página de la oferta. Al registrarse, el protocolo anota los precios de oráculo de ambos tokens; desde entonces se rechaza toda toma mientras la relación garantía/principal se haya alejado de ese nivel más que el límite (del 0,5 % al 50 %, en cualquier sentido), mientras el par haya superado el límite de calma frente a cualquiera de las dos últimas comprobaciones horarias de precio, o mientras falte un precio actual o una de esas comprobaciones. La comprobación se hace al crear el préstamo, así que cubre una toma directa y un emparejamiento, y la página muestra a todos el límite, cuánto se ha movido la relación y si ahora se permite tomarla. Cualquiera puede escribir las comprobaciones horarias, y el keeper del protocolo está previsto para escribirlas para los activos de las ofertas protegidas abiertas; mientras falten para ambos tokens, nadie puede tomar la oferta. Una protección fijada en una oferta publicada protege desde el bloque en que se registra, no antes; cambiarla vuelve a registrar los precios. No mueve nada ni cambia ninguna condición. También puede activarse al publicar, en las opciones avanzadas del formulario de oferta: la protección y la publicación van en una sola transacción, así que la oferta nunca está en el libro sin protección, y un par cuyos precios no se pueden leer rechaza ambas.

<a id="risk-access"></a>

### Risk Access: tu nivel de riesgo

El interruptor es `getRiskAccessGateEnabled`. Qué paso necesita un flujo es la propia respuesta del protocolo: para una aceptación, `previewOfferAcceptBlock` (1 = nivel demasiado bajo, 2 = acuerdo con el par, 3 = reconocimiento del modo estricto, 4 = el par ilíquido que antes cubría el reconocimiento de la aceptación; bloquea como 2 y un consentimiento al par lo despeja) una vez que `previewCreatorBlock` muestra que el prestamista no está bloqueado; para una solicitud, `RiskTierTooLow`, `IlliquidPairNotConsented` o `MidTierPairNotAcknowledged` de la simulación de `createOffer`. El paso lee en un solo bloque `pairRequiredRiskLevel` para el par (`acceptMidTierAckPair` para una oferta), `getVaultRiskTier`, `getEffectiveRiskTier`, `getVaultRiskTierVersion` frente a `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown` y `getRiskTierMutationNonce`, y para un par `isPairConsentPending` con `hasIlliquidPairConsent`, o `isMidTierAckPending` con `midTierStrictBlocked`. Una subida es `setVaultRiskTierChecked(level, nonce, termsVersion)` al nivel mínimo que necesita el par, así que se rechaza sin cambiar nada si otra escritura de nivel o un cambio de términos llegó después de la revisión. Un paso de par es `setIlliquidPairConsent(pair, true)` o `setMidTierPairAck(pair)`. Una subida aún en espera, o un paso de par aún pendiente, no se ofrece de nuevo. Ninguna lectura devuelve cuándo entra en vigor un paso de par pendiente, así que la revisión dice que no puede leer esa hora; solo la tarjeta final del propio paso la da, a partir de la hora del bloque del recibo más la espera. El resultado se lee en el bloque del recibo.

<a id="terms-gate"></a>

### El aviso de los Términos

`getCurrentTos` devuelve la versión y el hash del contenido vigentes en la cadena de la acción; la versión 0 significa ninguna y nada queda bloqueado. A una wallet cuyo `hasAcceptedCurrentTerms` es false se le pregunta antes de una nueva exposición, y el aviso enlaza `/terms/v<N>`, la página fijada a la versión cuyo texto nunca cambia. Aceptar llama a `acceptTerms(version, hash)` una sola vez. Antes de abrir la wallet se vuelve a leer el par: una versión más nueva reemplaza la mostrada y una aceptación hecha en otra pestaña deja continuar la acción. Una lectura fallida es «no se puede confirmar», con reintento, nunca «no aceptado». Las salidas nunca se bloquean.

<a id="settings"></a>

### Ajustes

Ajustes reúne lo que configuras una vez. El modo y el tema se guardan en el almacenamiento de este navegador para este sitio, y el idioma ahí y en la cookie `vaipakam_lang` que comparten los sitios de la plataforma; el atributo de idioma de la propia página sigue en inglés hasta que salga una traducción. La línea de Términos lee `getCurrentTos` y la aceptación de la billetera en la red conectada: ninguno en vigor, aceptado con la versión y la huella del texto, o en vigor y no aceptado, que se pide en la primera acción restringida. Una lectura fallida es «no se pudo confirmar», con reintento, nunca «no aceptado». El interruptor del descuento de comisiones es `setVPFIDiscountConsent`, el mismo flujo que en Inicio. Esta versión no incluye captura de diagnósticos. El navegador también guarda qué alertas se vieron, el registro de los canales de alerta, la hora de la última solicitud de alerta firmada, el último par de tokens, las tarjetas de inicio cerradas y la última conexión del conector de la billetera; nunca una clave ni una firma. La descarga escribe un archivo JSON con los registros propios de la app (las claves que empiezan por `app.` o `alpha05.`, y el idioma), nombra las direcciones de billetera bajo las que se guardan esos registros y cuenta, sin copiarlos, los elementos de sesión del conector de la billetera y las bases de datos de este sitio. Borrar desconecta primero cada conexión de billetera para que el conector no vuelva a escribir sus registros, luego elimina el almacenamiento local y por pestaña de este sitio, borra sus bases de datos cuando el navegador puede listarlas y caduca la cookie `vaipakam_lang` en cada dominio donde pueda estar; después recarga y muestra, para esa pestaña, lo que se eliminó y lo que el navegador rechazó, con el motivo. Solo vuelve a escribir las marcas de «desconectado» del conector de la billetera, para que la recarga no vuelva a conectar una billetera que aún autoriza este sitio; si el navegador no conserva el informe tras la recarga, la página se queda y lo muestra.

El acceso por riesgo lee en un bloque `getVaultRiskTier`, `getEffectiveRiskTier`, la versión de términos del nivel frente a `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown`, `getRiskStrictMode`, `getStrictModeStrictUntil` y `getRiskAccessGateEnabled`. Indica el nivel que cuenta y por qué difiere del elegido: una subida aún en espera (con la hora en que cuenta) o un cambio de términos (cuenta como blue-chip hasta confirmarlo). Un cambio de nivel es `setVaultRiskTierChecked`, con el contador de cambios y la versión de términos leídos, de modo que una escritura desde otro lugar o nuevos términos lo rechazan sin cambiar nada; una subida espera el periodo y nunca se vuelve a ofrecer mientras espera; bajar es inmediato. El control solo se aplica al originar, así que bajar cierra los pares por encima a nuevas ofertas y solicitudes (las tuyas abiertas no pueden aceptarse) y no toca los préstamos abiertos. El modo estricto es `setRiskStrictMode`: se activa al instante; desactivado sigue aplicando durante el periodo, y la página dice hasta cuándo. En una red con el control apagado, un cambio se guarda y solo cuenta si el control se enciende. Los acuerdos y reconocimientos por par siguen en los flujos que los necesitan.

Aprobaciones lee en un bloque el `allowance(wallet, Diamond)` de cada ERC-20, el `allowance(wallet, token, Diamond)` de Permit2 donde está desplegado (uno vencido no se lista), `isApprovedForAll(wallet, Diamond)` para cada colección de NFT y `getApproved` para cada token ERC-721 que nombra una posición y que la billetera aún posee. Se revisan los activos sugeridos, cada activo de `getDepositoryAssets`, los lados de cada préstamo de `getUserLoansPaginated` y de cada oferta de `getUserOffersPaginated`, el activo prestado de cada oferta permanente y cualquier contrato que añadas. Una aprobación igual o superior a 2^255 (2^159 vía Permit2) se muestra como ilimitada. Retirarla envía `approve(Diamond, 0)`, el `approve(token, Diamond, 0, 0)` de Permit2, `setApprovalForAll(Diamond, false)` o `approve(0x0, tokenId)`; la fila se vuelve a leer antes de abrir la billetera y en el bloque del recibo. Un registro no leído hasta el final, o un activo que no responde, se indica, nunca se muestra como sin aprobación. También se comprueba el activo de garantía de una oferta permanente, y un token que la wallet posee cuyo `getApproved` no responde cuenta como desconocido. El recibo lee, en el mismo bloque que la fila, la otra aprobación del mismo activo (`isApprovedForAll` para un token, `getApproved` de los tokens encontrados para una colección, la `allowance` de Permit2 para un ERC-20, la `allowance` ERC-20 para una de Permit2) y la nombra como vigente, o dice que es desconocida; un cambio antes de que se abra la wallet detiene la firma.

Keepers lee, en un solo bloque, `getKeeperAccess`, `getApprovedKeepers` y `getKeeperActions` para cada keeper aprobado (cinco como máximo). Las acciones son los bits del protocolo. Completar la venta de una posición prestamista (0x01), completar un cierre anticipado por compensación (0x02), iniciar la venta de una posición prestamista (0x04), iniciar un cierre anticipado (0x08) y extender dentro de los límites acordados (0x20) actúan sobre un préstamo solo si el préstamo u oferta también habilita a ese keeper; llenar ofertas de préstamo permanentes que exigen un keeper (0x40), volver a poner el dinero devuelto en ofertas permanentes (0x80) y bloquear una cuenta protegida (0x100) actúan para toda la cuenta en cuanto el acceso está activado. El bit 0x10 está retirado y se rechaza. Los cambios envían `setKeeperAccess`, `approveKeeper`, `setKeeperActions` o `revokeKeeper`; un cambio que da más a un keeper pide los Términos si hay una versión en vigor, quitar uno nunca, y todo cambio, quitar incluido, se rechaza mientras el protocolo está en pausa. El keeper de esta app se nombra a partir del registro de despliegue.

La app incluye un manifiesto web (`/manifest.webmanifest`) con los cuatro accesos directos y un icono adaptable. En Ajustes › Instalar la app, el botón aparece solo después de que el navegador dispara su evento `beforeinstallprompt`, y abre ese diálogo; si no, la página indica el caso (instalada, iOS o no ofrecida). Una versión desplegada registra `/sw.js`, escrito a partir de la salida de esa versión: guarda una copia de un archivo con hash de `/assets/` de la versión la primera vez que la página lo pide, responde las peticiones posteriores de ese archivo desde la copia, borra los almacenes de versiones anteriores al tomar el control, y nunca responde una navegación, una petición a otro origen ni un archivo que no esté en su lista. Tus datos en este navegador cuentan y borran esos almacenes.

<a id="rent-review"></a>

### Alquilar: alquilar un NFT

La revisión lee la oferta con `getOffer` (su `rentalBufferBpsAtCreate`), el veredicto del protocolo y la tarifa diaria con `previewAccept`, y `getRiskConfig` solo para una oferta que no registró margen propio. El total es `amount × durationDays` más esa parte, redondeado hacia abajo como lo redondea el protocolo, y la simulación demuestra que ambos coinciden. El alquiler es `acceptOffer` con `AcceptTerms` firmados que nombran el NFT como la parte ilíquida reconocida y ninguna parte de garantía; el derecho de uso se vuelve a leer en la bóveda del propietario en el bloque del recibo con `vaultGetNFTUserOf`, o `vaultGetNFTQuantity` para un ERC-1155.

<a id="rent-risks"></a>

### Alquilar: riesgos

Nunca eres dueño de un NFT alquilado, y tu derecho a usarlo termina con el alquiler. El alquiler y el margen se quedan en tu bóveda para el alquiler y no se pueden retirar mientras esté abierto. Cuando todos los días acordados están liquidados, algo que cualquiera puede hacer, el alquiler se cierra solo y puedes reclamar tu margen. Hasta entonces lo cierras tú, desde su página de posición. Cerrar durante el periodo de gracia cuesta un recargo por demora, tomado del margen; pasado ese periodo el alquiler entra en impago, el alquiler que queda en tu bóveda va al propietario y el margen al protocolo, y no recibes nada de vuelta. Con cobro por plazo completo se debe todo el plazo aunque cierres antes.

<a id="rent-list"></a>

### Alquilar: ofrecer tu NFT en alquiler

El formulario lee el estándar de la colección con ERC-165 `supportsInterface` y el plazo más largo de `getProtocolConfigBundle`. La revisión lee el token con `ownerOf`, `getApproved` e `isApprovedForAll` (`balanceOf` para un ERC-1155), la clase del token de pago con `getAssetPriceStatus` y la prueba de liquidez, la parte de margen con `getRiskConfig`, el periodo de gracia con `getEffectiveGraceSeconds` y la parte del protocolo con `getTreasuryFeeBps`, y luego simula `createOffer` con `assetType` 1 o 2, `amount` y `amountMax` iguales a la tarifa diaria, todos los campos de garantía y de tipo a cero y `prepayAsset` el token de pago. Publicar registra `rentalBufferBpsAtCreate`; el resultado se lee del registro `OfferCreated` de la transacción y del propio registro `Transfer` (o `TransferSingle`) del NFT hacia la bóveda del propietario.

<a id="rent-list-risks"></a>

### Alquilar: riesgos de ofrecer

El NFT se queda en tu bóveda mientras la oferta está abierta y mientras está alquilado, y no puedes retirarlo hasta que termine la oferta o el alquiler. Mientras nadie lo haya alquilado, puedes cancelar la oferta desde su página pasados sus primeros cinco minutos. Una vez alquilado, el arrendatario tiene el derecho a usar el NFT hasta que termine el alquiler, y no puedes retirárselo antes. El alquiler llega a tu bóveda, menos la parte del protocolo, a medida que se liquida cada día terminado; cualquiera puede liquidarlo. Cuando todos los días acordados están liquidados, el alquiler se cierra solo y el arrendatario puede reclamar el margen. Antes, lo cierra el arrendatario o, pasado el periodo de gracia, cualquiera puede cerrarlo como impago. Si lo cierra el arrendatario, puedes reclamar el alquiler aún no liquidado y cualquier recargo por demora, menos la parte del protocolo, y el resto del margen vuelve al arrendatario. En un impago puedes reclamar el alquiler restante, menos esa parte, y el margen va al protocolo. Una pausa detiene la liquidación diaria y retrasa las fechas del recargo y del impago, pero nunca alarga el uso del arrendatario. Una oferta que caduca deja el NFT en tu bóveda hasta que se cierra.

<a id="rent-request"></a>

### Alquilar: pedir un NFT en alquiler

El formulario lee el estándar de la colección con ERC-165 `supportsInterface` y el plazo más largo de `getProtocolConfigBundle`. La revisión lee el titular del token con `ownerOf` (un ERC-1155 no tiene lista de titulares), la clase del token de pago de `getAssetPriceStatus` y la comprobación de liquidez, el `balanceOf` y el `allowance` de la billetera en el token de pago, la parte de margen de `getRiskConfig` y el periodo de gracia de `getEffectiveGraceSeconds`, y después simula `createOffer` con `offerType` 1, `assetType` 1 o 2, `amount` y `amountMax` iguales a la tarifa diaria, todos los campos de garantía y de tipo a cero y `prepayAsset` igual al token de pago. Publicar registra `rentalBufferBpsAtCreate` y lleva la tarifa diaria por el plazo más esa parte a la bóveda del arrendatario; el resultado se lee del registro `OfferCreated` de la transacción y del registro `Transfer` del token de pago hacia la bóveda.

<a id="rent-request-risks"></a>

### Alquilar: riesgos de una solicitud de alquiler

El alquiler y el margen se quedan en tu bóveda mientras la solicitud está abierta, y no puedes retirarlos hasta que la canceles o termine. Mientras ningún propietario la haya aceptado, puedes cancelar la solicitud desde su página pasados sus primeros cinco minutos, y vuelven a tu billetera. Un propietario que la acepta inicia el alquiler de inmediato con exactamente estas condiciones: tienes el derecho a usar el NFT, nunca el NFT en sí. Cuando todos los días acordados están liquidados, algo que cualquiera puede hacer, el alquiler se cierra solo y puedes reclamar tu margen; hasta entonces, ciérralo desde su página de posición. Cerrar tarde cuesta un recargo por retraso tomado del margen, y si entra en impago el alquiler va al propietario y el margen al protocolo. Una solicitud que caduca deja el alquiler y el margen en tu bóveda hasta que se cierre. La parte del margen es el ajuste del protocolo cuando la solicitud se registra: si cambia después de tu revisión, uno más alto se rechaza cuando tu billetera aprobó exactamente este importe y se cobra cuando una aprobación anterior lo cubre, y el resultado indica lo que se movió.

<a id="rent-take"></a>

### Alquilar: aceptar la solicitud de un arrendatario

La revisión lee la solicitud con `getOffer` (su `rentalBufferBpsAtCreate`), el veredicto del protocolo de `previewAccept`, los ajustes de riesgo de ambas partes, el periodo de gracia de `getEffectiveGraceSeconds`, la parte del protocolo de `getTreasuryFeeBps` y `getRiskConfig` solo para una solicitud que no registró margen. `previewAccept` no comprueba quién tiene el NFT, así que la app lo lee con `ownerOf`, `getApproved` e `isApprovedForAll` (`balanceOf` e `isApprovedForAll` en un ERC-1155). Aceptarla es `acceptOffer` con `AcceptTerms` firmados: el protocolo lleva el NFT de la billetera del propietario a su bóveda y registra al arrendatario como su usuario hasta el fin del plazo. El resultado se lee de los logs de la transacción (el alquiler abierto desde esta solicitud y el `Transfer` o `TransferSingle` del NFT a la bóveda del propietario) y de `vaultGetNFTUserOf` en el bloque del recibo. Cada día terminado lo paga `autoDeductDaily(loanId)`, que cualquiera puede llamar mientras el protocolo no esté en pausa, a la bóveda de quien tenga el NFT de posición del propietario; el resto se reclama al cierre.

<a id="rent-take-risks"></a>

### Alquilar: riesgos de aceptar una solicitud

El NFT se queda en tu bóveda durante todo el alquiler, y no puedes retirarlo mientras esté abierto. El arrendatario tiene el derecho a usarlo hasta que termina el alquiler, y no puedes quitárselo antes. Las condiciones son las de la solicitud: no puedes cambiar la tarifa diaria, el plazo, la regla de alquiler ni el margen. El alquiler llega a tu bóveda, menos la parte del protocolo, a medida que se liquida cada día terminado; cualquiera puede liquidarlo. Cuando todos los días acordados están liquidados, el alquiler se cierra solo y el arrendatario puede reclamar el margen. Antes, lo cierra el arrendatario o, pasado el periodo de gracia, cualquiera puede cerrarlo como impago. Si lo cierra el arrendatario, puedes reclamar el alquiler aún no liquidado y cualquier recargo por demora, menos la parte del protocolo, y el resto del margen vuelve al arrendatario. En un impago puedes reclamar el alquiler restante, menos esa parte, y el margen va al protocolo. Una pausa detiene la liquidación diaria y retrasa las fechas del recargo y del impago, pero nunca alarga el uso del arrendatario. Una solicitud que no registró margen propio toma el ajuste de hoy cuando empieza el alquiler.

<a id="rent-close"></a>

### Alquilar: cerrar un alquiler

La página de un alquiler en curso te ofrece, como arrendatario, Cerrar el alquiler. Cerrar paga el alquiler debido y cualquier recargo por demora con el alquiler y el margen que prepagaste en tu propia bóveda, así que no se toma nada de tu billetera y no hay aprobación. La revisión muestra el alquiler debido si se cierra ahora y en un momento poco después, contado según la regla del alquiler (prorrateado: los días usados desde el inicio, un día empezado cuenta entero, menos los días ya liquidados; plazo completo: cada día acordado aún no liquidado), los días ya liquidados, cualquier recargo, lo que vuelve a ti como reclamo y lo que recibe el propietario: el alquiler y el recargo, menos la parte del protocolo. Si el prepago no alcanza para el cierre, la revisión lo dice antes de que se abra tu billetera. Después tu billetera te pide una sola vez cerrar el alquiler, que la app prueba primero en simulación. Luego la app comprueba en la cadena que el alquiler se cerró, el reclamo registrado para ti y que tu uso terminó. Lo que vuelve se cobra en la página Claims.

La revisión lee el alquiler con `getLoanDetails`, sus fechas con `getLoanDeadlines` y el recargo por demora con `calculateRepaymentAmount`, que en un alquiler es solo el recargo. El protocolo no publica ninguna cifra del alquiler, así que la app lo cuenta con la regla que aplica `repayLoan`, a partir de `startTime`, `lastDeductTime` y `durationDays`. Cerrar es `repayLoan(loanId)`, que solo el arrendatario puede llamar, antes de que termine el periodo de gracia. El resultado se lee del registro `LoanRepaid`, de `getClaimable(loanId, false)` y de `vaultGetNFTUserOf` en el bloque del recibo.

<a id="rent-close-risks"></a>

### Alquilar: riesgos de cerrar

Cerrar termina tu derecho a usar el NFT en el acto, aunque queden días acordados, y no se puede deshacer. El alquiler se cuenta cuando el cierre se confirma, así que un día que empieza antes se paga entero; con plazo completo se paga cada día acordado aún no liquidado, por pronto que cierres. Tras el fin del plazo se toma un recargo por demora de tu margen: el 1 % del alquiler total más el 0,5 % por cada día de retraso, como máximo el 5 % y nunca más que el margen. Pasado el periodo de gracia el protocolo rechaza el cierre; el alquiler termina entonces cuando sus días restantes se liquidan uno a uno, algo que cualquiera puede hacer, o en impago, lo que ocurra primero. El momento posterior que muestra la revisión no es un plazo ni un límite: un cierre que se confirma más tarde se cuenta entonces, así que se puede cobrar más alquiler o un recargo mayor y volverte menos. Lo que vuelve se queda en tu propia bóveda como reclamo hasta que lo cobres.

<a id="rewards-vpfi"></a>

### Recompensas: el VPFI en la bóveda

La página lee el token con `getVPFIToken`; la dirección cero significa que el VPFI no está configurado en esa red. En un mismo bloque lee el `balanceOf` de la wallet, la bóveda con `getUserVaultAddress`, el VPFI contado con `getTrackedVPFIBalance`, el importe libre con `withdrawableNow` y el `balanceOf` de la propia bóveda. Lo retenido es lo contado menos lo libre; lo no contado es el saldo de la bóveda por encima de lo contado. «Depositar VPFI» es el `depositToVault` genérico de la bóveda, y «Retirar VPFI» su `withdrawFromVault` (`escapeWithdraw` mientras el protocolo está en pausa y la vía de escape está abierta, para una cuenta sin modo protegido), no las entradas exclusivas de VPFI: las vías genéricas registran el VPFI para el nivel igual, y solo ellas tienen la vía de escape. Cada revisión lee `getTrackedVPFIBalance` y `getVPFIDiscountConsent` en su propio bloque, y el resultado se mide a partir de la transacción. `isCanonicalVpfiChain` se lee con ellos: solo la red de origen del VPFI calcula el nivel a partir de su propio VPFI contado, y las demás aplican una copia en caché de ese nivel, así que allí la página y cada recibo dicen que un movimiento no cambia ningún nivel.

<a id="rewards-vpfi-risks"></a>

### Recompensas: riesgos de mover VPFI

El nivel no es tu saldo de hoy. Es cero hasta que tu tenencia continua actual alcance el número mínimo de días; después sigue un promedio de tus saldos de cierre diarios ponderado hacia los días recientes; y queda limitado al nivel más bajo que tuviste en algún día de tu tenencia actual, mirando atrás como mucho 30 días. Son dos miradas atrás distintas. Retirar parte de tu VPFI contado baja el saldo mínimo de ese día, que es el que lee el límite, y retirarlo todo reinicia tu tiempo de tenencia. Un aumento no lo reinicia. El VPFI retenido para un préstamo, oferta, reclamo o pago no se puede retirar hasta que se libere. El retiro de una cuenta protegida cambia tu VPFI contado y tu nivel solo cuando se libera, y uno cancelado no cambia ninguno de los dos. El VPFI en tu bóveda no es garantía. El protocolo no vende VPFI, no le pone precio y no paga nada por tenerlo.

<a id="rewards-tier"></a>

### Recompensas: el nivel de descuento en comisiones

En un mismo bloque, la tarjeta lee `getVPFIDiscountConsent`, `isCanonicalVpfiChain` y `getEffectiveDiscount`, que devuelve el nivel y el descuento que aplica el cálculo de comisiones: cero con el consentimiento desactivado, limitado al 50 % y, en otras redes, la copia enviada desde la red de origen. En el mismo bloque lee `explainTier` y `getTwaConfig`. `explainTier` devuelve, sea cual sea el consentimiento, el nivel que da solo el VPFI contado, la cifra de cada regla de tenencia y la regla que mantiene el nivel efectivo por debajo; la tarjeta nombra esa regla solo cuando la explicación resuelve el mismo nivel que aplica el cálculo de comisiones, y con el consentimiento desactivado dice qué nivel se aplicaría con él activado. Advanced muestra la cifra de cada regla y los ajustes que devuelve `getTwaConfig`, con la ventana de la media y la retrospectiva como dos duraciones distintas. La tabla lee `getVpfiTierThresholds`, `getVpfiTierDiscountBps` y `getFeesConfig` en un mismo bloque. Los niveles 1 a 3 empiezan en su umbral y el nivel 4 por encima del suyo. Cada comisión es la comisión de lista por uno menos el descuento limitado, calculada con exactitud. La tabla se muestra solo en la red de origen, donde se fijan los niveles.

<a id="rewards-vpfi-sign"></a>

### Recompensas: firmar en lugar de aprobar

En su propio bloque, la revisión lee si Permit2 tiene código en su dirección canónica y la `allowance` ERC-20 de la billetera hacia Permit2 para el token VPFI. Solo cuando Permit2 está desplegado y esa autorización cubre el importe se ofrece «Firmar en lugar de aprobar»; si no, Advanced dice cuál de las dos cosas falta. La billetera firma el `PermitTransferFrom` de Permit2 para el token VPFI y exactamente el importe, con el Diamond como gastador, un nonce aleatorio comprobado como no usado en `nonceBitmap` y un plazo de 30 minutos tras el último bloque. La aplicación simula `depositVPFIToVaultWithPermit` con la firma y luego lo envía; el protocolo rechaza un permiso para cualquier otro token. El resultado se mide a partir de `VPFIDepositedToVault`, que esa entrada emite en lugar de `VaultDeposited`, y de la transferencia del token a la bóveda. Ambas vías cuentan el VPFI para el nivel del mismo modo.

<a id="desk-markets"></a>

### Rate desk: mercados y escaleras de tipos

La lista de mercados es el resumen de mercados del índice: cada combinación distinta de activo prestado, activo de garantía y plazo entre las ofertas abiertas de ERC-20 contra ERC-20, sin caducar, sin vehículos de venta ni de compensación, de mayor a menor profundidad y con un tope, con el número y el mejor tipo de cada lado (el `interestRateBps` más bajo de los prestamistas, el `interestRateBpsMax` más alto de los prestatarios). Esas cifras incluyen órdenes firmadas activas; el desk aún no lista órdenes firmadas, y cuando la cifra de un mercado difiere de lo que lista su escalera, la escalera indica ambas. La escalera lee del índice las ofertas abiertas del mercado con `excludeExpired`, `excludeSaleVehicles` y `excludeOffsetVehicles`, hasta cuatro páginas de 50, y dice cuándo el mercado tenía más. La oferta de un prestamista se sitúa en su tipo mínimo y la solicitud de un prestatario en su tope, el mayor entre su tipo y su tipo máximo. El importe abierto de un escalón suma, por cada oferta, su importe superior menos lo ya cubierto. La app además deja fuera, y cuenta por motivo, las ofertas caducadas según su propio reloj, los vehículos que el índice aún devolvió, las ofertas ligadas a una posición de préstamo que se movió desde su apertura (#3205), las ofertas sin nada abierto y las filas con otras condiciones. El tipo medio es la media de la mejor oferta y la mejor demanda, exacta a una décima de punto básico; cuando la mejor demanda está en o por encima de la mejor oferta, la escalera dice que los lados se solapan y no hace nada al respecto. Cada oferta enlaza su propia página, que lee su estado y condiciones de la cadena.

<a id="offer-terms-wait"></a>

### Antigüedad mínima de las condiciones de una oferta

El protocolo ejecuta una oferta o solicitud solo cuando sus condiciones llevan `getMinTermsAgeSec()` segundos desde `termsSetAt` en `getOffer` (5 s por defecto, un ajuste del administrador entre 1 y 60 s; cada cambio de las condiciones lo reinicia). `previewAccept` informa `TermsTooFresh` mientras no haya pasado. La revisión lee entonces `termsSetAt`, la antigüedad mínima y la hora del bloque en un mismo bloque, e indica cuánto deben mantenerse las condiciones y cuánto faltaba en ese bloque; no muestra ningún paso de consentimiento ni de firma. La revisión lee la cadena en cada bloque, así que el rechazo se levanta solo. Si esas cifras no se pueden leer, o no faltaba nada en el bloque leído, mantiene el rechazo simple, que dice que se levanta en segundos.

<a id="desk-tape"></a>

### Rate desk: ofertas propias, lista de operaciones y gráfico de tipos ejecutados

Sus ofertas son las ofertas de la escalera cuyo creador es su wallet, cada una con `amountFilled` frente a su importe superior, tal como las registró el índice. La lista lee `/loans/recent` del índice, limitada al mercado y con `excludeSaleVehicles`, los 20 préstamos más recientes, y muestra la instantánea de apertura de cada préstamo: `initRateBps` e `initPrincipal`, nunca los valores vivos `interestRateBps` o `principal` que el reembolso parcial y `LoanExtended` reescriben. Un importe que el registro no respalda se muestra como no confirmado. Un préstamo pertenece a un mercado solo cuando el índice lo coloca allí (`marketDurationDays`, el plazo acordado respaldado por el registro); los préstamos sin colocar del par se cuentan, nunca se asignan a un plazo por suposición, y se rechaza una respuesta que no esté limitada al mercado. El gráfico lee `/loans/rate-candles` en pasos de 1 hora durante 7 días, de 4 horas durante 30 días y diarios durante 90 días y todo el período. Cada paso lleva el primer, el más alto, el más bajo y el último tipo acordado, el número de préstamos y los importes prestados sumados sobre los préstamos con importe confirmado, contando los demás. Solo se devuelven pasos con algún préstamo. La línea une solo pasos consecutivos, así que un paso vacío queda como hueco, y cuando el índice solo leyó los préstamos más recientes, el gráfico indica que sus pasos más antiguos no se dibujan. La referencia discontinua es el tipo medio derivado de la escalera; no se muestra ninguna cifra de variación.

<a id="desk-history"></a>

### Rate desk: préstamos vivos e historial

Los préstamos vivos son las filas de tu propia lectura de posiciones (las filas `LoanSummary` detrás de Posiciones, con el factor de salud de cada préstamo y el lado que tiene tu NFT de posición) cuyas dos patas son tokens ERC-20 que coinciden con los tokens y el plazo del mercado. Nunca se leen del índice, y una lectura incompleta avisa de que puede faltar un préstamo. El historial lee `/loans/by-participant` del índice con `scope=desk`: préstamos cuyo activo prestado y garantía son ambos ERC-20, sin el préstamo contable que abre la venta de un prestamista, a partir del registro solo de anexado de quién tuvo cada lado (escrito al abrir y en cada transferencia de posición, nunca borrado). Las filas llegan por participación más reciente; el lector pide 21 filas y ofrece una página anterior, desde el momento de participación y el id de la fila 20, solo si llega la 21, así que una página que termina justo en el límite no ofrece nada. Cada fila se comprueba de nuevo contra el alcance del desk y una fila rechazada se cuenta, no se descarta. El estado es el del índice (`active`, `repaid`, `defaulted`, `liquidated`, `settled`, `internal_matched`, `fallback_pending` o desconocido), y la página del préstamo lee la cadena.

<a id="desk-ticket"></a>

### Rate desk: ticket de orden

El ticket publica mediante `createOffer` en el mercado que muestra el desk: el activo prestado, el activo de garantía y `durationDays` son del mercado, y el ticket aporta el lado (`offerType`), el importe total como `amountMax`, con `amount` como el menor llenado individual en parcial o inmediato o cancelar y el importe total en todo o nada (`LibOfferMatch` mantiene cada emparejamiento entre `amount` y lo que queda, así que un solo tamaño siempre se llena entero), `collateralAmount`, un tipo (`interestRateBpsMax` igual a `interestRateBps`), el vencimiento y `fillMode` (parcial, todo o nada o inmediato o cancelar; inmediato o cancelar necesita un vencimiento finito). El resto son los valores por defecto de los flujos guiados, indicados en el ticket: `useFullTermInterest` true, `allowsPartialRepay` false, `periodicInterestCadence` 0, sin rango de garantía (`collateralFloor` igual a la garantía), sin tarifa de comisiones y sin protección de precio. `expiresAt` se fija con la marca de tiempo del último bloque al abrir la revisión, o 0 para una oferta que no vence. Los importes se leen con los decimales del token y nunca se redondean; más decimales de los que tiene el token detienen el ticket. El primer impedimento se informa en un orden fijo: wallet, red, mercado, las lecturas (`readPostFormInputs`, los decimales de ambos tokens y los Términos vigentes), el plazo frente a `maxDurationDays`, luego importe, garantía, tipo (como máximo 100% anual) y modo de llenado. Las comisiones usan la comisión de apertura y la parte del tesoro de lista; un descuento solo puede bajarlas. La revisión es la propia de publicación de los flujos guiados, con la aceptación de los Términos primero.
