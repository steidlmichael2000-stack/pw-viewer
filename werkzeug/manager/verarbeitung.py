"""PW-Viewer-Manager — alles außer der Oberfläche.

Läuft unter Windows und Linux gleich. Jede Funktion bekommt `melden(text)`
für den Fortschritt; Fehler gehen als Exception mit verständlichem Text hinaus.

Ablauf eines Projekts:
  vorbereiten()  → daten-lokal/<name>/ (cloud.laz, model.glb, thumb.jpg, eintrag.json)
                   zum Ansehen auf localhost, nichts ist online
  veroeffentlichen() → R2 hochladen, pointclouds.json + p/<name>.html, git push
"""
from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HIER = Path(__file__).resolve().parent
REPO = HIER.parent.parent                     # pw-viewer/
LOKAL = REPO / "daten-lokal"
JSON_PFAD = REPO / "pointclouds.json"
P_ORDNER = REPO / "p"

R2_REMOTE = os.environ.get("PW_R2_REMOTE", "r2:pointclouds")
R2_BASE = "https://pwviewer-daten.steidl-michael2000.workers.dev"
SEITE = "https://steidlmichael2000-stack.github.io/pw-viewer"
LIMIT_GB = 10.0                              # Freikontingent R2

TEXTUR_MAX = 4096                            # so gewählt am 06.11.2026 (2048 war matschig)
WEBP_QUALITAET = 90
POTREE_DATEIEN = ["metadata.json", "hierarchy.bin", "octree.bin", "log.txt"]

WINDOWS = sys.platform.startswith("win")


class Fehler(Exception):
    """Fehler mit Text für den Nutzer."""


# ---------------------------------------------------------------- Werkzeuge

def rclone() -> str:
    p = shutil.which("rclone")
    if not p and WINDOWS:
        basis = Path(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages"))
        for k in sorted(basis.glob("Rclone.Rclone_*/rclone-*/rclone.exe"), reverse=True):
            return str(k)
    if not p:
        raise Fehler("rclone nicht gefunden. Unter Linux: sudo apt install rclone, unter Windows: winget install Rclone.Rclone")
    return p


def node() -> str:
    p = shutil.which("node") or (r"C:\Program Files\nodejs\node.exe" if WINDOWS and os.path.exists(r"C:\Program Files\nodejs\node.exe") else None)
    if not p:
        raise Fehler("Node.js nicht gefunden (für das 3D-Modell nötig).")
    return p


def _node_werkzeug(rel: str) -> str:
    p = HIER / "node_modules" / rel
    if not p.exists():
        raise Fehler("Die Modell-Werkzeuge fehlen — einmal einrichten.sh bzw. einrichten.bat ausführen.")
    return str(p)


def lauf(befehl: list[str], melden=None, cwd=None) -> str:
    """Programm ausführen; bei Fehler mit den letzten Zeilen der Ausgabe."""
    erg = subprocess.run(befehl, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                         creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
    if erg.returncode != 0:
        rest = "\n".join((erg.stderr or erg.stdout).strip().splitlines()[-6:])
        raise Fehler(f"{Path(befehl[0]).name} {' '.join(befehl[1:2])} ist fehlgeschlagen:\n{rest}")
    return erg.stdout


def cloudcompare() -> list[str] | None:
    """Aufruf von CloudCompare ohne Fenster, falls installiert."""
    if WINDOWS:
        for k in [r"C:\Program Files\CloudCompare\CloudCompare.exe", r"C:\Program Files (x86)\CloudCompare\CloudCompare.exe"]:
            if os.path.exists(k):
                return [k]
        return None
    if shutil.which("CloudCompare"):
        return ["CloudCompare"]
    if shutil.which("flatpak"):
        erg = subprocess.run(["flatpak", "info", "org.cloudcompare.CloudCompare"], capture_output=True)
        if erg.returncode == 0:
            return ["flatpak", "run", "--filesystem=/tmp", "--filesystem=home", "org.cloudcompare.CloudCompare"]
    return None


def tsd(n: int) -> str:
    """Zahl mit Tausenderpunkten"""
    return f"{n:,}".replace(",", ".")


def name_aus_titel(titel: str) -> str:
    """Technischer Name (R2-Ordner): nur a-z0-9_-"""
    t = titel.lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9]+", "_", t).strip("_")
    return t[:60] or "projekt"


# ---------------------------------------------------------------- Punktwolke

def las_kopf(pfad: Path) -> dict:
    """Kopf einer LAS/LAZ-Datei, ohne sie zu entpacken."""
    with open(pfad, "rb") as f:
        b = f.read(375)
    if b[:4] == b"CCB2" or b[:3] == b"CCB":
        raise Fehler("BIN")
    if b[:4] != b"LASF":
        raise Fehler(f"{pfad.name} ist keine LAS/LAZ-Datei.")
    anzahl = struct.unpack_from("<I", b, 107)[0]
    if not anzahl and len(b) >= 255:
        anzahl = struct.unpack_from("<Q", b, 247)[0]
    mx, mnx, my, mny, mz, mnz = struct.unpack_from("<6d", b, 179)
    return {
        "version": f"{b[24]}.{b[25]}", "format": b[104] & 0x3F, "laz": bool(b[104] & 0x80),
        "anzahl": anzahl, "versatz": struct.unpack_from("<3d", b, 155),
        "min": (mnx, mny, mnz), "max": (mx, my, mz),
    }


def punktwolke_vorbereiten(quelle: Path, ziel: Path, melden) -> dict:
    """Quelle (LAZ, LAS oder versehentlich CloudCompare-BIN) → ziel als LAZ. Gibt den Kopf zurück."""
    try:
        kopf = las_kopf(quelle)
    except Fehler as f:
        if str(f) != "BIN":
            raise
        cc = cloudcompare()
        if not cc:
            raise Fehler(f"{quelle.name} ist im CloudCompare-Format (BIN), nicht LAZ. In CloudCompare "
                         "„Speichern unter“ → LAS/LAZ wählen, oder CloudCompare installieren — dann wandelt der Manager selbst um.")
        melden("Datei ist CloudCompare-BIN, wandle mit CloudCompare in LAZ um …")
        with tempfile.TemporaryDirectory(prefix="pwm_cc_", dir=str(Path.home()) if not WINDOWS else None) as tmp:
            bin_ = Path(tmp) / "wolke.bin"
            shutil.copyfile(quelle, bin_)
            lauf(cc + ["-SILENT", "-NO_TIMESTAMP", "-O", str(bin_), "-C_EXPORT_FMT", "LAS", "-EXT", "laz", "-SAVE_CLOUDS"])
            laz = next(Path(tmp).glob("*.laz"), None)
            if not laz:
                raise Fehler("CloudCompare hat keine LAZ geschrieben.")
            shutil.move(str(laz), ziel)
        return las_kopf(ziel)
    if kopf["laz"]:
        shutil.copyfile(quelle, ziel)
        return kopf
    melden("Datei ist unkomprimiertes LAS, packe zu LAZ …")
    import laspy
    las = laspy.read(str(quelle))
    las.write(str(ziel), laz_backend=laspy.LazBackend.Lazrs)
    return las_kopf(ziel)


def wolke_lesen(laz: Path, melden, max_punkte: int = 4_000_000):
    """x, y, z, rgb (0…255) als numpy, gleichmäßig ausgedünnt."""
    import laspy
    import numpy as np
    melden("Lese Punktwolke …")
    las = laspy.read(str(laz), laz_backend=laspy.LazBackend.Lazrs)
    n = len(las.points)
    s = max(1, n // max_punkte)
    x, y, z = np.asarray(las.x)[::s], np.asarray(las.y)[::s], np.asarray(las.z)[::s]
    rgb = None
    if all(d in las.point_format.dimension_names for d in ("red", "green", "blue")):
        rgb = np.stack([np.asarray(las.red)[::s], np.asarray(las.green)[::s], np.asarray(las.blue)[::s]], 1).astype(np.uint32)
        if rgb.max() > 255:
            rgb >>= 8
        rgb = rgb.astype(np.uint8)
    return x, y, z, rgb


def vorschau_aus_wolke(x, y, z, rgb, ziel: Path, breite=640, hoehe=480):
    """Senkrecht von oben, der höchste Punkt je Bildpunkt — wie ein kleines Orthofoto."""
    import numpy as np
    from PIL import Image, ImageFilter
    x0, x1, y0, y1 = x.min(), x.max(), y.min(), y.max()
    # füllend (wie background-size: cover in der Galerie), kleiner Rand
    m = max((x1 - x0) / breite, (y1 - y0) / hoehe) * 1.04
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    px = ((x - cx) / m + breite / 2).astype(np.int32)
    py = ((cy - y) / m + hoehe / 2).astype(np.int32)
    ok = (px >= 0) & (px < breite) & (py >= 0) & (py < hoehe)
    ordnung = np.argsort(z[ok])
    px, py = px[ok][ordnung], py[ok][ordnung]
    if rgb is None:
        t = ((z[ok][ordnung] - z.min()) / max(1e-6, np.ptp(z)) * 200 + 40).astype(np.uint8)
        farbe = np.stack([t, t, t], 1)
    else:
        farbe = rgb[ok][ordnung]
    bild = np.zeros((hoehe, breite, 3), np.uint8)
    da = np.zeros((hoehe, breite), np.uint8)
    bild[py, px] = farbe                         # spätere (höhere) Punkte überschreiben
    da[py, px] = 255
    # Kleine Löcher zwischen den Punkten mit dem Nachbarn füllen, außen der Grund der Galerie
    b, besetzt = Image.fromarray(bild), Image.fromarray(da)
    gefuellt = Image.composite(b, b.filter(ImageFilter.MaxFilter(3)), besetzt)
    grund = Image.new("RGB", (breite, hoehe), (18, 24, 27))
    grund.paste(gefuellt, (0, 0), besetzt.filter(ImageFilter.MaxFilter(3)))
    grund.save(ziel, quality=85)


# ---------------------------------------------------------------- 3D-Modell

def modell_auspacken(quelle: Path, ordner: Path) -> Path:
    """Zip (WebODM „Textured Model“) oder OBJ → OBJ-Pfad mit MTL und Texturen daneben."""
    if quelle.suffix.lower() == ".obj":
        for f in quelle.parent.iterdir():
            if f.suffix.lower() in (".obj", ".mtl", ".png", ".jpg", ".jpeg"):
                shutil.copy(f, ordner / f.name)
        return ordner / quelle.name
    if quelle.suffix.lower() != ".zip":
        raise Fehler("Modell bitte als Zip aus WebODM („Textured Model“) oder als OBJ.")
    with zipfile.ZipFile(quelle) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if not name or Path(name).suffix.lower() not in (".obj", ".mtl", ".png", ".jpg", ".jpeg"):
                continue
            with z.open(info) as q, open(ordner / name, "wb") as zl:   # flach, ohne Pfade aus dem Zip
                shutil.copyfileobj(q, zl)
    objs = sorted(ordner.glob("*.obj"), key=lambda p: ("_geo" not in p.name, p.name))
    if not objs:
        raise Fehler("Im Zip liegt kein OBJ.")
    return objs[0]


def obj_lesen(pfad: Path):
    import numpy as np
    v, vt, vn, faces = [], [], [], []      # faces: (material, [(vi, ti, ni), …])
    mat = None
    with open(pfad, encoding="utf-8", errors="replace") as f:
        for z in f:
            if z.startswith("v "):
                a = z.split(); v.append((float(a[1]), float(a[2]), float(a[3])))
            elif z.startswith("vt "):
                a = z.split(); vt.append((float(a[1]), float(a[2])))
            elif z.startswith("vn "):
                a = z.split(); vn.append((float(a[1]), float(a[2]), float(a[3])))
            elif z.startswith("usemtl "):
                mat = z.split(None, 1)[1].strip()
            elif z.startswith("f "):
                ecken = []
                for e in z.split()[1:]:
                    t = e.split("/")
                    ecken.append((int(t[0]), int(t[1]) if len(t) > 1 and t[1] else 0, int(t[2]) if len(t) > 2 and t[2] else 0))
                faces.append((mat, ecken))
    return np.array(v), vt, vn, faces


def versatz_finden(v, x, y, kopf: dict, melden):
    """Wo das OBJ (lokale Koordinaten) in UTM liegt. WebODM nimmt für Modell und
    georeferenzierte Wolke denselben ganzzahligen Versatz — der steht im LAS-Kopf.
    Geprüft wird über die Grundfläche; passt er nicht, wird in ±15 m gesucht."""
    import numpy as np
    R = 0.5
    gx0, gy0 = x.min() - 2, y.min() - 2
    W, H = int((x.max() - gx0) / R) + 4, int((y.max() - gy0) / R) + 4
    belegt = np.zeros((H, W), bool)
    belegt[((y - gy0) / R).astype(int), ((x - gx0) / R).astype(int)] = True
    probe = v[:: max(1, len(v) // 20000), :2]

    def treffer(ox, oy):
        cx = ((probe[:, 0] + ox - gx0) / R).astype(int)
        cy = ((probe[:, 1] + oy - gy0) / R).astype(int)
        ok = (cx >= 0) & (cx < W) & (cy >= 0) & (cy < H)
        return belegt[cy[ok], cx[ok]].sum() / len(probe)

    ox, oy = round(kopf["versatz"][0]), round(kopf["versatz"][1])
    gut = treffer(ox, oy)
    melden(f"Versatz aus der Wolke {ox} / {oy}: {gut:.0%} des Modells über der Wolke")
    if gut < 0.15:
        mx = (x.min() + x.max()) / 2 - (v[:, 0].min() + v[:, 0].max()) / 2
        my = (y.min() + y.max()) / 2 - (v[:, 1].min() + v[:, 1].max()) / 2
        beste = max(((treffer(round(mx) + dx, round(my) + dy), round(mx) + dx, round(my) + dy)
                     for dx in range(-15, 16) for dy in range(-15, 16)))
        if beste[0] < 0.1:
            raise Fehler("Modell und Punktwolke liegen nicht übereinander — stammen sie aus demselben WebODM-Lauf?")
        gut, ox, oy = beste
        melden(f"Versatz gesucht: {ox} / {oy} ({gut:.0%})")
    return ox, oy, belegt, (gx0, gy0, R)


def modell_schneiden(obj: Path, aus: Path, x, y, kopf: dict, melden) -> Path:
    """Nur die Dreiecke, deren Mitte über der Punktwolke liegt (Raster 0,5 m,
    eine Zelle Rand). Unbenutzte Teile der Texturen werden grau — WebP packt
    einfarbige Flächen fast auf null."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    melden("Lese Modell …")
    v, vt, vn, faces = obj_lesen(obj)
    ox, oy, belegt, (gx0, gy0, R) = versatz_finden(v, x, y, kopf, melden)
    # einen Ring dazu
    rand = belegt.copy()
    rand[1:, :] |= belegt[:-1, :]; rand[:-1, :] |= belegt[1:, :]
    rand[:, 1:] |= rand[:, :-1].copy(); rand[:, :-1] |= rand[:, 1:].copy()
    H, W = rand.shape

    neu_v, neu_t, neu_n = {}, {}, {}
    zeilen_f, mats, dreiecke_uv = [], set(), {}
    letzte = None
    for mat, ecken in faces:
        mx = sum(v[e[0] - 1, 0] for e in ecken) / len(ecken) + ox
        my = sum(v[e[0] - 1, 1] for e in ecken) / len(ecken) + oy
        cx, cy = int((mx - gx0) / R), int((my - gy0) / R)
        if not (0 <= cx < W and 0 <= cy < H and rand[cy, cx]):
            continue
        if mat != letzte:
            zeilen_f.append(f"usemtl {mat}"); letzte = mat; mats.add(mat)
        teile = []
        for vi, ti, ni in ecken:
            a = neu_v.setdefault(vi, len(neu_v) + 1)
            b = neu_t.setdefault(ti, len(neu_t) + 1) if ti else ""
            c = neu_n.setdefault(ni, len(neu_n) + 1) if ni else ""
            teile.append(f"{a}/{b}/{c}")
        zeilen_f.append("f " + " ".join(teile))
        if all(e[1] for e in ecken):
            dreiecke_uv.setdefault(mat, []).append([vt[e[1] - 1] for e in ecken])
    if not zeilen_f:
        raise Fehler("Nach dem Zuschneiden bleibt vom Modell nichts übrig.")
    behalten = sum(1 for z in zeilen_f if z.startswith("f "))
    melden(f"Modell zugeschnitten: {tsd(behalten)} von {tsd(len(faces))} Dreiecken")

    aus.mkdir(parents=True, exist_ok=True)
    with open(aus / "modell.obj", "w", encoding="utf-8") as f:
        f.write("mtllib modell.mtl\n")
        for vi in neu_v:
            f.write("v %.6f %.6f %.6f\n" % tuple(v[vi - 1]))
        for ti in neu_t:
            f.write("vt %.6f %.6f\n" % vt[ti - 1])
        for ni in neu_n:
            f.write("vn %.6f %.6f %.6f\n" % vn[ni - 1])
        f.write("\n".join(zeilen_f) + "\n")

    # MTL: nur benutzte Materialien; Texturen maskiert daneben
    mtl_name = None
    with open(obj, encoding="utf-8", errors="replace") as f:
        for z in f:
            if z.startswith("mtllib "):
                mtl_name = z.split(None, 1)[1].strip()
                break
    bloecke, cur = {}, None
    for z in open(obj.parent / mtl_name, encoding="utf-8", errors="replace"):
        if z.startswith("newmtl "):
            cur = z.split(None, 1)[1].strip(); bloecke[cur] = []
        if cur:
            bloecke[cur].append(z)
    with open(aus / "modell.mtl", "w", encoding="utf-8") as f:
        for m in sorted(mats):
            f.writelines(bloecke.get(m, []))
    for i, m in enumerate(sorted(mats)):
        tex = next((z.split(None, 1)[1].strip() for z in bloecke.get(m, []) if z.startswith("map_Kd")), None)
        if not tex:
            continue
        melden(f"Textur {i + 1} von {len(mats)} maskieren …")
        im = Image.open(obj.parent / tex).convert("RGB")
        w, h = im.size
        maske = Image.new("L", (w, h), 0)
        zeichnen = ImageDraw.Draw(maske)
        for tri in dreiecke_uv.get(m, []):
            zeichnen.polygon([(u * w, (1 - vv) * h) for u, vv in tri], fill=255, outline=255)
        maske = maske.filter(ImageFilter.MaxFilter(9))     # 4 px Rand gegen Nähte und Mipmaps
        Image.composite(im, Image.new("RGB", (w, h), (128, 128, 128)), maske).save(aus / tex, compress_level=1)
    return aus / "modell.obj"


def glb_bauen(obj: Path, ziel: Path, melden):
    """OBJ → GLB: Texturen höchstens TEXTUR_MAX, WebP in WEBP_QUALITAET, Geometrie mit Draco."""
    n = node()
    o2g = _node_werkzeug("obj2gltf/bin/obj2gltf.js")
    gt = _node_werkzeug("@gltf-transform/cli/bin/cli.js")
    tmp = ziel.parent
    a, b, c = tmp / "_1.glb", tmp / "_2.glb", tmp / "_3.glb"
    try:
        melden("OBJ → GLB …")
        lauf([n, "--max-old-space-size=8192", o2g, "-i", str(obj), "-o", str(a)])
        melden(f"Texturen auf höchstens {TEXTUR_MAX} px …")
        lauf([n, gt, "resize", str(a), str(b), "--width", str(TEXTUR_MAX), "--height", str(TEXTUR_MAX)])
        melden(f"Texturen als WebP (Qualität {WEBP_QUALITAET}) …")
        lauf([n, gt, "webp", str(b), str(c), "--quality", str(WEBP_QUALITAET)])
        melden("Geometrie optimieren (Draco) …")
        lauf([n, gt, "optimize", str(c), str(ziel), "--texture-compress", "false", "--compress", "draco"])
    finally:
        for f in (a, b, c):
            f.unlink(missing_ok=True)


def glb_dreiecke(glb: Path) -> int:
    """Dreiecke aus dem JSON-Teil der GLB (auch mit Draco: die Accessoren nennen die Zahl)."""
    with open(glb, "rb") as f:
        kopf = f.read(20)
        laenge = struct.unpack_from("<I", kopf, 12)[0]
        j = json.loads(f.read(laenge))
    summe = 0
    for m in j.get("meshes", []):
        for p in m.get("primitives", []):
            if p.get("mode", 4) == 4 and "indices" in p:
                summe += j["accessors"][p["indices"]]["count"] // 3
    return summe


# ---------------------------------------------------------------- Projekt vorbereiten

def vorbereiten(titel: str, beschreibung: str, name: str, wolke: Path | None, modell: Path | None,
                schneiden: bool, melden) -> dict:
    """Legt daten-lokal/<name>/ an. Nichts geht online."""
    if not re.fullmatch(r"[a-z0-9_-]+", name):
        raise Fehler("Technischer Name: nur Kleinbuchstaben, Ziffern, _ und -")
    ordner = LOKAL / name
    ordner.mkdir(parents=True, exist_ok=True)
    alt = eintrag_lokal(name) or {}
    eintrag = {**alt, "name": name, "title": titel, "description": beschreibung}
    x = y = z = rgb = kopf = None

    if wolke:
        melden(f"Punktwolke: {wolke.name}")
        kopf = punktwolke_vorbereiten(wolke, ordner / "cloud.laz", melden)
        eintrag.update(laz=True, pointcloud=True, points=kopf["anzahl"],
                       utmX=round((kopf["min"][0] + kopf["max"][0]) / 2, 2),
                       utmY=round((kopf["min"][1] + kopf["max"][1]) / 2, 2))
        x, y, z, rgb = wolke_lesen(ordner / "cloud.laz", melden)
        melden("Vorschaubild …")
        vorschau_aus_wolke(x, y, z, rgb, ordner / "thumb.jpg")
        eintrag["thumb"] = True
        melden(f"Punktwolke fertig: {tsd(kopf['anzahl'])} Punkte, {(ordner / 'cloud.laz').stat().st_size / 1e6:.0f} MB")
    elif (ordner / "cloud.laz").exists():
        kopf = las_kopf(ordner / "cloud.laz")

    if modell:
        melden(f"3D-Modell: {modell.name}")
        with tempfile.TemporaryDirectory(prefix="pwm_") as tmp:
            tmp = Path(tmp)
            (tmp / "roh").mkdir()
            obj = modell_auspacken(modell, tmp / "roh")
            if schneiden:
                if kopf is None:
                    raise Fehler("Zum Zuschneiden braucht es die Punktwolke des Projekts.")
                if x is None:
                    x, y, z, rgb = wolke_lesen(ordner / "cloud.laz", melden)
                obj = modell_schneiden(obj, tmp / "schnitt", x, y, kopf, melden)
            glb_bauen(obj, ordner / "model.glb", melden)
        eintrag["model"] = True
        eintrag["tris"] = glb_dreiecke(ordner / "model.glb")
        if not wolke and not (ordner / "cloud.laz").exists() and not alt.get("laz"):
            eintrag.setdefault("pointcloud", False)
        melden(f"Modell fertig: {(ordner / 'model.glb').stat().st_size / 1e6:.0f} MB, {tsd(eintrag['tris'])} Dreiecke")

    (ordner / "eintrag.json").write_text(json.dumps(eintrag, ensure_ascii=False, indent=2), encoding="utf-8")
    return eintrag


def eintrag_lokal(name: str) -> dict | None:
    p = LOKAL / name / "eintrag.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def lokale_projekte() -> list[dict]:
    if not LOKAL.exists():
        return []
    return [e for e in (eintrag_lokal(p.name) for p in sorted(LOKAL.iterdir()) if p.is_dir()) if e]


# ---------------------------------------------------------------- Liste, Vorschauseiten, git

def liste_lesen() -> list[dict]:
    return json.loads(JSON_PFAD.read_text(encoding="utf-8")).get("pointclouds", [])


def liste_schreiben(liste: list[dict]):
    JSON_PFAD.write_text(json.dumps({"pointclouds": liste}, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def vorschauseite(pc: dict):
    """p/<name>.html mit Open-Graph-Angaben (Bild und Titel beim Teilen), leitet weiter."""
    from html import escape as esc
    name = pc["name"]
    if pc.get("pointcloud") is False:
        ziel = f"../model.html?p={name}"
    else:
        ziel = f"../{'wolke' if pc.get('laz') else 'view'}.html?p={name}"
    titel, beschr = esc(pc.get("title") or name), esc(pc.get("description") or "Photogrammetrie aus Drohnenaufnahmen")
    bild = f"{R2_BASE}/{name}/thumb.jpg"
    P_ORDNER.mkdir(exist_ok=True)
    (P_ORDNER / f"{name}.html").write_text(f"""<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{titel}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="{titel}">
<meta property="og:description" content="{beschr}">
<meta property="og:image" content="{bild}">
<meta property="og:url" content="{SEITE}/p/{name}.html">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{titel}">
<meta name="twitter:image" content="{bild}">
<link rel="canonical" href="{ziel}">
<meta http-equiv="refresh" content="0; url={ziel}">
<script>location.replace({json.dumps(ziel)});</script>
<style>body{{background:#1a1d21;color:#cfd3d7;font-family:sans-serif;text-align:center;padding:40px}}a{{color:#6ab0f3}}</style>
</head>
<body>
Weiterleitung zum Viewer … <a href="{ziel}">hier klicken</a>, falls es nicht automatisch geht.
</body>
</html>
""", encoding="utf-8")


def git(*args) -> str:
    return lauf(["git", "-C", str(REPO), *args])


def git_veroeffentlichen(nachricht: str, dateien: list[str], melden):
    melden("git: hole den Stand von GitHub …")
    git("pull", "--rebase", "--autostash")
    git("add", "--", *dateien)
    if not git("diff", "--cached", "--name-only").strip():
        melden("git: nichts zu veröffentlichen.")
        return
    git("commit", "-m", nachricht)
    melden("git: push …")
    git("push")
    melden("Online — GitHub Pages braucht 1–2 Minuten.")


# ---------------------------------------------------------------- R2

def speicher() -> tuple[float, dict]:
    """Belegter Speicher in GB und Größe je Projekt (Bytes), in einem Abruf."""
    aus = lauf([rclone(), "lsjson", "-R", "--files-only", "--no-mimetype", "--no-modtime", R2_REMOTE])
    je = {}
    for f in json.loads(aus or "[]"):
        je[f["Path"].split("/")[0]] = je.get(f["Path"].split("/")[0], 0) + f["Size"]
    return sum(je.values()) / 1e9, je


def hochladen(name: str, melden):
    ordner = LOKAL / name
    eintrag = eintrag_lokal(name)
    if not eintrag:
        raise Fehler(f"Für {name} ist nichts vorbereitet.")
    gb, je = speicher()
    neu = sum(f.stat().st_size for f in ordner.iterdir() if f.name in ("cloud.laz", "model.glb", "thumb.jpg")) / 1e9
    if gb + neu - je.get(name, 0) / 1e9 > LIMIT_GB * 0.95:
        raise Fehler(f"Das passt nicht mehr ins Freikontingent: belegt {gb:.2f} GB, dazu {neu:.2f} GB, Grenze {LIMIT_GB:.0f} GB.")
    for datei in ("cloud.laz", "model.glb", "thumb.jpg"):
        if (ordner / datei).exists():
            melden(f"Hochladen: {datei} ({(ordner / datei).stat().st_size / 1e6:.0f} MB) …")
            lauf([rclone(), "copyto", str(ordner / datei), f"{R2_REMOTE}/{name}/{datei}", "--s3-no-check-bucket"])
    if eintrag.get("laz"):
        # alte Potree-Dateien desselben Projekts weg
        args = [rclone(), "delete", f"{R2_REMOTE}/{name}"]
        for f in POTREE_DATEIEN:
            args += ["--include", f"/{f}"]
        lauf(args)
    liste = liste_lesen()
    sauber = {k: v for k, v in eintrag.items() if not k.startswith("_")}
    for i, pc in enumerate(liste):
        if pc["name"] == name:
            liste[i] = {**pc, **sauber}
            break
    else:
        liste.insert(0, sauber)
    liste_schreiben(liste)
    vorschauseite(next(pc for pc in liste if pc["name"] == name))
    git_veroeffentlichen(f"Projekt {eintrag['title']} veröffentlicht", ["pointclouds.json", f"p/{name}.html"], melden)
    shutil.rmtree(ordner)
    melden(f"{eintrag['title']} ist online, lokale Kopie gelöscht.")


def loeschen(name: str, was: str, melden):
    """was: 'alles' | 'wolke' | 'modell'"""
    liste = liste_lesen()
    pc = next((p for p in liste if p["name"] == name), None)
    if was == "alles":
        melden(f"Lösche {name} aus R2 …")
        lauf([rclone(), "purge", f"{R2_REMOTE}/{name}"])
        liste = [p for p in liste if p["name"] != name]
        (P_ORDNER / f"{name}.html").unlink(missing_ok=True)
        shutil.rmtree(LOKAL / name, ignore_errors=True)
        geaendert = ["pointclouds.json", f"p/{name}.html"]
    else:
        dateien = ["model.glb"] if was == "modell" else ["cloud.laz", *POTREE_DATEIEN]
        args = [rclone(), "delete", f"{R2_REMOTE}/{name}"]
        for f in dateien:
            args += ["--include", f"/{f}"]
        lauf(args)
        if pc:
            if was == "modell":
                pc["model"] = False; pc.pop("tris", None)
            else:
                pc["pointcloud"] = False; pc.pop("laz", None); pc.pop("points", None)
            vorschauseite(pc)
        geaendert = ["pointclouds.json", f"p/{name}.html"]
    liste_schreiben(liste)
    git_veroeffentlichen(f"Projekt {name}: {'gelöscht' if was == 'alles' else was + ' gelöscht'}", geaendert, melden)
