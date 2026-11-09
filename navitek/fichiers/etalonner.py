# Navitek N0 — l'étalonnage : chaque articulation se mesure elle-même (MicroPython, Raspberry Pi Pico 2 W)
#
# Pour le « hack du potentiomètre » : un fil soudé sur la patte du milieu (le curseur) du potentiomètre de chaque servo,
# les 13 fils sur un multiplexeur analogique 16 voies CD74HC4067, sa sortie sur l'entrée analogique du Pico.
# Ouvrir ce fichier dans Thonny et cliquer « Exécuter » (ne pas l'enregistrer sous main.py). LE ROBOT SUSPENDU, pieds dans le vide.
#
# Pour chaque articulation, l'une après l'autre :
#   1. un petit balayage de -20° à +20° : la droite qui relie l'angle commandé à la tension du curseur ;
#   2. puis on avance de 5° en 5° de chaque côté, et on s'arrête dès que la mesure ne suit plus la droite : c'est la butée,
#      le point où l'articulation touche une pièce. Le servo ne force jamais plus d'un pas.
# Résultat : etalonnage.json sur le Pico (comptes par degré, mesure au neutre, plage réelle de chaque articulation), et un
# tableau à l'écran. Ensuite, lire_angle() donne la vraie position d'une articulation, et l'écart entre l'angle commandé et
# l'angle mesuré, robot debout, dit l'effort qu'elle fournit.
#
# Version 0.1 (09.11.2026) : éprouvé dans MuJoCo (R-046), qui a trouvé un défaut corrigé ici (le départ de chaque côté). Pas encore essayé sur un robot.
# Version 0 (08.11.2026) : écrit avec la CAO. Mesurer la tension du curseur au multimètre
# AVANT de brancher le multiplexeur : elle doit rester sous 3,3 V (sinon, un pont de résistances, voir la page).

from machine import Pin, PWM, ADC
import time
import json

# Les mêmes broches que main.py ; l'ordre est celui des canaux du multiplexeur (canal 0 = hanche gauche, etc.).
BROCHES = [
    ("hanche_g", 2), ("genou_g", 3), ("cheville_tangage_g", 4), ("cheville_roulis_g", 5),
    ("hanche_d", 6), ("genou_d", 7), ("cheville_tangage_d", 8), ("cheville_roulis_d", 9),
    ("epaule_g", 10), ("coude_g", 11), ("epaule_d", 12), ("coude_d", 13), ("cou", 14),
]
SELECT = [Pin(n, Pin.OUT) for n in (15, 16, 17, 18)]     # S0 à S3 du CD74HC4067
LECTURE = ADC(26)                                          # SIG du CD74HC4067 sur GP26 (ADC0)

PAS = 5            # degrés
ATTENTE_MS = 150   # le temps que le servo arrive
MAX_DEG = 70       # on ne cherche pas plus loin que ça
ECART_MAX = 4      # degrés : au-delà, la mesure ne suit plus, c'est une butée

servos = {}
for nom, broche in BROCHES:
    p = PWM(Pin(broche))
    p.freq(50)
    servos[nom] = p


def commander(nom, a):
    servos[nom].duty_ns(int((1500 + a * 2000 / 180) * 1000))


def lire(canal, n=16):
    """La tension du curseur d'un canal, en comptes de 0 à 65535, moyenne de n lectures."""
    for k in range(4):
        SELECT[k].value((canal >> k) & 1)
    time.sleep_us(500)                     # le multiplexeur et l'entrée se stabilisent
    s = 0
    for _ in range(n):
        s += LECTURE.read_u16()
    return s / n


def mesurer(canal, nom, a):
    commander(nom, a)
    time.sleep_ms(ATTENTE_MS)
    return lire(canal)


def droite(points):
    n = len(points)
    mx = sum(a for a, _ in points) / n
    my = sum(m for _, m in points) / n
    sxx = sum((a - mx) ** 2 for a, _ in points)
    sxy = sum((a - mx) * (m - my) for a, m in points)
    pente = sxy / sxx if sxx else 0.0
    return pente, my - pente * mx


def etalonner(canal, nom):
    for nom_autre, _ in BROCHES:
        commander(nom_autre, 0)
    time.sleep_ms(400)
    # Version 0.1 : se poser à -20° avant la droite. La version 0 lisait -20° juste après un saut de 20° depuis le neutre : le servo n'était pas
    # posé, la pente sortait fausse de 4 à 5 % (R-046), et l'écart de 4° était dépassé vers ±65° sans aucune butée.
    commander(nom, -20)
    time.sleep_ms(400)
    points = [(a, mesurer(canal, nom, a)) for a in range(-20, 21, PAS)]
    pente, zero = droite(points)
    if abs(pente) < 20:                   # la mesure ne bouge pas avec l'angle : le fil n'est pas branché
        commander(nom, 0)
        return {"erreur": "le capteur ne suit pas l'angle : vérifier le fil du curseur et le canal %d" % canal}
    # Version 0.1 : si la droite elle-même ne passe pas par ses points, une butée (ou un jeu) est entre -20 et +20° : le dire, plutôt que des plages fausses.
    pire = max(abs(m - (pente * a + zero)) / abs(pente) for a, m in points)
    if pire > ECART_MAX:
        commander(nom, 0)
        return {"erreur": "butée ou jeu entre -20 et +20° (écart de %.1f° à la droite) : vérifier à la main" % pire}
    bornes = []
    for sens in (1, -1):
        a = 20
        # Version 0.1 (09.11.2026, R-046) : aller d'abord au dernier point sûr de ce côté (±20°) et attendre. La version 0 sautait de 0 à -25°
        # en 150 ms : en simulation, une jambe chargée n'y arrivait pas, et l'algorithme voyait une fausse butée à -20° (hanche), -55° (cheville).
        commander(nom, sens * a)
        time.sleep_ms(400)
        while a < MAX_DEG:
            m = mesurer(canal, nom, sens * (a + PAS))
            if abs(m - (pente * sens * (a + PAS) + zero)) / abs(pente) > ECART_MAX:
                break                         # butée : on revient tout de suite
            a += PAS
        bornes.append(sens * a)
        commander(nom, 0)
        time.sleep_ms(400)
    return {"comptes_par_degre": round(pente, 1), "neutre": round(zero), "de": bornes[1], "a": bornes[0]}


def lire_angle(canal, etal):
    """La vraie position d'une articulation, en degrés autour du neutre, d'après son étalonnage."""
    return (lire(canal) - etal["neutre"]) / etal["comptes_par_degre"]


resultats = {}
print("Navitek N0 : étalonnage de %d articulations, robot suspendu." % len(BROCHES))
for canal, (nom, _) in enumerate(BROCHES):
    r = etalonner(canal, nom)
    resultats[nom] = r
    if "erreur" in r:
        print("%-20s %s" % (nom, r["erreur"]))
    else:
        print("%-20s %6.1f comptes/degré   neutre %5d   plage réelle %+d° à %+d°" % (nom, r["comptes_par_degre"], r["neutre"], r["de"], r["a"]))
for nom, _ in BROCHES:
    commander(nom, 0)
with open("etalonnage.json", "w") as f:
    json.dump(resultats, f)
print("Enregistré dans etalonnage.json. Les plages réelles remplacent les BORNES de main.py.")
