# Vaipakam — Guía del usuario (Modo básico)

Explicaciones cercanas y en lenguaje sencillo de cada tarjeta de la
aplicación. Cada sección corresponde a un icono de información `(i)`
junto al título de una tarjeta.

> **Estás leyendo la versión Básica.** Corresponde al modo **Básico**
> de la app (la vista más sencilla, con menos controles y valores
> predeterminados más seguros). Para un recorrido más técnico y
> detallado, cambia la app al modo **Avanzado** — abre Configuración
> (icono del engranaje en la esquina superior derecha) → **Modo** →
> **Avanzado**. Los enlaces "Aprender más" (i) dentro de la app
> abrirán entonces la guía Avanzada.

---

<a id="chapter.dashboard"></a>

## Dashboard

<a id="dashboard.your-vault"></a>

### Tu Vault

Piensa en tu **vault** como tu bóveda privada dentro de Vaipakam. Es
un pequeño contrato que sólo tú controlas. Siempre que participes en
un préstamo —ya sea aportando colateral o prestando un activo— los
activos pasan de tu billetera a esta bóveda. Nunca se mezclan con el
dinero de nadie más. Cuando el préstamo termina, los reclamas de
vuelta directamente.

No tienes que "crear" un vault tú mismo; la app lo crea la primera
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

**VPFI** es el token propio del protocolo. Tener algo en tu vault te
da un descuento sobre las comisiones del protocolo. Esta tarjeta te
dice, en la cadena a la que estás conectado:

- Cuánto VPFI tienes en tu billetera ahora mismo.
- Cuánto está en tu vault (lo que cuenta para tu tier de descuento).
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

Vaipakam puede darte un descuento sobre las comisiones del
protocolo según el VPFI que mantienes en vault. Para un prestatario
el descuento es simplemente una Loan Initiation Fee más baja,
cobrada en el propio activo del préstamo cuando este empieza — no se
gasta VPFI en ello. Este interruptor es el "sí, hazlo". Sólo lo
activas una vez.

Cuán grande es el descuento depende de cuánto VPFI mantienes en
vault:

- **Tier 1** — `{liveValue:tier1Min}` VPFI o más → `{liveValue:tier1DiscountBps}`% de descuento
- **Tier 2** — `{liveValue:tier2Min}` VPFI o más → `{liveValue:tier2DiscountBps}`% de descuento
- **Tier 3** — `{liveValue:tier3Min}` VPFI o más → `{liveValue:tier3DiscountBps}`% de descuento
- **Tier 4** — más de `{liveValue:tier4Min}` VPFI → `{liveValue:tier4DiscountBps}`% de descuento

Puedes apagar el interruptor en cualquier momento. Si retiras VPFI
del vault, tu tier baja en tiempo real.

> **Nota sobre el gas de la red blockchain.** El descuento anterior
> se aplica a las **comisiones del protocolo** de Vaipakam (Comisión
> sobre Rendimiento, Comisión de Iniciación del Préstamo). La pequeña
> **comisión de gas** que requiere cada acción on-chain — pagada a
> los validadores de la blockchain al crear una oferta, aceptar,
> repagar, reclamar, etc. — es un cargo separado que va a la red, no
> a Vaipakam. El protocolo no puede descontarla porque nunca la
> recibe.

<a id="dashboard.rewards-summary"></a>

### Tus recompensas VPFI

Esta tarjeta reúne en un solo lugar cada recompensa VPFI que
has ganado del protocolo. El número grande en la parte superior
es el total combinado — lo que ya has reclamado más lo que
está esperando ser reclamado.

Las recompensas provienen de la **interacción con la
plataforma** — ganas un poco cada día por cada préstamo en el
que participes, en cualquier lado. Pagado en VPFI en la cadena
en la que estás, sin puente.

La fila tiene una pequeña flecha de chevron a la derecha. Haz
clic en ella para saltar directamente a la tarjeta de
reclamación completa en el Claim Center.

Si aún no has ganado nada, la tarjeta se renderiza igualmente
con *Total ganado: 0 VPFI* más una pista sobre cómo empezar.
No has hecho nada mal — simplemente no hay historial que
mostrar.


---

<a id="chapter.offer-book"></a>

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
queda bloqueado en vault, el activo principal llega a la billetera
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
oferta durante toda la duración. Una pequeña porción (`{liveValue:treasuryFeeBps}`%) de los
intereses va a la tesorería del protocolo en el momento de la
liquidación.
Esa tasa queda fijada al crear el préstamo, así que un cambio posterior
de la comisión del protocolo deja un préstamo ya abierto con la tasa con
la que empezó.

---

<a id="chapter.create-offer"></a>

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
operación se alarga un poco. El NFT mismo permanece en vault durante
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

<a id="chapter.claim-center"></a>

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
los intereses acumulados, menos el recorte de tesorería sobre la
porción de intereses. Ese recorte es el porcentaje fijado al crear tu
préstamo — un cambio posterior de la comisión del protocolo no lo
modifica. Los préstamos creados a la tasa actual llevan un recorte de
`{liveValue:treasuryFeeBps}`%. Pasa a ser reclamable apenas el préstamo se liquida —
repagado, en default o liquidado. La reclamación consume tu NFT de
posición de prestamista de forma atómica —una vez que se ejecuta,
ese lado del préstamo queda completamente cerrado.

<a id="claim-center.claims:borrower"></a>

#### Si eres el prestatario

Si repagaste el préstamo en su totalidad, tu reclamación de
prestatario devuelve el colateral que bloqueaste al inicio. En
default o liquidación, compruébalo igualmente. Sólo se toma el
valor que exigen la deuda y los costes de cerrarla, y todo lo que
exceda queda registrado como tuyo. Su forma depende de cómo
terminó el préstamo: si el colateral se vendió por un exchange,
lo que sobra te llega en el activo del propio préstamo. Si en
cambio se entregó, lo que te espera es el colateral mismo. Varias cosas lo entregan, termine como termine el préstamo: un
liquidador que lo toma directamente con descuento, un cierre casado
dentro del protocolo contra una posición opuesta en lugar de vendido, o una venta que no pudo hacerse — ahí te llega el colateral salvo que el prestamista aporte una
cotización que funcione al reclamar — entonces cobras en el activo del
propio préstamo; la mayoría no aporta ninguna. Una liquidación ordinaria y
un default buscan ese casamiento interno antes de ir a un exchange,
así que ninguno de esos dos acaba siempre igual: lee la reclamación en
vez de deducirlo de cómo cerró. La toma con descuento es la excepción,
y es previsible al revés: nunca vende, así que siempre te deja el
colateral. A menudo —en un
default sobre colateral que no podemos valorar— se va la canasta
entera y no queda nada, y en esa vía es la regla, no un resultado desafortunado.
Reclamar consume tu NFT de posición de prestatario.
Lo contrario no se sigue: un NFT que sigue ahí tras una
liquidación no es prueba de que algo te espere. Si no quedó nada,
no hay nada que recoger, el intento se rechaza y el NFT puede
quedarse igualmente. Lee lo que dice la
reclamación en vez de tomar el NFT como una promesa.

---

<a id="chapter.activity"></a>

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

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### Conseguir VPFI

VPFI es libremente transferible. Adquiérelo en el mercado abierto
allá donde se negocie, o muévelo por puente —VPFI es un token
Chainlink CCIP, así que se mueve entre cadenas compatibles usando el
puente oficial y llega a tu billetera en la cadena a la que estés
conectado.

<a id="buy-vpfi.discount-status"></a>

### Tu estado de descuento VPFI

Lectura rápida del tier de descuento en el que estás actualmente. El
tier viene de cuánto VPFI hay en tu **vault** (no en tu billetera).
La tarjeta también te dice (a) cuánto VPFI más necesitarías en
vault para subir al siguiente tier, y (b) si el interruptor de
consentimiento del Dashboard está activado —el descuento sólo aplica
mientras lo esté.

<a id="buy-vpfi.deposit"></a>

### Deposita VPFI en tu vault

El VPFI en tu billetera no cuenta para el tier de descuento. Para
desbloquear el descuento de comisiones, mueve VPFI a tu vault tú
mismo. Esto siempre es un clic explícito —la app nunca mueve tu VPFI
sin que se lo pidas. Una transacción (o una sola firma, en cadenas
que lo soporten) y listo.

<a id="buy-vpfi.unstake"></a>

### Saca VPFI de tu vault

¿Quieres recuperar algo de VPFI en tu billetera? Esta tarjeta lo
envía desde el vault de vuelta a ti. Ten en cuenta: sacar VPFI baja
tu tier de descuento **inmediatamente**. Si tienes préstamos
abiertos, la matemática del descuento pasa al tier inferior desde
ese momento en adelante.

---

<a id="chapter.rewards"></a>

## Recompensas

<a id="rewards.overview"></a>

### Sobre las recompensas

Vaipakam te paga una **recompensa por interacción con la
plataforma**: cada dólar de intereses que un préstamo del que formas
parte llegue efectivamente a liquidar te otorga una porción diaria de
un pool de recompensas comunitario.

Las recompensas se pagan en VPFI, minteado directamente en la cadena
en la que estés. Sin puentes, sin cambios de cadena.

<a id="rewards.claim"></a>

### Reclamar recompensas

Un sólo botón reclama tus recompensas acumuladas en una única
transacción. La porción del pool de interacción se liquida una vez al
día, así que si has ganado algo desde la última liquidación, sólo
entra en vigor poco después de que cierre la próxima ventana diaria.

---

<a id="chapter.loan-details"></a>

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
prestatario— y los vaults de vault que guardan sus activos. Cada
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
  intereses, menos el recorte de tesorería fijado al crear tu
  préstamo (`{liveValue:treasuryFeeBps}`% para préstamos creados a
  la tasa actual). Consume tu NFT de prestamista.
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
  sola transacción. El colateral nunca sale del vault.
- **Reclamar** — una vez que el préstamo se liquida, devuelve tu
  colateral en caso de repago total. En caso de default puede quedar un
  excedente: sólo se toma el colateral que exigen la deuda y el coste
  de cerrarla, y lo que aportaste de más queda registrado como tu
  reclamación. Qué es exactamente depende de la vía —
  véase la sección del Claim Center.

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Dashboard de analítica pública

<a id="public-dashboard.overview"></a>

### Acerca de Public Analytics

Una vista sin wallet del protocolo en una red: la que la app está
leyendo. No necesitas conectar nada. La página se apoya en dos
fuentes públicas y dice de cuál viene cada cifra — el indexador
público, que cualquiera puede consultar sin clave, y el propio
contrato de la plataforma —, así que nunca tienes que fiarte de un
número sin más.

<a id="public-dashboard.loans-offers"></a>

### Préstamos y ofertas

Recuentos de préstamos por estado (activos, reembolsados, en
impago, liquidados, etc.) y de ofertas por estado, del indexador
público. Un recuento que el indexador no informó aparece como «no
informado», nunca como cero. Solo se cuentan ofertas on-chain: las
órdenes firmadas sin gas no se cuentan aquí, aunque sí aparecen en
el Offer Book. El total de ofertas son las que hay registradas
ahora, no un recuento histórico.

<a id="public-dashboard.recycling"></a>

### Cuenta de reciclaje y cierre del ciclo

De dónde salió el fondo de recompensas de cada día y cuánto se
retiró, y cuánto del VPFI de recompensa pagado por los reclamos se
queda dentro de la plataforma. Son registros contables del
indexador público; una cifra que aún no se conoce lo dice en lugar
de mostrar cero.

<a id="public-dashboard.transparency"></a>

### Transparencia y fuente

La dirección del contrato de la plataforma, con un enlace para
abrirla en un explorador de bloques, la red, el último bloque que
leyó el indexador y hace cuánto fue. Las cifras del indexador solo
están tan al día como ese bloque, por eso se muestra su
antigüedad.

<a id="public-dashboard.vpfi-transparency"></a>

### Token VPFI

Leído directamente del contrato de la plataforma, no del
indexador: la dirección del token VPFI y su suministro en esta red.
En la red donde se emite VPFI muestra además el tope de
suministro, cuánto se puede acuñar aún bajo él y la única
dirección autorizada para acuñar. En una red a la que VPFI llega
por puente muestra solo el suministro de esa red.

<a id="public-dashboard.fees"></a>

### Comisiones y tesorería

También leído del contrato: las comisiones que el protocolo ha
registrado desde que empezó el registro, en el último día y en la
última semana, y la dirección de tesorería a la que van. La página
indica el bloque leído, la antigüedad de esa lectura y las
funciones llamadas, y expone cada motivo por el que las cifras de
comisiones pueden ser menores que lo realmente cobrado. Tras un
cambio de moneda de referencia, las comisiones anteriores quedan
en la unidad antigua, lo que puede mover un total en cualquier
sentido; la página también lo dice. Una cifra que no se pudo leer
lo dice en lugar de mostrar cero.

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.next-app"></a>

## La próxima app

La próxima versión de la app de Vaipakam se construye página a
página, junto a la actual. Una página que aún no está construida lo
dice y te lleva a la app actual, que la sigue sirviendo. Este
capítulo explica las páginas que ya están construidas.

<a id="advanced-mode"></a>

### Basic y Advanced

Basic muestra lo que la mayoría necesita. Advanced añade las
herramientas de salida y liquidación, la automatización, las órdenes
firmadas, el estado de los keepers y el detalle contable. Cambiar de
modo nunca oculta un consentimiento que debas dar, algo que te
bloquee ni la forma de resolverlo. Cada botón de información (i), tras la frase que explica,
abre la explicación completa, y su enlace "Leer más" abre esta guía en el
modo que usas.

<a id="wallet"></a>

### Tu wallet y de dónde salen tus cifras

La app lee tus loans, tu vault y tus claims primero a través de la
propia conexión de tu wallet a la red. Solo cuando el wallet no
ofrece ninguna usa un proxy de solo lectura. Tus cifras nunca salen
del índice compartido. La dirección y la red que se muestran arriba
son a las que pertenece cada cifra de la página. Si tu wallet está
en una red que la app no atiende, no se muestra nada tuyo hasta que
cambies.

<a id="deployments"></a>

### Qué admite el despliegue

Antes de ofrecer cualquier acción, la app lee qué funciones admite
ahora mismo el contrato del protocolo en tu red. Una actualización
puede cambiar esa lista, y leerla permite a la app decirte qué
cambió en lugar de fallar. Si la lista no se puede leer, no se
ofrece ningún paso de firma.

<a id="home-start"></a>

### Home: elegir una tarea

Home empieza con "Quiero…": pedir prestado, prestar, alquilar un
NFT, alquilar tu NFT o gestionar lo que tienes. Cada opción abre
una página guiada. Pedir prestado y prestar muestran primero las
ofertas que encajan y te dejan publicar la tuya si ninguna sirve.
Alquilar cubre los dos lados: usar el NFT de otra persona o dejar
que alguien use el tuyo mientras sigue en un vault. Con un wallet
conectado, Home también muestra tres tarjetas breves de inicio, que
puedes ocultar.

<a id="home-status"></a>

### Home: estado del protocolo

Home siempre dice si el protocolo en tu red está en marcha. Mientras
está en pausa por un incidente, se detienen las nuevas posiciones,
los claims, los retiros, las liquidaciones, los defaults y los pasos
de los keepers. El reembolso total, el reembolso parcial y añadir
colateral siguen abiertos, y el tiempo en pausa se suma a la fecha
de vencimiento de cada loan abierto. Una pausa automática dura un
tiempo fijo, y otra solo puede empezar tras un periodo de espera. El
servicio de keepers puede pausarse por separado; eso nunca bloquea
lo que haces tú. Si el estado no se puede leer, Home lo dice arriba
en lugar de suponer que todo funciona.

<a id="home-payouts"></a>

### Home: listo para cobrar

Un pago está listo cuando un loan ha terminado y un claim te pagaría
ahora: el reembolso para quien prestó, el colateral de vuelta (o lo
que quede) para quien pidió prestado, o un NFT devuelto al final de
un alquiler. Home los lista primero y te envía a Claims, que muestra
cada importe antes de cobrar.

<a id="home-loans"></a>

### Home: tus loans

Cada loan activo muestra tu lado, sus condiciones, su colateral y su
próximo plazo, el más urgente primero. Un loan vence en su fecha de
vencimiento. Después corre un periodo de gracia en el que quien pidió
prestado aún puede pagar con un recargo por demora. Cuando termina,
cualquiera puede iniciar el default, que liquida el loan con el
colateral. El health factor compara el valor del colateral con la
deuda: por debajo de 1, el loan puede liquidarse. Un loan en un
activo sin precio no tiene health factor. Los loans abiertos desde
una de tus ofertas se muestran juntos.

Un loan que paga intereses periódicamente también tiene hitos, hasta su vencimiento incluido. Los intereses aún debidos cuando termina la gracia de un hito pueden pagarse vendiendo colateral, y el loan sigue abierto; Home muestra el próximo hito y pone primero uno pendiente, aunque caiga en el vencimiento, porque su gracia puede terminar antes que la del loan. El protocolo puede desactivar esta liquidación; Home dice entonces que no se vende colateral en un hito.

<a id="home-exposure"></a>

### Home: prestado y pedido

Cuando prestas y pides prestado a la vez, Home compara los dos lados
por su valor de hoy. Los loans que no se pueden valorar, como NFTs o
activos sin precio, se cuentan y se dejan fuera, y Home nombra el
lado mayor solo cuando no podrían cambiar la respuesta.

<a id="home-faucet"></a>

### Home: activos de prueba

En una red de prueba, Home ofrece tokens y NFT de prueba para que puedas probar a pedir prestado, prestar y alquilar sin dinero real. No tienen valor y los acuñan contratos de tokens de prueba, no el protocolo. Algunos tokens de prueba tienen un precio de prueba, así que los préstamos en ellos tienen factor de salud; otros no lo tienen, así que un impago entrega la propia garantía. Los NFT de prueba se pueden alquilar. Cada acuñación muestra primero un recibo y el resultado se comprueba después en la cadena.

<a id="home-fee-discount"></a>

### Home: descuento en comisiones

El descuento en comisiones es un único ajuste por red para toda tu wallet. Mientras está desactivado, tus comisiones no tienen descuento, tengas el VPFI que tengas. Mientras está activado, se reduce la comisión que pagas al pedir prestado y también la comisión sobre los intereses que ganas como prestamista, según tu nivel de descuento VPFI en el momento de cobrarse cada comisión; en el nivel 0 no hay descuento. En algunas redes el descuento del prestamista se paga en VPFI desde tu vault, y el recibo te dice cuál aplica antes de confirmar. Activarlo requiere haber aceptado los Términos vigentes; desactivarlo, nunca. Mientras el protocolo está en pausa no se puede cambiar en ningún sentido. Un préstamo en un activo prestado ilíquido sigue pagando la comisión completa, y ningún descuento supera nunca la mitad de la comisión.

<a id="home-rewards"></a>

### Home: Recompensas

Las recompensas son reembolsos por uso de tus préstamos dados y recibidos en esta red, se cuentan por día de recompensa y se pagan en VPFI. Home muestra exactamente lo que pagaría un reclamo hecho ahora, porque la app ejecuta primero el reclamo como vista previa. Si esa vista previa no puede ejecutarse, Home muestra en su lugar un límite inferior, señalado como tal, y no ofrece el reclamo hasta poder calcular la cifra exacta. Un reclamo paga hasta 30 días de recompensa; si queda más, Home ofrece reclamar de nuevo, y detenerse a mitad es seguro. Un reclamo se entrega en tu bóveda, listo para usar, o en tu billetera cuando la bóveda no puede recibirlo; un reclamo nunca abre una bóveda. Cuando un día de recompensa aún espera su finalización entre redes, o que su financiación llegue a esta red, Home nombra ese día en vez de ofrecer un reclamo que fallaría. Las recompensas no son interés ni rendimiento, y reclamar nunca hace staking ni reinvierte nada. De vez en cuando un claim no paga nada pero avanza más allá de días de recompensa que no le pagaron nada, para que los días siguientes puedan pagarse; Home lo indica y lo ofrece igualmente.

<a id="home-rewards-expiry"></a>

### Home: Fechas de retirada de recompensas

En una red donde las recompensas no reclamadas pueden retirarse, Home muestra la fecha estimada de retirada más próxima entre tus recompensas, y un aviso final en los últimos 90 días antes de ella. Reclamar antes conserva siempre la recompensa. La estimación nunca es posterior a la fecha real tal como están las cosas: el tiempo en que la recompensa no puede reclamarse retrasa la fecha real, pero un cambio en la ventana de reclamo de la red puede adelantarla, así que vuelve a comprobarla antes de confiar en ella. Si no pudo comprobarse cada recompensa, Home lo dice en lugar de afirmar que nada vence. Donde la red no retira nada, no se muestra ninguna fecha.

<a id="home-rewards-held"></a>

### Home: Recompensas retenidas

Si el control de sanciones marca tu billetera, no se le paga nada mientras siga marcada. Las recompensas que ganó antes de la marca se retienen para ella, bloqueadas pero no perdidas, y se liberan cuando la billetera deja de estar marcada; entonces Home ofrece reclamar exactamente ese saldo por separado. Mientras una marca esté confirmada, las recompensas ganadas se pierden para siempre y el VPFI de tu bóveda no puede moverse. Si no puede leerse si la billetera sigue marcada, no se libera nada.

<a id="borrow-start"></a>

### Borrow: Cómo funciona

Para pedir prestado, aceptas la oferta abierta de un prestamista: una cantidad de un token, una tasa, un plazo y la garantía que pide el prestamista. Aceptarla abre el préstamo en una sola transacción. Tu garantía pasa de tu wallet a tu propio vault, donde queda bloqueada mientras el préstamo siga abierto, y la cantidad, menos una pequeña comisión de apertura, llega a tu wallet. Devuelves la cantidad más los intereses antes de la fecha de vencimiento. Si ninguna oferta encaja, también puedes publicar tu propia solicitud de préstamo y esperar a un prestamista.

<a id="borrow-pair"></a>

### Borrow: Elegir los tokens

Primero elige qué pedir prestado y qué bloquear. La app sugiere tokens de la red, o puedes pegar una dirección de token; no se hace ninguna revisión de seguridad de tokens, así que revisa tú mismo una dirección pegada. Para cada token, la app lee lo que el protocolo dice de él ahora. Un token líquido tiene precio, así que el préstamo tiene un factor de salud y puede liquidarse si la garantía pierde valor. Un token ilíquido se valora en cero y, en caso de impago, el prestamista recibe la propia garantía. Cuando el protocolo no confía en el precio de un token, los préstamos nuevos sobre él se cierran hasta que vuelva a confiar; los préstamos ya abiertos no se ven afectados.

<a id="borrow-offers"></a>

### Borrow: Elegir una oferta

La página muestra las ofertas abiertas de prestamistas para tus dos tokens, leídas del propio protocolo. Cada una indica la cantidad, la tasa y el plazo, la garantía pedida, la relación préstamo-valor a los precios de hoy, cómo se cobran los intereses, el calendario de intereses si lo hay, cuándo termina la oferta y lo que recibirías tras la comisión. Una oferta se acepta entera, por la cantidad completa del prestamista y su tasa más baja. Si el protocolo rechazaría una oferta, la página dice por qué y no muestra botón. El orden es una ayuda, no un consejo.

<a id="borrow-review"></a>

### Borrow: Revisar y firmar

Antes de que se abra tu wallet, la revisión muestra cada cifra: lo que recibes, la comisión, lo que bloqueas, la tasa, lo que debes en la fecha de vencimiento, el periodo de gracia y lo que puedes perder. Marcas una casilla para aceptar las Divulgaciones de riesgos y los Términos; si las cifras cambian antes de confirmar, la casilla se desmarca. Luego tu wallet te pide firmar los términos, lo que no cuesta nada, aprobar exactamente la garantía si hace falta, y enviar la aceptación, que la app prueba antes como simulación. Si se detiene tras una aprobación, la app pide restablecerla y dice si lo logró. Después, la app comprueba en la cadena el préstamo abierto, lo que llegó y lo que se bloqueó. También indica las condiciones del préstamo durante su vida, cada una aunque sea la predeterminada: el reembolso parcial, la venta de la garantía y cualquier refinanciación o préstamo vinculado. El importe adeudado supone que no hay pausa: una pausa retrasa la fecha de vencimiento y los intereses siguen corriendo durante ella.

<a id="borrow-fee"></a>

### Borrow: La comisión de apertura

Abrir un préstamo cuesta una pequeña parte de la cantidad, cobrada una vez, en el token que pides prestado, y descontada de lo que recibes; la revisión muestra la tasa vigente. Debes intereses sobre la cantidad completa. Tu nivel de descuento reduce la comisión cuando el descuento de comisiones está activado y el token prestado es líquido. No se toma ni se retiene VPFI por esta comisión, y no se reembolsa nada después. Como envías tú mismo la aceptación, una pequeña parte de la comisión, la que el protocolo paga a quien envía un emparejamiento, vuelve a ti junto con la cantidad; la revisión la muestra.

<a id="borrow-risks"></a>

### Borrow: Riesgos

Un préstamo puede costarte tu garantía. Si no has devuelto al final del periodo de gracia, el préstamo entra en impago y el prestamista cobra de tu garantía: vendida para él donde el protocolo puede, entregada tal cual donde no. Con garantía líquida, si su valor cae hasta que el factor de salud baja de 1, cualquiera puede liquidar el préstamo y pierdes garantía. Con intereses de plazo completo debes los intereses de todo el plazo aunque devuelvas antes. Con un calendario de intereses, un periodo impagado se cubre vendiendo parte de tu garantía. Tu garantía queda bloqueada hasta que el préstamo se devuelva o se liquide.

<a id="borrow-request"></a>

### Borrow: Publicar tu propia solicitud

Si ninguna oferta encaja, puedes publicar tu propia solicitud de préstamo para tus dos tokens: el importe exacto, la tasa que pagarás, el plazo y la garantía que bloqueas. Al publicarla, la garantía pasa de tu wallet a tu propio vault, donde queda mientras la solicitud esté abierta. Un prestamista que la acepte abre el préstamo al instante, con tus condiciones, sin volver a preguntarte; el importe, menos la comisión de apertura, llega a tu wallet. Puedes cancelarla a partir de cinco minutos después de publicarla, y la garantía vuelve a tu wallet. Una solicitud vencida ya no puede aceptarse; su garantía queda en tu vault hasta que tú, o cualquiera, la cierre, y entonces vuelve solo a tu wallet. Mientras la página de Ofertas de la próxima app no esté construida, sigues, cancelas y cierras una solicitud en la página de Ofertas de la app actual; la revisión lo dice antes de bloquear nada.

<a id="borrow-request-terms"></a>

### Borrow: Las condiciones de la solicitud

Un prestamista toma el importe completo, o nadie lo toma. Cada cifra se lee exactamente como la escribes: más decimales de los que tiene el token se rechazan, nunca se redondean, y la tasa llega hasta el 100 % anual con dos decimales. Los plazos ofrecidos terminan en el más largo que permite la red; también puedes escribir un plazo en días. La solicitud sigue abierta hasta que se acepte o se cancele, o durante los días que elijas, hasta un año. El interés de plazo completo, la opción habitual, se debe entero aunque devuelvas antes; el prorrateado cobra solo por el tiempo que el préstamo está abierto. El formulario muestra lo que recibirías con la comisión de hoy y deberías en la fecha de vencimiento si un prestamista la aceptara ahora.

<a id="borrow-request-review"></a>

### Borrow: Revisar y publicar una solicitud

Antes de que se abra tu wallet, la app pide al protocolo que pruebe tu solicitud como simulación, así que la revisión muestra la respuesta del propio protocolo. Indica lo que bloqueas ahora, el importe, la tasa y el plazo, lo que recibirías y cómo se fija la comisión (la tasa de comisión vigente cuando un prestamista la acepte, menos tu nivel de descuento de comisiones en ese momento; la cifra mostrada usa la tasa de hoy), lo que deberías, cada condición del préstamo, cuándo vence la solicitud, la relación préstamo-valor y si hace falta una aprobación. Marcas una casilla para aceptar las Divulgaciones de riesgos y los Términos. Tu wallet aprueba exactamente la garantía si hace falta, la app vuelve a probar la solicitud y solo entonces la publica. Si se detiene tras una aprobación, la app pide restablecerla y dice si lo logró. Después, la app comprueba en la cadena la solicitud registrada y la garantía bloqueada.

<a id="borrow-nft-collateral"></a>

### Borrow: un NFT como garantía

Una solicitud puede bloquear un NFT en lugar de un token. Elige la colección como lo que bloqueas (las colecciones de prueba están marcadas como NFT, o pega una dirección); si una dirección es un token o una colección de NFT se lee de su contrato. Luego escribe el número del NFT, su id de token, que muestra tu billetera o la página de la colección; el formulario dice al momento si tu billetera lo tiene. El protocolo valora un NFT en cero, sea cual sea su precio en otro lugar: un préstamo con él no tiene relación préstamo-valor ni liquidación por precio, y si no pagas antes del fin del periodo de gracia, el prestamista recibe el propio NFT. Al publicar, tu billetera aprueba al protocolo solo para ese NFT, nunca para el resto de tu colección, y moverlo a tu bóveda borra esa aprobación por sí solo; si la solicitud se detiene tras la aprobación, la app pide restablecerla y dice si ocurrió. Los NFT que vienen en cantidades (colecciones multitoken) funcionan igual, con una cantidad: escribe el número del token y cuántos bloquear, y el formulario dice cuántos tiene tu billetera. Una colección así no puede aprobar un solo token, solo todos los tuyos en ella, así que publicar concede esa aprobación solo para esta solicitud y la retira con un paso más de la billetera después, se haya completado la solicitud o no; una aprobación que ya habías dado se deja como la dejaste. Aceptar la oferta de un prestamista que pide un NFT todavía se hace en la app actual por ahora.

<a id="borrow-request-range"></a>

### Borrow: Un rango de importes (Avanzado)

En el modo Avanzado una solicitud puede aceptar un rango: el importe más pequeño y el más grande que un prestamista puede prestar, a su única tasa, y, si lo desea, una garantía menor para el préstamo más pequeño. Un prestamista que acepta la solicitud directamente presta el importe más pequeño y bloquea solo la garantía fijada para él; el resto vuelve a su billetera. Los emparejamientos pueden prestar más, hasta el importe más grande, mientras el emparejamiento esté activado en la red; la revisión dice si lo está, y que mientras esté desactivado el rango se llena una sola vez. El protocolo rechaza un importe más grande que su garantía no respalda a los precios de hoy, y la revisión indica el máximo que respalda. La revisión muestra la relación préstamo-valor en ambos extremos y avisa cuando un prestamista no podría aceptar la solicitud directamente a los precios de hoy. Las opciones fijadas en Avanzado siguen aplicándose si cambia a Básico: el formulario lo dice y le permite borrarlas. Un emparejamiento bloquea solo la garantía que pide su prestamista, como mínimo el piso, así que la revisión indica el mayor emparejamiento desde toda tu garantía hasta solo el piso, y advierte que un préstamo emparejado puede empezar con más riesgo que uno directo. Mientras el emparejamiento esté activado, la garantía que un emparejamiento no bloquea queda con la solicitud para emparejamientos posteriores y vuelve a su billetera solo cuando la solicitud se cierra o usted la cancela.

<a id="borrow-request-fill"></a>

### Borrow: Cómo se llena una solicitud (Avanzado)

Parcial, el valor predeterminado, permite que los emparejamientos llenen la solicitud en uno o más préstamos hasta que se llene, se cancele o caduque. Todo o nada admite un único llenado del importe completo, por lo que no puede usarse con un rango. Inmediato o cancelar llena como parcial, pero solo hasta que la solicitud caduca, por lo que necesita una caducidad. El modo de llenado no puede cambiarse después de publicar; para cambiarlo, cancele la solicitud y publique una nueva. El protocolo permite cambiar los importes, la tasa y la garantía mientras la solicitud está abierta, nunca por debajo de lo que ya usaron los emparejamientos, pero esta aplicación aún no lo ofrece, así que por ahora un cambio implica cancelar y publicar de nuevo.

<a id="borrow-request-cadence"></a>

### Borrow: Un calendario de intereses (Avanzado)

En el modo Avanzado una solicitud puede pagar los intereses según un calendario en lugar de todo al reembolsar: cada mes, trimestre, seis meses o año. El formulario ofrece solo los calendarios que el protocolo permite para tus condiciones y, bajo cada uno cerrado, dice por qué: los intereses periódicos están desactivados en la red, un activo no tiene precio, el préstamo vale menos que el umbral del protocolo (se muestran ambas cifras) o el periodo no es más corto que el préstamo. La revisión muestra los intereses de cada periodo y la gracia que recibe un periodo impagado. Si un periodo no se paga antes de que termine su gracia, cualquiera puede vender parte de tu garantía para pagarlo, y el préstamo sigue abierto. El calendario no se puede cambiar después de publicar. Como las demás opciones avanzadas, sigue aplicándose si cambias a Básico, y el formulario lo dice.

<a id="borrow-request-tariff"></a>

### Borrow: La tarifa de comisión Full (Avanzado)

En el modo Avanzado una solicitud puede tomar la tarifa de comisión Full: una comisión en VPFI, tomada de su bóveda al abrirse cada préstamo, que añade diez puntos al descuento de la comisión del préstamo, hasta el tope del 50 % del protocolo. La comisión del préstamo se sigue cobrando en el activo prestado, y la tarifa no se reembolsa. El formulario la ofrece solo mientras el protocolo la tiene activada y muestra la tarifa de hoy para su importe y plazo. Usted fija lo máximo en VPFI que puede tomar un préstamo (en blanco, la tarifa de hoy para el préstamo más grande) y qué ocurre con un préstamo que no puede tomar la tarifa al abrirse: se rechaza, o se abre sin ella. Un préstamo solo puede tomarla si, en ese momento, la tarifa está activada, el activo prestado tiene precio y es líquido, su tarifa está dentro de su máximo y su bóveda tiene suficiente VPFI libre. La tarifa se fija con una segunda transacción después de publicar, así que un prestamista que tome la solicitud antes de que esa transacción se confirme abre un préstamo sin ella. Esta aplicación aún no ofrece préstamos de respaldo para solicitudes que nadie toma.

<a id="lend-start"></a>

### Lend: Cómo funciona

Para prestar, usted financia la solicitud abierta de un prestatario: un importe de un token, la tasa que pagará, un plazo y una garantía que el prestatario ya ha bloqueado en su propia bóveda. Financiarla abre el préstamo en una sola transacción. El importe sale de su billetera, el prestatario lo recibe menos su comisión de apertura y la garantía queda bloqueada para usted hasta que el préstamo termine. Su lado del préstamo es un token de posición en su billetera, y quien lo tenga es quien cobra. El prestatario devuelve el importe más los intereses antes de la fecha de vencimiento, y el protocolo se queda con su parte de los intereses. Si ninguna solicitud le conviene, puede publicar su propia oferta de préstamo desde la misma página.

<a id="lend-offers"></a>

### Lend: Elegir una solicitud

Primero elija qué prestar y qué garantía acepta; deben ser tokens distintos, y esta página solo ofrece tokens. La página lista las solicitudes de préstamo abiertas para ese par, leídas del propio protocolo. Cada una muestra el importe, la tasa y el plazo, la garantía bloqueada, la relación préstamo-valor a los precios de hoy, cómo se cobran los intereses, cualquier calendario de intereses y cuánto de la comisión del prestatario vuelve a usted. Una solicitud se financia completa: si indica un rango, usted presta el importe mínimo del prestatario a su tasa más alta. Cuando el protocolo rechazaría una solicitud, la página dice por qué y no ofrece botón. Sus propias solicitudes, las solicitudes con un NFT y las ventas de préstamos en curso se cuentan, no se listan. El orden (primero las solicitudes que puede financiar, luego la tasa más alta) es una ayuda, no un consejo.

<a id="lend-review"></a>

### Lend: Revisar y firmar

Antes de que se abra su billetera, la revisión muestra cada cifra: lo que sale de su billetera, lo que recibe el prestatario, la comisión y su parte de ella, la garantía retenida para usted, la tasa, los intereses debidos en la fecha de vencimiento, la parte del protocolo en ellos, lo que vuelve a usted, el período de gracia y lo que puede perder. También indica cada condición del ciclo de vida, incluso cuando es la predeterminada. Si su billetera tiene menos que el importe, la revisión dice cuánto falta y no ofrece firma. Marca una casilla para aceptar las Divulgaciones de Riesgo y los Términos; si las cifras cambian antes de confirmar, la casilla se desmarca. Luego su billetera le pide firmar los términos, lo que no cuesta nada, aprobar exactamente el importe si hace falta y enviar la aceptación, que la app primero prueba como simulación. Si se detiene después de una aprobación, la app ofrece revertir la aprobación y dice si ocurrió. Después, la app comprueba en la cadena el préstamo que abrió, lo que salió de su billetera y lo que volvió.

<a id="lend-fee"></a>

### Lend: La comisión y la parte del protocolo

La comisión de apertura es del prestatario: una pequeña parte del importe, cobrada una vez en el activo prestado y descontada de lo que recibe el prestatario. Usted presta el importe completo, y el prestatario lo debe íntegro con intereses. Como usted mismo envía la aceptación, una pequeña parte de esa comisión, la que el protocolo paga a quien envía un emparejamiento, vuelve a su billetera; la revisión la muestra. Si el prestatario eligió la tarifa de comisión Full y se aplica al abrirse el préstamo, la comisión es menor, y también esa parte. Cuando se pagan intereses, el protocolo se queda con su parte, a la tasa vigente al abrirse el préstamo; su nivel de descuento de comisiones puede reducir esa parte mientras su ajuste de descuento esté activado. La revisión muestra la tasa de hoy y lo máximo que puede tomar esa parte.

<a id="lend-risks"></a>

### Lend: Riesgos

Prestar puede hacerle perder dinero. Si el prestatario no ha pagado al final del período de gracia, el préstamo entra en impago y se le paga con la garantía: vendida para usted donde el protocolo puede, entregada tal cual donde no, y una venta puede obtener menos de lo que se le debe. Con garantía líquida, cualquiera puede liquidar el préstamo cuando su factor de salud baja de 1; la venta le paga a usted primero, pero una caída brusca puede dejar menos de lo que se le debe. Un token ilíquido se valora en cero, así que no hay liquidación por precio, y en caso de impago usted recibe toda la garantía, valga lo que valga. No puede recuperar el importe antes de que termine el préstamo; salir antes significa vender su posición a otro prestamista. Con intereses prorrateados, un pago anticipado le rinde menos. Una pausa aplaza la fecha de vencimiento, y los intereses siguen acumulándose durante ella.

<a id="lend-offer"></a>

### Lend: Publicar su propia oferta

Si ninguna solicitud le conviene, puede publicar su propia oferta de préstamo para sus dos tokens: el importe exacto que presta, la tasa que pide, el plazo y la garantía que un prestatario debe bloquear. Al publicarla, el importe pasa de su billetera a su propia bóveda, donde queda bloqueado mientras la oferta esté abierta. Un prestatario que la acepta abre el préstamo de inmediato, en sus condiciones, sin volver a preguntarle: recibe el importe menos su comisión de apertura, y su garantía queda bloqueada en su bóveda para usted. Mientras el emparejamiento esté activado en la red, cualquiera puede además emparejar su oferta con la solicitud de un prestatario; sin partes, ese préstamo presta todo su importe a su tasa, contra al menos la garantía que usted pide. La revisión indica si el emparejamiento está activado ahora. Puede cancelar a partir de cinco minutos después de publicar, y el importe vuelve a su billetera. Una oferta vencida ya no se puede aceptar; su importe queda en su bóveda hasta que usted, o cualquiera, la cierre, y luego vuelve solo a su billetera. Hasta que exista la página de Ofertas de la próxima app, usted sigue, cancela y cierra una oferta en la página de Ofertas de la app actual; la revisión lo dice antes de que se bloquee nada.

<a id="lend-offer-terms"></a>

### Lend: Las condiciones de la oferta

Salvo que fije partes en el modo avanzado, un solo prestatario toma todo el importe, o nadie, y debe bloquear exactamente la garantía que usted fija. El formulario muestra cuánto del token prestado tiene su billetera. Cada cifra se lee exactamente como la escribe: más decimales de los que tiene el token se rechazan, nunca se redondean, y la tasa llega hasta el 100 % anual con dos decimales. Los plazos ofrecidos terminan en el más largo que permite la red. La oferta sigue abierta hasta que se acepte o se cancele, o durante los días que elija, hasta un año. Los intereses de plazo completo, la opción habitual, significan que un reembolso anticipado no reduce lo que usted gana; a prorrata se le paga solo por el tiempo que el préstamo está abierto. También puede permitir que el prestatario reembolse una parte antes. El formulario muestra lo que el prestatario le debería en la fecha de vencimiento si aceptara la oferta ahora. En el modo avanzado una oferta también puede prestarse en partes, llevar un modo de ejecución, pagar intereses según un calendario y tomar la tarifa de comisión Full.

<a id="lend-offer-parts"></a>

### Lend: Una oferta en partes (Avanzado)

En el modo avanzado una oferta de préstamo puede prestarse en partes. El importe que escribe sigue siendo el importe entero: publicar bloquea todo, y un prestatario que toma su oferta directamente toma prestado todo. Usted añade la parte más pequeña que un emparejamiento puede prestar. Mientras el emparejamiento esté activado en la red, los emparejadores pueden prestar su oferta a varios prestatarios, cada préstamo entre la parte más pequeña y lo que queda, a su tasa. Cada uno pide al menos la parte de su garantía que corresponde a su parte, redondeada hacia abajo, y la revisión muestra lo que pide la parte más pequeña. Cuando un emparejamiento ha prestado una parte, ningún prestatario puede tomar el resto directamente; solo más emparejamientos pueden, y usted puede cancelar la oferta para recuperar el resto. Cuando queda menos que la parte más pequeña, el protocolo lo devuelve a su billetera y cierra la oferta. La revisión indica si el emparejamiento está activado ahora; mientras esté desactivado, solo un prestatario que toma todo abre un préstamo. El modo de ejecución funciona como en una solicitud: parcial por defecto, todo o nada para un solo préstamo del importe entero (así que sin partes), o inmediato o cancelado, que necesita un vencimiento; no puede cambiarse después de publicar. El protocolo rechaza una oferta que pide menos garantía de la que el importe entero necesita a los precios de hoy, y la revisión indica el mínimo que pide. Las opciones fijadas en Avanzado siguen aplicándose si cambia a Basic: el formulario lo dice y le deja borrarlas.

<a id="lend-offer-schedule"></a>

### Lend: Un calendario de intereses en una oferta (Avanzado)

En el modo Avanzado una oferta de préstamo puede llevar un calendario de intereses, como una solicitud: cada mes, trimestre, seis meses o año. El formulario ofrece solo los calendarios que el protocolo permite para sus condiciones, y dice bajo cada uno cerrado por qué. Con partes, el protocolo comprueba la parte más pequeña al publicar, así que una parte más pequeña por debajo de su umbral cierra los calendarios más finos; cada préstamo se comprueba de nuevo al abrirse. La revisión muestra los intereses de cada periodo si un prestatario toma todo y, con partes, en un préstamo de la parte más pequeña, y la gracia de un periodo impagado. Si un periodo no se paga al final de su gracia, cualquiera puede vender parte de la garantía del prestatario para pagárselo a usted, y el préstamo sigue abierto. El calendario no puede cambiarse después de publicar.

<a id="lend-offer-tariff"></a>

### Lend: La tarifa de comisión Full en una oferta (Avanzado)

En el modo Avanzado una oferta de préstamo puede tomar la tarifa de comisión Full: una comisión en VPFI, tomada de su bóveda al abrirse cada préstamo de la oferta, calculada según el importe y el plazo de ese préstamo. A cambio, la parte del protocolo sobre los intereses de ese préstamo recibe diez puntos más de descuento, hasta su tope del 50 %; la parte se sigue tomando en el activo prestado. Los puntos extra duran el plazo del préstamo: si el préstamo se prorroga por un nuevo plazo, terminan para ese plazo. Pertenecen a la posición de prestamista, así que los recibe quien la tenga cuando se pagan intereses. La tarifa no se reembolsa. El formulario muestra la tarifa de hoy para el importe entero, el mayor préstamo que abre la oferta. Usted fija lo máximo en VPFI que puede tomar un préstamo, y si un préstamo que no puede tomar la tarifa se rechaza o se abre sin ella. Un préstamo solo puede tomarla si, en ese momento, la tarifa está activada, el activo prestado tiene precio y es líquido, su tarifa está dentro de su máximo y su bóveda tiene suficiente VPFI libre. La tarifa se fija con una segunda transacción después de publicar, así que un préstamo abierto desde la oferta antes de que se confirme, por un prestatario o por un emparejamiento, se abre sin ella.

<a id="lend-offer-review"></a>

### Lend: Revisar y publicar una oferta

Antes de que se abra su billetera, la app pide al protocolo que pruebe su oferta en simulación, así que la revisión muestra la respuesta del propio protocolo. Indica lo que bloquea ahora, el importe que toma un prestatario, la garantía que debe bloquear, la tasa y el plazo, lo que el prestatario recibiría con la comisión de hoy, los intereses a la fecha de vencimiento, la parte del protocolo y lo que vuelve a usted, cada condición del ciclo de vida, cuándo vence la oferta, la relación préstamo-valor a los precios de hoy y si hace falta una aprobación. Si su billetera tiene menos que el importe, la revisión dice cuánto falta y no ofrece firma. Marca una casilla para aceptar las Advertencias de riesgo y los Términos. Su billetera aprueba exactamente el importe si hace falta, la app prueba la oferta de nuevo, y solo entonces la publica. Si se detiene tras una aprobación, la app pide devolver la aprobación a su estado anterior e indica si ocurrió. Después, la app comprueba en la cadena la oferta registrada y el importe bloqueado en su bóveda.

<a id="lend-offer-fee"></a>

### Lend: Las comisiones de su oferta

Publicar una oferta no le cobra ninguna comisión. La comisión de apertura es del prestatario: una pequeña parte del importe, cobrada una vez en el activo prestado cuando un prestatario acepta su oferta, a la tasa vigente entonces, y descontada de lo que recibe. Usted presta todo el importe, y el prestatario se lo devuelve completo con intereses. Cuando se pagan los intereses, el protocolo se queda con su parte, a la tasa vigente al abrirse el préstamo; su nivel de descuento de comisiones puede reducir esa parte mientras su ajuste de descuento esté activado. La revisión muestra la tasa de hoy y lo máximo que puede tomar esa parte; si esa tasa no se puede leer, la revisión lo dice en lugar de mostrar una cifra.

<a id="positions"></a>

### Positions: Tus posiciones de préstamo

Positions muestra cada préstamo que prestaste o tomaste en esta red, a partir de los tokens de posición que guarda tu wallet, así que una posición que transferiste a otra persona sale de tu lista. Primero aparecen los pagos listos para cobrar, que abren Claims. Después, los préstamos activos, con el plazo más urgente primero, como en Home. Al final, los préstamos terminados, cada uno con cómo terminó: reembolsado, en impago, liquidado o cerrado por un emparejamiento. Un préstamo terminado cuyo pago sigue esperando te remite a Claims.

Todos, Prestados y Tomados filtran las tres listas a la vez. Positions dice que no tienes nada solo después de leerlo todo; si una lista no se pudo leer entera, lo indica. Cada préstamo abre su propia página, que muestra las acciones disponibles para ti. La lista nunca firma nada.

<a id="position"></a>

### Position: un préstamo

Cada préstamo tiene su propia página. Empieza con el estado del préstamo y luego tu papel: el lado que tu wallet guarda ahora, ya que los tokens de posición pueden venderse o transferirse. Si no guardas ningún lado, solo lo estás viendo. Un plazo que te afecta se redacta para tu lado. Cuando termina el período de gracia, la página dice que cualquiera puede iniciar el impago, y solo cuando el protocolo lo confirma.

Debajo aparecen las fechas del préstamo (la fecha de vencimiento del plazo actual antes de cualquier crédito por pausa, el tiempo añadido mientras el protocolo estuvo en pausa, la fecha de vencimiento y el fin del período de gracia), sus condiciones tal como están ahora (un reembolso parcial reduce el principal aún adeudado), su factor de salud y dónde está su garantía. Una cifra que no se pudo leer aparece como desconocida. Si la garantía no tiene precio, un impago entrega al prestamista la garantía misma, y la página lo dice. Si la red reserva una banda justo por encima del umbral de liquidación para un emparejamiento interno con otro préstamo, la página lo indica: dentro de esa banda ninguna venta externa puede cerrar el préstamo. Un alquiler de NFT no tiene garantía: si entra en impago, termina el uso del arrendatario, el alquiler prepagado va al prestamista menos la parte del protocolo y el colchón va a la tesorería. Pagar el préstamo completo, pagar una parte, añadir garantía y retirarla son sus primeras acciones; las demás llegan en próximas actualizaciones.

<a id="repay"></a>

### Pagar el préstamo completo

En un préstamo activo, la página ofrece pagarlo completo. Cualquiera puede pagar excepto el prestamista. Si no tienes la posición de prestatario, pagar no te da ningún derecho sobre la garantía: solo su titular puede cobrarla. El pago queda retenido una vez terminado el período de gracia (el préstamo pasa entonces a impago) y mientras haya una orden de swap-to-repay pendiente.

Lo que debes crece cada segundo, y el protocolo toma el importe del momento en que se confirma tu pago. La revisión muestra dos cifras: lo que cuesta ahora y lo que costaría unos treinta minutos después. Tu billetera aprueba exactamente la segunda cifra. Si ya habías aprobado más, incluso una cantidad ilimitada, se reduce a esa cifra para el pago, porque el pago no fija por sí mismo ningún máximo. La aprobación limita el importe, no el tiempo: un pago que se confirma más tarde solo se ejecuta mientras lo que debes siga cabiendo en ella; si no, se rechaza y nada se mueve. En un préstamo que cobra el plazo completo, el importe no crece antes del vencimiento, así que un pago posterior aún puede ejecutarse. Lo que el pago no use de la aprobación se restablece después. Luego el prestatario cobra la garantía y el prestamista cobra el principal y los intereses en Claims.

<a id="interest-schedule"></a>

### Calendario de intereses

Un préstamo con calendario de intereses debe intereses en cada período (un mes, un trimestre, seis meses o un año), no solo al final. Su página muestra el período actual: cuándo termina, cuándo termina su período de gracia, los intereses que debe, lo pagado a cuenta y lo que aún se debe. Los intereses de un período se calculan sobre el principal y la tasa tal como están ahora, así que un reembolso parcial los reduce.

Cuando terminan un período y su gracia, cualquiera puede liquidarlo. Un período pagado solo adelanta el punto de control; en uno aún incompleto se vende justo la garantía del prestatario necesaria para cubrir lo adeudado y los costes de la venta. La página dice si la liquidación está abierta ahora. Nombra el interruptor de liquidación periódica de la red cuando está apagado (entonces no se puede liquidar nada ni se vende garantía) y la pausa del protocolo mientras dura (la liquidación se detiene y el tiempo en pausa se añade a las fechas del período). Una pausa retrasa las fechas del período por el tiempo en pausa, pero los intereses que debe un período siguen siendo los de un período; los intereses siguen acumulándose durante la pausa, y todo interés que pague un reembolso cuenta para el período.

<a id="partial-repay"></a>

### Pagar parte de un préstamo

El titular de la posición prestataria puede pagar parte del principal de un préstamo en curso desde su página, cuando los términos del préstamo lo permiten. Escriba la parte del principal: el protocolo acepta al menos su parte mínima para el token prestado y menos que todo el principal (pagarlo todo es «Pagar todo»). Se suma el interés acumulado desde el último pago de intereses del préstamo. El préstamo sigue en curso con el principal más bajo y su fecha de vencimiento no se mueve.

La revisión muestra la parte, el interés, el principal restante y lo que cubre la aprobación. En un préstamo prorrateado antes de su vencimiento, el interés es exacto. En un préstamo de plazo completo, o después del vencimiento, aparece «como máximo»: la cifra del protocolo que lee la aplicación también cuenta el resto del plazo o un recargo por mora, que un pago parcial no cobra. El pago parcial queda en espera mientras haya activa una solicitud de refinanciación del préstamo o una oferta de compensación sobre la posición prestataria, y una vez terminado el período de gracia.

<a id="add-collateral"></a>

### Añadir garantía

Quien tiene la posición prestataria puede añadir garantía a un préstamo en curso desde su página. Añadir garantía sube el factor de salud del préstamo y baja su relación préstamo-valor, lo que lo aleja de la liquidación. Añades más del mismo token que el préstamo ya tiene: el protocolo no acepta otro, y solo acepta un aporte para una garantía que hoy tiene precio. Escribe la cantidad; el formulario muestra lo que tiene tu billetera.

La revisión muestra la garantía ahora y después, dónde se guarda (en tu bóveda, ligada al préstamo hasta que termine) y el factor de salud y la relación préstamo-valor del préstamo ahora. Tu billetera aprueba exactamente la cantidad si tu aprobación no la cubre ya, y la aplicación prueba antes el aporte como simulación. Después, la aplicación muestra el factor de salud y la relación préstamo-valor que el protocolo calcula tras el aporte. Añadir garantía sigue abierto aunque el protocolo esté en pausa. Un préstamo en fallback vuelve a estar en curso si el aporte restablece los límites de apertura del protocolo; si no, la garantía se añade y el préstamo sigue en fallback. La garantía que añades puede perderse con el resto si el préstamo se liquida o entra en impago. Si asumiste la posición prestataria y el préstamo está en fallback, el aporte va a la bóveda del prestatario que registra el préstamo y pasa a la tuya solo si devuelve el préstamo a curso.

<a id="take-back-collateral"></a>

### Retirar garantía

Mientras un préstamo está activo, quien tiene la posición de prestatario puede retirar, desde la página del préstamo, la garantía que supere lo que el préstamo necesita. El protocolo calcula el máximo de modo que el factor de salud se mantenga en el mínimo del préstamo o por encima y el préstamo sobre valor dentro de su límite de apertura. Ese límite cambia con los precios y a medida que se acumulan intereses, y el formulario lo muestra mientras escribe. Retirar garantía acerca el préstamo a la liquidación.

La revisión muestra la garantía ahora y después, que va de su bóveda a su billetera, el límite actual y el factor de salud y el préstamo sobre valor actuales. No hace falta aprobación, así que su billetera pide confirmar una vez, después de que la app pruebe el retiro en simulación. El protocolo vuelve a comprobar sus límites cuando el retiro se confirma: si los precios se movieron y el importe ya no cabe, se rechaza y no se mueve nada. Una pausa del protocolo, una orden de swap-to-repay pendiente, una solicitud de refinanciación vigente o una venta listada por el prestamista lo detiene, y el protocolo solo permite retirar garantía de un token al que pone precio. Si tu cuenta tiene activado el modo protegido, la garantía espera en su cola de pagos durante el retraso de la cuenta antes de llegar a tu cartera, y la revisión lo indica.

<a id="collect-a-payout"></a>

### Cobrar un pago

Cuando un préstamo termina, el protocolo registra lo que se debe a cada parte, y quien tiene cada posición lo cobra desde la página del préstamo o desde Reclamaciones. Paga a quien tiene la posición ahora, así que una posición que compraste te paga a ti. El pago del prestamista es el principal y los intereses, o lo que recuperó un impago o una liquidación, más los fondos retenidos para el prestamista y, en un alquiler, el NFT alquilado. El pago del prestatario es la garantía devuelta o lo que sobró, más el excedente retenido para el prestatario. Cobrar quema tu token de posición, y cuando ambas partes han cobrado, el préstamo queda liquidado.

La revisión enumera cada pago que hace la reclamación, lo que cobran primero los vendedores anteriores de una posición de prestamista (intereses ganados y no pagados) y adónde llega el pago: a tu billetera o, con el modo protegido activado, a la cola de pagos de tu cuenta o a tu bóveda. No hace falta ninguna aprobación, así que tu billetera pregunta una vez, después de que la app pruebe la reclamación en simulación. Una pausa del protocolo detiene toda reclamación. Mientras un préstamo está en fallback, el pago del prestatario espera a que el prestamista cobre, y ese cobro termina el fallback: el prestatario ya no puede subsanarlo. La tarjeta final muestra lo que la transacción pagó de verdad.

<a id="payout-queue"></a>

### Pagos en espera en tu cola

Con el modo protegido activado, todo lo que sale de tu bóveda hacia tu billetera espera el retraso de tu cuenta en una cola de pagos. Reclamaciones muestra lo que espera allí, primero lo más próximo, cada uno con un código de solicitud corto: cada alerta sobre un pago muestra el mismo código, así puedes relacionar un mensaje con una solicitud. Cada fila indica qué paga, adónde va y cuándo puede liberarse. Cuando un pago vence, cualquiera puede liberarlo, y solo paga al destino que registró; si ese destino ya no está permitido, liberarlo lo cancela. Tú, o uno de tus firmantes secundarios, puedes cancelar un pago en cualquier momento, incluso durante una pausa, y el activo se queda en tu bóveda. Si tu cuenta exige aprobación, un firmante secundario aprueba antes cada pago; un firmante encuentra tu cuenta en el modo avanzado pegando su dirección. Una pausa retiene las liberaciones hasta que termina o, tras una pausa larga, se abre su vía de escape. Cada acción pide a tu billetera una sola vez, y la tarjeta final muestra lo que hizo la transacción.

<a id="seller-interest"></a>

### Intereses de una posición que vendiste

Cuando vendes una posición de prestamista, los intereses que ganaste mientras la tenías y aún no cobraste siguen siendo tuyos como un derecho sobre el préstamo. Claims muestra cada préstamo en el que tienes ese derecho, con lo que se te debe tras la parte del protocolo en los intereses y lo que ya espera en tu bóveda. Mientras el préstamo sigue en curso, cada pago de intereses paga primero los derechos abiertos, el más antiguo primero, en la bóveda propia de cada vendedor; hasta que algo llega a la tuya no hay nada que retirar. Cuando el préstamo ha terminado, retirar primero reparte lo que recuperó el lado prestamista: primero el principal del titular, luego cada derecho de vendedor, el más antiguo primero. Entonces se cierran todos los derechos abiertos, y lo que un derecho no cobra queda sin pagar. Los préstamos se encuentran en el índice de la app; si no puede listarlos, busca un préstamo por su número, que se lee solo de la cadena. No hace falta ninguna aprobación, así que tu billetera pide una vez, tras una simulación, y la tarjeta final muestra lo que pagó la transacción.

<a id="frozen-proceeds"></a>

### Cuando un pago está congelado

Si el control de sanciones marca su billetera, el protocolo no toma nada de lo que se le debe y nunca impide que un préstamo se cierre: la otra parte igualmente recibe lo que recupera su lado. Su parte queda aparcada en una bóveda, bloqueada, y se libera cuando su billetera sale de la lista. Claims y la página del préstamo indican entonces «Congelado, a la espera de salir de la lista» y no ofrecen botón para cobrar. Si el control no puede leerse y su billetera fue confirmada como marcada antes, un pago congelado sigue bloqueado hasta que el control responda de nuevo, y un pago debido a su billetera en ese tiempo queda aparcado del mismo modo, porque el protocolo la sigue tratando como marcada; una caída por sí sola nunca congela una billetera que nunca fue confirmada como marcada. En un préstamo en curso, su página muestra además lo que el préstamo ya pagó y está reservado para la posición del prestamista hasta que este lo cobre, y un préstamo reembolsado indica cuándo espera un excedente que el prestatario aún no ha cobrado.

<a id="extension-reserves"></a>

### Reservas de extensión

Si tiene la posición del prestatario de un préstamo, puede apartar el token del préstamo en su propia bóveda para sus extensiones. Una extensión, la del keeper o la suya, toma primero de esa reserva. La reserva sigue siendo suya. Claims lista cada préstamo en el que le queda algo, e indica si una extensión aún puede tomar de ella: solo mientras el préstamo está en curso y usted tiene su posición del prestatario. Puede recuperar toda la reserva en cualquier momento mientras el protocolo no esté en pausa, sea cual sea el estado del préstamo; si el préstamo sigue en curso, su siguiente extensión toma entonces de su otro saldo del token. Los préstamos se encuentran en el índice de la app; si no puede listarlos, busque un préstamo por su número. No hace falta ninguna aprobación, así que su billetera pide una vez, tras una prueba, y la tarjeta final muestra adónde llegó el dinero.

<a id="risk-access"></a>

### Risk Access: tu nivel de riesgo

Toda cuenta empieza en el nivel de riesgo más bajo, solo activos blue-chip, y solo tú puedes subirlo. Un par necesita el nivel de su token más arriesgado: los tokens blue-chip no necesitan nada, otros tokens líquidos necesitan «Activos líquidos» y un token ilíquido necesita «Cualquier activo, incluidos los ilíquidos» más tu acuerdo con ese par exacto. Cuando aceptar una oferta o publicar una solicitud necesita un paso así, la revisión lo dice en el mismo lugar y lo ofrece como una sola confirmación en la billetera con su propio recibo: qué cambia, a qué pares alcanza, cuándo entra en vigor y que no se mueven fondos. Subir tu nivel, o aceptar un par, puede esperar un periodo que fija el protocolo; para un nivel subido la app muestra la hora en que entra en vigor, leída de la cadena; para un acuerdo dice que el protocolo aún no publica esa hora; y nunca ofrece el mismo paso dos veces, porque un segundo reiniciaría la espera. Bajar tu nivel siempre surte efecto al instante. Cuando el protocolo publica nuevos términos de riesgo, tu nivel y tus acuerdos dejan de contar hasta que los confirmes de nuevo. Si activaste el modo estricto, cada par líquido también necesita tu reconocimiento. Un bloqueo que viene del nivel de riesgo del prestamista se muestra como suyo: nada en tu cuenta lo cambiaría.

<a id="terms-gate"></a>

### El aviso de los Términos

Cuando hay una versión de los Términos del servicio vigente, la app te pide aceptarla antes de una acción que inicia algo nuevo, como activar el descuento en comisiones, y nombra la acción que lo pidió. Muestra la versión, una huella de su texto y un enlace a esa versión exacta, cuyo texto nunca cambia. Aceptar es una confirmación en la wallet y no mueve fondos. Si la app no puede leer si aceptaste, lo dice y te deja reintentar en lugar de tomarlo como un no. Repagar, cobrar, retirar tus propios activos, cancelar tus propias ofertas y desactivar un consentimiento nunca se bloquean.
