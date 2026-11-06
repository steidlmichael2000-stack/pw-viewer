# Punktwolken-Manager

Fenster zum Anlegen, Ansehen und Hochladen der Projekte im PW-Viewer. Läuft mit Python und
Tkinter unter Windows und Linux gleich. Nachfolger des PowerShell-Managers
(`Punktwolken-Manager.ps1`), der nur unter Windows lief und noch Potree baute.

## Einrichten (einmalig)

**Zorin/Linux**

```bash
sudo apt install python3-tk python3-venv
werkzeug/manager/einrichten.sh
```

Das Skript legt `.venv` und `node_modules` an und trägt „Punktwolken-Manager“ ins Startmenü ein.
rclone braucht das Remote `r2:`: die `rclone.conf` vom Windows-Rechner
(`%APPDATA%\rclone\rclone.conf`) nach `~/.config/rclone/rclone.conf` kopieren oder mit
`rclone config` neu anlegen (Typ s3, Anbieter Cloudflare).

**Windows**: Python 3, Node.js und rclone per winget, dann `einrichten.bat`, Start mit
`Punktwolken-Manager.bat`.

## Ablauf

1. **WebODM**: Punktwolke (`georeferenced_model.laz`) und Modell („Textured Model“, Zip) herunterladen.
2. **CloudCompare** (wenn nötig): die Wolke zurechtschneiden und als **LAS/LAZ** speichern.
   Hat CloudCompare sein eigenes Format geschrieben (BIN, auch mit Endung `.laz`), wandelt der
   Manager selbst um, sofern CloudCompare installiert ist.
3. **Manager → „+ Neues Projekt“**: Titel, Punktwolke, Modell wählen, „zuschneiden“ angehakt
   lassen → *Vorbereiten*. Dabei geschieht:
   - Wolke als LAZ nach `daten-lokal/<name>/cloud.laz`, Vorschaubild von oben,
   - Modell auf die Fläche der Wolke zugeschnitten, unbenutzte Texturteile grau,
     Texturen bis 4096 px als WebP (Qualität 90), Geometrie mit Draco → `model.glb`.
4. **„Punktwolke ansehen“ / „Modell ansehen“**: öffnet die Seiten im Browser von diesem Rechner aus
   (eigener kleiner Server auf Port 5193). Online ist noch nichts.
5. **„Veröffentlichen“**: lädt nach R2, trägt das Projekt oben in `pointclouds.json` ein, schreibt
   `p/<name>.html` (Vorschau beim Teilen), committet und pusht. Nach 1–2 Minuten in der Galerie.

Umbenennen und Reihenfolge ändern nur die Liste auf dem Rechner; „Veröffentlichen“ bei einem
Online-Projekt pusht diese Änderungen. Löschen wirkt sofort in R2 und in der Galerie.

## Was wo liegt

| | |
|---|---|
| R2 je Projekt | `cloud.laz`, `model.glb`, `thumb.jpg` (alte Projekte noch Potree: `metadata.json`, `hierarchy.bin`, `octree.bin`) |
| Viewer | `wolke.html` für LAZ (3D-Viewer aus Topovo, siehe `werkzeug/topovo-holen.sh`), `view.html` für alte Potree-Projekte, `model.html` für Modelle |
| `pointclouds.json` | `laz: true` = neues Format, `points`, `utmX`/`utmY` (Mitte), `tris` |

Ein altes Potree-Projekt umstellen: auswählen → „Wolke/Modell ändern“ → LAZ wählen →
Vorbereiten → Veröffentlichen. Die Potree-Dateien werden dabei in R2 gelöscht.

## Einstellungen

Oben in `verarbeitung.py`: `TEXTUR_MAX` (4096), `WEBP_QUALITAET` (90), `LIMIT_GB` (10, das
Freikontingent von R2 — der Manager lädt nichts hoch, was über 95 % führen würde). Das Remote
lässt sich mit der Umgebungsvariable `PW_R2_REMOTE` ändern (Standard `r2:pointclouds`).
