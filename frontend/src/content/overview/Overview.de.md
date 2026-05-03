# Willkommen bei Vaipakam

Vaipakam ist eine Peer-to-Peer-Kreditplattform. Sie verleihen
Vermögenswerte und verdienen Zinsen. Sie leihen sich Vermögenswerte
und hinterlegen Sicherheiten. Sie mieten NFTs, und der Eigentümer
erhält tägliche Mietzahlungen. Alles geschieht direkt zwischen zwei
Wallets, wobei die Smart Contracts die Vermögenswerte treuhänderisch
halten, bis der Kredit oder die Miete endet.

Diese Seite ist die **freundliche Einführung**. Wenn Sie mehr
technische Tiefe suchen, nutzen Sie den Tab **Benutzerhandbuch** für
Hilfe zu einzelnen Bildschirmen oder den Tab **Technisch** für das
vollständige Whitepaper. Wenn Sie einfach verstehen möchten, „was ist
das und wie nutze ich es" — lesen Sie weiter.

---

## Was Sie tun können

Vaipakam ist für vier Arten von Menschen:

- **Kreditgeber** — Sie haben einen Vermögenswert (USDC, ETH, USDT
  usw.), der ungenutzt herumliegt. Sie möchten, dass er Zinsen
  abwirft, ohne die Sicherheit aus der Hand zu geben. Sie veröffentlichen ein
  Kreditgeber-Angebot; ein Kreditnehmer akzeptiert; Sie verdienen
  Zinsen zu Ihren Konditionen.
- **Kreditnehmer** — Sie brauchen Bargeld für ein paar Tage, Wochen
  oder Monate und wollen Ihre Sicherheit nicht verkaufen (weil Sie
  glauben, sie steigt, oder weil es ein NFT ist, von dem Sie sich
  nicht trennen können). Sie hinterlegen Ihre Sicherheit; Sie
  erhalten den Kredit; Sie zahlen ihn zum vereinbarten Zinssatz
  zurück.
- **NFT-Eigentümer** — Sie haben ein wertvolles NFT, das einen
  Nutzen in einem Spiel oder einer App gewährt. Ein Verkauf würde
  bedeuten, diesen Nutzen dauerhaft aufzugeben. Eine Vermietung lässt
  jemand anderen es ein paar Tage nutzen, während Sie das Eigentum
  behalten und tägliche Miete kassieren.
- **NFT-Mieter** — Sie wollen vorübergehenden Zugang zu einem NFT
  (einem Spiel-Asset, einem Mitgliedsausweis, einer Domain) ohne
  den vollen Preis zu zahlen. Sie mieten es, nutzen es im
  Mietzeitraum, und der Eigentümer behält das Asset.

Sie melden sich nicht an. Sie füllen kein Profil aus. Sie verbinden
ein Wallet und können verleihen, leihen oder mieten.

---

## Wie ein Kredit funktioniert (konkretes Beispiel)

Angenommen, Sie haben **1.000 USDC** in Ihrem Wallet auf Base
liegen. Sie möchten Zinsen verdienen. Hier ist der vollständige
Lebenszyklus.

### Schritt 1 — Ein Angebot erstellen

Sie öffnen die Vaipakam-App, verbinden Ihr Wallet und klicken auf
**Angebot erstellen**. Sie sind Kreditgeber, also füllen Sie aus:

- Ich verleihe **1.000 USDC**
- Ich möchte **8 % APR**
- Akzeptable Sicherheit: **WETH**, mit **maximalem LTV von 70 %**
- Kreditlaufzeit: **30 Tage**

Sie unterschreiben eine Transaktion. Ihre 1.000 USDC wandern aus
Ihrem Wallet in Ihren **persönlichen Escrow** (einen
privaten Tresor, den nur Sie kontrollieren). Sie bleiben dort, bis
ein Kreditnehmer Ihr Angebot annimmt.

### Schritt 2 — Ein Kreditnehmer nimmt an

Vielleicht eine Stunde später sieht jemand anderes Ihr Angebot im
**Angebotsbuch**. Diese Person hat WETH und möchte USDC dagegen
einen Monat lang leihen. Sie klickt auf **Annehmen** und hinterlegt
WETH im Wert von, sagen wir, 1.500 $ (ein LTV von etwa 67 % — unter
Ihrer 70%-Grenze, also wird das Angebot angenommen).

In dem Moment, in dem die Annahme erfolgt:

- Ihre 1.000 USDC wandern aus Ihrem Escrow in den der
  anderen Person
- Deren WETH wird in deren Escrow als Sicherheit gesperrt
- Beide erhalten ein Positions-NFT — Ihres sagt „Mir werden 1.000
  USDC + Zinsen geschuldet"; das andere sagt „Mir wird mein WETH bei
  Rückzahlung geschuldet"
- Die Kreditlaufzeit-Uhr beginnt zu ticken

Eine kleine **Kreditinitiierungsgebühr (0,1 %)** wird vom verliehenen
Betrag abgezogen und an die Protokoll-Treasury weitergeleitet. Der
Kreditnehmer erhält also 999 USDC, nicht 1.000. (Sie können die
Gebühr stattdessen in **VPFI** zahlen, dann erhält der Kreditnehmer
die vollen 1.000 — mehr zu VPFI weiter unten.)

### Schritt 3 — Zeit vergeht; der Kreditnehmer zahlt zurück

Nach 30 Tagen schuldet Ihnen der Kreditnehmer den Hauptbetrag plus
Zinsen:

```
Zinsen = 1.000 USDC × 8 % × (30 / 365) = ~6,58 USDC
```

Er klickt auf **Zurückzahlen**, unterschreibt eine Transaktion, und
1.006,58 USDC fließen in die Kreditabwicklung. Daraus:

- Sie erhalten **1.005,51 USDC** (Hauptbetrag + Zinsen abzüglich
  einer Renditegebühr von 1 % nur auf den Zinsanteil)
- Die Treasury erhält **1,07 USDC** als Renditegebühr
- Das WETH des Kreditnehmers wird entsperrt

In Ihrem Dashboard sehen Sie einen **Beanspruchen**-Button. Sie
klicken, und die 1.005,51 USDC wandern aus der Abwicklung in Ihr
Wallet. Der Kreditnehmer klickt auf Beanspruchen und sein WETH
wandert in sein Wallet. Der Kredit ist abgeschlossen.

### Schritt 4 — Was, wenn der Kreditnehmer nicht zurückzahlt?

Zwei Dinge können schiefgehen, und das Protokoll behandelt jedes
automatisch.

**Der Sicherheitenpreis stürzt mitten im Kredit ab.** Vaipakam
verfolgt für jeden Kredit den **Health Factor** (eine einzelne Zahl,
die den Sicherheitenwert mit der Schuld vergleicht). Sinkt er unter
1,0, kann jeder — ja, jeder, einschließlich eines vorbeikommenden
Bots — **Liquidieren** auslösen. Das Protokoll routet die Sicherheit
durch bis zu vier DEX-Aggregatoren (0x, 1inch, Uniswap, Balancer),
nimmt die beste Ausführung, zahlt Ihnen, was Ihnen zusteht, gibt
dem Liquidator einen kleinen Bonus, und gibt jeden Rest an den
Kreditnehmer zurück.

**Der Kreditnehmer verschwindet nach dem Fälligkeitsdatum.** Nach
einer konfigurierbaren **Karenzzeit** (eine Stunde für kurze
Kredite, zwei Wochen für einjährige Kredite), kann jeder **Default**
auslösen. Derselbe Liquidationspfad läuft.

In seltenen Fällen — jeder Aggregator gibt einen schlechten Preis
zurück, oder die Sicherheit ist stark gefallen — *weigert sich* das
Protokoll, in einen schlechten Markt zu verkaufen. Stattdessen
erhalten Sie die Sicherheit selbst plus eine kleine Prämie und
können sie behalten oder verkaufen, wann Sie wollen. Dieser
**Fallback-Pfad** ist im Voraus dokumentiert und Sie akzeptieren ihn
als Teil der Kreditbedingungen.

### Schritt 5 — Jeder kann zurückzahlen

Wenn ein Freund oder ein delegierter Keeper den Kredit Ihres
Kreditnehmers begleichen will, kann er das. Die Sicherheit geht
dennoch an den Kreditnehmer zurück (nicht an den hilfsbereiten
Dritten). Es ist eine Einbahnstraße: für jemand anderen den Kredit
zu zahlen, gibt Ihnen nicht dessen Sicherheit.

---

## Wie NFT-Mieten funktionieren

Gleicher Ablauf wie ein Kredit, mit zwei Unterschieden:

- **Das NFT bleibt im Escrow**; der Mieter hält es nie
  direkt. Stattdessen verwendet das Protokoll **ERC-4907**, um dem
  Mieter „Nutzungsrechte" am NFT für das Mietfenster zu geben.
  Kompatible Spiele und Apps lesen Nutzungsrechte, also kann der
  Mieter spielen, sich anmelden oder den Nutzen des NFTs nutzen,
  ohne es zu besitzen.
- **Tägliche Gebühren werden automatisch abgezogen** aus einem
  vorausbezahlten Pool. Der Mieter zahlt die gesamte Miete im
  Voraus plus 5 % Puffer. Jeden Tag gibt das Protokoll die Gebühr
  des Tages an den Eigentümer frei. Will der Mieter früher beenden,
  werden die ungenutzten Tage erstattet.

Wenn die Miete endet (durch Ablauf oder Default), kehrt das NFT in
den Escrow des Eigentümers zurück. Der Eigentümer kann
es dann erneut listen oder zurück in sein Wallet beanspruchen.

---

## Was schützt mich?

Verleihen und Leihen auf Vaipakam ist nicht risikofrei. Aber das
Protokoll hat mehrere eingebaute Schichten:

- **Escrow pro Nutzer.** Ihre Vermögenswerte liegen in
  Ihrem eigenen Tresor. Das Protokoll bündelt sie nie mit Mitteln
  anderer Nutzer. Das bedeutet, ein Bug, der einen anderen Nutzer
  betrifft, kann Sie nicht leerräumen.
- **Health Factor-Durchsetzung.** Ein Kredit kann nur starten, wenn
  die Sicherheit mindestens das 1,5-fache des Kreditwertes bei der
  Erstellung wert ist. Bewegt sich der Preis mitten im Kredit gegen
  den Kreditnehmer, kann jeder liquidieren, bevor die Sicherheit
  weniger als die Schuld wert ist — was den Kreditgeber schützt.
- **Preisorakel aus mehreren Quellen.** Preise kommen zuerst von Chainlink
  und werden anschließend mit Tellor, API3 und DIA abgeglichen. Wenn sie über
  einer konfigurierten Schwelle abweichen, kann der Kredit nicht
  geöffnet und eine laufende Position nicht unfair liquidiert
  werden. Ein Angreifer müsste **mehrere unabhängige Orakel im
  selben Block** korrumpieren, um einen Preis zu fälschen.
- **Slippage-Obergrenze.** Liquidationen weigern sich, die
  Sicherheit mit mehr als 6 % Slippage zu verkaufen. Wenn der Markt
  zu dünn ist, fällt das Protokoll darauf zurück, Ihnen die
  Sicherheit direkt zu geben.
- **Berücksichtigung des L2-Sequencers.** Auf L2-Chains pausiert die
  Liquidation kurz, wenn der Sequencer der Chain gerade aus einer
  Ausfallzeit zurückkehrt, damit Angreifer das Stale-Price-Fenster
  nicht zu Ihrem Schaden ausnutzen können.
- **Pause-Schalter.** Jeder Vertrag hat Notfallhebel, sodass
  der Operator neue Geschäfte in Sekunden stoppen kann, wenn etwas
  nicht stimmt, während bestehende Nutzer ihre Positionen sicher
  abwickeln können.
- **Unabhängige Audits.** Jeder Vertrag auf jeder Chain geht erst
  nach Drittanbieter-Sicherheitsprüfung live. Audit-Berichte und
  Bug-Bounty-Umfang sind öffentlich.

Sie sollten dennoch verstehen, worauf Sie sich einlassen. Lesen Sie
die kombinierte **Risikozustimmung**, die vor jedem Kredit
erscheint — sie erklärt den Fallback-Pfad bei abnormalem Markt und den
Sachabwicklungspfad bei illiquiden Sicherheiten. Die App lässt Sie
nicht annehmen, bis Sie das Zustimmungskästchen ankreuzen.

---

## Was kostet es?

Zwei Gebühren, beide klein:

- **Renditegebühr — `{liveValue:treasuryFeeBps}` %** der **Zinsen**,
  die Sie als Kreditgeber verdienen (nicht des Hauptbetrags). Bei
  einem 30-Tage-Kredit zu 8 % APR über 1.000 USDC verdient der
  Kreditgeber ~6,58 USDC Zinsen, davon sind ~0,066 USDC die
  Renditegebühr beim Standard-Satz.
- **Kreditinitiierungsgebühr — `{liveValue:loanInitiationFeeBps}` %**
  des Verleihbetrags, vom Kreditnehmer bei der Erstellung gezahlt.
  Bei einem 1.000-USDC-Kredit sind das 1 USDC beim Standard-Satz.

Beide Gebühren können um **bis zu `{liveValue:tier4DiscountBps}` %
rabattiert** werden, indem Sie VPFI im Escrow halten (siehe unten).
Bei Default oder Liquidation wird keine Renditegebühr auf
zurückgewonnene Zinsen erhoben — das Protokoll profitiert nicht von
einem gescheiterten Kredit.

Es gibt keine Auszahlungsgebühren, keine Inaktivitätsgebühren,
keine Streaming-Gebühren, keine „Performance"-Gebühren auf den
Hauptbetrag. Das einzige Geld, das das Protokoll nimmt, sind die
zwei Zahlen oben.

> **Hinweis zur Blockchain-Netzwerkgebühr (Gas).** Wenn Sie ein
> Angebot erstellen, einen Kredit annehmen, zurückzahlen, einen
> Anspruch geltend machen oder eine andere On-Chain-Aktion
> durchführen, zahlen Sie zusätzlich eine kleine **Netzwerkgebühr
> (Gas)** an die Validatoren der Blockchain, die Ihre Transaktion in
> einen Block aufnehmen. Diese Gas-Gebühr geht ans Netzwerk —
> **nicht an Vaipakam**. Es ist dieselbe Gebühr, die Sie beim Senden
> jedes anderen Tokens auf derselben Chain zahlen würden. Der Betrag
> hängt von der Chain und der Netzwerk-Auslastung im Moment ab,
> nicht von der Größe Ihres Kredits. Die obigen Protokollgebühren
> (Renditegebühr `{liveValue:treasuryFeeBps}` %,
> Kreditinitiierungsgebühr `{liveValue:loanInitiationFeeBps}` %)
> sind vollständig getrennt vom Netzwerk-Gas und die einzigen, die
> das Protokoll selbst erhebt.

---

## Was ist VPFI?

**VPFI** ist Vaipakams Utility-Token. Er erfüllt drei Aufgaben:

### 1. Gebührenrabatte

Wenn Sie VPFI in Ihrem Escrow auf einer Chain halten,
rabattiert das Ihre Protokollgebühren auf Krediten, an denen Sie
auf dieser Chain teilnehmen:

| VPFI im Escrow | Gebührenrabatt |
|---|---|
| `{liveValue:tier1Min}` – `{liveValue:tier2Min}` (excl.) | `{liveValue:tier1DiscountBps}` % |
| `{liveValue:tier2Min}` – `{liveValue:tier3Min}` (excl.) | `{liveValue:tier2DiscountBps}` % |
| `{liveValue:tier3Min}` – `{liveValue:tier4Min}` | `{liveValue:tier3DiscountBps}` % |
| Über `{liveValue:tier4Min}` | `{liveValue:tier4DiscountBps}` % |

Rabatte gelten sowohl für Kreditgeber- als auch für Kreditnehmer-
Gebühren. Der Rabatt ist **zeitgewichtet über die Lebensdauer des
Kredits**, also manipuliert Aufladen kurz vor Kreditende die
Berechnung nicht — Sie verdienen den Rabatt anteilig zur Zeit, in
der Sie tatsächlich die Stufe gehalten haben.

### 2. Staking — 5 % APR

Jedes VPFI im Escrow verdient automatisch Staking-
Belohnungen mit 5 % Jahresrendite. Es gibt keine separate Staking-
Aktion, keine Sperrfrist, keine Wartezeit zum „Unstake". Verschieben
Sie VPFI in Ihren Escrow und es verdient ab diesem
Moment. Verschieben Sie es heraus und die Akkumulation hört auf.

### 3. Plattform-Interaktionsbelohnungen

Jeden Tag wird ein fester Pool von VPFI an Kreditgeber und
Kreditnehmer ausgeschüttet, anteilig zu den **Zinsen**, die durch
das Protokoll bewegt wurden. Sie erhalten einen Anteil, wenn Sie
als Kreditgeber Zinsen verdient haben oder als Kreditnehmer Zinsen
sauber bezahlt haben (ohne Verzugsgebühren, ohne Default).

Der Belohnungspool ist in den ersten sechs Monaten am größten und
nimmt über sieben Jahre ab. Frühe Nutzer erhalten die größten
Emissionen.

### Wie man VPFI bekommt

Drei Wege:

- **Verdienen** — durch Teilnahme (Interaktionsbelohnungen oben).
- **Kaufen** — zum Festpreis (`1 VPFI = 0,001 ETH`) auf der Seite
  **VPFI kaufen**. Das Festpreisprogramm ist pro Wallet pro Chain
  gedeckelt.
- **Bridgen** — VPFI ist ein LayerZero OFT V2-Token, also bewegt
  er sich zwischen unterstützten Chains über die offizielle Bridge.

---

## Welche Chains?

Vaipakam läuft als unabhängige Bereitstellung auf jeder
unterstützten Chain: **Ethereum**, **Base**, **Arbitrum**,
**Optimism**, **Polygon zkEVM**, **BNB Chain**.

Ein auf Base eröffneter Kredit wird auf Base abgewickelt. Ein auf
Arbitrum eröffneter Kredit wird auf Arbitrum abgewickelt. Es gibt
keine Cross-Chain-Schuld. Das Einzige, was Chains überquert, ist
der VPFI-Token und der tägliche Belohnungs-Nenner (der
sicherstellt, dass Belohnungen zwischen geschäftigen und ruhigen
Chains fair sind).

---

## Wo anfangen

Wenn Sie **verleihen** wollen:

1. Öffnen Sie die Vaipakam-App, verbinden Sie Ihr Wallet.
2. Gehen Sie zu **Angebot erstellen**, wählen Sie „Kreditgeber".
3. Setzen Sie Ihren Vermögenswert, Betrag, APR, akzeptierte
   Sicherheit und Laufzeit.
4. Unterschreiben Sie zwei Transaktionen (eine Genehmigung, eine
   Erstellung) und Ihr Angebot ist live.
5. Warten Sie, bis ein Kreditnehmer annimmt. Das Dashboard zeigt
   Ihre aktiven Kredite.

Wenn Sie **leihen** wollen:

1. Öffnen Sie die App, verbinden Sie Ihr Wallet.
2. Durchsuchen Sie das **Angebotsbuch** nach einem Angebot, das zu
   Ihrer Sicherheit und dem APR passt, den Sie zahlen können.
3. Klicken Sie auf **Annehmen**, unterschreiben Sie zwei
   Transaktionen, und Sie erhalten den Kreditbetrag in Ihrem Wallet
   (abzüglich der 0,1%-Kreditinitiierungsgebühr).
4. Zahlen Sie vor dem Fälligkeitsdatum plus Karenzzeit zurück. Ihre
   Sicherheit wird zurück in Ihr Wallet entsperrt.

Wenn Sie ein NFT **mieten oder listen** wollen:

Gleicher Ablauf, aber auf der Seite **Angebot erstellen** wählen
Sie „NFT-Miete" statt ERC-20-Verleihen. Das Formular wird Sie
führen.

Wenn Sie nur **passive Rendite auf Ihre VPFI** verdienen wollen,
hinterlegen Sie sie in Ihrem Escrow auf der **Dashboard**-
Seite. Das ist alles — Staking ist ab diesem Moment automatisch.

---

## Eine Anmerkung dazu, was wir *nicht* tun

Ein paar Dinge, die andere DeFi-Plattformen tun, die wir bewusst
**nicht** tun:

- **Kein gepooltes Verleihen.** Jeder Kredit ist zwischen zwei
  spezifischen Wallets mit Bedingungen, denen sie beide zugestimmt
  haben. Kein gemeinsamer Liquiditätspool, keine Auslastungskurve,
  keine überraschenden Zinsspitzen.
- **Keine Proxy-Verwahrung.** Ihre Vermögenswerte liegen in Ihrem
  eigenen Escrow, nicht in einem gemeinsamen Tresor. Das
  Protokoll bewegt sie nur bei Aktionen, die Sie unterschreiben.
- **Keine Hebelschleifen standardmäßig.** Sie können geliehene
  Mittel als neues Kreditgeber-Angebot erneut ausschreiben, wenn Sie
  möchten, aber das Protokoll integriert kein automatisches Looping
  in die UX. Wir halten das für eine leicht auslösbare Falle.
- **Keine Überraschungs-Upgrades.** Escrow-Upgrades sind
  kontrolliert; verpflichtende Upgrades erscheinen in der App,
  damit Sie sie explizit anwenden. Nichts schreibt Ihren Tresor
  hinter Ihrem Rücken um.

---

## Mehr brauchen?

- Der Tab **Benutzerhandbuch** geht Bildschirm für Bildschirm durch
  die App, Karte für Karte. Gut für „was macht dieser Knopf?"-
  Fragen.
- Der Tab **Technisch** ist das vollständige Whitepaper. Gut für
  „wie funktioniert die Liquidations-Engine eigentlich?"-Fragen.
- Die **FAQ**-Seite bearbeitet die häufigsten Einzeiler.
- Discord und das GitHub-Repo sind beide aus dem App-Footer
  verlinkt.

Das ist Vaipakam. Verbinden Sie ein Wallet und Sie sind drin.
