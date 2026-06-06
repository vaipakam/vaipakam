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

<a id="dashboard.your-vault"></a>

### Ton Vault

Un contrat upgradable par utilisateur — ton coffre privé sur cette
chaîne — créé pour toi la première fois que tu participes à un
prêt. Un vault par adresse par chaîne. Détient les soldes ERC-20,
ERC-721 et ERC-1155 liés à tes positions de prêt. Aucune mise en
commun : les actifs des autres utilisateurs ne sont jamais dans ce
contrat.

L'vault est le seul endroit où résident le collatéral, les actifs
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
- Solde de l'vault.
- Ta part de l'offre circulante (après soustraction des soldes
  détenus par le protocole).
- Plafond de minting restant.

Vaipakam transporte VPFI entre chaînes via Chainlink CCIP. **Base est
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
vault lors des événements terminaux. Par défaut : désactivé.
Désactivé signifie que tu paies 100% de chaque frais dans l'actif
principal ; activé signifie que la remise pondérée dans le temps
s'applique.

Échelle de tiers :

| Tier | VPFI minimum en vault                 | Remise                            |
| ---- | -------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`               | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`               | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`               | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`               | `{liveValue:tier4DiscountBps}`%   |

Le tier est calculé contre ton solde d'vault **après changement**
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

> **Le gas du réseau est séparé.** La remise ci-dessus s'applique
> aux **frais de protocole** de Vaipakam (yield-fee
> `{liveValue:treasuryFeeBps}` %, Loan Initiation Fee
> `{liveValue:loanInitiationFeeBps}` %). Les **frais de gas du
> réseau blockchain** que requiert chaque action on-chain — payés
> aux validateurs sur Base / Sepolia / Arbitrum / etc. lors de la
> création d'une offre, l'acceptation, le remboursement, la
> réclamation, le retrait, etc. — ne sont pas un frais de protocole.
> Vaipakam ne les reçoit jamais ; le réseau, oui. Ils ne peuvent
> pas être catégorisés en tiers ni remboursés, et ils varient avec
> la congestion de la chaîne au moment de la soumission, pas avec
> la taille du prêt ni avec ton tier VPFI.

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
  protocole sur ton solde d'vault, plus toutes les récompenses de
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
en vault. L'acceptation est réalisée par un prêteur ; cela
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
passe de ton vault à l'vault de l'emprunteur dans le cadre de
l'initialisation du prêt.

<a id="create-offer.lending-asset:borrower"></a>

#### Si tu es l'emprunteur

L'actif principal et le montant que tu veux du prêteur, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé
au moment de l'offre ; la durée définit la fenêtre de grâce avant
que le prêt puisse passer en défaut. Ton collatéral est verrouillé
dans ton vault au moment de la création de l'offre et reste
verrouillé jusqu'à ce qu'un prêteur accepte et que le prêt
s'ouvre (ou jusqu'à ce que tu annules).

<a id="create-offer.nft-details"></a>

### Détails du NFT

Champs du sous-type de location. Spécifie le contrat NFT et
l'identifiant du token (et la quantité pour ERC-1155), plus le
frais journalier de location dans l'actif principal. À
l'acceptation, le protocole prélève la location pré-payée depuis
l'vault du locataire vers la garde — soit durée × frais
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
vault au moment de la création de l'offre sur une offre
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
  envoie un paquet Chainlink CCIP au récepteur canonique sur Base, qui
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
- Solde VPFI d'vault plus l'écart jusqu'au tier suivant.
- Pourcentage de remise au tier courant.
- Drapeau de consentement au niveau wallet.

À noter que le VPFI en vault accumule aussi 5% APR via le pool
de staking — il n'y a pas d'action « stake » séparée. Déposer
du VPFI dans ton vault EST staker.

<a id="buy-vpfi.buy"></a>

### Étape 1 — Achète du VPFI avec de l'ETH

Soumet l'achat. Sur la chaîne canonique, le protocole mint
directement. Sur les chaînes mirror, l'adaptateur d'achat encaisse,
envoie un message cross-chain, et le récepteur exécute l'achat
sur Base et renvoie le VPFI par bridge. Les frais de pont plus le
coût du réseau de vérificateurs est coté en direct et affiché
dans le formulaire. Le VPFI ne se dépose pas automatiquement en
vault — l'étape 2 est une action explicite de l'utilisateur par
conception.

<a id="buy-vpfi.deposit"></a>

### Étape 2 — Dépose le VPFI dans ton vault

Une étape de dépôt explicite séparée, depuis ton wallet vers ton
vault sur la même chaîne. Requise sur chaque chaîne — même la
canonique — car le dépôt en vault est toujours une action
explicite de l'utilisateur par spécification. Sur les chaînes
où Permit2 est configuré, l'app préfère la voie en signature
unique au pattern classique approve + deposit ; elle bascule proprement
si Permit2 n'est pas configuré sur cette chaîne.

<a id="buy-vpfi.unstake"></a>

### Étape 3 — Désengage le VPFI de ton vault

Retire du VPFI de ton vault vers ton wallet. Pas d'étape
d'approbation — le protocole possède l'vault et se prélève
lui-même. Le retrait déclenche une refixation immédiate du
taux de remise au nouveau solde plus bas, appliqué à chaque
prêt ouvert te concernant. Il n'y a pas de fenêtre de grâce où
l'ancien tier s'applique encore.

---

## Récompenses

<a id="rewards.overview"></a>

### À propos des récompenses

Deux flux :

- **Pool de staking** — le VPFI détenu en vault accumule à 5%
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
VPFI — retire du VPFI de l'vault vers ton wallet. Le VPFI
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

Prêteur, emprunteur, vault du prêteur, vault de l'emprunteur
et les deux NFT de position (un pour chaque côté). Chaque NFT
est un ERC-721 avec métadonnées on-chain ; le transférer
transfère le droit de réclamer. Les contrats d'vault sont
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
  sans que le collatéral ne quitte ton vault.
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
dans ton vault tout du long — pas de fenêtre non garantie. Le
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
sur la nouvelle offre est livré à ton vault comme principal
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

---

<!-- ────────────────────────────────────────────────────────────── -->
<!-- T-086 #374 — TRANSLATION NEEDED                                -->
<!--                                                                -->
<!--   The three sections below are appended in ENGLISH as the      -->
<!--   translator source. Each block is anchored with a stable      -->
<!--   in-app HTML id (load-bearing for dapp cross-links — DO NOT   -->
<!--   change the anchor strings).                                  -->
<!--                                                                -->
<!--   Native French reviewer: please translate each block     -->
<!--   into French AND move it into the appropriate position   -->
<!--   in the body above:                                           -->
<!--                                                                -->
<!--   1. "Your Active Offers" — REPLACES the existing              -->
<!--      `offer-book.your-active-offers` section in this file      -->
<!--      (current locale content is the pre-OpenSea-feature        -->
<!--      version; the EN-source version below ADDS the closed-     -->
<!--      offer status bullets — Filled / Cancelled / Sold /        -->
<!--      Fully Filled / past-GTT note).                            -->
<!--                                                                -->
<!--   2. "Allow optional sale of this NFT on OpenSea"              -->
<!--      (anchor `create-offer.borrow-or-sell`) — INSERT after     -->
<!--      `create-offer.advanced-options` in the Create Offer       -->
<!--      section. This entire section is NEW in this locale.       -->
<!--                                                                -->
<!--   3. "Matching OpenSea offers on a prepay listing"             -->
<!--      (anchor `matching-opensea-offers-on-a-prepay-listing`)    -->
<!--      — INSERT before the "How Liquidation Actually Works"      -->
<!--      section. This entire section is NEW in this locale.       -->
<!--                                                                -->
<!--   Once the translated sections are placed correctly above,     -->
<!--   delete this banner block and the EN source blocks below it.  -->
<!-- ────────────────────────────────────────────────────────────── -->

## [TRANSLATION NEEDED] EN source — Your Active Offers (target placement: `offer-book.your-active-offers`)

<a id="offer-book.your-active-offers"></a>

### Your Active Offers

Open offers (status Active, expiry not yet reached) you created.
Cancellable any time before acceptance — the cancel call is free.
Acceptance flips the offer to Accepted and triggers loan
initiation, which mints the two position NFTs (one for lender,
one for borrower) and opens the loan in the Active state.

Closed offers carry one of several distinct statuses. Some are
already exposed as filter chips on the My Offers page; others
are indexer-side terminals that will get dedicated UI treatment
in follow-up work:

- **Filled** — accepted by a counterparty; the offer's loan
  reference is the resulting loan id.
- **Cancelled** — the offer reached the Cancelled state via
  either path: withdrawn by the creator before acceptance,
  OR cleaned up permissionlessly via `OfferCancelFacet.cancelOffer`
  once `LibVaipakam.isOfferExpired(offer)` is true (the refund
  still routes to the creator regardless of who initiated the
  cancel call).
- **Sold** — the offer was opted into the borrow-OR-sell
  parallel-sale flow (see Create Offer → Allow optional sale)
  and a marketplace buyer filled the NFT collateral listing
  before any lender accepted. The offer carries the on-chain
  status `consumed_by_sale`; the row's rate column shows the
  rate the offer was posted at and the collateral cell renders
  the NFT shape (token id for ERC-721, copy count for
  ERC-1155). The dapp also surfaces the row in the Activity
  feed as `Offer sold via OpenSea` for the borrower (offer
  creator). The on-chain event itself is
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  both the offer id AND the executor address are indexed on-chain,
  but the borrower / creator address is NOT. The borrower's
  wallet match for the Activity feed is added by the indexer at
  ingestion time (it joins the offer row to look up the creator),
  so the per-wallet filter finds the borrower without the
  event itself indexing them.
- **Fully Filled (indexer state, no chip yet)** — Range-orders
  only. When partial-fill matching consumes the offer's
  remaining budget (the last match fully fills the range, or
  a partial match leaves a sub-dust remainder),
  `OfferMatchFacet` emits `OfferClosed(FullyFilled | Dust)` and
  the indexer stamps the offer row `status = 'fullyFilled'`.
  The contract's `accepted` state and the on-chain Filled
  label above are reserved for the direct-accept terminal, so
  `fullyFilled` is distinct on the indexer side. The dapp's
  `MyOfferStatus` doesn't yet expose this terminal as its own
  filter chip — `useMyOffers` currently ignores rows with the
  `fullyFilled` indexer status — so a fully-filled range offer
  effectively drops out of the My Offers view altogether
  until the dedicated chip lands. The chip surface is queued
  as a separate UI follow-up.

Past-GTT (Good-Til-Time) offers that never reached a terminal
event aren't yet exposed as a distinct status chip in the dapp;
they currently fall under Active until the indexer records a
terminal. A dedicated Expired chip is queued as a separate UI
follow-up.


## [TRANSLATION NEEDED] EN source — Allow optional sale of this NFT on OpenSea (target placement: `create-offer.borrow-or-sell`)

<a id="create-offer.borrow-or-sell"></a>

### Allow optional sale of this NFT on OpenSea (borrower NFT-collateral offers only)

If you're posting a **borrower offer** with **ERC-721 or
ERC-1155 collateral** and an **ERC-20 principal**, the dapp
exposes a `Borrow or sell` opt-in below the collateral
section. Ticking it marks the offer as eligible for a
parallel-sale listing of your NFT collateral on OpenSea — a
single offer that can be filled EITHER by a lender (you take
the loan) OR by a marketplace buyer (you sell the NFT). The
listing is NOT torn down at lender acceptance if it was already
posted: if a lender fills first you take the loan, the existing
OpenSea listing carries through loan initiation until its
original Seaport expiry, and a later marketplace fill before
that expiry triggers the diamond's settlement waterfall to close
the loan from the sale proceeds (see Scenario B below). For
ordinary GTT offers this expiry is the offer's original
Good-Til-Time; lender acceptance does not extend or repost the
listing for the full loan term. If a marketplace buyer fills
first, no loan is ever created (Scenario A). The two scenarios
end at different offer states: Scenario A stamps
the offer with `consumed_by_sale` via `markOfferConsumedBySale`
(it shows up under the Sold filter), and lender acceptance
is gated against any offer that has already been stamped. In
Scenario B the offer is already in the `Accepted` state by
the time the marketplace fill lands; the contract
deliberately leaves the offer status at `Accepted` and only
settles the loan from the sale — the offer doesn't transition
to Sold a second time.

**Two-step nature.** Opting in at offer create time just
sets the eligibility flag on the offer. Getting an actual
buyable listing onto OpenSea is a SEPARATE TWO-PART step
the dapp does NOT automate today:

1. **Record + wire on the diamond.** Call
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` while the offer is still active and before any
   lender acceptance. Once the offer is accepted, cancelled, or
   consumed by sale, this call reverts as terminal; ticking the
   opt-in alone is not enough to create a listing that can carry
   into Scenario B. The ask must also clear the pre-loan floor:
   principal plus worst-case offer interest through the loan
   duration and grace window, treasury cut on that interest, the
   configured safety buffer, and all fee-leg amounts. Under-floor
   asks revert at this step. The `feeLegs` argument is the ONLY
   place this call records OpenSea protocol-fee and creator-
   royalty obligations: the diamond subtracts each fee-leg
   amount from the seller proceeds and appends the recipient +
   absolute amount to the Seaport consideration array.
   Passing `feeLegs: []` on a fee-enforced collection produces
   an order shape that the OpenSea publish step will reject
   (the fee-recipient consideration items are missing) and a
   direct Seaport fill will route the full ask to the seller
   rather than splitting the fees as the collection requires.
   Advanced users must fetch the OpenSea required-fee schedule
   for the collection (the in-repo fee parser at
   `apps/agent/src/openseaFees.ts` is the reference) and pass
   absolute amounts derived against the ask before calling. The facet internally builds the
   canonical Seaport OrderComponents from those inputs, the
   OfferContext values it records for the executor (borrower
   vault address, principal asset, collateral fields, startTime,
   endTime), and the current `Seaport.getCounter` for the vault,
   derives the orderHash via
   `Seaport.getOrderHash`, returns it, registers the vault's
   ERC-1271 binding to that hash, and grants the Seaport
   conduit approval for the NFT collateral. The emitted
   `PostParallelSaleListing` event exposes the input args
   (`offerId`, borrower, orderHash, askPrice, executor /
   conduit data, salt, fee legs); it does NOT echo the
   per-context fields, so reconstructing OrderComponents
   off-chain requires the additional reads described in
   step 2 below. **Important:** at this point the order is
   already FILLABLE via Seaport. A bot watching the
   contract's events PLUS those reads can reconstruct the
   OrderComponents and call `Seaport.fulfillOrder` directly
   — the listing does not need to appear on OpenSea's
   marketplace UI for
   the on-chain fill path to work. If you don't want
   counterparties to fill at the current ask before step 2
   lands, either run step 2 immediately after step 1 OR call
   `releaseParallelSaleLock` to invalidate the binding before
   any unintended fill.
   For fee-enforced collections, populate `feeLegs` from the
   collection's required OpenSea / creator fee schedule before
   calling this step. Use only required, non-zero fee rows; cap
   the list to the protocol-supported fee-leg count; convert each
   row into an absolute fixed amount in the principal asset at the
   chosen ask price; and use the listed fee recipient as the leg
   recipient. If a required fee rounds to zero at the chosen ask,
   the ask is too small for that collection and the post should not
   be attempted. Passing an empty array is valid only for fee-free
   collections. On fee-enforced collections it can produce an order
   that fails OpenSea publication or cannot satisfy the marketplace's
   required consideration shape.
2. **Publish to OpenSea.** Reconstruct the same OrderComponents
   the facet built. The `PostParallelSaleListing` event alone
   isn't sufficient: it emits `offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, and fee legs, but
   the offer-keyed order shape also needs values held in the
   executor's `OfferContext` storage (borrower vault address,
   principal asset, collateral fields, startTime, endTime) plus
   the borrower vault's Seaport counter. This is the same
   context used by the `LibPrepayOrder.buildAndHashOfferMem`
   offer-order path, and it is different from the loan-keyed
   prepay-listing order shape. Read both before posting:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     returns the persisted `OfferContext` struct for that hash.
   - `Seaport.getCounter(borrowerVault)` returns the canonical
     Seaport counter for the vault offerer.
   With those fields in hand the OrderComponents struct
   reproduces exactly the one the diamond hashed. Before POSTing,
   add the API-only `parameters.totalOriginalConsiderationItems`
   field — OpenSea's API requires it even though it's NOT part
   of the Seaport struct that produces the canonical hash; the
   in-repo publishers (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) inject it before
   calling the endpoint. For ERC-1271-validated orders OpenSea
   accepts the `signature` field as `0x` (empty bytes) — the
   vault's on-chain `isValidSignature(orderHash, '')` callback
   ignores the signature bytes and returns the EIP-1271 magic
   value for any orderHash the diamond previously registered
   (from step 1). POST the JSON to the OpenSea listings
   endpoint (`POST /api/v2/orders/{chain}/{protocol}/listings`,
   per the official [Create Listing](https://docs.opensea.io/reference/post_listing)
   docs — this is the same endpoint Vaipakam's own publishers
   in `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` use). Only after this
   step does the listing appear on OpenSea's marketplace UI
   and become discoverable to casual buyers. Vaipakam does
   not currently automate this submission for the
   parallel-sale path — surfacing the listing publication
   end-to-end is tracked as a follow-up.

Advanced users following the manual path today need BOTH steps
to get OpenSea visibility; running step 1 alone produces an
order that's fillable directly through Seaport (by a bot or
counterparty that reconstructs the components from the event)
but invisible on the OpenSea marketplace UI.

**Fill mode is forced to All-or-Nothing.** Opting in
automatically pins the offer's fill mode to `Aon` — partial
or IOC fills would create multiple loans against one
offer's collateral, which the contract gates against. The
toggle is hidden on lender offers, ERC-20 collateral, NFT
principals, and any other shape the contract's
`_validatePostParallelSale` would reject, so you can't
accidentally tick it on an ineligible offer.

**What a buyer sees.**

- *Before any lender accepts* (Scenario A): a buyer who
  fills the OpenSea listing pays the listed price. On
  fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first; the executor passes only the
  **net proceeds** (listed price minus those marketplace /
  creator fee legs) to the diamond. The diamond escrows that
  net amount in your vault, the NFT transfers to the buyer,
  and the offer is marked `consumed_by_sale` (visible as a
  distinct "Sold" status in My Offers, Activity, and Offer
  Details). No loan was ever created; you keep the net sale
  proceeds.
- *After a lender accepts* (Scenario B): the listing
  carries through loan initiation only if it was already
  posted before acceptance, and only until the Seaport order's
  original expiry. Neither the borrower NFT lock nor the listing
  is torn down at acceptance, but lender acceptance also does not
  extend or repost the order for the full loan term. A later buyer
  fill before that expiry triggers the diamond's settlement
  waterfall in one Seaport transaction. Same fee-leg note as Scenario A:
  on fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first, and the executor passes only
  the **net proceeds** (sale price minus marketplace /
  creator fees) into the diamond's waterfall. The waterfall
  then routes that net amount: the lender receives their
  settlement entitlement (which `LibEntitlement.settlementInterest`
  computes as the full coupon when the loan was created with
  `useFullTermInterest = true`, or the pro-rata interest
  accrued to the settlement timestamp otherwise — the gate is
  the loan policy, not whether the sale happens before or
  after scheduled maturity), the treasury cut goes to
  treasury, and the remainder is deposited DIRECTLY into
  the current borrower-position NFT holder's vault (via
  `LibUserVault.getOrCreate` + a vault deposit). No Claim
  Center claim is created — check your vault balance after
  the sale lands.

**What you can't combine it with.** Two distinct conflict
classes, surfaced at different protocol stages:

- *Publish-time block (sibling loan-keyed listing).* If the
  loan already has a parallel-sale listing carrying through
  from offer-create AND the borrower then calls
  `NFTPrepayListingFacet.postPrepayListing` (or `updatePrepayListing`)
  to post a SECOND loan-keyed prepay listing on the same loan,
  the diamond reverts with `SiblingParallelSaleListingLive`.
  The conduit approval for the borrower's NFT is a single
  slot — running both listings concurrently would create an
  ambiguous approval. The borrower sees the revert at the
  publish/update call; nothing fills.
- *Fill-time block (open PrecloseFacet offset).* If the loan
  has an open PrecloseFacet offset offer AND a buyer later
  tries to fill the parallel-sale listing, the diamond's
  `_settleLoanFromParallelSale` reverts with
  `ParallelSaleBlockedByOpenOffsetOffer`. The listing remains
  valid on OpenSea but any fill attempt reverts until the
  offset link is cleared. The dapp does NOT currently surface
  a dedicated banner / notification on the Loan Details page
  for this combination; users will see fills revert and may
  need to inspect the revert reason on a block explorer to
  diagnose. The cleanup path is the ordinary offer-cancel
  surface — call `OfferCancelFacet.cancelOffer(offsetOfferId)`
  to cancel the offset offer, which releases the offset link
  and unblocks the parallel-sale fill (PrecloseFacet has no
  separate cancellation entry point; the offset is bound to
  the linked offer, so cancelling the linked offer clears it).
  A dedicated UI surface for the conflict is queued as a
  separate UX follow-up.



## [TRANSLATION NEEDED] EN source — Matching OpenSea offers on a prepay listing (target placement: `matching-opensea-offers-on-a-prepay-listing`)

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Matching OpenSea offers on a prepay listing

Once your prepay listing is live on OpenSea's marketplace,
casual buyers will sometimes place **item offers** directly
on your token — bids tied to your specific collateral, not
to any token in the collection. Vaipakam surfaces these item
offers on the Loan Details page in real time — a separate
panel under "List collateral on OpenSea" with one row per
incoming offer. The panel applies a **buffer threshold** —
the lender's settlement entitlement (which ALREADY INCLUDES
principal plus the full coupon for full-term-interest loans
or the pro-rata interest otherwise — see
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus the
treasury cut, plus a safety buffer — and **greys out** offers
that don't clear it. You can see market interest at every
level but can only Match offers that the protocol will
actually settle.

Collection-wide / criteria offers (bids that any token in
the collection can fulfill) stay on OpenSea but **don't
appear** in the dapp's Match panel — the multi-leg
consideration the protocol settles into can't be
reconstructed against a criteria offer without contract-side
plumbing that isn't in v1. If your only inbound demand is
collection-wide, the practical path today is to wait for
an item-specific bid OR to leave the listing at your fixed
ask and let any buyer fulfill it directly. You cannot
manually settle a collection-wide bid yourself — the
collateral NFT lives in your Vaipakam vault, and Vaipakam-
side Seaport orders are the only authorised settlement
shape.

On collections that enforce OpenSea protocol fees and/or
creator royalties, the dapp DOES render the offers panel —
the fee-schedule fetch from the OpenSea API is treated as
advisory; the actual fulfillment data is fetched at
Match-click time. If that fulfillment-data fetch fails (rate
limit, API outage, or unsupported collection shape), the
dapp-side Match click handler ABORTS before any
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` transaction
is constructed — no calldata, no signature prompt, no
revert. The on-chain function itself isn't a `bool`-returning
selector; when it does run it returns a `bytes32` order hash
or reverts. So a fee-enforced collection's panel may show
offers you can browse but not all of them are clickable-
to-match in a given moment.

When you find an acceptable offer and click **Match offer**,
the dapp opens the **Confirm Match** modal, which restates the
matched value (the gross OpenSea offer amount the panel showed
— NOT the net amount the diamond will settle at; on
fee-enforced collections `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
computes `effectiveAsk = offerValue - bidderFeeTotal` before
running the lender / treasury / borrower split, so the net the
diamond actually distributes is smaller than the modal's
headline) and gives a generic explanation of the atomic-match
flow. After you
confirm, the dapp sends a single `matchOpenSeaOffer`
transaction that bundles the bidder's offer with a freshly-
constructed diamond-side counter-order into one Seaport
`matchAdvancedOrders` call — the bidder's fulfilment, the
counter-order's listing-side leg (whether or not you had a
prior v1 prepay listing live; the atomic path supports
`existingHash == 0`), and the diamond's settlement waterfall
all land atomically in one block. The transaction either fully succeeds (loan
settled, NFT transferred, sale proceeds split) or fully
reverts (nothing moves), and there is **no window between
listing rotation and settlement** in which a third-party
buyer could step in at the matched price.

> **No race window — atomic by construction.** This is the
> structural close-out of the v1 two-step "cancel + post"
> pattern: under v1 the dapp would rotate the listing as a
> separate `updatePrepayListing` transaction, leaving the
> rotated price live on OpenSea until the bidder's
> `fulfillOrder` landed in a later block — anyone watching
> the mempool could snipe the bidder out of the price they
> bid. The atomic path closes that hole by binding both
> orders into one Seaport match call: either the bidder fills
> at the agreed price or the whole transaction reverts.

**What you still want to verify before clicking Match:**

- **Confirm the matched value in the modal.** The modal
  surfaces the gross OpenSea offer amount. On fee-enforced
  collections, the diamond settles against the net effective
  ask after bidder-side marketplace / creator fee legs, so the
  modal value can be higher than the amount used for the
  lender / treasury / borrower split. The bidder address and
  the precise split aren't broken out in either the modal OR
  the OpenSea Offers panel row (the row shows value, payment
  token, offer kind, truncated bidder, and end time). The split
  is enforced on-chain by the diamond at settlement — the
  protocol's settlement buffer guarantees the effective ask covers
  the lender's settlement entitlement (which already includes
  principal plus the full coupon on full-term-interest loans
  or the pro-rata interest otherwise) plus the
  treasury cut, so the split is always at least neutral for
  you. If you want to see the projected split before
  confirming, the diamond exposes
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  as a callable view — it returns the lender and treasury legs
  the settlement waterfall will route at the given timestamp,
  and the remainder is yours.
- **Check OpenSea's fee posture for the collection.** If the
  collection enforces OpenSea protocol fees or creator
  royalties, the atomic path needs SignedZone `extraData` /
  criteria-resolver plumbing that the dapp fetches via the
  agent's OpenSea fulfillment-data proxy (PR #349) AT MATCH
  CLICK TIME. The Match panel renders regardless of
  fee-schedule fetch status; the click-time fulfillment-data
  fetch is the gate. If that fetch fails (rate limit, API
  outage, unsupported collection shape), the dapp-side click
  handler aborts before constructing the on-chain
  `matchOpenSeaOffer` transaction — no calldata is built,
  no signature prompt fires, no banner is shown in advance.
  You can retry the click later (the fetch may have just
  been a transient API blip), or fill the listing directly
  on OpenSea at the listed ask in the meantime.


