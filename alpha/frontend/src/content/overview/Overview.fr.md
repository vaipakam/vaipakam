# Bienvenue sur Vaipakam

Vaipakam est une plateforme de prêt entre pairs. Vous prêtez des
actifs et touchez des intérêts. Vous empruntez des actifs et apportez
une garantie. Vous louez des NFT et le propriétaire perçoit des
loyers journaliers. Tout se passe directement entre deux portefeuilles,
les contrats intelligents conservant les actifs en vault jusqu'à
la fin du prêt ou de la location.

Cette page est la **visite guidée accessible**. Si vous cherchez plus
de profondeur technique, utilisez l'onglet **Guide d'utilisation**
pour une aide écran par écran, ou l'onglet **Technique** pour le
whitepaper complet. Si vous voulez simplement comprendre « ce que
c'est et comment l'utiliser » — continuez.

---

## Ce que vous pouvez faire

Vaipakam s'adresse à quatre types de personnes :

- **Prêteurs** — vous avez un actif (USDC, ETH, USDT, etc.) qui dort
  dans votre portefeuille. Vous aimeriez qu'il produise des intérêts
  sans renoncer à la sécurité. Vous publiez une offre de prêt ; un
  emprunteur l'accepte ; vous gagnez des intérêts selon vos propres
  conditions.
- **Emprunteurs** — vous avez besoin de liquidités pour quelques
  jours, semaines ou mois et vous ne voulez pas vendre votre garantie
  (parce que vous pensez qu'elle va monter, ou parce que c'est un NFT
  que vous ne pouvez pas céder). Vous apportez votre garantie ;
  vous recevez le prêt ; vous le remboursez au taux convenu.
- **Propriétaires de NFT** — vous avez un NFT précieux qui octroie
  une utilité dans un jeu ou une app. Le vendre signifierait perdre
  cette utilité pour toujours. Le louer permet à quelqu'un d'autre
  de l'utiliser pendant quelques jours pendant que vous gardez la
  propriété et collectez un loyer journalier.
- **Locataires de NFT** — vous voulez accéder temporairement à un NFT
  (un objet de jeu, un pass d'adhésion, un domaine) sans payer le
  prix complet. Vous le louez, vous l'utilisez pendant la période,
  et le propriétaire conserve l'actif.

Vous ne créez pas de compte. Vous ne remplissez pas de profil. Vous
connectez un portefeuille et vous pouvez prêter, emprunter ou louer.

---

## Comment fonctionne un prêt (exemple concret)

Supposons que vous avez **1 000 USDC** qui dorment dans votre
portefeuille sur Base. Vous aimeriez gagner des intérêts. Voici le
cycle de vie complet.

### Étape 1 — Créer une offre

Vous ouvrez l'app Vaipakam, vous connectez votre portefeuille, et
vous cliquez sur **Créer une offre**. Vous êtes prêteur, donc vous
remplissez :

- Je prête **1 000 USDC**
- Je veux **8 % APR**
- Garantie acceptable : **WETH**, avec **LTV maximum 70 %**
- Durée du prêt : **30 jours**

Vous signez une transaction. Vos 1 000 USDC passent de votre
portefeuille à votre **vault personnel** (un coffre privé que
vous seul contrôlez). Ils y restent jusqu'à ce qu'un emprunteur
accepte votre offre.

### Étape 2 — Un emprunteur accepte

Une heure plus tard, peut-être, quelqu'un voit votre offre dans le
**Carnet d'offres**. Cette personne détient du WETH et souhaite
emprunter de l'USDC contre cette garantie pendant un mois. Elle clique sur **Accepter** et
apporte du WETH d'une valeur, disons, de 1 500 $ (un LTV d'environ
67 % — sous votre plafond de 70 %, donc l'offre s'accepte).

Au moment où l'acceptation se déclenche :

- Vos 1 000 USDC passent de votre Vaipakam Vault au sien
- Son WETH est verrouillé dans son vault comme garantie
- Vous recevez chacun un NFT de position — le vôtre dit « on me doit
  1 000 USDC + intérêts » ; le sien dit « on me doit mon WETH au
  remboursement »
- Le compteur du prêt démarre

De modestes **frais d'initiation du prêt (0,1 %)** sont prélevés sur
le montant prêté et dirigés vers le trésor du protocole. L'emprunteur
reçoit donc 999 USDC, pas 1 000. (Vous pouvez payer ces frais en
**VPFI** à la place et l'emprunteur reçoit alors les 1 000 complets
— plus de détails sur VPFI ci-dessous.)

### Étape 3 — Le temps passe ; l'emprunteur rembourse

Au bout de 30 jours, l'emprunteur vous doit le principal plus les
intérêts :

```
Intérêts = 1 000 USDC × 8 % × (30 / 365) = ~6,58 USDC
```

Il clique sur **Rembourser**, signe une transaction, et 1 006,58 USDC
arrivent dans le règlement du prêt. À partir de là :

- Vous recevez **1 005,51 USDC** (principal + intérêts, moins une
  commission de rendement de 1 % appliquée uniquement aux intérêts)
- Le trésor reçoit **1,07 USDC** au titre de la commission de rendement
- Le WETH de l'emprunteur est déverrouillé

Vous voyez un bouton **Réclamer** sur votre tableau de bord. Vous
cliquez et les 1 005,51 USDC passent du règlement à votre
portefeuille. L'emprunteur clique sur réclamer et son WETH revient
dans son portefeuille. Le prêt est clôturé.

### Étape 4 — Et si l'emprunteur ne rembourse pas ?

Deux choses peuvent mal tourner, et le protocole gère chacune
automatiquement.

**Le prix de la garantie s'effondre en cours de prêt.** Vaipakam
suit le **Facteur de Santé** (un seul nombre qui compare la valeur
de la garantie à la dette) de chaque prêt. S'il descend sous 1,0,
n'importe qui — oui, n'importe qui, y compris un bot de passage —
peut appeler **Liquider**. Le protocole route la garantie à travers
jusqu'à quatre agrégateurs DEX (0x, 1inch, Uniswap, Balancer),
prend la meilleure exécution, vous rembourse ce qui vous est dû,
verse une petite prime au liquidateur, et renvoie tout reliquat à
l'emprunteur.

**L'emprunteur disparaît après l'échéance.** Après une **période de
grâce** configurable (une heure pour les prêts courts, deux semaines
pour ceux d'un an), n'importe qui peut appeler **Défaut**. Le même
chemin de liquidation s'exécute.

Dans des cas rares — chaque agrégateur renvoie un mauvais prix, ou
la garantie a chuté trop bas — le protocole *refuse de vendre* dans
un mauvais marché. À la place, vous recevez la garantie elle-même
plus une petite prime, et vous pouvez la conserver ou la vendre
quand vous le souhaitez. Cette **voie de repli** est documentée
d'avance et vous l'acceptez dans le cadre des conditions du prêt.

### Étape 5 — N'importe qui peut rembourser

Si un ami ou un keeper délégué veut solder le prêt de votre
emprunteur, il peut. La garantie revient toujours à l'emprunteur
(pas au tiers serviable). C'est une porte à sens unique : payer le
prêt de quelqu'un d'autre ne vous donne pas sa garantie.

---

## Comment fonctionnent les locations de NFT

Même flux qu'un prêt, avec deux différences :

- **Le NFT reste en vault** ; le locataire ne le détient jamais
  directement. À la place, le protocole utilise **ERC-4907** pour
  donner au locataire des « droits d'utilisation » sur le NFT
  pendant la fenêtre de location. Les jeux et apps compatibles
  lisent les droits d'utilisation, donc le locataire peut jouer, se
  connecter ou utiliser l'utilité du NFT sans le posséder.
- **Les frais journaliers se déduisent automatiquement** d'un
  pool prépayé. Le locataire prépaie la totalité de la location à
  l'avance plus 5 % de marge. Chaque jour le protocole libère les
  frais du jour au propriétaire. Si le locataire veut terminer plus
  tôt, les jours non utilisés sont remboursés.

Quand la location se termine (par expiration ou par défaut), le
NFT retourne dans le vault du propriétaire. Le propriétaire peut
alors le re-lister ou le rappeler dans son portefeuille.

---

## Qu'est-ce qui me protège ?

Prêter et emprunter sur Vaipakam n'est pas sans risque. Mais le
protocole intègre plusieurs couches :

- **Vault par utilisateur.** Vos actifs restent dans votre
  propre coffre. Le protocole ne les met jamais en commun avec les
  fonds d'autres utilisateurs. Cela signifie qu'un bug affectant un
  autre utilisateur ne peut pas vider votre position.
- **Application du Facteur de Santé.** Un prêt ne peut démarrer que
  si la garantie vaut au moins 1,5× le montant du prêt à
  l'origination. Si le prix bouge contre l'emprunteur en cours de
  prêt, n'importe qui peut liquider avant que la garantie ne vaille
  moins que la dette — ce qui protège le prêteur.
- **Oracle de prix multi-source.** Les prix viennent d'abord de
  Chainlink, puis sont recoupés avec Tellor, API3 et DIA. S'ils
  divergent au-delà d'un seuil configuré, le prêt ne peut pas
  s'ouvrir et une position en cours ne peut pas être liquidée
  injustement. Un attaquant devrait corrompre **plusieurs oracles
  indépendants dans le même bloc** pour falsifier un prix.
- **Plafond de slippage.** Les liquidations refusent de vendre la
  garantie avec plus de 6 % de slippage. Si le marché est trop
  fin, le protocole bascule pour vous donner la garantie
  directement.
- **Prise en compte du séquenceur L2.** Sur les chaînes L2, la
  liquidation se met en pause brièvement quand le séquenceur de la
  chaîne vient juste de redémarrer, pour que les attaquants ne
  puissent pas exploiter la fenêtre de prix obsolète pour vous
  nuire.
- **Interrupteurs de pause.** Chaque contrat a des leviers de pause
  d'urgence pour que l'opérateur puisse stopper toute nouvelle
  activité en quelques secondes si quelque chose semble anormal,
  tout en laissant les utilisateurs existants clôturer leurs
  positions en sécurité.
- **Audits indépendants.** Chaque contrat sur chaque chaîne ne sort
  qu'après une revue de sécurité par un tiers. Les rapports d'audit
  et le périmètre du bug bounty sont publics.

Vous devez quand même comprendre ce dans quoi vous vous engagez.
Lisez le **consentement de risque** combiné qui apparaît avant
chaque prêt — il explique la voie de repli en marché anormal et la
voie de règlement en nature pour les garanties illiquides. L'app ne
vous laissera pas accepter sans cocher la case de consentement.

---

## Combien ça coûte ?

Deux frais, tous les deux modestes :

- **Commission de Rendement — `{liveValue:treasuryFeeBps}` %** des
  **intérêts** que vous gagnez en tant que prêteur (pas du
  principal). Sur un prêt à 30 jours à 8 % APR de 1 000 USDC, le
  prêteur gagne ~6,58 USDC d'intérêts, dont ~0,066 USDC sont la
  Commission de Rendement au taux par défaut.
- **Frais d'Initiation du Prêt — `{liveValue:loanInitiationFeeBps}` %**
  du montant prêté, payés par l'emprunteur à l'origination. Sur un
  prêt de 1 000 USDC, c'est 1 USDC au taux par défaut.

Les deux frais peuvent bénéficier d'une **remise allant jusqu'à
`{liveValue:tier4DiscountBps}` %** en détenant du VPFI en vault
(voir ci-dessous). En cas de défaut ou de liquidation, aucune
Commission de Rendement n'est prélevée sur les intérêts récupérés —
le protocole ne tire pas profit d'un prêt qui échoue.

Pas de frais de retrait, pas de frais d'inactivité, pas de frais de
streaming, pas de commissions « de performance » sur le principal.
Les seuls montants prélevés par le protocole sont les deux frais
ci-dessus.

> **Remarque sur les frais de réseau (gas) de la blockchain.**
> Quand vous créez une offre, acceptez un prêt, remboursez,
> réclamez ou effectuez toute autre action on-chain, vous payez
> aussi de petits **frais de gas** aux validateurs de la blockchain
> qui incluent votre transaction dans un bloc. Ces frais de gas
> vont au réseau, **pas à Vaipakam** — ce sont les mêmes frais que
> vous paieriez pour envoyer n'importe quel token sur la même
> chaîne. Le montant dépend de la chaîne et de la congestion du
> réseau au moment de la transaction, pas de la taille de votre
> prêt. Les frais de protocole ci-dessus (Commission de Rendement
> `{liveValue:treasuryFeeBps}` %, Frais d'Initiation du Prêt
> `{liveValue:loanInitiationFeeBps}` %) sont entièrement séparés du
> gas et sont les seuls que le protocole lui-même prélève.

---

## Qu'est-ce que VPFI ?

**VPFI** est le token utilitaire de Vaipakam. Il fait trois choses :

### 1. Remises sur les frais

Si vous détenez du VPFI dans votre Vaipakam Vault sur une chaîne, cela
réduit vos frais de protocole sur les prêts auxquels vous participez
sur cette chaîne :

| VPFI en vault | Remise sur les frais |
|---|---|
| `{liveValue:tier1Min}` – `{liveValue:tier2Min}` (excl.) | `{liveValue:tier1DiscountBps}` % |
| `{liveValue:tier2Min}` – `{liveValue:tier3Min}` (excl.) | `{liveValue:tier2DiscountBps}` % |
| `{liveValue:tier3Min}` – `{liveValue:tier4Min}` | `{liveValue:tier3DiscountBps}` % |
| Au-delà de `{liveValue:tier4Min}` | `{liveValue:tier4DiscountBps}` % |

Les remises s'appliquent à la fois aux frais du prêteur et de
l'emprunteur. La remise est **pondérée dans le temps sur la durée
du prêt**, donc recharger juste avant la fin d'un prêt ne biaise
pas le calcul — vous gagnez la remise au prorata du temps pendant
lequel vous avez réellement détenu le palier.

### 2. Staking — 5 % APR

Tout VPFI posé dans votre Vaipakam Vault génère automatiquement des
récompenses de staking au rendement annuel de 5 %. Pas d'action de
staking séparée, pas de blocage, pas d'attente pour « unstake ».
Déplacez du VPFI dans votre Vaipakam Vault et il rapporte à partir de
ce moment. Sortez-le et l'accumulation s'arrête.

### 3. Récompenses d'interaction sur la plateforme

Chaque jour, un pool fixe de VPFI est distribué aux prêteurs et
emprunteurs au prorata des **intérêts** brassés à travers le
protocole. Vous touchez une part si vous avez gagné des intérêts en
prêteur, ou si vous avez payé des intérêts proprement en emprunteur
(sans frais de retard, sans défaut).

Le pool de récompenses est le plus grand sur les six premiers mois
et diminue sur sept ans. Les premiers utilisateurs touchent les plus
grosses émissions.

### Comment obtenir du VPFI

Trois voies :

- **Le gagner** — en participant (récompenses d'interaction
  ci-dessus).
- **L'acheter** — à un taux fixe (`1 VPFI = 0,001 ETH`) sur la page
  **Acheter VPFI**. Le programme à taux fixe est plafonné par
  portefeuille par chaîne.
- **Le transférer par bridge** — VPFI est un token LayerZero OFT V2,
  donc il circule entre les chaînes prises en charge via le bridge
  officiel.

---

## Quelles chaînes ?

Vaipakam tourne comme un déploiement indépendant sur chaque chaîne
supportée : **Ethereum**, **Base**, **Arbitrum**, **Optimism**,
**Polygon zkEVM**, **BNB Chain**.

Un prêt ouvert sur Base se règle sur Base. Un prêt ouvert sur
Arbitrum se règle sur Arbitrum. Il n'y a pas de dette inter-chaîne. La seule
chose qui traverse les chaînes, c'est le token VPFI et le
dénominateur quotidien des récompenses (qui s'assure que les
récompenses restent équitables entre chaînes très actives et chaînes plus calmes).

---

## Par où commencer

Si vous voulez **prêter** :

1. Ouvrez l'app Vaipakam, connectez votre portefeuille.
2. Allez sur **Créer une offre**, choisissez « Prêteur ».
3. Définissez votre actif, le montant, l'APR, la garantie acceptée
   et la durée.
4. Signez deux transactions (une approbation, une création) et votre
   offre est en ligne.
5. Attendez qu'un emprunteur accepte. Le tableau de bord montre vos
   prêts actifs.

Si vous voulez **emprunter** :

1. Ouvrez l'app, connectez votre portefeuille.
2. Parcourez le **Carnet d'offres** pour trouver une offre qui
   correspond à votre garantie et à l'APR que vous pouvez payer.
3. Cliquez sur **Accepter**, signez deux transactions, et vous
   recevez le montant du prêt dans votre portefeuille (moins les
   Frais d'Initiation de 0,1 %).
4. Remboursez avant la date d'échéance plus la période de grâce.
   Votre garantie repart vers votre portefeuille.

Si vous voulez **louer ou lister un NFT** :

Même flux, mais sur la page **Créer une offre** vous choisissez
« Location de NFT » au lieu de prêt ERC-20. Le formulaire vous
guidera.

Si vous voulez juste **gagner du rendement passif sur votre VPFI**,
déposez-le dans votre Vaipakam Vault depuis la page **Tableau de bord**.
C'est tout — le staking est automatique à partir de ce moment.

---

## Une note sur ce que nous *ne faisons pas*

Quelques choses que d'autres plateformes DeFi font et que nous
**ne faisons** délibérément pas :

- **Pas de prêts en pool.** Chaque prêt est entre deux portefeuilles
  spécifiques avec des conditions auxquelles ils ont tous deux
  consenti. Pas de pool de liquidité partagé, pas de courbe
  d'utilisation, pas de pic de taux surprise.
- **Pas de garde par proxy.** Vos actifs reposent dans votre propre
  vault, pas dans un coffre partagé. Le protocole ne les déplace
  qu'au gré des actions que vous signez.
- **Pas de boucles de levier par défaut.** Vous pouvez republier
  des fonds empruntés comme nouvelle offre de prêteur si vous le
  souhaitez, mais le protocole n'intègre pas le bouclage automatique
  dans l'UX. Nous considérons que c'est un piège facile à déclencher.
- **Pas de mises à jour surprise.** Les mises à jour du vault
  sont contrôlées ; les mises à jour obligatoires apparaissent dans
  l'app pour que vous les appliquiez explicitement. Rien ne
  réécrit votre coffre dans votre dos.

---

## Besoin d'en savoir plus ?

- L'onglet **Guide d'utilisation** parcourt chaque écran de l'app
  carte par carte. Bon pour les questions « à quoi sert ce
  bouton ? ».
- L'onglet **Technique** est le whitepaper complet. Bon pour les
  questions « comment fonctionne réellement le moteur de
  liquidation ? ».
- La page **FAQ** traite les questions les plus courantes en une
  ligne.
- Le Discord et le repo GitHub sont liés depuis le pied de l'app.

C'est ça, Vaipakam. Connectez un portefeuille et vous y êtes.
