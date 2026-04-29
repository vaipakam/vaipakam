# Vaipakam — Guide utilisateur (Mode Avancé)

Explications précises et techniquement rigoureuses de chaque carte de
l'application. Chaque section correspond à une icône d'information
`(i)` à côté du titre d'une carte.

> **Tu lis la version Avancée.** Elle correspond au mode
> **Avancé** de l'app (contrôles plus denses, diagnostics et
> détails de configuration du protocole). Pour une explication
> plus accessible et simple, bascule l'app en mode **Basique** —
> ouvre les Paramètres (icône d'engrenage en haut à droite) →
> **Mode** → **Basique**. Les liens « En savoir plus » (i) dans
> l'app ouvriront alors le guide Basique.

---

## Tableau de bord

<a id="dashboard.your-escrow"></a>

### Ton Escrow

Un contrat upgradable par utilisateur — ton coffre privé sur cette
chaîne — créé pour toi la première fois que tu participes à un
prêt. Un escrow par adresse par chaîne. Détient les soldes ERC-20,
ERC-721 et ERC-1155 liés à tes positions de prêt. Aucune mise en
commun : les actifs des autres utilisateurs ne sont jamais dans ce
contrat.

L'escrow est le seul endroit où résident le collatéral, les actifs
prêtés et ton VPFI verrouillé. Le protocole s'authentifie auprès
de lui à chaque dépôt et retrait. L'implémentation peut être mise
à jour par le propriétaire du protocole, mais uniquement à travers
un timelock — jamais instantanément.

<a id="dashboard.your-loans"></a>

### Tes prêts

Chaque prêt impliquant le wallet connecté sur cette chaîne — que
tu sois côté prêteur, côté emprunteur, ou les deux sur des
positions distinctes. Les données sont calculées en direct à partir
des méthodes de vue du protocole pour ton adresse. Chaque ligne
renvoie vers la page de position complète avec HF, LTV, intérêts
accumulés, les actions autorisées par ton rôle et le statut du prêt,
ainsi que l'identifiant de prêt on-chain que tu peux coller dans un
explorateur de blocs.

<a id="dashboard.vpfi-panel"></a>

### VPFI sur cette chaîne

Comptabilité VPFI en direct pour le wallet connecté sur la chaîne
active :

- Solde du wallet.
- Solde de l'escrow.
- Ta part de l'offre circulante (après soustraction des soldes
  détenus par le protocole).
- Plafond de minting restant.

Vaipakam transporte VPFI entre chaînes via LayerZero V2. **Base est
la chaîne canonique** — l'adaptateur canonique y applique la sémantique
verrouillage à l'envoi / libération à la réception. Toute autre
chaîne supportée exécute un mirror qui mint à l'arrivée d'un paquet
de bridge entrant et brûle en sortie. Par construction, l'offre
totale sur toutes les chaînes reste invariante pendant le bridging.

La politique de vérification des messages cross-chain durcie
après l'incident du secteur d'avril 2026 est de **3 vérificateurs
requis + 2 optionnels, seuil 1 sur 2**. La configuration par
défaut à un seul vérificateur est rejetée à la porte de
déploiement.

<a id="dashboard.fee-discount-consent"></a>

### Consentement à la remise sur frais

Un drapeau d'opt-in au niveau wallet qui permet au protocole de
régler la portion remisée d'un frais en VPFI prélevés sur ton
escrow lors des événements terminaux. Par défaut : désactivé.
Désactivé signifie que tu paies 100% de chaque frais dans l'actif
principal ; activé signifie que la remise pondérée dans le temps
s'applique.

Échelle de tiers :

| Tier | VPFI minimum en escrow | Remise |
| ---- | ---------------------- | ------ |
| 1    | ≥ 100                  | 10%    |
| 2    | ≥ 1 000                | 15%    |
| 3    | ≥ 5 000                | 20%    |
| 4    | > 20 000               | 24%    |

Le tier est calculé contre ton solde d'escrow **après changement**
au moment où tu déposes ou retires du VPFI, puis pondéré dans le
temps sur la durée de vie de chaque prêt. Un retrait refixe
le taux au nouveau solde plus bas immédiatement pour chaque prêt
ouvert te concernant — il n'y a pas de fenêtre de grâce où ton
ancien tier (plus haut) s'applique encore. Cela ferme le schéma
d'abus où un utilisateur pourrait recharger du VPFI juste
avant la fin d'un prêt, capturer la remise du tier complet, et
retirer quelques secondes plus tard.

La remise s'applique au yield-fee du prêteur au moment du
règlement et au Loan Initiation Fee de l'emprunteur (versé comme
rabais VPFI lorsque l'emprunteur réclame).

<a id="dashboard.rewards-summary"></a>

### Tes récompenses VPFI

Carte de résumé ambitieuse qui affiche, dans une seule vue, l'image
combinée des récompenses VPFI du wallet connecté sur les deux flux
de récompenses. Le chiffre principal est la somme de : récompenses
de staking en attente, récompenses de staking déjà réclamées,
récompenses d'interaction en attente et récompenses d'interaction
déjà réclamées.

Les lignes de ventilation par flux affichent en attente + réclamé,
avec un lien profond en chevron vers la carte de réclamation
complète sur sa page native :

- **Rendement du staking** — VPFI en attente accumulé à l'APR du
  protocole sur ton solde d'escrow, plus toutes les récompenses de
  staking que tu as déjà réclamées depuis ce wallet. Lien vers la
  carte de réclamation de staking sur la page Acheter VPFI.
- **Récompenses d'interaction avec la plateforme** — VPFI en attente
  accumulé sur tous les prêts auxquels tu as participé (côté prêteur
  ou emprunteur), plus toutes les récompenses d'interaction que tu
  as déjà réclamées. Lien vers la carte de réclamation d'interaction
  dans le Centre de réclamations.

Les montants déjà réclamés sont reconstruits depuis l'historique
on-chain des réclamations de chaque wallet. Il n'existe pas de total
cumulé on-chain à interroger ; le chiffre est donc calculé en
parcourant les événements de réclamation précédents du wallet sur
cette chaîne. Un cache de navigateur neuf affiche zéro (ou un total
partiel) jusqu'à la fin du parcours historique ; le nombre passe
ensuite à sa valeur correcte. Le modèle de confiance est le même que
celui des cartes de réclamation sous-jacentes.

La carte s'affiche toujours pour les wallets connectés, même quand
toutes les valeurs sont à zéro. L'indice d'état vide est
intentionnel — masquer la carte à zéro rendrait les programmes de
récompenses invisibles pour les nouveaux utilisateurs jusqu'à ce
qu'ils ouvrent Acheter VPFI ou le Centre de réclamations.

---

## Carnet d'offres

<a id="offer-book.filters"></a>

### Filtres

Filtres côté client sur les listes d'offres de prêteur /
d'emprunteur. Filtre par actif, côté, statut, et quelques autres
axes. Les filtres n'affectent pas « Tes offres actives » — cette
liste est toujours affichée intégralement.

<a id="offer-book.your-active-offers"></a>

### Tes offres actives

Offres ouvertes (statut Active, expiration non encore atteinte)
que tu as créées. Annulables à tout moment avant acceptation —
l'annulation est gratuite. L'acceptation fait passer l'offre à
Accepted et déclenche l'initialisation du prêt, qui mint les deux
NFT de position (un pour le prêteur et un pour l'emprunteur) et
ouvre le prêt à l'état Active.

<a id="offer-book.lender-offers"></a>

### Offres de prêteurs

Offres actives où le créateur est prêt à prêter. L'acceptation est
réalisée par un emprunteur. Verrou strict à l'initialisation : le
panier de collatéral de l'emprunteur doit produire un Health
Factor d'au moins 1,5 face au principal demandé par le prêteur.
La mathématique HF est celle du protocole — le verrou n'est pas
contournable. La coupe de trésorerie de 1% sur les intérêts est
prélevée au règlement terminal, pas en amont.

<a id="offer-book.borrower-offers"></a>

### Offres d'emprunteurs

Offres actives d'emprunteurs ayant déjà verrouillé leur collatéral
en escrow. L'acceptation est réalisée par un prêteur ; cela
finance le prêt avec l'actif principal et mint les NFT de
position. Même verrou HF ≥ 1,5 à l'initialisation. L'APR fixe
est défini sur l'offre à la création et immuable durant toute la
vie du prêt — le refinancement crée un nouveau prêt plutôt que de
modifier celui existant.

---

## Créer une offre

<a id="create-offer.offer-type"></a>

### Type d'offre

Sélectionne le côté de l'offre où se trouve le créateur :

- **Prêteur** — le prêteur fournit l'actif principal et une
  spécification de collatéral à laquelle l'emprunteur doit
  satisfaire.
- **Emprunteur** — l'emprunteur verrouille le collatéral à
  l'avance ; un prêteur accepte et finance.
- Sous-type **Location** — pour les NFT ERC-4907 (ERC-721
  louable) et les ERC-1155 louables. Passe par le flux de
  location plutôt que par un prêt avec dette ; le locataire
  pré-paie le coût total de la location (durée × frais
  journalier) plus une marge de 5%.

<a id="create-offer.lending-asset"></a>

### Actif prêté

Pour une offre de dette tu spécifies l'actif, le montant
principal, l'APR fixe et la durée en jours :

- **Actif** — l'ERC-20 prêté / emprunté.
- **Montant** — principal, libellé dans les décimales natives de
  l'actif.
- **APR** — taux annuel fixe en basis points (centièmes de
  pourcent), figé à l'acceptation et inchangé ensuite.
- **Durée en jours** — fixe la fenêtre de grâce avant qu'un
  défaut puisse être déclenché.

L'intérêt accumulé est calculé en continu, à la seconde, à partir
du début du prêt jusqu'au règlement terminal.

<a id="create-offer.lending-asset:lender"></a>

#### Si tu es le prêteur

L'actif principal et le montant que tu es prêt à offrir, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé
au moment de l'offre ; la durée définit la fenêtre de grâce avant
que le prêt puisse passer en défaut. À l'acceptation, le principal
passe de ton escrow à l'escrow de l'emprunteur dans le cadre de
l'initialisation du prêt.

<a id="create-offer.lending-asset:borrower"></a>

#### Si tu es l'emprunteur

L'actif principal et le montant que tu veux du prêteur, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé
au moment de l'offre ; la durée définit la fenêtre de grâce avant
que le prêt puisse passer en défaut. Ton collatéral est verrouillé
dans ton escrow au moment de la création de l'offre et reste
verrouillé jusqu'à ce qu'un prêteur accepte et que le prêt
s'ouvre (ou jusqu'à ce que tu annules).

<a id="create-offer.nft-details"></a>

### Détails du NFT

Champs du sous-type de location. Spécifie le contrat NFT et
l'identifiant du token (et la quantité pour ERC-1155), plus le
frais journalier de location dans l'actif principal. À
l'acceptation, le protocole prélève la location pré-payée depuis
l'escrow du locataire vers la garde — soit durée × frais
journalier, plus une marge de 5%. Le NFT lui-même passe en état
délégué (via les droits d'utilisation ERC-4907, ou le hook
équivalent de location ERC-1155), de sorte que le locataire a
les droits mais ne peut pas transférer le NFT.

<a id="create-offer.collateral"></a>

### Collatéral

Spécification de l'actif de collatéral sur l'offre. Deux classes
de liquidité :

- **Liquide** — possède un flux de prix Chainlink enregistré ET
  au moins un pool Uniswap V3 / PancakeSwap V3 / SushiSwap V3
  avec ≥ 1 M$ de profondeur au tick courant. Les calculs LTV et
  HF s'appliquent ; une liquidation basée sur HF route le
  collatéral via un failover sur 4 DEX (0x → 1inch → Uniswap V3
  → Balancer V2).
- **Illiquide** — tout ce qui échoue à ce qui précède. Valorisé à
  $0 on-chain. Pas de calcul HF. En défaut, le collatéral
  intégral est transféré au prêteur. Les deux parties doivent
  reconnaître explicitement le risque de collatéral illiquide à
  la création / acceptation de l'offre pour que celle-ci soit
  enregistrée.

L'oracle de prix possède un quorum secondaire de trois sources
indépendantes (Tellor, API3, DIA) utilisant une règle de décision
souple 2-sur-N par-dessus le flux primaire Chainlink. Pyth a été
évalué et non adopté.

<a id="create-offer.collateral:lender"></a>

#### Si tu es le prêteur

Combien tu veux que l'emprunteur verrouille pour sécuriser le
prêt. Les ERC-20 liquides (flux Chainlink plus ≥ 1 M$ de
profondeur de pool v3) relèvent du calcul LTV / HF ; les ERC-20
illiquides et les NFT n'ont pas de valorisation on-chain et
nécessitent que les deux parties consentent à un scénario de
transfert intégral du collatéral en défaut. Le verrou HF ≥ 1,5
à l'initialisation du prêt est calculé contre le panier de
collatéral que l'emprunteur présente à l'acceptation —
dimensionner l'exigence ici fixe directement la marge HF de
l'emprunteur.

<a id="create-offer.collateral:borrower"></a>

#### Si tu es l'emprunteur

Combien tu es prêt à verrouiller pour sécuriser le prêt. Les
ERC-20 liquides (flux Chainlink plus ≥ 1 M$ de profondeur de pool
v3) relèvent du calcul LTV / HF ; les ERC-20 illiquides et les
NFT n'ont pas de valorisation on-chain et nécessitent que les
deux parties consentent à un scénario de transfert intégral du
collatéral en défaut. Ton collatéral est verrouillé dans ton
escrow au moment de la création de l'offre sur une offre
d'emprunteur ; pour une offre de prêteur, ton collatéral est
verrouillé au moment de l'acceptation. Dans tous les cas, le
verrou HF ≥ 1,5 à l'initialisation du prêt doit être franchi
avec le panier que tu présentes.

<a id="create-offer.risk-disclosures"></a>

### Avertissements de risque

Porte de consentement avant la soumission. La même surface de
risque s'applique aux deux côtés ; les onglets spécifiques au rôle
ci-dessous expliquent comment chaque risque se manifeste selon le
côté de l'offre que tu signes. Vaipakam est non-custodial : il
n'existe pas de clé admin pouvant annuler une transaction passée.
Des leviers de pause existent uniquement sur les contrats exposés
au cross-chain, sont protégés par un timelock et ne peuvent pas
déplacer d'actifs.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si tu es le prêteur

- **Risque smart contract** — code immuable au runtime ; audité
  mais non vérifié formellement.
- **Risque oracle** — l'obsolescence Chainlink ou la divergence
  de profondeur de pool peut retarder une liquidation basée sur
  HF au-delà du point où le collatéral couvre le principal. Le
  quorum secondaire (Tellor + API3 + DIA, souple 2-sur-N) capte
  les dérives importantes, mais un petit biais peut encore éroder
  la récupération.
- **Slippage de liquidation** — le failover 4-DEX route vers la
  meilleure exécution qu'il puisse trouver, mais ne peut garantir
  un prix spécifique. La récupération est nette de slippage et
  de la coupe de trésorerie de 1% sur les intérêts.
- **Défauts sur collatéral illiquide** — le collatéral te revient
  intégralement au moment du défaut. Aucun recours si l'actif
  vaut moins que le principal plus les intérêts accumulés.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si tu es l'emprunteur

- **Risque smart contract** — code immuable au runtime ; les
  bugs affecteraient le collatéral verrouillé.
- **Risque oracle** — des données obsolètes ou une manipulation peuvent
  déclencher une liquidation basée sur HF contre toi alors que
  le prix de marché réel serait resté sûr. La formule HF est
  réactive à la sortie de l'oracle ; un seul mauvais tick
  franchissant 1,0 suffit.
- **Slippage de liquidation** — quand une liquidation se
  déclenche, le swap peut vendre ton collatéral à des prix
  érodés par le slippage. Le swap est permissionless —
  n'importe qui peut le déclencher dès que ton HF descend
  sous 1,0.
- **Défauts sur collatéral illiquide** — le défaut transfère ton
  collatéral intégral au prêteur. Aucune réclamation
  résiduelle ; seulement le rabais VPFI Loan Initiation Fee
  inutilisé, que tu encaisses en tant qu'emprunteur au moment de
  la réclamation.

<a id="create-offer.advanced-options"></a>

### Options avancées

Réglages moins courants :

- **Expiration** — l'offre s'auto-annule après ce timestamp. Par
  défaut ≈ 7 jours.
- **Utiliser la remise sur frais pour cette offre** — surcharge
  locale du consentement à la remise au niveau wallet pour cette
  offre spécifique.
- Options spécifiques au côté exposées par le flux de création
  d'offre.

Les valeurs par défaut conviennent à la plupart des utilisateurs.

---

## Centre de réclamations

<a id="claim-center.claims"></a>

### Fonds réclamables

Les réclamations sont en mode pull par conception — les
événements terminaux laissent les fonds en garde du protocole et
le détenteur du NFT de position appelle réclamer pour les
déplacer. Les deux types de réclamation peuvent coexister dans
le même wallet en même temps. Les onglets spécifiques au rôle
ci-dessous décrivent chacun.

Chaque réclamation brûle le NFT de position du détenteur de manière
atomique. Le NFT *est* l'instrument au porteur — le transférer
avant de réclamer donne au nouveau détenteur le droit
d'encaisser.

<a id="claim-center.claims:lender"></a>

#### Si tu es le prêteur

La réclamation du prêteur rend :

- Ton principal de retour dans ton wallet sur cette chaîne.
- Les intérêts accumulés moins la coupe de trésorerie de 1%. La
  coupe est elle-même réduite par ton accumulateur de remise sur
  frais VPFI pondéré dans le temps quand le consentement est
  activé.

Réclamable dès que le prêt atteint un état terminal (Settled,
Defaulted ou Liquidated). Le NFT de position de prêteur est
brûlé dans la même transaction.

<a id="claim-center.claims:borrower"></a>

#### Si tu es l'emprunteur

La réclamation de l'emprunteur rend, selon la manière dont le
prêt s'est réglé :

- **Remboursement total / preclose / refinance** — ton panier de
  collatéral, plus le rabais VPFI pondéré dans le temps issu de
  la Loan Initiation Fee.
- **Liquidation HF ou défaut** — uniquement le rabais VPFI Loan
  Initiation Fee inutilisé, qui sur ces chemins terminaux est
  zéro à moins d'être explicitement préservé. Le collatéral est
  déjà passé au prêteur.

Le NFT de position d'emprunteur est brûlé dans la même
transaction.

---

## Activité

<a id="activity.feed"></a>

### Flux d'activité

Événements on-chain impliquant ton wallet sur la chaîne active,
sourcés en direct depuis les logs du protocole sur une fenêtre
glissante de blocs. Aucun cache backend — chaque chargement
récupère les données à nouveau. Les événements sont regroupés par hash de transaction
pour que les txns multi-événements (par exemple, accept +
initiate dans le même bloc) restent ensemble. Les plus récents
en premier. Affiche offres, prêts, remboursements, réclamations,
liquidations, mints / burns de NFT, et achats / stakes /
unstakes de VPFI.

---

## Acheter VPFI

<a id="buy-vpfi.overview"></a>

### Acheter du VPFI

Deux voies :

- **Canonique (Base)** — appel direct au flux d'achat canonique
  sur le protocole. Mint VPFI directement vers ton wallet sur
  Base.
- **Hors canonique** — l'adaptateur d'achat de la chaîne locale
  envoie un paquet LayerZero au récepteur canonique sur Base, qui
  exécute l'achat sur Base et renvoie le résultat par bridge via
  le standard de token cross-chain. Latence end-to-end ≈ 1 min
  sur les paires L2-vers-L2. Le VPFI atterrit dans ton wallet
  sur la chaîne d'**origine**.

Limites de débit de l'adaptateur (post-durcissement) : 50 000 VPFI
par requête et 500 000 VPFI glissants sur 24 heures. Réglables
par la gouvernance via un timelock.

<a id="buy-vpfi.discount-status"></a>

### Ton statut de remise VPFI

Statut en direct :

- Tier courant (0 à 4).
- Solde VPFI d'escrow plus l'écart jusqu'au tier suivant.
- Pourcentage de remise au tier courant.
- Drapeau de consentement au niveau wallet.

À noter que le VPFI en escrow accumule aussi 5% APR via le pool
de staking — il n'y a pas d'action « stake » séparée. Déposer
du VPFI dans ton escrow EST staker.

<a id="buy-vpfi.buy"></a>

### Étape 1 — Achète du VPFI avec de l'ETH

Soumet l'achat. Sur la chaîne canonique, le protocole mint
directement. Sur les chaînes mirror, l'adaptateur d'achat encaisse,
envoie un message cross-chain, et le récepteur exécute l'achat
sur Base et renvoie le VPFI par bridge. Les frais de pont plus le
coût du réseau de vérificateurs est coté en direct et affiché
dans le formulaire. Le VPFI ne se dépose pas automatiquement en
escrow — l'étape 2 est une action explicite de l'utilisateur par
conception.

<a id="buy-vpfi.deposit"></a>

### Étape 2 — Dépose le VPFI dans ton escrow

Une étape de dépôt explicite séparée, depuis ton wallet vers ton
escrow sur la même chaîne. Requise sur chaque chaîne — même la
canonique — car le dépôt en escrow est toujours une action
explicite de l'utilisateur par spécification. Sur les chaînes
où Permit2 est configuré, l'app préfère la voie en signature
unique au pattern classique approve + deposit ; elle bascule proprement
si Permit2 n'est pas configuré sur cette chaîne.

<a id="buy-vpfi.unstake"></a>

### Étape 3 — Désengage le VPFI de ton escrow

Retire du VPFI de ton escrow vers ton wallet. Pas d'étape
d'approbation — le protocole possède l'escrow et se prélève
lui-même. Le retrait déclenche une refixation immédiate du
taux de remise au nouveau solde plus bas, appliqué à chaque
prêt ouvert te concernant. Il n'y a pas de fenêtre de grâce où
l'ancien tier s'applique encore.

---

## Récompenses

<a id="rewards.overview"></a>

### À propos des récompenses

Deux flux :

- **Pool de staking** — le VPFI détenu en escrow accumule à 5%
  APR en continu, avec composition à la seconde.
- **Pool d'interaction** — part journalière au prorata d'une
  émission journalière fixe, pondérée par ta contribution en
  intérêts réglés au volume de prêts du jour. Les fenêtres
  journalières finalisent paresseusement à la première
  réclamation ou règlement après la fermeture de fenêtre.

Les deux flux sont mintés directement sur la chaîne active — il
n'y a pas d'aller-retour cross-chain pour l'utilisateur.
L'agrégation cross-chain des récompenses se fait uniquement
entre les contrats du protocole.

<a id="rewards.claim"></a>

### Réclamer les récompenses

Une seule transaction réclame les deux flux à la fois. Les
récompenses de staking sont toujours disponibles ; les
récompenses d'interaction sont nulles jusqu'à ce que la fenêtre
journalière concernée finalise (finalisation paresseuse
déclenchée par la prochaine réclamation ou règlement non nul sur
cette chaîne). L'UI verrouille le bouton tant que la fenêtre
est encore en cours de finalisation pour que les utilisateurs
ne sous-réclament pas.

<a id="rewards.withdraw-staked"></a>

### Retirer le VPFI staké

Interface identique à « Étape 3 — Désengage » sur la page Acheter
VPFI — retire du VPFI de l'escrow vers ton wallet. Le VPFI
retiré sort du pool de staking immédiatement (les récompenses
cessent de s'accumuler pour ce montant à ce bloc) et sort de
l'accumulateur de remise immédiatement (refixation après solde sur
chaque prêt ouvert).

---

## Détails du prêt

<a id="loan-details.overview"></a>

### Détails du prêt (cette page)

Vue d'un prêt unique dérivée en direct du protocole, plus HF et
LTV en direct du moteur de risque. Affiche les conditions, le
risque de collatéral, les parties, les actions autorisées par ton
rôle et le statut du prêt, ainsi que le statut keeper en ligne.

<a id="loan-details.terms"></a>

### Conditions du prêt

Parties immuables du prêt :

- Principal (actif et montant).
- APR (fixé à la création de l'offre).
- Durée en jours.
- Heure de début et heure de fin (heure de début + durée).
- Intérêts accumulés, calculés en direct depuis les secondes
  écoulées depuis le début.

Le refinancement crée un nouveau prêt plutôt que de modifier ces
valeurs.

<a id="loan-details.collateral-risk"></a>

### Collatéral & Risque

Mathématique de risque en direct.

- **Health Factor** = (valeur USD du collatéral × seuil de
  liquidation) / valeur USD de la dette. Un HF en dessous de
  1,0 rend la position liquidable.
- **LTV** = valeur USD de la dette / valeur USD du collatéral.
- **Seuil de liquidation** = le LTV à partir duquel la position
  devient liquidable ; dépend de la classe de volatilité du
  panier de collatéral. Le déclencheur d'effondrement à haute
  volatilité est de 110% LTV.

Le collatéral illiquide a une valeur USD on-chain de zéro ; HF
et LTV passent à « n/a » et le seul chemin terminal est le
transfert intégral du collatéral en défaut — les deux parties
ont consenti à la création de l'offre via la reconnaissance de
risque illiquide.

<a id="loan-details.collateral-risk:lender"></a>

#### Si tu es le prêteur

Le panier de collatéral sécurisant ce prêt est ta protection. Un
HF au-dessus de 1,0 signifie que la position est surcollatéralisée
par rapport au seuil de liquidation. À mesure que HF dérive vers
1,0, ta protection s'amenuise. Une fois HF
descendu sous 1,0, n'importe qui (toi inclus) peut appeler
liquider, et le protocole route le collatéral via le failover
4-DEX vers ton actif principal. La récupération est nette de
slippage.

Pour le collatéral illiquide, en défaut le panier te revient
intégralement au moment du défaut — sa valeur réelle sur le
marché ouvert devient ton risque.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si tu es l'emprunteur

Ton collatéral verrouillé. Garde HF confortablement au-dessus de
1,0 — une cible de marge courante est 1,5 pour absorber la
volatilité. Leviers pour remonter HF :

- **Ajouter du collatéral** — recharger le panier. Action
  réservée à l'utilisateur.
- **Remboursement partiel** — réduit la dette, remonte HF.

Une fois HF descendu sous 1,0, n'importe qui peut déclencher une
liquidation basée sur HF ; le swap vend ton collatéral à des
prix érodés par le slippage pour rembourser le prêteur. Sur
collatéral illiquide, le défaut transfère ton collatéral
intégral au prêteur — il ne reste à réclamer que le rabais VPFI
Loan Initiation Fee inutilisé.

<a id="loan-details.parties"></a>

### Parties

Prêteur, emprunteur, escrow du prêteur, escrow de l'emprunteur
et les deux NFT de position (un pour chaque côté). Chaque NFT
est un ERC-721 avec métadonnées on-chain ; le transférer
transfère le droit de réclamer. Les contrats d'escrow sont
déterministes par adresse — même adresse à travers les
déploiements.

<a id="loan-details.actions"></a>

### Actions

Interface d'actions, contrôlée par rôle par le protocole. Les onglets
spécifiques au rôle ci-dessous listent les actions disponibles
de chaque côté. Les actions désactivées affichent un motif au
survol dérivé du verrou (« HF insuffisant », « Pas encore
expiré », « Prêt verrouillé », etc.).

Actions permissionless disponibles à tous quel que soit le rôle :

- **Déclencher la liquidation** — quand HF descend sous 1,0.
- **Marquer en défaut** — quand la période de grâce a expiré
  sans remboursement total.

<a id="loan-details.actions:lender"></a>

#### Si tu es le prêteur

- **Réclamer en tant que prêteur** — uniquement en état terminal. Rend
  principal plus intérêts moins la coupe de trésorerie de 1%
  (encore réduite par ta remise yield-fee VPFI pondérée dans le
  temps quand le consentement est activé). Brûle le NFT de
  position de prêteur.
- **Initier un retrait anticipé** — liste le NFT de position de
  prêteur à la vente à un prix que tu choisis. Un acheteur qui
  finalise la vente prend ton côté ; tu reçois le produit.
  Annulable avant exécution de la vente.
- Optionnellement délégable à un keeper détenant la permission
  d'action pertinente — voir Paramètres des keepers.

<a id="loan-details.actions:borrower"></a>

#### Si tu es l'emprunteur

- **Rembourser** — total ou partiel. Le partiel réduit le solde
  restant et remonte HF ; le total déclenche le règlement
  terminal, y compris le rabais VPFI Loan Initiation Fee
  pondéré dans le temps.
- **Preclose direct** — paie le solde restant depuis ton wallet
  maintenant, libère le collatéral, règle le rabais.
- **Preclose offset** — vend une partie du collatéral via le
  routeur de swap du protocole, rembourse depuis le produit, et
  retourne le reste. Deux étapes : initier, puis finaliser.
- **Refinancer** — publie une offre d'emprunteur pour de
  nouvelles conditions ; une fois qu'un prêteur accepte,
  finaliser le refinancement échange les prêts atomiquement
  sans que le collatéral ne quitte ton escrow.
- **Réclamer en tant qu'emprunteur** — uniquement en état terminal. Rend
  le collatéral en cas de remboursement total, ou le rabais
  VPFI Loan Initiation Fee inutilisé en défaut / liquidation.
  Brûle le NFT de position d'emprunteur.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Liste chaque allowance ERC-20 que ton wallet a accordée au
protocole sur cette chaîne. Sourcée en scannant une liste
candidate de tokens contre les vues d'allowance on-chain.
Révoquer met l'allowance à zéro.

Conformément à la politique d'approbation au montant exact, le
protocole ne demande jamais d'allowances illimitées, donc la
liste typique de révocation est courte.

Note : les flux de type Permit2 contournent l'allowance par
actif sur le protocole en utilisant une signature unique à la
place, donc une liste propre ici n'empêche pas les dépôts
futurs.

---

## Alertes

<a id="alerts.overview"></a>

### À propos des alertes

Un watcher off-chain interroge chaque prêt actif impliquant ton
wallet à une cadence de 5 minutes, lit le Health Factor en
direct de chacun, et sur un franchissement de bande dans la
direction dangereuse déclenche une fois via les canaux
configurés. Pas d'état on-chain ni de gas. Les alertes sont
consultatives — elles ne déplacent pas de fonds.

<a id="alerts.threshold-ladder"></a>

### Échelle de seuils

Une échelle de bandes HF configurée par l'utilisateur. Passer
dans une bande plus dangereuse déclenche une fois et arme le
seuil plus profond suivant ; repasser au-dessus d'une bande la
réarme. Par défaut : 1,5 → 1,3 → 1,1. Des nombres plus élevés
sont appropriés pour un collatéral volatil. Le seul rôle de
l'échelle est de te faire sortir avant que HF ne descende sous
1,0 et déclenche la liquidation.

<a id="alerts.delivery-channels"></a>

### Canaux de livraison

Deux canaux :

- **Telegram** — DM bot avec l'adresse courte du wallet,
  l'identifiant du prêt et le HF actuel.
- **Push Protocol** — notification directe au wallet via le
  canal Vaipakam Push.

Les deux partagent l'échelle de seuils ; les niveaux
d'avertissement par canal ne sont volontairement pas exposés
pour éviter la dérive. La publication sur le canal Push est
actuellement stubée en attendant la création du canal.

---

## Vérificateur de NFT

<a id="nft-verifier.lookup"></a>

### Vérifier un NFT

Étant donné une adresse de contrat NFT et un identifiant de
token, le vérificateur récupère :

- Le propriétaire actuel (ou un signal de burn si le token est
  déjà brûlé).
- Les métadonnées JSON on-chain.
- Une vérification croisée avec le protocole : dérive
  l'identifiant de prêt sous-jacent depuis les métadonnées et
  lit les détails du prêt depuis le protocole pour confirmer
  l'état.

Affiche : minté par Vaipakam ? quelle chaîne ? statut du
prêt ? détenteur courant ? Te permet de repérer une
contrefaçon, une position déjà réclamée (brûlée), ou une
position dont le prêt est réglé et en cours de réclamation.

Le NFT de position est l'instrument au porteur — vérifie avant
d'acheter sur un marché secondaire.

---

## Paramètres des keepers

<a id="keeper-settings.overview"></a>

### À propos des keepers

Une allowlist de keepers par wallet, jusqu'à 5 keepers.
Chaque keeper a un ensemble de permissions d'action autorisant
des appels de maintenance spécifiques sur **ton côté** d'un
prêt. Les chemins de sortie de fonds (rembourser, réclamer, ajouter
du collatéral, liquider) sont réservés à l'utilisateur par
conception et ne peuvent pas être délégués.

Deux gardes supplémentaires s'appliquent au moment de l'action :

1. L'interrupteur principal d'accès keeper — un frein d'urgence
   à un seul basculement qui désactive tous les keepers sans toucher à
   l'allowlist.
2. Un toggle d'opt-in par prêt, réglé sur la surface du Carnet
   d'offres ou des Détails du prêt.

Un keeper ne peut agir que quand les quatre conditions sont
remplies : approuvé, interrupteur principal activé, toggle
par-prêt activé et la permission d'action spécifique configurée
sur ce keeper.

<a id="keeper-settings.approved-list"></a>

### Keepers approuvés

Permissions d'action actuellement exposées :

- **Finaliser une vente de prêt** (côté prêteur, sortie de
  marché secondaire).
- **Finaliser un offset** (côté emprunteur, deuxième étape du
  preclose via vente de collatéral).
- **Initier un retrait anticipé** (côté prêteur, met la
  position en vente).
- **Initier un preclose** (côté emprunteur, lance le flux de
  preclose).
- **Refinancer** (côté emprunteur, échange atomique de prêt
  sur une nouvelle offre d'emprunteur).

Les permissions ajoutées on-chain que le frontend ne reflète
pas encore obtiennent un revert clair de « permission
invalide ». La révocation est instantanée sur tous les prêts —
il n'y a pas de période d'attente.

---

## Tableau de bord d'analytique publique

<a id="public-dashboard.overview"></a>

### À propos de l'analytique publique

Un agrégateur sans wallet calculé en direct à partir d'appels
view du protocole on-chain sur chaque chaîne supportée. Pas de
backend, pas de base de données. Export CSV / JSON disponible ;
l'adresse du protocole plus la fonction view qui supporte chaque
métrique sont affichées pour la vérifiabilité.

<a id="public-dashboard.combined"></a>

### Combiné — Toutes les chaînes

Rollup cross-chain. L'en-tête rapporte combien de chaînes ont
été couvertes et combien ont échoué, donc un RPC inaccessible
au moment de la récupération est explicite. Quand une ou plusieurs
chaînes ont échoué, le tableau par chaîne signale laquelle —
les totaux TVL sont quand même rapportés, mais reconnaissent
l'écart.

<a id="public-dashboard.per-chain"></a>

### Détail par chaîne

Ventilation par chaîne des métriques combinées. Utile pour
repérer une concentration de TVL, des supplies mirror VPFI
incohérents (la somme des supplies mirror devrait égaler le
solde verrouillé de l'adaptateur canonique), ou des chaînes à
l'arrêt.

<a id="public-dashboard.vpfi-transparency"></a>

### Transparence du token VPFI

Comptabilité VPFI on-chain sur la chaîne active :

- Offre totale, lue directement depuis l'ERC-20.
- Offre circulante — offre totale moins les soldes détenus par
  le protocole (trésorerie, pools de récompenses, paquets du
  pont in-flight).
- Plafond de minting restant — n'a de sens que sur la chaîne
  canonique ; les chaînes mirror rapportent « n/a » pour le
  plafond car les mints y sont pilotés par le pont, pas mintés
  depuis le plafond.

Invariant cross-chain : la somme des supplies mirror sur toutes
les chaînes mirror égale le solde verrouillé de l'adaptateur
canonique. Un watcher surveille cela et alerte sur la dérive.

<a id="public-dashboard.transparency"></a>

### Transparence & Source

Pour chaque métrique, la page liste :

- Le numéro de bloc utilisé comme instantané.
- Fraîcheur des données (ancienneté maximale parmi les chaînes).
- L'adresse du protocole et l'appel de fonction view.

N'importe qui peut redériver n'importe quel chiffre de cette
page depuis RPC + bloc + adresse du protocole + nom de
fonction — c'est le standard.

---

## Refinancer

Cette page est réservée aux emprunteurs — le refinancement est
initié par l'emprunteur sur son prêt.

<a id="refinance.overview"></a>

### À propos du refinancement

Le refinancement solde atomiquement ton prêt existant depuis un
nouveau principal et ouvre un prêt frais avec les nouvelles
conditions, le tout en une transaction. Le collatéral reste
dans ton escrow tout du long — pas de fenêtre non garantie. Le
nouveau prêt doit franchir le verrou HF ≥ 1,5 à
l'initialisation, comme tout autre prêt.

Le rabais inutilisé de la Loan Initiation Fee de l'ancien prêt
est correctement réglé dans le cadre de l'échange.

<a id="refinance.position-summary"></a>

### Ta position actuelle

Snapshot du prêt en cours de refinancement — principal courant,
intérêts accumulés à ce stade, HF / LTV et le panier de
collatéral. La nouvelle offre devrait dimensionner au moins le
solde restant (principal + intérêts accumulés) ; tout excédent
sur la nouvelle offre est livré à ton escrow comme principal
libre.

<a id="refinance.step-1-post-offer"></a>

### Étape 1 — Publie la nouvelle offre

Publie une offre d'emprunteur avec tes conditions cibles.
L'ancien prêt continue d'accumuler des intérêts pendant
l'attente ; le collatéral reste verrouillé. L'offre apparaît
dans le Carnet d'offres public et n'importe quel prêteur peut
l'accepter. Tu peux annuler avant acceptation.

<a id="refinance.step-2-complete"></a>

### Étape 2 — Finaliser

Règlement atomique après que le nouveau prêteur a accepté :

1. Finance le nouveau prêt depuis le prêteur acceptant.
2. Rembourse l'ancien prêt en totalité (principal + intérêts,
   moins la coupe de trésorerie).
3. Brûle les anciens NFT de position.
4. Mint les nouveaux NFT de position.
5. Règle le rabais inutilisé de la Loan Initiation Fee de
   l'ancien prêt.

Revert si HF sous les nouvelles conditions serait inférieur à 1,5.

---

## Clôture anticipée

Cette page est réservée aux emprunteurs — la clôture anticipée
est initiée par l'emprunteur sur son prêt.

<a id="preclose.overview"></a>

### À propos de la clôture anticipée

Une terminaison anticipée pilotée par l'emprunteur. Deux voies :

- **Direct** — paie le solde restant (principal + intérêts
  accumulés) depuis ton wallet, libère le collatéral, règle le
  rabais inutilisé de la Loan Initiation Fee.
- **Offset** — initie l'offset pour vendre une partie du
  collatéral via le failover de swap 4-DEX du protocole contre
  l'actif principal, finalise l'offset pour rembourser depuis
  le produit, et le reste du collatéral te revient. Même
  règlement de rabais.

Pas de pénalité forfaitaire de clôture anticipée. La
mathématique VPFI pondérée dans le temps gère l'équité.

<a id="preclose.position-summary"></a>

### Ta position actuelle

Snapshot du prêt en cours de preclose — principal restant,
intérêts accumulés, HF / LTV courants. Le flux de preclose
**n'exige pas** HF ≥ 1,5 à la sortie (c'est une fermeture, pas
une ré-init).

<a id="preclose.in-progress"></a>

### Offset en cours

État : l'offset a été initié, le swap est en cours d'exécution
(ou la cotation a été consommée mais le règlement final est en
attente). Deux sorties :

- **Finaliser l'offset** — règle le prêt depuis le produit
  réalisé, retourne le reste.
- **Annuler l'offset** — abandonne ; le collatéral reste
  verrouillé, le prêt inchangé. À utiliser quand le swap a
  bougé contre toi entre initier et finaliser.

<a id="preclose.choose-path"></a>

### Choisis une voie

La voie directe consomme la liquidité du wallet dans l'actif
principal. La voie offset consomme le collatéral via swap DEX ;
préférée quand tu n'as pas l'actif principal sous la main ou
que tu veux aussi sortir de la position de collatéral. Le
slippage de l'offset est borné par le même failover 4-DEX
utilisé pour les liquidations (0x → 1inch → Uniswap V3 →
Balancer V2).

---

## Retrait anticipé (prêteur)

Cette page est réservée aux prêteurs — le retrait anticipé est
initié par le prêteur sur son prêt.

<a id="early-withdrawal.overview"></a>

### À propos de la sortie anticipée du prêteur

Un mécanisme de marché secondaire pour les positions de prêteur.
Tu listes ton NFT de position en vente à un prix choisi ; à
l'acceptation, l'acheteur paie, la propriété du NFT de prêteur
est transférée à l'acheteur, et l'acheteur devient le prêteur
de référence pour tout règlement futur (claim au terminal,
etc.). Tu reçois le produit de la vente.

Les liquidations restent réservées à l'utilisateur et ne sont
PAS déléguées par la vente — seul le droit de réclamer est
transféré.

<a id="early-withdrawal.position-summary"></a>

### Ta position actuelle

Snapshot — principal restant, intérêts accumulés, temps
restant, HF / LTV courants du côté emprunteur. Cela fixe le
prix juste que le marché des acheteurs attend : le payoff de
l'acheteur est principal plus intérêts au terminal, moins le
risque de liquidation sur le temps restant.

<a id="early-withdrawal.initiate-sale"></a>

### Initier la vente

Liste le NFT de position en vente via le protocole à ton prix
demandé. Un acheteur finalise la vente ; tu peux annuler avant
que la vente ne soit exécutée. Optionnellement délégable à un
keeper détenant la permission « finaliser une vente de prêt » ;
l'étape d'initiation reste réservée à l'utilisateur.
