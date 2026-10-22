# Russound pour Gladys

Pilotez depuis Gladys chaque **zone** de vos contrôleurs multiroom
**Russound** dotés du protocole RIO sur leur port réseau (MCA-66, MCA-88,
MCA-88X, MCA-C3, MCA-C5, MBX-PRE, MBX-AMP…), en local, sans aucun cloud :
allumage, veille, volume (plafonné), sourdine, source et lecture en cours.

> **Important.** Cette intégration n'a jamais été testée avec un vrai
> appareil : elle a été écrite à partir de la bibliothèque `aiorussound`
> (celle qu'utilise Home Assistant) et testée avec un faux contrôleur
> seulement. Vos retours sont les bienvenus. Intégration non officielle, sans
> lien avec Russound.

## Installation

1. Branchez le contrôleur sur votre réseau et donnez-lui une **adresse IP
   fixe** dans votre box (bail DHCP réservé).
2. Dans Gladys, installez l'intégration **Russound**, puis ouvrez sa
   configuration.
3. Saisissez les adresses IP des contrôleurs, séparées par des virgules (par
   exemple `192.168.1.40`). Le port RIO est le 9621 ; pour un autre,
   ajoutez-le : `192.168.1.40:9622`. Une seule adresse suffit pour des
   contrôleurs chaînés en RNET derrière le premier.
4. Choisissez le **plafond de volume** (25 sur 50 par défaut).
5. Les zones apparaissent dans l'onglet **Découverte** (une par zone
   nommée) : créez celles que vous voulez.

L'intégration garde une connexion ouverte avec chaque contrôleur et suit
chaque zone et chaque source : ce qui est changé sur un clavier, une
télécommande ou l'application s'affiche aussitôt dans Gladys. Les zones sont
aussi relues chaque minute.

Seul le port réseau est pris en charge : le **port série RS-232** ne l'est
pas (une intégration Gladys tourne dans un conteneur sans accès au port
série), pas plus que le protocole RNET seul des anciens modèles (CAV, CAM)
sans port RIO.

## Ce que vous obtenez, pour chaque zone

| Fonction         | Type Gladys                    | Remarque                                                  |
| ---------------- | ------------------------------ | --------------------------------------------------------- |
| Marche           | état binaire (lecture seule)   | 1 zone allumée, 0 éteinte ou contrôleur injoignable       |
| Allumer          | bouton                         | `ZoneOn`                                                  |
| Veille           | bouton                         | `ZoneOff`                                                 |
| Volume           | musique / volume (0 à 100)     | 100 % = le plafond                                        |
| Sourdine         | bouton (télévision / sourdine) | chaque appui lit l'état, puis règle l'inverse             |
| Source           | liste déroulante               | les sources nommées du contrôleur                         |
| Lecture en cours | texte (lecture seule)          | « artiste - titre », ou la station ; vide si zone éteinte |

Volontairement, aucun **interrupteur** : un « éteins tout » ou « allume
tout » d'un assistant vocal ou d'une scène n'allume ni n'éteint vos zones.

## Plafond de volume

Les contrôleurs Russound comptent le volume de 0 à 50. Dans Gladys, le volume
va de 0 à 100 % : 100 % est le **plafond** de la configuration (25 par
défaut). Gladys (tableau de bord, scène, assistant vocal) ne peut jamais
régler un volume au-dessus du plafond. Le plafond est relu juste avant
l'envoi : une nouvelle valeur enregistrée s'applique aussitôt.

Le volume réglé sur un clavier ou une télécommande n'est pas modifié par
l'intégration (au-dessus du plafond, Gladys affiche 100 %), sauf dans les deux
cas où Gladys le rendrait audible :

- **Retrait de la sourdine** : si le volume de la zone dépasse le plafond, il
  est d'abord ramené au plafond, puis la sourdine est retirée. Si le volume ne
  peut pas être lu, rien n'est envoyé ; si le contrôleur ne confirme pas la
  baisse, la sourdine est gardée.
- **Allumage** : une zone s'allume à son « volume d'allumage » ; s'il dépasse
  le plafond, il y est ramené, jusqu'à ce que le contrôleur confirme un volume
  au plafond ou en dessous. Si la zone tarde, l'intégration vérifie encore
  quelques fois pendant environ 15 secondes, et baisse un volume signalé
  au-dessus du plafond pendant ce temps.

## Commandes

Une commande n'est réussie que si la valeur relue sur le contrôleur est celle
demandée. Chaque commande reçoit une réponse en moins de 4 secondes (Gladys
attend 5 secondes). Une commande partie sans confirmation est signalée
« envoyée, sans confirmation » ; une commande qui n'a pas pu partir est
signalée « rien n'a été envoyé ». Une rafale de commandes (un curseur de
volume glissé) ne coupe jamais la connexion : celles qui arrivent trop tard
sont refusées sans rien envoyer. Huit commandes au plus attendent par zone.

La **source** ne se choisit que sur une zone allumée (relue juste avant) :
sur une zone éteinte, elle est refusée sans rien envoyer, car choisir une
source pourrait allumer la zone à son volume d'allumage, sans le plafond.
Allumez d'abord la zone.

La **veille** passe avant toutes les commandes en attente, annule un
allumage, une source ou un volume encore en attente (une commande déjà en
cours n'envoie plus rien après elle), et reste possible juste après un
redémarrage, avant la première lecture complète : si la connexion attend son
prochain essai, elle est ouverte aussitôt. Une veille non confirmée est relue
et renvoyée jusqu'à trois fois en 15 secondes, sauf si un allumage est
demandé dans Gladys entre-temps ; une zone rallumée au clavier pendant ce
temps peut donc être éteinte à nouveau.

La **sourdine** utilise les commandes explicites `ZoneMuteOn` / `ZoneMuteOff`
(RIO 1.09.00 ou plus récent) ; sur un micrologiciel plus ancien, qui ne sait
que basculer la sourdine, elle est refusée sans rien envoyer.

## Identité des zones

Chaque zone est reconnue par l'adresse du contrôleur, le numéro du contrôleur
et celui de la zone (par exemple `192.168.1.40_c1_z3`) : gardez une adresse
IP fixe. L'adresse MAC du contrôleur, quand il la donne, est retenue : si un
autre contrôleur répond un jour à cette adresse (échange DHCP), ses zones ne
sont ni lues ni commandées et le statut le signale. Si vous avez remplacé le
contrôleur, retirez son adresse de la configuration, supprimez ses zones dans
Gladys, puis ajoutez-le à nouveau. Une adresse MAC illisible n'est jamais
prise pour un autre contrôleur.

## Reconnexion

Un contrôleur qui ne répond pas (éteint, débranché) affiche la marche de ses
zones à 0 et est signalé dans le statut de l'intégration. L'intégration se
reconnecte après 10 s, puis à intervalles doublés après chaque échec, jusqu'à
5 minutes ; une question sans réponse ferme la connexion, puis la même
reconnexion espacée s'applique. L'heure du dernier essai est gardée : un
redémarrage de l'intégration n'interroge jamais le contrôleur plus vite.

## Bouton de configuration

- **Vérifier les contrôleurs** : la connexion, la version RIO, l'adresse MAC
  et le nombre de zones de chaque contrôleur, l'état de chaque zone (marche,
  volume sur 50, sourdine, source), et le plafond en vigueur.

## Données et vie privée

L'intégration ne demande ni compte ni mot de passe : le port RIO n'en a pas.
Elle garde dans `/data/russound.json` les zones connues (adresse, numéros,
nom, sources), et pour chaque adresse l'adresse MAC du contrôleur, l'heure du
dernier essai de connexion et le nombre d'échecs. Rien ne sort de votre
réseau local.

## Limites connues

- Pas encore de lecture / pause / suivant, de préréglages de tuner, de
  graves, aigus, balance, loudness, mode fête ni de « ne pas déranger ».
- La liste des sources ne tient pas compte des sources désactivées pour une
  zone.
- Utilité limitée en France, en Belgique et en Suisse : Russound est surtout
  installé en Amérique du Nord.
- Jamais testé avec un vrai appareil : les vraies réponses peuvent différer.
