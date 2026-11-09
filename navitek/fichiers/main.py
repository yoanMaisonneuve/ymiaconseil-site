# Navitek N0 — le programme du robot (MicroPython, Raspberry Pi Pico 2 W)
#
# Copier ce fichier sur le Pico sous le nom main.py (Thonny : Fichier > Enregistrer sous > Raspberry Pi Pico).
# Au démarrage, MODE = "centrer" : les 13 servos vont à leur neutre (90°) et y restent. C'est l'étape du montage où l'on pose
# les palonniers : chaque pièce droite pendant que le servo est au neutre. Une fois le robot monté, MODE = "demo".
#
# Version 0 (08.11.2026) : écrit avec la CAO, pas encore essayé sur un robot imprimé. Le sens de chaque servo (SENS) et
# son réglage fin (TRIM) se règlent sur le vrai robot.
#
# Câblage : le signal de chaque servo sur sa broche (BROCHES) ; le + des servos directement sur les piles (4 x AA NiMH,
# 4,8 V), jamais par le Pico ; le Pico sur VSYS par une diode Schottky ; toutes les masses ensemble ; un condensateur de
# 470 à 1000 uF sur le + des servos.

from machine import Pin, PWM
import time

MODE = "centrer"          # "centrer" pendant le montage, puis "demo"

BROCHES = {
    "hanche_g": 2, "genou_g": 3, "cheville_tangage_g": 4, "cheville_roulis_g": 5,
    "hanche_d": 6, "genou_d": 7, "cheville_tangage_d": 8, "cheville_roulis_d": 9,
    "epaule_g": 10, "coude_g": 11,
    "epaule_d": 12, "coude_d": 13,
    "cou": 14,
}
# Le côté droit est monté en miroir du gauche : le même geste demande l'angle opposé.
SENS = {nom: (-1 if nom.endswith("_d") else 1) for nom in BROCHES}
# Ce qui reste de travers au neutre, en degrés, servo par servo (à régler sur le robot monté).
TRIM = {nom: 0 for nom in BROCHES}
# Les bornes de chaque articulation, en degrés autour du neutre : le robot ne se cogne pas lui-même.
BORNES = {nom: (-60, 60) for nom in BROCHES}
BORNES.update({"genou_g": (-10, 90), "genou_d": (-10, 90), "cou": (-80, 80)})
# Simulation MuJoCo + FCL (navitek-sim, essai T4, 08.11.2026) : les pieds se touchent dès 7° de cheville-roulis vers l'intérieur
# (le reste, ±60°, ne heurte rien). Dans l'angle de la charnière, l'intérieur est + à gauche et - à droite.
BORNES.update({"cheville_roulis_g": (-60, 7), "cheville_roulis_d": (-7, 60)})

MIN_US, MAX_US = 500, 2500    # 0° et 180° pour un SG90 ou un MG90S ; certains servos préfèrent 600 à 2400

servos = {}
actuel = {}
for nom, broche in BROCHES.items():
    p = PWM(Pin(broche))
    p.freq(50)
    servos[nom] = p
    actuel[nom] = 0.0
led = Pin("LED", Pin.OUT)


def ecrire(nom, a):
    """Envoie un angle (degrés autour du neutre) au servo, borné, avec son sens et son réglage fin."""
    lo, hi = BORNES[nom]
    a = max(lo, min(hi, a))
    actuel[nom] = a
    b = SENS[nom] * a + TRIM[nom]
    us = 1500 + b * (MAX_US - MIN_US) / 180
    servos[nom].duty_ns(int(us * 1000))


def pose(cible, duree=0.6, pas=30):
    """Va doucement vers une pose {articulation: angle} ; les articulations absentes ne bougent pas."""
    depart = dict(actuel)
    for k in range(1, pas + 1):
        t = k / pas
        t = t * t * (3 - 2 * t)                      # départ et arrivée en douceur
        for nom, a in cible.items():
            ecrire(nom, depart[nom] + (a - depart[nom]) * t)
        time.sleep(duree / pas)


def centrer():
    for nom in BROCHES:
        ecrire(nom, 0)


DEBOUT = {nom: 0 for nom in BROCHES}


def accroupi(f=1.0):
    """Plier les deux jambes : la hanche et la cheville compensent le genou, le torse reste droit."""
    a = 35 * f
    return {"hanche_g": -a, "genou_g": 2 * a, "cheville_tangage_g": -a,
            "hanche_d": -a, "genou_d": 2 * a, "cheville_tangage_d": -a}


def salut():
    pose({"epaule_d": -60, "coude_d": 40}, 0.7)
    for _ in range(3):
        pose({"coude_d": 10}, 0.3)
        pose({"coude_d": 50}, 0.3)
    pose({"epaule_d": 0, "coude_d": 0}, 0.7)


def non_de_la_tete():
    for a in (35, -35, 35, 0):
        pose({"cou": a}, 0.35)


def demo():
    pose(DEBOUT, 1.0)
    time.sleep(0.5)
    non_de_la_tete()
    salut()
    for _ in range(2):
        pose(accroupi(1.0), 0.9)
        pose(DEBOUT, 0.9)


centrer()
if MODE == "centrer":
    while True:                      # les servos restent au neutre ; la DEL clignote lentement
        led.toggle()
        time.sleep(0.5)
else:
    time.sleep(1.0)
    while True:
        led.on()
        demo()
        led.off()
        time.sleep(3)
