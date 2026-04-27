# Vaipakam — Guía del usuario (Modo básico)

Explicaciones cercanas y en lenguaje sencillo de cada tarjeta de la
aplicación. Cada sección corresponde a un icono de información `(i)`
junto al título de una tarjeta. En modo **Básico**, el enlace
"Aprender más →" de cada tooltip lleva aquí. El modo Avanzado apunta
en cambio a la guía técnica.

Los títulos de abajo coinciden con los títulos de las tarjetas dentro
de la app. El ancla HTML oculta debajo de cada uno coincide con el id
de la tarjeta, de modo que la app puede enlazar directamente al
párrafo exacto.

Una nota sobre el lenguaje: las listas del **Libro de ofertas** y el
flujo de **Crear oferta** describen situaciones donde el prestamista
y el prestatario hacen cosas distintas en la misma pantalla, por lo
que esas secciones nombran el rol de forma explícita para evitar
confusiones. Las demás secciones se dirigen directamente a quien lee.

---

## Dashboard

<a id="dashboard.your-escrow"></a>

### Tu Escrow

Piensa en tu **escrow** como tu bóveda privada dentro de Vaipakam. Es
un pequeño contrato que sólo tú controlas. Siempre que participes en
un préstamo —ya sea aportando colateral o prestando un activo— los
activos pasan de tu billetera a esta bóveda. Nunca se mezclan con el
dinero de nadie más. Cuando el préstamo termina, los reclamas de
vuelta directamente.

No tienes que "crear" un escrow tú mismo; la app lo crea la primera
vez que lo necesites. Una vez que existe, queda como tu hogar
dedicado en esta cadena.

<a id="dashboard.your-loans"></a>

### Tus préstamos

Cada préstamo en el que participas en esta cadena aparece aquí —ya
seas el prestamista (quien aporta el activo a prestar) o el
prestatario (quien lo recibió). Cada fila es una posición. Si haces
clic obtienes la imagen completa: qué tan saludable está el préstamo,
qué hay bloqueado como colateral, cuánto interés se ha acumulado, y
los botones para repagar, reclamar o liquidar cuando llegue el
momento.

Si un préstamo abarca dos roles (prestaste en uno, pediste prestado
en otro), ambos aparecen —mismo lugar, filas distintas.

<a id="dashboard.vpfi-panel"></a>

### VPFI en esta cadena

**VPFI** es el token propio del protocolo. Tener algo en tu escrow te
da un descuento sobre las comisiones del protocolo y te genera un
pequeño rendimiento pasivo (5% APR). Esta tarjeta te dice, en la
cadena a la que estás conectado:

- Cuánto VPFI tienes en tu billetera ahora mismo.
- Cuánto está en tu escrow (lo que cuenta como "stakeado").
- Qué proporción del suministro total de VPFI tienes.
- Cuánto VPFI queda por mintear en total (el protocolo tiene un
  tope rígido).

Vaipakam corre en varias cadenas. Una de ellas (Base) es la cadena
**canónica** donde se mintea el nuevo VPFI; las demás son
**espejos** que mantienen copias sincronizadas vía un puente
cross-chain. Desde tu punto de vista no tienes que pensar en eso —el
saldo que ves es real en cualquier cadena en la que estés.

<a id="dashboard.fee-discount-consent"></a>

### Consentimiento de descuento en comisiones

Vaipakam puede pagarte un descuento sobre las comisiones del
protocolo usando parte del VPFI que tienes guardado en escrow. Este
interruptor es el "sí, hazlo". Sólo lo activas una vez.

Cuán grande es el descuento depende de cuánto VPFI mantienes en
escrow:

- **Tier 1** — 100 VPFI o más → 10% de descuento
- **Tier 2** — 1,000 VPFI o más → 15% de descuento
- **Tier 3** — 5,000 VPFI o más → 20% de descuento
- **Tier 4** — más de 20,000 VPFI → 24% de descuento

Puedes apagar el interruptor en cualquier momento. Si retiras VPFI
del escrow, tu tier baja en tiempo real.

---

## Libro de ofertas

<a id="offer-book.filters"></a>

### Filtros

Las listas de mercado pueden ser largas. Los filtros las acotan por
qué activo está en el préstamo, si es una oferta de prestamista o de
prestatario, y algunos otros parámetros. Tus propias ofertas activas
siempre permanecen visibles en la parte superior de la página —los
filtros sólo afectan lo que otras personas te muestran.

<a id="offer-book.your-active-offers"></a>

### Tus ofertas activas

Ofertas que **tú** publicaste y que nadie ha aceptado todavía.
Mientras una oferta está aquí puedes cancelarla sin coste. Una vez
que alguien acepta, la posición se convierte en un préstamo real y
pasa a "Tus préstamos" en el Dashboard.

<a id="offer-book.lender-offers"></a>

### Ofertas de prestamistas

Publicaciones de personas que ofrecen prestar. Cada una dice:
"Prestaré X unidades del activo Y al Z% de interés durante D días, a
cambio de esta cantidad de colateral".

Un prestatario que acepta una de estas se convierte en el
prestatario-de-registro del préstamo: el colateral del prestatario
queda bloqueado en escrow, el activo principal llega a la billetera
del prestatario, y los intereses se acumulan hasta que el prestatario
repaga.

El protocolo impone una regla de seguridad por el lado del
prestatario en el momento de aceptar: el colateral debe valer al
menos 1.5× el préstamo. (Ese número se llama **Health Factor 1.5**.)
Si el colateral del prestatario no alcanza, el préstamo no se inicia.

<a id="offer-book.borrower-offers"></a>

### Ofertas de prestatarios

Publicaciones de prestatarios que ya bloquearon su colateral y están
esperando a alguien que financie el préstamo.

Un prestamista que acepta una de estas financia el préstamo: el
activo del prestamista va al prestatario, el prestamista se convierte
en el prestamista-de-registro, y gana intereses a la tasa de la
oferta durante toda la duración. Una pequeña porción (1%) de los
intereses va a la tesorería del protocolo en el momento de la
liquidación.

---

## Crear oferta

<a id="create-offer.offer-type"></a>

### Tipo de oferta

Elige un lado:

- **Prestamista** — el prestamista aporta un activo y gana intereses
  mientras el préstamo está vigente.
- **Prestatario** — el prestatario bloquea colateral y solicita otro
  activo a cambio.

Existe una sub-opción de **Alquiler** para NFTs "alquilables" (una
clase especial de NFT que puede ser delegada temporalmente). Los
alquileres no prestan dinero —el NFT mismo se alquila por una tarifa
diaria.

<a id="create-offer.lending-asset"></a>

### Activo prestado

El activo y la cantidad en juego, además de la tasa de interés (APR
en %) y la duración en días. La tasa se fija cuando se publica la
oferta; nadie puede cambiarla después. Tras finalizar la duración se
aplica una breve ventana de gracia —si el prestatario no ha repagado
para entonces, el préstamo puede entrar en default y se activa la
reclamación de colateral del prestamista.

<a id="create-offer.lending-asset:lender"></a>

#### Si eres el prestamista

El activo principal y el monto que estás dispuesto a ofrecer, además
de la tasa de interés (APR en %) y la duración en días. La tasa se
fija al momento de la oferta; la duración determina la ventana de
gracia antes de que el préstamo pueda entrar en default.

<a id="create-offer.lending-asset:borrower"></a>

#### Si eres el prestatario

El activo principal y el monto que quieres recibir del prestamista,
además de la tasa de interés (APR en %) y la duración en días. La
tasa se fija al momento de la oferta; la duración determina la
ventana de gracia antes de que el préstamo pueda entrar en default.

<a id="create-offer.nft-details"></a>

### Detalles del NFT

Para una oferta de alquiler, esta tarjeta fija la tarifa diaria de
alquiler. El arrendatario paga el coste total del alquiler por
adelantado al aceptar, más un pequeño buffer del 5% por si la
operación se alarga un poco. El NFT mismo permanece en escrow durante
todo el tiempo —el arrendatario tiene derecho a usarlo pero no puede
moverlo.

<a id="create-offer.collateral"></a>

### Colateral

Lo que se bloquea para asegurar el préstamo. Dos variantes:

- **Líquido** — un token reconocido con un feed de precio en vivo
  (Chainlink + un pool on-chain con suficiente profundidad). El
  protocolo puede valorarlo en tiempo real y liquidar la posición
  automáticamente si el precio se mueve en contra del préstamo.
- **Ilíquido** — NFTs, o tokens sin feed de precio. El protocolo no
  puede valorarlos, así que en default el prestamista simplemente se
  queda con todo el colateral. Tanto el prestamista como el
  prestatario deben marcar una casilla aceptando esto antes de que
  pueda hacerse la oferta.

<a id="create-offer.collateral:lender"></a>

#### Si eres el prestamista

Cuánto quieres que el prestatario bloquee para asegurar el préstamo.
Los ERC-20 líquidos (feed de Chainlink + ≥$1M de profundidad en pool
v3) entran en la matemática de LTV/HF; los ERC-20 ilíquidos y los
NFTs no tienen valoración on-chain y requieren que ambas partes
consientan a un escenario de colateral-completo-en-default.

<a id="create-offer.collateral:borrower"></a>

#### Si eres el prestatario

Cuánto estás dispuesto a bloquear para asegurar el préstamo. Los
ERC-20 líquidos (feed de Chainlink + ≥$1M de profundidad en pool v3)
entran en la matemática de LTV/HF; los ERC-20 ilíquidos y los NFTs no
tienen valoración on-chain y requieren que ambas partes consientan a
un escenario de colateral-completo-en-default.

<a id="create-offer.risk-disclosures"></a>

### Divulgaciones de riesgo

Prestar y pedir prestado en Vaipakam conlleva riesgo real. Antes de
firmar una oferta, esta tarjeta pide un reconocimiento explícito de
la parte que firma. Los riesgos a continuación aplican a ambos lados;
las pestañas específicas por rol resaltan en qué dirección suele
golpear cada uno.

Vaipakam es no-custodial. No hay servicio de soporte que pueda
revertir una transacción ya enviada. Léelos con atención antes de
firmar.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si eres el prestamista

- **Riesgo de smart contract** — los contratos son código inmutable;
  un bug desconocido podría afectar fondos.
- **Riesgo de oráculo** — un feed de precio obsoleto o manipulado
  puede demorar la liquidación más allá del punto donde el colateral
  cubre tu principal. Podrías no recuperar todo.
- **Slippage de liquidación** — incluso cuando la liquidación se
  dispara a tiempo, el swap en DEX puede ejecutarse a un precio peor
  que la cotización, mermando lo que efectivamente recuperas.
- **Colateral ilíquido** — en default el colateral se transfiere
  íntegro a ti, pero si vale menos que el préstamo no tienes
  reclamación adicional. Aceptaste este trade-off al crear la oferta.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si eres el prestatario

- **Riesgo de smart contract** — los contratos son código inmutable;
  un bug desconocido podría afectar tu colateral bloqueado.
- **Riesgo de oráculo** — un feed de precio obsoleto o manipulado
  puede disparar una liquidación contra ti en el momento equivocado,
  incluso cuando el precio real de mercado se hubiera mantenido
  seguro.
- **Slippage de liquidación** — cuando la liquidación se dispara, el
  swap en DEX puede vender tu colateral a un precio peor del
  esperado.
- **Colateral ilíquido** — en default todo tu colateral se transfiere
  al prestamista, sin reclamación residual a tu favor. Aceptaste este
  trade-off al crear la oferta.

<a id="create-offer.advanced-options"></a>

### Opciones avanzadas

Ajustes adicionales para quienes los quieran —la mayoría los deja en
los valores por defecto. Cosas como cuánto tiempo permanece abierta
una oferta antes de expirar, si usar VPFI para el descuento de
comisiones en esta oferta específica, y un par de toggles
específicos por rol. Es seguro saltarse esto en una primera oferta.

---

## Centro de reclamaciones

<a id="claim-center.claims"></a>

### Fondos reclamables

Después de que un préstamo termina —repagado, en default o
liquidado— tu parte del resultado no se mueve a tu billetera
automáticamente. Tienes que hacer clic en **Reclamar** para
recuperarla. Esta página es la lista de cada reclamación pendiente
que tienes en esta cadena.

Un usuario puede tener tanto reclamaciones de prestamista (de
préstamos que financió) como de prestatario (de préstamos que tomó)
al mismo tiempo —ambas aparecen en la misma lista. Las dos pestañas
específicas por rol describen lo que cada tipo de reclamación
devuelve.

<a id="claim-center.claims:lender"></a>

#### Si eres el prestamista

Tu reclamación de prestamista devuelve el principal del préstamo más
los intereses acumulados, menos un 1% de tesorería sobre la porción
de intereses. Pasa a ser reclamable apenas el préstamo se liquida —
repagado, en default o liquidado. La reclamación consume tu NFT de
posición de prestamista de forma atómica —una vez que se ejecuta,
ese lado del préstamo queda completamente cerrado.

<a id="claim-center.claims:borrower"></a>

#### Si eres el prestatario

Si repagaste el préstamo en su totalidad, tu reclamación de
prestatario devuelve el colateral que bloqueaste al inicio. En
default o liquidación, sólo se devuelve el reembolso de VPFI no
usado de la Loan Initiation Fee —el colateral mismo ya se fue al
prestamista. La reclamación consume tu NFT de posición de
prestatario de forma atómica.

---

## Actividad

<a id="activity.feed"></a>

### Feed de actividad

Cada evento on-chain que involucra a tu billetera en la cadena a la
que estás conectado —cada oferta que publicaste o aceptaste, cada
préstamo, cada repago, cada reclamación, cada liquidación. Todo se
lee en vivo desde la cadena misma; no hay servidor central que pueda
caerse. Los más nuevos primero, agrupados por transacción para que
las cosas que hiciste en un mismo clic se mantengan juntas.

---

## Comprar VPFI

<a id="buy-vpfi.overview"></a>

### Comprando VPFI

La página de compra te permite intercambiar ETH por VPFI a la tasa
fija de etapa temprana del protocolo. Puedes hacerlo desde cualquier
cadena soportada —enrutamos la operación por debajo. El VPFI siempre
llega a tu billetera en la misma cadena a la que estás conectado.
Sin necesidad de cambiar de red.

<a id="buy-vpfi.discount-status"></a>

### Tu estado de descuento VPFI

Lectura rápida del tier de descuento en el que estás actualmente. El
tier viene de cuánto VPFI hay en tu **escrow** (no en tu billetera).
La tarjeta también te dice (a) cuánto VPFI más necesitarías en
escrow para subir al siguiente tier, y (b) si el interruptor de
consentimiento del Dashboard está activado —el descuento sólo aplica
mientras lo esté.

El mismo VPFI en tu escrow también está "stakeado" automáticamente y
te genera un 5% APR.

<a id="buy-vpfi.buy"></a>

### Paso 1 — Compra VPFI con ETH

Escribe cuánto ETH quieres gastar, presiona Comprar, firma la
transacción. Eso es todo. Hay un tope por compra y un tope rolling
de 24 horas para evitar abusos —verás los números en vivo junto al
formulario para saber cuánto te queda.

<a id="buy-vpfi.deposit"></a>

### Paso 2 — Deposita VPFI en tu escrow

Comprar VPFI lo coloca en tu billetera, no en tu escrow. Para
obtener el descuento de comisiones y el rendimiento por staking del
5%, tienes que moverlo al escrow tú mismo. Esto siempre es un clic
explícito —la app nunca mueve tu VPFI sin que se lo pidas. Una
transacción (o una sola firma, en cadenas que lo soporten) y listo.

<a id="buy-vpfi.unstake"></a>

### Paso 3 — Saca VPFI del staking en tu escrow

¿Quieres recuperar algo de VPFI en tu billetera? Esta tarjeta lo
envía desde el escrow de vuelta a ti. Ten en cuenta: sacar VPFI baja
tu tier de descuento **inmediatamente**. Si tienes préstamos
abiertos, la matemática del descuento pasa al tier inferior desde
ese momento en adelante.

---

## Recompensas

<a id="rewards.overview"></a>

### Sobre las recompensas

Vaipakam te paga por dos cosas:

1. **Staking** — el VPFI que mantienes en escrow gana 5% APR,
   automáticamente.
2. **Interacción** — cada dólar de intereses que un préstamo del que
   formas parte llegue a liquidar te otorga una porción diaria de un
   pool de recompensas comunitario.

Ambas se pagan en VPFI, minteado directamente en la cadena en la que
estés. Sin puentes, sin cambios de cadena.

<a id="rewards.claim"></a>

### Reclamar recompensas

Un sólo botón reclama todo de ambos flujos de recompensas en una
única transacción. Las recompensas de staking siempre son
reclamables en tiempo real. La porción del pool de interacción se
liquida una vez al día, así que si has ganado algo desde la última
liquidación, la parte de interacción del total sólo entra en vigor
poco después de que cierre la próxima ventana diaria.

<a id="rewards.withdraw-staked"></a>

### Retirar VPFI stakeado

Mueve VPFI de tu escrow de vuelta a tu billetera. Una vez en la
billetera deja de ganar el 5% APR y deja de contar para tu tier de
descuento. Lo mismo que el paso "unstake" en la página Comprar VPFI
—misma acción, sólo que también vive aquí por comodidad.

---

## Detalles del préstamo

<a id="loan-details.overview"></a>

### Detalles del préstamo (esta página)

Todo sobre un préstamo individual, en una página. Los términos bajo
los que se abrió, qué tan saludable está ahora, quién está en cada
lado, y cada botón que puedes presionar según el rol que estés
desempeñando —repagar, reclamar, liquidar, cerrar anticipadamente,
refinanciar.

<a id="loan-details.terms"></a>

### Términos del préstamo

Las partes fijas del préstamo: qué activo se prestó, cuánto, la tasa
de interés, la duración y cuánto interés se ha acumulado hasta
ahora. Nada de esto cambia una vez que el préstamo está abierto. (Si
hacen falta términos distintos, refinancia —la app crea un préstamo
nuevo y paga éste en la misma transacción.)

<a id="loan-details.collateral-risk"></a>

### Colateral y riesgo

El colateral en este préstamo, además de los números de riesgo en
vivo —Health Factor y LTV. **Health Factor** es una única puntuación
de seguridad: por encima de 1 significa que el colateral cubre
cómodamente el préstamo; cerca de 1 significa que es arriesgado y el
préstamo podría liquidarse. **LTV** es "cuánto se pidió prestado vs.
el valor de lo que se aportó". Los umbrales en los que la posición
se vuelve insegura están en la misma tarjeta.

Si el colateral es ilíquido (un NFT o un token sin feed de precio en
vivo), estos números no pueden calcularse. Ambas partes aceptaron
ese resultado al crear la oferta.

<a id="loan-details.collateral-risk:lender"></a>

#### Si eres el prestamista

Este es el colateral del prestatario —tu protección. Mientras HF se
mantenga por encima de 1, estás bien cubierto. Cuando HF baja, tu
protección se adelgaza; si cruza 1, cualquiera (tú incluido) puede
disparar la liquidación, y el swap en DEX convierte el colateral a
tu activo principal para repagarte. Sobre colateral ilíquido, el
default transfiere el colateral entero a ti —te quedas con lo que
valga.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si eres el prestatario

Este es tu colateral bloqueado. Mantén HF cómodamente por encima de
1 —cuando se acerca, estás en riesgo de liquidación. Normalmente
puedes subir HF de nuevo añadiendo más colateral o repagando parte
del préstamo. Si HF cruza 1, cualquiera puede disparar la
liquidación, y el swap en DEX venderá tu colateral a precios
mermados por slippage para repagar al prestamista. Sobre colateral
ilíquido, el default transfiere todo tu colateral al prestamista sin
reclamación residual a tu favor.

<a id="loan-details.parties"></a>

### Partes

Las dos direcciones de billetera en este préstamo —prestamista y
prestatario— y los vaults de escrow que guardan sus activos. Cada
lado también obtuvo un "NFT de posición" cuando se abrió el
préstamo. Ese NFT _es_ el derecho a la parte del resultado de ese
lado —cuídalo. Si quien lo tiene lo transfiere a otra persona, el
nuevo poseedor es quien podrá reclamar.

<a id="loan-details.actions"></a>

### Acciones

Cada botón disponible en este préstamo. El conjunto que ves depende
de tu rol en este préstamo específico —las pestañas por rol
listadas abajo enumeran las opciones de cada lado. Los botones que
no estén disponibles ahora estarán en gris, con un pequeño tooltip
explicando por qué.

<a id="loan-details.actions:lender"></a>

#### Si eres el prestamista

- **Reclamar** — una vez que el préstamo se liquida (repagado, en
  default o liquidado), desbloquea el principal de vuelta más los
  intereses, menos el 1% de tesorería sobre el interés. Consume tu
  NFT de prestamista.
- **Iniciar retiro anticipado** — pon a la venta tu NFT de
  prestamista a otro comprador a mitad del préstamo. El comprador se
  hace cargo de tu lado; tú te vas con lo que pagó.
- **Liquidar** — cualquiera (tú incluido) puede disparar esto cuando
  HF cae por debajo de 1 o el periodo de gracia expira.

<a id="loan-details.actions:borrower"></a>

#### Si eres el prestatario

- **Repagar** — total o parcial. El repago parcial reduce tu saldo
  pendiente y mejora HF; el repago total cierra el préstamo y
  desbloquea tu colateral vía Reclamar.
- **Cerrar anticipadamente** — cierra el préstamo antes de tiempo.
  Camino directo: paga todo el saldo pendiente desde tu billetera
  ahora. Camino con offset: vende parte del colateral en un DEX,
  usa lo recibido para repagar, y recupera lo que quede.
- **Refinanciar** — pasa a un préstamo nuevo con términos nuevos; el
  protocolo paga el préstamo viejo desde el principal nuevo en una
  sola transacción. El colateral nunca sale del escrow.
- **Reclamar** — una vez que el préstamo se liquida, devuelve tu
  colateral en caso de repago total, o cualquier reembolso de VPFI
  no usado de la loan-initiation fee en caso de default.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Cuando aceptas una oferta, tu billetera a veces "aprueba" a Vaipakam
para mover un token específico en tu nombre. Algunas billeteras
tienen la costumbre de mantener estas aprobaciones abiertas más
tiempo del necesario. Esta página lista cada aprobación que le has
dado a Vaipakam en esta cadena y te deja desactivar cualquiera con
un clic. Las aprobaciones no-cero (las que están realmente vigentes)
aparecen primero.

Una lista de aprobaciones limpia es un hábito de higiene —igual que
en Uniswap o 1inch.

---

## Alertas

<a id="alerts.overview"></a>

### Sobre las alertas

Cuando el precio de tu colateral cae, la puntuación de seguridad de
tu préstamo (su Health Factor) cae con él. Las alertas te permiten
optar a un aviso **antes** de que cualquiera pueda liquidarte. Un
pequeño servicio off-chain vigila tus préstamos cada cinco minutos y
te envía un ping en el momento en que la puntuación cruza una banda
de peligro. No hay coste de gas; nada ocurre on-chain.

<a id="alerts.threshold-ladder"></a>

### Escalera de umbrales

Las bandas de peligro que usa el watcher. Cruzar a una banda más
peligrosa dispara una sola alerta. El siguiente ping sólo ocurre si
cruzas otra banda más profunda. Si vuelves a subir a una banda más
segura, la escalera se resetea. Los valores por defecto están
calibrados para préstamos típicos; si tienes colateral muy volátil
quizá quieras configurar umbrales más altos.

<a id="alerts.delivery-channels"></a>

### Canales de envío

A dónde van realmente los pings. Puedes elegir Telegram (un bot te
manda DM), o Push Protocol (notificaciones directas a tu billetera),
o ambos. Los dos canales comparten la misma escalera de umbrales —
no se ajustan por separado.

---

## Verificador de NFTs

<a id="nft-verifier.lookup"></a>

### Verificar un NFT

A veces los NFTs de posición de Vaipakam aparecen en mercados
secundarios. Antes de comprar uno a otro poseedor, pega aquí la
dirección del contrato del NFT y el token ID. El verificador
confirma (a) que efectivamente fue minteado por Vaipakam, (b) en qué
cadena vive el préstamo subyacente, (c) en qué estado está ese
préstamo, y (d) quién tiene actualmente el NFT on-chain.

El NFT de posición _es_ el derecho a reclamar del préstamo. Detectar
una falsificación —o una posición que ya se liquidó— te ahorra el
mal trato.

---

## Configuración de keepers

<a id="keeper-settings.overview"></a>

### Sobre los keepers

Un "keeper" es una billetera en la que confías para realizar
acciones específicas de mantenimiento sobre tus préstamos —completar
un retiro anticipado, finalizar un refinance, cosas así. Los keepers
nunca pueden gastar tu dinero —repagar, añadir colateral, reclamar y
liquidar siguen siendo sólo del usuario. Puedes aprobar hasta 5
keepers, y puedes apagar el interruptor maestro en cualquier momento
para deshabilitarlos a todos a la vez.

<a id="keeper-settings.approved-list"></a>

### Keepers aprobados

Cada keeper de la lista puede hacer **sólo las acciones que hayas
marcado** para él. Así que un keeper con sólo "completar retiro
anticipado" permitido no puede iniciar uno en tu nombre —sólo puede
terminar uno que tú empezaste. Si cambias de opinión, edita las
marcas; si quieres que un keeper desaparezca por completo,
elimínalo de la lista.

---

## Dashboard de analítica pública

<a id="public-dashboard.overview"></a>

### Sobre la analítica pública

Una vista del protocolo entero, transparente y sin necesidad de
billetera: total value locked, volúmenes de préstamos, tasas de
default, suministro de VPFI, actividad reciente. Todo se calcula en
vivo a partir de datos on-chain —no hay base de datos privada
detrás de ningún número de esta página.

<a id="public-dashboard.combined"></a>

### Combinado — Todas las cadenas

Los totales del protocolo, sumados a través de todas las cadenas
soportadas. La pequeña línea "X cadenas cubiertas, Y inalcanzables"
te dice si la red de alguna cadena estaba caída en el momento en
que se cargó la página —si es así, esa cadena específica se marca
en la tabla por-cadena de abajo.

<a id="public-dashboard.per-chain"></a>

### Desglose por cadena

Los mismos totales, separados por cadena. Útil para ver qué cadena
tiene el mayor TVL, dónde están ocurriendo más préstamos, o para
detectar cuándo una cadena se ha estancado.

<a id="public-dashboard.vpfi-transparency"></a>

### Transparencia del token VPFI

El estado en vivo de VPFI en esta cadena —cuánto existe en total,
cuánto está realmente circulando (después de restar los saldos en
poder del protocolo), y cuánto sigue siendo minteable bajo el tope.
Entre todas las cadenas, el suministro se mantiene acotado por
diseño.

<a id="public-dashboard.transparency"></a>

### Transparencia y fuente

Cada número de esta página puede re-derivarse directamente desde la
blockchain. Esta tarjeta lista el bloque del snapshot, qué tan
reciente fue obtenida la data, y la dirección del contrato de la
que vino cada métrica. Si alguien quiere verificar un número, aquí
es donde empieza.

---

## Refinanciar

Esta página es sólo para prestatarios —el refinance lo inicia el
prestatario sobre el préstamo del prestatario.

<a id="refinance.overview"></a>

### Sobre refinanciar

Refinanciar pasa tu préstamo existente a uno nuevo sin tocar tu
colateral. Publicas una nueva oferta del lado prestatario con los
nuevos términos; una vez que un prestamista acepta, el protocolo
paga el préstamo viejo y abre el nuevo en una única transacción.
No hay momento alguno en el que tu colateral quede desprotegido.

<a id="refinance.position-summary"></a>

### Tu posición actual

Una instantánea del préstamo que estás refinanciando —qué hay
pendiente, cuánto interés se ha acumulado, qué tan saludable está,
qué hay bloqueado. Usa estos números para dimensionar la nueva
oferta de manera sensata.

<a id="refinance.step-1-post-offer"></a>

### Paso 1 — Publica la nueva oferta

Publicas una oferta de prestatario con el activo, monto, tasa y
duración que quieres para el refinance. Mientras está listada, el
préstamo viejo sigue corriendo normalmente —los intereses siguen
acumulándose, tu colateral sigue en su lugar. Otros usuarios ven
esta oferta en el Libro de ofertas.

<a id="refinance.step-2-complete"></a>

### Paso 2 — Completar

Una vez que un prestamista acepta tu oferta de refinance, haz clic
en Completar. El protocolo entonces, atómicamente: paga el préstamo
viejo desde el principal nuevo, abre el nuevo préstamo, y mantiene
tu colateral bloqueado todo el tiempo. Una transacción, cambio de
dos estados, sin ventana de exposición.

---

## Cierre anticipado

Esta página es sólo para prestatarios —el preclose lo inicia el
prestatario sobre el préstamo del prestatario.

<a id="preclose.overview"></a>

### Sobre el preclose

Preclose es "cerrar mi préstamo antes de tiempo". Tienes dos
caminos:

- **Directo** — paga todo el saldo pendiente desde tu billetera
  ahora.
- **Offset** — vende parte de tu colateral en un DEX y usa lo
  recibido para pagar el préstamo. Recuperas lo que quede.

Directo es más barato si tienes el efectivo. Offset es la respuesta
cuando no lo tienes, pero tampoco quieres que el préstamo siga
corriendo.

<a id="preclose.position-summary"></a>

### Tu posición actual

Una instantánea del préstamo que estás cerrando antes de tiempo —
saldo pendiente, intereses acumulados, salud actual. Cerrar antes
es justo en términos de comisiones —no hay penalización fija; la
matemática de VPFI ponderada por tiempo del protocolo se encarga de
la contabilidad.

<a id="preclose.in-progress"></a>

### Offset en progreso

Iniciaste un offset preclose hace un momento y el paso del swap está
en vuelo. Puedes o bien completarlo (lo recibido liquida el préstamo
y cualquier remanente vuelve a ti), o —si el precio se movió
mientras pensabas— cancelarlo y reintentar con una cotización
fresca.

<a id="preclose.choose-path"></a>

### Elige un camino

Elige **Directo** si tienes el efectivo para pagar el préstamo
ahora. Elige **Offset** si prefieres vender parte del colateral al
salir. Cualquiera de los dos caminos cierra el préstamo en su
totalidad; no puedes cerrar a medias con preclose.

---

## Retiro anticipado (prestamista)

Esta página es sólo para prestamistas —el retiro anticipado lo
inicia el prestamista sobre su préstamo.

<a id="early-withdrawal.overview"></a>

### Sobre la salida anticipada del prestamista

Si quieres salir de un préstamo antes de que termine la duración,
puedes poner tu NFT de prestamista a la venta a través del
protocolo. El comprador te paga por él; a cambio, se hace cargo de
tu lado del préstamo —cobra el repago + intereses eventualmente. Tú
te vas con tu dinero más cualquier prima que el comprador haya
pagado.

<a id="early-withdrawal.position-summary"></a>

### Tu posición actual

Una instantánea del préstamo del que estás saliendo —principal,
interés acumulado hasta ahora, tiempo restante, y la puntuación de
salud actual del prestatario. Estos son los números que un comprador
mirará al decidir cuánto vale tu NFT.

<a id="early-withdrawal.initiate-sale"></a>

### Iniciar la venta

Fijas el precio de venta, el protocolo lista tu NFT de prestamista,
y esperas a un comprador. Apenas un comprador acepta, lo pagado
llega a tu billetera y el préstamo continúa —pero ya no estás en el
gancho por él. Mientras la publicación esté abierta y sin llenarse
puedes cancelarla.
