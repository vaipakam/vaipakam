# Bienvenido a Vaipakam

Vaipakam es una plataforma de préstamos entre pares. Tú prestas
activos y ganas intereses. Tomas prestados activos y aportas garantía.
Alquilas NFTs y el propietario recibe pagos diarios. Todo ocurre
directamente entre dos billeteras, con los contratos inteligentes
custodiando los activos hasta que termina el préstamo o el alquiler.

Esta página es el **recorrido amigable**. Si quieres profundidad
técnica, usa la pestaña **Guía de usuario** para ayuda por pantalla,
o la pestaña **Técnico** para el whitepaper completo. Si solo quieres
saber "qué es esto y cómo lo uso" — sigue leyendo.

---

## Lo que puedes hacer

Vaipakam es para cuatro tipos de personas:

- **Prestamistas** — tienes un activo (USDC, ETH, USDT, etc.) sin uso.
  Te gustaría que generara intereses sin perder seguridad. Publicas
  una oferta de prestamista; un prestatario la acepta; ganas
  intereses según tus condiciones.
- **Prestatarios** — necesitas efectivo durante unos días, semanas o
  meses y no quieres vender tu garantía (porque crees que va a subir,
  o porque es un NFT del que no puedes desprenderte). Aportas tu
  garantía; recibes el préstamo; lo devuelves a la tasa acordada.
- **Propietarios de NFT** — tienes un NFT valioso que otorga utilidad
  dentro de un juego o una app. Venderlo significaría perder esa
  utilidad para siempre. Alquilarlo permite que otra persona lo use
  unos días mientras tú conservas la propiedad y cobras la renta
  diaria.
- **Inquilinos de NFT** — quieres acceso temporal a un NFT (un
  artículo de juego, un pase de membresía, un dominio) sin pagar el
  precio completo. Lo alquilas, lo usas durante el periodo, y el
  propietario conserva el activo.

No te registras. No rellenas un perfil. Conectas una billetera y
puedes prestar, pedir prestado o alquilar.

---

## Cómo funciona un préstamo (ejemplo concreto)

Supongamos que tienes **1.000 USDC** parados en tu billetera en Base.
Te gustaría ganar intereses. Aquí está el ciclo completo.

### Paso 1 — Crear una oferta

Abres la app de Vaipakam, conectas tu billetera y haces clic en
**Crear oferta**. Eres prestamista, así que rellenas:

- Estoy prestando **1.000 USDC**
- Quiero **8% APR**
- Garantía aceptable: **WETH**, con **LTV máximo del 70%**
- Duración del préstamo: **30 días**

Firmas una transacción. Tus 1.000 USDC se mueven de tu billetera a
tu **escrow personal** (una bóveda privada que solo tú controlas).
Permanecen ahí hasta que un prestatario acepte tu oferta.

### Paso 2 — Un prestatario acepta

Tal vez una hora después, otra persona ve tu oferta en el **Libro
de ofertas**. Tiene WETH y quiere pedir prestado USDC contra él
durante un mes. Hace clic en **Aceptar** y aporta WETH por valor,
digamos, de 1.500 $ (un LTV de aproximadamente 67% — por debajo de
tu límite del 70%, así que la oferta se acepta).

En el momento que acepta:

- Tus 1.000 USDC se mueven de tu escrow al suyo
- Su WETH queda bloqueado en su escrow como garantía
- Ambos recibís un NFT de posición — el tuyo dice "Se me deben 1.000
  USDC + intereses"; el suyo dice "Se me debe mi WETH cuando pague"
- El cronómetro del préstamo empieza a correr

Una pequeña **Comisión de iniciación del préstamo (0,1%)** se toma
del importe prestado y se envía al tesoro del protocolo. Así que el
prestatario recibe 999 USDC, no 1.000. (Puedes pagar la comisión en
**VPFI** y entonces el prestatario recibe los 1.000 completos —
más sobre VPFI más abajo.)

### Paso 3 — Pasa el tiempo; el prestatario devuelve

Tras 30 días, el prestatario te debe el principal más los intereses:

```
Intereses = 1.000 USDC × 8% × (30 / 365) = ~6,58 USDC
```

Hace clic en **Devolver**, firma una transacción, y 1.006,58 USDC
entran en la liquidación del préstamo. De ahí:

- Tú recibes **1.005,51 USDC** (principal + intereses menos una
  Comisión sobre Rendimiento del 1% sobre la parte de intereses
  únicamente)
- El tesoro recibe **1,07 USDC** como Comisión sobre Rendimiento
- El WETH del prestatario se desbloquea

En tu panel ves un botón **Reclamar**. Al hacer clic, los 1.005,51
USDC se mueven de la liquidación a tu billetera. El prestatario hace
clic en reclamar y su WETH vuelve a su billetera. El préstamo se
cierra.

### Paso 4 — ¿Y si el prestatario no devuelve?

Dos cosas pueden salir mal, y el protocolo gestiona cada una de
forma automática.

**El precio de la garantía se desploma a mitad del préstamo.**
Vaipakam rastrea el **Factor de Salud** de cada préstamo (un único
número que compara el valor de la garantía con la deuda). Si cae por
debajo de 1,0, cualquiera — sí, cualquiera, incluido un bot que
pase por allí — puede llamar a **Liquidar**. El protocolo enruta la
garantía a través de hasta cuatro agregadores DEX (0x, 1inch,
Uniswap, Balancer), toma la mejor ejecución, te paga lo que se te
debe, da una pequeña bonificación al liquidador y devuelve cualquier
sobrante al prestatario.

**El prestatario desaparece después de la fecha de vencimiento.**
Tras un **periodo de gracia** configurable (una hora para préstamos
cortos, dos semanas para los de un año), cualquiera puede llamar a
**Default**. Se ejecuta el mismo proceso de liquidación.

En casos raros — todos los agregadores devuelven un mal precio, o
la garantía ha caído mucho — el protocolo *se niega a vender* en un
mal mercado. En su lugar, recibes la propia garantía más una pequeña
prima, y puedes conservarla o venderla cuando elijas. Esta **vía de
respaldo** está documentada por adelantado y la aceptas como parte
de las condiciones del préstamo.

### Paso 5 — Cualquiera puede pagar

Si un amigo o un keeper delegado quiere saldar el préstamo de tu
prestatario, puede hacerlo. La garantía sigue volviendo al
prestatario (no al tercero servicial). Es una puerta de un solo
sentido: pagar el préstamo de otra persona no te da su garantía.

---

## Cómo funcionan los alquileres de NFT

Mismo flujo que un préstamo, con dos diferencias:

- **El NFT permanece en escrow**; el inquilino nunca lo tiene
  directamente. En su lugar, el protocolo usa **ERC-4907** para dar
  al inquilino "derechos de uso" sobre el NFT durante la ventana
  de alquiler. Los juegos y apps compatibles leen los derechos de
  uso, así que el inquilino puede jugar, iniciar sesión o usar la
  utilidad del NFT sin poseerlo.
- **Las comisiones diarias se descuentan automáticamente** de un
  fondo prepagado. El inquilino paga todo el alquiler por adelantado
  más un 5% de margen. Cada día el protocolo libera la comisión de
  ese día al propietario. Si el inquilino quiere terminar antes,
  los días no usados se reembolsan.

Cuando el alquiler termina (por vencimiento o por incumplimiento),
el NFT vuelve al escrow del propietario. El propietario puede
entonces volver a listarlo o reclamarlo de vuelta a su billetera.

---

## ¿Qué me protege?

Prestar y pedir prestado en Vaipakam no está libre de riesgo. Pero
el protocolo tiene varias capas integradas:

- **Escrow por usuario.** Tus activos están en tu propia bóveda.
  El protocolo nunca los junta con los fondos de otros usuarios.
  Esto significa que un fallo que afecte a otro usuario no puede
  drenarte.
- **Aplicación del Factor de Salud.** Un préstamo solo puede
  iniciarse si la garantía vale al menos 1,5× el valor del préstamo
  en el origen. Si el precio se mueve en contra del prestatario a
  mitad del préstamo, cualquiera puede liquidar antes de que la
  garantía valga menos que la deuda — protegiendo al prestamista.
- **Oráculo de precios multi-fuente.** Los precios vienen primero
  de Chainlink, y luego se contrastan con Tellor, API3 y DIA. Si
  difieren más allá de un umbral configurado, el préstamo no puede
  abrirse y una posición existente no puede liquidarse de forma
  injusta. Un atacante necesitaría corromper **varios oráculos
  independientes en el mismo bloque** para falsear un precio.
- **Tope de slippage.** Las liquidaciones rechazan vender la
  garantía con peor de un 6% de slippage. Si el mercado es
  demasiado fino, el protocolo pasa a darte la garantía
  directamente.
- **Conciencia del secuenciador L2.** En cadenas L2, la liquidación
  se pausa brevemente cuando el secuenciador de la cadena acaba de
  recuperarse, para que los atacantes no puedan usar la ventana de
  precio obsoleto para perjudicarte.
- **Interruptores de pausa.** Cada contrato tiene palancas de pausa
  de emergencia para que el operador pueda detener nuevas
  operaciones en segundos si algo no parece bien, mientras los
  usuarios existentes pueden cerrar sus posiciones de forma
  segura.
- **Auditorías independientes.** Cada contrato en cada cadena se
  publica solo después de revisión de seguridad por terceros. Los
  informes de auditoría y el alcance del bug bounty son públicos.

Aún así deberías entender en qué te estás metiendo. Lee el
**consentimiento de riesgos** combinado que aparece antes de cada
préstamo — explica la vía de respaldo en mercado anormal y la vía
de liquidación en especie para garantías ilíquidas. La app no te
dejará aceptar hasta marcar la casilla de consentimiento.

---

## ¿Cuánto cuesta?

Dos comisiones, ambas pequeñas:

- **Comisión sobre Rendimiento — 1%** de los **intereses** que ganas
  como prestamista (no 1% del principal). En un préstamo a 30 días
  al 8% APR de 1.000 USDC, el prestamista gana ~6,58 USDC de
  intereses, de los cuales ~0,066 USDC son la Comisión sobre
  Rendimiento.
- **Comisión de Iniciación del Préstamo — 0,1%** del importe
  prestado, pagada por el prestatario en el origen. En un préstamo
  de 1.000 USDC, eso es 1 USDC.

Ambas comisiones pueden tener un **descuento de hasta el 24%**
manteniendo VPFI en escrow (ver más abajo). En caso de
incumplimiento o liquidación, no se cobra Comisión sobre Rendimiento
sobre los intereses recuperados — el protocolo no se beneficia de un
préstamo fallido.

No hay comisiones de retirada, ni comisiones por inactividad, ni
comisiones de streaming, ni comisiones de "rendimiento" sobre el
principal. El único dinero que toma el protocolo son los dos números
de arriba.

---

## ¿Qué es VPFI?

**VPFI** es el token de utilidad de Vaipakam. Hace tres cosas:

### 1. Descuentos en comisiones

Si mantienes VPFI en tu escrow en una cadena, eso descuenta tus
comisiones de protocolo en los préstamos en los que participes en
esa cadena:

| VPFI en escrow | Descuento de comisión |
|---|---|
| 100 – 999 | 10% |
| 1.000 – 4.999 | 15% |
| 5.000 – 20.000 | 20% |
| Por encima de 20.000 | 24% |

Los descuentos se aplican tanto a las comisiones del prestamista
como del prestatario. El descuento es **ponderado en el tiempo a lo
largo de la vida del préstamo**, así que recargar justo antes de que
acabe un préstamo no manipula el cálculo — ganas el descuento en
proporción al tiempo que efectivamente mantuviste el nivel.

### 2. Staking — 5% APR

Cualquier VPFI en tu escrow gana automáticamente recompensas de
staking al 5% anual. No hay una acción de staking aparte, ni
bloqueo, ni espera para retirar. Mueve VPFI a tu escrow y gana desde
ese momento. Sácalo y la acumulación se detiene.

### 3. Recompensas por interacción en la plataforma

Cada día se distribuye un fondo fijo de VPFI a prestamistas y
prestatarios proporcional a los **intereses** movidos por el
protocolo. Ganas una parte si ganaste intereses como prestamista, o
si pagaste intereses limpiamente como prestatario (sin
comisiones por demora, sin incumplimiento).

El fondo de recompensas es mayor en los primeros seis meses y
disminuye a lo largo de siete años. Los primeros usuarios reciben
las mayores emisiones.

### Cómo conseguir VPFI

Tres caminos:

- **Ganarlo** — participando (recompensas por interacción arriba).
- **Comprarlo** — a tasa fija (`1 VPFI = 0,001 ETH`) en la página
  **Comprar VPFI**. El programa de tasa fija tiene tope por
  billetera por cadena.
- **Hacer puente** — VPFI es un token LayerZero OFT V2, así que se
  mueve entre cadenas compatibles usando el puente oficial.

---

## ¿Qué cadenas?

Vaipakam funciona como un despliegue independiente en cada cadena
compatible: **Ethereum**, **Base**, **Arbitrum**, **Optimism**,
**Polygon zkEVM**, **BNB Chain**.

Un préstamo abierto en Base se liquida en Base. Un préstamo abierto
en Arbitrum se liquida en Arbitrum. No hay deuda multi-cadena. Lo
único que cruza cadenas es el token VPFI y el denominador diario de
recompensas (que asegura que las recompensas sean justas entre
cadenas activas y tranquilas).

---

## Por dónde empezar

Si quieres **prestar**:

1. Abre la app de Vaipakam, conecta tu billetera.
2. Ve a **Crear oferta**, elige "Prestamista".
3. Define tu activo, importe, APR, garantía aceptada y duración.
4. Firma dos transacciones (una aprobación, una creación) y tu
   oferta queda activa.
5. Espera a que un prestatario acepte. El panel muestra tus
   préstamos activos.

Si quieres **pedir prestado**:

1. Abre la app, conecta tu billetera.
2. Recorre el **Libro de ofertas** en busca de una oferta que
   coincida con tu garantía y el APR que puedes pagar.
3. Haz clic en **Aceptar**, firma dos transacciones, y recibes el
   importe del préstamo en tu billetera (menos la Comisión de
   Iniciación del 0,1%).
4. Devuelve antes de la fecha de vencimiento más el periodo de
   gracia. Tu garantía vuelve a tu billetera.

Si quieres **alquilar o listar un NFT**:

Mismo flujo, pero en la página **Crear oferta** eliges "Alquiler de
NFT" en lugar de préstamo ERC-20. El formulario te guía.

Si solo quieres **ganar rendimiento pasivo sobre tu VPFI**, deposítalo
en tu escrow en la página de **Panel**. Eso es todo — el staking es
automático desde ese momento.

---

## Una nota sobre lo que *no* hacemos

Algunas cosas que otras plataformas DeFi sí hacen y nosotros
deliberadamente **no**:

- **Sin préstamos pooleados.** Cada préstamo es entre dos billeteras
  específicas con condiciones que ambas firmaron. Sin pool de
  liquidez compartido, sin curva de utilización, sin picos
  sorpresivos de tasa.
- **Sin custodia por proxy.** Tus activos están en tu propio escrow,
  no en una bóveda compartida. El protocolo solo los mueve con las
  acciones que firmas.
- **Sin bucles de apalancamiento por defecto.** Puedes retransmitir
  los fondos prestados como nueva oferta de prestamista si quieres,
  pero el protocolo no integra el bucle automático en la UX.
  Pensamos que es un footgun.
- **Sin actualizaciones sorpresa.** Las actualizaciones del escrow
  están limitadas; las actualizaciones obligatorias aparecen en la
  app para que las apliques explícitamente. Nada reescribe tu
  bóveda a tus espaldas.

---

## ¿Necesitas más?

- La pestaña **Guía de usuario** recorre cada pantalla de la app
  tarjeta por tarjeta. Buena para preguntas tipo "¿qué hace este
  botón?".
- La pestaña **Técnico** es el whitepaper completo. Buena para
  preguntas tipo "¿cómo funciona realmente el motor de
  liquidación?".
- La página **FAQ** atiende las preguntas más comunes de una sola
  línea.
- El Discord y el repo de GitHub están enlazados desde el pie de la
  app.

Eso es Vaipakam. Conecta una billetera y estás dentro.
