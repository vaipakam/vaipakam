# Vaipakam — Guide utilisateur (Mode Basique)

Explications claires et accessibles de chaque carte de l'application.
Chaque section correspond à une icône d'information `(i)` à côté du
titre d'une carte.

> **Vous lisez la version Basique.** Elle correspond au mode
> **Basique** de l'app (la vue plus simple, avec moins de contrôles
> et des valeurs par défaut plus sûres). Pour une présentation plus
> technique et détaillée, basculez l'app en mode **Avancé** —
> ouvrez les Paramètres (icône d'engrenage en haut à droite) →
> **Mode** → **Avancé**. Les liens « En savoir plus » (i) dans l'app
> ouvriront alors le guide Avancé.

---

## Tableau de bord

<a id="dashboard.your-escrow"></a>

### Votre Escrow

Considère ton **escrow** comme ton coffre-fort privé à l'intérieur de
Vaipakam. C'est un petit contrat que toi seul contrôles. Chaque fois
que tu participes à un prêt — soit en déposant un collatéral, soit en
prêtant un actif — les actifs passent de ton wallet vers ce coffre.
Ils ne sont jamais mélangés à l'argent de quelqu'un d'autre. Quand le
prêt se termine, tu les récupères directement.

Tu n'as pas besoin de "créer" un escrow toi-même ; l'application en
crée un la première fois que tu en as besoin. Une fois qu'il existe,
il reste comme ton emplacement dédié sur cette chaîne.

<a id="dashboard.your-loans"></a>

### Vos prêts

Chaque prêt auquel tu participes sur cette chaîne apparaît ici — que
tu sois le prêteur (celui qui dépose l'actif à prêter) ou
l'emprunteur (celui qui l'a pris). Chaque ligne est une position.
Clique dessus et tu obtiens le tableau complet : la santé du prêt,
ce qui est verrouillé en collatéral, l'intérêt accumulé, et les
boutons pour rembourser, réclamer ou liquider le moment venu.

Si un prêt couvre les deux rôles (tu as prêté sur l'un, emprunté sur
un autre), les deux apparaissent — même endroit, lignes différentes.

<a id="dashboard.vpfi-panel"></a>

### VPFI sur cette chaîne

**VPFI** est le token natif du protocole. En détenir dans ton escrow
te donne une remise sur les frais du protocole et te génère un petit
rendement passif (5% APR). Cette carte t'indique, sur la chaîne à
laquelle tu es connecté :

- Combien de VPFI se trouvent dans ton wallet en ce moment.
- Combien sont dans ton escrow (ce qui compte comme "staké").
- Quelle part de l'offre totale de VPFI tu détiens.
- Combien de VPFI il reste à minter au total (le protocole a un
  plafond strict).

Vaipakam fonctionne sur plusieurs chaînes. L'une d'elles (Base) est
la chaîne **canonique** où les nouveaux VPFI sont mintés ; les
autres sont des **mirrors** qui détiennent des copies maintenues
synchronisées via un pont cross-chain. De ton point de vue, tu n'as
pas à y penser — le solde que tu vois est réel sur n'importe quelle
chaîne où tu te trouves.

<a id="dashboard.fee-discount-consent"></a>

### Consentement à la remise sur frais

Vaipakam peut te verser une remise sur les frais du protocole en
utilisant une partie des VPFI que tu as garés en escrow. Cet
interrupteur est le "oui, fais-le". Tu ne le bascules qu'une fois.

L'ampleur de la remise dépend de la quantité de VPFI que tu gardes en
escrow :

- **Tier 1** — 100 VPFI ou plus → 10% de remise
- **Tier 2** — 1 000 VPFI ou plus → 15% de remise
- **Tier 3** — 5 000 VPFI ou plus → 20% de remise
- **Tier 4** — plus de 20 000 VPFI → 24% de remise

Tu peux désactiver l'interrupteur à tout moment. Si tu retires des
VPFI de ton escrow, ton tier baisse en temps réel.

---

## Carnet d'offres

<a id="offer-book.filters"></a>

### Filtres

Les listes de marché peuvent être longues. Les filtres les
restreignent par actif concerné par le prêt, par nature de l'offre
(prêteur ou emprunteur), et selon quelques autres axes. Tes propres
offres actives restent toujours visibles en haut de la page — les
filtres n'affectent que ce que les autres te montrent.

<a id="offer-book.your-active-offers"></a>

### Vos offres actives

Les offres que **tu** as publiées et que personne n'a encore
acceptées. Tant qu'une offre est ici, tu peux l'annuler sans frais.
Une fois acceptée, la position devient un vrai prêt et passe à "Vos
prêts" sur le Tableau de bord.

<a id="offer-book.lender-offers"></a>

### Offres de prêteurs

Publications de personnes proposant de prêter. Chacune dit : "Je
prêterai X unités de l'actif Y au taux de Z% pendant D jours, en
échange de tant de collatéral".

Un emprunteur acceptant l'une de ces offres devient l'emprunteur
inscrit du prêt : le collatéral de l'emprunteur est verrouillé en
escrow, l'actif principal arrive dans le wallet de l'emprunteur, et
les intérêts s'accumulent jusqu'à ce que l'emprunteur rembourse.

Le protocole impose une règle de sécurité du côté de l'emprunteur au
moment de l'acceptation : le collatéral doit valoir au moins 1.5×
le prêt. (Ce nombre s'appelle **Health Factor 1.5**.) Si le
collatéral de l'emprunteur n'est pas suffisant, le prêt ne démarre
pas.

<a id="offer-book.borrower-offers"></a>

### Offres d'emprunteurs

Publications d'emprunteurs ayant déjà verrouillé leur collatéral et
attendant que quelqu'un finance le prêt.

Un prêteur acceptant l'une de ces offres finance le prêt : l'actif
du prêteur va à l'emprunteur, le prêteur devient le prêteur inscrit,
et le prêteur perçoit des intérêts au taux de l'offre sur toute la
durée. Une petite portion (1%) des intérêts revient à la trésorerie
du protocole au moment du règlement.

---

## Créer une offre

<a id="create-offer.offer-type"></a>

### Type d'offre

Choisis un côté :

- **Prêteur** — le prêteur fournit un actif et perçoit des intérêts
  pendant qu'il est en cours.
- **Emprunteur** — l'emprunteur verrouille un collatéral et demande
  un autre actif en échange.

Une sous-option **Location** existe pour les NFT "louables" (une
classe spéciale de NFT pouvant être délégués temporairement). Les
locations ne prêtent pas d'argent — c'est le NFT lui-même qui est
loué pour des frais journaliers.

<a id="create-offer.lending-asset"></a>

### Actif prêté

L'actif et le montant en jeu, plus le taux d'intérêt (APR en %) et
la durée en jours. Le taux est fixé lorsque l'offre est publiée ;
personne ne peut le changer ensuite. Après la fin de la durée, une
courte fenêtre de grâce s'applique — si l'emprunteur n'a pas
remboursé d'ici là, le prêt peut être mis en défaut et la
réclamation du collatéral du prêteur s'enclenche.

<a id="create-offer.lending-asset:lender"></a>

#### Si tu es le prêteur

L'actif principal et le montant que tu es prêt à offrir, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé au
moment de l'offre ; la durée définit la fenêtre de grâce avant que
le prêt puisse passer en défaut.

<a id="create-offer.lending-asset:borrower"></a>

#### Si tu es l'emprunteur

L'actif principal et le montant que tu veux du prêteur, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé au
moment de l'offre ; la durée définit la fenêtre de grâce avant que
le prêt puisse passer en défaut.

<a id="create-offer.nft-details"></a>

### Détails du NFT

Pour une offre de location, cette carte fixe les frais journaliers
de location. Le locataire paie le coût total de la location à
l'avance lors de l'acceptation, plus un petit buffer de 5% au cas où
l'opération s'étirerait légèrement. Le NFT lui-même reste en escrow
pendant toute la durée — le locataire a le droit de l'utiliser mais
ne peut pas le déplacer.

<a id="create-offer.collateral"></a>

### Collatéral

Ce qui est verrouillé pour sécuriser le prêt. Deux variantes :

- **Liquide** — un token bien connu avec un flux de prix en direct
  (Chainlink + un pool on-chain suffisamment profond). Le protocole
  peut le valoriser en temps réel et liquider automatiquement la
  position si le prix bouge contre le prêt.
- **Illiquide** — NFT, ou tokens sans flux de prix. Le protocole ne
  peut pas les valoriser, donc en cas de défaut, le prêteur prend
  simplement tout le collatéral. Les deux parties doivent cocher une
  case acceptant cela avant que l'offre puisse être faite.

<a id="create-offer.collateral:lender"></a>

#### Si tu es le prêteur

Combien tu veux que l'emprunteur verrouille pour sécuriser le prêt.
Les ERC-20 liquides (flux Chainlink + ≥1M$ de profondeur de pool v3)
relèvent du calcul LTV/HF ; les ERC-20 illiquides et les NFT n'ont
pas de valorisation on-chain et nécessitent que les deux parties
consentent à un scénario de transfert intégral du collatéral en
défaut.

<a id="create-offer.collateral:borrower"></a>

#### Si tu es l'emprunteur

Combien tu es prêt à verrouiller pour sécuriser le prêt. Les ERC-20
liquides (flux Chainlink + ≥1M$ de profondeur de pool v3) relèvent
du calcul LTV/HF ; les ERC-20 illiquides et les NFT n'ont pas de
valorisation on-chain et nécessitent que les deux parties
consentent à un scénario de transfert intégral du collatéral en
défaut.

<a id="create-offer.risk-disclosures"></a>

### Avertissements de risque

Prêter et emprunter sur Vaipakam comporte un risque réel. Avant
qu'une offre soit signée, cette carte demande un consentement
explicite de la partie qui signe. Les risques ci-dessous s'appliquent
aux deux côtés ; les onglets spécifiques à chaque rôle ci-dessous
mettent en évidence dans quel sens chacun a tendance à mordre.

Vaipakam est non-custodial. Il n'y a aucun service support pouvant
inverser une transaction déjà passée. Lis attentivement avant de
signer.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si tu es le prêteur

- **Risque smart contract** — les contrats sont du code immuable ;
  un bug inconnu pourrait affecter les fonds.
- **Risque oracle** — un flux de prix obsolète ou manipulé peut
  retarder la liquidation au-delà du point où le collatéral couvre
  ton principal. Tu pourrais ne pas être indemnisé totalement.
- **Slippage de liquidation** — même quand la liquidation se
  déclenche à temps, le swap DEX peut s'exécuter à un prix plus
  défavorable que la cotation, rognant ce que tu récupères
  réellement.
- **Collatéral illiquide** — en cas de défaut, le collatéral te
  revient intégralement, mais s'il vaut moins que le prêt tu n'as
  aucun recours supplémentaire. Tu as accepté ce compromis lors de
  la création de l'offre.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si tu es l'emprunteur

- **Risque smart contract** — les contrats sont du code immuable ;
  un bug inconnu pourrait affecter ton collatéral verrouillé.
- **Risque oracle** — un flux de prix obsolète ou manipulé peut
  déclencher une liquidation contre toi au mauvais moment, même
  quand le prix réel du marché serait resté sûr.
- **Slippage de liquidation** — quand la liquidation se déclenche,
  le swap DEX peut vendre ton collatéral à un prix moins bon que
  prévu.
- **Collatéral illiquide** — en cas de défaut, ton collatéral
  intégral est transféré au prêteur, sans aucune réclamation
  résiduelle pour toi. Tu as accepté ce compromis lors de la
  création de l'offre.

<a id="create-offer.advanced-options"></a>

### Options avancées

Réglages supplémentaires pour les utilisateurs qui les veulent — la
plupart des gens les laissent tels quels. Des choses comme la durée
pendant laquelle une offre reste ouverte avant d'expirer, l'usage
ou non de VPFI pour la remise sur frais sur cette offre spécifique,
et quelques toggles spécifiques au rôle. Tu peux les passer sans
risque pour une première offre.

---

## Centre de réclamations

<a id="claim-center.claims"></a>

### Fonds réclamables

Quand un prêt est terminé — remboursé, en défaut ou liquidé — ta
part du résultat ne va pas automatiquement dans ton wallet. Tu dois
cliquer sur **Réclamer** pour la récupérer. Cette page liste chaque
réclamation en attente que tu as sur cette chaîne.

Un utilisateur peut détenir simultanément des réclamations de
prêteur (issues de prêts qu'il a financés) et des réclamations
d'emprunteur (issues de prêts qu'il a pris) — les deux apparaissent
dans la même liste. Les deux onglets spécifiques au rôle décrivent
ce que chaque type de réclamation rend.

<a id="claim-center.claims:lender"></a>

#### Si tu es le prêteur

Ta réclamation de prêteur rend le principal du prêt plus les
intérêts accumulés, moins une coupe de trésorerie de 1% sur la
portion d'intérêts. Elle devient réclamable dès que le prêt est
réglé — remboursé, en défaut ou liquidé. La réclamation consomme
ton NFT de position de prêteur de manière atomique — une fois
exécutée, ce côté du prêt est entièrement clos.

<a id="claim-center.claims:borrower"></a>

#### Si tu es l'emprunteur

Si tu as remboursé le prêt en totalité, ta réclamation d'emprunteur
te rend le collatéral que tu as verrouillé au début. En cas de
défaut ou de liquidation, seul le rabais VPFI inutilisé de la Loan
Initiation Fee est rendu — le collatéral lui-même est déjà parti
chez le prêteur. La réclamation consomme ton NFT de position
d'emprunteur de manière atomique.

---

## Activité

<a id="activity.feed"></a>

### Flux d'activité

Chaque événement on-chain impliquant ton wallet sur la chaîne à
laquelle tu es connecté — chaque offre que tu as publiée ou
acceptée, chaque prêt, chaque remboursement, chaque réclamation,
chaque liquidation. Tout est lu en direct depuis la chaîne
elle-même ; il n'y a aucun serveur central qui pourrait tomber. Les
plus récents en premier, regroupés par transaction pour que les
choses faites en un même clic restent ensemble.

---

## Acheter VPFI

<a id="buy-vpfi.overview"></a>

### Acheter du VPFI

La page d'achat te permet d'échanger de l'ETH contre du VPFI au
taux fixe de phase initiale du protocole. Tu peux le faire depuis
n'importe quelle chaîne supportée — on route l'opération en arrière-
plan pour toi. Le VPFI atterrit toujours dans ton wallet sur la même
chaîne à laquelle tu es connecté. Pas besoin de changer de réseau.

<a id="buy-vpfi.discount-status"></a>

### Votre statut de remise VPFI

Lecture rapide du tier de remise dans lequel tu te trouves
actuellement. Le tier vient de la quantité de VPFI dans ton
**escrow** (pas dans ton wallet). La carte t'indique aussi (a)
combien de VPFI supplémentaires il faudrait dans l'escrow pour
passer au tier suivant, et (b) si l'interrupteur de consentement du
Tableau de bord est activé — la remise ne s'applique que tant
qu'il l'est.

Le même VPFI dans ton escrow est aussi automatiquement "staké" et
te génère 5% APR.

<a id="buy-vpfi.buy"></a>

### Étape 1 — Achète du VPFI avec de l'ETH

Tape combien d'ETH tu veux dépenser, clique sur Acheter, signe la
transaction. C'est tout. Il y a un plafond par achat et un plafond
glissant sur 24 heures pour prévenir les abus — tu verras les
chiffres en direct à côté du formulaire pour savoir combien il te
reste.

<a id="buy-vpfi.deposit"></a>

### Étape 2 — Dépose le VPFI dans ton escrow

Acheter du VPFI le met dans ton wallet, pas dans ton escrow. Pour
obtenir la remise sur les frais et le rendement de staking de 5%,
tu dois le déplacer toi-même dans l'escrow. C'est toujours un clic
explicite — l'application ne déplace jamais ton VPFI sans que tu le
demandes. Une transaction (ou une seule signature, sur les chaînes
qui le supportent) et c'est réglé.

<a id="buy-vpfi.unstake"></a>

### Étape 3 — Désengage du VPFI de ton escrow

Tu veux récupérer du VPFI dans ton wallet ? Cette carte le renvoie
de l'escrow vers toi. Attention : retirer du VPFI fait baisser ton
tier de remise **immédiatement**. Si tu as des prêts ouverts, le
calcul de la remise bascule au tier inférieur à partir de cet
instant.

---

## Récompenses

<a id="rewards.overview"></a>

### À propos des récompenses

Vaipakam te paie pour deux choses :

1. **Staking** — le VPFI que tu gardes en escrow génère 5% APR,
   automatiquement.
2. **Interaction** — chaque dollar d'intérêts qu'un prêt auquel tu
   participes parvient à régler te rapporte une part journalière
   d'une enveloppe de récompenses communautaire.

Les deux sont versées en VPFI, mintés directement sur la chaîne où
tu te trouves. Pas de pont, pas de changement de chaîne.

<a id="rewards.claim"></a>

### Réclamer les récompenses

Un seul bouton réclame tout des deux flux de récompenses en une
seule transaction. Les récompenses de staking sont toujours
réclamables en temps réel. La part de l'enveloppe d'interaction se
règle une fois par jour, donc si tu en as gagné depuis le dernier
règlement, la portion interaction du total ne devient effective que
peu après la fermeture de la prochaine fenêtre journalière.

<a id="rewards.withdraw-staked"></a>

### Retirer le VPFI staké

Déplace du VPFI de ton escrow vers ton wallet. Une fois dans le
wallet il cesse de générer le 5% APR et cesse de compter pour ton
tier de remise. Identique à l'étape "désengage" sur la page Acheter
VPFI — même action, mais aussi présente ici par commodité.

---

## Détails du prêt

<a id="loan-details.overview"></a>

### Détails du prêt (cette page)

Tout sur un prêt unique, sur une seule page. Les conditions sous
lesquelles il a été ouvert, sa santé actuelle, qui est de chaque
côté, et chaque bouton sur lequel tu peux appuyer en fonction du
rôle que tu joues — rembourser, réclamer, liquider, clôturer
anticipativement, refinancer.

<a id="loan-details.terms"></a>

### Conditions du prêt

Les parties fixes du prêt : quel actif a été prêté, combien, le
taux d'intérêt, la durée, et combien d'intérêts se sont accumulés
jusqu'à présent. Aucun de ces éléments ne change une fois le prêt
ouvert. (Si des conditions différentes sont nécessaires, refinance
— l'application crée un nouveau prêt et règle celui-ci dans la même
transaction.)

<a id="loan-details.collateral-risk"></a>

### Collatéral & Risque

Le collatéral sur ce prêt, plus les chiffres de risque en direct —
Health Factor et LTV. Le **Health Factor** est un score de sécurité
unique : au-dessus de 1, le collatéral couvre confortablement le
prêt ; proche de 1, c'est risqué et le prêt pourrait être liquidé.
Le **LTV** mesure "combien a été emprunté par rapport à la valeur
de ce qui a été déposé". Les seuils où la position devient
dangereuse figurent sur la même carte.

Si le collatéral est illiquide (un NFT ou un token sans flux de
prix en direct), ces chiffres ne peuvent pas être calculés. Les
deux parties ont accepté ce résultat lors de la création de
l'offre.

<a id="loan-details.collateral-risk:lender"></a>

#### Si tu es le prêteur

Voilà le collatéral de l'emprunteur — ta protection. Tant que HF
reste au-dessus de 1, tu es bien couvert. Quand HF baisse, ta
protection s'amincit ; s'il franchit 1, n'importe qui (toi inclus)
peut déclencher la liquidation, et le swap DEX convertit le
collatéral en ton actif principal pour te rembourser. Sur un
collatéral illiquide, le défaut te transfère le collatéral
intégralement — tu prends ce qu'il vaut.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si tu es l'emprunteur

Voilà ton collatéral verrouillé. Garde HF confortablement au-dessus
de 1 — quand il s'en approche, tu es à risque de liquidation. Tu
peux généralement remonter HF en ajoutant du collatéral ou en
remboursant une partie du prêt. Si HF franchit 1, n'importe qui
peut déclencher la liquidation, et le swap DEX vendra ton
collatéral à des prix érodés par le slippage pour rembourser le
prêteur. Sur un collatéral illiquide, le défaut transfère
l'intégralité de ton collatéral au prêteur sans aucune réclamation
résiduelle pour toi.

<a id="loan-details.parties"></a>

### Parties

Les deux adresses de wallet sur ce prêt — prêteur et emprunteur —
et les coffres d'escrow qui détiennent leurs actifs. Chaque côté
a aussi reçu un "NFT de position" à l'ouverture du prêt. Ce NFT
_est_ le droit à la part de résultat de ce côté — garde-le en
sécurité. Si un détenteur le transfère à quelqu'un d'autre, le
nouveau détenteur peut réclamer à sa place.

<a id="loan-details.actions"></a>

### Actions

Chaque bouton disponible sur ce prêt. L'ensemble que tu vois
dépend de ton rôle sur ce prêt précis — les onglets spécifiques au
rôle ci-dessous listent les options de chaque côté. Les boutons
indisponibles pour le moment sont grisés, avec une petite
info-bulle expliquant pourquoi.

<a id="loan-details.actions:lender"></a>

#### Si tu es le prêteur

- **Réclamer** — une fois le prêt réglé (remboursé, en défaut ou
  liquidé), débloque le principal plus les intérêts, moins la
  coupe de trésorerie de 1% sur les intérêts. Consomme ton NFT de
  prêteur.
- **Initier un retrait anticipé** — mets en vente ton NFT de
  prêteur à un autre acheteur en cours de prêt. L'acheteur prend
  le relais de ton côté ; tu repars avec le produit de la vente.
- **Liquider** — n'importe qui (toi inclus) peut déclencher cela
  quand HF descend sous 1 ou quand la période de grâce expire.

<a id="loan-details.actions:borrower"></a>

#### Si tu es l'emprunteur

- **Rembourser** — total ou partiel. Le remboursement partiel
  abaisse ton solde restant et améliore HF ; le remboursement
  total clôt le prêt et débloque ton collatéral via Réclamer.
- **Clôture anticipée** — clôt le prêt avant terme. Voie directe :
  payer le solde restant complet depuis ton wallet maintenant.
  Voie offset : vendre une partie du collatéral sur un DEX,
  utiliser le produit pour rembourser, récupérer ce qui reste.
- **Refinancer** — basculer vers un nouveau prêt avec de nouvelles
  conditions ; le protocole solde l'ancien prêt depuis le nouveau
  principal en une seule transaction. Le collatéral ne quitte
  jamais l'escrow.
- **Réclamer** — une fois le prêt réglé, rend ton collatéral en
  cas de remboursement total, ou tout rabais VPFI inutilisé issu
  des frais d'initiation du prêt en cas de défaut.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Quand tu acceptes une offre, ton wallet "approuve" parfois Vaipakam
à déplacer un token spécifique en ton nom. Certains wallets ont
tendance à laisser ces approbations ouvertes plus longtemps que
nécessaire. Cette page liste chaque approbation que tu as donnée à
Vaipakam sur cette chaîne et te permet d'en désactiver n'importe
laquelle en un clic. Les approbations non nulles (celles
réellement actives) apparaissent en haut.

Une liste d'approbations propre est une habitude d'hygiène — comme
sur Uniswap ou 1inch.

---

## Alertes

<a id="alerts.overview"></a>

### À propos des alertes

Quand le prix de ton collatéral baisse, le score de sécurité de
ton prêt (son Health Factor) baisse avec lui. Les alertes te
permettent de t'inscrire pour recevoir un avertissement **avant**
que quiconque puisse te liquider. Un petit service off-chain
surveille tes prêts toutes les cinq minutes et t'envoie un ping au
moment où le score traverse une bande de danger. Aucun coût en gas ;
rien ne se passe on-chain.

<a id="alerts.threshold-ladder"></a>

### Échelle de seuils

Les bandes de danger qu'utilise le watcher. Passer dans une bande
plus dangereuse déclenche une fois. Le ping suivant n'arrive que si
tu traverses une autre bande encore plus profonde. Si tu remontes
dans une bande plus sûre, l'échelle se réinitialise. Les valeurs
par défaut sont calibrées pour des prêts typiques ; si tu détiens
un collatéral très volatil, tu peux vouloir fixer des seuils plus
élevés.

<a id="alerts.delivery-channels"></a>

### Canaux de livraison

Là où les pings arrivent réellement. Tu peux choisir Telegram (un
bot t'envoie un DM), ou Push Protocol (notifications directement
dans ton wallet), ou les deux. Les deux canaux partagent la même
échelle de seuils ci-dessus — tu ne les règles pas séparément.

---

## Vérificateur de NFT

<a id="nft-verifier.lookup"></a>

### Vérifier un NFT

Les NFT de position Vaipakam apparaissent parfois sur des marchés
secondaires. Avant d'en acheter un à un autre détenteur, colle ici
l'adresse du contrat NFT et le token ID. Le vérificateur confirme
(a) qu'il a bien été minté par Vaipakam, (b) sur quelle chaîne vit
le prêt sous-jacent, (c) dans quel état se trouve ce prêt, et (d)
qui détient actuellement le NFT on-chain.

Le NFT de position _est_ le droit de réclamer sur le prêt. Repérer
un faux — ou une position déjà réglée — t'évite la mauvaise
transaction.

---

## Paramètres des keepers

<a id="keeper-settings.overview"></a>

### À propos des keepers

Un "keeper" est un wallet en qui tu as confiance pour effectuer des
actions de maintenance spécifiques sur tes prêts à ta place —
finaliser un retrait anticipé, finaliser un refinancement, ce
genre de choses. Les keepers ne peuvent jamais dépenser ton argent
— rembourser, ajouter du collatéral, réclamer et liquider restent
réservés à l'utilisateur. Tu peux approuver jusqu'à 5 keepers, et
tu peux désactiver l'interrupteur principal à tout moment pour les
désactiver tous d'un coup.

<a id="keeper-settings.approved-list"></a>

### Keepers approuvés

Chaque keeper de la liste ne peut faire **que les actions que tu
as cochées** pour lui. Donc un keeper avec uniquement "finaliser
retrait anticipé" autorisé ne peut pas en démarrer un en ton nom —
il ne peut que finaliser celui que tu as démarré. Si tu changes
d'avis, modifie les coches ; si tu veux qu'un keeper disparaisse
totalement, retire-le de la liste.

---

## Tableau de bord d'analytique publique

<a id="public-dashboard.overview"></a>

### À propos de l'analytique publique

Une vue transparente, sans wallet, de tout le protocole : total
value locked, volumes de prêts, taux de défaut, offre VPFI,
activité récente. Le tout calculé en direct à partir des données
on-chain — il n'y a aucune base de données privée derrière les
chiffres de cette page.

<a id="public-dashboard.combined"></a>

### Combiné — Toutes les chaînes

Les totaux à l'échelle du protocole, sommés sur toutes les chaînes
supportées. La petite ligne "X chaînes couvertes, Y inaccessibles"
indique si le réseau d'une chaîne était hors ligne au moment du
chargement de la page — si c'est le cas, la chaîne concernée est
signalée dans le tableau par chaîne ci-dessous.

<a id="public-dashboard.per-chain"></a>

### Détail par chaîne

Les mêmes totaux, ventilés par chaîne. Utile pour voir quelle
chaîne détient le plus de TVL, où la plupart des prêts se font, ou
pour repérer quand une chaîne est à l'arrêt.

<a id="public-dashboard.vpfi-transparency"></a>

### Transparence du token VPFI

L'état en direct de VPFI sur cette chaîne — combien existent au
total, combien circulent réellement (après soustraction des soldes
détenus par le protocole), et combien restent à minter sous le
plafond. À travers toutes les chaînes, l'offre reste bornée par
construction.

<a id="public-dashboard.transparency"></a>

### Transparence & Source

Chaque chiffre de cette page peut être redérivé directement depuis
la blockchain. Cette carte liste le bloc de snapshot, à quel point
les données sont récentes, et l'adresse du contrat d'où provient
chaque métrique. Si quelqu'un veut vérifier un chiffre, c'est par
là qu'il commence.

---

## Refinancer

Cette page est réservée aux emprunteurs — le refinancement est
initié par l'emprunteur sur le prêt de l'emprunteur.

<a id="refinance.overview"></a>

### À propos du refinancement

Le refinancement bascule ton prêt existant vers un nouveau sans
toucher à ton collatéral. Tu publies une nouvelle offre côté
emprunteur avec les nouvelles conditions ; une fois qu'un prêteur
accepte, le protocole solde l'ancien prêt et ouvre le nouveau dans
une seule transaction. À aucun moment ton collatéral n'est sans
protection.

<a id="refinance.position-summary"></a>

### Votre position actuelle

Un instantané du prêt que tu refinances — ce qui reste dû, combien
d'intérêts se sont accumulés, sa santé, ce qui est verrouillé.
Sers-toi de ces chiffres pour dimensionner la nouvelle offre
intelligemment.

<a id="refinance.step-1-post-offer"></a>

### Étape 1 — Publie la nouvelle offre

Tu publies une offre d'emprunteur avec l'actif, le montant, le
taux et la durée que tu veux pour le refinancement. Tant qu'elle
est listée, l'ancien prêt continue normalement — les intérêts
s'accumulent encore, ton collatéral reste en place. Les autres
utilisateurs voient cette offre dans le Carnet d'offres.

<a id="refinance.step-2-complete"></a>

### Étape 2 — Finaliser

Une fois qu'un prêteur a accepté ton offre de refinancement,
clique sur Finaliser. Le protocole, atomiquement : rembourse
l'ancien prêt depuis le nouveau principal, ouvre le nouveau prêt,
et garde ton collatéral verrouillé tout du long. Une transaction,
deux états changés, aucune fenêtre d'exposition.

---

## Clôture anticipée

Cette page est réservée aux emprunteurs — la clôture anticipée
(preclose) est initiée par l'emprunteur sur son prêt.

<a id="preclose.overview"></a>

### À propos de la clôture anticipée

La clôture anticipée, c'est "fermer mon prêt avant terme". Tu as
deux voies :

- **Direct** — payer la totalité du solde restant depuis ton
  wallet maintenant.
- **Offset** — vendre une partie de ton collatéral sur un DEX et
  utiliser le produit pour solder le prêt. Tu récupères ce qui
  reste.

Direct revient moins cher si tu as les liquidités. Offset est la
réponse quand tu ne les as pas, mais que tu ne veux plus non plus
laisser le prêt courir.

<a id="preclose.position-summary"></a>

### Votre position actuelle

Un instantané du prêt que tu clos en avance — solde restant,
intérêts accumulés, santé actuelle. Clore en avance est juste sur
le plan des frais — il n'y a pas de pénalité forfaitaire ; le
calcul VPFI pondéré dans le temps du protocole gère la
comptabilité.

<a id="preclose.in-progress"></a>

### Offset en cours

Tu as démarré un offset preclose il y a un instant et l'étape de
swap est en plein vol. Tu peux soit le finaliser (le produit règle
le prêt et tout reliquat te revient), soit — si le prix a bougé
pendant ta réflexion — l'annuler et réessayer avec une nouvelle
cotation.

<a id="preclose.choose-path"></a>

### Choisis une voie

Choisis **Direct** si tu as les liquidités pour solder le prêt
maintenant. Choisis **Offset** si tu préfères vendre une partie du
collatéral en sortie. L'une ou l'autre voie clôt le prêt en
totalité ; tu ne peux pas faire une demi-clôture en preclose.

---

## Retrait anticipé (prêteur)

Cette page est réservée aux prêteurs — le retrait anticipé est
initié par le prêteur sur son prêt.

<a id="early-withdrawal.overview"></a>

### À propos de la sortie anticipée du prêteur

Si tu veux sortir d'un prêt avant la fin de la durée, tu peux
mettre ton NFT de prêteur en vente via le protocole. L'acheteur te
paie pour ; en retour, il prend ton côté du prêt — il encaisse le
remboursement éventuel + les intérêts. Tu repars avec ton argent
plus la prime éventuelle versée par l'acheteur.

<a id="early-withdrawal.position-summary"></a>

### Votre position actuelle

Un instantané du prêt dont tu sors — principal, intérêts accumulés
jusqu'à présent, temps restant, et le score de santé actuel de
l'emprunteur. Ce sont les chiffres qu'un acheteur regardera pour
décider de la valeur de ton NFT.

<a id="early-withdrawal.initiate-sale"></a>

### Initier la vente

Tu fixes le prix demandé, le protocole met en liste ton NFT de
prêteur, et tu attends un acheteur. Dès qu'un acheteur accepte, le
produit atterrit dans ton wallet et le prêt continue — mais tu
n'es plus engagé dessus. Tant que la mise en vente est ouverte et
non remplie, tu peux l'annuler.
